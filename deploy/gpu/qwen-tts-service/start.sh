#!/usr/bin/env bash
set -euo pipefail

SERVICE_DIR="${QWEN_TTS_SERVICE_DIR:-/root/qwen-tts-service}"
ENV_NAME="${QWEN_TTS_CONDA_ENV:-qwen3-tts}"
export QWEN_TTS_MODEL_PATH="${QWEN_TTS_MODEL_PATH:-/root/models/Qwen3-TTS-12Hz-1.7B-Base}"
export QWEN_TTS_DEVICE="${QWEN_TTS_DEVICE:-cuda:0}"
export CUDA_VISIBLE_DEVICES="${QWEN_TTS_GPU_INDEX:-3}"

if [[ -z "${QWEN_TTS_API_TOKEN:-}" ]]; then
  echo 'QWEN_TTS_API_TOKEN is required' >&2
  exit 1
fi

cd "$SERVICE_DIR"
exec conda run --no-capture-output -n "$ENV_NAME" \
  uvicorn app:app --host 127.0.0.1 --port "${QWEN_TTS_PORT:-18787}" --workers 1
