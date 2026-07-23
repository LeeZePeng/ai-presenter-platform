import {describe, expect, it} from 'vitest';
import {buildCodexPrompt} from '../server/prompt.js';
import type {JobRecord} from '../server/types.js';

const job: JobRecord = {
  id: 'job-1',
  title: '真实口型测试',
  mode: 'script',
  replicaMode: 'condensed',
  topic: '',
  script: '大家好，这是一段测试。',
  durationSeconds: 5,
  aspectRatio: '16:9',
  style: '自然专业',
  voiceMode: 'system_voice',
  rightsConfirmed: true,
  assets: {avatarImage: '/jobs/job-1/assets/avatar.jpg'},
  status: 'running',
  stage: '生成中',
  progress: 20,
  createdAt: '2026-07-15T00:00:00.000Z',
  updatedAt: '2026-07-15T00:00:00.000Z',
  startedAt: '2026-07-15T00:00:00.000Z',
  finishedAt: null,
  outputPath: null,
  error: null,
  cancelRequested: false,
  metadata: {},
};

describe('buildCodexPrompt', () => {
  it('requires InfiniteTalk and forbids static presenter fallbacks', () => {
    const prompt = buildCodexPrompt(job, '/jobs/job-1', {
      skillPath: '/skills/ai-presenter-video-replica',
      presenterApiUrl: 'http://presenter:7860',
      presenterComfyUrl: 'http://presenter:8188',
      remotionRuntimeDir: '/runtime/remotion',
      remotionSkillPath: '/skills/remotion-best-practices',
      remotionBrowserExecutable: '/runtime/headless-shell',
      remotionFontDir: '/jobs/job-1/remotion/public/fonts',
      asrBin: '/runtime/whisper-cli',
      asrModel: '/runtime/ggml-small.bin',
      asrLanguage: 'zh',
      asrThreads: 8,
      sourceTranscriptPath: undefined,
    });

    expect(prompt).toContain('/skills/ai-presenter-video-replica/scripts/infinite_talk_api.py');
    expect(prompt).toContain('第一项操作必须调用 create_goal');
    expect(prompt).toContain('严禁设置 token budget');
    expect(prompt).toContain('质量优先于 token 用量');
    expect(prompt).toContain('只有第 13-14 条全部通过后才能调用 update_goal(status=complete)');
    expect(prompt).toContain('prepare-assets --source-image');
    expect(prompt).toContain('--width 480 --height 832');
    expect(prompt).toContain('--audio2-mode none');
    expect(prompt).toContain('最终导出尺寸必须为 1920x1080');
    expect(prompt).toContain('禁止用静态图片循环');
    expect(prompt).toContain('InfiniteTalk 没有返回真实 MP4');
    expect(prompt).toContain('禁止运行 env、printenv');
    expect(prompt).toContain('超过 20 秒必须调用 segmented-submit');
    expect(prompt).toContain('--segment-seconds 19.5');
    expect(prompt).toContain('--blocks-to-swap 0');
    expect(prompt).toContain('--poll-seconds 10');
    expect(prompt).toContain('--max-polls 240');
    expect(prompt).toContain('所有风格都不得传入 --hd-enabled');
    expect(prompt).toContain('presenterSegmentPaths 和 infiniteTalkReceiptPaths');
    expect(prompt).toContain('normalize_presenter_segments.py');
    expect(prompt).toContain('presenterRenderPaths');
    expect(prompt).toContain('最终成片不得整段只展示全屏口播人物');
    expect(prompt).toContain('旁白时间戳工具');
    expect(prompt).toContain('必须严格按顺序执行：先完成最终口播文案');
    expect(prompt).toContain('所有分段 prompt_id、视频 SHA-256 均不同');
    expect(prompt).toContain('remotionVisualPath 对应文件也不得含音轨');
    expect(prompt).toContain('narrationTimelinePath');
    expect(prompt).toContain('captionTimelinePath');
    expect(prompt).toContain('data-caption-layer="narration-timeline"');
    expect(prompt).toContain('双向覆盖率都必须 >=95%');
    expect(prompt).toContain('sourceTopic、sourceTranscriptPath、selectedClips');
    expect(prompt).toContain('不得改名为 topic/sourceSections');
    expect(prompt).toContain('narration_visual_map.json');
    expect(prompt).toContain('/skills/ai-presenter-video-replica/scripts/validate_narration_visual_map.py');
    expect(prompt).toContain('/skills/ai-presenter-video-replica/scripts/validate_scene_contract.py');
    expect(prompt).toContain('semanticInventories');
    expect(prompt).toContain('禁止 M1-M5');
    expect(prompt).toContain('layoutRegions');
    expect(prompt).toContain('主内容、字幕、人物互不相交');
    expect(prompt).toContain('入场稳定后、每个短语叠层峰值、退出前');
    expect(prompt).toContain('禁止带错进入付费推理');
    expect(prompt).toContain('严禁把 source-cues、联系表或原片截图作为全屏静态背景');
    expect(prompt).toContain('@remotion/media Video');
    expect(prompt).toContain('data-presenter-layer="infinite-talk"');
    expect(prompt).toContain('FFmpeg 只能用 -c:v copy');
    expect(prompt).toContain('coverApproved、coverScore、coverIssues');
    expect(prompt).toContain('才允许开始 Remotion UI 编排');
    expect(prompt).toContain('禁止让图片/视频生成模型绘制文字');
    expect(prompt).toContain('@remotion/fonts');
    expect(prompt).toContain('Presenter Noto Sans SC');
    expect(prompt).toContain('out/analysis/preflight_report.json');
    expect(prompt).not.toContain('画面默认不生成文字、字幕或 UI');
    expect(prompt).toContain('直接调用 /runtime/remotion/node_modules/.bin/remotion');
    expect(prompt).toContain('Remotion 4.0.490');
    expect(prompt).toContain('严禁改用 FFmpeg drawtext/drawbox');
    expect(prompt).toContain('禁止为追逐 ffprobe 平均码率反复重编码');
    expect(prompt).toContain('清单和上述检查通过后立即结束');
    expect(prompt).toContain('5 秒是系统允许的最长时长上限');
    expect(prompt).toContain('compositionRenderer（固定为 Remotion）');
    expect(prompt).toContain('/skills/remotion-best-practices/SKILL.md');
    expect(prompt).toContain('out/analysis/visual_design.json');
    expect(prompt).toContain('同一帧最多只能出现一个讲解人物');
    expect(prompt).toContain('禁止套通用科技 dashboard');
    expect(prompt).toContain('out/stills/final/review_montage.jpg');
    expect(prompt).toContain('不得结束当前 Codex 会话或交给另一个模型');
    expect(prompt).toContain('out/analysis/visual_review.json');
    expect(prompt).toContain('sceneImplementationPath');
    expect(prompt).toContain('motionReviewFramePaths');
    expect(prompt).toContain('collisionReviewFramePaths');
    expect(prompt).toContain('sceneContractReportPath');
    expect(prompt).toContain('整体和封面 score 都必须 >= 90');
    expect(prompt).toContain('marketingTitle');
    expect(prompt).toContain('out/cover.png');

    const clonePrompt = buildCodexPrompt(
      {...job, mode: 'clone', replicaMode: 'exact', script: '', topic: '嵌入原片录屏', assets: {sourceVideo: '/jobs/job-1/assets/source.mp4'}},
      '/jobs/job-1',
      {
        skillPath: '/skills/ai-presenter-video-replica',
        presenterApiUrl: 'http://presenter:7860',
        presenterComfyUrl: 'http://presenter:8188',
        remotionRuntimeDir: '/runtime/remotion',
        remotionSkillPath: '/skills/remotion-best-practices',
        remotionBrowserExecutable: '/runtime/headless-shell',
        remotionFontDir: '/jobs/job-1/remotion/public/fonts',
        asrBin: '/runtime/whisper-cli',
        asrModel: '/runtime/ggml-small.bin',
        asrLanguage: 'zh',
        asrThreads: 8,
        sourceTranscriptPath: '/jobs/job-1/out/analysis/source_transcript.json',
      },
    );
    expect(clonePrompt).toContain('job.topic 是制作要求，不是口播文案');
    expect(clonePrompt).toContain('完整 1:1 内容复刻');
    expect(clonePrompt).toContain('禁止摘要、合并章节、删除例子');
    expect(clonePrompt).toContain('/jobs/job-1/out/analysis/source_transcript.json');
    expect(clonePrompt).toContain('sourceTranscriptPath 必须原样指向 worker 生成的');
    expect(clonePrompt).toContain('至少 10 张代表帧');
    expect(clonePrompt).toContain('sourceSceneDescription');
    expect(clonePrompt).toContain('sourceReviewFramePaths');
    expect(clonePrompt).toContain('visualType=source_video_pip');
    expect(clonePrompt).toContain('data-source-evidence-layer="source-video-pip"');
    expect(clonePrompt).toContain('不得给普通口播或静态 PPT 滥用原视频 PIP');
    expect(clonePrompt).toContain('网感是独立的全片节奏要求');
    expect(clonePrompt).toContain('约每 3-6 秒安排一次有语义的视觉推进');

    const condensedPrompt = buildCodexPrompt(
      {...job, mode: 'clone', replicaMode: 'condensed', script: '', topic: '', assets: {sourceVideo: '/jobs/job-1/assets/source.mp4'}},
      '/jobs/job-1',
      {
        skillPath: '/skills/ai-presenter-video-replica',
        presenterApiUrl: 'http://presenter:7860',
        presenterComfyUrl: 'http://presenter:8188',
        remotionRuntimeDir: '/runtime/remotion',
        remotionSkillPath: '/skills/remotion-best-practices',
        remotionBrowserExecutable: '/runtime/headless-shell',
        remotionFontDir: '/jobs/job-1/remotion/public/fonts',
        asrBin: '/runtime/whisper-cli',
        asrModel: '/runtime/ggml-small.bin',
        asrLanguage: 'zh',
        asrThreads: 8,
        sourceTranscriptPath: '/jobs/job-1/out/analysis/source_transcript.json',
      },
    );
    expect(condensedPrompt).toContain('执行精简复刻');
    expect(condensedPrompt).toContain('允许主动删除次要观点');
    expect(condensedPrompt).toContain('不要求覆盖原片全部观点');
    expect(condensedPrompt).toContain('语义完整的开场钩子');
    expect(condensedPrompt).toContain('有短视频网感');

    const presenterPrimaryPrompt = buildCodexPrompt(
      {...job, style: '真人主画面·悬浮组件'},
      '/jobs/job-1',
      {
        skillPath: '/skills/ai-presenter-video-replica',
        presenterApiUrl: 'http://presenter:7860',
        presenterComfyUrl: 'http://presenter:8188',
        remotionRuntimeDir: '/runtime/remotion',
        remotionSkillPath: '/skills/remotion-best-practices',
        remotionBrowserExecutable: '/runtime/headless-shell',
        remotionFontDir: '/jobs/job-1/remotion/public/fonts',
        asrBin: '/runtime/whisper-cli',
        asrModel: '/runtime/ggml-small.bin',
        asrLanguage: 'zh',
        asrThreads: 8,
        sourceTranscriptPath: undefined,
      },
    );
    expect(presenterPrimaryPrompt).toContain('--width 832 --height 480');
    expect(presenterPrimaryPrompt).toContain('--layout landscape --width 1248 --height 720');
    expect(presenterPrimaryPrompt).not.toContain('--hd-enabled --hd-res 720');
    expect(presenterPrimaryPrompt).toContain('/checkpoints/infinite_talk');
    expect(presenterPrimaryPrompt).toContain('832x480 输出尺寸');
    expect(presenterPrimaryPrompt).toContain('avatarImage（/jobs/job-1/assets/avatar.jpg）是唯一人物身份来源');
    expect(presenterPrimaryPrompt).toContain('prepare-assets --source-image "/jobs/job-1/assets/avatar.jpg"');
    expect(presenterPrimaryPrompt).toContain('data-layout-style="presenter-primary-floating-ui"');
    expect(presenterPrimaryPrompt).toContain('每帧最多同时出现一个主组件和一个次组件');
    expect(presenterPrimaryPrompt).toContain('不得退回角落圆形 PIP');

    const portraitPresenterPrimaryPrompt = buildCodexPrompt(
      {...job, aspectRatio: '9:16', style: '真人主画面·悬浮组件'},
      '/jobs/job-1',
      {
        skillPath: '/skills/ai-presenter-video-replica',
        presenterApiUrl: 'http://presenter:7860',
        presenterComfyUrl: 'http://presenter:8188',
        remotionRuntimeDir: '/runtime/remotion',
        remotionSkillPath: '/skills/remotion-best-practices',
        remotionBrowserExecutable: '/runtime/headless-shell',
        remotionFontDir: '/jobs/job-1/remotion/public/fonts',
        asrBin: '/runtime/whisper-cli',
        asrModel: '/runtime/ggml-small.bin',
        asrLanguage: 'zh',
        asrThreads: 8,
        sourceTranscriptPath: undefined,
      },
    );
    expect(portraitPresenterPrimaryPrompt).toContain('--width 480 --height 832');
    expect(portraitPresenterPrimaryPrompt).toContain('--layout portrait --width 720 --height 1248');
    expect(portraitPresenterPrimaryPrompt).toContain('480x832 输出尺寸');

    const avatarCanvasPrompt = buildCodexPrompt(
      {
        ...job,
        aspectRatio: 'avatar',
        style: '真人主画面·悬浮组件',
        metadata: {avatarDimensions: {width: 3024, height: 4032}},
      },
      '/jobs/job-1',
      {
        skillPath: '/skills/ai-presenter-video-replica',
        presenterApiUrl: 'http://presenter:7860',
        presenterComfyUrl: 'http://presenter:8188',
        remotionRuntimeDir: '/runtime/remotion',
        remotionSkillPath: '/skills/remotion-best-practices',
        remotionBrowserExecutable: '/runtime/headless-shell',
        remotionFontDir: '/jobs/job-1/remotion/public/fonts',
        asrBin: '/runtime/whisper-cli',
        asrModel: '/runtime/ggml-small.bin',
        asrLanguage: 'zh',
        asrThreads: 8,
        sourceTranscriptPath: undefined,
      },
    );
    expect(avatarCanvasPrompt).toContain('最终画布跟随上传人物图：原图 3024x4032');
    expect(avatarCanvasPrompt).toContain('最终导出尺寸必须为 3024x4032');
    expect(avatarCanvasPrompt).toContain('--width 544 --height 736');
  });
});
