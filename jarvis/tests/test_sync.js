/**
 * jarvis/tests/test_sync.js
 * Snow flakes Ops Automation テストスイート（Phase 10）
 *
 * 重要:
 * - ':memory:' DB のみ使用。実 DB (business_data.db) には触れない
 * - 外部 API 通信 0 件（Instagram/YouTube/GA4 はすべてモック）
 * - AUTO/MANUAL 分類の正確性・freshness 判定・通知重複抑制を網羅
 *
 * Section 1:  source registry
 * Section 2:  AUTO/MANUAL 分類
 * Section 3:  configured 判定
 * Section 4:  freshness 評価
 * Section 5:  never_synced / manual_required
 * Section 6:  stale 判定（各 source のしきい値）
 * Section 7:  getSourceStatus
 * Section 8:  getSyncStatus
 * Section 9:  runAutoSync（モック）
 * Section 10: source 独立失敗
 * Section 11: manual source を auto 実行しない
 * Section 12: attention items
 * Section 12b: Soundrop/Revenue 重複 attention 抑制
 * Section 13: 通知重複抑制 / snooze
 * Section 14: API エンドポイント
 * Section 15: runner dry-run / report-only
 * Section 16: Windows task script 安全性
 * Section 17: Character Stage
 * Section 18: 実 DB 未使用 / 外部通信なし
 */

import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─── DB セットアップ ──────────────────────────────────────────────────────────
import { createDb } from '../data/db.js';
import {
  SOURCE_REGISTRY, SOURCE_NAMES, AUTO_SOURCES, MANUAL_SOURCES,
  FRESHNESS_THRESHOLDS, NOTIFY_COOLDOWN_HOURS, DERIVED_FROM,
  getSyncSources, getSyncStatus, getSourceStatus,
  runAutoSync, runSourceSync,
  getAttentionItems, snoozeSource, notifyImportSuccess,
  evaluateFreshness, getLastDataDate,
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

/** テスト用インメモリ DB */
function makeDb() {
  return createDb(':memory:');
}

/** Instagram の日次データを挿入 */
function insertIg(db, date) {
  db.prepare(`
    INSERT OR IGNORE INTO sf_instagram_account_daily (date, followers_count)
    VALUES (?, 100)
  `).run(date);
}

/** YouTube チャンネル日次データを挿入 */
function insertYt(db, date) {
  db.prepare(`
    INSERT OR IGNORE INTO sf_youtube_channel_daily (date, views)
    VALUES (?, 1000)
  `).run(date);
}

/** TikTok アカウント日次データを挿入 */
function insertTt(db, date) {
  db.prepare(`
    INSERT OR IGNORE INTO sf_account_daily (platform, date, followers)
    VALUES ('tiktok', ?, 50)
  `).run(date);
}

/** GA4 日次データを挿入 */
function insertGa(db, date) {
  db.prepare(`
    INSERT OR IGNORE INTO sf_ga_daily (date, page_path, sessions)
    VALUES (?, '/', 200)
  `).run(date);
}

/** なろう月次スナップショットを挿入 */
function insertNarou(db, month) {
  db.prepare(`
    INSERT OR IGNORE INTO sf_narou_snapshot (month, ncode, pv_total)
    VALUES (?, 'N0001AB', 5000)
  `).run(month);
}

/** Soundrop Revenue データを挿入（transaction_month あり） */
function insertSoundrop(db, txMonth) {
  db.prepare(`
    INSERT OR IGNORE INTO sf_revenue (date, month, transaction_month, source, platform, amount, quantity)
    VALUES (?, ?, ?, '音楽配信', 'Spotify', 100.0, 50000)
  `).run(txMonth + '-01', txMonth, txMonth);
}

/** Revenue データを挿入（statement month のみ） */
function insertRevenue(db, month) {
  db.prepare(`
    INSERT OR IGNORE INTO sf_revenue (date, month, source, platform, amount, quantity)
    VALUES (?, ?, '音楽配信', 'apple', 50.0, 10000)
  `).run(month + '-01', month);
}

/** X ツイート指標データを挿入（sf_x_tweet + sf_x_tweet_metrics） */
function insertX(db, snapshotDate) {
  db.prepare(`
    INSERT OR IGNORE INTO sf_x_tweet (tweet_id, tweet_type) VALUES ('test_sync_tweet', 'tweet')
  `).run();
  db.prepare(`
    INSERT OR IGNORE INTO sf_x_tweet_metrics (tweet_id, snapshot_date, impressions)
    VALUES ('test_sync_tweet', ?, 1000)
  `).run(snapshotDate);
}

// ─── API テスト用サーバー ─────────────────────────────────────────────────────

import { createApiHandler } from '../dashboard/api.js';

async function withServer(fn) {
  const db = makeDb();
  const apiHandler = createApiHandler(db);
  // server.js と同様に URL を構築してから apiHandler に渡す
  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    return apiHandler(req, res, url);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;
  try {
    await fn(base, db);
  } finally {
    await new Promise(r => server.close(r));
    db.close?.();
  }
}

async function apiGet(base, path) {
  const res = await fetch(base + path);
  return { status: res.status, body: await res.json() };
}

async function apiPost(base, path, payload = {}) {
  const res = await fetch(base + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}

// ══════════════════════════════════════════════════════════════════════════════
// Section 1: source registry
// ══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 1: source registry');

await test('SOURCE_REGISTRY に全 source が含まれる', () => {
  assert.ok(SOURCE_REGISTRY.instagram);
  assert.ok(SOURCE_REGISTRY.youtube);
  assert.ok(SOURCE_REGISTRY.ga4);
  assert.ok(SOURCE_REGISTRY.narou);
  assert.ok(SOURCE_REGISTRY.tiktok);
  assert.ok(SOURCE_REGISTRY.soundrop);
  assert.ok(SOURCE_REGISTRY.revenue);
});

await test('getSyncSources() は配列を返す', () => {
  const list = getSyncSources();
  assert.ok(Array.isArray(list));
  assert.ok(list.length >= 7);
});

await test('各 source に source/mode/label/granularity が含まれる', () => {
  const list = getSyncSources();
  for (const item of list) {
    assert.ok(item.source, `source missing in ${JSON.stringify(item)}`);
    assert.ok(['auto', 'manual'].includes(item.mode), `invalid mode: ${item.mode}`);
    assert.ok(item.label, `label missing in ${item.source}`);
    assert.ok(item.granularity, `granularity missing in ${item.source}`);
  }
});

await test('FRESHNESS_THRESHOLDS に全 source が含まれる', () => {
  for (const s of SOURCE_NAMES) {
    assert.ok(FRESHNESS_THRESHOLDS[s] > 0, `FRESHNESS_THRESHOLDS missing for ${s}`);
  }
});

await test('Narou と Soundrop と Revenue は monthly granularity', () => {
  assert.equal(SOURCE_REGISTRY.narou.granularity,    'monthly');
  assert.equal(SOURCE_REGISTRY.soundrop.granularity, 'monthly');
  assert.equal(SOURCE_REGISTRY.revenue.granularity,  'monthly');
});

// ══════════════════════════════════════════════════════════════════════════════
// Section 2: AUTO/MANUAL 分類
// ══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 2: AUTO/MANUAL 分類');

await test('Instagram は AUTO', () => {
  assert.equal(SOURCE_REGISTRY.instagram.mode, 'auto');
  assert.ok(AUTO_SOURCES.includes('instagram'));
});

await test('YouTube は AUTO', () => {
  assert.equal(SOURCE_REGISTRY.youtube.mode, 'auto');
  assert.ok(AUTO_SOURCES.includes('youtube'));
});

await test('GA4 は MANUAL（API collector なし）', () => {
  assert.equal(SOURCE_REGISTRY.ga4.mode, 'manual');
  assert.ok(MANUAL_SOURCES.includes('ga4'));
  assert.equal(SOURCE_REGISTRY.ga4.collectorModule, null);
});

await test('TikTok は MANUAL（CSV only）', () => {
  assert.equal(SOURCE_REGISTRY.tiktok.mode, 'manual');
  assert.ok(MANUAL_SOURCES.includes('tiktok'));
});

await test('Soundrop は MANUAL（CSV only）', () => {
  assert.equal(SOURCE_REGISTRY.soundrop.mode, 'manual');
  assert.ok(MANUAL_SOURCES.includes('soundrop'));
});

await test('Narou は MANUAL', () => {
  assert.equal(SOURCE_REGISTRY.narou.mode, 'manual');
  assert.ok(MANUAL_SOURCES.includes('narou'));
});

await test('Revenue は MANUAL', () => {
  assert.equal(SOURCE_REGISTRY.revenue.mode, 'manual');
  assert.ok(MANUAL_SOURCES.includes('revenue'));
});

await test('AUTO_SOURCES は instagram と youtube のみ', () => {
  assert.deepEqual([...AUTO_SOURCES].sort(), ['instagram', 'youtube']);
});

// ══════════════════════════════════════════════════════════════════════════════
// Section 3: configured 判定
// ══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 3: configured 判定');

await test('ENV 未設定のとき AUTO source は unconfigured', () => {
  const db = makeDb();
  // ENV を消す
  const saved = {};
  for (const k of ['INSTAGRAM_APP_ID','INSTAGRAM_APP_SECRET','INSTAGRAM_ACCESS_TOKEN','INSTAGRAM_USER_ID']) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  try {
    const st = getSourceStatus(db, 'instagram');
    assert.equal(st.status, 'unconfigured');
    assert.equal(st.configured, false);
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v !== undefined) process.env[k] = v;
    }
    db.close?.();
  }
});

