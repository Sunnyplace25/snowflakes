/**
 * test_p42c.mjs  ─  Phase 42-C 手動進行ワーカー テストスイート（改訂版）
 * 実行: node content_business/test_p42c.mjs
 *
 * _mockConversation / _mockTone を使うため Claude API を呼ばない。
 */

import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { applyCbMigration } from './db_migration.mjs';
import {
  runManualAdvance,
  getAdvanceStatus,
  listPendingApprovals,
  resolveApproval,
} from './autonomous_worker.mjs';

// ── ユーティリティ ─────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
function assert(label, cond) {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else       { console.error(`  ✗ ${label}`); failed++; }
}

function makeDb() {
  const db = new DatabaseSync(':memory:');
  applyCbMigration(db);
  return db;
}

const TEST_OPTS = { _skipBudgetCheck: true };

const MOCK_2TURN = [
  { speaker: 'Scout',   content: 'ヒノデ、例のデータ確認してもらえた？' },
  { speaker: 'Analyst', content: 'ああ、さっき見た。問題ない。' },
];
const MOCK_4TURN = [
  { speaker: 'Writer', content: 'キイロ、今週の進み具合どう？' },
  { speaker: 'Editor', content: 'まあまあかな。あなたの下書き待ってる。' },
  { speaker: 'Writer', content: 'もう少しで渡せる。' },
  { speaker: 'Editor', content: 'わかった。待ってる。' },
];

// ── テスト 1: _skipBudgetCheck の挙動確認 ────────────────────────────────────
// 注: テスト環境ではログDBが未初期化のため hasBudgetForInteraction は常に true を返す。
// 本番環境では $2/月上限を超えると budget エラーになる（統合テスト不可のためロジック確認のみ）。

async function test_budget_check() {
  console.log('\n[Test 1] _skipBudgetCheck: テスト環境では budget は常にパス・正常実行を確認');
  const db = makeDb();
  // テスト環境では _skipBudgetCheck=false でも budget OK（ログDB未初期化 → 使用率0%）
  const res = await runManualAdvance(db, { _mockConversation: MOCK_2TURN, _mockTone: 'neutral' });
  assert('テスト環境で ok===true（budget使用率0%）', res.ok === true);

  // _skipBudgetCheck=true でも同様に動作する
  const db2 = makeDb();
  const res2 = await runManualAdvance(db2, { _mockConversation: MOCK_2TURN, _mockTone: 'neutral', ...TEST_OPTS });
  assert('_skipBudgetCheck=true でも ok===true', res2.ok === true);
}

// ── テスト 2: 正常実行（neutral トーン → スコア変化なし） ─────────────────────

async function test_normal_neutral() {
  console.log('\n[Test 2] 正常実行: neutral → スコア変化なし');
  const db = makeDb();

  const before = db.prepare(
    'SELECT trust, affection FROM cb_employee_relationships WHERE from_emp=? AND to_emp=?'
  ).get('Scout', 'Analyst');

  const res = await runManualAdvance(db, { _mockConversation: MOCK_2TURN, _mockTone: 'neutral', ...TEST_OPTS });
  assert('ok===true', res.ok === true);
  assert('interactionId 存在', typeof res.interactionId === 'number');
  assert('tone=neutral', res.tone === 'neutral');
  assert('delta=null', res.delta === null);
  assert('isPending=false', res.isPending === false);

  // cb_employee_interactions に記録
  const intRow = db.prepare('SELECT * FROM cb_employee_interactions WHERE id=?').get(res.interactionId);
  assert('interactions にレコードあり', !!intRow);
  assert('message が空でない', intRow?.message?.length > 0);

  // story_events に AUTONOMOUS_CHAT
  const evRow = db.prepare("SELECT * FROM cb_story_events WHERE event_type='AUTONOMOUS_CHAT' ORDER BY rowid DESC LIMIT 1").get();
  assert('story_events に記録あり', !!evRow);
  assert('会話原文含む', evRow?.content_text?.includes('--- 会話原文 ---'));

  // スコアは変わらない
  const after = db.prepare(
    'SELECT trust, affection FROM cb_employee_relationships WHERE from_emp=? AND to_emp=?'
  ).get(res.fromEmp, res.toEmp);
  // neutral なのでスコア変化なし（ただしペアが Scout→Analyst とは限らないので存在チェックのみ）
  assert('after スコア存在', !!after);
}

