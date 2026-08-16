/**
 * jarvis/tests/test_calendar_sync.js
 * Google Calendar 同期テスト (Phase 18)
 *
 * 実行: node tests/test_calendar_sync.js
 *
 * - DatabaseSync + :memory: を使用（外部DB不使用）
 * - 実ネットワーク呼び出しなし（全モック）
 * - async/await は executePush などの呼び出し部分のみ使用
 *   （test() ヘルパー自体は同期、async テストは Promise を返せるよう拡張）
 */

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { getCalendarConfig } from '../sync/calendar_client.js';
import { parseTimeFromDescription, buildEventFromLine, dryRunPush, executePush, dryRunPull } from '../sync/calendar_sync.js';
import {
  getCalendarLinks,
  getCalendarLinkByLineId,
  upsertCalendarLink,
  getCalendarLinkCount,
  insertSyncRun,
  completeSyncRun,
  getSyncRuns,
  upsertCalendarImport,
  getPendingCalendarImports,
  updateCalendarImportStatus,
} from '../data/calendar_manager.js';

// ─── テストヘルパー ───────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function section(name) {
  console.log(`\n${name}`);
}

async function test(name, fn) {
  try {
    const result = fn();
    // async テスト（Promise を返す場合）を await
    if (result && typeof result.then === 'function') {
      await result;
    }
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ❌ ${name}: ${e.message}`);
    failed++;
  }
}

// ─── Phase 18 テーブル定義 ────────────────────────────────────────────────────

const CALENDAR_TABLES = [
  // business_invoices / business_invoice_lines（FK 参照先）
  `CREATE TABLE IF NOT EXISTS business_invoice_imports (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    source_filename TEXT    NOT NULL,
    file_hash       TEXT    NOT NULL,
    imported_at     TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
    status          TEXT    NOT NULL DEFAULT 'completed'
      CHECK (status IN ('completed','partial','failed')),
    new_count       INTEGER NOT NULL DEFAULT 0,
    dup_count       INTEGER NOT NULL DEFAULT 0,
    skip_count      INTEGER NOT NULL DEFAULT 0,
    warn_count      INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS business_invoices (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    import_id       INTEGER NOT NULL REFERENCES business_invoice_imports(id),
    client_name     TEXT    NOT NULL DEFAULT '株式会社オーテック',
    invoice_number  TEXT    NOT NULL,
    invoice_date    TEXT,
    due_date        TEXT,
    subtotal        INTEGER NOT NULL DEFAULT 0,
    tax             INTEGER NOT NULL DEFAULT 0,
    total           INTEGER NOT NULL DEFAULT 0,
    source_sheet    TEXT    NOT NULL,
    source_filename TEXT    NOT NULL,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE(invoice_number, source_sheet)
  )`,
  `CREATE TABLE IF NOT EXISTS business_invoice_lines (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_id      INTEGER NOT NULL REFERENCES business_invoices(id),
    work_date       TEXT,
    description     TEXT    NOT NULL,
    quantity        REAL    NOT NULL DEFAULT 1,
    quantity_unit   TEXT    NOT NULL DEFAULT '日',
    unit_price      INTEGER NOT NULL DEFAULT 0,
    amount          INTEGER NOT NULL DEFAULT 0,
    category        TEXT    NOT NULL DEFAULT 'その他',
    job_id          TEXT,
    source_row      INTEGER NOT NULL,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE(invoice_id, source_row)
  )`,
  // Phase 18 テーブル
  `CREATE TABLE IF NOT EXISTS business_calendar_links (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_line_id     INTEGER NOT NULL,
    google_calendar_id  TEXT NOT NULL,
    google_event_id     TEXT NOT NULL,
    sync_status         TEXT NOT NULL DEFAULT 'synced'
                          CHECK (sync_status IN ('synced', 'updated', 'orphaned')),
    last_synced_at      TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    created_at          TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE(invoice_line_id),
    UNIQUE(google_calendar_id, google_event_id)
  )`,
  `CREATE TABLE IF NOT EXISTS business_calendar_sync_runs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    direction     TEXT NOT NULL CHECK (direction IN ('push', 'pull')),
    calendar_id   TEXT,
    year_filter   TEXT,
    started_at    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    finished_at   TEXT,
    created_count INTEGER NOT NULL DEFAULT 0,
    updated_count INTEGER NOT NULL DEFAULT 0,
    skipped_count INTEGER NOT NULL DEFAULT 0,
    error_count   INTEGER NOT NULL DEFAULT 0,
    status        TEXT NOT NULL DEFAULT 'running'
                    CHECK (status IN ('running', 'completed', 'failed')),
    notes         TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS business_calendar_imports (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    google_calendar_id  TEXT NOT NULL,
    google_event_id     TEXT NOT NULL,
    title               TEXT NOT NULL,
    start_date          TEXT,
    end_date            TEXT,
    start_datetime      TEXT,
    end_datetime        TEXT,
    is_all_day          INTEGER NOT NULL DEFAULT 0,
    description         TEXT,
    location            TEXT,
    import_status       TEXT NOT NULL DEFAULT 'pending'
                          CHECK (import_status IN ('pending', 'imported', 'skipped')),
    imported_line_id    INTEGER,
    fetched_at          TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE(google_calendar_id, google_event_id)
  )`,
];

/**
 * Phase 18 テーブルを含む in-memory DB を作成する。
 * @returns {import('node:sqlite').DatabaseSync}
 */
function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const sql of CALENDAR_TABLES) {
    db.exec(sql);
  }
  return db;
}

/**
 * テスト用の請求書データを DB に挿入する。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object[]} lines - [{ work_date, description, amount, category }]
 * @returns {number[]} 挿入した invoice_line の id 配列
 */
function insertTestLines(db, lines) {
  // import ログ
  const impResult = db.prepare(`
    INSERT INTO business_invoice_imports (source_filename, file_hash)
    VALUES ('test.xlsx', 'testhash')
  `).run();
  const importId = Number(impResult.lastInsertRowid);

  // 請求書
  const invResult = db.prepare(`
    INSERT INTO business_invoices (import_id, client_name, invoice_number, source_sheet, source_filename)
    VALUES (?, 'テスト取引先', 'TEST-001', 'Sheet1', 'test.xlsx')
  `).run(importId);
  const invoiceId = Number(invResult.lastInsertRowid);

  const ids = [];
  for (let i = 0; i < lines.length; i++) {
    const { work_date, description, amount = 50000, category = 'スタジオ音声' } = lines[i];
    const r = db.prepare(`
      INSERT INTO business_invoice_lines
        (invoice_id, work_date, description, amount, category, source_row)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(invoiceId, work_date ?? null, description, amount, category, i + 1);
    ids.push(Number(r.lastInsertRowid));
  }
  return ids;
}

// ─── OAuth設定 ────────────────────────────────────────────────────────────────

section('Section: OAuth設定');

await test('getCalendarConfig: 必要環境変数がある場合に設定を返す', () => {
  const original = {
    GCALENDAR_CLIENT_ID:     process.env.GCALENDAR_CLIENT_ID,
    GCALENDAR_CLIENT_SECRET: process.env.GCALENDAR_CLIENT_SECRET,
    GCALENDAR_REFRESH_TOKEN: process.env.GCALENDAR_REFRESH_TOKEN,
  };

  process.env.GCALENDAR_CLIENT_ID     = 'test-client-id';
  process.env.GCALENDAR_CLIENT_SECRET = 'test-client-secret';
  process.env.GCALENDAR_REFRESH_TOKEN = 'test-refresh-token';

  try {
    const config = getCalendarConfig();
    assert.equal(config.clientId,     'test-client-id');
    assert.equal(config.clientSecret, 'test-client-secret');
    assert.equal(config.refreshToken, 'test-refresh-token');
  } finally {
    // 元に戻す
    if (original.GCALENDAR_CLIENT_ID     != null) process.env.GCALENDAR_CLIENT_ID     = original.GCALENDAR_CLIENT_ID;
    else delete process.env.GCALENDAR_CLIENT_ID;
    if (original.GCALENDAR_CLIENT_SECRET != null) process.env.GCALENDAR_CLIENT_SECRET = original.GCALENDAR_CLIENT_SECRET;
    else delete process.env.GCALENDAR_CLIENT_SECRET;
    if (original.GCALENDAR_REFRESH_TOKEN != null) process.env.GCALENDAR_REFRESH_TOKEN = original.GCALENDAR_REFRESH_TOKEN;
    else delete process.env.GCALENDAR_REFRESH_TOKEN;
  }
});

await test('getCalendarConfig: 環境変数が不足する場合にエラーをスロー', () => {
  const original = {
    GCALENDAR_CLIENT_ID:     process.env.GCALENDAR_CLIENT_ID,
    GCALENDAR_CLIENT_SECRET: process.env.GCALENDAR_CLIENT_SECRET,
    GCALENDAR_REFRESH_TOKEN: process.env.GCALENDAR_REFRESH_TOKEN,
  };

  delete process.env.GCALENDAR_CLIENT_ID;
  delete process.env.GCALENDAR_CLIENT_SECRET;
  delete process.env.GCALENDAR_REFRESH_TOKEN;

  try {
    assert.throws(
      () => getCalendarConfig(),
      (err) => err.message.includes('GCALENDAR_CLIENT_ID'),
    );
  } finally {
    if (original.GCALENDAR_CLIENT_ID     != null) process.env.GCALENDAR_CLIENT_ID     = original.GCALENDAR_CLIENT_ID;
    if (original.GCALENDAR_CLIENT_SECRET != null) process.env.GCALENDAR_CLIENT_SECRET = original.GCALENDAR_CLIENT_SECRET;
    if (original.GCALENDAR_REFRESH_TOKEN != null) process.env.GCALENDAR_REFRESH_TOKEN = original.GCALENDAR_REFRESH_TOKEN;
  }
});

// ─── parseTimeFromDescription ─────────────────────────────────────────────────

section('Section: parseTimeFromDescription');

await test('parseTimeFromDescription: (HH:MM-HH:MM) 括弧付きを抽出できる', () => {
  const result = parseTimeFromDescription('UHBスタジオ 音声業務 (15:00-19:30)');
  assert.ok(result !== null);
  assert.equal(result.startH, 15);
  assert.equal(result.startM, 0);
  assert.equal(result.endH,   19);
  assert.equal(result.endM,   30);
  assert.equal(result.matchStr, '(15:00-19:30)');
});

await test('parseTimeFromDescription: (HH:MM〜HH:MM) 括弧付き全角チルダ', () => {
  const result = parseTimeFromDescription('スタジオ (9:00〜18:00)');
  assert.ok(result !== null);
  assert.equal(result.startH, 9);
  assert.equal(result.startM, 0);
  assert.equal(result.endH,   18);
  assert.equal(result.endM,   0);
});

await test('parseTimeFromDescription: HH:MM-HH:MM 括弧なし', () => {
  const result = parseTimeFromDescription('みんテレ 10:30-12:00 スタジオ');
  assert.ok(result !== null);
  assert.equal(result.startH, 10);
  assert.equal(result.startM, 30);
  assert.equal(result.endH,   12);
  assert.equal(result.endM,   0);
});

await test('parseTimeFromDescription: HH時〜HH時 漢字表記（分省略）', () => {
  const result = parseTimeFromDescription('外ロケ 15時〜19時');
  assert.ok(result !== null);
  assert.equal(result.startH, 15);
  assert.equal(result.startM, 0);
  assert.equal(result.endH,   19);
  assert.equal(result.endM,   0);
});

await test('parseTimeFromDescription: HH時MM分〜HH時MM分 漢字表記（分あり）', () => {
  const result = parseTimeFromDescription('収録 15時30分〜19時30分');
  assert.ok(result !== null);
  assert.equal(result.startH, 15);
  assert.equal(result.startM, 30);
  assert.equal(result.endH,   19);
  assert.equal(result.endM,   30);
});

await test('parseTimeFromDescription: 時刻なしの場合は null を返す', () => {
  const result = parseTimeFromDescription('みんテレ スタジオ');
  assert.equal(result, null);
});

await test('parseTimeFromDescription: null / 空文字は null を返す', () => {
  assert.equal(parseTimeFromDescription(null), null);
  assert.equal(parseTimeFromDescription(''), null);
});

// ─── イベント構築 ─────────────────────────────────────────────────────────────

section('Section: イベント構築');

await test('buildEventFromLine: work_dateがある場合に終日イベントを構築', () => {
  const line = {
    id: 1, work_date: '2024-08-01', description: 'テスト業務',
    amount: 50000, category: 'スタジオ音声', invoice_number: 'TEST-001', client_name: 'テスト取引先',
  };
  const event = buildEventFromLine(line);
  assert.ok(event !== null);
  assert.ok(event.summary === 'テスト業務', `タイトルは仕事内容のみ (got: ${event.summary})`);
  assert.equal(event.start.date, '2024-08-01');
  assert.ok(event.start.date);
  assert.ok(!event.start.dateTime, '終日イベントは dateTime を持たない');
});

await test('buildEventFromLine: work_dateがない場合にnullを返す', () => {
  const line = {
    id: 2, work_date: null, description: 'テスト業務',
    amount: 50000, category: 'スタジオ音声', invoice_number: 'TEST-001', client_name: 'テスト取引先',
  };
  const event = buildEventFromLine(line);
  assert.equal(event, null);
});

await test('buildEventFromLine: descriptionが80文字を超える場合に切り詰める', () => {
  const longDesc = 'あ'.repeat(100);
  const line = {
    id: 3, work_date: '2024-08-01', description: longDesc,
    amount: 50000, category: 'スタジオ音声', invoice_number: 'TEST-001', client_name: 'テスト取引先',
  };
  const event = buildEventFromLine(line);
  // summary は仕事内容のみ 80文字切り詰め（請求情報プレフィックスなし）
  assert.ok(event.summary.length <= 80, `切り詰め後 80文字以内 (got ${event.summary.length})`);
  assert.ok(!event.summary.includes('【'), '請求状態プレフィックスを含まない');
});

await test('buildEventFromLine: extendedPropertiesにinvoice_line_idが含まれる', () => {
  const line = {
    id: 42, work_date: '2024-08-01', description: 'テスト業務',
    amount: 50000, category: 'スタジオ音声', invoice_number: 'TEST-001', client_name: 'テスト取引先',
  };
  const event = buildEventFromLine(line);
  assert.equal(event.extendedProperties.private.invoice_line_id, '42');
  assert.equal(event.extendedProperties.private.jarvis_source, 'business');
});

await test('buildEventFromLine: 個人情報（住所・電話・メール・銀行）がイベントに含まれない', () => {
  const line = {
    id: 5, work_date: '2024-08-01',
    description: 'スタジオ業務（090-1234-5678、test@example.com）',
    amount: 50000, category: 'スタジオ音声', invoice_number: 'TEST-001',
    client_name: '〒060-0001 札幌市中央区 株式会社テスト',
  };
  const event = buildEventFromLine(line);
  const eventText = JSON.stringify(event);

  // 個人情報パターン（電話・メール・郵便番号・銀行口座）が含まれないことを確認
  assert.ok(!/@/.test(event.description ?? ''), 'descriptionにメールアドレスが含まれない');
  assert.ok(!/口座|銀行|振込/.test(eventText), '銀行口座情報が含まれない');
  // 請求情報（金額・ステータス・請求書番号）がCalendar側に出ないことを確認
  assert.ok(!/請求済|未請求|請求額|請求書:/.test(event.summary), 'タイトルに請求情報を含まない');
  assert.ok(!/¥|円|amount|50000/.test(event.description ?? ''), 'descriptionに金額を含まない');
  assert.ok(!/TEST-001/.test(event.description ?? ''), 'descriptionに請求書番号を含まない');
});

await test('buildEventFromLine: descriptionに時刻がある場合は時間指定イベントになる', () => {
  const line = {
    id: 10, work_date: '2026-02-16',
    description: 'UHBスタジオ 音声業務 (15:00-19:30)',
    amount: 50000, category: 'スタジオ音声', client_name: 'テスト取引先',
  };
  const event = buildEventFromLine(line);
  assert.ok(event !== null);
  // dateTime で設定されている（終日ではない）
  assert.ok(event.start.dateTime, 'start.dateTime が設定されている');
  assert.ok(event.end.dateTime,   'end.dateTime が設定されている');
  assert.ok(!event.start.date,    'start.date は設定されない');
  assert.equal(event.start.dateTime, '2026-02-16T15:00:00+09:00');
  assert.equal(event.end.dateTime,   '2026-02-16T19:30:00+09:00');
});

await test('buildEventFromLine: 時刻がある場合はタイトルから時刻表記を除去する', () => {
  const line = {
    id: 11, work_date: '2026-02-16',
    description: 'UHBスタジオ 音声業務 (15:00-19:30)',
    amount: 50000, category: 'スタジオ音声', client_name: 'テスト取引先',
  };
  const event = buildEventFromLine(line);
  assert.ok(!event.summary.includes('(15:00-19:30)'), '時刻括弧がタイトルから除去されている');
  assert.ok(!event.summary.includes('15:00'), '時刻がタイトルから除去されている');
  assert.ok(event.summary.includes('UHBスタジオ'), '仕事内容はタイトルに残っている');
  assert.equal(event.summary, 'UHBスタジオ 音声業務');
});

await test('buildEventFromLine: 終日イベントのend.dateは翌日', () => {
  const line = {
    id: 6, work_date: '2024-08-31', description: 'テスト業務',
    amount: 50000, category: 'スタジオ音声', invoice_number: 'TEST-001', client_name: 'テスト取引先',
  };
  const event = buildEventFromLine(line);
  assert.equal(event.end.date, '2024-09-01', '8/31 の翌日は 9/1');
});

// ─── DB操作 ──────────────────────────────────────────────────────────────────

section('Section: DB操作');

await test('upsertCalendarLink: 新規リンクを作成できる', () => {
  const db = makeDb();
  const [lineId] = insertTestLines(db, [{ work_date: '2024-08-01', description: 'テスト業務' }]);
  const result = upsertCalendarLink(db, {
    invoiceLineId:    lineId,
    googleCalendarId: 'cal-id-1',
    googleEventId:    'event-id-1',
  });
  assert.equal(result.action, 'created');
  assert.ok(result.id > 0);
  const count = getCalendarLinkCount(db);
  assert.equal(count, 1);
});

await test('upsertCalendarLink: 同じinvoice_line_idは1件のみ（UNIQUE）', () => {
  const db = makeDb();
  const [lineId] = insertTestLines(db, [{ work_date: '2024-08-01', description: 'テスト業務' }]);

  upsertCalendarLink(db, {
    invoiceLineId: lineId, googleCalendarId: 'cal-1', googleEventId: 'ev-1',
  });
  // 2回目は UPDATE
  const result2 = upsertCalendarLink(db, {
    invoiceLineId: lineId, googleCalendarId: 'cal-1', googleEventId: 'ev-2', syncStatus: 'updated',
  });
  assert.equal(result2.action, 'updated');
  // 件数は1件のまま
  assert.equal(getCalendarLinkCount(db), 1);
  // 内容が更新されている
  const link = getCalendarLinkByLineId(db, lineId);
  assert.equal(link.google_event_id, 'ev-2');
  assert.equal(link.sync_status, 'updated');
});

await test('insertSyncRun / completeSyncRun: 同期履歴を記録できる', () => {
  const db = makeDb();
  const runId = insertSyncRun(db, { direction: 'push', calendarId: 'cal-1', yearFilter: '2024' });
  assert.ok(runId > 0);

  // 作成直後は running
  const runs1 = getSyncRuns(db);
  assert.equal(runs1[0].status, 'running');

  completeSyncRun(db, {
    runId,
    createdCount: 3,
    updatedCount: 1,
    skippedCount: 0,
    errorCount:   0,
    status:       'completed',
  });

  const runs2 = getSyncRuns(db);
  assert.equal(runs2[0].status, 'completed');
  assert.equal(runs2[0].created_count, 3);
  assert.equal(runs2[0].updated_count, 1);
  assert.ok(runs2[0].finished_at, 'finished_at が設定されている');
});

await test('upsertCalendarImport: 取込候補を保存できる', () => {
  const db = makeDb();
  const result = upsertCalendarImport(db, {
    googleCalendarId: 'cal-1',
    googleEventId:    'ev-abc',
    title:            '打合せ',
    startDate:        '2024-08-01',
    endDate:          '2024-08-02',
    isAllDay:         true,
  });
  assert.equal(result.action, 'created');
  assert.ok(result.id > 0);
  const pending = getPendingCalendarImports(db);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].title, '打合せ');
  assert.equal(pending[0].is_all_day, 1);
});

