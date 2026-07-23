#!/usr/bin/env node
import {spawnSync} from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const recordFatalStartupError = (error) => {
  try {
    const filename = process.env.DEPLOY_STATE_FILE;
    if (filename) {
      mkdirSync(path.dirname(filename), {recursive: true});
      const state = {
        status: 'failed',
        stage: '发布进程启动失败',
        message: error instanceof Error ? error.message : String(error),
        commit: null,
        previousCommit: null,
        requestedAt: process.env.DEPLOY_REQUESTED_AT || null,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        pid: null,
      };
      writeFileSync(filename, `${JSON.stringify(state, null, 2)}\n`, {mode: 0o600});
    }
  } finally {
    process.exit(1);
  }
};
process.once('uncaughtException', recordFatalStartupError);
process.once('unhandledRejection', recordFatalStartupError);

const env = process.env;
const required = (name) => {
  const value = env[name]?.trim();
  if (!value) throw new Error(`缺少 ${name}`);
  return value;
};

const repoDir = path.resolve(required('DEPLOY_REPO_DIR'));
const targetDir = path.resolve(required('DEPLOY_TARGET_DIR'));
const remote = required('DEPLOY_REMOTE');
const branch = required('DEPLOY_BRANCH');
const pnpmBin = required('DEPLOY_PNPM_BIN');
const launchdLabel = required('DEPLOY_LAUNCHD_LABEL');
const healthUrl = required('DEPLOY_HEALTH_URL');
const stateFile = path.resolve(required('DEPLOY_STATE_FILE'));
const logFile = path.resolve(required('DEPLOY_LOG_FILE'));
const healthTimeoutMs = Math.max(10_000, Number(env.DEPLOY_HEALTH_TIMEOUT_MS) || 90_000);
const requestedAt = env.DEPLOY_REQUESTED_AT || new Date().toISOString();

const safeRef = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
if (!safeRef.test(remote) || !safeRef.test(branch) || remote.startsWith('-') || branch.startsWith('-')) {
  throw new Error('远程名或分支名不安全');
}
const home = path.resolve(os.homedir());
const assertSafeDirectory = (value, name) => {
  if (!path.isAbsolute(value) || value === '/' || value === home || value.split(path.sep).filter(Boolean).length < 3) {
    throw new Error(`${name} 不是安全的绝对目录`);
  }
};
assertSafeDirectory(repoDir, 'DEPLOY_REPO_DIR');
assertSafeDirectory(targetDir, 'DEPLOY_TARGET_DIR');
if (repoDir === targetDir) throw new Error('部署 checkout 与生产目录必须分离');

mkdirSync(path.dirname(stateFile), {recursive: true});
mkdirSync(path.dirname(logFile), {recursive: true});
appendFileSync(logFile, `\n[${new Date().toISOString()}] ===== 开始发布 ${remote}/${branch} =====\n`, {mode: 0o600});

let state = {
  status: 'running',
  stage: '初始化',
  message: '正在准备发布',
  commit: null,
  previousCommit: null,
  requestedAt,
  startedAt: new Date().toISOString(),
  completedAt: null,
  pid: process.pid,
};

