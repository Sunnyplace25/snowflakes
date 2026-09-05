/**
 * jarvis/sync/calendar_client.js
 * Google Calendar API クライアント（生 HTTP fetch、googleapis ライブラリ不使用）
 *
 * セキュリティ:
 *   - access_token / refresh_token はログに出力しない
 *   - エラーメッセージにトークンを含めない
 */

const CALENDAR_BASE = 'https://www.googleapis.com/calendar/v3';
const TOKEN_URL     = 'https://oauth2.googleapis.com/token';

// ─── Config ──────────────────────────────────────────────────────────────────

/**
 * 環境変数から Google Calendar 設定を読み込む。
 * @returns {{ clientId: string, clientSecret: string, refreshToken: string }}
 * @throws {Error} 必要な環境変数が不足している場合
 */
export function getCalendarConfig() {
  const clientId     = process.env.GCALENDAR_CLIENT_ID     ?? '';
  const clientSecret = process.env.GCALENDAR_CLIENT_SECRET ?? '';
  const refreshToken = process.env.GCALENDAR_REFRESH_TOKEN ?? '';

  const missing = [];
  if (!clientId)     missing.push('GCALENDAR_CLIENT_ID');
  if (!clientSecret) missing.push('GCALENDAR_CLIENT_SECRET');
  if (!refreshToken) missing.push('GCALENDAR_REFRESH_TOKEN');

  if (missing.length > 0) {
    throw new Error(
      `Google Calendar 設定が不足しています。以下の環境変数を .env に設定してください: ${missing.join(', ')}`
    );
  }

  return { clientId, clientSecret, refreshToken };
}

// ─── Token ───────────────────────────────────────────────────────────────────

/**
 * refresh_token を使って access_token を取得する。
 * @param {{ clientId: string, clientSecret: string, refreshToken: string }} opts
 * @returns {Promise<string>} access_token
 * @throws {Error} トークン取得失敗時（トークン値はエラーメッセージに含めない）
 */
export async function refreshAccessToken({ clientId, clientSecret, refreshToken }) {
  const res = await fetch(TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      grant_type:    'refresh_token',
      refresh_token: refreshToken,
      client_id:     clientId,
      client_secret: clientSecret,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // ボディからトークン情報を除いてエラーをスロー
    throw new Error(`access_token の取得に失敗しました: HTTP ${res.status}`);
  }

  const data = await res.json();
  if (!data.access_token) {
    throw new Error('access_token が応答に含まれていません');
  }
  return data.access_token;
}

// ─── Internal fetch helper ───────────────────────────────────────────────────

/**
 * Google Calendar API へ認証付きリクエストを送る内部ヘルパー。
 * @param {string} accessToken
 * @param {string} path - 完全な URL または CALENDAR_BASE からの相対パス（/ 始まり）
 * @param {RequestInit} [opts]
 * @returns {Promise<object>} レスポンス JSON
 * @throws {Error} HTTP エラー時（トークンをエラーメッセージに含めない）
 */
async function calendarFetch(accessToken, path, opts = {}) {
  const url = path.startsWith('http') ? path : `${CALENDAR_BASE}${path}`;
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    'Content-Type': 'application/json',
    ...(opts.headers ?? {}),
  };

  const res = await fetch(url, { ...opts, headers });

  if (!res.ok) {
    let errDetail = `HTTP ${res.status}`;
    try {
      const body = await res.json();
      // エラー詳細を含めるが、URL からトークンは除外
      errDetail = `HTTP ${res.status}: ${body?.error?.message ?? body?.error ?? '不明なエラー'}`;
    } catch {
      // JSON パース失敗時はステータスコードのみ
    }
    throw new Error(`Calendar API エラー: ${errDetail}`);
  }

  // 204 No Content など body がない場合
  const text = await res.text();
  if (!text) return {};
  return JSON.parse(text);
}

// ─── Calendars ───────────────────────────────────────────────────────────────

/**
 * 認証ユーザーのカレンダー一覧を取得する。
 * @param {string} accessToken
 * @returns {Promise<Array<{ id: string, summary: string, description: string, primary: boolean, accessRole: string, writable: boolean }>>}
 */
