/**
 * jarvis/tests/test_dist_status.js
 * Phase 26.1: 配信状況ステータス表示ロジック テスト
 *
 * 実行: node tests/test_dist_status.js
 *
 * 分類定義:
 *   URL未特定    : Soundrop Delivered だが本人公開 URL 未特定 (14 サービス)
 *   音源ライブラリ: 通常の Artist ページではなく音源ライブラリ配信 (TikTok / FB・IG / Snapchat)
 *   対象外       : 一般向け Artist プロフィール管理対象外 (Audible Magic / Peloton / Nuuday)
 *   未登録       : 上記いずれにも該当しない未登録 platform
 */

import assert from 'node:assert/strict';

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

// ── _platformDisplayStatus を直接テスト ──────────────────────────────────────
// sf.js は IIFE のため直接 import 不可。同一ロジックをここで再現して検証する。

const DIST_URL_UNKNOWN = new Set([
  'awa', 'line_music', 'kkbox', 'boomplay', 'ayoba', 'pandora',
  'iheartradio', 'claro_musica', 'flo', 'lissen', 'netease',
  'tencent', 'seven_digital', 'audiomack',
]);
const DIST_NOT_APPLICABLE = new Set(['audible_magic', 'peloton', 'nuuday']);
const DIST_LIBRARY_ONLY   = new Set(['tiktok', 'facebook_instagram', 'snapchat']);

const PROFILE_STATUS_BADGE = {
  active:    { cls: 'sf-badge-green',  label: 'active' },
  pending:   { cls: 'sf-badge-yellow', label: 'pending' },
  unclaimed: { cls: 'sf-badge-yellow', label: 'unclaimed' },
  inactive:  { cls: 'sf-badge-dim',    label: 'inactive' },
  unknown:   { cls: 'sf-badge-gray',   label: 'unknown' },
};

function platformDisplayStatus(platform, profile, issues) {
  const unresolved = issues.filter(i =>
    i.platform === platform &&
    i.issue_status !== 'resolved' &&
    i.issue_status !== 'wont_fix'
  );
  if (profile) {
    if (unresolved.length > 0) {
      const hasOpen = unresolved.some(i => i.issue_status === 'open');
      return hasOpen
        ? { cls: 'sf-badge-red',    label: '問題あり' }
        : { cls: 'sf-badge-yellow', label: '修正依頼済み' };
    }
    if (profile.profile_status === 'active') return { cls: 'sf-badge-green', label: '問題なし' };
    return PROFILE_STATUS_BADGE[profile.profile_status] || { cls: 'sf-badge-gray', label: profile.profile_status };
  }
  if (DIST_NOT_APPLICABLE.has(platform)) return { cls: 'sf-badge-dim',  label: '対象外' };
  if (DIST_LIBRARY_ONLY.has(platform))   return { cls: 'sf-badge-dim',  label: '音源ライブラリ' };
  if (DIST_URL_UNKNOWN.has(platform))    return { cls: 'sf-badge-blue', label: 'URL未特定' };
  return { cls: 'sf-badge-dim', label: '未登録' };
}

// ── 実 DB からデータ取得 ─────────────────────────────────────────────────────

const BASE = 'http://localhost:3000';
const [profRes, issueRes] = await Promise.all([
  fetch(`${BASE}/api/sf/artist-profiles`).then(r => r.json()),
  fetch(`${BASE}/api/sf/platform-issues`).then(r => r.json()),
]);
const profiles = profRes.profiles || [];
const issues   = issueRes.issues  || [];
const profMap  = Object.fromEntries(profiles.map(p => [p.platform, p]));

function checkStatus(platform, expectedLabel) {
  const profile = profMap[platform];
  const result  = platformDisplayStatus(platform, profile, issues);
  assert.equal(result.label, expectedLabel,
    `${platform}: expected "${expectedLabel}", got "${result.label}"`);
}

// ── Section 1: プロフィール登録済み platform ────────────────────────────────

console.log('\n─── Section 1: プロフィール登録済み platform ───');

test('Spotify → 問題なし', () => checkStatus('spotify', '問題なし'));
test('Apple Music → 問題なし', () => checkStatus('apple_music', '問題なし'));
test('Amazon Music → 問題なし', () => checkStatus('amazon_music', '問題なし'));
test('YouTube Music → 問題なし', () => checkStatus('youtube_music', '問題なし'));
test('Anghami → 問題なし', () => checkStatus('anghami', '問題なし'));
test('Qobuz → 修正依頼済み（requested issue あり）', () => checkStatus('qobuz', '修正依頼済み'));
test('TIDAL → 問題あり（open issue あり）', () => checkStatus('tidal', '問題あり'));
test('Deezer → 問題あり（open issue あり）', () => checkStatus('deezer', '問題あり'));

