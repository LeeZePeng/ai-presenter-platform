import {execFile} from 'node:child_process';
import {readFile} from 'node:fs/promises';
import {promisify} from 'node:util';

const execFileAsync = promisify(execFile);

type ProxyControllerConfig = {
  'external-controller'?: unknown;
  secret?: unknown;
};

type ProxyGroup = {
  all?: unknown;
};

export type ProxyProbeResult = {
  statusCode: number;
  contentType: string;
  reachable: boolean;
};

export type ProxySelectionResult = ProxyProbeResult & {
  candidateCount: number;
  selectedOrdinal: number;
};

export type ProxySelectionOptions = {
  proxyUrl: string;
  configPath: string;
  controllerUrl: string;
  groupName: string;
  probeUrl: string;
  probeTimeoutMs: number;
};

type ProxySelectionDependencies = {
  fetchImpl?: typeof fetch;
  readConfig?: (path: string) => Promise<string>;
  probe?: (proxyUrl: string, probeUrl: string, timeoutMs: number) => Promise<ProxyProbeResult>;
};

export const isUsProxyName = (name: string): boolean =>
  /^(?:us|usa)[\s_-]*\d+\b/i.test(name.trim()) ||
  /(?:美国|美國|🇺🇸|United States|Los Angeles|San Jose|Seattle|Dallas|New York|Chicago|Phoenix|Silicon Valley)/i.test(
    name,
  );

export const probeCodexRoute = async (
  proxyUrl: string,
  probeUrl: string,
  timeoutMs: number,
): Promise<ProxyProbeResult> => {
  let output = '';
  try {
    const result = await execFileAsync(
      'curl',
      [
        '-sS',
        '--proxy',
        proxyUrl,
        '--connect-timeout',
        String(Math.max(1, Math.ceil(timeoutMs / 2000))),
        '--max-time',
        String(Math.max(1, Math.ceil(timeoutMs / 1000))),
        '-o',
        '/dev/null',
        '-w',
        '%{http_code}|%{content_type}',
        probeUrl,
      ],
      {timeout: timeoutMs + 1000, maxBuffer: 64 * 1024},
    );
    output = result.stdout.trim();
  } catch (error) {
    const value = error as {stdout?: string};
    output = value.stdout?.trim() ?? '';
  }

  const [statusText = '0', contentType = ''] = output.split('|', 2);
  const statusCode = Number(statusText);
  const reachable = Number.isInteger(statusCode) && statusCode > 0 && /application\/json/i.test(contentType);
  return {statusCode, contentType, reachable};
};

export const selectWorkingUsProxy = async (
  options: ProxySelectionOptions,
  dependencies: ProxySelectionDependencies = {},
): Promise<ProxySelectionResult> => {
  if (!options.proxyUrl) throw new Error('Codex proxy URL is not configured');
  const fetchImpl = dependencies.fetchImpl ?? fetch;
  const readConfig = dependencies.readConfig ?? ((configPath: string) => readFile(configPath, 'utf8'));
  const probe = dependencies.probe ?? probeCodexRoute;
  const config = JSON.parse(await readConfig(options.configPath)) as ProxyControllerConfig;
  const configuredController = typeof config['external-controller'] === 'string' ? config['external-controller'] : '';
  const controllerUrl = (options.controllerUrl || configuredController).replace(/\/$/, '');
  if (!controllerUrl) throw new Error('Mihomo controller is not configured');
  const baseUrl = /^https?:\/\//i.test(controllerUrl) ? controllerUrl : `http://${controllerUrl}`;
  const headers: Record<string, string> = {'Content-Type': 'application/json'};
  if (typeof config.secret === 'string' && config.secret) headers.Authorization = `Bearer ${config.secret}`;

  const groupPath = `${baseUrl}/proxies/${encodeURIComponent(options.groupName)}`;
  const groupResponse = await fetchImpl(groupPath, {headers});
  if (!groupResponse.ok) throw new Error(`Mihomo controller returned HTTP ${groupResponse.status}`);
  const group = (await groupResponse.json()) as ProxyGroup;
  const allNames = Array.isArray(group.all) ? group.all.filter((name): name is string => typeof name === 'string') : [];
  const candidates = allNames.filter(isUsProxyName);
  if (candidates.length === 0) throw new Error('订阅中没有识别到美国代理节点');

  for (let index = 0; index < candidates.length; index += 1) {
    const selectionResponse = await fetchImpl(groupPath, {
      method: 'PUT',
      headers,
      body: JSON.stringify({name: candidates[index]}),
    });
    if (!selectionResponse.ok) continue;
    const result = await probe(options.proxyUrl, options.probeUrl, options.probeTimeoutMs);
    if (result.reachable) {
      return {...result, candidateCount: candidates.length, selectedOrdinal: index + 1};
    }
  }

  throw new Error(`已检查 ${candidates.length} 个美国节点，但没有节点能访问 Codex`);
};