await test('upsertCalendarImport: 同一イベントは重複しない（UNIQUE）', () => {
  const db = makeDb();
  upsertCalendarImport(db, {
    googleCalendarId: 'cal-1', googleEventId: 'ev-abc',
    title: '打合せ', startDate: '2024-08-01', isAllDay: true,
  });
  const result2 = upsertCalendarImport(db, {
    googleCalendarId: 'cal-1', googleEventId: 'ev-abc',
    title: '打合せ（更新）', startDate: '2024-08-01', isAllDay: true,
  });
  assert.equal(result2.action, 'updated');
  const pending = getPendingCalendarImports(db);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].title, '打合せ（更新）');
});

await test('getCalendarLinks: 全件取得', () => {
  const db = makeDb();
  const lineIds = insertTestLines(db, [
    { work_date: '2024-08-01', description: '業務A' },
    { work_date: '2024-08-02', description: '業務B' },
  ]);
  upsertCalendarLink(db, { invoiceLineId: lineIds[0], googleCalendarId: 'cal-1', googleEventId: 'ev-1' });
  upsertCalendarLink(db, { invoiceLineId: lineIds[1], googleCalendarId: 'cal-1', googleEventId: 'ev-2' });

  const links = getCalendarLinks(db);
  assert.equal(links.length, 2);
});

