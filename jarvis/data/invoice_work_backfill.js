/**
 * jarvis/data/invoice_work_backfill.js
 *
 * 既にDBへ取り込み済みの請求書明細を work_records へ後追い反映する。
 * 古いインポートで work_date が NULL の行や、1明細に複数日が書かれた行にも対応する。
 */

import { addWorkRecord, updateWorkRecordFull } from './work_record_manager.js';

function ensureLinkTable(db) {
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

function toHalfWidth(value) {
  return String(value ?? '')
    .replace(/[！-～]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0))
    .replace(/　/g, ' ');
}

function normalizeText(value) {
  return toHalfWidth(value)
    .toLowerCase()
    .replace(/明治カップ|meiji\s*cup|meijiカップ/g, 'meijicup')
    .replace(/[\s]/g, '')
    .replace(/[・･,，.。:：;；\\()（）\[\]【】「」『』_\-\/]/g, '');
}

function textMatches(a, b) {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  return !!na && !!nb && (na === nb || na.includes(nb) || nb.includes(na));
}

function workType(category, description = '') {
  if (category === 'スタジオ音声') return 'STUDIO';
  if (category === 'ロケ') return 'ロケ';
  if (String(category ?? '').includes('中継')) return '中継';

  // 古い分類ルールで「その他」になっていた行も仕事内容から回復する。
  const d = normalizeText(description);
  if (
    d.includes('meijicup') || d.includes('競馬') || d.includes('ファイターズ') ||
    d.includes('エスコン') || d.includes('マラソン') || d.includes('レバンガ')
  ) return '中継';
  if (d.includes('sasaru') || d.includes('ロケ')) return 'ロケ';
  if (d.includes('みんテレ') || d.includes('スタジオ') || d.includes('uhb') || d.includes('tvh')) return 'STUDIO';
  return null;
}

function extractMonthDays(description) {
  const s = toHalfWidth(description).replace(/／/g, '/');
  const out = [];
  const seen = new Set();
  const re = /(\d{1,2})\s*\/\s*(\d{1,2})/g;
  let m;
  let lastMonth = null;

  while ((m = re.exec(s)) !== null) {
    const month = Number(m[1]);
    const day = Number(m[2]);
    if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
      const key = `${month}-${day}`;
      if (!seen.has(key)) {
        out.push({ month, day });
        seen.add(key);
      }
      lastMonth = month;
    }

    // 8/2、3 のように2日目の月が省略された表記も拾う。
    const short = s.slice(re.lastIndex).match(/^\s*[、,，・･]\s*(\d{1,2})(?!\s*\/)/);
    if (short && lastMonth != null) {
      const day2 = Number(short[1]);
      if (day2 >= 1 && day2 <= 31) {
        const key = `${lastMonth}-${day2}`;
        if (!seen.has(key)) {
          out.push({ month: lastMonth, day: day2 });
          seen.add(key);
        }
      }
    }
  }
  return out;
}

