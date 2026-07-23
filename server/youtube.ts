import {spawn} from 'node:child_process';
import {existsSync, mkdirSync, readFileSync, readdirSync, renameSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';

export type YouTubeVideo = {
  id: string;
  title: string;
  channelTitle: string;
  thumbnailUrl: string;
  durationSeconds: number;
  viewCount: number;
  publishedAt: string;
  license: 'creativeCommon' | 'youtube' | 'unknown';
  url: string;
  viewsPerDay: number;
};

export type YouTubeImport = {
  id: string;
  sourcePath: string;
  video: YouTubeVideo;
};

export type YouTubeDurationFilter = 'any' | 'short' | '1to5' | '5to15' | '15to30';
export type YouTubeSort = 'velocity' | 'views' | 'newest';
export type YouTubeSearchFilters = {
  duration?: YouTubeDurationFilter;
  minViews?: number;
  minViewsPerDay?: number;
  sort?: YouTubeSort;
};

export const youtubeApiDurationFilter = (duration: YouTubeDurationFilter): 'any' | 'short' | 'medium' => {
  if (duration === 'short') return 'short';
  if (duration === '5to15') return 'medium';
  return 'any';
};

export const ytDlpMatchFilter = (filters: YouTubeSearchFilters): string => {
  const conditions: string[] = ['!is_live'];
  const ranges: Partial<Record<YouTubeDurationFilter, [number, number]>> = {
    short: [0, 60],
    '1to5': [61, 300],
    '5to15': [301, 900],
    '15to30': [901, 1800],
  };
  const range = filters.duration ? ranges[filters.duration] : undefined;
  if (range) conditions.push(`duration >= ${range[0]}`, `duration <= ${range[1]}`);
  if ((filters.minViews ?? 0) > 0) conditions.push(`view_count >= ${Math.floor(filters.minViews!)}`);
  return conditions.join(' & ');
};

type CommandResult = {stdout: string; stderr: string};

const run = (
  command: string,
  args: string[],
  options: {timeoutMs: number; maxOutputBytes?: number},
): Promise<CommandResult> =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, {stdio: ['ignore', 'pipe', 'pipe']});
    const chunks: Buffer[] = [];
    const errorChunks: Buffer[] = [];
    let outputBytes = 0;
    const maximum = options.maxOutputBytes ?? 16 * 1024 * 1024;
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      reject(new Error('YouTube 请求超时，请稍后重试'));
    }, options.timeoutMs);
    child.stdout.on('data', (chunk: Buffer) => {
      outputBytes += chunk.length;
      if (outputBytes <= maximum) chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (errorChunks.reduce((sum, item) => sum + item.length, 0) < 256 * 1024) errorChunks.push(chunk);
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      const stdout = Buffer.concat(chunks).toString('utf8');
      const stderr = Buffer.concat(errorChunks).toString('utf8');
      if (code === 0) resolve({stdout, stderr});
      else reject(new Error(`YouTube 导入失败：${stderr.trim().slice(-500) || `yt-dlp exited ${code}`}`));
    });
  });

export const parseIsoDurationSeconds = (value: string): number => {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/.exec(value);
  if (!match) return 0;
  return Math.round(
    Number(match[1] ?? 0) * 86_400 +
      Number(match[2] ?? 0) * 3_600 +
      Number(match[3] ?? 0) * 60 +
      Number(match[4] ?? 0),
  );
};

const viewsPerDay = (viewCount: number, publishedAt: string): number => {
  const ageDays = Math.max(1, (Date.now() - new Date(publishedAt).getTime()) / 86_400_000);
  return Math.round(viewCount / ageDays);
};

