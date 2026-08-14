/**
 * jarvis/tests/test_kdp.js
 * KDP Analytics インポーター・マネージャー テストスイート（Phase 13）
 *
 * 重要:
 * - ':memory:' DB のみ使用。実 DB (business_data.db) は絶対に触れない
 * - 実 KDP API 通信なし / スクレイピングなし
 * - 実 Amazon アカウント情報・実 ASIN はハードコードしない（テスト用仮データのみ）
 *
 * Section 1:  parseDelimited（TSV / CSV / BOM / クォート）
 * Section 2:  detectReportType（4 レポートタイプ検出）
 * Section 3:  importOrdersReport（正常 / スキップ / 警告 / 冪等性）
 * Section 4:  importKenpReport（正常 / スキップ / 冪等性）
 * Section 5:  importRoyaltiesReport（正常 / 通貨分離 / sf_revenue 同期）
 * Section 6:  importPaymentsReport（正常 / スキップ / 冪等性）
 * Section 7:  importKdpReport（自動検出 / エラー）
 * Section 8:  writeKdpBook / getOrCreateBook（UPSERT / ASIN 正規化）
 * Section 9:  writeKdpOrderDaily（冪等性 / NULL 保護）
 * Section 10: writeKdpKenpDaily（冪等性 / NULL 保護）
 * Section 11: writeKdpRoyalty（冪等性 / transaction_type 正規化 / 通貨分離）
 * Section 12: writeKdpPayment（冪等性 / COALESCE 保護）
 * Section 13: mapBookToSnowflakes（1:1 マッピング / 上書き）
 * Section 14: syncKdpRevenue（マッピング済みのみ / 通貨別集計 / 未マッピングはスキップ）
 * Section 15: 通貨分離（JPY と USD を合算しない）
 * Section 16: getKdpBooks / getKdpOrders / getKdpKenp / getKdpRoyalties / getKdpPayments
 * Section 17: getKdpSummary
 * Section 18: getSnowflakesKdpSummary
 * Section 19: API HTTP エンドポイント
 * Section 20: 実 DB 未使用 / 外部通信なし / 他テーブル汚染なし
 */

import assert from 'node:assert/strict';
import { createServer } from 'http';
import { createDb }         from '../data/db.js';
import { createApiHandler } from '../dashboard/api.js';
import {
  writeKdpBook,
  getOrCreateBook,
  writeKdpOrderDaily,
  writeKdpKenpDaily,
  writeKdpRoyalty,
  writeKdpPayment,
  mapBookToSnowflakes,
  syncKdpRevenue,
  writeKdpImportLog,
  getKdpBooks,
  getKdpOrders,
  getKdpKenp,
  getKdpRoyalties,
  getKdpPayments,
  getKdpSummary,
  getSnowflakesKdpSummary,
  isValidDate,
  isValidMonth,
  isValidAsin,
  VALID_TRANSACTION_TYPES,
  VALID_FORMATS,
} from '../data/kdp_manager.js';
import {
  parseDelimited,
  detectReportType,
  importOrdersReport,
  importKenpReport,
  importRoyaltiesReport,
  importPaymentsReport,
  importKdpReport,
} from '../importers/kdp_report_importer.js';

// ─── セットアップ ─────────────────────────────────────────────────────────────

const db = createDb(':memory:');
const apiHandler = createApiHandler(db);

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.url.startsWith('/api/')) return apiHandler(req, res, url);
  res.writeHead(404); res.end();
});

const port = await new Promise(resolve => {
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});

const BASE = `http://127.0.0.1:${port}`;

async function api(method, path) {
  const res = await fetch(`${BASE}${path}`, { method });
  const data = await res.json();
  return { status: res.status, data };
}

// ─── テストランナー ───────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ❌ ${name}`);
    console.error(`     ${e.message}`);
    failed++;
  }
}

// ─── テスト用データヘルパー ──────────────────────────────────────────────────

function makeOrdersTSV(rows = []) {
  const header = 'Title\tAuthor(s)\tASIN\tMarketplace\tFormat\tDate\tUnits Ordered (Paid)\tUnits Ordered (Free)';
  const lines = rows.map(r =>
    `${r.title ?? 'Test Book'}\t${r.author ?? 'Author'}\t${r.asin ?? 'B001TEST001'}\t${r.marketplace ?? 'amazon.co.jp'}\t${r.format ?? 'eBook'}\t${r.date ?? '2026-07-15'}\t${r.paid ?? '3'}\t${r.free ?? '0'}`
  );
  return [header, ...lines].join('\n');
}

function makeKenpTSV(rows = []) {
  const header = 'Title\tAuthor(s)\tASIN\tMarketplace\tDate\tKENP Read';
  const lines = rows.map(r =>
    `${r.title ?? 'Test Book'}\t${r.author ?? 'Author'}\t${r.asin ?? 'B001TEST001'}\t${r.marketplace ?? 'amazon.co.jp'}\t${r.date ?? '2026-07-15'}\t${r.kenp ?? '250'}`
  );
  return [header, ...lines].join('\n');
}

function makeRoyaltiesTSV(rows = []) {
  const header = 'Title\tAuthor(s)\tASIN\tMarketplace\tTransaction Type\tUnits Sold\tUnits Refunded\tNet Units Sold\tAverage List Price\tRoyalty Per Unit\tTotal Royalties\tCurrency';
  const lines = rows.map(r =>
    `${r.title ?? 'Test Book'}\t${r.author ?? 'Author'}\t${r.asin ?? 'B001TEST001'}\t${r.marketplace ?? 'amazon.co.jp'}\t${r.txType ?? 'Royalty'}\t${r.sold ?? '10'}\t${r.refunded ?? '0'}\t${r.net ?? '10'}\t${r.listPrice ?? '500'}\t${r.royPerUnit ?? '35'}\t${r.total ?? '350'}\t${r.currency ?? 'JPY'}`
  );
  return [header, ...lines].join('\n');
}

function makePaymentsTSV(rows = []) {
  const header = 'Payment Number\tMarketplace\tSales Period\tPayment Status\tPayment Date\tPayment Method\tNet Earnings\tFx Rate\tPayment Amount\tTax Amount';
  const lines = rows.map(r =>
    `${r.number ?? 'PAY001'}\t${r.marketplace ?? 'amazon.co.jp'}\t${r.period ?? '2026-06'}\t${r.status ?? 'Paid'}\t${r.date ?? '2026-07-29'}\tWire Transfer\t${r.net ?? '3500'}\t${r.fx ?? ''}\t${r.amount ?? '3500'}\t${r.tax ?? '0'}`
  );
  return [header, ...lines].join('\n');
}

// ── sf_works レコードを挿入（SF 接続テスト用） ──────────────────────────────
function insertWork(db, key = 'test_novel') {
  db.prepare(`
    INSERT OR IGNORE INTO sf_works (work_key, title, work_type)
    VALUES (?, 'テスト小説', 'novel')
  `).run(key);
  return db.prepare(`SELECT id FROM sf_works WHERE work_key = ?`).get(key).id;
}

// ══════════════════════════════════════════════════════════════════════════════
// Section 1: parseDelimited
// ══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 1: parseDelimited');

await test('TSV を正しくパースする', () => {
  const text = 'Title\tASIN\tDate\nTest Book\tB001TEST001\t2026-07-15';
  const { headers, rows, delimiter } = parseDelimited(text);
  assert.equal(delimiter, '\t');
  assert.deepEqual(headers, ['title', 'asin', 'date']);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]['asin'], 'B001TEST001');
});

await test('CSV を正しくパースする（コンマ区切り）', () => {
  const text = 'Title,ASIN,Date\nTest Book,B001TEST001,2026-07-15';
  const { headers, rows, delimiter } = parseDelimited(text);
  assert.equal(delimiter, ',');
  assert.equal(rows.length, 1);
  assert.equal(rows[0]['date'], '2026-07-15');
});

