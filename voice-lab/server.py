"""ClawdDesk voice lab: speaks with a voice cloned (zero-shot) from YOUR reference recording.

Runs F5-TTS (MLX, Apple Silicon) locally and serves synthesized WAV over HTTP on 127.0.0.1.

    voice-lab/.venv/bin/python voice-lab/server.py [--port 3003] [--voice voice-lab/my-voice]

The voice folder needs `reference.wav` (24 kHz mono, ~5-15 s of clear speech) and `reference.txt`
(exactly what is said in it). `record.py` makes both. Only use a voice you have the right to use:
your own, or someone who agreed to it.

Endpoints (browser requests must come from a loopback page):
    GET  /health  -> {"ok": true, "voice": "...", "ready": bool}
    POST /speak   {"text": "..."} -> audio/wav (cached on disk per voice + text)
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import queue
import threading
import time
from concurrent.futures import Future
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

import mlx.core as mx
import numpy as np
import soundfile as sf
from f5_tts_mlx.generate import (
    F5TTS,
    SAMPLE_RATE,
    TARGET_RMS,
    convert_char_to_pinyin,
    split_sentences,
)

# f5-tts-mlx 0.2.x passes MLX scalars inside the shape to mx.random.normal, which newer MLX rejects.
# Convert the shape to plain ints so it works on both old and new MLX.
_mx_normal = mx.random.normal


def _normal_compat(shape=(), *args, **kwargs):
    if isinstance(shape, (tuple, list)):
        shape = [int(d.item()) if isinstance(d, mx.array) else int(d) for d in shape]
    return _mx_normal(shape, *args, **kwargs)


mx.random.normal = _normal_compat

HERE = Path(__file__).resolve().parent
MODEL = "lucasnewman/f5-tts-mlx"
MAX_TEXT = 400
# Sampling: model evaluations per sentence = steps × (4 for rk4, 2 for midpoint, 1 for euler).
STEPS = 16
METHOD = "euler"
LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "[::1]", "::1"}
# Lines worth having ready before they are first needed.
WARMUP = ["At your service, sir.", "Task complete, sir.", "Sir, your attention is required."]


def origin_allowed(origin: str | None) -> bool:
    """No Origin (curl, scripts) or a loopback page. Anything else is a foreign website."""
    if not origin:
        return True
    try:
        u = urlparse(origin)
    except ValueError:
        return False
    return u.scheme in ("http", "https") and (u.hostname or "") in LOOPBACK_HOSTS


class Voice:
    def __init__(self, folder: Path):
        wav, txt = folder / "reference.wav", folder / "reference.txt"
        if not wav.exists() or not txt.exists():
            raise SystemExit(
                f"\n  ✖ {folder} needs reference.wav and reference.txt.\n"
                f"    Record them with: voice-lab/.venv/bin/python voice-lab/record.py\n"
            )
        audio, sr = sf.read(str(wav), dtype="float32", always_2d=True)
        audio = audio.mean(axis=1)  # mono
        if sr != SAMPLE_RATE:
            raise SystemExit(f"\n  ✖ {wav} must be {SAMPLE_RATE} Hz (it is {sr} Hz). record.py writes the right format.\n")
        self.name = folder.name
        self.text = txt.read_text(encoding="utf-8").strip()
        ref = mx.array(audio)
        rms = mx.sqrt(mx.mean(mx.square(ref)))
        self.ref = ref * TARGET_RMS / rms if rms.item() < TARGET_RMS else ref
        self.digest = hashlib.sha1(wav.read_bytes() + self.text.encode()).hexdigest()[:12]
        self.model: F5TTS | None = None
        # MLX GPU streams belong to the thread that created them, so every MLX call (loading and
        # generating) happens on one worker thread; HTTP threads hand it jobs and wait.
        self.jobs: queue.Queue[tuple[str, Future]] = queue.Queue()

    def run_worker(self, warmup: list[str], cache: Path):
        t = time.time()
        self.model = F5TTS.from_pretrained(MODEL)
        print(f"  model ready in {time.time() - t:.1f}s")
        for line in warmup:
            path = cache / f"{cache_key(self, line)}.wav"
            if not path.exists():
                path.write_bytes(wav_bytes(self._generate(line)))
        print("  warm-up done")
        while True:
            text, fut = self.jobs.get()
            try:
                fut.set_result(self._generate(text))
            except Exception as err:  # noqa: BLE001 - report any generation failure to the caller
                fut.set_exception(err)

    def synthesize(self, text: str, timeout: float = 120) -> np.ndarray:
        fut: Future = Future()
        self.jobs.put((text, fut))
        return fut.result(timeout=timeout)

    def _generate(self, text: str) -> np.ndarray:
        assert self.model is not None
        parts = []
        for sentence in split_sentences(text) or [text]:
            prompt = convert_char_to_pinyin([self.text + " " + sentence])
            wave, _ = self.model.sample(mx.expand_dims(self.ref, axis=0), text=prompt, steps=STEPS, method=METHOD)
            wave = wave[self.ref.shape[0] :]
            mx.eval(wave)
            parts.append(np.array(wave))
        return np.concatenate(parts) if parts else np.zeros(1, dtype=np.float32)


def cache_key(voice: "Voice", text: str) -> str:
    return hashlib.sha1(f"{voice.digest}|{METHOD}|{STEPS}|{text}".encode()).hexdigest()


def wav_bytes(samples: np.ndarray) -> bytes:
    buf = io.BytesIO()
    sf.write(buf, samples, SAMPLE_RATE, format="WAV", subtype="PCM_16")
    return buf.getvalue()


def make_handler(voice: Voice, cache: Path):
    class Handler(BaseHTTPRequestHandler):
        server_version = "ClawdDeskVoiceLab/1"

        def log_message(self, fmt, *args):  # quieter than the default access log
            pass

        def _cors(self) -> bool:
            origin = self.headers.get("Origin")
            if not origin_allowed(origin):
                self.send_response(403)
                self.end_headers()
                return False
            return True

        def _headers(self, status: int, ctype: str, length: int):
            self.send_response(status)
            origin = self.headers.get("Origin")
            if origin:
                self.send_header("Access-Control-Allow-Origin", origin)
                self.send_header("Vary", "Origin")
            self.send_header("Content-Type", ctype)
            self.send_header("Content-Length", str(length))
            self.end_headers()

        def _json(self, status: int, obj):
            body = json.dumps(obj).encode()
            self._headers(status, "application/json", len(body))
            self.wfile.write(body)

        def do_OPTIONS(self):
            if not self._cors():
                return
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", self.headers.get("Origin", "*"))
            self.send_header("Access-Control-Allow-Methods", "GET, POST")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.end_headers()

        def do_GET(self):
            if not self._cors():
                return
            if urlparse(self.path).path == "/health":
                return self._json(200, {"ok": True, "voice": voice.name, "ready": voice.model is not None})
            self._json(404, {"error": "not found"})

        def do_POST(self):
            if not self._cors():
                return
            if urlparse(self.path).path != "/speak":
                return self._json(404, {"error": "not found"})
            try:
                length = min(int(self.headers.get("Content-Length", "0")), 64 * 1024)
                text = str(json.loads(self.rfile.read(length) or b"{}").get("text", "")).strip()
            except (ValueError, json.JSONDecodeError):
                return self._json(400, {"error": "bad json"})
            if not text or len(text) > MAX_TEXT:
                return self._json(400, {"error": f"text must be 1-{MAX_TEXT} characters"})
            if voice.model is None:
                return self._json(503, {"error": "model loading"})

            path = cache / f"{cache_key(voice, text)}.wav"
            if not path.exists():
                t = time.time()
                try:
                    data = wav_bytes(voice.synthesize(text))
                except Exception as err:  # noqa: BLE001
                    print(f"  ✖ generation failed: {err}")
                    return self._json(500, {"error": "generation failed"})
                path.write_bytes(data)
                print(f"  [{time.time() - t:4.1f}s] {text}")
            data = path.read_bytes()
            self._headers(200, "audio/wav", len(data))
            self.wfile.write(data)

    return Handler


def main():
    global STEPS, METHOD
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--port", type=int, default=3003)
    ap.add_argument("--voice", type=Path, default=HERE / "my-voice")
    ap.add_argument("--steps", type=int, default=STEPS, help=f"sampling steps (default {STEPS})")
    ap.add_argument("--method", choices=["euler", "midpoint", "rk4"], default=METHOD, help=f"sampler (default {METHOD})")
    args = ap.parse_args()
    STEPS, METHOD = args.steps, args.method

    voice = Voice(args.voice.resolve())
    cache = HERE / "cache"
    cache.mkdir(exist_ok=True)

    threading.Thread(target=voice.run_worker, args=(WARMUP, cache), daemon=True).start()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(voice, cache))
    print(f"\n  🎙  ClawdDesk voice lab  http://127.0.0.1:{args.port}   voice: {voice.name}\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