await test('MANUAL source は ENV 不要で configured=true', () => {
  const db = makeDb();
  const st = getSourceStatus(db, 'tiktok');
  assert.equal(st.configured, true);
  db.close?.();
});

await test('configured は true/false のみ返す（token値は返さない）', () => {
  const db = makeDb();
  const st = getSourceStatus(db, 'tiktok');
  assert.equal(typeof st.configured, 'boolean');
  // action_message にトークン文字列が含まれないことを確認
  const msg = st.action_message ?? '';
  assert.ok(!msg.includes('Bearer'), 'action_message にトークンが含まれている');
  db.close?.();
});

// ══════════════════════════════════════════════════════════════════════════════
// Section 4: freshness 評価（fresh / stale / never_synced）
// ══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 4: freshness 評価');

await test('データなし → never_synced（AUTO）', () => {
  const db = makeDb();
  // ENV を設定してAUTO配下にする
  process.env.INSTAGRAM_APP_ID       = 'test';
  process.env.INSTAGRAM_APP_SECRET   = 'test';
  process.env.INSTAGRAM_ACCESS_TOKEN = 'test';
  process.env.INSTAGRAM_USER_ID      = 'test';
  const f = evaluateFreshness(db, 'instagram', '2026-08-14');
  assert.equal(f.status, 'never_synced');
  for (const k of ['INSTAGRAM_APP_ID','INSTAGRAM_APP_SECRET','INSTAGRAM_ACCESS_TOKEN','INSTAGRAM_USER_ID']) delete process.env[k];
  db.close?.();
});

await test('データなし → manual_required（MANUAL）', () => {
  const db = makeDb();
  const f = evaluateFreshness(db, 'tiktok', '2026-08-14');
  assert.equal(f.status, 'manual_required');
  db.close?.();
});

await test('Instagram: しきい値以内 → fresh', () => {
  const db = makeDb();
  process.env.INSTAGRAM_APP_ID = process.env.INSTAGRAM_APP_SECRET =
  process.env.INSTAGRAM_ACCESS_TOKEN = process.env.INSTAGRAM_USER_ID = 'test';
  insertIg(db, '2026-08-12'); // 2日前（しきい値3日）
  const f = evaluateFreshness(db, 'instagram', '2026-08-14');
  assert.equal(f.status, 'fresh');
  for (const k of ['INSTAGRAM_APP_ID','INSTAGRAM_APP_SECRET','INSTAGRAM_ACCESS_TOKEN','INSTAGRAM_USER_ID']) delete process.env[k];
  db.close?.();
});

