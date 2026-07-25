#!/usr/bin/env python3
"""Validate semantic inventories and declared layout regions before full render."""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any


class SceneContractError(ValueError):
    pass


NUMBER_WORDS = {
    "一": 1,
    "二": 2,
    "两": 2,
    "三": 3,
    "四": 4,
    "五": 5,
    "六": 6,
    "七": 7,
    "八": 8,
    "九": 9,
    "十": 10,
}

ENUMERATION_RE = re.compile(
    r"(?<!第)(?P<number>\d+|[一二两三四五六七八九十]+)\s*"
    r"(?:个)?(?P<noun>模块|件事|块积木|种(?:常见)?(?:设计)?模式|级台阶|(?:执行)?步(?:骤)?|"
    r"条(?:建议|原则|结论|方法|规则|行动)|项(?:任务|要求|检查|行动)|个(?:阶段|环节|问题|要点|能力|部分|组件))"
)
PLACEHOLDER_RE = re.compile(
    r"(?:\bM\s*\d+\s*[-–—~至到]\s*M?\s*\d+\b|"
    r"\b(?:M|Item|Card|Module)\s*\d+\b|"
    r"(?:模块|卡片|节点|要点|项目)\s*[一二三四五六七八九十\d]+(?:\s|$|[、，,；;]))",
    re.IGNORECASE,
)
REPEATED_UI_RE = re.compile(r"标签|卡片|列表|逐(?:项|个|格)|矩阵|网格|节点")
VALID_ROLES = {"primary", "secondary", "caption", "presenter", "decoration", "chrome", "summary"}


def _chinese_number(value: str) -> int | None:
    if value.isdigit():
        return int(value)
    if value in NUMBER_WORDS:
        return NUMBER_WORDS[value]
    if value.startswith("十") and len(value) == 2 and value[1] in NUMBER_WORDS:
        return 10 + NUMBER_WORDS[value[1]]
    if value.endswith("十") and len(value) == 2 and value[0] in NUMBER_WORDS:
        return NUMBER_WORDS[value[0]] * 10
    if "十" in value and len(value) == 3:
        left, right = value.split("十", 1)
        if left in NUMBER_WORDS and right in NUMBER_WORDS:
            return NUMBER_WORDS[left] * 10 + NUMBER_WORDS[right]
    return None


def _detected_enumerations(text: str) -> list[tuple[int, str]]:
    result: list[tuple[int, str]] = []
    for match in ENUMERATION_RE.finditer(text):
        count = _chinese_number(match.group("number"))
        if count is not None and 2 <= count <= 30:
            result.append((count, match.group("noun")))
    return result


def _rect(value: Any, label: str) -> tuple[float, float, float, float]:
    if not isinstance(value, list) or len(value) != 4:
        raise SceneContractError(f"{label} bounds must be [x, y, width, height]")
    try:
        x, y, width, height = (float(item) for item in value)
    except (TypeError, ValueError) as error:
        raise SceneContractError(f"{label} bounds must contain numbers") from error
    if x < 0 or y < 0 or width <= 0 or height <= 0 or x + width > 1.0001 or y + height > 1.0001:
        raise SceneContractError(f"{label} bounds must stay inside normalized canvas")
    return x, y, width, height


def _intersection_ratio(a: tuple[float, float, float, float], b: tuple[float, float, float, float]) -> float:
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    overlap_w = max(0.0, min(ax + aw, bx + bw) - max(ax, bx))
    overlap_h = max(0.0, min(ay + ah, by + bh) - max(ay, by))
    overlap = overlap_w * overlap_h
    return overlap / min(aw * ah, bw * bh) if overlap else 0.0


def _validate_inventory(cue: dict[str, Any], cue_index: int, count: int, noun: str) -> dict[str, Any]:
    inventories = cue.get("semanticInventories")
    if not isinstance(inventories, list):
        raise SceneContractError(
            f"cue {cue_index} says {count}{noun} but has no semanticInventories contract"
        )
    matching = [item for item in inventories if isinstance(item, dict) and item.get("count") == count]
    if not matching:
        raise SceneContractError(f"cue {cue_index} has no semantic inventory with count={count}")
    inventory = matching[0]
    label = str(inventory.get("label") or "").strip()
    evidence = str(inventory.get("sourceEvidence") or "").strip()
    mode = str(inventory.get("presentationMode") or "").strip()
    items = inventory.get("items")
    if len(label) < 2 or len(evidence) < 4:
        raise SceneContractError(f"cue {cue_index} semantic inventory needs label and sourceEvidence")
    if mode == "list":
        if not isinstance(items, list) or len(items) != count:
            raise SceneContractError(f"cue {cue_index} {label} must provide exactly {count} items")
        normalized = [str(item).strip() for item in items]
        if any(len(item) < 2 or PLACEHOLDER_RE.search(item) for item in normalized):
            raise SceneContractError(f"cue {cue_index} {label} contains blank or placeholder item labels")
    elif mode == "count-only":
        if items not in (None, []):
            raise SceneContractError(f"cue {cue_index} count-only inventory must not include fake items")
        reason = str(inventory.get("unavailableReason") or "").strip()
        if len(reason) < 8:
            raise SceneContractError(f"cue {cue_index} count-only inventory needs an unavailableReason")
        plan = str(cue.get("replicationPlan") or "")
        if REPEATED_UI_RE.search(plan):
            raise SceneContractError(
                f"cue {cue_index} promises repeated UI for an unknown list; use one count visual instead"
            )
    else:
        raise SceneContractError(f"cue {cue_index} semantic inventory presentationMode must be list or count-only")
    return inventory


