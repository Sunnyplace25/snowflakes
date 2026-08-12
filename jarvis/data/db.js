/**
 * jarvis/data/db.js
 * SQLite接続・スキーマ初期化（node:sqlite 使用 — 外部依存なし）
 *
 * 制約：
 * - DB接続はこのモジュール経由のみ
 * - 実データDB (business_data.db) はテストでは使用しない
 * - テストは createDb(':memory:') または専用パスを使用すること
 */

import { DatabaseSync } from 'node:sqlite';
import { readFileSync }  from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname   = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = resolve(__dirname, 'schema.sql');

/** 実データDBのデフォルトパス（テストでは使用禁止） */
export const DEFAULT_DB_PATH = resolve(__dirname, 'business_data.db');

// sf_tracks Phase 1.5 migrations
const SF_TRACKS_MIGRATIONS = [
  "ALTER TABLE sf_tracks ADD COLUMN status TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('unknown','unreleased','streaming_pending','released','private'))",
  "ALTER TABLE sf_tracks ADD COLUMN created_date TEXT",
  "ALTER TABLE sf_tracks ADD COLUMN duration_sec INTEGER",
  "ALTER TABLE sf_tracks ADD COLUMN isrc TEXT",
  "ALTER TABLE sf_tracks ADD COLUMN source_service TEXT CHECK (source_service IN ('suno','daw','other'))",
  "ALTER TABLE sf_tracks ADD COLUMN source_id TEXT",
  "ALTER TABLE sf_tracks ADD COLUMN source_url TEXT",
  "ALTER TABLE sf_tracks ADD COLUMN memo TEXT",
];

// sf_revenue Phase 2 migrations
const SF_REVENUE_MIGRATIONS = [
  "ALTER TABLE sf_revenue ADD COLUMN transaction_month TEXT",
  "ALTER TABLE sf_revenue ADD COLUMN quantity INTEGER NOT NULL DEFAULT 0",
];

function runMigrations(db) {
  // Phase 1.5: sf_tracks カラム追加
  for (const sql of SF_TRACKS_MIGRATIONS) {
    try { db.exec(sql); } catch (_) { /* column already exists */ }
  }

  // Phase 2: sf_revenue カラム追加
  for (const sql of SF_REVENUE_MIGRATIONS) {
    try { db.exec(sql); } catch (_) { /* column already exists */ }
  }

  // Phase 2: インデックス追加（冪等 — 何度実行しても安全）
  // 旧 idx_sf_revenue_csv_track は metrics_writer.js の冪等性のため維持する。
  // schema.sql で WHERE 条件を AND transaction_month IS NULL に絞り既存 DB に再適用。
  try { db.exec('DROP INDEX IF EXISTS idx_sf_revenue_csv_track'); } catch (_) {}
  try {
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_sf_revenue_csv_track
        ON sf_revenue(month, platform, track_id)
        WHERE import_source IN ('csv', 'api') AND track_id IS NOT NULL
          AND transaction_month IS NULL
    `);
  } catch (_) {}
  try {
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_sf_revenue_statement
        ON sf_revenue(month, transaction_month, platform, track_id)
        WHERE import_source IN ('csv', 'api') AND track_id IS NOT NULL
          AND transaction_month IS NOT NULL
    `);
  } catch (_) {}
  try {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_sf_revenue_transaction_month
        ON sf_revenue(transaction_month)
    `);
  } catch (_) {}
}

/**
 * SQLiteデータベースを開いてスキーマを適用し返す。
 *
 * @param {string} [dbPath] - DBファイルパス。省略時は DEFAULT_DB_PATH。
 *                            テストでは ':memory:' を渡すこと。
 * @returns {import('node:sqlite').DatabaseSync}
 */
export function createDb(dbPath = DEFAULT_DB_PATH) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');

  const schema = readFileSync(SCHEMA_PATH, 'utf8');
  db.exec(schema);

  runMigrations(db);

  return db;
}
