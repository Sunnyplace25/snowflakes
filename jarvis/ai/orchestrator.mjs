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
import { createHash }         from 'node:crypto';

import { createGuardrails }                        from './guardrails.mjs';
import { runClaude, findClaudeCli }                from './claude_runner.mjs';
import { reviewCode, SessionBudget, BudgetExceededError } from './openai_reviewer.mjs';
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

// ── Git 差分検出ヘルパー ──────────────────────────────────────────────────────

/**
 * 作業ツリーのスナップショット（dirty ファイルとハッシュ）を記録する。
 * @param {string} cwd
 * @param {(cmd: string) => string} execGit  makeExecGit(cwd) で作成したヘルパー
 * @returns {Map<string, string>}  Map<相対パス, contentHash | '__deleted__' | '__error__'>
 */
function captureWorkingTreeSnapshot(cwd, execGit) {
  const snapshot = new Map();
  try {
    const lines = execGit('git status --porcelain').split('\n').filter(Boolean);

    for (const line of lines) {
      let filePath = line.slice(3).trim();
      // リネーム: "R  old -> new" → new のみ追跡
      if (filePath.includes(' -> ')) filePath = filePath.split(' -> ').pop();
      // クォート除去
      filePath = filePath.replace(/^"(.*)"$/, '$1');

      // existsSync は使わない — git hash-object の返値で判断する。
      // これによりテスト環境でもモックが正しく機能する。
      const hash = execGit(`git hash-object -- "${filePath}"`);
      snapshot.set(filePath, hash || '__deleted__');
    }
  } catch { /* git status 失敗は無視 */ }
  return snapshot;
}

/**
 * Claude が変更したファイルを特定する（ベースラインとの差分比較）。
 * - beforeSnapshot にない新規ファイル
 * - ハッシュが変わった既存 dirty ファイル（事前 dirty + Claude 追加編集）
 * - ベースラインに存在して現在消えたファイル（Claude が削除）
 * @param {Map<string, string>} beforeSnapshot
 * @param {string} cwd
 * @param {(cmd: string) => string} execGit
 * @returns {string[]}
 */
function computeClaudeChangedFiles(beforeSnapshot, cwd, execGit) {
  const afterSnapshot = captureWorkingTreeSnapshot(cwd, execGit);
  const claudeFiles = new Set();

  for (const [file, afterHash] of afterSnapshot) {
    const beforeHash = beforeSnapshot.get(file);
    if (beforeHash === undefined) {
      // Claude が新規作成
      claudeFiles.add(file);
    } else if (afterHash !== beforeHash) {
      // 事前 dirty ファイルをさらに Claude が編集
      claudeFiles.add(file);
    }
  }

  // Claude が削除したファイル
  for (const [file, beforeHash] of beforeSnapshot) {
    if (!afterSnapshot.has(file) && beforeHash !== '__deleted__') {
      claudeFiles.add(file);
    }
  }

  return [...claudeFiles];
}

/**
 * Claude が変更したファイルのみのスコープ付き diff を返す。
 * この関数が呼ばれる時点でオーバーラップは解消済みであることが保証される。
 * - tracked ファイル: git diff HEAD（= Claude の変更のみ。事前 clean を確認済み）
 * - untracked 新規ファイル: 全内容を unified diff 形式で表現
 *
 * @param {string[]} claudeFiles
 * @param {string} cwd
 * @param {(cmd: string) => string} execGit
 * @returns {string}
 */