export const filterAndSortYouTubeVideos = (
  videos: YouTubeVideo[],
  filters: YouTubeSearchFilters = {},
): YouTubeVideo[] => {
  const duration = filters.duration ?? 'any';
  const durationRanges: Record<YouTubeDurationFilter, [number, number]> = {
    any: [0, Number.POSITIVE_INFINITY],
    short: [0, 60],
    '1to5': [61, 300],
    '5to15': [301, 900],
    '15to30': [901, 1800],
  };
  const [minimumDuration, maximumDuration] = durationRanges[duration] ?? durationRanges.any;
  const minimumViews = Math.max(0, filters.minViews ?? 0);
  const minimumVelocity = Math.max(0, filters.minViewsPerDay ?? 0);
  const sort = filters.sort ?? 'velocity';
  return videos
    .filter((video) => video.durationSeconds >= minimumDuration && video.durationSeconds <= maximumDuration)
    .filter((video) => video.viewCount >= minimumViews && video.viewsPerDay >= minimumVelocity)
    .sort((left, right) => {
      if (sort === 'views') return right.viewCount - left.viewCount;
      if (sort === 'newest') return new Date(right.publishedAt).getTime() - new Date(left.publishedAt).getTime();
      return right.viewsPerDay - left.viewsPerDay;
    });
};

export const parseYouTubeUrl = (raw: string): {id: string; url: string} => {
  let input: URL;
  try {
    input = new URL(raw.trim());
  } catch {
    throw new Error('请输入有效的 YouTube 视频链接');
  }
  const host = input.hostname.toLowerCase().replace(/^www\./, '');
  let id = '';
  if (host === 'youtu.be') id = input.pathname.split('/').filter(Boolean)[0] ?? '';
  if (['youtube.com', 'm.youtube.com', 'music.youtube.com'].includes(host)) {
    if (input.pathname === '/watch') id = input.searchParams.get('v') ?? '';
    else if (/^\/(shorts|embed)\//.test(input.pathname)) id = input.pathname.split('/')[2] ?? '';
  }
  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) throw new Error('只支持公开的 YouTube 单条视频链接');
  return {id, url: `https://www.youtube.com/watch?v=${id}`};
};

const mapYtDlpEntry = (entry: Record<string, unknown>): YouTubeVideo | null => {
  const id = String(entry.id ?? '').trim();
  if (!/^[A-Za-z0-9_-]{11}$/.test(id)) return null;
  const viewCount = Math.max(0, Number(entry.view_count ?? entry.viewCount ?? 0) || 0);
  const timestamp = Number(entry.timestamp ?? 0);
  const publishedAt = timestamp > 0
    ? new Date(timestamp * 1000).toISOString()
    : /^\d{8}$/.test(String(entry.upload_date ?? ''))
      ? new Date(`${String(entry.upload_date).slice(0, 4)}-${String(entry.upload_date).slice(4, 6)}-${String(entry.upload_date).slice(6, 8)}T00:00:00Z`).toISOString()
      : new Date().toISOString();
  const thumbnailUrl = String(entry.thumbnail ?? `https://i.ytimg.com/vi/${id}/hqdefault.jpg`);
  return {
    id,
    title: String(entry.title ?? 'YouTube 视频'),
    channelTitle: String(entry.channel ?? entry.uploader ?? ''),
    thumbnailUrl,
    durationSeconds: Math.max(0, Math.ceil(Number(entry.duration ?? 0) || 0)),
    viewCount,
    publishedAt,
    license: String(entry.license ?? '').toLowerCase().includes('creative commons') ? 'creativeCommon' : 'unknown',
    url: `https://www.youtube.com/watch?v=${id}`,
    viewsPerDay: viewsPerDay(viewCount, publishedAt),
  };
};

export class YouTubeService {
  constructor(
    private readonly options: {
      apiKey: string;
      bin: string;
      ffmpegBin: string;
      proxyUrl: string;
      importsDir: string;
      candidateLimit: number;
      expandedCandidateLimit: number;
      searchTimeoutMs: number;
      importTimeoutMs: number;
      maxDurationSeconds: number;
    },
  ) {
    mkdirSync(options.importsDir, {recursive: true});
  }

  private ytDlpArgs(args: string[]): string[] {
    const prefix: string[] = [];
    if (this.options.ffmpegBin) prefix.push('--ffmpeg-location', this.options.ffmpegBin);
    if (this.options.proxyUrl) prefix.push('--proxy', this.options.proxyUrl);
    return [...prefix, ...args];
  }

