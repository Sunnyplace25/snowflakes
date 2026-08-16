/**
 * jarvis/data/calendar_manager.js
 * Google Calendar 同期 DB CRUD (Phase 18)
 *
 * Tables:
 *   business_calendar_links      — invoice_line ↔ Google Calendar event
 *   business_calendar_sync_runs  — sync execution history
 *   business_calendar_imports    — Calendar → JARVIS import candidates
 */

// ─── Links (invoice_line ↔ Calendar event) ───────────────────────────────────

/**
 * calendar リンク一覧を取得する。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ invoiceLineIds?: number[] }} [opts]
 * @returns {object[]}
 */
export function getCalendarLinks(db, { invoiceLineIds } = {}) {
  if (invoiceLineIds && invoiceLineIds.length > 0) {
    const placeholders = invoiceLineIds.map(() => '?').join(', ');
    return db.prepare(
      `SELECT * FROM business_calendar_links WHERE invoice_line_id IN (${placeholders}) ORDER BY id ASC`
    ).all(...invoiceLineIds);
  }
  return db.prepare(
    'SELECT * FROM business_calendar_links ORDER BY id ASC'
  ).all();
}

/**
 * invoice_line_id に紐づくリンクを1件取得する。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} invoiceLineId
 * @returns {object|undefined}
 */
export function getCalendarLinkByLineId(db, invoiceLineId) {
  return db.prepare(
    'SELECT * FROM business_calendar_links WHERE invoice_line_id = ?'
  ).get(invoiceLineId);
}

/**
 * invoice_line ↔ Google Calendar event のリンクを INSERT or UPDATE する。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ invoiceLineId: number, googleCalendarId: string, googleEventId: string, syncStatus?: string }} opts
 * @returns {{ action: 'created'|'updated', id: number }}
 */
export function upsertCalendarLink(db, {
  invoiceLineId,
  googleCalendarId,
  googleEventId,
  syncStatus = 'synced',
}) {
  const existing = db.prepare(
    'SELECT id FROM business_calendar_links WHERE invoice_line_id = ?'
  ).get(invoiceLineId);

  if (existing) {
    db.prepare(`
      UPDATE business_calendar_links
         SET google_calendar_id = ?,
             google_event_id    = ?,
             sync_status        = ?,
             last_synced_at     = datetime('now','localtime')
       WHERE invoice_line_id = ?
    `).run(googleCalendarId, googleEventId, syncStatus, invoiceLineId);
    return { action: 'updated', id: existing.id };
  }

  const result = db.prepare(`
    INSERT INTO business_calendar_links
      (invoice_line_id, google_calendar_id, google_event_id, sync_status)
    VALUES (?, ?, ?, ?)
  `).run(invoiceLineId, googleCalendarId, googleEventId, syncStatus);
  return { action: 'created', id: Number(result.lastInsertRowid) };
}

/**
 * 全リンク件数を返す。
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {number}
 */
export function getCalendarLinkCount(db) {
  const row = db.prepare('SELECT COUNT(*) AS c FROM business_calendar_links').get();
  return row.c;
}

/**
 * リンク済み invoice_line を持つ年一覧を返す。
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {string[]}
 */
export function getLinkedYears(db) {
  const rows = db.prepare(`
    SELECT DISTINCT strftime('%Y', l.work_date) AS year
    FROM business_calendar_links cl
    JOIN business_invoice_lines l ON l.id = cl.invoice_line_id
    WHERE l.work_date IS NOT NULL
    ORDER BY year DESC
  `).all();
  return rows.map(r => r.year).filter(Boolean);
}

// ─── Sync Runs ────────────────────────────────────────────────────────────────

/**
 * 同期実行ログを新規作成する（status='running'）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ direction: string, calendarId?: string, yearFilter?: string }} opts
 * @returns {number} lastInsertRowid
 */