function buildScopedDiff(claudeFiles, cwd, execGit) {
  if (claudeFiles.length === 0) return '(Claude による変更なし)';

  const parts = [];
  for (const f of claudeFiles) {
    const isTracked = execGit(`git ls-files -- "${f}"`).trim() !== '';

    if (isTracked) {
      const d = execGit(`git diff HEAD -- "${f}"`);
      if (d) parts.push(d);
    } else {
      const absPath = resolve(cwd, f);
      if (existsSync(absPath)) {
        try {
          const content = readFileSync(absPath, 'utf8').replace(/\r\n/g, '\n');
          const lineCount = content.split('\n').length;
          const addLines  = content.split('\n').map(l => `+${l}`).join('\n');
          parts.push(
            `diff --git a/${f} b/${f}\nnew file mode 100644\n` +
            `--- /dev/null\n+++ b/${f}\n@@ -0,0 +1,${lineCount} @@\n${addLines}`
          );
        } catch {
          parts.push(`(新規ファイル: ${f} — 読み取り不可)`);
        }
      } else {
        parts.push(`(削除されたファイル: ${f})`);
      }
    }
  }
  return parts.filter(Boolean).join('\n\n');
}

/**
 * ファイル一覧の内容ハッシュから「コミットフィンガープリント」を計算する。
 * 承認後にファイルが変更されていないか確認するために使用。
 * @param {string[]} files
 * @param {string} cwd
 * @returns {string}
 */