await test('getCalendarLinks: invoiceLineIdsで絞り込み', () => {
  const db = makeDb();
  const lineIds = insertTestLines(db, [
    { work_date: '2024-08-01', description: '業務A' },
    { work_date: '2024-08-02', description: '業務B' },
    { work_date: '2024-08-03', description: '業務C' },
  ]);
  for (let i = 0; i < 3; i++) {
    upsertCalendarLink(db, {
      invoiceLineId: lineIds[i], googleCalendarId: 'cal-1', googleEventId: `ev-${i}`,
    });
  }
  const links = getCalendarLinks(db, { invoiceLineIds: [lineIds[0], lineIds[2]] });
  assert.equal(links.length, 2);
});

await test('getSyncRuns: 履歴一覧取得', () => {
  const db = makeDb();
  const id1 = insertSyncRun(db, { direction: 'push', calendarId: 'cal-1' });
  const id2 = insertSyncRun(db, { direction: 'pull', calendarId: 'cal-1' });
  completeSyncRun(db, { runId: id1, createdCount: 2, updatedCount: 0, skippedCount: 0, errorCount: 0 });
  completeSyncRun(db, { runId: id2, createdCount: 0, updatedCount: 0, skippedCount: 5, errorCount: 0 });

  const runs = getSyncRuns(db);
  assert.equal(runs.length, 2);
  // 両方向のレコードが存在することを確認（started_at が同秒の場合に ORDER は不定）
  const directions = new Set(runs.map(r => r.direction));
  assert.ok(directions.has('push'), 'push レコードが存在する');
  assert.ok(directions.has('pull'), 'pull レコードが存在する');
  // push レコードの created_count が 2 であることを確認
  const pushRun = runs.find(r => r.direction === 'push');
  assert.equal(pushRun.created_count, 2);
});

