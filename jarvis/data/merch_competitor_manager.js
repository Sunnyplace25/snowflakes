/**
 * jarvis/data/merch_competitor_manager.js
 * 競合アカウント分析 — DB CRUD 操作
 *
 * 依存: node:sqlite (db.js 経由)
 * 外部通信: なし
 */

'use strict';

// ─── アカウント管理 ────────────────────────────────────────────────────────────

/**
 * 全アクティブ（is_active=1）競合アカウントを返す。
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {object[]}
 */
export function listAccounts(db) {
  return db.prepare(
    `SELECT * FROM merch_competitor_accounts WHERE is_active = 1 ORDER BY created_at`
  ).all();
}

/**
 * 全アカウントを返す（非アクティブ含む）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {object[]}
 */
export function listAllAccounts(db) {
  return db.prepare(
    `SELECT * FROM merch_competitor_accounts ORDER BY is_active DESC, created_at`
  ).all();
}

/**
 * ID でアカウントを取得。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} id
 * @returns {object|undefined}
 */
export function getAccount(db, id) {
  return db.prepare(`SELECT * FROM merch_competitor_accounts WHERE id = ?`).get(id);
}

/**
 * mercari_user_id でアカウントを取得。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} mercariUserId
 * @returns {object|undefined}
 */
export function getAccountByUserId(db, mercariUserId) {
  return db.prepare(
    `SELECT * FROM merch_competitor_accounts WHERE mercari_user_id = ?`
  ).get(mercariUserId);
}

/**
 * 新しい競合アカウントを登録する。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ mercari_user_id: string, display_name: string, profile_url: string, note?: string }} params
 * @returns {{ id: number }}
 */
export function insertAccount(db, { mercari_user_id, display_name, profile_url, note }) {
  const result = db.prepare(`
    INSERT INTO merch_competitor_accounts (mercari_user_id, display_name, profile_url, note)
    VALUES (?, ?, ?, ?)
  `).run(mercari_user_id, display_name, profile_url, note ?? null);
  return { id: Number(result.lastInsertRowid) };
}

/**
 * アカウント情報を更新する。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} id
 * @param {{ display_name?: string, note?: string, is_active?: number }} fields
 */
export function updateAccount(db, id, fields) {
  const sets = [];
  const vals = [];
  if (fields.display_name !== undefined) { sets.push('display_name = ?'); vals.push(fields.display_name); }
  if (fields.note        !== undefined) { sets.push('note = ?');         vals.push(fields.note); }
  if (fields.is_active   !== undefined) { sets.push('is_active = ?');    vals.push(fields.is_active); }
  if (sets.length === 0) return;
  sets.push("updated_at = datetime('now','localtime')");
  vals.push(id);
  db.prepare(`UPDATE merch_competitor_accounts SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

/**
 * スキャン後にアカウントの last_scanned_at を更新する。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} id
 */
export function touchAccountScan(db, id) {
  db.prepare(`
    UPDATE merch_competitor_accounts
       SET last_scanned_at = datetime('now','localtime'),
           first_scanned_at = COALESCE(first_scanned_at, datetime('now','localtime')),
           updated_at = datetime('now','localtime')
     WHERE id = ?
  `).run(id);
}

// ─── スキャン管理 ──────────────────────────────────────────────────────────────

/**
 * スキャン開始レコードを作成して scan_id を返す。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} accountId
 * @param {string} scanDate - YYYY-MM-DD
 * @returns {number} scan_id
 */
export function startScan(db, accountId, scanDate) {
  // 既存スキャンがあれば再利用（running → running 状態で上書きしない）
  const existing = db.prepare(
    `SELECT id FROM merch_competitor_scans WHERE account_id = ? AND scan_date = ?`
  ).get(accountId, scanDate);
  if (existing) return existing.id;

  const result = db.prepare(`
    INSERT INTO merch_competitor_scans (account_id, scan_date, status)
    VALUES (?, ?, 'running')
  `).run(accountId, scanDate);
  return Number(result.lastInsertRowid);
}

/**
 * スキャンを完了状態に更新する。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} scanId
 * @param {{ status: string, items_fetched: number, items_new: number, items_sold: number,
 *           items_price_changed: number, items_missing: number, items_reappeared: number,
 *           error_message?: string }} counts
 */
export function finishScan(db, scanId, counts) {
  db.prepare(`
    UPDATE merch_competitor_scans
       SET status = ?, finished_at = datetime('now','localtime'),
           items_fetched = ?, items_new = ?, items_sold = ?,
           items_price_changed = ?, items_missing = ?, items_reappeared = ?,
           error_message = ?
     WHERE id = ?
  `).run(
    counts.status,
    counts.items_fetched     ?? 0,
    counts.items_new         ?? 0,
    counts.items_sold        ?? 0,
    counts.items_price_changed ?? 0,
    counts.items_missing     ?? 0,
    counts.items_reappeared  ?? 0,
    counts.error_message     ?? null,
    scanId
  );
}

/**
 * 手動取り込み用: 既存スキャンを再利用せず、常に新規スキャンレコードを作成する。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} accountId
 * @param {string} scanDate - YYYY-MM-DD
 * @returns {number} scan_id
 */
export function startManualImportScan(db, accountId, scanDate) {
  // 同日に複数回手動取り込みできるよう、UNIQUE衝突時は時刻サフィックスを付与
  const tryInsert = (date) => db.prepare(`
    INSERT INTO merch_competitor_scans (account_id, scan_date, status, started_at)
    VALUES (?, ?, 'running', datetime('now','localtime'))
  `).run(accountId, date);

  try {
    return Number(tryInsert(scanDate).lastInsertRowid);
  } catch (e) {
    if (e.errcode === 2067) {
      // UNIQUE(account_id, scan_date) 衝突 → 時刻を付加して再試行
      const now = new Date();
      const suffix = now.toTimeString().slice(0, 8).replace(/:/g, '');
      return Number(tryInsert(`${scanDate}#${suffix}`).lastInsertRowid);
    }
    throw e;
  }
}

