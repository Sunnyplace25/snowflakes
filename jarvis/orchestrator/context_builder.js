/**
 * jarvis/orchestrator/context_builder.js
 * タスク実行前コンテキスト収集（読み取り専用・外部通信なし）
 *
 * 責務：ローカル情報を安全に収集し後続 Planning 処理へ渡すオブジェクトを生成する。
 * 制約：ファイルの書き換え・git操作・外部通信・child_process を行わない。
 */

import { readFileSync, existsSync, lstatSync, realpathSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

import {
  isForbiddenPath,
  isAllowedPath,
  RESULT,
} from './safety_guard.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── デフォルト制限値 ─────────────────────────────────────────────────────────
export const DEFAULT_CONTEXT_LIMITS = Object.freeze({
  max_file_size_bytes:     100_000,  // 1ファイル上限 100KB
  max_total_context_bytes: 500_000,  // 合計上限 500KB（files + diffs + task + commits）
  max_diff_lines:          300,      // safety_guard DEFAULT_LIMITS と統一
});

// ─── secret パターン（最小限・過剰検知回避） ─────────────────────────────────
// 4パターンのみ。既存の通常ファイルには一致しない設計。
const SECRET_PATTERNS = [
  /sk-[A-Za-z0-9]{20,}/,                          // OpenAI API key
  /-----BEGIN [A-Z]+ PRIVATE KEY/,                // PEM 秘密鍵
  /Bearer\s+[A-Za-z0-9._~+/\-]{20,}/,            // Bearer トークン
  /ya29\.[A-Za-z0-9._-]{20,}/,                   // Google OAuth access token
];

/**
 * @param {string} text
 * @returns {boolean}
 */
function containsSecretPattern(text) {
  if (typeof text !== 'string') return false;
  return SECRET_PATTERNS.some(p => p.test(text));
}

// ─── 内部パス正規化 ──────────────────────────────────────────────────────────
// safety_guard.js の normalizeSafe は公開 API でないため、
// context_builder 内部で必要最小限の正規化を実装する。
// denylist/allowlist の定義自体は safety_guard.js に委譲する。

/**
 * rawPath をリポジトリルート相対の forward-slash 形式に正規化する。
 * 不正なパスは例外をスローする。
 *
 * @param {string} rawPath
 * @param {string} repoRootAbs - リポジトリルートの絶対パス
 * @returns {string} repo root 相対の / 区切りパス
 * @throws {Error}
 */
function normalizeRepoRelative(rawPath, repoRootAbs) {
  if (typeof rawPath !== 'string') {
    throw new Error('PATH_INVALID: not a string');
  }
  // .. によるトラバーサル
  if (rawPath.includes('..')) {
    throw new Error(`PATH_TRAVERSAL: "${rawPath}" contains ".."`);
  }
  // 絶対パス（/ or \ で始まる）
  if (/^[/\\]/.test(rawPath)) {
    throw new Error(`PATH_ABSOLUTE: "${rawPath}" is absolute`);
  }
  // Windows ドライブレター
  if (/^[A-Za-z]:[/\\]/.test(rawPath)) {
    throw new Error(`PATH_DRIVE_LETTER: "${rawPath}" has drive letter`);
  }
  // resolve で実パスを計算
  const resolved = resolve(repoRootAbs, rawPath);
  const repoNorm     = repoRootAbs.replace(/\\/g, '/');
  const resolvedNorm = resolved.replace(/\\/g, '/');
  if (!resolvedNorm.startsWith(repoNorm + '/') && resolvedNorm !== repoNorm) {
    throw new Error(`PATH_ESCAPE: "${rawPath}" resolves outside repo root`);
  }
  return resolvedNorm.slice(repoNorm.length + 1);
}

// ─── symlink 安全確認 ────────────────────────────────────────────────────────

/**
 * symlink の実体がリポジトリ内にあり、かつ denylist 対象でないことを確認する。
 *
 * @param {string} absPath       - symlink のリポジトリ内絶対パス
 * @param {string} repoRootAbs   - リポジトリルート絶対パス
 * @returns {{ safe: boolean, realRelPath: string|null, reason: string|null }}
 */
function resolveSymlinkSafe(absPath, repoRootAbs) {
  try {
    const realAbs  = realpathSync(absPath);
    const repoNorm = repoRootAbs.replace(/\\/g, '/');
    const realNorm = realAbs.replace(/\\/g, '/');

    // repo root 外チェック
    if (!realNorm.startsWith(repoNorm + '/') && realNorm !== repoNorm) {
      return { safe: false, realRelPath: null, reason: 'symlink resolves outside repo root' };
    }

    const realRelPath = realNorm.slice(repoNorm.length + 1);

    // 実体の denylist チェック（元パスが allowlist 内でも実体が denylist ならブロック）
    const deny = isForbiddenPath(realRelPath);
    if (deny.denied) {
      return { safe: false, realRelPath, reason: `symlink real path is denylist: ${deny.reason}` };
    }

    return { safe: true, realRelPath, reason: null };
  } catch {
    return { safe: false, realRelPath: null, reason: 'symlink resolution failed' };
  }
}

// ─── バイナリ判定 ────────────────────────────────────────────────────────────

/**
 * Buffer 先頭 8192 バイトに NULL バイトが含まれる場合はバイナリと判定する。
 *
 * @param {Buffer} buf
 * @returns {boolean}
 */
function isBinaryBuffer(buf) {
  const sample = buf.slice(0, 8192);
  for (let i = 0; i < sample.length; i++) {
    if (sample[i] === 0x00) return true;
  }
  return false;
}

// ─── UTF-8 検証 ──────────────────────────────────────────────────────────────
// Node.js 18+ では TextDecoder はグローバル。
const _utf8Decoder = new TextDecoder('utf-8', { fatal: true });

/**
 * Buffer を UTF-8 として安全にデコードする。
 * 失敗した場合は ok: false を返す。
 *
 * @param {Buffer} buf
 * @returns {{ ok: boolean, text: string|null }}
 */
function decodeUtf8Safe(buf) {
  try {
    return { ok: true, text: _utf8Decoder.decode(buf) };
  } catch {
    return { ok: false, text: null };
  }
}

// ─── バイト数計算 ────────────────────────────────────────────────────────────

function byteLen(str) {
  if (!str || typeof str !== 'string') return 0;
  return Buffer.byteLength(str, 'utf8');
}

// ─── diff 処理（制限・secret 対策） ─────────────────────────────────────────

/**
 * diff テキストに secret チェックと行数制限を適用する。
 *
 * @param {string} rawDiff
 * @param {number} maxLines
 * @returns {{ text: string|null, lines: number, truncated: boolean, redacted: boolean }}
 */
function processDiff(rawDiff, maxLines) {
  if (!rawDiff || typeof rawDiff !== 'string') {
    return { text: null, lines: 0, truncated: false, redacted: false };
  }

  // diff 内の secret 検出 → 生値を保持しない
  if (containsSecretPattern(rawDiff)) {
    const allLines = rawDiff.split('\n');
    return { text: null, lines: allLines.length, truncated: false, redacted: true };
  }

  const allLines = rawDiff.split('\n');
  if (allLines.length > maxLines) {
    return {
      text: allLines.slice(0, maxLines).join('\n') + '\n[truncated]',
      lines: allLines.length,
      truncated: true,
      redacted: false,
    };
  }

  return { text: rawDiff, lines: allLines.length, truncated: false, redacted: false };
}

// ─── リスト正規化ヘルパー ─────────────────────────────────────────────────────

function normalizePathList(list, repoRootAbs) {
  if (!Array.isArray(list)) return [];
  return list.reduce((acc, p) => {
    try { acc.push(normalizeRepoRelative(p, repoRootAbs)); } catch { /* skip invalid */ }
    return acc;
  }, []);
}

// ─── メイン公開 API ───────────────────────────────────────────────────────────

/**
 * buildContext(opts) → コンテキストオブジェクト
 *
 * ファイルの書き換え・git操作・外部通信を一切行わない。
 * git 情報は gitSnapshot として外部から注入する。
 *
 * @param {object} opts
 * @param {object}   [opts.task]                        - タスク情報
 * @param {string}   [opts.task.id]
 * @param {string}   [opts.task.title]
 * @param {string}   [opts.task.description]            - ログへ出さない
 * @param {object}   [opts.gitSnapshot]                 - 呼び出し元が git コマンドで収集して注入
 * @param {string}   [opts.repoRoot]                    - リポジトリルート絶対パス（省略時は自動計算）
 * @param {string[]} [opts.target_files]                - 本文を読むファイル（明示指定のみ）
 * @param {string[]} [opts.allowed_files]               - allowlist ファイル
 * @param {string[]} [opts.allowed_dirs]                - allowlist ディレクトリ
 * @param {string[]} [opts.protected_existing_changes]  - 保護対象の既存変更
 * @param {object}   [opts.limits]                      - 上限値（省略時はデフォルト）
 * @returns {object} コンテキストオブジェクト
 */
export function buildContext({
  task = {},
  gitSnapshot = null,
  repoRoot = null,
  target_files = [],
  allowed_files = null,
  allowed_dirs = null,
  protected_existing_changes = null,
  limits = null,
} = {}) {

  const warnings = [];
  let truncated = false;

  // ─ 制限値確定 ─────────────────────────────────────────────────────────────
  const maxFileSize   = limits?.max_file_size_bytes     ?? DEFAULT_CONTEXT_LIMITS.max_file_size_bytes;
  const maxTotalBytes = limits?.max_total_context_bytes ?? DEFAULT_CONTEXT_LIMITS.max_total_context_bytes;
  const maxDiffLines  = limits?.max_diff_lines          ?? DEFAULT_CONTEXT_LIMITS.max_diff_lines;

  // ─ repoRoot 確定 ──────────────────────────────────────────────────────────
  const repoRootAbs = repoRoot
    ? resolve(repoRoot)
    : resolve(__dirname, '..', '..');

  // ─ gitSnapshot 確認 ───────────────────────────────────────────────────────
  const hasGit = gitSnapshot != null && typeof gitSnapshot === 'object' && !Array.isArray(gitSnapshot);
  if (!hasGit) {
    warnings.push('gitSnapshot not provided: repository/status/diffs are incomplete');
  }

  // ─ 合計バイト追跡 ─────────────────────────────────────────────────────────
  let totalBytes = 0;

  function accountBytes(str) {
    if (!str) return;
    totalBytes += byteLen(str);
    if (totalBytes > maxTotalBytes) truncated = true;
  }

  // task 文字列をサイズ計上（description 含む）
  accountBytes(task?.title || '');
  accountBytes(task?.description || '');

  // recent commits
  const recentCommits = hasGit ? (Array.isArray(gitSnapshot.recent_commits) ? gitSnapshot.recent_commits : []) : [];
  for (const c of recentCommits) {
    accountBytes((c?.id || '') + ' ' + (c?.message || ''));
  }

  // ─ repository ─────────────────────────────────────────────────────────────
  // repository.root にローカル絶対パスを含めない
  const repository = {
    root:           '.',
    branch:         hasGit ? (gitSnapshot.branch         || '') : '',
    head_commit:    hasGit ? (gitSnapshot.head_commit     || '') : '',
    recent_commits: recentCommits,
  };

  // ─ status ─────────────────────────────────────────────────────────────────
  // untracked_files はメタ情報として保持するが、本文読み込みはしない
  const status = {
    tracked_modified_files:     hasGit ? (gitSnapshot.tracked_modified_files || []) : [],
    staged_files:               hasGit ? (gitSnapshot.staged_files            || []) : [],
    untracked_files:            hasGit ? (gitSnapshot.untracked_files         || []) : [],
    protected_existing_changes: Array.isArray(protected_existing_changes) ? protected_existing_changes : [],
  };

  // ─ targets（正規化済み） ──────────────────────────────────────────────────
  const targets = {
    allowed_files: normalizePathList(allowed_files, repoRootAbs),
    allowed_dirs:  normalizePathList(allowed_dirs,  repoRootAbs),
  };

  // ─ files ──────────────────────────────────────────────────────────────────
  // target_files に明示されたファイルのみ読む。
  // status.untracked_files に存在するだけのファイルは自動読み込みしない。
  const files = [];

  for (const rawPath of (Array.isArray(target_files) ? target_files : [])) {

    // 合計上限超過後は本文を読まない
    if (truncated) {
      warnings.push('file skipped due to total context limit');
      files.push({
        path: rawPath, exists: null, size_bytes: null,
        text_readable: false, content: null, skipped_reason: 'total_context_limit',
      });
      continue;
    }

    // ─ パス正規化 ─
    let relPath;
    try {
      relPath = normalizeRepoRelative(rawPath, repoRootAbs);
    } catch (e) {
      files.push({
        path: rawPath, exists: null, size_bytes: null,
        text_readable: false, content: null, skipped_reason: e.message,
      });
      continue;
    }

    // ─ denylist チェック（allowlist より優先） ─
    const denyCheck = isForbiddenPath(relPath);
    if (denyCheck.denied) {
      files.push({
        path: relPath, exists: null, size_bytes: null,
        text_readable: false, content: null, skipped_reason: `denylist: ${denyCheck.reason}`,
      });
      continue;
    }

    // ─ allowlist チェック ─
    const allowCheck = isAllowedPath(relPath, { allowed_files, allowed_dirs });
    if (allowCheck.result !== RESULT.ALLOW) {
      files.push({
        path: relPath, exists: null, size_bytes: null,
        text_readable: false, content: null, skipped_reason: `allowlist: ${allowCheck.reason}`,
      });
      continue;
    }

    // ─ ファイル存在確認 ─
    const absPath = resolve(repoRootAbs, relPath);
    if (!existsSync(absPath)) {
      files.push({
        path: relPath, exists: false, size_bytes: null,
        text_readable: false, content: null, skipped_reason: null,
      });
      continue;
    }

    // ─ lstat（symlink を follow しない） ─
    let stat;
    try {
      stat = lstatSync(absPath);
    } catch {
      files.push({
        path: relPath, exists: false, size_bytes: null,
        text_readable: false, content: null, skipped_reason: 'stat_failed',
      });
      continue;
    }

    // ─ symlink 処理 ─
    if (stat.isSymbolicLink()) {
      const symlinkCheck = resolveSymlinkSafe(absPath, repoRootAbs);
      if (!symlinkCheck.safe) {
        warnings.push(`symlink blocked: ${relPath} - ${symlinkCheck.reason}`);
        files.push({
          path: relPath, exists: true, size_bytes: null,
          text_readable: false, content: null, skipped_reason: symlinkCheck.reason,
        });
        continue;
      }
      // symlink 実体の stat を使用
      try {
        stat = lstatSync(realpathSync(absPath));
      } catch {
        files.push({
          path: relPath, exists: true, size_bytes: null,
          text_readable: false, content: null, skipped_reason: 'symlink_stat_failed',
        });
        continue;
      }
    }

    const sizeBytes = stat.size;

    // ─ ファイルサイズ上限 ─
    if (sizeBytes > maxFileSize) {
      truncated = true;
      warnings.push(`file size limit exceeded: ${relPath}`);
      files.push({
        path: relPath, exists: true, size_bytes: sizeBytes,
        text_readable: false, content: null, skipped_reason: 'file_size_limit',
      });
      continue;
    }

    // ─ ファイル読み込み ─
    let buf;
    try {
      buf = readFileSync(absPath);
    } catch {
      files.push({
        path: relPath, exists: true, size_bytes: sizeBytes,
        text_readable: false, content: null, skipped_reason: 'read_failed',
      });
      continue;
    }

    // ─ バイナリ判定（NULL バイト） ─
    if (isBinaryBuffer(buf)) {
      files.push({
        path: relPath, exists: true, size_bytes: sizeBytes,
        text_readable: false, content: null, skipped_reason: 'binary',
      });
      continue;
    }

    // ─ UTF-8 検証 ─
    const decoded = decodeUtf8Safe(buf);
    if (!decoded.ok) {
      files.push({
        path: relPath, exists: true, size_bytes: sizeBytes,
        text_readable: false, content: null, skipped_reason: 'invalid_utf8',
      });
      continue;
    }

    const text = decoded.text;

    // ─ secret 検出（生値を context へ残さない） ─
    if (containsSecretPattern(text)) {
      warnings.push(`secret pattern detected: ${relPath}`);
      files.push({
        path: relPath, exists: true, size_bytes: sizeBytes,
        text_readable: true, content: null, skipped_reason: 'secret_pattern',
      });
      continue;
    }

    // ─ 合計サイズ計上 ─
    const textBytes = byteLen(text);
    if (totalBytes + textBytes > maxTotalBytes) {
      truncated = true;
      warnings.push(`total context limit exceeded, skipping: ${relPath}`);
      files.push({
        path: relPath, exists: true, size_bytes: sizeBytes,
        text_readable: true, content: null, skipped_reason: 'total_context_limit',
      });
      continue;
    }
    accountBytes(text);

    files.push({
      path: relPath, exists: true, size_bytes: sizeBytes,
      text_readable: true, content: text, skipped_reason: null,
    });
  }

  // ─ diffs ──────────────────────────────────────────────────────────────────

  const diffsResult = { working_tree: {}, staged: {} };

  /**
   * gitSnapshot の diff マップを処理して diffsResult へ格納する。
   * denylist・allowlist・secret・truncation を適用する。
   */
  function processDiffMap(diffMap, target) {
    if (!diffMap || typeof diffMap !== 'object') return;

    for (const [rawDiffPath, rawDiff] of Object.entries(diffMap)) {

      // パス正規化
      let relPath;
      try {
        relPath = normalizeRepoRelative(rawDiffPath, repoRootAbs);
      } catch {
        continue; // 不正パスはスキップ
      }

      // denylist
      const denyCheck = isForbiddenPath(relPath);
      if (denyCheck.denied) continue;

      // allowlist（ファイルパスの allowlist をそのまま diff にも適用）
      const allowCheck = isAllowedPath(relPath, { allowed_files, allowed_dirs });
      if (allowCheck.result !== RESULT.ALLOW) continue;

      // diff 処理（secret + 行数制限）
      const processed = processDiff(rawDiff, maxDiffLines);

      if (processed.redacted) {
        // secret の実値はログ・warning へ含めない
        warnings.push(`secret pattern detected in diff: ${relPath}`);
      }

      // 合計サイズ計上
      if (!truncated && processed.text) {
        const diffBytes = byteLen(processed.text);
        if (totalBytes + diffBytes > maxTotalBytes) {
          truncated = true;
          warnings.push(`total context limit exceeded, diff truncated: ${relPath}`);
          target[relPath] = { text: null, lines: processed.lines, truncated: true, redacted: false };
          continue;
        }
        accountBytes(processed.text);
      }

      target[relPath] = processed;
    }
  }

  if (hasGit) {
    processDiffMap(gitSnapshot.diffs?.working_tree, diffsResult.working_tree);
    processDiffMap(gitSnapshot.diffs?.staged,       diffsResult.staged);
  }

  // ─ 出力 ──────────────────────────────────────────────────────────────────
  return {
    task: {
      id:          task?.id          || '',
      title:       task?.title       || '',
      description: task?.description || '',
    },
    repository,
    status,
    targets,
    files,
    diffs: diffsResult,
    limits: {
      max_file_size_bytes:     maxFileSize,
      max_total_context_bytes: maxTotalBytes,
      max_diff_lines:          maxDiffLines,
    },
    meta: {
      created_at: new Date().toISOString(),
      truncated,
      warnings,
    },
  };
}
