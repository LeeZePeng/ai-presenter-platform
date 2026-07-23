# Remotion Visual Quality Contract

Use this contract before writing any Remotion composition for an AI presenter video. Quality takes priority over token use, implementation brevity, render speed, and template reuse.

## 1. Extract the visual identity

For clone jobs, inspect at least ten representative source frames covering the opening, UI-dense moments, transitions, presenter placement, subtitles, and ending. Write `out/analysis/visual_design.json` before JSX with a concrete style summary, palette, typography, presenter and subtitle treatments, motion language, safe regions, source signatures, and anti-patterns.

For topic or script jobs, derive the same fields from the requested style and subject. Never fall back to generic blue/purple SaaS cards.

## 2. Preserve the source, not a template

- Do not add persistent chrome, chapter pills, metric panels, or dashboard rails unless visible in the source.
- Keep primary UI large enough to read. Use overlays only while the current sentence needs them.
- Match the source PIP geometry and show one presenter maximum per frame.
- Remove or rebuild source regions containing conflicting subtitles, baked-in presenters, or watermarks.
- Treat every cue `replicationPlan` as an implementation checklist. A title and keyword tag cannot stand in for a promised terminal, diagram, comparison, workflow, code panel, icon set, progress state, or review sequence.
- Treat enumerations as content, not decoration. “N 个模块 / N 件事 / N 步 / N 种模式” must either show N readable, source-grounded item names or collapse to one count-only visual when the source does not reveal the names. `M1–M5`, numbered empty cards, unlabeled nodes, and generic repeated icons are deterministic failures.
- Use distinct source-specific scene components. No generic layout may serve more than two consecutive cues, and a visually diverse source requires at least 60% measurably distinct cue compositions.

### Frame-layer budget

- Reserve normalized rectangles for primary content, captions, and the presenter before authoring secondary components. They may not overlap.
- Bind every declared region to its actual JSX node with `data-layout-role`. A JSON-only layout claim without corresponding rendered-layer markers is not evidence.
- A secondary callout must occupy free space or temporarily replace/reflow primary content; it may not float over the primary diagram.
- Decorative rings, grids, bars, polygons, and scene signatures must stay outside semantic content. If a subtle texture crosses it, cap opacity at 8% and include no text.
- Full captions already supply the lower text layer. Do not add a persistent bottom cue title or summary unless it is grounded in the cited source state.
- Do not simultaneously stack persistent header, cue counter, bottom title, focus callout, large decoration, full captions, presenter, and primary UI. Visual rhythm comes from changing meaningful state, not maximizing layer count.
- Do not use global `SceneSignature` / `PhraseFocus` systems that paint rings, sweeps, grids, brackets, or polygons across every cue. Phrase emphasis should change the primary diagram/card itself or reflow a declared secondary component into free space.

## 3. Use source-video PIP only as moving evidence

- For real device demonstrations, software operation, product behavior, field footage, before/after action, or on-location scenes, prefer a short timestamp-grounded moving source clip over a static reconstruction when motion itself is the proof.
- Render the muted, trimmed original clip inside Remotion with `data-source-evidence-layer="source-video-pip"`; preserve aspect ratio and natural speed.
- In video evaluation, real-device demonstration, field footage, and software-operation cues, make the moving evidence the dominant panel: at least 72% of a 16:9 canvas width, 50% height, and 42% area; prefer 82-92% width for detailed footage. Use `contain` by default and never hide evaluated content behind `cover`, nested padding, a large title block, or an oversized presenter. Declare the exact moving-pixel rectangle as `evidenceBounds`, not the outer card.
- Do not place top/bottom masks, gradients, titles, badges, subtitles, or the presenter over the evidence pixels. All such layers belong outside the declared rectangle. A burned-in old subtitle is not permission to cover the original frame; select a clean interval or rebuild the cue.
- Do not use source-video PIP for routine talking-head, test setup, method explanation, scoring criteria, conclusion, or static-slide cues. Phrases such as “same prompt / duration / aspect ratio” and “we will inspect motion / lip sync” describe the test, but do not themselves evaluate visible motion. Keep the InfiniteTalk presenter visible and explain them with native diagrams. Do not expose old subtitles, a baked presenter, a watermark, or original audio.
- Never show the original speaker and InfiniteTalk presenter as competing presenters. Hide one or crop the evidence clip to the action/UI region.
- In model/video evaluation content, cards and score graphics may explain a verdict but cannot replace the generated clip being judged. Show the actual moving result whenever narration discusses motion, camera work, weather/particles, reflections, physical logic, expression, blinking, lip sync, or delay.

## 4. Complete captions

- Use final-audio ASR only for timestamps and the locked final script for authoritative text.
- Write and render `out/analysis/caption_timeline.json`; require at least 95% bidirectional normalized text coverage against the final script.
- Use phrase-level captions, normally 1.2-4.5 seconds and never over 6 seconds. Keep them within two rendered lines.
- Mark the actual caption container `data-caption-layer="narration-timeline"`.
- Cue headings, summaries, chapter labels, and keywords are visual copy, not captions. They may never replace the words currently being spoken.
- Internal production labels such as “原生图解”, “数字人口播”, “动态证据”, cue numbers, review status, and renderer/method names must never appear in the delivered frame. Replace them with source-grounded content language or remove the layer.

## 5. Online-native retention rhythm

- Make the first 0-2 seconds visibly useful: show a grounded result, conflict, action, or curiosity gap without reordering exact-replica content.
- Create a meaningful visual beat every 3-6 seconds and a larger composition/perspective reset every 10-18 seconds when duration permits.
- Prefer proof-first reveals, progressive diagrams, annotated focus changes, comparisons, and restrained punch-ins over generic decoration.
- Keep captions anchored and readable. Emphasize one or two spoken keywords; never bounce or restyle the entire caption continuously.
- Finish with a complete 2-4 second payoff and grounded next step. “网感” never justifies stale subtitles, fabricated claims, random stickers, excessive transitions, or missing conclusions.

