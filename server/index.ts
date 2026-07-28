import {createHash, randomUUID, timingSafeEqual} from 'node:crypto';
import {spawnSync} from 'node:child_process';
import {copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync} from 'node:fs';
import {createRequire} from 'node:module';
import path from 'node:path';
import express, {type NextFunction, type Request, type Response} from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import multer from 'multer';
import {ZodError} from 'zod';
import {config, assertProductionConfiguration} from './config.js';
import {AppDatabase} from './db.js';
import {CompshareInstanceController, MockInstanceController} from './compshare.js';
import {PowerCoordinator} from './power-coordinator.js';
import {CodexRunner} from './codex-runner.js';
import {SourceTranscriber} from './asr.js';
import {JobWorker} from './worker.js';
import {isExactReplicaAudioDurationCompatible, parseJobInput} from './validation.js';
import {createFullRegenerationJob, createRetryJob, RetryJobError} from './retry.js';
import {isUserFacingEvent, publicEvents} from './public-events.js';
import {YouTubeService} from './youtube.js';
import {DeploymentManager} from './deployment.js';
import {probeQwenTtsHealth} from './qwen-tts-health.js';
import {migrateLegacyArtifactPaths} from './path-migration.js';
import type {JobAssets, PresenterAsset, PresenterAssetKind} from './types.js';

assertProductionConfiguration();

const ffprobePath = (createRequire(import.meta.url)('@ffprobe-installer/ffprobe') as {path: string}).path;
const bundledFfmpegPath = createRequire(import.meta.url)('ffmpeg-static') as string;
const fastRenderFfmpegPath = existsSync(config.asr.ffmpegBin) ? config.asr.ffmpegBin : bundledFfmpegPath;

const incomingDir = path.join(config.dataDir, 'incoming');
const jobsDir = path.join(config.dataDir, 'jobs');
const libraryDir = path.join(config.dataDir, 'presenter-library');
const youtubeImportsDir = path.join(config.dataDir, 'youtube-imports');
const maxUploadedAudioSeconds = 180;
const maxExactReplicaSeconds = 1800;
mkdirSync(incomingDir, {recursive: true});
mkdirSync(jobsDir, {recursive: true});
mkdirSync(libraryDir, {recursive: true});
mkdirSync(youtubeImportsDir, {recursive: true});
migrateLegacyArtifactPaths(config.dataDir);

const probeMediaDuration = (file: string): number => {
  const result = spawnSync(
    ffprobePath,
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'json', file],
    {encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024},
  );
  if (result.status !== 0 || result.error) throw new Error('无法读取上传媒体时长，请检查文件是否完整');
  try {
    const duration = Number((JSON.parse(result.stdout) as {format?: {duration?: string}}).format?.duration);
    if (!Number.isFinite(duration) || duration <= 0) throw new Error();
    return duration;
  } catch {
    throw new Error('无法读取上传媒体时长，请检查文件格式');
  }
};

const probeImageDimensions = (file: string): {width: number; height: number} => {
  const result = spawnSync(
    ffprobePath,
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', file],
    {encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024},
  );
  try {
    const stream = (JSON.parse(result.stdout) as {streams?: Array<{width?: number; height?: number}>}).streams?.[0];
    const width = Number(stream?.width);
    const height = Number(stream?.height);
    if (result.status !== 0 || !Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      throw new Error();
    }
    if (width / height > 4 || height / width > 4) throw new Error('人物图片宽高比不能超过 4:1');
    return {width, height};
  } catch (error) {
    if (error instanceof Error && error.message === '人物图片宽高比不能超过 4:1') throw error;
    throw new Error('无法读取人物图片尺寸，请检查图片是否完整');
  }
};

const db = new AppDatabase(path.join(config.dataDir, 'platform.sqlite'));
const deployment = new DeploymentManager(config.deployment);
const deploymentTicker = setInterval(() => {
  deployment.tick(db.queueSummary().total);
}, 5_000);
deploymentTicker.unref();
const youtube = new YouTubeService({...config.youtube, importsDir: youtubeImportsDir});
const controller = config.mockGpu
  ? new MockInstanceController()
  : new CompshareInstanceController(config.compshare);
