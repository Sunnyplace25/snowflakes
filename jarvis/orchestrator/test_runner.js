/**
 * jarvis/orchestrator/test_runner.js
 * C8: テスト実行エンジン（spawn のみ・外部通信なし・git操作なし）
 *
 * 本番の TEST_REGISTRY は空（Object.freeze({})）。
 * テスト注入は _inject.testRegistry / _inject.spawnFn で行う。
 */

import { spawn } from 'child_process';
import { dirname } from 'path';
import { fileURLToPath } from 'url';
import { resolve } from 'path';
import { existsSync } from 'fs';
import { lstatSync } from 'fs';
import { loadTask, finalizeTesting } from './task_manager.js';
import { logEvent } from './logger.js';
import { REPO_ROOT } from './safety_guard.js';

// ─── 本番レジストリ（常に空）─────────────────────────────────────────────────
const TEST_REGISTRY = Object.freeze({});

// ─── test_id パターン ─────────────────────────────────────────────────────────
const TEST_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/;

// ─── 定数 ─────────────────────────────────────────────────────────────────────
const DEFAULT_TEST_TIMEOUT_MS = 60_000;
const MAX_TEST_TIMEOUT_MS     = 120_000;
const MAX_STDOUT_BYTES        = 1_048_576;
const MAX_STDERR_BYTES        = 1_048_576;
const MAX_TESTS_PER_PHASE     = 10;

// ─── エラーコード ─────────────────────────────────────────────────────────────
export const TEST_RUNNER_ERRORS = Object.freeze({
  INVALID_ARGUMENT:         'TEST_EXECUTION_INVALID_ARGUMENT',
  TASK_NOT_FOUND:           'TEST_EXECUTION_TASK_NOT_FOUND',
  WRONG_STATE:              'TEST_EXECUTION_WRONG_STATE',
  PLAN_MISSING:             'TEST_EXECUTION_PLAN_MISSING',
  APPROVAL_REQUIRED:        'TEST_EXECUTION_APPROVAL_REQUIRED',
  INVALID_TEST_ID:          'TEST_EXECUTION_INVALID_TEST_ID',
  UNKNOWN_TEST_ID:          'TEST_EXECUTION_UNKNOWN_TEST_ID',
  DUPLICATE_TEST_ID:        'TEST_EXECUTION_DUPLICATE_TEST_ID',
  INVALID_REGISTRY_ENTRY:   'TEST_EXECUTION_INVALID_REGISTRY_ENTRY',
  CWD_INVALID:              'TEST_EXECUTION_CWD_INVALID',
  TOO_MANY_TESTS:           'TEST_EXECUTION_TOO_MANY_TESTS',
  SPAWN_FAILED:             'TEST_EXECUTION_SPAWN_FAILED',
  TIMEOUT:                  'TEST_EXECUTION_TIMEOUT',
  OUTPUT_TOO_LARGE:         'TEST_EXECUTION_OUTPUT_TOO_LARGE',
  KILL_FAILED:              'TEST_EXECUTION_KILL_FAILED',
  INTERNAL_ERROR:           'TEST_EXECUTION_INTERNAL_ERROR',
});

// ─── 安全な env 構築 ──────────────────────────────────────────────────────────
function _buildSafeEnv() {
  const ALLOWED_ENV_KEYS = ['SystemRoot', 'TEMP', 'TMP'];
  const safeEnv = {};
  for (const key of ALLOWED_ENV_KEYS) {
    if (typeof process.env[key] === 'string') {
      safeEnv[key] = process.env[key];
    }
  }
  // process.env.PATH 丸ごと禁止。node バイナリディレクトリのみ
  const nodeBinDir = dirname(process.execPath);
  safeEnv.PATH = nodeBinDir;
  safeEnv.JARVIS_TEST_MODE = '1';
  return safeEnv;
}

