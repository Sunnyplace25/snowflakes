/**
 * jarvis/automation/merch_daily_scan.js
 * 競合アカウント 日次スキャン CLI
 *
 * Task Scheduler: SnowflakesOpsRunner が毎朝 6:00 JST に実行する。
 * 手動実行: node automation/merch_daily_scan.js
 *
 * 処理フロー:
 *   1. DB からアクティブアカウント取得
 *   2. 各アカウントの商品を Mercari API から取得（最大 300 件）
 *   3. DB に upsert（新規/売却/価格変化/missing を記録）
 *   4. 自動分類・買付け上限更新
 *   5. 日次通知 upsert
 *   6. 月曜: 週次レポート生成 / 1日: 月次レポート生成
 */

import { resolve, dirname } from 'node:path';
import { fileURLToPath }   from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT      = resolve(__dirname, '..');

// DB
import { createDb }             from '../data/db.js';
import {
  listAccounts, startScan, finishScan, upsertItem,
  markMissingItems, touchAccountScan, upsertNotification,
  getSettings, getDailyScanSummary,
}                               from '../data/merch_competitor_manager.js';
import {
  fetchSellerItems, fetchSellerName,
}                               from '../data/merch_competitor_scraper.js';
import {
  classifyItem, calcMedian, calcBuyingLimit, getConfidence, batchClassify,
}                               from '../data/merch_competitor_analyzer.js';
import { updateItemClassification } from '../data/merch_competitor_manager.js';
import {
  getWeekStart, getMonthStart,
  generateAllAccountsWeeklyReport, generateAllAccountsMonthlyReport,
}                               from '../data/merch_competitor_reporter.js';

// ─── JST 日付 ─────────────────────────────────────────────────────────────────

function jstToday() {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}

// ─── メイン処理 ───────────────────────────────────────────────────────────────

async function main() {
  const scanDate = jstToday();
  console.log(`[merch_daily_scan] 開始 scanDate=${scanDate}`);

  const db       = createDb();
  const settings = getSettings(db);
  const maxItems = parseInt(settings.max_items_per_scan ?? 300, 10);

  const accounts = listAccounts(db);
  if (accounts.length === 0) {
    console.log('[merch_daily_scan] アクティブアカウントなし。終了。');
    return;
  }

  let totalNew = 0, totalSold = 0, totalPriceChange = 0, totalMissing = 0;

  for (const account of accounts) {
    console.log(`[merch_daily_scan] アカウント: ${account.display_name} (${account.mercari_user_id})`);
    const scanId = startScan(db, account.id, scanDate);

    let counts = {
      status: 'completed',
      items_fetched: 0, items_new: 0, items_sold: 0,
      items_price_changed: 0, items_missing: 0, items_reappeared: 0,
    };

    try {
      // セラー名を更新
      const sellerName = await fetchSellerName(account.mercari_user_id);
      if (sellerName && sellerName !== account.display_name) {
        db.prepare(
          `UPDATE merch_competitor_accounts SET display_name = ?, updated_at = datetime('now','localtime') WHERE id = ?`
        ).run(sellerName, account.id);
      }

      // 商品一覧取得
      const items = await fetchSellerItems(account.mercari_user_id, maxItems);
      counts.items_fetched = items.length;
      console.log(`  → ${items.length} 件取得`);

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
      console.error(`  [ERROR] ${err.message}`);
      counts.status = 'failed';
      counts.error_message = err.message;
    }

    finishScan(db, scanId, counts);

    totalNew         += counts.items_new;
    totalSold        += counts.items_sold;
    totalPriceChange += counts.items_price_changed;
    totalMissing     += counts.items_missing;

    console.log(`  → 新規:${counts.items_new} 売却:${counts.items_sold} 価格変化:${counts.items_price_changed} missing:${counts.items_missing}`);
  }

  // 日次通知 upsert
  const summary = getDailyScanSummary(db, scanDate);
  upsertNotification(db, scanDate, {
    scan_date:    scanDate,
    accounts:     accounts.length,
    ...summary,
    generated_at: new Date().toISOString(),
  });

  console.log(`[merch_daily_scan] 通知保存: ${JSON.stringify(summary)}`);

  // 週次レポート（月曜のみ）
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  if (jst.getUTCDay() === 1) {  // 月曜
    const weekStart = getWeekStart(new Date(jst.getTime() - 7 * 24 * 60 * 60 * 1000));
    const weekEnd   = new Date(jst);
    weekEnd.setUTCDate(jst.getUTCDate() - 1);
    const weekEndStr = weekEnd.toISOString().slice(0, 10);
    try {
      generateAllAccountsWeeklyReport(db, weekStart, weekEndStr);
      console.log(`[merch_daily_scan] 週次レポート生成: ${weekStart} - ${weekEndStr}`);
    } catch (e) {
      console.error(`[merch_daily_scan] 週次レポート生成失敗: ${e.message}`);
    }
  }

  // 月次レポート（1日のみ）
  if (jst.getUTCDate() === 1) {
    const prevMonth = new Date(jst);
    prevMonth.setUTCMonth(jst.getUTCMonth() - 1);
    const monthStart = getMonthStart(prevMonth);
    const [y, m] = monthStart.split('-').map(Number);
    const lastDay = new Date(y, m, 0).getDate();
    const monthEnd = `${monthStart.slice(0, 7)}-${String(lastDay).padStart(2, '0')}`;
    try {
      generateAllAccountsMonthlyReport(db, monthStart, monthEnd);
      console.log(`[merch_daily_scan] 月次レポート生成: ${monthStart} - ${monthEnd}`);
    } catch (e) {
      console.error(`[merch_daily_scan] 月次レポート生成失敗: ${e.message}`);
    }
  }

  console.log(`[merch_daily_scan] 完了`);
}

main().catch(err => {
  console.error('[merch_daily_scan] 予期しないエラー:', err);
  process.exit(1);
});
