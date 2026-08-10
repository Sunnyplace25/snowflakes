/**
 * jarvis/orchestrator/review_manager.js
 * C9: レビュー管理（外部通信なし・git操作なし・spawn禁止）
 */

import { randomUUID } from 'crypto';
import { loadTask, finalizeReview, finalizeReviewApproval } from './task_manager.js';
import { logEvent } from './logger.js';

// ─── 定数 ─────────────────────────────────────────────────────────────────────
const MAX_REVIEW_ITERATIONS = 3;
const MAX_REVIEW_HISTORY    = 20;

const ALLOWED_APPROVAL_DECISIONS = Object.freeze(['approve', 'revise']);

// ─── エラーコード ─────────────────────────────────────────────────────────────
export const REVIEW_MANAGER_ERRORS = Object.freeze({
  INVALID_ARGUMENT:              'REVIEW_INVALID_ARGUMENT',
  TASK_NOT_FOUND:                'REVIEW_TASK_NOT_FOUND',
  WRONG_STATE:                   'REVIEW_WRONG_STATE',
  DATA_INVALID:                  'REVIEW_DATA_INVALID',
  ITERATIONS_EXCEEDED:           'REVIEW_ITERATIONS_EXCEEDED',
  APPROVAL_WRONG_STATE:          'REVIEW_APPROVAL_WRONG_STATE',
  APPROVAL_CONTEXT_MISMATCH:     'REVIEW_APPROVAL_CONTEXT_MISMATCH',
  APPROVAL_INVALID_DECISION:     'REVIEW_APPROVAL_INVALID_DECISION',
  APPROVAL_INVALID_CONFIRMATION: 'REVIEW_APPROVAL_INVALID_CONFIRMATION',
  INTERNAL_ERROR:                'REVIEW_INTERNAL_ERROR',
});

// ─── reason_code 一覧 ─────────────────────────────────────────────────────────
export const REVIEW_REASON_CODES = Object.freeze({
  TESTS_FAILED:                      'TESTS_FAILED',
  NO_TESTS_RUN:                      'NO_TESTS_RUN',
  PLAN_REQUIRES_APPROVAL:            'PLAN_REQUIRES_APPROVAL',
  WARNINGS_PRESENT:                  'WARNINGS_PRESENT',
  READY_FOR_COMPLETION_APPROVAL:     'READY_FOR_COMPLETION_APPROVAL',
  MAX_REVIEW_ITERATIONS_EXCEEDED:    'MAX_REVIEW_ITERATIONS_EXCEEDED',
});

// ─── P0: taskデータ整合性チェック ─────────────────────────────────────────────
export function _validateReviewData(task) {
  // task.plan 存在確認
  if (!task.plan || typeof task.plan !== 'object') {
    return { ok: false, reason: 'task.plan is missing or not an object' };
  }
  // plan.requires_human_approval は boolean
  if (typeof task.plan.requires_human_approval !== 'boolean') {
    return { ok: false, reason: 'plan.requires_human_approval must be a boolean' };
  }
  // plan.warnings は配列
  if (!Array.isArray(task.plan.warnings)) {
    return { ok: false, reason: 'plan.warnings must be an array' };
  }
  // plan.warnings 各要素は string
  for (const w of task.plan.warnings) {
    if (typeof w !== 'string') {
      return { ok: false, reason: 'each warning must be a string' };
    }
  }
  // plan.actions は配列
  if (!Array.isArray(task.plan.actions)) {
    return { ok: false, reason: 'plan.actions must be an array' };
  }
  // test_results は配列（undefinedはBLOCK）
  if (!Array.isArray(task.test_results)) {
    return { ok: false, reason: 'task.test_results must be an array' };
  }
  // test_results 各要素の型チェック
  for (const r of task.test_results) {
    if (!r || typeof r !== 'object') {
      return { ok: false, reason: 'each test_result must be an object' };
    }
    if (typeof r.passed !== 'boolean') {
      return { ok: false, reason: 'test_result.passed must be a boolean' };
    }
    if (typeof r.test_id !== 'string') {
      return { ok: false, reason: 'test_result.test_id must be a string' };
    }
    if (typeof r.exit_code !== 'number') {
      return { ok: false, reason: 'test_result.exit_code must be a number' };
    }
  }
  return { ok: true };
}

