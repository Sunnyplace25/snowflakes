/**
 * jarvis/tests/test_instagram.js
 * Instagram Analytics テストスイート（Phase 6）
 *
 * 重要:
 * - ':memory:' DB のみ使用。実 DB (business_data.db) は絶対に触れない
 * - 実アカウント名・実数値はハードコードしない（テスト用仮データのみ）
 * - 外部 API は呼び出さない（モック fetch を使用）
 * - Instagram 廃止済み指標（impressions/profile_views/website_clicks）は使用しない
 *
 * Section 1: REQUIRED_ENV_VARS / getInstagramConfig 検証
 * Section 2: buildAccountSnapshot（純粋関数テスト）
 * Section 3: buildMediaEntry（純粋関数テスト）
 * Section 4: buildMediaSnapshot（純粋関数テスト）
 * Section 5: DB 書き込み（writeAccountDaily / writeMediaEntry / writeMediaDaily）
 * Section 6: モック HTTP テスト（fetch 関数の正常系・異常系）
 * Section 7: API エンドポイント HTTP テスト（createApiHandler 使用）
 * Section 8: 外部書き込み禁止の確認
 */

import assert from 'node:assert/strict';
import { createServer } from 'http';
import { createDb }         from '../data/db.js';
import { createApiHandler } from '../dashboard/api.js';
import {
  REQUIRED_ENV_VARS,
  getInstagramConfig,
  refreshLongLivedToken,
  fetchMe,
  fetchAccountInsights,
  fetchMediaList,
  fetchMediaInsights,
  buildAccountSnapshot,
  buildMediaEntry,
  buildMediaSnapshot,
  writeAccountDaily,
  writeMediaEntry,
  writeMediaDaily,
} from '../importers/instagram_collector.js';

// ─── セットアップ ─────────────────────────────────────────────────────────────
const db = createDb(':memory:');
const apiHandler = createApiHandler(db);

// テスト用メディアを事前登録（FK 制約のため）
db.prepare(`
  INSERT INTO sf_instagram_media
    (instagram_media_id, media_type, media_product_type, published_at, permalink, import_source)
  VALUES ('test-media-001', 'REELS', 'REELS', '2026-08-01T10:00:00Z', 'https://www.instagram.com/reel/test001/', 'api')
`).run();
db.prepare(`
  INSERT INTO sf_instagram_media
    (instagram_media_id, media_type, media_product_type, published_at, permalink, import_source)
  VALUES ('test-media-002', 'IMAGE', 'FEED', '2026-07-15T09:00:00Z', 'https://www.instagram.com/p/test002/', 'api')
`).run();

const server = createServer((req, res) => {
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.url.startsWith('/api/')) return apiHandler(req, res, url);
  res.writeHead(404); res.end();
});

const port = await new Promise(resolve => {
  server.listen(0, '127.0.0.1', () => resolve(server.address().port));
});

const BASE = `http://127.0.0.1:${port}`;

async function api(method, path) {
  const res = await fetch(`${BASE}${path}`, { method });
  const data = await res.json();
  return { status: res.status, data };
}

// ─── テストランナー ───────────────────────────────────────────────────────────
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

// ─── Section 1: REQUIRED_ENV_VARS / getInstagramConfig ──────────────────────
console.log('\n▶ Section 1: REQUIRED_ENV_VARS / getInstagramConfig 検証');

await test('REQUIRED_ENV_VARS に必須4変数が含まれる', async () => {
  assert.ok(REQUIRED_ENV_VARS.includes('INSTAGRAM_APP_ID'),       'INSTAGRAM_APP_ID');
  assert.ok(REQUIRED_ENV_VARS.includes('INSTAGRAM_APP_SECRET'),   'INSTAGRAM_APP_SECRET');
  assert.ok(REQUIRED_ENV_VARS.includes('INSTAGRAM_ACCESS_TOKEN'), 'INSTAGRAM_ACCESS_TOKEN');
  assert.ok(REQUIRED_ENV_VARS.includes('INSTAGRAM_USER_ID'),      'INSTAGRAM_USER_ID');
});

