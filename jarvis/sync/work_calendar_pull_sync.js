/**
 * jarvis/sync/work_calendar_pull_sync.js
 * Google Calendar → JARVIS 逆方向同期（取り込み候補スキャン）Phase 21
 *
 * 設計方針:
 *   - work_records への自動 INSERT は絶対に行わない
 *   - JARVIS 由来イベント（extendedProperties.private.jarvis_source = 'work_record'）は除外
 *   - work_calendar_links に紐付き済みのイベントも除外
 *   - 重複チェックは警告のみ・自動除外や結合はしない
 *   - dry-run: DB 書き込みなし。候補一覧と件数のみ返す
 *   - scan:    calendar_import_candidates に UPSERT し、不在候補を removed にする
 *
 * 未実装（将来フェーズ）:
 *   - 候補からの work_records 取り込み（ダッシュボード承認後）
 */

import { listEvents } from './calendar_client.js';
import {
  upsertCalendarImportCandidate,
  markAbsentCandidatesRemoved,
  getPendingCandidates,
  getCandidateSummary,
} from '../data/calendar_import_candidate_manager.js';

// ─── 内部ユーティリティ ─────────────────────────────────────────────────────────

/**
 * Calendar イベントから日付・時刻情報を正規化する。
 * @param {object} event - Google Calendar event resource
 * @returns {{ eventDate: string|null, startDatetime: string|null, endDatetime: string|null, isAllDay: number }}
 */
function normalizeDatetime(event) {
  if (event.start?.date) {
    // 終日イベント
    return {
      eventDate:     event.start.date,
      startDatetime: event.start.date,
      endDatetime:   event.end?.date ?? null,
      isAllDay:      1,
    };
  }
  if (event.start?.dateTime) {
    // 時間指定イベント
    const eventDate = event.start.dateTime.slice(0, 10);
    return {
      eventDate,
      startDatetime: event.start.dateTime,
      endDatetime:   event.end?.dateTime ?? null,
      isAllDay:      0,
    };
  }
  return { eventDate: null, startDatetime: null, endDatetime: null, isAllDay: 0 };
}

/**
 * 同日の work_records を照合して重複候補を返す。
 * 重複は警告のみで、自動除外・結合はしない。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string|null} eventDate - YYYY-MM-DD
 * @returns {{ duplicateWorkId: number|null, duplicateReason: string|null }}
 */
function checkDuplicates(db, eventDate) {
  if (!eventDate) return { duplicateWorkId: null, duplicateReason: null };

  const sameDay = db.prepare(
    'SELECT id, work_type, content FROM work_records WHERE date = ? ORDER BY id ASC LIMIT 1'
  ).get(eventDate);

  if (!sameDay) return { duplicateWorkId: null, duplicateReason: null };

  const label = [sameDay.work_type, sameDay.content].filter(Boolean).join(' ').slice(0, 80);
  return {
    duplicateWorkId: sameDay.id,
    duplicateReason: `同日の仕事記録あり: id=${sameDay.id} ${label}`,
  };
}

/**
 * Calendar 全イベントを取得し、JARVIS 由来・リンク済みを除外して候補リストを返す内部関数。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} accessToken
 * @param {{
 *   calendarId: string,
 *   timeMin?:   string,
 *   timeMax?:   string,
 * }} opts
 * @param {{ listEvents?: Function }|null} [apiClient] テスト用モック
 * @returns {Promise<{ candidates: object[], jarvisCount: number, linkedCount: number, totalCount: number }>}
 */
async function fetchAndFilterCandidates(db, accessToken, { calendarId, timeMin, timeMax }, apiClient = null) {
  const listFn = apiClient?.listEvents ?? listEvents;

  // ページネーションで全件取得
  let allEvents = [];
  let pageToken = null;
  do {
    const res = await listFn(accessToken, calendarId, {
      maxResults: 250,
      ...(timeMin    ? { timeMin }    : {}),
      ...(timeMax    ? { timeMax }    : {}),
      ...(pageToken  ? { pageToken }  : {}),
    });
    allEvents = allEvents.concat(res.items ?? []);
    pageToken = res.nextPageToken ?? null;
  } while (pageToken);

  const totalCount = allEvents.length;

  // JARVIS 由来を除外（extendedProperties.private.jarvis_source = 'work_record'）
  const notJarvis = allEvents.filter(e =>
    e.extendedProperties?.private?.jarvis_source !== 'work_record'
  );
  const jarvisCount = totalCount - notJarvis.length;

  // work_calendar_links に紐付き済みのイベントを除外
  const linkedIds = new Set(
    db.prepare(
      'SELECT google_event_id FROM work_calendar_links WHERE google_event_id IS NOT NULL'
    ).all().map(r => r.google_event_id)
  );
  const candidates = notJarvis.filter(e => !linkedIds.has(e.id));
  const linkedCount = notJarvis.length - candidates.length;

  return { candidates, jarvisCount, linkedCount, totalCount };
}

