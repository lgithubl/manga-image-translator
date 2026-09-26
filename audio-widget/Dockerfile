FROM rust:1.98-bookworm AS builder

WORKDIR /src

COPY Cargo.toml /src/Cargo.toml
COPY src /src/src
RUN cargo build --release

FROM debian:bookworm-slim

ENV AUDIO_WIDGET_HOST=0.0.0.0 \
    AUDIO_WIDGET_PORT=8080 \
    AUDIO_WIDGET_DATA_DIR=/data

WORKDIR /app

COPY --from=builder /src/target/release/audio-widget /app/audio-widget
COPY public /app/public

RUN mkdir -p /data/uploads

EXPOSE 8080

CMD ["/app/audio-widget"]
