/**
 * jarvis/tests/test_music_metrics.js
 * 音楽ストリーミング分析 テストスイート（Phase 5）
 *
 * 重要:
 * - ':memory:' DB のみ使用。実 DB (business_data.db) は絶対に触れない
 * - 実楽曲名・実数値はハードコードしない（テスト用仮データのみ）
 * - 外部 API は呼び出さない（変換ロジックのみテスト）
 *
 * Section 1: buildMusicMetrics（Soundrop CSV → sf_music_metrics 変換）
 * Section 2: writeMusicMetrics（Soundrop UPSERT）
 * Section 3: buildYouTubeVideoMetrics（YouTube API レスポンス変換）
 * Section 4: writeYouTubeMetrics（YouTube UPSERT）
 * Section 5: API クエリ SQL 検証（db.prepare 直接実行）
 * Section 6: HTTP 統合テスト（createApiHandler 使用）
 * Section 7: 既存 sf_revenue への影響なし
 * Section 8: YouTube Collector 設定・モック HTTP テスト（実 Google OAuth 接続なし）
 */

import assert from 'node:assert/strict';
import { createServer } from 'http';
import { createDb }         from '../data/db.js';
import { createApiHandler } from '../dashboard/api.js';
import {
  STREAMING_PLATFORM_MAP,
  buildMusicMetrics,
  writeMusicMetrics,
} from '../importers/music_metrics_writer.js';
import {
  buildYouTubeVideoMetrics,
  writeYouTubeMetrics,
  getYouTubeConfig,
  REQUIRED_ENV_VARS,
  refreshAccessToken,
  fetchYouTubeReport,
} from '../importers/youtube_collector.js';

// ─── セットアップ ─────────────────────────────────────────────────────────────
const db = createDb(':memory:');
const apiHandler = createApiHandler(db);

// sf_tracks にテスト用楽曲を挿入（FK 制約を満たすため）
const r1 = db.prepare(`INSERT INTO sf_tracks (track_key, title) VALUES (?, ?)`).run('test-track-A', 'Test Song A');
const r2 = db.prepare(`INSERT INTO sf_tracks (track_key, title) VALUES (?, ?)`).run('test-track-B', 'Test Song B');
const trackId1 = Number(r1.lastInsertRowid);
const trackId2 = Number(r2.lastInsertRowid);

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

// ─── Section 1: buildMusicMetrics（Soundrop CSV 変換）────────────────────────
console.log('\n▶ Section 1: buildMusicMetrics（Soundrop CSV → sf_music_metrics）');

await test('同月同曲同サービスの複数行が SUM されて1レコードになる', async () => {
  const rows = buildMusicMetrics([
    { transactionMonth: '2026-05', trackId: trackId1, service: 'Spotify', quantity: 100 },
    { transactionMonth: '2026-05', trackId: trackId1, service: 'Spotify', quantity: 200 },
    { transactionMonth: '2026-05', trackId: trackId1, service: 'Spotify', quantity:  50 },
  ]);
  assert.equal(rows.length, 1, '3行が1レコードに集約される');
  assert.equal(rows[0].streams, 350, 'SUM(quantity) = 350');
});

await test('Transaction Month が date/month 基準として使われる', async () => {
  const rows = buildMusicMetrics([
    { transactionMonth: '2026-03', trackId: trackId1, service: 'Spotify', quantity: 500 },
  ]);
  assert.equal(rows[0].date,  '2026-03-01', 'date は YYYY-MM-01');
  assert.equal(rows[0].month, '2026-03',    'month は YYYY-MM');
});

await test('TikTok が結果に含まれない（スキップ）', async () => {
  const rows = buildMusicMetrics([
    { transactionMonth: '2026-05', trackId: trackId1, service: 'TikTok', quantity: 9999 },
  ]);
  assert.equal(rows.length, 0, 'TikTok はスキップ');
});

