/**
 * jarvis/orchestrator/orchestrator.js
 * オーケストレーター本体 — Planning フェーズ統括（C6）
 *
 * 責務: C1〜C5 モジュールを安全に接続し、1 タスクの Planning を完結させる。
 * 制約: ファイル編集・ファイル作成・ファイル削除・shell 実行・
 *       child_process・git 操作・外部通信（OpenAI 以外）を行わない。
 *       git 情報は呼び出し元から gitSnapshot として注入される。
 */

import {
  loadTask,
  updateStatus,
  finalizePlanning,
  TASK_ID_PATTERN,
} from './task_manager.js';

import { logEvent } from './logger.js';

import {
  RESULT,
  DEFAULT_LIMITS,
  validateTaskStart,
  validateDiffSize,
  isAllowedPath,
  isForbiddenPath,
  detectApprovalRequired,
  buildErrorSignature,
  detectErrorLoop,
} from './safety_guard.js';

import { canCallOpenAI, getBudgetSummary } from './budget_tracker.js';
import { buildContext }                     from './context_builder.js';
import { callOpenAI }                       from './openai_client.js';

// ─── Planning 指示テンプレート ─────────────────────────────────────────────────
// コンパイル時定数。ユーザーデータ・シークレットを含まない。
const PLANNING_INSTRUCTIONS = [
  'You are a careful software development planner for the Snow flakes JARVIS project.',
  'Given the task context, generate a structured implementation plan using the provided JSON schema.',
  'Only include file operations within the explicitly allowed scope.',
  'Set requires_human_approval=true for: file deletion, git operations,',
  'external API calls, authentication changes, publishing, or any sensitive operations.',
  'Be conservative: prefer smaller focused plans over broad changes.',
].join('\n');

// ─── 許可 action types ─────────────────────────────────────────────────────────
export const ALLOWED_ACTION_TYPES = Object.freeze(
  new Set(['edit_file', 'create_file', 'delete_file', 'read_file', 'run_test', 'no_op'])
);

// ─── エラーレスポンス生成ヘルパー ──────────────────────────────────────────────
function _err(taskId, state, errorCode, errorMessage, safety, budget) {
  return {
    ok:      false,
    task_id: taskId  ?? null,
    state:   state   ?? null,
    error:   { code: errorCode, message: errorMessage },
    safety:  safety  ?? {
      decision:          'BLOCK',
      approval_required: false,
      blocked_actions:   [],
      approval_actions:  [],
    },
    budget:  budget ?? null,
  };
}

// ─── 入力バリデーション ────────────────────────────────────────────────────────
/**
 * runPlanningTask のオプションを検証する。
 * @param {object} opts
 * @returns {{ ok: boolean, code?: string, message?: string }}
 */
export function validatePlanningOpts(opts) {
  if (!opts || typeof opts !== 'object' || Array.isArray(opts)) {
    return { ok: false, code: 'INVALID_ARGUMENT', message: 'opts must be an object' };
  }
  if (typeof opts.taskId !== 'string' || !TASK_ID_PATTERN.test(opts.taskId)) {
    return { ok: false, code: 'INVALID_ARGUMENT', message: 'taskId must match pattern task_YYYYMMDD_xxxxxx' };
  }
  if (!opts.gitSnapshot || typeof opts.gitSnapshot !== 'object' || Array.isArray(opts.gitSnapshot)) {
    return { ok: false, code: 'INVALID_ARGUMENT', message: 'gitSnapshot must be an object' };
  }
  if (typeof opts.repoRoot !== 'string' || opts.repoRoot.trim() === '') {
    return { ok: false, code: 'INVALID_ARGUMENT', message: 'repoRoot must be a non-empty string' };
  }
  if (typeof opts.model !== 'string' || opts.model.trim() === '') {
    return { ok: false, code: 'INVALID_ARGUMENT', message: 'model must be a non-empty string' };
  }
  return { ok: true };
}

// ─── 冪等性・状態確認 ─────────────────────────────────────────────────────────
/**
 * @param {object} task
 * @param {boolean} forceReplan
 * @returns {{ ok: boolean, code?: string, message?: string }}
 */
