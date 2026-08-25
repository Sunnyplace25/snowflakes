/**
 * jarvis/data/merch_import.js
 * アパレル / eBay Excel 一括インポート
 *
 * ・アパレル : 「商品リスト」シート
 * ・eBay     : 年別「YYYY 商品リスト」「YYYY eBay 商品リスト」等のシートを全件
 * ・row_hash による重複防止（同じ行を再インポートしても二重登録しない）
 */
'use strict';

import * as XLSX from 'xlsx';
import { createHash } from 'node:crypto';

// ─── 日付・数値ユーティリティ ─────────────────────────────────────────────────

function isoDate(val) {
  if (val === null || val === undefined || val === '') return null;
  if (val instanceof Date) {
    if (isNaN(val.getTime())) return null;
    const y = val.getFullYear();
    const m = String(val.getMonth() + 1).padStart(2, '0');
    const d = String(val.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  }
  if (typeof val === 'number') {
    // Excel シリアル値 → JS Date（1900年うるう年バグ込み）
    if (val < 1 || val > 2958465) return null; // 範囲外ガード
    const ms = Math.round((val - 25569) * 86400 * 1000);
    return isoDate(new Date(ms));
  }
  if (typeof val === 'string') {
    const s = val.trim();
    const m1 = s.match(/^(\d{4})[\/\-年](\d{1,2})[\/\-月](\d{1,2})/);
    if (m1) return `${m1[1]}-${m1[2].padStart(2,'0')}-${m1[3].padStart(2,'0')}`;
  }
  return null;
}

function numInt(val) {
  if (val === null || val === undefined || val === '') return 0;
  if (typeof val === 'number') return Math.round(val);
  const s = String(val).replace(/[,，¥¥\s%％]/g, '');
  const n = parseFloat(s);
  return isNaN(n) ? 0 : Math.round(n);
}

function numFloat(val) {
  if (val === null || val === undefined || val === '') return null;
  if (typeof val === 'number') {
    // Excel が % 形式で保存した場合 0.xx として入る
    return val;
  }
  const s = String(val).replace(/[,，¥¥\s%％]/g, '');
  const n = parseFloat(s);
  if (isNaN(n)) return null;
  // "45" のようにパーセント記号なしで大きい値の場合は /100
  return String(val).includes('%') && n > 1 ? n / 100 : n;
}

function str(val) {
  if (val === null || val === undefined) return null;
  const s = String(val).trim();
  return s === '' ? null : s;
}

function isEmptyRow(row) {
  return !row || row.every(c => c === null || c === undefined || c === '');
}

function rowHash(...parts) {
  return createHash('sha256')
    .update(parts.map(p => String(p ?? '')).join('\x00'))
    .digest('hex')
    .slice(0, 40);
}

// ─── ファイル種別判定 ─────────────────────────────────────────────────────────

export function detectSourceType(wb, filename) {
  const fname = (filename || '').toLowerCase();
  const sheets = wb.SheetNames;

  if (fname.includes('ebay')) return 'ebay';
  if (sheets.some(s => s.toLowerCase().includes('ebay'))) return 'ebay';
  if (sheets.includes('商品リスト')) return 'apparel';

  // ヘッダー内容からアパレル判定
  for (const sn of sheets.slice(0, 3)) {
    const ws = wb.Sheets[sn];
    if (!ws) continue;
    const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
    const htext = rows.slice(0, 8).flat().join(' ');
    if (/ブランド|粗利率|仕入先|販売手数料/.test(htext)) return 'apparel';
    if (/仕入日|売却日|仕入値/.test(htext)) return 'ebay'; // eBay も同様ヘッダーを持つが eBay シートが多い
  }

  return 'unknown';
}

// ─── ヘッダー検出・列マッピング ─────────────────────────────────────────────────

function findHeaderRow(rows, keywords) {
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const text = rows[i].map(c => String(c ?? '')).join(' ');
    const hits = keywords.filter(k => text.includes(k)).length;
    if (hits >= Math.ceil(keywords.length * 0.5)) return i;
  }
  return -1;
}

function buildColMap(headerRow, aliasMap) {
  const map = {};
  headerRow.forEach((h, idx) => {
    const key = String(h ?? '').trim();
    if (aliasMap[key] && !(aliasMap[key] in map)) {
      map[aliasMap[key]] = idx;
    }
  });
  return map;
}

// ─── アパレル解析 ────────────────────────────────────────────────────────────

