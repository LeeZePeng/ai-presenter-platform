#!/usr/bin/env python3
"""Authenticated client for the private Qwen3-TTS reference-voice service."""

from __future__ import annotations

import argparse
import json
import os
import pathlib
import secrets
import sys
import urllib.error
import urllib.request


DEFAULT_TIMEOUT_SECONDS = 300
MAX_RESPONSE_BYTES = 64 * 1024 * 1024
DIRECT_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def service_url(server: str, suffix: str) -> str:
    base = server.strip().rstrip('/')
    if not base:
        raise ValueError('Qwen TTS service URL is empty')
    return f'{base}/{suffix.lstrip("/")}'


def bearer_headers() -> dict[str, str]:
    token = os.environ.get('QWEN_TTS_API_TOKEN', '').strip()
    if not token:
        raise RuntimeError('QWEN_TTS_API_TOKEN is not configured')
    return {'Authorization': f'Bearer {token}'}


def transcript_text(filename: pathlib.Path) -> str:
    if not filename.is_file():
        raise ValueError(f'Reference transcript does not exist: {filename}')
    raw = filename.read_text(encoding='utf-8').strip()
    if not raw:
        raise ValueError('Reference transcript is empty')
    try:
        value = json.loads(raw)
    except json.JSONDecodeError:
        value = None
    text = value.get('text', '') if isinstance(value, dict) else raw
    text = ' '.join(str(text).split())
    if len(text) < 2:
        raise ValueError('Reference transcript is too short for high-fidelity cloning')
    return text


def multipart_body(fields: dict[str, str], file_field: str, filename: pathlib.Path) -> tuple[bytes, str]:
    boundary = f'----ai-presenter-{secrets.token_hex(16)}'
    body = bytearray()
    for name, value in fields.items():
        body.extend(f'--{boundary}\r\n'.encode())
        body.extend(f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode())
        body.extend(value.encode('utf-8'))
        body.extend(b'\r\n')
    body.extend(f'--{boundary}\r\n'.encode())
    body.extend(
        f'Content-Disposition: form-data; name="{file_field}"; filename="reference.wav"\r\n'.encode()
    )
    body.extend(b'Content-Type: audio/wav\r\n\r\n')
    body.extend(filename.read_bytes())
    body.extend(b'\r\n')
    body.extend(f'--{boundary}--\r\n'.encode())
    return bytes(body), f'multipart/form-data; boundary={boundary}'


def safe_http_error(error: urllib.error.HTTPError) -> RuntimeError:
    detail = ''
    try:
        detail = error.read(4096).decode('utf-8', errors='replace').strip()
    except OSError:
        pass
    if detail:
        try:
            payload = json.loads(detail)
            detail = str(payload.get('detail', detail)) if isinstance(payload, dict) else detail
        except json.JSONDecodeError:
            pass
    return RuntimeError(f'Qwen TTS request failed with HTTP {error.code}: {detail[:500] or error.reason}')


def health(server: str, timeout: int) -> None:
    request = urllib.request.Request(service_url(server, 'health'), headers=bearer_headers(), method='GET')
    try:
        with DIRECT_OPENER.open(request, timeout=timeout) as response:
            payload = json.loads(response.read(64 * 1024).decode('utf-8'))
    except urllib.error.HTTPError as error:
        raise safe_http_error(error) from None
    except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
        raise RuntimeError(f'Qwen TTS health check failed: {error}') from None
    if not isinstance(payload, dict) or payload.get('status') != 'ready':
        raise RuntimeError(f'Qwen TTS service is not ready: {payload}')
    print(json.dumps({'status': 'ready', 'model': payload.get('model')}, ensure_ascii=False))


def synthesize(args: argparse.Namespace) -> None:
    reference = pathlib.Path(args.reference).resolve()
    transcript = pathlib.Path(args.reference_transcript).resolve()
    output = pathlib.Path(args.output).resolve()
    if not reference.is_file() or reference.stat().st_size <= 1024:
        raise ValueError(f'Reference audio is missing or invalid: {reference}')
    text = ' '.join(args.text.split())
    if not text:
        raise ValueError('Synthesis text is empty')
    if not 0.9 <= args.speed <= 1.25:
        raise ValueError('Speed must be between 0.9 and 1.25')

    body, content_type = multipart_body(
        {
            'reference_text': transcript_text(transcript),
            'text': text,
            'language': args.language,
            'speed': f'{args.speed:.3f}',
        },
        'reference',
        reference,
    )
    headers = bearer_headers()
    headers['Content-Type'] = content_type
    headers['Content-Length'] = str(len(body))
    request = urllib.request.Request(service_url(args.server, 'audio/voice-clone'), data=body, headers=headers)
    try:
        with DIRECT_OPENER.open(request, timeout=args.timeout) as response:
            data = response.read(MAX_RESPONSE_BYTES + 1)
    except urllib.error.HTTPError as error:
        raise safe_http_error(error) from None
    except (urllib.error.URLError, TimeoutError) as error:
        raise RuntimeError(f'Qwen TTS service is unreachable: {error}') from None
    if len(data) > MAX_RESPONSE_BYTES:
        raise RuntimeError('Qwen TTS response exceeded the safety limit')
    if len(data) <= 1024 or data[:4] != b'RIFF' or data[8:12] != b'WAVE':
        raise RuntimeError('Qwen TTS service returned invalid WAV audio')

    output.parent.mkdir(parents=True, exist_ok=True)
    temporary = output.with_name(f'.{output.name}.{os.getpid()}.tmp')
    try:
        temporary.write_bytes(data)
        os.replace(temporary, output)
    finally:
        temporary.unlink(missing_ok=True)
    print(json.dumps({'output': str(output), 'provider': 'qwen3-tts-12hz-1.7b-base'}, ensure_ascii=False))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--server', default=os.environ.get('QWEN_TTS_BASE_URL', ''))
    parser.add_argument('--health', action='store_true', help='Check authenticated service readiness and exit')
    parser.add_argument('--reference')
    parser.add_argument('--reference-transcript')
    parser.add_argument('--text')
    parser.add_argument('--output')
    parser.add_argument('--language', default='Chinese')
    parser.add_argument('--speed', type=float, default=1.12)
    parser.add_argument('--timeout', type=int, default=DEFAULT_TIMEOUT_SECONDS)
    args = parser.parse_args()
    try:
        if args.health:
            health(args.server, args.timeout)
            return
        missing = [name for name in ('reference', 'reference_transcript', 'text', 'output') if not getattr(args, name)]
        if missing:
            parser.error(f'missing required arguments: {", ".join("--" + name.replace("_", "-") for name in missing)}')
        synthesize(args)
    except (OSError, RuntimeError, ValueError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == '__main__':
    main()
