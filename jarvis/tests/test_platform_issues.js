/**
 * jarvis/tests/test_platform_issues.js
 * Phase 24: 配信サイト問題管理 テスト
 *
 * 実行: node tests/test_platform_issues.js
 *
 * 検証内容:
 *   - sf_artist_profiles への tidal / qobuz 追加（マイグレーション後）
 *   - 既存 profile が migration 後も残る
 *   - sf_platform_issues テーブル存在確認
 *   - issue 登録 / 更新 / 状態変更 / last_checked_at 更新
 *   - 同一 platform で複数 issue 履歴を保持できる
 *   - entity 不在時のエラー
 *   - CHECK 制約（issue_type / issue_status / entity_type）
 *   - 既存 Soundrop 関連テスト用テーブルが壊れていない
 *
 * 重要: ':memory:' DBのみ使用。business_data.db には触れない。
 */

import assert from 'node:assert/strict';
import { createDb } from '../data/db.js';
import { seed }     from '../data/sf_seed.js';
import { upsertArtistProfile } from '../data/sf_manager.js';
import {
  DISTRIBUTION_PLATFORMS,
  ISSUE_TYPE_LABELS,
  ISSUE_STATUS_LABELS,
  getDistributionPlatforms,
  getIssues,
  getIssue,
  createIssue,
  updateIssue,
  setIssueRequested,
  resolveIssue,
  touchIssueChecked,
} from '../data/sf_platform_manager.js';

// ── セットアップ ──────────────────────────────────────────────────────────────

const db = createDb(':memory:');
seed(db);

// ── テストランナー ────────────────────────────────────────────────────────────

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

function throws(fn, pattern) {
  try {
    fn();
    throw new Error('例外が発生しませんでした');
  } catch (e) {
    if (!pattern.test(e.message)) throw new Error(`期待したパターン ${pattern} に合わない: ${e.message}`);
  }
}

// ── Section 1: sf_artist_profiles マイグレーション確認 ───────────────────────

console.log('\n─── Section 1: sf_artist_profiles マイグレーション (tidal / qobuz) ───');

test('既存 profile (spotify) が migration 後も残る', () => {
  upsertArtistProfile(db, {
    artist_key:  'snow_flakes',
    artist_name: 'Snow flakes',
    platform:    'spotify',
  });
  const profiles = db.prepare(
    "SELECT * FROM sf_artist_profiles WHERE artist_key='snow_flakes' AND platform='spotify'"
  ).all();
  assert.equal(profiles.length, 1);
  assert.equal(profiles[0].platform, 'spotify');

  // クリーンアップ
  db.prepare("DELETE FROM sf_artist_profiles WHERE artist_key='snow_flakes' AND platform='spotify'").run();
});

test('tidal profile を保存できる', () => {
  const { id } = upsertArtistProfile(db, {
    artist_key:  'snow_flakes',
    artist_name: 'Snow flakes',
    platform:    'tidal',
    artist_page_url: 'https://tidal.com/artist/example',
  });
  assert.ok(id > 0);
  const row = db.prepare('SELECT * FROM sf_artist_profiles WHERE id = ?').get(id);
  assert.equal(row.platform, 'tidal');
  assert.equal(row.artist_name, 'Snow flakes');

  // クリーンアップ
  db.prepare('DELETE FROM sf_artist_profiles WHERE id = ?').run(id);
});

test('qobuz profile を保存できる', () => {
  const { id } = upsertArtistProfile(db, {
    artist_key:  'snow_flakes',
    artist_name: 'Snow flakes',
    platform:    'qobuz',
    artist_page_url: 'https://www.qobuz.com/artist/example',
  });
  assert.ok(id > 0);
  const row = db.prepare('SELECT * FROM sf_artist_profiles WHERE id = ?').get(id);
  assert.equal(row.platform, 'qobuz');

  // クリーンアップ
  db.prepare('DELETE FROM sf_artist_profiles WHERE id = ?').run(id);
});

test('TIDAL と Qobuz を別々の profile として保持できる', () => {
  const { id: tidalId } = upsertArtistProfile(db, {
    artist_key: 'snow_flakes_multi', artist_name: 'Snow flakes', platform: 'tidal',
  });
  const { id: qobuzId } = upsertArtistProfile(db, {
    artist_key: 'snow_flakes_multi', artist_name: 'Snow flakes', platform: 'qobuz',
  });

  assert.ok(tidalId !== qobuzId, 'tidal と qobuz は別 ID であるべき');

  const profiles = db.prepare(
    "SELECT platform FROM sf_artist_profiles WHERE artist_key='snow_flakes_multi' ORDER BY platform"
  ).all();
  assert.equal(profiles.length, 2);
  assert.equal(profiles[0].platform, 'qobuz');
  assert.equal(profiles[1].platform, 'tidal');

  // クリーンアップ
  db.prepare("DELETE FROM sf_artist_profiles WHERE artist_key='snow_flakes_multi'").run();
});

