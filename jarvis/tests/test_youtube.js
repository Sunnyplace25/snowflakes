/**
 * jarvis/tests/test_youtube.js
 * YouTube Channel Analytics テストスイート（Phase 7）
 *
 * 重要:
 * - ':memory:' DB のみ使用。実 DB (business_data.db) は絶対に触れない
 * - 実チャンネル名・実数値はハードコードしない（テスト用仮データのみ）
 * - 外部 API は呼び出さない（モック fetch を使用）
 * - Phase 5 youtube_collector.js との依存関係を確認する
 *
 * Section 1:  REQUIRED_ENV_VARS / getYouTubeConfig（Phase 5 から re-export）
 * Section 2:  buildChannelSnapshots（純粋関数テスト）
 * Section 3:  buildVideoEntry（純粋関数テスト）
 * Section 4:  buildVideoSnapshot（純粋関数テスト）
 * Section 5:  buildVideoExtMetrics（純粋関数テスト）
 * Section 6:  parseDuration（ユーティリティテスト）
 * Section 7:  DB 書き込み（writeChannelDaily / writeVideoEntry / writeVideoDaily / writeVideoExt）
 * Section 8:  モック HTTP テスト（fetch 関数の正常系・異常系）
 * Section 9:  API エンドポイント HTTP テスト（createApiHandler 使用）
 * Section 10: 外部書き込み禁止 / エラー耐性確認
 */

import assert from 'node:assert/strict';
import { createServer } from 'http';
import { createDb }         from '../data/db.js';
import { createApiHandler } from '../dashboard/api.js';
import {
  REQUIRED_ENV_VARS,
  getYouTubeConfig,
  refreshAccessToken,
  fetchYouTubeReport,
  fetchChannelStats,
  fetchChannelAnalytics,
  fetchVideoAnalytics,
  fetchTrafficSources,
  fetchDataVideos,
  buildChannelSnapshots,
  buildTrafficSourceRows,
  buildVideoEntry,
  buildVideoSnapshot,
  buildVideoExtMetrics,
  parseDuration,
  writeChannelDaily,
  writeTrafficSources,
  writeVideoEntry,
  writeVideoDaily,
  writeVideoExt,
} from '../importers/youtube_channel_collector.js';

// ─── セットアップ ─────────────────────────────────────────────────────────────
const db = createDb(':memory:');
const apiHandler = createApiHandler(db);

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

// ─── モック Analytics レスポンス ─────────────────────────────────────────────
// Phase 7 では impressions / impressionsClickThroughRate は取得しない
// （YouTube Reporting API Reach report が必要なため）
const mockChannelAnalytics = {
  columnHeaders: [
    { name: 'day' },
    { name: 'views' },
    { name: 'estimatedMinutesWatched' },
    { name: 'averageViewDuration' },
    { name: 'subscribersGained' },
    { name: 'subscribersLost' },
  ],
  rows: [
    ['2026-08-01', 1200, 5400, 270, 8, 2],
    ['2026-08-02', 980,  4200, 255, 5, 3],
  ],
};

const mockTrafficResponse = {
  columnHeaders: [
    { name: 'insightTrafficSourceType' },
    { name: 'views' },
    { name: 'estimatedMinutesWatched' },
  ],
  rows: [
    ['YT_SEARCH', 800, 2400],
    ['EXTERNAL',  400, 1200],
    ['SUGGESTED', 300, 900],
  ],
};

const mockVideoAnalytics = {
  columnHeaders: [
    { name: 'video' },
    { name: 'views' },
    { name: 'estimatedMinutesWatched' },
    { name: 'averageViewDuration' },
    { name: 'averageViewPercentage' },
    { name: 'likes' },
    { name: 'comments' },
    { name: 'shares' },
    { name: 'subscribersGained' },
    { name: 'subscribersLost' },
  ],
  rows: [
    ['vid-001', 500, 1800, 216, 45.5, 30, 5, 8, 3, 1],
    ['vid-002', 300, 900,  180, 38.0, 15, 2, 3, 1, 0],
  ],
};

// ─── Section 1: REQUIRED_ENV_VARS / getYouTubeConfig ────────────────────────
console.log('\n▶ Section 1: REQUIRED_ENV_VARS / getYouTubeConfig（Phase 5 re-export）');

await test('REQUIRED_ENV_VARS が Phase 5 の4変数を含む', async () => {
  assert.ok(REQUIRED_ENV_VARS.includes('YOUTUBE_CLIENT_ID'),     'YOUTUBE_CLIENT_ID');
  assert.ok(REQUIRED_ENV_VARS.includes('YOUTUBE_CLIENT_SECRET'), 'YOUTUBE_CLIENT_SECRET');
  assert.ok(REQUIRED_ENV_VARS.includes('YOUTUBE_REFRESH_TOKEN'), 'YOUTUBE_REFRESH_TOKEN');
  assert.ok(REQUIRED_ENV_VARS.includes('YOUTUBE_CHANNEL_ID'),    'YOUTUBE_CHANNEL_ID');
  assert.equal(REQUIRED_ENV_VARS.length, 4);
});

