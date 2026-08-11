/**
 * jarvis/tests/test_dashboard_api.js
 * JARVIS Dashboard API ユニットテスト
 *
 * 重要：
 * - テストは ':memory:' の一時 SQLite DB を使用する
 * - 実データ DB (business_data.db) には絶対に触れない
 * - テスト専用ポート（OS 任意割り当て）を使用する
 */

import assert from 'node:assert/strict';
import { createServer } from 'http';
import { createDb }        from '../data/db.js';
import { createApiHandler } from '../dashboard/api.js';

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

async function api(method, path, body = null) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== null) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, opts);
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

// ─── テスト ───────────────────────────────────────────────────────────────────
console.log('\n▶ dashboard API — 基本エンドポイント');

await test('GET /api/today → 今日の情報が返る', async () => {
  const { status, data } = await api('GET', '/api/today');
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.ok(typeof data.today === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(data.today));
  assert.ok(Array.isArray(data.works));
  assert.ok(typeof data.month === 'string');
});

await test('GET /api/summary → 月次サマリーが返る', async () => {
  const { status, data } = await api('GET', '/api/summary?month=2026-08');
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.ok(typeof data.summary.total_income === 'number');
  assert.ok(typeof data.summary.profit === 'number');
  assert.equal(data.summary.profit, data.summary.total_income - data.summary.total_expense);
  assert.ok(typeof data.uninvoiced === 'number');
  assert.ok(typeof data.unpaid === 'number');
  assert.ok(typeof data.full_day_off === 'number');
});

await test('GET /api/summary 不正な月フォーマット → 400', async () => {
  const { status, data } = await api('GET', '/api/summary?month=invalid');
  assert.equal(status, 400);
  assert.equal(data.ok, false);
  assert.ok(typeof data.error === 'string');
});

await test('GET /api/works → 仕事一覧が返る（初期は空）', async () => {
  const { status, data } = await api('GET', '/api/works?month=2026-08');
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.ok(Array.isArray(data.works));
});

await test('GET /api/works 不正月フォーマット → 400', async () => {
  const { status, data } = await api('GET', '/api/works?month=2026/08');
  assert.equal(status, 400);
  assert.equal(data.ok, false);
});

console.log('\n▶ dashboard API — 仕事登録');

let registeredId = null;

await test('POST /api/work → 仕事が登録される', async () => {
  const { status, data } = await api('POST', '/api/work', {
    date:           '2026-08-01',
    category:       '音声仕事',
    work_type:      'ロケ',
    client:         'テスト社',
    income:         20000,
    expense:        500,
    work_hours:     3.0,
    travel_hours:   1.0,
    invoice_status: '未請求',
    payment_status: '未入金',
  });
  assert.equal(status, 201);
  assert.equal(data.ok, true);
  assert.ok(data.id > 0);
  assert.ok(typeof data.job_id === 'string' && data.job_id.length > 0);
  registeredId = data.id;
});

await test('POST /api/work date 未指定 → 400', async () => {
  const { status, data } = await api('POST', '/api/work', { category: 'その他' });
  assert.equal(status, 400);
  assert.equal(data.ok, false);
});

await test('POST /api/work category 未指定 → 400', async () => {
  const { status, data } = await api('POST', '/api/work', { date: '2026-08-02' });
  assert.equal(status, 400);
  assert.equal(data.ok, false);
});

await test('POST /api/work 不正カテゴリ → 400', async () => {
  const { status, data } = await api('POST', '/api/work', {
    date: '2026-08-02', category: '不正カテゴリ',
  });
  assert.equal(status, 400);
  assert.equal(data.ok, false);
});

await test('POST /api/work 負の収入 → 400', async () => {
  const { status, data } = await api('POST', '/api/work', {
    date: '2026-08-02', category: 'その他', income: -100,
  });
  assert.equal(status, 400);
  assert.equal(data.ok, false);
});

