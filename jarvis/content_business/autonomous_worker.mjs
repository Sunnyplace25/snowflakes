/**
 * content_business/autonomous_worker.mjs
 * Phase 42-C: AI社員 手動進行ワーカー（改訂版）
 *
 * 設計原則:
 *   1. 「少し進める」ボタン（POST /api/cb/autonomous/advance）からのみ実行される。
 *      時間経過・自動スケジュール・その他のトリガーでは一切動かない。
 *   2. 1回の操作で生成されるのは会話イベント1件のみ。
 *   3. 関係スコアの変動は1会話につき25%確率で整数 ±1 変動（期待値 ±0.25）。
 *      ※ updateRelationship を経由せず直接 DB 更新することで SENSITIVITY×relModifier による
 *        増幅（最大+2）を防止し、常に ±1 以内に固定する。
 *   4. 重要な関係変化・ストーリー転換は cb_pending_approvals に保留。オーナー承認後に確定。
 *   5. 二重実行を in-process mutex（同プロセス）+ DB レベルロック（複数プロセス対応）で防止。
 *      ロックは cb_story_settings.advance_lock で管理（空=未ロック）。5分で自動解除（クラッシュ対策）。
 *   6. AI予算 $2/月 制限を維持。超過・警告時は実行しない。
 *   7. 社員は既存の人格設定・口調に従って自律的に活動する。小説のために演技しない。
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { callClaude } from '../shared/claude_router.mjs';
import {
  hasBudgetForInteraction,
  getRelationshipContext,
} from './relationship_manager.mjs';
import { logConversation } from './story_logger.mjs';

// ── スコア境界値（cb_employee_relationships の CHECK 制約と一致させる） ────────
const SCORE_BOUNDS = {
  trust:             { min: -100, max: 100 },
  affection:         { min: -100, max: 100 },
  respect:           { min: -100, max: 100 },
  rivalry:           { min:    0, max: 100 },
  discomfort:        { min:    0, max: 100 },
  romantic_interest: { min:    0, max: 100 },
};

const __dirname = dirname(fileURLToPath(import.meta.url));
const PERSONALITIES_PATH = resolve(__dirname, '../config/employee_personalities.json');

const ALL_EMPS = ['Scout', 'Analyst', 'Planner', 'Writer', 'Editor', 'Growth'];

const EMP_NAME = {
  Scout:   'ヒカゲ',
  Analyst: 'ヒノデ',
  Planner: 'アサヒ',
  Writer:  'ソラ',
  Editor:  'キイロ',
  Growth:  'アオ',
};

let _personalities = null;
function getPersonalities() {
  if (!_personalities) {
    try { _personalities = JSON.parse(readFileSync(PERSONALITIES_PATH, 'utf8')); }
    catch (_) { _personalities = {}; }
  }
  return _personalities;
}

// ── 二重実行防止ロック ────────────────────────────────────────────────────────
// 2層構造:
//   Layer 1: in-process mutex (_isRunning) — 同一プロセス内の同時呼び出しを即時拒否
//   Layer 2: DB レベルロック (advance_lock) — 複数プロセス起動時の二重実行を防止
//             5分経過した古いロックはクラッシュ後のリカバリとして自動解除する

let _isRunning = false;
const LOCK_TIMEOUT_MS = 5 * 60 * 1000; // 5分

// 現在このプロセスが保持しているロック値（取得時に設定・解除時にクリア）
// 解除時にこの値と DB の値を比較することで、他プロセスのロックを誤解除しない
let _currentLockValue = null;

/**
 * DB レベルのロックを取得する。
 *
 * ロック値フォーマット: "uuid:PID:ISO_DATETIME"
 *   - uuid   : 実行ごとに一意なID。解除時の照合に使用する
 *   - PID    : プロセス識別子
 *   - ISO    : 取得日時（スタールロック判定に使用）
 *
 * 解除条件（ロックが既に存在する場合）:
 *   - 自プロセスの残存ロック（uuid が _currentLockValue と一致）→ 解除して再取得
 *   - 期限切れ（5分以上経過）→ スタールロックとして解除
 *   - 有効な他プロセスのロック → 解除しない（アトミック UPDATE が失敗して自然に弾く）
 */
