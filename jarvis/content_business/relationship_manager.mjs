/**
 * content_business/relationship_manager.mjs
 * Phase 42-B: AI社員 関係変化ロジック
 *
 * 設計原則:
 *   1. 人格・口調は employee_personalities.json を厳守。スコアは裏方。
 *   2. 変化は「各社員の性格」×「相手との関係履歴」×「イベント文脈」で決まる。
 *      単純な機械的加算は行わない。
 *   3. is_secret=1 行の romantic_interest / private_feeling は
 *      通常モード API に含めない。管理モードのみ公開。
 *   4. engine.mjs から setImmediate 経由で呼ぶこと。業務フローをブロックしない。
 *   5. source_job_id で同一ジョブの二重反映を防ぐ。
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getBudgetStatus } from '../shared/claude_router.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PERSONALITIES_PATH = resolve(__dirname, '../config/employee_personalities.json');

let _personalities = null;
function getPersonalities() {
  if (!_personalities) {
    try { _personalities = JSON.parse(readFileSync(PERSONALITIES_PATH, 'utf8')); }
    catch (_) { _personalities = {}; }
  }
  return _personalities;
}

// ── スコア制限 ─────────────────────────────────────────────────────────────────
//
// trust / affection / respect : -100〜+100
//   負値 = 不信・嫌い・軽蔑。通常業務で負値になることは稀だが、
//   長期的な関係悪化を表現できるよう下限を -100 に設定。
// rivalry / discomfort / romantic_interest : 0〜+100
//   「負のライバル意識」「負の不快感」は意味をなさないため 0 を下限とする。
//
const SCORE_LIMITS = {
  trust:             { min: -100, max: 100 },
  affection:         { min: -100, max: 100 },
  respect:           { min: -100, max: 100 },
  rivalry:           { min:    0, max: 100 },
  discomfort:        { min:    0, max: 100 },
  romantic_interest: { min:    0, max: 100 },
};

function clamp(val, min, max) { return Math.max(min, Math.min(max, val)); }

// ── 人格別 感情感度係数 ────────────────────────────────────────────────────────
//
// 1.0 が標準。感情変化の大きさはこの係数で調整される。
// ヒカゲ・アオは感情を外に出さず変化が遅い。アサヒは感情が豊かで変化しやすい。
//
const SENSITIVITY = {
  Scout:   0.7,   // 冷静・寡黙 → 変化が小さく遅い
  Analyst: 0.9,   // 穏やか・社交的 → 標準的
  Planner: 1.2,   // 明るく積極的 → 変化しやすい
  Writer:  1.1,   // 繊細 → 感情は動くが外に出しにくい
  Editor:  0.8,   // 理性的・厳格 → 変化は小さいが一度変わると根づく
  Growth:  0.7,   // 合理的・寡黙 → 変化が小さく遅い
};

// ── 関係状態による反応スケール ──────────────────────────────────────────────
//
// 既存の関係強度によって、同じイベントへの反応が変わる。
// 親密度が高いほど「普通の良い出来事」の影響は小さくなり、
// 「悪い出来事」の影響は大きくなる（裏切り効果）。
//
function computeRelationModifier(currentTrust, currentAffection, deltaIsPositive) {
  const closeness = (currentTrust + currentAffection) / 2; // -100〜100
  if (deltaIsPositive) {
    // 親密すぎると良い出来事の感動は減る（慣れ）。遠い関係なら小さな親切も響く。
    return closeness > 70 ? 0.7 : closeness > 40 ? 0.9 : 1.1;
  } else {
    // 親密だと裏切り・摩擦がより痛い。
    return closeness > 70 ? 1.3 : closeness > 40 ? 1.0 : 0.8;
  }
}

// ── 業務イベント 基本デルタ定義 ──────────────────────────────────────────────
//
// 「from_empがto_empに対してどう感じるか」の変化（送り手視点）。
// エンジンは各イベントで 2 方向（from→to, to→from）に別々のデルタを適用する。
//
const JOB_EVENT_BASE = {
  // Scout→Analyst へのデータ引き継ぎ（ヒカゲの視点）
  research_handoff_fwd: { trust: +2, respect: +2 },
  // Analyst → Scout への引き継ぎ受け取り（ヒノデの視点）
  research_handoff_rev: { trust: +2, affection: +1 },

  // Analyst→Planner への分析結果引き継ぎ
  analysis_handoff_fwd: { trust: +2, affection: +1 },
  // Planner → Analyst への引き継ぎ受け取り
  analysis_handoff_rev: { trust: +2, respect: +1 },

  // Planner→Writer への執筆依頼（選択された後）
  writing_handoff_fwd:  { trust: +1, affection: +1 },
  // Writer → Planner
  writing_handoff_rev:  { trust: +1 },

  // fwd = fromEmp(Writer/ソラ) → toEmp(Editor/キイロ) への感情変化
  // rev = toEmp(Editor/キイロ) → fromEmp(Writer/ソラ) への感情変化
  //
  // READY判定: ソラ視点（安堵・信頼感）/ キイロ視点（ソラへの評価上昇）
  editing_ready_fwd:    { trust: +5, affection: +3, discomfort: -3 },  // ソラのキイロへの感情
  editing_ready_rev:    { trust: +4, respect: +3, affection: +2 },     // キイロのソラへの感情

  // REVISION_REQUIRED: ソラ視点（不快感・短期的信頼低下）/ キイロ視点（仕事として正当、期待継続）
  editing_revision_fwd: { discomfort: +5, trust: -2 },  // ソラのキイロへの感情
  editing_revision_rev: { respect: +1 },                // キイロのソラへの感情（期待は変わらない）

  // BLOCKED: ソラ視点（強い不快感・信頼低下）/ キイロ視点（品質基準への信念・不満）
  editing_blocked_fwd:  { discomfort: +10, trust: -5 }, // ソラのキイロへの感情
  editing_blocked_rev:  { discomfort: +3, respect: -2 }, // キイロのソラへの感情

  // Growth: 売上分析完了（アオ→プロジェクト関係者全体への小さな影響）
  measuring_done_fwd:   { trust: +1 },
  measuring_done_rev:   { trust: +1 },
};

// ── 業務イベント → trigger_type マッピング ──────────────────────────────────
const TRIGGER_TYPE_MAP = {
  research_handoff_fwd:  'joint_work_success',
  research_handoff_rev:  'joint_work_success',
  analysis_handoff_fwd:  'joint_work_success',
  analysis_handoff_rev:  'joint_work_success',
  writing_handoff_fwd:   'joint_work_success',
  writing_handoff_rev:   'joint_work_success',
  editing_ready_fwd:     'joint_work_success',
  editing_ready_rev:     'joint_work_success',
  editing_revision_fwd:  'conflict',          // ソラが不快感を感じる
  editing_revision_rev:  'joint_work_success', // キイロは仕事として正当な行動
  editing_blocked_fwd:   'conflict',
  editing_blocked_rev:   'conflict',
  measuring_done_fwd:    'joint_work_success',
  measuring_done_rev:    'joint_work_success',
};

// ── 関係データ取得 ────────────────────────────────────────────────────────────

/**
 * 全30件の関係データを返す。
 *
 * 通常モード (managementMode=false):
 *   is_secret=1 の行では romantic_interest を 0、private_feeling を null として返す。
 *   公開態度 (public_attitude) や通常スコア (trust/affection/respect 等) は返す。
 *
 * 管理モード (managementMode=true):
 *   全フィールドをそのまま返す。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ managementMode?: boolean }} [opts]
 * @returns {Array}
 */
