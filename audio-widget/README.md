# Audio Widget

Embeddable audio frontend plus a deployable baseline backend.

The frontend uses native `<audio>` playback. Large files are streamed by URL; the
server supports byte ranges so MP3/WAV files can seek without downloading the
whole file.

## Local

```bash
cd audio-widget
python -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
uvicorn server:app --host 127.0.0.1 --port 8080
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
  tracks: [
    { name: "example.mp3", path: "/absolute/path/to/example.mp3" }
  ],
  uploadEnabled: true
});
</script>
```

External sites can host `audio-widget.js` and `audio-widget.css` themselves, or
load them from this backend. Only `apiBase` has to point at the deployed backend.
If the upper layer already encoded the path, pass it as `id` instead of `path`.

## Docker

```bash
docker run --rm -p 8080:8080 -v "$PWD/audio-data:/data" audio-widget
```

The GitHub workflow publishes:

```text
ghcr.io/lgithubl/manga-image-translator:audio-widget-latest
```

## API

- `GET /health`
- `GET /api/stream/{base64urlPath}`
- `GET /api/meta/{base64urlPath}`
- `POST /api/upload` with multipart field `file`
- `GET /api/files` for demo uploads

The included backend is a stateless streaming service. The upper layer owns
security, indexes, permissions, and metadata. The backend accepts a base64url
encoded absolute file path and streams that file with HTTP Range support.

Demo uploads are still available and are stored under `/data/uploads`, but they
are not the production data model.
