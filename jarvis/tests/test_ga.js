/**
 * jarvis/tests/test_ga.js
 * GA4 分析管理 テストスイート（Phase 4）
 *
 * 重要:
 * - テストは ':memory:' の一時 SQLite DB のみ使用
 * - 実データ DB (business_data.db) には絶対に触れない
 * - 実際の Property ID・イベント名・数値をハードコードしない
 */

import assert from 'node:assert/strict';
import { createServer } from 'http';
import { createDb }         from '../data/db.js';
import { createApiHandler } from '../dashboard/api.js';
import { writeGaDaily, writeGaEventDaily, writeGaSources } from '../importers/ga_writer.js';

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

// ─── 日付ヘルパー ─────────────────────────────────────────────────────────────
function addDays(dateStr, n) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + n);
  return d.toISOString().slice(0, 10);
}

const today = new Date().toISOString().slice(0, 10);

// ─── Section 1: ga_writer.js 検証 ────────────────────────────────────────────
console.log('\n▶ Section 1: ga_writer.js');

await test('writeGaDaily: 正常書き込みで written=1, errors=[]', async () => {
  const result = writeGaDaily(db, [
    { date: '2026-01-01', pagePath: '/', sessions: 10, users: 8, pageViews: 20, engagedSessions: 6 },
  ]);
  assert.equal(result.written, 1);
  assert.equal(result.errors.length, 0);
  const row = db.prepare(
    `SELECT page_views, users FROM sf_ga_daily WHERE date = ? AND page_path = ?`
  ).get('2026-01-01', '/');
  assert.ok(row, 'DB に行が存在する');
  assert.equal(row.page_views, 20);
  assert.equal(row.users, 8);
});

await test('writeGaDaily: 同日同ページの UPSERT 冪等性（2回書いても rows 数は1件）', async () => {
  writeGaDaily(db, [{ date: '2026-01-02', pagePath: '/music', sessions: 5, users: 4, pageViews: 10, engagedSessions: 3 }]);
  writeGaDaily(db, [{ date: '2026-01-02', pagePath: '/music', sessions: 7, users: 6, pageViews: 15, engagedSessions: 5 }]);
  const count = db.prepare(
    `SELECT COUNT(*) AS c FROM sf_ga_daily WHERE date = ? AND page_path = ?`
  ).get('2026-01-02', '/music').c;
  assert.equal(count, 1, '重複行は作られない');
  const row = db.prepare(
    `SELECT page_views FROM sf_ga_daily WHERE date = ? AND page_path = ?`
  ).get('2026-01-02', '/music');
  assert.equal(row.page_views, 15, '2回目の値で上書きされる');
});

await test('writeGaDaily: 複数行一括書き込み', async () => {
  const result = writeGaDaily(db, [
    { date: '2026-01-03', pagePath: '/',       pageViews: 30 },
    { date: '2026-01-03', pagePath: '/sweets', pageViews: 15 },
    { date: '2026-01-03', pagePath: '/room',   pageViews:  8 },
  ]);
  assert.equal(result.written, 3);
  assert.equal(result.errors.length, 0);
});

await test('writeGaDaily: date 不正 → errors 配列に追加、DB には書かない', async () => {
  const before = db.prepare(`SELECT COUNT(*) AS c FROM sf_ga_daily`).get().c;
  const result = writeGaDaily(db, [
    { date: '20260104', pagePath: '/', pageViews: 5 },
  ]);
  const after = db.prepare(`SELECT COUNT(*) AS c FROM sf_ga_daily`).get().c;
  assert.equal(result.written, 0);
  assert.equal(result.errors.length, 1);
  assert.ok(result.errors[0].reason.includes('date'));
  assert.equal(before, after, 'DB 行数が増えていない');
});

await test('writeGaDaily: pagePath 空文字 → errors 配列に追加', async () => {
  const result = writeGaDaily(db, [
    { date: '2026-01-05', pagePath: '   ', pageViews: 5 },
  ]);
  assert.equal(result.written, 0);
  assert.equal(result.errors.length, 1);
  assert.ok(result.errors[0].reason.includes('pagePath'));
});

