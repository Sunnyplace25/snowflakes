/**
 * jarvis/data/sf_x_manager.js
 * X（旧Twitter）Analytics データマネージャー（Phase 12）
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 重要原則
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * - 取得方式: B（CSV エクスポート）
 *   X Analytics（analytics.x.com）の Post Activity CSV から手動取込。
 *
 *   公式 X API による自動取得は技術的に可能（User Context 認証 / public_metrics /
 *   non_public_metrics / organic_metrics 等）だが、現在は API credentials / credits を
 *   設定せず、無料の X Analytics CSV（analytics.x.com）を標準運用とするため MANUAL。
 *
 *   CSV 制約（X Analytics Post Activity Export の公式仕様）:
 *     - 1 回のエクスポートで最大 30 日分
 *     - 1 CSV に最大 3,000 件の投稿
 *
 *   将来 X API を有効化する場合は importers/x_csv_importer.js を API collector に置き換えること。
 *
 * - 個人ユーザー追跡を行わない。
 *   リプライ相手・リツイート元アカウントの識別・照合は禁止。
 *
 * - 異種指標の合算禁止。
 *   engagements（X Analytics 提供合計値）と likes + retweets + replies を
 *   二重に合算して「総エンゲージメント」を作ることは禁止。
 *   engagements カラムは X Analytics が提供した値をそのまま保持する。
 *
 * - 因果関係を断定しない。
 *   X からのサイト流入との相関を観測することは可能だが、同一人物照合は禁止。
 *
 * - スキーマ変更なし（このファイルは read/write のみ）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 */

// ── 定数 ─────────────────────────────────────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** sf_x_tweet.tweet_type の許可値 */
export const VALID_TWEET_TYPES = ['tweet', 'reply', 'retweet', 'quote'];

/** sf_x_tweet_metrics の数値カラム一覧 */
export const METRIC_COLS = [
  'impressions', 'engagements', 'retweets', 'replies', 'likes',
  'url_clicks', 'profile_clicks', 'detail_expands', 'media_views', 'media_engagements',
];

// ── バリデーション ────────────────────────────────────────────────────────────

/**
 * YYYY-MM-DD 形式の日付文字列か検証する。
 * @param {string} s
 * @returns {boolean}
 */
export function isValidDate(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !isNaN(d.getTime());
}

/**
 * tweet_id として有効か検証する（空文字・非文字列を拒否）。
 * @param {unknown} id
 * @returns {boolean}
 */
export function isValidTweetId(id) {
  return typeof id === 'string' && id.trim().length > 0;
}

// ── ツイート台帳 WRITE ────────────────────────────────────────────────────────

/**
 * ツイートレコードを sf_x_tweet へ UPSERT する（冪等）。
 * 既存レコードは published_at / text_snippet / tweet_type を上書き更新する。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ tweet_id: string, published_at?: string|null, text_snippet?: string|null, tweet_type?: string, import_source?: string }} tweet
 * @returns {string} tweet_id
 */
export function writeXTweet(db, tweet) {
  const { tweet_id, published_at = null, text_snippet = null, tweet_type = 'tweet', import_source = 'csv' } = tweet;
  if (!isValidTweetId(tweet_id)) throw new Error(`writeXTweet: tweet_id が不正です（値: ${tweet_id}）`);
  if (!VALID_TWEET_TYPES.includes(tweet_type)) throw new Error(`writeXTweet: tweet_type が不正です（値: ${tweet_type}）`);

  // text_snippet は先頭 140 文字に切り捨て
  const snippet = typeof text_snippet === 'string' ? text_snippet.slice(0, 140) : null;

  db.prepare(`
    INSERT INTO sf_x_tweet (tweet_id, published_at, text_snippet, tweet_type, import_source)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(tweet_id) DO UPDATE SET
      published_at  = COALESCE(excluded.published_at, published_at),
      text_snippet  = COALESCE(excluded.text_snippet, text_snippet),
      tweet_type    = excluded.tweet_type,
      import_source = excluded.import_source
  `).run(tweet_id.trim(), published_at, snippet, tweet_type, import_source);

  return tweet_id.trim();
}

// ── ツイート指標 WRITE ────────────────────────────────────────────────────────

/**
 * ツイート別指標スナップショットを sf_x_tweet_metrics へ UPSERT する（冪等）。
 * 既存 NULL を非 NULL 値で上書きする（COALESCE）。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ tweet_id: string, snapshot_date: string, [key: string]: unknown }} metrics
 * @returns {{ tweet_id: string, snapshot_date: string }}
 */
