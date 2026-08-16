#!/usr/bin/env node
/**
 * jarvis/tools/run_soundrop_catalog_sync.mjs
 * Soundrop カタログ同期 CLI — 3段階安全フロー
 *
 * ─── 実行順序 ────────────────────────────────────────────────────────────
 *
 * [Step 1] Migration のみ適用（Token 不要・Soundrop 通信なし）
 *   node tools/run_soundrop_catalog_sync.mjs --migrate-only
 *
 * [Step 2] Dry-run（DB は完全 read-only・差分確認のみ）
 *   $env:SOUNDROP_TOKEN = Read-Host "Soundrop Token"
 *   node tools/run_soundrop_catalog_sync.mjs --dry-run
 *   Remove-Item Env:\SOUNDROP_TOKEN
 *
 * [Step 3] 実同期（dry-run 結果確認後）
 *   $env:SOUNDROP_TOKEN = Read-Host "Soundrop Token"
 *   node tools/run_soundrop_catalog_sync.mjs
 *   Remove-Item Env:\SOUNDROP_TOKEN
 *
 * ─── Token 取得方法 ──────────────────────────────────────────────────────
 *   1. soundrop.com にログイン
 *   2. Chrome DevTools > Network タブを開く
 *   3. ページ内の任意の API リクエストを選択
 *   4. Query String Parameters の "Token" の値をコピー
 *   5. 上記のように環境変数として渡す（.env への恒久保存は禁止）
 *
 * ─── 安全制約 ────────────────────────────────────────────────────────────
 *   --migrate-only : Soundrop 通信なし・Token 不要・schema/index 追加のみ
 *                    INSERT / UPDATE / DELETE しない
 *                    実行前に backups/ へ自動バックアップを作成
 *   --dry-run      : DB 完全 read-only（PRAGMA query_only = ON）
 *                    migration 済みであること（未適用は Step 1 を先に実行）
 *   実同期         : migration 適用済みの上でデータを書き込む
 */

import { copyFileSync, mkdirSync, existsSync }
  from 'node:fs';
import { resolve, dirname }
  from 'node:path';
import { fileURLToPath }
  from 'node:url';
import { DatabaseSync }
  from 'node:sqlite';

import { createDb, createDbReadOnly, isSoundropMigrationApplied, DEFAULT_DB_PATH }
  from '../data/db.js';
import { fetchAllReleases, fetchAllTracks, fetchReleaseDetail, verifyToken }
  from '../sync/soundrop_client.mjs';
import { normalizeReleaseListItem, normalizeReleaseDetail, normalizeTrack }
  from '../sync/catalog_normalizer.mjs';
import { loadDbReleases, loadDbTracks, loadDbReleaseTracks,
         diffReleases, diffTracks, diffReleaseTracks }
  from '../sync/catalog_diff.mjs';
import { applyDiff }
  from '../sync/catalog_writer.mjs';

const __dirname     = dirname(fileURLToPath(import.meta.url));
const BACKUPS_DIR   = resolve(__dirname, '../backups');
const isMigrateOnly = process.argv.includes('--migrate-only');
const isDryRun      = process.argv.includes('--dry-run');
const token         = process.env.SOUNDROP_TOKEN;
const sep           = '='.repeat(64);

// ── Token 確認（--migrate-only は Token 不要） ──────────────────────────
if (!isMigrateOnly && !token) {
  console.error('');
  console.error('エラー: SOUNDROP_TOKEN が設定されていません。');
  console.error('');
  console.error('Token 取得方法:');
  console.error('  1. soundrop.com にログイン');
  console.error('  2. Chrome DevTools > Network タブを開く');
  console.error('  3. ページ内の任意の API リクエストを選択');
  console.error('  4. Query String Parameters の "Token" の値をコピー');
  console.error('');
  console.error('PowerShell 7 での実行方法:');
  console.error('  $env:SOUNDROP_TOKEN = Read-Host "Soundrop Token"');
  console.error('  node tools/run_soundrop_catalog_sync.mjs --dry-run');
  console.error('  Remove-Item Env:\\SOUNDROP_TOKEN');
  console.error('');
  console.error('注意: Token を .env・DB・ログへ保存しないこと（セッション限定）。');
  process.exit(1);
}

