/**
 * jarvis/tests/test_soundrop_importer.js
 * Soundrop CSV インポーター テスト
 *
 * 検証内容:
 *   - CSV パース: 通常行・空行・ヘッダーのみ
 *   - ISRC マッチ: 一致 / 不一致 → needs_review=1
 *   - UPC マッチ: 一致 / 不一致
 *   - 重複インポート: 冪等性（INSERT OR IGNORE）
 *   - import_status 遷移: pending → completed / partial / failed
 *   - matched_count / unmatched_count の正確性
 *
 * 重要: ':memory:' DBのみ使用。business_data.db には触れない。
 */

import assert from 'node:assert/strict';
import { writeFileSync, unlinkSync, mkdirSync } from 'fs';
import { tmpdir } from 'os';
import { join }   from 'path';

import { createDb } from '../data/db.js';
import { seed }     from '../data/sf_seed.js';
import { parseCsv } from '../importers/parsers/csv_parser.js';
import { matchTrack } from '../importers/matchers/track_matcher.js';
import { importFile, getUnreviewedRows } from '../importers/soundrop.js';

// ─── セットアップ ─────────────────────────────────────────────────────────────

const db = createDb(':memory:');
seed(db);

// テスト用トラックに ISRC を設定
const signalId = db.prepare("SELECT id FROM sf_tracks WHERE track_key='signal'").get().id;
db.prepare("UPDATE sf_tracks SET isrc=? WHERE id=?").run('JPXX12345678', signalId);

// テスト用リリースを作成（UPC テスト用）
db.prepare(`
  INSERT INTO sf_releases (release_key, title, release_type, upc_ean)
  VALUES ('signal_single', 'Signal Single', 'single', '123456789012')
`).run();
const releaseId = db.prepare("SELECT id FROM sf_releases WHERE release_key='signal_single'").get().id;

// ─── テストランナー ───────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ❌ ${name}`);
    console.error(`     ${e.message}`);
    failed++;
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`  ✅ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ❌ ${name}`);
    console.error(`     ${e.message}`);
    failed++;
  }
}

/** 一時ファイルを作成してパスを返す */
function writeTmp(content, ext = '.csv') {
  const path = join(tmpdir(), `jarvis_test_${Date.now()}_${Math.random().toString(36).slice(2)}${ext}`);
  writeFileSync(path, content, 'utf8');
  return path;
}

// ─── 1. CSV パース ────────────────────────────────────────────────────────────

console.log('\n▶ CSV パース');

test('通常の CSV を正しくパースできる', () => {
  const csv = `isrc,platform,streams,period\nJPXX12345678,spotify,100,2026-07\nJPXX99999999,apple_music,50,2026-07`;
  const rows = parseCsv(csv);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].isrc, 'JPXX12345678');
  assert.equal(rows[0].platform, 'spotify');
  assert.equal(rows[0].streams, '100');
  assert.equal(rows[1].isrc, 'JPXX99999999');
});

test('空行はスキップされる', () => {
  const csv = `isrc,platform,streams\nJPXX12345678,spotify,100\n\nJPXX99999999,apple_music,50\n\n`;
  const rows = parseCsv(csv);
  assert.equal(rows.length, 2);
});

test('ヘッダーのみの場合は空配列を返す', () => {
  const csv = `isrc,platform,streams`;
  const rows = parseCsv(csv);
  assert.equal(rows.length, 0);
});

test('空テキストは空配列を返す', () => {
  const rows = parseCsv('');
  assert.equal(rows.length, 0);
});

test('クォートフィールドをパースできる', () => {
  const csv = `isrc,title,streams\nJPXX12345678,"Signal, A-side",100`;
  const rows = parseCsv(csv);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].title, 'Signal, A-side');
  assert.equal(rows[0].streams, '100');
});

test('TSV を delimiter オプションでパースできる', () => {
  const tsv = `isrc\tplatform\tstreams\nJPXX12345678\tspotify\t100`;
  const rows = parseCsv(tsv, { delimiter: '\t' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].isrc, 'JPXX12345678');
  assert.equal(rows[0].platform, 'spotify');
});

// ─── 2. ISRC マッチ ───────────────────────────────────────────────────────────

console.log('\n▶ ISRC マッチ');

test('ISRC が一致する場合は track_id が返る', () => {
  const result = matchTrack(db, { isrc: 'JPXX12345678' });
  assert.equal(result.track_id, signalId);
  assert.equal(result.method, 'isrc');
  assert.equal(result.release_id, null);
});

