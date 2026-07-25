from __future__ import annotations

import unittest

from prepare_selective_presenter_track import SelectiveTrackError, build_timeline_parts, validate_plan


class SelectivePresenterTrackTests(unittest.TestCase):
    def test_builds_leading_middle_and_trailing_black_parts(self) -> None:
        plan = {
            "durationSeconds": 30,
            "segment_plan": [
                {"index": 1, "start": 2, "duration": 5},
                {"index": 2, "start": 12, "duration": 8},
            ],
        }
        duration, segments = validate_plan(plan, 2)
        parts = build_timeline_parts(duration, segments)
        self.assertEqual([part["kind"] for part in parts], ["black", "presenter", "black", "presenter", "black"])
        self.assertAlmostEqual(sum(part["duration"] for part in parts), 30)

    def test_adjacent_presenter_segments_do_not_insert_black_frame(self) -> None:
        plan = {
            "durationSeconds": 12,
            "segment_plan": [
                {"index": 1, "start": 0, "duration": 6},
                {"index": 2, "start": 6, "duration": 6},
            ],
        }
        duration, segments = validate_plan(plan, 2)
        parts = build_timeline_parts(duration, segments)
        self.assertEqual([part["kind"] for part in parts], ["presenter", "presenter"])

    def test_rejects_input_count_mismatch(self) -> None:
        with self.assertRaises(SelectiveTrackError):
            validate_plan({"durationSeconds": 10, "segment_plan": []}, 1)


if __name__ == "__main__":
    unittest.main()
