#!/usr/bin/env node
/**
 * Snow flakes JARVIS - 投稿前チェック・Dry-run
 * preflight_check.js v0.1.0
 *
 * 使用方法（jarvis/ ディレクトリから実行）:
 *   npm run schedule-check -- <draft-id>
 *   npm run dry-run        -- <draft-id>
 *
 * 方針:
 *   - Node.js 標準機能のみ使用（外部パッケージなし）
 *   - 外部通信・SNS投稿・YouTube API・TikTok API・OAuth 認証・git 操作なし
 *   - 実際の投稿は行わない（dry_run_only=true を前提とする）
 *   - ログに投稿本文・タイトル・URL・ハッシュタグを記録しない
 *   - 設定不明・不正の場合は安全側（外部投稿無効）へ倒す
 *
 * 将来の YouTube API 接続について（第4段階後半で別途実装）:
 *   content.scheduled_at → YouTube API status.publishAt
 *   同時に status.privacyStatus = "private" を設定する。
 *   公開済み動画は予約公開の対象にしない。
 *   第4段階後半では YouTube Data API v3 のインストール済みアプリ向け
 *   OAuth 2.0 認証を採用する。具体的な認証方式は実装時点の
 *   Google 公式仕様を確認して決定する。
 *
 * 将来の差し替え設計（providers/ ディレクトリ）:
 *   providers/mock.js           ← 現在の dry-run 実体（常に DRY_RUN_SUCCESS）
 *   providers/twitter_v2.js     ← 将来: Twitter API v2
 *   providers/instagram_graph.js← 将来: Meta Graph API
 *   providers/youtube_data_v3.js← 将来: YouTube Data API v3
 */

import fs   from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

// ── パス設定 ─────────────────────────────────────────────────────
const __filename  = fileURLToPath(import.meta.url);
const __dirname   = path.dirname(__filename);
const JARVIS_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT   = path.resolve(JARVIS_ROOT, '..');
const APPROVED_DIR  = path.join(JARVIS_ROOT, 'drafts', 'approved');
const LOG_DIR       = path.join(JARVIS_ROOT, 'logs');
const LOG_PATH      = path.join(LOG_DIR, 'history.log');
const SETTINGS_PATH = path.join(JARVIS_ROOT, 'config', 'settings.json');

const VALID_PLATFORMS = ['x', 'instagram', 'youtube', 'tiktok', 'note'];
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
  } catch {}
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

function loadSettings() {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
  } catch {
    // 設定読み込み失敗時は安全側（外部投稿無効）へ倒す
    return {
      scheduling:     { allow_past_schedule: false, minimum_lead_minutes: 10, duplicate_window_minutes: 5, external_posting_enabled: false, dry_run_only: true },
      platform_posting: { x: { enabled: false }, instagram: { enabled: false }, youtube: { enabled: false }, tiktok: { enabled: false }, note: { enabled: false } },
      platform_limits:  { x_warning_length: 280, instagram_warning_length: 2200, x_hashtag_recommended_max: 3 },
      instagram:      { bio_link_note: null },
      youtube:        { require_made_for_kids_setting: true },
      tiktok:         { require_aigc_setting: true, caption_warning_length: 2200, direct_post_enabled: false },
      note:           { external_posting_enabled: false, minimum_body_length: 100, title_warning_length: 80, body_warning_length: 20000 },
      sns:            { x: { account: '@snflk_official' }, instagram: { account: 'snowflakes_official' } },
    };
  }
}

// ── チェックビルダー ─────────────────────────────────────────────

function chk(id, level, message) {
  return { id, level, message };
}

// ── 共通チェック ──────────────────────────────────────────────────

function runCommonChecks(draft, settings) {
  const checks = [];
  const sched  = settings.scheduling || {};
  const c      = draft.content || {};

  // status
  if (draft.status !== 'approved') {
    checks.push(chk('STATUS_CHECK', 'BLOCK', `status=${draft.status}（approved が必要）`));
  } else {
    checks.push(chk('STATUS_CHECK', 'OK', 'status=approved'));
  }

  // platform
  if (!VALID_PLATFORMS.includes(draft.platform)) {
    checks.push(chk('PLATFORM_VALID', 'BLOCK', `不正なplatform: ${draft.platform}`));
  } else {
    checks.push(chk('PLATFORM_VALID', 'OK', `platform=${draft.platform}`));
  }

  // 必須コンテンツ
  if (draft.platform === 'youtube') {
    if (!c.title || !c.title.trim()) {
      checks.push(chk('CONTENT_PRESENT', 'BLOCK', 'YouTube タイトルが空です'));
    } else {
      checks.push(chk('CONTENT_PRESENT', 'OK', `タイトル: ${c.title.length}文字`));
    }
  } else if (draft.platform === 'tiktok') {
    if (!c.caption || !c.caption.trim()) {
      checks.push(chk('CONTENT_PRESENT', 'BLOCK', 'caption が空です'));
    } else {
      checks.push(chk('CONTENT_PRESENT', 'OK', `caption: ${c.caption.length}文字`));
    }
  } else if (draft.platform === 'note') {
    // note のコンテンツ・スケジュール・外部投稿チェックは runNoteChecks で行う
    checks.push(chk('CONTENT_PRESENT', 'OK', 'note: コンテンツチェックは runNoteChecks で実施'));
    return checks;
  } else {
    if (!c.post_text || !c.post_text.trim()) {
      checks.push(chk('CONTENT_PRESENT', 'BLOCK', 'post_text が空です'));
    } else {
      checks.push(chk('CONTENT_PRESENT', 'OK', `post_text: ${c.post_text.length}文字`));
    }
  }

  // scheduled_at 存在
  if (!c.scheduled_at) {
    checks.push(chk('SCHEDULED_AT_PRESENT', 'BLOCK', 'scheduled_at が未設定です'));
    return checks; // 以降の日時チェック不要
  }

  // scheduled_at 形式
  if (!SCHEDULED_AT_RE.test(c.scheduled_at)) {
    checks.push(chk('SCHEDULED_AT_FORMAT', 'BLOCK', `日時形式が不正: ${c.scheduled_at}`));
    return checks;
  }
  const d = new Date(c.scheduled_at.replace(' ', 'T'));
  if (isNaN(d.getTime())) {
    checks.push(chk('SCHEDULED_AT_FORMAT', 'BLOCK', `日時に変換できません: ${c.scheduled_at}`));
    return checks;
  }
  checks.push(chk('SCHEDULED_AT_FORMAT', 'OK', `scheduled_at: ${c.scheduled_at}`));

  // 過去日時・準備時間
  const now    = Date.now();
  const targMs = d.getTime();
  const leadMs = (sched.minimum_lead_minutes ?? 10) * 60 * 1000;

  const isVideoplatform = draft.platform === 'youtube' || draft.platform === 'tiktok';
  if (targMs < now) {
    // YouTube/TikTok: 即時公開・アップロードの危険 → BLOCK / SNS: WARN
    const level = isVideoplatform ? 'BLOCK' : 'WARN';
    const note  = isVideoplatform ? '（即時公開の危険があるため BLOCKED）' : '（要確認）';
    checks.push(chk('SCHEDULED_AT_PAST', level, `過去日時 ${note}`));
  } else if (targMs - now < leadMs) {
    const level = isVideoplatform ? 'BLOCK' : 'WARN';
    checks.push(chk('SCHEDULED_AT_TOO_SOON', level, `投稿まで ${sched.minimum_lead_minutes ?? 10} 分未満`));
  } else {
    checks.push(chk('SCHEDULED_AT_TIMING', 'OK', '日時: 未来かつ十分な余裕あり'));
  }

  // external_posting_enabled 矛盾チェック（安全装置）
  const extEnabled = sched.external_posting_enabled;
  const dryOnly    = sched.dry_run_only;
  if (extEnabled === true && dryOnly === false) {
    checks.push(chk('EXTERNAL_POSTING_UNSAFE', 'BLOCK', '設定矛盾: external_posting_enabled=true かつ dry_run_only=false'));
  } else {
    checks.push(chk('EXTERNAL_POSTING_DISABLED', 'OK', '外部投稿: 無効（dry_run_only=true）'));
  }

  return checks;
}