/**
 * プロフィール URL から mercari_user_id を抽出する。
 * @param {string} profileUrl
 * @returns {string}
 * @throws {Error} URL が不正な場合
 */
export function extractUserIdFromProfileUrl(profileUrl) {
  const parts = String(profileUrl || '').replace(/\/$/, '').split('/');
  const pIdx = parts.indexOf('profile');
  const userId = pIdx >= 0 && parts[pIdx + 1] ? parts[pIdx + 1] : '';
  if (!userId || !/^\d+$/.test(userId)) {
    throw new Error(`不正なプロフィール URL: ${profileUrl}`);
  }
  return userId;
}

/**
 * 最新スキャンを返す。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} accountId
 * @param {number} [limit=30]
 * @returns {object[]}
 */
export function getRecentScans(db, accountId, limit = 30) {
  return db.prepare(`
    SELECT * FROM merch_competitor_scans
     WHERE account_id = ?
     ORDER BY scan_date DESC
     LIMIT ?
  `).all(accountId, limit);
}

/**
 * セラーのフルスキャンを実行し、DB に反映する。
 *
 * スキャン完了判定:
 *   fetchFn が返す scanComplete=true（APIレスポンスで has_next=false 確認済み）の場合のみ
 *   markMissingItems を実行する。
 *   scanComplete=false（incomplete）の場合は取得済み商品の upsert のみ行い、
 *   markMissingItems はスキップする。
 *
 * リトライ:
 *   maxRetries 回試みて全て incomplete の場合は scanLog に 'incomplete' を記録し
 *   エラーをスローする。upsert は最後の取得結果で実行済み。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} accountId
 * @param {() => Promise<{ items: object[], scanComplete: boolean, incompleteReason: string|null }>} fetchFn
 *   スクレイパー呼び出し関数。テスト時はモック関数を渡せる。
 * @param {{
 *   maxRetries?:  number,   - 最大試行回数（デフォルト 3）
 *   retryDelay?:  number,   - 再試行間隔 ms（デフォルト 10000）
 *   baseline?:    boolean,  - ベースライン補正モード（sold_at を設定しない）
 *   scanDate?:    string,   - スキャン日付 YYYY-MM-DD（省略時は今日。テスト用）
 * }} [opts]
 * @returns {Promise<{
 *   scanId:    number,
 *   itemCount: number,
 *   counts:    { new: number, sold: number, priceChange: number, missing: number, reappeared: number },
 * }>}
 * @throws {Error} maxRetries 回全て incomplete の場合
 */