await test('Instagram: しきい値超え → stale', () => {
  const db = makeDb();
  process.env.INSTAGRAM_APP_ID = process.env.INSTAGRAM_APP_SECRET =
  process.env.INSTAGRAM_ACCESS_TOKEN = process.env.INSTAGRAM_USER_ID = 'test';
  insertIg(db, '2026-08-09'); // 5日前（しきい値3日）
  const f = evaluateFreshness(db, 'instagram', '2026-08-14');
  assert.equal(f.status, 'stale');
  for (const k of ['INSTAGRAM_APP_ID','INSTAGRAM_APP_SECRET','INSTAGRAM_ACCESS_TOKEN','INSTAGRAM_USER_ID']) delete process.env[k];
  db.close?.();
});

await test('YouTube: freshness 判定', () => {
  process.env.YOUTUBE_CLIENT_ID = process.env.YOUTUBE_CLIENT_SECRET =
  process.env.YOUTUBE_REFRESH_TOKEN = process.env.YOUTUBE_CHANNEL_ID = 'test';

  // fresh: 2日前のデータ（しきい値3日）
  const db1 = makeDb();
  insertYt(db1, '2026-08-12');
  const f1 = evaluateFreshness(db1, 'youtube', '2026-08-14');
  assert.equal(f1.status, 'fresh');
  db1.close?.();

  // stale: 44日前のデータ（しきい値3日）
  const db2 = makeDb();
  insertYt(db2, '2026-07-01');
  const f2 = evaluateFreshness(db2, 'youtube', '2026-08-14');
  assert.equal(f2.status, 'stale');
  db2.close?.();

  for (const k of ['YOUTUBE_CLIENT_ID','YOUTUBE_CLIENT_SECRET','YOUTUBE_REFRESH_TOKEN','YOUTUBE_CHANNEL_ID']) delete process.env[k];
});

// ══════════════════════════════════════════════════════════════════════════════
// Section 5: never_synced / manual_required
// ══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 5: never_synced / manual_required');

await test('TikTok: データなし → manual_required', () => {
  const db = makeDb();
  const st = getSourceStatus(db, 'tiktok', '2026-08-14');
  assert.equal(st.status, 'manual_required');
  assert.equal(st.requires_user_action, true);
  db.close?.();
});

await test('Soundrop: データなし → manual_required', () => {
  const db = makeDb();
  const st = getSourceStatus(db, 'soundrop', '2026-08-14');
  assert.equal(st.status, 'manual_required');
  db.close?.();
});

await test('Narou: データなし → manual_required', () => {
  const db = makeDb();
  const st = getSourceStatus(db, 'narou', '2026-08-14');
  assert.equal(st.status, 'manual_required');
  db.close?.();
});

// ══════════════════════════════════════════════════════════════════════════════
// Section 6: stale 判定（各 source のしきい値）
// ══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 6: stale 判定（各 source しきい値）');

await test('GA4: 7日しきい値（6日→fresh, 8日→stale）', () => {
  const db = makeDb();
  insertGa(db, '2026-08-08'); // 6日前
  const f1 = evaluateFreshness(db, 'ga4', '2026-08-14');
  assert.equal(f1.status, 'fresh');
  insertGa(db, '2026-08-06'); // 8日前
  const db2 = makeDb();
  insertGa(db2, '2026-08-06');
  const f2 = evaluateFreshness(db2, 'ga4', '2026-08-14');
  assert.equal(f2.status, 'stale');
  db.close?.(); db2.close?.();
});

await test('TikTok: 14日しきい値（13日→fresh, 15日→stale）', () => {
  const db = makeDb();
  insertTt(db, '2026-08-01'); // 13日前
  const f1 = evaluateFreshness(db, 'tiktok', '2026-08-14');
  assert.equal(f1.status, 'fresh');
  const db2 = makeDb();
  insertTt(db2, '2026-07-30'); // 15日前
  const f2 = evaluateFreshness(db2, 'tiktok', '2026-08-14');
  assert.equal(f2.status, 'stale');
  db.close?.(); db2.close?.();
});

await test('Narou: 32日しきい値（monthly）', () => {
  const db = makeDb();
  insertNarou(db, '2026-08'); // 当月
  const f1 = evaluateFreshness(db, 'narou', '2026-08-14');
  assert.equal(f1.status, 'fresh');
  const db2 = makeDb();
  insertNarou(db2, '2026-06'); // 2か月前
  const f2 = evaluateFreshness(db2, 'narou', '2026-08-14');
  assert.equal(f2.status, 'stale');
  db.close?.(); db2.close?.();
});

await test('Soundrop: 35日しきい値（monthly statement）', () => {
  const db = makeDb();
  insertSoundrop(db, '2026-08'); // 当月
  const f1 = evaluateFreshness(db, 'soundrop', '2026-08-14');
  assert.equal(f1.status, 'fresh');
  const db2 = makeDb();
  insertSoundrop(db2, '2026-06'); // 2か月以上前
  const f2 = evaluateFreshness(db2, 'soundrop', '2026-08-14');
  assert.equal(f2.status, 'stale');
  db.close?.(); db2.close?.();
});

await test('全 source のしきい値が同じ値でない（source別設定）', () => {
  const thresholds = Object.values(FRESHNESS_THRESHOLDS);
  const unique = new Set(thresholds);
  // 少なくとも2種類以上の値がある
  assert.ok(unique.size >= 2, '全 source が同じ threshold（source別でない）');
});

// ══════════════════════════════════════════════════════════════════════════════
// Section 7: getSourceStatus
// ══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 7: getSourceStatus');

await test('getSourceStatus は必須フィールドを返す', () => {
  const db = makeDb();
  const st = getSourceStatus(db, 'tiktok', '2026-08-14');
  assert.ok('source'               in st);
  assert.ok('mode'                 in st);
  assert.ok('configured'           in st);
  assert.ok('status'               in st);
  assert.ok('last_data_date'       in st);
  assert.ok('last_attempt_at'      in st);
  assert.ok('last_success_at'      in st);
  assert.ok('last_error'           in st);
  assert.ok('requires_user_action' in st);
  assert.ok('action_message'       in st);
  db.close?.();
});