function _tryAcquireDbLock(db) {
  try {
    const row = db.prepare("SELECT value FROM cb_story_settings WHERE key='advance_lock'").get();
    if (row?.value) {
      const parts    = row.value.split(':');
      // フォーマット: uuid(0):PID(1):ISO_DATE(2):ISO_TIME(3) ※ISO日時にも : が含まれる
      const lockUuid = parts[0];
      const lockPid  = parseInt(parts[1] ?? '', 10);
      const lockTime = parts.slice(2).join(':');
      const elapsed  = Date.now() - new Date(lockTime).getTime();

      if (row.value === _currentLockValue) {
        // 自プロセスの残存ロック（in-process mutex が前で弾くはずだが念のため）
        console.warn('[P42-C] 自プロセスの残存ロック (uuid=' + lockUuid + ') を解除します');
        db.prepare("UPDATE cb_story_settings SET value='' WHERE key='advance_lock'").run();
        _currentLockValue = null;
      } else if (elapsed > LOCK_TIMEOUT_MS) {
        // 期限切れのスタールロック → 解除（uuid が違うので別プロセスまたは前回実行の残存）
        console.warn('[P42-C] stale DB lock を解除しました (PID ' + lockPid + ', uuid=' + lockUuid + ', 経過: ' + Math.round(elapsed / 60000) + '分)');
        db.prepare("UPDATE cb_story_settings SET value='' WHERE key='advance_lock'").run();
      }
      // それ以外（有効な他プロセスのロック）→ 解除しない
    }

    // 実行ごとに一意なロック値を生成してアトミックに取得
    const newLockValue = `${randomUUID()}:${process.pid}:${new Date().toISOString()}`;
    const result = db.prepare(
      "UPDATE cb_story_settings SET value=? WHERE key='advance_lock' AND value=''"
    ).run(newLockValue);

    if (result.changes === 1) {
      _currentLockValue = newLockValue; // 解除時の照合用に保持
      return true;
    }
    return false;
  } catch (_) {
    return false; // DB 操作失敗時は安全側に倒す
  }
}

/**
 * DB レベルのロックを解除する。
 * 自プロセスが取得したロック値 (_currentLockValue) と一致する場合のみ解除する。
 * 他プロセスがロックを再取得済みの場合は何もしない。
 */
function _releaseDbLock(db) {
  try {
    if (!_currentLockValue) return;
    // WHERE value=? で自分のロックのみ解除（他プロセスのロックは触らない）
    db.prepare(
      "UPDATE cb_story_settings SET value='' WHERE key='advance_lock' AND value=?"
    ).run(_currentLockValue);
    _currentLockValue = null;
  } catch (_) { /* 解除失敗は無視（5分後に自動解除） */ }
}

// ── ペア選択 ──────────────────────────────────────────────────────────────────

/**
 * 交流ペアを選択する。
 *   40% 高親密ペア (trust>=55 AND affection>=40)
 *   40% ランダム同僚（直近未交流を優先）
 *   20% 偶発（交流頻度が最も低いペア）
 */
function selectPair(db) {
  const rand = Math.random();

  if (rand < 0.40) {
    const row = db.prepare(`
      SELECT from_emp, to_emp FROM cb_employee_relationships
      WHERE trust >= 55 AND affection >= 40
      ORDER BY RANDOM() LIMIT 1
    `).get();
    if (row) return { fromEmp: row.from_emp, toEmp: row.to_emp, pairType: 'high_affinity' };
  }

  if (rand < 0.80) {
    const recentPairs = new Set(
      db.prepare(`
        SELECT from_emp || '-' || to_emp AS pair
        FROM cb_employee_interactions
        ORDER BY created_at DESC LIMIT 20
      `).all().map(r => r.pair)
    );
    const pool = [];
    for (const f of ALL_EMPS) {
      for (const t of ALL_EMPS) {
        if (f === t) continue;
        pool.push({ fromEmp: f, toEmp: t, score: recentPairs.has(`${f}-${t}`) ? 0 : 1 });
      }
    }
    pool.sort((a, b) => b.score - a.score || Math.random() - 0.5);
    if (pool[0]) return { fromEmp: pool[0].fromEmp, toEmp: pool[0].toEmp, pairType: 'random' };
  }

  // 偶発: 交流頻度が最も低いペア
  const row = db.prepare(`
    SELECT r.from_emp, r.to_emp, COUNT(i.id) AS cnt
    FROM cb_employee_relationships r
    LEFT JOIN cb_employee_interactions i ON i.from_emp = r.from_emp AND i.to_emp = r.to_emp
    GROUP BY r.from_emp, r.to_emp
    ORDER BY cnt ASC, RANDOM() LIMIT 1
  `).get();
  if (row) return { fromEmp: row.from_emp, toEmp: row.to_emp, pairType: 'incidental' };

  const emps = [...ALL_EMPS].sort(() => Math.random() - 0.5);
  return { fromEmp: emps[0], toEmp: emps[1], pairType: 'fallback' };
}

