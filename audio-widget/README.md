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
    uploadEnabled: true
  });
</script>
```

External sites can host `audio-widget.js` and `audio-widget.css` themselves, or
load them from this backend. Only `apiBase` has to point at the deployed backend.

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
- `GET /api/files`
- `GET /api/files/{id}`
- `POST /api/upload` with multipart field `file`
- `GET /api/files/{id}/stream` with HTTP Range support

The included backend is a deployable baseline service: it keeps a SQLite file
index, stores uploaded audio under `/data/uploads`, and streams files with HTTP
Range support. Production installations should still put auth, quotas, backups,
and external object storage in front when needed.
