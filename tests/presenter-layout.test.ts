import {describe, expect, it} from 'vitest';
import {calculateModelDimensions, resolvePresenterLayout} from '../server/presenter-layout.js';

describe('presenter layout', () => {
  it('keeps lip inference near 480P while following a portrait source', () => {
    const layout = resolvePresenterLayout({
      aspectRatio: 'avatar',
      style: '真人主画面·悬浮组件',
      metadata: {avatarDimensions: {width: 3024, height: 4032}},
    });
    expect(layout.final).toEqual({width: 3024, height: 4032});
    expect(layout.model.width % 16).toBe(0);
    expect(layout.model.height % 16).toBe(0);
    expect(layout.model.width * layout.model.height).toBeLessThan(450_000);
    expect(layout.normalized.width).toBe(720);
    expect(layout.normalizationLayout).toBe('portrait');
  });

  it('pads odd final dimensions by one pixel for H.264', () => {
    const layout = resolvePresenterLayout({
      aspectRatio: 'avatar',
      style: '真人主画面·悬浮组件',
      metadata: {avatarDimensions: {width: 1081, height: 1921}},
    });
    expect(layout.final).toEqual({width: 1082, height: 1922});
  });

  it('preserves existing fixed layouts', () => {
    const layout = resolvePresenterLayout({
      aspectRatio: '16:9',
      style: '真人主画面·悬浮组件',
      metadata: {},
    });
    expect(layout.final).toEqual({width: 1920, height: 1080});
    expect(layout.model).toEqual({width: 832, height: 480});
    expect(layout.normalized).toEqual({width: 1248, height: 720});
  });

  it('keeps arbitrary model canvases divisible by 16', () => {
    const dimensions = calculateModelDimensions({width: 1000, height: 1000});
    expect(dimensions.width % 16).toBe(0);
    expect(dimensions.height % 16).toBe(0);
    expect(dimensions.width).toBe(dimensions.height);
  });

  it('rejects avatar-follow jobs without probed dimensions', () => {
    expect(() =>
      resolvePresenterLayout({aspectRatio: 'avatar', style: '真人主画面·悬浮组件', metadata: {}}),
    ).toThrow('缺少有效的原图尺寸');
  });
});
