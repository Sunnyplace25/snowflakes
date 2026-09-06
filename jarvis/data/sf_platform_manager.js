/**
 * jarvis/data/sf_platform_manager.js
 * Snow flakes 配信サイト問題管理 データマネージャー (Phase 24)
 *
 * 管理対象:
 *   - sf_platform_issues: アーティストページ・リリース・楽曲単位の問題発生・対応履歴
 *
 * 状態モデル:
 *   ページ自体の登録・確認状態 → sf_artist_profiles.profile_status（既存）
 *   問題の発生・対応履歴       → sf_platform_issues（本ファイル管理）
 *   二重管理による食い違いを防ぐため、ページ状態の更新は upsertArtistProfile() で行い、
 *   問題追跡のみ本ファイルで扱う。
 *
 * entity_type と対応テーブル:
 *   'artist'  → sf_artist_profiles.id
 *   'release' → sf_releases.id
 *   'track'   → sf_tracks.id
 *   ※ ポリモーフィックな設計のため DB 側外部キー制約なし。
 *      呼び出し元でエンティティ存在確認を行うこと（createIssue 内で検証済み）。
 *
 * 制約:
 *   - テストは :memory: DB のみ使用すること
 *   - 外部 API 不使用
 */

// ── 定数 ──────────────────────────────────────────────────────────────────────

/**
 * 管理対象の配信プラットフォーム一覧。
 * UI 表示名変換に使用する。
 */
export const DISTRIBUTION_PLATFORMS = [
  { value: 'spotify',            label: 'Spotify' },
  { value: 'apple_music',        label: 'Apple Music' },
  { value: 'amazon_music',       label: 'Amazon Music' },
  { value: 'youtube_music',      label: 'YouTube Music' },
  { value: 'tidal',              label: 'TIDAL' },
  { value: 'qobuz',              label: 'Qobuz' },
  { value: 'deezer',             label: 'Deezer' },
  { value: 'pandora',            label: 'Pandora' },
  { value: 'iheartradio',        label: 'iHeartRadio' },
  { value: 'tiktok',             label: 'TikTok' },
  { value: 'facebook_instagram', label: 'Facebook / Instagram' },
  { value: 'anghami',            label: 'Anghami' },
  { value: 'boomplay',           label: 'Boomplay' },
  { value: 'ayoba',              label: 'Ayoba' },
  { value: 'netease',            label: 'NetEase' },
  { value: 'tencent',            label: 'Tencent Music' },
  { value: 'claro_musica',       label: 'Claro música' },
  { value: 'peloton',            label: 'Peloton' },
  { value: 'awa',                label: 'AWA' },
  { value: 'line_music',         label: 'LINE MUSIC' },
  { value: 'kkbox',              label: 'KKBOX' },
  { value: 'lissen',             label: 'Lissen' },
  { value: 'audiomack',          label: 'Audiomack' },
  { value: 'audible_magic',      label: 'Audible Magic' },
  { value: 'nuuday',             label: 'Nuuday' },
  { value: 'flo',                label: 'FLO' },
  { value: 'snapchat',           label: 'Snapchat' },
  { value: 'seven_digital',      label: '7digital' },
  { value: 'other',              label: 'その他' },
];

/** issue_type コード → UI 表示名 */
export const ISSUE_TYPE_LABELS = {
  mixed_artist:  '別アーティストとの混在',
  wrong_link:    '別人・別ページへの紐付け',
  name_variant:  '表記揺れ',
  not_reflected: '未反映',
  other:         'その他',
};

/** issue_status コード → UI 表示名 */
export const ISSUE_STATUS_LABELS = {
  open:      'オープン',
  requested: '修正依頼済み',
  resolved:  '解決済み',
  wont_fix:  '対応しない',
};

// ── 内部ヘルパー ──────────────────────────────────────────────────────────────

/**
 * entity_type に対応するテーブル名を返す。
 * 存在しない entity_type の場合は null。
 */