// ─── run_test/test_results 整合性チェック ────────────────────────────────────
export function _validateRunTestConsistency(task) {
  const runTestActions = (task.plan.actions || []).filter(a => a && a.type === 'run_test');
  const runTestCount = runTestActions.length;
  const testResultCount = task.test_results.length;
  const note = task.test_phase_note;

  // run_test 0件のケース
  if (runTestCount === 0) {
    if (testResultCount === 0 && note === 'no_run_test_actions') {
      // 正常なno-test: OK
      return { ok: true, is_no_test: true };
    }
    if (testResultCount === 0 && note === null) {
      // test_results=[], note=null はDATA_INVALID
      return { ok: false, reason: 'test_results is empty and test_phase_note is null without run_test actions — ambiguous state' };
    }
    if (testResultCount > 0) {
      // run_testなしなのにtest_resultsがある
      return { ok: false, reason: 'test_results exist but no run_test actions in plan' };
    }
    // noteが"no_run_test_actions"以外
    if (note !== 'no_run_test_actions') {
      return { ok: false, reason: `test_phase_note is "${note}" but expected "no_run_test_actions" when run_test count is 0` };
    }
    return { ok: true, is_no_test: true };
  }

  // run_test 1件以上のケース
  if (note === 'no_run_test_actions') {
    // run_testあるのにnote="no_run_test_actions"
    return { ok: false, reason: 'test_phase_note is "no_run_test_actions" but run_test actions exist in plan' };
  }
  if (testResultCount !== runTestCount) {
    return { ok: false, reason: `test_results count (${testResultCount}) does not match run_test action count (${runTestCount})` };
  }
  // test_id対応チェック
  const planTestIds = runTestActions.map(a => a.test_id);
  const resultTestIds = task.test_results.map(r => r.test_id);
  // 重複チェック（結果側）
  const seenIds = new Set();
  for (const id of resultTestIds) {
    if (seenIds.has(id)) {
      return { ok: false, reason: `duplicate test_id in test_results: "${id}"` };
    }
    seenIds.add(id);
  }
  // plan側test_idと結果側test_idの対応（全一致確認）
  const planIdSet = new Set(planTestIds);
  const resultIdSet = new Set(resultTestIds);
  for (const id of planIdSet) {
    if (!resultIdSet.has(id)) {
      return { ok: false, reason: `test_id "${id}" in plan has no corresponding test_result` };
    }
  }
  for (const id of resultIdSet) {
    if (!planIdSet.has(id)) {
      return { ok: false, reason: `test_result has test_id "${id}" not found in plan run_test actions` };
    }
  }

  return { ok: true, is_no_test: false };
}

