#!/usr/bin/env python3
"""Direct Gradio/ComfyUI helper for InfiniteTalk digital-human video APIs."""

from __future__ import annotations

import argparse
import copy
import concurrent.futures
import hashlib
import json
import mimetypes
import random
import re
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from pathlib import Path


DEFAULT_SERVER = "http://106.75.239.93:7860"
DEFAULT_COMFY = "http://106.75.239.93:8188"
DEFAULT_NEG = (
    "bright tones, overexposed, static, blurred details, subtitles, style, works, paintings, images, static, "
    "overall gray, worst quality, low quality, JPEG compression residue, ugly, incomplete, extra fingers, poorly "
    "drawn hands, poorly drawn faces, deformed, disfigured, misshapen limbs, fused fingers, still picture, messy "
    "background, three legs, many people in the background, walking backwards"
)


def run(cmd: list[str]) -> None:
    subprocess.run(cmd, check=True)


def media_duration(path: Path) -> float:
    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    duration = float(result.stdout.strip())
    if duration <= 0:
        raise SystemExit(f"Invalid media duration: {path}")
    return duration


def media_dimensions(path: Path) -> tuple[int, int]:
    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height",
            "-of",
            "csv=p=0:s=x",
            str(path),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    try:
        width, height = (int(value) for value in result.stdout.strip().split("x", 1))
    except (TypeError, ValueError) as error:
        raise SystemExit(f"Invalid media dimensions: {path}") from error
    if width <= 0 or height <= 0:
        raise SystemExit(f"Invalid media dimensions: {path}")
    return width, height


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def generation_signature(args: argparse.Namespace, seed: int | None = None) -> dict[str, object]:
    return {
        "width": int(args.width),
        "height": int(args.height),
        "hd_enabled": bool(args.hd_enabled),
        "hd_res": int(args.hd_res),
        "fps": float(args.fps),
        "steps": int(args.steps),
        "blocks_to_swap": int(args.blocks_to_swap),
        "frame_size": int(args.frame_size),
        "mode": str(args.mode),
        "positive_prompt": str(args.pos),
        "negative_prompt": str(args.neg),
        "camera_control": bool(args.cam_ctrl),
        "pose_stabilize": bool(args.pose_stabilize),
        "seed": int(args.seed if seed is None else seed),
    }


def parse_workers(args: argparse.Namespace) -> list[tuple[str, str]]:
    values = list(getattr(args, "worker", None) or [])
    if not values:
        return [(str(args.server).rstrip("/"), str(args.comfy_server).rstrip("/"))]
    workers: list[tuple[str, str]] = []
    for value in values:
        server, separator, comfy_server = value.partition(",")
        server = server.strip().rstrip("/")
        comfy_server = comfy_server.strip().rstrip("/")
        if not separator or not server.startswith(("http://", "https://")) or not comfy_server.startswith(
            ("http://", "https://")
        ):
            raise SystemExit("Each --worker must be SERVER_URL,COMFY_URL")
        pair = (server, comfy_server)
        if pair not in workers:
            workers.append(pair)
    return workers


def expected_output_dimensions(args: argparse.Namespace) -> tuple[int, int]:
    width, height = int(args.width), int(args.height)
    if not args.hd_enabled:
        return width, height
    shortest = min(width, height)
    if shortest <= 0:
        raise SystemExit("InfiniteTalk width and height must be positive")
    scale = float(args.hd_res) / shortest
    output_width = max(2, int(round(width * scale / 2)) * 2)
    output_height = max(2, int(round(height * scale / 2)) * 2)
    return output_width, output_height


def add_bool_arg(parser: argparse.ArgumentParser, name: str, default: bool, help_text: str) -> None:
    dest = name.replace("-", "_")
    parser.add_argument(f"--{name}", dest=dest, action="store_true", help=help_text)
    parser.add_argument(f"--no-{name}", dest=dest, action="store_false", help=f"Disable {help_text}")
    parser.set_defaults(**{dest: default})


def http_json(base: str, path: str, payload: dict | None = None, timeout: int = 120) -> dict:
    body = None if payload is None else json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        base.rstrip("/") + path,
        data=body,
        method="GET" if payload is None else "POST",
        headers={"Content-Type": "application/json"} if payload is not None else {},
    )
    try:
        with urllib.request.urlopen(req, timeout=timeout) as response:
            data = response.read()
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", errors="replace")
        raise SystemExit(f"HTTP {exc.code} {path}: {detail[:2000]}") from exc
    return json.loads(data.decode("utf-8"))


def multipart_upload(base: str, paths: list[Path]) -> list[str]:
    boundary = f"----codex-gradio-{uuid.uuid4().hex}"
    chunks: list[bytes] = []
    for path in paths:
        if not path.exists():
            raise SystemExit(f"Missing file: {path}")
        mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
        chunks.append(f"--{boundary}\r\n".encode())
        chunks.append(f'Content-Disposition: form-data; name="files"; filename="{path.name}"\r\n'.encode())
        chunks.append(f"Content-Type: {mime}\r\n\r\n".encode())
        chunks.append(path.read_bytes())
        chunks.append(b"\r\n")
    chunks.append(f"--{boundary}--\r\n".encode())
    body = b"".join(chunks)
    req = urllib.request.Request(
        base.rstrip("/") + "/gradio_api/upload",
        data=body,
        method="POST",
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}", "Content-Length": str(len(body))},
    )
    with urllib.request.urlopen(req, timeout=240) as response:
        return json.loads(response.read().decode("utf-8"))


def comfy_upload_input(comfy_base: str, path: Path, remote_name: str) -> str:
    if not path.exists():
        raise SystemExit(f"Missing file: {path}")
    boundary = f"----codex-comfy-{uuid.uuid4().hex}"
    mime = mimetypes.guess_type(path.name)[0] or "application/octet-stream"
    body = b"".join(
        [
            f"--{boundary}\r\n".encode(),
            f'Content-Disposition: form-data; name="image"; filename="{remote_name}"\r\n'.encode(),
            f"Content-Type: {mime}\r\n\r\n".encode(),
            path.read_bytes(),
            b"\r\n",
            f"--{boundary}\r\n".encode(),
            b'Content-Disposition: form-data; name="type"\r\n\r\ninput\r\n',
            f"--{boundary}\r\n".encode(),
            b'Content-Disposition: form-data; name="overwrite"\r\n\r\ntrue\r\n',
            f"--{boundary}--\r\n".encode(),
        ]
    )
    request = urllib.request.Request(
        comfy_base.rstrip("/") + "/upload/image",
        data=body,
        method="POST",
        headers={"Content-Type": f"multipart/form-data; boundary={boundary}", "Content-Length": str(len(body))},
    )
    with urllib.request.urlopen(request, timeout=240) as response:
        uploaded = json.loads(response.read().decode("utf-8"))
    name = str(uploaded.get("name") or remote_name)
    subfolder = str(uploaded.get("subfolder") or "").strip("/")
    return f"{subfolder}/{name}" if subfolder else name


