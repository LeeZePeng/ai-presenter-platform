import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createReadStream, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
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
  bin: string;
  model: string;
  language: string;
  threads: number;
  timeoutMs: number;
};

type TranscribeCallbacks = {
  isCancelled: () => boolean;
  onEvent?: (kind: string, message: string, data?: Record<string, unknown>) => void;
  onProgress?: (percent: number) => void;
};

type WhisperSegment = {
  timestamps?: {from?: unknown; to?: unknown};
  offsets?: {from?: unknown; to?: unknown};
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

export class SourceTranscriber {
  constructor(private readonly options: SourceTranscriberOptions) {}

  async transcribe(
    sourceVideo: string,
    workspace: string,
    callbacks: TranscribeCallbacks,
  ): Promise<SourceTranscriptResult> {
    if (!existsSync(sourceVideo) || statSync(sourceVideo).size <= 1024) throw new Error('复刻任务缺少有效参考视频');
    if (!existsSync(this.options.bin)) throw new Error(`云端 ASR 程序不存在: ${this.options.bin}`);
    if (!existsSync(this.options.model)) throw new Error(`云端 ASR 模型不存在: ${this.options.model}`);

    const analysisDir = path.join(workspace, 'out', 'analysis');
    const transcriptPath = path.join(analysisDir, 'source_transcript.json');
    const transcriptTextPath = path.join(analysisDir, 'source_transcript.txt');
    const rawPrefix = path.join(analysisDir, 'source_transcript.raw');
    const rawJsonPath = `${rawPrefix}.json`;
    const extractedAudioPath = path.join(analysisDir, 'source_audio_16k.wav');
    mkdirSync(analysisDir, {recursive: true});

    callbacks.onEvent?.('asr_fingerprint', '正在校验参考视频并准备云端转写');
    const sourceSha256 = await sha256File(sourceVideo);
    if (existsSync(transcriptPath)) {
      try {
        const cached = JSON.parse(readFileSync(transcriptPath, 'utf8')) as SourceTranscript;
        if (cached.sourceSha256 === sourceSha256 && cached.text?.trim() && cached.segments?.length) {
          callbacks.onEvent?.('asr_reused', '已复用该任务的可靠原片转写', {
            language: cached.language,
            segments: cached.segments.length,
          });
          return {path: transcriptPath, sha256: createHash('sha256').update(readFileSync(transcriptPath)).digest('hex')};
        }
      } catch {
        // Invalid partial output is replaced below.
      }
    }

    rmSync(transcriptPath, {force: true});
    rmSync(transcriptTextPath, {force: true});
    rmSync(rawJsonPath, {force: true});
    rmSync(`${rawPrefix}.txt`, {force: true});
    rmSync(extractedAudioPath, {force: true});

    callbacks.onEvent?.('asr_extract', '正在提取原片音频，GPU 尚未启动');
    await runProcess(
      'ffmpeg',
      ['-y', '-v', 'error', '-i', sourceVideo, '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', extractedAudioPath],
      Math.min(this.options.timeoutMs, 30 * 60 * 1000),
      callbacks,
      '原片音频提取',
    );

    callbacks.onEvent?.('asr_running', '正在使用云端 ASR 转写原片，GPU 尚未启动');
    await runProcess(
      this.options.bin,
      [
        '-m',
        this.options.model,
        '-f',
        extractedAudioPath,
        '-l',
        this.options.language,
        '-t',
        String(this.options.threads),
        '-oj',
        '-otxt',
        '-pp',
        '-of',
        rawPrefix,
      ],
      this.options.timeoutMs,
      callbacks,
      '云端 ASR 转写',
      path.dirname(this.options.bin),
    );
    if (!existsSync(rawJsonPath)) throw new Error('云端 ASR 未输出时间戳 JSON');

    let normalized: ReturnType<typeof normalizeWhisperTranscript>;
    try {
      normalized = normalizeWhisperTranscript(JSON.parse(readFileSync(rawJsonPath, 'utf8')));
    } catch {
      throw new Error('云端 ASR 输出不是有效 JSON');
    }
    if (normalized.text.length < 20 || normalized.segments.length === 0) {
      throw new Error('云端 ASR 未识别出足够的原片口播内容');
    }
    const durationSeconds = normalized.segments.at(-1)?.endSeconds ?? 0;
    const transcript: SourceTranscript = {
      version: 1,
      sourceSha256,
      sourceSizeBytes: statSync(sourceVideo).size,
      durationSeconds,
      language: normalized.language,
      model: path.basename(this.options.model),
      text: normalized.text,
      segments: normalized.segments,
      generatedAt: new Date().toISOString(),
    };
    writeFileSync(transcriptPath, `${JSON.stringify(transcript, null, 2)}\n`, 'utf8');
    writeFileSync(
      transcriptTextPath,
      `${normalized.segments
        .map((segment) => `[${segment.startSeconds.toFixed(3)} --> ${segment.endSeconds.toFixed(3)}] ${segment.text}`)
        .join('\n')}\n`,
      'utf8',
    );
    rmSync(extractedAudioPath, {force: true});
    callbacks.onEvent?.('asr_completed', '原片转写完成，准备唤醒 GPU', {
      language: normalized.language,
      segments: normalized.segments.length,
      transcriptPath,
    });
    return {path: transcriptPath, sha256: createHash('sha256').update(readFileSync(transcriptPath)).digest('hex')};
  }
}
