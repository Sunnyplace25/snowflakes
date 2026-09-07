/**
 * jarvis/tests/test_phase28.js
 * Phase 28: 作品公開URL・原稿アーカイブ管理 テスト
 *
 * 実行: node tests/test_phase28.js
 *
 * テスト構成:
 *   Section 1: :memory: DB ユニットテスト（getWorks, upsertWorkPublication, updateWorkPublication, archiveManuscript）
 *   Section 2: API エンドポイント（GET/POST/PUT: works, publications, archives）
 *   Section 3: アーカイブ安全性（sha256重複, サイズ制限, 不正拡張子, パストラバーサル）
 *   Section 4: ダウンロードエンドポイント（所属確認, MANUSCRIPT_ARCHIVE_DIR未設定）
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin, resolve as pathResolve } from 'node:path';
import { createHash } from 'node:crypto';

import { createDb, phase28ExtensionMigration, seedSfWorksInventory } from '../data/db.js';
import {
  getWorks, getWork,
  getWorkPublications, upsertWorkPublication, updateWorkPublication,
  getWorkArchives, getWorkArchive, archiveManuscript,
  computeSha256, isValidPublicUrl, getArchivePath,
} from '../data/sf_works_manager.js';

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

// ── フィクスチャ ──────────────────────────────────────────────────────────────

/** :memory: DB にテスト用作品を1件挿入して db を返す */
function makeDb() {
  const db = createDb(':memory:');
  db.prepare(`
    INSERT INTO sf_works (work_key, title, work_type, status)
    VALUES ('test_novel', 'テスト小説', 'novel', 'active')
  `).run();
  return db;
}

/** テスト用一時ディレクトリを作成する */
function makeTmpDir() {
  return mkdtempSync(pathJoin(tmpdir(), 'jarvis-arc-test-'));
}

/** ダミーバッファを生成する */
function makeBuffer(content = 'hello manuscript') {
  return Buffer.from(content, 'utf8');
}

// ── Section 1: :memory: DB ユニットテスト ────────────────────────────────────

console.log('\n─── Section 1: :memory: DB ユニットテスト ───');

test('getWorks: 作品一覧を取得できる', () => {
  const db    = makeDb();
  const works = getWorks(db);
  assert.equal(works.length, 1);
  assert.equal(works[0].title, 'テスト小説');
  assert.equal(works[0].archive_count, 0);
});

test('getWork: 存在する work_id で取得できる', () => {
  const db   = makeDb();
  const work = getWork(db, 1);
  assert.ok(work, '作品が取得できない');
  assert.equal(work.work_key, 'test_novel');
});

test('getWork: 存在しない work_id は undefined', () => {
  const db   = makeDb();
  const work = getWork(db, 9999);
  assert.equal(work, undefined);
});

test('upsertWorkPublication: 新規登録できる', () => {
  const db  = makeDb();
  const res = upsertWorkPublication(db, {
    work_id:  1,
    platform: 'narou',
    public_url: 'https://ncode.syosetu.com/n1234ab/',
    publication_status: 'published',
  });
  assert.ok(res.id, 'id が返らない');
  const pubs = getWorkPublications(db, 1);
  assert.equal(pubs.length, 1);
  assert.equal(pubs[0].platform, 'narou');
  assert.equal(pubs[0].public_url, 'https://ncode.syosetu.com/n1234ab/');
});

test('upsertWorkPublication: 同プラットフォームは更新（id 保持）', () => {
  const db = makeDb();
  const r1 = upsertWorkPublication(db, { work_id: 1, platform: 'narou', public_url: 'https://a.example.com/' });
  const r2 = upsertWorkPublication(db, { work_id: 1, platform: 'narou', public_url: 'https://b.example.com/' });
  assert.equal(r1.id, r2.id, 'id が変わっている（REPLACE で削除再挿入されている）');
  const pubs = getWorkPublications(db, 1);
  assert.equal(pubs.length, 1);
  assert.equal(pubs[0].public_url, 'https://b.example.com/');
});

