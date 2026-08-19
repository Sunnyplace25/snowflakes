/**
 * JARVIS 請求書生成
 *
 * ユーザーが設定した既存 Excel テンプレートを使い、月次のオーテック仕事から
 * 請求書 .xlsx を作成する。テンプレート・生成物は git 管理しない。
 *
 * 2026 オーテック実テンプレート基準：
 * - ★請求書マスター を優先
 * - 明細は 17〜36 行（最大20件）
 * - 日付 B / 内容 C / 数量 H / 単位 I / 単価 J / 金額 L
 * - 小計 L38 / 消費税 L39 / 合計 L40 / 支払期限 D46
 */
'use strict';

import * as XLSX from 'xlsx';
import {
  existsSync, mkdirSync, readFileSync, writeFileSync,
} from 'node:fs';
import { resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const JARVIS_DIR = resolve(__dirname, '..');
const TEMPLATE_DIR = resolve(JARVIS_DIR, 'imports', 'invoices');
const TEMPLATE_PATH = resolve(TEMPLATE_DIR, 'invoice_template.xlsx');
const EXPORT_DIR = resolve(JARVIS_DIR, 'exports', 'invoices');
const MAX_ROWS = 20;
const PY_SCRIPT = resolve(__dirname, 'generate_invoice_py.py');

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

function firstDayOfMonth(month) {
  validateMonth(month);
  const [y, m] = month.split('-');
  return `${y}-${m}-01`;
}

function firstDayOfNextMonth(month) {
  validateMonth(month);
  const [y, m] = month.split('-').map(Number);
  const d = new Date(y, m, 1); // m は 1-indexed なので new Date(y, m, 1) = 翌月1日
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

function isOtec(client) {
  return String(client ?? '').includes('オーテック');
}

function monthDay(isoDate) {
  const [, m, d] = String(isoDate).split('-').map(Number);
  return `${m}/${d}`;
}

function invoiceDescription(work) {
  return String(work.content ?? '').trim()
    || String(work.work_type ?? '').trim()
    || '音声業務';
}

function quantityAndUnit(work) {
  const hours = Number(work.work_hours || work.hours || 0);
  if (Number.isFinite(hours) && hours > 0) {
    return { quantity: hours, unit: '時間' };
  }
  return { quantity: 1, unit: '日' };
}

function defaultInvoiceNumber(month) {
  const [year, mon] = month.split('-');
  return `${year}‐${mon}`;
}

function selectTemplateSheetName(workbook) {
  if (workbook.SheetNames.includes('★請求書マスター')) return '★請求書マスター';
  const master = workbook.SheetNames.find(name => name.includes('請求書') && name.includes('マスター'));
  if (master) return master;
  return workbook.SheetNames.find(name => name.includes('請求書')) || null;
}

export function getInvoiceTemplateStatus() {
  let sourceSheet = null;
  if (existsSync(TEMPLATE_PATH)) {
    try {
      const wb = XLSX.read(readFileSync(TEMPLATE_PATH), { type: 'buffer', cellStyles: true, cellDates: true });
      sourceSheet = selectTemplateSheetName(wb);
    } catch (_) {}
  }
  return {
    configured: existsSync(TEMPLATE_PATH),
    path: TEMPLATE_PATH,
    filename: existsSync(TEMPLATE_PATH) ? basename(TEMPLATE_PATH) : null,
    sourceSheet,
  };
}

export function saveInvoiceTemplate(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new Error('テンプレートが空です');
  const wb = XLSX.read(buffer, { type: 'buffer', cellStyles: true, cellDates: true });
  const sourceSheet = selectTemplateSheetName(wb);
  if (!sourceSheet) throw new Error('「請求書」シートが見つかりません');

  mkdirSync(TEMPLATE_DIR, { recursive: true });
  writeFileSync(TEMPLATE_PATH, buffer);
  return { ...getInvoiceTemplateStatus(), sourceSheet };
}

export function buildInvoicePreview(db, month) {
  validateMonth(month);
  ensureGenerationTable(db);

  const works = db.prepare(`
    SELECT * FROM work_records
    WHERE date LIKE ?
    ORDER BY date, id
  `).all(`${month}%`).filter(w => isOtec(w.client) && Number(w.income || 0) > 0);

  const rows = works.map((work, index) => {
    const qu = quantityAndUnit(work);
    return {
      no: index + 1,
      work_id: work.id,
      date: work.date,
      date_label: monthDay(work.date),
      description: invoiceDescription(work),
      quantity: qu.quantity,
      unit: qu.unit,
      unit_price: Number(work.income || 0),
      amount: Number(work.income || 0),
    };
  });

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
    invoice_number: prior?.invoice_number || defaultInvoiceNumber(month),
    invoice_date: prior?.invoice_date || firstDayOfNextMonth(month),
    due_date: prior?.due_date || lastDayOfMonth(month, 1),
    rows,
    subtotal,
    tax,
    total,
    tax_rate: 10,
    max_rows: MAX_ROWS,
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

function monthMemo(month) {
  const [y, m] = month.split('-').map(Number);
  return `${y}年${m}月分としてご請求申し上げます。`;
}

function displayInvoiceNumber(number) {
  const value = String(number || '').trim();
  return /^No[.．]?/i.test(value) ? value : `No.${value}`;
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

  mkdirSync(EXPORT_DIR, { recursive: true });
  const safeNumber = number.replace(/[^0-9A-Za-z_-]/g, '_');
  const filename = `請求書_${safeNumber}.xlsx`;
  const outputPath = resolve(EXPORT_DIR, filename);

  // Python スクリプトでテンプレートをコピーして値だけ差し替える。
  // openpyxl を使用するため画像・書式・結合セル等が完全保持される。
  const pyInput = JSON.stringify({
    template_path: TEMPLATE_PATH,
    output_path:   outputPath,
    month,
    invoice_number: number,
    invoice_date:   issueDate,
    due_date:       paymentDue,
    client:         preview.client,
    tax_rate:       10,
    memo:           monthMemo(month),
    rows:           preview.rows.map(r => ({
      no:          r.no,
      date_label:  r.date_label,
      description: r.description,
      quantity:    r.quantity,
      unit:        r.unit,
      unit_price:  r.unit_price,
      amount:      r.amount,
    })),
  });

  let pyOut;
  try {
    pyOut = execFileSync('python', [PY_SCRIPT, '--json', pyInput], {
      encoding: 'utf8',
      timeout:  30_000,
    });
  } catch (err) {
    throw new Error(`請求書生成（Python）失敗: ${err.stderr || err.message}`);
  }

  let pyResult;
  try {
    pyResult = JSON.parse(pyOut.trim());
  } catch {
    throw new Error(`請求書生成スクリプトの出力が不正です: ${pyOut}`);
  }
  if (!pyResult.ok) {
    throw new Error(`請求書生成エラー: ${pyResult.error}`);
  }

  const buffer = readFileSync(outputPath);

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
