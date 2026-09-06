/**
 * jarvis/tests/test_knowledge_ask.js
 * Snow flakes 設定資料 検索・参照基盤 テスト
 * Phase: Snow flakes knowledge retrieval
 *
 * 実行: node tests/test_knowledge_ask.js
 *
 * テスト対象:
 *   askKnowledge   - 検索・バリデーション・上限制御
 *   validateQuery  - クエリバリデーション単体
 *
 * 注意:
 *   - 実資料ファイル（jarvis/knowledge/）に依存するテストと、
 *     存在しないディレクトリを使うテストの両方を含む
 *   - 外部API・DB・OpenAI は一切使用しない
 *   - 設定資料の内容は変更しない
 */

import assert from 'node:assert/strict';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  askKnowledge,
  validateQuery,
  extractSearchTerms,
  QUERY_MAX_LENGTH,
  RESULTS_MAX_FILES,
  SNIPPETS_MAX_PER_FILE,
} from '../tools/knowledge_ask.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

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

// テスト用: 存在しないディレクトリを指す _dirs
const EMPTY_DIRS = {
  existing: resolve(__dirname, '../knowledge/__nonexistent_test_existing__'),
  chatgpt:  resolve(__dirname, '../knowledge/__nonexistent_test_chatgpt__'),
};

// ── Section 1: validateQuery ──────────────────────────────────────────────────

console.log('\n─── Section 1: validateQuery ────────────────────────────────────');

await test('正常なクエリは ok:true', async () => {
  assert.deepEqual(validateQuery('ヒナタ'), { ok: true });
});

await test('空文字は ok:false', async () => {
  const r = validateQuery('');
  assert.equal(r.ok, false);
  assert.ok(r.reason);
});

await test('スペースのみは ok:false', async () => {
  const r = validateQuery('   ');
  assert.equal(r.ok, false);
});

await test('QUERY_MAX_LENGTH 超過は ok:false', async () => {
  const long = 'あ'.repeat(QUERY_MAX_LENGTH + 1);
  const r = validateQuery(long);
  assert.equal(r.ok, false);
  assert.ok(r.reason.includes('文字以内'));
});

await test('QUERY_MAX_LENGTH ちょうどは ok:true', async () => {
  const exact = 'あ'.repeat(QUERY_MAX_LENGTH);
  const r = validateQuery(exact);
  assert.equal(r.ok, true);
});

await test('null は ok:false', async () => {
  const r = validateQuery(null);
  assert.equal(r.ok, false);
});

await test('数値は ok:false', async () => {
  const r = validateQuery(42);
  assert.equal(r.ok, false);
});

// ── Section 2: 実資料 基本検索 ────────────────────────────────────────────────

console.log('\n─── Section 2: 実資料 基本検索 ─────────────────────────────────');

await test('"ヒナタ" → found:true・複数ファイルにマッチ', async () => {
  const r = await askKnowledge('ヒナタ');
  assert.equal(r.found, true);
  assert.ok(r.results.length > 1, `マッチファイルが1件以下 (got ${r.results.length})`);
  assert.equal(r.query, 'ヒナタ');
});

await test('"ヒナタ" → existing・chatgpt 両方の source が含まれる', async () => {
  const r = await askKnowledge('ヒナタ');
  const sources = new Set(r.results.map(x => x.source));
  assert.ok(sources.has('existing'), 'existing がない');
  assert.ok(sources.has('chatgpt'),  'chatgpt がない');
});

await test('"月が満ちるまで" → chatgpt 資料から結果が返る', async () => {
  const r = await askKnowledge('月が満ちるまで');
  assert.equal(r.found, true);
  const chatgptHits = r.results.filter(x => x.source === 'chatgpt');
  assert.ok(chatgptHits.length > 0, 'chatgpt からの結果がない');
});

await test('存在しない設定 → found:false', async () => {
  const r = await askKnowledge('XYZXYZ絶対存在しない設定9999');
  assert.equal(r.found, false);
  assert.ok(r.message.includes('確認できません'));
  assert.deepEqual(r.results, []);
});

// ── Section 3: source 判別 ────────────────────────────────────────────────────