export function getRelationships(db, { managementMode = false } = {}) {
  const rows = db.prepare(`
    SELECT id, from_emp, to_emp,
           trust, affection, respect, rivalry, discomfort, romantic_interest,
           relationship_type, public_attitude, private_feeling, is_secret,
           last_interaction_at, updated_at
    FROM cb_employee_relationships
    ORDER BY id
  `).all();

  return rows.map(r => _sanitizeRow(r, managementMode));
}

/**
 * 特定ペアの関係データを返す。
 */
export function getRelationshipPair(db, fromEmp, toEmp, managementMode = false) {
  const row = db.prepare(`
    SELECT id, from_emp, to_emp,
           trust, affection, respect, rivalry, discomfort, romantic_interest,
           relationship_type, public_attitude, private_feeling, is_secret,
           last_interaction_at, updated_at
    FROM cb_employee_relationships WHERE from_emp = ? AND to_emp = ?
  `).get(fromEmp, toEmp);
  return row ? _sanitizeRow(row, managementMode) : null;
}

/** 通常モードで is_secret=1 行のセンシティブフィールドをマスク */
function _sanitizeRow(row, managementMode) {
  if (!managementMode && row.is_secret === 1) {
    return { ...row, romantic_interest: 0, private_feeling: null };
  }
  return row;
}

// ── 関係スコア更新（コア関数） ────────────────────────────────────────────────

/**
 * 関係スコアを更新する。
 *
 * 変化量の計算:
 *   実際の変化 = rawDelta × 人格感度 × 関係状態補正
 *   計算後は各スコアの上下限でクランプ。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} fromEmp        - 感情の主体（この社員の from_emp 行が更新される）
 * @param {string} toEmp
 * @param {object} delta          - 各次元の加算値
 * @param {object} [context]
 * @param {string} [context.triggerType]  - cb_employee_interactions に記録する場合
 * @param {string} [context.message]      - 記録用メッセージ
 * @param {number} [context.jobId]        - 二重反映防止用 job_id
 * @param {number} [context.projectId]
 */