// ── X 固有チェック ────────────────────────────────────────────────

function runXChecks(draft, settings) {
  const checks  = [];
  const c       = draft.content || {};
  const limits  = settings.platform_limits || {};
  const maxLen  = limits.x_warning_length || 280;
  const maxTags = limits.x_hashtag_recommended_max || 3;

  // URL 形式
  if (c.url && !/^https?:\/\/.+/i.test(c.url)) {
    checks.push(chk('URL_FORMAT', 'WARN', 'URL形式が不正（http/https で始まる必要があります）'));
  }

  // 文字数
  if (c.char_over === true) {
    checks.push(chk('X_CHAR_OVER', 'WARN', `文字数超過: ${c.char_count}文字（上限 ${maxLen}）`));
  } else {
    checks.push(chk('X_CHAR_OK', 'OK', `文字数: ${c.char_count ?? '不明'}文字`));
  }

  // ハッシュタグ数
  const tagCount = Array.isArray(c.hashtags) ? c.hashtags.length : 0;
  if (tagCount > maxTags) {
    checks.push(chk('X_HASHTAG_OVER', 'WARN', `ハッシュタグ ${tagCount} 件（推奨上限 ${maxTags}）`));
  } else {
    checks.push(chk('X_HASHTAG_OK', 'OK', `ハッシュタグ ${tagCount} 件`));
  }

  // URL 整合性
  if (c.include_url_in_post === true && !c.url) {
    checks.push(chk('X_URL_MISMATCH', 'WARN', 'include_url_in_post=true だが url が未設定'));
  } else {
    checks.push(chk('X_URL_OK', 'OK', 'URL設定整合'));
  }

  return checks;
}

// ── Instagram 固有チェック ────────────────────────────────────────

function runInstagramChecks(draft, settings) {
  const checks     = [];
  const c          = draft.content || {};
  const limits     = settings.platform_limits || {};
  const maxLen     = limits.instagram_warning_length || 2200;
  const igSettings = settings.instagram || {};

  // URL 形式
  if (c.url && !/^https?:\/\/.+/i.test(c.url)) {
    checks.push(chk('URL_FORMAT', 'WARN', 'URL形式が不正（http/https で始まる必要があります）'));
  }

  // 文字数
  if (c.char_over === true) {
    checks.push(chk('IG_CHAR_OVER', 'WARN', `文字数超過: ${c.char_count}文字（上限 ${maxLen}）`));
  } else {
    checks.push(chk('IG_CHAR_OK', 'OK', `文字数: ${c.char_count ?? '不明'}文字`));
  }

  // 素材ファイル
  const mediaPaths = Array.isArray(c.media_paths) ? c.media_paths : [];
  if (mediaPaths.length === 0) {
    checks.push(chk('IG_NO_MEDIA', 'WARN', '素材ファイルが未設定'));
  } else {
    checks.push(chk('IG_MEDIA_OK', 'OK', `素材 ${mediaPaths.length} 件`));
    for (const mp of mediaPaths) {
      if (mp.includes('../') || mp.includes('..\\')) {
        checks.push(chk('IG_MEDIA_TRAVERSAL', 'BLOCK', `素材パスに ../ を含む`));
        break;
      }
      if (/^[/\\]/.test(mp) || /^[A-Za-z]:[/\\]/.test(mp)) {
        checks.push(chk('IG_MEDIA_ABSOLUTE', 'BLOCK', '素材パスが絶対パス'));
        break;
      }
      const fullPath = path.resolve(REPO_ROOT, mp);
      if (!fs.existsSync(fullPath)) {
        checks.push(chk('IG_MEDIA_NOT_FOUND', 'WARN', `素材ファイルが存在しない（パスのみ確認）`));
      }
    }
  }

  // bio_link_note
  if (!igSettings.bio_link_note) {
    checks.push(chk('IG_NO_BIO_LINK_NOTE', 'WARN', 'bio_link_note が settings に未設定'));
  } else {
    checks.push(chk('IG_BIO_LINK_NOTE_OK', 'OK', 'bio_link_note 設定済み'));
  }

  return checks;
}

// ── YouTube 固有チェック ─────────────────────────────────────────

