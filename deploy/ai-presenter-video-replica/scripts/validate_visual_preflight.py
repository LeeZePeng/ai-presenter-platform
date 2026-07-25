#!/usr/bin/env python3
"""Validate required source, presenter, storyboard, and Remotion preflight images."""

from __future__ import annotations

import argparse
import json
import pathlib
import subprocess


def probe_image(path: pathlib.Path, ffprobe_bin: str) -> tuple[int, int]:
    result = subprocess.run(
        [
            ffprobe_bin,
            '-v',
            'error',
            '-select_streams',
            'v:0',
            '-show_entries',
            'stream=width,height',
            '-of',
            'json',
            str(path),
        ],
        capture_output=True,
        text=True,
    )
    if result.returncode:
        return (0, 0)
    streams = json.loads(result.stdout or '{}').get('streams') or []
    if not streams:
        return (0, 0)
    return (int(streams[0].get('width') or 0), int(streams[0].get('height') or 0))


def mean_luma(path: pathlib.Path, ffmpeg_bin: str) -> float | None:
    result = subprocess.run(
        [
            ffmpeg_bin,
            '-v',
            'error',
            '-i',
            str(path),
            '-frames:v',
            '1',
            '-vf',
            'scale=64:64,format=gray',
            '-f',
            'rawvideo',
            '-',
        ],
        capture_output=True,
    )
    if result.returncode or not result.stdout:
        return None
    return round(sum(result.stdout) / len(result.stdout), 3)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument('--source', required=True)
    parser.add_argument('--storyboard', required=True)
    parser.add_argument('--source-frame', action='append', default=[])
    parser.add_argument('--presenter-crop', action='append', default=[])
    parser.add_argument('--remotion-still', action='append', default=[])
    parser.add_argument('--output', required=True)
    parser.add_argument('--ffmpeg-bin', default='ffmpeg')
    parser.add_argument('--ffprobe-bin', default='ffprobe')
    parser.add_argument('--max-luma-difference', type=float, default=48.0)
    args = parser.parse_args()

    source = pathlib.Path(args.source).resolve()
    storyboard = pathlib.Path(args.storyboard).resolve()
    source_frames = [pathlib.Path(item).resolve() for item in args.source_frame]
    presenter_crops = [pathlib.Path(item).resolve() for item in args.presenter_crop]
    remotion_stills = [pathlib.Path(item).resolve() for item in args.remotion_still]
    issues: list[str] = []
    if len(source_frames) < 10:
        issues.append(f'at least 10 source frames are required, found {len(source_frames)}')
    if not presenter_crops:
        issues.append('at least one presenter crop is required')
    if len(remotion_stills) < 2:
        issues.append(f'opening and ending Remotion stills are required, found {len(remotion_stills)}')

    groups = {
        'source': [source],
        'storyboard': [storyboard],
        'source frame': source_frames,
        'presenter crop': presenter_crops,
        'Remotion still': remotion_stills,
    }
    for label, paths in groups.items():
        for candidate in paths:
            if not candidate.is_file() or candidate.stat().st_size < 1024:
                issues.append(f'missing or empty {label}: {candidate}')
                continue
            width, height = probe_image(candidate, args.ffprobe_bin)
            if width <= 0 or height <= 0:
                issues.append(f'unreadable {label}: {candidate}')

    source_luma = mean_luma(source, args.ffmpeg_bin) if source.is_file() else None
    storyboard_luma = mean_luma(storyboard, args.ffmpeg_bin) if storyboard.is_file() else None
    if source_luma is None or storyboard_luma is None:
        issues.append('could not measure source/storyboard luma')

    output = pathlib.Path(args.output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    report = {
        'version': 1,
        'approved': not issues,
        'issues': issues,
        'sourceFramePaths': [str(item) for item in source_frames],
        'storyboardPreviewPath': str(storyboard),
        'presenterCropStillPaths': [str(item) for item in presenter_crops],
        'remotionStillPaths': [str(item) for item in remotion_stills],
        'sourceMeanLuma': source_luma,
        'storyboardMeanLuma': storyboard_luma,
    }
    output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
    print(json.dumps({'output': str(output), 'approved': report['approved'], 'issues': issues}, ensure_ascii=False))
    if issues:
        raise SystemExit(1)


if __name__ == '__main__':
    main()