// ══════════════════════════════════════════════════════════════════════════
// --migrate-only: Phase 16 migration のみ適用（Token 不要・Soundrop 通信なし）
// ══════════════════════════════════════════════════════════════════════════

/** sf_releases / sf_tracks / sf_release_tracks の行数スナップショット */
function snapshotRowCounts(db) {
  return {
    sf_releases:       db.prepare('SELECT COUNT(*) AS n FROM sf_releases').get().n,
    sf_tracks:         db.prepare('SELECT COUNT(*) AS n FROM sf_tracks').get().n,
    sf_release_tracks: db.prepare('SELECT COUNT(*) AS n FROM sf_release_tracks').get().n,
    sf_revenue:        db.prepare('SELECT COUNT(*) AS n FROM sf_revenue').get().n,
  };
}

/** WAL をチェックポイントしてからファイルをコピー → backupパスを返す */
function backupDb(dbPath) {
  // WAL をメインファイルへ書き込み
  const tmp = new DatabaseSync(dbPath);
  tmp.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  tmp.close();

  // タイムスタンプ（ローカル時刻）
  const now = new Date();
  const pad = n => String(n).padStart(2, '0');
  const ts  = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}_`
             + `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  const backupName = `business_data_${ts}_pre_phase16.db`;
  const backupPath = resolve(BACKUPS_DIR, backupName);

  mkdirSync(BACKUPS_DIR, { recursive: true });
  copyFileSync(dbPath, backupPath);

  return backupPath;
}

/** Phase 16 で追加した soundrop_* カラムとインデックスを検証 */
function validateSoundropSchema(db) {
  const releaseCols  = db.prepare('PRAGMA table_info(sf_releases)').all().map(c => c.name);
  const trackCols    = db.prepare('PRAGMA table_info(sf_tracks)').all().map(c => c.name);
  const relTrackCols = db.prepare('PRAGMA table_info(sf_release_tracks)').all().map(c => c.name);

  const expected = {
    sf_releases: [
      'soundrop_release_id', 'soundrop_status',
      'soundrop_artwork_file_id', 'soundrop_artwork_filename',
      'soundrop_label_name', 'soundrop_copyright_p', 'soundrop_copyright_c',
      'soundrop_language_id', 'soundrop_primary_style_id', 'soundrop_secondary_style_id',
      'soundrop_sale_start_date', 'soundrop_is_locked',
      'soundrop_is_canceled', 'soundrop_is_draft', 'soundrop_synced_at',
    ],
    sf_tracks: [
      'soundrop_track_id', 'soundrop_is_locked',
      'soundrop_is_fully_locked', 'soundrop_is_canceled', 'soundrop_synced_at',
    ],
    sf_release_tracks: ['soundrop_source_order'],
  };

  const missing = [];
  for (const col of expected.sf_releases) {
    if (!releaseCols.includes(col))  missing.push(`sf_releases.${col}`);
  }
  for (const col of expected.sf_tracks) {
    if (!trackCols.includes(col))    missing.push(`sf_tracks.${col}`);
  }
  for (const col of expected.sf_release_tracks) {
    if (!relTrackCols.includes(col)) missing.push(`sf_release_tracks.${col}`);
  }

  // Partial UNIQUE INDEX 確認
  const indexes = db.prepare(`
    SELECT name FROM sqlite_master
    WHERE type = 'index'
      AND name IN ('idx_sf_releases_soundrop_id','idx_sf_tracks_soundrop_id')
    ORDER BY name
  `).all().map(r => r.name);

  return { missing, indexes };
}

