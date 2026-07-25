#!/usr/bin/env python3
from __future__ import annotations

import argparse
import concurrent.futures
import hashlib
import json
import math
import mimetypes
import queue
import subprocess
import time
import urllib.parse
import urllib.request
import uuid
from pathlib import Path


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def probe(path: Path, ffprobe_bin: str) -> dict[str, float | int]:
    result = subprocess.run(
        [
            ffprobe_bin,
            "-v",
            "error",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=width,height,avg_frame_rate,nb_frames:format=duration",
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
    stream = value["streams"][0]
    numerator, denominator = str(stream.get("avg_frame_rate") or "25/1").split("/", 1)
    fps = float(numerator) / max(float(denominator), 1)
    duration = float(value["format"]["duration"])
    frame_count = int(stream.get("nb_frames") or round(duration * fps))
    return {
        "width": int(stream["width"]),
        "height": int(stream["height"]),
        "fps": fps,
        "duration": duration,
        "frames": frame_count,
    }


def http_json(base: str, route: str, payload: dict | None = None, timeout: int = 120) -> dict:
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        base.rstrip("/") + route,
        data=data,
        headers={"Content-Type": "application/json"} if data else {},
    )
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8"))


def upload_video(base: str, path: Path) -> str:
    boundary = f"----presenter-upscale-{uuid.uuid4().hex}"
    mime = mimetypes.guess_type(path.name)[0] or "video/mp4"
    chunks = [
        f"--{boundary}\r\n".encode(),
        f'Content-Disposition: form-data; name="image"; filename="{path.name}"\r\n'.encode(),
        f"Content-Type: {mime}\r\n\r\n".encode(),
        path.read_bytes(),
        b"\r\n",
        f"--{boundary}\r\n".encode(),
        b'Content-Disposition: form-data; name="overwrite"\r\n\r\ntrue\r\n',
        f"--{boundary}--\r\n".encode(),
    ]
    body = b"".join(chunks)
    request = urllib.request.Request(
        base.rstrip("/") + "/upload/image",
        data=body,
        method="POST",
        headers={
            "Content-Type": f"multipart/form-data; boundary={boundary}",
            "Content-Length": str(len(body)),
        },
    )
    with urllib.request.urlopen(request, timeout=600) as response:
        result = json.loads(response.read().decode("utf-8"))
    name = str(result.get("name") or "")
    if not name:
        raise RuntimeError(f"ComfyUI video upload failed: {result}")
    subfolder = str(result.get("subfolder") or "").strip("/")
    return f"{subfolder}/{name}" if subfolder else name


def workflow(
    video_name: str,
    model: str,
    width: int,
    height: int,
    fps: float,
    start_frame: int,
    frame_count: int,
    prefix: str,
    per_batch: int,
) -> dict:
    return {
        "1": {
            "class_type": "VHS_LoadVideo",
            "inputs": {
                "video": video_name,
                "force_rate": 0,
                "custom_width": 0,
                "custom_height": 0,
                "frame_load_cap": frame_count,
                "skip_first_frames": start_frame,
                "select_every_nth": 1,
            },
        },
        "2": {"class_type": "UpscaleModelLoader", "inputs": {"model_name": model}},
        "3": {
            "class_type": "ImageUpscaleWithModelBatched",
            "inputs": {"upscale_model": ["2", 0], "images": ["1", 0], "per_batch": per_batch},
        },
        "4": {
            "class_type": "ImageScale",
            "inputs": {
                "image": ["3", 0],
                "upscale_method": "lanczos",
                "width": width,
                "height": height,
                "crop": "disabled",
            },
        },
        "5": {
            "class_type": "VHS_VideoCombine",
            "inputs": {
                "images": ["4", 0],
                "frame_rate": fps,
                "loop_count": 0,
                "filename_prefix": prefix,
                "format": "video/h264-mp4",
                "pix_fmt": "yuv420p",
                "bitrate": 20,
                "megabit": True,
                "save_metadata": False,
                "pingpong": False,
                "save_output": True,
            },
        },
    }


def wait_for_output(base: str, prompt_id: str, poll_seconds: float, max_polls: int) -> dict:
    for _ in range(max_polls):
        history = http_json(base, f"/history/{urllib.parse.quote(prompt_id)}", timeout=60)
        if prompt_id in history:
            entry = history[prompt_id]
            status = entry.get("status", {})
            if status.get("completed") is False:
                raise RuntimeError(f"ComfyUI upscale failed: {status.get('messages', [])[-3:]}")
            return entry
        time.sleep(poll_seconds)
    raise TimeoutError(f"Timed out waiting for upscale prompt {prompt_id}")


def download_output(base: str, entry: dict, destination: Path) -> None:
    candidates = []
    for output in entry.get("outputs", {}).values():
        candidates.extend(output.get("gifs", []))
        candidates.extend(output.get("videos", []))
    if not candidates:
        raise RuntimeError("ComfyUI upscale completed without a video")
    item = candidates[-1]
    query = urllib.parse.urlencode(
        {
            "filename": item["filename"],
            "subfolder": item.get("subfolder", ""),
            "type": item.get("type", "output"),
        }
    )
    destination.parent.mkdir(parents=True, exist_ok=True)
    with urllib.request.urlopen(base.rstrip("/") + "/view?" + query, timeout=1200) as response:
        destination.write_bytes(response.read())


def concat_chunks(chunks: list[Path], output: Path, ffmpeg_bin: str) -> None:
    if len(chunks) == 1:
        output.write_bytes(chunks[0].read_bytes())
        return
    concat_file = output.with_suffix(".concat.txt")
    concat_file.write_text("".join(f"file '{path.as_posix()}'\n" for path in chunks), encoding="utf-8")
    subprocess.run(
        [
            ffmpeg_bin,
            "-y",
            "-f",
            "concat",
            "-safe",
            "0",
            "-i",
            str(concat_file),
            "-an",
            "-c:v",
            "copy",
            "-movflags",
            "+faststart",
            str(output),
        ],
        check=True,
        timeout=600,
    )
    concat_file.unlink(missing_ok=True)


def upscale_one(source: Path, index: int, server: str, args: argparse.Namespace) -> dict:
    source = source.resolve()
    output = args.output_dir.resolve() / f"segment-{index:03d}.mp4"
    checkpoint = args.checkpoint_dir.resolve() / f"segment-{index:03d}"
    checkpoint.mkdir(parents=True, exist_ok=True)
    source_hash = sha256(source)
    receipt_path = checkpoint / "receipt.json"
    if output.is_file() and receipt_path.is_file():
        receipt = json.loads(receipt_path.read_text(encoding="utf-8"))
        if (
            receipt.get("sourceSha256") == source_hash
            and receipt.get("model") == args.model
            and receipt.get("targetDimensions") == {"width": args.width, "height": args.height}
            and receipt.get("outputSha256") == sha256(output)
        ):
            return receipt

    metadata = probe(source, args.ffprobe_bin)
    uploaded_name = upload_video(server, source)
    frames_per_chunk = max(1, round(float(metadata["fps"]) * args.chunk_seconds))
    chunk_count = max(1, math.ceil(int(metadata["frames"]) / frames_per_chunk))
    chunks: list[Path] = []
    prompt_ids: list[str] = []
    started_at = time.time()
    for chunk_index in range(chunk_count):
        start_frame = chunk_index * frames_per_chunk
        frame_count = min(frames_per_chunk, int(metadata["frames"]) - start_frame)
        chunk_path = checkpoint / f"chunk-{chunk_index + 1:03d}.mp4"
        if not chunk_path.is_file():
            graph = workflow(
                uploaded_name,
                args.model,
                args.width,
                args.height,
                float(metadata["fps"]),
                start_frame,
                frame_count,
                f"presenter-upscale/{source_hash[:12]}-{chunk_index + 1:03d}",
                args.per_batch,
            )
            submitted = http_json(
                server,
                "/prompt",
                {"prompt": graph, "client_id": f"presenter-upscale-{uuid.uuid4().hex}"},
                timeout=120,
            )
            if submitted.get("node_errors"):
                raise RuntimeError(f"ComfyUI rejected upscale workflow: {submitted['node_errors']}")
            prompt_id = str(submitted.get("prompt_id") or "")
            if not prompt_id:
                raise RuntimeError(f"ComfyUI did not return a prompt id: {submitted}")
            prompt_ids.append(prompt_id)
            entry = wait_for_output(server, prompt_id, args.poll_seconds, args.max_polls)
            download_output(server, entry, chunk_path)
        chunks.append(chunk_path)

    output.parent.mkdir(parents=True, exist_ok=True)
    concat_chunks(chunks, output, args.ffmpeg_bin)
    rendered = probe(output, args.ffprobe_bin)
    if int(rendered["width"]) != args.width or int(rendered["height"]) != args.height:
        raise RuntimeError(f"Upscaled dimensions do not match target: {output}")
    receipt = {
        "version": 1,
        "provider": "ComfyUI",
        "model": args.model,
        "server": server,
        "sourcePath": str(source),
        "sourceSha256": source_hash,
        "outputPath": str(output),
        "outputSha256": sha256(output),
        "targetDimensions": {"width": args.width, "height": args.height},
        "chunkSeconds": args.chunk_seconds,
        "chunkCount": chunk_count,
        "promptIds": prompt_ids,
        "elapsedSeconds": round(time.time() - started_at, 3),
    }
    receipt_path.write_text(json.dumps(receipt, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return receipt


def run_upscale_jobs(inputs: list[Path], servers: list[str], args: argparse.Namespace) -> list[dict]:
    """Keep every healthy GPU busy instead of pinning segments to a fixed worker.

    Segment durations vary, so modulo assignment leaves fast workers idle behind a
    slow worker's backlog. An availability queue lets the next segment go to the
    first worker that finishes while still enforcing one active segment per GPU.
    """
    available_workers: queue.Queue[str] = queue.Queue()
    for server in servers:
        available_workers.put(server)

    def process(index_and_source: tuple[int, Path]) -> dict:
        index, source = index_and_source
        attempts = max(1, int(getattr(args, "segment_retries", 3)) + 1)
        last_error: Exception | None = None
        for attempt in range(attempts):
            server = available_workers.get()
            try:
                return upscale_one(source, index, server, args)
            except Exception as error:  # noqa: BLE001 - preserve the last provider error after bounded retries
                last_error = error
            finally:
                available_workers.put(server)
            if attempt + 1 < attempts:
                time.sleep(float(getattr(args, "retry_backoff_seconds", 1.0)) * (2 ** attempt))
        raise RuntimeError(
            f"Presenter upscale segment {index} failed after {attempts} attempts: {last_error}"
        ) from last_error

    with concurrent.futures.ThreadPoolExecutor(
        max_workers=min(len(inputs), len(servers)),
        thread_name_prefix="presenter-upscale",
    ) as executor:
        return list(executor.map(process, enumerate(inputs, start=1)))


def main() -> int:
    parser = argparse.ArgumentParser(description="Upscale presenter videos in resumable ComfyUI chunks")
    parser.add_argument("--server", action="append", required=True, dest="servers")
    parser.add_argument("--input", action="append", required=True, type=Path, dest="inputs")
    parser.add_argument("--output-dir", required=True, type=Path)
    parser.add_argument("--checkpoint-dir", required=True, type=Path)
    parser.add_argument("--manifest", required=True, type=Path)
    parser.add_argument("--width", required=True, type=int)
    parser.add_argument("--height", required=True, type=int)
    parser.add_argument("--model", default="4xNomosWebPhoto_RealPLKSR.pth")
    parser.add_argument("--chunk-seconds", type=float, default=4)
    parser.add_argument("--per-batch", type=int, default=4)
    parser.add_argument("--poll-seconds", type=float, default=5)
    parser.add_argument("--max-polls", type=int, default=360)
    parser.add_argument("--segment-retries", type=int, default=3)
    parser.add_argument("--retry-backoff-seconds", type=float, default=1)
    parser.add_argument("--ffmpeg-bin", default="ffmpeg")
    parser.add_argument("--ffprobe-bin", default="ffprobe")
    args = parser.parse_args()
    if args.width < 256 or args.height < 256 or args.width % 2 or args.height % 2:
        parser.error("--width and --height must be even and at least 256")
    if args.chunk_seconds <= 0 or args.per_batch <= 0 or args.segment_retries < 0 or args.retry_backoff_seconds < 0:
        parser.error("chunk and batch settings must be positive")

    receipts = run_upscale_jobs(args.inputs, args.servers, args)
    manifest = {
        "version": 1,
        "provider": "ComfyUI",
        "model": args.model,
        "presenterRenderPaths": [receipt["outputPath"] for receipt in receipts],
        "receipts": receipts,
    }
    args.manifest.parent.mkdir(parents=True, exist_ok=True)
    args.manifest.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(manifest, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
