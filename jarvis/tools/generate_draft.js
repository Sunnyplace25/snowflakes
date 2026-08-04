#!/usr/bin/env node
/**
 * Snow flakes JARVIS - 下書き生成ツール
 * generate_draft.js  v0.1.0
 *
 * 使用方法:
 *   node tools/generate_draft.js
 *
 * 方針:
 *   - Node.js 標準機能のみ使用（外部パッケージなし）
 *   - Anthropic API 未使用（テンプレート方式）
 *   - 外部への投稿・git操作は一切行わない
 *   - 生成した下書きは drafts/pending/ へ保存する
 *   - ログにはAPIキー・プロンプト全文・個人情報を記録しない
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import crypto from 'crypto';
import { fileURLToPath } from 'url';

// ── パス設定 ────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const JARVIS_ROOT = path.resolve(__dirname, '..');
const PENDING_DIR = path.join(JARVIS_ROOT, 'drafts', 'pending');
const LOG_DIR = path.join(JARVIS_ROOT, 'logs');
const SETTINGS_PATH = path.join(JARVIS_ROOT, 'config', 'settings.json');

// ── 定数 ────────────────────────────────────────────────────────
const TOOL_VERSION = '0.1.0';

const DRAFT_TYPES = {
  '1': { id: 'site_update',      label: 'サイト更新案' },
  '2': { id: 'sns_x',            label: 'X（Twitter）投稿文' },
  '3': { id: 'sns_instagram',    label: 'Instagram投稿文' },
  '4': { id: 'news',             label: 'ニュース・お知らせ' },
  '5': { id: 'activity_report',  label: '活動報告' },
};

// ── ユーティリティ ───────────────────────────────────────────────

function loadSettings() {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function generateId() {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, '');
  const rand = crypto.randomBytes(3).toString('hex');
  return `draft_${date}_${rand}`;
}

function nowJST() {
  return new Date().toLocaleString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).replace(/\//g, '-');
}

function nowISO() {
  const d = new Date();
  const offset = '+09:00';
  const local = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return local.toISOString().slice(0, 19) + offset;
}

function writeLog(message) {
  // ログ: 操作種別・日時・成否のみ記録。APIキー・プロンプト全文・個人情報は含まない。
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    const logPath = path.join(LOG_DIR, 'history.log');
    const line = `[${nowJST()}] ${message}\n`;
    fs.appendFileSync(logPath, line, 'utf-8');
  } catch {
    // ログ書き込み失敗は処理を止めない
  }
}

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function ask(rl, question) {
  return new Promise(resolve => rl.question(question, resolve));
}

function hr(char = '─', width = 50) {
  return char.repeat(width);
}

function printBox(title, lines) {
  console.log('\n' + hr('═'));
  console.log(`  ${title}`);
  console.log(hr('─'));
  lines.forEach(l => console.log(`  ${l}`));
  console.log(hr('═') + '\n');
}

// ── テンプレート生成 ─────────────────────────────────────────────

function buildTemplate(type, inputs) {
  const { title, summary, scheduledDate, relatedUrls, hashtags, notes } = inputs;

  const base = {
    id: generateId(),
    created_at: nowISO(),
    type: type.id,
    status: 'pending',
    meta: {
      generated_by: `generate_draft.js v${TOOL_VERSION}`,
      template_version: '1.0',
      approved_by: null,
      approved_at: null,
      published_at: null,
      published_url: null,
    },
  };

  switch (type.id) {
    case 'site_update':
      return {
        ...base,
        content: {
          title,
          summary,
          scheduled_date: scheduledDate || null,
          related_file_paths: relatedUrls || [],
          notes: notes || '',
        },
      };

    case 'sns_x':
      return {
        ...base,
        content: {
          title,
          body: summary,
          hashtags: hashtags || [],
          media_paths: [],
          scheduled_date: scheduledDate || null,
          url: null,
          char_count_estimate: summary.length + (hashtags || []).join(' ').length,
          _note: 'URL付き投稿はAPI料金が増加する可能性があります。実行前に費用概算を確認してください。',
        },
      };

    case 'sns_instagram':
      return {
        ...base,
        content: {
          title,
          caption: summary,
          hashtags: hashtags || [],
          media_paths: [],
          scheduled_date: scheduledDate || null,
          _note: 'Instagramへの投稿にはMeta Graph API接続が必要です。現在は下書き保存のみ。',
        },
      };

    case 'news':
    case 'activity_report':
      return {
        ...base,
        content: {
          title,
          body: summary,
          scheduled_date: scheduledDate || null,
          related_file_paths: relatedUrls || [],
          notes: notes || '',
        },
      };

    default:
      return { ...base, content: { title, summary } };
  }
}

function formatDraftForDisplay(draft) {
  const lines = [];
  lines.push(`ID          : ${draft.id}`);
  lines.push(`種別        : ${draft.type}`);
  lines.push(`作成日時    : ${draft.created_at}`);
  lines.push(`ステータス  : ${draft.status}`);
  lines.push('');
  lines.push('【内容】');
  const c = draft.content;
  Object.entries(c).forEach(([k, v]) => {
    if (k.startsWith('_')) return;
    const val = Array.isArray(v) ? (v.length ? v.join(', ') : '（なし）') : (v ?? '（未設定）');
    lines.push(`  ${k.padEnd(18)}: ${val}`);
  });
  if (draft.content._note) {
    lines.push('');
    lines.push(`  ⚠️  ${draft.content._note}`);
  }
  return lines;
}

// ── メイン処理 ───────────────────────────────────────────────────

async function main() {
  const settings = loadSettings();

  console.log('\n' + hr('═'));
  console.log('  Snow flakes JARVIS - 下書き生成ツール v' + TOOL_VERSION);
  console.log('  ※ この操作は下書き保存のみです。外部への投稿は行いません。');
  console.log(hr('═'));

  if (!settings) {
    console.error('\n[エラー] config/settings.json が読み込めません。');
    writeLog('ERROR: generate_draft.js 起動失敗 - settings.json 読み込みエラー');
    process.exit(1);
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {
    // ── ステップ1: 下書き種別の選択 ──
    console.log('\n下書きの種別を選択してください：\n');
    Object.entries(DRAFT_TYPES).forEach(([k, v]) => {
      console.log(`  ${k}. ${v.label}`);
    });
    console.log('  0. キャンセル');

    const typeChoice = await ask(rl, '\n番号を入力 > ');
    if (typeChoice.trim() === '0') {
      console.log('\nキャンセルしました。\n');
      writeLog('INFO: generate_draft.js - ユーザーによりキャンセル');
      rl.close();
      return;
    }

    const selectedType = DRAFT_TYPES[typeChoice.trim()];
    if (!selectedType) {
      console.error('\n[エラー] 無効な選択です。\n');
      writeLog('ERROR: generate_draft.js - 無効な種別選択');
      rl.close();
      process.exit(1);
    }

    console.log(`\n選択: ${selectedType.label}\n` + hr('─'));

    // ── ステップ2: 情報入力 ──
    const title = await ask(rl, 'タイトル（必須）> ');
    if (!title.trim()) {
      console.error('\n[エラー] タイトルは必須です。\n');
      rl.close();
      process.exit(1);
    }

    let summaryPrompt = '内容・本文（必須）> ';
    if (selectedType.id === 'sns_x') summaryPrompt = '投稿文（必須・140文字目安）> ';
    if (selectedType.id === 'sns_instagram') summaryPrompt = 'キャプション（必須）> ';

    const summary = await ask(rl, summaryPrompt);
    if (!summary.trim()) {
      console.error('\n[エラー] 内容は必須です。\n');
      rl.close();
      process.exit(1);
    }

    const scheduledDate = await ask(rl, '公開予定日（任意・例: 2026-08-10）> ');

    let hashtags = [];
    if (selectedType.id === 'sns_x' || selectedType.id === 'sns_instagram') {
      const hashtagInput = await ask(rl, 'ハッシュタグ（任意・スペース区切り・例: #snowflakes #music）> ');
      hashtags = hashtagInput.trim()
        ? hashtagInput.trim().split(/\s+/).filter(h => h.startsWith('#'))
        : [];
    }

    let relatedUrls = [];
    if (selectedType.id === 'site_update' || selectedType.id === 'news' || selectedType.id === 'activity_report') {
      const pathInput = await ask(rl, '関連ファイルパス（任意・スペース区切り・絶対パス不可）> ');
      relatedUrls = pathInput.trim() ? pathInput.trim().split(/\s+/) : [];
    }

    const notes = await ask(rl, '備考・メモ（任意）> ');

    rl.close();

    // ── ステップ3: 下書き生成 ──
    const inputs = {
      title: title.trim(),
      summary: summary.trim(),
      scheduledDate: scheduledDate.trim() || null,
      hashtags,
      relatedUrls,
      notes: notes.trim(),
    };

    const draft = buildTemplate(selectedType, inputs);

    // ── ステップ4: プレビュー表示 ──
    printBox('【下書きプレビュー】', formatDraftForDisplay(draft));

    // ── ステップ5: pending/へ保存（上書き防止・最大10回リトライ）──
    ensureDir(PENDING_DIR);

    let savedFilename = null;
    const MAX_RETRY = 10;

    for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
      // 1回目は元のID、2回目以降は新しいIDを生成する
      const candidateId = attempt === 0 ? draft.id : generateId();
      const candidateFilename = `${candidateId}.json`;
      const candidateFilepath = path.join(PENDING_DIR, candidateFilename);

      if (!fs.existsSync(candidateFilepath)) {
        // 存在しない場合のみ書き込む（既存ファイルは絶対に上書きしない）
        fs.writeFileSync(candidateFilepath, JSON.stringify(
          { ...draft, id: candidateId }, null, 2
        ), 'utf-8');
        savedFilename = candidateFilename;
        break;
      }
    }

    if (!savedFilename) {
      console.error('\n[エラー] 保存先ファイル名の生成に10回失敗しました。');
      console.error('   既存ファイルは変更されていません。');
      console.error('   時間をおいてから再度実行してください。\n');
      writeLog(`ERROR: generate_draft.js - ファイル名重複につき保存中止 type=${draft.type}`);
      process.exit(1);
    }

    console.log(`✅ 下書きを保存しました:`);
    console.log(`   jarvis/drafts/pending/${savedFilename}`);
    console.log('\n⚠️  この下書きは承認されるまで外部へ送信されません。');
    console.log('   承認する場合は、担当者に確認を依頼してください。\n');

    writeLog(`INFO: generate_draft.js - 下書き生成完了 type=${draft.type} file=${savedFilename}`);

  } catch (err) {
    console.error('\n[エラー] 予期しないエラーが発生しました:', err.message);
    writeLog(`ERROR: generate_draft.js - 予期しないエラー: ${err.message}`);
    rl.close();
    process.exit(1);
  }
}

main();
