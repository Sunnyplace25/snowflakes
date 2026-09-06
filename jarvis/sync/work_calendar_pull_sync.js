/**
 * jarvis/sync/work_calendar_pull_sync.js
 * Google Calendar → JARVIS 逆方向同期（取り込み候補スキャン + 承認取り込み）
 * Phase 21: 取り込み候補スキャン
 * Phase 22: 承認取り込み（Calendar → work_records）
 *
 * 設計方針（Phase 21）:
 *   - work_records への自動 INSERT は絶対に行わない
 *   - JARVIS 由来イベント（extendedProperties.private.jarvis_source = 'work_record'）は除外
 *   - work_calendar_links に紐付き済みのイベントも除外
 *   - 重複チェックは警告のみ・自動除外や結合はしない
 *   - dry-run: DB 書き込みなし。候補一覧と件数のみ返す
 *   - scan:    calendar_import_candidates に UPSERT し、不在候補を removed にする
 *
 * 設計方針（Phase 22）:
 *   - importCalendarCandidate: 1件の pending 候補を work_records へ取り込む
 *   - Google Calendar 側に新しいイベントを作成しない（既存 google_event_id をそのまま再利用）
 *   - duplicate_work_id がある候補は allowDuplicate=true なしには取り込めない
 *   - DB 処理はトランザクションで実行し、途中失敗時は中途半端なレコードを残さない
 *   - 時間指定イベントの start_datetime / end_datetime は work_calendar_links に保持する
 */

import { randomUUID } from 'crypto';
import { listEvents } from './calendar_client.js';
import {
  upsertCalendarImportCandidate,
  markAbsentCandidatesRemoved,
  getPendingCandidates,
  getCandidateSummary,
} from '../data/calendar_import_candidate_manager.js';

// ─── 定数 ─────────────────────────────────────────────────────────────────────

const VALID_CATEGORIES      = ['Snow flakes', '音声仕事', '物販', '17配信', 'その他'];
const VALID_INVOICE_STATUSES = ['対象外', '未請求', '請求済'];
const VALID_PAYMENT_STATUSES = ['対象外', '未入金', '入金済'];

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

// ─── Phase 22: 承認取り込み ────────────────────────────────────────────────────

/**
 * workRecordFields の入力を検証し、正規化された値を返す内部ヘルパー。
 * @param {object} f
 * @param {object} candidate
 * @returns {object}
 */
function buildWorkRecordParams(f, candidate) {
  const category = f.category;
  if (!category) throw new Error('category は必須です');
  if (!VALID_CATEGORIES.includes(category)) {
    throw new Error(`Invalid category: "${category}". 許可値: ${VALID_CATEGORIES.join(', ')}`);
  }

  const invoice_status = f.invoice_status ?? '対象外';
  const payment_status = f.payment_status ?? '対象外';
  if (!VALID_INVOICE_STATUSES.includes(invoice_status)) {
    throw new Error(`Invalid invoice_status: "${invoice_status}"`);
  }
  if (!VALID_PAYMENT_STATUSES.includes(payment_status)) {
    throw new Error(`Invalid payment_status: "${payment_status}"`);
  }

  if (f.income != null && (!Number.isInteger(f.income) || f.income < 0)) {
    throw new Error('income は 0 以上の整数で指定してください');
  }
  if (f.expense != null && (!Number.isInteger(f.expense) || f.expense < 0)) {
    throw new Error('expense は 0 以上の整数で指定してください');
  }
  if (f.work_hours != null && (typeof f.work_hours !== 'number' || f.work_hours < 0)) {
    throw new Error('work_hours は 0 以上の数値で指定してください');
  }
  if (f.travel_hours != null && (typeof f.travel_hours !== 'number' || f.travel_hours < 0)) {
    throw new Error('travel_hours は 0 以上の数値で指定してください');
  }

  return {
    job_id:         randomUUID(),
    date:           candidate.event_date,
    category,
    work_type:      f.work_type      ?? null,
    content:        f.content        ?? candidate.title ?? null,
    client:         f.client         ?? null,
    income:         f.income         ?? 0,
    expense:        f.expense        ?? 0,
    work_hours:     f.work_hours     ?? null,
    travel_hours:   f.travel_hours   ?? null,
    is_full_day:    candidate.is_all_day ? 1 : 0,
    invoice_status,
    payment_status,
    memo:           f.memo           ?? null,
  };
}

/**
 * dry-run: calendar_import_candidates.id を指定して、取り込み結果をプレビューする。
 * DB への書き込みは一切行わない。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} candidateId
 * @param {{
 *   category:         string,
 *   work_type?:       string|null,
 *   content?:         string|null,
 *   client?:          string|null,
 *   income?:          number,
 *   expense?:         number,
 *   work_hours?:      number|null,
 *   travel_hours?:    number|null,
 *   invoice_status?:  string,
 *   payment_status?:  string,
 *   memo?:            string|null,
 * }} workRecordFields
 * @param {{ allowDuplicate?: boolean }} [opts]
 * @returns {{
 *   candidateId:    number,
 *   candidate:      object,
 *   workRecord:     object,
 *   calendarLink:   object,
 *   hasDuplicate:   boolean,
 *   duplicateWorkId: number|null,
 * }}
 */
