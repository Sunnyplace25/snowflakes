/**
 * jarvis/tests/test_sf_schema_15.js
 * Snow flakes Analytics Phase 1.5 — スキーマ・テスト
 *
 * 検証内容:
 *   - 全27テーブルの存在確認（Phase 1: 14 + Phase 1.5: 13）
 *   - sf_tracks の新カラム確認（status DEFAULT 'unknown'、isrc 等）
 *   - sf_track_files UNIQUE(track_id, file_type, file_path)
 *   - sf_track_lyrics UNIQUE(track_id, language, version)
 *   - sf_releases UNIQUE(release_key)
 *   - sf_credits CHECK制約（track_id か release_id のどちらか必須）
 *   - sf_distributions UNIQUE(release_id, distributor)
 *   - sf_artist_profiles UNIQUE(artist_key, platform)
 *   - sf_track_releases UNIQUE(track_id, platform)
 *   - sf_release_platforms UNIQUE(release_id, platform)
 *   - sf_track_previews analytics_key UNIQUE
 *   - トラック status='unreleased' + preview status='published' の共存テスト
 *   - FOREIGN KEY 制約
 *   - CHECK 制約の拒否テスト
 *   - Phase 1 seed 回帰テスト
 *
 * 重要: ':memory:' DBのみ使用。business_data.db には触れない。
 */

import assert from 'node:assert/strict';
import { createDb } from '../data/db.js';
import { seed }     from '../data/sf_seed.js';

// ─── セットアップ ─────────────────────────────────────────────────────────────

const db = createDb(':memory:');
seed(db);

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

function throws(fn, msgPattern) {
  try {
    fn();
    throw new Error('例外が発生しなかった');
  } catch (e) {
    if (msgPattern && !msgPattern.test(e.message)) {
      throw new Error(`期待した例外パターン (${msgPattern}) と不一致: ${e.message}`);
    }
  }
}

// ─── 1. 全テーブル存在確認（27テーブル）─────────────────────────────────────

console.log('\n▶ テーブル存在確認（27テーブル）');

const EXPECTED_TABLES = [
  // Phase 1: 14テーブル
  'work_records', 'daily_status',
  'sf_works', 'sf_tracks', 'sf_track_work_links',
  'sf_revenue', 'sf_ga_daily', 'sf_narou_snapshot',
  'sf_music_metrics',
  'sf_content_registry', 'sf_social_metrics', 'sf_platform_ext',
  'sf_account_daily', 'sf_funnel_event',
  // Phase 1.5: 13テーブル
  'sf_track_files', 'sf_track_lyrics', 'sf_releases', 'sf_release_tracks',
  'sf_release_artworks', 'sf_credits', 'sf_distributions',
  'sf_distribution_imports', 'sf_distribution_import_rows',
  'sf_artist_profiles', 'sf_track_releases', 'sf_release_platforms',
  'sf_track_previews',
];

const existingTables = db
  .prepare("SELECT name FROM sqlite_master WHERE type='table'")
  .all()
  .map(r => r.name);

for (const t of EXPECTED_TABLES) {
  test(`テーブル "${t}" が存在する`, () => {
    assert.ok(existingTables.includes(t), `テーブル ${t} が存在しない`);
  });
}

// ─── 2. sf_tracks 新カラム確認 ───────────────────────────────────────────────

console.log('\n▶ sf_tracks Phase 1.5 新カラム確認');

test('sf_tracks.status カラムが存在し DEFAULT は unknown', () => {
  const track = db.prepare("SELECT id FROM sf_tracks WHERE track_key='signal'").get();
  const row = db.prepare('SELECT status FROM sf_tracks WHERE id=?').get(track.id);
  // status カラムが存在することを確認（値は unknown または NULL でない）
  assert.ok('status' in row, 'status カラムが存在しない');
  // seed で挿入されたトラックはデフォルト unknown
  assert.equal(row.status, 'unknown', `status の DEFAULT が 'unknown' でない: ${row.status}`);
});

test('sf_tracks.isrc カラムが存在し NULL 許容', () => {
  const tid = db.prepare("SELECT id FROM sf_tracks WHERE track_key='signal'").get().id;
  db.prepare('UPDATE sf_tracks SET isrc=? WHERE id=?').run('JPXX12345678', tid);
  const row = db.prepare('SELECT isrc FROM sf_tracks WHERE id=?').get(tid);
  assert.equal(row.isrc, 'JPXX12345678');
  db.prepare('UPDATE sf_tracks SET isrc=NULL WHERE id=?').run(tid);
});

