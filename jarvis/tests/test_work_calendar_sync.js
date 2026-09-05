/**
 * jarvis/tests/test_work_calendar_sync.js
 * work_records → Google Calendar 同期テスト (Phase 20)
 *
 * 実行: node tests/test_work_calendar_sync.js
 *
 * - DatabaseSync + :memory: を使用（外部DB・実API呼び出しなし）
 * - Calendar API は全てモック
 * - テスト対象:
 *     parseTimeRange / buildEventFromWorkRecord /
 *     work_calendar_manager CRUD /
 *     dryRunWorkPush / syncSingleWorkRecord（モック）/
 *     hookWorkCreated / hookWorkUpdated / hookWorkDeleted（モック）
 */

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  parseTimeRange,
  buildEventFromWorkRecord,
  dryRunWorkPush,
  syncSingleWorkRecord,
} from '../sync/work_calendar_sync.js';

import {
  getWorkCalendarLink,
  upsertWorkCalendarLink,
  setWorkCalendarSynced,
  setWorkCalendarError,
  setWorkCalendarOrphaned,
  getPendingWorkCalendarLinks,
  getErrorWorkCalendarLinks,
  getWorkCalendarLinkSummary,
} from '../data/work_calendar_manager.js';

import {
  hookWorkCreated,
  hookWorkUpdated,
  hookWorkDeleted,
  getGoogleEventIdBeforeDelete,
  retryPendingCalendarDeletes,
} from '../sync/work_calendar_hook.js';

import {
  getAllCalendarDeleteQueue,
  getPendingCalendarDeletes,
} from '../data/calendar_delete_queue_manager.js';

// ─── テストヘルパー ───────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function section(name) { console.log(`\n${name}`); }

