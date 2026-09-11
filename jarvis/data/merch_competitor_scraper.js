/**
 * jarvis/data/merch_competitor_scraper.js
 * メルカリ競合アカウントスクレイパー
 *
 * SSRF 防止:
 *   - 受け付けるプロフィール URL は https://jp.mercari.com/user/profile/{digits} のみ
 *   - 外部 HTTP リクエストは api.mercari.jp エンドポイントのみ
 *   - userId は数字のみ（正規表現で検証）
 *
 * 外部通信: api.mercari.jp（スキャン実行時のみ）
 */

import { createRequire } from 'node:module';

// node:https / node:http を使用して外部依存なしで fetch
// Node 18+ では globalThis.fetch が利用可能だが、互換性のため node:https を使う
import https from 'node:https';

// ─── SSRF 防止ユーティリティ ──────────────────────────────────────────────────

const PROFILE_URL_RE = /^https:\/\/jp\.mercari\.com\/user\/profile\/(\d+)$/;
const USER_ID_RE     = /^\d+$/;

/**
 * プロフィール URL を検証し、userId を返す。
 * @param {string} profileUrl
 * @returns {string} userId（数字のみ）
 * @throws {Error} URL が不正な場合
 */
export function extractUserIdFromProfileUrl(profileUrl) {
  const m = PROFILE_URL_RE.exec(profileUrl);
  if (!m) throw new Error(`不正なプロフィール URL: ${profileUrl}`);
  return m[1];
}

/**
 * userId の安全性を確認する。数字のみ許可。
 * @param {string} userId
 * @throws {Error}
 */
export function validateUserId(userId) {
  if (!USER_ID_RE.test(userId)) {
    throw new Error(`不正な userId（数字のみ許可）: ${userId}`);
  }
}

// ─── HTTP ヘルパー ────────────────────────────────────────────────────────────

/**
 * HTTPS POST リクエスト（JSON）を送信して JSON レスポンスを返す。
 * @param {string} url
 * @param {object} payload
 * @param {object} headers
 * @returns {Promise<object>}
 */
function httpsPost(url, payload, headers = {}) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const parsed = new URL(url);

    const options = {
      hostname: parsed.hostname,
      path:     parsed.pathname + parsed.search,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(body),
        ...headers,
      },
      timeout: 30_000,
    };

    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          const text = Buffer.concat(chunks).toString('utf8');
          resolve({ status: res.statusCode, data: JSON.parse(text) });
        } catch (e) {
          reject(new Error(`JSON parse error: ${e.message}`));
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('request timeout')); });
    req.write(body);
    req.end();
  });
}

// ─── メルカリ API ─────────────────────────────────────────────────────────────

const MERCARI_SEARCH_URL = 'https://api.mercari.jp/v2/entities:search';

// リクエストヘッダー（ブラウザエミュレーション）
const BASE_HEADERS = {
  'Accept':          'application/json, text/plain, */*',
  'Accept-Language': 'ja,en;q=0.9',
  'Origin':          'https://jp.mercari.com',
  'Referer':         'https://jp.mercari.com/',
  'X-Platform':      'web',
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36',
};

/**
 * メルカリ出品商品一覧を取得する。
 * ページネーション対応（最大 maxItems 件）。
 *
 * @param {string} userId - 数字のみの seller ID
 * @param {number} [maxItems=300]
 * @returns {Promise<object[]>} - 商品の配列
 */
export async function fetchSellerItems(userId, maxItems = 300) {
  validateUserId(userId);

  const items = [];
  let pageToken = '';
  const pageSize = 120; // API の最大ページサイズ

  while (items.length < maxItems) {
    const payload = {
      userId,
      status:   'STATUS_TRADING_AND_TRADED', // 出品中 + 取引中 + 売却済み
      pageSize: Math.min(pageSize, maxItems - items.length),
      ...(pageToken ? { pageToken } : {}),
    };

    let resp;
    try {
      resp = await httpsPost(MERCARI_SEARCH_URL, payload, BASE_HEADERS);
    } catch (err) {
      throw new Error(`メルカリ API リクエスト失敗: ${err.message}`);
    }

    if (resp.status !== 200) {
      throw new Error(`メルカリ API エラー: HTTP ${resp.status}`);
    }

    const data = resp.data;
    const rawItems = data.items ?? data.data?.items ?? [];

    for (const raw of rawItems) {
      items.push(parseItem(raw));
    }

    pageToken = data.nextPageToken ?? '';
    if (!pageToken || rawItems.length === 0) break;
  }

  return items;
}

/**
 * メルカリ API の商品オブジェクトを正規化する。
 * @param {object} raw
 * @returns {object}
 */
function parseItem(raw) {
  const statusMap = {
    'ITEM_STATUS_ON_SALE':   'on_sale',
    'ITEM_STATUS_SOLD_OUT':  'sold',
    'ITEM_STATUS_TRADING':   'on_sale',  // 取引中は on_sale として扱う
    'ITEM_STATUS_STOP':      'missing',
    'ITEM_STATUS_CANCEL':    'missing',
    'ITEM_STATUS_PACKING':   'sold',
    'ITEM_STATUS_SHIPPED':   'sold',
  };

  const status = statusMap[raw.status] ?? 'unknown';
  const price  = parseInt(raw.price?.amount ?? raw.price ?? 0, 10);

  return {
    mercari_item_id: String(raw.id),
    name:            raw.name ?? '（不明）',
    price,
    status,
    brand:           raw.itemBrand?.name ?? raw.brand ?? null,
    category:        raw.itemCategory?.name ?? raw.category ?? null,
    color:           extractColor(raw),
    material:        null,  // API v2 では詳細取得が必要
    size:            extractSize(raw),
    condition_text:  raw.itemCondition?.name ?? null,
    target_gender:   extractGender(raw),
    season:          null,
    image_url:       raw.thumbnails?.[0] ?? raw.thumbnail ?? null,
    raw_data:        raw,
  };
}

// ─── 属性抽出ヘルパー ─────────────────────────────────────────────────────────

function extractColor(raw) {
  if (raw.colors && raw.colors.length > 0) {
    return raw.colors.map(c => c.name ?? c).join('/');
  }
  return null;
}

function extractSize(raw) {
  return raw.itemSize?.name ?? raw.size ?? null;
}

function extractGender(raw) {
  const g = raw.itemTaxonomy?.name ?? raw.targetGender ?? '';
  if (/[男メンズmale]/i.test(g))  return 'male';
  if (/[女レディースfemale]/i.test(g)) return 'female';
  if (/[ユニセックスunisex]/i.test(g)) return 'unisex';
  return null;
}

// ─── セラー名取得 ─────────────────────────────────────────────────────────────

/**
 * セラー名を取得する（プロフィールページから）。
 * 取得失敗時は null を返す（必須でないため）。
 * @param {string} userId
 * @returns {Promise<string|null>}
 */
export async function fetchSellerName(userId) {
  validateUserId(userId);
  // API v2 には users endpoint がないため、検索結果の seller 情報から取得
  try {
    const resp = await httpsPost(MERCARI_SEARCH_URL, {
      userId,
      pageSize: 1,
    }, BASE_HEADERS);
    if (resp.status !== 200) return null;
    const items = resp.data.items ?? resp.data.data?.items ?? [];
    if (items.length > 0 && items[0].seller) {
      return items[0].seller.name ?? null;
    }
  } catch (_) { /* 失敗は無視 */ }
  return null;
}
