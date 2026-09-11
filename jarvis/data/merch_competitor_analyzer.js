/**
 * jarvis/data/merch_competitor_analyzer.js
 * 商品自動分類・買付け上限計算
 *
 * 外部通信: なし（辞書/正規表現ベースの純粋関数）
 */

'use strict';

// ─── ブランド辞書（正規化マッピング） ─────────────────────────────────────────
// キー: 正規化ブランド名  値: 入力テキストにマッチする正規表現パターン配列

const BRAND_MAP = [
  // ラルフ ローレン 系
  { normalized: 'ラルフローレン系', patterns: [
    /ラルフ\s*ローレン/i, /ralph\s*lauren/i, /ポロ\s*ラルフ/i,
    /polo\s*ralph/i, /ローレン\s*ラルフ/i,
  ]},
  // バーバリー
  { normalized: 'バーバリー', patterns: [
    /バーバリー/i, /burberry/i,
  ]},
  // グッチ
  { normalized: 'グッチ', patterns: [
    /グッチ/i, /gucci/i,
  ]},
  // シャネル
  { normalized: 'シャネル', patterns: [
    /シャネル/i, /chanel/i,
  ]},
  // ルイ ヴィトン
  { normalized: 'ルイヴィトン', patterns: [
    /ルイ\s*ヴィトン/i, /louis\s*vuitton/i, /lv\b/i,
  ]},
  // エルメス
  { normalized: 'エルメス', patterns: [
    /エルメス/i, /hermes/i, /hermès/i,
  ]},
  // プラダ
  { normalized: 'プラダ', patterns: [
    /プラダ/i, /prada/i,
  ]},
  // コーチ
  { normalized: 'コーチ', patterns: [
    /コーチ/i, /coach/i,
  ]},
  // マイケルコース
  { normalized: 'マイケルコース', patterns: [
    /マイケル\s*コース/i, /michael\s*kors/i,
  ]},
  // ユニクロ
  { normalized: 'ユニクロ', patterns: [
    /ユニクロ/i, /uniqlo/i,
  ]},
  // GU
  { normalized: 'GU', patterns: [
    /\bGU\b/i, /ジーユー/i,
  ]},
  // ザラ
  { normalized: 'ZARA', patterns: [
    /\bzara\b/i, /ザラ/i,
  ]},
  // H&M
  { normalized: 'H&M', patterns: [
    /h\s*&\s*m/i, /エイチアンドエム/i,
  ]},
  // ナイキ
  { normalized: 'ナイキ', patterns: [
    /ナイキ/i, /\bnike\b/i,
  ]},
  // アディダス
  { normalized: 'アディダス', patterns: [
    /アディダス/i, /adidas/i,
  ]},
  // ノーブランド
  { normalized: 'ノーブランド', patterns: [
    /ノー\s*ブランド/i, /no\s*brand/i, /ブランドなし/i,
  ]},
];

// ─── カテゴリ辞書 ──────────────────────────────────────────────────────────────

const CATEGORY_MAP = [
  { normalized: 'トップス', patterns: [
    /トップ[スズ]/i, /シャツ/i, /ブラウス/i, /カットソー/i,
    /Tシャツ/i, /ポロシャツ/i, /ニット/i, /セーター/i, /スウェット/i,
    /パーカー/i, /カーディガン/i, /shirt/i, /blouse/i, /sweater/i,
  ]},
  { normalized: 'ボトムス', patterns: [
    /ボトムス/i, /パンツ/i, /スカート/i, /デニム/i, /ジーンズ/i,
    /shorts/i, /スラックス/i, /チノ/i, /legging/i,
  ]},
  { normalized: 'アウター', patterns: [
    /アウター/i, /コート/i, /ジャケット/i, /ブルゾン/i,
    /ダウン/i, /トレンチ/i, /coat/i, /jacket/i, /blazer/i,
  ]},
  { normalized: 'ワンピース', patterns: [
    /ワンピース/i, /ドレス/i, /dress/i,
  ]},
  { normalized: 'バッグ', patterns: [
    /バッグ/i, /ハンドバッグ/i, /トートバッグ/i, /ショルダーバッグ/i,
    /リュック/i, /ポーチ/i, /bag/i, /tote/i, /shoulder/i, /backpack/i,
  ]},
  { normalized: 'シューズ', patterns: [
    /シューズ/i, /スニーカー/i, /パンプス/i, /サンダル/i,
    /ブーツ/i, /ローファー/i, /shoes/i, /sneaker/i, /boots/i,
  ]},
  { normalized: 'アクセサリー', patterns: [
    /アクセサリー/i, /ネックレス/i, /リング/i, /指輪/i, /イヤリング/i,
    /ピアス/i, /ブレスレット/i, /ベルト/i, /スカーフ/i,
    /necklace/i, /ring/i, /earring/i, /bracelet/i,
  ]},
  { normalized: '帽子', patterns: [
    /帽子/i, /キャップ/i, /ハット/i, /ベレー帽/i, /cap/i, /hat/i, /beanie/i,
  ]},
  { normalized: '財布', patterns: [
    /財布/i, /ウォレット/i, /wallet/i, /purse/i,
  ]},
];

