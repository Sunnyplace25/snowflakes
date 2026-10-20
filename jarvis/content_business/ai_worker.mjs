/**
 * content_business/ai_worker.mjs
 * 出版事業部 AI社員ワーカー
 * - 各ロール (Scout / Analyst / Planner / Writer / Editor / Growth) をClaude APIで実行
 * - プロンプトは prompts/*.md から読み込む（server.jsへの直書き禁止）
 * - 外部送信・公開は行わない
 *
 * Scout（ヒカゲ）は実際のWebフェッチで公開情報のみを取得します。
 * URLが登録されていない場合は架空データを生成せず明示的にエラーを返します。
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { fetchMultipleArticles, discoverNoteUrlsMulti } from './web_scraper.mjs';
import { callClaude as _callClaudeRouter } from '../shared/claude_router.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPTS_DIR = resolve(__dirname, '../prompts');
const CONFIG_PATH = resolve(__dirname, '../config/content_business.json');
const KOTORI_PROFILE_PATH = resolve(__dirname, '../config/kotori_public_profile.md');
const KOTORI_POLICY_PATH  = resolve(__dirname, '../config/kotori_editorial_policy.md');

let _config = null;
function getConfig() {
  if (!_config) _config = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  return _config;
}

function loadPrompt(filename) {
  const p = resolve(PROMPTS_DIR, filename);
  if (!existsSync(p)) throw new Error(`プロンプトファイルが見つかりません: ${p}`);
  return readFileSync(p, 'utf8');
}

// ── Kotoriコンテキスト（ロール別・選択式） ─────────────────────────────────────

/** 全AI社員共通の必須ルール（常時適用、~150 tokens）*/
const KOTORI_CORE = `## 山吹ことり 必須ルール（全AI社員共通）
- 職業名（保育士など具体的な職種）は記事・外部出力に絶対含めない
- 本人が提供していない体験・実績・数値・感情は書かない（捏造禁止）
- AIが小説本文を書いているという誤解を招く表現は使わない（AI＝設定管理ツール）
- 最終判断はすべて社長（山吹ことり）が行う`.trim();

/**
 * ロール別・山吹ことりコンテキスト（選択式ロード）
 *
 * @param {string} role - 'Scout'|'Analyst'|'Planner'|'Writer'|'Editor'|'Growth'
 * @param {object} opts
 * @param {boolean} opts.forMeeting - 会議モード: COREルール + role_guidance のみ（profile/policy省略）
 */
function loadKotoriContext(role = '', { forMeeting = false } = {}) {
  // ── ロール別使い方の指示 ────────────────────────────────────────────────────
  const ROLE_GUIDANCE = {
    Scout: `
## ヒカゲ（市場調査担当）のことりコンテキスト使用指針

【内部情報として使うこと】
- 山吹ことりの活動領域（小説・音楽・イラスト・Web・クロスメディア）を理解した上で、
  それらに関連する市場を調査すること。
- 調査対象クリエイターの選定時、「ことりと同じような活動をしている人」を基準にする。

【やってはいけないこと】
- 「AI副業」「AI自動収益化」「AI転売」など、本人の活動と無関係なジャンルへ勝手に寄せない。
- 調査結果に「こういう方向に転換すれば売れる」という誘導を含めない（それは分析・企画の仕事）。
- このコンテキストの内容を調査レポートの本文に出力しない。`,

    Analyst: `
## ヒノデ（市場分析担当）のことりコンテキスト使用指針

【内部情報として使うこと】
- 市場データを分析するとき、「山吹ことりのブランド軸」に照らして評価すること。
  ブランド軸：小説×音楽×イラスト×Webのクロスメディア、AI活用（設定管理）、作品世界の具現化。
- 「PVが取れるかどうか」だけで方向性を判断しない。
  ことりのブランドと合致しているか、長期的にブランドを強化するかも評価基準に含める。

【やってはいけないこと】
- 短期的なPV・売上だけでブランド方針の変更を提案しない。
- 「流行りだから」という理由だけでことりの活動領域外のテーマを推奨しない。
- このコンテキストの内容を分析レポートに直接出力しない。`,

    Planner: `
## アサヒ（企画担当）のことりコンテキスト使用指針

【内部情報・公開可両方として使うこと】
- 企画案は「市場性」と「山吹ことりらしさ」の両方を満たすこと。
- ことりが実際に持っている知識・体験・視点からしか語れない企画を優先する。
  （例：AIで設定管理している話、クロスメディアの話、生成曲を音楽的に仕上げる話）
- シリーズ「山吹ことりについて」の既存記事と内容が重複しないよう確認すること。

【やってはいけないこと】
- 本人が持っていない体験・実績をベースにした企画を出さない。
- 公開禁止情報（職業名など）を企画のセールスポイントにしない。`,

    Writer: `
## ソラ（記事執筆担当）のことりコンテキスト使用指針

【公開可情報のみ使うこと】
- プロフィールの「公開可」情報を使って記事を書く。
- プロフィールの「公開禁止情報」セクションに記載された情報は記事本文に絶対に含めない。

【内部情報として使うこと】
- 「どこまで書いてよいか」を判断する基準として使う。

【やってはいけないこと】
- 具体的な職業名（例：保育士など）を記事に含めない。
- AIが小説本文を書いているかのような表現を使わない。
- 本人が提供していない体験・感情・数字を作り出さない。
- 修正依頼時は指定箇所のみ変更し、他の内容は原文を保持する。`,

    Editor: `
## キイロ（編集担当）のことりコンテキスト使用指針

【内部情報として使うこと】
- 記事チェック時に「本人像と一致しているか」を確認する。
- AIと小説の関係（AI＝設定管理ツール。本文執筆ではない）が正確に伝わっているか確認する。

【編集チェック項目（必須）】
1. 公開禁止情報（職業名・個人情報など）が含まれていないか
2. 事実の補完・推測が行われていないか
3. AIに小説を書かせているという誤解を招く表現がないか
4. 本人が提供していない体験・感情・数字が含まれていないか
5. シリーズ内の他記事と同じ内容の繰り返しになっていないか

問題があれば REVISION_REQUIRED を返し、具体的な修正指示を記載すること。
問題なければ READY を返すこと。`,

    Growth: `
## アオ（グロース・成長分析担当）のことりコンテキスト使用指針

【内部情報として使うこと】
- 売上・PV・購入率などの数字を分析するとき、「山吹ことりのブランド戦略」を前提に置く。
- 数字が低くても、ブランド価値への貢献や長期的な意義があれば、それを評価に含める。

【やってはいけないこと】
- 短期的な数字だけを根拠に「方向性を変えるべき」と提案しない。
- ことりのブランド外のジャンル（AI副業、転売系など）への転換を提案しない。
- このコンテキストの内容を分析レポートに直接出力しない。`,
  };

  const guidance = ROLE_GUIDANCE[role] ?? `
## AI社員 共通コンテキスト
このプロフィールはあなたの業務判断に使う内部情報です。
記事本文には「公開可」の情報のみ使用し、「公開禁止情報」は絶対に含めないでください。`;

  // 会議モード: COREルール + role_guidance のみ（profile/policy省略）
  if (forMeeting) {
    return '\n\n---\n' + KOTORI_CORE + '\n\n' + guidance;
  }

  // 記事本文を直接書く・編集するロールだけフルプロフィールが必要
  const needsProfile = ['Writer', 'Editor'].includes(role);
  // 編集方針・構成ルールが必要なロール
  const needsPolicy  = ['Writer', 'Editor', 'Planner'].includes(role);

  // Scout / Analyst / Growth: COREとguidanceのみ（profile/policy省略）
  if (!needsProfile && !needsPolicy) {
    return '\n\n---\n' + KOTORI_CORE + '\n\n' + guidance;
  }

  const profile = existsSync(KOTORI_PROFILE_PATH) ? readFileSync(KOTORI_PROFILE_PATH, 'utf8') : null;
  const policy  = existsSync(KOTORI_POLICY_PATH)  ? readFileSync(KOTORI_POLICY_PATH,  'utf8') : null;

  const parts = ['---', '# 山吹ことりコンテキスト（出版事業部 内部情報）', '', KOTORI_CORE, '', guidance];
  if (needsProfile && profile) parts.push('\n---\n## 著者プロフィール\n' + profile);
  if (needsPolicy  && policy)  parts.push('\n---\n## 編集方針\n'      + policy);

  return '\n\n' + parts.join('\n');
}

/**
 * 承認済みナレッジをシステムプロンプトに注入するセクションを生成する。
 * @param {Array} knowledge - loadApprovedKnowledge() の戻り値
 * @returns {string}
 */
function buildKnowledgeContext(knowledge) {
  if (!knowledge || knowledge.length === 0) return '';

  const CATEGORY_LABELS = {
    FACT:           '【事実情報】',
    PRIVACY:        '【プライバシー保護】',
    STYLE:          '【表記ルール】',
    EDITORIAL_RULE: '【編集ルール】',
    ARTICLE_SPECIFIC: '【記事固有ルール】',
  };

  // カテゴリ別にグループ化
  const groups = {};
  for (const k of knowledge) {
    if (!groups[k.category]) groups[k.category] = [];
    groups[k.category].push(k.rule_text);
  }

  const lines = [
    '',
    '---',
    '# 山吹ことりナレッジ（本人承認済みルール）',
    '',
    '⚠️ 以下のルールは本人（山吹ことり）が確認・承認済みです。執筆・編集時に必ず遵守してください。',
  ];

  for (const [cat, rules] of Object.entries(groups)) {
    lines.push('');
    lines.push(CATEGORY_LABELS[cat] ?? `【${cat}】`);
    for (const rule of rules) lines.push(`- ${rule}`);
  }

  return '\n' + lines.join('\n');
}