function computeFingerprint(files, cwd) {
  const entries = files.map(f => {
    try {
      const absPath = resolve(cwd, f);
      if (!existsSync(absPath)) return `${f}:deleted`;
      const content = readFileSync(absPath);
      const hash    = createHash('sha256').update(content).digest('hex').slice(0, 8);
      return `${f}:${hash}`;
    } catch {
      return `${f}:error`;
    }
  }).sort();
  return entries.join('|');
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
    case 'OVERLAP_DETECTED': {
      log(`オーバーラップファイル (${(pending.overlapFiles ?? []).length}件):`);
      (pending.overlapFiles ?? []).forEach(f => log(`  ⚠️ ${f}`));
      log('事前の未コミット変更と Claude の変更が重複しています。');
      log('手動でファイルを確認し、pre-existing 変更を commit または stash してから再実行してください。');
      await gate.promptUser('OVERLAP_DETECTED', '事前の未コミット変更を解消してから再実行してください。', { files: pending.overlapFiles ?? [] });
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
  const maxCycles  = options.maxCycles ?? parseInt(process.env.BRIDGE_MAX_CYCLES ?? '4', 10);
  const execGit    = options.execGit   ?? makeExecGit(cwd);
  const testRunner = options.runTests  ?? defaultRunTests;
  const gate       = options.gate      ?? createApprovalGate();
  const guard      = createGuardrails({ execGit });

  const _runClaude  = options.runner   ?? runClaude;
  const _reviewCode = options.reviewer ?? reviewCode;

  // セッション予算（OpenAI: BRIDGE_MAX_COST_USD、Claude: BRIDGE_MAX_CLAUDE_COST_USD）
  const maxCostUSD = process.env.BRIDGE_MAX_COST_USD
    ? parseFloat(process.env.BRIDGE_MAX_COST_USD)
    : null;
  const maxClaudeCostUSD = process.env.BRIDGE_MAX_CLAUDE_COST_USD
    ? parseFloat(process.env.BRIDGE_MAX_CLAUDE_COST_USD)
    : null;
  const budget = new SessionBudget(maxCostUSD);
  let claudeTotalCostUsd = 0;

  // ── ペンディング承認チェック ─────────────────────────────────────────────
  const pending = loadPendingApproval();
  if (pending) {
    return await handlePendingApproval(pending, gate, execGit, cwd);
  }

  // ── ブランチ確認 ─────────────────────────────────────────────────────────
  guard.checkBranch();
  log('Branch check OK: jarvis-development');
  if (maxCostUSD !== null)       log(`OpenAI 料金上限: $${maxCostUSD.toFixed(2)} / セッション`);
  if (maxClaudeCostUSD !== null) log(`Claude 料金上限: $${maxClaudeCostUSD.toFixed(2)} / セッション`);

  // ── ベースライン記録 ────────────────────────────────────────────────────
  const baseline        = guard.recordBaseline();
  // Claude が変更したファイルを特定するため、事前の dirty 状態をスナップショット
  const beforeSnapshot  = captureWorkingTreeSnapshot(cwd, execGit);
  const reviewRules     = loadReviewRules();

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

    // Claude コスト追跡
    claudeTotalCostUsd += claudeResult.cost_usd ?? 0;
    if (claudeResult.cost_usd) {
      log(`Claude コスト: $${(claudeResult.cost_usd).toFixed(4)} (累計: $${claudeTotalCostUsd.toFixed(4)})`);
    }
    if (maxClaudeCostUSD !== null && claudeTotalCostUsd > maxClaudeCostUSD) {
      log(`Claude 料金上限超過: $${claudeTotalCostUsd.toFixed(4)} > $${maxClaudeCostUSD}`);
      savePendingApproval({ type: 'BUDGET_EXCEEDED', scope: 'claude', spent: claudeTotalCostUsd, limit: maxClaudeCostUSD });
      return { decision: 'budget_exceeded', scope: 'claude', spent: claudeTotalCostUsd, limit: maxClaudeCostUSD };
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

    // Claude が変更したファイルを特定（hash ベース）
    const claudeChangedFiles = computeClaudeChangedFiles(beforeSnapshot, cwd, execGit);
    if (claudeChangedFiles.length > 0) {
      log(`Claude 変更ファイル (${claudeChangedFiles.length}件): ${claudeChangedFiles.join(', ')}`);
    } else {
      log('Claude による変更ファイルなし');
    }

    // ── 変更なし ───────────────────────────────────────────────────────
    if (claudeChangedFiles.length === 0) {
      log('Claude による変更ファイルなし → コミット不要');
      clearPendingApproval();
      return { decision: 'no_changes', cycle, testResult };
    }

    // ── オーバーラップ検出（OpenAI 呼び出し前に停止）──────────────────
    // 事前 dirty だったファイルを Claude が追加編集した場合、
    // 事前変更との分離が不可能なため自動レビュー・自動 commit を停止する。
    const preExistingKeys    = new Set(beforeSnapshot.keys());
    const claudeOverlapFiles = claudeChangedFiles.filter(f => preExistingKeys.has(f));

    if (claudeOverlapFiles.length > 0) {
      log(`⚠️ オーバーラップ検出: ${claudeOverlapFiles.length}件`);
      log(`   ${claudeOverlapFiles.join(', ')}`);
      log('   → 自動レビュー・自動コミットを停止します。手動で確認してください。');
      savePendingApproval({
        type:            'OVERLAP_DETECTED',
        overlapFiles:    claudeOverlapFiles,
        claudeOnlyFiles: claudeChangedFiles.filter(f => !preExistingKeys.has(f)),
        cycle,
        claudeCostUsd:   claudeTotalCostUsd,
        savedAt:         new Date().toISOString(),
      });
      return { decision: 'overlap_detected', overlapFiles: claudeOverlapFiles, cycle };
    }

    // ── diff 生成（オーバーラップなし確定）────────────────────────────
    const diff     = buildScopedDiff(claudeChangedFiles, cwd, execGit);
    const diffStat = `${claudeChangedFiles.length} file(s) changed by Claude:\n` +
                     claudeChangedFiles.map(f => `  - ${f}`).join('\n');

    // OpenAI レビュー（予算オーバー時は BudgetExceededError を throw）
    log('OpenAI レビュー中...');
    let review;
    try {
      review = await _reviewCode(
        { task: taskText, claudeReport: claudeResult.result, diff, diffStat, testResult },
        { budget },
      );
    } catch (e) {
      if (e.name === 'BudgetExceededError') {
        log(`料金上限超過: ${e.message}`);
        savePendingApproval({ type: 'BUDGET_EXCEEDED', message: e.message, spent: e.spent, limit: e.limit });
        return { decision: 'budget_exceeded', spent: e.spent, limit: e.limit };
      }
      throw e;
    }
    if (maxCostUSD !== null || maxClaudeCostUSD !== null) {
      log(`コスト内訳 — Claude: $${claudeTotalCostUsd.toFixed(4)} / OpenAI: $${budget.totalUsd?.toFixed(4) ?? '0'}`);
    }
    saveLastReview({ cycle, review, testResult, sessionId, timestamp: Date.now(), claudeCostUsd: claudeTotalCostUsd, openaiCostUsd: budget.totalUsd ?? 0 });
    log(`OpenAI decision: ${review.decision}`);

    // ── approve ──────────────────────────────────────────────────────────
    if (review.decision === 'approve' && testResult.failed === 0) {
      // オーバーラップなし確定なので claudeChangedFiles をそのままコミット対象に
      const filesToCommit = claudeChangedFiles;

      // 承認前のフィンガープリントを記録（承認後の変化検知用）
      const fingerprintBefore = computeFingerprint(filesToCommit, cwd);

      const commitMsg    = buildCommitMessage(taskText, review);
      const commitResult = await gate.promptCommit({
        task:          taskText,
        review,
        testResult,
        files:         filesToCommit,
        commitMessage: commitMsg,
        claudeCostUsd: claudeTotalCostUsd,
        openaiCostUsd: budget.totalUsd ?? 0,
      });

      if (commitResult.approved) {
        // 承認後にファイルが変わっていないか検証
        const fingerprintAfter = computeFingerprint(filesToCommit, cwd);
        if (fingerprintAfter !== fingerprintBefore) {
          log('警告: 承認後にファイルが変更されました → 再承認が必要');
          savePendingApproval({
            type: 'COMMIT_APPROVAL', task: taskText, review, testResult,
            files: filesToCommit, commitMessage: commitResult.commitMessage ?? commitMsg,
            claudeCostUsd: claudeTotalCostUsd, openaiCostUsd: budget.totalUsd ?? 0,
          });
          return { decision: 'reapproval_required' };
        }

        await doCommit(filesToCommit, commitResult.commitMessage ?? commitMsg, cwd);
        const hash = execGit('git rev-parse --short HEAD');
        log(`Committed: ${hash}`);

        const pushResult = await gate.promptPush({
          hash,
          branch:       'jarvis-development',
          files:        filesToCommit,
          claudeCostUsd: claudeTotalCostUsd,
          openaiCostUsd: budget.totalUsd ?? 0,
        });
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

// ── CLI 引数パーサー ──────────────────────────────────────────────────────────

/**
 * argv から名前付きオプションを取り出す。
 *   --cwd /path/to/dir  → { cwd: '/path/to/dir' }
 *   --dry-run           → { dryRun: true }
 *   --max-cycles 3      → { maxCycles: 3 }
 */
function parseArgs(argv) {
  const opts   = { cwd: null, dryRun: false, maxCycles: null };
  const pos    = [];  // 位置引数（オプション以外）

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--cwd' && argv[i + 1]) {
      opts.cwd = argv[++i];
    } else if (a === '--dry-run') {
      opts.dryRun = true;
    } else if (a === '--max-cycles' && argv[i + 1]) {
      opts.maxCycles = parseInt(argv[++i], 10);
    } else {
      pos.push(a);
    }
  }

  return { opts, pos };
}

// ── DRY RUN モック ────────────────────────────────────────────────────────────

/**
 * DRY_RUN=true または --dry-run 指定時に使うモックランナー。
 * 実際の Claude CLI / OpenAI API は呼ばない。
 */
function makeDryRunMocks() {
  let callCount = 0;

  const runner = async (prompt, { sessionId } = {}) => {
    callCount++;
    log(`[DRY_RUN] Claude 呼び出し #${callCount} をスキップ`);
    return {
      result:     `[DRY_RUN] Claude 実装完了（モック）— cycle ${callCount}`,
      session_id: sessionId ?? `dry-run-session-${callCount}`,
    };
  };

  const reviewer = async () => {
    log('[DRY_RUN] OpenAI レビュー呼び出しをスキップ → approve を返す');
    return {
      decision:               'approve',
      summary:                '[DRY_RUN] モックレビュー: 問題なし',
      issues:                 [],
      instructions_to_claude: '',
      user_question:          '',
    };
  };

  const runTests = async () => {
    log('[DRY_RUN] テスト実行をスキップ');
    return { passed: 1, failed: 0, output: '[DRY_RUN] テストスキップ\n1 passed' };
  };

  return { runner, reviewer, runTests };
}

// ── CLI エントリーポイント ─────────────────────────────────────────────────────

async function main() {
  const { opts, pos } = parseArgs(process.argv.slice(2));
  const [command, taskFile] = pos;

  // DRY_RUN は環境変数でも --dry-run フラグでも有効になる
  const isDryRun = opts.dryRun || process.env.DRY_RUN === 'true';

  if (command === 'run' && taskFile) {
    const taskPath = resolve(process.cwd(), taskFile);
    if (!existsSync(taskPath)) {
      console.error(`Task file not found: ${taskPath}`);
      process.exit(1);
    }
    const taskText = readFileSync(taskPath, 'utf8');

    // cwd: --cwd > 環境変数 BRIDGE_CWD > デフォルト（リポジトリルート）
    const cwd = opts.cwd
      ?? process.env.BRIDGE_CWD
      ?? resolve(__dirname, '../..');

    // maxCycles: --max-cycles > 環境変数 BRIDGE_MAX_CYCLES > デフォルト 4
    const maxCycles = opts.maxCycles
      ?? (process.env.BRIDGE_MAX_CYCLES ? parseInt(process.env.BRIDGE_MAX_CYCLES, 10) : 4);

    if (isDryRun) {
      console.log('[DRY_RUN モード] 実際の Claude / OpenAI API は呼び出しません');
      console.log(`[DRY_RUN] cwd: ${cwd}  maxCycles: ${maxCycles}`);
    }

    const mocks   = isDryRun ? makeDryRunMocks() : {};
    const options = {
      cwd,
      maxCycles,
      ...(isDryRun ? {
        runner:   mocks.runner,
        reviewer: mocks.reviewer,
        runTests: mocks.runTests,
      } : {}),
    };

    try {
      const result = await runBridge(taskText, options);
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
    // 設定値確認
    console.log(`BRIDGE_CWD:              ${process.env.BRIDGE_CWD ?? '(未設定 → デフォルト)'}`);
    console.log(`BRIDGE_MAX_CYCLES:       ${process.env.BRIDGE_MAX_CYCLES ?? '(未設定 → 4)'}`);
    console.log(`BRIDGE_MAX_COST_USD:     ${process.env.BRIDGE_MAX_COST_USD ?? '(未設定 → 無制限)'} (OpenAI上限)`);
    console.log(`BRIDGE_MAX_CLAUDE_COST_USD: ${process.env.BRIDGE_MAX_CLAUDE_COST_USD ?? '(未設定 → 無制限)'} (Claude上限)`);
    console.log(`OPENAI_REVIEW_MODEL:     ${process.env.OPENAI_REVIEW_MODEL ?? 'gpt-5.6-terra (デフォルト)'}`);
    return;
  }

  console.log('Usage:');
  console.log('  node jarvis/ai/orchestrator.mjs run <taskFile> [--cwd <dir>] [--dry-run] [--max-cycles <n>]');
  console.log('  node jarvis/ai/orchestrator.mjs check-cli');
  console.log('');
  console.log('Environment variables:');
  console.log('  BRIDGE_CWD          gitリポジトリのルートパス');
  console.log('  BRIDGE_MAX_CYCLES   最大レビュー往復回数 (default: 4)');
  console.log('  BRIDGE_MAX_COST_USD        1セッションのOpenAI料金上限ドル (default: 無制限)');
  console.log('  BRIDGE_MAX_CLAUDE_COST_USD 1セッションのClaude料金上限ドル (default: 無制限)');
  console.log('  OPENAI_REVIEW_MODEL        レビューに使うOpenAIモデル (default: gpt-5.6-terra)');
  console.log('  DRY_RUN                    true にするとClaude/OpenAIをモック化');
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