def filedata(local_path: Path, server_path: str) -> dict:
    return {
        "path": server_path,
        "url": None,
        "size": local_path.stat().st_size,
        "orig_name": local_path.name,
        "mime_type": mimetypes.guess_type(local_path.name)[0] or "application/octet-stream",
        "is_stream": False,
        "meta": {"_type": "gradio.FileData"},
    }


def summarize_status(result: dict) -> str:
    data = result.get("data", result)
    if not isinstance(data, list):
        return str(data)[:1000]
    status = data[1] if len(data) > 1 else ""
    queue = data[2] if len(data) > 2 else ""
    resources = data[3] if len(data) > 3 else ""
    logs = data[4] if len(data) > 4 else ""
    tail = "\n".join(str(logs).splitlines()[-8:]) if logs else ""
    return "\n".join(x for x in [f"STATUS: {status}", f"QUEUE: {queue}", f"RESOURCE: {resources}", tail] if x)


def prompt_ids_from_status(result: dict) -> list[str]:
    data = result.get("data", result)
    logs = data[4] if isinstance(data, list) and len(data) > 4 else ""
    prompt_ids: list[str] = []
    for line in str(logs).splitlines():
        match = re.search(r"Prompt ID:\s*([0-9a-f-]{8,64})", line, re.IGNORECASE)
        if match:
            prompt_id = match.group(1).rstrip("-")
            if prompt_id not in prompt_ids:
                prompt_ids.append(prompt_id)
    return prompt_ids


def matching_prompt_id(prompt_id: str, candidates: list[str]) -> str | None:
    normalized = prompt_id.strip().strip("()[]{}.,;:")
    if not normalized:
        return None
    exact = [item for item in candidates if item.lower() == normalized.lower()]
    if exact:
        return exact[0]
    matches = [item for item in candidates if item.lower().startswith(normalized.lower())]
    if len(matches) > 1:
        raise SystemExit(f"Ambiguous ComfyUI prompt ID prefix: {normalized}")
    return matches[0] if matches else None


def history_for_prompt(comfy_base: str, prompt_id: str) -> tuple[str, dict]:
    normalized = prompt_id.strip().strip("()[]{}.,;:")
    direct = http_json(comfy_base, f"/history/{normalized}", timeout=60)
    resolved = matching_prompt_id(normalized, list(direct))
    if resolved:
        return resolved, {resolved: direct[resolved]}

    history = http_json(comfy_base, "/history?max_items=200", timeout=60)
    resolved = matching_prompt_id(normalized, list(history))
    if resolved:
        return resolved, {resolved: history[resolved]}
    return normalized, {}


def videos_from_history(comfy_base: str, prompt_id: str, output_dir: Path) -> tuple[str, list[Path]]:
    resolved_prompt_id, history = history_for_prompt(comfy_base, prompt_id)
    output_dir.mkdir(parents=True, exist_ok=True)
    (output_dir / "comfy_history.json").write_text(json.dumps(history, ensure_ascii=False, indent=2))
    entry = history.get(resolved_prompt_id) or next(iter(history.values()), {})
    saved: list[Path] = []
    for output in entry.get("outputs", {}).values():
        for item in output.get("gifs", []) + output.get("videos", []):
            filename = item.get("filename")
            if not filename:
                continue
            query = urllib.parse.urlencode(
                {"filename": filename, "subfolder": item.get("subfolder", ""), "type": item.get("type", "output")}
            )
            with urllib.request.urlopen(comfy_base.rstrip("/") + "/view?" + query, timeout=600) as response:
                data = response.read()
            out = output_dir / filename
            out.write_bytes(data)
            saved.append(out)
    return resolved_prompt_id, saved


def comfy_prompt_state(comfy_base: str, prompt_id: str) -> str:
    _, history = history_for_prompt(comfy_base, prompt_id)
    if history:
        entry = next(iter(history.values()), {})
        status = entry.get("status", {}) if isinstance(entry, dict) else {}
        if isinstance(status, dict) and (
            str(status.get("status_str") or "").lower() == "error"
            or status.get("completed") is False
        ):
            return "failed"
        return "completed"
    queue = http_json(comfy_base, "/queue", timeout=60)
    queued_ids = [
        str(item[1])
        for key in ("queue_running", "queue_pending")
        for item in queue.get(key, [])
        if isinstance(item, list) and len(item) > 1
    ]
    return "active" if matching_prompt_id(prompt_id, queued_ids) else "missing"


def completed_result(args: argparse.Namespace, prompt_id: str, out_dir: Path, started_at: float) -> dict:
    resolved_prompt_id, saved = videos_from_history(args.comfy_server, prompt_id, out_dir)
    result = {
        "provider": "InfiniteTalk",
        "prompt_id": resolved_prompt_id,
        "audio_sha256": file_sha256(args.audio1),
        "person_image_sha256": file_sha256(args.person_img),
        "reference_video_sha256": file_sha256(args.ref_video),
        "generation": generation_signature(args),
        "output_dimensions": [
            {"path": str(path.resolve()), "width": media_dimensions(path)[0], "height": media_dimensions(path)[1]}
            for path in saved
        ],
        "saved": [str(path.resolve()) for path in saved],
        "elapsed_sec": round(time.time() - started_at),
    }
    if not saved:
        result["retry_reason"] = "completed_without_video"
    (out_dir / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2))
    return result


def workflow_from_history(history: dict) -> dict | None:
    for entry in history.values():
        if not isinstance(entry, dict):
            continue
        prompt = entry.get("prompt")
        if isinstance(prompt, list) and len(prompt) > 2 and isinstance(prompt[2], dict):
            return copy.deepcopy(prompt[2])
    return None


