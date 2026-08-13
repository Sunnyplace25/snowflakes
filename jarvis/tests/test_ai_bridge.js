/**
 * jarvis/tests/test_ai_bridge.js
 * AI ブリッジのモックベーステスト
 *
 * 外部 API (Claude CLI / OpenAI) は一切呼ばない。
 * モック関数を注入して orchestrator / guardrails / reviewer / gate の
 * ロジックのみを検証する。
 *
 * 注意: 全テストを逐次実行する（pending_approval.json への同時書き込み回避）
 */

import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath }    from 'node:url';

import { createGuardrails, ALLOWED_BRANCH, VIOLATION_TYPES } from '../ai/guardrails.mjs';
import { buildReviewInput, REVIEW_SCHEMA }                    from '../ai/openai_reviewer.mjs';
import { SAFE_ALLOWED_TOOLS, buildClaudeArgs }                from '../ai/claude_runner.mjs';
import {
  createApprovalGate,
  savePendingApproval,
  loadPendingApproval,
  clearPendingApproval,
} from '../ai/approval_gate.mjs';
import { runBridge } from '../ai/orchestrator.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── テストランナー ───────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

/** 同期テスト */
function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ❌ ${name}`);
    console.error(`     ${e.message}`);
    failed++;
  }
}

/** 非同期テスト — 必ず await して逐次実行すること */
async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ❌ ${name}`);
    console.error(`     ${e.message}`);
    failed++;
  }
}

// ─── モックヘルパー ───────────────────────────────────────────────────────────

/** Claude ランナーモック */
function mockRunner(responses) {
  let idx = 0;
  async function run(prompt, opts = {}) {
    const r = responses[idx] ?? responses[responses.length - 1];
    idx++;
    if (r instanceof Error) throw r;
    return { result: r, session_id: 'mock-session-abc' };
  }
  run.callCount = () => idx;
  return run;
}

/** OpenAI レビュアーモック */
function mockReviewer(decisions) {
  let idx = 0;
  async function review(payload, opts) {
    const d = decisions[idx] ?? decisions[decisions.length - 1];
    idx++;
    if (d instanceof Error) throw d;
    return d;
  }
  review.callCount = () => idx;
  return review;
}

const approve  = (summary = 'LGTM') =>
  ({ decision: 'approve',     summary, issues: [], instructions_to_claude: '', user_question: '' });
const revise   = (instructions = '修正してください') =>
  ({ decision: 'revise',      summary: 'Issues found', issues: [], instructions_to_claude: instructions, user_question: '' });
const needsUser = (question = 'どうしますか？') =>
  ({ decision: 'needs_user',  summary: 'User decision needed', issues: [], instructions_to_claude: '', user_question: question });

/** テスト用の非対話承認ゲート（実際の commit/push はしない） */
function mockGate({ commitApproved = false, pushApproved = false } = {}) {
  const calls = [];
  return {
    promptCommit: async (info) => { calls.push({ type: 'commit', info }); return { approved: commitApproved, commitMessage: info.commitMessage }; },
    promptPush:   async (info) => { calls.push({ type: 'push',   info }); return { approved: pushApproved }; },
    promptUser:   async (op, reason) => { calls.push({ type: 'user', op, reason }); return { approved: false }; },
    calls,
  };
}

/** テスト用 execGit: protected files は baseline から変化なし（違反なし） */
function mockExecGitNoViolation(branch = ALLOWED_BRANCH) {
  const baseStatus = [
    '?? jarvis/data/business_data.db-shm',
    '?? jarvis/data/business_data.db-wal',
    '?? music/kaeranai_streaming.mp3',
  ].join('\n');
  return (cmd) => {
    if (cmd === 'git branch --show-current')   return branch;
    if (cmd.includes('--porcelain'))           return baseStatus;
    if (cmd.includes('--cached --name-only'))  return '';
    if (cmd.includes('--name-only'))           return '';
    if (cmd.includes('--stat'))                return '';
    if (cmd.startsWith('git diff'))            return '(mock diff)';
    if (cmd.startsWith('git rev-parse'))       return 'abc1234';
    if (cmd.startsWith('git add'))             return '';
    if (cmd.startsWith('git push'))            return '';
    return '';
  };
}

const passTestResult = { passed: 10, failed: 0, output: '10 passed' };
const failTestResult = { passed: 8,  failed: 2, output: '8 passed / 2 failed' };

const BRIDGE_CWD = resolve(__dirname, '..');

// ─── 1. Guardrails ────────────────────────────────────────────────────────────