await test('Facebook が結果に含まれない（スキップ）', async () => {
  const rows = buildMusicMetrics([
    { transactionMonth: '2026-05', trackId: trackId1, service: 'Facebook', quantity: 9999 },
  ]);
  assert.equal(rows.length, 0, 'Facebook はスキップ');
});

await test('Spotify が正しく spotify にマッピングされる', async () => {
  const rows = buildMusicMetrics([
    { transactionMonth: '2026-04', trackId: trackId1, service: 'Spotify', quantity: 10 },
  ]);
  assert.equal(rows[0].platform, 'spotify');
});

await test('Apple Music → apple_music にマッピングされる', async () => {
  const rows = buildMusicMetrics([
    { transactionMonth: '2026-04', trackId: trackId1, service: 'Apple Music', quantity: 10 },
  ]);
  assert.equal(rows[0].platform, 'apple_music');
});

await test('YouTube Red → youtube_music にマッピングされる', async () => {
  const rows = buildMusicMetrics([
    { transactionMonth: '2026-04', trackId: trackId1, service: 'YouTube Red', quantity: 10 },
  ]);
  assert.equal(rows[0].platform, 'youtube_music');
});

await test('trackId が null の行がスキップされる', async () => {
  const rows = buildMusicMetrics([
    { transactionMonth: '2026-05', trackId: null,     service: 'Spotify', quantity: 100 },
    { transactionMonth: '2026-05', trackId: trackId1, service: 'Spotify', quantity:  50 },
  ]);
  assert.equal(rows.length, 1, 'null trackId の行は除外される');
  assert.equal(rows[0].trackId, trackId1);
});

await test('transactionMonth が不正な行がスキップされる', async () => {
  const rows = buildMusicMetrics([
    { transactionMonth: '2026-5',     trackId: trackId1, service: 'Spotify', quantity: 100 },
    { transactionMonth: '26-05',      trackId: trackId1, service: 'Spotify', quantity: 100 },
    { transactionMonth: '2026-05-01', trackId: trackId1, service: 'Spotify', quantity: 100 },
    { transactionMonth: '2026-06',    trackId: trackId1, service: 'Spotify', quantity:  50 },
  ]);
  assert.equal(rows.length, 1, '不正な transactionMonth の3行は除外');
  assert.equal(rows[0].month, '2026-06');
});

await test("対象外サービスが 'other' にマッピングされない（other は使用しない）", async () => {
  const rows = buildMusicMetrics([
    { transactionMonth: '2026-05', trackId: trackId1, service: 'Instagram', quantity: 100 },
    { transactionMonth: '2026-05', trackId: trackId1, service: 'Unknown',   quantity: 100 },
  ]);
  assert.equal(rows.length, 0, '対象外サービスはスキップ（other にまとめない）');
  assert.ok(!rows.some(r => r.platform === 'other'), "'other' は使用しない");
});

// ─── Section 2: writeMusicMetrics（Soundrop UPSERT）─────────────────────────
console.log('\n▶ Section 2: writeMusicMetrics（Soundrop UPSERT）');

await test('正常書き込み: written カウントが正しい', async () => {
  const input = buildMusicMetrics([
    { transactionMonth: '2026-01', trackId: trackId1, service: 'Spotify',     quantity: 300 },
    { transactionMonth: '2026-01', trackId: trackId1, service: 'Apple Music', quantity: 150 },
    { transactionMonth: '2026-01', trackId: trackId2, service: 'Spotify',     quantity: 200 },
  ]);
  const result = writeMusicMetrics(db, input);
  assert.equal(result.written, 3, '3レコード書き込まれる');
  assert.equal(result.errors.length, 0, 'エラーなし');

  const row = db.prepare(
    `SELECT streams FROM sf_music_metrics WHERE month = ? AND platform = ? AND track_id = ?`
  ).get('2026-01', 'spotify', trackId1);
  assert.ok(row, 'DB に行が存在する');
  assert.equal(row.streams, 300);
});

