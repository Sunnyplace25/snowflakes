/**
 * jarvis/sync/work_calendar_hook.js
 * work_records CRUD → Google Calendar 自動連動フック (Phase 20)
 *
 * 設計方針:
 *   - Calendar API 失敗でも work_records 操作（HTTP 応答）は影響を受けない
 *   - 作成・更新: syncSingleWorkRecord を使ってリンク状態を DB に記録する
 *   - 削除: ON DELETE CASCADE でリンクが消えるため、削除前に google_event_id を取得する
 *           Calendar 削除前に calendar_delete_queue へエントリを挿入し、
 *           成功時は 'done'、失敗時は pending のまま error 情報を記録してリトライ可能にする
 *           404 / 410 応答はすでに存在しない = 削除成功相当として扱う
 *   - GCALENDAR_CALENDAR_ID 未設定時はすべてのフックが即時 return（Calendar 連動無効）
 *   - apiClient 引数を渡すとテスト用モックとして使用できる
 *     形式: { calendarId?, getAccessToken?, createEvent?, updateEvent?, deleteEvent? }
 *     本番: null（環境変数 + 実 API を使用）
 */

import {
  getCalendarConfig,
  refreshAccessToken,
  createEvent,
  updateEvent,
  deleteEvent,
} from './calendar_client.js';
import { syncSingleWorkRecord } from './work_calendar_sync.js';
import { getWorkCalendarLink, setWorkCalendarError } from '../data/work_calendar_manager.js';
import {
  enqueueCalendarDelete,
  markCalendarDeleteDone,
  markCalendarDeleteError,
  getPendingCalendarDeletes,
} from '../data/calendar_delete_queue_manager.js';

// ─── 内部ヘルパー ──────────────────────────────────────────────────────────────

function getCalendarId() {
  return process.env.GCALENDAR_CALENDAR_ID ?? '';
}

async function defaultGetAccessToken() {
  const config = getCalendarConfig();
  return refreshAccessToken(config);
}

/**
 * Calendar API エラーメッセージが「存在しない」を示すか判定する。
 * HTTP 404 (Not Found) / 410 (Gone) はすでに削除済み = 成功相当。
 */
function isNotFoundError(message) {
  return message.includes('404') || message.includes('410');
}

// ─── Create Hook ──────────────────────────────────────────────────────────────

/**
 * work_record 作成後に Google Calendar へ非同期で反映する。
 * Calendar API 失敗は work_calendar_links に error を記録。
 * 呼び出し側は await 不要（fire-and-forget）。テストでは await して結果を検証可能。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} workRecordId
 * @param {{
 *   calendarId?:      string,
 *   getAccessToken?:  () => Promise<string>,
 *   createEvent?:     Function,
 *   updateEvent?:     Function,
 * }|null} [apiClient]
 * @returns {Promise<object|null>}
 */
export function hookWorkCreated(db, workRecordId, apiClient = null) {
  const calendarId = apiClient?.calendarId ?? getCalendarId();
  if (!calendarId) return Promise.resolve(null);

  return (async () => {
    try {
      const getToken = apiClient?.getAccessToken ?? defaultGetAccessToken;
      const token    = await getToken();
      const client   = {
        createEvent: apiClient?.createEvent ?? createEvent,
        updateEvent: apiClient?.updateEvent ?? updateEvent,
      };
      return await syncSingleWorkRecord(db, token, { calendarId, workRecordId }, client);
    } catch (err) {
      try { setWorkCalendarError(db, workRecordId, calendarId, err.message); } catch (_) {}
      return null;
    }
  })();
}

// ─── Update Hook ──────────────────────────────────────────────────────────────

/**
 * work_record 更新後に Google Calendar を非同期で更新する。
 * 既存リンクがあれば update、なければ create する（syncSingleWorkRecord に委譲）。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} workRecordId
 * @param {{
 *   calendarId?:      string,
 *   getAccessToken?:  () => Promise<string>,
 *   createEvent?:     Function,
 *   updateEvent?:     Function,
 * }|null} [apiClient]
 * @returns {Promise<object|null>}
 */
export function hookWorkUpdated(db, workRecordId, apiClient = null) {
  const calendarId = apiClient?.calendarId ?? getCalendarId();
  if (!calendarId) return Promise.resolve(null);

  return (async () => {
    try {
      const getToken = apiClient?.getAccessToken ?? defaultGetAccessToken;
      const token    = await getToken();
      const client   = {
        createEvent: apiClient?.createEvent ?? createEvent,
        updateEvent: apiClient?.updateEvent ?? updateEvent,
      };
      return await syncSingleWorkRecord(db, token, { calendarId, workRecordId }, client);
    } catch (err) {
      try { setWorkCalendarError(db, workRecordId, calendarId, err.message); } catch (_) {}
      return null;
    }
  })();
}

