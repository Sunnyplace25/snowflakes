/**
 * jarvis/orchestrator/task_runner.js
 * Top-level task runner — タスク状態から適切な処理へルーティングする
 *
 * 責務:
 *   - task状態を読んで次に実行すべき既存モジュールへルーティングする
 *   - 人間承認が必要な状態で必ず停止する
 *   - REVISING/WAITING_FOR_APPROVALを勝手に解決しない
 *
 * 制約:
 *   - 各phaseの業務ロジックを直接持たない（既存モジュールへ委譲）
 *   - git操作・外部通信を直接行わない
 *   - 承認フローを迂回しない
 */

import { createTask, loadTask, listTasks } from './task_manager.js';
import { runPlanningTask }                  from './orchestrator.js';
import { executeFilePlan }                  from './file_executor.js';
import { runTestPhase }                     from './test_runner.js';
import { reviewTask }                       from './review_manager.js';
import { createBudgetState }                from './budget_tracker.js';
import { REPO_ROOT }                        from './safety_guard.js';

// ─── 定数 ─────────────────────────────────────────────────────────────────────

// これ以上進められない（人間が操作するまで待つ）状態
const STOP_STATES     = new Set(['WAITING_FOR_APPROVAL', 'REVISING', 'PAUSED', 'PLANNING']);
// 再開不可な終端状態
const TERMINAL_STATES = new Set(['COMPLETED', 'CANCELLED', 'FAILED']);
// runner が自律的に進められる状態
const RUNNABLE_STATES = new Set(['CREATED', 'IMPLEMENTING', 'TESTING', 'REVIEWING']);

// ─── 次の操作ガイダンス ────────────────────────────────────────────────────────
function _nextSteps(state, task) {
  switch (state) {
    case 'WAITING_FOR_APPROVAL': {
      const stage = task?.pending_approval?.stage;
      if (stage === 'planning') {
        const id = task.pending_approval.approval_id;
        return `resolvePlanningApproval({ taskId, approval_id: "${id}", decision: "approve"|"revise", confirmed_by_human: "human" })`;
      }
      if (stage === 'review') {
        const id = task.pending_approval.review_id;
        return `resolveReviewApproval({ taskId, review_id: "${id}", decision: "approve"|"revise", confirmed_by_human: "human" })`;
      }
      return '承認APIを呼び出してください';
    }
    case 'REVISING':
      return 'recoverRevising({ taskId, confirmed_by_human: "human" }) を呼び出してから resume を実行してください';
    case 'COMPLETED':   return 'このタスクは完了しています';
    case 'FAILED':      return 'タスクの状態を確認し、必要に応じて再試行してください';
    case 'CANCELLED':   return 'このタスクはキャンセルされています';
    case 'PAUSED':      return '手動でタスクを再開してから resume を実行してください';
    default:            return 'run_task resume <taskId> を実行してください';
  }
}

// ─── 単一フェーズ実行（既存モジュールへの委譲のみ）──────────────────────────
async function _runPhase(state, taskId, {
  gitSnapshot, repoRoot, model, budgetState, budgetLimits, dry_run, _inject,
}) {
  switch (state) {
    case 'CREATED':
      return runPlanningTask({
        taskId,
        gitSnapshot:   gitSnapshot   ?? {},
        repoRoot:      repoRoot      ?? REPO_ROOT,
        model:         model         ?? 'gpt-4o',
        budgetState:   budgetState,
        budgetLimits:  budgetLimits,
        _inject:       _inject       ?? {},
      });

    case 'IMPLEMENTING':
      return executeFilePlan({
        taskId,
        dry_run: dry_run ?? false,
        _inject: _inject ?? {},
      });

    case 'TESTING':
      return runTestPhase({
        taskId,
        dry_run: dry_run ?? false,
        _inject: _inject ?? {},
      });

    case 'REVIEWING':
      return reviewTask({
        taskId,
        dry_run: dry_run ?? false,
      });

    default:
      return {
        ok: false,
        error: { code: 'UNKNOWN_STATE', message: `Cannot route state: ${state}` },
      };
  }
}

// ─── タスク読み込みヘルパー（例外を返り値に変換）──────────────────────────────
function _safeLoad(taskId) {
  try { return { ok: true, task: loadTask(taskId) }; }
  catch (e) { return { ok: false, error: e.message }; }
}

