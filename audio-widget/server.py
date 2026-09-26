import base64
import mimetypes
import os
import re
import time
from pathlib import Path
from typing import Annotated

from fastapi import FastAPI, File, Header, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, HTMLResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles


ROOT = Path(__file__).resolve().parent
PUBLIC_DIR = ROOT / "public"
DATA_DIR = Path(os.environ.get("AUDIO_WIDGET_DATA_DIR", ROOT / "data")).resolve()
UPLOAD_DIR = (DATA_DIR / "uploads").resolve()
AUDIO_EXTENSIONS = {".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".webm"}

app = FastAPI(title="Audio Widget Backend", version="0.2.0")
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


def init_storage() -> None:
    UPLOAD_DIR.mkdir(parents=True, exist_ok=True)
    DATA_DIR.mkdir(parents=True, exist_ok=True)


def safe_name(value: str) -> str:
    name = os.path.basename(value or "upload")
    name = re.sub(r'[\\/:*?"<>|]+', "-", name).strip().strip(".")
    return name or "upload"


def is_audio_name(name: str) -> bool:
    return Path(name).suffix.lower() in AUDIO_EXTENSIONS


def encode_path(path: str) -> str:
    return base64.urlsafe_b64encode(path.encode("utf-8")).decode("ascii").rstrip("=")


def decode_path(value: str) -> Path:
    try:
        padded = value + ("=" * (-len(value) % 4))
        decoded = base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8")
    except Exception as exc:
        raise HTTPException(status_code=400, detail="invalid encoded path") from exc
    if not decoded:
        raise HTTPException(status_code=400, detail="empty path")
    return Path(decoded).expanduser().resolve()


def file_meta(path: Path) -> dict:
    stat = path.stat()
    content_type = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
    return {
        "id": encode_path(str(path)),
        "path": str(path),
        "name": path.name,
        "contentType": content_type,
        "size": stat.st_size,
        "mtime": int(stat.st_mtime),
        "streamUrl": f"/api/stream/{encode_path(str(path))}",
    }


def unique_upload_path(filename: str) -> Path:
    stem = Path(filename).stem or "audio"
    suffix = Path(filename).suffix
    candidate = UPLOAD_DIR / f"{stem}{suffix}"
    index = 2
    while candidate.exists():
        candidate = UPLOAD_DIR / f"{stem}-{index}{suffix}"
        index += 1
    return candidate


def ensure_streamable_path(path: Path) -> Path:
    if not path.exists() or not path.is_file():
        raise HTTPException(status_code=404, detail="audio file not found")
    if not is_audio_name(path.name):
        raise HTTPException(status_code=400, detail="unsupported audio extension")
    return path


def parse_range(range_header: str | None, total: int) -> tuple[int, int, int]:
    if total <= 0:
        return 200, 0, -1
    if not range_header:
        return 200, 0, total - 1
    match = re.fullmatch(r"bytes=(\d*)-(\d*)", range_header.strip())
    if not match:
        raise HTTPException(status_code=416, detail="invalid range")
    raw_start, raw_end = match.groups()
    if raw_start:
        start = int(raw_start)
        end = int(raw_end) if raw_end else total - 1
    else:
        length = int(raw_end or 0)
        start = max(0, total - length)
        end = total - 1
    if start >= total or end < start:
        raise HTTPException(
            status_code=416,
            detail="range not satisfiable",
            headers={"Content-Range": f"bytes */{total}"},
        )
    return 206, start, min(end, total - 1)


def iter_file_range(path: Path, start: int, end: int):
    if end < start:
        return
    with path.open("rb") as file_obj:
        file_obj.seek(start)
        remaining = end - start + 1
        while remaining > 0:
            chunk = file_obj.read(min(1024 * 1024, remaining))
            if not chunk:
                break
            yield chunk
            remaining -= len(chunk)


def list_demo_uploads() -> list[dict]:
    files = []
    for path in sorted(UPLOAD_DIR.iterdir(), key=lambda item: item.name.lower()):
        if path.is_file() and is_audio_name(path.name):
            files.append(file_meta(path.resolve()))
    return files


@app.on_event("startup")
def on_startup() -> None:
    init_storage()


@app.get("/health")
def health():
    return {"ok": True, "mode": "path-stream", "dataDir": str(DATA_DIR)}


@app.get("/api/config")
def config():
    return {
        "apiVersion": "0.2.0",
        "mode": "path-stream",
        "audioExtensions": sorted(AUDIO_EXTENSIONS),
        "endpoints": {
            "stream": "/api/stream/{base64urlPath}",
            "meta": "/api/meta/{base64urlPath}",
            "upload": "/api/upload",
            "demoFiles": "/api/files",
        },
    }


@app.get("/api/files")
def list_files():
    return {"files": list_demo_uploads()}


@app.get("/api/meta/{encoded_path:path}")
def meta(encoded_path: str):
    path = ensure_streamable_path(decode_path(encoded_path))
    return file_meta(path)


@app.post("/api/upload")
async def upload_file(file: Annotated[UploadFile, File(...)]):
    filename = safe_name(file.filename or "upload")
    if not is_audio_name(filename):
        raise HTTPException(status_code=400, detail="unsupported audio extension")
    target = unique_upload_path(filename)
    with target.open("wb") as output:
        while True:
            chunk = await file.read(1024 * 1024)
            if not chunk:
                break
            output.write(chunk)
    os.utime(target, None)
    return file_meta(target.resolve())


@app.post("/upload")
async def upload_file_compat(file: Annotated[UploadFile, File(...)]):
    return await upload_file(file)


@app.api_route("/api/stream/{encoded_path:path}", methods=["GET", "HEAD"])
def stream_path(encoded_path: str, range_header: Annotated[str | None, Header(alias="Range")] = None):
    path = ensure_streamable_path(decode_path(encoded_path))
    total = path.stat().st_size
    status, start, end = parse_range(range_header, total)
    content_type = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
    headers = {
        "Accept-Ranges": "bytes",
        "Content-Length": str(max(0, end - start + 1)),
        "Cache-Control": "no-store",
        "X-Audio-Path-Encoded": encode_path(str(path)),
    }
    if status == 206:
        headers["Content-Range"] = f"bytes {start}-{end}/{total}"
    return StreamingResponse(
        iter_file_range(path, start, end),
        status_code=status,
        media_type=content_type,
        headers=headers,
    )


@app.api_route("/files/{encoded_path:path}/stream", methods=["GET", "HEAD"])
def stream_path_compat(encoded_path: str, range_header: Annotated[str | None, Header(alias="Range")] = None):
    return stream_path(encoded_path, range_header)


@app.get("/audio-widget.js")
def widget_js():
    return FileResponse(PUBLIC_DIR / "audio-widget.js", media_type="application/javascript")


@app.get("/audio-widget.css")
def widget_css():
    return FileResponse(PUBLIC_DIR / "audio-widget.css", media_type="text/css")


@app.get("/", response_class=HTMLResponse)
def index():
    return HTMLResponse((PUBLIC_DIR / "index.html").read_text(encoding="utf-8"))


app.mount("/assets", StaticFiles(directory=str(PUBLIC_DIR)), name="assets")
