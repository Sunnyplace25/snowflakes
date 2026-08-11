/**
 * jarvis/tests/test_task_runner.js
 * Top-level Task Runner テスト
 *
 * T1:  taskId・phase 両方未指定 → INVALID_ARGUMENT エラー
 * T2:  存在しないtaskId → TASK_NOT_FOUND エラー
 * T3:  TERMINAL状態（COMPLETED）→ terminal:true で即返却
 * T4:  STOP状態（WAITING_FOR_APPROVAL）→ requires_human_approval:true で即返却
 * T5:  STOP状態（REVISING）→ requires_recovery:true で即返却
 * T6:  新規タスク作成（phase指定）→ _inject.callOpenAI でモック → WAITING_FOR_APPROVAL で停止
 * T7:  dry_run=true（IMPLEMENTING状態）→ 1フェーズのみ・状態変化なし
 * T8:  IMPLEMENTING状態から → TESTING→REVIEWING→WAITING_FOR_APPROVAL まで自動チェーン
 * T9:  getTaskStatus 正常系
 * T10: listAllTasks に作成したタスクが含まれる
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  createTask,
  loadTask,
  updateStatus,
  finalizePlanning,
  finalizeTesting,
  finalizeReview,
  deleteTask,
} from '../orchestrator/task_manager.js';

import {
  runTask,
  getTaskStatus,
  listAllTasks,
} from '../orchestrator/task_runner.js';

// ─── クリーンアップ用レジストリ ───────────────────────────────────────────────
const createdTaskIds = [];

process.on('exit', () => {
  for (const id of createdTaskIds) {
    try { deleteTask(id); } catch {}
  }
});

// ─── ヘルパー: 空プランで IMPLEMENTING 状態にする ────────────────────────────
function buildImplementingTask({ phase = 'runner-test' } = {}) {
  const task = createTask({ phase });
  const taskId = task.taskId;
  createdTaskIds.push(taskId);

  updateStatus(taskId, 'PLANNING');
  finalizePlanning(taskId, {
    plan: {
      summary:                 'test plan',
      requires_human_approval: false,
      warnings:                [],
      actions:                 [], // 空プラン
    },
    nextStatus:           'IMPLEMENTING',
    planningAttemptCount: 1,
  });
  return taskId;
}

// ─── ヘルパー: WAITING_FOR_APPROVAL 状態にする ───────────────────────────────
function buildWaitingForApprovalTask({ stage = 'planning' } = {}) {
  const task = createTask({ phase: 'runner-test-wfa' });
  const taskId = task.taskId;
  createdTaskIds.push(taskId);

  if (stage === 'planning') {
    updateStatus(taskId, 'PLANNING');
    finalizePlanning(taskId, {
      plan: {
        summary:                 'test plan',
        requires_human_approval: true,
        warnings:                [],
        actions:                 [],
      },
      nextStatus: 'WAITING_FOR_APPROVAL',
      planningAttemptCount: 1,
      pending_approval: {
        stage:        'planning',
        approval_id:  'test-approval-id-001',
        reason_code:  'PLAN_REQUIRES_HUMAN_APPROVAL',
        requested_at: new Date().toISOString(),
      },
    });
  }
  return taskId;
}

// ─── ヘルパー: COMPLETED 状態にする ──────────────────────────────────────────
function buildCompletedTask() {
  const task = createTask({ phase: 'runner-test-completed' });
  const taskId = task.taskId;
  createdTaskIds.push(taskId);

  updateStatus(taskId, 'PLANNING');
  finalizePlanning(taskId, {
    plan: { summary: 'test', requires_human_approval: false, warnings: [], actions: [] },
    nextStatus: 'IMPLEMENTING', planningAttemptCount: 1,
  });
  updateStatus(taskId, 'TESTING');
  finalizeTesting(taskId, {
    test_results: [],
    test_phase_note: 'no_run_test_actions',
    nextStatus: 'REVIEWING',
  });
  finalizeReview(taskId, {
    review_result: {
      decision:              'APPROVE',
      reason_code:           'NO_TESTS_RUN',
      failed_test_count:     0,
      passed_test_count:     0,
      warning_count:         0,
      review_iteration_count: 1,
      reviewed_at:           new Date().toISOString(),
    },
    next_status:      'WAITING_FOR_APPROVAL',
    new_iteration_count: 1,
    pending_approval: {
      stage:        'review',
      review_id:    'test-review-id-001',
      reason_code:  'NO_TESTS_RUN',
      requested_at: new Date().toISOString(),
    },
  });
  // 直接 COMPLETED へ
  updateStatus(taskId, 'COMPLETED');
  return taskId;
}

// ─── ヘルパー: REVISING 状態にする ───────────────────────────────────────────
function buildRevisingTask() {
  const task = createTask({ phase: 'runner-test-revising' });
  const taskId = task.taskId;
  createdTaskIds.push(taskId);

  updateStatus(taskId, 'PLANNING');
  finalizePlanning(taskId, {
    plan: { summary: 'test', requires_human_approval: false, warnings: [], actions: [] },
    nextStatus: 'IMPLEMENTING', planningAttemptCount: 1,
  });
  updateStatus(taskId, 'TESTING');
  finalizeTesting(taskId, {
    test_results: [{ test_id: 'test_alpha', passed: false, exit_code: 1 }],
    test_phase_note: null,
    nextStatus: 'REVIEWING',
  });
  finalizeReview(taskId, {
    review_result: {
      decision:              'REVISE',
      reason_code:           'TESTS_FAILED',
      failed_test_count:     1,
      passed_test_count:     0,
      warning_count:         0,
      review_iteration_count: 1,
      reviewed_at:           new Date().toISOString(),
    },
    next_status:      'REVISING',
    new_iteration_count: 1,
  });
  return taskId;
}

// ─── モック callOpenAI（空プラン・承認不要）──────────────────────────────────
function mockCallOpenAI_EmptyPlan() {
  return async () => ({
    ok:           true,
    parsed_output: {
      summary:                 'empty plan for testing',
      actions:                 [],
      requires_human_approval: false,
      warnings:                [],
    },
    x_request_id: 'mock-req-001',
  });
}

// ─── モック callOpenAI（承認要求プラン）──────────────────────────────────────
function mockCallOpenAI_ApprovalPlan() {
  return async () => ({
    ok:           true,
    parsed_output: {
      summary:                 'plan that requires approval',
      actions:                 [],
      requires_human_approval: true,
      warnings:                [],
    },
    x_request_id: 'mock-req-002',
  });
}

// ─── モック spawnFn（テスト未登録 = no-op）──────────────────────────────────
function mockSpawnFn() {
  return () => {};
}

// ─── テスト ───────────────────────────────────────────────────────────────────

// T1: taskId・phase 両方未指定 → INVALID_ARGUMENT エラー
test('T1: taskId・phase 両方未指定 → INVALID_ARGUMENT', async () => {
  const result = await runTask({});
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'INVALID_ARGUMENT');
  assert.equal(result.task_id, null);
  assert.equal(result.initial_state, null);
  assert.equal(result.final_state, null);
});

// T2: 存在しないtaskId → TASK_NOT_FOUND エラー
test('T2: 存在しないtaskId → TASK_NOT_FOUND', async () => {
  const result = await runTask({ taskId: 'task_20260101_ffffff' });
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'TASK_NOT_FOUND');
  assert.equal(result.task_id, 'task_20260101_ffffff');
});

// T3: TERMINAL状態（COMPLETED）→ terminal:true で即返却
test('T3: COMPLETED → terminal:true で即返却', async () => {
  const taskId = buildCompletedTask();
  const result = await runTask({ taskId });
  assert.equal(result.ok, false);
  assert.equal(result.task_id, taskId);
  assert.equal(result.terminal, true);
  assert.equal(result.initial_state, 'COMPLETED');
  assert.equal(result.final_state, 'COMPLETED');
  assert.deepEqual(result.actions_taken, []);
});

// T4: STOP状態（WAITING_FOR_APPROVAL）→ requires_human_approval:true で即返却
test('T4: WAITING_FOR_APPROVAL → requires_human_approval:true で即返却', async () => {
  const taskId = buildWaitingForApprovalTask();
  const result = await runTask({ taskId });
  assert.equal(result.ok, false);
  assert.equal(result.task_id, taskId);
  assert.equal(result.requires_human_approval, true);
  assert.equal(result.initial_state, 'WAITING_FOR_APPROVAL');
  assert.equal(result.final_state, 'WAITING_FOR_APPROVAL');
  assert.deepEqual(result.actions_taken, []);
  // approval_context が付与されること
  assert.ok(result.approval_context, 'approval_context が付与されること');
  assert.equal(result.approval_context.stage, 'planning');
});

// T5: STOP状態（REVISING）→ requires_recovery:true で即返却
test('T5: REVISING → requires_recovery:true で即返却', async () => {
  const taskId = buildRevisingTask();
  const result = await runTask({ taskId });
  assert.equal(result.ok, false);
  assert.equal(result.task_id, taskId);
  assert.equal(result.requires_recovery, true);
  assert.equal(result.initial_state, 'REVISING');
  assert.equal(result.final_state, 'REVISING');
  assert.deepEqual(result.actions_taken, []);
});

// T6: 新規タスク作成（phase指定）→ _inject.callOpenAI でモック → 空プランで IMPLEMENTING チェーン
test('T6: 新規タスク作成 + _inject.callOpenAI（承認要求）→ WAITING_FOR_APPROVAL で停止', async () => {
  const result = await runTask({
    phase:  'runner-test-t6',
    model:  'gpt-4o',
    gitSnapshot:  {},
    budgetState:  { openai_calls: 0, input_tokens: 0, output_tokens: 0, cached_input_tokens: 0, estimated_cost_usd: null, _pricing: null },
    budgetLimits: { max_openai_calls: 10 },
    _inject: {
      callOpenAI: mockCallOpenAI_ApprovalPlan(),
    },
  });

  // task_id が生成されていること
  assert.ok(result.task_id, 'task_id が生成されること');
  createdTaskIds.push(result.task_id);

  // CREATED → PLANNING 実行後 WAITING_FOR_APPROVAL で停止
  assert.equal(result.ok, true);
  assert.equal(result.initial_state, 'CREATED');
  assert.equal(result.final_state, 'WAITING_FOR_APPROVAL');
  assert.ok(result.requires_human_approval, 'requires_human_approval が true');
  assert.ok(Array.isArray(result.actions_taken));
  assert.ok(result.actions_taken.includes('CREATED'), 'CREATED フェーズが実行されること');
});

// T7: dry_run=true（IMPLEMENTING状態）→ 1フェーズのみ・状態変化なし
test('T7: dry_run=true → 1フェーズプレビュー・状態変化なし', async () => {
  const taskId = buildImplementingTask();

  const before = loadTask(taskId);
  assert.equal(before.status, 'IMPLEMENTING');

  const result = await runTask({
    taskId,
    dry_run: true,
    _inject: {
      spawnFn: mockSpawnFn(),
    },
  });

  assert.equal(result.dry_run, true);
  assert.equal(result.task_id, taskId);
  assert.equal(result.initial_state, 'IMPLEMENTING');

  // dry_run では状態変化しない（executeFilePlan が dry_run 時に updateStatus しない）
  const after = loadTask(taskId);
  assert.equal(after.status, 'IMPLEMENTING', 'dry_run で状態変化しないこと');
});

// T8: IMPLEMENTING状態から → TESTING→REVIEWING→WAITING_FOR_APPROVAL まで自動チェーン
test('T8: IMPLEMENTING → TESTING → REVIEWING → WAITING_FOR_APPROVAL 自動チェーン', async () => {
  const taskId = buildImplementingTask();

  const result = await runTask({
    taskId,
    _inject: {
      spawnFn:      mockSpawnFn(),
      testRegistry: {}, // テスト未登録
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.task_id, taskId);
  assert.equal(result.initial_state, 'IMPLEMENTING');
  assert.equal(result.final_state, 'WAITING_FOR_APPROVAL');

  // IMPLEMENTING, TESTING, REVIEWING の3フェーズが実行されること
  assert.ok(result.actions_taken.includes('IMPLEMENTING'), 'IMPLEMENTING が実行されること');
  assert.ok(result.actions_taken.includes('TESTING'),      'TESTING が実行されること');
  assert.ok(result.actions_taken.includes('REVIEWING'),    'REVIEWING が実行されること');

  // 承認待ちで停止
  assert.equal(result.requires_human_approval, true);
  assert.ok(result.approval_context, 'approval_context が付与されること');
  assert.equal(result.approval_context.stage, 'review');

  // 最終状態確認
  const task = loadTask(taskId);
  assert.equal(task.status, 'WAITING_FOR_APPROVAL');
});

// T9: getTaskStatus 正常系
test('T9: getTaskStatus → 正しい状態を返す', () => {
  const taskId = buildImplementingTask();

  const result = getTaskStatus(taskId);
  assert.equal(result.ok, true);
  assert.equal(result.task_id, taskId);
  assert.equal(result.status, 'IMPLEMENTING');
  assert.equal(result.requires_human_approval, false);
  assert.equal(result.requires_recovery, false);
  assert.ok(typeof result.created_at === 'string');
  assert.ok(typeof result.next_steps === 'string');
});

// T9b: getTaskStatus - 存在しないタスク
test('T9b: getTaskStatus - 存在しないタスク → TASK_NOT_FOUND', () => {
  const result = getTaskStatus('task_20260101_000000');
  assert.equal(result.ok, false);
  assert.equal(result.error.code, 'TASK_NOT_FOUND');
});

// T10: listAllTasks に作成したタスクが含まれる
test('T10: listAllTasks → 作成タスクが含まれる', () => {
  const taskId = buildImplementingTask();

  const list = listAllTasks();
  assert.ok(Array.isArray(list), 'listAllTasks は配列を返す');

  const found = list.find(t => t.task_id === taskId);
  assert.ok(found, '作成したタスクが一覧に含まれること');
  assert.equal(found.status, 'IMPLEMENTING');
  assert.ok(typeof found.phase === 'string');
  assert.ok(typeof found.created_at === 'string');
});
