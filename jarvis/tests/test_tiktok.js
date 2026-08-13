/**
 * jarvis/tests/test_tiktok.js
 * TikTok CSV インポーター テストスイート（Phase 8）
 *
 * 重要:
 * - ':memory:' DB のみ使用。実 DB (business_data.db) は絶対に触れない
 * - 実アカウント名・実動画ID はハードコードしない（テスト用仮データのみ）
 * - 外部 API は呼び出さない（TikTok API への接続なし）
 * - JARVIS 内部正規化 CSV フォーマットの canonical header でテストする
 *
 * Section 1:  parseCSV（UTF-8 BOM / CRLF / クォートフィールド / カンマ含タイトル）
 * Section 2:  detectType（Type A / Type B / unknown）
 * Section 3:  validateAccountRow（必須 / 形式 / 範囲 / canonical header 確認）
 * Section 4:  validateVideoRow（必須 / completion_rate 範囲 / 新規フィールド）
 * Section 5:  buildAccountDailyRow（変換 / null 扱い / video_views 非保存確認）
 * Section 6:  buildVideoEntry（変換 / 省略フィールド / published_at）
 * Section 7:  buildVideoSnapshot（変換 / saves / watch_time_min / エラー条件）
 * Section 8:  writeAccountDaily（INSERT / UPSERT / impressions / link_clicks）
 * Section 9:  writeVideoEntry（INSERT / UPSERT / id 返却）
 * Section 10: writeVideoMetrics（INSERT / UPSERT / saves / watch_time_min）
 * Section 11: importTikTokCSV — Type A 統合テスト
 * Section 12: importTikTokCSV — Type B 統合テスト（snapshot_date per-row）
 * Section 13: API エンドポイント HTTP テスト（createApiHandler 使用）
 * Section 14: セキュリティ / 不正入力テスト
 */

import assert from 'node:assert/strict';
import { createServer } from 'http';
import { createDb }         from '../data/db.js';
import { createApiHandler } from '../dashboard/api.js';
import {
  parseCSV,
  detectType,
  validateAccountRow,
  validateVideoRow,
  buildAccountDailyRow,
  buildVideoEntry,
  buildVideoSnapshot,
  writeAccountDaily,
  writeVideoEntry,
  writeVideoMetrics,
  importTikTokCSV,
} from '../importers/tiktok_csv_importer.js';

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

// ─── テスト用 CSV サンプル（JARVIS 内部正規化 canonical header） ────────────────
// Type A: account_daily
// 必須: date / 任意: followers, followers_delta, reach, impressions, profile_visits, link_clicks
const typeACsv = `date,followers,followers_delta,reach,impressions,profile_visits,link_clicks
2026-08-01,10000,50,5000,12000,300,45
2026-08-02,10050,50,6000,14000,320,52
2026-08-03,10100,50,4500,11000,280,38
`;

// Type B: video_metrics
// 必須: video_id / 任意: snapshot_date, title, published_at, duration_sec,
//         views, likes, comments, shares, saves, watch_time_min, avg_watch_sec, completion_rate
const typeBCsv = `snapshot_date,video_id,title,published_at,duration_sec,views,likes,comments,shares,saves,watch_time_min,avg_watch_sec,completion_rate
2026-08-13,vid001,テスト動画1,2026-07-01,30,10000,500,30,80,120,2083.3,12.5,0.65
2026-08-13,vid002,"コンマ,入りタイトル",2026-07-05,25,8000,400,25,60,90,1200.0,9.0,0.55
2026-08-13,vid003,タイトルなし動画,,,,,,,,,,
`;

// ══════════════════════════════════════════════════════════════════════════════
// Section 1: parseCSV
// ══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 1: parseCSV');

await test('基本的な CSV を正しくパースする', () => {
  const { headers, rows } = parseCSV(typeACsv);
  assert.deepEqual(headers, ['date', 'followers', 'followers_delta', 'reach', 'impressions', 'profile_visits', 'link_clicks']);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].date, '2026-08-01');
  assert.equal(rows[0].followers, '10000');
  assert.equal(rows[0].followers_delta, '50');
  assert.equal(rows[0].reach, '5000');
  assert.equal(rows[0].impressions, '12000');
  assert.equal(rows[0].profile_visits, '300');
  assert.equal(rows[0].link_clicks, '45');
});

await test('UTF-8 BOM を除去して正常にパースする', () => {
  const bom = '\uFEFF';
  const { headers, rows } = parseCSV(bom + typeACsv);
  assert.equal(headers[0], 'date');
  assert.equal(rows.length, 3);
});

