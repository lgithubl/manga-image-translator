use std::collections::HashSet;
use std::env;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

use anyhow::{Context, Result};
use axum::body::Body;
use axum::extract::{Multipart, Path as AxumPath, State};
use axum::http::header::{
    ACCEPT_RANGES, CACHE_CONTROL, CONTENT_LENGTH, CONTENT_RANGE, CONTENT_TYPE, HeaderMap,
    HeaderValue, RANGE,
};
use axum::http::{Method, StatusCode};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use base64::Engine;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use bytes::Bytes;
use futures_util::{TryStreamExt, stream};
use serde::Serialize;
use tokio::fs::{self, File};
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt, SeekFrom};
use tokio::sync::{Mutex, Semaphore};
use tower_http::cors::{Any, CorsLayer};
use tower_http::services::{ServeDir, ServeFile};

const MEDIA_EXTENSIONS: &[&str] = &[
    "aac", "flac", "m4a", "mp3", "ogg", "opus", "wav", "webm", "m4v", "mkv", "mov", "mp4",
];
const DEFAULT_INITIAL_CHUNK_BYTES: usize = 256 * 1024;
const DEFAULT_READ_CHUNK_BYTES: usize = 1024 * 1024;
const MIN_INITIAL_CHUNK_BYTES: usize = 16 * 1024;
const MIN_READ_CHUNK_BYTES: usize = 64 * 1024;
const MAX_READ_CHUNK_BYTES: usize = 16 * 1024 * 1024;
const DEFAULT_PREFETCH_MAX_TASKS: usize = 2;
const MAX_PREFETCH_BYTES: u64 = 512 * 1024 * 1024;
const SLOW_FIRST_CHUNK_US: u64 = 500_000;
const SLOW_STREAM_US: u64 = 5_000_000;

#[derive(Clone)]
struct AppState {
    data_dir: Arc<PathBuf>,
    upload_dir: Arc<PathBuf>,
    stats: Arc<Stats>,
    initial_chunk_bytes: usize,
    read_chunk_bytes: usize,
    prefetch_bytes: u64,
    prefetch_max_tasks: usize,
    prefetch_semaphore: Arc<Semaphore>,
    prefetch_paths: Arc<Mutex<HashSet<String>>>,
}

#[derive(Default)]
struct Stats {
    started_at_unix: AtomicU64,
    stream_requests: AtomicU64,
    stream_active: AtomicU64,
    stream_active_max: AtomicU64,
    stream_head_requests: AtomicU64,
    stream_range_requests: AtomicU64,
    stream_full_requests: AtomicU64,
    stream_status_200: AtomicU64,
    stream_status_206: AtomicU64,
    stream_status_4xx: AtomicU64,
    stream_status_5xx: AtomicU64,
    stream_requested_bytes: AtomicU64,
    stream_errors: AtomicU64,
    stream_canceled: AtomicU64,
    stream_completed: AtomicU64,
    stream_bytes: AtomicU64,
    stream_chunks: AtomicU64,
    stream_read_us_total: AtomicU64,
    stream_duration_us_total: AtomicU64,
    stream_first_chunk_us_total: AtomicU64,
    stream_open_us_total: AtomicU64,
    stream_seek_us_total: AtomicU64,
    stream_setup_us_total: AtomicU64,
    stream_first_chunk_us_max: AtomicU64,
    stream_read_us_max: AtomicU64,
    stream_duration_us_max: AtomicU64,
    stream_open_us_max: AtomicU64,
    stream_seek_us_max: AtomicU64,
    stream_setup_us_max: AtomicU64,
    stream_slow_first_chunk: AtomicU64,
    stream_slow_completed: AtomicU64,
    upload_requests: AtomicU64,
    upload_bytes: AtomicU64,
    meta_requests: AtomicU64,
    file_list_requests: AtomicU64,
    prefetch_scheduled: AtomicU64,
    prefetch_skipped_disabled: AtomicU64,
    prefetch_skipped_eof: AtomicU64,
    prefetch_skipped_duplicate: AtomicU64,
    prefetch_skipped_busy: AtomicU64,
    prefetch_active: AtomicU64,
    prefetch_completed: AtomicU64,
    prefetch_errors: AtomicU64,
    prefetch_bytes: AtomicU64,
    prefetch_read_us_total: AtomicU64,
}

impl Stats {
    fn new() -> Self {
        let stats = Self::default();
        stats.reset();
        stats
    }