const power = new PowerCoordinator(db, controller, {
  windowMs: config.powerWindowMs,
  tickMs: config.powerTickMs,
  startTimeoutMs: config.gpuStartTimeoutMs,
  healthUrl: config.gpuHealthUrl,
  mockGpu: config.mockGpu,
  mockCodex: config.mockCodex,
  codexModel: config.codex.model,
});
const runner = new CodexRunner({...config.codex, mock: config.mockCodex, qwenTtsModel: config.qwenTts.model});
const transcriber = new SourceTranscriber(config.asr);
const worker = new JobWorker(db, power, runner, transcriber, {
  jobsDir,
  skillPath: config.codex.skillPath,
  presenterApiUrl: config.presenterApiUrl,
  presenterComfyUrl: config.presenterComfyUrl,
  presenterWorkers: config.presenterWorkers,
  qwenTtsBaseUrl: config.qwenTts.baseUrl,
  qwenTtsApiToken: config.qwenTts.apiToken,
  qwenTtsModel: config.qwenTts.model,
  remotionRuntimeDir: config.remotionRuntimeDir,
  remotionSkillPath: config.remotionSkillPath,
  videoShotcraftSkillPath: config.videoShotcraftSkillPath,
  remotionBrowserExecutable: config.remotionBrowserExecutable,
  remotionConcurrency: config.remotionConcurrency,
  remotionCrf: config.remotionCrf,
  pythonBin: config.pythonBin,
  ffmpegBin: fastRenderFfmpegPath,
  ffprobeBin: ffprobePath,
  cjkFontPaths: config.cjkFontPaths,
  asrBin: config.asr.bin,
  asrModel: config.asr.model,
  asrLanguage: config.asr.language,
  asrThreads: config.asr.threads,
  asrUseGpu: config.asr.useGpu,
});

power.start();
if (config.jobsEnabled) worker.start();

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');
app.use(
  helmet({
    crossOriginResourcePolicy: false,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:', 'blob:', 'https://i.ytimg.com', 'https://img.youtube.com'],
        mediaSrc: ["'self'", 'blob:'],
        connectSrc: ["'self'"],
      },
    },
  }),
);

const hashToken = (value: string): Buffer => createHash('sha256').update(value).digest();
const sessionDigest = config.appAccessToken ? hashToken(config.appAccessToken).toString('hex') : '';
const adminSessionDigest = config.adminAccessToken ? hashToken(config.adminAccessToken).toString('hex') : '';
const tokenMatches = (provided: string, expected: string): boolean =>
  Boolean(provided && expected) && timingSafeEqual(hashToken(provided), hashToken(expected));
const cookies = (req: Request): Record<string, string> =>
  Object.fromEntries(
    String(req.headers.cookie ?? '')
      .split(';')
      .map((part) => {
        const value = part.trim();
        const separator = value.indexOf('=');
        return separator === -1 ? ['', ''] : [value.slice(0, separator), value.slice(separator + 1)];
      })
      .filter(([key, value]) => Boolean(key && value))
      .map(([key, value]) => [decodeURIComponent(key), decodeURIComponent(value)]),
  );

const publicJob = (job: ReturnType<AppDatabase['getJob']>) => {
  if (!job) return null;
  const {assets, outputPath: _outputPath, metadata: _metadata, ...safe} = job;
  return {
    ...safe,
    hasResult: job.status === 'succeeded' && Boolean(job.outputPath),
    assetPresence: {
      avatarImage: Boolean(assets.avatarImage),
      sourceVideo: Boolean(assets.sourceVideo),
      voiceReference: Boolean(assets.voiceReference),
    },
  };
};

const secretValues = [
  config.appAccessToken,
  config.adminAccessToken,
  config.compshare.publicKey,
  config.compshare.privateKey,
  process.env.MODELVERSE_API_KEY ?? '',
  config.qwenTts.apiToken,
  process.env.HEYGEN_API_KEY ?? '',
  config.youtube.apiKey,
].filter((value) => value.length >= 6);
const redactAdminValue = (value: unknown): unknown => {
  if (typeof value === 'string') {
    return secretValues.reduce((output, secret) => output.split(secret).join('<redacted>'), value);
  }
  if (Array.isArray(value)) return value.map(redactAdminValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactAdminValue(entry)]));
  }
  return value;
};
const adminEvents = <T extends {kind: string; data: Record<string, unknown>}>(events: T[]) =>
  events.filter(isUserFacingEvent).map((event) => ({...event, data: redactAdminValue(event.data)}));

const streamJobEvents = (
  jobId: string,
  req: Request,
  res: Response,
  serialize: (events: ReturnType<AppDatabase['listEvents']>) => Array<{id: number}>,
): Response | void => {
  const job = db.getJob(jobId);
  if (!job) return res.status(404).json({error: '任务不存在'});
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  let cursor = Number(req.query.after ?? 0);
  const send = (): void => {
    const current = db.getJob(job.id);
    const events = db.listEvents(job.id, cursor);
    if (events.length) cursor = events.at(-1)!.id;
    for (const event of serialize(events)) {
      res.write(`id: ${event.id}\nevent: job_event\ndata: ${JSON.stringify(event)}\n\n`);
    }
    res.write(`event: snapshot\ndata: ${JSON.stringify(publicJob(current))}\n\n`);
    if (current && ['succeeded', 'failed', 'cancelled'].includes(current.status)) {
      clearInterval(timer);
      res.end();
    }
  };
  const timer = setInterval(send, 1500);
  req.on('close', () => clearInterval(timer));
  send();
};
app.use(express.json({limit: '1mb'}));
app.use(
  '/api',
  rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 600,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    skip: (req) => req.method === 'GET' || req.method === 'HEAD' || req.method === 'OPTIONS',
  }),
);

