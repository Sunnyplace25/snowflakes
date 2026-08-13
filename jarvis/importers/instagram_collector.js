/**
 * jarvis/importers/instagram_collector.js
 * Instagram Analytics Collector（Phase 6）
 *
 * API: Instagram API with Instagram Login
 * Base URL: https://graph.instagram.com/v26.0
 * Scope: instagram_business_basic
 * 認証: OAuth 2.0 長命トークン（60日・更新可能）
 * import_source = 'api'
 *
 * 廃止済み指標（使用しない）:
 *   impressions       → 2025-04-21 全廃。views を使用すること。
 *   profile_views     → 2024-10-02 削除。profile_links_taps に統合済み。
 *   website_clicks    → 2024-10-02 削除。profile_links_taps に統合済み。
 *   video_views       → 2025-01-08 (v21.0) 削除。
 *
 * Spotify フォロワーとの対比:
 *   Spotify followers.total は Deprecated のため同様に依存しない方針で統一。
 *   Instagram の followers_count は API で正式に提供されており使用可能。
 *
 * Apple Music との対比:
 *   Apple Music API は存在するが、for Artists analytics（再生数/リスナー等）
 *   の取得には使えない。Instagram は同 API から analytics が取得可能。
 *
 * Soundrop との対比:
 *   Soundrop は「後追い収益・照合データ」として Phase 2 が管轄する。
 *   Instagram のデータはリアルタイム日次観測データとして別軸で管理する。
 *
 * 必要な環境変数（コードに保存しない）:
 *   INSTAGRAM_APP_ID       - Meta アプリ ID
 *   INSTAGRAM_APP_SECRET   - Meta アプリ シークレット
 *   INSTAGRAM_ACCESS_TOKEN - 長命ユーザートークン（60日有効・更新可能）
 *   INSTAGRAM_USER_ID      - Instagram ユーザー ID（/me で取得可能）
 *
 * 実際の OAuth 認証フローが必要な場合は NEEDS_USER で停止すること。
 */

const BASE_URL = 'https://graph.instagram.com/v26.0';

/** 必須環境変数の一覧 */
export const REQUIRED_ENV_VARS = [
  'INSTAGRAM_APP_ID',
  'INSTAGRAM_APP_SECRET',
  'INSTAGRAM_ACCESS_TOKEN',
  'INSTAGRAM_USER_ID',
];

/**
 * 環境変数から Instagram 設定を読み込み、不足がある場合はエラーを投げる。
 * 実際の OAuth 接続は行わない（設定口の検証のみ）。
 *
 * @returns {{ appId: string, appSecret: string, accessToken: string, userId: string }}
 * @throws 環境変数が不足している場合
 */
export function getInstagramConfig() {
  const missing = REQUIRED_ENV_VARS.filter(k => !process.env[k]);
  if (missing.length > 0) {
    throw new Error(
      `Instagram collector: 環境変数が未設定です: ${missing.join(', ')}\n` +
      `設定方法: .env ファイルまたはシェル環境変数に上記を追加してください。\n` +
      `実際の Meta OAuth 認証フローが必要な場合は NEEDS_USER フラグを立ててください。`
    );
  }
  return {
    appId:       process.env.INSTAGRAM_APP_ID,
    appSecret:   process.env.INSTAGRAM_APP_SECRET,
    accessToken: process.env.INSTAGRAM_ACCESS_TOKEN,
    userId:      process.env.INSTAGRAM_USER_ID,
  };
}

/**
 * 長命トークンを更新する（60日ごとに必要）。
 * 実際の OAuth 初回認証フローは行わない（既存の長命トークンが必要）。
 * 実際の更新実行には getInstagramConfig() で取得した config が必要。
 *
 * @param {{ appSecret: string, accessToken: string }} config
 * @returns {Promise<string>} 新しいアクセストークン
 */
export async function refreshLongLivedToken({ appSecret, accessToken }) {
  const params = new URLSearchParams({
    grant_type:   'ig_refresh_token',
    access_token: accessToken,
  });
  // Instagram Login 版のリフレッシュエンドポイント
  const url = `${BASE_URL}/refresh_access_token?${params}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Instagram token refresh failed: ${res.status} ${body}`);
  }
  const data = await res.json();
  if (!data.access_token) {
    throw new Error('Instagram token refresh: access_token not returned');
  }
  return data.access_token;
}