async function runMigrateOnly() {
  console.log(sep);
  console.log('SOUNDROP CATALOG SYNC — --migrate-only');
  console.log('Phase 16 migration のみ適用（Token 不要・Soundrop 通信なし）');
  console.log(sep);
  console.log('');

  const dbPath = DEFAULT_DB_PATH;

  // ── 1. 実 DB 存在確認 ──────────────────────────────────────────────────
  if (!existsSync(dbPath)) {
    console.error(`エラー: DB が見つかりません — ${dbPath}`);
    process.exitCode = 1;
    return;
  }

  // ── 2. migration 適用済みかチェック ───────────────────────────────────
  const checkDb = createDbReadOnly(dbPath);
  const alreadyApplied = isSoundropMigrationApplied(checkDb);
  checkDb.close();

  if (alreadyApplied) {
    console.log('✔ Phase 16 migration は既に適用済みです。再適用は不要です。');
    console.log('');
    console.log('次のステップ:');
    console.log('  $env:SOUNDROP_TOKEN = Read-Host "Soundrop Token"');
    console.log('  node tools/run_soundrop_catalog_sync.mjs --dry-run');
    console.log('  Remove-Item Env:\\SOUNDROP_TOKEN');
    return;
  }

  // ── 3. migration 前の行数スナップショット ─────────────────────────────
  console.log('migration 前の行数確認...');
  const preDb     = new DatabaseSync(dbPath);
  const preCounts = snapshotRowCounts(preDb);
  preDb.close();

  console.log('  sf_releases:       ' + preCounts.sf_releases + '件');
  console.log('  sf_tracks:         ' + preCounts.sf_tracks + '件');
  console.log('  sf_release_tracks: ' + preCounts.sf_release_tracks + '件');
  console.log('  sf_revenue:        ' + preCounts.sf_revenue + '件');
  console.log('');

  // ── 4. バックアップ作成 ────────────────────────────────────────────────
  process.stdout.write('バックアップ作成中... ');
  const backupPath = backupDb(dbPath);
  console.log(`完了`);
  console.log(`  → ${backupPath}`);
  console.log('');

  // ── 5. Phase 16 migration 適用 ─────────────────────────────────────────
  console.log('Phase 16 migration 適用中...');
  console.log('  (sf_releases / sf_tracks / sf_release_tracks に soundrop_* カラム追加)');
  const db = createDb(dbPath);   // migration が自動適用される
  console.log('  完了');
  console.log('');

  // ── 6. schema 検証 ─────────────────────────────────────────────────────
  console.log('schema 検証中...');
  const { missing, indexes } = validateSoundropSchema(db);

  if (missing.length > 0) {
    console.error('エラー: 以下のカラムが存在しません:');
    for (const col of missing) console.error(`  - ${col}`);
    process.exitCode = 1;
    return;
  }

  console.log('  ✔ 全 soundrop_* カラム確認済み (sf_releases:15, sf_tracks:5, sf_release_tracks:1)');
  console.log('  ✔ UNIQUE INDEX: ' + indexes.join(', '));
  console.log('');

  // ── 7. migration 後の行数確認（変化なし確認） ──────────────────────────
  console.log('migration 後の行数確認（既存データ保護確認）...');
  const postCounts = snapshotRowCounts(db);

  const rowsOk = (
    postCounts.sf_releases       === preCounts.sf_releases  &&
    postCounts.sf_tracks         === preCounts.sf_tracks    &&
    postCounts.sf_release_tracks === preCounts.sf_release_tracks &&
    postCounts.sf_revenue        === preCounts.sf_revenue
  );

  console.log('  sf_releases:       ' + preCounts.sf_releases + ' → ' + postCounts.sf_releases
    + (preCounts.sf_releases === postCounts.sf_releases ? '  ✔' : '  ✖ MISMATCH'));
  console.log('  sf_tracks:         ' + preCounts.sf_tracks + ' → ' + postCounts.sf_tracks
    + (preCounts.sf_tracks === postCounts.sf_tracks ? '  ✔' : '  ✖ MISMATCH'));
  console.log('  sf_release_tracks: ' + preCounts.sf_release_tracks + ' → ' + postCounts.sf_release_tracks
    + (preCounts.sf_release_tracks === postCounts.sf_release_tracks ? '  ✔' : '  ✖ MISMATCH'));
  console.log('  sf_revenue:        ' + preCounts.sf_revenue + ' → ' + postCounts.sf_revenue
    + (preCounts.sf_revenue === postCounts.sf_revenue ? '  ✔' : '  ✖ MISMATCH'));

  if (!rowsOk) {
    console.error('');
    console.error('エラー: migration 前後で行数が変化しました。バックアップから復元してください:');
    console.error(`  Copy-Item "${backupPath}" "${dbPath}"`);
    process.exitCode = 1;
    return;
  }
  console.log('');

  // ── 8. 完了レポート ────────────────────────────────────────────────────
  console.log(sep);
  console.log('Phase 16 migration 完了 — 既存データへの変更なし');
  console.log(sep);
  console.log('');
  console.log(`バックアップ: ${backupPath}`);
  console.log('');
  console.log('次のステップ — dry-run（Soundrop Token が必要）:');
  console.log('  $env:SOUNDROP_TOKEN = Read-Host "Soundrop Token"');
  console.log('  node tools/run_soundrop_catalog_sync.mjs --dry-run');
  console.log('  Remove-Item Env:\\SOUNDROP_TOKEN');
  console.log('');
  console.log('復元が必要な場合:');
  console.log(`  Copy-Item "${backupPath}" "${dbPath}"`);
}