async function test(name, fn) {
  try {
    const r = fn();
    if (r && typeof r.then === 'function') await r;
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ❌ ${name}: ${e.message}`);
    failed++;
  }
}

// ─── インメモリDB セットアップ ────────────────────────────────────────────────

function setupDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(`
    CREATE TABLE work_records (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      job_id         TEXT    NOT NULL DEFAULT 'test-job',
      date           TEXT    NOT NULL,
      category       TEXT    NOT NULL DEFAULT '音声仕事',
      work_type      TEXT,
      content        TEXT,
      client         TEXT,
      income         INTEGER DEFAULT 0,
      expense        INTEGER DEFAULT 0,
      work_hours     REAL    DEFAULT 0,
      travel_hours   REAL    DEFAULT 0,
      invoice_status TEXT    NOT NULL DEFAULT '対象外',
      payment_status TEXT    NOT NULL DEFAULT '対象外',
      memo           TEXT,
      created_at     TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
      is_full_day    INTEGER NOT NULL DEFAULT 0 CHECK(is_full_day IN (0,1))
    )
  `);
  db.exec(`
    CREATE TABLE work_calendar_links (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      work_record_id     INTEGER NOT NULL REFERENCES work_records(id) ON DELETE CASCADE,
      google_calendar_id TEXT    NOT NULL,
      google_event_id    TEXT,
      sync_status        TEXT    NOT NULL DEFAULT 'pending'
                           CHECK (sync_status IN ('pending','synced','error','orphaned')),
      error_message      TEXT,
      error_count        INTEGER NOT NULL DEFAULT 0,
      last_attempted_at  TEXT,
      last_synced_at     TEXT,
      created_at         TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
      updated_at         TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
      UNIQUE(work_record_id),
      UNIQUE(google_calendar_id, google_event_id)
    )
  `);
  db.exec(`
    CREATE TABLE calendar_delete_queue (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      google_calendar_id TEXT    NOT NULL,
      google_event_id    TEXT    NOT NULL,
      work_record_id     INTEGER,
      status             TEXT    NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending','done')),
      error_message      TEXT,
      retry_count        INTEGER NOT NULL DEFAULT 0,
      created_at         TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
      last_attempted_at  TEXT,
      completed_at       TEXT
    )
  `);
  return db;
}

function insertRecord(db, overrides = {}) {
  const defaults = {
    date: '2026-09-19', category: '音声仕事', work_type: '中継',
    content: 'テスト業務', client: 'テスト株式会社',
    income: 25000, expense: 0,
    invoice_status: '対象外', payment_status: '対象外',
    memo: null, is_full_day: 1,
  };
  const r = { ...defaults, ...overrides };
  const res = db.prepare(`
    INSERT INTO work_records (date, category, work_type, content, client, income, expense,
      invoice_status, payment_status, memo, is_full_day)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(r.date, r.category, r.work_type, r.content, r.client, r.income, r.expense,
         r.invoice_status, r.payment_status, r.memo, r.is_full_day);
  return Number(res.lastInsertRowid);
}

const CAL_ID = 'test-calendar@group.calendar.google.com';

// ─── Section 1: parseTimeRange ────────────────────────────────────────────────

section('Section: parseTimeRange');

await test('HH:MM-HH:MM を解析できる', () => {
  const r = parseTimeRange('スタジオ業務 (15:00-19:30)');
  assert.deepEqual(r, { startH: 15, startM: 0, endH: 19, endM: 30 });
});

await test('全角コロン HH：MM〜HH：MM を解析できる', () => {
  const r = parseTimeRange('10：00〜18：30');
  assert.deepEqual(r, { startH: 10, startM: 0, endH: 18, endM: 30 });
});

await test('HH時〜HH時（漢字）を解析できる', () => {
  const r = parseTimeRange('13時〜19時30分');
  assert.deepEqual(r, { startH: 13, startM: 0, endH: 19, endM: 30 });
});

await test('開始時刻のみ（"13：00-"）は null を返す', () => {
  const r = parseTimeRange('13：00-');
  assert.strictEqual(r, null, '開始時刻のみの場合はnullが期待される');
});

await test('null を渡すと null を返す', () => {
  assert.strictEqual(parseTimeRange(null), null);
});

await test('時刻が含まれないテキストは null を返す', () => {
  assert.strictEqual(parseTimeRange('ロケ 音声業務'), null);
});

// ─── Section 2: buildEventFromWorkRecord ─────────────────────────────────────

section('Section: buildEventFromWorkRecord');

await test('date が null の場合 null を返す', () => {
  assert.strictEqual(buildEventFromWorkRecord({ date: null }), null);
});

await test('終日イベント（is_full_day=1）を正しく生成する', () => {
  const ev = buildEventFromWorkRecord({
    id: 1, date: '2026-09-19', category: '音声仕事', work_type: '中継',
    content: 'エスコン 音声業務', client: '株式会社オーテック',
    income: 25000, expense: 0, invoice_status: '対象外', payment_status: '対象外',
    memo: null, is_full_day: 1,
  });
  assert.ok(ev, 'イベントが生成されること');
  assert.strictEqual(ev.start?.date, '2026-09-19');
  assert.strictEqual(ev.end?.date,   '2026-09-20');
  assert.strictEqual(ev.start?.dateTime, undefined);
});

await test('時間指定イベント（is_full_day=0 + 時刻範囲あり）を正しく生成する', () => {
  const ev = buildEventFromWorkRecord({
    id: 2, date: '2026-08-25', category: '音声仕事', work_type: 'STUDIO',
    content: 'UHB みんテレ スタジオ業務 (15:00-19:30)', client: '株式会社オーテック',
    income: 14500, expense: 500, invoice_status: '請求済', payment_status: '入金済',
    memo: '請求書 2026-09 から自動反映', is_full_day: 0,
  });
  assert.ok(ev);
  assert.ok(ev.start?.dateTime?.includes('T15:00:00'), 'start が 15:00 であること');
  assert.ok(ev.end?.dateTime?.includes('T19:30:00'),   'end が 19:30 であること');
});

await test('時間指定イベントのsummaryから時刻 (HH:MM-HH:MM) が除去される', () => {
  const ev = buildEventFromWorkRecord({
    id: 3, date: '2026-08-25', category: '音声仕事', work_type: 'STUDIO',
    content: 'UHB みんテレ スタジオ業務 (15:00-19:30)', client: '株式会社オーテック',
    income: 0, expense: 0, invoice_status: '対象外', payment_status: '対象外',
    memo: null, is_full_day: 0,
  });
  assert.ok(!ev.summary.includes('(15:00'), `summaryに時刻が残っている: ${ev.summary}`);
  assert.ok(!ev.summary.includes('15:00-'), `summaryに時刻が残っている: ${ev.summary}`);
});

await test('work_type がない場合プレフィックスなしの summary になる', () => {
  const ev = buildEventFromWorkRecord({
    id: 4, date: '2026-09-01', category: '音声仕事', work_type: null,
    content: '単発業務', client: null,
    income: 0, expense: 0, invoice_status: '対象外', payment_status: '対象外',
    memo: null, is_full_day: 1,
  });
  assert.strictEqual(ev.summary, '単発業務');
});

await test('content が空の場合 summary が（内容未入力）になる', () => {
  const ev = buildEventFromWorkRecord({
    id: 5, date: '2026-09-01', category: '音声仕事', work_type: null,
    content: '', client: null,
    income: 0, expense: 0, invoice_status: '対象外', payment_status: '対象外',
    memo: null, is_full_day: 1,
  });
  assert.strictEqual(ev.summary, '（内容未入力）');
});

await test('翌日の end.date が正しく計算される（月末）', () => {
  const ev = buildEventFromWorkRecord({
    id: 6, date: '2026-09-30',
    category: '音声仕事', work_type: null, content: '月末業務', client: null,
    income: 0, expense: 0, invoice_status: '対象外', payment_status: '対象外',
    memo: null, is_full_day: 1,
  });
  assert.strictEqual(ev.end?.date, '2026-10-01');
});

// ─── Section 3: 金銭情報が含まれないことの確認 ──────────────────────────────

section('Section: 金銭情報保護');

await test('income・expense・invoice_status・payment_status が イベントに含まれない', () => {
  const ev = buildEventFromWorkRecord({
    id: 7, date: '2026-09-01', category: '音声仕事', work_type: '中継',
    content: '業務内容', client: '取引先A',
    income: 99999, expense: 1234, invoice_status: '請求済', payment_status: '入金済',
    memo: '請求書 2026-09 から自動反映 / 源泉徴収 / 売上 / 交通費',
    is_full_day: 1,
  });
  const json = JSON.stringify(ev);
  const forbidden = ['99999','1234','請求済','入金済','源泉','売上','交通費','請求書'];
  for (const word of forbidden) {
    assert.ok(!json.includes(word), `"${word}" がイベントデータに含まれている`);
  }
});

await test('memo フィールドはイベントの description に含まれない', () => {
  const ev = buildEventFromWorkRecord({
    id: 8, date: '2026-09-01', category: '音声仕事', work_type: null,
    content: '業務', client: null,
    income: 0, expense: 0, invoice_status: '対象外', payment_status: '対象外',
    memo: '請求書 202408-007 から自動反映',
    is_full_day: 1,
  });
  assert.ok(!ev.description.includes('請求書'), 'memoの内容がdescriptionに混入している');
});

await test('extendedProperties に jarvis_source と work_record_id が設定される', () => {
  const ev = buildEventFromWorkRecord({
    id: 42, date: '2026-09-01', category: '音声仕事', work_type: null,
    content: '業務', client: null,
    income: 0, expense: 0, invoice_status: '対象外', payment_status: '対象外',
    memo: null, is_full_day: 1,
  });
  assert.strictEqual(ev.extendedProperties.private.jarvis_source,  'work_record');
  assert.strictEqual(ev.extendedProperties.private.work_record_id, '42');
});

// ─── Section 4: work_calendar_manager CRUD ───────────────────────────────────

section('Section: work_calendar_manager CRUD');

await test('upsertWorkCalendarLink で pending レコードを作成できる', () => {
  const db = setupDb();
  const id = insertRecord(db);
  const r  = upsertWorkCalendarLink(db, { workRecordId: id, googleCalendarId: CAL_ID });
  assert.strictEqual(r.action, 'created');
  const link = getWorkCalendarLink(db, id);
  assert.strictEqual(link.sync_status,        'pending');
  assert.strictEqual(link.google_event_id,    null);
  assert.strictEqual(link.error_count,        0);
});

await test('setWorkCalendarSynced で synced に更新され google_event_id が保存される', () => {
  const db = setupDb();
  const id = insertRecord(db);
  upsertWorkCalendarLink(db, { workRecordId: id, googleCalendarId: CAL_ID });
  setWorkCalendarSynced(db, id, CAL_ID, 'google-event-abc123');
  const link = getWorkCalendarLink(db, id);
  assert.strictEqual(link.sync_status,     'synced');
  assert.strictEqual(link.google_event_id, 'google-event-abc123');
  assert.ok(link.last_synced_at, 'last_synced_at が設定されること');
});

await test('setWorkCalendarError で error に更新され error_count がインクリメントされる', () => {
  const db = setupDb();
  const id = insertRecord(db);
  upsertWorkCalendarLink(db, { workRecordId: id, googleCalendarId: CAL_ID });
  setWorkCalendarError(db, id, CAL_ID, 'HTTP 403: Forbidden');
  const link = getWorkCalendarLink(db, id);
  assert.strictEqual(link.sync_status,    'error');
  assert.strictEqual(link.error_message,  'HTTP 403: Forbidden');
  assert.strictEqual(link.error_count,    1);
  // 再度エラー → error_count が 2 になる
  setWorkCalendarError(db, id, CAL_ID, 'HTTP 500');
  const link2 = getWorkCalendarLink(db, id);
  assert.strictEqual(link2.error_count, 2);
});

await test('setWorkCalendarOrphaned で orphaned に更新される', () => {
  const db = setupDb();
  const id = insertRecord(db);
  upsertWorkCalendarLink(db, { workRecordId: id, googleCalendarId: CAL_ID, syncStatus: 'synced', googleEventId: 'ev1' });
  setWorkCalendarOrphaned(db, id);
  const link = getWorkCalendarLink(db, id);
  assert.strictEqual(link.sync_status, 'orphaned');
});

await test('getPendingWorkCalendarLinks が pending のみ返す', () => {
  const db  = setupDb();
  const id1 = insertRecord(db, { date: '2026-09-01' });
  const id2 = insertRecord(db, { date: '2026-09-02' });
  upsertWorkCalendarLink(db, { workRecordId: id1, googleCalendarId: CAL_ID, syncStatus: 'pending' });
  upsertWorkCalendarLink(db, { workRecordId: id2, googleCalendarId: CAL_ID, syncStatus: 'synced', googleEventId: 'ev2' });
  const pending = getPendingWorkCalendarLinks(db);
  assert.strictEqual(pending.length, 1);
  assert.strictEqual(pending[0].work_record_id, id1);
});

await test('getErrorWorkCalendarLinks が maxRetries 以下のみ返す', () => {
  const db  = setupDb();
  const id1 = insertRecord(db, { date: '2026-09-01' });
  const id2 = insertRecord(db, { date: '2026-09-02' });
  upsertWorkCalendarLink(db, { workRecordId: id1, googleCalendarId: CAL_ID, syncStatus: 'error', errorMessage: 'e1' });
  upsertWorkCalendarLink(db, { workRecordId: id2, googleCalendarId: CAL_ID, syncStatus: 'error', errorMessage: 'e2' });
  // id2 を 4回エラーにする（maxRetries=3 を超える）
  for (let i = 0; i < 4; i++) setWorkCalendarError(db, id2, CAL_ID, 'error');
  const errors = getErrorWorkCalendarLinks(db, 3);
  const ids = errors.map(r => r.work_record_id);
  assert.ok(ids.includes(id1),  'id1 (error_count=1) が含まれること');
  assert.ok(!ids.includes(id2), 'id2 (error_count>3) が除外されること');
});

await test('getWorkCalendarLinkSummary が正しい件数を返す', () => {
  const db  = setupDb();
  const id1 = insertRecord(db, { date: '2026-09-01' });
  const id2 = insertRecord(db, { date: '2026-09-02' });
  const id3 = insertRecord(db, { date: '2026-09-03' });
  upsertWorkCalendarLink(db, { workRecordId: id1, googleCalendarId: CAL_ID, syncStatus: 'pending' });
  upsertWorkCalendarLink(db, { workRecordId: id2, googleCalendarId: CAL_ID, syncStatus: 'synced', googleEventId: 'ev2' });
  upsertWorkCalendarLink(db, { workRecordId: id3, googleCalendarId: CAL_ID, syncStatus: 'error', errorMessage: 'err' });
  const summary = getWorkCalendarLinkSummary(db);
  assert.strictEqual(summary.pending,  1);
  assert.strictEqual(summary.synced,   1);
  assert.strictEqual(summary.error,    1);
  assert.strictEqual(summary.orphaned, 0);
});

await test('work_records 削除時に work_calendar_links が CASCADE 削除される', () => {
  const db = setupDb();
  const id = insertRecord(db);
  upsertWorkCalendarLink(db, { workRecordId: id, googleCalendarId: CAL_ID });
  db.prepare('DELETE FROM work_records WHERE id = ?').run(id);
  const link = getWorkCalendarLink(db, id);
  assert.strictEqual(link, undefined, '紐づくリンクが削除されること');
});

// ─── Section 5: dryRunWorkPush ────────────────────────────────────────────────

section('Section: dryRunWorkPush');

await test('日付フィルタが機能し指定範囲内のレコードのみ返す', () => {
  const db  = setupDb();
  insertRecord(db, { date: '2026-08-01' });
  insertRecord(db, { date: '2026-09-01' });
  insertRecord(db, { date: '2026-09-15' });
  insertRecord(db, { date: '2026-10-01' });

  const r = dryRunWorkPush(db, { calendarId: CAL_ID, dateFrom: '2026-09-01', dateTo: '2026-09-30' });
  assert.strictEqual(r.createCount, 2, '9月の2件のみ対象となること');
  assert.strictEqual(r.updateCount, 0);
  assert.strictEqual(r.skipCount,   0);
});

await test('同期済み (synced) のレコードは update アクションになる', () => {
  const db  = setupDb();
  const id  = insertRecord(db, { date: '2026-09-01' });
  upsertWorkCalendarLink(db, {
    workRecordId: id, googleCalendarId: CAL_ID,
    googleEventId: 'existing-event-id', syncStatus: 'synced',
  });
  const r = dryRunWorkPush(db, { calendarId: CAL_ID });
  assert.strictEqual(r.updateCount, 1);
  assert.strictEqual(r.createCount, 0);
});

await test('date が null のレコードは skip になる', () => {
  const db = setupDb();
  // date='2026-09-01' の通常レコードと date=null を直接SQL INSERT
  db.exec(`
    INSERT INTO work_records (job_id, date, category, invoice_status, payment_status, is_full_day)
    VALUES ('test', '', '音声仕事', '対象外', '対象外', 1)
  `);
  const r = dryRunWorkPush(db, { calendarId: CAL_ID });
  assert.strictEqual(r.skipCount, 1);
});

await test('limit が機能する', () => {
  const db = setupDb();
  for (let i = 1; i <= 10; i++) {
    insertRecord(db, { date: `2026-09-${String(i).padStart(2,'0')}` });
  }
  const r = dryRunWorkPush(db, { calendarId: CAL_ID, limit: 3 });
  assert.strictEqual(r.items.length, 3);
});

// ─── Section 6: syncSingleWorkRecord（モック）────────────────────────────────

section('Section: syncSingleWorkRecord（APIモック）');

await test('新規作成: google_event_id が保存され sync_status=synced になる', async () => {
  const db = setupDb();
  const id = insertRecord(db, { date: '2026-09-19', content: 'テスト業務', work_type: '中継', is_full_day: 1 });

  const mockClient = {
    createEvent: async (_token, _calId, event) => ({ id: 'mock-event-id-001', summary: event.summary }),
    updateEvent: async () => { throw new Error('updateEvent は呼ばれてはいけない'); },
  };

  const result = await syncSingleWorkRecord(db, 'dummy-token', { calendarId: CAL_ID, workRecordId: id }, mockClient);

  assert.strictEqual(result.success,       true);
  assert.strictEqual(result.action,        'created');
  assert.strictEqual(result.googleEventId, 'mock-event-id-001');

  const link = getWorkCalendarLink(db, id);
  assert.strictEqual(link.sync_status,     'synced');
  assert.strictEqual(link.google_event_id, 'mock-event-id-001');
  assert.ok(link.last_synced_at, 'last_synced_at が設定されること');
});

await test('既存イベント更新: update が呼ばれ synced のまま維持される', async () => {
  const db = setupDb();
  const id = insertRecord(db, { date: '2026-09-19', content: 'テスト業務', work_type: '中継', is_full_day: 1 });
  upsertWorkCalendarLink(db, {
    workRecordId: id, googleCalendarId: CAL_ID,
    googleEventId: 'existing-event-id', syncStatus: 'synced',
  });

  const mockClient = {
    createEvent: async () => { throw new Error('createEvent は呼ばれてはいけない'); },
    updateEvent: async (_token, _calId, eventId, event) => ({ id: eventId }),
  };

  const result = await syncSingleWorkRecord(db, 'dummy-token', { calendarId: CAL_ID, workRecordId: id }, mockClient);

  assert.strictEqual(result.success, true);
  assert.strictEqual(result.action,  'updated');
  const link = getWorkCalendarLink(db, id);
  assert.strictEqual(link.sync_status, 'synced');
});

await test('Calendar API 失敗時: work_records は影響なく error が記録される', async () => {
  const db = setupDb();
  const id = insertRecord(db, { date: '2026-09-19' });

  const mockClient = {
    createEvent: async () => { throw new Error('HTTP 403: Forbidden'); },
    updateEvent: async () => { throw new Error('HTTP 403: Forbidden'); },
  };

  const result = await syncSingleWorkRecord(db, 'dummy-token', { calendarId: CAL_ID, workRecordId: id }, mockClient);

  assert.strictEqual(result.success,      false);
  assert.strictEqual(result.action,       'error');
  assert.ok(result.error.includes('403'), 'エラーメッセージが記録されること');

  // work_records は変更されていない
  const record = db.prepare('SELECT * FROM work_records WHERE id = ?').get(id);
  assert.ok(record, 'work_records レコードが残っていること');

  // work_calendar_links にエラーが記録されている
  const link = getWorkCalendarLink(db, id);
  assert.strictEqual(link.sync_status,   'error');
  assert.ok(link.error_message.includes('403'));
  assert.strictEqual(link.error_count,   1);
});

await test('存在しない work_record_id を渡すとエラーを返す', async () => {
  const db = setupDb();
  const mockClient = { createEvent: async () => ({ id: 'ev' }) };
  const result = await syncSingleWorkRecord(db, 'dummy-token', { calendarId: CAL_ID, workRecordId: 9999 }, mockClient);
  assert.strictEqual(result.success, false);
  assert.ok(result.error.includes('9999'));
});

// ─── Section 7: hookWorkCreated（APIモック）───────────────────────────────────

section('Section: hookWorkCreated（APIモック）');

await test('hookWorkCreated: 作成後に Calendar.createEvent が呼ばれ synced になる', async () => {
  const db = setupDb();
  const id = insertRecord(db, { date: '2026-10-01', content: 'テスト作成フック' });

  let createCalled = false;
  const mockClient = {
    calendarId:     CAL_ID,
    getAccessToken: async () => 'mock-token',
    createEvent:    async (_t, _c, event) => {
      createCalled = true;
      assert.ok(event.summary.includes('テスト作成フック'), 'summary にコンテンツが含まれる');
      return { id: 'hook-created-event-id' };
    },
    updateEvent: async () => { throw new Error('updateEvent は呼ばれてはいけない'); },
  };

  await hookWorkCreated(db, id, mockClient);

  assert.ok(createCalled, 'createEvent が呼ばれること');
  const link = getWorkCalendarLink(db, id);
  assert.strictEqual(link.sync_status,     'synced');
  assert.strictEqual(link.google_event_id, 'hook-created-event-id');
});

await test('hookWorkCreated: Calendar API エラー時は work_calendar_links に error を記録する', async () => {
  const db = setupDb();
  const id = insertRecord(db, { date: '2026-10-02' });

  const mockClient = {
    calendarId:     CAL_ID,
    getAccessToken: async () => 'mock-token',
    createEvent:    async () => { throw new Error('HTTP 503: Service Unavailable'); },
    updateEvent:    async () => { throw new Error('HTTP 503: Service Unavailable'); },
  };

  await hookWorkCreated(db, id, mockClient);

  const link = getWorkCalendarLink(db, id);
  assert.strictEqual(link.sync_status, 'error');
  assert.ok(link.error_message.includes('503'));

  // work_records は変更されていない
  const record = db.prepare('SELECT id FROM work_records WHERE id = ?').get(id);
  assert.ok(record, 'work_records レコードが残っていること');
});

await test('hookWorkCreated: calendarId が未設定の場合は Calendar を呼ばない', async () => {
  const db = setupDb();
  const id = insertRecord(db, { date: '2026-10-03' });

  let called = false;
  const mockClient = {
    calendarId:     '',  // 未設定
    getAccessToken: async () => { called = true; return 'mock-token'; },
    createEvent:    async () => { called = true; return { id: 'ev' }; },
  };

  await hookWorkCreated(db, id, mockClient);

  assert.ok(!called, 'calendarId 未設定時は API が呼ばれないこと');
  const link = getWorkCalendarLink(db, id);
  assert.ok(!link, 'リンクが作成されていないこと');
});

// ─── Section 8: hookWorkUpdated（APIモック）───────────────────────────────────

section('Section: hookWorkUpdated（APIモック）');

await test('hookWorkUpdated: 既存 synced リンクがある場合は updateEvent が呼ばれる', async () => {
  const db = setupDb();
  const id = insertRecord(db, { date: '2026-10-04', content: '更新前コンテンツ' });
  upsertWorkCalendarLink(db, {
    workRecordId: id, googleCalendarId: CAL_ID,
    googleEventId: 'existing-ev-id', syncStatus: 'synced',
  });

  let updateCalled = false;
  const mockClient = {
    calendarId:     CAL_ID,
    getAccessToken: async () => 'mock-token',
    createEvent:    async () => { throw new Error('createEvent は呼ばれてはいけない'); },
    updateEvent:    async (_t, _c, eventId, _e) => {
      updateCalled = true;
      assert.strictEqual(eventId, 'existing-ev-id');
      return { id: eventId };
    },
  };

  await hookWorkUpdated(db, id, mockClient);

  assert.ok(updateCalled, 'updateEvent が呼ばれること');
  const link = getWorkCalendarLink(db, id);
  assert.strictEqual(link.sync_status, 'synced');
  assert.strictEqual(link.google_event_id, 'existing-ev-id');
});

await test('hookWorkUpdated: 未同期レコードは createEvent にフォールバックする', async () => {
  const db = setupDb();
  const id = insertRecord(db, { date: '2026-10-05' });
  // リンクなし

  let createCalled = false;
  const mockClient = {
    calendarId:     CAL_ID,
    getAccessToken: async () => 'mock-token',
    createEvent:    async () => { createCalled = true; return { id: 'new-ev-id' }; },
    updateEvent:    async () => { throw new Error('updateEvent は呼ばれてはいけない'); },
  };

  await hookWorkUpdated(db, id, mockClient);

  assert.ok(createCalled, 'リンク未存在時は createEvent が呼ばれること');
  const link = getWorkCalendarLink(db, id);
  assert.strictEqual(link.sync_status, 'synced');
});

// ─── Section 9: hookWorkDeleted / getGoogleEventIdBeforeDelete ────────────────

section('Section: hookWorkDeleted / getGoogleEventIdBeforeDelete（APIモック）');

await test('getGoogleEventIdBeforeDelete: synced リンクがある場合は google_event_id を返す', () => {
  const db = setupDb();
  const id = insertRecord(db, { date: '2026-10-06' });
  upsertWorkCalendarLink(db, {
    workRecordId: id, googleCalendarId: CAL_ID,
    googleEventId: 'ev-to-delete', syncStatus: 'synced',
  });

  const eventId = getGoogleEventIdBeforeDelete(db, id);
  assert.strictEqual(eventId, 'ev-to-delete');
});

await test('getGoogleEventIdBeforeDelete: リンクがない場合は null を返す', () => {
  const db = setupDb();
  const id = insertRecord(db, { date: '2026-10-07' });

  const eventId = getGoogleEventIdBeforeDelete(db, id);
  assert.strictEqual(eventId, null);
});

await test('getGoogleEventIdBeforeDelete: error 状態のリンクは null を返す', () => {
  const db = setupDb();
  const id = insertRecord(db, { date: '2026-10-08' });
  upsertWorkCalendarLink(db, {
    workRecordId: id, googleCalendarId: CAL_ID,
    googleEventId: 'old-ev-id', syncStatus: 'error',
  });

  const eventId = getGoogleEventIdBeforeDelete(db, id);
  assert.strictEqual(eventId, null);
});

await test('hookWorkDeleted: 正常系 — deleteEvent が呼ばれ queue が done になる', async () => {
  const db = setupDb();
  let deletedEventId = null;
  const mockClient = {
    calendarId:     CAL_ID,
    getAccessToken: async () => 'mock-token',
    deleteEvent:    async (_t, _c, eventId) => { deletedEventId = eventId; },
  };

  await hookWorkDeleted(db, 'target-event-id', null, mockClient);

  assert.strictEqual(deletedEventId, 'target-event-id');
  const queue = getAllCalendarDeleteQueue(db);
  assert.strictEqual(queue.length, 1);
  assert.strictEqual(queue[0].status, 'done');
  assert.ok(queue[0].completed_at, 'completed_at が設定されること');
});

await test('hookWorkDeleted: googleEventId が null の場合は queue に追加せず API も呼ばない', async () => {
  const db = setupDb();
  let called = false;
  const mockClient = {
    calendarId:     CAL_ID,
    getAccessToken: async () => { called = true; return 'mock-token'; },
    deleteEvent:    async () => { called = true; },
  };

  await hookWorkDeleted(db, null, null, mockClient);

  assert.ok(!called, 'googleEventId=null の場合は API が呼ばれないこと');
  const queue = getAllCalendarDeleteQueue(db);
  assert.strictEqual(queue.length, 0, 'queue が空であること');
});

await test('hookWorkDeleted: 404/410 エラーは成功相当として queue が done になる', async () => {
  const db = setupDb();
  const mockClient = {
    calendarId:     CAL_ID,
    getAccessToken: async () => 'mock-token',
    deleteEvent:    async () => { throw new Error('Calendar API エラー: HTTP 404: Not Found'); },
  };

  await hookWorkDeleted(db, 'already-gone-event-id', null, mockClient);

  const queue = getAllCalendarDeleteQueue(db);
  assert.strictEqual(queue.length, 1);
  assert.strictEqual(queue[0].status, 'done', '404 は done 扱い');
});

await test('hookWorkDeleted: Calendar 削除が失敗しても例外を投げない', async () => {
  const db = setupDb();
  const mockClient = {
    calendarId:     CAL_ID,
    getAccessToken: async () => 'mock-token',
    deleteEvent:    async () => { throw new Error('HTTP 500: Internal Server Error'); },
  };

  await assert.doesNotReject(() => hookWorkDeleted(db, 'some-event-id', null, mockClient));
});

// ─── Section 10: Calendar 削除失敗 → Queue 保存 → リトライ ───────────────────

section('Section: Calendar削除失敗・Queue保存・リトライ（APIモック）');

await test('削除失敗時: work_records は削除される / queue に pending エントリが残る', async () => {
  const db = setupDb();
  const id = insertRecord(db, { date: '2026-10-10' });
  upsertWorkCalendarLink(db, {
    workRecordId: id, googleCalendarId: CAL_ID,
    googleEventId: 'fail-ev-id', syncStatus: 'synced',
  });

  // google_event_id を削除前に取得
  const googleEventId = getGoogleEventIdBeforeDelete(db, id);

  // work_records を削除（ON DELETE CASCADE でリンクも消える）
  db.prepare('DELETE FROM work_records WHERE id = ?').run(id);
  assert.ok(!db.prepare('SELECT id FROM work_records WHERE id = ?').get(id), 'work_records が削除されること');
  assert.ok(!db.prepare('SELECT id FROM work_calendar_links WHERE work_record_id = ?').get(id),
    'work_calendar_links が CASCADE 削除されること');

  // hookWorkDeleted (失敗させる)
  const mockClient = {
    calendarId:     CAL_ID,
    getAccessToken: async () => 'mock-token',
    deleteEvent:    async () => { throw new Error('HTTP 503: Service Unavailable'); },
  };
  await hookWorkDeleted(db, googleEventId, id, mockClient);

  // queue に pending で残っていること
  const queue = getPendingCalendarDeletes(db);
  assert.strictEqual(queue.length, 1, 'queue に1件残ること');
  assert.strictEqual(queue[0].google_event_id, 'fail-ev-id');
  assert.strictEqual(queue[0].google_calendar_id, CAL_ID);
  assert.strictEqual(queue[0].status, 'pending');
  assert.ok(queue[0].error_message.includes('503'), 'エラーメッセージが記録されること');
  assert.strictEqual(queue[0].retry_count, 1, 'retry_count が 1 になること');
});

await test('リトライ成功: pending queue が done になる', async () => {
  const db = setupDb();
  const id = insertRecord(db, { date: '2026-10-11' });
  upsertWorkCalendarLink(db, {
    workRecordId: id, googleCalendarId: CAL_ID,
    googleEventId: 'retry-ev-id', syncStatus: 'synced',
  });

  const googleEventId = getGoogleEventIdBeforeDelete(db, id);
  db.prepare('DELETE FROM work_records WHERE id = ?').run(id);

  // 1回目: 失敗
  const failClient = {
    calendarId: CAL_ID, getAccessToken: async () => 'tok',
    deleteEvent: async () => { throw new Error('HTTP 503: Service Unavailable'); },
  };
  await hookWorkDeleted(db, googleEventId, id, failClient);

  // pending が1件あること
  assert.strictEqual(getPendingCalendarDeletes(db).length, 1);

  // リトライ: 成功
  let retryCalled = false;
  const retryClient = {
    calendarId: CAL_ID, getAccessToken: async () => 'tok',
    deleteEvent: async () => { retryCalled = true; },
  };
  const results = await retryPendingCalendarDeletes(db, retryClient);

  assert.ok(retryCalled, 'リトライで deleteEvent が呼ばれること');
  assert.strictEqual(results.length, 1);
  assert.strictEqual(results[0].success, true);

  // done になっていること
  assert.strictEqual(getPendingCalendarDeletes(db).length, 0, 'pending が 0 になること');
  const allQueue = getAllCalendarDeleteQueue(db);
  assert.strictEqual(allQueue[0].status, 'done');
});

await test('リトライ時 404: 成功相当として queue が done になる', async () => {
  const db = setupDb();
  const id = insertRecord(db, { date: '2026-10-12' });
  upsertWorkCalendarLink(db, {
    workRecordId: id, googleCalendarId: CAL_ID,
    googleEventId: '404-retry-ev', syncStatus: 'synced',
  });

  const googleEventId = getGoogleEventIdBeforeDelete(db, id);
  db.prepare('DELETE FROM work_records WHERE id = ?').run(id);

  // 1回目: 503 失敗
  await hookWorkDeleted(db, googleEventId, id, {
    calendarId: CAL_ID, getAccessToken: async () => 'tok',
    deleteEvent: async () => { throw new Error('HTTP 503'); },
  });

  // リトライ: 404（すでに存在しない）
  const results = await retryPendingCalendarDeletes(db, {
    calendarId: CAL_ID, getAccessToken: async () => 'tok',
    deleteEvent: async () => { throw new Error('HTTP 404: Not Found'); },
  });

  assert.strictEqual(results[0].success, true);
  assert.strictEqual(results[0].reason, 'not_found');
  assert.strictEqual(getPendingCalendarDeletes(db).length, 0, '404 は done 扱いで pending から除外');
});

// ─── 結果 ────────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`結果: ${passed + failed} テスト中 ${passed} 成功, ${failed} 失敗`);
if (failed === 0) {
  console.log('すべてのテストが成功しました ✅');
} else {
  console.log('失敗したテストがあります ❌');
  process.exit(1);
}
