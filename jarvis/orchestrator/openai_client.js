/**
 * jarvis/orchestrator/openai_client.js
 * OpenAI Responses API クライアント（外部通信はこのモジュールのみ・git操作なし）
 *
 * テストでは globalThis.fetch を差し替えてモック通信を使用すること。
 * 実 OpenAI API への通信は本番実行時のみ行う。
 */

import { randomUUID } from 'crypto';
import { canCallOpenAI, recordUsage } from './budget_tracker.js';

// ─── API エンドポイント ───────────────────────────────────────────────────────
const OPENAI_API_URL = 'https://api.openai.com/v1/responses';

// ─── シークレットパターン（4種）──────────────────────────────────────────────
// 過剰検知を避けるため最小限・明示的なパターンのみ
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9]{10,}/,                        // OpenAI APIキー形式
  /-----BEGIN [A-Z]+ PRIVATE KEY/,              // PEM 秘密鍵
  /Bearer\s+[A-Za-z0-9._~+/\-]{20,}/,          // Bearer トークン
  /ya29\.[A-Za-z0-9._-]{20,}/,                 // Google OAuth2 アクセストークン
];

// ─── デフォルトオプション ──────────────────────────────────────────────────────
export const DEFAULT_CLIENT_OPTIONS = Object.freeze({
  max_output_tokens:   4096,
  timeout_ms:          60_000,
  max_retries:         2,
  max_response_bytes:  1_048_576,  // 1 MB
  max_request_bytes:   524_288,    // 512 KB
  max_retry_delay_ms:  10_000,
});

// ─── PLANNING_JSON_SCHEMA ─────────────────────────────────────────────────────
export const PLANNING_JSON_SCHEMA = Object.freeze({
  type: 'object',
  properties: {
    summary: { type: 'string' },
    actions: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          type:        { type: 'string' },
          path:        { type: 'string' },
          description: { type: 'string' },
          operations: {
            anyOf: [
              {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    op:       { type: 'string' },
                    old_text: { type: 'string' },
                    new_text: { type: 'string' },
                  },
                  required: ['op', 'old_text', 'new_text'],
                  additionalProperties: false,
                },
              },
              { type: 'null' },
            ],
          },
          content: { anyOf: [{ type: 'string' }, { type: 'null' }] },
          test_id: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        },
        required: ['type', 'path', 'description', 'operations', 'content', 'test_id'],
        additionalProperties: false,
      },
    },
    requires_human_approval: { type: 'boolean' },
    warnings: {
      type: 'array',
      items: { type: 'string' },
    },
  },
  required: ['summary', 'actions', 'requires_human_approval', 'warnings'],
  additionalProperties: false,
});

// ─── エラークラス ─────────────────────────────────────────────────────────────
export class OpenAIClientError extends Error {
  /**
   * @param {string} code    - エラーコード（例: 'OPENAI_TIMEOUT'）
   * @param {string} message - エラーメッセージ
   * @param {object} [extra] - 追加フィールド（http_status, x_request_id など）
   */
  constructor(code, message, extra = {}) {
    super(message);
    this.name = 'OpenAIClientError';
    this.code = code;
    Object.assign(this, extra);
  }
}

// ─── シークレット検出 ──────────────────────────────────────────────────────────
/**
 * 文字列にシークレットパターンが含まれるか検出する。
 * @param {string} text
 * @returns {boolean}
 */
function containsSecret(text) {
  if (typeof text !== 'string') return false;
  return SECRET_PATTERNS.some(p => p.test(text));
}

// ─── 入力バリデーション ───────────────────────────────────────────────────────
/**
 * callOpenAI のオプションを検証する。
 * @param {object} opts
 * @throws {OpenAIClientError} OPENAI_INVALID_ARGUMENT
 */
