/**
 * jarvis/sync/work_calendar_sync.js
 * work_records → Google Calendar 同期 (Phase 20)
 *
 * push: work_records → Google Calendar（JARVIS仕事記録 → Calendar予定）
 *
 * 設計方針:
 *   - Calendar API 失敗時も work_records の登録・編集は独立して成功する
 *   - dry-run: DB・Calendar API への書き込みなし。変換内容のみ確認
 *   - execute: 実際に Calendar API を呼び、work_calendar_links にステータスを記録
 *
 * 未実装項目（将来対応）:
 *   - Google Calendar → JARVIS 取り込み（逆方向同期）
 *   - 重複防止（同日・同内容イベントの照合）
 *   - 既存 work_records との突き合わせ（orphaned 検出含む）
 *   - pending/error レコードの定期リトライバッチ
 */

import { createEvent, updateEvent } from './calendar_client.js';
import {
  getWorkCalendarLink,
  setWorkCalendarSynced,
  setWorkCalendarError,
} from '../data/work_calendar_manager.js';

const JARVIS_SOURCE_KEY    = 'jarvis_source';
const WORK_RECORD_ID_KEY   = 'work_record_id';

// ─── Time Parser ──────────────────────────────────────────────────────────────

/**
 * メモ・内容フィールドから開始・終了時刻を抽出する（両方揃っている場合のみ）。
 * 開始時刻のみ（例: "13：00-"）は null を返す（終日イベントとして扱う）。
 *
 * 対応パターン:
 *   HH:MM-HH:MM  /  HH:MM〜HH:MM  /  HH：MM〜HH：MM（全角コロン）
 *   HH時〜HH時  /  HH時MM分〜HH時MM分
 *
 * @param {string|null} text
 * @returns {{ startH: number, startM: number, endH: number, endM: number } | null}
 */
export function parseTimeRange(text) {
  if (!text) return null;

  // 全角コロン・全角チルダを正規化
  const normalized = text.replace(/：/g, ':').replace(/〜/g, '~');

  // HH:MM[-~]HH:MM
  const colonRange = normalized.match(
    /(\d{1,2}):(\d{2})\s*[-~－ー]\s*(\d{1,2}):(\d{2})/
  );
  if (colonRange) {
    return {
      startH: parseInt(colonRange[1], 10), startM: parseInt(colonRange[2], 10),
      endH:   parseInt(colonRange[3], 10), endM:   parseInt(colonRange[4], 10),
    };
  }

  // HH時(MM分)~HH時(MM分)
  const kanjiRange = normalized.match(
    /(\d{1,2})時(?:(\d{1,2})分)?\s*[~－ー]\s*(\d{1,2})時(?:(\d{1,2})分)?/
  );
  if (kanjiRange) {
    return {
      startH: parseInt(kanjiRange[1], 10), startM: kanjiRange[2] ? parseInt(kanjiRange[2], 10) : 0,
      endH:   parseInt(kanjiRange[3], 10), endM:   kanjiRange[4] ? parseInt(kanjiRange[4], 10) : 0,
    };
  }

  return null;
}

// ─── Event Builder ────────────────────────────────────────────────────────────

/**
 * work_record 行から Google Calendar イベントオブジェクトを構築する。
 *
 * Calendar イベントに含める情報:
 *   ✅ 日付・時刻 / 仕事内容 (content) / 仕事種別 (work_type) / 取引先 (client) / カテゴリ
 *   ❌ 金額 (income/expense) / 請求状況 / 入金状況 / 源泉徴収 / メモ（会計情報が混入するため除外）
 *
 * - is_full_day=1 → 終日イベント
 * - is_full_day=0 かつ content に時刻範囲あり → 時間指定イベント（summaryから時刻重複を除去）
 *
 * @param {object} record - work_records テーブルの1行
 * @returns {object|null} Google Calendar event resource。date が欠損する場合は null
 */