const userAuth = (req: Request, res: Response, next: NextFunction): void => {
  if (!config.appAccessToken) return next();
  const bearer = req.header('authorization')?.replace(/^Bearer\s+/i, '');
  const provided = req.header('x-access-token') ?? bearer ?? '';
  const sessionValid = cookies(req).presenter_session === sessionDigest;
  if (!tokenMatches(provided, config.appAccessToken) && !sessionValid) {
    res.status(401).json({error: '需要访问口令'});
    return;
  }
  next();
};

const adminAuth = (req: Request, res: Response, next: NextFunction): void => {
  if (!config.adminAccessToken && config.mockGpu && config.mockCodex) return next();
  const bearer = req.header('authorization')?.replace(/^Bearer\s+/i, '');
  const provided = req.header('x-admin-token') ?? bearer ?? '';
  const sessionValid = cookies(req).presenter_admin_session === adminSessionDigest;
  if (!tokenMatches(provided, config.adminAccessToken) && !sessionValid) {
    res.status(401).json({error: '需要管理员口令'});
    return;
  }
  next();
};

const upload = multer({
  dest: incomingDir,
  limits: {fileSize: config.maxUploadBytes, files: 3, fields: 30},
  fileFilter: (_req, file, callback) => {
    const allowed = new Set([
      'video/mp4',
      'video/quicktime',
      'video/webm',
      'image/jpeg',
      'image/png',
      'image/webp',
      'audio/wav',
      'audio/x-wav',
      'audio/mpeg',
      'audio/mp3',
      'audio/mp4',
      'audio/x-m4a',
    ]);
    if (!allowed.has(file.mimetype)) return callback(new Error(`不支持的文件类型: ${file.mimetype}`));
    return callback(null, true);
  },
});

const publicPresenterAsset = ({filePath: _filePath, ...asset}: PresenterAsset) => asset;

const savePresenterAsset = (input: {
  sourcePath: string;
  kind: PresenterAssetKind;
  name: string;
  originalName: string;
  mimeType: string;
  durationSeconds: number | null;
}): PresenterAsset => {
  const id = randomUUID();
  const extension = path.extname(input.originalName).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 8) || '.bin';
  const directory = path.join(libraryDir, id);
  const filePath = path.join(directory, `asset${extension}`);
  mkdirSync(directory, {recursive: true});
  copyFileSync(input.sourcePath, filePath);
  return db.createPresenterAsset({
    id,
    kind: input.kind,
    name: input.name.trim().slice(0, 60) || (input.kind === 'avatar' ? '我的形象' : '我的声音'),
    filePath,
    originalName: input.originalName,
    mimeType: input.mimeType,
    durationSeconds: input.durationSeconds,
  });
};

const sendJobResult = (jobId: string, req: Request, res: Response): Response | void => {
  const job = db.getJob(jobId);
  if (!job) return res.status(404).json({error: '任务不存在'});
  if (job.status !== 'succeeded' || !job.outputPath || !existsSync(job.outputPath)) {
    return res.status(409).json({error: '成片尚未生成'});
  }
  const resolved = path.resolve(job.outputPath);
  if (!resolved.startsWith(path.resolve(jobsDir) + path.sep)) return res.status(403).json({error: '无效产物路径'});
  if (req.query.inline === '1') {
    res.setHeader('Content-Disposition', `inline; filename="${job.id}.mp4"`);
    return res.sendFile(resolved);
  }
  return res.download(resolved, `${job.title.replace(/[^\p{L}\p{N}_-]+/gu, '_') || job.id}.mp4`);
};

type JobDelivery = {
  marketingTitle: string;
  marketingDescription: string;
  coverPath: string;
};

const jobDelivery = (jobId: string): JobDelivery => {
  const job = db.getJob(jobId);
  if (!job) throw Object.assign(new Error('任务不存在'), {status: 404});
  if (job.status !== 'succeeded') throw Object.assign(new Error('发布素材尚未生成'), {status: 409});
  const workspace = path.join(jobsDir, job.id);
  const manifestPath = path.join(workspace, 'out', 'result.json');
  if (!existsSync(manifestPath)) throw Object.assign(new Error('发布清单不存在'), {status: 409});
  let manifest: Record<string, unknown>;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  } catch {
    throw Object.assign(new Error('发布清单无效'), {status: 409});
  }
  const marketingTitle = typeof manifest.marketingTitle === 'string' ? manifest.marketingTitle.trim() : '';
  const marketingDescription =
    typeof manifest.marketingDescription === 'string' ? manifest.marketingDescription.trim() : '';
  const coverPath = path.resolve(String(manifest.coverPath ?? ''));
  if (
    !marketingTitle ||
    !marketingDescription ||
    !coverPath.startsWith(path.resolve(workspace) + path.sep) ||
    !existsSync(coverPath)
  ) {
    throw Object.assign(new Error('发布标题、描述或封面不完整'), {status: 409});
  }
  return {marketingTitle, marketingDescription, coverPath};
};