export function updateRelationship(db, fromEmp, toEmp, delta, context = {}) {
  const row = db.prepare(
    'SELECT * FROM cb_employee_relationships WHERE from_emp=? AND to_emp=?'
  ).get(fromEmp, toEmp);
  if (!row) return;

  // 人格感度
  const sens = SENSITIVITY[fromEmp] ?? 1.0;

  // 変化量の正負を判定（複数次元の場合は合計で判定）
  const rawNet = Object.values(delta).reduce((s, v) => s + (v ?? 0), 0);
  const relationMod = computeRelationModifier(row.trust, row.affection, rawNet >= 0);

  const fields = [];
  const vals   = [];

  for (const [dim, rawDelta] of Object.entries(delta)) {
    if (!(dim in SCORE_LIMITS)) continue;
    if (!rawDelta) continue;
    const { min, max } = SCORE_LIMITS[dim];
    const current      = row[dim] ?? 0;
    const adjusted     = Math.round(rawDelta * sens * relationMod);
    if (adjusted === 0) continue;
    const newVal = clamp(current + adjusted, min, max);
    if (newVal === current) continue;
    fields.push(`${dim} = ?`);
    vals.push(newVal);
  }

  if (fields.length === 0) return;  // 実質変化なし

  fields.push("last_interaction_at = datetime('now','localtime')");
  fields.push("updated_at          = datetime('now','localtime')");
  vals.push(fromEmp, toEmp);

  db.prepare(
    `UPDATE cb_employee_relationships SET ${fields.join(', ')} WHERE from_emp=? AND to_emp=?`
  ).run(...vals);

  // 交流ログに記録（triggerType 指定時のみ）
  if (context.triggerType) {
    const deltaJson = JSON.stringify({
      delta,
      sensitivity: sens,
      relation_mod: Math.round(relationMod * 100) / 100,
      job_id: context.jobId ?? null,
    });
    db.prepare(`
      INSERT INTO cb_employee_interactions
        (session_date, from_emp, to_emp, trigger_type, message,
         relationship_delta_json, source_job_id)
      VALUES (date('now','localtime'), ?, ?, ?, ?, ?, ?)
    `).run(
      fromEmp, toEmp,
      context.triggerType,
      context.message ?? '（業務イベント）',
      deltaJson,
      context.jobId ?? null,
    );
  }
}

// ── 業務イベントフック ─────────────────────────────────────────────────────────

/**
 * 業務イベントに基づいて 2 方向の関係スコアを更新する。
 *
 * 設計:
 *   - source_job_id が既に cb_employee_interactions に存在する場合はスキップ（二重反映防止）。
 *   - fwd: eventKey_fwd → from_emp → to_emp の感情変化
 *   - rev: eventKey_rev → to_emp → from_emp の感情変化
 *   - setImmediate 経由で呼び出すこと（業務フロー非ブロック）。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} eventKey       - 例: 'research_handoff' / 'editing_ready' / 'editing_revision' / 'editing_blocked'
 * @param {object} params
 * @param {string} params.fromEmp   - 発信側（Scoutが調査を渡す → Scout）
 * @param {string} params.toEmp     - 受信側（Analystが受け取る → Analyst）
 * @param {number} [params.jobId]   - cb_jobs.id（二重反映防止用）
 * @param {number} [params.projectId]
 */
export function applyJobEvent(db, eventKey, { fromEmp, toEmp, jobId = null, projectId = null } = {}) {
  try {
    // 二重反映防止
    if (jobId !== null) {
      const already = db.prepare(
        'SELECT COUNT(*) AS c FROM cb_employee_interactions WHERE source_job_id = ?'
      ).get(jobId)?.c ?? 0;
      if (already > 0) return;
    }

    const fwdKey = `${eventKey}_fwd`;
    const revKey = `${eventKey}_rev`;
    const fwdDelta = JOB_EVENT_BASE[fwdKey];
    const revDelta = JOB_EVENT_BASE[revKey];

    const triggerType = TRIGGER_TYPE_MAP[fwdKey] ?? 'joint_work_success';
    const message     = _buildEventMessage(eventKey, fromEmp, toEmp);

    // from→to 方向（発信側の感情）
    if (fwdDelta) {
      updateRelationship(db, fromEmp, toEmp, fwdDelta, {
        triggerType,
        message,
        jobId,
        projectId,
      });
    }

    // to→from 方向（受信側の感情）。source_job_id は fwd で記録済みなので rev は null
    if (revDelta) {
      updateRelationship(db, toEmp, fromEmp, revDelta, {
        triggerType: TRIGGER_TYPE_MAP[revKey] ?? triggerType,
        message,
        jobId:   null,  // fwd 側で既に source_job_id を記録。rev は重複を避けるため null
        projectId,
      });
    }
  } catch (e) {
    console.warn(`[P42-B] applyJobEvent(${eventKey}) エラー:`, e.message);
  }
}