export function writeXTweetMetrics(db, metrics) {
  const { tweet_id, snapshot_date, import_source = 'csv', ...rest } = metrics;
  if (!isValidTweetId(tweet_id)) throw new Error(`writeXTweetMetrics: tweet_id が不正です`);
  if (!isValidDate(snapshot_date)) throw new Error(`writeXTweetMetrics: snapshot_date が不正です（値: ${snapshot_date}）`);

  // METRIC_COLS のみ許可（未知のカラムは無視して合算しない）
  const nums = {};
  for (const col of METRIC_COLS) {
    const v = rest[col];
    nums[col] = (typeof v === 'number' && isFinite(v) && v >= 0) ? Math.floor(v) : null;
  }

  db.prepare(`
    INSERT INTO sf_x_tweet_metrics
      (tweet_id, snapshot_date, impressions, engagements, retweets, replies, likes,
       url_clicks, profile_clicks, detail_expands, media_views, media_engagements, import_source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(tweet_id, snapshot_date) DO UPDATE SET
      impressions       = COALESCE(excluded.impressions,       impressions),
      engagements       = COALESCE(excluded.engagements,       engagements),
      retweets          = COALESCE(excluded.retweets,          retweets),
      replies           = COALESCE(excluded.replies,           replies),
      likes             = COALESCE(excluded.likes,             likes),
      url_clicks        = COALESCE(excluded.url_clicks,        url_clicks),
      profile_clicks    = COALESCE(excluded.profile_clicks,    profile_clicks),
      detail_expands    = COALESCE(excluded.detail_expands,    detail_expands),
      media_views       = COALESCE(excluded.media_views,       media_views),
      media_engagements = COALESCE(excluded.media_engagements, media_engagements),
      import_source     = excluded.import_source,
      fetched_at        = datetime('now','localtime')
  `).run(
    tweet_id.trim(), snapshot_date,
    nums.impressions, nums.engagements, nums.retweets, nums.replies, nums.likes,
    nums.url_clicks, nums.profile_clicks, nums.detail_expands, nums.media_views, nums.media_engagements,
    import_source,
  );

  return { tweet_id: tweet_id.trim(), snapshot_date };
}

// ── アカウント日次 WRITE ──────────────────────────────────────────────────────

/**
 * アカウント日次スナップショットを sf_x_account_daily へ UPSERT する（冪等）。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ date: string, followers_count?: number|null, import_source?: string }} row
 * @returns {string} date
 */
export function writeXAccountDaily(db, row) {
  const { date, followers_count = null, import_source = 'manual' } = row;
  if (!isValidDate(date)) throw new Error(`writeXAccountDaily: date が不正です（値: ${date}）`);

  const fc = (typeof followers_count === 'number' && isFinite(followers_count) && followers_count >= 0)
    ? Math.floor(followers_count) : null;

  db.prepare(`
    INSERT INTO sf_x_account_daily (date, followers_count, import_source)
    VALUES (?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET
      followers_count = COALESCE(excluded.followers_count, followers_count),
      import_source   = excluded.import_source,
      fetched_at      = datetime('now','localtime')
  `).run(date, fc, import_source);

  return date;
}

// ── READ ──────────────────────────────────────────────────────────────────────

/**
 * ツイート一覧を最新スナップショット指標付きで取得する。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ from?: string, to?: string, tweet_type?: string, limit?: number }} [opts]
 * @returns {object[]}
 */
export function getXTweets(db, opts = {}) {
  const { from = null, to = null, tweet_type = null, limit = 100 } = opts;
  const params = [];
  const where = [];

  if (from && isValidDate(from)) { where.push('t.published_at >= ?'); params.push(from); }
  if (to   && isValidDate(to))   { where.push('t.published_at <= ?'); params.push(to + 'T99'); }
  if (tweet_type && VALID_TWEET_TYPES.includes(tweet_type)) {
    where.push('t.tweet_type = ?'); params.push(tweet_type);
  }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const lim = (Number.isInteger(limit) && limit > 0) ? limit : 100;
  params.push(lim);

  return db.prepare(`
    SELECT t.tweet_id, t.published_at, t.text_snippet, t.tweet_type,
           m.snapshot_date, m.impressions, m.engagements, m.retweets,
           m.replies, m.likes, m.url_clicks, m.profile_clicks,
           m.detail_expands, m.media_views, m.media_engagements
    FROM sf_x_tweet t
    LEFT JOIN sf_x_tweet_metrics m ON m.tweet_id = t.tweet_id
      AND m.snapshot_date = (
        SELECT MAX(m2.snapshot_date) FROM sf_x_tweet_metrics m2
        WHERE m2.tweet_id = t.tweet_id
      )
    ${whereClause}
    ORDER BY t.published_at DESC
    LIMIT ?
  `).all(...params);
}

/**
 * 指定期間内の投稿をインプレッション数上位で取得する。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ snapshot_date?: string, limit?: number }} [opts]
 * @returns {object[]}
 */
