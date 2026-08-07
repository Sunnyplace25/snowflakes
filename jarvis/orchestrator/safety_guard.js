/**
 * jarvis/orchestrator/safety_guard.js
 * JARVISの決定的安全ルール（外部通信なし・git操作なし）
 *
 * AIの判断よりこのモジュールの判定を常に優先する。
 */

import { createHash } from 'crypto';
import { resolve, dirname, normalize } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// リポジトリルート（jarvis/ の親 = snowflakes/）
const REPO_ROOT = resolve(__dirname, '..', '..');

// ─── 判定結果定数 ─────────────────────────────────────────────────────────────
export const RESULT = Object.freeze({
  ALLOW:                   'ALLOW',
  BLOCK:                   'BLOCK',
  HUMAN_APPROVAL_REQUIRED: 'HUMAN_APPROVAL_REQUIRED',
});

// ─── デフォルト上限値 ─────────────────────────────────────────────────────────
export const DEFAULT_LIMITS = Object.freeze({
  max_changed_files:  5,
  max_diff_lines:     300,
  max_diff_size_bytes: 50000,
  max_iterations:     1,
  max_claude_runs:    2,
  max_openai_calls:   3,
});

// ─── 恒久 denylist ────────────────────────────────────────────────────────────
// パス前方一致（正規化後）または拡張子・ファイル名の完全一致
const DENY_PATH_PREFIXES = [
  '.git/',
  'jarvis/secrets/',
  'music/',
  'sweets/',
];

const DENY_EXTENSIONS = new Set(['.mp3', '.wav', '.pem', '.key']);

const DENY_FILENAMES = new Set([
  'oauth_credentials.json',
  'youtube_token.json',
  'openai_api_key',
]);

// ─── 人間承認必須キーワード ───────────────────────────────────────────────────
// 各エントリ: { pattern: RegExp, reason: string }
//
// 誤検知を抑えるため「コマンド・API操作として明示されたコンテキスト」に
// 絞ったパターンを使用する。
// 例: 説明文中の "git commit" がコマンドとして要求された形でなければスルー。
//
// ここでは「要求されたアクション文字列」に対してマッチする設計とし、
// 呼び出し元は「AIが出力した次に実行するコマンド/操作」を渡す前提とする。
const APPROVAL_PATTERNS = [
  // git 操作
  { pattern: /\bgit\s+add\b/i,                   reason: 'git add' },
  { pattern: /\bgit\s+commit\b/i,                reason: 'git commit' },
  { pattern: /\bgit\s+push\b/i,                  reason: 'git push' },
  { pattern: /\bgit\s+merge\b/i,                 reason: 'git merge' },
  { pattern: /\bgit\s+reset\s+--hard\b/i,        reason: 'git reset --hard' },
  { pattern: /\bgit\s+branch\s+-[Dd]\b/i,        reason: 'branch削除' },
  // npm 操作
  { pattern: /\bnpm\s+install\b/i,               reason: 'npm install' },
  { pattern: /\bnpm\s+uninstall\b/i,             reason: 'npm uninstall' },
  { pattern: /\bnpm\s+update\b/i,                reason: 'npm update' },
  // 認証・外部連携
  { pattern: /\bOAuth\b/i,                       reason: 'OAuth' },
  { pattern: /\bAPIキー(?:作成|変更|生成|更新)\b/i, reason: 'APIキー操作' },
  { pattern: /\bAPI\s*key\s*(?:create|change|generate|update)\b/i, reason: 'APIキー操作' },
  { pattern: /\b外部サービス\s*(?:ログイン|認証|接続)\b/i, reason: '外部サービスログイン' },
  { pattern: /\bexternal\s*(?:login|auth)\b/i,  reason: '外部サービスログイン' },
  // 投稿・公開操作
  { pattern: /\bSNS\s*投稿\b/i,                 reason: 'SNS投稿' },
  { pattern: /\bYouTube\s*(?:アップロード|upload)\b/i, reason: 'YouTubeアップロード' },
  { pattern: /\bTikTok\s*(?:アップロード|upload)\b/i,  reason: 'TikTokアップロード' },
  { pattern: /\b外部公開\b/i,                    reason: '外部公開' },
  // 課金・本番・大量削除
  { pattern: /\b課金\s*操作\b/i,                 reason: '課金操作' },
  { pattern: /\b大量\s*削除\b/i,                 reason: '大量削除' },
  { pattern: /\b本番\s*環境\s*変更\b/i,          reason: '本番環境変更' },
];

