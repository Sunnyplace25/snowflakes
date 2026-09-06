/**
 * jarvis/tests/test_knowledge_search.js
 * Snow flakes 設定資料検索モジュール テスト
 *
 * 実行: node tests/test_knowledge_search.js
 *
 * テスト対象:
 *   searchKnowledge   - キーワード全文検索
 *   listKnowledgeFiles - ファイル一覧取得
 *
 * 注意:
 *   jarvis/knowledge/snowflakes/ 以下の実資料ファイルに依存する。
 *   外部API・DB・モックは不使用。
 */

import assert from 'node:assert/strict';
import { searchKnowledge, listKnowledgeFiles } from '../tools/knowledge_search.js';

// ── ユーティリティ ──────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function test(label, fn) {
  try {
    await fn();
    console.log(`  ✅ ${label}`);
    passed++;
  } catch (err) {
    console.error(`  ❌ ${label}`);
    console.error(`     ${err.message}`);
    failed++;
  }
}

// ── Section 1: listKnowledgeFiles ─────────────────────────────────────────────

console.log('\n─── Section 1: listKnowledgeFiles ───────────────────────────────');

await test('existing/ の .md ファイルが含まれる', async () => {
  const files = await listKnowledgeFiles({ sources: ['existing'] });
  assert.ok(files.length >= 8, `existing/ に8件以上あるはず (got ${files.length})`);
  assert.ok(files.every(f => f.source === 'existing'));
  assert.ok(files.every(f => f.file.endsWith('.md')));
});

await test('chatgpt/ の .md ファイルが含まれる', async () => {
  const files = await listKnowledgeFiles({ sources: ['chatgpt'] });
  assert.ok(files.length >= 5, `chatgpt/ に5件以上あるはず (got ${files.length})`);
  assert.ok(files.every(f => f.source === 'chatgpt'));
  assert.ok(files.every(f => f.file.endsWith('.md')));
});

await test('両方まとめて取得できる', async () => {
  const files = await listKnowledgeFiles();
  const existingCount = files.filter(f => f.source === 'existing').length;
  const chatgptCount  = files.filter(f => f.source === 'chatgpt').length;
  assert.ok(existingCount >= 8, `existing ${existingCount}`);
  assert.ok(chatgptCount  >= 5, `chatgpt  ${chatgptCount}`);
});

await test('.docx は含まれない（.md のみ）', async () => {
  const files = await listKnowledgeFiles();
  assert.ok(files.every(f => !f.file.endsWith('.docx')), '.docx が混入している');
});

// ── Section 2: searchKnowledge – 基本動作 ──────────────────────────────────

console.log('\n─── Section 2: searchKnowledge 基本動作 ─────────────────────────');

await test('"ヒナタ" で existing/ から結果が返る', async () => {
  const results = await searchKnowledge('ヒナタ', { sources: ['existing'] });
  assert.ok(results.length > 0, '結果が0件');
  assert.ok(results.every(r => r.source === 'existing'));
  const total = results.reduce((s, r) => s + r.matches.length, 0);
  assert.ok(total > 0, '本文マッチが0件');
});

await test('"ハヤテ" で existing/ から結果が返る', async () => {
  const results = await searchKnowledge('ハヤテ', { sources: ['existing'] });
  assert.ok(results.length > 0, '結果が0件');
  const total = results.reduce((s, r) => s + r.matches.length, 0);
  assert.ok(total > 0, '本文マッチが0件');
});

await test('"小雪" で existing/ から結果が返る', async () => {
  const results = await searchKnowledge('小雪', { sources: ['existing'] });
  assert.ok(results.length > 0, '結果が0件');
});

await test('"月が満ちるまで" で chatgpt/ から結果が返る', async () => {
  const results = await searchKnowledge('月が満ちるまで', { sources: ['chatgpt'] });
  assert.ok(results.length > 0, '結果が0件');
  assert.ok(results.every(r => r.source === 'chatgpt'));
});

// ── Section 3: 横断検索 ────────────────────────────────────────────────────

console.log('\n─── Section 3: 横断検索（existing + chatgpt） ───────────────────');

await test('"ヒナタ" が existing / chatgpt 両方から返る可能性がある（少なくとも1件以上）', async () => {
  const results = await searchKnowledge('ヒナタ');
  assert.ok(results.length > 0, '結果が0件');
  const sources = new Set(results.map(r => r.source));
  // existing には確実にヒナタが存在する
  assert.ok(sources.has('existing'), 'existing からの結果がない');
});

