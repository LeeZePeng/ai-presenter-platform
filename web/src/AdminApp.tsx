import {useCallback, useEffect, useMemo, useState} from 'react';
import {
  Activity,
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  CircleStop,
  Clock3,
  Download,
  Film,
  Gauge,
  GitBranch,
  LayoutDashboard,
  ListVideo,
  LoaderCircle,
  LogIn,
  Power,
  RefreshCw,
  Rocket,
  RotateCcw,
  Server,
  ShieldCheck,
  TimerReset,
  X,
  XCircle,
} from 'lucide-react';
import {
  adminResultUrl,
  api,
  ApiError,
  type AdminDashboard,
  type DeploymentSnapshot,
  type Job,
  type JobEvent,
} from './api';

type AdminView = 'overview' | 'requests' | 'deployment';

const deploymentStatusLabel: Record<DeploymentSnapshot['status'], string> = {
  idle: '尚未发布',
  queued: '等待执行',
  running: '发布中',
  succeeded: '发布成功',
  failed: '发布失败',
  rolled_back: '已自动回滚',
};

const statusLabel: Record<Job['status'], string> = {
  pending: '排队中',
  provisioning: '准备算力',
  running: '生成中',
  succeeded: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

const instanceLabel: Record<AdminDashboard['system']['instance']['state'], string> = {
  Running: '运行中',
  Stopped: '已关机',
  Starting: '启动中',
  Stopping: '关机中',
  Unknown: '状态异常',
};

const formatTime = (value: string | null, includeSeconds = false): string =>
  value
    ? new Intl.DateTimeFormat('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        ...(includeSeconds ? {second: '2-digit'} : {}),
      }).format(new Date(value))
    : '—';

const mergeEvents = (current: JobEvent[], incoming: JobEvent[]): JobEvent[] => {
  const byId = new Map(current.map((event) => [event.id, event]));
  for (const event of incoming) byId.set(event.id, event);
  return [...byId.values()].sort((left, right) => left.id - right.id).slice(-500);
};

const formatDuration = (seconds: number): string => {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return hours ? `${hours} 小时 ${minutes} 分` : `${minutes} 分钟`;
};

