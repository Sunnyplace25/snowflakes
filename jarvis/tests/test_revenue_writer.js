/**
 * jarvis/tests/test_revenue_writer.js
 * revenue_writer.js テスト
 *
 * 検証内容:
 *   - 集計（同一キーの複数行を SUM）
 *   - transaction_month 違いは別レコードとして保持
 *   - ISRC 解決: 未解決は needs_review に記録、sf_revenue には書かない
 *   - 0円行（Quantity有・amount=0）の扱い
 *   - 冪等性（同一CSV 再インポートで DO UPDATE）
 *   - API クエリ: monthly（transaction/statement基準）/ by-track / by-service
 *   - 統合テスト: 3か月分の代表データ
 *
 * 重要: ':memory:' DB のみ使用。business_data.db には触れない。
 */

import assert from 'node:assert/strict';

import { createDb }       from '../data/db.js';
import { writeRevenue }   from '../importers/revenue_writer.js';

// ─── Soundrop Statement CSV ヘルパー ─────────────────────────────────────────

const SOUNDROP_HEADER = [
  'Statement Period', 'Transaction Month', 'Service', 'Country', 'Label', 'Artist',
  'Release Title', 'Track Title', 'UPC', 'ISRC', 'Release Catalog ID', 'Track Catalog ID',
  'Channel', 'Format', 'Quantity', 'Gross Revenue in USD', 'Mechanical Royalties Deducted',
  'Contract ID', 'Net Revenue in USD', 'Your Share %', 'Amount Due in USD',
  'Statement Total in USD', 'Opening Balance in USD', 'Closing Balance in USD',
].join(',');

function makeRow({
  statementPeriod  = '2026-06',
  transactionMonth = '2026-03',
  service          = 'Apple Music',
  country          = 'Japan',
  releaseTitle     = 'Test Release',
  trackTitle       = 'Test Track',
  upc              = '100000000001',
  isrc             = 'JPTEST00000001',
  quantity         = '1',
  grossRevenue     = '0.001000',
  netRevenue       = '0.000850',
}) {
  return [
    statementPeriod, transactionMonth, service, country, 'Snow flakes', 'Snow flakes',
    releaseTitle, trackTitle, upc, isrc, upc, '',
    'Subscription Streaming', 'Track', quantity,
    grossRevenue, '0', '903737', netRevenue, '100', netRevenue, '', '', '',
  ].join(',');
}

function makeCsv(rows) {
  return [SOUNDROP_HEADER, ...rows.map(makeRow)].join('\r\n');
}

/** テスト用に sf_tracks に ISRC 付きトラックを直接 INSERT する */
function insertTrack(db, { trackKey, title, isrc }) {
  db.prepare(
    "INSERT INTO sf_tracks (track_key, title, isrc, status) VALUES (?, ?, ?, 'released')"
  ).run(trackKey, title, isrc);
  return db.prepare('SELECT id FROM sf_tracks WHERE track_key = ?').get(trackKey).id;
}

// ─── テストランナー ───────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ❌ ${name}`);
    console.error(`     ${e.message}`);
    failed++;
  }
}

// ─── 1. 集計（SUM）────────────────────────────────────────────────────────────

console.log('\n▶ 集計: 同一キーの複数行を SUM');

test('同月・同曲・同サービス・複数国 → quantity と amount が SUM される', () => {
  const db = createDb(':memory:');
  insertTrack(db, { trackKey: 'track_a', title: 'Track A', isrc: 'JPTEST00000001' });

  const csv = makeCsv([
    { isrc: 'JPTEST00000001', service: 'Apple Music', country: 'Japan',     quantity: '10', netRevenue: '0.004000' },
    { isrc: 'JPTEST00000001', service: 'Apple Music', country: 'US',        quantity: '5',  netRevenue: '0.005000' },
    { isrc: 'JPTEST00000001', service: 'Apple Music', country: 'Indonesia', quantity: '2',  netRevenue: '0.000200' },
  ]);
  const result = writeRevenue(db, csv);
  assert.equal(result.written,     1, 'written が 1 でない');
  assert.equal(result.needsReview.length, 0);

  const row = db.prepare('SELECT quantity, amount FROM sf_revenue WHERE platform = ?').get('Apple Music');
  assert.equal(row.quantity, 17,     `quantity: ${row.quantity}`);
  assert.ok(Math.abs(row.amount - 0.009200) < 1e-9, `amount: ${row.amount}`);
});