    fn reset(&self) {
        self.started_at_unix.store(now_unix(), Ordering::Relaxed);
        self.stream_requests.store(0, Ordering::Relaxed);
        self.stream_active.store(0, Ordering::Relaxed);
        self.stream_active_max.store(0, Ordering::Relaxed);
        self.stream_head_requests.store(0, Ordering::Relaxed);
        self.stream_range_requests.store(0, Ordering::Relaxed);
        self.stream_full_requests.store(0, Ordering::Relaxed);
        self.stream_status_200.store(0, Ordering::Relaxed);
        self.stream_status_206.store(0, Ordering::Relaxed);
        self.stream_status_4xx.store(0, Ordering::Relaxed);
        self.stream_status_5xx.store(0, Ordering::Relaxed);
        self.stream_requested_bytes.store(0, Ordering::Relaxed);
        self.stream_errors.store(0, Ordering::Relaxed);
        self.stream_canceled.store(0, Ordering::Relaxed);
        self.stream_completed.store(0, Ordering::Relaxed);
        self.stream_bytes.store(0, Ordering::Relaxed);
        self.stream_chunks.store(0, Ordering::Relaxed);
        self.stream_read_us_total.store(0, Ordering::Relaxed);
        self.stream_duration_us_total.store(0, Ordering::Relaxed);
        self.stream_first_chunk_us_total.store(0, Ordering::Relaxed);
        self.stream_open_us_total.store(0, Ordering::Relaxed);
        self.stream_seek_us_total.store(0, Ordering::Relaxed);
        self.stream_setup_us_total.store(0, Ordering::Relaxed);
        self.stream_first_chunk_us_max.store(0, Ordering::Relaxed);
        self.stream_read_us_max.store(0, Ordering::Relaxed);
        self.stream_duration_us_max.store(0, Ordering::Relaxed);
        self.stream_open_us_max.store(0, Ordering::Relaxed);
        self.stream_seek_us_max.store(0, Ordering::Relaxed);
        self.stream_setup_us_max.store(0, Ordering::Relaxed);
        self.stream_slow_first_chunk.store(0, Ordering::Relaxed);
        self.stream_slow_completed.store(0, Ordering::Relaxed);
        self.upload_requests.store(0, Ordering::Relaxed);
        self.upload_bytes.store(0, Ordering::Relaxed);
        self.meta_requests.store(0, Ordering::Relaxed);
        self.file_list_requests.store(0, Ordering::Relaxed);
        self.prefetch_scheduled.store(0, Ordering::Relaxed);
        self.prefetch_skipped_disabled.store(0, Ordering::Relaxed);
        self.prefetch_skipped_eof.store(0, Ordering::Relaxed);
        self.prefetch_skipped_duplicate.store(0, Ordering::Relaxed);
        self.prefetch_skipped_busy.store(0, Ordering::Relaxed);
        self.prefetch_active.store(0, Ordering::Relaxed);
        self.prefetch_completed.store(0, Ordering::Relaxed);
        self.prefetch_errors.store(0, Ordering::Relaxed);
        self.prefetch_bytes.store(0, Ordering::Relaxed);
        self.prefetch_read_us_total.store(0, Ordering::Relaxed);
    }
}

struct StreamGuard {
    stats: Arc<Stats>,
    request_started: Instant,
    done: AtomicBool,
}

impl StreamGuard {
    fn new(stats: Arc<Stats>, request_started: Instant) -> Self {
        Self {
            stats,
            request_started,
            done: AtomicBool::new(false),
        }
    }

    fn finish(&self) {
        if self
            .done
            .compare_exchange(false, true, Ordering::Relaxed, Ordering::Relaxed)
            .is_ok()
        {
            complete_stream(&self.stats, self.request_started);
        }
    }
}

impl Drop for StreamGuard {
    fn drop(&mut self) {
        if !self.done.load(Ordering::Relaxed) {
            self.stats.stream_canceled.fetch_add(1, Ordering::Relaxed);
            self.stats.stream_active.fetch_sub(1, Ordering::Relaxed);
        }
    }
}

#[derive(Serialize)]
struct MediaMeta {
    id: String,
    path: String,
    name: String,
    #[serde(rename = "contentType")]
    content_type: String,
    size: u64,
    mtime: u64,
    #[serde(rename = "streamUrl")]
    stream_url: String,
}

#[derive(Debug)]
struct AppError {
    status: StatusCode,
    detail: String,
    headers: HeaderMap,
}

impl AppError {
    fn new(status: StatusCode, detail: impl Into<String>) -> Self {
        Self {
            status,
            detail: detail.into(),
            headers: HeaderMap::new(),
        }
    }