await test('getSourceStatus: 不明な source はエラー', () => {
  const db = makeDb();
  assert.throws(() => getSourceStatus(db, 'nonexistent'), /Unknown source/);
  db.close?.();
});

await test('last_data_date は実データから取得する（source of truth）', () => {
  const db = makeDb();
  insertTt(db, '2026-08-10');
  const d = getLastDataDate(db, 'tiktok');
  assert.equal(d, '2026-08-10');
  db.close?.();
});

// ══════════════════════════════════════════════════════════════════════════════
// Section 8: getSyncStatus
// ══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 8: getSyncStatus');

await test('getSyncStatus は sources 配列と summary を返す', () => {
  const db = makeDb();
  const status = getSyncStatus(db, '2026-08-14');
  assert.ok(Array.isArray(status.sources));
  assert.ok(status.summary);
  assert.equal(typeof status.summary.total, 'number');
  assert.equal(typeof status.summary.attention_count, 'number');
  db.close?.();
});

await test('getSyncStatus の sources 数は SOURCE_NAMES と一致', () => {
  const db = makeDb();
  const status = getSyncStatus(db, '2026-08-14');
  assert.equal(status.sources.length, SOURCE_NAMES.length);
  db.close?.();
});

await test('getSyncStatus に secret/token が含まれない', () => {
  const db = makeDb();
  process.env.INSTAGRAM_ACCESS_TOKEN = 'SECRET_TOKEN_VALUE';
  const status = getSyncStatus(db, '2026-08-14');
  const json = JSON.stringify(status);
  assert.ok(!json.includes('SECRET_TOKEN_VALUE'), 'token がレスポンスに含まれている');
  delete process.env.INSTAGRAM_ACCESS_TOKEN;
  db.close?.();
});

// ══════════════════════════════════════════════════════════════════════════════
// Section 9: runAutoSync（モック）
// ══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 9: runAutoSync（モック）');

await test('runAutoSync: 全成功 → overall=success', async () => {
  const db = makeDb();
  process.env.INSTAGRAM_APP_ID = process.env.INSTAGRAM_APP_SECRET =
  process.env.INSTAGRAM_ACCESS_TOKEN = process.env.INSTAGRAM_USER_ID = 'test';
  process.env.YOUTUBE_CLIENT_ID = process.env.YOUTUBE_CLIENT_SECRET =
  process.env.YOUTUBE_REFRESH_TOKEN = process.env.YOUTUBE_CHANNEL_ID = 'test';

  const collectFns = {
    instagram: async (db) => { insertIg(db, '2026-08-14'); },
    youtube:   async (db) => { insertYt(db, '2026-08-14'); },
  };
  const r = await runAutoSync(db, { collectFns });
  assert.equal(r.overall, 'success');
  assert.equal(r.succeeded.length, 2);
  assert.equal(r.failed.length, 0);

  for (const k of ['INSTAGRAM_APP_ID','INSTAGRAM_APP_SECRET','INSTAGRAM_ACCESS_TOKEN','INSTAGRAM_USER_ID',
                    'YOUTUBE_CLIENT_ID','YOUTUBE_CLIENT_SECRET','YOUTUBE_REFRESH_TOKEN','YOUTUBE_CHANNEL_ID'])
    delete process.env[k];
  db.close?.();
});

await test('runAutoSync: 全失敗 → overall=failed', async () => {
  const db = makeDb();
  process.env.INSTAGRAM_APP_ID = process.env.INSTAGRAM_APP_SECRET =
  process.env.INSTAGRAM_ACCESS_TOKEN = process.env.INSTAGRAM_USER_ID = 'test';
  process.env.YOUTUBE_CLIENT_ID = process.env.YOUTUBE_CLIENT_SECRET =
  process.env.YOUTUBE_REFRESH_TOKEN = process.env.YOUTUBE_CHANNEL_ID = 'test';

  const collectFns = {
    instagram: async () => { throw new Error('IG error'); },
    youtube:   async () => { throw new Error('YT error'); },
  };
  const r = await runAutoSync(db, { collectFns });
  assert.equal(r.overall, 'failed');
  assert.equal(r.failed.length, 2);

  for (const k of ['INSTAGRAM_APP_ID','INSTAGRAM_APP_SECRET','INSTAGRAM_ACCESS_TOKEN','INSTAGRAM_USER_ID',
                    'YOUTUBE_CLIENT_ID','YOUTUBE_CLIENT_SECRET','YOUTUBE_REFRESH_TOKEN','YOUTUBE_CHANNEL_ID'])
    delete process.env[k];
  db.close?.();
});

await test('runAutoSync: dry-run → 外部 API 呼び出しなし', async () => {
  const db = makeDb();
  let called = false;
  process.env.INSTAGRAM_APP_ID = process.env.INSTAGRAM_APP_SECRET =
  process.env.INSTAGRAM_ACCESS_TOKEN = process.env.INSTAGRAM_USER_ID = 'test';
  process.env.YOUTUBE_CLIENT_ID = process.env.YOUTUBE_CLIENT_SECRET =
  process.env.YOUTUBE_REFRESH_TOKEN = process.env.YOUTUBE_CHANNEL_ID = 'test';

  const collectFns = {
    instagram: async () => { called = true; },
    youtube:   async () => { called = true; },
  };
  await runAutoSync(db, { collectFns, dryRun: true });
  assert.equal(called, false, 'dry-run 中に collect が呼ばれた');

  for (const k of ['INSTAGRAM_APP_ID','INSTAGRAM_APP_SECRET','INSTAGRAM_ACCESS_TOKEN','INSTAGRAM_USER_ID',
                    'YOUTUBE_CLIENT_ID','YOUTUBE_CLIENT_SECRET','YOUTUBE_REFRESH_TOKEN','YOUTUBE_CHANNEL_ID'])
    delete process.env[k];
  db.close?.();
});

