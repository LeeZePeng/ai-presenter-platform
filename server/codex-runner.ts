import {spawn, spawnSync, type ChildProcess} from 'node:child_process';
import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {resolvePresenterLayout} from './presenter-layout.js';
import {DatabaseSync} from 'node:sqlite';
import {selectWorkingUsProxy} from './codex-proxy.js';
import type {JobRecord} from './types.js';

type RunnerOptions = {
  bin: string;
  model: string;
  reasoningEffort: string;
  modelProvider: string;
  profile: string;
  proxyUrl: string;
  proxyControllerUrl: string;
  proxyConfigPath: string;
  proxyGroup: string;
  proxyProbeUrl: string;
  proxyProbeTimeoutMs: number;
  sandbox: string;
  ephemeral: boolean;
  timeoutMs: number;
  goalMaxMs: number;
  skillPath: string;
  mock: boolean;
};

type RunCallbacks = {
  onEvent: (kind: string, message: string, data?: Record<string, unknown>) => void;
  onProgress: (stage: string, progress: number) => void;
  isCancelled: () => boolean;
};

const secretNames = [
  'COMPSHARE_PRIVATE_KEY',
  'COMPSHARE_PUBLIC_KEY',
  'MODELVERSE_API_KEY',
  'HEYGEN_API_KEY',
  'OPENAI_API_KEY',
  'DEEPSEEK_API_KEY',
];

const redact = (text: string): string => {
  let output = text;
  for (const name of secretNames) {
    const value = process.env[name];
    if (value && value.length >= 6) output = output.split(value).join('<redacted>');
  }
  return output.replace(/\b(?:sk|AK|PK)_[A-Za-z0-9_-]{12,}\b/g, '<redacted>');
};

type ResultManifest = {
  outputPath?: unknown;
  presenterProvider?: unknown;
  presenterSourcePath?: unknown;
  infiniteTalkReceiptPath?: unknown;
  presenterSegmentPaths?: unknown;
  presenterRenderPaths?: unknown;
  infiniteTalkReceiptPaths?: unknown;
  durationSeconds?: unknown;
  compositionRenderer?: unknown;
  remotionEntryPath?: unknown;
  remotionVisualPath?: unknown;
  visualDesignPath?: unknown;
  visualReviewPath?: unknown;
  finalReviewMontagePath?: unknown;
  sourceReviewMontagePath?: unknown;
  sourceReviewFramePaths?: unknown;
  sourceEvidenceReviewFramePaths?: unknown;
  preflightReportPath?: unknown;
  sceneContractReportPath?: unknown;
  narrationPath?: unknown;
  narrationSha256?: unknown;
  narrationScriptPath?: unknown;
  ttsScriptPath?: unknown;
  pronunciationLexiconPath?: unknown;
  pronunciationPreviewPath?: unknown;
  pronunciationReviewPath?: unknown;
  sourceAnalysisPath?: unknown;
  sourceTranscriptPath?: unknown;
  narrationTimelinePath?: unknown;
  captionTimelinePath?: unknown;
  narrationVisualMapPath?: unknown;
  sceneImplementationPath?: unknown;
  cueReviewMontagePath?: unknown;
  cueReviewFramePaths?: unknown;
  motionReviewFramePaths?: unknown;
  collisionReviewFramePaths?: unknown;
  coverPath?: unknown;
  marketingTitle?: unknown;
  marketingDescription?: unknown;
};

type VisualReview = {
  approved: boolean;
  score: number;
  coverApproved: boolean;
  coverScore: number;
  coverIssues: string[];
  fatalIssues: string[];
  issues: string[];
  strengths: string[];
  requiredFixes: string[];
};

export const validateVisualReview = (value: unknown): VisualReview => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('独立视觉审查结果无效');
  const review = value as Record<string, unknown>;
  const score = Number(review.score);
  const stringArray = (key: string): string[] => {
    const entries = review[key];
    if (!Array.isArray(entries) || entries.some((entry) => typeof entry !== 'string')) {
      throw new Error(`独立视觉审查缺少 ${key}`);
    }
    return entries.map(String);
  };
  if (typeof review.approved !== 'boolean' || !Number.isInteger(score) || score < 0 || score > 100) {
    throw new Error('独立视觉审查缺少有效结论或分数');
  }
  const coverScore = Number(review.coverScore);
  if (
    typeof review.coverApproved !== 'boolean' ||
    !Number.isInteger(coverScore) ||
    coverScore < 0 ||
    coverScore > 100
  ) {
    throw new Error('独立视觉审查缺少封面结论或分数');
  }
  return {
    approved: review.approved,
    score,
    coverApproved: review.coverApproved,
    coverScore,
    coverIssues: stringArray('coverIssues'),
    fatalIssues: stringArray('fatalIssues'),
    issues: stringArray('issues'),
    strengths: stringArray('strengths'),
    requiredFixes: stringArray('requiredFixes'),
  };
};

const collectRemotionSources = (directory: string): string[] => {
  const files: string[] = [];
  for (const entry of readdirSync(directory, {withFileTypes: true})) {
    const filename = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...collectRemotionSources(filename));
    else if (/\.(?:ts|tsx|js|jsx|css|json)$/i.test(entry.name)) files.push(filename);
  }
  return files;
};

const readRemotionSourceText = (entryPath: string): string =>
  collectRemotionSources(path.dirname(entryPath))
    .map((filename) => readFileSync(filename, 'utf8'))
    .join('\n');

