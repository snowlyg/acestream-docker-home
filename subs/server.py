#!/usr/bin/env python3
"""Local ASR subtitle sidecar for the Ace Stream player.

Runs natively on the host (NOT inside the acestream container) so it can use
the host CPU / arm64 acceleration instead of emulated amd64. It pulls the audio
of the same live stream the player is watching, transcribes and translates it to
English with faster-whisper (task=translate), and exposes the cues over a tiny
HTTP API that the player polls.

Endpoints:
    GET  /health                     -> {status, model, ready}
    POST /session {content_id,engine}-> {session_id}   (start ffmpeg + ASR)
    GET  /session/<id>/cues?after=N  -> {cues:[{seq,start,end,text}], next, status}
    POST /session/<id>/stop          -> {status}

Cue start/end are seconds elapsed since the session started reading audio; the
player anchors them onto its own timeline with an offset captured at enable time.
"""
import argparse
import json
import re
import subprocess
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import numpy as np
from faster_whisper import WhisperModel

RATE = 16000
HASH_RE = re.compile(r"^[a-f0-9]{40}$")

CFG = None
MODEL = None
SESSIONS = {}
SESSIONS_LOCK = threading.Lock()


class Session:
    def __init__(self, content_id, engine):
        self.id = uuid.uuid4().hex[:12]
        self.content_id = content_id
        self.engine = engine.rstrip("/")
        self.cues = []
        self.lock = threading.Lock()
        self.stop_event = threading.Event()
        self.proc = None
        self.status = "starting"
        self.error = None
        self.thread = threading.Thread(target=self._run, daemon=True)

    def start(self):
        self.thread.start()

    def stop(self):
        self.stop_event.set()
        # Unblock the worker's stdout.read() so shutdown is prompt.
        if self.proc and self.proc.poll() is None:
            try:
                self.proc.terminate()
            except OSError:
                pass

    def _manifest_url(self):
        return f"{self.engine}/ace/manifest.m3u8?content_id={self.content_id}"

    def _emit(self, start, end, text):
        with self.lock:
            self.cues.append({
                "seq": len(self.cues),
                "start": round(start, 3),
                "end": round(end, 3),
                "text": text,
            })

    def _transcribe_window(self, buf, buf_start, emitted_end):
        segments, _info = MODEL.transcribe(
            buf, task="translate", vad_filter=True, beam_size=CFG.beam_size,
        )
        for seg in segments:
            a = buf_start + seg.start
            b = buf_start + seg.end
            text = seg.text.strip()
            # Overlapping windows re-see the tail; only emit what is new.
            if not text or b <= emitted_end + 0.05:
                continue
            self._emit(a, b, text)
            emitted_end = b
        return emitted_end

    def _run(self):
        cmd = [
            CFG.ffmpeg, "-hide_banner", "-loglevel", "error",
            "-i", self._manifest_url(),
            "-vn", "-ac", "1", "-ar", str(RATE), "-f", "s16le", "pipe:1",
        ]
        try:
            self.proc = subprocess.Popen(
                cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
            )
        except FileNotFoundError:
            self.status = "error"
            self.error = "ffmpeg not found on the host (brew install ffmpeg)"
            return

        self.status = "transcribing"
        buf = np.zeros(0, dtype=np.float32)
        buf_start = 0.0      # session time (s) of buf[0]
        emitted_end = 0.0    # absolute end of the last cue handed to the player
        chunk_samples = int(CFG.chunk_sec * RATE)
        max_window = int(CFG.max_window * RATE)
        overlap = int(0.5 * RATE)

        try:
            while not self.stop_event.is_set():
                raw = self.proc.stdout.read(32768)
                if not raw:
                    break
                samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
                buf = np.concatenate([buf, samples])
                if len(buf) < chunk_samples:
                    continue
                # Bound the window so inference latency cannot grow without limit.
                if len(buf) > max_window:
                    drop = len(buf) - max_window
                    buf = buf[drop:]
                    buf_start += drop / RATE

                emitted_end = self._transcribe_window(buf, buf_start, emitted_end)

                # Keep a short tail for continuity across chunk boundaries.
                keep_from = max(0.0, emitted_end - buf_start - overlap / RATE)
                drop = int(keep_from * RATE)
                if drop > 0:
                    buf = buf[drop:]
                    buf_start += drop / RATE

            # Flush the final sub-chunk tail so the last words are not lost when
            # the stream ends (a live stream that stops, or a finite test file).
            if not self.stop_event.is_set() and len(buf) > RATE // 2:
                emitted_end = self._transcribe_window(buf, buf_start, emitted_end)

            if not self.stop_event.is_set():
                self.status = "stopped"
        except Exception as exc:  # surface the reason to the player
            self.status = "error"
            self.error = str(exc)
        finally:
            if self.proc and self.proc.poll() is None:
                try:
                    self.proc.terminate()
                    self.proc.wait(timeout=3)
                except Exception:
                    self.proc.kill()