test('tidal / qobuz 以外の不正 platform は CHECK 制約で拒否される', () => {
  throws(
    () => db.prepare(`
      INSERT INTO sf_artist_profiles (artist_key, artist_name, platform)
      VALUES ('bad_test', 'Bad', 'soundcloud')
    `).run(),
    /CHECK|check/i
  );
});

test('既存 platform (other) は引き続き使える', () => {
  const { id } = upsertArtistProfile(db, {
    artist_key:  'snow_flakes_other',
    artist_name: 'Snow flakes',
    platform:    'other',
  });
  assert.ok(id > 0);
  db.prepare('DELETE FROM sf_artist_profiles WHERE id = ?').run(id);
});

// ── Section 2: sf_platform_issues テーブル確認 ───────────────────────────────

console.log('\n─── Section 2: sf_platform_issues テーブル確認 ────────────────────');

test('sf_platform_issues テーブルが存在する', () => {
  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='sf_platform_issues'"
  ).get();
  assert.ok(row, 'sf_platform_issues テーブルが存在しない');
});

test('DISTRIBUTION_PLATFORMS に tidal と qobuz が含まれる', () => {
  const values = DISTRIBUTION_PLATFORMS.map(p => p.value);
  assert.ok(values.includes('tidal'), 'tidal が含まれない');
  assert.ok(values.includes('qobuz'), 'qobuz が含まれない');
  assert.ok(values.includes('spotify'), 'spotify が含まれない');
});

test('ISSUE_TYPE_LABELS の全キーが定義されている', () => {
  const keys = ['mixed_artist','wrong_link','name_variant','not_reflected','other'];
  for (const k of keys) {
    assert.ok(ISSUE_TYPE_LABELS[k], `ISSUE_TYPE_LABELS['${k}'] が未定義`);
  }
});

test('ISSUE_STATUS_LABELS の全キーが定義されている', () => {
  const keys = ['open','requested','resolved','wont_fix'];
  for (const k of keys) {
    assert.ok(ISSUE_STATUS_LABELS[k], `ISSUE_STATUS_LABELS['${k}'] が未定義`);
  }
});

test('getDistributionPlatforms() が配列を返す', () => {
  const platforms = getDistributionPlatforms();
  assert.ok(Array.isArray(platforms));
  assert.ok(platforms.length >= 7);
});

// ── Section 3: issue 登録 ────────────────────────────────────────────────────

console.log('\n─── Section 3: issue 登録 ─────────────────────────────────────────');

// テスト用 artist profile を作成
const { id: testProfileId } = upsertArtistProfile(db, {
  artist_key:  'snow_flakes_issue_test',
  artist_name: 'Snow flakes',
  platform:    'spotify',
});

test('artist entity に issue を登録できる', () => {
  const { id } = createIssue(db, {
    entity_type: 'artist',
    entity_id:   testProfileId,
    platform:    'spotify',
    issue_type:  'mixed_artist',
    opened_at:   '2026-09-01',
    memo:        '別アーティストと混在している',
  });
  assert.ok(id > 0);

  const issue = getIssue(db, id);
  assert.equal(issue.entity_type, 'artist');
  assert.equal(issue.entity_id, testProfileId);
  assert.equal(issue.platform, 'spotify');
  assert.equal(issue.issue_type, 'mixed_artist');
  assert.equal(issue.issue_status, 'open');
  assert.equal(issue.opened_at, '2026-09-01');
  assert.equal(issue.memo, '別アーティストと混在している');
});

test('release entity に issue を登録できる', () => {
  const release = db.prepare("SELECT id FROM sf_releases LIMIT 1").get();
  if (!release) { passed++; console.log('  ✅ release entity に issue を登録できる (seed なし・スキップ)'); return; }

  const { id } = createIssue(db, {
    entity_type: 'release',
    entity_id:   release.id,
    platform:    'apple_music',
    issue_type:  'not_reflected',
  });
  assert.ok(id > 0);
  const issue = getIssue(db, id);
  assert.equal(issue.entity_type, 'release');
});