def workflow_template_from_checkpoint(checkpoint_dir: Path) -> dict | None:
    segments_dir = checkpoint_dir / "segments"
    for history_path in sorted(segments_dir.glob("segment-*/comfy_history.json")):
        try:
            history = json.loads(history_path.read_text())
        except (OSError, json.JSONDecodeError):
            continue
        workflow = workflow_from_history(history)
        if workflow:
            return workflow
    bundled_template = Path(__file__).resolve().parent.parent / "workflows" / "infinite_talk_image_api.json"
    try:
        workflow = json.loads(bundled_template.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    return workflow if isinstance(workflow, dict) else None


def direct_workflow(
    template: dict,
    person_name: str,
    audio_name: str,
    reference_video_name: str | None,
    output_prefix: str,
    generation: dict[str, object] | None = None,
) -> dict:
    workflow = copy.deepcopy(template)
    generation = generation or {}
    person_replaced = False
    audio_replaced = False
    for node in workflow.values():
        if not isinstance(node, dict):
            continue
        class_type = str(node.get("class_type") or "")
        inputs = node.get("inputs")
        if not isinstance(inputs, dict):
            continue
        if class_type == "LoadImage" and Path(str(inputs.get("image") or "")).name == "person_ref.png":
            inputs["image"] = person_name
            person_replaced = True
        if class_type == "LoadAudio" and Path(str(inputs.get("audio") or "")).name.lower() == "audio.wav":
            inputs["audio"] = audio_name
            audio_replaced = True
        if reference_video_name and "LoadVideo" in class_type and "video" in inputs:
            inputs["video"] = reference_video_name
        if class_type == "VHS_VideoCombine":
            inputs["filename_prefix"] = output_prefix
            inputs["images"] = ["334", 0] if bool(generation.get("hd_enabled")) else ["326", 0]
        if class_type == "WanVideoSampler" and "seed" in generation:
            inputs["seed"] = int(generation["seed"])
        if class_type == "WanVideoBlockSwap" and "blocks_to_swap" in generation:
            inputs["blocks_to_swap"] = int(generation["blocks_to_swap"])
        title = str((node.get("_meta") or {}).get("title") or "")
        if title == "Width" and "width" in generation:
            inputs["value"] = int(generation["width"])
        elif title == "Height" and "height" in generation:
            inputs["value"] = int(generation["height"])
        elif title == "frame_windows_size" and "frame_size" in generation:
            inputs["value"] = int(generation["frame_size"])
        elif title == "推理步数" and "steps" in generation:
            inputs["value"] = int(generation["steps"])
        elif title == "视频修复后分辨率(最短边)" and "hd_res" in generation:
            inputs["value"] = int(generation["hd_res"])
        if class_type == "FloatConstant" and "fps" in generation:
            inputs["value"] = float(generation["fps"])
    if "306" in workflow and "positive_prompt" in generation:
        workflow["306"]["inputs"]["text"] = str(generation["positive_prompt"])
    if "307" in workflow and "negative_prompt" in generation:
        workflow["307"]["inputs"]["text"] = str(generation["negative_prompt"])
    if not person_replaced or not audio_replaced:
        raise SystemExit("InfiniteTalk checkpoint workflow is missing the expected person/audio input nodes")
    return workflow


def detect_silence_points(audio: Path) -> list[float]:
    result = subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-nostats",
            "-i",
            str(audio),
            "-af",
            "silencedetect=noise=-35dB:d=0.25",
            "-f",
            "null",
            "-",
        ],
        capture_output=True,
        text=True,
    )
    points: list[float] = []
    starts: list[float] = []
    for line in result.stderr.splitlines():
        start_match = re.search(r"silence_start:\s*([0-9.]+)", line)
        if start_match:
            starts.append(float(start_match.group(1)))
        end_match = re.search(r"silence_end:\s*([0-9.]+)", line)
        if end_match:
            end = float(end_match.group(1))
            start = starts.pop(0) if starts else end
            points.append((start + end) / 2)
    return points


def plan_segments(
    duration: float,
    preferred_seconds: float = 19.5,
    min_seconds: float = 8,
    max_seconds: float = 20,
    silence_points: list[float] | None = None,
) -> list[tuple[float, float]]:
    if not 0 < min_seconds <= preferred_seconds <= max_seconds:
        raise SystemExit("Segment lengths must satisfy 0 < min <= preferred <= max")
    if duration <= max_seconds:
        return [(0.0, duration)]

    points = silence_points or []
    boundaries = [0.0]
    cursor = 0.0
    while duration - cursor > max_seconds:
        low = cursor + min_seconds
        high = min(cursor + max_seconds, duration - min_seconds)
        preferred = min(cursor + preferred_seconds, high)
        candidates = [point for point in points if low <= point <= high]
        boundary = min(candidates, key=lambda point: abs(point - preferred)) if candidates else preferred
        boundaries.append(boundary)
        cursor = boundary
    boundaries.append(duration)
    return [
        (round(start, 3), round(end - start, 3))
        for start, end in zip(boundaries, boundaries[1:])
        if end - start > 0.05
    ]


def valid_video(path: Path, expected_dimensions: tuple[int, int] | None = None) -> bool:
    if not path.exists() or path.stat().st_size <= 1024:
        return False
    try:
        if media_duration(path) <= 0:
            return False
        return expected_dimensions is None or media_dimensions(path) == expected_dimensions
    except (OSError, ValueError, subprocess.SubprocessError, SystemExit):
        return False


