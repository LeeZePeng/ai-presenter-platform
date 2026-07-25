from __future__ import annotations

import argparse
import importlib.util
import json
import tempfile
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

    def test_comfy_history_error_is_failed(self) -> None:
        history = {"prompt-1": {"status": {"status_str": "error", "completed": False}}}
        with patch.object(MODULE, "history_for_prompt", return_value=("prompt-1", history)):
            self.assertEqual(MODULE.comfy_prompt_state("http://comfy", "prompt-1"), "failed")

    def test_comfy_queue_prompt_is_active(self) -> None:
        queue = {"queue_running": [[1, "prompt-1"]], "queue_pending": []}
        with (
            patch.object(MODULE, "history_for_prompt", return_value=("prompt-1", {})),
            patch.object(MODULE, "http_json", return_value=queue),
        ):
            self.assertEqual(MODULE.comfy_prompt_state("http://comfy", "prompt-1"), "active")


class HttpJsonRetryTest(unittest.TestCase):
    class _Response:
        def __enter__(self) -> "HttpJsonRetryTest._Response":
            return self

        def __exit__(self, *_args: object) -> None:
            return None

        def read(self) -> bytes:
            return b'{"healthy": true}'

    def test_idempotent_get_retries_transient_disconnect(self) -> None:
        attempts = [ConnectionResetError("closed"), self._Response()]
        with (
            patch.object(MODULE.urllib.request, "urlopen", side_effect=attempts) as mocked,
            patch.object(MODULE.time, "sleep") as sleep,
        ):
            result = MODULE.http_json("http://comfy", "/system_stats", timeout=1)

        self.assertEqual(result, {"healthy": True})
        self.assertEqual(mocked.call_count, 2)
        sleep.assert_called_once_with(0.5)

    def test_post_is_not_retried_after_lost_response(self) -> None:
        with (
            patch.object(MODULE.urllib.request, "urlopen", side_effect=ConnectionResetError("closed")) as mocked,
            patch.object(MODULE.time, "sleep") as sleep,
            self.assertRaises(ConnectionResetError),
        ):
            MODULE.http_json("http://comfy", "/prompt", {"prompt": {}}, timeout=1)

        self.assertEqual(mocked.call_count, 1)
        sleep.assert_not_called()


class SubmitRetryTest(unittest.TestCase):
    def test_lost_prompt_is_resubmitted(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            args = argparse.Namespace(output_dir=Path(directory), submit_attempts=3)
            attempts = [
                {"saved": [], "retry_reason": "prompt_missing"},
                {"saved": ["segment.mp4"]},
            ]
            with patch.object(MODULE, "submit_once", side_effect=attempts) as mocked:
                result = MODULE.submit(args)

            self.assertEqual(mocked.call_count, 2)
            self.assertEqual(result["saved"], ["segment.mp4"])
            self.assertEqual(result["submit_attempt"], 2)
            stored = json.loads((Path(directory) / "result.json").read_text())
            self.assertEqual(stored["submit_attempt"], 2)

    def test_active_prompt_timeout_is_not_duplicated(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            args = argparse.Namespace(output_dir=Path(directory), submit_attempts=3)
            with patch.object(
                MODULE,
                "submit_once",
                return_value={"saved": [], "retry_reason": "poll_timeout"},
            ) as mocked:
                result = MODULE.submit(args)

            self.assertEqual(mocked.call_count, 1)
            self.assertEqual(result["retry_reason"], "poll_timeout")


class DirectWorkflowTest(unittest.TestCase):
    def test_history_workflow_is_reused_with_unique_inputs(self) -> None:
        template = {
            "audio": {"class_type": "LoadAudio", "inputs": {"audio": "audio.wav"}},
            "unused_audio": {"class_type": "LoadAudio", "inputs": {"audio": "sample.wav"}},
            "person": {"class_type": "LoadImage", "inputs": {"image": "person_ref.png"}},
            "output": {"class_type": "VHS_VideoCombine", "inputs": {"filename_prefix": "InfiniteTalk"}},
        }
        history = {"prompt-id": {"prompt": [0, "prompt-id", template, {}, []]}}

        extracted = MODULE.workflow_from_history(history)
        workflow = MODULE.direct_workflow(
            extracted,
            "person-unique.png",
            "audio-unique.wav",
            None,
            "InfiniteTalk-unique",
            {"seed": 77},
        )

        self.assertEqual(workflow["person"]["inputs"]["image"], "person-unique.png")
        self.assertEqual(workflow["audio"]["inputs"]["audio"], "audio-unique.wav")
        self.assertEqual(workflow["unused_audio"]["inputs"]["audio"], "sample.wav")
        self.assertEqual(workflow["output"]["inputs"]["filename_prefix"], "InfiniteTalk-unique")
        self.assertEqual(template["audio"]["inputs"]["audio"], "audio.wav")

    def test_checkpoint_loader_finds_completed_workflow(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            history_path = Path(directory) / "segments" / "segment-001" / "comfy_history.json"
            history_path.parent.mkdir(parents=True)
            history_path.write_text(
                json.dumps({"prompt-id": {"prompt": [0, "prompt-id", {"1": {"class_type": "Node"}}, {}, []]}})
            )

            workflow = MODULE.workflow_template_from_checkpoint(Path(directory))

            self.assertEqual(workflow, {"1": {"class_type": "Node"}})

    def test_checkpoint_loader_falls_back_to_bundled_template(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            workflow = MODULE.workflow_template_from_checkpoint(Path(directory))

            self.assertIsInstance(workflow, dict)
            self.assertIn("120", workflow)


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
