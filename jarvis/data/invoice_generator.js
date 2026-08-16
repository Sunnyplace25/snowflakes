/**
 * JARVIS 請求書生成
 *
 * ユーザーが設定した既存 Excel テンプレートを使い、月次のオーテック仕事から
 * 請求書 .xlsx を作成する。テンプレート・生成物は git 管理しない。
 */
'use strict';

import * as XLSX from 'xlsx';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const JARVIS_DIR = resolve(__dirname, '..');
const TEMPLATE_DIR = resolve(JARVIS_DIR, 'imports', 'invoices');
const TEMPLATE_PATH = resolve(TEMPLATE_DIR, 'invoice_template.xlsx');
const EXPORT_DIR = resolve(JARVIS_DIR, 'exports', 'invoices');

function ensureGenerationTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS business_generated_invoices (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      work_month     TEXT    NOT NULL,
      invoice_number TEXT    NOT NULL,
      invoice_date   TEXT    NOT NULL,
      due_date       TEXT    NOT NULL,
      subtotal       INTEGER NOT NULL DEFAULT 0,
      tax            INTEGER NOT NULL DEFAULT 0,
      total          INTEGER NOT NULL DEFAULT 0,
      filename       TEXT,
      created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      UNIQUE(work_month, invoice_number)
    );
    CREATE INDEX IF NOT EXISTS idx_bgi_month ON business_generated_invoices(work_month);
    CREATE INDEX IF NOT EXISTS idx_bgi_number ON business_generated_invoices(invoice_number);
  `);
}

function validateMonth(month) {
  if (typeof month !== 'string' || !/^\d{4}-\d{2}$/.test(month)) {
    throw new Error('対象月は YYYY-MM 形式で指定してください');
  }
}

function lastDayOfMonth(month, delta = 0) {
  validateMonth(month);
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m + delta, 0);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function isOtec(client) {
  return String(client ?? '').includes('オーテック');
}

function monthDay(isoDate) {
  const [, m, d] = String(isoDate).split('-').map(Number);
  return `${m}/${d}`;
}

function invoiceDescription(work) {
  const content = String(work.content ?? '').trim() || String(work.work_type ?? '').trim() || '音声技術費';
  const md = monthDay(work.date);
  const hasDate = /\d{1,2}\s*[\/／]\s*\d{1,2}/.test(content);
  return hasDate ? content : `${content}　${md}`;
}

function nextInvoiceNumber(db, month) {
  ensureGenerationTable(db);
  const year = month.slice(0, 4);
  let maxSeq = 0;
  const numbers = [];

  try {
    numbers.push(...db.prepare(`
      SELECT invoice_number FROM business_invoices
      WHERE invoice_number LIKE ?
    `).all(`${year}%`).map(r => r.invoice_number));
  } catch (_) {}

  numbers.push(...db.prepare(`
    SELECT invoice_number FROM business_generated_invoices
    WHERE invoice_number LIKE ?
  `).all(`${year}%`).map(r => r.invoice_number));

  for (const value of numbers) {
    const m = String(value ?? '').match(/-(\d+)$/);
    if (m) maxSeq = Math.max(maxSeq, Number(m[1]) || 0);
  }
  return `${month.replace('-', '')}-${String(maxSeq + 1).padStart(3, '0')}`;
}

export function getInvoiceTemplateStatus() {
  return {
    configured: existsSync(TEMPLATE_PATH),
    path: TEMPLATE_PATH,
    filename: existsSync(TEMPLATE_PATH) ? basename(TEMPLATE_PATH) : null,
  };
}

export function saveInvoiceTemplate(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('テンプレートが空です');
  // 読める Excel かを先に確認する。
  const wb = XLSX.read(buffer, { type: 'buffer', cellStyles: true, cellDates: true });
  const invoiceSheets = wb.SheetNames.filter(name => name.includes('請求書'));
  if (invoiceSheets.length === 0) throw new Error('「請求書」シートが見つかりません');

  mkdirSync(TEMPLATE_DIR, { recursive: true });
  writeFileSync(TEMPLATE_PATH, buffer);
  return { ...getInvoiceTemplateStatus(), sourceSheet: invoiceSheets[0] };
}

export function buildInvoicePreview(db, month) {
  validateMonth(month);
  ensureGenerationTable(db);

  const works = db.prepare(`
    SELECT * FROM work_records
    WHERE date LIKE ?
    ORDER BY date, id
  `).all(`${month}%`).filter(w => isOtec(w.client) && Number(w.income || 0) > 0);

  const rows = works.map((work, index) => ({
    no: index + 1,
    work_id: work.id,
    date: work.date,
    description: invoiceDescription(work),
    quantity: 1,
    unit: '日',
    unit_price: Number(work.income || 0),
    amount: Number(work.income || 0),
  }));

  const subtotal = rows.reduce((sum, row) => sum + row.amount, 0);
  const tax = Math.round(subtotal * 0.10);
  const total = subtotal + tax;

  const prior = db.prepare(`
    SELECT invoice_number, invoice_date, due_date
    FROM business_generated_invoices
    WHERE work_month = ?
    ORDER BY id DESC LIMIT 1
  `).get(month);

  return {
    month,
    client: '株式会社　オーテック',
    invoice_number: prior?.invoice_number || nextInvoiceNumber(db, month),
    invoice_date: prior?.invoice_date || lastDayOfMonth(month, 0),
    due_date: prior?.due_date || lastDayOfMonth(month, 1),
    rows,
    subtotal,
    tax,
    total,
    tax_rate: 10,
    max_rows: 24,
    template: getInvoiceTemplateStatus(),
  };
}

function setCellValue(sheet, addr, value, type = null) {
  const cell = sheet[addr] || {};
  delete cell.f;
  delete cell.F;
  cell.v = value;
  if (type) cell.t = type;
  else if (value instanceof Date) cell.t = 'd';
  else if (typeof value === 'number') cell.t = 'n';
  else cell.t = 's';
  sheet[addr] = cell;
}

function clearCellValue(sheet, addr) {
  const cell = sheet[addr];
  if (!cell) return;
  delete cell.f;
  delete cell.F;
  delete cell.v;
  cell.t = 'z';
}

function asLocalDate(iso) {
  const [y, m, d] = String(iso).split('-').map(Number);
  return new Date(y, m - 1, d, 12, 0, 0);
}

export function generateInvoiceWorkbook(db, {
  month,
  invoice_number = null,
  invoice_date = null,
  due_date = null,
} = {}) {
  const preview = buildInvoicePreview(db, month);
  if (!preview.template.configured) {
    throw new Error('請求書テンプレートが未設定です。先に Excel テンプレートを設定してください');
  }
  if (preview.rows.length === 0) throw new Error('この月にオーテックの請求対象仕事がありません');
  if (preview.rows.length > preview.max_rows) {
    throw new Error(`明細が${preview.max_rows}行を超えています。現在のテンプレートでは作成できません`);
  }

  const number = String(invoice_number || preview.invoice_number).trim();
  const issueDate = String(invoice_date || preview.invoice_date).trim();
  const paymentDue = String(due_date || preview.due_date).trim();
  if (!number) throw new Error('請求書番号が必要です');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(issueDate)) throw new Error('請求日は YYYY-MM-DD 形式で指定してください');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(paymentDue)) throw new Error('支払期限は YYYY-MM-DD 形式で指定してください');

  const templateBuffer = readFileSync(TEMPLATE_PATH);
  const workbook = XLSX.read(templateBuffer, {
    type: 'buffer', cellStyles: true, cellNF: true, cellDates: true,
  });
  const sourceName = workbook.SheetNames.find(name => name.includes('請求書'));
  if (!sourceName) throw new Error('テンプレートに請求書シートがありません');
  const sheet = workbook.Sheets[sourceName];

  // 過去請求書の値・式を消す。書式は残す。
  for (let row = 17; row <= 40; row++) {
    for (const col of ['B','C','D','E','F','G','H','I','J','K','L','M']) {
      clearCellValue(sheet, `${col}${row}`);
    }
  }

  setCellValue(sheet, 'M2', number);
  setCellValue(sheet, 'M3', asLocalDate(issueDate));
  setCellValue(sheet, 'B5', '株式会社　オーテック');
  setCellValue(sheet, 'E11', preview.total);

  preview.rows.forEach((item, idx) => {
    const row = 17 + idx;
    setCellValue(sheet, `B${row}`, item.no);
    setCellValue(sheet, `C${row}`, item.description);
    setCellValue(sheet, `I${row}`, item.quantity);
    setCellValue(sheet, `J${row}`, item.unit);
    setCellValue(sheet, `K${row}`, item.unit_price);
    setCellValue(sheet, `M${row}`, item.amount);
  });

  setCellValue(sheet, 'M42', preview.subtotal);
  setCellValue(sheet, 'L43', 10);
  setCellValue(sheet, 'M43', preview.tax);
  setCellValue(sheet, 'M44', preview.total);
  setCellValue(sheet, 'E51', asLocalDate(paymentDue));

  // 送付用ファイルに過去請求書や見積書等を混ぜない。
  const outputSheetName = `${month.replace('-', '')} 請求書`;
  workbook.SheetNames = [outputSheetName];
  workbook.Sheets = { [outputSheetName]: sheet };

  const buffer = XLSX.write(workbook, {
    type: 'buffer', bookType: 'xlsx', cellStyles: true,
  });

  mkdirSync(EXPORT_DIR, { recursive: true });
  const safeNumber = number.replace(/[^0-9A-Za-z_-]/g, '_');
  const filename = `請求書_${safeNumber}.xlsx`;
  const outputPath = resolve(EXPORT_DIR, filename);
  writeFileSync(outputPath, buffer);

  ensureGenerationTable(db);
  db.prepare(`
    INSERT INTO business_generated_invoices
      (work_month, invoice_number, invoice_date, due_date, subtotal, tax, total, filename)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(work_month, invoice_number) DO UPDATE SET
      invoice_date = excluded.invoice_date,
      due_date = excluded.due_date,
      subtotal = excluded.subtotal,
      tax = excluded.tax,
      total = excluded.total,
      filename = excluded.filename,
      created_at = datetime('now','localtime')
  `).run(month, number, issueDate, paymentDue, preview.subtotal, preview.tax, preview.total, filename);

  return {
    buffer,
    filename,
    outputPath,
    preview: { ...preview, invoice_number: number, invoice_date: issueDate, due_date: paymentDue },
  };
}
