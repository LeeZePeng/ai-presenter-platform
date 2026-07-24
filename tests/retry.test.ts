import {createHash} from 'node:crypto';
import {existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it} from 'vitest';
import {AppDatabase} from '../server/db.js';
import {createFullRegenerationJob, createRetryJob, createVisualRepairJob, RetryJobError} from '../server/retry.js';

const directories: string[] = [];

const setup = () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), 'presenter-retry-'));
  directories.push(directory);
  const jobsDir = path.join(directory, 'jobs');
  const sourceDir = path.join(jobsDir, 'source-job');
  mkdirSync(path.join(sourceDir, 'assets'), {recursive: true});
  const avatar = path.join(sourceDir, 'assets', 'avatarImage.png');
  writeFileSync(avatar, 'avatar');
  const sourceVideo = path.join(sourceDir, 'assets', 'sourceVideo.mp4');
  writeFileSync(sourceVideo, 'source video');
  const db = new AppDatabase(path.join(directory, 'db.sqlite'));
  db.createJob('source-job', {
    title: '失败任务',
    mode: 'clone',
    replicaMode: 'condensed',
    topic: '测试重试',
    script: '',
    durationSeconds: 30,
    aspectRatio: '16:9',
    style: '自然专业',
    voiceMode: 'system_voice',
    rightsConfirmed: true,
    assets: {avatarImage: avatar, sourceVideo},
  });
  db.updateJob('source-job', {status: 'failed', stage: '执行失败', error: '服务断开'});
  return {db, jobsDir, sourceDir};
};

afterEach(() => {
  while (directories.length) rmSync(directories.pop()!, {recursive: true, force: true});
});