test('ISRC が一致しない場合は needs_review = unmatched になる', () => {
  const result = matchTrack(db, { isrc: 'JPZZ99999999' });
  assert.equal(result.track_id, null);
  assert.equal(result.release_id, null);
  assert.equal(result.method, 'unmatched');
});

test('ISRC が空の場合は次のマッチ手順に進む', () => {
  const result = matchTrack(db, { isrc: '', upc: '123456789012' });
  assert.equal(result.release_id, releaseId);
  assert.equal(result.method, 'upc');
});

// ─── 3. UPC マッチ ────────────────────────────────────────────────────────────

console.log('\n▶ UPC マッチ');

test('UPC が一致する場合は release_id が返る', () => {
  const result = matchTrack(db, { upc: '123456789012' });
  assert.equal(result.release_id, releaseId);
  assert.equal(result.method, 'upc');
  assert.equal(result.track_id, null);
});

test('UPC が一致しない場合は unmatched になる', () => {
  const result = matchTrack(db, { upc: '000000000000' });
  assert.equal(result.track_id, null);
  assert.equal(result.release_id, null);
  assert.equal(result.method, 'unmatched');
});

// ─── 4. track_key マッチ ─────────────────────────────────────────────────────

console.log('\n▶ track_key マッチ');

test('track_key が一致する場合は track_id が返る', () => {
  const result = matchTrack(db, { track_key: 'glass_no_heri' });
  const expected = db.prepare("SELECT id FROM sf_tracks WHERE track_key='glass_no_heri'").get().id;
  assert.equal(result.track_id, expected);
  assert.equal(result.method, 'track_key');
});

test('track_key が一致しない場合は unmatched になる', () => {
  const result = matchTrack(db, { track_key: 'nonexistent_track' });
  assert.equal(result.track_id, null);
  assert.equal(result.method, 'unmatched');
});

// ─── 5. importFile: 完全マッチ ───────────────────────────────────────────────

console.log('\n▶ importFile: 完全マッチ');

await testAsync('ISRC でマッチした行が completed になる', async () => {
  const csv = `isrc,platform,streams,period\nJPXX12345678,spotify,200,2026-07`;
  const path = writeTmp(csv);

  try {
    const result = await importFile(db, path, { report_period: '2026-07' });
    assert.equal(result.rowCount, 1);
    assert.equal(result.matchedCount, 1);
    assert.equal(result.unmatchedCount, 0);

    const importRow = db.prepare('SELECT * FROM sf_distribution_imports WHERE id=?').get(result.importId);
    assert.equal(importRow.import_status, 'completed');
    assert.equal(importRow.matched_count, 1);
    assert.equal(importRow.unmatched_count, 0);
  } finally {
    unlinkSync(path);
  }
});

await testAsync('matched_count / unmatched_count が正確に記録される', async () => {
  const csv = [
    'isrc,platform,streams,period',
    'JPXX12345678,spotify,100,2026-06',     // マッチ
    'JPZZ00000001,spotify,50,2026-06',      // アンマッチ
    'JPZZ00000002,apple_music,30,2026-06',  // アンマッチ
  ].join('\n');
  const path = writeTmp(csv);

  try {
    const result = await importFile(db, path, { report_period: '2026-06' });
    assert.equal(result.rowCount, 3);
    assert.equal(result.matchedCount, 1);
    assert.equal(result.unmatchedCount, 2);

    const importRow = db.prepare('SELECT * FROM sf_distribution_imports WHERE id=?').get(result.importId);
    assert.equal(importRow.import_status, 'partial');
  } finally {
    unlinkSync(path);
  }
});

// ─── 6. アンマッチ行の needs_review ─────────────────────────────────────────

console.log('\n▶ アンマッチ行の needs_review');

await testAsync('アンマッチ行は needs_review=1 で記録される', async () => {
  const csv = `isrc,platform,streams,period\nJPZZ99999999,spotify,50,2026-05`;
  const path = writeTmp(csv);

  try {
    const result = await importFile(db, path);
    const rows = getUnreviewedRows(db, result.importId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].needs_review, 1);
    assert.equal(rows[0].match_method, 'unmatched');
  } finally {
    unlinkSync(path);
  }
});

