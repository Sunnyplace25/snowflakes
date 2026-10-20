/**
 * shared/claude_router.mjs
 * JARVIS 共通 Claude API ルーター
 *
 * 使い方:
 *   import { callClaude } from '../shared/claude_router.mjs';
 *   const text = await callClaude(system, user, { tier: 'CHEAP', task: 'screening', domain: 'publishing' });
 *
 * モデル設定は .env の CLAUDE_MODEL_CHEAP / DEFAULT / STRONG で管理。
 * 将来のモデル変更は .env 1行だけ変えれば全体に反映される。
 *
 * ── 予算制御の注意事項 ────────────────────────────────────────────────────────
 * このルーターは単一 Node.js プロセス内での予算制御のみを行う。
 * 以下の場合、実際の Anthropic 請求額と累計値がずれることがある:
 *   - プロセス再起動時: _pendingUsd がリセットされる（進行中の予約が失われる）
 *   - ネットワーク断でAPI呼び出し済みだがログ記録前にクラッシュした場合
 *   - 予約額（上限見積もり）と実際のコストの差分が累積する場合
 *   - 将来的に複数プロセスで起動した場合（現在は未サポート）
 * 正確な請求額は Anthropic コンソールで確認すること。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath }               from 'node:url';
import { resolve, dirname }            from 'node:path';

const __filename    = fileURLToPath(import.meta.url);
const __dirname_esm = dirname(__filename);
const _SETTINGS_PATH = resolve(__dirname_esm, '../config/settings.json');

// ── モデルID ────────────────────────────────────────────────────────────────

const MODEL_IDS = {
  CHEAP:   process.env.CLAUDE_MODEL_CHEAP   || 'claude-haiku-4-5',
  DEFAULT: process.env.CLAUDE_MODEL_DEFAULT  || 'claude-sonnet-5-5',
  STRONG:  process.env.CLAUDE_MODEL_STRONG   || 'claude-opus-5-5',
};

export function getModel(tier = 'DEFAULT') {
  return MODEL_IDS[tier] ?? MODEL_IDS.DEFAULT;
}

// ── 料金テーブル（USD per 1M tokens）──────────────────────────────────────
// 変更時はここだけ修正すれば全体に反映される

const PRICING = {
  'claude-haiku-4-5':   { input: 1.00,  output: 5.00  },
  'claude-sonnet-5-5':  { input: 2.00,  output: 10.00 },
  'claude-opus-5-5':    { input: 4.00,  output: 20.00 },
  // フォールバック（未知モデルはSonnet単価で概算）
  _default:             { input: 2.00,  output: 10.00 },
};

export function estimateCost(model, inputTokens, outputTokens, cacheReadTokens = 0) {
  const p = PRICING[model] ?? PRICING._default;
  // キャッシュ読み込みは通常input料金の10%程度
  const cacheCost = (cacheReadTokens * p.input * 0.10) / 1_000_000;
  return (inputTokens * p.input + outputTokens * p.output) / 1_000_000 + cacheCost;
}

// ── 予算制御エラークラス ───────────────────────────────────────────────────────

/**
 * monthly_limit_usd = 0 の場合に投げる（意図的な禁止設定）。
 * 業務エラーとは区別され、プロジェクト状態は変更されない。
 * 管理画面で monthly_limit_usd を 0 より大きい値または null に変更すれば再実行可能。
 */
export class BudgetDisabledError extends Error {
  constructor() {
    super('AI呼び出しは予算設定により無効化されています（monthly_limit_usd = 0）。管理画面で予算額を設定してください。');
    this.name  = 'BudgetDisabledError';
    this.code  = 'BUDGET_DISABLED';
  }
}

/**
 * 月次予算上限に達した場合に投げる。
 * 業務エラーとは区別され、プロジェクト状態は変更されない。
 * 管理画面で monthly_limit_usd を引き上げるか翌月まで待てば再実行可能。
 */
