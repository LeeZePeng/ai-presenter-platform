import type {AspectRatio, PublishingPlatform} from './types.js';

export const publishingPlatformLabels: Record<PublishingPlatform, string> = {
  original: '原尺寸母版',
  douyin: '抖音',
  wechat_channels: '视频号',
  bilibili: 'B站',
};

export const resolvePublishingAspectRatio = (
  platform: PublishingPlatform,
  requested: AspectRatio,
): AspectRatio => {
  if (platform === 'douyin' || platform === 'wechat_channels') return '9:16';
  if (platform === 'bilibili') return '16:9';
  return requested;
};
