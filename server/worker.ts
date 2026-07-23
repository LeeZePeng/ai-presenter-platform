import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import path from 'node:path';
import type {AppDatabase} from './db.js';
import type {PowerCoordinator} from './power-coordinator.js';
import type {CodexRunner} from './codex-runner.js';
import type {SourceTranscriber} from './asr.js';
import {buildCodexPrompt} from './prompt.js';
import type {JobRecord} from './types.js';

type WorkerOptions = {
  jobsDir: string;
  skillPath: string;
  presenterApiUrl: string;
  presenterComfyUrl: string;
  presenterWorkers: Array<{server: string; comfyServer: string}>;
  remotionRuntimeDir: string;
  remotionSkillPath: string;
  remotionBrowserExecutable: string;
  cjkFontPaths: {
    regular: string;
    bold: string;
    black: string;
  };
  asrBin: string;
  asrModel: string;
  asrLanguage: string;
  asrThreads: number;
  pollMs?: number;
};

export const isRetryableGpuCapacityError = (message: string): boolean =>
  /(?:226604|out of resources|insufficient capacity|resource capacity|try again later|资源不足|暂无可用资源)/i.test(
    message,
  );

export const calculateGpuRetryDelayMs = (attempt: number): number =>
  Math.min(5 * 60 * 1000, 30 * 1000 * 2 ** Math.max(0, Math.min(4, attempt - 1)));

export const ensureRemotionRuntimeLink = (workspace: string, runtimeDir: string): string => {
  const runtimeModules = path.join(runtimeDir, 'node_modules');
  if (!existsSync(runtimeModules)) throw new Error(`Remotion runtime 不完整: ${runtimeModules}`);
  const workspaceModules = path.join(workspace, 'node_modules');
  if (existsSync(workspaceModules)) {
    try {
      if (realpathSync(workspaceModules) === realpathSync(runtimeModules)) return workspaceModules;
    } catch {
      // Replace a stale or broken workspace-only runtime link.
    }
    rmSync(workspaceModules, {recursive: true, force: true});
  }
  symlinkSync(runtimeModules, workspaceModules, 'dir');
  return workspaceModules;
};

const fontAssets = [
  ['regular', 'NotoSansCJKSC-Regular.otf'],
  ['bold', 'NotoSansCJKSC-Bold.otf'],
  ['black', 'NotoSansCJKSC-Black.otf'],
] as const;

export const stageRemotionFonts = (
  workspace: string,
  fonts: WorkerOptions['cjkFontPaths'],
): string => {
  const destination = path.join(workspace, 'remotion', 'public', 'fonts');
  mkdirSync(destination, {recursive: true});
  for (const [weight, filename] of fontAssets) {
    const source = fonts[weight];
    if (!existsSync(source)) throw new Error(`Remotion 中文字体不存在: ${source}`);
    const target = path.join(destination, filename);
    if (existsSync(target) && statSync(target).size > 1024) continue;
    rmSync(target, {force: true});
    try {
      linkSync(source, target);
    } catch {
      copyFileSync(source, target);
    }
  }
  return destination;
};

export class JobWorker {
  private timer: NodeJS.Timeout | null = null;
  private busy = false;
  private nextClaimAt = 0;

  constructor(
    private readonly db: AppDatabase,
    private readonly power: PowerCoordinator,
    private readonly runner: CodexRunner,
    private readonly transcriber: SourceTranscriber,
    private readonly options: WorkerOptions,
  ) {}

