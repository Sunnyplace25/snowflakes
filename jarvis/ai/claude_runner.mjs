/**
 * jarvis/ai/claude_runner.mjs
 * Claude Code CLI を child_process から非対話で実行する。
 *
 * - Windows 環境: claude.exe / claude.cmd / claude を安全に探索
 * - 出力形式: --output-format json → { result, session_id }
 * - セッション再利用: --resume <session_id> で継続
 * - テスト用: options.spawnFn でモック注入可能
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
  const args       = [];

  if (sessionId) args.push('--resume', sessionId);
  args.push('-p', prompt, '--output-format', 'json');

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