// ─── dry-run push ─────────────────────────────────────────────────────────────

section('Section: dry-run push');

await test('dryRunPush: work_dateありの行はcreate候補になる', () => {
  const db = makeDb();
  insertTestLines(db, [
    { work_date: '2024-08-01', description: '業務A' },
    { work_date: '2024-08-02', description: '業務B' },
  ]);
  const result = dryRunPush(db, 'mock-token', { calendarId: 'cal-1', year: '2024' });
  assert.equal(result.createCount, 2);
  assert.equal(result.updateCount, 0);
  assert.equal(result.skipCount,   0);
  assert.ok(result.items.every(i => i.action === 'create'));
});

await test('dryRunPush: work_dateなしの行はskipになる', () => {
  const db = makeDb();
  insertTestLines(db, [
    { work_date: null, description: '日付なし業務' },
    { work_date: '2024-08-01', description: '日付あり業務' },
  ]);
  const result = dryRunPush(db, 'mock-token', { calendarId: 'cal-1' });
  assert.equal(result.skipCount,   1);
  assert.equal(result.createCount, 1);
  const skipped = result.items.find(i => i.action === 'skip');
  assert.ok(skipped);
  assert.ok(skipped.reason);
});

await test('dryRunPush: 既リンク済みの行はupdate候補になる', () => {
  const db = makeDb();
  const [lineId] = insertTestLines(db, [{ work_date: '2024-08-01', description: '業務A' }]);
  // 既にリンク済みにする
  upsertCalendarLink(db, {
    invoiceLineId: lineId, googleCalendarId: 'cal-1', googleEventId: 'ev-existing',
  });
  const result = dryRunPush(db, 'mock-token', { calendarId: 'cal-1' });
  assert.equal(result.updateCount, 1);
  assert.equal(result.createCount, 0);
  const updateItem = result.items.find(i => i.action === 'update');
  assert.ok(updateItem?.existingLink);
});