test('sf_tracks.created_date カラムが存在する', () => {
  const tid = db.prepare("SELECT id FROM sf_tracks WHERE track_key='signal'").get().id;
  db.prepare('UPDATE sf_tracks SET created_date=? WHERE id=?').run('2024-01-01', tid);
  const row = db.prepare('SELECT created_date FROM sf_tracks WHERE id=?').get(tid);
  assert.equal(row.created_date, '2024-01-01');
  db.prepare('UPDATE sf_tracks SET created_date=NULL WHERE id=?').run(tid);
});

test('sf_tracks.duration_sec カラムが存在する', () => {
  const tid = db.prepare("SELECT id FROM sf_tracks WHERE track_key='signal'").get().id;
  db.prepare('UPDATE sf_tracks SET duration_sec=? WHERE id=?').run(210, tid);
  const row = db.prepare('SELECT duration_sec FROM sf_tracks WHERE id=?').get(tid);
  assert.equal(row.duration_sec, 210);
  db.prepare('UPDATE sf_tracks SET duration_sec=NULL WHERE id=?').run(tid);
});

test('sf_tracks.source_service カラムが存在する', () => {
  const tid = db.prepare("SELECT id FROM sf_tracks WHERE track_key='signal'").get().id;
  db.prepare('UPDATE sf_tracks SET source_service=? WHERE id=?').run('suno', tid);
  const row = db.prepare('SELECT source_service FROM sf_tracks WHERE id=?').get(tid);
  assert.equal(row.source_service, 'suno');
  db.prepare('UPDATE sf_tracks SET source_service=NULL WHERE id=?').run(tid);
});

test('sf_tracks.status CHECK 制約が不正値を拒否する', () => {
  throws(
    () => db.prepare("INSERT INTO sf_tracks (track_key, title, status) VALUES ('bad_status_test', 'T', 'invalid_status')").run(),
    /CHECK|check/i
  );
});

test('sf_tracks.source_service CHECK 制約が不正値を拒否する', () => {
  throws(
    () => db.prepare("INSERT INTO sf_tracks (track_key, title, source_service) VALUES ('bad_src_test', 'T', 'invalid_service')").run(),
    /CHECK|check/i
  );
});

// ─── 3. sf_track_files ───────────────────────────────────────────────────────

console.log('\n▶ sf_track_files');

test('UNIQUE(track_id, file_type, file_path) が働く', () => {
  const tid = db.prepare("SELECT id FROM sf_tracks WHERE track_key='signal'").get().id;
  db.prepare(`
    INSERT INTO sf_track_files (track_id, file_type, file_path)
    VALUES (?, 'master_wav', '/audio/signal.wav')
  `).run(tid);
  throws(
    () => db.prepare(`
      INSERT INTO sf_track_files (track_id, file_type, file_path)
      VALUES (?, 'master_wav', '/audio/signal.wav')
    `).run(tid),
    /UNIQUE|unique/i
  );
  db.prepare('DELETE FROM sf_track_files WHERE track_id=?').run(tid);
});

test('file_type CHECK 制約が不正値を拒否する', () => {
  const tid = db.prepare("SELECT id FROM sf_tracks WHERE track_key='signal'").get().id;
  throws(
    () => db.prepare(`
      INSERT INTO sf_track_files (track_id, file_type, file_path)
      VALUES (?, 'invalid_type', '/audio/signal.wav')
    `).run(tid),
    /CHECK|check/i
  );
});

test('track_id FK 制約が働く', () => {
  throws(
    () => db.prepare(`
      INSERT INTO sf_track_files (track_id, file_type, file_path)
      VALUES (99999, 'master_wav', '/audio/x.wav')
    `).run(),
    /FOREIGN KEY|foreign key/i
  );
});

// ─── 4. sf_track_lyrics ──────────────────────────────────────────────────────

console.log('\n▶ sf_track_lyrics');

test('UNIQUE(track_id, language, version) が働く', () => {
  const tid = db.prepare("SELECT id FROM sf_tracks WHERE track_key='signal'").get().id;
  db.prepare(`
    INSERT INTO sf_track_lyrics (track_id, lyrics_text)
    VALUES (?, '歌詞テスト')
  `).run(tid);
  throws(
    () => db.prepare(`
      INSERT INTO sf_track_lyrics (track_id, language, version, lyrics_text)
      VALUES (?, 'ja', 'v1', '重複歌詞')
    `).run(tid),
    /UNIQUE|unique/i
  );
  db.prepare('DELETE FROM sf_track_lyrics WHERE track_id=?').run(tid);
});

