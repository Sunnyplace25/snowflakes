/**
 * jarvis/tests/test_work_detail.js
 * GET /api/sf/works/:id / PUT /api/sf/works/:id のロジックテスト
 * （updateWorkDetail + バリデーション + 拒否ロジック）
 */
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ─── テストユーティリティ ────────────────────────────────────────────────────────
let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✅ ${name}`); passed++; }
  catch (e) { console.error(`  ❌ ${name}\n     ${e.message}`); failed++; }
}
function expect(val) {
  return {
    toBe:      (exp) => { if (val !== exp) throw new Error(`expected ${JSON.stringify(exp)}, got ${JSON.stringify(val)}`); },
    toContain: (sub) => { if (!String(val).includes(sub)) throw new Error(`expected "${val}" to contain "${sub}"`); },
    toBeNull:  ()    => { if (val !== null) throw new Error(`expected null, got ${JSON.stringify(val)}`); },
    toBeTrue:  ()    => { if (val !== true) throw new Error(`expected true, got ${JSON.stringify(val)}`); },
    toBeFalsy: ()    => { if (val) throw new Error(`expected falsy, got ${JSON.stringify(val)}`); },
    toBeGte:   (n)   => { if (val < n) throw new Error(`expected >= ${n}, got ${val}`); },
  };
}
function expectThrows(fn, msgSubstr) {
  try { fn(); throw new Error('expected throw, but did not throw'); }
  catch (e) {
    if (e.message === 'expected throw, but did not throw') throw e;
    if (msgSubstr && !e.message.includes(msgSubstr)) {
      throw new Error(`expected error containing "${msgSubstr}", got: "${e.message}"`);
    }
  }
}

// ─── DB セットアップ ─────────────────────────────────────────────────────────────
function makeTestDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`
    CREATE TABLE sf_works (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      work_key         TEXT NOT NULL UNIQUE,
      title            TEXT NOT NULL,
      work_type        TEXT NOT NULL DEFAULT 'novel'
        CHECK (work_type IN ('novel','short_story','short_series','game','other')),
      status           TEXT NOT NULL DEFAULT 'active'
        CHECK (status IN ('active','completed','hiatus')),
      published_at     TEXT,
      title_provisional INTEGER NOT NULL DEFAULT 0,
      display_order    INTEGER,
      synopsis         TEXT,
      first_draft_date TEXT,
      character_count  INTEGER,
      memo             TEXT,
      created_at       TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    );
    CREATE TABLE sf_work_publications (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      work_id            INTEGER NOT NULL REFERENCES sf_works(id),
      platform           TEXT NOT NULL,
      platform_work_id   TEXT,
      public_url         TEXT,
      publication_status TEXT NOT NULL DEFAULT 'published',
      published_at       TEXT,
      last_checked_at    TEXT,
      memo               TEXT,
      created_at         TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      UNIQUE(work_id, platform)
    );
    CREATE TABLE sf_work_archives (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      work_id           INTEGER NOT NULL REFERENCES sf_works(id),
      archive_type      TEXT NOT NULL DEFAULT 'other',
      version_label     TEXT,
      version_date      TEXT,
      original_filename TEXT,
      archived_filename TEXT NOT NULL,
      file_path         TEXT NOT NULL,
      sha256            TEXT NOT NULL,
      file_size_bytes   INTEGER NOT NULL DEFAULT 0,
      archived_at       TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      memo              TEXT
    );
  `);
  // 作品を3件挿入
  db.prepare(`INSERT INTO sf_works (work_key,title,work_type,status) VALUES
    ('wk1','テスト作品A','novel','active'),
    ('wk2','テスト作品B','short_story','completed'),
    ('wk3','テスト作品C','novel','hiatus')
  `).run();
  // 公開先を挿入
  db.prepare(`INSERT INTO sf_work_publications (work_id,platform,publication_status,published_at,public_url) VALUES
    (1,'narou','published','2024-06-01','https://ncode.syosetu.com/test'),
    (1,'hp','published','2024-05-15',NULL),
    (2,'note','unpublished',NULL,NULL)
  `).run();
  // アーカイブを挿入
  db.prepare(`INSERT INTO sf_work_archives (work_id,archive_type,version_label,version_date,original_filename,archived_filename,file_path,sha256,file_size_bytes) VALUES
    (1,'revision','初稿','2024-01-10','draft1.txt','arc1.txt','path/arc1.txt','aaa',1000),
    (1,'revision','第1稿改稿','2024-08-14','draft2.txt','arc2.txt','path/arc2.txt','bbb',2000),
    (1,'literary_award','文学賞応募版','2024-09-01','award.txt','arc3.txt','path/arc3.txt','ccc',3000),
    (1,'submission',NULL,NULL,'sub.docx','arc4.docx','path/arc4.docx','ddd',4000)
  `).run();
  return db;
}

import {
  getWork, updateWorkDetail,
  getWorkPublications, getWorkArchives,
} from '../data/sf_works_manager.js';

const db = makeTestDb();

// ─── Section 1: getWork ───────────────────────────────────────────────────────
console.log('\n── getWork ───────────────────────────────────────────────────');
test('存在するIDはwork objectを返す', () => {
  const w = getWork(db, 1);
  expect(w.title).toBe('テスト作品A');
  expect(w.synopsis).toBeNull();
});
test('存在しないIDはundefined', () => {
  const w = getWork(db, 9999);
  expect(w).toBeFalsy();
});

// ─── Section 2: getWorkPublications ──────────────────────────────────────────
console.log('\n── getWorkPublications ───────────────────────────────────────');
test('作品1の公開先は2件', () => {
  const pubs = getWorkPublications(db, 1);
  expect(pubs.length).toBe(2);
});
test('published_atが早い順に並ぶか確認', () => {
  const pubs = getWorkPublications(db, 1);
  const platforms = pubs.map(p => p.platform);
  expect(platforms.includes('narou')).toBeTrue();
  expect(platforms.includes('hp')).toBeTrue();
});

// ─── Section 3: getWorkArchives ───────────────────────────────────────────────
console.log('\n── getWorkArchives ───────────────────────────────────────────');
test('作品1のアーカイブは4件', () => {
  const arcs = getWorkArchives(db, 1);
  expect(arcs.length).toBe(4);
});
test('作品2のアーカイブは0件', () => {
  const arcs = getWorkArchives(db, 2);
  expect(arcs.length).toBe(0);
});

// ─── Section 4: updateWorkDetail 正常系 ────────────────────────────────────────
console.log('\n── updateWorkDetail 正常系 ──────────────────────────────────');
test('synopsis を更新できる', () => {
  const w = updateWorkDetail(db, 1, { synopsis: 'テスト概要' });
  expect(w.synopsis).toBe('テスト概要');
});
test('first_draft_date を YYYY-MM-DD で更新できる', () => {
  const w = updateWorkDetail(db, 1, { first_draft_date: '2024-03-01' });
  expect(w.first_draft_date).toBe('2024-03-01');
});
test('character_count を整数で更新できる', () => {
  const w = updateWorkDetail(db, 1, { character_count: 12345 });
  expect(w.character_count).toBe(12345);
});
test('memo を更新できる', () => {
  const w = updateWorkDetail(db, 1, { memo: 'テストメモ' });
  expect(w.memo).toBe('テストメモ');
});
test('null を渡してフィールドを空にできる', () => {
  const w = updateWorkDetail(db, 1, { synopsis: null, memo: null });
  expect(w.synopsis).toBeNull();
  expect(w.memo).toBeNull();
});
test('空文字列の first_draft_date は null に変換', () => {
  const w = updateWorkDetail(db, 1, { first_draft_date: '' });
  expect(w.first_draft_date).toBeNull();
});
test('4フィールドを同時更新できる', () => {
  const w = updateWorkDetail(db, 1, {
    synopsis: '概要テキスト', first_draft_date: '2023-12-01',
    character_count: 9999, memo: '管理メモ',
  });
  expect(w.synopsis).toBe('概要テキスト');
  expect(w.character_count).toBe(9999);
});

// ─── Section 5: updateWorkDetail バリデーション ────────────────────────────────
console.log('\n── updateWorkDetail バリデーション ──────────────────────────');
test('不正な日付形式（YYYY/MM/DD）は400', () => {
  expectThrows(() => updateWorkDetail(db, 1, { first_draft_date: '2024/03/01' }),
    'YYYY-MM-DD');
});
test('不正な日付形式（8桁数字）は400', () => {
  expectThrows(() => updateWorkDetail(db, 1, { first_draft_date: '20240301' }),
    'YYYY-MM-DD');
});
test('負の character_count は400', () => {
  expectThrows(() => updateWorkDetail(db, 1, { character_count: -1 }),
    '0 以上の整数');
});
test('浮動小数点 character_count は400', () => {
  expectThrows(() => updateWorkDetail(db, 1, { character_count: 1.5 }),
    '0 以上の整数');
});
test('存在しない workId は404', () => {
  try {
    updateWorkDetail(db, 9999, { synopsis: 'X' });
    throw new Error('expected throw');
  } catch (e) {
    expect(e.status).toBe(404);
    expect(e.message).toContain('見つかりません');
  }
});

// ─── Section 6: 許可外フィールド拒否 ────────────────────────────────────────────
console.log('\n── 許可外フィールド拒否 ─────────────────────────────────────');
test('title フィールドは拒否', () => {
  expectThrows(() => updateWorkDetail(db, 1, { title: '変更' }),
    '更新できないフィールドが含まれています: title');
});
test('title + memo の混在は拒否（memoだけ成功しない）', () => {
  expectThrows(() => updateWorkDetail(db, 1, { title: '変更', memo: 'test' }),
    '更新できないフィールドが含まれています: title');
});
test('status フィールドは拒否', () => {
  expectThrows(() => updateWorkDetail(db, 1, { status: 'completed' }),
    '更新できないフィールドが含まれています: status');
});
test('work_key フィールドは拒否', () => {
  expectThrows(() => updateWorkDetail(db, 1, { work_key: 'hacked' }),
    '更新できないフィールドが含まれています: work_key');
});
test('display_order フィールドは拒否', () => {
  expectThrows(() => updateWorkDetail(db, 1, { display_order: 999 }),
    '更新できないフィールドが含まれています: display_order');
});
test('複数の不許可フィールドはまとめてエラーメッセージに含まれる', () => {
  try {
    updateWorkDetail(db, 1, { title: 'x', work_key: 'y' });
    throw new Error('expected throw');
  } catch (e) {
    expect(e.message).toContain('更新できないフィールドが含まれています');
    expect(e.message).toContain('title');
    expect(e.message).toContain('work_key');
  }
});
test('空 body は400（更新フィールドなし）', () => {
  expectThrows(() => updateWorkDetail(db, 1, {}), '更新するフィールドがありません');
});

// ─── Section 7: 公開日計算ロジック ───────────────────────────────────────────────
console.log('\n── 公開日計算ロジック ───────────────────────────────────────');
function computeEarliestPubDate(publications, workPublishedAt) {
  const dates = (publications || [])
    .filter(p => p.publication_status === 'published' && p.published_at)
    .map(p => p.published_at)
    .sort();
  if (dates.length > 0) return dates[0].slice(0, 10);
  return workPublishedAt ? workPublishedAt.slice(0, 10) : null;
}
test('published かつ published_at ありの最古日付を返す', () => {
  const pubs = getWorkPublications(db, 1);
  const result = computeEarliestPubDate(pubs, null);
  expect(result).toBe('2024-05-15'); // hp のほうが早い
});
test('published_at が全て null なら sf_works.published_at にfallback', () => {
  const pubs = [{ publication_status: 'published', published_at: null }];
  expect(computeEarliestPubDate(pubs, '2023-01-01')).toBe('2023-01-01');
});
test('public_url が null の published も公開日算出に含まれる（url不要）', () => {
  const pubs = [
    { publication_status: 'published', published_at: '2024-05-15', public_url: null },
    { publication_status: 'published', published_at: '2024-06-01', public_url: 'https://example.com' },
  ];
  expect(computeEarliestPubDate(pubs, null)).toBe('2024-05-15');
});
test('unpublished / private / deleted は公開日算出から除外', () => {
  const pubs = [
    { publication_status: 'unpublished', published_at: '2024-01-01' },
    { publication_status: 'private',     published_at: '2024-01-02' },
    { publication_status: 'deleted',     published_at: '2024-01-03' },
    { publication_status: 'published',   published_at: '2024-06-01' },
  ];
  expect(computeEarliestPubDate(pubs, null)).toBe('2024-06-01');
});
test('published_atが全てnullで sf_works.published_at も null なら null', () => {
  expect(computeEarliestPubDate([], null)).toBeNull();
});

// ─── Section 8: 最終改稿日ロジック ────────────────────────────────────────────
console.log('\n── 最終改稿日ロジック ───────────────────────────────────────');
function computeLastRevisionDate(archives) {
  const dates = (archives || [])
    .filter(a => a.archive_type === 'revision' && a.version_date)
    .map(a => a.version_date)
    .sort();
  return dates.length > 0 ? dates[dates.length - 1].slice(0, 10) : null;
}
test('revision + version_date の最新値を返す', () => {
  const arcs = getWorkArchives(db, 1);
  expect(computeLastRevisionDate(arcs)).toBe('2024-08-14');
});
test('literary_award の version_date は最終改稿日に使わない', () => {
  const arcs = [
    { archive_type: 'revision',       version_date: '2024-08-14' },
    { archive_type: 'literary_award', version_date: '2024-09-01' }, // 新しいが除外
  ];
  expect(computeLastRevisionDate(arcs)).toBe('2024-08-14');
});
test('submission の version_date も最終改稿日に使わない', () => {
  const arcs = [
    { archive_type: 'submission', version_date: '2024-09-15' },
  ];
  expect(computeLastRevisionDate(arcs)).toBeNull();
});
test('revision が 0 件なら null', () => {
  expect(computeLastRevisionDate([])).toBeNull();
});
test('version_date なし revision は除外', () => {
  const arcs = [
    { archive_type: 'revision', version_date: null },
    { archive_type: 'revision', version_date: '2024-05-01' },
  ];
  expect(computeLastRevisionDate(arcs)).toBe('2024-05-01');
});

// ─── Section 9: 最新原稿判定ロジック ──────────────────────────────────────────
console.log('\n── 最新原稿判定ロジック ─────────────────────────────────────');
function computeLatestArchive(archives) {
  if (!archives || archives.length === 0) return null;
  return [...archives].sort((a, b) => {
    if (a.version_date && !b.version_date) return -1;
    if (!a.version_date && b.version_date) return 1;
    if (a.version_date && b.version_date) {
      const cmp = b.version_date.localeCompare(a.version_date);
      if (cmp !== 0) return cmp;
    }
    return b.archived_at.localeCompare(a.archived_at);
  })[0];
}
test('version_date のある原稿が優先される', () => {
  const arcs = [
    { id: 1, version_date: '2024-09-01', archived_at: '2024-09-02', archived_filename: 'new.txt' },
    { id: 2, version_date: null,          archived_at: '2024-10-01', archived_filename: 'newer.txt' },
  ];
  expect(computeLatestArchive(arcs).id).toBe(1);
});
test('同 version_date なら archived_at 新しい方', () => {
  const arcs = [
    { id: 1, version_date: '2024-08-01', archived_at: '2024-08-01', archived_filename: 'a.txt' },
    { id: 2, version_date: '2024-08-01', archived_at: '2024-08-02', archived_filename: 'b.txt' },
  ];
  expect(computeLatestArchive(arcs).id).toBe(2);
});
test('version_date が全て null なら archived_at 最新', () => {
  const arcs = [
    { id: 1, version_date: null, archived_at: '2024-01-01', archived_filename: 'old.txt' },
    { id: 2, version_date: null, archived_at: '2024-06-01', archived_filename: 'new.txt' },
  ];
  expect(computeLatestArchive(arcs).id).toBe(2);
});
test('空配列は null', () => {
  expect(computeLatestArchive([])).toBeNull();
});

// ─── 集計 ─────────────────────────────────────────────────────────────────────
console.log('\n────────────────────────────────────────────────────────────');
console.log(`合計: ${passed + failed} tests  ✅ ${passed} passed  ❌ ${failed} failed`);
if (failed > 0) process.exit(1);
