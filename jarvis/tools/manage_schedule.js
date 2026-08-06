#!/usr/bin/env node
/**
 * Snow flakes JARVIS - 投稿予約スケジュール管理
 * manage_schedule.js v0.1.0
 *
 * 使用方法（jarvis/ ディレクトリから実行）:
 *   npm run schedule-list
 *   npm run schedule-show  -- <draft-id>
 *   npm run schedule-set   -- <draft-id>
 *
 * 方針:
 *   - Node.js 標準機能のみ使用（外部パッケージなし）
 *   - 外部通信・SNS投稿・YouTube API・OAuth 認証・git 操作なし
 *   - approved フォルダ内の platform=x/instagram/youtube/tiktok の下書きを対象とする
 *   - type による絞り込みは行わない（YouTube は type=youtube_video、TikTok は type=tiktok_video を確認）
 *   - schedule-set は content.scheduled_at のみ更新する（本文・status 変更禁止）
 *   - ログに投稿本文・タイトル・URL・ハッシュタグを記録しない
 *   - 設定不明時は安全側（外部投稿無効）へ倒す
 */

import fs       from 'fs';
import path     from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

// ── パス設定 ─────────────────────────────────────────────────────
const __filename  = fileURLToPath(import.meta.url);
const __dirname   = path.dirname(__filename);
const JARVIS_ROOT = path.resolve(__dirname, '..');
const APPROVED_DIR  = path.join(JARVIS_ROOT, 'drafts', 'approved');
const LOG_DIR       = path.join(JARVIS_ROOT, 'logs');
const LOG_PATH      = path.join(LOG_DIR, 'history.log');
const SETTINGS_PATH = path.join(JARVIS_ROOT, 'config', 'settings.json');

const TOOL_VERSION    = '0.1.0';
const VALID_PLATFORMS = ['x', 'instagram', 'youtube', 'tiktok'];
const VALID_ID_RE     = /^draft_\d{8}_[0-9a-f]{6}$/;
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
  return new Date(d.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 19) + '+09:00';
}

function writeLog(parts) {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_PATH, `[${nowJST()}] ${parts.join(' | ')}\n`, 'utf-8');
  } catch { /* ログ失敗は処理を止めない */ }
}

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
  } catch {
    return { scheduling: { allow_past_schedule: false, minimum_lead_minutes: 10, external_posting_enabled: false, dry_run_only: true } };
  }
}

function hr(char = '─', width = 60) { return char.repeat(width); }

function printHeader(title) {
  console.log('\n' + hr('═'));
  console.log(`  ${title}`);
  console.log(hr('─'));
}

function printFooter() {
  console.log(hr('═') + '\n');
}

// ── ID 検証 ───────────────────────────────────────────────────────

function validateId(id) {
  if (!id)                    return { ok: false, reason: 'IDが指定されていません' };
  if (typeof id !== 'string') return { ok: false, reason: 'IDは文字列で指定してください' };
  if (!VALID_ID_RE.test(id))  return { ok: false, reason: `不正なID形式: "${id}"\n   有効な形式: draft_YYYYMMDD_xxxxxx（例: draft_20260805_a1b2c3）` };
  return { ok: true };
}

// ── 対象下書き判定 ────────────────────────────────────────────────
// type による絞り込みは行わない。
// YouTube は platform=youtube かつ type=youtube_video を確認する。
// TikTok は platform=tiktok かつ type=tiktok_video を確認する。

function isScheduleTarget(draft) {
  if (!draft)                              return false;
  if (draft.status !== 'approved')         return false;
  if (!VALID_PLATFORMS.includes(draft.platform)) return false;
  if (draft.platform === 'youtube' && draft.type !== 'youtube_video') return false;
  if (draft.platform === 'tiktok'  && draft.type !== 'tiktok_video')  return false;
  return true;
}

// ── 日時検証 ─────────────────────────────────────────────────────

