/**
 * jarvis/ai/claude_runner.mjs
 * Claude Code CLI を child_process から非対話で実行する。
 *
 * - Windows 環境: claude.exe / claude.cmd / claude を安全に探索
 * - 出力形式: --output-format json → { result, session_id }
 * - セッション再利用: --resume <session_id> で継続
 * - テスト用: options.spawnFn でモック注入可能
 *
 * Permission mode:
 * - --allowed-tools で安全な操作のみ自動許可
 * - git commit / push / add / checkout / switch は許可リストに含めない
 * - dangerously-skip-permissions / bypassPermissions は使用禁止
 */

import { execFileSync, execFile, execSync } from 'node:child_process';
import { existsSync }             from 'node:fs';
import { promisify }              from 'node:util';

const execFileAsync = promisify(execFile);

// 探索候補（優先順）
const CLAUDE_CANDIDATES = [
  'claude',
  'claude.cmd',
  process.env.LOCALAPPDATA
    ? `${process.env.LOCALAPPDATA}\\Microsoft\\WinGet\\Packages\\Anthropic.ClaudeCode_Microsoft.Winget.Source_8wekyb3d8bbwe\\claude.exe`
    : null,
].filter(Boolean);

let _cachedClaudePath = null;

/**
 * 自動許可するツール・コマンドの一覧。
 * ここに含まれない操作は Claude Code が実行前に確認プロンプトを出す。
 *
 * 許可対象:
 *   - ファイル読み取り・編集・新規作成（Read / Edit / Write / Glob / Grep）
 *   - 読み取り専用 git 操作（status / diff / log / branch 参照）
 *   - node によるテスト実行
 *
 * 不許可（リストに含めない）:
 *   - git commit / git push / git add / git checkout / git switch
 *   - ブランチ削除 / ファイル削除 / 実 DB 変更 / 外部公開
 */
export const SAFE_ALLOWED_TOOLS = [
  // ファイル操作（読み取り・編集・作成）
  'Read', 'Edit', 'Write', 'Glob', 'Grep',
  // 読み取り専用 git 操作
  'Bash(git status)',
  'Bash(git diff)',
  'Bash(git diff --stat)',
  'Bash(git diff*)',
  'Bash(git log*)',
  'Bash(git branch --show-current)',
  'Bash(git branch)',
  'Bash(git show*)',
  'Bash(git rev-parse*)',
  // テスト実行
  'Bash(node*)',
].join(',');

/**
 * 利用可能な Claude CLI パスを返す。見つからなければ throw。
 * @returns {string}
 */
export function findClaudeCli() {
  if (_cachedClaudePath) return _cachedClaudePath;

  for (const candidate of CLAUDE_CANDIDATES) {
    // 絶対パス（\含む）は existsSync で確認
    if (candidate.includes('\\') || candidate.startsWith('/')) {
      if (existsSync(candidate)) {
        _cachedClaudePath = candidate;
        return candidate;
      }
      continue;
    }
    // コマンド名: --version で存在確認（失敗 = 未インストール）
    // shell: true 時は args 配列ではなくコマンド文字列で呼ぶ（DeprecationWarning 回避）
    try {
      if (process.platform === 'win32') {
        execSync(`${candidate} --version`, { encoding: 'utf8', stdio: 'pipe', timeout: 5_000 });
      } else {
        execFileSync(candidate, ['--version'], { encoding: 'utf8', stdio: 'pipe', timeout: 5_000 });
      }
      _cachedClaudePath = candidate;
      return candidate;
    } catch {
      // 次の候補へ
    }
  }

  throw new Error(
    'Claude CLI が見つかりません。インストールして PATH に追加してください。\n' +
    '  https://claude.ai/code'
  );
}

/** テスト用にキャッシュをリセットする */
export function resetClaudePathCache() {
  _cachedClaudePath = null;
}

/**
 * Claude CLI 実行引数を組み立てる。
 * テストから直接呼び出し可能。
 *
 * @param {string} prompt
 * @param {{ sessionId?: string|null }} options
 * @returns {string[]}
 */
export function buildClaudeArgs(prompt, { sessionId = null } = {}) {
  const args = [];
  if (sessionId) args.push('--resume', sessionId);
  args.push('-p', prompt, '--output-format', 'json');
  args.push('--allowed-tools', SAFE_ALLOWED_TOOLS);
  return args;
}

/**
 * Claude CLI を実行し、結果を返す。
 *
 * @param {string} prompt
 * @param {{
 *   sessionId?: string|null,
 *   cwd?:       string,
 *   timeout?:   number,
 *   spawnFn?:   (prompt: string, opts: object) => Promise<{ result: string, session_id: string|null }>,
 * }} options
 * @returns {Promise<{ result: string, session_id: string|null }>}
 */
export async function runClaude(prompt, {
  sessionId = null,
  cwd       = process.cwd(),
  timeout   = 180_000,
  spawnFn   = null,
} = {}) {
  // テスト用インジェクション
  if (spawnFn) return await spawnFn(prompt, { sessionId });

  const claudePath = findClaudeCli();
  const args       = buildClaudeArgs(prompt, { sessionId });

  // .cmd ファイルは Windows でシェル経由が必要
  const useShell = process.platform === 'win32' && claudePath.endsWith('.cmd');

  let stdout;
  try {
    ({ stdout } = await execFileAsync(claudePath, args, {
      cwd,
      timeout,
      encoding:  'utf8',
      maxBuffer: 10 * 1024 * 1024, // 10 MB
      shell:     useShell,
    }));
  } catch (e) {
    throw new Error(`Claude CLI 実行エラー: ${e.message}`);
  }

  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw new Error(`Claude 出力の JSON パース失敗: ${stdout.slice(0, 300)}`);
  }

  if (parsed.is_error) {
    throw new Error(`Claude エラー: ${parsed.result ?? '(no message)'}`);
  }

  return {
    result:     parsed.result     ?? '',
    session_id: parsed.session_id ?? null,
  };
}