await test('UTF-8 BOM を除去する', () => {
  const text = '\uFEFFTitle\tASIN\nTest Book\tB001TEST001';
  const { headers } = parseDelimited(text);
  assert.equal(headers[0], 'title');
});

await test('CRLF を正規化する', () => {
  const text = 'Title\tASIN\r\nTest Book\tB001TEST001\r\n';
  const { rows } = parseDelimited(text);
  assert.equal(rows.length, 1);
});

await test('ダブルクォート囲みフィールドを処理する', () => {
  const text = 'Title\tASIN\n"Book, with comma"\tB001TEST001';
  const { rows } = parseDelimited(text);
  assert.equal(rows[0]['title'], 'Book, with comma');
});

await test('ヘッダーを小文字・trim する', () => {
  const text = '  Title  \t  ASIN  \nTest\tB001TEST001';
  const { headers } = parseDelimited(text);
  assert.equal(headers[0], 'title');
  assert.equal(headers[1], 'asin');
});

await test('空テキストは空結果を返す', () => {
  const { headers, rows } = parseDelimited('');
  assert.equal(headers.length, 0);
  assert.equal(rows.length, 0);
});

await test('string 以外の引数でエラーをスロー', () => {
  assert.throws(() => parseDelimited(null), /text は string/);
});

// ══════════════════════════════════════════════════════════════════════════════
// Section 2: detectReportType
// ══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 2: detectReportType');

await test('Payment Number ヘッダー → payments', () => {
  assert.equal(detectReportType(['payment number', 'marketplace', 'net earnings']), 'payments');
});

await test('Total Royalties ヘッダー → royalties', () => {
  assert.equal(detectReportType(['asin', 'total royalties', 'transaction type', 'currency']), 'royalties');
});

await test('KENP Read ヘッダー → kenp', () => {
  assert.equal(detectReportType(['asin', 'marketplace', 'date', 'kenp read']), 'kenp');
});

await test('Units Ordered (Paid) ヘッダー → orders', () => {
  assert.equal(detectReportType(['asin', 'date', 'units ordered (paid)', 'units ordered (free)']), 'orders');
});

await test('Units Ordered ヘッダー（括弧なし）→ orders', () => {
  assert.equal(detectReportType(['asin', 'date', 'units ordered']), 'orders');
});

await test('不明なヘッダー → null', () => {
  assert.equal(detectReportType(['unknown', 'headers']), null);
});

await test('payments は royalties より優先される', () => {
  // payment number を含むなら payments
  assert.equal(detectReportType(['payment number', 'total royalties']), 'payments');
});

// ══════════════════════════════════════════════════════════════════════════════
// Section 3: importOrdersReport
// ══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 3: importOrdersReport');

await test('正常な Orders TSV をインポートする', () => {
  const d = createDb(':memory:');
  const tsv = makeOrdersTSV([
    { asin: 'B001TEST001', date: '2026-07-01', paid: '5', free: '0' },
    { asin: 'B001TEST002', date: '2026-07-01', paid: '2', free: '1' },
  ]);
  const { headers, rows } = parseDelimited(tsv);
  assert.equal(detectReportType(headers), 'orders');
  const r = importOrdersReport(d, rows);
  assert.equal(r.imported, 2);
  assert.equal(r.skipped, 0);
  const orders = getKdpOrders(d);
  assert.equal(orders.length, 2);
  d.close?.();
});

await test('ASIN 空行をスキップして警告を返す', () => {
  const d = createDb(':memory:');
  const rows = [{ 'asin': '', 'date': '2026-07-01', 'marketplace': 'amazon.co.jp' }];
  const r = importOrdersReport(d, rows);
  assert.equal(r.imported, 0);
  assert.equal(r.skipped, 1);
  assert.ok(r.warnings.length > 0);
  d.close?.();
});

await test('Date 不正な行をスキップする', () => {
  const d = createDb(':memory:');
  const rows = [{ 'asin': 'B001TEST001', 'date': 'not-a-date', 'marketplace': 'amazon.co.jp', 'title': 'T' }];
  const r = importOrdersReport(d, rows);
  assert.equal(r.skipped, 1);
  d.close?.();
});

await test('同一行を再インポートしても重複しない（冪等性）', () => {
  const d = createDb(':memory:');
  const row = [{ asin: 'B001TEST003', date: '2026-07-02', paid: '3', free: '0' }];
  const tsv = makeOrdersTSV(row);
  const { rows } = parseDelimited(tsv);
  importOrdersReport(d, rows);
  importOrdersReport(d, rows);
  const orders = getKdpOrders(d, { from: '2026-07-02', to: '2026-07-02' });
  assert.equal(orders.length, 1);
  d.close?.();
});

await test('format を正規化して保存する（ebook / paperback）', () => {
  const d = createDb(':memory:');
  const tsv = makeOrdersTSV([{ asin: 'B001TESTEBOK', format: 'eBook', paid: '1' }]);
  const { rows } = parseDelimited(tsv);
  importOrdersReport(d, rows);
  const books = getKdpBooks(d, { asin: 'B001TESTEBOK' });
  assert.equal(books[0]?.format, 'ebook');
  d.close?.();
});

// ══════════════════════════════════════════════════════════════════════════════
// Section 4: importKenpReport
// ══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 4: importKenpReport');

await test('正常な KENP TSV をインポートする', () => {
  const d = createDb(':memory:');
  const tsv = makeKenpTSV([
    { asin: 'B002TEST001', date: '2026-07-01', kenp: '500' },
    { asin: 'B002TEST001', date: '2026-07-02', kenp: '350' },
  ]);
  const { rows } = parseDelimited(tsv);
  const r = importKenpReport(d, rows);
  assert.equal(r.imported, 2);
  assert.equal(r.skipped, 0);
  const kenp = getKdpKenp(d);
  assert.equal(kenp.length, 2);
  d.close?.();
});

await test('ASIN 空行をスキップする', () => {
  const d = createDb(':memory:');
  const rows = [{ 'asin': '', 'date': '2026-07-01', 'kenp read': '100', 'marketplace': 'amazon.co.jp', 'title': 'T' }];
  const r = importKenpReport(d, rows);
  assert.equal(r.skipped, 1);
  d.close?.();
});

await test('KENP 冪等性（同一行を再インポートで重複しない）', () => {
  const d = createDb(':memory:');
  const tsv = makeKenpTSV([{ asin: 'B002TEST002', date: '2026-07-03', kenp: '200' }]);
  const { rows } = parseDelimited(tsv);
  importKenpReport(d, rows);
  importKenpReport(d, rows);
  const kenp = getKdpKenp(d, { from: '2026-07-03', to: '2026-07-03' });
  assert.equal(kenp.length, 1);
  d.close?.();
});

// ══════════════════════════════════════════════════════════════════════════════
// Section 5: importRoyaltiesReport
// ══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 5: importRoyaltiesReport');

await test('正常な Royalties TSV をインポートする', () => {
  const d = createDb(':memory:');
  const tsv = makeRoyaltiesTSV([
    { asin: 'B003TEST001', txType: 'Royalty', sold: '10', net: '10', total: '350', currency: 'JPY' },
    { asin: 'B003TEST001', txType: 'KU/KOLL', sold: '0', net: '0', total: '150', currency: 'JPY' },
  ]);
  const { rows } = parseDelimited(tsv);
  const r = importRoyaltiesReport(d, rows, { royalty_month: '2026-07' });
  assert.equal(r.imported, 2);
  assert.equal(r.skipped, 0);
  const royalties = getKdpRoyalties(d);
  assert.equal(royalties.length, 2);
  d.close?.();
});

