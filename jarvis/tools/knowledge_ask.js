/**
 * jarvis/tools/knowledge_ask.js
 * Snow flakes 設定資料 検索・参照基盤
 * Phase: Snow flakes knowledge retrieval
 *
 * 設計方針:
 *   - 渡されたクエリから検索語を抽出して knowledge_search.js に渡す
 *   - 検索対象ディレクトリはコード側で固定（ユーザーからパス指定不可）
 *   - ファイル全文を返さない。snippet（ヒット行の前後 contextLines 行）のみ
 *   - 結果0件は found:false / message で通知（推測・補完しない）
 *   - 複数 source の結果はそのまま返す（矛盾判定はしない）
 *   - OpenAI / Claude / Embeddings 等の外部APIは使用しない
 *   - knowledgeディレクトリが存在しなくてもエラーにならない
 *
 * 検索語抽出（extractSearchTerms）:
 *   - キャラ名固定リストなし・外部APIなし
 *   - 「Xについて」「Xの設定」「AとBの関係」等のパターンで名詞句を抽出
 *   - 日本語助詞（の/は/が/を/に/で/と...）で分割してストップワード除去
 *   - 複数語を抽出して横断検索、結果をファイル単位でマージ
 *   - originalQuery（元文）と searchedTerms（実際の検索語一覧）をレスポンスに含む
 *
 * 安全制御:
 *   - クエリ長上限: QUERY_MAX_LENGTH
 *   - 結果ファイル数上限: RESULTS_MAX_FILES
 *   - ファイルあたりsnippet数上限: SNIPPETS_MAX_PER_FILE
 *   - path traversal 不可（パスはコード側で固定）
 *   - .md のみ（knowledge_search.js で保証）
 *
 * CLI:
 *   node tools/knowledge_ask.js "ヒナタの大学時代は？"
 */

import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { searchKnowledge } from './knowledge_search.js';

// ── 定数 ──────────────────────────────────────────────────────────────────────

export const QUERY_MAX_LENGTH      = 200;
export const RESULTS_MAX_FILES     = 10;
export const SNIPPETS_MAX_PER_FILE = 5;
export const CONTEXT_LINES         = 3;

// ── 検索語抽出 ────────────────────────────────────────────────────────────────

/**
 * 検索結果として不要な汎用語（先頭一致で判定）
 * ※ キャラ名・作品名は含めない（固定リスト禁止）
 */
const STOPWORD_PREFIXES = [
  '設定', '情報', '資料', '詳細', '確認', '教え', 'くださ',
  '見せ', '調べ', 'について', 'に関', 'こと', '関係', '様子',
];

function isStopword(s) {
  return STOPWORD_PREFIXES.some(p => s.startsWith(p));
}

/**
 * ひらがなで終わる文字列かどうか判定する。
 * P4（助詞分割）の結果が語の途中で切れていないか確認するために使用する。
 * 例: "満ちるま" → true（「まで」の途中で切れている）
 *     "ヒナタ" → false（カタカナ名詞）
 *     "大学時代" → false（漢字で終わる）
 * @param {string} s
 * @returns {boolean}
 */
function endsWithHiragana(s) {
  return /[\u3041-\u3096]$/u.test(s);
}

/**
 * 自然文のクエリから検索語を抽出する。
 * キャラ名固定リストなし・外部APIなし・元質問文は保持（originalQuery）。
 *
 * 抽出パターン:
 *   P1: 「Xについて」  → X を抽出（タイトル扱い・それ以上分割しない）
 *   P2: 「Xの設定/情報/資料/詳細」 → X を抽出・の で内部分割して個別追加
 *   P3: 「AとBの関係/様子」 → A, B を個別抽出（1文字の固有名詞も含める）
 *   P4: フォールバック（P1/P2/P3で何も得られなかった場合のみ実行）
 *       助詞で分割・3文字以上・ひらがな終わりの部分語を除外
 *
 * @param {string} query
 * @returns {string[]} 検索語の配列（重複除去済み・空なら元のqueryをそのまま返す）
 */