/**
 * /me エンドポイントからアカウント基本情報を取得する。
 *
 * @param {{ accessToken: string, userId: string }} config
 * @returns {Promise<Object>}
 */
export async function fetchMe({ accessToken, userId }) {
  const params = new URLSearchParams({
    fields:       'id,username,followers_count,follows_count,media_count',
    access_token: accessToken,
  });
  const url = `${BASE_URL}/${userId}?${params}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Instagram /me error: ${res.status} ${body}`);
  }
  return res.json();
}

/**
 * アカウント Insights を取得する。
 * period=day で日次集計を取得。
 * 廃止済み impressions は含めない。
 *
 * @param {{ accessToken: string, userId: string }} config
 * @param {string} date - YYYY-MM-DD（集計対象日）
 * @returns {Promise<Object>} Instagram Insights API レスポンス
 */
export async function fetchAccountInsights({ accessToken, userId }, date) {
  // day 期間の Insights は Unix タイムスタンプの範囲で指定する
  const dateObj = new Date(date + 'T00:00:00Z');
  const since   = Math.floor(dateObj.getTime() / 1000);
  const until   = since + 86400; // +1日

  const params = new URLSearchParams({
    metric: [
      'reach',
      'views',
      'accounts_engaged',
      'total_interactions',
      'likes',
      'comments',
      'shares',
      'saves',
      'follows_and_unfollows',
      'profile_links_taps',
    ].join(','),
    period:       'day',
    since:        String(since),
    until:        String(until),
    access_token: accessToken,
  });
  const url = `${BASE_URL}/${userId}/insights?${params}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Instagram Insights error: ${res.status} ${body}`);
  }
  return res.json();
}

/**
 * メディア一覧を取得する。
 * 直接フィールドを利用（2026-04追加の shares_count/saved_count/reposts_count 含む）。
 *
 * @param {{ accessToken: string, userId: string }} config
 * @param {{ limit?: number, after?: string }} pagination
 * @returns {Promise<Object>}
 */
export async function fetchMediaList({ accessToken, userId }, { limit = 25, after = '' } = {}) {
  const fields = [
    'id', 'media_type', 'media_product_type', 'timestamp', 'caption', 'permalink',
    'like_count', 'comments_count', 'view_count',
    'shares_count', 'saved_count', 'reposts_count',
  ].join(',');
  const params = new URLSearchParams({
    fields,
    limit:        String(limit),
    access_token: accessToken,
  });
  if (after) params.set('after', after);

  const url = `${BASE_URL}/${userId}/media?${params}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Instagram media list error: ${res.status} ${body}`);
  }
  return res.json();
}

/**
 * 投稿別 Insights を取得する（insights edge）。
 * リール専用の ig_reels_avg_watch_time も含む。
 *
 * @param {{ accessToken: string }} config
 * @param {string} mediaId - Instagram media ID
 * @param {string} mediaProductType - 'FEED' | 'REELS'
 * @returns {Promise<Object>}
 */