export const validateRemotionImplementation = (entryPath: string): void => {
  const source = readRemotionSourceText(entryPath);
  if (/source-cues[\\/]/i.test(source)) {
    throw new Error('Remotion 禁止把原片 cue 截图作为静态全屏背景；请使用 @remotion/media Video、OffthreadVideo 或原生重建场景');
  }
  if (!/\b(?:interpolate|spring)\s*\(/.test(source)) {
    throw new Error('Remotion 主画面缺少基于帧的转场或重点动画');
  }
  if (!/data-presenter-layer\s*=\s*["']infinite-talk["']/.test(source)) {
    throw new Error('Remotion 主画面缺少 InfiniteTalk 数字人层标记');
  }
  if (!/data-cue-index\s*=/.test(source)) {
    throw new Error('Remotion 主画面缺少旁白 cue 场景索引标记');
  }
  if (!/data-caption-layer\s*=\s*["']narration-timeline["']/.test(source)) {
    throw new Error('Remotion 缺少绑定完整旁白时间轴的字幕层；cue 摘要不能代替字幕');
  }
  if (!/data-scene-key\s*=/.test(source)) {
    throw new Error('Remotion 缺少可核验的源片场景实现标记 data-scene-key');
  }
  if (/fontFamily\s*:\s*[`'"][^`'"]*(?:\/usr\/share\/fonts|\.(?:ttc|otf|ttf|woff2?))/i.test(source)) {
    throw new Error('Remotion fontFamily 不能使用字体文件路径；必须加载并使用真实中文字体 family');
  }
  const usesRemotionFontLoader =
    /from\s*[`'"]@remotion\/fonts[`'"]/.test(source) && /\bloadFont\s*\(/.test(source);
  const usesLocalFontFaces = /@font-face\s*\{[^}]*font-family\s*:\s*['"]?Presenter Noto Sans SC/i.test(source);
  if (!usesRemotionFontLoader && !usesLocalFontFaces) {
    throw new Error('Remotion 必须使用 @remotion/fonts 或项目内 @font-face 显式加载中文字体');
  }
  for (const [filename, weight] of [
    ['NotoSansCJKSC-Regular.otf', '400'],
    ['NotoSansCJKSC-Bold.otf', '700'],
    ['NotoSansCJKSC-Black.otf', '900'],
  ] as const) {
    const weightPattern = usesRemotionFontLoader
      ? new RegExp(`weight\\s*:\\s*['\"]${weight}['\"]`)
      : new RegExp(`font-weight\\s*:\\s*${weight}\\b`);
    if (!source.includes(filename) || !weightPattern.test(source)) {
      throw new Error(`Remotion 缺少 Noto Sans CJK SC ${weight} 字重的显式加载`);
    }
  }
  if (!source.includes('Presenter Noto Sans SC') || !/fontFamily\s*:/.test(source)) {
    throw new Error('Remotion 未使用已加载的 Presenter Noto Sans SC 字体 family');
  }
  for (const match of source.matchAll(/\bletterSpacing\s*:\s*([^,}\n]+)/g)) {
    if (!/^(?:['"]?0(?:px)?['"]?)$/.test(match[1].trim())) {
      throw new Error('Remotion 文字 letterSpacing 必须为 0，避免中文排版松散变形');
    }
  }
  if (/\bfontWeight\s*:\s*(?:['"])?(?:9[1-9]\d|1000)(?:['"])?\b/.test(source)) {
    throw new Error('Remotion 使用了未加载的伪字重；中文字体仅允许 400、700、900');
  }
  let publicFontDirectory: string | null = null;
  let cursor = path.dirname(entryPath);
  for (let depth = 0; depth < 4; depth += 1) {
    const candidate = path.join(cursor, 'public', 'fonts');
    if (existsSync(candidate)) {
      publicFontDirectory = candidate;
      break;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  if (!publicFontDirectory) throw new Error('Remotion 项目缺少 public/fonts 中文字体资产目录');
  for (const filename of [
    'NotoSansCJKSC-Regular.otf',
    'NotoSansCJKSC-Bold.otf',
    'NotoSansCJKSC-Black.otf',
  ]) {
    const asset = path.join(publicFontDirectory, filename);
    if (!existsSync(asset) || statSync(asset).size <= 1024) {
      throw new Error(`Remotion 中文字体资产缺失或无效: ${filename}`);
    }
  }
  if (
    !/<(?:OffthreadVideo|Video)\b[\s\S]{0,800}presenter[\\/]render[\\/]|presenter[\\/]render[\\/][\s\S]{0,800}<(?:OffthreadVideo|Video)\b/i.test(
      source,
    )
  ) {
    throw new Error('InfiniteTalk 数字人必须在 Remotion 内等比裁切合成');
  }
};

export const validateRemotionQualityBinding = (
  entryPath: string,
  captionTimeline: CaptionTimeline,
  sceneImplementation?: SceneImplementation,
): void => {
  const source = readRemotionSourceText(entryPath);
  if (contentOverlapRatio(captionTimeline.text, source) < 0.9) {
    throw new Error('Remotion 源码没有绑定完整 caption_timeline；禁止只渲染 cue 摘要');
  }
  if (!sceneImplementation) return;
  if (/\b(?:const|function)\s+SceneSignature\b|<SceneSignature\b/.test(source)) {
    throw new Error('Remotion 检测到全片通用 SceneSignature 大型装饰层；请删除并仅保留不穿过主内容的源片依据装饰');
  }
  if (/\b(?:const|function)\s+PhraseFocus\b|<PhraseFocus\b/.test(source)) {
    throw new Error('Remotion 检测到全片通用 PhraseFocus 焦点叠层；请用主内容自身的高亮/重排替代，禁止焦点环、扫光或网格覆盖 UI');
  }
  if (!/data-layout-role\s*=\s*["']primary["']/.test(source)) {
    throw new Error('Remotion 主内容节点缺少 data-layout-role="primary"，布局清单尚未绑定真实 JSX');
  }
  if (/bottom\s*:\s*(?:1[4-9]\d|2\d\d)[^}\n]*\}[^\n]{0,240}\{title\}/.test(source)) {
    throw new Error('完整字幕之外仍存在底部 cue 摘要标题；请删除重复文本层，避免与人物和字幕堆叠');
  }
  for (const cue of sceneImplementation.cues) {
    if (!source.includes(cue.sceneKey)) {
      throw new Error(`Remotion 源码缺少场景实现 ${cue.sceneKey}`);
    }
  }
  if (sceneImplementation.cues.some((cue) => cue.sourceVideoEvidence)) {
    for (const attribute of [
      'data-source-evidence-layer',
      'data-source-content-bounds',
      'data-source-cleanup-strategy',
      'data-source-evidence-subject',
    ]) {
      if (!source.includes(attribute)) throw new Error(`Remotion 原片证据层缺少 ${attribute} 绑定`);
    }
  }
};

const engagementBaitClosingPattern =
  /(?:点赞|点个赞|关注|收藏|转发|评论区|评论告诉我|留言告诉我|扣[个一二三四五六七八九十\d]|双击|一键三连|投币|私信我|@\s*\S+)/iu;
const naturalClosingPattern =
  /(?:下期见|再见|这就是|记住|别等|先.{0,12}(?:做|跑通|开始|行动)|下一步|现在就|从.{0,12}开始|做出|用.{0,12}(?:改进|变好|验证)|最终|最后)/iu;

export const validateNarrationClosing = (text: string): void => {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (normalized.length < 40) throw new Error('口播文案过短，无法形成完整开场和片尾');
  const closing = normalized.slice(-180);
  const bait = closing.match(engagementBaitClosingPattern)?.[0];
  if (bait) throw new Error(`片尾包含互动诱导“${bait}”；禁止用点赞、关注、收藏、评论或转发换互动`);
  if (!naturalClosingPattern.test(closing)) {
    throw new Error('片尾缺少自然收束；最后一段必须回收结论，并给出真实行动、下一步或告别');
  }
  const sentences = closing.split(/[。！？!?]+/u).map((part) => part.trim()).filter(Boolean);
  if (sentences.length < 2) throw new Error('片尾不完整；最后 180 个字符内至少需要两个完整分句');
  if (!/[。！？!?]$/u.test(normalized)) throw new Error('口播文案结尾缺少完整句号或问号');
};

const mixedLanguageTerms = (text: string): string[] => {
  const matches = text.match(/[A-Za-z][A-Za-z0-9]*(?:[ .+_-]+\d+(?:\.\d+)?)?/g) ?? [];
  return [...new Set(matches.map((term) => term.trim()).filter((term) => /[A-Za-z]/.test(term)))];
};

const validatePronunciationArtifacts = (
  workspace: string,
  manifest: ResultManifest,
  canonicalScript: string,
): void => {
  const requiredTerms = mixedLanguageTerms(canonicalScript);
  if (!requiredTerms.length) return;
  const ttsScript = resolveWorkspacePath(workspace, manifest.ttsScriptPath, 'ttsScriptPath');
  const lexiconPath = resolveWorkspacePath(workspace, manifest.pronunciationLexiconPath, 'pronunciationLexiconPath');
  const previewPath = resolveWorkspacePath(workspace, manifest.pronunciationPreviewPath, 'pronunciationPreviewPath');
  const reviewPath = resolveWorkspacePath(workspace, manifest.pronunciationReviewPath, 'pronunciationReviewPath');
  if (!existsSync(ttsScript) || readFileSync(ttsScript, 'utf8').trim().length < 20) {
    throw new Error('含英文/型号的口播缺少独立的 pronunciation-safe TTS 文案');
  }
  if (!existsSync(previewPath) || statSync(previewPath).size <= 1024) {
    throw new Error('含英文/型号的口播缺少真实发音预览音频');
  }
  let rawLexicon: unknown;
  let rawReview: unknown;
  try {
    rawLexicon = JSON.parse(readFileSync(lexiconPath, 'utf8'));
    rawReview = JSON.parse(readFileSync(reviewPath, 'utf8'));
  } catch {
    throw new Error('英文/型号发音词典或发音审查不是有效 JSON');
  }
  const lexiconRoot = rawLexicon && typeof rawLexicon === 'object' && !Array.isArray(rawLexicon)
    ? rawLexicon as Record<string, unknown>
    : {};
  const lexiconTerms = Array.isArray(rawLexicon)
    ? rawLexicon
    : Array.isArray(lexiconRoot.terms)
      ? lexiconRoot.terms
      : [];
  const entries = lexiconTerms
    .filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === 'object' && !Array.isArray(item))
    .map((item) => ({display: String(item.display ?? '').trim(), spoken: String(item.spoken ?? '').trim()}));
  for (const term of requiredTerms) {
    const match = entries.find((entry) => entry.display.toLowerCase() === term.toLowerCase());
    if (!match || match.spoken.length < 1) throw new Error(`发音词典缺少英文/型号词条：${term}`);
  }
  const review = rawReview && typeof rawReview === 'object' && !Array.isArray(rawReview)
    ? rawReview as Record<string, unknown>
    : {};
  const reviewTerms = Array.isArray(review.terms) ? review.terms : [];
  if (review.approved !== true || reviewTerms.length < requiredTerms.length) {
    throw new Error('英文/型号发音预检未通过，禁止复用或交付旁白');
  }
  for (const term of requiredTerms) {
    const match = reviewTerms.find((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
      return String((item as Record<string, unknown>).display ?? '').trim().toLowerCase() === term.toLowerCase();
    }) as Record<string, unknown> | undefined;
    if (!match || match.approved !== true || !String(match.observed ?? '').trim()) {
      throw new Error(`英文/型号“${term}”未通过真实音频发音审查`);
    }
  }
};

const videoStreamSha256 = (mediaPath: string): string => {
  const result = spawnSync(
    'ffmpeg',
    ['-v', 'error', '-i', mediaPath, '-map', '0:v:0', '-c', 'copy', '-f', 'hash', '-hash', 'sha256', '-'],
    {encoding: 'utf8', timeout: 120_000, maxBuffer: 1024 * 1024},
  );
  const match = result.stdout.match(/SHA256=([a-f0-9]{64})/i);
  if (result.status !== 0 || !match) throw new Error(`无法校验视频流: ${path.basename(mediaPath)}`);
  return match[1].toLowerCase();
};

const validateVisualDesign = (filename: string): void => {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(readFileSync(filename, 'utf8')) as Record<string, unknown>;
  } catch {
    throw new Error('视觉设计规范 visual_design.json 无效');
  }
  const textFields = ['sourceStyleSummary', 'presenterTreatment', 'subtitleTreatment', 'motionLanguage'];
  for (const field of textFields) {
    if (typeof value[field] !== 'string' || String(value[field]).trim().length < 8) {
      throw new Error(`视觉设计规范缺少 ${field}`);
    }
  }
  for (const field of ['palette', 'safeRegions', 'sourceSignatures', 'avoid']) {
    if (!Array.isArray(value[field]) || (value[field] as unknown[]).length < 2) {
      throw new Error(`视觉设计规范缺少 ${field}`);
    }
  }
  if (!value.typography || typeof value.typography !== 'object' || Array.isArray(value.typography)) {
    throw new Error('视觉设计规范缺少 typography');
  }
};

const resolveWorkspacePath = (workspace: string, candidate: unknown, label: string): string => {
  if (typeof candidate !== 'string' || !candidate.trim()) throw new Error(`${label} 缺失`);
  const resolved = path.resolve(workspace, candidate);
  const root = path.resolve(workspace) + path.sep;
  if (!resolved.startsWith(root)) throw new Error(`${label} 不在任务工作目录内`);
  return resolved;
};

const fileSha256 = (filename: string): string => createHash('sha256').update(readFileSync(filename)).digest('hex');

const contentTerms = (text: string): Set<string> => {
  const normalized = text.toLowerCase().normalize('NFKC');
  const terms = new Set<string>();
  for (const word of normalized.match(/[a-z0-9][a-z0-9._+-]{2,}/g) ?? []) terms.add(word);
  for (const run of normalized.match(/[\p{Script=Han}]{2,}/gu) ?? []) {
    for (let index = 0; index < run.length - 1; index += 1) terms.add(run.slice(index, index + 2));
  }
  return terms;
};

export const contentOverlapRatio = (candidate: string, source: string): number => {
  const candidateTerms = contentTerms(candidate);
  if (!candidateTerms.size) return 0;
  const sourceTerms = contentTerms(source);
  let matches = 0;
  for (const term of candidateTerms) if (sourceTerms.has(term)) matches += 1;
  return matches / candidateTerms.size;
};

export const validateMarketingCopy = (title: string, description: string): void => {
  if (title.length < 8 || title.length > 40) throw new Error('发布标题长度必须为 8-40 个字符');
  if (description.length < 30 || description.length > 500) {
    throw new Error('发布描述长度必须为 30-500 个字符');
  }
  const productionDisclosure =
    /(?:本视频|本成片|这条视频|该视频).{0,12}(?:由|使用|通过|调用|借助).{0,20}(?:Codex|Remotion|TTS|InfiniteTalk)|(?:复刻|生成|制作)(?:工作)?流程|幕后制作|制作过程/iu;
  if (productionDisclosure.test(`${title}\n${description}`)) {
    throw new Error('发布标题或描述错误地包含制作过程信息');
  }
};

type NarrationTimeline = {
  durationSeconds: number;
  text: string;
  segments: Array<{startSeconds: number; endSeconds: number; text: string}>;
};

export const validateNarrationTimeline = (value: unknown, narrationDuration: number): NarrationTimeline => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('旁白时间轴无效');
  const root = value as Record<string, unknown>;
  const durationSeconds = Number(root.durationSeconds);
  const rawSegments = Array.isArray(root.segments) ? root.segments : [];
  if (!Number.isFinite(durationSeconds) || Math.abs(durationSeconds - narrationDuration) > 2 || !rawSegments.length) {
    throw new Error('旁白时间轴与锁定音频时长不一致');
  }
  const segments = rawSegments.map((item, index) => {
    const segment = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
    const startSeconds = Number(segment.startSeconds);
    const endSeconds = Number(segment.endSeconds);
    const text = typeof segment.text === 'string' ? segment.text.trim() : '';
    if (!Number.isFinite(startSeconds) || !Number.isFinite(endSeconds) || startSeconds < 0 || endSeconds <= startSeconds || !text) {
      throw new Error(`旁白时间轴第 ${index + 1} 段无效`);
    }
    return {startSeconds, endSeconds, text};
  });
  if (segments[0].startSeconds > 1 || segments.at(-1)!.endSeconds < narrationDuration - 2) {
    throw new Error('旁白时间轴没有覆盖完整锁定音频');
  }
  for (let index = 1; index < segments.length; index += 1) {
    if (segments[index].startSeconds < segments[index - 1].startSeconds || segments[index].startSeconds - segments[index - 1].endSeconds > 2) {
      throw new Error('旁白时间轴顺序或覆盖范围无效');
    }
  }
  const text = segments.map((segment) => segment.text).join(' ');
  if (text.length < 20) throw new Error('旁白时间轴文本内容不足');
  return {durationSeconds, text, segments};
};

type CaptionTimeline = {
  segments: Array<{startSeconds: number; endSeconds: number; text: string}>;
  text: string;
};

export const validateCaptionTimeline = (
  value: unknown,
  options: {narrationDuration: number; narrationScript: string},
): CaptionTimeline => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('完整字幕时间轴无效');
  const root = value as Record<string, unknown>;
  const rawSegments = Array.isArray(root.segments) ? root.segments : [];
  const minimumSegments = Math.max(3, Math.floor(options.narrationDuration / 6));
  if (rawSegments.length < minimumSegments) {
    throw new Error(`字幕段数不足 (${rawSegments.length}/${minimumSegments})，禁止用 cue 摘要代替完整旁白字幕`);
  }
  const segments = rawSegments.map((item, index) => {
    const segment = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
    const startSeconds = Number(segment.startSeconds);
    const endSeconds = Number(segment.endSeconds);
    const text = typeof segment.text === 'string' ? segment.text.trim() : '';
    if (
      !Number.isFinite(startSeconds) ||
      !Number.isFinite(endSeconds) ||
      startSeconds < 0 ||
      endSeconds <= startSeconds ||
      endSeconds - startSeconds > 6.05 ||
      text.length < 1
    ) {
      throw new Error(`完整字幕时间轴第 ${index + 1} 段无效或超过 6 秒`);
    }
    return {startSeconds, endSeconds, text};
  });
  if (segments[0].startSeconds > 0.6 || segments.at(-1)!.endSeconds < options.narrationDuration - 0.8) {
    throw new Error('完整字幕没有覆盖旁白开场或结尾');
  }
  for (let index = 1; index < segments.length; index += 1) {
    const gap = segments[index].startSeconds - segments[index - 1].endSeconds;
    if (segments[index].startSeconds < segments[index - 1].startSeconds || gap > 0.6) {
      throw new Error('完整字幕时间轴存在乱序或超过 0.6 秒的空档');
    }
  }
  const text = segments.map((segment) => segment.text).join(' ');
  const captionToScript = contentOverlapRatio(text, options.narrationScript);
  const scriptToCaption = contentOverlapRatio(options.narrationScript, text);
  if (captionToScript < 0.95 || scriptToCaption < 0.95) {
    throw new Error(
      `字幕与最终口播文案覆盖不足 (${captionToScript.toFixed(3)}/${scriptToCaption.toFixed(3)})，必须修正 ASR 并补全字幕`,
    );
  }
  return {segments, text};
};

type NarrationVisualMap = {
  sourceMotionEvidenceInventory?: SourceMotionEvidence[];
  cues: Array<{
    cueIndex: number;
    outputStartSeconds: number;
    outputEndSeconds: number;
    narrationText: string;
    visualType: string;
    sourceStartSeconds: number;
    sourceEndSeconds: number;
    sourceText: string;
    sourceSceneDescription: string;
    replicationPlan: string;
    semanticInventories: SemanticInventory[];
    sourceVideoEvidence?: SourceVideoEvidence;
  }>;
};

type SourceMotionEvidence = {
  sourceStartSeconds: number;
  sourceEndSeconds: number;
  kind: string;
  description: string;
  eligible: boolean;
  mappedCueIndices: number[];
  exclusionReason?: string;
};

type SourceVideoEvidence = {
  evidenceSubject: string;
  sourceContentBounds: [number, number, number, number];
  hasBakedSubtitles: boolean;
  hasSourceWatermark: boolean;
  sourceSubtitleBounds?: [number, number, number, number];
  sourceWatermarkBounds?: [number, number, number, number];
  cleanupStrategy: 'clean-interval' | 'crop' | 'native-rebuild';
};

type SemanticInventory = {
  label: string;
  count: number;
  items: string[];
  sourceEvidence: string;
  presentationMode: 'list' | 'count-only';
  unavailableReason?: string;
};

type LayoutRegion = {
  id: string;
  role: 'primary' | 'secondary' | 'caption' | 'presenter' | 'decoration' | 'chrome' | 'summary';
  bounds: [number, number, number, number];
  maxOpacity?: number;
  sourceEvidence?: string;
};

type SceneImplementation = {
  cues: Array<{
    cueIndex: number;
    sceneKey: string;
    implementedElements: string[];
    motionEvents: string[];
    semanticLists: Array<Pick<SemanticInventory, 'label' | 'items' | 'presentationMode'>>;
    layoutRegions: LayoutRegion[];
    sourceVideoEvidence?: SourceVideoEvidence;
  }>;
};

const semanticCountPattern = /(?<!第)(\d+|[一二两三四五六七八九十]+)\s*(?:个)?(模块|件事|块积木|种(?:常见)?(?:设计)?模式|级台阶|(?:执行)?步(?:骤)?|条(?:建议|原则|结论|方法|规则|行动)|项(?:任务|要求|检查|行动)|个(?:阶段|环节|问题|要点|能力|部分|组件))/gu;
const placeholderListPattern = /(?:\bM\s*\d+\s*[-–—~至到]\s*M?\s*\d+\b|\b(?:M|Item|Card|Module)\s*\d+\b|(?:模块|卡片|节点|要点|项目)\s*[一二三四五六七八九十\d]+(?:\s|$|[、，,；;]))/iu;
const repeatedUiPattern = /标签|卡片|列表|逐(?:项|个|格)|矩阵|网格|节点/u;

const parseSemanticCount = (value: string): number | null => {
  if (/^\d+$/.test(value)) return Number(value);
  const digits: Record<string, number> = {一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10};
  if (digits[value]) return digits[value];
  if (value.startsWith('十') && value.length === 2) return 10 + (digits[value[1]] ?? 0);
  if (value.endsWith('十') && value.length === 2) return (digits[value[0]] ?? 0) * 10;
  const parts = value.split('十');
  if (parts.length === 2 && parts[0] && parts[1]) return (digits[parts[0]] ?? 0) * 10 + (digits[parts[1]] ?? 0);
  return null;
};

const detectSemanticCounts = (text: string): number[] => {
  const counts: number[] = [];
  for (const match of text.matchAll(semanticCountPattern)) {
    const count = parseSemanticCount(match[1]);
    if (count !== null && count >= 2 && count <= 30) counts.push(count);
  }
  return counts;
};

const parseLayoutRegion = (value: unknown, cueIndex: number, index: number): LayoutRegion => {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  const id = typeof raw.id === 'string' ? raw.id.trim() : `region-${index}`;
  const allowedRoles = new Set(['primary', 'secondary', 'caption', 'presenter', 'decoration', 'chrome', 'summary']);
  const role = typeof raw.role === 'string' ? raw.role : '';
  const bounds = Array.isArray(raw.bounds) ? raw.bounds.map(Number) : [];
  if (!allowedRoles.has(role) || bounds.length !== 4 || bounds.some((item) => !Number.isFinite(item))) {
    throw new Error(`第 ${cueIndex + 1} 个 cue 的布局区域 ${id} 无效`);
  }
  const [x, y, width, height] = bounds;
  if (x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1.0001 || y + height > 1.0001) {
    throw new Error(`第 ${cueIndex + 1} 个 cue 的布局区域 ${id} 超出画布`);
  }
  return {
    id,
    role: role as LayoutRegion['role'],
    bounds: [x, y, width, height],
    maxOpacity: raw.maxOpacity === undefined ? undefined : Number(raw.maxOpacity),
    sourceEvidence: typeof raw.sourceEvidence === 'string' ? raw.sourceEvidence.trim() : undefined,
  };
};

const layoutIntersectionRatio = (left: LayoutRegion['bounds'], right: LayoutRegion['bounds']): number => {
  const overlapWidth = Math.max(0, Math.min(left[0] + left[2], right[0] + right[2]) - Math.max(left[0], right[0]));
  const overlapHeight = Math.max(0, Math.min(left[1] + left[3], right[1] + right[3]) - Math.max(left[1], right[1]));
  const overlap = overlapWidth * overlapHeight;
  return overlap ? overlap / Math.min(left[2] * left[3], right[2] * right[3]) : 0;
};

const parseNormalizedRect = (value: unknown, label: string): [number, number, number, number] => {
  const bounds = Array.isArray(value) ? value.map(Number) : [];
  if (bounds.length !== 4 || bounds.some((item) => !Number.isFinite(item))) {
    throw new Error(`${label} 必须是归一化 [x,y,width,height]`);
  }
  const [x, y, width, height] = bounds;
  if (x < 0 || y < 0 || width <= 0 || height <= 0 || x + width > 1.0001 || y + height > 1.0001) {
    throw new Error(`${label} 超出原片画面`);
  }
  return [x, y, width, height];
};

const parseSourceVideoEvidence = (value: unknown, cueIndex: number): SourceVideoEvidence => {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const evidenceSubject = typeof raw.evidenceSubject === 'string' ? raw.evidenceSubject.trim() : '';
  const cleanupStrategy = raw.cleanupStrategy;
  if (evidenceSubject.length < 2) throw new Error(`第 ${cueIndex + 1} 个原片证据 cue 缺少 evidenceSubject`);
  if (!['clean-interval', 'crop', 'native-rebuild'].includes(String(cleanupStrategy))) {
    throw new Error(`第 ${cueIndex + 1} 个原片证据 cue 缺少有效 cleanupStrategy`);
  }
  if (typeof raw.hasBakedSubtitles !== 'boolean' || typeof raw.hasSourceWatermark !== 'boolean') {
    throw new Error(`第 ${cueIndex + 1} 个原片证据 cue 必须声明旧字幕和水印检测结果`);
  }
  const sourceContentBounds = parseNormalizedRect(raw.sourceContentBounds, `第 ${cueIndex + 1} 个 sourceContentBounds`);
  const sourceSubtitleBounds = raw.sourceSubtitleBounds === undefined
    ? undefined
    : parseNormalizedRect(raw.sourceSubtitleBounds, `第 ${cueIndex + 1} 个 sourceSubtitleBounds`);
  const sourceWatermarkBounds = raw.sourceWatermarkBounds === undefined
    ? undefined
    : parseNormalizedRect(raw.sourceWatermarkBounds, `第 ${cueIndex + 1} 个 sourceWatermarkBounds`);
  if (raw.hasBakedSubtitles && !sourceSubtitleBounds) {
    throw new Error(`第 ${cueIndex + 1} 个原片证据检测到旧字幕但没有 sourceSubtitleBounds`);
  }
  if (raw.hasSourceWatermark && !sourceWatermarkBounds) {
    throw new Error(`第 ${cueIndex + 1} 个原片证据检测到水印但没有 sourceWatermarkBounds`);
  }
  if (cleanupStrategy === 'crop') {
    if (sourceSubtitleBounds && layoutIntersectionRatio(sourceContentBounds, sourceSubtitleBounds) > 0.001) {
      throw new Error(`第 ${cueIndex + 1} 个原片证据 crop 后仍包含旧字幕`);
    }
    if (sourceWatermarkBounds && layoutIntersectionRatio(sourceContentBounds, sourceWatermarkBounds) > 0.001) {
      throw new Error(`第 ${cueIndex + 1} 个原片证据 crop 后仍包含水印`);
    }
  }
  return {
    evidenceSubject,
    sourceContentBounds,
    hasBakedSubtitles: raw.hasBakedSubtitles,
    hasSourceWatermark: raw.hasSourceWatermark,
    sourceSubtitleBounds,
    sourceWatermarkBounds,
    cleanupStrategy: cleanupStrategy as SourceVideoEvidence['cleanupStrategy'],
  };
};

export const validateSceneImplementation = (
  value: unknown,
  visualMap: NarrationVisualMap,
): SceneImplementation => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('场景实现清单无效');
  const root = value as Record<string, unknown>;
  const rawCues = Array.isArray(root.cues) ? root.cues : [];
  if (rawCues.length !== visualMap.cues.length) {
    throw new Error(`场景实现清单没有逐 cue 覆盖 (${rawCues.length}/${visualMap.cues.length})`);
  }
  const cues = rawCues.map((item, index) => {
    const raw = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
    const cueIndex = Number(raw.cueIndex);
    const sceneKey = typeof raw.sceneKey === 'string' ? raw.sceneKey.trim() : '';
    const implementedElements = Array.isArray(raw.implementedElements)
      ? raw.implementedElements.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length >= 2)
      : [];
    const motionEvents = Array.isArray(raw.motionEvents)
      ? raw.motionEvents
          .map((entry) =>
            typeof entry === 'string'
              ? entry.trim()
              : entry && typeof entry === 'object' && typeof (entry as Record<string, unknown>).description === 'string'
                ? String((entry as Record<string, unknown>).description).trim()
                : '',
          )
          .filter((entry) => entry.length >= 2)
      : [];
    const cueDuration = visualMap.cues[index].outputEndSeconds - visualMap.cues[index].outputStartSeconds;
    const minimumMotionEvents = cueDuration > 4 ? 2 : 1;
    if (
      cueIndex !== visualMap.cues[index].cueIndex ||
      sceneKey.length < 3 ||
      implementedElements.length < 2 ||
      motionEvents.length < minimumMotionEvents
    ) {
      throw new Error(`第 ${index + 1} 个 cue 缺少具体场景、视觉元素或短语驱动动效实现`);
    }
    if (placeholderListPattern.test(implementedElements.join(' '))) {
      throw new Error(`第 ${index + 1} 个 cue 使用了 M1-M5、空模块卡或其他占位列举`);
    }
    const rawSemanticLists = Array.isArray(raw.semanticLists) ? raw.semanticLists : [];
    const semanticLists = rawSemanticLists.map((entry) => {
      const list = entry && typeof entry === 'object' && !Array.isArray(entry) ? (entry as Record<string, unknown>) : {};
      return {
        label: typeof list.label === 'string' ? list.label.trim() : '',
        items: Array.isArray(list.items) ? list.items.map(String) : [],
        presentationMode: list.presentationMode === 'count-only' ? 'count-only' as const : 'list' as const,
      };
    });
    for (const inventory of visualMap.cues[index].semanticInventories) {
      const rendered = semanticLists.find((entry) => entry.label === inventory.label);
      if (!rendered || rendered.presentationMode !== inventory.presentationMode ||
          (inventory.presentationMode === 'list' && JSON.stringify(rendered.items) !== JSON.stringify(inventory.items))) {
        throw new Error(`第 ${index + 1} 个 cue 没有按原片内容渲染语义列表“${inventory.label}”`);
      }
    }
    const rawRegions = Array.isArray(raw.layoutRegions) ? raw.layoutRegions : [];
    const layoutRegions = rawRegions.map((region, regionIndex) => parseLayoutRegion(region, index, regionIndex));
    const roles = new Set(layoutRegions.map((region) => region.role));
    if (!["primary", "caption", "presenter"].every((role) => roles.has(role as LayoutRegion['role']))) {
      throw new Error(`第 ${index + 1} 个 cue 必须声明 primary、caption、presenter 安全区`);
    }
    for (let leftIndex = 0; leftIndex < layoutRegions.length; leftIndex += 1) {
      for (let rightIndex = leftIndex + 1; rightIndex < layoutRegions.length; rightIndex += 1) {
        const left = layoutRegions[leftIndex];
        const right = layoutRegions[rightIndex];
        const ratio = layoutIntersectionRatio(left.bounds, right.bounds);
        if (ratio <= 0.01) continue;
        const rolesPair = new Set([left.role, right.role]);
        if (rolesPair.has('caption') && rolesPair.has('presenter')) {
          throw new Error(`第 ${index + 1} 个 cue 的人物与字幕区域重叠 ${(ratio * 100).toFixed(1)}%`);
        }
        if (
          [...rolesPair].some((role) => role === 'caption' || role === 'presenter') &&
          [...rolesPair].some((role) => ['primary', 'secondary', 'summary', 'chrome'].includes(role))
        ) {
          throw new Error(`第 ${index + 1} 个 cue 的语义 UI 与字幕/人物区域重叠 ${(ratio * 100).toFixed(1)}%`);
        }
        if (rolesPair.has('primary') && rolesPair.has('secondary')) {
          throw new Error(`第 ${index + 1} 个 cue 的次组件覆盖主内容 ${(ratio * 100).toFixed(1)}%`);
        }
        if (rolesPair.has('decoration') && (rolesPair.has('primary') || rolesPair.has('secondary'))) {
          const decoration = left.role === 'decoration' ? left : right;
          if (!Number.isFinite(decoration.maxOpacity) || Number(decoration.maxOpacity) > 0.08) {
            throw new Error(`第 ${index + 1} 个 cue 的装饰层穿过内容且透明度超过 8%`);
          }
        }
      }
    }
    if (layoutRegions.some((region) => region.role === 'summary' && !region.sourceEvidence)) {
      throw new Error(`第 ${index + 1} 个 cue 在完整字幕之外增加了无原片依据的底部摘要`);
    }
    const expectedEvidence = visualMap.cues[index].sourceVideoEvidence;
    const sourceVideoEvidence = expectedEvidence
      ? parseSourceVideoEvidence(raw.sourceVideoEvidence, index)
      : undefined;
    if (expectedEvidence && JSON.stringify(sourceVideoEvidence) !== JSON.stringify(expectedEvidence)) {
      throw new Error(`第 ${index + 1} 个 cue 的原片内容裁切/清理方案与视觉映射不一致`);
    }
    return {cueIndex, sceneKey, implementedElements, motionEvents, semanticLists, layoutRegions, sourceVideoEvidence};
  });
  let repeated = 1;
  for (let index = 1; index < cues.length; index += 1) {
    repeated = cues[index].sceneKey === cues[index - 1].sceneKey ? repeated + 1 : 1;
    if (repeated > 2) throw new Error(`通用场景 ${cues[index].sceneKey} 连续复用超过两次`);
  }
  const uniqueSceneRatio = new Set(cues.map((cue) => cue.sceneKey)).size / cues.length;
  if (cues.length >= 5 && uniqueSceneRatio < 0.6) {
    throw new Error(`场景实现多样性不足 (${uniqueSceneRatio.toFixed(3)})，疑似反复套用同一模板`);
  }
  return {cues};
};

export const validateNarrationVisualMap = (
  value: unknown,
  options: {
    narrationDuration: number;
    narrationScript: string;
    sourceTranscript: string;
    sourceDuration: number;
    exact: boolean;
    presenterSegmentCount: number;
  },
): NarrationVisualMap => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('旁白视觉映射无效');
  const root = value as Record<string, unknown>;
  if (root.presenterSegmentationDrivesVisuals !== false) {
    throw new Error('视觉时间线错误地依赖 InfiniteTalk 口型分段');
  }
  const rawCues = Array.isArray(root.cues) ? root.cues : [];
  if (rawCues.length < 3) throw new Error('旁白视觉映射 cue 数量不足');
  if (options.narrationDuration > 30 && rawCues.length <= options.presenterSegmentCount + 1) {
    throw new Error('视觉 cue 过少，疑似直接复用 InfiniteTalk 分段边界');
  }
  const cues = rawCues.map((item, index) => {
    const cue = item && typeof item === 'object' ? (item as Record<string, unknown>) : {};
    const cueIndex = Number(cue.cueIndex);
    const outputStartSeconds = Number(cue.outputStartSeconds);
    const outputEndSeconds = Number(cue.outputEndSeconds);
    const narrationText = typeof cue.narrationText === 'string' ? cue.narrationText.trim() : '';
    const visualType = typeof cue.visualType === 'string' ? cue.visualType.trim() : '';
    const cueDuration = outputEndSeconds - outputStartSeconds;
    if (
      cueIndex !== index ||
      !Number.isFinite(outputStartSeconds) ||
      !Number.isFinite(outputEndSeconds) ||
      outputStartSeconds < 0 ||
      outputEndSeconds <= outputStartSeconds ||
      narrationText.length < 2 ||
      visualType.length < 3
    ) {
      throw new Error(`旁白视觉映射第 ${index + 1} 个 cue 字段无效`);
    }
    if (cueDuration > 12.001) {
      throw new Error(
        `旁白视觉映射第 ${index + 1} 个 cue 时长 ${cueDuration.toFixed(3)} 秒，超过 12 秒上限`,
      );
    }
    const sourceStartSeconds = Number(cue.sourceStartSeconds);
    const sourceEndSeconds = Number(cue.sourceEndSeconds);
    const sourceText = typeof cue.sourceText === 'string' ? cue.sourceText.trim() : '';
    const sourceSceneDescription =
      typeof cue.sourceSceneDescription === 'string' ? cue.sourceSceneDescription.trim() : '';
    const replicationPlan = typeof cue.replicationPlan === 'string' ? cue.replicationPlan.trim() : '';
    if (
      !Number.isFinite(sourceStartSeconds) ||
      !Number.isFinite(sourceEndSeconds) ||
      sourceStartSeconds < 0 ||
      sourceEndSeconds <= sourceStartSeconds ||
      sourceEndSeconds > options.sourceDuration + 2 ||
      sourceText.length < 4 ||
      sourceSceneDescription.length < 8 ||
      replicationPlan.length < 8 ||
      contentOverlapRatio(sourceText, options.sourceTranscript) < 0.45
    ) {
      throw new Error(`旁白视觉映射第 ${index + 1} 个 cue 缺少原片转写、场景状态或逐项复刻方案`);
    }
    const semanticInventories: SemanticInventory[] = [];
    const rawInventories = Array.isArray(cue.semanticInventories) ? cue.semanticInventories : [];
    for (const count of detectSemanticCounts(narrationText)) {
      const rawInventory = rawInventories.find((entry) => {
        const inventory = entry && typeof entry === 'object' && !Array.isArray(entry) ? (entry as Record<string, unknown>) : {};
        return Number(inventory.count) === count;
      });
      const inventory = rawInventory && typeof rawInventory === 'object' && !Array.isArray(rawInventory)
        ? (rawInventory as Record<string, unknown>)
        : null;
      if (!inventory) throw new Error(`旁白视觉映射第 ${index + 1} 个 cue 说了 ${count} 项，但缺少 semanticInventories`);
      const label = typeof inventory.label === 'string' ? inventory.label.trim() : '';
      const sourceEvidence = typeof inventory.sourceEvidence === 'string' ? inventory.sourceEvidence.trim() : '';
      const presentationMode = inventory.presentationMode;
      const items = Array.isArray(inventory.items) ? inventory.items.map((entry) => String(entry).trim()) : [];
      if (label.length < 2 || sourceEvidence.length < 4 || (presentationMode !== 'list' && presentationMode !== 'count-only')) {
        throw new Error(`旁白视觉映射第 ${index + 1} 个 cue 的语义列表依据无效`);
      }
      if (presentationMode === 'list' &&
          (items.length !== count || items.some((entry) => entry.length < 2 || placeholderListPattern.test(entry)))) {
        throw new Error(`旁白视觉映射第 ${index + 1} 个 cue 必须提供 ${count} 个有意义的真实项目名`);
      }
      const unavailableReason = typeof inventory.unavailableReason === 'string' ? inventory.unavailableReason.trim() : undefined;
      if (presentationMode === 'count-only' &&
          (items.length > 0 || !unavailableReason || unavailableReason.length < 8 || repeatedUiPattern.test(replicationPlan))) {
        throw new Error(`旁白视觉映射第 ${index + 1} 个 cue 未知项目名时只能使用单一数量视觉`);
      }
      semanticInventories.push({label, count, items, sourceEvidence, presentationMode, unavailableReason});
    }
    const sourceVideoEvidence = visualType === 'source_video_pip'
      ? parseSourceVideoEvidence(cue.sourceVideoEvidence, index)
      : undefined;
    return {
      cueIndex,
      outputStartSeconds,
      outputEndSeconds,
      narrationText,
      visualType,
      sourceStartSeconds,
      sourceEndSeconds,
      sourceText,
      sourceSceneDescription,
      replicationPlan,
      semanticInventories,
      sourceVideoEvidence,
    };
  });
  if (cues[0].outputStartSeconds > 0.5 || cues.at(-1)!.outputEndSeconds < options.narrationDuration - 1) {
    throw new Error('旁白视觉映射没有覆盖完整成片');
  }
  for (let index = 1; index < cues.length; index += 1) {
    const gap = cues[index].outputStartSeconds - cues[index - 1].outputEndSeconds;
    if (gap > 0.5 || cues[index].outputStartSeconds < cues[index - 1].outputStartSeconds) {
      throw new Error('旁白视觉映射存在空档或顺序错误');
    }
  }
  if (contentOverlapRatio(cues.map((cue) => cue.narrationText).join(' '), options.narrationScript) < 0.4) {
    throw new Error('旁白视觉映射没有依据最终口播文案');
  }
  for (let index = 1; index < cues.length; index += 1) {
    if (cues[index].sourceStartSeconds + 1 < cues[index - 1].sourceStartSeconds) {
      throw new Error('复刻任务的原片视觉 cue 没有保持原有顺序');
    }
  }
  const rawMotionEvidence = Array.isArray(root.sourceMotionEvidenceInventory)
    ? root.sourceMotionEvidenceInventory
    : [];
  const sourceMotionEvidenceInventory = rawMotionEvidence.map((item, index): SourceMotionEvidence => {
    const evidence = item && typeof item === 'object' && !Array.isArray(item)
      ? (item as Record<string, unknown>)
      : {};
    const sourceStartSeconds = Number(evidence.sourceStartSeconds);
    const sourceEndSeconds = Number(evidence.sourceEndSeconds);
    const kind = typeof evidence.kind === 'string' ? evidence.kind.trim() : '';
    const description = typeof evidence.description === 'string' ? evidence.description.trim() : '';
    const eligible = evidence.eligible === true;
    const mappedCueIndices = Array.isArray(evidence.mappedCueIndices)
      ? evidence.mappedCueIndices.map(Number)
      : [];
    const exclusionReason = typeof evidence.exclusionReason === 'string'
      ? evidence.exclusionReason.trim()
      : undefined;
    if (
      !Number.isFinite(sourceStartSeconds) ||
      !Number.isFinite(sourceEndSeconds) ||
      sourceStartSeconds < 0 ||
      sourceEndSeconds <= sourceStartSeconds ||
      sourceEndSeconds > options.sourceDuration + 2 ||
      kind.length < 3 ||
      description.length < 8 ||
      mappedCueIndices.some((cueIndex) => !Number.isInteger(cueIndex) || cueIndex < 0 || cueIndex >= cues.length)
    ) {
      throw new Error(`原片运动证据清单第 ${index + 1} 项无效`);
    }
    if (!eligible && (!exclusionReason || exclusionReason.length < 8)) {
      throw new Error(`原片运动证据清单第 ${index + 1} 项缺少排除理由`);
    }
    if (eligible && !mappedCueIndices.length) {
      throw new Error(`原片运动证据清单第 ${index + 1} 项没有映射到任何 cue`);
    }
    for (const cueIndex of mappedCueIndices) {
      const cue = cues[cueIndex];
      const preservesMotion = new Set([
        'source_clip',
        'source_video',
        'source_video_pip',
        'generated_video',
        'screen_recording',
      ]).has(cue.visualType);
      if (eligible && !preservesMotion) {
        throw new Error(`旁白视觉映射第 ${cueIndex + 1} 个 cue 禁止用卡片或示意图替代运动证据`);
      }
    }
    return {
      sourceStartSeconds,
      sourceEndSeconds,
      kind,
      description,
      eligible,
      mappedCueIndices,
      exclusionReason,
    };
  });
  return {cues, ...(sourceMotionEvidenceInventory.length ? {sourceMotionEvidenceInventory} : {})};
};

const validateInfiniteTalkReceipt = (
  receiptPath: string,
  presenterSource: string,
): {promptId: string; audioSha256: string} => {
  if (!existsSync(receiptPath)) throw new Error('缺少 InfiniteTalk 生成回执');
  try {
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as {
      saved?: unknown;
      prompt_id?: unknown;
      audio_sha256?: unknown;
    };
    const rawSaved = Array.isArray(receipt.saved) ? receipt.saved.map(String) : [];
    const saved = rawSaved.map((item) => path.resolve(item));
    const portableSaved = rawSaved.map((item) => path.resolve(path.dirname(receiptPath), path.basename(item)));
    if (!saved.includes(presenterSource) && !portableSaved.includes(presenterSource)) {
      throw new Error('presenterSourcePath 不在 InfiniteTalk 回执中');
    }
    const promptId = typeof receipt.prompt_id === 'string' ? receipt.prompt_id.trim() : '';
    if (!promptId) throw new Error('InfiniteTalk 回执缺少 prompt_id');
    const audioSha256 = typeof receipt.audio_sha256 === 'string' ? receipt.audio_sha256.trim() : '';
    if (!/^[a-f0-9]{64}$/.test(audioSha256)) throw new Error('InfiniteTalk 回执缺少有效 audio_sha256');
    return {promptId, audioSha256};
  } catch (error) {
    if (error instanceof Error && /presenterSourcePath|prompt_id|audio_sha256/.test(error.message)) throw error;
    throw new Error('InfiniteTalk 生成回执无效');
  }
};

const hasAudioStream = (mediaPath: string): boolean => {
  const result = spawnSync(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'a', '-show_entries', 'stream=index', '-of', 'csv=p=0', mediaPath],
    {encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024},
  );
  if (result.status !== 0) throw new Error(`无法检查媒体音轨: ${path.basename(mediaPath)}`);
  return Boolean(result.stdout.trim());
};

export const measureAudioSimilarity = (referencePath: string, candidatePath: string): number => {
  const decode = (mediaPath: string): Buffer => {
    const result = spawnSync(
      'ffmpeg',
      ['-v', 'error', '-i', mediaPath, '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', 'pipe:1'],
      {timeout: 120_000, maxBuffer: 16 * 1024 * 1024},
    );
    if (result.status !== 0 || !Buffer.isBuffer(result.stdout) || result.stdout.length < 16_000) {
      throw new Error(`无法解码音频内容: ${path.basename(mediaPath)}`);
    }
    return result.stdout;
  };
  const reference = decode(referencePath);
  const candidate = decode(candidatePath);
  const sampleCount = Math.floor(Math.min(reference.length, candidate.length) / 2);
  let dot = 0;
  let referenceEnergy = 0;
  let candidateEnergy = 0;
  for (let index = 0; index < sampleCount; index += 4) {
    const referenceSample = reference.readInt16LE(index * 2);
    const candidateSample = candidate.readInt16LE(index * 2);
    dot += referenceSample * candidateSample;
    referenceEnergy += referenceSample * referenceSample;
    candidateEnergy += candidateSample * candidateSample;
  }
  if (!referenceEnergy || !candidateEnergy) return 0;
  return dot / Math.sqrt(referenceEnergy * candidateEnergy);
};

const probeDuration = (mediaPath: string): number => {
  const result = spawnSync(
    'ffprobe',
    ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', mediaPath],
    {encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024},
  );
  const duration = Number(result.stdout.trim());
  if (result.status !== 0 || !Number.isFinite(duration) || duration <= 0) {
    throw new Error('无法读取最终 MP4 时长');
  }
  return duration;
};

const probeDimensions = (mediaPath: string): {width: number; height: number} => {
  const result = spawnSync(
    'ffprobe',
    ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', mediaPath],
    {encoding: 'utf8', timeout: 20_000, maxBuffer: 1024 * 1024},
  );
  try {
    const stream = (JSON.parse(result.stdout) as {streams?: Array<{width?: number; height?: number}>}).streams?.[0];
    const width = Number(stream?.width);
    const height = Number(stream?.height);
    if (result.status !== 0 || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
      throw new Error();
    }
    return {width, height};
  } catch {
    throw new Error(`无法读取视觉尺寸: ${path.basename(mediaPath)}`);
  }
};

export const isGrossLumaMismatch = (sourceMeanLuma: number, candidateMeanLuma: number): boolean =>
  (sourceMeanLuma >= 155 && candidateMeanLuma <= 100) ||
  (sourceMeanLuma <= 85 && candidateMeanLuma >= 145) ||
  Math.abs(sourceMeanLuma - candidateMeanLuma) >= 80;

export const measureSampledMeanLuma = (mediaPath: string, sampleCount = 10): number => {
  const extension = path.extname(mediaPath).toLowerCase();
  const isStill = ['.png', '.jpg', '.jpeg', '.webp'].includes(extension);
  const duration = isStill ? 0 : probeDuration(mediaPath);
  const samples = isStill ? [0] : Array.from({length: sampleCount}, (_, index) => duration * ((index + 0.5) / sampleCount));
  let total = 0;
  let pixels = 0;
  for (const timestamp of samples) {
    const seek = isStill ? [] : ['-ss', timestamp.toFixed(3)];
    const result = spawnSync(
      'ffmpeg',
      ['-v', 'error', ...seek, '-i', mediaPath, '-frames:v', '1', '-vf', 'scale=64:64,format=gray', '-f', 'rawvideo', 'pipe:1'],
      {timeout: 30_000, maxBuffer: 128 * 1024},
    );
    if (result.status !== 0 || !Buffer.isBuffer(result.stdout) || result.stdout.length < 4096) {
      throw new Error(`无法采样画面亮度: ${path.basename(mediaPath)}`);
    }
    for (const value of result.stdout) total += value;
    pixels += result.stdout.length;
  }
  return total / pixels;
};

const measureVisualSignature = (mediaPath: string): Buffer => {
  const result = spawnSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-i',
      mediaPath,
      '-frames:v',
      '1',
      '-vf',
      'crop=iw*0.76:ih*0.70:iw*0.12:ih*0.08,scale=32:18,format=gray',
      '-f',
      'rawvideo',
      'pipe:1',
    ],
    {timeout: 30_000, maxBuffer: 128 * 1024},
  );
  if (result.status !== 0 || !Buffer.isBuffer(result.stdout) || result.stdout.length < 576) {
    throw new Error(`无法采样中央画面结构: ${path.basename(mediaPath)}`);
  }
  return result.stdout.subarray(0, 576);
};

