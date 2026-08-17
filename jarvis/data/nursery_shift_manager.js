/**
 * 保育園シフト・給与明細管理。
 * 音声仕事などによる変更履歴を、収入用の work_records と分離して保持する。
 */
'use strict';

const VALID_STATUSES = ['通常', '変更', '休み', '有給'];
const VALID_REASONS = ['音声仕事優先', '園都合', '自分都合', 'その他'];

export function ensureNurseryShiftTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS business_nursery_shifts (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      date           TEXT    NOT NULL UNIQUE,
      original_start TEXT,
      original_end   TEXT,
      changed_start  TEXT,
      changed_end    TEXT,
      status         TEXT    NOT NULL DEFAULT '通常'
        CHECK (status IN ('通常','変更','休み','有給')),
      change_reason  TEXT
        CHECK (change_reason IS NULL OR change_reason IN ('音声仕事優先','園都合','自分都合','その他')),
      memo           TEXT,
      created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      updated_at     TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_bns_date ON business_nursery_shifts(date);
    CREATE INDEX IF NOT EXISTS idx_bns_status ON business_nursery_shifts(status);
    CREATE INDEX IF NOT EXISTS idx_bns_reason ON business_nursery_shifts(change_reason);
  `);
}

export function ensureNurseryPayslipTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS business_nursery_payslips (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      month          TEXT NOT NULL UNIQUE,
      hourly_rate    INTEGER,
      worked_hours   REAL,
      paid_leave_used REAL,
      paid_leave_balance REAL,
      gross_pay      INTEGER,
      net_pay        INTEGER,
      transport_pay  INTEGER,
      deductions     INTEGER,
      memo           TEXT,
      created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      updated_at     TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE INDEX IF NOT EXISTS idx_bnp_month ON business_nursery_payslips(month);
  `);
}

function normalizeTime(value) {
  if (value == null || value === '') return null;
  const text = String(value).trim();
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(text)) {
    throw new Error('時刻は HH:MM 形式で入力してください');
  }
  return text;
}

function validateDate(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('日付は YYYY-MM-DD 形式で入力してください');
  }
}

function validateMonth(month) {
  if (typeof month !== 'string' || !/^\d{4}-\d{2}$/.test(month)) {
    throw new Error('月は YYYY-MM 形式で入力してください');
  }
}

function nullableNumber(value, { integer = false } = {}) {
  if (value == null || value === '') return null;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new Error('数値は0以上で入力してください');
  return integer ? Math.round(n) : n;
}

function normalizePayload(payload = {}) {
  validateDate(payload.date);
  const status = payload.status || '通常';
  if (!VALID_STATUSES.includes(status)) throw new Error('不正なシフト状態です');

  let changeReason = payload.change_reason == null || payload.change_reason === ''
    ? null
    : String(payload.change_reason);
  if (changeReason && !VALID_REASONS.includes(changeReason)) throw new Error('不正な変更理由です');
  if (status !== '変更') changeReason = null;

  return {
    date: payload.date,
    original_start: normalizeTime(payload.original_start),
    original_end: normalizeTime(payload.original_end),
    changed_start: normalizeTime(payload.changed_start),
    changed_end: normalizeTime(payload.changed_end),
    status,
    change_reason: changeReason,
    memo: payload.memo == null || payload.memo === '' ? null : String(payload.memo).trim(),
  };
}

function normalizePayslip(payload = {}) {
  validateMonth(payload.month);
  return {
    month: payload.month,
    hourly_rate: nullableNumber(payload.hourly_rate, { integer: true }),
    worked_hours: nullableNumber(payload.worked_hours),
    paid_leave_used: nullableNumber(payload.paid_leave_used),
    paid_leave_balance: nullableNumber(payload.paid_leave_balance),
    gross_pay: nullableNumber(payload.gross_pay, { integer: true }),
    net_pay: nullableNumber(payload.net_pay, { integer: true }),
    transport_pay: nullableNumber(payload.transport_pay, { integer: true }),
    deductions: nullableNumber(payload.deductions, { integer: true }),
    memo: payload.memo == null || payload.memo === '' ? null : String(payload.memo).trim(),
  };
}