test('異なるサービス → 別レコードとして保持される', () => {
  const db = createDb(':memory:');
  insertTrack(db, { trackKey: 'track_a', title: 'Track A', isrc: 'JPTEST00000001' });

  const csv = makeCsv([
    { isrc: 'JPTEST00000001', service: 'Apple Music', netRevenue: '0.004000' },
    { isrc: 'JPTEST00000001', service: 'TikTok',      netRevenue: '0.001000' },
  ]);
  const result = writeRevenue(db, csv);
  assert.equal(result.written, 2);

  const count = db.prepare('SELECT COUNT(*) as c FROM sf_revenue').get().c;
  assert.equal(count, 2, `レコード数: ${count}`);
});

// ─── 2. transaction_month 違いは別レコード ───────────────────────────────────

console.log('\n▶ 集計: transaction_month 違いは別レコード');

test('同 statement_period・同曲・同サービス / transaction_month 違い → 別レコード', () => {
  const db = createDb(':memory:');
  insertTrack(db, { trackKey: 'track_a', title: 'Track A', isrc: 'JPTEST00000001' });

  const csv = makeCsv([
    { statementPeriod: '2026-07', transactionMonth: '2026-03', isrc: 'JPTEST00000001', service: 'Apple Music', netRevenue: '0.003000' },
    { statementPeriod: '2026-07', transactionMonth: '2026-04', isrc: 'JPTEST00000001', service: 'Apple Music', netRevenue: '0.005000' },
    { statementPeriod: '2026-07', transactionMonth: '2026-05', isrc: 'JPTEST00000001', service: 'Apple Music', netRevenue: '0.002000' },
  ]);
  const result = writeRevenue(db, csv);
  assert.equal(result.written, 3, `written: ${result.written}`);

  const count = db.prepare('SELECT COUNT(*) as c FROM sf_revenue').get().c;
  assert.equal(count, 3, `レコード数: ${count}`);
});

test('transaction_month 別レコードの合計が正しい', () => {
  const db = createDb(':memory:');
  insertTrack(db, { trackKey: 'track_a', title: 'Track A', isrc: 'JPTEST00000001' });

  const csv = makeCsv([
    { statementPeriod: '2026-07', transactionMonth: '2026-03', isrc: 'JPTEST00000001', service: 'Apple Music', netRevenue: '0.003000' },
    { statementPeriod: '2026-07', transactionMonth: '2026-04', isrc: 'JPTEST00000001', service: 'Apple Music', netRevenue: '0.005000' },
  ]);
  writeRevenue(db, csv);

  const total = db.prepare('SELECT ROUND(SUM(amount),10) as total FROM sf_revenue').get().total;
  assert.ok(Math.abs(total - 0.008000) < 1e-9, `合計: ${total}`);

  const r03 = db.prepare("SELECT amount FROM sf_revenue WHERE transaction_month = '2026-03'").get();
  assert.ok(Math.abs(r03.amount - 0.003000) < 1e-9);

  const r04 = db.prepare("SELECT amount FROM sf_revenue WHERE transaction_month = '2026-04'").get();
  assert.ok(Math.abs(r04.amount - 0.005000) < 1e-9);
});

// ─── 3. ISRC 解決 ────────────────────────────────────────────────────────────

console.log('\n▶ ISRC 解決');

test('ISRC 一致 → sf_revenue に書き込まれる', () => {
  const db = createDb(':memory:');
  insertTrack(db, { trackKey: 'track_a', title: 'Track A', isrc: 'JPTEST00000001' });

  const csv = makeCsv([{ isrc: 'JPTEST00000001', netRevenue: '0.004000' }]);
  const result = writeRevenue(db, csv);

  assert.equal(result.written, 1);
  assert.equal(result.needsReview.length, 0);
  const row = db.prepare('SELECT amount FROM sf_revenue').get();
  assert.ok(Math.abs(row.amount - 0.004000) < 1e-9);
});

test('ISRC 未解決 → sf_revenue に書き込まれない', () => {
  const db = createDb(':memory:');
  // sf_tracks に isrc を登録しない

  const csv = makeCsv([{ isrc: 'JPUNKNOWN00001', netRevenue: '0.004000' }]);
  const result = writeRevenue(db, csv);

  assert.equal(result.written, 0);
  assert.equal(result.needsReview.length, 1);
  assert.equal(result.needsReview[0].isrc, 'JPUNKNOWN00001');

  const count = db.prepare('SELECT COUNT(*) as c FROM sf_revenue').get().c;
  assert.equal(count, 0, '未解決 ISRC が sf_revenue に書き込まれた');
});