export class BudgetExceededError extends Error {
  constructor(projectedUsd, limitUsd) {
    super(
      `月次予算上限に達しました（見込み $${projectedUsd.toFixed(4)} / 上限 $${limitUsd.toFixed(2)}）。` +
      `管理画面で予算額を引き上げるか、翌月まで待つと再実行できます。`
    );
    this.name         = 'BudgetExceededError';
    this.code         = 'BUDGET_EXCEEDED';
    this.projectedUsd = projectedUsd;
    this.limitUsd     = limitUsd;
  }
}

// ── 予算予約（同時実行による超過を抑制） ─────────────────────────────────────────
// Node.js シングルプロセス内でのみ有効。
// 複数の callClaude() が並走する場合に累計+予約合計で上限チェックする。

let _pendingUsd = 0;

/**
 * モデル tier・max_tokens・プロンプト長から予約コスト（USD）を算出する。
 * 入力トークン: プロンプト文字数 / 3 で概算（日本語2-3字/token, 英語4字/token の中間値）
 * 出力トークン: max_tokens を上限として予約（実際はほぼこの値を下回る）
 *
 * @param {string} tier
 * @param {number} maxTokens
 * @param {number} promptLength - systemPrompt + userMessage の合計文字数
 * @returns {number} 予約コスト USD
 */
function _calcReservation(tier, maxTokens, promptLength) {
  const model = getModel(tier);
  const p     = PRICING[model] ?? PRICING._default;
  const estimatedInputTokens = Math.ceil(promptLength / 3);
  return (estimatedInputTokens * p.input + maxTokens * p.output) / 1_000_000;
}

// ── ロギング ──────────────────────────────────────────────────────────────
// DBが渡されない場合はコンソールログのみ

let _logDb = null;

export function setLogDb(db) {
  _logDb = db;

  // ai_usage_log テーブル（既存）
  try {
    db.prepare(`CREATE TABLE IF NOT EXISTS ai_usage_log (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp           DATETIME NOT NULL DEFAULT (datetime('now','localtime')),
      domain              TEXT NOT NULL,
      employee            TEXT,
      task                TEXT NOT NULL,
      model               TEXT NOT NULL,
      tier                TEXT NOT NULL,
      input_tokens        INTEGER NOT NULL DEFAULT 0,
      output_tokens       INTEGER NOT NULL DEFAULT 0,
      cache_read_tokens   INTEGER NOT NULL DEFAULT 0,
      cache_create_tokens INTEGER NOT NULL DEFAULT 0,
      estimated_cost      REAL NOT NULL DEFAULT 0,
      project_id          INTEGER,
      created_at          DATETIME NOT NULL DEFAULT (datetime('now','localtime'))
    )`).run();
  } catch (e) {
    console.warn('[claude_router] ai_usage_log テーブル作成スキップ:', e.message);
  }

  // ai_budget_settings テーブル（予算設定・管理画面から変更可）
  try {
    db.prepare(`CREATE TABLE IF NOT EXISTS ai_budget_settings (
      id                     INTEGER PRIMARY KEY,
      monthly_limit_usd      REAL,
      warn_threshold_percent INTEGER NOT NULL DEFAULT 80,
      updated_at             TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    )`).run();
    // id=1 固定で1レコードのみ管理。初期値: $2.00/月
    db.prepare(`
      INSERT OR IGNORE INTO ai_budget_settings (id, monthly_limit_usd, warn_threshold_percent)
      VALUES (1, 2.00, 80)
    `).run();
  } catch (e) {
    console.warn('[claude_router] ai_budget_settings テーブル作成スキップ:', e.message);
  }
}

