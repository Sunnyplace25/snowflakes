/**
 * jarvis/timecard/tc_manager.js
 * タイムカード管理ロジック
 *
 * テーブル: tc_punches
 *   id, owner_id, kind, at_ms, seq, request_id, location, created_at
 *
 * kind: in / out / break_start / break_end
 * at_ms: UTC epoch ミリ秒（打刻時刻の正本）
 * request_id: べき等キー
 */

const OWNER_ID = 1;
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

// ── ユーティリティ ──────────────────────────────────────────────────────────

/** UTC epoch ms → JST YYYY-MM-DD */
function msToJstDate(ms) {
  const d = new Date(ms + JST_OFFSET_MS);
  return d.toISOString().slice(0, 10);
}

/** JST 日付文字列 → その日の UTC epoch ms 範囲 */
function jstDateToUtcRange(dateStr) {
  // YYYY-MM-DD (JST) → UTC ms
  const start = new Date(dateStr + 'T00:00:00+09:00').getTime();
  const end   = new Date(dateStr + 'T23:59:59.999+09:00').getTime();
  return { start, end };
}

// ── 状態取得 ─────────────────────────────────────────────────────────────────

/**
 * 最新の打刻からオーナーの現在状態を返す。
 * @returns {{ state: 'idle'|'working'|'breaking', location: string, lastPunch: object|null }}
 */
export function getStatus(db) {
  const last = db.prepare(
    'SELECT * FROM tc_punches WHERE owner_id=? ORDER BY at_ms DESC, seq DESC LIMIT 1'
  ).get(OWNER_ID);

  if (!last) return { state: 'idle', location: '自宅', lastPunch: null };

  let state;
  switch (last.kind) {
    case 'in':          state = 'working';  break;
    case 'break_end':   state = 'working';  break;
    case 'break_start': state = 'breaking'; break;
    case 'out':         state = 'idle';     break;
    default:            state = 'idle';
  }
  return { state, location: last.location, lastPunch: last };
}

// ── 打刻（原子的） ────────────────────────────────────────────────────────────

/**
 * 打刻する。
 * - request_id でべき等処理（同じ ID の再送は最初の結果を返す）
 * - 状態検査→INSERT をトランザクション内で原子的に実行
 * @param {{ kind: string, atMs: number, location: string, requestId: string, category?: string }} opts
 * @returns {{ ok: boolean, punch?: object, error?: string, conflict?: boolean }}
 */
