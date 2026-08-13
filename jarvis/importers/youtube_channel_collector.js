/**
 * jarvis/importers/youtube_channel_collector.js
 * YouTube Channel & Video Analytics Collector（Phase 7）
 *
 * 認証・設定: Phase 5 youtube_collector.js の REQUIRED_ENV_VARS / getYouTubeConfig /
 *              refreshAccessToken を再利用
 * API:
 *   - YouTube Analytics API v2（チャンネル日次・動画別指標・トラフィックソース）
 *   - YouTube Data API v3 （チャンネル統計・動画メタデータ補完）
 *
 * 格納先:
 *   チャンネル日次     → sf_youtube_channel_daily（Phase 7 専用テーブル）
 *   動画台帳           → sf_content_registry（platform='youtube', content_type='video'|'short'）
 *   動画日次スナップ   → sf_social_metrics（content_reg_id 基準）
 *   YouTube固有指標    → sf_platform_ext（metrics_id 基準）
 *
 * 取得不可指標（架空データは生成しない）:
 *   収益データ            → monetization 権限が必要（対象外）
 *   ユニーク視聴者数      → video フィルタ時 estimatedUniqueViewers が unavailable
 *   低評価数              → 2021年から非公開（API でも取得不可）
 *   リアルタイムデータ    → 24-48h のレポートラグあり
 *
 * 必要な環境変数（Phase 5 と共通）:
 *   YOUTUBE_CLIENT_ID     - Google OAuth クライアント ID
 *   YOUTUBE_CLIENT_SECRET - Google OAuth クライアントシークレット
 *   YOUTUBE_REFRESH_TOKEN - オフライン refresh token（初回認証で取得）
 *   YOUTUBE_CHANNEL_ID    - YouTube チャンネル ID（例: UCxxxxxxxx）
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

// ─── HTTP フェッチ関数 ─────────────────────────────────────────────────────────

/**
 * YouTube Data API v3 でチャンネル統計情報を取得する。
 *
 * @param {{ accessToken: string }} opts
 * @returns {Promise<Object>} { items: [{ statistics: { subscriberCount, viewCount, videoCount } }] }
 */
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

/**
 * YouTube Analytics API v2 でチャンネル日次指標を取得する。
 * dimensions=day で1日1行のデータを返す。
 * Phase 5 の fetchYouTubeReport を内部で再利用する。
 *
 * 取得指標:
 *   views, estimatedMinutesWatched, averageViewDuration,
 *   subscribersGained, subscribersLost
 *
 * Phase 7 では取得しない指標（NULL 予約）:
 *   impressions / impressionsClickThroughRate
 *   → サムネイルインプレッション・CTR。YouTube Analytics API v2 channel reports での
 *     安定取得が保証されない（YouTube Reporting API Reach report が必要な場合あり）。
 *     将来 Reporting API 対応後に sf_youtube_channel_daily.impressions / .ctr へ書き込む。
 *
 * @param {{ accessToken: string, channelId: string, startDate: string, endDate: string }} opts
 * @returns {Promise<Object>} Analytics API レスポンス
 */
export async function fetchChannelAnalytics({ accessToken, channelId, startDate, endDate }) {
  try {
    return await fetchYouTubeReport({
      accessToken, channelId, startDate, endDate,
      dimensions: 'day',
      metrics: [
        'views',
        'estimatedMinutesWatched',
        'averageViewDuration',
        'subscribersGained',
        'subscribersLost',
      ].join(','),
    });
  } catch (e) {
    throw new Error(`YouTube Analytics (channel) error: ${e.message}`);
  }
}

/**
 * YouTube Analytics API v2 で動画別指標を取得する（期間集計）。
 * dimensions=video で動画ごとの集計データを返す（per-day ではなく期間合算）。
 *
 * 取得指標:
 *   views, estimatedMinutesWatched, averageViewDuration,
 *   averageViewPercentage, likes, comments, shares,
 *   subscribersGained, subscribersLost
 *
 * 取得不可（video フィルタ時）:
 *   estimatedUniqueViewers → unavailable（ユニーク視聴者数）
 *
 * @param {{ accessToken: string, channelId: string, startDate: string, endDate: string }} opts
 * @returns {Promise<Object>} Analytics API レスポンス
 */