await test('writeGaDaily: NULL値は COALESCE で既存値を保持', async () => {
  // 初回: 全フィールドを書き込む
  writeGaDaily(db, [{ date: '2026-01-06', pagePath: '/', sessions: 20, users: 15, pageViews: 40, engagedSessions: 12 }]);
  // 2回目: pageViews のみ更新、sessions/users/engagedSessions は null
  writeGaDaily(db, [{ date: '2026-01-06', pagePath: '/', pageViews: 50 }]);
  const row = db.prepare(
    `SELECT sessions, users, page_views, engaged_sessions FROM sf_ga_daily WHERE date = ? AND page_path = ?`
  ).get('2026-01-06', '/');
  assert.equal(row.sessions, 20, '既存の sessions が保持される');
  assert.equal(row.users, 15, '既存の users が保持される');
  assert.equal(row.page_views, 50, 'pageViews は新しい値に更新される');
  assert.equal(row.engaged_sessions, 12, '既存の engaged_sessions が保持される');
});

await test('writeGaEventDaily: 正常書き込みで written=1, errors=[]', async () => {
  const result = writeGaEventDaily(db, [
    { date: '2026-02-01', eventName: 'click_kindle', pagePath: '/', count: 5 },
  ]);
  assert.equal(result.written, 1);
  assert.equal(result.errors.length, 0);
  const row = db.prepare(
    `SELECT count FROM sf_ga_event_daily WHERE date = ? AND event_name = ? AND page_path = ?`
  ).get('2026-02-01', 'click_kindle', '/');
  assert.ok(row, 'DB に行が存在する');
  assert.equal(row.count, 5);
});

await test('writeGaEventDaily: UPSERT 冪等性（2回書いても rows 数は1件・count が更新される）', async () => {
  writeGaEventDaily(db, [{ date: '2026-02-02', eventName: 'click_spotify', pagePath: '/', count: 10 }]);
  writeGaEventDaily(db, [{ date: '2026-02-02', eventName: 'click_spotify', pagePath: '/', count: 20 }]);
  const count = db.prepare(
    `SELECT COUNT(*) AS c FROM sf_ga_event_daily WHERE date = ? AND event_name = ? AND page_path = ?`
  ).get('2026-02-02', 'click_spotify', '/').c;
  assert.equal(count, 1, '重複行は作られない');
  const row = db.prepare(
    `SELECT count FROM sf_ga_event_daily WHERE date = ? AND event_name = ? AND page_path = ?`
  ).get('2026-02-02', 'click_spotify', '/');
  assert.equal(row.count, 20, '2回目の count に更新される');
});

// ─── Section 2: API クエリ SQL 検証 ──────────────────────────────────────────
console.log('\n▶ Section 2: API クエリ SQL 検証（db.prepare 直接実行）');

// テスト用データを準備（固定日付）
writeGaDaily(db, [
  { date: '2026-03-01', pagePath: '/',       sessions: 100, users: 80, pageViews: 200, engagedSessions: 60 },
  { date: '2026-03-01', pagePath: '/sweets', sessions:  20, users: 15, pageViews:  40, engagedSessions: 12 },
  { date: '2026-03-02', pagePath: '/',       sessions: 120, users: 90, pageViews: 250, engagedSessions: 70 },
  { date: '2026-03-02', pagePath: '/sweets', sessions:  25, users: 20, pageViews:  50, engagedSessions: 15 },
  { date: '2026-03-03', pagePath: '/',       sessions:  90, users: 70, pageViews: 180, engagedSessions: 55 },
]);

await test('/api/sf/ga/daily の集計 SQL: 日別 SUM が正しい', async () => {
  const rows = db.prepare(`
    SELECT date,
           SUM(page_views)       AS page_views,
           SUM(users)            AS users,
           SUM(sessions)         AS sessions,
           SUM(engaged_sessions) AS engaged_sessions
    FROM sf_ga_daily
    WHERE date >= ? AND date <= ?
      AND (? IS NULL OR page_path = ?)
    GROUP BY date
    ORDER BY date ASC
  `).all('2026-03-01', '2026-03-03', null, null);
  assert.equal(rows.length, 3, '3日分');
  const day1 = rows.find(r => r.date === '2026-03-01');
  assert.ok(day1, '2026-03-01 が含まれる');
  assert.equal(day1.page_views, 240, '2ページ合計 200+40');
  assert.equal(day1.users, 95, '80+15');
});