console.log('\n▶ Guardrails: ブランチ確認');

test('正しいブランチ → throw しない', () => {
  const g = createGuardrails({ execGit: mockExecGitNoViolation('jarvis-development') });
  assert.doesNotThrow(() => g.checkBranch());
});

test('wrong branch → throw する', () => {
  const g = createGuardrails({ execGit: mockExecGitNoViolation('main') });
  assert.throws(() => g.checkBranch(), /GUARDRAIL/);
});

test('ALLOWED_BRANCH は jarvis-development', () => {
  assert.equal(ALLOWED_BRANCH, 'jarvis-development');
});

console.log('\n▶ Guardrails: 保護ファイル検出');

test('保護ファイルが baseline から変化なし → 違反なし', () => {
  const g = createGuardrails({ execGit: mockExecGitNoViolation() });
  const baseline   = g.recordBaseline();
  const violations = g.checkViolations(baseline);
  assert.equal(violations.length, 0, `violations: ${JSON.stringify(violations)}`);
});

test('保護ファイルが今回新たに変更された → 違反検出', () => {
  let callCount = 0;
  const execGit = (cmd) => {
    if (cmd === 'git branch --show-current') return 'jarvis-development';
    if (cmd.includes('--porcelain')) {
      callCount++;
      if (callCount === 1) return ''; // baseline は空
      return 'M  jarvis/data/business_data.db'; // 変更あり
    }
    if (cmd.includes('--cached --name-only')) return '';
    if (cmd.includes('--name-only')) return '';
    return '';
  };
  const g        = createGuardrails({ execGit });
  const baseline = g.recordBaseline();
  const violations = g.checkViolations(baseline);
  assert.ok(violations.some(v => v.type === VIOLATION_TYPES.PROTECTED_FILE_CHANGE));
});

test('isProtected: jarvis/data/business_data.db は保護対象', () => {
  const g = createGuardrails({ execGit: mockExecGitNoViolation() });
  assert.ok(g.isProtected('jarvis/data/business_data.db'));
});

test('isProtected: jarvis/ai/orchestrator.mjs は保護対象外', () => {
  const g = createGuardrails({ execGit: mockExecGitNoViolation() });
  assert.ok(!g.isProtected('jarvis/ai/orchestrator.mjs'));
});

// ─── 2. OpenAI Reviewer ───────────────────────────────────────────────────────

console.log('\n▶ OpenAI Reviewer: 入力組み立て');

test('buildReviewInput が必要なセクションを含む', () => {
  const input = buildReviewInput({
    task:         'Phase 3 タスク',
    claudeReport: 'Claude が実装しました',
    diff:         '--- a/foo.js\n+++ b/foo.js',
    diffStat:     'foo.js | 5 +++++',
    testResult:   { passed: 20, failed: 0 },
  });
  assert.ok(input.includes('Phase 3 タスク'), 'task missing');
  assert.ok(input.includes('Claude が実装'),  'report missing');
  assert.ok(input.includes('20 passed'),       'testResult missing');
  assert.ok(input.includes('foo.js'),          'diff missing');
});

test('REVIEW_SCHEMA には decision / issues / instructions_to_claude が含まれる', () => {
  assert.ok(REVIEW_SCHEMA.properties.decision);
  assert.ok(REVIEW_SCHEMA.properties.issues);
  assert.ok(REVIEW_SCHEMA.properties.instructions_to_claude);
  assert.deepEqual(REVIEW_SCHEMA.properties.decision.enum, ['approve', 'revise', 'needs_user']);
});

console.log('\n▶ OpenAI Reviewer: API モック');

await testAsync('入力が 120000 文字を超えると reviewer が throw する', async () => {
  const { reviewCode } = await import('../ai/openai_reviewer.mjs');
  const hugeDiff = 'x'.repeat(130_000);
  await assert.rejects(
    () => reviewCode(
      { task: 'T', claudeReport: 'C', diff: hugeDiff, diffStat: '', testResult: null },
      { apiKey: 'sk-test', fetchFn: async () => { throw new Error('should not reach'); } },
    ),
    /上限/,
  );
});

await testAsync('approve レスポンス → decision: approve が返る', async () => {
  const { reviewCode } = await import('../ai/openai_reviewer.mjs');
  const mockFetch = async () => ({
    ok:   true,
    json: async () => ({
      output: [{ content: [{ type: 'output_text', text: JSON.stringify(approve()) }] }],
    }),
  });
  const result = await reviewCode(
    { task: 'T', claudeReport: 'C', diff: '', diffStat: '', testResult: passTestResult },
    { fetchFn: mockFetch, apiKey: 'sk-test' },
  );
  assert.equal(result.decision, 'approve');
});

