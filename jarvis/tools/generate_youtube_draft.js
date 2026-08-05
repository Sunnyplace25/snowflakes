#!/usr/bin/env node
/**
 * Snow flakes JARVIS - YouTube下書き生成ツール
 * generate_youtube_draft.js v0.1.0
 *
 * 使用方法（jarvis/ ディレクトリから実行）:
 *   npm run youtube-draft
 *
 * 方針:
 *   - Node.js 標準機能のみ使用（外部パッケージなし）
 *   - YouTube API への接続なし・動画アップロードなし
 *   - OAuth 認証を実装しない
 *   - 外部通信なし・git 操作なし
 *   - ログに動画タイトル・説明文・タグを記録しない
 *
 * 将来の YouTube API 接続について（第4段階後半で別途実装）:
 *   content.scheduled_at → YouTube API status.publishAt
 *   同時に status.privacyStatus = "private" を設定する
 *   公開済み動画は予約公開の対象にしない。
 *   第4段階後半では YouTube Data API v3 のインストール済みアプリ向け
 *   OAuth 2.0 認証を採用する。具体的な認証方式は実装時点の
 *   Google 公式仕様を確認して決定する。
 */

import fs       from 'fs';
import path     from 'path';
import readline from 'readline';
import crypto   from 'crypto';
import { fileURLToPath } from 'url';

// ── パス設定 ─────────────────────────────────────────────────────
const __filename    = fileURLToPath(import.meta.url);
const __dirname     = path.dirname(__filename);
const JARVIS_ROOT   = path.resolve(__dirname, '..');
const REPO_ROOT     = path.resolve(JARVIS_ROOT, '..');
const PENDING_DIR   = path.join(JARVIS_ROOT, 'drafts', 'pending');
const LOG_DIR       = path.join(JARVIS_ROOT, 'logs');
const SETTINGS_PATH = path.join(JARVIS_ROOT, 'config', 'settings.json');

const TOOL_VERSION = '0.1.0';
const SCHEDULED_AT_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?$/;

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
  const local = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return local.toISOString().slice(0, 19) + '+09:00';
}

function generateId() {
  const local = new Date(Date.now() + 9 * 60 * 60 * 1000);
  const yyyymmdd = local.toISOString().slice(0, 10).replace(/-/g, '');
  return `draft_${yyyymmdd}_${crypto.randomBytes(3).toString('hex')}`;
}

function writeLog(parts) {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    const line = `[${nowJST()}] ${parts.join(' | ')}\n`;
    fs.appendFileSync(path.join(LOG_DIR, 'history.log'), line, 'utf-8');
  } catch { /* ログ失敗は処理を止めない */ }
}

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
  } catch {
    return { youtube: { default_privacy_status: 'private', default_publish_mode: 'scheduled', require_made_for_kids_setting: true } };
  }
}

function hr(char = '─', width = 60) { return char.repeat(width); }

// ── バリデーション ────────────────────────────────────────────────

function validateRelativePath(p, label) {
  if (!p || !p.trim()) return { ok: true, value: null };
  const t = p.trim();
  if (t.includes('../') || t.includes('..\\')) {
    return { ok: false, reason: `${label}に ../ を含むパスは使用できません` };
  }
  if (/^[/\\]/.test(t) || /^[A-Za-z]:[/\\]/.test(t)) {
    return { ok: false, reason: `${label}には絶対パスは使用できません。相対パスで指定してください` };
  }
  const resolved = path.resolve(REPO_ROOT, t);
  if (!resolved.startsWith(REPO_ROOT + path.sep) && resolved !== REPO_ROOT) {
    return { ok: false, reason: `${label}がリポジトリ外を参照しています` };
  }
  return { ok: true, value: t };
}

function validateScheduledAt(input) {
  if (!input || !input.trim()) return { ok: true, value: null };
  const s = input.trim();
  if (!SCHEDULED_AT_RE.test(s)) {
    return { ok: false, reason: `日時形式が不正です: "${s}"\n   例: 2026-08-10 または 2026-08-10 18:00` };
  }
  const d = new Date(s.replace(' ', 'T'));
  if (isNaN(d.getTime())) {
    return { ok: false, reason: `有効な日時に変換できません: "${s}"` };
  }
  return { ok: true, value: s };
}

function normalizeTags(input) {
  if (!input || !input.trim()) return [];
  return [...new Set(
    input.trim().split(/[\s,、]+/).map(t => t.trim()).filter(t => t.length > 0)
  )];
}

// ── 安全な保存 ────────────────────────────────────────────────────

