/**
 * jarvis/importers/catalog_builder.js
 * Soundrop Statement CSV から sf_tracks / sf_releases を自動登録するカタログビルダー
 *
 * sf_tracks 照合優先順位:
 *   1. ISRC完全一致 → 既存レコードをUPDATE（track_key/id変更なし）
 *   2. ISRC不一致の場合、title完全一致 + isrc IS NULL を検索
 *      - 1件一致 → ISRCとstatusをUPDATE（track_key/id変更なし）
 *      - 0件    → 新規INSERT（track_key='isrc_'+ISRC.toLowerCase()）
 *      - 2件以上 → needs_review に記録（自動確定しない）
 *
 * sf_releases 照合:
 *   - UPC一致 → スキップ（既存レコード優先）
 *   - UPC不一致 → INSERT
 *     - ISRCが1件: release_type='single'
 *     - ISRCが複数 + options.releaseTypes[upc]指定あり → 指定値を使用
 *     - ISRCが複数 + 指定なし → 登録保留（needs_review に記録）
 *
 * 注意:
 *   - sf_track_releases は登録しない（Statement実績 ≠ 現在のlive状態）
 *   - sf_tracks.status='released' のみ設定（「配信実績あり」の確定事実）
 *   - Track Title は parseCsv が .trim() 済み。念のため再trim。
 */

'use strict';

import { parseCsv } from './parsers/csv_parser.js';

/**
 * Soundrop Statement CSV テキストを解析し、sf_tracks / sf_releases を更新する。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} csvText  Soundrop Statement CSV の生テキスト
 * @param {object} [options]
 * @param {Object.<string,string>} [options.releaseTypes]
 *   UPC → release_type の上書きマップ（例: { '199999625681': 'ep' }）。
 *   複数ISRCのリリースはここで type を指定しないと登録保留になる。
 * @returns {{
 *   tracksUpdatedByIsrc:  number,
 *   tracksUpdatedByTitle: number,
 *   tracksInserted:       number,
 *   tracksNeedsReview:    Array<{isrc:string, title:string, reason:string}>,
 *   releasesInserted:     number,
 *   releasesSkipped:      number,
 *   releaseTracksLinked:  number,
 *   distributionsLinked:  number,
 * }}
 */
