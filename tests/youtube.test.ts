import {describe, expect, it} from 'vitest';
import {
  filterAndSortYouTubeVideos,
  parseIsoDurationSeconds,
  parseYouTubeUrl,
  youtubeApiDurationFilter,
  ytDlpMatchFilter,
  type YouTubeVideo,
} from '../server/youtube.js';

describe('YouTube helpers', () => {
  it('accepts canonical, short, and Shorts URLs', () => {
    expect(parseYouTubeUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ')).toEqual({
      id: 'dQw4w9WgXcQ',
      url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
    });
    expect(parseYouTubeUrl('https://youtu.be/dQw4w9WgXcQ?t=12').id).toBe('dQw4w9WgXcQ');
    expect(parseYouTubeUrl('https://youtube.com/shorts/dQw4w9WgXcQ').id).toBe('dQw4w9WgXcQ');
  });

  it('rejects non-YouTube and playlist-only URLs', () => {
    expect(() => parseYouTubeUrl('https://example.com/watch?v=dQw4w9WgXcQ')).toThrow('只支持公开的 YouTube 单条视频链接');
    expect(() => parseYouTubeUrl('https://youtube.com/playlist?list=abc')).toThrow('只支持公开的 YouTube 单条视频链接');
  });

  it('parses ISO 8601 video durations', () => {
    expect(parseIsoDurationSeconds('PT14M27S')).toBe(867);
    expect(parseIsoDurationSeconds('PT1H2M3S')).toBe(3723);
    expect(parseIsoDurationSeconds('invalid')).toBe(0);
  });

  it('filters duration and popularity, then applies the requested ranking', () => {
    const video = (id: string, durationSeconds: number, viewCount: number, daily: number, date: string): YouTubeVideo => ({
      id: id.padEnd(11, 'x').slice(0, 11),
      title: id,
      channelTitle: 'channel',
      thumbnailUrl: '',
      durationSeconds,
      viewCount,
      viewsPerDay: daily,
      publishedAt: date,
      license: 'unknown',
      url: '',
    });
    const videos = [
      video('old-hit', 240, 2_000_000, 8_000, '2025-01-01T00:00:00Z'),
      video('new-fast', 180, 300_000, 60_000, '2026-07-01T00:00:00Z'),
      video('long', 1_200, 5_000_000, 80_000, '2026-06-01T00:00:00Z'),
    ];
    expect(filterAndSortYouTubeVideos(videos, {duration: '1to5', minViews: 100_000, minViewsPerDay: 10_000, sort: 'velocity'}).map((item) => item.title)).toEqual(['new-fast']);
    expect(filterAndSortYouTubeVideos(videos, {sort: 'views'}).map((item) => item.title)).toEqual(['long', 'old-hit', 'new-fast']);
    expect(filterAndSortYouTubeVideos(videos, {sort: 'newest'}).map((item) => item.title)).toEqual(['new-fast', 'long', 'old-hit']);
  });

  it('pushes supported duration and popularity filters upstream', () => {
    expect(youtubeApiDurationFilter('short')).toBe('short');
    expect(youtubeApiDurationFilter('5to15')).toBe('medium');
    expect(youtubeApiDurationFilter('1to5')).toBe('any');
    expect(ytDlpMatchFilter({duration: '5to15', minViews: 100_000, minViewsPerDay: 10_000})).toBe(
      '!is_live & duration >= 301 & duration <= 900 & view_count >= 100000',
    );
  });
});