await test('CRLF 改行を正常にパースする', () => {
  const crlf = typeACsv.replace(/\n/g, '\r\n');
  const { headers, rows } = parseCSV(crlf);
  assert.equal(rows.length, 3);
  assert.equal(rows[0].date, '2026-08-01');
});

await test('クォートフィールド内のカンマを正しく処理する', () => {
  const { headers, rows } = parseCSV(typeBCsv);
  assert.equal(rows[1].title, 'コンマ,入りタイトル');
});

await test('クォートフィールド内の改行を1セルとして扱う', () => {
  const csv = `video_id,title\nvid001,"行1\n行2"\nvid002,普通\n`;
  const { rows } = parseCSV(csv);
  assert.equal(rows[0].title, '行1\n行2');
  assert.equal(rows[1].title, '普通');
});

await test('空のテキストでも安全に処理する', () => {
  const { headers, rows } = parseCSV('');
  assert.equal(headers.length, 0);
  assert.equal(rows.length, 0);
});

await test('空行をスキップする', () => {
  const csv = `date,followers\n2026-08-01,100\n\n2026-08-02,110\n`;
  const { rows } = parseCSV(csv);
  assert.equal(rows.length, 2);
});

await test('ヘッダを小文字・trim 化する', () => {
  const csv = `  Date  , FOLLOWERS , Followers_Delta\n2026-08-01,100,5\n`;
  const { headers } = parseCSV(csv);
  assert.equal(headers[0], 'date');
  assert.equal(headers[1], 'followers');
  assert.equal(headers[2], 'followers_delta');
});

// ══════════════════════════════════════════════════════════════════════════════
// Section 2: detectType
// ══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 2: detectType');

await test('video_id ヘッダがあれば video_metrics を返す', () => {
  assert.equal(detectType(['video_id', 'title', 'views']), 'video_metrics');
});

await test('date があれば（video_id なし）account_daily を返す', () => {
  assert.equal(detectType(['date', 'followers', 'reach']), 'account_daily');
});

await test('date のみでも account_daily を返す（任意フィールドなし）', () => {
  assert.equal(detectType(['date']), 'account_daily');
});

await test('video_id と date が両方あれば video_metrics を優先する', () => {
  assert.equal(detectType(['date', 'followers', 'video_id', 'views']), 'video_metrics');
});

await test('判定不能なヘッダは unknown を返す', () => {
  assert.equal(detectType(['foo', 'bar', 'baz']), 'unknown');
});

await test('空配列は unknown を返す', () => {
  assert.equal(detectType([]), 'unknown');
});

// ══════════════════════════════════════════════════════════════════════════════
// Section 3: validateAccountRow（canonical header 確認含む）
// ══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 3: validateAccountRow');

// canonical header の正常行
const validAccountRow = {
  date: '2026-08-01',
  followers: '10000',
  followers_delta: '50',
  reach: '5000',
  impressions: '12000',
  profile_visits: '300',
  link_clicks: '45',
};

await test('正常な Type A 行はエラーなし（全 canonical フィールド）', () => {
  const errs = validateAccountRow(validAccountRow, 2);
  assert.equal(errs.length, 0);
});

await test('date だけの行もエラーなし（任意フィールドは全部空 OK）', () => {
  const row = { date: '2026-08-01', followers: '', followers_delta: '', reach: '', impressions: '', profile_visits: '', link_clicks: '' };
  const errs = validateAccountRow(row, 2);
  assert.equal(errs.length, 0);
});

await test('date が空の場合エラー', () => {
  const row = { ...validAccountRow, date: '' };
  const errs = validateAccountRow(row, 2);
  assert.ok(errs.some(e => e.includes('date') && e.includes('必須')));
});

await test('date が YYYY-MM-DD 形式でない場合エラー', () => {
  const row = { ...validAccountRow, date: '08/01/2026' };
  const errs = validateAccountRow(row, 2);
  assert.ok(errs.some(e => e.includes('date') && e.includes('形式')));
});

await test('followers が負数の場合エラー', () => {
  const row = { ...validAccountRow, followers: '-100' };
  const errs = validateAccountRow(row, 2);
  assert.ok(errs.some(e => e.includes('followers') && e.includes('0 以上')));
});

await test('followers_delta がマイナスでも正常（整数なら OK）', () => {
  const row = { ...validAccountRow, followers_delta: '-20' };
  const errs = validateAccountRow(row, 2);
  assert.equal(errs.length, 0);
});

await test('followers_delta が小数の場合エラー', () => {
  const row = { ...validAccountRow, followers_delta: '1.5' };
  const errs = validateAccountRow(row, 3);
  assert.ok(errs.some(e => e.includes('followers_delta') && e.includes('整数')));
});