    fn with_header(mut self, name: axum::http::header::HeaderName, value: String) -> Self {
        if let Ok(value) = HeaderValue::from_str(&value) {
            self.headers.insert(name, value);
        }
        self
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> Response {
        let mut response = (
            self.status,
            Json(serde_json::json!({ "detail": self.detail })),
        )
            .into_response();
        response.headers_mut().extend(self.headers);
        response
    }
}

#[tokio::main]
async fn main() -> Result<()> {
    let root = env::current_dir().context("resolve current directory")?;
    let public_dir = root.join("public");
    let data_dir = env::var("AUDIO_WIDGET_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| root.join("data"));
    let upload_dir = data_dir.join("uploads");
    let read_chunk_bytes = env_usize(
        "AUDIO_WIDGET_READ_CHUNK_BYTES",
        DEFAULT_READ_CHUNK_BYTES,
        MIN_READ_CHUNK_BYTES,
        MAX_READ_CHUNK_BYTES,
    );
    let initial_chunk_bytes = env_usize(
        "AUDIO_WIDGET_INITIAL_CHUNK_BYTES",
        DEFAULT_INITIAL_CHUNK_BYTES,
        MIN_INITIAL_CHUNK_BYTES,
        read_chunk_bytes,
    );
    let prefetch_max_tasks = env_usize(
        "AUDIO_WIDGET_PREFETCH_MAX_TASKS",
        DEFAULT_PREFETCH_MAX_TASKS,
        1,
        64,
    );

    fs::create_dir_all(&upload_dir)
        .await
        .context("create upload dir")?;

    let state = AppState {
        data_dir: Arc::new(data_dir),
        upload_dir: Arc::new(upload_dir),
        stats: Arc::new(Stats::new()),
        initial_chunk_bytes,
        read_chunk_bytes,
        prefetch_bytes: env_u64("AUDIO_WIDGET_PREFETCH_BYTES", 0, 0, MAX_PREFETCH_BYTES),
        prefetch_max_tasks,
        prefetch_semaphore: Arc::new(Semaphore::new(prefetch_max_tasks)),
        prefetch_paths: Arc::new(Mutex::new(HashSet::new())),
    };

    let app = Router::new()
        .route("/health", get(health))
        .route("/api/config", get(config))
        .route("/api/stats", get(stats))
        .route("/api/stats/reset", post(reset_stats))
        .route("/api/files", get(list_files))
        .route("/api/meta/{encoded_path}", get(meta))
        .route("/api/upload", post(upload_file))
        .route("/upload", post(upload_file))
        .route(
            "/api/stream/{encoded_path}",
            get(stream_path).head(stream_path),
        )
        .route(
            "/files/{encoded_path}/stream",
            get(stream_path).head(stream_path),
        )
        .route_service(
            "/audio-widget.js",
            ServeFile::new(public_dir.join("audio-widget.js")),
        )
        .route_service(
            "/audio-widget.css",
            ServeFile::new(public_dir.join("audio-widget.css")),
        )
        .nest_service("/assets", ServeDir::new(&public_dir))
        .route("/", get(index))
        .layer(
            CorsLayer::new()
                .allow_origin(Any)
                .allow_methods(Any)
                .allow_headers(Any),
        )
        .with_state(state);

    let host = env::var("AUDIO_WIDGET_HOST").unwrap_or_else(|_| "0.0.0.0".to_string());
    let port = env::var("AUDIO_WIDGET_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(8080);
    let addr: SocketAddr = format!("{host}:{port}")
        .parse()
        .context("parse bind address")?;
    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .context("bind server")?;
    axum::serve(listener, app).await.context("serve app")?;
    Ok(())
}

async fn health(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "ok": true,
        "mode": "path-stream",
        "runtime": "rust",
        "dataDir": state.data_dir.to_string_lossy(),
        "initialChunkBytes": state.initial_chunk_bytes,
        "readChunkBytes": state.read_chunk_bytes,
        "prefetchBytes": state.prefetch_bytes,
        "prefetchMaxTasks": state.prefetch_max_tasks,
    }))
}

async fn config(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(serde_json::json!({
        "apiVersion": "0.3.0",
        "mode": "path-stream",
        "runtime": "rust",
        "initialChunkBytes": state.initial_chunk_bytes,
        "readChunkBytes": state.read_chunk_bytes,
        "prefetchBytes": state.prefetch_bytes,
        "prefetchMaxTasks": state.prefetch_max_tasks,
        "mediaExtensions": MEDIA_EXTENSIONS,
        "audioExtensions": ["aac", "flac", "m4a", "mp3", "ogg", "opus", "wav", "webm"],
        "videoExtensions": ["m4v", "mkv", "mov", "mp4", "webm"],
        "endpoints": {
            "stream": "/api/stream/{base64urlPath}",
            "meta": "/api/meta/{base64urlPath}",
            "stats": "/api/stats",
            "resetStats": "/api/stats/reset",
            "upload": "/api/upload",
            "demoFiles": "/api/files"
        }
    }))
}

async fn stats(State(state): State<AppState>) -> Json<serde_json::Value> {
    Json(stats_snapshot(&state))
}

async fn reset_stats(State(state): State<AppState>) -> Json<serde_json::Value> {
    state.stats.reset();
    Json(stats_snapshot(&state))
}

async fn index() -> Result<Html<String>, AppError> {
    let body = fs::read_to_string("public/index.html")
        .await
        .map_err(|_| AppError::new(StatusCode::NOT_FOUND, "index not found"))?;
    Ok(Html(body))
}

async fn list_files(State(state): State<AppState>) -> Result<Json<serde_json::Value>, AppError> {
    state
        .stats
        .file_list_requests
        .fetch_add(1, Ordering::Relaxed);
    let mut files = Vec::new();
    let mut entries = fs::read_dir(&*state.upload_dir)
        .await
        .map_err(|_| AppError::new(StatusCode::NOT_FOUND, "upload dir not found"))?;
    while let Some(entry) = entries.next_entry().await.map_err(|_| {
        AppError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "failed to read upload dir",
        )
    })? {
        let path = entry.path();
        if path.is_file() && is_media_name(&path) {
            if let Ok(meta) = file_meta(path).await {
                files.push(meta);
            }
        }
    }
    files.sort_by(|a, b| a.name.to_lowercase().cmp(&b.name.to_lowercase()));
    Ok(Json(serde_json::json!({ "files": files })))
}

async fn meta(
    State(state): State<AppState>,
    AxumPath(encoded_path): AxumPath<String>,
) -> Result<Json<MediaMeta>, AppError> {
    state.stats.meta_requests.fetch_add(1, Ordering::Relaxed);
    let path = ensure_streamable_path(&encoded_path).await?;
    Ok(Json(file_meta(path).await?))
}

