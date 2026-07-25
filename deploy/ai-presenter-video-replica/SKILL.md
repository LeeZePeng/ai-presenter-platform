---
name: ai-presenter-video-replica
description: Create reusable AI presenter replica videos from input MP4 files. Use when the user asks to "复刻视频", "AI口播", "数字人讲解", "输入 mp4 输出口播视频", "加字幕/卡片/特效/圆形人像 PIP", or otherwise wants Codex to analyze a source MP4 and produce a polished Remotion talking-head explainer video with synchronized narration, source-matched visual direction, captions, motion cards, and quality-checked export.
---

# AI Presenter Video Replica

## Goal

Turn a source MP4 into a polished AI presenter replica video: extract the topic and structure, rebuild the visual language in Remotion, generate or preserve narration, create a real lip-synced presenter/PIP when requested, and deliver a verified MP4.

Quality is the primary optimization target. Judge quality by whether a viewer can understand and trust the story, especially whether the actual demonstration remains visible. Do not optimize for the number of cards, scene keys, overlays, review frames, or animation events. Speed and GPU efficiency may be tuned only when they do not reduce narration fidelity, caption completeness, presenter quality, demonstration fidelity, or source-style fidelity.

Use the bundled scripts for repeatable media inspection, contact sheets, long-form narration, final-audio timestamps, InfiniteTalk digital-human generation, and sync checks. Read `references/replica-fidelity.md` and `references/remotion-visual-quality.md` before every clone composition. Read `references/remotion-heygen-workflow.md` for Remotion/HeyGen jobs and `references/modelverse-infinite-talk-workflow.md` for ModelVerse/InfiniteTalk API jobs.

## Secrets

Prefer `HEYGEN_API_KEY` from the environment for HeyGen calls. Never write API keys into skill files, project source, logs, or committed `.env` files. If `HEYGEN_API_KEY` is unavailable, fall back to HeyGen CLI/OAuth only after telling the user that API-key automation is not configured.

Prefer `MODELVERSE_API_KEY` from the environment for ModelVerse MiniMax Speech and IndexTTS-2 calls. Never write ModelVerse keys into skill files, project source, logs, or committed `.env` files. If the key is missing, guide the user to export it.

When HeyGen is needed, run `scripts/heygen_api.py me` before media upload. If the key is missing, stop before credit-spending work and guide the user with one concise message in their language:

```bash
需要 HeyGen API key 才能生成真实对口型人像。请在当前终端执行：
export HEYGEN_API_KEY="<your-heygen-api-key>"
然后告诉我“已设置”，我会先运行 scripts/heygen_api.py me 验证。
```

If a user asks how to fill the key, run `scripts/heygen_api.py setup-key` or show the same `export` command. If a user pastes an API key in chat, do not echo it back or store it; use it only as an ephemeral environment variable for the current command when necessary, and recommend rotating the key afterward.

## Workflow

1. **Set up a project**
   - Create a dedicated working folder for each job.
   - Copy the input MP4 into `public/source.mp4`; do not edit the original.
   - Run `scripts/media_report.py public/source.mp4` and save the JSON.
   - Run `scripts/contact_sheet.sh public/source.mp4 out/source_contact.jpg`.

2. **Analyze the source**
   - Identify aspect ratio, duration, scenes, key UI/text, visual style, presenter framing, subtitles, and audio language.
   - Extract and inspect at least ten representative source frames covering the opening, ending, every major chapter/PPT state, transitions, and presenter placement. Four-frame montages are not sufficient evidence.
   - Extract or transcribe the narration. If reliable ASR is unavailable, ask for the script instead of inventing precise transcript content.
   - Audit every selected source interval for viewer-facing evidence before planning visuals. Write top-level `sourceEvidenceInventory` in `out/analysis/narration_visual_map.json`; each entry records source timestamps, kind, description, whether the original demonstration should be preserved, and mapped cue indices. Treat software demos, generated results, before/after comparisons, data visualizations, product interaction, and visually judged output as evidence even when the narration describes appearance or capability rather than motion. Never replace a useful demonstration with an abstract card merely because the claim can be paraphrased as text.
   - Lock the requested replica mode before writing. `exact` preserves all substantive content, order, and scene progression. `condensed` targets any requested duration at or above the platform's technical minimum: preserve the core topic, key arguments, a complete opening hook, a complete closing statement, and the source order of retained points; actively drop secondary points, optional steps, examples, expanded evidence, comparison details, tangents, and repetition as needed. Never fail a condensed job merely because every source point cannot fit. Both modes replicate the source visual language and phrase-triggered PPT states for the content they retain.

