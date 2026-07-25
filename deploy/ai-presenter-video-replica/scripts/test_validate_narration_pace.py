#!/usr/bin/env python3
from __future__ import annotations

import unittest

from validate_narration_pace import measure_script_units


class NarrationPaceTests(unittest.TestCase):
    def test_counts_chinese_and_spoken_product_tokens(self) -> None:
        self.assertEqual(
            measure_script_units("Kimi K3 刚发布，能力更便宜。"),
            {"hanCharacters": 8, "latinWords": 2, "digits": 1, "meaningfulUnits": 13},
        )


if __name__ == "__main__":
    unittest.main()