export function buildEventFromWorkRecord(record) {
  if (!record.date) return null;

  const pad  = n => String(n).padStart(2, '0');
  const date = record.date; // "YYYY-MM-DD"

  // 翌日（終日イベントの end.date 用）
  const [y, m, d] = date.split('-').map(Number);
  const nextDay   = new Date(y, m - 1, d + 1);
  const nextDate  = [
    nextDay.getFullYear(),
    pad(nextDay.getMonth() + 1),
    pad(nextDay.getDate()),
  ].join('-');

  // 時刻解析（is_full_day=0 の場合のみ。memoは会計情報混入リスクがあるため content のみ対象）
  let start, end;
  const timeRange = record.is_full_day ? null : parseTimeRange(record.content);

  // タイトル: work_type プレフィックス + content
  // 時間指定イベントの場合、content内の "(HH:MM-HH:MM)" 重複表記を除去
  const workTypePrefix = record.work_type ? `[${record.work_type}] ` : '';
  const rawContent     = record.content ?? '';
  const cleanContent   = timeRange
    ? rawContent
        .replace(/[（(]\d{1,2}[:：]\d{2}\s*[-〜~－ー]\s*\d{1,2}[:：]\d{2}[)）]/g, '')  // 括弧付き時刻
        .replace(/\d{1,2}[:：]\d{2}\s*[-〜~－ー]\s*\d{1,2}[:：]\d{2}/g, '')           // 括弧なし時刻
        .replace(/\s{2,}/g, ' ')
        .trim()
    : rawContent;
  const summary = (workTypePrefix + cleanContent).trim().slice(0, 80) || '（内容未入力）';

  // description: 仕事種別・カテゴリ・取引先のみ（金額・請求・メモは含めない）
  const descParts = [
    record.category  ? `カテゴリ: ${record.category}`   : null,
    record.work_type ? `種別: ${record.work_type}`       : null,
    record.client    ? `取引先: ${record.client}`        : null,
    'JARVISからインポート',
  ].filter(Boolean);
  const description = descParts.join('\n');

  if (timeRange) {
    // 時間指定イベント
    start = { dateTime: `${date}T${pad(timeRange.startH)}:${pad(timeRange.startM)}:00+09:00` };
    end   = { dateTime: `${date}T${pad(timeRange.endH)}:${pad(timeRange.endM)}:00+09:00` };
  } else {
    // 終日イベント
    start = { date };
    end   = { date: nextDate };
  }

  return {
    summary,
    description,
    start,
    end,
    extendedProperties: {
      private: {
        [JARVIS_SOURCE_KEY]:  'work_record',
        [WORK_RECORD_ID_KEY]: String(record.id),
      },
    },
  };
}

// ─── Dry-Run ─────────────────────────────────────────────────────────────────

/**
 * dry-run: Calendar API を呼ばず、変換内容のみを返す。
 * DB への書き込みも行わない。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{
 *   calendarId: string,
 *   dateFrom?: string,  // "YYYY-MM-DD" 以降
 *   dateTo?:   string,  // "YYYY-MM-DD" 以前
 *   limit?:    number,
 * }} opts
 * @returns {{
 *   items: Array<{ record: object, action: 'create'|'update'|'skip', event: object|null, link?: object, reason?: string }>,
 *   createCount: number,
 *   updateCount: number,
 *   skipCount: number,
 * }}
 */
export function dryRunWorkPush(db, { calendarId, dateFrom, dateTo, limit = 200 }) {
  let sql   = 'SELECT * FROM work_records WHERE 1=1';
  const params = [];
  if (dateFrom) { sql += ' AND date >= ?'; params.push(dateFrom); }
  if (dateTo)   { sql += ' AND date <= ?'; params.push(dateTo);   }
  sql += ' ORDER BY date ASC LIMIT ?';
  params.push(limit);

  const records = db.prepare(sql).all(...params);

  let createCount = 0;
  let updateCount = 0;
  let skipCount   = 0;
  const items     = [];

  for (const record of records) {
    if (!record.date) {
      skipCount++;
      items.push({ record, action: 'skip', event: null, reason: 'date が未設定' });
      continue;
    }

    const event       = buildEventFromWorkRecord(record);
    const existingLink = getWorkCalendarLink(db, record.id);

    if (existingLink?.sync_status === 'synced' && existingLink?.google_event_id) {
      updateCount++;
      items.push({ record, action: 'update', event, link: existingLink });
    } else {
      createCount++;
      items.push({ record, action: 'create', event });
    }
  }

  return { items, createCount, updateCount, skipCount };
}

// ─── Execute Push ─────────────────────────────────────────────────────────────