/** Claude API 呼び出し — shared/claude_router.mjs 経由 */
async function callClaude(systemPrompt, userMessage, opts = {}) {
  return _callClaudeRouter(systemPrompt, userMessage, { domain: 'publishing', ...opts });
}

/**
 * ヒカゲ（Scout）: 登録されたURLから公開情報を実際にWebフェッチして構造化する
 *
 * ⚠️ URLが登録されていない場合は架空データを生成せず、明示的にエラーを返す。
 * ⚠️ 有料本文の取得は行わない。公開メタデータのみを対象とする。
 *
 * @param {{ existingUrls: string[], theme?: string, genre?: string, targetReader?: string, priceRange?: string }} opts
 * @returns {{ items: ArticleMetadata[], low_sample: boolean, count: number, no_urls?: boolean }}
 */
export async function runScout({ theme, genre, targetReader, priceRange, existingUrls = [], screeningTopics = [], maxUrls = 30, lightMode = false }) {
  let urls = [...existingUrls];

  // URL未登録の場合: note.com から自動探索（架空URL生成なし）
  if (urls.length === 0) {
    console.log(`[ヒカゲ] 手動URLなし → note.com から自動探索します（最大${maxUrls}件）`);
    const queries = screeningTopics.length > 0
      ? screeningTopics
      : [theme || genre || 'note クリエイター'].slice(0, 5);

    urls = await discoverNoteUrlsMulti(queries, { maxTotal: maxUrls, excludeUrls: [] });

    if (urls.length === 0) {
      // LIGHT モードは例外を投げずに noResults フラグで返す
      if (lightMode) {
        console.warn('[ヒカゲ] LIGHT: URL探索0件 → noResults で返します');
        return { items: [], noResults: true, low_sample: true, count: 0, fetch_summary: { total: 0, success: 0, failed: 0 } };
      }
      const err = new Error(
        'URL_DISCOVER_FAILED: note.com からの自動URL探索で0件しか取得できませんでした。\n' +
        'ネットワーク接続を確認するか、「調査URLを追加」から手動でURLを登録してください。'
      );
      err.code = 'URL_DISCOVER_FAILED';
      throw err;
    }
    console.log(`[ヒカゲ] 自動探索完了: ${urls.length}件のURLを取得しました`);
  }

  const urlsToFetch = urls.slice(0, maxUrls);

  // 実際にWebフェッチ（公開情報のみ）
  const fetchedItems = await fetchMultipleArticles(urlsToFetch, {
    onProgress: (done, total, url) => {
      console.log(`[ヒカゲ] 取得中 ${done}/${total}: ${url}`);
    },
  });

  // 取得成功件数
  const successItems = fetchedItems.filter(i => i.fetch_ok !== false);
  const failedItems  = fetchedItems.filter(i => i.fetch_ok === false);

  if (failedItems.length > 0) {
    console.warn(`[ヒカゲ] 取得失敗: ${failedItems.length}件`, failedItems.map(i => i.fetch_error));
  }

  // LIGHT モード: 成功0件 → noResults フラグで返す（例外なし）
  if (lightMode && successItems.length === 0) {
    console.warn('[ヒカゲ] LIGHT: 全URL取得失敗 → noResults で返します');
    return { items: fetchedItems, noResults: true, low_sample: true, count: 0, fetch_summary: { total: fetchedItems.length, success: 0, failed: failedItems.length } };
  }

  // Claudeで構造化補完（取得済みデータから target_reader / problem_solved / notes を推定）
  // ※ Claudeは既存データの整理・補完のみ行う。架空情報は追加しない。
  const systemPrompt = loadPrompt('01_scout.md') + loadKotoriContext('Scout');
  const apiKey = process.env.ANTHROPIC_API_KEY;

  let structuredItems = fetchedItems;

  if (apiKey && successItems.length > 0) {
    try {
      const userMessage = `
以下は実際にWebから取得した公開記事データです（架空データは含まれていません）。
各アイテムについて、取得済みの情報（title, author, price, free_content, table_of_contents）を元に、
推定できる範囲で target_reader と problem_solved を補完してください。
推測できない場合は null のままにしてください。架空の情報を追加しないでください。

取得データ（${fetchedItems.length}件）:
${JSON.stringify(fetchedItems.map(item => ({
  url: item.url,
  title: item.title,
  author: item.author,
  price: item.price,
  published_at: item.published_at,
  free_content: item.free_content?.slice(0, 200),
  table_of_contents: item.table_of_contents?.slice(0, 300),
  fetch_ok: item.fetch_ok,
  fetch_error: item.fetch_error,
})), null, 2)}

以下のJSON形式で返してください（元のURLと対応させること）:
[
  {
    "url": "（元のURLをそのまま）",
    "target_reader": "推定読者（推測不可なら null）",
    "problem_solved": "解決する悩み（推測不可なら null）",
    "notes": "気づき・特記事項（任意）"
  }
]
JSONのみ返してください。`;

      const raw = await callClaude(systemPrompt, userMessage);
      const supplements = extractJson(raw);

      if (Array.isArray(supplements)) {
        const supMap = new Map(supplements.map(s => [s.url, s]));
        structuredItems = fetchedItems.map(item => {
          const sup = supMap.get(item.url) ?? {};
          return {
            ...item,
            target_reader:  sup.target_reader  ?? item.target_reader  ?? null,
            problem_solved: sup.problem_solved ?? item.problem_solved ?? null,
            notes:          sup.notes          ?? null,
            cta:            item.cta           ?? null,
          };
        });
      }
    } catch (err) {
      console.warn('[ヒカゲ] Claude補完スキップ（API未設定またはエラー）:', err.message);
      // Claude補完失敗でも取得済みデータは返す
    }
  }

  const low_sample = successItems.length < 10;
  return {
    items: structuredItems,
    low_sample,
    count: successItems.length,
    fetch_summary: {
      total: fetchedItems.length,
      success: successItems.length,
      failed: failedItems.length,
    },
  };
}

/**
 * スクリーニング: 30記事seedを6基準で軽量スコアリングし、上位5〜8案を返す
 *
 * - この段階では長文生成・URL調査を行わない（軽量API呼び出し1回のみ）
 * - 戻り値の topSeeds は次のURL探索クエリとして使う
 *
 * @param {{ theme?: string, genre?: string }} context
 * @returns {{ topSeeds: Array<{title:string,score:number,queries:string[]}>, allScores: object[] }}
 */
export async function runScreening({ theme, genre } = {}) {
  const config = getConfig();
  const seeds  = (config.seed_articles ?? []).filter(s => !s.pinned);
  const author = config.author ?? {};

  if (seeds.length === 0) {
    return { topSeeds: [], allScores: [] };
  }

  const systemPrompt = `あなたは出版事業部の商品企画担当です。
著者「${author.name ?? 'ことり'}」向けのnote記事案を評価します。
著者の強み: ${(author.strengths ?? []).join('、')}
著者が避けること: ${(author.avoid ?? []).join('、')}

今回のプロジェクトテーマ（参考）: ${theme || genre || '（指定なし）'}

各記事案について以下の6基準を1〜5で採点してください。詳細説明は不要です。JSONのみ返してください。
${loadKotoriContext('Planner')}`;

  const userMessage = `以下${seeds.length}件の記事案を採点してください。

${seeds.map((s, i) => `${i+1}. [${s.type}] ${s.title}`).join('\n')}

以下のJSON形式で返してください:
[
  {
    "index": 1,
    "title": "記事タイトル",
    "market": 3,
    "competition": 3,
    "kotori_fit": 3,
    "firsthand": 3,
    "monetize": 3,
    "writeable_now": 3,
    "total": 18
  }
]
各項目1〜5。totalは合計点（最大30）。JSONのみ返してください。`;

  let allScores = [];
  try {
    const raw = await callClaude(systemPrompt, userMessage, {
      tier: 'CHEAP', task: 'screening', employee: 'Scout',
    });
    const parsed = extractJson(raw);
    if (Array.isArray(parsed)) {
      allScores = parsed.sort((a, b) => (b.total ?? 0) - (a.total ?? 0));
    }
  } catch (err) {
    console.warn('[スクリーニング] エラー（フォールバック: 上位8件をそのまま使用）:', err.message);
    // API失敗時は上位8件をそのまま返す
    allScores = seeds.slice(0, 8).map((s, i) => ({
      index: i + 1, title: s.title, total: 20,
    }));
  }

  // 上位5〜8案を選択（合計20点以上を優先）
  const topN = Math.min(8, Math.max(5, allScores.filter(s => (s.total ?? 0) >= 18).length));
  const topSeeds = allScores.slice(0, topN).map(s => ({
    title: s.title,
    score: s.total ?? 0,
    queries: [s.title.slice(0, 20)],  // 検索クエリ用に短縮
  }));

  console.log(`[スクリーニング] 上位${topSeeds.length}案: ${topSeeds.map(s => s.title.slice(0,15)).join(' / ')}`);

  return { topSeeds, allScores };
}

/**
 * Analyst: Scoutデータから市場構造を分析
 * @returns {{ analysis: string, themes: string[], price_range: string, opportunities: string[] }}
 */
