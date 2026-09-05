/**
 * jarvis/tests/test_work_calendar_pull_sync.js
 * Google Calendar → JARVIS 逆方向同期テスト (Phase 21)
 *
 * 実行: node tests/test_work_calendar_pull_sync.js
 *
 * - DatabaseSync + :memory: を使用（外部DB・実API呼び出しなし）
 * - Calendar API は全てモック
 * - テスト対象:
 *     calendar_import_candidate_manager CRUD /
 *     dryRunCalendarPull / scanCalendarCandidates
 */

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import {
  upsertCalendarImportCandidate,
  markAbsentCandidatesRemoved,
  updateCandidateStatus,
  getCalendarImportCandidate,
  getPendingCandidates,
  getCandidateSummary,
  getAllCandidates,
} from '../data/calendar_import_candidate_manager.js';

import {
  dryRunCalendarPull,
  scanCalendarCandidates,
} from '../sync/work_calendar_pull_sync.js';

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
      invoice_status TEXT    NOT NULL DEFAULT '対象外',
      payment_status TEXT    NOT NULL DEFAULT '対象外',
      memo           TEXT,
      created_at     TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
      is_full_day    INTEGER NOT NULL DEFAULT 0
    )
  `);
  db.exec(`
    CREATE TABLE work_calendar_links (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      work_record_id     INTEGER NOT NULL REFERENCES work_records(id) ON DELETE CASCADE,
      google_calendar_id TEXT    NOT NULL,
      google_event_id    TEXT,
      sync_status        TEXT    NOT NULL DEFAULT 'pending',
      error_message      TEXT,
      error_count        INTEGER NOT NULL DEFAULT 0,
      last_attempted_at  TEXT,
      last_synced_at     TEXT,
      created_at         TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
      updated_at         TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
      UNIQUE(work_record_id)
    )
  `);
  db.exec(`
    CREATE TABLE calendar_import_candidates (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      google_calendar_id  TEXT    NOT NULL,
      google_event_id     TEXT    NOT NULL,
      event_date          TEXT,
      start_datetime      TEXT,
      end_datetime        TEXT,
      is_all_day          INTEGER NOT NULL DEFAULT 0,
      title               TEXT,
      description         TEXT,
      event_updated_at    TEXT,
      etag                TEXT,
      recurring_event_id  TEXT,
      duplicate_work_id   INTEGER,
      duplicate_reason    TEXT,
      status              TEXT    NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending','imported','skipped','ignored','removed')),
      imported_work_id    INTEGER,
      scanned_at          TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
      last_seen_at        TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
      updated_at          TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
      UNIQUE(google_calendar_id, google_event_id)
    )
  `);
  return db;
}

const CAL_ID = 'test-calendar@group.calendar.google.com';

// モック Calendar イベントビルダー
function mockEvent({ id, date, title = 'テスト予定', description = null, jarvisSource = null, dateTime = null, recurringEventId = null, etag = 'etag-xxx' } = {}) {
  return {
    id,
    summary: title,
    description,
    etag,
    updated: '2026-09-01T00:00:00Z',
    ...(recurringEventId ? { recurringEventId } : {}),
    start: dateTime ? { dateTime } : { date },
    end:   dateTime ? { dateTime: dateTime.replace('T10:', 'T12:') } : { date },
    ...(jarvisSource ? { extendedProperties: { private: { jarvis_source: jarvisSource } } } : {}),
  };
}

// モック listEvents
function mockListEvents(events) {
  return async (_token, _calId, _opts) => ({ items: events, nextPageToken: null });
}

// ─── Section 1: calendar_import_candidate_manager CRUD ───────────────────────

section('Section: calendar_import_candidate_manager CRUD');

await test('upsertCalendarImportCandidate: 新規レコードを pending で作成できる', () => {
  const db = setupDb();
  upsertCalendarImportCandidate(db, {
    googleCalendarId: CAL_ID,
    googleEventId:    'ev-001',
    eventDate:        '2026-09-10',
    title:            'テスト予定',
    isAllDay:         1,
  });

  const row = getCalendarImportCandidate(db, CAL_ID, 'ev-001');
  assert.ok(row, 'レコードが作成されること');
  assert.strictEqual(row.status,     'pending');
  assert.strictEqual(row.event_date, '2026-09-10');
  assert.strictEqual(row.title,      'テスト予定');
});

await test('upsertCalendarImportCandidate: 再スキャンで pending のまま上書きされる', () => {
  const db = setupDb();
  upsertCalendarImportCandidate(db, { googleCalendarId: CAL_ID, googleEventId: 'ev-002', title: '旧タイトル' });
  upsertCalendarImportCandidate(db, { googleCalendarId: CAL_ID, googleEventId: 'ev-002', title: '新タイトル' });

  const row = getCalendarImportCandidate(db, CAL_ID, 'ev-002');
  assert.strictEqual(row.title,  '新タイトル');
  assert.strictEqual(row.status, 'pending');

  const count = db.prepare('SELECT COUNT(*) AS cnt FROM calendar_import_candidates').get();
  assert.strictEqual(count.cnt, 1, 'レコードが重複しないこと');
});

await test('upsertCalendarImportCandidate: ignored の status は再スキャンで pending に戻らない', () => {
  const db = setupDb();
  upsertCalendarImportCandidate(db, { googleCalendarId: CAL_ID, googleEventId: 'ev-003', title: '定期予定' });
  updateCandidateStatus(db, 1, 'ignored');

  // 再スキャン
  upsertCalendarImportCandidate(db, { googleCalendarId: CAL_ID, googleEventId: 'ev-003', title: '定期予定 更新' });

  const row = getCalendarImportCandidate(db, CAL_ID, 'ev-003');
  assert.strictEqual(row.status, 'ignored', 'ignored は保護されること');
  assert.strictEqual(row.title,  '定期予定 更新', 'タイトルは更新されること');
});

await test('upsertCalendarImportCandidate: skipped の status も保護される', () => {
  const db = setupDb();
  upsertCalendarImportCandidate(db, { googleCalendarId: CAL_ID, googleEventId: 'ev-004' });
  updateCandidateStatus(db, 1, 'skipped');
  upsertCalendarImportCandidate(db, { googleCalendarId: CAL_ID, googleEventId: 'ev-004' });

  const row = getCalendarImportCandidate(db, CAL_ID, 'ev-004');
  assert.strictEqual(row.status, 'skipped');
});

await test('upsertCalendarImportCandidate: removed は次のスキャンで pending に戻る', () => {
  const db = setupDb();
  upsertCalendarImportCandidate(db, { googleCalendarId: CAL_ID, googleEventId: 'ev-005' });
  // 手動で removed にする（実際は markAbsentCandidatesRemoved が行う）
  db.prepare("UPDATE calendar_import_candidates SET status = 'removed' WHERE google_event_id = 'ev-005'").run();

  // 再スキャンで pending に戻ること
  upsertCalendarImportCandidate(db, { googleCalendarId: CAL_ID, googleEventId: 'ev-005' });
  const row = getCalendarImportCandidate(db, CAL_ID, 'ev-005');
  assert.strictEqual(row.status, 'pending', 'removed は次のスキャンで pending に戻ること');
});

await test('markAbsentCandidatesRemoved: スキャンで不在の pending 候補を removed にする', () => {
  const db = setupDb();
  upsertCalendarImportCandidate(db, { googleCalendarId: CAL_ID, googleEventId: 'ev-A' });
  upsertCalendarImportCandidate(db, { googleCalendarId: CAL_ID, googleEventId: 'ev-B' });
  upsertCalendarImportCandidate(db, { googleCalendarId: CAL_ID, googleEventId: 'ev-C' });

  // ev-A だけ今回スキャンで確認 → ev-B, ev-C が removed に
  const count = markAbsentCandidatesRemoved(db, CAL_ID, ['ev-A']);

  assert.strictEqual(count, 2);
  assert.strictEqual(getCalendarImportCandidate(db, CAL_ID, 'ev-A').status, 'pending');
  assert.strictEqual(getCalendarImportCandidate(db, CAL_ID, 'ev-B').status, 'removed');
  assert.strictEqual(getCalendarImportCandidate(db, CAL_ID, 'ev-C').status, 'removed');
});

await test('markAbsentCandidatesRemoved: ignored / skipped は removed にならない', () => {
  const db = setupDb();
  upsertCalendarImportCandidate(db, { googleCalendarId: CAL_ID, googleEventId: 'ev-D' });
  upsertCalendarImportCandidate(db, { googleCalendarId: CAL_ID, googleEventId: 'ev-E' });
  updateCandidateStatus(db, 1, 'ignored');
  updateCandidateStatus(db, 2, 'skipped');

  markAbsentCandidatesRemoved(db, CAL_ID, []);

  assert.strictEqual(getCalendarImportCandidate(db, CAL_ID, 'ev-D').status, 'ignored');
  assert.strictEqual(getCalendarImportCandidate(db, CAL_ID, 'ev-E').status, 'skipped');
});

await test('getCandidateSummary: status 別件数を正しく返す', () => {
  const db = setupDb();
  upsertCalendarImportCandidate(db, { googleCalendarId: CAL_ID, googleEventId: 'x1' });
  upsertCalendarImportCandidate(db, { googleCalendarId: CAL_ID, googleEventId: 'x2' });
  upsertCalendarImportCandidate(db, { googleCalendarId: CAL_ID, googleEventId: 'x3' });
  updateCandidateStatus(db, 2, 'skipped');
  updateCandidateStatus(db, 3, 'ignored');

  const s = getCandidateSummary(db, CAL_ID);
  assert.strictEqual(s.pending, 1);
  assert.strictEqual(s.skipped, 1);
  assert.strictEqual(s.ignored, 1);
  assert.strictEqual(s.removed, 0);
});

// ─── Section 2: dryRunCalendarPull ───────────────────────────────────────────

section('Section: dryRunCalendarPull（APIモック）');

await test('dryRunCalendarPull: JARVIS由来イベントを除外して候補を返す', async () => {
  const db = setupDb();
  const events = [
    mockEvent({ id: 'jarvis-ev', date: '2026-09-15', jarvisSource: 'work_record' }),
    mockEvent({ id: 'external-ev', date: '2026-09-16', title: '外部予定' }),
  ];

  const result = await dryRunCalendarPull(db, 'mock-token', { calendarId: CAL_ID }, {
    listEvents: mockListEvents(events),
  });

  assert.strictEqual(result.totalCount,      2);
  assert.strictEqual(result.jarvisCount,      1);
  assert.strictEqual(result.candidateCount,   1);
  assert.strictEqual(result.candidates[0].googleEventId, 'external-ev');
  assert.strictEqual(result.candidates[0].title,         '外部予定');
});

await test('dryRunCalendarPull: work_calendar_links に紐付き済みのイベントを除外する', async () => {
  const db = setupDb();
  // リンク済みレコードを追加
  db.prepare('INSERT INTO work_records (date, category) VALUES (?, ?)').run('2026-09-17', '音声仕事');
  db.prepare('INSERT INTO work_calendar_links (work_record_id, google_calendar_id, google_event_id, sync_status) VALUES (?, ?, ?, ?)').run(1, CAL_ID, 'linked-ev', 'synced');

  const events = [
    mockEvent({ id: 'linked-ev', date: '2026-09-17' }),
    mockEvent({ id: 'unlinked-ev', date: '2026-09-18', title: '未紐付け予定' }),
  ];

  const result = await dryRunCalendarPull(db, 'mock-token', { calendarId: CAL_ID }, {
    listEvents: mockListEvents(events),
  });

  assert.strictEqual(result.linkedCount,    1);
  assert.strictEqual(result.candidateCount, 1);
  assert.strictEqual(result.candidates[0].googleEventId, 'unlinked-ev');
});

await test('dryRunCalendarPull: 同日の work_records がある場合は重複候補を警告する', async () => {
  const db = setupDb();
  db.prepare('INSERT INTO work_records (date, category, work_type, content) VALUES (?, ?, ?, ?)').run(
    '2026-09-20', '音声仕事', '中継', 'スタジオ業務'
  );

  const events = [mockEvent({ id: 'dup-ev', date: '2026-09-20', title: '外部予定（同日）' })];

  const result = await dryRunCalendarPull(db, 'mock-token', { calendarId: CAL_ID }, {
    listEvents: mockListEvents(events),
  });

  const c = result.candidates[0];
  assert.ok(c.duplicateWorkId, '重複候補の work_record_id が設定されること');
  assert.ok(c.duplicateReason?.includes('同日'), '重複理由が記録されること');
});

await test('dryRunCalendarPull: 候補なしの場合は candidateCount=0', async () => {
  const db = setupDb();
  const events = [mockEvent({ id: 'j-ev', date: '2026-09-21', jarvisSource: 'work_record' })];

  const result = await dryRunCalendarPull(db, 'mock-token', { calendarId: CAL_ID }, {
    listEvents: mockListEvents(events),
  });

  assert.strictEqual(result.candidateCount, 0);
  assert.deepEqual(result.candidates, []);
});

await test('dryRunCalendarPull: DB 書き込みなし（dry-run 後に candidates テーブルが空）', async () => {
  const db = setupDb();
  const events = [mockEvent({ id: 'dry-ev', date: '2026-09-22', title: 'dry-run予定' })];

  await dryRunCalendarPull(db, 'mock-token', { calendarId: CAL_ID }, {
    listEvents: mockListEvents(events),
  });

  const count = db.prepare('SELECT COUNT(*) AS cnt FROM calendar_import_candidates').get();
  assert.strictEqual(count.cnt, 0, 'dry-run では DB に書き込まないこと');
});

await test('dryRunCalendarPull: 時間指定イベントの startDatetime / endDatetime が正しく設定される', async () => {
  const db = setupDb();
  const events = [mockEvent({ id: 'timed-ev', dateTime: '2026-09-23T10:00:00+09:00', title: '時間指定' })];

  const result = await dryRunCalendarPull(db, 'mock-token', { calendarId: CAL_ID }, {
    listEvents: mockListEvents(events),
  });

  const c = result.candidates[0];
  assert.strictEqual(c.isAllDay,      0);
  assert.strictEqual(c.eventDate,     '2026-09-23');
  assert.ok(c.startDatetime?.includes('T10:00'), '開始時刻が含まれること');
});

// ─── Section 3: scanCalendarCandidates ───────────────────────────────────────

section('Section: scanCalendarCandidates（APIモック）');

await test('scanCalendarCandidates: 候補を DB に UPSERT する', async () => {
  const db = setupDb();
  const events = [
    mockEvent({ id: 'scan-ev-1', date: '2026-10-01', title: 'スキャン予定A' }),
    mockEvent({ id: 'scan-ev-2', date: '2026-10-02', title: 'スキャン予定B' }),
  ];

  const result = await scanCalendarCandidates(db, 'mock-token', { calendarId: CAL_ID }, {
    listEvents: mockListEvents(events),
  });

  assert.strictEqual(result.upsertedCount, 2);

  const all = getAllCandidates(db);
  assert.strictEqual(all.length, 2);
  assert.strictEqual(all[0].google_event_id, 'scan-ev-1');
  assert.strictEqual(all[0].status, 'pending');
});

await test('scanCalendarCandidates: JARVIS由来は UPSERT しない', async () => {
  const db = setupDb();
  const events = [
    mockEvent({ id: 'jarvis-ev', date: '2026-10-03', jarvisSource: 'work_record' }),
    mockEvent({ id: 'ext-ev',    date: '2026-10-04', title: '外部' }),
  ];

  const result = await scanCalendarCandidates(db, 'mock-token', { calendarId: CAL_ID }, {
    listEvents: mockListEvents(events),
  });

  assert.strictEqual(result.upsertedCount, 1);
  assert.strictEqual(result.jarvisCount,   1);
  assert.strictEqual(getAllCandidates(db).length, 1);
});

await test('scanCalendarCandidates: 再スキャンで ignored の status が保護される', async () => {
  const db = setupDb();
  const events1 = [mockEvent({ id: 'ig-ev', date: '2026-10-05', title: '定期予定' })];
  await scanCalendarCandidates(db, 'mock-token', { calendarId: CAL_ID }, { listEvents: mockListEvents(events1) });

  // ignored に変更
  const row = getAllCandidates(db)[0];
  updateCandidateStatus(db, row.id, 'ignored');

  // 再スキャン
  await scanCalendarCandidates(db, 'mock-token', { calendarId: CAL_ID }, { listEvents: mockListEvents(events1) });

  const updated = getAllCandidates(db)[0];
  assert.strictEqual(updated.status, 'ignored', '再スキャンで ignored が保護されること');
});

await test('scanCalendarCandidates: 不在イベントは pending → removed になる', async () => {
  const db = setupDb();
  // 1回目のスキャン: 2件
  const events1 = [
    mockEvent({ id: 'kept-ev',   date: '2026-10-06' }),
    mockEvent({ id: 'gone-ev',   date: '2026-10-07' }),
  ];
  await scanCalendarCandidates(db, 'mock-token', { calendarId: CAL_ID }, { listEvents: mockListEvents(events1) });

  // 2回目のスキャン: gone-ev が消えた
  const events2 = [mockEvent({ id: 'kept-ev', date: '2026-10-06' })];
  const result = await scanCalendarCandidates(db, 'mock-token', { calendarId: CAL_ID }, { listEvents: mockListEvents(events2) });

  assert.strictEqual(result.removedCount, 1);
  assert.strictEqual(getCalendarImportCandidate(db, CAL_ID, 'gone-ev').status,  'removed');
  assert.strictEqual(getCalendarImportCandidate(db, CAL_ID, 'kept-ev').status,  'pending');
});

await test('scanCalendarCandidates: summary が正しく返される', async () => {
  const db = setupDb();
  const events = [mockEvent({ id: 's1', date: '2026-10-08' }), mockEvent({ id: 's2', date: '2026-10-09' })];
  const result = await scanCalendarCandidates(db, 'mock-token', { calendarId: CAL_ID }, { listEvents: mockListEvents(events) });

  assert.strictEqual(result.summary.pending,  2);
  assert.strictEqual(result.summary.imported, 0);
  assert.strictEqual(result.summary.removed,  0);
});

await test('scanCalendarCandidates: 繰り返しイベントの recurring_event_id が保存される', async () => {
  const db = setupDb();
  const events = [mockEvent({ id: 'rec-ev', date: '2026-10-10', recurringEventId: 'rec-series-id' })];
  await scanCalendarCandidates(db, 'mock-token', { calendarId: CAL_ID }, { listEvents: mockListEvents(events) });

  const row = getCalendarImportCandidate(db, CAL_ID, 'rec-ev');
  assert.strictEqual(row.recurring_event_id, 'rec-series-id');
});

await test('scanCalendarCandidates: work_records への INSERT は行われない', async () => {
  const db = setupDb();
  const events = [mockEvent({ id: 'no-insert-ev', date: '2026-10-11', title: 'INSERTしてはいけない' })];
  await scanCalendarCandidates(db, 'mock-token', { calendarId: CAL_ID }, { listEvents: mockListEvents(events) });

  const count = db.prepare('SELECT COUNT(*) AS cnt FROM work_records').get();
  assert.strictEqual(count.cnt, 0, 'work_records への INSERT がないこと');
});

// ─── Section 4: 期間フィルタ・API失敗・ページネーション ──────────────────────

section('Section: 期間フィルタ・API失敗保護・ページネーション');

await test('markAbsentCandidatesRemoved: 期間外の pending 候補は removed にならない', () => {
  const db = setupDb();
  // 期間内 (2026-10)
  upsertCalendarImportCandidate(db, { googleCalendarId: CAL_ID, googleEventId: 'in-range',  eventDate: '2026-10-15' });
  // 期間外 (2026-09)
  upsertCalendarImportCandidate(db, { googleCalendarId: CAL_ID, googleEventId: 'out-range', eventDate: '2026-09-01' });

  // 期間内スキャン: in-range が不在（seen = []）
  const count = markAbsentCandidatesRemoved(db, CAL_ID, [], {
    dateFrom: '2026-10-01',
    dateTo:   '2026-10-31',
  });

  assert.strictEqual(count, 1);
  assert.strictEqual(getCalendarImportCandidate(db, CAL_ID, 'in-range').status,  'removed');
  assert.strictEqual(getCalendarImportCandidate(db, CAL_ID, 'out-range').status, 'pending', '期間外は removed にならない');
});

await test('markAbsentCandidatesRemoved: event_date が NULL の候補は期間指定時に removed にならない', () => {
  const db = setupDb();
  upsertCalendarImportCandidate(db, { googleCalendarId: CAL_ID, googleEventId: 'no-date', eventDate: null });

  markAbsentCandidatesRemoved(db, CAL_ID, [], { dateFrom: '2026-10-01', dateTo: '2026-10-31' });

  assert.strictEqual(getCalendarImportCandidate(db, CAL_ID, 'no-date').status, 'pending',
    'event_date NULL は期間フィルタ時に removed にならない');
});

await test('markAbsentCandidatesRemoved: 期間指定なしの場合は event_date NULL の候補も対象', () => {
  const db = setupDb();
  upsertCalendarImportCandidate(db, { googleCalendarId: CAL_ID, googleEventId: 'null-date', eventDate: null });

  markAbsentCandidatesRemoved(db, CAL_ID, []);  // 期間なし

  assert.strictEqual(getCalendarImportCandidate(db, CAL_ID, 'null-date').status, 'removed',
    '期間指定なしは NULL 日付も removed 対象');
});

await test('scanCalendarCandidates: 期間指定スキャンで期間外の pending 候補は removed にならない', async () => {
  const db = setupDb();

  // 期間外候補を事前に DB に登録
  upsertCalendarImportCandidate(db, {
    googleCalendarId: CAL_ID, googleEventId: 'old-ev',
    eventDate: '2026-08-01', title: '期間外の古い候補',
  });

  // 期間: 2026-10 のみ対象。期間内に新規イベントあり
  const events = [mockEvent({ id: 'oct-ev', date: '2026-10-20', title: '10月の予定' })];
  const result = await scanCalendarCandidates(db, 'mock-token', {
    calendarId: CAL_ID,
    timeMin: '2026-10-01T00:00:00+09:00',
    timeMax: '2026-10-31T23:59:59+09:00',
  }, { listEvents: mockListEvents(events) });

  assert.strictEqual(result.removedCount, 0, '期間外の候補は removed にならない');
  assert.strictEqual(getCalendarImportCandidate(db, CAL_ID, 'old-ev').status,  'pending', '期間外は pending のまま');
  assert.strictEqual(getCalendarImportCandidate(db, CAL_ID, 'oct-ev').status,  'pending', '期間内の新規は pending');
});

await test('scanCalendarCandidates: API失敗時は removed 判定を実行しない', async () => {
  const db = setupDb();

  // 既存の pending 候補
  upsertCalendarImportCandidate(db, { googleCalendarId: CAL_ID, googleEventId: 'safe-ev', eventDate: '2026-11-01' });

  // API が失敗するモック（2ページ目で失敗を模擬）
  let page = 0;
  const failingListEvents = async () => {
    page++;
    if (page === 1) return { items: [mockEvent({ id: 'page1-ev', date: '2026-11-02' })], nextPageToken: 'next' };
    throw new Error('HTTP 500: Internal Server Error');
  };

  await assert.rejects(
    () => scanCalendarCandidates(db, 'mock-token', { calendarId: CAL_ID }, { listEvents: failingListEvents }),
    /500/,
    'API 失敗時は例外を投げること'
  );

  // safe-ev は removed にならず pending のまま
  assert.strictEqual(
    getCalendarImportCandidate(db, CAL_ID, 'safe-ev').status, 'pending',
    'API 失敗時は既存候補の status が変わらないこと'
  );
});

await test('scanCalendarCandidates: 複数ページを全取得してから処理する', async () => {
  const db = setupDb();

  let callCount = 0;
  const pagedListEvents = async (_token, _calId, { pageToken } = {}) => {
    callCount++;
    if (!pageToken) {
      return { items: [mockEvent({ id: 'page1-ev1', date: '2026-12-01' }), mockEvent({ id: 'page1-ev2', date: '2026-12-02' })], nextPageToken: 'token-p2' };
    } else {
      return { items: [mockEvent({ id: 'page2-ev1', date: '2026-12-03' })], nextPageToken: null };
    }
  };

  const result = await scanCalendarCandidates(db, 'mock-token', { calendarId: CAL_ID }, {
    listEvents: pagedListEvents,
  });

  assert.strictEqual(callCount, 2, 'listEvents が2ページ分呼ばれること');
  assert.strictEqual(result.upsertedCount, 3, '2ページ分の全イベントが処理されること');
  assert.strictEqual(getAllCandidates(db).length, 3);
});

await test('scanCalendarCandidates: ページネーション全完了後に removed 判定を実行する', async () => {
  const db = setupDb();

  // 事前に 'will-be-absent' を DB に登録
  upsertCalendarImportCandidate(db, {
    googleCalendarId: CAL_ID, googleEventId: 'will-be-absent', eventDate: '2026-12-10',
  });

  // ページ1: 2件（absent は含まない）
  // ページ2: 1件（absent は含まない）
  const pagedListEvents = async (_token, _calId, { pageToken } = {}) => {
    if (!pageToken) {
      return { items: [mockEvent({ id: 'p1-a', date: '2026-12-11' })], nextPageToken: 'tok' };
    } else {
      return { items: [mockEvent({ id: 'p2-a', date: '2026-12-12' })], nextPageToken: null };
    }
  };

  const result = await scanCalendarCandidates(db, 'mock-token', { calendarId: CAL_ID }, {
    listEvents: pagedListEvents,
  });

  assert.strictEqual(result.removedCount, 1, 'absent は全ページ取得後に removed になること');
  assert.strictEqual(getCalendarImportCandidate(db, CAL_ID, 'will-be-absent').status, 'removed');
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
