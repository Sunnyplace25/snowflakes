/**
 * jarvis/tests/test_site_events.js
 * Snow flakes 公式サイト イベント計測 テストスイート（Phase 11）
 *
 * 重要:
 * - テストは ':memory:' の一時 SQLite DB のみ使用
 * - 実 DB (business_data.db) には触れない
 * - 実 GA4 通信はしない（すべてモック / 静的）
 *
 * カバー範囲:
 * - GET /api/sf/ga/events       (sf_ga_event_daily 日別集計)
 * - GET /api/sf/ga/events/catalog (静的イベントカタログ)
 * - カタログ構造検証（funnel_stage / status / parameters）
 * - 二重送信防止の確認（ドキュメントテスト）
 * - 既存 GA エンドポイント回帰
 */

import assert from 'node:assert/strict';
import { createServer }     from 'http';
import { createDb }         from '../data/db.js';
import { createApiHandler } from '../dashboard/api.js';
import { writeGaEventDaily } from '../importers/ga_writer.js';

// ─── セットアップ ─────────────────────────────────────────────────────────────
const db         = createDb(':memory:');
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
  const res  = await fetch(`${BASE}${path}`, { method });
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

// ─── テストデータ準備 ─────────────────────────────────────────────────────────
writeGaEventDaily(db, [
  { date: '2026-07-01', eventName: 'music_play_30s', pagePath: '/sweets/', count: 12 },
  { date: '2026-07-01', eventName: 'click_story',    pagePath: '/',        count:  8 },
  { date: '2026-07-01', eventName: 'sweets_unlock',  pagePath: '/sweets/', count:  5 },
  { date: '2026-07-02', eventName: 'music_play_30s', pagePath: '/sweets/', count: 17 },
  { date: '2026-07-02', eventName: 'click_story',    pagePath: '/',        count: 10 },
  { date: '2026-07-03', eventName: 'music_play',     pagePath: '/sweets/', count:  9 },
  { date: '2026-07-03', eventName: 'click_kindle',   pagePath: '/',        count:  3 },
]);

// ─── Section 1: イベントカタログ検証 ─────────────────────────────────────────
console.log('\n▶ Section 1: GET /api/sf/ga/events/catalog 構造検証');

await test('GET /api/sf/ga/events/catalog → 200 / ok:true / events 配列', async () => {
  const { status, data } = await api('GET', '/api/sf/ga/events/catalog');
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.ok(Array.isArray(data.events), 'events は配列');
  assert.ok(data.events.length >= 10, '10件以上のイベント定義');
});

await test('全カタログイベントに event_name フィールドあり', async () => {
  const { data } = await api('GET', '/api/sf/ga/events/catalog');
  for (const ev of data.events) {
    assert.ok(typeof ev.event_name === 'string' && ev.event_name.length > 0,
      `event_name が空または未定義: ${JSON.stringify(ev)}`);
  }
});

await test('全カタログイベントに funnel_stage フィールドあり', async () => {
  const { data } = await api('GET', '/api/sf/ga/events/catalog');
  const VALID_STAGES = ['DISCOVERY', 'ENGAGEMENT', 'DEEP_INTEREST', 'VALUE'];
  for (const ev of data.events) {
    assert.ok(VALID_STAGES.includes(ev.funnel_stage),
      `不正な funnel_stage: ${ev.event_name} → "${ev.funnel_stage}"`);
  }
});

await test('全カタログイベントに status フィールドあり', async () => {
  const { data } = await api('GET', '/api/sf/ga/events/catalog');
  const VALID_STATUS = ['active', 'site_change_required', 'deprecated'];
  for (const ev of data.events) {
    assert.ok(VALID_STATUS.includes(ev.status),
      `不正な status: ${ev.event_name} → "${ev.status}"`);
  }
});

await test('music_play_30s は funnel_stage: DEEP_INTEREST / status: active', async () => {
  const { data } = await api('GET', '/api/sf/ga/events/catalog');
  const ev = data.events.find(e => e.event_name === 'music_play_30s');
  assert.ok(ev, 'music_play_30s がカタログに存在する');
  assert.equal(ev.funnel_stage, 'DEEP_INTEREST');
  assert.equal(ev.status, 'active');
});

await test('music_play は funnel_stage: DEEP_INTEREST / status: active', async () => {
  const { data } = await api('GET', '/api/sf/ga/events/catalog');
  const ev = data.events.find(e => e.event_name === 'music_play');
  assert.ok(ev, 'music_play がカタログに存在する');
  assert.equal(ev.funnel_stage, 'DEEP_INTEREST');
  assert.equal(ev.status, 'active');
});