function runYouTubeChecks(draft, settings) {
  const checks     = [];
  const c          = draft.content || {};
  const ytSettings = settings.youtube || {};

  // type 確認
  if (draft.type !== 'youtube_video') {
    checks.push(chk('YT_TYPE_CHECK', 'BLOCK', `type が youtube_video ではありません: ${draft.type}`));
  } else {
    checks.push(chk('YT_TYPE_CHECK', 'OK', 'type=youtube_video'));
  }

  // 動画ファイルパス
  if (!c.video_path || !c.video_path.trim()) {
    checks.push(chk('YT_VIDEO_PATH_MISSING', 'BLOCK', '動画ファイルパスが未設定'));
  } else if (c.video_path.includes('../') || c.video_path.includes('..\\')) {
    checks.push(chk('YT_VIDEO_PATH_TRAVERSAL', 'BLOCK', '動画パスに ../ を含む'));
  } else if (/^[/\\]/.test(c.video_path) || /^[A-Za-z]:[/\\]/.test(c.video_path)) {
    checks.push(chk('YT_VIDEO_PATH_ABSOLUTE', 'BLOCK', '動画パスが絶対パス'));
  } else {
    const fullPath = path.resolve(REPO_ROOT, c.video_path);
    if (!fs.existsSync(fullPath)) {
      checks.push(chk('YT_VIDEO_NOT_FOUND', 'BLOCK', '動画ファイルが存在しない'));
    } else {
      checks.push(chk('YT_VIDEO_OK', 'OK', '動画ファイル確認 OK'));
    }
  }

  // サムネイル
  if (!c.thumbnail_path || !c.thumbnail_path.trim()) {
    checks.push(chk('YT_THUMBNAIL_MISSING', 'WARN', 'サムネイルパスが未設定'));
  } else if (c.thumbnail_path.includes('../') || c.thumbnail_path.includes('..\\')) {
    checks.push(chk('YT_THUMBNAIL_PATH_TRAVERSAL', 'BLOCK', 'サムネイルパスに ../ を含む'));
  } else if (/^[/\\]/.test(c.thumbnail_path) || /^[A-Za-z]:[/\\]/.test(c.thumbnail_path)) {
    checks.push(chk('YT_THUMBNAIL_PATH_ABSOLUTE', 'BLOCK', 'サムネイルパスが絶対パス'));
  } else {
    const fullPath = path.resolve(REPO_ROOT, c.thumbnail_path);
    if (!fs.existsSync(fullPath)) {
      checks.push(chk('YT_THUMBNAIL_NOT_FOUND', 'WARN', 'サムネイルファイルが存在しない'));
    } else {
      checks.push(chk('YT_THUMBNAIL_OK', 'OK', 'サムネイル確認 OK'));
    }
  }

  // 説明文
  if (!c.description || !c.description.trim()) {
    checks.push(chk('YT_DESCRIPTION_EMPTY', 'WARN', '説明文が未設定'));
  } else {
    checks.push(chk('YT_DESCRIPTION_OK', 'OK', `説明文: ${c.description.length}文字`));
  }

  // made_for_kids
  if (ytSettings.require_made_for_kids_setting !== false && c.made_for_kids === null) {
    checks.push(chk('YT_MADE_FOR_KIDS_UNSET', 'BLOCK', 'made_for_kids が未設定（明示が必要）'));
  } else {
    checks.push(chk('YT_MADE_FOR_KIDS_OK', 'OK', `made_for_kids=${c.made_for_kids}`));
  }

  // privacy_status
  if (c.privacy_status !== 'private') {
    checks.push(chk('YT_PRIVACY_NOT_PRIVATE', 'BLOCK', `privacy_status="${c.privacy_status}"（"private" が必要）`));
  } else {
    checks.push(chk('YT_PRIVACY_OK', 'OK', 'privacy_status=private'));
  }

  // publish_mode
  if (c.publish_mode !== 'scheduled') {
    checks.push(chk('YT_PUBLISH_MODE_INVALID', 'BLOCK', `publish_mode="${c.publish_mode}"（"scheduled" が必要）`));
  } else {
    checks.push(chk('YT_PUBLISH_MODE_OK', 'OK', 'publish_mode=scheduled'));
  }

  // タグ
  if (!Array.isArray(c.tags) || c.tags.length === 0) {
    checks.push(chk('YT_TAGS_EMPTY', 'WARN', 'タグが未設定'));
  } else {
    checks.push(chk('YT_TAGS_OK', 'OK', `タグ ${c.tags.length} 件`));
  }

  // 再生リスト
  if (!c.playlist_id) {
    checks.push(chk('YT_PLAYLIST_UNSET', 'WARN', '再生リストIDが未設定'));
  } else {
    checks.push(chk('YT_PLAYLIST_OK', 'OK', '再生リストID設定済み'));
  }

  // category_id（null → WARNING）
  if (c.category_id === null || c.category_id === undefined) {
    checks.push(chk('YT_CATEGORY_UNSET', 'WARN', 'category_id が未設定'));
  } else {
    checks.push(chk('YT_CATEGORY_OK', 'OK', `category_id=${c.category_id}`));
  }

  // 将来のAPI変換設計（OK として記録・実際の変換はしない）
  checks.push(chk('YT_API_MAPPING', 'OK',
    '将来API変換: content.scheduled_at → status.publishAt（同時に privacyStatus=private 設定）'));

  return checks;
}

// ── TikTok 固有チェック ──────────────────────────────────────────

