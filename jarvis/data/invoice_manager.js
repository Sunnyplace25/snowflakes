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
 */

import { addWorkRecord, updateWorkRecordFull } from './work_record_manager.js';

// ─── 請求明細 → 仕事一覧 自動反映 ───────────────────────────────────────────

function normalizeMatchText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[\s　]/g, '')
    .replace(/[・･,，.。:：;；/\\()（）\[\]【】「」『』_-]/g, '');
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

function emptyWorkSyncSummary() {
  return { created: 0, matched: 0, skipped: 0, ambiguous: 0 };
}

function countWorkSync(summary, result) {
  if (result.status === 'created') summary.created++;
  else if (result.status === 'matched') summary.matched++;
  else if (result.status === 'ambiguous') summary.ambiguous++;
  else summary.skipped++;
}

/**
 * 1請求明細を work_records と照合し、自動反映する。
 *
 * 照合順:
 *  1. 同日・同額が1件なら既存仕事にリンク
 *  2. 同日・仕事内容が一致するものが1件なら既存仕事にリンクし、請求額を確定値として反映
 *  3. 候補が複数なら自動決定せず保留
 *  4. 候補がなければ新規仕事を作成
 *
 * 既存仕事にリンクする場合、経費・労働時間など請求書に存在しない情報は変更しない。
 */
function syncInvoiceLineToWorkRecord(db, line, invoice) {
  if (!line?.id || !line.work_date || line.amount == null) {
    return { status: 'skipped', reason: '日付または金額なし' };
  }

  // 既にリンク済みなら二重反映しない。
  if (line.job_id) {
    const linked = db.prepare('SELECT id FROM work_records WHERE job_id = ?').get(line.job_id);
    if (linked) return { status: 'matched', jobId: line.job_id, alreadyLinked: true };
  }

  // 別の請求明細にリンク済みの仕事は候補から除外。
  const candidates = db.prepare(`
    SELECT w.*
    FROM work_records w
    WHERE w.date = ?
      AND w.category = '音声仕事'
      AND NOT EXISTS (
        SELECT 1
        FROM business_invoice_lines l2
        WHERE l2.job_id = w.job_id
          AND l2.id <> ?
      )
    ORDER BY w.id
  `).all(line.work_date, line.id);

  const amount = Math.round(Number(line.amount));
  const exactAmount = candidates.filter(w => Number(w.income) === amount);

  let match = null;
  if (exactAmount.length === 1) {
    match = exactAmount[0];
  } else if (exactAmount.length > 1) {
    const textMatched = exactAmount.filter(w => isDescriptionMatch(w.content, line.description));
    if (textMatched.length === 1) match = textMatched[0];
    else return { status: 'ambiguous', reason: '同日・同額の候補が複数' };
  } else {
    const textMatched = candidates.filter(w => isDescriptionMatch(w.content, line.description));
    if (textMatched.length === 1) match = textMatched[0];
    else if (textMatched.length > 1) {
      return { status: 'ambiguous', reason: '同日・同内容の候補が複数' };
    }
  }

  if (match) {
    // 請求額を確定値として収入へ反映。既存の経費・労働時間等は保持する。
    updateWorkRecordFull(db, match.id, {
      income: amount,
      client: match.client || invoice.client_name || null,
      content: match.content || line.description || null,
      invoice_status: '請求済',
      payment_status: match.payment_status === '入金済' ? '入金済' : '未入金',
    });
    db.prepare('UPDATE business_invoice_lines SET job_id = ? WHERE id = ?')
      .run(match.job_id, line.id);
    return { status: 'matched', jobId: match.job_id, workId: match.id };
  }

  try {
    const { rowid, job_id } = addWorkRecord(db, {
      date: line.work_date,
      category: '音声仕事',
      work_type: invoiceCategoryToWorkType(line.category),
      content: line.description || null,
      client: invoice.client_name || null,
      income: amount,
      expense: null,
      work_hours: null,
      travel_hours: null,
      invoice_status: '請求済',
      payment_status: '未入金',
      memo: invoice.invoice_number
        ? `請求書 ${invoice.invoice_number} から自動反映`
        : '請求書から自動反映',
    });
    db.prepare('UPDATE business_invoice_lines SET job_id = ? WHERE id = ?')
      .run(job_id, line.id);
    return { status: 'created', jobId: job_id, workId: rowid };
  } catch (e) {
    // 完全休日など、JARVIS側の整合性ルールに触れる場合は請求書取込自体を失敗させず保留。
    return { status: 'skipped', reason: e.message };
  }
}

function syncInvoiceIdToWorkRecords(db, invoiceId, workSync) {
  const invoice = db.prepare(`
    SELECT id, client_name, invoice_number
    FROM business_invoices
    WHERE id = ?
  `).get(invoiceId);
  if (!invoice) return;

  const lines = db.prepare(`
    SELECT id, work_date, description, amount, category, job_id
    FROM business_invoice_lines
    WHERE invoice_id = ?
    ORDER BY id
  `).all(invoiceId);

  for (const line of lines) {
    countWorkSync(workSync, syncInvoiceLineToWorkRecord(db, line, invoice));
  }
}

