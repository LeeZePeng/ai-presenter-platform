import {execFile} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import ffprobe from '@ffprobe-installer/ffprobe';
import {afterEach, describe, expect, it} from 'vitest';

const execFileAsync = promisify(execFile);
const ffmpegPath = createRequire(import.meta.url)('ffmpeg-static') as string;
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, {recursive: true, force: true});
});

describe('long_form_tts.py', () => {
  it('invalidates cached chunks when the reference/model cache key changes', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'long-form-tts-cache-'));
    temporaryDirectories.push(directory);
    const input = path.join(directory, 'script.txt');
    const output = path.join(directory, 'narration.wav');
    const checkpoints = path.join(directory, 'checkpoints');
    const marker = path.join(directory, 'provider-calls.txt');
    const provider = path.join(directory, 'provider.py');
    writeFileSync(input, '第一段需要足够长来形成独立的语音分块并验证缓存。第二段同样保持完整，用来确认参考音色切换后不会复用旧声音。');
    writeFileSync(provider, `
import argparse
import pathlib
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('--text', required=True)
parser.add_argument('--output', required=True)
parser.add_argument('--marker', required=True)
parser.add_argument('--ffmpeg', required=True)
args = parser.parse_args()
with pathlib.Path(args.marker).open('a', encoding='utf-8') as handle:
    handle.write(args.text + '\\n')
subprocess.run([
    args.ffmpeg, '-y', '-v', 'error', '-f', 'lavfi', '-i',
    'sine=frequency=250:sample_rate=24000:duration=0.5', '-c:a', 'pcm_s16le', args.output,
], check=True)
`);
    const script = path.resolve('deploy/ai-presenter-video-replica/scripts/long_form_tts.py');
    const ttsCommand = `python3 ${provider} --text {text} --output {output} --marker ${marker} --ffmpeg ${ffmpegPath}`;
    const run = async (cacheKey: string): Promise<void> => {
      await execFileAsync('python3', [
        script,
        '--input', input,
        '--output', output,
        '--checkpoint-dir', checkpoints,
        '--provider', 'qwen3-tts-12hz-1.7b-base',
        '--cache-key', cacheKey,
        '--tts-command', ttsCommand,
        '--max-chars', '40',
        '--ffmpeg-bin', ffmpegPath,
        '--ffprobe-bin', ffprobe.path,
      ]);
    };

    await run('reference-a:model-a:speed-1.12');
    const initialCalls = readFileSync(marker, 'utf8').trim().split('\n').length;
    expect(initialCalls).toBeGreaterThan(0);
    await run('reference-a:model-a:speed-1.12');
    expect(readFileSync(marker, 'utf8').trim().split('\n')).toHaveLength(initialCalls);
    await run('reference-b:model-a:speed-1.12');
    expect(readFileSync(marker, 'utf8').trim().split('\n').length).toBe(initialCalls * 2);
  }, 20_000);
});
