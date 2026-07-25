import {describe, expect, it, vi} from 'vitest';
import {probeQwenTtsHealth, qwenTtsHealthUrl, waitForQwenTtsReady} from '../server/qwen-tts-health.js';

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

  it('fails immediately when the private token is rejected', async () => {
    let requestCount = 0;
    const snapshot = await waitForQwenTtsReady({
      baseUrl: 'http://gpu/qwen-tts/v1',
      apiToken: 'wrong-token',
      sleepImpl: async () => {
        throw new Error('must not wait after an authentication failure');
      },
      fetchImpl: (async () => {
        requestCount += 1;
        return {
          ok: false,
          status: 401,
          json: async () => ({detail: 'Unauthorized'}),
        } as Response;
      }) as typeof fetch,
    });
    expect(requestCount).toBe(1);
    expect(snapshot).toEqual({
      configured: true,
      status: 'misconfigured',
      model: null,
      message: 'Qwen 服务鉴权失败，请检查私有令牌',
    });
  });

  it('waits through model loading and returns only after the clone service is ready', async () => {
    let requestCount = 0;
    let clock = 0;
    const snapshot = await waitForQwenTtsReady({
      baseUrl: 'http://gpu/qwen-tts/v1',
      apiToken: 'configured',
      readyTimeoutMs: 10_000,
      pollMs: 100,
      now: () => clock,
      sleepImpl: async (milliseconds) => {
        clock += milliseconds;
      },
      fetchImpl: (async () => {
        requestCount += 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({
            status: requestCount < 3 ? 'loading' : 'ready',
            model: 'Qwen3-TTS-12Hz-1.7B-Base',
          }),
        } as Response;
      }) as typeof fetch,
    });
    expect(requestCount).toBe(3);
    expect(snapshot.status).toBe('ready');
  });
});