export async function runSellerScan(db, accountId, fetchFn, {
  maxRetries  = 3,
  retryDelay  = 10000,
  baseline    = false,
  scanDate    = new Date().toISOString().slice(0, 10),
} = {}) {
  let completeFetch = null;   // 最初に scanComplete=true だった結果
  let lastFetch     = null;   // 最後の試行結果（incomplete 時の upsert 用）
  let lastReason    = '不明';

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    console.log(`[runSellerScan] 試行 ${attempt}/${maxRetries}`);
    const r = await fetchFn();
    lastFetch = r;

    if (r.scanComplete) {
      completeFetch = r;
      break;
    }

    lastReason = r.incompleteReason ?? '不明';
    console.warn(`[runSellerScan] incomplete (試行${attempt}): ${lastReason}`);

    if (attempt < maxRetries) {
      console.log(`[runSellerScan] ${retryDelay}ms 後に再試行...`);
      await new Promise(resolve => setTimeout(resolve, retryDelay));
    }
  }

  const scanId     = startScan(db, accountId, scanDate);
  const isComplete = completeFetch !== null;
  const { items }  = (completeFetch ?? lastFetch);

  // upsert（完了・incomplete 問わず実行）
  let cntNew = 0, cntSold = 0, cntPriceChange = 0, cntReappeared = 0;
  for (const item of items) {
    const r = upsertItem(db, accountId, scanId, item, { baseline });
    if (r.isNew)         cntNew++;
    if (r.isSold)        cntSold++;
    if (r.isPriceChange) cntPriceChange++;
    if (r.isReappeared)  cntReappeared++;
  }

  let missingCount = 0;

  if (isComplete) {
    // 正常完了時のみ markMissingItems を実行
    const seenIds = new Set(items.map(i => i.mercari_item_id));
    missingCount  = markMissingItems(db, accountId, scanId, seenIds);

    finishScan(db, scanId, {
      status:              'completed',
      items_fetched:       items.length,
      items_new:           cntNew,
      items_sold:          cntSold,
      items_price_changed: cntPriceChange,
      items_missing:       missingCount,
      items_reappeared:    cntReappeared,
    });
    touchAccountScan(db, accountId);

    return {
      scanId,
      itemCount: items.length,
      counts: {
        new: cntNew, sold: cntSold,
        priceChange: cntPriceChange, missing: missingCount, reappeared: cntReappeared,
      },
    };
  } else {
    // incomplete: markMissingItems はスキップ
    const reason = `${maxRetries}回試行後もスキャン未完了: ${lastReason}`;
    finishScan(db, scanId, {
      status:              'incomplete',
      items_fetched:       items.length,
      items_new:           cntNew,
      items_sold:          cntSold,
      items_price_changed: cntPriceChange,
      items_missing:       0,
      items_reappeared:    cntReappeared,
      error_message:       reason,
    });
    throw new Error(`Scan incomplete: ${reason}`);
  }
}

// ─── 商品管理 ──────────────────────────────────────────────────────────────────

/**
 * 商品を upsert する。
 * - 存在しなければ INSERT
 * - 存在すれば価格・ステータス・分類情報を UPDATE
 * - 価格変更時は merch_competitor_price_history に記録し、scan_event を追加
 *
 * status マッピング（API 生値 → DB 保存値）:
 *   'on_sale'  → 'on_sale'  （そのまま）
 *   'trading'  → 'trading'  （そのまま・独立ステータス）
 *   'sold_out' → 'sold'     （変換）
 *   その他     → そのまま
 *
 * sold_at 設定ルール（通常モード）:
 *   - sold_out（→ sold）を初めて確認した時点でのみ設定
 *   - trading 遷移では sold_at を設定しない
 *   - 再 upsert（既に sold_at あり）では上書きしない
 *
 * sold_at 設定ルール（ベースライン補正モード: baseline=true）:
 *   - 追跡開始前に既に sold 状態の商品を初回登録する際に使用
 *   - sold_out → sold への変換は行うが sold_at は常に NULL のまま
 *   - sold_at IS NULL AND status='sold' で追跡後の sold と区別できる
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} accountId
 * @param {number} scanId
 * @param {object} item - スクレイパーが返すアイテムオブジェクト
 * @param {{ baseline?: boolean }} [opts]
 * @returns {{ isNew: boolean, isSold: boolean, isPriceChange: boolean, isReappeared: boolean, itemId: number }}
 */
