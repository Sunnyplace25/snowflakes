/**
 * jarvis/data/calendar_import_candidate_manager.js
 * calendar_import_candidates テーブルの CRUD (Phase 21)
 *
 * 設計方針:
 *   - work_records への自動 INSERT は行わない（候補の記録・レビュー管理のみ）
 *   - UPSERT 時に ignored / skipped / imported の status を pending に戻さない
 *   - 重複チェックは警告フラグを立てるだけで自動除外・結合はしない
 *   - スキャンで不在になった pending 候補は removed に更新する
 */

// ─── UPSERT ─────────────────────────────────────────────────────────────────

/**
 * Calendar イベントを取り込み候補として UPSERT する。
 *
 * ステータス保護ルール:
 *   - 新規 INSERT         → status = 'pending'
 *   - 既存が pending / removed → status = 'pending' に更新
 *   - 既存が ignored / skipped / imported → status を変更しない
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{
 *   googleCalendarId:   string,
 *   googleEventId:      string,
 *   eventDate?:         string|null,
 *   startDatetime?:     string|null,
 *   endDatetime?:       string|null,
 *   isAllDay?:          number,
 *   title?:             string|null,
 *   description?:       string|null,
 *   eventUpdatedAt?:    string|null,
 *   etag?:              string|null,
 *   recurringEventId?:  string|null,
 *   duplicateWorkId?:   number|null,
 *   duplicateReason?:   string|null,
 * }} opts
 * @returns {number} UPSERT されたレコードの id
 */
export function upsertCalendarImportCandidate(db, {
  googleCalendarId,
  googleEventId,
  eventDate         = null,
  startDatetime     = null,
  endDatetime       = null,
  isAllDay          = 0,
  title             = null,
  description       = null,
  eventUpdatedAt    = null,
  etag              = null,
  recurringEventId  = null,
  duplicateWorkId   = null,
  duplicateReason   = null,
}) {
  db.prepare(`
    INSERT INTO calendar_import_candidates (
      google_calendar_id, google_event_id,
      event_date, start_datetime, end_datetime, is_all_day,
      title, description,
      event_updated_at, etag, recurring_event_id,
      duplicate_work_id, duplicate_reason,
      status, scanned_at, last_seen_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending',
              datetime('now','localtime'), datetime('now','localtime'))
    ON CONFLICT(google_calendar_id, google_event_id) DO UPDATE SET
      event_date          = excluded.event_date,
      start_datetime      = excluded.start_datetime,
      end_datetime        = excluded.end_datetime,
      is_all_day          = excluded.is_all_day,
      title               = excluded.title,
      description         = excluded.description,
      event_updated_at    = excluded.event_updated_at,
      etag                = excluded.etag,
      recurring_event_id  = excluded.recurring_event_id,
      duplicate_work_id   = excluded.duplicate_work_id,
      duplicate_reason    = excluded.duplicate_reason,
      last_seen_at        = datetime('now','localtime'),
      updated_at          = datetime('now','localtime'),
      -- ignored / skipped / imported の状態は保護する
      status = CASE
        WHEN calendar_import_candidates.status IN ('ignored', 'skipped', 'imported')
          THEN calendar_import_candidates.status
        ELSE 'pending'
      END
  `).run(
    googleCalendarId, googleEventId,
    eventDate, startDatetime, endDatetime, isAllDay,
    title, description,
    eventUpdatedAt, etag, recurringEventId,
    duplicateWorkId, duplicateReason,
  );

  return db.prepare(
    'SELECT id FROM calendar_import_candidates WHERE google_calendar_id = ? AND google_event_id = ?'
  ).get(googleCalendarId, googleEventId).id;
}

// ─── Status Updates ───────────────────────────────────────────────────────────

/**
 * スキャンで不在になった pending 候補を removed にする。
 * スキャン後に呼び出すことで Calendar 側の削除を検出する。
 *
 * 期間指定スキャンの場合は dateFrom / dateTo を渡すこと。
 * 期間外の候補（event_date がその範囲外、または NULL）は対象外とし、
 * 不在扱いにしない。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} googleCalendarId
 * @param {string[]} seenEventIds - 今回のスキャンで確認できた google_event_id の配列
 * @param {{ dateFrom?: string|null, dateTo?: string|null }} [period]
 * @returns {number} removed に更新した件数
 */
