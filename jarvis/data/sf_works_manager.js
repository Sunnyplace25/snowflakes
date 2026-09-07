/**
 * jarvis/data/sf_works_manager.js
 * Phase 28: 作品公開URL・原稿アーカイブ管理
 *
 * - 原稿ファイル本体は DB に保存しない（MANUSCRIPT_ARCHIVE_DIR に書き込む）
 * - sha256 重複チェック: UNIQUE(work_id, sha256, archive_type)
 * - ダウンロード時はパストラバーサル検証を行う
 */

import { createHash }                               from 'node:crypto';
import { writeFileSync, mkdirSync, createReadStream,
         readFileSync, statSync }                   from 'node:fs';
import { resolve as pathResolve, relative as pathRelative,
         dirname, extname, basename }               from 'node:path';

// ── 許可拡張子 ─────────────────────────────────────────────────────────────────
const ALLOWED_EXTS = new Set(['.docx', '.md', '.txt', '.pdf']);

// ── 最大ファイルサイズ（50 MB） ────────────────────────────────────────────────
const MAX_BYTES = 52_428_800;

// ─── ユーティリティ ────────────────────────────────────────────────────────────

/** Buffer の SHA-256 hex を返す */
export function computeSha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/**
 * public_url の簡易検証。null/空文字は許可。http/https のみ。
 * @param {string|null} url
 * @returns {boolean}
 */
