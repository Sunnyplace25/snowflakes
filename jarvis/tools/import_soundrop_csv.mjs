/**
 * jarvis/tools/import_soundrop_csv.mjs
 * Soundrop 実CSVファイルをDBにインポートするワンオフスクリプト。
 *
 * 処理：
 *   1. CSVをパース・正規化（Soundrop固有ヘッダー→内部フィールド名）
 *   2. ISRCでsf_tracksにマッチ
 *   3. (statement_period, tx_month, service, ISRC) でアグリゲート（国別集計）
 *   4. sf_distribution_imports / sf_distribution_import_rows に記録
 *   5. sf_revenue に INSERT OR IGNORE（UNIQUEキー: month/tx_month/platform/track_id）
 *   6. sf_music_metrics に INSERT OR IGNORE（UNIQUEキー: date/granularity/platform/track_id）
 *
 * 実行: node tools/import_soundrop_csv.mjs [--dry-run]
 */

import { readFileSync } from 'fs';
import { DatabaseSync } from 'node:sqlite';
import { basename } from 'path';

const DRY_RUN = process.argv.includes('--dry-run');

// ── Service名 → 内部platform名 ────────────────────────────────────────────
const SERVICE_MAP = {
  'amazon music unlimited': 'amazon_music',
  'amazon music':           'amazon_music',
  'apple music':            'apple_music',
  'spotify':                'spotify',
  'youtube red':            'youtube_music',
  'youtube music':          'youtube_music',
  'facebook':               'other',
  'tidal':                  'other',
  'tiktok':                 'other',
  'deezer':                 'other',
  'pandora':                'other',
};

function normalizeService(service) {
  return SERVICE_MAP[service.toLowerCase()] ?? 'other';
}

// ── Soundrop CSVパーサー ──────────────────────────────────────────────────
function parseSoundropCsv(text) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.length === 0) return [];
  const headers = lines[0].split(',').map(h => h.trim());
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const vals = lines[i].split(',');
    const obj = {};
    headers.forEach((h, j) => obj[h] = (vals[j] || '').trim());
    if (!obj['Statement Period']) continue;
    rows.push({
      statement_period:  obj['Statement Period'],
      transaction_month: obj['Transaction Month'],
      service:           obj['Service'],
      platform:          normalizeService(obj['Service']),
      channel:           (obj['Channel'] || '').trim(),
      country:           obj['Country'],
      release_title:     obj['Release Title'],
      track_title:       obj['Track Title'],
      upc:               obj['UPC'],
      isrc:              obj['ISRC'],
      quantity:          parseInt(obj['Quantity'], 10) || 0,
      revenue_usd:       parseFloat(obj['Net Revenue in USD']) || 0,
    });
  }
  return rows;
}

// ── メイン ────────────────────────────────────────────────────────────────
const CSV_FILES = [
  'imports/soundrop/747661_2026-05_Soundrop_2026 May.csv',
  'imports/soundrop/747661_2026-06_Soundrop_2026 Jun.csv',
  'imports/soundrop/747661_2026-07_Soundrop_2026 Jul.csv',
  'imports/soundrop/747661_2026-08_Soundrop_2026 Aug.csv',
];

if (DRY_RUN) console.log('[DRY-RUN] DBへの書き込みは行いません\n');

const db = new DatabaseSync('data/business_data.db');

// 事前カウント
const beforeRevenue = db.prepare('SELECT COUNT(*) as n FROM sf_revenue').get().n;
const beforeMetrics = db.prepare('SELECT COUNT(*) as n FROM sf_music_metrics').get().n;
const beforeImports = db.prepare('SELECT COUNT(*) as n FROM sf_distribution_imports').get().n;

console.log('=== インポート前カウント ===');
console.log('sf_revenue:', beforeRevenue, 'rows');
console.log('sf_music_metrics:', beforeMetrics, 'rows');
console.log('sf_distribution_imports:', beforeImports, 'rows');
console.log('');

// ISRCルックアップテーブル
const trackMap = new Map(); // isrc → track_id
db.prepare('SELECT id, isrc FROM sf_tracks WHERE isrc IS NOT NULL').all()
  .forEach(t => trackMap.set(t.isrc, t.id));
