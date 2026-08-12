/**
 * jarvis/ai/orchestrator.mjs
 * AI開発ブリッジのメインオーケストレーター。
 *
 * 起動:
 *   node jarvis/ai/orchestrator.mjs run jarvis/ai/tasks/phase3-narou.md
 *   node jarvis/ai/orchestrator.mjs check-cli
 *
 * フロー:
 *   Claude実装 → テスト → OpenAIレビュー → reviseならClaude修正 → 再レビュー
 *   → approveなら承認ゲート → commit承認 → push承認
 *
 * ユーザー確認が必要なもの:
 *   commit / push / mainブランチ変更 / 実DB変更 / 外部公開 / 削除 / 4回AI往復でも未解決
 */

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname }  from 'node:path';
import { fileURLToPath }     from 'node:url';
import { execSync, execFile } from 'node:child_process';
import { promisify }          from 'node:util';

import { createGuardrails }                        from './guardrails.mjs';
import { runClaude, findClaudeCli }                from './claude_runner.mjs';
import { reviewCode }                              from './openai_reviewer.mjs';
import {
  createApprovalGate,
  loadPendingApproval,
  clearPendingApproval,
  savePendingApproval,
} from './approval_gate.mjs';

const execFileAsync = promisify(execFile);
const __dirname     = dirname(fileURLToPath(import.meta.url));
const RUNTIME_DIR   = resolve(__dirname, 'runtime');
const SESSION_FILE      = resolve(RUNTIME_DIR, 'session.json');
const LAST_REVIEW_FILE  = resolve(RUNTIME_DIR, 'last_review.json');

// ── Runtime ───────────────────────────────────────────────────────────────────

function ensureRuntime() {
  mkdirSync(resolve(RUNTIME_DIR, 'logs'), { recursive: true });
}

