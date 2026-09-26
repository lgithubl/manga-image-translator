FROM python:3.12-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    AUDIO_WIDGET_HOST=0.0.0.0 \
    AUDIO_WIDGET_PORT=8080 \
    AUDIO_WIDGET_DATA_DIR=/data

WORKDIR /app

COPY server.py /app/server.py
COPY public /app/public

RUN mkdir -p /data/uploads

EXPOSE 8080

CMD ["python", "/app/server.py"]
