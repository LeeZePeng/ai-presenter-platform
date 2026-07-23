#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import subprocess
from collections import Counter
from pathlib import Path


def probe(path: Path) -> tuple[int, int, float]:
    result = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height:format=duration",
            "-of",
            "json",
            str(path),
        ],
        check=True,
        capture_output=True,
        text=True,
        timeout=20,
    )
    value = json.loads(result.stdout)
    stream = value["streams"][0]
    return int(stream["width"]), int(stream["height"]), float(value["format"]["duration"])


def detect_active_crop(path: Path, width: int, height: int, duration: float) -> tuple[int, int, int, int]:
    start = min(max(0.0, duration * 0.15), max(0.0, duration - 1.0))
    result = subprocess.run(
        [
            "ffmpeg",
            "-hide_banner",
            "-ss",
            f"{start:.3f}",
            "-i",
            str(path),
            "-t",
            f"{min(2.0, duration):.3f}",
            "-vf",
            "cropdetect=limit=24:round=2:reset=0",
            "-an",
            "-f",
            "null",
            "-",
        ],
        check=False,
        capture_output=True,
        text=True,
        timeout=30,
    )
    crops = [tuple(map(int, match)) for match in re.findall(r"crop=(\d+):(\d+):(\d+):(\d+)", result.stderr)]
    if not crops:
        return width, height, 0, 0
    crop = Counter(crops).most_common(1)[0][0]
    crop_width, crop_height, crop_x, crop_y = crop
    if crop_width * crop_height < width * height * 0.2:
        return width, height, 0, 0
    return crop_width, crop_height, crop_x, crop_y


def normalize(
    source: Path,
    output: Path,
    size: int,
    layout: str = "square",
    portrait_width: int = 720,
    portrait_height: int = 1280,
) -> dict[str, object]:
    width, height, duration = probe(source)
    crop_width, crop_height, crop_x, crop_y = detect_active_crop(source, width, height, duration)
    legacy_landscape = layout != "landscape" and crop_width > crop_height * 1.2
    output_width = size if layout == "square" else portrait_width
    output_height = size if layout == "square" else portrait_height
    target_ratio = output_width / output_height
    active_ratio = crop_width / crop_height
    if layout == "square":
        render_crop_width = min(crop_width, crop_height)
        render_crop_height = render_crop_width
        render_crop_x = crop_x + max(0, (crop_width - render_crop_width) // 2)
        render_crop_y = crop_y
    elif active_ratio > target_ratio:
        render_crop_height = crop_height
        render_crop_width = max(2, int(render_crop_height * target_ratio) // 2 * 2)
        render_crop_x = crop_x + max(0, (crop_width - render_crop_width) // 2)
        render_crop_y = crop_y
    else:
        render_crop_width = crop_width
        render_crop_height = max(2, int(render_crop_width / target_ratio) // 2 * 2)
        render_crop_x = crop_x
        render_crop_y = crop_y + max(0, (crop_height - render_crop_height) // 2)
    if legacy_landscape:
        filter_complex = (
            f"[0:v]crop={crop_width}:{crop_height}:{crop_x}:{crop_y},split[bgsrc][fgsrc];"
            f"[bgsrc]scale={output_width}:{output_height}:force_original_aspect_ratio=increase:flags=lanczos,"
            f"crop={output_width}:{output_height},boxblur=18:2[bg];"
            f"[fgsrc]scale={output_width}:{output_height}:force_original_aspect_ratio=decrease:flags=lanczos[fg];"
            f"[bg][fg]overlay=(W-w)/2:(H-h)/2,format=yuv420p[normalized]"
        )
        normalization_mode = f"legacy_landscape_contain_{layout}"
    else:
        filter_complex = (
            f"crop={render_crop_width}:{render_crop_height}:{render_crop_x}:{render_crop_y},"
            f"scale={output_width}:{output_height}:flags=lanczos,format=yuv420p"
        )
        normalization_mode = f"active_{layout}_crop"
    output.parent.mkdir(parents=True, exist_ok=True)
    command = [
            "ffmpeg",
            "-y",
            "-i",
            str(source),
            "-an",
    ]
    if legacy_landscape:
        command.extend(["-filter_complex", filter_complex, "-map", "[normalized]"])
    else:
        command.extend(["-map", "0:v:0", "-vf", filter_complex])
    command.extend(
        [
            "-c:v",
            "libx264",
            "-preset",
            "medium",
            "-crf",
            "16",
            "-movflags",
            "+faststart",
            str(output),
        ]
    )
    subprocess.run(
        command,
        check=True,
        timeout=max(120, int(duration * 6)),
    )
    rendered_width, rendered_height, output_duration = probe(output)
    if rendered_width != output_width or rendered_height != output_height or abs(output_duration - duration) > 0.25:
        raise RuntimeError(f"normalized presenter validation failed: {output}")
    return {
        "sourcePath": str(source.resolve()),
        "renderPath": str(output.resolve()),
        "sourceDimensions": {"width": width, "height": height},
        "activeCrop": {"width": crop_width, "height": crop_height, "x": crop_x, "y": crop_y},
        "normalizationMode": normalization_mode,
        "layout": layout,
        "renderCrop": {
            "width": render_crop_width,
            "height": render_crop_height,
            "x": render_crop_x,
            "y": render_crop_y,
        },
        "renderDimensions": {"width": output_width, "height": output_height},
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Remove black bars and create square, portrait, or landscape Remotion presenter assets")
    parser.add_argument("--input", action="append", required=True, type=Path, dest="inputs")
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--size", type=int, default=640)
    parser.add_argument("--layout", choices=("square", "portrait", "landscape"), default="square")
    parser.add_argument("--width", type=int, default=720, dest="portrait_width")
    parser.add_argument("--height", type=int, default=1280, dest="portrait_height")
    parser.add_argument("--manifest", required=True, type=Path)
    args = parser.parse_args()
    if args.size < 256:
        parser.error("--size must be at least 256")
    if args.portrait_width < 256 or args.portrait_height < 256:
        parser.error("--width and --height must be at least 256")

    results = []
    for index, source in enumerate(args.inputs, start=1):
        if not source.is_file():
            parser.error(f"missing input: {source}")
        output = args.output_dir / f"segment-{index:03d}.mp4"
        results.append(
            normalize(
                source.resolve(),
                output,
                args.size,
                args.layout,
                args.portrait_width,
                args.portrait_height,
            )
        )
    manifest = {
        "version": 2,
        "layout": args.layout,
        "presenterRenderPaths": [item["renderPath"] for item in results],
        "segments": results,
    }
    args.manifest.parent.mkdir(parents=True, exist_ok=True)
    args.manifest.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
