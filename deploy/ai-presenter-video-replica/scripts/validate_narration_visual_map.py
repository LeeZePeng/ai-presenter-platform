#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import math
import re
from pathlib import Path
from typing import Any


MAX_CUE_SECONDS = 12.0
MAX_GAP_SECONDS = 0.5
class VisualMapError(ValueError):
    pass


def _number(value: Any, label: str) -> float:
    if isinstance(value, bool):
        raise VisualMapError(f"{label} must be a finite number")
    try:
        result = float(value)
    except (TypeError, ValueError) as error:
        raise VisualMapError(f"{label} must be a finite number") from error
    if not math.isfinite(result):
        raise VisualMapError(f"{label} must be a finite number")
    return result


def _source_video_evidence(raw: dict[str, Any], cue: dict[str, float], index: int) -> dict[str, Any]:
    value = raw.get("sourceVideoEvidence")
    if not isinstance(value, dict):
        raise VisualMapError(f"cue {index} source_video_pip needs sourceVideoEvidence")
    clip_start = _number(value.get("clipStartSeconds"), f"cue {index} clipStartSeconds")
    clip_end = _number(value.get("clipEndSeconds"), f"cue {index} clipEndSeconds")
    purpose = str(value.get("evidencePurpose") or "").strip()
    treatment_text = str(value.get("presenterTreatment") or "").strip()
    if re.search(r"crop-action-only|裁|裁切", treatment_text):
        treatment = "crop-action-only"
    elif re.search(r"not-visible|无人物|人物不可见", treatment_text):
        treatment = "not-visible"
    elif re.search(r"hidden|隐藏", treatment_text):
        treatment = "hidden"
    elif re.search(r"outside|corner|角落|证据之外|缩小", treatment_text):
        treatment = "outside"
    else:
        treatment = ""
    if (
        clip_start < cue["source_start"] - 0.5
        or clip_end > cue["source_end"] + 0.5
        or clip_end <= clip_start
        or clip_end - clip_start > min(MAX_CUE_SECONDS, cue["output_end"] - cue["output_start"] + 2)
        or len(purpose) < 4
        or value.get("audioMuted") is not True
        or _number(value.get("playbackRate"), f"cue {index} playbackRate") != 1
        or treatment not in {"hidden", "crop-action-only", "not-visible", "outside"}
    ):
        raise VisualMapError(f"cue {index} has invalid sourceVideoEvidence")
    return {"clip_start": clip_start, "clip_end": clip_end}