async fn upload_file(
    State(state): State<AppState>,
    mut multipart: Multipart,
) -> Result<Json<MediaMeta>, AppError> {
    state.stats.upload_requests.fetch_add(1, Ordering::Relaxed);
    while let Some(field) = multipart
        .next_field()
        .await
        .map_err(|_| AppError::new(StatusCode::BAD_REQUEST, "invalid multipart body"))?
    {
        if field.name() != Some("file") {
            continue;
        }
        let filename = safe_name(field.file_name().unwrap_or("upload"));
        if !is_media_name(Path::new(&filename)) {
            return Err(AppError::new(
                StatusCode::BAD_REQUEST,
                "unsupported media extension",
            ));
        }
        let target = unique_upload_path(&state.upload_dir, &filename).await?;
        let mut output = File::create(&target).await.map_err(|_| {
            AppError::new(StatusCode::INTERNAL_SERVER_ERROR, "failed to create upload")
        })?;
        let mut stream = field.into_stream();
        while let Some(chunk) = stream
            .try_next()
            .await
            .map_err(|_| AppError::new(StatusCode::BAD_REQUEST, "failed to read upload"))?
        {
            state
                .stats
                .upload_bytes
                .fetch_add(chunk.len() as u64, Ordering::Relaxed);
            output.write_all(&chunk).await.map_err(|_| {
                AppError::new(StatusCode::INTERNAL_SERVER_ERROR, "failed to write upload")
            })?;
        }
        let canonical = target.canonicalize().map_err(|_| {
            AppError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "failed to resolve upload",
            )
        })?;
        return Ok(Json(file_meta(canonical).await?));
    }
    Err(AppError::new(
        StatusCode::BAD_REQUEST,
        "file field is required",
    ))
}

async fn stream_path(
    State(state): State<AppState>,
    method: Method,
    AxumPath(encoded_path): AxumPath<String>,
    headers: HeaderMap,
) -> Result<Response, AppError> {
    let request_started = Instant::now();
    state.stats.stream_requests.fetch_add(1, Ordering::Relaxed);
    let active = state.stats.stream_active.fetch_add(1, Ordering::Relaxed) + 1;
    atomic_max(&state.stats.stream_active_max, active);
    if method == Method::HEAD {
        state
            .stats
            .stream_head_requests
            .fetch_add(1, Ordering::Relaxed);
    }
    let path = match ensure_streamable_path(&encoded_path).await {
        Ok(path) => path,
        Err(error) => {
            record_stream_status(&state.stats, error.status);
            state.stats.stream_errors.fetch_add(1, Ordering::Relaxed);
            state.stats.stream_active.fetch_sub(1, Ordering::Relaxed);
            return Err(error);
        }
    };
    let metadata = match fs::metadata(&path).await {
        Ok(metadata) => metadata,
        Err(_) => {
            record_stream_status(&state.stats, StatusCode::NOT_FOUND);
            state.stats.stream_errors.fetch_add(1, Ordering::Relaxed);
            state.stats.stream_active.fetch_sub(1, Ordering::Relaxed);
            return Err(AppError::new(StatusCode::NOT_FOUND, "media file not found"));
        }
    };
    let total = metadata.len();
    let range_header = headers.get(RANGE).and_then(|value| value.to_str().ok());
    if range_header.is_some() {
        state
            .stats
            .stream_range_requests
            .fetch_add(1, Ordering::Relaxed);
    } else {
        state
            .stats
            .stream_full_requests
            .fetch_add(1, Ordering::Relaxed);
    }
    let (status, start, end) = match parse_range(range_header, total) {
        Ok(range) => range,
        Err(error) => {
            record_stream_status(&state.stats, error.status);
            state.stats.stream_errors.fetch_add(1, Ordering::Relaxed);
            state.stats.stream_active.fetch_sub(1, Ordering::Relaxed);
            return Err(error);
        }
    };
    let length = end
        .saturating_sub(start)
        .saturating_add(if total == 0 { 0 } else { 1 });
    state
        .stats
        .stream_requested_bytes
        .fetch_add(length, Ordering::Relaxed);
    let content_type = mime_guess::from_path(&path)
        .first_or_octet_stream()
        .to_string();

    let mut response_headers = HeaderMap::new();
    response_headers.insert(ACCEPT_RANGES, HeaderValue::from_static("bytes"));
    response_headers.insert(CACHE_CONTROL, HeaderValue::from_static("no-store"));
    response_headers.insert(CONTENT_TYPE, header_value(&content_type)?);
    response_headers.insert(CONTENT_LENGTH, header_value(&length.to_string())?);
    response_headers.insert(
        "x-media-path-encoded",
        header_value(&encode_path(path.to_string_lossy().as_ref()))?,
    );
    if status == StatusCode::PARTIAL_CONTENT {
        response_headers.insert(
            CONTENT_RANGE,
            header_value(&format!("bytes {start}-{end}/{total}"))?,
        );
    }

    if method == Method::HEAD || length == 0 {
        let setup_us = elapsed_us(request_started);
        state
            .stats
            .stream_setup_us_total
            .fetch_add(setup_us, Ordering::Relaxed);
        atomic_max(&state.stats.stream_setup_us_max, setup_us);
        record_stream_status(&state.stats, status);
        complete_stream(&state.stats, request_started);
        return Ok((status, response_headers, Body::empty()).into_response());
    }

    let open_started = Instant::now();
    let mut file = match File::open(&path).await {
        Ok(file) => file,
        Err(_) => {
            record_stream_status(&state.stats, StatusCode::NOT_FOUND);
            state.stats.stream_errors.fetch_add(1, Ordering::Relaxed);
            state.stats.stream_active.fetch_sub(1, Ordering::Relaxed);
            return Err(AppError::new(StatusCode::NOT_FOUND, "media file not found"));
        }
    };
    let open_us = elapsed_us(open_started);
    state
        .stats
        .stream_open_us_total
        .fetch_add(open_us, Ordering::Relaxed);
    atomic_max(&state.stats.stream_open_us_max, open_us);
    let seek_started = Instant::now();
    if file.seek(SeekFrom::Start(start)).await.is_err() {
        record_stream_status(&state.stats, StatusCode::INTERNAL_SERVER_ERROR);
        state.stats.stream_errors.fetch_add(1, Ordering::Relaxed);
        state.stats.stream_active.fetch_sub(1, Ordering::Relaxed);
        return Err(AppError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "failed to seek media file",
        ));
    }
    let seek_us = elapsed_us(seek_started);
    state
        .stats
        .stream_seek_us_total
        .fetch_add(seek_us, Ordering::Relaxed);
    atomic_max(&state.stats.stream_seek_us_max, seek_us);
    spawn_prefetch(state.clone(), path.clone(), end.saturating_add(1), total).await;
    let setup_us = elapsed_us(request_started);
    state
        .stats
        .stream_setup_us_total
        .fetch_add(setup_us, Ordering::Relaxed);
    atomic_max(&state.stats.stream_setup_us_max, setup_us);
    record_stream_status(&state.stats, status);
    let stream_guard = Arc::new(StreamGuard::new(state.stats.clone(), request_started));
    let stream = stream_file_range(
        file,
        length,
        state.initial_chunk_bytes,
        state.read_chunk_bytes,
        stream_guard,
    );
    Ok((status, response_headers, Body::from_stream(stream)).into_response())
}

