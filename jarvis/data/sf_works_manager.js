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
         dirname, extname, basename, sep as pathSep } from 'node:path';

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
      -- 全プラットフォームの公開中プラットフォーム名（カンマ区切り、NULLなら未公開）
      (SELECT GROUP_CONCAT(platform, ',')
       FROM (SELECT platform FROM sf_work_publications
             WHERE work_id = w.id AND publication_status = 'published'
             ORDER BY platform)) AS published_platforms,
      -- publication行の総件数（0なら公開先未登録）
      (SELECT COUNT(*) FROM sf_work_publications WHERE work_id = w.id) AS pub_count,
      -- published状態かつ日付ありの最古公開日（fallback: sf_works.published_at）
      COALESCE(
        (SELECT MIN(published_at)
         FROM sf_work_publications
         WHERE work_id = w.id
           AND publication_status = 'published'
           AND published_at IS NOT NULL),
        w.published_at
      ) AS earliest_pub_date,
      COUNT(DISTINCT a.id)   AS archive_count,
      MAX(a.archived_at)     AS last_archived_at
    FROM sf_works w
    LEFT JOIN sf_work_archives a ON a.work_id = w.id
    GROUP BY w.id
    ORDER BY w.display_order ASC NULLS LAST, earliest_pub_date DESC NULLS LAST, w.id DESC
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

/**
 * 作品の表示順を更新する。
 *
 * 検証:
 *   - work_ids に重複がないこと
 *   - work_ids のすべてが sf_works に実在すること
 *   - 不正な ID（非整数・存在しない）が混ざっていないこと
 *
 * 更新はトランザクション内で行い、一部だけ更新される状態を防ぐ。
 * display_order は (index + 1) * 10 で 10刻みに割り当てる。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number[]} workIds - 新しい順序の作品 ID 配列
 * @throws {Error} 検証失敗またはDB更新失敗時
 */
export function reorderWorks(db, workIds) {
  // ── 検証 ───────────────────────────────────────────────────────────────────
  if (!Array.isArray(workIds) || workIds.length === 0) {
    throw new Error('work_ids が空です');
  }

  // 全要素が整数であること
  if (!workIds.every(id => Number.isInteger(id) && id > 0)) {
    throw new Error('work_ids に不正な値が含まれています');
  }

  // 重複なし
  if (new Set(workIds).size !== workIds.length) {
    throw new Error('work_ids に重複 ID が含まれています');
  }

  // DB上の全件数と一致すること（一部IDのみ受け付けない）
  const total = Number(db.prepare('SELECT COUNT(*) AS cnt FROM sf_works').get().cnt);
  if (workIds.length !== total) {
    throw new Error(
      `全${total}件の作品IDを指定してください（受信: ${workIds.length}件）`
    );
  }

  // 全 ID が実在すること（＝送られてきたIDが全てDBに存在する）
  const placeholders = workIds.map(() => '?').join(',');
  const existing = db.prepare(
    `SELECT id FROM sf_works WHERE id IN (${placeholders})`
  ).all(...workIds);

  if (existing.length !== workIds.length) {
    throw new Error('work_ids に存在しない ID が含まれています');
  }

  // ── トランザクション内で display_order 更新 ────────────────────────────────
  const stmt = db.prepare('UPDATE sf_works SET display_order = ? WHERE id = ?');
  db.exec('BEGIN TRANSACTION');
  try {
    workIds.forEach((id, i) => {
      stmt.run((i + 1) * 10, id);
    });
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw err;
  }
}

// ─── 作品削除 ─────────────────────────────────────────────────────────────────