export function dryRunImportCandidate(db, candidateId, workRecordFields, { allowDuplicate = false } = {}) {
  const candidate = db.prepare(
    'SELECT * FROM calendar_import_candidates WHERE id = ?'
  ).get(candidateId);

  if (!candidate) throw new Error(`候補が見つかりません: id=${candidateId}`);

  if (candidate.status !== 'pending') {
    throw new Error(
      `取り込み不可: candidate id=${candidateId} の status は '${candidate.status}' です（pending のみ取り込み可能）`
    );
  }

  if (candidate.duplicate_work_id && !allowDuplicate) {
    throw new Error(
      `DuplicateError: candidate id=${candidateId} に duplicate_work_id=${candidate.duplicate_work_id} が設定されています。` +
      ` allowDuplicate=true を指定して上書きしてください。`
    );
  }

  const wr = buildWorkRecordParams(workRecordFields, candidate);

  return {
    candidateId,
    candidate: {
      google_event_id:    candidate.google_event_id,
      google_calendar_id: candidate.google_calendar_id,
      event_date:         candidate.event_date,
      title:              candidate.title,
      is_all_day:         candidate.is_all_day,
      start_datetime:     candidate.start_datetime,
      end_datetime:       candidate.end_datetime,
    },
    workRecord: {
      date:           wr.date,
      category:       wr.category,
      work_type:      wr.work_type,
      content:        wr.content,
      client:         wr.client,
      income:         wr.income,
      expense:        wr.expense,
      work_hours:     wr.work_hours,
      travel_hours:   wr.travel_hours,
      is_full_day:    wr.is_full_day,
      invoice_status: wr.invoice_status,
      payment_status: wr.payment_status,
      memo:           wr.memo,
    },
    calendarLink: {
      google_calendar_id: candidate.google_calendar_id,
      google_event_id:    candidate.google_event_id,
      sync_status:        'synced',
      start_datetime:     candidate.is_all_day ? null : candidate.start_datetime,
      end_datetime:       candidate.is_all_day ? null : candidate.end_datetime,
    },
    hasDuplicate:   !!candidate.duplicate_work_id,
    duplicateWorkId: candidate.duplicate_work_id ?? null,
  };
}

/**
 * 承認取り込み: calendar_import_candidates の pending 候補 1 件を
 * work_records へ取り込み、work_calendar_links を作成する。
 *
 * 【重要】Google Calendar には一切アクセスしない。
 *         既存の google_event_id をそのまま work_calendar_links に設定する。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} candidateId
 * @param {{
 *   category:         string,
 *   work_type?:       string|null,
 *   content?:         string|null,
 *   client?:          string|null,
 *   income?:          number,
 *   expense?:         number,
 *   work_hours?:      number|null,
 *   travel_hours?:    number|null,
 *   invoice_status?:  string,
 *   payment_status?:  string,
 *   memo?:            string|null,
 * }} workRecordFields
 * @param {{ allowDuplicate?: boolean }} [opts]
 * @returns {{ workRecordId: number, candidateId: number }}
 */
export function importCalendarCandidate(db, candidateId, workRecordFields, { allowDuplicate = false } = {}) {
  // ── 事前検証（トランザクション外） ─────────────────────────────────────────
  const candidate = db.prepare(
    'SELECT * FROM calendar_import_candidates WHERE id = ?'
  ).get(candidateId);

  if (!candidate) throw new Error(`候補が見つかりません: id=${candidateId}`);

  if (candidate.status !== 'pending') {
    throw new Error(
      `取り込み不可: candidate id=${candidateId} の status は '${candidate.status}' です（pending のみ取り込み可能）`
    );
  }

  if (candidate.status === 'imported') {
    throw new Error(`すでに取り込み済みです: candidate id=${candidateId}`);
  }

  if (candidate.duplicate_work_id && !allowDuplicate) {
    throw new Error(
      `DuplicateError: candidate id=${candidateId} に duplicate_work_id=${candidate.duplicate_work_id} が設定されています。` +
      ` allowDuplicate=true を指定して上書きしてください。`
    );
  }

  const wr = buildWorkRecordParams(workRecordFields, candidate);

  // ── トランザクション内で全 DB 書き込みを実行 ───────────────────────────────
  // node:sqlite の DatabaseSync は .transaction() を持たないため
  // BEGIN / COMMIT / ROLLBACK を明示的に使う
  db.exec('BEGIN');
  try {
    // 1. work_records INSERT
    const wrResult = db.prepare(`
      INSERT INTO work_records
        (job_id, date, category, work_type, content, client,
         income, expense, work_hours, travel_hours, is_full_day,
         invoice_status, payment_status, memo)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      wr.job_id, wr.date, wr.category, wr.work_type, wr.content, wr.client,
      wr.income, wr.expense, wr.work_hours, wr.travel_hours, wr.is_full_day,
      wr.invoice_status, wr.payment_status, wr.memo,
    );
    const workRecordId = Number(wrResult.lastInsertRowid);

    // 2. work_calendar_links INSERT（既存 google_event_id 再利用・Calendar API 呼び出しなし）
    //    import_origin = 'calendar'：Calendar起点であることを明示する
    db.prepare(`
      INSERT INTO work_calendar_links
        (work_record_id, google_calendar_id, google_event_id,
         sync_status, import_origin, start_datetime, end_datetime,
         last_synced_at, created_at, updated_at)
      VALUES (?, ?, ?, 'synced', 'calendar', ?, ?,
              datetime('now','localtime'), datetime('now','localtime'), datetime('now','localtime'))
    `).run(
      workRecordId,
      candidate.google_calendar_id,
      candidate.google_event_id,
      candidate.is_all_day ? null : candidate.start_datetime,
      candidate.is_all_day ? null : candidate.end_datetime,
    );

    // 3. calendar_import_candidates 更新
    db.prepare(`
      UPDATE calendar_import_candidates
         SET status           = 'imported',
             imported_work_id = ?,
             updated_at       = datetime('now','localtime')
       WHERE id = ?
    `).run(workRecordId, candidateId);

    db.exec('COMMIT');
    return { workRecordId, candidateId };
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
