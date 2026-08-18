/**
 * jarvis/importers/youtube_channel_collector.js
 * YouTube Channel & Video Analytics Collector（Phase 7）
 *
 * 2026-08-24 YouTube view-count update:
 * - views: 新しい公開視聴回数ロジック
 * - engagedViews: 旧ロジック相当のエンゲージビュー
 *
 * engagedViews は 2026-08-24 以降に要求する。ロールアウト直後など API 側で
 * 未対応の場合は従来 metrics に自動フォールバックし、収集全体を止めない。
 */

import {
  REQUIRED_ENV_VARS,
  getYouTubeConfig,
  refreshAccessToken,
  fetchYouTubeReport,
} from './youtube_collector.js';

export { REQUIRED_ENV_VARS, getYouTubeConfig, refreshAccessToken, fetchYouTubeReport };

const YOUTUBE_ANALYTICS_URL = 'https://youtubeanalytics.googleapis.com/v2/reports';
const YOUTUBE_DATA_URL      = 'https://www.googleapis.com/youtube/v3';
export const ENGAGED_VIEWS_ROLLOUT_DATE = '2026-08-24';

export function shouldRequestEngagedViews(now = new Date()) {
  const date = now instanceof Date ? now.toISOString().slice(0, 10) : String(now).slice(0, 10);
  return date >= ENGAGED_VIEWS_ROLLOUT_DATE;
}

function addEngagedViewsMetric(metrics, now = new Date()) {
  const list = Array.isArray(metrics) ? [...metrics] : String(metrics).split(',').filter(Boolean);
  if (shouldRequestEngagedViews(now) && !list.includes('engagedViews')) {
    const viewsIndex = list.indexOf('views');
    list.splice(viewsIndex >= 0 ? viewsIndex + 1 : 0, 0, 'engagedViews');
  }
  return list;
}

function isEngagedViewsCompatibilityError(errorText) {
  const text = String(errorText || '');
  return /engagedViews/i.test(text) && /(invalid|unsupported|unknown|not available|not supported|400)/i.test(text);
}

async function fetchReportWithEngagedViewsFallback(args, baseMetrics) {
  const metrics = addEngagedViewsMetric(baseMetrics);
  try {
    return await fetchYouTubeReport({ ...args, metrics: metrics.join(',') });
  } catch (e) {
    if (metrics.includes('engagedViews') && isEngagedViewsCompatibilityError(e?.message)) {
      return fetchYouTubeReport({ ...args, metrics: baseMetrics.join(',') });
    }
    throw e;
  }
}

async function fetchAnalyticsUrlWithEngagedViewsFallback({ accessToken, params, baseMetrics, errorLabel }) {
  const request = async (metrics) => {
    const next = new URLSearchParams(params);
    next.set('metrics', metrics.join(','));
    const url = `${YOUTUBE_ANALYTICS_URL}?${next}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (!res.ok) {
      const body = await res.text();
      const error = new Error(`${errorLabel}: ${res.status} ${body}`);
      error.status = res.status;
      throw error;
    }
    return res.json();
  };

  const metrics = addEngagedViewsMetric(baseMetrics);
  try {
    return await request(metrics);
  } catch (e) {
    if (metrics.includes('engagedViews') && isEngagedViewsCompatibilityError(e?.message)) {
      return request(baseMetrics);
    }
    throw e;
  }
}

export async function fetchChannelStats({ accessToken }) {
  const params = new URLSearchParams({ mine: 'true', part: 'statistics,snippet' });
  const url = `${YOUTUBE_DATA_URL}/channels?${params}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`YouTube Data API (channels) error: ${res.status} ${body}`);
  }
  return res.json();
}

export async function fetchChannelAnalytics({ accessToken, channelId, startDate, endDate }) {
  const baseMetrics = [
    'views',
    'estimatedMinutesWatched',
    'averageViewDuration',
    'subscribersGained',
    'subscribersLost',
  ];
  try {
    return await fetchReportWithEngagedViewsFallback({
      accessToken,
      channelId,
      startDate,
      endDate,
      dimensions: 'day',
    }, baseMetrics);
  } catch (e) {
    throw new Error(`YouTube Analytics (channel) error: ${e.message}`);
  }
}