await test('/api/sf/ga/pages の集計・並び順 SQL: page_views 降順', async () => {
  const rows = db.prepare(`
    SELECT page_path,
           SUM(page_views) AS page_views,
           SUM(users)      AS users,
           SUM(sessions)   AS sessions
    FROM sf_ga_daily
    WHERE date >= ? AND date <= ?
    GROUP BY page_path
    ORDER BY page_views DESC, page_path ASC
  `).all('2026-03-01', '2026-03-03');
  assert.ok(rows.length >= 2, '2ページ以上');
  assert.equal(rows[0].page_path, '/', 'page_views の多い / が先頭');
  assert.ok(rows[0].page_views >= rows[1].page_views, '降順になっている');
});

await test('/api/sf/ga/compare の current/previous 分割 SQL', async () => {
  // current: 2026-03-02 to 2026-03-03, previous: 2026-02-28 to 2026-03-01
  const currentStart  = '2026-03-02';
  const currentEnd    = '2026-03-03';
  const previousStart = '2026-02-28';
  const previousEnd   = '2026-03-01';

  const rows = db.prepare(`
    SELECT page_path,
           SUM(CASE WHEN date >= ? AND date <= ? THEN page_views ELSE 0 END) AS current_views,
           SUM(CASE WHEN date >= ? AND date <= ? THEN page_views ELSE 0 END) AS previous_views
    FROM sf_ga_daily
    WHERE date >= ? AND date <= ?
    GROUP BY page_path
    ORDER BY current_views DESC, page_path ASC
  `).all(currentStart, currentEnd, previousStart, previousEnd, previousStart, currentEnd);

  const root = rows.find(r => r.page_path === '/');
  assert.ok(root, '/ が含まれる');
  // current: 250+180=430, previous: 200
  assert.equal(root.current_views, 430, 'current_views が正しい');
  assert.equal(root.previous_views, 200, 'previous_views が正しい');
});

// ─── Section 3: HTTP 統合テスト ───────────────────────────────────────────────
console.log('\n▶ Section 3: HTTP 統合テスト');

await test('GET /api/sf/ga/daily → 200 / ok:true / rows 配列', async () => {
  const { status, data } = await api('GET', `/api/sf/ga/daily?from=2026-03-01&to=2026-03-03`);
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.ok(Array.isArray(data.rows));
  assert.ok(data.rows.length >= 3, '3日分');
  assert.ok('date'             in data.rows[0]);
  assert.ok('page_views'       in data.rows[0]);
  assert.ok('users'            in data.rows[0]);
  assert.ok('sessions'         in data.rows[0]);
  assert.ok('engaged_sessions' in data.rows[0]);
});

await test('GET /api/sf/ga/daily?page_path= フィルタで1ページのみ返す', async () => {
  const { status, data } = await api('GET', `/api/sf/ga/daily?from=2026-03-01&to=2026-03-03&page_path=%2Fsweets`);
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.ok(Array.isArray(data.rows));
  // /sweets のデータは2日分（03-01, 03-02）
  assert.ok(data.rows.length >= 1);
  // 集計値が /sweets 分のみになっているか（各日の page_views は /sweets のみ）
  for (const row of data.rows) {
    assert.ok(row.page_views <= 60, '/sweets のページビューは 50 以下のはず');
  }
});

await test('GET /api/sf/ga/pages → 200 / ok:true / page_views 降順', async () => {
  const { status, data } = await api('GET', `/api/sf/ga/pages?from=2026-03-01&to=2026-03-03`);
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.ok(Array.isArray(data.rows));
  assert.ok(data.rows.length >= 2);
  assert.ok('page_path'  in data.rows[0]);
  assert.ok('page_views' in data.rows[0]);
  assert.ok('users'      in data.rows[0]);
  assert.ok('sessions'   in data.rows[0]);
  // page_views 降順
  for (let i = 1; i < data.rows.length; i++) {
    assert.ok(data.rows[i - 1].page_views >= data.rows[i].page_views, '降順');
  }
});

