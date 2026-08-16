/**
 * jarvis/tools/soundrop_har_analyzer.mjs
 *
 * Soundrop Web App の DevTools Network キャプチャ（HAR形式）を解析し、
 * カタログ自動同期に必要なエンドポイント・レスポンス構造を抽出する。
 *
 * 使い方:
 *   1. Chrome DevTools > Network タブを開く
 *   2. soundrop.com にログイン
 *   3. Music > Albums → 一覧をスクロール（次ページも）
 *      → Release をクリック（Detail）
 *      Music > Tracks → 一覧 → Track をクリック（Detail）
 *   4. Network タブ右クリック → "Save all as HAR with content"
 *   5. ファイルを jarvis/imports/soundrop_capture.har として保存
 *      （.har で終わる名前にする。.har.txt 等の拡張子は使わない）
 *   6. node tools/soundrop_har_analyzer.mjs imports/soundrop_capture.har
 *
 * 出力ファイル: <入力ベース名>_audit.txt
 *   例: soundrop_capture.har     → soundrop_capture_audit.txt
 *       soundrop_capture.har.txt → soundrop_capture_audit.txt
 *   ※ 入力ファイルは絶対に上書きしない
 *
 * 安全設計:
 *   - Token / 認証ヘッダーの値は一切出力しない
 *   - クエリパラメータはキー名のみ記録（値は記録しない）
 *   - レスポンス JSON は構造（キー名・型）のみ抽出
 *   - 機密キー（token / secret / password 等）はキーごとスキップ
 *   - rawJSON はメモリに保持しない
 */

import { readFileSync, writeFileSync, existsSync } from 'fs';
import { basename, dirname, join } from 'path';

const harPath = process.argv[2];
if (!harPath) {
  console.error('使い方: node tools/soundrop_har_analyzer.mjs <path/to/capture.har>');
  process.exit(1);
}

// ── 出力パスを安全に決定（入力ファイルを絶対に上書きしない） ─────────────────
function safeOutputPath(inputPath) {
  const dir  = dirname(inputPath);
  let base   = basename(inputPath);
  // 末尾の .har / .har.txt / .txt 等を除去してベース名を取得
  base = base.replace(/(\.(har)(\.txt)?|\.txt)$/i, '');
  if (!base) base = 'soundrop_capture';
  const outName = base + '_audit.txt';
  const outPath = join(dir, outName);
  // 万一入力パスと一致した場合は別名にする（二重安全）
  if (outPath === inputPath) return join(dir, 'soundrop_audit_safe.txt');
  return outPath;
}

const outPath = safeOutputPath(harPath);

// ── HAR 読み込み（JSON検証付き） ──────────────────────────────────────────────
let har;
try {
  const raw = readFileSync(harPath, 'utf8');
  har = JSON.parse(raw);
} catch (e) {
  // JSON解析失敗 = 非HARファイル or 上書き済みの可能性
  console.error('HARファイルの読み込みに失敗:', e.message.slice(0, 80));
  console.error('→ ファイルが有効なHAR JSONではありません。');
  console.error('  Chrome DevTools > Network > 右クリック > "Save all as HAR with content"');
  console.error('  で再キャプチャしてください。');
  process.exit(1);
}

if (!har.log?.entries) {
  console.error('HARに log.entries が存在しません。有効なHARファイルか確認してください。');
  process.exit(1);
}

const entries = har.log.entries;
console.log(`HARエントリ総数: ${entries.length}`);

// ── 静的アセット除外 ──────────────────────────────────────────────────────────
const EXCLUDE_EXT  = /\.(js|css|png|jpg|jpeg|webp|svg|ico|woff2?|ttf|gif|mp3|wav)(\?.*)?$/i;
const EXCLUDE_PATH = /\/(static|assets|fonts|images)\//;

function isSoundropApi(entry) {
  const url = entry.request.url;
  return /soundrop\.com/.test(url)
    && !EXCLUDE_EXT.test(url)
    && !EXCLUDE_PATH.test(url)
    && ['GET','POST','PUT','PATCH','DELETE','HEAD','OPTIONS'].includes(entry.request.method);
}

const apiEntries = entries.filter(isSoundropApi);
console.log(`Soundrop API候補エントリ: ${apiEntries.length}`);
console.log('');

// ── 認証ヘッダー検出（値は絶対に出力しない） ─────────────────────────────────
const AUTH_HEADER_NAMES = [
  'authorization', 'x-auth-token', 'x-api-key', 'cookie',
  'x-session', 'bearer', 'x-csrf-token', 'x-access-token',
];

function detectAuthHeaders(headers) {
  const found = [];
  for (const h of headers) {
    const name = h.name.toLowerCase();
    if (AUTH_HEADER_NAMES.some(a => name.includes(a))) {
      // 値は参照しない — 種別名のみ返す
      const type = name === 'authorization' && h.value?.startsWith('Bearer ') ? 'Bearer JWT'
                 : name === 'authorization' && h.value?.startsWith('Basic ')  ? 'Basic Auth'
                 : name === 'cookie'                                           ? 'Cookie (session)'
                 : name;
      found.push(type);
    }
  }
  return [...new Set(found)];
}

