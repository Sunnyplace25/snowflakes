/**
 * jarvis/importers/kdp_report_importer.js
 * KDP（Kindle Direct Publishing）レポートインポーター（Phase 13）
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 対応レポートタイプ（KDP 公式エクスポート）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * 取得元: kdp.amazon.co.jp → レポート → 各レポートタブ → ダウンロード
 * 形式: TSV（タブ区切り）または CSV（カンマ区切り）
 *
 *  1. orders    — 日次注文（注文ユニット数）
 *     代表カラム: ASIN, Title, Author, Marketplace, Date,
 *                Units Ordered (Paid), Units Ordered (Free)
 *
 *  2. kenp      — 日次 KENP（Kindle Unlimited 読み取りページ数）
 *     代表カラム: ASIN, Title, Author, Marketplace, Date, KENP Read
 *
 *  3. royalties — 月次確定ロイヤリティ
 *     代表カラム: Title, Author, ASIN, Marketplace, Transaction Type,
 *                Units Sold, Units Refunded, Net Units Sold,
 *                Average List Price, Royalty Per Unit, Total Royalties, Currency
 *
 *  4. payments  — 支払い履歴
 *     代表カラム: Payment Number, Marketplace, Sales Period, Payment Status,
 *                Payment Date, Payment Method, Net Earnings, Fx Rate,
 *                Payment Amount, Tax Amount
 *
 * !! 注意 !!
 *   - スクレイピング・非公式API・セッション流用は禁止。公式エクスポートのみ。
 *   - 通貨合算禁止。JPY と USD は別レコードとして保持。
 *   - 指標の混在禁止（Orders ≠ KENP ≠ Royalty ≠ Payment）。
 *   - 実 DB (business_data.db) は使用禁止。
 *   - 実 KDP API 通信なし。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 */

import {
  getOrCreateBook,
  writeKdpOrderDaily,
  writeKdpKenpDaily,
  writeKdpRoyalty,
  writeKdpPayment,
  syncKdpRevenue,
  writeKdpImportLog,
  isValidDate,
  isValidMonth,
} from '../data/kdp_manager.js';

// ── パーサー ──────────────────────────────────────────────────────────────────

/**
 * TSV または CSV テキストを { headers, rows } に変換する。
 *
 * 対応:
 *   - UTF-8 BOM（\uFEFF）除去
 *   - CRLF / LF 正規化
 *   - タブ区切り（TSV）またはカンマ区切り（CSV）の自動検出
 *   - ダブルクォート囲みフィールド（RFC 4180）
 *   - ヘッダー名は小文字化・trim する
 *
 * @param {string} text
 * @returns {{ headers: string[], rows: Record<string, string>[], delimiter: string }}
 */
export function parseDelimited(text) {
  if (typeof text !== 'string') throw new Error('parseDelimited: text は string が必要です');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  // 最初の行でタブ数とカンマ数を比較して delimiter を決定
  const firstLine = text.split('\n')[0] ?? '';
  const tabCount   = (firstLine.match(/\t/g) || []).length;
  const commaCount = (firstLine.match(/,/g)  || []).length;
  const delimiter  = tabCount >= commaCount ? '\t' : ',';

  const lines = tokenizeDelimited(text, delimiter);
  if (lines.length === 0) return { headers: [], rows: [], delimiter };

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

  return { headers, rows, delimiter };
}

/**
 * 区切り文字テキストを行・セルの二次元配列にトークン化する（RFC 4180 準拠）。
 * @param {string} text
 * @param {string} delimiter
 * @returns {string[][]}
 */
