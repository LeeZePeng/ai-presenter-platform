# Qwen3-TTS reference-voice service

This private FastAPI service runs `Qwen/Qwen3-TTS-12Hz-1.7B-Base` on one GPU and exposes authenticated reference-voice cloning to the presenter platform.

- It binds only to `127.0.0.1:18787`.
- The existing GPU path router should proxy `/qwen-tts/v1/*` to `http://127.0.0.1:18787/v1/*`.
- Both the Mac platform and this service read the same `QWEN_TTS_API_TOKEN`; the token is never passed in a Codex prompt or command line.
- GPU index defaults to `3`, leaving the other workers available to InfiniteTalk. Change `QWEN_TTS_GPU_INDEX` only after checking allocation.

Copy this directory to `/root/qwen-tts-service`, run `install.sh`, and create a mode-`0600` `/root/qwen-tts-service/runtime.env` containing `QWEN_TTS_API_TOKEN`. The repository's `start-multi-gpu.sh` starts it as a non-critical auxiliary process and the path router strips `/qwen-tts` before forwarding. Do not open port `18787` to the public Internet.
