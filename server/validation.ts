import {z} from 'zod';
import type {JobAssets, JobCreateInput} from './types.js';

export const isExactReplicaAudioDurationCompatible = (
  sourceDurationSeconds: number,
  audioDurationSeconds: number,
): boolean =>
  Math.abs(sourceDurationSeconds - audioDurationSeconds) <= Math.max(5, sourceDurationSeconds * 0.15);

const formSchema = z.object({
  title: z.string().trim().min(2, '请填写任务名称').max(80),
  mode: z.enum(['topic', 'script', 'clone']),
  replicaMode: z.enum(['exact', 'condensed']).default('exact'),
  topic: z.string().trim().max(2000).default(''),
  script: z.string().trim().max(10000).default(''),
  durationSeconds: z.coerce.number().int().min(1).max(1800).default(120),
  aspectRatio: z.enum(['16:9', '9:16', '1:1', 'avatar']),
  style: z.string().trim().min(1).max(100),
  voiceMode: z.enum(['original_clone', 'uploaded_audio', 'uploaded_reference', 'system_voice']).optional(),
  rightsConfirmed: z
    .union([z.literal('true'), z.literal('1'), z.literal('on'), z.boolean()])
    .transform((value) => value === true || value === 'true' || value === '1' || value === 'on'),
});

export const parseJobInput = (body: Record<string, unknown>, assets: JobAssets): JobCreateInput => {
  const parsed = formSchema.parse(body);
  const voiceMode = parsed.voiceMode ?? (assets.voiceReference ? 'uploaded_reference' : parsed.mode === 'clone' ? 'original_clone' : 'system_voice');
  if (!parsed.rightsConfirmed) throw new Error('必须确认拥有形象、声音和参考素材的使用权');
  if (voiceMode !== 'uploaded_audio' && parsed.durationSeconds < 5) {
    throw new Error('最长时长不能少于 5 秒');
  }
  if (parsed.mode === 'topic' && !parsed.topic) throw new Error('主题创作模式需要填写视频主题');
  if (parsed.mode === 'script' && !parsed.script) throw new Error('已有文案模式需要填写口播文案');
  if (parsed.mode === 'clone' && !assets.sourceVideo) throw new Error('复刻模式需要上传参考视频');
  if (parsed.style === '真人主画面·悬浮组件' && !assets.avatarImage) {
    throw new Error('“真人主画面·悬浮组件”需要上传或选择人物图片');
  }
  if (parsed.aspectRatio === 'avatar' && parsed.style !== '真人主画面·悬浮组件') {
    throw new Error('“跟随人物图”画幅仅支持真人主画面风格');
  }
  if (!assets.avatarImage && !assets.sourceVideo) throw new Error('请上传人物形象图片或参考视频');
  if (voiceMode === 'original_clone' && !assets.sourceVideo) {
    throw new Error('克隆原片声音需要上传带人声的参考视频');
  }
  if (voiceMode === 'uploaded_reference' && !assets.voiceReference) {
    throw new Error('上传参考音色模式需要提供 5-30 秒人声文件');
  }
  if (voiceMode === 'uploaded_audio' && !assets.voiceReference) {
    throw new Error('直接使用口播音频需要上传 MP3、WAV 或 M4A 文件');
  }
  return {...parsed, voiceMode, replicaMode: parsed.mode === 'clone' ? parsed.replicaMode : 'condensed', assets};
};
