/**
 * jarvis/tests/test_narou.js
 * なろう分析管理 テストスイート
 *
 * 重要:
 * - テストは ':memory:' の一時 SQLite DB のみ使用
 * - 実データ DB (business_data.db) には絶対に触れない
 * - テスト専用ポート（OS 任意割り当て）を使用する
 */

import assert from 'node:assert/strict';
import { createServer } from 'http';
import { createDb }        from '../data/db.js';
import { createApiHandler } from '../dashboard/api.js';
import { writeNarouSnapshot } from '../importers/narou_writer.js';

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

// ─── テスト用ヘルパー ─────────────────────────────────────────────────────────

/** sf_works にテスト用作品を追加し、id を返す */
function insertWork(db, { workKey = 'w-test', title = 'テスト作品', workType = 'novel' } = {}) {
  const stmt = db.prepare(
    `INSERT INTO sf_works (work_key, title, work_type) VALUES (?, ?, ?) RETURNING id`
  );
  return stmt.get(workKey, title, workType).id;
}

// ─── Section 1: narou_writer.js 検証 ─────────────────────────────────────────
console.log('\n▶ Section 1: narou_writer.js');

await test('1件書き込みで written=1, errors=[]', async () => {
  const result = writeNarouSnapshot(db, [
    { ncode: 'N0001AA', month: '2026-01', pvTotal: 1000, pvMonthly: 200, bookmarkCount: 50, point: 10 },
  ]);
  assert.equal(result.written, 1);
  assert.equal(result.errors.length, 0);
});

await test('同月同 ncode の UPSERT が冪等（2回書いても rows 数は1件）', async () => {
  const ncode = 'N0002BB';
  writeNarouSnapshot(db, [{ ncode, month: '2026-02', pvTotal: 500 }]);
  writeNarouSnapshot(db, [{ ncode, month: '2026-02', pvTotal: 600 }]);
  const row = db.prepare(
    `SELECT pv_total FROM sf_narou_snapshot WHERE ncode = ? AND month = ?`
  ).get(ncode, '2026-02');
  assert.ok(row, 'UPSERT 後に行が存在する');
  assert.equal(row.pv_total, 600, '2回目の値で上書きされる');
  const count = db.prepare(
    `SELECT COUNT(*) AS c FROM sf_narou_snapshot WHERE ncode = ? AND month = ?`
  ).get(ncode, '2026-02').c;
  assert.equal(count, 1, '重複行は作られない');
});

await test('UPSERT で NULL は既存値を上書きしない（COALESCE 動作）', async () => {
  const ncode = 'N0003CC';
  writeNarouSnapshot(db, [{ ncode, month: '2026-03', pvTotal: 999, bookmarkCount: 77 }]);
  writeNarouSnapshot(db, [{ ncode, month: '2026-03', pvMonthly: 100 }]); // pvTotal/bookmarkCount は渡さない
  const row = db.prepare(
    `SELECT pv_total, bookmark_count, pv_monthly FROM sf_narou_snapshot WHERE ncode = ? AND month = ?`
  ).get(ncode, '2026-03');
  assert.equal(row.pv_total, 999, '既存の pv_total が保持される');
  assert.equal(row.bookmark_count, 77, '既存の bookmark_count が保持される');
  assert.equal(row.pv_monthly, 100, '新しい pv_monthly が書き込まれる');
});

await test('複数 ncode の一括書き込み', async () => {
  const result = writeNarouSnapshot(db, [
    { ncode: 'N1001AA', month: '2026-04', pvTotal: 100 },
    { ncode: 'N1002BB', month: '2026-04', pvTotal: 200 },
    { ncode: 'N1003CC', month: '2026-04', pvTotal: 300 },
  ]);
  assert.equal(result.written, 3);
  assert.equal(result.errors.length, 0);
});

await test('ncode が未指定 → errors に追加、DB には書かない', async () => {
  const before = db.prepare(`SELECT COUNT(*) AS c FROM sf_narou_snapshot`).get().c;
  const result = writeNarouSnapshot(db, [
    { month: '2026-05', pvTotal: 100 },
  ]);
  const after = db.prepare(`SELECT COUNT(*) AS c FROM sf_narou_snapshot`).get().c;
  assert.equal(result.written, 0);
  assert.equal(result.errors.length, 1);
  assert.ok(result.errors[0].reason.includes('ncode'));
  assert.equal(before, after, 'DB 行数が増えていない');
});

await test('ncode が空文字 → errors に追加', async () => {
  const result = writeNarouSnapshot(db, [
    { ncode: '   ', month: '2026-05' },
  ]);
  assert.equal(result.errors.length, 1);
  assert.ok(result.errors[0].reason.includes('ncode'));
});

await test('month が不正フォーマット → errors に追加', async () => {
  const result = writeNarouSnapshot(db, [
    { ncode: 'N9999ZZ', month: '2026/05' },
  ]);
  assert.equal(result.written, 0);
  assert.equal(result.errors.length, 1);
  assert.ok(result.errors[0].reason.includes('month'));
});