// ── クエリパラメータから認証候補を検出（値は出力しない） ──────────────────────
// Soundrop は Token という query param で認証を行う
const AUTH_QUERY_KEYS = new Set(['token', 'access_token', 'apikey', 'api_key', 'key', 'auth']);

function detectAuthQueryKeys(queryKeys) {
  return [...queryKeys].filter(k => AUTH_QUERY_KEYS.has(k.toLowerCase()));
}

// ── レスポンス JSON 機密キー（キーごとスキップ） ──────────────────────────────
const SENSITIVE_KEYS = new Set([
  'token', 'access_token', 'refresh_token', 'id_token', 'session_token',
  'secret', 'password', 'credential', 'api_key', 'apikey',
  'authorization', 'auth', 'jwt', 'bearer', 'csrf',
  'private_key', 'client_secret',
]);

function isSensitiveKey(key) {
  const k = key.toLowerCase();
  return SENSITIVE_KEYS.has(k) || [...SENSITIVE_KEYS].some(s => k.includes(s));
}

// ── JSON スキーマ抽出（値は出力しない、機密キーはスキップ） ───────────────────
function extractSchema(obj, depth = 0) {
  if (depth > 5) return '...';
  if (obj === null)            return 'null';
  if (typeof obj !== 'object') return typeof obj;
  if (Array.isArray(obj)) {
    if (obj.length === 0) return '[]';
    return `[${extractSchema(obj[0], depth + 1)}] (${obj.length}件)`;
  }
  const fields = Object.entries(obj)
    .filter(([k]) => !isSensitiveKey(k))
    .map(([k, v]) => `${k}: ${extractSchema(v, depth + 1)}`);
  return '{ ' + fields.join(', ') + ' }';
}

// ── URL パース（クエリ値は取得しない） ───────────────────────────────────────
function parseUrl(rawUrl) {
  try {
    const u = new URL(rawUrl);
    return { origin: u.origin, path: u.pathname, queryKeys: [...u.searchParams.keys()] };
  } catch {
    return { origin: '', path: rawUrl, queryKeys: [] };
  }
}

// ── エンドポイント別集計 ──────────────────────────────────────────────────────
const endpointMap = new Map();

for (const entry of apiEntries) {
  const { path, queryKeys, origin } = parseUrl(entry.request.url);
  const method = entry.request.method;
  const status = entry.response.status;
  const mapKey = `${method} ${path}`;

  if (!endpointMap.has(mapKey)) {
    endpointMap.set(mapKey, {
      method, path, origin,
      statuses:      new Set(),
      queryKeys:     new Set(),
      authHeaders:   new Set(),
      authQueryKeys: new Set(),
      schemas:       [],
    });
  }

  const ep = endpointMap.get(mapKey);
  ep.statuses.add(status);
  // クエリキー名のみ記録（値は記録しない）
  queryKeys.forEach(k => ep.queryKeys.add(k));
  // 認証クエリキー検出
  detectAuthQueryKeys(queryKeys).forEach(k => ep.authQueryKeys.add(k));
  // 認証ヘッダー種別
  detectAuthHeaders(entry.request.headers).forEach(a => ep.authHeaders.add(a));

  // レスポンス JSON スキーマ（2件まで、rawデータは保持しない）
  if (ep.schemas.length < 2) {
    const ct = entry.response.content?.mimeType || '';
    if (ct.includes('json')) {
      try {
        const text = entry.response.content?.text;
        if (text) {
          const json = JSON.parse(text);
          ep.schemas.push(extractSchema(json));
        }
      } catch { /* ignore */ }
    }
  }
}

// ── カタログ関連キー判定 ──────────────────────────────────────────────────────
const CATALOG_KEYWORDS = [
  'upc', 'ean', 'isrc', 'release', 'track', 'album', 'artist', 'genre',
  'label', 'catalog', 'p_line', 'c_line', 'pline', 'cline',
  'language', 'lock', 'artwork', 'cover', 'image', 'media',
  'status', 'scheduled', 'releasedate', 'totaltrack', 'tracknumber',
  'discnumber', 'version', 'title', 'barcode',
];

function catalogKeyHits(schema) {
  const s = schema.toLowerCase();
  return [...new Set(CATALOG_KEYWORDS.filter(k => s.includes(k)))];
}

// ── Pagination 検出（pageSize / pageNumber 含む） ─────────────────────────────
const PAGINATION_KEYS = new Set([
  'page', 'pagenumber', 'pagesize', 'limit', 'offset',
  'cursor', 'per_page', 'size', 'skip', 'take',
]);

function hasPagination(queryKeys) {
  return [...queryKeys].some(k => PAGINATION_KEYS.has(k.toLowerCase()));
}

// ── レポート生成 ──────────────────────────────────────────────────────────────
const lines = [];
const sep = '='.repeat(72);