await test('UPSERT 冪等性: 2回書いても行数が増えない', async () => {
  const input = buildMusicMetrics([
    { transactionMonth: '2026-02', trackId: trackId1, service: 'Spotify', quantity: 400 },
  ]);
  writeMusicMetrics(db, input);
  writeMusicMetrics(db, input);
  const count = db.prepare(
    `SELECT COUNT(*) AS c FROM sf_music_metrics WHERE month = ? AND platform = ? AND track_id = ?`
  ).get('2026-02', 'spotify', trackId1).c;
  assert.equal(count, 1, '2回書いても行数は1件のまま');
});

await test('再インポートで streams が上書き（二重加算しない）', async () => {
  writeMusicMetrics(db, buildMusicMetrics([
    { transactionMonth: '2026-03', trackId: trackId1, service: 'Amazon Music', quantity: 500 },
  ]));
  writeMusicMetrics(db, buildMusicMetrics([
    { transactionMonth: '2026-03', trackId: trackId1, service: 'Amazon Music', quantity: 600 },
  ]));
  const row = db.prepare(
    `SELECT streams FROM sf_music_metrics WHERE month = ? AND platform = ? AND track_id = ?`
  ).get('2026-03', 'amazon_music', trackId1);
  assert.equal(row.streams, 600, '600 に上書き（1100 にならない）');
});

// ─── Section 3: buildYouTubeVideoMetrics（YouTube API 変換）─────────────────
console.log('\n▶ Section 3: buildYouTubeVideoMetrics（YouTube API レスポンス変換）');

const mockYouTubeDaily = {
  columnHeaders: [
    { name: 'day',               columnType: 'DIMENSION' },
    { name: 'views',             columnType: 'METRIC' },
    { name: 'subscribersGained', columnType: 'METRIC' },
    { name: 'subscribersLost',   columnType: 'METRIC' },
  ],
  rows: [
    ['2026-07-01', 500, 10, 2],
    ['2026-07-02', 750, 15, 3],
  ],
};

const mockYouTubeMonthly = {
  columnHeaders: [
    { name: 'month',             columnType: 'DIMENSION' },
    { name: 'views',             columnType: 'METRIC' },
    { name: 'subscribersGained', columnType: 'METRIC' },
    { name: 'subscribersLost',   columnType: 'METRIC' },
  ],
  rows: [['2026-07', 1250, 25, 5]],
};

await test('daily: views が streams に変換される', async () => {
  const rows = buildYouTubeVideoMetrics(mockYouTubeDaily, trackId1, 'daily');
  assert.equal(rows.length, 2, '2行');
  assert.equal(rows[0].streams, 500, '1日目 500');
  assert.equal(rows[1].streams, 750, '2日目 750');
});

await test('daily: date が YYYY-MM-DD / granularity が daily になる', async () => {
  const rows = buildYouTubeVideoMetrics(mockYouTubeDaily, trackId1, 'daily');
  assert.equal(rows[0].date,        '2026-07-01');
  assert.equal(rows[0].granularity, 'daily');
  assert.equal(rows[0].platform,    'youtube_music');
});

await test('daily: subscribersGained - subscribersLost = followersDelta', async () => {
  const rows = buildYouTubeVideoMetrics(mockYouTubeDaily, trackId1, 'daily');
  assert.equal(rows[0].followersDelta, 8,  '10-2=8');
  assert.equal(rows[1].followersDelta, 12, '15-3=12');
});

await test('monthly: YYYY-MM が YYYY-MM-01 に変換される', async () => {
  const rows = buildYouTubeVideoMetrics(mockYouTubeMonthly, trackId1, 'monthly');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].date,        '2026-07-01', 'YYYY-MM-01 形式');
  assert.equal(rows[0].month,       '2026-07');
  assert.equal(rows[0].granularity, 'monthly');
});

await test('trackId が null の場合は空配列を返す', async () => {
  const rows = buildYouTubeVideoMetrics(mockYouTubeDaily, null, 'daily');
  assert.equal(rows.length, 0);
});

