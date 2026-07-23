import {mkdtempSync, rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {AppDatabase} from '../server/db.js';

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, {recursive: true, force: true});
});

describe('presenter asset library', () => {
  it('persists reusable avatar and voice records', () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'presenter-assets-'));
    temporaryDirectories.push(directory);
    const database = new AppDatabase(path.join(directory, 'platform.sqlite'));
    database.createPresenterAsset({
      id: 'avatar-1',
      kind: 'avatar',
      name: '主播 A',
      filePath: path.join(directory, 'avatar.png'),
      originalName: 'avatar.png',
      mimeType: 'image/png',
      durationSeconds: null,
    });
    database.createPresenterAsset({
      id: 'voice-1',
      kind: 'voice',
      name: '主播 A 声音',
      filePath: path.join(directory, 'voice.wav'),
      originalName: 'voice.wav',
      mimeType: 'audio/wav',
      durationSeconds: 12.5,
    });

    expect(database.listPresenterAssets('avatar')).toHaveLength(1);
    expect(database.listPresenterAssets('voice')[0]).toMatchObject({id: 'voice-1', durationSeconds: 12.5});
    expect(database.getPresenterAsset('missing')).toBeNull();
  });
});
