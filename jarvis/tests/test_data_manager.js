/**
 * jarvis/tests/test_data_manager.js
 * JARVIS共通データ基盤 MVP ユニットテスト
 *
 * 重要：
 * - テストは ':memory:' の一時SQLiteDBを使用する
 * - 実データDB (business_data.db) には絶対に触れない
 * - テスト終了後、インメモリDBは自動的に破棄される
 */

import assert from 'node:assert/strict';
import { createDb }                                         from '../data/db.js';
import { addWorkRecord, getWorkRecords, updateWorkRecord }  from '../data/work_record_manager.js';
import { upsertDailyStatus, markWorkDay, getDailyStatus,
         getFullDayOffCount, getMaxConsecutiveWorkDays }   from '../data/daily_status_manager.js';
import { getMonthlySummary, getCategoryBreakdown,
         getClientBreakdown, getWorkTypeBreakdown,
         getUnpaidCounts, getFullDayOffCount as aggFullDayOff } from '../data/aggregator.js';

// ─── テスト用インメモリDB（実データDBには触れない）────────────────────────
const db = createDb(':memory:');

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

// ─── work_records テスト ────────────────────────────────────────────────────
console.log('\n▶ work_records');

test('基本レコードを追加できる', () => {
  const { rowid, job_id } = addWorkRecord(db, {
    date: '2026-08-01', category: '音声仕事', work_type: 'ロケ',
    client: 'テスト社', income: 25000, work_hours: 4.0, travel_hours: 1.5,
    invoice_status: '未請求', payment_status: '未入金',
  });
  assert.ok(rowid > 0);
  assert.ok(typeof job_id === 'string' && job_id.length > 0);
});

test('job_idを省略するとUUIDが自動生成される', () => {
  const r = addWorkRecord(db, { date: '2026-08-02', category: 'Snow flakes' });
  assert.ok(/^[0-9a-f-]{36}$/.test(r.job_id));
});

test('job_idを指定した場合はその値が使われる', () => {
  const r = addWorkRecord(db, { date: '2026-08-03', category: '物販', job_id: 'test-job-001' });
  assert.equal(r.job_id, 'test-job-001');
});

test('income/expense は非負整数のみ許可', () => {
  assert.throws(() => addWorkRecord(db, { date: '2026-08-04', category: 'その他', income: -1 }),
    /non-negative integer/);
  assert.throws(() => addWorkRecord(db, { date: '2026-08-04', category: 'その他', income: 1.5 }),
    /non-negative integer/);
});

test('work_hours/travel_hours は非負のみ許可', () => {
  assert.throws(() => addWorkRecord(db, { date: '2026-08-04', category: 'その他', work_hours: -0.1 }),
    /work_hours/);
});

test('不正なcategoryを拒否する', () => {
  assert.throws(() => addWorkRecord(db, { date: '2026-08-04', category: '不正カテゴリ' }),
    /category/);
});

test('不正なinvoice_statusを拒否する', () => {
  assert.throws(() => addWorkRecord(db, { date: '2026-08-04', category: 'その他', invoice_status: 'NG' }),
    /invoice_status/);
});

test('不正なpayment_statusを拒否する', () => {
  assert.throws(() => addWorkRecord(db, { date: '2026-08-04', category: 'その他', payment_status: 'NG' }),
    /payment_status/);
});

test('dateが必須', () => {
  assert.throws(() => addWorkRecord(db, { category: 'その他' }), /date is required/);
});

test('categoryが必須', () => {
  assert.throws(() => addWorkRecord(db, { date: '2026-08-05' }), /category is required/);
});

test('完全休日の日に仕事を登録しようとするとエラー', () => {
  upsertDailyStatus(db, { date: '2026-08-30', is_full_day_off: true, memo: '完全休日テスト' });
  assert.throws(
    () => addWorkRecord(db, { date: '2026-08-30', category: 'その他' }),
    /ConflictError/
  );
});

test('getWorkRecords で全件取得できる', () => {
  const rows = getWorkRecords(db);
  assert.ok(rows.length >= 3);
});

test('yearMonth フィルターが動作する', () => {
  const rows = getWorkRecords(db, { yearMonth: '2026-08' });
  assert.ok(rows.every(r => r.date.startsWith('2026-08')));
});

test('invoice_status を更新できる', () => {
  const { rowid } = addWorkRecord(db, { date: '2026-08-10', category: '音声仕事', invoice_status: '未請求' });
  updateWorkRecord(db, rowid, { invoice_status: '請求済' });
  const row = db.prepare('SELECT * FROM work_records WHERE id = ?').get(rowid);
  assert.equal(row.invoice_status, '請求済');
});

// ─── daily_status テスト ────────────────────────────────────────────────────
console.log('\n▶ daily_status');

