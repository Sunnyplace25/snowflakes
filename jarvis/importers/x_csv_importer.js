/**
 * jarvis/importers/x_csv_importer.js
 * X Analytics CSV インポーター（Phase 12）
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 対応 CSV フォーマット（X Analytics エクスポート）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * 取得元: analytics.x.com → Post Activity Dashboard → Export Data → CSV
 *
 * X Analytics Post Activity Export の公式仕様（制約）:
 *   - 1 回のエクスポートで最大 30 日分
 *   - 1 CSV に最大 3,000 件の投稿
 *
 * X API による自動取得は技術的に可能（User Context 認証 / public_metrics 等）だが、
 * 現在は API credentials / credits を設定せず CSV 手動取込を標準運用とする。
 *
 * 代表カラム（小文字 trim 後で比較）:
 *   tweet id          → tweet_id（必須）
 *   time              → published_at
 *   tweet text        → text_snippet（先頭 140 文字）
 *   impressions       → impressions
 *   engagements       → engagements（X Analytics 提供合計値・内訳とは別）
 *   retweets          → retweets
 *   replies           → replies
 *   likes             → likes
 *   url clicks        → url_clicks
 *   user profile clicks → profile_clicks
 *   detail expands    → detail_expands
 *   media views       → media_views
 *   media engagements → media_engagements
 *
 * !! 注意 !!
 *   promoted_* カラムは保存対象外（広告なしアカウントでは常に 0 / 空欄）。
 *   engagement rate は派生値のため保存しない（impressions > 0 時に都度算出可能）。
 *   未知のカラムは無視する（合算禁止）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 重要制約
 * ══════════════════════════════════════════════════════════════════════════════
 *   - tweet_id が取得できない行はスキップ（警告を返す）
 *   - 全 UPSERT は COALESCE で既存非 NULL 値を保護する（sf_x_manager.js 経由）
 *   - snapshot_date はインポート実行日（呼び出し元が渡す）
 *   - 実 DB (business_data.db) は使用禁止
 *   - 実 X API 通信なし
 */

import { writeXTweet, writeXTweetMetrics, isValidDate } from '../data/sf_x_manager.js';

// ── ヘッダーマッピング（X Analytics CSV → 内部フィールド名）────────────────────

/**
 * CSV ヘッダー名（小文字 trim 後）→ 内部フィールド名のマップ。
 * マップに含まれないカラムは無視する。
 */
export const HEADER_MAP = {
  'tweet id':              'tweet_id',
  'time':                  'published_at',
  'tweet text':            'text_snippet',
  'impressions':           'impressions',
  'engagements':           'engagements',
  'retweets':              'retweets',
  'replies':               'replies',
  'likes':                 'likes',
  'url clicks':            'url_clicks',
  'user profile clicks':   'profile_clicks',
  'detail expands':        'detail_expands',
  'media views':           'media_views',
  'media engagements':     'media_engagements',
};

/** 必須ヘッダー */
export const REQUIRED_HEADERS = ['tweet id'];

// ── CSV パーサー ──────────────────────────────────────────────────────────────

/**
 * CSV テキストを { headers, rows } に変換する。
 *
 * 対応:
 *   - UTF-8 BOM（\uFEFF）除去
 *   - CRLF / LF 正規化
 *   - ダブルクォート囲みフィールド（カンマ・改行・二重引用符を含む値）
 *   - ヘッダ名は小文字化・trim する
 *
 * @param {string} text
 * @returns {{ headers: string[], rows: Record<string, string>[] }}
 */
export function parseCSV(text) {
  if (typeof text !== 'string') throw new Error('parseCSV: text は string が必要です');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  const lines = tokenizeCSV(text);
  if (lines.length === 0) return { headers: [], rows: [] };

  const headers = lines[0].map(h => h.trim().toLowerCase());
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i];
    if (cells.length === 0 || (cells.length === 1 && cells[0].trim() === '')) continue;
    const row = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = (cells[j] ?? '').trim();
    }
    rows.push(row);
  }

  return { headers, rows };
}

/**
 * CSV テキストを行・セルの二次元配列にトークン化する（RFC 4180 準拠）。
 * @param {string} text - BOM 除去・LF 正規化済み
 * @returns {string[][]}
 */
function tokenizeCSV(text) {
  const lines = [];
  let current = [];
  let cell = '';
  let inQuote = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];
    if (inQuote) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 2; continue; }
        inQuote = false; i++; continue;
      }
      cell += ch; i++; continue;
    }
    if (ch === '"') { inQuote = true; i++; continue; }
    if (ch === ',') { current.push(cell); cell = ''; i++; continue; }
    if (ch === '\n') {
      current.push(cell); cell = '';
      lines.push(current); current = [];
      i++; continue;
    }
    cell += ch; i++;
  }
  current.push(cell);
  if (current.some(c => c !== '')) lines.push(current);
  return lines;
}

// ── ヘッダー検証 ──────────────────────────────────────────────────────────────

/**
 * CSV ヘッダーが X Analytics フォーマットかを検証する。
 * tweet id が含まれていれば有効とみなす。
 *
 * @param {string[]} headers - 小文字 trim 済み
 * @returns {{ valid: boolean, missing: string[] }}
 */
