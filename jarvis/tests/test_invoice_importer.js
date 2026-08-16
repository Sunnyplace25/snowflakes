/**
 * jarvis/tests/test_invoice_importer.js
 * 請求書 Excel 取込テスト
 *
 * 実行: node tests/test_invoice_importer.js
 * 実ファイルが存在しない場合はダミーデータでテストする
 */

import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { createDb } from '../data/db.js';
import {
  parseExcel,
  computeFileHash,
  classifyWork,
} from '../importers/invoice_importer.js';
import {
  importInvoices,
  getImportHistory,
  getInvoiceAnalytics,
  getAnalyticsByYear,
  getInvoiceLines,
  getAvailableYears,
} from '../data/invoice_manager.js';
import XLSX from 'xlsx';

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ❌ ${name}: ${e.message}`);
    failed++;
  }
}

// ─── ダミー Excel 生成ユーティリティ ─────────────────────────────────────────
function makeInvoiceSheet(opts = {}) {
  const {
    title        = '請求書',
    invoiceNum   = 'TEST-001',
    invoiceDate  = 46100,   // 2026-03-01 相当
    clientRow    = '株式会社テスト',
    totalAmount  = 110000,
    headerLabel  = '商品名 ／ 品名',  // 旧形式
    lines        = [
      [1, 'テスト仕事　4/1', '', '', '', '', '', 1, '日', 50000, '', 50000],
      [2, 'テスト仕事　4/2', '', '', '', '', '', 1, '日', 50000, '', 50000],
    ],
  } = opts;

  const rows = [
    [title, '', '', '', '', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '', '', 'No.：', invoiceNum],
    ['', '', '', '', '', '', '', '', '', '', '請求日：', invoiceDate],
    ['', '', '', '', '', '', '', '', '', '', '', ''],
    [clientRow, '', '', '', '', '', '', '御 中', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '', '', '', ''],
    ['請求金額', '', '', totalAmount, '', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '', '', '', ''],
    ['No.', headerLabel, '', '', '', '', '', '数　量', '', '単　価', '', '金　額'],
    ...lines,
  ];

  const ws = XLSX.utils.aoa_to_sheet(rows);
  return ws;
}

function makeWorkbook(sheets) {
  const wb = XLSX.utils.book_new();
  for (const { name, ws } of sheets) {
    XLSX.utils.book_append_sheet(wb, ws, name);
  }
  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
}

// ─── カテゴリ分類テスト ────────────────────────────────────────────────────────
console.log('\n📋 カテゴリ自動分類');
test('みんテレ → スタジオ音声',   () => assert.equal(classifyWork('みんテレ スタジオ 音声業務'), 'スタジオ音声'));
test('UHBスタジオ → スタジオ音声', () => assert.equal(classifyWork('UHBスタジオ 音声業務 (15:00-19:30)'), 'スタジオ音声'));
test('ファイターズ → スポーツ中継', () => assert.equal(classifyWork('ファイターズ 練習中継 音声業務'), 'スポーツ中継'));
test('エスコン → スポーツ中継',    () => assert.equal(classifyWork('エスコン ファイターズ 練習中継'), 'スポーツ中継'));
test('meiji cup → ゴルフ中継',     () => assert.equal(classifyWork('meiji cup ゴルフ　音声業務'), 'ゴルフ中継'));
test('meijicup → ゴルフ中継',      () => assert.equal(classifyWork('meijicup 音声技術費　7/31'), 'ゴルフ中継'));
test('競馬 → 競馬中継',            () => assert.equal(classifyWork('uhb競馬中継 音声業務'), '競馬中継'));
test('マラソン → スポーツ中継',    () => assert.equal(classifyWork('北海道マラソン スタジオ音声業務'), 'スポーツ中継'));
test('SASARU → ロケ',              () => assert.equal(classifyWork('UHB SASARU ロケ'), 'ロケ'));
test('ロケ → ロケ',                () => assert.equal(classifyWork('病を知る ロケ 音声業務'), 'ロケ'));
test('不明 → その他',              () => assert.equal(classifyWork('特殊作業'), 'その他'));

// ─── 旧形式 Excel 解析テスト ──────────────────────────────────────────────────
console.log('\n📊 旧形式 Excel 解析（商品名 ／ 品名）');
test('旧形式: 基本解析', () => {
  const buf = makeWorkbook([{
    name: '202408 請求書',
    ws: makeInvoiceSheet({
      invoiceNum: '202408-001',
      invoiceDate: 45530,  // 2024-08-29
      totalAmount: 110000,
      lines: [
        [1, 'meijicup 音声技術費　7/31', '', '', '', '', '', 1, '日', 50000, '', 50000],
        [2, '北海道マラソン 音声技術費　8/25', '', '', '', '', '', 1, '日', 50000, '', 50000],
      ],
    }),
  }]);

  const result = parseExcel(buf, 'test.xlsx');
  assert.equal(result.invoices.length, 1);
  const inv = result.invoices[0];
  assert.equal(inv.invoiceNumber, '202408-001');
  assert.equal(inv.lines.length, 2);
  assert.equal(inv.subtotal, 100000);

  // 日付確認
  assert.equal(inv.lines[0].workDate, '2024-07-31');  // 7/31 → 前月
  assert.equal(inv.lines[1].workDate, '2024-08-25');  // 8/25 → 当月

  // カテゴリ確認
  assert.equal(inv.lines[0].category, 'ゴルフ中継');
  assert.equal(inv.lines[1].category, 'スポーツ中継');

  // description は元のまま
  assert.equal(inv.lines[0].description, 'meijicup 音声技術費　7/31');
});

test('旧形式: 0円行スキップ', () => {
  const buf = makeWorkbook([{
    name: '202408 請求書',
    ws: makeInvoiceSheet({
      invoiceNum: '202408-002',
      invoiceDate: 45530,
      totalAmount: 55000,
      lines: [
        [1, '仕事A　8/1', '', '', '', '', '', 1, '日', 50000, '', 50000],
        [2, ' ', '', '', '', '', '', '', ' ', '', '', 0],   // 空行 (0円)
        [3, ' ', '', '', '', '', '', '', ' ', '', '', 0],   // 空行 (0円)
      ],
    }),
  }]);

  const result = parseExcel(buf, 'test.xlsx');
  assert.equal(result.invoices[0].lines.length, 1, '0円行はスキップされるべき');
});

// ─── 新形式 Excel 解析テスト ──────────────────────────────────────────────────
console.log('\n📊 新形式 Excel 解析（作業内容 + 日付別セル）');
test('新形式: 基本解析', () => {
  const rows = [
    ['請　求　書', '', '', '', '', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '', '', '', 'No.2025‐07'],
    ['', '', '', '', '', '', '', '', '', '', '請求日:', 45870],
    ['', '', '', '', '', '', '', '', '', '', '', ''],
    ['株式会社　オーテック', '', '', '', '', '', '', '御 中', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '', '', '', ''],
    ['請求金額', '', '', 110000, '', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '', '', '', ''],
    ['No.', '作業内容', '', '', '', '', '', '数　量', '', '単　価', '', '金　額'],
    [1, '7/5', 'ファイターズ 練習中継 音声業務', '', '', '', '', 1, '日', 50000, '', 50000],
    [2, '7/10', 'uhbスタジオ 音声業務 (15:00-19:30)', '', '', '', '', 4.5, '時間', 14500, '', 14500],
  ];

  const ws = XLSX.utils.aoa_to_sheet(rows);
  const buf = makeWorkbook([{ name: '202507 請求書', ws }]);
  const result = parseExcel(buf, 'test2025.xlsx');

  assert.equal(result.invoices.length, 1);
  const inv = result.invoices[0];
  assert.equal(inv.lines.length, 2);
  assert.equal(inv.lines[0].workDate, '2025-07-05');
  assert.equal(inv.lines[1].workDate, '2025-07-10');
  assert.equal(inv.lines[0].description, 'ファイターズ 練習中継 音声業務');
  assert.equal(inv.lines[0].category, 'スポーツ中継');
  assert.equal(inv.lines[1].category, 'スタジオ音声');
});

// ─── スキップシートテスト ─────────────────────────────────────────────────────
console.log('\n🚫 スキップシート判定');
test('見積書シートはスキップ', () => {
  const ws = makeInvoiceSheet({ title: '見　積　書' });
  const buf = makeWorkbook([{ name: '見積書', ws }]);
  const result = parseExcel(buf, 'test.xlsx');
  assert.equal(result.invoices.length, 0);
  assert.ok(result.skipped.some(s => s.sheetName === '見積書'));
});

test('領収書シートはスキップ', () => {
  const ws = makeInvoiceSheet({ title: '領　収　書' });
  const buf = makeWorkbook([{ name: '領収書', ws }]);
  const result = parseExcel(buf, 'test.xlsx');
  assert.equal(result.invoices.length, 0);
});

test('請求書マスターはスキップ', () => {
  const ws = makeInvoiceSheet({
    totalAmount: 0,
    lines: [],  // 有効明細なし
  });
  const buf = makeWorkbook([{ name: '★請求書マスター', ws }]);
  const result = parseExcel(buf, 'test.xlsx');
  assert.equal(result.invoices.length, 0);
});

test('空シートはスキップ', () => {
  const wb = XLSX.utils.book_new();
  const ws = {};  // 空
  XLSX.utils.book_append_sheet(wb, ws, 'シート1');
  const buf = Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }));
  const result = parseExcel(buf, 'test.xlsx');
  assert.equal(result.invoices.length, 0);
});

test('全明細0円の空テンプレートはスキップ', () => {
  const ws = makeInvoiceSheet({
    totalAmount: 0,
    lines: [
      [1, '', '', '', '', '', '', '', '', '', '', 0],
      [2, '', '', '', '', '', '', '', '', '', '', 0],
    ],
  });
  const buf = makeWorkbook([{ name: '202512 請求書', ws }]);
  const result = parseExcel(buf, 'test.xlsx');
  assert.equal(result.invoices.length, 0, '全0円は空テンプレートとしてスキップ');
});

// ─── 複数シートテスト ─────────────────────────────────────────────────────────
console.log('\n📑 複数シート処理');
test('有効シート + スキップシートの混在', () => {
  const validWs = makeInvoiceSheet({
    invoiceNum: 'MULTI-001',
    invoiceDate: 45530,
    totalAmount: 55000,
    lines: [[1, '仕事A　8/1', '', '', '', '', '', 1, '日', 50000, '', 50000]],
  });
  const skipWs = makeInvoiceSheet({ title: '見　積　書' });

  const buf = makeWorkbook([
    { name: '202408 請求書', ws: validWs },
    { name: '見積書', ws: skipWs },
  ]);

  const result = parseExcel(buf, 'test.xlsx');
  assert.equal(result.invoices.length, 1, '有効シートは1件');
  assert.equal(result.skipped.length, 1, 'スキップシートは1件');
  assert.equal(result.summary.lineCount, 1);
});

// ─── 月跨ぎ日付テスト ─────────────────────────────────────────────────────────
console.log('\n📅 月跨ぎ日付');
test('8月請求書に7/31の仕事 → 2024-07-31', () => {
  const ws = makeInvoiceSheet({
    invoiceNum: 'DATE-001',
    invoiceDate: 45530,  // 2024-08-29
    totalAmount: 55000,
    lines: [
      [1, 'meijicup 音声技術費　7/31', '', '', '', '', '', 1, '日', 50000, '', 50000],
    ],
  });
  const buf = makeWorkbook([{ name: '202408 請求書', ws }]);
  const result = parseExcel(buf, 'test.xlsx');
  assert.equal(result.invoices[0].lines[0].workDate, '2024-07-31');
});

test('1月請求書に12月の仕事 → 前年12月', () => {
  // 2026年1月請求で12月の仕事 → 2025-12-xx
  const rows = [
    ['請　求　書', '', '', '', '', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '', '', '', 'No.2026-1'],
    ['', '', '', '', '', '', '', '', '', '', '請求日:', 46057],  // 2026-01-07 相当
    ['', '', '', '', '', '', '', '', '', '', '', ''],
    ['株式会社　オーテック', '', '', '', '', '', '', '御 中', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '', '', '', ''],
    ['請求金額', '', '', 55000, '', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '', '', '', ''],
    ['No.', '作業内容', '', '', '', '', '', '数　量', '', '単　価', '', '金　額'],
    [1, '12/28', '年末仕事', '', '', '', '', 1, '日', 50000, '', 50000],
  ];
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const buf = makeWorkbook([{ name: '202601 請求書', ws }]);
  const result = parseExcel(buf, 'test_jan.xlsx');
  const line = result.invoices[0]?.lines[0];
  assert.ok(line, '明細が存在すること');
  // 1月請求書に12月の仕事 → work_month(12) > invoice_month(1) → 前年
  assert.equal(line.workDate?.substring(0, 7), '2025-12', `前年12月であること (got: ${line.workDate})`);
});

// ─── 重複防止テスト ────────────────────────────────────────────────────────────
console.log('\n🔄 重複防止');
test('同じファイルを2回インポートしても重複しない', () => {
  const db = createDb(':memory:');

  const ws = makeInvoiceSheet({
    invoiceNum: 'DUP-001',
    invoiceDate: 45530,
    totalAmount: 55000,
    lines: [[1, '仕事A　8/1', '', '', '', '', '', 1, '日', 50000, '', 50000]],
  });
  const buf = makeWorkbook([{ name: '202408 請求書', ws }]);
  const hash = computeFileHash(buf);
  const { invoices } = parseExcel(buf, 'dup_test.xlsx');

  // 1回目
  const r1 = importInvoices(db, { filename: 'dup_test.xlsx', fileHash: hash, invoices });
  assert.equal(r1.newCount, 1, '1回目: 新規1件');
  assert.equal(r1.dupCount, 0, '1回目: 重複0件');

  // 2回目（同じデータ）
  const { invoices: inv2 } = parseExcel(buf, 'dup_test.xlsx');
  const r2 = importInvoices(db, { filename: 'dup_test.xlsx', fileHash: hash, invoices: inv2 });
  assert.equal(r2.newCount, 0,  '2回目: 新規0件');
  assert.equal(r2.dupCount, 1,  '2回目: 重複1件');

  // DB のレコード数は1件のまま
  const count = db.prepare('SELECT COUNT(*) AS c FROM business_invoices').get();
  assert.equal(count.c, 1, 'DBは1件のまま');
});

test('dry-run では DB を書き換えない', () => {
  const db = createDb(':memory:');
  const ws = makeInvoiceSheet({
    invoiceNum: 'DRYRUN-001',
    invoiceDate: 45530,
    totalAmount: 55000,
    lines: [[1, '仕事A　8/1', '', '', '', '', '', 1, '日', 50000, '', 50000]],
  });
  const buf = makeWorkbook([{ name: '202408 請求書', ws }]);
  const { invoices } = parseExcel(buf, 'dryrun.xlsx');

  const r = importInvoices(db, {
    filename: 'dryrun.xlsx',
    fileHash: 'dummy',
    invoices,
    dryRun: true,
  });

  assert.equal(r.newCount, 1, 'dry-run で件数はわかる');
  assert.equal(r.importId, null, 'dry-run では importId が null');

  // DB は空のまま
  const count = db.prepare('SELECT COUNT(*) AS c FROM business_invoices').get();
  assert.equal(count.c, 0, 'dry-run 後 DB は空');
});

// ─── 分析集計テスト ───────────────────────────────────────────────────────────
console.log('\n📈 分析集計');
test('年別・月別・カテゴリ別集計', () => {
  const db = createDb(':memory:');

  // 2024年データ
  const ws2024 = makeInvoiceSheet({
    invoiceNum: 'ANA-2024',
    invoiceDate: 45530,  // 2024-08
    totalAmount: 110000,
    lines: [
      [1, 'ファイターズ　8/1', '', '', '', '', '', 1, '日', 50000, '', 50000],
      [2, '競馬　8/5', '', '', '', '', '', 1, '日', 50000, '', 50000],
    ],
  });

  // 2025年データ（invoiceDate=45870=2025-07, 明細も7月で合わせる）
  const ws2025 = makeInvoiceSheet({
    invoiceNum: 'ANA-2025',
    invoiceDate: 45870,  // 2025-07
    totalAmount: 55000,
    lines: [
      [1, 'UHBスタジオ　7/10', '', '', '', '', '', 1, '日', 50000, '', 50000],
    ],
  });

  const buf2024 = makeWorkbook([{ name: '202408 請求書', ws: ws2024 }]);
  const buf2025 = makeWorkbook([{ name: '202509 請求書', ws: ws2025 }]);

  const { invoices: inv2024 } = parseExcel(buf2024, '2024.xlsx');
  const { invoices: inv2025 } = parseExcel(buf2025, '2025.xlsx');

  importInvoices(db, { filename: '2024.xlsx', fileHash: 'h1', invoices: inv2024 });
  importInvoices(db, { filename: '2025.xlsx', fileHash: 'h2', invoices: inv2025 });

  const analytics = getInvoiceAnalytics(db);
  assert.equal(analytics.byYear.length, 2, '2年分');
  assert.ok(analytics.byYear.some(r => r.year === '2024'), '2024年あり');
  assert.ok(analytics.byYear.some(r => r.year === '2025'), '2025年あり');

  const years = getAvailableYears(db);
  assert.ok(years.includes('2024'), 'getAvailableYears に 2024 含む');
  assert.ok(years.includes('2025'), 'getAvailableYears に 2025 含む');

  const ana2024 = getAnalyticsByYear(db, '2024');
  assert.equal(ana2024.lineCount, 2, '2024年 2件');
  assert.equal(ana2024.subtotal, 100000, '2024年 合計 100,000');

  const lines = getInvoiceLines(db, { year: '2024' });
  assert.equal(lines.length, 2, '2024年の明細2件');
});

// ─── 個人情報テスト ───────────────────────────────────────────────────────────
console.log('\n🔒 個人情報保護');
test('取込後に住所・電話・メールがDBに存在しない', () => {
  const db = createDb(':memory:');
  const ws = makeInvoiceSheet({
    invoiceNum: 'PII-001',
    invoiceDate: 45530,
    totalAmount: 55000,
    clientRow: '株式会社テスト',
    lines: [[1, '仕事　8/1', '', '', '', '', '', 1, '日', 50000, '', 50000]],
  });
  const buf = makeWorkbook([{ name: '202408 請求書', ws }]);
  const { invoices } = parseExcel(buf, 'pii_test.xlsx');
  importInvoices(db, { filename: 'pii_test.xlsx', fileHash: 'hpii', invoices });

  // DB の全テキストを取得して個人情報チェック
  const invRows = db.prepare('SELECT * FROM business_invoices').all();
  const lineRows = db.prepare('SELECT * FROM business_invoice_lines').all();

  const allText = JSON.stringify([...invRows, ...lineRows]);
  assert.ok(!/@/.test(allText), 'メールアドレスが保存されていない');
  assert.ok(!/☎|090-|080-/.test(allText), '電話番号が保存されていない');
  assert.ok(!/〒/.test(allText), '郵便番号・住所が保存されていない');
  assert.ok(!/口座|銀行/.test(allText), '銀行口座情報が保存されていない');
});

// ─── シート名誤記テスト ───────────────────────────────────────────────────────
console.log('\n📝 シート名・請求番号の表記ゆれ');
test('シート名誤記 "202529 請求書" → 2025年9月として解析', () => {
  const rows = [
    ['請　求　書', '', '', '', '', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '', '', '', 'No.2025‐09'],
    ['', '', '', '', '', '', '', '', '', '', '請求日:', 45931],  // 2025-10-01 相当
    ['', '', '', '', '', '', '', '', '', '', '', ''],
    ['株式会社　オーテック', '', '', '', '', '', '', '御 中', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '', '', '', ''],
    ['請求金額', '', '', 13000, '', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '', '', '', ''],
    ['', '', '', '', '', '', '', '', '', '', '', ''],
    ['No.', '作業内容', '', '', '', '', '', '数　量', '', '単　価', '', '金　額'],
    [1, '9/9', 'みんテレ スタジオ 音声業務 (15:00-18:30)', '', '', '', '', 3.5, '時間', 13000, '', 13000],
  ];
  const ws = XLSX.utils.aoa_to_sheet(rows);
  const buf = makeWorkbook([{ name: '202529 請求書', ws }]);
  const result = parseExcel(buf, 'test_typo.xlsx');

  assert.equal(result.invoices.length, 1);
  const line = result.invoices[0].lines[0];
  assert.ok(line.workDate, '日付が解析されている');
  assert.ok(line.workDate.startsWith('2025-09'), `9月の日付 (got: ${line.workDate})`);
  assert.equal(result.invoices[0].invoiceNumber, '2025-09');
});

// ─── インポート履歴テスト ─────────────────────────────────────────────────────
console.log('\n🗂️  インポート履歴');
test('インポート履歴が正しく記録される', () => {
  const db = createDb(':memory:');
  const ws = makeInvoiceSheet({
    invoiceNum: 'HIST-001',
    invoiceDate: 45530,
    totalAmount: 55000,
    lines: [[1, '仕事　8/1', '', '', '', '', '', 1, '日', 50000, '', 50000]],
  });
  const buf = makeWorkbook([{ name: '202408 請求書', ws }]);
  const { invoices } = parseExcel(buf, 'history_test.xlsx');
  importInvoices(db, { filename: 'history_test.xlsx', fileHash: 'hhist', invoices });

  const history = getImportHistory(db);
  assert.equal(history.length, 1, '履歴1件');
  assert.equal(history[0].source_filename, 'history_test.xlsx');
  assert.equal(history[0].new_count, 1);
  assert.equal(history[0].dup_count, 0);
});

// ─── 結果サマリー ─────────────────────────────────────────────────────────────
console.log(`\n${'─'.repeat(50)}`);
console.log(`結果: ${passed + failed} テスト中 ${passed} 成功, ${failed} 失敗`);
if (failed > 0) {
  console.error('\n一部テストが失敗しました');
  process.exit(1);
} else {
  console.log('\nすべてのテストが成功しました ✅');
}
