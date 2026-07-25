from __future__ import annotations

import unittest

from prepare_caption_pages import paginate_caption, prepare_timeline


class CaptionPageTests(unittest.TestCase):
    def test_does_not_split_model_name(self) -> None:
        text = "不过在网络安全任务上仍然落后于 Mythos 5。这个差距值得认真看。"
        pages = paginate_caption(text, max_units=18, min_last_units=5)
        self.assertEqual("".join(pages), text)
        self.assertTrue(any("Mythos 5" in page for page in pages))
        self.assertFalse(any(page.startswith("os 5") for page in pages))

    def test_preserves_custom_product_name(self) -> None:
        text = "这一次我们重点测试 Super Model X 的完整演示能力。"
        pages = paginate_caption(text, max_units=15, terms=["Super Model X"])
        self.assertTrue(any("Super Model X" in page for page in pages))

    def test_adds_pages_without_replacing_timing_or_text(self) -> None:
        timeline = {"segments": [{"startSeconds": 0, "endSeconds": 3, "text": "Kimi K3 的成本很关键。"}]}
        prepared, report = prepare_timeline(timeline, 12, 4, [])
        segment = prepared["segments"][0]
        self.assertEqual(segment["startSeconds"], 0)
        self.assertEqual("".join(segment["pages"]), segment["text"])
        self.assertEqual(report["captionCount"], 1)


if __name__ == "__main__":
    unittest.main()