await test('Transaction Type を正規化する（KU/KOLL → ku_koll）', () => {
  const d = createDb(':memory:');
  const tsv = makeRoyaltiesTSV([{ asin: 'B003TEST002', txType: 'KU/KOLL', total: '200', currency: 'JPY' }]);
  const { rows } = parseDelimited(tsv);
  importRoyaltiesReport(d, rows, { royalty_month: '2026-07' });
  const r = getKdpRoyalties(d);
  assert.equal(r[0].transaction_type, 'ku_koll');
  d.close?.();
});

await test('Transaction Type を正規化する（Refund → refund）', () => {
  const d = createDb(':memory:');
  const tsv = makeRoyaltiesTSV([{ asin: 'B003TEST003', txType: 'Refund', total: '-35', currency: 'JPY' }]);
  const { rows } = parseDelimited(tsv);
  importRoyaltiesReport(d, rows, { royalty_month: '2026-07' });
  const r = getKdpRoyalties(d);
  assert.equal(r[0].transaction_type, 'refund');
  d.close?.();
});

await test('royalty_month 未指定でエラーをスロー', () => {
  const d = createDb(':memory:');
  const { rows } = parseDelimited(makeRoyaltiesTSV([{ asin: 'B003TEST004' }]));
  assert.throws(
    () => importRoyaltiesReport(d, rows, { royalty_month: null }),
    /royalty_month が不正/
  );
  d.close?.();
});

await test('マッピング済み本は sf_revenue へ同期される', () => {
  const d = createDb(':memory:');
  const workId = insertWork(d, 'kdp_sf_work');
  // 先に本を登録してマッピング
  const bookId = writeKdpBook(d, { asin: 'B003TEST005', title: 'SF Book' });
  mapBookToSnowflakes(d, { book_id: bookId, work_id: workId });

  const tsv = makeRoyaltiesTSV([
    { asin: 'B003TEST005', txType: 'Royalty', net: '5', total: '175', currency: 'JPY' },
  ]);
  const { rows } = parseDelimited(tsv);
  importRoyaltiesReport(d, rows, { royalty_month: '2026-07' });

  const revenue = d.prepare(`SELECT * FROM sf_revenue WHERE platform = 'kdp'`).all();
  assert.ok(revenue.length > 0, 'sf_revenue に KDP 行が書き込まれていない');
  assert.equal(revenue[0].source, '電子書籍');
  d.close?.();
});

await test('マッピングなし本は sf_revenue へ書き込まない', () => {
  const d = createDb(':memory:');
  const tsv = makeRoyaltiesTSV([{ asin: 'B003TEST006', txType: 'Royalty', total: '350', currency: 'JPY' }]);
  const { rows } = parseDelimited(tsv);
  importRoyaltiesReport(d, rows, { royalty_month: '2026-07' });
  const revenue = d.prepare(`SELECT * FROM sf_revenue WHERE platform = 'kdp'`).all();
  assert.equal(revenue.length, 0);
  d.close?.();
});

await test('Royalties 冪等性（同一行を再インポートで重複しない）', () => {
  const d = createDb(':memory:');
  const tsv = makeRoyaltiesTSV([{ asin: 'B003TEST007', txType: 'Royalty', total: '350', currency: 'JPY' }]);
  const { rows } = parseDelimited(tsv);
  importRoyaltiesReport(d, rows, { royalty_month: '2026-07' });
  importRoyaltiesReport(d, rows, { royalty_month: '2026-07' });
  const royalties = getKdpRoyalties(d);
  // ASIN ごとに transaction_type 単位で1件のみ
  assert.equal(royalties.length, 1);
  d.close?.();
});

// ══════════════════════════════════════════════════════════════════════════════
// Section 6: importPaymentsReport
// ══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 6: importPaymentsReport');

await test('正常な Payments TSV をインポートする', () => {
  const d = createDb(':memory:');
  const tsv = makePaymentsTSV([
    { number: 'PAY001', marketplace: 'amazon.co.jp', net: '3500', amount: '3500' },
  ]);
  const { rows } = parseDelimited(tsv);
  const r = importPaymentsReport(d, rows);
  assert.equal(r.imported, 1);
  assert.equal(r.skipped, 0);
  const payments = getKdpPayments(d);
  assert.equal(payments.length, 1);
  assert.equal(payments[0].payment_number, 'PAY001');
  d.close?.();
});

await test('Payment Number 空行をスキップする', () => {
  const d = createDb(':memory:');
  const rows = [{ 'payment number': '', 'marketplace': 'amazon.co.jp' }];
  const r = importPaymentsReport(d, rows);
  assert.equal(r.skipped, 1);
  d.close?.();
});

await test('Payments 冪等性', () => {
  const d = createDb(':memory:');
  const tsv = makePaymentsTSV([{ number: 'PAY002', amount: '5000' }]);
  const { rows } = parseDelimited(tsv);
  importPaymentsReport(d, rows);
  importPaymentsReport(d, rows);
  const payments = getKdpPayments(d);
  assert.equal(payments.length, 1);
  d.close?.();
});

// ══════════════════════════════════════════════════════════════════════════════
// Section 7: importKdpReport（自動検出）
// ══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 7: importKdpReport');

await test('Orders TSV を自動検出してインポート', () => {
  const d = createDb(':memory:');
  const tsv = makeOrdersTSV([{ asin: 'B007TEST001', paid: '4' }]);
  const r = importKdpReport(d, tsv);
  assert.equal(r.report_type, 'orders');
  assert.equal(r.imported, 1);
  d.close?.();
});

await test('KENP TSV を自動検出してインポート', () => {
  const d = createDb(':memory:');
  const tsv = makeKenpTSV([{ asin: 'B007TEST002', kenp: '300' }]);
  const r = importKdpReport(d, tsv);
  assert.equal(r.report_type, 'kenp');
  assert.equal(r.imported, 1);
  d.close?.();
});

await test('Royalties TSV を自動検出してインポート（royalty_month 必須）', () => {
  const d = createDb(':memory:');
  const tsv = makeRoyaltiesTSV([{ asin: 'B007TEST003', total: '400', currency: 'JPY' }]);
  const r = importKdpReport(d, tsv, { royalty_month: '2026-07' });
  assert.equal(r.report_type, 'royalties');
  assert.equal(r.imported, 1);
  d.close?.();
});

await test('Payments TSV を自動検出してインポート', () => {
  const d = createDb(':memory:');
  const tsv = makePaymentsTSV([{ number: 'PAY007' }]);
  const r = importKdpReport(d, tsv);
  assert.equal(r.report_type, 'payments');
  assert.equal(r.imported, 1);
  d.close?.();
});

await test('不明なヘッダーでエラーをスロー', () => {
  const d = createDb(':memory:');
  assert.throws(
    () => importKdpReport(d, 'unknown\theaders\nval1\tval2'),
    /レポートタイプを検出できません/
  );
  d.close?.();
});

await test('report_type を明示指定で auto-detect をバイパス', () => {
  const d = createDb(':memory:');
  const tsv = makeOrdersTSV([{ asin: 'B007TEST004' }]);
  const r = importKdpReport(d, tsv, { report_type: 'orders' });
  assert.equal(r.report_type, 'orders');
  d.close?.();
});

await test('インポートログが記録される', () => {
  const d = createDb(':memory:');
  const tsv = makeOrdersTSV([{ asin: 'B007TEST005' }]);
  importKdpReport(d, tsv, { file_name: 'test_report.tsv' });
  const logs = d.prepare('SELECT * FROM kdp_import_log').all();
  assert.ok(logs.length > 0);
  assert.equal(logs[0].report_type, 'orders');
  d.close?.();
});

// ══════════════════════════════════════════════════════════════════════════════
// Section 8: writeKdpBook / getOrCreateBook
// ══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 8: writeKdpBook / getOrCreateBook');