export const visualSignatureDistance = (left: Uint8Array, right: Uint8Array): number => {
  if (left.length !== right.length || !left.length) throw new Error('视觉签名尺寸不一致');
  let total = 0;
  for (let index = 0; index < left.length; index += 1) total += Math.abs(left[index] - right[index]);
  return total / left.length;
};

export const countVisualSignatureClusters = (
  signatures: readonly Uint8Array[],
  threshold = 12,
): number => {
  const representatives: Uint8Array[] = [];
  for (const signature of signatures) {
    if (!representatives.some((representative) => visualSignatureDistance(signature, representative) < threshold)) {
      representatives.push(signature);
    }
  }
  return representatives.length;
};

export const validateCueVisualDiversity = (
  sourceFramePaths: string[],
  cueFramePaths: string[],
): {sourceUniqueRatio: number; cueUniqueRatio: number} => {
  const sourceSignatures = sourceFramePaths.map(measureVisualSignature);
  const cueSignatures = cueFramePaths.map(measureVisualSignature);
  const sourceUniqueRatio = countVisualSignatureClusters(sourceSignatures) / sourceSignatures.length;
  const cueUniqueRatio = countVisualSignatureClusters(cueSignatures) / cueSignatures.length;
  if (sourceUniqueRatio >= 0.75 && cueUniqueRatio < 0.6) {
    throw new Error(
      `成片 cue 构图重复度过高 (source=${sourceUniqueRatio.toFixed(3)}, final=${cueUniqueRatio.toFixed(3)})，禁止用少量模板冒充源片场景`,
    );
  }
  return {sourceUniqueRatio, cueUniqueRatio};
};