  async search(
    keyword: string,
    days = 90,
    license: 'creativeCommon' | 'any' = 'creativeCommon',
    filters: YouTubeSearchFilters = {},
  ): Promise<YouTubeVideo[]> {
    const query = keyword.trim();
    if (query.length < 2 || query.length > 100) throw new Error('搜索关键词需要 2-100 个字符');
    const safeDays = [7, 30, 90, 365].includes(days) ? days : 90;
    if (!this.options.apiKey) return filterAndSortYouTubeVideos(await this.searchWithYtDlp(query, safeDays, license, filters), filters);

    const publishedAfter = new Date(Date.now() - safeDays * 86_400_000).toISOString();
    const searchParams = new URLSearchParams({
      key: this.options.apiKey,
      part: 'snippet',
      type: 'video',
      maxResults: String(this.options.candidateLimit),
      order: filters.sort === 'newest' ? 'date' : 'viewCount',
      q: query,
      publishedAfter,
      safeSearch: 'strict',
      videoEmbeddable: 'true',
      videoDuration: youtubeApiDurationFilter(filters.duration ?? 'any'),
    });
    if (license === 'creativeCommon') searchParams.set('videoLicense', 'creativeCommon');
    const searchResponse = await fetch(`https://www.googleapis.com/youtube/v3/search?${searchParams}`, {
      signal: AbortSignal.timeout(this.options.searchTimeoutMs),
    });
    if (!searchResponse.ok) throw new Error(`YouTube 搜索失败 (${searchResponse.status})`);
    const searchData = (await searchResponse.json()) as {items?: Array<{id?: {videoId?: string}}>};
    const ids = (searchData.items ?? []).map((item) => item.id?.videoId ?? '').filter(Boolean);
    if (!ids.length) return [];

    const detailParams = new URLSearchParams({
      key: this.options.apiKey,
      part: 'snippet,statistics,contentDetails,status',
      id: ids.join(','),
    });
    const detailResponse = await fetch(`https://www.googleapis.com/youtube/v3/videos?${detailParams}`, {
      signal: AbortSignal.timeout(this.options.searchTimeoutMs),
    });
    if (!detailResponse.ok) throw new Error(`YouTube 视频信息读取失败 (${detailResponse.status})`);
    const detailData = (await detailResponse.json()) as {
      items?: Array<{
        id?: string;
        snippet?: {title?: string; channelTitle?: string; publishedAt?: string; thumbnails?: {high?: {url?: string}; medium?: {url?: string}}};
        statistics?: {viewCount?: string};
        contentDetails?: {duration?: string};
        status?: {license?: string};
      }>;
    };
    return filterAndSortYouTubeVideos((detailData.items ?? [])
      .map((item): YouTubeVideo | null => {
        const id = item.id ?? '';
        if (!id) return null;
        const viewCount = Number(item.statistics?.viewCount ?? 0) || 0;
        const publishedAt = item.snippet?.publishedAt ?? new Date().toISOString();
        return {
          id,
          title: item.snippet?.title ?? 'YouTube 视频',
          channelTitle: item.snippet?.channelTitle ?? '',
          thumbnailUrl: item.snippet?.thumbnails?.high?.url ?? item.snippet?.thumbnails?.medium?.url ?? `https://i.ytimg.com/vi/${id}/hqdefault.jpg`,
          durationSeconds: parseIsoDurationSeconds(item.contentDetails?.duration ?? ''),
          viewCount,
          publishedAt,
          license: item.status?.license === 'creativeCommon' ? 'creativeCommon' : 'youtube',
          url: `https://www.youtube.com/watch?v=${id}`,
          viewsPerDay: viewsPerDay(viewCount, publishedAt),
        };
      })
      .filter((item): item is YouTubeVideo => Boolean(item))
      .filter((item) => item.durationSeconds > 0 && item.durationSeconds <= this.options.maxDurationSeconds), filters);
  }