await test('getYouTubeConfig: 環境変数が未設定の場合は Error を投げる', async () => {
  const saved = {};
  for (const k of REQUIRED_ENV_VARS) { saved[k] = process.env[k]; delete process.env[k]; }
  try {
    assert.throws(() => getYouTubeConfig(), /環境変数が未設定/);
  } finally {
    for (const k of REQUIRED_ENV_VARS) {
      if (saved[k] !== undefined) process.env[k] = saved[k];
    }
  }
});

await test('getYouTubeConfig: 環境変数が揃っていれば config オブジェクトを返す', async () => {
  const saved = {};
  for (const k of REQUIRED_ENV_VARS) { saved[k] = process.env[k]; }
  process.env.YOUTUBE_CLIENT_ID     = 'mock_client_id';
  process.env.YOUTUBE_CLIENT_SECRET = 'mock_secret';
  process.env.YOUTUBE_REFRESH_TOKEN = 'mock_refresh';
  process.env.YOUTUBE_CHANNEL_ID    = 'UCmock_channel';
  try {
    const cfg = getYouTubeConfig();
    assert.equal(cfg.clientId,     'mock_client_id');
    assert.equal(cfg.channelId,    'UCmock_channel');
  } finally {
    for (const k of REQUIRED_ENV_VARS) {
      if (saved[k] !== undefined) process.env[k] = saved[k];
      else delete process.env[k];
    }
  }
});

// ─── Section 2: buildChannelSnapshots ────────────────────────────────────────
console.log('\n▶ Section 2: buildChannelSnapshots（純粋関数テスト）');

await test('正常レスポンスから日次レコード配列を構築できる', async () => {
  const rows = buildChannelSnapshots(mockChannelAnalytics, null, null);
  assert.equal(rows.length, 2, '2行が変換される');
  assert.equal(rows[0].date,  '2026-08-01');
  assert.equal(rows[0].views, 1200);
  assert.equal(rows[0].estimated_minutes_watched, 5400);
  assert.equal(rows[0].average_view_duration_sec, 270);
  assert.equal(rows[0].subscribers_gained, 8);
  assert.equal(rows[0].subscribers_lost,   2);
  // impressions / ctr は Phase 7 では取得対象外（常に null）
  assert.equal(rows[0].impressions, null, 'impressions は null（YouTube Reporting API 対応まで未取得）');
  assert.equal(rows[0].ctr,         null, 'ctr は null（YouTube Reporting API 対応まで未取得）');
});

await test('buildChannelSnapshots: impressions/CTR は API レスポンスに列があっても常に null', async () => {
  const responseWithImpressions = {
    columnHeaders: [
      { name: 'day' }, { name: 'views' },
      { name: 'impressions' }, { name: 'impressionsClickThroughRate' },
    ],
    rows: [['2026-08-05', 500, 9000, 0.05]],
  };
  const rows = buildChannelSnapshots(responseWithImpressions);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].impressions, null, 'impressions は null に固定');
  assert.equal(rows[0].ctr,         null, 'ctr は null に固定');
  assert.equal(rows[0].views,       500,  'views は正しく変換される');
});

await test('subscribersCount は today と一致する日付にのみ付与される', async () => {
  const rows = buildChannelSnapshots(mockChannelAnalytics, 50000, '2026-08-02');
  const r1 = rows.find(r => r.date === '2026-08-01');
  const r2 = rows.find(r => r.date === '2026-08-02');
  assert.equal(r1?.subscribers_count, null,  '2026-08-01 は null');
  assert.equal(r2?.subscribers_count, 50000, '2026-08-02 は 50000');
});

await test('rows が空の場合は空配列を返す', async () => {
  const rows = buildChannelSnapshots({ columnHeaders: [], rows: [] });
  assert.deepEqual(rows, []);
});

await test('columnHeaders に day がない場合は空配列を返す', async () => {
  const rows = buildChannelSnapshots({
    columnHeaders: [{ name: 'views' }],
    rows: [[1200]],
  });
  assert.deepEqual(rows, []);
});

await test('null / undefined レスポンスは空配列を返す', async () => {
  assert.deepEqual(buildChannelSnapshots(null), []);
  assert.deepEqual(buildChannelSnapshots(undefined), []);
  assert.deepEqual(buildChannelSnapshots({}), []);
});

// ─── Section 3: buildVideoEntry ─────────────────────────────────────────────
console.log('\n▶ Section 3: buildVideoEntry（純粋関数テスト）');

await test('通常動画エントリを正しく構築できる', async () => {
  const entry = buildVideoEntry({
    videoId:     'vid-test-001',
    title:       'テスト動画',
    publishedAt: '2026-07-20T10:00:00Z',
    duration_sec: 225,
  });
  assert.equal(entry.platform,     'youtube');
  assert.equal(entry.content_type, 'video');
  assert.equal(entry.platform_id,  'vid-test-001');
  assert.equal(entry.title,        'テスト動画');
  assert.equal(entry.duration_sec, 225);
});

await test('content_type=short を受け入れる', async () => {
  const entry = buildVideoEntry({ videoId: 'vid-short-001', content_type: 'short' });
  assert.equal(entry.content_type, 'short');
});