3. **Build narration and captions**
   - Keep the final script semantically aligned with the source unless the user asks for rewrite.
   - For Douyin/WeChat short-form Chinese narration generated by the platform, write and synthesize for a natural brisk delivery: roughly 6-7 meaningful Chinese characters per second, short clauses, and about 0.15-0.35 seconds between sentences. Remove filler, duplicated setup, and formal transitions before TTS. Set pace and punctuation in the TTS request before locking audio; never speed up a finished narration with time stretching. Exact replica mode may follow the source cadence when fidelity matters more than short-form pace.
   - Give every generated script a complete spoken closing, even when compressing aggressively: the final paragraph must recover the conclusion and end with a concrete action, next step, or natural sign-off. Do not stop on the last informational bullet as if the recording were cut off.
   - Never manufacture engagement bait. Unless the user explicitly supplies and insists on such copy, reject closing requests for likes, follows, saves, shares, comments, DMs, keyword replies, or “一键三连”. A genuine action belongs in the subject matter (for example, build the first Agent and evaluate it), not in platform engagement metrics.
   - Before any TTS or presenter request, run `python3 scripts/validate_narration_script.py --input out/audio/final_script.txt`. Fix every error first. Run it again during final validation so a later rewrite cannot drop or contaminate the closing.
   - When the user supplies a complete narration MP3/WAV, use it directly without TTS, time stretching, or speed changes. Probe its exact duration and make the presenter and final MP4 match it; hosted platform narration uploads are limited to 180 seconds.
   - For highest-quality built-in Chinese narration, use `scripts/modelverse_minimax_speech.py` with `speech-2.8-hd`; its production defaults use a premium Chinese female voice and high-quality audio settings.
   - For API-based Chinese voice cloning, use `scripts/modelverse_indextts.py` with 5-30 seconds of clean reference speech. Verify output audio with `ffprobe`; response headers may not always match the real WAV container.
   - For long exact narration, use `scripts/long_form_tts.py`; it chunks at sentence boundaries, resumes completed chunks, normalizes them, and creates one locked WAV.
   - After locking narration, run `scripts/transcribe_timeline.py` against the actual final audio. Use ASR only for timing. Treat `out/audio/final_script.txt` as the caption text authority and correct obvious ASR homophones, product names, punctuation, and broken clauses against that locked script.
   - Before paid lip-sync, listen to or inspect the first 15 seconds and measure the generated narration duration against the script length. If a short-form read sounds slow, regenerate TTS with tighter punctuation and a modestly faster provider setting; do not compensate with more visual cards or by accelerating the final WAV afterward.
   - Write `out/analysis/caption_timeline.json` with phrase-level `startSeconds`, `endSeconds`, and corrected `text`. Its concatenated text must cover at least 95% of the locked final script in both directions, cover the whole narration, keep normal captions at 1.2-4.5 seconds, and never exceed 6 seconds or two rendered lines.
   - Cue headings, scene labels, chapter names, keywords, and marketing summaries are not captions. Never render a 3-8 second cue summary in place of the words currently being spoken.
   - Internal production vocabulary is never viewer-facing copy. Do not render labels such as “原生图解”, “数字人口播”, “动态证据”, “source-video-pip”, “native diagram”, cue indices, review status, or production method names in the delivered frame; use a source-grounded content title or no label.
   - Bind the exact caption timeline into Remotion and mark the rendered container `data-caption-layer="narration-timeline"`.
   - For clone jobs, write `out/analysis/narration_visual_map.json` immediately after the final-audio timeline, then run `scripts/validate_narration_visual_map.py --map out/analysis/narration_visual_map.json --duration <final-audio-seconds>`. Fix every failure before any paid presenter request or Remotion render.
   - Generate timestamped captions from the actual final audio, not from an approximate draft.
   - For Chinese videos, keep captions short enough for two lines and avoid blocking PIP.