function checkIdempotency(task, forceReplan) {
  const s = task.status;

  // COMPLETED / CANCELLED は force_replan でも再開不可
  if (['COMPLETED', 'CANCELLED'].includes(s)) {
    return { ok: false, code: 'TASK_TERMINAL_STATE', message: `Task is in terminal state: ${s}` };
  }
  // FAILED: force_replan=true なら反復上限チェックのみ許可（iteration limitに委ねる）
  if (s === 'FAILED') {
    if (!forceReplan) {
      return { ok: false, code: 'TASK_TERMINAL_STATE', message: `Task is in terminal state: ${s}` };
    }
  }
  if (s === 'PLANNING') {
    return { ok: false, code: 'TASK_ALREADY_PLANNING', message: 'Task is already in PLANNING state' };
  }
  if (['IMPLEMENTING', 'WAITING_FOR_APPROVAL'].includes(s)) {
    if (!forceReplan) {
      return {
        ok: false,
        code: 'ALREADY_PLANNED',
        message: `Task is in ${s} state. Use force_replan=true to replan.`,
      };
    }
  }
  return { ok: true };
}

// ─── action 単体安全判定 ──────────────────────────────────────────────────────
/**
 * 単一 action の安全性を判定する。
 *
 * 優先順位:
 * 1. unknown type          → BLOCK
 * 2. no_op                 → description チェックのみ
 * 3. 空 path（no_op以外）  → BLOCK
 * 4. denylist / traversal / allowlist外 → BLOCK（isAllowedPath 内部で一括処理）
 * 5. delete_file            → APPROVAL
 * 6. description 承認パターン → APPROVAL
 * 7. それ以外               → ALLOW
 *
 * @param {object} action              - { type, path, description }
 * @param {{ allowed_files, allowed_dirs }} opts
 * @returns {{ safety: 'ALLOW'|'APPROVAL'|'BLOCK', reason: string }}
 */
export function classifyActionSafety(action, { allowed_files = null, allowed_dirs = null } = {}) {
  const { type, path, description } = action ?? {};
  const desc = typeof description === 'string' ? description : '';

  // 1. unknown type → BLOCK (fail-closed)
  if (!ALLOWED_ACTION_TYPES.has(type)) {
    return { safety: 'BLOCK', reason: `unknown action type: "${type}"` };
  }

  // 2. no_op: path 検証をスキップ（空 path も許容）
  if (type === 'no_op') {
    const descCheck = detectApprovalRequired(desc);
    if (descCheck.result === RESULT.HUMAN_APPROVAL_REQUIRED) {
      return { safety: 'APPROVAL', reason: descCheck.reason };
    }
    return { safety: 'ALLOW', reason: 'no_op action' };
  }

  // 3. 空 path は BLOCK（no_op 以外）
  if (!path || typeof path !== 'string' || path.trim() === '') {
    return { safety: 'BLOCK', reason: `path is required for action type "${type}"` };
  }

  // 4. isAllowedPath: denylist / traversal / repo外 / allowlist 外 → BLOCK
  const pathCheck = isAllowedPath(path, { allowed_files, allowed_dirs });
  if (pathCheck.result === RESULT.BLOCK) {
    return { safety: 'BLOCK', reason: pathCheck.reason };
  }

  // 5. delete_file → 常に承認必須
  if (type === 'delete_file') {
    return { safety: 'APPROVAL', reason: 'delete_file requires human approval' };
  }

  // 6. description の承認パターンチェック
  const descCheck = detectApprovalRequired(desc);
  if (descCheck.result === RESULT.HUMAN_APPROVAL_REQUIRED) {
    return { safety: 'APPROVAL', reason: descCheck.reason };
  }

  return { safety: 'ALLOW', reason: 'action safe for planning' };
}

// ─── actions 一括安全検証 ─────────────────────────────────────────────────────
/**
 * @param {object[]} actions
 * @param {{ allowed_files, allowed_dirs }} opts
 * @returns {{ result: 'ALLOW'|'APPROVAL'|'BLOCK', reason: string, blocked: string[], approval_needed: string[] }}
 */
export function validateActions(actions, { allowed_files = null, allowed_dirs = null } = {}) {
  if (!Array.isArray(actions)) {
    return { result: 'BLOCK', reason: 'actions is not an array', blocked: ['actions is not an array'], approval_needed: [] };
  }

  const blocked       = [];
  const approvalNeeded = [];

  for (const action of actions) {
    const r     = classifyActionSafety(action, { allowed_files, allowed_dirs });
    const label = `${action?.type ?? '?'}:${action?.path ?? ''}`;

    if (r.safety === 'BLOCK') {
      blocked.push(`${label}: ${r.reason}`);
    } else if (r.safety === 'APPROVAL') {
      approvalNeeded.push(`${label}: ${r.reason}`);
    }
  }

  if (blocked.length > 0) {
    return { result: 'BLOCK',    reason: 'blocked actions detected',  blocked, approval_needed: approvalNeeded };
  }
  if (approvalNeeded.length > 0) {
    return { result: 'APPROVAL', reason: 'human approval required',   blocked: [], approval_needed: approvalNeeded };
  }
  return { result: 'ALLOW',     reason: 'all actions safe',           blocked: [], approval_needed: [] };
}