await test('rows が空の場合は空配列を返す', async () => {
  const rows = buildYouTubeVideoMetrics({ ...mockYouTubeDaily, rows: [] }, trackId1, 'daily');
  assert.equal(rows.length, 0);
});

// ─── Section 4: writeYouTubeMetrics（YouTube UPSERT）────────────────────────
console.log('\n▶ Section 4: writeYouTubeMetrics（YouTube UPSERT）');

await test('YouTube データの正常書き込み（import_source=api）', async () => {
  const rows = buildYouTubeVideoMetrics(mockYouTubeDaily, trackId1, 'daily');
  const result = writeYouTubeMetrics(db, rows);
  assert.equal(result.written, 2, '2行書き込み');
  assert.equal(result.errors.length, 0);

  const row = db.prepare(
    `SELECT streams, import_source FROM sf_music_metrics WHERE date = ? AND track_id = ? AND platform = ? AND granularity = 'daily'`
  ).get('2026-07-01', trackId1, 'youtube_music');
  assert.ok(row, 'DB に行が存在する');
  assert.equal(row.streams, 500);
  assert.equal(row.import_source, 'api', 'import_source は api');
});

await test('YouTube UPSERT 冪等性: 2回書いても行数が増えない', async () => {
  const rows = buildYouTubeVideoMetrics(mockYouTubeDaily, trackId2, 'daily');
  writeYouTubeMetrics(db, rows);
  writeYouTubeMetrics(db, rows);
  const count = db.prepare(
    `SELECT COUNT(*) AS c FROM sf_music_metrics WHERE date = ? AND track_id = ? AND platform = ? AND granularity = 'daily'`
  ).get('2026-07-01', trackId2, 'youtube_music').c;
  assert.equal(count, 1, '重複行は作られない');
});

await test('YouTube 再書き込みで streams が上書き・null followersDelta は既存値を保持', async () => {
  writeYouTubeMetrics(db, [{
    date: '2026-06-01', month: '2026-06', granularity: 'daily',
    platform: 'youtube_music', trackId: trackId1, streams: 100, followersDelta: 5,
  }]);
  writeYouTubeMetrics(db, [{
    date: '2026-06-01', month: '2026-06', granularity: 'daily',
    platform: 'youtube_music', trackId: trackId1, streams: 888, followersDelta: null,
  }]);
  const row = db.prepare(
    `SELECT streams, followers_delta FROM sf_music_metrics WHERE date = ? AND track_id = ? AND platform = ? AND granularity = 'daily'`
  ).get('2026-06-01', trackId1, 'youtube_music');
  assert.equal(row.streams,          888, '888 で上書き');
  assert.equal(row.followers_delta,  5,   'COALESCE で既存値 5 を保持');
});

// ─── Section 5: API クエリ SQL 検証 ──────────────────────────────────────────
console.log('\n▶ Section 5: API クエリ SQL 検証（db.prepare 直接実行）');

// Section 5 用データを追加投入
const sqlData = [
  { month: '2026-04', platform: 'spotify',       trackId: trackId1, streams: 1000 },
  { month: '2026-04', platform: 'apple_music',   trackId: trackId1, streams:  500 },
  { month: '2026-04', platform: 'spotify',       trackId: trackId2, streams:  300 },
  { month: '2026-05', platform: 'spotify',       trackId: trackId1, streams: 1200 },
  { month: '2026-05', platform: 'youtube_music', trackId: trackId2, streams:  200 },
];
for (const d of sqlData) {
  db.prepare(`
    INSERT OR REPLACE INTO sf_music_metrics
      (date, month, granularity, platform, track_id, streams, import_source, fetched_at)
    VALUES (?, ?, 'monthly', ?, ?, ?, 'csv', datetime('now', 'localtime'))
  `).run(d.month + '-01', d.month, d.platform, d.trackId, d.streams);
}

