#!/bin/bash
set -euo pipefail

source /root/miniconda3/etc/profile.d/conda.sh
conda activate comfyui
cd /root/ComfyUI

worker_pids=()
auxiliary_pids=()
cleanup() {
  if ((${#worker_pids[@]})); then
    kill "${worker_pids[@]}" 2>/dev/null || true
    wait "${worker_pids[@]}" 2>/dev/null || true
  fi
  if ((${#auxiliary_pids[@]})); then
    kill "${auxiliary_pids[@]}" 2>/dev/null || true
    wait "${auxiliary_pids[@]}" 2>/dev/null || true
  fi
}
trap cleanup EXIT INT TERM

start_worker() {
  local gpu_index="$1"
  local comfy_port="$2"
  CUDA_VISIBLE_DEVICES="$gpu_index" \
    python main.py --listen 127.0.0.1 --port "$comfy_port" \
      >"/root/ComfyUI/worker-${gpu_index}.log" 2>&1 &
  worker_pids+=("$!")
}

start_worker 0 18188
start_worker 1 18189
start_worker 2 18190
start_worker 3 18191

# Qwen is optional and deliberately not part of the critical worker PID set:
# a TTS failure must never terminate all four InfiniteTalk workers.
if [[ -x /root/qwen-tts-service/start.sh && -f /root/qwen-tts-service/runtime.env ]]; then
  set -a
  # shellcheck disable=SC1091
  source /root/qwen-tts-service/runtime.env
  set +a
  /root/qwen-tts-service/start.sh > /root/qwen-tts-service/service.log 2>&1 &
  auxiliary_pids+=("$!")
fi

# Keep port 7860 as a compatibility alias, but route it to the clean ComfyUI
# API workers. Digital-human jobs submit directly through the ComfyUI API.
python /root/ComfyUI/path_router.py --port 7860 --worker-ports 18188 18189 18190 18191 --qwen-tts-port 18787 \
  > /root/ComfyUI/gradio-router.log 2>&1 &
worker_pids+=("$!")
python /root/ComfyUI/path_router.py --port 8188 --worker-ports 18188 18189 18190 18191 --qwen-tts-port 18787 \
  > /root/ComfyUI/comfy-router.log 2>&1 &
worker_pids+=("$!")

wait -n "${worker_pids[@]}"
