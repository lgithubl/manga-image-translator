import argparse
from email.parser import BytesParser
from email.policy import default
import json
import mimetypes
import os
import re
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote, urlparse


ROOT = Path(__file__).resolve().parent
PUBLIC_DIR = ROOT / "public"
DEFAULT_DATA_DIR = Path(os.environ.get("AUDIO_WIDGET_DATA_DIR", ROOT / "data"))
AUDIO_EXTENSIONS = {".mp3", ".wav", ".m4a", ".aac", ".flac", ".ogg", ".opus", ".webm"}


def safe_name(value: str) -> str:
    name = os.path.basename(value or "upload")
    name = re.sub(r'[\\/:*?"<>|]+', "-", name).strip().strip(".")
    return name or "upload"


class Handler(SimpleHTTPRequestHandler):
    server_version = "AudioWidgetTest/0.1"

    @property
    def upload_dir(self) -> Path:
        return self.server.upload_dir

    def end_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, HEAD, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Range")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(HTTPStatus.NO_CONTENT)
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        if parsed.path == "/health":
            self.send_json({"ok": True})
            return
        if parsed.path == "/api/files":
            self.send_json({"files": self.list_files()})
            return
        if parsed.path.startswith("/files/") and parsed.path.endswith("/stream"):
            raw_name = parsed.path[len("/files/"):-len("/stream")]
            self.send_audio(unquote(raw_name), head_only=False)
            return
        self.serve_public(parsed.path, head_only=False)

    def do_HEAD(self):
        parsed = urlparse(self.path)
        if parsed.path.startswith("/files/") and parsed.path.endswith("/stream"):
            raw_name = parsed.path[len("/files/"):-len("/stream")]
            self.send_audio(unquote(raw_name), head_only=True)
            return
        self.serve_public(parsed.path, head_only=True)

    def do_POST(self):
        parsed = urlparse(self.path)
        if parsed.path != "/upload":
            self.send_error(HTTPStatus.NOT_FOUND, "Not found")
            return
        field = self.read_multipart_file("file")
        if field is None:
            self.send_error(HTTPStatus.BAD_REQUEST, "multipart field 'file' is required")
            return
        filename, data = field
        suffix = Path(filename).suffix.lower()
        if suffix not in AUDIO_EXTENSIONS:
            self.send_error(HTTPStatus.BAD_REQUEST, "unsupported audio extension")
            return
        target = self.unique_path(filename)
        with target.open("wb") as output:
            output.write(data)
        self.send_json({"name": target.name, "size": target.stat().st_size})

    def read_multipart_file(self, field_name: str) -> tuple[str, bytes] | None:
        content_type = self.headers.get("Content-Type", "")
        length = int(self.headers.get("Content-Length") or 0)
        if not content_type.startswith("multipart/form-data") or length <= 0:
            return None
        body = self.rfile.read(length)
        raw_message = (
            f"Content-Type: {content_type}\r\n"
            "MIME-Version: 1.0\r\n\r\n"
        ).encode("utf-8") + body
        message = BytesParser(policy=default).parsebytes(raw_message)
        if not message.is_multipart():
            return None
        for part in message.iter_parts():
            disposition = part.get_content_disposition()
            name = part.get_param("name", header="content-disposition")
            filename = part.get_filename()
            if disposition == "form-data" and name == field_name and filename:
                return safe_name(filename), part.get_payload(decode=True) or b""
        return None

    def translate_path(self, path):
        rel = path.lstrip("/") or "index.html"
        candidate = (PUBLIC_DIR / rel).resolve()
        if PUBLIC_DIR not in candidate.parents and candidate != PUBLIC_DIR:
            return str(PUBLIC_DIR / "index.html")
        if candidate.is_dir():
            candidate = candidate / "index.html"
        if not candidate.exists():
            candidate = PUBLIC_DIR / "index.html"
        return str(candidate)

    def serve_public(self, path: str, head_only: bool):
        file_path = Path(self.translate_path(path))
        ctype = mimetypes.guess_type(str(file_path))[0] or "application/octet-stream"
        try:
            with file_path.open("rb") as file_obj:
                data = file_obj.read()
        except OSError:
            self.send_error(HTTPStatus.NOT_FOUND, "Not found")
            return
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        if not head_only:
            self.wfile.write(data)

    def list_files(self):
        files = []
        for path in sorted(self.upload_dir.iterdir(), key=lambda item: item.name.lower()):
            if path.is_file() and path.suffix.lower() in AUDIO_EXTENSIONS:
                stat = path.stat()
                files.append({
                    "name": path.name,
                    "size": stat.st_size,
                    "mtime": int(stat.st_mtime),
                })
        return files

    def unique_path(self, filename: str) -> Path:
        stem = Path(filename).stem or "audio"
        suffix = Path(filename).suffix
        candidate = self.upload_dir / f"{stem}{suffix}"
        index = 2
        while candidate.exists():
            candidate = self.upload_dir / f"{stem}-{index}{suffix}"
            index += 1
        return candidate

    def send_json(self, payload, status=HTTPStatus.OK):
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def send_audio(self, name: str, head_only: bool):
        path = (self.upload_dir / safe_name(name)).resolve()
        if self.upload_dir not in path.parents or not path.exists() or not path.is_file():
            self.send_error(HTTPStatus.NOT_FOUND, "Not found")
            return
        total = path.stat().st_size
        content_type = mimetypes.guess_type(str(path))[0] or "application/octet-stream"
        start = 0
        end = total - 1
        range_header = self.headers.get("Range")
        status = HTTPStatus.OK
        if range_header:
            match = re.fullmatch(r"bytes=(\d*)-(\d*)", range_header.strip())
            if not match:
                self.send_error(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE, "Invalid range")
                return
            raw_start, raw_end = match.groups()
            if raw_start:
                start = int(raw_start)
                end = int(raw_end) if raw_end else total - 1
            else:
                length = int(raw_end or 0)
                start = max(0, total - length)
                end = total - 1
            if start >= total or end < start:
                self.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
                self.send_header("Content-Range", f"bytes */{total}")
                self.end_headers()
                return
            end = min(end, total - 1)
            status = HTTPStatus.PARTIAL_CONTENT

        length = end - start + 1
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Accept-Ranges", "bytes")
        self.send_header("Content-Length", str(length))
        if status == HTTPStatus.PARTIAL_CONTENT:
            self.send_header("Content-Range", f"bytes {start}-{end}/{total}")
        self.end_headers()
        if head_only:
            return
        with path.open("rb") as file_obj:
            file_obj.seek(start)
            remaining = length
            while remaining > 0:
                chunk = file_obj.read(min(1024 * 1024, remaining))
                if not chunk:
                    break
                self.wfile.write(chunk)
                remaining -= len(chunk)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default=os.environ.get("AUDIO_WIDGET_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("AUDIO_WIDGET_PORT", "8080")))
    parser.add_argument("--data-dir", default=str(DEFAULT_DATA_DIR))
    args = parser.parse_args()

    upload_dir = (Path(args.data_dir) / "uploads").resolve()
    upload_dir.mkdir(parents=True, exist_ok=True)

    httpd = ThreadingHTTPServer((args.host, args.port), Handler)
    httpd.upload_dir = upload_dir
    print(f"Audio widget test server listening on http://{args.host}:{args.port}")
    print(f"Upload dir: {upload_dir}")
    httpd.serve_forever()


if __name__ == "__main__":
    main()
