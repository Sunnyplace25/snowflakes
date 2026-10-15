/**
 * jarvis/importers/soundrop.js
 * Soundrop CSV/TSV インポーター エントリーポイント
 *
 * 制約：
 * - 音源・画像ファイルには一切触れない
 * - 不明なトラックは status='unknown' のまま。タイトル等を推測しない
 * - テストは :memory: DBのみ使用すること
 */

import { readFileSync } from 'fs';
import { basename }     from 'path';
import { parseCsv }     from './parsers/csv_parser.js';
import { matchTrack }   from './matchers/track_matcher.js';
import { writeMetrics } from './writers/metrics_writer.js';

/**
 * Soundrop CSV/TSV ファイルをインポートする。
 *
 * 処理フロー:
 *   1. ファイル読み込み・パース
 *   2. sf_distribution_imports レコード作成
 *   3. 各行: マッチ → sf_distribution_import_rows 保存
 *   4. マッチ済み行: sf_music_metrics / sf_revenue へ書き込み
 *   5. インポート統計を更新
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} filePath - CSVファイルパス
 * @param {object} [options]
 * @param {string} [options.distributor='soundrop']
 * @param {string} [options.report_period] - 'YYYY-MM' 等のレポート期間
 * @param {string} [options.delimiter=','] - 区切り文字
 * @returns {{ importId: number, rowCount: number, matchedCount: number, unmatchedCount: number }}
 */
export async function importFile(db, filePath, options = {}) {
  const distributor   = options.distributor   ?? 'soundrop';
  const report_period = options.report_period ?? null;
  const delimiter     = options.delimiter     ?? ',';

  // ── 1. ファイル読み込み ────────────────────────────────────────────────────
  let text;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (e) {
    throw new Error(`ファイル読み込みエラー: ${filePath} — ${e.message}`);
  }

  const fileName = basename(filePath);
  const rows     = parseCsv(text, { delimiter });

  // ── 2. sf_distribution_imports レコード作成 ────────────────────────────────
  const importResult = db.prepare(`
    INSERT INTO sf_distribution_imports
      (distributor, source_type, file_name, file_path, report_period,
       row_count, import_status)
    VALUES (?, 'csv', ?, ?, ?, ?, 'processing')
  `).run(distributor, fileName, filePath, report_period, rows.length);

  const importId = Number(importResult.lastInsertRowid);

  let matchedCount   = 0;
  let unmatchedCount = 0;

  try {
    // ── 3 & 4. 各行処理 ────────────────────────────────────────────────────
    for (let i = 0; i < rows.length; i++) {
      const row         = rows[i];
      const matchResult = matchTrack(db, row);
      const isUnmatched = matchResult.method === 'unmatched';

      if (isUnmatched) {
        unmatchedCount++;
      } else {
        matchedCount++;
      }

      // フィールド正規化（旧: lowercase snake_case / 新: Title Case + スペース）
      const rowPlatform = row.platform     || row.Platform     || row.service           || row.Service   || null;
      const rowPeriod   = row.period       || row.Period       || row.transaction_month  || row['Transaction Month'] || report_period || null;
      const rowStreams   = row.streams   != null ? Number(row.streams)
                        : row.quantity  != null ? Number(row.quantity)
                        : row.Quantity  != null ? Number(row.Quantity) : null;
      const rowRevenue  = row.revenue    != null ? Number(row.revenue)
                        : row.revenue_usd != null ? Number(row.revenue_usd)
                        : row.revenue_amount != null ? Number(row.revenue_amount)
                        : row['Net Revenue in USD'] != null ? Number(row['Net Revenue in USD'])
                        : row['Amount Due in USD']  != null ? Number(row['Amount Due in USD']) : null;
      const rowCurrency = row.currency || row.Currency || 'USD';

      // sf_distribution_import_rows に保存
      db.prepare(`
        INSERT INTO sf_distribution_import_rows
          (import_id, row_index, raw_data,
           matched_track_id, matched_release_id, match_method,
           platform, period, streams, revenue_amount, currency,
           needs_review)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        importId,
        i,
        JSON.stringify(row),
        matchResult.track_id   ?? null,
        matchResult.release_id ?? null,
        matchResult.method,
        rowPlatform,
        rowPeriod,
        rowStreams,
        rowRevenue,
        rowCurrency,
        isUnmatched ? 1 : 0,
      );

      // マッチ済み行を sf_music_metrics へ書き込む
      if (!isUnmatched) {
        const importRowForWriter = {
          platform:       rowPlatform,
          period:         rowPeriod,
          streams:        rowStreams  ?? 0,
          revenue_amount: rowRevenue  ?? 0,
          currency:       rowCurrency,
        };
        writeMetrics(db, importRowForWriter, matchResult);
      }
    }

    // ── 5. インポート統計を更新 ─────────────────────────────────────────────
    const finalStatus = rows.length === 0
      ? 'completed'
      : unmatchedCount > 0 && matchedCount === 0
        ? 'partial'
        : unmatchedCount > 0
          ? 'partial'
          : 'completed';

    db.prepare(`
      UPDATE sf_distribution_imports SET
        import_status   = ?,
        matched_count   = ?,
        unmatched_count = ?
      WHERE id = ?
    `).run(finalStatus, matchedCount, unmatchedCount, importId);

  } catch (e) {
    // エラー時はログを記録して failed に更新
    db.prepare(`
      UPDATE sf_distribution_imports SET
        import_status = 'failed',
        error_log     = ?
      WHERE id = ?
    `).run(e.message, importId);
    throw e;
  }

  return { importId, rowCount: rows.length, matchedCount, unmatchedCount };
}

/**
 * 指定インポートIDのレビュー待ち行を返す。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} importId
 * @returns {object[]}
 */
export function getUnreviewedRows(db, importId) {
  return db.prepare(`
    SELECT * FROM sf_distribution_import_rows
    WHERE import_id = ? AND needs_review = 1
    ORDER BY row_index
  `).all(importId);
}
