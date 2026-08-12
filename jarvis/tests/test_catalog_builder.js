/**
 * jarvis/tests/test_catalog_builder.js
 * catalog_builder.js テスト
 *
 * 検証内容:
 *   - sf_tracks 3ステップ照合（ISRC一致 / タイトル一致 / 新規INSERT）
 *   - 既存 seed 曲（Little Snow / SWEETs / 置いた音）の track_key/id 維持
 *   - sf_releases 登録（single 自動判定 / ep オプション / 登録保留）
 *   - sf_release_tracks / sf_distributions 登録
 *   - 冪等性（同一CSV 2回実行で重複なし）
 *   - 統合テスト: 3か月分相当データで 9曲 / 4リリースを正しく登録
 *
 * 重要: ':memory:' DB のみ使用。business_data.db には触れない。
 */

import assert from 'node:assert/strict';

import { createDb }      from '../data/db.js';
import { seed }          from '../data/sf_seed.js';
import { buildCatalog, ISRC_TITLE_OVERRIDES }  from '../importers/catalog_builder.js';

// ─── Soundrop Statement CSV ヘルパー ─────────────────────────────────────────

const SOUNDROP_HEADER = [
  'Statement Period', 'Transaction Month', 'Service', 'Country', 'Label', 'Artist',
  'Release Title', 'Track Title', 'UPC', 'ISRC', 'Release Catalog ID', 'Track Catalog ID',
  'Channel', 'Format', 'Quantity', 'Gross Revenue in USD', 'Mechanical Royalties Deducted',
  'Contract ID', 'Net Revenue in USD', 'Your Share %', 'Amount Due in USD',
  'Statement Total in USD', 'Opening Balance in USD', 'Closing Balance in USD',
].join(',');

function makeRow({ period = '2026-07', month = '2026-04', service = 'Apple Music',
                   country = 'Japan', releaseTitle, trackTitle, upc, isrc }) {
  return [
    period, month, service, country, 'Snow flakes', 'Snow flakes',
    releaseTitle, trackTitle, upc, isrc, upc, '',
    'Subscription Streaming', 'Track ', '1',
    '0.004', '0', '903737', '0.0034', '100', '0.0034', '', '', '',
  ].join(',');
}

function makeCsv(rows) {
  return [SOUNDROP_HEADER, ...rows.map(makeRow)].join('\r\n');
}

// ─── 3か月分相当の統合CSV ─────────────────────────────────────────────────────
// 実際のSoundrop Statementから確認した9 ISRC / 4 UPC に対応

const ALL_TRACKS = [
  // SWEETs single（seed: sweets_track, isrc=NULL）
  { releaseTitle: 'SWEETs',       trackTitle: 'SWEETs',            upc: '199999603313', isrc: 'QZPJ32544083' },
  { releaseTitle: 'SWEETs',       trackTitle: 'SWEETs',            upc: '199999603313', isrc: 'QZPJ32544083', country: 'US' },  // 重複行
  // 置いた音 single（seed: oita_oto, isrc=NULL）
  { releaseTitle: '置いた音',      trackTitle: '置いた音',           upc: '199999610892', isrc: 'QZPJ32545428' },
  // Round Bounce single（seed なし）
  { releaseTitle: 'Round Bounce', trackTitle: 'Round Bounce',       upc: '199999597629', isrc: 'QZPJ32543034' },
  // Early Snow EP — 6曲（seed: little_snow=QZPJ32548359 のみ一致）
  { releaseTitle: 'Early Snow',   trackTitle: 'Little Snow',        upc: '199999625681', isrc: 'QZPJ32548359' },
  { releaseTitle: 'Early Snow',   trackTitle: '約束はしない',        upc: '199999625681', isrc: 'QZPJ32548354' },
  { releaseTitle: 'Early Snow',   trackTitle: '透明のまま',          upc: '199999625681', isrc: 'QZPJ32548355' },
  { releaseTitle: 'Early Snow',   trackTitle: 'Little Snow (Near)', upc: '199999625681', isrc: 'QZPJ32548356' },
  { releaseTitle: 'Early Snow',   trackTitle: 'Still ',             upc: '199999625681', isrc: 'QZPJ32548357' },  // 末尾スペースあり
  { releaseTitle: 'Early Snow',   trackTitle: '名前のない歌',        upc: '199999625681', isrc: 'QZPJ32548358' },
];

