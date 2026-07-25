import {mkdtempSync, mkdirSync, writeFileSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {
  calculateCodexTimeoutMs,
  countVisualSignatureClusters,
  codexContinuationPrompt,
  codexValidationRepairPrompt,
  contentOverlapRatio,
  detectDurationConstraintFailure,
  extractCodexThreadId,
  inspectArtifactProgress,
  isGrossLumaMismatch,
  isTransientCodexFailure,
  shouldContinueCodexGoal,
  shouldStopSettledGoalTurn,
  validateCaptionTimeline,
  validateChineseNarration,
  validateMarketingCopy,
  validateNarrationClosing,
  validateNarrationTimeline,
  validateNarrationVisualMap,
  validateRemotionImplementation,
  validateRemotionQualityBinding,
  validateSceneImplementation,
  validateVisualReview,
} from '../server/codex-runner.js';

describe('Codex Goal continuation', () => {
  it('rejects an English script when Chinese translation was requested', () => {
    expect(() => validateChineseNarration('This is still an English narration with no translated content.')).toThrow(
      '最终口播不是中文主体',
    );
    expect(() => validateChineseNarration(`${'这是一段忠实翻译后的自然中文口播。'.repeat(12)}Kimi K3 GPT`)).not.toThrow();
  });

  it('captures the persisted thread id from Codex JSONL events', () => {
    const threadId = '019f6f04-36b6-7492-b2d4-7014e31da75e';
    expect(extractCodexThreadId({type: 'thread.started', thread_id: threadId})).toBe(threadId);
    expect(extractCodexThreadId({type: 'thread.started', thread_id: 'not-a-thread'})).toBeNull();
  });

  it('requires a resumed turn to reuse checkpoints and finish the active Goal', () => {
    const prompt = codexContinuationPrompt(2, 45 * 60 * 1000);
    expect(prompt).toContain('active Goal');
    expect(prompt).toContain('不要重做');
    expect(prompt).toContain('pending prompt');
    expect(prompt).toContain('--max-polls 240');
    expect(prompt).toContain('45 分钟');
    expect(prompt).not.toContain('外部条件已变化');
  });

  it('stops instead of resuming when a duration constraint is terminal', () => {
    const failure = detectDurationConstraintFailure(
      '验证结果：失败。无法在 60 秒内完整保留全部观点。必要告警：需将时长上限提高至至少 180 秒。',
      60,
    );
    expect(failure).toBe('当前 60 秒时长约束无法完整保留原片实质内容，建议至少 180 秒');
    expect(
      detectDurationConstraintFailure(
        '验证结果：失败。无法在 60 秒内完整保留全部观点。',
        60,
        'condensed',
      ),
    ).toBeNull();
    expect(
      shouldContinueCodexGoal({
        hasCompleteArtifacts: false,
        turnTimedOut: false,
        threadId: '019f74c2-578f-7360-a3dd-d280aafcfd84',
        goalStatus: 'active',
        terminalConstraintFailure: true,
      }),
    ).toBe(false);
  });

  it('never auto-resumes a blocked or prematurely completed Goal', () => {
    for (const goalStatus of ['blocked', 'complete']) {
      expect(
        shouldContinueCodexGoal({
          hasCompleteArtifacts: false,
          turnTimedOut: false,
          threadId: '019f74c2-578f-7360-a3dd-d280aafcfd84',
          goalStatus,
          terminalConstraintFailure: false,
        }),
      ).toBe(false);
    }
  });

  it('distinguishes transient Codex service outages from real Goal blockers', () => {
    expect(
      isTransientCodexFailure(
        'unexpected status 503 Service Unavailable: high demand, biscuit_baker_service_me_circuit_open',
      ),
    ).toBe(true);
    expect(isTransientCodexFailure('stream disconnected before completion: websocket closed by server')).toBe(true);
    expect(isTransientCodexFailure('缺少用户授权，无法继续调用付费服务')).toBe(false);
  });

  it('stops a residual CLI process only after the Goal is newly settled', () => {
    const initial = {status: 'active', updatedAtMs: 100};
    expect(shouldStopSettledGoalTurn(initial, {status: 'active', updatedAtMs: 200})).toBe(false);
    expect(shouldStopSettledGoalTurn(initial, {status: 'blocked', updatedAtMs: 100})).toBe(false);
    expect(shouldStopSettledGoalTurn(initial, {status: 'blocked', updatedAtMs: 200})).toBe(true);
    expect(shouldStopSettledGoalTurn(initial, {status: 'complete', updatedAtMs: 200})).toBe(true);
  });

  it('feeds an independent worker validation error back into the same task', () => {
    const prompt = codexValidationRepairPrompt('Remotion 主画面缺少旁白 cue 场景索引标记', 3, 30 * 60 * 1000);
    expect(prompt).toContain('平台独立验收');
    expect(prompt).toContain('Remotion 主画面缺少旁白 cue 场景索引标记');
    expect(prompt).toContain('不要新建平台任务');
    expect(prompt).toContain('禁止重新 TTS');
  });
});

describe('calculateCodexTimeoutMs', () => {
  const minute = 60 * 1000;

  it('keeps the configured floor for short jobs', () => {
    expect(calculateCodexTimeoutMs(90 * minute, 15)).toBe(90 * minute);
  });

  it('allows enough time for sequential long-form presenter segments', () => {
    expect(calculateCodexTimeoutMs(90 * minute, 120)).toBe(170 * minute);
    expect(calculateCodexTimeoutMs(90 * minute, 180)).toBe(230 * minute);
    expect(calculateCodexTimeoutMs(90 * minute, 900)).toBe(720 * minute);
    expect(calculateCodexTimeoutMs(90 * minute, 900, 240 * minute)).toBe(240 * minute);
  });
});

describe('narration-driven visual mapping', () => {
  it('accepts a full final-audio timeline and phrase-level source cues', () => {
    expect(
      validateNarrationTimeline(
        {
          durationSeconds: 10,
          segments: [
            {startSeconds: 0, endSeconds: 3, text: '第一步让系统脱离界面运行'},
            {startSeconds: 3, endSeconds: 6, text: '第二步记录中间状态'},
            {startSeconds: 6, endSeconds: 10, text: '第三步让工具调用可以读取'},
          ],
        },
        10,
      ),
    ).toMatchObject({durationSeconds: 10});

    expect(
      validateNarrationVisualMap(
        {
          presenterSegmentationDrivesVisuals: false,
          sourceMotionEvidenceInventory: [{sourceStartSeconds: 20, sourceEndSeconds: 44, kind: 'static-slides', description: '三个步骤均为静态课程页，没有需要保留的运动证据', eligible: false, mappedCueIndices: [], exclusionReason: '原片仅有静态卡片与流程图，原生重建能完整表达'}],
          cues: [
            {cueIndex: 0, outputStartSeconds: 0, outputEndSeconds: 3, narrationText: '第一步脱离界面运行', visualType: 'source_clip', sourceStartSeconds: 20, sourceEndSeconds: 23, sourceText: '第一步让系统脱离界面运行', sourceSceneDescription: '米白背景上的第一步黑框卡片', replicationPlan: '按原片尺寸和颜色重建第一步卡片'},
            {cueIndex: 1, outputStartSeconds: 3, outputEndSeconds: 6, narrationText: '第二步记录中间状态', visualType: 'source_clip', sourceStartSeconds: 30, sourceEndSeconds: 33, sourceText: '第二步记录中间状态', sourceSceneDescription: '米白背景上的第二步状态流程图', replicationPlan: '按原片顺序显示第二步状态节点'},
            {cueIndex: 2, outputStartSeconds: 6, outputEndSeconds: 10, narrationText: '第三步工具调用可读', visualType: 'source_clip', sourceStartSeconds: 40, sourceEndSeconds: 44, sourceText: '第三步让工具调用可以读取', sourceSceneDescription: '米白背景上的第三步工具调用图', replicationPlan: '按原片布局重建第三步工具调用图'},
          ],
        },
        {
          narrationDuration: 10,
          narrationScript: '第一步让系统脱离界面运行，第二步记录中间状态，第三步让工具调用可以读取。',
          sourceTranscript: '第一步让系统脱离界面运行。第二步记录中间状态。第三步让工具调用可以读取。',
          sourceDuration: 60,
          exact: true,
          presenterSegmentCount: 1,
        },
      ),
    ).toMatchObject({cues: {length: 3}});
  });

  it('rejects a visual map that reuses presenter segmentation', () => {
    expect(() =>
      validateNarrationVisualMap(
        {presenterSegmentationDrivesVisuals: true, cues: []},
        {
          narrationDuration: 60,
          narrationScript: '测试旁白',
          sourceTranscript: '测试原片',
          sourceDuration: 60,
          exact: false,
          presenterSegmentCount: 4,
        },
      ),
    ).toThrow('InfiniteTalk');
  });

  it('requires condensed replicas to keep source visual cues in source order', () => {
    const cue = (outputStartSeconds: number, sourceStartSeconds: number, text: string) => ({
      cueIndex: outputStartSeconds / 3,
      outputStartSeconds,
      outputEndSeconds: outputStartSeconds + 3,
      narrationText: text,
      visualType: 'native_rebuild',
      sourceStartSeconds,
      sourceEndSeconds: sourceStartSeconds + 3,
      sourceText: text,
      sourceSceneDescription: '原片米白背景和黑色粗描边卡片',
      replicationPlan: '使用相同配色版式逐项原生重建场景',
    });
    expect(() =>
      validateNarrationVisualMap(
        {
          presenterSegmentationDrivesVisuals: false,
          sourceMotionEvidenceInventory: [{sourceStartSeconds: 10, sourceEndSeconds: 33, kind: 'static-slides', description: '三个步骤都是静态卡片页面，没有实机动作', eligible: false, mappedCueIndices: [], exclusionReason: '原片只展示静态步骤卡，运动不构成证据'}],
          cues: [cue(0, 20, '第一步开始执行'), cue(3, 10, '第二步继续执行'), cue(6, 30, '第三步完成执行')],
        },
        {
          narrationDuration: 9,
          narrationScript: '第一步开始执行，第二步继续执行，第三步完成执行。',
          sourceTranscript: '第二步继续执行。第一步开始执行。第三步完成执行。',
          sourceDuration: 60,
          exact: false,
          presenterSegmentCount: 1,
        },
      ),
    ).toThrow('没有保持原有顺序');
  });

  it('rejects a cue over the documented 12 second hard limit with an actionable error', () => {
    expect(() =>
      validateNarrationVisualMap(
        {
          presenterSegmentationDrivesVisuals: false,
          cues: [
            {cueIndex: 0, outputStartSeconds: 0, outputEndSeconds: 12.6, narrationText: '第一段旁白内容', visualType: 'concept_card'},
            {cueIndex: 1, outputStartSeconds: 12.6, outputEndSeconds: 18, narrationText: '第二段旁白内容', visualType: 'concept_card'},
            {cueIndex: 2, outputStartSeconds: 18, outputEndSeconds: 24, narrationText: '第三段旁白内容', visualType: 'concept_card'},
          ],
        },
        {
          narrationDuration: 24,
          narrationScript: '第一段旁白内容，第二段旁白内容，第三段旁白内容。',
          sourceTranscript: '原片内容',
          sourceDuration: 30,
          exact: false,
          presenterSegmentCount: 1,
        },
      ),
    ).toThrow('第 1 个 cue 时长 12.600 秒，超过 12 秒上限');
  });

  it('rejects abstract cards when narration needs a visible source demo', () => {
    const cue = (index: number, narrationText: string, visualType = 'native_rebuild') => ({
      cueIndex: index,
      outputStartSeconds: index * 4,
      outputEndSeconds: index * 4 + 4,
      narrationText,
      visualType,
      sourceStartSeconds: index * 10,
      sourceEndSeconds: index * 10 + 8,
      sourceText: narrationText,
      sourceSceneDescription: '原片正在展示真实产品报告和图表页面',
      replicationPlan: '展示当前产品报告并标注结论',
    });
    expect(() =>
      validateNarrationVisualMap(
        {
          presenterSegmentationDrivesVisuals: false,
          sourceEvidenceInventory: [{sourceStartSeconds: 0, sourceEndSeconds: 8, kind: 'software-demo', description: '真实产品报告包含对比表和结果图表', preserveOriginal: true, mappedCueIndices: [0]}],
          cues: [
            cue(0, '报告页面展示了三项核心结果和对比数据'),
            cue(1, '接着看第二项静态评分'),
            cue(2, '最后给出整体结论'),
          ],
        },
        {
          narrationDuration: 12,
          narrationScript: '报告页面展示了三项核心结果和对比数据。接着看第二项静态评分。最后给出整体结论。',
          sourceTranscript: '报告页面展示了三项核心结果和对比数据。接着看第二项静态评分。最后给出整体结论。',
          sourceDuration: 30,
          exact: false,
          presenterSegmentCount: 1,
        },
      ),
    ).toThrow('禁止用卡片或示意图替代原片演示证据');
  });
});

describe('quality-first captions and scene implementation', () => {
  it('requires full script coverage instead of cue-summary captions', () => {
    const script = '第一步理解问题，第二步执行方案，第三步检查最终结果。';
    expect(() =>
      validateCaptionTimeline(
        {
          segments: [
            {startSeconds: 0, endSeconds: 2, text: '第一步理解问题'},
            {startSeconds: 2, endSeconds: 4, text: '第二步执行方案'},
            {startSeconds: 4, endSeconds: 6, text: '第三步检查最终结果'},
          ],
        },
        {narrationDuration: 6, narrationScript: script},
      ),
    ).not.toThrow();
    expect(() =>
      validateCaptionTimeline(
        {
          segments: [
            {startSeconds: 0, endSeconds: 2, text: '理解'},
            {startSeconds: 2, endSeconds: 4, text: '执行'},
            {startSeconds: 4, endSeconds: 6, text: '检查'},
          ],
        },
        {narrationDuration: 6, narrationScript: script},
      ),
    ).toThrow('覆盖不足');
  });

  it('allows a repeated layout for a continuous explanation', () => {
    const map = {
      sourceMotionEvidenceInventory: [{sourceStartSeconds: 0, sourceEndSeconds: 45, kind: 'static-slides', description: '原片是静态场景示意页，不包含实机或现场动作', eligible: false, mappedCueIndices: [], exclusionReason: '静态页面适合用原生组件重建'}],
      cues: Array.from({length: 5}, (_, index) => ({
        cueIndex: index,
        outputStartSeconds: index * 5,
        outputEndSeconds: index * 5 + 5,
        narrationText: `第 ${index + 1} 段`,
        visualType: 'native_rebuild',
        sourceStartSeconds: index * 10,
        sourceEndSeconds: index * 10 + 5,
        sourceText: `原片第 ${index + 1} 段`,
        sourceSceneDescription: '原片具体场景描述',
        replicationPlan: '逐项重建原片具体场景',
        semanticInventories: [],
      })),
    };
    const generic = {
      cues: map.cues.map((_, index) => ({
        cueIndex: index,
        sceneKey: index < 3 ? 'generic-card' : `scene-${index}`,
        implementedElements: ['标题', '标签'],
        motionEvents: ['标题进入', '标签出现'],
        semanticLists: [],
        layoutRegions: [
          {id: 'main', role: 'primary', bounds: [0.05, 0.05, 0.55, 0.6]},
          {id: 'presenter', role: 'presenter', bounds: [0.75, 0.08, 0.18, 0.22]},
          {id: 'caption', role: 'caption', bounds: [0.2, 0.82, 0.6, 0.12]},
        ],
      })),
    };
    expect(() => validateSceneImplementation(generic, map)).not.toThrow();
  });

  it('rejects empty numbered UI and overlapping presenter/caption regions', () => {
    const map = validateNarrationVisualMap(
      {
        presenterSegmentationDrivesVisuals: false,
        sourceMotionEvidenceInventory: [{sourceStartSeconds: 0, sourceEndSeconds: 9, kind: 'static-slides', description: '课程模块和关系均为静态信息图', eligible: false, mappedCueIndices: [], exclusionReason: '原片没有需要运动证明的操作或实拍'}],
        cues: [
          {
            cueIndex: 0,
            outputStartSeconds: 0,
            outputEndSeconds: 3,
            narrationText: '课程包含三个模块',
            visualType: 'native_rebuild',
            sourceStartSeconds: 0,
            sourceEndSeconds: 3,
            sourceText: '课程包含三个模块',
            sourceSceneDescription: '原片课程页展示三块完整命名模块卡',
            replicationPlan: '三块完整命名模块按顺序点亮',
            semanticInventories: [{label: '课程模块', count: 3, items: ['基础认知', '工具调用', '效果评估'], sourceEvidence: '原片 0-3 秒目录页', presentationMode: 'list'}],
          },
          {cueIndex: 1, outputStartSeconds: 3, outputEndSeconds: 6, narrationText: '接着解释模块关系', visualType: 'native_rebuild', sourceStartSeconds: 3, sourceEndSeconds: 6, sourceText: '接着解释模块关系', sourceSceneDescription: '原片展示模块之间的连接关系图', replicationPlan: '原生重建连接关系图并依次高亮'},
          {cueIndex: 2, outputStartSeconds: 6, outputEndSeconds: 9, narrationText: '最后展示评估结果', visualType: 'native_rebuild', sourceStartSeconds: 6, sourceEndSeconds: 9, sourceText: '最后展示评估结果', sourceSceneDescription: '原片展示最终评估结果和完成状态', replicationPlan: '原生重建评估结果和完成状态'},
        ],
      },
      {narrationDuration: 9, narrationScript: '课程包含三个模块，接着解释模块关系，最后展示评估结果。', sourceTranscript: '课程包含三个模块。接着解释模块关系。最后展示评估结果。', sourceDuration: 12, exact: false, presenterSegmentCount: 1},
    );
    const baseCue = (index: number) => ({
      cueIndex: index,
      sceneKey: `scene-${index}`,
      implementedElements: ['完整标题', '真实语义内容'],
      motionEvents: ['标题进入', '内容推进'],
      semanticLists: index === 0 ? [{label: '课程模块', presentationMode: 'list', items: ['基础认知', '工具调用', '效果评估']}] : [],
      layoutRegions: [
        {id: 'main', role: 'primary', bounds: [0.05, 0.05, 0.55, 0.6]},
        {id: 'presenter', role: 'presenter', bounds: [0.75, 0.08, 0.18, 0.22]},
        {id: 'caption', role: 'caption', bounds: [0.2, 0.82, 0.6, 0.12]},
      ],
    });
    const placeholder = {cues: [baseCue(0), baseCue(1), baseCue(2)]};
    placeholder.cues[0].implementedElements = ['课程标题', 'M1-M3 三张模块卡'];
    expect(() => validateSceneImplementation(placeholder, map)).toThrow('占位列举');

    const collision = {cues: [baseCue(0), baseCue(1), baseCue(2)]};
    collision.cues[0].layoutRegions[1].bounds = [0.7, 0.8, 0.2, 0.16];
    expect(() => validateSceneImplementation(collision, map)).toThrow('人物与字幕区域重叠');
  });

  it('clusters near-identical central compositions', () => {
    const flat = (value: number) => Uint8Array.from({length: 16}, () => value);
    expect(countVisualSignatureClusters([flat(10), flat(12), flat(80), flat(82)], 5)).toBe(2);
  });
});

describe('contentOverlapRatio', () => {
  it('accepts a source-grounded rewrite and rejects production narration', () => {
    const source = '这个工具可以自动审查 GitHub pull request，并在代码提交后给出风险说明。';
    expect(contentOverlapRatio('它能自动审查 GitHub pull request，并指出代码风险。', source)).toBeGreaterThan(0.3);
    expect(contentOverlapRatio('接下来生成数字人，再用 Remotion 加 UI。', source)).toBeLessThan(0.12);
  });
});

describe('isGrossLumaMismatch', () => {
  it('rejects bright-source dark-template inversions without rejecting normal exposure drift', () => {
    expect(isGrossLumaMismatch(218, 52)).toBe(true);
    expect(isGrossLumaMismatch(48, 176)).toBe(true);
    expect(isGrossLumaMismatch(205, 168)).toBe(false);
  });
});

describe('validateMarketingCopy', () => {
  it('allows source-topic product names but rejects production disclosures', () => {
    expect(() =>
      validateMarketingCopy(
        '把 Codex 的 Go 讲透',
        '这一期用一句话讲清 Codex 里的 Go，帮助你快速理解它在真实工作流中的含义和使用边界。',
      ),
    ).not.toThrow();
    expect(() =>
      validateMarketingCopy(
        '一条完整的产品讲解视频',
        '本视频使用 Codex 和 Remotion 制作成片，并通过 TTS 生成最终口播，完整展示幕后制作过程。',
      ),
    ).toThrow('制作过程');
    expect(() =>
      validateMarketingCopy(
        '这是一个超过二十四个字符因此不适合直接发布到抖音平台的标题',
        '这一期直接讲清核心结论、关键原因和可以立刻执行的下一步，帮助你快速做出判断。',
        'douyin',
      ),
    ).toThrow('抖音发布标题');
  });
});

describe('inspectArtifactProgress', () => {
  it('reports durable InfiniteTalk segment progress instead of synthetic event-count progress', () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'presenter-progress-'));
    const checkpoint = path.join(workspace, 'out', 'checkpoints', 'infinite_talk');
    mkdirSync(checkpoint, {recursive: true});
    writeFileSync(
      path.join(checkpoint, 'segments.json'),
      JSON.stringify({completed_segments: 5, segment_plan: Array.from({length: 7}, (_, index) => ({index}))}),
    );

    expect(inspectArtifactProgress(workspace)).toMatchObject({
      key: 'presenter-segments-5-7',
      message: '数字人口型片段已完成 5/7',
      stage: '生成数字人 5/7',
      data: {completed: 5, total: 7},
    });
  });

  it('advances to Remotion rendering when a durable visual preview exists', () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'presenter-remotion-progress-'));
    const stills = path.join(workspace, 'out', 'stills', 'remotion');
    mkdirSync(stills, {recursive: true});
    writeFileSync(path.join(stills, 'opening.png'), Buffer.alloc(2048));

    expect(inspectArtifactProgress(workspace)).toMatchObject({
      key: 'remotion-preview-ready',
      stage: '渲染视觉成片',
      progress: 80,
    });
  });

  it('reports durable Remotion frame progress and ETA from the Mac render wrapper', () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'presenter-remotion-frame-progress-'));
    const analysis = path.join(workspace, 'out', 'analysis');
    mkdirSync(analysis, {recursive: true});
    writeFileSync(
      path.join(analysis, 'remotion_progress.json'),
      JSON.stringify({
        version: 1,
        state: 'rendering',
        percent: 42,
        renderedFrames: 8949,
        totalFrames: 21312,
        etaSeconds: 620,
        concurrency: 16,
        attempt: 1,
      }),
    );

    expect(inspectArtifactProgress(workspace)).toMatchObject({
      key: 'remotion-render-42',
      kind: 'remotion_render_progress',
      stage: '渲染视觉成片 42%',
      progress: 82,
      data: {renderedFrames: 8949, totalFrames: 21312, concurrency: 16},
    });
  });

  it('reports the single presenter track before Remotion preflight starts', () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'presenter-track-progress-'));
    const presenter = path.join(workspace, 'remotion', 'public', 'presenter');
    mkdirSync(presenter, {recursive: true});
    writeFileSync(path.join(presenter, 'presenter-track.mp4'), Buffer.alloc(2048));

    expect(inspectArtifactProgress(workspace)).toMatchObject({
      key: 'presenter-track-ready',
      stage: '编排字幕与 UI',
      progress: 78,
    });
  });

  it('recognizes presenter and Remotion filenames emitted by the skill', () => {
    const presenterWorkspace = mkdtempSync(path.join(os.tmpdir(), 'presenter-public-progress-'));
    const presenterPublic = path.join(presenterWorkspace, 'out', 'remotion', 'public');
    mkdirSync(presenterPublic, {recursive: true});
    writeFileSync(path.join(presenterPublic, 'presenter.mp4'), Buffer.alloc(2048));
    expect(inspectArtifactProgress(presenterWorkspace)).toMatchObject({
      key: 'presenter-ready',
      stage: '编排字幕与 UI',
      progress: 76,
    });

    const visualWorkspace = mkdtempSync(path.join(os.tmpdir(), 'presenter-visual-progress-'));
    mkdirSync(path.join(visualWorkspace, 'out'), {recursive: true});
    writeFileSync(path.join(visualWorkspace, 'out', 'remotion-visual.mp4'), Buffer.alloc(2048));
    expect(inspectArtifactProgress(visualWorkspace)).toMatchObject({
      key: 'remotion-visual-ready',
      stage: '封装最终成片',
      progress: 86,
    });
  });
});

