/**
 * jarvis/sync/catalog_writer.mjs
 * diff 結果を DB へ書き込む（トランザクション付き2パス処理）。
 *
 * applyDiff() は dry-run ではなく実同期専用。
 * dry-run は run_soundrop_catalog_sync.mjs 側で制御する。
 *
 * 処理順序:
 *   Pass 1: リリース更新 / 挿入
 *   Pass 2: トラック更新 / 挿入
 *   Pass 3: リリース-トラック リレーション（全 ID 確定後）
 */

import { toDbStatus } from './catalog_normalizer.mjs';

// ── リリース更新 ──────────────────────────────────────────────────────────────
// 既存レコードの title / status / release_type は変更しない。
// soundrop_* カラムのみ更新する。

function updateRelease(db, dbId, sr) {
  db.prepare(`
    UPDATE sf_releases SET
      soundrop_release_id         = COALESCE(soundrop_release_id, ?),
      soundrop_status             = ?,
      soundrop_artwork_file_id    = COALESCE(?, soundrop_artwork_file_id),
      soundrop_artwork_filename   = COALESCE(?, soundrop_artwork_filename),
      soundrop_label_name         = COALESCE(?, soundrop_label_name),
      soundrop_copyright_p        = COALESCE(?, soundrop_copyright_p),
      soundrop_copyright_c        = COALESCE(?, soundrop_copyright_c),
      soundrop_language_id        = COALESCE(?, soundrop_language_id),
      soundrop_primary_style_id   = COALESCE(?, soundrop_primary_style_id),
      soundrop_secondary_style_id = COALESCE(?, soundrop_secondary_style_id),
      soundrop_sale_start_date    = COALESCE(?, soundrop_sale_start_date),
      soundrop_is_locked          = ?,
      soundrop_is_canceled        = COALESCE(?, soundrop_is_canceled),
      soundrop_is_draft           = COALESCE(?, soundrop_is_draft),
      soundrop_synced_at          = datetime('now')
    WHERE id = ?
  `).run(
    sr.soundrop_release_id ?? null,
    sr.soundrop_status ?? null,
    sr.soundrop_artwork_file_id ?? null,
    sr.soundrop_artwork_filename ?? null,
    sr.soundrop_label_name ?? null,
    sr.soundrop_copyright_p ?? null,
    sr.soundrop_copyright_c ?? null,
    sr.soundrop_language_id ?? null,
    sr.soundrop_primary_style_id ?? null,
    sr.soundrop_secondary_style_id ?? null,
    sr.soundrop_sale_start_date ?? null,
    sr.soundrop_is_locked ?? null,
    sr.soundrop_is_canceled ?? null,
    sr.soundrop_is_draft ?? null,
    dbId,
  );
}

// ── リリース挿入 ──────────────────────────────────────────────────────────────

function insertRelease(db, sr) {
  const releaseKey = `soundrop_${sr.soundrop_release_id}`;
  const dbStatus   = toDbStatus(sr.soundrop_status);

  return db.prepare(`
    INSERT INTO sf_releases (
      release_key, title, release_type, status, release_date, upc_ean,
      soundrop_release_id, soundrop_status,
      soundrop_artwork_file_id, soundrop_artwork_filename,
      soundrop_label_name, soundrop_copyright_p, soundrop_copyright_c,
      soundrop_language_id, soundrop_primary_style_id, soundrop_secondary_style_id,
      soundrop_sale_start_date, soundrop_is_locked, soundrop_is_canceled, soundrop_is_draft,
      soundrop_synced_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now'))
  `).run(
    releaseKey,
    sr.name,
    sr.release_type ?? 'single',
    dbStatus,
    sr.release_date ?? null,
    sr.upc ?? null,
    sr.soundrop_release_id,
    sr.soundrop_status ?? null,
    sr.soundrop_artwork_file_id ?? null,
    sr.soundrop_artwork_filename ?? null,
    sr.soundrop_label_name ?? null,
    sr.soundrop_copyright_p ?? null,
    sr.soundrop_copyright_c ?? null,
    sr.soundrop_language_id ?? null,
    sr.soundrop_primary_style_id ?? null,
    sr.soundrop_secondary_style_id ?? null,
    sr.soundrop_sale_start_date ?? null,
    sr.soundrop_is_locked ?? null,
    sr.soundrop_is_canceled ?? null,
    sr.soundrop_is_draft ?? null,
  );
}

// ── トラック更新 ──────────────────────────────────────────────────────────────
// 既存レコードの title / isrc / status は変更しない。
// soundrop_* カラムのみ更新する。

function updateTrack(db, dbId, st) {
  db.prepare(`
    UPDATE sf_tracks SET
      soundrop_track_id        = COALESCE(soundrop_track_id, ?),
      soundrop_is_locked       = ?,
      soundrop_is_fully_locked = ?,
      soundrop_is_canceled     = ?,
      soundrop_synced_at       = datetime('now')
    WHERE id = ?
  `).run(
    st.soundrop_track_id ?? null,
    st.soundrop_is_locked ?? null,
    st.soundrop_is_fully_locked ?? null,
    st.soundrop_is_canceled ?? null,
    dbId,
  );
}