await test('POST /api/work 不正な invoice_status → 400', async () => {
  const { status, data } = await api('POST', '/api/work', {
    date: '2026-08-02', category: 'その他', invoice_status: '不正',
  });
  assert.equal(status, 400);
  assert.equal(data.ok, false);
});

await test('POST /api/work 不正な日付フォーマット → 400', async () => {
  const { status, data } = await api('POST', '/api/work', {
    date: '2026/08/02', category: 'その他',
  });
  assert.equal(status, 400);
  assert.equal(data.ok, false);
});

console.log('\n▶ dashboard API — ステータス更新');

await test('PUT /api/work/:id → invoice_status を請求済に更新', async () => {
  assert.ok(registeredId, '事前登録が必要');
  const { status, data } = await api('PUT', `/api/work/${registeredId}`, {
    invoice_status: '請求済',
  });
  assert.equal(status, 200);
  assert.equal(data.ok, true);
});

await test('PUT /api/work/:id 不正 invoice_status → 400', async () => {
  assert.ok(registeredId);
  const { status, data } = await api('PUT', `/api/work/${registeredId}`, {
    invoice_status: '無効ステータス',
  });
  assert.equal(status, 400);
  assert.equal(data.ok, false);
});

await test('PUT /api/work/999 存在しない ID → 更新エラーなし（updateRecord は silent）', async () => {
  // updateWorkRecordFull は存在しない ID でもエラーを投げない（行数 0 で無視）
  const { status, data } = await api('PUT', '/api/work/999', { invoice_status: '請求済' });
  assert.equal(status, 200);
  assert.equal(data.ok, true);
});

console.log('\n▶ dashboard API — 仕事編集（全フィールド更新）');

await test('PUT /api/work/:id → 全フィールド更新', async () => {
  assert.ok(registeredId, '事前登録が必要');
  const { status, data } = await api('PUT', `/api/work/${registeredId}`, {
    date:           '2026-08-01',
    category:       '音声仕事',
    work_type:      'STUDIO',
    content:        '編集後コンテンツ',
    client:         '編集後クライアント',
    income:         25000,
    expense:        1000,
    work_hours:     4.0,
    travel_hours:   2.0,
    invoice_status: '未請求',
    payment_status: '未入金',
    memo:           '編集テスト',
  });
  assert.equal(status, 200);
  assert.equal(data.ok, true);
});

await test('PUT /api/work/:id → 金額のみ変更', async () => {
  assert.ok(registeredId);
  const { status, data } = await api('PUT', `/api/work/${registeredId}`, { income: 30000, expense: 500 });
  assert.equal(status, 200);
  assert.equal(data.ok, true);
});

await test('PUT /api/work/:id → 時間のみ変更', async () => {
  assert.ok(registeredId);
  const { status, data } = await api('PUT', `/api/work/${registeredId}`, { work_hours: 5.5, travel_hours: 1.5 });
  assert.equal(status, 200);
  assert.equal(data.ok, true);
});

await test('PUT /api/work/:id → 仕事内容・発注元を変更', async () => {
  assert.ok(registeredId);
  const { status, data } = await api('PUT', `/api/work/${registeredId}`, {
    content: '変更後コンテンツ', client: '変更後クライアント',
  });
  assert.equal(status, 200);
  assert.equal(data.ok, true);
});

await test('invoice_status 未請求 → 請求済 → 未請求（逆方向）', async () => {
  assert.ok(registeredId);
  await api('PUT', `/api/work/${registeredId}`, { invoice_status: '請求済' });
  const { status, data } = await api('PUT', `/api/work/${registeredId}`, { invoice_status: '未請求' });
  assert.equal(status, 200);
  assert.equal(data.ok, true);
});

await test('payment_status 未入金 → 入金済 → 未入金（逆方向）', async () => {
  assert.ok(registeredId);
  await api('PUT', `/api/work/${registeredId}`, { payment_status: '入金済' });
  const { status, data } = await api('PUT', `/api/work/${registeredId}`, { payment_status: '未入金' });
  assert.equal(status, 200);
  assert.equal(data.ok, true);
});