// ─── Dry-Run ─────────────────────────────────────────────────────────────────

/**
 * dry-run: DB 書き込みなし。取り込み候補の件数と内容のみ返す。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} accessToken
 * @param {{
 *   calendarId: string,
 *   timeMin?:   string,  // ISO8601
 *   timeMax?:   string,  // ISO8601
 * }} opts
 * @param {{ listEvents?: Function }|null} [apiClient]
 * @returns {Promise<{
 *   totalCount:     number,
 *   jarvisCount:    number,
 *   linkedCount:    number,
 *   candidateCount: number,
 *   candidates: Array<{
 *     googleEventId:     string,
 *     eventDate:         string|null,
 *     startDatetime:     string|null,
 *     endDatetime:       string|null,
 *     isAllDay:          number,
 *     title:             string|null,
 *     description:       string|null,
 *     etag:              string|null,
 *     recurringEventId:  string|null,
 *     duplicateWorkId:   number|null,
 *     duplicateReason:   string|null,
 *   }>,
 * }>}
 */
export async function dryRunCalendarPull(db, accessToken, opts, apiClient = null) {
  const { calendarId } = opts;
  const { candidates, jarvisCount, linkedCount, totalCount } =
    await fetchAndFilterCandidates(db, accessToken, opts, apiClient);

  const items = candidates.map(e => {
    const { eventDate, startDatetime, endDatetime, isAllDay } = normalizeDatetime(e);
    const { duplicateWorkId, duplicateReason } = checkDuplicates(db, eventDate);

    return {
      googleEventId:    e.id,
      eventDate,
      startDatetime,
      endDatetime,
      isAllDay,
      title:            e.summary       ?? null,
      description:      e.description   ?? null,
      etag:             e.etag           ?? null,
      recurringEventId: e.recurringEventId ?? null,
      duplicateWorkId,
      duplicateReason,
    };
  });

  return {
    totalCount,
    jarvisCount,
    linkedCount,
    candidateCount: items.length,
    candidates: items,
  };
}

// ─── Scan（DB 書き込みあり）────────────────────────────────────────────────────

/**
 * スキャン実行: Calendar を取得し calendar_import_candidates に UPSERT する。
 * - ignored / skipped / imported の status は変更しない
 * - 不在になった pending 候補は removed に更新する
 * - work_records への INSERT は行わない
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} accessToken
 * @param {{
 *   calendarId: string,
 *   timeMin?:   string,
 *   timeMax?:   string,
 * }} opts
 * @param {{ listEvents?: Function }|null} [apiClient]
 * @returns {Promise<{
 *   totalCount:     number,
 *   jarvisCount:    number,
 *   linkedCount:    number,
 *   upsertedCount:  number,
 *   removedCount:   number,
 *   summary:        object,
 * }>}
 */
export async function scanCalendarCandidates(db, accessToken, opts, apiClient = null) {
  const { calendarId, timeMin, timeMax } = opts;

  // 【安全設計】
  //   - 全ページ取得完了後にのみ markAbsentCandidatesRemoved を実行する
  //   - API 途中失敗・ページ取得失敗時は例外が発生し、以降の removed 判定は実行されない
  //   - 期間指定スキャン（timeMin / timeMax）の場合は期間内候補のみを removed 判定対象にする
  //     期間外の候補を不在扱いにしない
  const { candidates, jarvisCount, linkedCount, totalCount } =
    await fetchAndFilterCandidates(db, accessToken, opts, apiClient);
  // ↑ ここで例外が発生した場合、以降の markAbsentCandidatesRemoved は実行されない

  const seenEventIds = [];

  for (const e of candidates) {
    const { eventDate, startDatetime, endDatetime, isAllDay } = normalizeDatetime(e);
    const { duplicateWorkId, duplicateReason } = checkDuplicates(db, eventDate);

    upsertCalendarImportCandidate(db, {
      googleCalendarId:  calendarId,
      googleEventId:     e.id,
      eventDate,
      startDatetime,
      endDatetime,
      isAllDay,
      title:             e.summary            ?? null,
      description:       e.description        ?? null,
      eventUpdatedAt:    e.updated            ?? null,
      etag:              e.etag               ?? null,
      recurringEventId:  e.recurringEventId   ?? null,
      duplicateWorkId,
      duplicateReason,
    });

    seenEventIds.push(e.id);
  }

  // 期間指定がある場合は timeMin / timeMax から YYYY-MM-DD を抽出して removed 判定を期間内に限定する
  const dateFrom = timeMin ? timeMin.slice(0, 10) : null;
  const dateTo   = timeMax ? timeMax.slice(0, 10) : null;

  const removedCount = markAbsentCandidatesRemoved(db, calendarId, seenEventIds, { dateFrom, dateTo });

  const summary = getCandidateSummary(db, calendarId);

  return {
    totalCount,
    jarvisCount,
    linkedCount,
    upsertedCount: candidates.length,
    removedCount,
    summary,
  };
}
