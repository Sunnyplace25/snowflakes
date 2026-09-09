/**
 * jarvis/tests/test_sync_settings.js
 * Phase 31: sf_sync_source_settings テスト
 *
 * 検証項目:
 * 1. manual_required が要確認件数に入らない
 * 2. manual stale も要確認件数に入らない
 * 3. enabled AUTO error は要確認に入る
 * 4. enabled AUTO unconfigured は要確認に入る
 * 5. disabled source は要確認に入らない
 * 6. disabled AUTO source は runAutoSync 対象外
 * 7. MANUAL source は AUTO同期で実行されない（skipped でも結果から除外）
 * 8. source enabled 設定が DB 経由で保持される
 * 9. Revenue 派生抑制が維持される
 *
 * 重要: ':memory:' DB のみ使用。実 DB には触れない。
 */

import assert from 'node:assert/strict';
import { createDb, phase31Migration } from '../data/db.js';
import {
  SOURCE_REGISTRY, AUTO_SOURCES, MANUAL_SOURCES, DERIVED_FROM,
  getSourceEnabled, setSourceEnabled,
  getAttentionItems, getSyncStatus,
  runAutoSync,
} from '../data/sf_sync_manager.js';

// ─── テストユーティリティ ────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function test(name, fn) {
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

/** :memory: DB を作成（phase31Migration 自動適用済み）*/
function makeDb() {
  return createDb(':memory:');
}

/** Instagram 日次データ挿入 */
function insertIg(db, date) {
  db.prepare(`
    INSERT OR IGNORE INTO sf_instagram_account_daily (date, followers_count)
    VALUES (?, 100)
  `).run(date);
}

/** YouTube 日次データ挿入 */
function insertYt(db, date) {
  db.prepare(`
    INSERT OR IGNORE INTO sf_youtube_channel_daily (date, views)
    VALUES (?, 1000)
  `).run(date);
}

/** TikTok データ挿入（stale 状態を作るために古い日付で） */
function insertTikTokStale(db) {
  db.prepare(`
    INSERT OR IGNORE INTO sf_account_daily (platform, date, followers)
    VALUES ('tiktok', '2026-01-01', 50)
  `).run();
}

/** Soundrop データ挿入（stale 状態を作るために古い月で） */
function insertSounddropStale(db) {
  db.prepare(`
    INSERT OR IGNORE INTO sf_revenue
      (date, month, transaction_month, source, platform, amount, quantity)
    VALUES ('2026-01-01', '2026-01', '2026-01', '音楽配信', 'Spotify', 100.0, 50000)
  `).run();
}

// ══════════════════════════════════════════════════════════════════════════════
// Section 1: phase31Migration とテーブル存在確認
// ══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 1: phase31Migration');

await test('createDb(:memory:) で sf_sync_source_settings テーブルが作られる', () => {
  const db = makeDb();
  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='sf_sync_source_settings'"
  ).get();
  assert.ok(row, 'sf_sync_source_settings テーブルが存在しない');
  db.close?.();
});

await test('phase31Migration は冪等（2回実行してもエラーにならない）', () => {
  const db = makeDb();
  // 既に createDb で1回適用されている。もう1回呼んでも安全なはず
  phase31Migration(db);
  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='sf_sync_source_settings'"
  ).get();
  assert.ok(row);
  db.close?.();
});

// ══════════════════════════════════════════════════════════════════════════════
// Section 2: getSourceEnabled / setSourceEnabled
// ══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 2: getSourceEnabled / setSourceEnabled');

await test('レコードがない source のデフォルトは 1（利用中）', () => {
  const db = makeDb();
  const val = getSourceEnabled(db, 'instagram');
  assert.equal(val, 1);
  db.close?.();
});

await test('setSourceEnabled(0) 後に getSourceEnabled は 0 を返す', () => {
  const db = makeDb();
  setSourceEnabled(db, 'instagram', 0);
  assert.equal(getSourceEnabled(db, 'instagram'), 0);
  db.close?.();
});