4. **Create the presenter**
   - A presenter video must contain real generated lip motion. Never substitute a still-image loop, zoom/pan, mask, silent person, or simulated mouth animation.
   - In the hosted AI presenter platform, InfiniteTalk is mandatory. If InfiniteTalk fails or returns no video, fail the job; do not create a fallback MP4.
   - Use a user-provided or user-approved Chinese/user-like reference when requested. Avoid stock/public avatars if the user expects their own identity.
   - For single-person InfiniteTalk jobs on the hosted 48 GB GPU, use `scripts/infinite_talk_api.py` with `steps=4`, `blocks_to_swap=0`, `frame_size=81`, `poll_seconds=10`, and `max_polls=240`. Use 480x832 for portrait/PIP presenters, 640x640 for square presenter-primary output, and 832x480 for a 16:9 `真人主画面·悬浮组件` presenter. Keep `hd_enabled=false` for every style so expensive lip-sync checkpoints are never coupled to an optional upscale. For presenter-primary output, run `scripts/upscale_presenter_segments.py` afterward with the required final geometry and preserve its chunk checkpoints. The measured production profile used 24.7/48 GB at `frame_size=61`, leaving enough headroom for an 81-frame window; use `frame_size=61` and then `blocks_to_swap=10` as the OOM fallbacks. A presenter intended for a circular PIP stays portrait even when the final composition is 16:9; the 832x480 exception applies only when the selected presenter-primary style explicitly needs a landscape person canvas.
   - Probe the final narration before requesting GPU generation. For audio longer than 20 seconds, use `segmented-submit` with `segment_seconds=19.5`, `min_segment_seconds=8`, and `max_segment_seconds=20`; it selects silence-adjacent boundaries, saves each MP4/receipt as a checkpoint, and stitches the segments against the untouched final narration. Keep segments serial and never exceed 20 seconds in this hosted workflow.
   - Put segmented checkpoints under the job's durable `out/checkpoints/infinite_talk` directory. On retry, rerun the same command against that directory so valid completed segments are skipped. Never delete successful segment receipts and never submit segments in parallel.
   - For a still avatar, run `prepare-assets --source-image <avatar>` to create the required reference MP4. For a source video, use `prepare-assets --source-video <video>`.
   - After generation, run `scripts/normalize_presenter_segments.py` on every raw InfiniteTalk segment. It removes black bars and creates silent, consistent `presenterRenderPaths` while preserving raw videos and receipts. Use its default square layout for circular/rounded PIP compositions. For the `真人主画面·悬浮组件` style, normalize to the resolved final aspect direction and dimensions. Never stretch, mix orientations, or feed raw segments directly into Remotion. After normalization/upscale, run `scripts/prepare_presenter_track.py` to stream-copy compatible segments into `remotion/public/presenter/presenter-track.mp4` and write `out/analysis/presenter_track_manifest.json`. Remotion must mount this one continuous presenter video once; it must not create one decoder per InfiniteTalk segment.
   - For single-person InfiniteTalk jobs, submit `audio2=None` first. Passing the same file as `audio1` and `audio2` can force dual-person/Multi mode and increase resource usage; only retry with `--audio2-mode same` if the API rejects `audio2=None`.
   - If Gradio status says generation succeeded but the gallery is empty, fetch the result from ComfyUI `/history/<prompt_id>` and `/view`; do not assume failure.
   - For HeyGen lipsync, prepare a source video with a clearly visible speaker and a valid audible audio track. If the visual reference is silent, use `scripts/prepare_lipsync_source.sh` to mux the final narration into the reference video before upload.
   - Prefer `scripts/heygen_api.py` for asset upload, lipsync creation, polling, and download. It reads `HEYGEN_API_KEY` and uses direct v3 API calls.
   - Run `scripts/heygen_api.py me` before uploading assets when `HEYGEN_API_KEY` is set, so auth/billing failures surface before credits are spent.
   - Submit a short preview before expensive full-duration generation when identity, framing, or credits are uncertain.

