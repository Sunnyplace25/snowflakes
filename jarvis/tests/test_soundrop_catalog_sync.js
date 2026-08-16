/**
 * jarvis/tests/test_soundrop_catalog_sync.js
 * Soundrop Catalog Sync テスト
 *
 * テスト対象:
 *   N01-N04: catalog_normalizer — mapTypeName / deriveReleaseStatus / normalizeReleaseListItem / normalizeReleaseDetail
 *   T01-T04: catalog_normalizer — normalizeTrack
 *   D01-D06: catalog_diff      — diffReleases / diffTracks / diffReleaseTracks
 *   W01-W04: catalog_writer    — applyDiff (:memory: DB)
 *
 * 制約: 実 DB (business_data.db) は使用しない。:memory: のみ。
 */

import { test } from 'node:test';
import assert   from 'node:assert/strict';

import { extractTokenFromInput } from '../sync/soundrop_client.mjs';

import {
  mapTypeName,
  deriveReleaseStatus,
  toDbStatus,
  normalizeReleaseListItem,
  normalizeReleaseDetail,
  normalizeTrack,
} from '../sync/catalog_normalizer.mjs';

import {
  diffReleases,
  diffTracks,
  diffReleaseTracks,
} from '../sync/catalog_diff.mjs';

import { applyDiff } from '../sync/catalog_writer.mjs';
import { createDb }  from '../data/db.js';

// ─── フィクスチャ ──────────────────────────────────────────────────────────────

const RELEASE_LIST_ITEM = {
  releaseId: 1378380,
  name: 'In One Sky',
  releaseName: 'In One Sky',
  typeId: 3,
  typeName: 'Single',
  artistId: 915510,
  artistName: 'Snow flakes',
  labelName: 'Snow flakes',
  image: {
    fileId: '64f33906-9817-48f6-8ca4-417b6076edd6',
    filename: 'in_one_sky_3000x3000.jpg',
    isTemp: false,
    externalUrl: null,
    lastUpdateDate: '2026-07-14T16:00:34.98',
  },
  upc: '199999709107',
  isrc: null,
  releaseCatalog: '199999709107',
  isLockedForDistribution: true,
};

const RELEASE_DETAIL = {
  releaseId: 1378380,
  name: 'In One Sky',
  upc: '199999709107',
  catalog: '199999709107',
  releaseDate: '2026-08-30T00:00:00',
  saleStartDate: '2026-08-31T00:00:00',
  isDraft: false,
  isReleaseCanceledFromDistribution: false,
  isLockedForDistribution: true,
  image: {
    fileId: '64f33906-9817-48f6-8ca4-417b6076edd6',
    filename: 'in_one_sky_3000x3000.jpg',
    isTemp: false,
    externalUrl: null,
    lastUpdateDate: '2026-07-14T16:00:34.98',
  },
  copyrightP: '2026 Snow flakes',
  copyrightC: '2026 Snow flakes',
  languageId: 1,
  primaryMusicStyleId: 25,
  secondaryMusicStyleId: 63,
  tracks: [
    { trackId: 3006422, isrc: 'QZPJ32563425', name: 'In One Sky' },
    { trackId: 3007491, isrc: 'QZPJ32563426', name: '帰らないほどでもない' },
  ],
};

const TRACK_RAW = {
  trackId: 3006422,
  name: 'In One Sky',
  isrc: 'QZPJ32563425',
  version: null,
  artistName: 'Snow flakes',
  labelName: 'Snow flakes',
  isLockedForDistribution: true,
  isFullyLocked: false,
  isCanceledFromDistribution: false,
  releases: [{ releaseId: 1378380 }],
  // 除外対象（保存してはならないフィールド）
  lyrics: '月はまだ沈まないまま...',
  stereoAudioFile: { fileId: 'abc', externalUrl: 'https://s3.example.com/file.wav' },
};

// ─── N01: mapTypeName ─────────────────────────────────────────────────────────

