#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import os
import re
import signal
import subprocess
import sys
import time
from pathlib import Path
from typing import Any


ACTIVE_PROCESS: subprocess.Popen[str] | None = None


def atomic_json(path: Path, value: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    temporary.replace(path)


def write_progress(path: Path, state: str, percent: int, **extra: Any) -> None:
    atomic_json(
        path,
        {
            "version": 1,
            "state": state,
            "percent": max(0, min(100, percent)),
            "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "error": None,
            **extra,
        },
    )


def terminate_child(_signal: int, _frame: object) -> None:
    if ACTIVE_PROCESS and ACTIVE_PROCESS.poll() is None:
        try:
            os.killpg(ACTIVE_PROCESS.pid, signal.SIGTERM)
        except ProcessLookupError:
            pass
    raise SystemExit(143)


def probe(path: Path, ffprobe_bin: Path) -> dict[str, Any]:
    result = subprocess.run(
        [
            str(ffprobe_bin),
            "-v",
            "error",
            "-show_entries",
            "stream=index,codec_type,codec_name,pix_fmt,color_range,color_space,color_transfer,color_primaries,width,height:format=duration,size",
            "-of",
            "json",
            str(path),
        ],
        check=True,
        capture_output=True,
        text=True,
        timeout=60,
    )
    value = json.loads(result.stdout)
    streams = value.get("streams") or []
    video = next((stream for stream in streams if stream.get("codec_type") == "video"), None)
    audio = next((stream for stream in streams if stream.get("codec_type") == "audio"), None)
    if not video:
        raise RuntimeError(f"missing video stream: {path}")
    return {
        "video": video,
        "audio": audio,
        "durationSeconds": float((value.get("format") or {}).get("duration") or 0),
        "size": int((value.get("format") or {}).get("size") or 0),
    }


def run_child(command: list[str], cwd: Path, capture_limit: int = 12000) -> str:
    global ACTIVE_PROCESS
    ACTIVE_PROCESS = subprocess.Popen(
        command,
        cwd=cwd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        start_new_session=True,
    )
    output = ""
    assert ACTIVE_PROCESS.stdout is not None
    for line in ACTIVE_PROCESS.stdout:
        print(line.rstrip(), flush=True)
        output = (output + line)[-capture_limit:]
    exit_code = ACTIVE_PROCESS.wait()
    ACTIVE_PROCESS = None
    if exit_code != 0:
        raise RuntimeError(f"command exited with code {exit_code}: {output[-2000:]}")
    return output


def transcode_evidence_source(args: argparse.Namespace, source: Path) -> bool:
    global ACTIVE_PROCESS
    metadata = probe(source, args.ffprobe_bin)
    if metadata["video"].get("codec_name") == "h264":
        write_progress(args.progress, "optimizing", 100, sourceCodec="h264", reused=True)
        return False

    duration = max(0.001, metadata["durationSeconds"])
    temporary = source.with_name(f".{source.stem}.{os.getpid()}.h264.mp4")
    command = [
        str(args.ffmpeg_bin),
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
        "h264_videotoolbox",
        "-b:v",
        "5M",
        "-maxrate",
        "8M",
        "-bufsize",
        "12M",
        "-g",
        "30",
        "-pix_fmt",
        "yuv420p",
        "-tag:v",
        "avc1",
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
        "-progress",
        "pipe:1",
        "-nostats",
        str(temporary),
    ]
    write_progress(args.progress, "optimizing", 0, sourceCodec=metadata["video"].get("codec_name"))
    try:
        ACTIVE_PROCESS = subprocess.Popen(
            command,
            cwd=args.workspace,
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            start_new_session=True,
        )
        assert ACTIVE_PROCESS.stdout is not None
        for raw_line in ACTIVE_PROCESS.stdout:
            line = raw_line.strip()
            if not line.startswith(("out_time_us=", "out_time_ms=")):
                continue
            try:
                completed_seconds = int(line.split("=", 1)[1]) / 1_000_000
            except ValueError:
                continue
            percent = min(99, max(0, int((completed_seconds / duration) * 100)))
            write_progress(args.progress, "optimizing", percent, sourceCodec=metadata["video"].get("codec_name"))
        exit_code = ACTIVE_PROCESS.wait()
        ACTIVE_PROCESS = None
        if exit_code != 0:
            raise RuntimeError(f"evidence source transcode exited with code {exit_code}")
        converted = probe(temporary, args.ffprobe_bin)
        if converted["video"].get("codec_name") != "h264" or abs(converted["durationSeconds"] - duration) > 1.0:
            raise RuntimeError("optimized evidence source failed validation")
        backup = source.with_name(f"{source.stem}.av1-original{source.suffix}")
        if not backup.exists():
            source.replace(backup)
        else:
            source.unlink()
        temporary.replace(source)
        write_progress(args.progress, "optimizing", 100, sourceCodec="h264", reused=False)
        return True
    finally:
        ACTIVE_PROCESS = None
        if temporary.exists():
            temporary.unlink()


def discover_compositions(source_dir: Path) -> tuple[str, str | None]:
    text = "\n".join(path.read_text(encoding="utf-8") for path in sorted(source_dir.glob("**/*")) if path.suffix in {".ts", ".tsx", ".js", ".jsx"})
    composition = re.search(r"<Composition\b[^>]*\bid\s*=\s*['\"]([^'\"]+)['\"]", text, re.DOTALL)
    still = re.search(r"<Still\b[^>]*\bid\s*=\s*['\"]([^'\"]+)['\"]", text, re.DOTALL)
    if not composition:
        raise RuntimeError("cannot discover Remotion composition id")
    return composition.group(1), still.group(1) if still else None


def preserve_if_present(path: Path) -> None:
    if not path.exists():
        return
    timestamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    path.replace(path.with_name(f"{path.stem}.abandoned-{timestamp}{path.suffix}"))


def render_visual(args: argparse.Namespace, composition: str) -> None:
    visual = args.workspace / "out" / "remotion_visual.mp4"
    raw = visual.with_name(f".{visual.stem}.remotion-raw.mp4")
    preserve_if_present(visual)
    preserve_if_present(raw)
    remotion_progress = args.workspace / "out" / "analysis" / "remotion_progress.json"
    if remotion_progress.exists():
        remotion_progress.unlink()
    write_progress(args.progress, "rendering", 0, composition=composition, concurrency=args.concurrency)
    command = [
        str(args.python_bin),
        str(args.render_script),
        "--runtime-dir",
        str(args.runtime_dir),
        "--entry",
        str(args.workspace / "remotion" / "src" / "index.ts"),
        "--composition",
        composition,
        "--output",
        str(visual),
        "--public-dir",
        str(args.workspace / "remotion" / "public"),
        "--browser-executable",
        str(args.browser_executable),
        "--progress",
        str(remotion_progress),
        "--concurrency",
        str(args.concurrency),
        "--fallback-concurrency",
        "12",
        "--fallback-concurrency",
        "8",
        "--crf",
        str(args.crf),
        "--ffmpeg-bin",
        str(args.ffmpeg_bin),
        "--ffprobe-bin",
        str(args.ffprobe_bin),
    ]
    run_child(command, args.workspace)
    metadata = probe(visual, args.ffprobe_bin)
    video = metadata["video"]
    if (
        video.get("codec_name") != "h264"
        or video.get("pix_fmt") != "yuv420p"
        or video.get("color_space") != "bt709"
        or video.get("color_transfer") != "bt709"
        or video.get("color_primaries") != "bt709"
    ):
        raise RuntimeError(f"visual master is not limited BT.709 H.264: {video}")


def mux_final(args: argparse.Namespace) -> Path:
    visual = args.workspace / "out" / "remotion_visual.mp4"
    narration = args.workspace / "out" / "audio" / "final_narration.wav"
    final = args.workspace / "out" / "final.mp4"
    temporary = final.with_name(f".{final.stem}.{os.getpid()}.mp4")
    preserve_if_present(final)
    write_progress(args.progress, "muxing", 0)
    command = [
        str(args.ffmpeg_bin),
        "-y",
        "-hide_banner",
        "-loglevel",
        "warning",
        "-i",
        str(visual),
        "-i",
        str(narration),
        "-map",
        "0:v:0",
        "-map",
        "1:a:0",
        "-c:v",
        "copy",
        "-c:a",
        "aac",
        "-b:a",
        "192k",
        "-shortest",
        "-movflags",
        "+faststart",
        str(temporary),
    ]
    try:
        run_child(command, args.workspace)
        metadata = probe(temporary, args.ffprobe_bin)
        if not metadata["audio"] or metadata["durationSeconds"] < 10:
            raise RuntimeError("final video is missing narration audio")
        temporary.replace(final)
        write_progress(args.progress, "muxing", 100)
        return final
    finally:
        if temporary.exists():
            temporary.unlink()


def render_cover(args: argparse.Namespace, still_id: str | None) -> Path | None:
    if not still_id:
        return None
    cover = args.workspace / "out" / "cover.png"
    write_progress(args.progress, "cover", 0)
    command = [
        str(args.runtime_dir / "node_modules" / ".bin" / "remotion"),
        "still",
        str(args.workspace / "remotion" / "src" / "index.ts"),
        still_id,
        str(cover),
        f"--public-dir={args.workspace / 'remotion' / 'public'}",
        f"--browser-executable={args.browser_executable}",
        "--image-format=png",
        "--overwrite",
    ]
    run_child(command, args.workspace)
    if not cover.is_file() or cover.stat().st_size <= 10_000:
        raise RuntimeError("cover render did not create a valid PNG")
    write_progress(args.progress, "cover", 100)
    return cover


def write_result(args: argparse.Namespace, final: Path, cover: Path | None) -> None:
    out = args.workspace / "out"
    analysis = out / "analysis"
    manifest_path = out / "result.json"
    try:
        manifest = json.loads(manifest_path.read_text(encoding="utf-8")) if manifest_path.exists() else {}
    except json.JSONDecodeError:
        manifest = {}
    presenter_manifest_path = analysis / "presenter_render_manifest.json"
    presenter_manifest = json.loads(presenter_manifest_path.read_text(encoding="utf-8"))
    source_frames = sorted((out / "stills" / "source_review" / "frames").glob("frame-*.jpg"))
    manifest.update(
        {
            "outputPath": str(final.resolve()),
            "presenterProvider": "InfiniteTalk",
            "compositionRenderer": "Remotion",
            "remotionEntryPath": str((args.workspace / "remotion" / "src" / "index.ts").resolve()),
            "remotionVisualPath": str((out / "remotion_visual.mp4").resolve()),
            "presenterRenderPaths": presenter_manifest.get("presenterRenderPaths") or [],
            "presenterTrackPath": str((args.workspace / "remotion" / "public" / "presenter" / "presenter-track.mp4").resolve()),
            "narrationPath": str((out / "audio" / "final_narration.wav").resolve()),
            "sourceTranscriptPath": str((analysis / "source_transcript.json").resolve()),
            "narrationVisualMapPath": str((analysis / "narration_visual_map.json").resolve()),
            "sceneImplementationPath": str((analysis / "scene_implementation.json").resolve()),
            "sceneContractReportPath": str((analysis / "scene_contract_report.json").resolve()),
            "preflightReportPath": str((analysis / "preflight_report.json").resolve()),
            "sourceReviewFramePaths": [str(path.resolve()) for path in source_frames],
            "marketingTitle": args.title,
            "marketingDescription": f"{args.title}｜AI 数字人口播复刻成片",
            "fastRender": True,
        }
    )
    if cover:
        manifest["coverPath"] = str(cover.resolve())
    atomic_json(manifest_path, manifest)


def main() -> int:
    parser = argparse.ArgumentParser(description="Fast deterministic render of an approved existing presenter workspace")
    parser.add_argument("--workspace", required=True, type=Path)
    parser.add_argument("--runtime-dir", required=True, type=Path)
    parser.add_argument("--browser-executable", required=True, type=Path)
    parser.add_argument("--render-script", required=True, type=Path)
    parser.add_argument("--python-bin", required=True, type=Path)
    parser.add_argument("--ffmpeg-bin", required=True, type=Path)
    parser.add_argument("--ffprobe-bin", required=True, type=Path)
    parser.add_argument("--progress", required=True, type=Path)
    parser.add_argument("--concurrency", type=int, default=16)
    parser.add_argument("--crf", type=int, default=12)
    parser.add_argument("--title", default="AI Presenter")
    args = parser.parse_args()
    args.workspace = args.workspace.expanduser().resolve()
    args.progress = args.progress.expanduser().resolve()
    if not 1 <= args.concurrency <= 16:
        parser.error("--concurrency must be between 1 and 16")
    for candidate, label in [
        (args.workspace / "remotion" / "src" / "index.ts", "Remotion entry"),
        (args.workspace / "remotion" / "public" / "presenter" / "presenter-track.mp4", "presenter track"),
        (args.workspace / "out" / "audio" / "final_narration.wav", "narration"),
        (args.workspace / "out" / "analysis" / "preflight_report.json", "preflight report"),
        (args.workspace / "out" / "analysis" / "scene_contract_report.json", "scene contract"),
        (args.render_script, "render wrapper"),
        (args.ffmpeg_bin, "ffmpeg"),
        (args.ffprobe_bin, "ffprobe"),
    ]:
        if not candidate.exists():
            parser.error(f"missing {label}: {candidate}")
    preflight = json.loads((args.workspace / "out" / "analysis" / "preflight_report.json").read_text(encoding="utf-8"))
    contract = json.loads((args.workspace / "out" / "analysis" / "scene_contract_report.json").read_text(encoding="utf-8"))
    if preflight.get("approved") is not True or contract.get("valid") is not True:
        raise RuntimeError("fast render requires approved preflight and valid scene contract")

    signal.signal(signal.SIGTERM, terminate_child)
    signal.signal(signal.SIGINT, terminate_child)
    write_progress(args.progress, "starting", 0)
    source = args.workspace / "remotion" / "public" / "source" / "sourceVideo.mp4"
    if source.exists():
        transcode_evidence_source(args, source)
    composition, still_id = discover_compositions(args.workspace / "remotion" / "src")
    render_visual(args, composition)
    final = mux_final(args)
    cover = render_cover(args, still_id)
    write_progress(args.progress, "validating", 0)
    final_metadata = probe(final, args.ffprobe_bin)
    if final_metadata["video"].get("codec_name") != "h264" or not final_metadata["audio"]:
        raise RuntimeError("final output validation failed")
    write_result(args, final, cover)
    write_progress(args.progress, "complete", 100, outputPath=str(final.resolve()), media=final_metadata)
    print(json.dumps({"outputPath": str(final.resolve()), "media": final_metadata}, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:
        try:
            progress_value = ""
            if "--progress" in sys.argv:
                progress_index = sys.argv.index("--progress") + 1
                if progress_index < len(sys.argv):
                    progress_value = sys.argv[progress_index]
            if progress_value:
                write_progress(Path(progress_value), "failed", 0, error=str(error))
        except Exception:
            pass
        print(str(error), file=sys.stderr)
        raise
