export type JobMode = 'topic' | 'script' | 'clone';
export type ReplicaMode = 'exact' | 'condensed';
export type JobStatus =
  | 'pending'
  | 'provisioning'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled';
export type AspectRatio = '16:9' | '9:16' | '1:1' | 'avatar';
export type VoiceMode = 'original_clone' | 'uploaded_audio' | 'uploaded_reference' | 'system_voice';
export type PresenterAssetKind = 'avatar' | 'voice';

export type PresenterAsset = {
  id: string;
  kind: PresenterAssetKind;
  name: string;
  filePath: string;
  originalName: string;
  mimeType: string;
  durationSeconds: number | null;
  createdAt: string;
};

export type JobAssets = {
  avatarImage?: string;
  sourceVideo?: string;
  voiceReference?: string;
};

export type JobCreateInput = {
  title: string;
  mode: JobMode;
  replicaMode: ReplicaMode;
  topic: string;
  script: string;
  durationSeconds: number;
  aspectRatio: AspectRatio;
  style: string;
  voiceMode: VoiceMode;
  rightsConfirmed: boolean;
  assets: JobAssets;
};

export type JobRecord = JobCreateInput & {
  id: string;
  status: JobStatus;
  stage: string;
  progress: number;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  outputPath: string | null;
  error: string | null;
  cancelRequested: boolean;
  metadata: Record<string, unknown>;
};

export type JobEvent = {
  id: number;
  jobId: string;
  level: 'info' | 'warning' | 'error';
  kind: string;
  message: string;
  data: Record<string, unknown>;
  createdAt: string;
};

export type InstanceState = 'Running' | 'Stopped' | 'Starting' | 'Stopping' | 'Unknown';

export type InstanceSnapshot = {
  id: string;
  name: string;
  state: InstanceState;
  gpuType: string;
  gpuCount: number;
  hourlyPrice: number | null;
  startTime: number | null;
  raw?: Record<string, unknown>;
};

export type SystemSnapshot = {
  instance: InstanceSnapshot;
  mockGpu: boolean;
  mockCodex: boolean;
  queue: {pending: number; active: number; total: number};
  billingWindowStartedAt: string | null;
  nextPowerCheckAt: string | null;
  lastPowerAction: string | null;
  lastPowerError: string | null;
  codexModel: string;
};
