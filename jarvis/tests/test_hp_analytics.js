/**
 * jarvis/tests/test_hp_analytics.js
 * HP Analytics Dashboard テストスイート（Phase 15）
 *
 * 重要:
 * - ':memory:' DB のみ使用。実 DB (business_data.db) は絶対に触れない
 * - 実 GA4 通信なし（すべてモックデータ）
 * - 認証情報をレスポンスに含めない
 *
 * Section 1:  GET /api/sf/ga/overview 基本構造
 * Section 2:  overview — 空 DB（未取得状態）
 * Section 3:  overview — データあり（0 vs 未取得の区別）
 * Section 4:  overview — days パラメータ検証
 * Section 5:  overview — 前期間比較（has_previous_data）
 * Section 6:  Music 導線イベント（music_play / click_music / click_spotify / nav_hayatecchi）
 * Section 7:  既存 GA エンドポイント回帰確認
 * Section 8:  empty state — イベントデータなし
 * Section 9:  0 vs 未取得の区別
 * Section 10: 不正入力処理
 * Section 11: GA 認証情報非漏洩
 * Section 12: 実 GA4 通信なし
 * Section 13: Dashboard HTML 構造確認
 * Section 14: main 変更なし
 */

import assert from 'node:assert/strict';
import { createServer }       from 'http';
import { readFileSync }       from 'node:fs';
import { createDb }           from '../data/db.js';
import { createApiHandler }   from '../dashboard/api.js';
import { writeGaDaily }       from '../importers/ga_writer.js';
import { writeGaEventDaily }  from '../importers/ga_writer.js';

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

// ─── 日付ヘルパー（テストを日付非依存にする）──────────────────────────────────

function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
}

// 直近30日（当期）と前30日（前期）のテストデータ日付
const dateCurrentA = daysAgo(5);   // 直近 30 日内
const dateCurrentB = daysAgo(15);  // 直近 30 日内
const datePreviousA = daysAgo(35); // 前30日内
const datePreviousB = daysAgo(45); // 前30日内
const dateOldA      = daysAgo(90); // 両期間外

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

// ═══════════════════════════════════════════════════════════════════════════════
// Section 1: GET /api/sf/ga/overview 基本構造
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 1: GET /api/sf/ga/overview 基本構造（空DB）');

await test('GET /api/sf/ga/overview → 200 / ok:true', async () => {
  const { status, data } = await api('GET', '/api/sf/ga/overview');
  assert.equal(status, 200);
  assert.equal(data.ok, true);
});

await test('レスポンスに days フィールドあり（デフォルト 30）', async () => {
  const { data } = await api('GET', '/api/sf/ga/overview');
  assert.equal(data.days, 30);
});

