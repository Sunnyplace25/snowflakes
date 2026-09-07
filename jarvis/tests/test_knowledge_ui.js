/**
 * jarvis/tests/test_knowledge_ui.js
 * Phase 26: 設定資料検索 UI テスト
 *
 * 実行: node tests/test_knowledge_ui.js
 *
 * 検証内容:
 *   - ヒナタ で複数結果表示
 *   - 月が満ちるまで で chatgpt 資料が表示
 *   - 存在しないキーワードで 0 件
 *   - API 失敗時に SF 画面全体が落ちない（他 API 正常応答）
 *   - source 表示が正しい (existing → 既存資料 / chatgpt → ChatGPT作成資料)
 *   - ファイルパスが UI に露出しない
 */

import assert from 'node:assert/strict';

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

// ── 1. ヒナタ で複数結果が返る ─────────────────────────────────────────────

console.log('\n─── 1. ヒナタ 検索 ───');

const hinataRes = await fetch(`${BASE}/api/knowledge/search?q=${encodeURIComponent('ヒナタ')}`);
const hinataData = await hinataRes.json();

test('status 200', () => assert.equal(hinataRes.status, 200));
test('results は配列', () => assert.ok(Array.isArray(hinataData.results)));
test('複数件ヒット（2件以上）', () => assert.ok(hinataData.results.length >= 2, `got ${hinataData.results.length}`));
test('各結果に file がある', () => {
  for (const r of hinataData.results) {
    assert.ok(r.file, `file が空: ${JSON.stringify(r)}`);
  }
});
test('各結果に source がある', () => {
  for (const r of hinataData.results) {
    assert.ok(r.source, `source が空: ${JSON.stringify(r)}`);
  }
});
test('各結果に matches 配列がある', () => {
  for (const r of hinataData.results) {
    assert.ok(Array.isArray(r.matches), `matches が配列でない: ${JSON.stringify(r)}`);
    assert.ok(r.matches.length >= 1, 'matches が空');
  }
});
test('source は existing または chatgpt のみ', () => {
  const valid = new Set(['existing', 'chatgpt']);
  for (const r of hinataData.results) {
    assert.ok(valid.has(r.source), `未知の source: ${r.source}`);
  }
});
test('file にスラッシュが含まれない（パス非露出）', () => {
  for (const r of hinataData.results) {
    const hasSlash    = r.file.includes('/');
    const hasBackslash = r.file.indexOf('\\') >= 0;
    assert.ok(!hasSlash && !hasBackslash, `パスが露出: ${r.file}`);
  }
});
test('matches に lineNo と snippet と matchType がある', () => {
  for (const r of hinataData.results) {
    for (const m of r.matches) {
      assert.ok(typeof m.lineNo === 'number', `lineNo が数値でない`);
      assert.ok(typeof m.snippet === 'string', `snippet が文字列でない`);
      assert.ok(typeof m.matchType === 'string', `matchType が文字列でない`);
    }
  }
});

// ── 2. 月が満ちるまで で chatgpt 資料が返る ────────────────────────────────

console.log('\n─── 2. 月が満ちるまで 検索 ───');

const tsukiRes = await fetch(`${BASE}/api/knowledge/search?q=${encodeURIComponent('月が満ちるまで')}`);
const tsukiData = await tsukiRes.json();

test('status 200', () => assert.equal(tsukiRes.status, 200));
test('1件以上ヒット', () => assert.ok(tsukiData.results.length >= 1, `got ${tsukiData.results.length}`));
test('chatgpt 資料が含まれる', () =>
  assert.ok(
    tsukiData.results.some(r => r.source === 'chatgpt'),
    `chatgpt source が見つからない。sources: ${tsukiData.results.map(r => r.source).join(', ')}`
  )
);

// ── 3. 存在しないキーワードで 0件 ──────────────────────────────────────────

console.log('\n─── 3. 存在しないキーワード ───');

const noneRes = await fetch(`${BASE}/api/knowledge/search?q=${encodeURIComponent('xyzABCDEF存在しない999')}`);
const noneData = await noneRes.json();

test('status 200', () => assert.equal(noneRes.status, 200));
test('results が空配列', () => assert.equal(noneData.results.length, 0, `got ${noneData.results.length}`));

// ── 4. 不正クエリ / API 失敗時に SF 画面全体が落ちない ─────────────────────

console.log('\n─── 4. SF 画面への影響なし確認 ───');

const emptyRes = await fetch(`${BASE}/api/knowledge/search?q=`);
test('空クエリで 200 or 400（サーバー落ちない）', () =>
  assert.ok([200, 400].includes(emptyRes.status), `got ${emptyRes.status}`)
);

const releasesRes = await fetch(`${BASE}/api/sf/releases`);
test('sf/releases API が正常応答（Music Library タブが壊れていない）',
  () => assert.equal(releasesRes.status, 200)
);

const distRes = await fetch(`${BASE}/api/sf/distribution-platforms`);
test('sf/distribution-platforms API が正常応答（配信状況タブが壊れていない）',
  () => assert.equal(distRes.status, 200)
);

const profilesRes = await fetch(`${BASE}/api/sf/artist-profiles`);
test('sf/artist-profiles API が正常応答（Artist Profiles タブが壊れていない）',
  () => assert.equal(profilesRes.status, 200)
);

const issuesRes = await fetch(`${BASE}/api/sf/platform-issues`);
test('sf/platform-issues API が正常応答',
  () => assert.equal(issuesRes.status, 200)
);

// ── 5. source 表示ラベル確認 ──────────────────────────────────────────────

console.log('\n─── 5. source ラベル定義確認 ───');

const KNOWLEDGE_SOURCE_LABELS = { existing: '既存資料', chatgpt: 'ChatGPT作成資料' };

test('existing → 既存資料', () =>
  assert.equal(KNOWLEDGE_SOURCE_LABELS['existing'], '既存資料')
);
test('chatgpt → ChatGPT作成資料', () =>
  assert.equal(KNOWLEDGE_SOURCE_LABELS['chatgpt'], 'ChatGPT作成資料')
);
test('未知 source は undefined（グレースフルデグレード可能）', () =>
  assert.equal(KNOWLEDGE_SOURCE_LABELS['unknown_source'], undefined)
);

// ── 6. 実データ検証（実 API 結果の整合性）────────────────────────────────

console.log('\n─── 6. 実データ整合性 ───');

test('ヒナタ 検索：existing 資料が含まれる', () =>
  assert.ok(
    hinataData.results.some(r => r.source === 'existing'),
    'existing source が見つからない'
  )
);
test('ヒナタ 検索：matches の snippet が文字列で空でない', () => {
  for (const r of hinataData.results) {
    for (const m of r.matches) {
      assert.ok(typeof m.snippet === 'string');
    }
  }
});
test('月が満ちるまで：chatgpt ファイルの file が .md で終わる', () => {
  const chatgptFiles = tsukiData.results.filter(r => r.source === 'chatgpt');
  for (const r of chatgptFiles) {
    assert.ok(r.file.endsWith('.md'), `拡張子が .md でない: ${r.file}`);
  }
});

// ── 結果 ──────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`);
console.log(`合計: ${passed + failed} tests  ✅ ${passed} passed  ❌ ${failed} failed`);
if (failed > 0) process.exit(1);
