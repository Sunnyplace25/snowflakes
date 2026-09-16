/**
 * jarvis/tests/test_intercept_manager.mjs
 *
 * Phase 32+ 本実装テスト（インメモリDB・ネットワーク不要）
 *
 * 検証項目:
 *   1. DBマイグレーション成功（created_api列、trading値のINSERT）
 *   2. status マッピング（sold_out → sold）
 *   3. trading の独立保持
 *   4. sold_at の初回設定（sold_out → sold 時のみ）
 *   5. sold_at の再スキャン時不変
 *   6. trading → sold_out 遷移で sold_at が設定される
 *   7. 新規商品登録（全フィールド）
 *   8. 既存商品の更新（price, status, updated_api 等）
 *   9. price_history の挙動（on_sale→価格変化時のみ記録）
 *  10. 同一スキャン再実行で重複・不正履歴が発生しないこと
 *  11. markMissingItems が trading も対象に含めること
 *  12. ベースライン補正: 新規 sold_out アイテムの sold_at = NULL
 *  13. ベースライン補正: 既存 on_sale → sold_out 遷移で sold_at = NULL
 *  14. ベースライン sold と追跡後 sold を sold_at IS NULL で区別できる
 *  15. ベースライン補正では price_history が生成されない
 *  16. ベースライン中の on_sale アイテムは通常通り保存される
 *  17. incomplete スキャン → 既存 on_sale が missing にならない
 *  18. 1回目 incomplete・2回目 complete → リトライ成功・正常 markMissing
 *  19. 全試行 incomplete → エラースロー・スキャンログ incomplete・upsert は実施済み
 *
 * 実行: node tests/test_intercept_manager.mjs
 */

import { createDb } from '../data/db.js';
import {
  insertAccount, startScan, finishScan,
  upsertItem, markMissingItems, runSellerScan,
} from '../data/merch_competitor_manager.js';

// ─── テストユーティリティ ──────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    console.log(`  ✅ ${label}`);
    passed++;
  } else {
    console.error(`  ❌ ${label}`);
    failed++;
  }
}

function assertEqual(actual, expected, label) {
  if (actual === expected) {
    console.log(`  ✅ ${label}: ${JSON.stringify(actual)}`);
    passed++;
  } else {
    console.error(`  ❌ ${label}: 期待=${JSON.stringify(expected)}, 実際=${JSON.stringify(actual)}`);
    failed++;
  }
}

// ─── セットアップ ──────────────────────────────────────────────────────────────

function setup() {
  const db = createDb(':memory:');
  const { id: accountId } = insertAccount(db, {
    mercari_user_id: 'TEST_USER_001',
    display_name:    'テストセラー',
    profile_url:     'https://jp.mercari.com/user/profile/TEST_USER_001',
  });
  const scanId = startScan(db, accountId, '2026-09-16');
  return { db, accountId, scanId };
}

// ─── テスト本体 ───────────────────────────────────────────────────────────────

function test1_migration(db) {
  console.log('\n【テスト 1: DBマイグレーション成功】');

  // created_api 列の存在確認
  const cols = db.prepare('PRAGMA table_info(merch_competitor_items)').all();
  const colNames = cols.map(c => c.name);
  assert(colNames.includes('created_api'),        'created_api 列が存在する');
  assert(colNames.includes('updated_api'),         'updated_api 列が存在する');
  assert(colNames.includes('num_likes'),           'num_likes 列が存在する');
  assert(colNames.includes('num_comments'),        'num_comments 列が存在する');
  assert(colNames.includes('shipping_from_area'),  'shipping_from_area 列が存在する');
  assert(colNames.includes('is_archived'),         'is_archived 列が存在する');

  // trading 値が INSERT できること
  const { id: accId } = insertAccount(db, {
    mercari_user_id: 'MIGRATION_TEST',
    display_name:    'migration test',
    profile_url:     'https://jp.mercari.com/user/profile/MIGRATION_TEST',
  });
  const scanId = startScan(db, accId, '2026-09-16');
  let ok = true;
  try {
    upsertItem(db, accId, scanId, {
      mercari_item_id: 'TRADING_TEST_001',
      name: 'trading テスト商品',
      price: 1000,
      status: 'trading',
    });
  } catch (e) {
    ok = false;
    console.error('  ERROR:', e.message);
  }
  assert(ok, "status='trading' の INSERT が成功する");

  const row = db.prepare(
    `SELECT status FROM merch_competitor_items WHERE mercari_item_id = ?`
  ).get('TRADING_TEST_001');
  assertEqual(row?.status, 'trading', 'DB に trading が保存されている');
}