// ─── runTask（メイン公開API）─────────────────────────────────────────────────
/**
 * runTask
 *
 * taskId が指定された場合は既存タスクを再開。
 * phase が指定された場合は新規タスクを作成してから開始。
 * 承認が必要な状態に到達したら停止する。
 * REVISING は停止して recoverRevising を要求する。
 *
 * @param {object} opts
 * @param {string}  [opts.taskId]       - 再開するタスクID（省略時は新規作成）
 * @param {string}  [opts.phase]        - 新規タスクのフェーズ名（taskId省略時に必須）
 * @param {string}  [opts.model]        - Planning用モデル名（デフォルト: 'gpt-4o'）
 * @param {object}  [opts.gitSnapshot]  - git状態スナップショット（省略時は空 {}）
 * @param {string}  [opts.repoRoot]     - リポジトリルートパス
 * @param {object}  [opts.budgetState]  - バジェット状態（省略時は自動生成）
 * @param {object}  [opts.budgetLimits] - バジェット上限（省略時はデフォルト）
 * @param {boolean} [opts.dry_run]      - true: 1フェーズプレビューのみ
 * @param {object}  [opts._inject]      - テスト用注入（callOpenAI等）
 * @returns {Promise<object>}
 */
export async function runTask(opts = {}) {
  const {
    taskId: givenTaskId,
    phase,
    model,
    gitSnapshot,
    repoRoot,
    budgetState:  givenBudgetState,
    budgetLimits: givenBudgetLimits,
    dry_run = false,
    _inject = {},
  } = opts ?? {};

  // デフォルトバジェット設定
  const budgetState  = givenBudgetState  ?? createBudgetState();
  const budgetLimits = givenBudgetLimits ?? { max_openai_calls: 10 };

  let taskId = givenTaskId;

  // ─── 新規タスク作成 ──────────────────────────────────────────────────────
  if (!taskId) {
    if (!phase || typeof phase !== 'string') {
      return {
        ok: false, task_id: null, initial_state: null, final_state: null,
        error: { code: 'INVALID_ARGUMENT', message: 'Either taskId or phase is required' },
      };
    }
    let newTask;
    try { newTask = createTask({ phase, model: model ?? null }); }
    catch (e) {
      return {
        ok: false, task_id: null, initial_state: null, final_state: null,
        error: { code: 'TASK_CREATE_FAILED', message: e.message },
      };
    }
    taskId = newTask.taskId;
  }

  // ─── タスク読み込み ──────────────────────────────────────────────────────
  const loaded = _safeLoad(taskId);
  if (!loaded.ok) {
    return {
      ok: false, task_id: taskId, initial_state: null, final_state: null,
      error: { code: 'TASK_NOT_FOUND', message: loaded.error },
    };
  }

  let task         = loaded.task;
  const initialState = task.status;
  let currentState   = initialState;

  // ─── 終端状態チェック ─────────────────────────────────────────────────────
  if (TERMINAL_STATES.has(currentState)) {
    return {
      ok: false,
      task_id: taskId,
      initial_state: currentState,
      final_state:   currentState,
      actions_taken: [],
      terminal: true,
      message:   `Task is in terminal state: ${currentState}`,
      next_steps: _nextSteps(currentState, task),
    };
  }

  // ─── 停止状態チェック ─────────────────────────────────────────────────────
  if (STOP_STATES.has(currentState)) {
    return {
      ok: false,
      task_id: taskId,
      initial_state: currentState,
      final_state:   currentState,
      actions_taken: [],
      requires_human_approval: currentState === 'WAITING_FOR_APPROVAL',
      requires_recovery:       currentState === 'REVISING',
      message:   `Stopped at: ${currentState}`,
      next_steps: _nextSteps(currentState, task),
      ...(currentState === 'WAITING_FOR_APPROVAL' ? { approval_context: task.pending_approval } : {}),
    };
  }

  // ─── dry_run: 1フェーズのみプレビュー実行（state変更なし）──────────────
  if (dry_run) {
    if (!RUNNABLE_STATES.has(currentState)) {
      return {
        ok: false, task_id: taskId, initial_state: currentState, final_state: currentState,
        actions_taken: [], dry_run: true, message: `State ${currentState} is not runnable`,
      };
    }
    let previewResult;
    try {
      previewResult = await _runPhase(currentState, taskId, {
        gitSnapshot, repoRoot, model, budgetState, budgetLimits,
        dry_run: true, _inject,
      });
    } catch (e) {
      previewResult = { ok: false, error: { code: 'UNEXPECTED_ERROR', message: e.message } };
    }
    const reloaded = _safeLoad(taskId);
    const afterState = reloaded.ok ? reloaded.task.status : currentState;
    return {
      ok: previewResult?.ok ?? false,
      task_id: taskId,
      initial_state: currentState,
      final_state: afterState,
      actions_taken: [currentState],
      dry_run: true,
      message: previewResult?.ok
        ? `dry_run: ${currentState} (no state changes)`
        : (previewResult?.error?.message ?? previewResult?.reason ?? 'phase failed'),
      next_steps: _nextSteps(afterState, reloaded.ok ? reloaded.task : task),
      ...(!(previewResult?.ok) ? { error: previewResult?.error } : {}),
    };
  }

  // ─── 本実行: 停止点まで自動チェーン ──────────────────────────────────────
  const actionsTaken = [];
  let lastResult = null;

  while (RUNNABLE_STATES.has(currentState)) {
    // フェーズ実行
    try {
      lastResult = await _runPhase(currentState, taskId, {
        gitSnapshot, repoRoot, model, budgetState, budgetLimits,
        dry_run: false, _inject,
      });
    } catch (e) {
      const reloaded = _safeLoad(taskId);
      return {
        ok: false,
        task_id: taskId,
        initial_state: initialState,
        final_state: reloaded.ok ? reloaded.task.status : currentState,
        actions_taken: actionsTaken,
        error: { code: 'UNEXPECTED_ERROR', message: e.message },
        message: `Exception during ${currentState}: ${e.message}`,
        next_steps: _nextSteps(reloaded.ok ? reloaded.task.status : currentState, reloaded.ok ? reloaded.task : task),
      };
    }

    actionsTaken.push(currentState);

    // フェーズ失敗
    if (!lastResult?.ok) {
      const reloaded = _safeLoad(taskId);
      return {
        ok: false,
        task_id: taskId,
        initial_state: initialState,
        final_state: reloaded.ok ? reloaded.task.status : currentState,
        actions_taken: actionsTaken,
        error: lastResult?.error ?? { code: 'PHASE_FAILED', message: lastResult?.reason ?? 'phase failed' },
        message: `Phase ${currentState} failed`,
        next_steps: _nextSteps(reloaded.ok ? reloaded.task.status : currentState, reloaded.ok ? reloaded.task : task),
      };
    }

    // タスク再読み込み → 次のstateを確認
    const reloaded = _safeLoad(taskId);
    if (!reloaded.ok) {
      return {
        ok: false, task_id: taskId, initial_state: initialState, final_state: currentState,
        actions_taken: actionsTaken,
        error: { code: 'TASK_LOAD_FAILED', message: 'Failed to reload task after phase' },
      };
    }
    task         = reloaded.task;
    currentState = task.status;
  }

  // ─── 停止点に到達 ────────────────────────────────────────────────────────
  const finalState       = currentState;
  const requiresApproval = finalState === 'WAITING_FOR_APPROVAL';
  const requiresRecovery = finalState === 'REVISING';

  return {
    ok: true,
    task_id: taskId,
    initial_state: initialState,
    final_state: finalState,
    actions_taken: actionsTaken,
    requires_human_approval: requiresApproval,
    requires_recovery:       requiresRecovery,
    ...(requiresApproval ? { approval_context: task.pending_approval } : {}),
    message:    `${initialState} → ${finalState}`,
    next_steps: _nextSteps(finalState, task),
  };
}