function validateOpts(opts) {
  if (!opts || typeof opts !== 'object' || Array.isArray(opts)) {
    throw new OpenAIClientError('OPENAI_INVALID_ARGUMENT', 'opts must be an object');
  }
  if (typeof opts.model !== 'string' || opts.model.trim() === '') {
    throw new OpenAIClientError('OPENAI_INVALID_ARGUMENT', 'opts.model must be a non-empty string');
  }
  if (typeof opts.instructions !== 'string' || opts.instructions.trim() === '') {
    throw new OpenAIClientError('OPENAI_INVALID_ARGUMENT', 'opts.instructions must be a non-empty string');
  }
  if (typeof opts.input !== 'string' || opts.input.trim() === '') {
    throw new OpenAIClientError('OPENAI_INVALID_ARGUMENT', 'opts.input must be a non-empty string');
  }

  // timeout_ms: 1,000–120,000
  if (opts.timeout_ms !== undefined) {
    const v = opts.timeout_ms;
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 1_000 || v > 120_000) {
      throw new OpenAIClientError(
        'OPENAI_INVALID_ARGUMENT',
        'opts.timeout_ms must be a number between 1000 and 120000'
      );
    }
  }

  // max_retries: 0–2（整数）
  if (opts.max_retries !== undefined) {
    const v = opts.max_retries;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 2) {
      throw new OpenAIClientError(
        'OPENAI_INVALID_ARGUMENT',
        'opts.max_retries must be an integer between 0 and 2'
      );
    }
  }

  // max_response_bytes: 1,024–2,097,152（整数）
  if (opts.max_response_bytes !== undefined) {
    const v = opts.max_response_bytes;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1_024 || v > 2_097_152) {
      throw new OpenAIClientError(
        'OPENAI_INVALID_ARGUMENT',
        'opts.max_response_bytes must be an integer between 1024 and 2097152'
      );
    }
  }

  // max_request_bytes: 1,024–2,097,152（整数）
  if (opts.max_request_bytes !== undefined) {
    const v = opts.max_request_bytes;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1_024 || v > 2_097_152) {
      throw new OpenAIClientError(
        'OPENAI_INVALID_ARGUMENT',
        'opts.max_request_bytes must be an integer between 1024 and 2097152'
      );
    }
  }

  // max_output_tokens: 1–∞（正の整数）
  if (opts.max_output_tokens !== undefined) {
    const v = opts.max_output_tokens;
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
      throw new OpenAIClientError(
        'OPENAI_INVALID_ARGUMENT',
        'opts.max_output_tokens must be a positive integer'
      );
    }
  }
}

// ─── レスポンスボディ読み取り（サイズ上限付き）────────────────────────────────
/**
 * Response ボディをサイズ上限付きで読み取る。
 * body が ReadableStream の場合はストリーミング読み取りでサイズを監視する。
 * フォールバックとして response.text() も試みる（モック向け）。
 *
 * @param {Response} response
 * @param {number}   maxBytes
 * @returns {Promise<string>}
 * @throws {OpenAIClientError} OPENAI_RESPONSE_TOO_LARGE
 */
async function readBodyWithLimit(response, maxBytes) {
  // ReadableStream が使える場合はストリーミング読み取り
  if (response.body && typeof response.body.getReader === 'function') {
    const reader = response.body.getReader();
    const chunks = [];
    let totalBytes = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        totalBytes += value.byteLength;
        if (totalBytes > maxBytes) {
          reader.cancel().catch(() => {});
          throw new OpenAIClientError(
            'OPENAI_RESPONSE_TOO_LARGE',
            `Response body exceeded max_response_bytes: ${maxBytes}`
          );
        }
        chunks.push(value);
      }
    } catch (e) {
      if (e instanceof OpenAIClientError) throw e;
      throw e;
    }

    // チャンクを結合して UTF-8 デコード
    const merged = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder('utf-8').decode(merged);
  }

  // フォールバック: response.text()（モック等で body が存在しない場合）
  const text = await response.text();
  const byteLen = Buffer.byteLength(text, 'utf8');
  if (byteLen > maxBytes) {
    throw new OpenAIClientError(
      'OPENAI_RESPONSE_TOO_LARGE',
      `Response body exceeded max_response_bytes: ${maxBytes}`
    );
  }
  return text;
}