function test2_statusMapping(db, accountId, scanId) {
  console.log('\n【テスト 2: status マッピング (sold_out → sold)】');

  // sold_out として upsert
  const r = upsertItem(db, accountId, scanId, {
    mercari_item_id: 'MAP_TEST_SOLD_001',
    name:   'sold_out マッピングテスト',
    price:  500,
    status: 'sold_out',
  });
  assert(r.isNew, '新規登録');

  const row = db.prepare(
    `SELECT status, sold_at FROM merch_competitor_items WHERE mercari_item_id = ?`
  ).get('MAP_TEST_SOLD_001');
  assertEqual(row?.status, 'sold', 'sold_out → DB では sold に変換されている');
  assert(row?.sold_at !== null, 'sold_at が設定されている');
}

function test3_tradingIndependent(db, accountId, scanId) {
  console.log('\n【テスト 3: trading の独立保持】');

  upsertItem(db, accountId, scanId, {
    mercari_item_id: 'TRADING_IND_001',
    name:   'trading 独立テスト',
    price:  800,
    status: 'trading',
  });

  const row = db.prepare(
    `SELECT status, sold_at FROM merch_competitor_items WHERE mercari_item_id = ?`
  ).get('TRADING_IND_001');
  assertEqual(row?.status, 'trading', 'DB に trading がそのまま保存されている');
  assert(row?.sold_at === null, 'trading では sold_at が設定されない');
}

function test4_soldAtFirstSet(db, accountId, scanId) {
  console.log('\n【テスト 4: sold_at の初回設定（on_sale → sold_out）】');

  // まず on_sale で登録
  upsertItem(db, accountId, scanId, {
    mercari_item_id: 'SOLDAT_TEST_001',
    name:   'sold_at テスト商品',
    price:  1200,
    status: 'on_sale',
  });
  const before = db.prepare(
    `SELECT sold_at FROM merch_competitor_items WHERE mercari_item_id = ?`
  ).get('SOLDAT_TEST_001');
  assert(before?.sold_at === null, '初回 on_sale では sold_at = null');

  // sold_out に変化
  const scanId2 = startScan(db, accountId, '2026-09-17');
  const r = upsertItem(db, accountId, scanId2, {
    mercari_item_id: 'SOLDAT_TEST_001',
    name:   'sold_at テスト商品',
    price:  1200,
    status: 'sold_out',
  });
  assert(r.isSold, 'isSold=true が返る');

  const after = db.prepare(
    `SELECT status, sold_at FROM merch_competitor_items WHERE mercari_item_id = ?`
  ).get('SOLDAT_TEST_001');
  assertEqual(after?.status, 'sold', 'status が sold に更新された');
  assert(after?.sold_at !== null, 'sold_at が設定された');
  return after?.sold_at;
}

function test5_soldAtImmutable(db, accountId, firstSoldAt) {
  console.log('\n【テスト 5: sold_at の再スキャン時不変】');

  const scanId3 = startScan(db, accountId, '2026-09-18');
  upsertItem(db, accountId, scanId3, {
    mercari_item_id: 'SOLDAT_TEST_001',
    name:   'sold_at テスト商品',
    price:  1200,
    status: 'sold_out',
  });

  const row = db.prepare(
    `SELECT sold_at FROM merch_competitor_items WHERE mercari_item_id = ?`
  ).get('SOLDAT_TEST_001');
  assertEqual(row?.sold_at, firstSoldAt, 're-upsert で sold_at が変化しない');
}