await test('reach が負数の場合エラー', () => {
  const row = { ...validAccountRow, reach: '-1' };
  const errs = validateAccountRow(row, 2);
  assert.ok(errs.some(e => e.includes('reach') && e.includes('0 以上')));
});

await test('impressions / profile_visits / link_clicks が負数の場合エラー', () => {
  for (const col of ['impressions', 'profile_visits', 'link_clicks']) {
    const row = { ...validAccountRow, [col]: '-5' };
    const errs = validateAccountRow(row, 2);
    assert.ok(errs.some(e => e.includes(col) && e.includes('0 以上')));
  }
});

await test('エラーメッセージに行番号が含まれる', () => {
  const row = { ...validAccountRow, date: '' };
  const errs = validateAccountRow(row, 7);
  assert.ok(errs.some(e => e.includes('行 7')));
});

// ══════════════════════════════════════════════════════════════════════════════
// Section 4: validateVideoRow
// ══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 4: validateVideoRow');

// canonical header の正常行
const validVideoRow = {
  snapshot_date: '2026-08-13',
  video_id: 'vid001',
  title: 'テスト動画',
  published_at: '2026-07-01',
  duration_sec: '30',
  views: '10000',
  likes: '500',
  comments: '30',
  shares: '80',
  saves: '120',
  watch_time_min: '2083.3',
  avg_watch_sec: '12.5',
  completion_rate: '0.65',
};

await test('正常な Type B 行はエラーなし（全 canonical フィールド）', () => {
  const errs = validateVideoRow(validVideoRow, 2);
  assert.equal(errs.length, 0);
});

await test('snapshot_date がない（video_id のみ）の行はエラー', () => {
  const row = { video_id: 'vid_min' };
  const errs = validateVideoRow(row, 2);
  assert.ok(errs.some(e => e.includes('snapshot_date') && e.includes('必須')));
});

await test('snapshot_date が空文字の場合エラー', () => {
  const row = { ...validVideoRow, snapshot_date: '' };
  const errs = validateVideoRow(row, 2);
  assert.ok(errs.some(e => e.includes('snapshot_date') && e.includes('必須')));
});

await test('video_id が空の場合エラー', () => {
  const row = { ...validVideoRow, video_id: '' };
  const errs = validateVideoRow(row, 2);
  assert.ok(errs.some(e => e.includes('video_id') && e.includes('必須')));
});

await test('completion_rate が 1.0 を超える場合エラー（0〜100% 形式の拒否）', () => {
  const row = { ...validVideoRow, completion_rate: '65' };
  const errs = validateVideoRow(row, 2);
  assert.ok(errs.some(e => e.includes('completion_rate') && e.includes('0.0〜1.0')));
});

await test('completion_rate が 0.0 と 1.0 の境界値は正常', () => {
  const row0 = { ...validVideoRow, completion_rate: '0.0' };
  const row1 = { ...validVideoRow, completion_rate: '1.0' };
  assert.equal(validateVideoRow(row0, 2).length, 0);
  assert.equal(validateVideoRow(row1, 2).length, 0);
});

await test('saves が負数の場合エラー', () => {
  const row = { ...validVideoRow, saves: '-1' };
  const errs = validateVideoRow(row, 2);
  assert.ok(errs.some(e => e.includes('saves') && e.includes('0 以上')));
});

await test('watch_time_min が負数の場合エラー', () => {
  const row = { ...validVideoRow, watch_time_min: '-1.5' };
  const errs = validateVideoRow(row, 2);
  assert.ok(errs.some(e => e.includes('watch_time_min') && e.includes('0 以上')));
});

await test('avg_watch_sec が負数の場合エラー', () => {
  const row = { ...validVideoRow, avg_watch_sec: '-5' };
  const errs = validateVideoRow(row, 2);
  assert.ok(errs.some(e => e.includes('avg_watch_sec') && e.includes('0 以上')));
});

await test('published_at が ISO8601 形式でも正常', () => {
  const row = { ...validVideoRow, published_at: '2026-07-01T12:00:00Z' };
  assert.equal(validateVideoRow(row, 2).length, 0);
});

await test('snapshot_date が不正形式の場合エラー', () => {
  const row = { ...validVideoRow, snapshot_date: '20260813' };
  const errs = validateVideoRow(row, 2);
  assert.ok(errs.some(e => e.includes('snapshot_date')));
});

// ══════════════════════════════════════════════════════════════════════════════
// Section 5: buildAccountDailyRow
// ══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 5: buildAccountDailyRow');