// ─── HTTP エラー分類 ──────────────────────────────────────────────────────────
/**
 * HTTP ステータスコードからエラーコードとリトライ可否を返す。
 * @param {number} status
 * @returns {{ code: string, retryable: boolean }}
 */
function classifyHttpError(status) {
  if (status === 429) return { code: 'OPENAI_RATE_LIMITED',  retryable: true  };
  if (status === 401) return { code: 'OPENAI_AUTH_ERROR',    retryable: false };
  if (status === 403) return { code: 'OPENAI_AUTH_ERROR',    retryable: false };
  if (status === 400) return { code: 'OPENAI_BAD_REQUEST',   retryable: false };
  if (status >= 500)  return { code: 'OPENAI_SERVER_ERROR',  retryable: true  };
  return               { code: 'OPENAI_SERVER_ERROR',  retryable: false };
}

// ─── レスポンスオブジェクトのパース ────────────────────────────────────────────
/**
 * JSON 文字列をパースしてオブジェクトを返す。
 * @param {string} rawText
 * @returns {object}
 * @throws {OpenAIClientError} OPENAI_INVALID_RESPONSE
 */
function parseResponseObject(rawText) {
  let obj;
  try {
    obj = JSON.parse(rawText);
  } catch (e) {
    throw new OpenAIClientError(
      'OPENAI_INVALID_RESPONSE',
      `Failed to parse response JSON: ${e.message}`
    );
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new OpenAIClientError('OPENAI_INVALID_RESPONSE', 'Response is not a JSON object');
  }
  return obj;
}

// ─── レスポンスステータス確認 ─────────────────────────────────────────────────
/**
 * Responses API のステータスフィールドを確認する。
 * 'completed' 以外はエラー。
 * @param {object} obj
 * @throws {OpenAIClientError} OPENAI_INVALID_RESPONSE
 */
function checkResponseStatus(obj) {
  const status = obj.status;
  if (status !== 'completed') {
    throw new OpenAIClientError(
      'OPENAI_INVALID_RESPONSE',
      `Response status is "${status}", expected "completed"`
    );
  }
}

// ─── 出力テキスト抽出 ──────────────────────────────────────────────────────────
/**
 * Responses API レスポンスから出力テキストを抽出する。
 * output[].type === 'message' の content[].type === 'output_text' を結合して返す。
 * refusal が検出された場合は OPENAI_REFUSAL をスロー。
 * unknown な content type はスキップする。
 *
 * @param {object} obj
 * @returns {string}
 * @throws {OpenAIClientError} OPENAI_REFUSAL | OPENAI_INVALID_RESPONSE
 */
function extractOutputText(obj) {
  const output = obj.output;
  if (!Array.isArray(output) || output.length === 0) {
    throw new OpenAIClientError('OPENAI_INVALID_RESPONSE', 'Response has no output array');
  }

  const textParts = [];

  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    if (item.type !== 'message') continue;

    const content = item.content;
    if (!Array.isArray(content)) continue;

    for (const c of content) {
      if (!c || typeof c !== 'object') continue;

      if (c.type === 'refusal') {
        throw new OpenAIClientError(
          'OPENAI_REFUSAL',
          `Model refused to respond: ${c.refusal ?? 'no reason given'}`
        );
      }

      if (c.type === 'output_text') {
        if (typeof c.text === 'string') {
          textParts.push(c.text);
        }
      }
      // unknown type はスキップ
    }
  }

  if (textParts.length === 0) {
    throw new OpenAIClientError('OPENAI_INVALID_RESPONSE', 'No output_text found in response output');
  }

  return textParts.join('');
}

// ─── プランニング出力パース ────────────────────────────────────────────────────
/**
 * 構造化出力テキストを JSON パースして PLANNING_JSON_SCHEMA に沿って検証する。
 *
 * useStructuredOutput === true  → fail-closed: パース失敗 → { ok: false }
 * useStructuredOutput === false → fail-open:   パース失敗 → { ok: true, parsed_output: null }
 *
 * @param {string}  text
 * @param {boolean} useStructuredOutput
 * @returns {{ ok: boolean, parsed_output: object|null, error?: string }}
 */