await testAsync('マッチ行は needs_review=0 で記録される', async () => {
  const csv = `isrc,platform,streams,period\nJPXX12345678,spotify,150,2026-04`;
  const path = writeTmp(csv);

  try {
    const result = await importFile(db, path);
    const allRows = db.prepare('SELECT * FROM sf_distribution_import_rows WHERE import_id=?').all(result.importId);
    assert.equal(allRows.length, 1);
    assert.equal(allRows[0].needs_review, 0);
    assert.equal(allRows[0].match_method, 'isrc');
  } finally {
    unlinkSync(path);
  }
});

// ─── 7. 重複インポート（冪等性）─────────────────────────────────────────────

console.log('\n▶ 重複インポート（冪等性）');

await testAsync('同一データを2回インポートしても sf_music_metrics が増えない', async () => {
  const csv = `isrc,platform,streams,period\nJPXX12345678,spotify,300,2026-03`;
  const path = writeTmp(csv);

  try {
    await importFile(db, path, { report_period: '2026-03' });
    const countBefore = db.prepare(
      "SELECT COUNT(*) as c FROM sf_music_metrics WHERE track_id=? AND platform='spotify' AND date='2026-03-01'"
    ).get(signalId).c;

    await importFile(db, path, { report_period: '2026-03' });
    const countAfter = db.prepare(
      "SELECT COUNT(*) as c FROM sf_music_metrics WHERE track_id=? AND platform='spotify' AND date='2026-03-01'"
    ).get(signalId).c;

    assert.equal(countBefore, countAfter, `重複して metrics が挿入された: ${countBefore} → ${countAfter}`);
  } finally {
    unlinkSync(path);
  }
});

// ─── 8. import_status 遷移 ───────────────────────────────────────────────────

console.log('\n▶ import_status 遷移');

await testAsync('全行マッチ → import_status = completed', async () => {
  const csv = `isrc,platform,streams,period\nJPXX12345678,spotify,400,2026-02`;
  const path = writeTmp(csv);

  try {
    const result = await importFile(db, path);
    const row = db.prepare('SELECT import_status FROM sf_distribution_imports WHERE id=?').get(result.importId);
    assert.equal(row.import_status, 'completed');
  } finally {
    unlinkSync(path);
  }
});

await testAsync('一部未マッチ → import_status = partial', async () => {
  const csv = [
    'isrc,platform,streams',
    'JPXX12345678,spotify,100',
    'JPZZ11111111,amazon_music,20',
  ].join('\n');
  const path = writeTmp(csv);

  try {
    const result = await importFile(db, path);
    const row = db.prepare('SELECT import_status FROM sf_distribution_imports WHERE id=?').get(result.importId);
    assert.equal(row.import_status, 'partial');
  } finally {
    unlinkSync(path);
  }
});

await testAsync('全行未マッチ → import_status = partial', async () => {
  const csv = `isrc,platform,streams\nJPZZ00001111,spotify,10`;
  const path = writeTmp(csv);

  try {
    const result = await importFile(db, path);
    const row = db.prepare('SELECT import_status FROM sf_distribution_imports WHERE id=?').get(result.importId);
    assert.equal(row.import_status, 'partial');
    assert.equal(result.unmatchedCount, 1);
    assert.equal(result.matchedCount, 0);
  } finally {
    unlinkSync(path);
  }
});

await testAsync('空ファイル（ヘッダーのみ）→ import_status = completed', async () => {
  const csv = `isrc,platform,streams`;
  const path = writeTmp(csv);

  try {
    const result = await importFile(db, path);
    assert.equal(result.rowCount, 0);
    const row = db.prepare('SELECT import_status FROM sf_distribution_imports WHERE id=?').get(result.importId);
    assert.equal(row.import_status, 'completed');
  } finally {
    unlinkSync(path);
  }
});

await testAsync('存在しないファイルパスは例外を投げる', async () => {
  try {
    await importFile(db, '/tmp/nonexistent_jarvis_test_file_12345.csv');
    throw new Error('例外が発生しなかった');
  } catch (e) {
    assert.ok(e.message.includes('ファイル読み込みエラー') || e.message.includes('ENOENT'),
      `期待したエラーメッセージでない: ${e.message}`);
  }
});

// ─── 9. UPC でのインポート ────────────────────────────────────────────────────

console.log('\n▶ UPC でのインポート');

await testAsync('UPC でマッチした行が正しく記録される', async () => {
  const csv = `upc,platform,streams,period\n123456789012,spotify,500,2026-01`;
  const path = writeTmp(csv);

  try {
    const result = await importFile(db, path);
    assert.equal(result.matchedCount, 1);
    assert.equal(result.unmatchedCount, 0);

    const rows = db.prepare('SELECT * FROM sf_distribution_import_rows WHERE import_id=?').all(result.importId);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].match_method, 'upc');
    assert.equal(rows[0].matched_release_id, releaseId);
  } finally {
    unlinkSync(path);
  }
});

