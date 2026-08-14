/**
 * jarvis/data/kdp_manager.js
 * KDP（Kindle Direct Publishing）Analytics データマネージャー（Phase 13）
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 重要原則
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * - 取得方式: MANUAL（公式 KDP レポート CSV/TSV エクスポート、スクレイピング禁止）
 *   Amazon KDP セルフサービスパブリッシング（kdp.amazon.co.jp）の
 *   「レポート」から取得したCSV/TSVを手動取込。
 *
 * - kdp_* テーブルはビジネス全体共通基盤（sf_ プレフィックスなし）。
 *   Snow flakes 固有の接続は sf_kdp_book_map を経由する。
 *
 * - ASIN を本の一次識別子として使用。
 *   同一作品でも eBook / Paperback は別 ASIN = 別レコード。
 *
 * - 通貨合算禁止。
 *   JPY と USD のロイヤリティは決して合算しない。通貨別に保持する。
 *
 * - 指標の合算禁止。
 *   Orders（日次注文）/ KENP（日次ページ読み取り）/ Royalties（月次確定）/
 *   Payments（支払い）は別テーブル・別指標として管理する。
 *
 * - sf_revenue への書き込みは sf_kdp_book_map に登録された本のみ。
 *   マッピングされていない本のロイヤリティは sf_revenue に書き込まない。
 *
 * - スキーマ変更なし（このファイルは read/write のみ）。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 */

// ── 定数 ─────────────────────────────────────────────────────────────────────

const DATE_RE  = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

/** kdp_royalties.transaction_type の許可値 */
export const VALID_TRANSACTION_TYPES = ['royalty', 'ku_koll', 'refund', 'free', 'other'];

/** kdp_books.format の許可値 */
export const VALID_FORMATS = ['ebook', 'paperback', 'hardcover', 'other'];

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
 * YYYY-MM 形式の月文字列か検証する。
 * @param {string} s
 * @returns {boolean}
 */
export function isValidMonth(s) {
  if (typeof s !== 'string' || !MONTH_RE.test(s)) return false;
  const d = new Date(s + '-01T00:00:00Z');
  return !isNaN(d.getTime());
}

/**
 * ASIN として有効か検証する（英数字1〜20文字）。
 * Amazon 標準 ASIN は10文字だが、将来の形式変更・テスト用に範囲を緩めている。
 * @param {unknown} asin
 * @returns {boolean}
 */
export function isValidAsin(asin) {
  return typeof asin === 'string' && /^[A-Z0-9]{1,20}$/i.test(asin.trim());
}

// ── 本台帳 WRITE ──────────────────────────────────────────────────────────────

/**
 * KDP 本レコードを kdp_books へ UPSERT する（冪等）。
 * ASIN が主キー。title は空文字不可（既存 NULL のみ COALESCE で保護）。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ asin: string, isbn?: string|null, title: string, author?: string|null, format?: string|null, memo?: string|null }} book
 * @returns {number} book_id (id)
 */
export function writeKdpBook(db, book) {
  const { asin, isbn = null, title, author = null, format = null, memo = null } = book;
  if (!isValidAsin(asin)) throw new Error(`writeKdpBook: ASIN が不正です（値: ${asin}）`);
  if (!title || typeof title !== 'string' || !title.trim())
    throw new Error(`writeKdpBook: title が空です（asin: ${asin}）`);

  const fmt = format && VALID_FORMATS.includes(format.toLowerCase())
    ? format.toLowerCase() : (format ? 'other' : null);

  db.prepare(`
    INSERT INTO kdp_books (asin, isbn, title, author, format, memo)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(asin) DO UPDATE SET
      isbn   = COALESCE(excluded.isbn,   isbn),
      title  = excluded.title,
      author = COALESCE(excluded.author, author),
      format = COALESCE(excluded.format, format),
      memo   = COALESCE(excluded.memo,   memo),
      updated_at = datetime('now','localtime')
  `).run(asin.trim().toUpperCase(), isbn, title.trim(), author, fmt, memo);

  const row = db.prepare('SELECT id FROM kdp_books WHERE asin = ?').get(asin.trim().toUpperCase());
  return row.id;
}

/**
 * ASIN で本を取得、存在しなければ最低限の情報で登録して id を返す。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} asin
 * @param {string} title
 * @param {{ author?: string|null, format?: string|null }} [opts]
 * @returns {number} book_id
 */