function validateScheduledAt(input) {
  if (!input || !input.trim()) return { ok: false, reason: '日時が入力されていません' };
  const s = input.trim();
  if (!SCHEDULED_AT_RE.test(s)) {
    return { ok: false, reason: `日時形式が不正です: "${s}"\n   例: 2026-08-10 18:00` };
  }
  const d = new Date(s.replace(' ', 'T'));
  if (isNaN(d.getTime())) {
    return { ok: false, reason: `有効な日時に変換できません: "${s}"` };
  }
  return { ok: true, date: d, normalized: s };
}

// ── ファイル操作 ──────────────────────────────────────────────────

function readDraftFile(filePath) {
  if (!fs.existsSync(filePath)) return { ok: false, reason: 'ファイルが見つかりません' };
  try {
    const raw = fs.readFileSync(filePath, 'utf-8');
    return { ok: true, data: JSON.parse(raw) };
  } catch (e) {
    return { ok: false, reason: e instanceof SyntaxError ? 'JSONが破損しています' : `読み込みエラー: ${e.message}` };
  }
}

function safeWrite(dir, filename, data) {
  const finalPath = path.join(dir, filename);
  const tmpPath   = finalPath + '.tmp';
  const cleanup   = () => { try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {} };
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    JSON.parse(fs.readFileSync(tmpPath, 'utf-8'));
    fs.renameSync(tmpPath, finalPath);
    return { ok: true };
  } catch (e) {
    cleanup();
    return { ok: false, reason: e.message };
  }
}

// ── コマンド: list ────────────────────────────────────────────────

function cmdList() {
  printHeader('Snow flakes JARVIS - 投稿予定一覧（X / Instagram / YouTube / TikTok）');

  if (!fs.existsSync(APPROVED_DIR)) {
    console.log('  approved フォルダが見つかりません。');
    printFooter();
    return;
  }

  const files   = fs.readdirSync(APPROVED_DIR).filter(f => f.endsWith('.json') && f !== '.gitkeep');
  const targets = [];
  const broken  = [];
  const skipped = [];

  for (const f of files) {
    const result = readDraftFile(path.join(APPROVED_DIR, f));
    if (!result.ok) { broken.push({ file: f, reason: result.reason }); continue; }
    if (!isScheduleTarget(result.data)) { skipped.push(f); continue; }
    targets.push(result.data);
  }

  // 日時あり → 昇順 / 日時なし → 末尾（作成日時昇順）
  const withDate    = targets.filter(d => d.content?.scheduled_at)
    .sort((a, b) => new Date(a.content.scheduled_at) - new Date(b.content.scheduled_at));
  const withoutDate = targets.filter(d => !d.content?.scheduled_at)
    .sort((a, b) => (a.created_at || '').localeCompare(b.created_at || ''));
  const sorted = [...withDate, ...withoutDate];

  if (sorted.length === 0) {
    console.log('  投稿予定の下書きはありません。（approved 内に対象ファイルなし）');
    printFooter();
    return;
  }

  console.log('  No.  ID                          Plt        タイトル/作品名     scheduled_at         preflight  警告');
  console.log('  ' + hr('─', 102));

  for (let i = 0; i < sorted.length; i++) {
    const d    = sorted[i];
    const no   = String(i + 1).padStart(3);
    const id   = (d.id ?? '（不明）').padEnd(27);
    const plt  = (d.platform ?? '?').padEnd(9);

    // タイトル取得: YouTube は content.title、TikTok は content.caption、SNS は meta.work_title
    let titleRaw = '';
    if (d.platform === 'youtube') {
      titleRaw = d.content?.title ?? '（タイトルなし）';
    } else if (d.platform === 'tiktok') {
      titleRaw = d.content?.caption ?? '（キャプションなし）';
    } else {
      titleRaw = d.meta?.work_title ?? d.content?.work_name ?? '（未設定）';
    }
    const title = titleRaw.slice(0, 18).padEnd(18);

    const sched = d.content?.scheduled_at
      ? d.content.scheduled_at.slice(0, 16).replace('T', ' ')
      : '（要設定）';
    const schedPad = sched.padEnd(20);
    const pf       = (d.meta?.preflight?.result ?? '-').padEnd(10);
    const warns    = d.meta?.preflight?.warning_count ?? '-';

    console.log(`  ${no}. ${id} ${plt} ${title} ${schedPad} ${pf} ${warns}`);
  }

  if (broken.length > 0) {
    console.log('\n  ⚠️  読み込みに失敗したファイル:');
    for (const b of broken) console.log(`    - ${b.file}: ${b.reason}`);
  }

  console.log('\n  ' + hr('─', 102));
  console.log(`  計 ${sorted.length} 件（破損: ${broken.length} 件 / スキップ: ${skipped.length} 件）`);
  printFooter();
}