function entityTable(entityType) {
  return {
    artist:  'sf_artist_profiles',
    release: 'sf_releases',
    track:   'sf_tracks',
  }[entityType] ?? null;
}

/**
 * 指定 entity が実在するか確認する。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} entityType
 * @param {number} entityId
 * @returns {boolean}
 */
function entityExists(db, entityType, entityId) {
  const table = entityTable(entityType);
  if (!table) return false;
  const row = db.prepare(`SELECT 1 FROM ${table} WHERE id = ? LIMIT 1`).get(entityId);
  return !!row;
}

// ── 配信プラットフォーム一覧 ──────────────────────────────────────────────────

/**
 * 管理対象の配信プラットフォーム一覧を返す（静的リスト）。
 * @returns {{ value: string, label: string }[]}
 */
export function getDistributionPlatforms() {
  return DISTRIBUTION_PLATFORMS;
}

// ── issue 一覧・取得 ─────────────────────────────────────────────────────────

/**
 * sf_platform_issues 一覧を返す。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{
 *   entity_type?: string,
 *   entity_id?:   number,
 *   platform?:    string,
 *   issue_status?: string,
 * }} [opts]
 * @returns {object[]}
 */
export function getIssues(db, opts = {}) {
  const { entity_type, entity_id, platform, issue_status } = opts;

  const where = [];
  const params = [];

  if (entity_type) { where.push('entity_type = ?'); params.push(entity_type); }
  if (entity_id)   { where.push('entity_id   = ?'); params.push(entity_id); }
  if (platform)    { where.push('platform    = ?'); params.push(platform); }
  if (issue_status){ where.push('issue_status = ?'); params.push(issue_status); }

  const sql = `
    SELECT * FROM sf_platform_issues
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY
      CASE issue_status WHEN 'open' THEN 0 WHEN 'requested' THEN 1 ELSE 2 END,
      created_at DESC
  `;

  return db.prepare(sql).all(...params);
}

/**
 * 単一 issue を返す。存在しない場合は null。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} id
 * @returns {object|null}
 */
export function getIssue(db, id) {
  return db.prepare('SELECT * FROM sf_platform_issues WHERE id = ?').get(id) ?? null;
}

// ── issue 登録 ────────────────────────────────────────────────────────────────

/**
 * 新規 issue を登録する。
 * entity の存在確認を行い、存在しない場合はエラーを投げる。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{
 *   entity_type:   'artist'|'release'|'track',
 *   entity_id:     number,
 *   platform:      string,
 *   issue_type?:   string,
 *   issue_status?: string,
 *   opened_at?:    string,
 *   requested_at?: string,
 *   resolved_at?:  string,
 *   last_checked_at?: string,
 *   related_url?:  string,
 *   memo?:         string,
 * }} data
 * @returns {{ id: number }}
 */