// ── きっかけ決定 ──────────────────────────────────────────────────────────────

const TRIGGERS = {
  work: (f, t) => [
    `${f}が${t}に最近の案件の進め方について一言かけた`,
    `${f}が${t}に仕事の手順を確認したいことがあって声をかけた`,
    `${f}が${t}に共有しておきたいことがあって話しかけた`,
  ],
  rival: (f, t) => [
    `${f}が${t}のやり方について気になることがあって声をかけた`,
    `${f}と${t}が同じデータに対して異なる解釈をしていた`,
  ],
  small_talk: (f, t) => [
    `${f}が${t}に業務とは関係のない話を持ちかけた`,
    `${f}が${t}に最近気づいたことを話した`,
    `${f}が作業の合間に${t}に声をかけた`,
  ],
  incidental: (f, t) => [
    `${f}と${t}が社内ですれ違い、一言交わした`,
    `${f}が${t}の様子が気になってひとこと声をかけた`,
  ],
  help: (f, t) => [
    `${f}が${t}にちょっとした相談を持ちかけた`,
    `${f}が${t}に確認したいことがあって話しかけた`,
  ],
};

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function decideTrigger(db, fromEmp, toEmp, pairType) {
  const fromName = EMP_NAME[fromEmp];
  const toName   = EMP_NAME[toEmp];
  const rel = db.prepare(
    'SELECT rivalry, discomfort FROM cb_employee_relationships WHERE from_emp=? AND to_emp=?'
  ).get(fromEmp, toEmp);

  const hasActiveProject = !!db.prepare(
    "SELECT id FROM cb_projects WHERE status NOT IN ('PUBLISHED','CANCELLED','ERROR','DROPPED') LIMIT 1"
  ).get();

  if (pairType === 'incidental') {
    return { triggerType: 'incidental', triggerReason: pick(TRIGGERS.incidental(fromName, toName)) };
  }
  if (rel?.rivalry >= 50 && Math.random() < 0.4) {
    return { triggerType: 'autonomous', triggerReason: pick(TRIGGERS.rival(fromName, toName)) };
  }
  if (hasActiveProject && pairType === 'high_affinity' && Math.random() < 0.55) {
    return { triggerType: 'autonomous', triggerReason: pick(TRIGGERS.work(fromName, toName)) };
  }
  if (Math.random() < 0.2) {
    return { triggerType: 'help', triggerReason: pick(TRIGGERS.help(fromName, toName)) };
  }
  return { triggerType: 'small_talk', triggerReason: pick(TRIGGERS.small_talk(fromName, toName)) };
}

// ── 会話生成 ──────────────────────────────────────────────────────────────────

/**
 * 過去の交流トピック（多様性確保用）
 */
function getRecentTopics(db, fromEmp, toEmp, limit = 5) {
  return db.prepare(`
    SELECT message, trigger_type, session_date
    FROM cb_employee_interactions
    WHERE (from_emp=? AND to_emp=?) OR (from_emp=? AND to_emp=?)
    ORDER BY created_at DESC LIMIT ?
  `).all(fromEmp, toEmp, toEmp, fromEmp, limit);
}

/**
 * Claude に会話全体を生成させる。
 * tone フィールドを付加して、感情的な重みを判断させる。
 *
 * @returns {{ turns, tone, tokenCount }}
 */