// ─── パス正規化・安全検証ユーティリティ ──────────────────────────────────────

/**
 * Windowsドライブレター形式の検出
 * 例: C:\, D:/, c:\
 */
function hasDriveLetter(p) {
  return /^[A-Za-z]:[/\\]/.test(p);
}

/**
 * パスを正規化してリポジトリルート相対の forward-slash 形式にする。
 * 不正なパスは例外をスローする。
 *
 * @param {string} p - 検証対象パス
 * @returns {string} repo root 相対の / 区切りパス（例: "jarvis/tools/foo.js"）
 * @throws {Error} 不正なパスの場合
 */
function normalizeSafe(p) {
  if (typeof p !== 'string') throw new Error('PATH_INVALID: not a string');

  // 大文字小文字を小文字に統一（Windows回避）
  const lower = p.toLowerCase();

  // .. によるトラバーサル（正規化前チェック）
  if (lower.includes('..')) {
    throw new Error(`PATH_TRAVERSAL: "${p}" contains ".."`);
  }
  // ..\ / ../ （念のため両方向）
  if (p.includes('..\\') || p.includes('../')) {
    throw new Error(`PATH_TRAVERSAL: "${p}" contains traversal sequence`);
  }

  // 絶対パス拒否（/ or \ で始まる）
  if (/^[/\\]/.test(p)) {
    throw new Error(`PATH_ABSOLUTE: "${p}" is absolute`);
  }

  // Windowsドライブレター拒否
  if (hasDriveLetter(p)) {
    throw new Error(`PATH_DRIVE_LETTER: "${p}" has drive letter`);
  }

  // resolve で実パスを計算し、REPO_ROOT 外に出ていないか確認
  const resolved = resolve(REPO_ROOT, p);
  const repoNorm = REPO_ROOT.replace(/\\/g, '/');
  const resolvedNorm = resolved.replace(/\\/g, '/');

  if (!resolvedNorm.startsWith(repoNorm + '/') && resolvedNorm !== repoNorm) {
    throw new Error(`PATH_ESCAPE: "${p}" resolves outside repo root`);
  }

  // repo root からの相対パスを forward-slash 形式で返す
  const rel = resolvedNorm.slice(repoNorm.length + 1);
  return rel;
}

// ─── denylist チェック ────────────────────────────────────────────────────────

/**
 * ファイルパスが恒久 denylist に該当するか判定する。
 *
 * @param {string} normalizedRelPath - normalizeSafe() 済みの相対パス
 * @returns {{ denied: boolean, reason: string|null }}
 */
export function isForbiddenPath(normalizedRelPath) {
  const p = normalizedRelPath.toLowerCase().replace(/\\/g, '/');

  // パスプレフィックス一致
  for (const prefix of DENY_PATH_PREFIXES) {
    if (p === prefix.replace(/\/$/, '') || p.startsWith(prefix)) {
      return { denied: true, reason: `denylist prefix: ${prefix}` };
    }
  }

  // 拡張子
  const dotIdx = p.lastIndexOf('.');
  if (dotIdx !== -1) {
    const ext = p.slice(dotIdx);
    if (DENY_EXTENSIONS.has(ext)) {
      return { denied: true, reason: `denylist extension: ${ext}` };
    }
  }

  // ファイル名（パスの最後のセグメント）
  const slashIdx = p.lastIndexOf('/');
  const filename = slashIdx !== -1 ? p.slice(slashIdx + 1) : p;
  if (DENY_FILENAMES.has(filename)) {
    return { denied: true, reason: `denylist filename: ${filename}` };
  }

  return { denied: false, reason: null };
}

// ─── allowlist チェック ───────────────────────────────────────────────────────

