/**
 * jarvis/importers/metricool_tiktok_collector.js
 * Metricool MCP 経由 TikTok データ収集コレクター
 *
 * 収集対象:
 *   - アカウント日次（フォロワー・フォロワー増減・プロフィール閲覧）→ sf_account_daily
 *   - 動画別メトリクス（再生数・いいね・コメント等）の累積スナップショット
 *     → sf_content_registry + sf_social_metrics
 *
 * ── メトリクス対応表 ──────────────────────────────────────────────────────────
 *
 * アカウント系 (TKEV):
 *   TKEV07 → sf_account_daily.followers       （フォロワー総数スナップショット）
 *   TKEV08 → sf_account_daily.followers_delta  （日次フォロワー増減）
 *   TKEV09 → sf_account_daily.profile_visits   （プロフィール表示数）
 *   ※ reach / impressions / link_clicks は TikTok API 経由では意味が合わないため保存しない
 *   ※ TKEV02（動画再生数）は video_views であり account-level reach ではないため保存禁止
 *
 * 動画系 (TKPO):
 *   TKPO01 → sf_content_registry.published_at   （投稿日時 "YYYYMMDDHHMMSS" → ISO）
 *   TKPO03 → sf_content_registry.platform_id    （URL からビデオIDを抽出）
 *   TKPO05 → sf_content_registry.title          （キャプション）
 *   TKPO06 → sf_content_registry.duration_sec   （秒）
 *   TKPO07 → sf_social_metrics.views            （総再生数・累積スナップショット）
 *   TKPO08 → sf_social_metrics.likes
 *   TKPO09 → sf_social_metrics.comments
 *   TKPO10 → sf_social_metrics.shares
 *   TKPO11 → sf_social_metrics.reach            （ユニーク視聴者数。null の場合は保存しない）
 *   TKPO13 → sf_social_metrics.completion_rate  （完走率。API が null の場合は必ず NULL 保存）
 *             ※ いいね率や再生数から計算して代入することは絶対禁止
 *   TKPO14 → sf_social_metrics.watch_time_min   （累積視聴時間秒 ÷ 60 で分換算）
 *   TKPO15 → sf_social_metrics.avg_watch_sec    （平均視聴時間秒）
 *   saves  → NULL（TikTok API では取得不可）
 *   TKPO9999 → 保存しない（エンゲージメント率はインタラクション/リーチで計算可能なため）
 *
 * ── 認証情報の管理 ────────────────────────────────────────────────────────────
 *   CLIENT_ID     : .env の METRICOOL_CLIENT_ID を使用
 *   REFRESH_TOKEN : data/.metricool_creds.json に保存（原子的書き込み）
 *   .env は自動書き換えしない（refresh_token ローテーション時も .env は変更しない）
 *
 * ── 安全性 ───────────────────────────────────────────────────────────────────
 *   - DB 書き込みは UPSERT + COALESCE で冪等（重複登録なし・既存値保護）
 *   - refresh_token 更新は原子的書き込み（.tmp → rename）
 *   - アクセストークン・リフレッシュトークンはログに出力しない
 *   - Instagram / YouTube 同期には一切影響しない
 */