// ─── Delete Hook ─────────────────────────────────────────────────────────────

/**
 * DB から work_record を削除する前に google_event_id を取得する。
 * ON DELETE CASCADE でリンクが消えるため、必ず deleteWorkRecord より前に呼ぶこと。
 * sync_status = 'synced' のリンクのみ google_event_id を返す。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} workRecordId
 * @returns {string|null}
 */
export function getGoogleEventIdBeforeDelete(db, workRecordId) {
  const link = getWorkCalendarLink(db, workRecordId);
  if (link?.sync_status === 'synced' && link?.google_event_id) {
    return link.google_event_id;
  }
  return null;
}

/**
 * work_record 削除後に Google Calendar からも非同期でイベントを削除する。
 *
 * 【設計】
 *   1. 同期的に calendar_delete_queue へエントリを挿入（情報を保持）
 *   2. 非同期で Calendar 削除を試みる
 *      成功 / 404 / 410 → status = 'done'（リトライ不要）
 *      その他エラー      → status = 'pending' のまま error 情報を記録（後でリトライ可能）
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string|null} googleEventId - getGoogleEventIdBeforeDelete で取得した値
 * @param {number|null} [workRecordId] - 参照用（FK なし）
 * @param {{
 *   calendarId?:     string,
 *   getAccessToken?: () => Promise<string>,
 *   deleteEvent?:    Function,
 * }|null} [apiClient]
 * @returns {Promise<void>}
 */
export function hookWorkDeleted(db, googleEventId, workRecordId = null, apiClient = null) {
  const calendarId = apiClient?.calendarId ?? getCalendarId();
  if (!calendarId || !googleEventId) return Promise.resolve();

  // 同期部分: Queue に即時 insert（fire-and-forget でも情報が保持される）
  const queueId = enqueueCalendarDelete(db, {
    googleCalendarId: calendarId,
    googleEventId,
    workRecordId,
  });

  return (async () => {
    try {
      const getToken = apiClient?.getAccessToken ?? defaultGetAccessToken;
      const token    = await getToken();
      const delFn    = apiClient?.deleteEvent ?? deleteEvent;
      await delFn(token, calendarId, googleEventId);
      // 成功 → done に更新
      markCalendarDeleteDone(db, queueId);
    } catch (err) {
      if (isNotFoundError(err.message)) {
        // 404/410: Calendar 側にすでに存在しない → 削除成功相当
        markCalendarDeleteDone(db, queueId);
      } else {
        // その他エラー: pending のまま error を記録してリトライ可能に
        markCalendarDeleteError(db, queueId, err.message);
      }
    }
  })();
}

// ─── Retry ────────────────────────────────────────────────────────────────────

/**
 * calendar_delete_queue の pending エントリを再試行する。
 * Calendar 削除バッチや管理画面からの手動リトライに使用する。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{
 *   calendarId?:     string,
 *   getAccessToken?: () => Promise<string>,
 *   deleteEvent?:    Function,
 * }|null} [apiClient]
 * @param {number} [maxRetries=10]
 * @returns {Promise<{ id: number, googleEventId: string, success: boolean, reason?: string, error?: string }[]>}
 */
export async function retryPendingCalendarDeletes(db, apiClient = null, maxRetries = 10) {
  const pending = getPendingCalendarDeletes(db, maxRetries);
  const results = [];

  for (const entry of pending) {
    try {
      const calendarId = apiClient?.calendarId ?? entry.google_calendar_id;
      const getToken   = apiClient?.getAccessToken ?? defaultGetAccessToken;
      const token      = await getToken();
      const delFn      = apiClient?.deleteEvent ?? deleteEvent;
      await delFn(token, calendarId, entry.google_event_id);
      markCalendarDeleteDone(db, entry.id);
      results.push({ id: entry.id, googleEventId: entry.google_event_id, success: true });
    } catch (err) {
      if (isNotFoundError(err.message)) {
        markCalendarDeleteDone(db, entry.id);
        results.push({ id: entry.id, googleEventId: entry.google_event_id, success: true, reason: 'not_found' });
      } else {
        markCalendarDeleteError(db, entry.id, err.message);
        results.push({ id: entry.id, googleEventId: entry.google_event_id, success: false, error: err.message });
      }
    }
  }

  return results;
}
