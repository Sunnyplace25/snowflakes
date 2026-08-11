/**
 * jarvis/data/daily_status_manager.js
 * daily_status テーブルの CRUD 操作
 *
 * 設計方針：
 * - 1日1レコード（date PRIMARY KEY で保証）
 * - 未登録日は勤務日とも休日とも判断しない
 * - 仕事レコード登録時は markWorkDay() で安全に「勤務日」を記録する
 *   （既にis_full_day_off=1の日には上書きしない）
 */

/**
 * 日次状態を登録または更新する（UPSERT）。
 * @param {import('better-sqlite3').Database} db
 * @param {{ date: string, is_full_day_off: boolean, memo?: string }} opts
 */
export function upsertDailyStatus(db, { date, is_full_day_off, memo = null }) {
  if (!date || typeof date !== 'string') throw new Error('date is required (YYYY-MM-DD)');
  if (typeof is_full_day_off !== 'boolean') throw new Error('is_full_day_off must be boolean');

  db.prepare(`
    INSERT INTO daily_status (date, is_full_day_off, memo, updated_at)
    VALUES (?, ?, ?, datetime('now', 'localtime'))
    ON CONFLICT(date) DO UPDATE SET
      is_full_day_off = excluded.is_full_day_off,
      memo            = excluded.memo,
      updated_at      = excluded.updated_at
  `).run(date, is_full_day_off ? 1 : 0, memo);
}

/**
 * 仕事を登録した日を安全に勤務日として daily_status に記録する。
 * すでに is_full_day_off=1 の記録がある場合は上書きしない（休日扱いを保護）。
 * 未登録の日のみ is_full_day_off=0 で新規挿入する。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} date - YYYY-MM-DD
 */
export function markWorkDay(db, date) {
  db.prepare(`
    INSERT INTO daily_status (date, is_full_day_off, updated_at)
    VALUES (?, 0, datetime('now', 'localtime'))
    ON CONFLICT(date) DO NOTHING
  `).run(date);
}

/**
 * 指定日の日次状態を取得する。
 * @param {import('better-sqlite3').Database} db
 * @param {string} date
 * @returns {object|null} - 未登録の場合 null を返す
 */
export function getDailyStatus(db, date) {
  return db.prepare(`SELECT * FROM daily_status WHERE date = ?`).get(date) ?? null;
}

/**
 * 期間内の完全休日日数を返す。
 * @param {import('better-sqlite3').Database} db
 * @param {{ yearMonth?: string }} [opts]
 * @returns {number}
 */
export function getFullDayOffCount(db, { yearMonth } = {}) {
  if (yearMonth) {
    return db.prepare(
      `SELECT COUNT(*) as cnt FROM daily_status WHERE date LIKE ? AND is_full_day_off = 1`
    ).get(`${yearMonth}%`).cnt;
  }
  return db.prepare(
    `SELECT COUNT(*) as cnt FROM daily_status WHERE is_full_day_off = 1`
  ).get().cnt;
}

/**
 * 最大連勤日数を返す（daily_statusに登録されたis_full_day_off=0の連続日数）。
 * ※ 未登録日は計算に含めない。
 * @param {import('better-sqlite3').Database} db
 * @returns {{ max_consecutive_work_days: number }}
 */
export function getMaxConsecutiveWorkDays(db) {
  const rows = db.prepare(
    `SELECT date, is_full_day_off FROM daily_status ORDER BY date`
  ).all();

  let maxStreak = 0;
  let cur       = 0;
  for (const row of rows) {
    if (row.is_full_day_off === 0) {
      cur++;
      if (cur > maxStreak) maxStreak = cur;
    } else {
      cur = 0;
    }
  }
  return { max_consecutive_work_days: maxStreak };
}