describe('validateVisualReview', () => {
  it('accepts optional diagnostic fields and rejects malformed approval output', () => {
    expect(
      validateVisualReview({
        approved: true,
        score: 88,
        coverApproved: true,
        coverScore: 86,
        coverIssues: [],
        fatalIssues: [],
        issues: ['次要字号可再统一'],
        strengths: ['原片风格一致'],
        requiredFixes: [],
      }),
    ).toMatchObject({approved: true, score: 88});
    expect(
      validateVisualReview({
        approved: true,
        coverApproved: true,
        coverIssues: [],
      }),
    ).toMatchObject({approved: true, score: null, fatalIssues: [], issues: []});
    expect(() => validateVisualReview({coverApproved: true, coverIssues: []})).toThrow('缺少有效结论');
  });
});

describe('validateRemotionImplementation', () => {
  it('rejects static source-frame fallbacks and requires presenter plus frame animation', () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'presenter-remotion-source-'));
    const entry = path.join(workspace, 'index.tsx');
    const fonts = path.join(workspace, 'public', 'fonts');
    mkdirSync(fonts, {recursive: true});
    for (const filename of ['NotoSansCJKSC-Regular.otf', 'NotoSansCJKSC-Bold.otf', 'NotoSansCJKSC-Black.otf']) {
      writeFileSync(path.join(fonts, filename), Buffer.alloc(2048));
    }
    writeFileSync(
      entry,
      `import {loadFont} from '@remotion/fonts';
       loadFont({family:'Presenter Noto Sans SC',url:'NotoSansCJKSC-Regular.otf',weight:'400'});
       loadFont({family:'Presenter Noto Sans SC',url:'NotoSansCJKSC-Bold.otf',weight:'700'});
       loadFont({family:'Presenter Noto Sans SC',url:'NotoSansCJKSC-Black.otf',weight:'900'});
       const frame = useCurrentFrame(); const x = interpolate(frame, [0, 10], [0, 1]);
       const style = {fontFamily:'Presenter Noto Sans SC, sans-serif', letterSpacing: 0};
       <main data-cue-index={0} data-scene-key="workflow-diagram"><div data-caption-layer="narration-timeline">完整字幕</div><div data-presenter-layer="infinite-talk"><OffthreadVideo src={staticFile('presenter/presenter-track.mp4')} /></div></main>`,
    );
    expect(() => validateRemotionImplementation(entry)).not.toThrow();
    writeFileSync(entry, `<Img src={staticFile('source-cues/cue-00.jpg')} />`);
    expect(() => validateRemotionImplementation(entry)).toThrow('静态全屏背景');
  });

  it('rejects segmented presenter decoders and accepts one continuous presenter track', () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'presenter-remotion-segments-'));
    const entry = path.join(workspace, 'Replica.tsx');
    const fonts = path.join(workspace, 'public', 'fonts');
    mkdirSync(fonts, {recursive: true});
    for (const filename of ['NotoSansCJKSC-Regular.otf', 'NotoSansCJKSC-Bold.otf', 'NotoSansCJKSC-Black.otf']) {
      writeFileSync(path.join(fonts, filename), Buffer.alloc(2048));
    }
    writeFileSync(
      entry,
      `import {loadFont} from '@remotion/fonts';
       loadFont({family:'Presenter Noto Sans SC',url:'NotoSansCJKSC-Regular.otf',weight:'400'});
       loadFont({family:'Presenter Noto Sans SC',url:'NotoSansCJKSC-Bold.otf',weight:'700'});
       loadFont({family:'Presenter Noto Sans SC',url:'NotoSansCJKSC-Black.otf',weight:'900'});
       const frame = useCurrentFrame(); const x = interpolate(frame, [0, 10], [0, 1]);
       const style = {fontFamily:'Presenter Noto Sans SC, sans-serif', letterSpacing: 0};
       <main data-cue-index={0} data-scene-key="terminal-review"><div data-caption-layer="narration-timeline">完整字幕</div><div data-presenter-layer="infinite-talk"><Video src={staticFile('presenter/presenter-track.mp4')} /></div></main>`,
    );
    expect(() => validateRemotionImplementation(entry)).not.toThrow();
    writeFileSync(
      entry,
      `import {loadFont} from '@remotion/fonts';
       loadFont({family:'Presenter Noto Sans SC',url:'NotoSansCJKSC-Regular.otf',weight:'400'});
       loadFont({family:'Presenter Noto Sans SC',url:'NotoSansCJKSC-Bold.otf',weight:'700'});
       loadFont({family:'Presenter Noto Sans SC',url:'NotoSansCJKSC-Black.otf',weight:'900'});
       const frame = useCurrentFrame(); const x = interpolate(frame, [0, 10], [0, 1]);
       const style = {fontFamily:'Presenter Noto Sans SC, sans-serif', letterSpacing: 0};
       <main data-cue-index={0} data-scene-key="bad"><div data-caption-layer="narration-timeline" /><div data-presenter-layer="infinite-talk"><Video src={staticFile('presenter/render/segment-001.mp4')} /></div></main>`,
    );
    expect(() => validateRemotionImplementation(entry)).toThrow('禁止逐段挂载');
  });
});

