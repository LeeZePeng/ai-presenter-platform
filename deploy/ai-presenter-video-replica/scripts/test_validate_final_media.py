from __future__ import annotations

import unittest

from validate_final_media import parse_intervals, validate_probe


class FinalMediaValidationTests(unittest.TestCase):
    def test_parses_black_and_silence_intervals(self) -> None:
        log = "black_start:1.000 black_end:1.500 black_duration:0.500\nsilence_start: 4.2\nsilence_end: 5.5 | silence_duration: 1.3"
        self.assertEqual(parse_intervals(log, "black")[0]["durationSeconds"], 0.5)
        self.assertEqual(parse_intervals(log, "silence")[0]["startSeconds"], 4.2)

    def test_accepts_delivery_stream_contract(self) -> None:
        probe = {
            "streams": [
                {
                    "codec_type": "video",
                    "codec_name": "h264",
                    "pix_fmt": "yuv420p",
                    "color_range": "tv",
                    "color_space": "bt709",
                    "color_transfer": "bt709",
                    "color_primaries": "bt709",
                    "width": 1080,
                    "height": 1920,
                    "r_frame_rate": "30/1",
                },
                {"codec_type": "audio", "codec_name": "aac"},
            ]
        }
        errors, summary = validate_probe(probe, 1080, 1920, 30)
        self.assertEqual(errors, [])
        self.assertEqual(summary["framesPerSecond"], 30)

    def test_rejects_missing_audio_and_wrong_color_metadata(self) -> None:
        probe = {
            "streams": [
                {
                    "codec_type": "video",
                    "codec_name": "h264",
                    "pix_fmt": "yuv420p",
                    "color_range": "pc",
                    "color_space": None,
                    "color_transfer": None,
                    "color_primaries": None,
                    "width": 1080,
                    "height": 1920,
                    "r_frame_rate": "30/1",
                }
            ]
        }
        errors, _summary = validate_probe(probe, 1080, 1920, 30)
        self.assertIn("missing audio stream", errors)
        self.assertTrue(any("color_space" in error for error in errors))


if __name__ == "__main__":
    unittest.main()
