# Audio Widget

Embeddable audio frontend plus a deployable Rust streaming backend.

The frontend uses native `<audio>` playback. Large files are streamed by URL; the
server supports byte ranges so MP3/WAV files can seek without downloading the
whole file. The same backend stream API also supports common video containers;
an embedding site can use the returned stream URL in a native `<video>` element.

## Local

```bash
cd audio-widget
cargo run
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

Useful runtime tuning variables:

- `AUDIO_WIDGET_INITIAL_CHUNK_BYTES`: first response chunk size. Defaults to
  `262144` bytes so slow disks can start playback sooner.
- `AUDIO_WIDGET_READ_CHUNK_BYTES`: later stream chunk size. Defaults to
  `1048576` bytes and is clamped between 64KB and 16MB.
- `AUDIO_WIDGET_PREFETCH_BYTES`: bytes to read ahead after the requested range.
  Defaults to `0`, which disables prefetch.
- `AUDIO_WIDGET_PREFETCH_MAX_TASKS`: max concurrent background prefetch tasks.
  Defaults to `2`.

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

Supported media extensions include `mp3`, `wav`, `flac`, `m4a`, `aac`, `ogg`,
`opus`, `webm`, `mp4`, `m4v`, `mov`, and `mkv`.

Demo uploads are still available and are stored under `/data/uploads`, but they
are not the production data model.

For faster first playback, keep `AUDIO_WIDGET_INITIAL_CHUNK_BYTES` modest,
enable a small prefetch window such as 8MB or 16MB for slow NAS disks, and make
sure MP4 files are written in faststart form so their metadata is near the front
of the file.
