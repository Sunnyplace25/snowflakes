#!/usr/bin/env node
/**
 * Snow flakes JARVIS - note記事エクスポート
 * export_note_draft.js v0.1.0
 *
 * 使用方法（jarvis/ ディレクトリから実行）:
 *   npm run note-export -- <draft-id>
 *
 * 方針:
 *   - Node.js 標準機能のみ使用（外部パッケージなし）
 *   - 外部通信・note API・OAuth 認証なし
 *   - approved フォルダ内の platform=note / type=note_article の下書きのみを対象とする
 *   - 本文・status・approved_at・scheduled_at・コンテンツフィールドは一切変更しない
 *   - エクスポート成功後のみ meta.export を更新する（失敗時は meta を変更しない）
 *   - 出力先: jarvis/exports/note/
 *   - ファイル名: note_{draft-id}_{YYYYMMDD}.{ext}（タイトルは含めない）
 *   - 上書き禁止: _2, _3 サフィックスで重複回避
 *   - ログにタイトル・本文・コンテンツ詳細を記録しない
 */

import fs       from 'fs';
import path     from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

// ── パス設定 ─────────────────────────────────────────────────────
const __filename  = fileURLToPath(import.meta.url);
const __dirname   = path.dirname(__filename);
const JARVIS_ROOT = path.resolve(__dirname, '..');
const APPROVED_DIR = path.join(JARVIS_ROOT, 'drafts', 'approved');
const EXPORTS_DIR  = path.join(JARVIS_ROOT, 'exports', 'note');
const LOG_DIR      = path.join(JARVIS_ROOT, 'logs');
const LOG_PATH     = path.join(LOG_DIR, 'history.log');

const TOOL_VERSION = '0.1.0';
const VALID_ID_RE  = /^draft_\d{8}_[0-9a-f]{6}$/;

// ── ユーティリティ ────────────────────────────────────────────────

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
  return new Date(d.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 19) + '+09:00';
}

function todayYYYYMMDD() {
  const jst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10).replace(/-/g, '');
}

function writeLog(parts) {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_PATH, `[${nowJST()}] ${parts.join(' | ')}\n`, 'utf-8');
  } catch { /* ログ失敗は処理を止めない */ }
}

function hr(char = '─', width = 60) { return char.repeat(width); }

function validateId(id) {
  if (!id)                   return { ok: false, reason: 'IDが指定されていません' };
  if (!VALID_ID_RE.test(id)) return { ok: false, reason: `不正なID形式: "${id}"` };
  return { ok: true };
}

function readDraftFile(filePath) {
  if (!fs.existsSync(filePath)) return { ok: false, reason: 'ファイルが見つかりません' };
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return { ok: true, data: JSON.parse(raw) };
  } catch (e) {
    return { ok: false, reason: e instanceof SyntaxError ? 'JSONが破損しています' : `読み込みエラー: ${e.message}` };
  }
}

// ── ファイル名の重複回避 ──────────────────────────────────────────

function resolveOutputPath(dir, baseName, ext) {
  const candidate = path.join(dir, `${baseName}.${ext}`);
  if (!fs.existsSync(candidate)) return candidate;
  for (let i = 2; i <= 99; i++) {
    const p = path.join(dir, `${baseName}_${i}.${ext}`);
    if (!fs.existsSync(p)) return p;
  }
  throw new Error('同名ファイルが多すぎます（最大99件）');
}

// ── meta.export のみ安全更新 ─────────────────────────────────────
// エクスポートファイル書き込み成功後のみ呼び出すこと

function updateMetaExport(draftPath, draft, exportRelPath, format) {
  const tmpPath = draftPath + '.tmp';
  const cleanup = () => { try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {} };
  try {
    const updated = {
      ...draft,
      meta: {
        ...(draft.meta || {}),
        export: {
          last_exported_at: nowISO(),
          format,
          path: exportRelPath,
        },
      },
    };
    fs.writeFileSync(tmpPath, JSON.stringify(updated, null, 2), 'utf-8');
    JSON.parse(fs.readFileSync(tmpPath, 'utf-8'));
    fs.renameSync(tmpPath, draftPath);
    return { ok: true };
  } catch (e) {
    cleanup();
    return { ok: false, reason: e.message };
  }
}

// ── Markdown 生成 ────────────────────────────────────────────────

function buildMarkdown(c) {
  const parts = [];
  parts.push(`# ${c.title}`);
  parts.push('');

  if (c.lead) {
    parts.push(c.lead);
    parts.push('');
  }

  parts.push(c.body);

  if (Array.isArray(c.headings) && c.headings.length > 0) {
    parts.push('');
    parts.push('== 見出し構成メモ ==');
    for (const h of c.headings) parts.push(h);
  }

  parts.push('');
  parts.push('---');
  parts.push('');

  if (c.summary) {
    parts.push(c.summary);
    parts.push('');
  }

  if (Array.isArray(c.hashtags) && c.hashtags.length > 0) {
    parts.push(c.hashtags.map(t => `#${t}`).join(' '));
  }

  return parts.join('\n');
}

// ── プレーンテキスト生成 ─────────────────────────────────────────

function buildText(c) {
  const parts = [];
  parts.push(c.title);
  parts.push('');

  if (c.lead) {
    parts.push(c.lead);
    parts.push('');
  }

  parts.push(c.body);

  if (Array.isArray(c.headings) && c.headings.length > 0) {
    parts.push('');
    parts.push('== 見出し構成メモ ==');
    for (const h of c.headings) parts.push(h);
  }

  parts.push('');

  if (c.summary) {
    parts.push(c.summary);
    parts.push('');
  }

  if (Array.isArray(c.hashtags) && c.hashtags.length > 0) {
    parts.push(c.hashtags.map(t => `#${t}`).join(' '));
  }

  return parts.join('\n');
}

