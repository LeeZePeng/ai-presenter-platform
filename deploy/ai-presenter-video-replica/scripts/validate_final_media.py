#!/usr/bin/env python3
"""Deterministically validate the complete delivered MP4 and write an audit report."""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import subprocess
from pathlib import Path
from typing import Any


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def ffprobe(path: Path, ffprobe_bin: str) -> dict[str, Any]:
    result = subprocess.run(
        [
            ffprobe_bin,
            "-v",
            "error",
            "-show_entries",
            "stream=index,codec_type,codec_name,width,height,pix_fmt,r_frame_rate,color_range,color_space,color_transfer,color_primaries:format=duration,size",
            "-of",
            "json",
            str(path),
        ],
        check=True,
        capture_output=True,
        text=True,
        timeout=60,
    )
    return json.loads(result.stdout)


def ratio(value: str) -> float:
    numerator, separator, denominator = str(value).partition("/")
    if separator:
        return float(numerator) / float(denominator)
    return float(value)


def parse_intervals(log: str, prefix: str) -> list[dict[str, float]]:
    pattern = re.compile(
        rf"{re.escape(prefix)}_start:\s*([0-9.]+).*?{re.escape(prefix)}_end:\s*([0-9.]+).*?{re.escape(prefix)}_duration:\s*([0-9.]+)",
        flags=re.DOTALL,
    )
    return [
        {"startSeconds": float(start), "endSeconds": float(end), "durationSeconds": float(duration)}
        for start, end, duration in pattern.findall(log)
    ]


def video_stream_sha256(path: Path, ffmpeg_bin: str) -> str:
    result = subprocess.run(
        [
            ffmpeg_bin,
            "-v",
            "error",
            "-i",
            str(path),
            "-map",
            "0:v:0",
            "-c",
            "copy",
            "-f",
            "hash",
            "-hash",
            "sha256",
            "-",
        ],
        check=True,
        capture_output=True,
        text=True,
        timeout=300,
    )
    match = re.search(r"SHA256=([0-9a-fA-F]{64})", result.stdout)
    if not match:
        raise RuntimeError("ffmpeg did not return a video-stream SHA-256")
    return match.group(1).lower()


def validate_probe(
    probe: dict[str, Any],
    expected_width: int | None,
    expected_height: int | None,
    expected_fps: float | None,
) -> tuple[list[str], dict[str, Any]]:
    streams = probe.get("streams") or []
    videos = [item for item in streams if item.get("codec_type") == "video"]
    audios = [item for item in streams if item.get("codec_type") == "audio"]
    errors: list[str] = []
    if len(videos) != 1:
        errors.append(f"expected exactly one video stream, got {len(videos)}")
    if not audios:
        errors.append("missing audio stream")
    video = videos[0] if videos else {}
    if video.get("codec_name") != "h264":
        errors.append(f"video codec must be h264, got {video.get('codec_name')}")
    if video.get("pix_fmt") != "yuv420p":
        errors.append(f"pixel format must be yuv420p, got {video.get('pix_fmt')}")
    for key in ("color_space", "color_transfer", "color_primaries"):
        if video.get(key) != "bt709":
            errors.append(f"{key} must be bt709, got {video.get(key)}")
    if video.get("color_range") not in {"tv", "limited"}:
        errors.append(f"color range must be limited/tv, got {video.get('color_range')}")
    if expected_width is not None and int(video.get("width") or 0) != expected_width:
        errors.append(f"width must be {expected_width}, got {video.get('width')}")
    if expected_height is not None and int(video.get("height") or 0) != expected_height:
        errors.append(f"height must be {expected_height}, got {video.get('height')}")
    actual_fps = ratio(str(video.get("r_frame_rate") or "0/1")) if video else 0
    if expected_fps is not None and abs(actual_fps - expected_fps) > 0.02:
        errors.append(f"frame rate must be {expected_fps}, got {actual_fps:.3f}")
    return errors, {"video": video, "audioStreamCount": len(audios), "framesPerSecond": actual_fps}