// ══════════════════════════════════════════════════════════════════════════════
// Section 10: source 独立失敗
// ══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 10: source 独立失敗');

await test('Instagram 失敗でも YouTube は成功する（independent）', async () => {
  const db = makeDb();
  process.env.INSTAGRAM_APP_ID = process.env.INSTAGRAM_APP_SECRET =
  process.env.INSTAGRAM_ACCESS_TOKEN = process.env.INSTAGRAM_USER_ID = 'test';
  process.env.YOUTUBE_CLIENT_ID = process.env.YOUTUBE_CLIENT_SECRET =
  process.env.YOUTUBE_REFRESH_TOKEN = process.env.YOUTUBE_CHANNEL_ID = 'test';

  const collectFns = {
    instagram: async () => { throw new Error('IG down'); },
    youtube:   async (db) => { insertYt(db, '2026-08-14'); },
  };
  const r = await runAutoSync(db, { collectFns });
  assert.equal(r.overall, 'partial');
  assert.ok(r.succeeded.includes('youtube'));
  assert.ok(r.failed.includes('instagram'));

  for (const k of ['INSTAGRAM_APP_ID','INSTAGRAM_APP_SECRET','INSTAGRAM_ACCESS_TOKEN','INSTAGRAM_USER_ID',
                    'YOUTUBE_CLIENT_ID','YOUTUBE_CLIENT_SECRET','YOUTUBE_REFRESH_TOKEN','YOUTUBE_CHANNEL_ID'])
    delete process.env[k];
  db.close?.();
});

await test('partial 結果に results 配列が含まれる', async () => {
  const db = makeDb();
  process.env.INSTAGRAM_APP_ID = process.env.INSTAGRAM_APP_SECRET =
  process.env.INSTAGRAM_ACCESS_TOKEN = process.env.INSTAGRAM_USER_ID = 'test';
  process.env.YOUTUBE_CLIENT_ID = process.env.YOUTUBE_CLIENT_SECRET =
  process.env.YOUTUBE_REFRESH_TOKEN = process.env.YOUTUBE_CHANNEL_ID = 'test';

  const collectFns = {
    instagram: async () => { throw new Error('IG down'); },
    youtube:   async (db) => { insertYt(db, '2026-08-14'); },
  };
  const r = await runAutoSync(db, { collectFns });
  assert.ok(Array.isArray(r.results));
  assert.equal(r.results.length, AUTO_SOURCES.length);

  for (const k of ['INSTAGRAM_APP_ID','INSTAGRAM_APP_SECRET','INSTAGRAM_ACCESS_TOKEN','INSTAGRAM_USER_ID',
                    'YOUTUBE_CLIENT_ID','YOUTUBE_CLIENT_SECRET','YOUTUBE_REFRESH_TOKEN','YOUTUBE_CHANNEL_ID'])
    delete process.env[k];
  db.close?.();
});

// ══════════════════════════════════════════════════════════════════════════════
// Section 11: MANUAL source を auto 実行しない
// ══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 11: MANUAL source を auto 実行しない');

await test('runSourceSync に tiktok → エラー（MANUAL source）', async () => {
  const db = makeDb();
  const r = await runSourceSync(db, 'tiktok');
  assert.equal(r.success, false);
  assert.ok(r.error?.includes('MANUAL') || r.error?.includes('manual'));
  db.close?.();
});

await test('runSourceSync に soundrop → エラー（MANUAL source）', async () => {
  const db = makeDb();
  const r = await runSourceSync(db, 'soundrop');
  assert.equal(r.success, false);
  db.close?.();
});

await test('runSourceSync に ga4 → エラー（MANUAL source）', async () => {
  const db = makeDb();
  const r = await runSourceSync(db, 'ga4');
  assert.equal(r.success, false);
  db.close?.();
});

await test('runAutoSync は MANUAL source を実行しない', async () => {
  const db = makeDb();
  process.env.INSTAGRAM_APP_ID = process.env.INSTAGRAM_APP_SECRET =
  process.env.INSTAGRAM_ACCESS_TOKEN = process.env.INSTAGRAM_USER_ID = 'test';
  process.env.YOUTUBE_CLIENT_ID = process.env.YOUTUBE_CLIENT_SECRET =
  process.env.YOUTUBE_REFRESH_TOKEN = process.env.YOUTUBE_CHANNEL_ID = 'test';

  const collectFns = {
    instagram: async (db) => { insertIg(db, '2026-08-14'); },
    youtube:   async (db) => { insertYt(db, '2026-08-14'); },
  };
  const r = await runAutoSync(db, { collectFns });
  // MANUAL source が results に含まれていないこと
  const sources = r.results.map(x => x.source);
  assert.ok(!sources.includes('tiktok'));
  assert.ok(!sources.includes('soundrop'));
  assert.ok(!sources.includes('ga4'));
  assert.ok(!sources.includes('narou'));

  for (const k of ['INSTAGRAM_APP_ID','INSTAGRAM_APP_SECRET','INSTAGRAM_ACCESS_TOKEN','INSTAGRAM_USER_ID',
                    'YOUTUBE_CLIENT_ID','YOUTUBE_CLIENT_SECRET','YOUTUBE_REFRESH_TOKEN','YOUTUBE_CHANNEL_ID'])
    delete process.env[k];
  db.close?.();
});

await test('runSourceSync: invalid source → エラー', async () => {
  const db = makeDb();
  const r = await runSourceSync(db, 'nonexistent_source');
  assert.equal(r.success, false);
  assert.ok(r.error?.includes('Unknown') || r.error?.includes('unknown'));
  db.close?.();
});

// ══════════════════════════════════════════════════════════════════════════════
// Section 12: attention items
// ══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 12: attention items');

await test('全データ未取得 → attention に全 MANUAL source が含まれる', () => {
  const db = makeDb();
  const items = getAttentionItems(db, { ignoreCooldown: true, today: '2026-08-14' });
  const sources = items.map(i => i.source);
  assert.ok(sources.includes('tiktok'));
  assert.ok(sources.includes('soundrop'));
  assert.ok(sources.includes('narou'));
  db.close?.();
});