const writeState = (changes = {}) => {
  state = {...state, ...changes};
  const temporary = `${stateFile}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, {mode: 0o600});
  renameSync(temporary, stateFile);
};
const log = (message) => appendFileSync(logFile, `[${new Date().toISOString()}] ${message}\n`);
const stage = (name, message) => {
  log(`${name}: ${message}`);
  writeState({stage: name, message});
};
const run = (command, args, options = {}) => {
  log(`$ ${path.basename(command)} ${args.join(' ')}`);
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? env,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: options.timeout ?? 20 * 60 * 1000,
  });
  if (result.stdout) appendFileSync(logFile, result.stdout);
  if (result.stderr) appendFileSync(logFile, result.stderr);
  if (result.error || result.status !== 0) {
    throw new Error(`${path.basename(command)} 执行失败${result.status == null ? '' : ` (${result.status})`}: ${result.error?.message || result.stderr?.trim() || '未知错误'}`);
  }
  return result.stdout.trim();
};

const exclusions = [
  '.env',
  '.cloudflared/',
  'data/',
  'logs/',
  'out/',
  'bin/',
  'runtime/',
  'vendor/',
  '.git/',
  'backups/',
  'deploy/remotion-runtime/node_modules/',
];
const rsyncArgs = (source, destination, extra = []) => [
  '-a',
  '--delete',
  ...exclusions.flatMap((item) => ['--exclude', item]),
  ...extra,
  `${source.replace(/\/$/, '')}/`,
  `${destination.replace(/\/$/, '')}/`,
];
const restart = () => run('/bin/launchctl', ['kickstart', '-k', `gui/${process.getuid()}/${launchdLabel}`], {timeout: 30_000});
const healthy = async () => {
  const deadline = Date.now() + healthTimeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(healthUrl, {signal: AbortSignal.timeout(5000)});
      if (response.ok) return true;
    } catch {
      // The service is expected to be briefly unavailable during restart.
    }
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  return false;
};

let stagingDir = '';
let deployed = false;
let backupReady = false;
const rollbackDir = `${targetDir}.rollback`;

try {
  writeState();
  if (!existsSync(path.join(repoDir, '.git'))) throw new Error('部署 checkout 不是 Git 仓库');

  stage('拉取代码', `正在获取 ${remote}/${branch}`);
  run('git', ['-C', repoDir, 'fetch', '--prune', remote, branch], {timeout: 5 * 60 * 1000});
  const ref = `${remote}/${branch}`;
  const commit = run('git', ['-C', repoDir, 'rev-parse', '--verify', `${ref}^{commit}`]);
  state.commit = commit;
  const versionFile = path.join(targetDir, '.deployment-version.json');
  if (existsSync(versionFile)) {
    try {
      state.previousCommit = JSON.parse(readFileSync(versionFile, 'utf8')).commit || null;
    } catch {
      log('忽略无法读取的旧版本标记');
    }
  }
  writeState({commit, previousCommit: state.previousCommit});

  stage('准备版本', `导出提交 ${commit.slice(0, 12)}`);
  stagingDir = mkdtempSync(path.join(os.tmpdir(), 'ai-presenter-release-'));
  const archive = path.join(stagingDir, 'release.tar');
  run('git', ['-C', repoDir, 'archive', '--format=tar', `--output=${archive}`, ref]);
  run('tar', ['-xf', archive, '-C', stagingDir]);
  rmSync(archive, {force: true});

  stage('安装依赖', '按锁文件安装依赖');
  run(pnpmBin, ['install', '--frozen-lockfile'], {cwd: stagingDir, timeout: 15 * 60 * 1000});
  stage('质量检查', '执行类型检查');
  run(pnpmBin, ['run', 'typecheck'], {cwd: stagingDir, timeout: 10 * 60 * 1000});
  stage('质量检查', '执行自动化测试');
  run(pnpmBin, ['test'], {cwd: stagingDir, timeout: 15 * 60 * 1000});
  stage('构建前端', '生成生产前端资源');
  run(pnpmBin, ['run', 'build'], {cwd: stagingDir, timeout: 10 * 60 * 1000});
  writeFileSync(
    path.join(stagingDir, '.deployment-version.json'),
    `${JSON.stringify({commit, deployedAt: new Date().toISOString(), remote, branch}, null, 2)}\n`,
  );

  stage('备份当前版本', '创建本地硬链接回滚快照');
  mkdirSync(targetDir, {recursive: true});
  mkdirSync(rollbackDir, {recursive: true});
  run('rsync', rsyncArgs(targetDir, rollbackDir, [`--link-dest=${targetDir}`]), {timeout: 10 * 60 * 1000});
  backupReady = true;

  stage('发布版本', `同步 ${commit.slice(0, 12)} 到生产目录`);
  run('rsync', rsyncArgs(stagingDir, targetDir), {timeout: 10 * 60 * 1000});
  deployed = true;

  stage('重启服务', '正在重启固定 launchd 服务');
  restart();
  stage('健康检查', '等待本机 API 恢复');
  if (!(await healthy())) throw new Error(`健康检查超时: ${healthUrl}`);

  writeState({
    status: 'succeeded',
    stage: '发布成功',
    message: `已发布 ${commit.slice(0, 12)}`,
    completedAt: new Date().toISOString(),
    pid: null,
  });
  log(`发布成功: ${commit}`);
} catch (error) {
  log(`发布失败: ${error instanceof Error ? error.stack || error.message : String(error)}`);
  if (deployed && backupReady) {
    try {
      stage('自动回滚', '健康检查失败，正在恢复上一个版本');
      run('rsync', rsyncArgs(rollbackDir, targetDir), {timeout: 10 * 60 * 1000});
      restart();
      const rollbackHealthy = await healthy();
      writeState({
        status: 'rolled_back',
        stage: rollbackHealthy ? '已自动回滚' : '回滚后仍不健康',
        message: error instanceof Error ? error.message : String(error),
        completedAt: new Date().toISOString(),
        pid: null,
      });
    } catch (rollbackError) {
      writeState({
        status: 'failed',
        stage: '回滚失败',
        message: `${error instanceof Error ? error.message : String(error)}；回滚失败：${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`,
        completedAt: new Date().toISOString(),
        pid: null,
      });
    }
  } else {
    writeState({
      status: 'failed',
      stage: '发布失败',
      message: error instanceof Error ? error.message : String(error),
      completedAt: new Date().toISOString(),
      pid: null,
    });
  }
  process.exitCode = 1;
} finally {
  if (stagingDir) rmSync(stagingDir, {recursive: true, force: true});
}