// ─── メイン公開 API ───────────────────────────────────────────────────────────
/**
 * 1 タスクの Planning フェーズを実行する。
 *
 * @param {object}   opts
 * @param {string}   opts.taskId                      - task_YYYYMMDD_xxxxxx
 * @param {object}   opts.gitSnapshot                 - { tracked_modified_files, untracked_files,
 *                                                        diff_stat?, diffs?, recent_commits? }
 * @param {string}   opts.repoRoot                    - リポジトリルート絶対パス
 * @param {string}   opts.model                       - 使用モデル
 * @param {object}   opts.budgetState                 - budget_tracker state（必須）
 * @param {object}   [opts.budgetLimits]              - { max_openai_calls（必須）, max_cost_usd? }
 * @param {string[]} [opts.target_files]
 * @param {string[]} [opts.allowed_files]
 * @param {string[]} [opts.allowed_dirs]
 * @param {string[]} [opts.protected_existing_changes]
 * @param {object}   [opts.limits]                    - iteration/diff 上限
 * @param {boolean}  [opts.force_replan]              - IMPLEMENTING/WAITING_FOR_APPROVAL から再計画
 * @param {string|null} [opts.previous_error_signature] - エラーループ検出用（案B: 既にhash済み）
 * @param {object}   [opts._inject]                   - テスト用注入（本番では使用しない）
 *
 * @returns {Promise<object>}
 */