function parsePlanningOutput(text, useStructuredOutput) {
  try {
    const parsed = JSON.parse(text);

    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('parsed output is not an object');
    }
    if (typeof parsed.summary !== 'string') {
      throw new Error('summary must be a string');
    }
    if (!Array.isArray(parsed.actions)) {
      throw new Error('actions must be an array');
    }
    if (typeof parsed.requires_human_approval !== 'boolean') {
      throw new Error('requires_human_approval must be a boolean');
    }
    if (!Array.isArray(parsed.warnings)) {
      throw new Error('warnings must be an array');
    }

    return { ok: true, parsed_output: parsed };

  } catch (e) {
    if (useStructuredOutput) {
      // fail-closed: 構造化出力のパース失敗はエラー
      return { ok: false, parsed_output: null, error: e.message };
    } else {
      // fail-open: 非構造化の場合はパース失敗でも ok:true
      return { ok: true, parsed_output: null, error: e.message };
    }
  }
}

// ─── usage 抽出 ───────────────────────────────────────────────────────────────
/**
 * レスポンスオブジェクトから usage を型安全に抽出する。
 * 型チェック失敗時は { usage: null, usage_available: false } を返す（例外スローしない）。
 *
 * @param {object} obj
 * @returns {{ usage: object|null, usage_available: boolean }}
 */
function extractUsage(obj) {
  const u = obj.usage;
  if (!u || typeof u !== 'object' || Array.isArray(u)) {
    return { usage: null, usage_available: false };
  }

  const inputTokens  = u.input_tokens;
  const outputTokens = u.output_tokens;

  if (
    typeof inputTokens !== 'number' ||
    !Number.isFinite(inputTokens) ||
    inputTokens < 0
  ) {
    return { usage: null, usage_available: false };
  }
  if (
    typeof outputTokens !== 'number' ||
    !Number.isFinite(outputTokens) ||
    outputTokens < 0
  ) {
    return { usage: null, usage_available: false };
  }

  // cached tokens はオプション（存在しなければ 0）
  let cachedTokens = 0;
  const details = u.input_tokens_details;
  if (details && typeof details === 'object' && !Array.isArray(details)) {
    const c = details.cached_tokens;
    if (typeof c === 'number' && Number.isFinite(c) && c >= 0) {
      cachedTokens = c;
    }
  }

  return {
    usage: {
      input_tokens:        inputTokens,
      output_tokens:       outputTokens,
      cached_input_tokens: cachedTokens,
    },
    usage_available: true,
  };
}

// ─── バックオフ計算 ────────────────────────────────────────────────────────────
/**
 * リトライ前のバックオフ時間（ms）を計算する。
 * Retry-After ヘッダがあればそれを優先。なければ指数バックオフ＋ジッター。
 * maxDelayMs でキャップする。
 *
 * @param {number}        retryIndex  - 何回目のリトライか（1始まり）
 * @param {object|null}   lastResp    - 直前のレスポンスオブジェクト（ヘッダ参照用）
 * @param {number}        maxDelayMs
 * @returns {number} ms
 */
function calcBackoff(retryIndex, lastResp, maxDelayMs) {
  if (lastResp) {
    const retryAfter = lastResp.headers.get('Retry-After');
    if (retryAfter !== null && retryAfter !== undefined) {
      const secs = Number(retryAfter);
      if (Number.isFinite(secs) && secs > 0) {
        return Math.min(secs * 1_000, maxDelayMs);
      }
    }
  }

  // 指数バックオフ: 1000ms * 2^(retryIndex-1) にジッター最大 1000ms を加算
  const expBase = 1_000 * Math.pow(2, retryIndex - 1);
  const jitter  = Math.random() * 1_000;
  return Math.min(expBase + jitter, maxDelayMs);
}

