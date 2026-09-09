/**
 * jarvis/tests/test_works_sort.js
 * 作品一覧 ヘッダーソート ロジック テスト
 *
 * 実行: node tests/test_works_sort.js
 *
 * テスト対象: sf.js の _sortedWorks / _worksStatusRank / ヘッダーソート仕様
 * ※ ブラウザUIのため純粋ロジック部分のみ Node.js で検証する
 */

import assert from 'node:assert/strict';

// ─── ソートロジックをここでも同等に再現（sf.js と一致させること） ──────────

const _WORKS_TYPE_ORDER = { novel: 0, short_series: 1, short_story: 2, game: 3, other: 4 };

function _worksStatusRank(w) {
  if (Number(w.pub_count) === 0) return 2; // 公開先未登録
  if (w.published_platforms)    return 0; // 公開中
  return 1;                                // 未公開
}

function _sortedWorks(works, worksSort) {
  if (!worksSort) return works;
  const { col, dir } = worksSort;
  const sign = dir === 'asc' ? 1 : -1;

  return [...works].sort((a, b) => {
    switch (col) {
      case 'title':
        return sign * a.title.localeCompare(b.title, 'ja');
      case 'type': {
        const oa = _WORKS_TYPE_ORDER[a.work_type] ?? 99;
        const ob = _WORKS_TYPE_ORDER[b.work_type] ?? 99;
        return sign * (oa - ob);
      }
      case 'pubdate': {
        const da = a.earliest_pub_date || null;
        const db = b.earliest_pub_date || null;
        if (da === null && db === null) return 0;
        if (da === null) return 1;   // NULL は昇順・降順どちらでも末尾
        if (db === null) return -1;
        return sign * da.localeCompare(db);
      }
      case 'status':
        return sign * (_worksStatusRank(a) - _worksStatusRank(b));
      case 'archive': {
        const ca = Number(a.archive_count) || 0;
        const cb = Number(b.archive_count) || 0;
        return sign * (ca - cb);
      }
      default:
        return 0;
    }
  });
}

// ─── テストユーティリティ ──────────────────────────────────────────────────

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

// ─── テストデータ ──────────────────────────────────────────────────────────

const WORKS = [
  { id: 1,  title: 'Snow flakes',     work_type: 'novel',        earliest_pub_date: '2026-01-08', pub_count: 1, published_platforms: 'narou', archive_count: 1, display_order: 1 },
  { id: 2,  title: 'Under tone',      work_type: 'game',         earliest_pub_date: null,         pub_count: 1, published_platforms: 'narou', archive_count: 0, display_order: 2 },
  { id: 8,  title: 'Moon Veil',       work_type: 'short_story',  earliest_pub_date: '2026-06-18', pub_count: 1, published_platforms: 'narou', archive_count: 0, display_order: 3 },
  { id: 7,  title: 'ICE BREAKER',     work_type: 'short_series', earliest_pub_date: '2026-04-01', pub_count: 1, published_platforms: 'narou', archive_count: 0, display_order: 4 },
  { id: 9,  title: '始まりのベース', work_type: 'short_story',  earliest_pub_date: '2026-06-13', pub_count: 1, published_platforms: 'narou', archive_count: 0, display_order: 5 },
  { id: 20, title: '月が満ちるまで', work_type: 'short_series', earliest_pub_date: null,         pub_count: 1, published_platforms: null,    archive_count: 0, display_order: 6 },
  { id: 24, title: '瞬間に残る',     work_type: 'novel',        earliest_pub_date: null,         pub_count: 1, published_platforms: null,    archive_count: 0, display_order: 7 },
  { id: 44, title: '名前、まだ慣れない', work_type: 'other',    earliest_pub_date: null,         pub_count: 1, published_platforms: 'hp',    archive_count: 0, display_order: 8 },
  { id: 30, title: '白い花',         work_type: 'short_story',  earliest_pub_date: null,         pub_count: 0, published_platforms: null,    archive_count: 0, display_order: 9 },
];

// ─── Section 1: タイトルソート ────────────────────────────────────────────

console.log('\n── Section 1: タイトルソート ────────────────────────────────');

test('タイトル昇順（ja locale）', () => {
  const sorted = _sortedWorks(WORKS, { col: 'title', dir: 'asc' });
  // 先頭は ASCII が先（"ICE BREAKER" < "Moon Veil" < "Snow flakes" < "Under tone" < 日本語）
  assert.equal(sorted[0].title, 'ICE BREAKER');
  assert.equal(sorted[1].title, 'Moon Veil');
  assert.equal(sorted[2].title, 'Snow flakes');
  assert.equal(sorted[3].title, 'Under tone');
  // 日本語タイトルが後続
  const titles = sorted.map(w => w.title);
  const jpIdx  = titles.findIndex(t => /^[\u3000-\u9fff]/.test(t));
  assert.ok(jpIdx > 3, `日本語が英字より後に来ていない: jpIdx=${jpIdx}`);
});

