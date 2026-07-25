#!/usr/bin/env python3
"""Validate audible narration quality before paid lip-sync and final delivery."""

from __future__ import annotations

import argparse
import json
import pathlib
import re
import subprocess


SPEECH_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fffA-Za-z0-9]")


def run(command: list[str], label: str) -> str:
    result = subprocess.run(command, capture_output=True, text=True)
    output = f"{result.stdout}\n{result.stderr}"
    if result.returncode:
        raise SystemExit(f"{label} failed ({result.returncode}): {output[-1600:].strip()}")
    return output


def normalize_speech_text(value: str) -> str:
    return "".join(SPEECH_RE.findall(value)).lower()


def edit_similarity(left: str, right: str) -> float:
    left = normalize_speech_text(left)
    right = normalize_speech_text(right)
    if not left or not right:
        return 0.0
    previous = list(range(len(right) + 1))
    for left_index, left_character in enumerate(left, start=1):
        current = [left_index]
        for right_index, right_character in enumerate(right, start=1):
            current.append(
                min(
                    current[-1] + 1,
                    previous[right_index] + 1,
                    previous[right_index - 1] + (left_character != right_character),
                )
            )
        previous = current
    return max(0.0, 1 - previous[-1] / max(len(left), len(right)))


def probe_duration(audio: pathlib.Path, ffprobe_bin: str) -> float:
    output = run(
        [
            ffprobe_bin,
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=nw=1:nk=1",
            str(audio),
        ],
        "audio duration probe",
    )
    try:
        duration = float(output.strip())
    except ValueError as error:
        raise SystemExit("Unable to read narration duration") from error
    if duration <= 0:
        raise SystemExit("Narration duration is invalid")
    return duration


def measure_loudness(audio: pathlib.Path, ffmpeg_bin: str) -> dict[str, float]:
    output = run(
        [
            ffmpeg_bin,
            "-hide_banner",
            "-nostats",
            "-i",
            str(audio),
            "-vn",
            "-af",
            "loudnorm=I=-16:TP=-1.5:LRA=7:print_format=json",
            "-f",
            "null",
            "-",
        ],
        "audio loudness analysis",
    )
    matches = re.findall(r'\{\s*"input_i".*?\}', output, flags=re.S)
    if not matches:
        raise SystemExit("Unable to parse narration loudness")
    value = json.loads(matches[-1])
    try:
        return {
            "integratedLufs": float(value["input_i"]),
            "truePeakDbtp": float(value["input_tp"]),
            "loudnessRangeLu": float(value["input_lra"]),
        }
    except (KeyError, TypeError, ValueError) as error:
        raise SystemExit("Narration loudness measurement is invalid") from error


def measure_silences(
    audio: pathlib.Path,
    ffmpeg_bin: str,
    duration: float,
    threshold_db: float,
    minimum_seconds: float,
) -> dict[str, float | int]:
    output = run(
        [
            ffmpeg_bin,
            "-hide_banner",
            "-nostats",
            "-i",
            str(audio),
            "-vn",
            "-af",
            f"silencedetect=noise={threshold_db}dB:d={minimum_seconds}",
            "-f",
            "null",
            "-",
        ],
        "audio pause analysis",
    )
    pauses = [float(value) for value in re.findall(r"silence_duration:\s*([0-9.]+)", output)]
    total = sum(pauses)
    return {
        "pauseCount": len(pauses),
        "pauseCountPerMinute": round(len(pauses) / max(duration / 60, 1 / 60), 3),
        "silenceSeconds": round(total, 3),
        "silenceRatio": round(total / duration, 4),
        "longestSilenceSeconds": round(max(pauses, default=0.0), 3),
    }


def timeline_text(filename: pathlib.Path) -> str:
    value = json.loads(filename.read_text(encoding="utf-8"))
    if isinstance(value.get("text"), str) and value["text"].strip():
        return value["text"]
    return "".join(
        str(item.get("text", ""))
        for item in value.get("segments", [])
        if isinstance(item, dict)
    )