await test('全 canonical フィールドを正しく変換する', () => {
  const row = buildAccountDailyRow(validAccountRow);
  assert.equal(row.platform, 'tiktok');
  assert.equal(row.date, '2026-08-01');
  assert.equal(row.followers, 10000);
  assert.equal(row.followers_delta, 50);
  assert.equal(row.reach, 5000);
  assert.equal(row.impressions, 12000);
  assert.equal(row.profile_visits, 300);
  assert.equal(row.link_clicks, 45);
  assert.equal(row.import_source, 'csv');
});

await test('空フィールドは null になる', () => {
  const row = { date: '2026-08-01', followers: '', followers_delta: '', reach: '', impressions: '', profile_visits: '', link_clicks: '' };
  const result = buildAccountDailyRow(row);
  assert.equal(result.followers, null);
  assert.equal(result.followers_delta, null);
  assert.equal(result.reach, null);
  assert.equal(result.impressions, null);
  assert.equal(result.profile_visits, null);
  assert.equal(result.link_clicks, null);
});

await test('followers_delta がマイナスの場合も正しく変換', () => {
  const row = { ...validAccountRow, followers_delta: '-30' };
  const result = buildAccountDailyRow(row);
  assert.equal(result.followers_delta, -30);
});

await test('video_views フィールドは結果に含まれない（保存対象外）', () => {
  // video_views キーを意図的に渡しても reach には入らない
  const row = { ...validAccountRow, video_views: '99999', reach: '' };
  const result = buildAccountDailyRow(row);
  assert.equal(result.reach, null); // reach は null のまま
  // video_views プロパティは結果オブジェクトに存在しないこと
  assert.ok(!('video_views' in result));
});

// ══════════════════════════════════════════════════════════════════════════════
// Section 6: buildVideoEntry
// ══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 6: buildVideoEntry');

await test('全フィールドを正しく変換する', () => {
  const entry = buildVideoEntry(validVideoRow);
  assert.equal(entry.platform, 'tiktok');
  assert.equal(entry.content_type, 'tiktok_video');
  assert.equal(entry.platform_id, 'vid001');
  assert.equal(entry.title, 'テスト動画');
  assert.equal(entry.published_at, '2026-07-01');
  assert.equal(entry.duration_sec, 30);
});

await test('published_at が ISO8601 形式の場合 YYYY-MM-DD に切り詰める', () => {
  const row = { ...validVideoRow, published_at: '2026-07-01T12:00:00Z' };
  const entry = buildVideoEntry(row);
  assert.equal(entry.published_at, '2026-07-01');
});

await test('title が空文字列の場合 null になる', () => {
  const row = { ...validVideoRow, title: '' };
  const entry = buildVideoEntry(row);
  assert.equal(entry.title, null);
});

await test('duration_sec が空の場合 null になる', () => {
  const row = { ...validVideoRow, duration_sec: '' };
  const entry = buildVideoEntry(row);
  assert.equal(entry.duration_sec, null);
});

// ══════════════════════════════════════════════════════════════════════════════
// Section 7: buildVideoSnapshot
// ══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 7: buildVideoSnapshot');

await test('全 canonical フィールドを正しく変換する（saves / watch_time_min 含む）', () => {
  const snap = buildVideoSnapshot(validVideoRow, 1, '2026-08-13');
  assert.equal(snap.content_reg_id, 1);
  assert.equal(snap.snapshot_date, '2026-08-13');
  assert.equal(snap.views, 10000);
  assert.equal(snap.likes, 500);
  assert.equal(snap.comments, 30);
  assert.equal(snap.shares, 80);
  assert.equal(snap.saves, 120);
  assert.equal(snap.watch_time_min, 2083.3);
  assert.equal(snap.avg_watch_sec, 12.5);
  assert.equal(snap.completion_rate, 0.65);
  assert.equal(snap.import_source, 'csv');
});

await test('contentRegId が falsy の場合エラーをスローする', () => {
  assert.throws(() => buildVideoSnapshot(validVideoRow, 0, '2026-08-13'), /contentRegId が必要/);
});

await test('不正な snapshotDate の場合エラーをスローする', () => {
  assert.throws(() => buildVideoSnapshot(validVideoRow, 1, 'invalid-date'), /snapshotDate/);
});

await test('saves / watch_time_min が空の場合 null になる', () => {
  const row = { ...validVideoRow, saves: '', watch_time_min: '' };
  const snap = buildVideoSnapshot(row, 1, '2026-08-13');
  assert.equal(snap.saves, null);
  assert.equal(snap.watch_time_min, null);
});

await test('avg_watch_sec が空の場合 null になる', () => {
  const row = { ...validVideoRow, avg_watch_sec: '' };
  const snap = buildVideoSnapshot(row, 1, '2026-08-13');
  assert.equal(snap.avg_watch_sec, null);
});

