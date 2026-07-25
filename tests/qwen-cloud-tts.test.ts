import {execFile, execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {afterEach, describe, expect, it} from 'vitest';

const execFileAsync = promisify(execFile);
const ffmpegPath = createRequire(import.meta.url)('ffmpeg-static') as string;
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, {recursive: true, force: true});
});

describe('qwen_cloud_tts.py', () => {
  it('turns cloud authorization failures into an actionable Chinese error', async () => {
    const script = path.resolve('deploy/ai-presenter-video-replica/scripts/qwen_cloud_tts.py');
    const pythonTest = `
import importlib.util, io, sys, urllib.error
spec = importlib.util.spec_from_file_location('qwen_cloud_tts', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
error = urllib.error.HTTPError(
    'https://dashscope.example/api/v1',
    403,
    'Forbidden',
    {},
    io.BytesIO(b'{"message":"Access to model denied"}'),
)
message = str(module.safe_http_error(error))
assert '百炼账户无权调用该模型' in message
assert '账户欠费' in message
assert 'HTTP 403' in message
`;
    await execFileAsync('python3', ['-c', pythonTest, script]);
  });

  it('enrolls the exact reference with managed Qwen VC and reuses the returned voice for synthesis', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'qwen-cloud-client-'));
    temporaryDirectories.push(directory);
    const reference = path.join(directory, 'reference.wav');
    const transcript = path.join(directory, 'transcript.json');
    const output = path.join(directory, 'output.wav');
    const voiceCache = path.join(directory, 'voice-cache.json');
    execFileSync(ffmpegPath, [
      '-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=24000:duration=1',
      '-ac', '1', '-c:a', 'pcm_s16le', reference,
    ]);
    writeFileSync(transcript, JSON.stringify({text: '这是参考音色的准确逐字稿。'}));

    const script = path.resolve('deploy/ai-presenter-video-replica/scripts/qwen_cloud_tts.py');
    const pythonTest = `
import importlib.util
import json
import pathlib
import sys
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location('qwen_cloud_tts', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

wav = pathlib.Path(sys.argv[2]).read_bytes()
calls = []

class Response:
    def __init__(self, data): self.data = data
    def __enter__(self): return self
    def __exit__(self, *args): return False
    def read(self, _limit): return self.data

class Opener:
    def open(self, request, timeout):
        calls.append(request.full_url)
        if request.full_url.endswith('/services/audio/tts/customization'):
            assert request.get_header('Authorization') == 'Bearer unit-test-token'
            body = json.loads(request.data)
            assert body['model'] == 'qwen-voice-enrollment'
            assert body['input']['action'] == 'create'
            assert body['input']['target_model'] == 'qwen3-tts-vc-2026-01-22'
            assert body['input']['preferred_name'].startswith('aip_')
            assert body['input']['text'] == '这是参考音色的准确逐字稿。'
            assert body['input']['language'] == 'zh'
            assert body['input']['audio']['data'].startswith('data:audio/wav;base64,')
            return Response(json.dumps({'output': {'voice': 'managed-reference-voice'}}).encode())
        if request.full_url.endswith('/services/aigc/multimodal-generation/generation'):
            assert request.get_header('Authorization') == 'Bearer unit-test-token'
            body = json.loads(request.data)
            assert body['model'] == 'qwen3-tts-vc-2026-01-22'
            assert body['input']['text'] in {'这是一段克隆声音测试。', '第二次合成必须复用同一个音色。'}
            assert body['input']['voice'] == 'managed-reference-voice'
            assert body['input']['language_type'] == 'Chinese'
            return Response(json.dumps({'output': {'audio': {'url': 'https://audio.example/output.wav'}}}).encode())
        assert request.full_url == 'https://audio.example/output.wav'
        assert request.get_header('Authorization') is None
        return Response(wav)

module.DIRECT_OPENER = Opener()
module.synthesize(SimpleNamespace(
    provider='dashscope',
    server='https://dashscope.example/api/v1',
    model='qwen3-tts-vc-2026-01-22',
    reference=sys.argv[2],
    reference_transcript=sys.argv[3],
    voice_cache=sys.argv[5],
    text='这是一段克隆声音测试。',
    output=sys.argv[4],
    language='Chinese',
    speed=1.12,
    timeout=30,
    ffmpeg_bin=sys.argv[6],
))
module.synthesize(SimpleNamespace(
    provider='dashscope',
    server='https://dashscope.example/api/v1',
    model='qwen3-tts-vc-2026-01-22',
    reference=sys.argv[2],
    reference_transcript=sys.argv[3],
    voice_cache=sys.argv[5],
    text='第二次合成必须复用同一个音色。',
    output=sys.argv[4],
    language='Chinese',
    speed=1.08,
    timeout=30,
    ffmpeg_bin=sys.argv[6],
))
assert len(calls) == 5
assert sum(url.endswith('/services/audio/tts/customization') for url in calls) == 1
`;
    await execFileAsync('python3', ['-c', pythonTest, script, reference, transcript, output, voiceCache, ffmpegPath], {
      env: {...process.env, DASHSCOPE_API_KEY: 'unit-test-token'},
    });

    expect(readFileSync(output).subarray(0, 12).toString('ascii')).toContain('RIFF');
    expect(readFileSync(output).subarray(8, 12).toString('ascii')).toBe('WAVE');
    expect(JSON.parse(readFileSync(voiceCache, 'utf8'))).toMatchObject({
      provider: 'dashscope',
      model: 'qwen3-tts-vc-2026-01-22',
      voice: 'managed-reference-voice',
    });
    expect(readFileSync(voiceCache, 'utf8')).not.toContain('unit-test-token');
  });

  it('rejects DashScope fallback enrollment instead of accepting a degraded clone', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'qwen-cloud-fallback-'));
    temporaryDirectories.push(directory);
    const reference = path.join(directory, 'reference.wav');
    const transcript = path.join(directory, 'transcript.json');
    const output = path.join(directory, 'output.wav');
    const voiceCache = path.join(directory, 'voice-cache.json');
    execFileSync(ffmpegPath, [
      '-y', '-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=220:sample_rate=24000:duration=1',
      '-ac', '1', '-c:a', 'pcm_s16le', reference,
    ]);
    writeFileSync(transcript, JSON.stringify({text: '准确逐字稿。'}));
    const script = path.resolve('deploy/ai-presenter-video-replica/scripts/qwen_cloud_tts.py');
    const pythonTest = `
import importlib.util, json, pathlib, sys
from types import SimpleNamespace
spec = importlib.util.spec_from_file_location('qwen_cloud_tts', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
class Response:
    def __enter__(self): return self
    def __exit__(self, *args): return False
    def read(self, _limit):
        return json.dumps({'output': {'voice': 'degraded', 'fallback_mode': True, 'fallback_reason': 'no_valid_asr_segments'}}).encode()
class Opener:
    def open(self, request, timeout): return Response()
module.DIRECT_OPENER = Opener()
args = SimpleNamespace(provider='dashscope', server='https://dashscope.example/api/v1', model='qwen3-tts-vc-2026-01-22', reference=sys.argv[2], reference_transcript=sys.argv[3], voice_cache=sys.argv[5], text='测试。', output=sys.argv[4], language='Chinese', speed=1.08, timeout=30, ffmpeg_bin=sys.argv[6])
try:
    module.synthesize(args)
    raise AssertionError('fallback enrollment must fail')
except RuntimeError as error:
    assert 'no_valid_asr_segments' in str(error)
assert not pathlib.Path(sys.argv[5]).exists()
`;
    await execFileAsync('python3', ['-c', pythonTest, script, reference, transcript, output, voiceCache, ffmpegPath], {
      env: {...process.env, DASHSCOPE_API_KEY: 'unit-test-token'},
    });
  });
});
