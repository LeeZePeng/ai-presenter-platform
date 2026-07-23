import {createHash} from 'node:crypto';
import {copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
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

const rewriteCopiedManifestPaths = (
  outputDir: string,
  sourceWorkspace: string,
  retryWorkspace: string,
): void => {
  const manifestPath = path.join(outputDir, 'result.json');
  if (!existsSync(manifestPath)) return;
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
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as unknown;
  writeFileSync(manifestPath, `${JSON.stringify(rewrite(manifest), null, 2)}\n`);
};

export const createRetryJob = (
  db: AppDatabase,
  jobsDir: string,
  sourceId: string,
  retryId: string,
): {job: JobRecord; reusedCheckpoints: boolean; reusedCompletedArtifacts: boolean} => {
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
  const reusedCheckpoints = existsSync(sourceCheckpoints);
  const reusedCompletedArtifacts =
    existsSync(path.join(sourceOut, 'final.mp4')) && existsSync(path.join(sourceOut, 'result.json'));

  try {
    const assets = copyAssets(source, path.join(retryWorkspace, 'assets'));
    if (reusedCompletedArtifacts) {
      cpSync(sourceOut, retryOut, {recursive: true});
      rewriteCopiedManifestPaths(retryOut, sourceWorkspace, retryWorkspace);
    } else if (reusedCheckpoints) {
      mkdirSync(path.dirname(retryCheckpoints), {recursive: true});
      cpSync(sourceCheckpoints, retryCheckpoints, {recursive: true});
      if (existsSync(sourceAudio)) cpSync(sourceAudio, retryAudio, {recursive: true});
    }
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
    });
    db.addEvent(retryId, 'info', 'retry_created', `由任务 ${source.id.slice(0, 12)} 创建重试`, {
      retryOf: source.id,
      retryCount,
      reusedCheckpoints,
      reusedCompletedArtifacts,
    });
    db.addEvent(source.id, 'info', 'retried', `已创建重试任务 ${retryId.slice(0, 12)}`, {retryJobId: retryId});
    return {job, reusedCheckpoints, reusedCompletedArtifacts};
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
    rewriteCopiedManifestPaths(retryOut, sourceWorkspace, retryWorkspace);
    if (existsSync(sourceRemotion)) cpSync(sourceRemotion, retryRemotion, {recursive: true});
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