console.log('Track ISRC map:', [...trackMap.entries()].map(([k,v]) => k+'→'+v).join(', '));
console.log('');

let totalRawRows = 0;
let totalMatched = 0;
let totalUnmatched = 0;
let totalRevInserted = 0;
let totalMetInserted = 0;

for (const filePath of CSV_FILES) {
  const fileName = basename(filePath);
  console.log('─── ' + fileName + ' ───');

  let text;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (e) {
    console.error('  読み込みエラー:', e.message);
    continue;
  }

  const rows = parseSoundropCsv(text);
  console.log('  パース行数:', rows.length);
  totalRawRows += rows.length;

  // ── sf_distribution_imports 登録（ファイル名重複スキップ）────────────
  let importId = null;
  if (!DRY_RUN) {
    const existing = db.prepare(
      "SELECT id FROM sf_distribution_imports WHERE file_name=? AND distributor='soundrop'"
    ).get(fileName);
    if (existing) {
      console.log('  既インポート済み（スキップ）: import_id=' + existing.id);
      console.log('');
      continue;
    }
    const res = db.prepare(`
      INSERT INTO sf_distribution_imports
        (distributor, source_type, file_name, file_path, report_period, row_count, import_status)
      VALUES ('soundrop', 'csv', ?, ?, ?, ?, 'processing')
    `).run(fileName, filePath, null, rows.length);
    importId = Number(res.lastInsertRowid);
  }

  // ── ISRC マッチ & 行登録 ───────────────────────────────────────────────
  let fileMatched = 0;
  let fileUnmatched = 0;

  rows.forEach((row, i) => {
    const trackId = row.isrc ? (trackMap.get(row.isrc) ?? null) : null;
    const method  = trackId ? 'isrc' : 'unmatched';
    if (trackId) fileMatched++; else fileUnmatched++;

    if (!DRY_RUN && importId !== null) {
      db.prepare(`
        INSERT INTO sf_distribution_import_rows
          (import_id, row_index, raw_data, matched_track_id, match_method,
           platform, period, streams, revenue_amount, currency, needs_review)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'USD', ?)
      `).run(
        importId, i, JSON.stringify(row), trackId, method,
        row.service, row.transaction_month, row.quantity, row.revenue_usd,
        trackId ? 0 : 1,
      );
    }
  });

  console.log('  マッチ:', fileMatched, '/ アンマッチ:', fileUnmatched);
  totalMatched   += fileMatched;
  totalUnmatched += fileUnmatched;

  // ── アグリゲート: (statement_period, tx_month, service, isrc) ──────────
  const aggMap = new Map();
  rows.forEach(row => {
    const trackId = row.isrc ? (trackMap.get(row.isrc) ?? null) : null;
    if (!trackId) return;
    const key = [row.statement_period, row.transaction_month, row.service, row.platform, trackId].join('|');
    if (!aggMap.has(key)) {
      aggMap.set(key, {
        statement_period:  row.statement_period,
        transaction_month: row.transaction_month,
        service:           row.service,
        platform:          row.platform,
        track_id:          trackId,
        quantity:          0,
        revenue_usd:       0,
      });
    }
    const e = aggMap.get(key);
    e.quantity    += row.quantity;
    e.revenue_usd += row.revenue_usd;
  });

  console.log('  アグリゲート後ユニークキー数:', aggMap.size);

  // ── sf_revenue 書き込み ────────────────────────────────────────────────
  let revInserted = 0;
  let revIgnored  = 0;

  aggMap.forEach(agg => {
    const date  = agg.transaction_month + '-01';
    const month = agg.statement_period;   // どのstatementから来たか
    const txMon = agg.transaction_month;
    const rev   = Math.round(agg.revenue_usd * 1e8) / 1e8; // float丸め

    if (DRY_RUN) {
      console.log('  [DRY] sf_revenue:', month, txMon, agg.service, 'track'+agg.track_id,
                  'qty='+agg.quantity, 'rev='+rev.toFixed(6)+'USD');
      revInserted++;
      return;
    }

    const res = db.prepare(`
      INSERT OR IGNORE INTO sf_revenue
        (date, month, source, platform, track_id, amount, currency, amount_jpy,
         import_source, transaction_month, quantity)
      VALUES (?, ?, '音楽配信', ?, ?, ?, 'USD', 0, 'csv', ?, ?)
    `).run(date, month, agg.service, agg.track_id, rev, txMon, agg.quantity);
    if (res.changes > 0) revInserted++; else revIgnored++;
  });

  console.log('  sf_revenue: inserted=' + revInserted + ' ignored=' + revIgnored);
  totalRevInserted += revInserted;

  // ── sf_music_metrics 書き込み ─────────────────────────────────────────
  // tx_month ベースでアグリゲート (複数statement period をまたぐ)
  const metMap = new Map();
  aggMap.forEach(agg => {
    const key = [agg.transaction_month, agg.platform, agg.track_id].join('|');
    if (!metMap.has(key)) {
      metMap.set(key, {
        transaction_month: agg.transaction_month,
        platform:          agg.platform,
        track_id:          agg.track_id,
        quantity:          0,
        revenue_usd:       0,
      });
    }
    const e = metMap.get(key);
    e.quantity    += agg.quantity;
    e.revenue_usd += agg.revenue_usd;
  });

  let metInserted = 0;
  let metIgnored  = 0;

  metMap.forEach(m => {
    const date = m.transaction_month + '-01';

    if (DRY_RUN) {
      console.log('  [DRY] sf_music_metrics:', date, 'monthly', m.platform, 'track'+m.track_id,
                  'streams='+m.quantity, 'rev='+m.revenue_usd.toFixed(6)+'USD');
      metInserted++;
      return;
    }

    const res = db.prepare(`
      INSERT OR IGNORE INTO sf_music_metrics
        (date, month, granularity, platform, track_id, streams, revenue_amount, currency, import_source)
      VALUES (?, ?, 'monthly', ?, ?, ?, ?, 'USD', 'csv')
    `).run(date, m.transaction_month, m.platform, m.track_id, m.quantity,
           Math.round(m.revenue_usd * 1e8) / 1e8);
    if (res.changes > 0) metInserted++; else metIgnored++;
  });

  console.log('  sf_music_metrics: inserted=' + metInserted + ' ignored=' + metIgnored);
  totalMetInserted += metInserted;

  // ── sf_distribution_imports 更新 ──────────────────────────────────────
  if (!DRY_RUN && importId !== null) {
    db.prepare(`
      UPDATE sf_distribution_imports SET
        import_status   = 'completed',
        matched_count   = ?,
        unmatched_count = ?
      WHERE id = ?
    `).run(fileMatched, fileUnmatched, importId);
  }

  console.log('');
}

