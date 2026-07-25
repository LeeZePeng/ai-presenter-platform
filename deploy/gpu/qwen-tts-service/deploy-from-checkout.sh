#!/usr/bin/env bash
set -euo pipefail

CHECKOUT_DIR="${1:-/root/ai-presenter-platform}"
SERVICE_DIR="/root/qwen-tts-service"
COMFY_DIR="/root/ComfyUI"

if [[ ! -f "$CHECKOUT_DIR/deploy/gpu/qwen-tts-service/app.py" ]]; then
  echo "AI presenter checkout is missing: $CHECKOUT_DIR" >&2
  exit 1
fi
if [[ ! -d "$COMFY_DIR" ]]; then
  echo "ComfyUI directory is missing: $COMFY_DIR" >&2
  exit 1
fi

install -d -m 700 "$SERVICE_DIR"
install -m 600 "$CHECKOUT_DIR/deploy/gpu/qwen-tts-service/app.py" "$SERVICE_DIR/app.py"
install -m 600 "$CHECKOUT_DIR/deploy/gpu/qwen-tts-service/requirements.txt" "$SERVICE_DIR/requirements.txt"
install -m 600 "$CHECKOUT_DIR/deploy/gpu/qwen-tts-service/README.md" "$SERVICE_DIR/README.md"
install -m 700 "$CHECKOUT_DIR/deploy/gpu/qwen-tts-service/install.sh" "$SERVICE_DIR/install.sh"
install -m 700 "$CHECKOUT_DIR/deploy/gpu/qwen-tts-service/start.sh" "$SERVICE_DIR/start.sh"
install -m 700 "$CHECKOUT_DIR/deploy/gpu/path_router.py" "$COMFY_DIR/path_router.py"
install -m 700 "$CHECKOUT_DIR/deploy/gpu/start-multi-gpu.sh" "$COMFY_DIR/start-multi-gpu.sh"

"$SERVICE_DIR/install.sh"

echo 'Qwen service files and model are installed.'
if [[ ! -f "$SERVICE_DIR/runtime.env" ]]; then
  echo 'Create /root/qwen-tts-service/runtime.env with mode 0600 before restarting the GPU stack.'
else
  chmod 600 "$SERVICE_DIR/runtime.env"
  echo 'runtime.env exists. Restart the GPU stack only after active presenter jobs are idle.'
fi