await testAsync('revise レスポンス → instructions_to_claude が返る', async () => {
  const { reviewCode } = await import('../ai/openai_reviewer.mjs');
  const r = revise('関数名をスネークケースにしてください');
  const mockFetch = async () => ({
    ok:   true,
    json: async () => ({
      output: [{ content: [{ type: 'output_text', text: JSON.stringify(r) }] }],
    }),
  });
  const result = await reviewCode(
    { task: 'T', claudeReport: 'C', diff: '', diffStat: '', testResult: passTestResult },
    { fetchFn: mockFetch, apiKey: 'sk-test' },
  );
  assert.equal(result.decision, 'revise');
  assert.ok(result.instructions_to_claude.includes('スネークケース'));
});

await testAsync('Structured Output 不正 → throw (approve 扱いにしない)', async () => {
  const { reviewCode } = await import('../ai/openai_reviewer.mjs');
  const mockFetch = async () => ({
    ok:   true,
    json: async () => ({
      output: [{ content: [{ type: 'output_text', text: '{"decision":"unknown"}' }] }],
    }),
  });
  await assert.rejects(
    () => reviewCode(
      { task: 'T', claudeReport: 'C', diff: '', diffStat: '', testResult: null },
      { fetchFn: mockFetch, apiKey: 'sk-test' },
    ),
    /不正|失敗/,
  );
});

await testAsync('API エラー → MAX_RETRIES 後に throw (安全停止)', async () => {
  const { reviewCode } = await import('../ai/openai_reviewer.mjs');
  let attempts = 0;
  const mockFetch = async () => { attempts++; throw new Error('network error'); };
  await assert.rejects(
    () => reviewCode(
      { task: 'T', claudeReport: 'C', diff: '', diffStat: '', testResult: null },
      { fetchFn: mockFetch, apiKey: 'sk-test' },
    ),
    /失敗/,
  );
  assert.equal(attempts, 2, `リトライ回数: ${attempts}`);
});

await testAsync('API キーがログに出力されない', async () => {
  const { reviewCode } = await import('../ai/openai_reviewer.mjs');
  const SECRET_KEY = 'sk-SUPER_SECRET_KEY_9999';
  const logged = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log   = (...a) => logged.push(a.join(' '));
  console.error = (...a) => logged.push(a.join(' '));

  const mockFetch = async () => ({
    ok:   true,
    json: async () => ({
      output: [{ content: [{ type: 'output_text', text: JSON.stringify(approve()) }] }],
    }),
  });

  try {
    await reviewCode(
      { task: 'T', claudeReport: 'C', diff: '', diffStat: '', testResult: null },
      { fetchFn: mockFetch, apiKey: SECRET_KEY },
    );
  } finally {
    console.log   = origLog;
    console.error = origErr;
  }

  const allOutput = logged.join('\n');
  assert.ok(!allOutput.includes(SECRET_KEY), `API キーが出力に含まれています`);
});

// ─── 3. Orchestrator フロー ───────────────────────────────────────────────────

console.log('\n▶ Orchestrator: 正常フロー');

await testAsync('approve → gate.promptCommit が呼ばれる', async () => {
  clearPendingApproval();
  const gate   = mockGate({ commitApproved: false });
  const result = await runBridge('task text', {
    runner:   mockRunner(['実装しました']),
    reviewer: mockReviewer([approve('OK')]),
    gate,
    execGit:  mockExecGitNoViolation(),
    runTests: async () => passTestResult,
    cwd:      BRIDGE_CWD,
  });
  assert.equal(result.decision, 'approved');
  assert.ok(gate.calls.some(c => c.type === 'commit'), 'promptCommit が呼ばれていない');
});

await testAsync('revise → Claude が再度呼ばれる (2サイクル)', async () => {
  clearPendingApproval();
  const runner   = mockRunner(['実装1', '実装2']);
  const reviewer = mockReviewer([revise('修正A'), approve('OK')]);
  const gate     = mockGate({ commitApproved: false });

  await runBridge('task', {
    runner, reviewer, gate,
    execGit:  mockExecGitNoViolation(),
    runTests: async () => passTestResult,
    cwd:      BRIDGE_CWD,
  });

  assert.equal(runner.callCount(), 2,   `Claude 呼び出し回数: ${runner.callCount()}`);
  assert.equal(reviewer.callCount(), 2, `reviewer 呼び出し回数: ${reviewer.callCount()}`);
});

