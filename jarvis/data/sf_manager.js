/**
 * jarvis/data/sf_manager.js
 * Snow flakes 楽曲・リリース管理 データマネージャー
 *
 * Phase 1.5: 楽曲・リリース・アーティストプロフィール・プレビュー・配信インポート
 *
 * 制約：
 * - ファイル（.mp3/.wav）・画像は参照のみ。移動・削除・リネーム・上書き禁止。
 * - テストは :memory: DBのみ使用すること。
 */

// ═══════════════════════════════════════════════════════════════════════════════
// 楽曲 (sf_tracks)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 全楽曲一覧を返す。プレビュー状態を LEFT JOIN で付加。
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {object[]}
 */
export function getTracks(db) {
  return db.prepare(`
    SELECT
      t.id, t.track_key, t.title, t.status, t.release_date, t.created_date,
      t.isrc, t.duration_sec, t.source_service, t.memo,
      t.created_at,
      (SELECT p.status FROM sf_track_previews p
       WHERE p.track_id = t.id AND p.status = 'published'
       LIMIT 1) AS preview_status,
      (SELECT COUNT(*) FROM sf_track_files f
       WHERE f.track_id = t.id AND f.file_type = 'master_wav') AS has_wav,
      (SELECT COUNT(*) FROM sf_track_files f
       WHERE f.track_id = t.id AND f.file_type = 'streaming_mp3') AS has_mp3
    FROM sf_tracks t
    ORDER BY t.created_at DESC
  `).all();
}

/**
 * 単一楽曲の詳細を返す（ファイル・歌詞・リリース・プレビュー・ストア情報含む）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} id
 * @returns {object|null}
 */
export function getTrack(db, id) {
  const track = db.prepare(`
    SELECT * FROM sf_tracks WHERE id = ?
  `).get(id);
  if (!track) return null;

  track.files    = db.prepare('SELECT * FROM sf_track_files WHERE track_id = ? ORDER BY is_master DESC, file_type').all(id);
  track.lyrics   = db.prepare('SELECT * FROM sf_track_lyrics WHERE track_id = ? ORDER BY language, version').all(id);
  track.previews = db.prepare('SELECT * FROM sf_track_previews WHERE track_id = ? ORDER BY status').all(id);
  track.stores   = db.prepare('SELECT * FROM sf_track_releases WHERE track_id = ? ORDER BY platform').all(id);
  track.releases = db.prepare(`
    SELECT r.id, r.release_key, r.title, r.release_type, r.status, r.release_date,
           rt.track_number, rt.disc_number
    FROM sf_releases r
    JOIN sf_release_tracks rt ON rt.release_id = r.id
    WHERE rt.track_id = ?
    ORDER BY r.release_date DESC
  `).all(id);

  return track;
}

/**
 * 楽曲を挿入または更新する。
 * data.id が存在する場合は UPDATE、なければ INSERT。
 * 不明な楽曲は status='unknown' のまま。タイトルや登録詳細は推測しない。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} data
 * @returns {{ id: number }}
 */
