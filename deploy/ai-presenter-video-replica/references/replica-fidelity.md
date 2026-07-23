# Replica Fidelity Contract

Use this contract for every clone job.

## Replica modes

- `exact`: preserve every substantive source point, its order, and the presentation sequence. Only repair ASR punctuation, obvious homophones, and verbal noise. Do not summarize, merge chapters, or fit the result into a shorter duration.
- `condensed`: fit any requested duration at or above the platform technical minimum. Preserve the core topic, key arguments, conclusion, a complete opening hook, a complete closing statement, and the source order of retained points. Actively drop secondary points, optional numbered steps, examples, expanded evidence, comparison details, tangents, and repetition when the cap requires it. Do not fail because full-source coverage is impossible. Every retained phrase must still reproduce its corresponding source PPT/scene state and visual language.

Never silently turn `exact` into `condensed`. For a long exact job, report the expected segment count and continue with resumable checkpoints.

## Source analysis contract

Clone jobs must write `out/analysis/source_analysis.json` with these exact required fields. Extra fields are allowed, but do not rename the required fields:

```json
{
  "version": 1,
  "replicaMode": "exact",
  "sourceTopic": "The actual subject discussed in the source video",
  "sourceTranscriptPath": "/absolute/path/to/worker/source_transcript.json",
  "selectedClips": [
    {
      "startSeconds": 0.0,
      "endSeconds": 6.3,
      "sourceText": "Verbatim transcript evidence for this interval",
      "narrationPurpose": "Which current narration point this clip supports"
    }
  ]
}
```

- `sourceTopic` must describe the source content, not the production request.
- `sourceTranscriptPath` must exactly reference the worker-provided transcript.
- Every selected clip needs valid source timestamps, transcript-grounded `sourceText`, and a non-empty `narrationPurpose`.
- Use `selectedClips` even when the source is a single talking-head shot; one evidence-backed full-source interval is valid.

## Independent timelines

The production has three timelines with different purposes:

1. Final narration timestamps: generated from the locked final audio.
2. Visual cues: phrase-level PPT/source/card changes aligned to the narration timestamps.
3. InfiniteTalk segments: implementation-only chunks capped at 20 seconds.

InfiniteTalk boundaries must never drive visual cuts.

## Complete caption contract

- Use the locked final narration audio for timing and `out/audio/final_script.txt` for the authoritative words.
- Correct ASR product names, homophones, punctuation, and broken clauses against the locked script without changing timing boundaries arbitrarily.
- Write `out/analysis/caption_timeline.json` with `version`, `narrationTimelinePath`, `scriptPath`, and phrase-level `segments` containing `startSeconds`, `endSeconds`, and `text`.
- Require bidirectional normalized text coverage of at least 95% between caption text and the locked script. Cover the opening and ending, leave no gap over 0.5 seconds, keep captions at 1.2-4.5 seconds normally, and never exceed 6 seconds.
- Render the caption timeline itself. Cue headings, scene labels, keywords, and summaries may coexist with captions but may never replace them.
- Mark the Remotion caption container with `data-caption-layer="narration-timeline"` and keep its source data inside the Remotion source tree so the platform can verify the binding.

After locking `out/audio/final_narration.wav`, run `scripts/transcribe_timeline.py` and write `out/analysis/narration_timeline.json`. Then write `out/analysis/narration_visual_map.json`:

```json
{
  "version": 1,
  "narrationTimelinePath": ".../narration_timeline.json",
  "presenterSegmentationDrivesVisuals": false,
  "cues": [
    {
      "cueIndex": 0,
      "outputStartSeconds": 0.0,
      "outputEndSeconds": 4.2,
      "narrationText": "第一步，让系统脱离 UI 也能运行",
      "visualType": "source_clip",
      "sourceStartSeconds": 287.8,
      "sourceEndSeconds": 292.3,
      "sourceText": "第一，你的系统在脱离人的眼睛和 UI 后还能运行吗",
      "sourceSceneDescription": "米白底、黑色粗描边的第一步卡片在左侧进入，粉色数字标签同步出现",
      "replicationPlan": "用同色背景、粗描边卡片和粉色数字标签原生重建，并在说到第一步时进入",
      "reason": "The first-question card appears as the narration says first step"
    }
  ]
}
```

Rules:

