import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import path from 'node:path';

export type SourceTranscript = {
  version: 1;
  sourceSha256: string;
  sourceSizeBytes: number;
  durationSeconds: number;
  language: string;
  model: string;
  text: string;
  segments: Array<{startSeconds: number; endSeconds: number; text: string}>;
  generatedAt: string;
};

export type SourceTranscriptResult = {path: string; sha256: string};

type SourceTranscriberOptions = {
  provider: 'local' | 'modelverse';
  cloudApiKey: string;
  cloudBaseUrl: string;
  cloudModel: string;
  localFallback: boolean;
  cacheDir: string;
  bin: string;
  model: string;
  ffmpegBin: string;
  useGpu: boolean;
  language: string;
  threads: number;
  timeoutMs: number;
};

type TranscribeCallbacks = {
  isCancelled: () => boolean;
  onEvent?: (kind: string, message: string, data?: Record<string, unknown>) => void;
  onProgress?: (percent: number) => void;
};

type TranscribeArtifactOptions = {
  artifactName?: string;
  mediaLabel?: string;
  minimumTextCharacters?: number;
};

type WhisperSegment = {
  timestamps?: {from?: unknown; to?: unknown};
  offsets?: {from?: unknown; to?: unknown};
  text?: unknown;
};

type OpenAiTranscriptionSegment = {
  start?: unknown;
  end?: unknown;
  text?: unknown;
};

const timestampSeconds = (value: unknown): number | null => {
  if (typeof value !== 'string') return null;
  const match = value.trim().match(/^(\d+):(\d{2}):(\d{2})[,.](\d{3})$/);
  if (!match) return null;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number(match[4]) / 1000;
};

const offsetSeconds = (value: unknown): number | null => {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric >= 0 ? numeric / 1000 : null;
};

export const normalizeWhisperTranscript = (
  raw: unknown,
): {language: string; text: string; segments: SourceTranscript['segments']} => {
  const root = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const result = root.result && typeof root.result === 'object' ? (root.result as Record<string, unknown>) : {};
  const language = typeof result.language === 'string' && result.language.trim() ? result.language.trim() : 'unknown';
  const transcription = Array.isArray(root.transcription) ? (root.transcription as WhisperSegment[]) : [];
  const segments = transcription
    .map((segment) => {
      const text = typeof segment.text === 'string' ? segment.text.trim() : '';
      const startSeconds = timestampSeconds(segment.timestamps?.from) ?? offsetSeconds(segment.offsets?.from);
      const endSeconds = timestampSeconds(segment.timestamps?.to) ?? offsetSeconds(segment.offsets?.to);
      if (!text || startSeconds === null || endSeconds === null || endSeconds < startSeconds) return null;
      return {startSeconds, endSeconds, text};
    })
    .filter((segment): segment is SourceTranscript['segments'][number] => segment !== null);
  const text = segments.map((segment) => segment.text).join(' ').replace(/\s+/g, ' ').trim();
  return {language, text, segments};
};

export const normalizeOpenAiTranscript = (
  raw: unknown,
): {language: string; text: string; segments: SourceTranscript['segments']} => {
  const root = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  const language = typeof root.language === 'string' && root.language.trim() ? root.language.trim() : 'unknown';
  const rawSegments = Array.isArray(root.segments) ? (root.segments as OpenAiTranscriptionSegment[]) : [];
  const segments = rawSegments
    .map((segment) => {
      const text = typeof segment.text === 'string' ? segment.text.trim() : '';
      const startSeconds = Number(segment.start);
      const endSeconds = Number(segment.end);
      if (
        !text ||
        !Number.isFinite(startSeconds) ||
        !Number.isFinite(endSeconds) ||
        startSeconds < 0 ||
        endSeconds < startSeconds
      ) {
        return null;
      }
      return {startSeconds, endSeconds, text};
    })
    .filter((segment): segment is SourceTranscript['segments'][number] => segment !== null);
  const text = segments.map((segment) => segment.text).join(' ').replace(/\s+/g, ' ').trim();
  return {language, text, segments};
};

export const whisperProgressPercent = (text: string): number | null => {
  const matches = [...text.matchAll(/progress\s*=\s*(\d{1,3})%/gi)];
  if (!matches.length) return null;
  return Math.min(100, Math.max(0, Number(matches.at(-1)?.[1] ?? 0)));
};

const sha256File = async (filename: string): Promise<string> =>
  new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filename);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });

const runProcess = async (
  bin: string,
  args: string[],
  timeoutMs: number,
  callbacks: TranscribeCallbacks,
  label: string,
  cwd?: string,
): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(bin, args, {cwd, stdio: ['ignore', 'ignore', 'pipe']});
    let stderr = '';
    let lastProgress = -1;
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearInterval(cancelPoll);
      if (error) reject(error);
      else resolve();
    };
    const timeout = setTimeout(() => {
      child.kill('SIGTERM');
      finish(new Error(`${label}超时`));
    }, timeoutMs);
    const cancelPoll = setInterval(() => {
      if (!callbacks.isCancelled()) return;
      child.kill('SIGTERM');
      finish(new Error('任务已取消'));
    }, 500);
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-6000);
      const progress = whisperProgressPercent(stderr);
      if (progress !== null && progress > lastProgress) {
        lastProgress = progress;
        callbacks.onProgress?.(progress);
      }
    });
    child.on('error', (error) => finish(new Error(`${label}无法启动: ${error.message}`)));
    child.on('exit', (code, signal) => {
      if (settled) return;
      if (code === 0) finish();
      else finish(new Error(`${label}失败 (${signal ?? code ?? 'unknown'}): ${stderr.trim().slice(-2000)}`));
    });
  });
};

const validTranscript = (
  value: unknown,
  sourceSha256: string,
  minimumTextCharacters = 20,
): value is SourceTranscript => {
  if (!value || typeof value !== 'object') return false;
  const transcript = value as Partial<SourceTranscript>;
  return (
    transcript.version === 1 &&
    transcript.sourceSha256 === sourceSha256 &&
    typeof transcript.text === 'string' &&
    transcript.text.trim().length >= minimumTextCharacters &&
    Array.isArray(transcript.segments) &&
    transcript.segments.length > 0
  );
};

const transcriptText = (transcript: SourceTranscript): string =>
  `${transcript.segments
    .map((segment) => `[${segment.startSeconds.toFixed(3)} --> ${segment.endSeconds.toFixed(3)}] ${segment.text}`)
    .join('\n')}\n`;

const writeTranscriptFiles = (transcript: SourceTranscript, jsonPath: string, textPath: string): void => {
  writeFileSync(jsonPath, `${JSON.stringify(transcript, null, 2)}\n`, 'utf8');
  writeFileSync(textPath, transcriptText(transcript), 'utf8');
};

const cloudErrorMessage = (error: unknown): string =>
  (error instanceof Error ? error.message : String(error)).replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(-1000);

export class SourceTranscriber {
  constructor(private readonly options: SourceTranscriberOptions) {}

