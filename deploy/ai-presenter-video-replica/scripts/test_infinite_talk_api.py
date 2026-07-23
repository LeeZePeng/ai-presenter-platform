from __future__ import annotations

import argparse
import importlib.util
import unittest
from pathlib import Path
from unittest.mock import patch


SCRIPT = Path(__file__).with_name("infinite_talk_api.py")
SPEC = importlib.util.spec_from_file_location("infinite_talk_api", SCRIPT)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class PromptIdRecoveryTest(unittest.TestCase):
    def test_status_parser_removes_trailing_punctuation(self) -> None:
        result = {"data": [None, None, None, None, "任务执行完毕 (Prompt ID: 58c6225f)"]}
        self.assertEqual(MODULE.prompt_ids_from_status(result), ["58c6225f"])

    def test_history_resolves_short_prompt_id(self) -> None:
        full_id = "58c6225f-ad2e-4fdc-9503-6fed519d2618"

        def fake_http_json(_base: str, path: str, **_kwargs: object) -> dict:
            if path == "/history/58c6225f":
                return {}
            if path == "/history?max_items=200":
                return {full_id: {"outputs": {}}}
            raise AssertionError(path)

        with patch.object(MODULE, "http_json", side_effect=fake_http_json):
            resolved, history = MODULE.history_for_prompt("http://comfy", "58c6225f")

        self.assertEqual(resolved, full_id)
        self.assertEqual(list(history), [full_id])

    def test_ambiguous_prefix_is_rejected(self) -> None:
        with self.assertRaises(SystemExit):
            MODULE.matching_prompt_id("58c6225f", ["58c6225f-a", "58c6225f-b"])


class WorkerPoolTest(unittest.TestCase):
    def test_default_worker_uses_legacy_endpoints(self) -> None:
        args = argparse.Namespace(server="http://gpu:7860/", comfy_server="http://gpu:8188/", worker=None)
        self.assertEqual(MODULE.parse_workers(args), [("http://gpu:7860", "http://gpu:8188")])

    def test_repeated_workers_are_deduplicated(self) -> None:
        args = argparse.Namespace(
            server="unused",
            comfy_server="unused",
            worker=[
                "http://gpu:7860,http://gpu:8188",
                "http://gpu:7860/w1,http://gpu:8188/w1",
                "http://gpu:7860/w1,http://gpu:8188/w1",
            ],
        )
        self.assertEqual(
            MODULE.parse_workers(args),
            [
                ("http://gpu:7860", "http://gpu:8188"),
                ("http://gpu:7860/w1", "http://gpu:8188/w1"),
            ],
        )

    def test_invalid_worker_is_rejected(self) -> None:
        args = argparse.Namespace(server="unused", comfy_server="unused", worker=["http://gpu:7860"])
        with self.assertRaises(SystemExit):
            MODULE.parse_workers(args)


if __name__ == "__main__":
    unittest.main()