const sendJobCover = (jobId: string, req: Request, res: Response): Response | void => {
  try {
    const delivery = jobDelivery(jobId);
    if (req.query.inline === '0') return res.download(delivery.coverPath, `${jobId}-cover.png`);
    res.setHeader('Content-Disposition', `inline; filename="${jobId}-cover.png"`);
    return res.sendFile(delivery.coverPath);
  } catch (error) {
    const status = Number((error as {status?: unknown}).status) || 500;
    return res.status(status).json({error: error instanceof Error ? error.message : String(error)});
  }
};

const sendJobDelivery = (jobId: string, res: Response): Response => {
  try {
    const {coverPath: _coverPath, ...delivery} = jobDelivery(jobId);
    return res.json(delivery);
  } catch (error) {
    const status = Number((error as {status?: unknown}).status) || 500;
    return res.status(status).json({error: error instanceof Error ? error.message : String(error)});
  }
};

app.get('/api/health', (_req, res) => res.json({ok: true, time: new Date().toISOString()}));
app.get('/api/public-config', (_req, res) =>
  res.json({
    authRequired: Boolean(config.appAccessToken),
    jobsEnabled: config.jobsEnabled,
    maxUploadMb: Math.round(config.maxUploadBytes / 1024 / 1024),
    youtubeSearchProvider: config.youtube.apiKey ? 'official' : 'fallback',
  }),
);
app.get('/api/admin/public-config', (_req, res) =>
  res.json({
    authRequired: Boolean(config.adminAccessToken),
  }),
);

app.post(
  '/api/session',
  rateLimit({windowMs: 15 * 60 * 1000, limit: 20, standardHeaders: 'draft-8', legacyHeaders: false}),
  (req, res) => {
    if (!tokenMatches(String(req.body?.token ?? ''), config.appAccessToken)) {
      return res.status(401).json({error: '访问口令错误'});
    }
    res.cookie('presenter_session', sessionDigest, {
      httpOnly: true,
      sameSite: 'strict',
      secure: config.sessionCookieSecure,
      maxAge: 7 * 24 * 60 * 60 * 1000,
      path: '/',
    });
    return res.json({ok: true});
  },
);

app.post(
  '/api/admin/session',
  rateLimit({windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false}),
  (req, res) => {
    if (!tokenMatches(String(req.body?.token ?? ''), config.adminAccessToken)) {
      return res.status(401).json({error: '管理员口令错误'});
    }
    res.cookie('presenter_admin_session', adminSessionDigest, {
      httpOnly: true,
      sameSite: 'strict',
      secure: config.sessionCookieSecure,
      maxAge: 12 * 60 * 60 * 1000,
      path: '/',
    });
    return res.json({ok: true});
  },
);

app.use('/api/admin', adminAuth);

app.get('/api/admin/dashboard', async (_req, res, next) => {
  try {
    const [system, qwenTts] = await Promise.all([
      power.systemSnapshot(),
      probeQwenTtsHealth({
        baseUrl: config.qwenTts.baseUrl,
        apiToken: config.qwenTts.apiToken,
        model: config.qwenTts.model,
      }),
    ]);
    res.json({
      system,
      qwenTts,
      metrics: db.metrics24h(),
      recentEvents: adminEvents(db.listRecentEvents()),
      serverTime: new Date().toISOString(),
      uptimeSeconds: Math.floor(process.uptime()),
      jobsEnabled: config.jobsEnabled,
    });
  } catch (error) {
    next(error);
  }
});

app.get('/api/admin/deployment', (_req, res) => {
  res.json(deployment.snapshot());
});

app.post(
  '/api/admin/deployment',
  rateLimit({windowMs: 60 * 60 * 1000, limit: 5, standardHeaders: 'draft-8', legacyHeaders: false}),
  (req, res) => {
    if (req.body?.confirmation !== 'DEPLOY') return res.status(400).json({error: '需要明确确认发布'});
    try {
      return res.status(202).json(deployment.trigger(db.queueSummary().total, req.body?.defer === true));
    } catch (error) {
      const status = Number((error as {status?: unknown}).status) || 500;
      return res.status(status).json({error: error instanceof Error ? error.message : String(error)});
    }
  },
);