await test('/api/sf/music/monthly SQL: 月別 SUM が正しい', async () => {
  const rows = db.prepare(`
    SELECT month, SUM(streams) AS streams
    FROM sf_music_metrics
    WHERE granularity = 'monthly'
      AND month >= ? AND month <= ?
      AND (? IS NULL OR platform = ?)
      AND (? IS NULL OR track_id = ?)
    GROUP BY month ORDER BY month ASC
  `).all('2026-04', '2026-05', null, null, null, null);

  const apr = rows.find(r => r.month === '2026-04');
  assert.ok(apr, '2026-04 が含まれる');
  // spotify(1000) + apple_music(500) + spotify trackId2(300) = 1800
  assert.equal(apr.streams, 1800, '月別 SUM 1800');
});

await test('/api/sf/music/by-track SQL: 楽曲別 SUM + sf_tracks JOIN', async () => {
  const rows = db.prepare(`
    SELECT m.track_id, t.title, SUM(m.streams) AS streams, ? AS platform
    FROM sf_music_metrics m
    JOIN sf_tracks t ON t.id = m.track_id
    WHERE m.granularity = 'monthly'
      AND (? IS NULL OR m.month >= ?)
      AND (? IS NULL OR m.month <= ?)
      AND (? IS NULL OR m.platform = ?)
    GROUP BY m.track_id
    ORDER BY streams DESC, m.track_id ASC
  `).all(null, null, null, null, null, null, null);

  assert.ok(rows.length >= 2, '2楽曲以上');
  assert.ok('title' in rows[0], 'title が含まれる（sf_tracks JOIN）');
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i - 1].streams >= rows[i].streams, '降順');
  }
});

await test('/api/sf/music/by-platform SQL: プラットフォーム別 SUM', async () => {
  const rows = db.prepare(`
    SELECT platform, SUM(streams) AS streams
    FROM sf_music_metrics
    WHERE granularity = 'monthly'
      AND (? IS NULL OR month >= ?)
      AND (? IS NULL OR month <= ?)
      AND (? IS NULL OR track_id = ?)
    GROUP BY platform
    ORDER BY streams DESC, platform ASC
  `).all(null, null, null, null, null, null);

  assert.ok(rows.length >= 2, '複数プラットフォーム');
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i - 1].streams >= rows[i].streams, '降順');
  }
  assert.ok(!rows.some(r => r.platform === 'other'), "'other' は含まれない");
});

// ─── Section 6: HTTP 統合テスト ───────────────────────────────────────────────
console.log('\n▶ Section 6: HTTP 統合テスト');

await test('GET /api/sf/music/monthly → 200 / ok:true / rows 配列', async () => {
  const { status, data } = await api('GET', '/api/sf/music/monthly?from=2026-04&to=2026-05');
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.ok(Array.isArray(data.rows), 'rows が配列');
  assert.ok(data.rows.length >= 2, '2ヶ月分');
  assert.ok('month'   in data.rows[0]);
  assert.ok('streams' in data.rows[0]);
});

await test('GET /api/sf/music/monthly?platform=spotify フィルタ', async () => {
  const { status, data } = await api('GET', '/api/sf/music/monthly?from=2026-04&to=2026-05&platform=spotify');
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  const apr = data.rows.find(r => r.month === '2026-04');
  assert.ok(apr, '2026-04 が含まれる');
  // spotify のみ: trackId1(1000) + trackId2(300) = 1300
  assert.equal(apr.streams, 1300, 'spotify フィルタで 1300');
});

await test('GET /api/sf/music/by-track → 200 / ok:true / streams 降順', async () => {
  const { status, data } = await api('GET', '/api/sf/music/by-track?from=2026-04&to=2026-05');
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.ok(Array.isArray(data.rows) && data.rows.length >= 2);
  assert.ok('track_id' in data.rows[0]);
  assert.ok('title'    in data.rows[0]);
  assert.ok('streams'  in data.rows[0]);
  for (let i = 1; i < data.rows.length; i++) {
    assert.ok(data.rows[i - 1].streams >= data.rows[i].streams, '降順');
  }
});