function runTikTokChecks(draft, settings) {
  const checks     = [];
  const c          = draft.content || {};
  const tkSettings = settings.tiktok || {};
  const warnLen    = tkSettings.caption_warning_length ?? 2200;
  const VALID_POST_MODES    = ['media_upload', 'direct_post'];
  const VALID_PRIVACY_LEVELS = ['PUBLIC_TO_EVERYONE', 'MUTUAL_FOLLOW_FRIENDS', 'FOLLOWER_OF_CREATOR', 'SELF_ONLY'];

  // type 確認
  if (draft.type !== 'tiktok_video') {
    checks.push(chk('TK_TYPE_CHECK', 'BLOCK', `type が tiktok_video ではありません: ${draft.type}`));
  } else {
    checks.push(chk('TK_TYPE_CHECK', 'OK', 'type=tiktok_video'));
  }

  // 動画ファイルパス
  if (!c.video_path || !c.video_path.trim()) {
    checks.push(chk('TK_VIDEO_PATH_MISSING', 'BLOCK', '動画ファイルパスが未設定'));
  } else if (c.video_path.includes('../') || c.video_path.includes('..\\')) {
    checks.push(chk('TK_VIDEO_PATH_TRAVERSAL', 'BLOCK', '動画パスに ../ を含む'));
  } else if (/^[/\\]/.test(c.video_path) || /^[A-Za-z]:[/\\]/.test(c.video_path)) {
    checks.push(chk('TK_VIDEO_PATH_ABSOLUTE', 'BLOCK', '動画パスが絶対パス'));
  } else {
    const fullPath = path.resolve(REPO_ROOT, c.video_path);
    if (!fs.existsSync(fullPath)) {
      checks.push(chk('TK_VIDEO_NOT_FOUND', 'BLOCK', '動画ファイルが存在しない'));
    } else {
      checks.push(chk('TK_VIDEO_OK', 'OK', '動画ファイル確認 OK'));
    }
  }

  // カバー画像
  if (!c.cover_path || !c.cover_path.trim()) {
    checks.push(chk('TK_COVER_MISSING', 'WARN', 'カバー画像パスが未設定'));
  } else if (c.cover_path.includes('../') || c.cover_path.includes('..\\')) {
    checks.push(chk('TK_COVER_TRAVERSAL', 'BLOCK', 'カバー画像パスに ../ を含む'));
  } else if (/^[/\\]/.test(c.cover_path) || /^[A-Za-z]:[/\\]/.test(c.cover_path)) {
    checks.push(chk('TK_COVER_ABSOLUTE', 'BLOCK', 'カバー画像パスが絶対パス'));
  } else {
    const fullPath = path.resolve(REPO_ROOT, c.cover_path);
    if (!fs.existsSync(fullPath)) {
      checks.push(chk('TK_COVER_NOT_FOUND', 'WARN', 'カバー画像ファイルが存在しない'));
    } else {
      checks.push(chk('TK_COVER_OK', 'OK', 'カバー画像確認 OK'));
    }
  }

  // キャプション文字数
  if (c.caption && c.caption.length > warnLen) {
    checks.push(chk('TK_CAPTION_OVER', 'WARN', `キャプション文字数超過: ${c.caption.length}文字（警告上限 ${warnLen}）`));
  }

  // ハッシュタグ
  if (!Array.isArray(c.hashtags) || c.hashtags.length === 0) {
    checks.push(chk('TK_HASHTAGS_EMPTY', 'WARN', 'ハッシュタグが未設定'));
  } else {
    checks.push(chk('TK_HASHTAGS_OK', 'OK', `ハッシュタグ ${c.hashtags.length} 件`));
  }

  // post_mode
  if (!VALID_POST_MODES.includes(c.post_mode)) {
    checks.push(chk('TK_POST_MODE_INVALID', 'BLOCK', `post_mode が不正: "${c.post_mode}"（media_upload / direct_post のみ有効）`));
  } else {
    checks.push(chk('TK_POST_MODE_OK', 'OK', `post_mode=${c.post_mode}`));
    if (c.post_mode === 'direct_post') {
      if (tkSettings.direct_post_enabled === false) {
        checks.push(chk('TK_DIRECT_POST_DISABLED', 'BLOCK',
          'DIRECT_POST は無効です（settings.tiktok.direct_post_enabled=false）'));
      }
      checks.push(chk('TK_DIRECT_POST_WARNING', 'WARN', 'DIRECT_POST: アプリ審査・公開権限の確認が完了するまで外部投稿は無効'));
      checks.push(chk('TK_UNREVIEWED_APP_NOTE', 'WARN', '未審査アプリでは公開範囲が制限される可能性があります'));
      // direct_post の場合は privacy_level が必須
      if (!c.privacy_level || !VALID_PRIVACY_LEVELS.includes(c.privacy_level)) {
        checks.push(chk('TK_DIRECT_POST_NO_PRIVACY', 'BLOCK', `DIRECT_POST に必要な公開範囲（privacy_level）が未設定`));
      } else {
        checks.push(chk('TK_PRIVACY_OK', 'OK', `privacy_level=${c.privacy_level}`));
      }
    }
  }

  // is_aigc（必須・null は BLOCK）
  if (c.is_aigc === null || c.is_aigc === undefined) {
    checks.push(chk('TK_AIGC_UNSET', 'BLOCK', 'is_aigc が未設定（明示が必要）'));
  } else {
    checks.push(chk('TK_AIGC_OK', 'OK', `is_aigc=${c.is_aigc}`));
  }

  // コメント・デュエット・Stitch（null の場合のみ WARN）
  if (c.disable_comment === null || c.disable_comment === undefined) {
    checks.push(chk('TK_COMMENT_UNSET', 'WARN', 'disable_comment が未設定（要確認）'));
  } else {
    checks.push(chk('TK_COMMENT_OK', 'OK', `コメント: ${c.disable_comment ? '禁止' : '許可'}`));
  }
  if (c.disable_duet === null || c.disable_duet === undefined) {
    checks.push(chk('TK_DUET_UNSET', 'WARN', 'disable_duet が未設定（要確認）'));
  } else {
    checks.push(chk('TK_DUET_OK', 'OK', `デュエット: ${c.disable_duet ? '禁止' : '許可'}`));
  }
  if (c.disable_stitch === null || c.disable_stitch === undefined) {
    checks.push(chk('TK_STITCH_UNSET', 'WARN', 'disable_stitch が未設定（要確認）'));
  } else {
    checks.push(chk('TK_STITCH_OK', 'OK', `Stitch: ${c.disable_stitch ? '禁止' : '許可'}`));
  }

  // brand_organic_toggle（null の場合のみ WARN）
  if (c.brand_organic_toggle === null || c.brand_organic_toggle === undefined) {
    checks.push(chk('TK_BRAND_ORGANIC_UNSET', 'WARN', 'brand_organic_toggle が未設定（要確認）'));
  } else {
    checks.push(chk('TK_BRAND_ORGANIC_OK', 'OK', `brand_organic_toggle=${c.brand_organic_toggle}`));
  }

  return checks;
}

// ── note 固有チェック ────────────────────────────────────────────

