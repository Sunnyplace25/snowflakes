/**
 * jarvis/tests/test_recovery.js
 * Safe REVISING Recovery テスト
 *
 * T1: 通常のREVISING → recoverRevising → IMPLEMENTING 遷移
 * T2: REVISING中に停止したシミュレーション → 復旧成功
 * T3: 復旧後に再度 recoverRevising を呼ぶ → WRONG_STATE エラー（二重実行防止）
 * T4: revising_recovery_count が正しくインクリメントされる
 * T5: 遷移先が IMPLEMENTING のみであること（COMPLETED等へ遷移しない）
 * T6: confirmed_by_human が 'human' でない場合はエラー
 * T7: taskId が不正な場合はエラー
 * T8: 存在しないtaskIdの場合はエラー
 * T9: reason_code TESTS_FAILED の場合の復旧・original_reason_code 保存
 * T10: resolveReviewApproval 経由（revise）でREVISINGになった場合の復旧
 * T11: last_revising_recovery フィールドが正しく記録される
 * T12: review_result が未設定の場合も安全（original_reason_code: null）
 * T13: finalizeRevisingRecovery - recovery_reason が空の場合エラー
 * T14: finalizeRevisingRecovery - REVISING以外の状態にはエラー
 * T15: 既存フロー: finalizeReview の REVISING 遷移は変更なし
 * T16: 既存フロー: resolveReviewApproval の revise 遷移は変更なし
 * T17: history に IMPLEMENTING エントリが追加される
 * T18: confirmed_by_human に 'human' 以外の文字列 → エラー
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'crypto';

import {
  createTask,
  loadTask,
  updateStatus,
  finalizePlanning,
  finalizeTesting,
  finalizeReview,
  finalizeReviewApproval,
  finalizeRevisingRecovery,
  deleteTask,
} from '../orchestrator/task_manager.js';

import {
  recoverRevising,
  RECOVERY_MANAGER_ERRORS,
} from '../orchestrator/recovery_manager.js';

// ─── クリーンアップ用レジストリ ───────────────────────────────────────────────
const createdTaskIds = [];

// ─── テスト用ヘルパー ─────────────────────────────────────────────────────────
// REVISING状態のタスクを作成する（TESTS_FAILED 経路）
function buildRevisingTaskViaReview({ reason_code = 'TESTS_FAILED' } = {}) {
  const task = createTask({ phase: 'recovery-test' });
  const taskId = task.taskId;
  createdTaskIds.push(taskId);

  updateStatus(taskId, 'PLANNING');
  finalizePlanning(taskId, {
    plan: {
      requires_human_approval: false,
      warnings: [],
      actions: [{ type: 'run_test', test_id: 'test_alpha' }],
    },
    nextStatus: 'IMPLEMENTING',
    planningAttemptCount: 1,
  });
  updateStatus(taskId, 'TESTING');
  finalizeTesting(taskId, {
    test_results: [{ test_id: 'test_alpha', passed: false, exit_code: 1 }],
    test_phase_note: null,
    nextStatus: 'REVIEWING',
  });
  finalizeReview(taskId, {
    review_result: {
      decision: 'REVISE',
      reason_code,
      failed_test_count: 1,
      passed_test_count: 0,
      warning_count: 0,
      review_iteration_count: 1,
      reviewed_at: new Date().toISOString(),
    },
    next_status: 'REVISING',
    new_iteration_count: 1,
  });

  return taskId;
}

// REVISING状態のタスクを作成する（WAITING_FOR_APPROVAL → revise 経路）
function buildRevisingTaskViaApproval() {
  const task = createTask({ phase: 'recovery-test-approval' });
  const taskId = task.taskId;
  createdTaskIds.push(taskId);

  updateStatus(taskId, 'PLANNING');
  finalizePlanning(taskId, {
    plan: { requires_human_approval: false, warnings: [], actions: [] },
    nextStatus: 'IMPLEMENTING',
    planningAttemptCount: 1,
  });
  updateStatus(taskId, 'TESTING');
  finalizeTesting(taskId, {
    test_results: [],
    test_phase_note: 'no_run_test_actions',
    nextStatus: 'REVIEWING',
  });

  const reviewId = randomUUID();
  finalizeReview(taskId, {
    review_result: {
      decision: 'WAIT_FOR_APPROVAL',
      reason_code: 'READY_FOR_COMPLETION_APPROVAL',
      failed_test_count: 0,
      passed_test_count: 0,
      warning_count: 0,
      review_iteration_count: 1,
      reviewed_at: new Date().toISOString(),
    },
    next_status: 'WAITING_FOR_APPROVAL',
    new_iteration_count: 1,
    pending_approval: {
      stage: 'review',
      review_id: reviewId,
      reason_code: 'READY_FOR_COMPLETION_APPROVAL',
      requested_at: new Date().toISOString(),
    },
  });
  finalizeReviewApproval(taskId, {
    approval_result: {
      decision: 'revise',
      approved_at: new Date().toISOString(),
      source: 'human',
      review_id: reviewId,
    },
    next_status: 'REVISING',
  });

  return taskId;
}

// review_result なしで直接 REVISING に持ち込む（updateStatus 経由）
function buildRawRevisingTask() {
  const task = createTask({ phase: 'recovery-test-raw' });
  const taskId = task.taskId;
  createdTaskIds.push(taskId);
  updateStatus(taskId, 'PLANNING');
  updateStatus(taskId, 'IMPLEMENTING');
  updateStatus(taskId, 'TESTING');
  updateStatus(taskId, 'REVIEWING');
  updateStatus(taskId, 'REVISING');
  return taskId;
}

// ─── テスト ─────────────────────────────────────────────────────────────────

test('T1: 通常のREVISING → recoverRevising → IMPLEMENTING', () => {
  const taskId = buildRevisingTaskViaReview();
  assert.equal(loadTask(taskId).status, 'REVISING');

  const result = recoverRevising({ taskId, confirmed_by_human: 'human' });

  assert.equal(result.ok, true, 'ok must be true');
  assert.equal(result.task_id, taskId);
  assert.equal(result.state, 'IMPLEMENTING');
  assert.equal(loadTask(taskId).status, 'IMPLEMENTING');
});

test('T2: REVISING停止シミュレーション → recoverRevising で復旧', () => {
  const taskId = buildRevisingTaskViaReview();
  // 「停止」= REVISINGのまま何もしない。その後 recoverRevising で復旧
  const result = recoverRevising({ taskId, confirmed_by_human: 'human' });
  assert.equal(result.ok, true);
  assert.equal(result.state, 'IMPLEMENTING');
  assert.equal(loadTask(taskId).status, 'IMPLEMENTING');
});

test('T3: 復旧後の再実行 → WRONG_STATE エラー（二重実行防止）', () => {
  const taskId = buildRevisingTaskViaReview();
  recoverRevising({ taskId, confirmed_by_human: 'human' }); // 1回目
  const result = recoverRevising({ taskId, confirmed_by_human: 'human' }); // 2回目

  assert.equal(result.ok, false);
  assert.equal(result.error.code, RECOVERY_MANAGER_ERRORS.WRONG_STATE);
  assert.equal(result.state, 'IMPLEMENTING');
  // タスクは IMPLEMENTING のまま
  assert.equal(loadTask(taskId).status, 'IMPLEMENTING');
});

test('T4: revising_recovery_count が正しくインクリメントされる', () => {
  const taskId = buildRevisingTaskViaReview();
  recoverRevising({ taskId, confirmed_by_human: 'human' });

  const after = loadTask(taskId);
  assert.equal(after.revising_recovery_count, 1);
  assert.ok(after.last_revising_recovery, 'last_revising_recovery must exist');
  assert.equal(after.last_revising_recovery.recovery_count, 1);
});

test('T5: IMPLEMENTING 以外（COMPLETED等）へ遷移しない', () => {
  const taskId = buildRevisingTaskViaReview();
  recoverRevising({ taskId, confirmed_by_human: 'human' });

  const after = loadTask(taskId);
  assert.equal(after.status, 'IMPLEMENTING');
  assert.notEqual(after.status, 'COMPLETED');
  assert.notEqual(after.status, 'WAITING_FOR_APPROVAL');
  assert.notEqual(after.status, 'APPROVED');
});

test('T6: confirmed_by_human が "human" でない → INVALID_CONFIRMATION', () => {
  const taskId = buildRevisingTaskViaReview();

  for (const val of [undefined, null, 'yes', '']) {
    const result = recoverRevising({ taskId, confirmed_by_human: val });
    assert.equal(result.ok, false, `should fail for ${JSON.stringify(val)}`);
    assert.equal(result.error.code, RECOVERY_MANAGER_ERRORS.INVALID_CONFIRMATION,
      `wrong code for ${JSON.stringify(val)}`);
  }
  // タスクはまだ REVISING
  assert.equal(loadTask(taskId).status, 'REVISING');
});

test('T7: taskId が不正 → INVALID_ARGUMENT', () => {
  const r1 = recoverRevising({ taskId: null, confirmed_by_human: 'human' });
  assert.equal(r1.ok, false);
  assert.equal(r1.error.code, RECOVERY_MANAGER_ERRORS.INVALID_ARGUMENT);

  const r2 = recoverRevising({ taskId: '', confirmed_by_human: 'human' });
  assert.equal(r2.ok, false);
  assert.equal(r2.error.code, RECOVERY_MANAGER_ERRORS.INVALID_ARGUMENT);

  const r3 = recoverRevising({ confirmed_by_human: 'human' });
  assert.equal(r3.ok, false);
  assert.equal(r3.error.code, RECOVERY_MANAGER_ERRORS.INVALID_ARGUMENT);
});

test('T8: 存在しないtaskId → TASK_NOT_FOUND', () => {
  const result = recoverRevising({
    taskId: 'task_20260101_ffffff',
    confirmed_by_human: 'human',
  });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, RECOVERY_MANAGER_ERRORS.TASK_NOT_FOUND);
});

test('T9: reason_code TESTS_FAILED → original_reason_code が保存される', () => {
  const taskId = buildRevisingTaskViaReview({ reason_code: 'TESTS_FAILED' });
  const result = recoverRevising({ taskId, confirmed_by_human: 'human' });

  assert.equal(result.ok, true);
  assert.equal(result.original_reason_code, 'TESTS_FAILED');

  const after = loadTask(taskId);
  assert.equal(after.last_revising_recovery.original_review_reason_code, 'TESTS_FAILED');
});

test('T10: WAITING_FOR_APPROVAL → revise → REVISING → recoverRevising', () => {
  const taskId = buildRevisingTaskViaApproval();
  assert.equal(loadTask(taskId).status, 'REVISING');

  const result = recoverRevising({ taskId, confirmed_by_human: 'human' });
  assert.equal(result.ok, true);
  assert.equal(result.state, 'IMPLEMENTING');
  assert.equal(loadTask(taskId).status, 'IMPLEMENTING');
});

test('T11: last_revising_recovery の構造が正しい', () => {
  const taskId = buildRevisingTaskViaReview();
  recoverRevising({ taskId, confirmed_by_human: 'human' });

  const r = loadTask(taskId).last_revising_recovery;
  assert.ok(r, 'last_revising_recovery must exist');
  assert.ok(typeof r.recovered_at === 'string', 'recovered_at must be string');
  assert.equal(r.recovery_reason, 'manual_recovery');
  assert.equal(r.recovery_count, 1);
  assert.ok('original_review_reason_code' in r, 'original_review_reason_code must be present');
});

test('T12: review_result 未設定でも original_reason_code は null で安全', () => {
  const taskId = buildRawRevisingTask();
  assert.equal(loadTask(taskId).review_result, undefined);

  const result = recoverRevising({ taskId, confirmed_by_human: 'human' });
  assert.equal(result.ok, true);
  assert.equal(result.original_reason_code, null);

  const after = loadTask(taskId);
  assert.equal(after.last_revising_recovery.original_review_reason_code, null);
});

test('T13: finalizeRevisingRecovery - recovery_reason が空 → エラー', () => {
  const taskId = buildRevisingTaskViaReview();
  assert.throws(
    () => finalizeRevisingRecovery(taskId, { recovery_reason: '' }),
    /INVALID_RECOVERY_REASON/
  );
  assert.equal(loadTask(taskId).status, 'REVISING');
});

test('T14: finalizeRevisingRecovery - REVISING以外の状態 → エラー', () => {
  const task = createTask({ phase: 'recovery-test-state' });
  const taskId = task.taskId;
  createdTaskIds.push(taskId);
  // CREATED のまま
  assert.throws(
    () => finalizeRevisingRecovery(taskId, { recovery_reason: 'test' }),
    /INVALID_STATE/
  );
});

test('T15: 既存フロー - finalizeReview の REVISING 遷移は変更なし', () => {
  const task = createTask({ phase: 'existing-flow-review' });
  const taskId = task.taskId;
  createdTaskIds.push(taskId);

  updateStatus(taskId, 'PLANNING');
  finalizePlanning(taskId, {
    plan: {
      requires_human_approval: false,
      warnings: [],
      actions: [{ type: 'run_test', test_id: 'test_beta' }],
    },
    nextStatus: 'IMPLEMENTING',
    planningAttemptCount: 1,
  });
  updateStatus(taskId, 'TESTING');
  finalizeTesting(taskId, {
    test_results: [{ test_id: 'test_beta', passed: false, exit_code: 1 }],
    test_phase_note: null,
    nextStatus: 'REVIEWING',
  });

  const finalized = finalizeReview(taskId, {
    review_result: {
      decision: 'REVISE',
      reason_code: 'TESTS_FAILED',
      failed_test_count: 1,
      passed_test_count: 0,
      warning_count: 0,
      review_iteration_count: 1,
      reviewed_at: new Date().toISOString(),
    },
    next_status: 'REVISING',
    new_iteration_count: 1,
  });

  assert.equal(finalized.status, 'REVISING');
  assert.equal(finalized.review_result.reason_code, 'TESTS_FAILED');
  assert.equal(finalized.review_iteration_count, 1);
});

test('T16: 既存フロー - resolveReviewApproval の revise 遷移は変更なし', () => {
  const task = createTask({ phase: 'existing-flow-approval' });
  const taskId = task.taskId;
  createdTaskIds.push(taskId);

  updateStatus(taskId, 'PLANNING');
  finalizePlanning(taskId, {
    plan: { requires_human_approval: false, warnings: [], actions: [] },
    nextStatus: 'IMPLEMENTING',
    planningAttemptCount: 1,
  });
  updateStatus(taskId, 'TESTING');
  finalizeTesting(taskId, {
    test_results: [],
    test_phase_note: 'no_run_test_actions',
    nextStatus: 'REVIEWING',
  });

  const reviewId = randomUUID();
  finalizeReview(taskId, {
    review_result: {
      decision: 'WAIT_FOR_APPROVAL',
      reason_code: 'READY_FOR_COMPLETION_APPROVAL',
      failed_test_count: 0,
      passed_test_count: 0,
      warning_count: 0,
      review_iteration_count: 1,
      reviewed_at: new Date().toISOString(),
    },
    next_status: 'WAITING_FOR_APPROVAL',
    new_iteration_count: 1,
    pending_approval: {
      stage: 'review',
      review_id: reviewId,
      reason_code: 'READY_FOR_COMPLETION_APPROVAL',
      requested_at: new Date().toISOString(),
    },
  });

  const result = finalizeReviewApproval(taskId, {
    approval_result: {
      decision: 'revise',
      approved_at: new Date().toISOString(),
      source: 'human',
      review_id: reviewId,
    },
    next_status: 'REVISING',
  });

  assert.equal(result.status, 'REVISING');
  assert.equal(result.approval_result.decision, 'revise');
  assert.equal(result.pending_approval, null);
});

test('T17: 復旧後 history に IMPLEMENTING エントリが追加される', () => {
  const taskId = buildRevisingTaskViaReview();
  recoverRevising({ taskId, confirmed_by_human: 'human' });

  const after = loadTask(taskId);
  const last = after.history[after.history.length - 1];
  assert.equal(last.status, 'IMPLEMENTING');
  assert.ok(typeof last.at === 'string', 'at must be ISO string');
});

test('T18: confirmed_by_human に "human" 以外の文字列 → INVALID_CONFIRMATION', () => {
  const taskId = buildRevisingTaskViaReview();

  for (const val of ['Human', 'HUMAN', ' human', 'human ', 'robot']) {
    const result = recoverRevising({ taskId, confirmed_by_human: val });
    assert.equal(result.ok, false, `should fail for "${val}"`);
    assert.equal(result.error.code, RECOVERY_MANAGER_ERRORS.INVALID_CONFIRMATION,
      `wrong code for "${val}"`);
  }
  assert.equal(loadTask(taskId).status, 'REVISING');
});

// ─── クリーンアップ ────────────────────────────────────────────────────────────
process.on('exit', () => {
  for (const taskId of createdTaskIds) {
    try { deleteTask(taskId); } catch { /* ignore */ }
  }
});
