import {mkdtempSync, rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {AppDatabase} from '../server/db.js';
import {PowerCoordinator} from '../server/power-coordinator.js';
import type {InstanceController} from '../server/compshare.js';
import type {InstanceSnapshot, InstanceState} from '../server/types.js';

class ImmediateController implements InstanceController {
  state: InstanceState = 'Stopped';
  starts = 0;
  stops = 0;
  nowSeconds = 0;
  describeError: Error | null = null;

  async describe(): Promise<InstanceSnapshot> {
    if (this.describeError) throw this.describeError;
    return {
      id: 'gpu-test',
      name: 'test',
      state: this.state,
      gpuType: '4090',
      gpuCount: 1,
      hourlyPrice: 1,
      startTime: this.state === 'Running' ? this.nowSeconds : null,
    };
  }

  async start(): Promise<void> {
    this.starts += 1;
    this.state = 'Running';
  }

  async stop(): Promise<void> {
    this.stops += 1;
    this.state = 'Stopped';
  }
}

const directories: string[] = [];
afterEach(() => directories.splice(0).forEach((directory) => rmSync(directory, {recursive: true, force: true})));

describe('PowerCoordinator', () => {
  it('clears a transient instance status error after the next successful snapshot', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'presenter-power-'));
    directories.push(directory);
    const db = new AppDatabase(path.join(directory, 'db.sqlite'));
    const controller = new ImmediateController();
    const power = new PowerCoordinator(db, controller, {
      windowMs: 1000,
      tickMs: 50,
      startTimeoutMs: 1000,
      healthUrl: '',
      mockGpu: true,
      mockCodex: true,
      codexModel: 'test-model',
    });

    controller.describeError = new Error('fetch failed');
    const failed = await power.systemSnapshot();
    expect(failed.instance.state).toBe('Unknown');
    expect(failed.lastPowerError).toBe('实例状态查询失败：fetch failed');

    controller.describeError = null;
    const recovered = await power.systemSnapshot();
    expect(recovered.instance.state).toBe('Stopped');
    expect(recovered.lastPowerError).toBeNull();
  });

  it('starts on demand, extends while jobs exist, then stops at an idle boundary', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'presenter-power-'));
    directories.push(directory);
    const db = new AppDatabase(path.join(directory, 'db.sqlite'));
    const controller = new ImmediateController();
    let clock = 1_000_000;
    controller.nowSeconds = Math.floor(clock / 1000);
    const power = new PowerCoordinator(
      db,
      controller,
      {
        windowMs: 1000,
        tickMs: 50,
        startTimeoutMs: 1000,
        healthUrl: '',
        mockGpu: true,
        mockCodex: true,
        codexModel: 'test-model',
      },
      () => clock,
    );

    await power.ensureRunning('test');
    expect(controller.starts).toBe(1);
    expect(controller.state).toBe('Running');

    db.createJob('job-1', {
      title: 'test',
      mode: 'topic',
      replicaMode: 'condensed',
      topic: 'topic',
      script: '',
      durationSeconds: 5,
      aspectRatio: '16:9',
      style: 'natural',
      voiceMode: 'system_voice',
      rightsConfirmed: true,
      assets: {avatarImage: '/tmp/avatar.png'},
    });
    clock += 1100;
    await power.checkBillingBoundary();
    expect(controller.stops).toBe(0);
    expect(Number(db.getRuntime('next_power_check_at'))).toBeGreaterThan(clock);

    db.updateJob('job-1', {status: 'succeeded', finishedAt: new Date(clock).toISOString()});
    clock = Number(db.getRuntime('next_power_check_at')) + 1;
    await power.checkBillingBoundary();
    expect(controller.stops).toBe(1);
    expect(controller.state).toBe('Stopped');
    expect(db.getRuntime('next_power_check_at')).toBeNull();
  });

  it('keeps an instance running for a registered external task even when the queue is empty', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'presenter-power-'));
    directories.push(directory);
    const db = new AppDatabase(path.join(directory, 'db.sqlite'));
    const controller = new ImmediateController();
    let clock = 1_000_000;
    controller.nowSeconds = Math.floor(clock / 1000);
    const power = new PowerCoordinator(
      db,
      controller,
      {
        windowMs: 1000,
        tickMs: 50,
        startTimeoutMs: 1000,
        healthUrl: '',
        mockGpu: true,
        mockCodex: true,
        codexModel: 'test-model',
      },
      () => clock,
    );

    await power.manualStart({leaseMs: 5 * 60 * 1000, reason: '断点续跑'});
    clock += 1100;
    await power.checkBillingBoundary();
    expect(controller.stops).toBe(0);
    expect(db.getRuntime('external_power_lease_reason')).toBe('断点续跑');
    expect(Number(db.getRuntime('next_power_check_at'))).toBeGreaterThan(clock);

    clock = Number(db.getRuntime('external_power_lease_until')) + 1;
    clock = Math.max(clock, Number(db.getRuntime('next_power_check_at')) + 1);
    await power.checkBillingBoundary();
    expect(controller.stops).toBe(1);
    expect(db.getRuntime('external_power_lease_until')).toBeNull();
    expect(db.getRuntime('next_power_check_at')).toBeNull();
  });

  it('manual stop releases an external task lease', async () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), 'presenter-power-'));
    directories.push(directory);
    const db = new AppDatabase(path.join(directory, 'db.sqlite'));
    const controller = new ImmediateController();
    const power = new PowerCoordinator(db, controller, {
      windowMs: 1000,
      tickMs: 50,
      startTimeoutMs: 1000,
      healthUrl: '',
      mockGpu: true,
      mockCodex: true,
      codexModel: 'test-model',
    });

    await power.manualStart({leaseMs: 5 * 60 * 1000, reason: '手动生成'});
    await power.manualStop();
    expect(controller.stops).toBe(1);
    expect(db.getRuntime('external_power_lease_until')).toBeNull();
    expect(db.getRuntime('external_power_lease_reason')).toBeNull();
  });
});