export async function runAnalyst({ items, lowSample }) {
  const systemPrompt = loadPrompt('02_analyst.md') + loadKotoriContext('Analyst');
  const userMessage = `
市場調査データ（${items.length}件${lowSample ? ' ※LOW_SAMPLE警告' : ''}）:
${JSON.stringify(items, null, 2)}

以下のJSON形式で市場分析を返してください:
{
  "summary": "全体概要",
  "frequent_themes": ["テーマ1", "テーマ2"],
  "common_problems": ["悩み1", "悩み2"],
  "price_distribution": "価格帯の分布",
  "title_patterns": ["パターン1", "パターン2"],
  "saturated_areas": ["飽和領域1"],
  "unmet_needs": ["未充足ニーズ1", "未充足ニーズ2"],
  "opportunities": ["機会1", "機会2"],
  "low_sample_warning": ${lowSample}
}
JSONのみ返してください。`;

  const raw = await callClaude(systemPrompt, userMessage);
  return extractJson(raw);
}

/**
 * Planner: 分析結果から商品候補3案を生成
 * @returns {{ ideas: Array[3] }}
 */
export async function runPlanner({ analysis, theme, genre, targetReader, priceRange }) {
  const systemPrompt = loadPrompt('03_planner.md') + loadKotoriContext('Planner');
  const config = getConfig();
  const author = config.author ?? {};
  const seeds  = (config.seed_articles ?? []).filter(s => !s.pinned).slice(0, 30);

  const authorSection = author.name ? `
著者情報:
- 著者名: ${author.name}
- 作風・強み: ${(author.strengths ?? []).join('、')}
- 避けるべき表現: ${(author.avoid ?? []).join('、')}
- 説明: ${author.description ?? ''}
` : '';

  const seedSection = seeds.length > 0 ? `
参考seed記事案（著者向けに事前に用意した記事アイデア一覧、これを参考にしつつ市場分析と組み合わせて3案を選ぶこと）:
${seeds.slice(0, 10).map((s, i) => `${i+1}. [${s.type}] ${s.title}`).join('\n')}
` : '';

  const userMessage = `
社長の入力:
- テーマ: ${theme || '（指定なし）'}
- ジャンル: ${genre || '（指定なし）'}
- 対象読者: ${targetReader || '（指定なし）'}
- 希望価格帯: ${priceRange || '（指定なし）'}
${authorSection}${seedSection}
市場分析結果:
${JSON.stringify(analysis, null, 2)}

必ず3案を以下のJSON形式で返してください（1案も勝手に採用しない）:
{
  "ideas": [
    {
      "index": 1,
      "title": "タイトル案",
      "target_reader": "想定読者",
      "problem": "解決する悩み",
      "value": "提供価値",
      "uniqueness": "独自性",
      "rationale": "根拠（市場データに基づく）",
      "structure": "構成案",
      "price_range": "想定価格帯",
      "workload": "制作負荷（小/中/大）"
    }
  ]
}
JSONのみ返してください。`;

  const raw = await callClaude(systemPrompt, userMessage);
  return extractJson(raw);
}

/**
 * Planner（ことりシリーズ専用）: 外部調査なしで企画案3案を生成
 * 山吹ことりの実体験・視点・活動から語れる内容のみを対象とする
 *
 * @param {{ theme?: string, existingArticles?: Array<{id, theme, status, title}> }} opts
 * @returns {{ ideas: Array<{index, title, target_reader, ...}> }}
 */
export async function runKotoriSeriesPlanner({ theme, existingArticles = [] }) {
  const systemPrompt = loadPrompt('03_planner.md') + loadKotoriContext('Planner');

  const existingList = existingArticles.length > 0
    ? existingArticles.map(a => `- 「${a.title ?? a.theme}」（${a.status}）`).join('\n')
    : '（まだありません）';

  const userMessage = `
## 「山吹ことりについて」シリーズ 次回記事の企画

テーマ: ${theme ?? '（自由）'}

このシリーズは外部市場データを使いません。
山吹ことり本人の実際の経験・視点・活動から語れる内容で企画してください。

### 既存シリーズ記事（重複不可）
${existingList}

### 制約
- 外部競合分析・市場調査は不要（データがないため）
- 本人が持っていない体験・実績をベースにしない
- 既存記事と内容が重複しない
- 「公開禁止情報」（職業名など）は企画案に含めない

必ず3案を以下のJSON形式で返してください:
{
  "ideas": [
    {
      "index": 1,
      "title": "タイトル案",
      "target_reader": "想定読者",
      "problem": "解決する悩み",
      "value": "提供価値",
      "uniqueness": "独自性（ことりにしか語れない理由）",
      "rationale": "根拠（ことりの実体験・活動に基づく）",
      "structure": "構成案",
      "price_range": "想定価格帯",
      "workload": "制作負荷（小/中/大）"
    }
  ]
}
JSONのみ返してください。`;

  const raw = await callClaude(systemPrompt, userMessage);
  return extractJson(raw);
}

/**
 * Writer: 採用案から記事を執筆
 * @returns {{ title_candidates: string[], lead: string, free_part: string, paid_part: string, summary: string }}
 */
export async function runWriter({ selectedIdea, revisionRequest = null, approvedKnowledge = [] }) {
  const systemPrompt = loadPrompt('04_writer.md') + loadKotoriContext('Writer') + buildKnowledgeContext(approvedKnowledge);
  const revisionSection = revisionRequest
    ? `\n\n【編集長からの修正指示】\n${revisionRequest}\n上記の指摘箇所を優先して修正してください。`
    : '';

  const userMessage = `
採用案:
${JSON.stringify(selectedIdea, null, 2)}
${revisionSection}

以下のJSON形式で記事を返してください:
{
  "title_candidates": ["タイトル案1", "タイトル案2", "タイトル案3"],
  "lead": "リード文（読者の心をつかむ導入）",
  "free_part": "無料公開部分（読者が価値を感じられる内容）",
  "paid_part": "有料部分（核心的な価値・ノウハウ）",
  "summary": "まとめ・行動促進"
}
JSONのみ返してください。架空の実績・口コミは禁止。`;

  const raw = await callClaude(systemPrompt, userMessage);
  return extractJson(raw);
}

/**
 * ソラ（Writer）がChatから記事生成を行う
 * - メッセージに記事作成の意図がある場合: 構造化記事JSON + 短い返答を返す
 * - 意図がない場合: chat_reply のみ返す
 *
 * @param {string} userMessage - 社長のメッセージ
 * @param {string} contextText - プロジェクトコンテキスト
 * @param {Array} history - 会話履歴
 * @param {string} [revisionInstruction] - 修正指示（バージョンアップ時）
 * @param {string} [existingDraftSummary] - 既存ドラフトの要約（修正時）
 * @returns {Promise<{is_article: boolean, article?: ArticleDraft, chat_reply: string}>}
 */
export async function runWriterFromChat(userMessage, contextText, history = [], revisionInstruction = null, existingDraftSummary = null) {
  const systemPrompt = loadPrompt('04_writer.md') + loadKotoriContext('Writer');
  const addressForm  = 'ことりさん';

  const revisionSection = revisionInstruction
    ? `\n\n【修正指示】\n${revisionInstruction}\n\n【既存ドラフト概要】\n${existingDraftSummary ?? '（なし）'}`
    : '';

  // 会話履歴を文字列化（直近5件）
  const historyText = history.slice(-5).map(h =>
    `${h.speaker === '社長' ? '社長' : 'ソラ'}：${h.message?.slice(0, 200) ?? ''}`
  ).join('\n');

  const userMsg = `
あなたはAI社員「ソラ」です。${addressForm}（山吹ことり）からのメッセージに返答します。

【会話履歴（直近）】
${historyText || '（なし）'}

【現在のプロジェクト情報】
${contextText || '（なし）'}
${revisionSection}

【${addressForm}のメッセージ】
${userMessage}

---
まず、このメッセージが「記事・本文の執筆・生成・修正依頼」かどうかを判断してください。

■ 記事生成依頼である場合：
以下のJSON形式で返してください。full_content は lead + free_part + paid_part + summary をつなげた完全版本文です。

{
  "is_article": true,
  "article": {
    "title": "記事タイトル（1つだけ、最も適切なもの）",
    "lead": "リード文（300〜500字。読者の心をつかむ導入。記事の続きへ誘導する）",
    "free_part": "無料公開部分（500〜1500字。読者が価値を感じられる内容。続きへの期待を作る）",
    "paid_part": "有料部分（1000〜3000字。核心的な価値・ノウハウ・ことりさんの実体験や具体的な内容）",
    "summary": "まとめ（300〜500字。行動促進・締めの言葉）",
    "full_content": "（上記をすべて結合した完全版本文）"
  },
  "chat_reply": "ことりさん、初稿ができました。約○文字です。記事レポートに保存しました。確認してみてください。"
}

■ 記事生成依頼でない場合：
{
  "is_article": false,
  "chat_reply": "（1〜5文の自然な返答。ソラのキャラクターで）"
}

【重要ルール】
- 架空の実体験・実績・数値・口コミは絶対に作らない
- ことりさんから提供されていない情報を事実として書かない
- 不足情報があれば chat_reply でその旨を伝える
- JSONのみ返してください`;

  // 記事生成はmax_tokens多めに（長文対応）
  const messages = history.slice(-8).map(h => ({
    role: h.speaker === '社長' ? 'user' : 'assistant',
    content: h.message?.slice(0, 500) ?? '',
  }));
  messages.push({ role: 'user', content: userMsg });

  const raw = await callClaude(systemPrompt, messages, {
    tier: 'DEFAULT', maxTokens: 8192, task: 'writer_chat', employee: 'Writer',
  });

  try {
    const parsed = extractJson(raw);
    if (parsed && typeof parsed === 'object' && 'is_article' in parsed) {
      // word_count を計算
      if (parsed.is_article && parsed.article) {
        const fc = parsed.article.full_content ?? '';
        parsed.article.word_count = fc.length;
        // chat_reply に文字数を挿入
        parsed.chat_reply = parsed.chat_reply?.replace('○', String(fc.length)) ?? parsed.chat_reply;
      }
      return parsed;
    }
  } catch (_) { /* fall through */ }

  // パース失敗時: テキスト返答として扱う
  return { is_article: false, chat_reply: raw.slice(0, 500) };
}