function test6_tradingToSold(db, accountId) {
  console.log('\n【テスト 6: trading → sold_out 遷移で sold_at が設定される】');

  const scanId4 = startScan(db, accountId, '2026-09-19');
  upsertItem(db, accountId, scanId4, {
    mercari_item_id: 'TRADING_TO_SOLD_001',
    name:   'trading→sold テスト',
    price:  2000,
    status: 'trading',
  });
  const mid = db.prepare(
    `SELECT status, sold_at FROM merch_competitor_items WHERE mercari_item_id = ?`
  ).get('TRADING_TO_SOLD_001');
  assertEqual(mid?.status, 'trading', 'trading として保存');
  assert(mid?.sold_at === null, 'trading 時点では sold_at なし');

  // sold_out に遷移
  const scanId5 = startScan(db, accountId, '2026-09-20');
  const r = upsertItem(db, accountId, scanId5, {
    mercari_item_id: 'TRADING_TO_SOLD_001',
    name:   'trading→sold テスト',
    price:  2000,
    status: 'sold_out',
  });
  assert(r.isSold, 'isSold=true');

  const after = db.prepare(
    `SELECT status, sold_at FROM merch_competitor_items WHERE mercari_item_id = ?`
  ).get('TRADING_TO_SOLD_001');
  assertEqual(after?.status, 'sold', 'trading → sold に変化');
  assert(after?.sold_at !== null, 'sold_at が設定された');
}

function test7_newItemAllFields(db, accountId, scanId) {
  console.log('\n【テスト 7: 新規商品登録（全フィールド確認）】');

  upsertItem(db, accountId, scanId, {
    mercari_item_id:    'FULL_FIELDS_001',
    name:               'フルフィールドテスト',
    price:              3000,
    status:             'on_sale',
    image_url:          'https://example.com/img.jpg',
    brand:              'テストブランド',
    category:           'テストカテゴリ',
    created_api:        '2026-01-01 10:00:00',
    updated_api:        '2026-09-01 12:00:00',
    num_likes:          42,
    num_comments:       5,
    shipping_from_area: '東京都',
    is_archived:        0,
  });

  const row = db.prepare(
    `SELECT * FROM merch_competitor_items WHERE mercari_item_id = ?`
  ).get('FULL_FIELDS_001');
  assertEqual(row?.name,               'フルフィールドテスト',    'name');
  assertEqual(row?.price,              3000,                       'price');
  assertEqual(row?.status,             'on_sale',                  'status');
  assertEqual(row?.brand,              'テストブランド',           'brand');
  assertEqual(row?.category,           'テストカテゴリ',           'category');
  assertEqual(row?.created_api,        '2026-01-01 10:00:00',      'created_api');
  assertEqual(row?.updated_api,        '2026-09-01 12:00:00',      'updated_api');
  assertEqual(row?.num_likes,          42,                         'num_likes');
  assertEqual(row?.num_comments,       5,                          'num_comments');
  assertEqual(row?.shipping_from_area, '東京都',                   'shipping_from_area');
  assertEqual(row?.is_archived,        0,                          'is_archived');
}

function test8_existingItemUpdate(db, accountId, scanId) {
  console.log('\n【テスト 8: 既存商品の更新】');

  upsertItem(db, accountId, scanId, {
    mercari_item_id: 'UPDATE_TEST_001',
    name:   '更新テスト商品',
    price:  1000,
    status: 'on_sale',
    updated_api: '2026-09-01 00:00:00',
    num_likes: 10,
  });

  const scanId2 = startScan(db, accountId, '2026-09-21');
  upsertItem(db, accountId, scanId2, {
    mercari_item_id: 'UPDATE_TEST_001',
    name:   '更新テスト商品（名称変更）',
    price:  900,
    status: 'on_sale',
    updated_api: '2026-09-16 09:00:00',
    num_likes: 15,
  });

  const row = db.prepare(
    `SELECT name, price, updated_api, num_likes FROM merch_competitor_items WHERE mercari_item_id = ?`
  ).get('UPDATE_TEST_001');
  assertEqual(row?.name,       '更新テスト商品（名称変更）', 'name が更新されている');
  assertEqual(row?.price,      900,                          'price が更新されている');
  assertEqual(row?.updated_api,'2026-09-16 09:00:00',        'updated_api が更新されている');
  assertEqual(row?.num_likes,  15,                           'num_likes が更新されている');
}

