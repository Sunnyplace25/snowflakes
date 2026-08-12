/**
 * jarvis/tests/test_sf_schema.js
 * Snow flakes Analytics Phase 1 — スキーマ・マスターデータ テスト
 *
 * 検証内容:
 *   - 全14テーブルの存在確認
 *   - UNIQUE制約
 *   - FOREIGN KEY制約（PRAGMA foreign_keys = ON）
 *   - sf_track_work_links の partial UNIQUE INDEX（primary は1件のみ）
 *   - sf_music_metrics の UNIQUE(date, granularity, platform, track_id)
 *   - seed() のべき等性
 *
 * 重要: ':memory:' DBのみ使用。business_data.db には触れない。
 */

import assert from 'node:assert/strict';
import { createDb }  from '../data/db.js';
import { seed }      from '../data/sf_seed.js';

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

// ─── 1. 全テーブル存在確認 ────────────────────────────────────────────────────

console.log('\n▶ テーブル存在確認（14テーブル）');

const EXPECTED_TABLES = [
  'work_records', 'daily_status',
  'sf_works', 'sf_tracks', 'sf_track_work_links',
  'sf_revenue', 'sf_ga_daily', 'sf_narou_snapshot',
  'sf_music_metrics',
  'sf_content_registry', 'sf_social_metrics', 'sf_platform_ext',
  'sf_account_daily', 'sf_funnel_event',
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

// ─── 2. partial UNIQUE INDEX 存在確認 ────────────────────────────────────────

console.log('\n▶ partial UNIQUE INDEX 確認');

test('idx_sf_twl_primary インデックスが存在する', () => {
  const idx = db
    .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='idx_sf_twl_primary'")
    .get();
  assert.ok(idx, 'idx_sf_twl_primary が存在しない');
});

// ─── 3. sf_works UNIQUE制約 ──────────────────────────────────────────────────

console.log('\n▶ sf_works');

test('work_key の UNIQUE 制約が働く', () => {
  db.prepare("INSERT INTO sf_works (work_key, title, work_type) VALUES ('test_work', 'テスト作品', 'novel')").run();
  throws(
    () => db.prepare("INSERT INTO sf_works (work_key, title, work_type) VALUES ('test_work', '重複', 'novel')").run(),
    /UNIQUE|unique/i
  );
  db.prepare("DELETE FROM sf_works WHERE work_key='test_work'").run();
});

// ─── 4. sf_tracks UNIQUE制約 ─────────────────────────────────────────────────

console.log('\n▶ sf_tracks');

test('track_key の UNIQUE 制約が働く', () => {
  db.prepare("INSERT INTO sf_tracks (track_key, title) VALUES ('test_track', 'テスト曲')").run();
  throws(
    () => db.prepare("INSERT INTO sf_tracks (track_key, title) VALUES ('test_track', '重複')").run(),
    /UNIQUE|unique/i
  );
  db.prepare("DELETE FROM sf_tracks WHERE track_key='test_track'").run();
});

// ─── 5. sf_track_work_links — primary は1件のみ ──────────────────────────────

console.log('\n▶ sf_track_work_links');

test('同一 track_id に primary が2件以上登録できない', () => {
  // テスト用作品・楽曲を用意
  db.prepare("INSERT INTO sf_works  (work_key, title, work_type) VALUES ('twl_w1', 'W1', 'novel')").run();
  db.prepare("INSERT INTO sf_works  (work_key, title, work_type) VALUES ('twl_w2', 'W2', 'novel')").run();
  db.prepare("INSERT INTO sf_tracks (track_key, title) VALUES ('twl_t1', 'T1')").run();

  const wid1 = db.prepare("SELECT id FROM sf_works  WHERE work_key='twl_w1'").get().id;
  const wid2 = db.prepare("SELECT id FROM sf_works  WHERE work_key='twl_w2'").get().id;
  const tid1 = db.prepare("SELECT id FROM sf_tracks WHERE track_key='twl_t1'").get().id;

  db.prepare('INSERT INTO sf_track_work_links (track_id, work_id, link_type) VALUES (?,?,?)').run(tid1, wid1, 'primary');

  throws(
    () => db.prepare('INSERT INTO sf_track_work_links (track_id, work_id, link_type) VALUES (?,?,?)').run(tid1, wid2, 'primary'),
    /UNIQUE|unique/i
  );

  // related は複数可
  db.prepare('INSERT INTO sf_track_work_links (track_id, work_id, link_type) VALUES (?,?,?)').run(tid1, wid2, 'related');

  // クリーンアップ
  db.prepare('DELETE FROM sf_track_work_links WHERE track_id=?').run(tid1);
  db.prepare('DELETE FROM sf_tracks WHERE track_key=?').run('twl_t1');
  db.prepare('DELETE FROM sf_works  WHERE work_key IN (?,?)').run('twl_w1', 'twl_w2');
});

test('PRIMARY KEY(track_id, work_id) 重複は拒否される', () => {
  db.prepare("INSERT INTO sf_works  (work_key, title, work_type) VALUES ('twl_pk_w', 'W', 'novel')").run();
  db.prepare("INSERT INTO sf_tracks (track_key, title) VALUES ('twl_pk_t', 'T')").run();
  const wid = db.prepare("SELECT id FROM sf_works  WHERE work_key='twl_pk_w'").get().id;
  const tid = db.prepare("SELECT id FROM sf_tracks WHERE track_key='twl_pk_t'").get().id;

  db.prepare('INSERT INTO sf_track_work_links (track_id, work_id, link_type) VALUES (?,?,?)').run(tid, wid, 'related');
  throws(
    () => db.prepare('INSERT INTO sf_track_work_links (track_id, work_id, link_type) VALUES (?,?,?)').run(tid, wid, 'collab'),
    /UNIQUE|unique/i
  );

  db.prepare('DELETE FROM sf_track_work_links WHERE track_id=?').run(tid);
  db.prepare('DELETE FROM sf_tracks WHERE track_key=?').run('twl_pk_t');
  db.prepare('DELETE FROM sf_works  WHERE work_key=?').run('twl_pk_w');
});

test('link_type の CHECK 制約が働く', () => {
  db.prepare("INSERT INTO sf_works  (work_key, title, work_type) VALUES ('twl_c_w', 'W', 'novel')").run();
  db.prepare("INSERT INTO sf_tracks (track_key, title) VALUES ('twl_c_t', 'T')").run();
  const wid = db.prepare("SELECT id FROM sf_works  WHERE work_key='twl_c_w'").get().id;
  const tid = db.prepare("SELECT id FROM sf_tracks WHERE track_key='twl_c_t'").get().id;

  throws(
    () => db.prepare('INSERT INTO sf_track_work_links (track_id, work_id, link_type) VALUES (?,?,?)').run(tid, wid, 'invalid_type'),
    /CHECK|check/i
  );

  db.prepare('DELETE FROM sf_tracks WHERE track_key=?').run('twl_c_t');
  db.prepare('DELETE FROM sf_works  WHERE work_key=?').run('twl_c_w');
});

// ─── 6. sf_music_metrics ─────────────────────────────────────────────────────

console.log('\n▶ sf_music_metrics');

test('track_id FK 制約：存在しない track_id は拒否される', () => {
  throws(
    () => db.prepare(`
      INSERT INTO sf_music_metrics (date, month, granularity, platform, track_id)
      VALUES ('2026-08-01', '2026-08', 'daily', 'spotify', 99999)
    `).run(),
    /FOREIGN KEY|foreign key/i
  );
});

test('UNIQUE(date, granularity, platform, track_id) が働く', () => {
  const tid = db.prepare("SELECT id FROM sf_tracks WHERE track_key='signal'").get().id;
  db.prepare(`
    INSERT INTO sf_music_metrics (date, month, granularity, platform, track_id, streams)
    VALUES ('2026-08-01', '2026-08', 'daily', 'spotify', ?, 100)
  `).run(tid);

  throws(
    () => db.prepare(`
      INSERT INTO sf_music_metrics (date, month, granularity, platform, track_id, streams)
      VALUES ('2026-08-01', '2026-08', 'daily', 'spotify', ?, 200)
    `).run(tid),
    /UNIQUE|unique/i
  );

  // granularity が違えば OK
  db.prepare(`
    INSERT INTO sf_music_metrics (date, month, granularity, platform, track_id, streams)
    VALUES ('2026-08-01', '2026-08', 'monthly', 'spotify', ?, 3000)
  `).run(tid);

  db.prepare('DELETE FROM sf_music_metrics WHERE track_id=?').run(tid);
});

test('platform_track_id カラムが存在し NULL 許容', () => {
  const tid = db.prepare("SELECT id FROM sf_tracks WHERE track_key='glass_no_heri'").get().id;
  db.prepare(`
    INSERT INTO sf_music_metrics
      (date, month, granularity, platform, track_id, platform_track_id)
    VALUES ('2026-08-02', '2026-08', 'daily', 'apple_music', ?, '1234567890')
  `).run(tid);
  const row = db.prepare('SELECT platform_track_id FROM sf_music_metrics WHERE track_id=? AND date=?').get(tid, '2026-08-02');
  assert.equal(row.platform_track_id, '1234567890');
  db.prepare('DELETE FROM sf_music_metrics WHERE track_id=? AND date=?').run(tid, '2026-08-02');
});

// ─── 7. sf_narou_snapshot ────────────────────────────────────────────────────

console.log('\n▶ sf_narou_snapshot');

test('UNIQUE(month, ncode) が働く', () => {
  const wid = db.prepare("SELECT id FROM sf_works WHERE work_key='hitotsu_ooi_oto'").get().id;
  db.prepare(`
    INSERT INTO sf_narou_snapshot (month, ncode, work_id, pv_monthly)
    VALUES ('2026-08', 'n9009lo', ?, 3200)
  `).run(wid);
  throws(
    () => db.prepare(`
      INSERT INTO sf_narou_snapshot (month, ncode, work_id, pv_monthly)
      VALUES ('2026-08', 'n9009lo', ?, 9999)
    `).run(wid),
    /UNIQUE|unique/i
  );
  db.prepare("DELETE FROM sf_narou_snapshot WHERE month='2026-08'").run();
});

test('work_id FK 制約が働く', () => {
  throws(
    () => db.prepare(`
      INSERT INTO sf_narou_snapshot (month, ncode, work_id)
      VALUES ('2026-07', 'n9009lo', 99999)
    `).run(),
    /FOREIGN KEY|foreign key/i
  );
});

// ─── 8. sf_content_registry ──────────────────────────────────────────────────

console.log('\n▶ sf_content_registry');

test('UNIQUE(platform, platform_id) が働く', () => {
  db.prepare(`
    INSERT INTO sf_content_registry (platform, content_type, platform_id, title)
    VALUES ('instagram', 'reel', 'reel_test_001', 'テストリール')
  `).run();
  throws(
    () => db.prepare(`
      INSERT INTO sf_content_registry (platform, content_type, platform_id, title)
      VALUES ('instagram', 'post', 'reel_test_001', '重複')
    `).run(),
    /UNIQUE|unique/i
  );
  db.prepare("DELETE FROM sf_content_registry WHERE platform_id='reel_test_001'").run();
});

test('work_id / track_id FK 制約が働く', () => {
  throws(
    () => db.prepare(`
      INSERT INTO sf_content_registry (platform, content_type, platform_id, work_id)
      VALUES ('youtube', 'video', 'yt_fk_test', 99999)
    `).run(),
    /FOREIGN KEY|foreign key/i
  );
});

// ─── 9. sf_social_metrics / sf_platform_ext ──────────────────────────────────

console.log('\n▶ sf_social_metrics / sf_platform_ext');

test('sf_social_metrics: content_reg_id FK + UNIQUE(content_reg_id, snapshot_date)', () => {
  const wid = db.prepare("SELECT id FROM sf_works WHERE work_key='undertone_game'").get().id;
  db.prepare(`
    INSERT INTO sf_content_registry (platform, content_type, platform_id, work_id)
    VALUES ('youtube', 'video', 'yt_sm_test', ?)
  `).run(wid);
  const cid = db.prepare("SELECT id FROM sf_content_registry WHERE platform_id='yt_sm_test'").get().id;

  db.prepare(`
    INSERT INTO sf_social_metrics (content_reg_id, snapshot_date, views)
    VALUES (?, '2026-08-01', 500)
  `).run(cid);
  throws(
    () => db.prepare(`
      INSERT INTO sf_social_metrics (content_reg_id, snapshot_date, views)
      VALUES (?, '2026-08-01', 600)
    `).run(cid),
    /UNIQUE|unique/i
  );

  // sf_platform_ext: UNIQUE(metrics_id, key)
  const mid = db.prepare('SELECT id FROM sf_social_metrics WHERE content_reg_id=?').get(cid).id;
  db.prepare('INSERT INTO sf_platform_ext (metrics_id, key, value_num) VALUES (?,?,?)').run(mid, 'completion_rate', 0.72);
  throws(
    () => db.prepare('INSERT INTO sf_platform_ext (metrics_id, key, value_num) VALUES (?,?,?)').run(mid, 'completion_rate', 0.80),
    /UNIQUE|unique/i
  );

  db.prepare('DELETE FROM sf_platform_ext   WHERE metrics_id=?').run(mid);
  db.prepare('DELETE FROM sf_social_metrics WHERE content_reg_id=?').run(cid);
  db.prepare("DELETE FROM sf_content_registry WHERE platform_id='yt_sm_test'").run();
});

// ─── 10. sf_account_daily ────────────────────────────────────────────────────

console.log('\n▶ sf_account_daily');

test('UNIQUE(platform, date) が働く', () => {
  db.prepare(`
    INSERT INTO sf_account_daily (platform, date, followers)
    VALUES ('instagram', '2026-08-01', 5800)
  `).run();
  throws(
    () => db.prepare(`
      INSERT INTO sf_account_daily (platform, date, followers)
      VALUES ('instagram', '2026-08-01', 5900)
    `).run(),
    /UNIQUE|unique/i
  );
  db.prepare("DELETE FROM sf_account_daily WHERE platform='instagram' AND date='2026-08-01'").run();
});

// ─── 11. sf_funnel_event ─────────────────────────────────────────────────────

console.log('\n▶ sf_funnel_event');

test('event_type CHECK 制約が働く', () => {
  throws(
    () => db.prepare(`
      INSERT INTO sf_funnel_event (date, event_type)
      VALUES ('2026-08-01', 'invalid_event')
    `).run(),
    /CHECK|check/i
  );
});

test('work_id / track_id FK 制約が働く', () => {
  throws(
    () => db.prepare(`
      INSERT INTO sf_funnel_event (date, event_type, work_id)
      VALUES ('2026-08-01', 'novel_publish', 99999)
    `).run(),
    /FOREIGN KEY|foreign key/i
  );
});

// ─── 12. sf_revenue ──────────────────────────────────────────────────────────

console.log('\n▶ sf_revenue');

test('source CHECK 制約が働く', () => {
  throws(
    () => db.prepare(`
      INSERT INTO sf_revenue (date, month, source, amount_jpy)
      VALUES ('2026-08-01', '2026-08', '不明な収益', 0)
    `).run(),
    /CHECK|check/i
  );
});

test('track_id FK 制約が働く', () => {
  throws(
    () => db.prepare(`
      INSERT INTO sf_revenue (date, month, source, track_id, amount_jpy)
      VALUES ('2026-08-01', '2026-08', '音楽配信', 99999, 0)
    `).run(),
    /FOREIGN KEY|foreign key/i
  );
});

// ─── 13. seed() べき等性 ─────────────────────────────────────────────────────

console.log('\n▶ seed() べき等性');

test('seed() を2回実行してもレコード数が増えない', () => {
  const beforeWorks  = db.prepare('SELECT COUNT(*) as c FROM sf_works').get().c;
  const beforeTracks = db.prepare('SELECT COUNT(*) as c FROM sf_tracks').get().c;
  const beforeLinks  = db.prepare('SELECT COUNT(*) as c FROM sf_track_work_links').get().c;

  seed(db); // 2回目

  const afterWorks  = db.prepare('SELECT COUNT(*) as c FROM sf_works').get().c;
  const afterTracks = db.prepare('SELECT COUNT(*) as c FROM sf_tracks').get().c;
  const afterLinks  = db.prepare('SELECT COUNT(*) as c FROM sf_track_work_links').get().c;

  assert.equal(afterWorks,  beforeWorks,  'sf_works が増えた');
  assert.equal(afterTracks, beforeTracks, 'sf_tracks が増えた');
  assert.equal(afterLinks,  beforeLinks,  'sf_track_work_links が増えた');
});

// ─── 14. seed データ確認 ──────────────────────────────────────────────────────

console.log('\n▶ seed データ確認');

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

test('spring_waltz は undertone_game (primary) + quietly_falling (related) に紐付く', () => {
  const track = db.prepare("SELECT id FROM sf_tracks WHERE track_key='spring_waltz'").get();
  const links = db.prepare(`
    SELECT w.work_key, l.link_type
    FROM sf_track_work_links l
    JOIN sf_works w ON w.id = l.work_id
    WHERE l.track_id = ?
    ORDER BY l.link_type
  `).all(track.id);
  assert.equal(links.length, 2);
  const primary = links.find(l => l.link_type === 'primary');
  const related = links.find(l => l.link_type === 'related');
  assert.equal(primary?.work_key, 'undertone_game');
  assert.equal(related?.work_key, 'quietly_falling');
});

test('signal は hitotsu_ooi_oto に primary リンクされている', () => {
  const track = db.prepare("SELECT id FROM sf_tracks WHERE track_key='signal'").get();
  const link  = db.prepare(`
    SELECT w.work_key FROM sf_track_work_links l
    JOIN sf_works w ON w.id = l.work_id
    WHERE l.track_id = ? AND l.link_type = 'primary'
  `).get(track.id);
  assert.equal(link?.work_key, 'hitotsu_ooi_oto');
});

// ─── 結果サマリー ─────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(50)}`);
console.log(`  結果: ${passed} passed / ${failed} failed`);
if (failed > 0) {
  console.error('  ❌ テスト失敗あり');
  process.exit(1);
}
console.log('  ✅ 全テスト通過');
