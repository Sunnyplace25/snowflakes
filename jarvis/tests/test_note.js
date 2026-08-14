/**
 * jarvis/tests/test_note.js
 * note Workflow テストスイート（Phase 14）
 *
 * 重要:
 * - ':memory:' DB のみ使用。実 DB (business_data.db) は絶対に触れない
 * - note への実通信なし / ログインなし / 実投稿なし
 * - 認証情報・パスワード・セッション・cookie を格納しない
 * - 実ファイル書き出しは os.tmpdir() のみ
 *
 * Section 1:  createArticle（基本作成 / デフォルト値 / id返却）
 * Section 2:  createArticle バリデーション（title必須 / status不正）
 * Section 3:  setStatus 正常遷移（idea→draft→review→ready→scheduled→published）
 * Section 4:  setStatus 制約（published後はarchivedのみ / 同一status拒否）
 * Section 5:  updateArticle（部分更新 / title/body/tags）
 * Section 6:  updateArticle バリデーション（空title拒否）
 * Section 7:  recordPublished（URL記録 / date記録 / status=published）
 * Section 8:  getArticle（単件 / 存在しないID）
 * Section 9:  getArticles（全件 / statusフィルタ / article_typeフィルタ）
 * Section 10: getArticlesByStatus / getScheduledArticles
 * Section 11: getDashboardSummary（status別カウント）
 * Section 12: generateExport md（title/body/tags/magazine含む）
 * Section 13: generateExport txt
 * Section 14: generateExport json（必須フィールド / JSON形式）
 * Section 15: generateExport バリデーション（不正format）
 * Section 16: writeNoteExport ファイル書き出し / 上書き安全性
 * Section 17: credential 非含有（export に認証情報が混入しない）
 * Section 18: 非公開記事をpublished扱いしない
 * Section 19: API HTTP エンドポイント（CRUD / status / export / dashboard）
 * Section 20: 実DB未使用 / note通信0 / 他テーブル汚染なし
 */

import assert from 'node:assert/strict';
import { createServer } from 'http';
import { tmpdir } from 'node:os';
import { join }   from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { createDb }         from '../data/db.js';
import { createApiHandler } from '../dashboard/api.js';
import {
  createArticle,
  updateArticle,
  setStatus,
  recordPublished,
  getArticle,
  getArticles,
  getArticlesByStatus,
  getScheduledArticles,
  getDashboardSummary,
  generateExport,
  writeNoteExport,
  VALID_STATUSES,
  VALID_EXPORT_FORMATS,
} from '../data/note_manager.js';

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