const INTEGRATION_CSV = makeCsv(ALL_TRACKS);

const RELEASE_TYPES = { '199999625681': 'ep' };

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

// ─── 1. sf_tracks: ISRC 完全一致 ─────────────────────────────────────────────

console.log('\n▶ sf_tracks: ISRC 完全一致');

test('ISRC一致 → 既存trackをUPDATE（tracksUpdatedByIsrc=1）', () => {
  const db = createDb(':memory:');
  seed(db);
  // signal に ISRC を事前設定
  db.prepare("UPDATE sf_tracks SET isrc='JPTEST00000001' WHERE track_key='signal'").run();

  const csv = makeCsv([
    { releaseTitle: 'Signal Single', trackTitle: 'Signal', upc: '111111111111', isrc: 'JPTEST00000001' },
  ]);
  const result = buildCatalog(db, csv);
  assert.equal(result.tracksUpdatedByIsrc, 1, 'tracksUpdatedByIsrc が 1 でない');
  assert.equal(result.tracksInserted,      0, 'tracksInserted が 0 でない');
  assert.equal(result.tracksUpdatedByTitle,0, 'tracksUpdatedByTitle が 0 でない');
});

test('ISRC一致 → track_key / id が変更されない', () => {
  const db = createDb(':memory:');
  seed(db);
  db.prepare("UPDATE sf_tracks SET isrc='JPTEST00000001' WHERE track_key='signal'").run();
  const before = db.prepare("SELECT id, track_key FROM sf_tracks WHERE track_key='signal'").get();

  const csv = makeCsv([
    { releaseTitle: 'Signal Single', trackTitle: 'Signal', upc: '111111111111', isrc: 'JPTEST00000001' },
  ]);
  buildCatalog(db, csv);
  const after = db.prepare("SELECT id, track_key FROM sf_tracks WHERE isrc='JPTEST00000001'").get();

  assert.equal(after.id,        before.id,        'id が変わってしまった');
  assert.equal(after.track_key, before.track_key,  'track_key が変わってしまった');
});

test('ISRC一致 → status が released に更新される', () => {
  const db = createDb(':memory:');
  seed(db);
  db.prepare("UPDATE sf_tracks SET isrc='JPTEST00000001' WHERE track_key='signal'").run();

  const csv = makeCsv([
    { releaseTitle: 'Signal Single', trackTitle: 'Signal', upc: '111111111111', isrc: 'JPTEST00000001' },
  ]);
  buildCatalog(db, csv);
  const track = db.prepare("SELECT status FROM sf_tracks WHERE isrc='JPTEST00000001'").get();
  assert.equal(track.status, 'released');
});

// ─── 2. sf_tracks: タイトル完全一致 + isrc NULL ───────────────────────────────

console.log('\n▶ sf_tracks: タイトル一致（ISRC未設定 seed曲）');

test('タイトル一致+isrc NULL → tracksUpdatedByTitle=1', () => {
  const db = createDb(':memory:');
  seed(db);

  const csv = makeCsv([
    { releaseTitle: 'SWEETs', trackTitle: 'SWEETs', upc: '199999603313', isrc: 'QZPJ32544083' },
  ]);
  const result = buildCatalog(db, csv);
  assert.equal(result.tracksUpdatedByTitle, 1);
  assert.equal(result.tracksInserted,       0);
});

test('タイトル一致 → track_key / id が変更されない', () => {
  const db = createDb(':memory:');
  seed(db);
  const before = db.prepare("SELECT id, track_key FROM sf_tracks WHERE track_key='sweets_track'").get();

  const csv = makeCsv([
    { releaseTitle: 'SWEETs', trackTitle: 'SWEETs', upc: '199999603313', isrc: 'QZPJ32544083' },
  ]);
  buildCatalog(db, csv);
  const after = db.prepare("SELECT id, track_key FROM sf_tracks WHERE isrc='QZPJ32544083'").get();

  assert.equal(after.id,        before.id,       'id が変わってしまった');
  assert.equal(after.track_key, 'sweets_track',  'track_key が変わってしまった');
});