await test('writeKdpBook で本を新規登録する', () => {
  const d = createDb(':memory:');
  const id = writeKdpBook(d, { asin: 'B008TEST001', title: '電子書籍テスト', author: 'テスト著者', format: 'ebook' });
  assert.ok(Number.isInteger(id) && id > 0);
  const books = getKdpBooks(d, { asin: 'B008TEST001' });
  assert.equal(books.length, 1);
  assert.equal(books[0].title, '電子書籍テスト');
  assert.equal(books[0].format, 'ebook');
  d.close?.();
});

await test('ASIN を大文字に正規化する', () => {
  const d = createDb(':memory:');
  writeKdpBook(d, { asin: 'b008test002', title: 'lower asin test' });
  const books = getKdpBooks(d, { asin: 'B008TEST002' });
  assert.equal(books.length, 1);
  d.close?.();
});

await test('UPSERT で既存本を更新する（title は上書き）', () => {
  const d = createDb(':memory:');
  writeKdpBook(d, { asin: 'B008TEST003', title: '旧タイトル' });
  writeKdpBook(d, { asin: 'B008TEST003', title: '新タイトル' });
  const books = getKdpBooks(d, { asin: 'B008TEST003' });
  assert.equal(books[0].title, '新タイトル');
  d.close?.();
});

await test('UPSERT で既存 author NULL を COALESCE 保護する', () => {
  const d = createDb(':memory:');
  writeKdpBook(d, { asin: 'B008TEST004', title: 'タイトル', author: '最初の著者' });
  writeKdpBook(d, { asin: 'B008TEST004', title: 'タイトル', author: null });
  const books = getKdpBooks(d, { asin: 'B008TEST004' });
  assert.equal(books[0].author, '最初の著者'); // NULL で上書きされない
  d.close?.();
});

await test('不正 ASIN でエラーをスロー（空文字・特殊文字）', () => {
  const d = createDb(':memory:');
  assert.throws(() => writeKdpBook(d, { asin: '', title: 'Test' }), /ASIN が不正/);
  assert.throws(() => writeKdpBook(d, { asin: 'ASIN-WITH-HYPHEN', title: 'Test' }), /ASIN が不正/);
  d.close?.();
});

await test('空 title でエラーをスロー', () => {
  const d = createDb(':memory:');
  assert.throws(() => writeKdpBook(d, { asin: 'B008TEST005', title: '' }), /title が空/);
  d.close?.();
});

await test('getOrCreateBook で既存本を返す', () => {
  const d = createDb(':memory:');
  const id1 = getOrCreateBook(d, 'B008TEST006', 'Test Book');
  const id2 = getOrCreateBook(d, 'B008TEST006', 'Test Book');
  assert.equal(id1, id2);
  d.close?.();
});

await test('getOrCreateBook で新規登録して id を返す', () => {
  const d = createDb(':memory:');
  const id = getOrCreateBook(d, 'B008TEST007', '新しい本');
  assert.ok(Number.isInteger(id) && id > 0);
  d.close?.();
});

// ══════════════════════════════════════════════════════════════════════════════
// Section 9: writeKdpOrderDaily
// ══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 9: writeKdpOrderDaily');

await test('日次注文を正常に挿入する', () => {
  const d = createDb(':memory:');
  const book_id = writeKdpBook(d, { asin: 'B009TEST001', title: 'Order Test' });
  writeKdpOrderDaily(d, { date: '2026-07-01', book_id, marketplace: 'amazon.co.jp', paid_units: 5, free_units: 0 });
  const orders = getKdpOrders(d, { book_id });
  assert.equal(orders.length, 1);
  assert.equal(orders[0].paid_units, 5);
  d.close?.();
});

await test('同一 date/book_id/marketplace の再挿入で冪等', () => {
  const d = createDb(':memory:');
  const book_id = writeKdpBook(d, { asin: 'B009TEST002', title: 'Idempotent Order' });
  writeKdpOrderDaily(d, { date: '2026-07-02', book_id, marketplace: 'amazon.co.jp', paid_units: 3 });
  writeKdpOrderDaily(d, { date: '2026-07-02', book_id, marketplace: 'amazon.co.jp', paid_units: 3 });
  const orders = getKdpOrders(d, { book_id });
  assert.equal(orders.length, 1);
  d.close?.();
});

await test('NULL paid_units を COALESCE で保護する', () => {
  const d = createDb(':memory:');
  const book_id = writeKdpBook(d, { asin: 'B009TEST003', title: 'NULL Test' });
  writeKdpOrderDaily(d, { date: '2026-07-03', book_id, marketplace: 'amazon.co.jp', paid_units: 7 });
  writeKdpOrderDaily(d, { date: '2026-07-03', book_id, marketplace: 'amazon.co.jp', paid_units: null });
  const orders = getKdpOrders(d, { book_id });
  assert.equal(orders[0].paid_units, 7); // NULL で上書きされない
  d.close?.();
});

await test('不正 date でエラーをスロー', () => {
  const d = createDb(':memory:');
  const book_id = writeKdpBook(d, { asin: 'B009TEST004', title: 'T' });
  assert.throws(
    () => writeKdpOrderDaily(d, { date: 'not-a-date', book_id, marketplace: 'amazon.co.jp' }),
    /date が不正/
  );
  d.close?.();
});

// ══════════════════════════════════════════════════════════════════════════════
// Section 10: writeKdpKenpDaily
// ══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 10: writeKdpKenpDaily');

await test('日次 KENP を正常に挿入する', () => {
  const d = createDb(':memory:');
  const book_id = writeKdpBook(d, { asin: 'B010TEST001', title: 'KENP Test' });
  writeKdpKenpDaily(d, { date: '2026-07-01', book_id, marketplace: 'amazon.co.jp', kenp_read: 500 });
  const kenp = getKdpKenp(d, { book_id });
  assert.equal(kenp.length, 1);
  assert.equal(kenp[0].kenp_read, 500);
  d.close?.();
});

await test('KENP 冪等性（重複挿入で1件のまま）', () => {
  const d = createDb(':memory:');
  const book_id = writeKdpBook(d, { asin: 'B010TEST002', title: 'KENP Idempotent' });
  writeKdpKenpDaily(d, { date: '2026-07-02', book_id, marketplace: 'amazon.co.jp', kenp_read: 300 });
  writeKdpKenpDaily(d, { date: '2026-07-02', book_id, marketplace: 'amazon.co.jp', kenp_read: 300 });
  const kenp = getKdpKenp(d, { book_id });
  assert.equal(kenp.length, 1);
  d.close?.();
});

await test('kenp_read NULL を COALESCE で保護する', () => {
  const d = createDb(':memory:');
  const book_id = writeKdpBook(d, { asin: 'B010TEST003', title: 'KENP NULL' });
  writeKdpKenpDaily(d, { date: '2026-07-03', book_id, marketplace: 'amazon.co.jp', kenp_read: 200 });
  writeKdpKenpDaily(d, { date: '2026-07-03', book_id, marketplace: 'amazon.co.jp', kenp_read: null });
  const kenp = getKdpKenp(d, { book_id });
  assert.equal(kenp[0].kenp_read, 200);
  d.close?.();
});

// ══════════════════════════════════════════════════════════════════════════════
// Section 11: writeKdpRoyalty
// ══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 11: writeKdpRoyalty');

await test('月次ロイヤリティを正常に挿入する', () => {
  const d = createDb(':memory:');
  const book_id = writeKdpBook(d, { asin: 'B011TEST001', title: 'Royalty Test' });
  writeKdpRoyalty(d, {
    royalty_month: '2026-07', book_id, marketplace: 'amazon.co.jp',
    transaction_type: 'royalty', units_sold: 10, net_units: 10,
    royalty_amount: 350, currency: 'JPY',
  });
  const r = getKdpRoyalties(d, { book_id });
  assert.equal(r.length, 1);
  assert.equal(r[0].royalty_amount, 350);
  assert.equal(r[0].currency, 'JPY');
  d.close?.();
});