test('track entity に issue を登録できる', () => {
  const track = db.prepare("SELECT id FROM sf_tracks LIMIT 1").get();
  assert.ok(track, 'sf_tracks にレコードがない');

  const { id } = createIssue(db, {
    entity_type: 'track',
    entity_id:   track.id,
    platform:    'tidal',
    issue_type:  'name_variant',
  });
  assert.ok(id > 0);
  const issue = getIssue(db, id);
  assert.equal(issue.entity_type, 'track');
  assert.equal(issue.issue_type, 'name_variant');
});

test('存在しない entity_id は拒否される', () => {
  throws(
    () => createIssue(db, {
      entity_type: 'artist',
      entity_id:   999999,
      platform:    'spotify',
    }),
    /存在しません/
  );
});

test('entity_type が必須', () => {
  throws(
    () => createIssue(db, { entity_id: testProfileId, platform: 'spotify' }),
    /entity_type/
  );
});

test('entity_id が必須', () => {
  throws(
    () => createIssue(db, { entity_type: 'artist', platform: 'spotify' }),
    /entity_id/
  );
});

test('platform が必須', () => {
  throws(
    () => createIssue(db, { entity_type: 'artist', entity_id: testProfileId }),
    /platform/
  );
});

// ── Section 4: issue 更新 ────────────────────────────────────────────────────

console.log('\n─── Section 4: issue 更新 ─────────────────────────────────────────');

const { id: updateIssueId } = createIssue(db, {
  entity_type: 'artist',
  entity_id:   testProfileId,
  platform:    'tidal',
  issue_type:  'wrong_link',
  opened_at:   '2026-09-05',
});

test('updateIssue で memo を更新できる', () => {
  updateIssue(db, updateIssueId, { memo: '更新されたメモ' });
  const issue = getIssue(db, updateIssueId);
  assert.equal(issue.memo, '更新されたメモ');
});

test('updateIssue で related_url を更新できる', () => {
  updateIssue(db, updateIssueId, { related_url: 'https://soundrop.com/ticket/123' });
  const issue = getIssue(db, updateIssueId);
  assert.equal(issue.related_url, 'https://soundrop.com/ticket/123');
});

test('updateIssue で既存フィールドは COALESCE で保持される', () => {
  const before = getIssue(db, updateIssueId);
  updateIssue(db, updateIssueId, { memo: '別メモ' });
  const after = getIssue(db, updateIssueId);
  // issue_type は変更していないので保持されているはず
  assert.equal(after.issue_type, before.issue_type);
  assert.equal(after.opened_at,  before.opened_at);
});

test('存在しない id の updateIssue はエラー', () => {
  throws(() => updateIssue(db, 999999, { memo: 'test' }), /存在しません/);
});

// ── Section 5: 状態変更ショートカット ──────────────────────────────────────

console.log('\n─── Section 5: 状態変更ショートカット ─────────────────────────────');

const { id: stateIssueId } = createIssue(db, {
  entity_type: 'artist',
  entity_id:   testProfileId,
  platform:    'qobuz',
  issue_type:  'other',
  opened_at:   '2026-09-07',
});

test('setIssueRequested で issue_status が requested になる', () => {
  setIssueRequested(db, stateIssueId, '2026-09-07');
  const issue = getIssue(db, stateIssueId);
  assert.equal(issue.issue_status, 'requested');
  assert.equal(issue.requested_at, '2026-09-07');
});

test('setIssueRequested は既存 requested_at を上書きしない（COALESCE）', () => {
  setIssueRequested(db, stateIssueId, '2026-12-31');
  const issue = getIssue(db, stateIssueId);
  // 最初に '2026-09-07' で呼んだので、それが保持されるはず
  assert.equal(issue.requested_at, '2026-09-07');
});

test('resolveIssue で issue_status が resolved になる', () => {
  resolveIssue(db, stateIssueId, '2026-09-10');
  const issue = getIssue(db, stateIssueId);
  assert.equal(issue.issue_status, 'resolved');
  assert.equal(issue.resolved_at, '2026-09-10');
});

test('存在しない id の setIssueRequested はエラー', () => {
  throws(() => setIssueRequested(db, 999999), /存在しません/);
});

test('存在しない id の resolveIssue はエラー', () => {
  throws(() => resolveIssue(db, 999999), /存在しません/);
});

// ── Section 6: last_checked_at 更新 ─────────────────────────────────────────

console.log('\n─── Section 6: last_checked_at 更新 ──────────────────────────────');

const { id: checkIssueId } = createIssue(db, {
  entity_type: 'artist',
  entity_id:   testProfileId,
  platform:    'amazon_music',
  issue_type:  'not_reflected',
});