// ══════════════════════════════════════════════════════════════════════════════
// Section 8: writeAccountDaily
// ══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 8: writeAccountDaily');

await test('impressions / link_clicks を含む新規行を INSERT する', () => {
  const rows = [buildAccountDailyRow({
    date: '2026-07-01', followers: '9000', followers_delta: '40',
    reach: '4000', impressions: '10000', profile_visits: '200', link_clicks: '30',
  })];
  const n = writeAccountDaily(db, rows);
  assert.equal(n, 1);
  const saved = db.prepare(`SELECT * FROM sf_account_daily WHERE platform='tiktok' AND date='2026-07-01'`).get();
  assert.equal(saved.followers, 9000);
  assert.equal(saved.followers_delta, 40);
  assert.equal(saved.reach, 4000);
  assert.equal(saved.impressions, 10000);
  assert.equal(saved.profile_visits, 200);
  assert.equal(saved.link_clicks, 30);
  assert.equal(saved.import_source, 'csv');
});

await test('再 UPSERT で既存値を COALESCE 保護する（impressions / profile_visits）', () => {
  // impressions / profile_visits を NULL で再 UPSERT → 既存値が保たれる
  const rows = [buildAccountDailyRow({
    date: '2026-07-01', followers: '9100', followers_delta: '100',
    reach: '', impressions: '', profile_visits: '', link_clicks: '',
  })];
  writeAccountDaily(db, rows);
  const saved = db.prepare(`SELECT * FROM sf_account_daily WHERE platform='tiktok' AND date='2026-07-01'`).get();
  assert.equal(saved.followers, 9100);        // 更新される
  assert.equal(saved.impressions, 10000);     // 保護される
  assert.equal(saved.profile_visits, 200);    // 保護される
  assert.equal(saved.link_clicks, 30);        // 保護される
});

await test('空配列を渡しても 0 件でエラーなし', () => {
  const n = writeAccountDaily(db, []);
  assert.equal(n, 0);
});

await test('複数行を一括 INSERT する', () => {
  const rows = [
    buildAccountDailyRow({ date: '2026-07-10', followers: '9200', followers_delta: '20', reach: '3500', impressions: '8000', profile_visits: '', link_clicks: '' }),
    buildAccountDailyRow({ date: '2026-07-11', followers: '9220', followers_delta: '20', reach: '3800', impressions: '9000', profile_visits: '', link_clicks: '' }),
  ];
  const n = writeAccountDaily(db, rows);
  assert.equal(n, 2);
});

// ══════════════════════════════════════════════════════════════════════════════
// Section 9: writeVideoEntry
// ══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 9: writeVideoEntry');

await test('新規エントリを INSERT して id を返す', () => {
  const entry = buildVideoEntry({ video_id: 'reg_test_001', title: '挿入テスト', published_at: '2026-07-01', duration_sec: '60' });
  const id = writeVideoEntry(db, entry);
  assert.ok(typeof id === 'number' && id > 0);
});

await test('同じ platform_id への再 UPSERT でタイトルを COALESCE 保護する', () => {
  const entry1 = buildVideoEntry({ video_id: 'reg_test_002', title: '最初のタイトル', published_at: '2026-07-01', duration_sec: '30' });
  const id1 = writeVideoEntry(db, entry1);
  // title を空で再 UPSERT → 最初のタイトルが保たれる
  const entry2 = buildVideoEntry({ video_id: 'reg_test_002', title: '', published_at: '', duration_sec: '' });
  const id2 = writeVideoEntry(db, entry2);
  assert.equal(id1, id2);
  const saved = db.prepare(`SELECT * FROM sf_content_registry WHERE platform='tiktok' AND platform_id='reg_test_002'`).get();
  assert.equal(saved.title, '最初のタイトル');
});

await test('UPSERT 後も content_type が tiktok_video のまま', () => {
  const entry = buildVideoEntry({ video_id: 'reg_test_003', title: '種別テスト', published_at: '', duration_sec: '' });
  writeVideoEntry(db, entry);
  const saved = db.prepare(`SELECT * FROM sf_content_registry WHERE platform='tiktok' AND platform_id='reg_test_003'`).get();
  assert.equal(saved.content_type, 'tiktok_video');
  assert.equal(saved.platform, 'tiktok');
});

// ══════════════════════════════════════════════════════════════════════════════
// Section 10: writeVideoMetrics
// ══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 10: writeVideoMetrics');