await test('PUT /api/work/:id 負の金額 → 400', async () => {
  assert.ok(registeredId);
  const { status, data } = await api('PUT', `/api/work/${registeredId}`, { income: -1 });
  assert.equal(status, 400);
  assert.equal(data.ok, false);
});

await test('PUT /api/work/:id 不正カテゴリ → 400', async () => {
  assert.ok(registeredId);
  const { status, data } = await api('PUT', `/api/work/${registeredId}`, { category: '不正カテゴリ' });
  assert.equal(status, 400);
  assert.equal(data.ok, false);
});

await test('PUT /api/work/:id 不正日付フォーマット → 400', async () => {
  assert.ok(registeredId);
  const { status, data } = await api('PUT', `/api/work/${registeredId}`, { date: '2026/08/01' });
  assert.equal(status, 400);
  assert.equal(data.ok, false);
});

console.log('\n▶ dashboard API — 日次状態登録');

await test('POST /api/day → 完全休日が登録される', async () => {
  const { status, data } = await api('POST', '/api/day', {
    date: '2026-08-10',
    is_full_day_off: true,
    memo: 'テスト休日',
  });
  assert.equal(status, 200);
  assert.equal(data.ok, true);
});

await test('POST /api/day → 勤務日が登録される', async () => {
  const { status, data } = await api('POST', '/api/day', {
    date: '2026-08-12',
    is_full_day_off: false,
  });
  assert.equal(status, 200);
  assert.equal(data.ok, true);
});

await test('POST /api/day date 未指定 → 400', async () => {
  const { status, data } = await api('POST', '/api/day', { is_full_day_off: true });
  assert.equal(status, 400);
  assert.equal(data.ok, false);
});

await test('POST /api/day is_full_day_off が boolean でない → 400', async () => {
  const { status, data } = await api('POST', '/api/day', {
    date: '2026-08-15', is_full_day_off: 'yes',
  });
  assert.equal(status, 400);
  assert.equal(data.ok, false);
});

await test('POST /api/day 不正な日付フォーマット → 400', async () => {
  const { status, data } = await api('POST', '/api/day', {
    date: '20260815', is_full_day_off: true,
  });
  assert.equal(status, 400);
  assert.equal(data.ok, false);
});

console.log('\n▶ dashboard API — 完全休日への仕事登録（ConflictError）');

await test('完全休日の日に仕事を登録しようとすると 409 ConflictError', async () => {
  // 休日登録
  await api('POST', '/api/day', { date: '2026-08-20', is_full_day_off: true });
  // 休日に仕事登録 → ConflictError
  const { status, data } = await api('POST', '/api/work', {
    date: '2026-08-20', category: 'その他',
  });
  assert.equal(status, 409);
  assert.equal(data.ok, false);
  assert.ok(data.error.includes('ConflictError'));
});

console.log('\n▶ dashboard API — JARVIS 入力欄');

await test('POST /api/chat → 未実装メッセージが返る', async () => {
  const { status, data } = await api('POST', '/api/chat', { text: 'テスト入力' });
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.implemented, false);
  assert.ok(typeof data.message === 'string' && data.message.length > 0);
});

console.log('\n▶ dashboard API — 存在しないエンドポイント');

await test('GET /api/unknown → 404', async () => {
  const { status, data } = await api('GET', '/api/unknown');
  assert.equal(status, 404);
  assert.equal(data.ok, false);
});

// ─── クリーンアップ ───────────────────────────────────────────────────────────
server.close();
db.close();

console.log(`\n${'─'.repeat(40)}`);
console.log(`テスト結果: ${passed + failed} 件 / ✅ ${passed} 件 / ❌ ${failed} 件`);

if (failed > 0) {
  console.error('テスト失敗があります');
  process.exit(1);
} else {
  console.log('全テスト通過');
}