async function generateConversation(db, fromEmp, toEmp, triggerType, triggerReason, numTurns) {
  const personalities = getPersonalities();
  const fromP = personalities[fromEmp];
  const toP   = personalities[toEmp];
  if (!fromP || !toP) throw new Error(`人格設定が見つかりません: ${fromEmp}, ${toEmp}`);

  const fromName = EMP_NAME[fromEmp];
  const toName   = EMP_NAME[toEmp];

  const fromCtx = getRelationshipContext(db, fromEmp);
  const toCtx   = getRelationshipContext(db, toEmp);

  const recent = getRecentTopics(db, fromEmp, toEmp, 5);
  const recentText = recent.length > 0
    ? recent.map(r => `  [${r.session_date} ${r.trigger_type}] ${r.message.slice(0, 50)}`).join('\n')
    : '  （まだ交流記録なし）';

  const proj = db.prepare(
    "SELECT theme, status FROM cb_projects WHERE status NOT IN ('PUBLISHED','CANCELLED','ERROR','DROPPED') ORDER BY updated_at DESC LIMIT 1"
  ).get();

  const turnTemplate = [
    `{"speaker":"${fromEmp}","content":"（${fromName}の最初の発言）"}`,
    `{"speaker":"${toEmp}","content":"（${toName}の返答）"}`,
    ...(numTurns >= 3 ? [`{"speaker":"${fromEmp}","content":"（${fromName}の返し）"}`] : []),
    ...(numTurns >= 4 ? [`{"speaker":"${toEmp}","content":"（${toName}の締め）"}`] : []),
  ].join(',\n  ');

  const systemPrompt = `あなたは「山吹ことり」が運営するバーチャルオフィスの会話シミュレーターです。
AI社員6名の人格・口調に従い、自然な会話を生成します。

【社員プロフィール】
▼ ${fromName}（${fromEmp}）
  人格: ${fromP.personality}
  口調: ${fromP.speech_style}

▼ ${toName}（${toEmp}）
  人格: ${toP.personality}
  口調: ${toP.speech_style}

${fromCtx ? `【${fromName}の内面的な対人感覚（機密）】\n${fromCtx}\n` : ''}${toCtx ? `\n【${toName}の内面的な対人感覚（機密）】\n${toCtx}\n` : ''}
【過去の交流（類似した展開・トピックは避けること）】
${recentText}

${proj ? `【現在進行中のプロジェクト】\n  テーマ: ${proj.theme ?? '（未設定）'} / 状態: ${proj.status}\n` : ''}
【生成ルール】
1. 各社員の人格・口調を厳守する
2. 恋愛感情・対立を無理に演出しない（自然に滲む程度は可）
3. 存在しない重要な出来事を作らない
4. 過去の交流と異なる話題・展開を選ぶ
5. 各発言は短く自然に（1〜3文程度）
6. 地の文・説明なし。台詞のみ
7. 内面の秘密感情は絶対に直接出さない

【tone フィールドの判断基準】
- "positive"     : 信頼・親しみが自然に高まった会話
- "neutral"      : 普通の業務的・日常的なやりとり
- "negative"     : 摩擦・不快感・距離感が生まれた会話
- "significant"  : 関係の転換点になりうる重要な会話（告白・重大な衝突・深い打ち明け話など）
                   ※日常的な会話では significant にしないこと`;

  const userMessage = `【今回の会話きっかけ】
${triggerReason}

${fromName}から${toName}への会話を ${numTurns} ターン生成してください。
最初の発言は ${fromName} です。

以下の JSON 形式のみで出力してください（前後に説明テキスト不要）:
{
  "tone": "positive|neutral|negative|significant",
  "turns": [
    ${turnTemplate}
  ]
}`;

  const raw = await callClaude(systemPrompt, userMessage, {
    tier:      'CHEAP',
    maxTokens: 600,
    task:      'autonomous_chat',
    domain:    'business',
    employee:  fromEmp,
  });

  try {
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('JSON object not found');
    const parsed = JSON.parse(match[0]);
    const tone  = ['positive','neutral','negative','significant'].includes(parsed.tone)
                    ? parsed.tone : 'neutral';
    const turns = (parsed.turns ?? [])
      .filter(t => t && typeof t.speaker === 'string' && typeof t.content === 'string')
      .map(t => ({ speaker: t.speaker.trim(), content: t.content.trim() }));
    if (turns.length === 0) throw new Error('No valid turns');
    return { turns, tone, tokenCount: Math.ceil(raw.length / 2) };
  } catch (parseErr) {
    console.warn('[P42-C] JSON parse error, fallback to raw:', parseErr.message);
    return {
      turns: [{ speaker: fromEmp, content: raw.trim().slice(0, 300) }],
      tone: 'neutral',
      tokenCount: Math.ceil(raw.length / 2),
    };
  }
}

// ── スコア変動（確率的 ±0.5・厳密に ±1 以内） ──────────────────────────────────