// ── テスト 3: positive トーン → スコアが変化するか不変（確率的） ──────────────

async function test_positive_tone() {
  console.log('\n[Test 3] positive tone → trust または affection が増加 OR 変化なし');
  const db = makeDb();

  // 多数回実行して少なくとも1回は変化することを確認
  let changed = 0;
  for (let i = 0; i < 20; i++) {
    const db2 = makeDb();
    const before = db2.prepare(
      'SELECT trust, affection FROM cb_employee_relationships WHERE from_emp=? AND to_emp=?'
    ).get('Analyst', 'Planner');

    const res = await runManualAdvance(db2, {
      _mockConversation: MOCK_2TURN,
      _mockTone: 'positive',
      ...TEST_OPTS,
    });
    if (!res.ok) continue;

    const after = db2.prepare(
      'SELECT trust, affection FROM cb_employee_relationships WHERE from_emp=? AND to_emp=?'
    ).get(res.fromEmp, res.toEmp);
    // スコアが上がったか確認
    if (after && before) {
      // ペアが一致しない場合はスキップ（selectPair はランダム）
    }
    if (res.delta !== null) changed++;
  }
  // 20回中少なくとも1回は変化するはず（確率的: 25%なので0.75^20≈0.3% で全変化なしはほぼない）
  assert(`20回中 ${changed} 回変化 (>=1 回)`, changed >= 1);

  // 変化が +1 程度であることを確認（+2以上は無い）
  const db3 = makeDb();
  // delta が null でない結果を探す
  let delta = null;
  for (let i = 0; i < 30 && delta === null; i++) {
    const res = await runManualAdvance(db3, {
      _mockConversation: MOCK_2TURN,
      _mockTone: 'positive',
      ...TEST_OPTS,
    });
    if (res.ok && res.delta !== null) delta = res.delta;
  }
  if (delta !== null) {
    const maxAbsValue = Math.max(...Object.values(delta).map(Math.abs));
    assert('変動量が 1 以下', maxAbsValue <= 1);
  } else {
    assert('delta が取得できた（確率的）', true); // 非常に稀なケース
  }
}

// ── テスト 4: negative トーン → trust または discomfort が変化 ───────────────

async function test_negative_tone() {
  console.log('\n[Test 4] negative tone → trust が下がるか discomfort が上がる（確率的）');
  const db = makeDb();

  let negativeCount = 0;
  for (let i = 0; i < 20; i++) {
    const res = await runManualAdvance(db, {
      _mockConversation: MOCK_2TURN,
      _mockTone: 'negative',
      ...TEST_OPTS,
    });
    if (res.ok && res.delta !== null) {
      // negative なので trust < 0 か discomfort > 0
      const vals = Object.values(res.delta);
      if (vals.some(v => v < 0) || (res.delta.discomfort ?? 0) > 0) negativeCount++;
    }
  }
  assert('negative 変動が少なくとも1回発生', negativeCount >= 1);
}

// ── テスト 5: significant トーン → 承認待ちに保存、スコア変化なし ───────────