// ── Section 2: URL未特定 platform（14件）────────────────────────────────────

console.log('\n─── Section 2: URL未特定 platform（14件）───');

const urlUnknownPlatforms = [
  'awa', 'line_music', 'kkbox', 'boomplay', 'ayoba', 'pandora',
  'iheartradio', 'claro_musica', 'flo', 'lissen', 'netease',
  'tencent', 'seven_digital', 'audiomack',
];
test('URL未特定 platform が 14 件', () => assert.equal(urlUnknownPlatforms.length, 14));
for (const p of urlUnknownPlatforms) {
  test(`${p} → URL未特定`, () => checkStatus(p, 'URL未特定'));
}

// ── Section 3: 音源ライブラリ platform（3件）──────────────────────────────

console.log('\n─── Section 3: 音源ライブラリ platform（3件）───');

test('TikTok → 音源ライブラリ', () => checkStatus('tiktok', '音源ライブラリ'));
test('Facebook / Instagram → 音源ライブラリ', () => checkStatus('facebook_instagram', '音源ライブラリ'));
test('Snapchat → 音源ライブラリ', () => checkStatus('snapchat', '音源ライブラリ'));

// Section 3 追加: TikTok が URL未特定 に含まれないことを確認
test('TikTok は URL未特定 Set に含まれない', () =>
  assert.ok(!DIST_URL_UNKNOWN.has('tiktok'), 'tiktok は DIST_URL_UNKNOWN にあってはいけない')
);
test('Snapchat は 対象外 Set に含まれない', () =>
  assert.ok(!DIST_NOT_APPLICABLE.has('snapchat'), 'snapchat は DIST_NOT_APPLICABLE にあってはいけない')
);

// ── Section 4: 対象外 platform（3件）─────────────────────────────────────

console.log('\n─── Section 4: 対象外 platform（3件）───');

test('Audible Magic → 対象外', () => checkStatus('audible_magic', '対象外'));
test('Peloton → 対象外', () => checkStatus('peloton', '対象外'));
test('Nuuday → 対象外', () => checkStatus('nuuday', '対象外'));

// ── Section 5: ロジック境界値テスト ─────────────────────────────────────────

console.log('\n─── Section 5: ロジック境界値 ───');

test('open + requested 混在 → 問題あり（open 優先）', () => {
  const result = platformDisplayStatus('test_p', { profile_status: 'active' }, [
    { platform: 'test_p', issue_status: 'open' },
    { platform: 'test_p', issue_status: 'requested' },
  ]);
  assert.equal(result.label, '問題あり');
});

test('resolved issue のみ → 問題なし（active profile）', () => {
  const result = platformDisplayStatus('test_p', { profile_status: 'active' }, [
    { platform: 'test_p', issue_status: 'resolved' },
  ]);
  assert.equal(result.label, '問題なし');
});

test('wont_fix issue のみ → 問題なし（active profile）', () => {
  const result = platformDisplayStatus('test_p', { profile_status: 'active' }, [
    { platform: 'test_p', issue_status: 'wont_fix' },
  ]);
  assert.equal(result.label, '問題なし');
});

test('profile=unknown + issue なし → unknown バッジ', () => {
  const result = platformDisplayStatus('test_p', { profile_status: 'unknown' }, []);
  assert.equal(result.label, 'unknown');
});

test('対象外 Set: audible_magic / peloton / nuuday の 3 件', () => {
  assert.equal(DIST_NOT_APPLICABLE.size, 3);
  assert.ok(DIST_NOT_APPLICABLE.has('audible_magic'));
  assert.ok(DIST_NOT_APPLICABLE.has('peloton'));
  assert.ok(DIST_NOT_APPLICABLE.has('nuuday'));
});

test('音源ライブラリ Set: tiktok / facebook_instagram / snapchat の 3 件', () => {
  assert.equal(DIST_LIBRARY_ONLY.size, 3);
  assert.ok(DIST_LIBRARY_ONLY.has('tiktok'));
  assert.ok(DIST_LIBRARY_ONLY.has('facebook_instagram'));
  assert.ok(DIST_LIBRARY_ONLY.has('snapchat'));
});

test('audiomack は URL未特定（別人防止: Togo の別アーティスト）', () =>
  assert.ok(DIST_URL_UNKNOWN.has('audiomack'))
);

// ── Section 6: other は未登録 ─────────────────────────────────────────────

console.log('\n─── Section 6: その他 platform ───');

test('other（プロフィールなし） → 未登録', () => {
  const result = platformDisplayStatus('other', undefined, []);
  assert.equal(result.label, '未登録');
});

// ── 結果 ──────────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`);
console.log(`合計: ${passed + failed} tests  ✅ ${passed} passed  ❌ ${failed} failed`);
if (failed > 0) process.exit(1);