await test('month が未指定 → errors に追加', async () => {
  const result = writeNarouSnapshot(db, [
    { ncode: 'N9999ZZ' },
  ]);
  assert.equal(result.errors.length, 1);
  assert.ok(result.errors[0].reason.includes('month'));
});

await test('一括書き込みで一部エラー・一部成功', async () => {
  const result = writeNarouSnapshot(db, [
    { ncode: 'N5001AA', month: '2026-06', pvTotal: 10 },   // 正常
    { ncode: '',        month: '2026-06' },                  // ncode エラー
    { ncode: 'N5002BB', month: '202606' },                   // month エラー
    { ncode: 'N5003CC', month: '2026-06', pvTotal: 30 },   // 正常
  ]);
  assert.equal(result.written, 2);
  assert.equal(result.errors.length, 2);
});

// ─── Section 2: API クエリ SQL 検証 ──────────────────────────────────────────
console.log('\n▶ Section 2: API クエリ SQL 検証（db.prepare 直接実行）');

// テスト用データを準備
const workId1 = insertWork(db, { workKey: 'novel-alpha', title: '作品アルファ', workType: 'novel' });
const workId2 = insertWork(db, { workKey: 'novel-beta',  title: '作品ベータ',  workType: 'novel' });

writeNarouSnapshot(db, [
  { ncode: 'NALPHA', month: '2025-12', pvTotal: 800,  pvMonthly: 80,  bookmarkCount: 40, point: 5,  workId: workId1 },
  { ncode: 'NALPHA', month: '2026-01', pvTotal: 1200, pvMonthly: 120, bookmarkCount: 60, point: 10, workId: workId1 },
  { ncode: 'NALPHA', month: '2026-02', pvTotal: 1500, pvMonthly: 150, bookmarkCount: 80, point: 15, workId: workId1 },
  { ncode: 'NBETA',  month: '2026-01', pvTotal: 500,  pvMonthly: 50,  bookmarkCount: 20, point: 3,  workId: workId2 },
  { ncode: 'NBETA',  month: '2026-02', pvTotal: 700,  pvMonthly: 70,  bookmarkCount: 30, point: 6,  workId: workId2 },
]);

await test('/api/sf/narou/summary SQL: 各 ncode の最新月だけ返す', async () => {
  const rows = db.prepare(`
    SELECT s.ncode, s.month, s.pv_total
    FROM sf_narou_snapshot s
    WHERE s.month = (SELECT MAX(s2.month) FROM sf_narou_snapshot s2 WHERE s2.ncode = s.ncode)
    AND s.ncode IN ('NALPHA', 'NBETA')
    ORDER BY s.ncode ASC
  `).all();
  assert.equal(rows.length, 2, 'ncode ごとに1件');
  const alpha = rows.find(r => r.ncode === 'NALPHA');
  const beta  = rows.find(r => r.ncode === 'NBETA');
  assert.equal(alpha.month, '2026-02');
  assert.equal(beta.month,  '2026-02');
  assert.equal(alpha.pv_total, 1500);
});

await test('/api/sf/narou/summary SQL: work_id フィルタで1作品のみ返す', async () => {
  const rows = db.prepare(`
    SELECT s.ncode
    FROM sf_narou_snapshot s
    WHERE s.month = (SELECT MAX(s2.month) FROM sf_narou_snapshot s2 WHERE s2.ncode = s.ncode)
    AND (? IS NULL OR s.work_id = ?)
    ORDER BY s.ncode ASC
  `).all(workId1, workId1);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].ncode, 'NALPHA');
});

await test('/api/sf/narou/monthly SQL: 全作品・月順', async () => {
  const rows = db.prepare(`
    SELECT month, ncode, pv_monthly
    FROM sf_narou_snapshot
    WHERE (? IS NULL OR ncode = ?)
    ORDER BY month ASC, ncode ASC
  `).all(null, null);
  assert.ok(rows.length >= 5, '全スナップショット件数');
  // 月順に並んでいることを確認
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i].month >= rows[i - 1].month, '月順');
  }
});

await test('/api/sf/narou/monthly SQL: ncode フィルタで1作品のみ', async () => {
  const rows = db.prepare(`
    SELECT month, ncode, pv_monthly
    FROM sf_narou_snapshot
    WHERE (? IS NULL OR ncode = ?)
    ORDER BY month ASC, ncode ASC
  `).all('NALPHA', 'NALPHA');
  assert.ok(rows.every(r => r.ncode === 'NALPHA'), 'NALPHA のみ');
  assert.equal(rows.length, 3, 'NALPHA は3ヶ月分');
});