// ─── カラー辞書 ───────────────────────────────────────────────────────────────

const COLOR_MAP = [
  { normalized: 'ホワイト', patterns: [/白/i, /ホワイト/i, /white/i, /オフホワイト/i] },
  { normalized: 'ブラック', patterns: [/黒/i, /ブラック/i, /black/i] },
  { normalized: 'グレー',   patterns: [/グレ[ー|]/i, /灰/i, /gray/i, /grey/i] },
  { normalized: 'ネイビー', patterns: [/ネイビー/i, /紺/i, /navy/i] },
  { normalized: 'ブルー',   patterns: [/青/i, /ブルー/i, /blue/i, /水色/i] },
  { normalized: 'レッド',   patterns: [/赤/i, /レッド/i, /red/i, /レッド系/i] },
  { normalized: 'ピンク',   patterns: [/ピンク/i, /pink/i] },
  { normalized: 'グリーン', patterns: [/緑/i, /グリーン/i, /green/i, /カーキ/i, /khaki/i] },
  { normalized: 'ブラウン', patterns: [/茶/i, /ブラウン/i, /brown/i, /キャメル/i, /camel/i] },
  { normalized: 'ベージュ', patterns: [/ベージュ/i, /beige/i, /生成り/i] },
  { normalized: 'イエロー', patterns: [/黄/i, /イエロー/i, /yellow/i] },
  { normalized: 'オレンジ', patterns: [/橙/i, /オレンジ/i, /orange/i] },
  { normalized: 'パープル', patterns: [/紫/i, /パープル/i, /purple/i, /violet/i, /ラベンダー/i] },
  { normalized: 'マルチ',   patterns: [/マルチ/i, /multi/i, /柄/i, /総柄/i] },
];

// ─── シーズン辞書 ─────────────────────────────────────────────────────────────

const SEASON_MAP = [
  { normalized: '春夏', patterns: [/春|夏|spring|summer|ss/i, /薄手/i, /半袖/i, /リネン/i] },
  { normalized: '秋冬', patterns: [/秋|冬|fall|autumn|winter|aw/i, /厚手/i, /フリース/i, /ウール/i, /ダウン/i] },
  { normalized: 'オールシーズン', patterns: [/オールシーズン/i, /all.season/i, /通年/i] },
];

// ─── 性別辞書 ────────────────────────────────────────────────────────────────