function runNoteChecks(draft, settings) {
  const checks       = [];
  const c            = draft.content || {};
  const noteSettings = settings.note || { external_posting_enabled: false, minimum_body_length: 100, title_warning_length: 80, body_warning_length: 20000 };
  const sched        = settings.scheduling || {};

  const VALID_ARTICLE_TYPES = [
    '小説', '短編', '制作日記', '楽曲解説', '活動報告',
    'イベント告知', 'お知らせ', 'コラム', '有料記事', 'その他',
  ];

  // NOTE_TYPE_CHECK
  if (draft.type !== 'note_article') {
    checks.push(chk('NOTE_TYPE_CHECK', 'BLOCK', `type が note_article ではありません: ${draft.type}`));
  } else {
    checks.push(chk('NOTE_TYPE_CHECK', 'OK', 'type=note_article'));
  }

  // NOTE_TITLE_EMPTY / NOTE_TITLE_OVER
  if (!c.title || !c.title.trim()) {
    checks.push(chk('NOTE_TITLE_EMPTY', 'BLOCK', 'タイトルが空です'));
  } else {
    checks.push(chk('NOTE_TITLE_EMPTY', 'OK', `タイトル: ${c.title.length}文字`));
    const titleWarnLen = noteSettings.title_warning_length ?? 80;
    if (c.title.length > titleWarnLen) {
      checks.push(chk('NOTE_TITLE_OVER', 'WARN', `タイトルが長すぎます: ${c.title.length}文字（警告上限 ${titleWarnLen}）`));
    }
  }

  // NOTE_BODY_EMPTY / NOTE_BODY_TOO_SHORT / NOTE_BODY_OVER
  if (!c.body || !c.body.trim()) {
    checks.push(chk('NOTE_BODY_EMPTY', 'BLOCK', '本文が空です'));
  } else {
    const minBody = noteSettings.minimum_body_length ?? 100;
    const maxBody = noteSettings.body_warning_length ?? 20000;
    checks.push(chk('NOTE_BODY_EMPTY', 'OK', `本文: ${c.body.length}文字`));
    if (c.body.length < minBody) {
      checks.push(chk('NOTE_BODY_TOO_SHORT', 'WARN', `本文が短すぎます: ${c.body.length}文字（推奨最低 ${minBody}文字）`));
    }
    if (c.body.length > maxBody) {
      checks.push(chk('NOTE_BODY_OVER', 'WARN', `本文が長すぎます: ${c.body.length}文字（警告上限 ${maxBody}）`));
    }
  }

  // NOTE_ARTICLE_TYPE_INVALID
  if (!c.article_type || !VALID_ARTICLE_TYPES.includes(c.article_type)) {
    checks.push(chk('NOTE_ARTICLE_TYPE_INVALID', 'BLOCK', `記事タイプが不正: "${c.article_type}"（有効値: ${VALID_ARTICLE_TYPES.join(' / ')}）`));
  } else {
    checks.push(chk('NOTE_ARTICLE_TYPE_INVALID', 'OK', `article_type=${c.article_type}`));
  }

  // scheduled_at（note: missing→WARN, format invalid→BLOCK, past→BLOCK, too-soon→WARN）
  if (!c.scheduled_at) {
    checks.push(chk('NOTE_SCHEDULED_AT_MISSING', 'WARN', 'scheduled_at が未設定です（noteへの予約登録は行いません）'));
  } else if (!SCHEDULED_AT_RE.test(c.scheduled_at)) {
    checks.push(chk('NOTE_SCHEDULED_AT_FORMAT', 'BLOCK', `日時形式が不正: ${c.scheduled_at}`));
  } else {
    const d = new Date(c.scheduled_at.replace(' ', 'T'));
    if (isNaN(d.getTime())) {
      checks.push(chk('NOTE_SCHEDULED_AT_FORMAT', 'BLOCK', `日時に変換できません: ${c.scheduled_at}`));
    } else {
      checks.push(chk('NOTE_SCHEDULED_AT_FORMAT', 'OK', `scheduled_at: ${c.scheduled_at}`));
      const now    = Date.now();
      const targMs = d.getTime();
      const leadMs = (sched.minimum_lead_minutes ?? 10) * 60 * 1000;
      if (targMs < now) {
        checks.push(chk('NOTE_SCHEDULED_AT_PAST', 'BLOCK', '過去日時です（JARVIS内の予定として要確認）'));
      } else if (targMs - now < leadMs) {
        checks.push(chk('NOTE_SCHEDULED_AT_TOO_SOON', 'WARN', `予定まで ${sched.minimum_lead_minutes ?? 10} 分未満`));
      } else {
        checks.push(chk('NOTE_SCHEDULED_AT_TIMING', 'OK', '日時: 未来かつ十分な余裕あり'));
      }
    }
  }

  // NOTE_VISIBILITY_INVALID
  if (c.visibility !== 'free' && c.visibility !== 'paid') {
    checks.push(chk('NOTE_VISIBILITY_INVALID', 'BLOCK', `visibility が不正: "${c.visibility}"（free / paid のみ有効）`));
  } else {
    checks.push(chk('NOTE_VISIBILITY_INVALID', 'OK', `visibility=${c.visibility}`));

    if (c.visibility === 'paid') {
      // NOTE_PRICE_REQUIRED / NOTE_PRICE_INVALID
      if (c.price === null || c.price === undefined) {
        checks.push(chk('NOTE_PRICE_REQUIRED', 'BLOCK', '有料記事に価格（price）が設定されていません'));
      } else if (typeof c.price !== 'number' || !Number.isInteger(c.price) || c.price <= 0) {
        checks.push(chk('NOTE_PRICE_INVALID', 'BLOCK', `price が不正: ${c.price}（正の整数が必要）`));
      } else {
        checks.push(chk('NOTE_PRICE_INVALID', 'OK', `price=${c.price}円`));
      }
      // NOTE_PAID_SECTION_UNSET
      if (!c.paid_section_marker) {
        checks.push(chk('NOTE_PAID_SECTION_UNSET', 'WARN', '有料パートの区切りマーカーが未設定です'));
      } else {
        checks.push(chk('NOTE_PAID_SECTION_UNSET', 'OK', '有料区切りマーカー設定済み'));
      }
    } else {
      // NOTE_FREE_PRICE_SET
      if (c.price !== null && c.price !== undefined) {
        checks.push(chk('NOTE_FREE_PRICE_SET', 'WARN', `無料記事に price が設定されています: ${c.price}（設定不整合の可能性）`));
      }
    }
  }

  // アイキャッチ（BLOCK: traversal/absolute, WARN: missing/not-found）
  if (!c.eyecatch_path) {
    checks.push(chk('NOTE_EYECATCH_MISSING', 'WARN', 'アイキャッチ画像パスが未設定です'));
  } else if (c.eyecatch_path.includes('../') || c.eyecatch_path.includes('..\\')) {
    checks.push(chk('NOTE_EYECATCH_TRAVERSAL', 'BLOCK', 'アイキャッチパスに ../ を含みます'));
  } else if (/^[/\\]/.test(c.eyecatch_path) || /^[A-Za-z]:[/\\]/.test(c.eyecatch_path)) {
    checks.push(chk('NOTE_EYECATCH_ABSOLUTE', 'BLOCK', 'アイキャッチパスが絶対パスです'));
  } else {
    const fullPath = path.resolve(REPO_ROOT, c.eyecatch_path);
    if (!fs.existsSync(fullPath)) {
      checks.push(chk('NOTE_EYECATCH_NOT_FOUND', 'WARN', 'アイキャッチファイルが見つかりません'));
    } else {
      checks.push(chk('NOTE_EYECATCH_OK', 'OK', 'アイキャッチファイル確認 OK'));
    }
  }

  // NOTE_LEAD_EMPTY
  if (!c.lead) {
    checks.push(chk('NOTE_LEAD_EMPTY', 'WARN', 'リード文が未設定です'));
  } else {
    checks.push(chk('NOTE_LEAD_EMPTY', 'OK', `リード文: ${c.lead.length}文字`));
  }

  // NOTE_SUMMARY_EMPTY
  if (!c.summary) {
    checks.push(chk('NOTE_SUMMARY_EMPTY', 'WARN', 'まとめが未設定です'));
  } else {
    checks.push(chk('NOTE_SUMMARY_EMPTY', 'OK', `まとめ: ${c.summary.length}文字`));
  }

  // headings（WARN: not-array, empty）
  if (!Array.isArray(c.headings)) {
    checks.push(chk('NOTE_HEADINGS_NOT_ARRAY', 'WARN', 'headings が配列ではありません'));
  } else if (c.headings.length === 0) {
    checks.push(chk('NOTE_HEADINGS_EMPTY', 'WARN', '見出し構成メモが未設定です'));
  } else {
    checks.push(chk('NOTE_HEADINGS_OK', 'OK', `見出しメモ ${c.headings.length} 件`));
  }

  // hashtags（WARN: not-array, empty）
  if (!Array.isArray(c.hashtags)) {
    checks.push(chk('NOTE_HASHTAGS_NOT_ARRAY', 'WARN', 'hashtags が配列ではありません'));
  } else if (c.hashtags.length === 0) {
    checks.push(chk('NOTE_HASHTAGS_EMPTY', 'WARN', 'ハッシュタグが未設定です'));
  } else {
    checks.push(chk('NOTE_HASHTAGS_OK', 'OK', `ハッシュタグ ${c.hashtags.length} 件`));
  }

  // NOTE_MAGAZINE_UNSET
  if (!c.magazine_name && !c.magazine_id) {
    checks.push(chk('NOTE_MAGAZINE_UNSET', 'WARN', 'マガジン名・IDが未設定です'));
  } else {
    checks.push(chk('NOTE_MAGAZINE_OK', 'OK', 'マガジン設定あり'));
  }

  // NOTE_COMMENTS_UNCONFIRMED / NOTE_COMMENTS_INVALID
  if (c.comments_enabled === null || c.comments_enabled === undefined) {
    checks.push(chk('NOTE_COMMENTS_UNCONFIRMED', 'WARN', 'コメント設定が未確認です'));
  } else if (typeof c.comments_enabled !== 'boolean') {
    checks.push(chk('NOTE_COMMENTS_INVALID', 'WARN', `comments_enabled が不正な型です: ${typeof c.comments_enabled}`));
  } else {
    checks.push(chk('NOTE_COMMENTS_OK', 'OK', `コメント: ${c.comments_enabled ? '許可' : '禁止'}`));
  }

  // NOTE_UNPUBLISHED_UNCONFIRMED / NOTE_UNPUBLISHED_INFO_TRUE
  if (c.contains_unpublished_information === null || c.contains_unpublished_information === undefined) {
    checks.push(chk('NOTE_UNPUBLISHED_UNCONFIRMED', 'BLOCK', 'contains_unpublished_information が未設定です（必須）'));
  } else if (c.contains_unpublished_information === true) {
    checks.push(chk('NOTE_UNPUBLISHED_INFO_TRUE', 'WARN', '未公開情報を含む記事です（公開前に必ず内容を確認してください）'));
  } else {
    checks.push(chk('NOTE_UNPUBLISHED_OK', 'OK', '未公開情報なし'));
  }

  // NOTE_REQUIRES_FINAL_CONFIRMATION / NOTE_FINAL_CONFIRMATION_INVALID
  if (c.requires_final_confirmation === null || c.requires_final_confirmation === undefined) {
    checks.push(chk('NOTE_FINAL_CONFIRMATION_INVALID', 'WARN', 'requires_final_confirmation が未設定です'));
  } else if (typeof c.requires_final_confirmation !== 'boolean') {
    checks.push(chk('NOTE_FINAL_CONFIRMATION_INVALID', 'WARN', `requires_final_confirmation が不正な型です: ${typeof c.requires_final_confirmation}`));
  } else if (c.requires_final_confirmation === true) {
    checks.push(chk('NOTE_REQUIRES_FINAL_CONFIRMATION', 'WARN', '最終確認が必要です（公開前に必ず目視確認してください）'));
  } else {
    checks.push(chk('NOTE_FINAL_CONFIRMATION_OK', 'OK', '最終確認: 不要に設定済み'));
  }

  // NOTE_EXTERNAL_POSTING_ENABLED（安全装置）
  if (noteSettings.external_posting_enabled === true) {
    checks.push(chk('NOTE_EXTERNAL_POSTING_ENABLED', 'BLOCK',
      'note外部投稿が有効になっています（settings.note.external_posting_enabled=true）安全のため無効にしてください'));
  } else {
    checks.push(chk('NOTE_EXTERNAL_POSTING_DISABLED', 'OK', '外部投稿: 無効（external_posting_enabled=false）'));
  }

  return checks;
}

