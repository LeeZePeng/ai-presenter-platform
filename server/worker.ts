import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
} from 'node:fs';
import {spawn, type ChildProcess} from 'node:child_process';
import path from 'node:path';
import type {AppDatabase} from './db.js';
import type {PowerCoordinator} from './power-coordinator.js';
import type {CodexRunner} from './codex-runner.js';
import type {SourceTranscriber} from './asr.js';
import {buildCodexPrompt} from './prompt.js';
import {prepareVoiceReference} from './voice-reference.js';
import {probeQwenTtsHealth} from './qwen-tts-health.js';
import type {JobRecord} from './types.js';

type WorkerOptions = {
  jobsDir: string;
  skillPath: string;
  presenterApiUrl: string;
  presenterComfyUrl: string;
  presenterWorkers: Array<{server: string; comfyServer: string}>;
  qwenTtsBaseUrl: string;
  qwenTtsApiToken: string;
  qwenTtsModel: string;
  remotionRuntimeDir: string;
  remotionSkillPath: string;
  remotionBrowserExecutable: string;
  remotionConcurrency: number;
  remotionCrf: number;
  pythonBin: string;
  ffmpegBin: string;
  ffprobeBin: string;
  cjkFontPaths: {
    regular: string;
    bold: string;
    black: string;
  };
  asrBin: string;
  asrModel: string;
  asrLanguage: string;
  asrThreads: number;
  asrUseGpu: boolean;
  pollMs?: number;
};

export const isRetryableGpuCapacityError = (message: string): boolean =>
  /(?:226604|226619|out of resources|insufficient capacity|resource capacity|try again later|too many requests|资源不足|暂无可用资源|调用过于频繁|接口调用过于频繁|请稍后重试)/i.test(
    message,
  );

export const calculateGpuRetryDelayMs = (attempt: number): number =>
  Math.min(5 * 60 * 1000, 30 * 1000 * 2 ** Math.max(0, Math.min(4, attempt - 1)));