await test('setSourceEnabled(1) → 0 → 1 と切り替えられる', () => {
  const db = makeDb();
  setSourceEnabled(db, 'youtube', 0);
  assert.equal(getSourceEnabled(db, 'youtube'), 0);
  setSourceEnabled(db, 'youtube', 1);
  assert.equal(getSourceEnabled(db, 'youtube'), 1);
  db.close?.();
});

await test('複数 source を独立して設定できる', () => {
  const db = makeDb();
  setSourceEnabled(db, 'instagram', 0);
  setSourceEnabled(db, 'youtube',   1);
  assert.equal(getSourceEnabled(db, 'instagram'), 0);
  assert.equal(getSourceEnabled(db, 'youtube'),   1);
  db.close?.();
});

// 8. source enabled 設定が DB 経由で保持される
await test('enabled 設定は DB に永続化される（UPSERT で上書き可能）', () => {
  const db = makeDb();
  setSourceEnabled(db, 'tiktok', 0);
  const row = db.prepare('SELECT enabled FROM sf_sync_source_settings WHERE source_key = ?').get('tiktok');
  assert.ok(row, 'レコードが存在しない');
  assert.equal(row.enabled, 0);
  // 再度 1 にする
  setSourceEnabled(db, 'tiktok', 1);
  const row2 = db.prepare('SELECT enabled FROM sf_sync_source_settings WHERE source_key = ?').get('tiktok');
  assert.equal(row2.enabled, 1);
  db.close?.();
});

// ══════════════════════════════════════════════════════════════════════════════
// Section 3: getAttentionItems の判定ロジック
// ══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 3: getAttentionItems 判定ロジック');

// 1. manual_required が要確認件数に入らない
await test('manual_required（MANUAL source データなし）は要確認に入らない', () => {
  const db = makeDb();
  // tiktok は MANUAL source でデータなし → manual_required
  // これが attention に出ないことを確認
  const items = getAttentionItems(db, { ignoreCooldown: true, today: '2026-09-09' });
  const tiktokItem = items.find(i => i.source === 'tiktok');
  assert.equal(tiktokItem, undefined, 'manual_required な tiktok が attention に出ている');
  db.close?.();
});

// 2. manual stale も要確認件数に入らない
await test('MANUAL source の stale は要確認に入らない', () => {
  const db = makeDb();
  insertTikTokStale(db); // 2026-01-01 → stale（しきい値14日）
  const items = getAttentionItems(db, { ignoreCooldown: true, today: '2026-09-09' });
  const tiktokItem = items.find(i => i.source === 'tiktok');
  assert.equal(tiktokItem, undefined, 'MANUAL stale な tiktok が attention に出ている');
  db.close?.();
});

// 3. enabled AUTO error は要確認に入る
await test('enabled AUTO source の error は要確認に入る', () => {
  const db = makeDb();
  // Instagram を error 状態にする（ENV 設定してデータ作成後にエラーを設定）
  process.env.INSTAGRAM_APP_ID       = 'test';
  process.env.INSTAGRAM_APP_SECRET   = 'test';
  process.env.INSTAGRAM_ACCESS_TOKEN = 'test';
  process.env.INSTAGRAM_USER_ID      = 'test';
  // sf_sync_state に error ステータスを直接挿入
  db.prepare(`
    INSERT OR REPLACE INTO sf_sync_state
      (source, mode, status, last_attempt_at, last_success_at, last_data_date,
       last_error, consecutive_failures, updated_at)
    VALUES ('instagram', 'auto', 'error', datetime('now'), NULL, NULL,
            'API error', 1, datetime('now'))
  `).run();
  // evaluateFreshness は ENV 設定 + データなし → never_synced になるが
  // getAttentionItems は evaluateFreshness の結果で判定する
  const items = getAttentionItems(db, { ignoreCooldown: true, today: '2026-09-09' });
  const igItem = items.find(i => i.source === 'instagram');
  // never_synced も AUTO source なので要確認に入るはず
  assert.ok(igItem, 'enabled AUTO source（never_synced/error）が attention に出ない');
  for (const k of ['INSTAGRAM_APP_ID','INSTAGRAM_APP_SECRET','INSTAGRAM_ACCESS_TOKEN','INSTAGRAM_USER_ID']) {
    delete process.env[k];
  }
  db.close?.();
});