await test('source フィールドが existing / chatgpt のいずれか', async () => {
  const results = await searchKnowledge('雪');
  assert.ok(results.every(r => r.source === 'existing' || r.source === 'chatgpt'));
});

await test('file フィールドが .md ファイル名', async () => {
  const results = await searchKnowledge('ヒナタ');
  assert.ok(results.every(r => r.file.endsWith('.md')));
});

// ── Section 4: snippet / コンテキスト ────────────────────────────────────

console.log('\n─── Section 4: snippet・コンテキスト ───────────────────────────');

await test('snippet にキーワードが含まれる', async () => {
  const results = await searchKnowledge('ヒナタ', { contextLines: 2 });
  const allSnippets = results.flatMap(r => r.matches.map(m => m.snippet));
  assert.ok(allSnippets.length > 0);
  assert.ok(allSnippets.some(s => s.includes('ヒナタ')), 'snippet にキーワードが含まれない');
});

await test('lineNo が 1 以上の整数', async () => {
  const results = await searchKnowledge('コウタ');
  const lineNos = results.flatMap(r => r.matches.map(m => m.lineNo));
  assert.ok(lineNos.length > 0);
  assert.ok(lineNos.every(n => Number.isInteger(n) && n >= 1));
});

await test('contextLines=0 では1行のみ返る', async () => {
  const results = await searchKnowledge('ヒナタ', { contextLines: 0 });
  const allSnippets = results.flatMap(r => r.matches.map(m => m.snippet));
  assert.ok(allSnippets.length > 0);
  // contextLines=0 なのでスニペットに改行は基本ない（1行のみ）
  assert.ok(allSnippets.every(s => !s.includes('\n')), '複数行が混入している');
});

await test('全文は返さない（snippet は元テキストより短い）', async () => {
  const results = await searchKnowledge('ヒナタ', { contextLines: 3 });
  assert.ok(results.length > 0);
  // 各 snippet はファイル全体より明らかに短い（10000文字未満を目安）
  const allSnippets = results.flatMap(r => r.matches.map(m => m.snippet));
  assert.ok(allSnippets.every(s => s.length < 10000), 'snippet が長すぎる');
});

// ── Section 5: ファイル名検索 ─────────────────────────────────────────────

console.log('\n─── Section 5: ファイル名検索 ────────────────────────────────────');

await test('"年表" でファイル名マッチが返る', async () => {
  const results = await searchKnowledge('年表', { sources: ['existing'] });
  const nameMatched = results.filter(r => r.nameMatch);
  assert.ok(nameMatched.length > 0, 'ファイル名マッチが0件');
  assert.ok(nameMatched.some(r => r.file.includes('年表')));
});

await test('"MoonVail" でファイル名マッチが返る', async () => {
  const results = await searchKnowledge('MoonVail', { sources: ['existing'] });
  const nameMatched = results.filter(r => r.nameMatch);
  assert.ok(nameMatched.length > 0, 'MoonVail のファイル名マッチが0件');
});

// ── Section 6: エッジケース ───────────────────────────────────────────────

console.log('\n─── Section 6: エッジケース ──────────────────────────────────────');

await test('存在しないキーワードで空配列が返る', async () => {
  const results = await searchKnowledge('XYZXYZ絶対存在しないキーワード9999');
  assert.deepEqual(results, []);
});

await test('sources=[] で空配列が返る', async () => {
  const results = await searchKnowledge('ヒナタ', { sources: [] });
  assert.deepEqual(results, []);
});

await test('特殊文字（括弧・ドット）を含むクエリでもエラーにならない', async () => {
  const results = await searchKnowledge('（主人公）');
  assert.ok(Array.isArray(results));
});

await test('大文字小文字を区別しない検索（caseSensitive=false）', async () => {
  const lower = await searchKnowledge('snow flakes', { caseSensitive: false });
  const upper = await searchKnowledge('SNOW FLAKES', { caseSensitive: false });
  // 件数は同一のはず
  assert.equal(lower.length, upper.length);
});

// ── 結果 ──────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`);
console.log(`合計: ${passed + failed} tests  ✅ ${passed} passed  ❌ ${failed} failed`);
if (failed > 0) process.exit(1);