export const validateCueMotionPairs = (motionFramePaths: string[]): {pairCount: number; movingPairCount: number} => {
  if (motionFramePaths.length % 2 !== 0) throw new Error('cue 动效审查帧必须按 25%/75% 成对提供');
  let movingPairCount = 0;
  for (let index = 0; index < motionFramePaths.length; index += 2) {
    const distance = visualSignatureDistance(
      measureVisualSignature(motionFramePaths[index]),
      measureVisualSignature(motionFramePaths[index + 1]),
    );
    if (distance >= 3) movingPairCount += 1;
  }
  const pairCount = motionFramePaths.length / 2;
  if (pairCount && movingPairCount / pairCount < 0.6) {
    throw new Error(
      `cue 内持续动效不足 (${movingPairCount}/${pairCount})，场景不能只在开头入场后保持静止`,
    );
  }
  return {pairCount, movingPairCount};
};

const validateMediaPaths = (
  workspace: string,
  value: unknown,
  label: string,
  minimum: number,
): string[] => {
  if (!Array.isArray(value) || value.length < minimum) throw new Error(`${label} 数量不足，至少需要 ${minimum} 个`);
  const paths = value.map((candidate, index) => resolveWorkspacePath(workspace, candidate, `${label}[${index}]`));
  if (new Set(paths).size !== paths.length) throw new Error(`${label} 包含重复路径`);
  for (const mediaPath of paths) {
    if (!existsSync(mediaPath) || statSync(mediaPath).size <= 1024) throw new Error(`${label} 文件缺失或无效`);
    probeDimensions(mediaPath);
  }
  return paths;
};