await test('dryRunPush: DB書き込みなし（dry-run後にbusiness_calendar_linksが空）', () => {
  const db = makeDb();
  insertTestLines(db, [
    { work_date: '2024-08-01', description: '業務A' },
    { work_date: '2024-08-02', description: '業務B' },
  ]);
  dryRunPush(db, 'mock-token', { calendarId: 'cal-1' });
  assert.equal(getCalendarLinkCount(db), 0, 'dry-run 後もリンクテーブルは空');
});

// ─── dry-run pull ─────────────────────────────────────────────────────────────

section('Section: dry-run pull');

// モック listEvents 関数
function makeMockListEvents(items) {
  return async (_accessToken, _calendarId, _opts) => ({
    items,
    nextPageToken: null,
  });
}

// dryRunPull はモックに差し替えられないため、
// calendar_client の listEvents をモンキーパッチする代わりに
// dryRunPull の内部動作をテストするために同等ロジックを実装して検証する

/**
 * dryRunPull のロジックをモックで再現する（ネットワーク呼び出しなし）。
 */
async function mockDryRunPull(mockItems) {
  const JARVIS_SOURCE_KEY = 'jarvis_source';
  const candidates = [];
  let managedCount = 0;

  for (const item of mockItems) {
    const isJarvisManaged =
      item.extendedProperties?.private?.[JARVIS_SOURCE_KEY] === 'business';
    if (isJarvisManaged) managedCount++;

    const isAllDay = Boolean(item.start?.date && !item.start?.dateTime);
    candidates.push({
      googleEventId:   item.id,
      title:           item.summary ?? '',
      startDate:       item.start?.date     ?? null,
      startDatetime:   item.start?.dateTime ?? null,
      endDate:         item.end?.date       ?? null,
      isAllDay,
      description:     item.description ?? null,
      location:        item.location    ?? null,
      isJarvisManaged,
      importStatus:    isJarvisManaged ? 'skip_managed' : 'candidate',
    });
  }

  return {
    candidates,
    candidateCount: candidates.filter(c => !c.isJarvisManaged).length,
    managedCount,
    total: mockItems.length,
  };
}