/**
 * 作品を安全に削除する。
 *
 * 削除前チェック（以下が1件でもあれば 409 エラー）:
 *   sf_work_archives  — 原稿アーカイブ（ファイル本体は絶対に削除しない）
 *   sf_track_work_links — 楽曲との紐付け
 *   sf_revenue          — 売上データ
 *   sf_narou_snapshot   — なろうスナップショット
 *   sf_content_registry — コンテンツレジストリ
 *   sf_funnel_event     — ファネルデータ
 *   sf_kdp_book_map     — KDP紐付け
 *   sf_note_article     — note記事（related_work_id）
 *
 * 削除可能な場合: sf_work_publications → sf_works をトランザクション内で削除。
 * 外部サイト（なろう・HP等）には一切触れない。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} workId
 * @returns {{ deleted: true, pub_count: number }}
 * @throws {Error} 作品未存在(status=404) / 関連データあり(status=409) / DB エラー
 */
export function deleteWork(db, workId) {
  // 1. 作品存在確認
  const work = db.prepare('SELECT id FROM sf_works WHERE id = ?').get(workId);
  if (!work) {
    const err = new Error('作品が見つかりません');
    err.status = 404;
    throw err;
  }

  // 2. 削除不可テーブルの件数確認
  const BLOCK_CHECKS = [
    { table: 'sf_work_archives',    col: 'work_id',         label: '原稿アーカイブ' },
    { table: 'sf_track_work_links', col: 'work_id',         label: '楽曲との紐付け' },
    { table: 'sf_revenue',          col: 'work_id',         label: '売上データ' },
    { table: 'sf_narou_snapshot',   col: 'work_id',         label: 'なろうスナップショット' },
    { table: 'sf_content_registry', col: 'work_id',         label: 'コンテンツレジストリ' },
    { table: 'sf_funnel_event',     col: 'work_id',         label: 'ファネルデータ' },
    { table: 'sf_kdp_book_map',     col: 'work_id',         label: 'KDP紐付け' },
    { table: 'sf_note_article',     col: 'related_work_id', label: 'note記事' },
  ];

  const blockers = [];
  for (const { table, col, label } of BLOCK_CHECKS) {
    try {
      const row = db.prepare(`SELECT COUNT(*) AS cnt FROM ${table} WHERE ${col} = ?`).get(workId);
      const cnt = Number(row?.cnt ?? 0);
      if (cnt > 0) blockers.push({ label, count: cnt });
    } catch (_) { /* テーブルが存在しない場合はスキップ */ }
  }

  if (blockers.length > 0) {
    const detail = blockers.map(b => `${b.label}: ${b.count}件`).join(' / ');
    const err = new Error(`この作品には関連データがあるため削除できません（${detail}）`);
    err.status   = 409;
    err.blockers = blockers;
    throw err;
  }

  // 3. publication 件数を記録してから削除
  const pubCount = Number(
    db.prepare('SELECT COUNT(*) AS cnt FROM sf_work_publications WHERE work_id = ?').get(workId).cnt
  );

  // 4. トランザクション内で削除（publication → works の順）
  db.exec('BEGIN TRANSACTION');
  try {
    db.prepare('DELETE FROM sf_work_publications WHERE work_id = ?').run(workId);
    db.prepare('DELETE FROM sf_works WHERE id = ?').run(workId);
    db.exec('COMMIT');
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch (_) {}
    throw err;
  }

  return { deleted: true, pub_count: pubCount };
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
 * アーカイブ登録をDBから削除する。
 * ★ 実ファイル（file_path 先）は絶対に削除しない。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} workId
 * @param {number} archiveId
 * @returns {{ deleted: true, archived_filename: string }}
 * @throws {Error} work 不在・archive 不在・work_id 不一致 → err.status = 404
 */
