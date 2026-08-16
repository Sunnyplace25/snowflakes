/**
 * jarvis/data/work_record_manager.js
 * work_records テーブルの CRUD 操作
 *
 * - job_id は呼び出し元未指定の場合 JARVIS 側で UUID を自動生成する
 * - income / expense は円単位の INTEGER
 * - work_hours は分析用。報酬計算には使用しない
 */

import { randomUUID } from 'crypto';
import { getDailyStatus } from './daily_status_manager.js';

const VALID_CATEGORIES      = ['Snow flakes', '音声仕事', '物販', '17配信', 'その他'];
const VALID_INVOICE_STATUSES = ['対象外', '未請求', '請求済'];
const VALID_PAYMENT_STATUSES = ['対象外', '未入金', '入金済'];

function assertEnum(value, allowed, fieldName) {
  if (!allowed.includes(value)) {
    throw new Error(`Invalid ${fieldName}: "${value}". Must be one of: ${allowed.join(', ')}`);
  }
}

export function addWorkRecord(db, {
  date,
  category,
  job_id         = null,
  work_type      = null,
  content        = null,
  client         = null,
  income         = null,
  expense        = null,
  work_hours     = null,
  travel_hours   = null,
  invoice_status = '対象外',
  payment_status = '対象外',
  memo           = null,
}) {
  if (!date || typeof date !== 'string') throw new Error('date is required (YYYY-MM-DD)');
  if (!category) throw new Error('category is required');

  assertEnum(category, VALID_CATEGORIES, 'category');
  assertEnum(invoice_status, VALID_INVOICE_STATUSES, 'invoice_status');
  assertEnum(payment_status, VALID_PAYMENT_STATUSES, 'payment_status');

  if (income !== null && (!Number.isInteger(income) || income < 0)) throw new Error('income must be a non-negative integer');
  if (expense !== null && (!Number.isInteger(expense) || expense < 0)) throw new Error('expense must be a non-negative integer');
  if (work_hours !== null && (typeof work_hours !== 'number' || work_hours < 0)) throw new Error('work_hours must be >= 0');
  if (travel_hours !== null && (typeof travel_hours !== 'number' || travel_hours < 0)) throw new Error('travel_hours must be >= 0');

  const dayStatus = getDailyStatus(db, date);
  if (dayStatus && dayStatus.is_full_day_off === 1) {
    throw new Error(
      `ConflictError: ${date} は完全休日として登録されています。` +
      `仕事を登録するには先に record_day.js set --date ${date} --work で勤務日に変更してください。`
    );
  }

  const effectiveJobId = job_id ?? randomUUID();
  const stmt = db.prepare(`
    INSERT INTO work_records
      (job_id, date, category, work_type, content, client,
       income, expense, work_hours, travel_hours,
       invoice_status, payment_status, memo)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  const result = stmt.run(
    effectiveJobId, date, category, work_type, content, client,
    income, expense, work_hours, travel_hours,
    invoice_status, payment_status, memo
  );
  return { rowid: result.lastInsertRowid, job_id: effectiveJobId };
}

export function getWorkRecords(db, filters = {}) {
  const { yearMonth, category, client } = filters;
  const conditions = [];
  const params = [];
  if (yearMonth) { conditions.push('date LIKE ?'); params.push(`${yearMonth}%`); }
  if (category) { conditions.push('category = ?'); params.push(category); }
  if (client) { conditions.push('client = ?'); params.push(client); }
  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  return db.prepare(`SELECT * FROM work_records ${where} ORDER BY date, id`).all(...params);
}

export function updateWorkRecord(db, id, updates) {
  const { invoice_status, payment_status } = updates;
  if (invoice_status !== undefined) assertEnum(invoice_status, VALID_INVOICE_STATUSES, 'invoice_status');
  if (payment_status !== undefined) assertEnum(payment_status, VALID_PAYMENT_STATUSES, 'payment_status');
  if (invoice_status !== undefined) db.prepare('UPDATE work_records SET invoice_status = ? WHERE id = ?').run(invoice_status, id);
  if (payment_status !== undefined) db.prepare('UPDATE work_records SET payment_status = ? WHERE id = ?').run(payment_status, id);
}

export function updateWorkRecordFull(db, id, fields = {}) {
  const {
    date, category, work_type, content, client,
    income, expense, work_hours, travel_hours,
    invoice_status, payment_status, memo,
  } = fields;

  if (date !== undefined && date !== null) {
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new Error('date は YYYY-MM-DD 形式で入力してください');
    }
  }
  if (category !== undefined && category !== null) assertEnum(category, VALID_CATEGORIES, 'category');
  if (invoice_status !== undefined && invoice_status !== null) assertEnum(invoice_status, VALID_INVOICE_STATUSES, 'invoice_status');
  if (payment_status !== undefined && payment_status !== null) assertEnum(payment_status, VALID_PAYMENT_STATUSES, 'payment_status');

  let parsedIncome = income;
  if (income !== undefined && income !== null) {
    const n = parseInt(income, 10);
    if (!Number.isFinite(n) || n < 0) throw new Error('income must be a non-negative integer');
    parsedIncome = n;
  }
  let parsedExpense = expense;
  if (expense !== undefined && expense !== null) {
    const n = parseInt(expense, 10);
    if (!Number.isFinite(n) || n < 0) throw new Error('expense must be a non-negative integer');
    parsedExpense = n;
  }
  let parsedWorkHours = work_hours;
  if (work_hours !== undefined && work_hours !== null) {
    const n = parseFloat(work_hours);
    if (!Number.isFinite(n) || n < 0) throw new Error('work_hours must be >= 0');
    parsedWorkHours = n;
  }
  let parsedTravelHours = travel_hours;
  if (travel_hours !== undefined && travel_hours !== null) {
    const n = parseFloat(travel_hours);
    if (!Number.isFinite(n) || n < 0) throw new Error('travel_hours must be >= 0');
    parsedTravelHours = n;
  }

  const sets = [];
  const params = [];
  const add = (col, val) => { sets.push(`${col} = ?`); params.push(val); };
  if (date !== undefined) add('date', date);
  if (category !== undefined) add('category', category);
  if (work_type !== undefined) add('work_type', work_type);
  if (content !== undefined) add('content', content);
  if (client !== undefined) add('client', client);
  if (income !== undefined) add('income', parsedIncome);
  if (expense !== undefined) add('expense', parsedExpense);
  if (work_hours !== undefined) add('work_hours', parsedWorkHours);
  if (travel_hours !== undefined) add('travel_hours', parsedTravelHours);
  if (invoice_status !== undefined) add('invoice_status', invoice_status);
  if (payment_status !== undefined) add('payment_status', payment_status);
  if (memo !== undefined) add('memo', memo);
  if (sets.length === 0) return;

  params.push(id);
  db.prepare(`UPDATE work_records SET ${sets.join(', ')} WHERE id = ?`).run(...params);
}

/**
 * 仕事レコードを削除する。
 * 請求書同期とのリンクがある場合はリンクを外し、明細側の旧 job_id もクリアする。
 */
export function deleteWorkRecord(db, id) {
  const work = db.prepare('SELECT id, job_id FROM work_records WHERE id = ?').get(id);
  if (!work) return false;

  try {
    db.exec('BEGIN');
    try {
      db.prepare('DELETE FROM business_invoice_work_links WHERE job_id = ?').run(work.job_id);
    } catch (_) { /* table may not exist yet */ }
    try {
      db.prepare('UPDATE business_invoice_lines SET job_id = NULL WHERE job_id = ?').run(work.job_id);
    } catch (_) { /* invoice tables may not exist yet */ }
    db.prepare('DELETE FROM work_records WHERE id = ?').run(id);
    db.exec('COMMIT');
    return true;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw e;
  }
}
