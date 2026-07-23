import type {AspectRatio, JobRecord} from './types.js';

export type Dimensions = {width: number; height: number};

export type PresenterLayout = {
  final: Dimensions;
  model: Dimensions;
  normalized: Dimensions;
  normalizationLayout: 'square' | 'portrait' | 'landscape';
  followsAvatar: boolean;
};

const FIXED_FINAL_DIMENSIONS: Record<Exclude<AspectRatio, 'avatar'>, Dimensions> = {
  '16:9': {width: 1920, height: 1080},
  '9:16': {width: 1080, height: 1920},
  '1:1': {width: 1080, height: 1080},
};

const toEven = (value: number): number => Math.ceil(value / 2) * 2;
const toModelMultiple = (value: number): number => Math.max(256, Math.round(value / 16) * 16);

const parseAvatarDimensions = (value: unknown): Dimensions | null => {
  if (!value || typeof value !== 'object') return null;
  const candidate = value as {width?: unknown; height?: unknown};
  const width = Number(candidate.width);
  const height = Number(candidate.height);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) return null;
  return {width, height};
};

export const calculateModelDimensions = ({width, height}: Dimensions): Dimensions => {
  const ratio = width / height;
  const targetArea = 832 * 480;
  return {
    width: toModelMultiple(Math.sqrt(targetArea * ratio)),
    height: toModelMultiple(Math.sqrt(targetArea / ratio)),
  };
};

const calculateNormalizedDimensions = ({width, height}: Dimensions): Dimensions => {
  const scale = 720 / Math.min(width, height);
  return {width: toEven(width * scale), height: toEven(height * scale)};
};

export const resolvePresenterLayout = (job: Pick<JobRecord, 'aspectRatio' | 'style' | 'metadata'>): PresenterLayout => {
  const presenterPrimary = job.style === '真人主画面·悬浮组件';
  const followsAvatar = job.aspectRatio === 'avatar';
  const avatarDimensions = parseAvatarDimensions(job.metadata.avatarDimensions);
  if (followsAvatar && !avatarDimensions) throw new Error('跟随人物图画幅缺少有效的原图尺寸');

  const final = followsAvatar
    ? {width: toEven(avatarDimensions!.width), height: toEven(avatarDimensions!.height)}
    : FIXED_FINAL_DIMENSIONS[job.aspectRatio as Exclude<AspectRatio, 'avatar'>];
  const model = followsAvatar
    ? calculateModelDimensions(final)
    : presenterPrimary && job.aspectRatio === '16:9'
      ? {width: 832, height: 480}
      : job.aspectRatio === '1:1'
        ? {width: 640, height: 640}
        : {width: 480, height: 832};
  const normalized = presenterPrimary ? calculateNormalizedDimensions(model) : {width: 640, height: 640};
  const normalizationLayout = !presenterPrimary || normalized.width === normalized.height
    ? 'square'
    : normalized.width > normalized.height
      ? 'landscape'
      : 'portrait';

  return {final, model, normalized, normalizationLayout, followsAvatar};
};
