/**
 * jarvis/orchestrator/file_executor.js
 * ファイル実行エンジン（edit_file / create_file のみ）
 * 外部通信なし・git操作なし・child_processなし
 */

import { createHash } from 'crypto';
import {
  readFileSync,
  writeFileSync,
  renameSync as fsRenameSync,
  unlinkSync,
  lstatSync as fsLstatSync,
  existsSync,
} from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { loadTask, updateStatus } from './task_manager.js';
import { isAllowedPath, REPO_ROOT } from './safety_guard.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── 実行上限 ─────────────────────────────────────────────────────────────────
export const DEFAULT_EXECUTION_LIMITS = Object.freeze({
  max_files_per_execution:  5,
  max_operations_per_file:  10,
  max_file_size_bytes:      524_288,   // 512 KB
  max_total_write_bytes:    1_048_576, // 1 MB
  max_added_lines:          300,
  max_removed_lines:        300,
});

// ─── エラーコード ─────────────────────────────────────────────────────────────
export const EXECUTION_ERRORS = Object.freeze({
  INVALID_ARGUMENT:     'EXECUTION_INVALID_ARGUMENT',
  TASK_NOT_FOUND:       'EXECUTION_TASK_NOT_FOUND',
  WRONG_STATE:          'EXECUTION_WRONG_STATE',
  PLAN_MISSING:         'EXECUTION_PLAN_MISSING',
  APPROVAL_REQUIRED:    'EXECUTION_APPROVAL_REQUIRED',
  PAYLOAD_MISSING:      'EXECUTION_PAYLOAD_MISSING',
  ACTION_UNSUPPORTED:   'EXECUTION_ACTION_UNSUPPORTED',
  PATH_BLOCKED:         'EXECUTION_PATH_BLOCKED',
  PROTECTED_FILE:       'EXECUTION_PROTECTED_FILE',
  BINARY_FILE:          'EXECUTION_BINARY_FILE',
  INVALID_UTF8:         'EXECUTION_INVALID_UTF8',
  SECRET_DETECTED:      'EXECUTION_SECRET_DETECTED',
  FILE_NOT_FOUND:       'EXECUTION_FILE_NOT_FOUND',
  FILE_ALREADY_EXISTS:  'EXECUTION_FILE_ALREADY_EXISTS',
  OLD_TEXT_NOT_FOUND:   'EXECUTION_OLD_TEXT_NOT_FOUND',
  OLD_TEXT_AMBIGUOUS:   'EXECUTION_OLD_TEXT_AMBIGUOUS',
  FILE_CHANGED_DURING:  'EXECUTION_FILE_CHANGED_DURING',
  SIZE_EXCEEDED:        'EXECUTION_SIZE_EXCEEDED',
  WRITE_FAILED:         'EXECUTION_WRITE_FAILED',
  RENAME_FAILED:        'EXECUTION_RENAME_FAILED',
  DUPLICATE_TARGET:     'EXECUTION_DUPLICATE_TARGET',
  SYMLINK_BLOCKED:      'EXECUTION_SYMLINK_BLOCKED',
  PARENT_DIR_NOT_FOUND: 'EXECUTION_PARENT_DIR_NOT_FOUND',
  ROLLBACK_FAILED:      'ROLLBACK_FAILED',
});

// ─── テスト用インジェクション（モジュールレベル） ────────────────────────────
export const _inject = {
  lstatSync:      null,  // (absPath) => stats-like
  renameSync:     null,  // (src, dest) => void
  writeTmpSync:   null,  // (tmpPath, buffer) => void
  onBeforeRename: null,  // () => void
};