- Cover the full narration with gaps no longer than 0.5 seconds.
- `cueIndex` is zero-based, contiguous, and identical in `narration_visual_map.json` and `scene_implementation.json`; never convert it to a one-based display number.
- Use 3-8 second cues. A cue may reach 12 seconds only when the spoken point and source visual intentionally remain unchanged.
- Twelve seconds is a hard limit, not a rounding target. If ASR emits a longer segment, split it at a real clause or sentence boundary and keep the visual evidence aligned to both resulting cues.
- Trigger numbered cards, steps, comparisons, and conclusions on the corresponding spoken phrase, not at paragraph or presenter-segment boundaries.
- Every stated quantity with enumerable meaning needs `semanticInventories`. Use `presentationMode: "list"` only with exactly `count` readable, source-grounded item names. If the source never reveals the names, use `presentationMode: "count-only"`, `items: []`, and `unavailableReason`, then render one count visual rather than placeholder cards.
- A `source_clip` cue must cite source timestamps and matching source transcript text.
- If the source animation cannot express the rewritten phrase at the correct moment, rebuild that cue in Remotion using the source palette and typography.
- In both `exact` and `condensed` modes, every cue includes source timestamps, source transcript evidence, the corresponding source PPT/scene state, and a concrete replication plan. Source-backed cue timestamps stay in source order. Every substantive source section must appear only in `exact`; `condensed` needs coverage only for the narration it retains.
- Review at least one frame per cue group, including every numbered sequence and the late section.

Before any paid presenter request or Remotion render, run:

```bash
python3 scripts/validate_narration_visual_map.py \
  --map out/analysis/narration_visual_map.json \
  --duration <final-audio-seconds>
```

Do not continue until this command exits successfully.

## Presenter treatment

- For a user-supplied avatar over a 16:9 presentation, default to a circular head-and-shoulders PIP unless the source has a clear presenter geometry to match.
- Generate that PIP presenter in portrait geometry, normally 480x832. The final canvas aspect ratio must not be reused as the InfiniteTalk person-video aspect ratio.
- Keep the face centered, use `object-fit: cover`, a stable diameter around 13-16% of frame height, and a source-matched border.
- Do not fade the presenter to transparency for 8-12 frames at every InfiniteTalk boundary. Use a hard cut or a 2-4 frame subtle transition inside the circle.
- Inspect the raw presenter frame before choosing `object-position`; do not crop eyes, chin, or the full face.
- Keep the source video aspect ratio inside the crop. Do not scale the presenter to the crop's square dimensions before masking.
- The presenter is part of the Remotion composition, marked with `data-presenter-layer="infinite-talk"`. Post-render FFmpeg overlays are forbidden; FFmpeg may only stream-copy the finished video while muxing locked narration.

## Conditional source-video evidence PIP

Source-video PIP is an evidence treatment, not the default visual language and not the mechanism that creates overall short-video appeal.

Before writing cues, audit every selected source interval into top-level `sourceMotionEvidenceInventory`. Each entry must include `sourceStartSeconds`, `sourceEndSeconds`, `kind`, `description`, `eligible`, and `mappedCueIndices`; an ineligible item also needs a specific `exclusionReason`. If any eligible entry exists, at least one mapped cue must use moving source evidence.

- Require it only when the original motion materially proves the current sentence: device operation, software interaction, physical behavior, field footage, before/after action, an on-location event, or a concrete evaluation of generated-video motion, realism, camera behavior, physics, facial motion, or lip sync. The narration must both identify the visible moving subject and make an observation or verdict about what it does.
- Do not mark setup or explanatory copy as motion evidence. “Use the same prompt / duration / aspect ratio”, test-group introductions, “we will inspect motion / lip sync”, scoring dimensions, methodology, disclaimers, transitions, summaries, and conclusions stay presenter-led with native diagrams even if nearby source footage contains movement. Split mixed cues at the sentence boundary instead of letting an evidence clause pull an explanatory clause into source video.
- Mark the matching visual cue as `visualType: "source_video_pip"`, preserve the cited `sourceStartSeconds` and `sourceEndSeconds`, and describe the crop, placement, and evidence purpose in `replicationPlan`.
- Stage the original video under Remotion `public/source/`, trim to the cited interval, mute the source audio, preserve natural playback speed, and render with `Video` or `OffthreadVideo` inside `data-source-evidence-layer="source-video-pip"`.
- Keep the clip moving and phrase-aligned. Do not replace it with a still, use it as a full-frame background, loop an arbitrary moment, or let it continue after its evidence purpose ends.
- For video evaluation, device demonstrations, field footage, or software operation in 16:9 output, the moving pixels are the primary evidence: require at least 72% canvas width, 50% canvas height, and 42% canvas area, and prefer 82-92% width for detailed scenes. Use `objectFit: "contain"` by default; `cover` is allowed only for a documented `crop-action-only` treatment that preserves every relevant action. Do not count an outer card, title block, border, or padding as evidence area.
- Keep the exact moving-pixel rectangle unobstructed. Top/bottom masks, gradient bands, titles, badges, subtitles, and presenters may not cover any source-video pixels. Put labels outside the evidence rectangle. If burned-in source text conflicts, choose another interval or rebuild; never conceal the top or bottom of the evaluated frame.
- In `scene_implementation.json`, add `displayMode`, `objectFit`, and normalized `evidenceBounds` to every implemented `sourceVideoEvidence`. Mark the exact video rectangle with `data-layout-role="evidence"` and `data-evidence-display="detail-stage" | "full-bleed"`.
- Crop or rebuild regions containing old subtitles, baked presenters, or watermarks. If the original speaker remains visible, hide the InfiniteTalk presenter for that interval or reframe to a speaker-free action region.
- Record the source-video PIP and its exact trim interval in `scene_implementation.json` as an implemented element. Ordinary talking-head, setup, method, score, conclusion, and static-slide cues should continue using native Remotion reconstruction. Their implementation entries must set `presenterVisible: true`, and the InfiniteTalk layer must remain continuously visible for the cue rather than appearing for only a few transition frames.
- Put `sourceVideoEvidence` on both the map cue and implementation cue. The map fields are `clipStartSeconds`, `clipEndSeconds`, `evidencePurpose`, `audioMuted: true`, `playbackRate: 1`, and `presenterTreatment`; the implementation also carries `sourceAsset: "source/sourceVideo.mp4"` and `layerMarker: "source-video-pip"`.