function safeSaveDraft(draft) {
  if (!fs.existsSync(PENDING_DIR)) fs.mkdirSync(PENDING_DIR, { recursive: true });
  for (let attempt = 0; attempt < 10; attempt++) {
    const id       = attempt === 0 ? draft.id : generateId();
    const filename = `${id}.json`;
    const filepath = path.join(PENDING_DIR, filename);
    const tmpPath  = filepath + '.tmp';
    if (!fs.existsSync(filepath)) {
      const dataToSave = { ...draft, id };
      try {
        fs.writeFileSync(tmpPath, JSON.stringify(dataToSave, null, 2), 'utf-8');
        JSON.parse(fs.readFileSync(tmpPath, 'utf-8'));
        fs.renameSync(tmpPath, filepath);
        return { ok: true, id, filename };
      } catch (e) {
        try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
        return { ok: false, reason: e.message };
      }
    }
  }
  return { ok: false, reason: 'ID重複により保存に失敗しました（10回リトライ）' };
}

// ── メイン処理 ────────────────────────────────────────────────────

async function main() {
  const settings   = loadSettings();
  const ytSettings = settings.youtube || {};

  const rl  = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = q => new Promise(resolve => rl.question(q, resolve));

  console.log('\n' + hr('═'));
  console.log('  Snow flakes JARVIS - YouTube下書き生成 v' + TOOL_VERSION);
  console.log('  npm run youtube-draft');
  console.log('  ※ YouTube API 接続なし / 動画アップロードなし / OAuth 認証なし');
  console.log(hr('─'));
  console.log('  0 を入力するといつでもキャンセルできます');
  console.log(hr('═') + '\n');

  const cancel = (reason) => {
    rl.close();
    console.log('\nキャンセルしました。\n');
    writeLog(['CANCELLED', 'generate_youtube_draft.js', `reason=${reason}`]);
    process.exit(0);
  };

  // 【1】動画タイトル（必須）
  console.log('【1】動画タイトル（必須）:');
  let title = '';
  while (true) {
    const ans = (await ask('  > ')).trim();
    if (ans === '0') cancel('ユーザーキャンセル');
    if (!ans) { console.log('  ⚠️  タイトルは必須です。'); continue; }
    title = ans;
    break;
  }

  // 【2】説明文（任意）
  console.log('\n【2】説明文（任意・空欄でスキップ）:');
  const descAns = (await ask('  > ')).trim();
  if (descAns === '0') cancel('ユーザーキャンセル');
  const description = descAns || null;

  // 【3】動画ファイルパス（必須・相対パス）
  console.log('\n【3】動画ファイルパス（必須・相対パス例: assets/video/mv.mp4）:');
  console.log('  ※ ../ を含むパス・絶対パスは拒否されます');
  let videoPath = '';
  while (true) {
    const ans = (await ask('  > ')).trim();
    if (ans === '0') cancel('ユーザーキャンセル');
    if (!ans) { console.log('  ⚠️  動画ファイルパスは必須です。'); continue; }
    const pv = validateRelativePath(ans, '動画ファイルパス');
    if (!pv.ok) { console.error(`  [エラー] ${pv.reason}`); continue; }
    videoPath = pv.value;
    break;
  }

  // 【4】サムネイル画像パス（任意）
  console.log('\n【4】サムネイル画像パス（任意・空欄でスキップ）:');
  let thumbnailPath = null;
  while (true) {
    const ans = (await ask('  > ')).trim();
    if (ans === '0') cancel('ユーザーキャンセル');
    if (!ans) { thumbnailPath = null; break; }
    const pv = validateRelativePath(ans, 'サムネイルパス');
    if (!pv.ok) { console.error(`  [エラー] ${pv.reason}`); continue; }
    thumbnailPath = pv.value;
    break;
  }

  // 【5】公開予定日時（任意）
  console.log('\n【5】公開予定日時（任意・例: 2026-08-10 18:00・空欄でスキップ）:');
  let scheduledAt = null;
  while (true) {
    const ans = (await ask('  > ')).trim();
    if (ans === '0') cancel('ユーザーキャンセル');
    const sv = validateScheduledAt(ans);
    if (!sv.ok) { console.error(`  [エラー] ${sv.reason}`); continue; }
    scheduledAt = sv.value;
    break;
  }

  // 【6】子ども向け設定（必須）
  console.log('\n【6】子ども向け動画ですか？（必須）:');
  console.log('  y = はい  /  n = いいえ');
  let madeForKids = null;
  while (true) {
    const ans = (await ask('  > ')).trim().toLowerCase();
    if (ans === '0') cancel('ユーザーキャンセル');
    if (ans === 'y') { madeForKids = true;  break; }
    if (ans === 'n') { madeForKids = false; break; }
    console.log('  ⚠️  y または n を入力してください。');
  }

  // 【7】タグ（任意）
  console.log('\n【7】タグ（任意・カンマまたはスペース区切り・空欄でスキップ）:');
  const tagAns = (await ask('  > ')).trim();
  if (tagAns === '0') cancel('ユーザーキャンセル');
  const tags = normalizeTags(tagAns);

  // 【8】再生リストID（任意）
  console.log('\n【8】再生リストID（任意・空欄でスキップ）:');
  const plAns = (await ask('  > ')).trim();
  if (plAns === '0') cancel('ユーザーキャンセル');
  const playlistId = plAns || null;

  // プレビュー
  console.log('\n' + hr('─'));
  console.log('  【入力内容プレビュー】');
  console.log(`  タイトル       : ${title}`);
  console.log(`  説明文         : ${description ? description.slice(0, 50) + (description.length > 50 ? '...' : '') : '（なし）'}`);
  console.log(`  動画パス       : ${videoPath}`);
  console.log(`  サムネイル     : ${thumbnailPath ?? '（なし）'}`);
  console.log(`  公開予定日時   : ${scheduledAt ?? '（要設定）'}`);
  console.log(`  子ども向け     : ${madeForKids ? 'はい' : 'いいえ'}`);
  console.log(`  タグ           : ${tags.length ? tags.join(', ') : '（なし）'}`);
  console.log(`  再生リストID   : ${playlistId ?? '（なし）'}`);
  console.log(`  カテゴリID     : null（schedule-check で警告）`);
  console.log(`  登録者通知     : する（デフォルト・dry-run で確認可）`);
  console.log(`  公開設定       : private（固定）`);
  console.log(`  公開モード     : scheduled（固定）`);
  console.log(hr('─'));
  console.log('  ⚠️  YouTube API 接続なし / 動画アップロードなし / OAuth 認証なし');
  console.log(hr('─'));

  const confirm = (await ask('  保存しますか？ (y/N)> ')).trim().toLowerCase();
  rl.close();

  if (!confirm.startsWith('y')) {
    console.log('\nキャンセルしました。下書きは保存されていません。\n');
    writeLog(['CANCELLED', 'generate_youtube_draft.js', 'reason=保存キャンセル']);
    process.exit(0);
  }

  // 下書き構築
  const id    = generateId();
  const draft = {
    id,
    type:       'youtube_video',
    platform:   'youtube',
    status:     'pending',
    created_at: nowISO(),
    content: {
      title,
      description,
      video_path:        videoPath,
      thumbnail_path:    thumbnailPath,
      playlist_id:       playlistId,
      tags,
      scheduled_at:      scheduledAt,
      made_for_kids:     madeForKids,
      privacy_status:    ytSettings.default_privacy_status  || 'private',
      publish_mode:      ytSettings.default_publish_mode    || 'scheduled',
      category_id:       null,
      default_language:  'ja',
      notify_subscribers: true,
    },
    meta: {
      generated_by: `generate_youtube_draft.js v${TOOL_VERSION}`,
      preflight: { last_checked_at: null, result: null, warning_count: 0, error_count: 0, checks: [] },
      dry_run:   { last_run_at: null, result: null },
    },
  };

  const saveResult = safeSaveDraft(draft);
  if (!saveResult.ok) {
    console.error(`\n[エラー] 保存に失敗しました: ${saveResult.reason}\n`);
    writeLog(['FAIL', 'generate_youtube_draft.js', `reason=${saveResult.reason}`]);
    process.exit(1);
  }

  console.log(`\n✅ 保存しました: ${saveResult.id}`);
  console.log(`   drafts/pending/${saveResult.filename}`);
  console.log(`\n⚠️  外部への送信・アップロードは一切行われていません。`);
  console.log(`   承認       : npm run approve -- ${saveResult.id}`);
  console.log(`   予約チェック: npm run schedule-check -- ${saveResult.id}\n`);

  // ログ: タイトル・説明文・タグは記録しない
  writeLog(['SUCCESS', 'generate_youtube_draft.js', `id=${saveResult.id}`, 'platform=youtube']);
}

main().catch(e => {
  console.error(`\n[予期しないエラー] ${e.message}\n`);
  process.exit(1);
});
