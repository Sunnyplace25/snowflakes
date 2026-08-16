/**
 * jarvis/sync/calendar_sync.js
 * JARVIS ↔ Google Calendar 同期オーケストレーション (Phase 18)
 *
 * push: business_invoice_lines → Google Calendar (JARVIS実績 → Calendar)
 * pull: Google Calendar → business_calendar_imports (Calendar予定 → JARVIS候補)
 *
 * dry-run: DBは書き換えない、Calendar APIへは書き込まない
 * execute: 実際に書き込む（ユーザー承認後のみ）
 */

import { listEvents, createEvent, updateEvent } from './calendar_client.js';
import { getInvoiceLines } from '../data/invoice_manager.js';
import {
  getCalendarLinkByLineId,
  upsertCalendarLink,
  insertSyncRun,
  completeSyncRun,
  upsertCalendarImport,
} from '../data/calendar_manager.js';

const JARVIS_SOURCE_KEY   = 'jarvis_source';
const INVOICE_LINE_ID_KEY = 'invoice_line_id';

// ─── 時刻パーサー ─────────────────────────────────────────────────────────────

/**
 * 仕事内容テキストから明記された開始・終了時刻を抽出する（推測・補完なし）。
 *
 * 対応パターン（明示的に書かれている場合のみ）：
 *   (15:00-19:30)  (15:00〜19:30)  15:00-19:30  15:00〜19:30
 *   15時〜19時30分  15時30分〜19時30分
 *
 * @param {string} description
 * @returns {{ startH: number, startM: number, endH: number, endM: number, matchStr: string } | null}
 */
export function parseTimeFromDescription(description) {
  if (!description) return null;

  // パターン1: (HH:MM-HH:MM) または (HH:MM〜HH:MM) — 括弧付き
  const paren = description.match(/\((\d{1,2}):(\d{2})\s*[〜~－ー\-]\s*(\d{1,2}):(\d{2})\)/);
  if (paren) {
    return {
      startH: parseInt(paren[1], 10), startM: parseInt(paren[2], 10),
      endH:   parseInt(paren[3], 10), endM:   parseInt(paren[4], 10),
      matchStr: paren[0],
    };
  }

  // パターン2: HH:MM-HH:MM または HH:MM〜HH:MM — 括弧なし
  const plain = description.match(/(\d{1,2}):(\d{2})\s*[〜~－ー\-]\s*(\d{1,2}):(\d{2})/);
  if (plain) {
    return {
      startH: parseInt(plain[1], 10), startM: parseInt(plain[2], 10),
      endH:   parseInt(plain[3], 10), endM:   parseInt(plain[4], 10),
      matchStr: plain[0],
    };
  }

  // パターン3: HH時MM分〜HH時MM分（分は省略可）— 漢字表記
  const kanji = description.match(/(\d{1,2})時(?:(\d{1,2})分)?\s*[〜~]\s*(\d{1,2})時(?:(\d{1,2})分)?/);
  if (kanji) {
    return {
      startH: parseInt(kanji[1], 10), startM: kanji[2] ? parseInt(kanji[2], 10) : 0,
      endH:   parseInt(kanji[3], 10), endM:   kanji[4] ? parseInt(kanji[4], 10) : 0,
      matchStr: kanji[0],
    };
  }

  return null;
}

// ─── Event Builder ────────────────────────────────────────────────────────────

/**
 * invoice_line 行から Google Calendar イベントオブジェクトを構築する。
 * 個人情報（住所・電話・メール・銀行口座）は一切含めない。
 * description に明確な開始・終了時刻が記載されている場合は時間指定イベントにする。
 *
 * @param {object} line - getInvoiceLines() が返す行
 * @returns {object|null} Google Calendar event resource、work_date が欠損する場合は null
 */