function _buildEventMessage(eventKey, fromEmp, toEmp) {
  const MSGS = {
    research_handoff:   `${fromEmp}が${toEmp}へ調査データを引き継いだ`,
    analysis_handoff:   `${fromEmp}が${toEmp}へ分析結果を引き継いだ`,
    writing_handoff:    `${fromEmp}が${toEmp}へ執筆を依頼した`,
    editing_ready:      `${toEmp}が${fromEmp}の原稿をREADYと判定した`,
    editing_revision:   `${toEmp}が${fromEmp}の原稿にREVISION_REQUIREDを出した`,
    editing_blocked:    `${toEmp}が${fromEmp}の原稿をBLOCKEDと判定した`,
    measuring_done:     `${fromEmp}が売上分析を完了した`,
  };
  return MSGS[eventKey] ?? `${eventKey}: ${fromEmp}→${toEmp}`;
}

// ── 関係コンテキスト（プロンプト挿入用） ──────────────────────────────────────

/**
 * 指定社員が持つ「関係性の内面」を短いテキストで返す。
 * プロンプトに挿入し、言い方・トーンに自然に滲ませる用途。
 *
 * 規則:
 *   - 秘密の感情（is_secret=1）は romance_enabled=1 のときのみ含める
 *   - 「この情報を会話に直接出してはならない」旨を必ずプロンプトに明記する
 *   - 数値は閾値以上のもののみ言語化（軽微な変動は無視）
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} empId
 * @returns {string}
 */
export function getRelationshipContext(db, empId) {
  const rows = db.prepare(`
    SELECT to_emp, trust, affection, respect, rivalry, discomfort,
           romantic_interest, is_secret
    FROM cb_employee_relationships
    WHERE from_emp = ?
    ORDER BY (trust + affection + respect - discomfort) DESC
  `).all(empId);

  const romanceEnabled = getAutonomousSetting(db, 'romance_enabled') === '1';

  const lines = [];
  for (const r of rows) {
    const parts = [];
    if (r.trust         >= 65)  parts.push(`信頼感${r.trust}`);
    else if (r.trust    <   0)  parts.push(`不信感${Math.abs(r.trust)}`);
    if (r.affection     >= 60)  parts.push(`親密度${r.affection}`);
    if (r.respect       >= 70)  parts.push(`尊敬${r.respect}`);
    if (r.rivalry       >= 50)  parts.push(`ライバル意識${r.rivalry}`);
    if (r.discomfort    >= 30)  parts.push(`距離感${r.discomfort}`);
    if (romanceEnabled && r.romantic_interest >= 20 && r.is_secret === 1) {
      parts.push(`〔内面のみ〕特別な意識${r.romantic_interest}`);
    }
    if (parts.length > 0) {
      lines.push(`  ${r.to_emp}: ${parts.join('・')}`);
    }
  }

  if (lines.length === 0) return '';

  return [
    `【${empId}の内面的な対人感覚（機密）】`,
    ...lines,
    '※ この情報は発話・行動に直接出さないこと。言い方・反応の温度感にのみ自然に反映させること。',
    '※ 特別な意識〔内面のみ〕は絶対に相手に伝えない。秘密として保持すること。',
  ].join('\n');
}

// ── 設定管理 ─────────────────────────────────────────────────────────────────

/** cb_autonomous_settings から設定値を取得 */
export function getAutonomousSetting(db, key) {
  return db.prepare('SELECT value FROM cb_autonomous_settings WHERE key=?').get(key)?.value ?? null;
}

/** cb_autonomous_settings を更新 */
export function updateAutonomousSetting(db, key, value) {
  db.prepare(
    'INSERT OR REPLACE INTO cb_autonomous_settings (key, value) VALUES (?, ?)'
  ).run(key, String(value));
}

// ── 予算チェック ──────────────────────────────────────────────────────────────

/**
 * 自律交流を実行できる予算余裕があるか確認する。
 *
 * 判定基準:
 *   - budget_threshold_percent 未満 → true（実行可）
 *   - status が disabled / exceeded / warning → false（実行不可）
 *   - monthly_limit_usd が null（無制限設定）→ true
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {boolean}
 */
export function hasBudgetForInteraction(db) {
  try {
    const status = getBudgetStatus();
    if (status.status === 'disabled' || status.status === 'exceeded') return false;
    if (status.status === 'warning') return false;  // 業務処理を優先
    if (status.usage_percent === null) return true;  // 無制限設定

    const threshold = parseFloat(getAutonomousSetting(db, 'budget_threshold_percent') ?? '50');
    return status.usage_percent < threshold;
  } catch (_) {
    return false;  // 予算確認失敗時は安全側に倒す
  }
}
