/**
 * jarvis/orchestrator/recovery_manager.js
 * Safe REVISING Recovery — REVISINGで停止したタスクを安全に復旧する
 *
 * 責務:
 *   - REVISING状態のまま停止したタスクを IMPLEMENTING へ安全に戻す
 *
 * 制約:
 *   - APPROVED / COMPLETED 等へは遷移しない
 *   - 既存の承認フローを迂回しない
 *   - 外部通信・git操作・shell実行を行わない
 *   - confirmed_by_human: 'human' は明示的な人間操作を示す intent marker
 *     （認証ではなく「自動生成で呼ばれていないこと」を示すためのみ使用）
 */

import { loadTask, finalizeRevisingRecovery } from './task_manager.js';
import { logEvent } from './logger.js';

// ─── エラーコード ─────────────────────────────────────────────────────────────
export const RECOVERY_MANAGER_ERRORS = Object.freeze({
  INVALID_ARGUMENT:     'RECOVERY_INVALID_ARGUMENT',
  TASK_NOT_FOUND:       'RECOVERY_TASK_NOT_FOUND',
  WRONG_STATE:          'RECOVERY_WRONG_STATE',
  INVALID_CONFIRMATION: 'RECOVERY_INVALID_CONFIRMATION',
  INTERNAL_ERROR:       'RECOVERY_INTERNAL_ERROR',
});

// ─── recoverRevising（公開API）───────────────────────────────────────────────
/**
 * REVISING状態で停止したタスクを IMPLEMENTING へ戻す。
 *
 * 呼び出し条件:
 *   - status が REVISING であること
 *   - confirmed_by_human: 'human' を明示的に渡すこと
 *
 * 復旧後の状態:
 *   - status: 'IMPLEMENTING'
 *   - last_revising_recovery に復旧情報を記録（recovered_at / reason_code）
 *   - revising_recovery_count をインクリメント
 *
 * 二重実行の安全性:
 *   - 1回目の復旧後は status が IMPLEMENTING になるため、
 *     再度呼ぶと WRONG_STATE エラーで即返る（べき等に近い動作）
 *
 * @param {object} opts
 * @param {string} opts.taskId
 * @param {string} opts.confirmed_by_human - 'human' 固定
 * @returns {{ ok: boolean, task_id: string|null, state: string|null,
 *             original_reason_code?: string|null, error?: object }}
 */
export function recoverRevising(opts = {}) {
  const { taskId, confirmed_by_human } = opts ?? {};

  // Step 1: 引数検証
  if (!taskId || typeof taskId !== 'string') {
    return {
      ok: false, task_id: null, state: null,
      error: { code: RECOVERY_MANAGER_ERRORS.INVALID_ARGUMENT,
               message: 'taskId is required' },
    };
  }
  if (confirmed_by_human !== 'human') {
    return {
      ok: false, task_id: taskId, state: null,
      error: { code: RECOVERY_MANAGER_ERRORS.INVALID_CONFIRMATION,
               message: 'confirmed_by_human must be the string "human"' },
    };
  }

  // Step 2: task読み込み
  let task;
  try {
    task = loadTask(taskId);
  } catch (e) {
    return {
      ok: false, task_id: taskId, state: null,
      error: { code: RECOVERY_MANAGER_ERRORS.TASK_NOT_FOUND, message: e.message },
    };
  }

  // Step 3: status確認（REVISING以外は復旧不要または不正）
  if (task.status !== 'REVISING') {
    return {
      ok: false, task_id: taskId, state: task.status,
      error: { code: RECOVERY_MANAGER_ERRORS.WRONG_STATE,
               message: `task status must be REVISING, got "${task.status}"` },
    };
  }

  // Step 4: 復旧前情報を記録
  const originalReasonCode = task.review_result?.reason_code ?? null;

  // Step 5: REVISING → IMPLEMENTING へ原子的に遷移
  try {
    finalizeRevisingRecovery(taskId, { recovery_reason: 'manual_recovery' });
  } catch (e) {
    return {
      ok: false, task_id: taskId, state: 'REVISING',
      error: { code: RECOVERY_MANAGER_ERRORS.INTERNAL_ERROR, message: e.message },
    };
  }

  logEvent({
    taskId,
    event:       'revising_recovery',
    status:      'IMPLEMENTING',
    reason_code: originalReasonCode,
    dry_run:     false,
  });

  return {
    ok: true,
    task_id: taskId,
    state: 'IMPLEMENTING',
    original_reason_code: originalReasonCode,
  };
}
