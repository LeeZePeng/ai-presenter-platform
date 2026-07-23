import {existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {migrateLegacyArtifactPaths} from '../server/path-migration.js';

const directories: string[] = [];

afterEach(() => {
  while (directories.length) rmSync(directories.pop()!, {recursive: true, force: true});
});

describe('artifact path migration', () => {
  it('backs up and rewrites legacy paths once without touching binary files', () => {
    const dataDir = mkdtempSync(path.join(os.tmpdir(), 'presenter-artifact-migration-'));
    directories.push(dataDir);
    const jobDir = path.join(dataDir, 'jobs', 'job-1', 'out');
    mkdirSync(jobDir, {recursive: true});
    const manifest = path.join(jobDir, 'result.json');
    const video = path.join(jobDir, 'final.mp4');
    writeFileSync(manifest, JSON.stringify({outputPath: '/var/lib/ai-presenter/data/jobs/job-1/out/final.mp4'}));
    writeFileSync(video, Buffer.from('/var/lib/ai-presenter/data'));

    const first = migrateLegacyArtifactPaths(dataDir);
    expect(first.migratedFiles).toBe(1);
    expect(JSON.parse(readFileSync(manifest, 'utf8')).outputPath).toBe(path.join(jobDir, 'final.mp4'));
    expect(readFileSync(video, 'utf8')).toBe('/var/lib/ai-presenter/data');
    expect(first.backupDir && existsSync(path.join(first.backupDir, 'jobs/job-1/out/result.json'))).toBe(true);

    writeFileSync(manifest, '/var/lib/ai-presenter/data/late-file');
    const second = migrateLegacyArtifactPaths(dataDir);
    expect(second.migratedFiles).toBe(0);
    expect(readFileSync(manifest, 'utf8')).toContain('/var/lib/ai-presenter/data');
  });
});