// ─── registry entry 検証 ──────────────────────────────────────────────────────
function _validateRegistryEntry(entry) {
  const ALLOWED_PROPS = new Set(['command', 'args', 'cwd']);
  for (const key of Object.keys(entry)) {
    if (!ALLOWED_PROPS.has(key)) {
      return { ok: false, reason: `unknown registry property: "${key}"` };
    }
  }
  if (entry.command !== process.execPath) {
    return { ok: false, reason: 'command must equal process.execPath' };
  }
  if (!Array.isArray(entry.args)) {
    return { ok: false, reason: 'args must be an array' };
  }
  const FORBIDDEN_ARGS = ['-e', '--eval', '-p', '--print'];
  for (const arg of entry.args) {
    if (typeof arg !== 'string') {
      return { ok: false, reason: 'each arg must be a string' };
    }
    if (FORBIDDEN_ARGS.includes(arg)) {
      return { ok: false, reason: `forbidden arg: "${arg}"` };
    }
    if (arg.startsWith('http://') || arg.startsWith('https://')) {
      return { ok: false, reason: `forbidden URL arg: "${arg}"` };
    }
  }
  if (typeof entry.cwd !== 'string' || entry.cwd.trim() === '') {
    return { ok: false, reason: 'cwd must be a non-empty string' };
  }
  return { ok: true };
}

// ─── cwd 安全検証 ─────────────────────────────────────────────────────────────
function _validateCwd(cwdRelative) {
  // 絶対パス禁止
  if (typeof cwdRelative !== 'string') return { ok: false };
  if (/^[/\\]/.test(cwdRelative) || /^[A-Za-z]:/.test(cwdRelative)) {
    return { ok: false, reason: 'cwd must be a relative path' };
  }
  // ../ 含む禁止
  if (cwdRelative.includes('..')) {
    return { ok: false, reason: 'cwd contains path traversal' };
  }
  const cwdAbs = resolve(REPO_ROOT, cwdRelative);
  // REPO_ROOT 外
  const repoNorm = REPO_ROOT.replace(/\\/g, '/');
  const cwdNorm = cwdAbs.replace(/\\/g, '/');
  if (!cwdNorm.startsWith(repoNorm + '/') && cwdNorm !== repoNorm) {
    return { ok: false, reason: 'cwd resolves outside REPO_ROOT' };
  }
  // 存在チェック
  if (!existsSync(cwdAbs)) {
    return { ok: false, reason: `cwd does not exist: ${cwdRelative}` };
  }
  // シンボリックリンクチェック
  try {
    const stat = lstatSync(cwdAbs);
    if (stat.isSymbolicLink()) {
      return { ok: false, reason: `cwd is a symbolic link: ${cwdRelative}` };
    }
  } catch {
    return { ok: false, reason: `cwd stat failed: ${cwdRelative}` };
  }
  return { ok: true, cwdAbs };
}

// ─── プロセス強制終了（Promise 返却）─────────────────────────────────────────
async function _killProcess(child) {
  return new Promise((resolve) => {
    let killed = false;
    const onExit = () => { killed = true; resolve({ ok: true }); };
    child.once('exit', onExit);
    child.once('close', onExit);

    child.kill('SIGTERM');

    setTimeout(() => {
      if (killed) return;
      child.kill('SIGKILL');
      setTimeout(() => {
        if (killed) return;
        child.removeListener('exit', onExit);
        child.removeListener('close', onExit);
        resolve({ ok: false });
      }, 300);
    }, 300);
  });
}