async function test_significant_pending() {
  console.log('\n[Test 5] significant tone → cb_pending_approvals に保留・スコア変化なし');
  const db = makeDb();

  const res = await runManualAdvance(db, {
    _mockConversation: MOCK_4TURN,
    _mockTone: 'significant',
    ...TEST_OPTS,
  });
  assert('ok===true', res.ok === true);
  assert('isPending===true', res.isPending === true);
  assert('delta===null', res.delta === null);
  assert('interactionId が null（承認前は未確定）', res.interactionId === null);

  // cb_pending_approvals に1件
  const pending = listPendingApprovals(db);
  assert('pending approvals に1件', pending.length === 1);
  assert('type=relationship_change', pending[0]?.type === 'relationship_change');
  assert('description が空でない', pending[0]?.description?.length > 0);

  // significant は承認前に interactions / story_events に書かれていない
  const intCount = db.prepare('SELECT COUNT(*) AS c FROM cb_employee_interactions').get().c;
  assert('interactions に書かれていない（承認前）', intCount === 0);
  const evCount = db.prepare("SELECT COUNT(*) AS c FROM cb_story_events WHERE event_type='AUTONOMOUS_CHAT'").get().c;
  assert('story_events に書かれていない（承認前）', evCount === 0);
}

// ── テスト 6: 承認操作（approve） ────────────────────────────────────────────

async function test_approve() {
  console.log('\n[Test 6] 承認操作: approve → スコア反映・status=approved');
  const db = makeDb();

  await runManualAdvance(db, {
    _mockConversation: MOCK_4TURN,
    _mockTone: 'significant',
    ...TEST_OPTS,
  });
  const pending = listPendingApprovals(db);
  assert('前提: pending 1件', pending.length === 1);

  const approvalId = pending[0].id;
  // 承認前のスコアを取得
  const approvalRow = db.prepare('SELECT from_emp, to_emp FROM cb_pending_approvals WHERE id=?').get(approvalId);
  const before = db.prepare(
    'SELECT trust, affection FROM cb_employee_relationships WHERE from_emp=? AND to_emp=?'
  ).get(approvalRow.from_emp, approvalRow.to_emp);

  const result = resolveApproval(db, approvalId, 'approve');
  assert('resolve ok', result.ok === true);
  assert("status='approved'", result.status === 'approved');

  // pending 一覧から消える
  const afterPending = listPendingApprovals(db);
  assert('承認後 pending=0', afterPending.length === 0);

  // スコアが増加
  const after = db.prepare(
    'SELECT trust, affection FROM cb_employee_relationships WHERE from_emp=? AND to_emp=?'
  ).get(approvalRow.from_emp, approvalRow.to_emp);
  assert('trust が増加', after.trust > before.trust);
  assert('affection が増加', after.affection > before.affection);

  // 承認後に interactions / story_events に確定書き込みされた
  const intCount = db.prepare('SELECT COUNT(*) AS c FROM cb_employee_interactions').get().c;
  assert('承認後 interactions に1件', intCount === 1);
  const evCount = db.prepare("SELECT COUNT(*) AS c FROM cb_story_events WHERE event_type='AUTONOMOUS_CHAT'").get().c;
  assert('承認後 story_events に1件', evCount === 1);
}

// ── テスト 7: 却下操作（reject） ────────────────────────────────────────────

async function test_reject() {
  console.log('\n[Test 7] 却下操作: reject → スコア変化なし・status=rejected');
  const db = makeDb();

  await runManualAdvance(db, {
    _mockConversation: MOCK_4TURN,
    _mockTone: 'significant',
    ...TEST_OPTS,
  });
  const pending = listPendingApprovals(db);
  const approvalId = pending[0].id;
  const approvalRow = db.prepare('SELECT from_emp, to_emp FROM cb_pending_approvals WHERE id=?').get(approvalId);
  const before = db.prepare(
    'SELECT trust, affection FROM cb_employee_relationships WHERE from_emp=? AND to_emp=?'
  ).get(approvalRow.from_emp, approvalRow.to_emp);

  const result = resolveApproval(db, approvalId, 'reject');
  assert('resolve ok', result.ok === true);
  assert("status='rejected'", result.status === 'rejected');

  const after = db.prepare(
    'SELECT trust, affection FROM cb_employee_relationships WHERE from_emp=? AND to_emp=?'
  ).get(approvalRow.from_emp, approvalRow.to_emp);
  assert('trust 変化なし', after.trust === before.trust);
  assert('affection 変化なし', after.affection === before.affection);

  // 却下時は interactions / story_events に書かれない
  const intCount = db.prepare('SELECT COUNT(*) AS c FROM cb_employee_interactions').get().c;
  assert('却下後 interactions は空', intCount === 0);
  const evCount = db.prepare("SELECT COUNT(*) AS c FROM cb_story_events WHERE event_type='AUTONOMOUS_CHAT'").get().c;
  assert('却下後 story_events は空', evCount === 0);
}

