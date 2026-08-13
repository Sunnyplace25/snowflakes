/**
 * jarvis/importers/narou_writer.js
 * sf_narou_snapshot へスナップショットを書き込む。
 *
 * 処理フロー:
 *   1. 入力バリデーション（ncode / month 必須）
 *   2. sf_narou_snapshot へ UPSERT
 *      ON CONFLICT(month, ncode) DO UPDATE
 *   3. 戻り値: { written: number, errors: Array }
 *
 * 注意:
 *   - 実際の作品名・Nコード・数値は推測しない
 *   - import_source = 'manual'
 *   - テストは :memory: DB のみ使用
 */

'use strict';

/**
 * なろうスナップショットを sf_narou_snapshot へ UPSERT する。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Array<{
 *   ncode:         string,
 *   month:         string,   // YYYY-MM
 *   pvTotal?:      number,
 *   pvMonthly?:    number,
 *   bookmarkCount?: number,
 *   reviewCount?:  number,
 *   point?:        number,
 *   workId?:       number,
 *   title?:        string,
 *   memo?:         string,
 * }>} rows
 * @returns {{ written: number, errors: Array<{ row: object, reason: string }> }}
 */
export function writeNarouSnapshot(db, rows) {
  const stmtUpsert = db.prepare(`
    INSERT INTO sf_narou_snapshot
      (month, ncode, work_id, title, pv_total, pv_monthly,
       bookmark_count, review_count, point, memo, import_source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual')
    ON CONFLICT(month, ncode) DO UPDATE SET
      work_id        = COALESCE(excluded.work_id,        work_id),
      title          = COALESCE(excluded.title,          title),
      pv_total       = COALESCE(excluded.pv_total,       pv_total),
      pv_monthly     = COALESCE(excluded.pv_monthly,     pv_monthly),
      bookmark_count = COALESCE(excluded.bookmark_count, bookmark_count),
      review_count   = COALESCE(excluded.review_count,   review_count),
      point          = COALESCE(excluded.point,          point),
      memo           = COALESCE(excluded.memo,           memo)
  `);

  const result = { written: 0, errors: [] };

  for (const row of rows) {
    // 必須フィールド検証
    if (!row.ncode || typeof row.ncode !== 'string' || !row.ncode.trim()) {
      result.errors.push({ row, reason: 'ncode が未指定または空文字' });
      continue;
    }
    if (!row.month || !/^\d{4}-\d{2}$/.test(row.month)) {
      result.errors.push({ row, reason: `month が不正: "${row.month}" (YYYY-MM 形式が必要)` });
      continue;
    }

    try {
      stmtUpsert.run(
        row.month,
        row.ncode.trim(),
        row.workId   ?? null,
        row.title    ?? null,
        row.pvTotal  ?? null,
        row.pvMonthly ?? null,
        row.bookmarkCount ?? null,
        row.reviewCount   ?? null,
        row.point    ?? null,
        row.memo     ?? null,
      );
      result.written++;
    } catch (e) {
      result.errors.push({ row, reason: e.message });
    }
  }

  return result;
}