function tokenizeDelimited(text, delimiter) {
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
    if (ch === delimiter) { current.push(cell); cell = ''; i++; continue; }
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

// ── レポートタイプ検出 ────────────────────────────────────────────────────────

/**
 * ヘッダーからレポートタイプを検出する。
 *
 * 検出ロジック:
 *   - 'payment number' → payments
 *   - 'total royalties' → royalties
 *   - 'kenp read' → kenp
 *   - 'units ordered (paid)' または 'units ordered' → orders
 *
 * @param {string[]} headers - 小文字 trim 済み
 * @returns {'orders'|'kenp'|'royalties'|'payments'|null}
 */
export function detectReportType(headers) {
  if (headers.includes('payment number'))        return 'payments';
  if (headers.includes('total royalties'))       return 'royalties';
  if (headers.includes('kenp read'))             return 'kenp';
  if (headers.some(h => h.startsWith('units ordered'))) return 'orders';
  return null;
}

// ── Transaction Type 正規化 ───────────────────────────────────────────────────

/**
 * KDP レポートの transaction_type 文字列を内部値に正規化する。
 * @param {string} raw
 * @returns {'royalty'|'ku_koll'|'refund'|'free'|'other'}
 */
function normalizeTransactionType(raw) {
  if (!raw) return 'other';
  const s = raw.toLowerCase().trim();
  if (['royalty', 'purchase', 'standard', 'paid'].some(v => s.includes(v))) return 'royalty';
  if (['ku', 'koll', 'kindle unlimited', 'kdp select', 'ku/koll'].some(v => s.includes(v))) return 'ku_koll';
  if (s.includes('refund')) return 'refund';
  if (['free', 'giveaway', 'promotion'].some(v => s.includes(v))) return 'free';
  return 'other';
}

// ── 数値パーサー ──────────────────────────────────────────────────────────────

function parseNum(v) {
  if (v === undefined || v === '' || v === null) return null;
  // カンマ区切り数値（1,234.56）に対応
  const cleaned = String(v).replace(/,/g, '');
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function parseCount(v) {
  const n = parseNum(v);
  return (n !== null && n >= 0) ? Math.floor(n) : null;
}

// ── Orders インポート ─────────────────────────────────────────────────────────

/**
 * Orders レポート行を DB へインポートする。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Record<string, string>[]} rows
 * @returns {{ imported: number, skipped: number, warnings: string[] }}
 */
export function importOrdersReport(db, rows) {
  let imported = 0, skipped = 0;
  const warnings = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const asin  = (row['asin'] ?? '').trim().toUpperCase();
    const date  = (row['date'] ?? '').trim();
    const marketplace = (row['marketplace'] ?? '').trim();

    if (!asin) {
      warnings.push(`行 ${i}: ASIN が空 → スキップ`);
      skipped++; continue;
    }
    if (!isValidDate(date)) {
      warnings.push(`行 ${i}: Date が不正（値: ${date}）→ スキップ`);
      skipped++; continue;
    }

    const title  = (row['title'] ?? '').trim() || asin;
    const author = (row['author'] ?? row['author(s)'] ?? '').trim() || null;
    const formatRaw = (row['format'] ?? '').trim().toLowerCase();
    const format = formatRaw === 'ebook' ? 'ebook'
      : formatRaw === 'paperback' ? 'paperback'
      : formatRaw === 'hardcover' ? 'hardcover'
      : null;

    let book_id;
    try {
      book_id = getOrCreateBook(db, asin, title, { author, format });
    } catch (e) {
      warnings.push(`行 ${i}: 本の登録失敗（${e.message}）→ スキップ`);
      skipped++; continue;
    }

    // 複数のカラム名に対応（英語/日本語 KDP エクスポート）
    const paidRaw = row['units ordered (paid)'] ?? row['units ordered'] ?? null;
    const freeRaw = row['units ordered (free)'] ?? null;

    writeKdpOrderDaily(db, {
      date,
      book_id,
      marketplace: marketplace || 'unknown',
      paid_units:  parseCount(paidRaw),
      free_units:  parseCount(freeRaw),
    });
    imported++;
  }

  return { imported, skipped, warnings };
}

// ── KENP インポート ───────────────────────────────────────────────────────────

/**
 * KENP レポート行を DB へインポートする。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Record<string, string>[]} rows
 * @returns {{ imported: number, skipped: number, warnings: string[] }}
 */
export function importKenpReport(db, rows) {
  let imported = 0, skipped = 0;
  const warnings = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const asin        = (row['asin'] ?? '').trim().toUpperCase();
    const date        = (row['date'] ?? '').trim();
    const marketplace = (row['marketplace'] ?? '').trim();

    if (!asin) {
      warnings.push(`行 ${i}: ASIN が空 → スキップ`);
      skipped++; continue;
    }
    if (!isValidDate(date)) {
      warnings.push(`行 ${i}: Date が不正（値: ${date}）→ スキップ`);
      skipped++; continue;
    }

    const title  = (row['title'] ?? '').trim() || asin;
    const author = (row['author'] ?? row['author(s)'] ?? '').trim() || null;

    let book_id;
    try {
      book_id = getOrCreateBook(db, asin, title, { author });
    } catch (e) {
      warnings.push(`行 ${i}: 本の登録失敗（${e.message}）→ スキップ`);
      skipped++; continue;
    }

    const kenpRaw = row['kenp read'] ?? null;

    writeKdpKenpDaily(db, {
      date,
      book_id,
      marketplace: marketplace || 'unknown',
      kenp_read: parseCount(kenpRaw),
    });
    imported++;
  }

  return { imported, skipped, warnings };
}