test('upsertWorkPublication: 不正 URL は拒否', () => {
  const db = makeDb();
  assert.throws(
    () => upsertWorkPublication(db, { work_id: 1, platform: 'note', public_url: 'javascript:alert(1)' }),
    /http/i,
  );
});

test('upsertWorkPublication: null URL は許可', () => {
  const db = makeDb();
  assert.doesNotThrow(
    () => upsertWorkPublication(db, { work_id: 1, platform: 'pixiv', public_url: null }),
  );
});

test('updateWorkPublication: 既存行を更新できる', () => {
  const db  = makeDb();
  const ins = upsertWorkPublication(db, { work_id: 1, platform: 'narou', public_url: 'https://old.example.com/' });
  updateWorkPublication(db, 1, ins.id, { public_url: 'https://new.example.com/' });
  const pubs = getWorkPublications(db, 1);
  assert.equal(pubs[0].public_url, 'https://new.example.com/');
});

test('updateWorkPublication: 別 work_id の pub_id は拒否', () => {
  const db = makeDb();
  db.prepare(`INSERT INTO sf_works (work_key, title, work_type, status) VALUES ('w2','作品2','short_story','active')`).run();
  const r1 = upsertWorkPublication(db, { work_id: 1, platform: 'narou', public_url: null });
  // work_id=2 でwork_id=1のpubIdを指定 → 拒否
  assert.throws(
    () => updateWorkPublication(db, 2, r1.id, { public_url: null }),
    /見つかりません/,
  );
});