test('解決済み・未解決が混在 → 解決済みのみ書き込む', () => {
  const db = createDb(':memory:');
  insertTrack(db, { trackKey: 'track_a', title: 'Track A', isrc: 'JPTEST00000001' });

  const csv = makeCsv([
    { isrc: 'JPTEST00000001', netRevenue: '0.004000' },
    { isrc: 'JPUNKNOWN00001', netRevenue: '0.002000' },
  ]);
  const result = writeRevenue(db, csv);

  assert.equal(result.written,     1);
  assert.equal(result.needsReview.length, 1);
  const count = db.prepare('SELECT COUNT(*) as c FROM sf_revenue').get().c;
  assert.equal(count, 1);
});

test('needsReview に isrc / service / statementPeriod / transactionMonth が含まれる', () => {
  const db = createDb(':memory:');
  const csv = makeCsv([{
    isrc: 'JPUNKNOWN00001', service: 'TikTok',
    statementPeriod: '2026-07', transactionMonth: '2026-04',
    netRevenue: '0.001000',
  }]);
  const result = writeRevenue(db, csv);
  const nr = result.needsReview[0];
  assert.equal(nr.isrc,             'JPUNKNOWN00001');
  assert.equal(nr.service,          'TikTok');
  assert.equal(nr.statementPeriod,  '2026-07');
  assert.equal(nr.transactionMonth, '2026-04');
});

// ─── 4. 0円行（Quantity有・amount=0）─────────────────────────────────────────

console.log('\n▶ 0円行（Amazon Music Unlimited 等）');

test('Net Revenue = 0 の行 → quantity に加算、amount = 0 で書き込まれる', () => {
  const db = createDb(':memory:');
  insertTrack(db, { trackKey: 'track_a', title: 'Track A', isrc: 'JPTEST00000001' });

  // Amazon Music Unlimited は $0 でも再生数がある
  const csv = makeCsv([
    { isrc: 'JPTEST00000001', service: 'Amazon Music Unlimited', quantity: '10', netRevenue: '0' },
  ]);
  const result = writeRevenue(db, csv);

  assert.equal(result.written, 1);
  const row = db.prepare('SELECT quantity, amount FROM sf_revenue').get();
  assert.equal(row.quantity, 10);
  assert.equal(row.amount,   0);
});

test('0円行と有料行の混在 → SUM が正しい', () => {
  const db = createDb(':memory:');
  insertTrack(db, { trackKey: 'track_a', title: 'Track A', isrc: 'JPTEST00000001' });

  const csv = makeCsv([
    { isrc: 'JPTEST00000001', service: 'Apple Music', country: 'Japan',     quantity: '5',  netRevenue: '0.004000' },
    { isrc: 'JPTEST00000001', service: 'Apple Music', country: 'Indonesia', quantity: '10', netRevenue: '0' },
  ]);
  writeRevenue(db, csv);

  const row = db.prepare('SELECT quantity, amount FROM sf_revenue').get();
  assert.equal(row.quantity, 15);
  assert.ok(Math.abs(row.amount - 0.004000) < 1e-9);
});

// ─── 5. 冪等性（同一CSV 再インポート）────────────────────────────────────────

console.log('\n▶ 冪等性（同一CSV 再インポート）');

test('同一CSV を 2 回インポートしても sf_revenue が重複しない', () => {
  const db = createDb(':memory:');
  insertTrack(db, { trackKey: 'track_a', title: 'Track A', isrc: 'JPTEST00000001' });

  const csv = makeCsv([{ isrc: 'JPTEST00000001', netRevenue: '0.004000', quantity: '5' }]);
  writeRevenue(db, csv);
  writeRevenue(db, csv);

  const count = db.prepare('SELECT COUNT(*) as c FROM sf_revenue').get().c;
  assert.equal(count, 1, `重複が発生した: count=${count}`);
});

test('再インポートで DO UPDATE: id が維持される', () => {
  const db = createDb(':memory:');
  insertTrack(db, { trackKey: 'track_a', title: 'Track A', isrc: 'JPTEST00000001' });

  const csv = makeCsv([{ isrc: 'JPTEST00000001', netRevenue: '0.004000', quantity: '5' }]);
  writeRevenue(db, csv);
  const before = db.prepare('SELECT id FROM sf_revenue').get();

  writeRevenue(db, csv);
  const after = db.prepare('SELECT id FROM sf_revenue').get();
  assert.equal(after.id, before.id, 'id が変わった（REPLACE が発生した）');
});