app.delete('/api/admin/deployment', (req, res) => {
  if (req.body?.confirmation !== 'CANCEL_DEPLOY') return res.status(400).json({error: '需要明确确认取消发布'});
  try {
    return res.json(deployment.cancelQueued());
  } catch (error) {
    const status = Number((error as {status?: unknown}).status) || 500;
    return res.status(status).json({error: error instanceof Error ? error.message : String(error)});
  }
});

app.get('/api/admin/jobs', (req, res) => {
  res.json({jobs: db.listJobs(Number(req.query.limit ?? 200)).map((job) => publicJob(job))});
});

app.get('/api/admin/jobs/:id', (req, res) => {
  const job = db.getJob(req.params.id);
  if (!job) return res.status(404).json({error: '任务不存在'});
  const after = req.query.after;
  const events = after === undefined ? db.listLatestEvents(job.id) : db.listEvents(job.id, Number(after));
  return res.json({job: publicJob(job), events: adminEvents(events)});
});

app.get('/api/admin/jobs/:id/events', (req, res) =>
  streamJobEvents(req.params.id, req, res, (events) => adminEvents(events)),
);

app.post('/api/admin/jobs/:id/cancel', (req, res) => {
  const job = worker.cancel(req.params.id);
  if (!job) return res.status(404).json({error: '任务不存在'});
  return res.status(202).json({job: publicJob(job)});
});

app.post('/api/admin/jobs/:id/retry', (req, res, next) => {
  if (!config.jobsEnabled) return res.status(503).json({error: '生成服务正在维护，请稍后再试'});
  try {
    const result = createRetryJob(db, jobsDir, req.params.id, randomUUID());
    if (!result.reusedPresenterRender) power.requestPowerForQueuedJob(result.job.id);
    return res.status(202).json({
      job: publicJob(result.job),
      reusedCheckpoints: result.reusedCheckpoints,
      reusedCompletedArtifacts: result.reusedCompletedArtifacts,
      reusedSourceTranscript: result.reusedSourceTranscript,
      reusedPresenterRender: result.reusedPresenterRender,
      fastRenderOnly: result.fastRenderOnly,
    });
  } catch (error) {
    if (error instanceof RetryJobError) return res.status(error.status).json({error: error.message});
    return next(error);
  }
});

app.post('/api/admin/jobs/:id/regenerate', (req, res, next) => {
  if (!config.jobsEnabled) return res.status(503).json({error: '生成服务正在维护，请稍后再试'});
  try {
    const replicaMode = req.body?.replicaMode;
    if (replicaMode !== undefined && replicaMode !== 'exact' && replicaMode !== 'condensed') {
      return res.status(400).json({error: 'replicaMode 必须是 exact 或 condensed'});
    }
    const durationSeconds = req.body?.durationSeconds === undefined ? undefined : Number(req.body.durationSeconds);
    const translateToChinese = req.body?.translateToChinese === undefined
      ? undefined
      : req.body.translateToChinese === true || req.body.translateToChinese === 'true';
    const publishPlatform = req.body?.publishPlatform;
    if (
      publishPlatform !== undefined &&
      !['original', 'douyin', 'wechat_channels', 'bilibili'].includes(publishPlatform)
    ) {
      return res.status(400).json({error: 'publishPlatform 不受支持'});
    }
    const result = createFullRegenerationJob(db, jobsDir, req.params.id, randomUUID(), {
      replicaMode,
      durationSeconds,
      translateToChinese,
      publishPlatform,
    });
    power.requestPowerForQueuedJob(result.job.id);
    return res.status(202).json({...result, job: publicJob(result.job)});
  } catch (error) {
    if (error instanceof RetryJobError) return res.status(error.status).json({error: error.message});
    return next(error);
  }
});

app.get('/api/admin/jobs/:id/result', (req, res) => sendJobResult(req.params.id, req, res));
app.get('/api/admin/jobs/:id/delivery', (req, res) => sendJobDelivery(req.params.id, res));
app.get('/api/admin/jobs/:id/cover', (req, res) => sendJobCover(req.params.id, req, res));

app.post('/api/admin/power/start', async (req, res, next) => {
  try {
    const leaseSeconds = req.body?.leaseSeconds === undefined ? 0 : Number(req.body.leaseSeconds);
    if (
      !Number.isFinite(leaseSeconds) ||
      leaseSeconds < 0 ||
      (leaseSeconds > 0 && leaseSeconds < 5 * 60) ||
      leaseSeconds > 12 * 60 * 60
    ) {
      return res.status(400).json({error: 'leaseSeconds 必须是 0，或 300 到 43200 之间的秒数'});
    }
    res.json(await power.manualStart({
      leaseMs: leaseSeconds * 1000,
      reason: typeof req.body?.reason === 'string' ? req.body.reason : '管理员手动任务',
    }));
  } catch (error) {
    next(error);
  }
});

