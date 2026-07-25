import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {AnimatePresence, motion} from 'motion/react';
import Particles, {ParticlesProvider} from '@tsparticles/react';
import {loadSlim} from '@tsparticles/slim';
import type {Engine, ISourceOptions} from '@tsparticles/engine';
import {
  Activity,
  Bot,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleStop,
  Download,
  ExternalLink,
  FileAudio,
  FileText,
  Film,
  Gauge,
  Image as ImageIcon,
  Library,
  Link,
  LayoutDashboard,
  LoaderCircle,
  LogIn,
  Mic2,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Search,
  Save,
  SlidersHorizontal,
  Sparkles,
  TriangleAlert,
  Upload,
  Video,
  X,
  Youtube,
} from 'lucide-react';
import {
  api,
  ApiError,
  coverUrl,
  presenterAssetUrl,
  resultUrl,
  type Job,
  type JobDelivery,
  type JobEvent,
  type JobMode,
  type PresenterAsset,
  type PublishPlatform,
  type ReplicaMode,
  type ServiceSnapshot,
  type YouTubeImport,
  type YouTubeVideo,
} from './api';

type View = 'create' | 'queue';
type WizardStep = 1 | 2 | 3;
type VoiceMode = 'original_clone' | 'uploaded_audio' | 'uploaded_reference' | 'system_voice';

const modeConfig: Array<{id: JobMode; label: string; icon: typeof Sparkles}> = [
  {id: 'clone', label: '复刻视频', icon: Film},
  {id: 'topic', label: '主题创作', icon: Sparkles},
  {id: 'script', label: '已有文案', icon: FileText},
];

const consoleParticles: ISourceOptions = {
  fullScreen: {enable: false},
  fpsLimit: 30,
  detectRetina: true,
  pauseOnBlur: true,
  interactivity: {events: {onClick: {enable: false}, onHover: {enable: false}, resize: {enable: true}}},
  particles: {
    color: {value: ['#29d8bc', '#ffc857']},
    links: {color: '#39b8a5', distance: 105, enable: true, opacity: 0.18, width: 1},
    move: {direction: 'none', enable: true, outModes: {default: 'bounce'}, random: true, speed: 0.28},
    number: {density: {enable: true, width: 900, height: 160}, value: 18},
    opacity: {value: {min: 0.22, max: 0.58}},
    shape: {type: 'square'},
    size: {value: {min: 1, max: 2}},
  },
};

const loadConsoleParticles = async (engine: Engine): Promise<void> => loadSlim(engine);

