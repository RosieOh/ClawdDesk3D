#!/usr/bin/env bash
# One-time setup for the voice lab: a private Python 3.12 environment with F5-TTS (MLX) in voice-lab/.venv.
# Apple Silicon only (MLX). The model (~1.3 GB) downloads on first start of server.py.
set -euo pipefail
cd "$(dirname "$0")"

if [[ "$(uname -s)-$(uname -m)" != "Darwin-arm64" ]]; then
  echo "The voice lab needs an Apple Silicon Mac (MLX)." >&2
  exit 1
fi

UV="$(command -v uv || true)"
if [[ -z "$UV" ]]; then
  echo "→ installing uv (Python package manager) for this user"
  python3 -m pip install --user --quiet uv
  UV="$(python3 -c 'import sysconfig; print(sysconfig.get_path("scripts", "posix_user"))')/uv"
fi

echo "→ creating voice-lab/.venv (Python 3.12)"
"$UV" venv --quiet --python 3.12 .venv
echo "→ installing requirements"
"$UV" pip install --quiet --python .venv/bin/python -r requirements.txt
echo "✓ ready. Next: npm run voice:record, then npm run voice:serve"
