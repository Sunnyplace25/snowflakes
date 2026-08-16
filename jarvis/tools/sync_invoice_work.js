#!/usr/bin/env node
/**
 * 既存の請求書明細を Business > 月次の仕事一覧へ後追い反映する。
 * 古い取込データで work_date が空でも、説明文と請求日から復元する。
 * 実行前に business_data.db を jarvis/backups/ へ自動バックアップする。
 *
 * 実行:
 *   cd C:\Users\Sunny\snowflakes\jarvis
 *   npm run sync-invoice-work
 *   npm run sync-invoice-work -- 2023
 */

import { mkdirSync, copyFileSync } from 'fs';
import { resolve, dirname, basename } from 'path';
import { fileURLToPath } from 'url';
import { createDb, DEFAULT_DB_PATH } from '../data/db.js';
import { syncAllInvoiceLinesToWorkRecords } from '../data/invoice_work_backfill.js';

const year = process.argv[2] || null;
if (year && !/^\d{4}$/.test(year)) {
  console.error('年は 2023 のような4桁で指定してください。');
  process.exit(1);
}

const __dirname = dirname(fileURLToPath(import.meta.url));
const backupDir = resolve(__dirname, '../backups');
const db = createDb(DEFAULT_DB_PATH);

try {
  db.exec('PRAGMA wal_checkpoint(FULL)');
  mkdirSync(backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = resolve(backupDir, `business_data_before_invoice_sync_${stamp}.db`);
  copyFileSync(DEFAULT_DB_PATH, backupPath);
  console.log(`バックアップ: ${basename(backupPath)}`);

  const result = syncAllInvoiceLinesToWorkRecords(db, { year });
  console.log('請求書 → 仕事一覧 同期完了');
  console.log(`明細: ${result.invoiceLines}件 / 仕事日: ${result.workParts}件`);
  console.log(`新規: ${result.created}件 / 既存一致: ${result.matched}件 / 保留: ${result.ambiguous}件 / スキップ: ${result.skipped}件`);

  const issues = result.details.filter(d => d.status === 'ambiguous' || d.status === 'skipped');
  if (issues.length) {
    console.log('\n要確認:');
    for (const d of issues.slice(0, 50)) {
      console.log(`- ${d.workDate || '日付不明'} ${d.description || ''} : ${d.reason || d.status}`);
    }
  }
} finally {
  db.close();
}
