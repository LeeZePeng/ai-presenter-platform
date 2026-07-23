import os from 'node:os';
import path from 'node:path';
import {existsSync} from 'node:fs';

const env = process.env;

const bool = (name: string, fallback: boolean): boolean => {
  const value = env[name];
  if (value === undefined) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
};

const number = (name: string, fallback: number): number => {
  const value = Number(env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const expandHome = (value: string): string =>
  value.startsWith('~/') ? path.join(os.homedir(), value.slice(2)) : path.resolve(value);

const presenterApiUrl = env.AI_PRESENTER_API_URL?.trim() || 'http://106.75.239.93:7860';
const presenterComfyUrl = env.AI_PRESENTER_COMFY_URL?.trim() || 'http://106.75.239.93:8188';
const presenterWorkerCount = Math.min(4, Math.max(1, Math.floor(number('AI_PRESENTER_GPU_WORKERS', 1))));
const dataDir = path.resolve(env.DATA_DIR ?? './data');
const configuredAsrProvider = env.ASR_PROVIDER?.trim().toLowerCase() || 'local';
if (!new Set(['local', 'modelverse']).has(configuredAsrProvider)) {
  throw new Error('ASR_PROVIDER must be local or modelverse');
}
const asrProvider = configuredAsrProvider as 'local' | 'modelverse';
const workerUrl = (base: string, index: number): string => {
  if (index === 0) return base.replace(/\/$/, '');
  const url = new URL(base);
  url.pathname = `${url.pathname.replace(/\/$/, '')}/w${index}`;
  return url.toString().replace(/\/$/, '');
};

export const config = {
  port: number('PORT', 4317),
  host: env.HOST?.trim() || '0.0.0.0',
  dataDir,
  appAccessToken: env.APP_ACCESS_TOKEN?.trim() ?? '',
  adminAccessToken: env.ADMIN_ACCESS_TOKEN?.trim() ?? '',
  sessionCookieSecure: bool('SESSION_COOKIE_SECURE', false),
  maxUploadBytes: number('MAX_UPLOAD_MB', 500) * 1024 * 1024,
  jobsEnabled: bool('JOBS_ENABLED', true),
  mockGpu: bool('MOCK_GPU', true),
  mockCodex: bool('MOCK_CODEX', true),
  pythonBin: env.PYTHON_BIN?.trim() || 'python3',

  compshare: {
    publicKey: env.COMPSHARE_PUBLIC_KEY?.trim() ?? '',
    privateKey: env.COMPSHARE_PRIVATE_KEY?.trim() ?? '',
    instanceId: env.COMPSHARE_INSTANCE_ID?.trim() ?? '',
    region: env.COMPSHARE_REGION?.trim() || 'cn-wlcb',
    zone: env.COMPSHARE_ZONE?.trim() || 'cn-wlcb-01',
    baseUrl: env.COMPSHARE_BASE_URL?.trim() || 'https://api.compshare.cn',
  },

  powerWindowMs: number('POWER_WINDOW_SECONDS', 3600) * 1000,
  powerTickMs: number('POWER_TICK_SECONDS', 15) * 1000,
  gpuStartTimeoutMs: number('GPU_START_TIMEOUT_SECONDS', 1200) * 1000,
  gpuHealthUrl: env.GPU_HEALTH_URL?.trim() ?? '',
  presenterApiUrl,
  presenterComfyUrl,
  presenterWorkers: Array.from({length: presenterWorkerCount}, (_, index) => ({
    server: workerUrl(presenterApiUrl, index),
    comfyServer: workerUrl(presenterComfyUrl, index),
  })),
  remotionRuntimeDir: path.resolve(env.REMOTION_RUNTIME_DIR ?? '/var/lib/ai-presenter/runtime/remotion-4.0.490'),
  remotionSkillPath: path.resolve(
    env.REMOTION_SKILL_PATH ?? '/var/lib/ai-presenter/.codex/skills/remotion-best-practices',
  ),
  remotionBrowserExecutable:
    env.REMOTION_BROWSER_EXECUTABLE?.trim() || '/opt/google/chrome/google-chrome',
  cjkFontPaths: {
    regular:
      env.CJK_FONT_REGULAR_PATH?.trim() ||
      '/var/lib/ai-presenter/runtime/fonts/NotoSansCJKSC-Regular.otf',
    bold:
      env.CJK_FONT_BOLD_PATH?.trim() ||
      '/var/lib/ai-presenter/runtime/fonts/NotoSansCJKSC-Bold.otf',
    black:
      env.CJK_FONT_BLACK_PATH?.trim() ||
      '/var/lib/ai-presenter/runtime/fonts/NotoSansCJKSC-Black.otf',
  },
  asr: {
    provider: asrProvider,
    cloudApiKey: env.ASR_CLOUD_API_KEY?.trim() || env.MODELVERSE_API_KEY?.trim() || '',
    cloudBaseUrl: env.ASR_CLOUD_BASE_URL?.trim() || 'https://api.modelverse.cn/v1',
    cloudModel: env.ASR_CLOUD_MODEL?.trim() || 'whisper-1',
    localFallback: bool('ASR_LOCAL_FALLBACK', true),
    cacheDir: path.resolve(env.ASR_CACHE_DIR?.trim() || path.join(dataDir, 'asr-cache')),
    bin: path.resolve(env.ASR_BIN?.trim() || '/var/lib/ai-presenter/runtime/whisper/whisper-cli'),
    model: path.resolve(env.ASR_MODEL?.trim() || '/var/lib/ai-presenter/runtime/whisper/ggml-small.bin'),
    ffmpegBin: env.FFMPEG_BIN?.trim() || 'ffmpeg',
    useGpu: bool('ASR_USE_GPU', false),
    language: env.ASR_LANGUAGE?.trim() || 'auto',
    threads: Math.max(1, Math.floor(number('ASR_THREADS', Math.min(8, os.cpus().length)))),
    timeoutMs: number('ASR_TIMEOUT_MINUTES', 120) * 60 * 1000,
  },

  youtube: {
    apiKey: env.YOUTUBE_API_KEY?.trim() ?? '',
    bin: env.YTDLP_BIN?.trim() || '/usr/local/bin/yt-dlp',
    ffmpegBin: env.FFMPEG_BIN?.trim() ?? '',
    proxyUrl: env.YOUTUBE_PROXY_URL?.trim() ?? '',
    candidateLimit: Math.min(50, Math.max(20, Math.floor(number('YOUTUBE_SEARCH_CANDIDATE_LIMIT', 50)))),
    expandedCandidateLimit: Math.min(200, Math.max(50, Math.floor(number('YOUTUBE_SEARCH_EXPANDED_LIMIT', 200)))),
    searchTimeoutMs: number('YOUTUBE_SEARCH_TIMEOUT_SECONDS', 45) * 1000,
    importTimeoutMs: number('YOUTUBE_IMPORT_TIMEOUT_MINUTES', 20) * 60 * 1000,
    maxDurationSeconds: number('YOUTUBE_MAX_DURATION_MINUTES', 30) * 60,
  },

  deployment: {
    enabled: bool('DEPLOY_ENABLED', false),
    repoDir: path.resolve(env.DEPLOY_REPO_DIR?.trim() || process.cwd()),
    remote: env.DEPLOY_REMOTE?.trim() || 'origin',
    branch: env.DEPLOY_BRANCH?.trim() || 'main',
    targetDir: path.resolve(env.DEPLOY_TARGET_DIR?.trim() || process.cwd()),
    script: path.resolve(env.DEPLOY_SCRIPT?.trim() || './deploy/deploy-macos.mjs'),
    pnpmBin: env.DEPLOY_PNPM_BIN?.trim() || 'pnpm',
    launchdLabel: env.DEPLOY_LAUNCHD_LABEL?.trim() || 'com.ai-presenter.platform',
    healthUrl: env.DEPLOY_HEALTH_URL?.trim() || `http://127.0.0.1:${number('PORT', 4317)}/api/health`,
    healthTimeoutMs: number('DEPLOY_HEALTH_TIMEOUT_SECONDS', 90) * 1000,
    stateFile: path.join(dataDir, 'deployment-state.json'),
    logFile: path.join(dataDir, 'deployment.log'),
  },

  codex: {
    bin: env.CODEX_BIN?.trim() || 'codex',
    model: env.CODEX_MODEL?.trim() || 'gpt-5.6-sol',
    reasoningEffort: env.CODEX_REASONING_EFFORT?.trim() || 'xhigh',
    modelProvider: env.CODEX_MODEL_PROVIDER?.trim() ?? '',
    profile: env.CODEX_PROFILE?.trim() ?? '',
    proxyUrl: env.CODEX_PROXY_URL?.trim() ?? '',
    proxyControllerUrl: env.CODEX_PROXY_CONTROLLER_URL?.trim() ?? '',
    proxyConfigPath:
      env.CODEX_PROXY_CONFIG_PATH?.trim() || '/etc/mihomo-ai-presenter/config.json',
    proxyGroup: env.CODEX_PROXY_GROUP?.trim() || 'CODEX',
    proxyProbeUrl:
      env.CODEX_PROXY_PROBE_URL?.trim() ||
      'https://chatgpt.com/backend-api/codex/models?client_version=0.144.4',
    proxyProbeTimeoutMs: number('CODEX_PROXY_PROBE_TIMEOUT_SECONDS', 10) * 1000,
    sandbox: env.CODEX_SANDBOX_MODE?.trim() || 'workspace-write',
    ephemeral: bool('CODEX_EPHEMERAL', false),
    timeoutMs: number('CODEX_TIMEOUT_MINUTES', 180) * 60 * 1000,
    goalMaxMs: number('CODEX_GOAL_MAX_MINUTES', 360) * 60 * 1000,
    skillPath: expandHome(env.AI_PRESENTER_SKILL_PATH?.trim() || '~/.codex/skills/ai-presenter-video-replica'),
  },
} as const;

export const assertProductionConfiguration = (): void => {
  const productionMode = !config.mockGpu || !config.mockCodex;
  if (productionMode) {
    const missingTokens = Object.entries({
      APP_ACCESS_TOKEN: config.appAccessToken,
      ADMIN_ACCESS_TOKEN: config.adminAccessToken,
    })
      .filter(([, value]) => !value)
      .map(([name]) => name);
    if (missingTokens.length) {
      throw new Error(`Production mode requires: ${missingTokens.join(', ')}`);
    }
    if (config.appAccessToken === config.adminAccessToken) {
      throw new Error('APP_ACCESS_TOKEN and ADMIN_ACCESS_TOKEN must be different');
    }
  }
  if (config.jobsEnabled && !config.mockGpu && config.mockCodex) {
    throw new Error('Refusing to enable real GPU jobs while MOCK_CODEX=true');
  }
  if (!new Set(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']).has(config.codex.reasoningEffort)) {
    throw new Error('CODEX_REASONING_EFFORT must be low, medium, high, xhigh, max, or ultra');
  }
  if (!config.mockGpu) {
    const missing = Object.entries({
      COMPSHARE_PUBLIC_KEY: config.compshare.publicKey,
      COMPSHARE_PRIVATE_KEY: config.compshare.privateKey,
      COMPSHARE_INSTANCE_ID: config.compshare.instanceId,
    })
      .filter(([, value]) => !value)
      .map(([name]) => name);
    if (missing.length) {
      throw new Error(`Real GPU mode requires: ${missing.join(', ')}`);
    }
    const missingRuntime = Object.entries({
      PYTHON_BIN: config.pythonBin,
      REMOTION_RUNTIME_DIR: config.remotionRuntimeDir,
      REMOTION_SKILL_PATH: config.remotionSkillPath,
      REMOTION_BROWSER_EXECUTABLE: config.remotionBrowserExecutable,
      CJK_FONT_REGULAR_PATH: config.cjkFontPaths.regular,
      CJK_FONT_BOLD_PATH: config.cjkFontPaths.bold,
      CJK_FONT_BLACK_PATH: config.cjkFontPaths.black,
    })
      .filter(([, value]) => !value)
      .map(([name]) => name);
    if (missingRuntime.length) throw new Error(`Real GPU mode requires: ${missingRuntime.join(', ')}`);
    const missingFiles = Object.entries({
      PYTHON_BIN: config.pythonBin,
      ASR_BIN: config.asr.bin,
      ASR_MODEL: config.asr.model,
      FFMPEG_BIN: config.asr.ffmpegBin,
      REMOTION_BROWSER_EXECUTABLE: config.remotionBrowserExecutable,
      REMOTION_CLI: path.join(config.remotionRuntimeDir, 'node_modules', '.bin', 'remotion'),
      YTDLP_BIN: config.youtube.bin,
      AI_PRESENTER_SKILL: path.join(config.codex.skillPath, 'SKILL.md'),
      REMOTION_SKILL: path.join(config.remotionSkillPath, 'SKILL.md'),
      INFINITE_TALK_SCRIPT: path.join(config.codex.skillPath, 'scripts', 'infinite_talk_api.py'),
      LONG_FORM_TTS_SCRIPT: path.join(config.codex.skillPath, 'scripts', 'long_form_tts.py'),
      NARRATION_TIMELINE_SCRIPT: path.join(config.codex.skillPath, 'scripts', 'transcribe_timeline.py'),
      VISUAL_PREFLIGHT_SCRIPT: path.join(config.codex.skillPath, 'scripts', 'validate_visual_preflight.py'),
    }).filter(([, filename]) => path.isAbsolute(filename) && !existsSync(filename));
    if (missingFiles.length) {
      throw new Error(
        `Production runtime files are missing: ${missingFiles.map(([name, filename]) => `${name}=${filename}`).join(', ')}`,
      );
    }
    for (const [weight, filename] of Object.entries(config.cjkFontPaths)) {
      if (!existsSync(filename)) throw new Error(`Remotion CJK ${weight} font is missing: ${filename}`);
    }
  }
};
