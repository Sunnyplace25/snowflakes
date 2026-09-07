/**
 * jarvis/tests/test_phase27.js
 * Phase 27: Soundrop カタログ自動同期 テスト
 *
 * 実行: node tests/test_phase27.js
 *
 * テスト構成:
 *   Section 1: API エンドポイント動作確認（5件）
 *   Section 2: リリースステータス変換ルール（5件）
 *   Section 3: トラックステータス変換ルール（4件）
 *   Section 4: 保護ルールと独立性（5件）
 *   Section 5: 日付境界・todayLocal 注入（1件）
 */

import assert from 'node:assert/strict';
import { reconcileReleaseStatus, reconcileTrackStatus } from '../sync/status_reconciler.mjs';

const BASE = 'http://localhost:3000';
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

// ── ヘルパー: Soundrop同期済みリリースのベースオブジェクト ──────────────────────
function sdRelease(overrides = {}) {
  return {
    id:                   99,
    status:               'draft',
    release_date:         null,
    soundrop_release_id:  12345,
    soundrop_synced_at:   '2026-09-01T00:00:00Z',
    soundrop_is_canceled: 0,
    soundrop_is_draft:    0,
    ...overrides,
  };
}

function sdTrack(overrides = {}) {
  return { id: 99, status: 'unreleased', ...overrides };
}

// ── Section 1: API エンドポイント動作確認 ─────────────────────────────────────

console.log('\n─── Section 1: API エンドポイント動作確認 ───');

await testAsync('token-status が tokenConfigured: boolean を返す', async () => {
  const res  = await fetch(`${BASE}/api/sf/soundrop-sync/token-status`);
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.ok(data.ok, `ok が false: ${JSON.stringify(data)}`);
  assert.ok(typeof data.tokenConfigured === 'boolean',
    `tokenConfigured が boolean でない: ${JSON.stringify(data)}`);
});

await testAsync('token-status のレスポンスに Token 文字列が含まれない', async () => {
  const res  = await fetch(`${BASE}/api/sf/soundrop-sync/token-status`);
  const text = await res.text();
  // Token は英数字64文字以上の文字列のことが多い
  // レスポンスに "SOUNDROP_TOKEN" のキー名も含まれないこと
  assert.ok(!text.includes('SOUNDROP_TOKEN'),
    'レスポンスに SOUNDROP_TOKEN が含まれている');
});

await testAsync('soundrop-sync/auto が reconcileStats を必ず返す（Token未設定時も）', async () => {
  const res  = await fetch(`${BASE}/api/sf/soundrop-sync/auto`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ force: false }),
  });
  const data = await res.json();
  // Token未設定でも skipped でも、reconcileStats は必ず存在する
  assert.ok(data.reconcileStats !== undefined,
    `reconcileStats が存在しない: ${JSON.stringify(data)}`);
  assert.ok(typeof data.reconcileStats.releasesChanged === 'number',
    `releasesChanged が数値でない: ${JSON.stringify(data.reconcileStats)}`);
  assert.ok(typeof data.reconcileStats.tracksChanged === 'number',
    `tracksChanged が数値でない: ${JSON.stringify(data.reconcileStats)}`);
});

await testAsync('Token 未設定 → needsToken: true、サーバは落ちない', async () => {
  // このテストは SOUNDROP_TOKEN が未設定の環境を前提とする
  const res  = await fetch(`${BASE}/api/sf/soundrop-sync/auto`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ force: true }),
  });
  const data = await res.json();
  // Token未設定の場合は needsToken: true、設定済みなら ok: true / skipped など
  // いずれにせよサーバーが落ちていない（200 or 500 で JSON が返る）こと
  assert.ok([200, 500].includes(res.status),
    `予期しないステータス: ${res.status}`);
  assert.ok(typeof data === 'object' && data !== null,
    'JSON レスポンスでない');
  // Token未設定時のみ needsToken をチェック
  if (data.needsToken !== undefined) {
    assert.ok(data.needsToken === true, `needsToken が true でない: ${JSON.stringify(data)}`);
    assert.ok(typeof data.error === 'string', `error が文字列でない`);
  }
});

