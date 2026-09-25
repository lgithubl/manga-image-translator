// ==UserScript==
// @name         Manga Image Translator Submitter
// @namespace    https://github.com/lgithubl/manga-image-translator
// @version      1.0.0
// @description  Collect manga images, submit translations, and provide context-menu translation/TTS helpers.
// @match        *://*/*
// @run-at       document-start
// @noframes
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        unsafeWindow
// @connect      *
// ==/UserScript==

(function () {
  "use strict";

  if (window.top !== window) return;

  const STORAGE_KEY = "mit_submitter_state_v1";
  const GLOBAL_STORAGE_KEY = "mit_submitter_global_state_v1";
  const IMAGE_EXTENSIONS = /\.(avif|bmp|gif|jpe?g|png|webp)(\?|#|$)/i;
  const DEFAULT_CONFIG = {
    detector: {
      detector: "default",
      detection_size: 1536,
      box_threshold: 0.7,
      unclip_ratio: 2.3,
    },
    render: {
      direction: "auto",
      font_size_offset: 0,
      disable_font_border: false,
    },
    translator: {
      translator: "custom_openai",
      target_lang: "CHS",
      custom_openai_model: "auto",
    },
    inpainter: {
      inpainter: "default",
      inpainting_size: 2048,
    },
    mask_dilation_offset: 30,
  };

  const defaultState = {
    host: "http://127.0.0.1:5003",
    useBasicAuth: false,
    username: "",
    password: "",
    zipNameSelector: "",
    zipName: "manga-translator-results.zip",
    imageBlacklist: "",
    configText: JSON.stringify(DEFAULT_CONFIG, null, 2),
    queue: [],
    resultsCount: 0,
    lastMessage: "",
    collapsed: false,
    panelLeft: null,
    panelTop: null,
    popupBlockHosts: {},
    assistant: {
      textTranslatePath: "http://127.0.0.1:5003/v1/chat/completions",
      ttsPath: "http://127.0.0.1:5003/assistant/tts",
      imageTranslatePath: "http://127.0.0.1:5003/translate/with-form/image/stream/web",
      textTargetLang: "zh-CN",
      ttsVoice: "zh-CN",
      textRequestJson: JSON.stringify({
        model: "sukinishiro",
        temperature: 0.3,
        top_p: 0.3,
        frequency_penalty: 0.1,
      }, null, 2),
      ttsRequestJson: "{}",
      history: [],
    },
  };

  let state = loadState();
  let running = false;
  let root;
  let panelFrame;
  let contextMenu;
  let bigImageRoot;
  let statusTimer;
  let suppressMiniClickUntil = 0;
  let initialized = false;
  let menuContext = { imageUrl: "", text: "" };
  let activeModalId = "";
  const openSections = new Set();
  let contextMenuShownAt = 0;
  let contextMenuStickyUntil = 0;
  installEarlyPanelShield();

  function loadState() {
    try {
      const local = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
      const global = readGlobalState() || {};
      const loadedAssistant = {
        ...defaultState.assistant,
        ...(local.assistant || {}),
        ...(global.assistant || {}),
      };
      if (!loadedAssistant.textRequestJson && loadedAssistant.requestJson) {
        loadedAssistant.textRequestJson = loadedAssistant.requestJson;
      }
      delete loadedAssistant.requestJson;
      return {
        ...defaultState,
        ...local,
        ...global,
        zipName: local.zipName ?? defaultState.zipName,
        zipNameSelector: local.zipNameSelector ?? defaultState.zipNameSelector,
        imageBlacklist: local.imageBlacklist ?? defaultState.imageBlacklist,
        queue: Array.isArray(local.queue) ? local.queue : [],
        resultsCount: local.resultsCount || 0,
        lastMessage: local.lastMessage || "",
        assistant: loadedAssistant,
      };
    } catch (_) {
      return { ...defaultState };
    }
  }

  function saveState() {
    const localPersisted = {
      zipName: state.zipName,
      zipNameSelector: state.zipNameSelector,
      imageBlacklist: state.imageBlacklist,
      queue: state.queue.slice(-300),
      resultsCount: state.resultsCount || 0,
      lastMessage: state.lastMessage || "",
    };
    const globalPersisted = {
      host: state.host,
      useBasicAuth: state.useBasicAuth,
      username: state.username,
      password: state.password,
      configText: state.configText,
      collapsed: state.collapsed,
      panelLeft: state.panelLeft,
      panelTop: state.panelTop,
      popupBlockHosts: state.popupBlockHosts || {},
      assistant: {
        ...state.assistant,
        history: (state.assistant?.history || []).slice(-100),
      },
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(localPersisted));
    writeGlobalState(globalPersisted);
  }

  function readGlobalState() {
    if (typeof GM_getValue === "function") {
      return GM_getValue(GLOBAL_STORAGE_KEY, null);
    }
    try {
      return JSON.parse(localStorage.getItem(GLOBAL_STORAGE_KEY) || "null");
    } catch (_) {
      return null;
    }
  }

  function writeGlobalState(value) {
    if (typeof GM_setValue === "function") {
      GM_setValue(GLOBAL_STORAGE_KEY, value);
      return;
    }
    localStorage.setItem(GLOBAL_STORAGE_KEY, JSON.stringify(value));
  }

  function normalizeHost(host) {
    return (host || "").trim().replace(/\/+$/, "");
  }

  function authHeader() {
    if (!state.useBasicAuth || !state.username) return {};
    return {
      Authorization: `Basic ${btoa(`${state.username}:${state.password || ""}`)}`,
    };
  }

  function setMessage(message) {
    state.lastMessage = message;
    saveState();
    const messageEl = root?.querySelector(".mit-message");
    if (messageEl) messageEl.textContent = message || "";
    const summaryEl = root?.querySelector(".mit-summary");
    if (summaryEl) summaryEl.textContent = statusText();
  }

  function eventTargetsPanel(event) {
    if (!root && !panelFrame && !contextMenu && !bigImageRoot) return false;
    const path = typeof event.composedPath === "function" ? event.composedPath() : [];
    return path.includes(root)
      || path.includes(panelFrame)
      || path.includes(contextMenu)
      || path.includes(bigImageRoot)
      || root?.contains(event.target)
      || panelFrame?.contains(event.target)
      || contextMenu?.contains(event.target)
      || bigImageRoot?.contains(event.target);
  }

  function installEarlyPanelShield() {
    ["pointerdown", "mousedown", "mouseup", "click", "auxclick", "touchstart", "touchend"].forEach((type) => {
      window.addEventListener(type, (event) => {
        if (!eventTargetsPanel(event)) return;
        if (bigImageRoot?.contains(event.target) && ["pointerdown", "mousedown", "touchstart", "click"].includes(type)) {
          hideBigImage();
        }
        if (contextMenu?.contains(event.target) && type === "click") {
          runContextMenuAction(event);
        }
        event.stopImmediatePropagation();
        window.setTimeout(() => ensureTopLayer(true), 0);
      }, true);
    });
  }

  function absoluteUrl(url) {
    try {
      return new URL(url, location.href).href;
    } catch (_) {
      return "";
    }
  }

  function srcFromSrcset(srcset) {
    if (!srcset) return "";
    const entries = srcset
      .split(",")
      .map((item) => item.trim().split(/\s+/)[0])
      .filter(Boolean);
    return entries[entries.length - 1] || "";
  }

  function imageUrlFromElement(img) {
    const candidates = [
      img.currentSrc,
      img.src,
      img.dataset?.src,
      img.dataset?.original,
      img.dataset?.lazySrc,
      img.dataset?.url,
      img.getAttribute("data-src"),
      img.getAttribute("data-original"),
      img.getAttribute("data-lazy-src"),
      img.getAttribute("data-url"),
      srcFromSrcset(img.getAttribute("srcset")),
      srcFromSrcset(img.dataset?.srcset),
    ];
    return absoluteUrl(candidates.find(Boolean) || "");
  }

  function isLikelyMangaImage(img, url) {
    const rect = img.getBoundingClientRect();
    const width = img.naturalWidth || rect.width || img.width || 0;
    const height = img.naturalHeight || rect.height || img.height || 0;
    if (!url || url.startsWith("data:") || url.startsWith("blob:")) return false;
    if (width < 180 || height < 180) return false;
    if (height < width * 0.75 && !IMAGE_EXTENSIONS.test(url)) return false;
    return true;
  }

  function detectImages() {
    const found = [];
    for (const img of Array.from(document.images)) {
      const url = imageUrlFromElement(img);
      if (isLikelyMangaImage(img, url)) {
        found.push(url);
      }
    }
    return Array.from(new Set(found));
  }

  function addDetectedImages() {
    const urls = detectImages();
    const known = new Set(state.queue.map((item) => item.url));
    let added = 0;
    let skipped = 0;
    for (const url of urls) {
      if (known.has(url)) continue;
      if (isBlacklistedImageUrl(url)) {
        skipped += 1;
        continue;
      }
      state.queue.push({
        id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
        url,
        status: "pending",
        message: "",
        addedAt: Date.now(),
        updatedAt: Date.now(),
      });
      known.add(url);
      added += 1;
    }
    saveState();
    render();
    setMessage(`检测到 ${urls.length} 张图，新增 ${added} 张，黑名单跳过 ${skipped} 张。`);
  }

  function gmRequest(options) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        ...options,
        onload(response) {
          if (response.status >= 200 && response.status < 300) {
            resolve(response);
          } else {
            reject(new Error(`HTTP ${response.status}: ${response.responseText || response.statusText || "request failed"}`));
          }
        },
        onerror() {
          reject(new Error("Network error"));
        },
        ontimeout() {
          reject(new Error("Request timeout"));
        },
      });
    });
  }

  function assistantState() {
    state.assistant = {
      ...defaultState.assistant,
      ...(state.assistant || {}),
    };
    return state.assistant;
  }

  function assistantConfigObject(kind = "text") {
    const assistant = assistantState();
    const raw = kind === "tts" ? assistant.ttsRequestJson : assistant.textRequestJson;
    try {
      return JSON.parse(raw || "{}");
    } catch (_) {
      return {};
    }
  }

  function assistantUrl(path) {
    const host = normalizeHost(state.host);
    if (!host) throw new Error("请先填写 Host。");
    if (/^https?:\/\//i.test(path || "")) return path;
    return `${host}${String(path || "").startsWith("/") ? "" : "/"}${path || ""}`;
  }

  function imageTranslateUrl() {
    return assistantUrl(assistantState().imageTranslatePath);
  }

  function imageServiceBase() {
    return new URL(imageTranslateUrl()).origin;
  }

  function isChatCompletionsUrl(url) {
    return /\/v1\/chat\/completions(?:[?#]|$)/i.test(url || "");
  }

  function targetLangName(targetLang) {
    const lang = String(targetLang || "").toLowerCase();
    if (lang === "zh-cn" || lang === "chs" || lang.includes("chinese")) return "中文";
    if (lang === "jpn" || lang === "ja" || lang.includes("japanese")) return "日文";
    return targetLang || "中文";
  }

  function buildSakuraMessages(text, targetLang) {
    return [
      {
        role: "system",
        content: "你是一个轻小说翻译模型，可以流畅通顺地以日本轻小说的风格将日文翻译成简体中文，并联系上下文正确使用人称代词，不擅自添加原文中没有的代词。",
      },
      {
        role: "user",
        content: `将下面的日文文本翻译成${targetLangName(targetLang)}：${text}`,
      },
    ];
  }

  function buildTextTranslatePayload(text, assistant, requestUrl) {
    const extra = assistantConfigObject("text");
    if (isChatCompletionsUrl(requestUrl) || Array.isArray(extra.messages) || extra.model) {
      const payload = {
        model: "sukinishiro",
        temperature: 0.3,
        top_p: 0.3,
        frequency_penalty: 0.1,
        ...extra,
      };
      return {
        ...payload,
        messages: Array.isArray(payload.messages)
          ? payload.messages
          : buildSakuraMessages(text, assistant.textTargetLang),
        max_tokens: payload.max_tokens || Math.max(String(text).length * 2, 512),
      };
    }
    return {
      text,
      target_lang: assistant.textTargetLang,
      config: extra,
      ...extra,
    };
  }

  function validateImageTranslateUrl(url) {
    try {
      const parsed = new URL(url, location.href);
      if (!parsed.pathname.includes("/translate/with-form/image")) {
        throw new Error(
          `图片翻译接口应填写 /translate/with-form/image/stream/web，当前是 ${parsed.pathname || "/"}。Sakura 的 http://...:11586/v1 只放在 Config JSON 的 translator.sakura_api_base 里。`
        );
      }
    } catch (error) {
      if (error?.message?.includes("图片翻译接口")) throw error;
      throw new Error("图片翻译接口地址无效。建议填写 /translate/with-form/image/stream/web");
    }
  }

  function selectedPageText() {
    return String(window.getSelection?.() || "").trim();
  }

  function shortText(text, max = 48) {
    const clean = String(text || "").replace(/\s+/g, " ").trim();
    return clean.length > max ? `${clean.slice(0, Math.max(0, max - 3))}...` : clean;
  }

  function safeFileStem(text) {
    const clean = String(text || "download")
      .replace(/\.[a-z0-9]+$/i, "")
      .replace(/[\\/:*?"<>|]+/g, "-")
      .replace(/\s+/g, " ")
      .trim();
    return (clean || "download").slice(0, 80);
  }

  function assistantTypeLabel(type) {
    if (type === "image") return "图片";
    if (type === "audio") return "语音";
    if (type === "text") return "文本";
    return "记录";
  }

  function addAssistantHistory(entry) {
    const now = Date.now();
    const next = {
      id: `${now}-${Math.random().toString(36).slice(2)}`,
      createdAt: now,
      status: "done",
      ...entry,
    };
    const assistant = assistantState();
    assistant.history = [next, ...(assistant.history || [])].slice(0, 100);
    saveState();
    render();
    return next;
  }

  function updateAssistantHistory(id, patch) {
    const assistant = assistantState();
    assistant.history = (assistant.history || []).map((item) => (
      item.id === id ? { ...item, ...patch, updatedAt: Date.now() } : item
    ));
    saveState();
    render();
  }

  function removeAssistantHistory(id) {
    const assistant = assistantState();
    assistant.history = (assistant.history || []).filter((item) => item.id !== id);
    if (activeModalId === id) activeModalId = "";
    saveState();
    render();
  }

  function clearAssistantHistory() {
    if (!window.confirm("清空翻译助手缓存？")) return;
    assistantState().history = [];
    activeModalId = "";
    saveState();
    render();
  }

  function blobToDataUrl(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result || ""));
      reader.onerror = () => reject(new Error("Failed to read blob"));
      reader.readAsDataURL(blob);
    });
  }

  function extractTextResponse(response) {
    const contentType = response.responseHeaders?.match(/content-type:\s*([^\r\n]+)/i)?.[1] || "";
    if (typeof response.response === "object" && response.response && !(response.response instanceof Blob)) {
      const data = response.response;
      if (Array.isArray(data.choices) && data.choices[0]) {
        return String(data.choices[0].message?.content || data.choices[0].text || "");
      }
      return String(data.translation || data.translated_text || data.text || data.result || data.output || "");
    }
    const raw = String(response.responseText || "");
    if (contentType.includes("json") || raw.trim().startsWith("{")) {
      try {
        const data = JSON.parse(raw);
        if (Array.isArray(data.choices) && data.choices[0]) {
          return String(data.choices[0].message?.content || data.choices[0].text || "");
        }
        return String(data.translation || data.translated_text || data.text || data.result || data.output || raw);
      } catch (_) {
        return raw;
      }
    }
    return raw;
  }

  async function translateSelectedText(text = selectedPageText()) {
    if (!text) {
      setMessage("请先选择文本。");
      return;
    }
    const entry = addAssistantHistory({
      type: "text",
      status: "pending",
      title: shortText(text),
      sourceText: text,
      resultText: "",
      message: "翻译中",
    });
    try {
      const assistant = assistantState();
      const requestUrl = assistantUrl(assistant.textTranslatePath);
      const response = await gmRequest({
        method: "POST",
        url: requestUrl,
        headers: {
          ...authHeader(),
          "Content-Type": "application/json",
        },
        data: JSON.stringify(buildTextTranslatePayload(text, assistant, requestUrl)),
        responseType: "json",
        timeout: 120000,
      });
      updateAssistantHistory(entry.id, {
        status: "done",
        resultText: extractTextResponse(response),
        message: "翻译完成",
      });
      setMessage("文本翻译完成。");
    } catch (error) {
      updateAssistantHistory(entry.id, { status: "error", message: error.message || String(error) });
      setMessage(`文本翻译失败: ${error.message || String(error)}`);
    }
  }

  async function speakSelectedText(text = selectedPageText()) {
    if (!text) {
      setMessage("请先选择文本。");
      return;
    }
    const entry = addAssistantHistory({
      type: "audio",
      status: "pending",
      title: shortText(text),
      sourceText: text,
      audioUrl: "",
      message: "生成语音中",
    });
    try {
      const assistant = assistantState();
      const extra = assistantConfigObject("tts");
      const response = await gmRequest({
        method: "POST",
        url: assistantUrl(assistant.ttsPath),
        headers: {
          ...authHeader(),
          "Content-Type": "application/json",
        },
        data: JSON.stringify({
          text,
          voice: assistant.ttsVoice,
          config: extra,
          ...extra,
        }),
        responseType: "blob",
        timeout: 180000,
      });
      const blob = response.response instanceof Blob
        ? response.response
        : new Blob([response.response], { type: "audio/mpeg" });
      const contentType = blob.type || response.responseHeaders?.match(/content-type:\s*([^\r\n]+)/i)?.[1] || "";
      if (contentType.includes("json") || contentType.includes("text")) {
        const textResponse = await blobToText(blob);
        throw new Error(textResponse || "unexpected TTS response");
      }
      updateAssistantHistory(entry.id, {
        status: "done",
        audioUrl: await blobToDataUrl(blob),
        message: "语音完成",
      });
      setMessage("语音生成完成。");
    } catch (error) {
      updateAssistantHistory(entry.id, { status: "error", message: error.message || String(error) });
      setMessage(`文本转语音失败: ${error.message || String(error)}`);
    }
  }

  async function translateImageUrlNow(url) {
    const imageUrl = absoluteUrl(url);
    if (!imageUrl) {
      setMessage("没有可翻译的图片。");
      return;
    }
    const entry = addAssistantHistory({
      type: "image",
      status: "pending",
      title: shortUrl(imageUrl),
      sourceUrl: imageUrl,
      resultUrl: "",
      folder: "",
      message: "图片翻译中",
    });
    try {
      const file = await fetchImageFile(imageUrl);
      const form = new FormData();
      form.append("image", file);
      form.append("config", state.configText || "{}");
      const requestUrl = imageTranslateUrl();
      validateImageTranslateUrl(requestUrl);
      const response = await gmRequest({
        method: "POST",
        url: requestUrl,
        headers: authHeader(),
        data: form,
        responseType: "arraybuffer",
        timeout: 30 * 60 * 1000,
      });
      const summary = parseStreamSummary(response.response);
      if (summary.error) throw new Error(summary.error);
      const host = imageServiceBase();
      const resultUrl = summary.finalFolder ? `${host}/result/${encodeURIComponent(summary.finalFolder)}/final.png` : "";
      const resultPreviewUrl = resultUrl ? await previewUrlForImage(resultUrl) : "";
      updateAssistantHistory(entry.id, {
        status: "done",
        folder: summary.finalFolder,
        resultUrl,
        resultPreviewUrl,
        message: resultUrl ? "图片翻译完成" : "图片翻译完成，但未返回结果路径",
      });
      setMessage("图片翻译完成。");
    } catch (error) {
      updateAssistantHistory(entry.id, { status: "error", message: error.message || String(error) });
      setMessage(`图片翻译失败: ${error.message || String(error)}`);
    }
  }

  async function fetchImageFile(url) {
    const response = await gmRequest({
      method: "GET",
      url,
      responseType: "blob",
      timeout: 120000,
      headers: {
        Referer: location.href,
      },
    });
    const contentType = response.response?.type || response.responseHeaders?.match(/content-type:\s*([^\r\n]+)/i)?.[1] || "image/jpeg";
    const blob = response.response instanceof Blob ? response.response : new Blob([response.response], { type: contentType });
    const ext = extensionFromUrlOrType(url, blob.type || contentType);
    const name = fileNameFromUrl(url, 1).replace(/\.[^.]+$/, ext);
    return new File([blob], name, { type: blob.type || contentType });
  }

  async function previewUrlForImage(url) {
    try {
      const response = await gmRequest({
        method: "GET",
        url,
        responseType: "blob",
        timeout: 120000,
        headers: authHeader(),
      });
      const contentType = response.response?.type || response.responseHeaders?.match(/content-type:\s*([^\r\n]+)/i)?.[1] || "image/png";
      const blob = response.response instanceof Blob
        ? response.response
        : new Blob([response.response], { type: contentType });
      return await blobToDataUrl(blob);
    } catch (_) {
      return url;
    }
  }

  function extensionFromUrlOrType(url, type) {
    try {
      const path = new URL(url).pathname;
      const match = decodeURIComponent(path.split("/").pop() || "").match(/\.(avif|bmp|gif|jpe?g|png|webp)$/i);
      if (match) return match[0].toLowerCase().replace(".jpeg", ".jpg");
    } catch (_) {
      // fall through
    }
    if ((type || "").includes("png")) return ".png";
    if ((type || "").includes("webp")) return ".webp";
    if ((type || "").includes("bmp")) return ".bmp";
    if ((type || "").includes("gif")) return ".gif";
    if ((type || "").includes("avif")) return ".avif";
    return ".jpg";
  }

  function queueOutputName(item) {
    const ordered = state.queue.filter((entry) => entry.status !== "removed");
    const index = Math.max(0, ordered.findIndex((entry) => entry.id === item.id));
    const rawName = fileNameFromUrl(item.url, index + 1);
    const rawExt = osExt(rawName) || extensionFromUrlOrType(item.url, "");
    const ext = item.outputExt || rawExt;
    const stem = rawName.slice(0, rawName.length - rawExt.length) || `image-${String(index + 1).padStart(3, "0")}`;
    let duplicateIndex = 1;
    for (let entryIndex = 0; entryIndex < ordered.length; entryIndex += 1) {
      const entry = ordered[entryIndex];
      if (entry.id === item.id) break;
      if (fileNameFromUrl(entry.url, entryIndex + 1).toLowerCase() === rawName.toLowerCase()) {
        duplicateIndex += 1;
      }
    }
    return duplicateIndex > 1 ? `${stem}-${duplicateIndex}${ext}` : `${stem}${ext}`;
  }

  async function downloadImage(item) {
    const response = await gmRequest({
      method: "GET",
      url: item.url,
      responseType: "blob",
      timeout: 120000,
      headers: {
        Referer: location.href,
      },
    });
    const contentType = response.response?.type || response.responseHeaders?.match(/content-type:\s*([^\r\n]+)/i)?.[1] || "image/jpeg";
    const blob = response.response instanceof Blob ? response.response : new Blob([response.response], { type: contentType });
    const outputExt = extensionFromUrlOrType(item.url, blob.type || contentType);
    const outputName = queueOutputName({ ...item, outputExt });
    updateQueueItem(item.id, { outputName, outputExt });
    return new File([blob], outputName, { type: blob.type || contentType });
  }

  function osExt(name) {
    const match = String(name || "").match(/\.(avif|bmp|gif|jpe?g|png|webp)$/i);
    return match ? match[0].toLowerCase().replace(".jpeg", ".jpg") : "";
  }

  function fileNameFromUrl(url, fallbackIndex = 1) {
    try {
      const path = new URL(url).pathname;
      const name = decodeURIComponent(path.split("/").pop() || "");
      if (name && IMAGE_EXTENSIONS.test(name)) {
        return name.replace(/[\\/:*?"<>|]+/g, "-").replace(/\.jpeg$/i, ".jpg");
      }
    } catch (_) {
      // fall through
    }
    return `image-${String(fallbackIndex).padStart(3, "0")}.jpg`;
  }

  function blacklistNames() {
    return String(state.imageBlacklist || "")
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean);
  }

  function isBlacklistedImageUrl(url) {
    const name = fileNameFromUrl(url, 1).toLowerCase();
    const stem = name.replace(/\.[^.]+$/, "");
    return blacklistNames().some((blocked) => blocked === name || blocked === stem);
  }

  function updateQueueItem(id, patch) {
    state.queue = state.queue.map((item) => {
      if (item.id !== id) return item;
      return { ...item, ...patch, updatedAt: Date.now() };
    });
    saveState();
    render();
  }

  function removeQueueItem(id) {
    state.queue = state.queue.filter((item) => item.id !== id);
    saveState();
    render();
  }

  function parseStreamSummary(arrayBuffer) {
    const bytes = new Uint8Array(arrayBuffer || new ArrayBuffer(0));
    let offset = 0;
    let lastStatus = "";
    let finalFolder = "";
    let error = "";
    const decoder = new TextDecoder("utf-8");
    while (offset + 5 <= bytes.length) {
      const code = bytes[offset];
      const size = new DataView(bytes.buffer, bytes.byteOffset + offset + 1, 4).getUint32(0, false);
      const start = offset + 5;
      const end = start + size;
      if (end > bytes.length) break;
      const payload = bytes.slice(start, end);
      if (code === 1) {
        const text = decoder.decode(payload);
        lastStatus = text;
        if (text.startsWith("final_ready:")) finalFolder = text.slice("final_ready:".length);
        if (text.startsWith("rendering_folder:")) finalFolder = text.slice("rendering_folder:".length);
      } else if (code === 2) {
        error = decoder.decode(payload);
      }
      offset = end;
    }
    return { lastStatus, finalFolder, error };
  }

  async function translateItem(item) {
    const requestUrl = imageTranslateUrl();
    validateImageTranslateUrl(requestUrl);

    updateQueueItem(item.id, { status: "downloading", message: "下载原图中" });
    const file = await downloadImage(item);

    updateQueueItem(item.id, { status: "translating", message: "提交翻译中" });
    const form = new FormData();
    form.append("image", file);
    form.append("config", state.configText || "{}");

    const response = await gmRequest({
      method: "POST",
      url: requestUrl,
      headers: authHeader(),
      data: form,
      responseType: "arraybuffer",
      timeout: 30 * 60 * 1000,
    });

    const summary = parseStreamSummary(response.response);
    if (summary.error) {
      throw new Error(summary.error);
    }
    updateQueueItem(item.id, {
      status: "done",
      message: summary.finalFolder ? `完成: ${summary.finalFolder}` : "完成",
      folder: summary.finalFolder,
      outputName: item.outputName || file.name,
    });
  }

  async function translateQueue() {
    if (running) return;
    running = true;
    render();
    try {
      JSON.parse(state.configText || "{}");
    } catch (error) {
      running = false;
      setMessage(`配置 JSON 错误: ${error.message}`);
      return;
    }

    const targets = state.queue.filter((item) => item.status === "pending" || item.status === "error");
    if (!targets.length) {
      running = false;
      setMessage("没有待翻译图片。");
      return;
    }

    for (let index = 0; index < targets.length; index += 1) {
      const item = targets[index];
      setMessage(`正在翻译 ${index + 1}/${targets.length}`);
      try {
        await translateItem(item);
      } catch (error) {
        updateQueueItem(item.id, { status: "error", message: error.message || String(error) });
      }
    }
    running = false;
    await refreshResults();
    setMessage("批量翻译完成。");
  }

  async function refreshResults() {
    try {
      const host = imageServiceBase();
      const response = await gmRequest({
        method: "GET",
        url: `${host}/results/list`,
        headers: authHeader(),
        responseType: "json",
        timeout: 30000,
      });
      const data = typeof response.response === "object" && response.response
        ? response.response
        : JSON.parse(response.responseText || "{}");
      state.resultsCount = Array.isArray(data.directories) ? data.directories.length : 0;
      saveState();
      setMessage(`服务端已有 ${state.resultsCount} 个翻译结果。`);
    } catch (error) {
      setMessage(`刷新失败: ${error.message}`);
    }
  }

  function zipDownloadName() {
    const extracted = extractZipNameFromSelector();
    const raw = (extracted || state.zipName || "").trim();
    if (!raw) return "manga-translator-results.zip";
    const cleaned = raw.replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim();
    const base = cleaned || "manga-translator-results";
    return base.toLowerCase().endsWith(".zip") ? base : `${base}.zip`;
  }

  function extractZipNameFromSelector() {
    const selector = String(state.zipNameSelector || "").trim();
    if (!selector) return "";
    try {
      return String(document.querySelector(selector)?.textContent || "").trim();
    } catch (_) {
      return "";
    }
  }

  function saveBlob(blob, filename) {
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = objectUrl;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(objectUrl), 30000);
  }

  function gmDownloadFile(options) {
    return new Promise((resolve, reject) => {
      GM_download({
        ...options,
        onload() {
          resolve();
        },
        onerror(error) {
          reject(new Error(error?.error || error?.details || "download failed"));
        },
        ontimeout() {
          reject(new Error("Download timeout"));
        },
      });
    });
  }

  async function blobToText(blob) {
    try {
      return await blob.text();
    } catch (_) {
      return "";
    }
  }

  async function downloadZip() {
    const headers = authHeader();
    const name = zipDownloadName();
    const selected = state.queue
      .filter((item) => item.status === "done" && item.folder)
      .map((item) => ({
        folder: item.folder,
        name: item.outputName || queueOutputName(item),
      }));

    if (!selected.length) {
      setMessage("当前脚本队列没有已完成结果可下载。");
      return;
    }

    try {
      const host = imageServiceBase();
      setMessage(`正在准备 ${name}...`);
      const prepareResponse = await gmRequest({
        method: "POST",
        url: `${host}/results/prepare-selected-download`,
        headers: {
          ...headers,
          "Content-Type": "application/json",
        },
        data: JSON.stringify({ results: selected, filename: name }),
        responseType: "json",
        timeout: 30 * 60 * 1000,
      });
      const prepared = typeof prepareResponse.response === "object" && prepareResponse.response
        ? prepareResponse.response
        : JSON.parse(prepareResponse.responseText || "{}");
      const downloadUrl = new URL(prepared.url, `${host}/`).href;
      setMessage(`正在下载 ${name}...`);
      await gmDownloadFile({
        url: downloadUrl,
        name,
        headers,
        timeout: 30 * 60 * 1000,
      });
      setMessage(`已开始下载 ${name}`);
    } catch (prepareError) {
      try {
        setMessage(`原生下载不可用，正在兼容下载 ${name}...`);
        await downloadZipAsBlob(host, headers, selected, name);
        setMessage(`已下载 ${name}`);
      } catch (blobError) {
        setMessage(`下载 ZIP 失败: ${blobError.message || prepareError.message || String(blobError)}`);
      }
    }
  }

  async function downloadZipAsBlob(host, headers, selected, name) {
      const response = await gmRequest({
        method: "POST",
        url: `${host}/results/download-selected.zip`,
        headers: {
          ...headers,
          "Content-Type": "application/json",
        },
        data: JSON.stringify({ results: selected }),
        responseType: "blob",
        timeout: 30 * 60 * 1000,
      });
      const blob = response.response instanceof Blob
        ? response.response
        : new Blob([response.response], { type: "application/zip" });
      if (!blob.size) {
        throw new Error("empty zip response");
      }
      const contentType = blob.type || "";
      if (contentType.includes("application/json") || contentType.includes("text/")) {
        const text = await blobToText(blob);
        throw new Error(text || `unexpected response type: ${contentType}`);
      }
      saveBlob(blob, name);
  }

  function clearDone() {
    state.queue = state.queue.filter((item) => item.status !== "done");
    saveState();
    render();
  }

  function clearQueue() {
    if (!window.confirm("清空当前油猴队列？服务端结果不会删除。")) return;
    state.queue = [];
    saveState();
    render();
  }

  function retryErrors() {
    state.queue = state.queue.map((item) => item.status === "error" ? { ...item, status: "pending", message: "" } : item);
    saveState();
    render();
  }

  function renderAssistantModal(item) {
    const title = item.title || item.sourceText || item.sourceUrl || "助手记录";
    const message = item.message ? `<div class="mit-modal-message mit-${escapeAttr(item.status || "done")}">${escapeHtml(item.message)}</div>` : "";
    let content = "";
    if (item.type === "image") {
      const result = item.resultUrl
        ? `<img class="mit-preview-image" data-action="openBigImage" data-title="译图" src="${escapeAttr(item.resultPreviewUrl || item.resultUrl)}" alt="translated image">
           <button data-action="downloadAssistantUrl" data-url="${escapeAttr(item.resultUrl)}" data-name="${escapeAttr(`${safeFileStem(title)}.png`)}">下载译图</button>`
        : `<div class="mit-muted">译图还没有返回。</div>`;
      content = `
        <div class="mit-modal-grid">
          <div>
            <strong>译图</strong>
            ${result}
          </div>
          <div>
            <strong>原图</strong>
            ${item.sourceUrl ? `<img class="mit-preview-image" data-action="openBigImage" data-title="原图" src="${escapeAttr(item.sourceUrl)}" alt="source image">
            <button data-action="downloadAssistantUrl" data-url="${escapeAttr(item.sourceUrl)}" data-name="${escapeAttr(fileNameFromUrl(item.sourceUrl, 1))}">下载原图</button>` : ""}
          </div>
        </div>
      `;
    } else if (item.type === "audio") {
      content = `
        <div class="mit-text-block">${escapeHtml(item.sourceText || "")}</div>
        ${item.audioUrl ? `<audio controls src="${escapeAttr(item.audioUrl)}"></audio>` : '<div class="mit-muted">语音还没有生成。</div>'}
      `;
    } else {
      content = `
        <div class="mit-modal-grid">
          <div>
            <strong>译文</strong>
            <div class="mit-text-block">${escapeHtml(item.resultText || "")}</div>
          </div>
          <div>
            <strong>原文</strong>
            <div class="mit-text-block">${escapeHtml(item.sourceText || "")}</div>
          </div>
        </div>
      `;
    }
    return `
      <div class="mit-modal">
        <div class="mit-modal-panel">
          <div class="mit-modal-head">
            <strong>${escapeHtml(assistantTypeLabel(item.type))}: ${escapeHtml(shortText(title, 56))}</strong>
            <button data-action="closeAssistantModal">关闭</button>
          </div>
          ${message}
          <div class="mit-modal-body">${content}</div>
        </div>
      </div>
    `;
  }

  function bindInput(selector, key, transform = (value) => value) {
    const el = root.querySelector(selector);
    if (!el) return;
    const update = () => {
      state[key] = transform(el.type === "checkbox" ? el.checked : el.value);
      saveState();
    };
    el.addEventListener(el.type === "checkbox" ? "change" : "input", update);
    if (el.type !== "checkbox") el.addEventListener("change", update);
  }

  function button(selector, handler) {
    const el = root.querySelector(selector);
    if (el) el.addEventListener("click", handler);
  }

  function statusText() {
    const counts = state.queue.reduce((acc, item) => {
      acc[item.status] = (acc[item.status] || 0) + 1;
      return acc;
    }, {});
    return `队列 ${state.queue.length} | 待翻译 ${counts.pending || 0} | 完成 ${counts.done || 0} | 失败 ${counts.error || 0} | 服务端结果 ${state.resultsCount || 0}`;
  }

  function renderSection(id, title, content) {
    const open = openSections.has(id);
    return `
      <section class="mit-section" data-section="${escapeAttr(id)}">
        <button class="mit-section-toggle" type="button" data-action="toggleSection" data-section="${escapeAttr(id)}" aria-expanded="${open ? "true" : "false"}">
          <span class="mit-section-caret">${open ? "▾" : "▸"}</span>
          <span>${escapeHtml(title)}</span>
        </button>
        <div class="mit-section-body" ${open ? "" : "hidden"}>${content}</div>
      </section>
    `;
  }

  function clampPanelPosition(left, top) {
    const rect = panelFrame?.getBoundingClientRect() || root?.getBoundingClientRect();
    const width = rect?.width || 56;
    const height = rect?.height || 40;
    const margin = 8;
    return {
      left: Math.min(Math.max(margin, left), Math.max(margin, window.innerWidth - width - margin)),
      top: Math.min(Math.max(margin, top), Math.max(margin, window.innerHeight - height - margin)),
    };
  }

  function applyPanelPosition() {
    const target = panelFrame || root;
    if (!target) return;
    if (Number.isFinite(state.panelLeft) && Number.isFinite(state.panelTop)) {
      const pos = clampPanelPosition(state.panelLeft, state.panelTop);
      state.panelLeft = pos.left;
      state.panelTop = pos.top;
      target.style.left = `${pos.left}px`;
      target.style.top = `${pos.top}px`;
      target.style.right = "auto";
    } else {
      target.style.left = "";
      target.style.top = panelFrame ? "72px" : "";
      target.style.right = panelFrame ? "16px" : "";
    }
  }

  function ensureTopLayer(forceToFront = false) {
    if (panelFrame) {
      panelFrame.style.zIndex = "2147483647";
      return;
    }
    if (!root || typeof root.showPopover !== "function") return;
    try {
      if (forceToFront && root.matches(":popover-open")) {
        root.hidePopover();
      }
      if (!root.matches(":popover-open")) {
        root.showPopover();
      }
    } catch (_) {
      // Some pages/browsers can reject popover while the document is inactive.
    }
  }

  function syncFrameSize() {
    if (!panelFrame || !root) return;
    const viewportWidth = window.innerWidth || 320;
    const viewportHeight = window.innerHeight || 640;
    if (state.collapsed) {
      panelFrame.style.width = "56px";
      panelFrame.style.height = "56px";
      return;
    }
    const width = Math.min(320, Math.max(280, viewportWidth - 16));
    const top = Number.isFinite(state.panelTop) ? state.panelTop : 72;
    panelFrame.style.width = `${width}px`;
    panelFrame.style.height = `${Math.min(viewportHeight - top - 8, 820)}px`;
  }

  function bindMiniDrag() {
    const el = root?.querySelector(".mit-mini-toggle");
    if (!el) return;
    let dragging = false;
    let moved = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    el.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      const rect = (panelFrame || root).getBoundingClientRect();
      dragging = true;
      moved = false;
      startX = event.clientX;
      startY = event.clientY;
      startLeft = rect.left;
      startTop = rect.top;
      el.setPointerCapture?.(event.pointerId);
    });

    el.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      if (Math.abs(dx) + Math.abs(dy) > 4) moved = true;
      if (!moved) return;
      const pos = clampPanelPosition(startLeft + dx, startTop + dy);
      state.panelLeft = pos.left;
      state.panelTop = pos.top;
      const target = panelFrame || root;
      target.style.left = `${pos.left}px`;
      target.style.top = `${pos.top}px`;
      target.style.right = "auto";
      event.preventDefault();
    });

    const finishDrag = (event) => {
      if (!dragging) return;
      dragging = false;
      el.releasePointerCapture?.(event.pointerId);
      if (moved) {
        suppressMiniClickUntil = Date.now() + 350;
        saveState();
      }
    };

    el.addEventListener("pointerup", finishDrag);
    el.addEventListener("pointercancel", finishDrag);
  }

  function render() {
    if (!root) return;
    root.classList.toggle("mit-root-collapsed", state.collapsed);
    if (state.collapsed) {
      root.innerHTML = `<button class="mit-mini-toggle" data-action="toggle" title="翻译助手">译</button>`;
      syncFrameSize();
      applyPanelPosition();
      ensureTopLayer();
      bindMiniDrag();
      button('[data-action="toggle"]', () => {
        if (Date.now() < suppressMiniClickUntil) return;
        state.collapsed = false;
        saveState();
        render();
      });
      return;
    }

    const queuePreview = state.queue.map((item, index) => `
      <div class="mit-row" title="${escapeHtml(item.url)}">
        <span>${index + 1}</span>
        <span class="mit-status mit-${item.status}">${escapeHtml(item.status)}</span>
        <span>${escapeHtml(item.message || shortUrl(item.url))}</span>
        <button class="mit-delete" data-action="removeItem" data-id="${escapeAttr(item.id)}">删除</button>
      </div>
    `).join("");
    const assistant = assistantState();
    const assistantHistory = (assistant.history || []).map((item) => `
      <div class="mit-assistant-row" data-action="openAssistantItem" data-id="${escapeAttr(item.id)}" title="${escapeAttr(item.title || item.sourceText || item.sourceUrl || "")}">
        <span class="mit-kind">${escapeHtml(assistantTypeLabel(item.type))}</span>
        <span class="mit-assistant-title">${escapeHtml(item.title || item.sourceText || item.sourceUrl || "")}</span>
        <span class="mit-status mit-${item.status || "done"}">${escapeHtml(item.status || "done")}</span>
        <button class="mit-delete" data-action="removeAssistantItem" data-id="${escapeAttr(item.id)}">删除</button>
      </div>
    `).join("");
    const activeItem = activeModalId
      ? (assistant.history || []).find((item) => item.id === activeModalId)
      : null;
    const assistantModal = activeItem ? renderAssistantModal(activeItem) : "";

    root.innerHTML = `
      <div class="mit-card">
        <div class="mit-head">
          <strong>翻译助手</strong>
          <button data-action="toggle">收起</button>
        </div>
        <div class="mit-body">
          ${renderSection("host", "HOST 维度", `
            <label>ZIP name selector <input data-field="zipNameSelector" value="${escapeAttr(state.zipNameSelector)}" placeholder="CSS selector, e.g. h1"></label>
            <label>ZIP name <input data-field="zipName" value="${escapeAttr(state.zipName)}"></label>
            <label>Image blacklist <input data-field="imageBlacklist" value="${escapeAttr(state.imageBlacklist)}" placeholder="abc123.webp, cover.jpg"></label>
          `)}
          ${renderSection("all", "ALL 维度", `
            <label class="mit-check"><input data-field="useBasicAuth" type="checkbox" ${state.useBasicAuth ? "checked" : ""}> Basic Auth</label>
            <div class="mit-grid">
              <label>User <input data-field="username" value="${escapeAttr(state.username)}"></label>
              <label>Pass <input data-field="password" type="password" value="${escapeAttr(state.password)}"></label>
            </div>
            <div class="mit-config-group">
              <strong>图片翻译</strong>
              <label>接口 <input data-assistant-field="imageTranslatePath" value="${escapeAttr(assistant.imageTranslatePath)}" placeholder="http://host:11585/translate/with-form/image/stream/web"></label>
              <label>Config JSON（批量队列和右键单图共用）<textarea data-field="configText" spellcheck="false">${escapeHtml(state.configText)}</textarea></label>
            </div>
            <div class="mit-config-group">
              <strong>文本翻译</strong>
              <label>接口 <input data-assistant-field="textTranslatePath" value="${escapeAttr(assistant.textTranslatePath)}" placeholder="http://host:11586/v1/chat/completions"></label>
              <label>目标语言 <input data-assistant-field="textTargetLang" value="${escapeAttr(assistant.textTargetLang)}"></label>
              <label>请求 JSON（OpenAI/Sakura 参数）<textarea data-assistant-field="textRequestJson" spellcheck="false">${escapeHtml(assistant.textRequestJson)}</textarea></label>
            </div>
            <div class="mit-config-group">
              <strong>TTS</strong>
              <label>接口 <input data-assistant-field="ttsPath" value="${escapeAttr(assistant.ttsPath)}" placeholder="http://host:11587/assistant/tts"></label>
              <label>TTS Voice <input data-assistant-field="ttsVoice" value="${escapeAttr(assistant.ttsVoice)}"></label>
              <label>请求 JSON<textarea data-assistant-field="ttsRequestJson" spellcheck="false">${escapeHtml(assistant.ttsRequestJson)}</textarea></label>
            </div>
          `)}
          ${renderSection("batch-actions", "批量相关按钮", `
            <div class="mit-actions mit-actions-compact">
              <button data-action="detect">抓取图片</button>
              <button data-action="translate" ${running ? "disabled" : ""}>翻译队列</button>
              <button data-action="refresh">刷新状态</button>
              <button data-action="download">下载 ZIP</button>
              <button data-action="retry">失败重试</button>
              <button data-action="clearDone">清除完成</button>
              <button data-action="clearQueue">清空队列</button>
            </div>
            <div class="mit-summary">${escapeHtml(statusText())}</div>
            <div class="mit-message">${escapeHtml(state.lastMessage || "")}</div>
          `)}
          ${renderSection("batch-queue", "批量队列", `
            <div class="mit-list">${queuePreview || '<div class="mit-muted">还没有图片。点击“抓取图片”累计当前页图片。</div>'}</div>
          `)}
          ${renderSection("assistant-cache", "助手缓存", `
            <div class="mit-helper-head">
              <strong>缓存记录</strong>
              <button data-action="clearAssistantHistory">清空</button>
            </div>
            <div class="mit-assistant-list">${assistantHistory || '<div class="mit-muted">右键图片或选中文本后使用翻译助手。</div>'}</div>
          `)}
        </div>
      </div>
      ${assistantModal}
    `;
    syncFrameSize();
    applyPanelPosition();
    ensureTopLayer();

    button('[data-action="toggle"]', () => {
      state.collapsed = true;
      saveState();
      render();
    });
    button('[data-action="detect"]', addDetectedImages);
    button('[data-action="translate"]', translateQueue);
    button('[data-action="refresh"]', refreshResults);
    button('[data-action="download"]', downloadZip);
    button('[data-action="retry"]', retryErrors);
    button('[data-action="clearDone"]', clearDone);
    button('[data-action="clearQueue"]', clearQueue);
    root.querySelectorAll('[data-action="toggleSection"]').forEach((el) => {
      el.addEventListener("click", () => {
        const section = el.dataset.section || "";
        if (!section) return;
        if (openSections.has(section)) {
          openSections.delete(section);
        } else {
          openSections.add(section);
        }
        render();
      });
    });
    root.querySelectorAll('[data-action="removeItem"]').forEach((el) => {
      el.addEventListener("click", () => removeQueueItem(el.dataset.id));
    });
    root.querySelectorAll('[data-action="openAssistantItem"]').forEach((el) => {
      el.addEventListener("click", () => {
        activeModalId = el.dataset.id;
        render();
      });
    });
    root.querySelectorAll('[data-action="removeAssistantItem"]').forEach((el) => {
      el.addEventListener("click", (event) => {
        event.stopPropagation();
        removeAssistantHistory(el.dataset.id);
      });
    });
    bindInput('[data-field="host"]', "host", normalizeHost);
    bindInput('[data-field="useBasicAuth"]', "useBasicAuth");
    bindInput('[data-field="username"]', "username");
    bindInput('[data-field="password"]', "password");
    bindInput('[data-field="zipNameSelector"]', "zipNameSelector");
    bindInput('[data-field="zipName"]', "zipName");
    bindInput('[data-field="imageBlacklist"]', "imageBlacklist");
    bindInput('[data-field="configText"]', "configText");
    root.querySelectorAll("[data-assistant-field]").forEach((el) => {
      const updateAssistantField = () => {
        assistantState()[el.dataset.assistantField] = el.value;
        saveState();
      };
      el.addEventListener("input", updateAssistantField);
      el.addEventListener("change", updateAssistantField);
    });
    button('[data-action="clearAssistantHistory"]', clearAssistantHistory);
    button('[data-action="closeAssistantModal"]', () => {
      activeModalId = "";
      render();
    });
    root.querySelectorAll('[data-action="openBigImage"]').forEach((el) => {
      el.addEventListener("click", () => {
        showBigImage(el.getAttribute("src") || "", el.dataset.title || "图片预览");
      });
    });
    root.querySelectorAll('[data-action="downloadAssistantUrl"]').forEach((el) => {
      el.addEventListener("click", () => {
        const url = el.dataset.url || "";
        if (!url) return;
        GM_download({
          url,
          name: el.dataset.name || `${safeFileStem(activeItem?.title || "assistant-download")}.png`,
          headers: authHeader(),
        });
      });
    });
  }

  function shortUrl(url) {
    try {
      const parsed = new URL(url);
      const name = decodeURIComponent(parsed.pathname.split("/").pop() || parsed.hostname);
      return name.length > 44 ? `${name.slice(0, 41)}...` : name;
    } catch (_) {
      return url.length > 44 ? `${url.slice(0, 41)}...` : url;
    }
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function escapeAttr(value) {
    return escapeHtml(value).replace(/`/g, "&#096;");
  }

  function installStyles(targetDocument = document) {
    const css = `
      html,
      body {
        margin: 0;
        padding: 0;
        background: transparent;
        overflow: hidden;
      }
      #mit-submitter-root {
        position: static;
        width: 100%;
        max-width: 100%;
        max-height: 100dvh;
        color: #172026;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        font-size: 13px;
      }
      #mit-submitter-root[popover] {
        border: 0;
        padding: 0;
        margin: 0;
        background: transparent;
        overflow: visible;
        inset: auto;
      }
      #mit-submitter-root * {
        box-sizing: border-box;
      }
      #mit-submitter-root.mit-root-collapsed {
        width: auto;
        max-width: none;
      }
      #mit-submitter-root .mit-card {
        background: #f8fafc;
        border: 1px solid #b8c2cc;
        border-radius: 8px;
        box-shadow: 0 12px 36px rgba(15, 23, 42, 0.22);
        overflow: hidden;
        height: 100dvh;
        max-height: 100dvh;
        display: flex;
        flex-direction: column;
      }
      #mit-submitter-root .mit-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
        padding: 8px 10px;
        background: #1f2937;
        color: white;
      }
      #mit-submitter-root .mit-body {
        display: grid;
        gap: 7px;
        padding: 9px;
        min-height: 0;
        flex: 1;
        overflow-y: auto;
        overscroll-behavior: contain;
      }
      #mit-submitter-root .mit-collapsed .mit-body {
        display: none;
      }
      #mit-submitter-root .mit-mini-toggle {
        width: 52px;
        height: 52px;
        padding: 0;
        border-radius: 50%;
        box-shadow: 0 10px 28px rgba(15, 23, 42, 0.22);
        touch-action: none;
        user-select: none;
        font-size: 18px;
        line-height: 1;
      }
      #mit-submitter-root label {
        display: grid;
        gap: 3px;
        font-weight: 600;
      }
      #mit-submitter-root input,
      #mit-submitter-root textarea {
        width: 100%;
        border: 1px solid #cbd5e1;
        border-radius: 6px;
        padding: 6px 8px;
        background: white;
        color: #111827;
        font: inherit;
      }
      #mit-submitter-root textarea {
        min-height: 120px;
        resize: vertical;
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 12px;
      }
      #mit-submitter-root .mit-check {
        display: flex;
        grid-template-columns: none;
        align-items: center;
        gap: 6px;
      }
      #mit-submitter-root .mit-check input {
        width: auto;
      }
      #mit-submitter-root .mit-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 8px;
      }
      #mit-submitter-root .mit-actions {
        display: grid;
        grid-template-columns: repeat(4, minmax(0, 1fr));
        gap: 5px;
      }
      #mit-submitter-root .mit-actions-compact {
        grid-template-columns: repeat(4, minmax(0, 1fr));
      }
      #mit-submitter-root button {
        border: 1px solid #334155;
        border-radius: 6px;
        padding: 5px 6px;
        background: #334155;
        color: white;
        cursor: pointer;
        font: inherit;
        font-weight: 650;
        line-height: 1.15;
      }
      #mit-submitter-root button:disabled {
        opacity: 0.5;
        cursor: wait;
      }
      #mit-submitter-root .mit-summary,
      #mit-submitter-root .mit-message,
      #mit-submitter-root .mit-muted {
        color: #475569;
      }
      #mit-submitter-root .mit-list {
        display: grid;
        gap: 4px;
        min-height: min(126px, 22dvh);
        max-height: min(260px, 34dvh);
        overflow: auto;
        overscroll-behavior: contain;
      }
      #mit-submitter-root .mit-section {
        border: 1px solid #dbe3ea;
        border-radius: 6px;
        background: #fff;
        overflow: hidden;
      }
      #mit-submitter-root .mit-section-toggle {
        width: 100%;
        min-height: 24px;
        padding: 3px 8px;
        border: 0;
        border-radius: 0;
        background: #eef2f7;
        color: #172026;
        cursor: pointer;
        font-weight: 700;
        display: flex;
        align-items: center;
        justify-content: flex-start;
        gap: 6px;
        text-align: left;
        line-height: 1.15;
      }
      #mit-submitter-root .mit-section-toggle:hover,
      #mit-submitter-root .mit-section-toggle:focus {
        background: #e2e8f0;
        outline: none;
      }
      #mit-submitter-root .mit-section-caret {
        width: 12px;
        flex: 0 0 12px;
        color: #475569;
      }
      #mit-submitter-root .mit-section-body {
        display: grid;
        gap: 7px;
        padding: 7px;
      }
      #mit-submitter-root .mit-section-body[hidden] {
        display: none;
        padding: 0;
      }
      #mit-submitter-root .mit-config-group {
        display: grid;
        gap: 7px;
        padding-top: 7px;
        border-top: 1px solid #e2e8f0;
      }
      #mit-submitter-root .mit-config-group:first-of-type {
        border-top: 0;
        padding-top: 0;
      }
      #mit-submitter-root .mit-helper-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }
      #mit-submitter-root .mit-helper-head button {
        padding: 4px 7px;
        font-size: 12px;
      }
      #mit-submitter-root .mit-assistant-list {
        display: grid;
        gap: 4px;
        min-height: min(70px, 14dvh);
        max-height: min(210px, 28dvh);
        overflow: auto;
        overscroll-behavior: contain;
      }
      #mit-submitter-root .mit-assistant-row {
        display: grid;
        grid-template-columns: 42px minmax(0, 1fr) 66px 48px;
        gap: 6px;
        align-items: center;
        min-height: 28px;
        padding: 4px 6px;
        border: 1px solid #dbe3ea;
        border-radius: 6px;
        background: white;
        cursor: pointer;
      }
      #mit-submitter-root .mit-assistant-title {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #mit-submitter-root .mit-kind {
        border-radius: 999px;
        padding: 2px 6px;
        background: #f1f5f9;
        color: #334155;
        text-align: center;
      }
      #mit-submitter-root .mit-row {
        display: grid;
        grid-template-columns: 22px 72px minmax(0, 1fr) 48px;
        gap: 6px;
        align-items: center;
        min-height: 26px;
        padding: 4px 6px;
        border: 1px solid #dbe3ea;
        border-radius: 6px;
        background: white;
      }
      #mit-submitter-root .mit-row span:last-child {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #mit-submitter-root .mit-row > span:nth-child(3) {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #mit-submitter-root .mit-delete {
        padding: 4px 5px;
        font-size: 12px;
      }
      #mit-submitter-root .mit-status {
        border-radius: 999px;
        padding: 2px 6px;
        text-align: center;
        background: #e2e8f0;
      }
      #mit-submitter-root .mit-done {
        background: #dcfce7;
        color: #166534;
      }
      #mit-submitter-root .mit-error {
        background: #fee2e2;
        color: #991b1b;
      }
      #mit-submitter-root .mit-translating,
      #mit-submitter-root .mit-downloading,
      #mit-submitter-root .mit-pending {
        background: #dbeafe;
        color: #1d4ed8;
      }
      #mit-submitter-root .mit-modal {
        position: fixed;
        inset: 0;
        z-index: 10;
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 12px;
        background: rgba(15, 23, 42, 0.38);
      }
      #mit-submitter-root .mit-modal-panel {
        position: relative;
        width: min(100%, 760px);
        max-height: calc(100dvh - 24px);
        display: flex;
        flex-direction: column;
        gap: 8px;
        padding: 10px;
        border: 1px solid #b8c2cc;
        border-radius: 8px;
        background: #f8fafc;
        box-shadow: 0 20px 56px rgba(15, 23, 42, 0.3);
      }
      #mit-submitter-root .mit-modal-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 8px;
      }
      #mit-submitter-root .mit-modal-head strong {
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      #mit-submitter-root .mit-modal-body {
        min-height: 0;
        overflow: auto;
      }
      #mit-submitter-root .mit-modal-grid {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 10px;
      }
      #mit-submitter-root .mit-modal-grid > div {
        min-width: 0;
        display: grid;
        gap: 6px;
        align-content: start;
      }
      #mit-submitter-root .mit-preview-image {
        width: 100%;
        max-height: 58dvh;
        object-fit: contain;
        border: 1px solid #dbe3ea;
        border-radius: 6px;
        background: white;
        cursor: zoom-in;
      }
      #mit-submitter-root .mit-text-block {
        max-height: 52dvh;
        overflow: auto;
        white-space: pre-wrap;
        word-break: break-word;
        padding: 8px;
        border: 1px solid #dbe3ea;
        border-radius: 6px;
        background: white;
      }
      #mit-submitter-root audio {
        width: 100%;
      }
      #mit-submitter-root .mit-modal-message {
        padding: 6px 8px;
        border-radius: 6px;
        background: #e2e8f0;
      }
      @media (max-width: 520px), (max-height: 680px) {
        #mit-submitter-root {
          width: 100%;
          max-height: calc(100dvh - 16px);
        }
        #mit-submitter-root .mit-card {
          max-height: calc(100dvh - 16px);
        }
        #mit-submitter-root .mit-actions {
          grid-template-columns: repeat(3, minmax(0, 1fr));
        }
        #mit-submitter-root textarea {
          min-height: 82px;
        }
        #mit-submitter-root .mit-list {
          max-height: 32dvh;
        }
        #mit-submitter-root .mit-assistant-row {
          grid-template-columns: 38px minmax(0, 1fr) 56px 44px;
        }
        #mit-submitter-root .mit-modal-grid {
          grid-template-columns: 1fr;
        }
      }
    `;
    if (targetDocument === document && typeof GM_addStyle === "function") {
      GM_addStyle(css);
      return;
    }
    const style = targetDocument.createElement("style");
    style.textContent = css;
    targetDocument.head.appendChild(style);
  }

  function installOuterStyles() {
    if (document.getElementById("mit-submitter-outer-style")) return;
    const style = document.createElement("style");
    style.id = "mit-submitter-outer-style";
    style.textContent = `
      #mit-submitter-frame {
        pointer-events: auto !important;
      }
      #mit-context-menu {
        position: fixed;
        z-index: 2147483647;
        display: none;
        min-width: 148px;
        padding: 6px;
        background: #f8fafc;
        color: #172026;
        border: 1px solid #b8c2cc;
        border-radius: 8px;
        box-shadow: 0 14px 36px rgba(15, 23, 42, 0.24);
        font: 13px/1.35 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      #mit-context-menu button {
        display: block;
        width: 100%;
        border: 0;
        border-radius: 6px;
        padding: 7px 9px;
        background: transparent;
        color: #172026;
        text-align: left;
        cursor: pointer;
        font: inherit;
      }
      #mit-context-menu button:hover,
      #mit-context-menu button:focus {
        background: #e2e8f0;
        outline: none;
      }
      #mit-context-menu .mit-menu-title {
        padding: 4px 8px 6px;
        color: #64748b;
        font-size: 12px;
        font-weight: 700;
      }
      #mit-context-menu .mit-menu-sep {
        height: 1px;
        margin: 5px 3px;
        background: #dbe3ea;
      }
      #mit-big-image-root {
        position: fixed;
        inset: 0;
        z-index: 2147483647;
        display: none;
        grid-template-rows: auto minmax(0, 1fr);
        gap: 8px;
        padding: 12px;
        background: rgba(2, 6, 23, 0.94);
        color: white;
        box-sizing: border-box;
        font: 13px/1.35 ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      #mit-big-image-root .mit-big-image-head {
        position: relative;
        z-index: 2;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }
      #mit-big-image-root button {
        border: 1px solid #475569;
        border-radius: 6px;
        padding: 6px 10px;
        background: #334155;
        color: white;
        cursor: pointer;
        font: inherit;
        font-weight: 650;
      }
      #mit-big-image-root img {
        position: relative;
        z-index: 1;
        pointer-events: none;
        width: 100%;
        height: 100%;
        min-height: 0;
        object-fit: contain;
        background: #020617;
        border-radius: 6px;
      }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function ensureBigImageRoot() {
    if (bigImageRoot && document.documentElement.contains(bigImageRoot)) return bigImageRoot;
    installOuterStyles();
    bigImageRoot = document.createElement("div");
    bigImageRoot.id = "mit-big-image-root";
    bigImageRoot.innerHTML = `
      <div class="mit-big-image-head">
        <strong data-big-title>图片预览</strong>
        <button type="button" data-big-close>关闭</button>
      </div>
      <img data-big-image alt="图片预览">
    `;
    (document.body || document.documentElement).appendChild(bigImageRoot);
    ["pointerdown", "mousedown", "mouseup", "click", "auxclick", "touchstart", "touchend", "contextmenu"].forEach((type) => {
      bigImageRoot.addEventListener(type, (event) => {
        if (["pointerdown", "mousedown", "touchstart", "click"].includes(type)) {
          hideBigImage();
        }
        event.stopPropagation();
        event.stopImmediatePropagation();
      }, true);
    });
    bigImageRoot.querySelector("[data-big-close]").addEventListener("click", hideBigImage);
    window.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && bigImageRoot?.style.display !== "none") hideBigImage();
    }, true);
    return bigImageRoot;
  }

  function showBigImage(src, title) {
    if (!src) return;
    const overlay = ensureBigImageRoot();
    overlay.querySelector("[data-big-title]").textContent = title || "图片预览";
    const img = overlay.querySelector("[data-big-image]");
    img.src = src;
    img.alt = title || "图片预览";
    overlay.style.display = "grid";
  }

  function hideBigImage() {
    if (!bigImageRoot) return;
    bigImageRoot.style.display = "none";
    const img = bigImageRoot.querySelector("[data-big-image]");
    if (img) img.removeAttribute("src");
  }

  function ensureContextMenu() {
    if (contextMenu && document.documentElement.contains(contextMenu)) return contextMenu;
    installOuterStyles();
    contextMenu = document.createElement("div");
    contextMenu.id = "mit-context-menu";
    contextMenu.setAttribute("role", "menu");
    contextMenu.innerHTML = `
      <div class="mit-menu-title">翻译助手 · Shift+右键原菜单</div>
      <button type="button" role="menuitem" data-menu-action="translateImage">发送翻译</button>
      <div class="mit-menu-sep" data-menu-image-sep></div>
      <button type="button" role="menuitem" data-menu-action="translateText">翻译中文</button>
      <button type="button" role="menuitem" data-menu-action="speakText">文本转语音</button>
    `;
    (document.body || document.documentElement).appendChild(contextMenu);
    ["pointerdown", "mousedown", "mouseup", "click", "auxclick", "touchstart", "touchend", "contextmenu"].forEach((type) => {
      contextMenu.addEventListener(type, (event) => {
        event.preventDefault();
        event.stopPropagation();
      }, true);
    });
    contextMenu.addEventListener("click", runContextMenuAction);
    return contextMenu;
  }

  function runContextMenuAction(event) {
    const buttonEl = event.target?.closest?.("[data-menu-action]");
    if (!buttonEl || buttonEl.style.display === "none") return;
    event.preventDefault();
    const action = buttonEl.dataset.menuAction;
    const context = { ...menuContext };
    hideContextMenu();
    if (action === "translateImage") translateImageUrlNow(context.imageUrl);
    if (action === "translateText") translateSelectedText(context.text);
    if (action === "speakText") speakSelectedText(context.text);
  }

  function showContextMenu(event, context) {
    const menu = ensureContextMenu();
    menuContext = {
      imageUrl: context.imageUrl || "",
      text: context.text || "",
    };
    const imageButton = menu.querySelector('[data-menu-action="translateImage"]');
    const imageSep = menu.querySelector("[data-menu-image-sep]");
    const textButtons = menu.querySelectorAll('[data-menu-action="translateText"], [data-menu-action="speakText"]');
    imageButton.style.display = menuContext.imageUrl ? "block" : "none";
    imageSep.style.display = menuContext.imageUrl && menuContext.text ? "block" : "none";
    textButtons.forEach((buttonEl) => {
      buttonEl.style.display = menuContext.text ? "block" : "none";
    });
    menu.style.display = "block";
    contextMenuShownAt = Date.now();
    contextMenuStickyUntil = contextMenuShownAt + 5000;
    menu.style.left = "0px";
    menu.style.top = "0px";
    const rect = menu.getBoundingClientRect();
    const margin = 8;
    const preferLeft = event.clientX - rect.width - margin;
    const preferRight = event.clientX + margin;
    const left = preferLeft >= margin
      ? preferLeft
      : Math.min(Math.max(margin, preferRight), Math.max(margin, window.innerWidth - rect.width - margin));
    const top = Math.min(Math.max(margin, event.clientY - 6), Math.max(margin, window.innerHeight - rect.height - margin));
    menu.style.left = `${left}px`;
    menu.style.top = `${top}px`;
    window.setTimeout(() => {
      if (Date.now() >= contextMenuStickyUntil) hideContextMenu();
    }, 9000);
  }

  function hideContextMenu() {
    if (!contextMenu) return;
    contextMenu.style.display = "none";
    menuContext = { imageUrl: "", text: "" };
    contextMenuStickyUntil = 0;
  }

  function installContextMenu() {
    window.addEventListener("contextmenu", (event) => {
      if (eventTargetsPanel(event)) return;
      if (event.shiftKey) {
        hideContextMenu();
        return;
      }
      const target = event.target;
      const image = target?.closest?.("img");
      const imageUrl = image ? imageUrlFromElement(image) : "";
      const text = selectedPageText();
      if (!imageUrl && !text) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      showContextMenu(event, { imageUrl, text });
      ensureTopLayer(true);
    }, true);
    ["pointerdown", "click", "keydown", "scroll", "resize"].forEach((type) => {
      window.addEventListener(type, (event) => {
        if (type === "keydown" && event.key !== "Escape") return;
        if (type === "keydown" && event.key === "Escape") {
          hideContextMenu();
          return;
        }
        if (eventTargetsPanel(event)) return;
        if (Date.now() < contextMenuStickyUntil) return;
        hideContextMenu();
      }, true);
    });
  }

  function init() {
    if (initialized) return;
    const mountTarget = document.body || document.documentElement;
    if (!mountTarget) return;
    initialized = true;
    installOuterStyles();

    panelFrame = document.createElement("iframe");
    panelFrame.id = "mit-submitter-frame";
    panelFrame.setAttribute("title", "Manga Image Translator Submitter");
    panelFrame.setAttribute("aria-label", "Manga Image Translator Submitter");
    Object.assign(panelFrame.style, {
      position: "fixed",
      right: "16px",
      top: "72px",
      width: "320px",
      height: "560px",
      maxWidth: "calc(100vw - 16px)",
      maxHeight: "calc(100dvh - 24px)",
      zIndex: "2147483647",
      border: "0",
      background: "transparent",
      colorScheme: "normal",
    });
    mountTarget.appendChild(panelFrame);

    const frameDocument = panelFrame.contentDocument;
    frameDocument.open();
    frameDocument.write("<!doctype html><html><head><meta charset=\"UTF-8\"><meta name=\"viewport\" content=\"width=device-width, initial-scale=1\"></head><body></body></html>");
    frameDocument.close();
    installStyles(frameDocument);

    root = frameDocument.createElement("div");
    root.id = "mit-submitter-root";
    frameDocument.body.appendChild(root);
    render();
    ["pointerenter", "pointerdown", "focusin"].forEach((type) => {
      root.addEventListener(type, () => ensureTopLayer(true), true);
    });
    window.addEventListener("pointerdown", (event) => {
      if (eventTargetsPanel(event)) return;
      window.setTimeout(() => ensureTopLayer(true), 0);
    }, true);
    window.addEventListener("resize", () => {
      syncFrameSize();
      applyPanelPosition();
    });
    statusTimer = window.setInterval(() => {
      if (!document.documentElement.contains(panelFrame)) {
        window.clearInterval(statusTimer);
        return;
      }
      syncFrameSize();
      ensureTopLayer();
    }, 30000);
  }

  function initSoon() {
    init();
    if (initialized) return;
    const timer = window.setInterval(() => {
      init();
      if (initialized) window.clearInterval(timer);
    }, 25);
    document.addEventListener("DOMContentLoaded", () => {
      init();
      if (initialized) window.clearInterval(timer);
    }, { once: true });
  }

  initSoon();
  installContextMenu();
})();