export async function fetchMediaInsights({ accessToken }, mediaId, mediaProductType) {
  const baseMetrics = ['reach', 'profile_visits', 'total_interactions'];
  if (mediaProductType === 'REELS') {
    baseMetrics.push('ig_reels_avg_watch_time');
  }
  const params = new URLSearchParams({
    metric:       baseMetrics.join(','),
    access_token: accessToken,
  });
  const url = `${BASE_URL}/${mediaId}/insights?${params}`;
  const res = await fetch(url);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Instagram media insights error: ${res.status} ${body}`);
  }
  return res.json();
}

// ─── 変換（純粋関数）────────────────────────────────────────────────────────────

/**
 * /me レスポンスと Insights レスポンスから sf_instagram_account_daily 用レコードを構築する。
 * 廃止済みフィールドは含めない。取得不能な値は 0 でなく NULL（省略）で返す。
 *
 * @param {Object} meData       - /me レスポンス
 * @param {Object} insightsData - insights エッジレスポンス
 * @param {string} date         - YYYY-MM-DD
 * @returns {Object} sf_instagram_account_daily 用レコード
 */
export function buildAccountSnapshot(meData, insightsData, date) {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`buildAccountSnapshot: 不正な date: ${date}`);
  }

  // insights data から metric 名 → 値のマップを作る
  const insightMap = {};
  for (const item of (insightsData?.data ?? [])) {
    const value = item?.values?.[0]?.value ?? item?.value ?? null;
    insightMap[item.name] = typeof value === 'number' ? value : null;
  }

  return {
    date,
    followers_count:       meData?.followers_count       ?? null,
    follows_count:         meData?.follows_count         ?? null,
    media_count:           meData?.media_count           ?? null,
    reach:                 insightMap['reach']                 ?? null,
    views:                 insightMap['views']                 ?? null,
    accounts_engaged:      insightMap['accounts_engaged']      ?? null,
    total_interactions:    insightMap['total_interactions']    ?? null,
    likes:                 insightMap['likes']                 ?? null,
    comments:              insightMap['comments']              ?? null,
    shares:                insightMap['shares']                ?? null,
    saves:                 insightMap['saves']                 ?? null,
    follows_and_unfollows: insightMap['follows_and_unfollows'] ?? null,
    profile_links_taps:    insightMap['profile_links_taps']    ?? null,
  };
}

/**
 * メディア API レスポンスから sf_instagram_media 用レコードを構築する。
 *
 * @param {Object} mediaData - media list の各要素
 * @returns {Object} sf_instagram_media 用レコード
 */
export function buildMediaEntry(mediaData) {
  if (!mediaData?.id) throw new Error('buildMediaEntry: media ID が必要です');
  const validTypes = ['IMAGE', 'VIDEO', 'CAROUSEL_ALBUM', 'REELS'];
  const mediaType = validTypes.includes(mediaData.media_type) ? mediaData.media_type : null;
  if (!mediaType) throw new Error(`buildMediaEntry: 不正な media_type: ${mediaData.media_type}`);

  const validProductTypes = ['FEED', 'REELS'];
  const mediaProductType = validProductTypes.includes(mediaData.media_product_type)
    ? mediaData.media_product_type : null;

  return {
    instagram_media_id: mediaData.id,
    media_type:         mediaType,
    media_product_type: mediaProductType,
    published_at:       mediaData.timestamp ?? null,
    caption:            mediaData.caption   ?? null,
    permalink:          mediaData.permalink ?? null,
  };
}

/**
 * メディア直接フィールドと insights レスポンスから sf_instagram_media_daily 用レコードを構築する。
 * 取得不能な値は NULL（0 にしない）。
 *
 * @param {string} mediaId           - instagram_media_id
 * @param {Object} directFields      - media list の直接フィールド（like_count 等）
 * @param {Object|null} insightsData - insights エッジレスポンス（失敗時は null）
 * @param {string} date              - スナップショット日 YYYY-MM-DD
 * @param {string} mediaProductType  - 'FEED' | 'REELS'
 * @returns {Object} sf_instagram_media_daily 用レコード
 */
export function buildMediaSnapshot(mediaId, directFields, insightsData, date, mediaProductType) {
  if (!mediaId) throw new Error('buildMediaSnapshot: mediaId が必要です');
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`buildMediaSnapshot: 不正な date: ${date}`);
  }

  const insightMap = {};
  for (const item of (insightsData?.data ?? [])) {
    const value = item?.values?.[0]?.value ?? item?.value ?? null;
    insightMap[item.name] = typeof value === 'number' ? value : null;
  }

  const avgWatchTime = mediaProductType === 'REELS'
    ? (insightMap['ig_reels_avg_watch_time'] ?? null)
    : null;

  return {
    instagram_media_id: mediaId,
    date,
    like_count:        directFields?.like_count        ?? null,
    comments_count:    directFields?.comments_count    ?? null,
    view_count:        directFields?.view_count        ?? null,
    shares_count:      directFields?.shares_count      ?? null,
    saved_count:       directFields?.saved_count       ?? null,
    reposts_count:     directFields?.reposts_count     ?? null,
    reach:             insightMap['reach']             ?? null,
    profile_visits:    insightMap['profile_visits']    ?? null,
    avg_watch_time_ms: avgWatchTime,
  };
}

// ─── DB 書き込み ─────────────────────────────────────────────────────────────────

/**
 * sf_instagram_account_daily へ UPSERT する。
 * COALESCE で NULL の再書き込みは既存値を保持。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Object} row - buildAccountSnapshot の返り値
 * @returns {{ written: number, error: string|null }}
 */
export function writeAccountDaily(db, row) {
  try {
    db.prepare(`
      INSERT INTO sf_instagram_account_daily
        (date, followers_count, follows_count, media_count,
         reach, views, accounts_engaged, total_interactions,
         likes, comments, shares, saves, follows_and_unfollows, profile_links_taps,
         import_source, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'api', datetime('now','localtime'))
      ON CONFLICT(date) DO UPDATE SET
        followers_count       = COALESCE(excluded.followers_count,       followers_count),
        follows_count         = COALESCE(excluded.follows_count,         follows_count),
        media_count           = COALESCE(excluded.media_count,           media_count),
        reach                 = COALESCE(excluded.reach,                 reach),
        views                 = COALESCE(excluded.views,                 views),
        accounts_engaged      = COALESCE(excluded.accounts_engaged,      accounts_engaged),
        total_interactions    = COALESCE(excluded.total_interactions,    total_interactions),
        likes                 = COALESCE(excluded.likes,                 likes),
        comments              = COALESCE(excluded.comments,              comments),
        shares                = COALESCE(excluded.shares,                shares),
        saves                 = COALESCE(excluded.saves,                 saves),
        follows_and_unfollows = COALESCE(excluded.follows_and_unfollows, follows_and_unfollows),
        profile_links_taps    = COALESCE(excluded.profile_links_taps,    profile_links_taps),
        fetched_at            = excluded.fetched_at
    `).run(
      row.date,
      row.followers_count    ?? null,
      row.follows_count      ?? null,
      row.media_count        ?? null,
      row.reach              ?? null,
      row.views              ?? null,
      row.accounts_engaged   ?? null,
      row.total_interactions ?? null,
      row.likes              ?? null,
      row.comments           ?? null,
      row.shares             ?? null,
      row.saves              ?? null,
      row.follows_and_unfollows ?? null,
      row.profile_links_taps    ?? null,
    );
    return { written: 1, error: null };
  } catch (e) {
    return { written: 0, error: e.message };
  }
}

/**
 * sf_instagram_media へ UPSERT する（メディア台帳）。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Object} row - buildMediaEntry の返り値
 * @returns {{ written: number, error: string|null }}
 */
export function writeMediaEntry(db, row) {
  try {
    db.prepare(`
      INSERT INTO sf_instagram_media
        (instagram_media_id, media_type, media_product_type, published_at, caption, permalink, import_source)
      VALUES (?, ?, ?, ?, ?, ?, 'api')
      ON CONFLICT(instagram_media_id) DO UPDATE SET
        media_type         = excluded.media_type,
        media_product_type = COALESCE(excluded.media_product_type, media_product_type),
        published_at       = COALESCE(excluded.published_at,       published_at),
        caption            = COALESCE(excluded.caption,            caption),
        permalink          = COALESCE(excluded.permalink,          permalink)
    `).run(
      row.instagram_media_id,
      row.media_type,
      row.media_product_type ?? null,
      row.published_at       ?? null,
      row.caption            ?? null,
      row.permalink          ?? null,
    );
    return { written: 1, error: null };
  } catch (e) {
    return { written: 0, error: e.message };
  }
}

/**
 * sf_instagram_media_daily へ UPSERT する。
 * COALESCE で NULL の再書き込みは既存値を保持（部分更新対応）。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Object} row - buildMediaSnapshot の返り値
 * @returns {{ written: number, error: string|null }}
 */
export function writeMediaDaily(db, row) {
  try {
    db.prepare(`
      INSERT INTO sf_instagram_media_daily
        (instagram_media_id, date, like_count, comments_count, view_count,
         shares_count, saved_count, reposts_count, reach, profile_visits, avg_watch_time_ms,
         import_source, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'api', datetime('now','localtime'))
      ON CONFLICT(instagram_media_id, date) DO UPDATE SET
        like_count        = COALESCE(excluded.like_count,        like_count),
        comments_count    = COALESCE(excluded.comments_count,    comments_count),
        view_count        = COALESCE(excluded.view_count,        view_count),
        shares_count      = COALESCE(excluded.shares_count,      shares_count),
        saved_count       = COALESCE(excluded.saved_count,       saved_count),
        reposts_count     = COALESCE(excluded.reposts_count,     reposts_count),
        reach             = COALESCE(excluded.reach,             reach),
        profile_visits    = COALESCE(excluded.profile_visits,    profile_visits),
        avg_watch_time_ms = COALESCE(excluded.avg_watch_time_ms, avg_watch_time_ms),
        fetched_at        = excluded.fetched_at
    `).run(
      row.instagram_media_id,
      row.date,
      row.like_count        ?? null,
      row.comments_count    ?? null,
      row.view_count        ?? null,
      row.shares_count      ?? null,
      row.saved_count       ?? null,
      row.reposts_count     ?? null,
      row.reach             ?? null,
      row.profile_visits    ?? null,
      row.avg_watch_time_ms ?? null,
    );
    return { written: 1, error: null };
  } catch (e) {
    return { written: 0, error: e.message };
  }
}

// ─── メインエントリーポイント ─────────────────────────────────────────────────────

/**
 * Instagram 日次収集のメインエントリーポイント。
 * 環境変数チェック後、アカウント情報・Insights・メディア一覧を取得して DB に保存する。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{
 *   date?:      string,   // YYYY-MM-DD（省略時: 昨日）
 *   mediaLimit?: number,  // 取得するメディア件数（デフォルト 25）
 *   fetchInsights?: boolean, // 投稿別 Insights も取得するか（デフォルト true）
 * }} opts
 * @returns {Promise<{ accountWritten: number, mediaWritten: number, errors: Array }>}
 */
export async function collectInstagramDaily(db, { date, mediaLimit = 25, fetchInsights = true } = {}) {
  const config = getInstagramConfig(); // env vars チェック（実 OAuth 接続なし）

  const today     = new Date().toISOString().slice(0, 10);
  const yesterday = (() => { const d = new Date(); d.setDate(d.getDate() - 1); return d.toISOString().slice(0, 10); })();
  const targetDate = date || yesterday;

  const errors = [];
  let mediaWritten = 0;

  // アカウント基本情報 + Insights
  const [meData, insightsData] = await Promise.all([
    fetchMe(config).catch(e => { errors.push({ type: 'fetchMe', reason: e.message }); return null; }),
    fetchAccountInsights(config, targetDate).catch(e => { errors.push({ type: 'fetchInsights', reason: e.message }); return null; }),
  ]);

  const accountRow = buildAccountSnapshot(meData ?? {}, insightsData ?? {}, targetDate);
  const { written: accountWritten } = writeAccountDaily(db, accountRow);

  // メディア一覧
  const mediaListData = await fetchMediaList(config, { limit: mediaLimit })
    .catch(e => { errors.push({ type: 'fetchMediaList', reason: e.message }); return null; });

  for (const media of (mediaListData?.data ?? [])) {
    const mediaEntry = buildMediaEntry(media);
    writeMediaEntry(db, mediaEntry);

    if (fetchInsights) {
      const insData = await fetchMediaInsights(config, media.id, media.media_product_type)
        .catch(e => { errors.push({ type: 'fetchMediaInsights', mediaId: media.id, reason: e.message }); return null; });
      const mediaSnap = buildMediaSnapshot(
        media.id, media, insData, today, media.media_product_type
      );
      const { written } = writeMediaDaily(db, mediaSnap);
      mediaWritten += written;
    }
  }

  return { accountWritten, mediaWritten, errors };
}
