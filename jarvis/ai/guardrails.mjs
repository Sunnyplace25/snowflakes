/**
 * jarvis/ai/guardrails.mjs
 * 実行前後の安全確認・ガードレール
 *
 * - ブランチ強制: jarvis-development のみ許可
 * - ベースライン記録: 処理開始前の git 状態を記録
 * - 違反検出: 今回の処理で新たに変更された保護ファイルのみを検出
 *   (ベースライン時点で既に untracked だったファイルはエラーにしない)
 */

import { execSync } from 'node:child_process';

export const ALLOWED_BRANCH = 'jarvis-development';

export const DEFAULT_PROTECTED_PATTERNS = [
  'jarvis/data/business_data.db',
  'jarvis/data/business_data.db-shm',
  'jarvis/data/business_data.db-wal',
  'jarvis/backups/',
  'jarvis/imports/',
  'music/',
  'sweets/',
];

export const VIOLATION_TYPES = {
  MAIN_BRANCH_CHANGE:    'MAIN_BRANCH_CHANGE',
  REAL_DB_WRITE:         'REAL_DB_WRITE',
  PROTECTED_FILE_CHANGE: 'PROTECTED_FILE_CHANGE',
  EXTERNAL_PUBLISH:      'EXTERNAL_PUBLISH',
  DESTRUCTIVE_OPERATION: 'DESTRUCTIVE_OPERATION',
  SECRET_EXPOSURE:       'SECRET_EXPOSURE',
};

function makeDefaultExecGit(cwd) {
  return (cmd) => {
    try {
      return execSync(cmd, {
        encoding: 'utf8',
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch {
      return '';
    }
  };
}

/**
 * ガードレールを生成する。
 *
 * @param {{
 *   execGit?:           Function,   // (cmd: string) => string  テスト用インジェクション
 *   protectedPatterns?: string[],
 *   cwd?:               string,
 * }} options
 */
export function createGuardrails({
  execGit           = null,
  protectedPatterns = DEFAULT_PROTECTED_PATTERNS,
  cwd               = process.cwd(),
} = {}) {
  const _exec = execGit ?? makeDefaultExecGit(cwd);

  /** jarvis-development にいることを確認する。違反なら throw。 */
  function checkBranch() {
    const branch = _exec('git branch --show-current');
    if (branch !== ALLOWED_BRANCH) {
      throw new Error(
        `GUARDRAIL: branch "${branch}" は許可されていません。"${ALLOWED_BRANCH}" にいる必要があります。`
      );
    }
    return branch;
  }

  /** 現在の git 状態をベースラインとして記録する。 */
  function recordBaseline() {
    return {
      branch:    _exec('git branch --show-current'),
      status:    _exec('git status --porcelain').split('\n').filter(Boolean),
      staged:    _exec('git diff --cached --name-only').split('\n').filter(Boolean),
      unstaged:  _exec('git diff --name-only').split('\n').filter(Boolean),
      timestamp: Date.now(),
    };
  }

  /** ファイルパスが保護対象かどうか判定する。 */
  function isProtected(filePath) {
    return protectedPatterns.some(p => {
      if (p.endsWith('/')) return filePath === p.slice(0, -1) || filePath.startsWith(p);
      return filePath === p || filePath.startsWith(p + '/');
    });
  }

  /**
   * ベースライン以降に新たに変更されたファイルを確認し、
   * 保護ファイルへの変更があれば違反として返す。
   *
   * @param {{ status: string[] }} baseline - recordBaseline() の戻り値
   * @returns {Array<{ type: string, detail: string }>}
   */
  function checkViolations(baseline) {
    const violations = [];

    // ブランチ変更チェック
    const currentBranch = _exec('git branch --show-current');
    if (currentBranch !== ALLOWED_BRANCH) {
      violations.push({
        type:   VIOLATION_TYPES.MAIN_BRANCH_CHANGE,
        detail: `Branch changed to "${currentBranch}"`,
      });
    }

    // ベースライン以降の新規変更ファイルをチェック
    const currentStatus = _exec('git status --porcelain').split('\n').filter(Boolean);
    const baselineSet   = new Set(baseline.status);

    for (const line of currentStatus) {
      if (baselineSet.has(line)) continue; // ベースライン時点で既存 → スキップ
      const filePath = line.slice(3).trim();
      if (isProtected(filePath)) {
        violations.push({
          type:   VIOLATION_TYPES.PROTECTED_FILE_CHANGE,
          detail: `Protected file changed: ${filePath}`,
        });
      }
    }

    return violations;
  }

  return { checkBranch, recordBaseline, checkViolations, isProtected };
}