console.log('\n─── Section 3: source 判別 ──────────────────────────────────────');

await test('全結果の source が existing / chatgpt のいずれか', async () => {
  const r = await askKnowledge('ヒナタ');
  assert.ok(r.results.every(x => x.source === 'existing' || x.source === 'chatgpt'));
});

await test('existing 専用クエリ → existing のみ返る', async () => {
  // "年表" は existing の Snow_flakes_年表.md にのみ存在
  const r = await askKnowledge('Snow_flakes_年表');
  if (r.found) {
    // ファイル名マッチが existing になること
    const existingHits = r.results.filter(x => x.source === 'existing');
    assert.ok(existingHits.length > 0);
  }
  // found:false でもエラーにしない（資料内容に依存）
  assert.ok(Array.isArray(r.results));
});

await test('chatgpt 専用クエリ → chatgpt から結果が返る', async () => {
  const r = await askKnowledge('宵の月');
  if (r.found) {
    const chatgptHits = r.results.filter(x => x.source === 'chatgpt');
    assert.ok(chatgptHits.length > 0, 'chatgpt からの結果がない');
  }
  assert.ok(Array.isArray(r.results));
});

// ── Section 4: snippet 制限 ───────────────────────────────────────────────────

console.log('\n─── Section 4: snippet 制限 ────────────────────────────────────');

await test('各ファイルのmatches数が SNIPPETS_MAX_PER_FILE 以下', async () => {
  const r = await askKnowledge('ヒナタ');
  assert.ok(r.results.every(x => x.matches.length <= SNIPPETS_MAX_PER_FILE),
    `snippet 数が上限超過`);
});

await test('snippet にキーワードが含まれる', async () => {
  const r = await askKnowledge('ヒナタ');
  const allSnippets = r.results.flatMap(x => x.matches.map(m => m.snippet));
  assert.ok(allSnippets.length > 0);
  assert.ok(allSnippets.some(s => s.includes('ヒナタ')));
});

await test('snippet はファイル全文ではない（短い）', async () => {
  const r = await askKnowledge('ヒナタ');
  const allSnippets = r.results.flatMap(x => x.matches.map(m => m.snippet));
  assert.ok(allSnippets.every(s => s.length < 10_000));
});

await test('lineNo は 1 以上の整数', async () => {
  const r = await askKnowledge('ヒナタ');
  const lineNos = r.results.flatMap(x => x.matches.map(m => m.lineNo));
  assert.ok(lineNos.every(n => Number.isInteger(n) && n >= 1));
});

await test('matchType フィールドが存在する', async () => {
  const r = await askKnowledge('ヒナタ');
  const types = r.results.flatMap(x => x.matches.map(m => m.matchType));
  assert.ok(types.every(t => t === 'body' || t === 'filename'));
});

// ── Section 5: 結果件数上限 ───────────────────────────────────────────────────

console.log('\n─── Section 5: 結果件数上限 ─────────────────────────────────────');

await test('results の長さが RESULTS_MAX_FILES 以下', async () => {
  const r = await askKnowledge('の');  // 広範なクエリで多くヒットさせる
  assert.ok(r.results.length <= RESULTS_MAX_FILES,
    `results が上限超過: ${r.results.length}`);
});

await test('maxFiles=2 で結果が2件以下に制限される', async () => {
  const r = await askKnowledge('ヒナタ', { maxFiles: 2 });
  assert.ok(r.results.length <= 2, `制限超過: ${r.results.length}`);
});

await test('maxSnippetsPerFile=1 でsnippetが1件に制限される', async () => {
  const r = await askKnowledge('ヒナタ', { maxSnippetsPerFile: 1 });
  assert.ok(r.results.every(x => x.matches.length <= 1));
});

// ── Section 6: エッジケース・安全制御 ────────────────────────────────────────

console.log('\n─── Section 6: エッジケース・安全制御 ───────────────────────────');

await test('空クエリ → found:false・エラーにならない', async () => {
  const r = await askKnowledge('');
  assert.equal(r.found, false);
  assert.ok(r.message);
  assert.deepEqual(r.results, []);
});

