/**
 * content_business/web_scraper.mjs
 * 公開URLから記事メタデータを実際に取得する
 *
 * 取得対象: 公開情報のみ（タイトル・作者・価格・公開日・無料部分・目次）
 * 禁止: 有料本文の取得・スクレイピング規約違反
 */

const FETCH_TIMEOUT_MS = 12000;
const UA = 'Mozilla/5.0 (compatible; JARVIS-Scout/1.0; +https://jarvis.local)';

/**
 * 1つのURLから公開メタデータを取得する
 * @param {string} url
 * @returns {Promise<ArticleMetadata>}
 */
export async function fetchArticleMetadata(url) {
  let html;
  try {
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'ja,en;q=0.9',
      },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'follow',
    });

    if (!res.ok) throw new Error(`HTTP ${res.status} ${res.statusText}`);

    const ct = res.headers.get('content-type') ?? '';
    if (!ct.includes('html')) throw new Error(`HTML以外のコンテンツタイプ: ${ct}`);

    html = await res.text();
  } catch (err) {
    throw new Error(`取得失敗 (${url}): ${err.message}`);
  }

  return parseHtml(html, url);
}

/**
 * URLリストを並列取得（失敗・タイムアウトしたものはfetch_ok:falseで記録して続行）
 * 1件の失敗が全体をブロックしない。Promise.allSettled ベース。
 *
 * @param {string[]} urls
 * @param {{
 *   onProgress?: (done:number, total:number, url:string) => void,
 *   concurrency?: number,   // 同時取得数（デフォルト3）
 *   totalTimeoutMs?: number // 全体タイムアウト（デフォルト無制限）
 * }} opts
 * @returns {Promise<ArticleMetadata[]>}
 */
export async function fetchMultipleArticles(urls, opts = {}) {
  const concurrency = opts.concurrency ?? 3;
  const allResults = new Array(urls.length);
  let done = 0;

  // concurrency件ずつ並列処理
  for (let i = 0; i < urls.length; i += concurrency) {
    const batch = urls.slice(i, i + concurrency);
    const settled = await Promise.allSettled(batch.map(url => fetchArticleMetadata(url)));
    settled.forEach((r, j) => {
      const url = batch[j];
      if (r.status === 'fulfilled') {
        allResults[i + j] = r.value;
      } else {
        allResults[i + j] = {
          url,
          fetch_error: r.reason?.message ?? String(r.reason),
          fetch_ok: false,
          source: url,
          fetched_at: new Date().toISOString(),
        };
      }
      done++;
      if (opts.onProgress) opts.onProgress(done, urls.length, url);
    });
    // バッチ間インターバル（サーバー負荷軽減）
    if (i + concurrency < urls.length) await new Promise(r => setTimeout(r, 600));
  }
  return allResults;
}

// ─── HTML パーサー ──────────────────────────────────────────────────────────

function parseHtml(html, url) {
  const domain = (() => { try { return new URL(url).hostname; } catch { return ''; } })();

  const meta = {
    url,
    fetch_ok: true,
    source: domain,
    fetched_at: new Date().toISOString(),

    title:         ogMeta(html, 'og:title')    || titleTag(html) || null,
    author:        ogMeta(html, 'og:article:author') || metaName(html, 'author') || null,
    published_at:  ogMeta(html, 'article:published_time') || ogMeta(html, 'og:updated_time') || null,
    description:   ogMeta(html, 'og:description') || metaName(html, 'description') || null,
    price:         null,
    table_of_contents: null,
    free_content:  null,
    target_reader: null,
    cta:           null,
    reaction_metrics: null,
  };

  // JSON-LD 解析（より詳細な情報を取得）
  const jsonLds = extractJsonLds(html);
  for (const ld of jsonLds) {
    if (!meta.title  && (ld.headline || ld.name)) meta.title = ld.headline || ld.name;
    if (!meta.author && ld.author)  meta.author  = typeof ld.author === 'object' ? ld.author.name : ld.author;
    if (!meta.published_at && ld.datePublished) meta.published_at = ld.datePublished;
    if (!meta.description  && ld.description)  meta.description  = ld.description;
    if (ld.offers?.price !== undefined) meta.price = String(ld.offers.price);
  }

  // ── note.com 特有の処理 ──────────────────────────────────────────────────
  if (domain.includes('note.com')) {
    const noteData = parseNotePage(html);
    if (noteData.price    !== null)  meta.price    = noteData.price;
    if (noteData.author)             meta.author   = noteData.author;
    if (noteData.toc)                meta.table_of_contents = noteData.toc;
    if (noteData.free_text)          meta.free_content = noteData.free_text;
    if (noteData.likes)              meta.reaction_metrics = `いいね: ${noteData.likes}`;
    if (noteData.published_at)       meta.published_at = noteData.published_at;
  }

  // ── 目次抽出（汎用 — h2/h3 見出し）────────────────────────────────────
  if (!meta.table_of_contents) {
    const headings = extractHeadings(html);
    if (headings.length >= 2) meta.table_of_contents = headings.join(' / ');
  }

  // ── 無料テキスト（ogDescription をフォールバックに使用）───────────────
  if (!meta.free_content && meta.description) {
    meta.free_content = meta.description.slice(0, 500);
  }

  // 日付を ISO8601 から読みやすい形式に変換
  if (meta.published_at) {
    try {
      meta.published_at = new Date(meta.published_at).toISOString().replace('T', ' ').slice(0, 16);
    } catch { /* そのまま */ }
  }

  return meta;
}