// ─── _evaluateReview（純粋関数・判定ロジック）────────────────────────────────
export function _evaluateReview(task) {
  // P1: iteration上限
  const currentCount = task.review_iteration_count ?? 0;
  if (currentCount >= MAX_REVIEW_ITERATIONS) {
    return {
      decision: 'WAIT_FOR_APPROVAL',
      reason_code: REVIEW_REASON_CODES.MAX_REVIEW_ITERATIONS_EXCEEDED,
      nextStatus: 'WAITING_FOR_APPROVAL',
    };
  }

  const passedCount = task.test_results.filter(r => r.passed === true).length;
  const failedCount = task.test_results.filter(r => r.passed === false).length;
  const warningCount = task.plan.warnings.length;

  // P2: テストFAIL
  if (failedCount > 0) {
    return {
      decision: 'REVISE',
      reason_code: REVIEW_REASON_CODES.TESTS_FAILED,
      nextStatus: 'REVISING',
      passed_test_count: passedCount,
      failed_test_count: failedCount,
      warning_count: warningCount,
    };
  }

  // P3: テスト未実施（test_resultsが0件かつno_run_test_actionsの場合）
  if (task.test_results.length === 0) {
    return {
      decision: 'WAIT_FOR_APPROVAL',
      reason_code: REVIEW_REASON_CODES.NO_TESTS_RUN,
      nextStatus: 'WAITING_FOR_APPROVAL',
      passed_test_count: 0,
      failed_test_count: 0,
      warning_count: warningCount,
    };
  }

  // P4: plan.requires_human_approval
  if (task.plan.requires_human_approval === true) {
    return {
      decision: 'WAIT_FOR_APPROVAL',
      reason_code: REVIEW_REASON_CODES.PLAN_REQUIRES_APPROVAL,
      nextStatus: 'WAITING_FOR_APPROVAL',
      passed_test_count: passedCount,
      failed_test_count: 0,
      warning_count: warningCount,
    };
  }

  // P5: warnings
  if (warningCount > 0) {
    return {
      decision: 'WAIT_FOR_APPROVAL',
      reason_code: REVIEW_REASON_CODES.WARNINGS_PRESENT,
      nextStatus: 'WAITING_FOR_APPROVAL',
      passed_test_count: passedCount,
      failed_test_count: 0,
      warning_count: warningCount,
    };
  }

  // P6: 全条件クリア → WAIT_FOR_APPROVAL（REVIEWING→COMPLETED直接遷移は存在しない）
  return {
    decision: 'WAIT_FOR_APPROVAL',
    reason_code: REVIEW_REASON_CODES.READY_FOR_COMPLETION_APPROVAL,
    nextStatus: 'WAITING_FOR_APPROVAL',
    passed_test_count: passedCount,
    failed_test_count: 0,
    warning_count: warningCount,
    recommended_outcome: 'COMPLETE',
  };
}