## 6. Presenter-primary floating-component style

When the user selects `真人主画面·悬浮组件`, treat it as an explicit composition hierarchy rather than a generic visual mood.

- Require an uploaded or saved avatar image and use it as the only identity source. Prepare the presenter with `prepare-assets --source-image <avatarImage>` even when a clone source video exists. The reference video may supply content evidence and visual language, but it must not silently replace the selected person.
- Make the lip-synced InfiniteTalk presenter the dominant visual. Generate and normalize it in the final canvas direction; never stretch square or portrait PIP assets into another aspect ratio.
- For 16:9, use a 832x480 landscape presenter generation normalized to 1280x720, then place it full-frame or in a 65-85% main stage. For 9:16, use a full-height or near-full-height portrait presenter normalized to 720x1280. For 1:1, use a square presenter main stage normalized to 720x720.
- Mark the layout `data-layout-style="presenter-primary-floating-ui"` and retain `data-presenter-layer="infinite-talk"` on the actual Video container.
- Define face, mouth/chin, hand-action, caption, and component safe regions in `visual_design.json`. Floating components must never cover these regions.
- Show no more than one primary and one secondary component at once. Use phrase-triggered keyword cards, step badges, metrics, comparison chips, diagram fragments, or source-evidence PIP, and remove each when its sentence ends.
- Alternate component placement and scale across cues, but keep visual gravity anchored to the person. Persistent rails, permanent dashboard panels, and a component over every empty pixel violate the style.
- Keep captions in a stable lower safe band with strong contrast against moving clothing/background. A floating keyword card may emphasize the current phrase but may not replace the complete caption layer.

## 7. Motion and typography

- Use `spring()` or eased `interpolate()` motion. Entrances should settle in 8-18 frames.
- Every cue needs an entrance and phrase-triggered progress after the entrance. For cues over four seconds, central content must materially change between 25% and 75% of the cue.
- Presenter mouth movement, subtitle replacement, background drift, and a scene's initial entrance do not count as central content motion.
- Use source-matched type scale and contrast. Keep Chinese `letterSpacing` at 0 and use only explicitly loaded 400, 700, and 900 Noto Sans CJK SC weights.

## 8. Required implementation evidence

Before full render, require:

- ten or more source frames spanning the source structure;
- a storyboard montage based on the narration cue map;
- `out/analysis/scene_implementation.json`, mapping every cue to a `sceneKey`, two or more implemented elements, and phrase-triggered motion events;
- semantic inventories for every counted list, copied into implementation `semanticLists` with the exact visible item labels;
- normalized `layoutRegions` for every primary, secondary, caption, presenter, decoration, chrome, and summary layer;
- one presenter-crop still per InfiniteTalk segment;
- one actual Remotion still per cue;
- 25%/75% motion-review pairs for every cue longer than four seconds;
- entrance-settled, phrase-overlay-peak, and pre-exit stills for every cue, because quarter-point sampling misses transient overlap;
- opening, middle, dense, and ending Remotion stills;
- `out/analysis/preflight_report.json` with `approved: true` and no issues.

The storyboard proves planning only. The cue stills and motion pairs prove JSX implementation.

## 9. Deterministic failure conditions

Fail before delivery when any of these is true:

- caption text does not cover at least 95% of the locked script in both directions;
- the Remotion source is not bound to the caption timeline;
- any visual cue lacks an implementation entry or promised visual structure;
- cue indices are shifted, non-contiguous, or use a different base between the narration map and implementation map;
- a counted list lacks the promised number of readable source-grounded item names, or uses placeholder labels such as `M1–M5`;
- declared primary/secondary UI intersects captions or the presenter, the presenter intersects captions, or secondary UI covers primary UI;
- decoration crosses semantic content above 8% opacity, or an ungrounded bottom summary duplicates the complete caption layer;
- fewer than 60% of cue compositions are measurably distinct while the source frames are diverse;
- a generic scene layout repeats for more than two consecutive cues;
- fewer than 60% of cues over four seconds show meaningful central-region change between their 25% and 75% frames;
- subtitles are stale, summarized, clipped, or absent;
- PPT/source visuals describe the previous or next spoken phrase;
- the presenter is duplicated, stretched, hidden, or blocks captions or primary UI;
- the final result uses full-frame screenshots, generic persistent chrome, or static-card swaps.
- a planned source-video evidence cue is replaced by a still, carries original audio, exposes a watermark/old subtitle, or duplicates the presenter;
- a source-video evidence rectangle is smaller than 72% canvas width, 50% height, or 42% area; omits `evidenceBounds`; uses `cover` without a documented crop-action-only need; or remains unreadable at normal playback size;
- eligible motion evidence is inventoried but no cue uses `source_video_pip`, or a motion-evaluation cue uses only abstract UI;
- a setup/method/score/conclusion cue uses `source_video_pip`, or a non-evidence cue does not keep the InfiniteTalk presenter continuously visible;
- the opening has no visible hook, long sections have no meaningful visual beats, or the closing sentence is cut off merely to increase pace.
- the presenter-primary style uses a stretched square asset, lacks `data-layout-style="presenter-primary-floating-ui"`, or lets floating components cover the face, mouth, hands, or captions.

After final mux, inspect the source, storyboard, cue, motion-pair, final, and cover montages in the same Codex session. Write `out/analysis/visual_review.json` and require video and cover scores of at least 90/100 with no fatal issues. Preserve narration and InfiniteTalk checkpoints so visual failures can be repaired without regenerating paid assets.