describe('validateRemotionQualityBinding', () => {
  it('rejects global decorative and focus overlays that are not bound to semantic layout', () => {
    const workspace = mkdtempSync(path.join(os.tmpdir(), 'presenter-layer-binding-'));
    const entry = path.join(workspace, 'Root.tsx');
    const captionTimeline = {text: '发布了一门人工智能完整课程', segments: []};
    const sceneImplementation = {
      cues: [
        {
          cueIndex: 0,
          sceneKey: 'course-scene',
          implementedElements: ['课程标题', '数量结论'],
          motionEvents: ['标题进入'],
          semanticLists: [],
          layoutRegions: [],
        },
      ],
    } as never;
    writeFileSync(
      entry,
      `const caption='发布了一门人工智能完整课程'; const SceneSignature=()=>null; const PhraseFocus=()=>null;
       <main data-layout-role="primary" data-scene-key="course-scene"><SceneSignature/><PhraseFocus/>{caption}</main>`,
    );
    expect(() => validateRemotionQualityBinding(entry, captionTimeline, sceneImplementation)).toThrow('SceneSignature');
    writeFileSync(entry, `const caption='发布了一门人工智能完整课程'; <main data-scene-key="course-scene">{caption}</main>`);
    expect(() => validateRemotionQualityBinding(entry, captionTimeline, sceneImplementation)).toThrow('data-layout-role');
  });
});

describe('validateNarrationClosing', () => {
  it('accepts a complete subject-matter closing without engagement bait', () => {
    expect(() =>
      validateNarrationClosing(
        '今天讲清楚如何搭建智能体。最后，别等所有条件都完美，先跑通第一个版本，再用评估把它一轮轮变好。我们下期见。',
      ),
    ).not.toThrow();
  });

  it('rejects cut-off conclusions and engagement bait', () => {
    expect(() =>
      validateNarrationClosing(
        '今天讲清楚如何搭建智能体。模型负责思考，工具负责干活，评估负责打分。点赞收藏，评论区告诉我你想看什么。',
      ),
    ).toThrow('互动诱导');
    expect(() =>
      validateNarrationClosing(
        '今天讲清楚如何搭建智能体。模型负责思考，工具负责干活，评估负责打分，四种常见设计模式分别是反思、工具使用、规划和多智能体。',
      ),
    ).toThrow('自然收束');
  });
});