await testAsync('4回 revise → max_cycles_reached', async () => {
  clearPendingApproval();
  const runner   = mockRunner(new Array(5).fill('実装'));
  const reviewer = mockReviewer(new Array(4).fill(revise('まだ修正が必要')));
  const gate     = mockGate();

  const result = await runBridge('task', {
    runner, reviewer, gate,
    execGit:   mockExecGitNoViolation(),
    runTests:  async () => passTestResult,
    maxCycles: 4,
    cwd:       BRIDGE_CWD,
  });

  assert.equal(result.decision, 'max_cycles_reached');
});

await testAsync('needs_user → gate.promptUser が呼ばれ needs_user を返す', async () => {
  clearPendingApproval();
  const gate   = mockGate();
  const result = await runBridge('task', {
    runner:   mockRunner(['実装しました']),
    reviewer: mockReviewer([needsUser('実 DB を変更してよいですか？')]),
    gate,
    execGit:  mockExecGitNoViolation(),
    runTests: async () => passTestResult,
    cwd:      BRIDGE_CWD,
  });
  assert.equal(result.decision, 'needs_user');
  assert.ok(gate.calls.some(c => c.type === 'user'));
});

await testAsync('main ブランチ → checkBranch で throw', async () => {
  clearPendingApproval();
  await assert.rejects(
    () => runBridge('task', {
      runner:   mockRunner(['done']),
      reviewer: mockReviewer([approve()]),
      gate:     mockGate(),
      execGit:  mockExecGitNoViolation('main'),
      runTests: async () => passTestResult,
      cwd:      BRIDGE_CWD,
    }),
    /GUARDRAIL/,
  );
});

await testAsync('OpenAI API エラー → throw (安全停止)', async () => {
  clearPendingApproval();
  await assert.rejects(
    () => runBridge('task', {
      runner:   mockRunner(['done']),
      reviewer: async () => { throw new Error('API 接続失敗'); },
      gate:     mockGate(),
      execGit:  mockExecGitNoViolation(),
      runTests: async () => passTestResult,
      cwd:      BRIDGE_CWD,
    }),
    /API 接続失敗/,
  );
});

await testAsync('テスト失敗 + approve → revise として継続 (Claude 2回呼ばれる)', async () => {
  clearPendingApproval();
  let runCount = 0;
  const runner   = mockRunner(['実装1', '実装2']);
  const reviewer = mockReviewer([approve('OK'), approve('OK')]);
  const gate     = mockGate({ commitApproved: false });

  await runBridge('task', {
    runner, reviewer, gate,
    execGit:  mockExecGitNoViolation(),
    runTests: async () => {
      runCount++;
      return runCount === 1 ? failTestResult : passTestResult;
    },
    cwd: BRIDGE_CWD,
  });

  assert.equal(runner.callCount(), 2, 'Claude は 2 回呼ばれるべき');
});

await testAsync('git add . / -A / --all はソースコード内で使われない (commit helper)', async () => {
  // commitApproved=true で実行し、execGit への呼び出しを記録する
  clearPendingApproval();
  const gitCalls = [];
  const execGit = (cmd) => {
    gitCalls.push(cmd);
    if (cmd === 'git branch --show-current')  return 'jarvis-development';
    if (cmd.includes('--porcelain'))          return '?? jarvis/data/business_data.db-shm';
    if (cmd.includes('--cached --name-only')) return '';
    if (cmd.includes('--name-only'))          return 'jarvis/ai/orchestrator.mjs';
    if (cmd.includes('--stat'))               return '';
    if (cmd.startsWith('git diff'))           return '(diff)';
    if (cmd.startsWith('git rev-parse'))      return 'abc1234';
    if (cmd.startsWith('git add'))            return '';
    if (cmd.startsWith('git push'))           return '';
    return '';
  };

  try {
    await runBridge('task', {
      runner:   mockRunner(['実装しました']),
      reviewer: mockReviewer([approve('OK')]),
      gate:     mockGate({ commitApproved: true, pushApproved: false }),
      execGit,
      runTests: async () => passTestResult,
      cwd:      BRIDGE_CWD,
    });
  } catch { /* git commit 実行失敗は OK */ }

  const forbidden = gitCalls.filter(c =>
    c === 'git add .' || c === 'git add -A' || c === 'git add --all'
  );
  assert.equal(forbidden.length, 0, `禁止コマンド: ${forbidden.join(', ')}`);
});