// ─── getTaskStatus（状態確認のみ・実行なし）──────────────────────────────────
/**
 * @param {string} taskId
 * @returns {object}
 */
export function getTaskStatus(taskId) {
  const loaded = _safeLoad(taskId);
  if (!loaded.ok) {
    return { ok: false, task_id: taskId, error: { code: 'TASK_NOT_FOUND', message: loaded.error } };
  }
  const task = loaded.task;
  return {
    ok: true,
    task_id: taskId,
    status: task.status,
    phase: task.phase,
    created_at: task.created_at,
    updated_at: task.updated_at,
    review_iteration_count:  task.review_iteration_count  ?? 0,
    revising_recovery_count: task.revising_recovery_count ?? 0,
    requires_human_approval: task.status === 'WAITING_FOR_APPROVAL',
    requires_recovery:       task.status === 'REVISING',
    ...(task.status === 'WAITING_FOR_APPROVAL' ? { approval_context: task.pending_approval } : {}),
    next_steps: _nextSteps(task.status, task),
  };
}

// ─── listAllTasks（一覧）────────────────────────────────────────────────────
/**
 * @returns {object[]}
 */
export function listAllTasks() {
  return listTasks().map(t => ({
    task_id:    t.taskId,
    phase:      t.phase,
    status:     t.status,
    created_at: t.created_at,
    updated_at: t.updated_at,
  }));
}
