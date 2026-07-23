import {describe, expect, it} from 'vitest';
import {normalizeWhisperTranscript, whisperProgressPercent} from '../server/asr.js';

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

describe('whisperProgressPercent', () => {
  it('returns the newest bounded whisper.cpp progress value', () => {
    expect(whisperProgressPercent('progress =  10%\nprogress =  45%')).toBe(45);
    expect(whisperProgressPercent('no progress here')).toBeNull();
    expect(whisperProgressPercent('progress = 120%')).toBe(100);
  });
});