  start(): void {
    if (this.timer) return;
    const poll = (): void => void this.tick();
    this.timer = setInterval(poll, this.options.pollMs ?? 1500);
    this.timer.unref();
    poll();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  cancel(jobId: string): JobRecord | null {
    const job = this.db.requestCancel(jobId);
    this.runner.cancel(jobId);
    return job;
  }

  private async tick(): Promise<void> {
    if (this.busy || Date.now() < this.nextClaimAt) return;
    const job = this.db.claimNextJob();
    if (!job) return;
    this.busy = true;
    try {
      await this.process(job);
    } finally {
      this.busy = false;
    }
  }

  private async process(job: JobRecord): Promise<void> {
    const workspace = path.join(this.options.jobsDir, job.id);
    const visualRepairOnly =
      job.metadata.visualRepairOnly === true &&
      existsSync(path.join(workspace, 'out', 'final.mp4')) &&
      existsSync(path.join(workspace, 'out', 'result.json'));
    mkdirSync(path.join(workspace, 'out'), {recursive: true});
    ensureRemotionRuntimeLink(workspace, this.options.remotionRuntimeDir);
    const remotionFontDir = stageRemotionFonts(workspace, this.options.cjkFontPaths);
    try {
      let sourceTranscriptPath: string | undefined;
      if (job.mode === 'clone') {
        if (!job.assets.sourceVideo) throw new Error('复刻任务缺少参考视频');
        const reusableTranscript =
          visualRepairOnly &&
          typeof job.metadata.sourceTranscriptPath === 'string' &&
          existsSync(job.metadata.sourceTranscriptPath)
            ? job.metadata.sourceTranscriptPath
            : undefined;
        if (reusableTranscript) {
          sourceTranscriptPath = reusableTranscript;
          this.db.updateJob(job.id, {status: 'provisioning', stage: '复用原片转写', progress: 15});
          this.db.addEvent(job.id, 'info', 'asr_reused', '视觉返修复用原片转写，不重复执行 ASR', {
            sourceTranscriptPath,
          });
        } else {
          this.db.updateJob(job.id, {status: 'provisioning', stage: '转写原片', progress: 10});
          this.db.addEvent(job.id, 'info', 'asr_start', '开始在 ECS CPU 上转写参考视频，暂不启动 GPU');
          const transcript = await this.transcriber.transcribe(job.assets.sourceVideo, workspace, {
            isCancelled: () => this.db.isCancelRequested(job.id),
            onEvent: (kind, message, data) => this.db.addEvent(job.id, 'info', kind, message, data),
            onProgress: (percent) =>
              this.db.updateJob(job.id, {
                stage: `转写原片 ${percent}%`,
                progress: 10 + Math.floor(percent / 20),
              }),
          });
          sourceTranscriptPath = transcript.path;
          this.db.updateJob(job.id, {
            metadata: {
              ...job.metadata,
              sourceTranscriptPath: transcript.path,
              sourceTranscriptSha256: transcript.sha256,
            },
          });
        }
        if (this.db.isCancelRequested(job.id)) throw new Error('任务已取消');
        this.db.updateJob(job.id, {
          stage: visualRepairOnly ? '准备修复旧成片' : '唤醒算力',
          progress: 16,
        });
      }
      if (visualRepairOnly) {
        this.db.addEvent(job.id, 'info', 'visual_repair_reuse', '旧任务仅修复视觉，复用旁白和数字人结果，不启动 GPU');
      } else {
        this.db.addEvent(job.id, 'info', 'power', '正在确认 GPU 实例状态');
        await this.power.ensureRunning(`任务 ${job.id.slice(0, 8)} 开始执行`);
      }
      if (this.db.isCancelRequested(job.id)) throw new Error('任务已取消');

      this.db.updateJob(job.id, {
        status: 'running',
        stage: visualRepairOnly ? '修复旧成片视觉' : '分析与生成',
        progress: 20,
      });
      this.db.addEvent(
        job.id,
        'info',
        'running',
        visualRepairOnly ? '正在续接同一 Goal 修复 Remotion、字体和人物裁切' : 'GPU 已就绪，开始执行口播 skill',
      );
      const current = this.db.getJob(job.id)!;
      const prompt = buildCodexPrompt(current, workspace, {
        skillPath: this.options.skillPath,
        presenterApiUrl: this.options.presenterApiUrl,
        presenterComfyUrl: this.options.presenterComfyUrl,
        presenterWorkers: this.options.presenterWorkers,
        remotionRuntimeDir: this.options.remotionRuntimeDir,
        remotionSkillPath: this.options.remotionSkillPath,
        remotionBrowserExecutable: this.options.remotionBrowserExecutable,
        remotionFontDir,
        asrBin: this.options.asrBin,
        asrModel: this.options.asrModel,
        asrLanguage: this.options.asrLanguage,
        asrThreads: this.options.asrThreads,
        sourceTranscriptPath,
      });

      const output = await this.runner.run(current, workspace, prompt, {
        onEvent: (kind, message, data) => this.db.addEvent(job.id, 'info', kind, message, data),
        onProgress: (stage, progress) => this.db.updateJob(job.id, {stage, progress}),
        isCancelled: () => this.db.isCancelRequested(job.id),
      });
      if (this.db.isCancelRequested(job.id)) throw new Error('任务已取消');

      this.db.updateJob(job.id, {
        status: 'succeeded',
        stage: '已完成',
        progress: 100,
        outputPath: output,
        finishedAt: new Date().toISOString(),
        metadata: {...current.metadata, workspace},
      });
      this.db.addEvent(job.id, 'info', 'completed', '成片已生成并通过 worker 检查', {output});
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const cancelled = this.db.isCancelRequested(job.id) || message === '任务已取消';
      const completeOutputPackage =
        existsSync(path.join(workspace, 'out', 'final.mp4')) &&
        existsSync(path.join(workspace, 'out', 'result.json'));
      if (!cancelled && completeOutputPackage) {
        const current = this.db.getJob(job.id) ?? job;
        const previousRepairs = Number(current.metadata.workerValidationRepairCount ?? 0);
        const repairCount = Number.isFinite(previousRepairs)
          ? Math.max(0, Math.floor(previousRepairs)) + 1
          : 1;
        this.nextClaimAt = Date.now() + 2000;
        this.db.updateJob(job.id, {
          status: 'pending',
          stage: '自动修复平台验收',
          progress: 88,
          error: null,
          startedAt: null,
          finishedAt: null,
          metadata: {
            ...current.metadata,
            workerValidationFeedback: message,
            workerValidationRepairCount: repairCount,
          },
        });
        this.db.addEvent(
          job.id,
          'warning',
          'worker_validation_repair',
          `平台独立验收未通过，正在恢复同一 Goal 修复：${message}`,
          {repairCount},
        );
        return;
      }
      if (!cancelled && isRetryableGpuCapacityError(message)) {
        const current = this.db.getJob(job.id) ?? job;
        const previousAttempts = Number(current.metadata.gpuCapacityRetryCount ?? 0);
        const attempt = Number.isFinite(previousAttempts) ? Math.max(0, Math.floor(previousAttempts)) + 1 : 1;
        const retryDelayMs = calculateGpuRetryDelayMs(attempt);
        const retryAt = Date.now() + retryDelayMs;
        this.nextClaimAt = retryAt;
        this.db.updateJob(job.id, {
          status: 'pending',
          stage: '等待 GPU 资源',
          progress: 8,
          error: null,
          startedAt: null,
          finishedAt: null,
          metadata: {
            ...current.metadata,
            gpuCapacityRetryCount: attempt,
            gpuCapacityRetryAt: new Date(retryAt).toISOString(),
          },
        });
        this.db.addEvent(
          job.id,
          'warning',
          'gpu_capacity_wait',
          `GPU 资源暂不可用，约 ${Math.ceil(retryDelayMs / 1000)} 秒后自动重试`,
          {attempt, retryAt: new Date(retryAt).toISOString()},
        );
        return;
      }
      this.db.updateJob(job.id, {
        status: cancelled ? 'cancelled' : 'failed',
        stage: cancelled ? '已取消' : '执行失败',
        error: cancelled ? null : message,
        finishedAt: new Date().toISOString(),
      });
      this.db.addEvent(job.id, cancelled ? 'warning' : 'error', cancelled ? 'cancelled' : 'failed', message);
    }
  }
}
