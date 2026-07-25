from __future__ import annotations

import unittest

from plan_selective_presenter import PresenterPlanError, build_presenter_plan


class SelectivePresenterPlanTests(unittest.TestCase):
    def test_keeps_commentary_and_excludes_evidence(self) -> None:
        visual_map = {
            "cues": [
                {"cueIndex": 0, "outputStartSeconds": 0, "outputEndSeconds": 12, "visualType": "presenter_primary"},
                {
                    "cueIndex": 1,
                    "outputStartSeconds": 12,
                    "outputEndSeconds": 42,
                    "visualType": "source_video_pip",
                    "sourceVideoEvidence": {"presenterTreatment": "hidden"},
                },
                {"cueIndex": 2, "outputStartSeconds": 42, "outputEndSeconds": 70, "visualType": "comparison"},
            ]
        }
        plan = build_presenter_plan(visual_map, 70, max_segment_seconds=19.5)
        self.assertEqual(
            [(item["startSeconds"], item["endSeconds"]) for item in plan["presenterVisibleRanges"]],
            [(0.0, 12.0), (42.0, 70)],
        )
        self.assertEqual(plan["generationSeconds"], 40.0)
        self.assertEqual(plan["savedSeconds"], 30.0)
        self.assertTrue(all(item["duration"] <= 19.5 for item in plan["segment_plan"]))

    def test_merges_short_non_evidence_gap(self) -> None:
        visual_map = {
            "cues": [
                {"outputStartSeconds": 0, "outputEndSeconds": 6, "visualType": "presenter"},
                {"outputStartSeconds": 6.3, "outputEndSeconds": 11, "visualType": "diagram"},
            ]
        }
        plan = build_presenter_plan(visual_map, 11, merge_gap_seconds=0.5)
        self.assertEqual(len(plan["presenterVisibleRanges"]), 1)
        self.assertEqual(plan["presenterVisibleRanges"][0]["cueIndices"], [0, 1])

    def test_explicit_hidden_non_evidence_is_excluded(self) -> None:
        visual_map = {
            "cues": [
                {"outputStartSeconds": 0, "outputEndSeconds": 5, "visualType": "diagram", "presenterVisible": False},
                {"outputStartSeconds": 5, "outputEndSeconds": 10, "visualType": "presenter"},
            ]
        }
        plan = build_presenter_plan(visual_map, 10)
        self.assertEqual(plan["generationSeconds"], 5.0)

    def test_requires_at_least_one_presenter_cue(self) -> None:
        visual_map = {
            "cues": [
                {"outputStartSeconds": 0, "outputEndSeconds": 10, "visualType": "source_video_pip"},
            ]
        }
        with self.assertRaises(PresenterPlanError):
            build_presenter_plan(visual_map, 10)


if __name__ == "__main__":
    unittest.main()