await test('saves / watch_time_min を含む新規メトリクスを INSERT する', () => {
  const entry = buildVideoEntry({ video_id: 'metrics_test_001', title: 'メトリクステスト', published_at: '2026-07-15', duration_sec: '45' });
  const regId = writeVideoEntry(db, entry);
  const snap = buildVideoSnapshot(validVideoRow, regId, '2026-08-01');
  writeVideoMetrics(db, snap);
  const saved = db.prepare(`SELECT * FROM sf_social_metrics WHERE content_reg_id=?`).get(regId);
  assert.equal(saved.views, 10000);
  assert.equal(saved.likes, 500);
  assert.equal(saved.saves, 120);
  assert.equal(saved.watch_time_min, 2083.3);
  assert.equal(saved.avg_watch_sec, 12.5);
  assert.equal(saved.completion_rate, 0.65);
  assert.equal(saved.import_source, 'csv');
});

await test('再 UPSERT で saves / watch_time_min を COALESCE 保護する', () => {
  const entry = buildVideoEntry({ video_id: 'metrics_test_002', title: 'COALESCE テスト', published_at: '', duration_sec: '' });
  const regId = writeVideoEntry(db, entry);
  const snap1 = buildVideoSnapshot({ ...validVideoRow, saves: '200', watch_time_min: '3000.0' }, regId, '2026-08-05');
  writeVideoMetrics(db, snap1);
  // saves / watch_time_min を空で再 UPSERT → 保たれる
  const snap2 = buildVideoSnapshot({ ...validVideoRow, saves: '', watch_time_min: '', completion_rate: '0.8' }, regId, '2026-08-05');
  writeVideoMetrics(db, snap2);
  const saved = db.prepare(`SELECT * FROM sf_social_metrics WHERE content_reg_id=? AND snapshot_date='2026-08-05'`).get(regId);
  assert.equal(saved.saves, 200);        // 保護される
  assert.equal(saved.watch_time_min, 3000.0); // 保護される
  assert.equal(saved.completion_rate, 0.8);  // 更新される
});

// ══════════════════════════════════════════════════════════════════════════════
// Section 11: importTikTokCSV — Type A 統合テスト
// ══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 11: importTikTokCSV — Type A');

await test('Type A CSV を正常にインポートする（impressions / link_clicks 含む）', () => {
  const result = importTikTokCSV(db, typeACsv);
  assert.equal(result.type, 'account_daily');
  assert.equal(result.processed, 3);
  assert.equal(result.inserted, 3);
  assert.equal(result.errors.length, 0);
  // impressions と link_clicks が保存されていること
  const row = db.prepare(`SELECT * FROM sf_account_daily WHERE platform='tiktok' AND date='2026-08-01'`).get();
  assert.equal(row.impressions, 12000);
  assert.equal(row.link_clicks, 45);
});

await test('Type A 再インポートで UPSERT が実行される（エラーなし）', () => {
  const result = importTikTokCSV(db, typeACsv);
  assert.equal(result.type, 'account_daily');
  assert.equal(result.errors.length, 0);
});

await test('Type A で不正行があってもスキップし他の行は成功する', () => {
  const csv = `date,followers\n2026-08-20,1000\nBAD_DATE,500\n2026-08-21,1010\n`;
  const result = importTikTokCSV(db, csv);
  assert.equal(result.type, 'account_daily');
  assert.equal(result.errors.length, 1);
  assert.ok(result.errors[0].includes('date'));
  assert.equal(result.inserted, 2);
});

await test('BOM 付き Type A CSV を正常にインポートする', () => {
  const bom = '\uFEFF';
  const result = importTikTokCSV(db, bom + typeACsv);
  assert.equal(result.type, 'account_daily');
  assert.equal(result.errors.length, 0);
});

await test('video_views カラムを持つ CSV は account_daily と判定されるが reach を汚染しない', () => {
  // video_views は canonical header ではなく、reach への代替保存もしない
  const csv = `date,video_views,followers\n2026-09-01,99999,5000\n`;
  const result = importTikTokCSV(db, csv);
  assert.equal(result.type, 'account_daily'); // date があるので account_daily
  assert.equal(result.errors.length, 0);
  const row = db.prepare(`SELECT * FROM sf_account_daily WHERE platform='tiktok' AND date='2026-09-01'`).get();
  assert.equal(row.reach, null); // video_views → reach への代替保存はしない
});

// ══════════════════════════════════════════════════════════════════════════════
// Section 12: importTikTokCSV — Type B 統合テスト
// ══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 12: importTikTokCSV — Type B');