function logUsage({ domain, employee, task, model, tier, inputTokens, outputTokens,
                    cacheReadTokens = 0, cacheCreateTokens = 0, cost, projectId = null }) {
  if (_logDb) {
    try {
      _logDb.prepare(`INSERT INTO ai_usage_log
        (domain, employee, task, model, tier, input_tokens, output_tokens,
         cache_read_tokens, cache_create_tokens, estimated_cost, project_id)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
        domain, employee ?? null, task, model, tier,
        inputTokens, outputTokens, cacheReadTokens, cacheCreateTokens,
        cost, projectId ?? null
      );
    } catch (e) {
      console.warn('[claude_router] ログ保存失敗:', e.message);
    }
  }
  console.log(`[AI] ${tier}/${model} | ${domain}/${employee ?? '-'}/${task} | in:${inputTokens} out:${outputTokens} $${cost.toFixed(6)}`);
}

// ── 予算設定の読み込み ────────────────────────────────────────────────────────

/**
 * 予算設定を返す。優先順: DB (ai_budget_settings) → settings.json → デフォルト(null=無制限)
 *
 * @returns {{ limitUsd: number|null, warnPercent: number }}
 */
function _loadBudgetConfig() {
  // 1. DB優先
  if (_logDb) {
    try {
      const row = _logDb.prepare(
        'SELECT monthly_limit_usd, warn_threshold_percent FROM ai_budget_settings WHERE id = 1'
      ).get();
      if (row !== undefined) {
        return {
          limitUsd:    row.monthly_limit_usd,          // null / 0 / 正数
          warnPercent: row.warn_threshold_percent ?? 80,
        };
      }
    } catch (_) { /* テーブル未作成時は無視 */ }
  }

  // 2. settings.json フォールバック
  try {
    const raw     = readFileSync(_SETTINGS_PATH, 'utf8');
    const settings = JSON.parse(raw);
    const budget  = settings.budget ?? {};
    if ('monthly_limit_usd' in budget) {
      return {
        limitUsd:    budget.monthly_limit_usd,
        warnPercent: budget.warn_threshold_percent ?? 80,
      };
    }
  } catch (_) { /* ファイル未存在・パースエラー時は無視 */ }

  // 3. デフォルト: 無制限
  return { limitUsd: null, warnPercent: 80 };
}

/**
 * 今月（ローカル時刻基準）の累計 estimated_cost を返す。
 * DB未接続の場合は 0 を返す（チェック無効化と同義）。
 *
 * @returns {number} USD
 */
function _getMonthlyAccumulated() {
  if (!_logDb) return 0;
  try {
    const row = _logDb.prepare(`
      SELECT COALESCE(SUM(estimated_cost), 0) AS total
      FROM ai_usage_log
      WHERE strftime('%Y-%m', timestamp) = strftime('%Y-%m', 'now', 'localtime')
    `).get();
    return row?.total ?? 0;
  } catch (_) { return 0; }
}

// ── 予算照会（外部公開） ──────────────────────────────────────────────────────

/**
 * 予算状態サマリーを返す（管理画面・APIレスポンス用）。
 *
 * @returns {{
 *   monthly_limit_usd: number|null,
 *   warn_threshold_percent: number,
 *   current_month: string,
 *   current_cost_usd: number,
 *   pending_usd: number,
 *   limit_jpy: number|null,
 *   current_cost_jpy: number,
 *   usage_percent: number|null,
 *   status: 'normal'|'warning'|'exceeded'|'disabled',
 *   breakdown: Array,
 *   history: Array,
 * }}
 */
export function getBudgetStatus() {
  const { limitUsd, warnPercent } = _loadBudgetConfig();
  const accumulated = _getMonthlyAccumulated();
  const JPY_RATE    = 150; // 参考円換算レート（固定）

  // 今月 domain/employee 別内訳
  let breakdown = [];
  let history   = [];
  if (_logDb) {
    try {
      breakdown = _logDb.prepare(`
        SELECT domain, COALESCE(employee, '-') AS employee,
               COUNT(*) AS calls,
               SUM(estimated_cost) AS cost_usd
        FROM ai_usage_log
        WHERE strftime('%Y-%m', timestamp) = strftime('%Y-%m', 'now', 'localtime')
        GROUP BY domain, employee
        ORDER BY cost_usd DESC
      `).all();
    } catch (_) { breakdown = []; }

    try {
      history = _logDb.prepare(`
        SELECT strftime('%Y-%m', timestamp) AS month,
               SUM(estimated_cost)          AS cost_usd,
               COUNT(*)                     AS calls
        FROM ai_usage_log
        GROUP BY month
        ORDER BY month DESC
        LIMIT 6
      `).all();
    } catch (_) { history = []; }
  }

  const currentMonth = new Date().toISOString().slice(0, 7);
  const projected    = accumulated + _pendingUsd;

  let status;
  if (limitUsd === 0) {
    status = 'disabled';
  } else if (limitUsd !== null && projected >= limitUsd) {
    status = 'exceeded';
  } else if (limitUsd !== null && projected >= limitUsd * (warnPercent / 100)) {
    status = 'warning';
  } else {
    status = 'normal';
  }

  const usagePercent = limitUsd !== null && limitUsd > 0
    ? Math.min(999, (projected / limitUsd) * 100)
    : null;

  return {
    monthly_limit_usd:      limitUsd,
    warn_threshold_percent: warnPercent,
    current_month:          currentMonth,
    current_cost_usd:       accumulated,
    pending_usd:            _pendingUsd,
    limit_jpy:              limitUsd !== null ? Math.round(limitUsd * JPY_RATE) : null,
    current_cost_jpy:       Math.round(accumulated * JPY_RATE),
    usage_percent:          usagePercent !== null ? Math.round(usagePercent * 10) / 10 : null,
    status,
    note_jpy_rate:          `参考値（1USD=${JPY_RATE}円換算）`,
    breakdown,
    history,
  };
}

/**
 * 予算設定を更新する（管理画面から呼ぶ）。
 * settings.json と ai_budget_settings DB の両方を更新する。
 *
 * @param {{ monthly_limit_usd: number|null, warn_threshold_percent?: number }} opts
 * @throws {Error} 入力値不正の場合
 */
export function updateBudgetConfig({ monthly_limit_usd, warn_threshold_percent }) {
  // バリデーション
  if (monthly_limit_usd !== null && monthly_limit_usd !== undefined) {
    if (typeof monthly_limit_usd !== 'number' || !isFinite(monthly_limit_usd) || monthly_limit_usd < 0) {
      throw new Error('monthly_limit_usd は null または 0以上の数値で指定してください');
    }
  }
  const newLimit = monthly_limit_usd ?? null;

  const warnPct = warn_threshold_percent ?? 80;
  if (typeof warnPct !== 'number' || warnPct < 1 || warnPct > 99) {
    throw new Error('warn_threshold_percent は 1〜99 の整数で指定してください');
  }

  // DB更新
  if (_logDb) {
    try {
      const now = new Date().toISOString().slice(0, 19).replace('T', ' ');
      _logDb.prepare(`
        INSERT INTO ai_budget_settings (id, monthly_limit_usd, warn_threshold_percent, updated_at)
        VALUES (1, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          monthly_limit_usd      = excluded.monthly_limit_usd,
          warn_threshold_percent = excluded.warn_threshold_percent,
          updated_at             = excluded.updated_at
      `).run(newLimit, Math.round(warnPct), now);
    } catch (e) {
      throw new Error(`DB更新失敗: ${e.message}`);
    }
  }

  // settings.json 同期更新
  try {
    const raw      = readFileSync(_SETTINGS_PATH, 'utf8');
    const settings = JSON.parse(raw);
    settings.budget = settings.budget ?? {};
    settings.budget.monthly_limit_usd      = newLimit;
    settings.budget.warn_threshold_percent = Math.round(warnPct);
    writeFileSync(_SETTINGS_PATH, JSON.stringify(settings, null, 2) + '\n', 'utf8');
  } catch (_) {
    // settings.json の更新失敗は致命的でない（DBが正とするため）
    console.warn('[claude_router] settings.json 同期更新スキップ');
  }
}

// ── メイン呼び出し関数 ────────────────────────────────────────────────────

/**
 * @param {string} systemPrompt
 * @param {string|Array} userMessage  文字列またはメッセージ配列（チャット履歴込み）
 * @param {object} opts
 * @param {'CHEAP'|'DEFAULT'|'STRONG'} opts.tier
 * @param {number}  opts.maxTokens
 * @param {string}  opts.task        ログ用タスク名
 * @param {string}  opts.domain      'publishing'|'snowflakes'|'business'|'system'
 * @param {string}  [opts.employee]  社員ID（Scout / Writer など）
 * @param {number}  [opts.projectId]
 * @returns {Promise<string>}
 * @throws {BudgetDisabledError}  monthly_limit_usd = 0 の場合
 * @throws {BudgetExceededError}  月次予算上限超過の場合
 */
export async function callClaude(systemPrompt, userMessage, {
  tier      = 'DEFAULT',
  maxTokens = 4096,
  task      = 'unknown',
  domain    = 'publishing',
  employee  = null,
  projectId = null,
} = {}) {
  // ── 予算チェック（APIキーチェックより先に行う） ─────────────────────────────
  // 予算停止は業務エラーと区別できるよう、API呼び出しを行う前に必ず確認する
  const { limitUsd, warnPercent } = _loadBudgetConfig();

  if (limitUsd === 0) {
    // 意図的な禁止設定（0 = AI呼び出し禁止）
    throw new BudgetDisabledError();
  }

  let reservation = 0;
  if (limitUsd !== null) {
    // プロンプト長からコスト予約を算出
    const msgStr      = Array.isArray(userMessage) ? JSON.stringify(userMessage) : String(userMessage);
    const promptLen   = systemPrompt.length + msgStr.length;
    reservation       = _calcReservation(tier, maxTokens, promptLen);

    const accumulated = _getMonthlyAccumulated();
    const projected   = accumulated + _pendingUsd + reservation;

    // 累計 + 予約済み + 新規予約 が上限を超える場合は実行しない
    if (projected > limitUsd) {
      throw new BudgetExceededError(accumulated + _pendingUsd + reservation, limitUsd);
    }

    // 警告ライン
    if (projected >= limitUsd * (warnPercent / 100)) {
      console.warn(
        `[budget] 警告: 月次予算 ${warnPercent}% ライン到達 ` +
        `($${(accumulated + _pendingUsd).toFixed(4)} + 予約 $${reservation.toFixed(4)} / $${limitUsd.toFixed(2)})`
      );
    }

    // 予約を追加（try/finally で必ず解除）
    _pendingUsd += reservation;
  }

  // ── APIキーチェック（予算チェック通過後に確認） ──────────────────────────────
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    // 予約済みのコストを解除してから例外
    if (reservation > 0) _pendingUsd = Math.max(0, _pendingUsd - reservation);
    throw new Error('ANTHROPIC_API_KEY が設定されていません');
  }

  // ── API呼び出し ───────────────────────────────────────────────────────────
  const model = getModel(tier);

  const messages = Array.isArray(userMessage)
    ? userMessage
    : [{ role: 'user', content: userMessage }];

  const body = JSON.stringify({ model, max_tokens: maxTokens, system: systemPrompt, messages });

  let data;
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key':         apiKey,
        'anthropic-version': '2023-06-01',
        'content-type':      'application/json',
      },
      body,
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Claude API エラー ${response.status}: ${err.slice(0, 300)}`);
    }

    data = await response.json();
  } finally {
    // 予約を解除（API失敗時も必ず解除）
    if (reservation > 0) {
      _pendingUsd = Math.max(0, _pendingUsd - reservation);
    }
  }

  // ── コスト記録 ────────────────────────────────────────────────────────────
  const usage             = data.usage ?? {};
  const inputTokens       = usage.input_tokens                    ?? 0;
  const outputTokens      = usage.output_tokens                   ?? 0;
  const cacheReadTokens   = usage.cache_read_input_tokens         ?? 0;
  const cacheCreateTokens = usage.cache_creation_input_tokens     ?? 0;
  const cost = estimateCost(model, inputTokens, outputTokens, cacheReadTokens);

  logUsage({ domain, employee, task, model, tier, inputTokens, outputTokens,
             cacheReadTokens, cacheCreateTokens, cost, projectId });

  // Extended Thinking モデルは content 配列に thinking/text ブロックが混在する
  const textBlock = data.content?.find(b => b.type === 'text');
  return textBlock?.text ?? '';
}