export function upsertItem(db, accountId, scanId, item, { baseline = false } = {}) {
  const existing = db.prepare(
    `SELECT * FROM merch_competitor_items WHERE account_id = ? AND mercari_item_id = ?`
  ).get(accountId, item.mercari_item_id);

  const rawData = typeof item.raw_data === 'object'
    ? JSON.stringify(item.raw_data)
    : (item.raw_data ?? null);

  // API の sold_out → DB の sold にマッピング
  const apiStatus = item.status ?? 'on_sale';
  const dbStatus  = apiStatus === 'sold_out' ? 'sold' : apiStatus;

  if (!existing) {
    // 新規 INSERT
    // sold_at: baseline モードは NULL 固定、通常モードは sold 時のみ設定
    const soldAtClause = baseline
      ? 'NULL'
      : "CASE WHEN ? = 'sold' THEN datetime('now','localtime') ELSE NULL END";

    const insertBaseParams = [
      accountId, item.mercari_item_id, item.name ?? '', item.price ?? 0, dbStatus,
      item.brand ?? null, item.category ?? null, item.color ?? null,
      item.material ?? null, item.size ?? null,
      item.condition_text ?? null, item.target_gender ?? null,
      item.season ?? null, item.image_url ?? null, rawData,
      item.created_api ?? null, item.updated_api ?? null,
      item.num_likes ?? null, item.num_comments ?? null,
      item.shipping_from_area ?? null, item.is_archived ?? 0,
      item.is_auction ?? 0,
    ];
    // 通常モードのみ sold_at CASE 式のパラメータ（dbStatus）を追加
    const insertParams = baseline ? insertBaseParams : [...insertBaseParams, dbStatus];

    const result = db.prepare(`
      INSERT INTO merch_competitor_items
        (account_id, mercari_item_id, name, price, status,
         brand, category, color, material, size,
         condition_text, target_gender, season, image_url, raw_data,
         created_api, updated_api, num_likes, num_comments,
         shipping_from_area, is_archived, is_auction,
         sold_at)
      VALUES (?, ?, ?, ?, ?,
              ?, ?, ?, ?, ?,
              ?, ?, ?, ?, ?,
              ?, ?, ?, ?,
              ?, ?, ?,
              ${soldAtClause})
    `).run(...insertParams);
    const itemId = Number(result.lastInsertRowid);
    addScanEvent(db, scanId, itemId, 'new', null, item.price ?? 0);
    return { isNew: true, isSold: false, isPriceChange: false, isReappeared: false, itemId };
  }

  const isNew = false;
  let isSold = false;
  let isPriceChange = false;
  let isReappeared = false;
  const itemId = existing.id;
  const newPrice = item.price ?? 0;

  // 価格変更検知（on_sale かつ前回価格と異なる場合のみ）
  // オークション商品は入札による価格変動を通常の値下げ・値上げイベントとして記録しない
  if (dbStatus === 'on_sale' && newPrice !== existing.price && !existing.is_auction) {
    isPriceChange = true;
    db.prepare(`
      INSERT INTO merch_competitor_price_history (item_id, price_from, price_to, scan_id)
      VALUES (?, ?, ?, ?)
    `).run(itemId, existing.price, newPrice, scanId);
    addScanEvent(db, scanId, itemId, 'price_change', existing.price, newPrice);
  }

  // 再出品検知（missing/unknown → on_sale）
  if (['missing', 'unknown'].includes(existing.status) && dbStatus === 'on_sale') {
    isReappeared = true;
    addScanEvent(db, scanId, itemId, 'reappeared', null, newPrice);
  }

  // 売却検知（sold_out → sold への変化。trading は売却扱いにしない）
  if (existing.status !== 'sold' && dbStatus === 'sold') {
    isSold = true;
    addScanEvent(db, scanId, itemId, 'sold', existing.price, null);
  }

  // UPDATE
  // sold_at: baseline モードは常に現状維持（NULL のまま）
  // 通常モードは、sold 検知時に last_seen_at と現在時刻の中間値（JST）を JS 側で計算して渡す
  let estimatedSoldAt = null;
  if (isSold && !baseline) {
    if (existing.last_seen_at) {
      const prevMs = new Date(existing.last_seen_at).getTime();
      const midMs  = Math.round((prevMs + Date.now()) / 2);
      const jstMid = new Date(midMs + 9 * 60 * 60 * 1000);
      estimatedSoldAt = jstMid.toISOString().slice(0, 19).replace('T', ' ');
    } else {
      const jstNow = new Date(Date.now() + 9 * 60 * 60 * 1000);
      estimatedSoldAt = jstNow.toISOString().slice(0, 19).replace('T', ' ');
    }
  }

  const soldAtUpdateClause = baseline
    ? 'sold_at'
    : 'CASE WHEN sold_at IS NULL AND ? IS NOT NULL THEN ? ELSE sold_at END';

  const updateBaseParams = [
    item.name ?? existing.name, newPrice, dbStatus,
    item.brand    ?? existing.brand,    item.category    ?? existing.category,
    item.color    ?? existing.color,    item.material    ?? existing.material,
    item.size     ?? existing.size,
    item.condition_text  ?? existing.condition_text,
    item.target_gender   ?? existing.target_gender,
    item.season          ?? existing.season,
    item.image_url ?? existing.image_url, rawData,
    // created_api: COALESCE で初回のみ書き込み
    item.created_api ?? null,
    // updated_api: 毎回上書き（Mercari 側更新を追跡）
    item.updated_api ?? null,
    item.num_likes    ?? null,
    item.num_comments ?? null,
    item.shipping_from_area ?? null,
    item.is_archived ?? 0,
    item.is_auction ?? existing.is_auction ?? 0,
  ];
  // baseline: sold_at clause にパラメータ不要。通常: estimatedSoldAt ×2 を sold_at CASE 式に渡す
  const updateParams = baseline
    ? [...updateBaseParams, dbStatus, itemId]
    : [...updateBaseParams, estimatedSoldAt, estimatedSoldAt, dbStatus, itemId];

  db.prepare(`
    UPDATE merch_competitor_items
       SET name = ?, price = ?, status = ?,
           brand = ?, category = ?, color = ?, material = ?, size = ?,
           condition_text = ?, target_gender = ?, season = ?,
           image_url = ?, raw_data = ?,
           created_api = COALESCE(created_api, ?),
           updated_api = ?,
           num_likes = ?,
           num_comments = ?,
           shipping_from_area = COALESCE(shipping_from_area, ?),
           is_archived = ?,
           is_auction = ?,
           last_seen_at = datetime('now','localtime'),
           sold_at = ${soldAtUpdateClause},
           status_changed_at = CASE
             WHEN ? != status THEN datetime('now','localtime')
             ELSE status_changed_at
           END,
           updated_at = datetime('now','localtime')
     WHERE id = ?
  `).run(...updateParams);

  return { isNew, isSold, isPriceChange, isReappeared, itemId };
}