// 事後カウント
if (!DRY_RUN) {
  const afterRevenue = db.prepare('SELECT COUNT(*) as n FROM sf_revenue').get().n;
  const afterMetrics = db.prepare('SELECT COUNT(*) as n FROM sf_music_metrics').get().n;
  const afterImports = db.prepare('SELECT COUNT(*) as n FROM sf_distribution_imports').get().n;

  console.log('=== インポート後カウント ===');
  console.log('sf_revenue:              ' + beforeRevenue + ' → ' + afterRevenue + ' (+' + (afterRevenue - beforeRevenue) + ')');
  console.log('sf_music_metrics:        ' + beforeMetrics + ' → ' + afterMetrics + ' (+' + (afterMetrics - beforeMetrics) + ')');
  console.log('sf_distribution_imports: ' + beforeImports + ' → ' + afterImports + ' (+' + (afterImports - beforeImports) + ')');
}

console.log('\n=== サマリー ===');
console.log('総RAW行数:', totalRawRows);
console.log('総マッチ数:', totalMatched, '/ 総アンマッチ:', totalUnmatched);
console.log('sf_revenue 新規:', totalRevInserted);
console.log('sf_music_metrics 新規:', totalMetInserted);
if (DRY_RUN) console.log('\n[DRY-RUN完了] DBへの変更なし');

db.close();
