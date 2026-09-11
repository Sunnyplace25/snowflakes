/**
 * jarvis/data/merch_competitor_importer.js
 * 競合アカウント商品データ 手動取り込み処理
 *
 * 利用者がブラウザで取得した JSON / CSV を受け取り DB へ保存する。
 *
 * 設計方針：
 *   - メルカリの Cookie・ログイン情報・トークンは一切受け取らない
 *   - markMissingItems は呼ばない（部分取り込みのため、未掲載商品を消失扱いにしない）
 *   - 同一 mercari_item_id は upsert（重複登録なし）
 *   - 取り込み後に batchClassify で分類・買付け上限を自動更新
 */

import {
  startManualImportScan, finishScan, upsertItem,
  touchAccountScan, getSettings, updateItemClassification,
  getAccountByUserId, insertAccount, getAccount,
} from './merch_competitor_manager.js';
import { batchClassify } from './merch_competitor_analyzer.js';

// ─── ユーティリティ ────────────────────────────────────────────────────────────

function jstToday() {
  const now = new Date();
  const jst = new Date(now.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10);
}

// ─── ステータス正規化マップ ────────────────────────────────────────────────────

const STATUS_MAP = {
  ITEM_STATUS_ON_SALE:  'on_sale',
  ITEM_STATUS_SOLD_OUT: 'sold',
  ITEM_STATUS_TRADING:  'on_sale',  // 取引中 → 出品中扱い
  ITEM_STATUS_PACKING:  'sold',
  ITEM_STATUS_SHIPPED:  'sold',
  ITEM_STATUS_STOP:     'missing',
  ITEM_STATUS_CANCEL:   'missing',
  on_sale:              'on_sale',
  sold:                 'sold',
  missing:              'missing',
  '出品中':              'on_sale',
  '売却済み':            'sold',
  '取引中':              'on_sale',
  '出品停止':            'missing',
};

// ─── アイテム正規化 ────────────────────────────────────────────────────────────

/**
 * 各種フォーマットのアイテムオブジェクトを共通形式に変換する。
 * @param {object} raw
 * @returns {object}
 */
function normalizeItem(raw) {
  const price = typeof raw.price === 'object'
    ? parseInt(raw.price?.amount ?? raw.price?.value ?? 0, 10)
    : parseInt(raw.price ?? 0, 10);

  const status = STATUS_MAP[raw.status] ?? 'on_sale';

  let color = null;
  if (Array.isArray(raw.colors) && raw.colors.length > 0) {
    color = raw.colors.map(c => (typeof c === 'object' ? c.name : c)).filter(Boolean).join('/');
  } else if (raw.color) {
    color = String(raw.color);
  }

  return {
    mercari_item_id: String(raw.id ?? raw.mercari_item_id ?? '').trim(),
    name:            raw.name ?? '（不明）',
    price,
    status,
    brand:           raw.itemBrand?.name ?? raw.brand ?? null,
    category:        raw.itemCategory?.name ?? raw.category ?? null,
    color,
    material:        null,
    size:            raw.itemSize?.name ?? raw.size ?? null,
    condition_text:  raw.itemCondition?.name ?? raw.condition_text ?? null,
    target_gender:   null,
    season:          null,
    image_url:       raw.thumbnails?.[0] ?? raw.thumbnail ?? raw.image_url ?? null,
    raw_data:        raw,
  };
}

// ─── JSON パーサー ────────────────────────────────────────────────────────────

/**
 * JSON テキストからアイテム配列を抽出する。
 *
 * 対応フォーマット（優先順）:
 *   1. アイテム配列そのもの: [ { id, name, price, ... }, ... ]
 *   2. API レスポンス:       { items: [...] } または { data: { items: [...] } }
 *   3. __NEXT_DATA__ 全体:   { props: { pageProps: { items: [...] } } }
 *
 * @param {string} jsonText
 * @returns {object[]} 正規化済みアイテム配列
 * @throws {Error} 解析失敗 or アイテムが見つからない場合
 */