// ─── シークレット検出パターン ─────────────────────────────────────────────────
const SECRET_PATTERNS = [
  { name: 'AWS_ACCESS_KEY',    pattern: /AKIA[0-9A-Z]{16}/ },
  { name: 'GITHUB_TOKEN',      pattern: /ghp_[0-9a-zA-Z]{36}/ },
  { name: 'GITHUB_OAUTH',      pattern: /gho_[0-9a-zA-Z]{36}/ },
  { name: 'PRIVATE_KEY_BLOCK', pattern: /-----BEGIN (?:RSA )?PRIVATE KEY-----/ },
  { name: 'PASSWORD_ASSIGN',   pattern: /(?:password|passwd|secret|api_key|apikey|access_token)\s*[:=]\s*["'][^"']{8,}/i },
];

// ─── ユーティリティ ───────────────────────────────────────────────────────────
function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function stripBOM(buffer) {
  if (buffer.length >= 3 && buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
    return { hasBOM: true, stripped: buffer.slice(3) };
  }
  return { hasBOM: false, stripped: buffer };
}

function isBinaryBuffer(buffer) {
  const checkLen = Math.min(buffer.length, 8192);
  for (let i = 0; i < checkLen; i++) {
    if (buffer[i] === 0) return true;
  }
  return false;
}

function detectSecrets(content) {
  for (const { name, pattern } of SECRET_PATTERNS) {
    if (pattern.test(content)) return { found: true, name };
  }
  return { found: false };
}

// ─── 操作適用 ─────────────────────────────────────────────────────────────────
/**
 * replace_exact 操作を順次適用する。
 * $文字補間なし（slice + concat で置換）。
 *
 * @param {string} content
 * @param {Array<{op:string, old_text:string, new_text:string}>} operations
 * @returns {{ ok:boolean, newContent?:string, addedLines?:number, removedLines?:number,
 *             error?:string, reason?:string, opIndex?:number }}
 */
export function applyOperations(content, operations) {
  if (typeof content !== 'string') {
    return { ok: false, error: EXECUTION_ERRORS.INVALID_ARGUMENT, reason: 'content must be a string' };
  }
  if (!Array.isArray(operations)) {
    return { ok: false, error: EXECUTION_ERRORS.INVALID_ARGUMENT, reason: 'operations must be an array' };
  }

  let current = content;
  let addedLines = 0;
  let removedLines = 0;

  for (let i = 0; i < operations.length; i++) {
    const op = operations[i];

    if (!op || typeof op !== 'object') {
      return { ok: false, error: EXECUTION_ERRORS.PAYLOAD_MISSING, opIndex: i, reason: `operation at index ${i} is not an object` };
    }
    if (op.op !== 'replace_exact') {
      return { ok: false, error: EXECUTION_ERRORS.PAYLOAD_MISSING, opIndex: i, reason: `operation at index ${i} op must be "replace_exact", got "${op.op}"` };
    }
    if (typeof op.old_text !== 'string' || typeof op.new_text !== 'string') {
      return { ok: false, error: EXECUTION_ERRORS.PAYLOAD_MISSING, opIndex: i, reason: `operation at index ${i} requires string old_text and new_text` };
    }

    // 出現回数カウント（2以上で即停止）
    let count = 0;
    let searchFrom = 0;
    while (count < 2) {
      const found = current.indexOf(op.old_text, searchFrom);
      if (found === -1) break;
      count++;
      searchFrom = found + 1;
    }

    if (count === 0) {
      return { ok: false, error: EXECUTION_ERRORS.OLD_TEXT_NOT_FOUND, opIndex: i, reason: `old_text not found at operation index ${i}` };
    }
    if (count > 1) {
      return { ok: false, error: EXECUTION_ERRORS.OLD_TEXT_AMBIGUOUS, opIndex: i, reason: `old_text is ambiguous (found more than once) at operation index ${i}` };
    }

    // 1回のみ適用（$補間なし）
    const idx = current.indexOf(op.old_text);
    current = current.slice(0, idx) + op.new_text + current.slice(idx + op.old_text.length);

    removedLines += op.old_text.split('\n').length;
    addedLines += op.new_text.split('\n').length;
  }

  return { ok: true, newContent: current, addedLines, removedLines };
}

// ─── アクション検証 ───────────────────────────────────────────────────────────
/**
 * 単一アクションの静的検証（ファイルI/Oなし）。
 *
 * @param {object} action
 * @param {object} [executionOpts]
 * @returns {{ ok:boolean, error?:string, reason?:string }}
 */
export function validateFileAction(action, executionOpts = {}) {
  const limits = { ...DEFAULT_EXECUTION_LIMITS, ...executionOpts };

  if (!action || typeof action !== 'object') {
    return { ok: false, error: EXECUTION_ERRORS.INVALID_ARGUMENT, reason: 'action must be an object' };
  }

  const { type, path: actionPath } = action;

  if (!type || typeof type !== 'string') {
    return { ok: false, error: EXECUTION_ERRORS.INVALID_ARGUMENT, reason: 'action.type is required' };
  }

  if (type !== 'edit_file' && type !== 'create_file') {
    return { ok: false, error: EXECUTION_ERRORS.ACTION_UNSUPPORTED, reason: `unsupported action type: "${type}"` };
  }

  // パス検証（denylist・traversal・repo外）
  const pathCheck = isAllowedPath(actionPath, {});
  if (pathCheck.result !== 'ALLOW') {
    return { ok: false, error: EXECUTION_ERRORS.PATH_BLOCKED, reason: pathCheck.reason };
  }

  if (type === 'edit_file') {
    if (!Array.isArray(action.operations) || action.operations.length === 0) {
      return { ok: false, error: EXECUTION_ERRORS.PAYLOAD_MISSING, reason: 'edit_file requires at least one operation' };
    }
    if (action.operations.length > limits.max_operations_per_file) {
      return {
        ok: false,
        error: EXECUTION_ERRORS.SIZE_EXCEEDED,
        reason: `operations count ${action.operations.length} exceeds max_operations_per_file ${limits.max_operations_per_file}`,
      };
    }
    for (let i = 0; i < action.operations.length; i++) {
      const op = action.operations[i];
      if (!op || typeof op !== 'object') {
        return { ok: false, error: EXECUTION_ERRORS.PAYLOAD_MISSING, reason: `operation at index ${i} is not an object` };
      }
      if (op.op !== 'replace_exact') {
        return { ok: false, error: EXECUTION_ERRORS.PAYLOAD_MISSING, reason: `operation at index ${i} op must be "replace_exact", got "${op.op}"` };
      }
      if (typeof op.old_text !== 'string' || typeof op.new_text !== 'string') {
        return { ok: false, error: EXECUTION_ERRORS.PAYLOAD_MISSING, reason: `operation at index ${i} requires string old_text and new_text` };
      }
    }
  } else {
    // create_file
    if (typeof action.content !== 'string') {
      return { ok: false, error: EXECUTION_ERRORS.PAYLOAD_MISSING, reason: 'create_file requires string content' };
    }
  }

  return { ok: true };
}

// ─── プリフライト（同期） ─────────────────────────────────────────────────────
/**
 * dry_run=true でコアロジックを同期実行する。ファイル書き込みなし。
 *
 * @param {object} opts
 * @returns {object} result
 */
export function preflightFilePlan(opts) {
  return _executeCore({ ...opts, dry_run: true });
}

// ─── メイン実行（非同期ラッパー） ─────────────────────────────────────────────
/**
 * ファイルプランを実行する。dry_run=true（デフォルト）では書き込みを行わない。
 *
 * @param {object} [opts]
 * @returns {Promise<object>} result
 */
export async function executeFilePlan(opts = {}) {
  return _executeCore(opts);
}

// ─── コア実装（同期） ─────────────────────────────────────────────────────────
function _executeCore(opts) {
  const {
    taskId,
    dry_run = true,
    execution_limits: userLimits = {},
    _inject: injOpts = {},
  } = opts ?? {};

  // インジェクション解決（per-call > module-level）
  const inj = {
    lstatSync:      injOpts.lstatSync      ?? _inject.lstatSync,
    renameSync:     injOpts.renameSync     ?? _inject.renameSync,
    writeTmpSync:   injOpts.writeTmpSync   ?? _inject.writeTmpSync,
    onBeforeRename: injOpts.onBeforeRename ?? _inject.onBeforeRename,
  };

  const limits = { ...DEFAULT_EXECUTION_LIMITS, ...userLimits };

  // ─── 1. 引数検証 ─────────────────────────────────────────────────────────
  if (!taskId || typeof taskId !== 'string') {
    return { ok: false, error: EXECUTION_ERRORS.INVALID_ARGUMENT, reason: 'taskId is required and must be a string' };
  }

  // ─── 2. タスク読み込み ──────────────────────────────────────────────────
  let task;
  try {
    task = loadTask(taskId);
  } catch (e) {
    if (e.message && e.message.startsWith('TASK_NOT_FOUND')) {
      return { ok: false, error: EXECUTION_ERRORS.TASK_NOT_FOUND, reason: e.message };
    }
    return { ok: false, error: EXECUTION_ERRORS.INVALID_ARGUMENT, reason: e.message };
  }

  // ─── 3. 状態確認 ─────────────────────────────────────────────────────────
  if (task.status !== 'IMPLEMENTING') {
    return { ok: false, error: EXECUTION_ERRORS.WRONG_STATE, reason: `task status must be IMPLEMENTING, got "${task.status}"` };
  }

  // ─── 4. プラン確認 ───────────────────────────────────────────────────────
  if (!task.plan || !Array.isArray(task.plan.actions)) {
    return { ok: false, error: EXECUTION_ERRORS.PLAN_MISSING, reason: 'task has no valid plan with actions array' };
  }

  // ─── 5. 承認確認 ─────────────────────────────────────────────────────────
  if (task.plan.requires_human_approval === true) {
    return { ok: false, error: EXECUTION_ERRORS.APPROVAL_REQUIRED, reason: 'plan requires human approval before execution' };
  }

  // ─── 6. アクション分類 ───────────────────────────────────────────────────
  // 実行: edit_file / create_file
  // deferred: run_test（C8で実行・C7ではスキップ）
  // skip: no_op
  // BLOCK: delete_file / read_file / unknown / その他
  const executableActions = [];
  const deferredActions   = [];  // run_test: KNOWN DEFERRED

  for (const action of task.plan.actions) {
    if (!action) continue;
    if (action.type === 'no_op') continue; // 明示的スキップ
    if (action.type === 'edit_file' || action.type === 'create_file') {
      executableActions.push(action);
    } else if (action.type === 'run_test') {
      deferredActions.push(action);  // C7では実行しない・planから削除しない
    } else {
      return {
        ok: false,
        error: EXECUTION_ERRORS.ACTION_UNSUPPORTED,
        reason: `unsupported action type in plan: "${action.type}"`,
        path: action.path,
      };
    }
  }

  // ─── 7. 重複ターゲット検出（大文字小文字非区別） ──────────────────────
  const seenPaths = new Map();
  for (let i = 0; i < executableActions.length; i++) {
    const action = executableActions[i];
    const key = (action.path || '').toLowerCase().replace(/\\/g, '/');
    if (seenPaths.has(key)) {
      return {
        ok: false,
        error: EXECUTION_ERRORS.DUPLICATE_TARGET,
        reason: `duplicate target path "${action.path}" at indices ${seenPaths.get(key)} and ${i}`,
      };
    }
    seenPaths.set(key, i);
  }

  // ─── 8. ファイル数上限 ───────────────────────────────────────────────────
  if (executableActions.length > limits.max_files_per_execution) {
    return {
      ok: false,
      error: EXECUTION_ERRORS.SIZE_EXCEEDED,
      reason: `${executableActions.length} executable actions exceeds max_files_per_execution ${limits.max_files_per_execution}`,
    };
  }

  // ─── 9. 個別アクション検証 ──────────────────────────────────────────────
  for (const action of executableActions) {
    const v = validateFileAction(action, limits);
    if (!v.ok) return { ok: false, error: v.error, reason: v.reason, path: action.path };
  }

  // ─── Phase 1: プリフライト（インメモリ） ────────────────────────────────
  const _lstat = inj.lstatSync ?? fsLstatSync;

  const phase1Results = [];
  let totalWriteBytes = 0;
  let totalAddedLines = 0;
  let totalRemovedLines = 0;

  for (const action of executableActions) {
    const absPath = resolve(REPO_ROOT, action.path);

    // シンボリックリンクチェック
    let lstats = null;
    try { lstats = _lstat(absPath); } catch { lstats = null; }

    if (lstats && lstats.isSymbolicLink()) {
      return { ok: false, error: EXECUTION_ERRORS.SYMLINK_BLOCKED, reason: `"${action.path}" is a symbolic link`, path: action.path };
    }

    if (action.type === 'edit_file') {
      // ファイル存在確認
      if (!existsSync(absPath)) {
        return { ok: false, error: EXECUTION_ERRORS.FILE_NOT_FOUND, reason: `"${action.path}" does not exist`, path: action.path };
      }

      // 読み込み
      let rawBuffer;
      try {
        rawBuffer = readFileSync(absPath);
      } catch (e) {
        return { ok: false, error: EXECUTION_ERRORS.FILE_NOT_FOUND, reason: `failed to read "${action.path}": ${e.message}`, path: action.path };
      }

      // サイズ上限
      if (rawBuffer.length > limits.max_file_size_bytes) {
        return {
          ok: false,
          error: EXECUTION_ERRORS.SIZE_EXCEEDED,
          reason: `"${action.path}" size ${rawBuffer.length} exceeds max_file_size_bytes ${limits.max_file_size_bytes}`,
          path: action.path,
        };
      }

      // バイナリ検出
      if (isBinaryBuffer(rawBuffer)) {
        return { ok: false, error: EXECUTION_ERRORS.BINARY_FILE, reason: `"${action.path}" appears to be a binary file`, path: action.path };
      }

      // BOMストリップ
      const { hasBOM, stripped: contentBuffer } = stripBOM(rawBuffer);

      // UTF-8デコード（U+FFFD = 不正シーケンス）
      const decoded = contentBuffer.toString('utf8');
      if (decoded.includes('\uFFFD')) {
        return { ok: false, error: EXECUTION_ERRORS.INVALID_UTF8, reason: `"${action.path}" contains invalid UTF-8 sequences`, path: action.path };
      }

      // オリジナルハッシュ（BOM含む生バッファ）
      const originalHash = sha256(rawBuffer);

      // 操作適用
      const opResult = applyOperations(decoded, action.operations);
      if (!opResult.ok) {
        return { ok: false, error: opResult.error, reason: opResult.reason, path: action.path, opIndex: opResult.opIndex };
      }

      // シークレット検出（最終結果全体）
      const secretCheck = detectSecrets(opResult.newContent);
      if (secretCheck.found) {
        return {
          ok: false,
          error: EXECUTION_ERRORS.SECRET_DETECTED,
          reason: `secret pattern "${secretCheck.name}" detected in resulting content of "${action.path}"`,
          path: action.path,
        };
      }

      // 出力バッファ（BOM再付与）
      const newBuffer = hasBOM
        ? Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), Buffer.from(opResult.newContent, 'utf8')])
        : Buffer.from(opResult.newContent, 'utf8');

      totalWriteBytes += newBuffer.length;
      totalAddedLines += opResult.addedLines;
      totalRemovedLines += opResult.removedLines;

      phase1Results.push({
        type: 'edit_file',
        path: action.path,
        absPath,
        originalBuffer: rawBuffer,
        originalHash,
        newBuffer,
        hasBOM,
      });

    } else {
      // create_file
      if (existsSync(absPath)) {
        return { ok: false, error: EXECUTION_ERRORS.FILE_ALREADY_EXISTS, reason: `"${action.path}" already exists`, path: action.path };
      }

      const parentDir = dirname(absPath);
      if (!existsSync(parentDir)) {
        return { ok: false, error: EXECUTION_ERRORS.PARENT_DIR_NOT_FOUND, reason: `parent directory for "${action.path}" does not exist`, path: action.path };
      }

      const secretCheck = detectSecrets(action.content);
      if (secretCheck.found) {
        return {
          ok: false,
          error: EXECUTION_ERRORS.SECRET_DETECTED,
          reason: `secret pattern "${secretCheck.name}" detected in content for "${action.path}"`,
          path: action.path,
        };
      }

      const newBuffer = Buffer.from(action.content, 'utf8');
      totalWriteBytes += newBuffer.length;

      phase1Results.push({
        type: 'create_file',
        path: action.path,
        absPath,
        newBuffer,
      });
    }
  }

  // 合計書き込みバイト数
  if (totalWriteBytes > limits.max_total_write_bytes) {
    return {
      ok: false,
      error: EXECUTION_ERRORS.SIZE_EXCEEDED,
      reason: `total write bytes ${totalWriteBytes} exceeds max_total_write_bytes ${limits.max_total_write_bytes}`,
    };
  }

  // 行数制限
  if (totalAddedLines > limits.max_added_lines) {
    return {
      ok: false,
      error: EXECUTION_ERRORS.SIZE_EXCEEDED,
      reason: `total added lines ${totalAddedLines} exceeds max_added_lines ${limits.max_added_lines}`,
    };
  }
  if (totalRemovedLines > limits.max_removed_lines) {
    return {
      ok: false,
      error: EXECUTION_ERRORS.SIZE_EXCEEDED,
      reason: `total removed lines ${totalRemovedLines} exceeds max_removed_lines ${limits.max_removed_lines}`,
    };
  }

  // ─── dry_run: 書き込みなしで返す ─────────────────────────────────────────
  if (dry_run) {
    return {
      ok: true,
      dry_run: true,
      files_processed: phase1Results.length,
      total_write_bytes: totalWriteBytes,
      added_lines: totalAddedLines,
      removed_lines: totalRemovedLines,
      deferred_action_count: deferredActions.length,
      actions: phase1Results.map(r => ({ type: r.type, path: r.path })),
    };
  }

  // ─── Phase 2: tmpファイル書き込み ────────────────────────────────────────
  const _writeTmp = inj.writeTmpSync
    ? inj.writeTmpSync
    : (tmpPath, buffer) => writeFileSync(tmpPath, buffer);

  const writtenTmps = [];

  for (let i = 0; i < phase1Results.length; i++) {
    const r = phase1Results[i];
    const tmpPath = r.absPath + '.jarvis_tmp';
    try {
      _writeTmp(tmpPath, r.newBuffer);
      writtenTmps.push({
        index: i,
        tmpPath,
        absPath: r.absPath,
        type: r.type,
        originalBuffer: r.originalBuffer ?? null,
        originalHash: r.originalHash ?? null,
      });
    } catch (e) {
      // ロールバック: 書き込み済みtmpを全て削除
      for (const w of writtenTmps) {
        try { unlinkSync(w.tmpPath); } catch {}
      }
      return {
        ok: false,
        error: EXECUTION_ERRORS.WRITE_FAILED,
        reason: `failed to write tmp for "${r.path}": ${e.message}`,
        path: r.path,
        rollback_attempted: false,
        rollback_succeeded: false,
      };
    }
  }

  // ─── Phase 3: ハッシュ再確認 + rename ────────────────────────────────────
  if (typeof inj.onBeforeRename === 'function') {
    inj.onBeforeRename();
  }

  // 全edit_fileターゲットのハッシュ再確認（ANY rename前に全件チェック）
  for (const r of phase1Results) {
    if (r.type !== 'edit_file') continue;
    let currentBuffer;
    try {
      currentBuffer = readFileSync(r.absPath);
    } catch {
      for (const w of writtenTmps) { try { unlinkSync(w.tmpPath); } catch {} }
      return {
        ok: false,
        error: EXECUTION_ERRORS.FILE_CHANGED_DURING,
        reason: `"${r.path}" disappeared between Phase 1 and Phase 3`,
        path: r.path,
        rollback_attempted: true,
        rollback_succeeded: true,
      };
    }
    if (sha256(currentBuffer) !== r.originalHash) {
      for (const w of writtenTmps) { try { unlinkSync(w.tmpPath); } catch {} }
      return {
        ok: false,
        error: EXECUTION_ERRORS.FILE_CHANGED_DURING,
        reason: `"${r.path}" was modified between Phase 1 and Phase 3`,
        path: r.path,
        rollback_attempted: true,
        rollback_succeeded: true,
      };
    }
  }

  // rename実行
  const _rename = inj.renameSync ?? fsRenameSync;
  const renamedSoFar = [];

  for (let i = 0; i < writtenTmps.length; i++) {
    const w = writtenTmps[i];
    const r = phase1Results[i];
    try {
      _rename(w.tmpPath, w.absPath);
      let writtenBuffer;
      try { writtenBuffer = readFileSync(w.absPath); } catch { writtenBuffer = r.newBuffer; }
      renamedSoFar.push({
        absPath: w.absPath,
        type: w.type,
        path: r.path,
        jarvisWrittenHash: sha256(writtenBuffer),
        originalBuffer: w.originalBuffer,
      });
    } catch (e) {
      // rename失敗: 残りtmp削除 + rename済みをロールバック
      for (let j = i; j < writtenTmps.length; j++) {
        try { unlinkSync(writtenTmps[j].tmpPath); } catch {}
      }

      let rollbackSucceeded = true;
      for (const renamed of renamedSoFar) {
        if (!_restoreFile(renamed)) rollbackSucceeded = false;
      }

      return {
        ok: false,
        error: EXECUTION_ERRORS.RENAME_FAILED,
        reason: `rename failed for "${r.path}": ${e.message}`,
        path: r.path,
        rollback_attempted: renamedSoFar.length > 0,
        rollback_succeeded: rollbackSucceeded,
      };
    }
  }

  // ─── 成功: IMPLEMENTING → TESTING ────────────────────────────────────────
  try { updateStatus(taskId, 'TESTING'); } catch {}

  return {
    ok: true,
    dry_run: false,
    files_processed: phase1Results.length,
    total_write_bytes: totalWriteBytes,
    added_lines: totalAddedLines,
    removed_lines: totalRemovedLines,
    deferred_action_count: deferredActions.length,
    actions: phase1Results.map(r => ({ type: r.type, path: r.path })),
  };
}

// ─── ファイル復元 ─────────────────────────────────────────────────────────────
/**
 * rename済みファイルをオリジナルに戻す。
 * 常に実際の fsRenameSync を使用する（注入なし）。
 * edit_file: 元バッファをtmp→renameで書き戻す。
 * create_file: jarvis_written_hashが一致する場合のみ削除。
 */
function _restoreFile(renamed) {
  if (renamed.type === 'create_file') {
    try {
      const current = readFileSync(renamed.absPath);
      if (sha256(current) !== renamed.jarvisWrittenHash) return false; // サードパーティ変更
      unlinkSync(renamed.absPath);
      return true;
    } catch { return false; }
  }

  // edit_file: 元バッファを書き戻す（pre-write hashチェックなし）
  const restoreTmp = renamed.absPath + '.jarvis_restore_tmp';
  try {
    writeFileSync(restoreTmp, renamed.originalBuffer);
    fsRenameSync(restoreTmp, renamed.absPath);
    return true;
  } catch {
    try { unlinkSync(restoreTmp); } catch {}
    return false;
  }
}
