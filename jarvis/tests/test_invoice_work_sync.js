/**
 * 請求書明細 → work_records 同期の回帰テスト。
 * 2023 明治カップの「8/2、8/3」のような複数日明細を日別に分割し、
 * 手動登録済みの仕事は重複させず照合することを確認する。
 */

import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { syncAllInvoiceLinesToWorkRecords } from '../data/invoice_manager.js';

const db = new DatabaseSync(':memory:');

db.exec(`
  CREATE TABLE daily_status (
    date TEXT PRIMARY KEY,
    is_full_day_off INTEGER NOT NULL DEFAULT 0,
    memo TEXT
  );

  CREATE TABLE work_records (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL UNIQUE,
    date TEXT NOT NULL,
    category TEXT NOT NULL,
    work_type TEXT,
    content TEXT,
    client TEXT,
    income INTEGER,
    expense INTEGER,
    work_hours REAL,
    travel_hours REAL,
    invoice_status TEXT NOT NULL DEFAULT '対象外',
    payment_status TEXT NOT NULL DEFAULT '対象外',
    memo TEXT
  );

  CREATE TABLE business_invoice_imports (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_filename TEXT NOT NULL,
    file_hash TEXT NOT NULL,
    imported_at TEXT DEFAULT (datetime('now','localtime')),
    status TEXT NOT NULL,
    new_count INTEGER NOT NULL DEFAULT 0,
    dup_count INTEGER NOT NULL DEFAULT 0,
    skip_count INTEGER NOT NULL DEFAULT 0,
    warn_count INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE business_invoices (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    import_id INTEGER NOT NULL,
    client_name TEXT NOT NULL,
    invoice_number TEXT NOT NULL,
    invoice_date TEXT,
    subtotal INTEGER NOT NULL DEFAULT 0,
    tax INTEGER NOT NULL DEFAULT 0,
    total INTEGER NOT NULL DEFAULT 0,
    source_sheet TEXT NOT NULL,
    source_filename TEXT NOT NULL,
    UNIQUE(invoice_number, source_sheet)
  );

  CREATE TABLE business_invoice_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_id INTEGER NOT NULL,
    work_date TEXT,
    description TEXT NOT NULL,
    quantity REAL NOT NULL DEFAULT 1,
    quantity_unit TEXT NOT NULL DEFAULT '日',
    unit_price INTEGER NOT NULL DEFAULT 0,
    amount INTEGER NOT NULL DEFAULT 0,
    category TEXT NOT NULL DEFAULT 'その他',
    job_id TEXT,
    source_row INTEGER NOT NULL,
    UNIQUE(invoice_id, source_row)
  );
`);

const importId = db.prepare(`
  INSERT INTO business_invoice_imports
    (source_filename, file_hash, status)
  VALUES ('明治カップ請求書202308.xlsx', 'testhash', 'completed')
`).run().lastInsertRowid;

const invoiceId = db.prepare(`
  INSERT INTO business_invoices
    (import_id, client_name, invoice_number, invoice_date,
     subtotal, tax, total, source_sheet, source_filename)
  VALUES (?, '株式会社オーテック', '202308-001', '2023-08-08',
          150000, 15000, 165000, '2023請求書', '明治カップ請求書202308.xlsx')
`).run(importId).lastInsertRowid;

const insertLine = db.prepare(`
  INSERT INTO business_invoice_lines
    (invoice_id, work_date, description, quantity, quantity_unit,
     unit_price, amount, category, job_id, source_row)
  VALUES (?, ?, ?, ?, '日', ?, ?, 'ゴルフ中継', NULL, ?)
`);

insertLine.run(invoiceId, '2023-08-02', 'meijicup 音声技術費　8/2、８/３', 2, 25000, 50000, 17);
insertLine.run(invoiceId, '2023-08-04', 'meijicup 音声技術費　8/4、８/5', 2, 30000, 60000, 18);
insertLine.run(invoiceId, '2023-08-06', 'ｍeijicup 音声技術費　8/6', 1, 40000, 40000, 19);

// 8/2 は手動入力済み、8/6 は金額未入力の手動仕事を想定。
db.prepare(`
  INSERT INTO work_records
    (job_id, date, category, work_type, content, client, income, invoice_status, payment_status)
  VALUES ('manual-0802', '2023-08-02', '音声仕事', '中継', '明治カップ', 'オーテック', 25000, '未請求', '未入金')
`).run();
db.prepare(`
  INSERT INTO work_records
    (job_id, date, category, work_type, content, client, income, invoice_status, payment_status)
  VALUES ('manual-0806', '2023-08-06', '音声仕事', '中継', '明治カップ', 'オーテック', NULL, '未請求', '未入金')
`).run();

const first = syncAllInvoiceLinesToWorkRecords(db, { year: '2023' });
assert.equal(first.workParts, 5);
assert.equal(first.matched, 2);
assert.equal(first.created, 3);
assert.equal(first.ambiguous, 0);
assert.equal(first.skipped, 0);

const works = db.prepare(`
  SELECT date, income, invoice_status
  FROM work_records
  ORDER BY date
`).all();

assert.deepEqual(works.map(w => w.date), [
  '2023-08-02', '2023-08-03', '2023-08-04', '2023-08-05', '2023-08-06',
]);
assert.deepEqual(works.map(w => w.income), [25000, 25000, 30000, 30000, 40000]);
assert.ok(works.every(w => w.invoice_status === '請求済'));

// 2回目でも仕事は増えない（冪等性）。
const second = syncAllInvoiceLinesToWorkRecords(db, { year: '2023' });
assert.equal(second.created, 0);
assert.equal(second.matched, 5);
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM work_records').get().n, 5);
assert.equal(db.prepare('SELECT COUNT(*) AS n FROM business_invoice_work_links').get().n, 5);

console.log('✅ invoice work sync: 2023 multi-day + manual match + idempotency');
db.close();