def existing_segment_video(
    receipt_path: Path,
    segment_dir: Path,
    expected_dimensions: tuple[int, int] | None = None,
) -> Path | None:
    if not receipt_path.exists():
        return None
    try:
        receipt = json.loads(receipt_path.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    for saved in receipt.get("saved", []):
        original = Path(saved)
        candidates = [segment_dir / original.name, original]
        for candidate in candidates:
            if valid_video(candidate, expected_dimensions):
                resolved = candidate.resolve()
                if str(resolved) != str(original):
                    rewritten: list[str] = []
                    for item in receipt.get("saved", []):
                        local = segment_dir / Path(item).name
                        rewritten.append(str((local if local.exists() else Path(item)).resolve()))
                    receipt["saved"] = rewritten
                    receipt_path.write_text(json.dumps(receipt, ensure_ascii=False, indent=2))
                return resolved
    return None


def recover_segment_video(
    comfy_base: str,
    receipt_path: Path,
    segment_dir: Path,
    segment_audio_hash: str,
    expected_dimensions: tuple[int, int] | None = None,
) -> Path | None:
    if not receipt_path.exists():
        return None
    try:
        receipt = json.loads(receipt_path.read_text())
    except (OSError, json.JSONDecodeError):
        return None
    prompt_id = str(receipt.get("prompt_id") or "")
    if not prompt_id or receipt.get("audio_sha256") != segment_audio_hash:
        return None
    try:
        resolved_prompt_id, saved = videos_from_history(comfy_base, prompt_id, segment_dir)
    except (OSError, ValueError, urllib.error.URLError):
        return None
    if not saved:
        return None
    receipt["prompt_id"] = resolved_prompt_id
    receipt["saved"] = [str(path.resolve()) for path in saved]
    receipt["recovered_from_comfy_history"] = True
    receipt_path.write_text(json.dumps(receipt, ensure_ascii=False, indent=2))
    return existing_segment_video(receipt_path, segment_dir, expected_dimensions)


def check_services(server: str, comfy_server: str) -> None:
    try:
        http_json(server, "/gradio_api/info", timeout=20)
        http_json(comfy_server, "/system_stats", timeout=20)
    except (OSError, ValueError, urllib.error.URLError) as exc:
        raise SystemExit(f"InfiniteTalk service health check failed: {exc}") from exc


def split_audio(audio: Path, output: Path, start: float, duration: float) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    run(
        [
            "ffmpeg",
            "-y",
            "-ss",
            f"{start:.3f}",
            "-t",
            f"{duration:.3f}",
            "-i",
            str(audio),
            "-vn",
            "-ac",
            "1",
            "-ar",
            "24000",
            "-c:a",
            "pcm_s16le",
            str(output),
        ]
    )


def stitch_segments(
    segment_videos: list[Path],
    segments: list[tuple[float, float]],
    audio: Path,
    output: Path,
    width: int,
    height: int,
    fps: float,
) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    inputs: list[str] = []
    filters: list[str] = []
    labels: list[str] = []
    for index, (video, (_, duration)) in enumerate(zip(segment_videos, segments)):
        inputs.extend(["-i", str(video)])
        label = f"v{index}"
        filters.append(
            f"[{index}:v]scale={width}:{height}:force_original_aspect_ratio=increase:flags=lanczos,"
            f"crop={width}:{height},fps={fps},"
            f"tpad=stop_mode=clone:stop_duration={duration:.3f},trim=duration={duration:.3f},"
            f"setpts=PTS-STARTPTS,format=yuv420p[{label}]"
        )
        labels.append(f"[{label}]")
    filters.append(f"{''.join(labels)}concat=n={len(labels)}:v=1:a=0[presenter]")
    audio_index = len(segment_videos)
    run(
        [
            "ffmpeg",
            "-y",
            *inputs,
            "-i",
            str(audio),
            "-filter_complex",
            ";".join(filters),
            "-map",
            "[presenter]",
            "-map",
            f"{audio_index}:a:0",
            "-t",
            f"{sum(duration for _, duration in segments):.3f}",
            "-c:v",
            "libx264",
            "-preset",
            "medium",
            "-crf",
            "18",
            "-c:a",
            "aac",
            "-b:a",
            "192k",
            "-movflags",
            "+faststart",
            str(output),
        ]
    )


def segmented_submit(args: argparse.Namespace) -> dict:
    checkpoint_dir = args.checkpoint_dir.resolve()
    checkpoint_dir.mkdir(parents=True, exist_ok=True)
    manifest_path = checkpoint_dir / "segments.json"
    duration = media_duration(args.audio)
    audio_sha256 = file_sha256(args.audio)
    existing_manifest: dict = {}
    if manifest_path.exists():
        try:
            existing_manifest = json.loads(manifest_path.read_text())
        except json.JSONDecodeError:
            existing_manifest = {}
    previous_audio_sha256 = existing_manifest.get("audio_sha256")
    if previous_audio_sha256 and previous_audio_sha256 != audio_sha256:
        raise SystemExit("Checkpoint narration differs from the current audio; use a new checkpoint directory")
    previous_hd_enabled = existing_manifest.get("hd_enabled")
    previous_hd_res = existing_manifest.get("hd_res")
    previous_requested_dimensions = existing_manifest.get("requested_dimensions")
    requested_dimensions_value = {"width": int(args.width), "height": int(args.height)}
    if previous_hd_enabled is not None and bool(previous_hd_enabled) != bool(args.hd_enabled):
        raise SystemExit("Checkpoint HD mode differs from the current request; use a new checkpoint directory")
    if previous_hd_res is not None and int(previous_hd_res) != int(args.hd_res):
        raise SystemExit("Checkpoint HD resolution differs from the current request; use a new checkpoint directory")
    if previous_requested_dimensions and previous_requested_dimensions != requested_dimensions_value:
        raise SystemExit("Checkpoint input dimensions differ from the current request; use a new checkpoint directory")
    seed = (
        args.seed
        if args.seed != -1
        else int(existing_manifest.get("seed") or random.SystemRandom().randint(1, 2**31 - 1))
    )
    segments = plan_segments(
        duration,
        preferred_seconds=args.segment_seconds,
        min_seconds=args.min_segment_seconds,
        max_seconds=args.max_segment_seconds,
        silence_points=detect_silence_points(args.audio),
    )
    workers = parse_workers(args)
    requested_dimensions = (int(args.width), int(args.height))
    expected_dimensions = expected_output_dimensions(args)
    expected_generation = generation_signature(args, seed=seed)
    records: dict[int, dict[str, object]] = {}
    manifest_lock = threading.Lock()
    workflow_template = workflow_template_from_checkpoint(checkpoint_dir)

    def write_manifest() -> None:
        ordered = [records[index] for index in sorted(records)]
        manifest = {
            "provider": "InfiniteTalk",
            "audio": str(args.audio.resolve()),
            "duration_seconds": duration,
            "audio_sha256": audio_sha256,
            "seed": seed,
            "requested_dimensions": {"width": requested_dimensions[0], "height": requested_dimensions[1]},
            "expected_output_dimensions": {"width": expected_dimensions[0], "height": expected_dimensions[1]},
            "hd_enabled": bool(args.hd_enabled),
            "hd_res": int(args.hd_res),
            "segment_plan": [
                {"index": index + 1, "start": start, "duration": segment_duration}
                for index, (start, segment_duration) in enumerate(segments)
            ],
            "worker_count": len(workers),
            "workers": [{"server": server, "comfy_server": comfy} for server, comfy in workers],
            "completed_segments": len(ordered),
            "presenterSegmentPaths": [str(record["video"]) for record in ordered],
            "infiniteTalkReceiptPaths": [str(record["receipt"]) for record in ordered],
            "segmentAudioSha256s": [str(record["audio_sha256"]) for record in ordered],
            "segmentVideoSha256s": [str(record["video_sha256"]) for record in ordered],
            "promptIds": [str(record["prompt_id"]) for record in ordered],
            "output": str(args.output_video.resolve()),
        }
        manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2))

    def process_segment(
        index: int,
        start: float,
        segment_duration: float,
        worker_index: int,
        worker: tuple[str, str],
    ) -> dict[str, object]:
        server, comfy_server = worker
        segment_dir = checkpoint_dir / "segments" / f"segment-{index:03d}"
        receipt_path = segment_dir / "result.json"
        worker_path = segment_dir / "worker.json"
        audio_path = segment_dir / "audio.wav"
        split_audio(args.audio, audio_path, start, segment_duration)
        segment_audio_hash = file_sha256(audio_path)
        video = existing_segment_video(receipt_path, segment_dir, expected_dimensions)
        if not video:
            video = recover_segment_video(
                comfy_server,
                receipt_path,
                segment_dir,
                segment_audio_hash,
                expected_dimensions,
            )
        receipt: dict = {}
        if video:
            receipt = json.loads(receipt_path.read_text())
            prompt_id = str(receipt.get("prompt_id") or "")
            segment_video_hash = file_sha256(video)
            invalid = {
                "missing_prompt_id": not prompt_id,
                "audio_sha256_mismatch": receipt.get("audio_sha256") != segment_audio_hash,
                "generation_mismatch": receipt.get("generation") != expected_generation,
                "duration_mismatch": abs(media_duration(video) - segment_duration) > 1.25,
                "dimension_mismatch": media_dimensions(video) != expected_dimensions,
            }
            if any(invalid.values()):
                (segment_dir / "invalid_checkpoint.json").write_text(
                    json.dumps({"reason": invalid, "receipt": receipt}, ensure_ascii=False, indent=2)
                )
                receipt_path.unlink(missing_ok=True)
                video.unlink(missing_ok=True)
                video = None
        if video:
            print_json({"step": "segment_skipped", "segment": index, "total": len(segments), "video": str(video)})
        else:
            if workflow_template:
                http_json(comfy_server, "/system_stats", timeout=20)
            else:
                check_services(server, comfy_server)
            worker_path.write_text(
                json.dumps(
                    {"worker_index": worker_index, "server": server, "comfy_server": comfy_server},
                    ensure_ascii=False,
                    indent=2,
                )
            )
            submit_args = argparse.Namespace(**vars(args))
            submit_args.server = server
            submit_args.comfy_server = comfy_server
            submit_args.audio1 = audio_path
            submit_args.audio2 = None
            submit_args.audio2_mode = "none"
            submit_args.output_dir = segment_dir
            submit_args.seed = seed
            print_json(
                {
                    "step": "segment_started",
                    "segment": index,
                    "total": len(segments),
                    "start": start,
                    "duration": segment_duration,
                    "worker": worker_index,
                }
            )
            result = (
                submit_direct(submit_args, workflow_template)
                if workflow_template
                else submit(submit_args)
            )
            video = existing_segment_video(receipt_path, segment_dir, expected_dimensions)
            if not result.get("saved") or not video:
                raise SystemExit(f"InfiniteTalk segment {index}/{len(segments)} did not return a valid MP4")
            result["audio_sha256"] = segment_audio_hash
            result["worker_index"] = worker_index
            result["server"] = server
            result["comfy_server"] = comfy_server
            receipt_path.write_text(json.dumps(result, ensure_ascii=False, indent=2))
            receipt = result
        prompt_id = str(receipt.get("prompt_id") or "")
        segment_video_hash = file_sha256(video)
        if not prompt_id:
            raise SystemExit(f"InfiniteTalk segment {index}/{len(segments)} has no prompt_id")
        if abs(media_duration(video) - segment_duration) > 1.25:
            raise SystemExit(f"InfiniteTalk segment {index}/{len(segments)} duration does not match its audio")
        if media_dimensions(video) != expected_dimensions:
            raise SystemExit(
                f"InfiniteTalk segment {index}/{len(segments)} dimensions do not match "
                f"{expected_dimensions[0]}x{expected_dimensions[1]}"
            )
        return {
            "index": index,
            "video": str(video.resolve()),
            "receipt": str(receipt_path.resolve()),
            "audio_sha256": segment_audio_hash,
            "video_sha256": segment_video_hash,
            "prompt_id": prompt_id,
        }

    def process_worker(worker_index: int, items: list[tuple[int, float, float]]) -> None:
        worker = workers[worker_index]
        for index, start, segment_duration in items:
            record = process_segment(index, start, segment_duration, worker_index, worker)
            with manifest_lock:
                records[index] = record
                write_manifest()

    if workflow_template is None:
        bootstrap_start, bootstrap_duration = segments[0]
        bootstrap_record = process_segment(1, bootstrap_start, bootstrap_duration, 0, workers[0])
        records[1] = bootstrap_record
        write_manifest()
        workflow_template = workflow_template_from_checkpoint(checkpoint_dir)
        if workflow_template is None:
            raise SystemExit("InfiniteTalk bootstrap segment did not produce a reusable ComfyUI workflow")

    assignments: list[list[tuple[int, float, float]]] = [[] for _ in workers]
    for index, (start, segment_duration) in enumerate(segments, start=1):
        assignments[(index - 1) % len(workers)].append((index, start, segment_duration))

    write_manifest()
    with concurrent.futures.ThreadPoolExecutor(max_workers=len(workers), thread_name_prefix="infinite-talk") as executor:
        futures = [
            executor.submit(process_worker, worker_index, items)
            for worker_index, items in enumerate(assignments)
            if items
        ]
        for future in concurrent.futures.as_completed(futures):
            future.result()

    ordered_records = [records[index] for index in range(1, len(segments) + 1)]
    prompt_ids = [str(record["prompt_id"]) for record in ordered_records]
    segment_video_hashes = [str(record["video_sha256"]) for record in ordered_records]
    if len(set(prompt_ids)) != len(prompt_ids):
        raise SystemExit("InfiniteTalk segments reused a prompt ID")
    if len(set(segment_video_hashes)) != len(segment_video_hashes):
        raise SystemExit("InfiniteTalk segments returned duplicate videos")
    segment_videos = [Path(str(record["video"])) for record in ordered_records]

    stitch_segments(
        segment_videos,
        segments,
        args.audio,
        args.output_video,
        expected_dimensions[0],
        expected_dimensions[1],
        args.fps,
    )
    if not valid_video(args.output_video):
        raise SystemExit("Segment stitching did not produce a valid MP4")
    write_manifest()
    return json.loads(manifest_path.read_text())


