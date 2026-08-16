/**
 * jarvis/sync/soundrop_client.mjs
 * Soundrop read-only API クライアント
 *
 * 安全原則:
 * - GET のみ。POST / PUT / PATCH / DELETE は一切実行しない。
 * - Token はクエリパラメータとして送信するが、ログへの出力前に除去する。
 * - Token を戻り値・ログ・DB・ファイルに一切保存しない。
 * - raw レスポンスをそのまま DB へ保存しない。
 *
 * Windows Node.js 安定性:
 * - !res.ok 時は必ず res.body を消費してから throw（UV_HANDLE_CLOSING 防止）
 * - AbortController timer は .unref() でイベントループを保持しない
 * - process.exit() はモジュール内では呼び出さない
 */

const BASE_URL          = 'https://soundrop.com';
const DEFAULT_PAGE_SIZE = 50;
const REQUEST_DELAY_MS  = 400;    // rate limit 対策
const REQUEST_TIMEOUT_MS = 15000; // 15秒タイムアウト

// ── Token を除去した安全な URL（ログ用） ─────────────────────────────────────
function safeUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    u.searchParams.delete('Token');
    u.searchParams.delete('token');
    return u.pathname + (u.search || '');
  } catch {
    return '[invalid url]';
  }
}

// ── Token を文字列から除去（エラーメッセージ sanitize 用） ───────────────────
function sanitize(str, token) {
  if (!str || !token) return str ?? '';
  return String(str).replaceAll(token, '[TOKEN]');
}

// ── delay ─────────────────────────────────────────────────────────────────────
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── HTTP レスポンスのボディを安全に読み取る（最大 512 バイト） ─────────────────
// Windows の UV_HANDLE_CLOSING 防止のため、エラー時も必ずボディを消費する。
async function drainBody(res, token) {
  try {
    const text = await res.text();
    // Token が response body に混入している場合を除去（念のため）
    return sanitize(text.slice(0, 512).replace(/\s+/g, ' '), token);
  } catch {
    return '(body read error)';
  }
}