await test('未知 transaction_type を "other" に正規化する', () => {
  const d = createDb(':memory:');
  const book_id = writeKdpBook(d, { asin: 'B011TEST002', title: 'Unknown TX' });
  writeKdpRoyalty(d, {
    royalty_month: '2026-07', book_id, marketplace: 'amazon.co.jp',
    transaction_type: 'unknown_type', royalty_amount: 100, currency: 'JPY',
  });
  const r = getKdpRoyalties(d, { book_id });
  assert.equal(r[0].transaction_type, 'other');
  d.close?.();
});

await test('Royalty 冪等性（UNIQUE on month/book/marketplace/txtype）', () => {
  const d = createDb(':memory:');
  const book_id = writeKdpBook(d, { asin: 'B011TEST003', title: 'Idem Royalty' });
  writeKdpRoyalty(d, { royalty_month: '2026-07', book_id, marketplace: 'amazon.co.jp', transaction_type: 'royalty', royalty_amount: 100, currency: 'JPY' });
  writeKdpRoyalty(d, { royalty_month: '2026-07', book_id, marketplace: 'amazon.co.jp', transaction_type: 'royalty', royalty_amount: 100, currency: 'JPY' });
  const r = getKdpRoyalties(d, { book_id });
  assert.equal(r.length, 1);
  d.close?.();
});

await test('不正 royalty_month でエラーをスロー', () => {
  const d = createDb(':memory:');
  const book_id = writeKdpBook(d, { asin: 'B011TEST004', title: 'T' });
  assert.throws(
    () => writeKdpRoyalty(d, { royalty_month: 'not-a-month', book_id, marketplace: 'amazon.co.jp', currency: 'JPY' }),
    /royalty_month が不正/
  );
  d.close?.();
});

// ══════════════════════════════════════════════════════════════════════════════
// Section 12: writeKdpPayment
// ══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 12: writeKdpPayment');

await test('支払いを正常に挿入する', () => {
  const d = createDb(':memory:');
  writeKdpPayment(d, {
    payment_number: 'PAY012001', marketplace: 'amazon.co.jp',
    sales_period: '2026-06', payment_status: 'Paid',
    payment_date: '2026-07-29', net_earnings: 3500, currency: 'JPY',
    payment_amount: 3500,
  });
  const payments = getKdpPayments(d);
  assert.equal(payments.length, 1);
  assert.equal(payments[0].net_earnings, 3500);
  d.close?.();
});

await test('支払い冪等性（UNIQUE on payment_number/marketplace）', () => {
  const d = createDb(':memory:');
  writeKdpPayment(d, { payment_number: 'PAY012002', marketplace: 'amazon.co.jp', currency: 'JPY', net_earnings: 1000 });
  writeKdpPayment(d, { payment_number: 'PAY012002', marketplace: 'amazon.co.jp', currency: 'JPY', net_earnings: 1000 });
  const payments = getKdpPayments(d);
  assert.equal(payments.length, 1);
  d.close?.();
});

await test('payment_status を上書き更新できる（COALESCE なし）', () => {
  const d = createDb(':memory:');
  writeKdpPayment(d, { payment_number: 'PAY012003', marketplace: 'amazon.co.jp', currency: 'JPY', payment_status: 'Pending' });
  writeKdpPayment(d, { payment_number: 'PAY012003', marketplace: 'amazon.co.jp', currency: 'JPY', payment_status: 'Paid' });
  const payments = getKdpPayments(d);
  assert.equal(payments[0].payment_status, 'Paid');
  d.close?.();
});

await test('payment_number 空文字でエラーをスロー', () => {
  const d = createDb(':memory:');
  assert.throws(
    () => writeKdpPayment(d, { payment_number: '', marketplace: 'amazon.co.jp', currency: 'JPY' }),
    /payment_number が空/
  );
  d.close?.();
});

// ══════════════════════════════════════════════════════════════════════════════
// Section 13: mapBookToSnowflakes
// ══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 13: mapBookToSnowflakes');

await test('KDP 本を SF 作品にマッピングする', () => {
  const d = createDb(':memory:');
  const workId = insertWork(d, 'map_test_work');
  const bookId = writeKdpBook(d, { asin: 'B013TEST001', title: 'Mapped Book' });
  mapBookToSnowflakes(d, { book_id: bookId, work_id: workId });
  const books = getKdpBooks(d, { sf_only: true });
  assert.equal(books.length, 1);
  assert.equal(books[0].sf_work_id, workId);
  d.close?.();
});

await test('同一 book_id の再マッピングで work_id を更新する', () => {
  const d = createDb(':memory:');
  const workId1 = insertWork(d, 'map_work_1');
  const workId2 = insertWork(d, 'map_work_2');
  const bookId = writeKdpBook(d, { asin: 'B013TEST002', title: 'Remap Book' });
  mapBookToSnowflakes(d, { book_id: bookId, work_id: workId1 });
  mapBookToSnowflakes(d, { book_id: bookId, work_id: workId2 });
  const books = getKdpBooks(d, { asin: 'B013TEST002' });
  assert.equal(books[0].sf_work_id, workId2);
  d.close?.();
});

await test('不正 book_id でエラーをスロー', () => {
  const d = createDb(':memory:');
  const workId = insertWork(d, 'map_err_work');
  assert.throws(
    () => mapBookToSnowflakes(d, { book_id: -1, work_id: workId }),
    /book_id が不正/
  );
  d.close?.();
});

await test('sf_only フィルターでマッピング済みのみ返す', () => {
  const d = createDb(':memory:');
  const workId = insertWork(d, 'sf_only_work');
  const bookId1 = writeKdpBook(d, { asin: 'B013TEST003', title: 'Mapped' });
  writeKdpBook(d, { asin: 'B013TEST004', title: 'Unmapped' });
  mapBookToSnowflakes(d, { book_id: bookId1, work_id: workId });
  const sfBooks = getKdpBooks(d, { sf_only: true });
  assert.equal(sfBooks.length, 1);
  assert.equal(sfBooks[0].asin, 'B013TEST003');
  d.close?.();
});

// ══════════════════════════════════════════════════════════════════════════════
// Section 14: syncKdpRevenue
// ══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 14: syncKdpRevenue');

await test('マッピング済み本のロイヤリティを sf_revenue へ同期する', () => {
  const d = createDb(':memory:');
  const workId = insertWork(d, 'revenue_sync_work');
  const bookId = writeKdpBook(d, { asin: 'B014TEST001', title: 'Revenue Book' });
  mapBookToSnowflakes(d, { book_id: bookId, work_id: workId });
  writeKdpRoyalty(d, { royalty_month: '2026-07', book_id: bookId, marketplace: 'amazon.co.jp', transaction_type: 'royalty', net_units: 5, royalty_amount: 175, currency: 'JPY' });
  const written = syncKdpRevenue(d, bookId, '2026-07');
  assert.equal(written, 1);
  const revenue = d.prepare(`SELECT * FROM sf_revenue WHERE platform = 'kdp'`).all();
  assert.ok(revenue.length > 0);
  assert.equal(revenue[0].month, '2026-07');
  assert.equal(revenue[0].source, '電子書籍');
  assert.equal(revenue[0].currency, 'JPY');
  d.close?.();
});

await test('マッピングなし本は sf_revenue に書き込まず 0 を返す', () => {
  const d = createDb(':memory:');
  const bookId = writeKdpBook(d, { asin: 'B014TEST002', title: 'Unmapped Revenue' });
  writeKdpRoyalty(d, { royalty_month: '2026-07', book_id: bookId, marketplace: 'amazon.co.jp', transaction_type: 'royalty', royalty_amount: 100, currency: 'JPY' });
  const written = syncKdpRevenue(d, bookId, '2026-07');
  assert.equal(written, 0);
  const revenue = d.prepare(`SELECT * FROM sf_revenue WHERE platform = 'kdp'`).all();
  assert.equal(revenue.length, 0);
  d.close?.();
});