const countdown = (target: string | null, now: number): string => {
  if (!target) return '未运行';
  const seconds = Math.max(0, Math.floor((new Date(target).getTime() - now) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(rest).padStart(2, '0')}`;
};

const AdminJobDrawer = ({
  job,
  events,
  onClose,
  onCancel,
  onRetry,
  retrying,
}: {
  job: Job;
  events: JobEvent[];
  onClose: () => void;
  onCancel: () => void;
  onRetry: () => void;
  retrying: boolean;
}) => (
  <div className="drawer-backdrop" onMouseDown={onClose}>
    <aside className="job-drawer admin-job-drawer" onMouseDown={(event) => event.stopPropagation()}>
      <div className="drawer-header">
        <div>
          <span className={`status-dot ${job.status}`} />
          <small>{statusLabel[job.status]}</small>
          <h2>{job.title}</h2>
        </div>
        <button className="icon-button" title="关闭" onClick={onClose}><X size={19} /></button>
      </div>

      {job.status === 'succeeded' && (
        <video className="result-video" src={adminResultUrl(job.id)} controls playsInline preload="metadata" />
      )}

      <div className="drawer-progress">
        <div><span>{job.stage}</span><strong>{job.progress}%</strong></div>
        <div className="progress-track"><i style={{width: `${job.progress}%`}} /></div>
      </div>

      <dl className="job-facts">
        <div><dt>请求 ID</dt><dd title={job.id}>{job.id.slice(0, 12)}</dd></div>
        <div><dt>状态</dt><dd>{statusLabel[job.status]}</dd></div>
        <div><dt>模式 / 画幅</dt><dd>{job.mode} / {job.aspectRatio}</dd></div>
        <div><dt>创建时间</dt><dd>{formatTime(job.createdAt)}</dd></div>
      </dl>

      {(job.topic || job.script) && (
        <section className="request-content">
          <h3>请求内容</h3>
          <p>{job.topic || job.script}</p>
        </section>
      )}
      {job.error && <div className="error-banner">{job.error}</div>}

      <section className="timeline">
        <div className="section-title"><Activity size={17} /><h3>执行日志</h3></div>
        <div className="timeline-list">
          {[...events].reverse().map((event) => (
            <div className={`timeline-item ${event.level}`} key={event.id}>
              <i />
              <div><strong>{event.message}</strong><time>{formatTime(event.createdAt, true)}</time></div>
            </div>
          ))}
          {!events.length && <div className="muted-empty">暂无日志</div>}
        </div>
      </section>

      <div className="drawer-actions">
        {['pending', 'provisioning', 'running'].includes(job.status) && (
          <button className="secondary danger" onClick={onCancel}><CircleStop size={17} />取消请求</button>
        )}
        {['failed', 'cancelled'].includes(job.status) && (
          <button className="primary" disabled={retrying} onClick={onRetry}>
            {retrying ? <LoaderCircle className="spin" size={17} /> : <RotateCcw size={17} />}
            {retrying ? '正在重试' : '重新入队'}
          </button>
        )}
        {job.status === 'succeeded' && (
          <a className="primary" href={adminResultUrl(job.id, false)}><Download size={17} />下载成片</a>
        )}
      </div>
    </aside>
  </div>
);

export const AdminApp = () => {
  const [view, setView] = useState<AdminView>('overview');
  const [dashboard, setDashboard] = useState<AdminDashboard | null>(null);
  const [deployment, setDeployment] = useState<DeploymentSnapshot | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [selected, setSelected] = useState<Job | null>(null);
  const [events, setEvents] = useState<JobEvent[]>([]);
  const [authorized, setAuthorized] = useState(false);
  const [authRequired, setAuthRequired] = useState(true);
  const [configLoaded, setConfigLoaded] = useState(false);
  const [tokenInput, setTokenInput] = useState('');
  const [error, setError] = useState('');
  const [action, setAction] = useState('');
  const [now, setNow] = useState(Date.now());

  const refresh = useCallback(async () => {
    try {
      const [dashboardData, jobsData, deploymentData] = await Promise.all([
        api<AdminDashboard>('/api/admin/dashboard'),
        api<{jobs: Job[]}>('/api/admin/jobs'),
        api<DeploymentSnapshot>('/api/admin/deployment'),
      ]);
      setDashboard(dashboardData);
      setJobs(jobsData.jobs);
      setDeployment(deploymentData);
      setAuthorized(true);
      setError('');
      if (selected) {
        const detail = await api<{job: Job; events: JobEvent[]}>(`/api/admin/jobs/${selected.id}`);
        setSelected(detail.job);
        setEvents((current) => mergeEvents(current, detail.events));
      }
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 401) setAuthorized(false);
      else setError(caught instanceof Error ? caught.message : String(caught));
    }
  }, [selected?.id]);

  useEffect(() => {
    api<{authRequired: boolean}>('/api/admin/public-config')
      .then(async (data) => {
        setAuthRequired(data.authRequired);
        setConfigLoaded(true);
        if (!data.authRequired) setAuthorized(true);
        else {
          try {
            await api('/api/admin/dashboard');
            setAuthorized(true);
          } catch {
            setAuthorized(false);
          }
        }
      })
      .catch((caught) => {
        setConfigLoaded(true);
        setError(caught instanceof Error ? caught.message : String(caught));
      });
  }, []);

  useEffect(() => {
    if (!authorized) return;
    void refresh();
    const timer = setInterval(() => void refresh(), 10000);
    return () => clearInterval(timer);
  }, [authorized, refresh]);

  useEffect(() => {
    if (!authorized || !selected || !['pending', 'provisioning', 'running'].includes(selected.status)) return;
    const after = events.at(-1)?.id ?? 0;
    const stream = new EventSource(`/api/admin/jobs/${selected.id}/events?after=${after}`);
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
    if (!authorized || !selected || !['pending', 'provisioning', 'running'].includes(selected.status)) return;
    let cursor = events.at(-1)?.id ?? 0;
    let disposed = false;
    const sync = async (): Promise<void> => {
      try {
        const detail = await api<{job: Job; events: JobEvent[]}>(`/api/admin/jobs/${selected.id}?after=${cursor}`);
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

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, []);

  const chart = useMemo(() => {
    const values = new Map(dashboard?.metrics.requestSeries.map((item) => [item.hour, item.count]) ?? []);
    return Array.from({length: 12}, (_, index) => {
      const date = new Date(Date.now() - (11 - index) * 60 * 60 * 1000);
      const key = date.toISOString().slice(0, 13);
      return {label: `${String(date.getHours()).padStart(2, '0')}:00`, count: values.get(key) ?? 0};
    });
  }, [dashboard?.metrics.requestSeries]);
  const chartMax = Math.max(1, ...chart.map((item) => item.count));

  const openJob = async (job: Job) => {
    try {
      const detail = await api<{job: Job; events: JobEvent[]}>(`/api/admin/jobs/${job.id}`);
      setSelected(detail.job);
      setEvents(detail.events.slice(-500));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    }
  };

  const powerAction = async (nextAction: 'start' | 'stop') => {
    if (nextAction === 'stop' && !window.confirm('确认关闭实例？存在活动请求时服务会拒绝关机。')) return;
    setAction(nextAction);
    try {
      await api(`/api/admin/power/${nextAction}`, {method: 'POST'});
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setAction('');
    }
  };

  const deployRelease = async () => {
    if (!deployment) return;
    if (!window.confirm(`确认把 ${deployment.remote}/${deployment.branch} 的最新代码发布到生产环境？发布前会自动执行检查和备份。`)) return;
    setAction('deploy');
    try {
      const next = await api<DeploymentSnapshot>('/api/admin/deployment', {
        method: 'POST',
        body: JSON.stringify({confirmation: 'DEPLOY'}),
      });
      setDeployment(next);
      setError('');
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setAction('');
    }
  };

  const cancelSelected = async () => {
    if (!selected || !window.confirm(`确认取消请求“${selected.title}”？`)) return;
    setAction('cancel');
    try {
      await api(`/api/admin/jobs/${selected.id}/cancel`, {method: 'POST'});
      await refresh();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setAction('');
    }
  };

  const retrySelected = async () => {
    if (!selected || !window.confirm(`确认重试请求“${selected.title}”？任务会重新入队，并可能启动 GPU 实例。`)) return;
    setAction('retry');
    try {
      const response = await api<{job: Job}>(`/api/admin/jobs/${selected.id}/retry`, {method: 'POST'});
      await refresh();
      await openJob(response.job);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setAction('');
    }
  };

  if (!configLoaded) {
    return <main className="login-screen"><LoaderCircle className="spin admin-loading" size={28} /></main>;
  }

  if (authRequired && !authorized) {
    return (
      <main className="login-screen admin-login-screen">
        <form
          className="login-panel"
          onSubmit={async (event) => {
            event.preventDefault();
            try {
              await api('/api/admin/session', {method: 'POST', body: JSON.stringify({token: tokenInput})});
              setAuthorized(true);
              setError('');
            } catch (caught) {
              setError(caught instanceof Error ? caught.message : String(caught));
            }
          }}
        >
          <div className="brand-mark"><ShieldCheck size={27} /></div>
          <h1>口播管理台</h1>
          <label>管理员口令<input type="password" value={tokenInput} onChange={(event) => setTokenInput(event.target.value)} autoFocus /></label>
          {error && <div className="error-banner">{error}</div>}
          <button className="primary" type="submit"><LogIn size={18} />进入管理台</button>
        </form>
      </main>
    );
  }

  const system = dashboard?.system;
  const metrics = dashboard?.metrics;
  const instanceState = system?.instance.state ?? 'Unknown';

  return (
    <div className="app-shell admin-shell">
      <aside className="sidebar admin-sidebar">
        <div className="brand"><div className="brand-mark"><ShieldCheck size={23} /></div><span><strong>口播管理台</strong><small>Operations Console</small></span></div>
        <nav>
          <button className={view === 'overview' ? 'active' : ''} onClick={() => setView('overview')}><LayoutDashboard size={19} />运行总览</button>
          <button className={view === 'requests' ? 'active' : ''} onClick={() => setView('requests')}><ListVideo size={19} />请求监控{system?.queue.total ? <b>{system.queue.total}</b> : null}</button>
          <button className={view === 'deployment' ? 'active' : ''} onClick={() => setView('deployment')}><Rocket size={19} />部署发布</button>
        </nav>
        <div className="sidebar-instance">
          <div><Server size={17} /><span>GPU 实例</span><i className={`instance-light ${instanceState.toLowerCase()}`} /></div>
          <strong>{system?.instance.gpuType || '—'} {system?.instance.gpuCount ? `× ${system.instance.gpuCount}` : ''}</strong>
          <small>{instanceLabel[instanceState]}</small>
        </div>
      </aside>

      <main className="workspace admin-workspace">
        <header className="topbar">
          <div><h1>{view === 'overview' ? '运行总览' : view === 'requests' ? '请求监控' : '部署发布'}</h1><span>服务已运行 {formatDuration(dashboard?.uptimeSeconds ?? 0)}</span></div>
          <div className="topbar-actions">
            {!dashboard?.jobsEnabled && <span className="maintenance-badge">生成已暂停</span>}
            {(system?.mockGpu || system?.mockCodex) && <span className="dev-badge">模拟环境</span>}
            <button className="icon-button" title="刷新" onClick={() => void refresh()}><RefreshCw size={18} /></button>
          </div>
        </header>

        <section className="status-strip admin-status-strip">
          <div><Activity size={20} /><span><small>24 小时请求</small><strong>{metrics?.total ?? 0}</strong></span></div>
          <div><Gauge size={20} /><span><small>队列 / 运行</small><strong>{metrics?.running ?? 0}</strong></span></div>
          <div><CheckCircle2 size={20} /><span><small>成功率</small><strong>{metrics?.successRate ?? 0}%</strong></span></div>
          <div><XCircle size={20} /><span><small>失败</small><strong>{metrics?.failed ?? 0}</strong></span></div>
          <div><Clock3 size={20} /><span><small>时间片剩余</small><strong>{countdown(system?.nextPowerCheckAt ?? null, now)}</strong></span></div>
        </section>

        {error && <div className="error-banner">{error}<button onClick={() => setError('')}><X size={16} /></button></div>}

        {view === 'overview' ? (
          <div className="admin-overview">
            <section className="admin-surface instance-panel">
              <div className="surface-heading"><div><Server size={18} /><h2>实例状态</h2></div><span className={`state-label ${instanceState.toLowerCase()}`}><i />{instanceLabel[instanceState]}</span></div>
              <dl className="instance-facts">
                <div><dt>实例</dt><dd>{system?.instance.name || '—'}<small>{system?.instance.id || '—'}</small></dd></div>
                <div><dt>GPU</dt><dd>{system?.instance.gpuType || '—'} {system?.instance.gpuCount ? `× ${system.instance.gpuCount}` : ''}</dd></div>
                <div><dt>小时价格</dt><dd>{system?.instance.hourlyPrice != null ? `¥${system.instance.hourlyPrice.toFixed(2)}` : '—'}</dd></div>
                <div><dt>时间片开始</dt><dd>{formatTime(system?.billingWindowStartedAt ?? null)}</dd></div>
                <div><dt>下次检测</dt><dd>{formatTime(system?.nextPowerCheckAt ?? null, true)}</dd></div>
                <div><dt>队列</dt><dd>{system?.queue.pending ?? 0} 等待 / {system?.queue.active ?? 0} 运行</dd></div>
              </dl>
              {(system?.lastPowerError || system?.lastPowerAction) && (
                <div className={`power-message ${system.lastPowerError ? 'error' : ''}`}>
                  {system.lastPowerError ? <AlertTriangle size={17} /> : <TimerReset size={17} />}
                  <span>{system.lastPowerError || system.lastPowerAction}</span>
                </div>
              )}
              <div className="instance-actions">
                <button className="primary" disabled={Boolean(action) || ['Running', 'Starting'].includes(instanceState)} onClick={() => void powerAction('start')}>
                  {action === 'start' ? <LoaderCircle className="spin" size={17} /> : <Power size={17} />}启动实例
                </button>
                <button className="secondary danger" disabled={Boolean(action) || ['Stopped', 'Stopping'].includes(instanceState)} onClick={() => void powerAction('stop')}>
                  {action === 'stop' ? <LoaderCircle className="spin" size={17} /> : <CircleStop size={17} />}关闭实例
                </button>
              </div>
            </section>

            <section className="admin-surface request-chart-panel">
              <div className="surface-heading"><div><Activity size={18} /><h2>请求趋势</h2></div><span>最近 12 小时</span></div>
              <div className="request-chart" aria-label="最近 12 小时请求量">
                {chart.map((item) => (
                  <div className="chart-column" key={item.label} title={`${item.label} · ${item.count} 个请求`}>
                    <strong>{item.count || ''}</strong>
                    <div><i style={{height: `${Math.max(item.count ? 8 : 2, (item.count / chartMax) * 100)}%`}} /></div>
                    <small>{item.label}</small>
                  </div>
                ))}
              </div>
            </section>

            <section className="admin-surface activity-panel">
              <div className="surface-heading"><div><Film size={18} /><h2>实时请求日志</h2></div><button className="text-button" onClick={() => setView('requests')}>查看全部<ChevronRight size={16} /></button></div>
              <div className="activity-list">
                {dashboard?.recentEvents.slice(0, 12).map((event) => (
                  <button key={event.id} onClick={() => {
                    const job = jobs.find((item) => item.id === event.jobId);
                    if (job) void openJob(job);
                  }}>
                    <span className={`event-icon ${event.level}`}>{event.level === 'error' ? <XCircle size={15} /> : event.level === 'warning' ? <AlertTriangle size={15} /> : <Activity size={15} />}</span>
                    <span><strong>{event.jobTitle}</strong><small>{event.message}</small></span>
                    <time>{formatTime(event.createdAt, true)}</time>
                  </button>
                ))}
                {!dashboard?.recentEvents.length && <div className="muted-empty">暂无请求日志</div>}
              </div>
            </section>
          </div>
        ) : view === 'requests' ? (
          <section className="queue-surface admin-request-surface">
            <div className="queue-toolbar"><div><h2>全部请求</h2><span>{jobs.length} 条记录</span></div><button className="secondary" onClick={() => void refresh()}><RefreshCw size={17} />刷新</button></div>
            <div className="job-table-wrap">
              <table className="job-table admin-job-table">
                <thead><tr><th>请求</th><th>模式</th><th>状态</th><th>执行阶段</th><th>创建时间</th><th /></tr></thead>
                <tbody>
                  {jobs.map((job) => (
                    <tr key={job.id} onClick={() => void openJob(job)}>
                      <td><strong>{job.title}</strong><small>{job.id.slice(0, 12)} · {job.voiceMode === 'uploaded_audio' ? `${job.durationSeconds}s` : `自动（≤${job.durationSeconds}s）`}</small></td>
                      <td>{job.mode}</td>
                      <td><span className={`status-badge ${job.status}`}><i />{statusLabel[job.status]}</span></td>
                      <td><div className="table-progress"><i style={{width: `${job.progress}%`}} /></div><small>{job.stage}</small></td>
                      <td>{formatTime(job.createdAt)}</td>
                      <td><button className="icon-button" title="查看请求"><ChevronRight size={18} /></button></td>
                    </tr>
                  ))}
                  {!jobs.length && <tr><td colSpan={6}><div className="empty-state"><Film size={28} /><strong>暂无请求</strong></div></td></tr>}
                </tbody>
              </table>
            </div>
          </section>
        ) : (
          <div className="deployment-layout">
            <section className="admin-surface deployment-panel">
              <div className="surface-heading">
                <div><Rocket size={18} /><h2>生产发布</h2></div>
                <span className={`deploy-state ${deployment?.status ?? 'idle'}`}><i />{deployment ? deploymentStatusLabel[deployment.status] : '读取中'}</span>
              </div>
              <div className="deployment-body">
                {!deployment?.enabled && (
                  <div className="power-message"><AlertTriangle size={17} /><span>服务器尚未启用一键部署。先按部署文档完成只读仓库、固定脚本和 launchd 配置。</span></div>
                )}
                <dl className="deployment-facts">
                  <div><dt>发布来源</dt><dd><GitBranch size={15} />{deployment ? `${deployment.remote}/${deployment.branch}` : '—'}</dd></div>
                  <div><dt>当前阶段</dt><dd>{deployment?.stage || '—'}</dd></div>
                  <div><dt>目标提交</dt><dd className="mono">{deployment?.commit?.slice(0, 12) || '—'}</dd></div>
                  <div><dt>上个提交</dt><dd className="mono">{deployment?.previousCommit?.slice(0, 12) || '—'}</dd></div>
                  <div><dt>开始时间</dt><dd>{formatTime(deployment?.startedAt ?? null, true)}</dd></div>
                  <div><dt>完成时间</dt><dd>{formatTime(deployment?.completedAt ?? null, true)}</dd></div>
                </dl>
                {deployment?.message && <div className={`deployment-message ${['failed', 'rolled_back'].includes(deployment.status) ? 'error' : ''}`}>{deployment.message}</div>}
                <div className="deployment-actions">
                  <button
                    className="primary"
                    disabled={!deployment?.enabled || Boolean(action) || ['queued', 'running'].includes(deployment?.status ?? '') || Boolean(system?.queue.total)}
                    onClick={() => void deployRelease()}
                  >
                    {action === 'deploy' || ['queued', 'running'].includes(deployment?.status ?? '') ? <LoaderCircle className="spin" size={17} /> : <Rocket size={17} />}
                    {['queued', 'running'].includes(deployment?.status ?? '') ? '发布进行中' : '一键部署 main'}
                  </button>
                  <button className="secondary" disabled={Boolean(action)} onClick={() => void refresh()}><RefreshCw size={17} />刷新状态</button>
                </div>
                {Boolean(system?.queue.total) && <small className="deployment-hint">当前有 {system?.queue.total} 个任务，队列清空后才能发布。</small>}
              </div>
            </section>

            <section className="admin-surface deployment-log-panel">
              <div className="surface-heading"><div><Activity size={18} /><h2>发布日志</h2></div><span>最近输出</span></div>
              <pre>{deployment?.logTail || '暂无发布日志'}</pre>
            </section>
          </div>
        )}
      </main>

      {selected && (
        <AdminJobDrawer
          job={selected}
          events={events}
          onClose={() => setSelected(null)}
          onCancel={() => void cancelSelected()}
          onRetry={() => void retrySelected()}
          retrying={action === 'retry'}
        />
      )}
    </div>
  );
};