export function getOrCreateBook(db, asin, title, opts = {}) {
  if (!isValidAsin(asin)) throw new Error(`getOrCreateBook: ASIN が不正です（値: ${asin}）`);
  const existing = db.prepare('SELECT id FROM kdp_books WHERE asin = ?').get(asin.trim().toUpperCase());
  if (existing) return existing.id;
  return writeKdpBook(db, { asin, title: title || asin, ...opts });
}

// ── 日次注文 WRITE ────────────────────────────────────────────────────────────

/**
 * 日次注文データを kdp_orders_daily へ UPSERT する（冪等）。
 * COALESCE で既存 NULL 値を保護する。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ date: string, book_id: number, marketplace: string, paid_units?: number|null, free_units?: number|null }} rec
 * @returns {{ date: string, book_id: number, marketplace: string }}
 */
export function writeKdpOrderDaily(db, rec) {
  const { date, book_id, marketplace, paid_units = null, free_units = null } = rec;
  if (!isValidDate(date)) throw new Error(`writeKdpOrderDaily: date が不正です（値: ${date}）`);
  if (!Number.isInteger(book_id) || book_id <= 0) throw new Error(`writeKdpOrderDaily: book_id が不正です`);
  if (!marketplace || typeof marketplace !== 'string')
    throw new Error(`writeKdpOrderDaily: marketplace が空です`);

  function parseCount(v) {
    if (v === null || v === undefined) return null;
    const n = Math.floor(Number(v));
    return (Number.isFinite(n) && n >= 0) ? n : null;
  }

  db.prepare(`
    INSERT INTO kdp_orders_daily (date, book_id, marketplace, paid_units, free_units)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(date, book_id, marketplace) DO UPDATE SET
      paid_units = COALESCE(excluded.paid_units, paid_units),
      free_units = COALESCE(excluded.free_units, free_units),
      fetched_at = datetime('now','localtime')
  `).run(date, book_id, marketplace.trim(), parseCount(paid_units), parseCount(free_units));

  return { date, book_id, marketplace: marketplace.trim() };
}

// ── 日次 KENP WRITE ───────────────────────────────────────────────────────────

/**
 * 日次 KENP 読み取りページ数を kdp_kenp_daily へ UPSERT する（冪等）。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ date: string, book_id: number, marketplace: string, kenp_read?: number|null }} rec
 * @returns {{ date: string, book_id: number, marketplace: string }}
 */
export function writeKdpKenpDaily(db, rec) {
  const { date, book_id, marketplace, kenp_read = null } = rec;
  if (!isValidDate(date)) throw new Error(`writeKdpKenpDaily: date が不正です（値: ${date}）`);
  if (!Number.isInteger(book_id) || book_id <= 0) throw new Error(`writeKdpKenpDaily: book_id が不正です`);
  if (!marketplace || typeof marketplace !== 'string')
    throw new Error(`writeKdpKenpDaily: marketplace が空です`);

  const kenp = (kenp_read !== null && kenp_read !== undefined) ? Math.floor(Number(kenp_read)) : null;
  const validKenp = (kenp !== null && Number.isFinite(kenp) && kenp >= 0) ? kenp : null;

  db.prepare(`
    INSERT INTO kdp_kenp_daily (date, book_id, marketplace, kenp_read)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(date, book_id, marketplace) DO UPDATE SET
      kenp_read  = COALESCE(excluded.kenp_read, kenp_read),
      fetched_at = datetime('now','localtime')
  `).run(date, book_id, marketplace.trim(), validKenp);

  return { date, book_id, marketplace: marketplace.trim() };
}

// ── ロイヤリティ WRITE ────────────────────────────────────────────────────────

/**
 * 月次ロイヤリティを kdp_royalties へ UPSERT する（冪等）。
 * 通貨別に保持。合算禁止。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ royalty_month: string, book_id: number, marketplace: string, transaction_type?: string, units_sold?: number|null, units_refunded?: number|null, net_units?: number|null, royalty_amount?: number|null, currency: string }} rec
 * @returns {{ royalty_month: string, book_id: number, marketplace: string, transaction_type: string }}
 */
