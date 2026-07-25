import {mkdirSync} from 'node:fs';
import path from 'node:path';
import {DatabaseSync} from 'node:sqlite';
import type {JobCreateInput, JobEvent, JobRecord, JobStatus, PresenterAsset, PresenterAssetKind} from './types.js';

type JobRow = {
  id: string;
  title: string;
  mode: JobRecord['mode'];
  replica_mode: JobRecord['replicaMode'];
  publish_platform: JobRecord['publishPlatform'];
  translate_to_chinese: number;
  topic: string;
  script: string;
  duration_seconds: number;
  aspect_ratio: JobRecord['aspectRatio'];
  style: string;
  voice_mode: JobRecord['voiceMode'];
  rights_confirmed: number;
  assets_json: string;
  status: JobStatus;
  stage: string;
  progress: number;
  created_at: string;
  updated_at: string;
  started_at: string | null;
  finished_at: string | null;
  output_path: string | null;
  error: string | null;
  cancel_requested: number;
  metadata_json: string;
};

type PresenterAssetRow = {
  id: string;
  kind: PresenterAssetKind;
  name: string;
  file_path: string;
  original_name: string;
  mime_type: string;
  duration_seconds: number | null;
  created_at: string;
};

const now = (): string => new Date().toISOString();

const parseJson = <T>(value: string, fallback: T): T => {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
};

export class AppDatabase {
  private readonly db: DatabaseSync;
  private readonly dataDir: string;

