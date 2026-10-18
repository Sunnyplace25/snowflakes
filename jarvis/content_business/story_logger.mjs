/**
 * content_business/story_logger.mjs
 * Phase 43-A: バーチャルオフィス観察記録システム — ログ収集モジュール
 *
 * 設計原則:
 *   1. ログは事実のみ記録。AIによる要約・改変・上書きは禁止。
 *   2. 重複防止は 2 層で行う:
 *        ① UUID + UNIQUE(event_uuid)            — 同一呼び出しの二重挿入を防ぐ
 *        ② UNIQUE(event_type, source_type, source_id, from_emp, to_emp)
 *                                                — 同一元イベントの再処理（再起動・リトライ）を防ぐ
 *      いずれも INSERT OR IGNORE で静かにスキップ。
 *   3. 元データとの対応を source_type / source_id で維持。
 *   4. is_secret=1 のイベントは includeSecret=true のときのみ返す。
 *      APIレイヤーで認証・権限確認を必ず行うこと（ヘッダーのみで制御しないこと）。
 *   5. is_fictional は常に 0。小説での情景・心理補完は cb_story_episodes で管理する。
 *
 * イベント種別とログ形式の使い分け:
 *   BUSINESS_HANDOFF   → content_text = 業務の要約テキスト（「ヒカゲが調査を完了した...」）
 *   AUTONOMOUS_CHAT    → content_text = 会話の原文をすべて含む。要約・省略禁止。
 *                         logConversation() を使うこと。
 *   RELATIONSHIP_CHANGE→ content_text = イベントの説明文。delta_json = スコア変化の詳細。
 */

