#!/usr/bin/env python3
"""Managed DashScope Qwen3-TTS reference-voice client with safe voice reuse."""

from __future__ import annotations

import argparse
import base64
import fcntl
import hashlib
import ipaddress
import json
import mimetypes
import os
import pathlib
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.parse
import urllib.request


DEFAULT_SERVER = 'https://dashscope.aliyuncs.com/api/v1'
DEFAULT_MODEL = 'qwen3-tts-vc-2026-01-22'
DEFAULT_TIMEOUT_SECONDS = 300
MAX_JSON_BYTES = 2 * 1024 * 1024
MAX_AUDIO_BYTES = 64 * 1024 * 1024
DIRECT_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def sha256_file(filename: pathlib.Path) -> str:
    digest = hashlib.sha256()
    with filename.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()


def api_key() -> str:
    value = os.environ.get('DASHSCOPE_API_KEY', '').strip()
    if not value:
        raise RuntimeError('DASHSCOPE_API_KEY is not configured')
    return value


def service_url(server: str, suffix: str) -> str:
    base = server.strip().rstrip('/')
    if not base:
        raise ValueError('DashScope API URL is empty')
    parsed = urllib.parse.urlparse(base)
    if parsed.scheme != 'https' or not parsed.hostname:
        raise ValueError('DashScope API URL must be an HTTPS endpoint')
    return f'{base}/{suffix.lstrip("/")}'


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


def language_code(language: str) -> str:
    return {
        'chinese': 'zh',
        'english': 'en',
        'german': 'de',
        'italian': 'it',
        'portuguese': 'pt',
        'spanish': 'es',
        'japanese': 'ja',
        'korean': 'ko',
        'french': 'fr',
        'russian': 'ru',
    }.get(language.strip().lower(), 'zh')


def safe_http_error(error: urllib.error.HTTPError) -> RuntimeError:
    detail = ''
    try:
        detail = error.read(4096).decode('utf-8', errors='replace').strip()
    except OSError:
        pass
    if detail:
        try:
            payload = json.loads(detail)
            if isinstance(payload, dict):
                detail = str(payload.get('message') or payload.get('code') or detail)
        except json.JSONDecodeError:
            pass
    return RuntimeError(f'DashScope Qwen TTS failed with HTTP {error.code}: {detail[:500] or error.reason}')


def post_json(server: str, suffix: str, payload: dict[str, object], timeout: int) -> dict[str, object]:
    request = urllib.request.Request(
        service_url(server, suffix),
        data=json.dumps(payload, ensure_ascii=False, separators=(',', ':')).encode('utf-8'),
        headers={
            'Authorization': f'Bearer {api_key()}',
            'Content-Type': 'application/json',
        },
        method='POST',
    )
    last_error: RuntimeError | None = None
    for attempt in range(3):
        try:
            with DIRECT_OPENER.open(request, timeout=timeout) as response:
                raw = response.read(MAX_JSON_BYTES + 1)
            if len(raw) > MAX_JSON_BYTES:
                raise RuntimeError('DashScope returned an oversized JSON response')
            value = json.loads(raw.decode('utf-8'))
            if not isinstance(value, dict):
                raise RuntimeError('DashScope returned invalid JSON')
            return value
        except urllib.error.HTTPError as error:
            last_error = safe_http_error(error)
            if error.code not in {408, 429, 500, 502, 503, 504} or attempt == 2:
                raise last_error from None
        except (urllib.error.URLError, TimeoutError, json.JSONDecodeError) as error:
            last_error = RuntimeError(f'DashScope Qwen TTS is unreachable: {error}')
            if attempt == 2:
                raise last_error from None
        time.sleep(0.5 * (2 ** attempt))
    raise last_error or RuntimeError('DashScope Qwen TTS request failed')


def voice_cache_key(reference: pathlib.Path, transcript: pathlib.Path, server: str, model: str) -> dict[str, str]:
    return {
        'provider': 'dashscope',
        'server': server.strip().rstrip('/'),
        'model': model,
        'reference_audio_sha256': sha256_file(reference),
        'reference_transcript_sha256': sha256_file(transcript),
    }


def load_cached_voice(cache_path: pathlib.Path, expected: dict[str, str]) -> str | None:
    try:
        value = json.loads(cache_path.read_text(encoding='utf-8'))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(value, dict) or any(value.get(key) != expected_value for key, expected_value in expected.items()):
        return None
    voice = value.get('voice')
    return voice.strip() if isinstance(voice, str) and voice.strip() else None