export async function fetchVideoAnalytics({ accessToken, channelId, startDate, endDate }) {
  const params = new URLSearchParams({
    ids:        `channel==${channelId}`,
    startDate,
    endDate,
    dimensions: 'video',
    metrics:    [
      'views',
      'estimatedMinutesWatched',
      'averageViewDuration',
      'averageViewPercentage',
      'likes',
      'comments',
      'shares',
      'subscribersGained',
      'subscribersLost',
    ].join(','),
    sort:       '-views',
    maxResults: '50',
  });
  const url = `${YOUTUBE_ANALYTICS_URL}?${params}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`YouTube Analytics (videos) error: ${res.status} ${body}`);
  }
  return res.json();
}

/**
 * YouTube Analytics API v2 でトラフィックソース別指標を取得する。
 * dimensions=insightTrafficSourceType で流入元ごとの期間集計を返す。
 * Phase 5 の fetchYouTubeReport を内部で再利用する。
 *
 * 代表的な source_type 値: YT_SEARCH / SUGGESTED / EXTERNAL / PLAYLIST /
 *                           DIRECT_OR_UNKNOWN / CHANNEL / NOTIFICATION / EXT_URL
 *
 * @param {{ accessToken: string, channelId: string, startDate: string, endDate: string }} opts
 * @returns {Promise<Object>} Analytics API レスポンス
 */
export async function fetchTrafficSources({ accessToken, channelId, startDate, endDate }) {
  try {
    return await fetchYouTubeReport({
      accessToken, channelId, startDate, endDate,
      dimensions: 'insightTrafficSourceType',
      metrics:    'views,estimatedMinutesWatched',
    });
  } catch (e) {
    throw new Error(`YouTube Analytics (traffic sources) error: ${e.message}`);
  }
}

/**
 * YouTube Data API v3 で動画メタデータ（タイトル・投稿日・尺）を取得する。
 * Analytics API の video dimension だけではタイトル等が取得できないため補完に使用する。
 *
 * @param {{ accessToken: string }} opts
 * @param {string[]} videoIds - 動画 ID の配列（最大 50 件）
 * @returns {Promise<Object>} Data API v3 /videos レスポンス
 */
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

// ─── 変換（純粋関数）────────────────────────────────────────────────────────────

/**
 * YouTube Analytics API のチャンネル日次レスポンスを
 * sf_youtube_channel_daily 用レコード配列に変換する。
 *
 * @param {Object} analyticsResponse - fetchChannelAnalytics のレスポンス
 * @param {number|null} subscribersCount - Data API から取得した現在の総登録者数
 * @param {string|null} today - subscribersCount を紐付ける日付 YYYY-MM-DD（通常は今日）
 * @returns {Array<Object>} sf_youtube_channel_daily 用レコード配列
 */
export function buildChannelSnapshots(analyticsResponse, subscribersCount = null, today = null) {
  if (!analyticsResponse?.rows?.length) return [];
  if (!Array.isArray(analyticsResponse.columnHeaders)) return [];

  const cols   = analyticsResponse.columnHeaders.map(h => h.name);
  const dayIdx = cols.indexOf('day');
  if (dayIdx < 0) return [];

  const idx = (name) => cols.indexOf(name);
  const num  = (row, name) => {
    const i = idx(name);
    if (i < 0 || row[i] == null) return null;
    const v = Number(row[i]);
    return isFinite(v) ? v : null;
  };

  return analyticsResponse.rows
    .map(row => {
      const date = row[dayIdx];
      if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(String(date))) return null;

      const avd = num(row, 'averageViewDuration');
      return {
        date,
        subscribers_count:         (subscribersCount !== null && date === today)
                                     ? subscribersCount : null,
        subscribers_gained:        num(row, 'subscribersGained'),
        subscribers_lost:          num(row, 'subscribersLost'),
        views:                     num(row, 'views'),
        estimated_minutes_watched: num(row, 'estimatedMinutesWatched'),
        average_view_duration_sec: avd !== null ? Math.round(avd) : null,
        // impressions / ctr: Phase 7 では取得対象外（NULL 予約）。
        // YouTube Analytics API v2 での安定取得が保証されないため、
        // 将来 YouTube Reporting API Reach report 対応後に書き込む。
        impressions: null,
        ctr:         null,
      };
    })
    .filter(Boolean);
}

/**
 * 動画データから sf_content_registry 用レコードを構築する。
 * Analytics API の video 行または Data API の補完データを受け付ける。
 *
 * @param {{
 *   videoId:      string,
 *   title?:       string,
 *   publishedAt?: string,
 *   duration_sec?: number,
 *   content_type?: 'video'|'short',
 * }} videoData
 * @returns {Object} sf_content_registry 用レコード
 */
export function buildVideoEntry(videoData) {
  if (!videoData?.videoId) throw new Error('buildVideoEntry: videoId が必要です');
  const VALID_TYPES = ['video', 'short'];
  const contentType = VALID_TYPES.includes(videoData.content_type) ? videoData.content_type : 'video';
  return {
    platform:     'youtube',
    content_type: contentType,
    platform_id:  videoData.videoId,
    title:        videoData.title        ?? null,
    published_at: videoData.publishedAt  ?? null,
    duration_sec: videoData.duration_sec ?? null,
  };
}

/**
 * Analytics API の動画行から sf_social_metrics 用レコードを構築する。
 * averageViewPercentage (0-100) は completion_rate (0-1) に正規化する。
 *
 * @param {Array} rawRow         - Analytics API の1行（動画 dimension）
 * @param {string[]} columnNames - columnHeaders から取り出したカラム名配列
 * @param {number} contentRegId  - sf_content_registry.id
 * @param {string} date          - スナップショット日 YYYY-MM-DD
 * @returns {Object} sf_social_metrics 用レコード
 */
export function buildVideoSnapshot(rawRow, columnNames, contentRegId, date) {
  if (!contentRegId) throw new Error('buildVideoSnapshot: contentRegId が必要です');
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`buildVideoSnapshot: 不正な date: ${date}`);
  }

  const get = (name) => {
    const i = columnNames.indexOf(name);
    return (i >= 0 && rawRow[i] != null) ? rawRow[i] : null;
  };
  const num = (name) => {
    const v = get(name);
    if (v === null) return null;
    const n = Number(v);
    return isFinite(n) ? n : null;
  };

  const avp = num('averageViewPercentage');
  return {
    content_reg_id:  contentRegId,
    snapshot_date:   date,
    views:           num('views'),
    likes:           num('likes'),
    comments:        num('comments'),
    shares:          num('shares'),
    watch_time_min:  num('estimatedMinutesWatched'),
    avg_watch_sec:   num('averageViewDuration'),
    completion_rate: avp !== null ? avp / 100 : null,
  };
}

/**
 * Analytics API の動画行から sf_platform_ext 用キー値ペア配列を構築する。
 * YouTube 固有指標（averageViewPercentage・登録者変化）を格納する。
 *
 * @param {Array} rawRow         - Analytics API の1行
 * @param {string[]} columnNames - columnHeaders から取り出したカラム名配列
 * @returns {Array<{key: string, value_num: number|null, value_text: string|null}>}
 */
export function buildVideoExtMetrics(rawRow, columnNames) {
  const result = [];
  const get = (name) => {
    const i = columnNames.indexOf(name);
    return (i >= 0 && rawRow[i] != null) ? Number(rawRow[i]) : null;
  };

  const avp = get('averageViewPercentage');
  if (avp !== null) {
    result.push({ key: 'avg_view_percentage', value_num: avp, value_text: null });
  }

  const sg = get('subscribersGained');
  if (sg !== null) {
    result.push({ key: 'subscribers_gained', value_num: sg, value_text: null });
  }

  const sl = get('subscribersLost');
  if (sl !== null) {
    result.push({ key: 'subscribers_lost', value_num: sl, value_text: null });
  }

  return result;
}

// ─── ユーティリティ ────────────────────────────────────────────────────────────

/**
 * ISO 8601 duration 文字列（例: "PT3M45S"）を秒数に変換する。
 *
 * @param {string} duration
 * @returns {number|null}
 */
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

// ─── DB 書き込み ─────────────────────────────────────────────────────────────────

/**
 * sf_youtube_channel_daily へ UPSERT する。
 * COALESCE で NULL 再書き込みは既存値を保持。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Object} row - buildChannelSnapshots の要素
 * @returns {{ written: number, error: string|null }}
 */
export function writeChannelDaily(db, row) {
  try {
    db.prepare(`
      INSERT INTO sf_youtube_channel_daily
        (date, subscribers_count, subscribers_gained, subscribers_lost,
         views, estimated_minutes_watched, average_view_duration_sec,
         impressions, ctr, import_source, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'api', datetime('now','localtime'))
      ON CONFLICT(date) DO UPDATE SET
        subscribers_count         = COALESCE(excluded.subscribers_count,         subscribers_count),
        subscribers_gained        = COALESCE(excluded.subscribers_gained,        subscribers_gained),
        subscribers_lost          = COALESCE(excluded.subscribers_lost,          subscribers_lost),
        views                     = COALESCE(excluded.views,                     views),
        estimated_minutes_watched = COALESCE(excluded.estimated_minutes_watched, estimated_minutes_watched),
        average_view_duration_sec = COALESCE(excluded.average_view_duration_sec, average_view_duration_sec),
        impressions               = COALESCE(excluded.impressions,               impressions),
        ctr                       = COALESCE(excluded.ctr,                       ctr),
        fetched_at                = excluded.fetched_at
    `).run(
      row.date,
      row.subscribers_count         ?? null,
      row.subscribers_gained        ?? null,
      row.subscribers_lost          ?? null,
      row.views                     ?? null,
      row.estimated_minutes_watched ?? null,
      row.average_view_duration_sec ?? null,
      row.impressions               ?? null,
      row.ctr                       ?? null,
    );
    return { written: 1, error: null };
  } catch (e) {
    return { written: 0, error: e.message };
  }
}

/**
 * sf_content_registry へ UPSERT する（YouTube 動画台帳）。
 * 挿入・競合後、実際の id を SELECT して返す。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Object} row - buildVideoEntry の返り値
 * @returns {{ id: number|null, error: string|null }}
 */
export function writeVideoEntry(db, row) {
  try {
    db.prepare(`
      INSERT INTO sf_content_registry
        (platform, content_type, platform_id, title, published_at, duration_sec)
      VALUES ('youtube', ?, ?, ?, ?, ?)
      ON CONFLICT(platform, platform_id) DO UPDATE SET
        content_type = excluded.content_type,
        title        = COALESCE(excluded.title,        title),
        published_at = COALESCE(excluded.published_at, published_at),
        duration_sec = COALESCE(excluded.duration_sec, duration_sec)
    `).run(
      row.content_type,
      row.platform_id,
      row.title        ?? null,
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

/**
 * sf_social_metrics へ UPSERT する（YouTube 動画日次スナップショット）。
 * 挿入・競合後、実際の id を SELECT して返す（sf_platform_ext 書き込みに必要）。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Object} row - buildVideoSnapshot の返り値
 * @returns {{ id: number|null, error: string|null }}
 */
export function writeVideoDaily(db, row) {
  try {
    db.prepare(`
      INSERT INTO sf_social_metrics
        (content_reg_id, snapshot_date, views, likes, comments, shares,
         watch_time_min, avg_watch_sec, completion_rate, import_source, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'api', datetime('now','localtime'))
      ON CONFLICT(content_reg_id, snapshot_date) DO UPDATE SET
        views           = COALESCE(excluded.views,           views),
        likes           = COALESCE(excluded.likes,           likes),
        comments        = COALESCE(excluded.comments,        comments),
        shares          = COALESCE(excluded.shares,          shares),
        watch_time_min  = COALESCE(excluded.watch_time_min,  watch_time_min),
        avg_watch_sec   = COALESCE(excluded.avg_watch_sec,   avg_watch_sec),
        completion_rate = COALESCE(excluded.completion_rate, completion_rate),
        fetched_at      = excluded.fetched_at
    `).run(
      row.content_reg_id,
      row.snapshot_date,
      row.views           ?? null,
      row.likes           ?? null,
      row.comments        ?? null,
      row.shares          ?? null,
      row.watch_time_min  ?? null,
      row.avg_watch_sec   ?? null,
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

/**
 * sf_platform_ext へ UPSERT する（YouTube 固有拡張指標）。
 * COALESCE で NULL 再書き込みは既存値を保持。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} metricsId - sf_social_metrics.id
 * @param {Array<{key: string, value_num: number|null, value_text: string|null}>} extPairs
 * @returns {{ written: number, error: string|null }}
 */
export function writeVideoExt(db, metricsId, extPairs) {
  if (!metricsId || !extPairs?.length) return { written: 0, error: null };
  let written = 0;
  try {
    const stmt = db.prepare(`
      INSERT INTO sf_platform_ext (metrics_id, key, value_num, value_text)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(metrics_id, key) DO UPDATE SET
        value_num  = COALESCE(excluded.value_num,  value_num),
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

// ─── トラフィックソース ───────────────────────────────────────────────────────────

/**
 * YouTube Analytics API のトラフィックソースレスポンスを
 * sf_youtube_traffic_sources 用レコード配列に変換する（純粋関数）。
 *
 * @param {Object} analyticsResponse - fetchTrafficSources のレスポンス
 * @param {string} periodStart       - 取得期間開始 YYYY-MM-DD
 * @param {string} periodEnd         - 取得期間終了 YYYY-MM-DD
 * @returns {Array<Object>} sf_youtube_traffic_sources 用レコード配列
 */
export function buildTrafficSourceRows(analyticsResponse, periodStart, periodEnd) {
  if (!analyticsResponse?.rows?.length) return [];
  if (!Array.isArray(analyticsResponse.columnHeaders)) return [];

  const cols    = analyticsResponse.columnHeaders.map(h => h.name);
  const srcIdx  = cols.indexOf('insightTrafficSourceType');
  if (srcIdx < 0) return [];

  const viewsIdx = cols.indexOf('views');
  const watchIdx = cols.indexOf('estimatedMinutesWatched');

  return analyticsResponse.rows
    .map(row => {
      const sourceType = row[srcIdx];
      if (!sourceType) return null;
      const v = (viewsIdx >= 0 && row[viewsIdx] != null) ? Number(row[viewsIdx]) : null;
      const w = (watchIdx >= 0 && row[watchIdx] != null) ? Number(row[watchIdx]) : null;
      return {
        period_start:              periodStart,
        period_end:                periodEnd,
        source_type:               String(sourceType),
        views:                     (v !== null && isFinite(v)) ? v : null,
        estimated_minutes_watched: (w !== null && isFinite(w)) ? w : null,
      };
    })
    .filter(Boolean);
}

/**
 * sf_youtube_traffic_sources へ UPSERT する。
 * COALESCE で NULL 再書き込みは既存値を保持。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Array<Object>} rows - buildTrafficSourceRows の返り値
 * @returns {{ written: number, error: string|null }}
 */
export function writeTrafficSources(db, rows) {
  if (!rows?.length) return { written: 0, error: null };
  let written = 0;
  try {
    const stmt = db.prepare(`
      INSERT INTO sf_youtube_traffic_sources
        (period_start, period_end, source_type, views, estimated_minutes_watched)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(period_start, period_end, source_type) DO UPDATE SET
        views                     = COALESCE(excluded.views,                     views),
        estimated_minutes_watched = COALESCE(excluded.estimated_minutes_watched, estimated_minutes_watched),
        fetched_at                = datetime('now', 'localtime')
    `);
    for (const row of rows) {
      stmt.run(
        row.period_start,
        row.period_end,
        row.source_type,
        row.views ?? null,
        row.estimated_minutes_watched ?? null,
      );
      written++;
    }
    return { written, error: null };
  } catch (e) {
    return { written, error: e.message };
  }
}

// ─── メインエントリーポイント ─────────────────────────────────────────────────────

/**
 * YouTube チャンネル + 動画 Analytics 収集のメインエントリーポイント。
 * 環境変数チェック後、チャンネル統計・日次指標・動画指標を取得して DB に保存する。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{
 *   startDate?:    string,  // YYYY-MM-DD（省略時: 30日前）
 *   endDate?:      string,  // YYYY-MM-DD（省略時: 今日）
 *   fetchVideos?:  boolean, // 動画別データも取得するか（デフォルト true）
 * }} opts
 * @returns {Promise<{ channelWritten: number, videoWritten: number, errors: Array }>}
 *
 * @throws 環境変数が不足している場合
 */
export async function collectYouTubeChannel(db, { startDate, endDate, fetchVideos = true } = {}) {
  const { clientId, clientSecret, refreshToken, channelId } = getYouTubeConfig();

  const today = new Date().toISOString().slice(0, 10);
  const end   = endDate   || today;
  const start = startDate || (() => {
    const d = new Date(end);
    d.setDate(d.getDate() - 30);
    return d.toISOString().slice(0, 10);
  })();

  const errors = [];
  let channelWritten = 0;
  let videoWritten   = 0;

  const accessToken = await refreshAccessToken({ clientId, clientSecret, refreshToken });

  // ── チャンネル日次指標 ──────────────────────────────────────────────────────
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

  // ── 動画別指標 ────────────────────────────────────────────────────────────
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

      // Data API でタイトル・尺を補完
      const videoIds = (videoIdx >= 0)
        ? videoAnalytics.rows.map(r => r[videoIdx]).filter(Boolean)
        : [];

      const videoMetaMap = {};
      if (videoIds.length > 0) {
        const metaData = await fetchDataVideos({ accessToken }, videoIds).catch(e => {
          errors.push({ type: 'fetchDataVideos', reason: e.message });
          return { items: [] };
        });
        for (const item of (metaData?.items ?? [])) {
          videoMetaMap[item.id] = {
            title:        item.snippet?.title        ?? null,
            publishedAt:  item.snippet?.publishedAt  ?? null,
            duration_sec: parseDuration(item.contentDetails?.duration || ''),
          };
        }
      }

      for (const row of videoAnalytics.rows) {
        const videoId = videoIdx >= 0 ? row[videoIdx] : null;
        if (!videoId) continue;

        const meta  = videoMetaMap[videoId] || {};
        const entry = buildVideoEntry({
          videoId,
          title:        meta.title        ?? null,
          publishedAt:  meta.publishedAt  ?? null,
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
            if (extPairs.length > 0) {
              writeVideoExt(db, metricsId, extPairs);
            }
          }
        }
      }
    }
  }

  // ── トラフィックソース ──────────────────────────────────────────────────────
  const trafficData = await fetchTrafficSources({
    accessToken, channelId, startDate: start, endDate: end,
  }).catch(e => {
    errors.push({ type: 'fetchTrafficSources', reason: e.message });
    return null;
  });
  if (trafficData) {
    const trafficRows = buildTrafficSourceRows(trafficData, start, end);
    writeTrafficSources(db, trafficRows);
  }

  return { channelWritten, videoWritten, errors };
}