export const isRecoverableWorkerTimeout = (message: string): boolean =>
  /^Codex worker 超过 \d+ 分钟超时$/.test(message.trim());

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
  private readonly fastRenderProcesses = new Map<string, ChildProcess>();

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
    this.fastRenderProcesses.get(jobId)?.kill('SIGTERM');
    return job;
  }

  private readJson(filename: string): Record<string, unknown> | null {
    try {
      return JSON.parse(readFileSync(filename, 'utf8')) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  private updateFastRenderProgress(jobId: string, workspace: string): void {
    const fast = this.readJson(path.join(workspace, 'out', 'analysis', 'fast_render_progress.json'));
    const remotion = this.readJson(path.join(workspace, 'out', 'analysis', 'remotion_progress.json'));
    const state = String(fast?.state ?? 'starting');
    if (state === 'optimizing') {
      const percent = Math.max(0, Math.min(100, Number(fast?.percent) || 0));
      this.db.updateJob(jobId, {stage: `优化 AV1 证据源 ${Math.floor(percent)}%`, progress: 80});
      return;
    }
    if (state === 'rendering' || remotion?.state === 'rendering' || remotion?.state === 'encoding') {
      const percent = Math.max(0, Math.min(100, Number(remotion?.percent) || 0));
      const concurrency = Math.max(1, Number(remotion?.concurrency) || this.options.remotionConcurrency);
      const etaSeconds = Math.max(0, Number(remotion?.etaSeconds) || 0);
      this.db.updateJob(jobId, {
        stage: `快速渲染 ${Math.floor(percent)}% · ${concurrency} 并发${etaSeconds ? ` · 约 ${Math.ceil(etaSeconds / 60)} 分钟` : ''}`,
        progress: 82 + Math.floor(percent * 0.15),
      });
      return;
    }
    if (state === 'muxing') {
      this.db.updateJob(jobId, {stage: '封装锁定旁白', progress: 98});
      return;
    }
    if (state === 'cover') {
      this.db.updateJob(jobId, {stage: '生成封面', progress: 99});
      return;
    }
    if (state === 'validating') {
      this.db.updateJob(jobId, {stage: '检查快速成片', progress: 99});
    }
  }

  private async runFastRender(job: JobRecord, workspace: string): Promise<string> {
    const script = path.join(this.options.skillPath, 'scripts', 'fast_render_existing.py');
    const renderScript = path.join(this.options.skillPath, 'scripts', 'render_remotion.py');
    if (!existsSync(script)) throw new Error(`快速渲染程序不存在: ${script}`);
    const progressPath = path.join(workspace, 'out', 'analysis', 'fast_render_progress.json');
    rmSync(progressPath, {force: true});
    const args = [
      script,
      '--workspace',
      workspace,
      '--runtime-dir',
      this.options.remotionRuntimeDir,
      '--browser-executable',
      this.options.remotionBrowserExecutable,
      '--render-script',
      renderScript,
      '--python-bin',
      this.options.pythonBin,
      '--ffmpeg-bin',
      this.options.ffmpegBin,
      '--ffprobe-bin',
      this.options.ffprobeBin,
      '--progress',
      progressPath,
      '--concurrency',
      String(this.options.remotionConcurrency),
      '--crf',
      String(this.options.remotionCrf),
      '--title',
      job.title,
    ];
    this.db.addEvent(job.id, 'info', 'fast_render_started', '复用已锁定工程，跳过 Agent、ASR、GPU、口型和逐帧预检，开始快速续跑', {
      concurrency: this.options.remotionConcurrency,
    });
    let outputTail = '';
    const child = spawn(this.options.pythonBin, args, {
      cwd: workspace,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.fastRenderProcesses.set(job.id, child);
    const collect = (chunk: unknown): void => {
      outputTail = (outputTail + String(chunk)).slice(-12000);
    };
    child.stdout?.on('data', collect);
    child.stderr?.on('data', collect);
    const timer = setInterval(() => this.updateFastRenderProgress(job.id, workspace), 1500);
    timer.unref();
    try {
      await new Promise<void>((resolve, reject) => {
        child.on('error', reject);
        child.on('exit', (code, signal) => {
          if (code === 0) resolve();
          else reject(new Error(`快速渲染退出 (${signal ?? code}): ${outputTail.slice(-2500)}`));
        });
      });
    } finally {
      clearInterval(timer);
      this.fastRenderProcesses.delete(job.id);
      this.updateFastRenderProgress(job.id, workspace);
    }
    const output = path.join(workspace, 'out', 'final.mp4');
    if (!existsSync(output) || statSync(output).size <= 1024) throw new Error('快速渲染没有生成有效成片');
    return output;
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
    const fastRenderOnly = job.metadata.fastRenderOnly === true;
    const resumeExistingWorkspace =
      job.metadata.resumeExistingWorkspace === true &&
      existsSync(path.join(workspace, 'out', 'codex-thread-id.txt'));
    const resumeProgress = resumeExistingWorkspace
      ? Math.max(20, Number(job.metadata.resumeProgress) || job.progress)
      : 0;
    const visualRepairOnly =
      job.metadata.visualRepairOnly === true &&
      existsSync(path.join(workspace, 'out', 'final.mp4')) &&
      existsSync(path.join(workspace, 'out', 'result.json'));
    const reusePresenterRender =
      job.metadata.reusedPresenterRender === true &&
      existsSync(path.join(workspace, 'out', 'analysis', 'presenter_render_manifest.json')) &&
      existsSync(path.join(workspace, 'remotion', 'public', 'presenter', 'render'));
    mkdirSync(path.join(workspace, 'out'), {recursive: true});
    ensureRemotionRuntimeLink(workspace, this.options.remotionRuntimeDir);
    const remotionFontDir = stageRemotionFonts(workspace, this.options.cjkFontPaths);
    try {
      if (fastRenderOnly) {
        this.db.updateJob(job.id, {status: 'running', stage: '准备快速续跑', progress: 79});
        const output = await this.runFastRender(job, workspace);
        if (this.db.isCancelRequested(job.id)) throw new Error('任务已取消');
        this.db.updateJob(job.id, {
          status: 'succeeded',
          stage: '已完成',
          progress: 100,
          outputPath: output,
          finishedAt: new Date().toISOString(),
          metadata: {...job.metadata, workspace},
        });
        this.db.addEvent(job.id, 'info', 'fast_render_completed', '快速成片已生成：只执行一次固定工程渲染和旁白封装', {output});
        return;
      }
      let voiceReferenceCleanPath: string | undefined;
      let voiceReferenceTranscriptPath: string | undefined;
      if (job.voiceMode === 'uploaded_reference' && !visualRepairOnly && !reusePresenterRender) {
        const qwenTts = await probeQwenTtsHealth({
          baseUrl: this.options.qwenTtsBaseUrl,
          apiToken: this.options.qwenTtsApiToken,
          model: this.options.qwenTtsModel,
        });
        if (qwenTts.status !== 'ready') throw new Error(`参考音色服务未就绪：${qwenTts.message}`);
        this.db.addEvent(job.id, 'info', 'qwen_tts_ready', `${qwenTts.model} 云端参考音色已配置，GPU 仅用于数字人口型`);
        if (!job.assets.voiceReference) throw new Error('参考音色任务缺少声音文件');
        const reusableVoiceReference =
          typeof job.metadata.voiceReferenceCleanPath === 'string' &&
          existsSync(job.metadata.voiceReferenceCleanPath) &&
          typeof job.metadata.voiceReferenceTranscriptPath === 'string' &&
          existsSync(job.metadata.voiceReferenceTranscriptPath);
        if (reusableVoiceReference) {
          voiceReferenceCleanPath = job.metadata.voiceReferenceCleanPath as string;
          voiceReferenceTranscriptPath = job.metadata.voiceReferenceTranscriptPath as string;
          this.db.updateJob(job.id, {status: 'provisioning', stage: '复用参考音色', progress: 9});
          this.db.addEvent(job.id, 'info', 'voice_reference_reused', '已复用清理和转写完成的参考音色', {
            voiceReferenceCleanPath,
            voiceReferenceTranscriptPath,
          });
        } else {
          this.db.updateJob(job.id, {status: 'provisioning', stage: '清理参考音色', progress: 6});
          this.db.addEvent(job.id, 'info', 'voice_reference_prepare', '正在清理参考音色的底噪、低频轰鸣和首尾空白');
          const prepared = await prepareVoiceReference(job.assets.voiceReference, workspace, {
            ffmpegBin: this.options.ffmpegBin,
            ffprobeBin: this.options.ffprobeBin,
            isCancelled: () => this.db.isCancelRequested(job.id),
          });
          voiceReferenceCleanPath = prepared.audioPath;
          this.db.updateJob(job.id, {stage: '转写参考音色', progress: 8});
          const transcript = await this.transcriber.transcribe(
            prepared.audioPath,
            workspace,
            {
              isCancelled: () => this.db.isCancelRequested(job.id),
              onEvent: (kind, message, data) => this.db.addEvent(job.id, 'info', `voice_${kind}`, message, data),
              onProgress: (percent) =>
                this.db.updateJob(job.id, {
                  stage: `转写参考音色 ${percent}%`,
                  progress: 8 + Math.floor(percent / 50),
                }),
            },
            {artifactName: 'voice_reference', mediaLabel: '参考音色', minimumTextCharacters: 2},
          );
          voiceReferenceTranscriptPath = transcript.path;
          const currentMetadata = this.db.getJob(job.id)?.metadata ?? job.metadata;
          this.db.updateJob(job.id, {
            metadata: {
              ...currentMetadata,
              voiceReferenceCleanPath: prepared.audioPath,
              voiceReferenceManifestPath: prepared.manifestPath,
              voiceReferenceSha256: prepared.sourceSha256,
              voiceReferenceAudioSha256: prepared.audioSha256,
              voiceReferenceTranscriptPath: transcript.path,
              voiceReferenceTranscriptSha256: transcript.sha256,
            },
          });
          this.db.addEvent(job.id, 'info', 'voice_reference_ready', '参考音色已清理并取得逐字转写，可用于千问云端高保真克隆', {
            durationSeconds: prepared.durationSeconds,
            voiceReferenceCleanPath: prepared.audioPath,
            voiceReferenceTranscriptPath: transcript.path,
          });
        }
      }
      let sourceTranscriptPath: string | undefined;
      if (job.mode === 'clone') {
        if (!job.assets.sourceVideo) throw new Error('复刻任务缺少参考视频');
        const reusableTranscript =
          (visualRepairOnly || resumeExistingWorkspace || job.metadata.reusedSourceTranscript === true) &&
          typeof job.metadata.sourceTranscriptPath === 'string' &&
          existsSync(job.metadata.sourceTranscriptPath)
            ? job.metadata.sourceTranscriptPath
            : undefined;
        if (reusableTranscript) {
          sourceTranscriptPath = reusableTranscript;
          this.db.updateJob(job.id, {
            status: 'provisioning',
            stage: resumeExistingWorkspace ? '恢复超时断点' : '复用原片转写',
            progress: resumeExistingWorkspace ? resumeProgress : 15,
          });
          this.db.addEvent(job.id, 'info', 'asr_reused', resumeExistingWorkspace
            ? '超时续跑复用原片转写和当前工作目录，不重复执行 ASR'
            : visualRepairOnly
              ? '视觉返修复用原片转写，不重复执行 ASR'
              : '重试任务复用已完成的原片转写，不重复执行 ASR', {
            sourceTranscriptPath,
          });
        } else {
          this.db.updateJob(job.id, {status: 'provisioning', stage: '转写原片', progress: 10});
          this.db.addEvent(job.id, 'info', 'asr_start', '开始转写参考视频，优先使用云端 ASR，暂不启动数字人 GPU');
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
              ...(this.db.getJob(job.id)?.metadata ?? job.metadata),
              sourceTranscriptPath: transcript.path,
              sourceTranscriptSha256: transcript.sha256,
            },
          });
        }
        if (this.db.isCancelRequested(job.id)) throw new Error('任务已取消');
        this.db.updateJob(job.id, {
          stage: visualRepairOnly
            ? '准备修复旧成片'
            : resumeExistingWorkspace
              ? '恢复超时断点'
              : reusePresenterRender
                ? '复用数字人高清素材'
                : '唤醒算力',
          progress: resumeExistingWorkspace ? resumeProgress : 16,
        });
      }
      if (visualRepairOnly || reusePresenterRender) {
        this.db.addEvent(
          job.id,
          'info',
          visualRepairOnly ? 'visual_repair_reuse' : 'presenter_render_reused',
          visualRepairOnly
            ? '旧任务仅修复视觉，复用旁白和数字人结果，不启动 GPU'
            : '重试任务复用完整数字人高清素材，不启动 GPU',
        );
      } else {
        this.db.addEvent(job.id, 'info', 'power', '正在确认 GPU 实例状态');
        await this.power.ensureRunning(`任务 ${job.id.slice(0, 8)} 开始执行`);
      }
      if (this.db.isCancelRequested(job.id)) throw new Error('任务已取消');

      this.db.updateJob(job.id, {
        status: 'running',
        stage: visualRepairOnly ? '修复旧成片视觉' : resumeExistingWorkspace ? '从断点继续生成' : '分析与生成',
        progress: resumeExistingWorkspace ? resumeProgress : 20,
      });
      this.db.addEvent(
        job.id,
        'info',
        'running',
        visualRepairOnly
          ? '正在续接同一 Goal 修复 Remotion、字体和人物裁切'
          : resumeExistingWorkspace
            ? 'GPU 已就绪，正在原任务目录和同一 Goal 中从断点继续'
            : reusePresenterRender
              ? '已复用 ASR、旁白、口型和高清人物素材，不启动 GPU，开始生成单轨并重新渲染'
            : 'GPU 已就绪，开始执行口播 skill',
      );
      const current = this.db.getJob(job.id)!;
      const prompt = buildCodexPrompt(current, workspace, {
        skillPath: this.options.skillPath,
        presenterApiUrl: this.options.presenterApiUrl,
        presenterComfyUrl: this.options.presenterComfyUrl,
        presenterWorkers: this.options.presenterWorkers,
        qwenTtsBaseUrl: this.options.qwenTtsBaseUrl,
        qwenTtsModel: this.options.qwenTtsModel,
        remotionRuntimeDir: this.options.remotionRuntimeDir,
        remotionSkillPath: this.options.remotionSkillPath,
        remotionBrowserExecutable: this.options.remotionBrowserExecutable,
        remotionConcurrency: this.options.remotionConcurrency,
        remotionCrf: this.options.remotionCrf,
        pythonBin: this.options.pythonBin,
        remotionFontDir,
        asrBin: this.options.asrBin,
        asrModel: this.options.asrModel,
        asrLanguage: this.options.asrLanguage,
        asrThreads: this.options.asrThreads,
        asrUseGpu: this.options.asrUseGpu,
        sourceTranscriptPath,
        voiceReferenceCleanPath,
        voiceReferenceTranscriptPath,
      });

      const output = await this.runner.run(current, workspace, prompt, {
        onEvent: (kind, message, data) => this.db.addEvent(job.id, 'info', kind, message, data),
        onProgress: (stage, progress) =>
          this.db.updateJob(job.id, {
            stage,
            progress: resumeExistingWorkspace ? Math.max(resumeProgress, progress) : progress,
          }),
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
      const resumableTimeout =
        !cancelled &&
        isRecoverableWorkerTimeout(message) &&
        existsSync(path.join(workspace, 'out', 'codex-thread-id.txt')) &&
        existsSync(path.join(workspace, 'out', 'checkpoints'));
      if (resumableTimeout) {
        const current = this.db.getJob(job.id) ?? job;
        const previousResumes = Number(current.metadata.workerTimeoutResumeCount ?? 0);
        const resumeCount = Number.isFinite(previousResumes)
          ? Math.max(0, Math.floor(previousResumes)) + 1
          : 1;
        if (resumeCount <= 2) {
          this.nextClaimAt = Date.now() + 2000;
          this.db.updateJob(job.id, {
            status: 'pending',
            stage: '总时限到达，准备从断点续跑',
            progress: current.progress,
            error: null,
            startedAt: null,
            finishedAt: null,
            metadata: {
              ...current.metadata,
              resumeExistingWorkspace: true,
              resumeProgress: current.progress,
              workerTimeoutResumeCount: resumeCount,
            },
          });
          this.db.addEvent(
            job.id,
            'warning',
            'worker_timeout_resume',
            `长视频达到单轮总时限，正在原目录从断点自动续跑（第 ${resumeCount} 次）`,
            {resumeCount},
          );
          return;
        }
      }
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
