"""Private Qwen3-TTS Base voice-clone service for the AI presenter platform."""

from __future__ import annotations

import hashlib
import hmac
import os
import pathlib
import subprocess
import tempfile
import threading
from collections import OrderedDict

import soundfile as sf
from fastapi import FastAPI, File, Form, Header, HTTPException, UploadFile
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask


MODEL_PATH = os.environ.get('QWEN_TTS_MODEL_PATH', '/root/models/Qwen3-TTS-12Hz-1.7B-Base')
DEVICE = os.environ.get('QWEN_TTS_DEVICE', 'cuda:0')
API_TOKEN = os.environ.get('QWEN_TTS_API_TOKEN', '').strip()
FFMPEG_BIN = os.environ.get('FFMPEG_BIN', 'ffmpeg')
MAX_REFERENCE_BYTES = 32 * 1024 * 1024
MAX_TEXT_CHARACTERS = 400
PROMPT_CACHE_SIZE = max(1, min(16, int(os.environ.get('QWEN_TTS_PROMPT_CACHE_SIZE', '8'))))

app = FastAPI(title='Private Qwen3-TTS Voice Clone', docs_url=None, redoc_url=None, openapi_url=None)
_model = None
_load_error = ''
_ready = threading.Event()
_inference_lock = threading.Lock()
_prompt_cache: OrderedDict[str, object] = OrderedDict()


def require_auth(authorization: str | None) -> None:
    if not API_TOKEN:
        raise HTTPException(status_code=503, detail='Qwen TTS API token is not configured')
    supplied = authorization.removeprefix('Bearer ').strip() if authorization else ''
    if not supplied or not hmac.compare_digest(supplied, API_TOKEN):
        raise HTTPException(status_code=401, detail='Unauthorized')


def load_model() -> None:
    global _model, _load_error
    try:
        if not API_TOKEN:
            raise RuntimeError('QWEN_TTS_API_TOKEN is not configured')
        import torch
        from qwen_tts import Qwen3TTSModel

        attention = 'flash_attention_2'
        try:
            import flash_attn  # noqa: F401
        except ImportError:
            attention = 'sdpa'
        _model = Qwen3TTSModel.from_pretrained(
            MODEL_PATH,
            device_map=DEVICE,
            dtype=torch.bfloat16,
            attn_implementation=attention,
        )
    except Exception as error:  # Keep the health endpoint useful during installation failures.
        _load_error = f'{type(error).__name__}: {error}'[:500]
    finally:
        _ready.set()


@app.on_event('startup')
def start_model_loading() -> None:
    threading.Thread(target=load_model, name='qwen-model-loader', daemon=True).start()


@app.get('/v1/health')
def health(authorization: str | None = Header(default=None)) -> dict[str, object]:
    require_auth(authorization)
    if not _ready.is_set():
        return {'status': 'loading', 'model': 'Qwen3-TTS-12Hz-1.7B-Base', 'device': DEVICE}
    if _model is None:
        raise HTTPException(status_code=503, detail=f'Model load failed: {_load_error}')
    return {'status': 'ready', 'model': 'Qwen3-TTS-12Hz-1.7B-Base', 'device': DEVICE}


def prompt_for(reference_path: pathlib.Path, reference_bytes: bytes, reference_text: str):
    cache_key = hashlib.sha256(reference_bytes + b'\0' + reference_text.encode('utf-8')).hexdigest()
    cached = _prompt_cache.get(cache_key)
    if cached is not None:
        _prompt_cache.move_to_end(cache_key)
        return cached
    prompt = _model.create_voice_clone_prompt(
        ref_audio=str(reference_path),
        ref_text=reference_text,
        x_vector_only_mode=False,
    )
    _prompt_cache[cache_key] = prompt
    _prompt_cache.move_to_end(cache_key)
    while len(_prompt_cache) > PROMPT_CACHE_SIZE:
        _prompt_cache.popitem(last=False)
    return prompt