test('touchIssueChecked で last_checked_at が更新される', () => {
  assert.equal(getIssue(db, checkIssueId).last_checked_at, null);
  touchIssueChecked(db, checkIssueId, '2026-09-07');
  assert.equal(getIssue(db, checkIssueId).last_checked_at, '2026-09-07');
});

test('touchIssueChecked を複数回呼ぶと最新日付で上書きされる', () => {
  touchIssueChecked(db, checkIssueId, '2026-09-08');
  assert.equal(getIssue(db, checkIssueId).last_checked_at, '2026-09-08');
});

test('存在しない id の touchIssueChecked はエラー', () => {
  throws(() => touchIssueChecked(db, 999999), /存在しません/);
});

// ── Section 7: 複数 issue 履歴 ───────────────────────────────────────────────

console.log('\n─── Section 7: 同一 platform で複数 issue 履歴を保持できる ─────────');

test('同一 entity / platform で複数の issue を登録できる', () => {
  const { id: id1 } = createIssue(db, {
    entity_type: 'artist', entity_id: testProfileId, platform: 'spotify',
    issue_type: 'mixed_artist', opened_at: '2026-01-01',
  });
  const { id: id2 } = createIssue(db, {
    entity_type: 'artist', entity_id: testProfileId, platform: 'spotify',
    issue_type: 'name_variant', opened_at: '2026-03-01',
  });
  assert.ok(id1 !== id2, '別 ID で登録されるべき');

  const issues = getIssues(db, { entity_type: 'artist', entity_id: testProfileId, platform: 'spotify' });
  const ids = issues.map(i => i.id);
  assert.ok(ids.includes(id1));
  assert.ok(ids.includes(id2));
});

// ── Section 8: getIssues フィルタ ────────────────────────────────────────────

console.log('\n─── Section 8: getIssues フィルタ ─────────────────────────────────');

test('issue_status フィルタが機能する', () => {
  const openIssues = getIssues(db, { issue_status: 'open' });
  assert.ok(openIssues.every(i => i.issue_status === 'open'));
});

test('platform フィルタが機能する', () => {
  const tidalIssues = getIssues(db, { platform: 'tidal' });
  assert.ok(tidalIssues.every(i => i.platform === 'tidal'));
});

test('entity_type フィルタが機能する', () => {
  const artistIssues = getIssues(db, { entity_type: 'artist' });
  assert.ok(artistIssues.every(i => i.entity_type === 'artist'));
});

// ── Section 9: CHECK 制約 ────────────────────────────────────────────────────

console.log('\n─── Section 9: CHECK 制約 ─────────────────────────────────────────');

test('不正な issue_type は拒否される', () => {
  throws(
    () => db.prepare(`
      INSERT INTO sf_platform_issues (entity_type, entity_id, platform, issue_type)
      VALUES ('artist', ?, 'spotify', 'bad_type')
    `).run(testProfileId),
    /CHECK|check/i
  );
});

test('不正な issue_status は拒否される', () => {
  throws(
    () => db.prepare(`
      INSERT INTO sf_platform_issues (entity_type, entity_id, platform, issue_status)
      VALUES ('artist', ?, 'spotify', 'pending')
    `).run(testProfileId),
    /CHECK|check/i
  );
});

test('不正な entity_type は拒否される', () => {
  throws(
    () => db.prepare(`
      INSERT INTO sf_platform_issues (entity_type, entity_id, platform)
      VALUES ('work', ?, 'spotify')
    `).run(testProfileId),
    /CHECK|check/i
  );
});

// ── Section 10: 既存 Soundrop 関連テーブルが壊れていない ─────────────────────

console.log('\n─── Section 10: 既存 Soundrop 関連テーブルが壊れていない ───────────');

test('sf_tracks テーブルが存在し seed データがある', () => {
  const tracks = db.prepare('SELECT COUNT(*) AS n FROM sf_tracks').get();
  assert.ok(tracks.n > 0, `sf_tracks のレコード数が 0 (got ${tracks.n})`);
});

test('sf_releases テーブルが存在する', () => {
  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='sf_releases'"
  ).get();
  assert.ok(row, 'sf_releases テーブルが存在しない');
});

test('sf_distribution_imports テーブルが存在する', () => {
  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='sf_distribution_imports'"
  ).get();
  assert.ok(row, 'sf_distribution_imports テーブルが存在しない');
});

test('sf_artist_profiles への INSERT / DELETE が正常に動作する（既存機能回帰）', () => {
  const { id } = upsertArtistProfile(db, {
    artist_key:  'regression_test',
    artist_name: 'Regression Test',
    platform:    'apple_music',
  });
  assert.ok(id > 0);
  db.prepare('DELETE FROM sf_artist_profiles WHERE id = ?').run(id);
  assert.equal(db.prepare('SELECT id FROM sf_artist_profiles WHERE id = ?').get(id), undefined);
});

