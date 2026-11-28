"""ClawdDesk voice lab: speaks with a voice cloned (zero-shot) from YOUR reference recording,
and transcribes spoken commands. Both run locally on Apple Silicon (MLX): F5-TTS and Whisper.

    voice-lab/.venv/bin/python voice-lab/server.py [--port 3003] [--voice voice-lab/my-voice]

The voice folder needs `reference.wav` (24 kHz mono, ~5-15 s of clear speech) and `reference.txt`
(exactly what is said in it). `record.py` makes both. Only use a voice you have the right to use:
your own, or someone who agreed to it.

Without a reference recording the server still runs for transcription only.

Endpoints (browser requests must come from a loopback page or the desktop app):
    GET  /health      -> {"ok": true, "voice": "..."|null, "ready": bool, "tts": bool, "stt": bool}
    POST /speak       {"text": "..."} -> audio/wav (cached on disk per voice + text)
    POST /transcribe  audio/wav (mono, <= 30 s) -> {"text": "...", "language": "ko"}
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
STT_MODEL = "mlx-community/whisper-large-v3-turbo"  # multilingual (Korean and English), ~1.6 GB on first use
STT_RATE = 16_000
MAX_AUDIO_BYTES = 6 * 1024 * 1024  # ~30 s of 16 kHz PCM16 with headroom
# Sampling: model evaluations per sentence = steps × (4 for rk4, 2 for midpoint, 1 for euler).
STEPS = 16
METHOD = "euler"
LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "[::1]", "::1"}
# Lines worth having ready before they are first needed.
WARMUP = ["At your service, sir.", "Task complete, sir.", "Sir, your attention is required."]


DESKTOP_APP_ORIGINS = {"tauri://localhost", "http://tauri.localhost"}


def origin_allowed(origin: str | None) -> bool:
    """No Origin (curl, scripts), a loopback page or the desktop app. Anything else is a foreign website."""
    if not origin or origin in DESKTOP_APP_ORIGINS:
        return True
    try:
        u = urlparse(origin)
    except ValueError:
        return False
    return u.scheme in ("http", "https") and (u.hostname or "") in LOOPBACK_HOSTS


class Voice:
    """The engines, all driven from one worker thread (MLX GPU streams belong to the thread that made them)."""

    def __init__(self, folder: Path, stt: bool):
        wav, txt = folder / "reference.wav", folder / "reference.txt"
        self.enabled = wav.exists() and txt.exists()  # text-to-speech needs a reference recording
        self.stt_wanted = stt
        self.stt_ready = False
        self.model: F5TTS | None = None
        self.jobs: queue.Queue[tuple[str, object, Future]] = queue.Queue()
        self.name: str | None = None
        if not self.enabled:
            print(
                f"\n  ! no reference recording in {folder}: speaking is off, transcription only.\n"
                f"    Record one with: npm run voice:record\n"
            )
            self.digest = "none"
            return
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

    def run_worker(self, warmup: list[str], cache: Path):
        if self.enabled:
            t = time.time()
            self.model = F5TTS.from_pretrained(MODEL)
            print(f"  voice model ready in {time.time() - t:.1f}s")
            for line in warmup:
                path = cache / f"{cache_key(self, line)}.wav"
                if not path.exists():
                    path.write_bytes(wav_bytes(self._generate(line)))
            print("  warm-up done")
        if self.stt_wanted:
            t = time.time()
            self._transcribe(np.zeros(STT_RATE // 2, dtype=np.float32))  # downloads / compiles once
            self.stt_ready = True
            print(f"  transcription ready in {time.time() - t:.1f}s ({STT_MODEL})")
        while True:
            kind, payload, fut = self.jobs.get()
            try:
                if kind == "tts":
                    fut.set_result(self._generate(payload))  # type: ignore[arg-type]
                else:
                    fut.set_result(self._transcribe(payload))  # type: ignore[arg-type]
            except Exception as err:  # noqa: BLE001 - report any failure to the caller
                fut.set_exception(err)

    def _submit(self, kind: str, payload, timeout: float):
        fut: Future = Future()
        self.jobs.put((kind, payload, fut))
        return fut.result(timeout=timeout)

    def synthesize(self, text: str, timeout: float = 120) -> np.ndarray:
        return self._submit("tts", text, timeout)

    def transcribe(self, audio: np.ndarray, timeout: float = 60) -> dict:
        return self._submit("stt", audio, timeout)

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

    def _transcribe(self, audio: np.ndarray) -> dict:
        import mlx_whisper  # imported on the worker thread, like every other MLX call

        out = mlx_whisper.transcribe(audio, path_or_hf_repo=STT_MODEL, condition_on_previous_text=False)
        return {"text": str(out.get("text", "")).strip(), "language": out.get("language")}


def decode_wav(data: bytes) -> np.ndarray:
    """Mono float32 at 16 kHz from a WAV upload (linear resampling if needed)."""
    audio, sr = sf.read(io.BytesIO(data), dtype="float32", always_2d=True)
    audio = audio.mean(axis=1)
    if sr != STT_RATE and audio.size:
        n = int(round(audio.size * STT_RATE / sr))
        audio = np.interp(np.linspace(0, audio.size - 1, n), np.arange(audio.size), audio).astype(np.float32)
    return audio


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
                return self._json(
                    200,
                    {
                        "ok": True,
                        "voice": voice.name,
                        "ready": voice.model is not None,
                        "tts": voice.enabled,
                        "stt": voice.stt_ready,
                    },
                )
            self._json(404, {"error": "not found"})

        def do_POST(self):
            if not self._cors():
                return
            route = urlparse(self.path).path
            if route == "/transcribe":
                return self._transcribe()
            if route != "/speak":
                return self._json(404, {"error": "not found"})
            if not voice.enabled:
                return self._json(503, {"error": "no reference recording: speaking is off"})
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

        def _transcribe(self):
            if not voice.stt_ready:
                return self._json(503, {"error": "transcription not ready"})
            length = int(self.headers.get("Content-Length", "0"))
            if length <= 0 or length > MAX_AUDIO_BYTES:
                return self._json(400, {"error": "send a WAV body up to ~30 s"})
            try:
                audio = decode_wav(self.rfile.read(length))
            except Exception:  # noqa: BLE001 - unreadable upload
                return self._json(400, {"error": "not a readable WAV"})
            if audio.size < STT_RATE // 4:
                return self._json(200, {"text": "", "language": None})
            t = time.time()
            try:
                result = voice.transcribe(audio)
            except Exception as err:  # noqa: BLE001
                print(f"  ✖ transcription failed: {err}")
                return self._json(500, {"error": "transcription failed"})
            print(f"  [{time.time() - t:4.1f}s] heard: {result['text']!r} ({result['language']})")
            self._json(200, result)

    return Handler


def main():
    global STEPS, METHOD
    ap = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    ap.add_argument("--port", type=int, default=3003)
    ap.add_argument("--voice", type=Path, default=HERE / "my-voice")
    ap.add_argument("--steps", type=int, default=STEPS, help=f"sampling steps (default {STEPS})")
    ap.add_argument("--method", choices=["euler", "midpoint", "rk4"], default=METHOD, help=f"sampler (default {METHOD})")
    ap.add_argument("--no-stt", action="store_true", help="don't load the speech recognition model")
    args = ap.parse_args()
    STEPS, METHOD = args.steps, args.method

    voice = Voice(args.voice.resolve(), stt=not args.no_stt)
    cache = HERE / "cache"
    cache.mkdir(exist_ok=True)

    threading.Thread(target=voice.run_worker, args=(WARMUP, cache), daemon=True).start()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), make_handler(voice, cache))
    print(f"\n  🎙  ClawdDesk voice lab  http://127.0.0.1:{args.port}   voice: {voice.name or 'off'}\n")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