export function insertSyncRun(db, { direction, calendarId, yearFilter }) {
  const result = db.prepare(`
    INSERT INTO business_calendar_sync_runs
      (direction, calendar_id, year_filter)
    VALUES (?, ?, ?)
  `).run(direction, calendarId ?? null, yearFilter ?? null);
  return Number(result.lastInsertRowid);
}

/**
 * 同期実行ログを完了状態に更新する。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ runId: number, createdCount: number, updatedCount: number, skippedCount: number, errorCount: number, status?: string, notes?: string }} opts
 */
export function completeSyncRun(db, {
  runId,
  createdCount,
  updatedCount,
  skippedCount,
  errorCount,
  status = 'completed',
  notes,
}) {
  db.prepare(`
    UPDATE business_calendar_sync_runs
       SET finished_at    = datetime('now','localtime'),
           created_count  = ?,
           updated_count  = ?,
           skipped_count  = ?,
           error_count    = ?,
           status         = ?,
           notes          = ?
     WHERE id = ?
  `).run(createdCount, updatedCount, skippedCount, errorCount, status, notes ?? null, runId);
}

/**
 * 同期実行履歴を取得する（最新順）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} [limit=20]
 * @returns {object[]}
 */
export function getSyncRuns(db, limit = 20) {
  return db.prepare(
    'SELECT * FROM business_calendar_sync_runs ORDER BY started_at DESC LIMIT ?'
  ).all(limit);
}

// ─── Calendar Imports (Google → JARVIS candidates) ───────────────────────────

/**
 * Google Calendar → JARVIS 取込候補を UPSERT する。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ googleCalendarId: string, googleEventId: string, title: string, startDate?: string, endDate?: string, startDatetime?: string, endDatetime?: string, isAllDay?: boolean, description?: string, location?: string }} opts
 * @returns {{ action: 'created'|'updated', id: number }}
 */
export function upsertCalendarImport(db, {
  googleCalendarId,
  googleEventId,
  title,
  startDate,
  endDate,
  startDatetime,
  endDatetime,
  isAllDay,
  description,
  location,
}) {
  const existing = db.prepare(
    'SELECT id FROM business_calendar_imports WHERE google_calendar_id = ? AND google_event_id = ?'
  ).get(googleCalendarId, googleEventId);

  if (existing) {
    db.prepare(`
      UPDATE business_calendar_imports
         SET title          = ?,
             start_date     = ?,
             end_date       = ?,
             start_datetime = ?,
             end_datetime   = ?,
             is_all_day     = ?,
             description    = ?,
             location       = ?,
             fetched_at     = datetime('now','localtime')
       WHERE id = ?
    `).run(
      title,
      startDate    ?? null,
      endDate      ?? null,
      startDatetime ?? null,
      endDatetime  ?? null,
      isAllDay ? 1 : 0,
      description  ?? null,
      location     ?? null,
      existing.id,
    );
    return { action: 'updated', id: existing.id };
  }

  const result = db.prepare(`
    INSERT INTO business_calendar_imports
      (google_calendar_id, google_event_id, title,
       start_date, end_date, start_datetime, end_datetime,
       is_all_day, description, location)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    googleCalendarId,
    googleEventId,
    title,
    startDate    ?? null,
    endDate      ?? null,
    startDatetime ?? null,
    endDatetime  ?? null,
    isAllDay ? 1 : 0,
    description  ?? null,
    location     ?? null,
  );
  return { action: 'created', id: Number(result.lastInsertRowid) };
}

/**
 * import_status = 'pending' の取込候補を返す。
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {object[]}
 */
export function getPendingCalendarImports(db) {
  return db.prepare(
    "SELECT * FROM business_calendar_imports WHERE import_status = 'pending' ORDER BY start_date ASC"
  ).all();
}

/**
 * 取込候補の import_status を更新する。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} id
 * @param {string} status  'pending'|'imported'|'skipped'
 */
export function updateCalendarImportStatus(db, id, status) {
  db.prepare(
    'UPDATE business_calendar_imports SET import_status = ? WHERE id = ?'
  ).run(status, id);
}