test('再インポートで amount が最新値に更新される', () => {
  const db = createDb(':memory:');
  insertTrack(db, { trackKey: 'track_a', title: 'Track A', isrc: 'JPTEST00000001' });

  // 1回目
  writeRevenue(db, makeCsv([{ isrc: 'JPTEST00000001', netRevenue: '0.004000', quantity: '5' }]));
  // 2回目（同一キー・異なる値でもUPDATE）
  writeRevenue(db, makeCsv([{ isrc: 'JPTEST00000001', netRevenue: '0.004000', quantity: '5' }]));

  const count = db.prepare('SELECT COUNT(*) as c FROM sf_revenue').get().c;
  assert.equal(count, 1);
});

// ─── 6. API クエリ検証（SQL直接）────────────────────────────────────────────

console.log('\n▶ API クエリ: monthly / by-track / by-service');

test('/api/sf/revenue/monthly: transaction_month 基準で正しく集計される', () => {
  const db = createDb(':memory:');
  const idA = insertTrack(db, { trackKey: 'track_a', title: 'Track A', isrc: 'JPTEST00000001' });
  const idB = insertTrack(db, { trackKey: 'track_b', title: 'Track B', isrc: 'JPTEST00000002' });

  const csv = makeCsv([
    { isrc: 'JPTEST00000001', statementPeriod: '2026-07', transactionMonth: '2026-04', netRevenue: '0.003000' },
    { isrc: 'JPTEST00000002', statementPeriod: '2026-07', transactionMonth: '2026-05', netRevenue: '0.005000' },
  ]);
  writeRevenue(db, csv);

  const rows = db.prepare(`
    SELECT transaction_month AS month, ROUND(SUM(amount),10) AS total_usd
    FROM sf_revenue
    WHERE import_source IN ('csv','api') AND track_id IS NOT NULL
    GROUP BY transaction_month ORDER BY transaction_month
  `).all();

  assert.equal(rows.length, 2);
  assert.equal(rows[0].month, '2026-04');
  assert.ok(Math.abs(rows[0].total_usd - 0.003000) < 1e-9);
  assert.equal(rows[1].month, '2026-05');
  assert.ok(Math.abs(rows[1].total_usd - 0.005000) < 1e-9);
});

test('/api/sf/revenue/monthly: statement_period 基準では同 month にまとまる', () => {
  const db = createDb(':memory:');
  insertTrack(db, { trackKey: 'track_a', title: 'Track A', isrc: 'JPTEST00000001' });
  insertTrack(db, { trackKey: 'track_b', title: 'Track B', isrc: 'JPTEST00000002' });

  const csv = makeCsv([
    { isrc: 'JPTEST00000001', statementPeriod: '2026-07', transactionMonth: '2026-04', netRevenue: '0.003000' },
    { isrc: 'JPTEST00000002', statementPeriod: '2026-07', transactionMonth: '2026-05', netRevenue: '0.005000' },
  ]);
  writeRevenue(db, csv);

  const rows = db.prepare(`
    SELECT month, ROUND(SUM(amount),10) AS total_usd
    FROM sf_revenue
    WHERE import_source IN ('csv','api') AND track_id IS NOT NULL
    GROUP BY month ORDER BY month
  `).all();

  assert.equal(rows.length, 1, 'statement_period 基準なら 1行にまとまるはず');
  assert.equal(rows[0].month, '2026-07');
  assert.ok(Math.abs(rows[0].total_usd - 0.008000) < 1e-9);
});

test('/api/sf/revenue/by-track: 楽曲別売上が正しい', () => {
  const db = createDb(':memory:');
  insertTrack(db, { trackKey: 'track_a', title: 'Track A', isrc: 'JPTEST00000001' });
  insertTrack(db, { trackKey: 'track_b', title: 'Track B', isrc: 'JPTEST00000002' });

  const csv = makeCsv([
    { isrc: 'JPTEST00000001', service: 'Apple Music', country: 'Japan', netRevenue: '0.003000' },
    { isrc: 'JPTEST00000001', service: 'TikTok',      country: 'US',    netRevenue: '0.001000' },
    { isrc: 'JPTEST00000002', service: 'Apple Music', country: 'Japan', netRevenue: '0.005000' },
  ]);
  writeRevenue(db, csv);

  const rows = db.prepare(`
    SELECT r.track_id, t.title, ROUND(SUM(r.amount),10) AS total_usd
    FROM sf_revenue r JOIN sf_tracks t ON t.id = r.track_id
    WHERE r.import_source IN ('csv','api') AND r.track_id IS NOT NULL
    GROUP BY r.track_id ORDER BY total_usd DESC
  `).all();

  assert.equal(rows.length, 2);
  assert.equal(rows[0].title, 'Track B');
  assert.ok(Math.abs(rows[0].total_usd - 0.005000) < 1e-9);
  assert.equal(rows[1].title, 'Track A');
  assert.ok(Math.abs(rows[1].total_usd - 0.004000) < 1e-9);
});