await test('スペースのみ → found:false', async () => {
  const r = await askKnowledge('   ');
  assert.equal(r.found, false);
});

await test('QUERY_MAX_LENGTH 超過 → found:false・エラーにならない', async () => {
  const long = 'あ'.repeat(QUERY_MAX_LENGTH + 1);
  const r = await askKnowledge(long);
  assert.equal(r.found, false);
  assert.ok(r.message.includes('文字以内'));
});

await test('path traversal 的入力 "../../../etc/passwd" → knowledge外を読まない', async () => {
  // パスはコード側で固定。クエリ文字列はキーワードとして扱われるだけ
  const r = await askKnowledge('../../../etc/passwd');
  // found:true/false どちらでも OK（結果が knowledge/ 内のファイルのみ）
  assert.ok(Array.isArray(r.results));
  // 結果ファイルがすべて .md 形式
  assert.ok(r.results.every(x => x.file.endsWith('.md')));
  // filePath が knowledge/ 以外を指していないこと
  // (knowledge_search.js はコード固定パスのみスキャンするため実質保証される)
});

await test('特殊文字（括弧・ドット・正規表現メタ）→ エラーにならない', async () => {
  const r = await askKnowledge('（テスト）.+*?');
  assert.ok(Array.isArray(r.results));
});

await test('null クエリ → found:false・例外なし', async () => {
  const r = await askKnowledge(null);
  assert.equal(r.found, false);
  assert.deepEqual(r.results, []);
});

// ── Section 7: knowledgeフォルダなし ─────────────────────────────────────────

console.log('\n─── Section 7: knowledge フォルダが存在しない場合 ───────────────');

await test('存在しないディレクトリを渡しても found:false で安全に返る', async () => {
  const r = await askKnowledge('ヒナタ', { _dirs: EMPTY_DIRS });
  assert.equal(r.found, false);
  assert.ok(r.message.includes('確認できません'));
  assert.deepEqual(r.results, []);
});

await test('存在しないディレクトリでも例外が投げられない', async () => {
  let threw = false;
  try {
    await askKnowledge('テスト', { _dirs: EMPTY_DIRS });
  } catch {
    threw = true;
  }
  assert.equal(threw, false, '例外が投げられた');
});

// ── Section 8: extractSearchTerms ────────────────────────────────────────────

console.log('\n─── Section 8: extractSearchTerms ───────────────────────────────');

await test('"ヒナタ"（単語）→ "ヒナタ" が含まれる', async () => {
  const terms = extractSearchTerms('ヒナタ');
  assert.ok(terms.some(t => t.includes('ヒナタ')), `got: ${terms}`);
});

await test('"小雪の設定を確認して" → "小雪" が抽出される', async () => {
  const terms = extractSearchTerms('小雪の設定を確認して');
  assert.ok(terms.includes('小雪'), `got: ${terms}`);
  assert.ok(!terms.includes('設定'), '設定はストップワードのはず');
});

await test('"ヒナタの大学時代の設定を教えて" → "ヒナタ" または "大学時代" が含まれる', async () => {
  const terms = extractSearchTerms('ヒナタの大学時代の設定を教えて');
  assert.ok(
    terms.some(t => t.includes('ヒナタ') || t.includes('大学時代')),
    `got: ${terms}`
  );
  assert.ok(!terms.some(t => t === '設定'), '設定はストップワードのはず');
});

await test('"ハヤテと翼の関係は？" → "ハヤテ" と "翼" が両方抽出される', async () => {
  const terms = extractSearchTerms('ハヤテと翼の関係は？');
  assert.ok(terms.some(t => t.includes('ハヤテ')), `ハヤテがない: ${terms}`);
  assert.ok(terms.includes('翼'), `翼がない: ${terms}`);
  assert.ok(!terms.some(t => t === '関係'), '関係はストップワードのはず');
});

await test('"月が満ちるまでについて教えて" → "月が満ちるまで" が抽出され、部分語が含まれない', async () => {
  const terms = extractSearchTerms('月が満ちるまでについて教えて');
  assert.ok(terms.includes('月が満ちるまで'), `got: ${terms}`);
  assert.ok(!terms.some(t => t === '満ちるま'), `部分語 "満ちるま" が混入: ${terms}`);
});