  constructor(filename: string) {
    this.dataDir = path.resolve(path.dirname(filename));
    mkdirSync(this.dataDir, {recursive: true});
    this.db = new DatabaseSync(filename);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
    this.migrate();
    this.migrateLegacyDataPaths();
    this.recoverInterruptedJobs();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        mode TEXT NOT NULL,
        replica_mode TEXT NOT NULL DEFAULT 'exact',
        publish_platform TEXT NOT NULL DEFAULT 'original',
        translate_to_chinese INTEGER NOT NULL DEFAULT 0,
        topic TEXT NOT NULL DEFAULT '',
        script TEXT NOT NULL DEFAULT '',
        duration_seconds INTEGER NOT NULL,
        aspect_ratio TEXT NOT NULL,
        style TEXT NOT NULL,
        voice_mode TEXT NOT NULL,
        rights_confirmed INTEGER NOT NULL,
        assets_json TEXT NOT NULL,
        status TEXT NOT NULL,
        stage TEXT NOT NULL,
        progress INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        output_path TEXT,
        error TEXT,
        cancel_requested INTEGER NOT NULL DEFAULT 0,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_jobs_status_created ON jobs(status, created_at);

      CREATE TABLE IF NOT EXISTS job_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        job_id TEXT NOT NULL,
        level TEXT NOT NULL,
        kind TEXT NOT NULL,
        message TEXT NOT NULL,
        data_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL,
        FOREIGN KEY(job_id) REFERENCES jobs(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_events_job_id ON job_events(job_id, id);

      CREATE TABLE IF NOT EXISTS runtime_state (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS presenter_assets (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL CHECK(kind IN ('avatar', 'voice')),
        name TEXT NOT NULL,
        file_path TEXT NOT NULL,
        original_name TEXT NOT NULL,
        mime_type TEXT NOT NULL,
        duration_seconds REAL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_presenter_assets_kind_created ON presenter_assets(kind, created_at DESC);
    `);
    const jobColumns = this.db.prepare('PRAGMA table_info(jobs)').all() as unknown as Array<{name: string}>;
    if (!jobColumns.some((column) => column.name === 'replica_mode')) {
      this.db.exec("ALTER TABLE jobs ADD COLUMN replica_mode TEXT NOT NULL DEFAULT 'condensed'");
    }
    if (!jobColumns.some((column) => column.name === 'translate_to_chinese')) {
      this.db.exec('ALTER TABLE jobs ADD COLUMN translate_to_chinese INTEGER NOT NULL DEFAULT 0');
    }
    if (!jobColumns.some((column) => column.name === 'publish_platform')) {
      this.db.exec("ALTER TABLE jobs ADD COLUMN publish_platform TEXT NOT NULL DEFAULT 'original'");
    }
  }

  private migrateLegacyDataPaths(): void {
    const legacyDataDir = '/var/lib/ai-presenter/data';
    if (this.dataDir === legacyDataDir) return;
    const targets = [
      ['jobs', 'assets_json'],
      ['jobs', 'output_path'],
      ['jobs', 'metadata_json'],
      ['job_events', 'data_json'],
      ['runtime_state', 'value'],
      ['presenter_assets', 'file_path'],
    ] as const;
    const matchPattern = `%${legacyDataDir}%`;
    const matches = targets.reduce((total, [table, column]) => {
      const row = this.db
        .prepare(`SELECT COUNT(*) AS count FROM ${table} WHERE ${column} LIKE ?`)
        .get(matchPattern) as {count: number};
      return total + row.count;
    }, 0);
    if (matches === 0) return;
    const backupDir = path.join(this.dataDir, 'backups');
    mkdirSync(backupDir, {recursive: true});
    const backupPath = path.join(backupDir, `path-migration-${now().replaceAll(/[:.]/g, '-')}.sqlite`);
    this.db.prepare('VACUUM INTO ?').run(backupPath);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const [table, column] of targets) {
        this.db
          .prepare(`UPDATE ${table} SET ${column} = replace(${column}, ?, ?) WHERE ${column} LIKE ?`)
          .run(legacyDataDir, this.dataDir, matchPattern);
      }
      this.db.exec('COMMIT');
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  createPresenterAsset(input: Omit<PresenterAsset, 'createdAt'>): PresenterAsset {
    const createdAt = now();
    this.db
      .prepare(`
        INSERT INTO presenter_assets (
          id, kind, name, file_path, original_name, mime_type, duration_seconds, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        input.id,
        input.kind,
        input.name,
        input.filePath,
        input.originalName,
        input.mimeType,
        input.durationSeconds,
        createdAt,
      );
    return this.getPresenterAsset(input.id)!;
  }

  private rowToPresenterAsset(row: PresenterAssetRow): PresenterAsset {
    return {
      id: row.id,
      kind: row.kind,
      name: row.name,
      filePath: row.file_path,
      originalName: row.original_name,
      mimeType: row.mime_type,
      durationSeconds: row.duration_seconds,
      createdAt: row.created_at,
    };
  }

  getPresenterAsset(id: string): PresenterAsset | null {
    const row = this.db.prepare('SELECT * FROM presenter_assets WHERE id = ?').get(id) as PresenterAssetRow | undefined;
    return row ? this.rowToPresenterAsset(row) : null;
  }

  listPresenterAssets(kind?: PresenterAssetKind): PresenterAsset[] {
    const rows = kind
      ? (this.db.prepare('SELECT * FROM presenter_assets WHERE kind = ? ORDER BY created_at DESC').all(kind) as unknown as PresenterAssetRow[])
      : (this.db.prepare('SELECT * FROM presenter_assets ORDER BY created_at DESC').all() as unknown as PresenterAssetRow[]);
    return rows.map((row) => this.rowToPresenterAsset(row));
  }

  private recoverInterruptedJobs(): void {
    const timestamp = now();
    this.db
      .prepare(`
        UPDATE jobs
        SET status = 'pending', stage = '等待恢复', progress = 2, updated_at = ?, started_at = NULL
        WHERE status IN ('provisioning', 'running')
      `)
      .run(timestamp);
  }

  createJob(id: string, input: JobCreateInput, metadata: Record<string, unknown> = {}): JobRecord {
    const timestamp = now();
    this.db
      .prepare(`
        INSERT INTO jobs (
          id, title, mode, replica_mode, publish_platform, translate_to_chinese, topic, script, duration_seconds, aspect_ratio, style,
          voice_mode, rights_confirmed, assets_json, status, stage, progress,
          created_at, updated_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', '已进入队列', 2, ?, ?, ?)
      `)
      .run(
        id,
        input.title,
        input.mode,
        input.replicaMode ?? (input.mode === 'clone' ? 'exact' : 'condensed'),
        input.publishPlatform ?? 'original',
        input.mode === 'clone' && input.translateToChinese ? 1 : 0,
        input.topic,
        input.script,
        input.durationSeconds,
        input.aspectRatio,
        input.style,
        input.voiceMode,
        input.rightsConfirmed ? 1 : 0,
        JSON.stringify(input.assets),
        timestamp,
        timestamp,
        JSON.stringify(metadata),
      );
    this.addEvent(id, 'info', 'queued', '任务已进入队列');
    return this.getJob(id)!;
  }

  private rowToJob(row: JobRow): JobRecord {
    return {
      id: row.id,
      title: row.title,
      mode: row.mode,
      replicaMode: row.replica_mode,
      publishPlatform: row.publish_platform ?? 'original',
      translateToChinese: Boolean(row.translate_to_chinese),
      topic: row.topic,
      script: row.script,
      durationSeconds: row.duration_seconds,
      aspectRatio: row.aspect_ratio,
      style: row.style,
      voiceMode: row.voice_mode,
      rightsConfirmed: Boolean(row.rights_confirmed),
      assets: parseJson(row.assets_json, {}),
      status: row.status,
      stage: row.stage,
      progress: row.progress,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      startedAt: row.started_at,
      finishedAt: row.finished_at,
      outputPath: row.output_path,
      error: row.error,
      cancelRequested: Boolean(row.cancel_requested),
      metadata: parseJson(row.metadata_json, {}),
    };
  }

  getJob(id: string): JobRecord | null {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined;
    return row ? this.rowToJob(row) : null;
  }

  listJobs(limit = 100): JobRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM jobs ORDER BY created_at DESC LIMIT ?')
      .all(Math.min(Math.max(limit, 1), 200)) as unknown as JobRow[];
    return rows.map((row) => this.rowToJob(row));
  }

  findActiveRetry(retryRootId: string): JobRecord | null {
    const rows = this.db
      .prepare(`SELECT * FROM jobs WHERE status IN ('pending', 'provisioning', 'running') ORDER BY created_at DESC`)
      .all() as unknown as JobRow[];
    const row = rows.find((candidate) => {
      const metadata = parseJson<Record<string, unknown>>(candidate.metadata_json, {});
      return metadata.retryRootId === retryRootId;
    });
    return row ? this.rowToJob(row) : null;
  }

  updateJob(
    id: string,
    patch: Partial<{
      status: JobStatus;
      stage: string;
      progress: number;
      startedAt: string | null;
      finishedAt: string | null;
      outputPath: string | null;
      error: string | null;
      cancelRequested: boolean;
      metadata: Record<string, unknown>;
    }>,
  ): JobRecord | null {
    const columns: Record<string, string> = {
      status: 'status',
      stage: 'stage',
      progress: 'progress',
      startedAt: 'started_at',
      finishedAt: 'finished_at',
      outputPath: 'output_path',
      error: 'error',
      cancelRequested: 'cancel_requested',
      metadata: 'metadata_json',
    };
    const entries = Object.entries(patch).filter(([, value]) => value !== undefined);
    if (!entries.length) return this.getJob(id);
    const values: Array<string | number | null> = entries.map(([key, value]) => {
      if (key === 'cancelRequested') return value ? 1 : 0;
      if (key === 'metadata') return JSON.stringify(value);
      return value as string | number | null;
    });
    const assignments = entries.map(([key]) => `${columns[key]} = ?`);
    assignments.push('updated_at = ?');
    values.push(now(), id);
    this.db.prepare(`UPDATE jobs SET ${assignments.join(', ')} WHERE id = ?`).run(...values);
    return this.getJob(id);
  }

  claimNextJob(): JobRecord | null {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const row = this.db
        .prepare(`SELECT id FROM jobs WHERE status = 'pending' AND cancel_requested = 0 ORDER BY created_at ASC LIMIT 1`)
        .get() as {id: string} | undefined;
      if (!row) {
        this.db.exec('COMMIT');
        return null;
      }
      const timestamp = now();
      this.db
        .prepare(`UPDATE jobs SET status = 'provisioning', stage = '唤醒算力', progress = 8, started_at = ?, updated_at = ? WHERE id = ?`)
        .run(timestamp, timestamp, row.id);
      this.db.exec('COMMIT');
      return this.getJob(row.id);
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  requestCancel(id: string): JobRecord | null {
    const job = this.getJob(id);
    if (!job || ['succeeded', 'failed', 'cancelled'].includes(job.status)) return job;
    if (job.status === 'pending') {
      this.updateJob(id, {
        status: 'cancelled',
        stage: '已取消',
        progress: job.progress,
        cancelRequested: true,
        finishedAt: now(),
      });
    } else {
      this.updateJob(id, {cancelRequested: true, stage: '正在取消'});
    }
    this.addEvent(id, 'warning', 'cancel_requested', '用户请求取消任务');
    return this.getJob(id);
  }

  isCancelRequested(id: string): boolean {
    const row = this.db.prepare('SELECT cancel_requested FROM jobs WHERE id = ?').get(id) as
      | {cancel_requested: number}
      | undefined;
    return Boolean(row?.cancel_requested);
  }

  countActiveJobs(): number {
    const row = this.db
      .prepare(`SELECT COUNT(*) AS count FROM jobs WHERE status IN ('pending', 'provisioning', 'running')`)
      .get() as {count: number};
    return row.count;
  }

  queueSummary(): {pending: number; active: number; total: number} {
    const pending = this.db.prepare(`SELECT COUNT(*) AS count FROM jobs WHERE status = 'pending'`).get() as {count: number};
    const active = this.db
      .prepare(`SELECT COUNT(*) AS count FROM jobs WHERE status IN ('provisioning', 'running')`)
      .get() as {count: number};
    return {pending: pending.count, active: active.count, total: pending.count + active.count};
  }

  metrics24h(): {
    total: number;
    succeeded: number;
    failed: number;
    cancelled: number;
    running: number;
    successRate: number;
    requestSeries: Array<{hour: string; count: number}>;
  } {
    const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const rows = this.db
      .prepare('SELECT status, COUNT(*) AS count FROM jobs WHERE created_at >= ? GROUP BY status')
      .all(cutoff) as unknown as Array<{status: JobStatus; count: number}>;
    const counts = Object.fromEntries(rows.map((row) => [row.status, row.count])) as Partial<Record<JobStatus, number>>;
    const total = rows.reduce((sum, row) => sum + row.count, 0);
    const succeeded = counts.succeeded ?? 0;
    const failed = counts.failed ?? 0;
    const terminal = succeeded + failed + (counts.cancelled ?? 0);
    const seriesRows = this.db
      .prepare(`
        SELECT substr(created_at, 1, 13) AS hour, COUNT(*) AS count
        FROM jobs WHERE created_at >= ?
        GROUP BY substr(created_at, 1, 13)
        ORDER BY hour ASC
      `)
      .all(cutoff) as unknown as Array<{hour: string; count: number}>;
    return {
      total,
      succeeded,
      failed,
      cancelled: counts.cancelled ?? 0,
      running: (counts.pending ?? 0) + (counts.provisioning ?? 0) + (counts.running ?? 0),
      successRate: terminal ? Math.round((succeeded / terminal) * 100) : 0,
      requestSeries: seriesRows,
    };
  }

  addEvent(
    jobId: string,
    level: JobEvent['level'],
    kind: string,
    message: string,
    data: Record<string, unknown> = {},
  ): void {
    this.db
      .prepare('INSERT INTO job_events (job_id, level, kind, message, data_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(jobId, level, kind, message.slice(0, 2000), JSON.stringify(data), now());
  }

  listEvents(jobId: string, afterId = 0, limit = 500): JobEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM job_events WHERE job_id = ? AND id > ? ORDER BY id ASC LIMIT ?')
      .all(jobId, afterId, Math.min(limit, 1000)) as unknown as Array<{
      id: number;
      job_id: string;
      level: JobEvent['level'];
      kind: string;
      message: string;
      data_json: string;
      created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      jobId: row.job_id,
      level: row.level,
      kind: row.kind,
      message: row.message,
      data: parseJson(row.data_json, {}),
      createdAt: row.created_at,
    }));
  }

  listLatestEvents(jobId: string, limit = 500): JobEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM job_events WHERE job_id = ? ORDER BY id DESC LIMIT ?')
      .all(jobId, Math.min(limit, 1000)) as unknown as Array<{
      id: number;
      job_id: string;
      level: JobEvent['level'];
      kind: string;
      message: string;
      data_json: string;
      created_at: string;
    }>;
    return rows.reverse().map((row) => ({
      id: row.id,
      jobId: row.job_id,
      level: row.level,
      kind: row.kind,
      message: row.message,
      data: parseJson(row.data_json, {}),
      createdAt: row.created_at,
    }));
  }

