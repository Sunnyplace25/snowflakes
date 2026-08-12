/**
 * jarvis/data/sf_seed.js
 * Snow flakes Analytics — マスターデータ初期投入
 *
 * 使い方:
 *   import { seed } from './sf_seed.js';
 *   seed(db);  // 既存レコードがある場合は何もしない（べき等）
 *
 * 注意:
 *   - production DB (business_data.db) / :memory: DB 双方で使用可
 *   - 既にレコードがある場合は INSERT OR IGNORE でスキップ
 *   - work_key / track_key は変更禁止（外部キー参照の基準になる）
 *   - タイトル変更は UPDATE で対応（work_key は変えない）
 */

'use strict';

// ── 作品マスター ──────────────────────────────────────────────────────────────

const WORKS = [
  {
    work_key:     'hitotsu_ooi_oto',
    title:        'ひとつ多い音',
    work_type:    'novel',
    status:       'active',
    published_at: null,   // なろう n9009lo — 正確な初公開日は更新時に追記
  },
  {
    work_key:     'undertone_game',
    title:        'Under tone',
    work_type:    'game',
    status:       'active',
    published_at: null,
  },
  {
    work_key:     'quietly_falling',
    title:        'Quietly Falling',
    work_type:    'short_series',
    status:       'active',
    published_at: null,   // Instagram 連載中
  },
  {
    work_key:     'moon_veil',
    title:        'Moon Veil',
    work_type:    'short_story',
    status:       'completed',
    published_at: null,
  },
];

// ── 楽曲マスター ──────────────────────────────────────────────────────────────

const TRACKS = [
  // Undertone EP
  { track_key: 'undertone',         title: 'Undertone',         release_date: null },
  { track_key: 'spring_waltz',      title: 'Spring Waltz',      release_date: null },
  { track_key: 'aftertone',         title: 'Aftertone',         release_date: null },
  // Little Snow シングル
  { track_key: 'little_snow',       title: 'Little Snow',       release_date: null },
  { track_key: 'oto_ga_kierumadewa', title: '音が消えるまでは', release_date: null },
  // Signal シングル
  { track_key: 'signal',            title: 'Signal',            release_date: null },
  { track_key: 'glass_no_heri',     title: 'グラスの縁',         release_date: null },
  // Rabbit シングル
  { track_key: 'rabbit',            title: 'Rabbit',            release_date: null },
  { track_key: 'happy_end_wa_iranai', title: 'ハッピーエンドはいらない', release_date: null },
  // 単曲
  { track_key: 'oita_oto',          title: '置いた音',           release_date: null },
  { track_key: 'sweets_track',      title: 'SWEETs',            release_date: null },
  { track_key: 'kokyuu_no_kyori',   title: '呼吸の距離',         release_date: null },
];

// ── 楽曲 ↔ 作品 リンク ───────────────────────────────────────────────────────
// track_key → [ { work_key, link_type } ]
// primary は track_id につき最大1件（partial UNIQUE INDEX で保証）

const TRACK_WORK_LINKS = [
  // Undertone EP → Under tone game が primary
  { track_key: 'undertone',           work_key: 'undertone_game',   link_type: 'primary' },
  { track_key: 'spring_waltz',        work_key: 'undertone_game',   link_type: 'primary' },
  { track_key: 'spring_waltz',        work_key: 'quietly_falling',  link_type: 'related' },
  { track_key: 'aftertone',           work_key: 'undertone_game',   link_type: 'primary' },

  // Little Snow → ひとつ多い音 ep.200
  { track_key: 'little_snow',         work_key: 'hitotsu_ooi_oto',  link_type: 'primary' },
  { track_key: 'oto_ga_kierumadewa',  work_key: 'hitotsu_ooi_oto',  link_type: 'primary' },

  // Signal / グラスの縁 → ひとつ多い音 ep.178, ep.133
  { track_key: 'signal',              work_key: 'hitotsu_ooi_oto',  link_type: 'primary' },
  { track_key: 'glass_no_heri',       work_key: 'hitotsu_ooi_oto',  link_type: 'primary' },

  // Rabbit → ひとつ多い音 ep.155, ep.76
  { track_key: 'rabbit',              work_key: 'hitotsu_ooi_oto',  link_type: 'primary' },
  { track_key: 'happy_end_wa_iranai', work_key: 'hitotsu_ooi_oto',  link_type: 'primary' },

  // 置いた音 → ひとつ多い音 ep.34 + Quietly Falling ep.08
  { track_key: 'oita_oto',            work_key: 'hitotsu_ooi_oto',  link_type: 'primary' },
  { track_key: 'oita_oto',            work_key: 'quietly_falling',  link_type: 'related' },

  // SWEETs → ひとつ多い音（ep.79周辺）+ Quietly Falling ep.05
  { track_key: 'sweets_track',        work_key: 'hitotsu_ooi_oto',  link_type: 'primary' },
  { track_key: 'sweets_track',        work_key: 'quietly_falling',  link_type: 'related' },

  // 呼吸の距離 → ひとつ多い音
  { track_key: 'kokyuu_no_kyori',     work_key: 'hitotsu_ooi_oto',  link_type: 'primary' },
];

// ── seed 関数 ─────────────────────────────────────────────────────────────────

/**
 * sf_works / sf_tracks / sf_track_work_links に初期データを投入する。
 * 既存レコード（work_key / track_key が一致するもの）はスキップする。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function seed(db) {
  // ─ works
  const insertWork = db.prepare(`
    INSERT OR IGNORE INTO sf_works (work_key, title, work_type, status, published_at)
    VALUES (?, ?, ?, ?, ?)
  `);
  for (const w of WORKS) {
    insertWork.run(w.work_key, w.title, w.work_type, w.status, w.published_at);
  }

  // ─ tracks
  const insertTrack = db.prepare(`
    INSERT OR IGNORE INTO sf_tracks (track_key, title, release_date)
    VALUES (?, ?, ?)
  `);
  for (const t of TRACKS) {
    insertTrack.run(t.track_key, t.title, t.release_date);
  }

  // ─ track_work_links（work_key / track_key を id に解決して挿入）
  const findWork  = db.prepare('SELECT id FROM sf_works  WHERE work_key  = ?');
  const findTrack = db.prepare('SELECT id FROM sf_tracks WHERE track_key = ?');
  const insertLink = db.prepare(`
    INSERT OR IGNORE INTO sf_track_work_links (track_id, work_id, link_type)
    VALUES (?, ?, ?)
  `);

  for (const link of TRACK_WORK_LINKS) {
    const workRow  = findWork.get(link.work_key);
    const trackRow = findTrack.get(link.track_key);
    if (!workRow)  throw new Error(`seed: work_key not found: ${link.work_key}`);
    if (!trackRow) throw new Error(`seed: track_key not found: ${link.track_key}`);
    insertLink.run(trackRow.id, workRow.id, link.link_type);
  }
}