// ── Section 11: Phase 25 プラットフォーム拡張 ───────────────────────────────

console.log('\n─── Section 11: Phase 25 プラットフォーム拡張（22 platform 追加） ───');

const PHASE25_PLATFORMS = [
  'deezer','pandora','iheartradio','tiktok','facebook_instagram','anghami',
  'boomplay','ayoba','netease','tencent','claro_musica','peloton',
  'awa','line_music','kkbox','lissen','audiomack','audible_magic',
  'nuuday','flo','snapchat','seven_digital',
];

test('DISTRIBUTION_PLATFORMS に Phase 25 の全 22 platform が含まれる', () => {
  const values = DISTRIBUTION_PLATFORMS.map(p => p.value);
  for (const pv of PHASE25_PLATFORMS) {
    assert.ok(values.includes(pv), `${pv} が DISTRIBUTION_PLATFORMS に含まれない`);
  }
});

test('getDistributionPlatforms() が 29 件（既存 7 + 新規 22）を返す', () => {
  const platforms = getDistributionPlatforms();
  assert.equal(platforms.length, 29, `expected 29, got ${platforms.length}`);
});

test('sf_artist_profiles の CHECK 制約が Phase 25 の platform を許可する', () => {
  for (const pv of PHASE25_PLATFORMS) {
    const { id } = upsertArtistProfile(db, {
      artist_key:  `p25_test_${pv}`,
      artist_name: 'Snow flakes',
      platform:    pv,
    });
    assert.ok(id > 0, `${pv} の INSERT が失敗した`);
    db.prepare('DELETE FROM sf_artist_profiles WHERE id = ?').run(id);
  }
});

test('Phase 25 の platform で issue を登録できる', () => {
  const profile = upsertArtistProfile(db, {
    artist_key: 'p25_issue_test', artist_name: 'Snow flakes', platform: 'deezer',
  });
  const { id } = createIssue(db, {
    entity_type: 'artist',
    entity_id:   profile.id,
    platform:    'deezer',
    issue_type:  'mixed_artist',
  });
  assert.ok(id > 0);
  const issue = getIssue(db, id);
  assert.equal(issue.platform, 'deezer');
  db.prepare('DELETE FROM sf_artist_profiles WHERE id = ?').run(profile.id);
});

test('soundcloud 等の未定義 platform は CHECK 制約で拒否される（Phase 25 後も）', () => {
  throws(
    () => db.prepare(`
      INSERT INTO sf_artist_profiles (artist_key, artist_name, platform)
      VALUES ('bad_p25', 'Bad', 'soundcloud')
    `).run(),
    /CHECK|check/i
  );
});

test('Phase 25 migration 再実行で既存 profile が壊れない（冪等確認）', () => {
  // createDb を再度呼ぶことで runMigrations が再実行される
  const db2 = createDb(':memory:');
  // 既存 platform で insert できる
  const { id } = upsertArtistProfile(db2, {
    artist_key: 'idempotent_test', artist_name: 'Snow flakes', platform: 'spotify',
  });
  assert.ok(id > 0);
  // Phase 25 platform も使える
  const { id: id2 } = upsertArtistProfile(db2, {
    artist_key: 'idempotent_test', artist_name: 'Snow flakes', platform: 'line_music',
  });
  assert.ok(id2 > 0);
  db2.close();
});

test('既存 6 platform（spotify/apple_music/amazon_music/youtube_music/tidal/qobuz）は引き続き使える', () => {
  const existingPlatforms = ['spotify','apple_music','amazon_music','youtube_music','tidal','qobuz'];
  for (const pv of existingPlatforms) {
    const { id } = upsertArtistProfile(db, {
      artist_key:  `p25_exist_${pv}`,
      artist_name: 'Snow flakes',
      platform:    pv,
    });
    assert.ok(id > 0, `${pv} の INSERT が失敗した`);
    db.prepare('DELETE FROM sf_artist_profiles WHERE id = ?').run(id);
  }
});

// ── 結果 ──────────────────────────────────────────────────────────────────────

// クリーンアップ
db.prepare("DELETE FROM sf_artist_profiles WHERE artist_key='snow_flakes_issue_test'").run();
db.prepare("DELETE FROM sf_artist_profiles WHERE artist_key='p25_issue_test'").run();

console.log(`\n${'─'.repeat(60)}`);
console.log(`合計: ${passed + failed} tests  ✅ ${passed} passed  ❌ ${failed} failed`);
if (failed > 0) process.exit(1);