export function markAbsentCandidatesRemoved(db, googleCalendarId, seenEventIds, {
  dateFrom = null,
  dateTo   = null,
} = {}) {
  // 期間指定がある場合は event_date BETWEEN を追加
  // event_date が NULL のレコードは期間判定不能として対象外にする
  const periodClauses = [];
  const periodParams  = [];
  if (dateFrom) { periodClauses.push('event_date >= ?'); periodParams.push(dateFrom); }
  if (dateTo)   { periodClauses.push('event_date <= ?'); periodParams.push(dateTo);   }
  const periodWhere = periodClauses.length > 0
    ? `AND event_date IS NOT NULL AND ${periodClauses.join(' AND ')}`
    : '';

  if (seenEventIds.length === 0) {
    const result = db.prepare(`
      UPDATE calendar_import_candidates
         SET status     = 'removed',
             updated_at = datetime('now','localtime')
       WHERE google_calendar_id = ?
         AND status = 'pending'
         ${periodWhere}
    `).run(googleCalendarId, ...periodParams);
    return result.changes;
  }

  const placeholders = seenEventIds.map(() => '?').join(', ');
  const result = db.prepare(`
    UPDATE calendar_import_candidates
       SET status     = 'removed',
           updated_at = datetime('now','localtime')
     WHERE google_calendar_id = ?
       AND status = 'pending'
       AND google_event_id NOT IN (${placeholders})
       ${periodWhere}
  `).run(googleCalendarId, ...seenEventIds, ...periodParams);
  return result.changes;
}

/**
 * 候補のステータスを手動で更新する（skipped / ignored / pending への変更用）。
 * imported への変更は importCandidate() を使うこと。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} id
 * @param {'pending'|'skipped'|'ignored'} status
 */
export function updateCandidateStatus(db, id, status) {
  const allowed = ['pending', 'skipped', 'ignored'];
  if (!allowed.includes(status)) throw new Error(`Invalid status: ${status}`);
  db.prepare(`
    UPDATE calendar_import_candidates
       SET status     = ?,
           updated_at = datetime('now','localtime')
     WHERE id = ?
  `).run(status, id);
}

// ─── Queries ─────────────────────────────────────────────────────────────────

/**
 * 単一候補を取得する。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} googleCalendarId
 * @param {string} googleEventId
 * @returns {object|undefined}
 */
export function getCalendarImportCandidate(db, googleCalendarId, googleEventId) {
  return db.prepare(
    'SELECT * FROM calendar_import_candidates WHERE google_calendar_id = ? AND google_event_id = ?'
  ).get(googleCalendarId, googleEventId);
}

/**
 * status = 'pending' の候補一覧を返す（レビュー対象）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} [googleCalendarId] - 省略時は全 Calendar 対象
 * @returns {object[]}
 */
export function getPendingCandidates(db, googleCalendarId = null) {
  if (googleCalendarId) {
    return db.prepare(
      "SELECT * FROM calendar_import_candidates WHERE status = 'pending' AND google_calendar_id = ? ORDER BY event_date ASC, id ASC"
    ).all(googleCalendarId);
  }
  return db.prepare(
    "SELECT * FROM calendar_import_candidates WHERE status = 'pending' ORDER BY event_date ASC, id ASC"
  ).all();
}

/**
 * status 別の件数サマリを返す。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} [googleCalendarId]
 * @returns {{ pending: number, imported: number, skipped: number, ignored: number, removed: number }}
 */
export function getCandidateSummary(db, googleCalendarId = null) {
  const rows = googleCalendarId
    ? db.prepare(
        'SELECT status, COUNT(*) AS cnt FROM calendar_import_candidates WHERE google_calendar_id = ? GROUP BY status'
      ).all(googleCalendarId)
    : db.prepare(
        'SELECT status, COUNT(*) AS cnt FROM calendar_import_candidates GROUP BY status'
      ).all();

  const summary = { pending: 0, imported: 0, skipped: 0, ignored: 0, removed: 0 };
  for (const r of rows) {
    if (r.status in summary) summary[r.status] = r.cnt;
  }
  return summary;
}

/**
 * 全候補を返す（管理・確認用）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {object[]}
 */
export function getAllCandidates(db) {
  return db.prepare(
    'SELECT * FROM calendar_import_candidates ORDER BY event_date ASC, id ASC'
  ).all();
}
