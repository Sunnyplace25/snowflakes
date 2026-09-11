/**
 * jarvis/data/merch_competitor_scan.js
 * 競合アカウントスキャン共通ロジック
 *
 * merch_daily_scan.js（自動）と /api/competitor/scan（手動）で共用する。
 */

import {
  listAccounts, getAccount, startScan, finishScan,
  upsertItem, markMissingItems, touchAccountScan,
  upsertNotification, getSettings, getDailyScanSummary,
  updateItemClassification,
} from './merch_competitor_manager.js';
import { fetchSellerItems, fetchSellerName } from './merch_competitor_scraper.js';
import { classifyItem, calcBuyingLimit, batchClassify } from './merch_competitor_analyzer.js';

function jstToday() {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}

/**
 * 1アカウントをスキャンし結果を返す。
 * @param {object} db
 * @param {object} account - { id, mercari_user_id, display_name }
 * @param {object} settings
 * @param {string} scanDate - YYYY-MM-DD
 * @returns {{ ok:boolean, items_fetched:number, items_new:number, items_sold:number,
 *             items_price_changed:number, items_missing:number, error:string|null }}
 */
export async function scanOneAccount(db, account, settings, scanDate) {
  const maxItems = parseInt(settings.max_items_per_scan ?? 300, 10);
  const scanId = startScan(db, account.id, scanDate);

  const counts = {
    status: 'completed',
    items_fetched: 0, items_new: 0, items_sold: 0,
    items_price_changed: 0, items_missing: 0, items_reappeared: 0,
    error_message: null,
  };

  try {
    // セラー名を最新に更新
    const sellerName = await fetchSellerName(account.mercari_user_id);
    if (sellerName && sellerName !== account.display_name) {
      db.prepare(
        `UPDATE merch_competitor_accounts SET display_name = ?, updated_at = datetime('now','localtime') WHERE id = ?`
      ).run(sellerName, account.id);
    }

    // 商品一覧取得
    const items = await fetchSellerItems(account.mercari_user_id, maxItems);
    counts.items_fetched = items.length;

    // upsert
    const seenIds = new Set();
    for (const item of items) {
      seenIds.add(item.mercari_item_id);
      const result = upsertItem(db, account.id, scanId, item);
      if (result.isNew)         counts.items_new++;
      if (result.isSold)        counts.items_sold++;
      if (result.isPriceChange) counts.items_price_changed++;
      if (result.isReappeared)  counts.items_reappeared++;
    }

    // missing 判定
    counts.items_missing = markMissingItems(db, account.id, scanId, seenIds);

    // 分類・買付け上限更新
    batchClassify(db, account.id, settings, updateItemClassification);

    touchAccountScan(db, account.id);

  } catch (err) {
    counts.status = 'failed';
    counts.error_message = err.message;
  }

  finishScan(db, scanId, counts);
  return {
    ok:                  counts.status === 'completed',
    account_id:          account.id,
    display_name:        account.display_name,
    items_fetched:       counts.items_fetched,
    items_new:           counts.items_new,
    items_sold:          counts.items_sold,
    items_price_changed: counts.items_price_changed,
    items_missing:       counts.items_missing,
    error:               counts.error_message ?? null,
  };
}

/**
 * 全アクティブアカウントをスキャンし、通知も更新する。
 * @param {object} db
 * @param {string} [scanDate]
 * @returns {{ results: object[], summary: object }}
 */
export async function scanAllAccounts(db, scanDate) {
  const date     = scanDate || jstToday();
  const settings = getSettings(db);
  const accounts = listAccounts(db);

  const results = [];
  for (const account of accounts) {
    const r = await scanOneAccount(db, account, settings, date);
    results.push(r);
  }

  // 通知更新
  const summary = getDailyScanSummary(db, date);
  upsertNotification(db, date, {
    scan_date:    date,
    accounts:     accounts.length,
    ...summary,
    generated_at: new Date().toISOString(),
  });

  return { results, summary };
}

/**
 * 指定アカウントのみスキャンし、通知も更新する。
 * @param {object} db
 * @param {number} accountId
 * @param {string} [scanDate]
 */
export async function scanSingleAccount(db, accountId, scanDate) {
  const date     = scanDate || jstToday();
  const settings = getSettings(db);
  const account  = getAccount(db, accountId);
  if (!account) throw new Error(`アカウントID ${accountId} が見つかりません`);

  const result = await scanOneAccount(db, account, settings, date);

  // 通知更新
  const summary = getDailyScanSummary(db, date);
  upsertNotification(db, date, {
    scan_date:    date,
    accounts:     1,
    ...summary,
    generated_at: new Date().toISOString(),
  });

  return { results: [result], summary };
}