def save_voice_cache(cache_path: pathlib.Path, expected: dict[str, str], voice: str) -> None:
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    payload = {'version': 1, **expected, 'voice': voice}
    temporary = cache_path.with_name(f'.{cache_path.name}.{os.getpid()}.tmp')
    try:
        temporary.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding='utf-8')
        os.chmod(temporary, 0o600)
        os.replace(temporary, cache_path)
    finally:
        temporary.unlink(missing_ok=True)


def enroll_voice(args: argparse.Namespace, reference: pathlib.Path, transcript: pathlib.Path) -> str:
    expected = voice_cache_key(reference, transcript, args.server, args.model)
    cache_path = pathlib.Path(args.voice_cache).resolve()
    cache_path.parent.mkdir(parents=True, exist_ok=True)
    lock_path = cache_path.with_suffix(f'{cache_path.suffix}.lock')
    with lock_path.open('a+', encoding='utf-8') as lock:
        os.chmod(lock_path, 0o600)
        fcntl.flock(lock.fileno(), fcntl.LOCK_EX)
        cached = load_cached_voice(cache_path, expected)
        if cached:
            return cached
        mime_type = mimetypes.guess_type(reference.name)[0] or 'audio/wav'
        if mime_type == 'audio/x-wav':
            mime_type = 'audio/wav'
        elif mime_type == 'audio/x-m4a':
            mime_type = 'audio/mp4'
        elif mime_type not in {'audio/wav', 'audio/mpeg', 'audio/mp4'}:
            mime_type = 'audio/wav'
        audio = base64.b64encode(reference.read_bytes()).decode('ascii')
        preferred_name = f'aip_{expected["reference_audio_sha256"][:12]}'
        payload = {
            'model': 'qwen-voice-enrollment',
            'input': {
                'action': 'create',
                'target_model': args.model,
                'preferred_name': preferred_name,
                'audio': {'data': f'data:{mime_type};base64,{audio}'},
                'text': transcript_text(transcript),
                'language': language_code(args.language),
            },
        }
        response = post_json(args.server, 'services/audio/tts/customization', payload, args.timeout)
        output = response.get('output')
        if not isinstance(output, dict):
            raise RuntimeError('DashScope voice enrollment returned no output')
        if output.get('fallback_mode') is True:
            reason = str(output.get('fallback_reason') or 'reference audio or transcript did not pass')
            raise RuntimeError(f'DashScope rejected high-fidelity voice enrollment: {reason}')
        returned_model = output.get('target_model')
        if isinstance(returned_model, str) and returned_model and returned_model != args.model:
            raise RuntimeError(f'DashScope enrolled the voice for the wrong model: {returned_model}')
        voice = output.get('voice')
        if not isinstance(voice, str) or not voice.strip():
            raise RuntimeError('DashScope voice enrollment returned no voice ID')
        save_voice_cache(cache_path, expected, voice.strip())
        return voice.strip()


def safe_audio_url(value: object) -> str:
    if not isinstance(value, str) or not value.strip():
        raise RuntimeError('DashScope synthesis returned no audio URL')
    parsed = urllib.parse.urlparse(value)
    if parsed.scheme not in {'http', 'https'} or not parsed.hostname:
        raise RuntimeError('DashScope synthesis returned an invalid audio URL')
    hostname = parsed.hostname.lower()
    if hostname in {'localhost', 'localhost.localdomain'}:
        raise RuntimeError('DashScope synthesis returned an unsafe audio URL')
    try:
        address = ipaddress.ip_address(hostname)
    except ValueError:
        address = None
    if address is not None and (address.is_private or address.is_loopback or address.is_link_local):
        raise RuntimeError('DashScope synthesis returned an unsafe audio URL')
    return value.strip()


def download_audio(url: str, timeout: int) -> bytes:
    request = urllib.request.Request(url, headers={'Accept': 'audio/*'}, method='GET')
    try:
        with DIRECT_OPENER.open(request, timeout=timeout) as response:
            data = response.read(MAX_AUDIO_BYTES + 1)
    except urllib.error.HTTPError as error:
        raise RuntimeError(f'DashScope audio download failed with HTTP {error.code}') from None
    except (urllib.error.URLError, TimeoutError) as error:
        raise RuntimeError(f'DashScope audio download failed: {error}') from None
    if len(data) > MAX_AUDIO_BYTES or len(data) <= 1024:
        raise RuntimeError('DashScope returned invalid or oversized audio')
    return data