const validatePreflightReport = (
  workspace: string,
  filename: string,
  remotionVisual: string,
  sourceFramePaths: string[],
  presenterSegmentCount: number,
): {storyboardPreviewPath: string; remotionStillPaths: string[]; presenterCropStillPaths: string[]} => {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(readFileSync(filename, 'utf8')) as Record<string, unknown>;
  } catch {
    throw new Error('Remotion 前置质检报告无效');
  }
  if (value.approved !== true || !Array.isArray(value.issues) || value.issues.length) {
    throw new Error('Remotion 前置质检未通过');
  }
  const reportedSourceFrames = validateMediaPaths(workspace, value.sourceFramePaths, '前置原片代表帧', 10);
  if (reportedSourceFrames.join('\n') !== sourceFramePaths.join('\n')) {
    throw new Error('前置质检使用的原片代表帧与结果清单不一致');
  }
  const storyboardPreviewPath = resolveWorkspacePath(
    workspace,
    value.storyboardPreviewPath,
    'preflight.storyboardPreviewPath',
  );
  if (!existsSync(storyboardPreviewPath) || statSync(storyboardPreviewPath).size <= 1024) {
    throw new Error('缺少低成本故事板预览');
  }
  const remotionStillPaths = validateMediaPaths(workspace, value.remotionStillPaths, 'Remotion 前置静帧', 4);
  const presenterCropStillPaths = validateMediaPaths(
    workspace,
    value.presenterCropStillPaths,
    '数字人裁切静帧',
    Math.max(1, presenterSegmentCount),
  );
  const visualMtime = statSync(remotionVisual).mtimeMs;
  for (const filenameToCheck of [storyboardPreviewPath, ...remotionStillPaths, ...presenterCropStillPaths]) {
    if (statSync(filenameToCheck).mtimeMs > visualMtime + 1000) {
      throw new Error('前置质检材料生成晚于完整 Remotion 成片，未执行前置门禁');
    }
  }
  return {storyboardPreviewPath, remotionStillPaths, presenterCropStillPaths};
};

export const calculateCodexTimeoutMs = (
  baseTimeoutMs: number,
  durationSeconds: number,
  goalMaxMs = 360 * 60 * 1000,
): number => {
  const segmentCount = Math.max(1, Math.ceil(durationSeconds / 18));
  const durationAwareTimeoutMs = (30 + segmentCount * 20) * 60 * 1000;
  return Math.min(goalMaxMs, Math.max(baseTimeoutMs, durationAwareTimeoutMs));
};

const codexThreadIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const extractCodexThreadId = (value: unknown): string | null => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const event = value as Record<string, unknown>;
  const item = event.item && typeof event.item === 'object' && !Array.isArray(event.item)
    ? (event.item as Record<string, unknown>)
    : {};
  const candidates = [event.thread_id, event.threadId, item.thread_id, item.threadId];
  const match = candidates.find(
    (candidate): candidate is string => typeof candidate === 'string' && codexThreadIdPattern.test(candidate),
  );
  return match ?? null;
};

export const codexContinuationPrompt = (turn: number, remainingMs: number): string =>
  [
    `继续当前 active Goal，这是 worker 自动续跑的第 ${turn} 轮。`,
    '不要设置 token budget；质量优先，不得为了减少 token、输出篇幅或轮次而简化字幕、场景、动效或验收。',
    '如果 get_goal 显示 blocked，立即返回最新阻塞原因；worker 会终止本次平台任务，不要再次启动 blocked audit。',
    '不要创建新任务、不要重做已经通过校验的 TTS 或 InfiniteTalk 分段，也不要仅总结当前进度后退出。',
    '先读取工作区现有检查点；若 InfiniteTalk 有 pending prompt，重新运行同一 segmented-submit 命令以恢复并等待回执，但统一使用 --blocks-to-swap 0 --poll-seconds 10 --max-polls 240。',
    '只有 final.mp4、result.json、封面和全部审查材料真实生成并通过提示中的硬校验后，才能完成 Goal 并结束。',
    `worker 剩余最长运行时间约 ${Math.max(1, Math.ceil(remainingMs / 60000))} 分钟。`,
  ].join('\n');

export const detectDurationConstraintFailure = (
  finalMessage: string,
  requestedDurationSeconds: number,
  replicaMode: 'exact' | 'condensed' = 'exact',
): string | null => {
  if (replicaMode === 'condensed') return null;
  const durationBlocked =
    /(?:无法|不能).{0,40}(?:秒|分钟).{0,80}(?:完整保留|容纳|保留全部|全部观点)/s.test(finalMessage) ||
    /(?:需要|需).{0,20}(?:提高|增加|放宽).{0,30}(?:允许时长|时长上限)/s.test(finalMessage) ||
    /为避免违规删节/.test(finalMessage);
  if (!durationBlocked) return null;
  const recommendedSeconds = Number(finalMessage.match(/至少\s*(\d+)\s*秒/)?.[1]);
  const recommendation = Number.isFinite(recommendedSeconds)
    ? `，建议至少 ${recommendedSeconds} 秒`
    : '，请提高允许时长后重试';
  return `当前 ${requestedDurationSeconds} 秒时长约束无法完整保留原片实质内容${recommendation}`;
};

export const shouldContinueCodexGoal = (input: {
  hasCompleteArtifacts: boolean;
  turnTimedOut: boolean;
  threadId: string;
  goalStatus: string;
  terminalConstraintFailure: boolean;
}): boolean =>
  !input.hasCompleteArtifacts &&
  !input.turnTimedOut &&
  Boolean(input.threadId) &&
  !input.terminalConstraintFailure &&
  !['blocked', 'complete'].includes(input.goalStatus);

export const codexValidationRepairPrompt = (error: string, turn: number, remainingMs: number): string =>
  [
    `平台独立验收在 Goal 完成后失败，这是同一任务的第 ${turn} 轮验收修复。`,
    `确定性错误：${error}`,
    '先调用 create_goal，把修复该验收错误并重新通过平台验收设为目标；不要设置 token budget，不要新建平台任务。',
    '质量优先于 token 用量、实现篇幅和轮次数量；字幕覆盖、场景实现、多样性或持续动效失败时必须真正修复可见画面。',
    '复用现有 TTS、InfiniteTalk 分段、Remotion 成片和审查材料，只修改导致错误的源码或清单。',
    '如果只是 JSX 数据标记或清单路径，不改变可见画面时禁止重新 TTS、重新请求 InfiniteTalk或重新渲染视频。',
    '修复后运行对应的确定性检查，确认错误已消失，再调用 update_goal(status=complete)。',
    `worker 剩余最长运行时间约 ${Math.max(1, Math.ceil(remainingMs / 60000))} 分钟。`,
  ].join('\n');

type CodexGoalSnapshot = {status: string; updatedAtMs: number};

const readCodexGoalSnapshot = (threadId: string): CodexGoalSnapshot | null => {
  try {
    const codexHome = process.env.CODEX_HOME?.trim() || path.join(os.homedir(), '.codex');
    const databasePath = readdirSync(codexHome)
      .filter((entry) => /^goals_\d+\.sqlite$/.test(entry))
      .map((entry) => path.join(codexHome, entry))
      .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0];
    if (!databasePath) return null;
    const database = new DatabaseSync(databasePath, {readOnly: true});
    try {
      const row = database
        .prepare('SELECT status, updated_at_ms FROM thread_goals WHERE thread_id = ?')
        .get(threadId) as {status?: unknown; updated_at_ms?: unknown} | undefined;
      const status = typeof row?.status === 'string' ? row.status : '';
      const updatedAtMs = Number(row?.updated_at_ms);
      return status && Number.isFinite(updatedAtMs) ? {status, updatedAtMs} : null;
    } finally {
      database.close();
    }
  } catch {
    return null;
  }
};

export const shouldStopSettledGoalTurn = (
  initial: CodexGoalSnapshot | null,
  current: CodexGoalSnapshot | null,
): boolean =>
  Boolean(
    initial &&
      current &&
      current.updatedAtMs > initial.updatedAtMs &&
      ['blocked', 'complete'].includes(current.status),
  );

export type ArtifactProgress = {
  key: string;
  kind: string;
  message: string;
  stage: string;
  progress: number;
  data?: Record<string, unknown>;
};

const hasMediaArtifact = (candidates: string[]): boolean =>
  candidates.some((candidate) => existsSync(candidate) && statSync(candidate).size > 1024);

export const inspectArtifactProgress = (workspace: string): ArtifactProgress | null => {
  const out = path.join(workspace, 'out');
  const finalVideo = path.join(out, 'final.mp4');
  if (existsSync(finalVideo) && statSync(finalVideo).size > 1024) {
    return {
      key: 'final-video',
      kind: 'final_video_ready',
      message: 'Remotion 成片已写入，正在执行严格质量检查',
      stage: '检查成片',
      progress: 90,
    };
  }

  if (hasMediaArtifact([path.join(out, 'remotion_visual.mp4'), path.join(out, 'remotion-visual.mp4')])) {
    return {
      key: 'remotion-visual-ready',
      kind: 'remotion_visual_ready',
      message: 'Remotion 无声视觉成片已写入，正在封装锁定旁白',
      stage: '封装最终成片',
      progress: 86,
    };
  }

  if (
    hasMediaArtifact([
      path.join(out, 'stills', 'remotion', 'opening.png'),
      path.join(out, 'stills', 'final', 'opening.png'),
    ])
  ) {
    return {
      key: 'remotion-preview-ready',
      kind: 'remotion_preview_ready',
      message: 'Remotion 视觉预览已生成，正在渲染全片',
      stage: '渲染视觉成片',
      progress: 80,
    };
  }

  if (
    hasMediaArtifact([
      path.join(out, 'checkpoints', 'infinite_talk', 'presenter.mp4'),
      path.join(out, 'remotion', 'public', 'presenter.mp4'),
      path.join(workspace, 'public', 'presenter.mp4'),
    ])
  ) {
    return {
      key: 'presenter-ready',
      kind: 'presenter_ready',
      message: '数字人口型片段已拼接，开始编排字幕与 UI',
      stage: '编排字幕与 UI',
      progress: 76,
    };
  }

  const segmentsPath = path.join(out, 'checkpoints', 'infinite_talk', 'segments.json');
  if (existsSync(segmentsPath)) {
    try {
      const manifest = JSON.parse(readFileSync(segmentsPath, 'utf8')) as {
        completed_segments?: unknown;
        segment_plan?: unknown;
      };
      const completed = Number(manifest.completed_segments);
      const total = Array.isArray(manifest.segment_plan) ? manifest.segment_plan.length : 0;
      if (Number.isInteger(completed) && completed > 0 && total > 0) {
        const bounded = Math.min(completed, total);
        return {
          key: `presenter-segments-${bounded}-${total}`,
          kind: 'presenter_segment_progress',
          message: `数字人口型片段已完成 ${bounded}/${total}`,
          stage: `生成数字人 ${bounded}/${total}`,
          progress: 38 + Math.round((bounded / total) * 36),
          data: {completed: bounded, total},
        };
      }
    } catch {
      // The manifest can be momentarily incomplete while the generator replaces it.
    }
  }

  const narration = path.join(out, 'audio', 'final_narration.wav');
  if (existsSync(narration) && statSync(narration).size > 1024) {
    return {
      key: 'narration-ready',
      kind: 'narration_ready',
      message: '最终旁白已锁定，开始生成数字人口型',
      stage: '生成数字人',
      progress: 36,
    };
  }

  const script = path.join(out, 'audio', 'final_script.txt');
  if (existsSync(script) && statSync(script).size > 16) {
    return {
      key: 'script-ready',
      kind: 'script_ready',
      message: '口播文案已完成，正在生成最终旁白',
      stage: '生成旁白',
      progress: 30,
    };
  }
  return null;
};

const missingOutputError = (workspace: string): Error => {
  const finalMessagePath = path.join(workspace, 'out', 'codex-final-message.txt');
  const finalMessage = existsSync(finalMessagePath) ? readFileSync(finalMessagePath, 'utf8') : '';
  if (/连接被拒绝|connection refused/i.test(finalMessage)) {
    return new Error('InfiniteTalk 服务在生成过程中断开连接，未生成成片');
  }
  if (/超时|timed?\s*out/i.test(finalMessage)) {
    return new Error('InfiniteTalk 生成超时，未生成成片');
  }
  if (/InfiniteTalk|数字人/.test(finalMessage)) {
    return new Error('InfiniteTalk 数字人生成失败，未生成成片');
  }
  return new Error('Codex 已结束，但没有生成最终 MP4 成片');
};

export class CodexRunner {
  private readonly processes = new Map<string, ChildProcess>();

  constructor(private readonly options: RunnerOptions) {}

