FROM rust:1.98-bookworm AS builder

WORKDIR /src

COPY Cargo.toml /src/Cargo.toml
COPY src /src/src
RUN cargo build --release

FROM debian:bookworm-slim

ENV AUDIO_WIDGET_HOST=0.0.0.0 \
    AUDIO_WIDGET_PORT=8080 \
    AUDIO_WIDGET_DATA_DIR=/tmp/audio-widget \
    AUDIO_WIDGET_UPLOAD_DIR=/tmp/audio-widget/uploads \
    AUDIO_WIDGET_UPLOAD_ENABLED=false \
    AUDIO_WIDGET_TCP_NODELAY=true \
    AUDIO_WIDGET_SOCKET_SEND_BUFFER_BYTES=0 \
    AUDIO_WIDGET_STREAM_CACHE_CONTROL=no-store \
    AUDIO_WIDGET_INITIAL_CHUNK_BYTES=262144 \
    AUDIO_WIDGET_READ_CHUNK_BYTES=1048576 \
    AUDIO_WIDGET_PREFETCH_BYTES=0 \
    AUDIO_WIDGET_PREFETCH_MAX_TASKS=2 \
    AUDIO_WIDGET_SENDFILE_ENABLED=false

WORKDIR /app

COPY --from=builder /src/target/release/audio-widget /app/audio-widget
COPY public /app/public

EXPOSE 8080

CMD ["/app/audio-widget"]