/**
 * ファイルパスがタスクの allowlist に含まれるか判定する。
 * allowed_files / allowed_dirs が未設定の場合は ALLOW を返す。
 *
 * @param {string} rawPath - 未正規化パス
 * @param {{ allowed_files?: string[], allowed_dirs?: string[] }} opts
 * @returns {{ result: string, reason: string }}
 */
export function isAllowedPath(rawPath, { allowed_files = null, allowed_dirs = null } = {}) {
  let normalized;
  try {
    normalized = normalizeSafe(rawPath);
  } catch (e) {
    return { result: RESULT.BLOCK, reason: e.message };
  }

  // denylist は allowlist より優先
  const deny = isForbiddenPath(normalized);
  if (deny.denied) {
    return { result: RESULT.BLOCK, reason: deny.reason };
  }

  // allowlist が未設定ならパス自体は ALLOW
  if (!allowed_files && !allowed_dirs) {
    return { result: RESULT.ALLOW, reason: 'no allowlist restriction' };
  }

  // allowed_files: 完全一致
  if (allowed_files && allowed_files.length > 0) {
    for (const af of allowed_files) {
      let afNorm;
      try { afNorm = normalizeSafe(af); } catch { continue; }
      if (afNorm.toLowerCase() === normalized.toLowerCase()) {
        return { result: RESULT.ALLOW, reason: `allowed_files match: ${afNorm}` };
      }
    }
  }

  // allowed_dirs: プレフィックス一致
  if (allowed_dirs && allowed_dirs.length > 0) {
    for (const ad of allowed_dirs) {
      let adNorm;
      try { adNorm = normalizeSafe(ad); } catch { continue; }
      const prefix = adNorm.toLowerCase().replace(/\/?$/, '/');
      const target = normalized.toLowerCase();
      if (target.startsWith(prefix)) {
        return { result: RESULT.ALLOW, reason: `allowed_dirs match: ${adNorm}` };
      }
    }
  }

  return { result: RESULT.BLOCK, reason: 'not in allowed_files or allowed_dirs' };
}

// ─── 変更ファイル一覧検証 ────────────────────────────────────────────────────

/**
 * 変更ファイル一覧をまとめて検証する。
 *
 * @param {string[]} changedFiles - 変更されたファイルパス一覧
 * @param {object} opts
 * @param {string[]} [opts.allowed_files]
 * @param {string[]} [opts.allowed_dirs]
 * @param {number}   [opts.max_changed_files]
 * @returns {{ result: string, reason: string, blocked_files?: string[] }}
 */
export function validateChangedFiles(changedFiles, {
  allowed_files = null,
  allowed_dirs = null,
  max_changed_files = DEFAULT_LIMITS.max_changed_files,
} = {}) {
  if (!Array.isArray(changedFiles)) {
    return { result: RESULT.BLOCK, reason: 'changedFiles must be an array' };
  }

  // ファイル数上限
  if (changedFiles.length > max_changed_files) {
    return {
      result: RESULT.HUMAN_APPROVAL_REQUIRED,
      reason: `changed_files ${changedFiles.length} exceeds max_changed_files ${max_changed_files}`,
    };
  }

  const blocked = [];
  for (const f of changedFiles) {
    const check = isAllowedPath(f, { allowed_files, allowed_dirs });
    if (check.result !== RESULT.ALLOW) {
      blocked.push(`${f}: ${check.reason}`);
    }
  }

  if (blocked.length > 0) {
    return {
      result: RESULT.BLOCK,
      reason: `blocked paths detected`,
      blocked_files: blocked,
    };
  }

  return { result: RESULT.ALLOW, reason: 'all files allowed' };
}

// ─── diff サイズ検証 ──────────────────────────────────────────────────────────

/**
 * diff のサイズ（行数・バイト数）を検証する。
 *
 * @param {{ lines?: number, bytes?: number }} diff
 * @param {{ max_diff_lines?: number, max_diff_size_bytes?: number }} opts
 * @returns {{ result: string, reason: string }}
 */