def prepare_assets(args: argparse.Namespace) -> dict:
    args.output_dir.mkdir(parents=True, exist_ok=True)
    person = args.output_dir / "person_ref.png"
    width = int(args.ref_width)
    height = int(args.ref_height)
    ref = args.output_dir / f"ref_vid_{int(args.duration)}s_{width}x{height}.mp4"
    source = args.source_image or args.source_video
    common_filter = (
        f"scale={width}:{height}:force_original_aspect_ratio=increase:flags=lanczos,"
        f"crop={width}:{height}"
    )
    still_input = ["-i", str(source)] if args.source_image else ["-ss", str(args.start), "-i", str(source)]
    run(["ffmpeg", "-y", *still_input, "-frames:v", "1", "-vf", f"{common_filter},format=rgb24", str(person)])

    video_input = ["-loop", "1", "-i", str(source)] if args.source_image else ["-ss", str(args.start), "-i", str(source)]
    run(
        [
            "ffmpeg",
            "-y",
            *video_input,
            "-t",
            str(args.duration),
            "-vf",
            f"{common_filter},fps={args.fps},format=yuv420p",
            "-an",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "23",
            "-movflags",
            "+faststart",
            str(ref),
        ]
    )
    return {"person_img": str(person), "ref_video": str(ref)}