// ── 重複候補チェック ─────────────────────────────────────────────

function runDuplicateCheck(draft, settings) {
  const checks   = [];
  const sched    = settings.scheduling || {};
  const windowMs = (sched.duplicate_window_minutes ?? 5) * 60 * 1000;
  const c        = draft.content || {};

  if (!c.scheduled_at) return checks;

  // SNS下書きは group_id がトップレベル、YouTube は meta.group_id の可能性も考慮
  const groupId = draft.group_id ?? draft.meta?.group_id ?? null;
  if (!groupId) return checks;

  try {
    const files = fs.readdirSync(APPROVED_DIR)
      .filter(f => f.endsWith('.json') && f !== `${draft.id}.json`);
    for (const f of files) {
      const r = readDraftFile(path.join(APPROVED_DIR, f));
      if (!r.ok) continue;
      const d2      = r.data;
      const gid2    = d2.group_id ?? d2.meta?.group_id ?? null;
      if (gid2 !== groupId)       continue;
      if (d2.platform !== draft.platform) continue;
      if (!d2.content?.scheduled_at)      continue;
      const diff = Math.abs(
        new Date(c.scheduled_at.replace(' ', 'T')) -
        new Date(d2.content.scheduled_at.replace(' ', 'T'))
      );
      if (diff < windowMs) {
        checks.push(chk('DUPLICATE_CANDIDATE', 'WARN',
          `同一group_id・platformで近接予約あり（${Math.round(diff / 60000)} 分差）`));
        break;
      }
    }
  } catch { /* ディレクトリ読み取り失敗は無視 */ }

  return checks;
}

// ── チェック集計 ─────────────────────────────────────────────────