export function buildEventFromLine(line) {
  if (!line.work_date) return null;

  const rawDescription = line.description ?? '';
  const [y, m, d] = line.work_date.split('-').map(Number);

  // description から時刻を抽出
  const timeInfo = parseTimeFromDescription(rawDescription);

  let summary, start, end;

  if (timeInfo) {
    // ── 時間指定イベント ──────────────────────────────────────────────────────
    // タイトルから時刻表記（括弧ごと）を除去して二重表示を防ぐ
    summary = rawDescription
      .replace(timeInfo.matchStr, '')   // 時刻パターンを除去
      .replace(/\s{2,}/g, ' ')         // 連続スペースを1つに
      .trim()
      .slice(0, 80);

    const pad  = n => String(n).padStart(2, '0');
    const date = line.work_date;
    start = { dateTime: `${date}T${pad(timeInfo.startH)}:${pad(timeInfo.startM)}:00+09:00` };
    end   = { dateTime: `${date}T${pad(timeInfo.endH)}:${pad(timeInfo.endM)}:00+09:00` };
  } else {
    // ── 終日イベント ──────────────────────────────────────────────────────────
    summary = rawDescription.slice(0, 80);
    const nextDay = new Date(y, m - 1, d + 1);
    const nextDate = [
      nextDay.getFullYear(),
      String(nextDay.getMonth() + 1).padStart(2, '0'),
      String(nextDay.getDate()).padStart(2, '0'),
    ].join('-');
    start = { date: line.work_date };
    end   = { date: nextDate };
  }

  // description: 最小限の業務情報のみ（金額・請求書番号は含めない）
  const clientName = line.client_name ?? '';
  const calDescription = [
    ...(clientName ? [`取引先: ${clientName}`] : []),
    'JARVISからインポート',
  ].join('\n');

  return {
    summary,
    description: calDescription,
    start,
    end,
    extendedProperties: {
      private: {
        [JARVIS_SOURCE_KEY]:   'business',
        [INVOICE_LINE_ID_KEY]: String(line.id),
      },
    },
  };
}

// ─── Dry-Run Push ─────────────────────────────────────────────────────────────

/**
 * push の dry-run。Calendar API を呼ばず、実行予定のみを返す。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} accessToken - dry-run では API 呼び出しに使わない
 * @param {{ calendarId: string, year?: string }} opts
 * @returns {{ items: object[], createCount: number, updateCount: number, skipCount: number }}
 */
export function dryRunPush(db, accessToken, { calendarId, year }) {
  const lines = getInvoiceLines(db, { year, limit: 500 });

  let createCount = 0;
  let updateCount = 0;
  let skipCount   = 0;
  const items = [];

  for (const line of lines) {
    if (!line.work_date) {
      skipCount++;
      items.push({ line, action: 'skip', event: null, reason: 'work_date が未設定' });
      continue;
    }

    const event       = buildEventFromLine(line);
    const existingLink = getCalendarLinkByLineId(db, line.id);

    if (existingLink) {
      updateCount++;
      items.push({ line, action: 'update', event, existingLink });
    } else {
      createCount++;
      items.push({ line, action: 'create', event });
    }
  }

  return { items, createCount, updateCount, skipCount };
}

// ─── Execute Push ─────────────────────────────────────────────────────────────

/**
 * push を実行する。Calendar API を呼び、DB にリンクを記録する。
 * 1件のエラーは収集して継続し、全件処理後にまとめて返す。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} accessToken
 * @param {{ calendarId: string, year?: string, runId?: number }} opts
 * @param {{ createEvent: Function, updateEvent: Function }|null} [apiClient=null]
 *   テスト用の API クライアント注入。null の場合は実際の calendar_client を使う。
 * @returns {Promise<{ createdCount: number, updatedCount: number, skippedCount: number, errorCount: number, errors: object[] }>}
 */
export async function executePush(db, accessToken, { calendarId, year, runId }, apiClient = null) {
  const client = apiClient ?? { createEvent, updateEvent };
  const lines  = getInvoiceLines(db, { year, limit: 500 });

  let createdCount = 0;
  let updatedCount = 0;
  let skippedCount = 0;
  let errorCount   = 0;
  const errors     = [];

  for (const line of lines) {
    if (!line.work_date) {
      skippedCount++;
      continue;
    }

    const event        = buildEventFromLine(line);
    const existingLink = getCalendarLinkByLineId(db, line.id);

    try {
      if (existingLink) {
        // 既存イベントの更新
        const updated = await client.updateEvent(
          accessToken,
          calendarId,
          existingLink.google_event_id,
          event,
        );
        upsertCalendarLink(db, {
          invoiceLineId:    line.id,
          googleCalendarId: calendarId,
          googleEventId:    updated.id ?? existingLink.google_event_id,
          syncStatus:       'updated',
        });
        updatedCount++;
      } else {
        // 新規イベントの作成
        const created = await client.createEvent(accessToken, calendarId, event);
        upsertCalendarLink(db, {
          invoiceLineId:    line.id,
          googleCalendarId: calendarId,
          googleEventId:    created.id,
          syncStatus:       'synced',
        });
        createdCount++;
      }
    } catch (err) {
      // 1件エラーでも継続
      errorCount++;
      errors.push({
        invoiceLineId: line.id,
        work_date:     line.work_date,
        description:   line.description,
        error:         err.message,
      });
    }
  }

  if (runId != null) {
    completeSyncRun(db, {
      runId,
      createdCount,
      updatedCount,
      skippedCount,
      errorCount,
      status: errorCount > 0 && (createdCount + updatedCount) === 0 ? 'failed' : 'completed',
    });
  }

  return { createdCount, updatedCount, skippedCount, errorCount, errors };
}

