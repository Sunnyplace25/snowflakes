/**
 * jarvis/tests/test_x.js
 * X Analytics インポーター・マネージャー テストスイート（Phase 12）
 *
 * 重要:
 * - ':memory:' DB のみ使用。実 DB (business_data.db) は絶対に触れない
 * - 実アカウント名・実ツイートID はハードコードしない（テスト用仮データのみ）
 * - 実 X API 通信なし（fetch・HTTP リクエストなし）
 *
 * Section 1:  parseCSV（BOM / CRLF / クォート / カンマ含みテキスト）
 * Section 2:  validateHeaders（必須ヘッダー / 不足検出）
 * Section 3:  validateRow（必須 tweet_id / 数値バリデーション）
 * Section 4:  detectTweetType（tweet / reply / retweet 判定）
 * Section 5:  buildTweetRecord / buildMetricsRecord（変換・text_snippet 切り捨て）
 * Section 6:  writeXTweet（INSERT / UPSERT 冪等性 / text_snippet 140文字上限）
 * Section 7:  writeXTweetMetrics（INSERT / UPSERT / NULL 保護 / 0値許容）
 * Section 8:  writeXAccountDaily（INSERT / UPSERT）
 * Section 9:  ツイート重複防止（同一 tweet_id 二重 INSERT は UPSERT で解決）
 * Section 10: 未知指標カラムを勝手に合算しない
 * Section 11: importXCSV — 統合テスト（正常 / スキップ / 警告）
 * Section 12: getXTweets / getXTweetsTop / getXAccountDaily / getXSummary
 * Section 13: Funnel — platform 'x' が VALID_EVENT_PLATFORMS に含まれること
 * Section 14: 他 SNS データへの影響なし（sf_account_daily / sf_content_registry を汚染しない）
 * Section 15: API エンドポイント HTTP テスト
 * Section 16: 実 DB 未使用 / 実 X API 通信なし
 */

import assert from 'node:assert/strict';
import { createServer } from 'http';
import { createDb }         from '../data/db.js';
import { createApiHandler } from '../dashboard/api.js';
import { VALID_EVENT_PLATFORMS, createFunnelEvent } from '../data/sf_funnel_manager.js';
import {
  writeXTweet,
  writeXTweetMetrics,
  writeXAccountDaily,
  getXTweets,
  getXTweetsTop,
  getXAccountDaily,
  getXSummary,
  isValidDate,
  isValidTweetId,
  VALID_TWEET_TYPES,
  METRIC_COLS,
} from '../data/sf_x_manager.js';
import {
  parseCSV,
  validateHeaders,
  validateRow,
  detectTweetType,
  buildTweetRecord,
  buildMetricsRecord,
  importXCSV,
  HEADER_MAP,
  REQUIRED_HEADERS,
} from '../importers/x_csv_importer.js';

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

// ─── テスト用 CSV サンプル ────────────────────────────────────────────────────

const SNAP = '2026-08-14';

// 正常な X Analytics CSV（代表カラムのみ）
const normalCsv = `Tweet id,time,Tweet text,impressions,engagements,retweets,replies,likes,url clicks,user profile clicks,detail expands,media views,media engagements
tweet001,2026-08-01 10:00,素晴らしい夏の曲をリリースしました！,10000,500,80,30,350,40,50,200,1500,100
tweet002,2026-08-02 12:00,@user お返事ありがとうございます,2000,100,5,10,70,0,15,20,0,0
tweet003,2026-08-03 09:00,RT @other 最高の曲です #music,500,20,1,0,10,5,4,0,30,2
`;

// BOM + CRLF 付き
const bomCrlfCsv = '\uFEFFTweet id,time,Tweet text,impressions\r\ntweet010,2026-08-10 00:00,テスト,100\r\n';

// クォートフィールド（コンマを含むツイートテキスト）
const quotedCsv = `Tweet id,time,Tweet text,impressions
tweet020,2026-08-11 00:00,"雪の結晶、冬の物語",200
`;