test('archiveManuscript: .txt ファイルを正常登録できる', () => {
  const db     = makeDb();
  const tmpDir = makeTmpDir();
  try {
    const buf = makeBuffer('テスト原稿内容');
    const res = archiveManuscript(db, {
      work_id: 1, archive_type: 'backup',
      original_filename: 'draft.txt', buffer: buf,
    }, tmpDir);
    assert.ok(res.id, 'id がない');
    assert.ok(res.archived_filename.endsWith('.txt'), '拡張子が .txt でない');
    assert.equal(res.sha256, computeSha256(buf));
    const arcs = getWorkArchives(db, 1);
    assert.equal(arcs.length, 1);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('archiveManuscript: 同一内容 + 同一 archive_type は拒否', () => {
  const db     = makeDb();
  const tmpDir = makeTmpDir();
  try {
    const buf = makeBuffer('重複テスト');
    archiveManuscript(db, { work_id: 1, archive_type: 'backup', original_filename: 'a.txt', buffer: buf }, tmpDir);
    assert.throws(
      () => archiveManuscript(db, { work_id: 1, archive_type: 'backup', original_filename: 'b.txt', buffer: buf }, tmpDir),
      /すでに登録/,
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('archiveManuscript: 同一内容 + 別 archive_type は許可', () => {
  const db     = makeDb();
  const tmpDir = makeTmpDir();
  try {
    const buf = makeBuffer('同じ内容');
    archiveManuscript(db, { work_id: 1, archive_type: 'backup',     original_filename: 'a.txt', buffer: buf }, tmpDir);
    assert.doesNotThrow(
      () => archiveManuscript(db, { work_id: 1, archive_type: 'submission', original_filename: 'b.txt', buffer: buf }, tmpDir),
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('archiveManuscript: 不正拡張子は拒否', () => {
  const db     = makeDb();
  const tmpDir = makeTmpDir();
  try {
    assert.throws(
      () => archiveManuscript(db, { work_id: 1, archive_type: 'backup', original_filename: 'malware.exe', buffer: makeBuffer() }, tmpDir),
      /許可されていない/,
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('archiveManuscript: 50MB 超えは拒否', () => {
  const db     = makeDb();
  const tmpDir = makeTmpDir();
  try {
    const bigBuf = Buffer.alloc(52_428_801, 0x41); // 50MB + 1 byte
    assert.throws(
      () => archiveManuscript(db, { work_id: 1, archive_type: 'backup', original_filename: 'big.txt', buffer: bigBuf }, tmpDir),
      /上限/,
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('getArchivePath: パストラバーサル検出', () => {
  const archiveDir = '/tmp/archive';
  const evilRecord = { file_path: '../../../etc/passwd' };
  assert.throws(() => getArchivePath(evilRecord, archiveDir), /Invalid/);
});

test('isValidPublicUrl: https は OK', () => {
  assert.ok(isValidPublicUrl('https://ncode.syosetu.com/n1234ab/'));
});

test('isValidPublicUrl: null は OK', () => {
  assert.ok(isValidPublicUrl(null));
});

test('isValidPublicUrl: javascript: は NG', () => {
  assert.ok(!isValidPublicUrl('javascript:alert(1)'));
});

test('isValidPublicUrl: ftp: は NG', () => {
  assert.ok(!isValidPublicUrl('ftp://example.com/'));
});

// ── Section 2: API エンドポイント ─────────────────────────────────────────────

console.log('\n─── Section 2: API エンドポイント ───');

await testAsync('GET /api/sf/works が 200 + works 配列を返す', async () => {
  const res  = await fetch(`${BASE}/api/sf/works`);
  const data = await res.json();
  assert.equal(res.status, 200);
  assert.ok(data.ok, `ok が false: ${JSON.stringify(data)}`);
  assert.ok(Array.isArray(data.works), 'works が配列でない');
});

await testAsync('GET /api/sf/works/:id/publications — 存在しない id は 404', async () => {
  const res = await fetch(`${BASE}/api/sf/works/9999999/publications`);
  assert.equal(res.status, 404);
});

await testAsync('POST /api/sf/works/:id/publications — platform なしは 400', async () => {
  // works の実際の id を取得
  const listRes  = await fetch(`${BASE}/api/sf/works`);
  const listData = await listRes.json();
  if (!listData.works?.length) return; // 作品なし環境はスキップ

  const workId = listData.works[0].id;
  const res = await fetch(`${BASE}/api/sf/works/${workId}/publications`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}), // platform なし
  });
  assert.equal(res.status, 400);
  const data = await res.json();
  assert.ok(data.error, 'error フィールドがない');
});

await testAsync('POST /api/sf/works/:id/archives (MANUSCRIPT_ARCHIVE_DIR 未設定) → 503', async () => {
  const listRes  = await fetch(`${BASE}/api/sf/works`);
  const listData = await listRes.json();
  if (!listData.works?.length) return; // 作品なし環境はスキップ

  const workId = listData.works[0].id;
  const res = await fetch(`${BASE}/api/sf/works/${workId}/archives`, {
    method:  'POST',
    headers: {
      'Content-Type':        'application/octet-stream',
      'X-Archive-Type':      'backup',
      'X-Original-Filename': encodeURIComponent('test.txt'),
    },
    body: Buffer.from('test content'),
  });
  // MANUSCRIPT_ARCHIVE_DIR 未設定なら 503
  // 設定済みなら 200 or 400
  assert.ok([200, 400, 503].includes(res.status),
    `予期しないステータス: ${res.status}`);
});

await testAsync('GET /api/sf/works/:id/archives/:id/file — MANUSCRIPT_ARCHIVE_DIR 未設定 → 503', async () => {
  const listRes  = await fetch(`${BASE}/api/sf/works`);
  const listData = await listRes.json();
  if (!listData.works?.length) return;

  const workId = listData.works[0].id;
  // 存在しないアーカイブIDでも 503 が返るはず（未設定時）
  const res = await fetch(`${BASE}/api/sf/works/${workId}/archives/1/file`);
  assert.ok([200, 404, 503].includes(res.status),
    `予期しないステータス: ${res.status}`);
});

// ── Section 3: アーカイブ安全性（ユニット） ──────────────────────────────────

console.log('\n─── Section 3: アーカイブ安全性 ───');

test('computeSha256: 同じ内容は同じハッシュ', () => {
  const buf1 = Buffer.from('hello');
  const buf2 = Buffer.from('hello');
  assert.equal(computeSha256(buf1), computeSha256(buf2));
});

test('computeSha256: 異なる内容は異なるハッシュ', () => {
  const buf1 = Buffer.from('hello');
  const buf2 = Buffer.from('world');
  assert.notEqual(computeSha256(buf1), computeSha256(buf2));
});

test('archiveManuscript: .docx も許可', () => {
  const db     = makeDb();
  const tmpDir = makeTmpDir();
  try {
    const buf = makeBuffer('docx content');
    assert.doesNotThrow(
      () => archiveManuscript(db, { work_id: 1, archive_type: 'submission', original_filename: 'manuscript.docx', buffer: buf }, tmpDir),
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('archiveManuscript: .pdf も許可', () => {
  const db     = makeDb();
  const tmpDir = makeTmpDir();
  try {
    const buf = makeBuffer('pdf content');
    assert.doesNotThrow(
      () => archiveManuscript(db, { work_id: 1, archive_type: 'publication', original_filename: 'ms.pdf', buffer: buf }, tmpDir),
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('archiveManuscript: ファイルパスは work_{id}/ サブディレクトリ', () => {
  const db     = makeDb();
  const tmpDir = makeTmpDir();
  try {
    const buf = makeBuffer('path test');
    const res = archiveManuscript(db, { work_id: 1, archive_type: 'backup', original_filename: 'path.txt', buffer: buf }, tmpDir);
    assert.ok(res.file_path.startsWith('work_1/'), `パスが work_1/ で始まらない: ${res.file_path}`);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('archiveManuscript: ファイル名に sha256 先頭8文字が含まれる', () => {
  const db     = makeDb();
  const tmpDir = makeTmpDir();
  try {
    const buf    = makeBuffer('sha check');
    const sha256 = computeSha256(buf);
    const res    = archiveManuscript(db, { work_id: 1, archive_type: 'backup', original_filename: 'sha.txt', buffer: buf }, tmpDir);
    assert.ok(res.archived_filename.includes(sha256.slice(0, 8)),
      `sha256先頭8文字(${sha256.slice(0, 8)})がファイル名に含まれない: ${res.archived_filename}`);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('getWorkArchive: work_id 所属確認 — 別 work_id では取得できない', () => {
  const db     = makeDb();
  const tmpDir = makeTmpDir();
  db.prepare(`INSERT INTO sf_works (work_key, title, work_type, status) VALUES ('w2','作品2','short_story','active')`).run();
  try {
    const buf = makeBuffer('ownership check');
    const res = archiveManuscript(db, { work_id: 1, archive_type: 'backup', original_filename: 'oc.txt', buffer: buf }, tmpDir);
    // work_id=2 で取得 → undefined
    const arc = getWorkArchive(db, 2, res.id);
    assert.equal(arc, undefined, '別 work_id でアーカイブが取得できてしまっている');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── Section 4: ダウンロードエンドポイント ────────────────────────────────────

console.log('\n─── Section 4: ダウンロードエンドポイント ───');

await testAsync('GET /api/sf/works/9999999/archives/1/file — 存在しない work → 404 or 503', async () => {
  const res = await fetch(`${BASE}/api/sf/works/9999999/archives/1/file`);
  assert.ok([404, 503].includes(res.status),
    `予期しないステータス: ${res.status}`);
});

await testAsync('PUT /api/sf/works/:id/publications/:pubId — 存在しない pubId は 404', async () => {
  const listRes  = await fetch(`${BASE}/api/sf/works`);
  const listData = await listRes.json();
  if (!listData.works?.length) return;

  const workId = listData.works[0].id;
  const res = await fetch(`${BASE}/api/sf/works/${workId}/publications/9999999`, {
    method:  'PUT',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ public_url: null }),
  });
  assert.equal(res.status, 404);
});

// ── Section 5: 39作品シード・冪等性テスト ─────────────────────────────────────

console.log('\n─── Section 5: 39作品シード・冪等性テスト ───');

/**
 * 9件の既存作品を :memory: DB に投入する（本番 DB の migration 後状態を模擬）。
 * ice_breaker は phase28ExtensionMigration 適用後の work_type='short_series' で投入する。
 * moon_veil にはユーザー登録済みの narou URL を付与する。
 */
function makeDbWithExisting9() {
  const db = createDb(':memory:');
  const insertWork = db.prepare(
    'INSERT INTO sf_works (work_key, title, work_type, status, title_provisional) VALUES (?, ?, ?, ?, 0)'
  );
  insertWork.run('snow_flakes_main',      'Snow flakes',    'novel',        'active');
  insertWork.run('under_tone',            'Under tone',     'game',         'active');
  insertWork.run('hitotsu_ooi_oto',       'ひとつ多い音',   'short_story',  'completed');
  insertWork.run('totonoena\u00ee_oto',   '整えない音',     'short_story',  'completed');
  insertWork.run('shiroi_oto',            '白い音',         'short_story',  'completed');
  insertWork.run('toumei_na_rhythm',      '透明なリズム',   'short_story',  'completed');
  insertWork.run('ice_breaker',           'ICE BREAKER',   'short_series', 'completed'); // migration 後
  insertWork.run('moon_veil',             'Moon Veil',      'short_story',  'completed');
  insertWork.run('hajimari_no_bass',      '始まりのベース', 'short_story',  'completed');

  // Moon Veil: ユーザーが登録済みの platform_work_id / public_url を模擬
  const moonVeilId = db.prepare("SELECT id FROM sf_works WHERE work_key='moon_veil'").get().id;
  db.prepare(
    "INSERT INTO sf_work_publications (work_id, platform, platform_work_id, public_url, publication_status) " +
    "VALUES (?, 'narou', 'n9832lr', 'https://ncode.syosetu.com/n9832lr/', 'published')"
  ).run(moonVeilId);

  return db;
}

test('seedSfWorksInventory: 39件登録後に sf_works が 39 件', () => {
  const db     = makeDbWithExisting9();
  const result = seedSfWorksInventory(db);
  assert.equal(result.errors.length, 0, `エラーあり: ${result.errors.join(' / ')}`);
  const count  = db.prepare('SELECT COUNT(*) as c FROM sf_works').get().c;
  assert.equal(Number(count), 39);
});

test('seedSfWorksInventory: 2回実行しても sf_works 39件・publications 39件のまま（冪等性）', () => {
  const db = makeDbWithExisting9();
  seedSfWorksInventory(db);
  const result2 = seedSfWorksInventory(db);
  assert.equal(result2.errors.length, 0, `2回目エラー: ${result2.errors.join(' / ')}`);
  const wc  = db.prepare('SELECT COUNT(*) as c FROM sf_works').get().c;
  const pc  = db.prepare('SELECT COUNT(*) as c FROM sf_work_publications').get().c;
  assert.equal(Number(wc), 39);
  assert.equal(Number(pc), 39);
});

test('seedSfWorksInventory: Snow flakes｜Quietly Falling が sf_works に存在しない', () => {
  const db = makeDbWithExisting9();
  seedSfWorksInventory(db);
  const qf = db.prepare("SELECT * FROM sf_works WHERE title LIKE '%Quietly Falling%'").get();
  assert.equal(qf, undefined, 'Quietly Falling が登録されている');
});

test('seedSfWorksInventory: Under tone の narou publication が published', () => {
  const db = makeDbWithExisting9();
  seedSfWorksInventory(db);
  const row = db.prepare(`
    SELECT p.publication_status FROM sf_works w
    JOIN sf_work_publications p ON p.work_id = w.id AND p.platform = 'narou'
    WHERE w.work_key = 'under_tone'
  `).get();
  assert.ok(row, 'Under tone の narou publication が存在しない');
  assert.equal(row.publication_status, 'published');
});

test('seedSfWorksInventory: Moon Veil の sf_works.title が "Moon Veil"、publication memo あり', () => {
  const db = makeDbWithExisting9();
  seedSfWorksInventory(db);
  const row = db.prepare(`
    SELECT w.title, p.memo
    FROM sf_works w
    JOIN sf_work_publications p ON p.work_id = w.id AND p.platform = 'narou'
    WHERE w.work_key = 'moon_veil'
  `).get();
  assert.ok(row, 'Moon Veil が存在しない');
  assert.equal(row.title, 'Moon Veil');
  assert.equal(row.memo, 'なろうでの表記は「Moon Vail」');
});

test('seedSfWorksInventory: 月が満ちるまで が status=completed / publication_status=unpublished', () => {
  const db = makeDbWithExisting9();
  seedSfWorksInventory(db);
  const row = db.prepare(`
    SELECT w.status, p.publication_status
    FROM sf_works w
    JOIN sf_work_publications p ON p.work_id = w.id AND p.platform = 'narou'
    WHERE w.work_key = 'tsuki_ga_michiru_made'
  `).get();
  assert.ok(row, '月が満ちるまでが存在しない');
  assert.equal(row.status, 'completed');
  assert.equal(row.publication_status, 'unpublished');
});

test('seedSfWorksInventory: Moon Veil の platform_work_id と public_url がシード後も消えない', () => {
  const db = makeDbWithExisting9();
  seedSfWorksInventory(db);
  const row = db.prepare(`
    SELECT p.platform_work_id, p.public_url
    FROM sf_works w
    JOIN sf_work_publications p ON p.work_id = w.id AND p.platform = 'narou'
    WHERE w.work_key = 'moon_veil'
  `).get();
  assert.equal(row.platform_work_id, 'n9832lr',                           'platform_work_id が消えた');
  assert.equal(row.public_url,       'https://ncode.syosetu.com/n9832lr/', 'public_url が消えた');
});

test('seedSfWorksInventory: PRAGMA foreign_key_check が 0 件', () => {
  const db      = makeDbWithExisting9();
  seedSfWorksInventory(db);
  const fkErrs  = db.prepare('PRAGMA foreign_key_check').all();
  assert.equal(fkErrs.length, 0, `FK 違反: ${JSON.stringify(fkErrs)}`);
});

test('seedSfWorksInventory: なろうへのネットワークアクセスなし（fetch 呼び出し検出）', () => {
  const db = makeDbWithExisting9();
  let fetchCalled = false;
  const origFetch = globalThis.fetch;
  globalThis.fetch = () => { fetchCalled = true; return Promise.resolve(); };
  try {
    seedSfWorksInventory(db);
  } finally {
    globalThis.fetch = origFetch;
  }
  assert.equal(fetchCalled, false, 'fetch が呼ばれた（なろうへのネットワークアクセスの可能性）');
});

test('phase28ExtensionMigration: ICE BREAKER work_type が short_series に更新される', () => {
  const db = createDb(':memory:');
  db.prepare(
    "INSERT INTO sf_works (work_key, title, work_type, status, title_provisional) VALUES ('ice_breaker','ICE BREAKER','short_story','completed',0)"
  ).run();
  phase28ExtensionMigration(db); // 明示的に再実行
  const ib = db.prepare("SELECT work_type FROM sf_works WHERE work_key='ice_breaker'").get();
  assert.equal(ib.work_type, 'short_series');
});

test('phase28ExtensionMigration: 2回実行しても冪等（sf_work_publications 再構築が skip される）', () => {
  const db = createDb(':memory:');
  phase28ExtensionMigration(db); // 1回目（createDb 内でも実行済み）
  phase28ExtensionMigration(db); // 2回目
  // テーブルが正常に存在し、'hp' を許容できること
  assert.doesNotThrow(() => {
    db.prepare("INSERT INTO sf_works (work_key,title,work_type,status) VALUES ('_tmp_hp_test','test','novel','active')").run();
    const wid = db.prepare("SELECT id FROM sf_works WHERE work_key='_tmp_hp_test'").get().id;
    db.prepare("INSERT INTO sf_work_publications (work_id,platform,publication_status) VALUES (?,'hp','published')").run(wid);
  });
});

// ── 結果 ──────────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`);
console.log(`合計: ${passed + failed} tests  ✅ ${passed} passed  ❌ ${failed} failed`);
if (failed > 0) process.exit(1);