/**
 * Writer: 既存ドラフトを元に修正版を作成（企画案なしプロジェクト用）
 * - runWriter の「採用案ベース」とは異なり「既存記事ベース」で修正する
 * @returns {{ title_candidates, lead, free_part, paid_part, summary }}
 */
export async function runWriterRevision({ existingDraft, revisionRequest, approvedKnowledge = [] }) {
  const systemPrompt = loadPrompt('04_writer.md') + loadKotoriContext('Writer') + buildKnowledgeContext(approvedKnowledge);
  const userMessage = `
【既存記事の修正依頼です】

【現在の記事内容】
タイトル候補: ${JSON.stringify(existingDraft.title_candidates)}
リード:
${existingDraft.lead ?? ''}

無料部分:
${existingDraft.free_part ?? ''}

有料部分:
${existingDraft.paid_part ?? '（なし）'}

まとめ:
${existingDraft.summary ?? ''}

【修正指示】
${revisionRequest}

上記の修正指示に従って記事を修正してください。
指示された箇所のみ変更し、他の内容は原文を保持してください。
指示にない実績・数字・体験・感情は絶対に追加しないでください。

以下のJSON形式で返してください:
{
  "title_candidates": ["タイトル案1", "タイトル案2", "タイトル案3"],
  "lead": "リード文",
  "free_part": "無料公開部分",
  "paid_part": null,
  "summary": "まとめ"
}
JSONのみ返してください。`;

  const raw = await callClaude(systemPrompt, userMessage);
  return extractJson(raw);
}

/**
 * 本人レビュー判定: 修正規模を判断する（キイロが担当）
 * @returns {{ type: 'MINOR'|'MAJOR', reason: string }}
 */
export async function runOwnerReviewJudge({ instruction, draft }) {
  const systemPrompt = loadKotoriContext('Editor') + `
あなたは編集長キイロです。
本人（山吹ことり）から届いた修正指示を読み、修正規模を判定してください。

【MINOR（あなたが直接修正）の基準】
- 単語・語句の変更
- 1〜数文の追加・削除
- 言い回し・表現の調整
- 誤解防止のための補足
- 表記の統一
- 個人情報・公開禁止情報の削除
- 事実関係を変えない小修正

【MAJOR（ソラへ差し戻す）の基準】
- 複数段落の全面的な書き直し
- 記事の構成変更
- 新しい章・大きなセクションの追加
- 記事の方向性・テーマの変更
- 大幅な文章追加

以下のJSON形式だけを返してください:
{"type":"MINOR","reason":"（理由）"}`;

  const userMessage = `【修正指示】
${instruction}

【現在の原稿（冒頭部分）】
リード: ${(draft.lead ?? '').slice(0, 300)}
本文冒頭: ${(draft.free_part ?? '').slice(0, 300)}`;

  const raw = await callClaude(systemPrompt, userMessage, {
    tier: 'CHEAP', task: 'owner_review_judge', employee: 'Editor',
  });
  try {
    const r = extractJson(raw);
    if (r?.type === 'MINOR' || r?.type === 'MAJOR') return r;
  } catch {}
  // フォールバック: 判断できなければMINORとして扱う
  return { type: 'MINOR', reason: '判定不能のためMINORとして処理' };
}

// ── 修正系ヘルパー ────────────────────────────────────────────────────────────

/** MINOR修正: 指示文からセクション名キーワードで対象を特定 */
function identifyTargetSections(instruction) {
  const sections = [];
  if (/リード|lead|導入|冒頭|書き出し|最初の段落/.test(instruction))   sections.push('lead');
  if (/無料部分|本文|free_part|フリー|公開部分/.test(instruction))       sections.push('free_part');
  if (/有料部分|paid_part|ペイド|有料コンテンツ|核心/.test(instruction)) sections.push('paid_part');
  if (/まとめ|summary|締め|結び/.test(instruction))                      sections.push('summary');
  if (/タイトル|title/.test(instruction))                                sections.push('title_candidates');
  return sections;
}