/**
 * 会話のトーンに基づいて関係スコアを直接 ±1 更新する。
 *
 * tone = "neutral"     → 変化なし
 * tone = "significant" → 変化なし（cb_pending_approvals に保留）
 * tone = "positive"    → 25%確率で {trust:+1} または {affection:+1}（期待値 ≤ +0.25）
 * tone = "negative"    → 25%確率で {trust:-1} または {discomfort:+1}（期待値 ≥ -0.25）
 *
 * ※ updateRelationship を経由しない理由:
 *    SENSITIVITY(max 1.2) × relModifier(max 1.3) = 最大 1.56 → Math.round → 2 になりうるため。
 *    手動進行の会話変動は常に ±1 以内に固定し、SENSITIVITY スケールは業務イベントにのみ適用する。
 *
 * @returns {object|null} 適用したデルタ（null = 変化なし）
 */
function applyScoreDelta(db, fromEmp, toEmp, tone) {
  if (tone === 'neutral' || tone === 'significant') return null;

  // 25%の確率でスコアを変動させる（期待値 ±0.25 に抑える・変動量は整数 ±1）
  if (Math.random() < 0.25) {
    const delta = tone === 'positive'
      ? (Math.random() < 0.5 ? { trust: +1 } : { affection: +1 })
      : (Math.random() < 0.5 ? { trust: -1 } : { discomfort: +1 });

    // 双方向に直接 DB 更新（SENSITIVITY×relModifier バイパス）
    for (const [fwd, rev] of [[fromEmp, toEmp], [toEmp, fromEmp]]) {
      for (const [dim, change] of Object.entries(delta)) {
        if (!change || !(dim in SCORE_BOUNDS)) continue;
        const { min, max } = SCORE_BOUNDS[dim];
        const row = db.prepare(
          `SELECT ${dim} FROM cb_employee_relationships WHERE from_emp=? AND to_emp=?`
        ).get(fwd, rev);
        if (!row) continue;
        const newVal = Math.max(min, Math.min(max, row[dim] + change));
        if (newVal === row[dim]) continue; // 変化なし（境界値に当たった場合）
        db.prepare(
          `UPDATE cb_employee_relationships SET ${dim}=?, updated_at=datetime('now','localtime') WHERE from_emp=? AND to_emp=?`
        ).run(newVal, fwd, rev);
      }
    }

    return delta;
  }

  return null; // 75%の確率でスコア変動なし
}

// ── 承認待ちイベント保存 ──────────────────────────────────────────────────────

/**
 * "significant" な会話を cb_pending_approvals に保存する。
 * interactions / story_events には書かず、承認後に初めて確定する。
 * 却下時は pending_approvals の status が 'rejected' になるのみで、履歴には残らない。
 *
 * @param {object} opts
 * @param {string}   opts.fromEmp
 * @param {string}   opts.toEmp
 * @param {string}   opts.triggerType
 * @param {string}   opts.triggerReason
 * @param {Array}    opts.turns
 * @param {string}   opts.sessionDate  - YYYY-MM-DD（承認後の interactions 保存に使用）
 */
function storePendingApproval(db, { fromEmp, toEmp, triggerType, triggerReason, turns, sessionDate }) {
  const fromName = EMP_NAME[fromEmp] ?? fromEmp;
  const toName   = EMP_NAME[toEmp]   ?? toEmp;
  const preview  = turns.map(t => `${EMP_NAME[t.speaker] ?? t.speaker}:「${t.content.slice(0, 30)}…」`).join(' / ');

  const description = `【重要な会話イベント】${fromName}と${toName}の間で関係の転換点となる可能性のある会話が発生しました。\n\nきっかけ: ${triggerReason}\n\nプレビュー: ${preview}`;

  // data_json に承認後の確定処理に必要な全データを保存する
  const dataJson = JSON.stringify({ fromEmp, toEmp, triggerType, triggerReason, turns, sessionDate });

  db.prepare(`
    INSERT INTO cb_pending_approvals
      (type, from_emp, to_emp, description, data_json, source_interaction_id)
    VALUES ('relationship_change', ?, ?, ?, ?, NULL)
  `).run(fromEmp, toEmp, description, dataJson);
}

// ── メインエクスポート ─────────────────────────────────────────────────────────