// ══════════════════════════════════════════════════════════════════════════
// --dry-run / 実同期 共通フロー
// ══════════════════════════════════════════════════════════════════════════

async function run() {
  if (isMigrateOnly) {
    await runMigrateOnly();
    return;
  }

  console.log(sep);
  console.log(`SOUNDROP CATALOG SYNC — ${isDryRun ? 'DRY RUN' : '実同期'}`);
  console.log(sep);
  console.log('');

  // ── Token 検証 ─────────────────────────────────────────────────────────
  process.stdout.write('Token 検証中... ');
  const verify = await verifyToken(token);
  if (!verify.ok) {
    console.error('NG');
    console.error('');
    console.error('Token 検証失敗:');
    console.error(`  endpoint : ${verify.path}`);
    console.error(`  HTTP     : ${verify.httpStatus ?? 'network error (HTTP 接続不可)'}`);
    if (verify.summary) {
      console.error(`  response : ${verify.summary.slice(0, 120)}`);
    }
    console.error('');
    console.error('対処方法:');
    console.error('  1. soundrop.com に再ログインして新しい Token を取得してください。');
    console.error('  2. Token の先頭・末尾に余分なスペースや改行がないか確認してください。');
    console.error('  3. ネットワーク接続を確認してください。');
    // process.exit() をここで呼ぶと UV_HANDLE_CLOSING が発生する場合がある。
    // process.exitCode を設定して return することで、イベントループが
    // 残存ハンドルを自然にクリーンアップした後にプロセスが終了する。
    process.exitCode = 1;
    return;
  }
  console.log(`OK (${verify.summary})`);
  console.log('');

  // ── DB 接続 ────────────────────────────────────────────────────────────
  // dry-run: 読み取り専用で開く（migration なし・DB 変更ゼロ）
  // 実同期 : createDb() で migration を適用してから書き込む
  let db;
  if (isDryRun) {
    const roDb = createDbReadOnly();
    if (!isSoundropMigrationApplied(roDb)) {
      console.error('エラー: Phase 16 migration (soundrop_* カラム) が未適用です。');
      console.error('');
      console.error('先に --migrate-only を実行してください:');
      console.error('  node tools/run_soundrop_catalog_sync.mjs --migrate-only');
      process.exitCode = 1;
      return;
    }
    db = roDb;
    console.log('DB モード: 読み取り専用 (PRAGMA query_only = ON) — schema/rows 変更なし');
  } else {
    db = createDb();
    console.log('DB モード: 読み書き (migration 適用済み)');
  }
  console.log('');

  // ── 1. リリース一覧取得 ────────────────────────────────────────────────
  process.stdout.write('リリース一覧取得 (GET /content/release/all)...');
  const rawReleases = await fetchAllReleases(token, {
    onPage: ({ pageNumber, count }) =>
      process.stdout.write(` [p${pageNumber}:${count}件]`),
  });
  console.log(` → 計 ${rawReleases.length}件`);

  // ── 2. トラック一覧取得 ───────────────────────────────────────────────
  process.stdout.write('トラック一覧取得 (GET /content/track/all)...');
  const rawTracks = await fetchAllTracks(token, {
    onPage: ({ pageNumber, count }) =>
      process.stdout.write(` [p${pageNumber}:${count}件]`),
  });
  console.log(` → 計 ${rawTracks.length}件`);

  // ── 3. リリース詳細取得 ───────────────────────────────────────────────
  console.log(`\nリリース詳細取得 (GET /content/release?id=...) ${rawReleases.length}件:`);
  const releaseDetails = [];
  let detailErrors     = 0;

  for (const raw of rawReleases) {
    process.stdout.write(`  [${raw.releaseId}] "${raw.name}"... `);
    try {
      const detail     = await fetchReleaseDetail(token, raw.releaseId);
      const normalized = normalizeReleaseDetail(detail);
      releaseDetails.push(normalized);
      console.log(`OK  status=${normalized.soundrop_status}  date=${normalized.release_date ?? '-'}`);
    } catch (e) {
      console.log(`SKIP (${e.message.slice(0, 60)})`);
      detailErrors++;
    }
  }

  if (detailErrors > 0) {
    console.log(`  ⚠ 詳細取得エラー: ${detailErrors}件`);
  }
  console.log('');

  // ── 4. 正規化（リスト + 詳細のマージ） ───────────────────────────────
  const detailByReleaseId = new Map(releaseDetails.map(d => [d.soundrop_release_id, d]));

  const soundropReleases = rawReleases.map(r => {
    const listItem = normalizeReleaseListItem(r);
    const detail   = detailByReleaseId.get(r.releaseId);
    return detail ? { ...listItem, ...detail } : listItem;
  });

  const soundropTracks = rawTracks.map(normalizeTrack);

  // ── 5. DB 現状ロード ──────────────────────────────────────────────────
  const dbReleases  = loadDbReleases(db);
  const dbTracks    = loadDbTracks(db);
  const dbRelTracks = loadDbReleaseTracks(db);

  console.log('DB 現状:');
  console.log(`  sf_releases:       ${dbReleases.length}件`);
  console.log(`  sf_tracks:         ${dbTracks.length}件`);
  console.log(`  sf_release_tracks: ${dbRelTracks.length}件`);
  console.log('');

  // ── 6. diff 計算 ──────────────────────────────────────────────────────
  const releaseDiff = diffReleases(dbReleases, soundropReleases);
  const trackDiff   = diffTracks(dbTracks, soundropTracks);

  const wouldBeReleaseIdMap = new Map(
    releaseDiff.matched.map(({ db: dbRel, soundrop }) =>
      [soundrop.soundrop_release_id, dbRel.id]),
  );
  const wouldBeTrackIdMap = new Map(
    trackDiff.matched.map(({ db: dbTrack, soundrop }) =>
      [soundrop.soundrop_track_id, dbTrack.id]),
  );

  const relTrackDiff = diffReleaseTracks(
    dbRelTracks,
    releaseDetails,
    wouldBeReleaseIdMap,
    wouldBeTrackIdMap,
  );

  // ── 7. レポート出力 ───────────────────────────────────────────────────
  console.log(sep);
  console.log(isDryRun ? 'DRY RUN 差分レポート' : '実同期前 差分確認');
  console.log(sep);
  console.log('');

  // Releases
  console.log('[Releases]');
  console.log(`  matched:   ${releaseDiff.matched.length}件`);
  console.log(`  new:       ${releaseDiff.new.length}件`);
  console.log(`  updated:   ${releaseDiff.updated.length}件`);
  console.log(`  skipped:   ${releaseDiff.skipped.length}件`);
  console.log(`  conflicts: ${releaseDiff.conflicts.length}件`);

  if (releaseDiff.updated.length > 0) {
    console.log('  --- 変更詳細 ---');
    for (const { db: dbRel, soundrop, changes } of releaseDiff.updated) {
      console.log(`  更新: "${dbRel.title}" (id=${dbRel.id})`);
      for (const c of changes) {
        console.log(`    ${c.field}: ${c.from ?? 'null'} → ${c.to}`);
      }
    }
  }
  if (releaseDiff.new.length > 0) {
    console.log('  --- 新規 ---');
    for (const sr of releaseDiff.new) {
      console.log(`  NEW: "${sr.name}" (soundrop_id=${sr.soundrop_release_id}, type=${sr.release_type}, status=${sr.soundrop_status ?? '-'})`);
    }
  }
  console.log('');

  // Tracks
  console.log('[Tracks]');
  console.log(`  matched:   ${trackDiff.matched.length}件`);
  console.log(`  new:       ${trackDiff.new.length}件`);
  console.log(`  updated:   ${trackDiff.updated.length}件`);
  console.log(`  skipped:   ${trackDiff.skipped.length}件`);
  console.log(`  conflicts: ${trackDiff.conflicts.length}件`);

  if (trackDiff.skipped.length > 0) {
    console.log('  --- スキップ詳細 ---');
    for (const { reason, soundrop } of trackDiff.skipped) {
      console.log(`  SKIP: "${soundrop.name}" (${reason})`);
    }
  }
  if (trackDiff.new.length > 0) {
    console.log('  --- 新規 ---');
    for (const st of trackDiff.new) {
      console.log(`  NEW: "${st.name}" (soundrop_id=${st.soundrop_track_id}, isrc=${st.isrc ?? '-'})`);
    }
  }
  if (trackDiff.updated.length > 0) {
    console.log('  --- 変更詳細 ---');
    for (const { db: dbTrack, soundrop, changes } of trackDiff.updated) {
      console.log(`  更新: "${dbTrack.title}" (id=${dbTrack.id})`);
      for (const c of changes) {
        console.log(`    ${c.field}: ${c.from ?? 'null'} → ${c.to}`);
      }
    }
  }
  console.log('');

  // Release-Track Relations
  console.log('[Release-Track Relations]');
  console.log(`  DB 既存:               ${dbRelTracks.length}件`);
  console.log(`  追加予定（既存ID）:    ${relTrackDiff.toAdd.length}件`);
  console.log(`  source_order 更新予定: ${relTrackDiff.toUpdateOrder.length}件`);
  console.log(`  conflicts:             ${relTrackDiff.conflicts.length}件`);
  if (relTrackDiff.pendingNewRelease.length > 0) {
    console.log(`  新規リリースのリレーション（実同期後に処理）: ${relTrackDiff.pendingNewRelease.length}件`);
  }
  if (relTrackDiff.pendingNewTrack.length > 0) {
    console.log(`  新規トラックのリレーション（実同期後に処理）: ${relTrackDiff.pendingNewTrack.length}件`);
  }
  console.log('');

  // ── 8. dry-run 終了 または 実同期 ────────────────────────────────────
  if (isDryRun) {
    console.log(sep);
    console.log('DRY RUN 完了 — DB への書き込みは行いませんでした。');
    console.log('実同期する場合:');
    console.log('  $env:SOUNDROP_TOKEN = Read-Host "Soundrop Token"');
    console.log('  node tools/run_soundrop_catalog_sync.mjs');
    console.log('  Remove-Item Env:\\SOUNDROP_TOKEN');
    console.log(sep);
    return;
  }

  // 実同期
  console.log('DB に書き込み中...');
  const stats = applyDiff(db, { releases: releaseDiff, tracks: trackDiff }, releaseDetails, dbRelTracks);
  console.log('完了');
  console.log('');
  console.log('[同期結果]');
  console.log(`  リリース更新: ${stats.releasesUpdated}件`);
  console.log(`  リリース新規: ${stats.releasesInserted}件`);
  console.log(`  トラック更新: ${stats.tracksUpdated}件`);
  console.log(`  トラック新規: ${stats.tracksInserted}件`);
  console.log(`  リレーション追加: ${stats.relationsAdded}件`);
  console.log(`  source_order更新: ${stats.relationsOrderUpdated}件`);
  console.log('');
  console.log(sep);
  console.log('同期完了。');
  console.log(sep);
}

run().catch(e => {
  console.error('\nエラー:', e.message);
  if (process.env.DEBUG) console.error(e.stack);
  process.exit(1);
});