5. **Compose in Remotion**
   - Read the installed Remotion skill and `references/remotion-visual-quality.md` before editing Remotion code.
   - Before JSX, write `out/analysis/visual_design.json` from the source contact sheet. It must define palette, typography, presenter geometry, subtitle treatment, motion rhythm, safe regions, source-specific signatures, and explicit anti-patterns.
   - Before JSX, render a cheap storyboard montage from the cue plan and compare it with the source frames. Use it to catch a swallowed demonstration or a generic template before rendering; do not treat the storyboard as an artifact quota.
   - Reproduce the source's visual language instead of adding a generic dashboard skin. This applies equally to exact and condensed clones: condensed changes duration, never visual fidelity. Persistent top bars, bottom information bands, chapter pills, metric panels, or decorative chrome are forbidden unless the source actually uses them.
   - Preserve demonstrations before rebuilding them. On the hosted Remotion v4 runtime, import `Video` from `@remotion/media`; if it reports `Code 4` or `DEMUXER_ERROR_COULD_NOT_OPEN`, switch that layer to Remotion `OffthreadVideo`. A static screenshot is allowed only when the source evidence itself is static and the relevant text remains readable; contact sheets and review montages are never delivery assets.
   - Use the original muted source interval whenever the viewer needs to see what was tested or produced: software demos, generated webpages or videos, model comparisons, before/after states, interactive graphics, real-device operation, product behavior, field footage, or any visible result being judged. Motion does not have to be the wording of the claim; showing the result can still be the proof. During these cues, the demonstration is the primary visual. The InfiniteTalk presenter may shrink to a corner, move outside the evidence, or hide completely. Cards and diagrams may annotate the demonstration but may not replace it.
   - Mark each evidence cue `visualType: "source_video_pip"` and add `sourceVideoEvidence` with `clipStartSeconds`, `clipEndSeconds`, `evidencePurpose`, `audioMuted: true`, `playbackRate: 1`, and `presenterTreatment`. Copy the same contract into `scene_implementation.json`, plus `sourceAsset: "source/sourceVideo.mp4"` and `layerMarker: "source-video-pip"`; include the literal `source-video-pip` in `implementedElements`. A planned evidence cue without this exact implementation contract is a deterministic failure.
   - Make evidence large enough to understand at normal phone playback. Prefer a full-bleed or dominant detail stage rather than a small decorative PIP. Preserve source aspect ratio, natural playback speed, the complete relevant action, and readable labels. Crop browser chrome, old presenters, subtitles, and watermarks when possible; if clean separation is impossible, rebuild only the conflicting chrome while keeping the actual demonstration visible. Do not cover evidence with titles, gradients, badges, captions, or the presenter.
   - Write `out/analysis/narration_visual_map.json` according to `references/replica-fidelity.md` before JSX. Use 3-8 second phrase-level cues and trigger numbered PPT states on the corresponding spoken phrase. InfiniteTalk segment boundaries are forbidden as visual boundaries.
   - Treat every spoken quantity as a semantic contract. When a cue says “五个模块 / 三件事 / 三块积木 / 四种模式 / N 条建议”, add `semanticInventories` to that narration-map cue with `label`, numeric `count`, source-grounded `items`, `sourceEvidence`, and `presentationMode: "list"`. Search the full source transcript and the cited source frames for the real names; never render `M1–M5`, `Item 1`, “模块一”, blank cards, unlabeled dots, or repeated icons as if they explain the list. If the source truly states only the count and the names cannot be verified, use `presentationMode: "count-only"`, an empty `items` array, and an explicit `unavailableReason`; show one honest count visual instead of fake list UI.
   - Write `out/analysis/scene_implementation.json` after JSX. Keep cue indices aligned with `narration_visual_map.json`, record the concrete scene and whether the presenter or source evidence is visible, and copy semantic inventories exactly as rendered. For source-video cues, record `displayMode`, `objectFit`, and the actual `evidenceBounds`. Use this file as a production trace, not as a requirement to invent two elements or two animation events for every cue.
   - Reserve the caption and presenter rectangles before placing content. Mark the actual JSX nodes with `data-layout-role="primary"`, `secondary`, `decoration`, `chrome`, or `summary` so the JSON contract is bound to rendered layers. Primary/secondary content must not intersect captions or the presenter, secondary callouts must not sit on top of primary UI, and the presenter must not touch captions. A decoration that crosses semantic content must be text-free and at most 8% opacity; otherwise keep it outside the primary region. With complete captions present, do not add a second bottom cue summary/title unless that exact layer exists in the cited source frame. Persistent header, cue counter, bottom title, focus callout, large scene signature, captions, presenter, and primary UI may not all coexist merely to make the frame feel busy. Do not create global `SceneSignature` or `PhraseFocus` overlays that indiscriminately add rings, sweeps, grids, brackets, or large polygons to every cue; animate the semantic component itself.
   - Use source-specific scenes where they help the story. Repetition is acceptable when the presenter is intentionally explaining a continuous point; change the layout when the evidence or editorial purpose changes, not to satisfy a diversity ratio.
   - Treat 12 seconds as a hard cue limit. Split longer transcript segments at real phrase boundaries and rerun the bundled visual-map validator; do not rely on a downstream tolerance.
   - Show at most one presenter in any frame. If the source already contains a baked-in presenter/PIP, crop or reframe to a presenter-free UI region before adding the InfiniteTalk presenter; never stack a new rectangle over the old circular presenter.
   - With a user avatar over a 16:9 presentation, default to a circular head-and-shoulders PIP unless the source provides a geometry to match or the user explicitly selected `真人主画面·悬浮组件`. Inspect face/chin framing and avoid long transparency fades at segment boundaries.
   - Composite the continuous `presenter/presenter-track.mp4` inside Remotion with one persistent `Video` from `@remotion/media` and a `data-presenter-layer="infinite-talk"` container. Preserve its aspect ratio with `objectFit: "cover"` inside the circular crop; never create one `Video` per segment, pre-scale a 16:9 presenter video into a square, or add the presenter with a post-render FFmpeg overlay. Give time-bounded heavy-media `Sequence` layers `premountFor` so they are ready before they become visible.
   - Before the full render, inspect the opening, ending, every source-evidence cue, and any dense layout or presenter/evidence handoff. Add more stills only when a real overlap or crop risk exists. Do not generate three collision frames and a 25%/75% pair for every cue by default.
   - Prefer a functional first frame over a landing page. Add cards, callouts, counters, diagrams, or subtitles only when they clarify the current spoken point and fit the source style.
   - Design online-native retention rhythm as a separate requirement from source-video PIP. Without inventing claims or reordering retained source points, make the first 0-2 seconds deliver a visible hook, result, conflict, or curiosity gap; add a meaningful visual beat roughly every 3-6 seconds and a stronger composition or perspective reset every 10-18 seconds. Use proof-first reveals, progressive diagrams, annotated focus changes, split-screen comparisons, restrained punch-ins, and phrase-triggered keyword emphasis. Do not achieve “网感” through nonstop bouncing, random stickers, excessive soundless transitions, generic neon UI, or unstable full-caption animation.
   - Keep the primary caption block stable and readable while highlighting only one or two spoken keywords at a time. Let the final 2-4 seconds complete the conclusion and give a grounded action, question, or next step; never cut off the closing sentence for pace.
   - When the selected style is `真人主画面·悬浮组件`, require an uploaded or saved avatar image and use it as the only identity source; always run `prepare-assets --source-image <avatarImage>` for the presenter input, even when a clone source video is also present. Never silently derive the person from the reference video. Make the resulting InfiniteTalk presenter the dominant visual rather than a corner PIP. On 16:9, use the landscape presenter full-frame or in a 65-85% main stage; on 9:16, use a full-height or near-full-height portrait presenter; on 1:1, use a square presenter main stage. Mark the main layout `data-layout-style="presenter-primary-floating-ui"` and the presenter `data-presenter-layer="infinite-talk"`.
   - In that style, the presenter is dominant only during explanation. When the narration refers to a concrete demo, webpage, comparison, generated result, or operation, promote that evidence to the main stage and shrink or hide the presenter. “人物为主” must never mean “演示永远是小卡片”. Float at most one useful annotation around—not over—the eyes, mouth, chin, hands, evidence, or captions.
   - Put presenter PIP in a stable corner, usually lower right, sized around 12-15% of video height for 16:9, and verify it does not block subtitles or core UI.
   - Animate when the source or explanation benefits from it. Preserve real demo motion and phrase-aligned edits; do not add movement merely to make a frame-difference validator pass.
   - Use `Config.setVideoImageFormat("png")` and render final HQ with CRF 10-14. Full renders must go through `scripts/render_remotion.py`, which writes durable frame progress, requests H.264/yuv420p/BT.709 on the first render, and resumes an already valid output. On the Mac renderer start at concurrency 16 now that the presenter is a single decode track, with automatic fallbacks 12, 8, 6, and 4 only after a render-process failure. Keep Remotion still generation serial. Never rerun a successful full Remotion render merely to repair color metadata.