const statusLabel: Record<Job['status'], string> = {
  pending: '排队中',
  provisioning: '准备算力',
  running: '生成中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

const voiceLabel = {
  original_clone: '原声克隆',
  uploaded_audio: '直接使用整段音频',
  uploaded_reference: '克隆上传声音',
  system_voice: '系统音色',
} as const;

const minimumGeneratedDurationSeconds = 5;
const maximumGeneratedDurationSeconds = 1800;

const publishingPresets: Array<{
  id: PublishPlatform;
  label: string;
  aspectRatio: '16:9' | '9:16' | null;
  resolution: string;
  preferredDuration: number;
  description: string;
}> = [
  {id: 'douyin', label: '抖音', aspectRatio: '9:16', resolution: '1080×1920', preferredDuration: 75, description: '首帧强钩子 · 竖屏安全区 · 快节奏'},
  {id: 'wechat_channels', label: '视频号', aspectRatio: '9:16', resolution: '1080×1920', preferredDuration: 120, description: '竖屏讲解 · 信息更完整 · 字幕易读'},
  {id: 'bilibili', label: 'B站', aspectRatio: '16:9', resolution: '1920×1080', preferredDuration: 300, description: '横屏章节 · 演示优先 · 保留上下文'},
  {id: 'original', label: '原尺寸母版', aspectRatio: null, resolution: '自选画幅', preferredDuration: 120, description: '保留原尺寸 · 适合归档和二次剪辑'},
];

const formatPublishingPlatform = (platform: PublishPlatform): string =>
  publishingPresets.find((preset) => preset.id === platform)?.label ?? '原尺寸母版';

const condensedTargetForSource = (sourceDurationSeconds: number, preferredSeconds = 60): number =>
  Math.min(
    Math.max(minimumGeneratedDurationSeconds, preferredSeconds),
    Math.min(maximumGeneratedDurationSeconds, Math.max(minimumGeneratedDurationSeconds, Math.ceil(sourceDurationSeconds))),
  );

const readAudioDuration = (file: File): Promise<number> =>
  new Promise((resolve, reject) => {
    const audio = document.createElement('audio');
    const url = URL.createObjectURL(file);
    const cleanup = (): void => {
      audio.removeAttribute('src');
      URL.revokeObjectURL(url);
    };
    audio.preload = 'metadata';
    audio.onloadedmetadata = () => {
      const seconds = audio.duration;
      cleanup();
      if (Number.isFinite(seconds) && seconds > 0) resolve(seconds);
      else reject(new Error('无法读取音频时长'));
    };
    audio.onerror = () => {
      cleanup();
      reject(new Error('无法读取音频文件'));
    };
    audio.src = url;
  });

const readVideoDuration = (file: File): Promise<number> =>
  new Promise((resolve, reject) => {
    const video = document.createElement('video');
    const url = URL.createObjectURL(file);
    const cleanup = (): void => {
      video.removeAttribute('src');
      URL.revokeObjectURL(url);
    };
    video.preload = 'metadata';
    video.onloadedmetadata = () => {
      const seconds = video.duration;
      cleanup();
      if (Number.isFinite(seconds) && seconds > 0) resolve(seconds);
      else reject(new Error('无法读取视频时长'));
    };
    video.onerror = () => {
      cleanup();
      reject(new Error('无法读取视频文件'));
    };
    video.src = url;
  });

const formatAudioDuration = (seconds: number): string => {
  if (seconds < 60) return `${seconds.toFixed(1)} 秒`;
  const rounded = Math.round(seconds);
  const minutes = Math.floor(rounded / 60);
  const remainder = rounded % 60;
  return `${minutes}:${String(remainder).padStart(2, '0')}`;
};

const formatCompactNumber = (value: number): string =>
  new Intl.NumberFormat('zh-CN', {notation: 'compact', maximumFractionDigits: 1}).format(value);

const formatPublishedDate = (value: string): string =>
  new Intl.DateTimeFormat('zh-CN', {year: 'numeric', month: 'short', day: 'numeric'}).format(new Date(value));

const PresenterAssetShelf = ({
  kind,
  assets,
  selectedId,
  onSelect,
}: {
  kind: 'avatar' | 'voice';
  assets: PresenterAsset[];
  selectedId: string;
  onSelect: (asset: PresenterAsset) => void;
}) => (
  <div className="asset-library">
    <div className="asset-library-heading">
      <span><Library size={16} />{kind === 'avatar' ? '已保存形象' : '已保存声音'}</span>
      <small>{assets.length ? `${assets.length} 个可复用素材` : '首次上传后会出现在这里'}</small>
    </div>
    {assets.length > 0 && (
      <div className="asset-shelf" role="listbox" aria-label={kind === 'avatar' ? '选择已保存形象' : '选择已保存声音'}>
        {assets.map((asset) => (
          <button
            type="button"
            role="option"
            aria-selected={selectedId === asset.id}
            className={selectedId === asset.id ? 'active' : ''}
            key={asset.id}
            onClick={() => onSelect(asset)}
          >
            {kind === 'avatar' ? <img src={presenterAssetUrl(asset.id)} alt="" /> : <span className="voice-orb"><Mic2 size={18} /></span>}
            <span><strong>{asset.name}</strong><small>{kind === 'voice' && asset.durationSeconds ? formatAudioDuration(asset.durationSeconds) : asset.originalName}</small></span>
            {selectedId === asset.id && <Check size={15} />}
          </button>
        ))}
      </div>
    )}
  </div>
);

const formatJobDuration = (job: Job): string =>
  job.mode === 'clone'
    ? job.replicaMode === 'exact'
      ? `完整 · ${formatAudioDuration(job.durationSeconds)}`
      : `精简复刻 · 核心提炼 · ≤${job.durationSeconds} 秒`
    : job.voiceMode === 'uploaded_audio'
      ? `${job.durationSeconds} 秒`
      : 'AI 自动规划';

const formatTime = (value: string | null): string =>
  value ? new Intl.DateTimeFormat('zh-CN', {month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'}).format(new Date(value)) : '—';

const mergeEvents = (current: JobEvent[], incoming: JobEvent[]): JobEvent[] => {
  const byId = new Map(current.map((event) => [event.id, event]));
  for (const event of incoming) byId.set(event.id, event);
  return [...byId.values()].sort((left, right) => left.id - right.id).slice(-500);
};

const FileField = ({
  label,
  accept,
  icon: Icon,
  file,
  onChange,
}: {
  label: string;
  accept: string;
  icon: typeof Upload;
  file: File | null;
  onChange: (file: File | null) => void;
}) => {
  const input = useRef<HTMLInputElement>(null);
  return (
    <motion.button
      className={`file-field ${file ? 'has-file' : ''}`}
      type="button"
      whileTap={{scale: 0.995}}
      transition={{duration: 0.1}}
      onClick={() => input.current?.click()}
    >
      <input
        ref={input}
        type="file"
        accept={accept}
        hidden
        onChange={(event) => onChange(event.target.files?.[0] ?? null)}
      />
      <Icon size={22} />
      <span>
        <strong>{label}</strong>
        <small>{file ? file.name : '选择文件'}</small>
      </span>
      {file ? (
        <X
          size={17}
          onClick={(event) => {
            event.stopPropagation();
            onChange(null);
          }}
        />
      ) : (
        <Upload size={17} />
      )}
    </motion.button>
  );
};

const VideoSourceField = ({file, onChange}: {file: File | null; onChange: (file: File | null) => void}) => {
  const input = useRef<HTMLInputElement>(null);
  const [previewUrl, setPreviewUrl] = useState('');

  useEffect(() => {
    if (!file) {
      setPreviewUrl('');
      return;
    }
    const url = URL.createObjectURL(file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const select = (next: File | null): void => {
    if (next && !next.type.startsWith('video/')) return;
    onChange(next);
  };

  return (
    <motion.button
      className={`video-source-field ${file ? 'has-file' : ''}`}
      type="button"
      whileTap={{scale: 0.998}}
      transition={{duration: 0.1}}
      onClick={() => input.current?.click()}
      onDragOver={(event) => event.preventDefault()}
      onDrop={(event) => {
        event.preventDefault();
        select(event.dataTransfer.files?.[0] ?? null);
      }}
    >
      <input
        ref={input}
        type="file"
        accept="video/mp4,video/quicktime,video/webm"
        hidden
        onChange={(event) => select(event.target.files?.[0] ?? null)}
      />
      {previewUrl ? (
        <video src={previewUrl} muted loop autoPlay playsInline preload="metadata" />
      ) : (
        <span className="video-source-empty"><Film size={34} /></span>
      )}
      <span className="video-monitor-label">SOURCE 01</span>
      <span className="video-monitor-corner top-left" />
      <span className="video-monitor-corner top-right" />
      <span className="video-source-overlay">
        <span className="video-source-copy">
          <strong>{file ? file.name : '上传参考视频'}</strong>
          <small>{file ? '点击更换文件' : 'MP4 / MOV / WEBM'}</small>
        </span>
        <span className="video-source-action">{file ? <RefreshCw size={17} /> : <Upload size={17} />}</span>
      </span>
      {file && (
        <span
          className="video-source-remove"
          title="移除视频"
          onClick={(event) => {
            event.stopPropagation();
            onChange(null);
          }}
        ><X size={17} /></span>
      )}
    </motion.button>
  );
};

const JobDrawer = ({
  job,
  events,
  retrying,
  delivery,
  onClose,
  onCancel,
  onRetry,
}: {
  job: Job;
  events: JobEvent[];
  retrying: boolean;
  delivery: JobDelivery | null;
  onClose: () => void;
  onCancel: () => void;
  onRetry: () => void;
}) => (
  <div className="drawer-backdrop" onMouseDown={onClose}>
    <aside className="job-drawer" onMouseDown={(event) => event.stopPropagation()}>
      <div className="drawer-header">
        <div>
          <span className={`status-dot ${job.status}`} />
          <small>{statusLabel[job.status]}</small>
          <h2>{job.title}</h2>
        </div>
        <button className="icon-button" title="关闭" onClick={onClose}>
          <X size={19} />
        </button>
      </div>

      {job.status === 'succeeded' && (
        <>
          <video className="result-video" style={{aspectRatio: job.aspectRatio === 'avatar' ? 'auto' : job.aspectRatio.replace(':', ' / ')}} src={resultUrl(job.id)} controls playsInline preload="metadata" />
          {delivery && (
            <section className="delivery-package">
              <img style={{aspectRatio: job.aspectRatio === 'avatar' ? 'auto' : job.aspectRatio.replace(':', ' / ')}} src={coverUrl(job.id)} alt={delivery.marketingTitle} />
              <div>
                <small>发布标题</small>
                <h3>{delivery.marketingTitle}</h3>
                <small>发布描述</small>
                <p>{delivery.marketingDescription}</p>
                <a className="secondary" href={coverUrl(job.id, false)}><Download size={16} />下载封面</a>
              </div>
            </section>
          )}
        </>
      )}

      <div className="drawer-progress">
        <div><span>{job.stage}</span><strong>{job.progress}%</strong></div>
        <div className="progress-track"><i style={{width: `${job.progress}%`}} /></div>
      </div>

      <dl className="job-facts">
        <div><dt>模式</dt><dd>{modeConfig.find((item) => item.id === job.mode)?.label}</dd></div>
        <div><dt>发布平台</dt><dd>{formatPublishingPlatform(job.publishPlatform)}</dd></div>
        <div><dt>画幅</dt><dd>{job.aspectRatio}</dd></div>
        <div><dt>时长</dt><dd>{formatJobDuration(job)}</dd></div>
        <div><dt>创建</dt><dd>{formatTime(job.createdAt)}</dd></div>
      </dl>

      {job.error && <div className="error-banner">{job.error}</div>}

      <section className="timeline">
        <div className="section-title"><Activity size={17} /><h3>任务时间线</h3></div>
        <div className="timeline-list">
          {[...events].reverse().map((event) => {
            const active = ['pending', 'provisioning', 'running'].includes(job.status) && event.id === events.at(-1)?.id;
            const state = event.level === 'error' || event.kind === 'failed'
              ? 'error'
              : active
                ? 'active'
                : event.level === 'warning'
                  ? 'warning'
                  : 'complete';
            return (
            <div className={`timeline-item ${state}`} key={event.id}>
              <span className="timeline-marker">
                {state === 'active' ? <LoaderCircle size={13} /> : state === 'complete' ? <Check size={12} /> : state === 'error' ? <X size={12} /> : <i />}
              </span>
              <div><strong>{event.message}</strong><time>{formatTime(event.createdAt)}</time></div>
            </div>
          )})}
        </div>
      </section>

      <div className="drawer-actions">
        {['pending', 'provisioning', 'running'].includes(job.status) && (
          <button className="secondary danger" onClick={onCancel}><CircleStop size={17} />取消任务</button>
        )}
        {['failed', 'cancelled'].includes(job.status) && (
          <button className="primary" disabled={retrying} onClick={onRetry}>
            {retrying ? <LoaderCircle className="spin" size={17} /> : <RotateCcw size={17} />}
            {retrying ? '正在重试' : '重新入队'}
          </button>
        )}
        {job.status === 'succeeded' && (
          <a className="primary" href={resultUrl(job.id, false)}><Download size={17} />下载成片</a>
        )}
      </div>
    </aside>
  </div>
);

export const App = () => {
  const [view, setView] = useState<View>('create');
  const [system, setSystem] = useState<ServiceSnapshot | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selected, setSelected] = useState<Job | null>(null);
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [authRequired, setAuthRequired] = useState(false);
  const [authorized, setAuthorized] = useState(false);
  const [tokenInput, setTokenInput] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [delivery, setDelivery] = useState<JobDelivery | null>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [wizardStep, setWizardStep] = useState<WizardStep>(1);
  const [stepError, setStepError] = useState('');
  const [dispatchConfirmOpen, setDispatchConfirmOpen] = useState(false);

  const [mode, setMode] = useState<JobMode>('clone');
  const [replicaMode, setReplicaMode] = useState<ReplicaMode>('exact');
  const [publishPlatform, setPublishPlatform] = useState<PublishPlatform>('douyin');
  const [translateToChinese, setTranslateToChinese] = useState(true);
  const [title, setTitle] = useState('');
  const [topic, setTopic] = useState('');
  const [script, setScript] = useState('');
  const [duration, setDuration] = useState(75);
  const [ratio, setRatio] = useState<'16:9' | '9:16' | '1:1' | 'avatar'>('9:16');
  const [style, setStyle] = useState('自然专业');
  const [voiceMode, setVoiceMode] = useState<VoiceMode>('original_clone');
  const [avatar, setAvatar] = useState<File | null>(null);
  const [source, setSource] = useState<File | null>(null);
  const [sourceDuration, setSourceDuration] = useState<number | null>(null);
  const [voice, setVoice] = useState<File | null>(null);
  const [audioDuration, setAudioDuration] = useState<number | null>(null);
  const [rights, setRights] = useState(false);
  const [sourceOrigin, setSourceOrigin] = useState<'upload' | 'youtube'>('upload');
  const [youtubeQuery, setYoutubeQuery] = useState('');
  const [youtubeUrl, setYoutubeUrl] = useState('');
  const [youtubeDays, setYoutubeDays] = useState<7 | 30 | 90 | 365>(90);
  const [youtubeLicense, setYoutubeLicense] = useState<'creativeCommon' | 'any'>('creativeCommon');
  const [youtubeDuration, setYoutubeDuration] = useState<'any' | 'short' | '1to5' | '5to15' | '15to30'>('any');
  const [youtubeMinViews, setYoutubeMinViews] = useState<0 | 10000 | 100000 | 1000000>(0);
  const [youtubeMinVelocity, setYoutubeMinVelocity] = useState<0 | 1000 | 10000 | 50000>(0);
  const [youtubeSort, setYoutubeSort] = useState<'velocity' | 'views' | 'newest'>('velocity');
  const [youtubeResults, setYoutubeResults] = useState<YouTubeVideo[]>([]);
  const [youtubeVisibleCount, setYoutubeVisibleCount] = useState(10);
  const [youtubeSearching, setYoutubeSearching] = useState(false);
  const [youtubeImportingId, setYoutubeImportingId] = useState('');
  const [youtubeImport, setYoutubeImport] = useState<YouTubeImport | null>(null);
  const [presenterAssets, setPresenterAssets] = useState<PresenterAsset[]>([]);
  const [avatarAssetId, setAvatarAssetId] = useState('');
  const [voiceAssetId, setVoiceAssetId] = useState('');
  const [saveAvatarAsset, setSaveAvatarAsset] = useState(true);
  const [saveVoiceAsset, setSaveVoiceAsset] = useState(true);
  const [avatarAssetName, setAvatarAssetName] = useState('');
  const [voiceAssetName, setVoiceAssetName] = useState('');

  const refresh = useCallback(async () => {
    try {
      const [systemData, jobsData] = await Promise.all([
        api<ServiceSnapshot>('/api/system'),
        api<{jobs: Job[]}>('/api/jobs'),
      ]);
      setSystem(systemData);
      setJobs(jobsData.jobs);
      setAuthorized(true);
      setError('');
      if (selected) {
        const detail = await api<{job: Job; events: JobEvent[]}>(`/api/jobs/${selected.id}`);
        setSelected(detail.job);
        setEvents((current) => mergeEvents(current, detail.events));
      }
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) setAuthorized(false);
      else setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [selected?.id]);

  useEffect(() => {
    api<{authRequired: boolean}>('/api/public-config')
      .then((data) => {
        setAuthRequired(data.authRequired);
        if (!data.authRequired) setAuthorized(true);
        else api('/api/system').then(() => setAuthorized(true)).catch(() => setAuthorized(false));
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!authorized) return;
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    return () => clearInterval(timer);
  }, [authorized, refresh]);

  const loadPresenterAssets = useCallback(async (): Promise<void> => {
    if (!authorized) return;
    try {
      const data = await api<{assets: PresenterAsset[]}>('/api/presenter-assets');
      setPresenterAssets(data.assets);
    } catch {
      // The creation flow still works with direct uploads if the library is temporarily unavailable.
    }
  }, [authorized]);

  useEffect(() => {
    void loadPresenterAssets();
  }, [loadPresenterAssets]);

  useEffect(() => {
    if (!authorized || !selected || !['pending', 'provisioning', 'running'].includes(selected.status)) return;
    const after = events.at(-1)?.id ?? 0;
    const stream = new EventSource(`/api/jobs/${selected.id}/events?after=${after}`);
    const onJobEvent = (message: MessageEvent<string>): void => {
      const next = JSON.parse(message.data) as JobEvent;
      setEvents((current) => mergeEvents(current, [next]));
    };
    const onSnapshot = (message: MessageEvent<string>): void => {
      const next = JSON.parse(message.data) as Job;
      setSelected((current) => (current?.id === next.id ? next : current));
      setJobs((current) => current.map((job) => (job.id === next.id ? next : job)));
      if (['succeeded', 'failed', 'cancelled'].includes(next.status)) stream.close();
    };
    stream.addEventListener('job_event', onJobEvent as EventListener);
    stream.addEventListener('snapshot', onSnapshot as EventListener);
    return () => stream.close();
  }, [authorized, selected?.id, selected?.status]);

  useEffect(() => {
    if (!selected || selected.status !== 'succeeded') {
      setDelivery(null);
      return;
    }
    let disposed = false;
    api<JobDelivery>(`/api/jobs/${selected.id}/delivery`)
      .then((value) => { if (!disposed) setDelivery(value); })
      .catch(() => { if (!disposed) setDelivery(null); });
    return () => { disposed = true; };
  }, [selected?.id, selected?.status]);

  useEffect(() => {
    if (!authorized || !selected || !['pending', 'provisioning', 'running'].includes(selected.status)) return;
    let cursor = events.at(-1)?.id ?? 0;
    let disposed = false;
    const sync = async (): Promise<void> => {
      try {
        const detail = await api<{job: Job; events: JobEvent[]}>(`/api/jobs/${selected.id}?after=${cursor}`);
        if (disposed) return;
        if (detail.events.length) cursor = detail.events.at(-1)?.id ?? cursor;
        setSelected((current) => (current?.id === detail.job.id ? detail.job : current));
        setJobs((current) => current.map((job) => (job.id === detail.job.id ? detail.job : job)));
        setEvents((current) => mergeEvents(current, detail.events));
      } catch {
        // The regular page refresh remains the fallback for transient stream failures.
      }
    };
    void sync();
    const timer = setInterval(() => void sync(), 2500);
    return () => {
      disposed = true;
      clearInterval(timer);
    };
  }, [authorized, selected?.id, selected?.status]);

  const queuePosition = useMemo(() => jobs.filter((job) => ['pending', 'provisioning', 'running'].includes(job.status)).length, [jobs]);
  const contentSummary = mode === 'script' ? script.trim() : topic.trim();
  const selectedAvatarAsset = presenterAssets.find((asset) => asset.id === avatarAssetId);
  const selectedVoiceAsset = presenterAssets.find((asset) => asset.id === voiceAssetId);
  const hasCloneSource = sourceOrigin === 'youtube' ? Boolean(youtubeImport) : Boolean(source);
  const presenterPrimaryStyle = style === '真人主画面·悬浮组件';
  const selectedPublishingPreset = publishingPresets.find((preset) => preset.id === publishPlatform)!;
  const platformPreferredDuration = selectedPublishingPreset.preferredDuration;
  const assetSummary = selectedAvatarAsset?.name ?? avatar?.name ?? (presenterPrimaryStyle ? '未选择人物图片' : mode === 'clone' ? '从参考视频取人物' : source?.name);
  const sourceSummary = youtubeImport?.video.title ?? source?.name;
  const durationSummary =
    mode === 'clone'
      ? replicaMode === 'exact'
        ? sourceDuration ? `完整复刻 · ${formatAudioDuration(sourceDuration)}` : '完整复刻'
        : `精简复刻 · 核心提炼 · ≤${duration} 秒`
      : voiceMode === 'uploaded_audio' && audioDuration ? formatAudioDuration(audioDuration) : 'AI 自动规划';
  const voiceSummary =
    (voice || selectedVoiceAsset) && (voiceMode === 'uploaded_audio' || voiceMode === 'uploaded_reference')
      ? `${voiceLabel[voiceMode]} · ${selectedVoiceAsset?.name ?? voice?.name}`
      : voiceLabel[voiceMode];
  const condensedMaximum = sourceDuration
    ? Math.min(maximumGeneratedDurationSeconds, Math.max(minimumGeneratedDurationSeconds, Math.ceil(sourceDuration)))
    : maximumGeneratedDurationSeconds;
  const condensedDurationInvalid =
    mode === 'clone' &&
    replicaMode === 'condensed' &&
    voiceMode !== 'uploaded_audio' &&
    (!Number.isFinite(duration) || duration < minimumGeneratedDurationSeconds || duration > condensedMaximum);
  const condensedCompression = sourceDuration && duration > 0 ? sourceDuration / duration : null;
  const exactDirectAudioMismatch =
    mode === 'clone' &&
    replicaMode === 'exact' &&
    voiceMode === 'uploaded_audio' &&
    Boolean(sourceDuration && audioDuration) &&
    Math.abs(sourceDuration! - audioDuration!) > Math.max(5, sourceDuration! * 0.15);
  const condensedOptions = sourceDuration
    ? [...new Set([5, 15, 30, 60, 90, 120, 180, 300, condensedMaximum])]
        .filter((seconds) => seconds >= minimumGeneratedDurationSeconds && seconds <= condensedMaximum)
        .sort((left, right) => left - right)
        .slice(0, 7)
    : [15, 30, 60, 90, 120, 180, 300];

  const choosePublishingPlatform = (next: PublishPlatform): void => {
    const preset = publishingPresets.find((item) => item.id === next)!;
    setPublishPlatform(next);
    setRatio(preset.aspectRatio ?? (presenterPrimaryStyle ? 'avatar' : '16:9'));
    if (voiceMode !== 'uploaded_audio') {
      if (mode === 'clone' && replicaMode === 'exact' && sourceDuration) {
        setDuration(Math.ceil(sourceDuration));
      } else if (mode === 'clone' && replicaMode === 'condensed' && sourceDuration) {
        setDuration(condensedTargetForSource(sourceDuration, preset.preferredDuration));
      } else {
        setDuration(preset.preferredDuration);
      }
    }
    setStepError('');
  };

  const searchYouTube = async (): Promise<void> => {
    if (!youtubeQuery.trim()) return setStepError('请输入要寻找的 YouTube 视频关键词');
    setYoutubeSearching(true);
    setStepError('');
    try {
      const params = new URLSearchParams({
        q: youtubeQuery.trim(),
        days: String(youtubeDays),
        license: youtubeLicense,
        duration: youtubeDuration,
        minViews: String(youtubeMinViews),
        minViewsPerDay: String(youtubeMinVelocity),
        sort: youtubeSort,
      });
      const data = await api<{videos: YouTubeVideo[]}>(`/api/youtube/search?${params}`);
      setYoutubeResults(data.videos);
      setYoutubeVisibleCount(10);
      if (!data.videos.length) {
        const suggestion = youtubeMinVelocity > 0
          ? '日均播放门槛最容易筛空，建议先降低一档'
          : youtubeMinViews > 0
            ? '建议先降低最低播放量'
            : youtubeDuration !== 'any'
              ? '建议扩大视频时长范围'
              : youtubeDays < 365
                ? '建议扩大发布时间范围'
                : youtubeLicense === 'creativeCommon'
                  ? '可切换为“全部授权”后重试'
                  : '请换一个更宽泛的关键词';
        setStepError(`没有找到同时满足当前条件的视频；${suggestion}`);
      }
    } catch (caught) {
      setStepError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setYoutubeSearching(false);
    }
  };

  const importYouTubeVideo = async (url: string, videoId = 'url'): Promise<void> => {
    if (!rights) return setStepError('请先确认拥有该 YouTube 视频的下载和改编权');
    setYoutubeImportingId(videoId);
    setStepError('');
    try {
      const data = await api<{import: YouTubeImport}>('/api/youtube/import', {
        method: 'POST',
        body: JSON.stringify({url, rightsConfirmed: true}),
      });
      setYoutubeImport(data.import);
      setYoutubeUrl(data.import.video.url);
      setSource(null);
      const seconds = data.import.video.durationSeconds;
      setSourceDuration(seconds);
      if (replicaMode === 'exact') setDuration(Math.ceil(seconds));
      else setDuration(condensedTargetForSource(seconds, platformPreferredDuration));
    } catch (caught) {
      setStepError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setYoutubeImportingId('');
    }
  };

  const selectAvatarAsset = (asset: PresenterAsset): void => {
    setAvatarAssetId(asset.id);
    setAvatar(null);
    setStepError('');
  };

  const selectVoiceAsset = (asset: PresenterAsset): void => {
    setVoiceAssetId(asset.id);
    setVoice(null);
    setAudioDuration(asset.durationSeconds);
    setVoiceMode('uploaded_reference');
    setStepError('');
  };

  const chooseVoiceMode = (nextMode: VoiceMode): void => {
    setVoiceMode(nextMode);
    if (nextMode === 'uploaded_audio' && audioDuration) setDuration(Math.max(1, Math.ceil(audioDuration)));
    else if (mode === 'clone' && replicaMode === 'exact' && sourceDuration) setDuration(Math.ceil(sourceDuration));
    else if (mode === 'clone' && replicaMode === 'condensed' && sourceDuration) {
      setDuration(condensedTargetForSource(sourceDuration, platformPreferredDuration));
    }
    else setDuration(platformPreferredDuration);
    setStepError('');
  };

  const updateVoiceReference = async (file: File | null): Promise<void> => {
    if (!file) {
      setVoice(null);
      setVoiceAssetId('');
      setAudioDuration(null);
      setVoiceMode(mode === 'clone' ? 'original_clone' : 'system_voice');
      setDuration(
        mode === 'clone' && replicaMode === 'exact' && sourceDuration
          ? Math.ceil(sourceDuration)
          : mode === 'clone' && replicaMode === 'condensed'
            ? sourceDuration ? condensedTargetForSource(sourceDuration, platformPreferredDuration) : platformPreferredDuration
            : platformPreferredDuration,
      );
      setStepError('');
      return;
    }
    try {
      const seconds = await readAudioDuration(file);
      if (seconds > 180) {
        setVoice(null);
        setAudioDuration(null);
        setStepError('口播音频最长 180 秒');
        return;
      }
      setVoice(file);
      setVoiceAssetId('');
      setVoiceAssetName(file.name.replace(/\.[^.]+$/, ''));
      setAudioDuration(seconds);
      setVoiceMode('uploaded_reference');
      if (mode === 'clone' && replicaMode === 'exact' && sourceDuration) setDuration(Math.ceil(sourceDuration));
      else if (mode === 'clone' && replicaMode === 'condensed' && sourceDuration) {
        setDuration(condensedTargetForSource(sourceDuration, platformPreferredDuration));
      }
      else setDuration(platformPreferredDuration);
      setStepError('');
    } catch (caught) {
      setVoice(null);
      setAudioDuration(null);
      setStepError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const updateSourceReference = async (file: File | null): Promise<void> => {
    setSource(file);
    setYoutubeImport(null);
    setSourceDuration(null);
    setStepError('');
    if (!file) return;
    try {
      const seconds = await readVideoDuration(file);
      setSourceDuration(seconds);
      if (replicaMode === 'exact') setDuration(Math.max(1, Math.ceil(seconds)));
      else setDuration(condensedTargetForSource(seconds, platformPreferredDuration));
    } catch (caught) {
      setSource(null);
      setStepError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const nextWizardStep = (): void => {
    if (wizardStep === 1) {
      if (mode === 'clone' && !hasCloneSource) return setStepError('请上传原片，或从 YouTube 导入需要复刻的视频');
      if (condensedDurationInvalid) return setStepError(`精简复刻目标时长需在 ${minimumGeneratedDurationSeconds}–${condensedMaximum} 秒之间`);
      if (mode === 'topic' && !topic.trim()) return setStepError('请先填写视频主题');
      if (mode === 'script' && !script.trim()) return setStepError('请先填写口播文案');
      setWizardStep(2);
    } else if (wizardStep === 2) {
      if (mode === 'clone' && !hasCloneSource) return setStepError('复刻视频需要上传或导入参考视频');
      if (presenterPrimaryStyle && !avatar && !avatarAssetId) return setStepError('“真人主画面·悬浮组件”需要选择已保存形象或上传人物图片');
      if (!avatar && !avatarAssetId && !hasCloneSource) return setStepError('请选择已保存形象，或上传人物图片');
      if (voiceMode === 'original_clone' && !hasCloneSource) return setStepError('原声克隆需要带人声的参考视频');
      if (voiceMode === 'uploaded_audio' && !voice && !voiceAssetId) return setStepError('请选择声音素材，或上传最长 180 秒的口播音频');
      if (voiceMode === 'uploaded_reference' && !voice && !voiceAssetId) return setStepError('请选择声音素材，或上传 5-30 秒参考声音');
      if (voiceMode === 'uploaded_reference' && audioDuration && (audioDuration < 5 || audioDuration > 30)) {
        return setStepError('参考音色需要 5-30 秒干净人声');
      }
      if (exactDirectAudioMismatch) return setStepError(`整段音频时长需要接近原片 ${formatAudioDuration(sourceDuration!)}`);
      setWizardStep(3);
    }
    setStepError('');
  };

  const previousWizardStep = (): void => {
    setDispatchConfirmOpen(false);
    setWizardStep((current) => Math.max(1, current - 1) as WizardStep);
    setStepError('');
  };

  const requestDispatch = (event: React.FormEvent): void => {
    event.preventDefault();
    if (wizardStep !== 3) {
      nextWizardStep();
      return;
    }
    if (!rights) {
      setStepError('请先确认拥有上传人物、声音和视频素材的使用权');
      return;
    }
    if (system?.service.accepting === false) {
      setStepError('服务维护中，暂时无法发起任务');
      return;
    }
    setStepError('');
    setDispatchConfirmOpen(true);
  };

  const dispatchJob = async (): Promise<void> => {
    if (condensedDurationInvalid) {
      setStepError(`精简复刻目标时长需在 ${minimumGeneratedDurationSeconds}–${condensedMaximum} 秒之间`);
      setDispatchConfirmOpen(false);
      setWizardStep(1);
      return;
    }
    if (presenterPrimaryStyle && !avatar && !avatarAssetId) {
      setStepError('“真人主画面·悬浮组件”需要选择已保存形象或上传人物图片');
      setDispatchConfirmOpen(false);
      setWizardStep(2);
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const form = new FormData();
      const sourceTitle = youtubeImport?.video.title.slice(0, 24) ?? source?.name.replace(/\.[^.]+$/, '').slice(0, 24) ?? '';
      const fallbackTitle = mode === 'script' ? script.slice(0, 24) : mode === 'clone' ? sourceTitle : topic.slice(0, 24);
      form.set('title', title || fallbackTitle || 'AI 口播任务');
      form.set('mode', mode);
      form.set('replicaMode', replicaMode);
      form.set('publishPlatform', publishPlatform);
      form.set('translateToChinese', String(mode === 'clone' && translateToChinese));
      form.set('topic', topic);
      form.set('script', script);
      form.set('durationSeconds', String(duration));
      form.set('aspectRatio', ratio);
      form.set('style', style);
      form.set('voiceMode', voiceMode);
      form.set('rightsConfirmed', String(rights));
      if (avatar) form.set('avatarImage', avatar);
      if (source) form.set('sourceVideo', source);
      if (voice) form.set('voiceReference', voice);
      if (youtubeImport) form.set('youtubeImportId', youtubeImport.id);
      if (avatarAssetId) form.set('avatarAssetId', avatarAssetId);
      if (voiceAssetId) form.set('voiceAssetId', voiceAssetId);
      if (avatar && saveAvatarAsset) {
        form.set('saveAvatarAsset', 'true');
        form.set('avatarAssetName', avatarAssetName || avatar.name.replace(/\.[^.]+$/, ''));
      }
      if (voice && saveVoiceAsset) {
        form.set('saveVoiceAsset', 'true');
        form.set('voiceAssetName', voiceAssetName || voice.name.replace(/\.[^.]+$/, ''));
      }
      const response = await api<{job: Job; savedAssets?: PresenterAsset[]}>('/api/jobs', {method: 'POST', body: form});
      if (response.savedAssets?.length) await loadPresenterAssets();
      setNotice('任务已进入队列，可在任务详情中查看进度');
      setSelected(response.job);
      setEvents([]);
      setDispatchConfirmOpen(false);
      setView('queue');
      setTimeout(() => setNotice(''), 3500);
      await refresh();
    } catch (caught) {
      setDispatchConfirmOpen(false);
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setSubmitting(false);
    }
  };

  const openJob = async (job: Job) => {
    const detail = await api<{job: Job; events: JobEvent[]}>(`/api/jobs/${job.id}`);
    setSelected(detail.job);
    setEvents(detail.events.slice(-500));
  };

  const retrySelected = async () => {
    if (!selected || !window.confirm(`确认重试“${selected.title}”？任务会重新入队，并可能启动 GPU 实例。`)) return;
    setRetrying(true);
    setError('');
    try {
      const response = await api<{job: Job; reusedCheckpoints: boolean; reusedCompletedArtifacts: boolean}>(`/api/jobs/${selected.id}/retry`, {
        method: 'POST',
      });
      setNotice(
        response.reusedCompletedArtifacts
          ? '已重新入队，将复用现有成片修复验收'
          : response.reusedCheckpoints
            ? '已重新入队，将从已完成分段继续'
            : '已重新入队',
      );
      setSelected(response.job);
      setEvents([]);
      await refresh();
      await openJob(response.job);
      setTimeout(() => setNotice(''), 3500);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setRetrying(false);
    }
  };

  if (authRequired && !authorized) {
    return (
      <main className="login-screen">
        <form
          className="login-panel"
          onSubmit={async (event) => {
            event.preventDefault();
            try {
              await api('/api/session', {method: 'POST', body: JSON.stringify({token: tokenInput})});
              setAuthorized(true);
              setError('');
            } catch (caught) {
              setError(caught instanceof Error ? caught.message : String(caught));
            }
          }}
        >
          <div className="brand-mark"><Bot size={28} /></div>
          <h1>AI 口播工厂</h1>
          <label>访问口令<input type="password" value={tokenInput} onChange={(event) => setTokenInput(event.target.value)} autoFocus /></label>
          {error && <div className="error-banner">{error}</div>}
          <button className="primary" type="submit"><LogIn size={18} />进入工作台</button>
        </form>
      </main>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand"><div className="brand-mark"><Bot size={23} /></div><span><strong>口播工厂</strong><small>AI Presenter Ops</small></span></div>
        <nav>
          <button title="创建任务" className={view === 'create' ? 'active' : ''} onClick={() => setView('create')}><Plus size={19} />创建任务</button>
          <button title="任务队列" className={view === 'queue' ? 'active' : ''} onClick={() => setView('queue')}><LayoutDashboard size={19} />任务队列{queuePosition > 0 && <b>{queuePosition}</b>}</button>
        </nav>
        <div className="sidebar-foot"><Activity size={16} /><span>服务正常</span></div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div><h1>{view === 'create' ? '视频工作台' : '任务队列'}</h1><span>{new Intl.DateTimeFormat('zh-CN', {weekday: 'short', month: 'long', day: 'numeric'}).format(new Date())}</span></div>
          <div className="topbar-actions">
            <div className="topbar-status">
              <span><i className={system?.service.status === 'processing' ? 'busy' : ''} />{system?.service.status === 'processing' ? '生成中' : '可提交'}</span>
              <span>{system?.queue.active ?? 0} 处理中</span>
              <span>{system?.queue.pending ?? 0} 排队</span>
            </div>
            <button className="icon-button" title="刷新" onClick={() => void refresh()}><RefreshCw size={18} /></button>
          </div>
        </header>

        {notice && <div className="notice-banner">{notice}</div>}
        {error && <div className="error-banner">{error}<button onClick={() => setError('')}><X size={16} /></button></div>}

        {view === 'create' ? (
          <form className="guided-create" onSubmit={requestDispatch}>
            <section className="form-surface guided-surface">
              <div className="create-heading">
                <ParticlesProvider init={loadConsoleParticles}>
                  <Particles id="create-console-particles" className="console-particles" options={consoleParticles} />
                </ParticlesProvider>
                <div>
                  <span><Sparkles size={15} />AI Presenter</span>
                  <h2>{mode === 'clone' ? '复刻参考视频' : mode === 'topic' ? '从主题创作' : '使用现有文案'}</h2>
                </div>
                <div className="create-heading-mark" aria-hidden="true"><Film size={21} /></div>
              </div>
              <div className="wizard-steps" aria-label="创建进度">
                {(mode === 'clone' ? ['上传原片', '人物声音', '检查配置'] : ['创作内容', '人物声音', '检查配置']).map((label, index) => {
                  const step = (index + 1) as WizardStep;
                  return (
                    <div className={`wizard-step ${wizardStep === step ? 'current' : ''} ${wizardStep > step ? 'complete' : ''}`} aria-current={wizardStep === step ? 'step' : undefined} key={label}>
                      <i>{wizardStep > step ? <Check size={15} /> : step}</i>
                      <span>{label}</span>
                    </div>
                  );
                })}
              </div>

              <AnimatePresence mode="wait" initial={false}>
              {wizardStep === 1 && (
                <motion.div
                  className="wizard-pane creation-section"
                  key={`step-1-${mode}`}
                  initial={{opacity: 0, y: 4}}
                  animate={{opacity: 1, y: 0}}
                  exit={{opacity: 0, y: -3}}
                  transition={{duration: 0.13, ease: 'easeOut'}}
                >
                  <div className="section-title"><Sparkles size={18} /><h2>创作方式</h2></div>
                  <div className="segmented mode-segmented mode-switcher">
                    {modeConfig.map(({id, label, icon: Icon}) => (
                      <motion.button
                        type="button"
                        className={mode === id ? 'active' : ''}
                        key={id}
                        whileTap={{scale: 0.98}}
                        onClick={() => {
                          setMode(id);
                          setStepError('');
                          if (voice || voiceAssetId) setVoiceMode('uploaded_reference');
                          else if (id === 'clone') {
                            setVoiceMode('original_clone');
                            setReplicaMode('exact');
                            if (sourceDuration) setDuration(Math.ceil(sourceDuration));
                          }
                          else {
                            if (!hasCloneSource && voiceMode === 'original_clone') setVoiceMode('system_voice');
                            if (voiceMode !== 'uploaded_audio') setDuration(platformPreferredDuration);
                          }
                        }}
                      >
                        {mode === id && <motion.span className="mode-active-track" layoutId="mode-active-track" transition={{duration: 0.14}} />}
                        <span className="mode-button-label"><Icon size={18} />{label}</span>
                      </motion.button>
                    ))}
                  </div>
                  <div className="content-field">
                    {mode === 'topic' && <label>视频主题<textarea value={topic} onChange={(event) => { setTopic(event.target.value); setStepError(''); }} placeholder="输入主题、受众和核心观点" rows={5} /></label>}
                    {mode === 'script' && <label>口播文案<textarea value={script} onChange={(event) => { setScript(event.target.value); setStepError(''); }} placeholder="输入最终口播文案" rows={6} /></label>}
                    {mode === 'clone' && (
                      <div className="clone-input-stack">
                        <div className="clone-source-column">
                          <div className="source-origin-switch segmented" aria-label="视频来源">
                            <button type="button" className={sourceOrigin === 'upload' ? 'active' : ''} aria-pressed={sourceOrigin === 'upload'} onClick={() => { setSourceOrigin('upload'); if (source) void updateSourceReference(source); else setSourceDuration(null); setStepError(''); }}><Upload size={16} />本地上传</button>
                            <button type="button" className={sourceOrigin === 'youtube' ? 'active' : ''} aria-pressed={sourceOrigin === 'youtube'} onClick={() => { setSourceOrigin('youtube'); setSourceDuration(youtubeImport?.video.durationSeconds ?? null); setStepError(''); }}><Youtube size={17} />YouTube 热门</button>
                          </div>
                          {sourceOrigin === 'upload' ? (
                            <VideoSourceField file={source} onChange={(file) => void updateSourceReference(file)} />
                          ) : (
                            <div className="youtube-radar">
                              {youtubeImport ? (
                                <div className="youtube-selected">
                                  <img src={youtubeImport.video.thumbnailUrl} alt="" />
                                  <span><small>已导入 YouTube 原片</small><strong>{youtubeImport.video.title}</strong><i>{youtubeImport.video.channelTitle} · {formatAudioDuration(youtubeImport.video.durationSeconds)}</i></span>
                                  <button type="button" title="移除 YouTube 原片" onClick={() => { setYoutubeImport(null); setSourceDuration(null); setYoutubeUrl(''); }}><X size={17} /></button>
                                </div>
                              ) : (
                                <>
                                  <div className="youtube-direct-row">
                                    <span><Link size={16} /><input aria-label="YouTube 视频链接" value={youtubeUrl} onChange={(event) => setYoutubeUrl(event.target.value)} placeholder="粘贴 YouTube 视频链接" /></span>
                                    <button className="secondary" type="button" disabled={Boolean(youtubeImportingId) || !youtubeUrl.trim()} onClick={() => void importYouTubeVideo(youtubeUrl)}>{youtubeImportingId === 'url' ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />}导入</button>
                                  </div>
                                  <div className="radar-divider"><span>或者按关键词寻找爆款</span></div>
                                  <div className="youtube-search-row">
                                    <span><Search size={16} /><input aria-label="YouTube 搜索关键词" value={youtubeQuery} onChange={(event) => setYoutubeQuery(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') { event.preventDefault(); void searchYouTube(); } }} placeholder="例如：AI Agent 教程" /></span>
                                    <button className="primary" type="button" disabled={youtubeSearching} onClick={() => void searchYouTube()}>{youtubeSearching ? <LoaderCircle className="spin" size={16} /> : <Search size={16} />}找爆款</button>
                                  </div>
                                  <div className="youtube-filter-strip" aria-label="爆款筛选条件">
                                    <label><small>发布时间</small><select aria-label="发布时间" value={youtubeDays} onChange={(event) => setYoutubeDays(Number(event.target.value) as 7 | 30 | 90 | 365)}><option value={7}>近 7 天</option><option value={30}>近 30 天</option><option value={90}>近 90 天</option><option value={365}>近一年</option></select></label>
                                    <label><small>视频时长</small><select aria-label="视频时长" value={youtubeDuration} onChange={(event) => setYoutubeDuration(event.target.value as typeof youtubeDuration)}><option value="any">全部时长</option><option value="short">60 秒以内</option><option value="1to5">1–5 分钟</option><option value="5to15">5–15 分钟</option><option value="15to30">15–30 分钟</option></select></label>
                                    <label><small>最低播放</small><select aria-label="最低总播放量" value={youtubeMinViews} onChange={(event) => setYoutubeMinViews(Number(event.target.value) as typeof youtubeMinViews)}><option value={0}>不限</option><option value={10000}>1 万+</option><option value={100000}>10 万+</option><option value={1000000}>100 万+</option></select></label>
                                    <label><small>日均播放</small><select aria-label="最低日均播放量" value={youtubeMinVelocity} onChange={(event) => setYoutubeMinVelocity(Number(event.target.value) as typeof youtubeMinVelocity)}><option value={0}>不限</option><option value={1000}>1 千+/天</option><option value={10000}>1 万+/天</option><option value={50000}>5 万+/天</option></select></label>
                                    <label><small>授权</small><select aria-label="视频授权" value={youtubeLicense} onChange={(event) => setYoutubeLicense(event.target.value as 'creativeCommon' | 'any')}><option value="creativeCommon">CC 优先</option><option value="any">全部授权</option></select></label>
                                    <label><small>排序</small><select aria-label="搜索结果排序" value={youtubeSort} onChange={(event) => setYoutubeSort(event.target.value as typeof youtubeSort)}><option value="velocity">爆发速度</option><option value="views">总播放量</option><option value="newest">最新发布</option></select></label>
                                  </div>
                                  {youtubeResults.length > 0 && (
                                    <div className="trend-results-wrap">
                                      <div className="trend-results-heading"><span>显示 {Math.min(youtubeVisibleCount, youtubeResults.length)} / {youtubeResults.length} 条</span><small>{youtubeSort === 'velocity' ? '按日均播放排序' : youtubeSort === 'views' ? '按总播放排序' : '按发布时间排序'}</small></div>
                                      <div className="trend-results">
                                      {youtubeResults.slice(0, youtubeVisibleCount).map((video, index) => (
                                        <article className="trend-result" key={video.id}>
                                          <b>{String(index + 1).padStart(2, '0')}</b>
                                          <img src={video.thumbnailUrl} alt="" />
                                          <div><a href={video.url} target="_blank" rel="noreferrer" title="在 YouTube 打开"><strong>{video.title}</strong><ExternalLink size={12} /></a><span>{video.channelTitle} · {formatPublishedDate(video.publishedAt)}</span><small><i>{formatCompactNumber(video.viewCount)} 播放</i><i>{formatCompactNumber(video.viewsPerDay)}/天</i><i>{formatAudioDuration(video.durationSeconds)}</i><i>{video.license === 'creativeCommon' ? 'CC 可复用' : '需确认授权'}</i></small></div>
                                          <button type="button" disabled={Boolean(youtubeImportingId)} onClick={() => void importYouTubeVideo(video.url, video.id)}>{youtubeImportingId === video.id ? <LoaderCircle className="spin" size={16} /> : <Download size={16} />}导入并复刻</button>
                                        </article>
                                      ))}
                                      </div>
                                      {youtubeVisibleCount < youtubeResults.length && (
                                        <div className="trend-load-more">
                                          <span><i style={{width: `${Math.min(100, youtubeVisibleCount / youtubeResults.length * 100)}%`}} /></span>
                                          <button type="button" onClick={() => setYoutubeVisibleCount((current) => Math.min(current + 10, youtubeResults.length))}><ChevronDown size={15} />继续展开 {Math.min(10, youtubeResults.length - youtubeVisibleCount)} 条</button>
                                        </div>
                                      )}
                                    </div>
                                  )}
                                  <label className="youtube-rights"><input type="checkbox" checked={rights} onChange={(event) => setRights(event.target.checked)} /><span>确认我拥有所选视频的下载和改编权；公开视频不等于可自由复刻</span></label>
                                </>
                              )}
                            </div>
                          )}
                          <div className="replica-mode-control">
                            <span>复刻范围</span>
                            <div className="segmented">
                              <button type="button" aria-pressed={replicaMode === 'exact'} className={replicaMode === 'exact' ? 'active' : ''} onClick={() => { setReplicaMode('exact'); if (sourceDuration) setDuration(Math.ceil(sourceDuration)); }}>完整复刻</button>
                              <button type="button" aria-pressed={replicaMode === 'condensed'} className={replicaMode === 'condensed' ? 'active' : ''} onClick={() => { setReplicaMode('condensed'); setDuration(sourceDuration ? condensedTargetForSource(sourceDuration, platformPreferredDuration) : platformPreferredDuration); setStepError(''); }}>精简复刻</button>
                            </div>
                          </div>
                          <label className="youtube-rights translation-option">
                            <input type="checkbox" checked={translateToChinese} onChange={(event) => setTranslateToChinese(event.target.checked)} />
                            <span><strong>翻译成中文口播</strong><small>勾选后把原片内容翻成自然中文，并重新生成中文配音、字幕和数字人口型；不勾选则保留原语言</small></span>
                          </label>
                          {sourceDuration && (
                            <div className={`duration-feasibility ${condensedDurationInvalid ? 'invalid' : ''}`}>
                              <div className="feasibility-heading">
                                {condensedDurationInvalid ? <TriangleAlert size={18} /> : <Gauge size={18} />}
                                <span>
                                  <strong>{replicaMode === 'exact' ? '按原片完整复刻' : condensedDurationInvalid ? '目标时长不可提交' : '按目标时长提炼'}</strong>
                                  <small>
                                    原片 {formatAudioDuration(sourceDuration)}
                                    {replicaMode === 'condensed' && condensedCompression ? ` · 约 ${condensedCompression.toFixed(1)}× 压缩` : ' · 不压缩内容'}
                                  </small>
                                </span>
                              </div>
                              {replicaMode === 'exact' ? (
                                <strong className="feasibility-duration">{formatAudioDuration(sourceDuration)}</strong>
                              ) : (
                                <div className="duration-planner">
                                  <label>
                                    输出时长
                                    <span className="duration-number"><input type="number" aria-invalid={condensedDurationInvalid} min={minimumGeneratedDurationSeconds} max={condensedMaximum} step={1} value={duration} onChange={(event) => { setDuration(Number(event.target.value)); setStepError(''); }} /><b>秒</b></span>
                                  </label>
                                  <div className="duration-presets" aria-label="快捷时长">
                                    {condensedOptions.map((seconds) => <button type="button" key={seconds} className={duration === seconds ? 'active' : ''} onClick={() => { setDuration(seconds); setStepError(''); }}>{formatAudioDuration(seconds)}</button>)}
                                  </div>
                                </div>
                              )}
                              {replicaMode === 'condensed' && (
                                <p>允许删除次要观点、案例、展开论据和重复内容；保留核心主题、关键论点和结论。开场钩子与结束语保持完整，封面和发布文案会同步增强短视频网感。</p>
                              )}
                            </div>
                          )}
                        </div>
                        <label>补充要求（可选，不会作为口播文案）<textarea value={topic} onChange={(event) => { setTopic(event.target.value); setStepError(''); }} placeholder="保留原片主题和演示节奏" rows={3} /></label>
                      </div>
                    )}
                  </div>
                </motion.div>
              )}

              {wizardStep === 2 && (
                <motion.div
                  className="wizard-pane"
                  key="step-2"
                  initial={{opacity: 0, y: 4}}
                  animate={{opacity: 1, y: 0}}
                  exit={{opacity: 0, y: -3}}
                  transition={{duration: 0.13, ease: 'easeOut'}}
                >
                  <div className="section-title"><Video size={18} /><h2>发布平台、人物与声音</h2></div>
                  <section className="publishing-platform-panel">
                    <div className="publishing-platform-heading">
                      <span>发布平台</span>
                      <small>平台预设会锁定画幅、安全区、首帧和节奏</small>
                    </div>
                    <div className="publishing-platform-grid" role="group" aria-label="发布平台">
                      {publishingPresets.map((preset) => (
                        <button
                          type="button"
                          key={preset.id}
                          aria-pressed={publishPlatform === preset.id}
                          className={publishPlatform === preset.id ? 'active' : ''}
                          onClick={() => choosePublishingPlatform(preset.id)}
                        >
                          <span><strong>{preset.label}</strong><i>{preset.resolution}</i></span>
                          <small>{preset.description}</small>
                        </button>
                      ))}
                    </div>
                    {publishPlatform !== 'original' && (
                      <p className="publishing-platform-lock"><Check size={14} />{selectedPublishingPreset.label}预设已锁定 {selectedPublishingPreset.aspectRatio} · {selectedPublishingPreset.resolution}</p>
                    )}
                  </section>
                  <PresenterAssetShelf kind="avatar" assets={presenterAssets.filter((asset) => asset.kind === 'avatar')} selectedId={avatarAssetId} onSelect={selectAvatarAsset} />
                  <div className="simple-upload">
                    <FileField
                      label={mode === 'clone' ? '上传新形象（可选）' : '上传新人物图片'}
                      accept="image/png,image/jpeg,image/webp"
                      icon={ImageIcon}
                      file={avatar}
                      onChange={(file) => { setAvatar(file); setAvatarAssetId(''); setAvatarAssetName(file?.name.replace(/\.[^.]+$/, '') ?? ''); setStepError(''); }}
                    />
                  </div>
                  {presenterPrimaryStyle && <p className="presenter-style-hint"><ImageIcon size={15} />此风格以这里选择或上传的人物图片为唯一形象来源；{publishPlatform === 'original' ? '原尺寸母版可选择“跟随人物图”。' : `${selectedPublishingPreset.label}会按 ${selectedPublishingPreset.aspectRatio} 安全裁切并保持人物不拉伸。`}</p>}
                  {avatar && (
                    <div className="save-asset-row">
                      <label><input type="checkbox" checked={saveAvatarAsset} onChange={(event) => setSaveAvatarAsset(event.target.checked)} /><Save size={15} />保存到形象库</label>
                      {saveAvatarAsset && <input aria-label="形象素材名称" value={avatarAssetName} onChange={(event) => setAvatarAssetName(event.target.value)} placeholder="给这个形象命名" />}
                    </div>
                  )}
                  <PresenterAssetShelf kind="voice" assets={presenterAssets.filter((asset) => asset.kind === 'voice')} selectedId={voiceAssetId} onSelect={selectVoiceAsset} />
                  <div className="voice-upload">
                    <FileField label="上传新声音（默认克隆音色）" accept=".mp3,.wav,.m4a,audio/mpeg,audio/mp3,audio/wav,audio/x-wav,audio/mp4" icon={FileAudio} file={voice} onChange={updateVoiceReference} />
                  </div>
                  {voice && (
                    <div className="save-asset-row">
                      <label><input type="checkbox" checked={saveVoiceAsset} onChange={(event) => setSaveVoiceAsset(event.target.checked)} /><Save size={15} />保存到声音库</label>
                      {saveVoiceAsset && <input aria-label="声音素材名称" value={voiceAssetName} onChange={(event) => setVoiceAssetName(event.target.value)} placeholder="给这个声音命名" />}
                    </div>
                  )}
                  {(voice || selectedVoiceAsset) && audioDuration && (
                    <div className="voice-intent-panel">
                      <div className="voice-intent-heading"><span>这段音频用来做什么？</span><small>{formatAudioDuration(audioDuration)}</small></div>
                      <div className="voice-intent-grid" role="group" aria-label="音频用途">
                        <button type="button" aria-pressed={voiceMode === 'uploaded_reference'} className={voiceMode === 'uploaded_reference' ? 'active' : ''} onClick={() => chooseVoiceMode('uploaded_reference')}>
                          <span><strong>克隆这段声音</strong><i>默认 · 推荐</i></span>
                          <small>只学习音色，再按原片内容生成新口播；需要 5–30 秒干净人声。</small>
                        </button>
                        <button type="button" aria-pressed={voiceMode === 'uploaded_audio'} className={voiceMode === 'uploaded_audio' ? 'active' : ''} onClick={() => chooseVoiceMode('uploaded_audio')}>
                          <span><strong>直接使用整段音频</strong></span>
                          <small>不生成新旁白，视频时长跟随这段音频；最长 180 秒。</small>
                        </button>
                      </div>
                      {voiceMode === 'uploaded_reference' && (audioDuration < 5 || audioDuration > 30) && <p className="voice-intent-warning"><TriangleAlert size={15} />当前音频不适合作为克隆样本，请裁剪至 5–30 秒，或明确选择“直接使用整段音频”。</p>}
                      {exactDirectAudioMismatch && <p className="voice-intent-warning"><TriangleAlert size={15} />整段音频与原片时长差异过大，完整复刻需要接近 {formatAudioDuration(sourceDuration!)}；建议改用声音克隆。</p>}
                    </div>
                  )}

                  <div className="advanced-section">
                    <button type="button" className={`advanced-toggle ${advancedOpen ? 'open' : ''}`} aria-expanded={advancedOpen} onClick={() => setAdvancedOpen((current) => !current)}>
                      <span className="advanced-toggle-copy"><SlidersHorizontal size={18} /><span><strong>高级设置</strong><small>{style} · {ratio} · {title.trim() || '自动命名'}</small></span></span>
                      <ChevronDown size={18} />
                    </button>

                    {advancedOpen && (
                      <div className="advanced-panel">
                        <div className="two-columns">
                          <label>任务名称<input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="自动使用内容摘要" /></label>
                          <label>画面风格<select value={style} onChange={(event) => { const nextStyle = event.target.value; setStyle(nextStyle); if (publishPlatform === 'original') { if (nextStyle === '真人主画面·悬浮组件') setRatio('avatar'); else if (ratio === 'avatar') setRatio('16:9'); } setStepError(''); }}><option>自然专业</option><option value="真人主画面·悬浮组件">真人主画面·悬浮组件（需人物图）</option><option>科技冷静</option><option>亲切生活化</option><option>高能短视频</option><option>电影访谈</option></select></label>
                        </div>
                        <div className={`advanced-grid ${voice || selectedVoiceAsset ? 'single-column' : ''}`}>
                          {!(voice || selectedVoiceAsset) && <label>默认声音来源<select value={voiceMode} onChange={(event) => chooseVoiceMode(event.target.value as VoiceMode)}>{mode === 'clone' && <option value="original_clone">克隆参考视频声音</option>}<option value="system_voice">系统高质量声音</option></select></label>}
                          <div className="setting-control"><span>画幅比例</span>{publishPlatform === 'original' ? <div className="segmented ratio-segmented">{(['16:9', '9:16', '1:1', ...(presenterPrimaryStyle ? ['avatar' as const] : [])] as const).map((item) => <button type="button" key={item} className={ratio === item ? 'active' : ''} onClick={() => setRatio(item)}>{item === 'avatar' ? '跟随人物图' : item}</button>)}</div> : <div className="platform-ratio-lock"><Check size={15} /><strong>{ratio}</strong><small>{selectedPublishingPreset.label}发布规格</small></div>}</div>
                        </div>
                        {mode !== 'clone' && (
                          <div className="file-grid advanced-file-grid">
                            <FileField label="补充参考视频" accept="video/mp4,video/quicktime,video/webm" icon={Film} file={source} onChange={(file) => void updateSourceReference(file)} />
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </motion.div>
              )}

              {wizardStep === 3 && (
                <motion.div
                  className="wizard-pane review-pane"
                  key="step-3"
                  initial={{opacity: 0, y: 4}}
                  animate={{opacity: 1, y: 0}}
                  exit={{opacity: 0, y: -3}}
                  transition={{duration: 0.13, ease: 'easeOut'}}
                >
                  <div className="section-title"><Check size={18} /><h2>检查任务配置</h2></div>
                  <p className="review-note">这里只核对配置，不会立即创建任务。点击“继续确认”后，你还会看到最终发起提示。</p>
                  <dl className="review-grid">
                    <div><dt>创作方式</dt><dd>{modeConfig.find((item) => item.id === mode)?.label}</dd></div>
                    <div><dt>发布平台</dt><dd>{selectedPublishingPreset.label}</dd></div>
                    <div><dt>输出规格</dt><dd>{durationSummary} · {ratio} · {selectedPublishingPreset.resolution}</dd></div>
                    {mode === 'clone' && <div className="review-wide"><dt>参考原片</dt><dd>{sourceSummary}</dd></div>}
                    <div><dt>人物素材</dt><dd>{assetSummary || '未上传'}</dd></div>
                    <div><dt>声音</dt><dd>{voiceSummary}</dd></div>
                    <div className="review-wide"><dt>{mode === 'script' ? '口播文案' : '创作内容'}</dt><dd>{contentSummary || '按参考视频复刻'}</dd></div>
                  </dl>
                  <label className="consent review-consent"><input type="checkbox" checked={rights} onChange={(event) => setRights(event.target.checked)} /><span>确认拥有上传人物、声音和视频素材的使用权</span></label>
                </motion.div>
              )}
              </AnimatePresence>

              {stepError && <div className="step-error" role="alert">{stepError}</div>}

              <div className="wizard-actions">
                {wizardStep > 1 && <button className="secondary" type="button" onClick={previousWizardStep}><ChevronLeft size={17} />上一步</button>}
                {wizardStep < 3 ? (
                  <button className="primary" type="button" onClick={nextWizardStep}>下一步<ChevronRight size={17} /></button>
                ) : (
                  <button className="primary wizard-submit" type="submit" disabled={submitting || !rights || system?.service.accepting === false}>
                    <ChevronRight size={19} />
                    {system?.service.accepting === false ? '服务维护中' : '继续确认'}
                  </button>
                )}
              </div>
            </section>
          </form>
        ) : (
          <section className="queue-surface">
            <div className="queue-toolbar"><div><h2>全部任务</h2><span>{jobs.length} 条记录</span></div><button className="secondary" onClick={() => void refresh()}><RotateCcw size={17} />刷新</button></div>
            <div className="job-table-wrap">
              <table className="job-table">
                <thead><tr><th>任务</th><th>模式</th><th>状态</th><th>进度</th><th>创建时间</th><th /></tr></thead>
                <tbody>
                  {jobs.map((job) => (
                    <tr key={job.id} onClick={() => void openJob(job)}>
                      <td><strong>{job.title}</strong><small>{formatPublishingPlatform(job.publishPlatform)} · {job.aspectRatio} · {formatJobDuration(job)}</small></td>
                      <td>{modeConfig.find((item) => item.id === job.mode)?.label}</td>
                      <td><span className={`status-badge ${job.status}`}><i />{statusLabel[job.status]}</span></td>
                      <td><div className="table-progress"><i style={{width: `${job.progress}%`}} /></div><small>{job.stage}</small></td>
                      <td>{formatTime(job.createdAt)}</td>
                      <td><button className="icon-button" title="查看任务"><ChevronRight size={18} /></button></td>
                    </tr>
                  ))}
                  {!jobs.length && <tr><td colSpan={6}><div className="empty-state"><Film size={28} /><strong>暂无任务</strong></div></td></tr>}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </main>

      {selected && (
        <JobDrawer
          job={selected}
          events={events}
          retrying={retrying}
          delivery={delivery}
          onClose={() => setSelected(null)}
          onCancel={() => void api(`/api/jobs/${selected.id}/cancel`, {method: 'POST'}).then(refresh)}
          onRetry={() => void retrySelected()}
        />
      )}

      <AnimatePresence>
        {dispatchConfirmOpen && (
          <motion.div
            className="dispatch-confirm-backdrop"
            initial={{opacity: 0}}
            animate={{opacity: 1}}
            exit={{opacity: 0}}
            onMouseDown={(event) => { if (event.currentTarget === event.target && !submitting) setDispatchConfirmOpen(false); }}
          >
            <motion.section
              className="dispatch-confirm-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="dispatch-confirm-title"
              aria-describedby="dispatch-confirm-description"
              initial={{opacity: 0, y: 12, scale: 0.98}}
              animate={{opacity: 1, y: 0, scale: 1}}
              exit={{opacity: 0, y: 8, scale: 0.985}}
              transition={{duration: 0.16, ease: 'easeOut'}}
              onKeyDown={(event) => { if (event.key === 'Escape' && !submitting) setDispatchConfirmOpen(false); }}
            >
              <div className="dispatch-confirm-mark"><Play size={21} /></div>
              <div className="dispatch-confirm-copy">
                <small>FINAL CHECK</small>
                <h2 id="dispatch-confirm-title">确认发起任务？</h2>
                <p id="dispatch-confirm-description">确认后任务会立即进入队列，并可能启动 GPU 实例。</p>
              </div>
              <dl className="dispatch-confirm-facts">
                <div><dt>制作方式</dt><dd>{mode === 'clone' ? `${replicaMode === 'exact' ? '完整复刻' : '精简复刻'} · ${translateToChinese ? '翻译中文' : '保留原语言'}` : modeConfig.find((item) => item.id === mode)?.label}</dd></div>
                <div><dt>发布平台</dt><dd>{selectedPublishingPreset.label}</dd></div>
                <div><dt>输出规格</dt><dd>{durationSummary} · {ratio} · {selectedPublishingPreset.resolution}</dd></div>
                <div><dt>人物</dt><dd>{assetSummary || '未上传'}</dd></div>
                <div><dt>声音</dt><dd>{voiceSummary}</dd></div>
              </dl>
              <div className="dispatch-confirm-actions">
                <button className="secondary" type="button" autoFocus disabled={submitting} onClick={() => setDispatchConfirmOpen(false)}>返回检查</button>
                <button className="primary" type="button" disabled={submitting} onClick={() => void dispatchJob()}>
                  {submitting ? <LoaderCircle className="spin" size={18} /> : <Play size={18} />}
                  {submitting ? '正在发起' : '确认发起任务'}
                </button>
              </div>
            </motion.section>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};