export function buildCatalog(db, csvText, options = {}) {
  const releaseTypes = options.releaseTypes ?? {};
  const rows = parseCsv(csvText);

  // ── 1. CSV 行を ISRC / UPC 単位に集約 ────────────────────────────────────
  // ISRC → { isrc, title, upc, releaseTitle }（重複除去済み）
  const isrcMap = new Map();
  // UPC → Set<isrc>（UPC ごとの ISRC 集合）
  const upcToIsrcs = new Map();
  // UPC → releaseTitle
  const upcToTitle = new Map();

  for (const row of rows) {
    const isrc       = (row['ISRC']         ?? '').trim();
    const title      = (row['Track Title']   ?? '').trim();
    const upc        = (row['UPC']           ?? '').trim();
    const relTitle   = (row['Release Title'] ?? '').trim();

    if (!isrc || !title || !upc) continue;

    if (!isrcMap.has(isrc)) {
      isrcMap.set(isrc, { isrc, title, upc, releaseTitle: relTitle });
    }
    if (!upcToIsrcs.has(upc)) {
      upcToIsrcs.set(upc, new Set());
      upcToTitle.set(upc, relTitle);
    }
    upcToIsrcs.get(upc).add(isrc);
  }

  // ── 2. sf_tracks 照合・登録 ───────────────────────────────────────────────
  const result = {
    tracksUpdatedByIsrc:  0,
    tracksUpdatedByTitle: 0,
    tracksInserted:       0,
    tracksNeedsReview:    [],
    releasesInserted:     0,
    releasesSkipped:      0,
    releaseTracksLinked:  0,
    distributionsLinked:  0,
  };

  // isrc → track_id（後で sf_release_tracks に使用）
  const isrcToTrackId = new Map();

  const stmtByIsrc  = db.prepare('SELECT id FROM sf_tracks WHERE isrc = ?');
  const stmtByTitle = db.prepare(
    "SELECT id FROM sf_tracks WHERE title = ? AND isrc IS NULL"
  );
  const stmtUpdateStatus = db.prepare(
    "UPDATE sf_tracks SET status = 'released' WHERE id = ?"
  );
  const stmtUpdateIsrc = db.prepare(
    "UPDATE sf_tracks SET isrc = ?, status = 'released' WHERE id = ?"
  );
  const stmtInsertTrack = db.prepare(`
    INSERT OR IGNORE INTO sf_tracks (track_key, title, isrc, status)
    VALUES (?, ?, ?, 'released')
  `);
  const stmtGetByKey = db.prepare('SELECT id FROM sf_tracks WHERE track_key = ?');

  for (const [isrc, info] of isrcMap) {
    const { title, upc } = info;

    // Step 1: ISRC 完全一致
    const byIsrc = stmtByIsrc.get(isrc);
    if (byIsrc) {
      stmtUpdateStatus.run(byIsrc.id);
      isrcToTrackId.set(isrc, byIsrc.id);
      result.tracksUpdatedByIsrc++;
      continue;
    }

    // Step 2: タイトル完全一致 + isrc IS NULL
    const byTitle = stmtByTitle.all(title);

    if (byTitle.length === 1) {
      stmtUpdateIsrc.run(isrc, byTitle[0].id);
      isrcToTrackId.set(isrc, byTitle[0].id);
      result.tracksUpdatedByTitle++;
      continue;
    }

    if (byTitle.length >= 2) {
      result.tracksNeedsReview.push({
        isrc,
        title,
        reason: `タイトル "${title}" が ${byTitle.length} 件存在しISRC未設定のため自動確定不可`,
      });
      continue;
    }

    // Step 3: 新規 INSERT
    const trackKey = 'isrc_' + isrc.toLowerCase();
    stmtInsertTrack.run(trackKey, title, isrc);
    const inserted = stmtGetByKey.get(trackKey);
    if (inserted) {
      isrcToTrackId.set(isrc, inserted.id);
      result.tracksInserted++;
    }
  }

  // ── 3. sf_releases 照合・登録 ─────────────────────────────────────────────
  // upc → release_id（後で sf_release_tracks / sf_distributions に使用）
  const upcToReleaseId = new Map();

  const stmtReleaseByUpc  = db.prepare('SELECT id FROM sf_releases WHERE upc_ean = ?');
  const stmtInsertRelease = db.prepare(`
    INSERT OR IGNORE INTO sf_releases (release_key, title, release_type, status, upc_ean)
    VALUES (?, ?, ?, 'released', ?)
  `);
  const stmtGetRelByKey = db.prepare('SELECT id FROM sf_releases WHERE release_key = ?');

  for (const [upc, isrcs] of upcToIsrcs) {
    const releaseTitle = upcToTitle.get(upc);

    // 既存 UPC チェック
    const existing = stmtReleaseByUpc.get(upc);
    if (existing) {
      upcToReleaseId.set(upc, existing.id);
      result.releasesSkipped++;
      continue;
    }

    // release_type を決定
    let releaseType;
    if (releaseTypes[upc]) {
      releaseType = releaseTypes[upc];
    } else if (isrcs.size === 1) {
      releaseType = 'single';
    } else {
      // 複数 ISRC かつ override 未指定 → 登録保留
      result.tracksNeedsReview.push({
        isrc:   [...isrcs].join(', '),
        title:  releaseTitle,
        reason: `UPC ${upc} は複数ISRC（${isrcs.size}件）でrelease_type未指定のため登録保留`,
      });
      result.releasesSkipped++;
      continue;
    }

    const releaseKey = 'upc_' + upc;
    stmtInsertRelease.run(releaseKey, releaseTitle, releaseType, upc);
    const inserted = stmtGetRelByKey.get(releaseKey);
    if (inserted) {
      upcToReleaseId.set(upc, inserted.id);
      result.releasesInserted++;
    }
  }

  // ── 4. sf_release_tracks 登録 ────────────────────────────────────────────
  const stmtLinkExists = db.prepare(
    'SELECT 1 FROM sf_release_tracks WHERE release_id = ? AND track_id = ?'
  );
  const stmtInsertLink = db.prepare(`
    INSERT INTO sf_release_tracks (release_id, track_id, track_number)
    VALUES (?, ?, NULL)
  `);

  for (const [isrc, info] of isrcMap) {
    const trackId   = isrcToTrackId.get(isrc);
    const releaseId = upcToReleaseId.get(info.upc);
    if (!trackId || !releaseId) continue;

    if (!stmtLinkExists.get(releaseId, trackId)) {
      stmtInsertLink.run(releaseId, trackId);
      result.releaseTracksLinked++;
    }
  }

  // ── 5. sf_distributions 登録 ─────────────────────────────────────────────
  const stmtDistExists = db.prepare(
    "SELECT 1 FROM sf_distributions WHERE release_id = ? AND distributor = 'soundrop'"
  );
  const stmtInsertDist = db.prepare(`
    INSERT INTO sf_distributions (release_id, distributor, distribution_status)
    VALUES (?, 'soundrop', 'distributed')
  `);

  for (const [, releaseId] of upcToReleaseId) {
    if (!stmtDistExists.get(releaseId)) {
      stmtInsertDist.run(releaseId);
      result.distributionsLinked++;
    }
  }

  return result;
}
