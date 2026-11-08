# Local ASR subtitles (English)

Live subtitles for the Ace Stream player, generated **on your own machine** with
a local [faster-whisper](https://github.com/SYSTRAN/faster-whisper) model. No
cloud service, no account. The model transcribes the stream audio and translates
it to English (`task=translate`).

This runs as a **native host process, not inside the acestream container**. The
container image is x86_64-only and minimal; on Apple Silicon it runs under
emulation, which is far too slow for real-time ASR. Running natively lets the
sidecar use the host CPU (arm64 int8) properly and keeps the core image unchanged.

## Requirements

- `ffmpeg` on the host — macOS: `brew install ffmpeg`
- Python **3.10–3.12** (ctranslate2 wheels). `run.sh` picks a compatible
  interpreter automatically; override with `PYTHON=python3.11 ./run.sh`.
- First run downloads the model (see sizes below).

## Run

```bash
cd subs
./run.sh                       # default: small model, port 8765
./run.sh --model base          # lower latency, lower quality
./run.sh --model tiny          # fastest, for a quick smoke test
./run.sh --port 8765 --engine http://127.0.0.1:6878
```

Then open the player and start a stream: on the first successful play the player
probes the sidecar and **enables subtitles automatically** (no manual step). The
**CC** button (top-right) toggles them on/off at any time. The player talks to the
sidecar at `http://<page-host>:8765` by default; you can override the address in
the input panel.

| Model  | Download | Notes                          |
|--------|----------|--------------------------------|
| tiny   | ~75 MB   | smoke tests, weakest quality   |
| base   | ~145 MB  | low latency                    |
| small  | ~465 MB  | default, good quality/latency  |
| medium | ~1.5 GB  | best quality, higher latency   |

## Run as a container (starts with the stack, no manual step)

Instead of `run.sh`, the sidecar can run as a companion container next to the
engine so it comes up (and auto-restarts) with `docker compose up -d`. The image
is multi-arch (`python:3.11-slim`), so on Apple Silicon it runs **native arm64**
and stays fast — do not add `platform: linux/amd64` to it. Add to your compose:

```yaml
  subs:
    build:
      context: /path/to/repo/subs
    image: acestream-subs:latest
    container_name: acestream-subs
    restart: unless-stopped
    ports:
      - "127.0.0.1:8765:8765"
    command: ["--engine", "http://acestream:6878", "--model", "small"]
    volumes:
      - subs-models:/root/.cache/huggingface
    depends_on:
      - acestream

volumes:
  subs-models:
    name: subs-models
```

`--engine http://acestream:6878` uses the compose service name (container-to-
container). The model downloads once into the `subs-models` volume on first
start. Because the sidecar is always up, the player auto-enables subtitles on
first play; you never run anything by hand.

## How it works

1. The player `POST /session {content_id}` when you enable CC.
2. The sidecar starts `ffmpeg` against the engine's
   `/ace/manifest.m3u8?content_id=<id>` and reads **audio only** (16 kHz mono).
   This shares the engine's existing live download, so it adds little bandwidth.
3. Audio is transcribed in rolling ~5 s windows (`--chunk-sec`), translated to
   English, and appended as cues.
4. The player polls `GET /session/<id>/cues?after=N` and renders them as a native
   video.js subtitle track (works in fullscreen).

## API

| Method | Path                     | Body / query                  |
|--------|--------------------------|-------------------------------|
| GET    | `/health`                | —                             |
| POST   | `/session`               | `{content_id, engine?}`       |
| GET    | `/session/<id>/cues`     | `?after=<last seq>`           |
| POST   | `/session/<id>/stop`     | —                             |

## Caveats

- **Latency is physical**: subtitles lag the picture by a few seconds (audio has
  to accumulate before it can be transcribed). Timeline alignment is approximate.
- **English only for now** (Whisper's native translate target). Other target
  languages would need a second, local translation model.
- **CSP**: the player's `connect-src` is relaxed to allow `http://*:8765` (only
  the sidecar port, still no third-party domains). If you change `--port`, update
  the CSP `<meta>` in `web/player.html` to match.
- The sidecar binds `0.0.0.0` so LAN clients can reach it; it is a personal local
  tool, not hardened for exposure to untrusted networks. Use `--bind 127.0.0.1`
  if you only watch from this machine.