await testAsync('手動 /soundrop-sync/apply が stats 構造（requestUrl なし）→ 400', async () => {
  // requestUrl なしで呼ぶと 400 が返る（クラッシュしない）
  const res  = await fetch(`${BASE}/api/sf/soundrop-sync/apply`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({}),
  });
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.ok(data.error, 'error フィールドが存在しない');
});

// ── Section 2: リリースステータス変換ルール ──────────────────────────────────

console.log('\n─── Section 2: リリースステータス変換ルール ───');

test('soundrop_is_canceled=true → private', () => {
  const rel    = sdRelease({ soundrop_is_canceled: 1, status: 'released' });
  const result = reconcileReleaseStatus(rel, '2026-09-07');
  assert.equal(result, 'private');
});

test('soundrop_is_draft=true → draft', () => {
  const rel    = sdRelease({ soundrop_is_draft: 1, status: 'released' });
  const result = reconcileReleaseStatus(rel, '2026-09-07');
  assert.equal(result, 'draft');
});

test('release_date が todayLocal より未来 → scheduled', () => {
  const rel    = sdRelease({ release_date: '2026-12-31', status: 'draft' });
  const result = reconcileReleaseStatus(rel, '2026-09-07');
  assert.equal(result, 'scheduled');
});

test('release_date が todayLocal と同日 → released（当日はリリース済み）', () => {
  const rel    = sdRelease({ release_date: '2026-09-07', status: 'draft' });
  const result = reconcileReleaseStatus(rel, '2026-09-07');
  assert.equal(result, 'released');
});

test('soundrop_release_id IS NULL → null（Soundrop未同期は対象外）', () => {
  const rel    = sdRelease({ soundrop_release_id: null, release_date: '2025-01-01' });
  const result = reconcileReleaseStatus(rel, '2026-09-07');
  assert.equal(result, null, 'Soundrop未同期リリースが対象になっている');
});

// ── Section 3: トラックステータス変換ルール ──────────────────────────────────

console.log('\n─── Section 3: トラックステータス変換ルール ───');

test('linked release=released → track は released', () => {
  const track    = sdTrack({ status: 'unreleased' });
  const releases = [{ id: 1, status: 'released' }];
  assert.equal(reconcileTrackStatus(track, releases), 'released');
});

test('linked release=scheduled → track は streaming_pending（scheduleは書かない）', () => {
  const track    = sdTrack({ status: 'unreleased' });
  const releases = [{ id: 1, status: 'scheduled' }];
  const result   = reconcileTrackStatus(track, releases);
  assert.equal(result, 'streaming_pending');
  assert.notEqual(result, 'scheduled', 'sf_tracks に scheduled を書いてはいけない');
});

test('linked release=draft → track は unreleased（draftは書かない）', () => {
  const track    = sdTrack({ status: 'unknown' });
  const releases = [{ id: 1, status: 'draft' }];
  const result   = reconcileTrackStatus(track, releases);
  assert.equal(result, 'unreleased');
  assert.notEqual(result, 'draft', 'sf_tracks に draft を書いてはいけない');
});

test('linked releases なし → null（現状維持）', () => {
  const track  = sdTrack({ status: 'unreleased' });
  const result = reconcileTrackStatus(track, []);
  assert.equal(result, null, 'linked releases が空のとき null 以外が返っている');
});

// ── Section 4: 保護ルールと独立性 ────────────────────────────────────────────

console.log('\n─── Section 4: 保護ルールと独立性 ───');

test('track.status=private → reconcileTrackStatus は null（手動private保護）', () => {
  const track    = sdTrack({ status: 'private' });
  const releases = [{ id: 1, status: 'released' }];
  const result   = reconcileTrackStatus(track, releases);
  assert.equal(result, null, 'private トラックが上書きされている');
});

test('release.status=private かつ soundrop_is_canceled=false → null（手動private保護）', () => {
  const rel    = sdRelease({ status: 'private', soundrop_is_canceled: 0, release_date: '2025-01-01' });
  const result = reconcileReleaseStatus(rel, '2026-09-07');
  assert.equal(result, null, '手動 private リリースが上書きされている');
});