await test('GET /api/sf/ga/compare → 200 / ok:true / days フィールド（デフォルト30）', async () => {
  const { status, data } = await api('GET', '/api/sf/ga/compare');
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.days, 30);
  assert.ok(Array.isArray(data.rows));
  if (data.rows.length > 0) {
    assert.ok('page_path'      in data.rows[0]);
    assert.ok('current_views'  in data.rows[0]);
    assert.ok('previous_views' in data.rows[0]);
  }
});

await test('GET /api/sf/ga/compare?days=7 → days:7', async () => {
  const { status, data } = await api('GET', '/api/sf/ga/compare?days=7');
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.days, 7);
});

await test('GET /api/sf/ga/compare?days=999 → デフォルト30にフォールバック', async () => {
  const { status, data } = await api('GET', '/api/sf/ga/compare?days=999');
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.days, 30, '不正な days は 30 にフォールバック');
});

// ─── Section 4: writeGaSources / /api/sf/ga/sources テスト ──────────────────
console.log('\n▶ Section 4: writeGaSources / /api/sf/ga/sources');

await test('writeGaSources: 正常書き込みで written=1, errors=[]', async () => {
  const result = writeGaSources(db, [
    { date: '2026-05-01', sessionSource: 'google', sessionMedium: 'organic',
      sessions: 50, users: 40, pageViews: 100, engagedSessions: 30 },
  ]);
  assert.equal(result.written, 1);
  assert.equal(result.errors.length, 0);
  const row = db.prepare(
    `SELECT sessions, page_views FROM sf_ga_sources WHERE date = ? AND session_source = ? AND session_medium = ?`
  ).get('2026-05-01', 'google', 'organic');
  assert.ok(row, 'DB に行が存在する');
  assert.equal(row.sessions, 50);
  assert.equal(row.page_views, 100);
});

await test('writeGaSources: UPSERT 冪等性（2回書いても rows 数は1件・値が更新される）', async () => {
  writeGaSources(db, [{ date: '2026-05-02', sessionSource: '(direct)', sessionMedium: '(none)', sessions: 10, users: 8, pageViews: 20 }]);
  writeGaSources(db, [{ date: '2026-05-02', sessionSource: '(direct)', sessionMedium: '(none)', sessions: 15, users: 12, pageViews: 30 }]);
  const count = db.prepare(
    `SELECT COUNT(*) AS c FROM sf_ga_sources WHERE date = ? AND session_source = ? AND session_medium = ?`
  ).get('2026-05-02', '(direct)', '(none)').c;
  assert.equal(count, 1, '重複行は作られない');
  const row = db.prepare(
    `SELECT sessions FROM sf_ga_sources WHERE date = ? AND session_source = ? AND session_medium = ?`
  ).get('2026-05-02', '(direct)', '(none)');
  assert.equal(row.sessions, 15, '2回目の値で更新される');
});

await test('writeGaSources: 複数行（source × medium の組み合わせ）一括書き込み', async () => {
  const result = writeGaSources(db, [
    { date: '2026-05-03', sessionSource: 'google',        sessionMedium: 'organic',  sessions: 30, users: 25, pageViews: 60 },
    { date: '2026-05-03', sessionSource: 'instagram.com', sessionMedium: 'referral', sessions: 12, users: 10, pageViews: 25 },
    { date: '2026-05-03', sessionSource: '(direct)',      sessionMedium: '(none)',   sessions:  8, users:  7, pageViews: 15 },
  ]);
  assert.equal(result.written, 3);
  assert.equal(result.errors.length, 0);
});

await test('writeGaSources: date 不正 → errors 配列に追加、DB には書かない', async () => {
  const before = db.prepare(`SELECT COUNT(*) AS c FROM sf_ga_sources`).get().c;
  const result = writeGaSources(db, [
    { date: '20260504', sessionSource: 'google', sessionMedium: 'organic', sessions: 5 },
  ]);
  const after = db.prepare(`SELECT COUNT(*) AS c FROM sf_ga_sources`).get().c;
  assert.equal(result.written, 0);
  assert.equal(result.errors.length, 1);
  assert.ok(result.errors[0].reason.includes('date'));
  assert.equal(before, after, 'DB 行数が増えていない');
});