## Online-native retention rhythm

Treat overall “网感” independently from source-video PIP.

- Open within 0-2 seconds with a visible result, conflict, high-value promise, action, or curiosity gap grounded in the first retained source point. Exact mode must not reorder source content to manufacture a hook.
- Add a meaningful visual beat every 3-6 seconds: reveal proof, advance a diagram, change focus, compare states, annotate a detail, or shift the information hierarchy.
- Add a stronger pattern interrupt or composition reset every 10-18 seconds when duration permits. Vary evidence panels, diagrams, comparisons, presenter emphasis, and source-matched layouts instead of changing only colors.
- Keep captions stable; emphasize one or two current keywords rather than animating every character or moving the whole subtitle block.
- Use restrained 6-12 frame punch-ins, snap reveals, match cuts, and progressive state changes. Random stickers, nonstop bouncing, generic neon dashboards, and decorative transitions are not retention design.
- Preserve a complete final 2-4 second payoff: conclusion plus a grounded action, question, or next step.

## No-degradation rule

- A source decode failure is not permission to use static source frames. Use Remotion v4 `Video` from `@remotion/media`; on `Code 4` or `DEMUXER_ERROR_COULD_NOT_OPEN`, use Remotion `OffthreadVideo`. Rebuild natively if both official media paths fail.
- If the source cannot be replayed cleanly, rebuild the cue with native Remotion shapes, text, diagrams, and motion while matching the source visual language.
- Full-frame `source-cues/*.jpg`, contact sheets, and screenshots are analysis artifacts only and must never appear as delivered scene backgrounds.
- Every cue has a visible but concise frame-driven transition or emphasis. Static image swaps do not satisfy the clone contract.
- A cue plan is not implementation evidence. Write `out/analysis/scene_implementation.json` after JSX and map every cue to its concrete scene key, implemented visual elements, and phrase-triggered motion events.
- Do not satisfy multiple distinct replication plans with the same title-card shell. When the source uses terminals, diagrams, code editors, comparison layouts, workflow nodes, progress states, or review steps, implement those structures as distinct Remotion scenes.
- For cues longer than four seconds, the central content region must materially change between 25% and 75% of the cue. Presenter mouth motion, subtitle changes, background drift, and a one-time entrance do not count.
- Render one final cue still per cue and 25%/75% motion pairs. Compare visual signatures against the source-frame diversity; a source with many distinct states cannot pass with two or three repeated templates.

## Publish package

Every final result includes:

- `marketingTitle`: an accurate, attractive title grounded in the final narration.
- `marketingDescription`: a publish-ready description summarizing the value and key points without disclosing production tools. Product names such as Codex or Remotion remain valid when they are the source topic.
- `coverPath`: a Remotion-rendered cover using real source/presenter imagery and code-rendered text.

Register a dedicated Remotion `Still` composition for the cover. Do not ask an image model to draw Chinese text. Use a short title, one visual focus, strong contrast, safe margins, and the same aspect ratio as the final video.
