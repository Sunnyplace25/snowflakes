/**
 * jarvis/data/work_calendar_manager.js
 * work_records ↔ Google Calendar 同期 DB CRUD (Phase 20)
 *
 * 設計方針:
 *   - Calendar API の成否は work_records の登録・編集に影響しない
 *   - sync_status: pending / synced / error / orphaned
 *   - error 時は error_message + error_count を記録してリトライ可能にする
 *   - orphaned: Calendar 側イベントが削除されたことを照合で検出した際に設定
 *
 * 未実装（将来対応）:
 *   - Google Calendar → JARVIS 取り込み（逆方向同期）
 *   - 重複防止・既存 work_records との照合
 *   - pending/error レコードの定期リトライバッチ
 */

// ─── Link CRUD ───────────────────────────────────────────────────────────────

/**
 * work_record_id に紐づくリンクを1件取得する。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} workRecordId
 * @returns {object|undefined}
 */
export function getWorkCalendarLink(db, workRecordId) {
  return db.prepare(
    'SELECT * FROM work_calendar_links WHERE work_record_id = ?'
  ).get(workRecordId);
}

/**
 * work_record ↔ Google Calendar event のリンクを UPSERT する。
 * INSERT 時は pending で作成し、その後 setSynced / setError で状態を更新する。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{
 *   workRecordId: number,
 *   googleCalendarId: string,
 *   googleEventId?: string|null,
 *   syncStatus?: 'pending'|'synced'|'error'|'orphaned',
 *   errorMessage?: string|null,
 * }} opts
 * @returns {{ action: 'created'|'updated', id: number }}
 */
export function upsertWorkCalendarLink(db, {
  workRecordId,
  googleCalendarId,
  googleEventId = null,
  syncStatus    = 'pending',
  errorMessage  = null,
}) {
  const now      = "datetime('now','localtime')";
  const existing = db.prepare(
    'SELECT id, error_count FROM work_calendar_links WHERE work_record_id = ?'
  ).get(workRecordId);

  if (existing) {
    const newErrorCount = syncStatus === 'error'
      ? (existing.error_count ?? 0) + 1
      : (existing.error_count ?? 0);

    db.prepare(`
      UPDATE work_calendar_links
         SET google_calendar_id = ?,
             google_event_id    = ?,
             sync_status        = ?,
             error_message      = ?,
             error_count        = ?,
             last_attempted_at  = datetime('now','localtime'),
             last_synced_at     = CASE WHEN ? = 'synced' THEN datetime('now','localtime') ELSE last_synced_at END,
             updated_at         = datetime('now','localtime')
       WHERE work_record_id = ?
    `).run(
      googleCalendarId,
      googleEventId,
      syncStatus,
      errorMessage,
      newErrorCount,
      syncStatus,
      workRecordId,
    );
    return { action: 'updated', id: existing.id };
  }

  const initErrorCount = syncStatus === 'error' ? 1 : 0;
  const result = db.prepare(`
    INSERT INTO work_calendar_links
      (work_record_id, google_calendar_id, google_event_id, sync_status,
       error_message, error_count, last_attempted_at, last_synced_at)
    VALUES (?, ?, ?, ?, ?, ?,
            datetime('now','localtime'),
            CASE WHEN ? = 'synced' THEN datetime('now','localtime') ELSE NULL END)
  `).run(
    workRecordId,
    googleCalendarId,
    googleEventId,
    syncStatus,
    errorMessage,
    initErrorCount,
    syncStatus,
  );
  return { action: 'created', id: Number(result.lastInsertRowid) };
}

/**
 * 同期成功時に呼ぶ。sync_status を 'synced' にし google_event_id を記録する。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} workRecordId
 * @param {string} googleCalendarId
 * @param {string} googleEventId
 */
export function setWorkCalendarSynced(db, workRecordId, googleCalendarId, googleEventId) {
  upsertWorkCalendarLink(db, {
    workRecordId,
    googleCalendarId,
    googleEventId,
    syncStatus: 'synced',
    errorMessage: null,
  });
}

/**
 * API 失敗時に呼ぶ。sync_status を 'error' にし error_message を記録する。
 * error_count をインクリメントして将来のリトライ判断に使う。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} workRecordId
 * @param {string} googleCalendarId
 * @param {string} errorMessage
 */
export function setWorkCalendarError(db, workRecordId, googleCalendarId, errorMessage) {
  upsertWorkCalendarLink(db, {
    workRecordId,
    googleCalendarId,
    googleEventId: getWorkCalendarLink(db, workRecordId)?.google_event_id ?? null,
    syncStatus: 'error',
    errorMessage,
  });
}

/**
 * Calendar 側イベントが削除済みと判明した際に呼ぶ。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} workRecordId
 */
export function setWorkCalendarOrphaned(db, workRecordId) {
  db.prepare(`
    UPDATE work_calendar_links
       SET sync_status = 'orphaned',
           updated_at  = datetime('now','localtime')
     WHERE work_record_id = ?
  `).run(workRecordId);
}

// ─── Queries ─────────────────────────────────────────────────────────────────

/**
 * sync_status = 'pending' のリンク一覧を返す（リトライバッチ用）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {object[]}
 */
export function getPendingWorkCalendarLinks(db) {
  return db.prepare(
    "SELECT * FROM work_calendar_links WHERE sync_status = 'pending' ORDER BY created_at ASC"
  ).all();
}

/**
 * sync_status = 'error' かつ error_count <= maxRetries のリンクを返す（リトライ対象）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} [maxRetries=3]
 * @returns {object[]}
 */
export function getErrorWorkCalendarLinks(db, maxRetries = 3) {
  return db.prepare(
    "SELECT * FROM work_calendar_links WHERE sync_status = 'error' AND error_count <= ? ORDER BY last_attempted_at ASC"
  ).all(maxRetries);
}

/**
 * work_calendar_links 全件を返す。
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {object[]}
 */
export function getAllWorkCalendarLinks(db) {
  return db.prepare(
    'SELECT * FROM work_calendar_links ORDER BY id ASC'
  ).all();
}

/**
 * sync_status 別の件数サマリを返す。
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {{ pending: number, synced: number, error: number, orphaned: number }}
 */
export function getWorkCalendarLinkSummary(db) {
  const rows = db.prepare(
    "SELECT sync_status, COUNT(*) AS cnt FROM work_calendar_links GROUP BY sync_status"
  ).all();
  const summary = { pending: 0, synced: 0, error: 0, orphaned: 0 };
  for (const r of rows) {
    if (r.sync_status in summary) summary[r.sync_status] = r.cnt;
  }
  return summary;
}