test('タイトル降順は昇順の逆順', () => {
  const asc  = _sortedWorks(WORKS, { col: 'title', dir: 'asc' });
  const desc = _sortedWorks(WORKS, { col: 'title', dir: 'desc' });
  assert.deepEqual(
    asc.map(w => w.id),
    [...desc.map(w => w.id)].reverse()
  );
});

// ─── Section 2: 種別ソート ────────────────────────────────────────────────

console.log('\n── Section 2: 種別ソート ────────────────────────────────────');

test('種別昇順: 長編小説→短編連作→短編小説→ゲーム→その他', () => {
  const sorted = _sortedWorks(WORKS, { col: 'type', dir: 'asc' });
  const types  = sorted.map(w => w.work_type);

  // 長編小説 (novel) が最初に来る
  const firstNovel = types.indexOf('novel');
  const firstSeries = types.indexOf('short_series');
  const firstStory  = types.indexOf('short_story');
  const firstGame   = types.indexOf('game');
  const firstOther  = types.indexOf('other');

  assert.ok(firstNovel < firstSeries,  `novel(${firstNovel}) は short_series(${firstSeries}) より前`);
  assert.ok(firstSeries < firstStory,  `short_series(${firstSeries}) は short_story(${firstStory}) より前`);
  assert.ok(firstStory < firstGame,    `short_story(${firstStory}) は game(${firstGame}) より前`);
  assert.ok(firstGame < firstOther,    `game(${firstGame}) は other(${firstOther}) より前`);
});

test('種別降順は昇順の逆', () => {
  const asc  = _sortedWorks(WORKS, { col: 'type', dir: 'asc' });
  const desc = _sortedWorks(WORKS, { col: 'type', dir: 'desc' });
  // 各 work_type の最初の出現順が逆転している
  const types = (arr) => [...new Set(arr.map(w => w.work_type))];
  assert.deepEqual(types(desc), types(asc).reverse());
});

// ─── Section 3: 公開日ソート ──────────────────────────────────────────────

console.log('\n── Section 3: 公開日ソート ──────────────────────────────────');

test('公開日昇順: 日付ありが先、NULLは末尾', () => {
  const sorted = _sortedWorks(WORKS, { col: 'pubdate', dir: 'asc' });
  // 最初3件は日付あり（2026-01-08, 2026-04-01, 2026-06-13）
  assert.equal(sorted[0].earliest_pub_date, '2026-01-08');
  assert.equal(sorted[1].earliest_pub_date, '2026-04-01');
  assert.equal(sorted[2].earliest_pub_date, '2026-06-13');
  // 末尾はすべて null
  const nullWorks = sorted.filter(w => !w.earliest_pub_date);
  const nonNull   = sorted.filter(w =>  w.earliest_pub_date);
  assert.ok(nonNull.length > 0, '日付ありが存在しない');
  assert.ok(nullWorks.length > 0, 'NULL日付が存在しない');
  // nullは末尾にまとまっている
  const firstNull = sorted.findIndex(w => !w.earliest_pub_date);
  for (let i = firstNull; i < sorted.length; i++) {
    assert.equal(sorted[i].earliest_pub_date, null, `インデックス${i}がNULLでない`);
  }
});

test('公開日降順: 日付ありが先（新しい順）、NULLは末尾', () => {
  const sorted = _sortedWorks(WORKS, { col: 'pubdate', dir: 'desc' });
  // 最初は最新日付
  assert.equal(sorted[0].earliest_pub_date, '2026-06-18');
  // 末尾は NULL
  assert.equal(sorted[sorted.length - 1].earliest_pub_date, null);
  // NULL が末尾に集まっている
  const firstNull = sorted.findIndex(w => !w.earliest_pub_date);
  for (let i = firstNull; i < sorted.length; i++) {
    assert.equal(sorted[i].earliest_pub_date, null, `descソート: インデックス${i}がNULLでない`);
  }
});

test('NULL公開日は昇順・降順どちらでも末尾', () => {
  const asc  = _sortedWorks(WORKS, { col: 'pubdate', dir: 'asc' });
  const desc = _sortedWorks(WORKS, { col: 'pubdate', dir: 'desc' });
  const lastAsc  = asc [asc.length - 1];
  const lastDesc = desc[desc.length - 1];
  assert.equal(lastAsc.earliest_pub_date,  null, '昇順末尾がNULLでない');
  assert.equal(lastDesc.earliest_pub_date, null, '降順末尾がNULLでない');
});

// ─── Section 4: 公開状態ソート ────────────────────────────────────────────

console.log('\n── Section 4: 公開状態ソート ────────────────────────────────');