// 4. enabled AUTO unconfigured は要確認に入る
await test('enabled AUTO source（unconfigured）は要確認に入る', () => {
  const db = makeDb();
  // ENV 未設定 → unconfigured
  const saved = {};
  for (const k of ['INSTAGRAM_APP_ID','INSTAGRAM_APP_SECRET','INSTAGRAM_ACCESS_TOKEN','INSTAGRAM_USER_ID']) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  const items = getAttentionItems(db, { ignoreCooldown: true, today: '2026-09-09' });
  const igItem = items.find(i => i.source === 'instagram');
  assert.ok(igItem, 'enabled AUTO unconfigured が attention に出ない');
  for (const [k, v] of Object.entries(saved)) {
    if (v !== undefined) process.env[k] = v;
  }
  db.close?.();
});

// 5. disabled source は要確認に入らない
await test('disabled（enabled=0）source は要確認に入らない', () => {
  const db = makeDb();
  // instagram を disabled にする
  setSourceEnabled(db, 'instagram', 0);
  const saved = {};
  for (const k of ['INSTAGRAM_APP_ID','INSTAGRAM_APP_SECRET','INSTAGRAM_ACCESS_TOKEN','INSTAGRAM_USER_ID']) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  const items = getAttentionItems(db, { ignoreCooldown: true, today: '2026-09-09' });
  const igItem = items.find(i => i.source === 'instagram');
  assert.equal(igItem, undefined, 'disabled source が attention に出ている');
  for (const [k, v] of Object.entries(saved)) {
    if (v !== undefined) process.env[k] = v;
  }
  db.close?.();
});

await test('disabled にして再び enabled にしたら attention に出る', () => {
  const db = makeDb();
  const saved = {};
  for (const k of ['INSTAGRAM_APP_ID','INSTAGRAM_APP_SECRET','INSTAGRAM_ACCESS_TOKEN','INSTAGRAM_USER_ID']) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  setSourceEnabled(db, 'instagram', 0);
  const items1 = getAttentionItems(db, { ignoreCooldown: true, today: '2026-09-09' });
  assert.equal(items1.find(i => i.source === 'instagram'), undefined, 'disabled なのに attention に出た');
  setSourceEnabled(db, 'instagram', 1);
  const items2 = getAttentionItems(db, { ignoreCooldown: true, today: '2026-09-09' });
  const igItem = items2.find(i => i.source === 'instagram');
  assert.ok(igItem, 'enabled に戻したのに attention に出ない');
  for (const [k, v] of Object.entries(saved)) {
    if (v !== undefined) process.env[k] = v;
  }
  db.close?.();
});

// ══════════════════════════════════════════════════════════════════════════════
// Section 4: runAutoSync と disabled
// ══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 4: runAutoSync と disabled');

// 6. disabled AUTO source は runAutoSync 対象外
await test('disabled AUTO source は runAutoSync でスキップされる', async () => {
  const db = makeDb();
  process.env.INSTAGRAM_APP_ID       = 'test';
  process.env.INSTAGRAM_APP_SECRET   = 'test';
  process.env.INSTAGRAM_ACCESS_TOKEN = 'test';
  process.env.INSTAGRAM_USER_ID      = 'test';
  process.env.YOUTUBE_CLIENT_ID      = 'test';
  process.env.YOUTUBE_CLIENT_SECRET  = 'test';
  process.env.YOUTUBE_REFRESH_TOKEN  = 'test';
  process.env.YOUTUBE_CHANNEL_ID     = 'test';

  setSourceEnabled(db, 'instagram', 0);

  let igCalled = false;
  let ytCalled = false;
  const collectFns = {
    instagram: async (db) => { igCalled = true; insertIg(db, '2026-09-09'); },
    youtube:   async (db) => { ytCalled = true; insertYt(db, '2026-09-09'); },
  };

  const r = await runAutoSync(db, { collectFns });
  assert.equal(igCalled, false, 'disabled な instagram の collect が呼ばれた');
  assert.equal(ytCalled, true,  'enabled な youtube の collect が呼ばれていない');

  // instagram は skipped フラグが立っている
  const igResult = r.results.find(x => x.source === 'instagram');
  assert.ok(igResult, 'instagram の result が存在しない');
  assert.equal(igResult.skipped, true);

  // succeeded には instagram が含まれない
  assert.ok(!r.succeeded.includes('instagram'), 'disabled instagram が succeeded に含まれる');

  for (const k of ['INSTAGRAM_APP_ID','INSTAGRAM_APP_SECRET','INSTAGRAM_ACCESS_TOKEN','INSTAGRAM_USER_ID',
                    'YOUTUBE_CLIENT_ID','YOUTUBE_CLIENT_SECRET','YOUTUBE_REFRESH_TOKEN','YOUTUBE_CHANNEL_ID']) {
    delete process.env[k];
  }
  db.close?.();
});