// ─── 4. Approval Gate ─────────────────────────────────────────────────────────

console.log('\n▶ Approval Gate: 承認フロー');

await testAsync('promptCommit: y → approved=true', async () => {
  const gate   = createApprovalGate({ isTTY: true, promptFn: async () => 'y' });
  const result = await gate.promptCommit({
    task: 'T', review: approve(), testResult: passTestResult,
    files: ['foo.js'], commitMessage: 'feat: test',
  });
  assert.equal(result.approved, true);
});

await testAsync('promptCommit: N → approved=false', async () => {
  const gate   = createApprovalGate({ isTTY: true, promptFn: async () => 'N' });
  const result = await gate.promptCommit({
    task: 'T', review: approve(), testResult: passTestResult,
    files: ['foo.js'], commitMessage: 'feat: test',
  });
  assert.equal(result.approved, false);
});

await testAsync('promptPush: y → approved=true', async () => {
  const gate   = createApprovalGate({ isTTY: true, promptFn: async () => 'y' });
  const result = await gate.promptPush({ hash: 'abc1234', branch: 'jarvis-development' });
  assert.equal(result.approved, true);
});

await testAsync('promptPush: N → approved=false', async () => {
  const gate   = createApprovalGate({ isTTY: true, promptFn: async () => 'N' });
  const result = await gate.promptPush({ hash: 'abc1234', branch: 'jarvis-development' });
  assert.equal(result.approved, false);
});

await testAsync('非対話環境 → pending_approval.json に保存', async () => {
  clearPendingApproval();
  const gate = createApprovalGate({ isTTY: false });  // promptFn なし → 非対話
  await gate.promptCommit({
    task: 'pending task', review: approve(), testResult: passTestResult,
    files: ['bar.js'], commitMessage: 'feat: pending',
  });
  const pending = loadPendingApproval();
  assert.ok(pending !== null, 'pending_approval.json が null');
  assert.equal(pending.type, 'COMMIT_APPROVAL');
  clearPendingApproval();
});

// ─── 5. Pending Approval 再開 ─────────────────────────────────────────────────

console.log('\n▶ Pending Approval: 再開フロー');

await testAsync('pending_approval.json がある → 新しい作業を始めず先に承認を表示', async () => {
  clearPendingApproval();
  savePendingApproval({
    type:          'COMMIT_APPROVAL',
    task:          'pending task',
    review:        approve(),
    testResult:    passTestResult,
    files:         ['baz.js'],
    commitMessage: 'feat: baz',
  });

  const gate   = mockGate({ commitApproved: false });
  const runner = mockRunner(['should not be called']);

  const result = await runBridge('new task', {
    runner,
    reviewer: mockReviewer([approve()]),
    gate,
    execGit:  mockExecGitNoViolation(),
    runTests: async () => passTestResult,
    cwd:      BRIDGE_CWD,
  });

  assert.equal(result.decision, 'resumed');
  assert.equal(result.pendingType, 'COMMIT_APPROVAL');
  assert.equal(runner.callCount(), 0, 'pending があるのに Claude が呼ばれた');

  clearPendingApproval();
});

// ─── 6. メタテスト ─────────────────────────────────────────────────────────────

console.log('\n▶ Meta: ソースコード検証');

test('ソースファイルに git add . / -A / --all が含まれない', () => {
  const sources = [
    resolve(__dirname, '../ai/orchestrator.mjs'),
    resolve(__dirname, '../ai/approval_gate.mjs'),
    resolve(__dirname, '../ai/guardrails.mjs'),
    resolve(__dirname, '../ai/claude_runner.mjs'),
    resolve(__dirname, '../ai/openai_reviewer.mjs'),
  ];
  const forbidden = ['git add .', 'git add -A', 'git add --all'];
  for (const src of sources) {
    if (!existsSync(src)) continue;
    const text = readFileSync(src, 'utf8');
    // コメント行・ドキュメント行を除いて検索
    const nonComment = text.split('\n')
      .filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*'))
      .join('\n');
    for (const pat of forbidden) {
      assert.ok(!nonComment.includes(pat), `"${pat}" が ${src.split(/[\\/]/).pop()} に含まれています`);
    }
  }
});

test('REVIEW_RULES.md が存在する', () => {
  assert.ok(existsSync(resolve(__dirname, '../ai/REVIEW_RULES.md')));
});

test('runtime/.gitignore が存在する', () => {
  assert.ok(existsSync(resolve(__dirname, '../ai/runtime/.gitignore')));
});