export async function listCalendars(accessToken) {
  const data = await calendarFetch(accessToken, '/users/me/calendarList');
  const items = data.items ?? [];
  return items.map(cal => ({
    id:          cal.id,
    summary:     cal.summary ?? '',
    description: cal.description ?? '',
    primary:     cal.primary === true,
    accessRole:  cal.accessRole ?? '',
    writable:    cal.accessRole === 'owner' || cal.accessRole === 'writer',
  }));
}

// ─── Events ──────────────────────────────────────────────────────────────────

/**
 * カレンダーのイベント一覧を取得する。
 * @param {string} accessToken
 * @param {string} calendarId
 * @param {{ timeMin?: string, timeMax?: string, maxResults?: number, pageToken?: string }} [opts]
 * @returns {Promise<{ items: object[], nextPageToken: string|null }>}
 */
export async function listEvents(accessToken, calendarId, {
  timeMin,
  timeMax,
  maxResults,
  pageToken,
} = {}) {
  const params = new URLSearchParams({ singleEvents: 'true', orderBy: 'startTime' });
  if (timeMin)     params.set('timeMin',     timeMin);
  if (timeMax)     params.set('timeMax',     timeMax);
  if (maxResults)  params.set('maxResults',  String(maxResults));
  if (pageToken)   params.set('pageToken',   pageToken);

  const encodedId = encodeURIComponent(calendarId);
  const data = await calendarFetch(accessToken, `/calendars/${encodedId}/events?${params}`);

  return {
    items:         data.items ?? [],
    nextPageToken: data.nextPageToken ?? null,
  };
}

/**
 * カレンダーにイベントを新規作成する。
 * @param {string} accessToken
 * @param {string} calendarId
 * @param {object} event - Google Calendar event resource
 * @returns {Promise<object>} 作成されたイベント（id を含む）
 */
export async function createEvent(accessToken, calendarId, event) {
  const encodedId = encodeURIComponent(calendarId);
  return calendarFetch(accessToken, `/calendars/${encodedId}/events`, {
    method: 'POST',
    body:   JSON.stringify(event),
  });
}

/**
 * カレンダーのイベントを更新する（PUT 全置換）。
 * @param {string} accessToken
 * @param {string} calendarId
 * @param {string} eventId
 * @param {object} event - Google Calendar event resource
 * @returns {Promise<object>} 更新されたイベント
 */
export async function updateEvent(accessToken, calendarId, eventId, event) {
  const encodedCalId   = encodeURIComponent(calendarId);
  const encodedEventId = encodeURIComponent(eventId);
  return calendarFetch(accessToken, `/calendars/${encodedCalId}/events/${encodedEventId}`, {
    method: 'PUT',
    body:   JSON.stringify(event),
  });
}

/**
 * カレンダーのイベントを削除する。
 * @param {string} accessToken
 * @param {string} calendarId
 * @param {string} eventId
 * @returns {Promise<void>}
 */
export async function deleteEvent(accessToken, calendarId, eventId) {
  const encodedCalId   = encodeURIComponent(calendarId);
  const encodedEventId = encodeURIComponent(eventId);
  await calendarFetch(accessToken, `/calendars/${encodedCalId}/events/${encodedEventId}`, {
    method: 'DELETE',
  });
}

/**
 * extendedProperties.private の key=value でイベントを検索する。
 * @param {string} accessToken
 * @param {string} calendarId
 * @param {string} key
 * @param {string} value
 * @returns {Promise<object[]>} イベント配列
 */
export async function findEventsByExtendedProperty(accessToken, calendarId, key, value) {
  const params = new URLSearchParams({
    privateExtendedProperty: `${key}=${value}`,
    singleEvents: 'true',
  });
  const encodedId = encodeURIComponent(calendarId);
  const data = await calendarFetch(accessToken, `/calendars/${encodedId}/events?${params}`);
  return data.items ?? [];
}

/**
 * 新しいカレンダーを作成する。
 * @param {string} accessToken
 * @param {string} summary - カレンダー名
 * @param {string} [description] - 説明
 * @returns {Promise<{ id: string, summary: string }>}
 */
export async function createCalendar(accessToken, summary, description = '') {
  const data = await calendarFetch(accessToken, 'https://www.googleapis.com/calendar/v3/calendars', {
    method: 'POST',
    body:   JSON.stringify({ summary, description }),
  });
  return { id: data.id, summary: data.summary };
}
