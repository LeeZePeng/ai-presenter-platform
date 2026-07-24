import {createHash} from 'node:crypto';
import {copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import type {AppDatabase} from './db.js';
import type {JobAssets, JobCreateInput, JobRecord} from './types.js';

export class RetryJobError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

const copyAssets = (source: JobRecord, destinationDir: string): JobAssets => {
  const assets: JobAssets = {};
  mkdirSync(destinationDir, {recursive: true});
  for (const [field, sourcePath] of Object.entries(source.assets) as Array<[keyof JobAssets, string | undefined]>) {
    if (!sourcePath) continue;
    if (!existsSync(sourcePath)) throw new RetryJobError(`原任务的 ${field} 素材已不存在，无法重试`, 409);
    const extension = path.extname(sourcePath).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 8) || '.bin';
    const destination = path.join(destinationDir, `${field}${extension}`);
    copyFileSync(sourcePath, destination);
    assets[field] = destination;
  }
  return assets;
};

const rewriteJsonFilePaths = (
  filename: string,
  sourceWorkspace: string,
  retryWorkspace: string,
): void => {
  if (!existsSync(filename)) return;
  const rewrite = (value: unknown): unknown => {
    if (typeof value === 'string') {
      const relative = path.relative(sourceWorkspace, value);
      if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
        return path.join(retryWorkspace, relative);
      }
      return value;
    }
    if (Array.isArray(value)) return value.map(rewrite);
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, rewrite(entry)]));
    }
    return value;
  };
  try {
    const manifest = JSON.parse(readFileSync(filename, 'utf8')) as unknown;
    const rewritten = rewrite(manifest);
    if (JSON.stringify(rewritten) !== JSON.stringify(manifest)) {
      writeFileSync(filename, `${JSON.stringify(rewritten, null, 2)}\n`);
    }
  } catch {
    // A partially written receipt is not reusable, but must not block the other durable checkpoints.
  }
};

const rewriteCopiedJsonPaths = (
  directory: string,
  sourceWorkspace: string,
  retryWorkspace: string,
): void => {
  if (!existsSync(directory)) return;
  for (const entry of readdirSync(directory, {withFileTypes: true})) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) rewriteCopiedJsonPaths(filename, sourceWorkspace, retryWorkspace);
    else if (entry.isFile() && entry.name.endsWith('.json')) {
      rewriteJsonFilePaths(filename, sourceWorkspace, retryWorkspace);
    }
  }
};

const hasReusablePresenterRender = (manifestPath: string): boolean => {
  if (!existsSync(manifestPath)) return false;
  try {
    const value = JSON.parse(readFileSync(manifestPath, 'utf8')) as {presenterRenderPaths?: unknown};
    return (
      Array.isArray(value.presenterRenderPaths) &&
      value.presenterRenderPaths.length > 0 &&
      value.presenterRenderPaths.every(
        (candidate) => {
          if (typeof candidate !== 'string' || !existsSync(candidate)) return false;
          const stats = statSync(candidate);
          return stats.isFile() && stats.size > 0;
        },
      )
    );
  } catch {
    return false;
  }
};