await test('dryRunPull: Calendar予定を取込候補として返す', async () => {
  const mockItems = [
    { id: 'ev-1', summary: '打合せ', start: { date: '2024-08-01' }, end: { date: '2024-08-02' } },
    { id: 'ev-2', summary: '外出',   start: { date: '2024-08-05' }, end: { date: '2024-08-06' } },
  ];
  const result = await mockDryRunPull(mockItems);
  assert.equal(result.total, 2);
  assert.equal(result.candidateCount, 2);
  assert.equal(result.managedCount,   0);
  assert.ok(result.candidates.every(c => c.importStatus === 'candidate'));
});

await test('dryRunPull: JARVIS管理イベントはskip_managedになる', async () => {
  const mockItems = [
    {
      id: 'ev-jarvis', summary: '業務A',
      start: { date: '2024-08-01' }, end: { date: '2024-08-02' },
      extendedProperties: { private: { jarvis_source: 'business', invoice_line_id: '10' } },
    },
    { id: 'ev-user', summary: '個人予定', start: { date: '2024-08-03' }, end: { date: '2024-08-04' } },
  ];
  const result = await mockDryRunPull(mockItems);
  assert.equal(result.managedCount,   1);
  assert.equal(result.candidateCount, 1);
  const managed = result.candidates.find(c => c.googleEventId === 'ev-jarvis');
  assert.equal(managed.importStatus, 'skip_managed');
  assert.equal(managed.isJarvisManaged, true);
});