fn stream_file_range(
    file: File,
    length: u64,
    initial_chunk_size: usize,
    chunk_size: usize,
    guard: Arc<StreamGuard>,
) -> impl futures_util::Stream<Item = Result<Bytes, std::io::Error>> {
    stream::try_unfold(
        (
            file,
            length,
            initial_chunk_size.max(1),
            chunk_size.max(1),
            true,
            guard,
        ),
        |(mut file, remaining, initial_chunk_size, chunk_size, is_first, guard)| async move {
            let stats = guard.stats.clone();
            if remaining == 0 {
                return Ok(None);
            }
            let current_chunk_size = if is_first {
                initial_chunk_size
            } else {
                chunk_size
            };
            let read_len = (current_chunk_size as u64).min(remaining) as usize;
            let mut buffer = vec![0; read_len];
            let read_started = Instant::now();
            let bytes_read = match file.read(&mut buffer).await {
                Ok(bytes_read) => bytes_read,
                Err(error) => {
                    stats.stream_errors.fetch_add(1, Ordering::Relaxed);
                    stats.stream_active.fetch_sub(1, Ordering::Relaxed);
                    guard.done.store(true, Ordering::Relaxed);
                    return Err(error);
                }
            };
            let read_us = elapsed_us(read_started);
            stats
                .stream_read_us_total
                .fetch_add(read_us, Ordering::Relaxed);
            atomic_max(&stats.stream_read_us_max, read_us);
            if bytes_read == 0 {
                guard.finish();
                return Ok(None);
            }
            if is_first {
                let first_chunk_us = elapsed_us(guard.request_started);
                stats
                    .stream_first_chunk_us_total
                    .fetch_add(first_chunk_us, Ordering::Relaxed);
                atomic_max(&stats.stream_first_chunk_us_max, first_chunk_us);
                if first_chunk_us >= SLOW_FIRST_CHUNK_US {
                    stats
                        .stream_slow_first_chunk
                        .fetch_add(1, Ordering::Relaxed);
                }
            }
            stats
                .stream_bytes
                .fetch_add(bytes_read as u64, Ordering::Relaxed);
            stats.stream_chunks.fetch_add(1, Ordering::Relaxed);
            buffer.truncate(bytes_read);
            let next_remaining = remaining.saturating_sub(bytes_read as u64);
            if next_remaining == 0 {
                guard.finish();
            }
            Ok(Some((
                Bytes::from(buffer),
                (
                    file,
                    next_remaining,
                    initial_chunk_size,
                    chunk_size,
                    false,
                    guard,
                ),
            )))
        },
    )
}

