/**
 * jarvis/data/aggregator.js
 * MVP集計クエリ群
 *
 * 全関数は db オブジェクトを第1引数に受け取る（接続管理は呼び出し元）。
 * work_hours は分析用のみ。報酬計算には使用しない。
 */

/**
 * 月別サマリー（収入・支出・利益・労働時間・収益÷労働時間）
 * @param {import('better-sqlite3').Database} db
 * @param {string} yearMonth - 'YYYY-MM'
 * @returns {object}
 */
export function getMonthlySummary(db, yearMonth) {
  return db.prepare(`
    SELECT
      COALESCE(SUM(income),       0) AS total_income,
      COALESCE(SUM(expense),      0) AS total_expense,
      COALESCE(SUM(income), 0) - COALESCE(SUM(expense), 0) AS profit,
      COALESCE(SUM(work_hours),   0) AS total_work_hours,
      COALESCE(SUM(travel_hours), 0) AS total_travel_hours,
      CASE
        WHEN SUM(work_hours) > 0
        THEN ROUND(CAST(SUM(income) AS REAL) / SUM(work_hours), 0)
        ELSE NULL
      END AS income_per_hour
    FROM work_records
    WHERE date LIKE ?
  `).get(`${yearMonth}%`);
}

/**
 * カテゴリ別収益・件数
 * @param {import('better-sqlite3').Database} db
 * @param {string} [yearMonth]
 * @returns {object[]}
 */
export function getCategoryBreakdown(db, yearMonth = null) {
  const where = yearMonth ? `WHERE date LIKE '${yearMonth}%'` : '';
  return db.prepare(`
    SELECT
      category,
      COUNT(DISTINCT job_id) AS job_count,
      COALESCE(SUM(income),  0) AS total_income,
      COALESCE(SUM(expense), 0) AS total_expense
    FROM work_records ${where}
    GROUP BY category
    ORDER BY total_income DESC
  `).all();
}

/**
 * 発注元別件数・収益
 * 発注件数は COUNT(DISTINCT job_id) で算出（行数ではない）
 * @param {import('better-sqlite3').Database} db
 * @param {string} [yearMonth]
 * @returns {object[]}
 */
export function getClientBreakdown(db, yearMonth = null) {
  const where = yearMonth ? `WHERE date LIKE '${yearMonth}%'` : '';
  return db.prepare(`
    SELECT
      client,
      COUNT(DISTINCT job_id)    AS job_count,
      COALESCE(SUM(income), 0)  AS total_income
    FROM work_records ${where}
    GROUP BY client
    ORDER BY total_income DESC
  `).all();
}

/**
 * work_type別件数・収益・平均拘束時間
 * @param {import('better-sqlite3').Database} db
 * @param {string} [yearMonth]
 * @returns {object[]}
 */
export function getWorkTypeBreakdown(db, yearMonth = null) {
  const where = yearMonth ? `WHERE date LIKE '${yearMonth}%'` : '';
  return db.prepare(`
    SELECT
      COALESCE(work_type, '未設定') AS work_type,
      COUNT(*)                        AS count,
      COALESCE(SUM(income), 0)        AS total_income,
      ROUND(AVG(work_hours), 2)       AS avg_work_hours
    FROM work_records ${where}
    GROUP BY work_type
    ORDER BY count DESC
  `).all();
}

/**
 * 未請求・未入金件数
 * @param {import('better-sqlite3').Database} db
 * @returns {{ uninvoiced: number, unpaid: number }}
 */
export function getUnpaidCounts(db) {
  const uninvoiced = db.prepare(
    `SELECT COUNT(*) AS cnt FROM work_records WHERE invoice_status = '未請求'`
  ).get().cnt;
  const unpaid = db.prepare(
    `SELECT COUNT(*) AS cnt FROM work_records WHERE payment_status = '未入金'`
  ).get().cnt;
  return { uninvoiced, unpaid };
}

/**
 * 完全休日日数（daily_status から算出）
 * @param {import('better-sqlite3').Database} db
 * @param {string} [yearMonth]
 * @returns {number}
 */
export function getFullDayOffCount(db, yearMonth = null) {
  const where = yearMonth ? `WHERE date LIKE '${yearMonth}%' AND` : 'WHERE';
  return db.prepare(
    `SELECT COUNT(*) AS cnt FROM daily_status ${where} is_full_day_off = 1`
  ).get().cnt;
}