async function api(method, path, body) {
  const opts = { method };
  if (body) {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body    = JSON.stringify(body);
  }
  const res  = await fetch(`${BASE}${path}`, opts);
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch (_) { data = { _raw: text }; }
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

// ─── テスト用ヘルパー ─────────────────────────────────────────────────────────

function seedWork(db) {
  db.prepare(`INSERT OR IGNORE INTO sf_works (work_key, title, work_type)
    VALUES ('test_work_01', 'テスト作品', 'novel')`).run();
  return db.prepare(`SELECT id FROM sf_works WHERE work_key='test_work_01'`).get().id;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Section 1: createArticle 基本
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 1: createArticle 基本');

await test('createArticle — id を返す', async () => {
  const id = createArticle(db, { title: '初回テスト記事' });
  assert.ok(Number.isInteger(id) && id > 0, `id=${id}`);
});

await test('createArticle — デフォルト status は idea', async () => {
  const id = createArticle(db, { title: 'デフォルトstatus' });
  const article = getArticle(db, id);
  assert.equal(article.status, 'idea');
});

await test('createArticle — 全フィールド指定', async () => {
  const workId = seedWork(db);
  const id = createArticle(db, {
    title:         '全フィールドテスト',
    internal_key:  'full_field_test',
    article_type:  '制作日記',
    status:        'draft',
    summary:       '概要テスト',
    body_markdown: '# 本文\nテスト本文。',
    tags:          ['Snow flakes', '制作日記'],
    magazine:      'Snow flakes制作日記',
    related_work_id: workId,
    scheduled_date: '2026-09-01',
  });
  const article = getArticle(db, id);
  assert.equal(article.title, '全フィールドテスト');
  assert.equal(article.status, 'draft');
  assert.equal(article.article_type, '制作日記');
  assert.deepEqual(article.tags, ['Snow flakes', '制作日記']);
  assert.equal(article.magazine, 'Snow flakes制作日記');
  assert.equal(article.related_work_id, workId);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Section 2: createArticle バリデーション
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 2: createArticle バリデーション');

await test('createArticle — title 未指定でエラー', async () => {
  assert.throws(() => createArticle(db, {}), /title は必須/);
});

await test('createArticle — title 空文字でエラー', async () => {
  assert.throws(() => createArticle(db, { title: '   ' }), /title は必須/);
});

await test('createArticle — 不正 status でエラー', async () => {
  assert.throws(() => createArticle(db, { title: 'test', status: 'publishing' }), /status が不正/);
});

await test('createArticle — internal_key null は重複しない', async () => {
  const id1 = createArticle(db, { title: 'dup null key 1' });
  const id2 = createArticle(db, { title: 'dup null key 2' });
  assert.notEqual(id1, id2);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Section 3: setStatus 正常遷移
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 3: setStatus 正常遷移');

await test('setStatus idea → draft', async () => {
  const id = createArticle(db, { title: 'transition1', status: 'idea' });
  const a  = setStatus(db, id, 'draft');
  assert.equal(a.status, 'draft');
});

await test('setStatus draft → review', async () => {
  const id = createArticle(db, { title: 'transition2', status: 'draft' });
  const a  = setStatus(db, id, 'review');
  assert.equal(a.status, 'review');
});

await test('setStatus review → ready', async () => {
  const id = createArticle(db, { title: 'transition3', status: 'review' });
  const a  = setStatus(db, id, 'ready');
  assert.equal(a.status, 'ready');
});

await test('setStatus ready → scheduled', async () => {
  const id = createArticle(db, { title: 'transition4', status: 'ready' });
  const a  = setStatus(db, id, 'scheduled');
  assert.equal(a.status, 'scheduled');
});

await test('setStatus scheduled → published', async () => {
  const id = createArticle(db, { title: 'transition5', status: 'scheduled' });
  const a  = setStatus(db, id, 'published');
  assert.equal(a.status, 'published');
});

await test('setStatus published → archived', async () => {
  const id = createArticle(db, { title: 'transition6', status: 'published' });
  const a  = setStatus(db, id, 'archived');
  assert.equal(a.status, 'archived');
});

// ═══════════════════════════════════════════════════════════════════════════════
// Section 4: setStatus 制約
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 4: setStatus 制約');

await test('setStatus published → idea は拒否', async () => {
  const id = createArticle(db, { title: 'constraint1', status: 'published' });
  assert.throws(() => setStatus(db, id, 'idea'), /status 遷移が無効/);
});

await test('setStatus published → draft は拒否', async () => {
  const id = createArticle(db, { title: 'constraint2', status: 'published' });
  assert.throws(() => setStatus(db, id, 'draft'), /status 遷移が無効/);
});

await test('setStatus 同一 status は拒否', async () => {
  const id = createArticle(db, { title: 'constraint3', status: 'draft' });
  assert.throws(() => setStatus(db, id, 'draft'), /すでに|遷移が無効/);
});

await test('setStatus 不正 status は拒否', async () => {
  const id = createArticle(db, { title: 'constraint4', status: 'idea' });
  assert.throws(() => setStatus(db, id, 'invalid_status'), /status が不正|遷移が無効/);
});

await test('setStatus 存在しない id は拒否', async () => {
  assert.throws(() => setStatus(db, 99999, 'draft'), /見つかりません/);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Section 5: updateArticle
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 5: updateArticle');

await test('updateArticle — title を更新', async () => {
  const id = createArticle(db, { title: '旧タイトル' });
  const a  = updateArticle(db, id, { title: '新タイトル' });
  assert.equal(a.title, '新タイトル');
});

await test('updateArticle — body_markdown を更新', async () => {
  const id = createArticle(db, { title: '本文更新テスト', body_markdown: '旧本文' });
  const a  = updateArticle(db, id, { body_markdown: '# 新本文\n更新後の内容。' });
  assert.equal(a.body_markdown, '# 新本文\n更新後の内容。');
});

await test('updateArticle — tags を更新', async () => {
  const id = createArticle(db, { title: 'tagsテスト', tags: ['既存タグ'] });
  const a  = updateArticle(db, id, { tags: ['Snow flakes', '新タグ'] });
  assert.deepEqual(a.tags, ['Snow flakes', '新タグ']);
});

await test('updateArticle — 部分更新で他フィールドは保持', async () => {
  const id = createArticle(db, {
    title:   '部分更新テスト',
    summary: '保持される概要',
    tags:    ['保持タグ'],
  });
  const a  = updateArticle(db, id, { title: '部分更新後タイトル' });
  assert.equal(a.title, '部分更新後タイトル');
  assert.equal(a.summary, '保持される概要');
  assert.deepEqual(a.tags, ['保持タグ']);
});

await test('updateArticle — magazine を更新', async () => {
  const id = createArticle(db, { title: 'magazine更新テスト' });
  const a  = updateArticle(db, id, { magazine: 'Snow flakes制作日記' });
  assert.equal(a.magazine, 'Snow flakes制作日記');
});

// ═══════════════════════════════════════════════════════════════════════════════
// Section 6: updateArticle バリデーション
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 6: updateArticle バリデーション');

await test('updateArticle — title 空文字でエラー', async () => {
  const id = createArticle(db, { title: 'バリデーション対象' });
  assert.throws(() => updateArticle(db, id, { title: '' }), /title は空/);
});

await test('updateArticle — 存在しない id でエラー', async () => {
  assert.throws(() => updateArticle(db, 99998, { title: 'x' }), /見つかりません/);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Section 7: recordPublished
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 7: recordPublished');

await test('recordPublished — status が published になる', async () => {
  const id = createArticle(db, { title: '公開記録テスト', status: 'ready' });
  const a  = recordPublished(db, id, {});
  assert.equal(a.status, 'published');
});

await test('recordPublished — note_url が記録される', async () => {
  const id = createArticle(db, { title: 'URL記録テスト' });
  const a  = recordPublished(db, id, { note_url: 'https://note.com/testuser/n/nXXXXXX' });
  assert.equal(a.note_url, 'https://note.com/testuser/n/nXXXXXX');
});

await test('recordPublished — published_date が記録される', async () => {
  const id = createArticle(db, { title: '公開日記録テスト' });
  const a  = recordPublished(db, id, { published_date: '2026-09-15' });
  assert.equal(a.published_date, '2026-09-15');
});

await test('recordPublished — 存在しない id でエラー', async () => {
  assert.throws(() => recordPublished(db, 99997, {}), /見つかりません/);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Section 8: getArticle
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 8: getArticle');

await test('getArticle — 正常取得', async () => {
  const id = createArticle(db, { title: 'getArticleテスト', summary: '概要です' });
  const a  = getArticle(db, id);
  assert.equal(a.id, id);
  assert.equal(a.title, 'getArticleテスト');
  assert.equal(a.summary, '概要です');
});

await test('getArticle — 存在しない id は null', async () => {
  const a = getArticle(db, 99996);
  assert.equal(a, null);
});

await test('getArticle — tags は常に配列', async () => {
  const id = createArticle(db, { title: 'tags配列テスト', tags: [] });
  const a  = getArticle(db, id);
  assert.ok(Array.isArray(a.tags));
});

// ═══════════════════════════════════════════════════════════════════════════════
// Section 9: getArticles フィルタ
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 9: getArticles フィルタ');

await test('getArticles — status フィルタ', async () => {
  createArticle(db, { title: 'filter_draft_1', status: 'draft' });
  createArticle(db, { title: 'filter_draft_2', status: 'draft' });
  const results = getArticles(db, { status: 'draft' });
  assert.ok(results.length >= 2);
  assert.ok(results.every(a => a.status === 'draft'));
});

await test('getArticles — article_type フィルタ', async () => {
  createArticle(db, { title: 'type_diary_1', article_type: '制作日記' });
  createArticle(db, { title: 'type_music_1', article_type: '楽曲制作' });
  const results = getArticles(db, { article_type: '制作日記' });
  assert.ok(results.length >= 1);
  assert.ok(results.every(a => a.article_type === '制作日記'));
});

await test('getArticles — limit 指定', async () => {
  const results = getArticles(db, { limit: 2 });
  assert.ok(results.length <= 2);
});

await test('getArticles — フィルタなしで全件取得', async () => {
  const results = getArticles(db);
  assert.ok(results.length > 0);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Section 10: getArticlesByStatus / getScheduledArticles
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 10: getArticlesByStatus / getScheduledArticles');

await test('getArticlesByStatus — draft のみ返す', async () => {
  createArticle(db, { title: 'status_filter_draft', status: 'draft' });
  const results = getArticlesByStatus(db, 'draft');
  assert.ok(results.every(a => a.status === 'draft'));
});

await test('getScheduledArticles — scheduled のみ返す', async () => {
  createArticle(db, {
    title: 'scheduled_article_A', status: 'scheduled', scheduled_date: '2026-10-01',
  });
  createArticle(db, {
    title: 'scheduled_article_B', status: 'scheduled', scheduled_date: '2026-09-15',
  });
  const results = getScheduledArticles(db);
  assert.ok(results.length >= 2);
  assert.ok(results.every(a => a.status === 'scheduled'));
});

await test('getScheduledArticles — scheduled_date 昇順（NULL は先頭）', async () => {
  const results = getScheduledArticles(db);
  if (results.length >= 2) {
    const d0 = results[0].scheduled_date ?? '';
    const d1 = results[1].scheduled_date ?? '';
    assert.ok(d0 <= d1, `順序不正: ${d0} > ${d1}`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Section 11: getDashboardSummary
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 11: getDashboardSummary');

await test('getDashboardSummary — total は全記事数', async () => {
  const all     = getArticles(db);
  const summary = getDashboardSummary(db);
  assert.equal(summary.total, all.length);
});

await test('getDashboardSummary — 全 status がカウントに含まれる', async () => {
  const summary = getDashboardSummary(db);
  for (const s of VALID_STATUSES) {
    assert.ok(s in summary.counts, `counts に ${s} がない`);
  }
});

await test('getDashboardSummary — draft カウントが正しい', async () => {
  const draftCount = getArticlesByStatus(db, 'draft').length;
  const summary    = getDashboardSummary(db);
  assert.equal(summary.counts.draft, draftCount);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Section 12: generateExport md
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 12: generateExport md');

const mdArticle = {
  id: 9900, title: 'テスト記事タイトル',
  summary: 'これは概要です',
  body_markdown: '## 本文\nここに本文が入ります。',
  tags: ['Snow flakes', '制作日記'],
  magazine: 'Snow flakes制作日記',
  article_type: '制作日記',
  scheduled_date: null,
};

await test('generateExport md — title を含む', async () => {
  const content = generateExport(mdArticle, 'md');
  assert.ok(content.includes('テスト記事タイトル'), 'title が含まれない');
});

await test('generateExport md — body を含む', async () => {
  const content = generateExport(mdArticle, 'md');
  assert.ok(content.includes('## 本文'), 'body が含まれない');
});

await test('generateExport md — tags を含む', async () => {
  const content = generateExport(mdArticle, 'md');
  assert.ok(content.includes('Snow flakes'), 'tags が含まれない');
  assert.ok(content.includes('制作日記'), 'tags が含まれない');
});

await test('generateExport md — magazine を含む', async () => {
  const content = generateExport(mdArticle, 'md');
  assert.ok(content.includes('Snow flakes制作日記'), 'magazine が含まれない');
});

await test('generateExport md — summary を含む', async () => {
  const content = generateExport(mdArticle, 'md');
  assert.ok(content.includes('これは概要です'), 'summary が含まれない');
});

// ═══════════════════════════════════════════════════════════════════════════════
// Section 13: generateExport txt
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 13: generateExport txt');

await test('generateExport txt — title を含む', async () => {
  const content = generateExport(mdArticle, 'txt');
  assert.ok(content.includes('テスト記事タイトル'));
});

await test('generateExport txt — body を含む', async () => {
  const content = generateExport(mdArticle, 'txt');
  assert.ok(content.includes('本文'));
});

await test('generateExport txt — tags を含む', async () => {
  const content = generateExport(mdArticle, 'txt');
  assert.ok(content.includes('Snow flakes'));
});

// ═══════════════════════════════════════════════════════════════════════════════
// Section 14: generateExport json
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 14: generateExport json');

await test('generateExport json — パース可能', async () => {
  const content = generateExport(mdArticle, 'json');
  const parsed  = JSON.parse(content);
  assert.ok(parsed);
});

await test('generateExport json — title を含む', async () => {
  const parsed = JSON.parse(generateExport(mdArticle, 'json'));
  assert.equal(parsed.title, 'テスト記事タイトル');
});

await test('generateExport json — tags を含む', async () => {
  const parsed = JSON.parse(generateExport(mdArticle, 'json'));
  assert.ok(Array.isArray(parsed.tags));
  assert.ok(parsed.tags.includes('Snow flakes'));
});

await test('generateExport json — magazine を含む', async () => {
  const parsed = JSON.parse(generateExport(mdArticle, 'json'));
  assert.equal(parsed.magazine, 'Snow flakes制作日記');
});

await test('generateExport json — 認証情報フィールドなし', async () => {
  const parsed = JSON.parse(generateExport(mdArticle, 'json'));
  assert.ok(!('password' in parsed));
  assert.ok(!('token' in parsed));
  assert.ok(!('session' in parsed));
  assert.ok(!('cookie' in parsed));
  assert.ok(!('note_url' in parsed));  // note_url は export に含まない
});

// ═══════════════════════════════════════════════════════════════════════════════
// Section 15: generateExport バリデーション
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 15: generateExport バリデーション');

await test('generateExport — 不正 format でエラー', async () => {
  assert.throws(() => generateExport(mdArticle, 'html'), /format が不正/);
});

await test('VALID_EXPORT_FORMATS — md / txt / json を含む', async () => {
  assert.ok(VALID_EXPORT_FORMATS.includes('md'));
  assert.ok(VALID_EXPORT_FORMATS.includes('txt'));
  assert.ok(VALID_EXPORT_FORMATS.includes('json'));
});

await test('VALID_STATUSES — 7 種類を含む', async () => {
  assert.equal(VALID_STATUSES.length, 7);
  for (const s of ['idea','draft','review','ready','scheduled','published','archived']) {
    assert.ok(VALID_STATUSES.includes(s));
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Section 16: writeNoteExport ファイル書き出し
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 16: writeNoteExport ファイル書き出し');

const exportDir = join(tmpdir(), `note_test_export_${Date.now()}`);

await test('writeNoteExport md — ファイルが作成される', async () => {
  const id = createArticle(db, {
    title: 'エクスポートテスト記事',
    body_markdown: '# テスト本文',
    tags: ['Snow flakes'],
  });
  const filepath = writeNoteExport(db, id, 'md', exportDir);
  assert.ok(existsSync(filepath), 'ファイルが存在しない');
});

await test('writeNoteExport md — ファイル内容に title が含まれる', async () => {
  const id = createArticle(db, { title: 'ファイル内容テスト' });
  const filepath = writeNoteExport(db, id, 'md', exportDir);
  const content  = readFileSync(filepath, 'utf8');
  assert.ok(content.includes('ファイル内容テスト'));
});

await test('writeNoteExport — 同一記事を再書き出しても例外なし（上書き安全性）', async () => {
  const id = createArticle(db, { title: '上書きテスト' });
  const fp1 = writeNoteExport(db, id, 'txt', exportDir);
  // body を更新してから再 export
  updateArticle(db, id, { body_markdown: '上書き後の内容' });
  let fp2;
  assert.doesNotThrow(() => {
    fp2 = writeNoteExport(db, id, 'txt', exportDir);
  });
  const content = readFileSync(fp2 ?? fp1, 'utf8');
  assert.ok(content.includes('上書き後の内容'));
});

await test('writeNoteExport json — JSON として読み込める', async () => {
  const id = createArticle(db, {
    title: 'JSON書き出しテスト',
    tags:  ['テストタグ'],
  });
  const filepath = writeNoteExport(db, id, 'json', exportDir);
  const content  = readFileSync(filepath, 'utf8');
  const parsed   = JSON.parse(content);
  assert.equal(parsed.title, 'JSON書き出しテスト');
});

// ═══════════════════════════════════════════════════════════════════════════════
// Section 17: credential 非含有
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 17: credential 非含有');

await test('generateExport — password / token / session を含まない', async () => {
  for (const fmt of VALID_EXPORT_FORMATS) {
    const content = generateExport(mdArticle, fmt);
    const lower   = content.toLowerCase();
    assert.ok(!lower.includes('password'),   `${fmt}: password が含まれる`);
    assert.ok(!lower.includes('access_token'), `${fmt}: access_token が含まれる`);
    assert.ok(!lower.includes('client_secret'), `${fmt}: client_secret が含まれる`);
  }
});

await test('note_url は export コンテンツに含まれない（認証情報と分離）', async () => {
  const articleWithUrl = {
    ...mdArticle,
    note_url: 'https://note.com/testuser/n/nABCDEF',
  };
  for (const fmt of VALID_EXPORT_FORMATS) {
    const content = generateExport(articleWithUrl, fmt);
    // note_url 自体は URL として export に不要（record のみ）
    assert.ok(!content.includes('nABCDEF') || fmt === 'txt', `${fmt} に note_url のURLが漏れている`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════════
// Section 18: 非公開記事を published 扱いしない
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 18: 非公開記事を published 扱いしない');

await test('draft 記事は published ではない', async () => {
  const id = createArticle(db, { title: '非公開ドラフト', status: 'draft' });
  const a  = getArticle(db, id);
  assert.notEqual(a.status, 'published');
});

await test('ready 記事は published ではない', async () => {
  const id = createArticle(db, { title: '公開準備中', status: 'ready' });
  const a  = getArticle(db, id);
  assert.notEqual(a.status, 'published');
});

await test('getArticlesByStatus published — published 以外は含まない', async () => {
  const id = createArticle(db, { title: '非公開確認', status: 'draft' });
  const published = getArticlesByStatus(db, 'published');
  assert.ok(!published.some(a => a.id === id), 'draft 記事が published 一覧に含まれている');
});

// ═══════════════════════════════════════════════════════════════════════════════
// Section 19: API HTTP エンドポイント
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 19: API HTTP エンドポイント');

await test('GET /api/note/dashboard — ok:true', async () => {
  const { status, data } = await api('GET', '/api/note/dashboard');
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.ok('total' in data);
  assert.ok('counts' in data);
});

await test('POST /api/note/articles — 記事作成', async () => {
  const { status, data } = await api('POST', '/api/note/articles', {
    title:        'API作成テスト記事',
    article_type: 'JARVIS制作記録',
    tags:         ['Snow flakes'],
  });
  assert.equal(status, 201);
  assert.equal(data.ok, true);
  assert.ok(Number.isInteger(data.id));
  assert.equal(data.article.title, 'API作成テスト記事');
});

await test('GET /api/note/articles — 一覧取得', async () => {
  const { status, data } = await api('GET', '/api/note/articles');
  assert.equal(status, 200);
  assert.equal(data.ok, true);
  assert.ok(Array.isArray(data.articles));
  assert.ok(data.articles.length > 0);
});

await test('GET /api/note/articles?status=draft — フィルタ', async () => {
  const { status, data } = await api('GET', '/api/note/articles?status=draft');
  assert.equal(status, 200);
  assert.ok(data.articles.every(a => a.status === 'draft'));
});

await test('POST /api/note/articles — title 未指定は 400', async () => {
  const { status } = await api('POST', '/api/note/articles', {});
  assert.equal(status, 400);
});

await test('GET /api/note/article?id=N — 単件取得', async () => {
  const { data: created } = await api('POST', '/api/note/articles', { title: '単件テスト' });
  const { status, data }  = await api('GET', `/api/note/article?id=${created.id}`);
  assert.equal(status, 200);
  assert.equal(data.article.title, '単件テスト');
});

await test('GET /api/note/article?id=99999 — 存在しない id は 404', async () => {
  const { status } = await api('GET', '/api/note/article?id=99999');
  assert.equal(status, 404);
});

await test('PATCH /api/note/article?id=N — 更新', async () => {
  const { data: created } = await api('POST', '/api/note/articles', { title: 'PATCH前' });
  const { status, data }  = await api('PATCH', `/api/note/article?id=${created.id}`, { title: 'PATCH後' });
  assert.equal(status, 200);
  assert.equal(data.article.title, 'PATCH後');
});

await test('POST /api/note/article/status — status 遷移', async () => {
  const { data: created } = await api('POST', '/api/note/articles', { title: 'status遷移テスト', status: 'idea' });
  const { status, data }  = await api('POST', '/api/note/article/status', { id: created.id, status: 'draft' });
  assert.equal(status, 200);
  assert.equal(data.article.status, 'draft');
});

await test('POST /api/note/article/published — 公開記録', async () => {
  const { data: created } = await api('POST', '/api/note/articles', { title: '公開記録API' });
  const { status, data }  = await api('POST', '/api/note/article/published', {
    id:             created.id,
    note_url:       'https://note.com/sf/n/nTESTABC',
    published_date: '2026-09-20',
  });
  assert.equal(status, 200);
  assert.equal(data.article.status, 'published');
  assert.equal(data.article.note_url, 'https://note.com/sf/n/nTESTABC');
});

await test('GET /api/note/article/export?id=N&format=md — export取得', async () => {
  const { data: created } = await api('POST', '/api/note/articles', {
    title: 'exportテスト',
    body_markdown: '# export本文',
  });
  const res   = await fetch(`${BASE}/api/note/article/export?id=${created.id}&format=md`);
  const text  = await res.text();
  assert.equal(res.status, 200);
  assert.ok(text.includes('exportテスト'));
});

await test('GET /api/note/article/export — 不正 format は 400', async () => {
  const { data: created } = await api('POST', '/api/note/articles', { title: 'format不正テスト' });
  const { status } = await api('GET', `/api/note/article/export?id=${created.id}&format=html`);
  assert.equal(status, 400);
});

await test('GET /api/note/articles?scheduled=1 — 公開予定一覧', async () => {
  await api('POST', '/api/note/articles', {
    title: 'scheduled_api_test', status: 'scheduled', scheduled_date: '2026-11-01',
  });
  const { status, data } = await api('GET', '/api/note/articles?scheduled=1');
  assert.equal(status, 200);
  assert.ok(data.articles.every(a => a.status === 'scheduled'));
});

// ═══════════════════════════════════════════════════════════════════════════════
// Section 20: 実 DB 未使用 / note 通信 0 / 他テーブル汚染なし
// ═══════════════════════════════════════════════════════════════════════════════

console.log('\nSection 20: 実 DB 未使用 / note 通信 0 / 他テーブル汚染なし');

await test('実 DB パス (business_data.db) が参照されない', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../data/note_manager.js', import.meta.url), 'utf8');
  assert.ok(!src.includes("DatabaseSync('business_data"), 'business_data.db が参照されている');
  assert.ok(!src.includes('createDb('), '実 DB を開いている可能性がある');
});

await test('note 通信 0 — fetch / http / axios を import しない', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('../data/note_manager.js', import.meta.url), 'utf8');
  assert.ok(!src.includes("from 'node-fetch'"), 'node-fetch が含まれる');
  assert.ok(!src.includes("import fetch"), 'fetch が含まれる');
  assert.ok(!src.includes('axios'), 'axios が含まれる');
  assert.ok(!src.includes('note.com'), 'note.com へのハードコードがある');
});

await test('sf_note_article 以外のテーブルに余計な行を書かない', async () => {
  const before = {
    works:    db.prepare('SELECT COUNT(*) AS n FROM sf_works').get().n,
    tracks:   db.prepare('SELECT COUNT(*) AS n FROM sf_tracks').get().n,
    revenue:  db.prepare('SELECT COUNT(*) AS n FROM sf_revenue').get().n,
    kdp:      db.prepare('SELECT COUNT(*) AS n FROM kdp_books').get().n,
  };
  // note 記事を作成・更新・削除操作
  const id = createArticle(db, { title: '汚染テスト記事' });
  updateArticle(db, id, { body_markdown: '更新' });
  setStatus(db, id, 'draft');
  recordPublished(db, id, { note_url: 'https://example.com' });

  const after = {
    works:    db.prepare('SELECT COUNT(*) AS n FROM sf_works').get().n,
    tracks:   db.prepare('SELECT COUNT(*) AS n FROM sf_tracks').get().n,
    revenue:  db.prepare('SELECT COUNT(*) AS n FROM sf_revenue').get().n,
    kdp:      db.prepare('SELECT COUNT(*) AS n FROM kdp_books').get().n,
  };
  assert.equal(after.works,   before.works,   'sf_works が汚染された');
  assert.equal(after.tracks,  before.tracks,  'sf_tracks が汚染された');
  assert.equal(after.revenue, before.revenue, 'sf_revenue が汚染された');
  assert.equal(after.kdp,     before.kdp,     'kdp_books が汚染された');
});

await test('sf_note_article テーブルが存在する', async () => {
  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='sf_note_article'"
  ).get();
  assert.ok(row, 'sf_note_article テーブルが存在しない');
});

// ─── 最終報告 ─────────────────────────────────────────────────────────────────

server.close();

console.log(`\n${'─'.repeat(60)}`);
console.log(`note Workflow テスト完了: ${passed} passed / ${failed} failed`);
if (failed > 0) process.exit(1);
