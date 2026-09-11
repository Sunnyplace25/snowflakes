/**
 * jarvis/data/merch_competitor_reporter.js
 * 週次・月次レポート生成
 *
 * 外部通信: なし
 */

'use strict';

import {
  listAccounts, getBrandSoldRanking, getCategoryStats,
  getBuyingCandidates, getDailyScanSummary, saveReport,
  getRecentScans,
} from './merch_competitor_manager.js';

// ─── 日付ユーティリティ ────────────────────────────────────────────────────────

/**
 * Date を YYYY-MM-DD 形式の文字列に変換する（JST）。
 * @param {Date} d
 * @returns {string}
 */
function toJstDateStr(d) {
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}

/**
 * 今週月曜の日付を返す（JST）。
 * @param {Date} [now]
 * @returns {string} YYYY-MM-DD
 */
export function getWeekStart(now = new Date()) {
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  const day = jst.getUTCDay(); // 0=Sun ... 6=Sat
  const diff = day === 0 ? -6 : 1 - day;  // 月曜基点
  const monday = new Date(jst);
  monday.setUTCDate(jst.getUTCDate() + diff);
  return monday.toISOString().slice(0, 10);
}

/**
 * 今月初日の日付を返す（JST）。
 * @param {Date} [now]
 * @returns {string} YYYY-MM-DD
 */
export function getMonthStart(now = new Date()) {
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 8) + '01';
}

// ─── 週次レポート ─────────────────────────────────────────────────────────────

/**
 * 指定アカウントの週次レポートを生成して DB に保存する。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} accountId
 * @param {string} periodStart - YYYY-MM-DD（月曜）
 * @param {string} periodEnd   - YYYY-MM-DD（日曜）
 * @returns {object} レポート本文
 */
export function generateWeeklyReport(db, accountId, periodStart, periodEnd) {
  const brandRanking = getBrandSoldRanking(db, accountId, 10);
  const categoryStats = getCategoryStats(db, accountId);
  const candidates = getBuyingCandidates(db, accountId, 20);
  const scans = getRecentScans(db, accountId, 7);

  // 週間イベント集計
  const totalNew         = scans.reduce((s, r) => s + (r.items_new         ?? 0), 0);
  const totalSold        = scans.reduce((s, r) => s + (r.items_sold        ?? 0), 0);
  const totalPriceChange = scans.reduce((s, r) => s + (r.items_price_changed ?? 0), 0);

  const body = {
    period_start: periodStart,
    period_end:   periodEnd,
    account_id:   accountId,
    summary: {
      total_new:          totalNew,
      total_sold:         totalSold,
      total_price_change: totalPriceChange,
      scan_count:         scans.length,
    },
    brand_ranking:   brandRanking,
    category_stats:  categoryStats,
    buying_candidates: candidates.slice(0, 10).map(i => ({
      id:          i.id,
      name:        i.name,
      price:       i.price,
      buying_limit: i.buying_limit,
      margin:      (i.buying_limit ?? 0) - i.price,
      brand:       i.classified_brand,
      category:    i.classified_category,
    })),
    generated_at: new Date().toISOString(),
  };

  saveReport(db, {
    report_type:  'weekly',
    period_start: periodStart,
    period_end:   periodEnd,
    account_id:   accountId,
    body,
  });

  return body;
}

// ─── 月次レポート ─────────────────────────────────────────────────────────────

/**
 * 指定アカウントの月次レポートを生成して DB に保存する。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} accountId
 * @param {string} periodStart - YYYY-MM-DD（月初）
 * @param {string} periodEnd   - YYYY-MM-DD（月末）
 * @returns {object}
 */
export function generateMonthlyReport(db, accountId, periodStart, periodEnd) {
  const brandRanking  = getBrandSoldRanking(db, accountId, 20);
  const categoryStats = getCategoryStats(db, accountId);
  const candidates    = getBuyingCandidates(db, accountId, 50);

  // 月間スキャンサマリー集計
  const scans = db.prepare(`
    SELECT * FROM merch_competitor_scans
     WHERE account_id = ? AND scan_date >= ? AND scan_date <= ?
     ORDER BY scan_date
  `).all(accountId, periodStart, periodEnd);

  const totalNew         = scans.reduce((s, r) => s + (r.items_new          ?? 0), 0);
  const totalSold        = scans.reduce((s, r) => s + (r.items_sold         ?? 0), 0);
  const totalPriceChange = scans.reduce((s, r) => s + (r.items_price_changed ?? 0), 0);

  // 月間売却済み商品の価格統計
  const soldPrices = db.prepare(`
    SELECT price FROM merch_competitor_items
     WHERE account_id = ? AND status = 'sold'
       AND sold_at >= ? AND sold_at <= ?
  `).all(accountId, periodStart + 'T00:00:00', periodEnd + 'T23:59:59').map(r => r.price);

  const avgSoldPrice = soldPrices.length > 0
    ? Math.round(soldPrices.reduce((s, p) => s + p, 0) / soldPrices.length)
    : null;

  const body = {
    period_start: periodStart,
    period_end:   periodEnd,
    account_id:   accountId,
    summary: {
      total_new:          totalNew,
      total_sold:         totalSold,
      total_price_change: totalPriceChange,
      scan_count:         scans.length,
      avg_sold_price:     avgSoldPrice,
      sold_item_count:    soldPrices.length,
    },
    brand_ranking:    brandRanking,
    category_stats:   categoryStats,
    buying_candidates: candidates.slice(0, 20).map(i => ({
      id:           i.id,
      name:         i.name,
      price:        i.price,
      buying_limit: i.buying_limit,
      margin:       (i.buying_limit ?? 0) - i.price,
      brand:        i.classified_brand,
      category:     i.classified_category,
    })),
    generated_at: new Date().toISOString(),
  };

  saveReport(db, {
    report_type:  'monthly',
    period_start: periodStart,
    period_end:   periodEnd,
    account_id:   accountId,
    body,
  });

  return body;
}

// ─── 全アカウント横断レポート ──────────────────────────────────────────────────

/**
 * 全アカウント横断の週次レポートを生成する。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} periodStart
 * @param {string} periodEnd
 */
export function generateAllAccountsWeeklyReport(db, periodStart, periodEnd) {
  const accounts = listAccounts(db);
  const results = [];
  for (const account of accounts) {
    const body = generateWeeklyReport(db, account.id, periodStart, periodEnd);
    results.push({ account_id: account.id, display_name: account.display_name, body });
  }
  return results;
}

/**
 * 全アカウント横断の月次レポートを生成する。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} periodStart
 * @param {string} periodEnd
 */
export function generateAllAccountsMonthlyReport(db, periodStart, periodEnd) {
  const accounts = listAccounts(db);
  const results = [];
  for (const account of accounts) {
    // 月末日を計算
    const [y, m] = periodStart.split('-').map(Number);
    const lastDay = new Date(y, m, 0).getDate();
    const pe = `${periodStart.slice(0, 7)}-${String(lastDay).padStart(2, '0')}`;
    const body = generateMonthlyReport(db, account.id, periodStart, pe);
    results.push({ account_id: account.id, display_name: account.display_name, body });
  }
  return results;
}