function iso(year, month, day) {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

function expandParts(line) {
  const md = extractMonthDays(line.description);
  const anchor = line.work_date || line.invoice_date || null;
  const [anchorYear, anchorMonth] = anchor ? String(anchor).split('-').map(Number) : [];
  let dates = [];

  if (md.length === 0) {
    if (line.work_date) dates = [line.work_date];
  } else if (line.work_date && md.length === 1) {
    dates = [line.work_date];
  } else if (anchorYear && anchorMonth) {
    const firstMonth = md[0].month;
    dates = md.map(({ month, day }) => {
      let year = anchorYear;
      if (!line.work_date) {
        // 1月請求に12月実績があるような年跨ぎ。
        if (month > anchorMonth) year = anchorYear - 1;
      } else {
        if (firstMonth === 12 && month === 1) year = anchorYear + 1;
        if (firstMonth === 1 && month === 12) year = anchorYear - 1;
      }
      return iso(year, month, day);
    });
  }

  if (!dates.length) return [];

  const total = Math.max(0, Math.round(Number(line.amount) || 0));
  const unit = Math.max(0, Math.round(Number(line.unit_price) || 0));
  const n = dates.length;
  let amounts;

  if (n === 1) {
    amounts = [total];
  } else if (unit > 0 && unit * n === total) {
    amounts = Array(n).fill(unit);
  } else {
    const base = Math.floor(total / n);
    const remainder = total - base * n;
    amounts = Array.from({ length: n }, (_, i) => base + (i < remainder ? 1 : 0));
  }

  return dates.map((date, i) => ({ date, amount: amounts[i], index: i, count: n }));
}

function link(db, line, part, jobId) {
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

function updateMatched(db, work, line, part) {
  updateWorkRecordFull(db, work.id, {
    work_type: work.work_type || workType(line.category, line.description),
    income: part.amount,
    client: work.client || line.client_name || null,
    content: work.content || line.description || null,
    invoice_status: '請求済',
    payment_status: work.payment_status === '入金済' ? '入金済' : '未入金',
  });
  link(db, line, part, work.job_id);
  return { status: 'matched', workId: work.id, jobId: work.job_id };
}

function syncPart(db, line, part) {
  const existingLink = db.prepare(`
    SELECT wl.job_id, w.id AS work_id
    FROM business_invoice_work_links wl
    LEFT JOIN work_records w ON w.job_id = wl.job_id
    WHERE wl.invoice_line_id = ? AND wl.work_date = ?
  `).get(line.id, part.date);
  if (existingLink?.work_id) {
    const work = db.prepare('SELECT * FROM work_records WHERE id = ?').get(existingLink.work_id);
    return updateMatched(db, work, line, part);
  }

  if (line.job_id) {
    const legacy = db.prepare('SELECT * FROM work_records WHERE job_id = ?').get(line.job_id);
    if (legacy && legacy.date === part.date) return updateMatched(db, legacy, line, part);
  }

  const candidates = db.prepare(`
    SELECT w.*
    FROM work_records w
    WHERE w.date = ? AND w.category = '音声仕事'
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

  const exact = candidates.filter(w => Number(w.income) === part.amount);
  let match = null;
  if (exact.length === 1) {
    match = exact[0];
  } else if (exact.length > 1) {
    const byText = exact.filter(w => textMatches(w.content, line.description));
    if (byText.length === 1) match = byText[0];
    else return { status: 'ambiguous', reason: '同日・同額の候補が複数' };
  } else {
    const byText = candidates.filter(w => textMatches(w.content, line.description));
    if (byText.length === 1) match = byText[0];
    else if (byText.length > 1) return { status: 'ambiguous', reason: '同日・同内容の候補が複数' };
    else if (candidates.length === 1 && candidates[0].income == null) match = candidates[0];
  }

  if (match) return updateMatched(db, match, line, part);

  try {
    const suffix = part.count > 1 ? `（${part.index + 1}/${part.count}日目）` : '';
    const { rowid, job_id } = addWorkRecord(db, {
      date: part.date,
      category: '音声仕事',
      work_type: workType(line.category, line.description),
      content: line.description || null,
      client: line.client_name || null,
      income: part.amount,
      expense: null,
      work_hours: null,
      travel_hours: null,
      invoice_status: '請求済',
      payment_status: '未入金',
      memo: line.invoice_number
        ? `請求書 ${line.invoice_number} から自動反映${suffix}`
        : `請求書から自動反映${suffix}`,
    });
    link(db, line, part, job_id);
    return { status: 'created', workId: rowid, jobId: job_id };
  } catch (e) {
    return { status: 'skipped', reason: e.message };
  }
}

export function syncAllInvoiceLinesToWorkRecords(db, { year = null } = {}) {
  ensureLinkTable(db);
  const params = [];
  let where = '';
  if (year) {
    where = 'WHERE (l.work_date LIKE ? OR (l.work_date IS NULL AND i.invoice_date LIKE ?))';
    params.push(`${year}-%`, `${year}-%`);
  }

  const lines = db.prepare(`
    SELECT l.id, l.work_date, l.description, l.quantity, l.unit_price, l.amount,
           l.category, l.job_id,
           i.invoice_number, i.invoice_date, i.client_name
    FROM business_invoice_lines l
    JOIN business_invoices i ON i.id = l.invoice_id
    ${where}
    ORDER BY i.id, l.id
  `).all(...params);

  const summary = {
    ok: true,
    invoiceLines: lines.length,
    workParts: 0,
    created: 0,
    matched: 0,
    ambiguous: 0,
    skipped: 0,
    details: [],
  };

  db.exec('BEGIN');
  try {
    for (const line of lines) {
      const parts = expandParts(line);
      summary.workParts += parts.length;

      if (!line.work_date && parts.length) {
        db.prepare('UPDATE business_invoice_lines SET work_date = ? WHERE id = ? AND work_date IS NULL')
          .run(parts[0].date, line.id);
        line.work_date = parts[0].date;
      }

      if (!parts.length) {
        summary.skipped++;
        if (summary.details.length < 200) summary.details.push({
          invoiceLineId: line.id,
          description: line.description,
          status: 'skipped',
          reason: '日付を復元できませんでした',
        });
        continue;
      }

      for (const part of parts) {
        const result = syncPart(db, line, part);
        if (result.status === 'created') summary.created++;
        else if (result.status === 'matched') summary.matched++;
        else if (result.status === 'ambiguous') summary.ambiguous++;
        else summary.skipped++;

        if (summary.details.length < 200) summary.details.push({
          invoiceLineId: line.id,
          invoiceNumber: line.invoice_number,
          workDate: part.date,
          amount: part.amount,
          description: line.description,
          ...result,
        });
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  return summary;
}