app.post('/api/admin/power/lease', (req, res, next) => {
  try {
    const leaseSeconds = Number(req.body?.leaseSeconds);
    const lease = power.acquireExternalLease(
      leaseSeconds * 1000,
      typeof req.body?.reason === 'string' ? req.body.reason : '平台外任务',
    );
    res.json({ok: true, lease});
  } catch (error) {
    next(error);
  }
});

app.delete('/api/admin/power/lease', (_req, res) => {
  power.releaseExternalLease();
  res.json({ok: true});
});

app.post('/api/admin/power/stop', async (_req, res, next) => {
  try {
    await power.manualStop();
    res.status(202).json({ok: true});
  } catch (error) {
    next(error);
  }
});

app.use('/api', userAuth);

app.get('/api/system', (_req, res) => {
  const queue = db.queueSummary();
  res.json({
    queue,
    service: {
      accepting: config.jobsEnabled,
      status: queue.active > 0 ? 'processing' : queue.pending > 0 ? 'queued' : 'ready',
    },
    updatedAt: new Date().toISOString(),
  });
});

app.get('/api/presenter-assets', (req, res) => {
  const kind = req.query.kind === 'avatar' || req.query.kind === 'voice' ? req.query.kind : undefined;
  res.json({assets: db.listPresenterAssets(kind).map(publicPresenterAsset)});
});

app.get('/api/presenter-assets/:id/file', (req, res) => {
  const asset = db.getPresenterAsset(req.params.id);
  if (!asset || !existsSync(asset.filePath)) return res.status(404).json({error: '素材不存在'});
  const resolved = path.resolve(asset.filePath);
  if (!resolved.startsWith(path.resolve(libraryDir) + path.sep)) return res.status(403).json({error: '素材路径无效'});
  res.type(asset.mimeType);
  return res.sendFile(resolved);
});

app.get(
  '/api/youtube/search',
  rateLimit({windowMs: 60 * 60 * 1000, limit: 60, standardHeaders: 'draft-8', legacyHeaders: false}),
  async (req, res, next) => {
    try {
      const keyword = String(req.query.q ?? '');
      const days = Number(req.query.days ?? 90);
      const license = req.query.license === 'any' ? 'any' : 'creativeCommon';
      const duration = ['any', 'short', '1to5', '5to15', '15to30'].includes(String(req.query.duration))
        ? String(req.query.duration) as 'any' | 'short' | '1to5' | '5to15' | '15to30'
        : 'any';
      const sort = ['velocity', 'views', 'newest'].includes(String(req.query.sort))
        ? String(req.query.sort) as 'velocity' | 'views' | 'newest'
        : 'velocity';
      const allowedMinimumViews = [0, 10_000, 100_000, 1_000_000];
      const requestedMinimumViews = Number(req.query.minViews ?? 0);
      const minViews = allowedMinimumViews.includes(requestedMinimumViews) ? requestedMinimumViews : 0;
      const allowedMinimumVelocity = [0, 1_000, 10_000, 50_000];
      const requestedMinimumVelocity = Number(req.query.minViewsPerDay ?? 0);
      const minViewsPerDay = allowedMinimumVelocity.includes(requestedMinimumVelocity) ? requestedMinimumVelocity : 0;
      res.json({
        videos: await youtube.search(keyword, days, license, {duration, minViews, minViewsPerDay, sort}),
        provider: config.youtube.apiKey ? 'official' : 'fallback',
      });
    } catch (error) {
      next(error);
    }
  },
);

app.post(
  '/api/youtube/import',
  rateLimit({windowMs: 60 * 60 * 1000, limit: 10, standardHeaders: 'draft-8', legacyHeaders: false}),
  async (req, res, next) => {
    try {
      if (req.body?.rightsConfirmed !== true && req.body?.rightsConfirmed !== 'true') {
        throw new Error('导入前必须确认拥有该 YouTube 视频的下载和改编权');
      }
      const imported = await youtube.importVideo(String(req.body?.url ?? ''));
      res.status(201).json({import: {id: imported.id, video: imported.video}});
    } catch (error) {
      next(error);
    }
  },
);

app.get('/api/jobs', (req, res) => {
  res.json({jobs: db.listJobs(Number(req.query.limit ?? 100)).map((job) => publicJob(job))});
});

app.get('/api/jobs/:id', (req, res) => {
  const job = db.getJob(req.params.id);
  if (!job) return res.status(404).json({error: '任务不存在'});
  const after = req.query.after;
  const events = after === undefined ? db.listLatestEvents(job.id) : db.listEvents(job.id, Number(after));
  return res.json({job: publicJob(job), events: publicEvents(events)});
});