function runAllChecks(draft, settings) {
  const checks = [
    ...runCommonChecks(draft, settings),
    ...(draft.platform === 'youtube'   ? runYouTubeChecks(draft, settings)   : []),
    ...(draft.platform === 'tiktok'    ? runTikTokChecks(draft, settings)    : []),
    ...(draft.platform === 'x'         ? runXChecks(draft, settings)         : []),
    ...(draft.platform === 'instagram' ? runInstagramChecks(draft, settings) : []),
    ...(draft.platform === 'note'      ? runNoteChecks(draft, settings)      : []),
    ...runDuplicateCheck(draft, settings),
  ];

  const errorCount   = checks.filter(c => c.level === 'BLOCK').length;
  const warningCount = checks.filter(c => c.level === 'WARN').length;
  const result       = errorCount > 0 ? 'BLOCKED' : warningCount > 0 ? 'WARNING' : 'READY';

  return { checks, errorCount, warningCount, result };
}

// ── コマンド: check ───────────────────────────────────────────────

function cmdCheck(id) {
  const v = validateId(id);
  if (!v.ok) { console.error(`\n[エラー] ${v.reason}\n`); process.exit(1); }

  const filePath   = path.join(APPROVED_DIR, `${id}.json`);
  const fileResult = readDraftFile(filePath);
  if (!fileResult.ok) {
    console.error(`\n[エラー] ${fileResult.reason}（approved/${id}.json）`);
    console.log('\n  判定: BLOCKED（ファイル読み込み不可）\n');
    writeLog(['PREFLIGHT', `id=${id}`, 'result=BLOCKED', 'errors=1', 'reason=ファイル読み込み失敗']);
    process.exit(1);
  }

  const draft    = fileResult.data;
  const settings = loadSettings();
  const { checks, errorCount, warningCount, result } = runAllChecks(draft, settings);

  // 表示
  const W = 64;
  console.log('\n' + hr('═', W));
  console.log(`  投稿前チェック: ${id}`);
  console.log(hr('─', W));
  console.log(`  プラットフォーム: ${draft.platform}`);
  console.log(`  scheduled_at   : ${draft.content?.scheduled_at ?? '（未設定）'}`);
  console.log(hr('─', W));

  for (const c of checks) {
    const icon = c.level === 'OK' ? '✅' : c.level === 'WARN' ? '⚠️ ' : '❌';
    console.log(`  ${icon} [${c.level.padEnd(5)}] ${c.message}`);
  }

  console.log(hr('─', W));
  console.log(`  結果     : ${result}`);
  console.log(`  警告件数 : ${warningCount}`);
  console.log(`  エラー数 : ${errorCount}`);
  console.log(hr('═', W) + '\n');

  // meta.preflight を更新して保存（status・本文等は変更しない）
  const updatedMeta = {
    ...(draft.meta || {}),
    preflight: { last_checked_at: nowISO(), result, warning_count: warningCount, error_count: errorCount, checks },
  };
  if (!updatedMeta.dry_run) {
    updatedMeta.dry_run = { last_run_at: null, result: null };
  }
  const updated = { ...draft, meta: updatedMeta };
  safeWrite(APPROVED_DIR, `${id}.json`, updated);

  writeLog([
    'PREFLIGHT',
    `id=${id}`,
    `platform=${draft.platform}`,
    draft.content?.scheduled_at ? `scheduled_at=${draft.content.scheduled_at}` : 'scheduled_at=未設定',
    `result=${result}`,
    `warnings=${warningCount}`,
    `errors=${errorCount}`,
  ]);

  if (result === 'BLOCKED') process.exit(2);
}

// ── コマンド: dry-run ─────────────────────────────────────────────