export function upsertTrack(db, data) {
  if (data.id) {
    // UPDATE
    db.prepare(`
      UPDATE sf_tracks SET
        title        = COALESCE(?, title),
        status       = COALESCE(?, status),
        release_date = ?,
        created_date = ?,
        duration_sec = ?,
        isrc         = ?,
        source_service = ?,
        source_id    = ?,
        source_url   = ?,
        memo         = ?
      WHERE id = ?
    `).run(
      data.title        ?? null,
      data.status       ?? null,
      data.release_date ?? null,
      data.created_date ?? null,
      data.duration_sec ?? null,
      data.isrc         ?? null,
      data.source_service ?? null,
      data.source_id    ?? null,
      data.source_url   ?? null,
      data.memo         ?? null,
      data.id,
    );
    return { id: data.id };
  }

  // INSERT
  if (!data.track_key) throw new Error('track_key は必須です');
  if (!data.title)     throw new Error('title は必須です');

  const result = db.prepare(`
    INSERT INTO sf_tracks
      (track_key, title, status, release_date, created_date, duration_sec,
       isrc, source_service, source_id, source_url, memo)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.track_key,
    data.title,
    data.status       ?? 'unknown',
    data.release_date ?? null,
    data.created_date ?? null,
    data.duration_sec ?? null,
    data.isrc         ?? null,
    data.source_service ?? null,
    data.source_id    ?? null,
    data.source_url   ?? null,
    data.memo         ?? null,
  );
  return { id: Number(result.lastInsertRowid) };
}

// ═══════════════════════════════════════════════════════════════════════════════
// リリース (sf_releases)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 全リリース一覧（楽曲数・ジャケット状態・配信状態付き）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {object[]}
 */
export function getReleases(db) {
  return db.prepare(`
    SELECT
      r.id, r.release_key, r.title, r.release_type, r.status,
      r.release_date, r.upc_ean, r.memo, r.created_at,
      (SELECT COUNT(*) FROM sf_release_tracks rt WHERE rt.release_id = r.id) AS track_count,
      (SELECT a.status FROM sf_release_artworks a
       WHERE a.release_id = r.id ORDER BY a.created_at DESC LIMIT 1) AS artwork_status,
      (SELECT d.distribution_status FROM sf_distributions d
       WHERE d.release_id = r.id AND d.distributor = 'soundrop' LIMIT 1) AS soundrop_status
    FROM sf_releases r
    ORDER BY r.release_date DESC, r.created_at DESC
  `).all();
}

/**
 * 単一リリースの詳細（楽曲・ジャケット・プラットフォーム・配信情報含む）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} id
 * @returns {object|null}
 */
export function getRelease(db, id) {
  const release = db.prepare('SELECT * FROM sf_releases WHERE id = ?').get(id);
  if (!release) return null;

  release.tracks = db.prepare(`
    SELECT t.id, t.track_key, t.title, t.status, t.isrc,
           rt.track_number, rt.disc_number
    FROM sf_tracks t
    JOIN sf_release_tracks rt ON rt.track_id = t.id
    WHERE rt.release_id = ?
    ORDER BY rt.disc_number, rt.track_number
  `).all(id);

  release.artworks      = db.prepare('SELECT * FROM sf_release_artworks WHERE release_id = ? ORDER BY created_at DESC').all(id);
  release.platforms     = db.prepare('SELECT * FROM sf_release_platforms WHERE release_id = ? ORDER BY platform').all(id);
  release.distributions = db.prepare('SELECT * FROM sf_distributions WHERE release_id = ? ORDER BY distributor').all(id);
  release.credits       = db.prepare('SELECT * FROM sf_credits WHERE release_id = ? ORDER BY role, name').all(id);

  return release;
}

/**
 * リリースを挿入または更新する。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} data
 * @returns {{ id: number }}
 */
export function upsertRelease(db, data) {
  if (data.id) {
    db.prepare(`
      UPDATE sf_releases SET
        title        = COALESCE(?, title),
        release_type = COALESCE(?, release_type),
        status       = COALESCE(?, status),
        created_date = ?,
        release_date = ?,
        upc_ean      = ?,
        memo         = ?
      WHERE id = ?
    `).run(
      data.title        ?? null,
      data.release_type ?? null,
      data.status       ?? null,
      data.created_date ?? null,
      data.release_date ?? null,
      data.upc_ean      ?? null,
      data.memo         ?? null,
      data.id,
    );
    return { id: data.id };
  }

  if (!data.release_key)  throw new Error('release_key は必須です');
  if (!data.title)        throw new Error('title は必須です');
  if (!data.release_type) throw new Error('release_type は必須です');

  const result = db.prepare(`
    INSERT INTO sf_releases
      (release_key, title, release_type, status, created_date, release_date, upc_ean, memo)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.release_key,
    data.title,
    data.release_type,
    data.status       ?? 'draft',
    data.created_date ?? null,
    data.release_date ?? null,
    data.upc_ean      ?? null,
    data.memo         ?? null,
  );
  return { id: Number(result.lastInsertRowid) };
}

// ═══════════════════════════════════════════════════════════════════════════════
// アーティストプロフィール (sf_artist_profiles)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 全アーティストプロフィールを返す。
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {object[]}
 */
export function getArtistProfiles(db) {
  return db.prepare(`
    SELECT * FROM sf_artist_profiles ORDER BY artist_key, platform
  `).all();
}

/**
 * アーティストプロフィールを挿入または更新する。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} data
 * @returns {{ id: number }}
 */
