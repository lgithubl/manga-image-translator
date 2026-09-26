FROM python:3.12-slim-bookworm

ENV PYTHONUNBUFFERED=1 \
    AUDIO_WIDGET_HOST=0.0.0.0 \
    AUDIO_WIDGET_PORT=8080 \
    AUDIO_WIDGET_DATA_DIR=/data

WORKDIR /app

COPY requirements.txt /app/requirements.txt
RUN python -m pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir -r /app/requirements.txt

COPY server.py /app/server.py
COPY public /app/public

RUN mkdir -p /data/uploads

EXPOSE 8080

CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8080"]