def pronunciation_issues(filename: pathlib.Path) -> tuple[list[str], list[str]]:
    value = json.loads(filename.read_text(encoding="utf-8"))
    hard: list[str] = []
    warnings: list[str] = []
    for item in value.get("terms", []):
        if not isinstance(item, dict):
            continue
        display = str(item.get("display", "")).strip()
        expected = str(item.get("expected", "")).strip()
        observed = str(item.get("observed", "")).strip()
        similarity = edit_similarity(expected, observed)
        normalized_expected = normalize_speech_text(expected)
        if not display or not expected or not observed:
            hard.append(f"发音词条 {display or '<unknown>'} 缺少真实试听记录")
        elif len(normalized_expected) >= 4 and similarity < 0.55:
            hard.append(f"{display} 的真实试听与预期发音差异过大 ({similarity:.2f})")
        elif similarity < 0.8:
            warnings.append(f"{display} 的 ASR 发音相似度偏低 ({similarity:.2f})，交付前需人工试听")
    return hard, warnings


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", required=True)
    parser.add_argument("--report", required=True)
    parser.add_argument("--tts-script")
    parser.add_argument("--asr-timeline")
    parser.add_argument("--pronunciation-review")
    parser.add_argument("--min-lufs", type=float, default=-18.5)
    parser.add_argument("--max-lufs", type=float, default=-14.0)
    parser.add_argument("--max-true-peak", type=float, default=-1.0)
    parser.add_argument("--max-silence-ratio", type=float, default=0.30)
    parser.add_argument("--max-longest-silence", type=float, default=1.25)
    parser.add_argument("--max-pauses-per-minute", type=float, default=60.0)
    parser.add_argument("--min-asr-similarity", type=float, default=0.82)
    parser.add_argument("--ffmpeg-bin", default="ffmpeg")
    parser.add_argument("--ffprobe-bin", default="ffprobe")
    args = parser.parse_args()

    audio = pathlib.Path(args.audio).resolve()
    report_path = pathlib.Path(args.report).resolve()
    if not audio.is_file() or audio.stat().st_size < 1024:
        raise SystemExit(f"Narration audio is missing or empty: {audio}")
    duration = probe_duration(audio, args.ffprobe_bin)
    loudness = measure_loudness(audio, args.ffmpeg_bin)
    pauses = measure_silences(audio, args.ffmpeg_bin, duration, -42, 0.18)
    errors: list[str] = []
    warnings: list[str] = []
    integrated = loudness["integratedLufs"]
    true_peak = loudness["truePeakDbtp"]
    if not args.min_lufs <= integrated <= args.max_lufs:
        errors.append(
            f"旁白综合响度 {integrated:.2f} LUFS 不在 {args.min_lufs:.1f} 到 {args.max_lufs:.1f} LUFS"
        )
    if true_peak > args.max_true_peak:
        errors.append(f"旁白真峰值 {true_peak:.2f} dBTP 高于 {args.max_true_peak:.1f} dBTP")
    if pauses["silenceRatio"] > args.max_silence_ratio:
        errors.append(f"旁白静音占比 {float(pauses['silenceRatio']) * 100:.1f}% 过高")
    if pauses["longestSilenceSeconds"] > args.max_longest_silence:
        errors.append(f"旁白最长停顿 {pauses['longestSilenceSeconds']:.2f} 秒过长")
    if pauses["pauseCountPerMinute"] > args.max_pauses_per_minute:
        errors.append(f"旁白每分钟停顿 {pauses['pauseCountPerMinute']:.1f} 次，断句过碎")

    asr_similarity: float | None = None
    if args.tts_script and args.asr_timeline:
        script_path = pathlib.Path(args.tts_script).resolve()
        timeline_path = pathlib.Path(args.asr_timeline).resolve()
        if script_path.is_file() and timeline_path.is_file():
            asr_similarity = edit_similarity(
                script_path.read_text(encoding="utf-8"),
                timeline_text(timeline_path),
            )
            if asr_similarity < args.min_asr_similarity:
                errors.append(
                    f"旁白 ASR 与实际 TTS 文案相似度仅 {asr_similarity:.3f}，可懂度或发音存在明显问题"
                )
            elif asr_similarity < 0.90:
                warnings.append(f"旁白 ASR 相似度为 {asr_similarity:.3f}，建议抽听产品名和长句")

    if args.pronunciation_review:
        review_path = pathlib.Path(args.pronunciation_review).resolve()
        if review_path.is_file():
            hard, soft = pronunciation_issues(review_path)
            errors.extend(hard)
            warnings.extend(soft)

    report = {
        "version": 1,
        "audioPath": str(audio),
        "durationSeconds": round(duration, 3),
        **loudness,
        **pauses,
        "asrSimilarity": None if asr_similarity is None else round(asr_similarity, 4),
        "valid": not errors,
        "errors": errors,
        "warnings": warnings,
    }
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))
    if errors:
        raise SystemExit("Audio quality validation failed: " + "；".join(errors))


if __name__ == "__main__":
    main()