// ── Royalties インポート ──────────────────────────────────────────────────────

/**
 * Royalties レポート行を DB へインポートする。
 * royalty_month が必須（opts から取得）。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Record<string, string>[]} rows
 * @param {{ royalty_month: string }} opts
 * @returns {{ imported: number, skipped: number, warnings: string[], revenue_synced: number }}
 */
export function importRoyaltiesReport(db, rows, opts = {}) {
  const { royalty_month } = opts;
  if (!isValidMonth(royalty_month)) {
    throw new Error(`importRoyaltiesReport: royalty_month が不正です（値: ${royalty_month}）`);
  }

  let imported = 0, skipped = 0, revenueSynced = 0;
  const warnings = [];
  const syncedBookMonths = new Set(); // 重複 sync を防ぐ

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const asin        = (row['asin'] ?? '').trim().toUpperCase();
    const marketplace = (row['marketplace'] ?? '').trim();
    const currency    = (row['currency'] ?? '').trim().toUpperCase();

    if (!asin) {
      warnings.push(`行 ${i}: ASIN が空 → スキップ`);
      skipped++; continue;
    }
    if (!currency) {
      warnings.push(`行 ${i}: Currency が空 → スキップ`);
      skipped++; continue;
    }

    const title       = (row['title'] ?? '').trim() || asin;
    const author      = (row['author'] ?? row['author(s)'] ?? '').trim() || null;
    const txTypeRaw   = row['transaction type'] ?? '';
    const txType      = normalizeTransactionType(txTypeRaw);
    const unitsSold   = parseCount(row['units sold'] ?? null);
    const unitsRefund = parseCount(row['units refunded'] ?? null);
    const netUnits    = parseCount(row['net units sold'] ?? null);
    const totalRoy    = parseNum(row['total royalties'] ?? null);

    let book_id;
    try {
      book_id = getOrCreateBook(db, asin, title, { author });
    } catch (e) {
      warnings.push(`行 ${i}: 本の登録失敗（${e.message}）→ スキップ`);
      skipped++; continue;
    }

    writeKdpRoyalty(db, {
      royalty_month,
      book_id,
      marketplace: marketplace || 'unknown',
      transaction_type: txType,
      units_sold:   unitsSold,
      units_refunded: unitsRefund,
      net_units:    netUnits,
      royalty_amount: totalRoy,
      currency,
    });
    imported++;

    // Snow flakes マッピング済み本のみ sf_revenue へ同期（月 × book_id で一度のみ）
    const syncKey = `${book_id}:${royalty_month}`;
    if (!syncedBookMonths.has(syncKey)) {
      syncedBookMonths.add(syncKey);
      revenueSynced += syncKdpRevenue(db, book_id, royalty_month);
    }
  }

  // sf_revenue への同期は全行処理後にまとめて再実行（通貨別集計のため）
  for (const key of syncedBookMonths) {
    const [bookId, month] = key.split(':');
    syncKdpRevenue(db, Number(bookId), month);
  }

  return { imported, skipped, warnings, revenue_synced: revenueSynced };
}