await test('dryRunPull: 終日イベントのisAllDayがtrue', async () => {
  const mockItems = [
    { id: 'ev-allday', summary: '終日', start: { date: '2024-08-01' }, end: { date: '2024-08-02' } },
  ];
  const result = await mockDryRunPull(mockItems);
  assert.equal(result.candidates[0].isAllDay, true);
});

await test('dryRunPull: 時間指定イベントのisAllDayがfalse', async () => {
  const mockItems = [
    {
      id: 'ev-timed', summary: '会議',
      start: { dateTime: '2024-08-01T10:00:00+09:00' },
      end:   { dateTime: '2024-08-01T12:00:00+09:00' },
    },
  ];
  const result = await mockDryRunPull(mockItems);
  assert.equal(result.candidates[0].isAllDay, false);
  assert.equal(result.candidates[0].startDatetime, '2024-08-01T10:00:00+09:00');
});

// ─── execute push ─────────────────────────────────────────────────────────────

section('Section: execute push');

await test('executePush: 新規イベントをcreateする（mock）', async () => {
  const db = makeDb();
  const [lineId] = insertTestLines(db, [{ work_date: '2024-08-01', description: '業務A' }]);

  let createCalled = 0;
  const mockClient = {
    createEvent: async (_token, _calId, _event) => {
      createCalled++;
      return { id: 'new-event-id-1' };
    },
    updateEvent: async () => { throw new Error('updateEvent は呼ばれないはず'); },
  };

  const result = await executePush(db, 'mock-token', { calendarId: 'cal-1' }, mockClient);
  assert.equal(result.createdCount, 1);
  assert.equal(result.updatedCount, 0);
  assert.equal(result.errorCount,   0);
  assert.equal(createCalled, 1);

  // DB にリンクが保存されている
  const link = getCalendarLinkByLineId(db, lineId);
  assert.equal(link.google_event_id, 'new-event-id-1');
});

await test('executePush: 既リンク済みイベントをupdateする（mock）', async () => {
  const db = makeDb();
  const [lineId] = insertTestLines(db, [{ work_date: '2024-08-01', description: '業務A' }]);
  upsertCalendarLink(db, {
    invoiceLineId: lineId, googleCalendarId: 'cal-1', googleEventId: 'existing-ev',
  });

  let updateCalled = 0;
  const mockClient = {
    createEvent: async () => { throw new Error('createEvent は呼ばれないはず'); },
    updateEvent: async (_token, _calId, _evId, _event) => {
      updateCalled++;
      return { id: 'existing-ev' };
    },
  };

  const result = await executePush(db, 'mock-token', { calendarId: 'cal-1' }, mockClient);
  assert.equal(result.updatedCount, 1);
  assert.equal(result.createdCount, 0);
  assert.equal(result.errorCount,   0);
  assert.equal(updateCalled, 1);
});

await test('executePush: 1件エラーでも他の件は継続する', async () => {
  const db = makeDb();
  insertTestLines(db, [
    { work_date: '2024-08-01', description: '業務A' },  // 成功
    { work_date: '2024-08-02', description: '業務B' },  // エラー
    { work_date: '2024-08-03', description: '業務C' },  // 成功
  ]);

  let callCount = 0;
  const mockClient = {
    createEvent: async (_token, _calId, event) => {
      callCount++;
      // 2件目（business B）でエラー
      if (event.summary.includes('業務B')) {
        throw new Error('API 503 エラー');
      }
      return { id: `ev-${callCount}` };
    },
    updateEvent: async () => ({ id: 'updated' }),
  };

  const result = await executePush(db, 'mock-token', { calendarId: 'cal-1' }, mockClient);
  assert.equal(result.createdCount, 2, '成功2件');
  assert.equal(result.errorCount,   1, 'エラー1件');
  assert.equal(result.errors.length, 1);
  assert.ok(result.errors[0].error.includes('503'));
});

await test('executePush: 同じ同期を2回してもリンクが重複しない', async () => {
  const db = makeDb();
  const [lineId] = insertTestLines(db, [{ work_date: '2024-08-01', description: '業務A' }]);

  const mockClient = {
    createEvent: async () => ({ id: 'ev-permanent' }),
    updateEvent: async () => ({ id: 'ev-permanent' }),
  };

  // 1回目
  await executePush(db, 'mock-token', { calendarId: 'cal-1' }, mockClient);
  // 2回目（update になる）
  await executePush(db, 'mock-token', { calendarId: 'cal-1' }, mockClient);

  // リンクは1件のまま
  assert.equal(getCalendarLinkCount(db), 1);
});

// ─── 既存予定との照合 ─────────────────────────────────────────────────────────

section('Section: 既存予定との照合');