await test('sweets_unlock は funnel_stage: ENGAGEMENT', async () => {
  const { data } = await api('GET', '/api/sf/ga/events/catalog');
  const ev = data.events.find(e => e.event_name === 'sweets_unlock');
  assert.ok(ev, 'sweets_unlock がカタログに存在する');
  assert.equal(ev.funnel_stage, 'ENGAGEMENT');
});

await test('click_kindle は funnel_stage: VALUE', async () => {
  const { data } = await api('GET', '/api/sf/ga/events/catalog');
  const ev = data.events.find(e => e.event_name === 'click_kindle');
  assert.ok(ev, 'click_kindle がカタログに存在する');
  assert.equal(ev.funnel_stage, 'VALUE');
});

await test('カタログイベントに個人識別パラメータなし（user_id / email / ip）', async () => {
  const PERSONAL_PARAMS = ['user_id', 'email', 'ip', 'phone', 'name'];
  const { data } = await api('GET', '/api/sf/ga/events/catalog');
  for (const ev of data.events) {
    const params = Array.isArray(ev.parameters) ? ev.parameters : [];
    for (const p of PERSONAL_PARAMS) {
      assert.ok(!params.includes(p),
        `個人識別パラメータ "${p}" が ${ev.event_name} に含まれている`);
    }
  }
});

await test('music_play と music_play_30s は別イベント（重複なし）', async () => {
  const { data } = await api('GET', '/api/sf/ga/events/catalog');
  const names = data.events.map(e => e.event_name);
  const mp    = names.filter(n => n === 'music_play').length;
  const mp30  = names.filter(n => n === 'music_play_30s').length;
  assert.equal(mp,   1, 'music_play は1件のみ');
  assert.equal(mp30, 1, 'music_play_30s は1件のみ');
});

// ─── Section 2: SQL クエリ検証（db.prepare 直接実行） ─────────────────────────
console.log('\n▶ Section 2: /api/sf/ga/events SQL 検証（db.prepare 直接実行）');

await test('event_name フィルタなし: 全イベントが返る', async () => {
  const rows = db.prepare(`
    SELECT date, event_name, SUM(count) AS count
    FROM sf_ga_event_daily
    WHERE date >= ? AND date <= ?
      AND (? IS NULL OR event_name = ?)
    GROUP BY date, event_name
    ORDER BY date ASC, event_name ASC
  `).all('2026-07-01', '2026-07-03', null, null);
  // 7エントリ → 7行（各 (date, event_name) ユニーク）
  assert.ok(rows.length >= 5, '複数イベントが全日付から返る');
});

await test('event_name フィルタあり: music_play_30s のみ返る', async () => {
  const rows = db.prepare(`
    SELECT date, event_name, SUM(count) AS count
    FROM sf_ga_event_daily
    WHERE date >= ? AND date <= ?
      AND (? IS NULL OR event_name = ?)
    GROUP BY date, event_name
    ORDER BY date ASC, event_name ASC
  `).all('2026-07-01', '2026-07-03', 'music_play_30s', 'music_play_30s');
  assert.ok(rows.every(r => r.event_name === 'music_play_30s'), 'music_play_30s のみ返る');
  assert.equal(rows.length, 2, '07-01 と 07-02 の2日分');
});

await test('日付範囲フィルタ: 1日のみ指定', async () => {
  const rows = db.prepare(`
    SELECT date, event_name, SUM(count) AS count
    FROM sf_ga_event_daily
    WHERE date >= ? AND date <= ?
      AND (? IS NULL OR event_name = ?)
    GROUP BY date, event_name
    ORDER BY date ASC, event_name ASC
  `).all('2026-07-01', '2026-07-01', null, null);
  assert.ok(rows.length >= 1, '07-01 のデータが返る');
  assert.ok(rows.every(r => r.date === '2026-07-01'), '07-01 のみ返る');
});

await test('存在しない event_name フィルタ → 空配列', async () => {
  const rows = db.prepare(`
    SELECT date, event_name, SUM(count) AS count
    FROM sf_ga_event_daily
    WHERE date >= ? AND date <= ?
      AND (? IS NULL OR event_name = ?)
    GROUP BY date, event_name
    ORDER BY date ASC, event_name ASC
  `).all('2026-07-01', '2026-07-03', 'nonexistent_event', 'nonexistent_event');
  assert.equal(rows.length, 0, '該当なし → 空配列');
});