test('N01: mapTypeName — Single/Album/EP/unknown', () => {
  assert.equal(mapTypeName('Single'),      'single');
  assert.equal(mapTypeName('Album'),       'album');
  assert.equal(mapTypeName('EP'),          'ep');
  assert.equal(mapTypeName('SINGLE'),      'single');   // 大文字
  assert.equal(mapTypeName('Compilation'), 'compilation');
  assert.equal(mapTypeName('Unknown'),     'single');   // 不明 → single
  assert.equal(mapTypeName(null),          'single');   // null → single
  assert.equal(mapTypeName(undefined),     'single');
  // typeId 数値は受け取らない（文字列変換されても single になるだけで安全）
});

// ─── N02: deriveReleaseStatus ─────────────────────────────────────────────────

test('N02: deriveReleaseStatus — 5パターン全検証', () => {
  const past   = new Date('2026-01-01T00:00:00');
  const future = new Date('2026-12-31T00:00:00');
  const today  = new Date('2026-08-16T00:00:00');

  // 1. canceled
  const canceled = { soundrop_is_canceled: 1, soundrop_is_draft: 0, release_date: '2026-01-01' };
  assert.equal(deriveReleaseStatus(canceled, today), 'canceled');

  // 2. isDraft（canceled より低優先）
  const draft = { soundrop_is_canceled: 0, soundrop_is_draft: 1, release_date: '2026-01-01' };
  assert.equal(deriveReleaseStatus(draft, today), 'unreleased');

  // 3. 未来 release_date → scheduled
  const sched = { soundrop_is_canceled: 0, soundrop_is_draft: 0, release_date: '2026-12-31' };
  assert.equal(deriveReleaseStatus(sched, today), 'scheduled');

  // 4. 過去・今日 → released
  const past1 = { soundrop_is_canceled: 0, soundrop_is_draft: 0, release_date: '2026-01-01' };
  assert.equal(deriveReleaseStatus(past1, today), 'released');

  const sameDay = { soundrop_is_canceled: 0, soundrop_is_draft: 0, release_date: '2026-08-16' };
  assert.equal(deriveReleaseStatus(sameDay, today), 'released');

  // 5. release_date なし
  const noDate = { soundrop_is_canceled: 0, soundrop_is_draft: 0, release_date: null };
  assert.equal(deriveReleaseStatus(noDate, today), 'unreleased');
});

// ─── N03: toDbStatus ──────────────────────────────────────────────────────────

test('N03: toDbStatus — CHECK 制約内の値に変換される', () => {
  assert.equal(toDbStatus('released'),   'released');
  assert.equal(toDbStatus('scheduled'),  'scheduled');
  assert.equal(toDbStatus('canceled'),   'private');    // CHECK 制約に 'canceled' はない
  assert.equal(toDbStatus('unreleased'), 'draft');
  assert.equal(toDbStatus('unknown'),    'draft');
  assert.equal(toDbStatus(null),         'draft');
});

// ─── N04: normalizeReleaseListItem ────────────────────────────────────────────

test('N04: normalizeReleaseListItem — フィールド抽出', () => {
  const result = normalizeReleaseListItem(RELEASE_LIST_ITEM);

  assert.equal(result.soundrop_release_id, 1378380);
  assert.equal(result.name,               'In One Sky');
  assert.equal(result.upc,                '199999709107');
  assert.equal(result.release_type,       'single');    // typeName='Single' → 'single'
  assert.equal(result.artist_name,        'Snow flakes');
  assert.equal(result.soundrop_label_name,'Snow flakes');
  assert.equal(result.soundrop_artwork_file_id, '64f33906-9817-48f6-8ca4-417b6076edd6');
  assert.equal(result.soundrop_is_locked, 1);

  // typeId / releaseTypeId は含まれてはならない
  assert.equal('typeId'        in result, false);
  assert.equal('releaseTypeId' in result, false);
});

// ─── N05: normalizeReleaseDetail ─────────────────────────────────────────────