test('タイトル一致 → isrc が設定される', () => {
  const db = createDb(':memory:');
  seed(db);
  const csv = makeCsv([
    { releaseTitle: '置いた音', trackTitle: '置いた音', upc: '199999610892', isrc: 'QZPJ32545428' },
  ]);
  buildCatalog(db, csv);
  const track = db.prepare("SELECT isrc, track_key FROM sf_tracks WHERE track_key='oita_oto'").get();
  assert.equal(track.isrc,      'QZPJ32545428');
  assert.equal(track.track_key, 'oita_oto');
});

test('Track Title の末尾スペース → trim後にタイトル一致', () => {
  const db = createDb(':memory:');
  seed(db);
  // 'Still' というタイトルの track を seed に追加（isrc NULL）
  db.prepare("INSERT INTO sf_tracks (track_key, title) VALUES ('still_track', 'Still')").run();

  // CSV 上のタイトルは 'Still '（末尾スペース）
  const csv = makeCsv([
    { releaseTitle: 'Early Snow', trackTitle: 'Still ', upc: '199999625681', isrc: 'QZPJ32548357' },
  ]);
  const result = buildCatalog(db, csv);
  assert.equal(result.tracksUpdatedByTitle, 1, 'trim後に一致しなかった');

  const track = db.prepare("SELECT isrc, track_key FROM sf_tracks WHERE track_key='still_track'").get();
  assert.equal(track.isrc, 'QZPJ32548357');
});

// ─── 3. sf_tracks: 新規 INSERT ───────────────────────────────────────────────

console.log('\n▶ sf_tracks: 新規 INSERT');

test('タイトル不一致・ISRC新規 → tracksInserted=1', () => {
  const db = createDb(':memory:');
  seed(db);
  const csv = makeCsv([
    { releaseTitle: 'Round Bounce', trackTitle: 'Round Bounce', upc: '199999597629', isrc: 'QZPJ32543034' },
  ]);
  const result = buildCatalog(db, csv);
  assert.equal(result.tracksInserted, 1);
});

test("新規INSERT後: track_key が 'isrc_' + ISRC.toLowerCase()", () => {
  const db = createDb(':memory:');
  seed(db);
  const csv = makeCsv([
    { releaseTitle: 'Round Bounce', trackTitle: 'Round Bounce', upc: '199999597629', isrc: 'QZPJ32543034' },
  ]);
  buildCatalog(db, csv);
  const track = db.prepare("SELECT track_key FROM sf_tracks WHERE isrc='QZPJ32543034'").get();
  assert.equal(track?.track_key, 'isrc_qzpj32543034');
});

test('タイトル2件以上+isrc NULL → needs_review に記録される', () => {
  const db = createDb(':memory:');
  seed(db);
  // 同タイトルを2件作成（isrc NULL）
  db.prepare("INSERT INTO sf_tracks (track_key, title) VALUES ('dup_a', 'DupTrack')").run();
  db.prepare("INSERT INTO sf_tracks (track_key, title) VALUES ('dup_b', 'DupTrack')").run();

  const csv = makeCsv([
    { releaseTitle: 'Test', trackTitle: 'DupTrack', upc: '999999999999', isrc: 'JPDUP00000001' },
  ]);
  const result = buildCatalog(db, csv);
  assert.equal(result.tracksNeedsReview.length, 1);
  assert.equal(result.tracksInserted,           0);
  assert.equal(result.tracksUpdatedByTitle,     0);
});

// ─── 4. sf_releases ──────────────────────────────────────────────────────────

console.log('\n▶ sf_releases');