export function parseJsonItems(jsonText) {
  let obj;
  try {
    obj = JSON.parse(String(jsonText).trim());
  } catch (e) {
    throw new Error(`JSON 解析エラー: ${e.message}`);
  }

  // 1. 配列
  if (Array.isArray(obj)) {
    if (obj.length === 0) throw new Error('アイテム配列が空です');
    return obj.map(normalizeItem);
  }

  // 2. API レスポンス形式
  if (Array.isArray(obj.items))        return obj.items.map(normalizeItem);
  if (Array.isArray(obj.data?.items))  return obj.data.items.map(normalizeItem);

  // 3. __NEXT_DATA__ 形式
  const pp = obj?.props?.pageProps ?? {};
  const candidates = [
    pp.items,
    pp.data?.items,
    pp.seller?.items,
    pp.profile?.items,
    pp.searchResult?.items,
  ];
  for (const c of candidates) {
    if (Array.isArray(c) && c.length > 0) return c.map(normalizeItem);
  }

  throw new Error(
    'JSON からアイテム一覧を取得できませんでした。' +
    'items 配列が見つかりません（__NEXT_DATA__ またはAPIレスポンス形式に対応しています）。'
  );
}

// ─── CSV パーサー ─────────────────────────────────────────────────────────────

/**
 * CSV テキストからアイテム配列を抽出する。
 *
 * 期待ヘッダ（大文字小文字不問・日本語対応）:
 *   商品ID, 商品名, 価格, 状態[, ブランド, カテゴリ, サイズ, 色, 画像URL]
 *
 * @param {string} csvText
 * @returns {object[]} 正規化済みアイテム配列
 * @throws {Error}
 */
export function parseCsvItems(csvText) {
  const lines = String(csvText).trim().split(/\r?\n/).filter(l => l.trim());
  if (lines.length < 2) {
    throw new Error('CSV にデータ行がありません（ヘッダ + 1行以上必要）');
  }

  const COL_ALIASES = {
    id:        ['商品id', 'id', 'item_id', 'mercari_item_id', '商品番号'],
    name:      ['商品名', 'name', '名前', 'タイトル'],
    price:     ['価格', 'price', '金額', '値段'],
    status:    ['状態', 'status'],
    brand:     ['ブランド', 'brand'],
    category:  ['カテゴリ', 'category', 'カテゴリー'],
    size:      ['サイズ', 'size'],
    color:     ['色', 'color', 'カラー'],
    image_url: ['画像url', 'image_url', 'image', '画像'],
  };

  // ヘッダ解析
  const headers = parseCsvLine(lines[0]).map(h => h.toLowerCase().trim());

  const idx = {};
  for (const [field, aliases] of Object.entries(COL_ALIASES)) {
    idx[field] = -1;
    for (const alias of aliases) {
      const i = headers.indexOf(alias);
      if (i >= 0) { idx[field] = i; break; }
    }
  }

  if (idx.id < 0)   throw new Error('CSV に 商品ID 列が必要です（ヘッダ: 商品ID または id）');
  if (idx.name < 0) throw new Error('CSV に 商品名 列が必要です（ヘッダ: 商品名 または name）');

  const items = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    const get = field => (idx[field] >= 0 ? (cols[idx[field]] ?? '') : '');

    const itemId = get('id').trim();
    if (!itemId) continue; // 空行はスキップ

    items.push(normalizeItem({
      id:        itemId,
      name:      get('name') || '（不明）',
      price:     get('price'),
      status:    get('status') || 'on_sale',
      brand:     get('brand') || null,
      category:  get('category') || null,
      size:      get('size') || null,
      color:     get('color') || null,
      image_url: get('image_url') || null,
    }));
  }

  if (items.length === 0) throw new Error('CSV にデータ行がありませんでした');
  return items;
}

/** CSV の1行をカンマ分割する（ダブルクォート対応）。 */
function parseCsvLine(line) {
  const result = [];
  let current = '';
  let inQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuote) {
      if (ch === '"' && line[i + 1] === '"') { current += '"'; i++; }
      else if (ch === '"') { inQuote = false; }
      else { current += ch; }
    } else {
      if (ch === '"') { inQuote = true; }
      else if (ch === ',') { result.push(current); current = ''; }
      else { current += ch; }
    }
  }
  result.push(current);
  return result;
}

// ─── DB への保存 ───────────────────────────────────────────────────────────────

/**
 * 取り込みアイテムを DB に upsert し、分類を自動更新する。
 *
 * - markMissingItems は実行しない（未掲載商品を消失扱いにしない）
 * - 全件成功時のみ touchAccountScan で最終取り込み日時を更新
 *
 * @param {object} db
 * @param {number} accountId
 * @param {object[]} items - normalizeItem 済みアイテム配列
 * @returns {{
 *   total: number, new: number, price_changed: number,
 *   sold: number, unchanged: number, errors: object[]
 * }}
 */
