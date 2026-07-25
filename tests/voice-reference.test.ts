import {execFileSync} from 'node:child_process';
import {createRequire} from 'node:module';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ffprobe from '@ffprobe-installer/ffprobe';
import {describe, expect, it} from 'vitest';
import {prepareVoiceReference, voiceReferenceFilter} from '../server/voice-reference.js';

const ffmpegPath = createRequire(import.meta.url)('ffmpeg-static') as string;

describe('prepareVoiceReference', () => {
  it('creates a reusable clean mono reference without an aggressive noise gate', async () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'presenter-voice-reference-'));
    try {
      const source = path.join(workspace, 'source.wav');
      execFileSync(ffmpegPath, [
        '-y',
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=220:sample_rate=48000:duration=2',
        '-f',
        'lavfi',
        '-i',
        'anullsrc=r=48000:cl=mono:d=1',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=330:sample_rate=48000:duration=2',
        '-filter_complex',
        '[0:a][1:a][2:a]concat=n=3:v=0:a=1',
        '-ac',
        '2',
        source,
      ]);
      const first = await prepareVoiceReference(source, workspace, {
        ffmpegBin: ffmpegPath,
        ffprobeBin: ffprobe.path,
      });
      const second = await prepareVoiceReference(source, workspace, {
        ffmpegBin: ffmpegPath,
        ffprobeBin: ffprobe.path,
      });

      expect(first.reused).toBe(false);
      expect(second.reused).toBe(true);
      expect(first.durationSeconds).toBeGreaterThan(4.5);
      expect(first.audioSha256).toBe(second.audioSha256);
      expect(JSON.parse(readFileSync(first.manifestPath, 'utf8'))).toMatchObject({
        version: 1,
        channels: 1,
        sampleRate: 24000,
        filter: voiceReferenceFilter,
      });
      expect(voiceReferenceFilter).toContain('afftdn=nr=10');
      expect(voiceReferenceFilter).not.toContain('agate');
    } finally {
      rmSync(workspace, {recursive: true, force: true});
    }
  });
});