export function deleteWorkArchive(db, workId, archiveId) {
  if (!db.prepare('SELECT id FROM sf_works WHERE id = ?').get(workId)) {
    const e = new Error('作品が見つかりません'); e.status = 404; throw e;
  }
  const record = db.prepare(
    'SELECT id, work_id, archived_filename FROM sf_work_archives WHERE id = ?'
  ).get(archiveId);
  if (!record) {
    const e = new Error('アーカイブが見つかりません'); e.status = 404; throw e;
  }
  if (Number(record.work_id) !== workId) {
    const e = new Error('アーカイブが見つかりません'); e.status = 404; throw e;
  }
  db.prepare('DELETE FROM sf_work_archives WHERE id = ?').run(archiveId);
  return { deleted: true, archived_filename: record.archived_filename };
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
    version_date     = null,
    original_filename,
    memo             = null,
    buffer,
  } = data;

  // ── version_date バリデーション ────────────────────────────────────────────
  if (version_date && !/^\d{4}-\d{2}-\d{2}$/.test(version_date)) {
    const err = new Error('version_date は YYYY-MM-DD 形式で指定してください');
    err.status = 400;
    throw err;
  }

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
      (work_id, archive_type, version_label, version_date, original_filename,
       archived_filename, file_path, sha256, file_size_bytes, memo)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    work_id, archive_type, version_label, version_date, original_filename,
    archived_filename, relPath, sha256, buffer.length, memo,
  );

  return {
    id:                Number(result.lastInsertRowid),
    archived_filename,
    sha256,
    file_path:         relPath,
  };
}

/**
 * 直接入力テキストを .md ファイルとして保存し、sf_work_archives に登録する。
 * 本文 (content) は SQLite には保存しない。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} workId
 * @param {string} content - UTF-8 本文（空は不可）
 * @param {{ version_label?: string, version_date?: string, memo?: string, archiveDir: string }} opts
 */
export function archiveTextContent(db, workId, content, {
  version_label = null,
  version_date  = null,
  memo          = null,
  archiveDir,
} = {}) {
  if (!content?.trim()) {
    const err = new Error('本文が空です');
    err.status = 400;
    throw err;
  }

  if (version_date && !/^\d{4}-\d{2}-\d{2}$/.test(version_date)) {
    const err = new Error('version_date は YYYY-MM-DD 形式で指定してください');
    err.status = 400;
    throw err;
  }

  const buf = Buffer.from(content, 'utf-8');

  if (buf.length > MAX_BYTES) {
    const err = new Error(`ファイルサイズが上限（50MB）を超えています（${buf.length} bytes）`);
    err.status = 400;
    throw err;
  }

  const sha256 = computeSha256(buf);

  // 重複チェック
  const dup = db.prepare(
    "SELECT id FROM sf_work_archives WHERE work_id=? AND sha256=? AND archive_type='direct_input'"
  ).get(workId, sha256);
  if (dup) {
    const err = new Error('同一内容のアーカイブが既に存在します');
    err.status = 409;
    throw err;
  }

  const today           = new Date().toISOString().slice(0, 10);
  const prefix          = sha256.slice(0, 8);
  const archived_filename = `${today}_direct_input_${prefix}.md`;
  const workDir         = `work_${workId}`;
  const relativePath    = `${workDir}/${archived_filename}`;
  const absBase         = pathResolve(archiveDir);
  const absDir          = pathResolve(absBase, workDir);
  const absFile         = pathResolve(absDir, archived_filename);

  // パストラバーサル検証
  if (!absFile.startsWith(absBase + pathSep) && absFile !== absBase) {
    const err = new Error('Invalid archive path');
    err.status = 400;
    throw err;
  }

  mkdirSync(absDir, { recursive: true });
  writeFileSync(absFile, buf, { flag: 'wx' });

  // 書き込み後 sha256 検証
  const written = readFileSync(absFile);
  if (computeSha256(written) !== sha256) {
    const err = new Error('ファイルの書き込み検証に失敗しました（sha256 不一致）');
    err.status = 500;
    throw err;
  }

  // DB INSERT
  const result = db.prepare(`
    INSERT INTO sf_work_archives
      (work_id, archive_type, version_label, version_date, original_filename,
       archived_filename, file_path, sha256, file_size_bytes, memo)
    VALUES (?, 'direct_input', ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    workId, version_label, version_date, 'direct_input.md',
    archived_filename, relativePath, sha256, buf.length, memo,
  );

  return {
    id:             Number(result.lastInsertRowid),
    archived_filename,
    sha256,
    file_size_bytes: buf.length,
    char_count:     [...content].length,
  };
}