const APPAREL_COLS = {
  '仕入日': 'purchase_date',
  'カテゴリ': 'category',
  'ブランド': 'brand',
  '品名': 'product_name',
  '販売先URL': 'sales_url',
  'URL': 'sales_url',
  '仕入先': 'supplier',
  '仕入値': 'purchase_price',
  '出品日': 'listing_date',
  '売却日': 'sale_date',
  '回転日数': 'turnover_days',
  '販路': 'channel',
  '売上': 'sale_price',
  '販売手数料': 'commission',
  '手数料': 'commission',
  '送料': 'shipping_cost',
  '入金額': 'net_income',
  '粗利': 'profit',
  '粗利率': 'profit_rate',
  '帳簿': 'ledger',
};

function parseApparelSheet(sheet, sheetName = '商品リスト') {
  const rows = XLSX.utils.sheet_to_json(sheet, {
    header: 1, defval: null, raw: true, cellDates: true,
  });

  const headerIdx = findHeaderRow(rows, ['品名', '仕入日', '仕入値']);
  if (headerIdx < 0) return [];

  const colMap = buildColMap(rows[headerIdx], APPAREL_COLS);
  if (colMap['product_name'] === undefined) return [];

  const items = [];
  let emptyStreak = 0;

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (isEmptyRow(row)) {
      if (++emptyStreak >= 5) break;
      continue;
    }
    emptyStreak = 0;

    const productName = str(row[colMap['product_name']]);
    if (!productName) continue;

    const purchaseDate  = isoDate(row[colMap['purchase_date']]);
    const purchasePrice = numInt(row[colMap['purchase_price']]);
    const brand         = str(row[colMap['brand']]);
    const saleDate      = isoDate(row[colMap['sale_date']]);

    items.push({
      source_type:    'apparel',
      sheet_name:     sheetName,
      product_name:   productName,
      purchase_date:  purchaseDate,
      purchase_price: purchasePrice,
      category:       str(row[colMap['category']]),
      brand,
      sales_url:      str(row[colMap['sales_url']]),
      supplier:       str(row[colMap['supplier']]),
      listing_date:   isoDate(row[colMap['listing_date']]),
      sale_date:      saleDate,
      turnover_days:  row[colMap['turnover_days']] != null ? (parseInt(row[colMap['turnover_days']]) || null) : null,
      channel:        str(row[colMap['channel']]),
      sale_price:     numInt(row[colMap['sale_price']]),
      commission:     numInt(row[colMap['commission']]),
      shipping_cost:  numInt(row[colMap['shipping_cost']]),
      net_income:     numInt(row[colMap['net_income']]),
      profit:         numInt(row[colMap['profit']]),
      profit_rate:    numFloat(row[colMap['profit_rate']]),
      ledger:         str(row[colMap['ledger']]),
      status:         saleDate ? '販売済み' : '在庫',
      // 行番号(i)をhashに含めることで同日・同商品・同価格の複数仕入れを区別
      row_hash:       rowHash('apparel', sheetName, String(i), purchaseDate, brand, productName, purchasePrice),
    });
  }
  return items;
}

// ─── eBay 解析 ───────────────────────────────────────────────────────────────

const EBAY_COLS = {
  '品名': 'product_name', '商品名': 'product_name', '品　名': 'product_name',
  '仕入日': 'purchase_date', '購入日': 'purchase_date',
  '仕入値': 'purchase_price', '仕入金額': 'purchase_price', '購入金額': 'purchase_price',
  '売却日': 'sale_date', '販売日': 'sale_date', '落札日': 'sale_date',
  '売上': 'sale_price', '販売額': 'sale_price', '落札金額': 'sale_price', '売却価格': 'sale_price',
  '販売手数料': 'commission', '手数料': 'commission',
  '送料': 'shipping_cost',
  '入金額': 'net_income',
  '粗利': 'profit', '利益': 'profit',
};

function isEbayDataSheet(sheetName) {
  const s = sheetName.toLowerCase();
  // 明らかに集計・設定系は除外
  if (/集計|グラフ|設定|summary|合計|chart/i.test(s)) return false;
  // それ以外はすべてデータシート候補として渡す（parseEbaySheet が 0件なら自動スキップ）
  return true;
}