lines.push(sep);
lines.push('SOUNDROP NETWORK AUDIT — エンドポイント一覧');
lines.push(`HARファイル: ${basename(harPath)}`);
lines.push(`解析日時: ${new Date().toISOString()}`);
lines.push(`出力先: ${basename(outPath)}  ※ 入力ファイルとは別ファイル`);
lines.push(sep);
lines.push('');

const getEps   = [...endpointMap.values()].filter(ep => ep.method === 'GET');
const otherEps = [...endpointMap.values()].filter(ep => ep.method !== 'GET');

// ── ★ カタログ重要エンドポイントを先頭に表示 ──────────────────────────────────
const PRIORITY_PATHS = new Set([
  '/content/release/all', '/content/track/all',
  '/content/release', '/content/track/lookups',
  '/content/musicProduct/all', '/distribution/store/all',
  '/finance/analytics/sales/grouped', '/account/user',
]);

const priorityEps = getEps.filter(ep => PRIORITY_PATHS.has(ep.path));
const otherGetEps = getEps.filter(ep => !PRIORITY_PATHS.has(ep.path));

lines.push(`[★ カタログ重要エンドポイント: ${priorityEps.length}件]`);
lines.push('');
for (const ep of priorityEps) renderEndpoint(ep);

lines.push(`[その他 GET エンドポイント: ${otherGetEps.length}件]`);
lines.push('');
for (const ep of otherGetEps) renderEndpoint(ep);

if (otherEps.length > 0) {
  lines.push(`[非GETエンドポイント（参考）: ${otherEps.length}件]`);
  for (const ep of otherEps) {
    lines.push(`  ${ep.method} ${ep.path}  Status: ${[...ep.statuses].join(', ')}`);
  }
  lines.push('');
}

// ── Pagination まとめ ─────────────────────────────────────────────────────────
lines.push('[Pagination 検出]');
const paginatedEps = [...endpointMap.values()].filter(ep => hasPagination(ep.queryKeys));
if (paginatedEps.length > 0) {
  for (const ep of paginatedEps) {
    const pkeys = [...ep.queryKeys].filter(k => PAGINATION_KEYS.has(k.toLowerCase()));
    lines.push(`  ${ep.method} ${ep.path}`);
    lines.push(`    pagination params: ${pkeys.join(', ')}`);
  }
} else {
  lines.push('  検出なし');
}
lines.push('');

// ── 認証まとめ ────────────────────────────────────────────────────────────────
lines.push('[認証方式まとめ]');
const allAuthHeaders = new Set([...endpointMap.values()].flatMap(ep => [...ep.authHeaders]));
const allAuthQuery   = new Set([...endpointMap.values()].flatMap(ep => [...ep.authQueryKeys]));

if (allAuthHeaders.size > 0) {
  [...allAuthHeaders].forEach(a => lines.push(`  Header: ${a}`));
}
if (allAuthQuery.size > 0) {
  [...allAuthQuery].forEach(k => lines.push(`  Query Token: ${k} （値は非表示）`));
}
if (allAuthHeaders.size === 0 && allAuthQuery.size === 0) {
  lines.push('  認証方式未検出（HARに認証リクエストが含まれていない可能性）');
}
lines.push('');

lines.push(sep);

// ── エンドポイント描画関数 ────────────────────────────────────────────────────
function renderEndpoint(ep) {
  const hits = ep.schemas.flatMap(s => catalogKeyHits(s));
  const mark = hits.length > 0 ? '★' : ' ';
  lines.push(`${mark} GET ${ep.path}`);
  lines.push(`  Status: ${[...ep.statuses].join(', ')}`);

  const nonAuthQueryKeys = [...ep.queryKeys].filter(k => !AUTH_QUERY_KEYS.has(k.toLowerCase()));
  if (nonAuthQueryKeys.length > 0) lines.push(`  Query params: ${nonAuthQueryKeys.join(', ')}`);
  if (ep.authQueryKeys.size > 0)   lines.push(`  Query Token: あり（値は非表示）`);
  if (ep.authHeaders.size > 0)     lines.push(`  Auth Header: ${[...ep.authHeaders].join(', ')}`);
  if (hasPagination(ep.queryKeys)) {
    const pkeys = [...ep.queryKeys].filter(k => PAGINATION_KEYS.has(k.toLowerCase()));
    lines.push(`  Pagination: ${pkeys.join(', ')}`);
  }
  if (hits.length > 0) lines.push(`  カタログキー: ${hits.join(', ')}`);
  if (ep.schemas.length > 0) {
    lines.push(`  Response schema:`);
    ep.schemas.forEach((s, i) => {
      lines.push(`    [${i+1}] ${s.slice(0, 400)}`);
    });
  }
  lines.push('');
}

// ── 出力 ─────────────────────────────────────────────────────────────────────
const report = lines.join('\n');
console.log(report);

try {
  writeFileSync(outPath, report, 'utf8');
  console.log(`\nレポート保存: ${outPath}`);
} catch (e) {
  console.error('レポート保存失敗:', e.message);
}
