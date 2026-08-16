/**
 * jarvis/sync/catalog_diff.mjs
 * DB の現状と Soundrop カタログを比較し差分を算出する（純粋関数群）。
 *
 * マッチ方式:
 *   Release: soundrop_release_id → UPC
 *   Track  : soundrop_track_id  → ISRC
 *   どちらもない場合は自動マッチしない（skipped）。
 */

// ── DB ロード ─────────────────────────────────────────────────────────────────

export function loadDbReleases(db) {
  return db.prepare(`
    SELECT id, release_key, title, upc_ean,
           release_type, status, soundrop_release_id, soundrop_status,
           soundrop_artwork_file_id, soundrop_synced_at
    FROM sf_releases
  `).all();
}

export function loadDbTracks(db) {
  return db.prepare(`
    SELECT id, track_key, title, isrc, soundrop_track_id,
           soundrop_is_locked, soundrop_synced_at
    FROM sf_tracks
  `).all();
}

export function loadDbReleaseTracks(db) {
  return db.prepare(`
    SELECT release_id, track_id, track_number, disc_number, soundrop_source_order
    FROM sf_release_tracks
  `).all();
}

// ── リリース差分 ──────────────────────────────────────────────────────────────

/**
 * DB リリースと Soundrop リリースを比較する。
 *
 * @param {object[]} dbReleases
 * @param {object[]} soundropReleases - normalizeReleaseListItem + normalizeReleaseDetail のマージ結果
 * @returns {{ matched, new, updated, skipped, conflicts }}
 */
export function diffReleases(dbReleases, soundropReleases) {
  const matched   = [];
  const newItems  = [];
  const updated   = [];
  const skipped   = [];
  const conflicts = [];

  const dbBySoundropId = new Map(
    dbReleases.filter(r => r.soundrop_release_id != null)
              .map(r => [r.soundrop_release_id, r]),
  );
  const dbByUpc = new Map(
    dbReleases.filter(r => r.upc_ean).map(r => [r.upc_ean, r]),
  );

  for (const sr of soundropReleases) {
    // マッチ優先順: soundrop_release_id → UPC
    const dbRel = dbBySoundropId.get(sr.soundrop_release_id)
                ?? (sr.upc ? dbByUpc.get(sr.upc) : null);

    if (!dbRel) {
      if (!sr.soundrop_release_id && !sr.upc) {
        skipped.push({ reason: 'no soundrop_release_id and no UPC', soundrop: sr });
      } else {
        newItems.push(sr);
      }
      continue;
    }

    matched.push({ db: dbRel, soundrop: sr });

    // 変更検出
    const changes = [];
    if (dbRel.soundrop_release_id == null) {
      changes.push({ field: 'soundrop_release_id', from: null, to: sr.soundrop_release_id });
    }
    if (sr.soundrop_status != null && dbRel.soundrop_status !== sr.soundrop_status) {
      changes.push({ field: 'soundrop_status', from: dbRel.soundrop_status ?? null, to: sr.soundrop_status });
    }
    if (sr.soundrop_artwork_file_id
        && dbRel.soundrop_artwork_file_id !== sr.soundrop_artwork_file_id) {
      changes.push({
        field: 'soundrop_artwork_file_id',
        from: dbRel.soundrop_artwork_file_id ?? null,
        to: sr.soundrop_artwork_file_id,
      });
    }

    if (changes.length > 0) updated.push({ db: dbRel, soundrop: sr, changes });
  }

  return { matched, new: newItems, updated, skipped, conflicts };
}

// ── トラック差分 ──────────────────────────────────────────────────────────────

/**
 * DB トラックと Soundrop トラックを比較する。
 *
 * @param {object[]} dbTracks
 * @param {object[]} soundropTracks - normalizeTrack の結果
 * @returns {{ matched, new, updated, skipped, conflicts }}
 */