export function extractSearchTerms(query) {
  const terms = new Set();

  // P1: 「Xについて」 → X をタイトルとして抽出（それ以上分割しない）
  for (const m of query.matchAll(/(.{2,15})について/gu)) {
    const t = m[1].replace(/^[のはがをにでもとからまでよりへ]+/u, '').trim();
    if (t.length >= 2 && !isStopword(t)) terms.add(t);
  }

  // P2: 「Xの設定/情報/資料/詳細」 → X を抽出・の で内部分割して各語も追加
  for (const m of query.matchAll(/(.{2,12}?)の(?:設定|情報|資料|詳細)/gu)) {
    const t = m[1].replace(/^[のはがをにでもとからまでよりへ]+/u, '').trim();
    if (t.length < 2 || isStopword(t)) continue;
    terms.add(t);
    // 「ヒナタの大学時代」→ "ヒナタ" + "大学時代" を個別追加
    for (const part of t.split(/の/u)) {
      const p = part.trim();
      if (p.length >= 2 && !isStopword(p)) terms.add(p);
    }
  }

  // P3: 「AとBの関係/様子」 → A, B を個別抽出
  // 固有名詞は1文字でも有効（例: 翼）。ただし単独ひらがな1文字は除外。
  for (const m of query.matchAll(/(.{1,15}?)の(?:関係|様子)/gu)) {
    const t = m[1].trim();
    for (const part of t.split(/[とや・]/u)) {
      const p = part.replace(/^[のはがをにでもとからまでよりへ]+/u, '').trim();
      if (p.length >= 1 && !isStopword(p) && !/^[\u3041-\u3096]$/u.test(p)) terms.add(p);
    }
  }

  // P4: フォールバック（P1/P2/P3 で何も抽出できなかった場合のみ）
  // 助詞で分割・3文字以上・ひらがな終わりの部分語（語の途中で切れた結果）を除外
  if (terms.size === 0) {
    for (const seg of query
      .replace(/[？！。、…]/gu, ' ')
      .split(/[のはがをにでもとからよりへってかな]/u)
      .map(s => s.trim())
      .filter(s => s.length >= 3 && !isStopword(s) && !endsWithHiragana(s))
    ) {
      terms.add(seg);
    }
  }

  // 最終フォールバック: 何も抽出できなければ元のクエリをそのまま返す
  if (terms.size === 0) {
    const fallback = query.trim();
    return fallback.length >= 2 ? [fallback] : [];
  }

  return [...terms].filter(t => t.length >= 1 && !isStopword(t));
}

// ── バリデーション ────────────────────────────────────────────────────────────

/**
 * クエリの安全性を検証する。
 * @param {string} query
 * @returns {{ ok: boolean, reason?: string }}
 */
export function validateQuery(query) {
  if (query === null || query === undefined || typeof query !== 'string') {
    return { ok: false, reason: 'クエリを文字列で指定してください' };
  }
  if (query.trim() === '') {
    return { ok: false, reason: '検索クエリを入力してください' };
  }
  if (query.length > QUERY_MAX_LENGTH) {
    return { ok: false, reason: `クエリは${QUERY_MAX_LENGTH}文字以内で入力してください（現在 ${query.length} 文字）` };
  }
  return { ok: true };
}

// ── 複数語マージ検索 ──────────────────────────────────────────────────────────

/**
 * 複数の検索語でそれぞれ検索し、ファイル単位でマージした結果を返す。
 * 同一 (source, file) のマッチはスニペット単位で重複排除する。
 *
 * @param {string[]} terms
 * @param {{ contextLines?: number, _dirs?: object|null,
 *           maxFiles?: number, maxSnippetsPerFile?: number }} opts
 * @returns {Promise<object[]>}
 */
