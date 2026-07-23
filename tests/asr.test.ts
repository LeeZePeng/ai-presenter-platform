import {describe, expect, it} from 'vitest';
import {normalizeOpenAiTranscript, normalizeWhisperTranscript, whisperProgressPercent} from '../server/asr.js';

describe('normalizeWhisperTranscript', () => {
  it('normalizes whisper.cpp timestamps and text', () => {
    const result = normalizeWhisperTranscript({
      result: {language: 'zh'},
      transcription: [
        {
          timestamps: {from: '00:00:01,250', to: '00:00:03,500'},
          offsets: {from: 1250, to: 3500},
          text: ' 大家好 ',
        },
        {
          timestamps: {from: '00:00:03,500', to: '00:00:06,000'},
          text: '今天聊一个工具。',
        },
      ],
    });

    expect(result.language).toBe('zh');
    expect(result.text).toBe('大家好 今天聊一个工具。');
    expect(result.segments).toEqual([
      {startSeconds: 1.25, endSeconds: 3.5, text: '大家好'},
      {startSeconds: 3.5, endSeconds: 6, text: '今天聊一个工具。'},
    ]);
  });

  it('falls back to millisecond offsets', () => {
    const result = normalizeWhisperTranscript({
      transcription: [{offsets: {from: 500, to: 1500}, text: 'hello world'}],
    });
    expect(result.segments[0]).toEqual({startSeconds: 0.5, endSeconds: 1.5, text: 'hello world'});
  });
});

describe('normalizeOpenAiTranscript', () => {
  it('normalizes ModelVerse whisper-1 verbose JSON segments', () => {
    const result = normalizeOpenAiTranscript({
      task: 'transcribe',
      language: 'chinese',
      duration: 5.47,
      text: '这是云端语音转写测试 数字人平台正在验证时间戳',
      segments: [
        {id: 0, start: 0, end: 2.6, text: '这是云端语音转写测试'},
        {id: 1, start: 2.6, end: 5.6, text: ' 数字人平台正在验证时间戳 '},
      ],
    });

    expect(result.language).toBe('chinese');
    expect(result.text).toBe('这是云端语音转写测试 数字人平台正在验证时间戳');
    expect(result.segments).toEqual([
      {startSeconds: 0, endSeconds: 2.6, text: '这是云端语音转写测试'},
      {startSeconds: 2.6, endSeconds: 5.6, text: '数字人平台正在验证时间戳'},
    ]);
  });

  it('drops malformed or backwards cloud segments', () => {
    const result = normalizeOpenAiTranscript({
      language: 'zh',
      segments: [
        {start: -1, end: 1, text: 'negative'},
        {start: 3, end: 2, text: 'backwards'},
        {start: 1, end: 2, text: '保留'},
      ],
    });
    expect(result.segments).toEqual([{startSeconds: 1, endSeconds: 2, text: '保留'}]);
  });
});

describe('whisperProgressPercent', () => {
  it('returns the newest bounded whisper.cpp progress value', () => {
    expect(whisperProgressPercent('progress =  10%\nprogress =  45%')).toBe(45);
    expect(whisperProgressPercent('no progress here')).toBeNull();
    expect(whisperProgressPercent('progress = 120%')).toBe(100);
  });
});
