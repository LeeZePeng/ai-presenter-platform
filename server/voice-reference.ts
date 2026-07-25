import {spawn} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync} from 'node:fs';
import path from 'node:path';

export const voiceReferenceFilter = [
  'highpass=f=70',
  'lowpass=f=14000',
  'afftdn=nr=10:nf=-45:tn=1',
  'silenceremove=start_periods=1:start_duration=0.03:start_threshold=-48dB:start_silence=0.04',
  'areverse',
  'silenceremove=start_periods=1:start_duration=0.08:start_threshold=-48dB:start_silence=0.08',
  'areverse',
  'loudnorm=I=-20:TP=-3:LRA=7',
].join(',');

export type PreparedVoiceReference = {
  audioPath: string;
  manifestPath: string;
  sourceSha256: string;
  audioSha256: string;
  durationSeconds: number;
  reused: boolean;
};

type PrepareVoiceReferenceOptions = {
  ffmpegBin: string;
  ffprobeBin: string;
  isCancelled?: () => boolean;
};

const sha256File = (filename: string): string =>
  createHash('sha256').update(readFileSync(filename)).digest('hex');

const runProcess = async (bin: string, args: string[], isCancelled: () => boolean): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(bin, args, {stdio: ['ignore', 'ignore', 'pipe']});
    let stderr = '';
    let settled = false;
    const finish = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearInterval(cancelPoll);
      if (error) reject(error);
      else resolve();
    };
    const cancelPoll = setInterval(() => {
      if (!isCancelled()) return;
      child.kill('SIGTERM');
      finish(new Error('任务已取消'));
    }, 250);
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-4000);
    });
    child.on('error', (error) => finish(new Error(`参考音色清理无法启动: ${error.message}`)));
    child.on('exit', (code, signal) => {
      if (settled) return;
      if (code === 0) finish();
      else finish(new Error(`参考音色清理失败 (${signal ?? code ?? 'unknown'}): ${stderr.trim().slice(-1600)}`));
    });
  });
};

const probeDuration = async (filename: string, ffprobeBin: string): Promise<number> => {
  let stdout = '';
  let stderr = '';
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      ffprobeBin,
      ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', filename],
      {stdio: ['ignore', 'pipe', 'pipe']},
    );
    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      stderr = (stderr + chunk.toString('utf8')).slice(-1000);
    });
    child.on('error', reject);
    child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`无法读取参考音色时长: ${stderr.trim()}`)));
  });
  const duration = Number(stdout.trim());
  if (!Number.isFinite(duration) || duration < 3 || duration > 30) {
    throw new Error(`清理后的参考音色需要 3-30 秒，当前为 ${Number.isFinite(duration) ? duration.toFixed(2) : '未知'} 秒`);
  }
  return duration;
};

export const prepareVoiceReference = async (
  sourcePath: string,
  workspace: string,
  options: PrepareVoiceReferenceOptions,
): Promise<PreparedVoiceReference> => {
  if (!existsSync(sourcePath) || statSync(sourcePath).size <= 1024) throw new Error('缺少有效参考音色');
  const outputDir = path.join(workspace, 'out', 'audio');
  const audioPath = path.join(outputDir, 'voice_reference_clean.wav');
  const manifestPath = path.join(outputDir, 'voice_reference_manifest.json');
  const sourceSha256 = sha256File(sourcePath);
  mkdirSync(outputDir, {recursive: true});

  if (existsSync(audioPath) && existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
      if (
        manifest.version === 1 &&
        manifest.sourceSha256 === sourceSha256 &&
        manifest.filter === voiceReferenceFilter &&
        statSync(audioPath).size > 1024 &&
        manifest.audioSha256 === sha256File(audioPath)
      ) {
        return {
          audioPath,
          manifestPath,
          sourceSha256,
          audioSha256: String(manifest.audioSha256),
          durationSeconds: Number(manifest.durationSeconds),
          reused: true,
        };
      }
    } catch {
      // Replace incomplete or stale preprocessing outputs.
    }
  }

  const temporaryPath = `${audioPath}.${process.pid}.${Date.now()}.tmp.wav`;
  rmSync(temporaryPath, {force: true});
  await runProcess(
    options.ffmpegBin,
    [
      '-y',
      '-v',
      'error',
      '-i',
      sourcePath,
      '-vn',
      '-af',
      voiceReferenceFilter,
      '-ac',
      '1',
      '-ar',
      '24000',
      '-c:a',
      'pcm_s16le',
      temporaryPath,
    ],
    options.isCancelled ?? (() => false),
  );
  try {
    const durationSeconds = await probeDuration(temporaryPath, options.ffprobeBin);
    const audioSha256 = sha256File(temporaryPath);
    renameSync(temporaryPath, audioPath);
    writeFileSync(
      manifestPath,
      `${JSON.stringify({
        version: 1,
        sourcePath,
        sourceSha256,
        audioPath,
        audioSha256,
        durationSeconds: Number(durationSeconds.toFixed(6)),
        sampleRate: 24000,
        channels: 1,
        filter: voiceReferenceFilter,
        generatedAt: new Date().toISOString(),
      }, null, 2)}\n`,
      {encoding: 'utf8', mode: 0o600},
    );
    return {audioPath, manifestPath, sourceSha256, audioSha256, durationSeconds, reused: false};
  } finally {
    rmSync(temporaryPath, {force: true});
  }
};