def failed_submit_result(
    out_dir: Path,
    prompt_id: str | None,
    started_at: float,
    reason: str,
    last_status: dict | None = None,
) -> dict:
    if last_status:
        (out_dir / "last_status.json").write_text(json.dumps(last_status, ensure_ascii=False, indent=2))
    result = {
        "provider": "InfiniteTalk",
        "prompt_id": prompt_id,
        "saved": [],
        "retry_reason": reason,
        "elapsed_sec": round(time.time() - started_at),
    }
    (out_dir / "result.json").write_text(json.dumps(result, ensure_ascii=False, indent=2))
    return result


def submit_once(args: argparse.Namespace) -> dict:
    out_dir = args.output_dir
    out_dir.mkdir(parents=True, exist_ok=True)
    pending_path = out_dir / "pending_prompt.json"
    audio_sha256 = file_sha256(args.audio1)
    request_signature = generation_signature(args)
    if pending_path.exists():
        try:
            pending = json.loads(pending_path.read_text())
        except (OSError, ValueError):
            pending = {}
        pending_prompt_id = str(pending.get("prompt_id") or "")
        if (
            pending.get("audio_sha256") == audio_sha256
            and pending.get("generation") == request_signature
            and pending_prompt_id
        ):
            started_at = float(pending.get("started_at") or time.time())
            last_pending_state = "missing"
            for _ in range(args.max_polls):
                state = comfy_prompt_state(args.comfy_server, pending_prompt_id)
                last_pending_state = state
                print_json({"step": "resume_pending", "prompt_id": pending_prompt_id, "state": state})
                if state == "completed":
                    result = completed_result(args, pending_prompt_id, out_dir, started_at)
                    pending_path.unlink(missing_ok=True)
                    return result
                if state == "failed":
                    pending_path.unlink(missing_ok=True)
                    return failed_submit_result(out_dir, pending_prompt_id, started_at, "prompt_failed")
                if state == "missing":
                    break
                time.sleep(args.poll_seconds)
            if last_pending_state == "active":
                return failed_submit_result(out_dir, pending_prompt_id, started_at, "poll_timeout")
        pending_path.unlink(missing_ok=True)
    upload_paths = [args.person_img, args.ref_video, args.audio1]
    if args.audio2_mode == "file":
        if not args.audio2:
            raise SystemExit("--audio2 is required when --audio2-mode file.")
        upload_paths.append(args.audio2)
    server_paths = multipart_upload(args.server, upload_paths)

    person_fd = filedata(args.person_img, server_paths[0])
    video_fd = filedata(args.ref_video, server_paths[1])
    audio1_fd = filedata(args.audio1, server_paths[2])
    if args.audio2_mode == "none":
        audio2_value = None
    elif args.audio2_mode == "same":
        audio2_value = audio1_fd
    else:
        audio2_value = filedata(args.audio2, server_paths[3])

    payload = {
        "data": [
            args.mode,
            person_fd,
            {"video": video_fd, "subtitles": None},
            audio1_fd,
            audio2_value,
            args.pos,
            args.neg,
            args.width,
            args.height,
            args.steps,
            args.blocks_to_swap,
            args.frame_size,
            args.seed,
            args.hd_enabled,
            args.hd_res,
            args.fps,
            args.cam_ctrl,
            args.pose_stabilize,
        ],
        "event_data": None,
        "fn_index": 2,
        "session_hash": "codex_" + uuid.uuid4().hex[:12],
    }
    (out_dir / "submit_payload.redacted.json").write_text(json.dumps(payload, ensure_ascii=False, indent=2))
    try:
        baseline_status = http_json(
            args.server, "/gradio_api/run/check_and_get_video", {"data": [], "fn_index": 5}, timeout=120
        )
        baseline_prompt_ids = set(prompt_ids_from_status(baseline_status))
    except (OSError, ValueError, urllib.error.URLError, SystemExit):
        baseline_prompt_ids = set()
    submitted = http_json(args.server, "/gradio_api/run/add_to_queue_wrapper", payload, timeout=240)
    print_json({"step": "submitted", "response": submitted})

    prompt_id = None
    last_result: dict | None = None
    start = time.time()
    missing_polls = 0
    max_missing_polls = max(1, int(getattr(args, "missing_prompt_polls", 3)))
    max_discovery_polls = max(1, int(getattr(args, "prompt_discovery_polls", 6)))
    for index in range(args.max_polls):
        time.sleep(args.poll_seconds)
        result = http_json(args.server, "/gradio_api/run/check_and_get_video", {"data": [], "fn_index": 5}, timeout=120)
        last_result = result
        new_prompt_ids = [item for item in prompt_ids_from_status(result) if item not in baseline_prompt_ids]
        if new_prompt_ids:
            prompt_id = new_prompt_ids[-1]
            pending_path.write_text(
                json.dumps(
                    {
                        "prompt_id": prompt_id,
                        "audio_sha256": audio_sha256,
                        "generation": request_signature,
                        "started_at": start,
                    },
                    ensure_ascii=False,
                    indent=2,
                )
            )
        summary = summarize_status(result)
        print_json({"step": "poll", "elapsed_sec": round(time.time() - start), "summary": summary[-3000:]})
        if prompt_id:
            state = comfy_prompt_state(args.comfy_server, prompt_id)
            print_json({"step": "prompt_state", "prompt_id": prompt_id, "state": state})
            if state == "completed":
                completed = completed_result(args, prompt_id, out_dir, start)
                pending_path.unlink(missing_ok=True)
                return completed
            if state == "failed":
                pending_path.unlink(missing_ok=True)
                return failed_submit_result(out_dir, prompt_id, start, "prompt_failed", last_result)
            if state == "missing":
                missing_polls += 1
                if missing_polls >= max_missing_polls:
                    pending_path.unlink(missing_ok=True)
                    return failed_submit_result(out_dir, prompt_id, start, "prompt_missing", last_result)
            else:
                missing_polls = 0
        elif index + 1 >= max_discovery_polls:
            return failed_submit_result(out_dir, None, start, "prompt_not_discovered", last_result)
    return failed_submit_result(out_dir, prompt_id, start, "poll_timeout", last_result)