await test('Type B CSV を正常にインポートする（per-row snapshot_date / saves / watch_time_min 含む）', () => {
  const result = importTikTokCSV(db, typeBCsv);
  assert.equal(result.type, 'video_metrics');
  assert.equal(result.processed, 3);
  assert.equal(result.inserted, 3);
  assert.equal(result.errors.length, 0);
  // saves と watch_time_min が保存されていること
  const regRow = db.prepare(`SELECT id FROM sf_content_registry WHERE platform='tiktok' AND platform_id='vid001'`).get();
  const metrics = db.prepare(`SELECT * FROM sf_social_metrics WHERE content_reg_id=? AND snapshot_date='2026-08-13'`).get(regRow.id);
  assert.equal(metrics.saves, 120);
  assert.equal(metrics.watch_time_min, 2083.3);
});

await test('Type B 再インポートで UPSERT が実行される（エラーなし）', () => {
  const result = importTikTokCSV(db, typeBCsv);
  assert.equal(result.type, 'video_metrics');
  assert.equal(result.errors.length, 0);
});

await test('Type B で video_id が空の行はスキップし他の行は成功する', () => {
  const csv = `snapshot_date,video_id,title,views\n2026-08-13,vid_ok_1,有効動画1,1000\n2026-08-13,,空video_id,2000\n2026-08-13,vid_ok_2,有効動画2,3000\n`;
  const result = importTikTokCSV(db, csv);
  assert.equal(result.type, 'video_metrics');
  assert.equal(result.errors.length, 1);
  assert.equal(result.inserted, 2);
});

await test('Type B でカンマ含みタイトルが正しく保存される', () => {
  importTikTokCSV(db, typeBCsv);
  const saved = db.prepare(`SELECT * FROM sf_content_registry WHERE platform='tiktok' AND platform_id='vid002'`).get();
  assert.equal(saved.title, 'コンマ,入りタイトル');
});

await test('per-row snapshot_date が使われる', () => {
  const csv = `snapshot_date,video_id,views\n2026-08-10,vid_snap_row,5000\n`;
  importTikTokCSV(db, csv);
  const regRow = db.prepare(`SELECT id FROM sf_content_registry WHERE platform='tiktok' AND platform_id='vid_snap_row'`).get();
  const m = db.prepare(`SELECT * FROM sf_social_metrics WHERE content_reg_id=?`).get(regRow.id);
  assert.equal(m.snapshot_date, '2026-08-10');
});

await test('snapshot_date が行に存在しない場合はエラー（inserted=0）', () => {
  const csv = `video_id,views\nvid_snap_missing,3000\n`;
  const result = importTikTokCSV(db, csv);
  assert.equal(result.type, 'video_metrics');
  assert.equal(result.errors.length, 1);
  assert.ok(result.errors[0].includes('snapshot_date') && result.errors[0].includes('必須'));
  assert.equal(result.inserted, 0);
});

await test('unknown タイプの CSV は適切なエラーを返す', () => {
  const csv = `foo,bar,baz\n1,2,3\n`;
  const result = importTikTokCSV(db, csv);
  assert.equal(result.type, 'unknown');
  assert.equal(result.errors.length, 1);
  assert.ok(result.errors[0].includes('判定できません'));
});

// ══════════════════════════════════════════════════════════════════════════════
// Section 13: API エンドポイント HTTP テスト
// ══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 13: API エンドポイント');

await test('GET /api/sf/tiktok/account/daily は 200 を返す（impressions / link_clicks 含む）', async () => {
  const { status, data } = await api('GET', '/api/sf/tiktok/account/daily');
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.ok(Array.isArray(data.rows));
  if (data.rows.length > 0) {
    assert.ok('impressions' in data.rows[0]);
    assert.ok('link_clicks' in data.rows[0]);
    assert.ok('reach' in data.rows[0]);
    assert.ok('profile_visits' in data.rows[0]);
  }
});

await test('GET /api/sf/tiktok/account/daily ?from&to でデータを返す', async () => {
  const { status, data } = await api('GET', '/api/sf/tiktok/account/daily?from=2026-08-01&to=2026-08-03');
  assert.equal(status, 200);
  assert.equal(data.from, '2026-08-01');
  assert.equal(data.to, '2026-08-03');
  assert.ok(data.rows.length >= 3);
});

await test('GET /api/sf/tiktok/account/compare は 200 を返す（impressions 含む）', async () => {
  const { status, data } = await api('GET', '/api/sf/tiktok/account/compare?days=30');
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.days, 30);
  assert.ok('current' in data);
  assert.ok('previous' in data);
  assert.ok('followers_count' in data);
  assert.ok('current_impressions' in data);
  assert.ok('previous_impressions' in data);
});

await test('GET /api/sf/tiktok/account/compare ?days=7 で days=7 を返す', async () => {
  const { status, data } = await api('GET', '/api/sf/tiktok/account/compare?days=7');
  assert.equal(status, 200);
  assert.equal(data.days, 7);
});