// ─── note.com 専用パーサー ──────────────────────────────────────────────────

function parseNotePage(html) {
  const result = { price: null, author: null, toc: null, free_text: null, likes: null, published_at: null };

  // nuxt データ / __NUXT_DATA__ から JSON を取得
  const nuxtMatch = html.match(/<script id="__NUXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (nuxtMatch) {
    try {
      const data = JSON.parse(nuxtMatch[1]);
      // ネストされた配列から文字列を探してpriceを推定（簡易）
      const flat = JSON.stringify(data);
      const priceM = flat.match(/"price":(\d+)/);
      if (priceM) result.price = priceM[1] + '円';
      const likeM = flat.match(/"likeCount":(\d+)/);
      if (likeM) result.likes = likeM[1];
    } catch { /* JSON解析失敗は無視 */ }
  }

  // meta description から無料テキストを取得
  const descM = html.match(/<meta[^>]+name="description"[^>]+content="([^"]*)"[^>]*>/i)
    ?? html.match(/<meta[^>]+content="([^"]*)"[^>]+name="description"[^>]*>/i);
  if (descM) result.free_text = htmlDecode(descM[1]);

  // 作者名: note独自のクレジット
  const authorM = html.match(/<span[^>]*class="[^"]*o-noteContentHeader__creatorName[^"]*"[^>]*>([\s\S]*?)<\/span>/i)
    ?? html.match(/<a[^>]*class="[^"]*m-creatorHeader__name[^"]*"[^>]*>([\s\S]*?)<\/a>/i);
  if (authorM) result.author = stripTags(authorM[1]).trim();

  // 公開日: note独自
  const dateM = html.match(/<time[^>]*datetime="([^"]*)"[^>]*>/i);
  if (dateM) result.published_at = dateM[1];

  // 目次: h2/h3 要素（noteの本文から）
  const headings = [];
  const hMatch = html.matchAll(/<h[23][^>]*>([\s\S]*?)<\/h[23]>/gi);
  for (const m of hMatch) {
    const text = stripTags(m[1]).trim();
    if (text && text.length < 100) headings.push(text);
    if (headings.length >= 10) break;
  }
  if (headings.length >= 2) result.toc = headings.join(' / ');

  // 価格表示: "有料" テキスト
  if (!result.price && html.includes('有料')) {
    const priceTagM = html.match(/(\d{2,5})円/);
    if (priceTagM) result.price = priceTagM[1] + '円';
  }
  if (!result.price && html.includes('無料')) result.price = '無料';

  return result;
}

// ─── ユーティリティ ──────────────────────────────────────────────────────────

function ogMeta(html, property) {
  const m = html.match(new RegExp(`<meta[^>]+property="${escRe(property)}"[^>]+content="([^"]*)"`, 'i'))
    ?? html.match(new RegExp(`<meta[^>]+content="([^"]*)"[^>]+property="${escRe(property)}"`, 'i'));
  return m ? htmlDecode(m[1]) : null;
}

function metaName(html, name) {
  const m = html.match(new RegExp(`<meta[^>]+name="${escRe(name)}"[^>]+content="([^"]*)"`, 'i'))
    ?? html.match(new RegExp(`<meta[^>]+content="([^"]*)"[^>]+name="${escRe(name)}"`, 'i'));
  return m ? htmlDecode(m[1]) : null;
}

function titleTag(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? htmlDecode(stripTags(m[1])).trim() : null;
}

function extractJsonLds(html) {
  const results = [];
  const re = /<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    try { results.push(JSON.parse(m[1])); } catch { /* skip */ }
  }
  return results;
}