test('_worksStatusRank: 公開中=0, 未公開=1, 公開先未登録=2', () => {
  const published   = { pub_count: 1, published_platforms: 'narou' };
  const unpublished = { pub_count: 1, published_platforms: null };
  const unregistered = { pub_count: 0, published_platforms: null };
  assert.equal(_worksStatusRank(published),    0);
  assert.equal(_worksStatusRank(unpublished),  1);
  assert.equal(_worksStatusRank(unregistered), 2);
});

test('公開状態昇順: 公開中→未公開→公開先未登録', () => {
  const sorted = _sortedWorks(WORKS, { col: 'status', dir: 'asc' });
  const ranks  = sorted.map(w => _worksStatusRank(w));
  // 降順ではない（rank が増加方向）
  for (let i = 1; i < ranks.length; i++) {
    assert.ok(ranks[i] >= ranks[i - 1], `公開状態昇順が崩れている: index=${i} (${ranks[i - 1]} → ${ranks[i]})`);
  }
  // 公開中が先頭に来ている
  assert.equal(ranks[0], 0, '先頭が公開中(0)でない');
});

test('公開状態降順: 公開先未登録→未公開→公開中', () => {
  const sorted = _sortedWorks(WORKS, { col: 'status', dir: 'desc' });
  const ranks  = sorted.map(w => _worksStatusRank(w));
  for (let i = 1; i < ranks.length; i++) {
    assert.ok(ranks[i] <= ranks[i - 1], `公開状態降順が崩れている: index=${i} (${ranks[i - 1]} → ${ranks[i]})`);
  }
  assert.equal(ranks[0], 2, '先頭が公開先未登録(2)でない');
});

// ─── Section 5: アーカイブ件数ソート ─────────────────────────────────────

console.log('\n── Section 5: アーカイブ件数ソート ─────────────────────────');

test('アーカイブ昇順: 件数が小さい順', () => {
  const sorted = _sortedWorks(WORKS, { col: 'archive', dir: 'asc' });
  const counts = sorted.map(w => Number(w.archive_count));
  for (let i = 1; i < counts.length; i++) {
    assert.ok(counts[i] >= counts[i - 1], `アーカイブ昇順が崩れている: index=${i} (${counts[i - 1]} → ${counts[i]})`);
  }
});

test('アーカイブ降順: 件数が大きい順（1件あり作品が先頭）', () => {
  const sorted = _sortedWorks(WORKS, { col: 'archive', dir: 'desc' });
  assert.equal(sorted[0].archive_count, 1, '先頭の archive_count が1でない（Snow flakesが先頭のはず）');
});

// ─── Section 6: ソート解除で元の順番に戻る ───────────────────────────────

console.log('\n── Section 6: ソート解除（worksSort=null）────────────────────');

test('worksSort=null で渡された配列の参照がそのまま返る', () => {
  const result = _sortedWorks(WORKS, null);
  // 同じ参照
  assert.strictEqual(result, WORKS, 'worksSort=null のとき元配列の参照が返っていない');
});

test('ソート後に null を渡すと display_order 順（元の配列順）に戻る', () => {
  const sorted = _sortedWorks(WORKS, { col: 'title', dir: 'asc' });
  const restored = _sortedWorks(WORKS, null);
  assert.deepEqual(
    restored.map(w => w.id),
    WORKS.map(w => w.id),
    '元の配列順に戻っていない'
  );
});

// ─── Section 7: display_order への影響なし ────────────────────────────────

console.log('\n── Section 7: display_order 不変 ────────────────────────────');

test('ソートしても元配列の display_order は変化しない', () => {
  const originalOrders = WORKS.map(w => ({ id: w.id, display_order: w.display_order }));
  _sortedWorks(WORKS, { col: 'title', dir: 'asc' });
  _sortedWorks(WORKS, { col: 'type',  dir: 'desc' });
  _sortedWorks(WORKS, { col: 'pubdate', dir: 'asc' });
  const afterOrders = WORKS.map(w => ({ id: w.id, display_order: w.display_order }));
  assert.deepEqual(afterOrders, originalOrders, 'ソートが元配列の display_order を変更した');
});

test('_sortedWorks は元配列を破壊しない（新しい配列を返す）', () => {
  const original = [...WORKS];
  const sorted   = _sortedWorks(WORKS, { col: 'pubdate', dir: 'asc' });
  assert.deepEqual(WORKS.map(w => w.id), original.map(w => w.id), '元配列が変更された');
  assert.notStrictEqual(sorted, WORKS, '同じ参照が返っている（コピーが作られていない）');
});

// ─── 結果 ──────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`);
console.log(`合計: ${passed + failed} tests  ✅ ${passed} passed  ❌ ${failed} failed`);
if (failed > 0) process.exit(1);