test('完全休日を登録できる', () => {
  upsertDailyStatus(db, { date: '2026-08-11', is_full_day_off: true, memo: '休日' });
  const row = getDailyStatus(db, '2026-08-11');
  assert.equal(row.is_full_day_off, 1);
  assert.equal(row.memo, '休日');
});

test('勤務日を登録できる', () => {
  upsertDailyStatus(db, { date: '2026-08-12', is_full_day_off: false });
  const row = getDailyStatus(db, '2026-08-12');
  assert.equal(row.is_full_day_off, 0);
});

test('未登録日はnullを返す', () => {
  const row = getDailyStatus(db, '2099-01-01');
  assert.equal(row, null);
});

test('UPSERT で既存レコードを上書きできる', () => {
  upsertDailyStatus(db, { date: '2026-08-13', is_full_day_off: false });
  upsertDailyStatus(db, { date: '2026-08-13', is_full_day_off: true });
  const row = getDailyStatus(db, '2026-08-13');
  assert.equal(row.is_full_day_off, 1);
});

test('markWorkDay は未登録の日のみ挿入し既存を上書きしない', () => {
  // 既に休日登録されている日は上書きされない
  upsertDailyStatus(db, { date: '2026-08-14', is_full_day_off: true });
  markWorkDay(db, '2026-08-14');
  const row = getDailyStatus(db, '2026-08-14');
  assert.equal(row.is_full_day_off, 1, '休日のままであること');

  // 未登録の日は勤務日として挿入される
  markWorkDay(db, '2026-08-15');
  const row2 = getDailyStatus(db, '2026-08-15');
  assert.equal(row2.is_full_day_off, 0);
});

test('is_full_day_off がboolean以外の場合エラー', () => {
  assert.throws(() => upsertDailyStatus(db, { date: '2026-08-20', is_full_day_off: 1 }), /boolean/);
});

test('完全休日日数が正しく集計される', () => {
  // 2026-08-11, 2026-08-13, 2026-08-14 が休日
  const count = getFullDayOffCount(db, { yearMonth: '2026-08' });
  assert.ok(count >= 3);
});

test('最大連勤が計算できる', () => {
  // 2026-08-12, 2026-08-15 が勤務日（連続2日とは限らないが0より大きい）
  const { max_consecutive_work_days } = getMaxConsecutiveWorkDays(db);
  assert.ok(max_consecutive_work_days >= 1);
});

// ─── aggregator テスト ──────────────────────────────────────────────────────
console.log('\n▶ aggregator');

test('月別サマリーが取得できる', () => {
  const s = getMonthlySummary(db, '2026-08');
  assert.ok(typeof s.total_income === 'number');
  assert.ok(typeof s.profit === 'number');
  assert.equal(s.profit, s.total_income - s.total_expense);
});

test('収益÷労働時間が計算される', () => {
  const s = getMonthlySummary(db, '2026-08');
  if (s.total_work_hours > 0) {
    assert.ok(s.income_per_hour > 0);
  }
});

test('カテゴリ別集計が動作する', () => {
  const rows = getCategoryBreakdown(db);
  assert.ok(Array.isArray(rows));
  assert.ok(rows.length > 0);
  assert.ok(rows.every(r => typeof r.category === 'string'));
});

test('発注元別件数がDISTINCT job_idで計算される（重複なし）', () => {
  // 同じjob_idで2レコード追加
  const jid = 'dup-job-001';
  addWorkRecord(db, { date: '2026-08-20', category: '音声仕事', client: 'dup社', job_id: jid, income: 10000 });
  addWorkRecord(db, { date: '2026-08-21', category: '音声仕事', client: 'dup社', job_id: jid, income: 5000 });
  const rows = getClientBreakdown(db);
  const dup  = rows.find(r => r.client === 'dup社');
  assert.ok(dup);
  assert.equal(dup.job_count, 1, 'DISTINCT job_id: 2レコードでも件数は1');
  assert.equal(dup.total_income, 15000, '収益は合計される');
});

test('work_type別集計が動作する', () => {
  const rows = getWorkTypeBreakdown(db);
  assert.ok(Array.isArray(rows));
});

test('未請求・未入金件数が集計される', () => {
  const { uninvoiced, unpaid } = getUnpaidCounts(db);
  assert.ok(typeof uninvoiced === 'number');
  assert.ok(typeof unpaid === 'number');
  assert.ok(uninvoiced >= 1);
  assert.ok(unpaid >= 1);
});

test('aggregator.getFullDayOffCount が動作する', () => {
  const count = aggFullDayOff(db, '2026-08');
  assert.ok(typeof count === 'number');
  assert.ok(count >= 0);
});

// ─── 結果集計 ────────────────────────────────────────────────────────────────
db.close();

console.log(`\n${'─'.repeat(40)}`);
console.log(`テスト結果: ${passed + failed} 件 / ✅ ${passed} 件 / ❌ ${failed} 件`);

if (failed > 0) {
  process.exit(1);
} else {
  console.log('全テスト通過');
}