test('1 ISRC/UPC → release_type=single で自動登録される', () => {
  const db = createDb(':memory:');
  seed(db);
  const csv = makeCsv([
    { releaseTitle: 'SWEETs', trackTitle: 'SWEETs', upc: '199999603313', isrc: 'QZPJ32544083' },
  ]);
  buildCatalog(db, csv);
  const rel = db.prepare("SELECT release_type, release_key FROM sf_releases WHERE upc_ean='199999603313'").get();
  assert.equal(rel?.release_type, 'single');
  assert.equal(rel?.release_key,  'upc_199999603313');
});

test('複数ISRC/UPC + releaseTypes 指定 → 指定の release_type で登録される', () => {
  const db = createDb(':memory:');
  seed(db);
  const csv = makeCsv([
    { releaseTitle: 'Early Snow', trackTitle: 'Little Snow',  upc: '199999625681', isrc: 'QZPJ32548359' },
    { releaseTitle: 'Early Snow', trackTitle: '約束はしない', upc: '199999625681', isrc: 'QZPJ32548354' },
  ]);
  buildCatalog(db, csv, { releaseTypes: { '199999625681': 'ep' } });
  const rel = db.prepare("SELECT release_type FROM sf_releases WHERE upc_ean='199999625681'").get();
  assert.equal(rel?.release_type, 'ep');
});

test('複数ISRC/UPC + releaseTypes 未指定 → 登録保留（sf_releases に登録されない）', () => {
  const db = createDb(':memory:');
  seed(db);
  const csv = makeCsv([
    { releaseTitle: 'Early Snow', trackTitle: 'Little Snow',  upc: '199999625681', isrc: 'QZPJ32548359' },
    { releaseTitle: 'Early Snow', trackTitle: '約束はしない', upc: '199999625681', isrc: 'QZPJ32548354' },
  ]);
  const result = buildCatalog(db, csv);  // releaseTypes 未指定
  const rel = db.prepare("SELECT id FROM sf_releases WHERE upc_ean='199999625681'").get();
  assert.equal(rel, undefined, 'releaseTypes未指定なのに sf_releases に登録されてしまった');
  assert.ok(result.tracksNeedsReview.some(r => r.title === 'Early Snow'));
});

test('既存 UPC → スキップ（releasesSkipped=1、重複なし）', () => {
  const db = createDb(':memory:');
  seed(db);
  db.prepare(`
    INSERT INTO sf_releases (release_key, title, release_type, upc_ean)
    VALUES ('upc_199999603313', 'SWEETs', 'single', '199999603313')
  `).run();

  const csv = makeCsv([
    { releaseTitle: 'SWEETs', trackTitle: 'SWEETs', upc: '199999603313', isrc: 'QZPJ32544083' },
  ]);
  const result = buildCatalog(db, csv);
  assert.equal(result.releasesSkipped,  1);
  assert.equal(result.releasesInserted, 0);
  const count = db.prepare("SELECT COUNT(*) as c FROM sf_releases WHERE upc_ean='199999603313'").get().c;
  assert.equal(count, 1, '重複して sf_releases が登録された');
});

// ─── 5. sf_release_tracks / sf_distributions ──────────────────────────────

console.log('\n▶ sf_release_tracks / sf_distributions');

test('sf_release_tracks にリリースと楽曲のリンクが登録される', () => {
  const db = createDb(':memory:');
  seed(db);
  const csv = makeCsv([
    { releaseTitle: 'SWEETs', trackTitle: 'SWEETs', upc: '199999603313', isrc: 'QZPJ32544083' },
  ]);
  buildCatalog(db, csv);

  const track   = db.prepare("SELECT id FROM sf_tracks WHERE isrc='QZPJ32544083'").get();
  const release = db.prepare("SELECT id FROM sf_releases WHERE upc_ean='199999603313'").get();
  const link    = db.prepare(
    "SELECT 1 FROM sf_release_tracks WHERE track_id=? AND release_id=?"
  ).get(track.id, release.id);
  assert.ok(link, 'sf_release_tracks にリンクが登録されていない');
});

