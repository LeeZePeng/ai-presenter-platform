#!/usr/bin/env python3
"""Measure short-form narration pace before audio is locked for lip-sync."""

from __future__ import annotations

import argparse
import json
import pathlib
import re
import subprocess


HAN_RE = re.compile(r"[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]")
LATIN_WORD_RE = re.compile(r"[A-Za-z]+")
DIGIT_RE = re.compile(r"\d")


def measure_script_units(text: str) -> dict[str, int]:
    han_characters = len(HAN_RE.findall(text))
    latin_words = len(LATIN_WORD_RE.findall(text))
    digits = len(DIGIT_RE.findall(text))
    meaningful_units = han_characters + latin_words * 2 + digits
    return {
        "hanCharacters": han_characters,
        "latinWords": latin_words,
        "digits": digits,
        "meaningfulUnits": meaningful_units,
    }


def probe_duration(audio_path: pathlib.Path, ffprobe_bin: str) -> float:
    result = subprocess.run(
        [
            ffprobe_bin,
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=nw=1:nk=1",
            str(audio_path),
        ],
        capture_output=True,
        text=True,
    )
    try:
        duration = float(result.stdout.strip())
    except ValueError as error:
        raise SystemExit("Unable to read narration duration") from error
    if result.returncode != 0 or duration <= 0:
        raise SystemExit("Unable to read narration duration")
    return duration


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--script", required=True)
    parser.add_argument("--audio", required=True)
    parser.add_argument("--report", required=True)
    parser.add_argument("--min-rate", type=float, default=5.8)
    parser.add_argument("--max-rate", type=float, default=7.2)
    parser.add_argument("--ffprobe-bin", default="ffprobe")
    args = parser.parse_args()

    script_path = pathlib.Path(args.script).resolve()
    audio_path = pathlib.Path(args.audio).resolve()
    report_path = pathlib.Path(args.report).resolve()
    if not script_path.is_file() or not audio_path.is_file():
        raise SystemExit("Narration script or candidate audio is missing")
    units = measure_script_units(script_path.read_text(encoding="utf-8"))
    duration = probe_duration(audio_path, args.ffprobe_bin)
    rate = units["meaningfulUnits"] / duration
    valid = args.min_rate <= rate <= args.max_rate
    report = {
        "version": 1,
        "scriptPath": str(script_path),
        "audioPath": str(audio_path),
        "durationSeconds": round(duration, 3),
        **units,
        "unitsPerSecond": round(rate, 3),
        "minRate": args.min_rate,
        "maxRate": args.max_rate,
        "valid": valid,
    }
    report_path.parent.mkdir(parents=True, exist_ok=True)
    report_path.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(report, ensure_ascii=False))
    if not valid:
        raise SystemExit(
            f"Narration pace {rate:.2f} units/s is outside {args.min_rate:.2f}-{args.max_rate:.2f}; "
            "regenerate the candidate TTS before locking audio or requesting lip-sync"
        )


if __name__ == "__main__":
    main()