async fn spawn_prefetch(state: AppState, path: PathBuf, start: u64, total: u64) {
    if state.prefetch_bytes == 0 {
        state
            .stats
            .prefetch_skipped_disabled
            .fetch_add(1, Ordering::Relaxed);
        return;
    }
    if start >= total {
        state
            .stats
            .prefetch_skipped_eof
            .fetch_add(1, Ordering::Relaxed);
        return;
    }

    let key = path.to_string_lossy().to_string();
    {
        let mut paths = state.prefetch_paths.lock().await;
        if !paths.insert(key.clone()) {
            state
                .stats
                .prefetch_skipped_duplicate
                .fetch_add(1, Ordering::Relaxed);
            return;
        }
    }
    state
        .stats
        .prefetch_scheduled
        .fetch_add(1, Ordering::Relaxed);

    tokio::spawn(async move {
        let permit = state.prefetch_semaphore.clone().try_acquire_owned();
        if permit.is_err() {
            state
                .stats
                .prefetch_skipped_busy
                .fetch_add(1, Ordering::Relaxed);
            let mut paths = state.prefetch_paths.lock().await;
            paths.remove(&key);
            return;
        }
        let _permit = permit.ok();
        state.stats.prefetch_active.fetch_add(1, Ordering::Relaxed);
        let length = state.prefetch_bytes.min(total.saturating_sub(start));
        let prefetch_started = Instant::now();
        match prefetch_range(&path, start, length, state.read_chunk_bytes).await {
            Ok(bytes_read) => {
                state
                    .stats
                    .prefetch_completed
                    .fetch_add(1, Ordering::Relaxed);
                state
                    .stats
                    .prefetch_bytes
                    .fetch_add(bytes_read, Ordering::Relaxed);
                state
                    .stats
                    .prefetch_read_us_total
                    .fetch_add(elapsed_us(prefetch_started), Ordering::Relaxed);
            }
            Err(_) => {
                state.stats.prefetch_errors.fetch_add(1, Ordering::Relaxed);
            }
        }
        state.stats.prefetch_active.fetch_sub(1, Ordering::Relaxed);
        let mut paths = state.prefetch_paths.lock().await;
        paths.remove(&key);
    });
}

async fn prefetch_range(
    path: &Path,
    start: u64,
    length: u64,
    chunk_size: usize,
) -> Result<u64, std::io::Error> {
    if length == 0 {
        return Ok(0);
    }
    let mut file = File::open(path).await?;
    file.seek(SeekFrom::Start(start)).await?;
    let mut remaining = length;
    let mut total_read = 0;
    let mut buffer = vec![0; chunk_size.max(1)];
    while remaining > 0 {
        let read_len = (buffer.len() as u64).min(remaining) as usize;
        let bytes_read = file.read(&mut buffer[..read_len]).await?;
        if bytes_read == 0 {
            break;
        }
        total_read += bytes_read as u64;
        remaining = remaining.saturating_sub(bytes_read as u64);
    }
    Ok(total_read)
}

fn header_value(value: &str) -> Result<HeaderValue, AppError> {
    HeaderValue::from_str(value)
        .map_err(|_| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, "invalid response header"))
}

fn record_stream_status(stats: &Stats, status: StatusCode) {
    match status.as_u16() {
        200 => {
            stats.stream_status_200.fetch_add(1, Ordering::Relaxed);
        }
        206 => {
            stats.stream_status_206.fetch_add(1, Ordering::Relaxed);
        }
        400..=499 => {
            stats.stream_status_4xx.fetch_add(1, Ordering::Relaxed);
        }
        500..=599 => {
            stats.stream_status_5xx.fetch_add(1, Ordering::Relaxed);
        }
        _ => {}
    }
}

fn complete_stream(stats: &Stats, request_started: Instant) {
    let duration_us = elapsed_us(request_started);
    stats.stream_completed.fetch_add(1, Ordering::Relaxed);
    stats
        .stream_duration_us_total
        .fetch_add(duration_us, Ordering::Relaxed);
    atomic_max(&stats.stream_duration_us_max, duration_us);
    if duration_us >= SLOW_STREAM_US {
        stats.stream_slow_completed.fetch_add(1, Ordering::Relaxed);
    }
    stats.stream_active.fetch_sub(1, Ordering::Relaxed);
}

