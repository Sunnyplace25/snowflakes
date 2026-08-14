/**
 * jarvis/data/sf_funnel_manager.js
 * Snow flakes ファネル分析 データマネージャー（Phase 9）
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 重要原則
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * - 個人ユーザー追跡を行わない。
 *   異なるプラットフォームの訪問者が同一人物であることは証明できない。
 *   Instagram から来た人物と GA サイト訪問者が同一かどうかは不明。
 *
 * - 因果関係を断定しない。
 *   Event Impact は「イベント前後の時系列変化（temporal signal）」であり
 *   因果推論ではない。caused_by / attributed_to フィールドは使用しない。
 *
 * - 異種指標の合算禁止。
 *   Instagram reach + GA users + Spotify streams を合計して
 *   「総流入人数」を作ることは禁止。source 別に保持する。
 *
 * - 月次データの日割り禁止。
 *   Narou（月次スナップショット）・Revenue（transaction_month 月粒度）は
 *   日次データとして補間・分割しない。granularity:'monthly' として別扱い。
 *
 * - 偽 conversion rate 禁止。
 *   異なる計測系同士（Instagram reach / GA users 等）から率を算出しない。
 *
 * - 分析結果そのものを DB へ保存しない（read-oriented manager）。
 *
 * - suggestFunnelEvents は候補提示のみ。自動 INSERT は絶対に行わない。
 *
 * - スキーマ変更なし・DB ファイル変更なし。
 *   既存 sf_funnel_event テーブルを分析基準点として再利用する。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 */

// ── 定数 ─────────────────────────────────────────────────────────────────────

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** sf_funnel_event.event_type の許可値（schema CHECK 制約と同期） */
export const VALID_EVENT_TYPES = [
  'novel_publish', 'novel_update', 'music_release', 'sns_post',
  'sweets_update', 'site_update', 'campaign_start', 'campaign_end',
];

/** sf_funnel_event.platform の許可値（スキーマに CHECK なし→アプリ層で検証） */
export const VALID_EVENT_PLATFORMS = [
  'youtube', 'instagram', 'tiktok', 'spotify',
  'apple_music', 'amazon_music', 'youtube_music', 'narou', 'site', 'x',
];

// ── ヘルパー関数 ──────────────────────────────────────────────────────────────

/**
 * YYYY-MM-DD 文字列に days 日を加算して返す（UTC 基準）。
 * 負の値で past 方向。
 * @param {string} dateStr - YYYY-MM-DD
 * @param {number} days    - 正負どちらも可
 * @returns {string} YYYY-MM-DD
 */