def validate_scene_contract(visual_map: Any, implementation: Any) -> dict[str, Any]:
    if not isinstance(visual_map, dict) or not isinstance(implementation, dict):
        raise SceneContractError("map and implementation roots must be objects")
    map_cues = visual_map.get("cues")
    impl_cues = implementation.get("cues")
    if not isinstance(map_cues, list) or not map_cues:
        raise SceneContractError("visual map has no cues")
    if not isinstance(impl_cues, list) or not impl_cues:
        raise SceneContractError("scene implementation has no cues")

    map_indices = [cue.get("cueIndex") for cue in map_cues if isinstance(cue, dict)]
    impl_indices = [cue.get("cueIndex") for cue in impl_cues if isinstance(cue, dict)]
    if map_indices != list(range(len(map_cues))):
        raise SceneContractError("visual-map cueIndex values must be zero-based, contiguous, and ordered")
    if impl_indices != map_indices:
        raise SceneContractError(
            f"scene cueIndex values must exactly match visual map; expected {map_indices}, got {impl_indices}"
        )

    enumeration_count = 0
    source_video_pip_count = 0
    for map_cue, impl_cue in zip(map_cues, impl_cues):
        cue_index = int(map_cue["cueIndex"])
        scene_key = str(impl_cue.get("sceneKey") or "").strip()
        presenter_visible = impl_cue.get("presenterVisible")
        elements = impl_cue.get("implementedElements")
        if len(scene_key) < 3 or not isinstance(presenter_visible, bool) or not isinstance(elements, list):
            raise SceneContractError(f"cue {cue_index} needs sceneKey, presenterVisible, and implementedElements")
        if map_cue.get("visualType") != "source_video_pip" and presenter_visible is not True:
            raise SceneContractError(f"cue {cue_index} has no moving source evidence, so the presenter must remain visible")
        element_text = " ".join(str(item) for item in elements)
        if PLACEHOLDER_RE.search(element_text):
            raise SceneContractError(f"cue {cue_index} contains placeholder enumeration labels: {element_text}")
        if map_cue.get("visualType") == "source_video_pip":
            planned = map_cue.get("sourceVideoEvidence")
            implemented = impl_cue.get("sourceVideoEvidence")
            if not isinstance(planned, dict) or not isinstance(implemented, dict):
                raise SceneContractError(f"cue {cue_index} source_video_pip needs matching sourceVideoEvidence")
            try:
                planned_start = float(planned.get("clipStartSeconds"))
                planned_end = float(planned.get("clipEndSeconds"))
                implemented_start = float(implemented.get("clipStartSeconds"))
                implemented_end = float(implemented.get("clipEndSeconds"))
                playback_rate = float(implemented.get("playbackRate"))
                evidence_bounds = _rect(
                    implemented.get("evidenceBounds"),
                    f"cue {cue_index} source evidence",
                )
            except (TypeError, ValueError) as error:
                raise SceneContractError(f"cue {cue_index} sourceVideoEvidence timestamps are invalid") from error
            if (
                abs(planned_start - implemented_start) > 0.05
                or abs(planned_end - implemented_end) > 0.05
                or implemented.get("audioMuted") is not True
                or playback_rate != 1
                or implemented.get("sourceAsset") != "source/sourceVideo.mp4"
                or implemented.get("layerMarker") != "source-video-pip"
                or "source-video-pip" not in element_text
            ):
                raise SceneContractError(f"cue {cue_index} does not implement the planned moving source clip")
            _ = evidence_bounds
            display_mode = str(implemented.get("displayMode") or "")
            object_fit = str(implemented.get("objectFit") or "")
            if display_mode not in {"detail-stage", "full-bleed"}:
                raise SceneContractError(f"cue {cue_index} source evidence needs detail-stage or full-bleed displayMode")
            if object_fit not in {"contain", "cover"}:
                raise SceneContractError(f"cue {cue_index} source evidence needs contain or cover objectFit")
            if implemented.get("presenterTreatment") != "crop-action-only" and object_fit != "contain":
                raise SceneContractError(
                    f"cue {cue_index} must use contain so the evaluated source video is not cropped"
                )
            source_video_pip_count += 1

        narration = str(map_cue.get("narrationText") or "")
        for count, noun in _detected_enumerations(narration):
            map_inventory = _validate_inventory(map_cue, cue_index, count, noun)
            impl_lists = impl_cue.get("semanticLists")
            if not isinstance(impl_lists, list):
                raise SceneContractError(f"cue {cue_index} must declare how its semantic inventory is rendered")
            label = map_inventory["label"]
            rendered = [item for item in impl_lists if isinstance(item, dict) and item.get("label") == label]
            if not rendered or rendered[0].get("presentationMode") != map_inventory.get("presentationMode"):
                raise SceneContractError(f"cue {cue_index} does not implement semantic inventory {label}")
            if map_inventory.get("presentationMode") == "list" and rendered[0].get("items") != map_inventory.get("items"):
                raise SceneContractError(f"cue {cue_index} rendered list does not match grounded items for {label}")
            enumeration_count += 1

        regions = impl_cue.get("layoutRegions")
        if not isinstance(regions, list) or len(regions) < 2:
            raise SceneContractError(f"cue {cue_index} needs primary and caption layoutRegions")
        parsed: list[tuple[str, str, tuple[float, float, float, float], dict[str, Any]]] = []
        for region_index, region in enumerate(regions):
            if not isinstance(region, dict):
                raise SceneContractError(f"cue {cue_index} layout region {region_index} must be an object")
            role = str(region.get("role") or "")
            name = str(region.get("id") or f"region-{region_index}")
            if role not in VALID_ROLES:
                raise SceneContractError(f"cue {cue_index} layout region {name} has invalid role {role}")
            parsed.append((role, name, _rect(region.get("bounds"), f"cue {cue_index} {name}"), region))
        roles = {role for role, _, _, _ in parsed}
        if not {"primary", "caption"}.issubset(roles):
            raise SceneContractError(f"cue {cue_index} must reserve primary and caption regions")
        if presenter_visible and "presenter" not in roles:
            raise SceneContractError(f"cue {cue_index} shows the presenter but has no presenter region")
        for left_index, (left_role, left_name, left_rect, left_raw) in enumerate(parsed):
            for right_role, right_name, right_rect, right_raw in parsed[left_index + 1 :]:
                ratio = _intersection_ratio(left_rect, right_rect)
                pair = {left_role, right_role}
                if ratio <= 0.01:
                    continue
                if pair == {"caption", "presenter"}:
                    raise SceneContractError(
                        f"cue {cue_index} presenter overlaps captions by {ratio:.1%}"
                    )
                if pair & {"caption", "presenter"} and pair & {"primary", "secondary", "summary", "chrome"}:
                    raise SceneContractError(
                        f"cue {cue_index} layout collision: {left_name} overlaps {right_name} by {ratio:.1%}"
                    )
                if pair == {"primary", "secondary"}:
                    raise SceneContractError(
                        f"cue {cue_index} secondary content overlaps primary content by {ratio:.1%}"
                    )
                if "decoration" in pair and pair & {"primary", "secondary"}:
                    decoration = left_raw if left_role == "decoration" else right_raw
                    if float(decoration.get("maxOpacity", 1.0)) > 0.08:
                        raise SceneContractError(
                            f"cue {cue_index} decoration crosses semantic content above 8% opacity"
                        )
        if "summary" in roles and "caption" in roles:
            summary_regions = [raw for role, _, _, raw in parsed if role == "summary"]
            if any(not str(raw.get("sourceEvidence") or "").strip() for raw in summary_regions):
                raise SceneContractError(
                    f"cue {cue_index} adds a summary beside captions without source evidence"
                )

    return {
        "valid": True,
        "cueCount": len(map_cues),
        "semanticInventoryCount": enumeration_count,
        "sourceVideoPipCount": source_video_pip_count,
        "layoutContractVersion": implementation.get("version"),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Validate cue semantics and declared frame layout")
    parser.add_argument("--map", required=True, type=Path, dest="map_path")
    parser.add_argument("--implementation", required=True, type=Path)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    try:
        visual_map = json.loads(args.map_path.read_text(encoding="utf-8"))
        implementation = json.loads(args.implementation.read_text(encoding="utf-8"))
        report = validate_scene_contract(visual_map, implementation)
        if args.output:
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    except (OSError, json.JSONDecodeError, SceneContractError) as error:
        parser.exit(2, f"scene contract validation failed: {error}\n")
    print(json.dumps(report, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
