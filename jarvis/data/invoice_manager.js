/**
 * jarvis/data/invoice_manager.js
 * 請求書インポート DB CRUD
 *
 * 制約:
 *   - 個人情報は保存しない
 *   - dry-run (dryRun=true) ではDBを書き換えない
 *   - 重複検出: invoice_number UNIQUE + (invoice_id, source_row) UNIQUE
 *   - 再インポート時: 新規/重複/スキップをカウントして返す
 */

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
 * @returns {{ newCount, dupCount, skipCount, warnCount, importId, invoiceResults }}
 */
export function importInvoices(db, { filename, fileHash, invoices, dryRun = false }) {
  let newCount  = 0;
  let dupCount  = 0;
  let skipCount = 0;
  let warnCount = 0;
  const invoiceResults = [];

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
    return { newCount, dupCount, skipCount, warnCount, importId: null, invoiceResults };
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

  return { newCount, dupCount, skipCount, warnCount, importId, invoiceResults };
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
