#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import subprocess
import tempfile
from pathlib import Path
from typing import Any


def read_json(path: Path) -> dict[str, Any]:
    value = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(value, dict):
        raise RuntimeError(f"JSON root must be an object: {path}")
    return value


def atomic_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def probe(path: Path, ffprobe_bin: str) -> dict[str, Any]:
    result = subprocess.run(
        [
            ffprobe_bin,
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=codec_name,width,height,pix_fmt,avg_frame_rate,r_frame_rate,time_base:format=duration",
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
        raise RuntimeError(f"missing video stream: {path}")
    stream = streams[0]
    duration = float((value.get("format") or {}).get("duration") or 0)
    if duration <= 0:
        raise RuntimeError(f"invalid video duration: {path}")
    return {
        "codec": stream.get("codec_name"),
        "width": int(stream.get("width") or 0),
        "height": int(stream.get("height") or 0),
        "pixelFormat": stream.get("pix_fmt"),
        "averageFrameRate": stream.get("avg_frame_rate"),
        "realFrameRate": stream.get("r_frame_rate"),
        "timeBase": stream.get("time_base"),
        "durationSeconds": duration,
    }


def input_signature(path: Path) -> dict[str, Any]:
    stat = path.stat()
    return {
        "path": str(path.resolve()),
        "size": stat.st_size,
        "modifiedNanoseconds": stat.st_mtime_ns,
    }


def compatible_for_stream_copy(items: list[dict[str, Any]]) -> bool:
    keys = ("codec", "width", "height", "pixelFormat", "averageFrameRate", "timeBase")
    return all(all(item.get(key) == items[0].get(key) for key in keys) for item in items[1:])


def segment_timing(segments_manifest: Path | None, expected_count: int) -> tuple[list[float] | None, float | None]:
    if not segments_manifest or not segments_manifest.is_file():
        return None, None
    plan = read_json(segments_manifest).get("segment_plan")
    if not isinstance(plan, list) or not plan:
        return None, None
    if len(plan) != expected_count:
        raise RuntimeError(f"segment plan count {len(plan)} does not match presenter inputs {expected_count}")
    end = 0.0
    previous_end = 0.0
    starts: list[float] = []
    raw_durations: list[float] = []
    for index, raw in enumerate(plan):
        if not isinstance(raw, dict):
            raise RuntimeError(f"segment plan item {index + 1} is invalid")
        start = float(raw.get("start", previous_end))
        duration = float(raw.get("duration", 0))
        if start < previous_end - 0.15 or duration <= 0:
            raise RuntimeError(f"segment plan item {index + 1} is not contiguous")
        starts.append(start)
        raw_durations.append(duration)
        end = max(end, start + duration)
        previous_end = start + duration
    durations = [starts[index + 1] - starts[index] for index in range(len(starts) - 1)]
    durations.append(raw_durations[-1])
    if any(value <= 0 for value in durations):
        raise RuntimeError("segment plan contains a non-positive timeline slot")
    return durations, end


def concat_file_line(path: Path, duration: float | None = None) -> str:
    escaped = str(path.resolve()).replace("'", "'\\''")
    line = f"file '{escaped}'\n"
    if duration is not None:
        line += f"duration {duration:.9f}\n"
    return line


def run_concat(
    inputs: list[Path],
    output: Path,
    ffmpeg_bin: str,
    stream_copy: bool,
    timeout_seconds: int,
    timeline_durations: list[float] | None,
) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="presenter-track-", dir=output.parent) as temporary_dir:
        concat_path = Path(temporary_dir) / "segments.txt"
        concat_path.write_text(
            "ffconcat version 1.0\n"
            + "".join(
                concat_file_line(item, timeline_durations[index] if timeline_durations else None)
                for index, item in enumerate(inputs)
            ),
            encoding="utf-8",
        )
        temporary_output = output.with_name(f".{output.stem}.{os.getpid()}.tmp.mp4")
        command = [
            ffmpeg_bin,
            "-y",
            "-hide_banner",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(concat_path),
            "-map",
            "0:v:0",
            "-an",
        ]
        if stream_copy:
            command.extend(["-c:v", "copy"])
        else:
            command.extend(
                [
                    "-c:v",
                    "libx264",
                    "-preset",
                    "veryfast",
                    "-crf",
                    "14",
                    "-pix_fmt",
                    "yuv420p",
                ]
            )
        command.extend(["-movflags", "+faststart", str(temporary_output)])
        try:
            subprocess.run(command, check=True, timeout=timeout_seconds)
            temporary_output.replace(output)
        finally:
            if temporary_output.exists():
                temporary_output.unlink()


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Join normalized InfiniteTalk segments into one resumable Remotion presenter track"
    )
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--segments-manifest", type=Path)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--output-manifest", required=True, type=Path)
    parser.add_argument("--ffmpeg-bin", default="ffmpeg")
    parser.add_argument("--ffprobe-bin", default="ffprobe")
    parser.add_argument("--timeout-minutes", type=float, default=60)
    args = parser.parse_args()

    source_manifest = read_json(args.manifest)
    raw_paths = source_manifest.get("presenterRenderPaths")
    if not isinstance(raw_paths, list) or not raw_paths:
        parser.error("manifest.presenterRenderPaths must contain at least one video")
    inputs = [Path(str(value)).expanduser().resolve() for value in raw_paths]
    missing = [str(item) for item in inputs if not item.is_file() or item.stat().st_size <= 1024]
    if missing:
        parser.error(f"missing presenter inputs: {', '.join(missing)}")

    output = args.output.expanduser().resolve()
    output_manifest = args.output_manifest.expanduser().resolve()
    signatures = [input_signature(item) for item in inputs]
    if output.is_file() and output.stat().st_size > 1024 and output_manifest.is_file():
        previous = read_json(output_manifest)
        if (
            previous.get("version") == 2
            and previous.get("inputSignatures") == signatures
            and previous.get("presenterTrackPath") == str(output)
        ):
            previous["reused"] = True
            atomic_json(output_manifest, previous)
            print(json.dumps(previous, ensure_ascii=False))
            return 0

    metadata = [probe(item, args.ffprobe_bin) for item in inputs]
    timeline_durations, planned_duration = segment_timing(args.segments_manifest, len(inputs))
    stream_copy = compatible_for_stream_copy(metadata)
    timeout_seconds = max(120, int(args.timeout_minutes * 60))
    try:
        run_concat(inputs, output, args.ffmpeg_bin, stream_copy, timeout_seconds, timeline_durations)
        mode = "stream-copy" if stream_copy else "libx264-fallback"
    except subprocess.CalledProcessError:
        if not stream_copy:
            raise
        run_concat(inputs, output, args.ffmpeg_bin, False, timeout_seconds, timeline_durations)
        mode = "libx264-fallback"

    rendered = probe(output, args.ffprobe_bin)
    first = metadata[0]
    if rendered["width"] != first["width"] or rendered["height"] != first["height"]:
        raise RuntimeError("presenter track dimensions changed during concatenation")
    actual_sum = sum(float(item["durationSeconds"]) for item in metadata)
    tolerance = max(0.5, len(inputs) * 0.04)
    target_duration = planned_duration if planned_duration is not None else actual_sum
    if abs(float(rendered["durationSeconds"]) - target_duration) > tolerance:
        raise RuntimeError(
            f"presenter track duration mismatch: {rendered['durationSeconds']:.3f}s vs {target_duration:.3f}s"
        )
    warnings: list[str] = []
    if planned_duration is not None and abs(actual_sum - planned_duration) > 0.5:
        warnings.append(f"preserved {planned_duration - actual_sum:.3f}s of planned boundary holds to prevent lip-sync drift")

    result = {
        "version": 2,
        "presenterTrackPath": str(output),
        "sourceManifestPath": str(args.manifest.resolve()),
        "segmentsManifestPath": str(args.segments_manifest.resolve()) if args.segments_manifest else None,
        "sourceCount": len(inputs),
        "mode": mode,
        "durationSeconds": rendered["durationSeconds"],
        "sourceDurationSeconds": actual_sum,
        "expectedDurationSeconds": planned_duration,
        "dimensions": {"width": rendered["width"], "height": rendered["height"]},
        "inputSignatures": signatures,
        "warnings": warnings,
        "reused": False,
    }
    atomic_json(output_manifest, result)
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
