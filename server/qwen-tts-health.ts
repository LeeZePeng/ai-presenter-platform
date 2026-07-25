export type QwenTtsHealthSnapshot = {
  configured: boolean;
  status: 'unconfigured' | 'ready' | 'misconfigured';
  model: string | null;
  message: string;
};

type ProbeOptions = {
  baseUrl: string;
  apiToken: string;
  model?: string;
};

const supportedModel = 'qwen3-tts-vc-2026-01-22';

export const probeQwenTtsHealth = async ({
  baseUrl,
  apiToken,
  model = supportedModel,
}: ProbeOptions): Promise<QwenTtsHealthSnapshot> => {
  if (!baseUrl.trim() || !apiToken.trim()) {
    return {
      configured: false,
      status: 'unconfigured',
      model: null,
      message: '尚未配置阿里云百炼 API Key',
    };
  }
  if (model.trim() !== supportedModel) {
    return {
      configured: true,
      status: 'misconfigured',
      model: model.trim() || null,
      message: `参考音色模型必须为 ${supportedModel}`,
    };
  }
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    return {
      configured: true,
      status: 'misconfigured',
      model,
      message: '阿里云百炼 API 地址无效',
    };
  }
  if (parsed.protocol !== 'https:') {
    return {
      configured: true,
      status: 'misconfigured',
      model,
      message: '阿里云百炼 API 必须使用 HTTPS',
    };
  }
  return {
    configured: true,
    status: 'ready',
    model,
    message: '阿里云千问参考音色已配置（合成时验证）',
  };
};
