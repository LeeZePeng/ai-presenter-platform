export type QwenTtsHealthSnapshot = {
  configured: boolean;
  status: 'unconfigured' | 'loading' | 'ready' | 'unavailable' | 'misconfigured';
  model: string | null;
  message: string;
};

type ProbeOptions = {
  baseUrl: string;
  apiToken: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
};

type WaitOptions = ProbeOptions & {
  readyTimeoutMs?: number;
  pollMs?: number;
  isCancelled?: () => boolean;
  onStatus?: (snapshot: QwenTtsHealthSnapshot) => void;
  now?: () => number;
  sleepImpl?: (milliseconds: number) => Promise<void>;
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
    if (response.status === 401 || response.status === 403) {
      return {configured: true, status: 'misconfigured', model, message: 'Qwen 服务鉴权失败，请检查私有令牌'};
    }
    if (response.status === 404) {
      return {configured: true, status: 'misconfigured', model, message: 'Qwen 服务路由不存在，请检查服务地址'};
    }
    const detail = typeof payload.detail === 'string' ? payload.detail : '';
    if (response.status === 503 && /(?:model load failed|token is not configured)/i.test(detail)) {
      return {configured: true, status: 'misconfigured', model, message: 'Qwen 模型启动失败，请检查 GPU 服务日志'};
    }
    return {configured: true, status: 'unavailable', model, message: `Qwen 服务不可用（HTTP ${response.status}）`};
  } catch {
    return {configured: true, status: 'unavailable', model: null, message: 'Qwen 服务当前无法连接'};
  }
};

const sleep = (milliseconds: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, milliseconds));

export const waitForQwenTtsReady = async ({
  readyTimeoutMs = 10 * 60 * 1000,
  pollMs = 5000,
  isCancelled = () => false,
  onStatus,
  now = Date.now,
  sleepImpl = sleep,
  ...probeOptions
}: WaitOptions): Promise<QwenTtsHealthSnapshot> => {
  const deadline = now() + Math.max(1000, readyTimeoutMs);
  let latest = await probeQwenTtsHealth(probeOptions);
  onStatus?.(latest);
  if (latest.status === 'unconfigured' || latest.status === 'misconfigured' || latest.status === 'ready') return latest;
  while (now() < deadline) {
    if (isCancelled()) throw new Error('任务已取消');
    await sleepImpl(Math.max(100, pollMs));
    latest = await probeQwenTtsHealth(probeOptions);
    onStatus?.(latest);
    if (latest.status === 'ready' || latest.status === 'unconfigured' || latest.status === 'misconfigured') return latest;
  }
  return latest;
};
