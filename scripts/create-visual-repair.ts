import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {AppDatabase} from '../server/db.js';
import {createVisualRepairJob} from '../server/retry.js';

const sourceJobId = process.argv[2]?.trim();
const dataDir = path.resolve(process.argv[3] ?? '/var/lib/ai-presenter/data');

if (!sourceJobId) {
  throw new Error('usage: tsx scripts/create-visual-repair.ts <source-job-id> [data-dir]');
}

const db = new AppDatabase(path.join(dataDir, 'platform.sqlite'));
const retryId = randomUUID();
const result = createVisualRepairJob(db, path.join(dataDir, 'jobs'), sourceJobId, retryId);

process.stdout.write(`${JSON.stringify({
  jobId: result.job.id,
  status: result.job.status,
  reusedAudio: true,
  reusedPresenter: true,
  visualRepairOnly: result.visualRepairOnly,
})}\n`);