await test('環境変数が未設定の場合 getInstagramConfig() がエラーを投げる', async () => {
  const saved = {};
  for (const k of REQUIRED_ENV_VARS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  try {
    assert.throws(
      () => getInstagramConfig(),
      /環境変数が未設定/,
      'missing env → エラーが投げられる'
    );
  } finally {
    for (const k of REQUIRED_ENV_VARS) {
      if (saved[k] !== undefined) process.env[k] = saved[k];
    }
  }
});

await test('環境変数が設定済みの場合 getInstagramConfig() が config オブジェクトを返す', async () => {
  const saved = {};
  for (const k of REQUIRED_ENV_VARS) {
    saved[k] = process.env[k];
    process.env[k] = `test-${k.toLowerCase()}`;
  }
  try {
    const config = getInstagramConfig();
    assert.equal(typeof config.appId,       'string', 'appId');
    assert.equal(typeof config.appSecret,   'string', 'appSecret');
    assert.equal(typeof config.accessToken, 'string', 'accessToken');
    assert.equal(typeof config.userId,      'string', 'userId');
  } finally {
    for (const k of REQUIRED_ENV_VARS) {
      if (saved[k] !== undefined) process.env[k] = saved[k];
      else delete process.env[k];
    }
  }
});

// ─── Section 2: buildAccountSnapshot ────────────────────────────────────────
console.log('\n▶ Section 2: buildAccountSnapshot（純粋関数テスト）');

await test('正常な meData + insightsData からレコードを構築できる', async () => {
  const meData = { id: 'u123', username: 'test_user', followers_count: 5000, follows_count: 200, media_count: 42 };
  const insightsData = {
    data: [
      { name: 'reach',                 values: [{ value: 1200 }] },
      { name: 'views',                 values: [{ value: 8000 }] },
      { name: 'accounts_engaged',      values: [{ value: 300  }] },
      { name: 'total_interactions',    values: [{ value: 450  }] },
      { name: 'likes',                 values: [{ value: 380  }] },
      { name: 'comments',              values: [{ value: 40   }] },
      { name: 'shares',                values: [{ value: 20   }] },
      { name: 'saves',                 values: [{ value: 10   }] },
      { name: 'follows_and_unfollows', values: [{ value: 15   }] },
      { name: 'profile_links_taps',    values: [{ value: 5    }] },
    ],
  };
  const row = buildAccountSnapshot(meData, insightsData, '2026-08-01');
  assert.equal(row.date,               '2026-08-01');
  assert.equal(row.followers_count,    5000);
  assert.equal(row.follows_count,      200);
  assert.equal(row.media_count,        42);
  assert.equal(row.reach,              1200);
  assert.equal(row.views,              8000);
  assert.equal(row.likes,              380);
  assert.equal(row.follows_and_unfollows, 15);
  assert.equal(row.profile_links_taps, 5);
});

await test('meData が空でもクラッシュせず NULL を返す', async () => {
  const row = buildAccountSnapshot({}, {}, '2026-08-02');
  assert.equal(row.followers_count, null, 'followers_count は null');
  assert.equal(row.reach,           null, 'reach は null');
});

await test('廃止済み impressions フィールドを含まない', async () => {
  const row = buildAccountSnapshot({}, { data: [{ name: 'impressions', values: [{ value: 9999 }] }] }, '2026-08-03');
  assert.ok(!('impressions' in row), 'impressions フィールドが存在しない');
});

await test('廃止済み profile_views / website_clicks フィールドを含まない', async () => {
  const row = buildAccountSnapshot({}, {
    data: [
      { name: 'profile_views',   values: [{ value: 100 }] },
      { name: 'website_clicks',  values: [{ value: 50  }] },
    ],
  }, '2026-08-04');
  assert.ok(!('profile_views'  in row), 'profile_views がない');
  assert.ok(!('website_clicks' in row), 'website_clicks がない');
});

await test('不正な date フォーマットで例外が投げられる', async () => {
  assert.throws(() => buildAccountSnapshot({}, {}, '2026/08/01'), /不正な date/);
  assert.throws(() => buildAccountSnapshot({}, {}, ''),           /不正な date/);
});

// ─── Section 3: buildMediaEntry ─────────────────────────────────────────────
console.log('\n▶ Section 3: buildMediaEntry（純粋関数テスト）');

await test('IMAGE メディアのエントリを正しく構築できる', async () => {
  const entry = buildMediaEntry({
    id: 'media-img-001', media_type: 'IMAGE', media_product_type: 'FEED',
    timestamp: '2026-07-20T10:00:00Z', caption: 'テスト', permalink: 'https://ig.com/p/001',
  });
  assert.equal(entry.instagram_media_id, 'media-img-001');
  assert.equal(entry.media_type,         'IMAGE');
  assert.equal(entry.media_product_type, 'FEED');
});

await test('REELS メディアのエントリを正しく構築できる', async () => {
  const entry = buildMediaEntry({
    id: 'media-reel-001', media_type: 'REELS', media_product_type: 'REELS',
    timestamp: '2026-07-25T12:00:00Z',
  });
  assert.equal(entry.media_type,         'REELS');
  assert.equal(entry.media_product_type, 'REELS');
});

await test('CAROUSEL_ALBUM メディアを受け入れる', async () => {
  const entry = buildMediaEntry({
    id: 'media-car-001', media_type: 'CAROUSEL_ALBUM', media_product_type: 'FEED',
  });
  assert.equal(entry.media_type, 'CAROUSEL_ALBUM');
});

await test('未知の media_product_type は null に正規化される', async () => {
  const entry = buildMediaEntry({
    id: 'media-unk-001', media_type: 'IMAGE', media_product_type: 'STORIES',
  });
  assert.equal(entry.media_product_type, null, 'STORIES → null');
});

await test('id がない場合は例外が投げられる', async () => {
  assert.throws(() => buildMediaEntry({ media_type: 'IMAGE' }), /media ID/);
});

await test('不正な media_type は例外が投げられる', async () => {
  assert.throws(() => buildMediaEntry({ id: 'x', media_type: 'INVALID' }), /不正な media_type/);
});

// ─── Section 4: buildMediaSnapshot ──────────────────────────────────────────
console.log('\n▶ Section 4: buildMediaSnapshot（純粋関数テスト）');

await test('REELS の avg_watch_time_ms が insights から取得される', async () => {
  const insightsData = {
    data: [
      { name: 'reach',                  value: 500 },
      { name: 'profile_visits',         value: 30  },
      { name: 'ig_reels_avg_watch_time', value: 4200 },
    ],
  };
  const snap = buildMediaSnapshot('media-r1', { view_count: 800 }, insightsData, '2026-08-01', 'REELS');
  assert.equal(snap.avg_watch_time_ms, 4200, 'REELS: avg_watch_time_ms = 4200');
  assert.equal(snap.reach,             500);
});

await test('FEED 投稿の avg_watch_time_ms は null になる', async () => {
  const insightsData = {
    data: [
      { name: 'ig_reels_avg_watch_time', value: 9999 },
    ],
  };
  const snap = buildMediaSnapshot('media-f1', {}, insightsData, '2026-08-01', 'FEED');
  assert.equal(snap.avg_watch_time_ms, null, 'FEED: avg_watch_time_ms = null');
});

await test('直接フィールドから like_count / comments_count / view_count を取得する', async () => {
  const direct = { like_count: 50, comments_count: 5, view_count: 300,
                   shares_count: 10, saved_count: 7, reposts_count: 2 };
  const snap = buildMediaSnapshot('media-d1', direct, null, '2026-08-01', 'FEED');
  assert.equal(snap.like_count,     50);
  assert.equal(snap.comments_count, 5);
  assert.equal(snap.view_count,     300);
  assert.equal(snap.shares_count,   10);
  assert.equal(snap.saved_count,    7);
  assert.equal(snap.reposts_count,  2);
});

await test('mediaId がない場合は例外、date 不正でも例外', async () => {
  assert.throws(() => buildMediaSnapshot('',       {}, null, '2026-08-01', 'FEED'), /mediaId/);
  assert.throws(() => buildMediaSnapshot('media1', {}, null, '2026/08/01', 'FEED'), /不正な date/);
});

// ─── Section 5: DB 書き込み ──────────────────────────────────────────────────
console.log('\n▶ Section 5: DB 書き込み（UPSERT / COALESCE）');

await test('writeAccountDaily が正常に挿入され written=1 を返す', async () => {
  const row = {
    date: '2026-08-10', followers_count: 5000, follows_count: 200, media_count: 42,
    reach: 1200, views: 8000, accounts_engaged: 300, total_interactions: 450,
    likes: 380, comments: 40, shares: 20, saves: 10,
    follows_and_unfollows: 15, profile_links_taps: 5,
  };
  const { written, error } = writeAccountDaily(db, row);
  assert.equal(written, 1, 'written = 1');
  assert.equal(error,   null, 'error = null');
  const saved = db.prepare(`SELECT * FROM sf_instagram_account_daily WHERE date = '2026-08-10'`).get();
  assert.equal(saved.followers_count, 5000);
  assert.equal(saved.import_source,   'api');
});

await test('writeAccountDaily の UPSERT で NULL 再書き込みは既存値を保持（COALESCE）', async () => {
  // 初回: reach=1000 で挿入
  writeAccountDaily(db, {
    date: '2026-08-11', reach: 1000, views: null,
    followers_count: null, follows_count: null, media_count: null,
    accounts_engaged: null, total_interactions: null, likes: null,
    comments: null, shares: null, saves: null,
    follows_and_unfollows: null, profile_links_taps: null,
  });
  // 再書き込み: reach=null, views=5000
  writeAccountDaily(db, {
    date: '2026-08-11', reach: null, views: 5000,
    followers_count: null, follows_count: null, media_count: null,
    accounts_engaged: null, total_interactions: null, likes: null,
    comments: null, shares: null, saves: null,
    follows_and_unfollows: null, profile_links_taps: null,
  });
  const row = db.prepare(`SELECT reach, views FROM sf_instagram_account_daily WHERE date = '2026-08-11'`).get();
  assert.equal(row.reach, 1000, '既存 reach=1000 を保持');
  assert.equal(row.views, 5000, 'views が 5000 に更新');
});

await test('writeMediaEntry が正常に挿入される', async () => {
  const row = {
    instagram_media_id: 'new-media-001', media_type: 'IMAGE', media_product_type: 'FEED',
    published_at: '2026-08-05T08:00:00Z', caption: 'キャプション', permalink: 'https://ig.com/p/001',
  };
  const { written, error } = writeMediaEntry(db, row);
  assert.equal(written, 1, 'written = 1');
  assert.equal(error,   null);
  const saved = db.prepare(`SELECT * FROM sf_instagram_media WHERE instagram_media_id = 'new-media-001'`).get();
  assert.equal(saved.media_type, 'IMAGE');
});

await test('writeMediaEntry を同じ ID で再実行しても重複しない（UPSERT）', async () => {
  const row = { instagram_media_id: 'new-media-001', media_type: 'IMAGE', media_product_type: 'FEED' };
  writeMediaEntry(db, row);
  writeMediaEntry(db, row);
  const count = db.prepare(`SELECT COUNT(*) AS cnt FROM sf_instagram_media WHERE instagram_media_id = 'new-media-001'`).get();
  assert.equal(count.cnt, 1, '重複なし');
});

await test('writeMediaDaily が挿入され COALESCE で既存値を保持する', async () => {
  // test-media-001 は事前に登録済み
  writeMediaDaily(db, {
    instagram_media_id: 'test-media-001', date: '2026-08-10',
    like_count: 50, comments_count: 5, view_count: 300,
    shares_count: null, saved_count: null, reposts_count: null,
    reach: 200, profile_visits: null, avg_watch_time_ms: 3000,
  });
  // 再書き込み: avg_watch_time_ms=null, view_count=400
  writeMediaDaily(db, {
    instagram_media_id: 'test-media-001', date: '2026-08-10',
    like_count: null, comments_count: null, view_count: 400,
    shares_count: null, saved_count: null, reposts_count: null,
    reach: null, profile_visits: null, avg_watch_time_ms: null,
  });
  const row = db.prepare(`
    SELECT like_count, view_count, avg_watch_time_ms
    FROM sf_instagram_media_daily
    WHERE instagram_media_id = 'test-media-001' AND date = '2026-08-10'
  `).get();
  assert.equal(row.like_count,        50,   '既存 like_count=50 を保持');
  assert.equal(row.view_count,        400,  'view_count が 400 に更新');
  assert.equal(row.avg_watch_time_ms, 3000, '既存 avg_watch_time_ms=3000 を保持');
});

// ─── Section 6: モック HTTP テスト ──────────────────────────────────────────
console.log('\n▶ Section 6: モック HTTP テスト（実外部接続なし）');

await test('refreshLongLivedToken: 成功時に新しいアクセストークンを返す', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ access_token: 'new-token-xyz', token_type: 'bearer', expires_in: 5183944 }),
  });
  try {
    const token = await refreshLongLivedToken({ appSecret: 'secret', accessToken: 'old-token' });
    assert.equal(token, 'new-token-xyz', '新しいトークンが返る');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test('refreshLongLivedToken: HTTP エラー時に例外を投げる', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 401, text: async () => '{"error":"Invalid token"}' });
  try {
    await assert.rejects(
      () => refreshLongLivedToken({ appSecret: 'secret', accessToken: 'bad-token' }),
      /token refresh failed/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test('fetchMe: 成功時にアカウント情報を返す', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.ok(url.includes('/me') || url.includes('/test-user'), 'userId エンドポイントを呼ぶ');
    return {
      ok: true,
      json: async () => ({ id: 'test-user', username: 'snow_test', followers_count: 4200 }),
    };
  };
  try {
    const data = await fetchMe({ accessToken: 'tok', userId: 'test-user' });
    assert.equal(data.followers_count, 4200);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test('fetchAccountInsights: 成功時にインサイトデータを返す', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.ok(url.includes('/insights'), 'insights エンドポイントを呼ぶ');
    assert.ok(!url.includes('impressions'), 'impressions を含まない');
    return {
      ok: true,
      json: async () => ({
        data: [{ name: 'reach', values: [{ value: 1500 }] }],
      }),
    };
  };
  try {
    const data = await fetchAccountInsights({ accessToken: 'tok', userId: 'u1' }, '2026-08-01');
    assert.ok(Array.isArray(data.data), 'data 配列が返る');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test('fetchMediaList: 成功時にメディア一覧を返す', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.ok(url.includes('/media'), 'media エンドポイントを呼ぶ');
    assert.ok(url.includes('shares_count'), 'shares_count フィールドを含む');
    return {
      ok: true,
      json: async () => ({ data: [{ id: 'media-001', media_type: 'REELS' }], paging: {} }),
    };
  };
  try {
    const data = await fetchMediaList({ accessToken: 'tok', userId: 'u1' });
    assert.equal(data.data[0].id, 'media-001');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test('fetchMediaInsights: REELS の場合 ig_reels_avg_watch_time を含む', async () => {
  const originalFetch = globalThis.fetch;
  let requestedMetrics = '';
  globalThis.fetch = async (url) => {
    requestedMetrics = url;
    return {
      ok: true,
      json: async () => ({ data: [{ name: 'ig_reels_avg_watch_time', value: 5000 }] }),
    };
  };
  try {
    await fetchMediaInsights({ accessToken: 'tok' }, 'media-001', 'REELS');
    assert.ok(requestedMetrics.includes('ig_reels_avg_watch_time'), 'REELS: avg_watch_time を要求する');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── Section 7: API エンドポイント HTTP テスト ───────────────────────────────
console.log('\n▶ Section 7: API エンドポイント HTTP テスト');

// テスト用データを追加
writeAccountDaily(db, {
  date: '2026-08-01', followers_count: 4800, follows_count: 180, media_count: 40,
  reach: 1100, views: 7500, accounts_engaged: 280, total_interactions: 400,
  likes: 340, comments: 35, shares: 18, saves: 7, follows_and_unfollows: 10, profile_links_taps: 4,
});
writeAccountDaily(db, {
  date: '2026-08-02', followers_count: 4820, follows_count: 181, media_count: 41,
  reach: 1250, views: 8200, accounts_engaged: 310, total_interactions: 460,
  likes: 390, comments: 42, shares: 22, saves: 11, follows_and_unfollows: 20, profile_links_taps: 6,
});
writeMediaDaily(db, {
  instagram_media_id: 'test-media-001', date: '2026-08-01',
  like_count: 150, comments_count: 20, view_count: 5000,
  shares_count: 30, saved_count: 25, reposts_count: 5,
  reach: 3000, profile_visits: 100, avg_watch_time_ms: 4500,
});
writeMediaDaily(db, {
  instagram_media_id: 'test-media-002', date: '2026-08-01',
  like_count: 80, comments_count: 10, view_count: 1200,
  shares_count: null, saved_count: null, reposts_count: null,
  reach: 900, profile_visits: 30, avg_watch_time_ms: null,
});

await test('GET /api/sf/instagram/account/daily が日別データを返す', async () => {
  const { status, data } = await api('GET', '/api/sf/instagram/account/daily?from=2026-08-01&to=2026-08-02');
  assert.equal(status, 200, 'HTTP 200');
  assert.ok(data.ok, 'ok: true');
  assert.ok(Array.isArray(data.rows), 'rows が配列');
  assert.ok(data.rows.length >= 2, '2件以上のデータ');
  assert.ok('followers_count' in data.rows[0], 'followers_count フィールドあり');
  assert.ok(!('impressions' in data.rows[0]), 'impressions は含まない');
});

await test('GET /api/sf/instagram/account/daily ?from/?to なし はデフォルト期間を使う', async () => {
  const { status, data } = await api('GET', '/api/sf/instagram/account/daily');
  assert.equal(status, 200, 'HTTP 200');
  assert.ok(data.from, 'from が設定される');
  assert.ok(data.to,   'to が設定される');
});

await test('GET /api/sf/instagram/account/compare が比較データを返す', async () => {
  const { status, data } = await api('GET', '/api/sf/instagram/account/compare?days=7');
  assert.equal(status, 200, 'HTTP 200');
  assert.ok(data.ok, 'ok: true');
  assert.equal(data.days, 7, 'days = 7');
  assert.ok('current_reach' in data,   'current_reach フィールドあり');
  assert.ok('previous_reach' in data,  'previous_reach フィールドあり');
  assert.ok('followers_count' in data, 'followers_count フィールドあり');
});

await test('GET /api/sf/instagram/media がメディア一覧を返す', async () => {
  const { status, data } = await api('GET', '/api/sf/instagram/media?limit=10');
  assert.equal(status, 200, 'HTTP 200');
  assert.ok(data.ok, 'ok: true');
  assert.ok(Array.isArray(data.rows), 'rows が配列');
  if (data.rows.length > 0) {
    assert.ok('instagram_media_id' in data.rows[0], 'instagram_media_id フィールドあり');
    assert.ok('media_type'         in data.rows[0], 'media_type フィールドあり');
  }
});

await test('GET /api/sf/instagram/media ?type=REELS でフィルタできる', async () => {
  const { status, data } = await api('GET', '/api/sf/instagram/media?type=REELS');
  assert.equal(status, 200, 'HTTP 200');
  for (const row of data.rows) {
    assert.equal(row.media_product_type, 'REELS', 'REELS のみ');
  }
});

await test('GET /api/sf/instagram/media/top がトップメディアを返す', async () => {
  const { status, data } = await api('GET', '/api/sf/instagram/media/top?metric=view_count&limit=5');
  assert.equal(status, 200, 'HTTP 200');
  assert.ok(data.ok, 'ok: true');
  assert.equal(data.metric, 'view_count', 'metric = view_count');
  assert.equal(data.limit,  5,            'limit = 5');
  assert.ok(Array.isArray(data.rows), 'rows が配列');
});

await test('GET /api/sf/instagram/media/top 不正な metric はデフォルト view_count になる', async () => {
  const { status, data } = await api('GET', '/api/sf/instagram/media/top?metric=invalid_field');
  assert.equal(status, 200, 'HTTP 200');
  assert.equal(data.metric, 'view_count', 'フォールバック metric = view_count');
});

await test('GET /api/sf/instagram/media/top ?metric=avg_watch_time_ms は受け入れる', async () => {
  const { status, data } = await api('GET', '/api/sf/instagram/media/top?metric=avg_watch_time_ms&type=REELS');
  assert.equal(status, 200, 'HTTP 200');
  assert.equal(data.metric, 'avg_watch_time_ms');
});

// ─── Section 8: 外部書き込み禁止の確認 ─────────────────────────────────────
console.log('\n▶ Section 8: 外部書き込み禁止の確認');

await test('write 関数（writeAccountDaily / writeMediaEntry / writeMediaDaily）は外部 fetch を呼ばない', async () => {
  let fetchCalled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetchCalled = true; return { ok: true, json: async () => ({}) }; };
  try {
    writeAccountDaily(db, {
      date: '2026-08-12', followers_count: 1, follows_count: 0, media_count: 0,
      reach: null, views: null, accounts_engaged: null, total_interactions: null,
      likes: null, comments: null, shares: null, saves: null,
      follows_and_unfollows: null, profile_links_taps: null,
    });
    writeMediaEntry(db, { instagram_media_id: 'no-fetch-test', media_type: 'IMAGE', media_product_type: 'FEED' });
    writeMediaDaily(db, {
      instagram_media_id: 'test-media-001', date: '2026-08-12',
      like_count: 1, comments_count: null, view_count: null,
      shares_count: null, saved_count: null, reposts_count: null,
      reach: null, profile_visits: null, avg_watch_time_ms: null,
    });
    assert.equal(fetchCalled, false, 'write 関数は fetch を呼ばない');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── 終了処理 ─────────────────────────────────────────────────────────────────
server.close();

console.log(`\n${'─'.repeat(50)}`);
console.log(`  passed: ${passed}  failed: ${failed}`);

if (failed > 0) process.exit(1);