await test('/api/sf/narou/compare SQL: pv_total で降順', async () => {
  const rows = db.prepare(`
    SELECT s.ncode, s.pv_total AS value, s.month
    FROM sf_narou_snapshot s
    WHERE s.month = (SELECT MAX(s2.month) FROM sf_narou_snapshot s2 WHERE s2.ncode = s.ncode)
    AND s.ncode IN ('NALPHA', 'NBETA')
    ORDER BY value DESC NULLS LAST, s.ncode ASC
  `).all();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].ncode, 'NALPHA', 'NALPHA の pv_total が多い');
  assert.ok(rows[0].value >= rows[1].value, '降順');
});

await test('/api/sf/narou/compare SQL: bookmark_count で降順', async () => {
  const rows = db.prepare(`
    SELECT s.ncode, s.bookmark_count AS value
    FROM sf_narou_snapshot s
    WHERE s.month = (SELECT MAX(s2.month) FROM sf_narou_snapshot s2 WHERE s2.ncode = s.ncode)
    ORDER BY value DESC NULLS LAST, s.ncode ASC
  `).all();
  assert.equal(rows[0].ncode, 'NALPHA');
});

// ─── Section 3: HTTP 統合テスト ───────────────────────────────────────────────
console.log('\n▶ Section 3: HTTP 統合テスト');

await test('GET /api/sf/narou/summary → 200 / ok:true / rows 配列', async () => {
  const { status, data } = await api('GET', '/api/sf/narou/summary');
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.ok(Array.isArray(data.rows));
  assert.ok(data.rows.length >= 2, '2作品分のデータ');
});

await test('GET /api/sf/narou/summary?work_id= でフィルタ', async () => {
  const { status, data } = await api('GET', `/api/sf/narou/summary?work_id=${workId1}`);
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.rows.length, 1);
  assert.equal(data.rows[0].ncode, 'NALPHA');
});

await test('GET /api/sf/narou/summary の rows に必須フィールドが含まれる', async () => {
  const { data } = await api('GET', '/api/sf/narou/summary');
  const row = data.rows.find(r => r.ncode === 'NALPHA');
  assert.ok(row, 'NALPHA が含まれる');
  assert.ok('ncode'          in row);
  assert.ok('month'          in row);
  assert.ok('pv_total'       in row);
  assert.ok('pv_monthly'     in row);
  assert.ok('bookmark_count' in row);
  assert.ok('review_count'   in row);
  assert.ok('point'          in row);
});

await test('GET /api/sf/narou/monthly → 200 / ok:true / rows 配列', async () => {
  const { status, data } = await api('GET', '/api/sf/narou/monthly');
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.ok(Array.isArray(data.rows));
  assert.ok(data.rows.length >= 5, '全スナップショット件数');
});

await test('GET /api/sf/narou/monthly?ncode=NALPHA → NALPHA のみ返す', async () => {
  const { status, data } = await api('GET', '/api/sf/narou/monthly?ncode=NALPHA');
  assert.equal(status, 200);
  assert.ok(data.rows.every(r => r.ncode === 'NALPHA'));
  assert.equal(data.rows.length, 3);
});

await test('GET /api/sf/narou/monthly の rows に month/ncode/pv_monthly/pv_total/bookmark_count/point が含まれる', async () => {
  const { data } = await api('GET', '/api/sf/narou/monthly?ncode=NALPHA');
  const row = data.rows[0];
  assert.ok('month'          in row);
  assert.ok('ncode'          in row);
  assert.ok('pv_monthly'     in row);
  assert.ok('pv_total'       in row);
  assert.ok('bookmark_count' in row);
  assert.ok('point'          in row);
});

await test('GET /api/sf/narou/compare → 200 / ok:true / metric:pv_total（デフォルト）', async () => {
  const { status, data } = await api('GET', '/api/sf/narou/compare');
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.metric, 'pv_total');
  assert.ok(Array.isArray(data.rows));
});

await test('GET /api/sf/narou/compare?metric=bookmark_count → metric フィールドが返る', async () => {
  const { status, data } = await api('GET', '/api/sf/narou/compare?metric=bookmark_count');
  assert.equal(status, 200);
  assert.equal(data.metric, 'bookmark_count');
  assert.ok(data.rows.length >= 1);
  assert.ok('value' in data.rows[0]);
});

await test('GET /api/sf/narou/compare?metric=INVALID → デフォルト pv_total にフォールバック', async () => {
  const { status, data } = await api('GET', '/api/sf/narou/compare?metric=INVALID');
  assert.equal(status, 200);
  assert.equal(data.metric, 'pv_total', '不正な metric は pv_total にフォールバック');
});

await test('GET /api/sf/narou/compare の rows に ncode/value/month が含まれる', async () => {
  const { data } = await api('GET', '/api/sf/narou/compare');
  const row = data.rows[0];
  assert.ok('ncode' in row);
  assert.ok('value' in row);
  assert.ok('month' in row);
});

// ─── 終了処理 ─────────────────────────────────────────────────────────────────
server.close();

console.log(`\n${'─'.repeat(50)}`);
console.log(`  passed: ${passed}  failed: ${failed}`);

if (failed > 0) process.exit(1);