  listRecentEvents(limit = 60): Array<JobEvent & {jobTitle: string}> {
    const rows = this.db
      .prepare(`
        SELECT job_events.*, jobs.title AS job_title
        FROM job_events
        JOIN jobs ON jobs.id = job_events.job_id
        ORDER BY job_events.id DESC
        LIMIT ?
      `)
      .all(Math.min(Math.max(limit, 1), 200)) as unknown as Array<{
      id: number;
      job_id: string;
      job_title: string;
      level: JobEvent['level'];
      kind: string;
      message: string;
      data_json: string;
      created_at: string;
    }>;
    return rows.map((row) => ({
      id: row.id,
      jobId: row.job_id,
      jobTitle: row.job_title,
      level: row.level,
      kind: row.kind,
      message: row.message,
      data: parseJson(row.data_json, {}),
      createdAt: row.created_at,
    }));
  }

  setRuntime(key: string, value: string | null): void {
    if (value === null) {
      this.db.prepare('DELETE FROM runtime_state WHERE key = ?').run(key);
      return;
    }
    this.db
      .prepare(`
        INSERT INTO runtime_state (key, value, updated_at) VALUES (?, ?, ?)
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `)
      .run(key, value, now());
  }

  getRuntime(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM runtime_state WHERE key = ?').get(key) as {value: string} | undefined;
    return row?.value ?? null;
  }
}