// ─── インポート実行 ────────────────────────────────────────────────────────────
/**
 * パース済みデータをDBに保存する。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} opts
 * @param {string}  opts.filename   - 元ファイル名
 * @param {string}  opts.fileHash   - SHA-256ハッシュ
 * @param {Array}   opts.invoices   - parseExcel() の invoices
 * @param {boolean} [opts.dryRun=false] - true なら DB を書き換えない
 * @returns {{ newCount, dupCount, skipCount, warnCount, importId, invoiceResults, workSync }}
 */
export function importInvoices(db, { filename, fileHash, invoices, dryRun = false }) {
  let newCount  = 0;
  let dupCount  = 0;
  let skipCount = 0;
  let warnCount = 0;
  const invoiceResults = [];
  const workSync = emptyWorkSyncSummary();

  // ─ dry-run は DB 操作なしで件数だけ計算
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

  // ─ 本番インポート（手動トランザクション）
  let importId = null;
  db.exec('BEGIN');
  try {
    // import ログレコードを作成（後で件数を更新）
    const importResult = db.prepare(`
      INSERT INTO business_invoice_imports
        (source_filename, file_hash, status, new_count, dup_count, skip_count, warn_count)
      VALUES (?, ?, 'completed', 0, 0, 0, 0)
    `).run(filename, fileHash);
    importId = importResult.lastInsertRowid;

    for (const inv of invoices) {
      // 重複チェック: (invoice_number, source_sheet) の組み合わせ
      // シート名誤記で同番号が複数存在する場合は別シートとして区別して取込む
      const existInv = db.prepare(
        'SELECT id FROM business_invoices WHERE invoice_number = ? AND source_sheet = ?'
      ).get(inv.invoiceNumber, inv.sourceSheet);

      if (existInv) {
        dupCount++;
        // 既に請求書自体が取込済みでも、未リンク明細を仕事一覧へ反映できる。
        syncInvoiceIdToWorkRecords(db, existInv.id, workSync);
        invoiceResults.push({
          invoiceNumber: inv.invoiceNumber,
          status: 'duplicate',
          lineCount: 0,
          existingId: existInv.id,
        });
        continue;
      }

      // 請求書レコード挿入
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

      // 明細行挿入
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

      // 新規請求書の全明細を仕事一覧へ反映。
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

    // import ログを更新
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
  // 年別合計
  const byYear = db.prepare(`
    SELECT
      strftime('%Y', l.work_date) AS year,
      COUNT(*) AS line_count,
      SUM(l.amount) AS subtotal
    FROM business_invoice_lines l
    WHERE l.work_date IS NOT NULL
    GROUP BY year
    ORDER BY year
  `).all();

  // 月別合計（全期間）
  const byMonth = db.prepare(`
    SELECT
      strftime('%Y-%m', l.work_date) AS month,
      COUNT(*) AS line_count,
      SUM(l.amount) AS subtotal
    FROM business_invoice_lines l
    WHERE l.work_date IS NOT NULL
    GROUP BY month
    ORDER BY month
  `).all();

  // カテゴリ別合計（全期間）
  const byCategory = db.prepare(`
    SELECT
      l.category,
      COUNT(*) AS line_count,
      SUM(l.amount) AS subtotal
    FROM business_invoice_lines l
    GROUP BY l.category
    ORDER BY subtotal DESC
  `).all();

  // 取引先別合計
  const byClient = db.prepare(`
    SELECT
      i.client_name,
      COUNT(l.id) AS line_count,
      SUM(l.amount) AS subtotal
    FROM business_invoice_lines l
    JOIN business_invoices i ON i.id = l.invoice_id
    GROUP BY i.client_name
    ORDER BY subtotal DESC
  `).all();

  // 年別・前年比（year, subtotal, prev_subtotal, yoy_rate）
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
    SELECT
      COUNT(*) AS line_count,
      SUM(l.amount) AS subtotal,
      ROUND(CAST(SUM(l.amount) AS REAL) / MAX(COUNT(*), 1)) AS avg_amount
    FROM business_invoice_lines l
    WHERE strftime('%Y', l.work_date) = ?
  `).get(y);

  const byMonth = db.prepare(`
    SELECT
      strftime('%Y-%m', l.work_date) AS month,
      COUNT(*) AS line_count,
      SUM(l.amount) AS subtotal
    FROM business_invoice_lines l
    WHERE strftime('%Y', l.work_date) = ?
    GROUP BY month
    ORDER BY month
  `).all(y);

  const byCategory = db.prepare(`
    SELECT
      l.category,
      COUNT(*) AS line_count,
      SUM(l.amount) AS subtotal
    FROM business_invoice_lines l
    WHERE strftime('%Y', l.work_date) = ?
    GROUP BY l.category
    ORDER BY subtotal DESC
  `).all(y);

  // 前年比
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
      l.unit_price, l.amount, l.category, l.source_row,
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
