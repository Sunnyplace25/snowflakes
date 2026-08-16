/**
 * jarvis/importers/invoice_importer.js
 * 請求書 Excel (.xlsx) パーサー
 *
 * 制約:
 *   - 個人情報（住所・電話・メール・口座）は一切抽出・保存しない
 *   - description は元の作業内容を絶対に書き換えない
 *   - 固定セル決め打ちなし。ヘッダー行を動的に検出する
 *   - 外部APIコールなし・ファイルシステム書き込みなし（純粋な変換関数）
 */

import XLSX from 'xlsx';
import { createHash } from 'node:crypto';

// ─── カテゴリ自動分類ルール ────────────────────────────────────────────────────
// 順序が重要（先にマッチしたルールが優先）
const CATEGORY_RULES = [
  { patterns: ['meijicup', 'meiji cup', '明治カップ', 'meiji'],   category: 'ゴルフ中継' },
  { patterns: ['競馬'],                                             category: '競馬中継' },
  { patterns: ['ファイターズ', 'エスコン'],                         category: 'スポーツ中継' },
  { patterns: ['マラソン'],                                         category: 'スポーツ中継' },
  { patterns: ['レバンガ', 'きたえーる'],                           category: 'スポーツ中継' },
  { patterns: ['sasaru', 'ロケ'],                                   category: 'ロケ' },
  { patterns: ['みんテレ', 'スタジオ', 'uhb', 'tvh', 'テレビ'],   category: 'スタジオ音声' },
];

/**
 * 仕事内容からカテゴリを自動判定する。
 * ルールを追加する場合は CATEGORY_RULES を編集する。
 * @param {string} description
 * @returns {string}
 */
export function classifyWork(description) {
  const lower = description.toLowerCase();
  for (const rule of CATEGORY_RULES) {
    for (const p of rule.patterns) {
      if (lower.includes(p.toLowerCase())) return rule.category;
    }
  }
  return 'その他';
}

// ─── 全角→半角変換 ────────────────────────────────────────────────────────────
function toHalfWidth(str) {
  return String(str).replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0));
}