function parseEbaySheet(sheet, sheetName) {
  const rows = XLSX.utils.sheet_to_json(sheet, {
    header: 1, defval: null, raw: true, cellDates: true,
  });

  // ヘッダー行検出
  let headerIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 15); i++) {
    const text = rows[i].map(c => String(c ?? '')).join(' ');
    if (/品名|商品名/.test(text) || (text.includes('仕入日') && /売上|粗利/.test(text))) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0) return [];

  const headerRow = rows[headerIdx];
  const colMap = buildColMap(headerRow, EBAY_COLS);

  // 品名列が見つからない場合：データ値から推定
  // ヘッダーが空欄や全角スペースでも、実データが長い文字列の列を品名とみなす
  if (colMap['product_name'] === undefined) {
    const mappedCols = new Set(Object.values(colMap));
    const sampleRows = rows.slice(headerIdx + 1, headerIdx + 11).filter(r => !isEmptyRow(r));
    let bestCol = -1;
    let bestScore = 0;
    for (let ci = 0; ci < headerRow.length; ci++) {
      if (mappedCols.has(ci)) continue;
      let score = 0;
      for (const r of sampleRows) {
        const v = r[ci];
        if (v != null && typeof v === 'string') {
          const t = v.trim();
          // 3文字以上の文字列で、純粋な数字でなければ品名候補
          if (t.length >= 3 && !/^\d[\d,，.]*$/.test(t)) score++;
        }
      }
      if (score > bestScore) { bestScore = score; bestCol = ci; }
    }
    if (bestCol >= 0 && bestScore >= 2) colMap['product_name'] = bestCol;
  }
  if (colMap['product_name'] === undefined) return [];

  const items = [];
  let emptyStreak = 0;

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (isEmptyRow(row)) {
      if (++emptyStreak >= 5) break;
      continue;
    }
    emptyStreak = 0;

    const productName = str(row[colMap['product_name']]);
    if (!productName) continue;

    const purchaseDate  = colMap['purchase_date']  !== undefined ? isoDate(row[colMap['purchase_date']])  : null;
    const purchasePrice = colMap['purchase_price'] !== undefined ? numInt(row[colMap['purchase_price']])  : 0;
    const saleDate      = colMap['sale_date']      !== undefined ? isoDate(row[colMap['sale_date']])      : null;
    const salePrice     = colMap['sale_price']     !== undefined ? numInt(row[colMap['sale_price']])      : 0;
    const profit        = colMap['profit']         !== undefined ? numInt(row[colMap['profit']])          : 0;
    const commission    = colMap['commission']     !== undefined ? numInt(row[colMap['commission']])      : 0;
    const shippingCost  = colMap['shipping_cost']  !== undefined ? numInt(row[colMap['shipping_cost']])  : 0;
    const netIncome     = colMap['net_income']     !== undefined ? numInt(row[colMap['net_income']])     : 0;

    items.push({
      source_type:    'ebay',
      sheet_name:     sheetName,
      product_name:   productName,
      purchase_date:  purchaseDate,
      purchase_price: purchasePrice,
      sale_date:      saleDate,
      sale_price:     salePrice,
      commission,
      shipping_cost:  shippingCost,
      net_income:     netIncome,
      profit,
      status:         saleDate ? '販売済み' : '在庫',
      // 行番号(i)をhashに含めることで同日・同商品・同価格の複数仕入れを区別
      row_hash:       rowHash('ebay', sheetName, String(i), purchaseDate, productName, purchasePrice),
    });
  }
  return items;
}

// ─── DB テーブル初期化 ────────────────────────────────────────────────────────