6. **Synchronize**
   - Do not stretch a lip-synced PIP just to match a slightly different audio duration. If HeyGen PIP audio and final narration are from the same source, play the PIP at `playbackRate={1}` unless measured sync says otherwise.
   - Use `scripts/sync_audio_lag.py final_audio.wav pip_video.mp4 --times 5,60,300,580,740` to distinguish fixed offset from playback-rate drift.
   - Fix a fixed offset with trim/delay. Fix drift only after measuring it across multiple timestamps.
   - Fade out PIP before its source ends if the main composition has a visual outro longer than narration.

7. **Validate before delivery**
   - Run lint/typecheck for the project.
   - Re-run `python3 scripts/validate_narration_script.py --input out/audio/final_script.txt`; reject missing/cut-off closings and engagement-bait endings before rendering or delivery.
   - Render stills at opening, middle, risk/dense UI scene, and ending. Build `out/stills/final/review_montage.jpg`; clone jobs also build `out/stills/source_review/montage.jpg` from representative source frames.
   - Run `scripts/validate_scene_contract.py --map out/analysis/narration_visual_map.json --implementation out/analysis/scene_implementation.json --output out/analysis/scene_contract_report.json` before full render. The validator checks timeline alignment, semantic lists, evidence declarations, and obvious collisions; it must not score scene diversity or animation density.
   - In the same Codex session, inspect the source, every evidence cue, the opening, the ending, and the final montage with `view_image`. Check one editorial question first: “Did this version preserve the thing the viewer came to see?” Reject a demo/review cue that replaces the visible result with abstract cards, even if all metadata and frame metrics pass.
   - Reject visible source/platform watermarks, stretched or duplicate presenters, stale/missing subtitles, blank frames, unreadable demonstrations, or evidence covered by UI. Do not reject a correct video merely because a cue is visually steady, two layouts repeat, or a self-assigned score is below an arbitrary threshold.
   - Render a short segment around a late timestamp to check accumulated sync before full export.
   - Run `ffprobe`, full decode (`ffmpeg -v error -i final.mp4 -f null -`), and `volumedetect`.
   - Inspect representative frames from every narration cue group, not only opening/middle/ending. Explicitly test numbered steps and late-video cues for phrase-level agreement.
   - Generate a publish package: accurate `marketingTitle`, publish-ready `marketingDescription`, and a dedicated Remotion cover still at `out/cover.png`.
   - Inspect `out/cover.png` separately for a clear focal point, readable title, safe crop, and no watermark. Record an `approved` decision and concrete issues; numeric self-scores are optional and never a hard gate.
   - Treat the wrapper's BT.709-limited output as the Remotion visual master. If the first render is not compliant, the wrapper may perform one fast libx264 `veryfast` color standardization before declaring that master; this is not a second Remotion render. Afterward mux narration with video stream copy. The final MP4 and the declared visual master must have identical video-stream SHA-256 values; any visual processing after the master is declared is a validation failure.
   - Preserve the `submit` command's `result.json` receipt. Hosted jobs must report the receipt and the returned InfiniteTalk MP4 in their final manifest.
   - For segmented jobs, preserve `segments.json`, every per-segment `result.json`, and every returned MP4. The final manifest must expose matching `presenterSegmentPaths` and `infiniteTalkReceiptPaths` arrays.
   - Deliver the final MP4 path and mention any limitations such as ASR uncertainty, missing user voice, or HeyGen credit constraints.