class Handler(BaseHTTPRequestHandler):
    server_version = "AceSubs/1.0"

    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def _send(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _get_session(self, sid):
        with SESSIONS_LOCK:
            return SESSIONS.get(sid)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        parsed = urlparse(self.path)
        parts = [p for p in parsed.path.split("/") if p]

        if parsed.path in ("/", "/health"):
            self._send(200, {"status": "ok", "model": CFG.model, "ready": MODEL is not None})
            return

        if len(parts) == 3 and parts[0] == "session" and parts[2] == "cues":
            sess = self._get_session(parts[1])
            if not sess:
                self._send(404, {"error": "unknown session"})
                return
            after = int(parse_qs(parsed.query).get("after", ["-1"])[0])
            with sess.lock:
                cues = [c for c in sess.cues if c["seq"] > after]
                nxt = sess.cues[-1]["seq"] if sess.cues else after
            self._send(200, {"cues": cues, "next": nxt, "status": sess.status, "error": sess.error})
            return

        self._send(404, {"error": "not found"})

    def do_POST(self):
        parsed = urlparse(self.path)
        parts = [p for p in parsed.path.split("/") if p]
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length else b""
        try:
            data = json.loads(raw) if raw else {}
        except json.JSONDecodeError:
            data = {}

        if parsed.path == "/session":
            cid = str(data.get("content_id", "")).lower().strip()
            if not HASH_RE.match(cid):
                self._send(400, {"error": "content_id must be 40 hex characters"})
                return
            engine = str(data.get("engine") or CFG.engine)
            if not engine.startswith(("http://", "https://")):
                self._send(400, {"error": "engine must be an http(s) URL"})
                return
            with SESSIONS_LOCK:
                for sess in SESSIONS.values():
                    if sess.content_id == cid and sess.status in ("starting", "transcribing"):
                        self._send(200, {"session_id": sess.id, "reused": True})
                        return
                sess = Session(cid, engine)
                SESSIONS[sess.id] = sess
            sess.start()
            self._send(200, {"session_id": sess.id})
            return

        if len(parts) == 3 and parts[0] == "session" and parts[2] == "stop":
            sess = self._get_session(parts[1])
            if not sess:
                self._send(404, {"error": "unknown session"})
                return
            sess.stop()
            self._send(200, {"status": "stopping"})
            return

        self._send(404, {"error": "not found"})

    def log_message(self, fmt, *args):
        pass


def main():
    global CFG, MODEL
    ap = argparse.ArgumentParser(description="Local ASR subtitle sidecar (English output).")
    ap.add_argument("--bind", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8765)
    ap.add_argument("--model", default="small", help="faster-whisper model (tiny/base/small/medium)")
    ap.add_argument("--engine", default="http://127.0.0.1:6878")
    ap.add_argument("--ffmpeg", default="ffmpeg")
    ap.add_argument("--device", default="cpu")
    ap.add_argument("--compute-type", default="int8")
    ap.add_argument("--chunk-sec", type=float, default=5.0)
    ap.add_argument("--max-window", type=float, default=30.0)
    ap.add_argument("--beam-size", type=int, default=5)
    CFG = ap.parse_args()

    print(f"[subs] loading faster-whisper '{CFG.model}' ({CFG.device}/{CFG.compute_type})...", flush=True)
    MODEL = WhisperModel(CFG.model, device=CFG.device, compute_type=CFG.compute_type)
    print(f"[subs] ready on http://{CFG.bind}:{CFG.port} (engine {CFG.engine})", flush=True)

    httpd = ThreadingHTTPServer((CFG.bind, CFG.port), Handler)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        with SESSIONS_LOCK:
            for sess in SESSIONS.values():
                sess.stop()
        httpd.server_close()


if __name__ == "__main__":
    main()