  cancel(jobId: string): void {
    this.processes.get(jobId)?.kill('SIGTERM');
  }

  async run(job: JobRecord, workspace: string, prompt: string, callbacks: RunCallbacks): Promise<string> {
    mkdirSync(path.join(workspace, 'out'), {recursive: true});
    writeFileSync(path.join(workspace, 'job-prompt.txt'), prompt, 'utf8');
    if (this.options.mock) return this.runMock(job, workspace, callbacks);
    return this.runCodex(job, workspace, prompt, callbacks);
  }

  private async runMock(job: JobRecord, workspace: string, callbacks: RunCallbacks): Promise<string> {
    callbacks.onEvent('mock', '开发模式：使用本地模拟生成，不调用 Codex 或收费模型');
    callbacks.onProgress('分析素材', 32);
    await new Promise((resolve) => setTimeout(resolve, 600));
    if (callbacks.isCancelled()) throw new Error('任务已取消');
    callbacks.onProgress('生成数字人', 62);

    const output = path.join(workspace, 'out', 'final.mp4');
    const source = job.assets.sourceVideo;
    const args = source
      ? [
          '-y',
          '-t',
          String(Math.min(job.durationSeconds, 12)),
          '-i',
          source,
          '-vf',
          'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,format=yuv420p',
          '-c:v',
          'libx264',
          '-crf',
          '18',
          '-c:a',
          'aac',
          '-movflags',
          '+faststart',
          output,
        ]
      : [
          '-y',
          '-f',
          'lavfi',
          '-i',
          `color=c=#171a19:s=1280x720:r=25:d=${Math.min(job.durationSeconds, 8)}`,
          '-f',
          'lavfi',
          '-i',
          `sine=frequency=220:sample_rate=44100:duration=${Math.min(job.durationSeconds, 8)}`,
          '-c:v',
          'libx264',
          '-pix_fmt',
          'yuv420p',
          '-c:a',
          'aac',
          '-shortest',
          '-movflags',
          '+faststart',
          output,
        ];

    await new Promise<void>((resolve, reject) => {
      const child = spawn('ffmpeg', args, {stdio: ['ignore', 'ignore', 'pipe']});
      this.processes.set(job.id, child);
      let error = '';
      child.stderr.on('data', (chunk) => {
        error = (error + String(chunk)).slice(-4000);
      });
      child.on('error', reject);
      child.on('exit', (code) => {
        this.processes.delete(job.id);
        if (code === 0) resolve();
        else reject(new Error(`模拟视频生成失败: ${redact(error)}`));
      });
    });
    callbacks.onProgress('质量检查', 90);
    callbacks.onEvent('result', '模拟成片已生成', {output});
    return output;
  }

  private async runCodex(
    job: JobRecord,
    workspace: string,
    prompt: string,
    callbacks: RunCallbacks,
  ): Promise<string> {
    const outputDir = path.join(workspace, 'out');
    const finalMessagePath = path.join(outputDir, 'codex-final-message.txt');
    const threadIdPath = path.join(outputDir, 'codex-thread-id.txt');
    const expected = path.join(outputDir, 'final.mp4');
    const manifestPath = path.join(outputDir, 'result.json');
    if (this.options.proxyUrl) {
      callbacks.onEvent('codex_proxy_scan', '正在检查美国 Codex 代理节点');
      callbacks.onProgress('检查美国 Codex 节点', 22);
      const selection = await selectWorkingUsProxy({
        proxyUrl: this.options.proxyUrl,
        configPath: this.options.proxyConfigPath,
        controllerUrl: this.options.proxyControllerUrl,
        groupName: this.options.proxyGroup,
        probeUrl: this.options.proxyProbeUrl,
        probeTimeoutMs: this.options.proxyProbeTimeoutMs,
      });
      callbacks.onEvent(
        'codex_proxy_ready',
        `美国 Codex 节点预检通过（第 ${selection.selectedOrdinal}/${selection.candidateCount} 个候选）`,
        {candidateCount: selection.candidateCount, selectedOrdinal: selection.selectedOrdinal},
      );
    }
    const completeArtifactsExist = (): boolean =>
      existsSync(expected) && statSync(expected).size > 1024 && existsSync(manifestPath);
    const storedThreadId = existsSync(threadIdPath) ? readFileSync(threadIdPath, 'utf8').trim() : '';
    let threadId = codexThreadIdPattern.test(storedThreadId) ? storedThreadId : '';
    let validationFeedback =
      typeof job.metadata.workerValidationFeedback === 'string'
        ? job.metadata.workerValidationFeedback.trim()
        : '';
    const initialArgs = (): string[] => {
      const args = [
        'exec',
        '--json',
        '--skip-git-repo-check',
        '--color',
        'never',
        '--model',
        this.options.model,
        '--sandbox',
        this.options.sandbox,
        '--cd',
        workspace,
        '--add-dir',
        this.options.skillPath,
        '--output-last-message',
        finalMessagePath,
      ];
      if (this.options.ephemeral) args.splice(2, 0, '--ephemeral');
      if (this.options.modelProvider) args.push('--config', `model_provider="${this.options.modelProvider}"`);
      args.push('--config', `model_reasoning_effort="${this.options.reasoningEffort}"`);
      if (this.options.proxyUrl) {
        args.push(
          '--config',
          'shell_environment_policy.exclude=["HTTP_PROXY","HTTPS_PROXY","ALL_PROXY","NO_PROXY"]',
        );
      }
      args.push('--config', 'sandbox_workspace_write.network_access=true');
      if (this.options.profile) args.push('--profile', this.options.profile);
      args.push('-');
      return args;
    };
    const resumeArgs = (id: string): string[] => {
      const args = [
        '--sandbox',
        this.options.sandbox,
        '--cd',
        workspace,
        '--add-dir',
        this.options.skillPath,
        '--config',
        'sandbox_workspace_write.network_access=true',
        'exec',
        'resume',
        '--json',
        '--skip-git-repo-check',
        '--model',
        this.options.model,
        '--output-last-message',
        finalMessagePath,
      ];
      if (this.options.modelProvider) args.splice(8, 0, '--config', `model_provider="${this.options.modelProvider}"`);
      args.splice(8, 0, '--config', `model_reasoning_effort="${this.options.reasoningEffort}"`);
      if (this.options.proxyUrl) {
        args.splice(
          8,
          0,
          '--config',
          'shell_environment_policy.exclude=["HTTP_PROXY","HTTPS_PROXY","ALL_PROXY","NO_PROXY"]',
        );
      }
      if (this.options.profile) args.splice(8, 0, '--profile', this.options.profile);
      if (this.options.ephemeral) args.push('--ephemeral');
      args.push(id, '-');
      return args;
    };

    callbacks.onEvent(
      'codex_start',
      `Codex worker 已启动，模型 ${this.options.model}，推理强度 ${this.options.reasoningEffort}`,
      {model: this.options.model, reasoningEffort: this.options.reasoningEffort},
    );
    callbacks.onProgress('Codex 正在规划', 24);
    let stderr = '';
    let eventCount = 0;
    let lastFailure = '';
    let lastArtifactKey = '';
    let reportedProgress = 24;
    const reportProgress = (stage: string, progress: number): void => {
      if (progress < reportedProgress) return;
      reportedProgress = progress;
      callbacks.onProgress(stage, progress);
    };
    const reportArtifacts = (): void => {
      const artifact = inspectArtifactProgress(workspace);
      if (!artifact || artifact.key === lastArtifactKey) return;
      lastArtifactKey = artifact.key;
      callbacks.onEvent(artifact.kind, artifact.message, artifact.data);
      reportProgress(artifact.stage, artifact.progress);
    };
    const artifactTimer = setInterval(reportArtifacts, 2000);
    artifactTimer.unref();
    reportArtifacts();
    const parseLine = (line: string): void => {
      if (!line.trim()) return;
      try {
        const event = JSON.parse(line) as Record<string, unknown>;
        const detectedThreadId = extractCodexThreadId(event);
        if (detectedThreadId && detectedThreadId !== threadId) {
          threadId = detectedThreadId;
          writeFileSync(threadIdPath, `${threadId}\n`, 'utf8');
        }
        const kind = String(event.type ?? event.kind ?? 'codex_event');
        const item = (event.item ?? event.message ?? {}) as Record<string, unknown>;
        const itemType = typeof item.type === 'string' ? item.type : undefined;
        const rawMessage =
          item.text ?? item.command ?? item.status ?? event.text ?? event.message ?? event.error ?? kind;
        const message = redact(typeof rawMessage === 'string' ? rawMessage : JSON.stringify(rawMessage));
        if (kind === 'error' || kind.endsWith('.failed') || kind === 'turn.failed') lastFailure = message;
        eventCount += 1;
        if (!/^(?:in_progress|completed|started|codex_event)$/i.test(message.trim())) {
          callbacks.onEvent(kind, message.slice(0, 1800), {sequence: eventCount, ...(itemType ? {itemType} : {})});
        }
      } catch {
        callbacks.onEvent('codex_output', redact(line).slice(0, 1800));
      }
    };
    const effectiveTimeoutMs = calculateCodexTimeoutMs(
      this.options.timeoutMs,
      job.durationSeconds,
      this.options.goalMaxMs,
    );
    const deadline = Date.now() + effectiveTimeoutMs;
    let timedOut = false;
    let exitCode: number | null = null;
    let terminalError: Error | null = null;
    let turn = 0;
    try {
      while (!completeArtifactsExist() || Boolean(validationFeedback)) {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          timedOut = true;
          break;
        }
        turn += 1;
        const isResume = Boolean(threadId);
        if (isResume) {
          callbacks.onEvent(
            validationFeedback ? 'codex_validation_repair' : 'codex_resume',
            validationFeedback
              ? `平台验收未通过，正在同一上下文修复：${validationFeedback}`
              : `后台口播仍在生成，正在自动恢复等待（第 ${turn} 轮；不是上下文超限或质检失败）`,
            {threadId, turn, ...(validationFeedback ? {validationFeedback} : {})},
          );
        }
        const childEnvironment = {...process.env};
        if (this.options.proxyUrl) {
          childEnvironment.HTTP_PROXY = this.options.proxyUrl;
          childEnvironment.HTTPS_PROXY = this.options.proxyUrl;
          childEnvironment.ALL_PROXY = this.options.proxyUrl;
          childEnvironment.NO_PROXY = '127.0.0.1,localhost,::1';
        }
        const child = spawn(this.options.bin, isResume ? resumeArgs(threadId) : initialArgs(), {
          cwd: workspace,
          env: childEnvironment,
          stdio: ['pipe', 'pipe', 'pipe'],
        });
        this.processes.set(job.id, child);
        const turnPrompt = validationFeedback
          ? codexValidationRepairPrompt(validationFeedback, turn, remainingMs)
          : isResume
            ? codexContinuationPrompt(turn, remainingMs)
            : prompt;
        validationFeedback = '';
        child.stdin.end(turnPrompt);

        let stdoutBuffer = '';
        child.stdout.on('data', (chunk) => {
          stdoutBuffer += String(chunk);
          const lines = stdoutBuffer.split('\n');
          stdoutBuffer = lines.pop() ?? '';
          lines.forEach(parseLine);
        });
        child.stderr.on('data', (chunk) => {
          stderr = (stderr + redact(String(chunk))).slice(-12000);
        });

        let turnTimedOut = false;
        let goalSnapshotAtTurnStart = threadId ? readCodexGoalSnapshot(threadId) : null;
        exitCode = await new Promise<number | null>((resolve, reject) => {
          let forceKill: NodeJS.Timeout | null = null;
          let stopping = false;
          const stopChild = (): void => {
            if (stopping) return;
            stopping = true;
            child.kill('SIGTERM');
            forceKill = setTimeout(() => child.kill('SIGKILL'), 10_000);
          };
          const timeout = setTimeout(() => {
            turnTimedOut = true;
            callbacks.onEvent(
              'worker_timeout',
              `Codex worker 达到 ${Math.round(effectiveTimeoutMs / 60000)} 分钟总时限，正在停止并检查已有产物`,
            );
            stopChild();
          }, remainingMs);
          const goalWatch = setInterval(() => {
            if (!threadId) return;
            const current = readCodexGoalSnapshot(threadId);
            if (!goalSnapshotAtTurnStart) {
              goalSnapshotAtTurnStart = current;
              return;
            }
            if (!shouldStopSettledGoalTurn(goalSnapshotAtTurnStart, current)) return;
            callbacks.onEvent(
              'codex_goal_turn_settled',
              `Codex 本轮已更新 Goal 为 ${current?.status ?? 'unknown'}，正在结束残留进程并继续检查产物`,
              {threadId, turn, goalStatus: current?.status},
            );
            stopChild();
          }, 2000);
          goalWatch.unref();
          const cleanUp = (): void => {
            clearTimeout(timeout);
            clearInterval(goalWatch);
            if (forceKill) clearTimeout(forceKill);
          };
          child.on('error', (error) => {
            cleanUp();
            if (turnTimedOut) resolve(null);
            else reject(error);
          });
          child.on('exit', (code) => {
            cleanUp();
            resolve(code);
          });
        });
        this.processes.delete(job.id);
        if (stdoutBuffer.trim()) parseLine(stdoutBuffer);
        reportArtifacts();
        if (callbacks.isCancelled()) throw new Error('任务已取消');
        if (completeArtifactsExist()) break;
        if (turnTimedOut) {
          timedOut = true;
          break;
        }
        const finalMessage = existsSync(finalMessagePath) ? readFileSync(finalMessagePath, 'utf8').trim() : '';
        const durationConstraintFailure = detectDurationConstraintFailure(
          finalMessage,
          job.durationSeconds,
          job.replicaMode,
        );
        const goalAfterTurn = threadId ? readCodexGoalSnapshot(threadId) : null;
        if (durationConstraintFailure) {
          callbacks.onEvent('codex_terminal_blocked', durationConstraintFailure, {
            reason: 'duration_constraint',
            requestedDurationSeconds: job.durationSeconds,
          });
          terminalError = new Error(durationConstraintFailure);
        } else if (goalAfterTurn?.status === 'blocked') {
          const message = 'Codex Goal 已阻塞，未生成完整成片；请查看任务日志中的必要告警';
          callbacks.onEvent('codex_terminal_blocked', message, {reason: 'goal_blocked'});
          terminalError = new Error(message);
        } else if (goalAfterTurn?.status === 'complete') {
          terminalError = missingOutputError(workspace);
        }
        if (
          !shouldContinueCodexGoal({
            hasCompleteArtifacts: completeArtifactsExist(),
            turnTimedOut,
            threadId,
            goalStatus: goalAfterTurn?.status ?? '',
            terminalConstraintFailure: Boolean(durationConstraintFailure),
          })
        ) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }
    } finally {
      clearInterval(artifactTimer);
      reportArtifacts();
      this.processes.delete(job.id);
    }

