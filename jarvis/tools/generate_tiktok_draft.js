#!/usr/bin/env node
/**
 * Snow flakes JARVIS - TikTok下書き生成ツール
 * generate_tiktok_draft.js v0.1.0
 *
 * 使用方法（jarvis/ ディレクトリから実行）:
 *   npm run tiktok-draft
 *
 * 方針:
 *   - Node.js 標準機能のみ使用（外部パッケージなし）
 *   - TikTok API への接続なし・動画アップロードなし
 *   - OAuth 認証を実装しない
 *   - 外部通信なし・git 操作なし
 *   - ログにキャプション・ハッシュタグを記録しない
 *
 * 将来の TikTok API 接続について（第4段階後半で別途実装）:
 *   初期接続は MEDIA_UPLOAD を優先する。
 *   DIRECT_POST はアプリ審査と公開権限の確認後に別途実装する。
 *   TikTok Content Posting API の OAuth 2.0 認証方式は、
 *   実装時点の TikTok 公式仕様を確認して決定する。
 *
 * brand_organic_toggle について:
 *   JARVIS 内部でのコンテンツ分類に使用する。
 *   TikTok API へのフィールド名・送信仕様は、実装時点の
 *   TikTok 公式仕様を確認して決定する。現時点では外部送信なし。
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

const TOOL_VERSION    = '0.1.0';
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
    return { tiktok: { default_post_mode: 'media_upload', direct_post_enabled: false, caption_warning_length: 2200 } };
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

function normalizeHashtags(input) {
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
  const tkSettings = settings.tiktok || {};

  const rl  = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = q => new Promise(resolve => rl.question(q, resolve));

  console.log('\n' + hr('═'));
  console.log('  Snow flakes JARVIS - TikTok下書き生成 v' + TOOL_VERSION);
  console.log('  npm run tiktok-draft');
  console.log('  ※ TikTok API 接続なし / 動画アップロードなし / OAuth 認証なし');
  console.log(hr('─'));
  console.log('  0 を入力するといつでもキャンセルできます');
  console.log(hr('═') + '\n');

  const cancel = (reason) => {
    rl.close();
    console.log('\nキャンセルしました。\n');
    writeLog(['CANCELLED', 'generate_tiktok_draft.js', `reason=${reason}`]);
    process.exit(0);
  };

  // 【1】キャプション（必須）
  console.log('【1】キャプション（必須）:');
  let caption = '';
  while (true) {
    const ans = (await ask('  > ')).trim();
    if (ans === '0') cancel('ユーザーキャンセル');
    if (!ans) { console.log('  ⚠️  キャプションは必須です。'); continue; }
    caption = ans;
    break;
  }

  // 【2】動画ファイルパス（必須・相対パス）
  console.log('\n【2】動画ファイルパス（必須・相対パス例: assets/video/dance.mp4）:');
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

  // 【3】カバー画像パス（任意）
  console.log('\n【3】カバー画像パス（任意・空欄でスキップ）:');
  let coverPath = null;
  while (true) {
    const ans = (await ask('  > ')).trim();
    if (ans === '0') cancel('ユーザーキャンセル');
    if (!ans) { coverPath = null; break; }
    const pv = validateRelativePath(ans, 'カバー画像パス');
    if (!pv.ok) { console.error(`  [エラー] ${pv.reason}`); continue; }
    coverPath = pv.value;
    break;
  }

  // 【4】ハッシュタグ（任意）
  console.log('\n【4】ハッシュタグ（任意・カンマまたはスペース区切り・空欄でスキップ）:');
  const tagAns = (await ask('  > ')).trim();
  if (tagAns === '0') cancel('ユーザーキャンセル');
  const hashtags = normalizeHashtags(tagAns);

  // 【5】投稿予定日時（任意）
  console.log('\n【5】投稿予定日時（任意・例: 2026-08-10 18:00・空欄でスキップ）:');
  let scheduledAt = null;
  while (true) {
    const ans = (await ask('  > ')).trim();
    if (ans === '0') cancel('ユーザーキャンセル');
    const sv = validateScheduledAt(ans);
    if (!sv.ok) { console.error(`  [エラー] ${sv.reason}`); continue; }
    scheduledAt = sv.value;
    break;
  }

  // 【6】投稿方式（必須）
  console.log('\n【6】投稿方式（必須）:');
  console.log('  1 = media_upload  （TikTok アプリ内で確認・投稿）※推奨');
  console.log('  2 = direct_post   （JARVIS から直接投稿・アプリ審査完了後のみ有効）');
  let postMode = '';
  while (true) {
    const ans = (await ask('  > ')).trim();
    if (ans === '0') cancel('ユーザーキャンセル');
    if (ans === '1') { postMode = 'media_upload'; break; }
    if (ans === '2') { postMode = 'direct_post';  break; }
    console.log('  ⚠️  1 または 2 を入力してください。');
  }

  // 【7】公開範囲（direct_post=必須 / media_upload=任意）
  const privacyRequired = (postMode === 'direct_post');
  console.log(`\n【7】公開範囲（${privacyRequired ? '必須' : '任意・空欄でスキップ'}）:`);
  console.log('  1 = PUBLIC_TO_EVERYONE     （全員に公開）');
  console.log('  2 = MUTUAL_FOLLOW_FRIENDS  （相互フォロー）');
  console.log('  3 = FOLLOWER_OF_CREATOR    （フォロワーのみ）');
  console.log('  4 = SELF_ONLY              （自分のみ）');
  if (!privacyRequired) console.log('  空欄 = スキップ（media_upload の場合は TikTok アプリで設定）');
  const privacyMap = {
    '1': 'PUBLIC_TO_EVERYONE',
    '2': 'MUTUAL_FOLLOW_FRIENDS',
    '3': 'FOLLOWER_OF_CREATOR',
    '4': 'SELF_ONLY',
  };
  let privacyLevel = null;
  while (true) {
    const ans = (await ask('  > ')).trim();
    if (ans === '0') cancel('ユーザーキャンセル');
    if (!ans && !privacyRequired) { privacyLevel = null; break; }
    if (privacyMap[ans]) { privacyLevel = privacyMap[ans]; break; }
    console.log('  ⚠️  1〜4 を入力してください。' + (!privacyRequired ? '（空欄でスキップ）' : ''));
  }

  // 【8】コメント許可（任意）
  console.log('\n【8】コメントを許可しますか？:');
  console.log('  y = 許可する  /  n = 禁止する  /  空欄 = 未設定（null）');
  let disableComment = null;
  while (true) {
    const ans = (await ask('  > ')).trim().toLowerCase();
    if (ans === '0') cancel('ユーザーキャンセル');
    if (ans === 'y') { disableComment = false; break; }
    if (ans === 'n') { disableComment = true;  break; }
    if (ans === '')  { disableComment = null;  break; }
    console.log('  ⚠️  y、n、または空欄（Enter）を入力してください。');
  }

  // 【9】デュエット許可（任意）
  console.log('\n【9】デュエットを許可しますか？:');
  console.log('  y = 許可する  /  n = 禁止する  /  空欄 = 未設定（null）');
  let disableDuet = null;
  while (true) {
    const ans = (await ask('  > ')).trim().toLowerCase();
    if (ans === '0') cancel('ユーザーキャンセル');
    if (ans === 'y') { disableDuet = false; break; }
    if (ans === 'n') { disableDuet = true;  break; }
    if (ans === '')  { disableDuet = null;  break; }
    console.log('  ⚠️  y、n、または空欄（Enter）を入力してください。');
  }

  // 【10】Stitch/リミックス許可（任意）
  console.log('\n【10】Stitch（リミックス）を許可しますか？:');
  console.log('  y = 許可する  /  n = 禁止する  /  空欄 = 未設定（null）');
  let disableStitch = null;
  while (true) {
    const ans = (await ask('  > ')).trim().toLowerCase();
    if (ans === '0') cancel('ユーザーキャンセル');
    if (ans === 'y') { disableStitch = false; break; }
    if (ans === 'n') { disableStitch = true;  break; }
    if (ans === '')  { disableStitch = null;  break; }
    console.log('  ⚠️  y、n、または空欄（Enter）を入力してください。');
  }

  // 【11】AI生成コンテンツ（任意・空欄=null は preflight で BLOCK）
  console.log('\n【11】AI 生成コンテンツですか？:');
  console.log('  y = AI 生成  /  n = AI 生成ではない  /  空欄 = 未設定（null・preflight で BLOCK）');
  let isAigc = null;
  while (true) {
    const ans = (await ask('  > ')).trim().toLowerCase();
    if (ans === '0') cancel('ユーザーキャンセル');
    if (ans === 'y') { isAigc = true;  break; }
    if (ans === 'n') { isAigc = false; break; }
    if (ans === '')  { isAigc = null;  break; }
    console.log('  ⚠️  y、n、または空欄（Enter）を入力してください。');
  }

  // 【12】自己の事業・作品の宣伝（任意）
  console.log('\n【12】自己の事業や作品の宣伝コンテンツですか？:');
  console.log('  y = 宣伝あり  /  n = 宣伝なし  /  空欄 = 未設定（null）');
  let brandOrganicToggle = null;
  while (true) {
    const ans = (await ask('  > ')).trim().toLowerCase();
    if (ans === '0') cancel('ユーザーキャンセル');
    if (ans === 'y') { brandOrganicToggle = true;  break; }
    if (ans === 'n') { brandOrganicToggle = false; break; }
    if (ans === '')  { brandOrganicToggle = null;  break; }
    console.log('  ⚠️  y、n、または空欄（Enter）を入力してください。');
  }

  // プレビュー
  const captionWarnLen = tkSettings.caption_warning_length ?? 2200;
  const captionOver    = caption.length > captionWarnLen;
  console.log('\n' + hr('─'));
  console.log('  【入力内容プレビュー】');
  console.log(`  キャプション   : ${caption.slice(0, 50)}${caption.length > 50 ? '...' : ''}${captionOver ? ' ⚠️ 文字数超過' : ''}`);
  console.log(`  動画パス       : ${videoPath}`);
  console.log(`  カバー画像     : ${coverPath ?? '（なし）'}`);
  console.log(`  ハッシュタグ   : ${hashtags.length ? hashtags.join(', ') : '（なし）'}`);
  console.log(`  投稿予定日時   : ${scheduledAt ?? '（要設定）'}`);
  console.log(`  投稿方式       : ${postMode}`);
  console.log(`  公開範囲       : ${privacyLevel ?? (postMode === 'media_upload' ? '（TikTok アプリで設定）' : '（未設定）')}`);
  console.log(`  コメント       : ${disableComment === null ? '（未設定）' : disableComment ? '禁止' : '許可'}`);
  console.log(`  デュエット     : ${disableDuet   === null ? '（未設定）' : disableDuet   ? '禁止' : '許可'}`);
  console.log(`  Stitch         : ${disableStitch === null ? '（未設定）' : disableStitch ? '禁止' : '許可'}`);
  console.log(`  AI生成         : ${isAigc === null ? '（未設定・preflight で BLOCK）' : isAigc ? 'あり' : 'なし'}`);
  console.log(`  自己宣伝       : ${brandOrganicToggle === null ? '（未設定）' : brandOrganicToggle ? 'あり' : 'なし'}`);
  console.log(`  外部投稿       : 無効（dry_run_only=true）`);
  console.log(hr('─'));
  console.log('  ⚠️  TikTok API 接続なし / 動画アップロードなし / OAuth 認証なし');
  if (postMode === 'direct_post') {
    console.log('  ⚠️  DIRECT_POST: アプリ審査・公開権限の確認が完了するまで外部投稿は無効です');
  }
  console.log(hr('─'));

  const confirm = (await ask('  保存しますか？ (y/N)> ')).trim().toLowerCase();
  rl.close();

  if (!confirm.startsWith('y')) {
    console.log('\nキャンセルしました。下書きは保存されていません。\n');
    writeLog(['CANCELLED', 'generate_tiktok_draft.js', 'reason=保存キャンセル']);
    process.exit(0);
  }

  // 下書き構築
  const id    = generateId();
  const draft = {
    id,
    type:       'tiktok_video',
    platform:   'tiktok',
    status:     'pending',
    created_at: nowISO(),
    content: {
      caption,
      video_path:           videoPath,
      cover_path:           coverPath,
      scheduled_at:         scheduledAt,
      privacy_level:        privacyLevel,
      disable_comment:      disableComment,
      disable_duet:         disableDuet,
      disable_stitch:       disableStitch,
      is_aigc:              isAigc,
      brand_organic_toggle: brandOrganicToggle,
      post_mode:            postMode,
      hashtags,
      notify_before_upload: true,
    },
    meta: {
      generated_by: `generate_tiktok_draft.js v${TOOL_VERSION}`,
      preflight: { last_checked_at: null, result: null, warning_count: 0, error_count: 0, checks: [] },
      dry_run:   { last_run_at: null, result: null },
    },
  };

  const saveResult = safeSaveDraft(draft);
  if (!saveResult.ok) {
    console.error(`\n[エラー] 保存に失敗しました: ${saveResult.reason}\n`);
    writeLog(['FAIL', 'generate_tiktok_draft.js', `reason=${saveResult.reason}`]);
    process.exit(1);
  }

  console.log(`\n✅ 保存しました: ${saveResult.id}`);
  console.log(`   drafts/pending/${saveResult.filename}`);
  console.log(`\n⚠️  外部への送信・アップロードは一切行われていません。`);
  console.log(`   承認       : npm run approve -- ${saveResult.id}`);
  console.log(`   予約チェック: npm run schedule-check -- ${saveResult.id}\n`);

  // ログ: キャプション・ハッシュタグは記録しない
  writeLog(['SUCCESS', 'generate_tiktok_draft.js', `id=${saveResult.id}`, 'platform=tiktok', `post_mode=${postMode}`]);
}

main().catch(e => {
  console.error(`\n[予期しないエラー] ${e.message}\n`);
  process.exit(1);
});