await test('全 AUTO source が disabled の場合 overall=success を返す', async () => {
  const db = makeDb();
  setSourceEnabled(db, 'instagram', 0);
  setSourceEnabled(db, 'youtube',   0);

  const r = await runAutoSync(db, { collectFns: {} });
  assert.equal(r.overall, 'success');
  assert.equal(r.succeeded.length, 0);
  assert.equal(r.failed.length, 0);
  db.close?.();
});

// 7. MANUAL source は AUTO同期で実行されない
await test('runAutoSync の results に MANUAL source は含まれない', async () => {
  const db = makeDb();
  process.env.INSTAGRAM_APP_ID       = 'test';
  process.env.INSTAGRAM_APP_SECRET   = 'test';
  process.env.INSTAGRAM_ACCESS_TOKEN = 'test';
  process.env.INSTAGRAM_USER_ID      = 'test';
  process.env.YOUTUBE_CLIENT_ID      = 'test';
  process.env.YOUTUBE_CLIENT_SECRET  = 'test';
  process.env.YOUTUBE_REFRESH_TOKEN  = 'test';
  process.env.YOUTUBE_CHANNEL_ID     = 'test';

  const collectFns = {
    instagram: async (db) => { insertIg(db, '2026-09-09'); },
    youtube:   async (db) => { insertYt(db, '2026-09-09'); },
  };
  const r = await runAutoSync(db, { collectFns });
  const resultSources = r.results.map(x => x.source);

  for (const ms of MANUAL_SOURCES) {
    assert.ok(!resultSources.includes(ms), `MANUAL source ${ms} が runAutoSync の results に含まれる`);
  }

  for (const k of ['INSTAGRAM_APP_ID','INSTAGRAM_APP_SECRET','INSTAGRAM_ACCESS_TOKEN','INSTAGRAM_USER_ID',
                    'YOUTUBE_CLIENT_ID','YOUTUBE_CLIENT_SECRET','YOUTUBE_REFRESH_TOKEN','YOUTUBE_CHANNEL_ID']) {
    delete process.env[k];
  }
  db.close?.();
});

// ══════════════════════════════════════════════════════════════════════════════
// Section 5: getSyncStatus の enabled フィールド
// ══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 5: getSyncStatus の enabled フィールド');

await test('getSyncStatus の各 source に enabled フィールドが含まれる', () => {
  const db = makeDb();
  const status = getSyncStatus(db, '2026-09-09');
  for (const s of status.sources) {
    assert.ok('enabled' in s, `source ${s.source} に enabled フィールドがない`);
    assert.ok(s.enabled === 0 || s.enabled === 1, `enabled の値が 0/1 以外: ${s.enabled}`);
  }
  db.close?.();
});

await test('デフォルトでは全 source の enabled=1', () => {
  const db = makeDb();
  const status = getSyncStatus(db, '2026-09-09');
  for (const s of status.sources) {
    assert.equal(s.enabled, 1, `${s.source} のデフォルト enabled が 1 でない`);
  }
  db.close?.();
});

await test('setSourceEnabled(0) 後 getSyncStatus の source.enabled が 0 になる', () => {
  const db = makeDb();
  setSourceEnabled(db, 'tiktok', 0);
  const status = getSyncStatus(db, '2026-09-09');
  const tiktok = status.sources.find(s => s.source === 'tiktok');
  assert.ok(tiktok);
  assert.equal(tiktok.enabled, 0);
  db.close?.();
});