test('N05: normalizeReleaseDetail — releaseDate 確定・除外フィールド確認', () => {
  const result = normalizeReleaseDetail(RELEASE_DETAIL);

  // release_date は releaseDate から
  assert.equal(result.release_date, '2026-08-30');

  // soundrop_sale_start_date は saleStartDate（release_date には影響しない）
  assert.equal(result.soundrop_sale_start_date, '2026-08-31');

  // soundrop_status は日付から導出（2026-08-30 > 今日→ scheduled）
  // deriveReleaseStatus は today=new Date() で呼ばれるので今日基準
  // 本テスト実行時（2026-08-16）では scheduled になる
  assert.equal(result.soundrop_status, 'scheduled');

  assert.equal(result.soundrop_is_draft,    0);
  assert.equal(result.soundrop_is_canceled, 0);
  assert.equal(result.soundrop_copyright_p, '2026 Snow flakes');
  assert.equal(result.soundrop_language_id, 1);

  // tracks[] は trackId / isrc / name / source_order のみ
  assert.equal(result.tracks.length, 2);
  assert.equal(result.tracks[0].soundrop_track_id, 3006422);
  assert.equal(result.tracks[0].source_order,       0);
  assert.equal(result.tracks[1].soundrop_track_id, 3007491);
  assert.equal(result.tracks[1].source_order,       1);

  // lyrics / audio URL は含まれてはならない
  assert.equal('lyrics' in result,         false);
  assert.equal('stereoAudioFile' in result, false);
});

// ─── T01: normalizeTrack ─────────────────────────────────────────────────────

test('T01: normalizeTrack — フィールド抽出・除外確認', () => {
  const result = normalizeTrack(TRACK_RAW);

  assert.equal(result.soundrop_track_id,        3006422);
  assert.equal(result.name,                     'In One Sky');
  assert.equal(result.isrc,                     'QZPJ32563425');
  assert.equal(result.soundrop_is_locked,       1);
  assert.equal(result.soundrop_is_fully_locked, 0);
  assert.equal(result.soundrop_is_canceled,     0);
  assert.deepEqual(result.release_ids,          [1378380]);

  // lyrics / audio URL / email / payment は含まれてはならない
  assert.equal('lyrics'          in result, false);
  assert.equal('stereoAudioFile' in result, false);
});

// ─── D01: diffReleases — UPC 一致でマッチ ────────────────────────────────────

test('D01: diffReleases — UPC 一致でマッチ・soundrop_release_id 追加を検出', () => {
  const dbReleases = [
    { id: 20, release_key: 'upc_199999709107', title: 'In One Sky', upc_ean: '199999709107',
      release_type: 'single', status: 'scheduled', soundrop_release_id: null,
      soundrop_status: null, soundrop_artwork_file_id: null, soundrop_synced_at: null },
  ];

  const sr = { ...normalizeReleaseListItem(RELEASE_LIST_ITEM),
               ...normalizeReleaseDetail(RELEASE_DETAIL) };
  const result = diffReleases(dbReleases, [sr]);

  assert.equal(result.matched.length, 1);
  assert.equal(result.new.length,     0);
  assert.equal(result.updated.length, 1);  // soundrop_release_id が null → 追加

  const change = result.updated[0].changes.find(c => c.field === 'soundrop_release_id');
  assert.ok(change);
  assert.equal(change.to, 1378380);
});

// ─── D02: diffReleases — 新規リリース検出 ────────────────────────────────────

test('D02: diffReleases — DB にない UPC は new として検出', () => {
  const sr = normalizeReleaseListItem({ ...RELEASE_LIST_ITEM, upc: '999000000001', releaseId: 9999 });
  const result = diffReleases([], [sr]);

  assert.equal(result.new.length,     1);
  assert.equal(result.matched.length, 0);
  assert.equal(result.new[0].soundrop_release_id, 9999);
});

// ─── D03: diffTracks — ISRC 一致でマッチ ─────────────────────────────────────

test('D03: diffTracks — ISRC 一致でマッチ・soundrop_track_id 追加を検出', () => {
  const dbTracks = [
    { id: 53, track_key: 'in_one_sky', title: 'In One Sky',
      isrc: 'QZPJ32563425', soundrop_track_id: null,
      soundrop_is_locked: null, soundrop_synced_at: null },
  ];

  const st = normalizeTrack(TRACK_RAW);
  const result = diffTracks(dbTracks, [st]);

  assert.equal(result.matched.length, 1);
  assert.equal(result.updated.length, 1);

  const change = result.updated[0].changes.find(c => c.field === 'soundrop_track_id');
  assert.ok(change);
  assert.equal(change.to, 3006422);
});

// ─── D04: diffTracks — ISRC/ID なし → skipped ────────────────────────────────