import { writeFileSync, readFileSync, existsSync, renameSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── 設定 ──────────────────────────────────────────────────────────────────────

const MCP_ENDPOINT   = 'https://ai.metricool.com/mcp';
const TOKEN_ENDPOINT = 'https://app.metricool.com/oauth/token';
const BRAND_ID       = '7353308';  // snowflakes_story brand（Metricool で確認済み）
const CREDS_PATH     = resolve(__dirname, '../data/.metricool_creds.json');
const SYNC_DAYS      = 30;  // 取得期間（日）

/**
 * アカウント日次メトリクスのIDリスト（この順番でリクエストする）
 * INDEX 0: TKEV07, 1: TKEV08, 2: TKEV09
 */
const ACCOUNT_METRIC_IDS = ['TKEV07', 'TKEV08', 'TKEV09'];
const ACCOUNT_IDX = { followers: 0, followers_delta: 1, profile_visits: 2 };

/**
 * 動画メトリクスのIDリスト（この順番でリクエストする）
 * INDEX: 0=TKPO01, 1=TKPO03, 2=TKPO05, 3=TKPO06, 4=TKPO07,
 *        5=TKPO08, 6=TKPO09, 7=TKPO10, 8=TKPO11, 9=TKPO13,
 *        10=TKPO14, 11=TKPO15
 */
const VIDEO_METRIC_IDS = [
  'TKPO01',  // 投稿日  (公開日のみ、時刻なし)
  'TKPO03',  // 動画URL (platform_id 抽出用)
  'TKPO05',  // キャプション
  'TKPO06',  // 動画長（秒）
  'TKPO07',  // 総再生数
  'TKPO08',  // いいね数
  'TKPO09',  // コメント数
  'TKPO10',  // シェア数
  'TKPO11',  // リーチ（ユニーク視聴者）
  'TKPO13',  // 完走率（0〜100 もしくは null）← 計算値で補完しないこと
  'TKPO14',  // 累積視聴時間（秒）
  'TKPO15',  // 平均視聴時間（秒）
];
const V_IDX = {
  pub_date: 0, url: 1, caption: 2, duration: 3,
  views: 4, likes: 5, comments: 6, shares: 7,
  reach: 8, completion_rate: 9,
  watch_time_sec: 10, avg_watch_sec: 11,
};

// ── 認証情報管理 ─────────────────────────────────────────────────────────────

/**
 * 認証情報を読み込む。
 * data/.metricool_creds.json があればそちらを優先。
 * なければ .env の METRICOOL_REFRESH_TOKEN をフォールバックとして使用し、
 * 読み込めた場合は JSON ファイルに移行保存する。
 */
function loadCreds() {
  const clientId = process.env.METRICOOL_CLIENT_ID;
  if (!clientId) throw new Error('METRICOOL_CLIENT_ID が未設定です');

  let refreshToken = null;

  if (existsSync(CREDS_PATH)) {
    try {
      const data = JSON.parse(readFileSync(CREDS_PATH, 'utf-8'));
      refreshToken = data.refresh_token || null;
    } catch {
      // JSON 破損時は .env フォールバックへ
    }
  }

  // フォールバック: .env の値を使い、JSON に移行
  if (!refreshToken) {
    refreshToken = process.env.METRICOOL_REFRESH_TOKEN || null;
    if (refreshToken) {
      saveCreds(clientId, refreshToken);
    }
  }

  if (!refreshToken) {
    throw new Error(
      'Metricool refresh_token が未設定です。' +
      'METRICOOL_REFRESH_TOKEN を .env に設定するか、' +
      'metricool_explore.mjs で認証してください。'
    );
  }

  return { clientId, refreshToken };
}

/**
 * refresh_token を原子的に更新する（.tmp ファイル経由でリネーム）。
 * トークン値はログに出力しない。
 */
function saveCreds(clientId, refreshToken) {
  const tmp = CREDS_PATH + '.tmp';
  try {
    writeFileSync(tmp, JSON.stringify({ client_id: clientId, refresh_token: refreshToken }, null, 2), 'utf-8');
    renameSync(tmp, CREDS_PATH);
  } catch (e) {
    // tmp ファイルが残った場合は無視（次回上書きされる）
    throw new Error(`認証情報の保存に失敗しました: ${e.message}`);
  }
}

// ── OAuth トークン取得 ────────────────────────────────────────────────────────

/**
 * refresh_token で access_token を取得する。
 * ローテーション型の場合は新しい refresh_token も保存する。
 * アクセストークン値はログに出力しない。
 */
async function getAccessToken() {
  const { clientId, refreshToken } = loadCreds();

  const res = await fetch(TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: refreshToken,
      client_id:     clientId,
      scope:         'mcp:read',
    }).toString(),
  });

  if (!res.ok) {
    const body = await res.text();
    // トークン値を含む可能性があるため body はログに出さない
    throw new Error(`Metricool token refresh 失敗 (HTTP ${res.status})`);
  }

  const tokens = await res.json();

  if (!tokens.access_token) {
    throw new Error('access_token が返されませんでした');
  }

  // ローテーション型: 新しい refresh_token が返されたら保存
  if (tokens.refresh_token && tokens.refresh_token !== refreshToken) {
    saveCreds(clientId, tokens.refresh_token);
  }

  return tokens.access_token;
}