// ── トラック挿入 ──────────────────────────────────────────────────────────────

function insertTrack(db, st) {
  const trackKey = st.isrc
    ? `isrc_${st.isrc.toLowerCase()}`
    : `soundrop_${st.soundrop_track_id}`;

  return db.prepare(`
    INSERT INTO sf_tracks (
      track_key, title, isrc,
      soundrop_track_id, soundrop_is_locked, soundrop_is_fully_locked, soundrop_is_canceled,
      soundrop_synced_at
    ) VALUES (?,?,?,?,?,?,?,datetime('now'))
  `).run(
    trackKey,
    st.name,
    st.isrc ?? null,
    st.soundrop_track_id,
    st.soundrop_is_locked ?? null,
    st.soundrop_is_fully_locked ?? null,
    st.soundrop_is_canceled ?? null,
  );
}

// ── リレーション処理 ──────────────────────────────────────────────────────────

function upsertReleaseTracks(db, releaseDetails, releaseIdMap, trackIdMap, existingRelTracks) {
  const existingSet = new Set(existingRelTracks.map(rt => `${rt.release_id}:${rt.track_id}`));
  let added = 0;
  let orderUpdated = 0;

  for (const detail of releaseDetails) {
    const dbReleaseId = releaseIdMap.get(detail.soundrop_release_id);
    if (!dbReleaseId) continue;

    for (const t of detail.tracks) {
      const dbTrackId = trackIdMap.get(t.soundrop_track_id);
      if (!dbTrackId) continue;

      const key = `${dbReleaseId}:${dbTrackId}`;

      if (!existingSet.has(key)) {
        db.prepare(`
          INSERT OR IGNORE INTO sf_release_tracks
            (release_id, track_id, track_number, disc_number, soundrop_source_order)
          VALUES (?,?,?,1,?)
        `).run(dbReleaseId, dbTrackId, t.source_order + 1, t.source_order);
        existingSet.add(key);
        added++;
      } else {
        db.prepare(`
          UPDATE sf_release_tracks SET soundrop_source_order = ?
          WHERE release_id = ? AND track_id = ?
            AND (soundrop_source_order IS NULL OR soundrop_source_order != ?)
        `).run(t.source_order, dbReleaseId, dbTrackId, t.source_order);
        orderUpdated++;
      }
    }
  }

  return { added, orderUpdated };
}

// ── メイン: diff 適用 ─────────────────────────────────────────────────────────

/**
 * diff 結果を DB へ適用する（2パス + リレーション処理）。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} diff    - diffReleases / diffTracks / diffReleaseTracks の結果
 * @param {object[]} releaseDetails - normalizeReleaseDetail[] (tracks[] 含む)
 * @param {object[]} existingRelTracks - loadDbReleaseTracks() の結果
 * @returns {{ releasesUpdated, releasesInserted, tracksUpdated, tracksInserted, relationsAdded, relationsOrderUpdated }}
 */
export function applyDiff(db, diff, releaseDetails, existingRelTracks) {
  const releaseIdMap = new Map(); // soundrop_release_id → sf_releases.id
  const trackIdMap   = new Map(); // soundrop_track_id  → sf_tracks.id

  db.exec('BEGIN');
  try {
    // ── Pass 1: リリース ──────────────────────────────────────────────────────
    for (const { db: dbRel, soundrop } of diff.releases.matched) {
      updateRelease(db, dbRel.id, soundrop);
      releaseIdMap.set(soundrop.soundrop_release_id, dbRel.id);
    }

    let releasesInserted = 0;
    for (const sr of diff.releases.new) {
      const result = insertRelease(db, sr);
      const newId  = Number(result.lastInsertRowid);
      releaseIdMap.set(sr.soundrop_release_id, newId);
      releasesInserted++;
    }

    // ── Pass 2: トラック ──────────────────────────────────────────────────────
    for (const { db: dbTrack, soundrop } of diff.tracks.matched) {
      updateTrack(db, dbTrack.id, soundrop);
      trackIdMap.set(soundrop.soundrop_track_id, dbTrack.id);
    }

    let tracksInserted = 0;
    for (const st of diff.tracks.new) {
      const result = insertTrack(db, st);
      const newId  = Number(result.lastInsertRowid);
      trackIdMap.set(st.soundrop_track_id, newId);
      tracksInserted++;
    }

    // ── Pass 3: リレーション ──────────────────────────────────────────────────
    const { added: relationsAdded, orderUpdated: relationsOrderUpdated } =
      upsertReleaseTracks(db, releaseDetails, releaseIdMap, trackIdMap, existingRelTracks);

    db.exec('COMMIT');

    return {
      releasesUpdated:       diff.releases.matched.length,
      releasesInserted,
      tracksUpdated:         diff.tracks.matched.length,
      tracksInserted,
      relationsAdded,
      relationsOrderUpdated,
    };
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