function saveSession(data) {
  writeFileSync(SESSION_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function saveLastReview(data) {
  writeFileSync(LAST_REVIEW_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function log(msg) {
  const ts   = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  try {
    const logFile = resolve(RUNTIME_DIR, 'logs', `bridge-${ts.slice(0, 10)}.log`);
    writeFileSync(logFile, line + '\n', { flag: 'a', encoding: 'utf8' });
  } catch { /* ログ書き込み失敗は無視 */ }
}

// ── Git helpers ───────────────────────────────────────────────────────────────

function makeExecGit(cwd) {
  return (cmd) => {
    try {
      return execSync(cmd, {
        cwd,
        encoding: 'utf8',
        stdio:    ['pipe', 'pipe', 'pipe'],
      }).trim();
    } catch {
      return '';
    }
  };
}

// ── Test runner ───────────────────────────────────────────────────────────────

async function defaultRunTests(cwd) {
  const registryPath = resolve(cwd, 'jarvis/tests/registry.json');
  if (!existsSync(registryPath)) {
    return { passed: 0, failed: 0, output: '(registry.json not found)' };
  }

  const registry = JSON.parse(readFileSync(registryPath, 'utf8'));
  let passed = 0, failed = 0, output = '';

  for (const [name, entry] of Object.entries(registry)) {
    const testCwd = resolve(cwd, entry.cwd ?? '.');
    const args    = entry.args ?? [];
    try {
      const stdout = execSync(`node ${args.join(' ')}`, {
        cwd:      testCwd,
        encoding: 'utf8',
        timeout:  60_000,
        stdio:    'pipe',
      });
      const m = stdout.match(/(\d+)\s*passed/i);
      const p = m ? parseInt(m[1]) : 0;
      passed += p;
      output += `✅ ${name}: ${p} passed\n`;
    } catch (e) {
      const out = ((e.stdout ?? '') + (e.stderr ?? '')).slice(0, 500);
      const mf  = out.match(/(\d+)\s*failed/i);
      const f   = mf ? parseInt(mf[1]) : 1;
      failed += f;
      output += `❌ ${name}: ${f} failed\n${out}\n`;
    }
  }

  return { passed, failed, output };
}

// ── Claude プロンプト組み立て ─────────────────────────────────────────────────

function loadReviewRules() {
  const p = resolve(__dirname, 'REVIEW_RULES.md');
  return existsSync(p) ? readFileSync(p, 'utf8') : '(REVIEW_RULES.md not found)';
}

function buildClaudePrompt({ task, reviewRules, previousReview, gitStatus }) {
  const parts = [
    `# Task\n${task}`,
    `# Review Rules\n${reviewRules}`,
  ];

  if (previousReview) {
    parts.push(
      `# 前回 OpenAI レビュー (decision: ${previousReview.decision})\n` +
      `## Summary\n${previousReview.summary ?? ''}\n\n` +
      `## Instructions to Claude\n${previousReview.instructions_to_claude ?? ''}`
    );
  }

  if (gitStatus) {
    parts.push(`# Current Git Status\n${gitStatus}`);
  }

  parts.push(
    '以上を踏まえて実装してください。\n' +
    '絶対禁止: commit / push / main ブランチ変更 / 実 DB 変更'
  );

  return parts.join('\n\n---\n\n');
}

// ── Commit helper（git add . 禁止・ファイル個別 add）───────────────────────────

async function doCommit(files, commitMessage, cwd) {
  // git add -- <file> を1件ずつ
  for (const f of files) {
    execSync(`git add -- ${JSON.stringify(f)}`, { cwd, encoding: 'utf8', stdio: 'pipe' });
  }
  await execFileAsync('git', ['commit', '-m', commitMessage], {
    cwd,
    encoding: 'utf8',
    stdio:    'pipe',
  });
}

// ── Pending approval handler ──────────────────────────────────────────────────

async function handlePendingApproval(pending, gate, execGit, cwd) {
  log(`未処理の承認待ち: ${pending.type} (保存: ${pending.savedAt ?? '不明'})`);

  switch (pending.type) {
    case 'COMMIT_APPROVAL': {
      const result = await gate.promptCommit({
        task:          pending.task,
        review:        pending.review,
        testResult:    pending.testResult,
        files:         pending.files,
        commitMessage: pending.commitMessage,
      });
      if (result.approved) {
        await doCommit(pending.files, result.commitMessage ?? pending.commitMessage, cwd);
        const hash       = execGit('git rev-parse --short HEAD');
        const pushResult = await gate.promptPush({ hash, branch: 'jarvis-development' });
        if (pushResult.approved) execGit('git push origin jarvis-development');
      }
      clearPendingApproval();
      return { decision: 'resumed', pendingType: pending.type };
    }
    case 'PUSH_APPROVAL': {
      const result = await gate.promptPush({ hash: pending.hash, branch: pending.branch });
      if (result.approved) execGit(`git push origin ${pending.branch}`);
      clearPendingApproval();
      return { decision: 'resumed', pendingType: pending.type };
    }
    case 'NEEDS_USER':
    case 'USER_APPROVAL':
    case 'MAX_CYCLES': {
      await gate.promptUser(pending.type, pending.question ?? pending.reason ?? '(詳細なし)');
      clearPendingApproval();
      return { decision: 'resumed', pendingType: pending.type };
    }
    default:
      log(`未知の pending type: ${pending.type}`);
      clearPendingApproval();
      return { decision: 'resumed', pendingType: pending.type };
  }
}

// ── Main bridge ───────────────────────────────────────────────────────────────

/**
 * AI開発ブリッジを実行する。
 *
 * @param {string} taskText - タスクの内容（Markdown テキスト）
 * @param {{
 *   runner?:    (prompt: string, opts: object) => Promise<{ result: string, session_id: string|null }>,
 *   reviewer?:  (payload: object, opts?: object) => Promise<object>,
 *   gate?:      { promptCommit, promptPush, promptUser },
 *   execGit?:   (cmd: string) => string,
 *   runTests?:  (cwd: string) => Promise<{ passed: number, failed: number, output: string }>,
 *   maxCycles?: number,
 *   cwd?:       string,
 * }} options
 * @returns {Promise<{ decision: string, cycle?: number, review?: object, testResult?: object }>}
 */
export async function runBridge(taskText, options = {}) {
  ensureRuntime();

  const cwd        = options.cwd       ?? resolve(__dirname, '../..');
  const maxCycles  = options.maxCycles ?? 4;
  const execGit    = options.execGit   ?? makeExecGit(cwd);
  const testRunner = options.runTests  ?? defaultRunTests;
  const gate       = options.gate      ?? createApprovalGate();
  const guard      = createGuardrails({ execGit });

  const _runClaude  = options.runner   ?? runClaude;
  const _reviewCode = options.reviewer ?? reviewCode;

  // ── ペンディング承認チェック ─────────────────────────────────────────────
  const pending = loadPendingApproval();
  if (pending) {
    return await handlePendingApproval(pending, gate, execGit, cwd);
  }

  // ── ブランチ確認 ─────────────────────────────────────────────────────────
  guard.checkBranch();
  log('Branch check OK: jarvis-development');

  // ── ベースライン記録 ────────────────────────────────────────────────────
  const baseline    = guard.recordBaseline();
  const reviewRules = loadReviewRules();

  let sessionId      = null;
  let previousReview = null;

  for (let cycle = 0; cycle < maxCycles; cycle++) {
    log(`\n── Cycle ${cycle + 1} / ${maxCycles} ──`);

    // Claude プロンプト組み立て
    const gitStatus = execGit('git status --short');
    const prompt    = buildClaudePrompt({ task: taskText, reviewRules, previousReview, gitStatus });

    // Claude 実行
    log('Claude 実行中...');
    const claudeResult = await _runClaude(prompt, { sessionId, cwd });
    if (claudeResult.session_id) {
      sessionId = claudeResult.session_id;
      saveSession({ sessionId, cycle, taskText: taskText.slice(0, 120), timestamp: Date.now() });
      log(`Session saved: ${sessionId}`);
    }

    // ガードレール確認
    const violations = guard.checkViolations(baseline);
    if (violations.length > 0) {
      const v = violations[0];
      log(`GUARDRAIL VIOLATION: ${v.type} — ${v.detail}`);
      savePendingApproval({ type: 'VIOLATION', violation: v });
      throw new Error(`GUARDRAIL VIOLATION: ${v.type} — ${v.detail}`);
    }

    // テスト実行
    log('テスト実行中...');
    const testResult = await testRunner(cwd);
    log(`テスト: ${testResult.passed} passed / ${testResult.failed} failed`);

    // diff 取得
    const diff     = execGit('git diff');
    const diffStat = execGit('git diff --stat');

    // OpenAI レビュー
    log('OpenAI レビュー中...');
    const review = await _reviewCode({
      task:         taskText,
      claudeReport: claudeResult.result,
      diff,
      diffStat,
      testResult,
    });
    saveLastReview({ cycle, review, testResult, sessionId, timestamp: Date.now() });
    log(`OpenAI decision: ${review.decision}`);

    // ── approve ──────────────────────────────────────────────────────────
    if (review.decision === 'approve' && testResult.failed === 0) {
      const changedFiles = [
        ...execGit('git diff --name-only').split('\n').filter(Boolean),
        ...execGit('git diff --cached --name-only').split('\n').filter(Boolean),
      ];
      const files = [...new Set(changedFiles)];

      const commitMsg    = buildCommitMessage(taskText, review);
      const commitResult = await gate.promptCommit({
        task:          taskText,
        review,
        testResult,
        files,
        commitMessage: commitMsg,
      });

      if (commitResult.approved) {
        await doCommit(files, commitResult.commitMessage ?? commitMsg, cwd);
        const hash = execGit('git rev-parse --short HEAD');
        log(`Committed: ${hash}`);

        const pushResult = await gate.promptPush({ hash, branch: 'jarvis-development' });
        if (pushResult.approved) {
          execGit('git push origin jarvis-development');
          log('Push 完了');
        }
      }

      clearPendingApproval();
      return { decision: 'approved', cycle, review, testResult };
    }

    // approve だが tests 失敗
    if (review.decision === 'approve' && testResult.failed > 0) {
      log('OpenAI は approve だがテスト失敗 → revise として継続');
      previousReview = {
        ...review,
        decision:               'revise',
        instructions_to_claude: `テストが ${testResult.failed} 件失敗しています。修正してください。\n${testResult.output ?? ''}`,
      };
      continue;
    }

    // ── needs_user ────────────────────────────────────────────────────────
    if (review.decision === 'needs_user') {
      savePendingApproval({ type: 'NEEDS_USER', question: review.user_question, cycle, review });
      await gate.promptUser('NEEDS_USER', review.user_question ?? '(詳細なし)');
      return { decision: 'needs_user', cycle, review };
    }

    // ── revise ────────────────────────────────────────────────────────────
    if (review.decision === 'revise') {
      log(`Claude へ修正指示を返却: ${String(review.instructions_to_claude).slice(0, 80)}`);
      previousReview = review;
      continue;
    }
  }

  // 最大サイクル到達
  log(`最大レビュー回数 (${maxCycles}) に達しました。ユーザーの介入が必要です。`);
  savePendingApproval({ type: 'MAX_CYCLES', maxCycles, lastReview: previousReview });
  return { decision: 'max_cycles_reached', maxCycles };
}

function buildCommitMessage(taskText, review) {
  const summary = (review?.summary ?? '').slice(0, 60).replace(/"/g, "'");
  return summary || `feat(jarvis): task completed`;
}

// ── CLI エントリーポイント ─────────────────────────────────────────────────────

async function main() {
  const [,, command, taskFile] = process.argv;

  if (command === 'run' && taskFile) {
    const taskPath = resolve(process.cwd(), taskFile);
    if (!existsSync(taskPath)) {
      console.error(`Task file not found: ${taskPath}`);
      process.exit(1);
    }
    const taskText = readFileSync(taskPath, 'utf8');
    try {
      const result = await runBridge(taskText);
      console.log(`\nBridge result: ${result.decision}`);
    } catch (e) {
      console.error(`\nBridge error: ${e.message}`);
      process.exit(1);
    }
    return;
  }

  if (command === 'check-cli') {
    // Claude CLI 確認
    try {
      const p = findClaudeCli();
      console.log(`Claude CLI: OK (${p})`);
    } catch (e) {
      console.log(`Claude CLI: NG — ${e.message}`);
    }
    // OpenAI APIキー確認（値は表示しない）
    console.log(`OPENAI_API_KEY: ${process.env.OPENAI_API_KEY ? 'SET' : 'NOT SET'}`);
    return;
  }

  console.log('Usage:');
  console.log('  node jarvis/ai/orchestrator.mjs run <taskFile>');
  console.log('  node jarvis/ai/orchestrator.mjs check-cli');
}

// メインスクリプトとして直接実行された場合のみ起動
const isMain = process.argv[1] &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));

if (isMain) {
  main().catch(e => {
    console.error(e.message);
    process.exit(1);
  });
}