test('status CHECK 制約が不正値を拒否する', () => {
  const tid = db.prepare("SELECT id FROM sf_tracks WHERE track_key='signal'").get().id;
  throws(
    () => db.prepare(`
      INSERT INTO sf_track_lyrics (track_id, lyrics_text, status)
      VALUES (?, '歌詞', 'published')
    `).run(tid),
    /CHECK|check/i
  );
});

// ─── 5. sf_releases ──────────────────────────────────────────────────────────

console.log('\n▶ sf_releases');

test('UNIQUE(release_key) が働く', () => {
  db.prepare(`
    INSERT INTO sf_releases (release_key, title, release_type)
    VALUES ('signal_single', 'Signal Single', 'single')
  `).run();
  throws(
    () => db.prepare(`
      INSERT INTO sf_releases (release_key, title, release_type)
      VALUES ('signal_single', '重複', 'single')
    `).run(),
    /UNIQUE|unique/i
  );
  db.prepare("DELETE FROM sf_releases WHERE release_key='signal_single'").run();
});

test('release_type CHECK 制約が不正値を拒否する', () => {
  throws(
    () => db.prepare(`
      INSERT INTO sf_releases (release_key, title, release_type)
      VALUES ('bad_type_test', 'T', 'mixtape')
    `).run(),
    /CHECK|check/i
  );
});

test('status CHECK 制約が不正値を拒否する', () => {
  throws(
    () => db.prepare(`
      INSERT INTO sf_releases (release_key, title, release_type, status)
      VALUES ('bad_status2_test', 'T', 'single', 'unknown')
    `).run(),
    /CHECK|check/i
  );
});

// ─── 6. sf_release_tracks ────────────────────────────────────────────────────

console.log('\n▶ sf_release_tracks');

test('PRIMARY KEY(release_id, track_id) 重複は拒否される', () => {
  db.prepare(`
    INSERT INTO sf_releases (release_key, title, release_type)
    VALUES ('rt_test_release', 'RT Test', 'single')
  `).run();
  const rid = db.prepare("SELECT id FROM sf_releases WHERE release_key='rt_test_release'").get().id;
  const tid = db.prepare("SELECT id FROM sf_tracks WHERE track_key='signal'").get().id;

  db.prepare('INSERT INTO sf_release_tracks (release_id, track_id, track_number) VALUES (?,?,?)').run(rid, tid, 1);
  throws(
    () => db.prepare('INSERT INTO sf_release_tracks (release_id, track_id, track_number) VALUES (?,?,?)').run(rid, tid, 2),
    /UNIQUE|unique/i
  );
  db.prepare('DELETE FROM sf_release_tracks WHERE release_id=?').run(rid);
  db.prepare("DELETE FROM sf_releases WHERE release_key='rt_test_release'").run();
});

// ─── 7. sf_credits ───────────────────────────────────────────────────────────

console.log('\n▶ sf_credits');

test('track_id も release_id も NULL の場合は拒否される', () => {
  throws(
    () => db.prepare(`
      INSERT INTO sf_credits (role, name) VALUES ('vocal', 'テスト')
    `).run(),
    /CHECK|check/i
  );
});

test('track_id のみで挿入できる', () => {
  const tid = db.prepare("SELECT id FROM sf_tracks WHERE track_key='signal'").get().id;
  db.prepare(`
    INSERT INTO sf_credits (track_id, role, name) VALUES (?, 'vocal', 'ことり')
  `).run(tid);
  db.prepare('DELETE FROM sf_credits WHERE track_id=?').run(tid);
});

test('release_id のみで挿入できる', () => {
  db.prepare(`
    INSERT INTO sf_releases (release_key, title, release_type)
    VALUES ('credits_test_release', 'Credits Test', 'single')
  `).run();
  const rid = db.prepare("SELECT id FROM sf_releases WHERE release_key='credits_test_release'").get().id;
  db.prepare(`
    INSERT INTO sf_credits (release_id, role, name) VALUES (?, 'artwork', 'デザイナー')
  `).run(rid);
  db.prepare('DELETE FROM sf_credits WHERE release_id=?').run(rid);
  db.prepare("DELETE FROM sf_releases WHERE release_key='credits_test_release'").run();
});

