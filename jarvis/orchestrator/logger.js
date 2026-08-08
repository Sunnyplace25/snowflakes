/**
 * jarvis/orchestrator/logger.js
 * 構造化イベントロガー（外部通信なし・説明文・プロンプト禁止）
 */

import { appendFileSync, mkdirSync, existsSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ログファイルパス（jarvis/logs/orchestrator.log 固定）
const LOG_DIR  = resolve(__dirname, '..', 'logs');
const LOG_FILE = join(LOG_DIR, 'orchestrator.log');

// ─── 許可キー一覧 ─────────────────────────────────────────────────────────────
const ALLOWED_KEYS = new Set([
  'taskId',
  'event',
  'status',
  'openai_calls',
  'claude_runs',
  'decision',
  'changed_files',
  'changed_file_count',
  'test_passed',
  'test_failed',
  'prompt_tokens',
  'completion_tokens',
  'total_tokens',
  'estimated_cost_usd',
  'error_type',
  'approval_reason',
  'action_count',
  'warning_count',
  'approval_required',
  'request_id',
]);

// ─── 制御文字サニタイズ ───────────────────────────────────────────────────────
// 改行・タブ・制御文字（U+0000–U+001F, U+007F）を除去する
// JSON文字列値が改行を含むと1行ロギング原則が崩れるため
function sanitize(value) {
  if (typeof value === 'string') {
    // eslint-disable-next-line no-control-regex
    return value.replace(/[\x00-\x1F\x7F]/g, '');
  }
  return value;
}

// ─── フィールドサニタイズ（再帰しない・値のみ処理）────────────────────────────
function sanitizeFields(obj) {
  const result = {};
  for (const [k, v] of Object.entries(obj)) {
    if (Array.isArray(v)) {
      result[k] = v.map(item => sanitize(item));
    } else {
      result[k] = sanitize(v);
    }
  }
  return result;
}

// ─── ログディレクトリ保証 ──────────────────────────────────────────────────────
function ensureLogDir() {
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true });
  }
}

// ─── メイン公開 API ───────────────────────────────────────────────────────────
/**
 * logEvent(fields)
 *
 * ALLOWED_KEYS に含まれないキーは無視する。
 * 制御文字はすべてサニタイズする。
 * timestamp は自動付与（上書き不可）。
 * ロガー自体の例外はタスク処理を止めないよう内部で握り潰す。
 *
 * @param {object} fields
 */
export function logEvent(fields) {
  try {
    if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
      return;
    }

    // 許可キーのみ抽出
    const filtered = {};
    for (const key of ALLOWED_KEYS) {
      if (Object.prototype.hasOwnProperty.call(fields, key)) {
        filtered[key] = fields[key];
      }
    }

    // 値をサニタイズ
    const sanitized = sanitizeFields(filtered);

    // タイムスタンプを先頭に固定
    const entry = {
      timestamp: new Date().toISOString(),
      ...sanitized,
    };

    const line = JSON.stringify(entry) + '\n';

    ensureLogDir();
    appendFileSync(LOG_FILE, line, { encoding: 'utf8' });
  } catch {
    // ロガー失敗はタスク処理に影響させない
  }
}

// ─── テスト用内部エクスポート ─────────────────────────────────────────────────
export { LOG_FILE, LOG_DIR, ALLOWED_KEYS };