await test('GET /api/sf/music/by-platform → 200 / ok:true / streams 降順', async () => {
  const { status, data } = await api('GET', '/api/sf/music/by-platform?from=2026-04&to=2026-05');
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.ok(Array.isArray(data.rows) && data.rows.length >= 2);
  assert.ok('platform' in data.rows[0]);
  assert.ok('streams'  in data.rows[0]);
  for (let i = 1; i < data.rows.length; i++) {
    assert.ok(data.rows[i - 1].streams >= data.rows[i].streams, '降順');
  }
});

await test('GET /api/sf/music/by-platform?track_id= フィルタ', async () => {
  const { status, data } = await api('GET', `/api/sf/music/by-platform?from=2026-04&to=2026-05&track_id=${trackId1}`);
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  const spotify = data.rows.find(r => r.platform === 'spotify');
  assert.ok(spotify, 'spotify が含まれる');
  // trackId1 の spotify: 1000 + 1200 = 2200
  assert.equal(spotify.streams, 2200, 'trackId1 の spotify SUM 2200');
  // trackId2 の youtube_music(200) は含まれない
  const youtube = data.rows.find(r => r.platform === 'youtube_music');
  assert.ok(!youtube, 'trackId2 のデータは除外される');
});

// ─── Section 7: 既存 sf_revenue への影響なし ─────────────────────────────────
console.log('\n▶ Section 7: 既存 sf_revenue への影響なし');

await test('music_metrics_writer.js は sf_revenue を変更しない', async () => {
  const before = db.prepare(`SELECT COUNT(*) AS c FROM sf_revenue`).get().c;
  writeMusicMetrics(db, buildMusicMetrics([
    { transactionMonth: '2026-07', trackId: trackId1, service: 'Spotify', quantity: 999 },
  ]));
  const after = db.prepare(`SELECT COUNT(*) AS c FROM sf_revenue`).get().c;
  assert.equal(before, after, 'sf_revenue 行数が変わらない');
});

await test('youtube_collector は sf_revenue を変更しない', async () => {
  const before = db.prepare(`SELECT COUNT(*) AS c FROM sf_revenue`).get().c;
  writeYouTubeMetrics(db, buildYouTubeVideoMetrics(mockYouTubeDaily, trackId2, 'daily'));
  const after = db.prepare(`SELECT COUNT(*) AS c FROM sf_revenue`).get().c;
  assert.equal(before, after, 'sf_revenue 行数が変わらない');
});

await test('Phase 2 Revenue API の結果が変わらない', async () => {
  const { status, data } = await api('GET', '/api/sf/revenue/monthly?basis=transaction');
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.ok(Array.isArray(data.rows));
});

// ─── 追加テスト（20件以上保証）────────────────────────────────────────────────
console.log('\n▶ 追加テスト');

await test('Amazon Music → amazon_music にマッピングされる', async () => {
  const rows = buildMusicMetrics([
    { transactionMonth: '2026-08', trackId: trackId1, service: 'Amazon Music', quantity: 75 },
  ]);
  assert.equal(rows[0].platform, 'amazon_music');
});

await test('YouTube Music → youtube_music にマッピングされる', async () => {
  const rows = buildMusicMetrics([
    { transactionMonth: '2026-08', trackId: trackId1, service: 'YouTube Music', quantity: 60 },
  ]);
  assert.equal(rows[0].platform, 'youtube_music');
});

await test('YouTube Music と YouTube Red が同プラットフォームとして集約される', async () => {
  const rows = buildMusicMetrics([
    { transactionMonth: '2026-08', trackId: trackId1, service: 'YouTube Music', quantity: 100 },
    { transactionMonth: '2026-08', trackId: trackId1, service: 'YouTube Red',   quantity:  50 },
  ]);
  assert.equal(rows.length, 1, 'youtube_music として1レコードに集約');
  assert.equal(rows[0].streams, 150);
  assert.equal(rows[0].platform, 'youtube_music');
});