    if (callbacks.isCancelled()) throw new Error('任务已取消');
    if (terminalError) throw terminalError;
    const hasCompleteArtifacts = completeArtifactsExist();
    if (timedOut) {
      if (!hasCompleteArtifacts) {
        throw new Error(`Codex worker 超过 ${Math.round(effectiveTimeoutMs / 60000)} 分钟超时`);
      }
      callbacks.onEvent(
        'worker_timeout_recovered',
        'Codex 达到时限时完整产物已经写入，继续执行严格成片验收',
      );
    } else if (exitCode !== 0) {
      const detail = lastFailure || stderr.slice(-4000);
      if (!hasCompleteArtifacts) {
        throw new Error(detail ? `Codex worker 失败: ${detail}` : `Codex worker 退出码 ${exitCode}`);
      }
      callbacks.onEvent(
        'worker_exit_warning',
        'Codex 事件流在产物写入后中断，继续执行严格成片验收',
        detail ? {detail} : {exitCode},
      );
    }

    callbacks.onProgress('检查成片', 90);
    if (!existsSync(expected) || statSync(expected).size <= 1024) {
      throw missingOutputError(workspace);
    }

    if (!existsSync(manifestPath)) throw new Error('缺少结果清单 result.json');
    let manifest: ResultManifest;
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as ResultManifest;
    } catch {
      throw new Error('结果清单 result.json 不是有效 JSON');
    }
    if (manifest.presenterProvider !== 'InfiniteTalk') throw new Error('结果未声明使用 InfiniteTalk 真实口型');
    if (manifest.compositionRenderer !== 'Remotion') throw new Error('最终成片未声明使用 Remotion 编排');
    const manifestOutput = resolveWorkspacePath(workspace, manifest.outputPath, 'outputPath');
    if (manifestOutput !== expected) throw new Error('结果清单 outputPath 与最终成片路径不一致');
    const remotionEntry = resolveWorkspacePath(workspace, manifest.remotionEntryPath, 'remotionEntryPath');
    const remotionVisual = resolveWorkspacePath(workspace, manifest.remotionVisualPath, 'remotionVisualPath');
    if (!existsSync(remotionEntry) || statSync(remotionEntry).size <= 32) throw new Error('Remotion 入口文件不存在');
    validateRemotionImplementation(remotionEntry);
    if (!existsSync(remotionVisual) || statSync(remotionVisual).size <= 1024) {
      throw new Error('Remotion 视觉成片不存在');
    }
    if (hasAudioStream(remotionVisual)) throw new Error('Remotion 视觉母版不应包含音轨');
    if (videoStreamSha256(remotionVisual) !== videoStreamSha256(expected)) {
      throw new Error('最终视频流被 Remotion 之外的后处理修改；人物、遮罩和 UI 必须全部在 Remotion 内完成');
    }

    const marketingTitle = typeof manifest.marketingTitle === 'string' ? manifest.marketingTitle.trim() : '';
    const marketingDescription =
      typeof manifest.marketingDescription === 'string' ? manifest.marketingDescription.trim() : '';
    validateMarketingCopy(marketingTitle, marketingDescription);
    const cover = resolveWorkspacePath(workspace, manifest.coverPath, 'coverPath');
    if (!existsSync(cover) || statSync(cover).size <= 10_000) throw new Error('缺少高质量发布封面');
    const outputDimensions = probeDimensions(expected);
    const expectedLayout = resolvePresenterLayout(job);
    if (
      outputDimensions.width !== expectedLayout.final.width ||
      outputDimensions.height !== expectedLayout.final.height
    ) {
      throw new Error(
        `最终视频尺寸必须为 ${expectedLayout.final.width}x${expectedLayout.final.height}，当前为 ${outputDimensions.width}x${outputDimensions.height}`,
      );
    }
    const coverDimensions = probeDimensions(cover);
    if (coverDimensions.width !== outputDimensions.width || coverDimensions.height !== outputDimensions.height) {
      throw new Error('发布封面尺寸与最终视频画幅不一致');
    }

    const visualDesign = resolveWorkspacePath(workspace, manifest.visualDesignPath, 'visualDesignPath');
    if (!existsSync(visualDesign) || statSync(visualDesign).size <= 64) throw new Error('缺少视觉设计规范');
    validateVisualDesign(visualDesign);
    const finalReviewMontage = resolveWorkspacePath(
      workspace,
      manifest.finalReviewMontagePath,
      'finalReviewMontagePath',
    );
    if (!existsSync(finalReviewMontage) || statSync(finalReviewMontage).size <= 1024) {
      throw new Error('缺少最终成片四帧审查图');
    }
    const cueReviewMontage = resolveWorkspacePath(
      workspace,
      manifest.cueReviewMontagePath,
      'cueReviewMontagePath',
    );
    if (!existsSync(cueReviewMontage) || statSync(cueReviewMontage).size <= 1024) {
      throw new Error('缺少旁白视觉 cue 审查图');
    }
    let sourceReviewMontage: string | null = null;
    let sourceReviewFramePaths: string[] = [];
    if (job.mode === 'clone') {
      sourceReviewMontage = resolveWorkspacePath(
        workspace,
        manifest.sourceReviewMontagePath,
        'sourceReviewMontagePath',
      );
      if (!existsSync(sourceReviewMontage) || statSync(sourceReviewMontage).size <= 1024) {
        throw new Error('复刻任务缺少原片代表帧审查图');
      }
      sourceReviewFramePaths = validateMediaPaths(
        workspace,
        manifest.sourceReviewFramePaths,
        '原片代表帧',
        10,
      );
      const preflightReportPath = resolveWorkspacePath(
        workspace,
        manifest.preflightReportPath,
        'preflightReportPath',
      );
      if (!existsSync(preflightReportPath) || statSync(preflightReportPath).size <= 128) {
        throw new Error('复刻任务缺少 Remotion 前置质检报告');
      }
      const presenterSegmentCount = Math.max(
        1,
        Array.isArray(manifest.presenterSegmentPaths) ? manifest.presenterSegmentPaths.length : 1,
      );
      const preflight = validatePreflightReport(
        workspace,
        preflightReportPath,
        remotionVisual,
        sourceReviewFramePaths,
        presenterSegmentCount,
      );
      if (!job.assets.sourceVideo) throw new Error('复刻任务缺少原片路径');
      const sourceMeanLuma = measureSampledMeanLuma(job.assets.sourceVideo, 10);
      const storyboardMeanLuma = measureSampledMeanLuma(preflight.storyboardPreviewPath, 1);
      const finalMeanLuma = measureSampledMeanLuma(expected, 10);
      callbacks.onEvent('visual_luma_checked', '已完成原片、故事板与成片亮度风格对比', {
        sourceMeanLuma: Number(sourceMeanLuma.toFixed(1)),
        storyboardMeanLuma: Number(storyboardMeanLuma.toFixed(1)),
        finalMeanLuma: Number(finalMeanLuma.toFixed(1)),
      });
      if (isGrossLumaMismatch(sourceMeanLuma, storyboardMeanLuma)) {
        throw new Error(
          `前置故事板与原片明暗风格严重不符 (${sourceMeanLuma.toFixed(1)} -> ${storyboardMeanLuma.toFixed(1)})`,
        );
      }
      if (isGrossLumaMismatch(sourceMeanLuma, finalMeanLuma)) {
        throw new Error(
          `最终成片与原片明暗风格严重不符 (${sourceMeanLuma.toFixed(1)} -> ${finalMeanLuma.toFixed(1)})`,
        );
      }
    }
    const visualReviewPath = resolveWorkspacePath(workspace, manifest.visualReviewPath, 'visualReviewPath');
    if (!existsSync(visualReviewPath) || statSync(visualReviewPath).size <= 64) {
      throw new Error('缺少同一 Codex 会话的视觉审查结果');
    }
    let visualReview: VisualReview;
    try {
      visualReview = validateVisualReview(JSON.parse(readFileSync(visualReviewPath, 'utf8')));
    } catch (error) {
      if (error instanceof Error) throw error;
      throw new Error('视觉审查结果不是有效 JSON');
    }
    callbacks.onEvent('visual_review_completed', `同一 Codex 会话视觉审查 ${visualReview.score}/100`, {
      approved: visualReview.approved,
      score: visualReview.score,
      fatalIssues: visualReview.fatalIssues,
      issues: visualReview.issues,
      coverApproved: visualReview.coverApproved,
      coverScore: visualReview.coverScore,
      coverIssues: visualReview.coverIssues,
    });
    if (!visualReview.approved || visualReview.score < 90 || visualReview.fatalIssues.length) {
      const detail =
        visualReview.requiredFixes[0] ??
        visualReview.fatalIssues[0] ??
        visualReview.issues[0] ??
        '视觉风格未达到交付标准';
      throw new Error(`视觉质量审查未通过 (${visualReview.score}/100): ${detail}`);
    }
    if (!visualReview.coverApproved || visualReview.coverScore < 90) {
      throw new Error(
        `封面质量审查未通过 (${visualReview.coverScore}/100): ${visualReview.coverIssues[0] ?? '封面信息密度或视觉焦点不足'}`,
      );
    }

    const narration = resolveWorkspacePath(workspace, manifest.narrationPath, 'narrationPath');
    const narrationScript = resolveWorkspacePath(workspace, manifest.narrationScriptPath, 'narrationScriptPath');
    if (!existsSync(narration) || statSync(narration).size <= 1024) throw new Error('锁定的最终旁白不存在');
    if (!existsSync(narrationScript) || statSync(narrationScript).size <= 16) throw new Error('最终口播文案不存在');
    const narrationSha256 = fileSha256(narration);
    if (manifest.narrationSha256 !== narrationSha256) throw new Error('最终旁白 SHA-256 与结果清单不一致');
    const narrationDuration = probeDuration(narration);
    const narrationTimelinePath = resolveWorkspacePath(
      workspace,
      manifest.narrationTimelinePath,
      'narrationTimelinePath',
    );
    if (!existsSync(narrationTimelinePath) || statSync(narrationTimelinePath).size <= 64) {
      throw new Error('缺少基于最终音频的旁白时间轴');
    }
    let narrationTimeline: NarrationTimeline;
    try {
      narrationTimeline = validateNarrationTimeline(
        JSON.parse(readFileSync(narrationTimelinePath, 'utf8')),
        narrationDuration,
      );
    } catch (error) {
      if (error instanceof Error) throw error;
      throw new Error('旁白时间轴不是有效 JSON');
    }
    const scriptText = readFileSync(narrationScript, 'utf8');
    if (job.voiceMode !== 'uploaded_audio') {
      validateNarrationClosing(scriptText);
      validatePronunciationArtifacts(workspace, manifest, scriptText);
    }
    const captionTimelinePath = resolveWorkspacePath(
      workspace,
      manifest.captionTimelinePath,
      'captionTimelinePath',
    );
    if (!existsSync(captionTimelinePath) || statSync(captionTimelinePath).size <= 64) {
      throw new Error('缺少完整字幕时间轴 caption_timeline.json');
    }
    let captionTimeline: CaptionTimeline;
    try {
      captionTimeline = validateCaptionTimeline(JSON.parse(readFileSync(captionTimelinePath, 'utf8')), {
        narrationDuration,
        narrationScript: scriptText,
      });
    } catch (error) {
      if (error instanceof Error) throw error;
      throw new Error('完整字幕时间轴不是有效 JSON');
    }
    validateRemotionQualityBinding(remotionEntry, captionTimeline);
    if (job.mode === 'clone') {
      const sourceTranscript = resolveWorkspacePath(workspace, manifest.sourceTranscriptPath, 'sourceTranscriptPath');
      const expectedTranscript = path.join(workspace, 'out', 'analysis', 'source_transcript.json');
      if (sourceTranscript !== expectedTranscript || !existsSync(sourceTranscript)) {
        throw new Error('复刻任务没有使用 worker 生成的原片转写');
      }
      let transcriptData: {
        text?: unknown;
        durationSeconds?: unknown;
        segments?: unknown;
        sourceSha256?: unknown;
        sourceSizeBytes?: unknown;
      };
      try {
        transcriptData = JSON.parse(readFileSync(sourceTranscript, 'utf8')) as typeof transcriptData;
      } catch {
        throw new Error('worker 生成的原片转写不是有效 JSON');
      }
      const expectedTranscriptSha256 = String(job.metadata.sourceTranscriptSha256 ?? '');
      const transcriptHashMatchesMetadata =
        /^[a-f0-9]{64}$/.test(expectedTranscriptSha256) && fileSha256(sourceTranscript) === expectedTranscriptSha256;
      const legacyVisualRepairProvenanceMatches =
        job.metadata.visualRepairOnly === true &&
        Boolean(job.assets.sourceVideo) &&
        existsSync(job.assets.sourceVideo!) &&
        transcriptData.sourceSha256 === fileSha256(job.assets.sourceVideo!) &&
        Number(transcriptData.sourceSizeBytes) === statSync(job.assets.sourceVideo!).size;
      if (!transcriptHashMatchesMetadata && !legacyVisualRepairProvenanceMatches) {
        throw new Error('worker 生成的原片转写被修改或校验信息缺失');
      }
      const transcriptText = typeof transcriptData.text === 'string' ? transcriptData.text.trim() : '';
      const transcriptDuration = Number(transcriptData.durationSeconds);
      if (transcriptText.length < 20 || !Array.isArray(transcriptData.segments) || !transcriptData.segments.length) {
        throw new Error('worker 生成的原片转写内容不足');
      }
      const sourceAnalysis = resolveWorkspacePath(workspace, manifest.sourceAnalysisPath, 'sourceAnalysisPath');
      if (!existsSync(sourceAnalysis) || statSync(sourceAnalysis).size <= 64) throw new Error('复刻任务缺少原片内容分析');
      const productionMarkers = [
        '处理旧字幕',
        '新旁白',
        '对口型数字人',
        '固定区域',
        '新成片',
        '录屏证据',
        '这次我们不做一条纯口播复刻',
      ];
      if (productionMarkers.filter((marker) => scriptText.includes(marker)).length >= 2) {
        throw new Error('口播文案错误地描述了视频制作流程，而不是复刻原片内容');
      }
      const overlap = contentOverlapRatio(scriptText, transcriptText);
      if (!Number.isFinite(overlap) || overlap < 0.12) {
        throw new Error(`口播文案与原片转写内容关联不足 (${overlap.toFixed(3)})`);
      }
      if (job.replicaMode === 'exact') {
        const sourceCoverage = contentOverlapRatio(transcriptText, scriptText);
        const scriptLength = scriptText.replace(/\s+/g, '').length;
        const transcriptLength = transcriptText.replace(/\s+/g, '').length;
        if (sourceCoverage < 0.55 || scriptLength < transcriptLength * 0.65) {
          throw new Error(
            `完整复刻删减了原片内容 (coverage=${sourceCoverage.toFixed(3)}, length=${scriptLength}/${transcriptLength})`,
          );
        }
      }
      let analysis: {
        sourceTopic?: unknown;
        sourceTranscriptPath?: unknown;
        selectedClips?: unknown;
      };
      try {
        analysis = JSON.parse(readFileSync(sourceAnalysis, 'utf8')) as typeof analysis;
      } catch {
        throw new Error('原片内容分析不是有效 JSON');
      }
      const analysisTranscript = resolveWorkspacePath(
        workspace,
        analysis.sourceTranscriptPath,
        'sourceAnalysis.sourceTranscriptPath',
      );
      if (analysisTranscript !== expectedTranscript) throw new Error('原片内容分析没有引用 worker 转写');
      if (typeof analysis.sourceTopic !== 'string' || analysis.sourceTopic.trim().length < 2) {
        throw new Error('原片内容分析缺少真实主题');
      }
      if (!Array.isArray(analysis.selectedClips) || analysis.selectedClips.length === 0) {
        throw new Error('原片内容分析缺少语义选片依据');
      }
      for (const [index, value] of analysis.selectedClips.entries()) {
        const clip = value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
        const start = Number(clip.startSeconds);
        const end = Number(clip.endSeconds);
        const sourceText = typeof clip.sourceText === 'string' ? clip.sourceText.trim() : '';
        const purpose = typeof clip.narrationPurpose === 'string' ? clip.narrationPurpose.trim() : '';
        if (
          !Number.isFinite(start) ||
          !Number.isFinite(end) ||
          start < 0 ||
          end <= start ||
          end > transcriptDuration + 2 ||
          sourceText.length < 4 ||
          purpose.length < 2 ||
          contentOverlapRatio(sourceText, transcriptText) < 0.5
        ) {
          throw new Error(`原片第 ${index + 1} 个选用片段缺少有效的时间戳或转写依据`);
        }
      }
      const narrationVisualMapPath = resolveWorkspacePath(
        workspace,
        manifest.narrationVisualMapPath,
        'narrationVisualMapPath',
      );
      if (!existsSync(narrationVisualMapPath) || statSync(narrationVisualMapPath).size <= 128) {
        throw new Error('复刻任务缺少句级旁白视觉映射');
      }
      const presenterSegmentCount = Array.isArray(manifest.presenterSegmentPaths)
        ? manifest.presenterSegmentPaths.length
        : 1;
      let narrationVisualMap: NarrationVisualMap;
      try {
        narrationVisualMap = validateNarrationVisualMap(JSON.parse(readFileSync(narrationVisualMapPath, 'utf8')), {
          narrationDuration,
          narrationScript: scriptText,
          sourceTranscript: transcriptText,
          sourceDuration: transcriptDuration,
          exact: job.replicaMode === 'exact',
          presenterSegmentCount,
        });
      } catch (error) {
        if (error instanceof Error) throw error;
        throw new Error('旁白视觉映射不是有效 JSON');
      }
      const sceneImplementationPath = resolveWorkspacePath(
        workspace,
        manifest.sceneImplementationPath,
        'sceneImplementationPath',
      );
      if (!existsSync(sceneImplementationPath) || statSync(sceneImplementationPath).size <= 128) {
        throw new Error('复刻任务缺少逐 cue 场景实现清单');
      }
      let sceneImplementation: SceneImplementation;
      try {
        sceneImplementation = validateSceneImplementation(
          JSON.parse(readFileSync(sceneImplementationPath, 'utf8')),
          narrationVisualMap,
        );
      } catch (error) {
        if (error instanceof Error) throw error;
        throw new Error('逐 cue 场景实现清单不是有效 JSON');
      }
      const sceneContractReportPath = resolveWorkspacePath(
        workspace,
        manifest.sceneContractReportPath,
        'sceneContractReportPath',
      );
      if (!existsSync(sceneContractReportPath) || statSync(sceneContractReportPath).size <= 64) {
        throw new Error('复刻任务缺少场景语义与布局硬校验报告');
      }
      try {
        const report = JSON.parse(readFileSync(sceneContractReportPath, 'utf8')) as Record<string, unknown>;
        if (report.valid !== true || Number(report.cueCount) !== narrationVisualMap.cues.length) {
          throw new Error();
        }
      } catch {
        throw new Error('场景语义与布局硬校验报告无效');
      }
      validateRemotionQualityBinding(remotionEntry, captionTimeline, sceneImplementation);

      const sourceEvidenceCueCount = narrationVisualMap.cues.filter((cue) => cue.sourceVideoEvidence).length;
      if (sourceEvidenceCueCount) {
        const sourceEvidenceReviewFramePaths = validateMediaPaths(
          workspace,
          manifest.sourceEvidenceReviewFramePaths,
          '原片证据裁切后审查帧',
          sourceEvidenceCueCount,
        );
        if (sourceEvidenceReviewFramePaths.length !== sourceEvidenceCueCount) {
          throw new Error(
            `原片证据审查帧必须逐 source_video_pip cue 覆盖 (${sourceEvidenceReviewFramePaths.length}/${sourceEvidenceCueCount})`,
          );
        }
      }

      const cueReviewFramePaths = validateMediaPaths(
        workspace,
        manifest.cueReviewFramePaths,
        '旁白视觉 cue 审查帧',
        narrationVisualMap.cues.length,
      );
      if (cueReviewFramePaths.length !== narrationVisualMap.cues.length) {
        throw new Error(`旁白视觉 cue 审查帧数量必须与 cue 一致 (${cueReviewFramePaths.length}/${narrationVisualMap.cues.length})`);
      }
      const diversity = validateCueVisualDiversity(sourceReviewFramePaths, cueReviewFramePaths);

      const longCueCount = narrationVisualMap.cues.filter(
        (cue) => cue.outputEndSeconds - cue.outputStartSeconds > 4,
      ).length;
      const motionReviewFramePaths = longCueCount
        ? validateMediaPaths(
            workspace,
            manifest.motionReviewFramePaths,
            'cue 25%/75% 动效审查帧',
            longCueCount * 2,
          )
        : [];
      if (longCueCount && motionReviewFramePaths.length !== longCueCount * 2) {
        throw new Error(
          `cue 动效审查帧数量必须为长 cue 数量的两倍 (${motionReviewFramePaths.length}/${longCueCount * 2})`,
        );
      }
      const motion = validateCueMotionPairs(motionReviewFramePaths);
      validateMediaPaths(
        workspace,
        manifest.collisionReviewFramePaths,
        'cue 入场/叠层峰值/退出碰撞审查帧',
        narrationVisualMap.cues.length * 3,
      );
      callbacks.onEvent('replica_quality_checked', '已完成字幕、场景多样性与 cue 内持续动效硬校验', {
        captionCount: captionTimeline.segments.length,
        sourceUniqueRatio: Number(diversity.sourceUniqueRatio.toFixed(3)),
        cueUniqueRatio: Number(diversity.cueUniqueRatio.toFixed(3)),
        motionPairCount: motion.pairCount,
        movingPairCount: motion.movingPairCount,
      });
    }
    const actualDuration = probeDuration(expected);
    const declaredDuration = Number(manifest.durationSeconds);
    if (!Number.isFinite(declaredDuration) || Math.abs(declaredDuration - actualDuration) > 1.5) {
      throw new Error('结果清单时长与最终 MP4 不一致');
    }
    if (Math.abs(actualDuration - narrationDuration) > 0.5) {
      throw new Error('最终视频时长与锁定旁白不一致');
    }
    const audioSimilarity = measureAudioSimilarity(narration, expected);
    if (!Number.isFinite(audioSimilarity) || audioSimilarity < 0.97) {
      throw new Error(`最终 MP4 音轨与锁定旁白不一致 (${audioSimilarity.toFixed(3)})`);
    }
    const durationTolerance = job.voiceMode === 'uploaded_audio' ? 2 : 0.5;
    if (job.voiceMode === 'uploaded_audio' && Math.abs(actualDuration - job.durationSeconds) > durationTolerance) {
      throw new Error(`最终视频时长 ${actualDuration.toFixed(1)} 秒，与上传口播音频不一致`);
    }
    if (
      job.mode === 'clone' &&
      job.replicaMode === 'exact' &&
      Math.abs(actualDuration - job.durationSeconds) > Math.max(5, job.durationSeconds * 0.15)
    ) {
      throw new Error(`完整复刻时长 ${actualDuration.toFixed(1)} 秒，与原片 ${job.durationSeconds} 秒差异过大`);
    }
    if (
      !(job.mode === 'clone' && job.replicaMode === 'exact') &&
      job.voiceMode !== 'uploaded_audio' &&
      actualDuration > job.durationSeconds + durationTolerance
    ) {
      throw new Error(`最终视频时长 ${actualDuration.toFixed(1)} 秒，超过最长 ${job.durationSeconds} 秒`);
    }
    const presenterSource = resolveWorkspacePath(workspace, manifest.presenterSourcePath, 'presenterSourcePath');
    if (!existsSync(presenterSource) || statSync(presenterSource).size <= 1024) {
      throw new Error('InfiniteTalk 返回的数字人成片不存在');
    }

    const rawSegments = Array.isArray(manifest.presenterSegmentPaths) ? manifest.presenterSegmentPaths : [];
    const rawReceipts = Array.isArray(manifest.infiniteTalkReceiptPaths) ? manifest.infiniteTalkReceiptPaths : [];
    const presenterRenderPaths = validateMediaPaths(
      workspace,
      manifest.presenterRenderPaths,
      'Remotion 数字人规范化素材',
      Math.max(1, rawSegments.length),
    );
    if (presenterRenderPaths.length !== Math.max(1, rawSegments.length)) {
      throw new Error('Remotion 数字人规范化素材数量与 InfiniteTalk 原始分段不一致');
    }
    const presenterLayout = resolvePresenterLayout(job);
    for (const renderPath of presenterRenderPaths) {
      const dimensions = probeDimensions(renderPath);
      if (
        dimensions.width !== presenterLayout.normalized.width ||
        dimensions.height !== presenterLayout.normalized.height
      ) {
        throw new Error(
          `Remotion 数字人规范化素材必须为 ${presenterLayout.normalized.width}x${presenterLayout.normalized.height}`,
        );
      }
      if (hasAudioStream(renderPath)) throw new Error('Remotion 数字人规范化素材不应包含音轨');
    }
    if (rawSegments.length || rawReceipts.length) {
      if (!rawSegments.length || rawSegments.length !== rawReceipts.length) {
        throw new Error('InfiniteTalk 分段视频和回执数量不一致');
      }
      const promptIds = new Set<string>();
      const segmentHashes = new Set<string>();
      const receiptAudioHashes: string[] = [];
      const actualSegmentHashes: string[] = [];
      rawSegments.forEach((candidate, index) => {
        const segment = resolveWorkspacePath(workspace, candidate, `presenterSegmentPaths[${index}]`);
        const receipt = resolveWorkspacePath(workspace, rawReceipts[index], `infiniteTalkReceiptPaths[${index}]`);
        if (!existsSync(segment) || statSync(segment).size <= 1024) {
          throw new Error(`InfiniteTalk 第 ${index + 1} 段成片不存在`);
        }
        const receiptData = validateInfiniteTalkReceipt(receipt, segment);
        if (promptIds.has(receiptData.promptId)) throw new Error('InfiniteTalk 分段复用了同一个 prompt_id');
        promptIds.add(receiptData.promptId);
        receiptAudioHashes.push(receiptData.audioSha256);
        const segmentHash = fileSha256(segment);
        if (segmentHashes.has(segmentHash)) throw new Error('InfiniteTalk 返回了重复的分段视频，口型可能不同步');
        segmentHashes.add(segmentHash);
        actualSegmentHashes.push(segmentHash);
      });
      const checkpointManifestPath = path.join(workspace, 'out', 'checkpoints', 'infinite_talk', 'segments.json');
      if (!existsSync(checkpointManifestPath)) throw new Error('缺少 InfiniteTalk 分段清单 segments.json');
      const checkpointManifest = JSON.parse(readFileSync(checkpointManifestPath, 'utf8')) as {
        audio_sha256?: unknown;
        promptIds?: unknown;
        segmentAudioSha256s?: unknown;
        segmentVideoSha256s?: unknown;
      };
      if (checkpointManifest.audio_sha256 !== narrationSha256) {
        throw new Error('InfiniteTalk 分段并非由锁定的最终旁白生成');
      }
      if (
        !Array.isArray(checkpointManifest.segmentAudioSha256s) ||
        checkpointManifest.segmentAudioSha256s.map(String).join('\n') !== receiptAudioHashes.join('\n')
      ) {
        throw new Error('InfiniteTalk 分段音频 SHA-256 与回执不一致');
      }
      if (
        !Array.isArray(checkpointManifest.promptIds) ||
        checkpointManifest.promptIds.map(String).join('\n') !== [...promptIds].join('\n')
      ) {
        throw new Error('InfiniteTalk 分段 prompt_id 与检查点清单不一致');
      }
      if (
        !Array.isArray(checkpointManifest.segmentVideoSha256s) ||
        checkpointManifest.segmentVideoSha256s.map(String).join('\n') !== actualSegmentHashes.join('\n')
      ) {
        throw new Error('InfiniteTalk 分段视频 SHA-256 与检查点清单不一致');
      }
    } else {
      const receiptPath = resolveWorkspacePath(workspace, manifest.infiniteTalkReceiptPath, 'infiniteTalkReceiptPath');
      const receiptData = validateInfiniteTalkReceipt(receiptPath, presenterSource);
      if (receiptData.audioSha256 !== narrationSha256) {
        throw new Error('InfiniteTalk 单段视频并非由锁定的最终旁白生成');
      }
    }
    return expected;
  }
}