app.post(
  '/api/jobs',
  rateLimit({windowMs: 60 * 60 * 1000, limit: 30, standardHeaders: 'draft-8', legacyHeaders: false}),
  (_req, res, next) => {
    if (!config.jobsEnabled) return res.status(503).json({error: '生成服务正在维护，请稍后再试'});
    return next();
  },
  upload.fields([
    {name: 'avatarImage', maxCount: 1},
    {name: 'sourceVideo', maxCount: 1},
    {name: 'voiceReference', maxCount: 1},
  ]),
  (req, res, next) => {
    const files = (req.files ?? {}) as Record<string, Express.Multer.File[]>;
    const uploaded = Object.values(files).flat();
    const id = randomUUID();
    const assetsDir = path.join(jobsDir, id, 'assets');
    try {
      mkdirSync(assetsDir, {recursive: true});
      const assets: JobAssets = {};
      const body = {...(req.body as Record<string, unknown>)};
      let youtubeMetadata: Record<string, unknown> | undefined;
      for (const [field, entries] of Object.entries(files)) {
        const file = entries[0];
        if (!file) continue;
        const safeExtension = path.extname(file.originalname).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 8);
        const destination = path.join(assetsDir, `${field}${safeExtension || '.bin'}`);
        renameSync(file.path, destination);
        if (field === 'avatarImage') assets.avatarImage = destination;
        if (field === 'sourceVideo') assets.sourceVideo = destination;
        if (field === 'voiceReference') assets.voiceReference = destination;
      }
      const attachLibraryAsset = (rawId: unknown, kind: PresenterAssetKind, field: keyof JobAssets): void => {
        if (assets[field] || !rawId) return;
        const asset = db.getPresenterAsset(String(rawId));
        if (!asset || asset.kind !== kind || !existsSync(asset.filePath)) throw new Error(`选择的${kind === 'avatar' ? '形象' : '声音'}素材不存在`);
        const extension = path.extname(asset.originalName).toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 8) || '.bin';
        const destination = path.join(assetsDir, `${field}${extension}`);
        copyFileSync(asset.filePath, destination);
        assets[field] = destination;
      };
      attachLibraryAsset(body.avatarAssetId, 'avatar', 'avatarImage');
      attachLibraryAsset(body.voiceAssetId, 'voice', 'voiceReference');
      if (!assets.sourceVideo && body.youtubeImportId) {
        const imported = youtube.getImport(String(body.youtubeImportId));
        const destination = path.join(assetsDir, 'sourceVideo.mp4');
        copyFileSync(imported.sourcePath, destination);
        assets.sourceVideo = destination;
        youtubeMetadata = {youtubeImportId: imported.id, youtubeVideo: imported.video};
      }
      if (body.voiceMode === undefined) {
        body.voiceMode = assets.voiceReference ? 'uploaded_reference' : body.mode === 'clone' ? 'original_clone' : 'system_voice';
      }
      let sourceDuration: number | null = null;
      if (body.mode === 'clone') {
        if (!assets.sourceVideo) throw new Error('完整复刻需要上传参考视频');
        sourceDuration = probeMediaDuration(assets.sourceVideo);
        if (sourceDuration > maxExactReplicaSeconds) {
          throw new Error(`完整复刻原片最长 ${maxExactReplicaSeconds / 60} 分钟`);
        }
        if (body.replicaMode === undefined || body.replicaMode === 'exact') {
          body.replicaMode = 'exact';
          body.durationSeconds = String(Math.max(1, Math.ceil(sourceDuration)));
        }
      }
      if (body.voiceMode === 'uploaded_audio' || body.voiceMode === 'uploaded_reference') {
        if (!assets.voiceReference) throw new Error('请上传声音文件');
        const audioDuration = probeMediaDuration(assets.voiceReference);
        if (body.voiceMode === 'uploaded_audio') {
          if (audioDuration > maxUploadedAudioSeconds) {
            throw new Error(`口播音频最长 ${maxUploadedAudioSeconds} 秒`);
          }
          body.durationSeconds = String(Math.max(1, Math.ceil(audioDuration)));
          if (
            body.mode === 'clone' &&
            body.replicaMode === 'exact' &&
            sourceDuration !== null &&
            !isExactReplicaAudioDurationCompatible(sourceDuration, audioDuration)
          ) {
            throw new Error(
              `完整复刻使用整段音频时，音频时长需接近原片 ${Math.ceil(sourceDuration)} 秒；当前为 ${Math.ceil(audioDuration)} 秒`,
            );
          }
        } else if (audioDuration < 5 || audioDuration > 30) {
          throw new Error('参考音色需要 5-30 秒干净人声');
        }
      }
      const input = parseJobInput(body, assets);
      const savedAssets: PresenterAsset[] = [];
      const avatarUpload = files.avatarImage?.[0];
      if (avatarUpload && assets.avatarImage && String(body.saveAvatarAsset ?? '') === 'true') {
        savedAssets.push(savePresenterAsset({
          sourcePath: assets.avatarImage,
          kind: 'avatar',
          name: String(body.avatarAssetName ?? path.parse(avatarUpload.originalname).name),
          originalName: avatarUpload.originalname,
          mimeType: avatarUpload.mimetype,
          durationSeconds: null,
        }));
      }
      const voiceUpload = files.voiceReference?.[0];
      if (voiceUpload && assets.voiceReference && String(body.saveVoiceAsset ?? '') === 'true') {
        savedAssets.push(savePresenterAsset({
          sourcePath: assets.voiceReference,
          kind: 'voice',
          name: String(body.voiceAssetName ?? path.parse(voiceUpload.originalname).name),
          originalName: voiceUpload.originalname,
          mimeType: voiceUpload.mimetype,
          durationSeconds: probeMediaDuration(assets.voiceReference),
        }));
      }
      const metadata: Record<string, unknown> = {...(youtubeMetadata ?? {})};
      if (assets.avatarImage) metadata.avatarDimensions = probeImageDimensions(assets.avatarImage);
      const job = db.createJob(id, input, metadata);
      power.requestPowerForQueuedJob(id);
      res.status(202).json({job: publicJob(job), savedAssets: savedAssets.map(publicPresenterAsset)});
    } catch (error) {
      for (const file of uploaded) {
        if (existsSync(file.path)) rmSync(file.path, {force: true});
      }
      rmSync(path.join(jobsDir, id), {recursive: true, force: true});
      next(error);
    }
  },
);