export function ensureMerchTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS merch_imports (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      filename     TEXT NOT NULL,
      source_type  TEXT NOT NULL,
      sheets       TEXT,
      total_rows   INTEGER DEFAULT 0,
      created_rows INTEGER DEFAULT 0,
      skipped_rows INTEGER DEFAULT 0,
      created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );

    CREATE TABLE IF NOT EXISTS merch_items (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      source_type    TEXT NOT NULL,
      import_id      INTEGER REFERENCES merch_imports(id),
      sheet_name     TEXT,
      product_name   TEXT,
      purchase_date  TEXT,
      purchase_price INTEGER DEFAULT 0,
      sale_date      TEXT,
      sale_price     INTEGER DEFAULT 0,
      profit         INTEGER DEFAULT 0,
      status         TEXT NOT NULL DEFAULT '在庫',
      -- アパレル専用
      category       TEXT,
      brand          TEXT,
      sales_url      TEXT,
      supplier       TEXT,
      listing_date   TEXT,
      turnover_days  INTEGER,
      channel        TEXT,
      commission     INTEGER DEFAULT 0,
      shipping_cost  INTEGER DEFAULT 0,
      net_income     INTEGER DEFAULT 0,
      profit_rate    REAL,
      ledger         TEXT,
      -- 共通
      row_hash       TEXT NOT NULL,
      created_at     TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      UNIQUE(row_hash)
    );
    CREATE INDEX IF NOT EXISTS idx_merch_items_type   ON merch_items(source_type);
    CREATE INDEX IF NOT EXISTS idx_merch_items_status ON merch_items(status);
    CREATE INDEX IF NOT EXISTS idx_merch_items_pdate  ON merch_items(purchase_date);
    CREATE INDEX IF NOT EXISTS idx_merch_items_sdate  ON merch_items(sale_date);
  `);
}

// ─── プレビュー ───────────────────────────────────────────────────────────────

export function previewMerchImport(db, buffer, filename) {
  ensureMerchTables(db);

  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true, raw: true });
  const sourceType = detectSourceType(wb, filename);

  if (sourceType === 'unknown') {
    throw new Error('アパレルまたはeBayのExcelとして認識できませんでした。シート名・列名を確認してください。');
  }

  let allItems = [];
  let parsedSheets = [];

  if (sourceType === 'apparel') {
    // 「商品リスト」を含むシートを全部処理（旧Excelの「2024 商品リスト」「★2025 商品リスト」等に対応）
    // 集計・設定シートは除外
    const apparelSheets = wb.SheetNames.filter(s => {
      if (/集計|グラフ|設定|summary|chart/i.test(s)) return false;
      if (s.includes('商品リスト')) return true;
      return false;
    });
    // 「商品リスト」系シートが1つもなければ先頭シートを試す
    const targets = apparelSheets.length > 0 ? apparelSheets : [wb.SheetNames[0]];
    for (const targetSheet of targets) {
      const items = parseApparelSheet(wb.Sheets[targetSheet], targetSheet);
      allItems.push(...items);
      if (items.length > 0) parsedSheets.push(targetSheet);
    }
  } else {
    for (const sheetName of wb.SheetNames) {
      if (!isEbayDataSheet(sheetName)) continue;
      const items = parseEbaySheet(wb.Sheets[sheetName], sheetName);
      allItems.push(...items);
      if (items.length > 0) parsedSheets.push(sheetName);
    }
  }

  if (allItems.length === 0) {
    throw new Error('データ行が見つかりませんでした。シート構成・ヘッダー行を確認してください。');
  }

  // 重複チェック（既存 row_hash との照合）
  const hashes = allItems.map(i => i.row_hash);
  let existingHashes = new Set();
  if (hashes.length > 0) {
    const placeholders = hashes.map(() => '?').join(',');
    existingHashes = new Set(
      db.prepare(`SELECT row_hash FROM merch_items WHERE row_hash IN (${placeholders})`)
        .all(...hashes)
        .map(r => r.row_hash)
    );
  }

  const newItems = allItems.filter(i => !existingHashes.has(i.row_hash));
  const dupCount = allItems.length - newItems.length;

  return {
    source_type:  sourceType,
    filename,
    sheets:       parsedSheets,
    total:        allItems.length,
    new_count:    newItems.length,
    dup_count:    dupCount,
    items:        newItems,
    preview_rows: newItems.slice(0, 50),
  };
}

// ─── 登録確定 ─────────────────────────────────────────────────────────────────

export function confirmMerchImport(db, items, meta) {
  ensureMerchTables(db);
  if (!items || items.length === 0) return { ok: true, created: 0, skipped: 0 };

  const importRec = db.prepare(`
    INSERT INTO merch_imports (filename, source_type, sheets, total_rows, created_rows, skipped_rows)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(meta.filename, meta.source_type, JSON.stringify(meta.sheets), meta.total, 0, meta.dup_count ?? 0);

  const importId = importRec.lastInsertRowid;

  const insert = db.prepare(`
    INSERT OR IGNORE INTO merch_items (
      source_type, import_id, sheet_name,
      product_name, purchase_date, purchase_price,
      sale_date, sale_price, profit, status,
      category, brand, sales_url, supplier,
      listing_date, turnover_days, channel,
      commission, shipping_cost, net_income,
      profit_rate, ledger, row_hash
    ) VALUES (
      ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?,
      ?, ?, ?
    )
  `);

  // node:sqlite は db.transaction() を持たないため BEGIN/COMMIT/ROLLBACK で制御
  db.exec('BEGIN');
  let created = 0;
  try {
    for (const r of items) {
      const res = insert.run(
        r.source_type,    importId,           r.sheet_name    ?? null,
        r.product_name,   r.purchase_date  ?? null, r.purchase_price ?? 0,
        r.sale_date    ?? null, r.sale_price ?? 0,   r.profit         ?? 0, r.status,
        r.category     ?? null, r.brand          ?? null, r.sales_url   ?? null, r.supplier   ?? null,
        r.listing_date ?? null, r.turnover_days  ?? null, r.channel     ?? null,
        r.commission   ?? 0,    r.shipping_cost  ?? 0,    r.net_income  ?? 0,
        r.profit_rate  ?? null, r.ledger         ?? null, r.row_hash
      );
      if (res.changes > 0) created++;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  db.prepare('UPDATE merch_imports SET created_rows = ? WHERE id = ?').run(created, importId);

  return { ok: true, import_id: Number(importId), created, skipped: items.length - created };
}