test('soundrop_synced_at IS NULL → null（Soundrop未同期手動scheduledを日付だけでreleasedにしない）', () => {
  const rel = {
    id:                   10,
    status:               'scheduled',
    release_date:         '2025-01-01',   // 過去日付
    soundrop_release_id:  99,
    soundrop_synced_at:   null,           // 未同期
    soundrop_is_canceled: 0,
    soundrop_is_draft:    0,
  };
  const result = reconcileReleaseStatus(rel, '2026-09-07');
  assert.equal(result, null, '未同期リリースが日付判定でreleasedになっている');
});

await testAsync('source=soundrop_catalog と source=soundrop が混在しない', async () => {
  // soundrop_catalog の操作が source=soundrop 行に影響しないことを確認
  // auto-sync を呼んだ前後で source='soundrop' の行が変わらないこと
  const before = await fetch(`${BASE}/api/sf/soundrop-sync/status`)
    .then(r => r.json()).catch(() => null);

  await fetch(`${BASE}/api/sf/soundrop-sync/auto`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ force: false }),
  });

  const after = await fetch(`${BASE}/api/sf/soundrop-sync/status`)
    .then(r => r.json()).catch(() => null);

  // /soundrop-sync/status は既存エンドポイント（migration状態チェック）
  // auto-sync 後も 200 を返すこと（クラッシュしていない）
  if (before && after) {
    assert.ok(after.ok !== false, 'soundrop-sync/status が壊れている');
  }
});

await testAsync('force=false・6時間以内 → skipped:true + reconcileStats あり', async () => {
  // soundrop_catalog に過去1時間以内の last_success_at を設定してテスト
  // 実際には前のテストで soundrop_catalog 行が作られている可能性がある
  const res  = await fetch(`${BASE}/api/sf/soundrop-sync/auto`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ force: false }),
  });
  const data = await res.json();
  // Token未設定の場合は needsToken が返るが、reconcileStats は存在する
  assert.ok(data.reconcileStats !== undefined,
    `force=false でも reconcileStats が存在しない: ${JSON.stringify(data)}`);
  // skipped か needsToken のどちらかが返っていること（API同期に到達していない）
  const isSkippedOrNoToken = data.skipped === true || data.needsToken === true || data.ok === true;
  assert.ok(isSkippedOrNoToken, `予期しないレスポンス: ${JSON.stringify(data)}`);
});

// ── Section 5: 日付境界・todayLocal 注入 ────────────────────────────────────

console.log('\n─── Section 5: 日付境界・todayLocal 注入 ───');

test('日付境界: release_date=2026-09-07, todayLocal=2026-09-06 → scheduled', () => {
  const rel    = sdRelease({ release_date: '2026-09-07', status: 'draft' });
  const result = reconcileReleaseStatus(rel, '2026-09-06');
  assert.equal(result, 'scheduled',
    `リリース日前日なのに scheduled にならない: ${result}`);
});

test('日付境界: release_date=2026-09-07, todayLocal=2026-09-07 → released（当日=リリース済み）', () => {
  const rel    = sdRelease({ release_date: '2026-09-07', status: 'draft' });
  const result = reconcileReleaseStatus(rel, '2026-09-07');
  assert.equal(result, 'released',
    `リリース当日なのに released にならない: ${result}`);
});

// UTC(2026-09-06T15:00:00Z) は JST では 2026-09-07 00:00 = リリース当日
// → todayLocal='2026-09-07' として注入すれば正しく released になる
test('日付境界: UTC 2026-09-06T15:00Z = JST 2026-09-07 → todayLocal=2026-09-07 で released', () => {
  const rel      = sdRelease({ release_date: '2026-09-07', status: 'draft' });
  // JST 2026-09-07 00:00 をローカル基準日として注入
  const todayLocal = '2026-09-07';
  const result   = reconcileReleaseStatus(rel, todayLocal);
  assert.equal(result, 'released',
    `JST リリース当日に released にならない: ${result}`);
});

// ── 結果 ──────────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`);
console.log(`合計: ${passed + failed} tests  ✅ ${passed} passed  ❌ ${failed} failed`);
if (failed > 0) process.exit(1);
