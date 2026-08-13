/**
 * jarvis/importers/music_metrics_writer.js
 * 音楽ストリーミング指標ライター（Phase 5）
 *
 * - 既存の metrics_writer.js とは別ファイル（既存ファイルは変更しない）
 * - sf_music_metrics へ UPSERT する（冪等・再インポート安全）
 * - platform='other' は使用しない（対象外サービスはスキップ）
 * - Transaction Month を日付基準とする（Statement Period は使用しない）
 */

/**
 * ストリーミング対象サービス名 → platform 値のマッピング。
 * ここにないサービスはスキップ（'other' にまとめない）。
 */
export const STREAMING_PLATFORM_MAP = {
  'Spotify':       'spotify',
  'Apple Music':   'apple_music',
  'Amazon Music':  'amazon_music',
  'YouTube Music': 'youtube_music',
  'YouTube Red':   'youtube_music',
};

/**
 * 生の Soundrop 行データから sf_music_metrics 用レコードを構築する。
 * フィルタリング・集計を行い、writeMusicMetrics に渡せる形式で返す。
 *
 * @param {Array<{
 *   transactionMonth: string,  // YYYY-MM（CSV の Transaction Month 列）
 *   trackId:          number|null,
 *   service:          string,  // CSV の Service 列の値そのまま
 *   quantity:         number,
 * }>} rawRows
 * @returns {Array<{
 *   date:     string,  // YYYY-MM-01
 *   month:    string,  // YYYY-MM
 *   platform: string,
 *   trackId:  number,
 *   streams:  number,
 * }>}
 */
export function buildMusicMetrics(rawRows) {
  const groups = new Map();

  for (const row of rawRows) {
    // trackId が null または整数でない行をスキップ
    if (row.trackId == null || !Number.isInteger(row.trackId)) continue;

    // transactionMonth が YYYY-MM 形式でない行をスキップ
    if (
      typeof row.transactionMonth !== 'string' ||
      !/^\d{4}-\d{2}$/.test(row.transactionMonth)
    ) continue;

    // STREAMING_PLATFORM_MAP に含まれないサービスをスキップ（エラーなし）
    const platform = STREAMING_PLATFORM_MAP[row.service];
    if (!platform) continue;

    // (transactionMonth, trackId, platform) でグループ化して SUM
    const key = `${row.transactionMonth}|${row.trackId}|${platform}`;
    const qty = (typeof row.quantity === 'number' && isFinite(row.quantity))
      ? row.quantity
      : 0;

    if (groups.has(key)) {
      groups.get(key).streams += qty;
    } else {
      groups.set(key, {
        date:    row.transactionMonth + '-01',
        month:   row.transactionMonth,
        platform,
        trackId: row.trackId,
        streams: qty,
      });
    }
  }

  return Array.from(groups.values());
}

/**
 * sf_music_metrics へ UPSERT する。
 * ON CONFLICT(date, granularity, platform, track_id) DO UPDATE SET
 *   streams = excluded.streams,
 *   fetched_at = excluded.fetched_at
 * granularity は常に 'monthly'、import_source = 'csv'。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {Array<{ date, month, platform, trackId, streams }>} rows
 * @returns {{ written: number, errors: Array<{ row, reason }> }}
 */
export function writeMusicMetrics(db, rows) {
  let written = 0;
  const errors = [];

  const stmt = db.prepare(`
    INSERT INTO sf_music_metrics
      (date, month, granularity, platform, track_id, streams, import_source, fetched_at)
    VALUES (?, ?, 'monthly', ?, ?, ?, 'csv', datetime('now', 'localtime'))
    ON CONFLICT(date, granularity, platform, track_id) DO UPDATE SET
      streams    = excluded.streams,
      fetched_at = excluded.fetched_at
  `);

  for (const row of rows) {
    try {
      stmt.run(row.date, row.month, row.platform, row.trackId, row.streams);
      written++;
    } catch (e) {
      errors.push({ row, reason: e.message });
    }
  }

  return { written, errors };
}