// ─── spawn 1 件実行（Promise 返却）──────────────────────────────────────────
async function _runSingleTest(entry, cwdAbs, timeoutMs, spawnFn) {
  const { command, args } = entry;
  const spawnOpts = {
    shell: false,
    cwd: cwdAbs,
    env: _buildSafeEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  };

  const actualSpawn = spawnFn ?? spawn;
  let child;
  try {
    child = actualSpawn(command, args, spawnOpts);
  } catch (e) {
    return { ok: false, code: TEST_RUNNER_ERRORS.SPAWN_FAILED, message: e.message };
  }

  // spawn エラーイベント（プロセス起動失敗）
  let spawnError = null;
  child.on('error', (e) => { spawnError = e; });

  const startTime = Date.now();
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let outputExceeded = false;
  let outputError = null;

  // stdout bytes カウント（本文保持禁止）
  child.stdout.on('data', (chunk) => {
    stdoutBytes += chunk.length;
    if (stdoutBytes > MAX_STDOUT_BYTES && !outputExceeded) {
      outputExceeded = true;
      outputError = { stream: 'stdout' };
    }
  });
  child.stderr.on('data', (chunk) => {
    stderrBytes += chunk.length;
    if (stderrBytes > MAX_STDERR_BYTES && !outputExceeded) {
      outputExceeded = true;
      outputError = { stream: 'stderr' };
    }
  });

  return new Promise((resolve) => {
    let finished = false;
    let timedOut = false;

    const finish = async (exitCode) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);

      const durationMs = Date.now() - startTime;

      if (outputExceeded) {
        const killResult = await _killProcess(child);
        if (!killResult.ok) {
          return resolve({ ok: false, code: TEST_RUNNER_ERRORS.KILL_FAILED, message: 'process could not be killed after output limit' });
        }
        return resolve({ ok: false, code: TEST_RUNNER_ERRORS.OUTPUT_TOO_LARGE, message: `output too large on ${outputError.stream}` });
      }

      if (spawnError) {
        return resolve({ ok: false, code: TEST_RUNNER_ERRORS.SPAWN_FAILED, message: spawnError.message });
      }

      return resolve({
        ok: true,
        exit_code: exitCode ?? 1,
        duration_ms: durationMs,
        stdout_bytes: stdoutBytes,
        stderr_bytes: stderrBytes,
        passed: exitCode === 0,
        completed_at: new Date().toISOString(),
      });
    };

    const timer = setTimeout(async () => {
      if (finished) return;
      timedOut = true;
      const killResult = await _killProcess(child);
      if (!finished) {
        finished = true;
        if (!killResult.ok) {
          resolve({ ok: false, code: TEST_RUNNER_ERRORS.KILL_FAILED, message: 'process could not be killed after timeout' });
        } else {
          resolve({ ok: false, code: TEST_RUNNER_ERRORS.TIMEOUT, message: `test timed out after ${timeoutMs}ms` });
        }
      }
    }, timeoutMs);

    child.on('close', (code) => {
      if (!timedOut) finish(code);
    });
    child.on('exit', (code) => {
      if (!timedOut) finish(code);
    });
    child.on('error', (e) => {
      if (!finished) {
        finished = true;
        clearTimeout(timer);
        resolve({ ok: false, code: TEST_RUNNER_ERRORS.SPAWN_FAILED, message: e.message });
      }
    });
  });
}

