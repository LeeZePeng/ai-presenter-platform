import {spawn} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, renameSync, writeFileSync} from 'node:fs';
import path from 'node:path';

export type DeploymentStatus = 'idle' | 'queued' | 'running' | 'succeeded' | 'failed' | 'rolled_back';

export type DeploymentState = {
  status: DeploymentStatus;
  stage: string;
  message: string;
  commit: string | null;
  previousCommit: string | null;
  requestedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  pid: number | null;
};

export type DeploymentSnapshot = DeploymentState & {
  enabled: boolean;
  remote: string;
  branch: string;
  repoDir: string;
  targetDir: string;
  logTail: string;
};

export type DeploymentOptions = {
  enabled: boolean;
  repoDir: string;
  remote: string;
  branch: string;
  targetDir: string;
  script: string;
  pnpmBin: string;
  launchdLabel: string;
  healthUrl: string;
  healthTimeoutMs: number;
  stateFile: string;
  logFile: string;
};

const statuses = new Set<DeploymentStatus>([
  'idle',
  'queued',
  'running',
  'succeeded',
  'failed',
  'rolled_back',
]);

const emptyState = (): DeploymentState => ({
  status: 'idle',
  stage: '尚未发布',
  message: '等待管理员发起发布',
  commit: null,
  previousCommit: null,
  requestedAt: null,
  startedAt: null,
  completedAt: null,
  pid: null,
});

const parseState = (filename: string): DeploymentState => {
  if (!existsSync(filename)) return emptyState();
  try {
    const parsed = JSON.parse(readFileSync(filename, 'utf8')) as Partial<DeploymentState>;
    if (!parsed.status || !statuses.has(parsed.status)) return emptyState();
    return {
      status: parsed.status,
      stage: String(parsed.stage ?? ''),
      message: String(parsed.message ?? ''),
      commit: parsed.commit ? String(parsed.commit) : null,
      previousCommit: parsed.previousCommit ? String(parsed.previousCommit) : null,
      requestedAt: parsed.requestedAt ? String(parsed.requestedAt) : null,
      startedAt: parsed.startedAt ? String(parsed.startedAt) : null,
      completedAt: parsed.completedAt ? String(parsed.completedAt) : null,
      pid: Number.isInteger(parsed.pid) ? Number(parsed.pid) : null,
    };
  } catch {
    return {...emptyState(), status: 'failed', stage: '状态读取失败', message: '发布状态文件损坏'};
  }
};

const readLogTail = (filename: string, limit = 24_000): string => {
  if (!existsSync(filename)) return '';
  try {
    const content = readFileSync(filename, 'utf8');
    return content.slice(-limit);
  } catch {
    return '无法读取发布日志';
  }
};

const processIsAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

export class DeploymentManager {
  constructor(private readonly options: DeploymentOptions) {
    mkdirSync(path.dirname(options.stateFile), {recursive: true});
  }

  snapshot(): DeploymentSnapshot {
    const state = this.reconciledState();
    return {
      ...state,
      enabled: this.options.enabled,
      remote: this.options.remote,
      branch: this.options.branch,
      repoDir: this.options.repoDir,
      targetDir: this.options.targetDir,
      logTail: readLogTail(this.options.logFile),
    };
  }

  trigger(activeJobs: number): DeploymentSnapshot {
    if (!this.options.enabled) throw Object.assign(new Error('一键部署尚未在服务器启用'), {status: 503});
    if (activeJobs > 0) throw Object.assign(new Error('仍有排队或运行中的任务，暂不能部署'), {status: 409});
    if (!existsSync(this.options.script)) throw Object.assign(new Error('服务器部署脚本不存在'), {status: 503});
    if (!existsSync(path.join(this.options.repoDir, '.git'))) {
      throw Object.assign(new Error('服务器部署仓库尚未初始化'), {status: 503});
    }
    const safeRef = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
    if (!safeRef.test(this.options.remote) || !safeRef.test(this.options.branch)) {
      throw Object.assign(new Error('服务器部署远程或分支配置无效'), {status: 503});
    }
    if (path.resolve(this.options.repoDir) === path.resolve(this.options.targetDir)) {
      throw Object.assign(new Error('部署 checkout 与生产目录必须分离'), {status: 503});
    }
    const current = this.reconciledState();
    if (current.status === 'queued' || current.status === 'running') {
      throw Object.assign(new Error('已有发布正在进行'), {status: 409});
    }

    const requestedAt = new Date().toISOString();
    const queued: DeploymentState = {
      ...current,
      status: 'queued',
      stage: '等待发布进程',
      message: `准备发布 ${this.options.remote}/${this.options.branch}`,
      requestedAt,
      startedAt: null,
      completedAt: null,
      pid: null,
    };
    this.writeState(queued);

    // Deliberately do not inherit application secrets. Incoming code is built
    // with a minimal environment and production credentials remain in .env.
    const inherited = process.env;
    const child = spawn(process.execPath, [this.options.script], {
      detached: true,
      stdio: 'ignore',
      env: {
        PATH: inherited.PATH ?? '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin',
        HOME: inherited.HOME ?? '',
        TMPDIR: inherited.TMPDIR ?? '/tmp',
        LANG: inherited.LANG ?? 'en_US.UTF-8',
        LC_ALL: inherited.LC_ALL ?? '',
        DEPLOY_REPO_DIR: this.options.repoDir,
        DEPLOY_REMOTE: this.options.remote,
        DEPLOY_BRANCH: this.options.branch,
        DEPLOY_TARGET_DIR: this.options.targetDir,
        DEPLOY_PNPM_BIN: this.options.pnpmBin,
        DEPLOY_LAUNCHD_LABEL: this.options.launchdLabel,
        DEPLOY_HEALTH_URL: this.options.healthUrl,
        DEPLOY_HEALTH_TIMEOUT_MS: String(this.options.healthTimeoutMs),
        DEPLOY_STATE_FILE: this.options.stateFile,
        DEPLOY_LOG_FILE: this.options.logFile,
        DEPLOY_REQUESTED_AT: requestedAt,
      },
    });

    if (!child.pid) {
      const failed = {...queued, status: 'failed' as const, stage: '启动失败', message: '无法启动发布进程'};
      this.writeState(failed);
      throw Object.assign(new Error(failed.message), {status: 500});
    }
    this.writeState({...queued, pid: child.pid});
    child.once('error', (error) => {
      const latest = parseState(this.options.stateFile);
      this.writeState({
        ...latest,
        status: 'failed',
        stage: '启动失败',
        message: error.message,
        completedAt: new Date().toISOString(),
        pid: null,
      });
    });
    child.unref();
    return this.snapshot();
  }

  private writeState(state: DeploymentState): void {
    const temporary = `${this.options.stateFile}.${process.pid}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {mode: 0o600});
    renameSync(temporary, this.options.stateFile);
  }

  private reconciledState(): DeploymentState {
    const current = parseState(this.options.stateFile);
    const queuedTooLong =
      current.status === 'queued' &&
      current.requestedAt &&
      Date.now() - new Date(current.requestedAt).getTime() > 5 * 60 * 1000;
    const runnerExited = current.status === 'running' && current.pid !== null && !processIsAlive(current.pid);
    if (!queuedTooLong && !runnerExited) return current;
    const failed: DeploymentState = {
      ...current,
      status: 'failed',
      stage: '发布进程中断',
      message: '发布进程未正常结束，请检查日志后重新发布',
      completedAt: new Date().toISOString(),
      pid: null,
    };
    this.writeState(failed);
    return failed;
  }
}
