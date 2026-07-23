#!/usr/bin/env python3
"""Sentence-safe, resumable long-form TTS chunk orchestration and WAV assembly."""

from __future__ import annotations

import argparse
import hashlib
import json
import pathlib
import re
import shlex
import subprocess


def sha256(value: str) -> str:
    return hashlib.sha256(value.encode('utf-8')).hexdigest()


def split_text(text: str, max_chars: int) -> list[str]:
    sentences = [item.strip() for item in re.findall(r'.+?(?:[。！？!?；;]|$)', text, flags=re.S) if item.strip()]
    chunks: list[str] = []
    current = ''
    for sentence in sentences:
        if current and len(current) + len(sentence) > max_chars:
            chunks.append(current)
            current = ''
        if len(sentence) <= max_chars:
            current += sentence
            continue
        if current:
            chunks.append(current)
            current = ''
        chunks.extend(sentence[index:index + max_chars] for index in range(0, len(sentence), max_chars))
    if current:
        chunks.append(current)
    return chunks


def run(command: list[str], label: str) -> None:
    result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if result.returncode:
        detail = (result.stderr or result.stdout)[-2000:].strip()
        raise SystemExit(f'{label} failed ({result.returncode}): {detail}')


def valid_audio(path: pathlib.Path, ffprobe_bin: str) -> bool:
    if not path.is_file() or path.stat().st_size < 1024:
        return False
    result = subprocess.run(
        [ffprobe_bin, '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', str(path)],
        capture_output=True,
        text=True,
    )
    try:
        return result.returncode == 0 and float(result.stdout.strip()) > 0.1
    except ValueError:
        return False


def main() -> None:
    parser = argparse.ArgumentParser(
        description=(
            'Split text at sentence boundaries, resume valid chunk audio, and assemble one normalized WAV. '
            '--tts-command is an argv template containing {text} and {output}; it is never executed through a shell.'
        )
    )
    parser.add_argument('--input', required=True)
    parser.add_argument('--output', required=True)
    parser.add_argument('--checkpoint-dir', required=True)
    parser.add_argument('--provider', default='external')
    parser.add_argument('--tts-command', help='Example: python3 provider.py --text {text} --output {output}')
    parser.add_argument('--max-chars', type=int, default=180)
    parser.add_argument('--ffmpeg-bin', default='ffmpeg')
    parser.add_argument('--ffprobe-bin', default='ffprobe')
    args = parser.parse_args()

    input_path = pathlib.Path(args.input).resolve()
    output_path = pathlib.Path(args.output).resolve()
    checkpoint_dir = pathlib.Path(args.checkpoint_dir).resolve()
    if not input_path.is_file():
        raise SystemExit(f'Missing TTS input: {input_path}')
    text = input_path.read_text(encoding='utf-8').strip()
    if not text:
        raise SystemExit('TTS input is empty')
    chunks = split_text(text, max(40, args.max_chars))
    if not chunks:
        raise SystemExit('TTS input has no speakable chunks')
    checkpoint_dir.mkdir(parents=True, exist_ok=True)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    manifest_path = checkpoint_dir / 'manifest.json'
    old_manifest = {}
    if manifest_path.is_file():
        try:
            old_manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
        except (OSError, json.JSONDecodeError):
            old_manifest = {}
    old_chunks = {int(item.get('index', -1)): item for item in old_manifest.get('chunks', [])}
    template = shlex.split(args.tts_command) if args.tts_command else []
    manifest_chunks = []
    normalized_paths = []
    for index, chunk in enumerate(chunks, start=1):
        chunk_hash = sha256(chunk)
        raw_path = checkpoint_dir / f'chunk-{index:03d}.wav'
        normalized_path = checkpoint_dir / f'chunk-{index:03d}.normalized.wav'
        previous = old_chunks.get(index, {})
        reusable = previous.get('textSha256') == chunk_hash and valid_audio(raw_path, args.ffprobe_bin)
        if not reusable:
            if not template:
                raise SystemExit(
                    f'Missing audio for chunk {index}: provide --tts-command or place a valid file at {raw_path}'
                )
            command = [part.replace('{text}', chunk).replace('{output}', str(raw_path)) for part in template]
            if all('{text}' not in part for part in template) or all('{output}' not in part for part in template):
                raise SystemExit('--tts-command must contain both {text} and {output}')
            run(command, f'TTS chunk {index}')
            if not valid_audio(raw_path, args.ffprobe_bin):
                raise SystemExit(f'TTS provider returned invalid audio for chunk {index}: {raw_path}')
        run(
            [
                args.ffmpeg_bin,
                '-y',
                '-v',
                'error',
                '-i',
                str(raw_path),
                '-vn',
                '-ac',
                '1',
                '-ar',
                '44100',
                '-c:a',
                'pcm_s16le',
                str(normalized_path),
            ],
            f'normalize chunk {index}',
        )
        normalized_paths.append(normalized_path)
        manifest_chunks.append(
            {
                'index': index,
                'text': chunk,
                'textSha256': chunk_hash,
                'audioPath': str(raw_path),
                'normalizedAudioPath': str(normalized_path),
            }
        )
        manifest_path.write_text(
            json.dumps(
                {'version': 1, 'provider': args.provider, 'scriptSha256': sha256(text), 'chunks': manifest_chunks},
                ensure_ascii=False,
                indent=2,
            ) + '\n',
            encoding='utf-8',
        )

    concat_path = checkpoint_dir / 'concat.txt'
    concat_path.write_text(
        ''.join("file '" + str(path).replace("'", "'\\''") + "'\n" for path in normalized_paths),
        encoding='utf-8',
    )
    run(
        [
            args.ffmpeg_bin,
            '-y',
            '-v',
            'error',
            '-f',
            'concat',
            '-safe',
            '0',
            '-i',
            str(concat_path),
            '-c:a',
            'pcm_s16le',
            str(output_path),
        ],
        'final narration assembly',
    )
    if not valid_audio(output_path, args.ffprobe_bin):
        raise SystemExit(f'Final narration is invalid: {output_path}')
    print(json.dumps({'output': str(output_path), 'chunks': len(chunks), 'manifest': str(manifest_path)}))


if __name__ == '__main__':
    main()