async function searchMerged(terms, opts) {
  const { contextLines, _dirs, maxFiles, maxSnippetsPerFile } = opts;

  /** @type {Map<string, { source, file, nameMatch, matchedTerms: Set<string>, matchSet: Set<string>, matches: object[] }>} */
  const fileMap = new Map();

  for (const term of terms) {
    let raw;
    try {
      raw = await searchKnowledge(term, { contextLines, _dirs: _dirs ?? undefined });
    } catch {
      continue;
    }

    for (const r of raw) {
      const key = `${r.source}:${r.file}`;
      if (!fileMap.has(key)) {
        fileMap.set(key, {
          source:       r.source,
          file:         r.file,
          nameMatch:    r.nameMatch,
          matchedTerms: new Set(), // マッチした検索語の数（ランキング用）
          matchSet:     new Set(),
          matches:      [],
        });
      }
      const entry = fileMap.get(key);
      if (r.nameMatch) entry.nameMatch = true;
      entry.matchedTerms.add(term);

      for (const m of r.matches) {
        const mk = `${m.lineNo}`;
        if (!entry.matchSet.has(mk)) {
          entry.matchSet.add(mk);
          entry.matches.push({ lineNo: m.lineNo, snippet: m.snippet, matchType: 'body' });
        }
      }
    }
  }

  // 複数の検索語にマッチしたファイルを優先して上位に並べる
  return [...fileMap.values()]
    .sort((a, b) => b.matchedTerms.size - a.matchedTerms.size)
    .slice(0, maxFiles)
    .map(e => ({
      source:    e.source,
      file:      e.file,
      nameMatch: e.nameMatch,
      matches:   e.matches.slice(0, maxSnippetsPerFile),
    }));
}

// ── メイン公開 API ────────────────────────────────────────────────────────────

/**
 * Snow flakes 設定資料を検索して構造化結果を返す。
 *
 * @param {string} query 検索クエリ（自然文可）
 * @param {{
 *   maxFiles?:           number,
 *   maxSnippetsPerFile?: number,
 *   contextLines?:       number,
 *   _dirs?:              object,
 * }} [opts]
 *
 * @returns {Promise<{
 *   found:          boolean,
 *   query:          string,          // 元の質問文（trim済み）
 *   searchedTerms:  string[],        // 実際に検索した語のリスト
 *   message?:       string,
 *   results:        object[],
 * }>}
 */
export async function askKnowledge(query, opts = {}) {
  const {
    maxFiles           = RESULTS_MAX_FILES,
    maxSnippetsPerFile = SNIPPETS_MAX_PER_FILE,
    contextLines       = CONTEXT_LINES,
    _dirs              = null,
  } = opts;

  // ─ クエリ検証 ────────────────────────────────────────────────────────────
  const validation = validateQuery(query);
  if (!validation.ok) {
    return {
      found: false, query: String(query ?? ''),
      searchedTerms: [], message: validation.reason, results: [],
    };
  }

  const trimmedQuery = query.trim();

  // ─ 検索語抽出 ────────────────────────────────────────────────────────────
  const searchedTerms = extractSearchTerms(trimmedQuery);

  // ─ 複数語で横断検索してマージ ────────────────────────────────────────────
  let results;
  try {
    results = await searchMerged(searchedTerms, {
      contextLines, _dirs, maxFiles, maxSnippetsPerFile,
    });
  } catch {
    results = [];
  }

  // ─ 結果なし ──────────────────────────────────────────────────────────────
  if (results.length === 0) {
    return {
      found:         false,
      query:         trimmedQuery,
      searchedTerms,
      message:       '設定資料では確認できません',
      results:       [],
    };
  }

  return {
    found:         true,
    query:         trimmedQuery,
    searchedTerms,
    results,
  };
}

// ── CLI エントリーポイント ────────────────────────────────────────────────────

const __filename = fileURLToPath(import.meta.url);
const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(__filename);

if (isMain) {
  const query = process.argv.slice(2).join(' ');
  const result = await askKnowledge(query);

  if (!result.found) {
    console.log(`\n質問: "${result.query}"`);
    console.log(`検索語: ${result.searchedTerms.join(', ') || '(なし)'}`);
    console.log(`→ ${result.message}`);
    process.exit(0);
  }

  console.log(`\n質問: "${result.query}"`);
  console.log(`検索語: ${result.searchedTerms.join(', ')}`);
  console.log(`→ ${result.results.length} ファイルにマッチ`);
  for (const r of result.results) {
    console.log(`\n  [${r.source}] ${r.file}${r.nameMatch ? '  ※ファイル名一致' : ''}  (${r.matches.length}件)`);
    for (const m of r.matches) {
      console.log(`    L${m.lineNo}:`);
      for (const line of m.snippet.split('\n')) {
        console.log(`      ${line}`);
      }
    }
  }
}