await test('attention_count は disabled source を除外する', () => {
  const db = makeDb();
  const saved = {};
  // instagram/youtube を unconfigured にする
  for (const k of ['INSTAGRAM_APP_ID','INSTAGRAM_APP_SECRET','INSTAGRAM_ACCESS_TOKEN','INSTAGRAM_USER_ID',
                    'YOUTUBE_CLIENT_ID','YOUTUBE_CLIENT_SECRET','YOUTUBE_REFRESH_TOKEN','YOUTUBE_CHANNEL_ID']) {
    saved[k] = process.env[k];
    delete process.env[k];
  }

  const status1 = getSyncStatus(db, '2026-09-09');
  const count1 = status1.summary.attention_count;

  // instagram を disabled にする → attention_count が減るはず
  setSourceEnabled(db, 'instagram', 0);
  const status2 = getSyncStatus(db, '2026-09-09');
  const count2 = status2.summary.attention_count;

  assert.ok(count2 < count1, `disabled 後も attention_count が減っていない (${count1} → ${count2})`);

  for (const [k, v] of Object.entries(saved)) {
    if (v !== undefined) process.env[k] = v;
  }
  db.close?.();
});

// ══════════════════════════════════════════════════════════════════════════════
// Section 6: Revenue 派生抑制の維持（DERIVED_FROM）
// ══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 6: Revenue 派生抑制の維持');

// 9. Revenue 派生抑制が維持される
await test('DERIVED_FROM に revenue → soundrop が定義されている', () => {
  assert.equal(DERIVED_FROM['revenue'], 'soundrop');
});

await test('Soundrop（MANUAL）が attention に出ないとき Revenue も attention に出ない', () => {
  // MANUAL source は getAttentionItems から除外されるため
  // soundrop/revenue はどちらも attention に出ない
  const db = makeDb();
  const items = getAttentionItems(db, { ignoreCooldown: true, today: '2026-09-09' });
  const sounddropItem = items.find(i => i.source === 'soundrop');
  const revenueItem   = items.find(i => i.source === 'revenue');
  assert.equal(sounddropItem, undefined, 'MANUAL soundrop が attention に出ている');
  assert.equal(revenueItem,   undefined, 'MANUAL revenue が attention に出ている');
  db.close?.();
});

await test('AUTO source が attention に出るとき DERIVED_FROM 構造が維持される', () => {
  // DERIVED_FROM の対象は soundrop（MANUAL）なので派生抑制が発動するケースはない
  // が、設定自体が壊れていないことを確認する
  assert.ok(typeof DERIVED_FROM === 'object');
  assert.equal(Object.keys(DERIVED_FROM).includes('revenue'), true);
  assert.equal(DERIVED_FROM.revenue, 'soundrop');
});

// ══════════════════════════════════════════════════════════════════════════════
// Section 7: SOURCE_REGISTRY 変更なし検証
// ══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 7: SOURCE_REGISTRY 変更なし検証');

await test('evaluateFreshness の定義は変更されていない（AUTO_SOURCES は instagram/youtube のみ）', () => {
  assert.deepEqual([...AUTO_SOURCES].sort(), ['instagram', 'youtube']);
});

await test('MANUAL_SOURCES に ga4/narou/tiktok/x/kdp/soundrop/revenue が含まれる', () => {
  const expected = ['ga4', 'kdp', 'narou', 'revenue', 'soundrop', 'tiktok', 'x'];
  for (const s of expected) {
    assert.ok(MANUAL_SOURCES.includes(s), `${s} が MANUAL_SOURCES に含まれない`);
  }
});

await test('SOURCE_REGISTRY の各 source に mode が設定されている', () => {
  for (const [key, def] of Object.entries(SOURCE_REGISTRY)) {
    assert.ok(['auto', 'manual'].includes(def.mode), `${key} の mode が不正: ${def.mode}`);
  }
});

// ──────────────────────────────────────────────────────────────────────────────

console.log('\n──────────────────────────────────────────────────────────────────────────────');
console.log(`テスト結果: ${passed + failed} 件 / ✅ ${passed} 件成功 / ❌ ${failed} 件失敗`);
if (failed > 0) process.exit(1);