// ─── メイン内部ロジック ────────────────────────────────────────────────────────
async function _runTestCore(opts) {
  const {
    taskId,
    dry_run = true,
    human_approval_granted = false,
    test_timeout_ms,
    _inject: injOpts = {},
  } = opts ?? {};

  const spawnFn       = injOpts.spawnFn       ?? null;
  const testRegistry  = injOpts.testRegistry  ?? TEST_REGISTRY;

  // ── Step 1: 引数検証 ──────────────────────────────────────────────────────
  if (!taskId || typeof taskId !== 'string') {
    return { ok: false, task_id: null, state: null,
             error: { code: TEST_RUNNER_ERRORS.INVALID_ARGUMENT, message: 'taskId is required' } };
  }
  const effectiveTimeout = test_timeout_ms ?? DEFAULT_TEST_TIMEOUT_MS;
  if (test_timeout_ms !== undefined) {
    if (typeof test_timeout_ms !== 'number' || test_timeout_ms <= 0 || test_timeout_ms > MAX_TEST_TIMEOUT_MS) {
      return { ok: false, task_id: taskId, state: null,
               error: { code: TEST_RUNNER_ERRORS.INVALID_ARGUMENT,
                        message: `test_timeout_ms must be between 1 and ${MAX_TEST_TIMEOUT_MS}` } };
    }
  }

  // ── Step 2: task 読み込み ─────────────────────────────────────────────────
  let task;
  try {
    task = loadTask(taskId);
  } catch (e) {
    return { ok: false, task_id: taskId, state: null,
             error: { code: TEST_RUNNER_ERRORS.TASK_NOT_FOUND, message: e.message } };
  }

  // ── Step 3: status 確認 ───────────────────────────────────────────────────
  if (task.status !== 'TESTING') {
    return { ok: false, task_id: taskId, state: task.status,
             error: { code: TEST_RUNNER_ERRORS.WRONG_STATE,
                      message: `task status must be TESTING, got "${task.status}"` } };
  }

  // ── Step 4: plan 確認 ─────────────────────────────────────────────────────
  if (!task.plan || !Array.isArray(task.plan.actions)) {
    return { ok: false, task_id: taskId, state: 'TESTING',
             error: { code: TEST_RUNNER_ERRORS.PLAN_MISSING, message: 'task has no valid plan with actions array' } };
  }

  // ── Step 5: 承認確認 ──────────────────────────────────────────────────────
  if (task.plan.requires_human_approval === true && !human_approval_granted) {
    return { ok: false, task_id: taskId, state: 'TESTING',
             error: { code: TEST_RUNNER_ERRORS.APPROVAL_REQUIRED,
                      message: 'plan requires human approval before test execution' } };
  }

  // ── Step 6: run_test 抽出 ─────────────────────────────────────────────────
  const runTestActions = task.plan.actions.filter(a => a && a.type === 'run_test');

  // ── Step 7: 0 件 ─────────────────────────────────────────────────────────
  if (runTestActions.length === 0) {
    if (!dry_run) {
      // dry_run=false のみ finalizeTesting を呼ぶ（TESTING → REVIEWING）
      try {
        finalizeTesting(taskId, {
          test_results: [],
          test_phase_note: 'no_run_test_actions',
          nextStatus: 'REVIEWING',
        });
      } catch (e) {
        return { ok: false, task_id: taskId, state: 'TESTING',
                 error: { code: TEST_RUNNER_ERRORS.INTERNAL_ERROR, message: e.message } };
      }
      logEvent({ taskId, event: 'test_phase_complete', status: 'REVIEWING', test_count: 0, dry_run: false });
      return { ok: true, task_id: taskId, state: 'REVIEWING', dry_run: false, test_count: 0, test_results: [] };
    }
    // dry_run=true: task JSON を一切変更しない（完全 read-only）
    logEvent({ taskId, event: 'test_phase_complete', status: 'TESTING', test_count: 0, dry_run: true });
    return {
      ok:              true,
      task_id:         taskId,
      state:           'TESTING',
      dry_run:         true,
      test_count:      0,
      planned_tests:   [],
      test_phase_note: 'no_run_test_actions',
    };
  }

  // ── Step 8: max_tests_per_phase ───────────────────────────────────────────
  if (runTestActions.length > MAX_TESTS_PER_PHASE) {
    return { ok: false, task_id: taskId, state: 'TESTING',
             error: { code: TEST_RUNNER_ERRORS.TOO_MANY_TESTS,
                      message: `${runTestActions.length} run_test actions exceeds MAX_TESTS_PER_PHASE ${MAX_TESTS_PER_PHASE}` } };
  }

  // ── Step 9: 全件 preflight（test_id 検証・registry 確認・entry 検証） ──────
  const resolvedEntries = [];  // { test_id, entry, cwdAbs }
  for (const action of runTestActions) {
    const testId = action.test_id;

    // test_id 形式検証
    if (typeof testId !== 'string' || testId.trim() === '') {
      return { ok: false, task_id: taskId, state: 'TESTING',
               error: { code: TEST_RUNNER_ERRORS.INVALID_TEST_ID,
                        message: `run_test action has invalid test_id: ${JSON.stringify(testId)}` } };
    }
    if (!TEST_ID_PATTERN.test(testId)) {
      return { ok: false, task_id: taskId, state: 'TESTING',
               error: { code: TEST_RUNNER_ERRORS.INVALID_TEST_ID,
                        message: `test_id "${testId}" does not match pattern ${TEST_ID_PATTERN}` } };
    }

    // registry 確認
    if (!Object.prototype.hasOwnProperty.call(testRegistry, testId)) {
      return { ok: false, task_id: taskId, state: 'TESTING',
               error: { code: TEST_RUNNER_ERRORS.UNKNOWN_TEST_ID,
                        message: `unknown test_id: "${testId}"` } };
    }

    // entry 検証
    const entry = testRegistry[testId];
    const entryCheck = _validateRegistryEntry(entry);
    if (!entryCheck.ok) {
      return { ok: false, task_id: taskId, state: 'TESTING',
               error: { code: TEST_RUNNER_ERRORS.INVALID_REGISTRY_ENTRY,
                        message: `registry entry for "${testId}" is invalid: ${entryCheck.reason}` } };
    }

    // cwd 安全検証
    const cwdCheck = _validateCwd(entry.cwd);
    if (!cwdCheck.ok) {
      return { ok: false, task_id: taskId, state: 'TESTING',
               error: { code: TEST_RUNNER_ERRORS.CWD_INVALID,
                        message: `cwd for test_id "${testId}" is invalid: ${cwdCheck.reason}` } };
    }

    resolvedEntries.push({ test_id: testId, entry, cwdAbs: cwdCheck.cwdAbs });
  }

  // ── Step 10: 重複 test_id 確認 ────────────────────────────────────────────
  const seenIds = new Set();
  for (const { test_id } of resolvedEntries) {
    if (seenIds.has(test_id)) {
      return { ok: false, task_id: taskId, state: 'TESTING',
               error: { code: TEST_RUNNER_ERRORS.DUPLICATE_TEST_ID,
                        message: `duplicate test_id: "${test_id}"` } };
    }
    seenIds.add(test_id);
  }

  // ── Step 11: dry_run ──────────────────────────────────────────────────────
  if (dry_run) {
    return {
      ok: true,
      dry_run: true,
      task_id: taskId,
      state: 'TESTING',
      test_count: resolvedEntries.length,
      planned_tests: resolvedEntries.map(r => ({ test_id: r.test_id })),
    };
  }

  // ── Step 12: 直列 spawn 実行 ──────────────────────────────────────────────
  const testResults = [];

  for (const { test_id, entry, cwdAbs } of resolvedEntries) {
    let singleResult;
    try {
      singleResult = await _runSingleTest(entry, cwdAbs, effectiveTimeout, spawnFn);
    } catch (e) {
      // 内部例外
      try {
        finalizeTesting(taskId, {
          test_results: testResults,
          test_phase_note: null,
          nextStatus: 'FAILED',
        });
      } catch {}
      logEvent({ taskId, event: 'test_phase_error', status: 'FAILED', error_type: TEST_RUNNER_ERRORS.INTERNAL_ERROR });
      return { ok: false, task_id: taskId, state: 'FAILED',
               error: { code: TEST_RUNNER_ERRORS.INTERNAL_ERROR, message: e.message } };
    }

    if (!singleResult.ok) {
      // system error → FAILED
      try {
        finalizeTesting(taskId, {
          test_results: testResults,
          test_phase_note: null,
          nextStatus: 'FAILED',
        });
      } catch {}
      logEvent({ taskId, event: 'test_phase_error', status: 'FAILED', error_type: singleResult.code });
      return { ok: false, task_id: taskId, state: 'FAILED',
               error: { code: singleResult.code, message: singleResult.message } };
    }

    // 通常結果（pass/fail 問わず）
    testResults.push({
      test_id,
      passed:       singleResult.passed,
      exit_code:    singleResult.exit_code,
      duration_ms:  singleResult.duration_ms,
      stdout_bytes: singleResult.stdout_bytes,
      stderr_bytes: singleResult.stderr_bytes,
      completed_at: singleResult.completed_at,
    });
  }

  // ── Step 13: 全件完了 → REVIEWING ─────────────────────────────────────────
  try {
    finalizeTesting(taskId, {
      test_results: testResults,
      test_phase_note: null,
      nextStatus: 'REVIEWING',
    });
  } catch (e) {
    return { ok: false, task_id: taskId, state: 'TESTING',
             error: { code: TEST_RUNNER_ERRORS.INTERNAL_ERROR, message: e.message } };
  }

  const passedCount = testResults.filter(r => r.passed).length;
  const failedCount = testResults.length - passedCount;
  logEvent({
    taskId,
    event:              'test_phase_complete',
    status:             'REVIEWING',
    test_count:         testResults.length,
    test_passed_count:  passedCount,
    test_failed_count:  failedCount,
    dry_run:            false,
  });

  return {
    ok: true,
    task_id: taskId,
    state: 'REVIEWING',
    dry_run: false,
    test_count: testResults.length,
    test_results: testResults,
  };
}

// ─── 公開 API ─────────────────────────────────────────────────────────────────
export async function runTestPhase(opts = {}) {
  return _runTestCore(opts);
}

export function preflightTestPlan(opts = {}) {
  return _runTestCore({ ...opts, dry_run: true });
}

export {
  TEST_REGISTRY,
  TEST_ID_PATTERN,
  _buildSafeEnv,
  _validateRegistryEntry,
  _validateCwd,
};