// ─── メイン公開 API ───────────────────────────────────────────────────────────
/**
 * OpenAI Responses API を呼び出す。
 *
 * @param {object}  opts
 * @param {string}  opts.model                       - 使用モデル（必須）
 * @param {string}  opts.instructions                - システム指示（必須）
 * @param {string}  opts.input                       - ユーザー入力（必須）
 * @param {object}  [opts.budgetState]               - budget_tracker の状態オブジェクト
 * @param {object}  [opts.budgetLimits]              - { max_openai_calls?, max_cost_usd? }
 * @param {boolean} [opts.use_structured_output]     - 構造化出力を使用するか（デフォルト true）
 * @param {number}  [opts.max_output_tokens]         - デフォルト 4096
 * @param {number}  [opts.timeout_ms]               - デフォルト 60000（範囲: 1000–120000）
 * @param {number}  [opts.max_retries]              - デフォルト 2（範囲: 0–2）
 * @param {number}  [opts.max_response_bytes]       - デフォルト 1048576（範囲: 1024–2097152）
 * @param {number}  [opts.max_request_bytes]        - デフォルト 524288（範囲: 1024–2097152）
 * @param {number}  [opts.max_retry_delay_ms]       - デフォルト 10000
 *
 * @returns {Promise<object>}
 *   成功: { ok:true, output_text, parsed_output, usage_available, usage, attempts, x_request_id }
 *   失敗: { ok:false, error_code, error_message, attempts, [x_request_id], [http_status] }
 */