test('sf_distributions に soundrop エントリが登録される', () => {
  const db = createDb(':memory:');
  seed(db);
  const csv = makeCsv([
    { releaseTitle: '置いた音', trackTitle: '置いた音', upc: '199999610892', isrc: 'QZPJ32545428' },
  ]);
  buildCatalog(db, csv);

  const release = db.prepare("SELECT id FROM sf_releases WHERE upc_ean='199999610892'").get();
  const dist = db.prepare(
    "SELECT distribution_status FROM sf_distributions WHERE release_id=? AND distributor='soundrop'"
  ).get(release.id);
  assert.equal(dist?.distribution_status, 'distributed');
});

// ─── 6. 冪等性 ───────────────────────────────────────────────────────────────

console.log('\n▶ 冪等性（同一CSV 2回実行）');

test('sf_tracks が重複しない', () => {
  const db = createDb(':memory:');
  seed(db);
  const csv = makeCsv([
    { releaseTitle: 'Round Bounce', trackTitle: 'Round Bounce', upc: '199999597629', isrc: 'QZPJ32543034' },
  ]);
  buildCatalog(db, csv);
  buildCatalog(db, csv);
  const count = db.prepare("SELECT COUNT(*) as c FROM sf_tracks WHERE isrc='QZPJ32543034'").get().c;
  assert.equal(count, 1, `sf_tracks に重複が発生した (count=${count})`);
});

test('sf_releases が重複しない', () => {
  const db = createDb(':memory:');
  seed(db);
  const csv = makeCsv([
    { releaseTitle: 'SWEETs', trackTitle: 'SWEETs', upc: '199999603313', isrc: 'QZPJ32544083' },
  ]);
  buildCatalog(db, csv);
  buildCatalog(db, csv);
  const count = db.prepare("SELECT COUNT(*) as c FROM sf_releases WHERE upc_ean='199999603313'").get().c;
  assert.equal(count, 1, `sf_releases に重複が発生した (count=${count})`);
});

test('sf_release_tracks が重複しない', () => {
  const db = createDb(':memory:');
  seed(db);
  const csv = makeCsv([
    { releaseTitle: 'SWEETs', trackTitle: 'SWEETs', upc: '199999603313', isrc: 'QZPJ32544083' },
  ]);
  buildCatalog(db, csv);
  buildCatalog(db, csv);
  const track   = db.prepare("SELECT id FROM sf_tracks WHERE isrc='QZPJ32544083'").get();
  const release = db.prepare("SELECT id FROM sf_releases WHERE upc_ean='199999603313'").get();
  const count   = db.prepare(
    "SELECT COUNT(*) as c FROM sf_release_tracks WHERE track_id=? AND release_id=?"
  ).get(track.id, release.id).c;
  assert.equal(count, 1, `sf_release_tracks に重複が発生した (count=${count})`);
});

test('sf_distributions が重複しない', () => {
  const db = createDb(':memory:');
  seed(db);
  const csv = makeCsv([
    { releaseTitle: 'SWEETs', trackTitle: 'SWEETs', upc: '199999603313', isrc: 'QZPJ32544083' },
  ]);
  buildCatalog(db, csv);
  buildCatalog(db, csv);
  const release = db.prepare("SELECT id FROM sf_releases WHERE upc_ean='199999603313'").get();
  const count   = db.prepare(
    "SELECT COUNT(*) as c FROM sf_distributions WHERE release_id=? AND distributor='soundrop'"
  ).get(release.id).c;
  assert.equal(count, 1, `sf_distributions に重複が発生した (count=${count})`);
});

// ─── 7. 統合テスト: 3か月分相当 ──────────────────────────────────────────────

console.log('\n▶ 統合テスト: 3か月分相当（9曲 / 4リリース）');

const intDb = createDb(':memory:');
seed(intDb);

const intResult = buildCatalog(intDb, INTEGRATION_CSV, { releaseTypes: RELEASE_TYPES });

test('tracksUpdatedByTitle = 3（Little Snow / SWEETs / 置いた音）', () => {
  assert.equal(intResult.tracksUpdatedByTitle, 3,
    `tracksUpdatedByTitle=${intResult.tracksUpdatedByTitle}`);
});

