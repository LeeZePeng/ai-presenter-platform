#!/usr/bin/env bash
set -euo pipefail

SERVICE_DIR="${QWEN_TTS_SERVICE_DIR:-/root/qwen-tts-service}"
MODEL_DIR="${QWEN_TTS_MODEL_PATH:-/root/models/Qwen3-TTS-12Hz-1.7B-Base}"
ENV_NAME="${QWEN_TTS_CONDA_ENV:-qwen3-tts}"

if ! command -v conda >/dev/null 2>&1; then
  echo 'conda is required on the GPU image' >&2
  exit 1
fi
if [[ ! -f "$SERVICE_DIR/requirements.txt" || ! -f "$SERVICE_DIR/app.py" ]]; then
  echo "Service files are missing from $SERVICE_DIR" >&2
  exit 1
fi

if ! conda env list | awk '{print $1}' | grep -Fxq "$ENV_NAME"; then
  conda create -n "$ENV_NAME" python=3.12 -y
fi
conda run -n "$ENV_NAME" python -m pip install --upgrade pip
conda run -n "$ENV_NAME" python -m pip install -r "$SERVICE_DIR/requirements.txt"

if [[ ! -f "$MODEL_DIR/config.json" ]]; then
  mkdir -p "$MODEL_DIR"
  conda run -n "$ENV_NAME" modelscope download \
    --model Qwen/Qwen3-TTS-12Hz-1.7B-Base \
    --local_dir "$MODEL_DIR"
fi

conda run -n "$ENV_NAME" python -c 'from qwen_tts import Qwen3TTSModel; print("qwen-tts import ok")'
echo "Qwen TTS installed in conda env $ENV_NAME; model: $MODEL_DIR"