// ─── Excel シリアル日付 → YYYY-MM-DD ─────────────────────────────────────────
function excelSerialToDate(serial) {
  if (typeof serial !== 'number' || serial <= 0) return null;
  // Excel serial: 1900-01-01 = 1 (with leap year bug: pretends 1900-02-29 exists)
  const utcDays = serial - 25569; // days from Unix epoch (1970-01-01)
  const d = new Date(Math.round(utcDays) * 86400000);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const dy = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${dy}`;
}

// ─── 請求書番号を正規化 ───────────────────────────────────────────────────────
function normalizeInvoiceNumber(raw) {
  if (!raw) return null;
  return String(raw)
    .replace(/^No\.[:：]?\s*/i, '')  // "No.："などのプレフィックス削除
    .replace(/[‐‑–—]/g, '-')         // 各種ダッシュをハイフンに統一
    .replace(/[　\s]+/g, '')          // 空白除去
    .trim();
}

// ─── スキップ判定 ─────────────────────────────────────────────────────────────
const SKIP_SHEET_PATTERNS = ['見積', '発注', '納品', '領収', 'マスター', 'シート1', 'シート'];

function shouldSkipSheet(sheetName) {
  return SKIP_SHEET_PATTERNS.some(p => sheetName.includes(p));
}

function getDocumentType(data) {
  // R1 の最初の非空文字列セルをドキュメントタイプとして使う
  for (let i = 0; i < Math.min(data.length, 3); i++) {
    for (const cell of data[i]) {
      const s = String(cell).replace(/[　\s]/g, '');
      if (s.length > 0) return s;
    }
  }
  return '';
}

// ─── ヘッダー行の検出 ─────────────────────────────────────────────────────────
function detectHeaderRow(data) {
  for (let i = 0; i < Math.min(data.length, 25); i++) {
    const row = data[i];
    // "No." を含む列を探す
    const noIdx = row.findIndex(c => /^No\.\s*$/.test(String(c).trim()));
    if (noIdx < 0) continue;
    // "商品名" か "品名" か "作業内容" が同じ行に存在すること
    const hasDesc = row.some(c => /商品|品名|作業内容/.test(String(c)));
    if (!hasDesc) continue;
    return { rowIdx: i, row, noIdx };
  }
  return null;
}

// ─── 列位置マップを作成 ───────────────────────────────────────────────────────
function buildColMap(headerRow, noIdx) {
  const isNewFormat = headerRow.some(c => /作業内容/.test(String(c)));
  const isOldFormat = headerRow.some(c => /商品|品名/.test(String(c)));

  // 数量列: noIdx以降で "数" を含む最初の列
  const qtyIdx = headerRow.findIndex((c, i) => i > noIdx && /数/.test(String(c)));
  // 単価列: qtyIdx以降で "単" を含む最初の列
  const priceIdx = headerRow.findIndex((c, i) => i > Math.max(noIdx, qtyIdx) && /単/.test(String(c)));
  // 金額列: priceIdx以降で "金" を含む最初の列
  const amountIdx = headerRow.findIndex((c, i) => i > Math.max(noIdx, priceIdx) && /金/.test(String(c)));

  return {
    noIdx,
    // 新形式: 日付=no+1, 説明=no+2 / 旧形式: 説明=no+1（日付は説明文内）
    dateIdx:    isNewFormat ? noIdx + 1 : -1,
    descIdx:    isNewFormat ? noIdx + 2 : noIdx + 1,
    qtyIdx:     qtyIdx  >= 0 ? qtyIdx  : noIdx + 7,
    unitIdx:    qtyIdx  >= 0 ? qtyIdx + 1 : noIdx + 8,
    priceIdx:   priceIdx >= 0 ? priceIdx : noIdx + 9,
    amountIdx:  amountIdx >= 0 ? amountIdx : noIdx + 11,
    isNewFormat,
    isOldFormat,
  };
}

// ─── 請求書ヘッダー情報の抽出 ─────────────────────────────────────────────────
function extractInvoiceHeader(data, sourceFilename, sheetName) {
  let invoiceNumber = null;
  let invoiceDate   = null;
  let clientName    = '株式会社オーテック'; // デフォルト（個人情報は保存しない）
  let totalWithTax  = 0;

  for (let i = 0; i < Math.min(data.length, 15); i++) {
    const row = data[i];
    for (let j = 0; j < row.length; j++) {
      const val = String(row[j] ?? '').trim();
      if (!val) continue;

      // 請求番号パターン A: "No.：" + 次セル
      if (/^No\.[:：]\s*$/.test(val) && j + 1 < row.length) {
        const next = String(row[j + 1] ?? '').trim();
        if (next) invoiceNumber = normalizeInvoiceNumber(next);
      }
      // 請求番号パターン B: "No.2025-07" のようにひとつのセルに入っている
      else if (/^No\.[\d\-‐‑–—]/.test(val)) {
        invoiceNumber = normalizeInvoiceNumber(val);
      }
      // 請求番号パターン C: "No." + 値が直後に
      else if (/^No\.$/.test(val) && j + 1 < row.length) {
        const next = String(row[j + 1] ?? '').trim();
        if (/[\d]/.test(next)) invoiceNumber = normalizeInvoiceNumber(next);
      }

      // 請求日
      if (/^請求日[:：]?\s*$/.test(val) && j + 1 < row.length && typeof row[j + 1] === 'number') {
        invoiceDate = excelSerialToDate(row[j + 1]);
      }

      // 請求金額 (税込合計)
      if (/請求金額/.test(val) || /^請求金額$/.test(val.replace(/[　\s]/g, ''))) {
        for (let k = j + 1; k < row.length; k++) {
          if (typeof row[k] === 'number' && row[k] > 0) {
            totalWithTax = row[k];
            break;
          }
        }
      }
    }
  }

  // 取引先名: R5 (index 4) の最初の非空・非住所・非個人情報セル
  // 個人情報に該当するセル（電話・メール・住所・個人名）は保存しない
  // クライアント名のみ取得（法人名パターン）
  if (data[4]) {
    for (const cell of data[4]) {
      const s = String(cell ?? '').trim();
      if (!s) continue;
      if (/御\s*中/.test(s)) continue;        // "御中"は宛先なのでスキップ
      if (/^〒/.test(s)) continue;            // 郵便番号付き住所スキップ
      if (/^☎/.test(s) || /@/.test(s)) continue;  // 電話・メールスキップ
      if (s.length < 3) continue;
      // 法人名パターン（株式会社、有限会社など）または会社名らしい文字列
      if (/会社|放送|テレビ|プロ|制作|スタジオ/.test(s)) {
        clientName = s;
        break;
      }
    }
  }

  // フォールバック: シート名・ファイル名から取引先を推定
  if (clientName === '株式会社オーテック' && /オーテック/i.test(sourceFilename)) {
    clientName = '株式会社オーテック';
  }

  return { invoiceNumber, invoiceDate, clientName, totalWithTax };
}

// ─── 日付文字列の解析（"8/5", "7/31", "８/５" など）───────────────────────────
function parseDateStr(rawDate, invoiceYear, invoiceMonth) {
  if (!rawDate) return null;
  const s = toHalfWidth(String(rawDate)).trim();
  const match = s.match(/(\d{1,2})[\/\/](\d{1,2})/);
  if (!match) return null;
  const m = parseInt(match[1], 10);
  const d = parseInt(match[2], 10);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;

  let year = invoiceYear;
  // 月跨ぎ: 仕事月 > 請求月 → 前年の仕事（例: 1月請求に12月の仕事）
  if (m > invoiceMonth) year = invoiceYear - 1;

  return `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// ─── 旧形式: 説明文から日付を抽出 ────────────────────────────────────────────
function extractDateFromDescription(desc, invoiceYear, invoiceMonth) {
  const s = toHalfWidth(String(desc));
  // "7/31" "8/25" "8/2、8/3"（複数日の最初） "8/2､8/3"
  const match = s.match(/(\d{1,2})[\/\/](\d{1,2})/);
  if (!match) return null;
  const m = parseInt(match[1], 10);
  const d = parseInt(match[2], 10);
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  let year = invoiceYear;
  if (m > invoiceMonth) year = invoiceYear - 1;
  return `${year}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// ─── セル値を数値として取得 ───────────────────────────────────────────────────
function toNumber(val) {
  if (typeof val === 'number') return val;
  if (typeof val === 'string') {
    const n = parseFloat(toHalfWidth(val).replace(/[,，、]/g, '').trim());
    return isNaN(n) ? 0 : n;
  }
  return 0;
}

// ─── シートから明細を解析 ─────────────────────────────────────────────────────
function parseSheet(ws, sheetName, sourceFilename) {
  const result = {
    skip:     false,
    skipReason: null,
    invoice:  null,
    lines:    [],
    warnings: [],
  };

  if (!ws['!ref']) {
    result.skip = true;
    result.skipReason = '空シート';
    return result;
  }

  if (shouldSkipSheet(sheetName)) {
    result.skip = true;
    result.skipReason = `シート名スキップ (${sheetName})`;
    return result;
  }

  const data = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: true });
  if (!data.length) {
    result.skip = true;
    result.skipReason = 'データなし';
    return result;
  }

  // ドキュメントタイプ確認（請求書以外はスキップ）
  const docType = getDocumentType(data);
  if (docType && !/請求/.test(docType)) {
    result.skip = true;
    result.skipReason = `非請求書 (${docType.substring(0, 10)})`;
    return result;
  }

  // ヘッダー行検出
  const header = detectHeaderRow(data);
  if (!header) {
    result.skip = true;
    result.skipReason = 'ヘッダー行が見つからない';
    return result;
  }

  const colMap = buildColMap(header.row, header.noIdx);

  // 請求書ヘッダー情報を抽出
  const { invoiceNumber, invoiceDate, clientName, totalWithTax } =
    extractInvoiceHeader(data, sourceFilename, sheetName);

  // 請求日から年月を取得
  let invoiceYear  = null;
  let invoiceMonth = null;
  if (invoiceDate) {
    const [y, m] = invoiceDate.split('-').map(Number);
    invoiceYear  = y;
    invoiceMonth = m;
  } else {
    // フォールバック: シート名から年月を推定（例: "202507 請求書" → 2025年7月）
    const sMatch = sheetName.replace(/[　\s]/g, '').match(/^(\d{4})(\d{2})/);
    if (sMatch) {
      invoiceYear  = parseInt(sMatch[1], 10);
      invoiceMonth = parseInt(sMatch[2], 10);
    }
    if (!invoiceYear) {
      result.skip = true;
      result.skipReason = '請求日が不明';
      return result;
    }
    result.warnings.push(`請求日をシート名から推定: ${invoiceYear}年${invoiceMonth}月`);
  }

  // 明細行を解析（ヘッダー行の次から）
  let subtotal = 0;
  const validLines = [];

  for (let i = header.rowIdx + 1; i < data.length; i++) {
    const row = data[i];
    if (!row || row.length === 0) continue;

    // No. 列の値を確認
    const noVal = row[colMap.noIdx];
    if (!noVal && noVal !== 0) continue;
    const noNum = toNumber(noVal);
    if (noNum <= 0) continue;

    // 金額
    const amount = Math.round(toNumber(row[colMap.amountIdx]));
    if (amount <= 0) continue; // 0円行はスキップ

    // 説明
    let desc = '';
    if (colMap.isNewFormat) {
      // 新形式: descIdx のセル
      desc = String(row[colMap.descIdx] ?? '').trim();
    } else {
      // 旧形式: descIdx のセル（日付が埋め込まれている）
      desc = String(row[colMap.descIdx] ?? '').trim();
    }
    if (!desc || /^\s*$/.test(desc)) continue; // 空説明スキップ

    // 数量
    const qty     = toNumber(row[colMap.qtyIdx]) || 1;
    const qtyUnit = String(row[colMap.unitIdx] ?? '').trim() || '日';
    const price   = Math.round(toNumber(row[colMap.priceIdx]));

    // 仕事日の決定
    let workDate = null;
    if (colMap.isNewFormat && colMap.dateIdx >= 0) {
      // 新形式: 日付列から取得
      const rawDate = row[colMap.dateIdx];
      if (rawDate) {
        workDate = parseDateStr(rawDate, invoiceYear, invoiceMonth);
        if (!workDate) {
          result.warnings.push(`R${i + 1}: 日付解析失敗 "${rawDate}"`);
        }
      }
    } else {
      // 旧形式: 説明文から日付を抽出
      workDate = extractDateFromDescription(desc, invoiceYear, invoiceMonth);
    }

    // カテゴリ自動分類（元のdescriptionは絶対変更しない）
    const category = classifyWork(desc);

    validLines.push({
      workDate,
      description:  desc,
      quantity:     qty,
      quantityUnit: qtyUnit,
      unitPrice:    price,
      amount,
      category,
      jobId:        null,
      sourceRow:    i + 1, // 1始まりの行番号
    });

    subtotal += amount;
  }

  // 有効明細がなければスキップ（空テンプレート）
  if (validLines.length === 0) {
    result.skip = true;
    result.skipReason = `有効明細なし (${sheetName})`;
    return result;
  }

  // 消費税計算
  const tax = totalWithTax > 0 ? totalWithTax - subtotal : Math.round(subtotal * 0.1);

  result.invoice = {
    clientName,
    invoiceNumber: invoiceNumber || `${sheetName.replace(/[　\s]/g, '')}-AUTO`,
    invoiceDate,
    subtotal,
    tax,
    total: totalWithTax > 0 ? totalWithTax : subtotal + tax,
    sourceSheet: sheetName,
    sourceFilename,
  };
  result.lines = validLines;

  return result;
}

// ─── Excel バイナリを解析してプレビューデータを返す ──────────────────────────
/**
 * @param {Buffer|Uint8Array} buffer - .xlsx バイナリ
 * @param {string} filename - ファイル名（表示・ログ用）
 * @returns {{ invoices: Array, summary: Object }}
 */
export function parseExcel(buffer, filename) {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false, raw: true });

  const invoices  = [];
  const skipped   = [];
  const allWarn   = [];

  for (const sheetName of wb.SheetNames) {
    const ws = wb.Sheets[sheetName];
    const parsed = parseSheet(ws, sheetName, filename);

    if (parsed.skip) {
      skipped.push({ sheetName, reason: parsed.skipReason });
      continue;
    }

    allWarn.push(...parsed.warnings.map(w => `[${sheetName}] ${w}`));
    invoices.push({ ...parsed.invoice, lines: parsed.lines });
  }

  const totalLines    = invoices.reduce((s, inv) => s + inv.lines.length, 0);
  const totalSubtotal = invoices.reduce((s, inv) => s + inv.subtotal, 0);

  return {
    invoices,
    skipped,
    warnings: allWarn,
    summary: {
      sheetCount:    wb.SheetNames.length,
      invoiceCount:  invoices.length,
      skippedCount:  skipped.length,
      lineCount:     totalLines,
      totalSubtotal,
    },
  };
}

// ─── ファイル hash 計算 ───────────────────────────────────────────────────────
export function computeFileHash(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

// ─── 分類ルール一覧を返す（フロントエンド表示用）────────────────────────────
export function getCategoryRules() {
  return CATEGORY_RULES.map(r => ({ patterns: [...r.patterns], category: r.category }));
}
