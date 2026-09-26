# Audio Widget

Small embeddable audio frontend plus a test-only HTTP server.

The frontend uses native `<audio>` playback. Large files are streamed by URL; the
server supports byte ranges so MP3/WAV files can seek without downloading the
whole file.

## Local

```bash
python audio-widget/server.py
```

Open `http://127.0.0.1:8080`.

## Embed

```html
<link rel="stylesheet" href="/audio-widget.css">
<div id="audio-widget"></div>
<script src="/audio-widget.js"></script>
<script>
  AudioWidget.mount("#audio-widget", {
    apiBase: "http://127.0.0.1:8080",
    uploadEnabled: true
  });
</script>
```

## Test API

- `GET /health`
- `GET /api/files`
- `POST /upload` with multipart field `file`
- `GET /files/{name}/stream` with HTTP Range support

This server is intentionally small and only meant for demos/tests. Production
sites should provide their own storage, auth, indexing, and static file service.