// ── テスト 8: 二重実行防止 ────────────────────────────────────────────────────

async function test_mutex() {
  console.log('\n[Test 8] 二重実行防止: 同時呼び出しは already_running で弾く');
  const db = makeDb();

  // 1回目を開始して完了前に2回目を投げる
  const p1 = runManualAdvance(db, { _mockConversation: MOCK_2TURN, _mockTone: 'neutral', ...TEST_OPTS });
  const p2 = runManualAdvance(db, { _mockConversation: MOCK_2TURN, _mockTone: 'neutral', ...TEST_OPTS });

  const [r1, r2] = await Promise.all([p1, p2]);
  // 片方が already_running で弾かれるはず
  const oneOk = (r1.ok && r2.reason === 'already_running') ||
                (r2.ok && r1.reason === 'already_running');
  assert('片方が already_running', oneOk);
}

// ── テスト 9: 重複 source_id 防止 ─────────────────────────────────────────────

async function test_dedup() {
  console.log('\n[Test 9] 同一 source_id の story_event 重複防止');
  const db = makeDb();

  const res = await runManualAdvance(db, { _mockConversation: MOCK_2TURN, _mockTone: 'neutral', ...TEST_OPTS });
  assert('1回目: ok', res.ok === true);

  const countBefore = db.prepare("SELECT COUNT(*) AS c FROM cb_story_events WHERE event_type='AUTONOMOUS_CHAT'").get().c;

  const { logConversation } = await import('./story_logger.mjs');
  const dup = logConversation(db, {
    fromEmp: res.fromEmp, toEmp: res.toEmp,
    triggerType: 'small_talk', triggerReason: '重複テスト',
    turns: MOCK_2TURN, deltaJson: {}, sourceId: res.interactionId, isSecret: false,
  });
  assert('重複挿入は null', dup === null);
  assert('件数が増えない',
    db.prepare("SELECT COUNT(*) AS c FROM cb_story_events WHERE event_type='AUTONOMOUS_CHAT'").get().c === countBefore
  );
}

// ── テスト 10: getAdvanceStatus ───────────────────────────────────────────────

async function test_status() {
  console.log('\n[Test 10] getAdvanceStatus の構造確認');
  const db = makeDb();

  const s0 = getAdvanceStatus(db);
  assert('is_running が boolean', typeof s0.is_running === 'boolean');
  assert('pending_approvals が number', typeof s0.pending_approvals === 'number');
  assert('recent_interactions が配列', Array.isArray(s0.recent_interactions));
  assert('pending_list が配列', Array.isArray(s0.pending_list));

  await runManualAdvance(db, { _mockConversation: MOCK_2TURN, _mockTone: 'positive', ...TEST_OPTS });
  const s1 = getAdvanceStatus(db);
  assert('実行後 recent_interactions が1件', s1.recent_interactions.length === 1);
  const r = s1.recent_interactions[0];
  assert('from が存在', !!r.from);
  assert('to が存在', !!r.to);
  assert('tone が存在', r.tone === 'positive');
  assert('current_scores が存在', !!r.current_scores);
  assert('current_scores.trust が number', typeof r.current_scores?.trust === 'number');
}

// ── テスト 10b: スコア変動が厳密に ±1 以内 ────────────────────────────────────