def normalize_audio(data: bytes, output: pathlib.Path, ffmpeg_bin: str, speed: float) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='qwen-cloud-tts-') as directory:
        source = pathlib.Path(directory) / 'source.audio'
        destination = pathlib.Path(directory) / 'output.wav'
        source.write_bytes(data)
        command = [
            ffmpeg_bin, '-y', '-v', 'error', '-i', str(source), '-vn',
            '-af', f'atempo={speed:.6f}', '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', str(destination),
        ]
        result = subprocess.run(command, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
        if result.returncode or not destination.is_file() or destination.stat().st_size <= 1024:
            detail = (result.stderr or result.stdout)[-1000:].strip()
            raise RuntimeError(f'Unable to normalize DashScope audio: {detail or "ffmpeg failed"}')
        temporary = output.with_name(f'.{output.name}.{os.getpid()}.tmp')
        try:
            temporary.write_bytes(destination.read_bytes())
            os.replace(temporary, output)
        finally:
            temporary.unlink(missing_ok=True)


def synthesize(args: argparse.Namespace) -> None:
    if args.provider != 'dashscope':
        raise ValueError('Only the managed dashscope provider is supported')
    if args.model != DEFAULT_MODEL:
        raise ValueError(f'Only {DEFAULT_MODEL} is supported')
    reference = pathlib.Path(args.reference).resolve()
    transcript = pathlib.Path(args.reference_transcript).resolve()
    output = pathlib.Path(args.output).resolve()
    if not reference.is_file() or reference.stat().st_size <= 1024:
        raise ValueError(f'Reference audio is missing or invalid: {reference}')
    if reference.stat().st_size > 10 * 1024 * 1024:
        raise ValueError('Reference audio exceeds the 10 MB Qwen-TTS limit')
    text = ' '.join(args.text.split())
    if not text:
        raise ValueError('Synthesis text is empty')
    if len(text) > 600:
        raise ValueError('Synthesis text exceeds the 600-character Qwen-TTS limit; use long_form_tts.py')
    if not 0.95 <= args.speed <= 1.18:
        raise ValueError('Speed must be between 0.95 and 1.18')
    voice = enroll_voice(args, reference, transcript)
    response = post_json(
        args.server,
        'services/aigc/multimodal-generation/generation',
        {
            'model': args.model,
            'input': {
                'text': text,
                'voice': voice,
                'language_type': args.language,
            },
        },
        args.timeout,
    )
    synthesis_output = response.get('output')
    audio = synthesis_output.get('audio') if isinstance(synthesis_output, dict) else None
    url = safe_audio_url(audio.get('url') if isinstance(audio, dict) else None)
    normalize_audio(download_audio(url, args.timeout), output, args.ffmpeg_bin, args.speed)
    print(json.dumps({'output': str(output), 'provider': args.model, 'voiceCache': str(pathlib.Path(args.voice_cache).resolve())}, ensure_ascii=False))


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--provider', default='dashscope')
    parser.add_argument('--server', default=os.environ.get('QWEN_TTS_BASE_URL', DEFAULT_SERVER))
    parser.add_argument('--model', default=os.environ.get('QWEN_TTS_MODEL', DEFAULT_MODEL))
    parser.add_argument('--reference')
    parser.add_argument('--reference-transcript')
    parser.add_argument('--voice-cache')
    parser.add_argument('--text')
    parser.add_argument('--output')
    parser.add_argument('--language', default='Chinese')
    parser.add_argument('--speed', type=float, default=1.08)
    parser.add_argument('--timeout', type=int, default=DEFAULT_TIMEOUT_SECONDS)
    parser.add_argument('--ffmpeg-bin', default='ffmpeg')
    args = parser.parse_args()
    try:
        missing = [name for name in ('reference', 'reference_transcript', 'voice_cache', 'text', 'output') if not getattr(args, name)]
        if missing:
            parser.error(f'missing required arguments: {", ".join("--" + name.replace("_", "-") for name in missing)}')
        synthesize(args)
    except (OSError, RuntimeError, ValueError) as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1) from None


if __name__ == '__main__':
    main()