  private async searchWithYtDlp(
    keyword: string,
    days: number,
    license: 'creativeCommon' | 'any',
    filters: YouTubeSearchFilters,
  ): Promise<YouTubeVideo[]> {
    const restrictive =
      days < 365 ||
      (filters.duration ?? 'any') !== 'any' ||
      (filters.minViews ?? 0) > 0 ||
      (filters.minViewsPerDay ?? 0) > 0;
    const candidateLimit = restrictive ? this.options.expandedCandidateLimit : this.options.candidateLimit;
    const result = await run(
      this.options.bin,
      this.ytDlpArgs([
        '--dump-single-json',
        '--flat-playlist',
        '--skip-download',
        '--no-warnings',
        '--extractor-args',
        'youtubetab:approximate_date',
        '--dateafter',
        `now-${days}days`,
        '--match-filters',
        ytDlpMatchFilter(filters),
        '--compat-options',
        'playlist-match-filter',
        `ytsearch${candidateLimit}:${keyword}`,
      ]),
      {timeoutMs: this.options.searchTimeoutMs},
    );
    const data = JSON.parse(result.stdout) as {entries?: Array<Record<string, unknown>>};
    const cutoff = Date.now() - days * 86_400_000;
    return (data.entries ?? [])
      .map(mapYtDlpEntry)
      .filter((item): item is YouTubeVideo => Boolean(item))
      .filter((item) => new Date(item.publishedAt).getTime() >= cutoff)
      .filter((item) => item.durationSeconds <= this.options.maxDurationSeconds)
      .filter((item) => license === 'any' || item.license !== 'youtube');
  }

  async importVideo(rawUrl: string): Promise<YouTubeImport> {
    const parsed = parseYouTubeUrl(rawUrl);
    const metadataResult = await run(
      this.options.bin,
      this.ytDlpArgs(['--dump-single-json', '--skip-download', '--no-playlist', '--no-warnings', parsed.url]),
      {timeoutMs: this.options.searchTimeoutMs},
    );
    const metadata = mapYtDlpEntry(JSON.parse(metadataResult.stdout) as Record<string, unknown>);
    if (!metadata) throw new Error('无法读取该 YouTube 视频信息');
    if (metadata.durationSeconds <= 0 || metadata.durationSeconds > this.options.maxDurationSeconds) {
      throw new Error(`YouTube 原片最长 ${Math.round(this.options.maxDurationSeconds / 60)} 分钟`);
    }

    const id = randomUUID();
    const destination = path.join(this.options.importsDir, id);
    mkdirSync(destination, {recursive: true});
    const outputTemplate = path.join(destination, 'source.%(ext)s');
    await run(
      this.options.bin,
      this.ytDlpArgs([
        '--no-playlist',
        '--no-warnings',
        '--format',
        'bv*[height<=1080]+ba/b[height<=1080]',
        '--merge-output-format',
        'mp4',
        '--remux-video',
        'mp4',
        '--output',
        outputTemplate,
        parsed.url,
      ]),
      {timeoutMs: this.options.importTimeoutMs, maxOutputBytes: 2 * 1024 * 1024},
    );
    const downloaded = readdirSync(destination)
      .map((name) => path.join(destination, name))
      .find((candidate) => /^source\.(mp4|mkv|webm|mov)$/i.test(path.basename(candidate)) && existsSync(candidate));
    if (!downloaded) throw new Error('YouTube 视频下载完成但未找到媒体文件');
    const sourcePath = path.join(destination, 'source.mp4');
    if (downloaded !== sourcePath) renameSync(downloaded, sourcePath);
    writeFileSync(path.join(destination, 'metadata.json'), JSON.stringify({id, video: metadata}, null, 2));
    return {id, sourcePath, video: metadata};
  }

  getImport(id: string): YouTubeImport {
    if (!/^[0-9a-f-]{36}$/i.test(id)) throw new Error('YouTube 导入记录无效');
    const directory = path.join(this.options.importsDir, id);
    const sourcePath = path.join(directory, 'source.mp4');
    const metadataPath = path.join(directory, 'metadata.json');
    if (!existsSync(sourcePath) || !existsSync(metadataPath)) throw new Error('YouTube 导入记录不存在或已过期');
    const manifest = JSON.parse(readFileSync(metadataPath, 'utf8')) as {video?: YouTubeVideo};
    if (!manifest.video) throw new Error('YouTube 导入记录损坏');
    return {id, sourcePath, video: manifest.video};
  }
}