fn stats_snapshot(state: &AppState) -> serde_json::Value {
    let stats = &state.stats;
    let started_at = stats.started_at_unix.load(Ordering::Relaxed);
    let stream_requests = stats.stream_requests.load(Ordering::Relaxed);
    let stream_completed = stats.stream_completed.load(Ordering::Relaxed);
    let stream_chunks = stats.stream_chunks.load(Ordering::Relaxed);
    let stream_bytes = stats.stream_bytes.load(Ordering::Relaxed);
    let stream_duration_us = stats.stream_duration_us_total.load(Ordering::Relaxed);
    let prefetch_completed = stats.prefetch_completed.load(Ordering::Relaxed);
    serde_json::json!({
        "startedAtUnix": started_at,
        "uptimeSeconds": now_unix().saturating_sub(started_at),
        "config": {
            "initialChunkBytes": state.initial_chunk_bytes,
            "readChunkBytes": state.read_chunk_bytes,
            "prefetchBytes": state.prefetch_bytes,
            "prefetchMaxTasks": state.prefetch_max_tasks,
        },
        "requests": {
            "fileList": stats.file_list_requests.load(Ordering::Relaxed),
            "meta": stats.meta_requests.load(Ordering::Relaxed),
            "upload": stats.upload_requests.load(Ordering::Relaxed),
            "uploadBytes": stats.upload_bytes.load(Ordering::Relaxed),
        },
        "stream": {
            "requests": stream_requests,
            "active": stats.stream_active.load(Ordering::Relaxed),
            "activeMax": stats.stream_active_max.load(Ordering::Relaxed),
            "headRequests": stats.stream_head_requests.load(Ordering::Relaxed),
            "rangeRequests": stats.stream_range_requests.load(Ordering::Relaxed),
            "fullRequests": stats.stream_full_requests.load(Ordering::Relaxed),
            "status200": stats.stream_status_200.load(Ordering::Relaxed),
            "status206": stats.stream_status_206.load(Ordering::Relaxed),
            "status4xx": stats.stream_status_4xx.load(Ordering::Relaxed),
            "status5xx": stats.stream_status_5xx.load(Ordering::Relaxed),
            "errors": stats.stream_errors.load(Ordering::Relaxed),
            "canceled": stats.stream_canceled.load(Ordering::Relaxed),
            "completed": stream_completed,
            "requestedBytes": stats.stream_requested_bytes.load(Ordering::Relaxed),
            "bytes": stream_bytes,
            "chunks": stream_chunks,
            "avgBytesPerRequest": avg_u64(stream_bytes, stream_completed),
            "avgBytesPerChunk": avg_u64(stream_bytes, stream_chunks),
            "avgThroughputBytesPerSecond": throughput_bps(stream_bytes, stream_duration_us),
            "avgFirstChunkUs": avg_u64(stats.stream_first_chunk_us_total.load(Ordering::Relaxed), stream_chunks.min(stream_requests)),
            "avgOpenUs": avg_u64(stats.stream_open_us_total.load(Ordering::Relaxed), stream_requests),
            "avgSeekUs": avg_u64(stats.stream_seek_us_total.load(Ordering::Relaxed), stream_requests),
            "avgSetupUs": avg_u64(stats.stream_setup_us_total.load(Ordering::Relaxed), stream_requests),
            "avgReadUs": avg_u64(stats.stream_read_us_total.load(Ordering::Relaxed), stream_chunks),
            "avgDurationUs": avg_u64(stream_duration_us, stream_completed),
            "maxFirstChunkUs": stats.stream_first_chunk_us_max.load(Ordering::Relaxed),
            "maxOpenUs": stats.stream_open_us_max.load(Ordering::Relaxed),
            "maxSeekUs": stats.stream_seek_us_max.load(Ordering::Relaxed),
            "maxSetupUs": stats.stream_setup_us_max.load(Ordering::Relaxed),
            "maxReadUs": stats.stream_read_us_max.load(Ordering::Relaxed),
            "maxDurationUs": stats.stream_duration_us_max.load(Ordering::Relaxed),
            "slowFirstChunk": stats.stream_slow_first_chunk.load(Ordering::Relaxed),
            "slowCompleted": stats.stream_slow_completed.load(Ordering::Relaxed),
        },
        "prefetch": {
            "scheduled": stats.prefetch_scheduled.load(Ordering::Relaxed),
            "active": stats.prefetch_active.load(Ordering::Relaxed),
            "completed": prefetch_completed,
            "errors": stats.prefetch_errors.load(Ordering::Relaxed),
            "bytes": stats.prefetch_bytes.load(Ordering::Relaxed),
            "skippedDisabled": stats.prefetch_skipped_disabled.load(Ordering::Relaxed),
            "skippedEof": stats.prefetch_skipped_eof.load(Ordering::Relaxed),
            "skippedDuplicate": stats.prefetch_skipped_duplicate.load(Ordering::Relaxed),
            "skippedBusy": stats.prefetch_skipped_busy.load(Ordering::Relaxed),
            "avgBytes": avg_u64(stats.prefetch_bytes.load(Ordering::Relaxed), prefetch_completed),
            "avgReadUs": avg_u64(stats.prefetch_read_us_total.load(Ordering::Relaxed), prefetch_completed),
        }
    })
}

fn avg_u64(total: u64, count: u64) -> u64 {
    if count == 0 { 0 } else { total / count }
}

fn throughput_bps(bytes: u64, duration_us: u64) -> u64 {
    if duration_us == 0 {
        0
    } else {
        bytes.saturating_mul(1_000_000) / duration_us
    }
}

fn atomic_max(target: &AtomicU64, value: u64) {
    let mut current = target.load(Ordering::Relaxed);
    while value > current {
        match target.compare_exchange_weak(current, value, Ordering::Relaxed, Ordering::Relaxed) {
            Ok(_) => break,
            Err(previous) => current = previous,
        }
    }
}

fn elapsed_us(started: Instant) -> u64 {
    started.elapsed().as_micros().min(u128::from(u64::MAX)) as u64
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_secs())
        .unwrap_or(0)
}

fn env_usize(name: &str, default: usize, min: usize, max: usize) -> usize {
    env::var(name)
        .ok()
        .and_then(|value| value.parse::<usize>().ok())
        .map(|value| value.clamp(min, max))
        .unwrap_or(default)
}

fn env_u64(name: &str, default: u64, min: u64, max: u64) -> u64 {
    env::var(name)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .map(|value| value.clamp(min, max))
        .unwrap_or(default)
}

fn safe_name(value: &str) -> String {
    let basename = Path::new(value)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("upload");
    let cleaned = basename
        .chars()
        .map(|ch| match ch {
            '\\' | '/' | ':' | '*' | '?' | '"' | '<' | '>' | '|' => '-',
            _ => ch,
        })
        .collect::<String>()
        .trim_matches('.')
        .trim()
        .to_string();
    if cleaned.is_empty() {
        "upload".to_string()
    } else {
        cleaned
    }
}