function test9_priceHistory(db, accountId) {
  console.log('\n【テスト 9: price_history の挙動】');

  const scanId = startScan(db, accountId, '2026-09-22');
  upsertItem(db, accountId, scanId, {
    mercari_item_id: 'PRICE_TEST_001',
    name:   '価格変更テスト',
    price:  2000,
    status: 'on_sale',
  });

  // 価格変更（on_sale → on_sale, 価格変化）→ 記録されるべき
  const scanId2 = startScan(db, accountId, '2026-09-23');
  const r1 = upsertItem(db, accountId, scanId2, {
    mercari_item_id: 'PRICE_TEST_001',
    name:   '価格変更テスト',
    price:  1800,
    status: 'on_sale',
  });
  assert(r1.isPriceChange, '価格変化が検知された');

  const hist = db.prepare(
    `SELECT * FROM merch_competitor_price_history WHERE item_id = ?`
  ).all(r1.itemId);
  assertEqual(hist.length, 1, 'price_history に1件記録された');
  assertEqual(hist[0]?.price_from, 2000, 'price_from = 2000');
  assertEqual(hist[0]?.price_to,   1800, 'price_to = 1800');

  // trading 中の価格は記録しない
  const scanId3 = startScan(db, accountId, '2026-09-24');
  upsertItem(db, accountId, scanId3, {
    mercari_item_id: 'PRICE_TEST_001',
    name:   '価格変更テスト',
    price:  1500,   // 変化しているが trading なので記録しない
    status: 'trading',
  });
  const hist2 = db.prepare(
    `SELECT * FROM merch_competitor_price_history WHERE item_id = ?`
  ).all(r1.itemId);
  assertEqual(hist2.length, 1, 'trading 中の価格変化は price_history に記録されない');

  // sold 後の価格変化も記録しない
  const scanId4 = startScan(db, accountId, '2026-09-25');
  upsertItem(db, accountId, scanId4, {
    mercari_item_id: 'PRICE_TEST_001',
    name:   '価格変更テスト',
    price:  999,
    status: 'sold_out',
  });
  const scanId5 = startScan(db, accountId, '2026-09-26');
  const r2 = upsertItem(db, accountId, scanId5, {
    mercari_item_id: 'PRICE_TEST_001',
    price:  888,
    status: 'sold_out',
  });
  assert(!r2.isPriceChange, 'sold 後の価格変化は検知されない');
}

function test10_noduplicateOnRescan(db, accountId) {
  console.log('\n【テスト 10: 同一スキャン再実行で重複・不正履歴なし】');

  const scanId = startScan(db, accountId, '2026-09-27');
  const item = {
    mercari_item_id: 'RESCAN_TEST_001',
    name:   '再スキャンテスト',
    price:  500,
    status: 'on_sale',
  };

  // 1回目
  const r1 = upsertItem(db, accountId, scanId, item);
  assert(r1.isNew, '1回目: 新規');

  // 同一 scanId で 2回目（同一データ）
  const r2 = upsertItem(db, accountId, scanId, item);
  assert(!r2.isNew, '2回目: 新規にならない');

  const rows = db.prepare(
    `SELECT COUNT(*) AS cnt FROM merch_competitor_items WHERE mercari_item_id = ?`
  ).get('RESCAN_TEST_001');
  assertEqual(rows?.cnt, 1, 'DB に重複行が発生しない');

  const events = db.prepare(
    `SELECT COUNT(*) AS cnt FROM merch_competitor_scan_events WHERE item_id = ?`
  ).get(r1.itemId);
  assertEqual(events?.cnt, 1, 'scan_events が重複して追加されない');
}

function test11_markMissingTrading(db) {
  console.log('\n【テスト 11: markMissingItems が trading を対象に含める】');

  // 専用アカウントで独立して検証
  const { id: accountId } = insertAccount(db, {
    mercari_user_id: 'MISSING_TEST_ACCT',
    display_name:    'missing テスト用アカウント',
    profile_url:     'https://jp.mercari.com/user/profile/MISSING_TEST_ACCT',
  });
  const scanId = startScan(db, accountId, '2026-09-28');
  // on_sale 商品
  const r1 = upsertItem(db, accountId, scanId, {
    mercari_item_id: 'MISS_ON_SALE_001',
    name: 'on_sale missing テスト',
    price: 300,
    status: 'on_sale',
  });
  // trading 商品
  const r2 = upsertItem(db, accountId, scanId, {
    mercari_item_id: 'MISS_TRADING_001',
    name: 'trading missing テスト',
    price: 400,
    status: 'trading',
  });
  // sold 商品（missing 対象外）
  const r3 = upsertItem(db, accountId, scanId, {
    mercari_item_id: 'MISS_SOLD_001',
    name: 'sold missing テスト',
    price: 500,
    status: 'sold_out',
  });

  // 次スキャンで全商品が消えた想定（seenIds = 空）
  const scanId2 = startScan(db, accountId, '2026-09-29');
  const missingCount = markMissingItems(db, accountId, scanId2, new Set());

  assertEqual(missingCount, 2, 'on_sale と trading の2件が missing になる');

  const onSaleRow = db.prepare(
    `SELECT status FROM merch_competitor_items WHERE id = ?`
  ).get(r1.itemId);
  assertEqual(onSaleRow?.status, 'missing', 'on_sale が missing に変わった');

  const tradingRow = db.prepare(
    `SELECT status FROM merch_competitor_items WHERE id = ?`
  ).get(r2.itemId);
  assertEqual(tradingRow?.status, 'missing', 'trading が missing に変わった');

  const soldRow = db.prepare(
    `SELECT status FROM merch_competitor_items WHERE id = ?`
  ).get(r3.itemId);
  assertEqual(soldRow?.status, 'sold', 'sold は missing にならない');
}