export const createRetryJob = (
  db: AppDatabase,
  jobsDir: string,
  sourceId: string,
  retryId: string,
): {
  job: JobRecord;
  reusedCheckpoints: boolean;
  reusedCompletedArtifacts: boolean;
  reusedSourceTranscript: boolean;
  reusedPresenterRender: boolean;
} => {
  const source = db.getJob(sourceId);
  if (!source) throw new RetryJobError('任务不存在', 404);
  if (!['failed', 'cancelled'].includes(source.status)) {
    throw new RetryJobError('只有失败或已取消的任务可以重试', 409);
  }

  const retryRootId = typeof source.metadata.retryRootId === 'string' ? source.metadata.retryRootId : source.id;
  const activeRetry = db.findActiveRetry(retryRootId);
  if (activeRetry) throw new RetryJobError(`已有重试任务正在执行：${activeRetry.id}`, 409);

  const sourceWorkspace = path.join(jobsDir, source.id);
  const retryWorkspace = path.join(jobsDir, retryId);
  const sourceOut = path.join(sourceWorkspace, 'out');
  const retryOut = path.join(retryWorkspace, 'out');
  const sourceCheckpoints = path.join(sourceWorkspace, 'out', 'checkpoints');
  const retryCheckpoints = path.join(retryWorkspace, 'out', 'checkpoints');
  const sourceAudio = path.join(sourceWorkspace, 'out', 'audio');
  const retryAudio = path.join(retryWorkspace, 'out', 'audio');
  const sourceAnalysis = path.join(sourceWorkspace, 'out', 'analysis');
  const retryAnalysis = path.join(retryWorkspace, 'out', 'analysis');
  const sourceRemotion = path.join(sourceWorkspace, 'remotion');
  const retryRemotion = path.join(retryWorkspace, 'remotion');
  const reusedCheckpoints = existsSync(sourceCheckpoints);
  const reusedCompletedArtifacts =
    existsSync(path.join(sourceOut, 'final.mp4')) && existsSync(path.join(sourceOut, 'result.json'));

  try {
    const assets = copyAssets(source, path.join(retryWorkspace, 'assets'));
    if (reusedCompletedArtifacts) {
      cpSync(sourceOut, retryOut, {recursive: true});
      if (existsSync(sourceRemotion)) cpSync(sourceRemotion, retryRemotion, {recursive: true});
    } else if (reusedCheckpoints) {
      mkdirSync(path.dirname(retryCheckpoints), {recursive: true});
      cpSync(sourceCheckpoints, retryCheckpoints, {recursive: true});
      if (existsSync(sourceAudio)) cpSync(sourceAudio, retryAudio, {recursive: true});
      mkdirSync(retryAnalysis, {recursive: true});
      for (const filename of [
        'source_transcript.json',
        'presenter_base_manifest.json',
        'presenter_render_manifest.json',
      ]) {
        const sourceFile = path.join(sourceAnalysis, filename);
        if (existsSync(sourceFile)) copyFileSync(sourceFile, path.join(retryAnalysis, filename));
      }
      const sourcePresenter = path.join(sourceRemotion, 'public', 'presenter');
      if (existsSync(sourcePresenter)) {
        cpSync(sourcePresenter, path.join(retryRemotion, 'public', 'presenter'), {recursive: true});
      }
    }
    rewriteCopiedJsonPaths(retryWorkspace, sourceWorkspace, retryWorkspace);
    const retryTranscript = path.join(retryAnalysis, 'source_transcript.json');
    const reusedSourceTranscript = existsSync(retryTranscript);
    const reusedPresenterRender = hasReusablePresenterRender(
      path.join(retryAnalysis, 'presenter_render_manifest.json'),
    );
    const sourceTranscriptSha256 = reusedSourceTranscript
      ? createHash('sha256').update(readFileSync(retryTranscript)).digest('hex')
      : source.metadata.sourceTranscriptSha256;
    const input: JobCreateInput = {
      title: source.title,
      mode: source.mode,
      replicaMode: source.replicaMode,
      topic: source.topic,
      script: source.script,
      durationSeconds: source.durationSeconds,
      aspectRatio: source.aspectRatio,
      style: source.style,
      voiceMode: source.voiceMode,
      rightsConfirmed: source.rightsConfirmed,
      assets,
    };
    const retryCount = Number(source.metadata.retryCount ?? 0) + 1;
    const job = db.createJob(retryId, input, {
      avatarDimensions: source.metadata.avatarDimensions,
      retryOf: source.id,
      retryRootId,
      retryCount,
      reusedCheckpoints,
      reusedCompletedArtifacts,
      reusedSourceTranscript,
      reusedPresenterRender,
      sourceTranscriptPath: reusedSourceTranscript ? retryTranscript : undefined,
      sourceTranscriptSha256,
    });
    db.addEvent(retryId, 'info', 'retry_created', `由任务 ${source.id.slice(0, 12)} 创建重试`, {
      retryOf: source.id,
      retryCount,
      reusedCheckpoints,
      reusedCompletedArtifacts,
      reusedSourceTranscript,
      reusedPresenterRender,
    });
    db.addEvent(source.id, 'info', 'retried', `已创建重试任务 ${retryId.slice(0, 12)}`, {retryJobId: retryId});
    return {job, reusedCheckpoints, reusedCompletedArtifacts, reusedSourceTranscript, reusedPresenterRender};
  } catch (error) {
    rmSync(retryWorkspace, {recursive: true, force: true});
    throw error;
  }
};

export const createFullRegenerationJob = (
  db: AppDatabase,
  jobsDir: string,
  sourceId: string,
  retryId: string,
): {job: JobRecord; reusedCheckpoints: false; reusedCompletedArtifacts: false} => {
  const source = db.getJob(sourceId);
  if (!source) throw new RetryJobError('任务不存在', 404);
  if (!['succeeded', 'failed', 'cancelled'].includes(source.status)) {
    throw new RetryJobError('任务仍在执行，不能完整重做', 409);
  }
  const retryRootId = typeof source.metadata.retryRootId === 'string' ? source.metadata.retryRootId : source.id;
  const activeRetry = db.findActiveRetry(retryRootId);
  if (activeRetry) throw new RetryJobError(`已有重试任务正在执行：${activeRetry.id}`, 409);
  const retryWorkspace = path.join(jobsDir, retryId);
  try {
    const assets = copyAssets(source, path.join(retryWorkspace, 'assets'));
    const input: JobCreateInput = {
      title: `${source.title}（完整返修）`,
      mode: source.mode,
      replicaMode: source.replicaMode,
      topic: source.topic,
      script: source.script,
      durationSeconds: source.durationSeconds,
      aspectRatio: source.aspectRatio,
      style: source.style,
      voiceMode: source.voiceMode,
      rightsConfirmed: source.rightsConfirmed,
      assets,
    };
    const retryCount = Number(source.metadata.retryCount ?? 0) + 1;
    const job = db.createJob(retryId, input, {
      avatarDimensions: source.metadata.avatarDimensions,
      retryOf: source.id,
      retryRootId,
      retryCount,
      reusedCheckpoints: false,
      reusedCompletedArtifacts: false,
      fullRegeneration: true,
    });
    db.addEvent(retryId, 'info', 'full_regeneration_created', `由任务 ${source.id.slice(0, 12)} 创建完整返修`, {
      retryOf: source.id,
      retryCount,
      reusedAudio: false,
      reusedPresenter: false,
    });
    db.addEvent(source.id, 'info', 'full_regeneration_retried', `已创建完整返修任务 ${retryId.slice(0, 12)}`, {
      retryJobId: retryId,
    });
    return {job, reusedCheckpoints: false, reusedCompletedArtifacts: false};
  } catch (error) {
    rmSync(retryWorkspace, {recursive: true, force: true});
    throw error;
  }
};