def remove_file(path: str) -> None:
    pathlib.Path(path).unlink(missing_ok=True)


@app.post('/v1/audio/voice-clone')
def voice_clone(
    reference: UploadFile = File(...),
    reference_text: str = Form(...),
    text: str = Form(...),
    language: str = Form('Chinese'),
    speed: float = Form(1.12),
    authorization: str | None = Header(default=None),
) -> FileResponse:
    require_auth(authorization)
    if not _ready.is_set():
        raise HTTPException(status_code=503, detail='Model is still loading')
    if _model is None:
        raise HTTPException(status_code=503, detail=f'Model load failed: {_load_error}')
    reference_text = ' '.join(reference_text.split())
    text = ' '.join(text.split())
    if len(reference_text) < 2:
        raise HTTPException(status_code=422, detail='Reference transcript is too short')
    if not text or len(text) > MAX_TEXT_CHARACTERS:
        raise HTTPException(status_code=422, detail=f'Text must contain 1-{MAX_TEXT_CHARACTERS} characters')
    if not 0.9 <= speed <= 1.25:
        raise HTTPException(status_code=422, detail='Speed must be between 0.9 and 1.25')
    if language not in {'Chinese', 'English', 'Japanese', 'Korean', 'German', 'French', 'Russian', 'Portuguese', 'Spanish', 'Italian'}:
        raise HTTPException(status_code=422, detail='Unsupported language')
    reference_bytes = reference.file.read(MAX_REFERENCE_BYTES + 1)
    if len(reference_bytes) <= 1024 or len(reference_bytes) > MAX_REFERENCE_BYTES:
        raise HTTPException(status_code=422, detail='Reference audio size is invalid')

    temporary_dir = pathlib.Path(tempfile.mkdtemp(prefix='qwen-tts-'))
    reference_path = temporary_dir / 'reference.wav'
    raw_output = temporary_dir / 'raw.wav'
    final_output = temporary_dir / 'output.wav'
    reference_path.write_bytes(reference_bytes)
    try:
        info = sf.info(reference_path)
        if info.duration < 3 or info.duration > 30:
            raise HTTPException(status_code=422, detail='Reference audio must be 3-30 seconds')
        with _inference_lock:
            prompt = prompt_for(reference_path, reference_bytes, reference_text)
            wavs, sample_rate = _model.generate_voice_clone(
                text=text,
                language=language,
                voice_clone_prompt=prompt,
                max_new_tokens=2048,
            )
            sf.write(raw_output, wavs[0], sample_rate, subtype='PCM_16')
        subprocess.run(
            [
                FFMPEG_BIN,
                '-y',
                '-v',
                'error',
                '-i',
                str(raw_output),
                '-af',
                f'atempo={speed:.3f},loudnorm=I=-20:TP=-3:LRA=7',
                '-ac',
                '1',
                '-c:a',
                'pcm_s16le',
                str(final_output),
            ],
            check=True,
            timeout=120,
        )
        if final_output.stat().st_size <= 1024:
            raise RuntimeError('Generated audio is empty')
    except HTTPException:
        remove_file(str(reference_path))
        remove_file(str(raw_output))
        temporary_dir.rmdir()
        raise
    except Exception as error:
        for item in temporary_dir.iterdir():
            item.unlink(missing_ok=True)
        temporary_dir.rmdir()
        raise HTTPException(status_code=500, detail=f'Voice generation failed: {type(error).__name__}') from None

    remove_file(str(reference_path))
    remove_file(str(raw_output))
    return FileResponse(
        final_output,
        media_type='audio/wav',
        filename='qwen-voice-clone.wav',
        headers={'X-TTS-Provider': 'qwen3-tts-12hz-1.7b-base'},
        background=BackgroundTask(lambda: (remove_file(str(final_output)), temporary_dir.rmdir())),
    )
