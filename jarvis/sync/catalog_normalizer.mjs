/**
 * jarvis/sync/catalog_normalizer.mjs
 * Soundrop API レスポンスを DB スキーマ用オブジェクトへ正規化する。
 *
 * 安全原則:
 * - lyrics, email, Stripe/payment 情報, audio URL は除外する。
 * - 必要フィールドのみ whitelist で抽出する。
 * - Token・認証情報は一切扱わない。
 * - release type は typeName 文字列のみ使用（typeId / releaseTypeId 数値から推測しない）。
 */

// ── release type 名称マッピング (typeName 文字列のみ) ─────────────────────────
// typeId / releaseTypeId の数値は使用しない
const TYPE_NAME_MAP = {
  single:      'single',
  album:       'album',
  ep:          'ep',
  compilation: 'compilation',
};

/**
 * release/all の typeName を sf_releases.release_type 値へ変換する。
 * 不明な typeName は 'single' に倒す（数値から推測しない）。
 */
export function mapTypeName(typeName) {
  if (!typeName) return 'single';
  const key = String(typeName).toLowerCase().trim();
  return TYPE_NAME_MAP[key] ?? 'single';
}

// ── ISO8601 → YYYY-MM-DD（時刻部分を除去） ────────────────────────────────────
function toDate(isoString) {
  if (!isoString) return null;
  const s = String(isoString);
  // '0001-01-01T...' などシステム既定値は null 扱い
  if (s.startsWith('0001-') || s.startsWith('0000-')) return null;
  return s.slice(0, 10);
}

// ── UUID ゼロ値チェック ────────────────────────────────────────────────────────
function validFileId(fileId) {
  if (!fileId) return null;
  if (fileId === '00000000-0000-0000-0000-000000000000') return null;
  return fileId;
}

// ── Status 判定 ───────────────────────────────────────────────────────────────
/**
 * リリース詳細の正規化オブジェクトから Soundrop status を判定する。
 *
 * 優先順位:
 *   1. isReleaseCanceledFromDistribution=true → 'canceled'
 *   2. isDraft=true                           → 'unreleased'
 *   3. releaseDate が未来                     → 'scheduled'
 *   4. releaseDate が今日以前                 → 'released'
 *   5. releaseDate なし                       → 'unreleased'
 *
 * isLockedForDistribution / previouslyReleased 単独では判定しない。
 *
 * @param {object} normalized - normalizeReleaseDetail の戻り値
 * @param {Date}   [today]
 * @returns {'released'|'scheduled'|'canceled'|'unreleased'}
 */
export function deriveReleaseStatus(normalized, today = new Date()) {
  if (normalized.soundrop_is_canceled) return 'canceled';
  if (normalized.soundrop_is_draft)    return 'unreleased';
  if (!normalized.release_date)        return 'unreleased';

  const rd = new Date(normalized.release_date + 'T00:00:00');
  // ローカル日付の年月日を取得（toISOString は UTC 変換で日付がずれるため使用しない）
  const yy = today.getFullYear();
  const mm = String(today.getMonth() + 1).padStart(2, '0');
  const dd = String(today.getDate()).padStart(2, '0');
  const todayDate = new Date(`${yy}-${mm}-${dd}T00:00:00`);
  return rd > todayDate ? 'scheduled' : 'released';
}

/**
 * soundrop_status を sf_releases.status の CHECK 制約値へマッピングする。
 * 新規レコード挿入時のみ使用（既存レコードの status は変更しない）。
 */
export function toDbStatus(soundropStatus) {
  switch (soundropStatus) {
    case 'released':   return 'released';
    case 'scheduled':  return 'scheduled';
    case 'canceled':   return 'private';   // CHECK 制約内の最近似値
    case 'unreleased': return 'draft';
    default:           return 'draft';
  }
}

// ── リリース一覧 (GET /content/release/all) の正規化 ─────────────────────────
/**
 * release/all の items[] 1 要素を正規化する。
 * typeName 文字列を使用。typeId / releaseTypeId は無視する。
 */
export function normalizeReleaseListItem(raw) {
  return {
    soundrop_release_id:       raw.releaseId,
    name:                      raw.name ?? raw.releaseName ?? null,
    upc:                       raw.upc ?? null,
    release_type:              mapTypeName(raw.typeName),
    artist_name:               raw.artistName ?? null,
    soundrop_label_name:       raw.labelName ?? null,
    soundrop_artwork_file_id:  validFileId(raw.image?.fileId),
    soundrop_artwork_filename: raw.image?.filename ?? null,
    soundrop_is_locked:        raw.isLockedForDistribution ? 1 : 0,
  };
}

// ── リリース詳細 (GET /content/release?id=) の正規化 ─────────────────────────
/**
 * release?id= レスポンスを正規化する。
 * release_date は releaseDate を使用。saleStartDate は release_date に使用しない。
 * lyrics / audio URL / email / payment / Stripe 情報は除外。
 */
export function normalizeReleaseDetail(raw) {
  const normalized = {
    soundrop_release_id:          raw.releaseId,
    name:                         raw.name ?? null,
    upc:                          raw.upc ?? null,
    catalog:                      raw.catalog ?? null,
    release_date:                 toDate(raw.releaseDate),          // ← releaseDate のみ
    soundrop_sale_start_date:     toDate(raw.saleStartDate),
    soundrop_is_draft:            raw.isDraft ? 1 : 0,
    soundrop_is_canceled:         raw.isReleaseCanceledFromDistribution ? 1 : 0,
    soundrop_is_locked:           raw.isLockedForDistribution ? 1 : 0,
    soundrop_artwork_file_id:     validFileId(raw.image?.fileId),
    soundrop_artwork_filename:    raw.image?.filename ?? null,
    soundrop_copyright_p:         raw.copyrightP ?? null,
    soundrop_copyright_c:         raw.copyrightC ?? null,
    soundrop_language_id:         raw.languageId ?? null,
    soundrop_primary_style_id:    raw.primaryMusicStyleId ?? null,
    soundrop_secondary_style_id:  raw.secondaryMusicStyleId ?? null,
    // tracks[]: trackId / isrc / name / 配列順のみ保持
    // lyrics, audio URL, email, payment 情報は除外
    tracks: (raw.tracks ?? []).map((t, idx) => ({
      soundrop_track_id: t.trackId,
      isrc:              t.isrc ?? null,
      name:              t.name ?? null,
      source_order:      idx,           // 配列順 (0-indexed)
    })),
  };

  normalized.soundrop_status = deriveReleaseStatus(normalized);
  return normalized;
}

// ── トラック一覧 (GET /content/track/all) の正規化 ───────────────────────────
/**
 * track/all の items[] 1 要素を正規化する。
 * lyrics / audio URL / email / payment / Stripe 情報は除外。
 */
export function normalizeTrack(raw) {
  return {
    soundrop_track_id:        raw.trackId,
    name:                     raw.name ?? null,
    isrc:                     raw.isrc ?? null,
    version:                  raw.version ?? null,
    artist_name:              raw.artistName ?? null,
    soundrop_label_name:      raw.labelName ?? null,
    soundrop_is_locked:       raw.isLockedForDistribution ? 1 : 0,
    soundrop_is_fully_locked: raw.isFullyLocked ? 1 : 0,
    soundrop_is_canceled:     raw.isCanceledFromDistribution ? 1 : 0,
    // 所属リリース: releaseId のみ（UPC 等は release 側で管理）
    release_ids: (raw.releases ?? []).map(r => r.releaseId),
  };
}