def submit(args: argparse.Namespace) -> dict:
    attempts = max(1, int(getattr(args, "submit_attempts", 3)))
    retryable_reasons = {"prompt_missing", "prompt_not_discovered", "completed_without_video"}
    last_result: dict = {}
    for attempt in range(1, attempts + 1):
        last_result = submit_once(args)
        last_result["submit_attempt"] = attempt
        (args.output_dir / "result.json").write_text(json.dumps(last_result, ensure_ascii=False, indent=2))
        if last_result.get("saved"):
            return last_result
        reason = str(last_result.get("retry_reason") or "")
        if reason not in retryable_reasons or attempt >= attempts:
            return last_result
        print_json(
            {
                "step": "retry_submission",
                "attempt": attempt + 1,
                "max_attempts": attempts,
                "reason": reason,
            }
        )
    return last_result


def wait_for_direct_prompt(
    args: argparse.Namespace,
    prompt_id: str,
    out_dir: Path,
    pending_path: Path,
    started_at: float,
) -> dict:
    missing_polls = 0
    max_missing_polls = max(1, int(getattr(args, "missing_prompt_polls", 3)))
    for _ in range(args.max_polls):
        state = comfy_prompt_state(args.comfy_server, prompt_id)
        print_json({"step": "direct_prompt_state", "prompt_id": prompt_id, "state": state})
        if state == "completed":
            completed = completed_result(args, prompt_id, out_dir, started_at)
            pending_path.unlink(missing_ok=True)
            return completed
        if state == "failed":
            pending_path.unlink(missing_ok=True)
            return failed_submit_result(out_dir, prompt_id, started_at, "prompt_failed")
        if state == "missing":
            missing_polls += 1
            if missing_polls >= max_missing_polls:
                pending_path.unlink(missing_ok=True)
                return failed_submit_result(out_dir, prompt_id, started_at, "prompt_missing")
        else:
            missing_polls = 0
        time.sleep(args.poll_seconds)
    return failed_submit_result(out_dir, prompt_id, started_at, "poll_timeout")


