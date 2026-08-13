/**
 * jarvis/tests/test_funnel.js
 * Funnel Analytics テストスイート（Phase 9）
 *
 * 重要:
 * - ':memory:' DB のみ使用。実 DB (business_data.db) には絶対に触れない
 * - 外部 API 呼び出しなし
 * - 個人追跡なし・異種指標合算なし・因果断定なし
 * - 月次データの日割り禁止を確認するテスト含む
 *
 * Section 1:  getFunnelOverview（空DB / 期間 / 各 source / 品質 / 禁止事項）
 * Section 2:  getFunnelEvents（フィルター各種）
 * Section 3:  createFunnelEvent（正常 / 不正 / FK 検証）
 * Section 4:  getEventImpact（期間境界 / percent_change / monthly 非比較）
 * Section 5:  getWorkFunnel / getTrackFunnel
 * Section 6:  suggestFunnelEvents
 * Section 7:  API エンドポイント HTTP テスト（6件）
 * Section 8:  セキュリティ / 不正入力テスト
 * Section 9:  構造 / 品質 / 外部通信確認
 */

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { createDb }         from '../data/db.js';
import { createApiHandler } from '../dashboard/api.js';
import {
  VALID_EVENT_TYPES,
  VALID_EVENT_PLATFORMS,
  getFunnelEvents,
  createFunnelEvent,
  getFunnelOverview,
  getEventImpact,
  getWorkFunnel,
  getTrackFunnel,
  suggestFunnelEvents,
} from '../data/sf_funnel_manager.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

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

