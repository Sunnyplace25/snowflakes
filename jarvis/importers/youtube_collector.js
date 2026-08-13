/**
 * jarvis/importers/youtube_collector.js
 * YouTube Analytics API v2 コレクター（Phase 5）
 *
 * データ源: YouTube Analytics API v2
 * 認証: OAuth 2.0 (offline access / refresh token)
 * import_source = 'api'
 *
 * 必要な環境変数:
 *   YOUTUBE_CLIENT_ID     - Google OAuth クライアントID
 *   YOUTUBE_CLIENT_SECRET - Google OAuth クライアントシークレット
 *   YOUTUBE_REFRESH_TOKEN - オフライン refresh token（初回認証で取得）
 *   YOUTUBE_CHANNEL_ID    - YouTube チャンネルID（例: UCxxxxxxxx）
 *
 * 利用可能データ（動画単位）:
 *   views                → streams（再生数）
 *   subscribersGained    → followers_delta の元データ
 *   subscribersLost      → followers_delta の元データ
 *
 * 取得不可データ:
 *   ユニークリスナー数（YouTube Analytics v2 では動画フィルタ時に unavailable）
 *
 * 対象外サービスとの対比:
 *   Spotify for Artists  → Web API は公開（GET /artists/{id}）だが analytics エンドポイントは存在しない。
 *                          followers.total は Deprecated 扱い（非推奨）のため補助指標としても依存しない。
 *                          月次ストリーム数は Soundrop Statement CSV から後追いで照合する。
 *   Apple Music          → Apple Music API は存在するが、アーティスト向けストリーム/リスナー数
 *                          (Apple Music for Artists analytics) の取得には使用できない。unsupported。
 *   Amazon Music         → 公式 analytics API なし。unsupported。
 *
 * Soundrop Statement CSV の位置づけ:
 *   - 「後追い収益・再生照合データ」として Phase 2 (sf_revenue) が管轄する
 *   - 日次リアルタイムデータとは混同しない（反映ラグあり・手動取得）
 *   - music_metrics_writer.js は Soundrop CSV を sf_music_metrics へ補完投入するが、
 *     日次 YouTube データと同一の "主データ" としては扱わない
 *
 * OAuth 設定:
 *   実際の Google OAuth 接続・トークン発行は環境変数セットアップ後に行う。
 *   初回認証フローが必要になった時点で NEEDS_USER フラグを立てること。
 */

const GOOGLE_TOKEN_URL      = 'https://oauth2.googleapis.com/token';
const YOUTUBE_ANALYTICS_URL = 'https://youtubeanalytics.googleapis.com/v2/reports';

/** 必須環境変数の一覧 */
export const REQUIRED_ENV_VARS = [
  'YOUTUBE_CLIENT_ID',
  'YOUTUBE_CLIENT_SECRET',
  'YOUTUBE_REFRESH_TOKEN',
  'YOUTUBE_CHANNEL_ID',
];

/**
 * 環境変数から YouTube 設定を読み込み、不足がある場合はエラーを投げる。
 * 実際の Google OAuth 接続は行わない（設定口の検証のみ）。
 *
 * @returns {{ clientId: string, clientSecret: string, refreshToken: string, channelId: string }}
 * @throws 環境変数が不足している場合
 */
export function getYouTubeConfig() {
  const missing = REQUIRED_ENV_VARS.filter(k => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(
      `YouTube collector: 環境変数が未設定です: ${missing.join(', ')}\n` +
      `設定方法: .env ファイルまたはシェル環境変数に上記を追加してください。\n` +
      `実際の Google OAuth 接続が必要な場合は NEEDS_USER フラグを立ててください。`
    );
  }
  return {
    clientId:     process.env.YOUTUBE_CLIENT_ID,
    clientSecret: process.env.YOUTUBE_CLIENT_SECRET,
    refreshToken: process.env.YOUTUBE_REFRESH_TOKEN,
    channelId:    process.env.YOUTUBE_CHANNEL_ID,
  };
}