// ─── ベースライン補正テスト ────────────────────────────────────────────────────

function test12_baselineNewSoldItem(db, accountId) {
  console.log('\n【テスト 12: ベースライン補正 — 新規 sold_out アイテムの sold_at = NULL】');

  const scanId = startScan(db, accountId, '2026-10-01');
  const r = upsertItem(db, accountId, scanId, {
    mercari_item_id: 'BASELINE_NEW_001',
    name:  'ベースライン新規sold商品',
    price: 1000,
    status: 'sold_out',
  }, { baseline: true });

  assert(r.isNew, '新規登録として扱われる');

  const row = db.prepare(
    `SELECT status, sold_at FROM merch_competitor_items WHERE mercari_item_id = ?`
  ).get('BASELINE_NEW_001');
  assertEqual(row?.status, 'sold',  'status が sold に変換されている');
  assert(row?.sold_at === null, 'sold_at が NULL（ベースライン補正）');
}

function test13_baselineExistingToSold(db, accountId) {
  console.log('\n【テスト 13: ベースライン補正 — 既存 on_sale → sold_out で sold_at = NULL】');

  // まず通常モードで on_sale 登録
  const scanId = startScan(db, accountId, '2026-10-02');
  upsertItem(db, accountId, scanId, {
    mercari_item_id: 'BASELINE_EXISTING_001',
    name:  'ベースライン既存商品',
    price: 2000,
    status: 'on_sale',
  });

  // ベースラインスキャンで sold_out に変化
  const scanId2 = startScan(db, accountId, '2026-10-03');
  const r = upsertItem(db, accountId, scanId2, {
    mercari_item_id: 'BASELINE_EXISTING_001',
    name:  'ベースライン既存商品',
    price: 2000,
    status: 'sold_out',
  }, { baseline: true });

  assert(r.isSold, 'isSold=true（売却イベントは記録される）');

  const row = db.prepare(
    `SELECT status, sold_at FROM merch_competitor_items WHERE mercari_item_id = ?`
  ).get('BASELINE_EXISTING_001');
  assertEqual(row?.status, 'sold', 'status が sold に更新されている');
  assert(row?.sold_at === null, 'sold_at = NULL（ベースライン補正）');
}

function test14_baselineVsNormalDistinction(db, accountId) {
  console.log('\n【テスト 14: ベースライン sold（sold_at=NULL）と追跡後 sold（sold_at あり）の区別】');

  const scanId = startScan(db, accountId, '2026-10-04');

  // ベースラインで sold_out → sold_at = NULL
  upsertItem(db, accountId, scanId, {
    mercari_item_id: 'DISTINC_BASELINE_001',
    name:  'ベースラインsold',
    price: 500,
    status: 'sold_out',
  }, { baseline: true });

  // 通常モードで on_sale → 次スキャンで sold_out → sold_at が設定される
  upsertItem(db, accountId, scanId, {
    mercari_item_id: 'DISTINC_NORMAL_001',
    name:  '追跡後sold',
    price: 600,
    status: 'on_sale',
  });
  const scanId2 = startScan(db, accountId, '2026-10-05');
  upsertItem(db, accountId, scanId2, {
    mercari_item_id: 'DISTINC_NORMAL_001',
    name:  '追跡後sold',
    price: 600,
    status: 'sold_out',
  });

  const baselineRow = db.prepare(
    `SELECT sold_at FROM merch_competitor_items WHERE mercari_item_id = ?`
  ).get('DISTINC_BASELINE_001');
  const normalRow = db.prepare(
    `SELECT sold_at FROM merch_competitor_items WHERE mercari_item_id = ?`
  ).get('DISTINC_NORMAL_001');

  assert(baselineRow?.sold_at === null, 'ベースライン sold: sold_at = NULL');
  assert(normalRow?.sold_at !== null,   '追跡後 sold: sold_at が設定されている');

  // status='sold' AND sold_at IS NULL でベースライン商品だけ絞り込める
  const baselineCount = db.prepare(
    `SELECT COUNT(*) AS cnt FROM merch_competitor_items
      WHERE account_id = ? AND status = 'sold' AND sold_at IS NULL`
  ).get(accountId).cnt;
  const trackedCount = db.prepare(
    `SELECT COUNT(*) AS cnt FROM merch_competitor_items
      WHERE account_id = ? AND status = 'sold' AND sold_at IS NOT NULL`
  ).get(accountId).cnt;

  assert(baselineCount >= 1, "sold_at IS NULL で過去 sold を特定できる");
  assert(trackedCount  >= 1, "sold_at IS NOT NULL で追跡後 sold を特定できる");
}

