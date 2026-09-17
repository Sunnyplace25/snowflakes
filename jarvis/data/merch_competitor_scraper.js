/**
 * jarvis/data/merch_competitor_scraper.js
 * Playwright版 メルカリセラースクレイパー（APIインターセプト方式）
 *
 * 取得方式:
 *   Playwright で通常のプロフィール閲覧を行い、ブラウザ自身が受信する
 *   /items/get_items レスポンスを page.on('response', ...) でインターセプトする。
 *   DOM 仮想スクロールの影響を受けず、全件を重複なく安定取得できる。
 *
 * ページネーション:
 *   max_pager_id カーソル方式。「もっと見る」クリックごとに 1 API コール。
 *   meta.has_next=false またはボタン消失で終了。
 *
 * status マッピング（スクレイパーは API 生値を返す）:
 *   API: on_sale  → scraper: 'on_sale'
 *   API: trading  → scraper: 'trading'
 *   API: sold_out → scraper: 'sold_out'
 *   ※ sold_out → sold へのマッピングは manager 側で行う
 *
 * 認証情報・Cookie・トークンの抽出・再利用なし。
 * 通常ブラウジング中にブラウザが受信したレスポンスの観察のみ。
 */

import { chromium } from 'playwright';

const PROFILE_BASE = 'https://jp.mercari.com/user/profile/';

// ─── ユーティリティ ────────────────────────────────────────────────────────────

/**
 * ブラウザを起動し、処理後に必ずクローズする共通ラッパー。
 * @template T
 * @param {(page: import('playwright').Page) => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withBrowser(fn) {
  const browser = await chromium.launch({ headless: false });
  try {
    const context = await browser.newContext({
      locale: 'ja-JP',
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) ' +
        'AppleWebKit/537.36 (KHTML, like Gecko) ' +
        'Chrome/125.0.0.0 Safari/537.36',
    });
    const page = await context.newPage();
    return await fn(page);
  } finally {
    await browser.close();
  }
}

/**
 * Unix timestamp（秒）を JST の日時文字列 (YYYY-MM-DD HH:MM:SS) に変換する。
 * null / undefined / 0 の場合は null を返す。
 * @param {number|null|undefined} ts
 * @returns {string|null}
 */
function unixToJst(ts) {
  if (!ts) return null;
  const d = new Date(ts * 1000);
  const jst = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * /items/get_items レスポンスから商品配列を抽出する。
 * @param {object} body
 * @returns {object[]}
 */
function extractItemsFromBody(body) {
  if (Array.isArray(body?.data))  return body.data;
  if (Array.isArray(body?.items)) return body.items;
  for (const key of Object.keys(body ?? {})) {
    if (Array.isArray(body[key])) return body[key];
  }
  return [];
}

/**
 * API レスポンス生アイテムを正規化して返す。
 * status は API 生値のまま返す（on_sale / trading / sold_out）。
 * @param {object} raw
 * @returns {{
 *   mercari_item_id: string,
 *   name: string|null,
 *   price: number,
 *   status: 'on_sale'|'trading'|'sold_out',
 *   image_url: string|null,
 *   brand: string|null,
 *   category: string|null,
 *   created_api: string|null,
 *   updated_api: string|null,
 *   num_likes: number|null,
 *   num_comments: number|null,
 *   shipping_from_area: string|null,
 *   is_archived: number,
 * }|null}
 */
function normalizeItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const itemId = String(raw.id ?? '');
  if (!itemId || !/^(m\d+|\d{6,})$/.test(itemId)) return null;

  return {
    mercari_item_id:    itemId,
    name:               raw.name ?? null,
    price:              typeof raw.price === 'number' ? raw.price : 0,
    status:             raw.status ?? 'on_sale',
    image_url:          Array.isArray(raw.thumbnails) && raw.thumbnails.length > 0
                          ? raw.thumbnails[0] : null,
    brand:              raw.item_brand?.name ?? null,
    category:           raw.item_category?.name ?? null,
    created_api:        unixToJst(raw.created),
    updated_api:        unixToJst(raw.updated),
    num_likes:          typeof raw.num_likes    === 'number' ? raw.num_likes    : null,
    num_comments:       typeof raw.num_comments === 'number' ? raw.num_comments : null,
    shipping_from_area: raw.shipping_from_area?.name ?? raw.shipping_from_area ?? null,
    is_archived:        raw.is_archived ? 1 : 0,
    is_auction:         raw.auction_info != null ? 1 : 0,
  };
}

// ─── 公開 API ──────────────────────────────────────────────────────────────────

/**
 * セラー表示名を取得する。
 * 取得できない場合は null を返す（エラーをスローしない）。
 *
 * @param {string} mercariUserId
 * @returns {Promise<string|null>}
 */
export async function fetchSellerName(mercariUserId) {
  return withBrowser(async (page) => {
    try {
      await page.goto(`${PROFILE_BASE}${mercariUserId}`, {
        waitUntil: 'domcontentloaded',
        timeout: 30000,
      });
      const name = await page.evaluate(() => {
        const candidates = [
          document.querySelector('[data-testid="profile-name"]'),
          document.querySelector('[class*="userName"]'),
          document.querySelector('[class*="user-name"]'),
          document.querySelector('h1'),
        ];
        for (const el of candidates) {
          const t = el?.textContent?.trim();
          if (t) return t;
        }
        return null;
      });
      return name;
    } catch {
      return null;
    }
  });
}