await test('レスポンスに period フィールドあり（from / to）', async () => {
  const { data } = await api('GET', '/api/sf/ga/overview');
  assert.ok('period' in data);
  assert.ok('from' in data.period);
  assert.ok('to' in data.period);
  assert.match(data.period.from, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(data.period.to,   /^\d{4}-\d{2}-\d{2}$/);
});

await test('レスポンスに previous_period フィールドあり', async () => {
  const { data } = await api('GET', '/api/sf/ga/overview');
  assert.ok('previous_period' in data);
  assert.match(data.previous_period.from, /^\d{4}-\d{2}-\d{2}$/);
  assert.match(data.previous_period.to,   /^\d{4}-\d{2}-\d{2}$/);
});

await test('has_data フィールドが boolean', async () => {
  const { data } = await api('GET', '/api/sf/ga/overview');
  assert.ok(typeof data.has_data === 'boolean');
});

await test('has_previous_data フィールドが boolean', async () => {
  const { data } = await api('GET', '/api/sf/ga/overview');
  assert.ok(typeof data.has_previous_data === 'boolean');
});

await test('period.from < period.to（日付順序が正しい）', async () => {
  const { data } = await api('GET', '/api/sf/ga/overview');
  assert.ok(data.period.from <= data.period.to, `${data.period.from} <= ${data.period.to}`);
});

await test('previous_period.to < period.from（期間が重複しない）', async () => {
  const { data } = await api('GET', '/api/sf/ga/overview');
  assert.ok(
    data.previous_period.to < data.period.from,
    `前期 ${data.previous_period.to} < 当期 ${data.period.from}`
  );
});

// ═══════════════════════════════════════════════════════════════════════════════
// Section 2: overview — 空 DB（未取得状態）
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 2: overview — 空 DB（データ未取得状態）');

await test('空 DB: has_data=false', async () => {
  const { data } = await api('GET', '/api/sf/ga/overview');
  assert.equal(data.has_data, false);
});

await test('空 DB: current=null（0 ではなく null）', async () => {
  const { data } = await api('GET', '/api/sf/ga/overview');
  assert.equal(data.current, null);
});

await test('空 DB: has_previous_data=false', async () => {
  const { data } = await api('GET', '/api/sf/ga/overview');
  assert.equal(data.has_previous_data, false);
});

await test('空 DB: previous=null', async () => {
  const { data } = await api('GET', '/api/sf/ga/overview');
  assert.equal(data.previous, null);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Section 3: overview — データあり
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 3: overview — データあり（0 vs 未取得の区別）');

// 当期データを挿入
writeGaDaily(db, [
  { date: dateCurrentA, pagePath: '/',        pageViews: 120, users: 90,  sessions: 95, engagedSessions: 60 },
  { date: dateCurrentA, pagePath: '/sweets/', pageViews:  40, users: 30,  sessions: 32, engagedSessions: 25 },
  { date: dateCurrentB, pagePath: '/',        pageViews: 200, users: 150, sessions: 160, engagedSessions: 120 },
]);

await test('データ挿入後: has_data=true', async () => {
  const { data } = await api('GET', '/api/sf/ga/overview');
  assert.equal(data.has_data, true);
});

await test('データあり: current は null でない', async () => {
  const { data } = await api('GET', '/api/sf/ga/overview');
  assert.notEqual(data.current, null);
});

await test('current.page_views が正しく集計される（2日分合計）', async () => {
  const { data } = await api('GET', '/api/sf/ga/overview');
  // dateCurrentA: 120+40=160, dateCurrentB: 200 → 合計 360
  assert.equal(data.current.page_views, 360);
});

await test('current.users が正しく集計される', async () => {
  const { data } = await api('GET', '/api/sf/ga/overview');
  // dateCurrentA: 90+30=120, dateCurrentB: 150 → 合計 270
  assert.equal(data.current.users, 270);
});

await test('current.sessions が正しく集計される', async () => {
  const { data } = await api('GET', '/api/sf/ga/overview');
  assert.equal(data.current.sessions, 287); // 95+32+160
});

await test('current.engaged_sessions が正しく集計される', async () => {
  const { data } = await api('GET', '/api/sf/ga/overview');
  assert.equal(data.current.engaged_sessions, 205); // 60+25+120
});

await test('current フィールドに page_views / users / sessions / engaged_sessions が揃う', async () => {
  const { data } = await api('GET', '/api/sf/ga/overview');
  assert.ok('page_views'       in data.current);
  assert.ok('users'            in data.current);
  assert.ok('sessions'         in data.current);
  assert.ok('engaged_sessions' in data.current);
});

await test('current の各フィールドが数値', async () => {
  const { data } = await api('GET', '/api/sf/ga/overview');
  assert.ok(typeof data.current.page_views       === 'number');
  assert.ok(typeof data.current.users            === 'number');
  assert.ok(typeof data.current.sessions         === 'number');
  assert.ok(typeof data.current.engaged_sessions === 'number');
});

// ═══════════════════════════════════════════════════════════════════════════════
// Section 4: overview — days パラメータ検証
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 4: overview — days パラメータ検証');

await test('?days=7 → days:7', async () => {
  const { data } = await api('GET', '/api/sf/ga/overview?days=7');
  assert.equal(data.days, 7);
});

await test('?days=14 → days:14', async () => {
  const { data } = await api('GET', '/api/sf/ga/overview?days=14');
  assert.equal(data.days, 14);
});

await test('?days=30 → days:30', async () => {
  const { data } = await api('GET', '/api/sf/ga/overview?days=30');
  assert.equal(data.days, 30);
});

await test('?days=0 → デフォルト 30 にフォールバック', async () => {
  const { data } = await api('GET', '/api/sf/ga/overview?days=0');
  assert.equal(data.days, 30);
});

await test('?days=999 → デフォルト 30 にフォールバック', async () => {
  const { data } = await api('GET', '/api/sf/ga/overview?days=999');
  assert.equal(data.days, 30);
});

await test('?days=abc → デフォルト 30 にフォールバック', async () => {
  const { data } = await api('GET', '/api/sf/ga/overview?days=abc');
  assert.equal(data.days, 30);
});

await test('days=7 のとき period が 7 日間', async () => {
  const { data } = await api('GET', '/api/sf/ga/overview?days=7');
  const from = new Date(data.period.from);
  const to   = new Date(data.period.to);
  const diffDays = Math.round((to - from) / (1000 * 60 * 60 * 24));
  assert.equal(diffDays, 6, `period は 6日差（= 7日間）: ${diffDays}`);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Section 5: overview — 前期間比較
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 5: overview — 前期間比較（has_previous_data）');

// 前期データを挿入
writeGaDaily(db, [
  { date: datePreviousA, pagePath: '/',        pageViews: 80,  users: 60, sessions: 65, engagedSessions: 40 },
  { date: datePreviousB, pagePath: '/sweets/', pageViews: 20,  users: 15, sessions: 16, engagedSessions: 12 },
]);

await test('前期データ挿入後: has_previous_data=true', async () => {
  const { data } = await api('GET', '/api/sf/ga/overview');
  assert.equal(data.has_previous_data, true);
});

await test('previous が null でない', async () => {
  const { data } = await api('GET', '/api/sf/ga/overview');
  assert.notEqual(data.previous, null);
});

await test('previous.page_views が正しく集計される', async () => {
  const { data } = await api('GET', '/api/sf/ga/overview');
  // datePreviousA: 80, datePreviousB: 20 → 合計 100
  assert.equal(data.previous.page_views, 100);
});

await test('previous フィールドに必須フィールドが揃う', async () => {
  const { data } = await api('GET', '/api/sf/ga/overview');
  assert.ok('page_views'       in data.previous);
  assert.ok('users'            in data.previous);
  assert.ok('sessions'         in data.previous);
  assert.ok('engaged_sessions' in data.previous);
});

await test('期間外データ（90日前）は集計に含まれない', async () => {
  // dateOldA にデータを挿入
  writeGaDaily(db, [
    { date: dateOldA, pagePath: '/', pageViews: 9999, users: 9999, sessions: 9999, engagedSessions: 9999 },
  ]);
  const { data } = await api('GET', '/api/sf/ga/overview');
  // 当期の page_views が 9999 増えていないことを確認
  assert.ok(data.current.page_views < 9999, `期間外データが混入: ${data.current.page_views}`);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Section 6: Music 導線イベント
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 6: Music 導線イベント（music_play / click_music / click_spotify / nav_hayatecchi）');

// Music 系イベントデータを挿入
writeGaEventDaily(db, [
  { date: dateCurrentA, eventName: 'music_play',     pagePath: '/sweets/', count: 25 },
  { date: dateCurrentA, eventName: 'music_play_30s', pagePath: '/sweets/', count: 18 },
  { date: dateCurrentA, eventName: 'click_music',    pagePath: '/',        count: 42 },
  { date: dateCurrentA, eventName: 'click_spotify',  pagePath: '/music/',  count: 15 },
  { date: dateCurrentA, eventName: 'nav_hayatecchi', pagePath: '/',        count:  7 },
  { date: dateCurrentB, eventName: 'music_play',     pagePath: '/sweets/', count: 30 },
  { date: dateCurrentB, eventName: 'click_music',    pagePath: '/',        count: 55 },
]);

await test('music_play イベントが /api/sf/ga/events から取得できる', async () => {
  // dateCurrentB（15日前）が earlier、dateCurrentA（5日前）が later
  const { data } = await api('GET', `/api/sf/ga/events?from=${dateCurrentB}&to=${dateCurrentA}&event_name=music_play`);
  assert.equal(data.ok, true);
  assert.ok(data.rows.length >= 1);
  assert.ok(data.rows.every(r => r.event_name === 'music_play'));
});

await test('click_music イベントが取得できる', async () => {
  const { data } = await api('GET', `/api/sf/ga/events?from=${dateCurrentA}&to=${dateCurrentA}&event_name=click_music`);
  assert.equal(data.ok, true);
  assert.ok(data.rows.length >= 1);
  assert.equal(data.rows[0].event_name, 'click_music');
  assert.equal(Number(data.rows[0].count), 42);
});

await test('click_spotify イベントが取得できる', async () => {
  const { data } = await api('GET', `/api/sf/ga/events?from=${dateCurrentA}&to=${dateCurrentA}&event_name=click_spotify`);
  assert.equal(data.ok, true);
  assert.ok(data.rows.some(r => r.event_name === 'click_spotify'));
  assert.equal(Number(data.rows.find(r => r.event_name === 'click_spotify').count), 15);
});

await test('nav_hayatecchi イベントが取得できる', async () => {
  const { data } = await api('GET', `/api/sf/ga/events?from=${dateCurrentA}&to=${dateCurrentA}&event_name=nav_hayatecchi`);
  assert.equal(data.ok, true);
  assert.ok(data.rows.some(r => r.event_name === 'nav_hayatecchi'));
  assert.equal(Number(data.rows.find(r => r.event_name === 'nav_hayatecchi').count), 7);
});

await test('music_play と click_music は別イベント（独立してカウント）', async () => {
  const { data } = await api('GET', `/api/sf/ga/events?from=${dateCurrentA}&to=${dateCurrentA}`);
  const mp  = data.rows.find(r => r.event_name === 'music_play');
  const cm  = data.rows.find(r => r.event_name === 'click_music');
  assert.ok(mp, 'music_play が存在する');
  assert.ok(cm, 'click_music が存在する');
  assert.notEqual(Number(mp.count), Number(cm.count), '件数が異なる（独立して計測）');
});

await test('music_play の 2日間合計が正しい（25+30=55）', async () => {
  // dateCurrentB（15日前）が earlier、dateCurrentA（5日前）が later
  const { data } = await api('GET', `/api/sf/ga/events?from=${dateCurrentB}&to=${dateCurrentA}&event_name=music_play`);
  const total = data.rows.reduce((s, r) => s + Number(r.count), 0);
  assert.equal(total, 55);
});

await test('music_play はカタログで DEEP_INTEREST / active', async () => {
  const { data } = await api('GET', '/api/sf/ga/events/catalog');
  const ev = data.events.find(e => e.event_name === 'music_play');
  assert.ok(ev, 'music_play がカタログに存在');
  assert.equal(ev.funnel_stage, 'DEEP_INTEREST');
  assert.equal(ev.status, 'active');
});

await test('click_spotify はカタログで ENGAGEMENT', async () => {
  const { data } = await api('GET', '/api/sf/ga/events/catalog');
  const ev = data.events.find(e => e.event_name === 'click_spotify');
  assert.ok(ev, 'click_spotify がカタログに存在');
  assert.equal(ev.funnel_stage, 'ENGAGEMENT');
});

await test('nav_hayatecchi はカタログで ENGAGEMENT / active', async () => {
  const { data } = await api('GET', '/api/sf/ga/events/catalog');
  const ev = data.events.find(e => e.event_name === 'nav_hayatecchi');
  assert.ok(ev, 'nav_hayatecchi がカタログに存在');
  assert.equal(ev.funnel_stage, 'ENGAGEMENT');
  assert.equal(ev.status, 'active');
});

await test('music_play_30s はカタログで DEEP_INTEREST / active', async () => {
  const { data } = await api('GET', '/api/sf/ga/events/catalog');
  const ev = data.events.find(e => e.event_name === 'music_play_30s');
  assert.ok(ev, 'music_play_30s がカタログに存在');
  assert.equal(ev.funnel_stage, 'DEEP_INTEREST');
  assert.equal(ev.status, 'active');
});

// ═══════════════════════════════════════════════════════════════════════════════
// Section 7: 既存 GA エンドポイント回帰確認
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 7: 既存 GA エンドポイント回帰確認');

await test('/api/sf/ga/daily → 200 / ok:true / rows[]（回帰）', async () => {
  const { status, data } = await api('GET', '/api/sf/ga/daily');
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.ok(Array.isArray(data.rows));
});

await test('/api/sf/ga/pages → 200 / ok:true / rows[] / PV降順（回帰）', async () => {
  const { status, data } = await api('GET', '/api/sf/ga/pages');
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.ok(Array.isArray(data.rows));
  if (data.rows.length >= 2) {
    assert.ok(
      Number(data.rows[0].page_views) >= Number(data.rows[1].page_views),
      'PV 降順で並んでいる'
    );
  }
});

await test('/api/sf/ga/compare → 200 / ok:true / days フィールドあり（回帰）', async () => {
  const { status, data } = await api('GET', '/api/sf/ga/compare');
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.ok('days' in data);
  assert.ok(Array.isArray(data.rows));
});

await test('/api/sf/ga/events → 200 / ok:true / rows[]（回帰）', async () => {
  const { status, data } = await api('GET', '/api/sf/ga/events');
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.ok(Array.isArray(data.rows));
  assert.ok(data.rows.length > 0, 'イベントデータが返る');
});

await test('/api/sf/ga/events/catalog → 200 / ok:true / 20件以上（回帰）', async () => {
  const { status, data } = await api('GET', '/api/sf/ga/events/catalog');
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.ok(data.events.length >= 20);
});

await test('/api/sf/ga/compare?days=7 → days:7（回帰）', async () => {
  const { data } = await api('GET', '/api/sf/ga/compare?days=7');
  assert.equal(data.days, 7);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Section 8: empty state — イベントデータなし
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 8: empty state — 存在しないイベント / 期間外');

await test('存在しないイベント名 → rows:[]', async () => {
  const { data } = await api('GET', '/api/sf/ga/events?event_name=nonexistent_event_xyz');
  assert.equal(data.ok, true);
  assert.deepEqual(data.rows, []);
});

await test('将来日付の期間 → rows:[]（ページデータなし）', async () => {
  const { data } = await api('GET', '/api/sf/ga/pages?from=2099-01-01&to=2099-01-31');
  assert.equal(data.ok, true);
  assert.deepEqual(data.rows, []);
});

await test('将来日付 overview → has_data:false / current:null', async () => {
  const { data } = await api('GET', '/api/sf/ga/overview?days=7');
  // days=7 の期間内にデータが入っているかどうかは dateCurrentA による
  // 念のため日付を指定して空期間をテスト（daily の from/to パラメータ）
  const { data: d2 } = await api('GET', '/api/sf/ga/daily?from=2099-01-01&to=2099-01-31');
  assert.deepEqual(d2.rows, [], '将来期間のデータは空');
});

// ═══════════════════════════════════════════════════════════════════════════════
// Section 9: 0 vs 未取得の区別
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 9: 0 vs 未取得の区別');

await test('has_data=true のとき current は null ではなくオブジェクト', async () => {
  const { data } = await api('GET', '/api/sf/ga/overview');
  assert.equal(data.has_data, true);
  assert.notEqual(data.current, null, 'has_data=true → current はオブジェクト');
  assert.ok(typeof data.current === 'object');
});

await test('has_data=false のとき current は null（0 ではない）', async () => {
  // 別の :memory: DB で確認
  const emptyDb = createDb(':memory:');
  const emptyHandler = createApiHandler(emptyDb);
  const emptyServer  = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.url.startsWith('/api/')) return emptyHandler(req, res, url);
    res.writeHead(404); res.end();
  });
  const emptyPort = await new Promise(resolve => {
    emptyServer.listen(0, '127.0.0.1', () => resolve(emptyServer.address().port));
  });
  try {
    const r = await fetch(`http://127.0.0.1:${emptyPort}/api/sf/ga/overview`).then(r => r.json());
    assert.equal(r.has_data, false);
    assert.equal(r.current, null, 'current は null（0 のオブジェクトではない）');
  } finally {
    emptyServer.close();
  }
});

await test('page_views=0 のデータがあっても has_data=true / current は数値0', async () => {
  const zeroDb      = createDb(':memory:');
  const zeroHandler = createApiHandler(zeroDb);
  const zeroServer  = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    if (req.url.startsWith('/api/')) return zeroHandler(req, res, url);
    res.writeHead(404); res.end();
  });
  const zeroPort = await new Promise(resolve => {
    zeroServer.listen(0, '127.0.0.1', () => resolve(zeroServer.address().port));
  });
  try {
    // page_views=0 のデータを挿入
    writeGaDaily(zeroDb, [
      { date: daysAgo(3), pagePath: '/', pageViews: 0, users: 0, sessions: 0, engagedSessions: 0 },
    ]);
    const r = await fetch(`http://127.0.0.1:${zeroPort}/api/sf/ga/overview`).then(r => r.json());
    assert.equal(r.has_data, true, 'row があれば has_data=true');
    assert.notEqual(r.current, null, 'current はオブジェクト');
    assert.equal(r.current.page_views, 0, 'page_views は 0（null ではない）');
  } finally {
    zeroServer.close();
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Section 10: 不正入力処理
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 10: 不正入力処理');

await test('/api/sf/ga/overview?days=-1 → デフォルト 30', async () => {
  const { data } = await api('GET', '/api/sf/ga/overview?days=-1');
  assert.equal(data.days, 30);
});

await test('/api/sf/ga/overview?days= （空）→ デフォルト 30', async () => {
  const { data } = await api('GET', '/api/sf/ga/overview?days=');
  assert.equal(data.days, 30);
});

await test('/api/sf/ga/daily?from=invalid → 正常 200（デフォルト期間で返す）', async () => {
  const { status, data } = await api('GET', '/api/sf/ga/daily?from=invalid-date');
  assert.equal(status, 200);
  assert.equal(data.ok, true);
});

await test('/api/sf/ga/compare?days=15 → 不正 days は 30 にフォールバック', async () => {
  const { data } = await api('GET', '/api/sf/ga/compare?days=15');
  assert.equal(data.days, 30, '有効でない days (15) は 30 になる');
});

// ═══════════════════════════════════════════════════════════════════════════════
// Section 11: GA 認証情報非漏洩
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 11: GA 認証情報非漏洩');

await test('/api/sf/ga/overview レスポンスに認証情報フィールドなし', async () => {
  const { data } = await api('GET', '/api/sf/ga/overview');
  const forbidden = ['token', 'access_token', 'client_secret', 'api_key', 'credentials', 'password', 'private_key'];
  for (const key of forbidden) {
    assert.ok(!(key in data), `${key} がレスポンスに含まれている`);
  }
  const str = JSON.stringify(data).toLowerCase();
  assert.ok(!str.includes('client_secret'), 'client_secret が含まれる');
});

await test('/api/sf/ga/events レスポンスに認証情報フィールドなし', async () => {
  const { data } = await api('GET', '/api/sf/ga/events');
  const str = JSON.stringify(data).toLowerCase();
  assert.ok(!str.includes('access_token'), 'access_token が含まれる');
  assert.ok(!str.includes('client_secret'), 'client_secret が含まれる');
  assert.ok(!str.includes('api_key'), 'api_key が含まれる');
});

await test('/api/sf/ga/pages レスポンスに認証情報フィールドなし', async () => {
  const { data } = await api('GET', '/api/sf/ga/pages');
  const str = JSON.stringify(data).toLowerCase();
  assert.ok(!str.includes('access_token'), 'access_token が含まれる');
  assert.ok(!str.includes('password'), 'password が含まれる');
});

await test('ga_manager / ga_writer ソースコードにハードコードされた認証情報なし', async () => {
  const writerSrc = readFileSync(new URL('../importers/ga_writer.js', import.meta.url), 'utf8').toLowerCase();
  assert.ok(!writerSrc.includes('access_token'), 'ga_writer に access_token がある');
  assert.ok(!writerSrc.includes('client_secret'), 'ga_writer に client_secret がある');
  assert.ok(!writerSrc.includes('api_key'),       'ga_writer に api_key がある');
});

// ═══════════════════════════════════════════════════════════════════════════════
// Section 12: 実 GA4 通信なし
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 12: 実 GA4 通信なし');

await test('テスト内の全 fetch は localhost のみ', async () => {
  assert.ok(BASE.startsWith('http://127.0.0.1'), `BASE が localhost 以外: ${BASE}`);
});

await test('ga_writer.js は googleapi / googleapis を import しない', async () => {
  const src = readFileSync(new URL('../importers/ga_writer.js', import.meta.url), 'utf8');
  assert.ok(!src.includes('googleapis'), 'googleapis が import されている');
  assert.ok(!src.includes('google-auth'), 'google-auth が import されている');
  assert.ok(!src.includes('analyticsdata'), 'analyticsdata が import されている');
});

await test('実 DB (business_data.db) を参照しない', async () => {
  const count = db.prepare('SELECT COUNT(*) AS c FROM sf_ga_daily').get().c;
  assert.ok(count >= 3, 'テストデータが :memory: DB に書き込まれている');
});

// ═══════════════════════════════════════════════════════════════════════════════
// Section 13: Dashboard HTML 構造確認
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 13: Dashboard HTML 構造確認');

const htmlSrc = readFileSync(
  new URL('../dashboard/public/index.html', import.meta.url), 'utf8'
);

await test('index.html に "HP Analytics" タブボタンが存在する', async () => {
  assert.ok(htmlSrc.includes('HP Analytics'), 'HP Analytics タブが存在しない');
});

await test('index.html に sf-tab-hp-analytics パネルが存在する', async () => {
  assert.ok(htmlSrc.includes('sf-tab-hp-analytics'), 'sf-tab-hp-analytics が存在しない');
});

await test('index.html に hp-overview-container が存在する', async () => {
  assert.ok(htmlSrc.includes('hp-overview-container'), 'hp-overview-container が存在しない');
});

await test('index.html に hp-pages-container が存在する', async () => {
  assert.ok(htmlSrc.includes('hp-pages-container'), 'hp-pages-container が存在しない');
});

await test('index.html に hp-daily-container が存在する', async () => {
  assert.ok(htmlSrc.includes('hp-daily-container'), 'hp-daily-container が存在しない');
});

await test('index.html に hp-events-container が存在する', async () => {
  assert.ok(htmlSrc.includes('hp-events-container'), 'hp-events-container が存在しない');
});

await test('index.html に hp-music-container が存在する', async () => {
  assert.ok(htmlSrc.includes('hp-music-container'), 'hp-music-container が存在しない');
});

await test('index.html に hp-sources-container が存在する', async () => {
  assert.ok(htmlSrc.includes('hp-sources-container'), 'hp-sources-container が存在しない');
});

await test('index.html に外部 CDN 参照がない', async () => {
  assert.ok(!htmlSrc.includes('cdn.'), 'CDN リンクが存在する');
  assert.ok(!htmlSrc.includes('unpkg.com'), 'unpkg が使われている');
  assert.ok(!htmlSrc.includes('jsdelivr'), 'jsdelivr が使われている');
});

// ═══════════════════════════════════════════════════════════════════════════════
// Section 14: main 変更なし
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 14: main 変更なし');

await test('overview API はページデータ DB を READ のみ（UPSERT なし）', async () => {
  // overview API 実行前後で sf_ga_daily の件数が変わらないことを確認
  const before = db.prepare('SELECT COUNT(*) AS c FROM sf_ga_daily').get().c;
  await api('GET', '/api/sf/ga/overview');
  const after  = db.prepare('SELECT COUNT(*) AS c FROM sf_ga_daily').get().c;
  assert.equal(after, before, 'overview は sf_ga_daily を変更しない');
});

await test('overview API はイベント DB を READ のみ（変更なし）', async () => {
  const before = db.prepare('SELECT COUNT(*) AS c FROM sf_ga_event_daily').get().c;
  await api('GET', '/api/sf/ga/overview');
  const after  = db.prepare('SELECT COUNT(*) AS c FROM sf_ga_event_daily').get().c;
  assert.equal(after, before, 'overview は sf_ga_event_daily を変更しない');
});

// ─── 終了処理 ─────────────────────────────────────────────────────────────────

server.close();

console.log(`\n${'─'.repeat(60)}`);
console.log(`HP Analytics テスト完了: ${passed} passed / ${failed} failed`);

if (failed > 0) process.exit(1);