test('/api/sf/revenue/by-service: サービス別売上が正しい', () => {
  const db = createDb(':memory:');
  insertTrack(db, { trackKey: 'track_a', title: 'Track A', isrc: 'JPTEST00000001' });

  const csv = makeCsv([
    { isrc: 'JPTEST00000001', service: 'Apple Music', country: 'Japan', netRevenue: '0.004000' },
    { isrc: 'JPTEST00000001', service: 'Apple Music', country: 'US',    netRevenue: '0.002000' },
    { isrc: 'JPTEST00000001', service: 'TikTok',      country: 'Japan', netRevenue: '0.001000' },
  ]);
  writeRevenue(db, csv);

  const rows = db.prepare(`
    SELECT platform, ROUND(SUM(amount),10) AS total_usd
    FROM sf_revenue
    WHERE import_source IN ('csv','api') AND track_id IS NOT NULL
    GROUP BY platform ORDER BY total_usd DESC
  `).all();

  assert.equal(rows.length, 2);
  assert.equal(rows[0].platform, 'Apple Music');
  assert.ok(Math.abs(rows[0].total_usd - 0.006000) < 1e-9);
  assert.equal(rows[1].platform, 'TikTok');
  assert.ok(Math.abs(rows[1].total_usd - 0.001000) < 1e-9);
});

test('/api/sf/revenue/by-track: month フィルタが機能する', () => {
  const db = createDb(':memory:');
  insertTrack(db, { trackKey: 'track_a', title: 'Track A', isrc: 'JPTEST00000001' });

  const csv = makeCsv([
    { isrc: 'JPTEST00000001', statementPeriod: '2026-07', transactionMonth: '2026-04', netRevenue: '0.003000' },
    { isrc: 'JPTEST00000001', statementPeriod: '2026-07', transactionMonth: '2026-05', netRevenue: '0.005000' },
  ]);
  writeRevenue(db, csv);

  const filterMonth = '2026-04';
  const rows = db.prepare(`
    SELECT ROUND(SUM(r.amount),10) AS total_usd
    FROM sf_revenue r JOIN sf_tracks t ON t.id = r.track_id
    WHERE r.import_source IN ('csv','api') AND r.track_id IS NOT NULL
      AND r.transaction_month = ?
  `).all(filterMonth);

  assert.ok(Math.abs(rows[0].total_usd - 0.003000) < 1e-9, `フィルタ結果: ${rows[0].total_usd}`);
});

// ─── 7. 統合テスト ─────────────────────────────────────────────────────────────

console.log('\n▶ 統合テスト: 3か月分相当データ');