export async function callOpenAI(opts = {}) {

  // ── 1. 入力検証 ─────────────────────────────────────────────────────────────
  try {
    validateOpts(opts);
  } catch (e) {
    return {
      ok:            false,
      error_code:    e.code,
      error_message: e.message,
      attempts:      0,
    };
  }

  const model             = opts.model;
  const instructions      = opts.instructions;
  const input             = opts.input;
  const budgetState       = opts.budgetState    ?? null;
  const budgetLimits      = opts.budgetLimits   ?? {};
  const useStructured     = opts.use_structured_output !== false; // デフォルト true
  const maxOutputTokens   = opts.max_output_tokens  ?? DEFAULT_CLIENT_OPTIONS.max_output_tokens;
  const timeoutMs         = opts.timeout_ms         ?? DEFAULT_CLIENT_OPTIONS.timeout_ms;
  const maxRetries        = opts.max_retries         ?? DEFAULT_CLIENT_OPTIONS.max_retries;
  const maxResponseBytes  = opts.max_response_bytes  ?? DEFAULT_CLIENT_OPTIONS.max_response_bytes;
  const maxRequestBytes   = opts.max_request_bytes   ?? DEFAULT_CLIENT_OPTIONS.max_request_bytes;
  const maxRetryDelayMs   = opts.max_retry_delay_ms  ?? DEFAULT_CLIENT_OPTIONS.max_retry_delay_ms;

  // ── 2. APIキー取得 ─────────────────────────────────────────────────────────
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey || typeof apiKey !== 'string' || apiKey.trim() === '') {
    return {
      ok:            false,
      error_code:    'OPENAI_API_KEY_MISSING',
      error_message: 'OPENAI_API_KEY environment variable is not set',
      attempts:      0,
    };
  }

  // ── 3. 初期バジェットチェック ─────────────────────────────────────────────
  if (budgetState !== null) {
    const budgetCheck = canCallOpenAI(budgetState, budgetLimits);
    if (!budgetCheck.allowed) {
      return {
        ok:            false,
        error_code:    'OPENAI_BUDGET_BLOCKED',
        error_message: `Budget limit exceeded: ${budgetCheck.reason}`,
        attempts:      0,
      };
    }
  }

  // ── 4. instructions / input のシークレットチェック ─────────────────────────
  if (containsSecret(instructions) || containsSecret(input)) {
    return {
      ok:            false,
      error_code:    'OPENAI_SECRET_DETECTED',
      error_message: 'Secret pattern detected in instructions or input',
      attempts:      0,
    };
  }

  // ── 5. リクエストボディ構築 ────────────────────────────────────────────────
  const requestBody = {
    model,
    store: false,          // LITERAL — opts から上書き不可
    instructions,
    input,
    max_output_tokens: maxOutputTokens,
  };

  if (useStructured) {
    requestBody.text = {
      format: {
        type:   'json_schema',
        name:   'planning_result',
        strict: true,
        schema: PLANNING_JSON_SCHEMA,
      },
    };
  }

  // ── 6. リクエストボディ文字列化 ＆ サイズチェック ──────────────────────────
  let bodyStr;
  try {
    bodyStr = JSON.stringify(requestBody);
  } catch (e) {
    return {
      ok:            false,
      error_code:    'OPENAI_INVALID_ARGUMENT',
      error_message: `Failed to serialize request body: ${e.message}`,
      attempts:      0,
    };
  }

  const bodyBytes = Buffer.byteLength(bodyStr, 'utf8');
  if (bodyBytes > maxRequestBytes) {
    return {
      ok:            false,
      error_code:    'OPENAI_REQUEST_TOO_LARGE',
      error_message: `Request body ${bodyBytes} bytes exceeds max_request_bytes ${maxRequestBytes}`,
      attempts:      0,
    };
  }

  // ── 7. シリアライズ済みボディのシークレットチェック ──────────────────────
  if (containsSecret(bodyStr)) {
    return {
      ok:            false,
      error_code:    'OPENAI_SECRET_DETECTED',
      error_message: 'Secret pattern detected in serialized request body',
      attempts:      0,
    };
  }

  // ── 8. リトライループ ──────────────────────────────────────────────────────
  let attempts     = 0;
  let lastError    = null;
  let lastResponse = null;   // Retry-After ヘッダ参照用

  for (let retry = 0; retry <= maxRetries; retry++) {

    // ── per-attempt バジェットチェック ──────────────────────────────────────
    // budgetState.openai_calls（外部記録済み）＋ attempts（本呼び出し内） >= 上限 → BREAK
    if (budgetState !== null) {
      const maxCalls = budgetLimits.max_openai_calls ?? null;
      if (maxCalls !== null) {
        if (budgetState.openai_calls + attempts >= maxCalls) {
          lastError = {
            error_code:    'OPENAI_BUDGET_BLOCKED',
            error_message: `Per-attempt budget blocked: openai_calls ${budgetState.openai_calls} + attempts ${attempts} >= max_openai_calls ${maxCalls}`,
          };
          break;
        }
      }
    }

    // ── バックオフ（2回目以降）────────────────────────────────────────────
    if (retry > 0) {
      const delay = calcBackoff(retry, lastResponse, maxRetryDelayMs);
      await new Promise(res => setTimeout(res, delay));
    }

    // ── X-Client-Request-Id（試行ごとに新しい UUID）────────────────────────
    const requestId = randomUUID();

    // ── 試行カウントを更新（fetch 直前）────────────────────────────────────
    attempts++;

    // ── fetch 実行 ───────────────────────────────────────────────────────────
    let response;
    try {
      response = await globalThis.fetch(OPENAI_API_URL, {
        method:   'POST',
        redirect: 'error',
        signal:   AbortSignal.timeout(timeoutMs),
        headers: {
          'Content-Type':        'application/json',
          'Authorization':       `Bearer ${apiKey}`,
          'X-Client-Request-Id': requestId,
        },
        body: bodyStr,
      });
    } catch (e) {
      lastResponse = null;
      const isTimeout = e?.name === 'TimeoutError' || e?.name === 'AbortError';
      if (isTimeout) {
        lastError = {
          error_code:    'OPENAI_TIMEOUT',
          error_message: `Request timed out after ${timeoutMs}ms`,
        };
      } else {
        lastError = {
          error_code:    'OPENAI_NETWORK_ERROR',
          error_message: `Network error: ${e.message}`,
        };
      }
      continue; // ネットワークエラー・タイムアウトはリトライ可能
    }

    lastResponse = response;
    const xRequestId = response.headers.get('x-request-id') ?? null;

    // ── HTTP エラー判定 ──────────────────────────────────────────────────────
    if (!response.ok) {
      const { code, retryable } = classifyHttpError(response.status);
      lastError = {
        error_code:   code,
        error_message: `HTTP ${response.status}`,
        http_status:  response.status,
        x_request_id: xRequestId,
      };
      if (retryable) continue;
      break;
    }

    // ── レスポンスボディ読み取り（サイズ上限付き）──────────────────────────
    let rawText;
    try {
      rawText = await readBodyWithLimit(response, maxResponseBytes);
    } catch (e) {
      lastError = {
        error_code:    e.code ?? 'OPENAI_NETWORK_ERROR',
        error_message: e.message,
        x_request_id: xRequestId,
      };
      break; // サイズ超過はリトライしない
    }

    // ── JSON パース ──────────────────────────────────────────────────────────
    let responseObj;
    try {
      responseObj = parseResponseObject(rawText);
    } catch (e) {
      lastError = {
        error_code:    e.code,
        error_message: e.message,
        x_request_id: xRequestId,
      };
      break;
    }

    // ── レスポンスステータス確認 ────────────────────────────────────────────
    try {
      checkResponseStatus(responseObj);
    } catch (e) {
      lastError = {
        error_code:    e.code,
        error_message: e.message,
        x_request_id: xRequestId,
      };
      break;
    }

    // ── 出力テキスト抽出 ─────────────────────────────────────────────────────
    let outputText;
    try {
      outputText = extractOutputText(responseObj);
    } catch (e) {
      lastError = {
        error_code:    e.code,
        error_message: e.message,
        x_request_id: xRequestId,
      };
      break;
    }

    // ── プランニング出力パース ────────────────────────────────────────────────
    const parseResult = parsePlanningOutput(outputText, useStructured);

    if (!parseResult.ok) {
      // fail-closed: 構造化出力のパース失敗は即時エラー返却
      // usage は取得できていれば記録する（APIは実際に呼ばれているため）
      if (budgetState !== null) {
        const { usage, usage_available } = extractUsage(responseObj);
        recordUsage(budgetState, usage_available
          ? usage
          : { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 });
      }
      return {
        ok:            false,
        error_code:    'OPENAI_OUTPUT_PARSE_ERROR',
        error_message: `Failed to parse planning output: ${parseResult.error}`,
        attempts,
        x_request_id:  xRequestId,
      };
    }

    // ── usage 抽出 ───────────────────────────────────────────────────────────
    const { usage, usage_available } = extractUsage(responseObj);

    // ── バジェット記録 ────────────────────────────────────────────────────────
    if (budgetState !== null) {
      recordUsage(budgetState, usage_available
        ? usage
        : { input_tokens: 0, output_tokens: 0, cached_input_tokens: 0 });
    }

    // ── 成功レスポンス ────────────────────────────────────────────────────────
    return {
      ok:              true,
      output_text:     outputText,
      parsed_output:   parseResult.parsed_output,
      usage_available,
      usage:           usage_available ? usage : null,
      attempts,
      x_request_id:    xRequestId,
    };
  }

  // ── 全試行失敗 ───────────────────────────────────────────────────────────────
  const result = {
    ok:            false,
    error_code:    lastError?.error_code    ?? 'OPENAI_NETWORK_ERROR',
    error_message: lastError?.error_message ?? 'Unknown error after all retries',
    attempts,
  };
  if (lastError?.x_request_id) result.x_request_id = lastError.x_request_id;
  if (lastError?.http_status)  result.http_status   = lastError.http_status;
  return result;
}

// ─── テスト用内部エクスポート ─────────────────────────────────────────────────
export {
  OPENAI_API_URL,
  containsSecret,
  parsePlanningOutput,
  extractUsage,
  classifyHttpError,
};
