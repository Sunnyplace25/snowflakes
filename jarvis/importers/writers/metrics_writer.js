/**
 * jarvis/importers/writers/metrics_writer.js
 * マッチ済みインポート行を sf_music_metrics / sf_revenue に書き込む。
 *
 * - track_id が取れた行のみ sf_music_metrics へ書き込む
 * - 収益データがある行は sf_revenue へも書き込む
 * - 重複は INSERT OR IGNORE で冪等に処理する
 */

/**
 * マッチ済みインポート行をメトリクス・収益テーブルに書き込む。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} importRow - sf_distribution_import_rows の行データ
 * @param {{ track_id: number|null, release_id: number|null, method: string }} matchResult
 */
export function writeMetrics(db, importRow, matchResult) {
  const { track_id, method } = matchResult;

  // track_id が取れていない場合はスキップ（アンマッチ行）
  if (!track_id || method === 'unmatched') return;

  const platform   = importRow.platform  || 'other';
  const period     = importRow.period    || '';
  const streams    = importRow.streams   != null ? Number(importRow.streams) : 0;
  const revenue    = importRow.revenue_amount != null ? Number(importRow.revenue_amount) : 0;
  const currency   = importRow.currency  || 'JPY';

  // 日付・月を period から推定（YYYY-MM 形式なら月次、YYYY-MM-DD なら日次）
  let date        = period || '1970-01-01';
  let month       = period ? period.slice(0, 7) : '1970-01';
  let granularity = 'monthly';

  if (/^\d{4}-\d{2}-\d{2}$/.test(period)) {
    granularity = 'daily';
    date        = period;
    month       = period.slice(0, 7);
  } else if (/^\d{4}-\d{2}$/.test(period)) {
    granularity = 'monthly';
    date        = period + '-01';
    month       = period;
  }

  // sf_music_metrics への INSERT OR IGNORE
  try {
    db.prepare(`
      INSERT OR IGNORE INTO sf_music_metrics
        (date, month, granularity, platform, track_id, streams,
         revenue_amount, currency, import_source)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'csv')
    `).run(date, month, granularity, platform, track_id, streams, revenue, currency);
  } catch (e) {
    // 制約違反などは無視して続行
  }

  // 収益がある場合は sf_revenue へも書き込む
  if (revenue > 0) {
    try {
      db.prepare(`
        INSERT OR IGNORE INTO sf_revenue
          (date, month, source, platform, track_id, amount, currency, amount_jpy, import_source)
        VALUES (?, ?, '音楽配信', ?, ?, ?, ?, ?, 'csv')
      `).run(
        date, month, platform, track_id,
        revenue,
        currency,
        currency === 'JPY' ? Math.round(revenue) : 0,
      );
    } catch (e) {
      // 制約違反などは無視して続行
    }
  }
}