app.post('/api/jobs/:id/cancel', (req, res) => {
  const job = worker.cancel(req.params.id);
  if (!job) return res.status(404).json({error: '任务不存在'});
  return res.status(202).json({job: publicJob(job)});
});

app.post('/api/jobs/:id/retry', (req, res, next) => {
  if (!config.jobsEnabled) return res.status(503).json({error: '生成服务正在维护，请稍后再试'});
  try {
    const result = createRetryJob(db, jobsDir, req.params.id, randomUUID());
    if (!result.reusedPresenterRender) power.requestPowerForQueuedJob(result.job.id);
    return res.status(202).json({
      job: publicJob(result.job),
      reusedCheckpoints: result.reusedCheckpoints,
      reusedCompletedArtifacts: result.reusedCompletedArtifacts,
      reusedSourceTranscript: result.reusedSourceTranscript,
      reusedPresenterRender: result.reusedPresenterRender,
      fastRenderOnly: result.fastRenderOnly,
    });
  } catch (error) {
    if (error instanceof RetryJobError) return res.status(error.status).json({error: error.message});
    return next(error);
  }
});

app.post('/api/jobs/:id/regenerate', (req, res, next) => {
  if (!config.jobsEnabled) return res.status(503).json({error: '生成服务正在维护，请稍后再试'});
  try {
    const result = createFullRegenerationJob(db, jobsDir, req.params.id, randomUUID());
    power.requestPowerForQueuedJob(result.job.id);
    return res.status(202).json({...result, job: publicJob(result.job)});
  } catch (error) {
    if (error instanceof RetryJobError) return res.status(error.status).json({error: error.message});
    return next(error);
  }
});

app.get('/api/jobs/:id/events', (req, res) => {
  return streamJobEvents(req.params.id, req, res, (events) => publicEvents(events));
});

app.get('/api/jobs/:id/result', (req, res) => {
  return sendJobResult(req.params.id, req, res);
});
app.get('/api/jobs/:id/delivery', (req, res) => sendJobDelivery(req.params.id, res));
app.get('/api/jobs/:id/cover', (req, res) => sendJobCover(req.params.id, req, res));

const webDist = path.resolve('web/dist');
if (existsSync(webDist)) {
  app.use(express.static(webDist, {maxAge: '1h', index: false}));
  app.use((req, res, next) => {
    if (req.method === 'GET' && !req.path.startsWith('/api/')) return res.sendFile(path.join(webDist, 'index.html'));
    return next();
  });
}

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const message =
    error instanceof ZodError
      ? error.issues.map((issue) => issue.message).join('；')
      : error instanceof Error
        ? error.message
        : String(error);
  const status =
    error instanceof multer.MulterError && error.code === 'LIMIT_FILE_SIZE'
      ? 413
      : error instanceof multer.MulterError || error instanceof ZodError
        ? 400
        : message.includes('不存在')
          ? 404
          : message.includes('仍有') || message.includes('尚未')
            ? 409
            : ['文件', '需要', '请', '必须', '不支持', '无效', '最长', '时长'].some((keyword) => message.includes(keyword))
              ? 400
              : 500;
  res.status(status).json({error: message});
});

const server = app.listen(config.port, config.host, () => {
  console.log(`AI Presenter Platform listening on http://localhost:${config.port}`);
  console.log(`Safety mode: MOCK_GPU=${config.mockGpu} MOCK_CODEX=${config.mockCodex}`);
});

const shutdown = (): void => {
  worker.stop();
  power.stop();
  server.close(() => process.exit(0));
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
