(function () {
  "use strict";

  const AUDIO_EXTENSIONS = /\.(mp3|wav|m4a|aac|flac|ogg|opus|webm)$/i;

  function formatBytes(value) {
    const size = Number(value || 0);
    if (size < 1024) return `${size} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let scaled = size / 1024;
    let index = 0;
    while (scaled >= 1024 && index < units.length - 1) {
      scaled /= 1024;
      index += 1;
    }
    return `${scaled.toFixed(scaled >= 10 ? 1 : 2)} ${units[index]}`;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#039;");
  }

  function joinUrl(base, path) {
    return `${String(base || "").replace(/\/+$/, "")}${path}`;
  }

  async function requestJson(url, options) {
    const response = await fetch(url, options);
    if (!response.ok) {
      const text = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status}: ${text || response.statusText}`);
    }
    return response.json();
  }

  function createWidget(target, options = {}) {
    const root = typeof target === "string" ? document.querySelector(target) : target;
    if (!root) throw new Error("AudioWidget target not found");

    const config = {
      apiBase: options.apiBase || location.origin,
      uploadEnabled: options.uploadEnabled !== false,
    };
    const state = {
      files: [],
      selected: null,
      busy: false,
      message: "",
    };

    function streamUrl(file) {
      return joinUrl(config.apiBase, `/api/files/${encodeURIComponent(file.id)}/stream`);
    }

    function render() {
      const selected = state.selected;
      root.innerHTML = `
        <div class="aw-root">
          <div class="aw-toolbar">
            <input type="file" data-aw-file accept="audio/*" ${config.uploadEnabled ? "" : "disabled"}>
            <button class="aw-button" data-aw-upload ${state.busy || !config.uploadEnabled ? "disabled" : ""}>Upload</button>
            <button class="aw-button" data-aw-refresh ${state.busy ? "disabled" : ""}>Refresh</button>
          </div>
          <div class="aw-message">${escapeHtml(state.message)}</div>
          ${selected ? `
            <section class="aw-player">
              <strong>${escapeHtml(selected.name)}</strong>
              <audio controls preload="metadata" src="${escapeHtml(streamUrl(selected))}"></audio>
            </section>
          ` : ""}
          <section class="aw-list">
            ${state.files.map((file) => `
              <div class="aw-row">
                <span class="aw-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</span>
                <span class="aw-meta">${escapeHtml(formatBytes(file.size))}</span>
                <button class="aw-button" data-aw-play="${escapeHtml(file.name)}">Play</button>
              </div>
            `).join("") || '<div class="aw-message">No audio files yet.</div>'}
          </section>
        </div>
      `;

      root.querySelector("[data-aw-refresh]")?.addEventListener("click", refresh);
      root.querySelector("[data-aw-upload]")?.addEventListener("click", upload);
      root.querySelectorAll("[data-aw-play]").forEach((button) => {
        button.addEventListener("click", () => {
          state.selected = state.files.find((file) => file.name === button.dataset.awPlay) || null;
          render();
        });
      });
    }

    async function refresh() {
      state.busy = true;
      state.message = "Loading files...";
      render();
      try {
        const data = await requestJson(joinUrl(config.apiBase, "/api/files"));
        state.files = (data.files || []).filter((file) => AUDIO_EXTENSIONS.test(file.name || ""));
        if (state.selected && !state.files.some((file) => file.name === state.selected.name)) {
          state.selected = null;
        }
        state.message = `Loaded ${state.files.length} audio file(s).`;
      } catch (error) {
        state.message = error.message || String(error);
      } finally {
        state.busy = false;
        render();
      }
    }

    async function upload() {
      const input = root.querySelector("[data-aw-file]");
      const file = input?.files?.[0];
      if (!file) {
        state.message = "Choose an audio file first.";
        render();
        return;
      }
      state.busy = true;
      state.message = `Uploading ${file.name}...`;
      render();
      try {
        const form = new FormData();
        form.append("file", file);
        await requestJson(joinUrl(config.apiBase, "/api/upload"), {
          method: "POST",
          body: form,
        });
        state.message = `Uploaded ${file.name}.`;
        await refresh();
      } catch (error) {
        state.message = error.message || String(error);
      } finally {
        state.busy = false;
        render();
      }
    }

    render();
    refresh();
    return { refresh, upload };
  }

  window.AudioWidget = {
    mount: createWidget,
  };
})();
