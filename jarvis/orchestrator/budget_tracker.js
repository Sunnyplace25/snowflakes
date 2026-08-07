/**
 * jarvis/orchestrator/budget_tracker.js
 * OpenAI API利用回数・token usage・推定料金管理（外部通信なし）
 *
 * 料金テーブルはこのモジュール内に固定しない。
 * モデル名・現在のOpenAI価格も固定しない。
 */

// ─── 初期状態ファクトリ ───────────────────────────────────────────────────────

/**
 * 新しいバジェット状態オブジェクトを生成する。
 *
 * @returns {object}
 */
export function createBudgetState() {
  return {
    openai_calls:          0,
    input_tokens:          0,
    output_tokens:         0,
    cached_input_tokens:   0,
    estimated_cost_usd:    null,
    _pricing:              null,   // 内部保持（外部向け summary では除外）
  };
}

// ─── 料金設定 ─────────────────────────────────────────────────────────────────

/**
 * 料金テーブルをバジェット状態に設定する。
 * 料金テーブルはモジュール外から渡す形にしてモジュール内へ固定しない。
 *
 * @param {object} state - createBudgetState() で生成した状態オブジェクト
 * @param {object} pricing
 * @param {number}       pricing.input_per_1m          - 入力token 1M あたりUSD
 * @param {number}       pricing.output_per_1m         - 出力token 1M あたりUSD
 * @param {number|null}  [pricing.cached_input_per_1m] - キャッシュ済み入力token 1M あたりUSD
 * @returns {object} 更新された状態オブジェクト（同一参照）
 */
export function setPricing(state, pricing) {
  if (!state || typeof state !== 'object') {
    throw new Error('INVALID_STATE: state must be a budget state object');
  }
  if (!pricing || typeof pricing !== 'object') {
    throw new Error('INVALID_PRICING: pricing must be an object');
  }
  if (typeof pricing.input_per_1m !== 'number' || !isFinite(pricing.input_per_1m) || pricing.input_per_1m < 0) {
    throw new Error('INVALID_PRICING: input_per_1m must be a non-negative finite number');
  }
  if (typeof pricing.output_per_1m !== 'number' || !isFinite(pricing.output_per_1m) || pricing.output_per_1m < 0) {
    throw new Error('INVALID_PRICING: output_per_1m must be a non-negative finite number');
  }
  if (pricing.cached_input_per_1m !== undefined && pricing.cached_input_per_1m !== null) {
    if (typeof pricing.cached_input_per_1m !== 'number' || !isFinite(pricing.cached_input_per_1m) || pricing.cached_input_per_1m < 0) {
      throw new Error('INVALID_PRICING: cached_input_per_1m must be a non-negative finite number or null');
    }
  }

  state._pricing = {
    input_per_1m:         pricing.input_per_1m,
    output_per_1m:        pricing.output_per_1m,
    cached_input_per_1m:  pricing.cached_input_per_1m ?? null,
  };

  // 既存累計値で推定料金を再計算
  state.estimated_cost_usd = _calcCost(state);

  return state;
}

// ─── 料金計算（内部） ─────────────────────────────────────────────────────────

/**
 * 現在の token 累計から推定料金（USD）を計算する。
 * 浮動小数誤差を抑えるため整数演算 + 最後に割り算する方式を採用。
 *
 * @param {object} state
 * @returns {number|null}
 */
function _calcCost(state) {
  const p = state._pricing;
  if (!p) return null;

  // 整数マイクロUSD（10^-6 USD）で計算してから USD に戻す
  // 1M tokens = 1_000_000 tokens
  // cost_micro = tokens * price_per_1m / 1_000_000 * 1_000_000
  //            = tokens * price_per_1m
  // → 最終的に 1_000_000 で割る
  const SCALE = 1_000_000;

  // input（キャッシュ分を差し引いた通常入力）
  const normalInput = Math.max(0, state.input_tokens - state.cached_input_tokens);

  let costMicro = 0;
  costMicro += normalInput * p.input_per_1m;
  costMicro += state.output_tokens * p.output_per_1m;

  if (p.cached_input_per_1m !== null) {
    costMicro += state.cached_input_tokens * p.cached_input_per_1m;
  } else {
    // cached_input_per_1m 未設定時は通常 input 料金で計算
    costMicro += state.cached_input_tokens * p.input_per_1m;
  }

  // USD に変換し小数点以下8桁で丸める（表示用精度）
  const usd = costMicro / SCALE;
  return Math.round(usd * 1e8) / 1e8;
}