// ── Payments インポート ───────────────────────────────────────────────────────

/**
 * Payments レポート行を DB へインポートする。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Record<string, string>[]} rows
 * @returns {{ imported: number, skipped: number, warnings: string[] }}
 */
export function importPaymentsReport(db, rows) {
  let imported = 0, skipped = 0;
  const warnings = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const paymentNumber = (row['payment number'] ?? '').trim();
    const marketplace   = (row['marketplace'] ?? '').trim();

    if (!paymentNumber) {
      warnings.push(`行 ${i}: Payment Number が空 → スキップ`);
      skipped++; continue;
    }

    const currency = (row['currency'] ?? '').trim().toUpperCase() || 'JPY';

    writeKdpPayment(db, {
      payment_number:  paymentNumber,
      marketplace:     marketplace || 'unknown',
      sales_period:    (row['sales period'] ?? '').trim() || null,
      payment_status:  (row['payment status'] ?? '').trim() || null,
      payment_date:    (row['payment date'] ?? '').trim() || null,
      payment_method:  (row['payment method'] ?? '').trim() || null,
      net_earnings:    parseNum(row['net earnings'] ?? null),
      currency,
      fx_rate:         parseNum(row['fx rate'] ?? null),
      payment_amount:  parseNum(row['payment amount'] ?? null),
      tax_withholding: parseNum(row['tax amount'] ?? row['tax withholding'] ?? null),
    });
    imported++;
  }

  return { imported, skipped, warnings };
}

// ── メインインポート ───────────────────────────────────────────────────────────

/**
 * KDP レポートテキスト（TSV または CSV）を DB へインポートする。
 * レポートタイプは自動検出。royalties の場合は royalty_month が必須。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} text - KDP エクスポートテキスト
 * @param {{ report_type?: 'orders'|'kenp'|'royalties'|'payments', royalty_month?: string, file_name?: string, file_fingerprint?: string }} [opts]
 * @returns {{ report_type: string, imported: number, skipped: number, warnings: string[], revenue_synced?: number }}
 */
export function importKdpReport(db, text, opts = {}) {
  const { royalty_month = null, file_name = null, file_fingerprint = null } = opts;

  const { headers, rows } = parseDelimited(text);

  const detectedType = opts.report_type || detectReportType(headers);
  if (!detectedType) {
    throw new Error('importKdpReport: レポートタイプを検出できません。ヘッダーを確認してください');
  }

  let result;
  switch (detectedType) {
    case 'orders':
      result = importOrdersReport(db, rows);
      break;
    case 'kenp':
      result = importKenpReport(db, rows);
      break;
    case 'royalties': {
      const month = royalty_month || opts.report_period || null;
      result = importRoyaltiesReport(db, rows, { royalty_month: month });
      break;
    }
    case 'payments':
      result = importPaymentsReport(db, rows);
      break;
    default:
      throw new Error(`importKdpReport: 未知のレポートタイプ（値: ${detectedType}）`);
  }

  // インポートログを記録
  try {
    writeKdpImportLog(db, {
      report_type:     detectedType,
      file_name,
      file_fingerprint,
      report_period:   royalty_month || null,
      row_count:       rows.length,
      imported_count:  result.imported,
      skipped_count:   result.skipped,
      warning_count:   result.warnings?.length ?? 0,
    });
  } catch (_) {
    // ログ書き込み失敗は致命的でないため無視
  }

  return { report_type: detectedType, ...result };
}