const GENDER_MAP = [
  { normalized: 'male',   patterns: [/メンズ/i, /men'?s/i, /男性/i, /男の子/i] },
  { normalized: 'female', patterns: [/レディース/i, /ladies/i, /women'?s/i, /女性/i, /女の子/i] },
  { normalized: 'unisex', patterns: [/ユニセックス/i, /unisex/i, /性別なし/i, /男女兼用/i] },
];

// ─── 分類ロジック ─────────────────────────────────────────────────────────────

/**
 * テキストに最初にマッチするマップエントリを返す。
 * @param {Array<{normalized: string, patterns: RegExp[]}>} map
 * @param {string} text
 * @returns {string|null}
 */
function matchFirst(map, text) {
  if (!text) return null;
  for (const entry of map) {
    for (const re of entry.patterns) {
      if (re.test(text)) return entry.normalized;
    }
  }
  return null;
}

/**
 * 商品を自動分類する。
 * @param {object} item - DB の merch_competitor_items 行（またはスクレイパー出力）
 * @returns {{ classified_brand, classified_category, classified_color,
 *             classified_season, classified_target }}
 */
export function classifyItem(item) {
  const searchBrand    = [item.brand, item.name].filter(Boolean).join(' ');
  const searchCategory = [item.category, item.name].filter(Boolean).join(' ');
  const searchColor    = [item.color, item.name].filter(Boolean).join(' ');
  const searchSeason   = [item.name, item.category].filter(Boolean).join(' ');
  const searchGender   = [item.target_gender, item.category, item.name].filter(Boolean).join(' ');

  return {
    classified_brand:    matchFirst(BRAND_MAP,    searchBrand),
    classified_category: matchFirst(CATEGORY_MAP, searchCategory),
    classified_color:    matchFirst(COLOR_MAP,    searchColor),
    classified_season:   matchFirst(SEASON_MAP,   searchSeason),
    classified_target:   matchFirst(GENDER_MAP,   searchGender) ?? item.target_gender ?? null,
  };
}

// ─── 買付け上限計算 ───────────────────────────────────────────────────────────

/**
 * 売却済み価格一覧の中央値を計算する。
 * @param {number[]} prices
 * @returns {number|null} 中央値（空の場合は null）
 */
export function calcMedian(prices) {
  if (!prices || prices.length === 0) return null;
  const sorted = [...prices].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[mid - 1] + sorted[mid]) / 2)
    : sorted[mid];
}

/**
 * 買付け上限価格を計算する。
 *   limit = floor100(medianSoldPrice × (1 - fee_rate) - shipping - min_profit)
 *
 * @param {number} medianSoldPrice - 中央値売却価格
 * @param {{ fee_rate?: number, shipping_cost?: number, min_profit?: number }} settings
 * @returns {number|null} 買付け上限（計算できない場合は null）
 */
export function calcBuyingLimit(medianSoldPrice, settings = {}) {
  if (!medianSoldPrice || medianSoldPrice <= 0) return null;
  const feeRate  = parseFloat(settings.fee_rate     ?? 0.10);
  const shipping = parseInt(settings.shipping_cost  ?? 600,  10);
  const minProfit = parseInt(settings.min_profit    ?? 2000, 10);

  const limit = medianSoldPrice * (1 - feeRate) - shipping - minProfit;
  if (limit <= 0) return null;

  // 100円単位に切り捨て
  return Math.floor(limit / 100) * 100;
}

// ─── 信頼度判定 ───────────────────────────────────────────────────────────────

/**
 * サンプル数から信頼度を返す。
 * @param {number} count
 * @param {{ confidence_high_min?: number, confidence_med_min?: number }} settings
 * @returns {'high'|'medium'|'low'}
 */
export function getConfidence(count, settings = {}) {
  const highMin = parseInt(settings.confidence_high_min ?? 10, 10);
  const medMin  = parseInt(settings.confidence_med_min  ??  3, 10);
  if (count >= highMin) return 'high';
  if (count >= medMin)  return 'medium';
  return 'low';
}

// ─── バッチ分類 ───────────────────────────────────────────────────────────────

/**
 * DB から未分類アイテムを取得して分類し、買付け上限を計算する。
 * manager の updateItemClassification を呼ぶため db と manager が必要。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} accountId
 * @param {object} settings - merch_analysis_settings から取得したオブジェクト
 * @param {Function} updateFn - manager.updateItemClassification
 * @returns {number} 処理件数
 */
export function batchClassify(db, accountId, settings, updateFn) {
  const items = db.prepare(`
    SELECT i.*, o.override_brand, o.override_category, o.override_color,
           o.override_season, o.override_target
      FROM merch_competitor_items i
      LEFT JOIN merch_classification_overrides o ON o.item_id = i.id
     WHERE i.account_id = ?
  `).all(accountId);

  let count = 0;
  for (const item of items) {
    // 手動オーバーライドを優先
    const cls = classifyItem(item);
    if (item.override_brand)    cls.classified_brand    = item.override_brand;
    if (item.override_category) cls.classified_category = item.override_category;
    if (item.override_color)    cls.classified_color    = item.override_color;
    if (item.override_season)   cls.classified_season   = item.override_season;
    if (item.override_target)   cls.classified_target   = item.override_target;

    // 売却済み価格から中央値を計算して買付け上限を設定
    const soldPrices = db.prepare(`
      SELECT price FROM merch_competitor_items
       WHERE account_id = ? AND status = 'sold'
         AND classified_brand = ?
       LIMIT 50
    `).all(accountId, cls.classified_brand ?? '__none__').map(r => r.price);

    const median = calcMedian(soldPrices);
    const buyingLimit = median ? calcBuyingLimit(median, settings) : null;
    const confidence  = getConfidence(soldPrices.length, settings);

    updateFn(db, item.id, { ...cls, buying_limit: buyingLimit, classification_confidence: confidence });
    count++;
  }
  return count;
}
