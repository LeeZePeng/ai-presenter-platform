#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Any


ACTIVE_PROCESS: subprocess.Popen[str] | None = None
ANSI_PATTERN = re.compile(r"\x1b\[[0-?]*[ -/]*[@-~]")
FRAME_PATTERN = re.compile(r"\b(Rendered|Encoded)\s+(\d+)\s*/\s*(\d+)", re.IGNORECASE)


def concurrency_attempts(requested: int, fallbacks: list[int], available_cpus: int | None = None) -> list[int]:
    """Clamp declared render concurrency to what Remotion can actually accept.

    Remotion rejects values above the host's logical CPU count before rendering a
    frame.  Clamping here avoids a guaranteed failed attempt while retaining the
    caller's ordered fallback policy.
    """
    cpu_limit = max(1, int(available_cpus or os.cpu_count() or requested))
    attempts: list[int] = []
    for value in [requested, *fallbacks]:
        effective = min(int(value), cpu_limit)
        if effective > 0 and effective not in attempts:
            attempts.append(effective)
    return attempts


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
            "stream=codec_name,pix_fmt,color_range,color_space,color_transfer,color_primaries,width,height,nb_frames:format=duration",
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
    return {
        "codec": stream.get("codec_name"),
        "pixelFormat": stream.get("pix_fmt"),
        "colorRange": stream.get("color_range"),
        "colorSpace": stream.get("color_space"),
        "colorTransfer": stream.get("color_transfer"),
        "colorPrimaries": stream.get("color_primaries"),
        "width": int(stream.get("width") or 0),
        "height": int(stream.get("height") or 0),
        "frames": int(stream.get("nb_frames") or 0),
        "durationSeconds": float((value.get("format") or {}).get("duration") or 0),
    }


def is_bt709_limited(metadata: dict[str, Any]) -> bool:
    return (
        metadata.get("codec") == "h264"
        and metadata.get("pixelFormat") == "yuv420p"
        and metadata.get("colorRange") in {"tv", "mpeg"}
        and metadata.get("colorSpace") == "bt709"
        and metadata.get("colorTransfer") == "bt709"
        and metadata.get("colorPrimaries") == "bt709"
    )


def has_bt709_limited_picture(metadata: dict[str, Any]) -> bool:
    return (
        metadata.get("codec") == "h264"
        and metadata.get("pixelFormat") == "yuv420p"
        and metadata.get("colorRange") in {"tv", "mpeg"}
        and metadata.get("colorSpace") == "bt709"
    )


def try_probe(path: Path, ffprobe_bin: str) -> dict[str, Any] | None:
    if not path.is_file() or path.stat().st_size <= 1024:
        return None
    try:
        metadata = probe(path, ffprobe_bin)
        if metadata["durationSeconds"] <= 0 or metadata["width"] <= 0 or metadata["height"] <= 0:
            return None
        return metadata
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError):
        return None


def preserve_attempt(path: Path, label: str, attempt: int) -> Path:
    target = path.with_name(f"{path.stem}.{label}-attempt-{attempt}{path.suffix}")
    suffix = 1
    while target.exists():
        target = path.with_name(f"{path.stem}.{label}-attempt-{attempt}-{suffix}{path.suffix}")
        suffix += 1
    path.replace(target)
    return target


