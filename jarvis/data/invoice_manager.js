/**
 * jarvis/data/invoice_manager.js
 * 請求書インポート DB CRUD
 *
 * 制約:
 *   - 個人情報は保存しない
 *   - dry-run (dryRun=true) ではDBを書き換えない
 *   - 重複検出: invoice_number UNIQUE + (invoice_id, source_row) UNIQUE
 *   - 再インポート時: 新規/重複/スキップをカウントして返す
 *   - 本番取込時は請求明細を work_records に自動反映する
 *   - 1明細に複数日が書かれている場合は、日ごとに work_records へ分割して反映する
 */

import { addWorkRecord, updateWorkRecordFull } from './work_record_manager.js';

// ─── 請求明細 → 仕事一覧 自動反映 ───────────────────────────────────────────

function ensureWorkLinkTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS business_invoice_work_links (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_line_id INTEGER NOT NULL REFERENCES business_invoice_lines(id),
      job_id          TEXT    NOT NULL,
      work_date       TEXT    NOT NULL,
      amount          INTEGER NOT NULL DEFAULT 0,
      created_at      TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
      UNIQUE(invoice_line_id, work_date),
      UNIQUE(job_id)
    );
    CREATE INDEX IF NOT EXISTS idx_biwl_line ON business_invoice_work_links(invoice_line_id);
    CREATE INDEX IF NOT EXISTS idx_biwl_date ON business_invoice_work_links(work_date);
  `);
}

function normalizeMatchText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[\s　]/g, '')
    .replace(/[・･,，.。:：;；\\()（）\[\]【】「」『』_-]/g, '')
    .replace(/[\/／]/g, '');
}

function isDescriptionMatch(a, b) {
  const na = normalizeMatchText(a);
  const nb = normalizeMatchText(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

function invoiceCategoryToWorkType(category) {
  if (category === 'スタジオ音声') return 'STUDIO';
  if (category === 'ロケ') return 'ロケ';
  if (String(category ?? '').includes('中継')) return '中継';
  return null;
}

function toHalfWidth(value) {
  return String(value ?? '').replace(/[０-９]/g, c =>
    String.fromCharCode(c.charCodeAt(0) - 0xFEE0)
  );
}

/**
 * 明細説明文に含まれる日付をすべて取り出す。
 * 例: "8/2、８/３" → [{month:8,day:2},{month:8,day:3}]
 *     "8/2、3"      → [{month:8,day:2},{month:8,day:3}]
 */
function extractMonthDays(description) {
  const s = toHalfWidth(description).replace(/／/g, '/');
  const out = [];
  const seen = new Set();

  const re = /(\d{1,2})\s*\/\s*(\d{1,2})/g;
  let m;
  let lastMonth = null;
  while ((m = re.exec(s)) !== null) {
    const month = parseInt(m[1], 10);
    const day = parseInt(m[2], 10);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const key = `${month}-${day}`;
      if (!seen.has(key)) {
        out.push({ month, day });
        seen.add(key);
      }
      lastMonth = month;
    }

    const after = s.slice(re.lastIndex);
    const short = after.match(/^\s*[、,，・･]\s*(\d{1,2})(?!\s*\/)/);
    if (short && lastMonth != null) {
      const shortDay = parseInt(short[1], 10);
      if (shortDay >= 1 && shortDay <= 31) {
        const key = `${lastMonth}-${shortDay}`;
        if (!seen.has(key)) {
          out.push({ month: lastMonth, day: shortDay });
          seen.add(key);
        }
      }
    }
  }

  return out;
}

function isoDate(year, month, day) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * business_invoice_lines 1行を、仕事日単位のパーツへ展開する。
 * DB上の work_date は従来互換のため最初の日付を保持しているが、説明文に複数日が
 * 記載されている場合はここで全日を復元する。
 */
function expandLineIntoWorkParts(line) {
  if (!line?.work_date || line.amount == null) return [];

  const [anchorYear, anchorMonth] = String(line.work_date).split('-').map(Number);
  if (!anchorYear || !anchorMonth) return [];

  const monthDays = extractMonthDays(line.description);
  let dates;
  if (monthDays.length <= 1) {
    dates = [line.work_date];
  } else {
    const firstMonth = monthDays[0].month;
    dates = monthDays.map(({ month, day }) => {
      let year = anchorYear;
      if (firstMonth === 12 && month === 1) year = anchorYear + 1;
      if (firstMonth === 1 && month === 12) year = anchorYear - 1;
      return isoDate(year, month, day);
    });
  }

  const total = Math.max(0, Math.round(Number(line.amount) || 0));
  const unit = Math.max(0, Math.round(Number(line.unit_price) || 0));
  const n = dates.length;

  let amounts;
  if (n === 1) {
    amounts = [total];
  } else if (unit > 0 && unit * n === total) {
    amounts = Array(n).fill(unit);
  } else if (unit > 0 && unit * n <= total && total - unit * n < Math.max(unit, 1)) {
    amounts = Array(n).fill(unit);
    amounts[n - 1] += total - unit * n;
  } else {
    const base = Math.floor(total / n);
    const rem = total - base * n;
    amounts = Array.from({ length: n }, (_, i) => base + (i < rem ? 1 : 0));
  }

  return dates.map((date, idx) => ({
    date,
    amount: amounts[idx],
    index: idx,
    count: n,
  }));
}

function emptyWorkSyncSummary() {
  return {
    created: 0,
    matched: 0,
    skipped: 0,
    ambiguous: 0,
    invoiceLines: 0,
    workParts: 0,
    details: [],
  };
}

function countWorkSync(summary, result, detail = null) {
  if (result.status === 'created') summary.created++;
  else if (result.status === 'matched') summary.matched++;
  else if (result.status === 'ambiguous') summary.ambiguous++;
  else summary.skipped++;

  if (detail && summary.details.length < 200) {
    summary.details.push({ ...detail, ...result });
  }
}

function linkInvoiceLineToWork(db, line, part, jobId) {
  ensureWorkLinkTable(db);
  db.prepare(`
    INSERT INTO business_invoice_work_links (invoice_line_id, job_id, work_date, amount)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(invoice_line_id, work_date) DO UPDATE SET
      job_id = excluded.job_id,
      amount = excluded.amount
  `).run(line.id, jobId, part.date, part.amount);

  if (!line.job_id) {
    db.prepare('UPDATE business_invoice_lines SET job_id = ? WHERE id = ? AND job_id IS NULL')
      .run(jobId, line.id);
    line.job_id = jobId;
  }
}

function updateMatchedWork(db, work, line, invoice, part) {
  updateWorkRecordFull(db, work.id, {
    income: part.amount,
    client: work.client || invoice.client_name || null,
    content: work.content || line.description || null,
    invoice_status: '請求済',
    payment_status: work.payment_status === '入金済' ? '入金済' : '未入金',
  });
  linkInvoiceLineToWork(db, line, part, work.job_id);
  return { status: 'matched', jobId: work.job_id, workId: work.id };
}

function syncWorkPart(db, line, invoice, part) {
  ensureWorkLinkTable(db);

  const existingLink = db.prepare(`
    SELECT l.job_id, w.id AS work_id
    FROM business_invoice_work_links l
    LEFT JOIN work_records w ON w.job_id = l.job_id
    WHERE l.invoice_line_id = ? AND l.work_date = ?
  `).get(line.id, part.date);
  if (existingLink?.work_id) {
    const work = db.prepare('SELECT * FROM work_records WHERE id = ?').get(existingLink.work_id);
    return updateMatchedWork(db, work, line, invoice, part);
  }

  if (line.job_id) {
    const legacy = db.prepare('SELECT * FROM work_records WHERE job_id = ?').get(line.job_id);
    if (legacy && legacy.date === part.date) {
      return updateMatchedWork(db, legacy, line, invoice, part);
    }
  }

  const candidates = db.prepare(`
    SELECT w.*
    FROM work_records w
    WHERE w.date = ?
      AND w.category = '音声仕事'
      AND NOT EXISTS (
        SELECT 1 FROM business_invoice_work_links wl
        WHERE wl.job_id = w.job_id AND wl.invoice_line_id <> ?
      )
      AND NOT EXISTS (
        SELECT 1 FROM business_invoice_lines l2
        WHERE l2.job_id = w.job_id AND l2.id <> ?
      )
    ORDER BY w.id
  `).all(part.date, line.id, line.id);

  const exactAmount = candidates.filter(w => Number(w.income) === part.amount);
  let match = null;

  if (exactAmount.length === 1) {
    match = exactAmount[0];
  } else if (exactAmount.length > 1) {
    const textMatched = exactAmount.filter(w => isDescriptionMatch(w.content, line.description));
    if (textMatched.length === 1) match = textMatched[0];
    else return { status: 'ambiguous', reason: '同日・同額の候補が複数' };
  } else {
    const textMatched = candidates.filter(w => isDescriptionMatch(w.content, line.description));
    if (textMatched.length === 1) {
      match = textMatched[0];
    } else if (textMatched.length > 1) {
      return { status: 'ambiguous', reason: '同日・同内容の候補が複数' };
    } else if (candidates.length === 1 && candidates[0].income == null) {
      match = candidates[0];
    }
  }

  if (match) return updateMatchedWork(db, match, line, invoice, part);

  try {
    const suffix = part.count > 1 ? `（${part.index + 1}/${part.count}日目）` : '';
    const { rowid, job_id } = addWorkRecord(db, {
      date: part.date,
      category: '音声仕事',
      work_type: invoiceCategoryToWorkType(line.category),
      content: line.description || null,
      client: invoice.client_name || null,
      income: part.amount,
      expense: null,
      work_hours: null,
      travel_hours: null,
      invoice_status: '請求済',
      payment_status: '未入金',
      memo: invoice.invoice_number
        ? `請求書 ${invoice.invoice_number} から自動反映${suffix}`
        : `請求書から自動反映${suffix}`,
    });
    linkInvoiceLineToWork(db, line, part, job_id);
    return { status: 'created', jobId: job_id, workId: rowid };
  } catch (e) {
    return { status: 'skipped', reason: e.message };
  }
}

function syncInvoiceLineToWorkRecords(db, line, invoice, workSync) {
  const parts = expandLineIntoWorkParts(line);
  workSync.invoiceLines++;
  workSync.workParts += parts.length;

  if (parts.length === 0) {
    countWorkSync(workSync, { status: 'skipped', reason: '日付または金額なし' }, {
      invoiceLineId: line.id,
      invoiceNumber: invoice.invoice_number,
      description: line.description,
    });
    return;
  }

  for (const part of parts) {
    const result = syncWorkPart(db, line, invoice, part);
    countWorkSync(workSync, result, {
      invoiceLineId: line.id,
      invoiceNumber: invoice.invoice_number,
      workDate: part.date,
      amount: part.amount,
      description: line.description,
    });
  }
}

function syncInvoiceIdToWorkRecords(db, invoiceId, workSync) {
  ensureWorkLinkTable(db);
  const invoice = db.prepare(`
    SELECT id, client_name, invoice_number
    FROM business_invoices
    WHERE id = ?
  `).get(invoiceId);
  if (!invoice) return;

  const lines = db.prepare(`
    SELECT id, work_date, description, quantity, unit_price, amount, category, job_id
    FROM business_invoice_lines
    WHERE invoice_id = ?
    ORDER BY id
  `).all(invoiceId);

  for (const line of lines) {
    syncInvoiceLineToWorkRecords(db, line, invoice, workSync);
  }
}

export function syncAllInvoiceLinesToWorkRecords(db, { year = null } = {}) {
  ensureWorkLinkTable(db);
  const workSync = emptyWorkSyncSummary();

  let invoiceIds;
  if (year) {
    invoiceIds = db.prepare(`
      SELECT DISTINCT i.id
      FROM business_invoices i
      JOIN business_invoice_lines l ON l.invoice_id = i.id
      WHERE l.work_date LIKE ? OR i.invoice_date LIKE ?
      ORDER BY i.id
    `).all(`${year}-%`, `${year}-%`);
  } else {
    invoiceIds = db.prepare('SELECT id FROM business_invoices ORDER BY id').all();
  }

  db.exec('BEGIN');
  try {
    for (const { id } of invoiceIds) syncInvoiceIdToWorkRecords(db, id, workSync);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  return { ok: true, invoices: invoiceIds.length, ...workSync };
}

// ─── インポート実行 ────────────────────────────────────────────────────────────
export function importInvoices(db, { filename, fileHash, invoices, dryRun = false }) {
  let newCount  = 0;
  let dupCount  = 0;
  let skipCount = 0;
  let warnCount = 0;
  const invoiceResults = [];
  const workSync = emptyWorkSyncSummary();

  if (dryRun) {
    for (const inv of invoices) {
      const existInv = db.prepare(
        'SELECT id FROM business_invoices WHERE invoice_number = ? AND source_sheet = ?'
      ).get(inv.invoiceNumber, inv.sourceSheet);

      if (existInv) {
        dupCount++;
        invoiceResults.push({ invoiceNumber: inv.invoiceNumber, status: 'duplicate', lineCount: 0 });
        continue;
      }

      newCount++;
      invoiceResults.push({
        invoiceNumber: inv.invoiceNumber,
        status: 'new',
        lineCount: inv.lines.length,
      });
    }
    return { newCount, dupCount, skipCount, warnCount, importId: null, invoiceResults, workSync };
  }

  ensureWorkLinkTable(db);

  let importId = null;
  db.exec('BEGIN');
  try {
    const importResult = db.prepare(`
      INSERT INTO business_invoice_imports
        (source_filename, file_hash, status, new_count, dup_count, skip_count, warn_count)
      VALUES (?, ?, 'completed', 0, 0, 0, 0)
    `).run(filename, fileHash);
    importId = importResult.lastInsertRowid;

    for (const inv of invoices) {
      const existInv = db.prepare(
        'SELECT id FROM business_invoices WHERE invoice_number = ? AND source_sheet = ?'
      ).get(inv.invoiceNumber, inv.sourceSheet);

      if (existInv) {
        dupCount++;
        syncInvoiceIdToWorkRecords(db, existInv.id, workSync);
        invoiceResults.push({
          invoiceNumber: inv.invoiceNumber,
          status: 'duplicate',
          lineCount: 0,
          existingId: existInv.id,
        });
        continue;
      }

      const invResult = db.prepare(`
        INSERT INTO business_invoices
          (import_id, client_name, invoice_number, invoice_date,
           subtotal, tax, total, source_sheet, source_filename)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        importId,
        inv.clientName,
        inv.invoiceNumber,
        inv.invoiceDate ?? null,
        inv.subtotal,
        inv.tax,
        inv.total,
        inv.sourceSheet,
        inv.sourceFilename,
      );
      const invoiceId = invResult.lastInsertRowid;

      let lineNew  = 0;
      let lineDup  = 0;
      for (const line of inv.lines) {
        try {
          db.prepare(`
            INSERT INTO business_invoice_lines
              (invoice_id, work_date, description, quantity, quantity_unit,
               unit_price, amount, category, job_id, source_row)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).run(
            invoiceId,
            line.workDate ?? null,
            line.description,
            line.quantity,
            line.quantityUnit,
            line.unitPrice,
            line.amount,
            line.category,
            line.jobId ?? null,
            line.sourceRow,
          );
          lineNew++;
        } catch (e) {
          if (e.message && e.message.includes('UNIQUE')) {
            lineDup++;
          } else {
            throw e;
          }
        }
      }

      syncInvoiceIdToWorkRecords(db, invoiceId, workSync);

      newCount++;
      warnCount += (inv.lines.length - lineNew - lineDup > 0) ? 1 : 0;
      invoiceResults.push({
        invoiceNumber: inv.invoiceNumber,
        status: 'new',
        invoiceId,
        lineCount: lineNew,
        dupLines: lineDup,
      });
    }

    db.prepare(`
      UPDATE business_invoice_imports
      SET new_count=?, dup_count=?, skip_count=?, warn_count=?
      WHERE id=?
    `).run(newCount, dupCount, skipCount, warnCount, importId);

    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  return { newCount, dupCount, skipCount, warnCount, importId, invoiceResults, workSync };
}

// ─── インポート履歴一覧 ───────────────────────────────────────────────────────
export function getImportHistory(db, limit = 20) {
  return db.prepare(`
    SELECT id, source_filename, file_hash, imported_at, status,
           new_count, dup_count, skip_count, warn_count
    FROM business_invoice_imports
    ORDER BY imported_at DESC
    LIMIT ?
  `).all(limit);
}

// ─── 年別・月別集計 ───────────────────────────────────────────────────────────
export function getInvoiceAnalytics(db) {
  const byYear = db.prepare(`
    SELECT strftime('%Y', l.work_date) AS year,
           COUNT(*) AS line_count,
           SUM(l.amount) AS subtotal
    FROM business_invoice_lines l
    WHERE l.work_date IS NOT NULL
    GROUP BY year
    ORDER BY year
  `).all();

  const byMonth = db.prepare(`
    SELECT strftime('%Y-%m', l.work_date) AS month,
           COUNT(*) AS line_count,
           SUM(l.amount) AS subtotal
    FROM business_invoice_lines l
    WHERE l.work_date IS NOT NULL
    GROUP BY month
    ORDER BY month
  `).all();

  const byCategory = db.prepare(`
    SELECT l.category,
           COUNT(*) AS line_count,
           SUM(l.amount) AS subtotal
    FROM business_invoice_lines l
    GROUP BY l.category
    ORDER BY subtotal DESC
  `).all();

  const byClient = db.prepare(`
    SELECT i.client_name,
           COUNT(l.id) AS line_count,
           SUM(l.amount) AS subtotal
    FROM business_invoice_lines l
    JOIN business_invoices i ON i.id = l.invoice_id
    GROUP BY i.client_name
    ORDER BY subtotal DESC
  `).all();

  const yearRows = byYear.map((row, idx) => {
    const prev = byYear[idx - 1];
    return {
      year:         row.year,
      lineCount:    row.line_count,
      subtotal:     row.subtotal,
      prevSubtotal: prev ? prev.subtotal : null,
      yoyRate:      prev && prev.subtotal > 0
        ? Math.round((row.subtotal / prev.subtotal - 1) * 1000) / 10
        : null,
    };
  });

  return { byYear: yearRows, byMonth, byCategory, byClient };
}

// ─── 年別絞り込み集計 ─────────────────────────────────────────────────────────
export function getAnalyticsByYear(db, year) {
  const y = String(year);

  const summary = db.prepare(`
    SELECT COUNT(*) AS line_count,
           SUM(l.amount) AS subtotal,
           ROUND(CAST(SUM(l.amount) AS REAL) / MAX(COUNT(*), 1)) AS avg_amount
    FROM business_invoice_lines l
    WHERE strftime('%Y', l.work_date) = ?
  `).get(y);

  const byMonth = db.prepare(`
    SELECT strftime('%Y-%m', l.work_date) AS month,
           COUNT(*) AS line_count,
           SUM(l.amount) AS subtotal
    FROM business_invoice_lines l
    WHERE strftime('%Y', l.work_date) = ?
    GROUP BY month
    ORDER BY month
  `).all(y);

  const byCategory = db.prepare(`
    SELECT l.category,
           COUNT(*) AS line_count,
           SUM(l.amount) AS subtotal
    FROM business_invoice_lines l
    WHERE strftime('%Y', l.work_date) = ?
    GROUP BY l.category
    ORDER BY subtotal DESC
  `).all(y);

  const prevYear = String(parseInt(y, 10) - 1);
  const prevSummary = db.prepare(`
    SELECT SUM(l.amount) AS subtotal FROM business_invoice_lines l
    WHERE strftime('%Y', l.work_date) = ?
  `).get(prevYear);

  const yoyRate = (prevSummary?.subtotal ?? 0) > 0
    ? Math.round((summary.subtotal / prevSummary.subtotal - 1) * 1000) / 10
    : null;

  return {
    year:         y,
    lineCount:    summary?.line_count ?? 0,
    subtotal:     summary?.subtotal   ?? 0,
    avgAmount:    summary?.avg_amount ?? 0,
    prevSubtotal: prevSummary?.subtotal ?? 0,
    yoyRate,
    byMonth,
    byCategory,
  };
}

// ─── 明細一覧（絞り込みあり）─────────────────────────────────────────────────
export function getInvoiceLines(db, { year, month, category, limit = 200, offset = 0 } = {}) {
  const conditions = [];
  const params = [];

  if (year)     { conditions.push("strftime('%Y', l.work_date) = ?");    params.push(String(year)); }
  if (month)    { conditions.push("strftime('%Y-%m', l.work_date) = ?"); params.push(month); }
  if (category) { conditions.push('l.category = ?');                     params.push(category); }

  const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : '';

  return db.prepare(`
    SELECT
      l.id, l.work_date, l.description, l.quantity, l.quantity_unit,
      l.unit_price, l.amount, l.category, l.job_id, l.source_row,
      i.invoice_number, i.client_name, i.invoice_date, i.source_sheet
    FROM business_invoice_lines l
    JOIN business_invoices i ON i.id = l.invoice_id
    ${where}
    ORDER BY l.work_date ASC, l.id ASC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
}

// ─── 年一覧（分析タブの年切り替え用）────────────────────────────────────────
export function getAvailableYears(db) {
  const rows = db.prepare(`
    SELECT DISTINCT strftime('%Y', work_date) AS year
    FROM business_invoice_lines
    WHERE work_date IS NOT NULL
    ORDER BY year DESC
  `).all();
  return rows.map(r => r.year).filter(Boolean);
}
