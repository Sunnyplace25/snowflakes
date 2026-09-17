/**
 * jarvis/tests/test_mercari_competitor.js
 * 競合アカウント分析機能テスト
 *
 * テスト対象:
 *   1. DB スキーマ (Phase 32)
 *   2. manager CRUD
 *   3. URL バリデーション
 *   4. analyzer 分類・買付け上限計算
 *   5. reporter 週次・月次レポート
 *
 * 外部通信: なし（:memory: DB使用、HTTP リクエストなし）
 */

import assert from 'node:assert/strict';
import { createDb } from '../data/db.js';
import {
  listAllAccounts, getAccountByUserId, insertAccount, updateAccount,
  startScan, finishScan, upsertItem, markMissingItems,
  listItems, updateItemClassification,
  upsertNotification, listUnreadNotifications, markNotificationRead,
  getSettings, setSetting,
  getBrandSoldRanking, getCategoryStats, getBuyingCandidates,
  getSoldDaysStats, getUnsoldItemsWithAge,
  getDailyScanSummary,
  extractUserIdFromProfileUrl,
} from '../data/merch_competitor_manager.js';
import { scanOneAccount } from '../data/merch_competitor_scan.js';
import {
  classifyItem, calcMedian, calcBuyingLimit, getConfidence,
} from '../data/merch_competitor_analyzer.js';
import {
  getWeekStart, getMonthStart,
} from '../data/merch_competitor_reporter.js';

// ─── テストユーティリティ ──────────────────────────────────────────────────────

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); failed++; }
}
async function testAsync(name, fn) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); failed++; }
}

// ─── Section 1: DB スキーマ (Phase 32) ──────────────────────────────────────

console.log('\nSection 1: DB スキーマ (Phase 32)');

