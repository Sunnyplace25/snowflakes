/**
 * jarvis/importers/matchers/track_matcher.js
 * インポート行を sf_tracks / sf_releases にマッチさせる。
 *
 * マッチ優先順位:
 *   1. ISRC        → sf_tracks.isrc
 *   2. UPC/EAN     → sf_releases.upc_ean
 *   3. track_key   → sf_tracks.track_key（完全一致）
 *   4. unmatched   → needs_review = 1
 *
 * 不明なトラックのタイトルや登録詳細は推測しない。
 */

/**
 * インポート行を楽曲またはリリースにマッチさせる。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} row - インポート行オブジェクト
 * @param {string} [row.isrc]      - ISRC コード
 * @param {string} [row.upc]       - UPC/EAN コード
 * @param {string} [row.track_key] - トラックキー
 * @returns {{ track_id: number|null, release_id: number|null, method: string }}
 */
export function matchTrack(db, row) {
  // 1. ISRC マッチ
  if (row.isrc && row.isrc.trim()) {
    const track = db.prepare(
      'SELECT id FROM sf_tracks WHERE isrc = ? LIMIT 1'
    ).get(row.isrc.trim());
    if (track) {
      return { track_id: track.id, release_id: null, method: 'isrc' };
    }
  }

  // 2. UPC/EAN マッチ
  const upc = row.upc || row.upc_ean || row['UPC/EAN'] || '';
  if (upc && upc.trim()) {
    const release = db.prepare(
      'SELECT id FROM sf_releases WHERE upc_ean = ? LIMIT 1'
    ).get(upc.trim());
    if (release) {
      return { track_id: null, release_id: release.id, method: 'upc' };
    }
  }

  // 3. track_key マッチ
  if (row.track_key && row.track_key.trim()) {
    const track = db.prepare(
      'SELECT id FROM sf_tracks WHERE track_key = ? LIMIT 1'
    ).get(row.track_key.trim());
    if (track) {
      return { track_id: track.id, release_id: null, method: 'track_key' };
    }
  }

  // 4. アンマッチ
  return { track_id: null, release_id: null, method: 'unmatched' };
}
