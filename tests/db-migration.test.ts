import {mkdtempSync, rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {AppDatabase} from '../server/db.js';

const directories: string[] = [];

afterEach(() => {
  while (directories.length) rmSync(directories.pop()!, {recursive: true, force: true});
});

describe('database path migration', () => {
  it('rewrites persisted Linux data paths to the current database directory', () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'presenter-db-migration-'));
    directories.push(dataDir);
    const filename = path.join(dataDir, 'platform.sqlite');
    const original = new AppDatabase(filename);
    original.createJob('legacy-job', {
      title: 'legacy',
      mode: 'script',
      replicaMode: 'condensed',
      topic: '',
      script: 'test',
      durationSeconds: 10,
      aspectRatio: '16:9',
      style: '自然专业',
      voiceMode: 'uploaded_audio',
      rightsConfirmed: true,
      assets: {voiceReference: '/var/lib/ai-presenter/data/jobs/legacy-job/voice.wav'},
    });
    original.updateJob('legacy-job', {
      outputPath: '/var/lib/ai-presenter/data/jobs/legacy-job/out/final.mp4',
      metadata: {workspace: '/var/lib/ai-presenter/data/jobs/legacy-job'},
    });
    original.addEvent('legacy-job', 'info', 'legacy', 'legacy path', {
      file: '/var/lib/ai-presenter/data/jobs/legacy-job/out/result.json',
    });
    original.setRuntime('legacy-path', '/var/lib/ai-presenter/data/runtime.json');
    original.createPresenterAsset({
      id: 'legacy-avatar',
      kind: 'avatar',
      name: 'legacy',
      filePath: '/var/lib/ai-presenter/data/presenter-library/legacy-avatar/asset.png',
      originalName: 'asset.png',
      mimeType: 'image/png',
      durationSeconds: null,
    });

    const migrated = new AppDatabase(filename);
    const job = migrated.getJob('legacy-job')!;
    expect(job.assets.voiceReference).toBe(path.join(dataDir, 'jobs/legacy-job/voice.wav'));
    expect(job.outputPath).toBe(path.join(dataDir, 'jobs/legacy-job/out/final.mp4'));
    expect(job.metadata.workspace).toBe(path.join(dataDir, 'jobs/legacy-job'));
    expect(migrated.listLatestEvents('legacy-job').at(-1)?.data.file).toBe(
      path.join(dataDir, 'jobs/legacy-job/out/result.json'),
    );
    expect(migrated.getRuntime('legacy-path')).toBe(path.join(dataDir, 'runtime.json'));
    expect(migrated.getPresenterAsset('legacy-avatar')?.filePath).toBe(
      path.join(dataDir, 'presenter-library/legacy-avatar/asset.png'),
    );
  });
});
