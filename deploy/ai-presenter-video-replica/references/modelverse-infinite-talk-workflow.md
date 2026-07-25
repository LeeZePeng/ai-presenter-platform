# ModelVerse MiniMax/IndexTTS-2 + InfiniteTalk Workflow

Use this reference when the user wants API-based Chinese narration and digital-human video generation without local TTS/GPU setup.

## MiniMax Speech 2.8 HD

For the best built-in Chinese voice quality, use `speech-2.8-hd` through `scripts/modelverse_minimax_speech.py`. The production defaults are a premium Chinese female voice (`female-yujie-jingpin`), 44.1 kHz mono MP3, 256 kbps, calm delivery, and restrained magnetic voice modifiers.

```bash
scripts/modelverse_minimax_speech.py \
  --text "大家好，我是刚刚诞生的虚拟人。" \
  --output out/narration.mp3 \
  --metadata out/narration.json
```

Convert the result to the sample rate expected by the downstream lip-sync service instead of asking the TTS API for a lower-quality master.

## Secrets

Use `MODELVERSE_API_KEY` from the environment for ModelVerse calls. Never write keys into skill files, generated projects, logs, or committed `.env` files.

```bash
export MODELVERSE_API_KEY="<your-modelverse-api-key>"
scripts/modelverse_indextts.py list-voices
```

If the user pasted a key in chat, avoid echoing it and recommend key rotation after the run.

## IndexTTS-2 Custom Voice

Reference audio constraints from ModelVerse docs: use MP3/WAV under 20 MB. In practice, 5-30 seconds of clean speech works best.

Prepare a short voice reference from an input video:

```bash
ffmpeg -y -ss 20 -t 12 -i source.mp4 \
  -vn -ac 1 -ar 24000 \
  -af "loudnorm=I=-18:TP=-1.5:LRA=11" \
  out/ref_12s.wav
```

One-shot upload + TTS:

```bash
scripts/modelverse_indextts.py one-shot \
  --speaker-file out/ref_12s.wav \
  --text "你好，这是一段使用 IndexTTS 二和自定义音色生成的测试音频。" \
  --output out/narration.wav \
  --voice-json out/modelverse_voice.json
```

Observed from a 12.6s Chinese test: voice upload about 1.2s, TTS about 5.6s. The response header may say `audio/mpeg`, but the body can still be RIFF/WAV; verify with `ffprobe`.

## InfiniteTalk Digital Human API

The Gradio app used in testing:

- Gradio server: `http://106.75.239.93:7860`
- ComfyUI server: `http://106.75.239.93:8188`
- Main submit endpoint: `/gradio_api/run/add_to_queue_wrapper`
- Status endpoint: `/gradio_api/run/check_and_get_video`
- ComfyUI history endpoint: `/history/<prompt_id>`
- ComfyUI video download endpoint: `/view?filename=<name>&subfolder=&type=output`

Do not depend on `gradio_client`: package install can fail in constrained environments, and direct HTTP works with no extra dependency.

### Prepare Small Assets

Keep the first API test small to avoid OOM:

```bash
scripts/infinite_talk_api.py prepare-assets \
  --source-video source.mp4 \
  --duration 10 \
  --ref-width 480 \
  --ref-height 832 \
  --output-dir out/infinite_talk
```

For a still avatar, generate the required reference MP4 directly from the image:

```bash
scripts/infinite_talk_api.py prepare-assets \
  --source-image avatar.jpg \
  --duration 5 \
  --ref-width 832 \
  --ref-height 480 \
  --output-dir out/infinite_talk/assets
```

This creates:

- `person_ref.png`
- `ref_vid_10s_480x832.mp4`

### Submit With OOM-Safe Defaults

Use defaults first:

```bash
scripts/infinite_talk_api.py submit \
  --person-img out/infinite_talk/person_ref.png \
  --ref-video out/infinite_talk/ref_vid_10s_480x832.mp4 \
  --audio1 out/narration.wav \
  --output-dir out/infinite_talk/outputs
```

Default resource-sensitive parameters:

- `width=480`, `height=832`
- `steps=4`
- `blocks_to_swap=0` on the hosted single-person 48 GB GPU profile after measuring only 23.8/48 GB at 10; use 10, 20, or 40 only as explicit lower-VRAM fallbacks
- `frame_size=81`（48 GB 生产默认；显存不足时回退到 61）
- `hd_enabled=false`
- `fps=25`
- `cam_ctrl=true`
- `pose_stabilize=true`
- `audio2_mode=none`
- `poll_seconds=10`
- `max_polls=240` so a shorter poll interval does not shorten the total wait window

