/**
 * jarvis/tools/run_ga4_sync.js
 * GA4 Data API から実データを取得して DB へ書き込む手動実行ツール。
 *
 * 使い方:
 *   node --env-file=.env tools/run_ga4_sync.js
 *   node --env-file=.env tools/run_ga4_sync.js 2026-07-01 2026-08-15
 */

import { createDb } from '../data/db.js';
import { syncGa4 }  from '../importers/ga4_collector.js';

const [,, startDate, endDate] = process.argv;

const db = createDb();
console.log('GA4 sync 開始...');
console.log('  Property:', process.env.GA4_PROPERTY_ID);
console.log('  期間    :', startDate ?? '(過去90日)');

try {
  const result = await syncGa4(db, { startDate, endDate });

  console.log('\n── 完了 ──────────────────────────────────');
  console.log(`期間         : ${result.startDate} ～ ${result.endDate}`);
  console.log(`sf_ga_daily  : 取得 ${result.daily.fetched} 件 / 書込 ${result.daily.written} 件`);
  if (result.daily.errors.length) {
    console.warn(`  エラー ${result.daily.errors.length} 件:`, result.daily.errors.slice(0, 3));
  }
  console.log(`sf_ga_events : 取得 ${result.events.fetched} 件 / 書込 ${result.events.written} 件`);
  if (result.events.errors.length) {
    console.warn(`  エラー ${result.events.errors.length} 件:`, result.events.errors.slice(0, 3));
  }
  console.log('──────────────────────────────────────────');
} catch (e) {
  console.error('GA4 sync 失敗:', e.message);
  process.exit(1);
}