test('tracksInserted = 6（Round Bounce + Early Snow 5曲）', () => {
  assert.equal(intResult.tracksInserted, 6,
    `tracksInserted=${intResult.tracksInserted}`);
});

test('tracksUpdatedByIsrc = 0（初回実行時はISRC設定済みtrackなし）', () => {
  assert.equal(intResult.tracksUpdatedByIsrc, 0,
    `tracksUpdatedByIsrc=${intResult.tracksUpdatedByIsrc}`);
});

test('releasesInserted = 4', () => {
  assert.equal(intResult.releasesInserted, 4,
    `releasesInserted=${intResult.releasesInserted}`);
});

test('releaseTracksLinked = 9', () => {
  assert.equal(intResult.releaseTracksLinked, 9,
    `releaseTracksLinked=${intResult.releaseTracksLinked}`);
});

test('distributionsLinked = 4', () => {
  assert.equal(intResult.distributionsLinked, 4,
    `distributionsLinked=${intResult.distributionsLinked}`);
});

test('needs_review = 0件', () => {
  assert.equal(intResult.tracksNeedsReview.length, 0,
    `tracksNeedsReview=${JSON.stringify(intResult.tracksNeedsReview)}`);
});

test('Little Snow の track_key が "little_snow" のまま維持される', () => {
  const track = intDb.prepare("SELECT track_key FROM sf_tracks WHERE isrc='QZPJ32548359'").get();
  assert.equal(track?.track_key, 'little_snow',
    `track_key=${track?.track_key}`);
});

test('SWEETs の track_key が "sweets_track" のまま維持される', () => {
  const track = intDb.prepare("SELECT track_key FROM sf_tracks WHERE isrc='QZPJ32544083'").get();
  assert.equal(track?.track_key, 'sweets_track',
    `track_key=${track?.track_key}`);
});

test('置いた音 の track_key が "oita_oto" のまま維持される', () => {
  const track = intDb.prepare("SELECT track_key FROM sf_tracks WHERE isrc='QZPJ32545428'").get();
  assert.equal(track?.track_key, 'oita_oto',
    `track_key=${track?.track_key}`);
});

test('Little Snow の isrc が QZPJ32548359 に設定された', () => {
  const track = intDb.prepare("SELECT isrc FROM sf_tracks WHERE track_key='little_snow'").get();
  assert.equal(track?.isrc, 'QZPJ32548359');
});

test('Early Snow が ep として登録された', () => {
  const rel = intDb.prepare("SELECT release_type FROM sf_releases WHERE upc_ean='199999625681'").get();
  assert.equal(rel?.release_type, 'ep');
});

test('sf_tracks 総数 = 18（seed 12 + 新規 6）', () => {
  const count = intDb.prepare("SELECT COUNT(*) as c FROM sf_tracks").get().c;
  assert.equal(count, 18, `sf_tracks 総数=${count}`);
});

test('Still の track_key が "isrc_qzpj32548357"（末尾スペースtrim済み）', () => {
  const track = intDb.prepare("SELECT track_key, title FROM sf_tracks WHERE isrc='QZPJ32548357'").get();
  assert.equal(track?.track_key, 'isrc_qzpj32548357');
  assert.equal(track?.title,     'Still');  // trim後
});

// ─── 8. 再実行: 冪等性（統合DB）────────────────────────────────────────────

console.log('\n▶ 統合テスト: 再実行で重複なし');

const intResult2 = buildCatalog(intDb, INTEGRATION_CSV, { releaseTypes: RELEASE_TYPES });

test('再実行: tracksUpdatedByIsrc = 9（全曲がISRCで一致）', () => {
  assert.equal(intResult2.tracksUpdatedByIsrc, 9,
    `tracksUpdatedByIsrc=${intResult2.tracksUpdatedByIsrc}`);
});

test('再実行: tracksInserted = 0', () => {
  assert.equal(intResult2.tracksInserted, 0,
    `tracksInserted=${intResult2.tracksInserted}`);
});