function test15_baselineNoPriceHistory(db, accountId) {
  console.log('\n【テスト 15: ベースライン補正では price_history が生成されない】');

  const scanId = startScan(db, accountId, '2026-10-06');
  upsertItem(db, accountId, scanId, {
    mercari_item_id: 'BASELINE_NOHIST_001',
    name:  'ベースラインprice_historyなし',
    price: 3000,
    status: 'on_sale',
  });

  // ベースラインで sold_out に変化（価格も変化）
  const scanId2 = startScan(db, accountId, '2026-10-07');
  const r = upsertItem(db, accountId, scanId2, {
    mercari_item_id: 'BASELINE_NOHIST_001',
    name:  'ベースラインprice_historyなし',
    price: 2500,   // 価格変化があっても sold なので記録しない
    status: 'sold_out',
  }, { baseline: true });

  const hist = db.prepare(
    `SELECT COUNT(*) AS cnt FROM merch_competitor_price_history WHERE item_id = ?`
  ).get(r.itemId);
  assert(!r.isPriceChange,  'isPriceChange=false（sold は価格変化対象外）');
  assertEqual(hist?.cnt, 0, 'price_history に記録なし');
}

function test16_baselineOnSaleUnaffected(db, accountId) {
  console.log('\n【テスト 16: ベースライン中の on_sale アイテムは通常通り保存される】');

  const scanId = startScan(db, accountId, '2026-10-08');
  upsertItem(db, accountId, scanId, {
    mercari_item_id: 'BASELINE_ONSALE_001',
    name:  'ベースライン中のon_sale',
    price: 800,
    status: 'on_sale',
  }, { baseline: true });

  const row = db.prepare(
    `SELECT status, sold_at FROM merch_competitor_items WHERE mercari_item_id = ?`
  ).get('BASELINE_ONSALE_001');
  assertEqual(row?.status,  'on_sale', 'on_sale として保存される');
  assert(row?.sold_at === null, 'on_sale の sold_at は NULL（影響なし）');
}

// ─── incomplete スキャン / runSellerScan テスト ────────────────────────────────