export function validateDiffSize(diff, {
  max_diff_lines = DEFAULT_LIMITS.max_diff_lines,
  max_diff_size_bytes = DEFAULT_LIMITS.max_diff_size_bytes,
} = {}) {
  if (!diff || typeof diff !== 'object') {
    return { result: RESULT.BLOCK, reason: 'diff must be an object' };
  }

  if (typeof diff.lines === 'number' && diff.lines > max_diff_lines) {
    return {
      result: RESULT.HUMAN_APPROVAL_REQUIRED,
      reason: `diff lines ${diff.lines} exceeds max_diff_lines ${max_diff_lines}`,
    };
  }

  if (typeof diff.bytes === 'number' && diff.bytes > max_diff_size_bytes) {
    return {
      result: RESULT.HUMAN_APPROVAL_REQUIRED,
      reason: `diff bytes ${diff.bytes} exceeds max_diff_size_bytes ${max_diff_size_bytes}`,
    };
  }

  return { result: RESULT.ALLOW, reason: 'diff size within limits' };
}

// ─── 反復上限検証 ─────────────────────────────────────────────────────────────

/**
 * 反復回数・実行回数が上限を超えていないか検証する。
 *
 * @param {{ iterations?: number, claude_runs?: number, openai_calls?: number }} counters
 * @param {{ max_iterations?: number, max_claude_runs?: number, max_openai_calls?: number }} limits
 * @returns {{ result: string, reason: string }}
 */
export function validateIterationLimits(counters, limits = {}) {
  const maxIter     = limits.max_iterations   ?? DEFAULT_LIMITS.max_iterations;
  const maxClaude   = limits.max_claude_runs  ?? DEFAULT_LIMITS.max_claude_runs;
  const maxOpenAI   = limits.max_openai_calls ?? DEFAULT_LIMITS.max_openai_calls;

  if (typeof counters.iterations === 'number' && counters.iterations >= maxIter) {
    return {
      result: RESULT.BLOCK,
      reason: `iterations ${counters.iterations} reached max_iterations ${maxIter}`,
    };
  }
  if (typeof counters.claude_runs === 'number' && counters.claude_runs >= maxClaude) {
    return {
      result: RESULT.BLOCK,
      reason: `claude_runs ${counters.claude_runs} reached max_claude_runs ${maxClaude}`,
    };
  }
  if (typeof counters.openai_calls === 'number' && counters.openai_calls >= maxOpenAI) {
    return {
      result: RESULT.BLOCK,
      reason: `openai_calls ${counters.openai_calls} reached max_openai_calls ${maxOpenAI}`,
    };
  }

  return { result: RESULT.ALLOW, reason: 'iteration limits OK' };
}

// ─── 同一エラーループ検出 ────────────────────────────────────────────────────

/**
 * エラーの normalized signature を生成する。
 * エラーメッセージの全文は保存せず SHA-256 の先頭16文字で識別する。
 *
 * @param {string} errorMessage
 * @returns {string} 16文字のHEXシグネチャ
 */
