import {execFile} from 'node:child_process';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {afterEach, describe, expect, it} from 'vitest';

const execFileAsync = promisify(execFile);
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, {recursive: true, force: true});
});

describe('qwen_cloud_tts.py', () => {
  it('sends the reference audio and exact transcript to the authenticated clone endpoint', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'qwen-cloud-client-'));
    temporaryDirectories.push(directory);
    const reference = path.join(directory, 'reference.wav');
    const transcript = path.join(directory, 'transcript.json');
    const output = path.join(directory, 'output.wav');
    const referenceBytes = Buffer.alloc(2048, 1);
    referenceBytes.write('RIFF', 0);
    referenceBytes.write('WAVE', 8);
    writeFileSync(reference, referenceBytes);
    writeFileSync(transcript, JSON.stringify({text: '这是参考音色的准确逐字稿。'}));

    const script = path.resolve('deploy/ai-presenter-video-replica/scripts/qwen_cloud_tts.py');
    const pythonTest = `
import importlib.util
import pathlib
import sys
from types import SimpleNamespace

spec = importlib.util.spec_from_file_location('qwen_cloud_tts', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)

wav = bytearray(2048)
wav[0:4] = b'RIFF'
wav[8:12] = b'WAVE'

class Response:
    def __enter__(self): return self
    def __exit__(self, *args): return False
    def read(self, _limit): return bytes(wav)

class Opener:
    def open(self, request, timeout):
        assert request.full_url == 'http://gpu.internal/v1/audio/voice-clone'
        assert request.get_header('Authorization') == 'Bearer unit-test-token'
        body = request.data.decode('utf-8', errors='ignore')
        assert 'name="reference_text"' in body
        assert '这是参考音色的准确逐字稿。' in body
        assert '这是一段克隆声音测试。' in body
        assert 'name="speed"' in body and '1.120' in body
        return Response()

module.DIRECT_OPENER = Opener()
module.synthesize(SimpleNamespace(
    server='http://gpu.internal/v1',
    reference=sys.argv[2],
    reference_transcript=sys.argv[3],
    text='这是一段克隆声音测试。',
    output=sys.argv[4],
    language='Chinese',
    speed=1.12,
    timeout=30,
))
`;
    await execFileAsync('python3', ['-c', pythonTest, script, reference, transcript, output], {
      env: {...process.env, QWEN_TTS_API_TOKEN: 'unit-test-token'},
    });

    expect(readFileSync(output).subarray(0, 12).toString('ascii')).toContain('RIFF');
    expect(readFileSync(output).subarray(8, 12).toString('ascii')).toBe('WAVE');
  });
});