/**
 * 前回スキャン時に存在した商品で、今回スキャン結果に含まれていないものを missing にする。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} accountId
 * @param {number} scanId
 * @param {Set<string>} seenIds - 今回スキャンで確認した mercari_item_id の Set
 * @returns {number} missing にしたアイテム数
 */
export function markMissingItems(db, accountId, scanId, seenIds) {
  // on_sale と trading の両方が対象（sold は missing 扱いしない）
  const onSaleItems = db.prepare(`
    SELECT id, mercari_item_id FROM merch_competitor_items
     WHERE account_id = ? AND status IN ('on_sale', 'trading')
  `).all(accountId);

  let count = 0;
  for (const row of onSaleItems) {
    if (!seenIds.has(row.mercari_item_id)) {
      db.prepare(`
        UPDATE merch_competitor_items
           SET status = 'missing',
               status_changed_at = datetime('now','localtime'),
               updated_at = datetime('now','localtime')
         WHERE id = ?
      `).run(row.id);
      addScanEvent(db, scanId, row.id, 'missing', null, null);
      count++;
    }
  }
  return count;
}

/**
 * スキャンイベントを追加する。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} scanId
 * @param {number} itemId
 * @param {string} eventType
 * @param {number|null} priceFrom
 * @param {number|null} priceTo
 */
export function addScanEvent(db, scanId, itemId, eventType, priceFrom, priceTo) {
  db.prepare(`
    INSERT INTO merch_competitor_scan_events (scan_id, item_id, event_type, price_from, price_to)
    VALUES (?, ?, ?, ?, ?)
  `).run(scanId, itemId, eventType, priceFrom ?? null, priceTo ?? null);
}

/**
 * アカウントの商品一覧を返す。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} accountId
 * @param {{ status?: string, limit?: number, offset?: number }} opts
 * @returns {object[]}
 */
export function listItems(db, accountId, { status, limit = 100, offset = 0 } = {}) {
  if (status) {
    return db.prepare(`
      SELECT * FROM merch_competitor_items
       WHERE account_id = ? AND status = ?
       ORDER BY last_seen_at DESC LIMIT ? OFFSET ?
    `).all(accountId, status, limit, offset);
  }
  return db.prepare(`
    SELECT * FROM merch_competitor_items
     WHERE account_id = ?
     ORDER BY last_seen_at DESC LIMIT ? OFFSET ?
  `).all(accountId, limit, offset);
}

/**
 * 商品の分類情報を更新する（classifier が呼ぶ）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} itemId
 * @param {object} cls - { classified_brand, classified_category, classified_color,
 *                         classified_season, classified_target, classification_confidence, buying_limit }
 */
export function updateItemClassification(db, itemId, cls) {
  db.prepare(`
    UPDATE merch_competitor_items
       SET classified_brand = ?, classified_category = ?, classified_color = ?,
           classified_season = ?, classified_target = ?,
           classification_confidence = ?, buying_limit = ?,
           updated_at = datetime('now','localtime')
     WHERE id = ?
  `).run(
    cls.classified_brand ?? null, cls.classified_category ?? null,
    cls.classified_color ?? null, cls.classified_season ?? null,
    cls.classified_target ?? null, cls.classification_confidence ?? null,
    cls.buying_limit ?? null,
    itemId
  );
}

// ─── 通知管理 ──────────────────────────────────────────────────────────────────

/**
 * 日次通知を upsert する（当日のみ 1 件）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} date - YYYY-MM-DD
 * @param {object} summary
 */
export function upsertNotification(db, date, summary) {
  db.prepare(`
    INSERT INTO merch_competitor_notifications (notify_date, summary)
    VALUES (?, ?)
    ON CONFLICT(notify_date) DO UPDATE SET summary = excluded.summary
  `).run(date, JSON.stringify(summary));
}

/**
 * 未読通知一覧を返す。
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {object[]}
 */
export function listUnreadNotifications(db) {
  return db.prepare(`
    SELECT * FROM merch_competitor_notifications WHERE is_read = 0 ORDER BY notify_date DESC
  `).all();
}

/**
 * 通知を既読にする。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} date - YYYY-MM-DD
 */