export function getXTweetsTop(db, opts = {}) {
  const { snapshot_date = null, limit = 10 } = opts;
  const lim = (Number.isInteger(limit) && limit > 0) ? limit : 10;
  const params = [];
  let where = '';

  if (snapshot_date && isValidDate(snapshot_date)) {
    where = 'WHERE m.snapshot_date = ?';
    params.push(snapshot_date);
  } else {
    where = `
      WHERE m.snapshot_date = (
        SELECT MAX(m2.snapshot_date) FROM sf_x_tweet_metrics m2
      )
    `;
  }
  params.push(lim);

  return db.prepare(`
    SELECT t.tweet_id, t.published_at, t.text_snippet, t.tweet_type,
           m.snapshot_date, m.impressions, m.engagements, m.retweets,
           m.replies, m.likes, m.url_clicks
    FROM sf_x_tweet t
    JOIN sf_x_tweet_metrics m ON m.tweet_id = t.tweet_id
    ${where}
    ORDER BY m.impressions DESC NULLS LAST
    LIMIT ?
  `).all(...params);
}

/**
 * アカウント日次スナップショットを日付範囲で取得する。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ from?: string, to?: string }} [opts]
 * @returns {object[]}
 */
export function getXAccountDaily(db, opts = {}) {
  const { from = null, to = null } = opts;
  const params = [];
  const where = [];

  if (from && isValidDate(from)) { where.push('date >= ?'); params.push(from); }
  if (to   && isValidDate(to))   { where.push('date <= ?'); params.push(to); }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  return db.prepare(`
    SELECT date, followers_count, import_source
    FROM sf_x_account_daily
    ${whereClause}
    ORDER BY date ASC
  `).all(...params);
}

/**
 * 期間集計サマリーを取得する（投稿数・インプレッション合計等）。
 * engagements の内訳（likes + retweets + replies）とは別に合算しない。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ snapshot_date?: string, from?: string, to?: string }} [opts]
 * @returns {{ tweet_count: number, total_impressions: number|null, total_engagements: number|null, total_likes: number|null, total_retweets: number|null, total_replies: number|null, by_type: object[] }}
 */
export function getXSummary(db, opts = {}) {
  const { snapshot_date = null, from = null, to = null } = opts;

  // 最新スナップショット日を基準にする（snapshot_date 指定がなければ MAX）
  let snapDate = snapshot_date;
  if (!snapDate || !isValidDate(snapDate)) {
    const row = db.prepare('SELECT MAX(snapshot_date) AS md FROM sf_x_tweet_metrics').get();
    snapDate = row?.md ?? null;
  }
  if (!snapDate) {
    return { tweet_count: 0, total_impressions: null, total_engagements: null, total_likes: null, total_retweets: null, total_replies: null, by_type: [] };
  }

  const dateWhere = [];
  const dateParams = [];
  if (from && isValidDate(from)) { dateWhere.push('t.published_at >= ?'); dateParams.push(from); }
  if (to   && isValidDate(to))   { dateWhere.push('t.published_at <= ?'); dateParams.push(to + 'T99'); }
  const dateClause = dateWhere.length ? `AND ${dateWhere.join(' AND ')}` : '';

  const summary = db.prepare(`
    SELECT
      COUNT(*)              AS tweet_count,
      SUM(m.impressions)    AS total_impressions,
      SUM(m.engagements)    AS total_engagements,
      SUM(m.likes)          AS total_likes,
      SUM(m.retweets)       AS total_retweets,
      SUM(m.replies)        AS total_replies
    FROM sf_x_tweet t
    JOIN sf_x_tweet_metrics m ON m.tweet_id = t.tweet_id AND m.snapshot_date = ?
    ${dateClause}
  `).get(snapDate, ...dateParams);

  const byType = db.prepare(`
    SELECT t.tweet_type,
           COUNT(*)           AS tweet_count,
           SUM(m.impressions) AS total_impressions
    FROM sf_x_tweet t
    JOIN sf_x_tweet_metrics m ON m.tweet_id = t.tweet_id AND m.snapshot_date = ?
    ${dateClause}
    GROUP BY t.tweet_type
    ORDER BY total_impressions DESC NULLS LAST
  `).all(snapDate, ...dateParams);

  return {
    snapshot_date:     snapDate,
    tweet_count:       summary.tweet_count ?? 0,
    total_impressions: summary.total_impressions ?? null,
    total_engagements: summary.total_engagements ?? null,
    total_likes:       summary.total_likes ?? null,
    total_retweets:    summary.total_retweets ?? null,
    total_replies:     summary.total_replies ?? null,
    by_type:           byType,
  };
}
