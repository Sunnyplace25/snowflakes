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

// ─── 商品管理 ──────────────────────────────────────────────────────────────────

/**
 * 商品を upsert する。
 * - 存在しなければ INSERT
 * - 存在すれば価格・ステータス・分類情報を UPDATE
 * - 価格変更時は merch_competitor_price_history に記録し、scan_event を追加
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} accountId
 * @param {number} scanId
 * @param {object} item - スクレイパーが返すアイテムオブジェクト
 * @returns {{ isNew: boolean, isSold: boolean, isPriceChange: boolean, isReappeared: boolean }}
 */
export function upsertItem(db, accountId, scanId, item) {
  const existing = db.prepare(
    `SELECT * FROM merch_competitor_items WHERE account_id = ? AND mercari_item_id = ?`
  ).get(accountId, item.mercari_item_id);

  const rawData = typeof item.raw_data === 'object'
    ? JSON.stringify(item.raw_data)
    : (item.raw_data ?? null);

  if (!existing) {
    // 新規
    const result = db.prepare(`
      INSERT INTO merch_competitor_items
        (account_id, mercari_item_id, name, price, status,
         brand, category, color, material, size,
         condition_text, target_gender, season, image_url, raw_data)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      accountId, item.mercari_item_id, item.name, item.price, item.status ?? 'on_sale',
      item.brand ?? null, item.category ?? null, item.color ?? null,
      item.material ?? null, item.size ?? null,
      item.condition_text ?? null, item.target_gender ?? null,
      item.season ?? null, item.image_url ?? null, rawData
    );
    const itemId = Number(result.lastInsertRowid);
    addScanEvent(db, scanId, itemId, 'new', null, item.price);
    return { isNew: true, isSold: false, isPriceChange: false, isReappeared: false, itemId };
  }

  const isNew = false;
  let isSold = false;
  let isPriceChange = false;
  let isReappeared = false;
  const itemId = existing.id;

  const newStatus = item.status ?? 'on_sale';
  const newPrice  = item.price;

  // 価格変更検知
  if (newStatus === 'on_sale' && newPrice !== existing.price) {
    isPriceChange = true;
    db.prepare(`
      INSERT INTO merch_competitor_price_history (item_id, price_from, price_to, scan_id)
      VALUES (?, ?, ?, ?)
    `).run(itemId, existing.price, newPrice, scanId);
    addScanEvent(db, scanId, itemId, 'price_change', existing.price, newPrice);
  }

  // 再出品検知（missing/unknown → on_sale）
  if (['missing', 'unknown'].includes(existing.status) && newStatus === 'on_sale') {
    isReappeared = true;
    addScanEvent(db, scanId, itemId, 'reappeared', null, newPrice);
  }

  // 売却検知
  if (existing.status !== 'sold' && newStatus === 'sold') {
    isSold = true;
    addScanEvent(db, scanId, itemId, 'sold', existing.price, null);
  }

  // UPDATE
  db.prepare(`
    UPDATE merch_competitor_items
       SET name = ?, price = ?, status = ?,
           brand = ?, category = ?, color = ?, material = ?, size = ?,
           condition_text = ?, target_gender = ?, season = ?,
           image_url = ?, raw_data = ?,
           last_seen_at = datetime('now','localtime'),
           sold_at = CASE WHEN ? = 'sold' AND sold_at IS NULL THEN datetime('now','localtime') ELSE sold_at END,
           status_changed_at = CASE WHEN ? != status THEN datetime('now','localtime') ELSE status_changed_at END,
           updated_at = datetime('now','localtime')
     WHERE id = ?
  `).run(
    item.name, newPrice, newStatus,
    item.brand ?? existing.brand, item.category ?? existing.category,
    item.color ?? existing.color, item.material ?? existing.material,
    item.size ?? existing.size,
    item.condition_text ?? existing.condition_text,
    item.target_gender ?? existing.target_gender,
    item.season ?? existing.season,
    item.image_url ?? existing.image_url, rawData,
    newStatus, newStatus,
    itemId
  );

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
  const onSaleItems = db.prepare(`
    SELECT id, mercari_item_id FROM merch_competitor_items
     WHERE account_id = ? AND status = 'on_sale'
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
export function getBrandSoldRanking(db, accountId, limit = 20) {
  return db.prepare(`
    SELECT classified_brand AS brand,
           COUNT(*) AS sold_count,
           CAST(AVG(price) AS INTEGER) AS avg_price
      FROM merch_competitor_items
     WHERE account_id = ? AND status = 'sold' AND classified_brand IS NOT NULL
     GROUP BY classified_brand
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
export function getCategoryStats(db, accountId) {
  return db.prepare(`
    SELECT classified_category AS category,
           SUM(CASE WHEN status = 'on_sale' THEN 1 ELSE 0 END) AS on_sale_count,
           SUM(CASE WHEN status = 'sold'    THEN 1 ELSE 0 END) AS sold_count,
           CAST(AVG(CASE WHEN status = 'sold' THEN price END) AS INTEGER) AS avg_sold_price
      FROM merch_competitor_items
     WHERE account_id = ? AND classified_category IS NOT NULL
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
