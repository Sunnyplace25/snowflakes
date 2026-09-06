/**
 * jarvis/tools/knowledge_search.js
 * Snow flakes 設定資料 ローカル全文検索モジュール
 *
 * 設計方針:
 *   - 対象: jarvis/knowledge/snowflakes/ 以下の .md ファイルのみ
 *   - .docx は保管用として読み込まない
 *   - 読み取り専用: 設定資料を変更・削除しない
 *   - ファイル全文は返さず、ヒット行の前後 contextLines 行だけ返す
 *   - source フィールドで existing / chatgpt を区別する
 *   - 外部API・Embeddings不使用（ローカルテキスト検索のみ）
 *   - UI から分離した純粋なモジュール（将来の AI 連携でも使用可能）
 *
 * 使用例:
 *   import { searchKnowledge } from '../tools/knowledge_search.js';
 *   const results = await searchKnowledge('ヒナタ');
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── パス定義 ──────────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));

const KNOWLEDGE_DIRS = {
  existing: resolve(__dirname, '../knowledge/snowflakes/existing'),
  chatgpt:  resolve(__dirname, '../knowledge/snowflakes/chatgpt'),
};

// ── 内部ヘルパー ──────────────────────────────────────────────────────────────

/**
 * ディレクトリ内の .md ファイル一覧を返す
 * @param {string} dir
 * @returns {Promise<string[]>} 絶対パスの配列
 */
async function listMdFiles(dir) {
  let entries;
  try {
    entries = await readdir(dir);
  } catch {
    return []; // フォルダが存在しない場合は空
  }
  return entries
    .filter(f => f.endsWith('.md'))
    .map(f => join(dir, f));
}

/**
 * テキストからクエリにマッチする行とその前後コンテキストを抽出する
 * @param {string} text       ファイル全文
 * @param {RegExp} pattern    検索パターン
 * @param {number} contextLines 前後に含める行数
 * @returns {{ lineNo: number, snippet: string }[]}
 */
function extractMatches(text, pattern, contextLines) {
  const lines = text.split('\n');
  const results = [];
  const seen = new Set(); // 同じ行を重複して返さない

  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i])) {
      const from = Math.max(0, i - contextLines);
      const to   = Math.min(lines.length - 1, i + contextLines);

      // already covered by a previous match window?
      if (seen.has(i)) continue;
      for (let j = from; j <= to; j++) seen.add(j);

      const snippet = lines.slice(from, to + 1).join('\n');
      results.push({ lineNo: i + 1, snippet }); // lineNo は 1-indexed
    }
  }
  return results;
}

// ── 公開 API ──────────────────────────────────────────────────────────────────

/**
 * Snow flakes 設定資料を横断検索する
 *
 * @param {string} query 検索キーワード（正規表現メタ文字はエスケープされる）
 * @param {{
 *   contextLines?: number,  // ヒット行の前後に含める行数（デフォルト 3）
 *   caseSensitive?: boolean, // 大文字小文字を区別するか（デフォルト false）
 *   sources?: ('existing'|'chatgpt')[], // 検索対象 source（省略時は両方）
 * }} [opts]
 *
 * @returns {Promise<{
 *   source: 'existing'|'chatgpt',
 *   file: string,       // ファイル名（拡張子あり）
 *   filePath: string,   // 絶対パス
 *   nameMatch: boolean,
 *   matches: { lineNo: number, snippet: string }[],
 * }[]>}
 */
export async function searchKnowledge(query, opts = {}) {
  const {
    contextLines  = 3,
    caseSensitive = false,
    sources       = ['existing', 'chatgpt'],
    _dirs         = null, // テスト用ディレクトリオーバーライド（本番では使用しない）
  } = opts;

  const dirs = _dirs ?? KNOWLEDGE_DIRS;

  // クエリを正規表現に変換（メタ文字をエスケープ）
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const flags   = caseSensitive ? 'g' : 'gi';
  const pattern = new RegExp(escaped, flags);

  const output = [];

  for (const source of sources) {
    const dir = dirs[source];
    if (!dir) continue;

    const files = await listMdFiles(dir);

    for (const filePath of files.sort()) {
      const fileName = basename(filePath);

      // ファイル名マッチ（本文スキャン前に確認）
      const nameMatch = pattern.test(fileName);
      // pattern は stateful（g フラグ）なので lastIndex をリセット
      pattern.lastIndex = 0;

      let text;
      try {
        text = await readFile(filePath, 'utf-8');
      } catch {
        continue; // 読み込み失敗はスキップ
      }

      const bodyMatches = extractMatches(text, pattern, contextLines);
      pattern.lastIndex = 0;

      // ファイル名のみマッチで本文はゼロ件の場合も結果に含める
      if (!nameMatch && bodyMatches.length === 0) continue;

      output.push({
        source,
        file: fileName,
        filePath,
        nameMatch,
        matches: bodyMatches,
      });
    }
  }

  return output;
}

/**
 * knowledge/ 配下に存在する .md ファイルの一覧を返す（インデックス用）
 * @param {{ sources?: ('existing'|'chatgpt')[] }} [opts]
 * @returns {Promise<{ source: string, file: string, filePath: string }[]>}
 */
export async function listKnowledgeFiles(opts = {}) {
  const { sources = ['existing', 'chatgpt'], _dirs = null } = opts;
  const dirs = _dirs ?? KNOWLEDGE_DIRS;
  const output = [];

  for (const source of sources) {
    const dir = dirs[source];
    if (!dir) continue;
    const files = await listMdFiles(dir);
    for (const filePath of files.sort()) {
      output.push({ source, file: basename(filePath), filePath });
    }
  }

  return output;
}