export async function fetchVideoAnalytics({ accessToken, channelId, startDate, endDate }) {
  const params = new URLSearchParams({
    ids:        `channel==${channelId}`,
    startDate,
    endDate,
    dimensions: 'video',
    sort:       '-views',
    maxResults: '50',
  });
  const baseMetrics = [
    'views',
    'estimatedMinutesWatched',
    'averageViewDuration',
    'averageViewPercentage',
    'likes',
    'comments',
    'shares',
    'subscribersGained',
    'subscribersLost',
  ];
  return fetchAnalyticsUrlWithEngagedViewsFallback({
    accessToken,
    params,
    baseMetrics,
    errorLabel: 'YouTube Analytics (videos) error',
  });
}

export async function fetchTrafficSources({ accessToken, channelId, startDate, endDate }) {
  const baseMetrics = ['views', 'estimatedMinutesWatched'];
  try {
    return await fetchReportWithEngagedViewsFallback({
      accessToken,
      channelId,
      startDate,
      endDate,
      dimensions: 'insightTrafficSourceType',
    }, baseMetrics);
  } catch (e) {
    throw new Error(`YouTube Analytics (traffic sources) error: ${e.message}`);
  }
}

export async function fetchDataVideos({ accessToken }, videoIds) {
  if (!videoIds || videoIds.length === 0) return { items: [] };
  const params = new URLSearchParams({
    id:   videoIds.slice(0, 50).join(','),
    part: 'snippet,contentDetails',
  });
  const url = `${YOUTUBE_DATA_URL}/videos?${params}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`YouTube Data API (videos) error: ${res.status} ${body}`);
  }
  return res.json();
}

export function buildChannelSnapshots(analyticsResponse, subscribersCount = null, today = null) {
  if (!analyticsResponse?.rows?.length) return [];
  if (!Array.isArray(analyticsResponse.columnHeaders)) return [];

  const cols = analyticsResponse.columnHeaders.map(h => h.name);
  const dayIdx = cols.indexOf('day');
  if (dayIdx < 0) return [];
  const idx = name => cols.indexOf(name);
  const num = (row, name) => {
    const i = idx(name);
    if (i < 0 || row[i] == null) return null;
    const value = Number(row[i]);
    return isFinite(value) ? value : null;
  };

  return analyticsResponse.rows.map(row => {
    const date = row[dayIdx];
    if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) return null;
    const avd = num(row, 'averageViewDuration');
    return {
      date,
      subscribers_count:         subscribersCount !== null && date === today ? subscribersCount : null,
      subscribers_gained:        num(row, 'subscribersGained'),
      subscribers_lost:          num(row, 'subscribersLost'),
      views:                     num(row, 'views'),
      engaged_views:             num(row, 'engagedViews'),
      estimated_minutes_watched: num(row, 'estimatedMinutesWatched'),
      average_view_duration_sec: avd !== null ? Math.round(avd) : null,
      impressions: null,
      ctr: null,
    };
  }).filter(Boolean);
}

export function buildVideoEntry(videoData) {
  if (!videoData?.videoId) throw new Error('buildVideoEntry: videoId が必要です');
  const validTypes = ['video', 'short'];
  const contentType = validTypes.includes(videoData.content_type) ? videoData.content_type : 'video';
  return {
    platform: 'youtube',
    content_type: contentType,
    platform_id: videoData.videoId,
    title: videoData.title ?? null,
    published_at: videoData.publishedAt ?? null,
    duration_sec: videoData.duration_sec ?? null,
  };
}

export function buildVideoSnapshot(rawRow, columnNames, contentRegId, date) {
  if (!contentRegId) throw new Error('buildVideoSnapshot: contentRegId が必要です');
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`buildVideoSnapshot: 不正な date: ${date}`);
  }
  const get = name => {
    const i = columnNames.indexOf(name);
    return i >= 0 && rawRow[i] != null ? rawRow[i] : null;
  };
  const num = name => {
    const value = get(name);
    if (value === null) return null;
    const n = Number(value);
    return isFinite(n) ? n : null;
  };
  const avp = num('averageViewPercentage');
  return {
    content_reg_id: contentRegId,
    snapshot_date: date,
    views: num('views'),
    likes: num('likes'),
    comments: num('comments'),
    shares: num('shares'),
    watch_time_min: num('estimatedMinutesWatched'),
    avg_watch_sec: num('averageViewDuration'),
    completion_rate: avp !== null ? avp / 100 : null,
  };
}

export function buildVideoExtMetrics(rawRow, columnNames) {
  const result = [];
  const get = name => {
    const i = columnNames.indexOf(name);
    if (i < 0 || rawRow[i] == null) return null;
    const value = Number(rawRow[i]);
    return isFinite(value) ? value : null;
  };
  const pairs = [
    ['averageViewPercentage', 'avg_view_percentage'],
    ['engagedViews', 'engaged_views'],
    ['subscribersGained', 'subscribers_gained'],
    ['subscribersLost', 'subscribers_lost'],
  ];
  for (const [metric, key] of pairs) {
    const value = get(metric);
    if (value !== null) result.push({ key, value_num: value, value_text: null });
  }
  return result;
}

export function parseDuration(duration) {
  if (!duration || typeof duration !== 'string') return null;
  const match = duration.match(/^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/);
  if (!match) return null;
  const h = parseInt(match[1] || '0', 10);
  const m = parseInt(match[2] || '0', 10);
  const s = parseInt(match[3] || '0', 10);
  const total = h * 3600 + m * 60 + s;
  return total > 0 ? total : null;
}

function ensureColumn(db, tableName, columnName, definition) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all();
  if (!columns.some(column => column.name === columnName)) {
    db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }
}

export function ensureYouTubeEngagedViewsSchema(db) {
  ensureColumn(db, 'sf_youtube_channel_daily', 'engaged_views', 'INTEGER');
  ensureColumn(db, 'sf_youtube_traffic_sources', 'engaged_views', 'INTEGER');
}

export function writeChannelDaily(db, row) {
  try {
    ensureYouTubeEngagedViewsSchema(db);
    db.prepare(`
      INSERT INTO sf_youtube_channel_daily
        (date, subscribers_count, subscribers_gained, subscribers_lost,
         views, engaged_views, estimated_minutes_watched, average_view_duration_sec,
         impressions, ctr, import_source, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'api', datetime('now','localtime'))
      ON CONFLICT(date) DO UPDATE SET
        subscribers_count         = COALESCE(excluded.subscribers_count, subscribers_count),
        subscribers_gained        = COALESCE(excluded.subscribers_gained, subscribers_gained),
        subscribers_lost          = COALESCE(excluded.subscribers_lost, subscribers_lost),
        views                     = COALESCE(excluded.views, views),
        engaged_views             = COALESCE(excluded.engaged_views, engaged_views),
        estimated_minutes_watched = COALESCE(excluded.estimated_minutes_watched, estimated_minutes_watched),
        average_view_duration_sec = COALESCE(excluded.average_view_duration_sec, average_view_duration_sec),
        impressions               = COALESCE(excluded.impressions, impressions),
        ctr                       = COALESCE(excluded.ctr, ctr),
        fetched_at                = excluded.fetched_at
    `).run(
      row.date,
      row.subscribers_count ?? null,
      row.subscribers_gained ?? null,
      row.subscribers_lost ?? null,
      row.views ?? null,
      row.engaged_views ?? null,
      row.estimated_minutes_watched ?? null,
      row.average_view_duration_sec ?? null,
      row.impressions ?? null,
      row.ctr ?? null,
    );
    return { written: 1, error: null };
  } catch (e) {
    return { written: 0, error: e.message };
  }
}

export function writeVideoEntry(db, row) {
  try {
    db.prepare(`
      INSERT INTO sf_content_registry
        (platform, content_type, platform_id, title, published_at, duration_sec)
      VALUES ('youtube', ?, ?, ?, ?, ?)
      ON CONFLICT(platform, platform_id) DO UPDATE SET
        content_type = excluded.content_type,
        title        = COALESCE(excluded.title, title),
        published_at = COALESCE(excluded.published_at, published_at),
        duration_sec = COALESCE(excluded.duration_sec, duration_sec)
    `).run(
      row.content_type,
      row.platform_id,
      row.title ?? null,
      row.published_at ?? null,
      row.duration_sec ?? null,
    );
    const record = db.prepare(
      `SELECT id FROM sf_content_registry WHERE platform = 'youtube' AND platform_id = ?`
    ).get(row.platform_id);
    return { id: record?.id ?? null, error: null };
  } catch (e) {
    return { id: null, error: e.message };
  }
}

export function writeVideoDaily(db, row) {
  try {
    db.prepare(`
      INSERT INTO sf_social_metrics
        (content_reg_id, snapshot_date, views, likes, comments, shares,
         watch_time_min, avg_watch_sec, completion_rate, import_source, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'api', datetime('now','localtime'))
      ON CONFLICT(content_reg_id, snapshot_date) DO UPDATE SET
        views           = COALESCE(excluded.views, views),
        likes           = COALESCE(excluded.likes, likes),
        comments        = COALESCE(excluded.comments, comments),
        shares          = COALESCE(excluded.shares, shares),
        watch_time_min  = COALESCE(excluded.watch_time_min, watch_time_min),
        avg_watch_sec   = COALESCE(excluded.avg_watch_sec, avg_watch_sec),
        completion_rate = COALESCE(excluded.completion_rate, completion_rate),
        fetched_at      = excluded.fetched_at
    `).run(
      row.content_reg_id,
      row.snapshot_date,
      row.views ?? null,
      row.likes ?? null,
      row.comments ?? null,
      row.shares ?? null,
      row.watch_time_min ?? null,
      row.avg_watch_sec ?? null,
      row.completion_rate ?? null,
    );
    const record = db.prepare(
      `SELECT id FROM sf_social_metrics WHERE content_reg_id = ? AND snapshot_date = ?`
    ).get(row.content_reg_id, row.snapshot_date);
    return { id: record?.id ?? null, error: null };
  } catch (e) {
    return { id: null, error: e.message };
  }
}

export function writeVideoExt(db, metricsId, extPairs) {
  if (!metricsId || !extPairs?.length) return { written: 0, error: null };
  let written = 0;
  try {
    const stmt = db.prepare(`
      INSERT INTO sf_platform_ext (metrics_id, key, value_num, value_text)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(metrics_id, key) DO UPDATE SET
        value_num  = COALESCE(excluded.value_num, value_num),
        value_text = COALESCE(excluded.value_text, value_text)
    `);
    for (const pair of extPairs) {
      stmt.run(metricsId, pair.key, pair.value_num ?? null, pair.value_text ?? null);
      written++;
    }
    return { written, error: null };
  } catch (e) {
    return { written, error: e.message };
  }
}

export function buildTrafficSourceRows(analyticsResponse, periodStart, periodEnd) {
  if (!analyticsResponse?.rows?.length) return [];
  if (!Array.isArray(analyticsResponse.columnHeaders)) return [];
  const cols = analyticsResponse.columnHeaders.map(h => h.name);
  const srcIdx = cols.indexOf('insightTrafficSourceType');
  if (srcIdx < 0) return [];
  const numAt = (row, name) => {
    const i = cols.indexOf(name);
    if (i < 0 || row[i] == null) return null;
    const value = Number(row[i]);
    return isFinite(value) ? value : null;
  };
  return analyticsResponse.rows.map(row => {
    const sourceType = row[srcIdx];
    if (!sourceType) return null;
    return {
      period_start: periodStart,
      period_end: periodEnd,
      source_type: String(sourceType),
      views: numAt(row, 'views'),
      engaged_views: numAt(row, 'engagedViews'),
      estimated_minutes_watched: numAt(row, 'estimatedMinutesWatched'),
    };
  }).filter(Boolean);
}

export function writeTrafficSources(db, rows) {
  if (!rows?.length) return { written: 0, error: null };
  let written = 0;
  try {
    ensureYouTubeEngagedViewsSchema(db);
    const stmt = db.prepare(`
      INSERT INTO sf_youtube_traffic_sources
        (period_start, period_end, source_type, views, engaged_views, estimated_minutes_watched)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(period_start, period_end, source_type) DO UPDATE SET
        views                     = COALESCE(excluded.views, views),
        engaged_views             = COALESCE(excluded.engaged_views, engaged_views),
        estimated_minutes_watched = COALESCE(excluded.estimated_minutes_watched, estimated_minutes_watched),
        fetched_at                = datetime('now', 'localtime')
    `);
    for (const row of rows) {
      stmt.run(
        row.period_start,
        row.period_end,
        row.source_type,
        row.views ?? null,
        row.engaged_views ?? null,
        row.estimated_minutes_watched ?? null,
      );
      written++;
    }
    return { written, error: null };
  } catch (e) {
    return { written, error: e.message };
  }
}

export async function collectYouTubeChannel(db, { startDate, endDate, fetchVideos = true } = {}) {
  const { clientId, clientSecret, refreshToken, channelId } = getYouTubeConfig();
  ensureYouTubeEngagedViewsSchema(db);

  const today = new Date().toISOString().slice(0, 10);
  const end = endDate || today;
  const start = startDate || (() => {
    const d = new Date(end);
    d.setDate(d.getDate() - 30);
    return d.toISOString().slice(0, 10);
  })();

  const errors = [];
  let channelWritten = 0;
  let videoWritten = 0;
  const accessToken = await refreshAccessToken({ clientId, clientSecret, refreshToken });

  const [statsData, channelAnalytics] = await Promise.all([
    fetchChannelStats({ accessToken }).catch(e => {
      errors.push({ type: 'fetchChannelStats', reason: e.message });
      return null;
    }),
    fetchChannelAnalytics({ accessToken, channelId, startDate: start, endDate: end }).catch(e => {
      errors.push({ type: 'fetchChannelAnalytics', reason: e.message });
      return null;
    }),
  ]);

  const subscribersCount = statsData?.items?.[0]?.statistics?.subscriberCount
    ? Number(statsData.items[0].statistics.subscriberCount) : null;
  const channelRows = buildChannelSnapshots(channelAnalytics ?? {}, subscribersCount, today);
  for (const row of channelRows) {
    const { written } = writeChannelDaily(db, row);
    channelWritten += written;
  }

  if (fetchVideos) {
    const videoAnalytics = await fetchVideoAnalytics({
      accessToken, channelId, startDate: start, endDate: end,
    }).catch(e => {
      errors.push({ type: 'fetchVideoAnalytics', reason: e.message });
      return null;
    });

    if (videoAnalytics?.rows?.length) {
      const colNames = videoAnalytics.columnHeaders.map(h => h.name);
      const videoIdx = colNames.indexOf('video');
      const videoIds = videoIdx >= 0 ? videoAnalytics.rows.map(r => r[videoIdx]).filter(Boolean) : [];
      const videoMetaMap = {};

      if (videoIds.length > 0) {
        const metaData = await fetchDataVideos({ accessToken }, videoIds).catch(e => {
          errors.push({ type: 'fetchDataVideos', reason: e.message });
          return { items: [] };
        });
        for (const item of (metaData?.items ?? [])) {
          videoMetaMap[item.id] = {
            title: item.snippet?.title ?? null,
            publishedAt: item.snippet?.publishedAt ?? null,
            duration_sec: parseDuration(item.contentDetails?.duration || ''),
          };
        }
      }

      for (const row of videoAnalytics.rows) {
        const videoId = videoIdx >= 0 ? row[videoIdx] : null;
        if (!videoId) continue;
        const meta = videoMetaMap[videoId] || {};
        const entry = buildVideoEntry({
          videoId,
          title: meta.title ?? null,
          publishedAt: meta.publishedAt ?? null,
          duration_sec: meta.duration_sec ?? null,
        });
        const { id: contentRegId, error: entryErr } = writeVideoEntry(db, entry);
        if (entryErr || !contentRegId) {
          errors.push({ type: 'writeVideoEntry', videoId, reason: entryErr });
          continue;
        }
        const snap = buildVideoSnapshot(row, colNames, contentRegId, end);
        const { id: metricsId, error: snapErr } = writeVideoDaily(db, snap);
        if (snapErr) {
          errors.push({ type: 'writeVideoDaily', videoId, reason: snapErr });
        } else {
          videoWritten++;
          if (metricsId) {
            const extPairs = buildVideoExtMetrics(row, colNames);
            if (extPairs.length > 0) writeVideoExt(db, metricsId, extPairs);
          }
        }
      }
    }
  }

  const trafficData = await fetchTrafficSources({
    accessToken, channelId, startDate: start, endDate: end,
  }).catch(e => {
    errors.push({ type: 'fetchTrafficSources', reason: e.message });
    return null;
  });
  if (trafficData) {
    writeTrafficSources(db, buildTrafficSourceRows(trafficData, start, end));
  }

  return { channelWritten, videoWritten, errors };
}
