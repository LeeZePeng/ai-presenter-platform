export type QwenTtsHealthSnapshot = {
  configured: boolean;
  status: 'unconfigured' | 'loading' | 'ready' | 'unavailable';
  model: string | null;
  message: string;
};

type ProbeOptions = {
  baseUrl: string;
  apiToken: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

export const qwenTtsHealthUrl = (baseUrl: string): string => `${baseUrl.trim().replace(/\/$/, '')}/health`;

export const probeQwenTtsHealth = async ({
  baseUrl,
  apiToken,
  timeoutMs = 2500,
  fetchImpl = fetch,
}: ProbeOptions): Promise<QwenTtsHealthSnapshot> => {
  if (!baseUrl.trim() || !apiToken.trim()) {
    return {configured: false, status: 'unconfigured', model: null, message: '尚未配置参考音色服务'};
  }
  try {
    const response = await fetchImpl(qwenTtsHealthUrl(baseUrl), {
      headers: {Authorization: `Bearer ${apiToken}`},
      signal: AbortSignal.timeout(timeoutMs),
    });
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    const model = typeof payload.model === 'string' && payload.model.trim() ? payload.model.trim() : null;
    if (response.ok && payload.status === 'ready') {
      return {configured: true, status: 'ready', model, message: 'Qwen 参考音色克隆已就绪'};
    }
    if (response.ok && payload.status === 'loading') {
      return {configured: true, status: 'loading', model, message: 'Qwen 模型正在加载'};
    }
    return {configured: true, status: 'unavailable', model, message: `Qwen 服务不可用（HTTP ${response.status}）`};
  } catch {
    return {configured: true, status: 'unavailable', model: null, message: 'Qwen 服务当前无法连接'};
  }
};