test('role CHECK 制約が不正値を拒否する', () => {
  const tid = db.prepare("SELECT id FROM sf_tracks WHERE track_key='signal'").get().id;
  throws(
    () => db.prepare(`
      INSERT INTO sf_credits (track_id, role, name) VALUES (?, 'producer', 'テスト')
    `).run(tid),
    /CHECK|check/i
  );
});

// ─── 8. sf_distributions ─────────────────────────────────────────────────────

console.log('\n▶ sf_distributions');

test('UNIQUE(release_id, distributor) が働く', () => {
  db.prepare(`
    INSERT INTO sf_releases (release_key, title, release_type)
    VALUES ('dist_test_release', 'Dist Test', 'single')
  `).run();
  const rid = db.prepare("SELECT id FROM sf_releases WHERE release_key='dist_test_release'").get().id;

  db.prepare(`
    INSERT INTO sf_distributions (release_id, distributor) VALUES (?, 'soundrop')
  `).run(rid);
  throws(
    () => db.prepare(`
      INSERT INTO sf_distributions (release_id, distributor) VALUES (?, 'soundrop')
    `).run(rid),
    /UNIQUE|unique/i
  );
  db.prepare('DELETE FROM sf_distributions WHERE release_id=?').run(rid);
  db.prepare("DELETE FROM sf_releases WHERE release_key='dist_test_release'").run();
});

test('distribution_status CHECK 制約が不正値を拒否する', () => {
  db.prepare(`
    INSERT INTO sf_releases (release_key, title, release_type)
    VALUES ('dist_chk_release', 'Dist Chk', 'single')
  `).run();
  const rid = db.prepare("SELECT id FROM sf_releases WHERE release_key='dist_chk_release'").get().id;
  throws(
    () => db.prepare(`
      INSERT INTO sf_distributions (release_id, distribution_status) VALUES (?, 'unknown_status')
    `).run(rid),
    /CHECK|check/i
  );
  db.prepare("DELETE FROM sf_releases WHERE release_key='dist_chk_release'").run();
});

// ─── 9. sf_distribution_imports / sf_distribution_import_rows ────────────────

console.log('\n▶ sf_distribution_imports / sf_distribution_import_rows');

test('sf_distribution_imports に INSERT できる', () => {
  db.prepare(`
    INSERT INTO sf_distribution_imports (distributor, source_type, file_name, row_count)
    VALUES ('soundrop', 'csv', 'test.csv', 100)
  `).run();
  const row = db.prepare("SELECT * FROM sf_distribution_imports WHERE file_name='test.csv'").get();
  assert.equal(row.row_count, 100);
  db.prepare("DELETE FROM sf_distribution_imports WHERE file_name='test.csv'").run();
});

test('sf_distribution_import_rows FK 制約が働く', () => {
  throws(
    () => db.prepare(`
      INSERT INTO sf_distribution_import_rows (import_id, row_index)
      VALUES (99999, 0)
    `).run(),
    /FOREIGN KEY|foreign key/i
  );
});

test('match_method CHECK 制約が不正値を拒否する', () => {
  db.prepare(`
    INSERT INTO sf_distribution_imports (distributor, row_count)
    VALUES ('soundrop', 1)
  `).run();
  const importId = db.prepare("SELECT id FROM sf_distribution_imports ORDER BY id DESC LIMIT 1").get().id;
  throws(
    () => db.prepare(`
      INSERT INTO sf_distribution_import_rows (import_id, row_index, match_method)
      VALUES (?, 0, 'invalid_method')
    `).run(importId),
    /CHECK|check/i
  );
  db.prepare('DELETE FROM sf_distribution_imports WHERE id=?').run(importId);
});

// ─── 10. sf_artist_profiles ──────────────────────────────────────────────────

console.log('\n▶ sf_artist_profiles');

test('UNIQUE(artist_key, platform) が働く', () => {
  db.prepare(`
    INSERT INTO sf_artist_profiles (artist_key, artist_name, platform)
    VALUES ('snow_flakes', 'Snow flakes', 'spotify')
  `).run();
  throws(
    () => db.prepare(`
      INSERT INTO sf_artist_profiles (artist_key, artist_name, platform)
      VALUES ('snow_flakes', 'Snow flakes 2', 'spotify')
    `).run(),
    /UNIQUE|unique/i
  );
  db.prepare("DELETE FROM sf_artist_profiles WHERE artist_key='snow_flakes'").run();
});