test('D04: diffTracks — ISRC も soundrop_track_id もない → skipped', () => {
  const st = normalizeTrack({ ...TRACK_RAW, trackId: null, isrc: null });
  st.soundrop_track_id = null;
  const result = diffTracks([], [st]);

  assert.equal(result.skipped.length, 1);
  assert.equal(result.new.length,     0);
});

// ─── D05: diffReleaseTracks — 新規リレーション検出 ───────────────────────────

test('D05: diffReleaseTracks — 新規リレーション追加を検出', () => {
  const releaseIdMap = new Map([[1378380, 20]]);  // soundrop_id → db_id
  const trackIdMap   = new Map([[3006422, 53]]);

  const detail = normalizeReleaseDetail(RELEASE_DETAIL);
  const result = diffReleaseTracks([], [detail], releaseIdMap, trackIdMap);

  // tracks[0] = 3006422 → db_id=53 がリレーション追加対象
  const added = result.toAdd.find(r => r.release_id === 20 && r.track_id === 53);
  assert.ok(added);
  assert.equal(added.soundrop_source_order, 0);  // 配列先頭
  assert.equal(added.track_number,          1);
});

// ─── D06: diffReleaseTracks — 未登録 release → pendingNewRelease ─────────────

test('D06: diffReleaseTracks — DB 未登録リリースは pendingNewRelease へ', () => {
  const releaseIdMap = new Map();  // 空（DB にまだない）
  const trackIdMap   = new Map([[3006422, 53]]);

  const detail = normalizeReleaseDetail(RELEASE_DETAIL);
  const result = diffReleaseTracks([], [detail], releaseIdMap, trackIdMap);

  assert.equal(result.toAdd.length,            0);
  assert.equal(result.pendingNewRelease.length, 1);
  assert.equal(result.pendingNewRelease[0].soundrop_release_id, 1378380);
});

// ─── W01: applyDiff — :memory: DB に新規リリースを挿入 ───────────────────────

test('W01: applyDiff — 新規リリース挿入', () => {
  const db = createDb(':memory:');

  const sr = { ...normalizeReleaseListItem(RELEASE_LIST_ITEM),
               ...normalizeReleaseDetail(RELEASE_DETAIL) };

  const releaseDiff = diffReleases([], [sr]);
  const trackDiff   = diffTracks([], []);

  const stats = applyDiff(db, { releases: releaseDiff, tracks: trackDiff }, [sr], []);

  assert.equal(stats.releasesInserted, 1);

  const inserted = db.prepare(`SELECT * FROM sf_releases WHERE soundrop_release_id = 1378380`).get();
  assert.ok(inserted);
  assert.equal(inserted.title,                'In One Sky');
  assert.equal(inserted.upc_ean,              '199999709107');
  assert.equal(inserted.release_type,         'single');
  assert.equal(inserted.soundrop_status,      'scheduled');
  assert.equal(inserted.soundrop_is_locked,   1);
  assert.equal(inserted.soundrop_copyright_p, '2026 Snow flakes');
  // status は CHECK 制約内の値
  assert.ok(['draft','scheduled','released','private'].includes(inserted.status));
});

// ─── W02: applyDiff — 新規トラック挿入 ──────────────────────────────────────

test('W02: applyDiff — 新規トラック挿入', () => {
  const db = createDb(':memory:');

  const st = normalizeTrack(TRACK_RAW);
  const releaseDiff = diffReleases([], []);
  const trackDiff   = diffTracks([], [st]);

  const stats = applyDiff(db, { releases: releaseDiff, tracks: trackDiff }, [], []);

  assert.equal(stats.tracksInserted, 1);

  const inserted = db.prepare(`SELECT * FROM sf_tracks WHERE soundrop_track_id = 3006422`).get();
  assert.ok(inserted);
  assert.equal(inserted.title,             'In One Sky');
  assert.equal(inserted.isrc,              'QZPJ32563425');
  assert.equal(inserted.soundrop_is_locked, 1);
});

// ─── W03: applyDiff — 既存リリースの soundrop_release_id を更新 ──────────────