await test('GET /api/sf/tiktok/account/compare 不正な days はデフォルト 30 に補正', async () => {
  const { status, data } = await api('GET', '/api/sf/tiktok/account/compare?days=999');
  assert.equal(status, 200);
  assert.equal(data.days, 30);
});

await test('GET /api/sf/tiktok/videos は 200 を返す（saves / watch_time_min 含む）', async () => {
  const { status, data } = await api('GET', '/api/sf/tiktok/videos');
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.ok(Array.isArray(data.rows));
  if (data.rows.length > 0) {
    assert.ok('saves' in data.rows[0]);
    assert.ok('watch_time_min' in data.rows[0]);
  }
});

await test('GET /api/sf/tiktok/videos ?limit=2 でレコード数を制限する', async () => {
  const { status, data } = await api('GET', '/api/sf/tiktok/videos?limit=2');
  assert.equal(status, 200);
  assert.ok(data.rows.length <= 2);
});

await test('GET /api/sf/tiktok/videos/top は 200 を返す（saves / watch_time_min が metric として有効）', async () => {
  const { status, data } = await api('GET', '/api/sf/tiktok/videos/top?metric=views&limit=10');
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.equal(data.metric, 'views');
});

await test('GET /api/sf/tiktok/videos/top metric=saves で正常動作', async () => {
  const { status, data } = await api('GET', '/api/sf/tiktok/videos/top?metric=saves');
  assert.equal(status, 200);
  assert.equal(data.metric, 'saves');
});

await test('GET /api/sf/tiktok/videos/top metric=watch_time_min で正常動作', async () => {
  const { status, data } = await api('GET', '/api/sf/tiktok/videos/top?metric=watch_time_min');
  assert.equal(status, 200);
  assert.equal(data.metric, 'watch_time_min');
});

await test('GET /api/sf/tiktok/videos/top metric=completion_rate で正常動作', async () => {
  const { status, data } = await api('GET', '/api/sf/tiktok/videos/top?metric=completion_rate');
  assert.equal(status, 200);
  assert.equal(data.metric, 'completion_rate');
});

await test('GET /api/sf/tiktok/videos/top 不正な limit は 10 に補正', async () => {
  const { status, data } = await api('GET', '/api/sf/tiktok/videos/top?limit=200');
  assert.equal(status, 200);
  assert.equal(data.limit, 10);
});

// ══════════════════════════════════════════════════════════════════════════════
// Section 14: セキュリティ / 不正入力テスト
// ══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 14: セキュリティ / 不正入力テスト');

await test('GET /api/sf/tiktok/videos/top に不正な metric を渡すと 400 を返す', async () => {
  const { status, data } = await api('GET', '/api/sf/tiktok/videos/top?metric=views;DROP TABLE sf_content_registry;--');
  assert.equal(status, 400);
  assert.equal(data.ok, false);
});

await test('GET /api/sf/tiktok/videos/top metric 省略時は 200 で metric=views', async () => {
  const { status, data } = await api('GET', '/api/sf/tiktok/videos/top');
  assert.equal(status, 200);
  assert.equal(data.metric, 'views');
});

await test('GET /api/sf/tiktok/account/daily に不正な日付を渡してもデフォルトで返す', async () => {
  const { status, data } = await api('GET', '/api/sf/tiktok/account/daily?from=not-a-date&to=also-bad');
  assert.equal(status, 200);
  assert.ok(data.ok);
});

await test('GET /api/sf/tiktok/videos に limit=0 を渡すとデフォルト 20 に補正', async () => {
  const { status, data } = await api('GET', '/api/sf/tiktok/videos?limit=0');
  assert.equal(status, 200);
  assert.equal(data.limit, 20);
});

await test('GET /api/sf/tiktok/videos に負の offset を渡すとデフォルト 0 に補正', async () => {
  const { status, data } = await api('GET', '/api/sf/tiktok/videos?offset=-10');
  assert.equal(status, 200);
  assert.equal(data.offset, 0);
});

await test('インポート後も sf_content_registry の platform は既存 CHECK 制約内に収まる', () => {
  const rows = db.prepare(`SELECT DISTINCT platform FROM sf_content_registry`).all();
  const platforms = rows.map(r => r.platform);
  assert.ok(platforms.every(p => ['youtube', 'instagram', 'tiktok'].includes(p)));
});

await test('インポート後も sf_account_daily の platform = tiktok', () => {
  const rows = db.prepare(`SELECT DISTINCT platform FROM sf_account_daily WHERE platform='tiktok'`).all();
  assert.ok(rows.length > 0);
  assert.ok(rows.every(r => r.platform === 'tiktok'));
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