await test('writeGaSources: sessionSource 空文字 → errors 配列に追加', async () => {
  const result = writeGaSources(db, [
    { date: '2026-05-05', sessionSource: '  ', sessionMedium: 'organic', sessions: 5 },
  ]);
  assert.equal(result.written, 0);
  assert.equal(result.errors.length, 1);
  assert.ok(result.errors[0].reason.includes('sessionSource'));
});

await test('writeGaSources: sessionMedium 空文字 → errors 配列に追加', async () => {
  const result = writeGaSources(db, [
    { date: '2026-05-05', sessionSource: 'google', sessionMedium: '', sessions: 5 },
  ]);
  assert.equal(result.written, 0);
  assert.equal(result.errors.length, 1);
  assert.ok(result.errors[0].reason.includes('sessionMedium'));
});

await test('writeGaSources: NULL 値は COALESCE で既存値を保持', async () => {
  writeGaSources(db, [{ date: '2026-05-06', sessionSource: 'google', sessionMedium: 'cpc', sessions: 20, users: 15, pageViews: 40, engagedSessions: 12 }]);
  writeGaSources(db, [{ date: '2026-05-06', sessionSource: 'google', sessionMedium: 'cpc', pageViews: 50 }]);
  const row = db.prepare(
    `SELECT sessions, users, page_views, engaged_sessions FROM sf_ga_sources WHERE date = ? AND session_source = ? AND session_medium = ?`
  ).get('2026-05-06', 'google', 'cpc');
  assert.equal(row.sessions, 20, '既存の sessions が保持される');
  assert.equal(row.users, 15, '既存の users が保持される');
  assert.equal(row.page_views, 50, 'pageViews は新しい値に更新される');
  assert.equal(row.engaged_sessions, 12, '既存の engaged_sessions が保持される');
});

await test('GET /api/sf/ga/sources → 200 / ok:true / rows 配列', async () => {
  const { status, data } = await api('GET', '/api/sf/ga/sources?from=2026-05-01&to=2026-05-06');
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.ok(Array.isArray(data.rows), 'rows は配列');
  assert.ok(data.rows.length >= 1, '1件以上のデータがある');
  assert.ok('session_source'   in data.rows[0], 'session_source が含まれる');
  assert.ok('session_medium'   in data.rows[0], 'session_medium が含まれる');
  assert.ok('sessions'         in data.rows[0], 'sessions が含まれる');
  assert.ok('users'            in data.rows[0], 'users が含まれる');
  assert.ok('page_views'       in data.rows[0], 'page_views が含まれる');
  assert.ok('engaged_sessions' in data.rows[0], 'engaged_sessions が含まれる');
});

await test('GET /api/sf/ga/sources → sessions 降順', async () => {
  const { data } = await api('GET', '/api/sf/ga/sources?from=2026-05-01&to=2026-05-06');
  for (let i = 1; i < data.rows.length; i++) {
    assert.ok(data.rows[i - 1].sessions >= data.rows[i].sessions, 'sessions 降順');
  }
});

await test('GET /api/sf/ga/sources → from/to が返却される', async () => {
  const { data } = await api('GET', '/api/sf/ga/sources?from=2026-05-01&to=2026-05-06');
  assert.equal(data.from, '2026-05-01');
  assert.equal(data.to,   '2026-05-06');
});

await test('GET /api/sf/ga/sources → from/to 省略時はデフォルト30日（200が返る）', async () => {
  const { status, data } = await api('GET', '/api/sf/ga/sources');
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.ok(Array.isArray(data.rows));
});

// ─── 終了処理 ─────────────────────────────────────────────────────────────────
server.close();

console.log(`\n${'─'.repeat(50)}`);
console.log(`  passed: ${passed}  failed: ${failed}`);

if (failed > 0) process.exit(1);