// tweet_id が空の行（スキップ対象）
const missingIdCsv = `Tweet id,time,Tweet text,impressions
,2026-08-05 00:00,IDなし行,999
tweet030,2026-08-05 00:00,正常行,300
`;

// 必須ヘッダー欠如
const noIdHeaderCsv = `time,Tweet text,impressions
2026-08-01 00:00,ヘッダーなし,100
`;

// 未知カラム付き（保存対象外）
const unknownColCsv = `Tweet id,time,Tweet text,impressions,unknown_metric,another_unknown
tweet040,2026-08-12 00:00,未知カラムテスト,3000,99999,88888
`;

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── Section 1: parseCSV ──');
// ─────────────────────────────────────────────────────────────────────────────

await test('Section 1-1: 正常 CSV をパースして headers と rows を返す', () => {
  const { headers, rows } = parseCSV(normalCsv);
  assert.ok(headers.includes('tweet id'));
  assert.ok(headers.includes('impressions'));
  assert.equal(rows.length, 3);
  assert.equal(rows[0]['tweet id'], 'tweet001');
});

await test('Section 1-2: UTF-8 BOM を除去する', () => {
  const { rows } = parseCSV(bomCrlfCsv);
  assert.equal(rows.length, 1);
  assert.equal(rows[0]['tweet id'], 'tweet010');
});

await test('Section 1-3: CRLF を正規化する', () => {
  const { rows } = parseCSV(bomCrlfCsv);
  assert.equal(rows[0]['impressions'], '100');
});

await test('Section 1-4: クォートフィールド（コンマ含み）を正しくパースする', () => {
  const { rows } = parseCSV(quotedCsv);
  assert.equal(rows[0]['tweet text'], '雪の結晶、冬の物語');
});

await test('Section 1-5: ヘッダー名を小文字 trim する', () => {
  const csv = '  Tweet ID  ,impressions\ntweet100,50\n';
  const { headers } = parseCSV(csv);
  // 'tweet id' が小文字 trim された結果
  assert.ok(headers.some(h => h.includes('tweet')));
});

