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

  // Phase 13: KDP Analytics テーブル追加
  const KDP_TABLES = [
    `CREATE TABLE IF NOT EXISTS kdp_books (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      asin TEXT NOT NULL UNIQUE,
      isbn TEXT, title TEXT NOT NULL, author TEXT,
      format TEXT CHECK (format IN ('ebook','paperback','hardcover','other') OR format IS NULL),
      memo TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_kdp_books_asin  ON kdp_books(asin)`,
    `CREATE INDEX IF NOT EXISTS idx_kdp_books_title ON kdp_books(title)`,
    `CREATE TABLE IF NOT EXISTS kdp_orders_daily (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL, book_id INTEGER NOT NULL REFERENCES kdp_books(id),
      marketplace TEXT NOT NULL, paid_units INTEGER, free_units INTEGER,
      fetched_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      UNIQUE(date, book_id, marketplace)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_kdp_orders_date ON kdp_orders_daily(date)`,
    `CREATE INDEX IF NOT EXISTS idx_kdp_orders_book ON kdp_orders_daily(book_id)`,
    `CREATE TABLE IF NOT EXISTS kdp_kenp_daily (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL, book_id INTEGER NOT NULL REFERENCES kdp_books(id),
      marketplace TEXT NOT NULL, kenp_read INTEGER,
      fetched_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      UNIQUE(date, book_id, marketplace)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_kdp_kenp_date ON kdp_kenp_daily(date)`,
    `CREATE INDEX IF NOT EXISTS idx_kdp_kenp_book ON kdp_kenp_daily(book_id)`,
    `CREATE TABLE IF NOT EXISTS kdp_royalties (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      royalty_month TEXT NOT NULL,
      book_id INTEGER NOT NULL REFERENCES kdp_books(id),
      marketplace TEXT NOT NULL,
      transaction_type TEXT NOT NULL DEFAULT 'royalty'
        CHECK (transaction_type IN ('royalty','ku_koll','refund','free','other')),
      units_sold INTEGER, units_refunded INTEGER, net_units INTEGER,
      royalty_amount REAL, currency TEXT NOT NULL DEFAULT 'JPY',
      fetched_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      UNIQUE(royalty_month, book_id, marketplace, transaction_type)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_kdp_royalties_month ON kdp_royalties(royalty_month)`,
    `CREATE INDEX IF NOT EXISTS idx_kdp_royalties_book  ON kdp_royalties(book_id)`,
    `CREATE TABLE IF NOT EXISTS kdp_payments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      payment_number TEXT NOT NULL, marketplace TEXT NOT NULL,
      sales_period TEXT, payment_status TEXT, payment_date TEXT,
      payment_method TEXT, net_earnings REAL, currency TEXT NOT NULL DEFAULT 'JPY',
      fx_rate REAL, payment_amount REAL, tax_withholding REAL,
      fetched_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      UNIQUE(payment_number, marketplace)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_kdp_payments_date ON kdp_payments(payment_date)`,
    `CREATE TABLE IF NOT EXISTS kdp_import_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      report_type TEXT NOT NULL
        CHECK (report_type IN ('orders','kenp','royalties','payments')),
      file_name TEXT, file_fingerprint TEXT, report_period TEXT,
      row_count INTEGER DEFAULT 0, imported_count INTEGER DEFAULT 0,
      skipped_count INTEGER DEFAULT 0, warning_count INTEGER DEFAULT 0,
      imported_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    )`,
    `CREATE TABLE IF NOT EXISTS sf_kdp_book_map (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      book_id INTEGER NOT NULL UNIQUE REFERENCES kdp_books(id),
      work_id INTEGER NOT NULL REFERENCES sf_works(id),
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_sf_kdp_map_work ON sf_kdp_book_map(work_id)`,
    `CREATE UNIQUE INDEX IF NOT EXISTS idx_sf_revenue_kdp
      ON sf_revenue(month, platform, work_id, currency)
      WHERE platform = 'kdp' AND work_id IS NOT NULL AND track_id IS NULL`,
  ];
  for (const sql of KDP_TABLES) {
    try { db.exec(sql); } catch (_) { /* already exists */ }
  }

  // Phase 14: note Workflow テーブル追加
  const NOTE_TABLES = [
    `CREATE TABLE IF NOT EXISTS sf_note_article (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      title              TEXT    NOT NULL,
      internal_key       TEXT    UNIQUE,
      article_type       TEXT,
      status             TEXT    NOT NULL DEFAULT 'idea'
        CHECK (status IN ('idea','draft','review','ready','scheduled','published','archived')),
      summary            TEXT,
      body_markdown      TEXT,
      tags               TEXT,
      magazine           TEXT,
      related_work_id    INTEGER REFERENCES sf_works(id),
      related_track_id   INTEGER REFERENCES sf_tracks(id),
      related_release_id INTEGER REFERENCES sf_releases(id),
      scheduled_date     TEXT,
      published_date     TEXT,
      note_url           TEXT,
      created_at         TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      updated_at         TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_sf_note_status    ON sf_note_article(status)`,
    `CREATE INDEX IF NOT EXISTS idx_sf_note_scheduled ON sf_note_article(scheduled_date)`,
    `CREATE INDEX IF NOT EXISTS idx_sf_note_type      ON sf_note_article(article_type)`,
  ];
  for (const sql of NOTE_TABLES) {
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

  // Phase 16: Soundrop Catalog Sync — sf_releases / sf_tracks / sf_release_tracks カラム追加
  // 既存レコードの id / status / title は一切変更しない。soundrop_* カラムのみ追加。
  const SOUNDROP_CATALOG_MIGRATIONS = [
    // sf_releases: Soundrop 識別子・同期メタデータ
    'ALTER TABLE sf_releases ADD COLUMN soundrop_release_id       INTEGER',
    'ALTER TABLE sf_releases ADD COLUMN soundrop_status           TEXT',
    'ALTER TABLE sf_releases ADD COLUMN soundrop_artwork_file_id  TEXT',
    'ALTER TABLE sf_releases ADD COLUMN soundrop_artwork_filename TEXT',
    'ALTER TABLE sf_releases ADD COLUMN soundrop_label_name       TEXT',
    'ALTER TABLE sf_releases ADD COLUMN soundrop_copyright_p      TEXT',
    'ALTER TABLE sf_releases ADD COLUMN soundrop_copyright_c      TEXT',
    'ALTER TABLE sf_releases ADD COLUMN soundrop_language_id      INTEGER',
    'ALTER TABLE sf_releases ADD COLUMN soundrop_primary_style_id   INTEGER',
    'ALTER TABLE sf_releases ADD COLUMN soundrop_secondary_style_id INTEGER',
    'ALTER TABLE sf_releases ADD COLUMN soundrop_sale_start_date  TEXT',
    'ALTER TABLE sf_releases ADD COLUMN soundrop_is_locked        INTEGER',
    'ALTER TABLE sf_releases ADD COLUMN soundrop_is_canceled      INTEGER',
    'ALTER TABLE sf_releases ADD COLUMN soundrop_is_draft         INTEGER',
    'ALTER TABLE sf_releases ADD COLUMN soundrop_synced_at        TEXT',
    // sf_tracks: Soundrop 識別子
    'ALTER TABLE sf_tracks ADD COLUMN soundrop_track_id        INTEGER',
    'ALTER TABLE sf_tracks ADD COLUMN soundrop_is_locked       INTEGER',
    'ALTER TABLE sf_tracks ADD COLUMN soundrop_is_fully_locked INTEGER',
    'ALTER TABLE sf_tracks ADD COLUMN soundrop_is_canceled     INTEGER',
    'ALTER TABLE sf_tracks ADD COLUMN soundrop_synced_at       TEXT',
    // sf_release_tracks: Soundrop 配列順
    'ALTER TABLE sf_release_tracks ADD COLUMN soundrop_source_order INTEGER',
  ];
  for (const sql of SOUNDROP_CATALOG_MIGRATIONS) {
    try { db.exec(sql); } catch (_) { /* column already exists */ }
  }
  // Partial unique index: NULL は除外するため既存 NULL 行が複数あっても安全
  try {
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sf_releases_soundrop_id
      ON sf_releases(soundrop_release_id) WHERE soundrop_release_id IS NOT NULL`);
  } catch (_) {}
  try {
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_sf_tracks_soundrop_id
      ON sf_tracks(soundrop_track_id) WHERE soundrop_track_id IS NOT NULL`);
  } catch (_) {}

  // Phase 17: Business Invoice Import テーブル追加
  const INVOICE_TABLES = [
    `CREATE TABLE IF NOT EXISTS business_invoice_imports (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      source_filename TEXT    NOT NULL,
      file_hash       TEXT    NOT NULL,
      imported_at     TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
      status          TEXT    NOT NULL DEFAULT 'completed'
        CHECK (status IN ('completed','partial','failed')),
      new_count       INTEGER NOT NULL DEFAULT 0,
      dup_count       INTEGER NOT NULL DEFAULT 0,
      skip_count      INTEGER NOT NULL DEFAULT 0,
      warn_count      INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE INDEX IF NOT EXISTS idx_bii_filename ON business_invoice_imports(source_filename)`,
    `CREATE INDEX IF NOT EXISTS idx_bii_hash     ON business_invoice_imports(file_hash)`,
    `CREATE TABLE IF NOT EXISTS business_invoices (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      import_id       INTEGER NOT NULL REFERENCES business_invoice_imports(id),
      client_name     TEXT    NOT NULL DEFAULT '株式会社オーテック',
      invoice_number  TEXT    NOT NULL,
      invoice_date    TEXT,
      due_date        TEXT,
      subtotal        INTEGER NOT NULL DEFAULT 0,
      tax             INTEGER NOT NULL DEFAULT 0,
      total           INTEGER NOT NULL DEFAULT 0,
      source_sheet    TEXT    NOT NULL,
      source_filename TEXT    NOT NULL,
      created_at      TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
      UNIQUE(invoice_number, source_sheet)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_bi_invoice_date ON business_invoices(invoice_date)`,
    `CREATE INDEX IF NOT EXISTS idx_bi_client       ON business_invoices(client_name)`,
    `CREATE INDEX IF NOT EXISTS idx_bi_import       ON business_invoices(import_id)`,
    `CREATE TABLE IF NOT EXISTS business_invoice_lines (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_id      INTEGER NOT NULL REFERENCES business_invoices(id),
      work_date       TEXT,
      description     TEXT    NOT NULL,
      quantity        REAL    NOT NULL DEFAULT 1,
      quantity_unit   TEXT    NOT NULL DEFAULT '日',
      unit_price      INTEGER NOT NULL DEFAULT 0,
      amount          INTEGER NOT NULL DEFAULT 0,
      category        TEXT    NOT NULL DEFAULT 'その他',
      job_id          TEXT,
      source_row      INTEGER NOT NULL,
      created_at      TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
      UNIQUE(invoice_id, source_row)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_bil_invoice   ON business_invoice_lines(invoice_id)`,
    `CREATE INDEX IF NOT EXISTS idx_bil_work_date ON business_invoice_lines(work_date)`,
    `CREATE INDEX IF NOT EXISTS idx_bil_category  ON business_invoice_lines(category)`,
  ];
  for (const sql of INVOICE_TABLES) {
    try { db.exec(sql); } catch (_) { /* already exists */ }
  }

  // Phase 18: Google Calendar 双方向同期テーブル追加
  const CALENDAR_TABLES = [
    `CREATE TABLE IF NOT EXISTS business_calendar_links (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_line_id     INTEGER NOT NULL REFERENCES business_invoice_lines(id),
      google_calendar_id  TEXT    NOT NULL,
      google_event_id     TEXT    NOT NULL,
      sync_status         TEXT    NOT NULL DEFAULT 'synced'
                            CHECK (sync_status IN ('synced', 'updated', 'orphaned')),
      last_synced_at      TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
      created_at          TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
      UNIQUE(invoice_line_id),
      UNIQUE(google_calendar_id, google_event_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_bcl_line   ON business_calendar_links(invoice_line_id)`,
    `CREATE INDEX IF NOT EXISTS idx_bcl_event  ON business_calendar_links(google_calendar_id, google_event_id)`,
    `CREATE TABLE IF NOT EXISTS business_calendar_sync_runs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      direction     TEXT    NOT NULL CHECK (direction IN ('push', 'pull')),
      calendar_id   TEXT,
      year_filter   TEXT,
      started_at    TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
      finished_at   TEXT,
      created_count INTEGER NOT NULL DEFAULT 0,
      updated_count INTEGER NOT NULL DEFAULT 0,
      skipped_count INTEGER NOT NULL DEFAULT 0,
      error_count   INTEGER NOT NULL DEFAULT 0,
      status        TEXT    NOT NULL DEFAULT 'running'
                      CHECK (status IN ('running', 'completed', 'failed')),
      notes         TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_bcsr_dir ON business_calendar_sync_runs(direction, started_at)`,
    `CREATE TABLE IF NOT EXISTS business_calendar_imports (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      google_calendar_id  TEXT    NOT NULL,
      google_event_id     TEXT    NOT NULL,
      title               TEXT    NOT NULL,
      start_date          TEXT,
      end_date            TEXT,
      start_datetime      TEXT,
      end_datetime        TEXT,
      is_all_day          INTEGER NOT NULL DEFAULT 0,
      description         TEXT,
      location            TEXT,
      import_status       TEXT    NOT NULL DEFAULT 'pending'
                            CHECK (import_status IN ('pending', 'imported', 'skipped')),
      imported_line_id    INTEGER REFERENCES business_invoice_lines(id),
      fetched_at          TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
      UNIQUE(google_calendar_id, google_event_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_bci_event  ON business_calendar_imports(google_calendar_id, google_event_id)`,
    `CREATE INDEX IF NOT EXISTS idx_bci_status ON business_calendar_imports(import_status)`,
  ];
  for (const sql of CALENDAR_TABLES) {
    try { db.exec(sql); } catch (_) { /* already exists */ }
  }
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

/**
 * DB を読み取り専用モードで開く（dry-run 専用）。
 * Migration は実行しない。PRAGMA query_only = ON でスキーマ・行の変更を禁止する。
 * 使用前に isSoundropMigrationApplied() でカラム存在を確認すること。
 *
 * @param {string} [dbPath]
 * @returns {import('node:sqlite').DatabaseSync}
 */
export function createDbReadOnly(dbPath = DEFAULT_DB_PATH) {
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA query_only = ON');
  return db;
}

/**
 * Phase 16 Soundrop Catalog Sync migration が適用済みか確認する。
 * soundrop_release_id カラムの存在を PRAGMA table_info で確認する（読み取りのみ）。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {boolean}
 */
export function isSoundropMigrationApplied(db) {
  const cols = db.prepare('PRAGMA table_info(sf_releases)').all();
  return cols.some(c => c.name === 'soundrop_release_id');
}