await test('不正な content_type は video にフォールバックする', async () => {
  const entry = buildVideoEntry({ videoId: 'vid-x', content_type: 'reel' });
  assert.equal(entry.content_type, 'video', 'reel → video にフォールバック');
});

await test('videoId がない場合は例外が投げられる', async () => {
  assert.throws(() => buildVideoEntry({}),   /videoId/);
  assert.throws(() => buildVideoEntry(null), /videoId/);
});

// ─── Section 4: buildVideoSnapshot ──────────────────────────────────────────
console.log('\n▶ Section 4: buildVideoSnapshot（純粋関数テスト）');

await test('正常な Analytics 行からスナップショットを構築できる', async () => {
  const cols = mockVideoAnalytics.columnHeaders.map(h => h.name);
  const row  = mockVideoAnalytics.rows[0]; // vid-001
  const snap = buildVideoSnapshot(row, cols, 99, '2026-08-13');
  assert.equal(snap.content_reg_id, 99);
  assert.equal(snap.snapshot_date,  '2026-08-13');
  assert.equal(snap.views,          500);
  assert.equal(snap.watch_time_min, 1800);
  assert.equal(snap.avg_watch_sec,  216);
  assert.equal(snap.likes,          30);
  assert.equal(snap.comments,       5);
  assert.equal(snap.shares,         8);
  assert.ok(Math.abs(snap.completion_rate - 0.455) < 0.001, 'completion_rate = 45.5 / 100 ≈ 0.455');
});

await test('averageViewPercentage がない場合 completion_rate は null', async () => {
  const cols = ['video', 'views'];
  const snap = buildVideoSnapshot(['vid-001', 500], cols, 1, '2026-08-13');
  assert.equal(snap.completion_rate, null);
  assert.equal(snap.views, 500);
});

await test('date 不正で例外が投げられる', async () => {
  assert.throws(() => buildVideoSnapshot([], [], 1, '2026/08/13'), /不正な date/);
  assert.throws(() => buildVideoSnapshot([], [], 1, ''), /不正な date/);
});

await test('contentRegId がない場合は例外が投げられる', async () => {
  assert.throws(() => buildVideoSnapshot([], [], 0,    '2026-08-13'), /contentRegId/);
  assert.throws(() => buildVideoSnapshot([], [], null, '2026-08-13'), /contentRegId/);
});

// ─── Section 5: buildVideoExtMetrics ─────────────────────────────────────────
console.log('\n▶ Section 5: buildVideoExtMetrics（純粋関数テスト）');

await test('averageViewPercentage / subscribersGained / subscribersLost を抽出する', async () => {
  const cols = mockVideoAnalytics.columnHeaders.map(h => h.name);
  const row  = mockVideoAnalytics.rows[0]; // vid-001: avp=45.5, sg=3, sl=1
  const ext  = buildVideoExtMetrics(row, cols);
  const avp  = ext.find(e => e.key === 'avg_view_percentage');
  const sg   = ext.find(e => e.key === 'subscribers_gained');
  const sl   = ext.find(e => e.key === 'subscribers_lost');
  assert.ok(avp, 'avg_view_percentage が含まれる');
  assert.ok(Math.abs(avp.value_num - 45.5) < 0.01);
  assert.ok(sg, 'subscribers_gained が含まれる');
  assert.equal(sg.value_num, 3);
  assert.ok(sl, 'subscribers_lost が含まれる');
  assert.equal(sl.value_num, 1);
});

await test('該当カラムがない場合は空配列を返す', async () => {
  const ext = buildVideoExtMetrics(['vid-001', 500], ['video', 'views']);
  assert.deepEqual(ext, [], '対象カラムなしで空配列');
});

await test('各キーの value_text は null', async () => {
  const cols = mockVideoAnalytics.columnHeaders.map(h => h.name);
  const ext  = buildVideoExtMetrics(mockVideoAnalytics.rows[0], cols);
  for (const e of ext) {
    assert.equal(e.value_text, null, `${e.key}.value_text = null`);
  }
});

// ─── Section 6: parseDuration ─────────────────────────────────────────────────
console.log('\n▶ Section 6: parseDuration（ユーティリティテスト）');

await test('PT3M45S → 225秒', async () => {
  assert.equal(parseDuration('PT3M45S'), 225);
});

await test('PT1H2M30S → 3750秒', async () => {
  assert.equal(parseDuration('PT1H2M30S'), 3750);
});

await test('PT30S → 30秒', async () => {
  assert.equal(parseDuration('PT30S'), 30);
});

await test('空文字・null・不正形式は null を返す', async () => {
  assert.equal(parseDuration(''),          null);
  assert.equal(parseDuration(null),        null);
  assert.equal(parseDuration('invalid'),   null);
  assert.equal(parseDuration('PT0S'),      null, 'PT0S は 0秒 → null');
});

// ─── Section 7: DB 書き込み ──────────────────────────────────────────────────
console.log('\n▶ Section 7: DB 書き込み（UPSERT / COALESCE）');