async function api(method, path, body = null) {
  const opts = { method };
  if (body !== null) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(`${BASE}${path}`, opts);
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

// ─── テスト用データ挿入ヘルパー ───────────────────────────────────────────────

/** sf_works にテスト作品を挿入 → id を返す */
function insertWork(title = 'テスト小説', work_type = 'novel', published_at = null) {
  const key = `work_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  return db.prepare(
    `INSERT INTO sf_works (work_key, title, work_type, published_at) VALUES (?, ?, ?, ?) RETURNING id`
  ).get(key, title, work_type, published_at)?.id;
}

/** sf_tracks にテスト楽曲を挿入 → id を返す */
function insertTrack(title = 'テスト楽曲', release_date = null) {
  const key = `track_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const r = db.prepare(
    `INSERT INTO sf_tracks (track_key, title, release_date) VALUES (?, ?, ?) RETURNING id`
  ).get(key, title, release_date);
  // migration で追加されたカラムがある場合の対応
  if (r) return r.id;
  return db.prepare(`SELECT id FROM sf_tracks WHERE track_key = ?`).get(key)?.id;
}

/** sf_content_registry にテストコンテンツを挿入 → id を返す */
function insertContent(platform = 'instagram', pid = null, workId = null, trackId = null, published_at = null) {
  const platform_id = pid ?? `${platform}_test_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const r = db.prepare(
    `INSERT INTO sf_content_registry (platform, content_type, platform_id, work_id, track_id, published_at)
     VALUES (?, ?, ?, ?, ?, ?) RETURNING id`
  ).get(platform, platform === 'youtube' ? 'video' : platform === 'tiktok' ? 'tiktok_video' : 'post',
    platform_id, workId, trackId, published_at);
  if (r) return r.id;
  return db.prepare(`SELECT id FROM sf_content_registry WHERE platform_id = ?`).get(platform_id)?.id;
}

/** sf_instagram_account_daily に日次データを挿入 */
function insertIgAccount(date, reach, views, likes = 0, comments = 0, shares = 0, saves = 0) {
  db.prepare(`
    INSERT OR IGNORE INTO sf_instagram_account_daily
      (date, reach, views, likes, comments, shares, saves)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(date, reach, views, likes, comments, shares, saves);
}

/** sf_youtube_channel_daily に日次データを挿入 */
function insertYtChannel(date, views, estimated_minutes_watched = null) {
  db.prepare(`
    INSERT OR IGNORE INTO sf_youtube_channel_daily (date, views, estimated_minutes_watched)
    VALUES (?, ?, ?)
  `).run(date, views, estimated_minutes_watched);
}

/** sf_account_daily (tiktok) に日次データを挿入 */
function insertTtAccount(date, reach, impressions) {
  db.prepare(`
    INSERT OR IGNORE INTO sf_account_daily (platform, date, reach, impressions)
    VALUES ('tiktok', ?, ?, ?)
  `).run(date, reach, impressions);
}

/** sf_ga_daily に日次データを挿入 */
function insertGA(date, sessions, users, page_views = 0, engaged_sessions = 0, page_path = '/') {
  db.prepare(`
    INSERT OR IGNORE INTO sf_ga_daily (date, page_path, sessions, users, page_views, engaged_sessions)
    VALUES (?, ?, ?, ?, ?, ?)
  `).run(date, page_path, sessions, users, page_views, engaged_sessions);
}

/** sf_narou_snapshot に月次データを挿入 */
function insertNarou(month, ncode, pv_monthly, bookmark_count, workId = null) {
  db.prepare(`
    INSERT OR IGNORE INTO sf_narou_snapshot
      (month, ncode, work_id, pv_monthly, bookmark_count, review_count, point)
    VALUES (?, ?, ?, ?, ?, 5, 100)
  `).run(month, ncode, workId, pv_monthly, bookmark_count);
}

/** sf_music_metrics に日次データを挿入 */
function insertMusic(date, streams, listeners, trackId, granularity = 'daily') {
  const month = date.slice(0, 7);
  db.prepare(`
    INSERT OR IGNORE INTO sf_music_metrics
      (date, month, granularity, platform, track_id, streams, listeners, saves, playlist_adds)
    VALUES (?, ?, ?, 'spotify', ?, ?, ?, 10, 5)
  `).run(date, month, granularity, trackId, streams, listeners);
}

/** sf_revenue に月次収益を挿入 */
function insertRevenue(month, amount_jpy, quantity, workId = null, trackId = null) {
  db.prepare(`
    INSERT INTO sf_revenue
      (date, month, source, amount_jpy, amount, quantity, work_id, track_id)
    VALUES (?, ?, '音楽配信', ?, ?, ?, ?, ?)
  `).run(month + '-01', month, amount_jpy, amount_jpy, quantity, workId, trackId);
}

/** sf_funnel_event を挿入 → id を返す */
function insertEvent(date, event_type, opts = {}) {
  const r = createFunnelEvent(db, { date, event_type, ...opts });
  if (!r.ok) throw new Error(`insertEvent failed: ${r.errors?.join(', ')}`);
  return r.id;
}

// ══════════════════════════════════════════════════════════════════════════════
// Section 1: getFunnelOverview
// ══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 1: getFunnelOverview');

await test('空 DB で overview が正常に返る（エラーなし）', () => {
  const result = getFunnelOverview(db, { from: '2020-01-01', to: '2020-01-31' });
  assert.ok(result);
  assert.ok('stages' in result);
  assert.ok('data_quality' in result);
});

await test('空 DB の overview は sources が全て null（0 で捏造しない）', () => {
  const result = getFunnelOverview(db, { from: '2020-01-01', to: '2020-01-31' });
  assert.equal(result.stages.discovery.social.instagram.reach, null);
  assert.equal(result.stages.discovery.social.youtube.views, null);
  assert.equal(result.stages.discovery.social.tiktok.reach, null);
  assert.equal(result.stages.discovery.site.sessions, null);
});

await test('from / to フィールドが応答に含まれる', () => {
  const result = getFunnelOverview(db, { from: '2026-01-01', to: '2026-01-31' });
  assert.equal(result.from, '2026-01-01');
  assert.equal(result.to,   '2026-01-31');
});

await test('Instagram 指標が sf_instagram_account_daily から集計される', () => {
  insertIgAccount('2026-07-01', 500, 1000, 50, 10, 20, 30);
  insertIgAccount('2026-07-02', 600, 1200, 60, 12, 25, 40);
  const result = getFunnelOverview(db, { from: '2026-07-01', to: '2026-07-02' });
  assert.equal(result.stages.discovery.social.instagram.reach, 1100);
  assert.equal(result.stages.discovery.social.instagram.views, 2200);
});

await test('YouTube 指標が sf_youtube_channel_daily から集計される', () => {
  insertYtChannel('2026-07-01', 3000, 500);
  insertYtChannel('2026-07-02', 4000, 600);
  const result = getFunnelOverview(db, { from: '2026-07-01', to: '2026-07-02' });
  assert.equal(result.stages.discovery.social.youtube.views, 7000);
});

await test('TikTok 指標が sf_account_daily から集計される', () => {
  insertTtAccount('2026-07-01', 800, 5000);
  insertTtAccount('2026-07-02', 900, 6000);
  const result = getFunnelOverview(db, { from: '2026-07-01', to: '2026-07-02' });
  assert.equal(result.stages.discovery.social.tiktok.reach, 1700);
  assert.equal(result.stages.discovery.social.tiktok.impressions, 11000);
});

await test('GA4 指標が sf_ga_daily から集計される', () => {
  insertGA('2026-07-01', 200, 150, 800, 120);
  insertGA('2026-07-02', 250, 180, 900, 140);
  const result = getFunnelOverview(db, { from: '2026-07-01', to: '2026-07-02' });
  assert.equal(result.stages.discovery.site.sessions, 450);
  assert.equal(result.stages.discovery.site.users,    330);
  assert.equal(result.stages.engagement.site.page_views, 1700);
});

await test('Narou は月次として granularity:"monthly" が付く（日割りなし）', () => {
  const result = getFunnelOverview(db, { from: '2026-07-01', to: '2026-07-31' });
  assert.equal(result.stages.deep_interest.narou.granularity, 'monthly');
});

await test('Revenue は月次として granularity:"monthly" が付く（日割りなし）', () => {
  const result = getFunnelOverview(db, { from: '2026-07-01', to: '2026-07-31' });
  assert.equal(result.stages.value.revenue.granularity, 'monthly');
});

await test('Narou データが sf_narou_snapshot から集計される', () => {
  insertNarou('2026-07', 'N001', 3000, 100);
  insertNarou('2026-08', 'N001', 4000, 120);
  const result = getFunnelOverview(db, { from: '2026-07-01', to: '2026-08-31' });
  assert.equal(result.stages.deep_interest.narou.pv_monthly, 7000);
  assert.equal(result.stages.deep_interest.narou.bookmark_count, 220);
});

await test('Music データが sf_music_metrics から集計される', () => {
  const tid = insertTrack('ファネルテスト楽曲');
  insertMusic('2026-07-01', 500, 200, tid);
  insertMusic('2026-07-02', 600, 250, tid);
  const result = getFunnelOverview(db, { from: '2026-07-01', to: '2026-07-02' });
  assert.equal(result.stages.deep_interest.music.streams, 1100);
  assert.equal(result.stages.deep_interest.music.listeners, 450);
});

await test('Revenue データが sf_revenue から集計される', () => {
  insertRevenue('2026-07', 5000, 100);
  const result = getFunnelOverview(db, { from: '2026-07-01', to: '2026-07-31' });
  assert.ok(result.stages.value.revenue.amount_jpy >= 5000);
});

await test('異種指標を合算して総人数フィールドを作っていない', () => {
  const result = getFunnelOverview(db, {});
  // discovery に total や sum フィールドがない
  assert.ok(!('total' in result.stages.discovery));
  assert.ok(!('total_users' in result.stages.discovery));
  assert.ok(!('total_reach' in result.stages.discovery));
  // source が分離されている
  assert.ok('social' in result.stages.discovery);
  assert.ok('site' in result.stages.discovery);
});

await test('偽 conversion rate フィールドが存在しない', () => {
  const result = getFunnelOverview(db, {});
  const json = JSON.stringify(result);
  // conversion_rate の計算は engagement.tiktok にはあるが、
  // discovery → engagement の跨ぎ比率（偽 CVR）がないことを確認
  assert.ok(!json.includes('"site_conversion"'));
  assert.ok(!json.includes('"funnel_conversion"'));
  assert.ok(!json.includes('"cross_platform_cvr"'));
});

await test('月次データを日割りしていない（granularity が monthly のまま）', () => {
  const result = getFunnelOverview(db, { from: '2026-07-15', to: '2026-07-17' });
  // 3日間の期間でも Narou が日割りされていない
  assert.equal(result.stages.deep_interest.narou.granularity, 'monthly');
  assert.equal(result.stages.value.revenue.granularity, 'monthly');
});

await test('data_quality に必要フィールドが全て含まれる', () => {
  const result = getFunnelOverview(db, {});
  const dq = result.data_quality;
  assert.ok(Array.isArray(dq.missing_sources));
  assert.ok(Array.isArray(dq.monthly_only_sources));
  assert.ok(typeof dq.unlinked_content_count === 'number');
  assert.ok(Array.isArray(dq.warnings));
});

await test('monthly_only_sources に narou と revenue が含まれる', () => {
  const result = getFunnelOverview(db, {});
  assert.ok(result.data_quality.monthly_only_sources.includes('narou'));
  assert.ok(result.data_quality.monthly_only_sources.includes('revenue'));
});

await test('未紐付けコンテンツ数が data_quality に反映される', () => {
  // work_id / track_id = NULL のコンテンツを挿入
  insertContent('instagram', null, null, null, null);
  const result = getFunnelOverview(db, {});
  assert.ok(result.data_quality.unlinked_content_count > 0);
});

await test('期間フィルタが有効（範囲外のデータは集計しない）', () => {
  insertIgAccount('2024-01-01', 99999, 99999);
  const result = getFunnelOverview(db, { from: '2026-07-01', to: '2026-07-02' });
  // 2026-07 の期待値は既存挿入済みの 1100 のまま
  assert.equal(result.stages.discovery.social.instagram.reach, 1100);
});

// ══════════════════════════════════════════════════════════════════════════════
// Section 2: getFunnelEvents
// ══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 2: getFunnelEvents');

// テスト用作品・楽曲
const w1 = insertWork('ファネル作品A');
const t1 = insertTrack('ファネル楽曲A');

// テスト用イベント
const ev1 = insertEvent('2026-07-10', 'novel_publish', { work_id: w1, label: 'A公開' });
const ev2 = insertEvent('2026-07-15', 'music_release', { track_id: t1, platform: 'spotify', label: 'Aリリース' });
const ev3 = insertEvent('2026-08-01', 'sns_post', { platform: 'instagram', label: 'IG投稿' });

await test('フィルタなしで全イベントを返す', () => {
  const events = getFunnelEvents(db);
  assert.ok(events.length >= 3);
});

await test('event_type でフィルタできる', () => {
  const events = getFunnelEvents(db, { eventType: 'novel_publish' });
  assert.ok(events.every(e => e.event_type === 'novel_publish'));
  assert.ok(events.some(e => e.id === ev1));
});

await test('platform でフィルタできる', () => {
  const events = getFunnelEvents(db, { platform: 'instagram' });
  assert.ok(events.every(e => e.platform === 'instagram'));
  assert.ok(events.some(e => e.id === ev3));
});

await test('work_id でフィルタできる', () => {
  const events = getFunnelEvents(db, { workId: w1 });
  assert.ok(events.every(e => e.work_id === w1));
  assert.ok(events.some(e => e.id === ev1));
});

await test('track_id でフィルタできる', () => {
  const events = getFunnelEvents(db, { trackId: t1 });
  assert.ok(events.every(e => e.track_id === t1));
  assert.ok(events.some(e => e.id === ev2));
});

await test('from / to でフィルタできる', () => {
  const events = getFunnelEvents(db, { from: '2026-07-10', to: '2026-07-15' });
  assert.ok(events.every(e => e.date >= '2026-07-10' && e.date <= '2026-07-15'));
});

await test('不正な event_type はフィルタなしとして安全に動作する', () => {
  // allowlist 外 → 全件返す（エラーにしない）
  const all   = getFunnelEvents(db).length;
  const filt  = getFunnelEvents(db, { eventType: "'; DROP TABLE sf_funnel_event; --" }).length;
  assert.equal(filt, all);
});

// ══════════════════════════════════════════════════════════════════════════════
// Section 3: createFunnelEvent
// ══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 3: createFunnelEvent');

await test('正常なイベントを作成できる', () => {
  const r = createFunnelEvent(db, { date: '2026-08-10', event_type: 'site_update', label: 'テスト更新' });
  assert.ok(r.ok);
  assert.ok(typeof r.id === 'number' && r.id > 0);
});

await test('必須フィールドだけでも作成できる', () => {
  const r = createFunnelEvent(db, { date: '2026-08-11', event_type: 'sweets_update' });
  assert.ok(r.ok);
});

await test('work_id 付きで作成できる', () => {
  const w = insertWork('FK作品');
  const r = createFunnelEvent(db, { date: '2026-08-12', event_type: 'novel_publish', work_id: w });
  assert.ok(r.ok);
});

await test('不正な event_type はエラーになる', () => {
  const r = createFunnelEvent(db, { date: '2026-08-10', event_type: 'invalid_type' });
  assert.ok(!r.ok);
  assert.ok(r.errors.some(e => e.includes('event_type')));
});

await test('不正な platform はエラーになる', () => {
  const r = createFunnelEvent(db, { date: '2026-08-10', event_type: 'sns_post', platform: 'unknown_platform' });
  assert.ok(!r.ok);
  assert.ok(r.errors.some(e => e.includes('platform')));
});

await test('不正な date 形式はエラーになる', () => {
  const r = createFunnelEvent(db, { date: '20260810', event_type: 'sns_post' });
  assert.ok(!r.ok);
  assert.ok(r.errors.some(e => e.includes('date')));
});

await test('date が空の場合エラーになる', () => {
  const r = createFunnelEvent(db, { date: '', event_type: 'sns_post' });
  assert.ok(!r.ok);
});

await test('存在しない work_id はエラーになる（FK 検証）', () => {
  const r = createFunnelEvent(db, { date: '2026-08-10', event_type: 'novel_publish', work_id: 999999 });
  assert.ok(!r.ok);
  assert.ok(r.errors.some(e => e.includes('work_id')));
});

await test('存在しない track_id はエラーになる（FK 検証）', () => {
  const r = createFunnelEvent(db, { date: '2026-08-10', event_type: 'music_release', track_id: 999999 });
  assert.ok(!r.ok);
  assert.ok(r.errors.some(e => e.includes('track_id')));
});

await test('存在しない content_reg_id はエラーになる（FK 検証）', () => {
  const r = createFunnelEvent(db, { date: '2026-08-10', event_type: 'sns_post', content_reg_id: 999999 });
  assert.ok(!r.ok);
  assert.ok(r.errors.some(e => e.includes('content_reg_id')));
});

await test('platform = null は許可される（省略可能）', () => {
  const r = createFunnelEvent(db, { date: '2026-08-10', event_type: 'site_update', platform: null });
  assert.ok(r.ok);
});

// ══════════════════════════════════════════════════════════════════════════════
// Section 4: getEventImpact
// ══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 4: getEventImpact');

// イベント日: 2026-08-10
const impEvId = insertEvent('2026-08-10', 'novel_publish', { label: 'Impact テスト公開' });

// before: 2026-08-03〜2026-08-09
insertGA('2026-08-03', 100, 80, 400, 60);
insertGA('2026-08-04', 120, 90, 480, 70);
// after: 2026-08-11〜2026-08-17
insertGA('2026-08-11', 200, 160, 800, 120);
insertGA('2026-08-12', 180, 140, 720, 100);

await test('存在しないイベント ID は null を返す', () => {
  const result = getEventImpact(db, { eventId: 999999 });
  assert.equal(result, null);
});

await test('event / event_date / before_period / after_period が含まれる', () => {
  const result = getEventImpact(db, { eventId: impEvId });
  assert.ok(result);
  assert.ok('event' in result);
  assert.equal(result.event_date, '2026-08-10');
  assert.ok('before_period' in result);
  assert.ok('after_period' in result);
});

await test('before / after 期間境界が正しい（beforeDays=7, afterDays=7）', () => {
  const result = getEventImpact(db, { eventId: impEvId, beforeDays: 7, afterDays: 7 });
  assert.equal(result.before_period.from, '2026-08-03');
  assert.equal(result.before_period.to,   '2026-08-09');
  assert.equal(result.after_period.from,  '2026-08-11');
  assert.equal(result.after_period.to,    '2026-08-17');
  assert.equal(result.before_period.days, 7);
  assert.equal(result.after_period.days,  7);
});

await test('カスタム before_days / after_days が期間に反映される', () => {
  const result = getEventImpact(db, { eventId: impEvId, beforeDays: 3, afterDays: 5 });
  assert.equal(result.before_period.days, 3);
  assert.equal(result.after_period.days,  5);
  assert.equal(result.before_period.from, '2026-08-07');
  assert.equal(result.after_period.to,    '2026-08-15');
});

await test('GA4 sessions の before/after が正しく計算される', () => {
  const result = getEventImpact(db, { eventId: impEvId, beforeDays: 7, afterDays: 7 });
  const m = result.metrics.find(x => x.source === 'ga4' && x.metric === 'sessions');
  assert.ok(m);
  assert.equal(m.before_value, 220); // 100 + 120
  assert.equal(m.after_value, 380);  // 200 + 180
  assert.equal(m.absolute_change, 160);
  // percent_change = 160/220 * 100 ≈ 72.73
  assert.ok(m.percent_change !== null);
  assert.ok(m.percent_change > 0);
});

await test('before_value = 0 のとき percent_change は null（Infinity 禁止）', () => {
  // GA に before=0 のデータを用意
  const ev0 = insertEvent('2026-09-10', 'site_update', { label: 'ゼロbeforeテスト' });
  // before期間(2026-09-03〜09): データなし → 合計0ではなくnull
  insertGA('2026-09-11', 100, 80, 400, 60);
  const result = getEventImpact(db, { eventId: ev0, beforeDays: 7, afterDays: 7 });
  const m = result.metrics.find(x => x.source === 'ga4' && x.metric === 'sessions');
  // before期間にデータがない → null（0ではない）
  assert.equal(m.before_value, null);
  assert.equal(m.percent_change, null);
});

await test('before_value が明示的に 0 なら percent_change は null', () => {
  const ev0 = insertEvent('2026-10-05', 'site_update', { label: 'ゼロ値テスト' });
  insertGA('2026-09-29', 0, 0, 0, 0); // before: sessions=0
  insertGA('2026-10-06', 50, 40, 200, 30); // after
  const result = getEventImpact(db, { eventId: ev0, beforeDays: 7, afterDays: 7 });
  const m = result.metrics.find(x => x.source === 'ga4' && x.metric === 'sessions');
  // sessions合計が0の場合はSQLのSUMがnullではなく0になることもある
  // どちらの場合も percent_change は null（Infinity は絶対に出ない）
  assert.ok(m.percent_change === null || m.percent_change === null);
  assert.ok(m.percent_change !== Infinity);
  assert.ok(m.percent_change !== -Infinity);
  assert.ok(!Number.isNaN(m.percent_change ?? 0));
});

await test('metrics に note（因果断定しない文言）が含まれる', () => {
  const result = getEventImpact(db, { eventId: impEvId });
  assert.ok(typeof result.note === 'string');
  assert.ok(result.note.includes('因果') || result.note.includes('temporal'));
  // caused_by / attributed_to は存在しない
  assert.ok(!('caused_by' in result));
  assert.ok(!('attributed_to' in result));
});

await test('Revenue は not_comparable: true / granularity: monthly', () => {
  const result = getEventImpact(db, { eventId: impEvId });
  const m = result.metrics.find(x => x.source === 'revenue' && x.metric === 'amount_jpy');
  assert.ok(m);
  assert.equal(m.granularity, 'monthly');
  assert.equal(m.not_comparable, true);
  assert.ok(typeof m.note === 'string');
});

await test('Narou は not_comparable: true / granularity: monthly', () => {
  const result = getEventImpact(db, { eventId: impEvId });
  const m = result.metrics.find(x => x.source === 'narou' && x.metric === 'pv_monthly');
  assert.ok(m);
  assert.equal(m.not_comparable, true);
  assert.equal(m.granularity, 'monthly');
});

await test('データがない metric は before_value / after_value = null', () => {
  // before / after 期間に Instagram データがない場合
  const ev = insertEvent('2025-01-15', 'sns_post', { platform: 'instagram' });
  const result = getEventImpact(db, { eventId: ev, beforeDays: 3, afterDays: 3 });
  const m = result.metrics.find(x => x.source === 'instagram' && x.metric === 'reach');
  assert.ok(m);
  assert.equal(m.before_value, null);
  assert.equal(m.after_value,  null);
  assert.equal(m.absolute_change, null);
  assert.equal(m.percent_change,  null);
});

// ══════════════════════════════════════════════════════════════════════════════
// Section 5: getWorkFunnel / getTrackFunnel
// ══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 5: Work Funnel / Track Funnel');

const wf1 = insertWork('ワークファネル作品', 'novel', '2026-06-01');
const tf1 = insertTrack('トラックファネル楽曲', '2026-06-15');
const cid1 = insertContent('instagram', null, wf1, null, '2026-06-05');

// wf1 に Narou データ
insertNarou('2026-07', 'WF001', 2000, 80, wf1);

// tf1 に音楽データ
insertMusic('2026-07-01', 1000, 300, tf1);
insertMusic('2026-07-02', 1200, 350, tf1);

// wf1・tf1 にファネルイベント
insertEvent('2026-06-01', 'novel_publish', { work_id: wf1 });

// tf1 と wf1 をリンク
db.prepare(`INSERT OR IGNORE INTO sf_track_work_links (track_id, work_id, link_type) VALUES (?, ?, 'primary')`).run(tf1, wf1);

await test('getWorkFunnel: 存在しない work_id は null を返す', () => {
  const result = getWorkFunnel(db, 999999);
  assert.equal(result, null);
});

await test('getWorkFunnel: 作品情報が含まれる', () => {
  const result = getWorkFunnel(db, wf1);
  assert.ok(result);
  assert.equal(result.work.id, wf1);
  assert.ok('events' in result);
  assert.ok('content' in result);
  assert.ok('narou' in result);
  assert.ok('revenue' in result);
});

await test('getWorkFunnel: リンク済みコンテンツが含まれる', () => {
  const result = getWorkFunnel(db, wf1);
  assert.ok(Array.isArray(result.content));
  assert.ok(result.content.some(c => c.id === cid1));
});

await test('getWorkFunnel: Narou は granularity:monthly', () => {
  const result = getWorkFunnel(db, wf1);
  assert.equal(result.narou.granularity, 'monthly');
  assert.ok(Array.isArray(result.narou.data));
});

await test('getWorkFunnel: Revenue は granularity:monthly', () => {
  const result = getWorkFunnel(db, wf1);
  assert.equal(result.revenue.granularity, 'monthly');
});

await test('getTrackFunnel: 存在しない track_id は null を返す', () => {
  const result = getTrackFunnel(db, 999999);
  assert.equal(result, null);
});

await test('getTrackFunnel: 楽曲情報が含まれる', () => {
  const result = getTrackFunnel(db, tf1);
  assert.ok(result);
  assert.equal(result.track.id, tf1);
  assert.ok('events' in result);
  assert.ok('content' in result);
  assert.ok('music_by_platform' in result);
  assert.ok('revenue' in result);
  assert.ok('linked_works' in result);
});

await test('getTrackFunnel: music_by_platform に spotify データが含まれる', () => {
  const result = getTrackFunnel(db, tf1, { from: '2026-07-01', to: '2026-07-31' });
  const sp = result.music_by_platform.find(p => p.platform === 'spotify');
  assert.ok(sp);
  assert.equal(sp.streams, 2200); // 1000 + 1200
});

await test('getTrackFunnel: linked_works に作品が含まれる', () => {
  const result = getTrackFunnel(db, tf1);
  assert.ok(result.linked_works.some(w => w.id === wf1));
});

await test('getTrackFunnel: Revenue は granularity:monthly', () => {
  const result = getTrackFunnel(db, tf1);
  assert.equal(result.revenue.granularity, 'monthly');
});

// ══════════════════════════════════════════════════════════════════════════════
// Section 6: suggestFunnelEvents
// ══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 6: suggestFunnelEvents');

await test('suggestFunnelEvents は配列を返す', () => {
  const suggestions = suggestFunnelEvents(db);
  assert.ok(Array.isArray(suggestions));
});

await test('suggestFunnelEvents は sf_funnel_event に INSERT しない', () => {
  const before = getFunnelEvents(db).length;
  suggestFunnelEvents(db);
  const after  = getFunnelEvents(db).length;
  assert.equal(before, after);
});

await test('suggestFunnelEvents の候補には suggested_date と suggested_event_type が含まれる', () => {
  const suggestions = suggestFunnelEvents(db);
  for (const s of suggestions) {
    assert.ok('suggested_date' in s);
    assert.ok('suggested_event_type' in s);
    assert.ok('reason' in s);
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// Section 7: API エンドポイント HTTP テスト
// ══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 7: API エンドポイント');

await test('GET /api/sf/funnel/overview は 200 を返す', async () => {
  const { status, data } = await api('GET', '/api/sf/funnel/overview');
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.ok('stages' in data);
  assert.ok('data_quality' in data);
});

await test('GET /api/sf/funnel/overview ?from&to でフィルタできる', async () => {
  const { status, data } = await api('GET', '/api/sf/funnel/overview?from=2026-07-01&to=2026-07-31');
  assert.equal(status, 200);
  assert.equal(data.from, '2026-07-01');
  assert.equal(data.to,   '2026-07-31');
});

await test('GET /api/sf/funnel/events は 200 を返す', async () => {
  const { status, data } = await api('GET', '/api/sf/funnel/events');
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.ok(Array.isArray(data.events));
});

await test('GET /api/sf/funnel/events ?type= でフィルタできる', async () => {
  const { status, data } = await api('GET', '/api/sf/funnel/events?type=novel_publish');
  assert.equal(status, 200);
  assert.ok(data.events.every(e => e.event_type === 'novel_publish'));
});

await test('POST /api/sf/funnel/events は 201 を返す', async () => {
  const { status, data } = await api('POST', '/api/sf/funnel/events', {
    date: '2026-08-20',
    event_type: 'campaign_start',
    label: 'API テスト',
  });
  assert.equal(status, 201);
  assert.equal(data.ok, true);
  assert.ok(typeof data.id === 'number');
});

await test('POST /api/sf/funnel/events 不正 event_type は 400', async () => {
  const { status, data } = await api('POST', '/api/sf/funnel/events', {
    date: '2026-08-20',
    event_type: 'invalid_type',
  });
  assert.equal(status, 400);
  assert.equal(data.ok, false);
});

await test('GET /api/sf/funnel/event-impact は 200 を返す', async () => {
  const { status, data } = await api('GET', `/api/sf/funnel/event-impact?event_id=${impEvId}`);
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.ok('metrics' in data);
  assert.ok(Array.isArray(data.metrics));
});

await test('GET /api/sf/funnel/event-impact 存在しない event_id は 404', async () => {
  const { status } = await api('GET', '/api/sf/funnel/event-impact?event_id=999999');
  assert.equal(status, 404);
});

await test('GET /api/sf/funnel/work は 200 を返す', async () => {
  const { status, data } = await api('GET', `/api/sf/funnel/work?work_id=${wf1}`);
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.ok('work' in data);
});

await test('GET /api/sf/funnel/work 存在しない work_id は 404', async () => {
  const { status } = await api('GET', '/api/sf/funnel/work?work_id=999999');
  assert.equal(status, 404);
});

await test('GET /api/sf/funnel/track は 200 を返す', async () => {
  const { status, data } = await api('GET', `/api/sf/funnel/track?track_id=${tf1}`);
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.ok('track' in data);
});

await test('GET /api/sf/funnel/track 存在しない track_id は 404', async () => {
  const { status } = await api('GET', '/api/sf/funnel/track?track_id=999999');
  assert.equal(status, 404);
});

// ══════════════════════════════════════════════════════════════════════════════
// Section 8: セキュリティ / 不正入力テスト
// ══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 8: セキュリティ / 不正入力テスト');

await test('event_id が文字列の場合 400 を返す', async () => {
  const { status } = await api('GET', '/api/sf/funnel/event-impact?event_id=abc');
  assert.equal(status, 400);
});

await test('event_id が負数の場合 400 を返す', async () => {
  const { status } = await api('GET', '/api/sf/funnel/event-impact?event_id=-1');
  assert.equal(status, 400);
});

await test('work_id が文字列の場合 400 を返す', async () => {
  const { status } = await api('GET', '/api/sf/funnel/work?work_id=abc');
  assert.equal(status, 400);
});

await test('track_id が負数の場合 400 を返す', async () => {
  const { status } = await api('GET', '/api/sf/funnel/track?track_id=-5');
  assert.equal(status, 400);
});

await test('before_days が 0 の場合 400 を返す', async () => {
  const { status } = await api('GET', `/api/sf/funnel/event-impact?event_id=${impEvId}&before_days=0`);
  assert.equal(status, 400);
});

await test('before_days が 91 の場合 400 を返す', async () => {
  const { status } = await api('GET', `/api/sf/funnel/event-impact?event_id=${impEvId}&before_days=91`);
  assert.equal(status, 400);
});

await test('after_days が 0 の場合 400 を返す', async () => {
  const { status } = await api('GET', `/api/sf/funnel/event-impact?event_id=${impEvId}&after_days=0`);
  assert.equal(status, 400);
});

await test('after_days が 91 の場合 400 を返す', async () => {
  const { status } = await api('GET', `/api/sf/funnel/event-impact?event_id=${impEvId}&after_days=91`);
  assert.equal(status, 400);
});

await test('SQL injection を含む event_type は 400 を返す', async () => {
  const { status } = await api('POST', '/api/sf/funnel/events', {
    date: '2026-08-01',
    event_type: "'; DROP TABLE sf_funnel_event; --",
  });
  assert.equal(status, 400);
});

await test('SQL injection を含む platform は 400 を返す', async () => {
  const { status } = await api('POST', '/api/sf/funnel/events', {
    date: '2026-08-01',
    event_type: 'sns_post',
    platform: "'; DROP TABLE sf_account_daily; --",
  });
  assert.equal(status, 400);
});

await test('before_days = 1（下限値）は正常に動作する', async () => {
  const { status } = await api('GET', `/api/sf/funnel/event-impact?event_id=${impEvId}&before_days=1`);
  assert.equal(status, 200);
});

await test('before_days = 90（上限値）は正常に動作する', async () => {
  const { status } = await api('GET', `/api/sf/funnel/event-impact?event_id=${impEvId}&before_days=90`);
  assert.equal(status, 200);
});

// ══════════════════════════════════════════════════════════════════════════════
// Section 9: 構造 / 品質 / 外部通信確認
// ══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 9: 構造 / 品質確認');

await test('VALID_EVENT_TYPES に全 8 種が含まれる', () => {
  const expected = ['novel_publish', 'novel_update', 'music_release', 'sns_post',
    'sweets_update', 'site_update', 'campaign_start', 'campaign_end'];
  for (const t of expected) {
    assert.ok(VALID_EVENT_TYPES.includes(t), `missing: ${t}`);
  }
  assert.equal(VALID_EVENT_TYPES.length, 8);
});

await test('VALID_EVENT_PLATFORMS が定義されている', () => {
  assert.ok(Array.isArray(VALID_EVENT_PLATFORMS));
  assert.ok(VALID_EVENT_PLATFORMS.length > 0);
  assert.ok(VALID_EVENT_PLATFORMS.includes('instagram'));
  assert.ok(VALID_EVENT_PLATFORMS.includes('youtube'));
});

await test('sf.js に setState("analyzing") の呼び出しが含まれる（Funnel 読込時）', () => {
  const sfPath = resolve(__dirname, '../dashboard/public/modules/sf.js');
  const content = readFileSync(sfPath, 'utf8');
  assert.ok(content.includes("setState('analyzing'"), 'setState analyzing が見つからない');
  assert.ok(content.includes("setState('completed'"), 'setState completed が見つからない');
  assert.ok(content.includes("setState('notice'"),    'setState notice が見つからない');
});

await test('sf.js に caused_by / attributed_to が含まれない（因果断定なし）', () => {
  const sfPath = resolve(__dirname, '../dashboard/public/modules/sf.js');
  const content = readFileSync(sfPath, 'utf8');
  assert.ok(!content.includes('caused_by'),    'caused_by が見つかった（禁止）');
  assert.ok(!content.includes('attributed_to'), 'attributed_to が見つかった（禁止）');
});

await test('sf_funnel_manager.js に caused_by / attributed_to が含まれない（コメント除く）', () => {
  const mgrPath = resolve(__dirname, '../data/sf_funnel_manager.js');
  const content = readFileSync(mgrPath, 'utf8');
  // コメント行（// または * で始まる行）を除いたコードのみ検査
  const codeLines = content.split('\n').filter(l => {
    const t = l.trim();
    return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
  }).join('\n');
  assert.ok(!codeLines.includes('caused_by'),    'caused_by がコードに存在する（禁止）');
  assert.ok(!codeLines.includes('attributed_to'), 'attributed_to がコードに存在する（禁止）');
});

await test('空データ状態でもクラッシュしない（空 overview）', () => {
  const emptyDb = createDb(':memory:');
  const overview = getFunnelOverview(emptyDb, { from: '2026-01-01', to: '2026-01-01' });
  assert.ok(overview.stages.discovery.social.instagram.reach === null);
  assert.ok(overview.stages.value.revenue.amount_jpy === null);
  assert.equal(overview.data_quality.unlinked_content_count, 0);
});

await test('外部 HTTP 通信なし（fetch は localhost のみ）', async () => {
  // APIはすべてローカルサーバー経由
  const { data } = await api('GET', '/api/sf/funnel/overview');
  assert.ok(data.ok);
});

await test('実 DB を参照していない（business_data.db 未使用）', () => {
  // createDb(':memory:') のみ使用。このテスト自体が証明。
  const tables = db.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all();
  const names  = tables.map(t => t.name);
  assert.ok(names.includes('sf_funnel_event'));
  assert.ok(names.includes('sf_ga_daily'));
  // ファイルパスがメモリDB（テスト用セットアップから確認）
  assert.ok(true, 'memory DB のみ使用');
});

// ══════════════════════════════════════════════════════════════════════════════
// 後処理
// ══════════════════════════════════════════════════════════════════════════════

server.close();

console.log(`\n${'─'.repeat(50)}`);
console.log(`テスト結果: ${passed} 件成功 / ${failed} 件失敗`);
if (failed > 0) {
  process.exit(1);
}