function cmdDryRun(id) {
  const v = validateId(id);
  if (!v.ok) { console.error(`\n[エラー] ${v.reason}\n`); process.exit(1); }

  const filePath   = path.join(APPROVED_DIR, `${id}.json`);
  const fileResult = readDraftFile(filePath);
  if (!fileResult.ok) {
    console.error(`\n[エラー] ${fileResult.reason}（approved/${id}.json）\n`);
    writeLog(['DRY_RUN', `id=${id}`, 'result=DRY_RUN_BLOCKED', 'reason=ファイル読み込み失敗']);
    process.exit(1);
  }

  const draft    = fileResult.data;
  const settings = loadSettings();
  const { checks, errorCount, warningCount, result: preflightResult } = runAllChecks(draft, settings);
  const dryRunResult = preflightResult === 'BLOCKED' ? 'DRY_RUN_BLOCKED' : 'DRY_RUN_SUCCESS';

  const c   = draft.content || {};
  const W   = 64;
  const sns = settings.sns || {};

  console.log('\n' + hr('═', W));
  console.log(`  [DRY-RUN] ${id}`);
  console.log(hr('─', W));

  if (draft.platform === 'youtube') {
    console.log(`  投稿先           : YouTube`);
    console.log(`  動画タイトル     : ${c.title ?? '（未設定）'}`);
    console.log(`  公開予定日時     : ${c.scheduled_at ?? '（未設定）'} JST`);
    console.log(`  動画ファイル     : ${c.video_path ?? '（未設定）'}`);
    console.log(`  サムネイル       : ${c.thumbnail_path ?? '（未設定）'}`);
    console.log(`  タグ             : ${Array.isArray(c.tags) ? `${c.tags.length}件` : '（なし）'}`);
    console.log(`  再生リストID     : ${c.playlist_id ?? '（未設定）'}`);
    console.log(`  カテゴリID       : ${c.category_id ?? '（未設定）'}`);
    console.log(`  デフォルト言語   : ${c.default_language ?? '（未設定）'}`);
    console.log(`  子ども向け       : ${c.made_for_kids === null ? '（未設定）' : c.made_for_kids ? 'はい' : 'いいえ'}`);
    const notifyStr = c.notify_subscribers === null
      ? '（未設定）'
      : c.notify_subscribers
        ? 'する ⚠️  実投稿前に必ず確認してください'
        : 'しない';
    console.log(`  登録者通知       : ${notifyStr}`);
    console.log(`  公開設定         : ${c.privacy_status ?? '（未設定）'} → ${c.publish_mode ?? '（未設定）'}`);
    console.log(hr('─', W));
    console.log('  【将来のAPI変換】');
    console.log('    content.scheduled_at → status.publishAt');
    console.log('    同時に status.privacyStatus = "private" を設定');
    console.log('    第4段階後半: YouTube Data API v3 インストール済みアプリ向け');
    console.log('    OAuth 2.0 認証（方式は実装時点の Google 公式仕様で決定）');
  } else if (draft.platform === 'tiktok') {
    const postModeLabel = c.post_mode === 'direct_post' ? 'DIRECT_POST' : 'MEDIA_UPLOAD';
    console.log(`  投稿先           : TikTok`);
    console.log(`  投稿方式         : ${postModeLabel}`);
    console.log(`  動画ファイル     : ${c.video_path ?? '（未設定）'}`);
    console.log(`  キャプション文字数: ${c.caption ? c.caption.length : 0}文字`);
    if (c.post_mode === 'media_upload') {
      console.log(`  アップロード準備予定 : ${c.scheduled_at ?? '（未設定）'} JST`);
      console.log(`  ※ TikTok 側の公開日時ではなく JARVIS 内のアップロード準備予定です`);
    } else {
      console.log(`  TikTok 公開予定日時 : ${c.scheduled_at ?? '（未設定）'} JST`);
    }
    const privacyDisplay = c.privacy_level
      ? c.privacy_level
      : (c.post_mode === 'media_upload' ? '（TikTok アプリで設定）' : '（未設定）');
    console.log(`  公開範囲         : ${privacyDisplay}`);
    console.log(`  コメント         : ${c.disable_comment == null ? '（未設定）' : c.disable_comment ? '禁止' : '許可'}`);
    console.log(`  デュエット       : ${c.disable_duet   == null ? '（未設定）' : c.disable_duet   ? '禁止' : '許可'}`);
    console.log(`  Stitch           : ${c.disable_stitch == null ? '（未設定）' : c.disable_stitch ? '禁止' : '許可'}`);
    console.log(`  AI生成表示       : ${c.is_aigc == null ? '（未設定）' : c.is_aigc ? 'あり' : 'なし'}`);
    console.log(`  自己宣伝設定     : ${c.brand_organic_toggle == null ? '（未設定）' : c.brand_organic_toggle ? 'あり' : 'なし'}`);
    if (c.post_mode === 'direct_post') {
      console.log(hr('─', W));
      console.log('  ⚠️  DIRECT_POST: アプリ審査・公開権限の確認が完了するまで外部投稿は無効です');
    }
  } else if (draft.platform === 'note') {
    console.log(`  投稿先           : note`);
    console.log(`  記事タイプ       : ${c.article_type ?? '（未設定）'}`);
    console.log(`  本文文字数       : ${c.body ? c.body.length : 0}文字`);
    console.log(`  公開設定         : ${c.visibility ?? '（未設定）'}`);
    if (c.visibility === 'paid') {
      console.log(`  価格             : ${c.price != null ? `${c.price}円` : '（未設定）'}`);
    }
    console.log(`  JARVIS内の予定   : ${c.scheduled_at ?? '（未設定）'} JST`);
    console.log(`  noteへの予約登録 : 未実行（外部API接続なし）`);
    console.log(`  外部投稿機能     : 無効（external_posting_enabled=false）`);
  } else if (draft.platform === 'x') {
    const acct = sns.x?.account ?? '@snflk_official';
    console.log(`  投稿先           : X（${acct}）`);
    console.log(`  公開予定日時     : ${c.scheduled_at ?? '（未設定）'} JST`);
    console.log(`  文字数           : ${c.char_count ?? '不明'}文字${c.char_over ? ' ⚠️ 超過' : ''}`);
    console.log(`  URL              : ${c.url ? '設定あり' : '（なし）'}`);
    console.log(`  ハッシュタグ     : ${Array.isArray(c.hashtags) ? `${c.hashtags.length}件` : '（なし）'}`);
    console.log(`  公開タイミング   : ${draft.meta?.timing ?? c.timing ?? '（不明）'}`);
  } else if (draft.platform === 'instagram') {
    const acct = sns.instagram?.account ?? 'snowflakes_official';
    console.log(`  投稿先           : Instagram（@${acct}）`);
    console.log(`  公開予定日時     : ${c.scheduled_at ?? '（未設定）'} JST`);
    console.log(`  文字数           : ${c.char_count ?? '不明'}文字${c.char_over ? ' ⚠️ 超過' : ''}`);
    console.log(`  素材             : ${Array.isArray(c.media_paths) ? `${c.media_paths.length}件` : '（なし）'}`);
    console.log(`  ハッシュタグ     : ${Array.isArray(c.hashtags) ? `${c.hashtags.length}件` : '（なし）'}`);
    console.log(`  公開タイミング   : ${draft.meta?.timing ?? c.timing ?? '（不明）'}`);
  }

  console.log(hr('─', W));
  console.log(`  事前確認         : ${preflightResult}（警告: ${warningCount}件、エラー: ${errorCount}件）`);
  console.log(`  外部投稿機能     : 無効（dry_run_only=true）`);
  console.log(hr('─', W));
  console.log(`  実行結果: ${dryRunResult}`);

  if (dryRunResult === 'DRY_RUN_BLOCKED') {
    console.log('  ブロック理由:');
    for (const c of checks.filter(c => c.level === 'BLOCK')) {
      console.log(`    ❌ ${c.message}`);
    }
  }

  console.log('  ※ 実際の投稿は行われていません');
  if (draft.platform === 'note') {
    console.log('  ※ note API への接続・記事送信は行われていません');
    console.log('  ※ OAuth 認証情報は未使用です');
  } else if (draft.platform === 'youtube') {
    console.log('  ※ YouTube API 認証情報は未使用です');
    console.log('  ※ 動画・画像のアップロードは行われていません');
  } else if (draft.platform === 'tiktok') {
    console.log('  ※ TikTok API への接続・動画送信は行われていません');
    console.log('  ※ OAuth 認証情報は未使用です');
  }
  console.log(hr('═', W) + '\n');

  // meta.preflight と meta.dry_run を更新（status・本文等は変更しない）
  const updatedMeta = {
    ...(draft.meta || {}),
    preflight: { last_checked_at: nowISO(), result: preflightResult, warning_count: warningCount, error_count: errorCount, checks },
    dry_run:   { last_run_at: nowISO(), result: dryRunResult },
  };
  const updated = { ...draft, meta: updatedMeta };
  safeWrite(APPROVED_DIR, `${id}.json`, updated);

  writeLog([
    'DRY_RUN',
    `id=${id}`,
    `platform=${draft.platform}`,
    c.scheduled_at ? `scheduled_at=${c.scheduled_at}` : 'scheduled_at=未設定',
    `result=${dryRunResult}`,
  ]);

  if (dryRunResult === 'DRY_RUN_BLOCKED') process.exit(2);
}

// ── エントリーポイント ─────────────────────────────────────────────

const args    = process.argv.slice(2);
const command = args[0];
const draftId = args[1];

switch (command) {
  case 'check':   cmdCheck(draftId);   break;
  case 'dry-run': cmdDryRun(draftId);  break;
  default:
    console.error(`\n[エラー] 不明なコマンド: ${command || '（未指定）'}`);
    console.error('使用可能なコマンド: check / dry-run\n');
    process.exit(1);
}
