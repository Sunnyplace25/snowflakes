/**
 * jarvis/importers/ga_writer.js
 * sf_ga_daily / sf_ga_event_daily へデータを書き込む。
 *
 * 注意:
 *   - 実際の Property ID・イベント名・数値をハードコードしない
 *   - GA4 API への接続・認証情報はコードに保存しない
 *   - テストは :memory: DB のみ使用
 */

'use strict';

/**
 * GA4 日別ページ指標を sf_ga_daily へ UPSERT する。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Array<{
 *   date:             string,   // YYYY-MM-DD（必須）
 *   pagePath:         string,   // 非空文字（必須）
 *   sessions?:        number|null,
 *   users?:           number|null,
 *   pageViews?:       number|null,
 *   engagedSessions?: number|null,
 * }>} rows
 * @returns {{ written: number, errors: Array<{ row: object, reason: string }> }}
 */
export function writeGaDaily(db, rows) {
  const stmt = db.prepare(`
    INSERT INTO sf_ga_daily
      (date, page_path, sessions, users, page_views, engaged_sessions, fetched_at)
    VALUES (?, ?, ?, ?, ?, ?, datetime('now', 'localtime'))
    ON CONFLICT(date, page_path) DO UPDATE SET
      sessions         = COALESCE(excluded.sessions,         sessions),
      users            = COALESCE(excluded.users,            users),
      page_views       = COALESCE(excluded.page_views,       page_views),
      engaged_sessions = COALESCE(excluded.engaged_sessions, engaged_sessions),
      fetched_at       = excluded.fetched_at
  `);

  const result = { written: 0, errors: [] };

  for (const row of rows) {
    if (!row.date || !/^\d{4}-\d{2}-\d{2}$/.test(row.date)) {
      result.errors.push({ row, reason: `date が不正: "${row.date}" (YYYY-MM-DD 形式が必要)` });
      continue;
    }
    if (!row.pagePath || typeof row.pagePath !== 'string' || !row.pagePath.trim()) {
      result.errors.push({ row, reason: 'pagePath が未指定または空文字' });
      continue;
    }

    try {
      stmt.run(
        row.date,
        row.pagePath,
        row.sessions        ?? null,
        row.users           ?? null,
        row.pageViews       ?? null,
        row.engagedSessions ?? null,
      );
      result.written++;
    } catch (e) {
      result.errors.push({ row, reason: e.message });
    }
  }

  return result;
}

/**
 * GA4 イベント日別集計を sf_ga_event_daily へ UPSERT する。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Array<{
 *   date:      string,  // YYYY-MM-DD（必須）
 *   eventName: string,  // 非空文字（必須）
 *   pagePath?: string,  // 省略時は '/'
 *   count:     number,
 * }>} rows
 * @returns {{ written: number, errors: Array<{ row: object, reason: string }> }}
 */
export function writeGaEventDaily(db, rows) {
  const stmt = db.prepare(`
    INSERT INTO sf_ga_event_daily
      (date, event_name, page_path, count, fetched_at)
    VALUES (?, ?, ?, ?, datetime('now', 'localtime'))
    ON CONFLICT(date, event_name, page_path) DO UPDATE SET
      count      = excluded.count,
      fetched_at = excluded.fetched_at
  `);

  const result = { written: 0, errors: [] };

  for (const row of rows) {
    if (!row.date || !/^\d{4}-\d{2}-\d{2}$/.test(row.date)) {
      result.errors.push({ row, reason: `date が不正: "${row.date}" (YYYY-MM-DD 形式が必要)` });
      continue;
    }
    if (!row.eventName || typeof row.eventName !== 'string' || !row.eventName.trim()) {
      result.errors.push({ row, reason: 'eventName が未指定または空文字' });
      continue;
    }

    try {
      stmt.run(
        row.date,
        row.eventName,
        row.pagePath ?? '/',
        row.count    ?? 0,
      );
      result.written++;
    } catch (e) {
      result.errors.push({ row, reason: e.message });
    }
  }

  return result;
}