/**
 * OAuth 2.0 refresh token でアクセストークンを取得する。
 *
 * @param {{ clientId: string, clientSecret: string, refreshToken: string }} opts
 * @returns {Promise<string>} アクセストークン
 */
export async function refreshAccessToken({ clientId, clientSecret, refreshToken }) {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      client_id:     clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
      grant_type:    'refresh_token',
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token refresh failed: ${res.status} ${body}`);
  }
  const data = await res.json();
  if (!data.access_token) {
    throw new Error(`Token refresh: access_token not returned`);
  }
  return data.access_token;
}

/**
 * YouTube Analytics API v2 にクエリを送信する。
 *
 * @param {{
 *   accessToken: string,
 *   channelId:   string,
 *   startDate:   string,  // YYYY-MM-DD
 *   endDate:     string,  // YYYY-MM-DD
 *   dimensions:  string,  // 'day' | 'month'
 *   metrics:     string,  // カンマ区切り
 *   filters?:    string,  // 例: 'video==VIDEO_ID'
 * }} opts
 * @returns {Promise<Object>} API レスポンス
 */
export async function fetchYouTubeReport({ accessToken, channelId, startDate, endDate, dimensions, metrics, filters = '' }) {
  const params = new URLSearchParams({
    ids:        `channel==${channelId}`,
    startDate,
    endDate,
    dimensions,
    metrics,
  });
  if (filters) params.set('filters', filters);

  const url = `${YOUTUBE_ANALYTICS_URL}?${params}`;
  const res = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`YouTube Analytics API error: ${res.status} ${body}`);
  }
  return res.json();
}

/**
 * YouTube Analytics API レスポンス（動画単位）を sf_music_metrics 形式に変換する。
 * 純粋関数（DB 操作なし）。
 *
 * @param {Object} apiResponse - YouTube Analytics API のレスポンス
 * @param {number} trackId     - sf_tracks.id（track_id が null/非整数の場合は空配列を返す）
 * @param {'daily'|'monthly'} granularity
 * @returns {Array<{
 *   date:           string,
 *   month:          string,
 *   granularity:    string,
 *   platform:       'youtube_music',
 *   trackId:        number,
 *   streams:        number,
 *   followersDelta: number|null,
 * }>}
 */
export function buildYouTubeVideoMetrics(apiResponse, trackId, granularity = 'daily') {
  if (!Number.isInteger(trackId) || trackId == null) return [];
  if (!apiResponse?.rows?.length) return [];
  if (!Array.isArray(apiResponse.columnHeaders)) return [];

  const cols = apiResponse.columnHeaders.map(h => h.name);
  const dayIdx         = cols.indexOf('day');
  const monthIdx       = cols.indexOf('month');
  const viewsIdx       = cols.indexOf('views');
  const subsGainedIdx  = cols.indexOf('subscribersGained');
  const subsLostIdx    = cols.indexOf('subscribersLost');

  const results = [];
  for (const row of apiResponse.rows) {
    // 日付を特定
    let dateStr;
    if (granularity === 'daily' && dayIdx >= 0) {
      dateStr = row[dayIdx]; // YYYY-MM-DD
    } else if (granularity === 'monthly' && monthIdx >= 0) {
      dateStr = row[monthIdx] + '-01'; // YYYY-MM → YYYY-MM-01
    } else if (dayIdx >= 0) {
      dateStr = row[dayIdx];
    } else {
      continue; // 日付列なし → スキップ
    }

    if (!dateStr || !/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) continue;

    const month   = dateStr.slice(0, 7); // YYYY-MM
    const views   = viewsIdx >= 0 ? Number(row[viewsIdx] ?? 0) : 0;
    const gained  = subsGainedIdx >= 0 ? Number(row[subsGainedIdx] ?? 0) : null;
    const lost    = subsLostIdx   >= 0 ? Number(row[subsLostIdx]   ?? 0) : null;
    const followersDelta = (gained !== null && lost !== null) ? gained - lost : null;

    results.push({
      date:           dateStr,
      month,
      granularity,
      platform:       'youtube_music',
      trackId,
      streams:        isFinite(views) ? views : 0,
      followersDelta: followersDelta !== null && isFinite(followersDelta) ? followersDelta : null,
    });
  }
  return results;
}

/**
 * sf_music_metrics へ YouTube データを UPSERT する。
 * ON CONFLICT(date, granularity, platform, track_id) DO UPDATE SET
 *   streams        = excluded.streams,
 *   followers_delta = COALESCE(excluded.followers_delta, followers_delta),
 *   fetched_at     = excluded.fetched_at
 * import_source = 'api' 固定。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Array<{ date, month, granularity, platform, trackId, streams, followersDelta }>} rows
 * @returns {{ written: number, errors: Array<{ row, reason }> }}
 */
export function writeYouTubeMetrics(db, rows) {
  let written = 0;
  const errors = [];

  const stmt = db.prepare(`
    INSERT INTO sf_music_metrics
      (date, month, granularity, platform, track_id, streams, followers_delta, import_source, fetched_at)
    VALUES (?, ?, ?, 'youtube_music', ?, ?, ?, 'api', datetime('now', 'localtime'))
    ON CONFLICT(date, granularity, platform, track_id) DO UPDATE SET
      streams         = excluded.streams,
      followers_delta = COALESCE(excluded.followers_delta, followers_delta),
      fetched_at      = excluded.fetched_at
  `);

  for (const row of rows) {
    try {
      stmt.run(
        row.date,
        row.month,
        row.granularity,
        row.trackId,
        row.streams,
        row.followersDelta ?? null,
      );
      written++;
    } catch (e) {
      errors.push({ row, reason: e.message });
    }
  }

  return { written, errors };
}

/**
 * YouTube Analytics の日次収集メインエントリーポイント。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{
 *   startDate?:    string,                  // YYYY-MM-DD（省略時: 30日前）
 *   endDate?:      string,                  // YYYY-MM-DD（省略時: 今日）
 *   granularity?:  'daily'|'monthly',
 *   trackVideoMap: Map<string, number>,     // YouTube videoId → sf_tracks.id
 * }} opts
 * @returns {Promise<{ written: number, errors: Array }>}
 *
 * @throws 環境変数が不足している場合
 */
export async function collectYouTubeDaily(db, { startDate, endDate, granularity = 'daily', trackVideoMap } = {}) {
  // 環境変数チェック（実際の Google OAuth 接続は行わない）
  const { clientId, clientSecret, refreshToken, channelId } = getYouTubeConfig();

  if (!trackVideoMap || trackVideoMap.size === 0) {
    return { written: 0, errors: [] };
  }

  const today = new Date().toISOString().slice(0, 10);
  const end   = endDate || today;
  const start = startDate || (() => {
    const d = new Date(end);
    d.setDate(d.getDate() - 30);
    return d.toISOString().slice(0, 10);
  })();

  const accessToken  = await refreshAccessToken({ clientId, clientSecret, refreshToken });
  const dimensions   = granularity === 'monthly' ? 'month' : 'day';
  const metrics      = 'views,subscribersGained,subscribersLost';

  let totalWritten = 0;
  const allErrors  = [];

  for (const [videoId, trackId] of trackVideoMap) {
    try {
      const report = await fetchYouTubeReport({
        accessToken,
        channelId,
        startDate: start,
        endDate:   end,
        dimensions,
        metrics,
        filters: `video==${videoId}`,
      });

      const rows = buildYouTubeVideoMetrics(report, trackId, granularity);
      const { written, errors } = writeYouTubeMetrics(db, rows);
      totalWritten += written;
      allErrors.push(...errors);
    } catch (e) {
      allErrors.push({ videoId, trackId, reason: e.message });
    }
  }

  return { written: totalWritten, errors: allErrors };
}