export function getNurseryShifts(db, { month = null } = {}) {
  ensureNurseryShiftTable(db);
  if (month) {
    if (!/^\d{4}-\d{2}$/.test(month)) throw new Error('month は YYYY-MM 形式で指定してください');
    return db.prepare(`
      SELECT * FROM business_nursery_shifts
      WHERE date LIKE ?
      ORDER BY date, id
    `).all(`${month}%`);
  }
  return db.prepare('SELECT * FROM business_nursery_shifts ORDER BY date, id').all();
}

export function upsertNurseryShift(db, payload) {
  ensureNurseryShiftTable(db);
  const p = normalizePayload(payload);
  db.prepare(`
    INSERT INTO business_nursery_shifts
      (date, original_start, original_end, changed_start, changed_end, status, change_reason, memo)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(date) DO UPDATE SET
      original_start = excluded.original_start,
      original_end = excluded.original_end,
      changed_start = excluded.changed_start,
      changed_end = excluded.changed_end,
      status = excluded.status,
      change_reason = excluded.change_reason,
      memo = excluded.memo,
      updated_at = datetime('now','localtime')
  `).run(
    p.date, p.original_start, p.original_end, p.changed_start, p.changed_end,
    p.status, p.change_reason, p.memo,
  );
  return db.prepare('SELECT * FROM business_nursery_shifts WHERE date = ?').get(p.date);
}

export function updateNurseryShift(db, id, payload) {
  ensureNurseryShiftTable(db);
  const current = db.prepare('SELECT * FROM business_nursery_shifts WHERE id = ?').get(id);
  if (!current) return null;
  const p = normalizePayload({ ...current, ...payload });
  db.prepare(`
    UPDATE business_nursery_shifts SET
      date = ?, original_start = ?, original_end = ?, changed_start = ?, changed_end = ?,
      status = ?, change_reason = ?, memo = ?, updated_at = datetime('now','localtime')
    WHERE id = ?
  `).run(
    p.date, p.original_start, p.original_end, p.changed_start, p.changed_end,
    p.status, p.change_reason, p.memo, id,
  );
  return db.prepare('SELECT * FROM business_nursery_shifts WHERE id = ?').get(id);
}

export function deleteNurseryShift(db, id) {
  ensureNurseryShiftTable(db);
  const current = db.prepare('SELECT * FROM business_nursery_shifts WHERE id = ?').get(id);
  if (!current) return null;
  db.prepare('DELETE FROM business_nursery_shifts WHERE id = ?').run(id);
  return current;
}

export function getNurseryPayslips(db, { month = null } = {}) {
  ensureNurseryPayslipTable(db);
  if (month) {
    validateMonth(month);
    const row = db.prepare('SELECT * FROM business_nursery_payslips WHERE month = ?').get(month);
    return row ? [row] : [];
  }
  return db.prepare('SELECT * FROM business_nursery_payslips ORDER BY month DESC').all();
}

export function upsertNurseryPayslip(db, payload) {
  ensureNurseryPayslipTable(db);
  const p = normalizePayslip(payload);
  db.prepare(`
    INSERT INTO business_nursery_payslips
      (month, hourly_rate, worked_hours, paid_leave_used, paid_leave_balance, gross_pay, net_pay, transport_pay, deductions, memo)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(month) DO UPDATE SET
      hourly_rate = excluded.hourly_rate,
      worked_hours = excluded.worked_hours,
      paid_leave_used = excluded.paid_leave_used,
      paid_leave_balance = excluded.paid_leave_balance,
      gross_pay = excluded.gross_pay,
      net_pay = excluded.net_pay,
      transport_pay = excluded.transport_pay,
      deductions = excluded.deductions,
      memo = excluded.memo,
      updated_at = datetime('now','localtime')
  `).run(
    p.month, p.hourly_rate, p.worked_hours, p.paid_leave_used, p.paid_leave_balance,
    p.gross_pay, p.net_pay, p.transport_pay, p.deductions, p.memo,
  );
  return db.prepare('SELECT * FROM business_nursery_payslips WHERE month = ?').get(p.month);
}

export function deleteNurseryPayslip(db, month) {
  ensureNurseryPayslipTable(db);
  validateMonth(month);
  const current = db.prepare('SELECT * FROM business_nursery_payslips WHERE month = ?').get(month);
  if (!current) return null;
  db.prepare('DELETE FROM business_nursery_payslips WHERE month = ?').run(month);
  return current;
}