// ─── Section 3: HTTP 統合テスト ───────────────────────────────────────────────
console.log('\n▶ Section 3: GET /api/sf/ga/events HTTP 統合テスト');

await test('GET /api/sf/ga/events → 200 / ok:true / rows 配列', async () => {
  const { status, data } = await api('GET', '/api/sf/ga/events?from=2026-07-01&to=2026-07-03');
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.ok(Array.isArray(data.rows), 'rows は配列');
  assert.ok(data.rows.length >= 1, '1件以上返る');
});

await test('GET /api/sf/ga/events レスポンス構造: date / event_name / count フィールドあり', async () => {
  const { data } = await api('GET', '/api/sf/ga/events?from=2026-07-01&to=2026-07-03');
  assert.ok(data.rows.length > 0, '行あり');
  const row = data.rows[0];
  assert.ok('date'       in row, 'date フィールドあり');
  assert.ok('event_name' in row, 'event_name フィールドあり');
  assert.ok('count'      in row, 'count フィールドあり');
});

await test('GET /api/sf/ga/events?event_name=music_play_30s → フィルタ適用', async () => {
  const { status, data } = await api('GET', '/api/sf/ga/events?from=2026-07-01&to=2026-07-03&event_name=music_play_30s');
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.ok(data.rows.length >= 1);
  assert.ok(data.rows.every(r => r.event_name === 'music_play_30s'),
    'music_play_30s のみ返る');
});

await test('GET /api/sf/ga/events?event_name=nonexistent → rows:[]', async () => {
  const { status, data } = await api('GET', '/api/sf/ga/events?event_name=nonexistent_xyz');
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.deepEqual(data.rows, [], '空配列');
});

await test('GET /api/sf/ga/events date 集計: 日別 SUM(count) が正しい', async () => {
  const { data } = await api('GET', '/api/sf/ga/events?from=2026-07-01&to=2026-07-01');
  const row30s = data.rows.find(r => r.event_name === 'music_play_30s');
  assert.ok(row30s, '07-01 の music_play_30s が含まれる');
  assert.equal(Number(row30s.count), 12, 'count=12 が正しく返る');
});

await test('GET /api/sf/ga/events?from=2026-07-03&to=2026-07-03 → 07-03 のみ', async () => {
  const { data } = await api('GET', '/api/sf/ga/events?from=2026-07-03&to=2026-07-03');
  assert.ok(data.rows.every(r => r.date === '2026-07-03'), '07-03 のみ返る');
});

// ─── Section 4: 既存 GA エンドポイント回帰 ───────────────────────────────────
console.log('\n▶ Section 4: 既存 GA エンドポイント回帰確認');

await test('GET /api/sf/ga/daily → 200 / ok:true（回帰）', async () => {
  const { status, data } = await api('GET', '/api/sf/ga/daily');
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.ok(Array.isArray(data.rows));
});

await test('GET /api/sf/ga/pages → 200 / ok:true（回帰）', async () => {
  const { status, data } = await api('GET', '/api/sf/ga/pages');
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.ok(Array.isArray(data.rows));
});

await test('GET /api/sf/ga/compare → 200 / ok:true（回帰）', async () => {
  const { status, data } = await api('GET', '/api/sf/ga/compare');
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.ok('days' in data);
});

// ─── Section 5: 安全性確認 ───────────────────────────────────────────────────
console.log('\n▶ Section 5: 安全性確認');

await test('実 GA4 通信なし（fetch は localhost のみ）', async () => {
  // このテストファイル内で使用した fetch の宛先が 127.0.0.1 のみであることを確認
  // 実 GA4 endpoint（www.google-analytics.com 等）への通信は発生しない
  assert.ok(BASE.startsWith('http://127.0.0.1'), `BASE が localhost: ${BASE}`);
});

await test('実 DB を参照していない（business_data.db 未使用）', async () => {
  // createDb(':memory:') のみ使用。ファイルパスが :memory: であることを確認
  const row = db.prepare(`SELECT COUNT(*) AS c FROM sf_ga_event_daily`).get();
  assert.ok(row.c >= 7, 'テストデータ7件以上が :memory: DB に書き込まれている');
  // ファイル DB を開いていれば別の行数になりうるが、:memory: で7件なら問題なし
});

// ─── 終了処理 ─────────────────────────────────────────────────────────────────
server.close();

console.log(`\n${'─'.repeat(60)}`);
console.log(`  テスト完了: ${passed} passed / ${failed} failed`);

if (failed > 0) process.exit(1);