/**
 * 「少し進める」を1回実行する。
 * POST /api/cb/autonomous/advance から呼び出す。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} [opts]
 * @param {Array}   [opts._mockConversation] - テスト用モック会話（Claude を呼ばない）
 * @param {string}  [opts._mockTone]         - テスト用モックトーン
 * @param {boolean} [opts._skipBudgetCheck]  - テスト用: 予算チェックをスキップ（本番では使わない）
 */
export async function runManualAdvance(db, {
  _mockConversation = null,
  _mockTone = null,
  _skipBudgetCheck = false,
} = {}) {
  // ① 二重実行防止（Layer 1: in-process mutex）
  if (_isRunning) {
    console.log('[P42-C] 実行中のため重複リクエストをスキップ（in-process）');
    return { ok: false, reason: 'already_running' };
  }
  _isRunning = true;

  // ① 二重実行防止（Layer 2: DB レベルロック・複数プロセス対応）
  const dbLockAcquired = _tryAcquireDbLock(db);
  if (!dbLockAcquired) {
    _isRunning = false;
    console.log('[P42-C] 実行中のため重複リクエストをスキップ（DB lock）');
    return { ok: false, reason: 'already_running' };
  }

  try {
    // ② 予算チェック（テスト時のみスキップ可）
    if (!_skipBudgetCheck && !hasBudgetForInteraction(db)) {
      return { ok: false, reason: 'budget' };
    }

    // ③ ペア選択
    const { fromEmp, toEmp, pairType } = selectPair(db);

    // ④ きっかけ決定
    const { triggerType, triggerReason } = decideTrigger(db, fromEmp, toEmp, pairType);

    const numTurns = triggerType === 'incidental' ? 2
                   : (2 + Math.floor(Math.random() * 3)); // 2〜4

    console.log(`[P42-C] 手動進行: ${EMP_NAME[fromEmp]} → ${EMP_NAME[toEmp]} (${triggerType}, ${numTurns}ターン)`);

    // ⑤ 会話生成
    let turns, tone, tokenCount;
    if (_mockConversation) {
      await Promise.resolve(); // ミューテックステスト用の非同期ポイント
      turns      = _mockConversation;
      tone       = _mockTone ?? 'neutral';
      tokenCount = turns.reduce((s, t) => s + t.content.length, 0);
    } else {
      ({ turns, tone, tokenCount } = await generateConversation(
        db, fromEmp, toEmp, triggerType, triggerReason, numTurns
      ));
    }

    if (!turns || turns.length === 0) {
      return { ok: false, reason: 'empty_response' };
    }

    const today = new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' });
    let interactionId = null;
    let delta         = null;
    let isPending     = false;

    if (tone === 'significant') {
      // ⑥〜⑨ significant: 承認待ちに完全保留
      // interactions / story_events には書かない。承認後に resolveApproval が確定する
      storePendingApproval(db, { fromEmp, toEmp, triggerType, triggerReason, turns, sessionDate: today });
      isPending = true;
      console.log(`[P42-C] 重要イベント → 承認待ちに保留（interactions/story_events への書き込みなし）`);
    } else {
      // ⑥ cb_employee_interactions に保存
      const firstTurn = turns[0];
      const restTurns = turns.slice(1);
      const replyText = restTurns.length > 0
        ? restTurns.map(t => `${EMP_NAME[t.speaker] ?? t.speaker}: ${t.content}`).join('\n')
        : null;
      const insertResult = db.prepare(`
        INSERT INTO cb_employee_interactions
          (session_date, from_emp, to_emp, trigger_type, message, reply, token_count)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(today, fromEmp, toEmp, triggerType, firstTurn.content, replyText, tokenCount);
      interactionId = Number(insertResult.lastInsertRowid);

      // ⑦ スコア変動（25%確率で ±1 整数・期待値 ±0.25）
      delta = applyScoreDelta(db, fromEmp, toEmp, tone);

      // ⑧ is_secret チェック
      const secretRow = db.prepare(
        'SELECT is_secret FROM cb_employee_relationships WHERE from_emp=? AND to_emp=?'
      ).get(fromEmp, toEmp);
      const isSecret = secretRow?.is_secret === 1;

      // ⑨ オフィス観察記録に保存
      logConversation(db, {
        fromEmp, toEmp,
        triggerType, triggerReason,
        turns,
        deltaJson: { tone, delta: delta ?? null, isPending: false },
        sourceId:  interactionId,
        isSecret,
      });
    }

    console.log(`[P42-C] 完了: tone=${tone}, delta=${JSON.stringify(delta)}, pending=${isPending}, interaction#${interactionId}`);
    return {
      ok: true,
      interactionId,
      fromEmp,
      toEmp,
      turns,
      tone,
      triggerType,
      triggerReason,
      delta,
      isPending,
    };

  } catch (e) {
    console.error('[P42-C] 手動進行エラー:', e.message);
    return { ok: false, reason: 'error', message: e.message };
  } finally {
    _releaseDbLock(db);
    _isRunning = false;
  }
}

/**
 * 現在の状態を返す（ダッシュボード API 用）。
 * 管理画面で確認できる情報:
 *   - 直近の会話: 誰と誰が・いつ・何のきっかけで会話したか
 *   - スコア変化: tone と delta_json（cb_story_events から取得）
 *   - 承認待ち: 件数と概要
 *   - 現在の関係スコア: 直近会話ペアの trust/affection/discomfort
 */
export function getAdvanceStatus(db) {
  const pendingCount = db.prepare(
    "SELECT COUNT(*) AS c FROM cb_pending_approvals WHERE status='pending'"
  ).get()?.c ?? 0;

  const pendingList = db.prepare(`
    SELECT id, from_emp, to_emp, description, created_at
    FROM cb_pending_approvals WHERE status='pending'
    ORDER BY created_at ASC LIMIT 5
  `).all().map(r => ({
    id:          r.id,
    from:        EMP_NAME[r.from_emp] ?? r.from_emp,
    to:          EMP_NAME[r.to_emp]   ?? r.to_emp,
    description: r.description.slice(0, 80) + (r.description.length > 80 ? '…' : ''),
    created_at:  r.created_at,
  }));

  // 直近5件の会話（cb_story_events から tone + delta_json も取得）
  const recentInteractions = db.prepare(`
    SELECT i.id, i.session_date, i.from_emp, i.to_emp, i.trigger_type,
           i.message, i.reply, i.token_count, i.created_at,
           e.delta_json AS story_delta_json
    FROM cb_employee_interactions i
    LEFT JOIN cb_story_events e
      ON e.source_type = 'cb_employee_interactions'
      AND e.source_id = i.id
      AND e.event_type = 'AUTONOMOUS_CHAT'
    ORDER BY i.created_at DESC LIMIT 5
  `).all();

  const interactions = recentInteractions.map(r => {
    let tone = null, delta = null;
    try {
      const d = JSON.parse(r.story_delta_json ?? 'null');
      if (d) { tone = d.tone ?? null; delta = d.delta ?? null; }
    } catch (_) {}

    // 現在の関係スコア（from→to 方向）
    const scores = db.prepare(
      'SELECT trust, affection, respect, discomfort, rivalry FROM cb_employee_relationships WHERE from_emp=? AND to_emp=?'
    ).get(r.from_emp, r.to_emp);

    return {
      id:            r.id,
      date:          r.session_date,
      from:          EMP_NAME[r.from_emp] ?? r.from_emp,
      to:            EMP_NAME[r.to_emp]   ?? r.to_emp,
      trigger_type:  r.trigger_type,
      message:       (r.message ?? '').slice(0, 80) + ((r.message?.length ?? 0) > 80 ? '…' : ''),
      tone,
      score_delta:   delta,
      current_scores: scores ? {
        trust:      scores.trust,
        affection:  scores.affection,
        discomfort: scores.discomfort,
      } : null,
      token_count:   r.token_count,
      created_at:    r.created_at,
    };
  });

  const dbLockRow = db.prepare("SELECT value FROM cb_story_settings WHERE key='advance_lock'").get();
  const dbLockActive = !!(dbLockRow?.value);

  return {
    is_running:         _isRunning || dbLockActive,
    pending_approvals:  pendingCount,
    pending_list:       pendingList,
    recent_interactions: interactions,
  };
}

/**
 * 承認待ちイベント一覧を返す。
 */
export function listPendingApprovals(db) {
  return db.prepare(`
    SELECT id, type, from_emp, to_emp, description, created_at, status
    FROM cb_pending_approvals
    WHERE status = 'pending'
    ORDER BY created_at ASC
  `).all().map(r => ({
    id:          r.id,
    type:        r.type,
    from:        EMP_NAME[r.from_emp] ?? r.from_emp,
    to:          EMP_NAME[r.to_emp]   ?? r.to_emp,
    description: r.description,
    created_at:  r.created_at,
  }));
}

/**
 * 承認待ちイベントを承認または却下する。
 *
 * @param {number} approvalId
 * @param {'approve'|'reject'} action
 * @returns {{ ok: boolean, reason?: string }}
 */
export function resolveApproval(db, approvalId, action) {
  if (!['approve', 'reject'].includes(action)) {
    return { ok: false, reason: 'invalid_action' };
  }

  const newStatus = action === 'approve' ? 'approved' : 'rejected';

  // アトミックな操作: WHERE status='pending' で同時リクエストによる二重適用を防ぐ
  // changes===0 の場合は「既に処理済み or 存在しない」なので何もしない
  const updateResult = db.prepare(`
    UPDATE cb_pending_approvals
    SET status=?, resolved_at=datetime('now','localtime')
    WHERE id=? AND status='pending'
  `).run(newStatus, approvalId);

  if (updateResult.changes === 0) {
    return { ok: false, reason: 'not_found_or_already_resolved' };
  }

  // 承認時: data_json から会話データを復元して interactions/story_events に確定書き込み + スコア反映
  if (action === 'approve') {
    try {
      const row = db.prepare('SELECT from_emp, to_emp, data_json FROM cb_pending_approvals WHERE id=?').get(approvalId);
      if (row) {
        const data = JSON.parse(row.data_json ?? '{}');
        const { fromEmp, toEmp, triggerType, triggerReason, turns, sessionDate } = data;

        // cb_employee_interactions に確定書き込み
        let newInteractionId = null;
        if (fromEmp && toEmp && turns?.length > 0) {
          const firstTurn = turns[0];
          const restTurns = turns.slice(1);
          const replyText = restTurns.length > 0
            ? restTurns.map(t => `${EMP_NAME[t.speaker] ?? t.speaker}: ${t.content}`).join('\n')
            : null;
          const tokenCount = turns.reduce((s, t) => s + (t.content?.length ?? 0), 0);
          const insertResult = db.prepare(`
            INSERT INTO cb_employee_interactions
              (session_date, from_emp, to_emp, trigger_type, message, reply, token_count)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(
            sessionDate ?? new Date().toLocaleDateString('sv-SE', { timeZone: 'Asia/Tokyo' }),
            fromEmp, toEmp,
            triggerType ?? 'autonomous',
            firstTurn.content,
            replyText,
            tokenCount
          );
          newInteractionId = Number(insertResult.lastInsertRowid);
        }

        // スコア変動を適用（significant 承認: trust+2, affection+1）
        const approvalDelta = { trust: +2, affection: +1 };
        if (fromEmp && toEmp) {
          for (const [fwd, rev] of [[fromEmp, toEmp], [toEmp, fromEmp]]) {
            for (const [dim, change] of Object.entries(approvalDelta)) {
              const { min, max } = SCORE_BOUNDS[dim];
              const scoreRow = db.prepare(
                `SELECT ${dim} FROM cb_employee_relationships WHERE from_emp=? AND to_emp=?`
              ).get(fwd, rev);
              if (!scoreRow) continue;
              const newVal = Math.max(min, Math.min(max, scoreRow[dim] + change));
              if (newVal !== scoreRow[dim]) {
                db.prepare(
                  `UPDATE cb_employee_relationships SET ${dim}=?, updated_at=datetime('now','localtime') WHERE from_emp=? AND to_emp=?`
                ).run(newVal, fwd, rev);
              }
            }
          }
        }

        // story_events に確定書き込み
        if (fromEmp && toEmp && turns?.length > 0) {
          const secretRow = db.prepare(
            'SELECT is_secret FROM cb_employee_relationships WHERE from_emp=? AND to_emp=?'
          ).get(fromEmp, toEmp);
          logConversation(db, {
            fromEmp, toEmp,
            triggerType: triggerType ?? 'autonomous',
            triggerReason: triggerReason ?? '（重要イベント・承認済み）',
            turns,
            deltaJson: { tone: 'significant', delta: approvalDelta, isPending: false },
            sourceId:  newInteractionId,
            isSecret:  secretRow?.is_secret === 1,
          });
        }

        console.log(`[P42-C] 承認確定: #${approvalId} → interactions#${newInteractionId} + trust+2/affection+1 反映`);
      }
    } catch (e) {
      console.warn('[P42-C] 承認スコア反映エラー:', e.message);
    }
  }

  return { ok: true, status: newStatus };
}
