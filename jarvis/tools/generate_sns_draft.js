#!/usr/bin/env node
/**
 * Snow flakes JARVIS - SNS下書き生成ツール
 * generate_sns_draft.js v0.1.0
 *
 * 使用方法（jarvis/ ディレクトリから実行）:
 *   npm run sns-draft
 *
 * 方針:
 *   - Node.js 標準機能のみ使用（外部パッケージなし）
 *   - Anthropic API・SNS API・外部通信は一切行わない
 *   - git 操作は一切行わない
 *   - exec / spawn / eval は使用しない
 *   - XとInstagramの下書きをそれぞれ drafts/pending/ へ保存する
 *   - 同一セッションの投稿には共通の group_id を付ける
 *   - 既存ファイルを上書きしない
 *   - ログに投稿本文・URL・ハッシュタグ・個人情報・秘密情報を記録しない
 */

import fs   from 'fs';
import path from 'path';
import readline from 'readline';
import crypto   from 'crypto';
import { fileURLToPath } from 'url';

// ── パス設定 ─────────────────────────────────────────────────────
const __filename    = fileURLToPath(import.meta.url);
const __dirname     = path.dirname(__filename);
const JARVIS_ROOT   = path.resolve(__dirname, '..');
const PENDING_DIR   = path.join(JARVIS_ROOT, 'drafts', 'pending');
const LOG_DIR       = path.join(JARVIS_ROOT, 'logs');
const SETTINGS_PATH = path.join(JARVIS_ROOT, 'config', 'settings.json');

// ── 定数 ─────────────────────────────────────────────────────────
const TOOL_VERSION = '0.1.0';

const ANNOUNCE_TYPES = {
  '1': { id: 'novel_release',   label: '小説公開' },
  '2': { id: 'music_release',   label: '楽曲公開' },
  '3': { id: 'site_update',     label: 'サイト更新' },
  '4': { id: 'event_announce',  label: 'イベント告知' },
  '5': { id: 'sale_start',      label: '販売開始' },
  '6': { id: 'activity_report', label: '活動報告' },
  '7': { id: 'other',           label: 'その他' },
};

// ── ユーティリティ ────────────────────────────────────────────────

