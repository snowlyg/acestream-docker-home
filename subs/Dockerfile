# Native-arm64 subtitle sidecar image. Unlike the engine (amd64-only, emulated on
# Apple Silicon), this base runs natively so ASR stays fast. No platform override.
#
# Base is python:3.10: it is already cached locally as arm64 on the target host,
# which avoids a slow Docker Hub pull (public China registry mirrors are currently
# login-gated or rate-limited). ctranslate2 / faster-whisper support 3.10. On a
# host without a cached base, pull one via a working registry mirror first.
#
# apt (aliyun) and pip (tuna) use mainland mirrors to keep the remaining downloads
# fast on China networks.
FROM python:3.10

RUN set -eux; \
    if [ -f /etc/apt/sources.list.d/debian.sources ]; then \
      sed -i 's|deb.debian.org|mirrors.aliyun.com|g; s|security.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list.d/debian.sources; \
    fi; \
    if [ -f /etc/apt/sources.list ]; then \
      sed -i 's|deb.debian.org|mirrors.aliyun.com|g; s|security.debian.org|mirrors.aliyun.com|g' /etc/apt/sources.list; \
    fi; \
    apt-get update -o Acquire::Retries=5 -o Acquire::http::Timeout=30 \
 && apt-get install -y --no-install-recommends -o Acquire::Retries=5 -o Acquire::http::Timeout=30 ffmpeg \
 && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir --retries 5 --timeout 60 -i https://pypi.tuna.tsinghua.edu.cn/simple -r requirements.txt

COPY server.py ./

EXPOSE 8765

# huggingface.co is frequently stalled/blocked on China networks (the model blob
# downloads at 0 B/s); hf-mirror.com is a full mirror that huggingface_hub honours
# via HF_ENDPOINT. But huggingface_hub 2.x + hf-xet default to the Xet CAS protocol,
# which bypasses HF_ENDPOINT and stalls at 0 B on the same network — so force the
# classic HTTP path with HF_HUB_DISABLE_XET. Placed after the heavy layers to keep
# their cache.
ENV HF_ENDPOINT=https://hf-mirror.com \
    HF_HUB_DISABLE_XET=1

# Model weights download on first start into the HF cache; mount a volume there
# (see compose) so they persist across restarts. ENTRYPOINT fixes the interpreter
# + script so a compose `command:` only overrides the args (it replaces CMD
# wholesale); --engine/--model come from compose, --bind/--port from argparse
# defaults (0.0.0.0:8765).
ENTRYPOINT ["python", "server.py"]
CMD ["--bind", "0.0.0.0", "--port", "8765"]