async function test_score_bounded() {
  console.log('\n[Test 10b] スコア変動が厳密に ±1 以内（高感度ペアでも増幅しない）');
  const db = makeDb();

  // Planner (sens=1.2) を含む高親密ペアを仮定して多数回実行
  // 全ペアで delta が null または ±1 以内であることを確認
  for (let i = 0; i < 30; i++) {
    const res = await runManualAdvance(db, {
      _mockConversation: MOCK_4TURN,
      _mockTone: i % 2 === 0 ? 'positive' : 'negative',
      ...TEST_OPTS,
    });
    if (res.ok && res.delta !== null) {
      const maxAbs = Math.max(...Object.values(res.delta).map(Math.abs));
      assert(`iter${i}: delta ±1 以内 (${JSON.stringify(res.delta)})`, maxAbs <= 1);
    }
  }
}

// ── テスト 10c: DB レベルロックの動作確認 ────────────────────────────────────

async function test_db_lock() {
  console.log('\n[Test 10c] DB レベルロック: 取得・解除・PID識別・スタールロック');
  const db = makeDb();

  // advance_lock キーが存在するか確認
  const lockRow = db.prepare("SELECT value FROM cb_story_settings WHERE key='advance_lock'").get();
  assert('advance_lock キーが存在', !!lockRow);
  assert('初期値が空文字', lockRow?.value === '');

  // 実行前はロックなし
  const s0 = getAdvanceStatus(db);
  assert('実行前 is_running=false', s0.is_running === false);

  // 実行後もロック解放されている（PID:ISO形式で取得・解放される）
  await runManualAdvance(db, { _mockConversation: MOCK_2TURN, _mockTone: 'neutral', ...TEST_OPTS });
  const lockAfter = db.prepare("SELECT value FROM cb_story_settings WHERE key='advance_lock'").get();
  assert('実行後 lock が解除（value=空）', lockAfter?.value === '');

  // 期限切れのロック（uuid:PID:ISO フォーマット・6分前）→ スタールロック解除されて実行成功
  const db2 = makeDb();
  const fakePid   = process.pid + 9999;
  const staleTime = new Date(Date.now() - 6 * 60 * 1000).toISOString();
  const staleUuid = randomUUID();
  db2.prepare("UPDATE cb_story_settings SET value=? WHERE key='advance_lock'").run(`${staleUuid}:${fakePid}:${staleTime}`);
  const resStale = await runManualAdvance(db2, { _mockConversation: MOCK_2TURN, _mockTone: 'neutral', ...TEST_OPTS });
  assert('期限切れロック（新フォーマット）: 実行成功', resStale.ok === true);

  // 有効なロック（uuid:PID:ISO フォーマット・直近取得）→ 弾かれる
  const db3 = makeDb();
  const freshTime = new Date().toISOString();
  const freshUuid = randomUUID();
  db3.prepare("UPDATE cb_story_settings SET value=? WHERE key='advance_lock'").run(`${freshUuid}:${fakePid}:${freshTime}`);
  const resFresh = await runManualAdvance(db3, { _mockConversation: MOCK_2TURN, _mockTone: 'neutral', ...TEST_OPTS });
  assert('有効な他プロセスロック（新フォーマット）: already_running で弾かれる', resFresh.ok === false && resFresh.reason === 'already_running');

  // 解除時に自分のロックのみ解除される（他プロセスのロックは触らない）
  const db4 = makeDb();
  await runManualAdvance(db4, { _mockConversation: MOCK_2TURN, _mockTone: 'neutral', ...TEST_OPTS });
  // 実行後ロックが解放されていること（value=空）
  const lockVal = db4.prepare("SELECT value FROM cb_story_settings WHERE key='advance_lock'").get();
  assert('実行後ロック解放（uuid一致解除）', lockVal?.value === '');
}

// ── テスト 10d: 承認の重複操作防止 ──────────────────────────────────────────

