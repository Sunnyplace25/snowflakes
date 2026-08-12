/**
 * jarvis/importers/revenue_writer.js
 * Soundrop Statement CSV から sf_revenue を更新する収益ライター
 *
 * 処理フロー:
 *   1. CSV 全行を読み込む
 *   2. (statement_period, transaction_month, ISRC, service) をキーに集計
 *      - Quantity と Net Revenue in USD を SUM
 *   3. ISRC → sf_tracks.id を解決
 *      - 解決できない ISRC は sf_revenue に書き込まず needs_review に記録
 *   4. 解決済み集計を sf_revenue へ UPSERT
 *      - ON CONFLICT DO UPDATE（INSERT OR REPLACE 禁止・id を維持）
 *
 * カラム定義:
 *   month             = Statement Period（Soundrop 明細発行月 YYYY-MM）
 *   transaction_month = Transaction Month（実際の再生・売上発生月 YYYY-MM）
 *   platform          = Service 列の値そのまま（例: 'TikTok', 'Apple Music'）
 *   amount            = Net Revenue in USD の SUM（USD建て）
 *   quantity          = Quantity の SUM
 *
 * 注意:
 *   - :memory: DB のみでテスト。business_data.db には触れない
 *   - sf_music_metrics への書き込みは Phase 5 で扱う
 */

'use strict';

import { parseCsv } from './parsers/csv_parser.js';

/**
 * Soundrop Statement CSV テキストを集計し sf_revenue に書き込む。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} csvText  Soundrop Statement CSV の生テキスト
 * @returns {{
 *   written:     number,
 *   needsReview: Array<{isrc:string, service:string, statementPeriod:string, transactionMonth:string, reason:string}>,
 * }}
 */
export function writeRevenue(db, csvText) {
  const rows = parseCsv(csvText);

  // ── 1. 集計 Map の構築 ─────────────────────────────────────────────────────
  // キー: `${statementPeriod}|${transactionMonth}|${isrc}|${service}`
  const aggMap = new Map();

  for (const row of rows) {
    const statementPeriod  = (row['Statement Period']   ?? '').trim();
    const transactionMonth = (row['Transaction Month']  ?? '').trim();
    const isrc             = (row['ISRC']               ?? '').trim();
    const service          = (row['Service']            ?? '').trim();
    const netRevenue       = parseFloat(row['Net Revenue in USD'] ?? '0') || 0;
    const quantity         = parseInt(row['Quantity']   ?? '0', 10) || 0;

    if (!statementPeriod || !transactionMonth || !isrc || !service) continue;

    const key = `${statementPeriod}|${transactionMonth}|${isrc}|${service}`;
    if (!aggMap.has(key)) {
      aggMap.set(key, {
        statementPeriod,
        transactionMonth,
        isrc,
        service,
        quantity: 0,
        amount:   0,
      });
    }
    const entry   = aggMap.get(key);
    entry.quantity += quantity;
    entry.amount   += netRevenue;
  }

  // ── 2. ISRC 解決 & UPSERT ─────────────────────────────────────────────────
  const stmtGetTrack = db.prepare('SELECT id FROM sf_tracks WHERE isrc = ?');

  const stmtUpsert = db.prepare(`
    INSERT INTO sf_revenue
      (date, month, transaction_month, source, platform, track_id,
       quantity, amount, currency, amount_jpy, import_source)
    VALUES (?, ?, ?, '音楽配信', ?, ?, ?, ?, 'USD', 0, 'csv')
    ON CONFLICT(month, transaction_month, platform, track_id)
      WHERE import_source IN ('csv', 'api') AND track_id IS NOT NULL
        AND transaction_month IS NOT NULL
    DO UPDATE SET
      quantity = excluded.quantity,
      amount   = excluded.amount
  `);

  const result = {
    written:     0,
    needsReview: [],
  };

  for (const [, entry] of aggMap) {
    const track = stmtGetTrack.get(entry.isrc);

    if (!track) {
      // ISRC 未解決 → sf_revenue に書き込まず needs_review に積む
      result.needsReview.push({
        isrc:             entry.isrc,
        service:          entry.service,
        statementPeriod:  entry.statementPeriod,
        transactionMonth: entry.transactionMonth,
        reason:           `ISRC "${entry.isrc}" が sf_tracks に未登録`,
      });
      continue;
    }

    stmtUpsert.run(
      entry.statementPeriod + '-01',  // date（月初固定）
      entry.statementPeriod,          // month = statement_period
      entry.transactionMonth,         // transaction_month
      entry.service,                  // platform
      track.id,                       // track_id
      entry.quantity,
      entry.amount,
    );
    result.written++;
  }

  return result;
}
