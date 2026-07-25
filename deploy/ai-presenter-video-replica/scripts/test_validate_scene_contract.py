#!/usr/bin/env python3
from __future__ import annotations

import copy
import unittest

from validate_scene_contract import SceneContractError, validate_scene_contract


def fixture() -> tuple[dict, dict]:
    visual_map = {
        "cues": [
            {
                "cueIndex": 0,
                "outputStartSeconds": 0,
                "outputEndSeconds": 5,
                "narrationText": "课程分成三个模块。",
                "replicationPlan": "三个模块按旁白依次点亮。",
                "semanticInventories": [
                    {
                        "label": "课程模块",
                        "count": 3,
                        "items": ["基础认知", "工具调用", "效果评估"],
                        "sourceEvidence": "原片 00:10 课程目录页",
                        "presentationMode": "list",
                    }
                ],
            }
        ]
    }
    implementation = {
        "version": 3,
        "cues": [
            {
                "cueIndex": 0,
                "sceneKey": "course-modules",
                "presenterVisible": True,
                "implementedElements": ["课程目录标题", "三张带完整名称的模块卡"],
                "motionEvents": ["0.3 秒标题入场", "2.0 秒模块逐项点亮"],
                "semanticLists": [
                    {
                        "label": "课程模块",
                        "presentationMode": "list",
                        "items": ["基础认知", "工具调用", "效果评估"],
                    }
                ],
                "layoutRegions": [
                    {"id": "main", "role": "primary", "bounds": [0.08, 0.08, 0.56, 0.58]},
                    {"id": "person", "role": "presenter", "bounds": [0.74, 0.08, 0.18, 0.22]},
                    {"id": "subtitles", "role": "caption", "bounds": [0.18, 0.82, 0.64, 0.12]},
                ],
            }
        ],
    }
    return visual_map, implementation


class SceneContractTests(unittest.TestCase):
    def test_accepts_grounded_list_and_non_overlapping_regions(self) -> None:
        visual_map, implementation = fixture()
        result = validate_scene_contract(visual_map, implementation)
        self.assertTrue(result["valid"])
        self.assertEqual(result["semanticInventoryCount"], 1)

    def test_rejects_placeholder_items(self) -> None:
        visual_map, implementation = fixture()
        visual_map["cues"][0]["semanticInventories"][0]["items"] = ["M1", "M2", "M3"]
        with self.assertRaisesRegex(SceneContractError, "placeholder"):
            validate_scene_contract(visual_map, implementation)

    def test_rejects_shifted_cue_indices(self) -> None:
        visual_map, implementation = fixture()
        implementation["cues"][0]["cueIndex"] = 1
        with self.assertRaisesRegex(SceneContractError, "exactly match"):
            validate_scene_contract(visual_map, implementation)

    def test_rejects_presenter_caption_collision(self) -> None:
        visual_map, implementation = fixture()
        bad = copy.deepcopy(implementation)
        bad["cues"][0]["layoutRegions"][1]["bounds"] = [0.70, 0.80, 0.20, 0.16]
        with self.assertRaisesRegex(SceneContractError, "presenter overlaps captions"):
            validate_scene_contract(visual_map, bad)


if __name__ == "__main__":
    unittest.main()
