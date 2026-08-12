/**
 * jarvis/ai/openai_reviewer.mjs
 * OpenAI Responses API を使ってコードレビューを行う。
 *
 * - APIキーは process.env.OPENAI_API_KEY からのみ取得
 * - APIキーをログ・ファイルに出力しない
 * - Structured Output (json_schema) で必ず決められた JSON を返す
 * - 入力サイズ上限: 120,000 文字
 * - API失敗時の最大リトライ: 2回
 */

import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath }    from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** モデル名はここ1箇所で変更する */
const DEFAULT_MODEL        = process.env.OPENAI_REVIEW_MODEL ?? 'gpt-5.6-terra';
const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
const INPUT_SIZE_LIMIT     = 120_000;
const MAX_RETRIES          = 2;

/** OpenAI Structured Output 用 JSON Schema */
export const REVIEW_SCHEMA = {
  type: 'object',
  properties: {
    decision: {
      type: 'string',
      enum: ['approve', 'revise', 'needs_user'],
    },
    summary: { type: 'string' },
    issues: {
      type:  'array',
      items: {
        type: 'object',
        properties: {
          severity: { type: 'string', enum: ['high', 'medium', 'low'] },
          file:     { type: 'string' },
          problem:  { type: 'string' },
          fix:      { type: 'string' },
        },
        required:             ['severity', 'file', 'problem', 'fix'],
        additionalProperties: false,
      },
    },
    instructions_to_claude: { type: 'string' },
    user_question:          { type: 'string' },
  },
  required: ['decision', 'summary', 'issues', 'instructions_to_claude', 'user_question'],
  additionalProperties: false,
};

function loadReviewRules() {
  try {
    return readFileSync(resolve(__dirname, 'REVIEW_RULES.md'), 'utf8');
  } catch {
    return '(REVIEW_RULES.md not found)';
  }
}

/**
 * レビュー用の入力テキストを組み立てる。
 */
export function buildReviewInput({ task, claudeReport, diff, diffStat, testResult }) {
  const rules       = loadReviewRules();
  const testSummary = testResult
    ? `${testResult.passed ?? '?'} passed / ${testResult.failed ?? '?'} failed`
    : '(no test result)';

  return [
    `# REVIEW_RULES\n${rules}`,
    `# Task\n${task}`,
    `# Claude Report\n${claudeReport}`,
    `# Test Result\n${testSummary}`,
    `# git diff --stat\n${diffStat || '(empty)'}`,
    `# git diff\n${diff || '(empty)'}`,
  ].join('\n\n---\n\n');
}

/**
 * コードレビューを実行する。
 *
 * @param {{
 *   task:         string,
 *   claudeReport: string,
 *   diff:         string,
 *   diffStat:     string,
 *   testResult:   { passed: number, failed: number } | null,
 * }} payload
 * @param {{
 *   fetchFn?: Function,   // テスト用インジェクション
 *   apiKey?:  string,     // 省略時は process.env.OPENAI_API_KEY
 *   model?:   string,
 * }} options
 * @returns {Promise<{
 *   decision:               'approve'|'revise'|'needs_user',
 *   summary:                string,
 *   issues:                 Array,
 *   instructions_to_claude: string,
 *   user_question:          string,
 * }>}
 */
export async function reviewCode(payload, {
  fetchFn = fetch,
  apiKey  = null,
  model   = null,
} = {}) {
  const key = apiKey ?? process.env.OPENAI_API_KEY;
  if (!key) throw new Error('OPENAI_API_KEY が設定されていません');

  const reviewModel = model ?? DEFAULT_MODEL;
  const inputText   = buildReviewInput(payload);

  if (inputText.length > INPUT_SIZE_LIMIT) {
    throw new Error(
      `レビュー入力が上限(${INPUT_SIZE_LIMIT}文字)を超えています: ${inputText.length}文字`
    );
  }

  let lastError;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const res = await fetchFn(OPENAI_RESPONSES_URL, {
        method:  'POST',
        headers: {
          'Content-Type':  'application/json',
          'Authorization': `Bearer ${key}`,
        },
        body: JSON.stringify({
          model: reviewModel,
          input: [
            {
              role:    'system',
              content: 'あなたはコードレビュアーです。与えられたルールに従い、task・実装・テスト結果を厳密にレビューし、必ず指定のJSON形式で回答してください。',
            },
            {
              role:    'user',
              content: inputText,
            },
          ],
          text: {
            format: {
              type:   'json_schema',
              name:   'review_result',
              strict: true,
              schema: REVIEW_SCHEMA,
            },
          },
        }),
      });

      if (!res.ok) {
        const body = await res.text();
        // レスポンスボディにキーが含まれていても出力しない
        throw new Error(`OpenAI API HTTP ${res.status}`);
      }

      const data = await res.json();

      // Responses API: output[0].content[0].text または output_text
      const outputText =
        data?.output_text ??
        data?.output?.[0]?.content?.[0]?.text ??
        null;

      if (!outputText) {
        throw new Error('Responses API レスポンスから output text を取得できませんでした');
      }

      let parsed;
      try {
        parsed = JSON.parse(outputText);
      } catch {
        // Structured Output が壊れている → approve 扱いにせず失敗
        throw new Error(`Structured Output のパース失敗: ${String(outputText).slice(0, 200)}`);
      }

      // 必須フィールド検証
      if (!['approve', 'revise', 'needs_user'].includes(parsed?.decision)) {
        throw new Error(`Structured Output 不正: decision="${parsed?.decision}"`);
      }

      return parsed;
    } catch (e) {
      lastError = e;
      if (attempt < MAX_RETRIES - 1) {
        await new Promise(r => setTimeout(r, 1_000));
      }
    }
  }

  throw new Error(`OpenAI レビュー失敗 (${MAX_RETRIES}回試行): ${lastError?.message}`);
}