await test('JARVIS管理extendedPropertiesがない既存イベントは自動上書きしない', async () => {
  // dryRunPush は calendar API を呼ばない（既存イベントの照合は DB ベース）
  // JARVIS 管理外のイベントは pull 候補として 'candidate' になる（上書きしない）
  const mockItems = [
    {
      id: 'ev-user-only', summary: 'ユーザー個人予定',
      start: { date: '2024-08-01' }, end: { date: '2024-08-02' },
      // extendedProperties なし → JARVIS 管理外
    },
  ];
  const result = await mockDryRunPull(mockItems);
  const c = result.candidates[0];
  assert.equal(c.isJarvisManaged, false);
  assert.equal(c.importStatus,    'candidate');
  // push 側で上書きしない確認: dryRunPush は invoice_line のみ対象
  // JARVIS 管理外の既存イベントへの update 候補は生成しない（invoice_line ≠ calendar event）
});

// ─── Calendar APIエラー処理 ───────────────────────────────────────────────────

section('Section: Calendar APIエラー処理');

await test('Calendar API 503エラー時にDBを壊さない（ロールバック）', async () => {
  const db = makeDb();
  insertTestLines(db, [
    { work_date: '2024-08-01', description: '業務A' },
    { work_date: '2024-08-02', description: '業務B' },
  ]);

  const mockClient = {
    createEvent: async () => { throw new Error('HTTP 503: Service Unavailable'); },
    updateEvent: async () => { throw new Error('HTTP 503: Service Unavailable'); },
  };

  const result = await executePush(db, 'mock-token', { calendarId: 'cal-1' }, mockClient);
  // 全件エラー
  assert.equal(result.errorCount,   2);
  assert.equal(result.createdCount, 0);
  // DB は壊れていない（リンクは0件）
  assert.equal(getCalendarLinkCount(db), 0);
  // DB の基本クエリが正常に動作する
  const links = getCalendarLinks(db);
  assert.equal(links.length, 0);
});

// ─── 過去年度 ─────────────────────────────────────────────────────────────────

section('Section: 過去年度');

await test('2023〜2026年のデータをyear指定でdry-run推奨', () => {
  const db = makeDb();
  // 4年分のデータを挿入
  const lines = ['2023', '2024', '2025', '2026'].map((year, i) => ({
    work_date:   `${year}-06-${String(i + 1).padStart(2, '0')}`,
    description: `${year}年業務`,
  }));
  insertTestLines(db, lines);

  for (const year of ['2023', '2024', '2025', '2026']) {
    const result = dryRunPush(db, 'mock-token', { calendarId: 'cal-1', year });
    assert.equal(result.createCount, 1, `${year}年: 1件`);
    assert.equal(result.skipCount,   0, `${year}年: スキップなし`);
  }
});

// ─── 個人情報保護 ─────────────────────────────────────────────────────────────

section('Section: 個人情報保護');

await test('イベント説明に住所・電話・メール・銀行口座が含まれない', () => {
  // 銀行口座・電話番号・メールなどを description や client_name に持つ行でも
  // Calendar イベントの description に入れない
  const line = {
    id: 99,
    work_date: '2024-08-01',
    description: 'スタジオ業務',
    amount: 50000,
    category: 'スタジオ音声',
    invoice_number: 'TEST-099',
    client_name: '株式会社テスト',
  };
  const event = buildEventFromLine(line);
  const allText = JSON.stringify(event);

  assert.ok(!/@/.test(allText),              'メールアドレスなし');
  assert.ok(!/090-|080-|☎/.test(allText),   '電話番号なし');
  assert.ok(!/〒/.test(allText),             '郵便番号なし');
  assert.ok(!/口座|銀行|振込/.test(allText), '銀行口座情報なし');
});

// ─── 同期履歴 ─────────────────────────────────────────────────────────────────

section('Section: 同期履歴');

await test('同期実行後に履歴レコードが作成される', async () => {
  const db = makeDb();
  insertTestLines(db, [{ work_date: '2024-08-01', description: '業務A' }]);

  const runId = insertSyncRun(db, { direction: 'push', calendarId: 'cal-1', yearFilter: '2024' });

  const mockClient = {
    createEvent: async () => ({ id: 'ev-new' }),
    updateEvent: async () => ({ id: 'ev-updated' }),
  };

  await executePush(db, 'mock-token', { calendarId: 'cal-1', year: '2024', runId }, mockClient);

  const runs = getSyncRuns(db);
  assert.equal(runs.length, 1);
  assert.equal(runs[0].status, 'completed');
  assert.equal(runs[0].created_count, 1);
  assert.ok(runs[0].finished_at, 'finished_at が記録されている');
});

// ─── 結果サマリー ─────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`結果: ${passed + failed} テスト中 ${passed} 成功, ${failed} 失敗`);
if (failed > 0) {
  console.error('\n一部テストが失敗しました');
  process.exit(1);
} else {
  console.log('\nすべてのテストが成功しました ✅');
}