export function diffTracks(dbTracks, soundropTracks) {
  const matched   = [];
  const newItems  = [];
  const updated   = [];
  const skipped   = [];
  const conflicts = [];

  const dbBySoundropId = new Map(
    dbTracks.filter(t => t.soundrop_track_id != null)
            .map(t => [t.soundrop_track_id, t]),
  );
  const dbByIsrc = new Map(
    dbTracks.filter(t => t.isrc).map(t => [t.isrc, t]),
  );

  for (const st of soundropTracks) {
    // マッチ優先順: soundrop_track_id → ISRC
    const dbTrack = dbBySoundropId.get(st.soundrop_track_id)
                  ?? (st.isrc ? dbByIsrc.get(st.isrc) : null);

    if (!dbTrack) {
      if (!st.soundrop_track_id && !st.isrc) {
        skipped.push({ reason: 'no soundrop_track_id and no ISRC', soundrop: st });
      } else {
        newItems.push(st);
      }
      continue;
    }

    matched.push({ db: dbTrack, soundrop: st });

    const changes = [];
    if (dbTrack.soundrop_track_id == null) {
      changes.push({ field: 'soundrop_track_id', from: null, to: st.soundrop_track_id });
    }
    if (dbTrack.soundrop_is_locked !== st.soundrop_is_locked) {
      changes.push({
        field: 'soundrop_is_locked',
        from: dbTrack.soundrop_is_locked ?? null,
        to: st.soundrop_is_locked,
      });
    }

    if (changes.length > 0) updated.push({ db: dbTrack, soundrop: st, changes });
  }

  return { matched, new: newItems, updated, skipped, conflicts };
}

// ── リリース↔トラック リレーション差分 ──────────────────────────────────────────

/**
 * リリース-トラックのリレーション差分を算出する。
 *
 * @param {object[]} dbRelTracks       - loadDbReleaseTracks() の結果
 * @param {object[]} releaseDetails    - normalizeReleaseDetail[] (tracks[] を含む)
 * @param {Map<number,number>} releaseIdMap - soundrop_release_id → sf_releases.id
 * @param {Map<number,number>} trackIdMap   - soundrop_track_id  → sf_tracks.id
 * @returns {{ toAdd, toUpdateOrder, conflicts, pendingNewRelease, pendingNewTrack }}
 */
export function diffReleaseTracks(dbRelTracks, releaseDetails, releaseIdMap, trackIdMap) {
  const toAdd           = [];
  const toUpdateOrder   = [];
  const conflicts       = [];
  const pendingNewRelease = []; // DB 未登録リリースのリレーション（実同期後に処理）
  const pendingNewTrack   = []; // DB 未登録トラックのリレーション

  const existingSet = new Set(dbRelTracks.map(rt => `${rt.release_id}:${rt.track_id}`));
  const existingMap = new Map(dbRelTracks.map(rt => [`${rt.release_id}:${rt.track_id}`, rt]));

  for (const detail of releaseDetails) {
    const dbReleaseId = releaseIdMap.get(detail.soundrop_release_id);
    if (!dbReleaseId) {
      pendingNewRelease.push({ soundrop_release_id: detail.soundrop_release_id, trackCount: detail.tracks.length });
      continue;
    }

    for (const t of detail.tracks) {
      const dbTrackId = trackIdMap.get(t.soundrop_track_id);
      if (!dbTrackId) {
        pendingNewTrack.push({ soundrop_track_id: t.soundrop_track_id, name: t.name });
        continue;
      }

      const key = `${dbReleaseId}:${dbTrackId}`;

      if (!existingSet.has(key)) {
        toAdd.push({
          release_id:           dbReleaseId,
          track_id:             dbTrackId,
          track_number:         t.source_order + 1,  // 1-indexed
          soundrop_source_order: t.source_order,      // 0-indexed 配列順
        });
      } else {
        const existing = existingMap.get(key);
        if (existing && existing.soundrop_source_order !== t.source_order) {
          toUpdateOrder.push({
            release_id:           dbReleaseId,
            track_id:             dbTrackId,
            soundrop_source_order: t.source_order,
          });
        }
      }
    }
  }

  return { toAdd, toUpdateOrder, conflicts, pendingNewRelease, pendingNewTrack, existing: dbRelTracks };
}