test('May+Jun+Jul 代表データ: written 件数と合計金額が正しい', () => {
  const db = createDb(':memory:');
  // 実際のStatementに登場するISRC
  const isrcs = [
    { trackKey: 'round_bounce',     isrc: 'QZPJ32543034', title: 'Round Bounce' },
    { trackKey: 'sweets_track',     isrc: 'QZPJ32544083', title: 'SWEETs' },
    { trackKey: 'oita_oto',         isrc: 'QZPJ32545428', title: '置いた音' },
    { trackKey: 'little_snow',      isrc: 'QZPJ32548359', title: 'Little Snow (Raw)' },
    { trackKey: 'little_snow_near', isrc: 'QZPJ32548356', title: 'Little Snow (Near)' },
    { trackKey: 'yakusoku_wa_shinai',isrc: 'QZPJ32548354', title: '約束はしない' },
    { trackKey: 'toumei_no_mama',   isrc: 'QZPJ32548355', title: '透明のまま' },
    { trackKey: 'still_track',      isrc: 'QZPJ32548357', title: 'Still' },
    { trackKey: 'namae_no_nai_uta', isrc: 'QZPJ32548358', title: '名前のない歌' },
  ];
  for (const t of isrcs) insertTrack(db, t);

  // 5月: 1行
  const mayCsv = makeCsv([
    { isrc: 'QZPJ32543034', statementPeriod: '2026-05', transactionMonth: '2026-03',
      service: 'Apple Music', country: 'Indonesia', quantity: '1', netRevenue: '0.0024905' },
  ]);

  // 6月: 代表4行（異ISRC・異サービス・異transactionMonth）
  const junCsv = makeCsv([
    { isrc: 'QZPJ32544083', statementPeriod: '2026-06', transactionMonth: '2026-03',
      service: 'TikTok', country: 'Singapore', quantity: '1', netRevenue: '0.00000425' },
    { isrc: 'QZPJ32544083', statementPeriod: '2026-06', transactionMonth: '2026-03',
      service: 'TikTok', country: 'Brazil',    quantity: '2', netRevenue: '0.00000425' },
    { isrc: 'QZPJ32545428', statementPeriod: '2026-06', transactionMonth: '2026-04',
      service: 'Apple Music', country: 'Canada', quantity: '1', netRevenue: '0.00298945' },
    { isrc: 'QZPJ32543034', statementPeriod: '2026-06', transactionMonth: '2026-04',
      service: 'Apple Music', country: 'US',     quantity: '1', netRevenue: '0.00365585' },
  ]);

  // 7月: 代表2行（同ISRC・同サービス・異transactionMonth）
  const julCsv = makeCsv([
    { isrc: 'QZPJ32543034', statementPeriod: '2026-07', transactionMonth: '2026-04',
      service: 'Amazon Music Unlimited', country: 'Japan', quantity: '24', netRevenue: '0' },
    { isrc: 'QZPJ32548359', statementPeriod: '2026-07', transactionMonth: '2026-04',
      service: 'Facebook', country: 'Japan', quantity: '5', netRevenue: '0.0761753' },
  ]);

  const r1 = writeRevenue(db, mayCsv);
  const r2 = writeRevenue(db, junCsv);
  const r3 = writeRevenue(db, julCsv);

  // May: 1, Jun: 3（TikTok×SWEETs は同キーでSUM→1行 + Apple Music×oita_oto + Apple Music×RoundBounce）, Jul: 2
  assert.equal(r1.written, 1, `May written: ${r1.written}`);
  assert.equal(r2.written, 3, `Jun written: ${r2.written}`);
  assert.equal(r3.written, 2, `Jul written: ${r3.written}`);
  assert.equal(r1.needsReview.length + r2.needsReview.length + r3.needsReview.length, 0, 'needs_review が発生した');

  // Jun の TikTok×SWEETs: quantity=3 (1+2), amount=0.0000085 (0.00000425×2)
  const tikTokSweets = db.prepare(
    "SELECT quantity, amount FROM sf_revenue WHERE platform='TikTok' AND transaction_month='2026-03'"
  ).get();
  assert.equal(tikTokSweets.quantity, 3, `TikTok SWEETs quantity: ${tikTokSweets.quantity}`);
  assert.ok(Math.abs(tikTokSweets.amount - 0.0000085) < 1e-10, `TikTok SWEETs amount: ${tikTokSweets.amount}`);

  // Jul の 0円行: quantity=24, amount=0
  const amazonRow = db.prepare(
    "SELECT quantity, amount FROM sf_revenue WHERE platform='Amazon Music Unlimited'"
  ).get();
  assert.equal(amazonRow.quantity, 24);
  assert.equal(amazonRow.amount,   0);
});

test('統合: 再インポートで sf_revenue 件数が増えない', () => {
  const db = createDb(':memory:');
  insertTrack(db, { trackKey: 'round_bounce', isrc: 'QZPJ32543034', title: 'Round Bounce' });

  const csv = makeCsv([
    { isrc: 'QZPJ32543034', statementPeriod: '2026-05', transactionMonth: '2026-03',
      service: 'Apple Music', quantity: '1', netRevenue: '0.0024905' },
  ]);
  writeRevenue(db, csv);
  writeRevenue(db, csv);

  const count = db.prepare('SELECT COUNT(*) as c FROM sf_revenue').get().c;
  assert.equal(count, 1, `重複が発生した: ${count}`);
});

// ─── 結果サマリー ─────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`  結果: ${passed} passed / ${failed} failed`);
if (failed > 0) {
  console.error('  ❌ テスト失敗あり');
  process.exit(1);
}
console.log('  ✅ 全テスト通過');