describe('createRetryJob', () => {
  it('requeues an approved fixed Remotion workspace in place for fast rendering', () => {
    const {db, jobsDir, sourceDir} = setup();
    const files: Array<[string, string]> = [
      ['remotion/src/index.ts', "import {registerRoot} from 'remotion';"],
      ['remotion/src/Root.tsx', '<Composition id="FastReplica" />'],
      ['remotion/public/presenter/presenter-track.mp4', 'presenter track'],
      ['out/audio/final_narration.wav', 'locked narration'],
      ['out/analysis/presenter_render_manifest.json', JSON.stringify({presenterRenderPaths: ['segment.mp4']})],
      ['out/analysis/preflight_report.json', JSON.stringify({approved: true})],
      ['out/analysis/scene_contract_report.json', JSON.stringify({valid: true})],
      ['out/analysis/source_transcript.json', JSON.stringify({segments: []})],
    ];
    for (const [relative, value] of files) {
      const filename = path.join(sourceDir, relative);
      mkdirSync(path.dirname(filename), {recursive: true});
      writeFileSync(filename, value);
    }

    const result = createRetryJob(db, jobsDir, 'source-job', 'unused-retry-id');

    expect(result.job.id).toBe('source-job');
    expect(result.job.status).toBe('pending');
    expect(result.job.cancelRequested).toBe(false);
    expect(result.fastRenderOnly).toBe(true);
    expect(result.job.metadata).toMatchObject({
      fastRenderOnly: true,
      reusedPresenterRender: true,
      reusedSourceTranscript: true,
      retryCount: 1,
    });
    expect(existsSync(path.join(jobsDir, 'unused-retry-id'))).toBe(false);
  });

  it('copies assets and reusable segmented checkpoints into a new queued job', () => {
    const {db, jobsDir, sourceDir} = setup();
    const checkpoint = path.join(sourceDir, 'out', 'checkpoints', 'segments', 'segment-001.mp4');
    mkdirSync(path.dirname(checkpoint), {recursive: true});
    writeFileSync(checkpoint, 'completed segment');
    const narration = path.join(sourceDir, 'out', 'audio', 'final_narration.wav');
    mkdirSync(path.dirname(narration), {recursive: true});
    writeFileSync(narration, 'final narration');
    const transcript = path.join(sourceDir, 'out', 'analysis', 'source_transcript.json');
    mkdirSync(path.dirname(transcript), {recursive: true});
    writeFileSync(transcript, JSON.stringify({sourcePath: path.join(sourceDir, 'assets', 'sourceVideo.mp4')}));
    const presenter = path.join(sourceDir, 'remotion', 'public', 'presenter', 'render', 'segment-001.mp4');
    mkdirSync(path.dirname(presenter), {recursive: true});
    writeFileSync(presenter, 'rendered presenter');
    writeFileSync(
      path.join(sourceDir, 'out', 'analysis', 'presenter_render_manifest.json'),
      JSON.stringify({presenterRenderPaths: [presenter]}),
    );
    writeFileSync(
      path.join(sourceDir, 'out', 'checkpoints', 'segments', 'state.json'),
      JSON.stringify({renderPath: presenter}),
    );

    const result = createRetryJob(db, jobsDir, 'source-job', 'retry-job');

    expect(result.job.status).toBe('pending');
    expect(result.job.metadata).toMatchObject({
      retryOf: 'source-job',
      retryRootId: 'source-job',
      retryCount: 1,
      reusedSourceTranscript: true,
      reusedPresenterRender: true,
      sourceTranscriptPath: path.join(jobsDir, 'retry-job', 'out', 'analysis', 'source_transcript.json'),
    });
    expect(result.reusedCheckpoints).toBe(true);
    expect(result.reusedCompletedArtifacts).toBe(false);
    expect(readFileSync(result.job.assets.avatarImage!, 'utf8')).toBe('avatar');
    expect(readFileSync(path.join(jobsDir, 'retry-job', 'out', 'checkpoints', 'segments', 'segment-001.mp4'), 'utf8'))
      .toBe('completed segment');
    expect(readFileSync(path.join(jobsDir, 'retry-job', 'out', 'audio', 'final_narration.wav'), 'utf8'))
      .toBe('final narration');
    expect(readFileSync(path.join(jobsDir, 'retry-job', 'remotion', 'public', 'presenter', 'render', 'segment-001.mp4'), 'utf8'))
      .toBe('rendered presenter');
    const renderManifest = JSON.parse(
      readFileSync(path.join(jobsDir, 'retry-job', 'out', 'analysis', 'presenter_render_manifest.json'), 'utf8'),
    );
    expect(renderManifest.presenterRenderPaths[0]).toContain(path.join('retry-job', 'remotion', 'public', 'presenter'));
    const checkpointState = JSON.parse(
      readFileSync(path.join(jobsDir, 'retry-job', 'out', 'checkpoints', 'segments', 'state.json'), 'utf8'),
    );
    expect(checkpointState.renderPath).toContain(path.join('retry-job', 'remotion', 'public', 'presenter'));
  });

  it('copies a completed output package for validation-only repair', () => {
    const {db, jobsDir, sourceDir} = setup();
    const sourceOut = path.join(sourceDir, 'out');
    mkdirSync(path.join(sourceOut, 'analysis'), {recursive: true});
    writeFileSync(path.join(sourceOut, 'final.mp4'), 'complete video');
    writeFileSync(path.join(sourceOut, 'result.json'), JSON.stringify({outputPath: path.join(sourceOut, 'final.mp4')}));
    writeFileSync(path.join(sourceOut, 'analysis', 'visual_review.json'), JSON.stringify({approved: true}));

    const result = createRetryJob(db, jobsDir, 'source-job', 'repair-job');

    expect(result.reusedCompletedArtifacts).toBe(true);
    expect(result.job.metadata).toMatchObject({reusedCompletedArtifacts: true});
    expect(readFileSync(path.join(jobsDir, 'repair-job', 'out', 'final.mp4'), 'utf8')).toBe('complete video');
    expect(readFileSync(path.join(jobsDir, 'repair-job', 'out', 'analysis', 'visual_review.json'), 'utf8'))
      .toContain('approved');
  });

  it('rejects a second active retry for the same root task', () => {
    const {db, jobsDir} = setup();
    createRetryJob(db, jobsDir, 'source-job', 'retry-job');
    expect(() => createRetryJob(db, jobsDir, 'source-job', 'retry-job-2')).toThrow(RetryJobError);
  });
});