test('platform CHECK 制約が不正値を拒否する', () => {
  throws(
    () => db.prepare(`
      INSERT INTO sf_artist_profiles (artist_key, artist_name, platform)
      VALUES ('snow_flakes_bad', 'Snow flakes', 'soundcloud')
    `).run(),
    /CHECK|check/i
  );
});

test('profile_status CHECK 制約が不正値を拒否する', () => {
  throws(
    () => db.prepare(`
      INSERT INTO sf_artist_profiles (artist_key, artist_name, platform, profile_status)
      VALUES ('snow_flakes_ps', 'Snow flakes', 'spotify', 'verified')
    `).run(),
    /CHECK|check/i
  );
});

// ─── 11. sf_track_releases ───────────────────────────────────────────────────

console.log('\n▶ sf_track_releases');

test('UNIQUE(track_id, platform) が働く', () => {
  const tid = db.prepare("SELECT id FROM sf_tracks WHERE track_key='signal'").get().id;
  db.prepare(`
    INSERT INTO sf_track_releases (track_id, platform) VALUES (?, 'spotify')
  `).run(tid);
  throws(
    () => db.prepare(`
      INSERT INTO sf_track_releases (track_id, platform) VALUES (?, 'spotify')
    `).run(tid),
    /UNIQUE|unique/i
  );
  db.prepare('DELETE FROM sf_track_releases WHERE track_id=?').run(tid);
});

test('platform CHECK 制約が不正値を拒否する', () => {
  const tid = db.prepare("SELECT id FROM sf_tracks WHERE track_key='signal'").get().id;
  throws(
    () => db.prepare(`
      INSERT INTO sf_track_releases (track_id, platform) VALUES (?, 'soundcloud')
    `).run(tid),
    /CHECK|check/i
  );
});

test('release_status CHECK 制約が不正値を拒否する', () => {
  const tid = db.prepare("SELECT id FROM sf_tracks WHERE track_key='signal'").get().id;
  throws(
    () => db.prepare(`
      INSERT INTO sf_track_releases (track_id, platform, release_status) VALUES (?, 'spotify', 'deleted')
    `).run(tid),
    /CHECK|check/i
  );
});

// ─── 12. sf_release_platforms ────────────────────────────────────────────────

console.log('\n▶ sf_release_platforms');

test('UNIQUE(release_id, platform) が働く', () => {
  db.prepare(`
    INSERT INTO sf_releases (release_key, title, release_type)
    VALUES ('rp_test_release', 'RP Test', 'single')
  `).run();
  const rid = db.prepare("SELECT id FROM sf_releases WHERE release_key='rp_test_release'").get().id;

  db.prepare(`
    INSERT INTO sf_release_platforms (release_id, platform) VALUES (?, 'spotify')
  `).run(rid);
  throws(
    () => db.prepare(`
      INSERT INTO sf_release_platforms (release_id, platform) VALUES (?, 'spotify')
    `).run(rid),
    /UNIQUE|unique/i
  );
  db.prepare('DELETE FROM sf_release_platforms WHERE release_id=?').run(rid);
  db.prepare("DELETE FROM sf_releases WHERE release_key='rp_test_release'").run();
});

// ─── 13. sf_track_previews ───────────────────────────────────────────────────

console.log('\n▶ sf_track_previews');

test('analytics_key UNIQUE が働く', () => {
  const tid = db.prepare("SELECT id FROM sf_tracks WHERE track_key='signal'").get().id;
  db.prepare(`
    INSERT INTO sf_track_previews (track_id, preview_type, analytics_key)
    VALUES (?, 'demo', 'preview_signal_001')
  `).run(tid);
  throws(
    () => db.prepare(`
      INSERT INTO sf_track_previews (track_id, preview_type, analytics_key)
      VALUES (?, 'short', 'preview_signal_001')
    `).run(tid),
    /UNIQUE|unique/i
  );
  db.prepare('DELETE FROM sf_track_previews WHERE track_id=?').run(tid);
});

test('preview_type CHECK 制約が不正値を拒否する', () => {
  const tid = db.prepare("SELECT id FROM sf_tracks WHERE track_key='signal'").get().id;
  throws(
    () => db.prepare(`
      INSERT INTO sf_track_previews (track_id, preview_type) VALUES (?, 'clip')
    `).run(tid),
    /CHECK|check/i
  );
});

test('status CHECK 制約が不正値を拒否する', () => {
  const tid = db.prepare("SELECT id FROM sf_tracks WHERE track_key='signal'").get().id;
  throws(
    () => db.prepare(`
      INSERT INTO sf_track_previews (track_id, preview_type, status) VALUES (?, 'demo', 'live')
    `).run(tid),
    /CHECK|check/i
  );
});