export function upsertArtistProfile(db, data) {
  if (data.id) {
    db.prepare(`
      UPDATE sf_artist_profiles SET
        artist_name        = COALESCE(?, artist_name),
        platform_artist_id = ?,
        artist_page_url    = ?,
        profile_status     = COALESCE(?, profile_status),
        claimed            = COALESCE(?, claimed),
        last_checked_at    = ?,
        memo               = ?,
        updated_at         = datetime('now','localtime')
      WHERE id = ?
    `).run(
      data.artist_name        ?? null,
      data.platform_artist_id ?? null,
      data.artist_page_url    ?? null,
      data.profile_status     ?? null,
      data.claimed            ?? null,
      data.last_checked_at    ?? null,
      data.memo               ?? null,
      data.id,
    );
    return { id: data.id };
  }

  if (!data.artist_key)  throw new Error('artist_key は必須です');
  if (!data.artist_name) throw new Error('artist_name は必須です');
  if (!data.platform)    throw new Error('platform は必須です');

  const result = db.prepare(`
    INSERT INTO sf_artist_profiles
      (artist_key, artist_name, platform, platform_artist_id, artist_page_url,
       profile_status, claimed, last_checked_at, memo)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.artist_key,
    data.artist_name,
    data.platform,
    data.platform_artist_id ?? null,
    data.artist_page_url    ?? null,
    data.profile_status     ?? 'unknown',
    data.claimed            ?? 0,
    data.last_checked_at    ?? null,
    data.memo               ?? null,
  );
  return { id: Number(result.lastInsertRowid) };
}

// ═══════════════════════════════════════════════════════════════════════════════
// プレビュー (sf_track_previews)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 全プレビューを楽曲情報付きで返す。
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {object[]}
 */
export function getPreviews(db) {
  return db.prepare(`
    SELECT
      p.*,
      t.track_key, t.title AS track_title, t.status AS track_status
    FROM sf_track_previews p
    JOIN sf_tracks t ON t.id = p.track_id
    ORDER BY p.status, p.created_at DESC
  `).all();
}

/**
 * プレビューを挿入または更新する。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} data
 * @returns {{ id: number }}
 */
export function upsertPreview(db, data) {
  if (data.id) {
    db.prepare(`
      UPDATE sf_track_previews SET
        file_id       = ?,
        preview_type  = COALESCE(?, preview_type),
        page_path     = ?,
        page_url      = ?,
        status        = COALESCE(?, status),
        published_at  = ?,
        ended_at      = ?,
        start_sec     = ?,
        end_sec       = ?,
        analytics_key = ?,
        label         = ?,
        memo          = ?,
        updated_at    = datetime('now','localtime')
      WHERE id = ?
    `).run(
      data.file_id       ?? null,
      data.preview_type  ?? null,
      data.page_path     ?? null,
      data.page_url      ?? null,
      data.status        ?? null,
      data.published_at  ?? null,
      data.ended_at      ?? null,
      data.start_sec     ?? null,
      data.end_sec       ?? null,
      data.analytics_key ?? null,
      data.label         ?? null,
      data.memo          ?? null,
      data.id,
    );
    return { id: data.id };
  }

  if (!data.track_id)    throw new Error('track_id は必須です');
  if (!data.preview_type) throw new Error('preview_type は必須です');

  const result = db.prepare(`
    INSERT INTO sf_track_previews
      (track_id, file_id, preview_type, platform, page_path, page_url,
       status, published_at, ended_at, start_sec, end_sec, analytics_key, label, memo)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.track_id,
    data.file_id       ?? null,
    data.preview_type,
    data.platform      ?? 'official_site',
    data.page_path     ?? null,
    data.page_url      ?? null,
    data.status        ?? 'draft',
    data.published_at  ?? null,
    data.ended_at      ?? null,
    data.start_sec     ?? null,
    data.end_sec       ?? null,
    data.analytics_key ?? null,
    data.label         ?? null,
    data.memo          ?? null,
  );
  return { id: Number(result.lastInsertRowid) };
}

// ═══════════════════════════════════════════════════════════════════════════════
// インポート履歴 (sf_distribution_imports)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * 直近のインポートログを返す（最大100件）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {object[]}
 */
export function getImportHistory(db) {
  return db.prepare(`
    SELECT * FROM sf_distribution_imports
    ORDER BY imported_at DESC
    LIMIT 100
  `).all();
}

/**
 * レビューが必要なインポート行を返す。
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {object[]}
 */
export function getUnreviewedImportRows(db) {
  return db.prepare(`
    SELECT r.*, i.file_name, i.report_period, i.distributor
    FROM sf_distribution_import_rows r
    JOIN sf_distribution_imports i ON i.id = r.import_id
    WHERE r.needs_review = 1
    ORDER BY r.created_at DESC
  `).all();
}