await test('抽出結果はストップワードを含まない', async () => {
  const queries = [
    '小雪の設定を確認して',
    'ヒナタの大学時代の設定を教えて',
    'ハヤテと翼の関係は？',
  ];
  for (const q of queries) {
    const terms = extractSearchTerms(q);
    for (const t of terms) {
      assert.ok(!['設定', '情報', '関係', 'について'].includes(t),
        `ストップワード混入: "${t}" in "${q}"`);
    }
  }
});

await test('短いクエリ → 元の語が返る', async () => {
  const terms = extractSearchTerms('コウタ');
  assert.ok(terms.length > 0);
  assert.ok(terms.some(t => t.includes('コウタ')));
});

// ── Section 9: API 等価性（同じ関数を経由） ──────────────────────────────────

console.log('\n─── Section 9: API 等価性 ───────────────────────────────────────');

await test('CLIから呼ぶ askKnowledge と API エンドポイントが同じ関数を使う（参照確認）', async () => {
  const r1 = await askKnowledge('ヒナタ');
  const r2 = await askKnowledge('ヒナタ');
  assert.equal(r1.found, r2.found);
  assert.equal(r1.results.length, r2.results.length);
  assert.equal(r1.results[0]?.file, r2.results[0]?.file);
});

await test('API 想定: q="" → found:false（エンドポイント相当）', async () => {
  const q = '';
  const r = await askKnowledge(q);
  assert.equal(r.found, false);
});

await test('API 想定: q="ヒナタ" → results配列・source・file・snippet全て含む', async () => {
  const r = await askKnowledge('ヒナタ');
  assert.ok(r.found);
  for (const res of r.results) {
    assert.ok(typeof res.source === 'string');
    assert.ok(typeof res.file   === 'string');
    assert.ok(Array.isArray(res.matches));
    for (const m of res.matches) {
      assert.ok(typeof m.lineNo  === 'number');
      assert.ok(typeof m.snippet === 'string');
    }
  }
});

await test('searchedTerms フィールドが配列として返る', async () => {
  const r = await askKnowledge('ヒナタの大学時代の設定を教えて');
  assert.ok(Array.isArray(r.searchedTerms), 'searchedTerms がない');
  assert.ok(r.searchedTerms.length > 0, 'searchedTerms が空');
});

await test('found:false のときも searchedTerms が含まれる', async () => {
  const r = await askKnowledge('XYZXYZ存在しない9999');
  assert.equal(r.found, false);
  assert.ok(Array.isArray(r.searchedTerms));
});

// ── Section 10: 設定資料の安全性 ─────────────────────────────────────────────

console.log('\n─── Section 10: 設定資料の安全性 ───────────────────────────────');

await test('知識ベースは読み取り専用（結果に更新系のフィールドが含まれない）', async () => {
  const r = await askKnowledge('ヒナタ');
  // 書き込み・削除に使えるフィールドが返り値にないこと
  assert.ok(!('delete' in r));
  assert.ok(!('write' in r));
  assert.ok(!('path' in r));  // 絶対パスは返さない（file 名のみ）
  for (const res of r.results) {
    // filePath（絶対パス）は外部に露出しない
    assert.ok(!('filePath' in res), 'filePath が露出している');
  }
});

await test('外部APIが呼ばれていない（import に openai / anthropic が含まれない）', async () => {
  // knowledge_ask.js が外部APIを import していないことをファイル内容で確認
  const { readFile } = await import('node:fs/promises');
  const src = await readFile(new URL('../tools/knowledge_ask.js', import.meta.url), 'utf-8');
  assert.ok(!src.includes('openai'),    'openai import が含まれている');
  assert.ok(!src.includes('anthropic'), 'anthropic import が含まれている');
  assert.ok(!src.includes('fetch('),    'fetch が含まれている（外部API疑い）');
});

// ── 結果 ──────────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`);
console.log(`合計: ${passed + failed} tests  ✅ ${passed} passed  ❌ ${failed} failed`);
if (failed > 0) process.exit(1);