// ─── reviewTask（メイン公開API）──────────────────────────────────────────────
export async function reviewTask(opts = {}) {
  const {
    taskId,
    dry_run = true,
  } = opts ?? {};

  // Step 1: 引数検証
  if (!taskId || typeof taskId !== 'string') {
    return { ok: false, task_id: null, state: null,
             error: { code: REVIEW_MANAGER_ERRORS.INVALID_ARGUMENT, message: 'taskId is required' } };
  }

  // Step 2: task読み込み
  let task;
  try {
    task = loadTask(taskId);
  } catch (e) {
    return { ok: false, task_id: taskId, state: null,
             error: { code: REVIEW_MANAGER_ERRORS.TASK_NOT_FOUND, message: e.message } };
  }

  // Step 3: status確認
  if (task.status !== 'REVIEWING') {
    return { ok: false, task_id: taskId, state: task.status,
             error: { code: REVIEW_MANAGER_ERRORS.WRONG_STATE,
                      message: `task status must be REVIEWING, got "${task.status}"` } };
  }

  // Step 4: P0チェック（データ整合性）
  const dataCheck = _validateReviewData(task);
  if (!dataCheck.ok) {
    return { ok: false, task_id: taskId, state: 'REVIEWING',
             error: { code: REVIEW_MANAGER_ERRORS.DATA_INVALID, message: dataCheck.reason } };
  }

  // Step 5: run_test/test_results整合性
  const consistencyCheck = _validateRunTestConsistency(task);
  if (!consistencyCheck.ok) {
    return { ok: false, task_id: taskId, state: 'REVIEWING',
             error: { code: REVIEW_MANAGER_ERRORS.DATA_INVALID, message: consistencyCheck.reason } };
  }

  // Step 6: 判定
  const evaluation = _evaluateReview(task);

  const currentCount = task.review_iteration_count ?? 0;
  // iterationカウント: ITERATIONS_EXCEEDED時はインクリメントしない
  const isIterationExceeded = evaluation.reason_code === REVIEW_REASON_CODES.MAX_REVIEW_ITERATIONS_EXCEEDED;
  const newIterationCount = isIterationExceeded ? currentCount : currentCount + 1;

  const metrics = {
    passed_test_count:      evaluation.passed_test_count ?? 0,
    failed_test_count:      evaluation.failed_test_count ?? 0,
    warning_count:          evaluation.warning_count ?? 0,
    review_iteration_count: newIterationCount,
  };

  // Step 7: dry_run
  if (dry_run) {
    return {
      ok: true,
      dry_run: true,
      task_id: taskId,
      state: 'REVIEWING',
      decision: evaluation.decision,
      reason_code: evaluation.reason_code,
      ...(evaluation.recommended_outcome ? { recommended_outcome: evaluation.recommended_outcome } : {}),
      metrics,
    };
  }

  // Step 8: 本実行
  const now = new Date().toISOString();
  const reviewResult = {
    decision:                evaluation.decision,
    reason_code:             evaluation.reason_code,
    failed_test_count:       metrics.failed_test_count,
    passed_test_count:       metrics.passed_test_count,
    warning_count:           metrics.warning_count,
    review_iteration_count:  newIterationCount,
    reviewed_at:             now,
  };

  // pending_approval（WAITING_FOR_APPROVALへ進む場合）
  let pendingApproval = null;
  if (evaluation.nextStatus === 'WAITING_FOR_APPROVAL') {
    pendingApproval = {
      stage:        'review',
      review_id:    randomUUID(),
      reason_code:  evaluation.reason_code,
      requested_at: now,
    };
  }

  try {
    finalizeReview(taskId, {
      review_result:       reviewResult,
      next_status:         evaluation.nextStatus,
      new_iteration_count: newIterationCount,
      pending_approval:    pendingApproval,
      ...(evaluation.recommended_outcome ? { recommended_outcome: evaluation.recommended_outcome } : {}),
    });
  } catch (e) {
    return { ok: false, task_id: taskId, state: 'REVIEWING',
             error: { code: REVIEW_MANAGER_ERRORS.INTERNAL_ERROR, message: e.message } };
  }

  logEvent({
    taskId,
    event:                  'review_complete',
    status:                 evaluation.nextStatus,
    review_decision:        evaluation.decision,
    reason_code:            evaluation.reason_code,
    test_passed_count:      metrics.passed_test_count,
    test_failed_count:      metrics.failed_test_count,
    warning_count:          metrics.warning_count,
    review_iteration_count: newIterationCount,
    approval_required:      evaluation.nextStatus === 'WAITING_FOR_APPROVAL',
    dry_run:                false,
  });

  return {
    ok: true,
    dry_run: false,
    task_id: taskId,
    decision: evaluation.decision,
    reason_code: evaluation.reason_code,
    state: evaluation.nextStatus,
    ...(evaluation.recommended_outcome ? { recommended_outcome: evaluation.recommended_outcome } : {}),
    metrics,
  };
}

// ─── resolveReviewApproval（人間承認API）─────────────────────────────────────
/**
 * resolveReviewApproval
 *
 * confirmed_by_human: "human" 固定文字列は認証ではなく、
 * 「明示的な人間操作として呼ばれたことを示すintent marker」のみ。
 * 本人認証・権限管理を保証する仕組みではない。
 * C9自身がこの値を自動生成して呼び出すことは禁止。
 */
