/**
 * jarvis/orchestrator/task_manager.js
 * タスク状態管理（外部通信なし・git操作なし）
 */

import {
  writeFileSync,
  readFileSync,
  renameSync,
  existsSync,
  readdirSync,
  unlinkSync,
  mkdirSync,
} from 'fs';
import { join, resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { randomBytes } from 'crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));

// タスク保存ディレクトリ（jarvis/tasks/ 固定）
const TASKS_DIR = resolve(__dirname, '..', 'tasks');

// ─── 有効ステータス一覧 ───────────────────────────────────────────────────────
export const STATUSES = Object.freeze([
  'CREATED',
  'PLANNING',
  'IMPLEMENTING',
  'TESTING',
  'REVIEWING',
  'REVISING',
  'WAITING_FOR_APPROVAL',
  'PAUSED',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
]);

// ─── 有効な状態遷移マップ ──────────────────────────────────────────────────────
// ※ PAUSED は任意のアクティブ状態から遷移可能（個別チェック）
const VALID_TRANSITIONS = Object.freeze({
  CREATED:               ['PLANNING', 'CANCELLED'],
  PLANNING:              ['IMPLEMENTING', 'WAITING_FOR_APPROVAL', 'PAUSED', 'FAILED', 'CANCELLED'],
  IMPLEMENTING:          ['TESTING', 'PLANNING', 'PAUSED', 'FAILED', 'CANCELLED'],
  TESTING:               ['REVIEWING', 'IMPLEMENTING', 'PAUSED', 'FAILED', 'CANCELLED'],
  REVIEWING:             ['REVISING', 'WAITING_FOR_APPROVAL', 'PAUSED', 'FAILED', 'CANCELLED'],
  REVISING:              ['IMPLEMENTING', 'PAUSED', 'FAILED', 'CANCELLED'],
  WAITING_FOR_APPROVAL:  ['COMPLETED', 'REVISING', 'PLANNING', 'CANCELLED'],
  PAUSED:                ['PLANNING', 'IMPLEMENTING', 'TESTING', 'REVIEWING', 'REVISING', 'CANCELLED'],
  COMPLETED:             [],
  FAILED:                [],
  CANCELLED:             [],
});

// ─── タスクIDパターン ─────────────────────────────────────────────────────────
const TASK_ID_PATTERN = /^task_\d{8}_[0-9a-f]{6}$/;

// ─── タスクIDの生成 ───────────────────────────────────────────────────────────
/**
 * task_YYYYMMDD_xxxxxx 形式のIDを生成する。
 * 日付部分はJST（Asia/Tokyo）を使用する。
 * @returns {string}
 */
export function generateTaskId() {
  const now = new Date();
  // JST offset = UTC+9
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const y = jst.getUTCFullYear();
  const m = String(jst.getUTCMonth() + 1).padStart(2, '0');
  const d = String(jst.getUTCDate()).padStart(2, '0');
  const hex = randomBytes(3).toString('hex'); // 6文字
  return `task_${y}${m}${d}_${hex}`;
}

// ─── パストラバーサル防止 ─────────────────────────────────────────────────────
/**
 * taskId が安全かどうかを検証する。
 * ../  絶対パス  TASK_ID_PATTERN不一致 のいずれかで拒否。
 * @param {string} taskId
 * @returns {string} 解決済み安全パス
 * @throws {Error}
 */
function resolveTaskPath(taskId) {
  if (typeof taskId !== 'string') {
    throw new Error('INVALID_TASK_ID: taskId must be a string');
  }
  if (!TASK_ID_PATTERN.test(taskId)) {
    throw new Error(`INVALID_TASK_ID: "${taskId}" does not match expected format`);
  }
  if (taskId.includes('..') || taskId.includes('/') || taskId.includes('\\')) {
    throw new Error(`INVALID_TASK_ID: path traversal detected in "${taskId}"`);
  }

  const filePath = resolve(TASKS_DIR, taskId + '.json');

  // 解決後のパスが TASKS_DIR 配下にあることを確認
  if (!filePath.startsWith(TASKS_DIR + '\\') && !filePath.startsWith(TASKS_DIR + '/')) {
    throw new Error(`INVALID_TASK_ID: resolved path escapes tasks directory`);
  }
  return filePath;
}

// ─── タスクディレクトリ保証 ──────────────────────────────────────────────────
function ensureTasksDir() {
  if (!existsSync(TASKS_DIR)) {
    mkdirSync(TASKS_DIR, { recursive: true });
  }
}

// ─── 安全な書き込み ───────────────────────────────────────────────────────────
/**
 * tmp → JSON.parse検証 → renameSync の3ステップで安全に保存する。
 * @param {string} filePath
 * @param {object} data
 */
function safeSave(filePath, data) {
  const json = JSON.stringify(data, null, 2);

  // JSON.parseで検証（不正なオブジェクトを書かせない）
  JSON.parse(json);

  const tmpPath = filePath + '.tmp';
  writeFileSync(tmpPath, json, { encoding: 'utf8' });
  renameSync(tmpPath, filePath);
}

// ─── タスク作成 ───────────────────────────────────────────────────────────────
/**
 * 新しいタスクを作成して保存する。
 * @param {object} opts
 * @param {string} opts.phase   - フェーズ識別子（例: "C3"）
 * @param {string} [opts.model] - 使用モデル（省略可）
 * @returns {object} 作成されたタスクオブジェクト
 */
export function createTask({ phase, model = null } = {}) {
  if (!phase || typeof phase !== 'string') {
    throw new Error('INVALID_PHASE: phase is required and must be a string');
  }

  ensureTasksDir();

  const taskId = generateTaskId();
  const now = new Date().toISOString();

  const task = {
    taskId,
    phase,
    model,
    status: 'CREATED',
    created_at: now,
    updated_at: now,
    history: [
      { status: 'CREATED', at: now },
    ],
  };

  const filePath = resolveTaskPath(taskId);
  safeSave(filePath, task);

  return { ...task };
}

// ─── タスク読み込み ───────────────────────────────────────────────────────────
/**
 * タスクをIDで読み込む。
 * @param {string} taskId
 * @returns {object} タスクオブジェクト
 * @throws {Error} 存在しない場合
 */
export function loadTask(taskId) {
  const filePath = resolveTaskPath(taskId);
  if (!existsSync(filePath)) {
    throw new Error(`TASK_NOT_FOUND: ${taskId}`);
  }
  const raw = readFileSync(filePath, { encoding: 'utf8' });
  return JSON.parse(raw);
}

// ─── ステータス更新 ───────────────────────────────────────────────────────────
/**
 * タスクのステータスを更新する。
 * 無効な遷移は拒否する。
 * @param {string} taskId
 * @param {string} nextStatus
 * @returns {object} 更新後のタスクオブジェクト
 * @throws {Error}
 */
export function updateStatus(taskId, nextStatus) {
  if (!STATUSES.includes(nextStatus)) {
    throw new Error(`INVALID_STATUS: "${nextStatus}" is not a valid status`);
  }

  const task = loadTask(taskId);
  const current = task.status;
  const allowed = VALID_TRANSITIONS[current];

  if (!allowed.includes(nextStatus)) {
    throw new Error(
      `INVALID_TRANSITION: ${current} → ${nextStatus} is not allowed`
    );
  }

  const now = new Date().toISOString();
  task.status = nextStatus;
  task.updated_at = now;
  task.history.push({ status: nextStatus, at: now });

  const filePath = resolveTaskPath(taskId);
  safeSave(filePath, task);

  return { ...task };
}

// ─── タスク一覧取得 ───────────────────────────────────────────────────────────
/**
 * tasks/ ディレクトリ内の全タスクを返す。
 * .gitkeep など非タスクファイルは除外する。
 * @returns {object[]}
 */
export function listTasks() {
  ensureTasksDir();
  const files = readdirSync(TASKS_DIR);
  const tasks = [];

  for (const file of files) {
    if (!file.endsWith('.json')) continue;
    const taskId = file.slice(0, -5); // .json を除去
    if (!TASK_ID_PATTERN.test(taskId)) continue;

    try {
      const task = loadTask(taskId);
      tasks.push(task);
    } catch {
      // 破損ファイルはスキップ
    }
  }

  // created_at 昇順
  tasks.sort((a, b) => a.created_at.localeCompare(b.created_at));
  return tasks;
}

// ─── タスク削除（テスト用）───────────────────────────────────────────────────
/**
 * タスクファイルを削除する。テストのクリーンアップ専用。
 * @param {string} taskId
 */
export function deleteTask(taskId) {
  const filePath = resolveTaskPath(taskId);
  if (existsSync(filePath)) {
    unlinkSync(filePath);
  }
  // .tmp が残っている場合も削除
  const tmpPath = filePath + '.tmp';
  if (existsSync(tmpPath)) {
    unlinkSync(tmpPath);
  }
}

// ─── Planning 確定（原子的保存）──────────────────────────────────────────────
/**
 * Planning フェーズの終了処理。
 * plan保存・status更新・カウンタ更新を 1 回の安全な JSON 書き込みで確定する。
 *
 * 現在のステータスが PLANNING であることを確認してから実行する。
 * .tmp → JSON.parse検証 → renameSync の安全書き込みを使用する。
 *
 * @param {string} taskId
 * @param {object} opts
 * @param {object|null}  opts.plan                  - 保存する plan オブジェクト（失敗時は null）
 * @param {string}       opts.nextStatus            - 'IMPLEMENTING' | 'WAITING_FOR_APPROVAL' | 'FAILED'
 * @param {number}       opts.planningAttemptCount  - 新しい planning 試行回数（1以上の整数）
 * @param {string|null}  opts.lastErrorSignature    - エラーシグネチャ（成功時は null）
 * @returns {object} 更新後のタスクオブジェクト
 * @throws {Error} 状態不正・パラメータ不正の場合
 */
export function finalizePlanning(taskId, {
  plan,
  nextStatus,
  planningAttemptCount,
  lastErrorSignature = null,
} = {}) {
  const ALLOWED_NEXT_STATUSES = ['IMPLEMENTING', 'WAITING_FOR_APPROVAL', 'FAILED'];
  if (!ALLOWED_NEXT_STATUSES.includes(nextStatus)) {
    throw new Error(
      `INVALID_STATUS: finalizePlanning nextStatus must be one of ${ALLOWED_NEXT_STATUSES.join(', ')}, got "${nextStatus}"`
    );
  }

  if (
    typeof planningAttemptCount !== 'number' ||
    !Number.isInteger(planningAttemptCount) ||
    planningAttemptCount < 1
  ) {
    throw new Error('INVALID_PLANNING_ATTEMPT_COUNT: must be a positive integer');
  }

  const task = loadTask(taskId);

  if (task.status !== 'PLANNING') {
    throw new Error(
      `INVALID_STATE: finalizePlanning requires status PLANNING, got "${task.status}"`
    );
  }

  const now = new Date().toISOString();

  const updatedTask = {
    ...task,
    status:                  nextStatus,
    updated_at:              now,
    history:                 [...task.history, { status: nextStatus, at: now }],
    planning_attempt_count:  planningAttemptCount,
    last_error_signature:    lastErrorSignature ?? null,
  };

  // plan フィールドは成功時のみ上書き（失敗時は既存 plan を保持）
  if (plan !== null && plan !== undefined) {
    updatedTask.plan = plan;
  }

  const filePath = resolveTaskPath(taskId);
  safeSave(filePath, updatedTask);

  return { ...updatedTask };
}

// ─── Testing 確定（原子的保存）──────────────────────────────────────────────
/**
 * Testing フェーズの終了処理。
 * test_results保存・status更新を 1 回の安全な JSON 書き込みで確定する。
 *
 * @param {string} taskId
 * @param {object} opts
 * @param {object[]}     opts.test_results      - テスト結果配列
 * @param {string|null}  opts.test_phase_note   - フェーズ注記（省略可）
 * @param {string}       opts.nextStatus        - 'REVIEWING' | 'FAILED'
 * @returns {object} 更新後のタスクオブジェクト
 * @throws {Error} 状態不正・パラメータ不正の場合
 */
export function finalizeTesting(taskId, {
  test_results,
  test_phase_note = null,
  nextStatus,
} = {}) {
  const ALLOWED_NEXT_STATUSES = ['REVIEWING', 'FAILED'];
  if (!ALLOWED_NEXT_STATUSES.includes(nextStatus)) {
    throw new Error(
      `INVALID_STATUS: finalizeTesting nextStatus must be one of ${ALLOWED_NEXT_STATUSES.join(', ')}, got "${nextStatus}"`
    );
  }
  if (!Array.isArray(test_results)) {
    throw new Error('INVALID_TEST_RESULTS: test_results must be an array');
  }

  const task = loadTask(taskId);
  if (task.status !== 'TESTING') {
    throw new Error(
      `INVALID_STATE: finalizeTesting requires status TESTING, got "${task.status}"`
    );
  }

  const now = new Date().toISOString();
  const updatedTask = {
    ...task,
    status:             nextStatus,
    updated_at:         now,
    history:            [...task.history, { status: nextStatus, at: now }],
    test_results:       test_results,
    test_phase_note:    test_phase_note ?? null,
    test_completed_at:  now,
  };

  const filePath = resolveTaskPath(taskId);
  safeSave(filePath, updatedTask);
  return { ...updatedTask };
}

// ─── Review 確定（原子的保存）────────────────────────────────────────────────
/**
 * Review フェーズの終了処理。
 * review_result保存・status更新・review_history更新を 1 回の安全な JSON 書き込みで確定する。
 *
 * @param {string} taskId
 * @param {object} opts
 * @param {object}       opts.review_result       - レビュー結果オブジェクト
 * @param {string}       opts.next_status         - 'REVISING' | 'WAITING_FOR_APPROVAL'
 * @param {number}       opts.new_iteration_count - 新しいiteration数（非負整数）
 * @param {object|null}  [opts.pending_approval]  - 承認待ちコンテキスト
 * @param {string|null}  [opts.recommended_outcome] - 推奨アウトカム
 * @returns {object} 更新後のタスクオブジェクト
 * @throws {Error} 状態不正・パラメータ不正の場合
 */
export function finalizeReview(taskId, {
  review_result,
  next_status,
  new_iteration_count,
  pending_approval = null,
  recommended_outcome = null,
} = {}) {
  const ALLOWED_NEXT_STATUSES = ['REVISING', 'WAITING_FOR_APPROVAL'];
  if (!ALLOWED_NEXT_STATUSES.includes(next_status)) {
    throw new Error(
      `INVALID_STATUS: finalizeReview next_status must be one of ${ALLOWED_NEXT_STATUSES.join(', ')}, got "${next_status}"`
    );
  }
  if (!review_result || typeof review_result !== 'object') {
    throw new Error('INVALID_REVIEW_RESULT: review_result must be an object');
  }
  if (typeof new_iteration_count !== 'number' || !Number.isInteger(new_iteration_count) || new_iteration_count < 0) {
    throw new Error('INVALID_ITERATION_COUNT: new_iteration_count must be a non-negative integer');
  }

  const task = loadTask(taskId);
  if (task.status !== 'REVIEWING') {
    throw new Error(
      `INVALID_STATE: finalizeReview requires status REVIEWING, got "${task.status}"`
    );
  }

  const now = new Date().toISOString();

  // review_history更新（MAX_REVIEW_HISTORY超過時に先頭削除）
  const MAX_REVIEW_HISTORY = 20;
  const existingHistory = Array.isArray(task.review_history) ? task.review_history : [];
  const newHistoryEntry = { ...review_result };
  let updatedReviewHistory = [...existingHistory, newHistoryEntry];
  if (updatedReviewHistory.length > MAX_REVIEW_HISTORY) {
    updatedReviewHistory = updatedReviewHistory.slice(updatedReviewHistory.length - MAX_REVIEW_HISTORY);
  }

  const updatedTask = {
    ...task,
    status:                  next_status,
    updated_at:              now,
    history:                 [...task.history, { status: next_status, at: now }],
    review_result,
    review_history:          updatedReviewHistory,
    review_iteration_count:  new_iteration_count,
    last_reviewed_at:        now,
    ...(pending_approval !== null ? { pending_approval } : {}),
    ...(recommended_outcome !== null ? { recommended_outcome } : {}),
  };

  const filePath = resolveTaskPath(taskId);
  safeSave(filePath, updatedTask);
  return { ...updatedTask };
}

// ─── ReviewApproval 確定（原子的保存）────────────────────────────────────────
/**
 * Review承認フェーズの終了処理。
 * approval_result保存・status更新を 1 回の安全な JSON 書き込みで確定する。
 *
 * @param {string} taskId
 * @param {object} opts
 * @param {object}  opts.approval_result - 承認結果オブジェクト
 * @param {string}  opts.next_status     - 'COMPLETED' | 'REVISING'
 * @returns {object} 更新後のタスクオブジェクト
 * @throws {Error} 状態不正・パラメータ不正の場合
 */
export function finalizeReviewApproval(taskId, {
  approval_result,
  next_status,
} = {}) {
  const ALLOWED_NEXT_STATUSES = ['COMPLETED', 'REVISING'];
  if (!ALLOWED_NEXT_STATUSES.includes(next_status)) {
    throw new Error(
      `INVALID_STATUS: finalizeReviewApproval next_status must be one of ${ALLOWED_NEXT_STATUSES.join(', ')}, got "${next_status}"`
    );
  }
  if (!approval_result || typeof approval_result !== 'object') {
    throw new Error('INVALID_APPROVAL_RESULT: approval_result must be an object');
  }

  const task = loadTask(taskId);
  if (task.status !== 'WAITING_FOR_APPROVAL') {
    throw new Error(
      `INVALID_STATE: finalizeReviewApproval requires status WAITING_FOR_APPROVAL, got "${task.status}"`
    );
  }

  const now = new Date().toISOString();

  const updatedTask = {
    ...task,
    status:           next_status,
    updated_at:       now,
    history:          [...task.history, { status: next_status, at: now }],
    approval_result,
    pending_approval: null,  // 承認完了後に解除
    approved_at:      now,
  };

  const filePath = resolveTaskPath(taskId);
  safeSave(filePath, updatedTask);
  return { ...updatedTask };
}

// ─── テスト用内部エクスポート ─────────────────────────────────────────────────
export { TASKS_DIR, VALID_TRANSITIONS, TASK_ID_PATTERN };
