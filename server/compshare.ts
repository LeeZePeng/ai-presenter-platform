import {createHash} from 'node:crypto';
import type {InstanceSnapshot, InstanceState} from './types.js';

export interface InstanceController {
  describe(): Promise<InstanceSnapshot>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

type CompshareOptions = {
  publicKey: string;
  privateKey: string;
  instanceId: string;
  region: string;
  zone: string;
  baseUrl: string;
};

export type CompshareZone = {region: string; zone: string; name: string};

export const normalizeInstanceState = (value: unknown): InstanceState => {
  const state = String(value ?? 'Unknown');
  if (state === 'Initializing') return 'Starting';
  return ['Running', 'Stopped', 'Starting', 'Stopping'].includes(state) ? (state as InstanceState) : 'Unknown';
};

export class CompshareInstanceController implements InstanceController {
  private readonly endpoint: URL;

  constructor(private readonly options: CompshareOptions) {
    this.endpoint = new URL(options.baseUrl);
    if (this.endpoint.protocol !== 'https:' || this.endpoint.hostname !== 'api.compshare.cn') {
      throw new Error('COMPSHARE_BASE_URL 必须是 https://api.compshare.cn');
    }
  }

  private flatten(input: Record<string, unknown>, prefix = ''): Record<string, string | number | boolean> {
    const output: Record<string, string | number | boolean> = {};
    for (const [key, value] of Object.entries(input)) {
      if (value === undefined || value === null) continue;
      const fullKey = prefix ? `${prefix}.${key}` : key;
      if (Array.isArray(value)) {
        value.forEach((item, index) => {
          if (item && typeof item === 'object') Object.assign(output, this.flatten(item as Record<string, unknown>, `${fullKey}.${index}`));
          else if (item !== undefined && item !== null) output[`${fullKey}.${index}`] = item as string | number | boolean;
        });
      } else if (typeof value === 'object') {
        Object.assign(output, this.flatten(value as Record<string, unknown>, fullKey));
      } else if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        output[fullKey] = value;
      }
    }
    return output;
  }

  private sign(input: Record<string, string | number | boolean>): Record<string, string | number | boolean> {
    const signed: Record<string, string | number | boolean> = {...input, PublicKey: this.options.publicKey};
    const canonical = Object.keys(signed)
      .sort()
      .map((key) => `${key}${String(signed[key])}`)
      .join('');
    const signature = createHash('sha1').update(canonical + this.options.privateKey).digest('hex');
    return {...signed, Signature: signature};
  }

  private async invoke(action: string, extra: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const payload = this.sign(this.flatten({
      Action: action,
      Region: this.options.region,
      Zone: this.options.zone,
      ...extra,
    }));
    let response: Record<string, unknown> | null = null;
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        const httpResponse = await fetch(this.endpoint, {
          method: 'POST',
          headers: {'content-type': 'application/json', 'user-agent': 'ai-presenter-platform/0.1'},
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(20_000),
        });
        const text = await httpResponse.text();
        if (!httpResponse.ok) throw new Error(`CompShare HTTP ${httpResponse.status}: ${text.slice(0, 500)}`);
        response = JSON.parse(text) as Record<string, unknown>;
        break;
      } catch (error) {
        lastError = error;
        if (attempt < 3) await new Promise((resolve) => setTimeout(resolve, attempt * 500));
      }
    }
    if (!response) throw lastError instanceof Error ? lastError : new Error('CompShare request failed');
    const retCode = Number(response.RetCode ?? 0);
    if (retCode !== 0) {
      throw new Error(`CompShare ${action} failed (${retCode}): ${String(response.Message ?? 'unknown error')}`);
    }
    return response;
  }

  private mapInstance(instance: Record<string, unknown>): InstanceSnapshot {
    return {
      id: String(instance.UHostId ?? ''),
      name: String(instance.Name ?? 'GPU instance'),
      state: normalizeInstanceState(instance.State),
      gpuType: String(instance.GpuType ?? ''),
      gpuCount: Number(instance.GPU ?? 0),
      hourlyPrice: Number.isFinite(Number(instance.InstancePrice)) ? Number(instance.InstancePrice) : null,
      startTime: Number(instance.StartTime) > 0 ? Number(instance.StartTime) : null,
    };
  }

  async listInstances(): Promise<InstanceSnapshot[]> {
    const response = await this.invoke('DescribeCompShareInstance', {
      Limit: 100,
      Offset: 0,
    });
    const instances = (response.UHostSet ?? []) as Array<Record<string, unknown>>;
    return instances.map((instance) => this.mapInstance(instance));
  }

  async listSupportZones(): Promise<CompshareZone[]> {
    const response = await this.invoke('DescribeCompShareSupportZone');
    const zones = (response.ZoneInfo ?? []) as Array<Record<string, unknown>>;
    return zones.map((zone) => ({
      region: String(zone.Region ?? ''),
      zone: String(zone.Zone ?? ''),
      name: String(zone.Describe ?? ''),
    }));
  }

  async describe(): Promise<InstanceSnapshot> {
    const response = await this.invoke('DescribeCompShareInstance', {
      UHostIds: [this.options.instanceId],
      Limit: 1,
      Offset: 0,
    });
    const instances = (response.UHostSet ?? []) as Array<Record<string, unknown>>;
    const instance = instances.find((item) => item.UHostId === this.options.instanceId) ?? instances[0];
    if (!instance) throw new Error(`CompShare instance not found: ${this.options.instanceId}`);
    return this.mapInstance(instance);
  }

  async start(): Promise<void> {
    await this.invoke('StartCompShareInstance', {UHostId: this.options.instanceId});
  }

  async stop(): Promise<void> {
    await this.invoke('StopCompShareInstance', {UHostId: this.options.instanceId});
  }
}

export class MockInstanceController implements InstanceController {
  private state: InstanceState = 'Stopped';
  private startTime: number | null = null;

  constructor(private readonly transitionMs = 1200) {}

  async describe(): Promise<InstanceSnapshot> {
    return {
      id: 'mock-gpu-01',
      name: '开发预览实例',
      state: this.state,
      gpuType: '4090',
      gpuCount: 1,
      hourlyPrice: 1.98,
      startTime: this.startTime,
    };
  }

  async start(): Promise<void> {
    if (this.state === 'Running' || this.state === 'Starting') return;
    this.state = 'Starting';
    setTimeout(() => {
      this.state = 'Running';
      this.startTime = Math.floor(Date.now() / 1000);
    }, this.transitionMs);
  }

  async stop(): Promise<void> {
    if (this.state === 'Stopped' || this.state === 'Stopping') return;
    this.state = 'Stopping';
    setTimeout(() => {
      this.state = 'Stopped';
    }, this.transitionMs);
  }
}