import { randomUUID } from 'node:crypto';
import { writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** ログエクスポートの保存先ディレクトリ */
const ARCHIVE_DIR = resolve(__dirname, 'story_archive');

// ── イベント種別 ─────────────────────────────────────────────────────────────
//
//  BUSINESS_HANDOFF   : 業務フェーズの引き継ぎ・完了（調査→分析→企画→執筆→編集）
//  AUTONOMOUS_CHAT    : AI社員間の自律交流会話（P42-C で記録）
//  RELATIONSHIP_CHANGE: 関係性スコアの変化
//  PERSONALITY_UPDATE : 人格設定の変更（将来用。現在は静的 JSON のため未使用）
//  SYSTEM             : システムイベント（サーバー起動・設定変更等）
//
const VALID_EVENT_TYPES = new Set([
  'BUSINESS_HANDOFF',
  'AUTONOMOUS_CHAT',
  'RELATIONSHIP_CHANGE',
  'PERSONALITY_UPDATE',
  'SYSTEM',
]);

// ── 社員日本語名マッピング ────────────────────────────────────────────────────
const EMP_NAME = {
  Scout:   'ヒカゲ',
  Analyst: 'ヒノデ',
  Planner: 'アサヒ',
  Writer:  'ソラ',
  Editor:  'キイロ',
  Growth:  'アオ',
};

const EVENT_LABEL = {
  BUSINESS_HANDOFF:   '業務',
  AUTONOMOUS_CHAT:    '交流',
  RELATIONSHIP_CHANGE:'関係変化',
  PERSONALITY_UPDATE: '人格更新',
  SYSTEM:             'システム',
};

// ── コアログ記録関数 ─────────────────────────────────────────────────────────

/**
 * オフィスイベントを cb_story_events に記録する（冪等）。
 *
 * INSERT OR IGNORE で event_uuid の重複を防ぐ。
 * エラー発生時は console.warn のみ行い、業務フローに影響させない。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object}  opts
 * @param {string}  opts.eventType       - BUSINESS_HANDOFF | AUTONOMOUS_CHAT | RELATIONSHIP_CHANGE | PERSONALITY_UPDATE | SYSTEM
 * @param {string}  [opts.fromEmp]       - 発信者（社員ID: Scout/Analyst/...）
 * @param {string}  [opts.toEmp]         - 受信者
 * @param {string}  opts.contentText     - 原文。AIによる改変禁止
 * @param {object}  [opts.deltaJson]     - 関係性変化のスナップショット（RELATIONSHIP_CHANGE 時）
 * @param {string}  [opts.sourceType]    - 元データ種別: cb_jobs | cb_employee_interactions | cb_chat_messages
 * @param {number}  [opts.sourceId]      - 元データの id
 * @param {boolean} [opts.isSecret=false]- 秘密感情関連イベントは true（社長権限のみ閲覧可）
 * @returns {string|null} 記録した event_uuid。失敗時は null
 */
export function logEvent(db, {
  eventType,
  fromEmp    = null,
  toEmp      = null,
  contentText,
  deltaJson  = null,
  sourceType = null,
  sourceId   = null,
  isSecret   = false,
}) {
  if (!VALID_EVENT_TYPES.has(eventType)) {
    console.warn('[P43-A] logEvent: 不明なeventType:', eventType);
    return null;
  }
  try {
    const eventUuid = randomUUID();
    const now = new Date();
    // JST で日付・時刻を取得
    const eventDate = now.toLocaleDateString('sv-SE',  { timeZone: 'Asia/Tokyo' }); // YYYY-MM-DD
    const eventTime = now.toLocaleTimeString('ja-JP',  { timeZone: 'Asia/Tokyo', hour12: false }); // HH:MM:SS

    const result = db.prepare(`
      INSERT OR IGNORE INTO cb_story_events
        (event_uuid, event_date, event_time, event_type,
         from_emp, to_emp, content_text, delta_json,
         source_type, source_id, is_secret)
      VALUES (?,?,?,?,?,?,?,?,?,?,?)
    `).run(
      eventUuid,
      eventDate, eventTime,
      eventType,
      fromEmp,
      toEmp,
      contentText,
      deltaJson != null ? JSON.stringify(deltaJson) : null,
      sourceType,
      sourceId ?? null,
      isSecret ? 1 : 0,
    );
    // changes === 0 は INSERT が IGNORE されたことを示す（重複防止インデックスが作動）
    if (result.changes === 0) return null;
    return eventUuid;
  } catch (e) {
    console.warn('[P43-A] logEvent エラー:', e.message);
    return null;
  }
}

// ── ログ取得関数 ─────────────────────────────────────────────────────────────

/**
 * 指定日のイベント一覧を返す。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object}  opts
 * @param {string}  opts.date              - YYYY-MM-DD
 * @param {string}  [opts.empFilter]       - 社員IDで絞り込み（from_emp または to_emp）
 * @param {boolean} [opts.includeSecret=false] - 社長権限のみ true にすること
 * @returns {Array}
 */
export function getDailyEvents(db, { date, empFilter = null, includeSecret = false }) {
  const params = [date];
  let query = `
    SELECT id, event_uuid, event_date, event_time, event_type,
           from_emp, to_emp, content_text, delta_json,
           source_type, source_id, is_secret, created_at
    FROM cb_story_events
    WHERE event_date = ?
  `;
  if (!includeSecret) { query += ' AND is_secret = 0'; }
  if (empFilter) {
    query += ' AND (from_emp = ? OR to_emp = ?)';
    params.push(empFilter, empFilter);
  }
  query += ' ORDER BY event_time ASC, id ASC';
  return db.prepare(query).all(...params);
}

/**
 * 期間指定でイベント一覧を返す。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object}  opts
 * @param {string}  opts.dateFrom
 * @param {string}  opts.dateTo
 * @param {string}  [opts.empFilter]
 * @param {boolean} [opts.includeSecret=false]
 * @returns {Array}
 */
export function getEventsByDateRange(db, { dateFrom, dateTo, empFilter = null, includeSecret = false }) {
  const params = [dateFrom, dateTo];
  let query = `
    SELECT id, event_uuid, event_date, event_time, event_type,
           from_emp, to_emp, content_text, delta_json,
           source_type, source_id, is_secret, created_at
    FROM cb_story_events
    WHERE event_date BETWEEN ? AND ?
  `;
  if (!includeSecret) { query += ' AND is_secret = 0'; }
  if (empFilter) {
    query += ' AND (from_emp = ? OR to_emp = ?)';
    params.push(empFilter, empFilter);
  }
  query += ' ORDER BY event_date ASC, event_time ASC, id ASC';
  return db.prepare(query).all(...params);
}

/**
 * 期間内のイベント件数を返す（執筆可否判断用）。
 */
export function getEventCount(db, { dateFrom, dateTo, includeSecret = false }) {
  let query = 'SELECT COUNT(*) AS c FROM cb_story_events WHERE event_date BETWEEN ? AND ?';
  if (!includeSecret) query += ' AND is_secret = 0';
  return db.prepare(query).get(dateFrom, dateTo)?.c ?? 0;
}

/**
 * UUID でイベントを1件取得する。小説での参照元確認用。
 */
export function getEventByUuid(db, eventUuid) {
  return db.prepare('SELECT * FROM cb_story_events WHERE event_uuid=?').get(eventUuid) ?? null;
}

// ── エクスポート（Markdown / TXT） ────────────────────────────────────────────

/**
 * 期間のイベントを Markdown 文字列に変換して返す。
 * ファイルへの書き出しは exportMarkdownToFile() を使う。
 */
export function exportMarkdown(db, { dateFrom, dateTo, empFilter = null, includeSecret = false }) {
  const events = getEventsByDateRange(db, { dateFrom, dateTo, empFilter, includeSecret });

  const empLabel = empFilter ? `（${EMP_NAME[empFilter] ?? empFilter}）` : '';
  const header = [
    '# オフィス観察記録',
    '',
    `**期間:** ${dateFrom} 〜 ${dateTo}${empLabel}`,
    `**出力:** ${new Date().toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' })}`,
    `**件数:** ${events.length}件`,
    '',
  ];

  if (events.length === 0) {
    return [...header, '記録がありません。', ''].join('\n');
  }

  // 日付ごとにグループ化
  const byDate = {};
  for (const ev of events) {
    (byDate[ev.event_date] ??= []).push(ev);
  }

  const lines = [...header];
  for (const [date, dayEvents] of Object.entries(byDate)) {
    lines.push(`## ${date}（${dayEvents.length}件）`, '');
    for (const ev of dayEvents) {
      const actors = [ev.from_emp, ev.to_emp]
        .filter(Boolean)
        .map(e => EMP_NAME[e] ?? e)
        .join(' → ');
      const secretMark = ev.is_secret ? ' 🔒' : '';
      const label = EVENT_LABEL[ev.event_type] ?? ev.event_type;
      lines.push(`### ${ev.event_time} [${label}] ${actors}${secretMark}`);
      lines.push(`*UUID: ${ev.event_uuid}*`);
      lines.push('');
      lines.push(ev.content_text);
      if (ev.delta_json) {
        try {
          const d = JSON.parse(ev.delta_json);
          lines.push('');
          lines.push('<details><summary>関係性変化データ</summary>');
          lines.push('');
          lines.push('```json');
          lines.push(JSON.stringify(d, null, 2));
          lines.push('```');
          lines.push('</details>');
        } catch (_) { /* 不正な JSON はスキップ */ }
      }
      lines.push('');
    }
  }

  return lines.join('\n');
}

/**
 * Markdown を story_archive ディレクトリに書き出す。
 * ファイル名: office_log_YYYYMMDD-YYYYMMDD[_社員ID].md
 *
 * @returns {{ filePath: string, content: string } | null}
 */
export function exportMarkdownToFile(db, { dateFrom, dateTo, empFilter = null, includeSecret = false }) {
  try {
    if (!existsSync(ARCHIVE_DIR)) mkdirSync(ARCHIVE_DIR, { recursive: true });

    const content    = exportMarkdown(db, { dateFrom, dateTo, empFilter, includeSecret });
    const safeDateF  = dateFrom.replace(/-/g, '');
    const safeDateT  = dateTo.replace(/-/g, '');
    const empSuffix  = empFilter ? `_${empFilter}` : '';
    const filePath   = resolve(ARCHIVE_DIR, `office_log_${safeDateF}-${safeDateT}${empSuffix}.md`);
    writeFileSync(filePath, content, 'utf8');
    return { filePath, content };
  } catch (e) {
    console.warn('[P43-A] exportMarkdownToFile エラー:', e.message);
    return null;
  }
}

/**
 * プレーン TXT 形式で書き出す。
 * Markdown 記法を除いたシンプルなテキスト。
 */
export function exportTxtToFile(db, { dateFrom, dateTo, empFilter = null, includeSecret = false }) {
  try {
    if (!existsSync(ARCHIVE_DIR)) mkdirSync(ARCHIVE_DIR, { recursive: true });

    const events = getEventsByDateRange(db, { dateFrom, dateTo, empFilter, includeSecret });
    const lines = [
      'オフィス観察記録',
      `期間: ${dateFrom} 〜 ${dateTo}`,
      `件数: ${events.length}件`,
      '',
    ];

    let lastDate = '';
    for (const ev of events) {
      if (ev.event_date !== lastDate) {
        if (lastDate) lines.push('');
        lines.push(`【${ev.event_date}】`);
        lastDate = ev.event_date;
      }
      const actors = [ev.from_emp, ev.to_emp]
        .filter(Boolean)
        .map(e => EMP_NAME[e] ?? e)
        .join(' → ');
      const secretMark = ev.is_secret ? ' [秘密]' : '';
      lines.push(`${ev.event_time} [${EVENT_LABEL[ev.event_type] ?? ev.event_type}] ${actors}${secretMark}`);
      lines.push(ev.content_text);
    }

    const safeDateF = dateFrom.replace(/-/g, '');
    const safeDateT = dateTo.replace(/-/g, '');
    const empSuffix = empFilter ? `_${empFilter}` : '';
    const filePath  = resolve(ARCHIVE_DIR, `office_log_${safeDateF}-${safeDateT}${empSuffix}.txt`);
    writeFileSync(filePath, lines.join('\n'), 'utf8');
    return { filePath, content: lines.join('\n') };
  } catch (e) {
    console.warn('[P43-A] exportTxtToFile エラー:', e.message);
    return null;
  }
}

// ── 会話原文ログ（P42-C で使用） ────────────────────────────────────────────

/**
 * 自律交流の会話を原文のまま AUTONOMOUS_CHAT イベントとして記録する。
 *
 * BUSINESS_HANDOFF（業務の要約ログ）と明示的に区別するために専用関数を用意する。
 * content_text には発言の原文をすべて含める（要約・省略禁止）。
 *
 * source_id（= cb_employee_interactions.id）が設定されている場合、
 * idx_story_ev_src_dedup インデックスにより同一インタラクションの二重記録を防ぐ。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object}   opts
 * @param {string}   opts.fromEmp        - 会話を始めた社員（発話者）
 * @param {string}   opts.toEmp          - 相手社員
 * @param {string}   opts.triggerType    - 会話のきっかけ種別（autonomous/incidental 等）
 * @param {string}   opts.triggerReason  - きっかけの説明文（原文）
 * @param {Array}    opts.turns          - 会話ターン配列: [{ speaker: 'Scout', content: '...' }, ...]
 * @param {object}   [opts.deltaJson]    - 関係性変化スナップショット
 * @param {number}   [opts.sourceId]     - cb_employee_interactions.id（重複防止に使用）
 * @param {boolean}  [opts.isSecret=false]
 * @returns {string|null} event_uuid
 */
export function logConversation(db, {
  fromEmp,
  toEmp,
  triggerType,
  triggerReason,
  turns         = [],
  deltaJson     = null,
  sourceId      = null,
  isSecret      = false,
}) {
  const lines = [
    `【きっかけ（${triggerType}）】${triggerReason}`,
    '',
    '--- 会話原文 ---',
  ];
  for (const turn of turns) {
    const name = EMP_NAME[turn.speaker] ?? turn.speaker;
    lines.push(`${name}：「${turn.content}」`);
  }

  return logEvent(db, {
    eventType:   'AUTONOMOUS_CHAT',
    fromEmp,
    toEmp,
    contentText: lines.join('\n'),
    deltaJson,
    sourceType:  'cb_employee_interactions',
    sourceId,
    isSecret,
  });
}

// ── 設定管理 ─────────────────────────────────────────────────────────────────

/** cb_story_settings から設定値を取得 */
export function getStorySetting(db, key) {
  return db.prepare('SELECT value FROM cb_story_settings WHERE key=?').get(key)?.value ?? null;
}

/** cb_story_settings を更新 */
export function updateStorySetting(db, key, value) {
  db.prepare('INSERT OR REPLACE INTO cb_story_settings (key,value) VALUES (?,?)').run(key, String(value));
}