await test('同期を複数回実行しても sf_revenue 行数は変わらない（冪等性）', () => {
  const d = createDb(':memory:');
  const workId = insertWork(d, 'idem_sync_work');
  const bookId = writeKdpBook(d, { asin: 'B014TEST003', title: 'Idem Revenue' });
  mapBookToSnowflakes(d, { book_id: bookId, work_id: workId });
  writeKdpRoyalty(d, { royalty_month: '2026-07', book_id: bookId, marketplace: 'amazon.co.jp', transaction_type: 'royalty', royalty_amount: 200, currency: 'JPY' });
  syncKdpRevenue(d, bookId, '2026-07');
  syncKdpRevenue(d, bookId, '2026-07');
  const revenue = d.prepare(`SELECT * FROM sf_revenue WHERE platform = 'kdp'`).all();
  assert.equal(revenue.length, 1);
  d.close?.();
});

// ══════════════════════════════════════════════════════════════════════════════
// Section 15: 通貨分離
// ══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 15: 通貨分離');

await test('JPY と USD のロイヤリティは別レコードに保存される', () => {
  const d = createDb(':memory:');
  const bookId = writeKdpBook(d, { asin: 'B015TEST001', title: 'Multi Currency' });
  writeKdpRoyalty(d, { royalty_month: '2026-07', book_id: bookId, marketplace: 'amazon.co.jp', transaction_type: 'royalty', royalty_amount: 350, currency: 'JPY' });
  writeKdpRoyalty(d, { royalty_month: '2026-07', book_id: bookId, marketplace: 'amazon.com', transaction_type: 'royalty', royalty_amount: 2.50, currency: 'USD' });
  const r = getKdpRoyalties(d, { book_id: bookId });
  assert.equal(r.length, 2);
  const jpy = r.find(x => x.currency === 'JPY');
  const usd = r.find(x => x.currency === 'USD');
  assert.ok(jpy, 'JPY レコードが存在しない');
  assert.ok(usd, 'USD レコードが存在しない');
  d.close?.();
});

await test('sf_revenue sync で JPY と USD が別行に書き込まれる', () => {
  const d = createDb(':memory:');
  const workId = insertWork(d, 'multi_currency_work');
  const bookId = writeKdpBook(d, { asin: 'B015TEST002', title: 'Multi Currency SF' });
  mapBookToSnowflakes(d, { book_id: bookId, work_id: workId });
  writeKdpRoyalty(d, { royalty_month: '2026-07', book_id: bookId, marketplace: 'amazon.co.jp', transaction_type: 'royalty', royalty_amount: 350, currency: 'JPY' });
  writeKdpRoyalty(d, { royalty_month: '2026-07', book_id: bookId, marketplace: 'amazon.com', transaction_type: 'royalty', royalty_amount: 2.50, currency: 'USD' });
  syncKdpRevenue(d, bookId, '2026-07');
  const revenue = d.prepare(`SELECT * FROM sf_revenue WHERE platform = 'kdp' ORDER BY currency ASC`).all();
  assert.equal(revenue.length, 2, 'sf_revenue に JPY と USD の2行がない');
  assert.notEqual(revenue[0].currency, revenue[1].currency, '通貨が同じ（合算されている）');
  d.close?.();
});

await test('getKdpSummary で通貨別サマリーを返す', () => {
  const d = createDb(':memory:');
  const bookId = writeKdpBook(d, { asin: 'B015TEST003', title: 'Summary Multi' });
  writeKdpRoyalty(d, { royalty_month: '2026-07', book_id: bookId, marketplace: 'amazon.co.jp', transaction_type: 'royalty', royalty_amount: 500, currency: 'JPY' });
  writeKdpRoyalty(d, { royalty_month: '2026-07', book_id: bookId, marketplace: 'amazon.com', transaction_type: 'royalty', royalty_amount: 3.50, currency: 'USD' });
  const summary = getKdpSummary(d, { royalty_month: '2026-07' });
  assert.equal(summary.by_currency.length, 2);
  const currencies = summary.by_currency.map(x => x.currency).sort();
  assert.deepEqual(currencies, ['JPY', 'USD']);
  d.close?.();
});

// ══════════════════════════════════════════════════════════════════════════════
// Section 16: getKdpBooks / getKdpOrders / getKdpKenp / getKdpRoyalties / getKdpPayments
// ══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 16: getKdp各種 READ 関数');

await test('getKdpBooks — 全件取得', () => {
  const d = createDb(':memory:');
  writeKdpBook(d, { asin: 'B016TEST001', title: 'Book A' });
  writeKdpBook(d, { asin: 'B016TEST002', title: 'Book B' });
  const books = getKdpBooks(d);
  assert.ok(books.length >= 2);
  d.close?.();
});

await test('getKdpBooks — sf_only フィルター', () => {
  const d = createDb(':memory:');
  const workId = insertWork(d, 'get_sf_only');
  const bookId = writeKdpBook(d, { asin: 'B016TEST003', title: 'SF Book' });
  writeKdpBook(d, { asin: 'B016TEST004', title: 'Non SF' });
  mapBookToSnowflakes(d, { book_id: bookId, work_id: workId });
  const books = getKdpBooks(d, { sf_only: true });
  assert.equal(books.length, 1);
  assert.equal(books[0].asin, 'B016TEST003');
  d.close?.();
});

await test('getKdpOrders — 日付範囲フィルター', () => {
  const d = createDb(':memory:');
  const book_id = writeKdpBook(d, { asin: 'B016TEST005', title: 'Order Range' });
  writeKdpOrderDaily(d, { date: '2026-07-01', book_id, marketplace: 'amazon.co.jp', paid_units: 3 });
  writeKdpOrderDaily(d, { date: '2026-07-15', book_id, marketplace: 'amazon.co.jp', paid_units: 5 });
  writeKdpOrderDaily(d, { date: '2026-07-31', book_id, marketplace: 'amazon.co.jp', paid_units: 2 });
  const orders = getKdpOrders(d, { from: '2026-07-10', to: '2026-07-20' });
  assert.equal(orders.length, 1);
  assert.equal(orders[0].paid_units, 5);
  d.close?.();
});

await test('getKdpKenp — 本フィルター', () => {
  const d = createDb(':memory:');
  const book1 = writeKdpBook(d, { asin: 'B016TEST006', title: 'KENP Book 1' });
  const book2 = writeKdpBook(d, { asin: 'B016TEST007', title: 'KENP Book 2' });
  writeKdpKenpDaily(d, { date: '2026-07-01', book_id: book1, marketplace: 'amazon.co.jp', kenp_read: 100 });
  writeKdpKenpDaily(d, { date: '2026-07-01', book_id: book2, marketplace: 'amazon.co.jp', kenp_read: 200 });
  const kenp = getKdpKenp(d, { book_id: book1 });
  assert.equal(kenp.length, 1);
  assert.equal(kenp[0].kenp_read, 100);
  d.close?.();
});

await test('getKdpRoyalties — 月フィルター', () => {
  const d = createDb(':memory:');
  const book_id = writeKdpBook(d, { asin: 'B016TEST008', title: 'Royalty Month Filter' });
  writeKdpRoyalty(d, { royalty_month: '2026-06', book_id, marketplace: 'amazon.co.jp', transaction_type: 'royalty', royalty_amount: 100, currency: 'JPY' });
  writeKdpRoyalty(d, { royalty_month: '2026-07', book_id, marketplace: 'amazon.co.jp', transaction_type: 'royalty', royalty_amount: 200, currency: 'JPY' });
  const r = getKdpRoyalties(d, { royalty_month: '2026-07' });
  assert.equal(r.length, 1);
  assert.equal(r[0].royalty_amount, 200);
  d.close?.();
});