export function isValidPublicUrl(url) {
  if (!url) return true;
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * アーカイブレコードの絶対ファイルパスを返す（パストラバーサル検証付き）。
 * @param {{ file_path: string }} record
 * @param {string} archiveDir
 * @returns {string} 絶対パス
 * @throws {Error} パストラバーサル検出時
 */
export function getArchivePath(record, archiveDir) {
  const abs = pathResolve(archiveDir, record.file_path);
  const rel = pathRelative(archiveDir, abs);
  if (rel.startsWith('..') || pathResolve(abs) !== abs) {
    throw new Error('Invalid file path');
  }
  return abs;
}

// ─── 作品一覧 ─────────────────────────────────────────────────────────────────

/**
 * 全作品を取得する（なろう掲載URLの有無 + アーカイブ件数を付与）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {object[]}
 */
export function getWorks(db) {
  return db.prepare(`
    SELECT
      w.id, w.work_key, w.title, w.work_type, w.status, w.published_at, w.created_at,
      p_narou.public_url          AS narou_url,
      p_narou.publication_status  AS narou_pub_status,
      COUNT(DISTINCT a.id)        AS archive_count,
      MAX(a.archived_at)          AS last_archived_at
    FROM sf_works w
    LEFT JOIN sf_work_publications p_narou
           ON p_narou.work_id = w.id AND p_narou.platform = 'narou'
    LEFT JOIN sf_work_archives a ON a.work_id = w.id
    GROUP BY w.id
    ORDER BY w.published_at DESC NULLS LAST, w.id DESC
  `).all();
}

/**
 * 単一作品を取得する。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} workId
 * @returns {object|undefined}
 */
export function getWork(db, workId) {
  return db.prepare('SELECT * FROM sf_works WHERE id = ?').get(workId);
}

// ─── 公開URL管理 ──────────────────────────────────────────────────────────────

/**
 * 作品に紐づく全プラットフォームの公開URL一覧を返す。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} workId
 * @returns {object[]}
 */
export function getWorkPublications(db, workId) {
  return db.prepare(`
    SELECT * FROM sf_work_publications
    WHERE work_id = ?
    ORDER BY platform
  `).all(workId);
}

/**
 * 公開URL情報を登録・更新する（ON CONFLICT DO UPDATE）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ work_id, platform, platform_work_id?, public_url?, publication_status?, published_at?, memo? }} data
 * @returns {{ id: number }}
 */
export function upsertWorkPublication(db, data) {
  const {
    work_id, platform,
    platform_work_id = null,
    public_url       = null,
    publication_status = 'published',
    published_at     = null,
    memo             = null,
  } = data;

  if (!isValidPublicUrl(public_url)) {
    throw new Error('public_url は http:// または https:// で始まるURLを入力してください');
  }

  const result = db.prepare(`
    INSERT INTO sf_work_publications
      (work_id, platform, platform_work_id, public_url, publication_status, published_at, memo)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(work_id, platform) DO UPDATE SET
      platform_work_id   = excluded.platform_work_id,
      public_url         = excluded.public_url,
      publication_status = excluded.publication_status,
      published_at       = excluded.published_at,
      memo               = excluded.memo,
      last_checked_at    = datetime('now','localtime')
  `).run(work_id, platform, platform_work_id, public_url, publication_status, published_at, memo);

  // 挿入/更新された行の id を返す
  const row = db.prepare(
    'SELECT id FROM sf_work_publications WHERE work_id = ? AND platform = ?'
  ).get(work_id, platform);
  return { id: row.id };
}

/**
 * 既存の公開URL行を更新する（work_id 所属確認付き）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} workId
 * @param {number} pubId
 * @param {object} data
 */
export function updateWorkPublication(db, workId, pubId, data) {
  const existing = db.prepare(
    'SELECT * FROM sf_work_publications WHERE id = ? AND work_id = ?'
  ).get(pubId, workId);
  if (!existing) throw new Error('公開URL行が見つかりません（work_id 不一致または存在しない）');

  const {
    platform_work_id = existing.platform_work_id,
    public_url       = existing.public_url,
    publication_status = existing.publication_status,
    published_at     = existing.published_at,
    memo             = existing.memo,
  } = data;

  if (!isValidPublicUrl(public_url)) {
    throw new Error('public_url は http:// または https:// で始まるURLを入力してください');
  }

  db.prepare(`
    UPDATE sf_work_publications SET
      platform_work_id   = ?,
      public_url         = ?,
      publication_status = ?,
      published_at       = ?,
      last_checked_at    = datetime('now','localtime'),
      memo               = ?
    WHERE id = ? AND work_id = ?
  `).run(platform_work_id, public_url, publication_status, published_at, memo, pubId, workId);
}

// ─── 原稿アーカイブ管理 ────────────────────────────────────────────────────────

/**
 * 作品に紐づく全アーカイブを取得する（新しい順）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} workId
 * @returns {object[]}
 */
export function getWorkArchives(db, workId) {
  return db.prepare(`
    SELECT * FROM sf_work_archives
    WHERE work_id = ?
    ORDER BY archived_at DESC
  `).all(workId);
}

/**
 * 単一アーカイブを取得する（work_id 所属確認付き）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} workId
 * @param {number} archiveId
 * @returns {object|undefined}
 */
export function getWorkArchive(db, workId, archiveId) {
  return db.prepare(`
    SELECT * FROM sf_work_archives WHERE id = ? AND work_id = ?
  `).get(archiveId, workId);
}

/**
 * 原稿ファイルをアーカイブする。
 * 1. sha256 計算 → 重複チェック
 * 2. ファイル書き込み（flag:'wx' で上書き防止）
 * 3. 書き込み後 sha256 検証
 * 4. DB INSERT
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{
 *   work_id: number,
 *   archive_type: string,
 *   version_label?: string,
 *   original_filename: string,
 *   memo?: string,
 *   buffer: Buffer,
 * }} data
 * @param {string} archiveDir  MANUSCRIPT_ARCHIVE_DIR の絶対パス
 * @returns {{ id: number, archived_filename: string, sha256: string }}
 */
export function archiveManuscript(db, data, archiveDir) {
  const {
    work_id, archive_type,
    version_label    = null,
    original_filename,
    memo             = null,
    buffer,
  } = data;

  // ── 拡張子チェック ──────────────────────────────────────────────────────────
  const ext = extname(original_filename).toLowerCase();
  if (!ALLOWED_EXTS.has(ext)) {
    throw new Error(`許可されていないファイル形式です（${ext}）。.docx .md .txt .pdf のみ対応しています`);
  }

  // ── サイズチェック ──────────────────────────────────────────────────────────
  if (buffer.length > MAX_BYTES) {
    throw new Error(`ファイルサイズが上限（50MB）を超えています（${buffer.length} bytes）`);
  }

  // ── sha256 計算 ─────────────────────────────────────────────────────────────
  const sha256 = computeSha256(buffer);

  // ── 重複チェック ────────────────────────────────────────────────────────────
  const dup = db.prepare(`
    SELECT id FROM sf_work_archives
    WHERE work_id = ? AND sha256 = ? AND archive_type = ?
  `).get(work_id, sha256, archive_type);
  if (dup) {
    throw new Error(`同一内容のファイルがすでに登録されています（id=${dup.id}）`);
  }

  // ── ファイル名生成 ──────────────────────────────────────────────────────────
  const dateStr        = new Date().toISOString().slice(0, 10);
  const archived_filename = `${dateStr}_${archive_type}_${sha256.slice(0, 8)}${ext}`;
  const subDir         = `work_${work_id}`;
  const relPath        = `${subDir}/${archived_filename}`;
  const destDir        = pathResolve(archiveDir, subDir);
  const destPath       = pathResolve(destDir, archived_filename);

  // パストラバーサル検証
  const relCheck = pathRelative(archiveDir, destPath);
  if (relCheck.startsWith('..')) {
    throw new Error('Invalid archive path');
  }

  // ── ディレクトリ作成 ─────────────────────────────────────────────────────────
  mkdirSync(destDir, { recursive: true });

  // ── ファイル書き込み（上書き禁止） ──────────────────────────────────────────
  writeFileSync(destPath, buffer, { flag: 'wx' });

  // ── 書き込み後 sha256 検証 ────────────────────────────────────────────────
  const writtenBuf    = readFileSync(destPath);
  const writtenSha256 = computeSha256(writtenBuf);
  if (writtenSha256 !== sha256) {
    throw new Error('ファイルの書き込み検証に失敗しました（sha256 不一致）');
  }

  // ── DB INSERT ─────────────────────────────────────────────────────────────
  const result = db.prepare(`
    INSERT INTO sf_work_archives
      (work_id, archive_type, version_label, original_filename,
       archived_filename, file_path, sha256, file_size_bytes, memo)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    work_id, archive_type, version_label, original_filename,
    archived_filename, relPath, sha256, buffer.length, memo,
  );

  return {
    id:                Number(result.lastInsertRowid),
    archived_filename,
    sha256,
    file_path:         relPath,
  };
}