// ─── token 値の検証 ───────────────────────────────────────────────────────────

/**
 * @param {*} val
 * @param {string} name
 * @throws {Error}
 */
function assertTokenValue(val, name) {
  if (typeof val !== 'number') {
    throw new Error(`INVALID_USAGE: ${name} must be a number, got ${typeof val}`);
  }
  if (!isFinite(val)) {
    throw new Error(`INVALID_USAGE: ${name} must be finite, got ${val}`);
  }
  if (isNaN(val)) {
    throw new Error(`INVALID_USAGE: ${name} must not be NaN`);
  }
  if (val < 0) {
    throw new Error(`INVALID_USAGE: ${name} must be non-negative, got ${val}`);
  }
}

// ─── 利用記録 ─────────────────────────────────────────────────────────────────

/**
 * 1回分のAPI利用を記録する。
 * APIレスポンスの未知フィールドは保存しない。
 * 想定入力フィールド: input_tokens, output_tokens, cached_input_tokens
 *
 * @param {object} state
 * @param {object} usage
 * @param {number} [usage.input_tokens=0]
 * @param {number} [usage.output_tokens=0]
 * @param {number} [usage.cached_input_tokens=0]
 * @returns {object} 更新された状態オブジェクト（同一参照）
 */
export function recordUsage(state, usage) {
  if (!state || typeof state !== 'object') {
    throw new Error('INVALID_STATE: state must be a budget state object');
  }
  if (!usage || typeof usage !== 'object') {
    throw new Error('INVALID_USAGE: usage must be an object');
  }

  // 既知フィールドのみ受け付け（未知フィールドは無視）
  const inputTokens  = usage.input_tokens          ?? 0;
  const outputTokens = usage.output_tokens         ?? 0;
  const cachedTokens = usage.cached_input_tokens   ?? 0;

  assertTokenValue(inputTokens,  'input_tokens');
  assertTokenValue(outputTokens, 'output_tokens');
  assertTokenValue(cachedTokens, 'cached_input_tokens');

  state.openai_calls        += 1;
  state.input_tokens        += inputTokens;
  state.output_tokens       += outputTokens;
  state.cached_input_tokens += cachedTokens;

  // 料金テーブルがあれば再計算
  state.estimated_cost_usd = _calcCost(state);

  return state;
}

// ─── OpenAI 呼び出し可否判定 ──────────────────────────────────────────────────

/**
 * 次の OpenAI API 呼び出しが可能かどうかを判定する。
 *
 * @param {object} state
 * @param {object} opts
 * @param {number} [opts.max_openai_calls] - 最大呼び出し回数
 * @param {number|null} [opts.max_cost_usd] - USD 上限（null なら無制限）
 * @returns {{ allowed: boolean, reason: string }}
 */
export function canCallOpenAI(state, { max_openai_calls = null, max_cost_usd = null } = {}) {
  if (!state || typeof state !== 'object') {
    return { allowed: false, reason: 'invalid state' };
  }

  if (max_openai_calls !== null) {
    if (state.openai_calls >= max_openai_calls) {
      return {
        allowed: false,
        reason: `openai_calls ${state.openai_calls} reached max_openai_calls ${max_openai_calls}`,
      };
    }
  }

  // USD 上限は料金テーブルが設定されている場合のみ有効
  if (max_cost_usd !== null && state.estimated_cost_usd !== null) {
    if (state.estimated_cost_usd >= max_cost_usd) {
      return {
        allowed: false,
        reason: `estimated_cost_usd ${state.estimated_cost_usd} reached max_cost_usd ${max_cost_usd}`,
      };
    }
  }

  return { allowed: true, reason: 'within budget' };
}

// ─── バジェットサマリー ───────────────────────────────────────────────────────

/**
 * 外部向けサマリーを返す（_pricing などの内部フィールドを除外）。
 *
 * @param {object} state
 * @returns {object}
 */
export function getBudgetSummary(state) {
  if (!state || typeof state !== 'object') {
    throw new Error('INVALID_STATE: state must be a budget state object');
  }
  return {
    openai_calls:         state.openai_calls,
    input_tokens:         state.input_tokens,
    output_tokens:        state.output_tokens,
    cached_input_tokens:  state.cached_input_tokens,
    estimated_cost_usd:   state.estimated_cost_usd,
  };
}
