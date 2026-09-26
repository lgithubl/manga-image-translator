import hashlib
import mimetypes
import os
import re
import sqlite3
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
DB_PATH = DATA_DIR / "audio-widget.sqlite3"
AUDIO_EXTENSIONS = {".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".webm"}

app = FastAPI(title="Audio Widget Backend", version="0.1.0")
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
    with connect() as db:
        db.execute(
            """
            CREATE TABLE IF NOT EXISTS audio_files (
              id TEXT PRIMARY KEY,
              name TEXT NOT NULL,
              original_name TEXT NOT NULL,
              path TEXT NOT NULL UNIQUE,
              content_type TEXT NOT NULL,
              size INTEGER NOT NULL,
              mtime INTEGER NOT NULL,
              created_at INTEGER NOT NULL,
              updated_at INTEGER NOT NULL
            )
            """
        )
        db.commit()
    reindex_uploads()


def connect() -> sqlite3.Connection:
    db = sqlite3.connect(DB_PATH)
    db.row_factory = sqlite3.Row
    return db


def safe_name(value: str) -> str:
    name = os.path.basename(value or "upload")
    name = re.sub(r'[\\/:*?"<>|]+', "-", name).strip().strip(".")
    return name or "upload"


def is_audio_name(name: str) -> bool:
    return Path(name).suffix.lower() in AUDIO_EXTENSIONS


def unique_path(filename: str) -> Path:
    stem = Path(filename).stem or "audio"
    suffix = Path(filename).suffix
    candidate = UPLOAD_DIR / f"{stem}{suffix}"
    index = 2
    while candidate.exists():
        candidate = UPLOAD_DIR / f"{stem}-{index}{suffix}"
        index += 1
    return candidate


def file_id(path: Path) -> str:
    relative = str(path.relative_to(UPLOAD_DIR))
    return hashlib.sha256(relative.encode("utf-8")).hexdigest()[:20]


def row_to_dict(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "name": row["name"],
        "originalName": row["original_name"],
        "contentType": row["content_type"],
        "size": row["size"],
        "mtime": row["mtime"],
        "streamUrl": f"/api/files/{row['id']}/stream",
    }


def upsert_file(path: Path, original_name: str | None = None) -> dict:
    stat = path.stat()
    content_type = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
    now = int(time.time())
    item = {
        "id": file_id(path),
        "name": path.name,
        "original_name": original_name or path.name,
        "path": str(path),
        "content_type": content_type,
        "size": stat.st_size,
        "mtime": int(stat.st_mtime),
        "created_at": now,
        "updated_at": now,
    }
    with connect() as db:
        previous = db.execute("SELECT created_at FROM audio_files WHERE id = ?", (item["id"],)).fetchone()
        if previous:
            item["created_at"] = previous["created_at"]
        db.execute(
            """
            INSERT INTO audio_files
              (id, name, original_name, path, content_type, size, mtime, created_at, updated_at)
            VALUES
              (:id, :name, :original_name, :path, :content_type, :size, :mtime, :created_at, :updated_at)
            ON CONFLICT(id) DO UPDATE SET
              name = excluded.name,
              original_name = excluded.original_name,
              path = excluded.path,
              content_type = excluded.content_type,
              size = excluded.size,
              mtime = excluded.mtime,
              updated_at = excluded.updated_at
            """,
            item,
        )
        db.commit()
        row = db.execute("SELECT * FROM audio_files WHERE id = ?", (item["id"],)).fetchone()
    return row_to_dict(row)


def reindex_uploads() -> None:
    known_paths: set[str] = set()
    for path in sorted(UPLOAD_DIR.iterdir(), key=lambda item: item.name.lower()):
        if path.is_file() and is_audio_name(path.name):
            known_paths.add(str(path.resolve()))
            upsert_file(path.resolve())
    with connect() as db:
        rows = db.execute("SELECT id, path FROM audio_files").fetchall()
        for row in rows:
            if row["path"] not in known_paths or not Path(row["path"]).exists():
                db.execute("DELETE FROM audio_files WHERE id = ?", (row["id"],))
        db.commit()


def get_file_row(file_id_value: str) -> sqlite3.Row:
    with connect() as db:
        row = db.execute("SELECT * FROM audio_files WHERE id = ?", (file_id_value,)).fetchone()
    if not row:
        raise HTTPException(status_code=404, detail="audio file not found")
    path = Path(row["path"]).resolve()
    if UPLOAD_DIR not in path.parents or not path.exists() or not path.is_file():
        raise HTTPException(status_code=404, detail="audio file not found")
    return row


def parse_range(range_header: str | None, total: int) -> tuple[int, int, int]:
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
    with path.open("rb") as file_obj:
        file_obj.seek(start)
        remaining = end - start + 1
        while remaining > 0:
            chunk = file_obj.read(min(1024 * 1024, remaining))
            if not chunk:
                break
            yield chunk
            remaining -= len(chunk)


@app.on_event("startup")
def on_startup() -> None:
    init_storage()


@app.get("/health")
def health():
    return {"ok": True, "dataDir": str(DATA_DIR)}


@app.get("/api/config")
def config():
    return {
        "apiVersion": "0.1.0",
        "audioExtensions": sorted(AUDIO_EXTENSIONS),
        "endpoints": {
            "files": "/api/files",
            "upload": "/api/upload",
            "stream": "/api/files/{id}/stream",
        },
    }


@app.get("/api/files")
def list_files():
    reindex_uploads()
    with connect() as db:
        rows = db.execute("SELECT * FROM audio_files ORDER BY updated_at DESC, name ASC").fetchall()
    return {"files": [row_to_dict(row) for row in rows]}


@app.get("/api/files/{file_id_value}")
def get_file(file_id_value: str):
    return row_to_dict(get_file_row(file_id_value))


@app.post("/api/upload")
async def upload_file(file: Annotated[UploadFile, File(...)]):
    filename = safe_name(file.filename or "upload")
    if not is_audio_name(filename):
        raise HTTPException(status_code=400, detail="unsupported audio extension")
    target = unique_path(filename)
    with target.open("wb") as output:
        while True:
            chunk = await file.read(1024 * 1024)
            if not chunk:
                break
            output.write(chunk)
    return upsert_file(target.resolve(), original_name=filename)


@app.post("/upload")
async def upload_file_compat(file: Annotated[UploadFile, File(...)]):
    return await upload_file(file)


@app.api_route("/api/files/{file_id_value}/stream", methods=["GET", "HEAD"])
def stream_file(file_id_value: str, range_header: Annotated[str | None, Header(alias="Range")] = None):
    row = get_file_row(file_id_value)
    path = Path(row["path"]).resolve()
    total = path.stat().st_size
    status, start, end = parse_range(range_header, total)
    headers = {
        "Accept-Ranges": "bytes",
        "Content-Length": str(end - start + 1),
    }
    if status == 206:
        headers["Content-Range"] = f"bytes {start}-{end}/{total}"
    return StreamingResponse(
        iter_file_range(path, start, end),
        status_code=status,
        media_type=row["content_type"],
        headers=headers,
    )


@app.api_route("/files/{file_id_value}/stream", methods=["GET", "HEAD"])
def stream_file_compat(file_id_value: str, range_header: Annotated[str | None, Header(alias="Range")] = None):
    return stream_file(file_id_value, range_header)


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
