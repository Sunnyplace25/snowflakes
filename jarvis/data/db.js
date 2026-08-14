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

  // Phase 6: Instagram 分析テーブル追加（sf_instagram_account_daily / media / media_daily）
  // ※ schema.sql でも CREATE TABLE IF NOT EXISTS 済み。既存 DB への適用用。
  const INSTAGRAM_TABLES = [
    `CREATE TABLE IF NOT EXISTS sf_instagram_account_daily (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      followers_count INTEGER, follows_count INTEGER, media_count INTEGER,
      reach INTEGER, views INTEGER, accounts_engaged INTEGER, total_interactions INTEGER,
      likes INTEGER, comments INTEGER, shares INTEGER, saves INTEGER,
      follows_and_unfollows INTEGER, profile_links_taps INTEGER,
      import_source TEXT NOT NULL DEFAULT 'api' CHECK (import_source IN ('api','manual')),
      fetched_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      UNIQUE(date)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_sf_ig_account_date ON sf_instagram_account_daily(date)`,
    `CREATE TABLE IF NOT EXISTS sf_instagram_media (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instagram_media_id TEXT NOT NULL UNIQUE,
      media_type TEXT NOT NULL CHECK (media_type IN ('IMAGE','VIDEO','CAROUSEL_ALBUM','REELS')),
      media_product_type TEXT CHECK (media_product_type IN ('FEED','REELS') OR media_product_type IS NULL),
      published_at TEXT, caption TEXT, permalink TEXT,
      import_source TEXT NOT NULL DEFAULT 'api' CHECK (import_source IN ('api','manual')),
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_sf_ig_media_published ON sf_instagram_media(published_at)`,
    `CREATE INDEX IF NOT EXISTS idx_sf_ig_media_type ON sf_instagram_media(media_product_type)`,
    `CREATE TABLE IF NOT EXISTS sf_instagram_media_daily (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      instagram_media_id TEXT NOT NULL REFERENCES sf_instagram_media(instagram_media_id),
      date TEXT NOT NULL,
      like_count INTEGER, comments_count INTEGER, view_count INTEGER,
      shares_count INTEGER, saved_count INTEGER, reposts_count INTEGER,
      reach INTEGER, profile_visits INTEGER, avg_watch_time_ms INTEGER,
      import_source TEXT NOT NULL DEFAULT 'api' CHECK (import_source IN ('api','manual')),
      fetched_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      UNIQUE(instagram_media_id, date)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_sf_ig_media_daily_date ON sf_instagram_media_daily(date)`,
    `CREATE INDEX IF NOT EXISTS idx_sf_ig_media_daily_media ON sf_instagram_media_daily(instagram_media_id)`,
  ];
  for (const sql of INSTAGRAM_TABLES) {
    try { db.exec(sql); } catch (_) { /* already exists */ }
  }

  // Phase 7: YouTube チャンネル日次テーブル + トラフィックソーステーブル追加
  const YOUTUBE_TABLES = [
    `CREATE TABLE IF NOT EXISTS sf_youtube_channel_daily (
      id                        INTEGER PRIMARY KEY AUTOINCREMENT,
      date                      TEXT    NOT NULL,
      subscribers_count         INTEGER, subscribers_gained INTEGER, subscribers_lost INTEGER,
      views                     INTEGER, estimated_minutes_watched INTEGER,
      average_view_duration_sec INTEGER,
      impressions               INTEGER, ctr REAL,
      import_source TEXT NOT NULL DEFAULT 'api' CHECK (import_source IN ('api','manual')),
      fetched_at    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      UNIQUE(date)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_sf_yt_channel_date ON sf_youtube_channel_daily(date)`,
    `CREATE TABLE IF NOT EXISTS sf_youtube_traffic_sources (
      id                        INTEGER PRIMARY KEY AUTOINCREMENT,
      period_start              TEXT    NOT NULL,
      period_end                TEXT    NOT NULL,
      source_type               TEXT    NOT NULL,
      views                     INTEGER,
      estimated_minutes_watched INTEGER,
      fetched_at                TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
      UNIQUE(period_start, period_end, source_type)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_sf_yt_traffic_period ON sf_youtube_traffic_sources(period_start, period_end)`,
  ];
  for (const sql of YOUTUBE_TABLES) {
    try { db.exec(sql); } catch (_) { /* already exists */ }
  }

  // Phase 10: sf_sync_state テーブル追加（Ops 同期状態）
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sf_sync_state (
        source               TEXT    PRIMARY KEY,
        mode                 TEXT    NOT NULL DEFAULT 'manual'
          CHECK (mode IN ('auto', 'manual')),
        last_attempt_at      TEXT,
        last_success_at      TEXT,
        last_data_date       TEXT,
        status               TEXT    NOT NULL DEFAULT 'never_synced'
          CHECK (status IN ('fresh','stale','never_synced','unconfigured','error','manual_required')),
        last_error           TEXT,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        last_notified_at     TEXT,
        snoozed_until        TEXT,
        updated_at           TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
      )
    `);
  } catch (_) {}

  // Phase 12: X Analytics テーブル追加
  const X_TABLES = [
    `CREATE TABLE IF NOT EXISTS sf_x_tweet (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tweet_id TEXT NOT NULL UNIQUE,
      published_at TEXT,
      text_snippet TEXT,
      tweet_type TEXT NOT NULL DEFAULT 'tweet'
        CHECK (tweet_type IN ('tweet','reply','retweet','quote')),
      import_source TEXT NOT NULL DEFAULT 'csv'
        CHECK (import_source IN ('csv','manual')),
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_sf_x_tweet_published ON sf_x_tweet(published_at)`,
    `CREATE TABLE IF NOT EXISTS sf_x_tweet_metrics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      tweet_id TEXT NOT NULL REFERENCES sf_x_tweet(tweet_id),
      snapshot_date TEXT NOT NULL,
      impressions INTEGER, engagements INTEGER, retweets INTEGER,
      replies INTEGER, likes INTEGER, url_clicks INTEGER,
      profile_clicks INTEGER, detail_expands INTEGER,
      media_views INTEGER, media_engagements INTEGER,
      import_source TEXT NOT NULL DEFAULT 'csv'
        CHECK (import_source IN ('csv','manual')),
      fetched_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      UNIQUE(tweet_id, snapshot_date)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_sf_x_metrics_date  ON sf_x_tweet_metrics(snapshot_date)`,
    `CREATE INDEX IF NOT EXISTS idx_sf_x_metrics_tweet ON sf_x_tweet_metrics(tweet_id)`,
    `CREATE TABLE IF NOT EXISTS sf_x_account_daily (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL UNIQUE,
      followers_count INTEGER,
      import_source TEXT NOT NULL DEFAULT 'manual'
        CHECK (import_source IN ('api','csv','manual')),
      fetched_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_sf_x_account_date ON sf_x_account_daily(date)`,
  ];
  for (const sql of X_TABLES) {
    try { db.exec(sql); } catch (_) { /* already exists */ }
  }

  // Phase 4: sf_ga_event_daily テーブル追加（受け口）
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sf_ga_event_daily (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        date       TEXT    NOT NULL,
        event_name TEXT    NOT NULL,
        page_path  TEXT    NOT NULL DEFAULT '/',
        count      INTEGER NOT NULL DEFAULT 0,
        fetched_at TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
        UNIQUE(date, event_name, page_path)
      )
    `);
  } catch (_) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_sf_ga_event_date ON sf_ga_event_daily(date)'); } catch (_) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_sf_ga_event_name ON sf_ga_event_daily(event_name)'); } catch (_) {}
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
