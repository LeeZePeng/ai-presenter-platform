#!/bin/bash
set -euo pipefail

source /root/miniconda3/etc/profile.d/conda.sh
conda activate comfyui
cd /root/ComfyUI

worker_pids=()
cleanup() {
  if ((${#worker_pids[@]})); then
    kill "${worker_pids[@]}" 2>/dev/null || true
    wait "${worker_pids[@]}" 2>/dev/null || true
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

# Keep port 7860 as a compatibility alias, but route it to the clean ComfyUI
# API workers. Digital-human jobs submit directly through the ComfyUI API.
python /root/ComfyUI/path_router.py --port 7860 --worker-ports 18188 18189 18190 18191 \
  > /root/ComfyUI/gradio-router.log 2>&1 &
worker_pids+=("$!")
python /root/ComfyUI/path_router.py --port 8188 --worker-ports 18188 18189 18190 18191 \
  > /root/ComfyUI/comfy-router.log 2>&1 &
worker_pids+=("$!")

wait -n "${worker_pids[@]}"