await test('STREAMING_PLATFORM_MAP に正しい5エントリが含まれる', async () => {
  assert.equal(STREAMING_PLATFORM_MAP['Spotify'],       'spotify');
  assert.equal(STREAMING_PLATFORM_MAP['Apple Music'],   'apple_music');
  assert.equal(STREAMING_PLATFORM_MAP['Amazon Music'],  'amazon_music');
  assert.equal(STREAMING_PLATFORM_MAP['YouTube Music'], 'youtube_music');
  assert.equal(STREAMING_PLATFORM_MAP['YouTube Red'],   'youtube_music');
  assert.equal(Object.keys(STREAMING_PLATFORM_MAP).length, 5);
});

await test('writeMusicMetrics で granularity が monthly 固定', async () => {
  writeMusicMetrics(db, [{
    date: '2026-10-01', month: '2026-10', platform: 'spotify', trackId: trackId1, streams: 111,
  }]);
  const row = db.prepare(
    `SELECT granularity FROM sf_music_metrics WHERE month = ? AND platform = ? AND track_id = ?`
  ).get('2026-10', 'spotify', trackId1);
  assert.equal(row.granularity, 'monthly');
});

await test('writeMusicMetrics で import_source が csv 固定', async () => {
  const row = db.prepare(
    `SELECT import_source FROM sf_music_metrics WHERE month = ? AND platform = ? AND track_id = ?`
  ).get('2026-10', 'spotify', trackId1);
  assert.equal(row.import_source, 'csv');
});

await test('GET /api/sf/music/monthly パラメータ省略時もレスポンスが返る', async () => {
  const { status, data } = await api('GET', '/api/sf/music/monthly');
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.ok(Array.isArray(data.rows));
});

// ─── Section 8: YouTube Collector 設定・モック HTTP テスト ────────────────────
// 実際の Google OAuth 接続は行わない。fetch をモックして HTTP レイヤーを検証する。
console.log('\n▶ Section 8: YouTube Collector 設定・モック HTTP テスト');

await test('REQUIRED_ENV_VARS に4変数が含まれる', async () => {
  assert.ok(REQUIRED_ENV_VARS.includes('YOUTUBE_CLIENT_ID'));
  assert.ok(REQUIRED_ENV_VARS.includes('YOUTUBE_CLIENT_SECRET'));
  assert.ok(REQUIRED_ENV_VARS.includes('YOUTUBE_REFRESH_TOKEN'));
  assert.ok(REQUIRED_ENV_VARS.includes('YOUTUBE_CHANNEL_ID'));
  assert.equal(REQUIRED_ENV_VARS.length, 4);
});