Keep API HD disabled for small presenter PIP. For `真人主画面·悬浮组件`, enable the API's native upscale with `--hd-enabled --hd-res 720`; 832x480 becomes 1248x720, 480x832 becomes 720x1248, and 640x640 becomes 720x720. Use a separate `infinite_talk-hd720` checkpoint directory and require the HD configuration and output dimensions to match before reusing any segment.

Use `--audio2-mode same` only if the server rejects `audio2=None`. Passing the same file to `audio1` and `audio2` works, but it triggers dual-person/Multi mode and can increase cost and resource use. In a 12.6s test with `audio2=same`, the service switched to `Wan2_1-InfiniteTalk_Multi_Q8.gguf`; it completed but took about 12 minutes.

### Long Audio: Segmented and Resumable

Do not send narration longer than 20 seconds through one `submit`. Long requests retain too much system memory and can crash Gradio/ComfyUI near the end, losing the entire render. First plan only the cues where a presenter will be visible, then use resumable checkpoints:

```bash
scripts/infinite_talk_api.py segmented-submit \
  --server http://106.75.239.93:7860 \
  --comfy-server http://106.75.239.93:8188 \
  --person-img out/infinite_talk/assets/person_ref.png \
  --ref-video out/infinite_talk/assets/ref_vid_5s_832x480.mp4 \
  --audio out/final_narration.wav \
  --segment-plan out/analysis/presenter_plan.json \
  --segments-only \
  --checkpoint-dir out/checkpoints/infinite_talk \
  --width 832 --height 480 \
  --hd-enabled --hd-res 720 \
  --steps 4 --blocks-to-swap 0 --frame-size 81 \
  --segment-seconds 19.5 --max-segment-seconds 20 --poll-seconds 10 --max-polls 240
```

Create `out/analysis/presenter_plan.json` with `plan_selective_presenter.py` before the command. The helper validates that every requested interval is non-overlapping and at most 20 seconds. Repeat `--worker SERVER_URL,COMFY_URL` for each healthy GPU endpoint to process independent intervals concurrently. A pending prompt stays pinned to its original worker, while completed checkpoints are reused. Each segment directory contains its audio slice, downloaded MP4, and original `result.json`; `segments.json` records the exact sparse plan, plan hash, worker assignment, and completed paths.

Retry with exactly the same command, presenter plan, and checkpoint directory. Valid segments are skipped, including checkpoints copied to a new job workspace. After normalization/upscale, use `prepare_selective_presenter_track.py` to place the generated clips at their original narration timestamps and insert black gaps for evidence intervals. Remotion mounts that track once and uses `presenterVisibleRanges` for visibility.

For final validation, expose these fields in the job result manifest:

```json
{
  "presenterProvider": "InfiniteTalk",
  "presenterSourcePath": "out/checkpoints/infinite_talk/presenter.mp4",
  "presenterSegmentPaths": [".../segment-001/InfiniteTalk_00001-audio.mp4"],
  "infiniteTalkReceiptPaths": [".../segment-001/result.json"]
}
```

### Result Retrieval

The Gradio gallery may return only `{"__type__": "update"}` even when generation succeeds. Parse the logs for `Prompt ID`, then fetch ComfyUI history:

```bash
curl http://106.75.239.93:8188/history/<prompt_id>
```

Find output node `gifs`/`videos`, then download via `/view`. The helper does this automatically.
The submit command writes `result.json` beside its downloaded outputs and exits nonzero when no video is returned. Treat that as a hard job failure; never replace it with a still-image animation.

Observed successful output node:

```json
{
  "gifs": [{
    "filename": "InfiniteTalk_00002-audio.mp4",
    "subfolder": "",
    "type": "output",
    "format": "video/h264-mp4",
    "frame_rate": 25.0
  }]
}
```

## Validation

Run:

```bash
ffprobe -v error \
  -show_entries format=duration,size,bit_rate \
  -show_entries stream=index,codec_type,codec_name,width,height,r_frame_rate,duration,bit_rate,sample_rate,channels \
  -of json out/infinite_talk/outputs/InfiniteTalk_*.mp4

ffmpeg -v error -i out/infinite_talk/outputs/InfiniteTalk_00002-audio.mp4 -f null -
ffmpeg -hide_banner -i out/infinite_talk/outputs/InfiniteTalk_00002-audio.mp4 \
  -af volumedetect -vn -sn -dn -f null - 2>&1 | tail -n 20
```

Known successful 12.6s test output:

- `480x832`, `25fps`, H.264
- AAC mono audio at `22050Hz`
- peak observed GPU memory around 10 GB on a 48 GB GPU
- peak observed system memory around 62 GB