export function punch(db, { kind, atMs, location, requestId, category = '' }) {
  // べき等チェック: 同じ request_id が既にある？
  const existing = db.prepare('SELECT * FROM tc_punches WHERE request_id=?').get(requestId);
  if (existing) {
    if (existing.kind === kind && existing.at_ms === atMs && existing.location === location) {
      return { ok: true, punch: existing, duplicate: true };
    }
    return { ok: false, error: '同じIDで内容が異なるリクエストです（競合）', conflict: true };
  }

  // 状態チェック + INSERT をトランザクションで原子化
  try {
    db.exec('BEGIN IMMEDIATE');

    const { state, lastPunch } = getStatus(db);

    // 状態遷移バリデーション
    const allowed = {
      idle:     ['in'],
      working:  ['break_start', 'out'],
      breaking: ['break_end', 'out'],
    };
    if (!allowed[state]?.includes(kind)) {
      db.exec('ROLLBACK');
      return {
        ok: false,
        error: `現在の状態（${state}）では「${kind}」操作はできません`,
        stateConflict: true,
        currentState: state,
      };
    }

    // break_start / break_end / out はカテゴリを直前の in から引き継ぐ
    const resolvedCategory = (kind === 'in')
      ? (category ?? '').slice(0, 40)
      : (lastPunch?.category ?? '');

    const seq = (db.prepare('SELECT COALESCE(MAX(seq),0)+1 AS next FROM tc_punches WHERE owner_id=?').get(OWNER_ID)?.next ?? 1);
    const id  = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    db.prepare(`
      INSERT INTO tc_punches (id, owner_id, kind, at_ms, seq, request_id, location, category)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(id, OWNER_ID, kind, atMs, seq, requestId, location, resolvedCategory);

    const inserted = db.prepare('SELECT * FROM tc_punches WHERE id=?').get(id);
    db.exec('COMMIT');
    return { ok: true, punch: inserted };
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    return { ok: false, error: e.message };
  }
}

// ── 打刻履歴 ─────────────────────────────────────────────────────────────────

/**
 * 打刻履歴を新しい順で返す。
 * @param {{ limit?: number, offset?: number }} opts
 * @returns {object[]}
 */
export function getPunches(db, { limit = 30, offset = 0 } = {}) {
  return db.prepare(
    'SELECT * FROM tc_punches WHERE owner_id=? ORDER BY at_ms DESC, seq DESC LIMIT ? OFFSET ?'
  ).all(OWNER_ID, limit, offset);
}

// ── 日別集計 ─────────────────────────────────────────────────────────────────

/**
 * 指定 JST 日付の作業時間・休憩時間を集計する。
 *
 * アルゴリズム:
 *   - in / break_end → 作業区間の開始
 *   - break_start / out → 作業区間の終了 → 休憩区間の開始(break_startの場合)
 *   - 未終了の区間は現在時刻を終端として使用
 *   - 対象日の 00:00〜24:00 JST との重なりのみ集計
 *   - 全区間合計後、分未満を切り捨てて返す
 *
 * @param {string} dateJst - YYYY-MM-DD (JST)
 * @param {number} [nowMs] - 現在時刻 (UTC ms)、省略時は Date.now()
 * @returns {{ workMs: number, breakMs: number, firstInMs: number|null, lastOutMs: number|null }}
 */
export function getAggregate(db, dateJst, nowMs = Date.now()) {
  const { start: dayStart, end: dayEnd } = jstDateToUtcRange(dateJst);

  // 集計対象の打刻を取得（前後の区間のため前日末〜翌日初を含む広範囲）
  const margin = 24 * 60 * 60 * 1000;
  const punches = db.prepare(
    'SELECT * FROM tc_punches WHERE owner_id=? AND at_ms >= ? AND at_ms <= ? ORDER BY at_ms ASC, seq ASC'
  ).all(OWNER_ID, dayStart - margin, dayEnd + margin);

  let workMs  = 0;
  let breakMs = 0;
  let firstInMs  = null;
  let lastOutMs  = null;

  let workStart  = null; // 作業区間の開始 ms
  let breakStart = null; // 休憩区間の開始 ms

  /** 区間と日付の重なりを計算する */
  const overlap = (s, e) => {
    const cs = Math.max(s, dayStart);
    const ce = Math.min(e, dayEnd + 1); // dayEnd は 23:59:59.999 なので +1ms
    return Math.max(0, ce - cs);
  };

  for (const p of punches) {
    switch (p.kind) {
      case 'in':
        workStart  = p.at_ms;
        breakStart = null;
        if (firstInMs === null || p.at_ms < firstInMs) firstInMs = p.at_ms;
        break;

      case 'break_end':
        // 休憩区間を確定してから作業再開
        if (breakStart !== null) {
          breakMs   += overlap(breakStart, p.at_ms);
          breakStart = null;
        }
        workStart = p.at_ms;
        break;

      case 'break_start':
        if (workStart !== null) {
          workMs += overlap(workStart, p.at_ms);
          workStart = null;
        }
        breakStart = p.at_ms;
        break;

      case 'out':
        if (workStart !== null) {
          workMs += overlap(workStart, p.at_ms);
          workStart = null;
        }
        if (breakStart !== null) {
          breakMs += overlap(breakStart, p.at_ms);
          breakStart = null;
        }
        lastOutMs = p.at_ms;
        break;
    }
  }

  // 未終了区間
  if (workStart !== null) {
    workMs += overlap(workStart, nowMs);
  }
  if (breakStart !== null) {
    breakMs += overlap(breakStart, nowMs);
  }

  // 分未満切り捨て
  workMs  = Math.floor(workMs  / 60000) * 60000;
  breakMs = Math.floor(breakMs / 60000) * 60000;

  return { workMs, breakMs, firstInMs, lastOutMs };
}

/** ms を "H時間M分" 形式に変換 */
export function formatDuration(ms) {
  if (ms <= 0) return '0分';
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h === 0) return `${m}分`;
  if (m === 0) return `${h}時間`;
  return `${h}時間${m}分`;
}

// ── 日別集計履歴 ──────────────────────────────────────────────────────────────

/**
 * 直近 N 日の日別集計を新しい日順で返す。
 * - 打刻がある日のみ返す（今日は作業中/休憩中なら打刻なしでも含める）
 * - 各日の `punches` は at_ms がその JST 日に属するもの（表示用）
 * - `workMs` / `breakMs` は getAggregate で日境界クリップ済み
 *
 * @param {number} [days=30]
 * @param {number} [nowMs]
 * @returns {Array<{date,workMs,breakMs,firstInMs,lastOutMs,locations,punches,state,isToday}>}
 */
export function getDailyHistory(db, days = 30, nowMs = Date.now()) {
  const todayStr = msToJstDate(nowMs);
  const { state: currentState } = getStatus(db);
  const result = [];
  const seenDates = new Set();

  for (let i = 0; i < days; i++) {
    const dateStr = msToJstDate(nowMs - i * 86400000);
    if (seenDates.has(dateStr)) continue;
    seenDates.add(dateStr);

    const { start, end } = jstDateToUtcRange(dateStr);
    const punches = db.prepare(
      'SELECT * FROM tc_punches WHERE owner_id=? AND at_ms >= ? AND at_ms <= ? ORDER BY at_ms ASC, seq ASC'
    ).all(OWNER_ID, start, end);

    const isToday = dateStr === todayStr;
    const state   = isToday ? currentState : 'idle';

    // 打刻がなく非アクティブな日はスキップ
    if (punches.length === 0 && !(isToday && state !== 'idle')) continue;

    const agg        = getAggregate(db, dateStr, nowMs);
    const locations  = [...new Set(punches.map(p => p.location).filter(Boolean))];
    const categories = [...new Set(punches.map(p => p.category).filter(Boolean))];

    result.push({ date: dateStr, workMs: agg.workMs, breakMs: agg.breakMs,
      firstInMs: agg.firstInMs, lastOutMs: agg.lastOutMs,
      locations, categories, punches, state, isToday });
  }

  return result; // 新しい日順
}

// ── 打刻削除 ──────────────────────────────────────────────────────────────────

/**
 * 打刻を ID で削除する。
 * @returns {{ ok: boolean, error?: string }}
 */
export function deletePunch(db, punchId) {
  const row = db.prepare('SELECT id FROM tc_punches WHERE id=? AND owner_id=?').get(punchId, OWNER_ID);
  if (!row) return { ok: false, error: '見つかりません' };
  db.prepare('DELETE FROM tc_punches WHERE id=? AND owner_id=?').run(punchId, OWNER_ID);
  return { ok: true };
}