function loadSettings() {
  try {
    const raw = fs.readFileSync(SETTINGS_PATH, 'utf-8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** ID生成: draft_YYYYMMDD_xxxxxx（16進数6文字）*/
function generateId() {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rand = crypto.randomBytes(3).toString('hex');
  return `draft_${date}_${rand}`;
}

/** group_id生成: group_YYYYMMDD_xxxxxxxx（16進数8文字）*/
function generateGroupId() {
  const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const rand = crypto.randomBytes(4).toString('hex');
  return `group_${date}_${rand}`;
}

function nowISO() {
  const d     = new Date();
  const local = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return local.toISOString().slice(0, 19) + '+09:00';
}

function nowJST() {
  return new Date().toLocaleString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year:     'numeric',
    month:    '2-digit',
    day:      '2-digit',
    hour:     '2-digit',
    minute:   '2-digit',
    second:   '2-digit',
    hour12:   false,
  }).replace(/\//g, '-');
}

/**
 * ログ書き込み。
 * 記録する内容: 日時・操作種別・成否・種別ID・draft ID（本文・URL・ハッシュタグ等は記録しない）
 */
function writeLog(parts) {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    const logPath = path.join(LOG_DIR, 'history.log');
    const line    = `[${nowJST()}] ${Array.isArray(parts) ? parts.join(' | ') : parts}\n`;
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

function hr(char = '─', width = 60) {
  return char.repeat(width);
}

// ── バリデーション ────────────────────────────────────────────────

/**
 * URLの検証。http:// または https:// のみ許可。
 * 空文字・未入力は有効（任意項目）。
 */
function validateUrl(url) {
  if (!url || !url.trim()) return { ok: true, value: '' };
  const trimmed = url.trim();
  if (!/^https?:\/\/.+/i.test(trimmed)) {
    return {
      ok:     false,
      reason: 'URLは http:// または https:// で始める必要があります。',
    };
  }
  return { ok: true, value: trimmed };
}

/**
 * 素材パスの検証。
 * - ../ または ..\ を含むパスを拒否（パストラバーサル防止）
 * - / や ドライブ文字:\ で始まる絶対パスを拒否
 * - 正規化後にリポジトリルート外を指すパスを拒否
 */
function validateMediaPath(p) {
  if (!p || !p.trim()) return { ok: true, value: '' };
  const trimmed = p.trim();

  if (trimmed.includes('../') || trimmed.includes('..\\')) {
    return {
      ok:     false,
      reason: `"${trimmed}" に ../ が含まれています。リポジトリ外のパスは指定できません。`,
    };
  }
  if (/^[/\\]/.test(trimmed) || /^[A-Za-z]:[/\\]/.test(trimmed)) {
    return {
      ok:     false,
      reason: `"${trimmed}" は絶対パスです。リポジトリからの相対パスで指定してください。`,
    };
  }

  // リポジトリルート = jarvis の親ディレクトリ（snowflakes/）
  const repoRoot = path.resolve(JARVIS_ROOT, '..');
  const resolved = path.resolve(repoRoot, trimmed);
  if (!resolved.startsWith(repoRoot + path.sep) && resolved !== repoRoot) {
    return {
      ok:     false,
      reason: `"${trimmed}" はリポジトリ外を指しています。`,
    };
  }
  return { ok: true, value: trimmed };
}

/**
 * ハッシュタグの正規化。
 * - スペース・カンマ区切りを受け付ける
 * - #なしは # を補う
 * - 空タグを除去
 * - 重複を除去（大文字・小文字は区別する）
 */
function normalizeHashtags(input) {
  if (!input || !input.trim()) return [];
  return [
    ...new Set(
      input.trim()
        .split(/[\s,]+/)
        .map(h => h.trim())
        .filter(h => h.length > 0)
        .map(h => (h.startsWith('#') ? h : `#${h}`))
        .filter(h => h.length > 1), // '#' だけのものを除去
    ),
  ];
}

/**
 * 投稿予定日時の検証。
 * YYYY-MM-DD または YYYY-MM-DD HH:MM または YYYY-MM-DDTHH:MM[:SS] を許可。
 * 空文字・未入力は有効（任意項目）。
 */
function validateScheduledAt(input) {
  if (!input || !input.trim()) return { ok: true, value: null };
  const trimmed = input.trim();

  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(trimmed);
  const dateTime = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?$/.test(trimmed);

  if (!dateOnly && !dateTime) {
    return {
      ok:     false,
      reason: '日時の形式が正しくありません。例: 2026-08-10 または 2026-08-10 20:00',
    };
  }
  const d = new Date(trimmed.replace(' ', 'T'));
  if (isNaN(d.getTime())) {
    return { ok: false, reason: '有効な日時ではありません。' };
  }
  return { ok: true, value: trimmed };
}

// ── 投稿文の生成 ──────────────────────────────────────────────────

/**
 * X用投稿文を生成する。
 * 構成: 本文（ja + en）+ URL（任意）+ ハッシュタグ（任意）
 * 文字数はpost_textをそのまま計算する。本文を自動削除しない。
 */
function buildXPostText(params) {
  const { bodyJa, bodyEn, hashtags, url, includeUrlInPost, lang } = params;

  const body       = (lang === 'ja_en' && bodyEn) ? `${bodyJa}\n\n${bodyEn}` : bodyJa;
  const urlStr     = (includeUrlInPost && url)     ? `\n${url}`              : '';
  const hashtagStr = hashtags.length > 0           ? '\n' + hashtags.join(' ') : '';

  return body + urlStr + hashtagStr;
}

/**
 * Instagram用投稿文を生成する。
 * 構成: 本文（ja + en）+ プロフィールリンク誘導文（URLがある場合）+ ハッシュタグ（任意）
 * リンク誘導文は settings.json の instagram.bio_link_note から取得する。
 */
function buildInstagramPostText(params, settings) {
  const { bodyJa, bodyEn, hashtags, url, lang } = params;

  const bioLinkNote   = settings?.instagram?.bio_link_note    ?? 'プロフィールのリンクからご確認いただけます。';
  const bioLinkNoteEn = settings?.instagram?.bio_link_note_en ?? 'Check the link in bio for details.';

  const body = (lang === 'ja_en' && bodyEn) ? `${bodyJa}\n\n${bodyEn}` : bodyJa;

  let linkPart = '';
  if (url) {
    linkPart = (lang === 'ja_en')
      ? `\n\n${bioLinkNote}\n${bioLinkNoteEn}`
      : `\n\n${bioLinkNote}`;
  }

  const hashtagStr = hashtags.length > 0 ? '\n\n' + hashtags.join(' ') : '';

  return body + linkPart + hashtagStr;
}

// ── 下書きオブジェクトの組み立て ─────────────────────────────────

function buildDraft(platform, announceType, inputs, groupId) {
  const {
    lang,
    timing,
    workTitle,
    bodyJa,
    bodyEn,
    publishDate,
    url,
    includeUrlInPost,
    mediaPaths,
    hashtags,
    scheduledAt,
    postText,
  } = inputs;

  const charLimitMap = { x: 280, instagram: 2200 };
  const charLimit    = charLimitMap[platform];
  const charCount    = postText.length;
  const charOver     = charCount > charLimit;

  return {
    id:         generateId(),
    group_id:   groupId,
    platform,
    status:     'pending',
    type:       announceType.id,
    created_at: nowISO(),
    content: {
      post_text:           postText,
      body_ja:             bodyJa,
      body_en:             bodyEn  || null,
      hashtags:            hashtags,
      url:                 url     || null,
      include_url_in_post: includeUrlInPost,
      media_paths:         mediaPaths,
      scheduled_at:        scheduledAt || null,
      char_count:          charCount,
      char_limit:          charLimit,
      char_over:           charOver,
    },
    meta: {
      generated_by:  `generate_sns_draft.js v${TOOL_VERSION}`,
      announce_type: announceType.label,
      lang,
      timing,
      work_title:    workTitle   || null,
      publish_date:  publishDate || null,
    },
  };
}

// ── プレビュー表示 ────────────────────────────────────────────────

function printPreview(xDraft, igDraft) {
  const showField = (label, value) => {
    const v =
      value === null || value === undefined ? '（未設定）'
      : Array.isArray(value) ? (value.length ? value.join(', ') : '（なし）')
      : typeof value === 'boolean' ? String(value)
      : String(value);
    console.log(`    ${label.padEnd(22)}: ${v}`);
  };

  console.log('\n' + hr('═'));
  console.log('  【下書きプレビュー】');
  console.log(hr('─'));

  // X
  console.log('\n  ▼ X（Twitter）');
  console.log('  ' + hr('─', 58));
  showField('ID（仮）', xDraft.id);
  showField('group_id', xDraft.group_id);
  showField('platform', xDraft.platform);
  showField('告知種別', xDraft.meta.announce_type);
  showField('作品名/曲名', xDraft.meta.work_title);
  showField('言語', xDraft.meta.lang === 'ja_en' ? '日本語＋英語' : '日本語のみ');
  showField('タイミング', xDraft.meta.timing === 'pre' ? '公開前' : '公開後');
  showField('URL', xDraft.content.url);
  showField('URLを投稿に含める', xDraft.content.include_url_in_post);
  showField('素材パス', xDraft.content.media_paths);
  showField('投稿予定日時', xDraft.content.scheduled_at);
  showField(`文字数 (上限${xDraft.content.char_limit})`, xDraft.content.char_count);
  if (xDraft.content.char_over) {
    console.log(`    ⚠️  文字数超過: ${xDraft.content.char_count - xDraft.content.char_limit}文字オーバーです。`);
    console.log('       本文を手動で調整してキャンセル後に再実行してください。');
  }
  console.log('    投稿文:');
  console.log('    ' + hr('·', 56));
  xDraft.content.post_text.split('\n').forEach(l => console.log(`      ${l}`));
  console.log('    ' + hr('·', 56));

  // Instagram
  console.log('\n  ▼ Instagram');
  console.log('  ' + hr('─', 58));
  showField('ID（仮）', igDraft.id);
  showField('group_id', igDraft.group_id);
  showField('platform', igDraft.platform);
  showField(`文字数 (上限${igDraft.content.char_limit})`, igDraft.content.char_count);
  if (igDraft.content.char_over) {
    console.log(`    ⚠️  文字数超過: ${igDraft.content.char_count - igDraft.content.char_limit}文字オーバーです。`);
    console.log('       本文を手動で調整してキャンセル後に再実行してください。');
  }
  console.log('    投稿文:');
  console.log('    ' + hr('·', 56));
  igDraft.content.post_text.split('\n').forEach(l => console.log(`      ${l}`));
  console.log('    ' + hr('·', 56));

  console.log('\n' + hr('═'));
}

// ── 安全な保存 ────────────────────────────────────────────────────

/**
 * 下書きを pending/ に安全に保存する。
 * - 既存ファイルを絶対に上書きしない
 * - 一時ファイル(.tmp)へ書いてからリネーム（破損防止）
 * - ID重複時は最大10回リトライ
 */
function safeSaveDraft(draft) {
  ensureDir(PENDING_DIR);

  const MAX_RETRY = 10;
  for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
    const id       = attempt === 0 ? draft.id : generateId();
    const filename = `${id}.json`;
    const filepath = path.join(PENDING_DIR, filename);
    const tmpPath  = filepath + '.tmp';

    if (!fs.existsSync(filepath)) {
      const dataToSave = { ...draft, id };
      try {
        fs.writeFileSync(tmpPath, JSON.stringify(dataToSave, null, 2), 'utf-8');
        // 書き込み後にJSONパースして破損チェック
        JSON.parse(fs.readFileSync(tmpPath, 'utf-8'));
        fs.renameSync(tmpPath, filepath);
        return { ok: true, id, filename };
      } catch (e) {
        // 失敗時は .tmp を削除して終了
        try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
        return { ok: false, reason: e.message };
      }
    }
  }
  return { ok: false, reason: 'ファイル名重複により保存に失敗しました（10回リトライ）。時間をおいて再実行してください。' };
}

// ── メイン処理 ────────────────────────────────────────────────────

async function main() {
  const settings = loadSettings();

  if (!settings) {
    console.error('\n[エラー] config/settings.json が読み込めません。');
    writeLog(['ERROR', 'generate_sns_draft.js 起動失敗', 'settings.json 読み込みエラー']);
    process.exit(1);
  }

  const xLimit       = settings?.platform_limits?.x_warning_length        ?? 280;
  const igLimit      = settings?.platform_limits?.instagram_warning_length ?? 2200;
  const xHashtagMax  = settings?.platform_limits?.x_hashtag_recommended_max ?? 3;

  console.log('\n' + hr('═'));
  console.log('  Snow flakes JARVIS - SNS下書き生成ツール v' + TOOL_VERSION);
  console.log('  ※ XとInstagram用の下書きをそれぞれ pending/ へ保存します。');
  console.log('  ※ 外部への投稿・SNS API接続・git操作は一切行いません。');
  console.log(hr('═'));

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  try {

    // ── 【1】告知種別 ────────────────────────────────────────────
    console.log('\n【1】告知種別を選択してください:\n');
    Object.entries(ANNOUNCE_TYPES).forEach(([k, v]) => console.log(`  ${k}. ${v.label}`));
    console.log('  0. キャンセル');

    const typeChoice = (await ask(rl, '\n番号 > ')).trim();
    if (typeChoice === '0') {
      console.log('\nキャンセルしました。\n');
      writeLog(['INFO', 'generate_sns_draft.js', 'ユーザーによりキャンセル（種別選択）']);
      rl.close();
      return;
    }
    const announceType = ANNOUNCE_TYPES[typeChoice];
    if (!announceType) {
      console.error('\n[エラー] 無効な選択です。\n');
      writeLog(['ERROR', 'generate_sns_draft.js', '無効な種別選択']);
      rl.close();
      process.exit(1);
    }
    console.log(`  → ${announceType.label}`);

    // ── 【2】投稿言語 ────────────────────────────────────────────
    console.log('\n【2】投稿言語を選択してください:');
    console.log('  1. 日本語のみ');
    console.log('  2. 日本語＋英語');
    const langChoice = (await ask(rl, '\n番号 > ')).trim();
    if (!['1', '2'].includes(langChoice)) {
      console.error('\n[エラー] 無効な選択です（1 または 2 を入力してください）。\n');
      rl.close();
      process.exit(1);
    }
    const lang = langChoice === '2' ? 'ja_en' : 'ja';
    console.log(`  → ${lang === 'ja_en' ? '日本語＋英語' : '日本語のみ'}`);

    // ── 【3】タイミング ──────────────────────────────────────────
    console.log('\n【3】タイミングを選択してください:');
    console.log('  1. 公開前（事前告知）');
    console.log('  2. 公開後（公開報告）');
    const timingChoice = (await ask(rl, '\n番号 > ')).trim();
    if (!['1', '2'].includes(timingChoice)) {
      console.error('\n[エラー] 無効な選択です（1 または 2 を入力してください）。\n');
      rl.close();
      process.exit(1);
    }
    const timing = timingChoice === '1' ? 'pre' : 'post';
    console.log(`  → ${timing === 'pre' ? '公開前' : '公開後'}`);

    // ── 【4】作品名・曲名 ────────────────────────────────────────
    console.log('\n【4】作品名または曲名（任意・Enterでスキップ）:');
    const workTitle = (await ask(rl, '  > ')).trim() || null;

    // ── 【5】告知内容（日本語） ──────────────────────────────────
    console.log('\n【5】告知内容（日本語・必須）:');
    const bodyJaRaw = (await ask(rl, '  > ')).trim();
    if (!bodyJaRaw) {
      console.error('\n[エラー] 告知内容（日本語）は必須です。\n');
      rl.close();
      process.exit(1);
    }

    // ── 【6】公開日 ──────────────────────────────────────────────
    console.log('\n【6】公開日（任意・例: 2026-08-10 / Enterでスキップ）:');
    const publishDate = (await ask(rl, '  > ')).trim() || null;

    // ── 【7】URL ─────────────────────────────────────────────────
    console.log('\n【7】URL（任意・http:// または https:// / Enterでスキップ）:');
    const urlRaw    = (await ask(rl, '  > ')).trim();
    const urlResult = validateUrl(urlRaw);
    if (!urlResult.ok) {
      console.error(`\n[エラー] ${urlResult.reason}\n`);
      rl.close();
      process.exit(1);
    }
    const url = urlResult.value;

    // ── 【8】X投稿にURLを含めるか ─────────────────────────────
    let includeUrlInPost = false;
    if (url) {
      console.log('\n【8】X投稿にURLを含めますか？');
      console.log('  y / yes → 含める');
      console.log('  n / no  → 含めない（Instagramはプロフィールリンク誘導文を使用）');
      const includeChoice = (await ask(rl, '\n  選択 > ')).trim().toLowerCase();
      includeUrlInPost = (includeChoice === 'y' || includeChoice === 'yes');
      console.log(`  → ${includeUrlInPost ? '含める' : '含めない'}`);
    }

    // ── 【9】使用素材の相対パス ──────────────────────────────────
    console.log('\n【9】使用画像・素材の相対パス（任意・スペース区切り・Enterでスキップ）:');
    console.log('  ※ ../を含むパス・絶対パスは拒否されます');
    const mediaRaw  = (await ask(rl, '  > ')).trim();
    const mediaPaths = [];
    if (mediaRaw) {
      const pathCandidates = mediaRaw.split(/\s+/).filter(p => p);
      for (const p of pathCandidates) {
        const result = validateMediaPath(p);
        if (!result.ok) {
          console.error(`\n[エラー] ${result.reason}\n`);
          rl.close();
          process.exit(1);
        }
        if (result.value) mediaPaths.push(result.value);
      }
    }

    // ── 【10】ハッシュタグ ───────────────────────────────────────
    console.log(`\n【10】ハッシュタグ（任意・スペース区切り・X推奨${xHashtagMax}個以内 / Enterでスキップ）:`);
    const hashtagRaw = (await ask(rl, '  > ')).trim();
    const hashtags   = normalizeHashtags(hashtagRaw);
    if (hashtags.length > xHashtagMax) {
      console.log(`  ⚠️  X推奨上限（${xHashtagMax}個）を超えています（現在: ${hashtags.length}個）。`);
    }
    if (hashtags.length > 0) {
      console.log(`  → ${hashtags.join(' ')}`);
    }

    // ── 【11】投稿予定日時 ───────────────────────────────────────
    console.log('\n【11】投稿予定日時（任意・例: 2026-08-10 または 2026-08-10 20:00 / Enterでスキップ）:');
    const scheduledRaw    = (await ask(rl, '  > ')).trim();
    const scheduledResult = validateScheduledAt(scheduledRaw);
    if (!scheduledResult.ok) {
      console.error(`\n[エラー] ${scheduledResult.reason}\n`);
      rl.close();
      process.exit(1);
    }
    const scheduledAt = scheduledResult.value;

    // ── 【12】英語入力（ja_en のみ） ─────────────────────────────
    let bodyEn     = null;
    let hashtagsEn = [];
    if (lang === 'ja_en') {
      console.log('\n【12a】英語タイトル（任意・Enterでスキップ）:');
      await ask(rl, '  > '); // タイトルはmetaに保存しないが入力は受け付ける

      console.log('\n【12b】英語の告知内容（任意・空欄の場合は日本語本文のみ使用）:');
      const bodyEnRaw = (await ask(rl, '  > ')).trim();
      bodyEn = bodyEnRaw || null;

      console.log('\n【12c】英語ハッシュタグ（任意・スペース区切り / Enterでスキップ）:');
      const hashtagEnRaw = (await ask(rl, '  > ')).trim();
      hashtagsEn = normalizeHashtags(hashtagEnRaw);
    }

    // 日英ハッシュタグのマージ（重複除去済み）
    const allHashtags = lang === 'ja_en'
      ? [...new Set([...hashtags, ...hashtagsEn])]
      : hashtags;

    // ── 投稿文の生成 ─────────────────────────────────────────────
    const postParams = {
      bodyJa:          bodyJaRaw,
      bodyEn,
      hashtags:        allHashtags,
      url,
      includeUrlInPost,
      lang,
      timing,
    };

    const xPostText  = buildXPostText(postParams);
    const igPostText = buildInstagramPostText(postParams, settings);

    // ── 下書きオブジェクトの生成 ─────────────────────────────────
    const groupId = generateGroupId();

    const commonInputs = {
      lang,
      timing,
      workTitle,
      bodyJa:          bodyJaRaw,
      bodyEn,
      publishDate,
      url,
      includeUrlInPost,
      mediaPaths,
      hashtags:        allHashtags,
      scheduledAt,
    };

    const xDraft  = buildDraft('x',         announceType, { ...commonInputs, postText: xPostText  }, groupId);
    const igDraft = buildDraft('instagram',  announceType, { ...commonInputs, postText: igPostText }, groupId);

    // ── プレビュー表示 ────────────────────────────────────────────
    printPreview(xDraft, igDraft);

    // 文字数超過があっても保存は可能だが、明示的に警告を再掲する
    if (xDraft.content.char_over || igDraft.content.char_over) {
      console.log('  ⚠️  文字数超過の下書きが含まれています。');
      console.log('      保存してapproveする前に本文を調整することを推奨します。');
    }

    // ── 保存確認 ─────────────────────────────────────────────────
    console.log('\n上記の内容で pending/ へ保存しますか？');
    console.log('  y / yes → 保存する（XとInstagram の両方）');
    console.log('  n / no  → 保存しないでキャンセル');
    const saveChoice = (await ask(rl, '\n  選択 > ')).trim().toLowerCase();

    if (saveChoice !== 'y' && saveChoice !== 'yes') {
      console.log('\nキャンセルしました。下書きは保存されていません。\n');
      writeLog(['INFO', 'generate_sns_draft.js', 'ユーザーによりキャンセル（保存確認）']);
      rl.close();
      return;
    }

    // ── 保存実行 ─────────────────────────────────────────────────
    rl.close();

    const xResult  = safeSaveDraft(xDraft);
    const igResult = safeSaveDraft(igDraft);

    if (!xResult.ok) {
      console.error(`\n[エラー] X用下書きの保存に失敗しました: ${xResult.reason}\n`);
      writeLog(['ERROR', 'generate_sns_draft.js', 'X下書き保存失敗']);
      process.exit(1);
    }

    if (!igResult.ok) {
      console.error(`\n[エラー] Instagram用下書きの保存に失敗しました: ${igResult.reason}\n`);
      writeLog(['ERROR', 'generate_sns_draft.js', 'Instagram下書き保存失敗']);
      process.exit(1);
    }

    console.log('\n✅ 下書きを保存しました:\n');
    console.log(`   X           : jarvis/drafts/pending/${xResult.filename}`);
    console.log(`   Instagram   : jarvis/drafts/pending/${igResult.filename}`);
    console.log(`   group_id    : ${groupId}`);
    console.log('\n⚠️  これらの下書きは承認されるまで外部へ送信されません。');
    console.log('   一覧確認    : npm run list');
    console.log('   詳細確認    : npm run show -- <draft-id>');
    console.log('   承認        : npm run approve -- <draft-id>');
    console.log('   差し戻し    : npm run reject  -- <draft-id>\n');

    // ログには本文・URL・ハッシュタグを記録しない
    writeLog([
      'SUCCESS',
      'generate_sns_draft.js',
      `type=${announceType.id}`,
      `x_id=${xResult.id}`,
      `ig_id=${igResult.id}`,
      `group_id=${groupId}`,
    ]);

  } catch (err) {
    console.error('\n[エラー] 予期しないエラーが発生しました:', err.message);
    writeLog(['ERROR', 'generate_sns_draft.js', `予期しないエラー: ${err.message}`]);
    rl.close();
    process.exit(1);
  }
}

main();