await test('getKdpPayments — marketplace フィルター', () => {
  const d = createDb(':memory:');
  writeKdpPayment(d, { payment_number: 'PAY016A', marketplace: 'amazon.co.jp', currency: 'JPY', net_earnings: 3500 });
  writeKdpPayment(d, { payment_number: 'PAY016B', marketplace: 'amazon.com', currency: 'USD', net_earnings: 25.00 });
  const jp = getKdpPayments(d, { marketplace: 'amazon.co.jp' });
  assert.equal(jp.length, 1);
  assert.equal(jp[0].payment_number, 'PAY016A');
  d.close?.();
});

// ══════════════════════════════════════════════════════════════════════════════
// Section 17: getKdpSummary
// ══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 17: getKdpSummary');

await test('データなし時は null と空配列を返す', () => {
  const d = createDb(':memory:');
  const summary = getKdpSummary(d);
  assert.equal(summary.royalty_month, null);
  assert.deepEqual(summary.by_currency, []);
  assert.deepEqual(summary.by_book, []);
  d.close?.();
});

await test('最新月を自動選択する', () => {
  const d = createDb(':memory:');
  const book_id = writeKdpBook(d, { asin: 'B017TEST001', title: 'Summary Book' });
  writeKdpRoyalty(d, { royalty_month: '2026-06', book_id, marketplace: 'amazon.co.jp', transaction_type: 'royalty', royalty_amount: 100, currency: 'JPY' });
  writeKdpRoyalty(d, { royalty_month: '2026-07', book_id, marketplace: 'amazon.co.jp', transaction_type: 'royalty', royalty_amount: 300, currency: 'JPY' });
  const summary = getKdpSummary(d);
  assert.equal(summary.royalty_month, '2026-07');
  d.close?.();
});

await test('月指定でサマリーを取得する', () => {
  const d = createDb(':memory:');
  const book_id = writeKdpBook(d, { asin: 'B017TEST002', title: 'Month Summary' });
  writeKdpRoyalty(d, { royalty_month: '2026-07', book_id, marketplace: 'amazon.co.jp', transaction_type: 'royalty', royalty_amount: 500, currency: 'JPY' });
  writeKdpRoyalty(d, { royalty_month: '2026-07', book_id, marketplace: 'amazon.co.jp', transaction_type: 'ku_koll', royalty_amount: 150, currency: 'JPY' });
  const summary = getKdpSummary(d, { royalty_month: '2026-07' });
  assert.equal(summary.royalty_month, '2026-07');
  assert.equal(summary.by_currency.length, 1);
  assert.ok(summary.by_currency[0].total_royalty >= 650);
  d.close?.();
});

await test('by_book に本タイトルと marketplace が含まれる', () => {
  const d = createDb(':memory:');
  const book_id = writeKdpBook(d, { asin: 'B017TEST003', title: 'Book With Details' });
  writeKdpRoyalty(d, { royalty_month: '2026-07', book_id, marketplace: 'amazon.co.jp', transaction_type: 'royalty', royalty_amount: 100, currency: 'JPY' });
  const summary = getKdpSummary(d, { royalty_month: '2026-07' });
  assert.ok(summary.by_book[0].title === 'Book With Details');
  assert.ok(summary.by_book[0].marketplace === 'amazon.co.jp');
  d.close?.();
});

// ══════════════════════════════════════════════════════════════════════════════
// Section 18: getSnowflakesKdpSummary
// ══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 18: getSnowflakesKdpSummary');

await test('データなし時は null と空配列を返す', () => {
  const d = createDb(':memory:');
  const summary = getSnowflakesKdpSummary(d);
  assert.equal(summary.royalty_month, null);
  assert.deepEqual(summary.by_work, []);
  d.close?.();
});

await test('マッピングなし本は含まれない', () => {
  const d = createDb(':memory:');
  const book_id = writeKdpBook(d, { asin: 'B018TEST001', title: 'Unmapped SF' });
  writeKdpRoyalty(d, { royalty_month: '2026-07', book_id, marketplace: 'amazon.co.jp', transaction_type: 'royalty', royalty_amount: 100, currency: 'JPY' });
  const summary = getSnowflakesKdpSummary(d);
  assert.equal(summary.royalty_month, null); // マッピング済み本にデータがない
  d.close?.();
});

await test('マッピング済み本のみを含む', () => {
  const d = createDb(':memory:');
  const workId = insertWork(d, 'sf_kdp_summary_work');
  const bookId1 = writeKdpBook(d, { asin: 'B018TEST002', title: 'Mapped SF' });
  const bookId2 = writeKdpBook(d, { asin: 'B018TEST003', title: 'Unmapped' });
  mapBookToSnowflakes(d, { book_id: bookId1, work_id: workId });
  writeKdpRoyalty(d, { royalty_month: '2026-07', book_id: bookId1, marketplace: 'amazon.co.jp', transaction_type: 'royalty', royalty_amount: 300, currency: 'JPY' });
  writeKdpRoyalty(d, { royalty_month: '2026-07', book_id: bookId2, marketplace: 'amazon.co.jp', transaction_type: 'royalty', royalty_amount: 9999, currency: 'JPY' });
  const summary = getSnowflakesKdpSummary(d, { royalty_month: '2026-07' });
  assert.equal(summary.royalty_month, '2026-07');
  assert.equal(summary.by_work.length, 1);
  assert.equal(summary.by_work[0].book_title, 'Mapped SF');
  assert.ok(summary.by_currency[0].total_royalty < 1000, 'Unmapped の 9999 が混入している');
  d.close?.();
});

await test('by_work に work_title が含まれる', () => {
  const d = createDb(':memory:');
  const workId = insertWork(d, 'sf_kdp_work_title');
  const bookId = writeKdpBook(d, { asin: 'B018TEST004', title: 'Title In Summary' });
  mapBookToSnowflakes(d, { book_id: bookId, work_id: workId });
  writeKdpRoyalty(d, { royalty_month: '2026-07', book_id: bookId, marketplace: 'amazon.co.jp', transaction_type: 'royalty', royalty_amount: 100, currency: 'JPY' });
  const summary = getSnowflakesKdpSummary(d, { royalty_month: '2026-07' });
  assert.ok(summary.by_work[0].work_title === 'テスト小説');
  d.close?.();
});

// ══════════════════════════════════════════════════════════════════════════════
// Section 19: API HTTP エンドポイント
// ══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 19: API HTTP エンドポイント');

// テストデータを DB に挿入
const apiBookId = writeKdpBook(db, { asin: 'B019APITEST', title: 'API Test Book', format: 'ebook' });
const apiWorkId = insertWork(db, 'api_test_work');
mapBookToSnowflakes(db, { book_id: apiBookId, work_id: apiWorkId });
writeKdpOrderDaily(db, { date: '2026-07-10', book_id: apiBookId, marketplace: 'amazon.co.jp', paid_units: 3, free_units: 0 });
writeKdpKenpDaily(db, { date: '2026-07-10', book_id: apiBookId, marketplace: 'amazon.co.jp', kenp_read: 500 });
writeKdpRoyalty(db, { royalty_month: '2026-07', book_id: apiBookId, marketplace: 'amazon.co.jp', transaction_type: 'royalty', units_sold: 3, net_units: 3, royalty_amount: 105, currency: 'JPY' });
writeKdpPayment(db, { payment_number: 'PAY019API', marketplace: 'amazon.co.jp', currency: 'JPY', net_earnings: 105, payment_amount: 105, payment_date: '2026-08-29' });

await test('GET /api/kdp/books → 200 OK / books 配列', async () => {
  const { status, data } = await api('GET', '/api/kdp/books');
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.ok(Array.isArray(data.books));
  assert.ok(data.books.length > 0);
});