export function validateHeaders(headers) {
  const missing = REQUIRED_HEADERS.filter(h => !headers.includes(h));
  return { valid: missing.length === 0, missing };
}

// ── 行バリデーション ──────────────────────────────────────────────────────────

/**
 * 1 行を検証し、エラーがあれば配列で返す。
 *
 * @param {Record<string, string>} row - parseCSV が返す行オブジェクト
 * @param {number} rowIndex - エラーメッセージ用の行番号（0 基準）
 * @returns {string[]} エラーメッセージ一覧（空ならOK）
 */
export function validateRow(row, rowIndex = 0) {
  const errors = [];
  const tweetId = (row['tweet id'] ?? '').trim();
  if (!tweetId) errors.push(`行 ${rowIndex}: tweet id が空です`);

  // 数値カラムは空文字 or 非負整数のみ許可
  const numCols = [
    'impressions', 'engagements', 'retweets', 'replies', 'likes',
    'url clicks', 'user profile clicks', 'detail expands', 'media views', 'media engagements',
  ];
  for (const col of numCols) {
    const v = row[col];
    if (v === undefined || v === '') continue; // 任意
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) {
      errors.push(`行 ${rowIndex}: ${col} の値が不正です（値: ${v}）`);
    }
  }

  return errors;
}

// ── 型変換 ────────────────────────────────────────────────────────────────────

/**
 * テキスト先頭の記号でツイートタイプを推定する。
 * RT @ → retweet / @ → reply / else → tweet
 * quote は CSV テキストのみでは確実に判定できないため tweet として扱う。
 *
 * @param {string} text
 * @returns {'tweet'|'reply'|'retweet'}
 */
export function detectTweetType(text) {
  if (typeof text !== 'string') return 'tweet';
  if (/^RT @/i.test(text.trim())) return 'retweet';
  if (/^@/.test(text.trim())) return 'reply';
  return 'tweet';
}

/**
 * CSV 行から sf_x_tweet 用レコードを生成する。
 *
 * @param {Record<string, string>} row
 * @returns {{ tweet_id: string, published_at: string|null, text_snippet: string|null, tweet_type: string }}
 */
export function buildTweetRecord(row) {
  const tweetId    = (row['tweet id'] ?? '').trim();
  const publishedAt = (row['time'] ?? '').trim() || null;
  const rawText    = (row['tweet text'] ?? '').trim();
  const snippet    = rawText ? rawText.slice(0, 140) : null;
  const tweetType  = detectTweetType(rawText);

  return {
    tweet_id:    tweetId,
    published_at: publishedAt,
    text_snippet: snippet,
    tweet_type:  tweetType,
    import_source: 'csv',
  };
}

/**
 * CSV 行と snapshot_date から sf_x_tweet_metrics 用レコードを生成する。
 * 未知のカラムは含まない（合算しない）。
 *
 * @param {Record<string, string>} row
 * @param {string} snapshotDate - YYYY-MM-DD
 * @returns {object}
 */
export function buildMetricsRecord(row, snapshotDate) {
  function parseNum(v) {
    if (v === undefined || v === '') return null;
    const n = Number(v);
    return (Number.isFinite(n) && n >= 0) ? Math.floor(n) : null;
  }

  return {
    tweet_id:          (row['tweet id'] ?? '').trim(),
    snapshot_date:     snapshotDate,
    impressions:       parseNum(row['impressions']),
    engagements:       parseNum(row['engagements']),
    retweets:          parseNum(row['retweets']),
    replies:           parseNum(row['replies']),
    likes:             parseNum(row['likes']),
    url_clicks:        parseNum(row['url clicks']),
    profile_clicks:    parseNum(row['user profile clicks']),
    detail_expands:    parseNum(row['detail expands']),
    media_views:       parseNum(row['media views']),
    media_engagements: parseNum(row['media engagements']),
    import_source:     'csv',
  };
}

// ── メインインポート ───────────────────────────────────────────────────────────

/**
 * X Analytics CSV テキストを DB へインポートする。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} csvText - X Analytics エクスポート CSV テキスト
 * @param {string} snapshotDate - YYYY-MM-DD（エクスポート取得日）
 * @returns {{ imported: number, skipped: number, warnings: string[] }}
 */
export function importXCSV(db, csvText, snapshotDate) {
  if (!isValidDate(snapshotDate)) {
    throw new Error(`importXCSV: snapshotDate が不正です（値: ${snapshotDate}）`);
  }

  const { headers, rows } = parseCSV(csvText);

  const { valid, missing } = validateHeaders(headers);
  if (!valid) {
    throw new Error(`importXCSV: 必須ヘッダーが見つかりません（不足: ${missing.join(', ')}）`);
  }

  let imported = 0;
  let skipped  = 0;
  const warnings = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const errs = validateRow(row, i);
    if (errs.length > 0) {
      warnings.push(...errs);
      skipped++;
      continue;
    }

    const tweetRec   = buildTweetRecord(row);
    const metricsRec = buildMetricsRecord(row, snapshotDate);

    writeXTweet(db, tweetRec);
    writeXTweetMetrics(db, metricsRec);
    imported++;
  }

  return { imported, skipped, warnings };
}