function addDays(dateStr, days) {
  const d = new Date(dateStr + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/**
 * before/after 変化量を計算する。
 *
 * percent_change ルール:
 *   - before_value が null → percent_change = null
 *   - before_value が 0   → percent_change = null（Infinity 禁止）
 *   - before_value > 0    → 通常計算（小数点2桁丸め）
 *
 * @param {number|null} beforeVal
 * @param {number|null} afterVal
 * @returns {{ absolute_change: number|null, percent_change: number|null }}
 */
function calcChange(beforeVal, afterVal) {
  if (beforeVal === null || afterVal === null) {
    return { absolute_change: null, percent_change: null };
  }
  const abs = afterVal - beforeVal;
  const pct = (beforeVal > 0)
    ? Math.round((abs / beforeVal) * 10000) / 100
    : null;
  return { absolute_change: abs, percent_change: pct };
}

/** null / undefined → null。0 はそのまま 0 で返す（有効なゼロ値として保持）。 */
function orNull(v) {
  return (v == null) ? null : v;
}

// ══════════════════════════════════════════════════════════════════════════════
// イベント CRUD
// ══════════════════════════════════════════════════════════════════════════════

/**
 * sf_funnel_event を取得する。
 *
 * 不正な filter 値（allowlist 外の event_type 等）は無視して安全に処理する。
 * SQL 識別子としてユーザー入力を展開しない（全てパラメータバインド）。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{
 *   from?: string,
 *   to?: string,
 *   eventType?: string,
 *   platform?: string,
 *   workId?: number|string,
 *   trackId?: number|string,
 * }} [options]
 * @returns {object[]}
 */
export function getFunnelEvents(db, options = {}) {
  const { from, to, eventType, platform, workId, trackId } = options;

  const parts  = ['1=1'];
  const params = [];

  if (from && DATE_RE.test(from)) {
    parts.push('date >= ?');
    params.push(from);
  }
  if (to && DATE_RE.test(to)) {
    parts.push('date <= ?');
    params.push(to);
  }
  // event_type: allowlist 検証済みのものだけ使用（不正値はフィルタなし扱い）
  if (eventType && VALID_EVENT_TYPES.includes(eventType)) {
    parts.push('event_type = ?');
    params.push(eventType);
  }
  if (platform) {
    parts.push('platform = ?');
    params.push(platform);
  }
  if (workId != null) {
    const id = Number(workId);
    if (Number.isInteger(id) && id > 0) {
      parts.push('work_id = ?');
      params.push(id);
    }
  }
  if (trackId != null) {
    const id = Number(trackId);
    if (Number.isInteger(id) && id > 0) {
      parts.push('track_id = ?');
      params.push(id);
    }
  }

  return db.prepare(
    `SELECT * FROM sf_funnel_event WHERE ${parts.join(' AND ')} ORDER BY date DESC, id DESC`,
  ).all(...params);
}

/**
 * sf_funnel_event に新規イベントを登録する。
 *
 * FK（content_reg_id / work_id / track_id）の存在を確認する。
 * 存在しない ID を黙って保存しない（推測紐付け禁止）。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{
 *   date: string,
 *   event_type: string,
 *   platform?: string|null,
 *   content_reg_id?: number|null,
 *   work_id?: number|null,
 *   track_id?: number|null,
 *   label?: string|null,
 *   memo?: string|null,
 * }} event
 * @returns {{ ok: boolean, id?: number, errors?: string[] }}
 */
export function createFunnelEvent(db, event) {
  const {
    date, event_type, platform,
    content_reg_id, work_id, track_id,
    label, memo,
  } = event ?? {};

  const errors = [];

  if (!date || !DATE_RE.test(date)) {
    errors.push('date は YYYY-MM-DD 形式が必要です');
  }
  if (!event_type || !VALID_EVENT_TYPES.includes(event_type)) {
    errors.push(`event_type が不正です（許可値: ${VALID_EVENT_TYPES.join(', ')}）`);
  }
  if (platform != null && !VALID_EVENT_PLATFORMS.includes(platform)) {
    errors.push(`platform が不正です（許可値: ${VALID_EVENT_PLATFORMS.join(', ')}）`);
  }

  if (errors.length > 0) return { ok: false, errors };

  // FK 存在確認（タイトル等による推測紐付けは行わない）
  if (content_reg_id != null) {
    const row = db.prepare('SELECT id FROM sf_content_registry WHERE id = ?').get(content_reg_id);
    if (!row) return { ok: false, errors: ['content_reg_id が sf_content_registry に存在しません'] };
  }
  if (work_id != null) {
    const row = db.prepare('SELECT id FROM sf_works WHERE id = ?').get(work_id);
    if (!row) return { ok: false, errors: ['work_id が sf_works に存在しません'] };
  }
  if (track_id != null) {
    const row = db.prepare('SELECT id FROM sf_tracks WHERE id = ?').get(track_id);
    if (!row) return { ok: false, errors: ['track_id が sf_tracks に存在しません'] };
  }

  const result = db.prepare(`
    INSERT INTO sf_funnel_event
      (date, event_type, platform, content_reg_id, work_id, track_id, label, memo)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    date,
    event_type,
    platform       ?? null,
    content_reg_id ?? null,
    work_id        ?? null,
    track_id       ?? null,
    label          ?? null,
    memo           ?? null,
  );

  return { ok: true, id: result.lastInsertRowid };
}

// ══════════════════════════════════════════════════════════════════════════════
// Funnel Overview
// ══════════════════════════════════════════════════════════════════════════════

/**
 * ファネル 4 Stage の集計概要を返す。
 *
 * Stage 1 DISCOVERY  : reach / impressions / views / site sessions
 * Stage 2 ENGAGEMENT : likes / comments / shares / saves / watch_time
 * Stage 3 DEEP INTEREST: narou PV / music streams / GA events
 * Stage 4 VALUE      : revenue
 *
 * !! 各 source 別に保持。合計して「総流入人数」を作らない !!
 * !! 偽 conversion rate（Instagram reach / GA users 等）を算出しない !!
 * !! 月次データ（Narou / Revenue）を日割りしない !!
 * !! データなし → 0 で捏造せず null で返す !!
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ from?: string, to?: string }} [options]
 * @returns {object}
 */
export function getFunnelOverview(db, options = {}) {
  const today     = new Date().toISOString().slice(0, 10);
  const actualTo  = (options.to   && DATE_RE.test(options.to))   ? options.to   : today;
  const actualFrom= (options.from && DATE_RE.test(options.from)) ? options.from : addDays(actualTo, -30);
  const fromMonth = actualFrom.slice(0, 7);
  const toMonth   = actualTo.slice(0, 7);

  // ── Stage 1: DISCOVERY ─────────────────────────────────────────────────────

  // Instagram: sf_instagram_account_daily (Phase 6 専用テーブル)
  const igAcc = db.prepare(`
    SELECT SUM(reach) AS reach, SUM(views) AS views
    FROM sf_instagram_account_daily
    WHERE date >= ? AND date <= ?
  `).get(actualFrom, actualTo);

  // YouTube: sf_youtube_channel_daily (Phase 7)
  const ytCh = db.prepare(`
    SELECT SUM(views) AS views
    FROM sf_youtube_channel_daily
    WHERE date >= ? AND date <= ?
  `).get(actualFrom, actualTo);

  // TikTok: sf_account_daily platform='tiktok' (Phase 8)
  const ttAcc = db.prepare(`
    SELECT SUM(reach) AS reach, SUM(impressions) AS impressions
    FROM sf_account_daily
    WHERE platform = 'tiktok' AND date >= ? AND date <= ?
  `).get(actualFrom, actualTo);

  // Site: sf_ga_daily（全ページ合計）
  const gaDay = db.prepare(`
    SELECT SUM(sessions) AS sessions, SUM(users) AS users,
           SUM(page_views) AS page_views, SUM(engaged_sessions) AS engaged_sessions
    FROM sf_ga_daily
    WHERE date >= ? AND date <= ?
  `).get(actualFrom, actualTo);

  // ── Stage 2: ENGAGEMENT ────────────────────────────────────────────────────

  const igEng = db.prepare(`
    SELECT SUM(likes) AS likes, SUM(comments) AS comments,
           SUM(shares) AS shares, SUM(saves) AS saves,
           SUM(accounts_engaged) AS accounts_engaged
    FROM sf_instagram_account_daily
    WHERE date >= ? AND date <= ?
  `).get(actualFrom, actualTo);

  const ytEng = db.prepare(`
    SELECT SUM(sm.likes) AS likes, SUM(sm.comments) AS comments,
           SUM(sm.watch_time_min) AS watch_time_min
    FROM sf_social_metrics sm
    JOIN sf_content_registry cr ON cr.id = sm.content_reg_id
    WHERE cr.platform = 'youtube'
      AND sm.snapshot_date >= ? AND sm.snapshot_date <= ?
  `).get(actualFrom, actualTo);

  const ttEng = db.prepare(`
    SELECT SUM(sm.likes) AS likes, SUM(sm.comments) AS comments,
           SUM(sm.shares) AS shares, SUM(sm.saves) AS saves,
           SUM(sm.watch_time_min) AS watch_time_min,
           AVG(sm.completion_rate) AS completion_rate
    FROM sf_social_metrics sm
    JOIN sf_content_registry cr ON cr.id = sm.content_reg_id
    WHERE cr.platform = 'tiktok'
      AND sm.snapshot_date >= ? AND sm.snapshot_date <= ?
  `).get(actualFrom, actualTo);

  // ── Stage 3: DEEP INTEREST ─────────────────────────────────────────────────

  // Narou: 月次スナップショット（日割り禁止）
  const narou = db.prepare(`
    SELECT SUM(pv_monthly) AS pv_monthly, SUM(bookmark_count) AS bookmark_count,
           SUM(review_count) AS review_count, SUM(point) AS point
    FROM sf_narou_snapshot
    WHERE month >= ? AND month <= ?
  `).get(fromMonth, toMonth);

  // Music: sf_music_metrics（日次集計）
  const music = db.prepare(`
    SELECT SUM(streams) AS streams, SUM(listeners) AS listeners,
           SUM(saves) AS saves, SUM(playlist_adds) AS playlist_adds
    FROM sf_music_metrics
    WHERE date >= ? AND date <= ?
  `).get(actualFrom, actualTo);

  // GA events（存在するイベントのみ、存在確認あり）
  const gaEvents = db.prepare(`
    SELECT event_name, SUM(count) AS total_count
    FROM sf_ga_event_daily
    WHERE date >= ? AND date <= ?
    GROUP BY event_name
    ORDER BY total_count DESC
  `).all(actualFrom, actualTo);

  // ── Stage 4: VALUE ─────────────────────────────────────────────────────────

  // Revenue: 月次粒度（日割り禁止）
  const revenue = db.prepare(`
    SELECT SUM(amount_jpy) AS amount_jpy, SUM(quantity) AS quantity
    FROM sf_revenue
    WHERE (transaction_month >= ? AND transaction_month <= ?)
       OR (transaction_month IS NULL AND month >= ? AND month <= ?)
  `).get(fromMonth, toMonth, fromMonth, toMonth);

  // ── Data Quality ───────────────────────────────────────────────────────────

  const unlinkedContentCount = db.prepare(`
    SELECT COUNT(*) AS cnt FROM sf_content_registry
    WHERE work_id IS NULL AND track_id IS NULL
  `).get().cnt;

  const missing_sources = [];
  if (orNull(igAcc?.reach) === null && orNull(igAcc?.views) === null) {
    missing_sources.push('instagram');
  }
  if (orNull(ytCh?.views) === null) {
    missing_sources.push('youtube');
  }
  if (orNull(ttAcc?.reach) === null && orNull(ttAcc?.impressions) === null) {
    missing_sources.push('tiktok');
  }
  if (orNull(gaDay?.sessions) === null && orNull(gaDay?.users) === null) {
    missing_sources.push('ga4');
  }
  if (orNull(music?.streams) === null && orNull(music?.listeners) === null) {
    missing_sources.push('music');
  }

  const warnings = [];
  if (unlinkedContentCount > 0) {
    warnings.push(`${unlinkedContentCount}件のコンテンツが作品・楽曲に未紐付けです`);
  }

  // ── Result ─────────────────────────────────────────────────────────────────
  // 異種指標を合算して「総流入人数」フィールドは作らない

  return {
    from: actualFrom,
    to:   actualTo,
    stages: {
      discovery: {
        social: {
          instagram: {
            reach: orNull(igAcc?.reach),
            views: orNull(igAcc?.views),
          },
          youtube: {
            views: orNull(ytCh?.views),
          },
          tiktok: {
            reach:       orNull(ttAcc?.reach),
            impressions: orNull(ttAcc?.impressions),
          },
        },
        site: {
          sessions: orNull(gaDay?.sessions),
          users:    orNull(gaDay?.users),
        },
      },
      engagement: {
        social: {
          instagram: {
            likes:            orNull(igEng?.likes),
            comments:         orNull(igEng?.comments),
            shares:           orNull(igEng?.shares),
            saves:            orNull(igEng?.saves),
            accounts_engaged: orNull(igEng?.accounts_engaged),
          },
          youtube: {
            likes:          orNull(ytEng?.likes),
            comments:       orNull(ytEng?.comments),
            watch_time_min: orNull(ytEng?.watch_time_min),
          },
          tiktok: {
            likes:           orNull(ttEng?.likes),
            comments:        orNull(ttEng?.comments),
            shares:          orNull(ttEng?.shares),
            saves:           orNull(ttEng?.saves),
            watch_time_min:  orNull(ttEng?.watch_time_min),
            completion_rate: orNull(ttEng?.completion_rate),
          },
        },
        site: {
          engaged_sessions: orNull(gaDay?.engaged_sessions),
          page_views:       orNull(gaDay?.page_views),
        },
      },
      deep_interest: {
        narou: {
          pv_monthly:     orNull(narou?.pv_monthly),
          bookmark_count: orNull(narou?.bookmark_count),
          review_count:   orNull(narou?.review_count),
          point:          orNull(narou?.point),
          granularity:    'monthly',  // 月次。日割り不可
        },
        music: {
          streams:       orNull(music?.streams),
          listeners:     orNull(music?.listeners),
          saves:         orNull(music?.saves),
          playlist_adds: orNull(music?.playlist_adds),
        },
        ga_events: gaEvents,
      },
      value: {
        revenue: {
          amount_jpy:  orNull(revenue?.amount_jpy),
          quantity:    orNull(revenue?.quantity),
          granularity: 'monthly',  // 月次。日割り不可
        },
      },
    },
    data_quality: {
      missing_sources,
      monthly_only_sources: ['narou', 'revenue'],
      unlinked_content_count: unlinkedContentCount,
      warnings,
    },
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// Event Impact 分析
// ══════════════════════════════════════════════════════════════════════════════

/**
 * イベント前後の指標変化を返す（時系列 signal）。
 *
 * !! 因果関係を断定しない !!
 *   これは「イベント前後の時系列変化」であり因果推論ではない。
 *   caused_by / attributed_to のようなフィールドは使用しない。
 *
 * !! 月次データは日次 before/after 比較が不可能 !!
 *   Revenue / Narou → not_comparable: true / granularity: 'monthly'
 *   Music に monthly 粒度データが存在する場合も同様。
 *
 * percent_change ルール:
 *   before_value = 0 → null（Infinity 禁止）
 *   before_value = null → null
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{
 *   eventId: number,
 *   beforeDays?: number,  // 1〜90、デフォルト 7
 *   afterDays?:  number,  // 1〜90、デフォルト 7
 * }} options
 * @returns {object|null} イベントが存在しない場合は null
 */
export function getEventImpact(db, options = {}) {
  const { eventId, beforeDays = 7, afterDays = 7 } = options;

  const event = db.prepare('SELECT * FROM sf_funnel_event WHERE id = ?').get(eventId);
  if (!event) return null;

  const eventDate  = event.date;
  const beforeFrom = addDays(eventDate, -beforeDays);
  const beforeTo   = addDays(eventDate, -1);
  const afterFrom  = addDays(eventDate,  1);
  const afterTo    = addDays(eventDate,  afterDays);

  const metrics = [];

  // ── GA4 日次 ───────────────────────────────────────────────────────────────
  {
    const bRow = db.prepare(`
      SELECT SUM(sessions) AS sessions, SUM(users) AS users,
             SUM(page_views) AS page_views, SUM(engaged_sessions) AS engaged_sessions
      FROM sf_ga_daily WHERE date >= ? AND date <= ?
    `).get(beforeFrom, beforeTo);

    const aRow = db.prepare(`
      SELECT SUM(sessions) AS sessions, SUM(users) AS users,
             SUM(page_views) AS page_views, SUM(engaged_sessions) AS engaged_sessions
      FROM sf_ga_daily WHERE date >= ? AND date <= ?
    `).get(afterFrom, afterTo);

    for (const m of ['sessions', 'users', 'page_views', 'engaged_sessions']) {
      const bv = orNull(bRow?.[m]);
      const av = orNull(aRow?.[m]);
      metrics.push({
        source: 'ga4', metric: m, granularity: 'daily',
        before_period: { from: beforeFrom, to: beforeTo },
        after_period:  { from: afterFrom,  to: afterTo  },
        before_value: bv, after_value: av, ...calcChange(bv, av),
      });
    }
  }

  // ── Instagram アカウント日次 ───────────────────────────────────────────────
  {
    const bRow = db.prepare(`
      SELECT SUM(reach) AS reach, SUM(views) AS views, SUM(likes) AS likes,
             SUM(comments) AS comments, SUM(shares) AS shares, SUM(saves) AS saves
      FROM sf_instagram_account_daily WHERE date >= ? AND date <= ?
    `).get(beforeFrom, beforeTo);

    const aRow = db.prepare(`
      SELECT SUM(reach) AS reach, SUM(views) AS views, SUM(likes) AS likes,
             SUM(comments) AS comments, SUM(shares) AS shares, SUM(saves) AS saves
      FROM sf_instagram_account_daily WHERE date >= ? AND date <= ?
    `).get(afterFrom, afterTo);

    for (const m of ['reach', 'views', 'likes', 'comments', 'shares', 'saves']) {
      const bv = orNull(bRow?.[m]);
      const av = orNull(aRow?.[m]);
      metrics.push({
        source: 'instagram', metric: m, granularity: 'daily',
        before_period: { from: beforeFrom, to: beforeTo },
        after_period:  { from: afterFrom,  to: afterTo  },
        before_value: bv, after_value: av, ...calcChange(bv, av),
      });
    }
  }

  // ── YouTube チャンネル日次 ─────────────────────────────────────────────────
  {
    const bRow = db.prepare(`
      SELECT SUM(views) AS views,
             SUM(estimated_minutes_watched) AS estimated_minutes_watched
      FROM sf_youtube_channel_daily WHERE date >= ? AND date <= ?
    `).get(beforeFrom, beforeTo);

    const aRow = db.prepare(`
      SELECT SUM(views) AS views,
             SUM(estimated_minutes_watched) AS estimated_minutes_watched
      FROM sf_youtube_channel_daily WHERE date >= ? AND date <= ?
    `).get(afterFrom, afterTo);

    for (const m of ['views', 'estimated_minutes_watched']) {
      const bv = orNull(bRow?.[m]);
      const av = orNull(aRow?.[m]);
      metrics.push({
        source: 'youtube', metric: m, granularity: 'daily',
        before_period: { from: beforeFrom, to: beforeTo },
        after_period:  { from: afterFrom,  to: afterTo  },
        before_value: bv, after_value: av, ...calcChange(bv, av),
      });
    }
  }

  // ── TikTok アカウント日次 ──────────────────────────────────────────────────
  {
    const bRow = db.prepare(`
      SELECT SUM(reach) AS reach, SUM(impressions) AS impressions
      FROM sf_account_daily WHERE platform = 'tiktok' AND date >= ? AND date <= ?
    `).get(beforeFrom, beforeTo);

    const aRow = db.prepare(`
      SELECT SUM(reach) AS reach, SUM(impressions) AS impressions
      FROM sf_account_daily WHERE platform = 'tiktok' AND date >= ? AND date <= ?
    `).get(afterFrom, afterTo);

    for (const m of ['reach', 'impressions']) {
      const bv = orNull(bRow?.[m]);
      const av = orNull(aRow?.[m]);
      metrics.push({
        source: 'tiktok', metric: m, granularity: 'daily',
        before_period: { from: beforeFrom, to: beforeTo },
        after_period:  { from: afterFrom,  to: afterTo  },
        before_value: bv, after_value: av, ...calcChange(bv, av),
      });
    }
  }

  // ── Music（日次 vs 月次確認）─────────────────────────────────────────────
  {
    const hasMonthly = db.prepare(`
      SELECT COUNT(*) AS cnt FROM sf_music_metrics WHERE granularity = 'monthly'
    `).get().cnt > 0;

    if (hasMonthly) {
      // 月次データが存在 → 日次 before/after 比較不可
      for (const m of ['streams', 'listeners', 'saves', 'playlist_adds']) {
        metrics.push({
          source: 'music', metric: m, granularity: 'monthly',
          not_comparable: true,
          note: '月次データは日次before/afterとの直接比較が不可能です',
        });
      }
    } else {
      const bRow = db.prepare(`
        SELECT SUM(streams) AS streams, SUM(listeners) AS listeners,
               SUM(saves) AS saves, SUM(playlist_adds) AS playlist_adds
        FROM sf_music_metrics WHERE date >= ? AND date <= ?
      `).get(beforeFrom, beforeTo);

      const aRow = db.prepare(`
        SELECT SUM(streams) AS streams, SUM(listeners) AS listeners,
               SUM(saves) AS saves, SUM(playlist_adds) AS playlist_adds
        FROM sf_music_metrics WHERE date >= ? AND date <= ?
      `).get(afterFrom, afterTo);

      for (const m of ['streams', 'listeners', 'saves', 'playlist_adds']) {
        const bv = orNull(bRow?.[m]);
        const av = orNull(aRow?.[m]);
        metrics.push({
          source: 'music', metric: m, granularity: 'daily',
          before_period: { from: beforeFrom, to: beforeTo },
          after_period:  { from: afterFrom,  to: afterTo  },
          before_value: bv, after_value: av, ...calcChange(bv, av),
        });
      }
    }
  }

  // ── Revenue（常に月次 → 比較不可）────────────────────────────────────────
  for (const m of ['amount_jpy', 'quantity']) {
    metrics.push({
      source: 'revenue', metric: m, granularity: 'monthly',
      not_comparable: true,
      note: '月次データは日次before/afterとの直接比較が不可能です',
    });
  }

  // ── Narou（常に月次 → 比較不可）──────────────────────────────────────────
  for (const m of ['pv_monthly', 'bookmark_count', 'review_count', 'point']) {
    metrics.push({
      source: 'narou', metric: m, granularity: 'monthly',
      not_comparable: true,
      note: '月次データは日次before/afterとの直接比較が不可能です',
    });
  }

  return {
    event,
    event_date:    eventDate,
    before_period: { from: beforeFrom, to: beforeTo, days: beforeDays },
    after_period:  { from: afterFrom,  to: afterTo,  days: afterDays  },
    // 因果関係の断定禁止：temporal signal（時系列変化）として明示
    note: 'これはイベント前後の時系列変化（temporal signal）であり、因果関係を示すものではありません',
    metrics,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// Work / Track 横断分析
// ══════════════════════════════════════════════════════════════════════════════

/**
 * 特定作品に紐づく分析データを返す。
 *
 * !! work_id = NULL のコンテンツを推測で紐付けない !!
 *    タイトル文字列の類似等による自動紐付けは禁止。
 *    unlinked コンテンツはそのまま unlinked として扱う。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} workId
 * @param {{ from?: string, to?: string }} [options]
 * @returns {object|null} 作品が存在しない場合は null
 */
export function getWorkFunnel(db, workId, options = {}) {
  const work = db.prepare('SELECT * FROM sf_works WHERE id = ?').get(workId);
  if (!work) return null;

  const today     = new Date().toISOString().slice(0, 10);
  const actualTo  = (options.to   && DATE_RE.test(options.to))   ? options.to   : today;
  const actualFrom= (options.from && DATE_RE.test(options.from)) ? options.from : addDays(actualTo, -90);
  const fromMonth = actualFrom.slice(0, 7);
  const toMonth   = actualTo.slice(0, 7);

  const events = db.prepare(`
    SELECT * FROM sf_funnel_event WHERE work_id = ? ORDER BY date DESC
  `).all(workId);

  const content = db.prepare(`
    SELECT cr.*,
      (SELECT SUM(sm.views) FROM sf_social_metrics sm
       WHERE sm.content_reg_id = cr.id) AS total_views,
      (SELECT SUM(sm.likes) FROM sf_social_metrics sm
       WHERE sm.content_reg_id = cr.id) AS total_likes
    FROM sf_content_registry cr
    WHERE cr.work_id = ?
    ORDER BY cr.published_at DESC
  `).all(workId);

  const narou = db.prepare(`
    SELECT month, ncode, title, pv_monthly, bookmark_count, review_count, point
    FROM sf_narou_snapshot
    WHERE work_id = ? AND month >= ? AND month <= ?
    ORDER BY month DESC
  `).all(workId, fromMonth, toMonth);

  const revenue = db.prepare(`
    SELECT SUM(amount_jpy) AS amount_jpy, SUM(quantity) AS quantity
    FROM sf_revenue
    WHERE work_id = ?
      AND ((transaction_month >= ? AND transaction_month <= ?)
        OR (transaction_month IS NULL AND month >= ? AND month <= ?))
  `).get(workId, fromMonth, toMonth, fromMonth, toMonth);

  return {
    work,
    from:    actualFrom,
    to:      actualTo,
    events,
    content,
    narou:   { data: narou, granularity: 'monthly' },
    revenue: {
      amount_jpy:  orNull(revenue?.amount_jpy),
      quantity:    orNull(revenue?.quantity),
      granularity: 'monthly',
    },
  };
}

/**
 * 特定楽曲に紐づく分析データを返す。
 *
 * !! track_id = NULL のコンテンツを推測で紐付けない !!
 *    タイトル文字列の類似等による自動紐付けは禁止。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} trackId
 * @param {{ from?: string, to?: string }} [options]
 * @returns {object|null} 楽曲が存在しない場合は null
 */
export function getTrackFunnel(db, trackId, options = {}) {
  const track = db.prepare('SELECT * FROM sf_tracks WHERE id = ?').get(trackId);
  if (!track) return null;

  const today     = new Date().toISOString().slice(0, 10);
  const actualTo  = (options.to   && DATE_RE.test(options.to))   ? options.to   : today;
  const actualFrom= (options.from && DATE_RE.test(options.from)) ? options.from : addDays(actualTo, -90);
  const fromMonth = actualFrom.slice(0, 7);
  const toMonth   = actualTo.slice(0, 7);

  const events = db.prepare(`
    SELECT * FROM sf_funnel_event WHERE track_id = ? ORDER BY date DESC
  `).all(trackId);

  const content = db.prepare(`
    SELECT cr.*,
      (SELECT SUM(sm.views) FROM sf_social_metrics sm
       WHERE sm.content_reg_id = cr.id) AS total_views,
      (SELECT SUM(sm.likes) FROM sf_social_metrics sm
       WHERE sm.content_reg_id = cr.id) AS total_likes
    FROM sf_content_registry cr
    WHERE cr.track_id = ?
    ORDER BY cr.published_at DESC
  `).all(trackId);

  const musicByPlatform = db.prepare(`
    SELECT platform,
           SUM(streams)       AS streams,
           SUM(listeners)     AS listeners,
           SUM(saves)         AS saves,
           SUM(playlist_adds) AS playlist_adds
    FROM sf_music_metrics
    WHERE track_id = ? AND date >= ? AND date <= ?
    GROUP BY platform
    ORDER BY streams DESC NULLS LAST
  `).all(trackId, actualFrom, actualTo);

  const revenue = db.prepare(`
    SELECT SUM(amount_jpy) AS amount_jpy, SUM(quantity) AS quantity
    FROM sf_revenue
    WHERE track_id = ?
      AND ((transaction_month >= ? AND transaction_month <= ?)
        OR (transaction_month IS NULL AND month >= ? AND month <= ?))
  `).get(trackId, fromMonth, toMonth, fromMonth, toMonth);

  const linkedWorks = db.prepare(`
    SELECT w.id, w.title, w.work_type, l.link_type
    FROM sf_track_work_links l
    JOIN sf_works w ON w.id = l.work_id
    WHERE l.track_id = ?
    ORDER BY l.link_type
  `).all(trackId);

  return {
    track,
    from:    actualFrom,
    to:      actualTo,
    events,
    content,
    music_by_platform: musicByPlatform,
    revenue: {
      amount_jpy:  orNull(revenue?.amount_jpy),
      quantity:    orNull(revenue?.quantity),
      granularity: 'monthly',
    },
    linked_works: linkedWorks,
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// イベント候補生成（提案のみ・自動 INSERT 禁止）
// ══════════════════════════════════════════════════════════════════════════════

/**
 * 既存の日付データからファネルイベント候補を提案する純粋関数。
 *
 * !! sf_funnel_event へ自動 INSERT しない !!
 *    返値をユーザーが確認して createFunnelEvent で登録する前提。
 *    タイトル文字列の類似による推測紐付けも行わない。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {object[]} 候補イベントリスト（id なし・未確定）
 */
export function suggestFunnelEvents(db) {
  const suggestions = [];

  // sf_content_registry.published_at → 未登録 SNS 投稿候補
  const unregContent = db.prepare(`
    SELECT cr.id, cr.platform, cr.content_type, cr.title,
           cr.published_at, cr.work_id, cr.track_id
    FROM sf_content_registry cr
    WHERE cr.published_at IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM sf_funnel_event fe WHERE fe.content_reg_id = cr.id
      )
    ORDER BY cr.published_at DESC
    LIMIT 20
  `).all();

  for (const c of unregContent) {
    suggestions.push({
      suggested_date:       c.published_at.slice(0, 10),
      suggested_event_type: 'sns_post',
      platform:             c.platform,
      content_reg_id:       c.id,
      work_id:              c.work_id   ?? null,
      track_id:             c.track_id  ?? null,
      label:                c.title     ?? `${c.platform} ${c.content_type}`,
      reason:               '未登録のSNS投稿から候補生成',
    });
  }

  // sf_tracks.release_date → 未登録 music_release 候補
  const unregTracks = db.prepare(`
    SELECT t.id, t.title, t.release_date
    FROM sf_tracks t
    WHERE t.release_date IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM sf_funnel_event fe
        WHERE fe.track_id = t.id AND fe.event_type = 'music_release'
      )
    ORDER BY t.release_date DESC
    LIMIT 10
  `).all();

  for (const t of unregTracks) {
    suggestions.push({
      suggested_date:       t.release_date.slice(0, 10),
      suggested_event_type: 'music_release',
      platform:             null,
      track_id:             t.id,
      label:                `${t.title} リリース`,
      reason:               '未登録の楽曲リリース日から候補生成',
    });
  }

  // sf_works.published_at → 未登録 novel_publish 候補
  const unregWorks = db.prepare(`
    SELECT w.id, w.title, w.work_type, w.published_at
    FROM sf_works w
    WHERE w.published_at IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM sf_funnel_event fe
        WHERE fe.work_id = w.id
          AND fe.event_type IN ('novel_publish', 'novel_update')
      )
    ORDER BY w.published_at DESC
    LIMIT 10
  `).all();

  for (const w of unregWorks) {
    const et = (w.work_type === 'novel' || w.work_type === 'short_story')
      ? 'novel_publish' : 'site_update';
    suggestions.push({
      suggested_date:       w.published_at.slice(0, 10),
      suggested_event_type: et,
      work_id:              w.id,
      label:                `${w.title} 公開`,
      reason:               '未登録の作品公開日から候補生成',
    });
  }

  return suggestions;
}