describe('createFullRegenerationJob', () => {
  it('creates a five-minute translated condensed repair and reuses only the source transcript', () => {
    const {db, jobsDir, sourceDir} = setup();
    const transcript = path.join(sourceDir, 'out', 'analysis', 'source_transcript.json');
    mkdirSync(path.dirname(transcript), {recursive: true});
    writeFileSync(transcript, JSON.stringify({language: 'en', text: 'source transcript', segments: [{text: 'source'}]}));
    db.updateJob('source-job', {status: 'succeeded', stage: '已完成'});

    const result = createFullRegenerationJob(db, jobsDir, 'source-job', 'translated-repair', {
      replicaMode: 'condensed',
      durationSeconds: 300,
      translateToChinese: true,
    });

    expect(result.job).toMatchObject({
      id: 'translated-repair',
      title: '失败任务（300秒中文精简返修）',
      replicaMode: 'condensed',
      durationSeconds: 300,
      translateToChinese: true,
    });
    expect(result.reusedSourceTranscript).toBe(true);
    expect(result.job.metadata).toMatchObject({
      reusedCheckpoints: false,
      reusedCompletedArtifacts: false,
      reusedSourceTranscript: true,
      sourceTranscriptPath: path.join(jobsDir, 'translated-repair', 'out', 'analysis', 'source_transcript.json'),
    });
    expect(existsSync(path.join(jobsDir, 'translated-repair', 'out', 'audio', 'final_narration.wav'))).toBe(false);
  });
});

describe('createVisualRepairJob', () => {
  it('retries a succeeded task while preserving reusable audio, presenter checkpoints, transcript, and Remotion sources', () => {
    const {db, jobsDir, sourceDir} = setup();
    const sourceOut = path.join(sourceDir, 'out');
    mkdirSync(path.join(sourceOut, 'audio'), {recursive: true});
    mkdirSync(path.join(sourceOut, 'checkpoints', 'infinite_talk'), {recursive: true});
    mkdirSync(path.join(sourceOut, 'analysis'), {recursive: true});
    mkdirSync(path.join(sourceDir, 'remotion', 'src'), {recursive: true});
    writeFileSync(path.join(sourceOut, 'final.mp4'), 'old video');
    writeFileSync(path.join(sourceOut, 'result.json'), JSON.stringify({
      outputPath: path.join(sourceOut, 'final.mp4'),
      sourceReviewFramePaths: [path.join(sourceOut, 'stills', 'source_review', 'frames', '001.jpg')],
    }));
    writeFileSync(path.join(sourceOut, 'audio', 'final_narration.wav'), 'locked audio');
    writeFileSync(path.join(sourceOut, 'checkpoints', 'infinite_talk', 'segments.json'), '[]');
    writeFileSync(path.join(sourceOut, 'analysis', 'source_transcript.json'), '{}');
    writeFileSync(path.join(sourceDir, 'remotion', 'src', 'Root.tsx'), 'old project');
    db.updateJob('source-job', {status: 'succeeded', stage: '已完成'});

    const result = createVisualRepairJob(db, jobsDir, 'source-job', 'visual-repair-job');

    expect(result.job.status).toBe('pending');
    expect(result.job.metadata).toMatchObject({
      retryOf: 'source-job',
      reusedCheckpoints: true,
      reusedCompletedArtifacts: true,
      visualRepairOnly: true,
      sourceTranscriptPath: path.join(jobsDir, 'visual-repair-job', 'out', 'analysis', 'source_transcript.json'),
      sourceTranscriptSha256: createHash('sha256').update('{}').digest('hex'),
    });
    expect(readFileSync(path.join(jobsDir, 'visual-repair-job', 'out', 'audio', 'final_narration.wav'), 'utf8'))
      .toBe('locked audio');
    expect(readFileSync(path.join(jobsDir, 'visual-repair-job', 'remotion', 'src', 'Root.tsx'), 'utf8'))
      .toBe('old project');
    const rewrittenResult = JSON.parse(readFileSync(path.join(jobsDir, 'visual-repair-job', 'out', 'result.json'), 'utf8'));
    expect(rewrittenResult.outputPath).toBe(path.join(jobsDir, 'visual-repair-job', 'out', 'final.mp4'));
    expect(rewrittenResult.sourceReviewFramePaths[0]).toContain(path.join('visual-repair-job', 'out', 'stills'));
    expect(readFileSync(path.join(jobsDir, 'visual-repair-job', 'out', 'analysis', 'source_transcript.json'), 'utf8'))
      .toBe('{}');
  });
});
