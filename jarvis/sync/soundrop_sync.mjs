/**
 * jarvis/sync/soundrop_sync.mjs
 * Soundrop カタログ同期 — 共有ロジック（CLI + Dashboard API 共用）
 *
 * 安全原則:
 * - GET のみ（POST / PUT / PATCH / DELETE 禁止）
 * - Token はメモリ内でのみ使用・ログ/DB/ファイルへ保存しない
 * - エラーメッセージから Token を除去して throw する
 */

import {
  fetchAllReleases, fetchAllTracks, fetchReleaseDetail,
} from './soundrop_client.mjs';
import {
  normalizeReleaseListItem, normalizeReleaseDetail, normalizeTrack,
} from './catalog_normalizer.mjs';
import {
  loadDbReleases, loadDbTracks, loadDbReleaseTracks,
  diffReleases, diffTracks, diffReleaseTracks,
} from './catalog_diff.mjs';
import { applyDiff } from './catalog_writer.mjs';

/**
 * Soundrop API からカタログを取得して DB との差分を計算する（読み取り専用）。
 *
 * @param {string} token - Soundrop API Token
 * @param {import('node:sqlite').DatabaseSync} db - DB 接続（dry-run 時は read-only 推奨）
 * @param {object} [options]
 * @param {function} [options.onProgress] - 進捗コールバック ({ step, message }) => void
 * @returns {Promise<{
 *   releaseDetails: object[],
 *   dbRelTracks:    object[],
 *   releaseDiff:    object,
 *   trackDiff:      object,
 *   relTrackDiff:   object,
 *   detailErrors:   number,
 * }>}
 */
export async function runSoundropDiff(token, db, options = {}) {
  const notify = (step, message) => {
    if (options.onProgress) options.onProgress({ step, message });
  };

  // ── 1. リリース一覧 ────────────────────────────────────────────────────
  notify('releases', 'リリース一覧取得中...');
  const rawReleases = await fetchAllReleases(token);

  // ── 2. トラック一覧 ───────────────────────────────────────────────────
  notify('tracks', 'トラック一覧取得中...');
  const rawTracks = await fetchAllTracks(token);

  // ── 3. リリース詳細 ───────────────────────────────────────────────────
  notify('details', `リリース詳細取得中 (${rawReleases.length}件)...`);
  const releaseDetails = [];
  let detailErrors     = 0;

  for (const raw of rawReleases) {
    try {
      const detail = await fetchReleaseDetail(token, raw.releaseId);
      releaseDetails.push(normalizeReleaseDetail(detail));
    } catch (_e) {
      detailErrors++;
    }
  }

  // ── 4. 正規化 ─────────────────────────────────────────────────────────
  const detailByReleaseId = new Map(releaseDetails.map(d => [d.soundrop_release_id, d]));

  const soundropReleases = rawReleases.map(r => {
    const listItem = normalizeReleaseListItem(r);
    const detail   = detailByReleaseId.get(r.releaseId);
    return detail ? { ...listItem, ...detail } : listItem;
  });

  const soundropTracks = rawTracks.map(normalizeTrack);

  // ── 5. DB 現状ロード ──────────────────────────────────────────────────
  notify('diff', 'DB と差分を計算中...');
  const dbReleases  = loadDbReleases(db);
  const dbTracks    = loadDbTracks(db);
  const dbRelTracks = loadDbReleaseTracks(db);

  // ── 6. diff 計算 ──────────────────────────────────────────────────────
  const releaseDiff = diffReleases(dbReleases, soundropReleases);
  const trackDiff   = diffTracks(dbTracks, soundropTracks);

  const wouldBeReleaseIdMap = new Map(
    releaseDiff.matched.map(({ db: d, soundrop: s }) => [s.soundrop_release_id, d.id]),
  );
  const wouldBeTrackIdMap = new Map(
    trackDiff.matched.map(({ db: d, soundrop: s }) => [s.soundrop_track_id, d.id]),
  );

  const relTrackDiff = diffReleaseTracks(
    dbRelTracks,
    releaseDetails,
    wouldBeReleaseIdMap,
    wouldBeTrackIdMap,
  );

  return {
    releaseDetails,
    dbRelTracks,
    releaseDiff,
    trackDiff,
    relTrackDiff,
    detailErrors,
  };
}

/**
 * diff 結果を整形して API レスポンス / CLI レポート向けの概要オブジェクトを返す。
 * Token / URL / 生データは含まない。
 *
 * @param {object} diffResult - runSoundropDiff の戻り値
 * @returns {object} UI・API 向けの diff 概要
 */
export function summarizeDiff({ releaseDiff, trackDiff, relTrackDiff, dbRelTracks, detailErrors }) {
  return {
    releases: {
      matched:      releaseDiff.matched.length,
      new:          releaseDiff.new.length,
      updated:      releaseDiff.updated.length,
      skipped:      releaseDiff.skipped.length,
      conflicts:    releaseDiff.conflicts.length,
      newItems:     releaseDiff.new.map(sr => ({
        name:                sr.name,
        soundrop_release_id: sr.soundrop_release_id,
        release_type:        sr.release_type,
        status:              sr.soundrop_status ?? '-',
      })),
      updatedItems: releaseDiff.updated.map(({ db: d, changes }) => ({
        title:   d.title,
        id:      d.id,
        changes: changes.map(c => ({ field: c.field, from: c.from ?? null, to: c.to })),
      })),
    },
    tracks: {
      matched:      trackDiff.matched.length,
      new:          trackDiff.new.length,
      updated:      trackDiff.updated.length,
      skipped:      trackDiff.skipped.length,
      conflicts:    trackDiff.conflicts.length,
      newItems:     trackDiff.new.map(st => ({
        name:             st.name,
        soundrop_track_id: st.soundrop_track_id,
        isrc:             st.isrc ?? '-',
      })),
      updatedItems: trackDiff.updated.map(({ db: d, changes }) => ({
        title:   d.title,
        id:      d.id,
        changes: changes.map(c => ({ field: c.field, from: c.from ?? null, to: c.to })),
      })),
      skippedItems: trackDiff.skipped.map(({ reason, soundrop: s }) => ({
        name: s.name,
        reason,
      })),
    },
    relations: {
      existing:          dbRelTracks.length,
      toAdd:             relTrackDiff.toAdd.length,
      toUpdateOrder:     relTrackDiff.toUpdateOrder.length,
      conflicts:         relTrackDiff.conflicts.length,
      pendingNewRelease: relTrackDiff.pendingNewRelease.length,
      pendingNewTrack:   relTrackDiff.pendingNewTrack.length,
    },
    detailErrors,
    hasChanges: (
      releaseDiff.new.length       > 0 ||
      releaseDiff.updated.length   > 0 ||
      trackDiff.new.length         > 0 ||
      trackDiff.updated.length     > 0 ||
      relTrackDiff.toAdd.length    > 0 ||
      relTrackDiff.toUpdateOrder.length > 0
    ),
  };
}