test('再実行: releasesInserted = 0（全リリースが既存スキップ）', () => {
  assert.equal(intResult2.releasesInserted, 0,
    `releasesInserted=${intResult2.releasesInserted}`);
});

test('再実行: releaseTracksLinked = 0（重複登録なし）', () => {
  assert.equal(intResult2.releaseTracksLinked, 0,
    `releaseTracksLinked=${intResult2.releaseTracksLinked}`);
});

test('再実行: distributionsLinked = 0（重複登録なし）', () => {
  assert.equal(intResult2.distributionsLinked, 0,
    `distributionsLinked=${intResult2.distributionsLinked}`);
});

// ─── 9. ISRC一致時のタイトル保護（override なし ISRC）────────────────────────
// ISRC_TITLE_OVERRIDES に登録されていない ISRC については、
// ユーザーが手動修正したタイトルが Statement の Track Title で上書きされないことを保証する。
// Round Bounce（QZPJ32543034）= override 未設定の ISRC を使用。

console.log('\n▶ ISRC一致時のタイトル保護（override なし ISRC）');

test('ISRC一致時（override なし）: 手動修正済みタイトルがStatementのタイトルで上書きされない', () => {
  const db = createDb(':memory:');
  seed(db);

  // Step1: catalog_builderで初回取込 → "Round Bounce" として登録
  const csv1 = makeCsv([
    { releaseTitle: 'Round Bounce', trackTitle: 'Round Bounce', upc: '199999597629', isrc: 'QZPJ32543034' },
  ]);
  buildCatalog(db, csv1);

  // Step2: ユーザーが手動でタイトルを修正
  db.prepare("UPDATE sf_tracks SET title='Round Bounce (Edit)' WHERE isrc='QZPJ32543034'").run();
  const afterManual = db.prepare("SELECT title FROM sf_tracks WHERE isrc='QZPJ32543034'").get();
  assert.equal(afterManual.title, 'Round Bounce (Edit)', '手動修正が反映されていない');

  // Step3: 同じISRCを含むStatementを再取込（Track Title = 'Round Bounce'）
  const csv2 = makeCsv([
    { releaseTitle: 'Round Bounce', trackTitle: 'Round Bounce', upc: '199999597629', isrc: 'QZPJ32543034' },
  ]);
  buildCatalog(db, csv2);

  // override なし → status のみ更新、タイトルは保護される
  const afterReimport = db.prepare("SELECT title FROM sf_tracks WHERE isrc='QZPJ32543034'").get();
  assert.equal(afterReimport.title, 'Round Bounce (Edit)',
    `タイトルが上書きされた: "${afterReimport.title}"`);
});

test('ISRC一致時（override なし）: status は released に更新される（タイトルとは独立）', () => {
  const db = createDb(':memory:');
  seed(db);

  // 初回取込
  const csv = makeCsv([
    { releaseTitle: 'Round Bounce', trackTitle: 'Round Bounce', upc: '199999597629', isrc: 'QZPJ32543034' },
  ]);
  buildCatalog(db, csv);

  // 手動タイトル修正 + status を別値にリセット
  db.prepare("UPDATE sf_tracks SET title='Round Bounce (Edit)', status='unknown' WHERE isrc='QZPJ32543034'").run();

  // 再取込
  buildCatalog(db, csv);

  const track = db.prepare("SELECT title, status FROM sf_tracks WHERE isrc='QZPJ32543034'").get();
  assert.equal(track.title,  'Round Bounce (Edit)', 'override なしなのにタイトルが上書きされた');
  assert.equal(track.status, 'released',            'statusが更新されなかった');
});

// ─── 10. ISRC_TITLE_OVERRIDES ────────────────────────────────────────────────
// ISRC_TITLE_OVERRIDES に登録された ISRC は INSERT / ISRC一致 UPDATE の
// いずれのパスでも補正タイトルが優先される。
// 空DB から再構築しても正式タイトルが自動的に適用される。

console.log('\n▶ ISRC_TITLE_OVERRIDES');