// ── コマンド: show ────────────────────────────────────────────────

function cmdShow(id) {
  const v = validateId(id);
  if (!v.ok) { console.error(`\n[エラー] ${v.reason}\n`); process.exit(1); }

  const filePath = path.join(APPROVED_DIR, `${id}.json`);
  const result   = readDraftFile(filePath);
  if (!result.ok) {
    console.error(`\n[エラー] ${result.reason}（approved/${id}.json）\n`);
    process.exit(1);
  }

  const draft = result.data;
  if (!isScheduleTarget(draft)) {
    console.error(`\n[エラー] この下書きは投稿予定管理の対象ではありません（platform: ${draft.platform}, status: ${draft.status}）\n`);
    process.exit(1);
  }

  const show = (label, value) => {
    let v;
    if (value === null || value === undefined) {
      v = '（未設定）';
    } else if (Array.isArray(value)) {
      v = value.length ? value.join(', ') : '（なし）';
    } else {
      v = String(value);
    }
    console.log(`  ${label.padEnd(22)}: ${v}`);
  };

  printHeader(`Snow flakes JARVIS - 投稿予定詳細 [approved]`);
  show('ID', draft.id);
  show('プラットフォーム', draft.platform);
  show('ステータス', draft.status);
  show('承認日時', draft.approved_at);
  show('投稿予定日時', draft.content?.scheduled_at);

  const c = draft.content || {};

  if (draft.platform === 'youtube') {
    console.log('\n  【YouTube 動画情報】');
    show('タイトル', c.title);
    const descShort = c.description ? c.description.slice(0, 60) + (c.description.length > 60 ? '...' : '') : null;
    show('説明文', descShort);
    show('動画ファイルパス', c.video_path);
    show('サムネイルパス', c.thumbnail_path);
    show('再生リストID', c.playlist_id);
    show('タグ', c.tags);
    show('カテゴリID', c.category_id);
    show('デフォルト言語', c.default_language);
    show('子ども向け', c.made_for_kids === null ? null : (c.made_for_kids ? 'はい' : 'いいえ'));
    show('公開設定', c.privacy_status);
    show('公開モード', c.publish_mode);
    show('登録者通知', c.notify_subscribers === null ? null : (c.notify_subscribers ? 'する' : 'しない'));
    console.log('\n  【将来のAPI変換情報】');
    console.log('    content.scheduled_at → YouTube API status.publishAt');
    console.log('    同時に status.privacyStatus = "private" を設定する');
    console.log('    第4段階後半: YouTube Data API v3 インストール済みアプリ向け');
    console.log('    OAuth 2.0 認証（方式は実装時点の Google 公式仕様で決定）');
  } else if (draft.platform === 'tiktok') {
    console.log('\n  【TikTok 動画情報】');
    const capShort = c.caption ? c.caption.slice(0, 60) + (c.caption.length > 60 ? '...' : '') : null;
    show('キャプション', capShort);
    show('動画ファイルパス', c.video_path);
    show('カバー画像パス', c.cover_path);
    show('ハッシュタグ', c.hashtags);
    show('投稿方式', c.post_mode);
    if (c.post_mode === 'media_upload') {
      console.log('  ※ scheduled_at は JARVIS 内のアップロード準備予定です（TikTok 側の公開日時ではありません）');
    }
    show('公開範囲', c.privacy_level ?? (c.post_mode === 'media_upload' ? '（TikTok アプリで設定）' : null));
    show('コメント', c.disable_comment === null ? null : (c.disable_comment ? '禁止' : '許可'));
    show('デュエット', c.disable_duet   === null ? null : (c.disable_duet   ? '禁止' : '許可'));
    show('Stitch', c.disable_stitch === null ? null : (c.disable_stitch ? '禁止' : '許可'));
    show('AI生成', c.is_aigc === null ? null : (c.is_aigc ? 'あり' : 'なし'));
    show('自己宣伝', c.brand_organic_toggle === null ? null : (c.brand_organic_toggle ? 'あり' : 'なし'));
    console.log('\n  【将来のAPI接続情報】');
    console.log('    初期接続: MEDIA_UPLOAD を優先する');
    console.log('    DIRECT_POST: アプリ審査・公開権限の確認後に別途実装する');
    console.log('    TikTok Content Posting API の OAuth 2.0 認証方式は');
    console.log('    実装時点の TikTok 公式仕様を確認して決定する');
  } else {
    // X / Instagram（第3段階生成のSNS下書きとの互換性を維持）
    console.log('\n  【投稿内容】');
    show('投稿文字数', c.char_count != null ? `${c.char_count}文字` : null);
    show('文字数超過', c.char_over != null ? String(c.char_over) : null);
    show('URL', c.url ? '設定あり' : null);
    show('ハッシュタグ', c.hashtags);
    show('言語', c.lang ?? draft.meta?.lang);
    const lang = c.lang ?? draft.meta?.lang;
    if (lang === 'ja_en') show('英語本文', c.body_en ? '設定あり' : null);
    show('素材ファイル', c.media_paths?.length ? `${c.media_paths.length}件` : null);
    show('URLを本文に含める', c.include_url_in_post != null ? String(c.include_url_in_post) : null);
    show('公開タイミング', draft.meta?.timing ?? c.timing);
    show('告知種別', draft.meta?.announce_type);
    show('作品名/曲名', draft.meta?.work_title ?? c.work_name);
  }

  console.log('\n  【事前確認（preflight）】');
  show('最終確認日時', draft.meta?.preflight?.last_checked_at);
  show('確認結果', draft.meta?.preflight?.result);
  show('警告件数', draft.meta?.preflight?.warning_count != null ? String(draft.meta.preflight.warning_count) : null);
  show('エラー件数', draft.meta?.preflight?.error_count != null ? String(draft.meta.preflight.error_count) : null);

  console.log('\n  【Dry-run】');
  show('最終実行日時', draft.meta?.dry_run?.last_run_at);
  show('実行結果', draft.meta?.dry_run?.result);

  console.log('\n  ⚠️  外部投稿機能: 無効（dry_run_only=true）');
  printFooter();
}