test('platform CHECK 制約が不正値を拒否する', () => {
  const tid = db.prepare("SELECT id FROM sf_tracks WHERE track_key='signal'").get().id;
  throws(
    () => db.prepare(`
      INSERT INTO sf_track_previews (track_id, preview_type, platform) VALUES (?, 'demo', 'youtube')
    `).run(tid),
    /CHECK|check/i
  );
});

// ─── 14. 独立性テスト: track status='unreleased' + preview status='published' ─

console.log('\n▶ 独立性テスト: track status + preview status');

test('status=unreleased の楽曲に preview status=published を設定できる', () => {
  // 楽曲を unreleased に設定
  const tid = db.prepare("SELECT id FROM sf_tracks WHERE track_key='rabbit'").get().id;
  db.prepare("UPDATE sf_tracks SET status='unreleased' WHERE id=?").run(tid);

  // プレビューを published に設定
  db.prepare(`
    INSERT INTO sf_track_previews (track_id, preview_type, status, analytics_key)
    VALUES (?, 'demo', 'published', 'independence_test_001')
  `).run(tid);

  // 確認
  const track   = db.prepare('SELECT status FROM sf_tracks WHERE id=?').get(tid);
  const preview = db.prepare("SELECT status FROM sf_track_previews WHERE analytics_key='independence_test_001'").get();

  assert.equal(track.status,   'unreleased');
  assert.equal(preview.status, 'published');

  // クリーンアップ
  db.prepare("DELETE FROM sf_track_previews WHERE analytics_key='independence_test_001'").run();
  db.prepare("UPDATE sf_tracks SET status='unknown' WHERE id=?").run(tid);
});

// ─── 15. FOREIGN KEY 制約（PRAGMA foreign_keys=ON 確認）─────────────────────

console.log('\n▶ FOREIGN KEY 制約確認');

test('sf_track_files: 存在しない track_id は拒否される', () => {
  throws(
    () => db.prepare(`
      INSERT INTO sf_track_files (track_id, file_type, file_path)
      VALUES (99999, 'master_wav', '/audio/ghost.wav')
    `).run(),
    /FOREIGN KEY|foreign key/i
  );
});

test('sf_track_previews: 存在しない track_id は拒否される', () => {
  throws(
    () => db.prepare(`
      INSERT INTO sf_track_previews (track_id, preview_type) VALUES (99999, 'demo')
    `).run(),
    /FOREIGN KEY|foreign key/i
  );
});

test('sf_release_artworks: 存在しない release_id は拒否される', () => {
  throws(
    () => db.prepare(`
      INSERT INTO sf_release_artworks (release_id, file_path) VALUES (99999, '/img/cover.jpg')
    `).run(),
    /FOREIGN KEY|foreign key/i
  );
});

// ─── 16. Phase 1 seed 回帰テスト ─────────────────────────────────────────────

console.log('\n▶ Phase 1 seed 回帰テスト');

test('sf_works に4件登録されている', () => {
  const count = db.prepare('SELECT COUNT(*) as c FROM sf_works').get().c;
  assert.equal(count, 4, `sf_works: 期待4件, 実際${count}件`);
});

test('sf_tracks に12件登録されている', () => {
  const count = db.prepare('SELECT COUNT(*) as c FROM sf_tracks').get().c;
  assert.equal(count, 12, `sf_tracks: 期待12件, 実際${count}件`);
});

test('sf_track_work_links に15件登録されている', () => {
  const count = db.prepare('SELECT COUNT(*) as c FROM sf_track_work_links').get().c;
  assert.equal(count, 15, `sf_track_work_links: 期待15件, 実際${count}件`);
});

test('seed() を2回実行してもレコード数が増えない（べき等性）', () => {
  const beforeTracks = db.prepare('SELECT COUNT(*) as c FROM sf_tracks').get().c;
  seed(db);
  const afterTracks  = db.prepare('SELECT COUNT(*) as c FROM sf_tracks').get().c;
  assert.equal(afterTracks, beforeTracks, 'sf_tracks が増えた');
});

// ─── 結果サマリー ─────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`  結果: ${passed} passed / ${failed} failed`);
if (failed > 0) {
  console.error('  ❌ テスト失敗あり');
  process.exit(1);
}
console.log('  ✅ 全テスト通過');
