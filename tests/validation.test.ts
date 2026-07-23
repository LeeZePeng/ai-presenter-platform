import {describe, expect, it} from 'vitest';
import {
  isExactReplicaAudioDurationCompatible,
  parseJobInput,
} from '../server/validation.js';

const base = {
  title: '测试任务',
  mode: 'topic',
  topic: '介绍一款 AI 产品',
  script: '',
  durationSeconds: '15',
  aspectRatio: '16:9',
  style: '自然专业',
  voiceMode: 'system_voice',
  rightsConfirmed: 'true',
};

describe('parseJobInput', () => {
  it('accepts a topic job with an avatar image', () => {
    const result = parseJobInput(base, {avatarImage: '/tmp/avatar.png'});
    expect(result.durationSeconds).toBe(15);
    expect(result.mode).toBe('topic');
    expect(result.replicaMode).toBe('condensed');
  });

  it('uses the platform maximum when duration is omitted', () => {
    const {durationSeconds: _durationSeconds, ...withoutDuration} = base;
    const result = parseJobInput(withoutDuration, {avatarImage: '/tmp/avatar.png'});
    expect(result.durationSeconds).toBe(120);
  });

  it('requires a source video for clone mode', () => {
    expect(() => parseJobInput({...base, mode: 'clone'}, {avatarImage: '/tmp/avatar.png'})).toThrow(
      '复刻模式需要上传参考视频',
    );
  });

  it('requires an uploaded or saved avatar for presenter-primary composition', () => {
    expect(() =>
      parseJobInput(
        {...base, mode: 'clone', style: '真人主画面·悬浮组件'},
        {sourceVideo: '/tmp/source.mp4'},
      ),
    ).toThrow('需要上传或选择人物图片');
    expect(
      parseJobInput(
        {...base, mode: 'clone', style: '真人主画面·悬浮组件'},
        {sourceVideo: '/tmp/source.mp4', avatarImage: '/tmp/avatar.png'},
      ).assets.avatarImage,
    ).toBe('/tmp/avatar.png');
  });

  it('defaults clone jobs to exact replication and supports explicit condensation', () => {
    const exact = parseJobInput({...base, mode: 'clone'}, {sourceVideo: '/tmp/source.mp4'});
    const condensed = parseJobInput(
      {...base, mode: 'clone', replicaMode: 'condensed'},
      {sourceVideo: '/tmp/source.mp4'},
    );
    expect(exact.replicaMode).toBe('exact');
    expect(condensed.replicaMode).toBe('condensed');
  });

  it('requires rights confirmation', () => {
    expect(() => parseJobInput({...base, rightsConfirmed: 'false'}, {avatarImage: '/tmp/avatar.png'})).toThrow();
  });

  it('accepts a short uploaded narration and requires its audio asset', () => {
    const result = parseJobInput(
      {...base, durationSeconds: '3', voiceMode: 'uploaded_audio'},
      {avatarImage: '/tmp/avatar.png', voiceReference: '/tmp/narration.mp3'},
    );
    expect(result.durationSeconds).toBe(3);
    expect(() =>
      parseJobInput({...base, durationSeconds: '3', voiceMode: 'uploaded_audio'}, {avatarImage: '/tmp/avatar.png'}),
    ).toThrow('需要上传 MP3、WAV 或 M4A');
  });

  it('defaults uploaded audio to a cloned voice reference', () => {
    const {voiceMode: _voiceMode, ...withoutVoiceMode} = base;
    const result = parseJobInput(withoutVoiceMode, {
      avatarImage: '/tmp/avatar.png',
      voiceReference: '/tmp/reference.wav',
    });
    expect(result.voiceMode).toBe('uploaded_reference');
  });

  it('accepts any condensed target at or above the technical minimum', () => {
    const result = parseJobInput(
      {...base, mode: 'clone', replicaMode: 'condensed', durationSeconds: '5'},
      {sourceVideo: '/tmp/very-long-source.mp4'},
    );
    expect(result.durationSeconds).toBe(5);
    expect(() =>
      parseJobInput(
        {...base, mode: 'clone', replicaMode: 'condensed', durationSeconds: '4'},
        {sourceVideo: '/tmp/very-long-source.mp4'},
      ),
    ).toThrow('最长时长不能少于 5 秒');
  });

  it('checks direct narration duration against an exact replica', () => {
    expect(isExactReplicaAudioDurationCompatible(120, 110)).toBe(true);
    expect(isExactReplicaAudioDurationCompatible(120, 60)).toBe(false);
    expect(isExactReplicaAudioDurationCompatible(20, 15)).toBe(true);
    expect(isExactReplicaAudioDurationCompatible(20, 14)).toBe(false);
  });
});