// ── 単一 GET リクエスト ───────────────────────────────────────────────────────
async function get(path, params, token) {
  const url = new URL(path, BASE_URL);
  for (const [k, v] of Object.entries(params)) {
    if (v !== null && v !== undefined) url.searchParams.set(k, String(v));
  }
  // Token は最後にセット（途中で URL を文字列化しない）
  url.searchParams.set('Token', token);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  // .unref(): タイムアウト待機中でもイベントループを保持しない
  // → Node プロセスが自然終了できる（UV_HANDLE_CLOSING 防止）
  if (timer.unref) timer.unref();

  try {
    const res = await fetch(url.toString(), {
      method: 'GET',
      signal: controller.signal,
      headers: { 'Accept': 'application/json' },
    });

    if (!res.ok) {
      // 必ずボディを消費してから throw する。
      // ボディを読まずに throw すると TCP ハンドルが CLOSING 中に残り、
      // Windows Node.js で UV_HANDLE_CLOSING assertion が発生する。
      const bodySummary = await drainBody(res, token);
      const err = new Error(`HTTP ${res.status} — ${safeUrl(url.toString())}`);
      err.httpStatus   = res.status;
      err.safePath     = safeUrl(url.toString());
      err.bodySummary  = bodySummary;
      throw err;
    }

    return await res.json();
  } catch (e) {
    if (e.name === 'AbortError') {
      const err = new Error(`Timeout (${REQUEST_TIMEOUT_MS}ms): ${safeUrl(url.toString())}`);
      err.httpStatus  = null;
      err.safePath    = safeUrl(url.toString());
      err.bodySummary = '(request timed out)';
      throw err;
    }
    // httpStatus が設定済み = 上記の !res.ok エラー → そのまま再 throw
    if (e.httpStatus !== undefined) throw e;
    // ネットワークエラー等: Token が含まれないよう sanitize
    const safeMsg = sanitize(e.message, token);
    const err = new Error(`${safeMsg} (${safeUrl(url.toString())})`);
    err.httpStatus  = null;
    err.safePath    = safeUrl(url.toString());
    err.bodySummary = '(network error)';
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

// ── ページネーション付き全件取得 ──────────────────────────────────────────────
async function fetchAllPages(path, extraParams, token, options = {}) {
  const pageSize = options.pageSize ?? DEFAULT_PAGE_SIZE;
  const onPage   = options.onPage;
  let pageNumber = 1;
  let allItems   = [];

  while (true) {
    const params = {
      orderByDescending: true,
      pageSize,
      pageNumber,
      ...extraParams,
    };

    const data  = await get(path, params, token);
    const items = data.items ?? [];
    allItems    = allItems.concat(items);

    if (onPage) onPage({ pageNumber, count: items.length, total: data.totalItemsCount ?? 0 });

    const fetched = pageNumber * pageSize;
    if (items.length === 0 || fetched >= (data.totalItemsCount ?? 0)) break;

    pageNumber++;
    await delay(REQUEST_DELAY_MS);
  }

  return allItems;
}

// ── 公開 API ─────────────────────────────────────────────────────────────────

/**
 * リリース一覧を全件取得する (GET /content/release/all)
 * @param {string} token
 * @param {object} [options]
 * @param {number} [options.pageSize]
 * @param {function} [options.onPage]
 * @returns {Promise<object[]>}
 */
export async function fetchAllReleases(token, options = {}) {
  return fetchAllPages(
    '/content/release/all',
    { orderByProperty: 'releaseDate' },
    token,
    options,
  );
}

/**
 * トラック一覧を全件取得する (GET /content/track/all)
 * @param {string} token
 * @param {object} [options]
 * @returns {Promise<object[]>}
 */
export async function fetchAllTracks(token, options = {}) {
  return fetchAllPages(
    '/content/track/all',
    { orderByProperty: 'creationDate' },
    token,
    options,
  );
}

/**
 * リリース詳細を1件取得する (GET /content/release?id={releaseId}&useVersion=true)
 * @param {string} token
 * @param {number} releaseId
 * @returns {Promise<object>}
 */
export async function fetchReleaseDetail(token, releaseId) {
  await delay(REQUEST_DELAY_MS);
  return get('/content/release', { id: releaseId, useVersion: true }, token);
}

/**
 * DevTools の Request URL または生 Token 文字列から Token を抽出する。
 *
 * - URL の場合: URLSearchParams で Token / token パラメータを取得（URL デコード自動）
 * - URL でない場合: 入力文字列そのものを Token として返す
 * - URL に Token パラメータがない場合: null を返す
 * - 入力値はログへ出力しない・DB/ファイルへ保存しない
 *
 * @param {string} raw - Request URL 全体または生 Token 文字列
 * @returns {string|null} Token 文字列、または null（Token 未検出）
 */
export function extractTokenFromInput(raw) {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  try {
    const u = new URL(trimmed);
    // Token は大文字 'T' が Soundrop の慣例だが小文字 'token' も受け付ける
    const t = u.searchParams.get('Token') ?? u.searchParams.get('token');
    if (t && t.trim()) return t.trim();
    // 有効な URL だが Token パラメータがない → null
    return null;
  } catch {
    // URL でない → 生 Token 文字列として扱う
    return trimmed;
  }
}

/**
 * Token が有効かを検証する。
 *
 * 検証エンドポイント: GET /content/release/all?pageSize=1&pageNumber=1
 *   - /account/user は Soundrop API に存在しない可能性があるため使用しない
 *   - /content/release/all は実際の同期でも使用する確実に存在するエンドポイント
 *   - Token が無効なら 401/403 が返る
 *   - Token が有効なら items[] を含む JSON が返る
 *
 * @param {string} token
 * @returns {Promise<{ ok: boolean, httpStatus: number|null, path: string, summary: string }>}
 *   ok        : true = Token 有効
 *   httpStatus: HTTP ステータスコード（ネットワークエラー時は null）
 *   path      : エンドポイントパス（Token 除去済み）
 *   summary   : レスポンスボディの概要（Token 除去済み・最大 512 バイト）
 */
export async function verifyToken(token) {
  const testPath = '/content/release/all';
  const safePath = `${testPath}?pageSize=1&pageNumber=1&orderByDescending=true`;

  try {
    const data = await get(testPath, { pageSize: 1, pageNumber: 1 }, token);
    const ok   = Array.isArray(data?.items);
    return {
      ok,
      httpStatus:  200,
      path:        safePath,
      summary:     ok
        ? `items[${data.items.length}] / totalItemsCount=${data.totalItemsCount ?? '?'}`
        : 'unexpected response shape (items[] not found)',
    };
  } catch (e) {
    return {
      ok:          false,
      httpStatus:  e.httpStatus  ?? null,
      path:        e.safePath    ?? safePath,
      summary:     e.bodySummary ?? e.message,
    };
  }
}