export function writeKdpRoyalty(db, rec) {
  const {
    royalty_month, book_id, marketplace,
    transaction_type = 'royalty',
    units_sold = null, units_refunded = null, net_units = null,
    royalty_amount = null, currency,
  } = rec;

  if (!isValidMonth(royalty_month))
    throw new Error(`writeKdpRoyalty: royalty_month が不正です（値: ${royalty_month}）`);
  if (!Number.isInteger(book_id) || book_id <= 0)
    throw new Error(`writeKdpRoyalty: book_id が不正です`);
  if (!marketplace || typeof marketplace !== 'string')
    throw new Error(`writeKdpRoyalty: marketplace が空です`);
  if (!currency || typeof currency !== 'string')
    throw new Error(`writeKdpRoyalty: currency が空です`);

  const txType = VALID_TRANSACTION_TYPES.includes(transaction_type) ? transaction_type : 'other';

  function parseNum(v) {
    if (v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  function parseInt_(v) {
    const n = parseNum(v);
    return n !== null ? Math.floor(n) : null;
  }

  db.prepare(`
    INSERT INTO kdp_royalties
      (royalty_month, book_id, marketplace, transaction_type,
       units_sold, units_refunded, net_units, royalty_amount, currency)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(royalty_month, book_id, marketplace, transaction_type) DO UPDATE SET
      units_sold     = COALESCE(excluded.units_sold,     units_sold),
      units_refunded = COALESCE(excluded.units_refunded, units_refunded),
      net_units      = COALESCE(excluded.net_units,      net_units),
      royalty_amount = COALESCE(excluded.royalty_amount, royalty_amount),
      currency       = excluded.currency,
      fetched_at     = datetime('now','localtime')
  `).run(
    royalty_month, book_id, marketplace.trim(), txType,
    parseInt_(units_sold), parseInt_(units_refunded), parseInt_(net_units),
    parseNum(royalty_amount), currency.trim().toUpperCase(),
  );

  return { royalty_month, book_id, marketplace: marketplace.trim(), transaction_type: txType };
}

// ── 支払い WRITE ──────────────────────────────────────────────────────────────

/**
 * 支払いレコードを kdp_payments へ UPSERT する（冪等）。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ payment_number: string, marketplace: string, sales_period?: string|null, payment_status?: string|null, payment_date?: string|null, payment_method?: string|null, net_earnings?: number|null, currency?: string, fx_rate?: number|null, payment_amount?: number|null, tax_withholding?: number|null }} rec
 * @returns {{ payment_number: string, marketplace: string }}
 */
export function writeKdpPayment(db, rec) {
  const {
    payment_number, marketplace,
    sales_period = null, payment_status = null, payment_date = null,
    payment_method = null, net_earnings = null, currency = 'JPY',
    fx_rate = null, payment_amount = null, tax_withholding = null,
  } = rec;

  if (!payment_number || typeof payment_number !== 'string' || !payment_number.trim())
    throw new Error(`writeKdpPayment: payment_number が空です`);
  if (!marketplace || typeof marketplace !== 'string')
    throw new Error(`writeKdpPayment: marketplace が空です`);

  function parseNum(v) {
    if (v === null || v === undefined) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }

  db.prepare(`
    INSERT INTO kdp_payments
      (payment_number, marketplace, sales_period, payment_status, payment_date,
       payment_method, net_earnings, currency, fx_rate, payment_amount, tax_withholding)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(payment_number, marketplace) DO UPDATE SET
      sales_period    = COALESCE(excluded.sales_period,    sales_period),
      payment_status  = excluded.payment_status,
      payment_date    = COALESCE(excluded.payment_date,    payment_date),
      payment_method  = COALESCE(excluded.payment_method,  payment_method),
      net_earnings    = COALESCE(excluded.net_earnings,    net_earnings),
      currency        = excluded.currency,
      fx_rate         = COALESCE(excluded.fx_rate,         fx_rate),
      payment_amount  = COALESCE(excluded.payment_amount,  payment_amount),
      tax_withholding = COALESCE(excluded.tax_withholding, tax_withholding),
      fetched_at      = datetime('now','localtime')
  `).run(
    payment_number.trim(), marketplace.trim(),
    sales_period, payment_status, payment_date, payment_method,
    parseNum(net_earnings), currency.trim().toUpperCase(),
    parseNum(fx_rate), parseNum(payment_amount), parseNum(tax_withholding),
  );

  return { payment_number: payment_number.trim(), marketplace: marketplace.trim() };
}

// ── Snow flakes 接続 ──────────────────────────────────────────────────────────

/**
 * KDP 本を Snow flakes 作品にマッピングする（sf_kdp_book_map）。
 * book_id は UNIQUE（1 ASIN → 1 作品のみ）。
 * 既に別の work_id でマッピングされている場合は上書き更新する。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ book_id: number, work_id: number }} map
 * @returns {{ book_id: number, work_id: number }}
 */
export function mapBookToSnowflakes(db, map) {
  const { book_id, work_id } = map;
  if (!Number.isInteger(book_id) || book_id <= 0)
    throw new Error(`mapBookToSnowflakes: book_id が不正です`);
  if (!Number.isInteger(work_id) || work_id <= 0)
    throw new Error(`mapBookToSnowflakes: work_id が不正です`);

  db.prepare(`
    INSERT INTO sf_kdp_book_map (book_id, work_id)
    VALUES (?, ?)
    ON CONFLICT(book_id) DO UPDATE SET
      work_id    = excluded.work_id,
      created_at = created_at
  `).run(book_id, work_id);

  return { book_id, work_id };
}

/**
 * 指定 book_id のロイヤリティを sf_revenue へ同期する。
 * sf_kdp_book_map に登録されていない本はスキップ。
 * 通貨別に集計して UPSERT する（同一通貨の複数 transaction_type は合算）。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} book_id
 * @param {string} royalty_month - YYYY-MM
 * @returns {number} 書き込んだ sf_revenue 行数（0 = マッピングなし）
 */
export function syncKdpRevenue(db, book_id, royalty_month) {
  if (!Number.isInteger(book_id) || book_id <= 0) return 0;
  if (!isValidMonth(royalty_month)) return 0;

  const mapping = db.prepare(
    'SELECT work_id FROM sf_kdp_book_map WHERE book_id = ?'
  ).get(book_id);
  if (!mapping) return 0;

  const { work_id } = mapping;

  // 通貨別に集計（JPY と USD は別々に保持）
  const groups = db.prepare(`
    SELECT currency,
           SUM(COALESCE(net_units, 0))      AS total_units,
           SUM(COALESCE(royalty_amount, 0)) AS total_amount
    FROM kdp_royalties
    WHERE book_id = ? AND royalty_month = ?
    GROUP BY currency
  `).all(book_id, royalty_month);

  if (groups.length === 0) return 0;

  const book = db.prepare('SELECT title FROM kdp_books WHERE id = ?').get(book_id);
  const bookTitle = book?.title || null;

  let written = 0;
  for (const g of groups) {
    const { currency, total_units, total_amount } = g;

    db.prepare(`
      INSERT INTO sf_revenue
        (date, month, transaction_month, source, platform, work_id,
         quantity, content, amount, currency, amount_jpy, import_source)
      VALUES (?, ?, ?, '電子書籍', 'kdp', ?, ?, ?, ?, ?, 0, 'csv')
      ON CONFLICT DO UPDATE SET
        quantity      = excluded.quantity,
        content       = excluded.content,
        amount        = excluded.amount,
        currency      = excluded.currency,
        import_source = excluded.import_source
    `).run(
      royalty_month + '-01',   // date
      royalty_month,            // month
      royalty_month,            // transaction_month
      work_id,
      Math.max(0, Math.floor(total_units)),
      bookTitle,
      total_amount,
      currency,
    );
    written++;
  }

  return written;
}

// ── インポートログ ─────────────────────────────────────────────────────────────

/**
 * インポート結果を kdp_import_log へ記録する。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ report_type: string, file_name?: string|null, file_fingerprint?: string|null, report_period?: string|null, row_count?: number, imported_count?: number, skipped_count?: number, warning_count?: number }} log
 * @returns {number} log id
 */
export function writeKdpImportLog(db, log) {
  const {
    report_type, file_name = null, file_fingerprint = null, report_period = null,
    row_count = 0, imported_count = 0, skipped_count = 0, warning_count = 0,
  } = log;

  const VALID_TYPES = ['orders', 'kenp', 'royalties', 'payments'];
  if (!VALID_TYPES.includes(report_type))
    throw new Error(`writeKdpImportLog: report_type が不正です（値: ${report_type}）`);

  const res = db.prepare(`
    INSERT INTO kdp_import_log
      (report_type, file_name, file_fingerprint, report_period,
       row_count, imported_count, skipped_count, warning_count)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(report_type, file_name, file_fingerprint, report_period,
         row_count, imported_count, skipped_count, warning_count);

  return Number(res.lastInsertRowid);
}

// ── READ ──────────────────────────────────────────────────────────────────────

/**
 * KDP 本一覧を取得する。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ sf_only?: boolean, asin?: string }} [opts]
 * @returns {object[]}
 */
export function getKdpBooks(db, opts = {}) {
  const { sf_only = false, asin = null } = opts;
  const params = [];
  const where = [];

  if (sf_only) {
    where.push('EXISTS (SELECT 1 FROM sf_kdp_book_map m WHERE m.book_id = b.id)');
  }
  if (asin) {
    where.push('b.asin = ?');
    params.push(asin.trim().toUpperCase());
  }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  return db.prepare(`
    SELECT b.id, b.asin, b.isbn, b.title, b.author, b.format, b.memo,
           m.work_id AS sf_work_id,
           w.title   AS sf_work_title
    FROM kdp_books b
    LEFT JOIN sf_kdp_book_map m ON m.book_id = b.id
    LEFT JOIN sf_works w ON w.id = m.work_id
    ${whereClause}
    ORDER BY b.title ASC
  `).all(...params);
}

/**
 * 日次注文データを日付範囲・本で取得する。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ from?: string, to?: string, book_id?: number, marketplace?: string }} [opts]
 * @returns {object[]}
 */
export function getKdpOrders(db, opts = {}) {
  const { from = null, to = null, book_id = null, marketplace = null } = opts;
  const params = [];
  const where = [];

  if (from && isValidDate(from)) { where.push('o.date >= ?'); params.push(from); }
  if (to   && isValidDate(to))   { where.push('o.date <= ?'); params.push(to); }
  if (book_id && Number.isInteger(book_id)) { where.push('o.book_id = ?'); params.push(book_id); }
  if (marketplace) { where.push('o.marketplace = ?'); params.push(marketplace); }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  return db.prepare(`
    SELECT o.date, o.book_id, b.asin, b.title, b.format,
           o.marketplace, o.paid_units, o.free_units
    FROM kdp_orders_daily o
    JOIN kdp_books b ON b.id = o.book_id
    ${whereClause}
    ORDER BY o.date DESC, b.title ASC
  `).all(...params);
}

/**
 * 日次 KENP データを日付範囲・本で取得する。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ from?: string, to?: string, book_id?: number, marketplace?: string }} [opts]
 * @returns {object[]}
 */
export function getKdpKenp(db, opts = {}) {
  const { from = null, to = null, book_id = null, marketplace = null } = opts;
  const params = [];
  const where = [];

  if (from && isValidDate(from)) { where.push('k.date >= ?'); params.push(from); }
  if (to   && isValidDate(to))   { where.push('k.date <= ?'); params.push(to); }
  if (book_id && Number.isInteger(book_id)) { where.push('k.book_id = ?'); params.push(book_id); }
  if (marketplace) { where.push('k.marketplace = ?'); params.push(marketplace); }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  return db.prepare(`
    SELECT k.date, k.book_id, b.asin, b.title, b.format,
           k.marketplace, k.kenp_read
    FROM kdp_kenp_daily k
    JOIN kdp_books b ON b.id = k.book_id
    ${whereClause}
    ORDER BY k.date DESC, b.title ASC
  `).all(...params);
}

/**
 * ロイヤリティデータを月・本・マーケットプレイスで取得する。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ royalty_month?: string, book_id?: number, marketplace?: string, currency?: string }} [opts]
 * @returns {object[]}
 */
export function getKdpRoyalties(db, opts = {}) {
  const { royalty_month = null, book_id = null, marketplace = null, currency = null } = opts;
  const params = [];
  const where = [];

  if (royalty_month && isValidMonth(royalty_month)) {
    where.push('r.royalty_month = ?');
    params.push(royalty_month);
  }
  if (book_id && Number.isInteger(book_id)) { where.push('r.book_id = ?'); params.push(book_id); }
  if (marketplace) { where.push('r.marketplace = ?'); params.push(marketplace); }
  if (currency) { where.push('r.currency = ?'); params.push(currency.toUpperCase()); }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  return db.prepare(`
    SELECT r.royalty_month, r.book_id, b.asin, b.title, b.format,
           r.marketplace, r.transaction_type,
           r.units_sold, r.units_refunded, r.net_units,
           r.royalty_amount, r.currency
    FROM kdp_royalties r
    JOIN kdp_books b ON b.id = r.book_id
    ${whereClause}
    ORDER BY r.royalty_month DESC, b.title ASC, r.marketplace ASC
  `).all(...params);
}

/**
 * 支払いデータを取得する。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ marketplace?: string, payment_status?: string }} [opts]
 * @returns {object[]}
 */
export function getKdpPayments(db, opts = {}) {
  const { marketplace = null, payment_status = null } = opts;
  const params = [];
  const where = [];

  if (marketplace) { where.push('marketplace = ?'); params.push(marketplace); }
  if (payment_status) { where.push('payment_status = ?'); params.push(payment_status); }

  const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';

  return db.prepare(`
    SELECT payment_number, marketplace, sales_period, payment_status,
           payment_date, payment_method, net_earnings, currency,
           fx_rate, payment_amount, tax_withholding
    FROM kdp_payments
    ${whereClause}
    ORDER BY payment_date DESC NULLS LAST, payment_number DESC
  `).all(...params);
}

/**
 * KDP 月次サマリーを取得する（全本 / 通貨別）。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ royalty_month?: string }} [opts]
 * @returns {{ royalty_month: string|null, by_currency: object[], by_book: object[] }}
 */
export function getKdpSummary(db, opts = {}) {
  const { royalty_month = null } = opts;

  let month = royalty_month && isValidMonth(royalty_month) ? royalty_month : null;
  if (!month) {
    const row = db.prepare('SELECT MAX(royalty_month) AS m FROM kdp_royalties').get();
    month = row?.m ?? null;
  }

  if (!month) {
    return { royalty_month: null, by_currency: [], by_book: [] };
  }

  const byCurrency = db.prepare(`
    SELECT currency,
           SUM(COALESCE(net_units,      0)) AS total_net_units,
           SUM(COALESCE(royalty_amount, 0)) AS total_royalty
    FROM kdp_royalties
    WHERE royalty_month = ?
    GROUP BY currency
    ORDER BY currency ASC
  `).all(month);

  const byBook = db.prepare(`
    SELECT b.title, b.asin, b.format, r.marketplace, r.currency,
           SUM(COALESCE(r.units_sold,     0)) AS total_units_sold,
           SUM(COALESCE(r.net_units,      0)) AS total_net_units,
           SUM(COALESCE(r.royalty_amount, 0)) AS total_royalty
    FROM kdp_royalties r
    JOIN kdp_books b ON b.id = r.book_id
    WHERE r.royalty_month = ?
    GROUP BY b.id, r.marketplace, r.currency
    ORDER BY total_royalty DESC NULLS LAST
  `).all(month);

  return { royalty_month: month, by_currency: byCurrency, by_book: byBook };
}

/**
 * Snow flakes にマッピングされた本のみの KDP サマリーを取得する。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ royalty_month?: string }} [opts]
 * @returns {object}
 */
export function getSnowflakesKdpSummary(db, opts = {}) {
  const { royalty_month = null } = opts;

  let month = royalty_month && isValidMonth(royalty_month) ? royalty_month : null;
  if (!month) {
    const row = db.prepare(`
      SELECT MAX(r.royalty_month) AS m
      FROM kdp_royalties r
      JOIN sf_kdp_book_map m ON m.book_id = r.book_id
    `).get();
    month = row?.m ?? null;
  }

  if (!month) {
    return { royalty_month: null, by_currency: [], by_work: [] };
  }

  const byCurrency = db.prepare(`
    SELECT r.currency,
           SUM(COALESCE(r.net_units,      0)) AS total_net_units,
           SUM(COALESCE(r.royalty_amount, 0)) AS total_royalty
    FROM kdp_royalties r
    JOIN sf_kdp_book_map mp ON mp.book_id = r.book_id
    WHERE r.royalty_month = ?
    GROUP BY r.currency
    ORDER BY r.currency ASC
  `).all(month);

  const byWork = db.prepare(`
    SELECT w.work_key, w.title AS work_title,
           b.asin, b.title AS book_title, b.format,
           r.marketplace, r.currency,
           SUM(COALESCE(r.net_units,      0)) AS total_net_units,
           SUM(COALESCE(r.royalty_amount, 0)) AS total_royalty
    FROM kdp_royalties r
    JOIN kdp_books b ON b.id = r.book_id
    JOIN sf_kdp_book_map mp ON mp.book_id = r.book_id
    JOIN sf_works w ON w.id = mp.work_id
    WHERE r.royalty_month = ?
    GROUP BY b.id, r.marketplace, r.currency
    ORDER BY total_royalty DESC NULLS LAST
  `).all(month);

  return { royalty_month: month, by_currency: byCurrency, by_work: byWork };
}
