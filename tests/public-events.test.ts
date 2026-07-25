import {describe, expect, it} from 'vitest';
import {isUserFacingEvent, publicEvents} from '../server/public-events.js';
import type {JobEvent} from '../server/types.js';

const event = (id: number, kind: string, message: string, data: Record<string, unknown> = {}): JobEvent => ({
  id,
  jobId: 'job-1',
  level: 'info',
  kind,
  message,
  data,
  createdAt: '2026-07-17T00:00:00.000Z',
});

describe('publicEvents', () => {
  it('keeps assistant updates and platform milestones but hides Codex tool activity', () => {
    const visible = publicEvents([
      event(1, 'queued', '任务已进入队列'),
      event(2, 'item.started', '/bin/bash -lc ffprobe source.mp4', {itemType: 'command_execution'}),
      event(3, 'item.completed', '/bin/bash -lc ffprobe source.mp4', {itemType: 'command_execution'}),
      event(4, 'item.completed', '正在核对旁白与画面时间轴。', {itemType: 'agent_message'}),
      event(5, 'codex_output', '{not-json}'),
      event(6, 'presenter_segment_progress', '数字人口型片段已完成 5/7'),
      event(7, 'codex_start', 'Codex worker 已启动，模型 internal-model'),
      event(8, 'turn.failed', 'raw internal failure'),
    ]);

    expect(visible.map(({id, message}) => ({id, message}))).toEqual([
      {id: 1, message: '任务已进入队列'},
      {id: 4, message: '正在核对旁白与画面时间轴。'},
      {id: 6, message: '数字人口型片段已完成 5/7'},
    ]);
    expect(visible.every((entry) => !('data' in entry))).toBe(true);
  });

  it('hides historical untyped item.completed events instead of leaking commands', () => {
    expect(publicEvents([event(1, 'item.completed', 'ffmpeg -i source.mp4 out.mp4')])).toEqual([]);
  });

  it('exposes the same filter for the administrator event stream', () => {
    expect(isUserFacingEvent(event(1, 'item.completed', 'python3 internal.py', {itemType: 'command_execution'}))).toBe(false);
    expect(isUserFacingEvent(event(2, 'presenter_upscale_progress', '数字人高清增强 9/24'))).toBe(true);
  });
});