## Bundled Scripts

- `scripts/media_report.py <media>`: JSON media stream and duration report.
- `scripts/contact_sheet.sh <input.mp4> <output.jpg> [cols] [width]`: quick visual overview.
- `scripts/heygen_api.py`: API-key first wrapper for HeyGen user check, asset upload, lipsync create/get/download.
- `scripts/modelverse_minimax_speech.py`: API-key first wrapper for ModelVerse MiniMax `speech-2.8-hd` premium Chinese narration.
- `scripts/validate_narration_script.py`: deterministic guard for a complete spoken closing without engagement bait.
- `scripts/modelverse_indextts.py`: API-key first wrapper for ModelVerse IndexTTS-2 custom voice upload and TTS generation.
- `scripts/long_form_tts.py`: resumable sentence-safe long-form MiniMax/IndexTTS narration.
- `scripts/transcribe_timeline.py`: normalized timestamps from the locked final narration.
- `scripts/validate_narration_visual_map.py`: deterministic preflight for phrase-level cue timing, coverage, and source evidence.
- `scripts/validate_scene_contract.py`: rejects cue-index drift, empty or placeholder numbered lists, and declared caption/presenter/content collisions.
- `scripts/validate_visual_preflight.py`: blocks full rendering until ten source frames, presenter crops, Remotion stills, and source/storyboard luma all pass.
- `scripts/infinite_talk_api.py`: direct Gradio/ComfyUI helper for InfiniteTalk digital-human submit, polling, and result download.
- `scripts/normalize_presenter_segments.py`: removes black bars and creates square, portrait, or landscape silent Remotion presenter assets while preserving raw API outputs.
- `scripts/prepare_presenter_track.py`: joins compatible normalized/upscaled presenter segments into one resumable, silent Remotion decode track.
- `scripts/render_remotion.py`: runs the only full Remotion render with durable frame progress, Mac concurrency fallback, resume, and BT.709 standardization.
- `scripts/prepare_lipsync_source.sh <reference_video> <narration_audio> <output.mp4>`: loop/scale a reference video and mux narration so lip-sync services detect a speaker.
- `scripts/sync_audio_lag.py <main_audio_or_video> <pip_audio_or_video> --times 5,60,300`: estimate audio lag at multiple timestamps.

## Delivery Standard

Finish with a playable MP4, not just project files. Include:

- Final MP4 absolute path.
- Publish title, description, and cover path.
- Verification performed.
- Caption timeline, scene implementation map, and source-evidence decisions.
- Any known tradeoffs.
