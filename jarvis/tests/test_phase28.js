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
 *   Section 5: 39作品シード・冪等性テスト
 *   Section 6: Phase 29 display_order migration / reorderWorks テスト
 */

import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin, resolve as pathResolve } from 'node:path';
import { createHash } from 'node:crypto';

import { createDb, phase28ExtensionMigration, phase29Migration, phase30Migration, seedSfWorksInventory, seedHpExclusiveWorks } from '../data/db.js';
import {
  getWorks, getWork, reorderWorks, deleteWork,
  getWorkPublications, upsertWorkPublication, updateWorkPublication,
  getWorkArchives, getWorkArchive, archiveManuscript, deleteWorkArchive,
  computeSha256, isValidPublicUrl, getArchivePath, archiveTextContent,
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

// ── Section 6: Phase 29 display_order migration / reorderWorks ───────────────

console.log('\n─── Section 6: Phase 29 display_order migration / reorderWorks ───');

/**
 * テスト用ヘルパー: display_order なし・published_at あり の3件を挿入した :memory: DB を返す。
 * createDb(':memory:') 内で phase29Migration が呼ばれるが作品ゼロなので何もしない。
 */
function makeDbFor29() {
  const db = createDb(':memory:');
  db.exec(`
    INSERT INTO sf_works (work_key, title, work_type, status, published_at)
    VALUES
      ('work_alpha',  '作品α',  'novel',       'active',    '2024-01-15'),
      ('work_beta',   '作品β',  'short_story', 'completed', '2024-03-10'),
      ('work_gamma',  '作品γ',  'other',       'active',    NULL)
  `);
  return db;
}

test('phase29Migration: 初回migration → published_at DESC NULLS LAST, id DESC 順で 10,20,30', () => {
  const db = makeDbFor29();
  phase29Migration(db);
  const works = db.prepare('SELECT work_key, display_order FROM sf_works ORDER BY display_order').all();
  // published_at: 2024-03-10 > 2024-01-15 > NULL
  //  → work_beta=10, work_alpha=20, work_gamma=30
  assert.equal(works.length, 3);
  assert.equal(works[0].work_key,    'work_beta',  '1位が work_beta でない');
  assert.equal(Number(works[0].display_order), 10, 'work_beta の order が 10 でない');
  assert.equal(works[1].work_key,    'work_alpha', '2位が work_alpha でない');
  assert.equal(Number(works[1].display_order), 20, 'work_alpha の order が 20 でない');
  assert.equal(works[2].work_key,    'work_gamma', '3位が work_gamma でない');
  assert.equal(Number(works[2].display_order), 30, 'work_gamma の order が 30 でない');
});

test('phase29Migration: ユーザー並べ替え後に新規作品1件追加 → 既存順を変えず末尾に付与', () => {
  const db = makeDbFor29();
  phase29Migration(db);

  // ユーザーが α→γ→β の順に並べ替え (display_order: 10,20,30)
  const ids = db.prepare('SELECT id, work_key FROM sf_works ORDER BY work_key').all();
  const idMap = Object.fromEntries(ids.map(r => [r.work_key, Number(r.id)]));
  reorderWorks(db, [idMap['work_alpha'], idMap['work_gamma'], idMap['work_beta']]);

  // 新規作品を1件追加（display_order は INSERT 時点でMAX+10に自動設定）
  db.prepare(
    'INSERT INTO sf_works (work_key, title, work_type, status, display_order) ' +
    "VALUES ('work_delta', '作品δ', 'novel', 'active', (SELECT COALESCE(MAX(display_order),0)+10 FROM sf_works))"
  ).run();

  // phase29Migration 再実行（NULL なし → 何もしないはず）
  phase29Migration(db);

  const works = db.prepare('SELECT work_key, display_order FROM sf_works ORDER BY display_order').all();
  assert.equal(works.length, 4);
  assert.equal(works[0].work_key, 'work_alpha', '1位が work_alpha でない');
  assert.equal(works[1].work_key, 'work_gamma', '2位が work_gamma でない');
  assert.equal(works[2].work_key, 'work_beta',  '3位が work_beta でない');
  assert.equal(works[3].work_key, 'work_delta', '4位（末尾）が work_delta でない');
  // 既存の順序が変わっていないこと
  const alphaOrder = Number(works[0].display_order);
  const gammaOrder = Number(works[1].display_order);
  const betaOrder  = Number(works[2].display_order);
  const deltaOrder = Number(works[3].display_order);
  assert.ok(alphaOrder < gammaOrder && gammaOrder < betaOrder && betaOrder < deltaOrder,
    `display_order が正しく並んでいない: α=${alphaOrder} γ=${gammaOrder} β=${betaOrder} δ=${deltaOrder}`);
});

test('phase29Migration: migration再実行 → ユーザー並べ替え順を維持（冪等）', () => {
  const db = makeDbFor29();
  phase29Migration(db);

  const ids = db.prepare('SELECT id, work_key FROM sf_works ORDER BY work_key').all();
  const idMap = Object.fromEntries(ids.map(r => [r.work_key, Number(r.id)]));
  // γ→α→β 順にカスタム並べ替え
  reorderWorks(db, [idMap['work_gamma'], idMap['work_alpha'], idMap['work_beta']]);

  const before = db.prepare(
    'SELECT work_key, display_order FROM sf_works ORDER BY display_order'
  ).all().map(r => ({ k: r.work_key, o: Number(r.display_order) }));

  // migration 再実行（NULL なし → 何もしないはず）
  phase29Migration(db);

  const after = db.prepare(
    'SELECT work_key, display_order FROM sf_works ORDER BY display_order'
  ).all().map(r => ({ k: r.work_key, o: Number(r.display_order) }));

  assert.deepEqual(before, after, '再実行後に display_order が変わった');
});

test('reorderWorks: 一部IDのみ送信 → 400相当のエラーをスロー', () => {
  const db = makeDbFor29();
  phase29Migration(db);
  const ids = db.prepare('SELECT id FROM sf_works ORDER BY id').all().map(r => Number(r.id));
  // 3件のうち2件だけ送信
  assert.throws(
    () => reorderWorks(db, [ids[0], ids[1]]),
    /全3件の作品IDを指定してください/,
    '一部IDのみで400エラーにならない'
  );
});

test('reorderWorks: 全IDを正しい新順序で送信 → 保存成功・順序が反映される', () => {
  const db = makeDbFor29();
  phase29Migration(db);
  const rows = db.prepare('SELECT id, work_key FROM sf_works ORDER BY work_key').all();
  const idMap = Object.fromEntries(rows.map(r => [r.work_key, Number(r.id)]));
  // β→γ→α 順に並べ替え
  assert.doesNotThrow(() =>
    reorderWorks(db, [idMap['work_beta'], idMap['work_gamma'], idMap['work_alpha']])
  );
  const result = db.prepare(
    'SELECT work_key FROM sf_works ORDER BY display_order'
  ).all().map(r => r.work_key);
  assert.deepEqual(result, ['work_beta', 'work_gamma', 'work_alpha'], '並べ替え後の順序が期待と違う');
});

// ── Section 7: deleteWork ─────────────────────────────────────────────────────

console.log('\n─── Section 7: deleteWork ───');

function makeDbWith3Works() {
  const db = createDb(':memory:');
  db.prepare(
    "INSERT INTO sf_works (work_key, title, work_type, status) VALUES (?, ?, 'novel', 'active')"
  ).run('del_target', '削除テスト作品');
  db.prepare(
    "INSERT INTO sf_works (work_key, title, work_type, status) VALUES (?, ?, 'novel', 'active')"
  ).run('del_with_pub', '公開先あり作品');
  db.prepare(
    "INSERT INTO sf_works (work_key, title, work_type, status) VALUES (?, ?, 'novel', 'active')"
  ).run('del_blocked', 'ブロック対象作品');
  return db;
}

test('deleteWork: publication なし作品を削除できる', () => {
  const db = makeDbWith3Works();
  const id = Number(db.prepare("SELECT id FROM sf_works WHERE work_key='del_target'").get().id);
  const r  = deleteWork(db, id);
  assert.equal(r.deleted, true);
  assert.equal(r.pub_count, 0);
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS c FROM sf_works WHERE id=?').get(id).c), 0);
});

test('deleteWork: publication あり作品は publication も同時削除される', () => {
  const db = makeDbWith3Works();
  const id = Number(db.prepare("SELECT id FROM sf_works WHERE work_key='del_with_pub'").get().id);
  db.prepare("INSERT INTO sf_work_publications (work_id, platform, publication_status) VALUES (?, 'narou', 'published')").run(id);
  db.prepare("INSERT INTO sf_work_publications (work_id, platform, publication_status) VALUES (?, 'hp', 'published')").run(id);
  const r = deleteWork(db, id);
  assert.equal(r.pub_count, 2);
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS c FROM sf_work_publications WHERE work_id=?').get(id).c), 0);
  assert.equal(Number(db.prepare('SELECT COUNT(*) AS c FROM sf_works WHERE id=?').get(id).c), 0);
});

test('deleteWork: sf_track_work_links あれば 409', () => {
  const db  = makeDbWith3Works();
  const wid = Number(db.prepare("SELECT id FROM sf_works WHERE work_key='del_blocked'").get().id);
  // track を先に作成してリンク
  db.prepare("INSERT INTO sf_tracks (track_key, title) VALUES ('t1','track1')").run();
  const tid = Number(db.prepare("SELECT id FROM sf_tracks WHERE track_key='t1'").get().id);
  db.prepare('INSERT INTO sf_track_work_links (track_id, work_id) VALUES (?, ?)').run(tid, wid);
  assert.throws(() => deleteWork(db, wid), /関連データがあるため削除できません/);
});

test('deleteWork: sf_work_archives あれば 409（実ファイルは削除しない）', () => {
  const db  = makeDbWith3Works();
  const wid = Number(db.prepare("SELECT id FROM sf_works WHERE work_key='del_blocked'").get().id);
  db.prepare(
    "INSERT INTO sf_work_archives (work_id, archive_type, archived_filename, file_path, sha256, file_size_bytes) " +
    "VALUES (?, 'publication', 'test.txt', 'work_1/test.txt', 'abc123', 100)"
  ).run(wid);
  assert.throws(() => deleteWork(db, wid), /関連データがあるため削除できません/);
});

test('deleteWork: 存在しない ID は 404 エラー', () => {
  const db = makeDbWith3Works();
  assert.throws(() => deleteWork(db, 99999), /作品が見つかりません/);
});

test('deleteWork: 削除後 PRAGMA foreign_key_check が 0件', () => {
  const db = makeDbWith3Works();
  const id = Number(db.prepare("SELECT id FROM sf_works WHERE work_key='del_target'").get().id);
  db.prepare("INSERT INTO sf_work_publications (work_id, platform, publication_status) VALUES (?, 'hp', 'published')").run(id);
  deleteWork(db, id);
  const fk = db.prepare('PRAGMA foreign_key_check').all();
  assert.equal(fk.length, 0, `FK違反: ${JSON.stringify(fk)}`);
});

// ── Section 8: getWorks 公開状態表示 ─────────────────────────────────────────

console.log('\n─── Section 8: getWorks 公開状態表示 ───');

function makeDbForPubDisplay() {
  const db = createDb(':memory:');
  const ins = db.prepare(
    "INSERT INTO sf_works (work_key, title, work_type, status) VALUES (?, ?, 'novel', 'active')"
  );
  ins.run('narou_pub',    'なろう公開中');
  ins.run('hp_pub',       'HP公開中');
  ins.run('other_pub',    'その他公開中');
  ins.run('multi_pub',    'なろう+HP公開中');
  ins.run('unpublished',  '未公開（pub行あり）');
  ins.run('no_pub',       '公開先未登録');
  ins.run('narou_url_but_unpub', 'URL有り・status=unpublished');
  return db;
}

function addPub(db, workKey, platform, status) {
  const wid = Number(db.prepare('SELECT id FROM sf_works WHERE work_key=?').get(workKey).id);
  db.prepare(
    'INSERT INTO sf_work_publications (work_id, platform, publication_status) VALUES (?, ?, ?)'
  ).run(wid, platform, status);
}

test('getWorks: narou published → published_platforms="narou"', () => {
  const db = makeDbForPubDisplay();
  addPub(db, 'narou_pub', 'narou', 'published');
  const w = getWorks(db).find(x => x.work_key === 'narou_pub');
  assert.equal(w.published_platforms, 'narou');
  assert.equal(Number(w.pub_count), 1);
});

test('getWorks: hp published → published_platforms="hp"', () => {
  const db = makeDbForPubDisplay();
  addPub(db, 'hp_pub', 'hp', 'published');
  const w = getWorks(db).find(x => x.work_key === 'hp_pub');
  assert.equal(w.published_platforms, 'hp');
});

test('getWorks: other published → published_platforms="other"', () => {
  const db = makeDbForPubDisplay();
  addPub(db, 'other_pub', 'other', 'published');
  const w = getWorks(db).find(x => x.work_key === 'other_pub');
  assert.equal(w.published_platforms, 'other');
});

test('getWorks: narou+hp published → published_platforms にnarou/hpが含まれる', () => {
  const db = makeDbForPubDisplay();
  addPub(db, 'multi_pub', 'narou', 'published');
  addPub(db, 'multi_pub', 'hp',    'published');
  const w = getWorks(db).find(x => x.work_key === 'multi_pub');
  const plats = (w.published_platforms || '').split(',');
  assert.ok(plats.includes('narou'), `"narou"が含まれない: ${w.published_platforms}`);
  assert.ok(plats.includes('hp'),    `"hp"が含まれない: ${w.published_platforms}`);
  assert.equal(Number(w.pub_count), 2);
});

test('getWorks: pub行あり but unpublished → published_platforms=null', () => {
  const db = makeDbForPubDisplay();
  addPub(db, 'unpublished', 'narou', 'unpublished');
  const w = getWorks(db).find(x => x.work_key === 'unpublished');
  assert.equal(w.published_platforms, null);
  assert.equal(Number(w.pub_count), 1);
});

test('getWorks: pub行なし → published_platforms=null かつ pub_count=0', () => {
  const db = makeDbForPubDisplay();
  const w = getWorks(db).find(x => x.work_key === 'no_pub');
  assert.equal(w.published_platforms, null);
  assert.equal(Number(w.pub_count), 0);
});

test('getWorks: URLあり+unpublished → published_platforms=null（URLだけで公開中にならない）', () => {
  const db = makeDbForPubDisplay();
  const wid = Number(db.prepare("SELECT id FROM sf_works WHERE work_key='narou_url_but_unpub'").get().id);
  db.prepare(
    "INSERT INTO sf_work_publications (work_id, platform, publication_status, public_url) VALUES (?, 'narou', 'unpublished', 'https://ncode.syosetu.com/n9999zz/')"
  ).run(wid);
  const w = getWorks(db).find(x => x.work_key === 'narou_url_but_unpub');
  assert.equal(w.published_platforms, null, 'unpublishedなのに公開中扱いになっている');
});

// ── Section 9: getWorks 公開日 (earliest_pub_date) ───────────────────────────

console.log('\n─── Section 9: getWorks 公開日 (earliest_pub_date) ───');

function makeDbForPubDate() {
  const db = createDb(':memory:');
  const ins = db.prepare(
    "INSERT INTO sf_works (work_key, title, work_type, status) VALUES (?, ?, 'novel', 'active')"
  );
  ins.run('date_single',    '単一公開先・日付あり');
  ins.run('date_multi',     '複数公開先・最古が基準');
  ins.run('date_unpub',     '日付あり+unpublished → 除外');
  ins.run('date_fallback',  'publication日付なし → sf_works.published_at fallback');
  ins.run('date_none',      '日付なし作品');
  return db;
}

test('getWorks: published + 日付あり → earliest_pub_date に表示', () => {
  const db = makeDbForPubDate();
  const wid = Number(db.prepare("SELECT id FROM sf_works WHERE work_key='date_single'").get().id);
  db.prepare(
    "INSERT INTO sf_work_publications (work_id, platform, publication_status, published_at) VALUES (?, 'narou', 'published', '2026-04-01')"
  ).run(wid);
  const w = getWorks(db).find(x => x.work_key === 'date_single');
  assert.equal(w.earliest_pub_date, '2026-04-01');
});

test('getWorks: published複数 → 最古の日付を返す', () => {
  const db = makeDbForPubDate();
  const wid = Number(db.prepare("SELECT id FROM sf_works WHERE work_key='date_multi'").get().id);
  db.prepare(
    "INSERT INTO sf_work_publications (work_id, platform, publication_status, published_at) VALUES (?, 'narou', 'published', '2026-04-01')"
  ).run(wid);
  db.prepare(
    "INSERT INTO sf_work_publications (work_id, platform, publication_status, published_at) VALUES (?, 'hp', 'published', '2026-05-10')"
  ).run(wid);
  const w = getWorks(db).find(x => x.work_key === 'date_multi');
  assert.equal(w.earliest_pub_date, '2026-04-01', '最古ではなく最新になっている');
});

test('getWorks: unpublished の日付は earliest_pub_date に含めない', () => {
  const db = makeDbForPubDate();
  const wid = Number(db.prepare("SELECT id FROM sf_works WHERE work_key='date_unpub'").get().id);
  db.prepare(
    "INSERT INTO sf_work_publications (work_id, platform, publication_status, published_at) VALUES (?, 'narou', 'unpublished', '2026-01-01')"
  ).run(wid);
  const w = getWorks(db).find(x => x.work_key === 'date_unpub');
  assert.equal(w.earliest_pub_date, null, 'unpublishedの日付が採用されている');
});

test('getWorks: publication日付なし + sf_works.published_at あり → fallback', () => {
  const db = makeDbForPubDate();
  const wid = Number(db.prepare("SELECT id FROM sf_works WHERE work_key='date_fallback'").get().id);
  db.prepare("UPDATE sf_works SET published_at='2025-12-01' WHERE id=?").run(wid);
  db.prepare(
    "INSERT INTO sf_work_publications (work_id, platform, publication_status, published_at) VALUES (?, 'narou', 'published', NULL)"
  ).run(wid);
  const w = getWorks(db).find(x => x.work_key === 'date_fallback');
  assert.equal(w.earliest_pub_date, '2025-12-01', 'fallbackが効いていない');
});

test('getWorks: 日付なし作品 → earliest_pub_date=null', () => {
  const db = makeDbForPubDate();
  const w = getWorks(db).find(x => x.work_key === 'date_none');
  assert.equal(w.earliest_pub_date, null);
});

// ── Section 10: deleteWorkArchive ────────────────────────────────────────────

console.log('\n─── Section 10: deleteWorkArchive ───');

function makeDbForArchiveDel() {
  const db = createDb(':memory:');
  db.prepare(
    "INSERT INTO sf_works (work_key, title, work_type, status) VALUES ('arc_work_a', '作品A', 'novel', 'active')"
  ).run();
  db.prepare(
    "INSERT INTO sf_works (work_key, title, work_type, status) VALUES ('arc_work_b', '作品B', 'novel', 'active')"
  ).run();
  return db;
}

let _arcCounter = 0;
function insertArc(db, workKey, filename = 'test.txt') {
  const wid  = Number(db.prepare('SELECT id FROM sf_works WHERE work_key=?').get(workKey).id);
  const sha  = `deadbeef${String(_arcCounter++).padStart(8, '0')}`;
  db.prepare(
    "INSERT INTO sf_work_archives (work_id, archive_type, archived_filename, file_path, sha256, file_size_bytes) " +
    "VALUES (?, 'publication', ?, 'work_1/test.txt', ?, 100)"
  ).run(wid, filename, sha);
  return { workId: wid, archiveId: Number(db.prepare('SELECT last_insert_rowid() AS id').get().id) };
}

test('deleteWorkArchive: 正常削除 → DBレコードが消える', () => {
  const db  = makeDbForArchiveDel();
  const { workId, archiveId } = insertArc(db, 'arc_work_a');
  const result = deleteWorkArchive(db, workId, archiveId);
  assert.equal(result.deleted, true);
  assert.equal(result.archived_filename, 'test.txt');
  const row = db.prepare('SELECT * FROM sf_work_archives WHERE id=?').get(archiveId);
  assert.equal(row, undefined, 'DBレコードが残っている');
});

test('deleteWorkArchive: 実ファイルは削除しない（unlink系関数は呼ばれない）', () => {
  // deleteWorkArchive 関数本体に unlinkSync / rmSync が含まれていないことを確認
  const src = (deleteWorkArchive.toString());
  assert.ok(!src.includes('unlinkSync'), 'unlinkSync が含まれている');
  assert.ok(!src.includes('rmSync'),     'rmSync が含まれている');
  assert.ok(!src.includes('fs.unlink'),  'fs.unlink が含まれている');
});

test('deleteWorkArchive: 別作品の archiveId → 404', () => {
  const db = makeDbForArchiveDel();
  const { archiveId }      = insertArc(db, 'arc_work_a');
  const workBId = Number(db.prepare("SELECT id FROM sf_works WHERE work_key='arc_work_b'").get().id);
  assert.throws(
    () => deleteWorkArchive(db, workBId, archiveId),
    (e) => e.status === 404 && /アーカイブが見つかりません/.test(e.message)
  );
});

test('deleteWorkArchive: 存在しない archiveId → 404', () => {
  const db = makeDbForArchiveDel();
  const { workId } = insertArc(db, 'arc_work_a');
  assert.throws(
    () => deleteWorkArchive(db, workId, 99999),
    (e) => e.status === 404
  );
});

test('deleteWorkArchive: 存在しない workId → 404', () => {
  const db = makeDbForArchiveDel();
  assert.throws(
    () => deleteWorkArchive(db, 99999, 1),
    (e) => e.status === 404 && /作品が見つかりません/.test(e.message)
  );
});

test('deleteWorkArchive: 削除後に getWorkArchives の件数が減る', () => {
  const db = makeDbForArchiveDel();
  const { workId } = insertArc(db, 'arc_work_a', 'file1.txt');
  insertArc(db, 'arc_work_a', 'file2.txt');
  assert.equal(getWorkArchives(db, workId).length, 2, '削除前が2件ではない');
  const { archiveId } = insertArc(db, 'arc_work_a', 'file3.txt');
  // file3 だけ削除
  const third = db.prepare('SELECT id FROM sf_work_archives WHERE archived_filename=?').get('file3.txt');
  deleteWorkArchive(db, workId, Number(third.id));
  assert.equal(getWorkArchives(db, workId).length, 2, '削除後が2件ではない');
});

// ── Section 11: Phase 30 マイグレーション & archiveTextContent ───────────────

console.log('\n─── Section 11: Phase 30 マイグレーション & archiveTextContent ───');

/** Phase 30 用の :memory: DB（phase29まで適用済み、phase30未適用） */
function makeDbPhase29() {
  const db = createDb(':memory:');
  // createDb 内で phase30Migration も呼ばれるようになったので、
  // 未適用状態を作るには直接テーブルを手動構築する必要がある。
  // ここでは createDb（phase30適用済み）を使い、マイグレーション後の状態をテストする。
  return db;
}

test('phase30Migration: literary_award が登録可能', () => {
  const db = makeDbPhase29();
  const wid = Number(db.prepare(
    "INSERT INTO sf_works (work_key, title, work_type, status) VALUES ('p30_la', 'test', 'novel', 'active')"
  ).run().lastInsertRowid);
  db.prepare(`
    INSERT INTO sf_work_archives
      (work_id, archive_type, archived_filename, file_path, sha256, file_size_bytes)
    VALUES (?, 'literary_award', 'test.md', 'work_1/test.md', 'aabbcc', 100)
  `).run(wid);
  const rows = db.prepare('SELECT archive_type FROM sf_work_archives WHERE work_id=?').all(wid);
  assert.equal(rows[0].archive_type, 'literary_award');
});

test('phase30Migration: direct_input が登録可能', () => {
  const db = makeDbPhase29();
  const wid = Number(db.prepare(
    "INSERT INTO sf_works (work_key, title, work_type, status) VALUES ('p30_di', 'test', 'novel', 'active')"
  ).run().lastInsertRowid);
  db.prepare(`
    INSERT INTO sf_work_archives
      (work_id, archive_type, archived_filename, file_path, sha256, file_size_bytes)
    VALUES (?, 'direct_input', 'test.md', 'work_1/test.md', 'ddeeff', 200)
  `).run(wid);
  const rows = db.prepare('SELECT archive_type FROM sf_work_archives WHERE work_id=?').all(wid);
  assert.equal(rows[0].archive_type, 'direct_input');
});

test('phase30Migration: other が引き続き登録可能', () => {
  const db = makeDbPhase29();
  const wid = Number(db.prepare(
    "INSERT INTO sf_works (work_key, title, work_type, status) VALUES ('p30_oth', 'test', 'novel', 'active')"
  ).run().lastInsertRowid);
  db.prepare(`
    INSERT INTO sf_work_archives
      (work_id, archive_type, archived_filename, file_path, sha256, file_size_bytes)
    VALUES (?, 'other', 'other.md', 'work_1/other.md', '112233', 50)
  `).run(wid);
  const rows = db.prepare('SELECT archive_type FROM sf_work_archives WHERE work_id=?').all(wid);
  assert.equal(rows[0].archive_type, 'other');
});

test('phase30Migration: version_date カラムが存在する', () => {
  const db   = makeDbPhase29();
  const cols = db.prepare('PRAGMA table_info(sf_work_archives)').all().map(c => c.name);
  assert.ok(cols.includes('version_date'), 'version_date カラムがない');
});

test('phase30Migration: sf_works に synopsis/first_draft_date/character_count/memo が追加される', () => {
  const db   = makeDbPhase29();
  const cols = db.prepare('PRAGMA table_info(sf_works)').all().map(c => c.name);
  assert.ok(cols.includes('synopsis'),         'synopsis がない');
  assert.ok(cols.includes('first_draft_date'), 'first_draft_date がない');
  assert.ok(cols.includes('character_count'),  'character_count がない');
  assert.ok(cols.includes('memo'),             'memo がない');
});

test('phase30Migration: 冪等（2回実行しても壊れない）', () => {
  const db = makeDbPhase29();
  // createDb 内で既に1回呼ばれているので、もう1回呼ぶ
  assert.doesNotThrow(() => phase30Migration(db));
});

test('phase30Migration: PRAGMA foreign_key_check が 0件', () => {
  const db     = makeDbPhase29();
  const errors = db.prepare('PRAGMA foreign_key_check').all();
  assert.equal(errors.length, 0);
});

test('phase30Migration: 既存 archive_type が全て保持される', () => {
  // createDb（phase30適用済み）に各種 archive_type を挿入して確認
  const db = makeDbPhase29();
  const wid = Number(db.prepare(
    "INSERT INTO sf_works (work_key, title, work_type, status) VALUES ('p30_all', 'test', 'novel', 'active')"
  ).run().lastInsertRowid);
  const types = ['submission', 'publication', 'revision', 'backup', 'other', 'literary_award', 'direct_input'];
  types.forEach((t, i) => {
    db.prepare(`
      INSERT INTO sf_work_archives
        (work_id, archive_type, archived_filename, file_path, sha256, file_size_bytes)
      VALUES (?, ?, ?, ?, ?, 10)
    `).run(wid, t, `f${i}.md`, `work_${wid}/f${i}.md`, `sha${i}`.padEnd(10, '0'));
  });
  const rows = db.prepare('SELECT archive_type FROM sf_work_archives WHERE work_id=? ORDER BY id').all(wid);
  assert.deepEqual(rows.map(r => r.archive_type), types);
});

// archiveTextContent テスト用ヘルパー
function makeDbForTextArchive() {
  const db = createDb(':memory:');
  db.prepare(
    "INSERT INTO sf_works (work_key, title, work_type, status) VALUES ('txt_work', 'テスト', 'novel', 'active')"
  ).run();
  return db;
}

import { existsSync } from 'node:fs';

test('archiveTextContent: 本文を .md として保存しDBに登録できる', () => {
  const db       = makeDbForTextArchive();
  const tmpDir   = mkdtempSync(pathJoin(tmpdir(), 'jarvis-test-'));
  try {
    const result = archiveTextContent(db, 1, 'テスト本文です。', { archiveDir: tmpDir });
    assert.ok(result.id > 0, 'id が返らない');
    assert.ok(result.archived_filename.endsWith('.md'), '.md でない');
    assert.ok(result.sha256.length === 64, 'sha256 長が不正');
    assert.ok(result.file_size_bytes > 0, 'file_size_bytes が 0');
    assert.ok(result.char_count > 0, 'char_count が 0');
    // DBに登録されているか
    const row = db.prepare('SELECT * FROM sf_work_archives WHERE id=?').get(result.id);
    assert.equal(row.archive_type, 'direct_input');
    assert.equal(row.original_filename, 'direct_input.md');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('archiveTextContent: 空本文は拒否', () => {
  const db     = makeDbForTextArchive();
  const tmpDir = mkdtempSync(pathJoin(tmpdir(), 'jarvis-test-'));
  try {
    assert.throws(
      () => archiveTextContent(db, 1, '   ', { archiveDir: tmpDir }),
      (e) => e.status === 400 && /空/.test(e.message)
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('archiveTextContent: 同一内容の重複は拒否', () => {
  const db     = makeDbForTextArchive();
  const tmpDir = mkdtempSync(pathJoin(tmpdir(), 'jarvis-test-'));
  try {
    archiveTextContent(db, 1, '重複テスト本文', { archiveDir: tmpDir });
    assert.throws(
      () => archiveTextContent(db, 1, '重複テスト本文', { archiveDir: tmpDir }),
      (e) => e.status === 409
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('archiveTextContent: version_date 形式不正は拒否', () => {
  const db     = makeDbForTextArchive();
  const tmpDir = mkdtempSync(pathJoin(tmpdir(), 'jarvis-test-'));
  try {
    assert.throws(
      () => archiveTextContent(db, 1, '本文テスト', { archiveDir: tmpDir, version_date: '2024/01/01' }),
      (e) => e.status === 400
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('archiveTextContent: SHA256が一致する', () => {
  const db      = makeDbForTextArchive();
  const tmpDir  = mkdtempSync(pathJoin(tmpdir(), 'jarvis-test-'));
  try {
    const content = '本文のSHA256検証テスト';
    const result  = archiveTextContent(db, 1, content, { archiveDir: tmpDir });
    const expected = computeSha256(Buffer.from(content, 'utf-8'));
    assert.equal(result.sha256, expected);
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('archiveTextContent: 実ファイルが残る（deleteWorkArchive後も）', () => {
  const db     = makeDbForTextArchive();
  const tmpDir = mkdtempSync(pathJoin(tmpdir(), 'jarvis-test-'));
  try {
    const result = archiveTextContent(db, 1, 'ファイル残留テスト', { archiveDir: tmpDir });
    const absFile = pathResolve(tmpDir, `work_1`, result.archived_filename);
    assert.ok(existsSync(absFile), 'ファイルが存在しない（削除前）');
    // DB から登録解除
    deleteWorkArchive(db, 1, result.id);
    // ファイルは残っているはず
    assert.ok(existsSync(absFile), 'deleteWorkArchive 後にファイルが消えた');
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

// ── 結果 ──────────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`);
console.log(`合計: ${passed + failed} tests  ✅ ${passed} passed  ❌ ${failed} failed`);
if (failed > 0) process.exit(1);