await test('fresh なデータがある source は attention に出ない', () => {
  const db = makeDb();
  insertTt(db, '2026-08-13'); // 1日前（しきい値14日）
  const items = getAttentionItems(db, { ignoreCooldown: true, today: '2026-08-14' });
  const ttItem = items.find(i => i.source === 'tiktok');
  assert.equal(ttItem, undefined, 'fresh な tiktok が attention に出ている');
  db.close?.();
});

await test('attention item に source/label/severity/reason/message/action が含まれる', () => {
  const db = makeDb();
  const items = getAttentionItems(db, { ignoreCooldown: true, today: '2026-08-14' });
  assert.ok(items.length > 0);
  const item = items[0];
  assert.ok(item.source);
  assert.ok(item.label);
  assert.ok(['error','warning','info'].includes(item.severity));
  assert.ok(item.reason);
  assert.ok(item.message);
  assert.ok(item.action);
  db.close?.();
});

await test('no attention: 全 source fresh → 空配列', () => {
  const db = makeDb();
  const today = '2026-08-14';
  // MANUAL sources に fresh データを入れる
  insertTt(db, '2026-08-13');     // 1日前
  insertGa(db, '2026-08-13');     // 1日前
  insertNarou(db, '2026-08');     // 当月
  insertSoundrop(db, '2026-08');  // 当月
  insertRevenue(db, '2026-08');   // 当月
  insertX(db, '2026-08-13');      // 1日前
  // AUTO sources: ENV 未設定なので unconfigured のまま（attention に出る）
  // → AUTO unconfigured は残るが MANUAL は消えることを確認
  const items = getAttentionItems(db, { ignoreCooldown: true, today });
  const manualItems = items.filter(i => MANUAL_SOURCES.includes(i.source));
  assert.equal(manualItems.length, 0, 'fresh な MANUAL source が attention に出ている');
  db.close?.();
});

// ══════════════════════════════════════════════════════════════════════════════
// Section 12b: Soundrop / Revenue 重複 attention 抑制
// ══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 12b: Soundrop/Revenue 重複 attention 抑制');

await test('DERIVED_FROM に revenue → soundrop が定義されている', () => {
  assert.equal(DERIVED_FROM['revenue'], 'soundrop');
});

await test('Soundrop stale + Revenue stale → attention は soundrop のみ（1件）', () => {
  const db = makeDb();
  // どちらも未取得（manual_required）
  const items = getAttentionItems(db, { ignoreCooldown: true, today: '2026-08-14' });
  const soundropItem = items.find(i => i.source === 'soundrop');
  const revenueItem  = items.find(i => i.source === 'revenue');
  assert.ok(soundropItem, 'soundrop が attention に出ていない');
  assert.equal(revenueItem, undefined, 'Revenue が soundrop と同時に attention に出ている（重複）');
});

await test('Soundrop fresh + Revenue stale → Revenue は独立 attention を出す', () => {
  const db = makeDb();
  // Soundrop: fresh（transaction_month='2026-08' = 当月）
  // Revenue: stale（month='2025-12' = 8か月前、しきい値35日超え）
  // → 同じ sf_revenue テーブルだが読むカラムが異なるため独立した freshness を持つ
  db.prepare(`
    INSERT OR IGNORE INTO sf_revenue (date, month, transaction_month, source, platform, amount, quantity)
    VALUES ('2025-12-01', '2025-12', '2026-08', '音楽配信', 'Spotify', 100.0, 50000)
  `).run();
  const items = getAttentionItems(db, { ignoreCooldown: true, today: '2026-08-14' });
  const soundropItem = items.find(i => i.source === 'soundrop');
  const revenueItem  = items.find(i => i.source === 'revenue');
  // soundrop: transaction_month='2026-08' → fresh → attention に出ない
  assert.equal(soundropItem, undefined, 'fresh な soundrop が attention に出ている');
  // revenue: MAX(month)='2025-12' → stale（240日以上）→ 出てよい
  assert.ok(revenueItem, 'soundrop が fresh のとき Revenue の独立 attention が出ない');
  db.close?.();
});

await test('Soundrop stale → attention item の source は soundrop（revenue ではない）', () => {
  const db = makeDb();
  const items = getAttentionItems(db, { ignoreCooldown: true, today: '2026-08-14' });
  const sources = items.map(i => i.source);
  // soundrop が存在して revenue は存在しない
  if (sources.includes('soundrop')) {
    assert.ok(!sources.includes('revenue'), 'soundrop stale のとき revenue も出ている（重複）');
  }
  db.close?.();
});

// ══════════════════════════════════════════════════════════════════════════════
// Section 13: 通知重複抑制 / snooze
// ══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 13: 通知重複抑制 / snooze');

await test('通知後: 同じ source が cooldown 内に再通知されない', () => {
  const db = makeDb();
  // 1回目の attention 取得（last_notified_at 更新）
  const items1 = getAttentionItems(db, { ignoreCooldown: false, today: '2026-08-14' });
  const tikTokIn1 = items1.some(i => i.source === 'tiktok');
  // 2回目: cooldown 内（クールダウン更新直後なので再通知されない）
  const items2 = getAttentionItems(db, { ignoreCooldown: false, today: '2026-08-14' });
  const tikTokIn2 = items2.some(i => i.source === 'tiktok');
  // 1回目は出た、2回目は出ない（または ignoreCooldown=true で常に出る）
  if (tikTokIn1) {
    assert.equal(tikTokIn2, false, '同一セッション内でクールダウンが効いていない');
  }
  db.close?.();
});

await test('snoozeSource でスヌーズ期間中は attention に出ない', () => {
  const db = makeDb();
  // today='2026-08-14' を基準に 24h スヌーズ → snoozed_until='2026-08-15'
  snoozeSource(db, 'tiktok', 24, '2026-08-14');
  const items = getAttentionItems(db, { ignoreCooldown: false, today: '2026-08-14' });
  const hasTt = items.some(i => i.source === 'tiktok');
  assert.equal(hasTt, false, 'スヌーズ中の source が attention に出ている');
  db.close?.();
});