def validate_visual_map(
    value: Any,
    duration_seconds: float,
    presenter_segment_count: int = 0,
) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise VisualMapError("visual map root must be an object")
    if value.get("presenterSegmentationDrivesVisuals") is not False:
        raise VisualMapError("presenterSegmentationDrivesVisuals must be false")
    cues = value.get("cues")
    if not isinstance(cues, list) or len(cues) < 3:
        raise VisualMapError("visual map must contain at least 3 cues")
    if duration_seconds > 30 and presenter_segment_count > 0 and len(cues) <= presenter_segment_count + 1:
        raise VisualMapError("visual cue count is too close to InfiniteTalk segment count")

    previous_start = -1.0
    previous_end = 0.0
    previous_source_start = -1.0
    parsed_evidence: dict[int, dict[str, Any]] = {}
    for index, raw in enumerate(cues):
        if not isinstance(raw, dict):
            raise VisualMapError(f"cue {index} must be an object")
        if raw.get("cueIndex") != index:
            raise VisualMapError(f"cue {index} cueIndex must be zero-based and contiguous")
        start = _number(raw.get("outputStartSeconds"), f"cue {index} outputStartSeconds")
        end = _number(raw.get("outputEndSeconds"), f"cue {index} outputEndSeconds")
        narration_text = str(raw.get("narrationText") or "").strip()
        visual_type = str(raw.get("visualType") or "").strip()
        if start < 0 or end <= start or end - start > MAX_CUE_SECONDS + 0.001:
            raise VisualMapError(f"cue {index} has invalid output timestamps or exceeds 12s")
        if len(narration_text) < 2 or len(visual_type) < 3:
            raise VisualMapError(f"cue {index} is missing narrationText or visualType")
        if index == 0 and start > MAX_GAP_SECONDS:
            raise VisualMapError(f"first cue starts at {start:.3f}s, leaving an opening gap")
        if index > 0:
            gap = start - previous_end
            if start < previous_start or gap > MAX_GAP_SECONDS + 0.001:
                raise VisualMapError(f"cue {index} has an invalid order or visual gap")
        source_start = _number(raw.get("sourceStartSeconds"), f"cue {index} sourceStartSeconds")
        source_end = _number(raw.get("sourceEndSeconds"), f"cue {index} sourceEndSeconds")
        source_text = str(raw.get("sourceText") or "").strip()
        source_scene = str(raw.get("sourceSceneDescription") or "").strip()
        plan = str(raw.get("replicationPlan") or "").strip()
        if source_start < 0 or source_end <= source_start or len(source_text) < 4 or len(source_scene) < 8 or len(plan) < 8:
            raise VisualMapError(f"cue {index} must include source evidence, scene state, and replication plan")
        if previous_source_start >= 0 and source_start + 1.0 < previous_source_start:
            raise VisualMapError(f"cue {index} source timestamps are out of source order")
        if visual_type == "source_video_pip":
            parsed_evidence[index] = _source_video_evidence(
                raw,
                {"source_start": source_start, "source_end": source_end, "output_start": start, "output_end": end},
                index,
            )
        previous_start, previous_end, previous_source_start = start, end, source_start

    if previous_end < duration_seconds - 1.0:
        raise VisualMapError(f"last cue ends at {previous_end:.3f}s but narration lasts {duration_seconds:.3f}s")

    inventory = value.get("sourceEvidenceInventory")
    if not isinstance(inventory, list):
        inventory = value.get("sourceMotionEvidenceInventory")
    if not isinstance(inventory, list) or not inventory:
        raise VisualMapError("sourceEvidenceInventory is required")
    mapped: set[int] = set()
    for index, item in enumerate(inventory):
        if not isinstance(item, dict):
            raise VisualMapError(f"source evidence item {index} must be an object")
        start = _number(item.get("sourceStartSeconds"), f"source evidence {index} start")
        end = _number(item.get("sourceEndSeconds"), f"source evidence {index} end")
        preserve_original = item.get("preserveOriginal") is True or item.get("eligible") is True
        cue_indices = item.get("mappedCueIndices")
        cue_indices = [int(candidate) for candidate in cue_indices] if isinstance(cue_indices, list) else []
        if start < 0 or end <= start or len(str(item.get("kind") or "").strip()) < 3 or len(str(item.get("description") or "").strip()) < 8:
            raise VisualMapError(f"source evidence item {index} is invalid")
        if preserve_original and not cue_indices:
            raise VisualMapError(f"preserved source evidence item {index} maps no source_video_pip cue")
        rebuild_reason = item.get("rebuildReason") or item.get("exclusionReason")
        if not preserve_original and len(str(rebuild_reason or "").strip()) < 8:
            raise VisualMapError(f"rebuilt source evidence item {index} needs rebuildReason")
        for cue_index in cue_indices:
            evidence = parsed_evidence.get(cue_index)
            if not evidence:
                raise VisualMapError(f"source evidence item {index} maps cue {cue_index} without source_video_pip")
            if evidence["clip_end"] < start or evidence["clip_start"] > end:
                raise VisualMapError(f"source evidence item {index} does not overlap cue {cue_index} clip")
            mapped.add(cue_index)
    if set(parsed_evidence) - mapped:
        raise VisualMapError("every source_video_pip cue must map to preserved source evidence")

    return {
        "valid": True,
        "cueCount": len(cues),
        "sourceVideoPipCount": len(parsed_evidence),
        "sourceEvidenceInventoryCount": len(inventory),
        "durationSeconds": duration_seconds,
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate narration-driven visual cues before paid rendering")
    parser.add_argument("--map", required=True, type=Path, dest="map_path")
    parser.add_argument("--duration", required=True, type=float)
    parser.add_argument("--presenter-segment-count", type=int, default=0)
    args = parser.parse_args()
    try:
        value = json.loads(args.map_path.read_text(encoding="utf-8"))
        result = validate_visual_map(value, args.duration, args.presenter_segment_count)
    except (OSError, json.JSONDecodeError, VisualMapError) as error:
        parser.exit(2, f"visual map validation failed: {error}\n")
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