export async function runPlanningTask(opts = {}) {

  // ── Step 1: 入力バリデーション ──────────────────────────────────────────────
  const vResult = validatePlanningOpts(opts);
  if (!vResult.ok) {
    return _err(opts.taskId ?? null, null, vResult.code, vResult.message, null, null);
  }

  const {
    taskId,
    gitSnapshot,
    repoRoot,
    model,
    budgetState         = null,
    budgetLimits        = {},
    target_files        = [],
    allowed_files       = null,
    allowed_dirs        = null,
    protected_existing_changes = [],
    limits              = {},
    force_replan        = false,
    previous_error_signature = null,
    _inject             = {},
  } = opts;

  // テスト注入ポイント（本番では未使用）
  const _buildContext  = _inject.buildContext  ?? buildContext;
  const _callOpenAI    = _inject.callOpenAI    ?? callOpenAI;

  const effectiveLimits = { ...DEFAULT_LIMITS, ...limits };

  // ── Step 2: task 読み込み ─────────────────────────────────────────────────
  let task;
  try {
    task = loadTask(taskId);
  } catch (e) {
    return _err(taskId, null, 'TASK_NOT_FOUND', e.message, null, null);
  }

  // ── Step 3: 冪等性・状態確認 ──────────────────────────────────────────────
  const idempotency = checkIdempotency(task, force_replan);
  if (!idempotency.ok) {
    return _err(
      taskId, task.status,
      idempotency.code, idempotency.message,
      null,
      budgetState ? getBudgetSummary(budgetState) : null
    );
  }

  // ── Step 4: エラーループ検出 ───────────────────────────────────────────────
  // previous_error_signature は呼び出し元が buildErrorSignature() で生成済みの値（案B）
  const storedSig = task.last_error_signature ?? null;
  if (previous_error_signature !== null && storedSig !== null) {
    const loopCheck = detectErrorLoop(previous_error_signature, storedSig);
    if (loopCheck.result === RESULT.BLOCK) {
      return _err(
        taskId, task.status,
        'ERROR_LOOP_DETECTED', loopCheck.reason,
        null,
        budgetState ? getBudgetSummary(budgetState) : null
      );
    }
  }

  // ── Step 5: iteration 上限チェック ────────────────────────────────────────
  const currentAttempts = task.planning_attempt_count ?? 0;
  const maxIter = effectiveLimits.max_iterations ?? DEFAULT_LIMITS.max_iterations;
  // 今回の attempt を含めて上限判定（currentAttempts >= maxIter なら今回で上限超過）
  if (currentAttempts >= maxIter) {
    return _err(
      taskId, task.status,
      'ITERATION_LIMIT_EXCEEDED',
      `planning_attempt_count ${currentAttempts} reached max_iterations ${maxIter}`,
      null,
      budgetState ? getBudgetSummary(budgetState) : null
    );
  }

  // ── Step 6: budget config 必須チェック ────────────────────────────────────
  if (budgetState === null || budgetState === undefined) {
    return _err(
      taskId, task.status,
      'ORCHESTRATOR_BUDGET_CONFIG_MISSING', 'budgetState is required',
      null, null
    );
  }
  if (
    !budgetLimits ||
    budgetLimits.max_openai_calls === undefined ||
    budgetLimits.max_openai_calls === null
  ) {
    return _err(
      taskId, task.status,
      'ORCHESTRATOR_BUDGET_CONFIG_MISSING', 'budgetLimits.max_openai_calls is required',
      null, getBudgetSummary(budgetState)
    );
  }

  // ── Step 7: 初期 budget チェック ──────────────────────────────────────────
  const budgetCheck = canCallOpenAI(budgetState, budgetLimits);
  if (!budgetCheck.allowed) {
    return _err(
      taskId, task.status,
      'OPENAI_BUDGET_BLOCKED', `Budget limit exceeded: ${budgetCheck.reason}`,
      null, getBudgetSummary(budgetState)
    );
  }

  // ── Step 8: validateTaskStart() ───────────────────────────────────────────
  const startCheck = validateTaskStart({
    trackedModifiedFiles:      gitSnapshot.tracked_modified_files ?? [],
    protected_existing_changes,
    untrackedFiles:             gitSnapshot.untracked_files       ?? [],
  });
  if (startCheck.result !== RESULT.ALLOW) {
    return _err(
      taskId, task.status,
      'DIRTY_TREE', startCheck.reason,
      null, getBudgetSummary(budgetState)
    );
  }

  // ── Step 9: validateDiffSize() ─────────────────────────────────────────────
  let diffApprovalRequired = false;
  if (gitSnapshot.diff_stat) {
    const diffCheck = validateDiffSize(gitSnapshot.diff_stat, effectiveLimits);
    if (diffCheck.result === RESULT.BLOCK) {
      return _err(
        taskId, task.status,
        'DIFF_TOO_LARGE', diffCheck.reason,
        null, getBudgetSummary(budgetState)
      );
    }
    if (diffCheck.result === RESULT.HUMAN_APPROVAL_REQUIRED) {
      diffApprovalRequired = true;
    }
  }

  // ── Step 10: context 生成 ──────────────────────────────────────────────────
  let context;
  try {
    context = _buildContext({
      task,
      gitSnapshot,
      repoRoot,
      target_files,
      allowed_files,
      allowed_dirs,
      protected_existing_changes,
      limits: effectiveLimits,
    });
  } catch (e) {
    return _err(
      taskId, task.status,
      'CONTEXT_BUILD_FAILED', e.message,
      null, getBudgetSummary(budgetState)
    );
  }

  // ── Step 11: task → PLANNING 遷移 ─────────────────────────────────────────
  const newAttemptCount = currentAttempts + 1;
  try {
    updateStatus(taskId, 'PLANNING');
  } catch (e) {
    return _err(
      taskId, task.status,
      'STATE_TRANSITION_FAILED', e.message,
      null, getBudgetSummary(budgetState)
    );
  }

  // ── Step 12: OpenAI Planning 呼び出し ─────────────────────────────────────
  // C5 (callOpenAI) が budgetState.openai_calls および token usage を内部で更新する。
  // C6 から recordUsage() を呼ばない（二重計上防止）。
  const input = JSON.stringify(context);

  const apiResult = await _callOpenAI({
    model,
    instructions: PLANNING_INSTRUCTIONS,
    input,
    budgetState,
    budgetLimits,
    use_structured_output: true,
  });

  if (!apiResult.ok) {
    // error.code のみから signature を生成（prompt/context/response 本文は使用しない）
    const errorSig = buildErrorSignature(apiResult.error_code);
    try {
      finalizePlanning(taskId, {
        plan:                 null,
        nextStatus:           'FAILED',
        planningAttemptCount: newAttemptCount,
        lastErrorSignature:   errorSig,
      });
    } catch { /* finalizePlanning 失敗は無視してオリジナルエラーを返す */ }

    logEvent({
      taskId,
      event:      'planning_failed',
      status:     'FAILED',
      error_type: apiResult.error_code,
      openai_calls: getBudgetSummary(budgetState).openai_calls,
      request_id:   apiResult.x_request_id ?? null,
    });

    return {
      ok:      false,
      task_id: taskId,
      state:   'FAILED',
      error:   { code: apiResult.error_code, message: apiResult.error_message },
      safety:  { decision: 'ALLOW', approval_required: false, blocked_actions: [], approval_actions: [] },
      budget:  getBudgetSummary(budgetState),
    };
  }

  // ── Step 13: action 安全検証 ───────────────────────────────────────────────
  const parsed      = apiResult.parsed_output;
  const actionsCheck = validateActions(parsed.actions, { allowed_files, allowed_dirs });

  if (actionsCheck.result === 'BLOCK') {
    const errorSig = buildErrorSignature('ACTION_SAFETY_BLOCK');
    try {
      finalizePlanning(taskId, {
        plan:                 null,
        nextStatus:           'FAILED',
        planningAttemptCount: newAttemptCount,
        lastErrorSignature:   errorSig,
      });
    } catch {}

    logEvent({
      taskId,
      event:       'planning_blocked',
      status:      'FAILED',
      decision:    RESULT.BLOCK,
      error_type:  'ACTION_SAFETY_BLOCK',
      openai_calls: getBudgetSummary(budgetState).openai_calls,
    });

    return {
      ok:      false,
      task_id: taskId,
      state:   'FAILED',
      error:   { code: 'ACTION_SAFETY_BLOCK', message: actionsCheck.reason },
      safety:  {
        decision:          'BLOCK',
        approval_required: false,
        blocked_actions:   actionsCheck.blocked,
        approval_actions:  actionsCheck.approval_needed,
      },
      budget: getBudgetSummary(budgetState),
    };
  }

  // ── Step 14: 最終承認判定 ──────────────────────────────────────────────────
  // AI の requires_human_approval より ローカル判定を優先（ローカルが true → 必ず true）
  const finalApprovalRequired =
    parsed.requires_human_approval        // AI 判定
    || actionsCheck.result === 'APPROVAL' // ローカル action 判定
    || diffApprovalRequired;              // diff サイズ判定

  const nextStatus = finalApprovalRequired ? 'WAITING_FOR_APPROVAL' : 'IMPLEMENTING';

  // ── Step 15: plan 保存 + 最終 status 更新（原子的）────────────────────────
  // context / prompt / raw response / API key は保存しない
  const plan = {
    summary:                 parsed.summary,
    actions:                 parsed.actions,
    requires_human_approval: finalApprovalRequired,
    warnings:                parsed.warnings ?? [],
    request_id:              apiResult.x_request_id ?? null,
    planned_at:              new Date().toISOString(),
  };

  try {
    finalizePlanning(taskId, {
      plan,
      nextStatus,
      planningAttemptCount: newAttemptCount,
      lastErrorSignature:   null,
    });
  } catch (e) {
    return _err(
      taskId, 'PLANNING',
      'FINALIZE_PLANNING_FAILED', e.message,
      null, getBudgetSummary(budgetState)
    );
  }

  // ── Step 16: ログ記録 ──────────────────────────────────────────────────────
  // plan 本文・context 本文・API key はログしない
  logEvent({
    taskId,
    event:             'planning_complete',
    status:            nextStatus,
    decision:          finalApprovalRequired ? RESULT.HUMAN_APPROVAL_REQUIRED : RESULT.ALLOW,
    openai_calls:      getBudgetSummary(budgetState).openai_calls,
    estimated_cost_usd: getBudgetSummary(budgetState).estimated_cost_usd,
    action_count:      parsed.actions.length,
    warning_count:     (parsed.warnings ?? []).length,
    approval_required: finalApprovalRequired,
    request_id:        apiResult.x_request_id ?? null,
  });

  return {
    ok:      true,
    task_id: taskId,
    state:   nextStatus,
    plan,
    safety: {
      decision:          finalApprovalRequired ? RESULT.HUMAN_APPROVAL_REQUIRED : RESULT.ALLOW,
      approval_required: finalApprovalRequired,
      blocked_actions:   [],
      approval_actions:  actionsCheck.approval_needed,
    },
    budget: getBudgetSummary(budgetState),
  };
}