export function markNotificationRead(db, date) {
  db.prepare(`
    UPDATE merch_competitor_notifications SET is_read = 1 WHERE notify_date = ?
  `).run(date);
}

// ─── 分析設定 ──────────────────────────────────────────────────────────────────

/**
 * 全分析設定を key-value オブジェクトとして返す。
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {{ [key: string]: string }}
 */
export function getSettings(db) {
  const rows = db.prepare(`SELECT key, value FROM merch_analysis_settings`).all();
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
}

/**
 * 分析設定を更新する。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} key
 * @param {string} value
 */
export function setSetting(db, key, value) {
  db.prepare(`
    INSERT INTO merch_analysis_settings (key, value)
    VALUES (?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now','localtime')
  `).run(key, String(value));
}

// ─── 分析用クエリ ──────────────────────────────────────────────────────────────

/**
 * 指定アカウントの売れ筋ブランド集計を返す。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} accountId
 * @param {number} [limit=20]
 * @returns {object[]} - { brand, sold_count, avg_price }
 */
/**
 * 期間フィルター SQL フラグメント（sold_at に適用）。
 * days は 7 or 30 のみ想定（API 側でバリデーション済み）。
 * @param {number|null} days
 * @returns {string}
 */
function soldInPeriod(days) {
  return days ? `AND sold_at >= datetime('now', 'localtime', '-${days} days')` : '';
}

export function getBrandSoldRanking(db, accountId, limit = 20, days = null) {
  // is_auction=1 を除外。ベースライン商品（sold_at=NULL）は sold 件数カウントから除外する。
  // sold 集計は sold_at の期間フィルターを適用。on_sale_count は現時点スナップショット。
  const p = soldInPeriod(days);
  return db.prepare(`
    SELECT classified_brand AS brand,
           COUNT(CASE WHEN status = 'sold'    AND sold_at IS NOT NULL ${p} THEN 1 END) AS sold_count,
           COUNT(CASE WHEN status = 'on_sale'                               THEN 1 END) AS on_sale_count,
           CAST(AVG(CASE WHEN status = 'sold' AND sold_at IS NOT NULL ${p} THEN price END) AS INTEGER) AS avg_price,
           ROUND(
             COUNT(CASE WHEN status = 'sold' AND sold_at IS NOT NULL ${p} THEN 1 END) * 100.0
             / NULLIF(
                 COUNT(CASE WHEN status = 'sold'    AND sold_at IS NOT NULL ${p} THEN 1 END)
               + COUNT(CASE WHEN status = 'on_sale'                               THEN 1 END),
               0
             ),
             1
           ) AS sell_rate,
           CAST(AVG(
             CASE WHEN status = 'sold' AND sold_at IS NOT NULL ${p} AND created_api IS NOT NULL
             THEN julianday(sold_at) - julianday(created_api)
             END
           ) AS INTEGER) AS avg_sold_days
      FROM merch_competitor_items
     WHERE account_id = ? AND is_auction = 0 AND classified_brand IS NOT NULL
     GROUP BY classified_brand
    HAVING sold_count > 0
     ORDER BY sold_count DESC
     LIMIT ?
  `).all(accountId, limit);
}

/**
 * カテゴリ別統計を返す。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} accountId
 * @returns {object[]} - { category, on_sale_count, sold_count, avg_sold_price }
 */
export function getCategoryStats(db, accountId, days = null) {
  // is_auction=1 を除外。sold 件数は sold_at IS NOT NULL でベースライン除外する。
  // sold 集計は sold_at の期間フィルターを適用。on_sale_count は現時点スナップショット。
  const p = soldInPeriod(days);
  return db.prepare(`
    SELECT classified_category AS category,
           COUNT(CASE WHEN status = 'on_sale'                               THEN 1 END) AS on_sale_count,
           COUNT(CASE WHEN status = 'sold'    AND sold_at IS NOT NULL ${p} THEN 1 END) AS sold_count,
           CAST(AVG(CASE WHEN status = 'sold' AND sold_at IS NOT NULL ${p} THEN price END) AS INTEGER) AS avg_sold_price,
           ROUND(
             COUNT(CASE WHEN status = 'sold' AND sold_at IS NOT NULL ${p} THEN 1 END) * 100.0
             / NULLIF(
                 COUNT(CASE WHEN status = 'sold'    AND sold_at IS NOT NULL ${p} THEN 1 END)
               + COUNT(CASE WHEN status = 'on_sale'                               THEN 1 END),
               0
             ),
             1
           ) AS sell_rate,
           CAST(AVG(
             CASE WHEN status = 'sold' AND sold_at IS NOT NULL ${p} AND created_api IS NOT NULL
             THEN julianday(sold_at) - julianday(created_api)
             END
           ) AS INTEGER) AS avg_sold_days
      FROM merch_competitor_items
     WHERE account_id = ? AND is_auction = 0 AND classified_category IS NOT NULL
     GROUP BY classified_category
     ORDER BY sold_count DESC
  `).all(accountId);
}

