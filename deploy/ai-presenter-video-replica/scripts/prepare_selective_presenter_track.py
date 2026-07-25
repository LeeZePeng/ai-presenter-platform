#!/usr/bin/env python3
"""Build one exact-duration presenter track with black gaps for evidence scenes."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import os
import subprocess
from pathlib import Path
from typing import Any


class SelectiveTrackError(ValueError):
    pass


def read_object(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise SelectiveTrackError(f"JSON root must be an object: {path}")
    return value


def atomic_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def probe(path: Path, ffprobe_bin: str) -> dict[str, Any]:
    result = subprocess.run(
        [
            ffprobe_bin,
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height,avg_frame_rate:format=duration",
            "-of",
            "json",
            str(path),
        ],
        check=True,
        capture_output=True,
        text=True,
        timeout=30,
    )
    value = json.loads(result.stdout)
    streams = value.get("streams") or []
    if not streams:
        raise SelectiveTrackError(f"missing video stream: {path}")
    stream = streams[0]
    return {
        "width": int(stream.get("width") or 0),
        "height": int(stream.get("height") or 0),
        "frameRate": str(stream.get("avg_frame_rate") or "25/1"),
        "durationSeconds": float((value.get("format") or {}).get("duration") or 0),
    }


def validate_plan(plan: dict[str, Any], input_count: int) -> tuple[float, list[dict[str, float]]]:
    try:
        timeline_duration = float(plan["durationSeconds"])
    except (KeyError, TypeError, ValueError) as error:
        raise SelectiveTrackError("plan.durationSeconds must be positive") from error
    raw_segments = plan.get("segment_plan")
    if not math.isfinite(timeline_duration) or timeline_duration <= 0:
        raise SelectiveTrackError("plan.durationSeconds must be positive")
    if not isinstance(raw_segments, list) or len(raw_segments) != input_count:
        raise SelectiveTrackError("segment plan count must match presenter input count")
    segments: list[dict[str, float]] = []
    previous_end = 0.0
    for position, raw in enumerate(raw_segments, start=1):
        if not isinstance(raw, dict) or int(raw.get("index", position)) != position:
            raise SelectiveTrackError("segment plan indices must be one-based and contiguous")
        try:
            start = float(raw["start"])
            duration = float(raw["duration"])
        except (KeyError, TypeError, ValueError) as error:
            raise SelectiveTrackError(f"segment {position} needs numeric start and duration") from error
        end = start + duration
        if (
            not all(math.isfinite(number) for number in (start, duration, end))
            or start < previous_end - 0.001
            or duration <= 0
            or end > timeline_duration + 0.5
        ):
            raise SelectiveTrackError(f"segment {position} overlaps or exceeds the timeline")
        segments.append({"start": start, "duration": duration, "end": end})
        previous_end = end
    return timeline_duration, segments


def build_timeline_parts(timeline_duration: float, segments: list[dict[str, float]]) -> list[dict[str, Any]]:
    parts: list[dict[str, Any]] = []
    cursor = 0.0
    for input_index, segment in enumerate(segments):
        start, end = segment["start"], segment["end"]
        if start > cursor + 0.001:
            parts.append({"kind": "black", "duration": start - cursor})
        parts.append({"kind": "presenter", "duration": segment["duration"], "inputIndex": input_index})
        cursor = end
    if timeline_duration > cursor + 0.001:
        parts.append({"kind": "black", "duration": timeline_duration - cursor})
    return parts


def render_track(
    inputs: list[Path],
    parts: list[dict[str, Any]],
    output: Path,
    width: int,
    height: int,
    frame_rate: str,
    timeline_duration: float,
    ffmpeg_bin: str,
    timeout_seconds: int,
) -> None:
    command = [ffmpeg_bin, "-y", "-hide_banner"]
    for item in inputs:
        command.extend(["-i", str(item)])
    filters: list[str] = []
    labels: list[str] = []
    for part_index, part in enumerate(parts):
        label = f"part{part_index}"
        duration = float(part["duration"])
        if part["kind"] == "black":
            filters.append(
                f"color=c=black:s={width}x{height}:r={frame_rate}:d={duration:.6f},"
                f"format=yuv420p,setpts=PTS-STARTPTS[{label}]"
            )
        else:
            input_index = int(part["inputIndex"])
            filters.append(
                f"[{input_index}:v]scale={width}:{height}:force_original_aspect_ratio=increase:flags=lanczos,"
                f"crop={width}:{height},fps={frame_rate},"
                f"tpad=stop_mode=clone:stop_duration={duration:.6f},trim=duration={duration:.6f},"
                f"setpts=PTS-STARTPTS,format=yuv420p[{label}]"
            )
        labels.append(f"[{label}]")
    filters.append(f"{''.join(labels)}concat=n={len(labels)}:v=1:a=0[presenter]")
    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(f".{output.stem}.{os.getpid()}.tmp.mp4")
    command.extend(
        [
            "-filter_complex",
            ";".join(filters),
            "-map",
            "[presenter]",
            "-an",
            "-t",
            f"{timeline_duration:.6f}",
            "-c:v",
            "libx264",
            "-preset",
            "veryfast",
            "-crf",
            "14",
            "-pix_fmt",
            "yuv420p",
            "-color_range",
            "tv",
            "-colorspace",
            "bt709",
            "-color_primaries",
            "bt709",
            "-color_trc",
            "bt709",
            "-movflags",
            "+faststart",
            str(temporary),
        ]
    )
    try:
        subprocess.run(command, check=True, timeout=timeout_seconds)
        temporary.replace(output)
    finally:
        temporary.unlink(missing_ok=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--plan", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--output-manifest", required=True, type=Path)
    parser.add_argument("--ffmpeg-bin", default="ffmpeg")
    parser.add_argument("--ffprobe-bin", default="ffprobe")
    parser.add_argument("--timeout-minutes", type=float, default=60)
    args = parser.parse_args()
    try:
        source_manifest = read_object(args.manifest)
        plan = read_object(args.plan)
        raw_paths = source_manifest.get("presenterRenderPaths")
        if not isinstance(raw_paths, list) or not raw_paths:
            raise SelectiveTrackError("manifest.presenterRenderPaths must contain video paths")
        inputs = [Path(str(value)).expanduser().resolve() for value in raw_paths]
        if any(not path.is_file() or path.stat().st_size <= 1024 for path in inputs):
            raise SelectiveTrackError("one or more presenter inputs are missing or empty")
        timeline_duration, segments = validate_plan(plan, len(inputs))
        metadata = [probe(path, args.ffprobe_bin) for path in inputs]
        width, height = metadata[0]["width"], metadata[0]["height"]
        frame_rate = metadata[0]["frameRate"]
        if width <= 0 or height <= 0 or any(
            item["width"] != width or item["height"] != height or item["frameRate"] != frame_rate
            for item in metadata[1:]
        ):
            raise SelectiveTrackError("normalized presenter inputs must share dimensions and frame rate")
        signatures = [
            {"path": str(path), "size": path.stat().st_size, "sha256": file_sha256(path)} for path in inputs
        ]
        plan_sha256 = file_sha256(args.plan)
        output = args.output.expanduser().resolve()
        output_manifest = args.output_manifest.expanduser().resolve()
        if output.is_file() and output_manifest.is_file():
            previous = read_object(output_manifest)
            if (
                previous.get("version") == 1
                and previous.get("inputSignatures") == signatures
                and previous.get("planSha256") == plan_sha256
                and previous.get("presenterTrackPath") == str(output)
            ):
                previous["reused"] = True
                atomic_json(output_manifest, previous)
                print(json.dumps(previous, ensure_ascii=False))
                return 0
        parts = build_timeline_parts(timeline_duration, segments)
        render_track(
            inputs,
            parts,
            output,
            width,
            height,
            frame_rate,
            timeline_duration,
            args.ffmpeg_bin,
            max(120, int(args.timeout_minutes * 60)),
        )
        rendered = probe(output, args.ffprobe_bin)
        if abs(float(rendered["durationSeconds"]) - timeline_duration) > 0.15:
            raise SelectiveTrackError("rendered presenter track duration does not match the narration timeline")
        result = {
            "version": 1,
            "presenterTrackPath": str(output),
            "sourceManifestPath": str(args.manifest.resolve()),
            "presenterPlanPath": str(args.plan.resolve()),
            "planSha256": plan_sha256,
            "durationSeconds": rendered["durationSeconds"],
            "dimensions": {"width": width, "height": height},
            "frameRate": frame_rate,
            "presenterVisibleRanges": plan.get("presenterVisibleRanges") or [],
            "generationSeconds": plan.get("generationSeconds"),
            "savedSeconds": plan.get("savedSeconds"),
            "inputSignatures": signatures,
            "reused": False,
        }
        atomic_json(output_manifest, result)
        print(json.dumps(result, ensure_ascii=False))
        return 0
    except (OSError, json.JSONDecodeError, SelectiveTrackError, subprocess.SubprocessError) as error:
        parser.error(str(error))
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