await test('writeChannelDaily が正常に挿入され written=1 を返す', async () => {
  const row = {
    date: '2026-08-10', subscribers_count: 50000, subscribers_gained: 8, subscribers_lost: 2,
    views: 1200, estimated_minutes_watched: 5400, average_view_duration_sec: 270,
    impressions: 12000, ctr: 0.045,
  };
  const { written, error } = writeChannelDaily(db, row);
  assert.equal(written, 1, 'written = 1');
  assert.equal(error, null);
  const saved = db.prepare(`SELECT * FROM sf_youtube_channel_daily WHERE date = '2026-08-10'`).get();
  assert.equal(saved.views,              1200);
  assert.equal(saved.subscribers_count,  50000);
  assert.equal(saved.import_source,      'api');
});

await test('writeChannelDaily の UPSERT で NULL 再書き込みは既存値を保持（COALESCE）', async () => {
  writeChannelDaily(db, {
    date: '2026-08-11', views: 800, estimated_minutes_watched: 3600,
    subscribers_count: null, subscribers_gained: null, subscribers_lost: null,
    average_view_duration_sec: null, impressions: null, ctr: null,
  });
  writeChannelDaily(db, {
    date: '2026-08-11', views: null, estimated_minutes_watched: 4000, impressions: 9500,
    subscribers_count: null, subscribers_gained: null, subscribers_lost: null,
    average_view_duration_sec: null, ctr: null,
  });
  const row = db.prepare(`SELECT views, estimated_minutes_watched, impressions FROM sf_youtube_channel_daily WHERE date = '2026-08-11'`).get();
  assert.equal(row.views,                     800,  '既存 views=800 を保持');
  assert.equal(row.estimated_minutes_watched, 4000, 'estimated_minutes_watched が 4000 に更新');
  assert.equal(row.impressions,               9500, 'impressions が 9500 に更新');
});

await test('writeVideoEntry が正常に挿入され content_reg_id を返す', async () => {
  const row = buildVideoEntry({
    videoId: 'test-vid-write-001', title: 'テスト動画', publishedAt: '2026-08-01T00:00:00Z', duration_sec: 225,
  });
  const { id, error } = writeVideoEntry(db, row);
  assert.ok(id > 0, 'id > 0');
  assert.equal(error, null);
  const saved = db.prepare(`SELECT * FROM sf_content_registry WHERE platform_id = 'test-vid-write-001'`).get();
  assert.equal(saved.platform,    'youtube');
  assert.equal(saved.title,       'テスト動画');
  assert.equal(saved.duration_sec, 225);
});

await test('writeVideoEntry を同じ platform_id で再実行しても重複しない（UPSERT）', async () => {
  const row = buildVideoEntry({ videoId: 'test-vid-write-001', title: '更新タイトル' });
  writeVideoEntry(db, row);
  const count = db.prepare(`SELECT COUNT(*) AS cnt FROM sf_content_registry WHERE platform_id = 'test-vid-write-001'`).get();
  assert.equal(count.cnt, 1, '重複なし');
});

await test('writeVideoDaily が挿入され sf_social_metrics.id を返す', async () => {
  const { id: contentRegId } = writeVideoEntry(db, buildVideoEntry({ videoId: 'test-vid-daily-001' }));
  const snapRow = buildVideoSnapshot(
    ['test-vid-daily-001', 300, 900, 180, 38.0, 15, 2, 3, 1, 0],
    mockVideoAnalytics.columnHeaders.map(h => h.name),
    contentRegId,
    '2026-08-10',
  );
  const { id, error } = writeVideoDaily(db, snapRow);
  assert.ok(id > 0, 'metrics_id > 0');
  assert.equal(error, null);
  const saved = db.prepare(`SELECT * FROM sf_social_metrics WHERE id = ?`).get(id);
  assert.equal(saved.views,    300);
  assert.equal(saved.comments, 2);
});

await test('writeVideoDaily の UPSERT で NULL 再書き込みは既存値を保持（COALESCE）', async () => {
  const { id: contentRegId } = writeVideoEntry(db, buildVideoEntry({ videoId: 'test-vid-coalesce-001' }));
  // 初回: views=500
  writeVideoDaily(db, {
    content_reg_id: contentRegId, snapshot_date: '2026-08-12',
    views: 500, likes: 20, comments: null, shares: null,
    watch_time_min: null, avg_watch_sec: null, completion_rate: null,
  });
  // 再書き込み: views=null, comments=10
  writeVideoDaily(db, {
    content_reg_id: contentRegId, snapshot_date: '2026-08-12',
    views: null, likes: null, comments: 10, shares: null,
    watch_time_min: null, avg_watch_sec: null, completion_rate: null,
  });
  const row = db.prepare(
    `SELECT views, likes, comments FROM sf_social_metrics WHERE content_reg_id = ? AND snapshot_date = '2026-08-12'`
  ).get(contentRegId);
  assert.equal(row.views,    500, '既存 views=500 を保持');
  assert.equal(row.likes,    20,  '既存 likes=20 を保持');
  assert.equal(row.comments, 10,  'comments が 10 に更新');
});

