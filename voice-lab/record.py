"""Record the reference clip the voice lab clones: your voice reading one sentence.

    voice-lab/.venv/bin/python voice-lab/record.py [--out voice-lab/my-voice] [--seconds 12]

Writes reference.wav (24 kHz mono) and reference.txt into the output folder. macOS will ask once for
microphone access for your terminal app. Tips: quiet room, normal distance from the mic, read calmly
and clearly in the tone you want JARVIS to have. Re-run to try again; the last take wins.
"""

from __future__ import annotations

import argparse
import time
from pathlib import Path

import numpy as np
import sounddevice as sd
import soundfile as sf

SAMPLE_RATE = 24_000
HERE = Path(__file__).resolve().parent
SENTENCE = (
    "Good evening. All systems are online and running normally. "
    "I have finished the analysis, and the results are ready whenever you are."
)


def trim(audio: np.ndarray, threshold: float = 0.02, pad: int = SAMPLE_RATE // 5) -> np.ndarray:
    """Cut leading/trailing silence, keeping a little padding."""
    loud = np.flatnonzero(np.abs(audio) > threshold)
    if loud.size == 0:
        return audio
    return audio[max(0, loud[0] - pad) : min(audio.size, loud[-1] + pad)]


def main():
    ap = argparse.ArgumentParser(description="Record a voice-lab reference clip.")
    ap.add_argument("--out", type=Path, default=HERE / "my-voice")
    ap.add_argument("--seconds", type=float, default=12.0)
    ap.add_argument("--text", default=SENTENCE, help="sentence to read (saved as reference.txt)")
    args = ap.parse_args()

    print("\n  Read this out loud, calmly and clearly:\n")
    print(f"    “{args.text}”\n")
    for n in (3, 2, 1):
        print(f"  recording in {n}…", end="\r", flush=True)
        time.sleep(1)
    print(f"  ● recording for {args.seconds:.0f}s — speak now      ")
    audio = sd.rec(int(args.seconds * SAMPLE_RATE), samplerate=SAMPLE_RATE, channels=1, dtype="float32")
    sd.wait()
    audio = trim(audio[:, 0])

    peak = float(np.max(np.abs(audio))) if audio.size else 0.0
    seconds = audio.size / SAMPLE_RATE
    if peak < 0.05 or seconds < 3:
        raise SystemExit("\n  ✖ That was too quiet or too short. Check the mic (and macOS mic permission) and try again.\n")
    if peak > 0.99:
        print("  ! It clipped (too loud). Consider moving back a little and recording again.")
    audio = audio / peak * 0.9  # normalize

    args.out.mkdir(parents=True, exist_ok=True)
    sf.write(args.out / "reference.wav", audio, SAMPLE_RATE, subtype="PCM_16")
    (args.out / "reference.txt").write_text(args.text + "\n", encoding="utf-8")
    print(f"\n  ✓ saved {seconds:.1f}s to {args.out}/reference.wav")
    print("    next: voice-lab/.venv/bin/python voice-lab/server.py\n")


if __name__ == "__main__":
    main()