// ─── Dry-Run Pull ─────────────────────────────────────────────────────────────

/**
 * pull の dry-run。Calendar のイベントを取込候補として返す（DB 書き込みなし）。
 *
 * @param {string} accessToken
 * @param {{ calendarId: string, startDate?: string, endDate?: string }} opts
 * @returns {Promise<{ candidates: object[], candidateCount: number, managedCount: number, total: number }>}
 */
export async function dryRunPull(accessToken, { calendarId, startDate, endDate }) {
  const allItems = [];
  let pageToken  = undefined;

  // ページネーション対応
  do {
    const result = await listEvents(accessToken, calendarId, {
      timeMin:    startDate ? `${startDate}T00:00:00Z` : undefined,
      timeMax:    endDate   ? `${endDate}T23:59:59Z`   : undefined,
      maxResults: 250,
      pageToken,
    });
    allItems.push(...result.items);
    pageToken = result.nextPageToken ?? undefined;
  } while (pageToken);

  const candidates = [];
  let managedCount = 0;

  for (const item of allItems) {
    const isJarvisManaged =
      item.extendedProperties?.private?.[JARVIS_SOURCE_KEY] === 'business';

    if (isJarvisManaged) {
      managedCount++;
    }

    // 終日イベント判定
    const isAllDay = Boolean(item.start?.date && !item.start?.dateTime);

    const startDateValue     = item.start?.date     ?? null;
    const startDatetimeValue = item.start?.dateTime ?? null;
    const endDateValue       = item.end?.date       ?? null;

    candidates.push({
      googleEventId:   item.id,
      title:           item.summary ?? '',
      startDate:       startDateValue,
      startDatetime:   startDatetimeValue,
      endDate:         endDateValue,
      isAllDay,
      description:     item.description ?? null,
      location:        item.location    ?? null,
      isJarvisManaged,
      importStatus:    isJarvisManaged ? 'skip_managed' : 'candidate',
    });
  }

  const candidateCount = candidates.filter(c => !c.isJarvisManaged).length;

  return {
    candidates,
    candidateCount,
    managedCount,
    total: allItems.length,
  };
}

// ─── Execute Pull ─────────────────────────────────────────────────────────────

/**
 * pull を実行する。JARVIS 非管理イベントを business_calendar_imports に保存する。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} accessToken
 * @param {{ calendarId: string, startDate?: string, endDate?: string, runId?: number }} opts
 * @returns {Promise<{ importedCount: number, skippedCount: number, errorCount: number }>}
 */
export async function executePull(db, accessToken, { calendarId, startDate, endDate, runId }) {
  const { candidates } = await dryRunPull(accessToken, { calendarId, startDate, endDate });

  let importedCount = 0;
  let skippedCount  = 0;
  let errorCount    = 0;

  for (const c of candidates) {
    if (c.isJarvisManaged) {
      skippedCount++;
      continue;
    }

    try {
      upsertCalendarImport(db, {
        googleCalendarId: calendarId,
        googleEventId:    c.googleEventId,
        title:            c.title,
        startDate:        c.startDate,
        endDate:          c.endDate,
        startDatetime:    c.startDatetime,
        endDatetime:      null,
        isAllDay:         c.isAllDay,
        description:      c.description,
        location:         c.location,
      });
      importedCount++;
    } catch (err) {
      errorCount++;
    }
  }

  if (runId != null) {
    completeSyncRun(db, {
      runId,
      createdCount:  importedCount,
      updatedCount:  0,
      skippedCount,
      errorCount,
      status: 'completed',
    });
  }

  return { importedCount, skippedCount, errorCount };
}