/**
 * 仕入れ候補（buying_limit > 0 かつ on_sale）を返す。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} accountId
 * @param {number} [limit=50]
 * @returns {object[]}
 */
export function getBuyingCandidates(db, accountId, limit = 50) {
  return db.prepare(`
    SELECT i.*
      FROM merch_competitor_items i
     WHERE i.account_id = ? AND i.status = 'on_sale' AND i.buying_limit > 0
       AND i.price <= i.buying_limit
     ORDER BY (i.buying_limit - i.price) DESC
     LIMIT ?
  `).all(accountId, limit);
}

/**
 * 今日のスキャンイベントサマリーを返す。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} scanDate - YYYY-MM-DD
 * @returns {{ new: number, sold: number, price_change: number, missing: number, reappeared: number }}
 */
export function getDailyScanSummary(db, scanDate) {
  const rows = db.prepare(`
    SELECT e.event_type, COUNT(*) AS cnt
      FROM merch_competitor_scan_events e
      JOIN merch_competitor_scans s ON e.scan_id = s.id
     WHERE s.scan_date = ?
     GROUP BY e.event_type
  `).all(scanDate);
  const summary = { new: 0, sold: 0, price_change: 0, missing: 0, reappeared: 0 };
  for (const r of rows) summary[r.event_type] = r.cnt;
  return summary;
}

/**
 * レポートを保存する。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ report_type: string, period_start: string, period_end: string,
 *           account_id?: number|null, body: object }} params
 */
export function saveReport(db, { report_type, period_start, period_end, account_id, body }) {
  db.prepare(`
    INSERT INTO merch_competitor_reports (report_type, period_start, period_end, account_id, body)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(report_type, period_start, account_id) DO UPDATE SET body = excluded.body
  `).run(report_type, period_start, period_end, account_id ?? null, JSON.stringify(body));
}

/**
 * アカウント別の売却所要日数統計を返す（ブランド×カテゴリ集計）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} accountId
 * @returns {object[]}
 */
export function getSoldDaysStats(db, accountId) {
  // ベースラインインポート商品（sold_at = NULL）は売却日不明のため除外する。is_auction=1 も除外。
  return db.prepare(`
    SELECT classified_brand, classified_category,
           COUNT(*) AS sold_count,
           CAST(AVG(julianday(sold_at) - julianday(created_api)) AS INTEGER) AS avg_days,
           MIN(CAST(julianday(sold_at) - julianday(created_api) AS INTEGER)) AS min_days,
           MAX(CAST(julianday(sold_at) - julianday(created_api) AS INTEGER)) AS max_days
      FROM merch_competitor_items
     WHERE account_id = ? AND status = 'sold' AND is_auction = 0
       AND sold_at IS NOT NULL AND created_api IS NOT NULL
     GROUP BY classified_brand, classified_category
     ORDER BY sold_count DESC
  `).all(accountId);
}

/**
 * 出品中で掲載日数が長い商品を返す（滞留在庫）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} accountId
 * @param {number} [limit=50]
 * @returns {object[]}
 */
export function getUnsoldItemsWithAge(db, accountId, limit = 50) {
  // is_auction=1 を除外する。
  return db.prepare(`
    SELECT id, mercari_item_id, name, price, classified_brand, classified_category,
           created_api, first_seen_at, last_seen_at,
           CAST(julianday(datetime('now','localtime'))
                - julianday(COALESCE(created_api, first_seen_at)) AS INTEGER) AS days_listed
      FROM merch_competitor_items
     WHERE account_id = ? AND status = 'on_sale' AND is_auction = 0
     ORDER BY days_listed DESC
     LIMIT ?
  `).all(accountId, limit);
}

/**
 * 価格帯別の売却件数・売却率を返す。
 * is_auction=1 とベースライン商品（sold_at=NULL）を除外する。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} accountId
 * @returns {object[]} - { price_range, sold_count, on_sale_count, sell_rate }
 */
export function getPriceRangeStats(db, accountId, days = null) {
  // sold 集計は sold_at の期間フィルターを適用。on_sale_count は現時点スナップショット。
  const p = soldInPeriod(days);
  return db.prepare(`
    SELECT
      CASE
        WHEN price <  1000  THEN '〜999円'
        WHEN price <  3000  THEN '1,000〜2,999円'
        WHEN price <  5000  THEN '3,000〜4,999円'
        WHEN price < 10000  THEN '5,000〜9,999円'
        ELSE                     '10,000円〜'
      END AS price_range,
      MIN(price) AS price_range_min,
      COUNT(CASE WHEN status = 'sold'    AND sold_at IS NOT NULL ${p} THEN 1 END) AS sold_count,
      COUNT(CASE WHEN status = 'on_sale'                               THEN 1 END) AS on_sale_count,
      ROUND(
        COUNT(CASE WHEN status = 'sold' AND sold_at IS NOT NULL ${p} THEN 1 END) * 100.0
        / NULLIF(
            COUNT(CASE WHEN status = 'sold'    AND sold_at IS NOT NULL ${p} THEN 1 END)
          + COUNT(CASE WHEN status = 'on_sale'                               THEN 1 END),
          0
        ),
        1
      ) AS sell_rate
      FROM merch_competitor_items
     WHERE account_id = ? AND is_auction = 0
     GROUP BY price_range
     ORDER BY price_range_min
  `).all(accountId);
}