/** 指示文から検索用キーワードを抽出（対象箇所を本文内で探すために使用） */
function extractSearchTerms(instruction) {
  const terms = [];
  // 「」引用
  const jpQ = instruction.match(/「([^」\n]{2,40})」/g);
  if (jpQ) terms.push(...jpQ.map(q => q.slice(1, -1)));
  // "" 引用
  const enQ = instruction.match(/"([^"\n]{2,40})"/g);
  if (enQ) terms.push(...enQ.map(q => q.slice(1, -1)));
  // ## 見出し記述
  const hdg = instruction.match(/#+\s*([^\n]{2,30})/g);
  if (hdg) terms.push(...hdg.map(h => h.replace(/^#+\s*/, '')));
  // 「〇〇の部分/箇所/段落/章」パターン
  const kp = instruction.match(/([^\s、。「」\n]{2,20})(?:の部分|の箇所|の段落|の章|という文|の節)/g);
  if (kp) terms.push(...kp.map(p => p.replace(/(?:の部分|の箇所|の段落|の章|という文|の節)$/, '')));
  return [...new Set(terms)].filter(t => t.length >= 2);
}

/**
 * テキスト内で検索語に最も近い位置を中心にウィンドウを切り出す。
 * 段落境界（\n）でスナップ。後半にある語でも確実に取得できる。
 * @returns {string|null} マッチなしなら null
 */
function extractSmartWindow(text, searchTerms, maxChars = 1500) {
  if (!text) return null;
  if (text.length <= maxChars) return text;

  // 最初にマッチする位置を探す
  let matchPos = -1;
  for (const term of searchTerms) {
    const pos = text.indexOf(term);
    if (pos >= 0 && (matchPos === -1 || pos < matchPos)) matchPos = pos;
  }
  if (matchPos === -1) return null; // マッチなし

  // マッチ周辺のウィンドウ
  const half = Math.floor(maxChars / 2);
  let start = Math.max(0, matchPos - half);
  let end   = Math.min(text.length, matchPos + half);

  // 段落境界でスナップ
  if (start > 0) {
    const nl = text.lastIndexOf('\n', start);
    if (nl >= 0) start = nl + 1;
  }
  if (end < text.length) {
    const nl = text.indexOf('\n', end);
    if (nl >= 0) end = nl;
  }

  const prefix = start > 0          ? '…（前略）\n' : '';
  const suffix = end < text.length   ? '\n…（後略）' : '';
  return prefix + text.slice(start, end) + suffix;
}

/** 検索語がどのセクションに含まれるかをコンテンツ検索で特定 */
function findSectionByContent(draft, searchTerms) {
  if (!searchTerms.length) return null;
  const SECTIONS = ['lead', 'free_part', 'paid_part', 'summary'];
  let best = null, bestScore = 0;
  for (const s of SECTIONS) {
    const text = draft[s] ?? '';
    const score = searchTerms.filter(t => text.includes(t)).length;
    if (score > bestScore) { bestScore = score; best = s; }
  }
  return bestScore > 0 ? best : null;
}

/**
 * 対象セクション + 前後コンテキストを組み立てる。
 * セクション内の対象箇所は extractSmartWindow で切り出す（後半でも確実に取得）。
 */
function buildSectionContext(draft, targetSections, instruction = '', charLimit = 2000) {
  const SECTION_ORDER = ['lead', 'free_part', 'paid_part', 'summary'];
  const targetSet = new Set(targetSections.filter(s => s !== 'title_candidates'));
  const searchTerms = extractSearchTerms(instruction);

  // 隣接セクションも含める
  const includeSet = new Set(targetSet);
  for (const s of targetSet) {
    const idx = SECTION_ORDER.indexOf(s);
    if (idx > 0) includeSet.add(SECTION_ORDER[idx - 1]);
    if (idx < SECTION_ORDER.length - 1) includeSet.add(SECTION_ORDER[idx + 1]);
  }

  const parts = [];
  let total = 0;
  for (const s of SECTION_ORDER) {
    if (!includeSet.has(s)) continue;
    const text = draft[s] ?? '';
    if (!text) continue;

    const isTarget = targetSet.has(s);
    const label = isTarget ? `【修正対象: ${s}】` : `【参考: ${s}】`;
    // 対象セクションに75%、参考セクションに15%を割り当て
    const budget = isTarget
      ? Math.min(text.length, Math.floor(charLimit * 0.75))
      : Math.min(text.length, Math.floor(charLimit * 0.15));

    let excerpt;
    if (text.length <= budget) {
      excerpt = text; // 全文入る
    } else if (isTarget && searchTerms.length > 0) {
      // 検索語を基点にウィンドウ切り出し（後半でも取得できる）
      excerpt = extractSmartWindow(text, searchTerms, budget)
             ?? (text.slice(0, budget) + '\n…（後略）');
    } else {
      excerpt = text.slice(0, budget) + '\n…（後略）';
    }

    parts.push(`${label}\n${excerpt}`);
    total += excerpt.length;
    if (total >= charLimit) break;
  }
  return parts.join('\n\n');
}

/** テキストを見出し単位のブロックに分割（## heading 対応） */
function splitIntoSections(text) {
  const lines = text.split('\n');
  const blocks = [];
  let cur = { heading: null, bodyLines: [] };
  for (const line of lines) {
    if (/^#{1,4}\s+/.test(line)) {
      if (cur.bodyLines.length > 0 || cur.heading !== null) {
        blocks.push({ heading: cur.heading, body: cur.bodyLines.join('\n').trim() });
      }
      cur = { heading: line, bodyLines: [] };
    } else {
      cur.bodyLines.push(line);
    }
  }
  if (cur.bodyLines.length > 0 || cur.heading !== null) {
    blocks.push({ heading: cur.heading, body: cur.bodyLines.join('\n').trim() });
  }
  return blocks.length > 0 ? blocks : [{ heading: null, body: text }];
}

/**
 * MAJOR修正: 全文をバジェット内に収める（見出し構造を保持）。
 * 単純な先頭sliceは使わない。予算内なら全文送信、超過時は見出し単位で圧縮。
 */
function buildMajorDraftContext(draft, budgetChars = 7000) {
  const FIELDS = [
    { label: 'リード',   content: draft.lead ?? '' },
    { label: '無料部分', content: draft.free_part ?? '' },
    { label: '有料部分', content: draft.paid_part ?? '' },
    { label: 'まとめ',   content: draft.summary ?? '' },
  ];
  const titleLine = `タイトル候補: ${JSON.stringify(draft.title_candidates)}\n`;
  const totalChars = FIELDS.reduce((sum, f) => sum + f.content.length, 0);

  // バジェット内: 全文送信
  if (totalChars + titleLine.length <= budgetChars) {
    return titleLine + FIELDS.filter(f => f.content).map(f => `\n【${f.label}】\n${f.content}`).join('');
  }

  // バジェット超過: 見出し構成を先に全体提示し、各フィールドを見出し単位で圧縮
  const outlineLines = [];
  for (const f of FIELDS) {
    const hdgs = (f.content.match(/^#{1,4}\s+.+$/gm) ?? []);
    if (hdgs.length) outlineLines.push(`[${f.label}] ${hdgs.join(' / ')}`);
  }
  const outline = outlineLines.length
    ? `【記事全体の見出し構成】\n${outlineLines.join('\n')}\n\n---\n` : '';

  const remainBudget = budgetChars - outline.length - titleLine.length;
  const parts = [outline, titleLine];

  for (const f of FIELDS) {
    if (!f.content) continue;
    const fBudget = Math.floor(remainBudget * (f.content.length / totalChars));
    if (f.content.length <= fBudget) {
      parts.push(`\n【${f.label}】\n${f.content}`);
      continue;
    }
    // 見出し単位で前から収める（省略は見出し構成で補完）
    const blocks = splitIntoSections(f.content);
    const fieldParts = [];
    let used = 0;
    for (const blk of blocks) {
      const blkText = (blk.heading ? blk.heading + '\n' : '') + blk.body;
      if (used + blkText.length <= fBudget) {
        fieldParts.push(blkText); used += blkText.length;
      } else {
        const rem = fBudget - used;
        if (rem > 80) {
          const hdr = blk.heading ? blk.heading + '\n' : '';
          fieldParts.push(hdr + blk.body.slice(0, rem - hdr.length) + '\n…（以降省略。見出し構成を参照）');
        }
        break;
      }
    }
    parts.push(`\n【${f.label}】\n${fieldParts.join('\n\n')}`);
  }
  return parts.join('');
}

/**
 * キイロによる軽微修正（本人指示を直接反映）
 *
 * 優先順: セクション名キーワード → コンテンツ検索 → 全文（短文）or 圧縮全文（長文）
 * extractSmartWindow により後半にある対象箇所でも確実にAIへ渡る。
 * @returns {{ title_candidates, lead, free_part, paid_part, summary, changes_summary }}
 */
export async function runEditorMinorRevision({ instruction, draft, approvedKnowledge = [] }) {
  const systemPrompt = loadPrompt('05_editor.md') + loadKotoriContext('Editor') + buildKnowledgeContext(approvedKnowledge) + `

## 本人レビュー軽微修正モード

本人（山吹ことり）から直接届いた修正指示を原稿へ反映します。

【絶対に守ること】
- 指示された箇所だけを変更する
- 指示されていない文・段落は一字一句変えない
- 自分の判断で追加・削除・言い換えをしない
- 修正後に changes_summary で何を変えたかを日本語で説明する`;

  // ① セクション名キーワードで特定
  const namedSections = identifyTargetSections(instruction).filter(s => s !== 'title_candidates');
  const searchTerms   = extractSearchTerms(instruction);

  // ② 名前で特定できなければコンテンツ検索でセクションを探す
  let activeTargets = namedSections;
  if (activeTargets.length === 0 && searchTerms.length > 0) {
    const found = findSectionByContent(draft, searchTerms);
    if (found) activeTargets = [found];
  }

  let userMessage;
  let isPartial = false;

  if (activeTargets.length > 0) {
    // ── 部分送信モード: 対象セクション周辺のみ（後半でも確実に取得）───────────
    const sectionContext = buildSectionContext(draft, activeTargets, instruction, 2000);
    const returnFields   = activeTargets.map(s => `  "${s}": "修正後のテキスト"`).join(',\n');
    userMessage = `【修正指示】
${instruction}

${sectionContext}

修正対象の部分だけを返してください。他のセクションは出力不要です。
JSON形式:
{
${returnFields},
  "changes_summary": "変更内容（1〜3行）"
}
JSONのみ返してください。`;
    isPartial = true;

  } else {
    // ── 完全フォールバック: 全文が短ければそのまま、長ければ見出し構造を保持して圧縮 ──
    const totalChars = [draft.lead, draft.free_part, draft.paid_part, draft.summary]
      .reduce((s, v) => s + (typeof v === 'string' ? v.length : 0), 0);
    const draftContext = buildMajorDraftContext(draft, totalChars <= 4500 ? totalChars + 200 : 4500);
    userMessage = `【本人の修正指示】
${instruction}

【現在の原稿】
${draftContext}

【出力形式（JSONのみ）】
{
  "title_candidates": ["…"],
  "lead": "…",
  "free_part": "…",
  "paid_part": null,
  "summary": "…",
  "changes_summary": "・変更1\\n・変更2（キイロが直接修正）"
}`;
  }

  const raw    = await callClaude(systemPrompt, userMessage);
  const result = extractJson(raw);

  if (isPartial && result) {
    // 部分レスポンスを元ドラフトにマージして返す
    return {
      title_candidates: result.title_candidates ?? draft.title_candidates,
      lead:      result.lead      ?? draft.lead,
      free_part: result.free_part ?? draft.free_part,
      paid_part: result.paid_part ?? draft.paid_part,
      summary:   result.summary   ?? draft.summary,
      changes_summary: result.changes_summary ?? '（変更サマリーなし）',
    };
  }
  return result;
}

/**
 * ソラによる大きな修正（本人指示を元に改稿）
 *
 * MAJOR: バジェット内なら全文送信。超過時は見出し単位で圧縮（先頭sliceなし）。
 * @returns {{ title_candidates, lead, free_part, paid_part, summary, changes_summary }}
 */
export async function runWriterMajorRevision({ instruction, draft, approvedKnowledge = [] }) {
  const systemPrompt = loadPrompt('04_writer.md') + loadKotoriContext('Writer') + buildKnowledgeContext(approvedKnowledge) + `

## 本人レビュー大きな修正モード

本人（山吹ことり）から届いた修正指示に基づいて原稿を改稿します。

【守ること】
- 指示された修正を最優先で反映する
- 指示されていない部分は原文をベースにする（必要最小限の変更）
- 指示にない体験・数字・感情を追加しない
- 改稿後に changes_summary で何を変えたかを説明する`;

  // MAJOR: バジェット7000字以内なら全文、超過時は見出し構造を保持して圧縮
  const draftContext = buildMajorDraftContext(draft, 7000);
  const userMessage = `【本人の修正指示】
${instruction}

【現在の原稿】
${draftContext}

【出力形式（JSONのみ）】
{
  "title_candidates": ["…"],
  "lead": "…",
  "free_part": "…",
  "paid_part": null,
  "summary": "…",
  "changes_summary": "・変更1\\n・変更2（ソラが改稿）"
}`;

  const raw = await callClaude(systemPrompt, userMessage, {
    tier: 'DEFAULT', maxTokens: 8192, task: 'writer_major_revision', employee: 'Writer',
  });
  return extractJson(raw);
}

/**
 * 事実確認モード（FACT_CHECK）: AIが現在の理解を箇条書きで提示する
 * 記事本文は一切書かない。本人が確認できる内容だけを出力する。
 *
 * @param {{ instruction: string, draft: object }} opts
 * @returns {Promise<string>} markdown 形式の箇条書き
 */
export async function runFactCheckPresentation({ instruction, draft }) {
  const systemPrompt = loadKotoriContext('Writer') + `
あなたは記事執筆担当のソラです。
本人から「記事本文を書く前に、今回の記事で使おうとしている事実を確認したい」という指示が届きました。

このモードでは、記事本文は書きません。
代わりに、現在の原稿から読み取った「事実・具体例・不確かな情報」を箇条書きで整理して提示します。

出力形式:
## 現在の原稿で使っている事実・具体例

（箇条書き。本人が確認できるよう具体的に）

## 不確かな情報・AIが補完した可能性がある記述

（箇条書き。本人の確認が必要なもの）

## 今回の記事の前提理解

（記事の中心テーマ・前提について短くまとめる）

JSONは返さない。箇条書きのみ。`;

  const draftText = `
タイトル候補: ${JSON.stringify(draft.title_candidates ?? [])}
リード: ${(draft.lead ?? '').slice(0, 500)}
無料部分（冒頭）: ${(draft.free_part ?? '').slice(0, 500)}
有料部分（冒頭）: ${(draft.paid_part ?? '').slice(0, 500)}`;

  const userMessage = `【本人からの確認指示】
${instruction}

【現在の原稿（確認用抜粋）】
${draftText}`;

  return callClaude(systemPrompt, userMessage, {
    tier: 'DEFAULT', maxTokens: 2048, task: 'fact_check', employee: 'Writer',
  });
}

/**
 * 企画採用後の事実確認（ドラフトなし・本文生成なし）
 *
 * AIは事実を生成・補完しない。
 * 以下の「確定情報源」だけを参照し、企画内の各要素を4分類する:
 *   【確認済み事実】       - approvedKnowledge / 公開済み記事 / profile に明示されているもの
 *   【本人が提供した経験】 - usableFacts に本人が書いたもの
 *   【根拠がなく使用禁止】 - いずれの情報源にも存在しない（推測・補完を含む）
 *   【本人確認が必要】     - 情報源に近い記述はあるが確証がないもの
 *
 * @param {{ idea, theme, usableFacts, approvedKnowledgeFacts, publishedTitles, profile }} opts
 * @returns {Promise<string>} markdown 形式の分類リスト
 */
export async function runIdeaFactCheck({ idea, theme, usableFacts, approvedKnowledgeFacts, publishedTitles, profile }) {
  const systemPrompt = `あなたは山吹ことりの記事制作を補佐するファクトチェック担当です。

## 役割
この企画で言及される事実・経験・主張を、以下の確定情報源だけと照合して分類してください。
AIによる推測・補完・「おそらくこういう経験があるはず」という判断は厳禁です。
確定情報源にない内容は、もっともらしく見えても「根拠がなく使用禁止」にしてください。

## 確定情報源
${profile ? `### kotori公開プロフィール\n${profile}\n` : ''}
### 承認済みナレッジ（事実カテゴリ）
${approvedKnowledgeFacts?.length ? approvedKnowledgeFacts.map(k => `- ${k.rule_text}`).join('\n') : '（登録なし）'}

### 本人が今回提供した事実・経験（使ってよいもの）
${usableFacts?.trim() ? usableFacts : '（今回の入力なし）'}

### 公開済み記事タイトル一覧（存在確認用）
${publishedTitles?.length ? publishedTitles.map(t => `- ${t}`).join('\n') : '（なし）'}

## 出力形式（JSONなし・マークダウンのみ）

企画タイトルと各要素を読んで、以下4分類に整理してください。

### 【確認済み事実】
（確定情報源に明示されており、記事で使用可能なもの）

### 【本人が提供した経験】
（今回の「使ってよい事実・経験」欄に本人が書いたもの）

### 【根拠がなく使用禁止】
（確定情報源に存在しない。推測・補完された可能性のある情報）

### 【本人確認が必要】
（情報源に近い記述はあるが、この文脈・数値・詳細について確認が取れていないもの）

各カテゴリに該当なしの場合は「（該当なし）」と書いてください。`;

  const ideaText = `企画タイトル: ${idea.title ?? '（未定）'}
ターゲット読者: ${idea.target_reader ?? '（未設定）'}
解決する悩み: ${idea.problem ?? '（未設定）'}
提供する価値: ${idea.value ?? '（未設定）'}
独自性・根拠: ${idea.uniqueness ?? '（未設定）'}
構成案: ${idea.structure ?? '（未設定）'}`;

  return callClaude(systemPrompt, `【記事テーマ】${theme ?? '（未設定）'}\n\n【採用企画の詳細】\n${ideaText}`, {
    tier: 'CHEAP', maxTokens: 2048, task: 'idea_fact_check', employee: 'Writer',
  });
}

/**
 * 企画採用後の構成作成（本文なし・見出し骨格のみ）
 * - 記事本文は一切書かない
 * - タイトル候補・見出し構成・無料/有料の分け方を出力
 *
 * @param {{ idea: object, theme: string, genre: string, targetReader: string }} opts
 * @returns {Promise<string>} markdown 形式の構成
 */
export async function runIdeaOutlinePlanner({ idea, theme, genre, targetReader }) {
  const systemPrompt = loadKotoriContext('Writer') + `
あなたは記事執筆担当のソラです。
社長から「この企画の構成だけ作ってほしい、本文はまだ書かなくていい」という依頼が来ました。

このモードでは記事本文を書きません。
見出し構成（骨格）だけを作成します。

出力形式（JSONなし・マークダウンのみ）:

## タイトル候補（3案）
1. （タイトル案1）
2. （タイトル案2）
3. （タイトル案3）

## 無料部分の構成
（ここは誰でも読める部分。読者を惹き込む役割）
### リード（導入）
（1〜2行で内容を説明）
### [見出し]
### [見出し]
...

## 有料部分の構成
（購入者だけが読める部分。記事の核心）
### [見出し]
### [見出し]
...

## まとめ

---
**無料/有料の分け方の根拠:**
（なぜここで分けるのか、一言で）

**推定文字数:** 無料〇〇字 / 有料〇〇字 / 合計〇〇字

見出しのテキストだけ書いてください。本文・説明文は書かない。JSONは返さない。`;

  const ideaText = `
企画タイトル: ${idea.title ?? '（未定）'}
ターゲット読者: ${idea.target_reader ?? targetReader ?? '（未設定）'}
解決する悩み: ${idea.problem ?? '（未設定）'}
提供する価値: ${idea.value ?? '（未設定）'}
独自性: ${idea.uniqueness ?? '（未設定）'}
既存の構成案: ${idea.structure ?? '（なし）'}
価格帯: ${idea.price_range ?? '（未設定）'}`;

  return callClaude(systemPrompt, `【記事テーマ】${theme ?? '（未設定）'}\n\n【企画詳細】\n${ideaText}`, {
    tier: 'DEFAULT', maxTokens: 2048, task: 'idea_outline', employee: 'Writer',
  });
}

/**
 * アサヒへの直接企画依頼（市場調査なし、1回のAPI呼び出しで企画案を作成）
 *
 * @param {{ theme, purpose, usableFacts, avoid, notes }} opts
 * @returns {{ titles: string[], aim: string, freePart: string, paidPart: string, outline: string[], priceRationale?: string }}
 */
export async function runDirectPlanProposal({ theme, purpose, usableFacts, avoid, notes }) {
  const systemPrompt = loadPrompt('03_planner.md') + loadKotoriContext('Planner') + `

## 直接企画依頼モード

社長（山吹ことり）から直接、記事企画の依頼が来ました。
市場調査データはありません。本人から提供された情報と、ことりさんの活動領域だけを根拠にしてください。

【絶対に守ること】
- 「使ってよい事実・経験」欄に書かれていない体験・数字・感情は記事に含めない
- 本人が提供していない情報を「読み物として面白くするために」補完しない
- 「書かないでほしいこと」は企画のどこにも入れない
- 記事本文は書かない。企画だけ出す

以下のJSON形式で返してください:
{
  "titles": ["タイトル案1", "タイトル案2", "タイトル案3"],
  "aim": "この記事の狙い（1〜2文）",
  "free_part": "無料部分で見せる内容（箇条書き）",
  "paid_part": "有料部分で読者が持ち帰れるもの（箇条書き）",
  "outline": ["## 見出し1", "## 見出し2", "## 見出し3"],
  "price_rationale": "有料記事の場合、その価格に値する根拠（無料記事の場合はnull）",
  "price_suggestion": "500円〜1000円（任意）"
}
JSONのみ返してください。`;

  const userMessage = `【記事テーマ】
${theme}

【記事の目的】
${purpose || '未定'}

【今回使ってよい事実・経験】
${usableFacts || '（指定なし）'}

【書かないでほしいこと】
${avoid || '（指定なし）'}

【補足】
${notes || '（なし）'}`;

  const raw = await callClaude(systemPrompt, userMessage, {
    tier: 'DEFAULT', maxTokens: 4096, task: 'direct_plan', employee: 'Planner',
  });
  return extractJson(raw);
}

/**
 * Editor: 原稿をチェック
 * @returns {{ verdict: 'READY'|'REVISION_REQUIRED'|'BLOCKED', notes: string, revision_request: string }}
 */
export async function runEditor({ draft, selectedIdea, approvedKnowledge = [] }) {
  const systemPrompt = loadPrompt('05_editor.md') + loadKotoriContext('Editor') + buildKnowledgeContext(approvedKnowledge);
  const hasPaidPart = !!(draft.paid_part?.trim());
  const userMessage = `
【企画案】
${JSON.stringify(selectedIdea, null, 2)}

【原稿】
タイトル候補: ${JSON.stringify(draft.title_candidates)}
リード: ${draft.lead}
無料部分: ${draft.free_part}
有料部分: ${hasPaidPart ? draft.paid_part : '（なし — 全文無料記事）'}
まとめ: ${draft.summary}

以下のJSON形式で編集チェック結果を返してください:
{
  "verdict": "READY",
  "notes": "チェック内容の詳細",
  "revision_request": "修正指示（REVISION_REQUIREDの場合のみ具体的に記載）",
  "price_type": "FREE",
  "paid_appropriateness": "FREE_RECOMMENDED",
  "paid_appropriateness_reason": "有料適性の判定理由（1〜2文）"
}
verdictは READY / REVISION_REQUIRED / BLOCKED のいずれか。
price_type は FREE / PAID のいずれか。
paid_appropriateness は FREE_RECOMMENDED / PAID_READY / PAID_WEAK のいずれか。
有料部分がない場合は price_type=FREE, paid_appropriateness=FREE_RECOMMENDED を返すこと。
READYでも自動公開はしない。
JSONのみ返してください。`;

  const raw = await callClaude(systemPrompt, userMessage);
  return extractJson(raw);
}

/**
 * Growth: 売上データを分析
 * @returns {{ analysis: object }}
 */
export async function runGrowth({ projectTitle, salesRecords }) {
  const systemPrompt = loadPrompt('06_growth.md') + loadKotoriContext('Growth');
  const userMessage = `
商品タイトル: ${projectTitle}

売上データ:
${JSON.stringify(salesRecords, null, 2)}

以下のJSON形式で分析結果を返してください:
{
  "purchase_rate": "購入率（PVに対する購入率）",
  "revenue_total": 0,
  "revenue_by_period": [],
  "price_effectiveness": "価格の効果分析",
  "sns_contribution": "SNS流入の貢献度",
  "hypotheses": ["次回企画への仮説1", "仮説2"],
  "low_sample_warning": false
}
母数が少ないときは強い結論を出さない。JSONのみ返してください。`;

  const raw = await callClaude(systemPrompt, userMessage);
  return extractJson(raw);
}

/**
 * アオ：メトリクス分析（公開後3日・7日・手動トリガー時のみ呼ぶ）
 * @param {{ summary: object, project: object }} params
 * @returns {{ report: string, low_sample_warning: boolean, hypotheses: string[] }}
 */
export async function runMetricsAnalysis({ summary, project }) {
  const systemPrompt = loadPrompt('06_growth.md') + loadKotoriContext('Growth');

  const { records, latest, diff, daysSincePublish, milestones, publishedAt } = summary;
  const totalRecords = records.length;

  const userMessage = `
記事タイトル: ${project.theme ?? '（不明）'}
公開日: ${publishedAt ?? '（不明）'}
公開からの日数: ${daysSincePublish ?? '（不明）'}

最新データ（${latest?.record_date ?? '—'}）:
- インプレッション: ${latest?.impressions ?? '—'}
- PV: ${latest?.pv ?? '—'}
- スキ: ${latest?.likes ?? '—'}
- コメント: ${latest?.comments ?? '—'}
- 購入数: ${latest?.purchase_count ?? '—'}
- 売上: ${latest?.revenue != null ? '¥' + latest.revenue.toLocaleString() : '—'}

前回比:
${diff ? `- インプレッション: ${diff.impressions != null ? (diff.impressions >= 0 ? '+' : '') + diff.impressions : '—'}
- PV: ${diff.pv != null ? (diff.pv >= 0 ? '+' : '') + diff.pv : '—'}
- スキ: ${diff.likes != null ? (diff.likes >= 0 ? '+' : '') + diff.likes : '—'}
- 購入数: ${diff.purchases != null ? (diff.purchases >= 0 ? '+' : '') + diff.purchases : '—'}` : '（前回データなし）'}

3日後スナップショット: ${milestones.day3.snapshot ? JSON.stringify(milestones.day3.snapshot) : '（なし）'}
7日後スナップショット: ${milestones.day7.snapshot ? JSON.stringify(milestones.day7.snapshot) : '（なし）'}

全記録数: ${totalRecords}件

以下のJSON形式で分析してください:
{
  "report": "アオの報告文（簡潔に、です・ます調）",
  "hypotheses": ["次に試すべきこと・仮説1", "仮説2"],
  "low_sample_warning": true/false（母数が少なく強い結論が出せない場合はtrue）
}
母数が少ないときは強い結論を出さない。JSONのみ返してください。`;

  const raw = await callClaude(systemPrompt, userMessage);
  return extractJson(raw);
}

/** JSON文字列をオブジェクトに変換（コードブロック対応） */
function extractJson(text) {
  // ```json ... ``` 形式を除去
  const cleaned = text.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    // JSONが見つからない場合はテキストとして返す
    const match = cleaned.match(/\{[\s\S]*\}/);
    if (match) {
      try { return JSON.parse(match[0]); } catch { /* fall through */ }
    }
    throw new Error(`AIレスポンスのJSON解析に失敗: ${cleaned.slice(0, 200)}`);
  }
}

// ── Chat機能 ────────────────────────────────────────────────────────────────

const PERSONALITIES_PATH_CHAT = resolve(__dirname, '../config/employee_personalities.json');
let _personalitiesChat = null;
function getPersonalitiesChat() {
  if (!_personalitiesChat) {
    try { _personalitiesChat = JSON.parse(readFileSync(PERSONALITIES_PATH_CHAT, 'utf8')); }
    catch (_) { _personalitiesChat = {}; }
  }
  return _personalitiesChat;
}

/**
 * 社員個別Chatの返答を生成
 *
 * @param {string} empId - 'Scout'|'Analyst'|'Planner'|'Writer'|'Editor'|'Growth'
 * @param {string} userMessage - 社長のメッセージ（現在のメッセージ、切断しない）
 * @param {string} contextText - プロジェクトコンテキスト（業務モード時のみ使用）
 * @param {Array}  history     - 会話履歴 [{speaker, message}]
 * @param {object} opts
 * @param {'casual'|'work'} opts.chatMode
 *   casual = 雑談モード: Haiku固定、短いpersonaのみ、コスト最小
 *   work   = 業務相談モード: Sonnet、ロール別コンテキスト
 * @returns {Promise<string>}
 */
export async function runEmployeeChat(empId, userMessage, contextText, history = [], { chatMode = 'casual' } = {}) {
  const personalities = getPersonalitiesChat();
  const p = personalities[empId];

  if (chatMode === 'casual') {
    // ── 雑談モード: Haiku固定、短いpersonaのみ、最小コスト ──────────────────
    const systemPrompt = `あなたは山吹ことりの出版会社のAI社員「${p?.display_name ?? empId}」です。
ことりさんとの雑談に応じてください。

【キャラクター】
${p?.personality ?? 'プロフェッショナルに対応する'}

【話し方】
${p?.speech_style ?? '敬語で簡潔に'}

【ルール】
- 1〜3文程度で返答する
- 絵文字は使わない
- Snow flakesの詳細・記事内容・プロジェクト情報など業務情報を聞かれた場合は、推測せず「仕事の相談モードに切り替えると詳しい情報を参照できます」と案内する`;

    const messages = [];
    for (const h of history.slice(-5)) {
      messages.push({
        role: h.speaker === '社長' ? 'user' : 'assistant',
        content: (h.message ?? '').slice(0, 500),
      });
    }
    messages.push({ role: 'user', content: userMessage });

    return callClaude(systemPrompt, messages, {
      tier: 'CHEAP', maxTokens: 256, task: 'employee_chat_casual', employee: empId,
    });
  }

  // ── 業務相談モード: Sonnet、ロール別コンテキスト ─────────────────────────
  const promptFile = {
    Scout: '01_scout.md', Analyst: '02_analyst.md', Planner: '03_planner.md',
    Writer: '04_writer.md', Editor: '05_editor.md', Growth: '06_growth.md',
  }[empId];
  const rolePrompt   = promptFile ? loadPrompt(promptFile) : '';
  const addressForm  = p?.address_form  ?? '社長';
  const speechStyle  = p?.speech_style  ?? '';
  const meetingRole  = p?.meeting_role  ?? '';
  const firstMessage = p?.first_message ?? '';

  const systemPrompt = `あなたは山吹ことりの出版会社で働くAI社員「${p?.display_name ?? empId}」です。
社長（山吹ことり）から直接指示を受け、担当業務を遂行します。日本語で返答してください。

【あなたのキャラクター】
${p?.personality ?? 'プロフェッショナルに対応する'}

【話し方・文体】
${speechStyle || '敬語を使い、簡潔に話す'}

【会議での立ち位置】
${meetingRole || '担当業務の観点から意見を述べる'}

【担当業務・専門知識】
${rolePrompt}

【社長への呼称ルール】
- 社長を「${addressForm}」と呼ぶ
- 会話の冒頭・重要報告・確認依頼・提案の場面で自然に使う
- 毎文に入れない。連続する返答でも1〜2回程度が自然

【会話の原則】
- 1回の返答は1〜5文程度。長すぎず、味気なくしない
- 最初のメッセージでは必ず担当を名乗り、今できることを自然に伝える（例：${firstMessage}）
- 担当外の質問は「その件は〇〇が担当です」と案内する
- DB・実データに存在しない数値・情報を作らない
- 変更提案はするが、実行はしない（「反映しますか？」と確認する）
- 絵文字は使わない
- 「何でも聞いてください」で終わらない。担当らしい一言で締める
- 業務精度を落とさない。キャラクターは「言い方」に出す

${contextText ? `【現在のプロジェクト情報】\n${contextText}` : '現在アクティブなプロジェクトはありません。担当の観点から手伝えることを伝えてください。'}
${loadKotoriContext(empId)}`;

  // 過去履歴: 直近6件、各1000字上限。現在のメッセージは切断しない
  const messages = [];
  for (const h of history.slice(-6)) {
    messages.push({
      role: h.speaker === '社長' ? 'user' : 'assistant',
      content: (h.message ?? '').slice(0, 1000),
    });
  }
  messages.push({ role: 'user', content: userMessage });

  return callClaude(systemPrompt, messages, {
    tier: 'DEFAULT', maxTokens: 4096, task: 'employee_chat', employee: empId,
  });
}

/**
 * AI編集会議 — 議題に応じた社員が順番に意見を述べる
 *
 * @param {string} topic - 会議テーマ
 * @param {string} projectContext - プロジェクト概要（buildEmployeeContext済みの短いテキスト）
 * @param {object} opts
 * @param {'full'|'revision'|'writing'|'strategy'|'analysis'} opts.mode
 *   full     = 全6名（デフォルト）
 *   revision = Writer + Editor のみ（文章修正系）
 *   writing  = Planner + Writer + Editor
 *   strategy = Scout + Analyst + Planner + Growth
 *   analysis = Scout + Analyst + Growth
 * @returns {Promise<Array<{empId, name, role, message}>>}
 */
export async function runEditorialMeeting(topic, projectContext, { mode = 'full' } = {}) {
  const personalities = getPersonalitiesChat();

  const ALL_EMPLOYEES = [
    { id: 'Scout',   viewpoint: '市場調査・競合の観点' },
    { id: 'Analyst', viewpoint: 'データ分析・市場傾向の観点' },
    { id: 'Planner', viewpoint: '商品企画・方向性の観点' },
    { id: 'Writer',  viewpoint: '執筆・内容の観点' },
    { id: 'Editor',  viewpoint: '品質・ブランドの観点' },
    { id: 'Growth',  viewpoint: '販売・収益の観点' },
  ];

  // モード別参加メンバー（議題に不要な社員を呼ばない）
  const MODE_MEMBERS = {
    full:     ['Scout', 'Analyst', 'Planner', 'Writer', 'Editor', 'Growth'],
    revision: ['Writer', 'Editor'],
    writing:  ['Planner', 'Writer', 'Editor'],
    strategy: ['Scout', 'Analyst', 'Planner', 'Growth'],
    analysis: ['Scout', 'Analyst', 'Growth'],
  };
  const activeIds = new Set(MODE_MEMBERS[mode] ?? MODE_MEMBERS.full);
  const ORDER = ALL_EMPLOYEES.filter(e => activeIds.has(e.id));

  // ── 会議用共通ブリーフ（ローカル組み立て、AI呼び出しなし）────────────────
  const meetingBrief = [
    `## 会議テーマ\n${topic}`,
    projectContext ? `## プロジェクト概要\n${projectContext.slice(0, 500)}` : '',
  ].filter(Boolean).join('\n\n');

  const results = [];
  let prevSummary = ''; // 全文累積ではなく要点だけ保持（~100字/人）

  for (const emp of ORDER) {
    const p = personalities[emp.id];

    const systemPrompt = `あなたは山吹ことりの出版会社のAI社員「${p?.display_name ?? emp.id}」です。
AI編集会議に参加しています。${emp.viewpoint}から短く意見を述べてください。

【あなたのキャラクター】
${p?.personality ?? ''}

【話し方・文体】
${p?.speech_style ?? '敬語で簡潔に'}

【会議ルール】
- 返答は2〜4文程度で簡潔に
- 断定しない。「〜が良いと思います」「〜の可能性があります」など
- 絵文字は使わない
- キャラクターは「言い方」に出す。業務精度は落とさない
${loadKotoriContext(emp.id, { forMeeting: true })}`;

    const userMsg = [
      meetingBrief,
      prevSummary ? `【これまでの発言要点】\n${prevSummary.trimEnd()}` : '',
      `${emp.viewpoint}から、2〜4文で意見を述べてください。`,
    ].filter(Boolean).join('\n\n');

    try {
      const msg = await callClaude(systemPrompt, userMsg, {
        tier: 'DEFAULT', maxTokens: 256, task: 'editorial_meeting', employee: emp.id,
      });

      results.push({ empId: emp.id, name: p?.display_name ?? emp.id, role: emp.id, message: msg });
      // 要点だけ保持（100字以内）
      prevSummary += `${p?.display_name ?? emp.id}：${msg.replace(/\n/g, ' ').slice(0, 100)}\n`;
    } catch (e) {
      results.push({ empId: emp.id, name: p?.display_name ?? emp.id, role: emp.id, message: `（エラー: ${e.message.slice(0, 80)}）` });
    }
  }

  return results;
}

// ── 学び抽出AI ────────────────────────────────────────────────────────────────

/**
 * キイロ（Editor）が公開承認された記事の修正履歴から「学び候補」を抽出する。
 *
 * @param {{
 *   directEdits: Array<{ version: number, diff_json: string }>,
 *   ownerReviews: Array<{ version: number, owner_review_instruction: string, changes_summary: string }>,
 *   projectTheme: string
 * }} opts
 * @returns {Promise<Array<{
 *   category: 'FACT'|'PRIVACY'|'STYLE'|'EDITORIAL_RULE'|'ARTICLE_SPECIFIC'|'REJECTED',
 *   rule_text: string,
 *   source_type: 'DIRECT_EDIT'|'OWNER_REVIEW',
 *   source_draft_version: number,
 *   reason: string
 * }>>}
 */
export async function runLearningsExtractor({ directEdits, ownerReviews, projectTheme }) {
  const systemPrompt = loadKotoriContext('Editor') + `

あなたは編集長キイロです。
山吹ことりが記事を公開OKした後、その記事の修正履歴から「今後のルールとして使えそうな学び」を抽出します。

【抽出の方針】
- 直接編集（本人が直接書き換えた差分）は最も信頼度が高い学習材料です
- 本人レビュー指示（修正を依頼した文章）は参考にはなりますが、一般化しすぎないこと
- 1回の修正から過剰に一般化しない
- 「この記事だけに当てはまること」は ARTICLE_SPECIFIC にする
- 複数の記事に適用できそうなものだけ FACT / PRIVACY / STYLE / EDITORIAL_RULE にする
- 抽出数は最大5件まで（絞って質を上げること）
- 明らかに学びにならないものは出さない

【カテゴリの使い分け】
- FACT: 山吹ことりに関する正確な事実（経歴・プロジェクトの背景など）
- PRIVACY: 公開してはいけない個人情報・職業情報など
- STYLE: 表記・言い回しのルール
- EDITORIAL_RULE: 記事構成・内容作りのルール
- ARTICLE_SPECIFIC: この記事固有のこと（グローバルルールに昇格させない）
- REJECTED: 誤って学び候補に入ったが、ルール化すべきでないもの

【出力形式（JSONのみ）】
{
  "learnings": [
    {
      "category": "STYLE",
      "rule_text": "〜する",
      "source_type": "DIRECT_EDIT",
      "source_draft_version": 3,
      "reason": "なぜこれが学びになるか（1文）"
    }
  ]
}
learnings が空の場合は {"learnings": []} を返してください。
JSONのみ返してください。`;

  // 直接編集の差分を整形
  const directEditSections = directEdits.map(e => {
    let diffText = '';
    try {
      const diff = typeof e.diff_json === 'string' ? JSON.parse(e.diff_json) : e.diff_json;
      if (diff) {
        const parts = [];
        for (const [section, d] of Object.entries(diff)) {
          if (d?.removed?.length || d?.added?.length) {
            const lines = [];
            d.removed?.forEach(l => lines.push(`  削除: ${l}`));
            d.added?.forEach(l  => lines.push(`  追加: ${l}`));
            parts.push(`[${section}]\n${lines.join('\n')}`);
          }
        }
        diffText = parts.join('\n\n');
      }
    } catch { diffText = '（diff解析失敗）'; }
    return `--- 直接編集 v${e.version} ---\n${diffText || '（差分なし）'}`;
  }).join('\n\n');

  // 本人レビュー指示を整形
  const reviewSections = ownerReviews.map(r =>
    `--- 本人レビュー指示 v${r.version} ---\n修正指示: ${r.owner_review_instruction}\n変更概要: ${r.changes_summary ?? '—'}`
  ).join('\n\n');

  const userMessage = `記事テーマ: ${projectTheme ?? '（不明）'}

【直接編集の履歴】
${directEditSections || '（直接編集なし）'}

【本人レビュー指示の履歴】
${reviewSections || '（本人レビュー指示なし）'}

上記の修正履歴から、今後の記事執筆に活かせる「学び候補」を抽出してください。`;

  const raw = await callClaude(systemPrompt, userMessage, {
    tier: 'CHEAP', task: 'learnings_extractor', employee: 'Editor',
  });
  const parsed = extractJson(raw);
  return parsed?.learnings ?? [];
}
