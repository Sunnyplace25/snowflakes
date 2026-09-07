/**
 * jarvis/sync/status_reconciler.mjs
 * Phase 27: Soundrop カタログ同期後のステータス整合モジュール
 *
 * - Soundrop同期済みリリースのstatusをローカルDBに反映する
 * - トラックstatusをlinked Soundropリリースから導出する
 * - API同期とは独立して実行可能（ローカルDBのsoundrop_*カラムのみ使用）
 *
 * 保護ルール:
 * - sf_distributions は一切変更しない
 * - 手動設定の private（soundrop_is_canceled でない）は変更しない
 * - Soundrop未同期リリース（soundrop_release_id IS NULL）は対象外
 * - sf_tracks に 'scheduled'/'draft' は書き込まない
 *   CHECK 制約: unknown/unreleased/streaming_pending/released/private
 */

import { localDateStr } from './catalog_normalizer.mjs';
export { localDateStr };

/**
 * リリースのステータスを reconcile する。
 *
 * @param {object} release - sf_releases レコード（soundrop_* カラム含む）
 * @param {string} todayLocal - YYYY-MM-DD 形式のローカル基準日
 * @returns {string|null} 新ステータス文字列、または null（スキップ）
 */
export function reconcileReleaseStatus(release, todayLocal) {
  // Soundrop未同期 → 対象外
  if (!release.soundrop_release_id || !release.soundrop_synced_at) return null;

  // 手動private保護: soundrop_is_canceled でない private は触らない
  if (release.status === 'private' && !release.soundrop_is_canceled) return null;

  if (release.soundrop_is_canceled) return 'private';
  if (release.soundrop_is_draft)    return 'draft';
  if (!release.release_date)        return 'draft';

  // YYYY-MM-DD 文字列の辞書順比較（タイムゾーン安全・ローカル基準日と一致）
  return release.release_date > todayLocal ? 'scheduled' : 'released';
}

/**
 * トラックのステータスを Soundrop同期済みリリースから導出する。
 *
 * linked releases は必ず
 *   soundrop_release_id IS NOT NULL AND soundrop_synced_at IS NOT NULL
 * を満たすものだけを渡すこと（呼び出し側 or applyStatusReconciliation で保証）。
 *
 * 変換マッピング（sf_tracks.status の CHECK 制約に収まる値のみ）:
 *   release.status='released'   → 'released'
 *   release.status='scheduled'  → 'streaming_pending'  ← 'scheduled' は書き込まない
 *   release.status='draft'      → 'unreleased'         ← 'draft' は書き込まない
 *   全 release が 'private'     → 'private'
 *
 * @param {object}   track                  - sf_tracks レコード
 * @param {object[]} soundropLinkedReleases - Soundrop同期済みリリースのみ
 * @returns {string|null} 新ステータス、または null（スキップ）
 */
export function reconcileTrackStatus(track, soundropLinkedReleases) {
  // 手動private保護
  if (track.status === 'private') return null;

  // Soundrop同期済みリリースが0件 → 現状維持
  if (!soundropLinkedReleases || soundropLinkedReleases.length === 0) return null;

  // 優先順位: released > scheduled(→streaming_pending) > draft(→unreleased) > 全private
  if (soundropLinkedReleases.some(r => r.status === 'released'))   return 'released';
  if (soundropLinkedReleases.some(r => r.status === 'scheduled'))  return 'streaming_pending';
  if (soundropLinkedReleases.some(r => r.status === 'draft'))      return 'unreleased';
  if (soundropLinkedReleases.every(r => r.status === 'private'))   return 'private';

  return null;
}

/**
 * DB全体に対してステータス整合を適用する。
 * Soundrop API接続なし・Token不要でローカルのみ実行可能。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} [todayLocal] - YYYY-MM-DD（省略時はローカル現在日）
 * @returns {{ releasesChanged: number, tracksChanged: number }}
 */
export function applyStatusReconciliation(db, todayLocal = localDateStr()) {
  let releasesChanged = 0;
  let tracksChanged   = 0;

  // ── リリース整合 ──────────────────────────────────────────────────────────
  // 対象: Soundrop同期済み（soundrop_release_id IS NOT NULL AND soundrop_synced_at IS NOT NULL）
  const releases = db.prepare(`
    SELECT id, status, release_date,
           soundrop_release_id, soundrop_synced_at,
           soundrop_is_canceled, soundrop_is_draft
    FROM sf_releases
    WHERE soundrop_release_id IS NOT NULL
      AND soundrop_synced_at  IS NOT NULL
  `).all();

  for (const rel of releases) {
    const newStatus = reconcileReleaseStatus(rel, todayLocal);
    if (newStatus === null)       continue;  // スキップ（未同期 or 手動private）
    if (newStatus === rel.status) continue;  // 変化なし
    db.prepare('UPDATE sf_releases SET status = ? WHERE id = ?').run(newStatus, rel.id);
    releasesChanged++;
  }

  // ── トラック整合 ──────────────────────────────────────────────────────────
  // linked releases は Soundrop同期済みのもののみ取得（手動リリースは除外）
  const tracks = db.prepare('SELECT id, status FROM sf_tracks').all();

  const linkedRelStmt = db.prepare(`
    SELECT r.id, r.status
    FROM sf_releases r
    JOIN sf_release_tracks rt ON rt.release_id = r.id
    WHERE rt.track_id = ?
      AND r.soundrop_release_id IS NOT NULL
      AND r.soundrop_synced_at  IS NOT NULL
  `);

  for (const track of tracks) {
    const soundropLinkedReleases = linkedRelStmt.all(track.id);
    const newStatus = reconcileTrackStatus(track, soundropLinkedReleases);
    if (newStatus === null)         continue;  // スキップ（リンクなし or 手動private）
    if (newStatus === track.status) continue;  // 変化なし
    db.prepare('UPDATE sf_tracks SET status = ? WHERE id = ?').run(newStatus, track.id);
    tracksChanged++;
  }

  return { releasesChanged, tracksChanged };
}