  async transcribe(
    sourceMedia: string,
    workspace: string,
    callbacks: TranscribeCallbacks,
    artifactOptions: TranscribeArtifactOptions = {},
  ): Promise<SourceTranscriptResult> {
    const artifactName = artifactOptions.artifactName?.trim() || 'source';
    if (!/^[a-z0-9_-]+$/i.test(artifactName)) throw new Error('ASR artifactName 只能包含字母、数字、下划线和连字符');
    const mediaLabel = artifactOptions.mediaLabel?.trim() || '原片';
    const minimumTextCharacters = Math.max(1, Math.floor(artifactOptions.minimumTextCharacters ?? 20));
    if (!existsSync(sourceMedia) || statSync(sourceMedia).size <= 1024) throw new Error(`缺少有效${mediaLabel}媒体`);

    const analysisDir = path.join(workspace, 'out', 'analysis');
    const transcriptPath = path.join(analysisDir, `${artifactName}_transcript.json`);
    const transcriptTextPath = path.join(analysisDir, `${artifactName}_transcript.txt`);
    const rawPrefix = path.join(analysisDir, `${artifactName}_transcript.raw`);
    const rawJsonPath = `${rawPrefix}.json`;
    const localAudioPath = path.join(analysisDir, `${artifactName}_audio_16k.wav`);
    const cloudAudioPath = path.join(analysisDir, `${artifactName}_audio_16k.mp3`);
    mkdirSync(analysisDir, {recursive: true});

    callbacks.onEvent?.('asr_fingerprint', `正在校验${mediaLabel}并准备云端转写`);
    const sourceSha256 = await sha256File(sourceMedia);
    if (existsSync(transcriptPath)) {
      try {
        const cached = JSON.parse(readFileSync(transcriptPath, 'utf8')) as unknown;
        if (validTranscript(cached, sourceSha256, minimumTextCharacters)) {
          callbacks.onEvent?.('asr_reused', `已复用该任务的可靠${mediaLabel}转写`, {
            language: cached.language,
            segments: cached.segments.length,
          });
          return {path: transcriptPath, sha256: createHash('sha256').update(readFileSync(transcriptPath)).digest('hex')};
        }
      } catch {
        // Invalid partial output is replaced below.
      }
    }

    const cachePath = this.options.cacheDir ? path.join(this.options.cacheDir, `${sourceSha256}.json`) : '';
    if (cachePath && existsSync(cachePath)) {
      try {
        const cached = JSON.parse(readFileSync(cachePath, 'utf8')) as unknown;
        if (validTranscript(cached, sourceSha256, minimumTextCharacters)) {
          writeTranscriptFiles(cached, transcriptPath, transcriptTextPath);
          callbacks.onEvent?.('asr_cache_reused', `已按${mediaLabel}指纹复用云端转写缓存`, {
            language: cached.language,
            model: cached.model,
            segments: cached.segments.length,
          });
          return {path: transcriptPath, sha256: createHash('sha256').update(readFileSync(transcriptPath)).digest('hex')};
        }
      } catch {
        callbacks.onEvent?.('asr_cache_invalid', `忽略损坏的${mediaLabel}转写缓存`);
      }
    }

    rmSync(transcriptPath, {force: true});
    rmSync(transcriptTextPath, {force: true});
    rmSync(rawJsonPath, {force: true});
    rmSync(`${rawPrefix}.txt`, {force: true});
    rmSync(localAudioPath, {force: true});
    rmSync(cloudAudioPath, {force: true});

    let normalized: ReturnType<typeof normalizeWhisperTranscript>;
    let resolvedModel: string;
    let resolvedProvider: 'local' | 'modelverse';
    try {
      if (this.options.provider === 'modelverse') {
        try {
          normalized = await this.transcribeWithModelVerse(
            sourceMedia,
            cloudAudioPath,
            rawJsonPath,
            callbacks,
            mediaLabel,
          );
          resolvedModel = this.options.cloudModel;
          resolvedProvider = 'modelverse';
        } catch (error) {
          if (callbacks.isCancelled() || cloudErrorMessage(error) === '任务已取消') throw error;
          callbacks.onEvent?.('asr_cloud_failed', '云端 ASR 失败，准备切换本机 Metal', {
            error: cloudErrorMessage(error),
          });
          if (!this.options.localFallback) throw error;
          normalized = await this.transcribeLocally(sourceMedia, localAudioPath, rawPrefix, rawJsonPath, callbacks, mediaLabel);
          resolvedModel = path.basename(this.options.model);
          resolvedProvider = 'local';
        }
      } else {
        normalized = await this.transcribeLocally(sourceMedia, localAudioPath, rawPrefix, rawJsonPath, callbacks, mediaLabel);
        resolvedModel = path.basename(this.options.model);
        resolvedProvider = 'local';
      }
    } finally {
      rmSync(localAudioPath, {force: true});
      rmSync(cloudAudioPath, {force: true});
    }

    if (normalized.text.length < minimumTextCharacters || normalized.segments.length === 0) {
      throw new Error(`云端 ASR 未识别出足够的${mediaLabel}口播内容`);
    }
    const durationSeconds = normalized.segments.at(-1)?.endSeconds ?? 0;
    const transcript: SourceTranscript = {
      version: 1,
      sourceSha256,
      sourceSizeBytes: statSync(sourceMedia).size,
      durationSeconds,
      language: normalized.language,
      model: resolvedModel,
      text: normalized.text,
      segments: normalized.segments,
      generatedAt: new Date().toISOString(),
    };
    writeTranscriptFiles(transcript, transcriptPath, transcriptTextPath);
    if (cachePath) {
      mkdirSync(path.dirname(cachePath), {recursive: true});
      const temporaryCache = `${cachePath}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(temporaryCache, `${JSON.stringify(transcript, null, 2)}\n`, {encoding: 'utf8', mode: 0o600});
      renameSync(temporaryCache, cachePath);
    }
    callbacks.onEvent?.('asr_completed', `${mediaLabel}转写完成`, {
      language: normalized.language,
      model: resolvedModel,
      provider: resolvedProvider,
      segments: normalized.segments.length,
      transcriptPath,
    });
    return {path: transcriptPath, sha256: createHash('sha256').update(readFileSync(transcriptPath)).digest('hex')};
  }

  private async transcribeWithModelVerse(
    sourceMedia: string,
    audioPath: string,
    rawJsonPath: string,
    callbacks: TranscribeCallbacks,
    mediaLabel: string,
  ): Promise<ReturnType<typeof normalizeOpenAiTranscript>> {
    if (!this.options.cloudApiKey) throw new Error('未配置 ModelVerse 云端 ASR 密钥');
    callbacks.onEvent?.('asr_extract', `正在压缩${mediaLabel}音频供云端转写，数字人 GPU 尚未启动`);
    await runProcess(
      this.options.ffmpegBin,
      [
        '-y',
        '-v',
        'error',
        '-i',
        sourceMedia,
        '-vn',
        '-ac',
        '1',
        '-ar',
        '16000',
        '-c:a',
        'libmp3lame',
        '-b:a',
        '64k',
        audioPath,
      ],
      Math.min(this.options.timeoutMs, 30 * 60 * 1000),
      callbacks,
      '云端 ASR 音频准备',
    );
    callbacks.onProgress?.(5);
    callbacks.onEvent?.('asr_cloud_running', `正在使用 ModelVerse whisper-1 云端转写${mediaLabel}，数字人 GPU 尚未启动`, {
      model: this.options.cloudModel,
      uploadBytes: statSync(audioPath).size,
    });

    const form = new FormData();
    form.append('file', new Blob([readFileSync(audioPath)], {type: 'audio/mpeg'}), 'source.mp3');
    form.append('model', this.options.cloudModel);
    form.append('response_format', 'verbose_json');
    form.append('timestamp_granularities[]', 'segment');
    if (this.options.language && this.options.language !== 'auto') form.append('language', this.options.language);

    const controller = new AbortController();
    let abortReason: 'cancelled' | 'timeout' | null = null;
    const timeout = setTimeout(() => {
      abortReason = 'timeout';
      controller.abort();
    }, this.options.timeoutMs);
    const cancelPoll = setInterval(() => {
      if (!callbacks.isCancelled()) return;
      abortReason = 'cancelled';
      controller.abort();
    }, 500);
    try {
      const response = await fetch(`${this.options.cloudBaseUrl.replace(/\/$/, '')}/audio/transcriptions`, {
        method: 'POST',
        headers: {Authorization: `Bearer ${this.options.cloudApiKey}`},
        body: form,
        signal: controller.signal,
      });
      const body = await response.text();
      if (!response.ok) throw new Error(`ModelVerse ASR 请求失败 (${response.status}): ${body.slice(-1000)}`);
      let raw: unknown;
      try {
        raw = JSON.parse(body);
      } catch {
        throw new Error('ModelVerse ASR 返回的不是有效 JSON');
      }
      writeFileSync(rawJsonPath, `${JSON.stringify(raw, null, 2)}\n`, 'utf8');
      const normalized = normalizeOpenAiTranscript(raw);
      if (!normalized.text || !normalized.segments.length) throw new Error('ModelVerse ASR 未返回分段时间戳');
      callbacks.onProgress?.(100);
      return normalized;
    } catch (error) {
      if (abortReason === 'cancelled') throw new Error('任务已取消');
      if (abortReason === 'timeout') throw new Error('ModelVerse 云端 ASR 超时');
      throw error;
    } finally {
      clearTimeout(timeout);
      clearInterval(cancelPoll);
    }
  }

  private async transcribeLocally(
    sourceMedia: string,
    audioPath: string,
    rawPrefix: string,
    rawJsonPath: string,
    callbacks: TranscribeCallbacks,
    mediaLabel: string,
  ): Promise<ReturnType<typeof normalizeWhisperTranscript>> {
    if (!existsSync(this.options.bin)) throw new Error(`本机 ASR 程序不存在: ${this.options.bin}`);
    if (!existsSync(this.options.model)) throw new Error(`本机 ASR 模型不存在: ${this.options.model}`);
    callbacks.onEvent?.('asr_local_extract', `正在准备${mediaLabel}的本机 ASR 音频，数字人 GPU 尚未启动`);
    await runProcess(
      this.options.ffmpegBin,
      ['-y', '-v', 'error', '-i', sourceMedia, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', audioPath],
      Math.min(this.options.timeoutMs, 30 * 60 * 1000),
      callbacks,
      '本机 ASR 音频提取',
    );
    callbacks.onEvent?.(
      'asr_local_running',
      this.options.provider === 'modelverse'
        ? this.options.useGpu
          ? `云端不可用，正在使用 Mac Metal 转写${mediaLabel}`
          : `云端不可用，正在使用本机 CPU 转写${mediaLabel}`
        : this.options.useGpu
          ? `正在使用 Mac Metal 转写${mediaLabel}`
          : `正在使用本机 CPU 转写${mediaLabel}`,
    );
    await runProcess(
      this.options.bin,
      [
        '-m',
        this.options.model,
        '-f',
        audioPath,
        '-l',
        this.options.language,
        '-t',
        String(this.options.threads),
        '-oj',
        '-otxt',
        '-pp',
        '-of',
        rawPrefix,
        ...(this.options.useGpu ? [] : ['-ng']),
      ],
      this.options.timeoutMs,
      callbacks,
      '本机 ASR 转写',
      path.dirname(this.options.bin),
    );
    if (!existsSync(rawJsonPath)) throw new Error('本机 ASR 未输出时间戳 JSON');
    try {
      return normalizeWhisperTranscript(JSON.parse(readFileSync(rawJsonPath, 'utf8')));
    } catch {
      throw new Error('本机 ASR 输出不是有效 JSON');
    }
  }
}