/**
 * 全体サマリー（販売中件数・売却済件数・売却率・平均売却日数）を返す。
 * is_auction=1 とベースライン商品（sold_at=NULL）を除外する。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} accountId
 * @param {number|null} [days] - 期間フィルター（7 / 30 / null=全期間）
 * @returns {{ on_sale_count, sold_count, avg_sold_price, overall_sell_rate, overall_avg_days }}
 */
export function getSummaryStats(db, accountId, days = null) {
  // sold 集計・avg_sold_price は sold_at の期間フィルターを適用。
  // on_sale_count は現時点スナップショット。
  // avg_sold_price には売却時点の price（items.price）を使用する。sold 後は再スキャンされないため凍結済み。
  const p = soldInPeriod(days);
  return db.prepare(`
    SELECT
      COUNT(CASE WHEN status = 'on_sale'                               THEN 1 END) AS on_sale_count,
      COUNT(CASE WHEN status = 'sold'    AND sold_at IS NOT NULL ${p} THEN 1 END) AS sold_count,
      CAST(AVG(CASE WHEN status = 'sold' AND sold_at IS NOT NULL ${p} THEN price END) AS INTEGER) AS avg_sold_price,
      ROUND(
        COUNT(CASE WHEN status = 'sold' AND sold_at IS NOT NULL ${p} THEN 1 END) * 100.0
        / NULLIF(
            COUNT(CASE WHEN status = 'sold'    AND sold_at IS NOT NULL ${p} THEN 1 END)
          + COUNT(CASE WHEN status = 'on_sale'                               THEN 1 END),
          0
        ),
        1
      ) AS overall_sell_rate,
      CAST(AVG(
        CASE WHEN status = 'sold' AND sold_at IS NOT NULL ${p} AND created_api IS NOT NULL
        THEN julianday(sold_at) - julianday(created_api)
        END
      ) AS INTEGER) AS overall_avg_days
      FROM merch_competitor_items
     WHERE account_id = ? AND is_auction = 0
  `).get(accountId);
}

/**
 * 最近売却された商品一覧を返す。
 * is_auction=1 とベースライン商品（sold_at=NULL）を除外する。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} accountId
 * @param {number} [limit=20]
 * @returns {object[]} - { name, classified_brand, classified_category, price, sold_days, sold_at }
 */
export function getSoldItemsList(db, accountId, limit = 20, days = null) {
  // price は sold 後に再スキャンされないため売却時点の価格として扱える。
  const p = soldInPeriod(days);
  return db.prepare(`
    SELECT name, classified_brand, classified_category, price,
           CAST(julianday(sold_at) - julianday(created_api) AS INTEGER) AS sold_days,
           sold_at
      FROM merch_competitor_items
     WHERE account_id = ? AND is_auction = 0 AND status = 'sold' AND sold_at IS NOT NULL ${p}
     ORDER BY sold_at DESC
     LIMIT ?
  `).all(accountId, limit);
}

/**
 * オークション商品数をステータス別に返す。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} accountId
 * @returns {{ on_sale: number, sold: number, total: number }}
 */
export function getAuctionCount(db, accountId) {
  const rows = db.prepare(`
    SELECT status, COUNT(*) AS cnt
      FROM merch_competitor_items
     WHERE account_id = ? AND is_auction = 1
     GROUP BY status
  `).all(accountId);
  const result = { on_sale: 0, sold: 0, total: 0 };
  for (const r of rows) {
    if (r.status === 'on_sale') result.on_sale = r.cnt;
    if (r.status === 'sold')    result.sold    = r.cnt;
    result.total += r.cnt;
  }
  return result;
}

/**
 * レポート一覧を返す。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ report_type?: string, limit?: number }} opts
 * @returns {object[]}
 */
export function listReports(db, { report_type, limit = 20 } = {}) {
  if (report_type) {
    return db.prepare(`
      SELECT * FROM merch_competitor_reports WHERE report_type = ?
       ORDER BY period_start DESC LIMIT ?
    `).all(report_type, limit);
  }
  return db.prepare(`
    SELECT * FROM merch_competitor_reports ORDER BY period_start DESC LIMIT ?
  `).all(limit);
}