export const createVisualRepairJob = (
  db: AppDatabase,
  jobsDir: string,
  sourceId: string,
  retryId: string,
): {job: JobRecord; reusedCheckpoints: boolean; reusedCompletedArtifacts: boolean; visualRepairOnly: true} => {
  const source = db.getJob(sourceId);
  if (!source) throw new RetryJobError('任务不存在', 404);
  if (!['succeeded', 'failed', 'cancelled'].includes(source.status)) {
    throw new RetryJobError('任务仍在执行，不能创建视觉返修', 409);
  }

  const retryRootId = typeof source.metadata.retryRootId === 'string' ? source.metadata.retryRootId : source.id;
  const activeRetry = db.findActiveRetry(retryRootId);
  if (activeRetry) throw new RetryJobError(`已有重试任务正在执行：${activeRetry.id}`, 409);

  const sourceWorkspace = path.join(jobsDir, source.id);
  const retryWorkspace = path.join(jobsDir, retryId);
  const sourceOut = path.join(sourceWorkspace, 'out');
  const retryOut = path.join(retryWorkspace, 'out');
  const sourceRemotion = path.join(sourceWorkspace, 'remotion');
  const retryRemotion = path.join(retryWorkspace, 'remotion');
  const sourceTranscript = path.join(sourceOut, 'analysis', 'source_transcript.json');
  const retryTranscript = path.join(retryOut, 'analysis', 'source_transcript.json');

  if (!existsSync(path.join(sourceOut, 'final.mp4')) || !existsSync(path.join(sourceOut, 'result.json'))) {
    throw new RetryJobError('原任务缺少完整成片，不能执行仅视觉返修', 409);
  }
  if (!existsSync(path.join(sourceOut, 'audio', 'final_narration.wav'))) {
    throw new RetryJobError('原任务缺少已锁定旁白，不能复用音频', 409);
  }
  if (!existsSync(path.join(sourceOut, 'checkpoints', 'infinite_talk'))) {
    throw new RetryJobError('原任务缺少数字人检查点，不能复用数字人', 409);
  }

  try {
    const assets = copyAssets(source, path.join(retryWorkspace, 'assets'));
    cpSync(sourceOut, retryOut, {recursive: true});
    if (existsSync(sourceRemotion)) cpSync(sourceRemotion, retryRemotion, {recursive: true});
    rewriteCopiedJsonPaths(retryWorkspace, sourceWorkspace, retryWorkspace);
    const input: JobCreateInput = {
      title: `${source.title}（视觉返修）`,
      mode: source.mode,
      replicaMode: source.replicaMode,
      topic: source.topic,
      script: source.script,
      durationSeconds: source.durationSeconds,
      aspectRatio: source.aspectRatio,
      style: source.style,
      voiceMode: source.voiceMode,
      rightsConfirmed: source.rightsConfirmed,
      assets,
    };
    const retryCount = Number(source.metadata.retryCount ?? 0) + 1;
    const reusedSourceTranscript = existsSync(sourceTranscript) && existsSync(retryTranscript);
    const sourceTranscriptSha256 = reusedSourceTranscript
      ? createHash('sha256').update(readFileSync(retryTranscript)).digest('hex')
      : source.metadata.sourceTranscriptSha256;
    const job = db.createJob(retryId, input, {
      avatarDimensions: source.metadata.avatarDimensions,
      retryOf: source.id,
      retryRootId,
      retryCount,
      reusedCheckpoints: true,
      reusedCompletedArtifacts: true,
      visualRepairOnly: true,
      sourceTranscriptPath: reusedSourceTranscript ? retryTranscript : undefined,
      sourceTranscriptSha256,
    });
    db.addEvent(retryId, 'info', 'visual_repair_created', `由任务 ${source.id.slice(0, 12)} 创建仅视觉返修`, {
      retryOf: source.id,
      retryCount,
      reusedAudio: true,
      reusedPresenter: true,
      reusedSourceTranscript,
    });
    db.addEvent(source.id, 'info', 'visual_repair_retried', `已创建视觉返修任务 ${retryId.slice(0, 12)}`, {
      retryJobId: retryId,
    });
    return {job, reusedCheckpoints: true, reusedCompletedArtifacts: true, visualRepairOnly: true};
  } catch (error) {
    rmSync(retryWorkspace, {recursive: true, force: true});
    throw error;
  }
};