// ── コマンド: set ─────────────────────────────────────────────────

async function cmdSet(id) {
  const v = validateId(id);
  if (!v.ok) { console.error(`\n[エラー] ${v.reason}\n`); process.exit(1); }

  const settings = loadSettings();
  const sched    = settings.scheduling || {};

  const filePath = path.join(APPROVED_DIR, `${id}.json`);
  const result   = readDraftFile(filePath);
  if (!result.ok) {
    const reason = result.reason;
    console.error(`\n[エラー] ${reason}（approved/${id}.json）\n`);
    writeLog(['SCHEDULE_SET', `id=${id}`, 'FAIL', `reason=${reason}`]);
    process.exit(1);
  }

  const draft = result.data;
  if (!isScheduleTarget(draft)) {
    const reason = '投稿予定管理の対象ではありません';
    console.error(`\n[エラー] ${reason}（platform: ${draft.platform}, status: ${draft.status}）\n`);
    writeLog(['SCHEDULE_SET', `id=${id}`, 'FAIL', `reason=${reason}`]);
    process.exit(1);
  }

  const current = draft.content?.scheduled_at ?? null;
  printHeader(`Snow flakes JARVIS - 投稿予定日時設定 [${id}]`);
  console.log(`  プラットフォーム : ${draft.platform}`);
  console.log(`  現在の予定日時   : ${current ?? '（未設定）'}`);
  console.log();

  const rl  = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = q => new Promise(resolve => rl.question(q, resolve));

  // 日時入力
  const input = (await ask('投稿予定日時を入力してください（例: 2026-08-10 18:00、空欄でキャンセル）> ')).trim();
  if (!input) {
    rl.close();
    console.log('\nキャンセルしました。\n');
    writeLog(['SCHEDULE_SET', `id=${id}`, `platform=${draft.platform}`, 'CANCELLED']);
    return;
  }

  const valResult = validateScheduledAt(input);
  if (!valResult.ok) {
    rl.close();
    console.error(`\n[エラー] ${valResult.reason}\n`);
    writeLog(['SCHEDULE_SET', `id=${id}`, `platform=${draft.platform}`, 'FAIL', 'reason=日時形式エラー']);
    process.exit(1);
  }

  const now       = Date.now();
  const targetMs  = valResult.date.getTime();
  const isPast    = targetMs < now;
  const leadMs    = (sched.minimum_lead_minutes ?? 10) * 60 * 1000;
  const isTooSoon = !isPast && (targetMs - now) < leadMs;

  // 過去日時の警告と再確認
  if (isPast) {
    console.log(`\n  ⚠️  警告: 指定された日時は過去です（${input}）`);
    const confirm1 = (await ask('  それでも設定しますか？ (y/N)> ')).trim().toLowerCase();
    if (!confirm1.startsWith('y')) {
      rl.close();
      console.log('\nキャンセルしました。\n');
      writeLog(['SCHEDULE_SET', `id=${id}`, `platform=${draft.platform}`, 'CANCELLED', 'reason=過去日時キャンセル']);
      return;
    }
  }

  if (isTooSoon) {
    console.log(`\n  ⚠️  警告: 投稿まで ${sched.minimum_lead_minutes ?? 10} 分未満です`);
  }

  // 変更前後を表示して最終確認
  console.log(`\n  変更前: ${current ?? '（未設定）'}`);
  console.log(`  変更後: ${input}`);
  const confirm2 = (await ask('\nこの日時で設定しますか？ (y/N)> ')).trim().toLowerCase();
  rl.close();

  if (!confirm2.startsWith('y')) {
    console.log('\nキャンセルしました。\n');
    writeLog(['SCHEDULE_SET', `id=${id}`, `platform=${draft.platform}`, 'CANCELLED']);
    return;
  }

  // content.scheduled_at のみ更新（それ以外のフィールドは変更しない）
  const updated = { ...draft, content: { ...draft.content, scheduled_at: input } };
  const writeResult = safeWrite(APPROVED_DIR, `${id}.json`, updated);
  if (!writeResult.ok) {
    console.error(`\n[エラー] 保存に失敗しました: ${writeResult.reason}\n`);
    writeLog(['SCHEDULE_SET', `id=${id}`, `platform=${draft.platform}`, 'FAIL', `reason=${writeResult.reason}`]);
    process.exit(1);
  }

  console.log(`\n✅ 投稿予定日時を設定しました: ${id}`);
  console.log(`   ${input}\n`);
  writeLog(['SCHEDULE_SET', `id=${id}`, `platform=${draft.platform}`, `scheduled_at=${input}`, 'SUCCESS']);
}

// ── エントリーポイント ─────────────────────────────────────────────

const args    = process.argv.slice(2);
const command = args[0];
const draftId = args[1];

switch (command) {
  case 'list': cmdList(); break;
  case 'show': cmdShow(draftId); break;
  case 'set':  await cmdSet(draftId); break;
  default:
    console.error(`\n[エラー] 不明なコマンド: ${command || '（未指定）'}`);
    console.error('使用可能なコマンド: list / show / set\n');
    process.exit(1);
}
