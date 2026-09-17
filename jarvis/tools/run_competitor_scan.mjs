/**
 * tools/run_competitor_scan.mjs
 * 競合アカウント自動スキャン CLI エントリーポイント
 *
 * 使用方法:
 *   node tools/run_competitor_scan.mjs                    # 全アカウントスキャン
 *   node tools/run_competitor_scan.mjs <account_id>       # 指定アカウントのみ
 *   node tools/run_competitor_scan.mjs <account_id> <YYYY-MM-DD>  # 日付も指定
 *
 * 例:
 *   node tools/run_competitor_scan.mjs           # 全セラーを順番にスキャン
 *   node tools/run_competitor_scan.mjs 1         # account_id=1 のみ
 *   node tools/run_competitor_scan.mjs 1 2026-09-17
 *
 * セラー間待機時間は merch_analysis_settings の account_interval_sec で設定可能。
 * デフォルト: 30秒
 */

import { join, dirname } from 'node:path';
import { fileURLToPath }  from 'node:url';
import { createDb }       from '../data/db.js';
import { scanAllAccounts, scanSingleAccount } from '../data/merch_competitor_scan.js';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const DB_PATH    = join(__dirname, '..', 'jarvis.db');

const rawAccountId = process.argv[2];
const accountId    = rawAccountId && /^\d+$/.test(rawAccountId)
  ? parseInt(rawAccountId, 10) : null;
const scanDate     = process.argv[3] ?? undefined;

const db = createDb(DB_PATH);

try {
  let result;
  if (accountId) {
    console.log(`[scan] アカウント ID=${accountId} をスキャンします`);
    result = await scanSingleAccount(db, accountId, scanDate);
  } else {
    console.log('[scan] 全登録アカウントをスキャンします');
    result = await scanAllAccounts(db, scanDate);
  }
  console.log('\n[scan] 完了');
  console.log(JSON.stringify(result, null, 2));
} catch (err) {
  console.error('[scan] エラー:', err.message);
  process.exit(1);
} finally {
  db.close();
}
