import {describe, expect, it, vi} from 'vitest';
import {probeQwenTtsHealth, qwenTtsHealthUrl} from '../server/qwen-tts-health.js';

describe('probeQwenTtsHealth', () => {
  it('does not issue a request before the private token is configured', async () => {
    const fetchImpl = vi.fn();
    const snapshot = await probeQwenTtsHealth({
      baseUrl: 'http://gpu/qwen-tts/v1',
      apiToken: '',
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(snapshot.status).toBe('unconfigured');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('reports a ready authenticated Base clone service without exposing the token', async () => {
    let observedAuthorization = '';
    const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
      observedAuthorization = new Headers(init?.headers).get('authorization') ?? '';
      return {
        ok: true,
        status: 200,
        json: async () => ({status: 'ready', model: 'Qwen3-TTS-12Hz-1.7B-Base'}),
      } as Response;
    }) as typeof fetch;
    const snapshot = await probeQwenTtsHealth({
      baseUrl: 'http://gpu/qwen-tts/v1/',
      apiToken: 'private-test-token',
      fetchImpl,
    });
    expect(qwenTtsHealthUrl('http://gpu/qwen-tts/v1/')).toBe('http://gpu/qwen-tts/v1/health');
    expect(observedAuthorization).toBe('Bearer private-test-token');
    expect(snapshot).toEqual({
      configured: true,
      status: 'ready',
      model: 'Qwen3-TTS-12Hz-1.7B-Base',
      message: 'Qwen 参考音色克隆已就绪',
    });
    expect(JSON.stringify(snapshot)).not.toContain('private-test-token');
  });

  it('turns connection failures into a bounded admin status', async () => {
    const snapshot = await probeQwenTtsHealth({
      baseUrl: 'http://gpu/qwen-tts/v1',
      apiToken: 'configured',
      fetchImpl: (async () => {
        throw new Error('connection details that must not be returned');
      }) as typeof fetch,
    });
    expect(snapshot).toEqual({
      configured: true,
      status: 'unavailable',
      model: null,
      message: 'Qwen 服务当前无法连接',
    });
  });
});
