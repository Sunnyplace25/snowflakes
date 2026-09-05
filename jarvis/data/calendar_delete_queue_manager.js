/**
 * jarvis/data/calendar_delete_queue_manager.js
 * calendar_delete_queue テーブルの CRUD (Phase 20)
 *
 * 役割:
 *   work_records 削除後に Google Calendar 側のイベント削除を試みるが、
 *   Calendar API 失敗時は work_calendar_links がすでに CASCADE 削除済みのため
 *   情報を保持する専用 Outbox テーブルを使用する。
 *
 * ステータス:
 *   pending → Calendar 削除待ち / 失敗してリトライ待ち
 *   done    → 削除成功（または 404/410 で存在しなかった）
 */

// ─── Enqueue ─────────────────────────────────────────────────────────────────

/**
 * Calendar 削除 Queue にエントリを追加する。
 * deleteWorkRecord より前に呼ぶこと（work_record_id を記録するため）。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ googleCalendarId: string, googleEventId: string, workRecordId?: number|null }} opts
 * @returns {number} 挿入されたエントリの id
 */
export function enqueueCalendarDelete(db, { googleCalendarId, googleEventId, workRecordId = null }) {
  const result = db.prepare(`
    INSERT INTO calendar_delete_queue
      (google_calendar_id, google_event_id, work_record_id)
    VALUES (?, ?, ?)
  `).run(googleCalendarId, googleEventId, workRecordId ?? null);
  return Number(result.lastInsertRowid);
}

// ─── Status Updates ───────────────────────────────────────────────────────────

/**
 * Calendar 削除成功時（または 404/410 で存在しなかった場合）に呼ぶ。
 * status を 'done' に更新する。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} queueId
 */
export function markCalendarDeleteDone(db, queueId) {
  db.prepare(`
    UPDATE calendar_delete_queue
       SET status           = 'done',
           last_attempted_at = datetime('now','localtime'),
           completed_at      = datetime('now','localtime')
     WHERE id = ?
  `).run(queueId);
}

/**
 * Calendar 削除失敗時に呼ぶ。
 * error_message を記録し retry_count をインクリメントする。
 * status は 'pending' のまま（リトライ対象）。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} queueId
 * @param {string} errorMessage
 */
export function markCalendarDeleteError(db, queueId, errorMessage) {
  db.prepare(`
    UPDATE calendar_delete_queue
       SET error_message     = ?,
           retry_count       = retry_count + 1,
           last_attempted_at = datetime('now','localtime')
     WHERE id = ?
  `).run(errorMessage, queueId);
}

// ─── Queries ─────────────────────────────────────────────────────────────────

/**
 * status = 'pending' のエントリを返す（リトライ対象）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} [maxRetries=10] retry_count がこの値以下のもののみ返す
 * @returns {object[]}
 */
export function getPendingCalendarDeletes(db, maxRetries = 10) {
  return db.prepare(`
    SELECT * FROM calendar_delete_queue
     WHERE status = 'pending' AND retry_count <= ?
     ORDER BY created_at ASC
  `).all(maxRetries);
}

/**
 * 全エントリを返す（管理・確認用）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {object[]}
 */
export function getAllCalendarDeleteQueue(db) {
  return db.prepare(
    'SELECT * FROM calendar_delete_queue ORDER BY id ASC'
  ).all();
}