/**
 * セラーの全商品を /items/get_items インターセプトで取得して返す。
 *
 * 取得方式:
 *   通常のプロフィールページ閲覧 + 「もっと見る」クリックを繰り返し、
 *   ブラウザが受信した /items/get_items レスポンスを蓄積する。
 *
 * 正常完了判定:
 *   APIレスポンス内の meta.has_next=false を受信した場合のみ scanComplete=true。
 *   「もっと見る」ボタン消失のみでは正常完了と判定しない。
 *   has_next=true のままボタン消失・タイムアウトが発生した場合は
 *   scanComplete=false（incomplete）となる。
 *
 * セラー名も同一ブラウザセッション内で取得して返す（fetchSellerName の別ブラウザ起動が不要）。
 *
 * @param {string} mercariUserId
 * @param {number} [maxItems=0] - 0 = 無制限
 * @returns {Promise<{
 *   items: Array<{
 *     mercari_item_id: string,
 *     name: string|null,
 *     price: number,
 *     status: 'on_sale'|'trading'|'sold_out',
 *     image_url: string|null,
 *     brand: string|null,
 *     category: string|null,
 *     created_api: string|null,
 *     updated_api: string|null,
 *     num_likes: number|null,
 *     num_comments: number|null,
 *     shipping_from_area: string|null,
 *     is_archived: number,
 *   }>,
 *   scanComplete: boolean,
 *   incompleteReason: string|null,
 *   sellerName: string|null,
 * }>}
 */
export async function fetchSellerItems(mercariUserId, maxItems = 0) {
  const url = `${PROFILE_BASE}${mercariUserId}`;
  console.log(`[scraper] 開始 (APIインターセプト方式): ${url}`);

  return withBrowser(async (page) => {
    const items = new Map();   // mercari_item_id → item
    let callCount       = 0;
    let dupCount        = 0;
    let hasNextFalseSeen = false;  // meta.has_next=false を受信したか

    // /items/get_items レスポンスをインターセプト
    page.on('response', async (response) => {
      if (!response.url().includes('/items/get_items')) return;
      if (response.status() < 200 || response.status() >= 300) return;

      let body;
      try { body = await response.json(); } catch { return; }

      callCount++;

      // スキャン完了判定: meta.has_next=false を確認
      if (body?.meta?.has_next === false) {
        hasNextFalseSeen = true;
      }

      const rawItems = extractItemsFromBody(body);

      for (const raw of rawItems) {
        const item = normalizeItem(raw);
        if (!item) continue;
        if (items.has(item.mercari_item_id)) {
          dupCount++;
        } else {
          items.set(item.mercari_item_id, item);
        }
        // maxItems チェック（0 = 無制限）
        if (maxItems > 0 && items.size >= maxItems) break;
      }

      if (callCount % 10 === 0 || callCount <= 3) {
        console.log(`[scraper] call#${callCount} 累計=${items.size}件 (dup=${dupCount})`);
      }
    });

    // ページ読み込み
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });

    // セラー名を同一セッションで取得（fetchSellerName の別ブラウザ起動が不要になる）
    let sellerName = null;
    try {
      sellerName = await page.evaluate(() => {
        const candidates = [
          document.querySelector('[data-testid="profile-name"]'),
          document.querySelector('[class*="userName"]'),
          document.querySelector('[class*="user-name"]'),
          document.querySelector('h1'),
        ];
        for (const el of candidates) {
          const t = el?.textContent?.trim();
          if (t) return t;
        }
        return null;
      });
    } catch { /* 取得失敗は無視 */ }

    await page.waitForSelector("[data-testid='item-cell']", { timeout: 30000 }).catch(() => {});
    await page.waitForTimeout(1500);

    // 「もっと見る」ボタンロケーター
    const moreBtnLoc = page
      .locator("button:not([data-testid='show-more-toggle'])")
      .filter({ hasText: 'もっと見る' })
      .first();

    let clickCount = 0;
    let stopReason = null;

    while (true) {
      // maxItems 到達チェック
      if (maxItems > 0 && items.size >= maxItems) {
        stopReason = `maxItems(${maxItems})到達`;
        console.log(`[scraper] maxItems(${maxItems})到達 → 終了`);
        break;
      }

      await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
      await page.waitForTimeout(800);

      const visible = await moreBtnLoc.isVisible().catch(() => false);
      if (!visible) {
        stopReason = `「もっと見る」ボタン消失 (click=${clickCount})`;
        console.log(`[scraper] 「もっと見る」ボタンなし → 終了 (click=${clickCount})`);
        break;
      }

      await moreBtnLoc.click();
      clickCount++;
      await page.waitForTimeout(1500);
    }

    // 最後の API レスポンスが届くまで少し待つ
    await page.waitForTimeout(1500);

    const result = Array.from(items.values());
    const onSale   = result.filter(i => i.status === 'on_sale').length;
    const trading  = result.filter(i => i.status === 'trading').length;
    const soldOut  = result.filter(i => i.status === 'sold_out').length;

    const scanComplete = hasNextFalseSeen;
    const incompleteReason = scanComplete
      ? null
      : `has_next=false 未確認（${stopReason ?? '理由不明'}で終了）`;

    console.log(
      `[scraper] 取得${scanComplete ? '完了' : '不完全'}: ${result.length}件` +
      ` (on_sale=${onSale}, trading=${trading}, sold_out=${soldOut})` +
      ` APIコール=${callCount}, dup排除=${dupCount}` +
      (scanComplete ? '' : ` [INCOMPLETE: ${incompleteReason}]`)
    );

    return { items: result, scanComplete, incompleteReason, sellerName };
  });
}
