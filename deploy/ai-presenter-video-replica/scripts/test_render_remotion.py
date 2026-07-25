#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path


SCRIPT = Path(__file__).with_name("render_remotion.py")
SPEC = importlib.util.spec_from_file_location("render_remotion", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class ConcurrencyAttemptsTests(unittest.TestCase):
    def test_caps_requested_and_fallbacks_to_host_cpu_count(self) -> None:
        self.assertEqual(MODULE.concurrency_attempts(16, [12, 8, 6, 4], 10), [10, 8, 6, 4])

    def test_deduplicates_values_after_clamping(self) -> None:
        self.assertEqual(MODULE.concurrency_attempts(16, [12, 10, 8], 8), [8])

    def test_keeps_declared_order_when_all_values_are_supported(self) -> None:
        self.assertEqual(MODULE.concurrency_attempts(8, [6, 4], 10), [8, 6, 4])


if __name__ == "__main__":
    unittest.main()