/**
 * push 実行: work_records の予定を Google Calendar に作成・更新する。
 * Calendar API が失敗した場合は work_calendar_links に error を記録して継続する。
 * work_records 本体の更新は一切行わない。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} accessToken
 * @param {{
 *   calendarId: string,
 *   dateFrom?: string,
 *   dateTo?:   string,
 *   limit?:    number,
 * }} opts
 * @param {{ createEvent: Function, updateEvent: Function }|null} [apiClient]
 * @returns {Promise<{ createdCount: number, updatedCount: number, skippedCount: number, errorCount: number, errors: object[] }>}
 */
export async function executeWorkPush(db, accessToken, {
  calendarId, dateFrom, dateTo, limit = 200
}, apiClient = null) {
  const client = apiClient ?? { createEvent, updateEvent };
  const { items } = dryRunWorkPush(db, { calendarId, dateFrom, dateTo, limit });

  let createdCount = 0;
  let updatedCount = 0;
  let skippedCount = 0;
  let errorCount   = 0;
  const errors     = [];

  for (const item of items) {
    if (item.action === 'skip') {
      skippedCount++;
      continue;
    }

    try {
      if (item.action === 'update' && item.link?.google_event_id) {
        const updated = await client.updateEvent(
          accessToken, calendarId, item.link.google_event_id, item.event
        );
        setWorkCalendarSynced(db, item.record.id, calendarId, updated.id ?? item.link.google_event_id);
        updatedCount++;
      } else {
        const created = await client.createEvent(accessToken, calendarId, item.event);
        setWorkCalendarSynced(db, item.record.id, calendarId, created.id);
        createdCount++;
      }
    } catch (err) {
      // Calendar API 失敗 → work_records への影響なし、リンクにエラー記録
      setWorkCalendarError(db, item.record.id, calendarId, err.message);
      errorCount++;
      errors.push({
        workRecordId: item.record.id,
        date:         item.record.date,
        content:      item.record.content,
        error:        err.message,
      });
    }
  }

  return { createdCount, updatedCount, skippedCount, errorCount, errors };
}

// ─── Single-Record Test Mode ──────────────────────────────────────────────────

/**
 * 1件テストモード: 指定した work_record_id のみ Calendar に同期する。
 * 本番全件同期前の動作確認用。
 *
 * 成功時:
 *   - Google Calendar にイベントが1件作成される
 *   - work_calendar_links に google_event_id が保存される
 *   - sync_status = 'synced' になる
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} accessToken
 * @param {{ calendarId: string, workRecordId: number }} opts
 * @param {{ createEvent: Function, updateEvent: Function }|null} [apiClient]
 * @returns {Promise<{
 *   success: boolean,
 *   action: 'created'|'updated'|'skipped'|'error',
 *   event: object|null,
 *   googleEventId?: string,
 *   error?: string,
 *   record: object|null,
 * }>}
 */
export async function syncSingleWorkRecord(db, accessToken, {
  calendarId, workRecordId,
}, apiClient = null) {
  const client = apiClient ?? { createEvent, updateEvent };

  const record = db.prepare('SELECT * FROM work_records WHERE id = ?').get(workRecordId);
  if (!record) {
    return { success: false, action: 'error', event: null, record: null, error: `work_record id=${workRecordId} が見つかりません` };
  }

  const event = buildEventFromWorkRecord(record);
  if (!event) {
    return { success: false, action: 'skipped', event: null, record, error: 'date が未設定のためスキップ' };
  }

  const existingLink = getWorkCalendarLink(db, workRecordId);

  try {
    if (existingLink?.sync_status === 'synced' && existingLink?.google_event_id) {
      // 既存イベントを更新
      const updated = await client.updateEvent(accessToken, calendarId, existingLink.google_event_id, event);
      const eventId = updated.id ?? existingLink.google_event_id;
      setWorkCalendarSynced(db, workRecordId, calendarId, eventId);
      return { success: true, action: 'updated', event, googleEventId: eventId, record };
    } else {
      // 新規作成
      const created = await client.createEvent(accessToken, calendarId, event);
      setWorkCalendarSynced(db, workRecordId, calendarId, created.id);
      return { success: true, action: 'created', event, googleEventId: created.id, record };
    }
  } catch (err) {
    setWorkCalendarError(db, workRecordId, calendarId, err.message);
    return { success: false, action: 'error', event, record, error: err.message };
  }
}