def scan_full_media(
    path: Path,
    ffmpeg_bin: str,
    max_black_seconds: float,
    max_silence_seconds: float,
    timeout_seconds: int,
) -> tuple[str, list[dict[str, float]], list[dict[str, float]]]:
    result = subprocess.run(
        [
            ffmpeg_bin,
            "-v",
            "info",
            "-xerror",
            "-i",
            str(path),
            "-map",
            "0:v:0",
            "-map",
            "0:a:0",
            "-vf",
            f"blackdetect=d={max_black_seconds}:pix_th=0.10",
            "-af",
            f"silencedetect=noise=-45dB:d={max_silence_seconds}",
            "-f",
            "null",
            "-",
        ],
        check=True,
        capture_output=True,
        text=True,
        timeout=timeout_seconds,
    )
    log = result.stderr
    return log, parse_intervals(log, "black"), parse_intervals(log, "silence")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--final", required=True, type=Path, dest="final_path")
    parser.add_argument("--visual-master", type=Path)
    parser.add_argument("--narration", type=Path)
    parser.add_argument("--report", required=True, type=Path)
    parser.add_argument("--expected-width", type=int)
    parser.add_argument("--expected-height", type=int)
    parser.add_argument("--expected-fps", type=float)
    parser.add_argument("--duration-tolerance", type=float, default=0.25)
    parser.add_argument("--max-black-seconds", type=float, default=0.3)
    parser.add_argument("--max-silence-seconds", type=float, default=1.0)
    parser.add_argument("--timeout-minutes", type=float, default=60)
    parser.add_argument("--ffmpeg-bin", default="ffmpeg")
    parser.add_argument("--ffprobe-bin", default="ffprobe")
    args = parser.parse_args()

    errors: list[str] = []
    warnings: list[str] = []
    final_path = args.final_path.expanduser().resolve()
    report: dict[str, Any] = {"version": 1, "finalPath": str(final_path), "approved": False}
    try:
        if not final_path.is_file() or final_path.stat().st_size <= 1024:
            raise RuntimeError("final MP4 is missing or empty")
        probe = ffprobe(final_path, args.ffprobe_bin)
        probe_errors, stream_summary = validate_probe(
            probe, args.expected_width, args.expected_height, args.expected_fps
        )
        errors.extend(probe_errors)
        duration = float((probe.get("format") or {}).get("duration") or 0)
        if not math.isfinite(duration) or duration <= 0:
            errors.append("final duration is invalid")
        narration_duration = None
        narration_hash = None
        if args.narration:
            narration_path = args.narration.expanduser().resolve()
            narration_probe = ffprobe(narration_path, args.ffprobe_bin)
            narration_duration = float((narration_probe.get("format") or {}).get("duration") or 0)
            narration_hash = file_sha256(narration_path)
            if abs(duration - narration_duration) > args.duration_tolerance:
                errors.append(
                    f"final duration {duration:.3f}s differs from narration {narration_duration:.3f}s"
                )
        _log, black_intervals, silence_intervals = scan_full_media(
            final_path,
            args.ffmpeg_bin,
            args.max_black_seconds,
            args.max_silence_seconds,
            max(120, int(args.timeout_minutes * 60)),
        )
        if black_intervals:
            errors.append(f"detected {len(black_intervals)} black interval(s) at or above threshold")
        if silence_intervals:
            errors.append(f"detected {len(silence_intervals)} abnormal silence interval(s) at or above threshold")
        final_video_hash = video_stream_sha256(final_path, args.ffmpeg_bin)
        visual_master_hash = None
        if args.visual_master:
            visual_master = args.visual_master.expanduser().resolve()
            visual_master_hash = video_stream_sha256(visual_master, args.ffmpeg_bin)
            if final_video_hash != visual_master_hash:
                errors.append("final and visual master video-stream SHA-256 values differ")
        report.update(
            {
                "durationSeconds": duration,
                "narrationDurationSeconds": narration_duration,
                "streams": stream_summary,
                "fullDecodePassed": True,
                "blackIntervals": black_intervals,
                "silenceIntervals": silence_intervals,
                "hashes": {
                    "finalFileSha256": file_sha256(final_path),
                    "finalVideoStreamSha256": final_video_hash,
                    "visualMasterVideoStreamSha256": visual_master_hash,
                    "narrationFileSha256": narration_hash,
                },
            }
        )
    except (OSError, ValueError, RuntimeError, json.JSONDecodeError, subprocess.SubprocessError) as error:
        errors.append(str(error))
        report["fullDecodePassed"] = False
    report["errors"] = errors
    report["warnings"] = warnings
    report["approved"] = not errors
    args.report.parent.mkdir(parents=True, exist_ok=True)
    args.report.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))
    return 0 if report["approved"] else 2


if __name__ == "__main__":
    raise SystemExit(main())
