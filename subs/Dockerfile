# Native-arm64 subtitle sidecar image. Unlike the engine (amd64-only, emulated on
# Apple Silicon), this base is multi-arch so Docker builds/runs it natively and
# ASR stays fast. No platform override on purpose.
FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir -r requirements.txt

COPY server.py ./

EXPOSE 8765

# Model weights download on first start into the HF cache; mount a volume there
# (see compose) so they persist across restarts. --engine is supplied by compose.
CMD ["python", "server.py", "--bind", "0.0.0.0", "--port", "8765"]