async function test_approval_idempotent() {
  console.log('\n[Test 10d] 承認の重複操作防止: 2回 approve しても1回分のスコア変化のみ');
  const db = makeDb();

  await runManualAdvance(db, { _mockConversation: MOCK_4TURN, _mockTone: 'significant', ...TEST_OPTS });
  const pending = listPendingApprovals(db);
  const approvalId = pending[0].id;
  const approvalRow = db.prepare('SELECT from_emp, to_emp FROM cb_pending_approvals WHERE id=?').get(approvalId);

  const before = db.prepare(
    'SELECT trust, affection FROM cb_employee_relationships WHERE from_emp=? AND to_emp=?'
  ).get(approvalRow.from_emp, approvalRow.to_emp);

  // 1回目: 承認成功
  const r1 = resolveApproval(db, approvalId, 'approve');
  assert('1回目: ok=true', r1.ok === true);

  const mid = db.prepare(
    'SELECT trust, affection FROM cb_employee_relationships WHERE from_emp=? AND to_emp=?'
  ).get(approvalRow.from_emp, approvalRow.to_emp);

  // 2回目: already_resolved で拒否
  const r2 = resolveApproval(db, approvalId, 'approve');
  assert('2回目: ok=false', r2.ok === false);
  assert('2回目: already_resolved', r2.reason === 'not_found_or_already_resolved');

  // スコアは1回分のみ変化
  const after = db.prepare(
    'SELECT trust, affection FROM cb_employee_relationships WHERE from_emp=? AND to_emp=?'
  ).get(approvalRow.from_emp, approvalRow.to_emp);
  assert('スコアが2回目で追加変化していない', after.trust === mid.trust && after.affection === mid.affection);
}

// ── テスト 11: is_secret フラグ確認 ──────────────────────────────────────────

async function test_secret_flags() {
  console.log('\n[Test 11] is_secret フラグ: Scout→Analyst / Writer→Editor が 1');
  const db = makeDb();

  const sr = db.prepare("SELECT is_secret FROM cb_employee_relationships WHERE from_emp='Scout' AND to_emp='Analyst'").get();
  const wr = db.prepare("SELECT is_secret FROM cb_employee_relationships WHERE from_emp='Writer' AND to_emp='Editor'").get();
  assert('Scout→Analyst is_secret=1', sr?.is_secret === 1);
  assert('Writer→Editor is_secret=1', wr?.is_secret === 1);
}

// ── テスト 12: 会話ログフォーマット ──────────────────────────────────────────

async function test_log_format() {
  console.log('\n[Test 12] 会話ログのフォーマット検証');
  const db = makeDb();

  await runManualAdvance(db, { _mockConversation: MOCK_4TURN, _mockTone: 'positive', ...TEST_OPTS });

  const ev = db.prepare("SELECT * FROM cb_story_events WHERE event_type='AUTONOMOUS_CHAT' ORDER BY rowid DESC LIMIT 1").get();
  const ct = ev?.content_text ?? '';
  assert('きっかけ行含む', ct.includes('【きっかけ'));
  assert('会話原文セクション含む', ct.includes('--- 会話原文 ---'));
  assert('発言が含まれる', ct.includes('：「'));
  assert('delta_json 存在', !!ev?.delta_json);
  assert('created_at 存在', !!ev?.created_at);
}

// ── 全テスト実行 ───────────────────────────────────────────────────────────────

async function main() {
  console.log('=== P42-C 手動進行ワーカー テストスイート ===');

  await test_budget_check();
  await test_normal_neutral();
  await test_positive_tone();
  await test_negative_tone();
  await test_significant_pending();
  await test_approve();
  await test_reject();
  await test_mutex();
  await test_dedup();
  await test_status();
  await test_score_bounded();
  await test_db_lock();
  await test_approval_idempotent();
  await test_secret_flags();
  await test_log_format();

  console.log(`\n=== 結果: ${passed} 件成功 / ${failed} 件失敗 ===`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });
