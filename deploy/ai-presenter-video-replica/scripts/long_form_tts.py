#!/usr/bin/env python3
"""Sentence-safe, resumable long-form TTS with broadcast-safe assembly."""

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


def run_capture(command: list[str], label: str) -> str:
    result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    if result.returncode:
        detail = (result.stderr or result.stdout)[-2000:].strip()
        raise SystemExit(f'{label} failed ({result.returncode}): {detail}')
    return f'{result.stdout}\n{result.stderr}'


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


def probe_duration(path: pathlib.Path, ffprobe_bin: str) -> float:
    result = subprocess.run(
        [ffprobe_bin, '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', str(path)],
        capture_output=True,
        text=True,
    )
    try:
        duration = float(result.stdout.strip())
    except ValueError as error:
        raise SystemExit(f'Unable to read audio duration: {path}') from error
    if result.returncode or duration <= 0:
        raise SystemExit(f'Unable to read audio duration: {path}')
    return duration


def parse_loudnorm_stats(output: str) -> dict[str, float]:
    matches = re.findall(r'\{\s*"input_i".*?\}', output, flags=re.S)
    if not matches:
        raise SystemExit('FFmpeg loudness analysis returned no measurement')
    try:
        value = json.loads(matches[-1])
        return {
            'input_i': float(value['input_i']),
            'input_lra': float(value['input_lra']),
            'input_tp': float(value['input_tp']),
            'input_thresh': float(value['input_thresh']),
            'target_offset': float(value['target_offset']),
        }
    except (KeyError, TypeError, ValueError, json.JSONDecodeError) as error:
        raise SystemExit('FFmpeg loudness analysis returned invalid measurements') from error


def normalize_audio(
    source: pathlib.Path,
    destination: pathlib.Path,
    ffmpeg_bin: str,
    target_lufs: float,
    true_peak: float,
    trim_edges: bool,
) -> None:
    # `stop_periods=1` terminates the stream at the first natural pause.  Long
    # chunks routinely contain more than one sentence, so that seemingly
    # convenient form silently discarded everything after the first pause.
    # Trim the tail by reversing it and applying the start-only filter instead;
    # internal pauses remain byte-for-byte part of the programme audio.
    trim = (
        'silenceremove=start_periods=1:start_duration=0.03:start_threshold=-42dB:start_silence=0.04,'
        'areverse,'
        'silenceremove=start_periods=1:start_duration=0.08:start_threshold=-42dB:start_silence=0.12,'
        'areverse,'
        if trim_edges
        else ''
    )
    target = f'I={target_lufs}:TP={true_peak}:LRA=7'
    analysis = run_capture(
        [
            ffmpeg_bin,
            '-hide_banner',
            '-nostats',
            '-i',
            str(source),
            '-vn',
            '-af',
            f'{trim}loudnorm={target}:print_format=json',
            '-f',
            'null',
            '-',
        ],
        f'analyze loudness for {source.name}',
    )
    stats = parse_loudnorm_stats(analysis)
    measured = (
        f':measured_I={stats["input_i"]}:measured_LRA={stats["input_lra"]}'
        f':measured_TP={stats["input_tp"]}:measured_thresh={stats["input_thresh"]}'
        f':offset={stats["target_offset"]}:linear=true'
    )
    run(
        [
            ffmpeg_bin,
            '-y',
            '-v',
            'error',
            '-i',
            str(source),
            '-vn',
            '-af',
            f'{trim}loudnorm={target}{measured}',
            '-ac',
            '1',
            '-ar',
            '44100',
            '-c:a',
            'pcm_s16le',
            str(destination),
        ],
        f'normalize {source.name}',
    )


def assemble_with_crossfades(
    sources: list[pathlib.Path],
    destination: pathlib.Path,
    ffmpeg_bin: str,
    crossfade_seconds: float,
) -> None:
    if len(sources) == 1:
        run(
            [
                ffmpeg_bin,
                '-y',
                '-v',
                'error',
                '-i',
                str(sources[0]),
                '-ac',
                '1',
                '-ar',
                '44100',
                '-c:a',
                'pcm_s16le',
                str(destination),
            ],
            'single-chunk narration assembly',
        )
        return
    command = [ffmpeg_bin, '-y', '-v', 'error']
    for source in sources:
        command.extend(['-i', str(source)])
    filters: list[str] = []
    previous = '[0:a]'
    for index in range(1, len(sources)):
        output = f'[joined{index}]'
        filters.append(
            f'{previous}[{index}:a]acrossfade=d={crossfade_seconds:.3f}:c1=tri:c2=tri{output}'
        )
        previous = output
    command.extend(
        [
            '-filter_complex',
            ';'.join(filters),
            '-map',
            previous,
            '-ac',
            '1',
            '-ar',
            '44100',
            '-c:a',
            'pcm_s16le',
            str(destination),
        ]
    )
    run(command, 'crossfaded narration assembly')


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
    parser.add_argument(
        '--cache-key',
        default='',
        help='Reference/model fingerprint. Change it whenever the voice, model, or provider configuration changes.',
    )
    parser.add_argument('--max-chars', type=int, default=180)
    parser.add_argument('--target-lufs', type=float, default=-16.0)
    parser.add_argument('--true-peak', type=float, default=-1.5)
    parser.add_argument('--crossfade-ms', type=float, default=20.0)
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
    synthesis_key = sha256(
        json.dumps(
            {'provider': args.provider, 'ttsCommand': template, 'cacheKey': args.cache_key},
            ensure_ascii=False,
            sort_keys=True,
        )
    )
    manifest_chunks: list[dict[str, object]] = []
    normalized_paths: list[pathlib.Path] = []
    for index, chunk in enumerate(chunks, start=1):
        chunk_hash = sha256(chunk)
        raw_path = checkpoint_dir / f'chunk-{index:03d}.wav'
        normalized_path = checkpoint_dir / f'chunk-{index:03d}.normalized.wav'
        previous = old_chunks.get(index, {})
        reusable = (
            old_manifest.get('version') == 3
            and old_manifest.get('synthesisKeySha256') == synthesis_key
            and previous.get('textSha256') == chunk_hash
            and valid_audio(raw_path, args.ffprobe_bin)
        )
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
        normalize_audio(
            raw_path,
            normalized_path,
            args.ffmpeg_bin,
            args.target_lufs,
            args.true_peak,
            trim_edges=True,
        )
        normalized_duration = probe_duration(normalized_path, args.ffprobe_bin)
        normalized_paths.append(normalized_path)
        manifest_chunks.append(
            {
                'index': index,
                'text': chunk,
                'textSha256': chunk_hash,
                'audioPath': str(raw_path),
                'normalizedAudioPath': str(normalized_path),
                'normalizedDurationSeconds': round(normalized_duration, 6),
            }
        )
        manifest_path.write_text(
            json.dumps(
                {
                    'version': 3,
                    'provider': args.provider,
                    'synthesisKeySha256': synthesis_key,
                    'scriptSha256': sha256(text),
                    'targetLufs': args.target_lufs,
                    'truePeakDb': args.true_peak,
                    'crossfadeMilliseconds': args.crossfade_ms,
                    'chunks': manifest_chunks,
                },
                ensure_ascii=False,
                indent=2,
            ) + '\n',
            encoding='utf-8',
        )

    crossfade_seconds = min(0.08, max(0.0, args.crossfade_ms / 1000))
    assembled_path = checkpoint_dir / 'assembled.wav'
    assemble_with_crossfades(normalized_paths, assembled_path, args.ffmpeg_bin, crossfade_seconds)
    normalize_audio(
        assembled_path,
        output_path,
        args.ffmpeg_bin,
        args.target_lufs,
        args.true_peak,
        trim_edges=False,
    )
    if not valid_audio(output_path, args.ffprobe_bin):
        raise SystemExit(f'Final narration is invalid: {output_path}')
    cursor = 0.0
    for index, chunk in enumerate(manifest_chunks):
        duration = float(chunk['normalizedDurationSeconds'])
        chunk['assembledStartSeconds'] = round(cursor, 6)
        chunk['assembledEndSeconds'] = round(cursor + duration, 6)
        cursor += duration - (crossfade_seconds if index < len(manifest_chunks) - 1 else 0)
    manifest_path.write_text(
        json.dumps(
            {
                'version': 3,
                'provider': args.provider,
                'synthesisKeySha256': synthesis_key,
                'scriptSha256': sha256(text),
                'targetLufs': args.target_lufs,
                'truePeakDb': args.true_peak,
                'crossfadeMilliseconds': args.crossfade_ms,
                'outputDurationSeconds': round(probe_duration(output_path, args.ffprobe_bin), 6),
                'chunks': manifest_chunks,
            },
            ensure_ascii=False,
            indent=2,
        ) + '\n',
        encoding='utf-8',
    )
    print(
        json.dumps(
            {
                'output': str(output_path),
                'chunks': len(chunks),
                'manifest': str(manifest_path),
                'targetLufs': args.target_lufs,
                'crossfadeMilliseconds': args.crossfade_ms,
            }
        )
    )


if __name__ == '__main__':
    main()