async function test17_incompleteSkipsMarkMissing(db) {
  console.log('\n【テスト 17: incomplete スキャン → 既存 on_sale が missing にならない】');

  // 専用アカウントで独立して検証
  const { id: accountId } = insertAccount(db, {
    mercari_user_id: 'INC_SKIP_ACCT',
    display_name:    'incomplete skip test',
    profile_url:     'https://jp.mercari.com/user/profile/INC_SKIP_ACCT',
  });

  // 初期データ: 3件を on_sale で登録
  const scanId0 = startScan(db, accountId, '2026-10-20');
  upsertItem(db, accountId, scanId0, { mercari_item_id: 'INC_A', price: 100, status: 'on_sale' });
  upsertItem(db, accountId, scanId0, { mercari_item_id: 'INC_B', price: 200, status: 'on_sale' });
  upsertItem(db, accountId, scanId0, { mercari_item_id: 'INC_C', price: 300, status: 'on_sale' });

  // incomplete な fetchFn: INC_A と INC_B のみ、scanComplete=false
  const mockFetch = async () => ({
    items: [
      { mercari_item_id: 'INC_A', price: 100, status: 'on_sale' },
      { mercari_item_id: 'INC_B', price: 200, status: 'on_sale' },
    ],
    scanComplete:     false,
    incompleteReason: 'test: has_next=false not received',
  });

  let threw = false;
  try {
    await runSellerScan(db, accountId, mockFetch, {
      maxRetries: 1, retryDelay: 0, scanDate: '2026-10-21',
    });
  } catch {
    threw = true;
  }

  assert(threw, 'incomplete scan でエラーがスローされる');

  // INC_C はスキャン結果に含まれなかったが missing にはならない
  const c = db.prepare(
    `SELECT status FROM merch_competitor_items WHERE mercari_item_id = ?`
  ).get('INC_C');
  assertEqual(c?.status, 'on_sale', 'INC_C が missing にならない（incomplete scan）');

  // INC_A は upsert されている
  const a = db.prepare(`SELECT status FROM merch_competitor_items WHERE mercari_item_id = ?`).get('INC_A');
  assertEqual(a?.status, 'on_sale', 'INC_A は upsert済み');

  // スキャンログが incomplete で記録されている
  const scan = db.prepare(
    `SELECT status, error_message FROM merch_competitor_scans WHERE scan_date = '2026-10-21' AND account_id = ?`
  ).get(accountId);
  assertEqual(scan?.status, 'incomplete', 'スキャンログに incomplete が記録されている');
  assert(scan?.error_message !== null, 'error_message が記録されている');
}

async function test18_retrySucceeds(db) {
  console.log('\n【テスト 18: 1回目 incomplete・2回目 complete → リトライ成功】');

  // 専用アカウント
  const { id: accountId } = insertAccount(db, {
    mercari_user_id: 'RETRY_SUCC_ACCT',
    display_name:    'retry success test',
    profile_url:     'https://jp.mercari.com/user/profile/RETRY_SUCC_ACCT',
  });

  // 初期データ: 2件 on_sale
  const scanId0 = startScan(db, accountId, '2026-10-22');
  upsertItem(db, accountId, scanId0, { mercari_item_id: 'RETRY_A', price: 500, status: 'on_sale' });
  upsertItem(db, accountId, scanId0, { mercari_item_id: 'RETRY_B', price: 600, status: 'on_sale' });

  let callCount = 0;
  const mockFetch = async () => {
    callCount++;
    if (callCount === 1) {
      // 1回目: incomplete（RETRY_A のみ）
      return {
        items: [{ mercari_item_id: 'RETRY_A', price: 500, status: 'on_sale' }],
        scanComplete:     false,
        incompleteReason: 'test: first attempt incomplete',
      };
    }
    // 2回目: complete（全件 + 新規 RETRY_C、RETRY_B は sold_out）
    return {
      items: [
        { mercari_item_id: 'RETRY_A', price: 500, status: 'on_sale' },
        { mercari_item_id: 'RETRY_B', price: 600, status: 'sold_out' },
        { mercari_item_id: 'RETRY_C', price: 700, status: 'on_sale'  },
      ],
      scanComplete:     true,
      incompleteReason: null,
    };
  };

  const result = await runSellerScan(db, accountId, mockFetch, {
    maxRetries: 2, retryDelay: 0, scanDate: '2026-10-23',
  });

  assertEqual(callCount,        2, '2回試行された');
  assertEqual(result.itemCount, 3, '3件取得');
  // RETRY_A=on_sale(seenIds), RETRY_B=sold(not targeted), RETRY_C=on_sale(seenIds) → missing=0
  assertEqual(result.counts.missing, 0, 'missing 0件（完了スキャン・全件 seenIds 内）');

  const b = db.prepare(`SELECT status, sold_at FROM merch_competitor_items WHERE mercari_item_id = ?`).get('RETRY_B');
  assertEqual(b?.status, 'sold', 'RETRY_B が sold になった');
  assert(b?.sold_at !== null, 'RETRY_B の sold_at が設定されている');

  const c = db.prepare(`SELECT status FROM merch_competitor_items WHERE mercari_item_id = ?`).get('RETRY_C');
  assertEqual(c?.status, 'on_sale', 'RETRY_C が新規登録された');

  const scan = db.prepare(
    `SELECT status FROM merch_competitor_scans WHERE scan_date = '2026-10-23' AND account_id = ?`
  ).get(accountId);
  assertEqual(scan?.status, 'completed', 'スキャンログが completed');
}

