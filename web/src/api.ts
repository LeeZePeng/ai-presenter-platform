export type JobStatus = 'pending' | 'provisioning' | 'running' | 'succeeded' | 'failed' | 'cancelled';
export type JobMode = 'topic' | 'script' | 'clone';
export type ReplicaMode = 'exact' | 'condensed';
export type PresenterAssetKind = 'avatar' | 'voice';

export type PresenterAsset = {
  id: string;
  kind: PresenterAssetKind;
  name: string;
  originalName: string;
  mimeType: string;
  durationSeconds: number | null;
  createdAt: string;
};

export type YouTubeVideo = {
  id: string;
  title: string;
  channelTitle: string;
  thumbnailUrl: string;
  durationSeconds: number;
  viewCount: number;
  publishedAt: string;
  license: 'creativeCommon' | 'youtube' | 'unknown';
  url: string;
  viewsPerDay: number;
};

export type YouTubeImport = {id: string; video: YouTubeVideo};

export type Job = {
  id: string;
  title: string;
  mode: JobMode;
  replicaMode: ReplicaMode;
  topic: string;
  script: string;
  durationSeconds: number;
  aspectRatio: '16:9' | '9:16' | '1:1';
  style: string;
  voiceMode: string;
  status: JobStatus;
  stage: string;
  progress: number;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  error: string | null;
  cancelRequested: boolean;
};

export type JobDelivery = {
  marketingTitle: string;
  marketingDescription: string;
};

export type JobEvent = {
  id: number;
  level: 'info' | 'warning' | 'error';
  kind: string;
  message: string;
  createdAt: string;
};

export type SystemSnapshot = {
  instance: {
    id: string;
    name: string;
    state: 'Running' | 'Stopped' | 'Starting' | 'Stopping' | 'Unknown';
    gpuType: string;
    gpuCount: number;
    hourlyPrice: number | null;
  };
  mockGpu: boolean;
  mockCodex: boolean;
  queue: {pending: number; active: number; total: number};
  billingWindowStartedAt: string | null;
  nextPowerCheckAt: string | null;
  lastPowerAction: string | null;
  lastPowerError: string | null;
  codexModel: string;
};

export type ServiceSnapshot = {
  queue: {pending: number; active: number; total: number};
  service: {accepting: boolean; status: 'ready' | 'queued' | 'processing'};
  updatedAt: string;
};

export type AdminMetrics = {
  total: number;
  succeeded: number;
  failed: number;
  cancelled: number;
  running: number;
  successRate: number;
  requestSeries: Array<{hour: string; count: number}>;
};

export type AdminEvent = JobEvent & {
  jobId: string;
  jobTitle: string;
  data: Record<string, unknown>;
};

export type AdminDashboard = {
  system: SystemSnapshot;
  metrics: AdminMetrics;
  recentEvents: AdminEvent[];
  serverTime: string;
  uptimeSeconds: number;
  jobsEnabled: boolean;
};

export type DeploymentSnapshot = {
  enabled: boolean;
  status: 'idle' | 'queued' | 'running' | 'succeeded' | 'failed' | 'rolled_back';
  stage: string;
  message: string;
  commit: string | null;
  previousCommit: string | null;
  requestedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  pid: number | null;
  remote: string;
  branch: string;
  repoDir: string;
  targetDir: string;
  logTail: string;
};

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

export const api = async <T>(path: string, init: RequestInit = {}): Promise<T> => {
  const headers = new Headers(init.headers);
  if (init.body && !(init.body instanceof FormData)) headers.set('content-type', 'application/json');
  const response = await fetch(path, {...init, headers, credentials: 'include'});
  const data = (await response.json().catch(() => ({}))) as {error?: string};
  if (!response.ok) throw new ApiError(data.error ?? `请求失败 (${response.status})`, response.status);
  return data as T;
};

export const resultUrl = (jobId: string, inline = true): string => {
  const params = new URLSearchParams({inline: inline ? '1' : '0'});
  return `/api/jobs/${jobId}/result?${params.toString()}`;
};

export const coverUrl = (jobId: string, inline = true): string => {
  const params = new URLSearchParams({inline: inline ? '1' : '0'});
  return `/api/jobs/${jobId}/cover?${params.toString()}`;
};

export const presenterAssetUrl = (assetId: string): string => `/api/presenter-assets/${assetId}/file`;

export const adminResultUrl = (jobId: string, inline = true): string => {
  const params = new URLSearchParams({inline: inline ? '1' : '0'});
  return `/api/admin/jobs/${jobId}/result?${params.toString()}`;
};
