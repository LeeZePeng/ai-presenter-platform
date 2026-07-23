import {mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {
  calculateGpuRetryDelayMs,
  ensureRemotionRuntimeLink,
  isRetryableGpuCapacityError,
  stageRemotionFonts,
} from '../server/worker.js';

const directories: string[] = [];

afterEach(() => {
  while (directories.length) rmSync(directories.pop()!, {recursive: true, force: true});
});

describe('ensureRemotionRuntimeLink', () => {
  it('binds a job workspace to the configured shared Remotion runtime', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'presenter-remotion-runtime-'));
    directories.push(root);
    const runtime = path.join(root, 'runtime');
    const workspace = path.join(root, 'job');
    mkdirSync(path.join(runtime, 'node_modules'), {recursive: true});
    mkdirSync(workspace, {recursive: true});
    writeFileSync(path.join(runtime, 'node_modules', 'version.txt'), '4.0.490');

    const link = ensureRemotionRuntimeLink(workspace, runtime);

    expect(realpathSync(link)).toBe(realpathSync(path.join(runtime, 'node_modules')));
  });
});

describe('stageRemotionFonts', () => {
  it('stages real SC font faces under the canonical Remotion public directory', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'presenter-remotion-fonts-'));
    directories.push(root);
    const source = path.join(root, 'source');
    const workspace = path.join(root, 'job');
    mkdirSync(source, {recursive: true});
    const fonts = {
      regular: path.join(source, 'regular.otf'),
      bold: path.join(source, 'bold.otf'),
      black: path.join(source, 'black.otf'),
    };
    for (const [weight, filename] of Object.entries(fonts)) writeFileSync(filename, `font-${weight}`);

    const destination = stageRemotionFonts(workspace, fonts);

    expect(readFileSync(path.join(destination, 'NotoSansCJKSC-Regular.otf'), 'utf8')).toBe('font-regular');
    expect(readFileSync(path.join(destination, 'NotoSansCJKSC-Bold.otf'), 'utf8')).toBe('font-bold');
    expect(readFileSync(path.join(destination, 'NotoSansCJKSC-Black.otf'), 'utf8')).toBe('font-black');
  });
});

describe('GPU capacity retry policy', () => {
  it('retries transient capacity failures but not authentication errors', () => {
    expect(
      isRetryableGpuCapacityError(
        'CompShare StartCompShareInstance failed (226604): This GPU type is currently out of resources.',
      ),
    ).toBe(true);
    expect(isRetryableGpuCapacityError('403 invalid private key')).toBe(false);
  });

  it('backs off from 30 seconds and caps at five minutes', () => {
    expect(calculateGpuRetryDelayMs(1)).toBe(30_000);
    expect(calculateGpuRetryDelayMs(2)).toBe(60_000);
    expect(calculateGpuRetryDelayMs(3)).toBe(120_000);
    expect(calculateGpuRetryDelayMs(99)).toBe(300_000);
  });
});