await test('getYouTubeConfig: 環境変数が未設定の場合は Error を投げる', async () => {
  // env vars をクリア
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

await test('getYouTubeConfig: 環境変数が揃っていれば設定オブジェクトを返す', async () => {
  const saved = {};
  for (const k of REQUIRED_ENV_VARS) { saved[k] = process.env[k]; }
  process.env.YOUTUBE_CLIENT_ID     = 'mock_client_id';
  process.env.YOUTUBE_CLIENT_SECRET = 'mock_client_secret';
  process.env.YOUTUBE_REFRESH_TOKEN = 'mock_refresh_token';
  process.env.YOUTUBE_CHANNEL_ID    = 'UCmock_channel';
  try {
    const cfg = getYouTubeConfig();
    assert.equal(cfg.clientId,     'mock_client_id');
    assert.equal(cfg.clientSecret, 'mock_client_secret');
    assert.equal(cfg.refreshToken, 'mock_refresh_token');
    assert.equal(cfg.channelId,    'UCmock_channel');
  } finally {
    for (const k of REQUIRED_ENV_VARS) {
      if (saved[k] !== undefined) process.env[k] = saved[k];
      else delete process.env[k];
    }
  }
});

await test('refreshAccessToken: モック fetch で成功レスポンスを返す', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, _opts) => ({
    ok: true,
    json: async () => ({ access_token: 'mock_access_token_xyz' }),
    text: async () => '',
  });
  try {
    const token = await refreshAccessToken({
      clientId:     'mock_id',
      clientSecret: 'mock_secret',
      refreshToken: 'mock_refresh',
    });
    assert.equal(token, 'mock_access_token_xyz');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test('refreshAccessToken: モック fetch で HTTP エラー → Error を投げる', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (_url, _opts) => ({
    ok: false,
    status: 401,
    text: async () => '{"error":"invalid_client"}',
    json: async () => ({}),
  });
  try {
    await assert.rejects(
      () => refreshAccessToken({ clientId: 'x', clientSecret: 'y', refreshToken: 'z' }),
      /Token refresh failed: 401/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test('refreshAccessToken: access_token が返らない場合 → Error を投げる', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({ token_type: 'Bearer' }), // access_token なし
    text: async () => '',
  });
  try {
    await assert.rejects(
      () => refreshAccessToken({ clientId: 'x', clientSecret: 'y', refreshToken: 'z' }),
      /access_token not returned/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test('fetchYouTubeReport: モック fetch で成功レスポンスを返す', async () => {
  const originalFetch = globalThis.fetch;
  const mockResponse = {
    columnHeaders: [
      { name: 'day',   columnType: 'DIMENSION' },
      { name: 'views', columnType: 'METRIC' },
    ],
    rows: [['2026-08-01', 123]],
  };
  globalThis.fetch = async (url, opts) => {
    assert.ok(url.includes('youtubeanalytics'), 'YouTube Analytics URL を呼んでいる');
    assert.ok(opts.headers.Authorization.startsWith('Bearer '), 'Authorization ヘッダーが正しい');
    return {
      ok: true,
      json: async () => mockResponse,
      text: async () => '',
    };
  };
  try {
    const result = await fetchYouTubeReport({
      accessToken: 'mock_token',
      channelId:   'UCmock',
      startDate:   '2026-08-01',
      endDate:     '2026-08-07',
      dimensions:  'day',
      metrics:     'views',
    });
    assert.deepEqual(result, mockResponse);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test('fetchYouTubeReport: API エラー → Error を投げる', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false,
    status: 403,
    text: async () => '{"error":{"code":403,"message":"Forbidden"}}',
    json: async () => ({}),
  });
  try {
    await assert.rejects(
      () => fetchYouTubeReport({
        accessToken: 'token',
        channelId:   'UCmock',
        startDate:   '2026-08-01',
        endDate:     '2026-08-07',
        dimensions:  'day',
        metrics:     'views',
      }),
      /YouTube Analytics API error: 403/
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});

await test('fetchYouTubeReport: filters パラメータが URL に含まれる', async () => {
  const originalFetch = globalThis.fetch;
  let capturedUrl = '';
  globalThis.fetch = async (url) => {
    capturedUrl = url;
    return { ok: true, json: async () => ({ rows: [] }), text: async () => '' };
  };
  try {
    await fetchYouTubeReport({
      accessToken: 'token',
      channelId:   'UCmock',
      startDate:   '2026-08-01',
      endDate:     '2026-08-07',
      dimensions:  'day',
      metrics:     'views',
      filters:     'video==dQw4w9WgXcQ',
    });
    assert.ok(capturedUrl.includes('filters='), 'filters パラメータが含まれる');
    assert.ok(capturedUrl.includes('video'), 'video フィルタが含まれる');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ─── 終了処理 ─────────────────────────────────────────────────────────────────
server.close();

console.log(`\n${'─'.repeat(50)}`);
console.log(`  passed: ${passed}  failed: ${failed}`);

if (failed > 0) process.exit(1);
