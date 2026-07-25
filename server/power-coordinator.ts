import type {AppDatabase} from './db.js';
import type {InstanceController} from './compshare.js';
import type {InstanceSnapshot, SystemSnapshot} from './types.js';

type PowerOptions = {
  windowMs: number;
  tickMs: number;
  startTimeoutMs: number;
  healthUrl: string;
  mockGpu: boolean;
  mockCodex: boolean;
  codexModel: string;
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export class PowerCoordinator {
  private timer: NodeJS.Timeout | null = null;
  private gate: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly db: AppDatabase,
    private readonly controller: InstanceController,
    private readonly options: PowerOptions,
    private readonly now: () => number = Date.now,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.checkBillingBoundary(), this.options.tickMs);
    this.timer.unref();
    void this.checkBillingBoundary();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private withLock<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.gate.then(fn, fn);
    this.gate = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private setAction(message: string): void {
    this.db.setRuntime('last_power_action', message);
    this.db.setRuntime('last_power_error', null);
  }

  private setError(error: unknown): void {
    this.db.setRuntime('last_power_error', error instanceof Error ? error.message : String(error));
  }

  private getActiveExternalLease(): {untilMs: number; reason: string} | null {
    const untilMs = Number(this.db.getRuntime('external_power_lease_until') ?? 0);
    if (!Number.isFinite(untilMs) || untilMs <= this.now()) {
      if (untilMs) {
        this.db.setRuntime('external_power_lease_until', null);
        this.db.setRuntime('external_power_lease_reason', null);
      }
      return null;
    }
    return {
      untilMs,
      reason: this.db.getRuntime('external_power_lease_reason') || '平台外任务',
    };
  }

  acquireExternalLease(durationMs: number, reason = '平台外任务'): {until: string; reason: string} {
    if (!Number.isFinite(durationMs) || durationMs < 5 * 60 * 1000 || durationMs > 12 * 60 * 60 * 1000) {
      throw new Error('算力保留时间必须在 5 分钟到 12 小时之间');
    }
    const existing = this.getActiveExternalLease();
    const untilMs = Math.max(existing?.untilMs ?? 0, this.now() + durationMs);
    const normalizedReason = reason.trim().slice(0, 120) || '平台外任务';
    this.db.setRuntime('external_power_lease_until', String(untilMs));
    this.db.setRuntime('external_power_lease_reason', normalizedReason);
    this.ensureWindow(this.now());
    this.setAction(`${normalizedReason} 已登记，算力保留至 ${new Date(untilMs).toISOString()}`);
    return {until: new Date(untilMs).toISOString(), reason: normalizedReason};
  }

  releaseExternalLease(): void {
    this.db.setRuntime('external_power_lease_until', null);
    this.db.setRuntime('external_power_lease_reason', null);
    this.setAction('平台外任务算力保留已解除');
  }

  private async describeInstance(): Promise<InstanceSnapshot> {
    try {
      return await this.controller.describe();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`实例状态查询失败：${message}`);
    }
  }

  private clearRecoveredStatusError(): void {
    const error = this.db.getRuntime('last_power_error');
    if (
      error === 'fetch failed' ||
      error?.startsWith('实例状态查询失败：') ||
      error?.includes('DescribeCompShareInstance')
    ) {
      this.db.setRuntime('last_power_error', null);
    }
  }

  private ensureWindow(anchorMs = this.now()): void {
    const currentNext = Number(this.db.getRuntime('next_power_check_at') ?? 0);
    if (currentNext > this.now()) return;
    const elapsed = Math.max(0, this.now() - anchorMs);
    const windows = Math.floor(elapsed / this.options.windowMs) + 1;
    const next = anchorMs + windows * this.options.windowMs;
    this.db.setRuntime('billing_window_started_at', new Date(anchorMs).toISOString());
    this.db.setRuntime('next_power_check_at', String(next));
  }

  private resetWindow(anchorMs = this.now()): void {
    this.db.setRuntime('billing_window_started_at', new Date(anchorMs).toISOString());
    this.db.setRuntime('next_power_check_at', String(anchorMs + this.options.windowMs));
  }

  private async probeHealthy(attempts = 1): Promise<boolean> {
    if (this.options.mockGpu || !this.options.healthUrl) return true;
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      try {
        const response = await fetch(this.options.healthUrl, {signal: AbortSignal.timeout(8000)});
        if (response.ok) return true;
      } catch {
        // Retry transient network failures before deciding the service needs recovery.
      }
      if (attempt < attempts) await sleep(5000);
    }
    return false;
  }

  private async restartUnhealthyInstance(reason: string): Promise<void> {
    this.setAction(`${reason}，数字人服务无响应，正在重启实例`);
    await this.controller.stop();
    const stopDeadline = this.now() + Math.min(this.options.startTimeoutMs, 5 * 60 * 1000);
    while (this.now() < stopDeadline) {
      const instance = await this.describeInstance();
      if (instance.state === 'Stopped') {
        await this.controller.start();
        this.resetWindow(this.now());
        return;
      }
      await sleep(this.options.mockGpu ? 250 : 5000);
    }
    throw new Error('数字人服务无响应，GPU 实例重启超时');
  }

  requestPowerForQueuedJob(jobId: string): void {
    this.db.setRuntime('last_request_at', new Date(this.now()).toISOString());
    void this.ensureRunning(`任务 ${jobId.slice(0, 8)} 入队`).catch((error) => this.setError(error));
  }

  ensureRunning(reason: string): Promise<InstanceSnapshot> {
    return this.withLock(async () => {
      let instance = await this.describeInstance();
      if (instance.state === 'Stopped') {
        this.setAction(`${reason}，正在启动实例`);
        await this.controller.start();
        this.ensureWindow(this.now());
      } else if (instance.state === 'Running') {
        const anchor = instance.startTime ? instance.startTime * 1000 : this.now();
        this.ensureWindow(anchor);
        const isEstablishedInstance = !instance.startTime || this.now() - anchor >= 10 * 60 * 1000;
        if (isEstablishedInstance) {
          if (await this.probeHealthy(3)) {
            this.setAction('GPU 实例已就绪');
            return instance;
          }
          await this.restartUnhealthyInstance(reason);
        }
      } else if (instance.state === 'Stopping') {
        this.setAction('实例正在关机，等待完成后重新启动');
      } else if (instance.state === 'Unknown') {
        throw new Error('无法确认 GPU 实例状态，已暂停任务执行');
      }

      const deadline = this.now() + this.options.startTimeoutMs;
      while (this.now() < deadline) {
        instance = await this.describeInstance();
        if (instance.state === 'Running') {
          this.ensureWindow(instance.startTime ? instance.startTime * 1000 : this.now());
          await this.waitUntilHealthy();
          this.setAction('GPU 实例已就绪');
          return instance;
        }
        if (instance.state === 'Stopped') {
          await this.controller.start();
          this.ensureWindow(this.now());
        }
        await sleep(this.options.mockGpu ? 250 : 5000);
      }
      throw new Error('GPU 实例启动超时');
    });
  }

  private async waitUntilHealthy(): Promise<void> {
    if (this.options.mockGpu || !this.options.healthUrl) return;
    const deadline = this.now() + this.options.startTimeoutMs;
    while (this.now() < deadline) {
      if (await this.probeHealthy()) return;
      await sleep(5000);
    }
    throw new Error('GPU 已开机，但数字人服务健康检查超时');
  }

  checkBillingBoundary(): Promise<void> {
    return this.withLock(async () => {
      const nextAt = Number(this.db.getRuntime('next_power_check_at') ?? 0);
      if (!nextAt || this.now() < nextAt) return;

      const activeJobs = this.db.countActiveJobs();
      const externalLease = this.getActiveExternalLease();
      const instance = await this.describeInstance();
      if (activeJobs > 0 || externalLease) {
        let next = nextAt;
        while (next <= this.now()) next += this.options.windowMs;
        this.db.setRuntime('next_power_check_at', String(next));
        this.setAction(
          activeJobs > 0
            ? `时间片到期，但仍有 ${activeJobs} 个任务，实例继续运行一小时`
            : `时间片到期，但“${externalLease?.reason}”仍在算力保留期，实例继续运行一小时`,
        );
        return;
      }

      if (instance.state === 'Running') {
        this.setAction('时间片到期且队列为空，正在关闭实例');
        await this.controller.stop();
      } else if (instance.state === 'Starting') {
        this.db.setRuntime('next_power_check_at', String(this.now() + this.options.tickMs));
        this.setAction('队列为空，等待实例启动完成后关闭');
        return;
      }
      this.db.setRuntime('billing_window_started_at', null);
      this.db.setRuntime('next_power_check_at', null);
    }).catch((error) => this.setError(error));
  }

  async systemSnapshot(): Promise<SystemSnapshot> {
    let instance: InstanceSnapshot;
    try {
      instance = await this.describeInstance();
      this.clearRecoveredStatusError();
    } catch (error) {
      this.setError(error);
      instance = {
        id: '',
        name: '状态不可用',
        state: 'Unknown',
        gpuType: '',
        gpuCount: 0,
        hourlyPrice: null,
        startTime: null,
      };
    }
    const next = Number(this.db.getRuntime('next_power_check_at') ?? 0);
    return {
      instance,
      mockGpu: this.options.mockGpu,
      mockCodex: this.options.mockCodex,
      queue: this.db.queueSummary(),
      billingWindowStartedAt: this.db.getRuntime('billing_window_started_at'),
      nextPowerCheckAt: next ? new Date(next).toISOString() : null,
      externalPowerLeaseUntil: this.getActiveExternalLease()
        ? new Date(Number(this.db.getRuntime('external_power_lease_until'))).toISOString()
        : null,
      externalPowerLeaseReason: this.db.getRuntime('external_power_lease_reason'),
      lastPowerAction: this.db.getRuntime('last_power_action'),
      lastPowerError: this.db.getRuntime('last_power_error'),
      codexModel: this.options.codexModel,
    };
  }

  manualStart(options?: {leaseMs?: number; reason?: string}): Promise<InstanceSnapshot> {
    if (options?.leaseMs) this.acquireExternalLease(options.leaseMs, options.reason || '管理员手动任务');
    return this.ensureRunning('管理员手动启动');
  }

  manualStop(): Promise<void> {
    return this.withLock(async () => {
      if (this.db.countActiveJobs() > 0) throw new Error('仍有排队或运行任务，不能手动关机');
      this.db.setRuntime('external_power_lease_until', null);
      this.db.setRuntime('external_power_lease_reason', null);
      const instance = await this.describeInstance();
      if (instance.state === 'Running') await this.controller.stop();
      this.db.setRuntime('billing_window_started_at', null);
      this.db.setRuntime('next_power_check_at', null);
      this.setAction('管理员手动关闭实例');
    });
  }
}