def terminate_child(_signal: int, _frame: object) -> None:
    if ACTIVE_PROCESS and ACTIVE_PROCESS.poll() is None:
        try:
            os.killpg(ACTIVE_PROCESS.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    raise SystemExit(143)


def progress_state(args: argparse.Namespace, state: str, **changes: Any) -> dict[str, Any]:
    now = time.time()
    value = {
        "version": 1,
        "state": state,
        "percent": 0,
        "renderedFrames": 0,
        "encodedFrames": 0,
        "totalFrames": 0,
        "etaSeconds": None,
        "startedAt": args.started_at,
        "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now)),
        "outputPath": str(args.output.resolve()),
        "requestedConcurrency": args.concurrency,
        "availableCpus": args.available_cpus,
        "concurrency": args.active_concurrency,
        "crf": args.crf,
        "scale": args.scale,
        "attempt": args.attempt,
        "error": None,
    }
    value.update(changes)
    atomic_json(args.progress, value)
    return value


def run_remotion(args: argparse.Namespace, concurrency: int, raw_output: Path) -> None:
    global ACTIVE_PROCESS
    args.active_concurrency = concurrency
    args.attempt += 1
    command = [
        str((args.runtime_dir / "node_modules" / ".bin" / "remotion").resolve()),
        "render",
        str(args.entry.resolve()),
        args.composition,
        str(raw_output),
        f"--public-dir={args.public_dir.resolve()}",
        f"--browser-executable={args.browser_executable.resolve()}",
        "--codec=h264",
        "--pixel-format=yuv420p",
        "--color-space=bt709",
        f"--crf={args.crf}",
        f"--concurrency={concurrency}",
        f"--scale={args.scale}",
        "--muted",
        f"--timeout={args.timeout_ms}",
        "--overwrite",
    ]
    started = time.monotonic()
    active_phase = "rendered"
    phase_started = started
    current = progress_state(args, "rendering")
    last_write = 0.0
    last_line = ""
    ACTIVE_PROCESS = subprocess.Popen(
        command,
        cwd=args.entry.parent,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=0,
        start_new_session=True,
    )
    assert ACTIVE_PROCESS.stdout is not None
    buffer = ""
    while True:
        character = ACTIVE_PROCESS.stdout.read(1)
        if character == "" and ACTIVE_PROCESS.poll() is not None:
            break
        if character not in {"", "\r", "\n"}:
            buffer += character
            continue
        if not buffer:
            continue
        line = ANSI_PATTERN.sub("", buffer).strip()
        buffer = ""
        if line:
            print(line, flush=True)
            last_line = line
        match = FRAME_PATTERN.search(line)
        if not match:
            continue
        phase = match.group(1).lower()
        completed = int(match.group(2))
        total = max(1, int(match.group(3)))
        now = time.monotonic()
        if phase != active_phase:
            active_phase = phase
            phase_started = now
        phase_elapsed = max(0.001, now - phase_started)
        eta = (
            int((phase_elapsed / completed) * max(0, total - completed))
            if completed >= 30 and phase_elapsed >= 2
            else None
        )
        if phase == "rendered":
            percent = min(92, int((completed / total) * 92))
            current.update(
                state="rendering",
                percent=percent,
                renderedFrames=completed,
                totalFrames=total,
                etaSeconds=eta,
            )
        else:
            percent = 92 + min(7, int((completed / total) * 7))
            current.update(
                state="encoding",
                percent=percent,
                encodedFrames=completed,
                totalFrames=total,
                etaSeconds=eta,
            )
        if now - last_write >= 0.75 or completed >= total:
            current["updatedAt"] = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
            current["concurrency"] = concurrency
            current["attempt"] = args.attempt
            atomic_json(args.progress, current)
            last_write = now
    exit_code = ACTIVE_PROCESS.wait()
    ACTIVE_PROCESS = None
    if exit_code != 0:
        raise RuntimeError(f"Remotion exited with code {exit_code}: {last_line[-500:]}")
    if not raw_output.is_file() or raw_output.stat().st_size <= 1024:
        raise RuntimeError("Remotion completed without a valid MP4")


def standardize_bt709(args: argparse.Namespace, source: Path, output: Path, metadata: dict[str, Any]) -> dict[str, Any]:
    global ACTIVE_PROCESS
    in_range = "full" if metadata.get("colorRange") in {"pc", "jpeg"} or str(metadata.get("pixelFormat", "")).startswith("yuvj") else "tv"
    color_space = metadata.get("colorSpace")
    in_matrix = color_space if color_space in {"bt709", "bt470bg", "smpte170m", "smpte240m"} else "bt709"
    temporary = output.with_name(f".{output.stem}.{os.getpid()}.bt709.mp4")
    progress_state(args, "standardizing", percent=99, phasePercent=0, totalFrames=metadata.get("frames", 0))
    command = [
        args.ffmpeg_bin,
        "-y",
        "-hide_banner",
        "-loglevel",
        "warning",
        "-i",
        str(source),
        "-map",
        "0:v:0",
        "-an",
        "-vf",
        f"scale=in_range={in_range}:out_range=tv:in_color_matrix={in_matrix}:out_color_matrix=bt709,format=yuv420p",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        str(args.crf),
        "-color_range",
        "tv",
        "-colorspace",
        "bt709",
        "-color_primaries",
        "bt709",
        "-color_trc",
        "bt709",
        "-bsf:v",
        "h264_metadata=video_full_range_flag=0:colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1",
        "-movflags",
        "+faststart",
        "-progress",
        "pipe:1",
        "-nostats",
        str(temporary),
    ]
    try:
        timeout_seconds = max(600, int(metadata.get("durationSeconds", 0) * 3))
        started = time.monotonic()
        last_write = 0.0
        duration = max(0.001, float(metadata.get("durationSeconds", 0)))
        ACTIVE_PROCESS = subprocess.Popen(
            command,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            start_new_session=True,
        )
        assert ACTIVE_PROCESS.stdout is not None
        phase_percent = 0
        for raw_line in ACTIVE_PROCESS.stdout:
            line = raw_line.strip()
            if line.startswith(("out_time_us=", "out_time_ms=")):
                try:
                    completed_seconds = int(line.split("=", 1)[1]) / 1_000_000
                    phase_percent = min(100, max(0, int((completed_seconds / duration) * 100)))
                except ValueError:
                    continue
                now = time.monotonic()
                if now - last_write >= 0.75 or phase_percent >= 100:
                    progress_state(
                        args,
                        "standardizing",
                        percent=99,
                        phasePercent=phase_percent,
                        totalFrames=metadata.get("frames", 0),
                        etaSeconds=int((now - started) / max(1, phase_percent) * max(0, 100 - phase_percent)),
                    )
                    last_write = now
            if time.monotonic() - started > timeout_seconds:
                os.killpg(ACTIVE_PROCESS.pid, signal.SIGTERM)
                raise TimeoutError("BT.709 standardization timed out")
        exit_code = ACTIVE_PROCESS.wait()
        ACTIVE_PROCESS = None
        if exit_code != 0:
            raise RuntimeError(f"FFmpeg BT.709 standardization exited with code {exit_code}")
        converted = probe(temporary, args.ffprobe_bin)
        if not is_bt709_limited(converted):
            raise RuntimeError(f"BT.709 standardization validation failed: {converted}")
        temporary.replace(output)
        return converted
    finally:
        ACTIVE_PROCESS = None
        if temporary.exists():
            temporary.unlink()


def tag_bt709_metadata(args: argparse.Namespace, source: Path, output: Path) -> dict[str, Any]:
    global ACTIVE_PROCESS
    temporary = output.with_name(f".{output.stem}.{os.getpid()}.bt709-metadata.mp4")
    command = [
        args.ffmpeg_bin,
        "-y",
        "-hide_banner",
        "-loglevel",
        "warning",
        "-i",
        str(source),
        "-map",
        "0:v:0",
        "-an",
        "-c:v",
        "copy",
        "-bsf:v",
        "h264_metadata=video_full_range_flag=0:colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1",
        "-movflags",
        "+faststart",
        str(temporary),
    ]
    progress_state(args, "standardizing", percent=99, phasePercent=100, etaSeconds=None)
    try:
        ACTIVE_PROCESS = subprocess.Popen(command, start_new_session=True)
        try:
            exit_code = ACTIVE_PROCESS.wait(timeout=180)
        except subprocess.TimeoutExpired as error:
            os.killpg(ACTIVE_PROCESS.pid, signal.SIGTERM)
            ACTIVE_PROCESS.wait(timeout=15)
            raise TimeoutError("BT.709 metadata tagging timed out") from error
        ACTIVE_PROCESS = None
        if exit_code != 0:
            raise RuntimeError(f"FFmpeg BT.709 metadata tagging exited with code {exit_code}")
        tagged = probe(temporary, args.ffprobe_bin)
        if not is_bt709_limited(tagged):
            raise RuntimeError(f"BT.709 metadata tagging validation failed: {tagged}")
        temporary.replace(output)
        return tagged
    finally:
        ACTIVE_PROCESS = None
        if temporary.exists():
            temporary.unlink()


def main() -> int:
    parser = argparse.ArgumentParser(description="Run one resumable, Mac-safe Remotion render with durable frame progress")
    parser.add_argument("--runtime-dir", required=True, type=Path)
    parser.add_argument("--entry", required=True, type=Path)
    parser.add_argument("--composition", required=True)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("--public-dir", required=True, type=Path)
    parser.add_argument("--browser-executable", required=True, type=Path)
    parser.add_argument("--progress", required=True, type=Path)
    parser.add_argument("--concurrency", required=True, type=int)
    parser.add_argument("--fallback-concurrency", action="append", type=int, default=[])
    parser.add_argument("--crf", type=int, default=12)
    parser.add_argument("--scale", type=float, default=1.0)
    parser.add_argument("--timeout-ms", type=int, default=120000)
    parser.add_argument("--ffmpeg-bin", default="ffmpeg")
    parser.add_argument("--ffprobe-bin", default="ffprobe")
    args = parser.parse_args()
    if not 1 <= args.concurrency <= 16:
        parser.error("--concurrency must be between 1 and 16")
    if not 10 <= args.crf <= 20:
        parser.error("--crf must be between 10 and 20")
    if not 0.1 <= args.scale <= 1.0:
        parser.error("--scale must be between 0.1 and 1.0")
    cli = args.runtime_dir / "node_modules" / ".bin" / "remotion"
    for candidate, name in [(cli, "Remotion CLI"), (args.entry, "entry"), (args.public_dir, "public directory"), (args.browser_executable, "browser")]:
        if not candidate.exists():
            parser.error(f"missing {name}: {candidate}")

    args.output = args.output.expanduser().resolve()
    args.progress = args.progress.expanduser().resolve()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.started_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    args.available_cpus = max(1, os.cpu_count() or args.concurrency)
    attempts = concurrency_attempts(args.concurrency, args.fallback_concurrency, args.available_cpus)
    args.active_concurrency = attempts[0]
    args.attempt = 0
    signal.signal(signal.SIGTERM, terminate_child)
    signal.signal(signal.SIGINT, terminate_child)

    existing = try_probe(args.output, args.ffprobe_bin)
    if existing:
        if is_bt709_limited(existing):
            progress_state(args, "complete", percent=100, totalFrames=existing.get("frames", 0), reused=True, media=existing)
            print(json.dumps({"outputPath": str(args.output), "reused": True, "media": existing}, ensure_ascii=False))
            return 0

    raw_output = args.output.with_name(f".{args.output.stem}.remotion-raw.mp4")
    raw_metadata = try_probe(raw_output, args.ffprobe_bin)
    if not raw_metadata and not existing:
        preserved_outputs = sorted(
            args.output.parent.glob(f"{args.output.stem}.pre-bt709*.mp4"),
            key=lambda candidate: candidate.stat().st_mtime,
            reverse=True,
        )
        for preserved_output in preserved_outputs:
            preserved_metadata = try_probe(preserved_output, args.ffprobe_bin)
            if preserved_metadata:
                raw_output = preserved_output
                raw_metadata = preserved_metadata
                break
    if raw_metadata:
        pass
    elif existing:
        raw_output = args.output
        raw_metadata = existing
    else:
        errors = []
        for concurrency in attempts:
            try:
                if raw_output.exists():
                    preserve_attempt(raw_output, "partial", args.attempt + 1)
                run_remotion(args, concurrency, raw_output)
                break
            except Exception as error:  # Preserve the attempt history and retry only at declared safe concurrency.
                errors.append(str(error))
                progress_state(args, "retrying", percent=0, error=str(error), nextConcurrency=attempts[min(args.attempt, len(attempts) - 1)] if args.attempt < len(attempts) else None)
        else:
            message = " | ".join(errors)
            progress_state(args, "failed", error=message)
            raise RuntimeError(message)
        raw_metadata = probe(raw_output, args.ffprobe_bin)

    metadata_tagged = False
    if is_bt709_limited(raw_metadata):
        if raw_output != args.output:
            raw_output.replace(args.output)
        final_metadata = raw_metadata
        standardized = False
    elif has_bt709_limited_picture(raw_metadata):
        preserved = args.output.with_name(f"{args.output.stem}.pre-bt709.mp4")
        if preserved.exists() and raw_output != preserved:
            preserved = args.output.with_name(
                f"{args.output.stem}.pre-bt709-{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}.mp4"
            )
        if raw_output != preserved:
            shutil.move(str(raw_output), str(preserved))
        final_metadata = tag_bt709_metadata(args, preserved, args.output)
        standardized = False
        metadata_tagged = True
    else:
        preserved = args.output.with_name(f"{args.output.stem}.pre-bt709.mp4")
        if preserved.exists() and raw_output != preserved:
            preserved = args.output.with_name(
                f"{args.output.stem}.pre-bt709-{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}.mp4"
            )
        if raw_output != preserved:
            shutil.move(str(raw_output), str(preserved))
        final_metadata = standardize_bt709(args, preserved, args.output, raw_metadata)
        standardized = True

    result = {
        "outputPath": str(args.output),
        "reused": False,
        "standardized": standardized,
        "metadataTagged": metadata_tagged,
        "media": final_metadata,
        "attempts": args.attempt,
        "concurrency": args.active_concurrency,
        "scale": args.scale,
    }
    progress_state(
        args,
        "complete",
        percent=100,
        totalFrames=final_metadata.get("frames", 0),
        media=final_metadata,
        standardized=standardized,
        metadataTagged=metadata_tagged,
    )
    print(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        print(str(error), file=sys.stderr)
        raise