def submit_direct_once(args: argparse.Namespace, workflow_template: dict) -> dict:
    out_dir = args.output_dir
    out_dir.mkdir(parents=True, exist_ok=True)
    pending_path = out_dir / "pending_prompt.json"
    audio_sha256 = file_sha256(args.audio1)
    request_signature = generation_signature(args)
    if pending_path.exists():
        try:
            pending = json.loads(pending_path.read_text())
        except (OSError, json.JSONDecodeError):
            pending = {}
        pending_prompt_id = str(pending.get("prompt_id") or "")
        if (
            pending.get("audio_sha256") == audio_sha256
            and pending.get("generation") == request_signature
            and pending_prompt_id
        ):
            state = comfy_prompt_state(args.comfy_server, pending_prompt_id)
            print_json({"step": "direct_resume_pending", "prompt_id": pending_prompt_id, "state": state})
            if state == "completed":
                completed = completed_result(
                    args,
                    pending_prompt_id,
                    out_dir,
                    float(pending.get("started_at") or time.time()),
                )
                pending_path.unlink(missing_ok=True)
                return completed
            if state == "active":
                return wait_for_direct_prompt(
                    args,
                    pending_prompt_id,
                    out_dir,
                    pending_path,
                    float(pending.get("started_at") or time.time()),
                )
            if state == "failed":
                pending_path.unlink(missing_ok=True)
                return failed_submit_result(out_dir, pending_prompt_id, time.time(), "prompt_failed")
        pending_path.unlink(missing_ok=True)

    token = uuid.uuid4().hex
    person_name = comfy_upload_input(args.comfy_server, args.person_img, f"person-{token}.png")
    audio_name = comfy_upload_input(args.comfy_server, args.audio1, f"audio-{token}.wav")
    needs_reference_video = any(
        isinstance(node, dict) and "LoadVideo" in str(node.get("class_type") or "")
        for node in workflow_template.values()
    )
    reference_video_name = (
        comfy_upload_input(args.comfy_server, args.ref_video, f"reference-{token}.mp4")
        if needs_reference_video
        else None
    )
    workflow = direct_workflow(
        workflow_template,
        person_name,
        audio_name,
        reference_video_name,
        f"InfiniteTalk-{token[:12]}",
        request_signature,
    )
    started_at = time.time()
    submitted = http_json(
        args.comfy_server,
        "/prompt",
        {"prompt": workflow, "client_id": f"codex-{token[:16]}"},
        timeout=240,
    )
    prompt_id = str(submitted.get("prompt_id") or "")
    if not prompt_id:
        return failed_submit_result(out_dir, None, started_at, "prompt_not_discovered", submitted)
    pending_path.write_text(
        json.dumps(
            {
                "prompt_id": prompt_id,
                "audio_sha256": audio_sha256,
                "generation": request_signature,
                "started_at": started_at,
                "direct_comfy": True,
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    print_json({"step": "direct_submitted", "prompt_id": prompt_id, "comfy_server": args.comfy_server})
    return wait_for_direct_prompt(args, prompt_id, out_dir, pending_path, started_at)


def submit_direct(args: argparse.Namespace, workflow_template: dict) -> dict:
    attempts = max(1, int(getattr(args, "submit_attempts", 3)))
    retryable_reasons = {"prompt_missing", "prompt_not_discovered", "completed_without_video"}
    last_result: dict = {}
    for attempt in range(1, attempts + 1):
        last_result = submit_direct_once(args, workflow_template)
        last_result["submit_attempt"] = attempt
        last_result["direct_comfy"] = True
        (args.output_dir / "result.json").write_text(json.dumps(last_result, ensure_ascii=False, indent=2))
        if last_result.get("saved"):
            return last_result
        reason = str(last_result.get("retry_reason") or "")
        if reason not in retryable_reasons or attempt >= attempts:
            return last_result
        print_json(
            {
                "step": "retry_direct_submission",
                "attempt": attempt + 1,
                "max_attempts": attempts,
                "reason": reason,
            }
        )
    return last_result


def print_json(data: dict) -> None:
    print(json.dumps(data, ensure_ascii=False, indent=2), flush=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="cmd", required=True)

    prep = sub.add_parser("prepare-assets", help="Create a still person image and short reference video")
    prep_source = prep.add_mutually_exclusive_group(required=True)
    prep_source.add_argument("--source-video", type=Path)
    prep_source.add_argument("--source-image", type=Path)
    prep.add_argument("--output-dir", type=Path, required=True)
    prep.add_argument("--start", type=float, default=1)
    prep.add_argument("--duration", type=float, default=10)
    prep.add_argument("--ref-width", type=float, default=480)
    prep.add_argument("--ref-height", type=float, default=832)
    prep.add_argument("--fps", type=float, default=25)

    status = sub.add_parser("status", help="Check Gradio status")
    status.add_argument("--server", default=DEFAULT_SERVER)

    submit_parser = sub.add_parser("submit", help="Submit and download an InfiniteTalk video")
    submit_parser.add_argument("--server", default=DEFAULT_SERVER)
    submit_parser.add_argument("--comfy-server", default=DEFAULT_COMFY)
    submit_parser.add_argument("--person-img", type=Path, required=True)
    submit_parser.add_argument("--ref-video", type=Path, required=True)
    submit_parser.add_argument("--audio1", type=Path, required=True)
    submit_parser.add_argument("--audio2", type=Path)
    submit_parser.add_argument("--audio2-mode", choices=["none", "same", "file"], default="none")
    submit_parser.add_argument("--output-dir", type=Path, required=True)
    submit_parser.add_argument("--mode", choices=["图片数字人", "视频数字人"], default="图片数字人")
    submit_parser.add_argument("--pos", default="人物正在说话，手势动作自然，头部动作自然，富有感染力")
    submit_parser.add_argument("--neg", default=DEFAULT_NEG)
    submit_parser.add_argument("--width", type=float, default=480)
    submit_parser.add_argument("--height", type=float, default=832)
    submit_parser.add_argument("--steps", type=float, default=4)
    submit_parser.add_argument("--blocks-to-swap", type=float, default=0)
    submit_parser.add_argument("--frame-size", type=float, default=81)
    submit_parser.add_argument("--seed", type=int, default=-1)
    submit_parser.add_argument("--hd-enabled", action="store_true")
    submit_parser.add_argument("--hd-res", type=float, default=720)
    submit_parser.add_argument("--fps", type=float, default=25)
    add_bool_arg(submit_parser, "cam-ctrl", True, "camera control")
    add_bool_arg(submit_parser, "pose-stabilize", True, "pose stabilization")
    submit_parser.add_argument("--poll-seconds", type=float, default=10)
    submit_parser.add_argument("--max-polls", type=int, default=240)
    submit_parser.add_argument("--submit-attempts", type=int, default=3)
    submit_parser.add_argument("--missing-prompt-polls", type=int, default=3)
    submit_parser.add_argument("--prompt-discovery-polls", type=int, default=6)

    segmented_parser = sub.add_parser(
        "segmented-submit",
        help="Generate long narration in resumable segments and stitch the returned videos",
    )
    segmented_parser.add_argument("--server", default=DEFAULT_SERVER)
    segmented_parser.add_argument("--comfy-server", default=DEFAULT_COMFY)
    segmented_parser.add_argument(
        "--worker",
        action="append",
        help="Repeat SERVER_URL,COMFY_URL to process independent segments concurrently",
    )
    segmented_parser.add_argument("--person-img", type=Path, required=True)
    segmented_parser.add_argument("--ref-video", type=Path, required=True)
    segmented_parser.add_argument("--audio", type=Path, required=True)
    segmented_parser.add_argument("--checkpoint-dir", type=Path, required=True)
    segmented_parser.add_argument("--output-video", type=Path, required=True)
    segmented_parser.add_argument("--segment-seconds", type=float, default=19.5)
    segmented_parser.add_argument("--min-segment-seconds", type=float, default=8)
    segmented_parser.add_argument("--max-segment-seconds", type=float, default=20)
    segmented_parser.add_argument("--mode", choices=["图片数字人", "视频数字人"], default="图片数字人")
    segmented_parser.add_argument("--pos", default="人物正在说话，手势动作自然，头部动作自然，富有感染力")
    segmented_parser.add_argument("--neg", default=DEFAULT_NEG)
    segmented_parser.add_argument("--width", type=float, default=480)
    segmented_parser.add_argument("--height", type=float, default=832)
    segmented_parser.add_argument("--steps", type=float, default=4)
    segmented_parser.add_argument("--blocks-to-swap", type=float, default=0)
    segmented_parser.add_argument("--frame-size", type=float, default=81)
    segmented_parser.add_argument("--seed", type=int, default=-1)
    segmented_parser.add_argument("--hd-enabled", action="store_true")
    segmented_parser.add_argument("--hd-res", type=float, default=720)
    segmented_parser.add_argument("--fps", type=float, default=25)
    add_bool_arg(segmented_parser, "cam-ctrl", True, "camera control")
    add_bool_arg(segmented_parser, "pose-stabilize", True, "pose stabilization")
    segmented_parser.add_argument("--poll-seconds", type=float, default=10)
    segmented_parser.add_argument("--max-polls", type=int, default=240)
    segmented_parser.add_argument("--submit-attempts", type=int, default=3)
    segmented_parser.add_argument("--missing-prompt-polls", type=int, default=3)
    segmented_parser.add_argument("--prompt-discovery-polls", type=int, default=6)

    args = parser.parse_args()
    if args.cmd == "prepare-assets":
        print_json(prepare_assets(args))
    elif args.cmd == "status":
        print_json(http_json(args.server, "/gradio_api/run/check_and_get_video", {"data": [], "fn_index": 5}))
    elif args.cmd == "submit":
        result = submit(args)
        print_json(result)
        if not result.get("saved"):
            return 1
    elif args.cmd == "segmented-submit":
        result = segmented_submit(args)
        print_json(result)
    return 0


if __name__ == "__main__":
    sys.exit(main())