export function createIssue(db, data) {
  if (!data.entity_type) throw new Error('entity_type は必須です');
  if (!data.entity_id)   throw new Error('entity_id は必須です');
  if (!data.platform)    throw new Error('platform は必須です');

  if (!entityExists(db, data.entity_type, data.entity_id)) {
    throw new Error(
      `entity_type='${data.entity_type}' id=${data.entity_id} が存在しません`
    );
  }

  const result = db.prepare(`
    INSERT INTO sf_platform_issues
      (entity_type, entity_id, platform, issue_type, issue_status,
       opened_at, requested_at, resolved_at, last_checked_at, related_url, memo)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    data.entity_type,
    data.entity_id,
    data.platform,
    data.issue_type      ?? 'other',
    data.issue_status    ?? 'open',
    data.opened_at       ?? null,
    data.requested_at    ?? null,
    data.resolved_at     ?? null,
    data.last_checked_at ?? null,
    data.related_url     ?? null,
    data.memo            ?? null,
  );

  return { id: Number(result.lastInsertRowid) };
}

// ── issue 更新 ────────────────────────────────────────────────────────────────

/**
 * issue を更新する（部分更新可・COALESCE で未指定フィールドは保持）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} id
 * @param {{
 *   platform?:      string,
 *   issue_type?:    string,
 *   issue_status?:  string,
 *   opened_at?:     string,
 *   requested_at?:  string,
 *   resolved_at?:   string,
 *   last_checked_at?: string,
 *   related_url?:   string,
 *   memo?:          string,
 * }} data
 * @returns {{ id: number }}
 */
export function updateIssue(db, id, data) {
  const existing = getIssue(db, id);
  if (!existing) throw new Error(`issue id=${id} が存在しません`);

  db.prepare(`
    UPDATE sf_platform_issues SET
      platform        = COALESCE(?, platform),
      issue_type      = COALESCE(?, issue_type),
      issue_status    = COALESCE(?, issue_status),
      opened_at       = COALESCE(?, opened_at),
      requested_at    = COALESCE(?, requested_at),
      resolved_at     = COALESCE(?, resolved_at),
      last_checked_at = COALESCE(?, last_checked_at),
      related_url     = COALESCE(?, related_url),
      memo            = COALESCE(?, memo),
      updated_at      = datetime('now','localtime')
    WHERE id = ?
  `).run(
    data.platform        ?? null,
    data.issue_type      ?? null,
    data.issue_status    ?? null,
    data.opened_at       ?? null,
    data.requested_at    ?? null,
    data.resolved_at     ?? null,
    data.last_checked_at ?? null,
    data.related_url     ?? null,
    data.memo            ?? null,
    id,
  );

  return { id };
}

// ── 状態変更ショートカット ────────────────────────────────────────────────────

/**
 * issue を「修正依頼済み (requested)」に変更する。
 * requested_at が未設定の場合は今日の日付を自動セットする。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} id
 * @param {string} [requestedAt] YYYY-MM-DD（省略時は実行日）
 * @returns {{ id: number }}
 */
export function setIssueRequested(db, id, requestedAt) {
  const existing = getIssue(db, id);
  if (!existing) throw new Error(`issue id=${id} が存在しません`);

  const date = requestedAt ?? new Date().toISOString().slice(0, 10);
  db.prepare(`
    UPDATE sf_platform_issues SET
      issue_status = 'requested',
      requested_at = COALESCE(requested_at, ?),
      updated_at   = datetime('now','localtime')
    WHERE id = ?
  `).run(date, id);

  return { id };
}

/**
 * issue を「解決済み (resolved)」に変更する。
 * resolved_at が未設定の場合は今日の日付を自動セットする。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} id
 * @param {string} [resolvedAt] YYYY-MM-DD（省略時は実行日）
 * @returns {{ id: number }}
 */
export function resolveIssue(db, id, resolvedAt) {
  const existing = getIssue(db, id);
  if (!existing) throw new Error(`issue id=${id} が存在しません`);

  const date = resolvedAt ?? new Date().toISOString().slice(0, 10);
  db.prepare(`
    UPDATE sf_platform_issues SET
      issue_status = 'resolved',
      resolved_at  = COALESCE(resolved_at, ?),
      updated_at   = datetime('now','localtime')
    WHERE id = ?
  `).run(date, id);

  return { id };
}

/**
 * last_checked_at を今日の日付で更新する。
 * 「今も問題があるか」「確認が古いだけか」を区別するために使用。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} id
 * @param {string} [checkedAt] YYYY-MM-DD（省略時は実行日）
 * @returns {{ id: number }}
 */
export function touchIssueChecked(db, id, checkedAt) {
  const existing = getIssue(db, id);
  if (!existing) throw new Error(`issue id=${id} が存在しません`);

  const date = checkedAt ?? new Date().toISOString().slice(0, 10);
  db.prepare(`
    UPDATE sf_platform_issues SET
      last_checked_at = ?,
      updated_at      = datetime('now','localtime')
    WHERE id = ?
  `).run(date, id);

  return { id };
}