test('runtime JSON ファイルが存在する', () => {
  for (const f of ['session.json', 'last_review.json', 'pending_approval.json']) {
    assert.ok(existsSync(resolve(__dirname, '../ai/runtime', f)), `${f} が存在しない`);
  }
});

// ─── 7. Permission Mode / Allowed Tools ──────────────────────────────────────

console.log('\n▶ Permission Mode: 安全なツール設定');

test('SAFE_ALLOWED_TOOLS に Read/Edit/Write/Glob/Grep が含まれる', () => {
  for (const tool of ['Read', 'Edit', 'Write', 'Glob', 'Grep']) {
    assert.ok(SAFE_ALLOWED_TOOLS.includes(tool), `${tool} が含まれない`);
  }
});

test('SAFE_ALLOWED_TOOLS に安全な git 読み取り操作が含まれる', () => {
  assert.ok(SAFE_ALLOWED_TOOLS.includes('git status'),            'git status 含まれない');
  assert.ok(SAFE_ALLOWED_TOOLS.includes('git diff'),              'git diff 含まれない');
  assert.ok(SAFE_ALLOWED_TOOLS.includes('git log'),               'git log 含まれない');
  assert.ok(SAFE_ALLOWED_TOOLS.includes('git branch --show-current'), 'git branch --show-current 含まれない');
});

test('SAFE_ALLOWED_TOOLS に node テスト実行が含まれる', () => {
  assert.ok(SAFE_ALLOWED_TOOLS.includes('node'), 'node 含まれない');
});

test('SAFE_ALLOWED_TOOLS に git commit が含まれない', () => {
  assert.ok(!SAFE_ALLOWED_TOOLS.includes('git commit'), 'git commit が含まれている（危険）');
});

test('SAFE_ALLOWED_TOOLS に git push が含まれない', () => {
  assert.ok(!SAFE_ALLOWED_TOOLS.includes('git push'), 'git push が含まれている（危険）');
});

test('SAFE_ALLOWED_TOOLS に git add が含まれない', () => {
  assert.ok(!SAFE_ALLOWED_TOOLS.includes('git add'), 'git add が含まれている（危険）');
});

test('SAFE_ALLOWED_TOOLS に checkout / switch が含まれない', () => {
  assert.ok(!SAFE_ALLOWED_TOOLS.includes('checkout'), 'checkout が含まれている（危険）');
  assert.ok(!SAFE_ALLOWED_TOOLS.includes('switch'),   'switch が含まれている（危険）');
});

test('SAFE_ALLOWED_TOOLS に dangerously-skip-permissions / bypassPermissions が含まれない', () => {
  assert.ok(!SAFE_ALLOWED_TOOLS.includes('dangerously-skip-permissions'), '危険フラグが含まれている');
  assert.ok(!SAFE_ALLOWED_TOOLS.includes('bypassPermissions'),            '危険モードが含まれている');
});

test('buildClaudeArgs に --allowed-tools が含まれ値は SAFE_ALLOWED_TOOLS と一致する', () => {
  const args     = buildClaudeArgs('test prompt');
  const idx      = args.indexOf('--allowed-tools');
  assert.ok(idx >= 0, '--allowed-tools が args に含まれない');
  assert.equal(args[idx + 1], SAFE_ALLOWED_TOOLS, '--allowed-tools の値が SAFE_ALLOWED_TOOLS と異なる');
});

test('buildClaudeArgs に --output-format json が含まれる', () => {
  const args = buildClaudeArgs('test prompt');
  assert.ok(args.includes('--output-format'), '--output-format が含まれない');
  assert.ok(args.includes('json'),            'json が含まれない');
});

test('buildClaudeArgs: sessionId あり → --resume が含まれる', () => {
  const args = buildClaudeArgs('test', { sessionId: 'sess-abc' });
  assert.ok(args.includes('--resume'),   '--resume が含まれない');
  assert.ok(args.includes('sess-abc'),   'session_id が含まれない');
});

test('buildClaudeArgs: sessionId なし → --resume が含まれない', () => {
  const args = buildClaudeArgs('test', { sessionId: null });
  assert.ok(!args.includes('--resume'), '--resume が含まれてしまっている');
});

// ─── 結果 ─────────────────────────────────────────────────────────────────────

// pending_approval.json を最終クリア
clearPendingApproval();

console.log(`\n${passed + failed} tests run: ${passed} passed / ${failed} failed`);
if (failed > 0) process.exit(1);
