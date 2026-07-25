import {describe, expect, it} from 'vitest';
import {probeQwenTtsHealth} from '../server/qwen-tts-health.js';

describe('probeQwenTtsHealth', () => {
  it('reports managed Qwen VC as configured without consuming synthesis quota', async () => {
    await expect(probeQwenTtsHealth({
      baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
      apiToken: 'configured',
      model: 'qwen3-tts-vc-2026-01-22',
    })).resolves.toEqual({
      configured: true,
      status: 'ready',
      model: 'qwen3-tts-vc-2026-01-22',
      message: '阿里云千问参考音色已配置（合成时验证）',
    });
  });

  it('requires the DashScope key', async () => {
    const snapshot = await probeQwenTtsHealth({
      baseUrl: 'https://dashscope.aliyuncs.com/api/v1',
      apiToken: '',
      model: 'qwen3-tts-vc-2026-01-22',
    });
    expect(snapshot.status).toBe('unconfigured');
    expect(snapshot.model).toBeNull();
  });

  it('rejects a private or different TTS model configuration', async () => {
    const snapshot = await probeQwenTtsHealth({
      baseUrl: 'http://gpu/qwen-tts/v1',
      apiToken: 'configured',
      model: 'Qwen3-TTS-12Hz-1.7B-Base',
    });
    expect(snapshot.status).toBe('misconfigured');
    expect(snapshot.message).toContain('qwen3-tts-vc-2026-01-22');
  });
});
