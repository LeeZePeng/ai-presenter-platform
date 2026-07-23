#!/usr/bin/env python3
"""Transcribe locked narration audio into a normalized whisper.cpp timeline."""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import subprocess
import tempfile
from datetime import datetime, timezone
from typing import Any


def fail(message: str) -> None:
    raise SystemExit(message)


def run(command: list[str], label: str) -> None:
    result = subprocess.run(command, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
    if result.returncode:
        fail(f"{label} failed ({result.returncode}): {result.stderr[-2000:].strip()}")


def seconds(value: Any) -> float | None:
    if not isinstance(value, str):
        return None
    normalized = value.strip().replace(',', '.')
    parts = normalized.split(':')
    if len(parts) != 3:
        return None
    try:
        return round(float(parts[0]) * 3600 + float(parts[1]) * 60 + float(parts[2]), 3)
    except ValueError:
        return None


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--input', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--whisper-bin', required=True)
    parser.add_argument('--whisper-model', required=True)
    parser.add_argument('--language', default='auto')
    parser.add_argument('--threads', type=int, default=8)
    parser.add_argument('--ffmpeg-bin', default=os.environ.get('FFMPEG_BIN', 'ffmpeg'))
    parser.add_argument('--no-gpu', action='store_true')
    args = parser.parse_args()

    input_path = pathlib.Path(args.input).resolve()
    output_path = pathlib.Path(args.output).resolve()
    whisper_bin = pathlib.Path(args.whisper_bin).resolve()
    whisper_model = pathlib.Path(args.whisper_model).resolve()
    for label, candidate in (
        ('input audio', input_path),
        ('whisper executable', whisper_bin),
        ('whisper model', whisper_model),
    ):
        if not candidate.is_file() or candidate.stat().st_size == 0:
            fail(f"Missing {label}: {candidate}")

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='ai-presenter-timeline-') as temporary:
        temporary_path = pathlib.Path(temporary)
        wav_path = temporary_path / 'narration-16k.wav'
        raw_prefix = temporary_path / 'whisper'
        run(
            [
                args.ffmpeg_bin,
                '-y',
                '-v',
                'error',
                '-i',
                str(input_path),
                '-vn',
                '-ac',
                '1',
                '-ar',
                '16000',
                '-c:a',
                'pcm_s16le',
                str(wav_path),
            ],
            'audio normalization',
        )
        command = [
            str(whisper_bin),
            '-m',
            str(whisper_model),
            '-f',
            str(wav_path),
            '-l',
            args.language,
            '-t',
            str(max(1, args.threads)),
            '-oj',
            '-of',
            str(raw_prefix),
        ]
        if args.no_gpu:
            command.append('-ng')
        run(command, 'whisper transcription')
        raw_path = raw_prefix.with_suffix('.json')
        if not raw_path.is_file():
            fail(f"Whisper did not create JSON: {raw_path}")
        raw = json.loads(raw_path.read_text(encoding='utf-8'))

    segments = []
    for item in raw.get('transcription', []):
        text = str(item.get('text', '')).strip()
        timestamps = item.get('timestamps') or {}
        start = seconds(timestamps.get('from'))
        end = seconds(timestamps.get('to'))
        if text and start is not None and end is not None and end >= start:
            segments.append({'startSeconds': start, 'endSeconds': end, 'text': text})
    if not segments:
        fail('Whisper returned no timestamped speech segments')
    result = raw.get('result') if isinstance(raw.get('result'), dict) else {}
    document = {
        'version': 1,
        'audioPath': str(input_path),
        'durationSeconds': segments[-1]['endSeconds'],
        'language': result.get('language') or args.language,
        'model': whisper_model.name,
        'text': ' '.join(segment['text'] for segment in segments),
        'segments': segments,
        'generatedAt': datetime.now(timezone.utc).isoformat(),
    }
    output_path.write_text(json.dumps(document, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'output': str(output_path), 'segments': len(segments), 'language': document['language']}))


if __name__ == '__main__':
    main()