test('ISRC_TITLE_OVERRIDES に QZPJ32548359 が定義されている', () => {
  assert.equal(ISRC_TITLE_OVERRIDES['QZPJ32548359'], 'Little Snow (Raw)',
    'ISRC_TITLE_OVERRIDES の定義が正しくない');
});

test('空DB + CSV（QZPJ32548359, title="Little Snow"）→ INSERT 時に "Little Snow (Raw)" になる', () => {
  // sf_seed.js を使わない完全な空DB
  const db = createDb(':memory:');

  const csv = makeCsv([
    { releaseTitle: 'Early Snow', trackTitle: 'Little Snow', upc: '199999625681', isrc: 'QZPJ32548359' },
  ]);
  const result = buildCatalog(db, csv, { releaseTypes: { '199999625681': 'ep' } });

  assert.equal(result.tracksInserted, 1, 'tracksInserted が 1 でない');
  const track = db.prepare("SELECT title FROM sf_tracks WHERE isrc='QZPJ32548359'").get();
  assert.equal(track?.title, 'Little Snow (Raw)',
    `INSERT 時のタイトルが誤り: "${track?.title}"`);
});

test('ISRC一致時（override あり）: re-import で "Little Snow (Raw)" に補正される', () => {
  const db = createDb(':memory:');

  // DB に title='Little Snow' で直接 INSERT（Soundrop CSV 取込前の状態を模擬）
  db.prepare(
    "INSERT INTO sf_tracks (track_key, title, isrc) VALUES ('isrc_qzpj32548359', 'Little Snow', 'QZPJ32548359')"
  ).run();

  const csv = makeCsv([
    { releaseTitle: 'Early Snow', trackTitle: 'Little Snow', upc: '199999625681', isrc: 'QZPJ32548359' },
  ]);
  const result = buildCatalog(db, csv, { releaseTypes: { '199999625681': 'ep' } });

  assert.equal(result.tracksUpdatedByIsrc, 1, 'tracksUpdatedByIsrc が 1 でない');
  const track = db.prepare("SELECT title FROM sf_tracks WHERE isrc='QZPJ32548359'").get();
  assert.equal(track?.title, 'Little Snow (Raw)',
    `ISRC一致時の補正タイトルが誤り: "${track?.title}"`);
});

test('QZPJ32548356（override 未設定）: "Little Snow (Near)" のまま登録される', () => {
  const db = createDb(':memory:');

  const csv = makeCsv([
    { releaseTitle: 'Early Snow', trackTitle: 'Little Snow (Near)', upc: '199999625681', isrc: 'QZPJ32548356' },
  ]);
  buildCatalog(db, csv, { releaseTypes: { '199999625681': 'ep' } });

  const track = db.prepare("SELECT title FROM sf_tracks WHERE isrc='QZPJ32548356'").get();
  assert.equal(track?.title, 'Little Snow (Near)',
    `override 未設定なのにタイトルが変わった: "${track?.title}"`);
});

test('QZPJ32548356 ISRC一致時: 既存タイトルがそのまま保護される', () => {
  const db = createDb(':memory:');

  // DB に "Little Snow (Near)" で登録済み
  db.prepare(
    "INSERT INTO sf_tracks (track_key, title, isrc) VALUES ('isrc_qzpj32548356', 'Little Snow (Near)', 'QZPJ32548356')"
  ).run();

  const csv = makeCsv([
    { releaseTitle: 'Early Snow', trackTitle: 'Little Snow (Near)', upc: '199999625681', isrc: 'QZPJ32548356' },
  ]);
  buildCatalog(db, csv, { releaseTypes: { '199999625681': 'ep' } });

  const track = db.prepare("SELECT title FROM sf_tracks WHERE isrc='QZPJ32548356'").get();
  assert.equal(track?.title, 'Little Snow (Near)',
    `override 未設定なのにタイトルが変わった: "${track?.title}"`);
});

// ─── 結果サマリー ─────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`  結果: ${passed} passed / ${failed} failed`);
if (failed > 0) {
  console.error('  ❌ テスト失敗あり');
  process.exit(1);
}
console.log('  ✅ 全テスト通過');
