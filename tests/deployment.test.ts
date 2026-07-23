import {mkdtempSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {DeploymentManager, type DeploymentOptions} from '../server/deployment.js';

const fixture = (enabled = false): {root: string; options: DeploymentOptions} => {
  const root = mkdtempSync(path.join(os.tmpdir(), 'deployment-manager-test-'));
  const repoDir = path.join(root, 'checkout');
  const targetDir = path.join(root, 'runtime');
  mkdirSync(path.join(repoDir, '.git'), {recursive: true});
  mkdirSync(targetDir, {recursive: true});
  const script = path.join(root, 'deploy.mjs');
  writeFileSync(script, 'process.exit(0);\n');
  return {
    root,
    options: {
      enabled,
      repoDir,
      targetDir,
      remote: 'origin',
      branch: 'main',
      script,
      pnpmBin: 'pnpm',
      launchdLabel: 'com.example.test',
      healthUrl: 'http://127.0.0.1:1/health',
      healthTimeoutMs: 10_000,
      stateFile: path.join(root, 'data', 'deployment-state.json'),
      logFile: path.join(root, 'data', 'deployment.log'),
    },
  };
};

describe('DeploymentManager', () => {
  it('returns a safe idle snapshot before the first deployment', () => {
    const {options} = fixture();
    const snapshot = new DeploymentManager(options).snapshot();
    expect(snapshot).toMatchObject({
      enabled: false,
      status: 'idle',
      remote: 'origin',
      branch: 'main',
      commit: null,
      logTail: '',
    });
  });

  it('rejects deployment while the feature is disabled', () => {
    const {options} = fixture();
    expect(() => new DeploymentManager(options).trigger(0)).toThrow('一键部署尚未在服务器启用');
  });

  it('rejects deployment while jobs are queued or running', () => {
    const {options} = fixture(true);
    expect(() => new DeploymentManager(options).trigger(2)).toThrow('仍有排队或运行中的任务');
  });

  it('rejects a second deployment represented by persisted running state', () => {
    const {options} = fixture(true);
    mkdirSync(path.dirname(options.stateFile), {recursive: true});
    writeFileSync(
      options.stateFile,
      JSON.stringify({
        status: 'running',
        stage: '质量检查',
        message: '测试中',
        commit: null,
        previousCommit: null,
        requestedAt: new Date().toISOString(),
        startedAt: new Date().toISOString(),
        completedAt: null,
        pid: process.pid,
      }),
    );
    expect(() => new DeploymentManager(options).trigger(0)).toThrow('已有发布正在进行');
    expect(JSON.parse(readFileSync(options.stateFile, 'utf8')).stage).toBe('质量检查');
  });

  it('marks an interrupted persisted runner as failed', () => {
    const {options} = fixture(true);
    mkdirSync(path.dirname(options.stateFile), {recursive: true});
    writeFileSync(options.stateFile, JSON.stringify({
      status: 'running',
      stage: '发布版本',
      message: '同步中',
      commit: 'abc',
      previousCommit: null,
      requestedAt: new Date().toISOString(),
      startedAt: new Date().toISOString(),
      completedAt: null,
      pid: 999_999_999,
    }));
    expect(new DeploymentManager(options).snapshot()).toMatchObject({
      status: 'failed',
      stage: '发布进程中断',
      pid: null,
    });
  });
});