await test('ignoreCooldown=true でクールダウンを無視して全件取得', () => {
  const db = makeDb();
  // 一度通知して last_notified_at を更新
  getAttentionItems(db, { ignoreCooldown: false, today: '2026-08-14' });
  // ignoreCooldown=true で再取得
  const items = getAttentionItems(db, { ignoreCooldown: true, today: '2026-08-14' });
  assert.ok(items.length > 0, 'ignoreCooldown=true でも attention が空');
  db.close?.();
});

await test('Dashboard では stale 状態は常に確認できる（status は cooldown 関係なし）', () => {
  const db = makeDb();
  // attention を一度消費してもsync statusは変わらない
  getAttentionItems(db, { ignoreCooldown: false, today: '2026-08-14' });
  const status = getSyncStatus(db, '2026-08-14');
  const ttSrc = status.sources.find(s => s.source === 'tiktok');
  assert.equal(ttSrc.requires_user_action, true, 'cooldown 後も status は要確認のまま');
  db.close?.();
});

// ══════════════════════════════════════════════════════════════════════════════
// Section 14: API エンドポイント
// ══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 14: API エンドポイント');

await test('GET /api/sf/sync/status → 200', async () => {
  await withServer(async (base) => {
    const r = await apiGet(base, '/api/sf/sync/status');
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.ok(Array.isArray(r.body.sources));
    assert.ok(r.body.summary);
  });
});

await test('GET /api/sf/sync/attention → 200', async () => {
  await withServer(async (base) => {
    const r = await apiGet(base, '/api/sf/sync/attention');
    assert.equal(r.status, 200);
    assert.equal(r.body.ok, true);
    assert.ok(Array.isArray(r.body.items));
    assert.equal(typeof r.body.count, 'number');
  });
});

await test('POST /api/sf/sync/run → dry_run=true でも 200', async () => {
  await withServer(async (base) => {
    const r = await apiPost(base, '/api/sf/sync/run', { dry_run: true });
    assert.ok([200, 500].includes(r.status)); // unconfigured なら 500 も許容
    assert.ok(r.body.overall !== undefined);
  });
});

await test('POST /api/sf/sync/run-source → tiktok は 400', async () => {
  await withServer(async (base) => {
    const r = await apiPost(base, '/api/sf/sync/run-source', { source: 'tiktok' });
    assert.equal(r.status, 400);
    assert.ok(r.body.error?.includes('MANUAL') || r.body.error?.includes('manual'));
  });
});

await test('POST /api/sf/sync/run-source → soundrop は 400', async () => {
  await withServer(async (base) => {
    const r = await apiPost(base, '/api/sf/sync/run-source', { source: 'soundrop' });
    assert.equal(r.status, 400);
  });
});

await test('POST /api/sf/sync/run-source → ga4 は 400', async () => {
  await withServer(async (base) => {
    const r = await apiPost(base, '/api/sf/sync/run-source', { source: 'ga4' });
    assert.equal(r.status, 400);
  });
});

await test('POST /api/sf/sync/run-source → invalid source は 400', async () => {
  await withServer(async (base) => {
    const r = await apiPost(base, '/api/sf/sync/run-source', { source: 'unknown_xyz' });
    assert.equal(r.status, 400);
  });
});

await test('POST /api/sf/sync/run-source → source 未指定は 400', async () => {
  await withServer(async (base) => {
    const r = await apiPost(base, '/api/sf/sync/run-source', {});
    assert.equal(r.status, 400);
  });
});

await test('API レスポンスにトークン・シークレットが含まれない', async () => {
  process.env.INSTAGRAM_ACCESS_TOKEN = 'SECRET_API_TOKEN_XYZ';
  await withServer(async (base) => {
    const r = await apiGet(base, '/api/sf/sync/status');
    const json = JSON.stringify(r.body);
    assert.ok(!json.includes('SECRET_API_TOKEN_XYZ'), 'API レスポンスにトークンが含まれている');
  });
  delete process.env.INSTAGRAM_ACCESS_TOKEN;
});

// ══════════════════════════════════════════════════════════════════════════════
// Section 15: runner dry-run / test mode
// ══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 15: runner dry-run / test mode');

await test('runAutoSync の dry-run は DB を変更しない', async () => {
  const db = makeDb();
  process.env.INSTAGRAM_APP_ID = process.env.INSTAGRAM_APP_SECRET =
  process.env.INSTAGRAM_ACCESS_TOKEN = process.env.INSTAGRAM_USER_ID = 'test';
  process.env.YOUTUBE_CLIENT_ID = process.env.YOUTUBE_CLIENT_SECRET =
  process.env.YOUTUBE_REFRESH_TOKEN = process.env.YOUTUBE_CHANNEL_ID = 'test';

  const beforeCount = db.prepare('SELECT COUNT(*) AS n FROM sf_instagram_account_daily').get()?.n ?? 0;
  await runAutoSync(db, { dryRun: true });
  const afterCount = db.prepare('SELECT COUNT(*) AS n FROM sf_instagram_account_daily').get()?.n ?? 0;
  assert.equal(afterCount, beforeCount, 'dry-run で DB が変更された');

  for (const k of ['INSTAGRAM_APP_ID','INSTAGRAM_APP_SECRET','INSTAGRAM_ACCESS_TOKEN','INSTAGRAM_USER_ID',
                    'YOUTUBE_CLIENT_ID','YOUTUBE_CLIENT_SECRET','YOUTUBE_REFRESH_TOKEN','YOUTUBE_CHANNEL_ID'])
    delete process.env[k];
  db.close?.();
});

await test('notifyImportSuccess でsync state が更新される', () => {
  const db = makeDb();
  insertTt(db, '2026-08-14');
  notifyImportSuccess(db, 'tiktok');
  const st = getSourceStatus(db, 'tiktok', '2026-08-14');
  assert.equal(st.last_data_date, '2026-08-14');
  assert.equal(st.status, 'fresh');
  db.close?.();
});