export function resolveReviewApproval(opts = {}) {
  const {
    taskId,
    review_id,
    decision,
    confirmed_by_human,
  } = opts ?? {};

  // Step 1: 引数検証
  if (!taskId || typeof taskId !== 'string') {
    return { ok: false, task_id: null, state: null,
             error: { code: REVIEW_MANAGER_ERRORS.INVALID_ARGUMENT, message: 'taskId is required' } };
  }
  if (!review_id || typeof review_id !== 'string') {
    return { ok: false, task_id: taskId, state: null,
             error: { code: REVIEW_MANAGER_ERRORS.INVALID_ARGUMENT, message: 'review_id is required' } };
  }
  // confirmed_by_humanは "human" 固定文字列のみ
  if (confirmed_by_human !== 'human') {
    return { ok: false, task_id: taskId, state: null,
             error: { code: REVIEW_MANAGER_ERRORS.APPROVAL_INVALID_CONFIRMATION,
                      message: 'confirmed_by_human must be the string "human"' } };
  }
  // decision は enum
  if (!ALLOWED_APPROVAL_DECISIONS.includes(decision)) {
    return { ok: false, task_id: taskId, state: null,
             error: { code: REVIEW_MANAGER_ERRORS.APPROVAL_INVALID_DECISION,
                      message: `decision must be one of: ${ALLOWED_APPROVAL_DECISIONS.join(', ')}` } };
  }

  // Step 2: task読み込み
  let task;
  try {
    task = loadTask(taskId);
  } catch (e) {
    return { ok: false, task_id: taskId, state: null,
             error: { code: REVIEW_MANAGER_ERRORS.TASK_NOT_FOUND, message: e.message } };
  }

  // Step 3: status確認
  if (task.status !== 'WAITING_FOR_APPROVAL') {
    return { ok: false, task_id: taskId, state: task.status,
             error: { code: REVIEW_MANAGER_ERRORS.APPROVAL_WRONG_STATE,
                      message: `task status must be WAITING_FOR_APPROVAL, got "${task.status}"` } };
  }

  // Step 4: pending_approval存在確認（C6 Planning承認との分離）
  const pa = task.pending_approval;
  if (!pa || typeof pa !== 'object') {
    return { ok: false, task_id: taskId, state: 'WAITING_FOR_APPROVAL',
             error: { code: REVIEW_MANAGER_ERRORS.APPROVAL_CONTEXT_MISMATCH,
                      message: 'task has no pending_approval context' } };
  }
  // stage === "review" 確認
  if (pa.stage !== 'review') {
    return { ok: false, task_id: taskId, state: 'WAITING_FOR_APPROVAL',
             error: { code: REVIEW_MANAGER_ERRORS.APPROVAL_CONTEXT_MISMATCH,
                      message: `pending_approval.stage is "${pa.stage}", expected "review"` } };
  }
  // review_id一致確認
  if (pa.review_id !== review_id) {
    return { ok: false, task_id: taskId, state: 'WAITING_FOR_APPROVAL',
             error: { code: REVIEW_MANAGER_ERRORS.APPROVAL_CONTEXT_MISMATCH,
                      message: 'review_id does not match pending_approval.review_id' } };
  }

  // Step 5: 遷移先決定
  const nextStatus = decision === 'approve' ? 'COMPLETED' : 'REVISING';

  // Step 6: approval_result
  const now = new Date().toISOString();
  const approvalResult = {
    decision,
    approved_at: now,
    source:      'human',
    review_id:   review_id,
  };

  try {
    finalizeReviewApproval(taskId, {
      approval_result: approvalResult,
      next_status:     nextStatus,
    });
  } catch (e) {
    return { ok: false, task_id: taskId, state: 'WAITING_FOR_APPROVAL',
             error: { code: REVIEW_MANAGER_ERRORS.INTERNAL_ERROR, message: e.message } };
  }

  logEvent({
    taskId,
    event:             'review_approval_resolved',
    status:            nextStatus,
    review_decision:   decision,
    approval_decision: decision,
    dry_run:           false,
  });

  return {
    ok: true,
    task_id: taskId,
    decision,
    state: nextStatus,
  };
}