fn is_media_name(path: &Path) -> bool {
    path.extension()
        .and_then(|ext| ext.to_str())
        .map(|ext| MEDIA_EXTENSIONS.contains(&ext.to_ascii_lowercase().as_str()))
        .unwrap_or(false)
}

fn encode_path(path: &str) -> String {
    URL_SAFE_NO_PAD.encode(path.as_bytes())
}

fn decode_path(value: &str) -> Result<PathBuf, AppError> {
    let decoded = URL_SAFE_NO_PAD
        .decode(value.as_bytes())
        .map_err(|_| AppError::new(StatusCode::BAD_REQUEST, "invalid encoded path"))?;
    let path = String::from_utf8(decoded)
        .map_err(|_| AppError::new(StatusCode::BAD_REQUEST, "invalid encoded path"))?;
    if path.is_empty() {
        return Err(AppError::new(StatusCode::BAD_REQUEST, "empty path"));
    }
    Ok(PathBuf::from(path))
}

async fn ensure_streamable_path(encoded_path: &str) -> Result<PathBuf, AppError> {
    let path = decode_path(encoded_path)?;
    if !is_media_name(&path) {
        return Err(AppError::new(
            StatusCode::BAD_REQUEST,
            "unsupported media extension",
        ));
    }
    let canonical = path
        .canonicalize()
        .map_err(|_| AppError::new(StatusCode::NOT_FOUND, "media file not found"))?;
    let metadata = fs::metadata(&canonical)
        .await
        .map_err(|_| AppError::new(StatusCode::NOT_FOUND, "media file not found"))?;
    if !metadata.is_file() {
        return Err(AppError::new(StatusCode::NOT_FOUND, "media file not found"));
    }
    Ok(canonical)
}

async fn file_meta(path: PathBuf) -> Result<MediaMeta, AppError> {
    let metadata = fs::metadata(&path)
        .await
        .map_err(|_| AppError::new(StatusCode::NOT_FOUND, "media file not found"))?;
    let mtime = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_secs())
        .unwrap_or(0);
    let path_string = path.to_string_lossy().to_string();
    let id = encode_path(&path_string);
    Ok(MediaMeta {
        id: id.clone(),
        path: path_string,
        name: path
            .file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("media")
            .to_string(),
        content_type: mime_guess::from_path(&path)
            .first_or_octet_stream()
            .to_string(),
        size: metadata.len(),
        mtime,
        stream_url: format!("/api/stream/{id}"),
    })
}

async fn unique_upload_path(upload_dir: &Path, filename: &str) -> Result<PathBuf, AppError> {
    let stem = Path::new(filename)
        .file_stem()
        .and_then(|value| value.to_str())
        .unwrap_or("media");
    let suffix = Path::new(filename)
        .extension()
        .and_then(|value| value.to_str())
        .map(|value| format!(".{value}"))
        .unwrap_or_default();
    let mut candidate = upload_dir.join(format!("{stem}{suffix}"));
    let mut index = 2;
    while fs::try_exists(&candidate).await.map_err(|_| {
        AppError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "failed to check upload path",
        )
    })? {
        candidate = upload_dir.join(format!("{stem}-{index}{suffix}"));
        index += 1;
    }
    Ok(candidate)
}

fn parse_range(range_header: Option<&str>, total: u64) -> Result<(StatusCode, u64, u64), AppError> {
    if total == 0 {
        return Ok((StatusCode::OK, 0, 0));
    }
    let Some(range) = range_header else {
        return Ok((StatusCode::OK, 0, total - 1));
    };
    let Some(raw) = range.trim().strip_prefix("bytes=") else {
        return Err(
            AppError::new(StatusCode::RANGE_NOT_SATISFIABLE, "invalid range")
                .with_header(CONTENT_RANGE, format!("bytes */{total}")),
        );
    };
    let Some((raw_start, raw_end)) = raw.split_once('-') else {
        return Err(
            AppError::new(StatusCode::RANGE_NOT_SATISFIABLE, "invalid range")
                .with_header(CONTENT_RANGE, format!("bytes */{total}")),
        );
    };

    let (start, end) = if raw_start.is_empty() {
        let length = raw_end.parse::<u64>().unwrap_or(0);
        if length == 0 {
            return Err(
                AppError::new(StatusCode::RANGE_NOT_SATISFIABLE, "range not satisfiable")
                    .with_header(CONTENT_RANGE, format!("bytes */{total}")),
            );
        }
        (total.saturating_sub(length), total - 1)
    } else {
        let start = raw_start.parse::<u64>().map_err(|_| {
            AppError::new(StatusCode::RANGE_NOT_SATISFIABLE, "invalid range")
                .with_header(CONTENT_RANGE, format!("bytes */{total}"))
        })?;
        let end = if raw_end.is_empty() {
            total - 1
        } else {
            raw_end.parse::<u64>().map_err(|_| {
                AppError::new(StatusCode::RANGE_NOT_SATISFIABLE, "invalid range")
                    .with_header(CONTENT_RANGE, format!("bytes */{total}"))
            })?
        };
        (start, end.min(total - 1))
    };

    if start >= total || end < start {
        return Err(
            AppError::new(StatusCode::RANGE_NOT_SATISFIABLE, "range not satisfiable")
                .with_header(CONTENT_RANGE, format!("bytes */{total}")),
        );
    }
    Ok((StatusCode::PARTIAL_CONTENT, start, end))
}