function extractHeadings(html) {
  const headings = [];
  for (const m of html.matchAll(/<h[23][^>]*>([\s\S]*?)<\/h[23]>/gi)) {
    const text = stripTags(m[1]).trim();
    if (text && text.length < 100) headings.push(text);
    if (headings.length >= 12) break;
  }
  return headings;
}

function stripTags(html) {
  return html.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ');
}

function htmlDecode(str) {
  return str
    .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function escRe(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * @typedef {Object} ArticleMetadata
 * @property {string} url
 * @property {boolean} fetch_ok
 * @property {string} source
 * @property {string} fetched_at
 * @property {string|null} title
 * @property {string|null} author
 * @property {string|null} published_at
 * @property {string|null} description
 * @property {string|null} price
 * @property {string|null} table_of_contents
 * @property {string|null} free_content
 * @property {string|null} target_reader
 * @property {string|null} reaction_metrics
 * @property {string} [fetch_error]
 */

// ─── URL 自動探索 ───────────────────────────────────────────────────────────

const DISCOVER_TIMEOUT_MS = 10000;
const NOTE_SEARCH_API = 'https://note.com/api/v2/searches';

/**
 * note.com 検索API から関連記事の URL を収集する（架空URL生成なし）
 *
 * @param {string} query - 検索キーワード
 * @param {{ maxUrls?: number, excludeUrls?: string[], onProgress?: Function }} opts
 * @returns {Promise<string[]>} 実在するnote記事のURL一覧
 */
export async function discoverNoteUrls(query, opts = {}) {
  const { maxUrls = 30, excludeUrls = [], onProgress } = opts;
  const excludeSet = new Set(excludeUrls.filter(Boolean));
  const urls = [];

  console.log(`[ヒカゲ] URL探索開始: "${query}" (最大${maxUrls}件)`);

  // note.com 検索を最大3ページ取得
  for (let page = 1; urls.length < maxUrls && page <= 3; page++) {
    const searchUrl = `${NOTE_SEARCH_API}?q=${encodeURIComponent(query)}&context=note&size=20&page=${page}`;
    try {
      const res = await fetch(searchUrl, {
        headers: {
          'User-Agent': UA,
          'Accept': 'application/json',
          'Accept-Language': 'ja,en;q=0.9',
        },
        signal: AbortSignal.timeout(DISCOVER_TIMEOUT_MS),
      });

      if (!res.ok) {
        console.warn(`[ヒカゲ] 検索API失敗 (page${page}): HTTP ${res.status}`);
        break;
      }

      const data = await res.json();
      const notes = data?.data?.notes ?? [];

      for (const note of notes) {
        if (urls.length >= maxUrls) break;
        const urlname = note.user?.urlname;
        const key     = note.key;
        if (!urlname || !key) continue;
        const url = `https://note.com/${urlname}/n/${key}`;
        if (!excludeSet.has(url)) {
          urls.push(url);
          excludeSet.add(url);
        }
      }

      if (onProgress) onProgress(urls.length, maxUrls, `page${page}`);
      console.log(`[ヒカゲ] page${page}: ${notes.length}件取得 → 累計${urls.length}件`);

      if (notes.length < 20) break; // 最終ページ
    } catch (err) {
      console.warn(`[ヒカゲ] URL探索エラー (page${page}):`, err.message);
      break;
    }
  }

  console.log(`[ヒカゲ] URL探索完了: ${urls.length}件`);
  return urls;
}

/**
 * 複数クエリで URL を探索し、重複を除去してまとめて返す
 *
 * @param {string[]} queries - 検索クエリ一覧（スクリーニング上位案のタイトル等）
 * @param {{ maxTotal?: number, excludeUrls?: string[] }} opts
 * @returns {Promise<string[]>}
 */
export async function discoverNoteUrlsMulti(queries, opts = {}) {
  const { maxTotal = 30, excludeUrls = [] } = opts;
  const seen = new Set(excludeUrls.filter(Boolean));
  const result = [];
  const perQuery = Math.max(5, Math.ceil(maxTotal / queries.length));

  for (const query of queries) {
    if (result.length >= maxTotal) break;
    const found = await discoverNoteUrls(query, {
      maxUrls: perQuery,
      excludeUrls: [...seen],
    });
    for (const url of found) {
      if (result.length >= maxTotal) break;
      if (!seen.has(url)) {
        result.push(url);
        seen.add(url);
      }
    }
    // クエリ間の間隔（サーバー負荷軽減）
    if (result.length < maxTotal) {
      await new Promise(r => setTimeout(r, 600));
    }
  }

  return result;
}