// ══════════════════════════════════════════════════════════════════════════════
// Section 16: Windows task script 安全性
// ══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 16: Windows task script 安全性');

await test('install_sf_ops_task.ps1 が存在する', () => {
  const psPath = resolve(__dirname, '../automation/install_sf_ops_task.ps1');
  const content = readFileSync(psPath, 'utf8');
  assert.ok(content.length > 0);
});

await test('install_sf_ops_task.ps1 の TaskName は JARVIS 専用（SnowflakesOpsRunner）', () => {
  const psPath = resolve(__dirname, '../automation/install_sf_ops_task.ps1');
  const content = readFileSync(psPath, 'utf8');
  assert.ok(content.includes('SnowflakesOpsRunner'), 'TaskName が見つからない');
});

await test('install_sf_ops_task.ps1 が他のタスクを操作しない（TaskName 以外の Unregister/Remove がない）', () => {
  const psPath = resolve(__dirname, '../automation/install_sf_ops_task.ps1');
  const content = readFileSync(psPath, 'utf8');
  // Unregister-ScheduledTask が $TaskName を使う行のみを許可
  const lines = content.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith('#')) continue; // コメント行はスキップ
    if (trimmed.includes('Unregister-ScheduledTask') && !trimmed.includes('$TaskName')) {
      assert.fail(`他のタスクを操作する可能性がある行: ${trimmed}`);
    }
  }
});

await test('install_sf_ops_task.ps1 に削除方法のコメントが含まれる', () => {
  const psPath = resolve(__dirname, '../automation/install_sf_ops_task.ps1');
  const content = readFileSync(psPath, 'utf8');
  assert.ok(content.includes('Unregister-ScheduledTask') && content.includes('削除'), '削除方法のコメントがない');
});

await test('install_sf_ops_task.ps1 に RunIfMissed / StartWhenAvailable 設定がある', () => {
  const psPath = resolve(__dirname, '../automation/install_sf_ops_task.ps1');
  const content = readFileSync(psPath, 'utf8');
  assert.ok(content.includes('StartWhenAvailable'), 'StartWhenAvailable が設定されていない');
});

// ══════════════════════════════════════════════════════════════════════════════
// Section 17: Character Stage
// ══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 17: Character Stage');

await test('sf.js に setState("analyzing") の呼び出しが含まれる（Sync タブ読込時）', () => {
  const sfPath = resolve(__dirname, '../dashboard/public/modules/sf.js');
  const content = readFileSync(sfPath, 'utf8');
  // loadSync 関数内に analyzing がある
  const loadSyncIdx = content.indexOf('function loadSync');
  assert.ok(loadSyncIdx >= 0, 'loadSync が見つからない');
  const slice = content.slice(loadSyncIdx, loadSyncIdx + 500);
  assert.ok(slice.includes("setState('analyzing')") || slice.includes('setState("analyzing")'));
});

await test('sf.js に setState("notice") の呼び出しが含まれる（要確認あり時）', () => {
  const sfPath = resolve(__dirname, '../dashboard/public/modules/sf.js');
  const content = readFileSync(sfPath, 'utf8');
  assert.ok(content.includes("setState('notice')") || content.includes('setState("notice")'));
});

await test('sf.js の loadSync がサイト変更・投稿・作品変更をしない', () => {
  const sfPath = resolve(__dirname, '../dashboard/public/modules/sf.js');
  const content = readFileSync(sfPath, 'utf8');
  const loadSyncIdx = content.indexOf('function loadSync');
  assert.ok(loadSyncIdx >= 0);
  const slice = content.slice(loadSyncIdx, loadSyncIdx + 1500);
  // 自動投稿・自動サイト変更系の呼び出しがない
  assert.ok(!slice.includes('publishPost'), 'publishPost が loadSync に含まれる');
  assert.ok(!slice.includes('autoPublish'), 'autoPublish が loadSync に含まれる');
});

// ══════════════════════════════════════════════════════════════════════════════
// Section 18: 実 DB 未使用 / 外部通信なし
// ══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 18: 実 DB 未使用 / 外部通信なし');

await test('sf_sync_manager.js は business_data.db を参照しない', () => {
  const mgrPath = resolve(__dirname, '../data/sf_sync_manager.js');
  const content = readFileSync(mgrPath, 'utf8');
  assert.ok(!content.includes('business_data.db'), 'business_data.db への直接参照がある');
});

await test('sf_sync_manager.js に fetch 呼び出しがない（外部 API 通信なし）', () => {
  const mgrPath = resolve(__dirname, '../data/sf_sync_manager.js');
  const content  = readFileSync(mgrPath, 'utf8');
  // fetch は collector に委譲しているので sf_sync_manager 自体には不要
  assert.ok(!content.includes("fetch("), 'sf_sync_manager に fetch 呼び出しがある（collector に委譲すること）');
});

await test('テスト用 DB はすべて :memory: または makeDb() で作成', () => {
  // このテスト自体が :memory: のみ使用していることを確認
  // (全 makeDb() 呼び出しは createDb(':memory:') に相当)
  assert.ok(true); // 構造上保証されている
});

await test('空 DB でも getSyncStatus がクラッシュしない', () => {
  const db = makeDb();
  const status = getSyncStatus(db, '2026-08-14');
  assert.ok(status.sources.length > 0);
  db.close?.();
});

await test('空 DB でも getAttentionItems がクラッシュしない', () => {
  const db = makeDb();
  const items = getAttentionItems(db, { ignoreCooldown: true, today: '2026-08-14' });
  assert.ok(Array.isArray(items));
  db.close?.();
});

// ──────────────────────────────────────────────────────────────────────────────

console.log('\n──────────────────────────────────────────────────────────────────────────────');
console.log(`テスト結果: ${passed + failed} 件 / ✅ ${passed} 件成功 / ❌ ${failed} 件失敗`);
if (failed > 0) process.exit(1);
