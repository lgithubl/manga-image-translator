// ==UserScript==
// @name         Manga Image Translator Submitter
// @namespace    https://github.com/lgithubl/manga-image-translator
// @version      0.1.0
// @description  Collect manga page images and submit them to a manga-image-translator server.
// @match        *://*/*
// @grant        GM_xmlhttpRequest
// @grant        GM_download
// @grant        GM_addStyle
// @connect      *
// ==/UserScript==

(function () {
  "use strict";

  const STORAGE_KEY = "mit_submitter_state_v1";
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
    zipName: "manga-translator-results.zip",
    configText: JSON.stringify(DEFAULT_CONFIG, null, 2),
    queue: [],
    resultsCount: 0,
    lastMessage: "",
    collapsed: false,
  };

  let state = loadState();
  let running = false;
  let root;
  let statusTimer;

  function loadState() {
    try {
      return { ...defaultState, ...JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}") };
    } catch (_) {
      return { ...defaultState };
    }
  }

  function saveState() {
    const persisted = {
      ...state,
      queue: state.queue.slice(-300),
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(persisted));
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
    render();
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
    for (const url of urls) {
      if (known.has(url)) continue;
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
    setMessage(`检测到 ${urls.length} 张图，新增 ${added} 张。`);
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

  async function downloadImage(url) {
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
    return new File([blob], fileNameFromUrl(url), { type: blob.type || contentType });
  }

  function fileNameFromUrl(url) {
    try {
      const path = new URL(url).pathname;
      const name = decodeURIComponent(path.split("/").pop() || "");
      if (name && IMAGE_EXTENSIONS.test(name)) return name.replace(/[\\/:*?"<>|]+/g, "-");
    } catch (_) {
      // fall through
    }
    return `manga-${Date.now()}.jpg`;
  }

  function updateQueueItem(id, patch) {
    state.queue = state.queue.map((item) => {
      if (item.id !== id) return item;
      return { ...item, ...patch, updatedAt: Date.now() };
    });
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
    const host = normalizeHost(state.host);
    if (!host) throw new Error("请先填写 manga-image-translator Host。");

    updateQueueItem(item.id, { status: "downloading", message: "下载原图中" });
    const file = await downloadImage(item.url);

    updateQueueItem(item.id, { status: "translating", message: "提交翻译中" });
    const form = new FormData();
    form.append("image", file);
    form.append("config", state.configText || "{}");

    const response = await gmRequest({
      method: "POST",
      url: `${host}/translate/with-form/image/stream/web`,
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
    const host = normalizeHost(state.host);
    if (!host) {
      setMessage("请先填写 Host。");
      return;
    }
    try {
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
    const raw = (state.zipName || "").trim();
    if (!raw) return "manga-translator-results.zip";
    const cleaned = raw.replace(/[\\/:*?"<>|]+/g, "-").replace(/\s+/g, " ").trim();
    const base = cleaned || "manga-translator-results";
    return base.toLowerCase().endsWith(".zip") ? base : `${base}.zip`;
  }

  function downloadZip() {
    const host = normalizeHost(state.host);
    if (!host) {
      setMessage("请先填写 Host。");
      return;
    }
    const url = `${host}/results/download.zip`;
    const headers = authHeader();
    const name = zipDownloadName();
    if (Object.keys(headers).length) {
      GM_download({
        url,
        name,
        headers,
        onerror(error) {
          setMessage(`下载 ZIP 失败: ${error.error || "unknown error"}`);
        },
      });
    } else {
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      document.body.appendChild(link);
      link.click();
      link.remove();
    }
    setMessage(`已请求下载 ${name}`);
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

  function bindInput(selector, key, transform = (value) => value) {
    const el = root.querySelector(selector);
    if (!el) return;
    el.addEventListener("change", () => {
      state[key] = transform(el.type === "checkbox" ? el.checked : el.value);
      saveState();
      render();
    });
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

  function render() {
    if (!root) return;
    const queuePreview = state.queue.slice(0, 12).map((item, index) => `
      <div class="mit-row" title="${escapeHtml(item.url)}">
        <span>${index + 1}</span>
        <span class="mit-status mit-${item.status}">${escapeHtml(item.status)}</span>
        <span>${escapeHtml(item.message || shortUrl(item.url))}</span>
      </div>
    `).join("");
    const more = state.queue.length > 12 ? `<div class="mit-muted">还有 ${state.queue.length - 12} 项未显示</div>` : "";

    root.innerHTML = `
      <div class="mit-card ${state.collapsed ? "mit-collapsed" : ""}">
        <div class="mit-head">
          <strong>MIT Submitter</strong>
          <button data-action="toggle">${state.collapsed ? "展开" : "收起"}</button>
        </div>
        <div class="mit-body">
          <label>Host <input data-field="host" value="${escapeAttr(state.host)}" placeholder="https://your-mit-host"></label>
          <label class="mit-check"><input data-field="useBasicAuth" type="checkbox" ${state.useBasicAuth ? "checked" : ""}> Basic Auth</label>
          <div class="mit-grid">
            <label>User <input data-field="username" value="${escapeAttr(state.username)}"></label>
            <label>Pass <input data-field="password" type="password" value="${escapeAttr(state.password)}"></label>
          </div>
          <label>ZIP name <input data-field="zipName" value="${escapeAttr(state.zipName)}"></label>
          <label>Config JSON <textarea data-field="configText" spellcheck="false">${escapeHtml(state.configText)}</textarea></label>
          <div class="mit-actions">
            <button data-action="detect">抓取图片</button>
            <button data-action="translate" ${running ? "disabled" : ""}>翻译队列</button>
            <button data-action="refresh">刷新状态</button>
            <button data-action="download">下载 ZIP</button>
          </div>
          <div class="mit-actions">
            <button data-action="retry">失败重试</button>
            <button data-action="clearDone">清除完成</button>
            <button data-action="clearQueue">清空队列</button>
          </div>
          <div class="mit-summary">${escapeHtml(statusText())}</div>
          <div class="mit-message">${escapeHtml(state.lastMessage || "")}</div>
          <div class="mit-list">${queuePreview || '<div class="mit-muted">还没有图片。点击“抓取图片”累计当前页图片。</div>'}${more}</div>
        </div>
      </div>
    `;

    button('[data-action="toggle"]', () => {
      state.collapsed = !state.collapsed;
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
    bindInput('[data-field="host"]', "host", normalizeHost);
    bindInput('[data-field="useBasicAuth"]', "useBasicAuth");
    bindInput('[data-field="username"]', "username");
    bindInput('[data-field="password"]', "password");
    bindInput('[data-field="zipName"]', "zipName");
    bindInput('[data-field="configText"]', "configText");
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

  function installStyles() {
    GM_addStyle(`
      #mit-submitter-root {
        position: fixed;
        right: 16px;
        top: 72px;
        z-index: 2147483647;
        width: 360px;
        color: #172026;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        font-size: 13px;
      }
      #mit-submitter-root * {
        box-sizing: border-box;
      }
      #mit-submitter-root .mit-card {
        background: #f8fafc;
        border: 1px solid #b8c2cc;
        border-radius: 8px;
        box-shadow: 0 12px 36px rgba(15, 23, 42, 0.22);
        overflow: hidden;
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
        gap: 8px;
        padding: 10px;
      }
      #mit-submitter-root .mit-collapsed .mit-body {
        display: none;
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
        gap: 6px;
      }
      #mit-submitter-root button {
        border: 1px solid #334155;
        border-radius: 6px;
        padding: 6px 7px;
        background: #334155;
        color: white;
        cursor: pointer;
        font: inherit;
        font-weight: 650;
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
        max-height: 260px;
        overflow: auto;
      }
      #mit-submitter-root .mit-row {
        display: grid;
        grid-template-columns: 24px 82px minmax(0, 1fr);
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
      #mit-submitter-root .mit-downloading {
        background: #dbeafe;
        color: #1d4ed8;
      }
    `);
  }

  function init() {
    installStyles();
    root = document.createElement("div");
    root.id = "mit-submitter-root";
    document.body.appendChild(root);
    render();
    statusTimer = window.setInterval(() => {
      if (!document.body.contains(root)) {
        window.clearInterval(statusTimer);
      }
    }, 30000);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
