#!/usr/bin/env bash
# Start the local ASR subtitle sidecar. Creates a venv on first run.
# Usage: ./run.sh [--model small] [--port 8765] [--engine http://127.0.0.1:6878]
set -euo pipefail
cd "$(dirname "$0")"

# ctranslate2 (faster-whisper's backend) ships wheels for CPython 3.9-3.12.
# Prefer a compatible interpreter over a too-new default python3.
PYTHON="${PYTHON:-}"
if [ -z "$PYTHON" ]; then
    for candidate in python3.12 python3.11 python3.10 python3; do
        if command -v "$candidate" >/dev/null 2>&1; then
            PYTHON="$candidate"
            break
        fi
    done
fi
if [ -z "$PYTHON" ]; then
    echo "No python3 found. Install Python 3.10-3.12." >&2
    exit 1
fi

if [ ! -d .venv ]; then
    echo "[subs] creating venv with $PYTHON ($($PYTHON --version 2>&1))"
    "$PYTHON" -m venv .venv
    ./.venv/bin/pip install --upgrade pip
    ./.venv/bin/pip install -r requirements.txt
fi

exec ./.venv/bin/python server.py "$@"