// ── JSON 生成（content のみ）────────────────────────────────────

function buildJSON(c) {
  return JSON.stringify(c, null, 2);
}

// ── コマンド: export ──────────────────────────────────────────────

async function cmdExport(id) {
  const v = validateId(id);
  if (!v.ok) { console.error(`\n[エラー] ${v.reason}\n`); process.exit(1); }

  const filePath = path.join(APPROVED_DIR, `${id}.json`);
  const result   = readDraftFile(filePath);
  if (!result.ok) {
    console.error(`\n[エラー] ${result.reason}（approved/${id}.json）\n`);
    writeLog(['EXPORT_NOTE', `id=${id}`, 'platform=note', 'result=FAIL', `reason=${result.reason}`]);
    process.exit(1);
  }

  const draft = result.data;

  // バリデーション
  if (draft.status !== 'approved') {
    const reason = `status が approved ではありません: ${draft.status}`;
    console.error(`\n[エラー] ${reason}\n`);
    writeLog(['EXPORT_NOTE', `id=${id}`, 'platform=note', 'result=FAIL', `reason=${reason}`]);
    process.exit(1);
  }
  if (draft.platform !== 'note') {
    const reason = `platform が note ではありません: ${draft.platform}`;
    console.error(`\n[エラー] ${reason}\n`);
    writeLog(['EXPORT_NOTE', `id=${id}`, 'platform=note', 'result=FAIL', `reason=${reason}`]);
    process.exit(1);
  }
  if (draft.type !== 'note_article') {
    const reason = `type が note_article ではありません: ${draft.type}`;
    console.error(`\n[エラー] ${reason}\n`);
    writeLog(['EXPORT_NOTE', `id=${id}`, 'platform=note', 'result=FAIL', `reason=${reason}`]);
    process.exit(1);
  }

  const c = draft.content || {};

  // フォーマット選択
  console.log('\n' + hr('═'));
  console.log('  Snow flakes JARVIS - note記事エクスポート');
  console.log(hr('─'));
  console.log(`  ID: ${id}`);
  console.log(hr('─'));
  console.log('  エクスポート形式を選択してください:');
  console.log('    1. Markdown（.md）');
  console.log('    2. プレーンテキスト（.txt）');
  console.log('    3. JSON（.json、contentフィールドのみ）');

  const rl  = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = q => new Promise(resolve => rl.question(q, resolve));

  let format = '';
  let ext    = '';
  while (!format) {
    const m = (await ask('番号を入力> ')).trim();
    if (m === '1')      { format = 'markdown'; ext = 'md'; }
    else if (m === '2') { format = 'text';     ext = 'txt'; }
    else if (m === '3') { format = 'json';     ext = 'json'; }
    else { console.log('  1、2、3 のいずれかを入力してください。'); }
  }
  rl.close();

  // 出力先の決定（上書き禁止）
  if (!fs.existsSync(EXPORTS_DIR)) fs.mkdirSync(EXPORTS_DIR, { recursive: true });
  const baseName = `note_${id}_${todayYYYYMMDD()}`;

  let outputPath;
  try {
    outputPath = resolveOutputPath(EXPORTS_DIR, baseName, ext);
  } catch (e) {
    console.error(`\n[エラー] ${e.message}\n`);
    writeLog(['EXPORT_NOTE', `id=${id}`, 'platform=note', `format=${format}`, 'result=FAIL', `reason=${e.message}`]);
    process.exit(1);
  }

  // コンテンツ生成
  let content;
  if (format === 'markdown')   { content = buildMarkdown(c); }
  else if (format === 'text')  { content = buildText(c); }
  else                          { content = buildJSON(c); }

  // ファイル書き込み
  try {
    fs.writeFileSync(outputPath, content, 'utf-8');
  } catch (e) {
    console.error(`\n[エラー] ファイルの書き込みに失敗しました: ${e.message}\n`);
    writeLog(['EXPORT_NOTE', `id=${id}`, 'platform=note', `format=${format}`, 'result=FAIL', `reason=${e.message}`]);
    process.exit(1);
  }

  // エクスポート成功後のみ meta.export を更新
  const exportRelPath = path.relative(JARVIS_ROOT, outputPath).replace(/\\/g, '/');
  const metaResult    = updateMetaExport(filePath, draft, exportRelPath, format);

  if (!metaResult.ok) {
    console.log(`\n⚠️  meta.export の更新に失敗しました（エクスポートファイルは正常に作成されました）: ${metaResult.reason}`);
  }

  console.log(`\n✅ エクスポート完了`);
  console.log(`   形式: ${format}`);
  console.log(`   出力先: ${exportRelPath}\n`);
  writeLog(['EXPORT_NOTE', `id=${id}`, 'platform=note', `format=${format}`, 'result=SUCCESS']);
}

// ── エントリーポイント ─────────────────────────────────────────────

const args    = process.argv.slice(2);
const command = args[0];
const draftId = args[1];

switch (command) {
  case 'export': await cmdExport(draftId); break;
  default:
    console.error(`\n[エラー] 不明なコマンド: ${command || '（未指定）'}`);
    console.error('使用可能なコマンド: export\n');
    process.exit(1);
}