async function test19_allRetriesIncomplete(db) {
  console.log('\n【テスト 19: 全試行 incomplete → エラースロー・incomplete 記録・upsert 実施済み】');

  // 専用アカウント
  const { id: accountId } = insertAccount(db, {
    mercari_user_id: 'ALL_INC_ACCT',
    display_name:    'all retries incomplete test',
    profile_url:     'https://jp.mercari.com/user/profile/ALL_INC_ACCT',
  });

  let callCount = 0;
  const mockFetch = async () => {
    callCount++;
    return {
      items: [{ mercari_item_id: `ALLRETRY_${callCount}`, price: 100, status: 'on_sale' }],
      scanComplete:     false,
      incompleteReason: 'test: always incomplete',
    };
  };

  let threw = false;
  let thrownMsg = '';
  try {
    await runSellerScan(db, accountId, mockFetch, {
      maxRetries: 2, retryDelay: 0, scanDate: '2026-10-24',
    });
  } catch (e) {
    threw     = true;
    thrownMsg = e.message ?? '';
  }

  assertEqual(callCount, 2, '2回（maxRetries）試行された');
  assert(threw, 'エラーがスローされる');
  assert(thrownMsg.includes('incomplete'), 'エラーメッセージに incomplete が含まれる');

  const scan = db.prepare(
    `SELECT status, error_message FROM merch_competitor_scans WHERE scan_date = '2026-10-24' AND account_id = ?`
  ).get(accountId);
  assertEqual(scan?.status, 'incomplete', 'スキャンログが incomplete');
  assert(scan?.error_message !== null, 'error_message が記録されている');

  // 最後の試行の商品 (ALLRETRY_2) が upsert されている
  const item = db.prepare(
    `SELECT status FROM merch_competitor_items WHERE mercari_item_id = 'ALLRETRY_2'`
  ).get();
  assert(item !== undefined, '最後の試行分がupsert済み (ALLRETRY_2)');
}

// ─── メイン ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n' + '='.repeat(60));
  console.log('Phase 32+ 本実装テスト（インターセプト方式 + manager）');
  console.log('='.repeat(60));

  // テスト 1: マイグレーション
  const { db: db1 } = setup();
  test1_migration(db1);

  // テスト 2-11: 独立した DB で実行
  const { db, accountId, scanId } = setup();
  test2_statusMapping(db, accountId, scanId);
  test3_tradingIndependent(db, accountId, scanId);
  const firstSoldAt = test4_soldAtFirstSet(db, accountId, scanId);
  test5_soldAtImmutable(db, accountId, firstSoldAt);
  test6_tradingToSold(db, accountId);
  test7_newItemAllFields(db, accountId, scanId);
  test8_existingItemUpdate(db, accountId, scanId);
  test9_priceHistory(db, accountId);
  test10_noduplicateOnRescan(db, accountId);
  test11_markMissingTrading(db);

  // テスト 12-16: ベースライン補正モードの検証（専用 DB）
  const { db: db3, accountId: accountId3 } = setup();
  test12_baselineNewSoldItem(db3, accountId3);
  test13_baselineExistingToSold(db3, accountId3);
  test14_baselineVsNormalDistinction(db3, accountId3);
  test15_baselineNoPriceHistory(db3, accountId3);
  test16_baselineOnSaleUnaffected(db3, accountId3);

  // テスト 17-19: incomplete スキャン / runSellerScan の検証（専用 DB）
  const { db: db4, accountId: accountId4 } = setup();
  await test17_incompleteSkipsMarkMissing(db4, accountId4);
  await test18_retrySucceeds(db4, accountId4);
  await test19_allRetriesIncomplete(db4, accountId4);

  // ─── 結果サマリー ─────────────────────────────────────────────────────────
  console.log('\n' + '='.repeat(60));
  console.log(`テスト完了: ${passed + failed}件`);
  console.log(`  ✅ 合格: ${passed}件`);
  console.log(`  ❌ 失敗: ${failed}件`);
  console.log('='.repeat(60));

  if (failed > 0) {
    console.error('\n一部テストが失敗しました。本番DB への反映を保留してください。');
    process.exit(1);
  } else {
    console.log('\n全テスト合格。本番DB への反映を承認できます。');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