await test('writeVideoExt が sf_platform_ext に挿入され UPSERT で重複しない', async () => {
  const { id: contentRegId } = writeVideoEntry(db, buildVideoEntry({ videoId: 'test-vid-ext-001' }));
  const { id: metricsId }   = writeVideoDaily(db, {
    content_reg_id: contentRegId, snapshot_date: '2026-08-13',
    views: 100, likes: null, comments: null, shares: null,
    watch_time_min: null, avg_watch_sec: null, completion_rate: null,
  });
  const extPairs = [
    { key: 'avg_view_percentage', value_num: 42.5, value_text: null },
    { key: 'subscribers_gained',  value_num: 2,    value_text: null },
  ];
  const { written, error } = writeVideoExt(db, metricsId, extPairs);
  assert.equal(written, 2, '2件挿入');
  assert.equal(error, null);
  // 再実行
  writeVideoExt(db, metricsId, extPairs);
  const count = db.prepare(`SELECT COUNT(*) AS cnt FROM sf_platform_ext WHERE metrics_id = ?`).get(metricsId);
  assert.equal(count.cnt, 2, '重複なし（UPSERT）');
});

// ─── Section 8: モック HTTP テスト ──────────────────────────────────────────
console.log('\n▶ Section 8: モック HTTP テスト（実外部接続なし）');