export function buildErrorSignature(errorMessage) {
  if (typeof errorMessage !== 'string') {
    errorMessage = String(errorMessage);
  }
  // 正規化: 小文字化・数値をプレースホルダに置換・空白を折り畳む
  const normalized = errorMessage
    .toLowerCase()
    .replace(/\b\d+\b/g, 'N')           // 数値 → N
    .replace(/['"]/g, '')               // クォート除去
    .replace(/\s+/g, ' ')              // 空白折り畳み
    .trim();

  return createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 16);
}

/**
 * 同一エラーシグネチャが連続2回出た場合に BLOCK を返す。
 *
 * @param {string} currentSignature   - 今回のエラーシグネチャ
 * @param {string|null} previousSignature - 直前のエラーシグネチャ
 * @returns {{ result: string, reason: string }}
 */
export function detectErrorLoop(currentSignature, previousSignature) {
  if (
    typeof currentSignature === 'string' &&
    currentSignature.length > 0 &&
    currentSignature === previousSignature
  ) {
    return {
      result: RESULT.BLOCK,
      reason: `same error signature repeated twice: ${currentSignature}`,
    };
  }
  return { result: RESULT.ALLOW, reason: 'no error loop detected' };
}

// ─── 保護ファイル変更検出 ────────────────────────────────────────────────────

/**
 * 現在の変更ファイル一覧と、タスク開始時のスナップショット（未追跡ファイル一覧）
 * を比較して、開始前から存在した未追跡ファイルが変更されていないか確認する。
 *
 * @param {string[]} changedFiles        - 現在変更されているファイル
 * @param {string[]} untrackedSnapshot   - タスク開始時点の未追跡ファイル一覧
 * @returns {{ result: string, reason: string, violated?: string[] }}
 */
export function detectProtectedFileChanges(changedFiles, untrackedSnapshot) {
  if (!Array.isArray(changedFiles) || !Array.isArray(untrackedSnapshot)) {
    return { result: RESULT.BLOCK, reason: 'invalid arguments' };
  }

  const snapshotSet = new Set(untrackedSnapshot.map(f => f.toLowerCase().replace(/\\/g, '/')));
  const violated = changedFiles.filter(f => snapshotSet.has(f.toLowerCase().replace(/\\/g, '/')));

  if (violated.length > 0) {
    return {
      result: RESULT.BLOCK,
      reason: `previously-untracked files were modified`,
      violated,
    };
  }
  return { result: RESULT.ALLOW, reason: 'no protected file changes detected' };
}

// ─── タスク開始検証（dirty tree 含む） ───────────────────────────────────────

/**
 * タスク開始前の作業ツリー状態を検証する。
 *
 * @param {object} opts
 * @param {string[]} opts.trackedModifiedFiles        - tracked かつ変更済みのファイル一覧
 * @param {string[]} [opts.protected_existing_changes] - 開始前から存在する例外的変更（保護対象）
 * @param {string[]} [opts.untrackedFiles]            - 未追跡ファイル一覧（スナップショット用）
 * @returns {{ result: string, reason: string, untracked_snapshot?: string[] }}
 */
export function validateTaskStart({
  trackedModifiedFiles = [],
  protected_existing_changes = [],
  untrackedFiles = [],
} = {}) {
  if (!Array.isArray(trackedModifiedFiles)) {
    return { result: RESULT.BLOCK, reason: 'trackedModifiedFiles must be an array' };
  }

  const protectedSet = new Set(
    protected_existing_changes.map(f => f.toLowerCase().replace(/\\/g, '/'))
  );

  // protected 以外に tracked modified ファイルがある場合は BLOCK
  const dirty = trackedModifiedFiles.filter(
    f => !protectedSet.has(f.toLowerCase().replace(/\\/g, '/'))
  );

  if (dirty.length > 0) {
    return {
      result: RESULT.BLOCK,
      reason: `dirty work tree: tracked modified files exist outside protected_existing_changes`,
    };
  }

  return {
    result: RESULT.ALLOW,
    reason: 'work tree is clean for task start',
    untracked_snapshot: [...untrackedFiles],
  };
}

// ─── 人間承認必須アクション検出 ──────────────────────────────────────────────

/**
 * AIが要求した操作文字列に人間承認必須のパターンが含まれるか検出する。
 * 説明文脈ではなく「実行しようとするコマンド・操作名」を渡す前提。
 *
 * @param {string} actionString - AIが「次に実行する」として出力した文字列
 * @returns {{ result: string, reason: string, matched?: string }}
 */
export function detectApprovalRequired(actionString) {
  if (typeof actionString !== 'string' || actionString.trim() === '') {
    return { result: RESULT.ALLOW, reason: 'empty action string' };
  }

  for (const { pattern, reason } of APPROVAL_PATTERNS) {
    if (pattern.test(actionString)) {
      return {
        result: RESULT.HUMAN_APPROVAL_REQUIRED,
        reason: `human approval required: ${reason}`,
        matched: reason,
      };
    }
  }

  return { result: RESULT.ALLOW, reason: 'no approval-required pattern matched' };
}

// ─── テスト用内部エクスポート ─────────────────────────────────────────────────
export {
  DENY_PATH_PREFIXES,
  DENY_EXTENSIONS,
  DENY_FILENAMES,
  APPROVAL_PATTERNS,
  REPO_ROOT,
  normalizeSafe,
};