// ── Metricool MCP 呼び出し ────────────────────────────────────────────────────

let _mcpReqId = 1;

async function mcpPost(accessToken, method, params = {}) {
  const res = await fetch(MCP_ENDPOINT, {
    method:  'POST',
    headers: {
      'Content-Type':  'application/json',
      'Accept':        'application/json, text/event-stream',
      // Bearer トークン値はレスポンス・エラーに混入しないよう MCP 側が管理
      'Authorization': `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id:      _mcpReqId++,
      method,
      params,
    }),
  });

  const ct = res.headers.get('content-type') || '';

  if (ct.includes('text/event-stream')) {
    const text = await res.text();
    let last = null;
    for (const line of text.split('\n')) {
      if (!line.startsWith('data:')) continue;
      try {
        const obj = JSON.parse(line.slice(5).trim());
        if (obj.result !== undefined) last = obj.result;
        if (obj.error) throw new Error(`MCP エラー: ${JSON.stringify(obj.error)}`);
      } catch (_) { /* パース失敗は無視 */ }
    }
    return last;
  }

  // Bearer トークンが含まれる可能性があるためエラー本文はサニタイズ
  if (!res.ok) {
    throw new Error(`MCP HTTP ${res.status} (詳細はサーバーログを確認)`);
  }

  const json = await res.json();
  if (json.error) throw new Error(`MCP エラー: ${JSON.stringify(json.error)}`);
  return json.result;
}

async function mcpInit(accessToken) {
  return mcpPost(accessToken, 'initialize', {
    protocolVersion: '2024-11-05',
    capabilities:    {},
    clientInfo:      { name: 'JARVIS-TikTok-Collector', version: '1.0' },
  });
}

async function mcpGetAnalytics(accessToken, metricIds, from, to) {
  const result = await mcpPost(accessToken, 'tools/call', {
    name:      'getAnalyticsDataByMetrics',
    arguments: {
      brandId: BRAND_ID,
      metrics: metricIds,
      from,
      to,
    },
  });

  const text = result?.content?.[0]?.text || '';

  if (result?.isError) {
    // Bearer トークンがエラーテキストに含まれる可能性 → サニタイズして throw
    const safe = text.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]');
    throw new Error(`getAnalyticsDataByMetrics 失敗: ${safe.slice(0, 200)}`);
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`getAnalyticsDataByMetrics レスポンスの JSON 解析失敗（先頭200字: ${text.slice(0, 200)}）`);
  }
}

// ── データ解析ユーティリティ ──────────────────────────────────────────────────

/**
 * Metricool レスポンスの日付文字列を YYYY-MM-DD 形式に変換する。
 * 入力形式: "20261012" または "20261012143037"
 * @param {string|null} s
 * @returns {string|null}
 */
function parseMetricoolDate(s) {
  if (!s || typeof s !== 'string') return null;
  const digits = s.replace(/\D/g, '');
  if (digits.length < 8) return null;
  return `${digits.slice(0,4)}-${digits.slice(4,6)}-${digits.slice(6,8)}`;
}

/**
 * TikTok 動画 URL からビデオ ID を抽出する。
 * 例: https://www.tiktok.com/@handle/video/7687995896142777621?...
 * → "7687995896142777621"
 */
function extractVideoId(url) {
  if (!url) return null;
  const m = String(url).match(/\/video\/(\d+)/);
  return m ? m[1] : null;
}

/**
 * null/undefined/空文字列 を null に正規化し、数値に変換できる場合のみ返す。
 * @param {any} v
 * @returns {number|null}
 */
function toIntOrNull(v) {
  if (v === null || v === undefined || v === '' || v === 'null') return null;
  const n = parseFloat(String(v));
  return Number.isFinite(n) ? Math.round(n) : null;
}

/**
 * @param {any} v
 * @returns {number|null}
 */
function toFloatOrNull(v) {
  if (v === null || v === undefined || v === '' || v === 'null') return null;
  const n = parseFloat(String(v));
  return Number.isFinite(n) ? n : null;
}

// ── アカウント日次データの解析 ────────────────────────────────────────────────

/**
 * TKEV07/08/09 メトリクスのレスポンス行をアカウント日次レコードに変換する。
 *
 * Metricool は各行の末尾に日付（YYYYMMDD）を付加する。
 * 各行は ACCOUNT_METRIC_IDS 順のスパース配列。
 *
 * @param {{ rows: Array<Array<any>> }} data
 * @returns {Array<{ date: string, followers: number|null, followers_delta: number|null, profile_visits: number|null }>}
 */
function parseAccountRows(data) {
  if (!data?.rows) return [];
  const results = [];

  for (const row of data.rows) {
    if (!Array.isArray(row) || row.length === 0) continue;

    // 末尾が日付文字列（8桁以上の数字）のはずだが念のため確認
    const lastVal = String(row[row.length - 1] ?? '');
    const date = parseMetricoolDate(lastVal);
    if (!date) continue;

    // ACCOUNT_METRIC_IDS と同じ順番でインデックスが対応している前提
    const dataValues = row.slice(0, -1);  // 末尾の日付を除く

    const followers       = toIntOrNull(dataValues[ACCOUNT_IDX.followers]);
    const followers_delta = toIntOrNull(dataValues[ACCOUNT_IDX.followers_delta]);
    const profile_visits  = toIntOrNull(dataValues[ACCOUNT_IDX.profile_visits]);

    // 全ての値が null の行はスキップ（無意味なデータ）
    if (followers === null && followers_delta === null && profile_visits === null) continue;

    results.push({ date, followers, followers_delta, profile_visits });
  }

  return results;
}

// ── 動画データの解析 ──────────────────────────────────────────────────────────

/**
 * TKPO メトリクスのレスポンス行を動画レコードに変換する。
 *
 * @param {{ rows: Array<Array<any>> }} data
 * @returns {Array<{
 *   platform_id: string,
 *   published_at: string|null,
 *   caption: string|null,
 *   duration_sec: number|null,
 *   views: number|null,
 *   likes: number|null,
 *   comments: number|null,
 *   shares: number|null,
 *   reach: number|null,
 *   completion_rate: number|null,
 *   watch_time_min: number|null,
 *   avg_watch_sec: number|null,
 * }>}
 */
function parseVideoRows(data) {
  if (!data?.rows) return [];
  const results = [];

  for (const row of data.rows) {
    if (!Array.isArray(row) || row.length < 4) continue;

    const url         = row[V_IDX.url];
    const platform_id = extractVideoId(url);
    if (!platform_id) continue;  // URL から ID が取れない行はスキップ

    const pubDateRaw  = row[V_IDX.pub_date];
    const published_at = pubDateRaw ? parseMetricoolDate(String(pubDateRaw)) : null;

    const captionRaw  = row[V_IDX.caption];
    const caption     = captionRaw != null ? String(captionRaw).trim() : null;

    const duration_sec = toIntOrNull(row[V_IDX.duration]);

    // 再生指標
    const views    = toIntOrNull(row[V_IDX.views]);
    const likes    = toIntOrNull(row[V_IDX.likes]);
    const comments = toIntOrNull(row[V_IDX.comments]);
    const shares   = toIntOrNull(row[V_IDX.shares]);
    const reach    = toIntOrNull(row[V_IDX.reach]);

    // 完走率: Metricool が null を返した場合は必ず null を保存（計算値で補完しない）
    const completion_rate_raw = row[V_IDX.completion_rate];
    const completion_rate = toFloatOrNull(completion_rate_raw);

    // 視聴時間
    const watch_time_sec_raw = toFloatOrNull(row[V_IDX.watch_time_sec]);
    const watch_time_min = watch_time_sec_raw !== null ? watch_time_sec_raw / 60 : null;
    const avg_watch_sec  = toFloatOrNull(row[V_IDX.avg_watch_sec]);

    results.push({
      platform_id,
      published_at,
      caption,
      duration_sec,
      views,
      likes,
      comments,
      shares,
      reach,
      completion_rate,
      watch_time_min,
      avg_watch_sec,
    });
  }

  return results;
}

// ── DB 書き込み関数 ───────────────────────────────────────────────────────────

/**
 * TikTok アカウント日次データを sf_account_daily に UPSERT する。
 * - 既存の非 NULL 値は COALESCE で保護する（既存データを削除しない）
 * - import_source = 'api' で固定
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ date: string, followers: number|null, followers_delta: number|null, profile_visits: number|null }} row
 * @returns {{ written: number, error: string|null }}
 */
export function writeAccountDaily(db, row) {
  try {
    db.prepare(`
      INSERT INTO sf_account_daily
        (platform, date, followers, followers_delta, profile_visits, import_source, fetched_at)
      VALUES ('tiktok', ?, ?, ?, ?, 'api', datetime('now','localtime'))
      ON CONFLICT(platform, date) DO UPDATE SET
        followers       = COALESCE(excluded.followers,       followers),
        followers_delta = COALESCE(excluded.followers_delta, followers_delta),
        profile_visits  = COALESCE(excluded.profile_visits,  profile_visits),
        import_source   = 'api',
        fetched_at      = excluded.fetched_at
    `).run(row.date, row.followers, row.followers_delta, row.profile_visits);
    return { written: 1, error: null };
  } catch (e) {
    return { written: 0, error: e.message };
  }
}

/**
 * TikTok 動画を sf_content_registry に UPSERT する。
 * 重複は (platform, platform_id) の UNIQUE 制約で防ぐ。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ platform_id: string, published_at: string|null, caption: string|null, duration_sec: number|null }} row
 * @returns {{ id: number|null, error: string|null }}
 */
export function writeVideoEntry(db, row) {
  try {
    // title は caption の先頭 100文字
    const title = row.caption ? row.caption.slice(0, 100) : null;

    db.prepare(`
      INSERT INTO sf_content_registry
        (platform, content_type, platform_id, title, published_at, duration_sec)
      VALUES ('tiktok', 'tiktok_video', ?, ?, ?, ?)
      ON CONFLICT(platform, platform_id) DO UPDATE SET
        title        = COALESCE(excluded.title,        title),
        published_at = COALESCE(excluded.published_at, published_at),
        duration_sec = COALESCE(excluded.duration_sec, duration_sec)
    `).run(row.platform_id, title, row.published_at, row.duration_sec);

    const rec = db.prepare(
      `SELECT id FROM sf_content_registry WHERE platform='tiktok' AND platform_id=?`
    ).get(row.platform_id);

    return { id: rec?.id ?? null, error: null };
  } catch (e) {
    return { id: null, error: e.message };
  }
}

/**
 * TikTok 動画メトリクスを sf_social_metrics に UPSERT する。
 * - snapshot_date: 今日（累積スナップショットとして保存）
 * - completion_rate は API が null の場合は必ず null（計算値で補完しない）
 * - saves は TikTok 経由では取得不可のため NULL
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{
 *   content_reg_id: number,
 *   snapshot_date: string,
 *   views: number|null,
 *   likes: number|null,
 *   comments: number|null,
 *   shares: number|null,
 *   reach: number|null,
 *   completion_rate: number|null,
 *   watch_time_min: number|null,
 *   avg_watch_sec: number|null,
 * }} row
 * @returns {{ written: number, error: string|null }}
 */
export function writeVideoMetrics(db, row) {
  try {
    db.prepare(`
      INSERT INTO sf_social_metrics
        (content_reg_id, snapshot_date, views, reach, likes, comments, shares,
         completion_rate, watch_time_min, avg_watch_sec,
         import_source, fetched_at)
      VALUES (?, ?, ?, ?, ?, ?, ?,
              ?, ?, ?,
              'api', datetime('now','localtime'))
      ON CONFLICT(content_reg_id, snapshot_date) DO UPDATE SET
        views           = COALESCE(excluded.views,           views),
        reach           = COALESCE(excluded.reach,           reach),
        likes           = COALESCE(excluded.likes,           likes),
        comments        = COALESCE(excluded.comments,        comments),
        shares          = COALESCE(excluded.shares,          shares),
        completion_rate = COALESCE(excluded.completion_rate, completion_rate),
        watch_time_min  = COALESCE(excluded.watch_time_min,  watch_time_min),
        avg_watch_sec   = COALESCE(excluded.avg_watch_sec,   avg_watch_sec),
        import_source   = 'api',
        fetched_at      = excluded.fetched_at
    `).run(
      row.content_reg_id,
      row.snapshot_date,
      row.views,
      row.reach,
      row.likes,
      row.comments,
      row.shares,
      row.completion_rate,
      row.watch_time_min,
      row.avg_watch_sec,
    );
    return { written: 1, error: null };
  } catch (e) {
    return { written: 0, error: e.message };
  }
}

// ── メイン収集関数 ────────────────────────────────────────────────────────────

/**
 * TikTok データを Metricool MCP から取得して DB に保存する。
 * sf_sync_manager.js の runSourceSync から呼び出される。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @throws {Error} 収集失敗時（runSourceSync が catch して状態を更新する）
 */
export async function collectTikTok(db) {
  // ── 1. アクセストークン取得 ──────────────────────────────────────────────
  const accessToken = await getAccessToken();

  // ── 2. MCP 初期化 ─────────────────────────────────────────────────────
  await mcpInit(accessToken);

  // ── 3. 期間設定（直近 SYNC_DAYS 日） ────────────────────────────────────
  const now   = new Date();
  const tzOff = '+09:00';
  const to    = now.toISOString().slice(0, 19) + tzOff;
  const from  = new Date(now - SYNC_DAYS * 86400_000).toISOString().slice(0, 19) + tzOff;
  const todayDate = now.toISOString().slice(0, 10);

  // ── 4. アカウント日次データ取得 ──────────────────────────────────────────
  let accountWritten = 0;
  try {
    const acctData = await mcpGetAnalytics(accessToken, ACCOUNT_METRIC_IDS, from, to);
    const acctRows = parseAccountRows(acctData);

    for (const row of acctRows) {
      const r = writeAccountDaily(db, row);
      if (r.error) {
        console.error(`  [tiktok] sf_account_daily 書込エラー (${row.date}): ${r.error}`);
      } else {
        accountWritten += r.written;
      }
    }
    // 注: フォロワー値を今日の日付に複製しない（日付の誤割り当てを防ぐ）
    // API が今日の行を返せば today が last_data_date になる
  } catch (e) {
    // アカウントデータ失敗は動画データ取得には影響しない
    console.error(`  [tiktok] アカウントデータ取得失敗: ${e.message}`);
  }

  // ── 5. 動画メトリクス取得 ─────────────────────────────────────────────
  let videoEntries = 0;
  let videoMetrics = 0;

  const videoData = await mcpGetAnalytics(accessToken, VIDEO_METRIC_IDS, from, to);
  const videoRows = parseVideoRows(videoData);

  for (const vRow of videoRows) {
    // sf_content_registry に登録（UPSERT）
    const { id, error: entryError } = writeVideoEntry(db, vRow);
    if (entryError || id === null) {
      console.error(`  [tiktok] sf_content_registry 書込エラー (${vRow.platform_id}): ${entryError}`);
      continue;
    }
    videoEntries++;

    // sf_social_metrics に今日の累積スナップショットを UPSERT
    const { written, error: metricsError } = writeVideoMetrics(db, {
      content_reg_id:  id,
      snapshot_date:   todayDate,
      views:           vRow.views,
      reach:           vRow.reach,
      likes:           vRow.likes,
      comments:        vRow.comments,
      shares:          vRow.shares,
      completion_rate: vRow.completion_rate,  // null の場合は null のまま
      watch_time_min:  vRow.watch_time_min,
      avg_watch_sec:   vRow.avg_watch_sec,
    });

    if (metricsError) {
      console.error(`  [tiktok] sf_social_metrics 書込エラー (${vRow.platform_id}): ${metricsError}`);
    } else {
      videoMetrics += written;
    }
  }

  console.log(
    `  [tiktok] 完了: account_daily ${accountWritten}件, ` +
    `動画登録 ${videoEntries}件, 動画指標 ${videoMetrics}件`
  );
}