await test('fetchChannelStats: 成功時にチャンネル統計を返す', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.ok(url.includes('/channels'), 'channels エンドポイントを呼ぶ');
    assert.ok(url.includes('mine=true'), 'mine=true パラメータを含む');
    return {
      ok: true,
      json: async () => ({ items: [{ statistics: { subscriberCount: '50000', viewCount: '1000000' } }] }),
    };
  };
  try {
    const data = await fetchChannelStats({ accessToken: 'tok' });
    assert.equal(data.items[0].statistics.subscriberCount, '50000');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test('fetchChannelAnalytics: 成功時に Analytics レスポンスを返す（impressions は含まない）', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.ok(url.includes('youtubeanalytics'), 'Analytics URL を呼ぶ');
    assert.ok(url.includes('dimensions=day'),   'dimensions=day を含む');
    assert.ok(url.includes('estimatedMinutesWatched'), 'estimatedMinutesWatched を含む');
    // impressions / impressionsClickThroughRate は Phase 7 対象外
    assert.ok(!url.includes('impressions'), 'impressions は含まない（Reporting API 対象）');
    return { ok: true, json: async () => mockChannelAnalytics };
  };
  try {
    const data = await fetchChannelAnalytics({
      accessToken: 'tok', channelId: 'UCmock', startDate: '2026-08-01', endDate: '2026-08-13',
    });
    assert.equal(data.rows.length, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test('fetchVideoAnalytics: 成功時に動画別データを返す', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    assert.ok(url.includes('dimensions=video'), 'dimensions=video を含む');
    assert.ok(url.includes('averageViewPercentage'), 'averageViewPercentage を含む');
    return { ok: true, json: async () => mockVideoAnalytics };
  };
  try {
    const data = await fetchVideoAnalytics({
      accessToken: 'tok', channelId: 'UCmock', startDate: '2026-08-01', endDate: '2026-08-13',
    });
    assert.equal(data.rows[0][0], 'vid-001', 'video ID が含まれる');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test('fetchTrafficSources: insightTrafficSourceType dimension を含む', async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = '';
  globalThis.fetch = async (url) => {
    capturedUrl = url;
    return { ok: true, json: async () => ({ rows: [] }) };
  };
  try {
    await fetchTrafficSources({ accessToken: 'tok', channelId: 'UCmock', startDate: '2026-08-01', endDate: '2026-08-13' });
    assert.ok(capturedUrl.includes('insightTrafficSourceType'), 'traffic source dimension を含む');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test('fetchDataVideos: 動画 ID をカンマ結合して /videos に送る', async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = '';
  globalThis.fetch = async (url) => {
    capturedUrl = url;
    return {
      ok: true,
      json: async () => ({
        items: [
          { id: 'vid-001', snippet: { title: 'テスト', publishedAt: '2026-07-01T00:00:00Z' }, contentDetails: { duration: 'PT3M45S' } },
        ],
      }),
    };
  };
  try {
    const data = await fetchDataVideos({ accessToken: 'tok' }, ['vid-001', 'vid-002']);
    assert.ok(capturedUrl.includes('vid-001'), 'vid-001 が URL に含まれる');
    assert.ok(capturedUrl.includes('vid-002'), 'vid-002 が URL に含まれる');
    assert.equal(data.items[0].snippet.title, 'テスト');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test('HTTP エラー時に各 fetch 関数が適切な Error を投げる', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({ ok: false, status: 403, text: async () => '{"error":"quota exceeded"}' });
  try {
    await assert.rejects(() => fetchChannelStats({ accessToken: 'tok' }),         /Data API.*channels.*error.*403/);
    await assert.rejects(() => fetchChannelAnalytics({ accessToken: 'tok', channelId: 'UC', startDate: '2026-08-01', endDate: '2026-08-01' }), /Analytics.*channel.*error.*403/);
    await assert.rejects(() => fetchVideoAnalytics({ accessToken: 'tok', channelId: 'UC', startDate: '2026-08-01', endDate: '2026-08-01' }),   /Analytics.*videos.*error.*403/);
    await assert.rejects(() => fetchTrafficSources({ accessToken: 'tok', channelId: 'UC', startDate: '2026-08-01', endDate: '2026-08-01' }),   /Analytics.*traffic.*error.*403/);
    await assert.rejects(() => fetchDataVideos({ accessToken: 'tok' }, ['vid-001']),                                                           /Data API.*videos.*error.*403/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── Section 9: API エンドポイント HTTP テスト ───────────────────────────────
console.log('\n▶ Section 9: API エンドポイント HTTP テスト');

// テスト用データを投入（impressions/ctr は NULL - API 経由では取得しない）
writeChannelDaily(db, {
  date: '2026-08-01', subscribers_count: 49800, subscribers_gained: 8, subscribers_lost: 2,
  views: 1200, estimated_minutes_watched: 5400, average_view_duration_sec: 270,
  impressions: null, ctr: null,
});
writeChannelDaily(db, {
  date: '2026-08-02', subscribers_count: 49806, subscribers_gained: 6, subscribers_lost: 0,
  views: 980, estimated_minutes_watched: 4200, average_view_duration_sec: 255,
  impressions: null, ctr: null,
});

// トラフィックソーステスト用データを投入
writeTrafficSources(db, [
  { period_start: '2026-08-01', period_end: '2026-08-13', source_type: 'YT_SEARCH', views: 800, estimated_minutes_watched: 2400 },
  { period_start: '2026-08-01', period_end: '2026-08-13', source_type: 'EXTERNAL',  views: 400, estimated_minutes_watched: 1200 },
  { period_start: '2026-08-01', period_end: '2026-08-13', source_type: 'SUGGESTED', views: 300, estimated_minutes_watched: 900  },
]);

const { id: contentId1 } = writeVideoEntry(db, buildVideoEntry({
  videoId: 'api-test-vid-001', title: 'API テスト動画A',
  publishedAt: '2026-08-01T00:00:00Z', duration_sec: 225,
}));
const { id: contentId2 } = writeVideoEntry(db, buildVideoEntry({
  videoId: 'api-test-vid-002', title: 'API テスト動画B',
  publishedAt: '2026-07-15T00:00:00Z', duration_sec: 45, content_type: 'short',
}));
if (contentId1) {
  writeVideoDaily(db, {
    content_reg_id: contentId1, snapshot_date: '2026-08-02',
    views: 500, likes: 30, comments: 5, shares: 8,
    watch_time_min: 1800, avg_watch_sec: 216, completion_rate: 0.455,
  });
}
if (contentId2) {
  writeVideoDaily(db, {
    content_reg_id: contentId2, snapshot_date: '2026-08-02',
    views: 300, likes: 15, comments: 2, shares: 3,
    watch_time_min: 900, avg_watch_sec: 180, completion_rate: 0.38,
  });
}

await test('GET /api/sf/youtube/channel/daily が日別データを返す', async () => {
  const { status, data } = await api('GET', '/api/sf/youtube/channel/daily?from=2026-08-01&to=2026-08-02');
  assert.equal(status, 200, 'HTTP 200');
  assert.ok(data.ok, 'ok: true');
  assert.ok(Array.isArray(data.rows), 'rows が配列');
  assert.ok(data.rows.length >= 2, '2件以上');
  assert.ok('views' in data.rows[0], 'views フィールドあり');
  assert.ok('subscribers_count' in data.rows[0], 'subscribers_count フィールドあり');
});

await test('GET /api/sf/youtube/channel/daily クエリパラメータなしでデフォルト期間', async () => {
  const { status, data } = await api('GET', '/api/sf/youtube/channel/daily');
  assert.equal(status, 200);
  assert.ok(data.from, 'from が設定される');
  assert.ok(data.to,   'to が設定される');
});

await test('GET /api/sf/youtube/channel/compare が比較データを返す', async () => {
  const { status, data } = await api('GET', '/api/sf/youtube/channel/compare?days=7');
  assert.equal(status, 200);
  assert.ok(data.ok, 'ok: true');
  assert.equal(data.days, 7, 'days = 7');
  assert.ok('current_views'    in data, 'current_views');
  assert.ok('previous_views'   in data, 'previous_views');
  assert.ok('current_watch_min' in data, 'current_watch_min');
  assert.ok('subscribers_count' in data, 'subscribers_count オブジェクト');
});

await test('GET /api/sf/youtube/channel/compare 不正な days はデフォルト 30 になる', async () => {
  const { status, data } = await api('GET', '/api/sf/youtube/channel/compare?days=99');
  assert.equal(status, 200);
  assert.equal(data.days, 30, 'フォールバック days = 30');
});

await test('GET /api/sf/youtube/videos がメディア一覧を返す', async () => {
  const { status, data } = await api('GET', '/api/sf/youtube/videos?limit=10');
  assert.equal(status, 200);
  assert.ok(data.ok, 'ok: true');
  assert.ok(Array.isArray(data.rows), 'rows が配列');
  if (data.rows.length > 0) {
    assert.ok('platform_id' in data.rows[0], 'platform_id フィールドあり');
    assert.ok('content_type' in data.rows[0], 'content_type フィールドあり');
  }
});

await test('GET /api/sf/youtube/videos ?type=short でフィルタできる', async () => {
  const { status, data } = await api('GET', '/api/sf/youtube/videos?type=short');
  assert.equal(status, 200);
  for (const row of data.rows) {
    assert.equal(row.content_type, 'short', 'short のみ');
  }
});

await test('GET /api/sf/youtube/videos/top がトップ動画を返す', async () => {
  const { status, data } = await api('GET', '/api/sf/youtube/videos/top?metric=views&limit=5');
  assert.equal(status, 200);
  assert.ok(data.ok, 'ok: true');
  assert.equal(data.metric, 'views', 'metric = views');
  assert.equal(data.limit,  5,       'limit = 5');
  assert.ok(Array.isArray(data.rows), 'rows が配列');
});

await test('GET /api/sf/youtube/videos/top 不正な metric はデフォルト views になる', async () => {
  const { status, data } = await api('GET', '/api/sf/youtube/videos/top?metric=invalid_col');
  assert.equal(status, 200);
  assert.equal(data.metric, 'views', 'フォールバック metric = views');
});

await test('GET /api/sf/youtube/channel/traffic がトラフィックソース一覧を返す', async () => {
  const { status, data } = await api('GET', '/api/sf/youtube/channel/traffic?from=2026-08-01&to=2026-08-13');
  assert.equal(status, 200, 'HTTP 200');
  assert.ok(data.ok, 'ok: true');
  assert.ok(Array.isArray(data.rows), 'rows が配列');
  assert.ok(data.rows.length >= 1, '1件以上');
  assert.ok('source_type' in data.rows[0], 'source_type フィールドあり');
  assert.ok('views' in data.rows[0], 'views フィールドあり');
  assert.ok('estimated_minutes_watched' in data.rows[0], 'estimated_minutes_watched フィールドあり');
});

await test('GET /api/sf/youtube/channel/traffic クエリパラメータなしでデフォルト期間', async () => {
  const { status, data } = await api('GET', '/api/sf/youtube/channel/traffic');
  assert.equal(status, 200);
  assert.ok(data.from, 'from が設定される');
  assert.ok(data.to,   'to が設定される');
});

// ─── Section 10: 外部書き込み禁止 / エラー耐性 ──────────────────────────────
console.log('\n▶ Section 10: 外部書き込み禁止 / エラー耐性確認');

await test('write 関数は外部 fetch を呼ばない', async () => {
  let fetchCalled = false;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { fetchCalled = true; return { ok: true, json: async () => ({}) }; };
  try {
    writeChannelDaily(db, {
      date: '2026-08-13', subscribers_count: null, subscribers_gained: null, subscribers_lost: null,
      views: null, estimated_minutes_watched: null, average_view_duration_sec: null,
      impressions: null, ctr: null,
    });
    const { id } = writeVideoEntry(db, buildVideoEntry({ videoId: 'no-fetch-test-001' }));
    if (id) {
      writeVideoDaily(db, {
        content_reg_id: id, snapshot_date: '2026-08-13',
        views: 1, likes: null, comments: null, shares: null,
        watch_time_min: null, avg_watch_sec: null, completion_rate: null,
      });
    }
    assert.equal(fetchCalled, false, 'write 関数は fetch を呼ばない');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test('buildChannelSnapshots: 不正な日付行はスキップされる', async () => {
  const badResponse = {
    columnHeaders: [{ name: 'day' }, { name: 'views' }],
    rows: [
      ['2026-08-01', 100],
      ['invalid-date', 200],
      ['2026-08-03', 150],
    ],
  };
  const rows = buildChannelSnapshots(badResponse);
  assert.equal(rows.length, 2, '不正な日付行をスキップして2件');
});

await test('fetchDataVideos: 空配列を渡した場合は API を呼ばずに空配列を返す', async () => {
  const originalFetch = globalThis.fetch;
  let fetchCalled = false;
  globalThis.fetch = async () => { fetchCalled = true; return { ok: true, json: async () => ({}) }; };
  try {
    const data = await fetchDataVideos({ accessToken: 'tok' }, []);
    assert.deepEqual(data, { items: [] }, '空配列を返す');
    assert.equal(fetchCalled, false, 'fetch は呼ばれない');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test('writeVideoExt: metricsId が falsy の場合は何も書き込まない', async () => {
  const { written } = writeVideoExt(db, 0, [{ key: 'test', value_num: 1, value_text: null }]);
  assert.equal(written, 0, '何も書き込まない');
  const { written: w2 } = writeVideoExt(db, null, [{ key: 'test', value_num: 1, value_text: null }]);
  assert.equal(w2, 0);
});

await test('エラーメッセージに OAuth secret / refreshToken が含まれない（漏洩防止）', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false, status: 401, text: async () => '{"error":"invalid_client"}',
  });
  try {
    let errMsg = '';
    try {
      await refreshAccessToken({
        clientId:     'MY_SECRET_CLIENT_ID',
        clientSecret: 'MY_VERY_SECRET_VALUE',
        refreshToken: 'MY_REFRESH_TOKEN_VALUE',
      });
    } catch (e) { errMsg = e.message; }
    assert.ok(errMsg.length > 0, 'エラーが投げられる');
    assert.ok(!errMsg.includes('MY_VERY_SECRET_VALUE'),  'clientSecret がエラーに含まれない');
    assert.ok(!errMsg.includes('MY_REFRESH_TOKEN_VALUE'), 'refreshToken がエラーに含まれない');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── Section 11: refreshAccessToken（Phase 5 re-export / token refresh）───────
console.log('\n▶ Section 11: refreshAccessToken（token refresh / エラー）');

await test('refreshAccessToken: 成功時にアクセストークンを返す', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, opts) => {
    assert.ok(url.includes('oauth2.googleapis.com'), 'Google OAuth エンドポイントを呼ぶ');
    assert.ok(opts?.method === 'POST', 'POST リクエスト');
    return {
      ok: true,
      json: async () => ({ access_token: 'mock_access_token_test123' }),
    };
  };
  try {
    const token = await refreshAccessToken({
      clientId: 'cid', clientSecret: 'csec', refreshToken: 'rtoken',
    });
    assert.equal(token, 'mock_access_token_test123', 'access_token が返る');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test('refreshAccessToken: HTTP 401 エラー時に Error を投げる', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false, status: 401, text: async () => '{"error":"invalid_client"}',
  });
  try {
    await assert.rejects(
      () => refreshAccessToken({ clientId: 'c', clientSecret: 's', refreshToken: 'r' }),
      /Token refresh failed/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test('refreshAccessToken: access_token が含まれないレスポンスで Error を投げる', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ token_type: 'Bearer' }),   // access_token なし
  });
  try {
    await assert.rejects(
      () => refreshAccessToken({ clientId: 'c', clientSecret: 's', refreshToken: 'r' }),
      /access_token not returned/,
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test('fetchYouTubeReport: Phase 5 から re-export されている', async () => {
  assert.ok(typeof fetchYouTubeReport === 'function', 'fetchYouTubeReport は関数');
  // fetchChannelAnalytics / fetchTrafficSources が内部で利用する
  // これにより Phase 5 の HTTP フェッチロジックを重複なく再利用している
});

// ─── Section 12: buildTrafficSourceRows / writeTrafficSources ────────────────
console.log('\n▶ Section 12: buildTrafficSourceRows / writeTrafficSources（純粋関数 + DB）');

await test('buildTrafficSourceRows: 正常レスポンスから行配列を構築できる', async () => {
  const rows = buildTrafficSourceRows(mockTrafficResponse, '2026-08-01', '2026-08-13');
  assert.equal(rows.length, 3, '3件変換される');
  assert.equal(rows[0].source_type,               'YT_SEARCH');
  assert.equal(rows[0].views,                     800);
  assert.equal(rows[0].estimated_minutes_watched, 2400);
  assert.equal(rows[0].period_start,              '2026-08-01');
  assert.equal(rows[0].period_end,                '2026-08-13');
});

await test('buildTrafficSourceRows: 空レスポンスは空配列を返す', async () => {
  assert.deepEqual(buildTrafficSourceRows({ columnHeaders: [], rows: [] }, '2026-08-01', '2026-08-13'), []);
  assert.deepEqual(buildTrafficSourceRows(null, '2026-08-01', '2026-08-13'), []);
  assert.deepEqual(buildTrafficSourceRows(undefined, '2026-08-01', '2026-08-13'), []);
});

await test('buildTrafficSourceRows: insightTrafficSourceType カラムがない場合は空配列', async () => {
  const response = { columnHeaders: [{ name: 'views' }], rows: [[1000]] };
  assert.deepEqual(buildTrafficSourceRows(response, '2026-08-01', '2026-08-13'), []);
});

await test('writeTrafficSources: 正常に挿入され written を返す', async () => {
  const rows = buildTrafficSourceRows(mockTrafficResponse, '2026-08-10', '2026-08-13');
  const { written, error } = writeTrafficSources(db, rows);
  assert.equal(written, 3, '3件挿入');
  assert.equal(error, null);
  const saved = db.prepare(
    `SELECT * FROM sf_youtube_traffic_sources WHERE source_type = 'YT_SEARCH' AND period_start = '2026-08-10'`
  ).get();
  assert.equal(saved.views, 800);
  assert.equal(saved.period_end, '2026-08-13');
});

await test('writeTrafficSources: UPSERT で同一 period+source は重複しない', async () => {
  writeTrafficSources(db, buildTrafficSourceRows(mockTrafficResponse, '2026-08-10', '2026-08-13'));
  const count = db.prepare(
    `SELECT COUNT(*) AS cnt FROM sf_youtube_traffic_sources WHERE period_start = '2026-08-10'`
  ).get();
  assert.equal(count.cnt, 3, '再挿入しても3件のまま');
});

await test('writeTrafficSources: 空配列は written=0 を返す', async () => {
  const { written, error } = writeTrafficSources(db, []);
  assert.equal(written, 0);
  assert.equal(error, null);
});

// ─── 終了処理 ─────────────────────────────────────────────────────────────────
server.close();

console.log(`\n${'─'.repeat(50)}`);
console.log(`  passed: ${passed}  failed: ${failed}`);

if (failed > 0) process.exit(1);