test('createDb(:memory:) で Phase 32 テーブルが作成される', () => {
  const db = createDb(':memory:');
  const tables = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'merch_competitor%' OR name LIKE 'merch_analysis%' OR name LIKE 'merch_class%'`
  ).all().map(r => r.name);

  const required = [
    'merch_competitor_accounts',
    'merch_competitor_scans',
    'merch_competitor_items',
    'merch_competitor_price_history',
    'merch_competitor_scan_events',
    'merch_competitor_notifications',
    'merch_competitor_reports',
    'merch_analysis_settings',
    'merch_classification_overrides',
  ];
  for (const t of required) {
    assert.ok(tables.includes(t), `テーブル ${t} が存在する`);
  }
  db.close();
});

test('Phase 32 デフォルト設定が投入される', () => {
  const db = createDb(':memory:');
  const settings = getSettings(db);
  assert.ok(settings.fee_rate,            'fee_rate が存在する');
  assert.ok(settings.shipping_cost,       'shipping_cost が存在する');
  assert.ok(settings.min_profit,          'min_profit が存在する');
  assert.ok(settings.max_items_per_scan,  'max_items_per_scan が存在する');
  db.close();
});

test('初期アカウント（はーと♡セール）が投入される', () => {
  const db = createDb(':memory:');
  const account = getAccountByUserId(db, '793350860');
  assert.ok(account, '初期アカウントが存在する');
  assert.equal(account.mercari_user_id, '793350860');
  assert.equal(account.display_name, 'はーと♡セール開催中');
  db.close();
});

// ─── Section 2: manager CRUD ─────────────────────────────────────────────────

console.log('\nSection 2: manager CRUD');

test('アカウント登録・取得', () => {
  const db = createDb(':memory:');
  const { id } = insertAccount(db, {
    mercari_user_id: '999888777',
    display_name:   'テストセラー',
    profile_url:    'https://jp.mercari.com/user/profile/999888777',
  });
  assert.ok(id > 0, 'id が採番される');
  const account = getAccountByUserId(db, '999888777');
  assert.equal(account.display_name, 'テストセラー');
  db.close();
});

test('重複 mercari_user_id は UNIQUE エラー', () => {
  const db = createDb(':memory:');
  insertAccount(db, {
    mercari_user_id: '111222333',
    display_name:   'セラーA',
    profile_url:    'https://jp.mercari.com/user/profile/111222333',
  });
  assert.throws(() => {
    insertAccount(db, {
      mercari_user_id: '111222333',
      display_name:   'セラーB',
      profile_url:    'https://jp.mercari.com/user/profile/111222333',
    });
  }, 'UNIQUE 制約エラー');
  db.close();
});

test('スキャン開始・完了', () => {
  const db = createDb(':memory:');
  const { id: accountId } = insertAccount(db, {
    mercari_user_id: '444555666',
    display_name:   'テスト',
    profile_url:    'https://jp.mercari.com/user/profile/444555666',
  });
  const scanId = startScan(db, accountId, '2026-09-11');
  assert.ok(scanId > 0, 'scanId 採番');

  // 同日の startScan は同一 scanId を返す
  const scanId2 = startScan(db, accountId, '2026-09-11');
  assert.equal(scanId, scanId2, '同日スキャンは再利用');

  finishScan(db, scanId, { status: 'completed', items_fetched: 5, items_new: 3, items_sold: 1, items_price_changed: 1, items_missing: 0, items_reappeared: 0 });
  const scan = db.prepare('SELECT * FROM merch_competitor_scans WHERE id = ?').get(scanId);
  assert.equal(scan.status, 'completed');
  assert.equal(scan.items_fetched, 5);
  db.close();
});

test('商品 upsert — 新規', () => {
  const db = createDb(':memory:');
  const { id: accountId } = insertAccount(db, {
    mercari_user_id: '777000111',
    display_name:   'テスト',
    profile_url:    'https://jp.mercari.com/user/profile/777000111',
  });
  const scanId = startScan(db, accountId, '2026-09-11');
  const result = upsertItem(db, accountId, scanId, {
    mercari_item_id: 'ITEM001',
    name: 'ラルフローレン ポロシャツ Mサイズ',
    price: 3500,
    status: 'on_sale',
    brand: 'POLO RALPH LAUREN',
    category: 'トップス',
  });
  assert.ok(result.isNew, 'isNew = true');
  assert.ok(!result.isSold, 'isSold = false');
  const items = listItems(db, accountId);
  assert.equal(items.length, 1);
  assert.equal(items[0].name, 'ラルフローレン ポロシャツ Mサイズ');
  db.close();
});

test('商品 upsert — 価格変化', () => {
  const db = createDb(':memory:');
  const { id: accountId } = insertAccount(db, {
    mercari_user_id: '777000222',
    display_name:   'テスト',
    profile_url:    'https://jp.mercari.com/user/profile/777000222',
  });
  const scanId1 = startScan(db, accountId, '2026-09-10');
  upsertItem(db, accountId, scanId1, { mercari_item_id: 'ITEM002', name: '商品A', price: 5000, status: 'on_sale' });

  const scanId2 = startScan(db, accountId, '2026-09-11');
  const result = upsertItem(db, accountId, scanId2, { mercari_item_id: 'ITEM002', name: '商品A', price: 4500, status: 'on_sale' });
  assert.ok(result.isPriceChange, 'isPriceChange = true');

  const history = db.prepare('SELECT * FROM merch_competitor_price_history WHERE item_id = ?').all(result.itemId);
  assert.equal(history.length, 1);
  assert.equal(history[0].price_from, 5000);
  assert.equal(history[0].price_to, 4500);
  db.close();
});

test('商品 upsert — 売却', () => {
  const db = createDb(':memory:');
  const { id: accountId } = insertAccount(db, {
    mercari_user_id: '777000333',
    display_name:   'テスト',
    profile_url:    'https://jp.mercari.com/user/profile/777000333',
  });
  const scanId1 = startScan(db, accountId, '2026-09-10');
  upsertItem(db, accountId, scanId1, { mercari_item_id: 'ITEM003', name: '商品B', price: 2000, status: 'on_sale' });

  const scanId2 = startScan(db, accountId, '2026-09-11');
  const result = upsertItem(db, accountId, scanId2, { mercari_item_id: 'ITEM003', name: '商品B', price: 2000, status: 'sold' });
  assert.ok(result.isSold, 'isSold = true');
  const items = listItems(db, accountId, { status: 'sold' });
  assert.equal(items.length, 1);
  db.close();
});

test('missing 判定 — on_sale 商品が未見の場合 missing になる', () => {
  const db = createDb(':memory:');
  const { id: accountId } = insertAccount(db, {
    mercari_user_id: '777000444',
    display_name:   'テスト',
    profile_url:    'https://jp.mercari.com/user/profile/777000444',
  });
  const scanId1 = startScan(db, accountId, '2026-09-10');
  upsertItem(db, accountId, scanId1, { mercari_item_id: 'ITEM004', name: '商品C', price: 1000, status: 'on_sale' });
  upsertItem(db, accountId, scanId1, { mercari_item_id: 'ITEM005', name: '商品D', price: 2000, status: 'on_sale' });

  const scanId2 = startScan(db, accountId, '2026-09-11');
  // ITEM005 だけ見えた → ITEM004 は missing になる
  upsertItem(db, accountId, scanId2, { mercari_item_id: 'ITEM005', name: '商品D', price: 2000, status: 'on_sale' });
  const missingCount = markMissingItems(db, accountId, scanId2, new Set(['ITEM005']));
  assert.equal(missingCount, 1);
  const missing = listItems(db, accountId, { status: 'missing' });
  assert.equal(missing.length, 1);
  assert.equal(missing[0].mercari_item_id, 'ITEM004');
  db.close();
});

test('通知 upsert と既読', () => {
  const db = createDb(':memory:');
  upsertNotification(db, '2026-09-11', { new: 5, sold: 2 });
  let unread = listUnreadNotifications(db);
  assert.equal(unread.length, 1);

  markNotificationRead(db, '2026-09-11');
  unread = listUnreadNotifications(db);
  assert.equal(unread.length, 0);
  db.close();
});

test('設定読み書き', () => {
  const db = createDb(':memory:');
  setSetting(db, 'fee_rate', '0.15');
  const settings = getSettings(db);
  assert.equal(settings.fee_rate, '0.15');
  // 再度セットしても上書き
  setSetting(db, 'fee_rate', '0.10');
  const s2 = getSettings(db);
  assert.equal(s2.fee_rate, '0.10');
  db.close();
});

// ─── Section 3: URL バリデーション ───────────────────────────────────────────

console.log('\nSection 3: URL バリデーション');

test('正常な URL から userId を抽出', () => {
  const uid = extractUserIdFromProfileUrl('https://jp.mercari.com/user/profile/793350860');
  assert.equal(uid, '793350860');
});

test('不正な URL はエラー', () => {
  const badUrls = [
    'https://jp.mercari.com/user/profile/abc',
    'https://jp.mercari.com/user/profile/',
    '',
  ];
  for (const url of badUrls) {
    assert.throws(() => extractUserIdFromProfileUrl(url), `不正 URL はエラー: ${url}`);
  }
});

// ─── Section 4: analyzer ─────────────────────────────────────────────────────

console.log('\nSection 4: analyzer');

test('ブランド分類 — ラルフローレン系', () => {
  const result = classifyItem({ brand: 'POLO RALPH LAUREN', name: 'ポロシャツ', category: 'トップス' });
  assert.equal(result.classified_brand, 'ラルフローレン系', 'POLO RALPH LAUREN → ラルフローレン系');
});

test('ブランド分類 — 日本語ブランド名', () => {
  const result = classifyItem({ brand: 'ラルフローレン', name: 'シャツ', category: null });
  assert.equal(result.classified_brand, 'ラルフローレン系');
});

test('ブランド分類 — ナイキ', () => {
  const result = classifyItem({ brand: 'Nike', name: 'スニーカー', category: null });
  assert.equal(result.classified_brand, 'ナイキ');
});

test('カテゴリ分類 — トップス', () => {
  const result = classifyItem({ brand: null, name: 'ニットセーター 秋冬', category: 'トップス' });
  assert.equal(result.classified_category, 'トップス');
});

test('カテゴリ分類 — バッグ（商品名から）', () => {
  const result = classifyItem({ brand: null, name: 'コーチ ハンドバッグ', category: null });
  assert.equal(result.classified_category, 'バッグ');
});

test('カラー分類', () => {
  const result = classifyItem({ brand: null, name: 'ホワイトシャツ', category: null, color: null });
  assert.equal(result.classified_color, 'ホワイト');
});

test('シーズン分類 — 秋冬', () => {
  const result = classifyItem({ brand: null, name: 'ウールコート 秋冬', category: null });
  assert.equal(result.classified_season, '秋冬');
});

test('中央値計算', () => {
  assert.equal(calcMedian([1000, 2000, 3000]), 2000, '奇数中央値');
  assert.equal(calcMedian([1000, 2000, 3000, 4000]), 2500, '偶数中央値');
  assert.equal(calcMedian([5000]), 5000, '1件');
  assert.equal(calcMedian([]), null, '空は null');
  assert.equal(calcMedian(null), null, 'null は null');
});

test('買付け上限計算', () => {
  // medianSoldPrice=5000, fee_rate=0.10, shipping=600, min_profit=2000
  // limit = floor100(5000 * 0.9 - 600 - 2000) = floor100(4500 - 2600) = floor100(1900) = 1900
  const limit = calcBuyingLimit(5000, { fee_rate: 0.10, shipping_cost: 600, min_profit: 2000 });
  assert.equal(limit, 1900);
});

test('買付け上限 — 利益が出ない場合は null', () => {
  const limit = calcBuyingLimit(500, { fee_rate: 0.10, shipping_cost: 600, min_profit: 2000 });
  assert.equal(limit, null);
});

test('買付け上限 — 100円単位に切り捨て', () => {
  // medianSoldPrice=10000, fee_rate=0.10, shipping=600, min_profit=2000
  // limit = floor100(9000 - 2600) = floor100(6400) = 6400
  const limit = calcBuyingLimit(10000, { fee_rate: 0.10, shipping_cost: 600, min_profit: 2000 });
  assert.equal(limit % 100, 0, '100円単位');
});

test('信頼度判定', () => {
  assert.equal(getConfidence(10), 'high');
  assert.equal(getConfidence(9),  'medium');
  assert.equal(getConfidence(3),  'medium');
  assert.equal(getConfidence(2),  'low');
  assert.equal(getConfidence(0),  'low');
});

// ─── Section 5: reporter 日付ユーティリティ ────────────────────────────────

console.log('\nSection 5: reporter 日付ユーティリティ');

test('getWeekStart — 月曜の日付を返す', () => {
  // 2026-09-11 は金曜日 → 週初月曜は 2026-09-07
  const d = new Date('2026-09-11T10:00:00.000Z');
  const start = getWeekStart(d);
  assert.match(start, /^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD 形式');
  const day = new Date(start + 'T12:00:00+09:00').getDay();
  assert.equal(day, 1, '月曜日');
});

test('getMonthStart — 月初日を返す', () => {
  const d = new Date('2026-09-11T10:00:00.000Z');
  const start = getMonthStart(d);
  assert.match(start, /^\d{4}-\d{2}-01$/, '月初日（01日）');
});

// ─── Section 6: 分析クエリ ────────────────────────────────────────────────────

console.log('\nSection 6: 分析クエリ');

test('getBrandSoldRanking — 売れ筋ブランド集計', () => {
  const db = createDb(':memory:');
  const { id: accountId } = insertAccount(db, {
    mercari_user_id: '888999000',
    display_name:   'テスト',
    profile_url:    'https://jp.mercari.com/user/profile/888999000',
  });

  // sold アイテムを複数登録
  const scanId = startScan(db, accountId, '2026-09-11');
  for (let i = 0; i < 3; i++) {
    const r = upsertItem(db, accountId, scanId, {
      mercari_item_id: `B_ITEM_${i}`,
      name: `ラルフシャツ ${i}`,
      price: 3000 + i * 100,
      status: 'sold',
    });
    updateItemClassification(db, r.itemId, { classified_brand: 'ラルフローレン系' });
  }

  const ranking = getBrandSoldRanking(db, accountId, 5);
  assert.ok(ranking.length > 0, 'ランキング取得');
  assert.equal(ranking[0].brand, 'ラルフローレン系');
  assert.equal(ranking[0].sold_count, 3);
  db.close();
});

test('getDailyScanSummary — 日次集計', () => {
  const db = createDb(':memory:');
  const { id: accountId } = insertAccount(db, {
    mercari_user_id: '999000888',
    display_name:   'テスト',
    profile_url:    'https://jp.mercari.com/user/profile/999000888',
  });
  const scanId = startScan(db, accountId, '2026-09-11');
  upsertItem(db, accountId, scanId, { mercari_item_id: 'S001', name: '商品X', price: 1000, status: 'on_sale' });
  finishScan(db, scanId, { status: 'completed', items_fetched: 1, items_new: 1, items_sold: 0, items_price_changed: 0, items_missing: 0, items_reappeared: 0 });

  const summary = getDailyScanSummary(db, '2026-09-11');
  assert.equal(summary.new, 1, '新規 1 件');
  db.close();
});

// ─── Section 7: sold_at 中間値 ────────────────────────────────────────────────

console.log('\nSection 7: sold_at 中間値・スキャン不完全・統計クエリ');

test('M01 — sold_at: last_seen_at と現在時刻の中間付近に設定される', () => {
  const db = createDb(':memory:');
  const { id: accountId } = insertAccount(db, {
    mercari_user_id: 'M01_USER',
    display_name:   'テスト',
    profile_url:    'https://jp.mercari.com/user/profile/M01_USER',
  });
  const scanId1 = startScan(db, accountId, '2026-09-10');
  const r1 = upsertItem(db, accountId, scanId1, { mercari_item_id: 'M01_ITEM', name: '商品', price: 2000, status: 'on_sale' });

  // last_seen_at が設定されるよう少し待つ代わりに直接 UPDATE で過去時刻を設定
  const pastTime = '2026-09-10 10:00:00';
  db.prepare(`UPDATE merch_competitor_items SET last_seen_at = ? WHERE id = ?`).run(pastTime, r1.itemId);

  const beforeSold = Date.now();
  const scanId2 = startScan(db, accountId, '2026-09-11');
  upsertItem(db, accountId, scanId2, { mercari_item_id: 'M01_ITEM', name: '商品', price: 2000, status: 'sold' });
  const afterSold = Date.now();

  const item = db.prepare('SELECT * FROM merch_competitor_items WHERE id = ?').get(r1.itemId);
  assert.ok(item.sold_at != null, 'sold_at が設定される');

  // sold_at が last_seen_at と現在時刻の中間付近にあるか（±5分のマージン）
  const soldAtMs = new Date(item.sold_at.replace(' ', 'T') + '+09:00').getTime();
  const prevMs   = new Date(pastTime.replace(' ', 'T') + '+09:00').getTime();
  const midMin   = (prevMs + beforeSold) / 2 - 5 * 60 * 1000;
  const midMax   = (prevMs + afterSold)  / 2 + 5 * 60 * 1000;
  assert.ok(soldAtMs >= midMin && soldAtMs <= midMax, `sold_at(${item.sold_at}) が中間範囲内`);
  db.close();
});

test('M02 — baseline モード: sold_at は NULL のまま', () => {
  const db = createDb(':memory:');
  const { id: accountId } = insertAccount(db, {
    mercari_user_id: 'M02_USER',
    display_name:   'テスト',
    profile_url:    'https://jp.mercari.com/user/profile/M02_USER',
  });
  const scanId1 = startScan(db, accountId, '2026-09-10');
  const r1 = upsertItem(db, accountId, scanId1, { mercari_item_id: 'M02_ITEM', name: '商品', price: 1000, status: 'on_sale' });

  const scanId2 = startScan(db, accountId, '2026-09-11');
  upsertItem(db, accountId, scanId2, { mercari_item_id: 'M02_ITEM', name: '商品', price: 1000, status: 'sold' }, { baseline: true });

  const item = db.prepare('SELECT * FROM merch_competitor_items WHERE id = ?').get(r1.itemId);
  assert.equal(item.sold_at, null, 'baseline モードでは sold_at が NULL');
  db.close();
});

await testAsync('S01 — scanOneAccount: scanComplete=false のとき商品ステータス保持、スキャン履歴は incomplete', async () => {
  const db = createDb(':memory:');
  const { id: accountId } = insertAccount(db, {
    mercari_user_id: 'S01_USER',
    display_name:   'テスト',
    profile_url:    'https://jp.mercari.com/user/profile/S01_USER',
  });
  // 事前に on_sale 商品を登録
  const preScanId = startScan(db, accountId, '2026-09-10');
  upsertItem(db, accountId, preScanId, { mercari_item_id: 'S01_PRE', name: '既存商品', price: 3000, status: 'on_sale' });
  finishScan(db, preScanId, { status: 'completed', items_fetched: 1, items_new: 1, items_sold: 0, items_price_changed: 0, items_missing: 0, items_reappeared: 0 });

  const account  = { id: accountId, mercari_user_id: 'S01_USER', display_name: 'テスト' };
  const settings = { max_items_per_scan: 300, fee_rate: '0.1', shipping_cost: '500', min_profit: '100', min_profit_rate: '0.1' };

  const mockFetchName  = async () => 'テスト';
  const mockFetchItems = async () => ({
    items: [{ mercari_item_id: 'S01_ITEM', name: '新商品', price: 2000, status: 'on_sale' }],
    scanComplete: false,
    incompleteReason: 'スキャン途中で中断',
  });

  const result = await scanOneAccount(db, account, settings, '2026-09-11', {
    _fetchNameFn:  mockFetchName,
    _fetchItemsFn: mockFetchItems,
  });

  // 戻り値: ok=false
  assert.ok(!result.ok, 'ok = false');
  assert.equal(result.error, 'スキャン途中で中断', 'error に理由が入る');

  // スキャン履歴が incomplete
  const scan = db.prepare(`SELECT * FROM merch_competitor_scans WHERE account_id = ? AND scan_date = '2026-09-11'`).get(accountId);
  assert.equal(scan.status, 'incomplete', 'スキャン履歴 status = incomplete');

  // 既存商品のステータスは on_sale のまま（markMissingItems は実行されない）
  const preItem = db.prepare(`SELECT status FROM merch_competitor_items WHERE mercari_item_id = 'S01_PRE'`).get();
  assert.equal(preItem.status, 'on_sale', '既存商品の status は変わらない');
  db.close();
});

await testAsync('S02 — scanOneAccount: scanComplete=true のとき正常完了', async () => {
  const db = createDb(':memory:');
  const { id: accountId } = insertAccount(db, {
    mercari_user_id: 'S02_USER',
    display_name:   'テスト',
    profile_url:    'https://jp.mercari.com/user/profile/S02_USER',
  });
  const account  = { id: accountId, mercari_user_id: 'S02_USER', display_name: 'テスト' };
  const settings = { max_items_per_scan: 300, fee_rate: '0.1', shipping_cost: '500', min_profit: '100', min_profit_rate: '0.1' };

  const mockFetchName  = async () => 'テスト';
  const mockFetchItems = async () => ({
    items: [
      { mercari_item_id: 'S02_ITEM1', name: '商品A', price: 1000, status: 'on_sale' },
      { mercari_item_id: 'S02_ITEM2', name: '商品B', price: 2000, status: 'on_sale' },
    ],
    scanComplete: true,
    incompleteReason: null,
  });

  const result = await scanOneAccount(db, account, settings, '2026-09-11', {
    _fetchNameFn:  mockFetchName,
    _fetchItemsFn: mockFetchItems,
  });

  assert.ok(result.ok, 'ok = true');
  assert.equal(result.items_fetched, 2, 'items_fetched = 2');
  assert.equal(result.items_new, 2, 'items_new = 2');
  const scan = db.prepare(`SELECT * FROM merch_competitor_scans WHERE account_id = ?`).get(accountId);
  assert.equal(scan.status, 'completed', 'スキャン履歴 status = completed');
  db.close();
});

await testAsync('S03 — scanComplete=false では markMissingItems が実行されない', async () => {
  const db = createDb(':memory:');
  const { id: accountId } = insertAccount(db, {
    mercari_user_id: 'S03_USER',
    display_name:   'テスト',
    profile_url:    'https://jp.mercari.com/user/profile/S03_USER',
  });
  // 事前に2商品登録
  const preScanId = startScan(db, accountId, '2026-09-10');
  upsertItem(db, accountId, preScanId, { mercari_item_id: 'S03_A', name: '商品A', price: 1000, status: 'on_sale' });
  upsertItem(db, accountId, preScanId, { mercari_item_id: 'S03_B', name: '商品B', price: 2000, status: 'on_sale' });
  finishScan(db, preScanId, { status: 'completed', items_fetched: 2, items_new: 2, items_sold: 0, items_price_changed: 0, items_missing: 0, items_reappeared: 0 });

  const account  = { id: accountId, mercari_user_id: 'S03_USER', display_name: 'テスト' };
  const settings = { max_items_per_scan: 300, fee_rate: '0.1', shipping_cost: '500', min_profit: '100', min_profit_rate: '0.1' };

  // 不完全スキャン: S03_A のみ取得できた（S03_B は見えなかった）
  const mockFetchItems = async () => ({
    items: [{ mercari_item_id: 'S03_A', name: '商品A', price: 1000, status: 'on_sale' }],
    scanComplete: false,
    incompleteReason: 'タイムアウト',
  });

  await scanOneAccount(db, account, settings, '2026-09-11', {
    _fetchNameFn:  async () => 'テスト',
    _fetchItemsFn: mockFetchItems,
  });

  // S03_B は missing になっていないこと
  const itemB = db.prepare(`SELECT status FROM merch_competitor_items WHERE mercari_item_id = 'S03_B'`).get();
  assert.equal(itemB.status, 'on_sale', 'S03_B は on_sale のまま（missing にならない）');
  db.close();
});

test('D01 — getSoldDaysStats: 売却商品の日数統計を返す', () => {
  const db = createDb(':memory:');
  const { id: accountId } = insertAccount(db, {
    mercari_user_id: 'D01_USER',
    display_name:   'テスト',
    profile_url:    'https://jp.mercari.com/user/profile/D01_USER',
  });
  const scanId = startScan(db, accountId, '2026-09-11');
  const r = upsertItem(db, accountId, scanId, {
    mercari_item_id: 'D01_ITEM',
    name: 'テスト商品',
    price: 3000,
    status: 'sold',
    created_api: '2026-09-01 00:00:00',
  });
  // sold_at を直接設定（10日後）
  db.prepare(`UPDATE merch_competitor_items SET sold_at = '2026-09-11 12:00:00' WHERE id = ?`).run(r.itemId);
  updateItemClassification(db, r.itemId, { classified_brand: 'テストブランド', classified_category: 'トップス' });

  const stats = getSoldDaysStats(db, accountId);
  assert.ok(stats.length > 0, '統計が返る');
  assert.equal(stats[0].classified_brand, 'テストブランド');
  assert.ok(stats[0].avg_days != null, 'avg_days が存在する');
  db.close();
});

test('D02 — getUnsoldItemsWithAge: 出品中商品を掲載日数順で返す', () => {
  const db = createDb(':memory:');
  const { id: accountId } = insertAccount(db, {
    mercari_user_id: 'D02_USER',
    display_name:   'テスト',
    profile_url:    'https://jp.mercari.com/user/profile/D02_USER',
  });
  const scanId = startScan(db, accountId, '2026-09-11');
  // 古い商品と新しい商品
  const r1 = upsertItem(db, accountId, scanId, { mercari_item_id: 'D02_OLD', name: '古い商品', price: 1000, status: 'on_sale', created_api: '2026-08-01 00:00:00' });
  const r2 = upsertItem(db, accountId, scanId, { mercari_item_id: 'D02_NEW', name: '新しい商品', price: 2000, status: 'on_sale', created_api: '2026-09-10 00:00:00' });

  const items = getUnsoldItemsWithAge(db, accountId);
  assert.ok(items.length >= 2, '商品が返る');

  // days_listed の大小関係を確認（ORDER に依存しない）
  const oldItem = items.find(i => i.mercari_item_id === 'D02_OLD');
  const newItem = items.find(i => i.mercari_item_id === 'D02_NEW');
  assert.ok(oldItem, 'D02_OLD が含まれる');
  assert.ok(newItem, 'D02_NEW が含まれる');
  assert.ok(
    (oldItem.days_listed ?? 0) >= (newItem.days_listed ?? 0),
    `D02_OLD の days_listed(${oldItem.days_listed}) >= D02_NEW の days_listed(${newItem.days_listed})`
  );

  // データがない場合は空配列
  const empty = getUnsoldItemsWithAge(db, 99999);
  assert.equal(empty.length, 0, '存在しない accountId は空配列');
  db.close();
});

// ─── 集計 ─────────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`);
console.log(`テスト結果: ${passed + failed} 件 / ✅ ${passed} 件成功 / ❌ ${failed} 件失敗`);
if (failed > 0) process.exit(1);