export function importItemsToDB(db, accountId, items) {
  const scanDate = jstToday();
  // 手動取り込みは常に新規スキャンレコードを作成（同日の自動スキャンと混在させない）
  const scanId = startManualImportScan(db, accountId, scanDate);

  const counts = {
    status:              'completed',
    items_fetched:       items.length,
    items_new:           0,
    items_sold:          0,
    items_price_changed: 0,
    items_missing:       0,     // 手動取り込みでは常に 0
    items_reappeared:    0,
    error_message:       null,
  };

  const errors = [];
  let unchanged = 0;

  // トランザクション: 途中失敗時に既存データを変更しない
  db.exec('BEGIN');
  try {
    for (const item of items) {
      if (!item.mercari_item_id) {
        errors.push({ name: item.name, error: '商品ID が空です' });
        continue;
      }
      try {
        const result = upsertItem(db, accountId, scanId, item);
        if (result.isNew)              counts.items_new++;
        else if (result.isSold)        counts.items_sold++;
        else if (result.isPriceChange) counts.items_price_changed++;
        else if (result.isReappeared)  counts.items_reappeared++;
        else                           unchanged++;
      } catch (e) {
        errors.push({ item_id: item.mercari_item_id, error: e.message });
      }
    }

    // 分類・買付け上限を自動更新
    const settings = getSettings(db);
    batchClassify(db, accountId, settings, updateItemClassification);

    // 1件以上成功した場合のみ最終取り込み日時を更新
    if (counts.items_new + counts.items_sold + counts.items_price_changed + unchanged + counts.items_reappeared > 0) {
      touchAccountScan(db, accountId);
    }

    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    counts.status        = 'failed';
    counts.error_message = e.message;
    finishScan(db, scanId, counts);
    return {
      total: items.length, new: 0, price_changed: 0,
      sold: 0, reappeared: 0, unchanged: 0, errors: [{ error: e.message }],
    };
  }

  finishScan(db, scanId, counts);

  return {
    total:         items.length,
    new:           counts.items_new,
    price_changed: counts.items_price_changed,
    sold:          counts.items_sold,
    reappeared:    counts.items_reappeared,
    unchanged,
    errors,
  };
}

// ─── seller_id によるアカウント自動解決 ──────────────────────────────────────

/**
 * seller_id（mercari_user_id）からアカウントを解決し、商品を取り込む。
 * - 登録済みアカウント（is_active 問わず）が見つかれば使用
 * - 未登録なら seller_name / profile_url から新規アカウントを自動作成（is_active=1）
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ sellerId: string, sellerName?: string, profileUrl?: string }} seller
 * @param {object[]} items - normalizeItem 済みアイテム配列
 * @returns {{ accountId: number, accountName: string, isNewAccount: boolean } & ReturnType<importItemsToDB>}
 */
export function importItemsForSeller(db, { sellerId, sellerName, profileUrl }, items) {
  let account = getAccountByUserId(db, sellerId);
  let isNewAccount = false;

  if (!account) {
    const name = sellerName?.trim() || `出品者 ${sellerId}`;
    const url  = profileUrl || `https://jp.mercari.com/user/profile/${sellerId}`;
    const { id } = insertAccount(db, {
      mercari_user_id: sellerId,
      display_name:    name,
      profile_url:     url,
    });
    account = getAccount(db, id);
    isNewAccount = true;
  }

  const result = importItemsToDB(db, account.id, items);
  return {
    accountId:    account.id,
    accountName:  account.display_name,
    isNewAccount,
    ...result,
  };
}

// ─── CSV テンプレート生成 ──────────────────────────────────────────────────────

/**
 * CSV テンプレート文字列を返す（列説明付き）。
 * @returns {string}
 */
export function csvTemplate() {
  return [
    '商品ID,商品名,価格,状態,ブランド,カテゴリ,サイズ,色',
    '# 状態: on_sale（出品中）/ sold（売却済み）/ 出品中 / 売却済み',
    '# 商品IDはメルカリのURLに含まれる「m」から始まる番号（例: m12345678901）',
    'm12345678901,サンプル商品,1000,on_sale,ブランド名,カテゴリ名,M,ホワイト',
  ].join('\r\n');
}
