#!/usr/bin/env node
/**
 * jarvis/automation/sf_ops_runner.js
 * Snow flakes Ops Runner（Phase 10）
 *
 * JARVIS Dashboard を開かなくても GA4 と AUTO source の同期、
 * freshness 評価・attention 生成を実行するための CLI ランナー。
 *
 * 使用方法:
 *   node jarvis/automation/sf_ops_runner.js
 *   node jarvis/automation/sf_ops_runner.js --dry-run
 *   node jarvis/automation/sf_ops_runner.js --report-only
 *   node jarvis/automation/sf_ops_runner.js --source instagram
 *
 * オプション:
 *   --dry-run      同期を実行せず freshness だけ評価して終了
 *   --report-only  sync せず attention 一覧だけ表示して終了
 *   --source <s>   指定 source のみ実行（AUTO source のみ有効）
 *   --no-notify    last_notified_at を更新しない（クールダウンを消費しない）
 *
 * 環境変数:
 *   SF_DB_PATH — DB パスを上書きする場合に設定（省略時は data/business_data.db）
 */

import { createDb, DEFAULT_DB_PATH } from '../data/db.js';
import { syncGa4 } from '../importers/ga4_collector.js';
import {
  getSyncStatus,
  getAttentionItems,
  runAutoSync,
  runSourceSync,
  AUTO_SOURCES,
  MANUAL_SOURCES,
} from '../data/sf_sync_manager.js';

// ─── 引数パース ──────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const isDryRun     = args.includes('--dry-run');
const isReportOnly = args.includes('--report-only');
const noNotify     = args.includes('--no-notify');
const sourceIdx    = args.indexOf('--source');
const targetSource = sourceIdx >= 0 ? args[sourceIdx + 1] : null;

// ─── DB 接続 ─────────────────────────────────────────────────────────────────

const dbPath = process.env.SF_DB_PATH ?? DEFAULT_DB_PATH;
let db;
try {
  db = createDb(dbPath);
} catch (err) {
  console.error(`[sf_ops_runner] DB 接続失敗: ${err.message}`);
  process.exit(1);
}

async function runGa4DailySync() {
  if (!process.env.GA4_PROPERTY_ID) {
    console.log('[sf_ops_runner] GA4: 未設定のためスキップ');
    return { success: false, skipped: true };
  }

  try {
    // 毎朝の更新でも直近90日を再取得して、遅延確定したGA4値も上書き反映する。
    const result = await syncGa4(db, {});
    console.log(`  ✓ ga4: 成功 (${result.startDate} ～ ${result.endDate}, daily ${result.daily.written}件 / events ${result.events.written}件)`);
    return { success: true, result };
  } catch (err) {
    // GA4だけ失敗しても YouTube / Instagram 等の同期は続行する。
    console.error(`  ✗ ga4: 失敗 — ${err.message}`);
    return { success: false, error: err.message };
  }
}

// ─── メイン処理 ──────────────────────────────────────────────────────────────

async function main() {
  const now = new Date().toISOString();
  console.log(`[sf_ops_runner] 開始 ${now}`);

  // report-only モード: sync せずに現在状態を表示して終了
  if (isReportOnly) {
    const status = getSyncStatus(db);
    console.log('\n=== Sync Status ===');
    for (const s of status.sources) {
      const flag = s.requires_user_action ? '⚠' : '✓';
      console.log(`  ${flag} [${s.mode.toUpperCase()}] ${s.label}: ${s.status} (last: ${s.last_data_date ?? 'none'})`);
    }

    const items = getAttentionItems(db, { ignoreCooldown: noNotify || isReportOnly });
    if (items.length > 0) {
      console.log(`\n=== 要確認 ${items.length} 件 ===`);
      for (const item of items) {
        console.log(`  [${item.severity.toUpperCase()}] ${item.label}: ${item.message}`);
      }
    } else {
      console.log('\n要確認なし');
    }
    db.close?.();
    return;
  }

  // 通常の日次実行では GA4 も同じタイミングで更新する。
  // --source 指定時は従来どおり指定 source だけを実行する。
  if (!isDryRun && !targetSource) {
    console.log('[sf_ops_runner] GA4 を同期します');
    await runGa4DailySync();
  }

  // AUTO sync 実行
  let syncResult;
  if (isDryRun) {
    console.log('[sf_ops_runner] --dry-run モード（sync スキップ）');
    syncResult = null;
  } else if (targetSource) {
    if (!AUTO_SOURCES.includes(targetSource)) {
      if (MANUAL_SOURCES.includes(targetSource)) {
        console.error(`[sf_ops_runner] ${targetSource} は MANUAL source です。自動取得できません`);
      } else {
        console.error(`[sf_ops_runner] 不明な source: ${targetSource}`);
      }
      db.close?.();
      process.exit(1);
    }
    console.log(`[sf_ops_runner] ${targetSource} のみ同期します`);
    const r = await runSourceSync(db, targetSource);
    syncResult = {
      overall:   r.success ? 'success' : 'failed',
      results:   [r],
      succeeded: r.success ? [r.source] : [],
      failed:    r.success ? [] : [r.source],
    };
  } else {
    console.log('[sf_ops_runner] AUTO sources を同期します:', AUTO_SOURCES.join(', '));
    syncResult = await runAutoSync(db);
  }

  // 同期結果ログ（成功は簡潔に、失敗は詳細に）
  if (syncResult) {
    for (const r of syncResult.results) {
      if (r.success) {
        console.log(`  ✓ ${r.source}: 成功 (data_date: ${r.data_date ?? 'n/a'})`);
      } else {
        console.error(`  ✗ ${r.source}: 失敗 — ${r.error}`);
      }
    }
    console.log(`[sf_ops_runner] 同期結果: ${syncResult.overall} (${syncResult.succeeded.length}/${syncResult.succeeded.length + syncResult.failed.length})`);
  }

  // freshness 評価 + attention
  const items = getAttentionItems(db, { ignoreCooldown: noNotify });
  if (items.length > 0) {
    console.log(`\n[sf_ops_runner] 要確認 ${items.length} 件:`);
    for (const item of items) {
      console.log(`  [${item.severity.toUpperCase()}] ${item.label}: ${item.message}`);
    }
  }

  const endTime = new Date().toISOString();
  console.log(`[sf_ops_runner] 完了 ${endTime}`);

  db.close?.();
}

main().catch(err => {
  console.error('[sf_ops_runner] 予期しないエラー:', err.message);
  db.close?.();
  process.exit(1);
});