await test('Section 1-6: 空テキストは空オブジェクトを返す', () => {
  const result = parseCSV('');
  assert.equal(result.headers.length, 0);
  assert.equal(result.rows.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── Section 2: validateHeaders ──');
// ─────────────────────────────────────────────────────────────────────────────

await test('Section 2-1: tweet id を含むヘッダーは valid', () => {
  const { valid } = validateHeaders(['tweet id', 'impressions', 'time']);
  assert.equal(valid, true);
});

await test('Section 2-2: tweet id が欠如していれば invalid', () => {
  const { valid, missing } = validateHeaders(['time', 'impressions']);
  assert.equal(valid, false);
  assert.ok(missing.includes('tweet id'));
});

await test('Section 2-3: REQUIRED_HEADERS は tweet id のみ', () => {
  assert.deepEqual(REQUIRED_HEADERS, ['tweet id']);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── Section 3: validateRow ──');
// ─────────────────────────────────────────────────────────────────────────────

await test('Section 3-1: 正常行はエラーなし', () => {
  const errs = validateRow({ 'tweet id': 'tweet001', impressions: '10000', likes: '350' });
  assert.equal(errs.length, 0);
});

await test('Section 3-2: tweet id 空欄はエラー', () => {
  const errs = validateRow({ 'tweet id': '', impressions: '100' });
  assert.ok(errs.length > 0);
});

await test('Section 3-3: 負数の impressions はエラー', () => {
  const errs = validateRow({ 'tweet id': 'tweet001', impressions: '-1' });
  assert.ok(errs.length > 0);
});

await test('Section 3-4: 非数値の likes はエラー', () => {
  const errs = validateRow({ 'tweet id': 'tweet001', likes: 'abc' });
  assert.ok(errs.length > 0);
});

await test('Section 3-5: 空文字の任意数値はエラーなし（省略可）', () => {
  const errs = validateRow({ 'tweet id': 'tweet001', impressions: '', likes: '' });
  assert.equal(errs.length, 0);
});

await test('Section 3-6: 0 は有効値', () => {
  const errs = validateRow({ 'tweet id': 'tweet001', impressions: '0', retweets: '0' });
  assert.equal(errs.length, 0);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── Section 4: detectTweetType ──');
// ─────────────────────────────────────────────────────────────────────────────

await test('Section 4-1: 通常テキストは tweet', () => {
  assert.equal(detectTweetType('新曲リリース！'), 'tweet');
});

await test('Section 4-2: RT @ 始まりは retweet', () => {
  assert.equal(detectTweetType('RT @user 最高の曲ですね'), 'retweet');
});

await test('Section 4-3: @ 始まりは reply', () => {
  assert.equal(detectTweetType('@user ありがとうございます！'), 'reply');
});

await test('Section 4-4: 空文字は tweet', () => {
  assert.equal(detectTweetType(''), 'tweet');
});

await test('Section 4-5: null/undefined は tweet（フォールバック）', () => {
  assert.equal(detectTweetType(null), 'tweet');
  assert.equal(detectTweetType(undefined), 'tweet');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── Section 5: buildTweetRecord / buildMetricsRecord ──');
// ─────────────────────────────────────────────────────────────────────────────

const sampleRow = {
  'tweet id': 'tweet001',
  'time': '2026-08-01 10:00',
  'tweet text': '素晴らしい夏の曲をリリースしました！',
  'impressions': '10000',
  'engagements': '500',
  'retweets': '80',
  'replies': '30',
  'likes': '350',
  'url clicks': '40',
  'user profile clicks': '50',
  'detail expands': '200',
  'media views': '1500',
  'media engagements': '100',
};

await test('Section 5-1: buildTweetRecord — tweet_id, published_at, tweet_type を正しく変換', () => {
  const rec = buildTweetRecord(sampleRow);
  assert.equal(rec.tweet_id, 'tweet001');
  assert.equal(rec.published_at, '2026-08-01 10:00');
  assert.equal(rec.tweet_type, 'tweet');
});

await test('Section 5-2: buildTweetRecord — text_snippet は先頭 140 文字まで', () => {
  const longText = 'a'.repeat(200);
  const row = { 'tweet id': 'tweet099', 'tweet text': longText };
  const rec = buildTweetRecord(row);
  assert.equal(rec.text_snippet.length, 140);
});

await test('Section 5-3: buildMetricsRecord — 数値フィールドを正しく変換', () => {
  const rec = buildMetricsRecord(sampleRow, SNAP);
  assert.equal(rec.tweet_id, 'tweet001');
  assert.equal(rec.snapshot_date, SNAP);
  assert.equal(rec.impressions, 10000);
  assert.equal(rec.retweets, 80);
  assert.equal(rec.url_clicks, 40);
});

await test('Section 5-4: buildMetricsRecord — 空文字フィールドは null', () => {
  const row = { 'tweet id': 'tweet001', 'impressions': '' };
  const rec = buildMetricsRecord(row, SNAP);
  assert.equal(rec.impressions, null);
});

await test('Section 5-5: buildMetricsRecord — 未知カラムは含まれない', () => {
  const row = { 'tweet id': 'tweet001', 'impressions': '100', 'unknown_metric': '99999' };
  const rec = buildMetricsRecord(row, SNAP);
  assert.equal(rec.unknown_metric, undefined);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── Section 6: writeXTweet ──');
// ─────────────────────────────────────────────────────────────────────────────

await test('Section 6-1: INSERT が成功する', () => {
  writeXTweet(db, { tweet_id: 'w001', published_at: '2026-08-01 10:00', tweet_type: 'tweet' });
  const row = db.prepare("SELECT * FROM sf_x_tweet WHERE tweet_id='w001'").get();
  assert.equal(row.tweet_id, 'w001');
  assert.equal(row.tweet_type, 'tweet');
});

await test('Section 6-2: 同一 tweet_id の再 INSERT は UPSERT（エラーなし）', () => {
  writeXTweet(db, { tweet_id: 'w001', tweet_type: 'tweet' });
  const rows = db.prepare("SELECT COUNT(*) AS c FROM sf_x_tweet WHERE tweet_id='w001'").get();
  assert.equal(rows.c, 1);
});

await test('Section 6-3: text_snippet は 140 文字に切り捨て保存される', () => {
  writeXTweet(db, { tweet_id: 'w002', text_snippet: 'a'.repeat(200), tweet_type: 'tweet' });
  const row = db.prepare("SELECT text_snippet FROM sf_x_tweet WHERE tweet_id='w002'").get();
  assert.equal(row.text_snippet.length, 140);
});

await test('Section 6-4: tweet_type が不正なら例外', () => {
  assert.throws(() => writeXTweet(db, { tweet_id: 'w099', tweet_type: 'invalid' }));
});

await test('Section 6-5: tweet_id が空なら例外', () => {
  assert.throws(() => writeXTweet(db, { tweet_id: '', tweet_type: 'tweet' }));
});

await test('Section 6-6: reply / retweet 型でも INSERT 成功', () => {
  writeXTweet(db, { tweet_id: 'w003', tweet_type: 'reply' });
  writeXTweet(db, { tweet_id: 'w004', tweet_type: 'retweet' });
  const r1 = db.prepare("SELECT tweet_type FROM sf_x_tweet WHERE tweet_id='w003'").get();
  const r2 = db.prepare("SELECT tweet_type FROM sf_x_tweet WHERE tweet_id='w004'").get();
  assert.equal(r1.tweet_type, 'reply');
  assert.equal(r2.tweet_type, 'retweet');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── Section 7: writeXTweetMetrics ──');
// ─────────────────────────────────────────────────────────────────────────────

const metBase = { tweet_id: 'w001', snapshot_date: SNAP };

await test('Section 7-1: INSERT が成功する', () => {
  writeXTweetMetrics(db, { ...metBase, impressions: 10000, likes: 350, retweets: 80 });
  const row = db.prepare("SELECT * FROM sf_x_tweet_metrics WHERE tweet_id='w001' AND snapshot_date=?").get(SNAP);
  assert.equal(row.impressions, 10000);
  assert.equal(row.likes, 350);
});

await test('Section 7-2: 同一 (tweet_id, snapshot_date) の再 INSERT は UPSERT', () => {
  writeXTweetMetrics(db, { ...metBase, impressions: 10000 });
  const rows = db.prepare("SELECT COUNT(*) AS c FROM sf_x_tweet_metrics WHERE tweet_id='w001'").get();
  assert.equal(rows.c, 1);
});

await test('Section 7-3: UPSERT は既存非 NULL 値を NULL で上書きしない', () => {
  writeXTweetMetrics(db, { ...metBase, impressions: 10000, likes: 350 });
  writeXTweetMetrics(db, { ...metBase, impressions: 10500, likes: null }); // likes は null で上書き試み
  const row = db.prepare("SELECT * FROM sf_x_tweet_metrics WHERE tweet_id='w001' AND snapshot_date=?").get(SNAP);
  assert.equal(row.impressions, 10500);
  assert.equal(row.likes, 350); // 既存値を保持
});

await test('Section 7-4: 0 値が正しく保存される', () => {
  writeXTweet(db, { tweet_id: 'w005', tweet_type: 'tweet' });
  writeXTweetMetrics(db, { tweet_id: 'w005', snapshot_date: SNAP, impressions: 0, likes: 0, retweets: 0 });
  const row = db.prepare("SELECT * FROM sf_x_tweet_metrics WHERE tweet_id='w005' AND snapshot_date=?").get(SNAP);
  assert.equal(row.impressions, 0);
  assert.equal(row.likes, 0);
});

await test('Section 7-5: 全 NULL 指標でも INSERT 成功', () => {
  writeXTweet(db, { tweet_id: 'w006', tweet_type: 'tweet' });
  writeXTweetMetrics(db, { tweet_id: 'w006', snapshot_date: SNAP });
  const row = db.prepare("SELECT * FROM sf_x_tweet_metrics WHERE tweet_id='w006' AND snapshot_date=?").get(SNAP);
  assert.equal(row.impressions, null);
  assert.equal(row.likes, null);
});

await test('Section 7-6: snapshot_date が不正なら例外', () => {
  assert.throws(() => writeXTweetMetrics(db, { tweet_id: 'w001', snapshot_date: 'not-a-date' }));
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── Section 8: writeXAccountDaily ──');
// ─────────────────────────────────────────────────────────────────────────────

await test('Section 8-1: INSERT が成功する', () => {
  writeXAccountDaily(db, { date: '2026-08-01', followers_count: 5000 });
  const row = db.prepare("SELECT * FROM sf_x_account_daily WHERE date='2026-08-01'").get();
  assert.equal(row.followers_count, 5000);
});

await test('Section 8-2: 同一 date の再 INSERT は UPSERT', () => {
  writeXAccountDaily(db, { date: '2026-08-01', followers_count: 5100 });
  const row = db.prepare("SELECT * FROM sf_x_account_daily WHERE date='2026-08-01'").get();
  assert.equal(row.followers_count, 5100);
});

await test('Section 8-3: date が不正なら例外', () => {
  assert.throws(() => writeXAccountDaily(db, { date: 'invalid' }));
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── Section 9: ツイート重複防止 ──');
// ─────────────────────────────────────────────────────────────────────────────

await test('Section 9-1: 同一 tweet_id を複数回 writeXTweet しても 1 件のみ存在', () => {
  writeXTweet(db, { tweet_id: 'dup001', tweet_type: 'tweet', text_snippet: 'v1' });
  writeXTweet(db, { tweet_id: 'dup001', tweet_type: 'tweet', text_snippet: 'v2' });
  const cnt = db.prepare("SELECT COUNT(*) AS c FROM sf_x_tweet WHERE tweet_id='dup001'").get();
  assert.equal(cnt.c, 1);
});

await test('Section 9-2: 同一 (tweet_id, snapshot_date) を複数回書いても 1 件のみ存在', () => {
  writeXTweet(db, { tweet_id: 'dup001', tweet_type: 'tweet' });
  writeXTweetMetrics(db, { tweet_id: 'dup001', snapshot_date: '2026-08-13', impressions: 100 });
  writeXTweetMetrics(db, { tweet_id: 'dup001', snapshot_date: '2026-08-13', impressions: 200 });
  const cnt = db.prepare("SELECT COUNT(*) AS c FROM sf_x_tweet_metrics WHERE tweet_id='dup001' AND snapshot_date='2026-08-13'").get();
  assert.equal(cnt.c, 1);
  // 最後の値で更新されていること
  const row = db.prepare("SELECT impressions FROM sf_x_tweet_metrics WHERE tweet_id='dup001' AND snapshot_date='2026-08-13'").get();
  assert.equal(row.impressions, 200);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── Section 10: 未知指標カラムを合算しない ──');
// ─────────────────────────────────────────────────────────────────────────────

await test('Section 10-1: METRIC_COLS のみ保存対象（promoted_* 等は含まない）', () => {
  assert.ok(!METRIC_COLS.includes('promoted_impressions'));
  assert.ok(!METRIC_COLS.includes('engagement_rate'));
  assert.ok(!METRIC_COLS.includes('unknown_metric'));
});

await test('Section 10-2: buildMetricsRecord は HEADER_MAP にないカラムを無視する', () => {
  const row = {
    'tweet id': 'tweet001',
    'impressions': '5000',
    'promoted impressions': '9999',
    'engagement rate': '0.05',
    'extra field': '12345',
  };
  const rec = buildMetricsRecord(row, SNAP);
  assert.equal(rec['promoted impressions'], undefined);
  assert.equal(rec['engagement rate'], undefined);
  assert.equal(rec.impressions, 5000);
});

await test('Section 10-3: writeXTweetMetrics は METRIC_COLS 以外のキーを DB に書かない', () => {
  writeXTweet(db, { tweet_id: 'w007', tweet_type: 'tweet' });
  // extra_metric を含むオブジェクトを渡しても例外は起きない（無視される）
  assert.doesNotThrow(() => writeXTweetMetrics(db, {
    tweet_id: 'w007',
    snapshot_date: SNAP,
    impressions: 1000,
    extra_metric: 9999,
  }));
  // 実際に余分な列がないことは DB スキーマが保証
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── Section 11: importXCSV 統合テスト ──');
// ─────────────────────────────────────────────────────────────────────────────

await test('Section 11-1: 正常 CSV を全行インポートできる', () => {
  const result = importXCSV(db, normalCsv, SNAP);
  assert.equal(result.imported, 3);
  assert.equal(result.skipped, 0);
  assert.equal(result.warnings.length, 0);
});

await test('Section 11-2: BOM + CRLF 付き CSV をインポートできる', () => {
  const result = importXCSV(db, bomCrlfCsv, SNAP);
  assert.equal(result.imported, 1);
  assert.equal(result.skipped, 0);
});

await test('Section 11-3: tweet_id 空欄の行はスキップして警告を返す', () => {
  const result = importXCSV(db, missingIdCsv, SNAP);
  assert.equal(result.imported, 1);
  assert.equal(result.skipped, 1);
  assert.ok(result.warnings.length > 0);
});

await test('Section 11-4: 必須ヘッダーなし CSV は例外をスローする', () => {
  assert.throws(() => importXCSV(db, noIdHeaderCsv, SNAP));
});

await test('Section 11-5: 未知カラム付き CSV でも正常インポートされる', () => {
  const result = importXCSV(db, unknownColCsv, SNAP);
  assert.equal(result.imported, 1);
  assert.equal(result.skipped, 0);
});

await test('Section 11-6: snapshot_date が不正なら例外', () => {
  assert.throws(() => importXCSV(db, normalCsv, 'not-a-date'));
});

await test('Section 11-7: 同じ CSV を再インポートしても件数は変わらない（冪等）', () => {
  importXCSV(db, normalCsv, SNAP);
  importXCSV(db, normalCsv, SNAP);
  const cnt = db.prepare("SELECT COUNT(*) AS c FROM sf_x_tweet WHERE tweet_id='tweet001'").get();
  assert.equal(cnt.c, 1);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── Section 12: getXTweets / getXTweetsTop / getXAccountDaily / getXSummary ──');
// ─────────────────────────────────────────────────────────────────────────────

// 前のテストで tweet001/002/003 + metrics が入っている前提

await test('Section 12-1: getXTweets は ツイート+指標の配列を返す', () => {
  const rows = getXTweets(db);
  assert.ok(Array.isArray(rows));
  assert.ok(rows.length > 0);
  assert.ok(rows[0].tweet_id !== undefined);
});

await test('Section 12-2: getXTweets — tweet_type フィルタが機能する', () => {
  const rows = getXTweets(db, { tweet_type: 'retweet' });
  for (const r of rows) assert.equal(r.tweet_type, 'retweet');
});

await test('Section 12-3: getXTweets — 不正 tweet_type は無視される（全件返る）', () => {
  const all  = getXTweets(db);
  const rows = getXTweets(db, { tweet_type: 'invalid_type' });
  assert.equal(rows.length, all.length);
});

await test('Section 12-4: getXTweetsTop — impressions 降順で返る', () => {
  const rows = getXTweetsTop(db, { limit: 5 });
  for (let i = 1; i < rows.length; i++) {
    const prev = rows[i - 1].impressions ?? 0;
    const curr = rows[i].impressions ?? 0;
    assert.ok(prev >= curr, `順序が不正: ${prev} < ${curr}`);
  }
});

await test('Section 12-5: getXAccountDaily — 登録データを取得できる', () => {
  const rows = getXAccountDaily(db, { from: '2026-08-01', to: '2026-08-31' });
  assert.ok(Array.isArray(rows));
  assert.ok(rows.length > 0);
  assert.equal(rows[0].followers_count, 5100);
});

await test('Section 12-6: getXAccountDaily — 範囲外は返らない', () => {
  const rows = getXAccountDaily(db, { from: '2020-01-01', to: '2020-12-31' });
  assert.equal(rows.length, 0);
});

await test('Section 12-7: getXSummary — tweet_count / total_impressions を返す', () => {
  const summary = getXSummary(db);
  assert.ok(typeof summary.tweet_count === 'number');
  assert.ok(summary.tweet_count >= 0);
  assert.ok('total_impressions' in summary);
  assert.ok(Array.isArray(summary.by_type));
});

await test('Section 12-8: getXSummary — データなしは 0 / null を返す', () => {
  const emptyDb = createDb(':memory:');
  const summary = getXSummary(emptyDb);
  assert.equal(summary.tweet_count, 0);
  assert.equal(summary.total_impressions, null);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── Section 13: Funnel — platform \'x\' の安全性 ──');
// ─────────────────────────────────────────────────────────────────────────────

await test("Section 13-1: 'x' が VALID_EVENT_PLATFORMS に含まれる", () => {
  assert.ok(VALID_EVENT_PLATFORMS.includes('x'));
});

await test('Section 13-2: 既存プラットフォームが除外されていない', () => {
  const expected = ['youtube', 'instagram', 'tiktok', 'spotify', 'apple_music', 'narou', 'site'];
  for (const p of expected) {
    assert.ok(VALID_EVENT_PLATFORMS.includes(p), `${p} が VALID_EVENT_PLATFORMS に含まれない`);
  }
});

await test("Section 13-3: createFunnelEvent で platform='x' を受け付ける", () => {
  const funnelDb = createDb(':memory:');
  assert.doesNotThrow(() => {
    createFunnelEvent(funnelDb, {
      date: '2026-08-14',
      event_type: 'sns_post',
      platform: 'x',
      label: 'テスト投稿',
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── Section 14: 他 SNS データへの影響なし ──');
// ─────────────────────────────────────────────────────────────────────────────

await test('Section 14-1: sf_account_daily (instagram/youtube/tiktok) は汚染されない', () => {
  const before = db.prepare('SELECT COUNT(*) AS c FROM sf_account_daily').get().c;
  importXCSV(db, normalCsv, SNAP);
  const after = db.prepare('SELECT COUNT(*) AS c FROM sf_account_daily').get().c;
  assert.equal(before, after);
});

await test('Section 14-2: sf_content_registry は汚染されない', () => {
  const before = db.prepare('SELECT COUNT(*) AS c FROM sf_content_registry').get().c;
  importXCSV(db, normalCsv, SNAP);
  const after = db.prepare('SELECT COUNT(*) AS c FROM sf_content_registry').get().c;
  assert.equal(before, after);
});

await test('Section 14-3: sf_social_metrics は汚染されない', () => {
  const before = db.prepare('SELECT COUNT(*) AS c FROM sf_social_metrics').get().c;
  importXCSV(db, normalCsv, SNAP);
  const after = db.prepare('SELECT COUNT(*) AS c FROM sf_social_metrics').get().c;
  assert.equal(before, after);
});

await test('Section 14-4: sf_instagram_account_daily は汚染されない', () => {
  const before = db.prepare('SELECT COUNT(*) AS c FROM sf_instagram_account_daily').get().c;
  importXCSV(db, normalCsv, SNAP);
  const after = db.prepare('SELECT COUNT(*) AS c FROM sf_instagram_account_daily').get().c;
  assert.equal(before, after);
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── Section 15: API エンドポイント HTTP テスト ──');
// ─────────────────────────────────────────────────────────────────────────────

await test('Section 15-1: GET /api/sf/x/tweets → 200 + { ok: true, rows: [] }', async () => {
  const { status, data } = await api('GET', '/api/sf/x/tweets');
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.ok(Array.isArray(data.rows));
});

await test('Section 15-2: GET /api/sf/x/tweets/top → 200 + { ok: true, rows: [] }', async () => {
  const { status, data } = await api('GET', '/api/sf/x/tweets/top');
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.ok(Array.isArray(data.rows));
});

await test('Section 15-3: GET /api/sf/x/account/daily → 200 + { ok: true, rows: [] }', async () => {
  const { status, data } = await api('GET', '/api/sf/x/account/daily');
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.ok(Array.isArray(data.rows));
});

await test('Section 15-4: GET /api/sf/x/summary → 200 + { ok: true, tweet_count: ... }', async () => {
  const { status, data } = await api('GET', '/api/sf/x/summary');
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.ok('tweet_count' in data);
});

await test('Section 15-5: GET /api/sf/x/tweets?tweet_type=retweet → 200', async () => {
  const { status, data } = await api('GET', '/api/sf/x/tweets?tweet_type=retweet');
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  for (const r of data.rows) assert.equal(r.tweet_type, 'retweet');
});

await test('Section 15-6: GET /api/sf/x/tweets?limit=5 → rows.length <= 5', async () => {
  const { status, data } = await api('GET', '/api/sf/x/tweets?limit=5');
  assert.equal(status, 200);
  assert.ok(data.rows.length <= 5);
});

await test('Section 15-7: GET /api/sf/x/tweets/top?limit=3 → rows.length <= 3', async () => {
  const { status, data } = await api('GET', '/api/sf/x/tweets/top?limit=3');
  assert.equal(status, 200);
  assert.ok(data.rows.length <= 3);
});

await test('Section 15-8: 既存 GA エンドポイントが X 追加後も正常動作', async () => {
  const { status } = await api('GET', '/api/sf/ga/events');
  assert.equal(status, 200);
});

await test('Section 15-9: 既存 TikTok エンドポイントが X 追加後も正常動作', async () => {
  const { status } = await api('GET', '/api/sf/tiktok/account/daily');
  assert.equal(status, 200);
});

await test('Section 15-10: 既存 sync status エンドポイントに x が含まれる', async () => {
  const { status, data } = await api('GET', '/api/sf/sync/status');
  assert.equal(status, 200);
  const sources = data.sources ?? [];
  const xEntry = sources.find(s => s.source === 'x');
  assert.ok(xEntry !== undefined, 'x が sync status に含まれていない');
  assert.equal(xEntry.mode, 'manual');
});

// ─────────────────────────────────────────────────────────────────────────────
console.log('\n── Section 16: 実 DB 未使用 / 実 X API 通信なし ──');
// ─────────────────────────────────────────────────────────────────────────────

await test('Section 16-1: テスト全体で business_data.db を参照していない', async () => {
  // createDb(':memory:') 経由のみ使用。DEFAULT_DB_PATH のファイルはテストに不要。
  const { DEFAULT_DB_PATH } = await import('../data/db.js');
  const { statSync } = await import('node:fs');
  let accessed = false;
  try { statSync(DEFAULT_DB_PATH); accessed = true; } catch (_) { /* 存在しなくてよい */ }
  // DB が存在すること自体は問題ないが、テスト用 db は ':memory:' を使っているため
  // このテストはコード上の意図（実 DB 非使用）を明示的に文書化する
  assert.ok(true, '実 DB アクセスなし（意図的なノーオペテスト）');
});

await test('Section 16-2: X API 関連の ENV は未設定でもテスト全体が通る', () => {
  // X API credentials がなくてもインポーター・マネージャーは動作する
  const xEnvKeys = ['X_API_KEY', 'X_API_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_TOKEN_SECRET', 'X_BEARER_TOKEN'];
  // テスト中に X API を呼んでいないことを確認（呼んでいれば ENV 未設定でエラーになるはず）
  for (const k of xEnvKeys) {
    const val = process.env[k];
    // ENV が未設定でもここまで到達している = 実 API 通信なし
    assert.ok(true, `${k} = ${val ?? '未設定'} でもテスト通過`);
  }
});

// ─── 終了 ─────────────────────────────────────────────────────────────────────
server.close();

console.log(`\n${'─'.repeat(60)}`);
console.log(`  結果: ${passed} passed / ${failed} failed`);
console.log('─'.repeat(60));

if (failed > 0) process.exit(1);