await test('GET /api/kdp/books?sf_only=1 → マッピング済みのみ', async () => {
  const { status, data } = await api('GET', '/api/kdp/books?sf_only=1');
  assert.equal(status, 200);
  assert.ok(data.books.every(b => b.sf_work_id !== null));
});

await test('GET /api/kdp/orders → 200 OK / rows 配列', async () => {
  const { status, data } = await api('GET', '/api/kdp/orders');
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.ok(Array.isArray(data.rows));
  assert.ok(data.rows.length > 0);
});

await test('GET /api/kdp/orders?from=&to= → フィルター動作', async () => {
  const { status, data } = await api('GET', '/api/kdp/orders?from=2026-07-01&to=2026-07-31');
  assert.equal(status, 200);
  assert.ok(data.rows.length > 0);
});

await test('GET /api/kdp/kenp → 200 OK / rows 配列', async () => {
  const { status, data } = await api('GET', '/api/kdp/kenp');
  assert.equal(status, 200);
  assert.ok(Array.isArray(data.rows));
});

await test('GET /api/kdp/royalties → 200 OK / rows 配列', async () => {
  const { status, data } = await api('GET', '/api/kdp/royalties');
  assert.equal(status, 200);
  assert.ok(Array.isArray(data.rows));
  assert.ok(data.rows.length > 0);
});

await test('GET /api/kdp/royalties?royalty_month=2026-07 → 月フィルター', async () => {
  const { status, data } = await api('GET', '/api/kdp/royalties?royalty_month=2026-07');
  assert.equal(status, 200);
  assert.ok(data.rows.every(r => r.royalty_month === '2026-07'));
});

await test('GET /api/kdp/payments → 200 OK / rows 配列', async () => {
  const { status, data } = await api('GET', '/api/kdp/payments');
  assert.equal(status, 200);
  assert.ok(Array.isArray(data.rows));
});

await test('GET /api/kdp/summary → 200 OK / royalty_month 含む', async () => {
  const { status, data } = await api('GET', '/api/kdp/summary');
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.ok(data.royalty_month !== undefined);
});

await test('GET /api/kdp/summary?royalty_month=2026-07 → 月指定', async () => {
  const { status, data } = await api('GET', '/api/kdp/summary?royalty_month=2026-07');
  assert.equal(status, 200);
  assert.equal(data.royalty_month, '2026-07');
});

await test('GET /api/sf/kdp/summary → 200 OK / SF マッピング済みのみ', async () => {
  const { status, data } = await api('GET', '/api/sf/kdp/summary');
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.ok(data.royalty_month !== undefined);
});

await test('GET /api/kdp/books?asin=B019APITEST → 単一 ASIN 検索', async () => {
  const { status, data } = await api('GET', '/api/kdp/books?asin=B019APITEST');
  assert.equal(status, 200);
  assert.equal(data.books.length, 1);
  assert.equal(data.books[0].asin, 'B019APITEST');
});

// ══════════════════════════════════════════════════════════════════════════════
// Section 20: 実 DB 未使用 / 外部通信なし / 他テーブル汚染なし
// ══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 20: 実 DB 未使用 / 外部通信なし / 他テーブル汚染なし');

await test('実 DB パス (business_data.db) が実行コード内で開かれない', async () => {
  const { readFileSync } = await import('node:fs');
  const { resolve, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const __dirname2 = dirname(fileURLToPath(import.meta.url));
  const content = readFileSync(resolve(__dirname2, '../data/kdp_manager.js'), 'utf8')
    + readFileSync(resolve(__dirname2, '../importers/kdp_report_importer.js'), 'utf8');
  // コメント内の言及は問題なし。DatabaseSync() に渡す文字列リテラルにないことを確認。
  assert.ok(!content.includes("DatabaseSync('business_data"), 'DatabaseSync で business_data.db を開いている');
  assert.ok(!content.includes('createDb('), 'createDb() が kdp ファイルで呼び出されている');
});

await test('外部 fetch / HTTP 通信が kdp_manager.js に存在しない', async () => {
  const { readFileSync } = await import('node:fs');
  const { resolve, dirname } = await import('node:path');
  const { fileURLToPath } = await import('node:url');
  const __dirname2 = dirname(fileURLToPath(import.meta.url));
  const content = readFileSync(resolve(__dirname2, '../data/kdp_manager.js'), 'utf8');
  assert.ok(!content.includes('fetch('), 'fetch() が kdp_manager.js に存在する');
  assert.ok(!content.includes('http.'), 'http. が kdp_manager.js に存在する');
});

await test('KDP 操作が sf_x_tweet / sf_instagram / sf_account_daily を汚染しない', () => {
  const d = createDb(':memory:');
  const book_id = writeKdpBook(d, { asin: 'B020TEST001', title: 'Isolation Test' });
  writeKdpOrderDaily(d, { date: '2026-07-01', book_id, marketplace: 'amazon.co.jp', paid_units: 5 });
  writeKdpRoyalty(d, { royalty_month: '2026-07', book_id, marketplace: 'amazon.co.jp', transaction_type: 'royalty', royalty_amount: 100, currency: 'JPY' });

  const tweets    = d.prepare('SELECT COUNT(*) AS c FROM sf_x_tweet').get().c;
  const igDaily   = d.prepare('SELECT COUNT(*) AS c FROM sf_instagram_account_daily').get().c;
  const accDaily  = d.prepare('SELECT COUNT(*) AS c FROM sf_account_daily').get().c;
  assert.equal(tweets,   0, 'sf_x_tweet が汚染されている');
  assert.equal(igDaily,  0, 'sf_instagram_account_daily が汚染されている');
  assert.equal(accDaily, 0, 'sf_account_daily が汚染されている');
  d.close?.();
});

await test('VALID_TRANSACTION_TYPES は 5 種類を含む', () => {
  assert.deepEqual(VALID_TRANSACTION_TYPES.sort(), ['free', 'ku_koll', 'other', 'refund', 'royalty']);
});

await test('VALID_FORMATS は 4 種類を含む', () => {
  assert.deepEqual(VALID_FORMATS.sort(), ['ebook', 'hardcover', 'other', 'paperback']);
});

await test('isValidAsin — 正常な ASIN を受理する', () => {
  assert.ok(isValidAsin('B001TEST001'));
  assert.ok(isValidAsin('b001test001')); // 大文字小文字不問
});

await test('isValidAsin — 不正な ASIN を拒否する', () => {
  assert.ok(!isValidAsin(''));              // 空文字
  assert.ok(!isValidAsin('ASIN-HYPHEN'));  // ハイフンを含む
  assert.ok(!isValidAsin('ASIN SPACE'));   // スペースを含む
  assert.ok(!isValidAsin(null));           // null
  assert.ok(!isValidAsin(12345));          // 数値
});

await test('isValidMonth — 正常な月を受理する', () => {
  assert.ok(isValidMonth('2026-07'));
  assert.ok(isValidMonth('2023-12'));
});

await test('isValidMonth — 不正な月を拒否する', () => {
  assert.ok(!isValidMonth('2026-13'));
  assert.ok(!isValidMonth('2026-7'));
  assert.ok(!isValidMonth('not-a-month'));
  assert.ok(!isValidMonth(null));
});

await test('isValidDate — 正常な日付を受理する', () => {
  assert.ok(isValidDate('2026-07-15'));
});

await test('isValidDate — 不正な日付を拒否する', () => {
  assert.ok(!isValidDate('2026-07'));
  assert.ok(!isValidDate('not-a-date'));
  assert.ok(!isValidDate(null));
});

// ══════════════════════════════════════════════════════════════════════════════
// 結果
// ══════════════════════════════════════════════════════════════════════════════

server.close();

console.log(`\n${'='.repeat(60)}`);
console.log(`KDP テスト結果: ${passed} passed / ${failed} failed`);
console.log('='.repeat(60));

if (failed > 0) process.exit(1);