test('W03: applyDiff — 既存リリースに soundrop_release_id を設定', () => {
  const db = createDb(':memory:');

  // 既存レコードを挿入（UPCのみ、soundrop_release_id は null）
  db.prepare(`
    INSERT INTO sf_releases (release_key, title, release_type, status, upc_ean)
    VALUES ('upc_199999709107', 'In One Sky', 'single', 'scheduled', '199999709107')
  `).run();
  const existing = db.prepare(`SELECT id FROM sf_releases WHERE upc_ean='199999709107'`).get();

  const dbReleases = [{ ...existing, upc_ean: '199999709107', soundrop_release_id: null,
                        soundrop_status: null, soundrop_artwork_file_id: null, soundrop_synced_at: null }];

  const sr = { ...normalizeReleaseListItem(RELEASE_LIST_ITEM),
               ...normalizeReleaseDetail(RELEASE_DETAIL) };

  const releaseDiff = diffReleases(dbReleases, [sr]);
  const trackDiff   = diffTracks([], []);

  applyDiff(db, { releases: releaseDiff, tracks: trackDiff }, [sr], []);

  const updated = db.prepare(`SELECT soundrop_release_id, soundrop_status FROM sf_releases WHERE upc_ean='199999709107'`).get();
  assert.equal(updated.soundrop_release_id, 1378380);
  assert.equal(updated.soundrop_status,     'scheduled');
});

// ─── P01-P06: extractTokenFromInput ──────────────────────────────────────────

test('P01: extractTokenFromInput — 正常なRequest URLからToken取得', () => {
  const url = 'https://api.soundrop.com/content/release/all?Token=abc123xyz&pageSize=50';
  assert.equal(extractTokenFromInput(url), 'abc123xyz');
});

test('P02: extractTokenFromInput — lowercase token パラメータ', () => {
  const url = 'https://api.soundrop.com/content/release/all?token=mySecretToken99';
  assert.equal(extractTokenFromInput(url), 'mySecretToken99');
});

test('P03: extractTokenFromInput — URLエンコードされたTokenを正しく復元', () => {
  const url = 'https://api.soundrop.com/content/release/all?Token=foo%2Bbar%3D%3D';
  assert.equal(extractTokenFromInput(url), 'foo+bar==');
});

test('P04: extractTokenFromInput — TokenなしURLはnullを返す', () => {
  const url = 'https://api.soundrop.com/content/release/all?pageSize=50';
  assert.equal(extractTokenFromInput(url), null);
});

test('P05: extractTokenFromInput — URL以外の文字列はそのまま返す（raw Token）', () => {
  assert.equal(extractTokenFromInput('rawTokenString123'), 'rawTokenString123');
});

test('P06: extractTokenFromInput — console.logを呼ばない（Tokenがログ出力されない）', () => {
  const logs = [];
  const orig = console.log;
  console.log = (...args) => logs.push(args.join(' '));
  try {
    extractTokenFromInput('https://api.soundrop.com/content/release/all?Token=secretABC');
    extractTokenFromInput('rawToken456');
    extractTokenFromInput('');
    extractTokenFromInput(null);
  } finally {
    console.log = orig;
  }
  assert.equal(logs.length, 0, `console.log が呼ばれた: ${logs.join(', ')}`);
});

// ─── W04: applyDiff — リレーション追加 ──────────────────────────────────────

test('W04: applyDiff — リリース+トラック同時挿入後にリレーション作成', () => {
  const db = createDb(':memory:');

  const sr = { ...normalizeReleaseListItem(RELEASE_LIST_ITEM),
               ...normalizeReleaseDetail(RELEASE_DETAIL) };
  const st = normalizeTrack(TRACK_RAW);

  const releaseDiff = diffReleases([], [sr]);
  const trackDiff   = diffTracks([], [st]);

  const stats = applyDiff(
    db,
    { releases: releaseDiff, tracks: trackDiff },
    [sr],
    [],
  );

  assert.equal(stats.releasesInserted, 1);
  assert.equal(stats.tracksInserted,   1);
  assert.equal(stats.relationsAdded,   1);  // In One Sky (track) → In One Sky (release)

  const rel = db.prepare(`
    SELECT rt.*, r.title as rel_title, t.title as trk_title
    FROM sf_release_tracks rt
    JOIN sf_releases r ON r.id = rt.release_id
    JOIN sf_tracks   t ON t.id = rt.track_id
  `).get();
  assert.ok(rel);
  assert.equal(rel.soundrop_source_order, 0);
  assert.equal(rel.track_number,          1);
});