// ─── 10. sf_revenue への収益書き込み ────────────────────────────────────────
// metrics_writer.js は sf_music_metrics と sf_revenue を同一関数で処理する。
// revenue > 0 の行のみ sf_revenue へ INSERT OR IGNORE する。

console.log('\n▶ sf_revenue への収益書き込み');

await testAsync('収益付き行を取り込むと sf_revenue にレコードが作られる', async () => {
  const csv = `isrc,platform,streams,revenue,currency,period\nJPXX12345678,spotify,800,1234.56,JPY,2025-12`;
  const path = writeTmp(csv);

  try {
    await importFile(db, path, { report_period: '2025-12' });
    const row = db.prepare(
      "SELECT * FROM sf_revenue WHERE track_id=? AND platform='spotify' AND month='2025-12'"
    ).get(signalId);
    assert.ok(row, 'sf_revenue にレコードが存在しない');
    assert.equal(row.source, '音楽配信');
    assert.equal(row.amount, 1234.56);
    assert.equal(row.currency, 'JPY');
    assert.equal(row.amount_jpy, 1235);    // Math.round(1234.56)
    assert.equal(row.import_source, 'csv');
  } finally {
    unlinkSync(path);
  }
});

await testAsync('収益0の行は sf_revenue に書き込まれない', async () => {
  const csv = `isrc,platform,streams,revenue,currency,period\nJPXX12345678,amazon_music,50,0,JPY,2025-11`;
  const path = writeTmp(csv);

  try {
    const countBefore = db.prepare(
      "SELECT COUNT(*) as c FROM sf_revenue WHERE track_id=? AND platform='amazon_music' AND month='2025-11'"
    ).get(signalId).c;

    await importFile(db, path);

    const countAfter = db.prepare(
      "SELECT COUNT(*) as c FROM sf_revenue WHERE track_id=? AND platform='amazon_music' AND month='2025-11'"
    ).get(signalId).c;

    assert.equal(countAfter, countBefore, '収益0なのに sf_revenue に書き込まれた');
  } finally {
    unlinkSync(path);
  }
});

await testAsync('収益付き行を2回取り込んでも sf_revenue が重複しない（冪等性）', async () => {
  const csv = `isrc,platform,streams,revenue,currency,period\nJPXX12345678,apple_music,300,500.00,JPY,2025-10`;
  const path = writeTmp(csv);

  try {
    await importFile(db, path, { report_period: '2025-10' });
    await importFile(db, path, { report_period: '2025-10' });

    const count = db.prepare(
      "SELECT COUNT(*) as c FROM sf_revenue WHERE track_id=? AND platform='apple_music' AND month='2025-10'"
    ).get(signalId).c;
    assert.equal(count, 1, `sf_revenue に重複が発生: ${count}件`);
  } finally {
    unlinkSync(path);
  }
});

await testAsync('収益あり・なし混在の場合、収益行のみ sf_revenue に登録される', async () => {
  const csv = [
    'isrc,platform,streams,revenue,currency,period',
    'JPXX12345678,spotify,100,200.00,JPY,2025-09',   // 収益あり
    'JPXX12345678,youtube_music,50,0,JPY,2025-09',    // 収益なし
  ].join('\n');
  const path = writeTmp(csv);

  try {
    await importFile(db, path, { report_period: '2025-09' });

    const spotifyRev = db.prepare(
      "SELECT * FROM sf_revenue WHERE track_id=? AND platform='spotify' AND month='2025-09'"
    ).get(signalId);
    assert.ok(spotifyRev, 'spotify の sf_revenue レコードがない');

    const youtubeRev = db.prepare(
      "SELECT COUNT(*) as c FROM sf_revenue WHERE track_id=? AND platform='youtube_music' AND month='2025-09'"
    ).get(signalId).c;
    assert.equal(youtubeRev, 0, 'youtube_music（収益0）が sf_revenue に登録されてしまった');
  } finally {
    unlinkSync(path);
  }
});

// ─── 結果サマリー ─────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`  結果: ${passed} passed / ${failed} failed`);
if (failed > 0) {
  console.error('  ❌ テスト失敗あり');
  process.exit(1);
}
console.log('  ✅ 全テスト通過');
