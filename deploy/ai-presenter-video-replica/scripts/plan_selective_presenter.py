#!/usr/bin/env python3
"""Plan only the narration intervals that need a lip-synced presenter."""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path
from typing import Any


EVIDENCE_VISUAL_TYPES = {"source_video_pip", "source_clip", "source_evidence"}
HIDDEN_TREATMENTS = {"hidden", "not-visible", "crop-action-only", "outside"}


class PresenterPlanError(ValueError):
    pass


def _number(value: Any, label: str) -> float:
    if isinstance(value, bool):
        raise PresenterPlanError(f"{label} must be a finite number")
    try:
        result = float(value)
    except (TypeError, ValueError) as error:
        raise PresenterPlanError(f"{label} must be a finite number") from error
    if not math.isfinite(result):
        raise PresenterPlanError(f"{label} must be a finite number")
    return result


def _treatment(cue: dict[str, Any]) -> str:
    evidence = cue.get("sourceVideoEvidence")
    candidates = [cue.get("presenterTreatment")]
    if isinstance(evidence, dict):
        candidates.append(evidence.get("presenterTreatment"))
    return " ".join(str(value or "").strip().lower() for value in candidates).strip()


def cue_needs_presenter(cue: dict[str, Any]) -> tuple[bool, str]:
    visual_type = str(cue.get("visualType") or "").strip().lower()
    treatment = _treatment(cue)
    if cue.get("presenterVisible") is False:
        return False, "explicitly-hidden"
    if visual_type in EVIDENCE_VISUAL_TYPES:
        return False, "source-evidence"
    if any(token in treatment for token in HIDDEN_TREATMENTS):
        return False, "hidden-treatment"
    if cue.get("presenterVisible") is True:
        return True, "explicitly-visible"
    return True, "non-evidence-commentary"


def _split_interval(start: float, end: float, max_seconds: float) -> list[tuple[float, float]]:
    duration = end - start
    count = max(1, math.ceil(duration / max_seconds))
    slot = duration / count
    return [
        (round(start + slot * index, 3), round(start + slot * (index + 1), 3))
        for index in range(count)
    ]


def build_presenter_plan(
    visual_map: dict[str, Any],
    duration_seconds: float,
    merge_gap_seconds: float = 0.5,
    max_segment_seconds: float = 19.5,
) -> dict[str, Any]:
    if duration_seconds <= 0 or not math.isfinite(duration_seconds):
        raise PresenterPlanError("duration must be positive")
    if merge_gap_seconds < 0:
        raise PresenterPlanError("merge gap must not be negative")
    if max_segment_seconds <= 0 or max_segment_seconds > 20:
        raise PresenterPlanError("max presenter segment must be in (0, 20]")
    cues = visual_map.get("cues")
    if not isinstance(cues, list) or not cues:
        raise PresenterPlanError("visual map must contain cues")

    selected: list[dict[str, Any]] = []
    previous_start = -1.0
    for position, raw in enumerate(cues):
        if not isinstance(raw, dict):
            raise PresenterPlanError(f"cue {position} must be an object")
        index = int(raw.get("cueIndex", position))
        start = _number(raw.get("outputStartSeconds"), f"cue {index} start")
        end = _number(raw.get("outputEndSeconds"), f"cue {index} end")
        if start < 0 or end <= start or end > duration_seconds + 0.5 or start < previous_start:
            raise PresenterPlanError(f"cue {index} has invalid or unordered timestamps")
        previous_start = start
        include, reason = cue_needs_presenter(raw)
        if include:
            selected.append(
                {
                    "startSeconds": max(0.0, start),
                    "endSeconds": min(duration_seconds, end),
                    "cueIndices": [index],
                    "reasons": [reason],
                }
            )

    if not selected:
        raise PresenterPlanError("no presenter-led cue remains after evidence exclusions")

    merged: list[dict[str, Any]] = []
    for interval in selected:
        if merged and interval["startSeconds"] <= merged[-1]["endSeconds"] + merge_gap_seconds:
            merged[-1]["endSeconds"] = max(merged[-1]["endSeconds"], interval["endSeconds"])
            merged[-1]["cueIndices"].extend(interval["cueIndices"])
            merged[-1]["reasons"].extend(interval["reasons"])
        else:
            merged.append(dict(interval))

    segment_plan: list[dict[str, Any]] = []
    for interval in merged:
        for start, end in _split_interval(
            float(interval["startSeconds"]), float(interval["endSeconds"]), max_segment_seconds
        ):
            segment_plan.append(
                {
                    "index": len(segment_plan) + 1,
                    "start": start,
                    "duration": round(end - start, 3),
                    "end": end,
                    "cueIndices": list(interval["cueIndices"]),
                }
            )

    generation_seconds = round(sum(float(item["duration"]) for item in segment_plan), 3)
    saved_seconds = round(max(0.0, duration_seconds - generation_seconds), 3)
    return {
        "version": 1,
        "durationSeconds": round(duration_seconds, 3),
        "policy": {
            "default": "presenter-visible-on-non-evidence-cues",
            "evidenceVisualTypes": sorted(EVIDENCE_VISUAL_TYPES),
            "mergeGapSeconds": merge_gap_seconds,
            "maxSegmentSeconds": max_segment_seconds,
        },
        "presenterVisibleRanges": merged,
        "segment_plan": segment_plan,
        "generationSeconds": generation_seconds,
        "savedSeconds": saved_seconds,
        "savedRatio": round(saved_seconds / duration_seconds, 4),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--map", required=True, type=Path, dest="map_path")
    parser.add_argument("--duration", required=True, type=float)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--merge-gap-seconds", type=float, default=0.5)
    parser.add_argument("--max-segment-seconds", type=float, default=19.5)
    args = parser.parse_args()
    try:
        visual_map = json.loads(args.map_path.read_text(encoding="utf-8"))
        plan = build_presenter_plan(
            visual_map,
            args.duration,
            merge_gap_seconds=args.merge_gap_seconds,
            max_segment_seconds=args.max_segment_seconds,
        )
    except (OSError, json.JSONDecodeError, PresenterPlanError) as error:
        parser.error(str(error))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(plan, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(plan, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
