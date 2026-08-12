/**
 * jarvis/ai/approval_gate.mjs
 * ユーザー承認ゲート — commit / push / 特殊操作の確認。
 *
 * - 対話環境 (TTY) ではターミナルで y/N を確認
 * - 非対話環境では pending_approval.json に保存して停止
 * - 次回起動時に未処理承認があれば先に表示
 */

import { createInterface }                        from 'node:readline';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { resolve, dirname }                        from 'node:path';
import { fileURLToPath }                           from 'node:url';

const __dirname    = dirname(fileURLToPath(import.meta.url));
const RUNTIME_DIR  = resolve(__dirname, 'runtime');
const PENDING_FILE = resolve(RUNTIME_DIR, 'pending_approval.json');

// ── Runtime ファイル I/O ──────────────────────────────────────────────────────

export function savePendingApproval(data) {
  writeFileSync(
    PENDING_FILE,
    JSON.stringify({ ...data, savedAt: new Date().toISOString() }, null, 2),
    'utf8',
  );
}

export function loadPendingApproval() {
  if (!existsSync(PENDING_FILE)) return null;
  try {
    const raw = readFileSync(PENDING_FILE, 'utf8').trim();
    if (!raw || raw === 'null' || raw === '{}') return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export function clearPendingApproval() {
  writeFileSync(PENDING_FILE, 'null', 'utf8');
}

// ── 対話プロンプト (readline) ─────────────────────────────────────────────────

function promptLine(question) {
  return new Promise(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, answer => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ── 承認ゲート factory ────────────────────────────────────────────────────────

/**
 * @param {{
 *   isTTY?:    boolean,   // 省略時は process.stdout.isTTY
 *   promptFn?: Function,  // テスト用インジェクション (question: string) => Promise<string>
 * }} options
 */
export function createApprovalGate({
  isTTY    = null,
  promptFn = null,
} = {}) {
  const isInteractive = isTTY ?? (process.stdout.isTTY === true);
  const ask           = promptFn ?? promptLine;

  /** 非対話の場合は null を返す（呼び元が pending 保存処理を行う） */
  async function _ask(question) {
    if (!isInteractive && !promptFn) return null;
    return await ask(question);
  }

  // ── COMMIT APPROVAL ────────────────────────────────────────────────────────

  async function promptCommit({ task, review, testResult, files, commitMessage }) {
    const testSummary = `${testResult?.passed ?? '?'} passed / ${testResult?.failed ?? '?'} failed`;
    const fileList    = (files ?? []).map(f => `  ・${f}`).join('\n') || '  (none)';

    console.log(`\n${'='.repeat(64)}`);
    console.log('COMMIT APPROVAL REQUIRED');
    console.log('='.repeat(64));
    console.log(`\nTask:\n${task}\n`);
    console.log(`OpenAI review:\nAPPROVED  — ${review?.summary ?? ''}\n`);
    console.log(`Tests:\n${testSummary}\n`);
    console.log(`Files:\n${fileList}\n`);
    console.log(`Commit message:\n${commitMessage}\n`);

    const answer = await _ask('Commitしてよいですか？ [y/N]: ');

    if (answer === null) {
      savePendingApproval({ type: 'COMMIT_APPROVAL', task, review, testResult, files, commitMessage });
      console.log('\n承認待ちを pending_approval.json に保存しました。次回起動時に再開します。');
      return { approved: false };
    }

    return { approved: answer.toLowerCase() === 'y', commitMessage };
  }

  // ── PUSH APPROVAL ──────────────────────────────────────────────────────────

  async function promptPush({ hash, branch }) {
    console.log(`\n${'='.repeat(64)}`);
    console.log('PUSH APPROVAL REQUIRED');
    console.log('='.repeat(64));
    console.log(`\ncommit:\n${hash}\n`);
    console.log(`branch:\n${branch}\n`);

    const answer = await _ask(`origin/${branch} へ push しますか？ [y/N]: `);

    if (answer === null) {
      savePendingApproval({ type: 'PUSH_APPROVAL', hash, branch });
      console.log('\n承認待ちを pending_approval.json に保存しました。');
      return { approved: false };
    }

    return { approved: answer.toLowerCase() === 'y' };
  }

  // ── USER APPROVAL (特殊操作) ───────────────────────────────────────────────

  async function promptUser(operation, reason, { files = [] } = {}) {
    const fileList = files.length
      ? files.map(f => `  ${f}`).join('\n')
      : '  (なし)';

    console.log(`\n${'='.repeat(64)}`);
    console.log('USER APPROVAL REQUIRED');
    console.log('='.repeat(64));
    console.log(`\nOperation:\n${operation}\n`);
    console.log(`Reason:\n${reason}\n`);
    console.log(`Files / target:\n${fileList}\n`);

    const answer = await _ask('実行してよいですか？ [y/N]: ');

    if (answer === null) {
      savePendingApproval({ type: 'USER_APPROVAL', operation, reason, files });
      console.log('\n承認待ちを pending_approval.json に保存しました。');
      return { approved: false };
    }

    return { approved: answer.toLowerCase() === 'y' };
  }

  return { promptCommit, promptPush, promptUser };
}
