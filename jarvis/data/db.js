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

function runMigrations(db, dbPath = ':memory:') {
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

  // Phase 19: GA4 流入元スナップショットテーブル追加（sf_ga_sources）
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sf_ga_sources (
        id               INTEGER PRIMARY KEY AUTOINCREMENT,
        date             TEXT    NOT NULL,
        session_source   TEXT    NOT NULL,
        session_medium   TEXT    NOT NULL,
        sessions         INTEGER DEFAULT 0,
        users            INTEGER DEFAULT 0,
        page_views       INTEGER DEFAULT 0,
        engaged_sessions INTEGER DEFAULT 0,
        fetched_at       TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
        UNIQUE(date, session_source, session_medium)
      )
    `);
  } catch (_) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_sf_ga_sources_date ON sf_ga_sources(date)'); } catch (_) {}
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_sf_ga_sources_source ON sf_ga_sources(session_source, session_medium)'); } catch (_) {}

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

  // Phase 20: work_records ↔ Google Calendar 同期テーブル追加
  // ベストエフォート設計: Calendar API 失敗時も work_records への書き込みは独立
  const WORK_CALENDAR_TABLES = [
    `CREATE TABLE IF NOT EXISTS work_calendar_links (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      work_record_id     INTEGER NOT NULL REFERENCES work_records(id) ON DELETE CASCADE,
      google_calendar_id TEXT    NOT NULL,
      google_event_id    TEXT,              -- API失敗時はNULL（pending/errorで保持）
      sync_status        TEXT    NOT NULL DEFAULT 'pending'
                           CHECK (sync_status IN ('pending', 'synced', 'error', 'orphaned')),
        -- pending  : 同期未実行 or リトライ待ち
        -- synced   : Calendarへの同期成功
        -- error    : API失敗（error_message に詳細、error_count でリトライ回数管理）
        -- orphaned : Calendar側イベントが削除済み（照合時に検出）
      error_message      TEXT,
      error_count        INTEGER NOT NULL DEFAULT 0,
      last_attempted_at  TEXT,
      last_synced_at     TEXT,
      created_at         TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
      updated_at         TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
      UNIQUE(work_record_id),
      UNIQUE(google_calendar_id, google_event_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_wcl_work_record ON work_calendar_links(work_record_id)`,
    `CREATE INDEX IF NOT EXISTS idx_wcl_sync_status ON work_calendar_links(sync_status)`,

    // Calendar 削除 Outbox: work_records 削除後の Calendar 側削除リトライ用
    // work_calendar_links は ON DELETE CASCADE で消えるため FK を持たない
    `CREATE TABLE IF NOT EXISTS calendar_delete_queue (
      id                 INTEGER PRIMARY KEY AUTOINCREMENT,
      google_calendar_id TEXT    NOT NULL,
      google_event_id    TEXT    NOT NULL,
      work_record_id     INTEGER,              -- 参照情報のみ（FK なし・削除後 NULL 可）
      status             TEXT    NOT NULL DEFAULT 'pending'
                           CHECK (status IN ('pending', 'done')),
      error_message      TEXT,
      retry_count        INTEGER NOT NULL DEFAULT 0,
      created_at         TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
      last_attempted_at  TEXT,
      completed_at       TEXT
    )`,
    `CREATE INDEX IF NOT EXISTS idx_cdq_status ON calendar_delete_queue(status)`,
  ];
  for (const sql of WORK_CALENDAR_TABLES) {
    try { db.exec(sql); } catch (_) { /* already exists */ }
  }

  // Phase 21: Google Calendar → JARVIS 逆方向同期 取り込み候補テーブル
  // work_records への自動 INSERT は行わない。候補の記録・レビュー管理のみ。
  const PULL_SYNC_TABLES = [
    `CREATE TABLE IF NOT EXISTS calendar_import_candidates (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,

      -- Calendar 識別情報
      google_calendar_id  TEXT    NOT NULL,
      google_event_id     TEXT    NOT NULL,

      -- イベント内容（必要最小限）
      event_date          TEXT,              -- YYYY-MM-DD
      start_datetime      TEXT,             -- 時間指定: ISO8601 / 終日: YYYY-MM-DD
      end_datetime        TEXT,
      is_all_day          INTEGER NOT NULL DEFAULT 0,
      title               TEXT,
      description         TEXT,
      event_updated_at    TEXT,             -- Calendar 側の updated フィールド
      etag                TEXT,             -- 変更検知用
      recurring_event_id  TEXT,             -- 繰り返しイベントの場合のみ

      -- 重複チェック（警告のみ・自動除外・結合はしない）
      duplicate_work_id   INTEGER,          -- 重複候補の work_record.id（FK なし・参照のみ）
      duplicate_reason    TEXT,

      -- レビュー状態
      status              TEXT    NOT NULL DEFAULT 'pending'
                            CHECK (status IN ('pending', 'imported', 'skipped', 'ignored', 'removed')),
        -- pending  : レビュー待ち
        -- imported : work_records に取り込み済み（将来フェーズ）
        -- skipped  : 今回スキップ（手動判断）
        -- ignored  : 以後スキャン対象外（定期予定など）
        -- removed  : Calendar 側で削除済み（スキャン時に不在を検出）

      imported_work_id    INTEGER,          -- 取り込んだ work_record.id（imported のとき）

      -- 時刻管理
      scanned_at          TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
      last_seen_at        TEXT    NOT NULL DEFAULT (datetime('now','localtime')),  -- 最後にスキャンで確認された日時
      updated_at          TEXT    NOT NULL DEFAULT (datetime('now','localtime')),

      UNIQUE(google_calendar_id, google_event_id)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_cic_status     ON calendar_import_candidates(status)`,
    `CREATE INDEX IF NOT EXISTS idx_cic_event_date ON calendar_import_candidates(event_date)`,
  ];
  for (const sql of PULL_SYNC_TABLES) {
    try { db.exec(sql); } catch (_) { /* already exists */ }
  }

  // Phase 22: Calendar → work_records 承認取り込み
  // work_calendar_links に時刻保持カラム追加
  // work_records の is_full_day は別経路（過去マイグレーション）で追加済み
  const PHASE22_MIGRATIONS = [
    `ALTER TABLE work_records ADD COLUMN is_full_day INTEGER NOT NULL DEFAULT 0 CHECK(is_full_day IN (0,1))`,
    `ALTER TABLE work_calendar_links ADD COLUMN start_datetime TEXT`,
    `ALTER TABLE work_calendar_links ADD COLUMN end_datetime TEXT`,
  ];
  for (const sql of PHASE22_MIGRATIONS) {
    try { db.exec(sql); } catch (_) { /* already exists */ }
  }

  // Phase 23: work_calendar_links に起点情報を追加
  //   import_origin = 'jarvis'   : JARVIS で work_record を作成 → Calendar へ送った予定
  //   import_origin = 'calendar' : Google Calendar から importCalendarCandidate で取り込んだ予定
  const PHASE23_MIGRATIONS = [
    `ALTER TABLE work_calendar_links ADD COLUMN import_origin TEXT NOT NULL DEFAULT 'jarvis' CHECK(import_origin IN ('jarvis','calendar'))`,
  ];
  for (const sql of PHASE23_MIGRATIONS) {
    try { db.exec(sql); } catch (_) { /* already exists */ }
  }

  // Phase 23 データ補正: calendar_import_candidates.status='imported' のイベントに紐づく
  //   work_calendar_links を 'calendar' 起点として更新する（冪等・安全）
  try {
    db.exec(`
      UPDATE work_calendar_links
         SET import_origin = 'calendar'
       WHERE google_event_id IN (
         SELECT google_event_id FROM calendar_import_candidates WHERE status = 'imported'
       )
         AND import_origin = 'jarvis'
    `);
  } catch (_) { /* calendar_import_candidates が未存在の環境（古い DB）は無視 */ }

  // Phase 24: sf_artist_profiles platform CHECK 拡張 (tidal, qobuz 追加)
  // SQLite は CHECK 制約の変更 (MODIFY COLUMN) 不可のため、テーブル再構築が必要。
  // sf_artist_profiles は他テーブルから FK 参照されていないため安全に再構築できる。
  // 冪等判定: sqlite_master の CREATE TABLE 文に 'tidal' が含まれているか確認する。
  try {
    const row = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='sf_artist_profiles'"
    ).get();
    if (row && !row.sql.includes("'tidal'")) {
      db.exec('PRAGMA foreign_keys = OFF');
      try {
        db.exec(`
          CREATE TABLE sf_artist_profiles_v2 (
            id                 INTEGER PRIMARY KEY AUTOINCREMENT,
            artist_key         TEXT    NOT NULL,
            artist_name        TEXT    NOT NULL,
            platform           TEXT    NOT NULL
              CHECK (platform IN ('spotify','apple_music','amazon_music','youtube_music','tidal','qobuz','other')),
            platform_artist_id TEXT,
            artist_page_url    TEXT,
            profile_status     TEXT    NOT NULL DEFAULT 'unknown'
              CHECK (profile_status IN ('unknown','active','pending','unclaimed','inactive')),
            claimed            INTEGER NOT NULL DEFAULT 0 CHECK (claimed IN (0,1)),
            last_checked_at    TEXT,
            memo               TEXT,
            created_at         TEXT NOT NULL DEFAULT (datetime('now','localtime')),
            updated_at         TEXT NOT NULL DEFAULT (datetime('now','localtime')),
            UNIQUE(artist_key, platform)
          )
        `);
        db.exec(`INSERT INTO sf_artist_profiles_v2 SELECT * FROM sf_artist_profiles`);
        db.exec(`DROP TABLE sf_artist_profiles`);
        db.exec(`ALTER TABLE sf_artist_profiles_v2 RENAME TO sf_artist_profiles`);
      } finally {
        db.exec('PRAGMA foreign_keys = ON');
      }
    }
  } catch (_) { /* 既にマイグレーション済み、または sf_artist_profiles 未存在の場合はスキップ */ }

  // Phase 24: sf_platform_issues テーブル追加（配信サイト問題管理）
  const PLATFORM_ISSUES_TABLES = [
    `CREATE TABLE IF NOT EXISTS sf_platform_issues (
      id              INTEGER PRIMARY KEY AUTOINCREMENT,
      entity_type     TEXT    NOT NULL
        CHECK (entity_type IN ('artist','release','track')),
      entity_id       INTEGER NOT NULL,
      platform        TEXT    NOT NULL,
      issue_type      TEXT    NOT NULL DEFAULT 'other'
        CHECK (issue_type IN ('mixed_artist','wrong_link','name_variant','not_reflected','other')),
      issue_status    TEXT    NOT NULL DEFAULT 'open'
        CHECK (issue_status IN ('open','requested','resolved','wont_fix')),
      opened_at       TEXT,
      requested_at    TEXT,
      resolved_at     TEXT,
      last_checked_at TEXT,
      related_url     TEXT,
      memo            TEXT,
      created_at      TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      updated_at      TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    )`,
    `CREATE INDEX IF NOT EXISTS idx_sf_platform_issues_entity   ON sf_platform_issues(entity_type, entity_id)`,
    `CREATE INDEX IF NOT EXISTS idx_sf_platform_issues_status   ON sf_platform_issues(issue_status)`,
    `CREATE INDEX IF NOT EXISTS idx_sf_platform_issues_platform ON sf_platform_issues(platform)`,
  ];
  for (const sql of PLATFORM_ISSUES_TABLES) {
    try { db.exec(sql); } catch (_) { /* already exists */ }
  }

  // Phase 28: 作品公開URL・原稿アーカイブ管理テーブル追加
  const PHASE28_TABLES = [
    `CREATE TABLE IF NOT EXISTS sf_work_publications (
      id                  INTEGER PRIMARY KEY AUTOINCREMENT,
      work_id             INTEGER NOT NULL REFERENCES sf_works(id),
      platform            TEXT    NOT NULL
        CHECK (platform IN ('narou','kakuyomu','note','pixiv','hp','other')),
      platform_work_id    TEXT,
      public_url          TEXT,
      publication_status  TEXT    NOT NULL DEFAULT 'published'
        CHECK (publication_status IN ('published','unpublished','private','deleted')),
      published_at        TEXT,
      last_checked_at     TEXT,
      memo                TEXT,
      created_at          TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
      UNIQUE(work_id, platform)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_sf_work_pub_work   ON sf_work_publications(work_id)`,
    `CREATE INDEX IF NOT EXISTS idx_sf_work_pub_status ON sf_work_publications(publication_status)`,
    `CREATE TABLE IF NOT EXISTS sf_work_archives (
      id                INTEGER PRIMARY KEY AUTOINCREMENT,
      work_id           INTEGER NOT NULL REFERENCES sf_works(id),
      archive_type      TEXT    NOT NULL
        CHECK (archive_type IN ('submission','publication','revision','backup','other')),
      version_label     TEXT,
      original_filename TEXT,
      archived_filename TEXT    NOT NULL,
      file_path         TEXT    NOT NULL,
      sha256            TEXT    NOT NULL,
      file_size_bytes   INTEGER NOT NULL,
      archived_at       TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
      memo              TEXT,
      UNIQUE(work_id, sha256, archive_type)
    )`,
    `CREATE INDEX IF NOT EXISTS idx_sf_work_arch_work ON sf_work_archives(work_id)`,
    `CREATE INDEX IF NOT EXISTS idx_sf_work_arch_type ON sf_work_archives(archive_type)`,
  ];
  for (const sql of PHASE28_TABLES) {
    try { db.exec(sql); } catch (_) { /* already exists */ }
  }

  // Phase 28 Extension: title_provisional + sf_work_publications 'hp' + ICE BREAKER 修正
  phase28ExtensionMigration(db);

  // Phase 29: sf_works.display_order カラム追加・初期値設定
  phase29Migration(db);

  // Phase 30: sf_work_archives 再構築（direct_input/literary_award/version_date 追加）+ sf_works 新カラム
  // ★ :memory: DB（テスト用）は自動適用。実DBファイルへの適用は承認後に手動呼び出しすること。
  if (dbPath === ':memory:') {
    phase30Migration(db);
  }

  // Phase 31: sf_sync_source_settings テーブル追加（source の enabled/disabled 管理）
  // ★ :memory: DB（テスト用）は自動適用。実DBファイルへの適用は承認後に手動呼び出しすること。
  if (dbPath === ':memory:') {
    phase31Migration(db);
  }

  // Phase 32: 競合アカウント分析テーブル追加
  // schema.sql に CREATE TABLE IF NOT EXISTS 済み。既存 DB への適用 + 初期設定データ投入用。
  phase32Migration(db);

  // Phase 33: work_records 物販詳細カラム追加
  // 既存 expense カラムは保持・既存データは破壊しない。
  phase33Migration(db);

  // Phase 34: work_records 出品日・売却日・仕入日カラム追加
  phase34Migration(db);

  // Phase 25: sf_artist_profiles platform CHECK 拡張 (deezer 等 22 platform 追加)
  // 冪等判定: sqlite_master の CREATE TABLE 文に 'deezer' が含まれているか確認する。
  try {
    const row = db.prepare(
      "SELECT sql FROM sqlite_master WHERE type='table' AND name='sf_artist_profiles'"
    ).get();
    if (row && !row.sql.includes("'deezer'")) {
      db.exec('PRAGMA foreign_keys = OFF');
      try {
        db.exec(`
          CREATE TABLE sf_artist_profiles_v3 (
            id                 INTEGER PRIMARY KEY AUTOINCREMENT,
            artist_key         TEXT    NOT NULL,
            artist_name        TEXT    NOT NULL,
            platform           TEXT    NOT NULL
              CHECK (platform IN (
                'spotify','apple_music','amazon_music','youtube_music','tidal','qobuz',
                'deezer','pandora','iheartradio','tiktok','facebook_instagram','anghami',
                'boomplay','ayoba','netease','tencent','claro_musica','peloton',
                'awa','line_music','kkbox','lissen','audiomack','audible_magic',
                'nuuday','flo','snapchat','seven_digital','other'
              )),
            platform_artist_id TEXT,
            artist_page_url    TEXT,
            profile_status     TEXT    NOT NULL DEFAULT 'unknown'
              CHECK (profile_status IN ('unknown','active','pending','unclaimed','inactive')),
            claimed            INTEGER NOT NULL DEFAULT 0 CHECK (claimed IN (0,1)),
            last_checked_at    TEXT,
            memo               TEXT,
            created_at         TEXT NOT NULL DEFAULT (datetime('now','localtime')),
            updated_at         TEXT NOT NULL DEFAULT (datetime('now','localtime')),
            UNIQUE(artist_key, platform)
          )
        `);
        db.exec(`INSERT INTO sf_artist_profiles_v3 SELECT * FROM sf_artist_profiles`);
        db.exec(`DROP TABLE sf_artist_profiles`);
        db.exec(`ALTER TABLE sf_artist_profiles_v3 RENAME TO sf_artist_profiles`);
      } finally {
        db.exec('PRAGMA foreign_keys = ON');
      }
    }
  } catch (_) { /* 既にマイグレーション済み、または sf_artist_profiles 未存在の場合はスキップ */ }
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

  runMigrations(db, dbPath);

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

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 28 Extension: title_provisional / sf_work_publications 'hp' / ICE BREAKER 修正
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Phase 28 拡張マイグレーション。runMigrations から自動呼び出し済み。
 * テストから直接呼ぶことも可（冪等）。
 *
 * 1. sf_works.title_provisional カラム追加（PRAGMA table_info で存在確認）
 * 2. sf_work_publications テーブル再構築（platform CHECK に 'hp' 追加）
 *    - BEGIN TRANSACTION / COMMIT + エラー時 ROLLBACK
 *    - 移行カラムを明示（SELECT * 不使用）
 *    - COMMIT 後に PRAGMA foreign_key_check
 * 3. ICE BREAKER work_type 修正（work_key 指定・冪等）
 *
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function phase28ExtensionMigration(db) {
  // ─── 1. title_provisional カラム追加（冪等）────────────────────────────────
  const sfWorksCols = db.prepare('PRAGMA table_info(sf_works)').all();
  if (!sfWorksCols.some(c => c.name === 'title_provisional')) {
    db.exec(
      "ALTER TABLE sf_works ADD COLUMN title_provisional INTEGER NOT NULL DEFAULT 0 " +
      "CHECK (title_provisional IN (0, 1))"
    );
  }

  // ─── 2. sf_work_publications 再構築（'hp' 追加、冪等）─────────────────────
  // CHECK 制約は ALTER TABLE で変更不可のためテーブル再構築。
  // sqlite_master の CREATE 文に 'hp' が含まれていれば適用済みとして skip する。
  const pubRow = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='sf_work_publications'"
  ).get();
  if (pubRow && !pubRow.sql.includes("'hp'")) {
    db.exec('PRAGMA foreign_keys = OFF');
    let committed = false;
    try {
      db.exec('BEGIN TRANSACTION');

      db.exec(`
        CREATE TABLE sf_work_publications_new (
          id                  INTEGER PRIMARY KEY AUTOINCREMENT,
          work_id             INTEGER NOT NULL REFERENCES sf_works(id),
          platform            TEXT    NOT NULL
            CHECK (platform IN ('narou','kakuyomu','note','pixiv','hp','other')),
          platform_work_id    TEXT,
          public_url          TEXT,
          publication_status  TEXT    NOT NULL DEFAULT 'published'
            CHECK (publication_status IN ('published','unpublished','private','deleted')),
          published_at        TEXT,
          last_checked_at     TEXT,
          memo                TEXT,
          created_at          TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
          UNIQUE(work_id, platform)
        )
      `);

      // 移行対象カラムを明示（カラム順変更・追加に影響されない）
      db.exec(`
        INSERT INTO sf_work_publications_new
          (id, work_id, platform, platform_work_id, public_url,
           publication_status, published_at, last_checked_at, memo, created_at)
        SELECT
          id, work_id, platform, platform_work_id, public_url,
          publication_status, published_at, last_checked_at, memo, created_at
        FROM sf_work_publications
      `);

      db.exec('DROP TABLE sf_work_publications');
      db.exec('ALTER TABLE sf_work_publications_new RENAME TO sf_work_publications');

      db.exec('CREATE INDEX IF NOT EXISTS idx_sf_work_pub_work   ON sf_work_publications(work_id)');
      db.exec('CREATE INDEX IF NOT EXISTS idx_sf_work_pub_status ON sf_work_publications(publication_status)');

      db.exec('COMMIT');
      committed = true;

      // FK 整合性チェック（COMMIT 後）
      const fkErrors = db.prepare('PRAGMA foreign_key_check(sf_work_publications)').all();
      if (fkErrors.length > 0) {
        throw new Error(`foreign_key_check failed after sf_work_publications rebuild: ${JSON.stringify(fkErrors)}`);
      }
    } catch (err) {
      if (!committed) {
        try { db.exec('ROLLBACK'); } catch (_) {}
      }
      throw err;
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  }

  // ─── 3. ICE BREAKER work_type 修正（work_key 指定・冪等）──────────────────
  // sf_works が存在しない DB（古い環境）は例外を無視する。
  try {
    db.exec(
      "UPDATE sf_works SET work_type = 'short_series' " +
      "WHERE work_key = 'ice_breaker' AND work_type = 'short_story'"
    );
  } catch (_) {}
}

// ═══════════════════════════════════════════════════════════════════════════════
// Snow flakes 作品在庫シード（39件）
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Snow flakes 全39件の作品在庫を sf_works + sf_work_publications（narou）へ登録する。
 *
 * sf_works 方針:
 *   - work_key で存在確認
 *   - 未存在 → INSERT（inserted_works にカウント）
 *   - 存在し title/work_type が一致 → id 再利用（verified_works にカウント）
 *   - 存在するが title/work_type が不一致 → errors に記録（INSERT/UPDATE ともしない）
 *
 * sf_work_publications 方針:
 *   - (work_id, 'narou') で存在確認
 *   - 未存在 → INSERT（inserted_pubs にカウント）
 *   - 存在する → publication_status を更新。memo は非 NULL 時のみ上書き（updated_pubs にカウント）
 *   - public_url / platform_work_id / published_at / last_checked_at は一切上書きしない
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {{ inserted_works: number, verified_works: number, inserted_pubs: number, updated_pubs: number, errors: string[] }}
 */
export function seedSfWorksInventory(db) {
  /** @type {{ work_key: string, title: string, work_type: string, status: string, tp: number, pub: string, memo: string|null }[]} */
  const SEED = [
    // ── 既存9件 ─────────────────────────────────────────────────────────────
    { work_key: 'snow_flakes_main',       title: 'Snow flakes',    work_type: 'novel',        status: 'active',    tp: 0, pub: 'published',   memo: null },
    { work_key: 'under_tone',             title: 'Under tone',     work_type: 'game',         status: 'active',    tp: 0, pub: 'published',   memo: null },
    { work_key: 'hitotsu_ooi_oto',        title: 'ひとつ多い音',   work_type: 'short_story',  status: 'completed', tp: 0, pub: 'published',   memo: null },
    { work_key: 'totonoena\u00ee_oto',    title: '整えない音',     work_type: 'short_story',  status: 'completed', tp: 0, pub: 'published',   memo: null },
    { work_key: 'shiroi_oto',             title: '白い音',         work_type: 'short_story',  status: 'completed', tp: 0, pub: 'published',   memo: null },
    { work_key: 'toumei_na_rhythm',       title: '透明なリズム',   work_type: 'short_story',  status: 'completed', tp: 0, pub: 'published',   memo: null },
    { work_key: 'ice_breaker',            title: 'ICE BREAKER',   work_type: 'short_series', status: 'completed', tp: 0, pub: 'published',   memo: null },
    { work_key: 'moon_veil',              title: 'Moon Veil',     work_type: 'short_story',  status: 'completed', tp: 0, pub: 'published',   memo: 'なろうでの表記は「Moon Vail」' },
    { work_key: 'hajimari_no_bass',       title: '始まりのベース', work_type: 'short_story',  status: 'completed', tp: 0, pub: 'published',   memo: null },
    // ── 新規30件（公開8件）───────────────────────────────────────────────────
    { work_key: 'oto_hazure_skill',       title: '音を覚えるだけの外れスキルで追放された俺、失われた古代魔法を全部再生できるらしい', work_type: 'novel',        status: 'active',    tp: 0, pub: 'published',   memo: null },
    { work_key: 'ippon_drumstick',        title: '一本だけのドラムスティック',                                                         work_type: 'short_story',  status: 'completed', tp: 0, pub: 'published',   memo: null },
    { work_key: 'tadashii_kyori',         title: '正しい距離より、触れている方がいい',                                                 work_type: 'short_story',  status: 'completed', tp: 0, pub: 'published',   memo: null },
    { work_key: 'hanbun_no_mama',         title: '半分のまま',                                                                         work_type: 'short_story',  status: 'completed', tp: 0, pub: 'published',   memo: null },
    { work_key: 'oto_no_naru_ishi',       title: '音の鳴る石',                                                                         work_type: 'short_series', status: 'completed', tp: 0, pub: 'published',   memo: null },
    { work_key: 'mada_natteiru',          title: 'まだ、鳴っている',                                                                   work_type: 'short_series', status: 'completed', tp: 0, pub: 'published',   memo: null },
    { work_key: 'shikiichi',              title: '閾値',                                                                               work_type: 'short_story',  status: 'completed', tp: 0, pub: 'published',   memo: null },
    { work_key: 'dekkin',                 title: '出禁',                                                                               work_type: 'short_story',  status: 'completed', tp: 0, pub: 'published',   memo: null },
    // ── 新規30件（未公開22件）────────────────────────────────────────────────
    { work_key: 'headroom',               title: 'ヘッドルーム',                    work_type: 'other',        status: 'active',    tp: 0, pub: 'unpublished', memo: null },
    { work_key: 'tomaranai_oto',          title: '止まらない音',                    work_type: 'short_story',  status: 'active',    tp: 0, pub: 'unpublished', memo: null },
    { work_key: 'tsuki_ga_michiru_made',  title: '月が満ちるまで',                  work_type: 'short_series', status: 'completed', tp: 0, pub: 'unpublished', memo: null },
    { work_key: 'blue_night_drive',       title: 'Blue Night Drive',               work_type: 'short_story',  status: 'active',    tp: 0, pub: 'unpublished', memo: null },
    { work_key: 'yoi_no_tsuki',           title: '宵の月',                         work_type: 'other',        status: 'active',    tp: 0, pub: 'unpublished', memo: null },
    { work_key: 'tsubasa',                title: '翼',                             work_type: 'short_series', status: 'active',    tp: 0, pub: 'unpublished', memo: null },
    { work_key: 'shunkan_ni_nokoru',      title: '瞬間に残る',                     work_type: 'novel',        status: 'active',    tp: 0, pub: 'unpublished', memo: null },
    { work_key: 'fuyu_tanpen',            title: '冬短篇',                         work_type: 'other',        status: 'active',    tp: 1, pub: 'unpublished', memo: null },
    { work_key: 'idol_tanpen',            title: 'アイドル',                       work_type: 'other',        status: 'active',    tp: 1, pub: 'unpublished', memo: null },
    { work_key: 'akari_kouta_tanpen',     title: 'あかり視点のコウタ短編',          work_type: 'other',        status: 'active',    tp: 1, pub: 'unpublished', memo: null },
    { work_key: 'kouta_highschool_adult', title: 'コウタ　高校後半から　社会人',    work_type: 'other',        status: 'active',    tp: 1, pub: 'unpublished', memo: null },
    { work_key: 'kouta_no_nikki',         title: 'コウタの日記',                   work_type: 'other',        status: 'active',    tp: 1, pub: 'unpublished', memo: null },
    { work_key: 'shiroi_hana',            title: '白い花',                         work_type: 'short_story',  status: 'active',    tp: 0, pub: 'unpublished', memo: null },
    { work_key: 'in_one_sky',             title: 'In One Sky',                     work_type: 'short_series', status: 'active',    tp: 0, pub: 'unpublished', memo: null },
    { work_key: 'after_the_snow',         title: 'After the Snow',                 work_type: 'other',        status: 'active',    tp: 0, pub: 'unpublished', memo: null },
    { work_key: 'hinata_koyuki',          title: 'ヒナタ小雪',                     work_type: 'other',        status: 'active',    tp: 1, pub: 'unpublished', memo: null },
    { work_key: 'another_peace_after_snow', title: 'AnotherPeace\u3000+AftertheSnow', work_type: 'other',    status: 'active',    tp: 1, pub: 'unpublished', memo: null },
    { work_key: 'totonoeru_me',           title: '整える目',                       work_type: 'short_story',  status: 'active',    tp: 0, pub: 'unpublished', memo: null },
    { work_key: 'amane',                  title: 'アマネ',                         work_type: 'other',        status: 'active',    tp: 0, pub: 'unpublished', memo: null },
    { work_key: 'little_snow',            title: 'リトルスノー',                   work_type: 'short_story',  status: 'active',    tp: 0, pub: 'unpublished', memo: null },
    { work_key: 'snow_another_piece',     title: 'Snow frakes - Anoter piece -',   work_type: 'other',        status: 'active',    tp: 1, pub: 'unpublished', memo: null },
    { work_key: 'rising_wind',            title: 'Rising Wind',                    work_type: 'short_story',  status: 'active',    tp: 0, pub: 'unpublished', memo: null },
  ];

  let inserted_works = 0;
  let verified_works = 0;
  let inserted_pubs  = 0;
  let updated_pubs   = 0;
  const errors = [];

  const stmtFindWork   = db.prepare('SELECT id, title, work_type FROM sf_works WHERE work_key = ?');
  // display_order はINSERT時点で末尾へ自動付与（MAX + 10）
  const stmtInsertWork = db.prepare(
    'INSERT INTO sf_works (work_key, title, work_type, status, title_provisional, display_order) ' +
    'VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(display_order), 0) + 10 FROM sf_works))'
  );
  const stmtFindPub = db.prepare(
    "SELECT id FROM sf_work_publications WHERE work_id = ? AND platform = 'narou'"
  );
  const stmtInsertPub = db.prepare(
    "INSERT INTO sf_work_publications (work_id, platform, publication_status, memo) " +
    "VALUES (?, 'narou', ?, ?)"
  );
  // pub_status のみ更新。memo は非 NULL 時のみ上書き（NULL なら既存値を維持）。
  // public_url / platform_work_id / published_at / last_checked_at は SET 句に含めない。
  const stmtUpdatePub = db.prepare(
    "UPDATE sf_work_publications " +
    "SET publication_status = ?, " +
    "    memo = CASE WHEN ? IS NOT NULL THEN ? ELSE memo END " +
    "WHERE work_id = ? AND platform = 'narou'"
  );

  for (const seed of SEED) {
    // ── sf_works 存在確認 ────────────────────────────────────────────────────
    let workId;
    const existing = stmtFindWork.get(seed.work_key);
    if (existing) {
      const mismatches = [];
      if (existing.title     !== seed.title)     mismatches.push(`title: DB="${existing.title}" expected="${seed.title}"`);
      if (existing.work_type !== seed.work_type) mismatches.push(`work_type: DB="${existing.work_type}" expected="${seed.work_type}"`);
      if (mismatches.length > 0) {
        errors.push(`work_key="${seed.work_key}" mismatch — ${mismatches.join(', ')}`);
        continue; // publication も skip
      }
      workId = Number(existing.id);
      verified_works++;
    } else {
      const result = stmtInsertWork.run(seed.work_key, seed.title, seed.work_type, seed.status, seed.tp);
      workId = Number(result.lastInsertRowid);
      inserted_works++;
    }

    // ── sf_work_publications (narou) upsert ─────────────────────────────────
    const existingPub = stmtFindPub.get(workId);
    if (existingPub) {
      stmtUpdatePub.run(seed.pub, seed.memo, seed.memo, workId);
      updated_pubs++;
    } else {
      stmtInsertPub.run(workId, seed.pub, seed.memo);
      inserted_pubs++;
    }
  }

  return { inserted_works, verified_works, inserted_pubs, updated_pubs, errors };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 29: display_order migration
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Phase 29 マイグレーション。runMigrations から自動呼び出し済み。
 * テストから直接呼ぶことも可（冪等）。
 *
 * 1. sf_works.display_order カラム追加（PRAGMA table_info で存在確認）
 * 2. display_order が NULL の作品に初期値を付与（ユーザー設定済みの値は絶対に変更しない）
 *
 *    ケース A: まだ1件も display_order が設定されていない（初回 migration）
 *      → 現行表示順 (published_at DESC NULLS LAST, id DESC) で 10, 20, 30... を付与
 *
 *    ケース B: 一部の作品に display_order が設定済み（ユーザーが並べ替え後に新規作品が追加された等）
 *      → 既存の MAX(display_order) を起点に id ASC 順で末尾へ追加
 *      → 既存の display_order は一切変更しない
 *
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function phase29Migration(db) {
  // 1. display_order カラム追加（冪等）
  const cols = db.prepare('PRAGMA table_info(sf_works)').all();
  if (!cols.some(c => c.name === 'display_order')) {
    db.exec('ALTER TABLE sf_works ADD COLUMN display_order INTEGER');
  }

  // 2. NULL作品が存在しない場合は何もしない
  const nullCount = Number(
    db.prepare('SELECT COUNT(*) AS cnt FROM sf_works WHERE display_order IS NULL').get()?.cnt ?? 0
  );
  if (nullCount === 0) return;

  const orderedCount = Number(
    db.prepare('SELECT COUNT(*) AS cnt FROM sf_works WHERE display_order IS NOT NULL').get()?.cnt ?? 0
  );

  if (orderedCount === 0) {
    // ケース A: 初回 — 現行ソート順 (published_at DESC NULLS LAST, id DESC) で初期化
    db.exec(`
      UPDATE sf_works
      SET display_order = (
        SELECT sub.rn * 10
        FROM (
          SELECT id,
                 ROW_NUMBER() OVER (ORDER BY published_at DESC NULLS LAST, id DESC) AS rn
          FROM sf_works
        ) sub
        WHERE sub.id = sf_works.id
      )
      WHERE display_order IS NULL
    `);
  } else {
    // ケース B: 既存順を維持し、NULL作品を末尾に id ASC 順で追加
    //   MAX(display_order) + 10, +20, +30 ... と付与
    //   サブクエリ内で id <= sf_works.id かつ NULL の作品数を数えることで連番を実現
    db.exec(`
      UPDATE sf_works
      SET display_order = (
        SELECT COALESCE(
          (SELECT MAX(display_order) FROM sf_works WHERE display_order IS NOT NULL),
          0
        ) + (
          SELECT COUNT(*) * 10
          FROM sf_works AS s2
          WHERE s2.display_order IS NULL AND s2.id <= sf_works.id
        )
      )
      WHERE display_order IS NULL
    `);
  }
}

/**
 * Phase 30 マイグレーション。
 *
 * 1. sf_work_archives テーブル再構築（direct_input / literary_award 追加、version_date 追加）
 * 2. sf_works に synopsis / first_draft_date / character_count / memo カラム追加
 * 3. sf_work_archives に version_date カラム確認・追加（再構築スキップ時のフォールバック）
 * 4. PRAGMA foreign_key_check
 *
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function phase30Migration(db) {
  // ── Step 1: sf_work_archives 再構築（冪等判定） ──────────────────────────────
  const archiveTableRow = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type='table' AND name='sf_work_archives'"
  ).get();
  const archiveTableSql = archiveTableRow?.sql ?? '';
  // CHECK に7種すべて + version_date カラムが存在する場合のみ再構築をスキップ
  const ALL_ARCHIVE_TYPES = ['submission', 'publication', 'revision', 'literary_award', 'direct_input', 'backup', 'other'];
  const checkHasAllTypes  = ALL_ARCHIVE_TYPES.every(t => archiveTableSql.includes(`'${t}'`));
  const archiveColNames   = db.prepare('PRAGMA table_info(sf_work_archives)').all().map(c => c.name);
  const hasVersionDate    = archiveColNames.includes('version_date');
  const skipRebuild       = checkHasAllTypes && hasVersionDate;

  db.exec('PRAGMA foreign_keys = OFF');
  try {
    if (!skipRebuild) {
      let committed = false;
      try {
        db.exec('BEGIN TRANSACTION');

        db.exec(`
          CREATE TABLE sf_work_archives_new (
            id                INTEGER PRIMARY KEY AUTOINCREMENT,
            work_id           INTEGER NOT NULL REFERENCES sf_works(id),
            archive_type      TEXT    NOT NULL
              CHECK (archive_type IN ('submission','publication','revision','literary_award','direct_input','backup','other')),
            version_label     TEXT,
            version_date      TEXT,
            original_filename TEXT,
            archived_filename TEXT    NOT NULL,
            file_path         TEXT    NOT NULL,
            sha256            TEXT    NOT NULL,
            file_size_bytes   INTEGER NOT NULL,
            archived_at       TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
            memo              TEXT,
            UNIQUE(work_id, sha256, archive_type)
          )
        `);

        db.exec(`
          INSERT INTO sf_work_archives_new
            (id, work_id, archive_type, version_label, original_filename, archived_filename,
             file_path, sha256, file_size_bytes, archived_at, memo)
          SELECT
            id, work_id, archive_type, version_label, original_filename, archived_filename,
            file_path, sha256, file_size_bytes, archived_at, memo
          FROM sf_work_archives
        `);

        db.exec('DROP TABLE sf_work_archives');
        db.exec('ALTER TABLE sf_work_archives_new RENAME TO sf_work_archives');

        db.exec('COMMIT');
        committed = true;

        db.exec('CREATE INDEX IF NOT EXISTS idx_sf_work_arch_work ON sf_work_archives(work_id)');
        db.exec('CREATE INDEX IF NOT EXISTS idx_sf_work_arch_type ON sf_work_archives(archive_type)');

        const fkCheck = db.prepare('PRAGMA foreign_key_check(sf_work_archives)').all();
        if (fkCheck.length > 0) {
          throw new Error(`sf_work_archives FK check failed: ${JSON.stringify(fkCheck)}`);
        }
      } catch (e) {
        if (!committed) {
          try { db.exec('ROLLBACK'); } catch (_) {}
        }
        throw e;
      }
    }
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }

  // ── Step 2: sf_works カラム追加（冪等） ──────────────────────────────────────
  const worksCols = db.prepare('PRAGMA table_info(sf_works)').all().map(c => c.name);
  if (!worksCols.includes('synopsis'))         db.exec('ALTER TABLE sf_works ADD COLUMN synopsis TEXT');
  if (!worksCols.includes('first_draft_date')) db.exec('ALTER TABLE sf_works ADD COLUMN first_draft_date TEXT');
  if (!worksCols.includes('character_count'))  db.exec('ALTER TABLE sf_works ADD COLUMN character_count INTEGER');
  if (!worksCols.includes('memo'))             db.exec('ALTER TABLE sf_works ADD COLUMN memo TEXT');

  // ── Step 3: version_date カラム確認（再構築スキップ時のフォールバック） ────────
  const archiveCols = db.prepare('PRAGMA table_info(sf_work_archives)').all().map(c => c.name);
  if (!archiveCols.includes('version_date')) {
    db.exec('ALTER TABLE sf_work_archives ADD COLUMN version_date TEXT');
  }

  // ── Step 4: Final FK check ────────────────────────────────────────────────────
  const fkErrors = db.prepare('PRAGMA foreign_key_check').all();
  if (fkErrors.length > 0) {
    throw new Error(`foreign_key_check failed: ${JSON.stringify(fkErrors)}`);
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Snow flakes HP限定作品シード（5件）
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Snow flakes HP限定5件を sf_works + sf_work_publications（hp）へ登録する。
 *
 * sf_works 方針:
 *   - work_key で存在確認
 *   - 未存在 → INSERT（inserted_works にカウント）
 *   - 存在し title/work_type が一致 → id 再利用（verified_works にカウント）
 *   - 存在するが title/work_type が不一致 → errors に記録（INSERT/UPDATE ともしない）
 *
 * sf_work_publications 方針:
 *   - (work_id, 'hp') で存在確認
 *   - 未存在 → INSERT（inserted_pubs にカウント）
 *   - 存在する → publication_status / memo / public_url を更新（updated_pubs にカウント）
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {{ inserted_works: number, verified_works: number, inserted_pubs: number, updated_pubs: number, errors: string[] }}
 */
export function seedHpExclusiveWorks(db) {
  /** @type {{ work_key: string, title: string, work_type: string, status: string, tp: number, pub_status: string, public_url: string|null, memo: string|null }[]} */
  const HP_SEED = [
    {
      work_key:   'kankei',
      title:      '関係者',
      work_type:  'short_story',
      status:     'completed',
      tp:         0,
      pub_status: 'published',
      public_url: 'https://sunnyplace25.github.io/snowflakes/horror_kankei.html',
      memo:       null,
    },
    {
      work_key:   'yoninnme',
      title:      '四人目',
      work_type:  'short_story',
      status:     'completed',
      tp:         0,
      pub_status: 'published',
      public_url: 'https://sunnyplace25.github.io/snowflakes/horror_yoninnme.html',
      memo:       null,
    },
    {
      work_key:   'tebiki',
      title:      '手引き',
      work_type:  'short_story',
      status:     'completed',
      tp:         0,
      pub_status: 'published',
      public_url: 'https://sunnyplace25.github.io/snowflakes/horror_tebiki.html',
      memo:       null,
    },
    {
      work_key:   'oboetokuwa',
      title:      '覚えとくわ',
      work_type:  'short_story',
      status:     'completed',
      tp:         0,
      pub_status: 'published',
      public_url: 'https://sunnyplace25.github.io/snowflakes/horror_oboetokuwa.html',
      memo:       null,
    },
    {
      work_key:   'namae_mada_narenai',
      title:      '名前、まだ慣れない',
      work_type:  'other',
      status:     'completed',
      tp:         0,
      pub_status: 'published',
      public_url: 'https://sunnyplace25.github.io/snowflakes/ura/',
      memo:       '裏話 第1回 / noindex,nofollow',
    },
  ];

  let inserted_works = 0;
  let verified_works = 0;
  let inserted_pubs  = 0;
  let updated_pubs   = 0;
  const errors = [];

  const stmtFindWork   = db.prepare('SELECT id, title, work_type FROM sf_works WHERE work_key = ?');
  // display_order はINSERT時点で末尾へ自動付与（MAX + 10）
  const stmtInsertWork = db.prepare(
    'INSERT INTO sf_works (work_key, title, work_type, status, title_provisional, display_order) ' +
    'VALUES (?, ?, ?, ?, ?, (SELECT COALESCE(MAX(display_order), 0) + 10 FROM sf_works))'
  );
  const stmtFindPub = db.prepare(
    "SELECT id FROM sf_work_publications WHERE work_id = ? AND platform = 'hp'"
  );
  const stmtInsertPub = db.prepare(
    "INSERT INTO sf_work_publications (work_id, platform, publication_status, public_url, memo) " +
    "VALUES (?, 'hp', ?, ?, ?)"
  );
  const stmtUpdatePub = db.prepare(
    "UPDATE sf_work_publications " +
    "SET publication_status = ?, public_url = ?, memo = ? " +
    "WHERE work_id = ? AND platform = 'hp'"
  );

  for (const seed of HP_SEED) {
    // ── sf_works 存在確認 ────────────────────────────────────────────────────
    let workId;
    const existing = stmtFindWork.get(seed.work_key);
    if (existing) {
      const mismatches = [];
      if (existing.title     !== seed.title)     mismatches.push(`title: DB="${existing.title}" expected="${seed.title}"`);
      if (existing.work_type !== seed.work_type) mismatches.push(`work_type: DB="${existing.work_type}" expected="${seed.work_type}"`);
      if (mismatches.length > 0) {
        errors.push(`work_key="${seed.work_key}" mismatch — ${mismatches.join(', ')}`);
        continue;
      }
      workId = Number(existing.id);
      verified_works++;
    } else {
      const result = stmtInsertWork.run(seed.work_key, seed.title, seed.work_type, seed.status, seed.tp);
      workId = Number(result.lastInsertRowid);
      inserted_works++;
    }

    // ── sf_work_publications (hp) upsert ────────────────────────────────────
    const existingPub = stmtFindPub.get(workId);
    if (existingPub) {
      stmtUpdatePub.run(seed.pub_status, seed.public_url, seed.memo, workId);
      updated_pubs++;
    } else {
      stmtInsertPub.run(workId, seed.pub_status, seed.public_url, seed.memo);
      inserted_pubs++;
    }
  }

  return { inserted_works, verified_works, inserted_pubs, updated_pubs, errors };
}

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 31: sf_sync_source_settings テーブル追加（source enabled/disabled 管理）
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Phase 31 マイグレーション。
 * sf_sync_source_settings テーブルを追加する（冪等）。
 *
 * ★ runMigrations() から :memory: DB のみ自動適用。
 *    実 DB（business_data.db）への適用は承認後に別途呼び出すこと。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function phase31Migration(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sf_sync_source_settings (
      source_key  TEXT PRIMARY KEY,
      enabled     INTEGER NOT NULL DEFAULT 1,
      updated_at  TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    )
  `);
}

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 32: 競合アカウント分析テーブル追加
// ═══════════════════════════════════════════════════════════════════════════════

const PHASE32_TABLES = [
  `CREATE TABLE IF NOT EXISTS merch_competitor_accounts (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    mercari_user_id TEXT    NOT NULL UNIQUE,
    display_name    TEXT    NOT NULL,
    profile_url     TEXT    NOT NULL,
    note            TEXT,
    is_active       INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
    first_scanned_at TEXT,
    last_scanned_at  TEXT,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at      TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
  `CREATE TABLE IF NOT EXISTS merch_competitor_scans (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id        INTEGER NOT NULL REFERENCES merch_competitor_accounts(id),
    scan_date         TEXT    NOT NULL,
    started_at        TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
    finished_at       TEXT,
    status            TEXT    NOT NULL DEFAULT 'running'
      CHECK (status IN ('running','completed','failed','partial')),
    items_fetched     INTEGER NOT NULL DEFAULT 0,
    items_new         INTEGER NOT NULL DEFAULT 0,
    items_sold        INTEGER NOT NULL DEFAULT 0,
    items_price_changed INTEGER NOT NULL DEFAULT 0,
    items_missing     INTEGER NOT NULL DEFAULT 0,
    items_reappeared  INTEGER NOT NULL DEFAULT 0,
    error_message     TEXT,
    UNIQUE(account_id, scan_date)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_mcs_account  ON merch_competitor_scans(account_id)`,
  `CREATE INDEX IF NOT EXISTS idx_mcs_date     ON merch_competitor_scans(scan_date)`,
  `CREATE INDEX IF NOT EXISTS idx_mcs_status   ON merch_competitor_scans(status)`,
  `CREATE TABLE IF NOT EXISTS merch_competitor_items (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id        INTEGER NOT NULL REFERENCES merch_competitor_accounts(id),
    mercari_item_id   TEXT    NOT NULL,
    name              TEXT    NOT NULL,
    price             INTEGER NOT NULL DEFAULT 0,
    status            TEXT    NOT NULL DEFAULT 'unknown'
      CHECK (status IN ('on_sale','sold','missing','unknown')),
    brand             TEXT,
    category          TEXT,
    color             TEXT,
    material          TEXT,
    size              TEXT,
    condition_text    TEXT,
    target_gender     TEXT CHECK (target_gender IN ('male','female','unisex','unknown') OR target_gender IS NULL),
    season            TEXT,
    image_url         TEXT,
    raw_data          TEXT,
    classified_brand  TEXT,
    classified_category TEXT,
    classified_color  TEXT,
    classified_season TEXT,
    classified_target TEXT,
    classification_confidence TEXT CHECK (classification_confidence IN ('high','medium','low') OR classification_confidence IS NULL),
    buying_limit      INTEGER,
    first_seen_at     TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
    last_seen_at      TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
    sold_at           TEXT,
    status_changed_at TEXT,
    created_at        TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at        TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE(account_id, mercari_item_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_mci_account   ON merch_competitor_items(account_id)`,
  `CREATE INDEX IF NOT EXISTS idx_mci_status    ON merch_competitor_items(status)`,
  `CREATE INDEX IF NOT EXISTS idx_mci_brand     ON merch_competitor_items(classified_brand)`,
  `CREATE INDEX IF NOT EXISTS idx_mci_category  ON merch_competitor_items(classified_category)`,
  `CREATE INDEX IF NOT EXISTS idx_mci_last_seen ON merch_competitor_items(last_seen_at)`,
  `CREATE TABLE IF NOT EXISTS merch_competitor_price_history (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id     INTEGER NOT NULL REFERENCES merch_competitor_items(id),
    price_from  INTEGER NOT NULL,
    price_to    INTEGER NOT NULL,
    changed_at  TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
    scan_id     INTEGER REFERENCES merch_competitor_scans(id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_mcph_item    ON merch_competitor_price_history(item_id)`,
  `CREATE INDEX IF NOT EXISTS idx_mcph_changed ON merch_competitor_price_history(changed_at)`,
  `CREATE TABLE IF NOT EXISTS merch_competitor_scan_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    scan_id     INTEGER NOT NULL REFERENCES merch_competitor_scans(id),
    item_id     INTEGER NOT NULL REFERENCES merch_competitor_items(id),
    event_type  TEXT    NOT NULL
      CHECK (event_type IN ('new','sold','price_change','missing','reappeared')),
    price_from  INTEGER,
    price_to    INTEGER,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_mcse_scan  ON merch_competitor_scan_events(scan_id)`,
  `CREATE INDEX IF NOT EXISTS idx_mcse_item  ON merch_competitor_scan_events(item_id)`,
  `CREATE INDEX IF NOT EXISTS idx_mcse_event ON merch_competitor_scan_events(event_type)`,
  `CREATE TABLE IF NOT EXISTS merch_competitor_notifications (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    notify_date TEXT    NOT NULL UNIQUE,
    summary     TEXT    NOT NULL,
    is_read     INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0,1)),
    created_at  TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_mcn_date ON merch_competitor_notifications(notify_date)`,
  `CREATE TABLE IF NOT EXISTS merch_competitor_reports (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    report_type   TEXT    NOT NULL CHECK (report_type IN ('weekly','monthly')),
    period_start  TEXT    NOT NULL,
    period_end    TEXT    NOT NULL,
    account_id    INTEGER REFERENCES merch_competitor_accounts(id),
    body          TEXT    NOT NULL,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE(report_type, period_start, account_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_mcr_type   ON merch_competitor_reports(report_type)`,
  `CREATE INDEX IF NOT EXISTS idx_mcr_period ON merch_competitor_reports(period_start)`,
  `CREATE TABLE IF NOT EXISTS merch_analysis_settings (
    key         TEXT    PRIMARY KEY,
    value       TEXT    NOT NULL,
    description TEXT,
    updated_at  TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
  `CREATE TABLE IF NOT EXISTS merch_classification_overrides (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id         INTEGER NOT NULL UNIQUE REFERENCES merch_competitor_items(id),
    override_brand  TEXT,
    override_category TEXT,
    override_color  TEXT,
    override_season TEXT,
    override_target TEXT,
    note            TEXT,
    created_at      TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at      TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
];

/** デフォルト分析設定 */
const PHASE32_DEFAULT_SETTINGS = [
  ['fee_rate',            '0.10',  'メルカリ手数料率（デフォルト10%）'],
  ['shipping_cost',       '600',   '送料目安（円）'],
  ['min_profit',          '2000',  '最低利益（円）'],
  ['max_items_per_scan',  '300',   '1スキャンで取得する最大商品数'],
  ['confidence_high_min', '10',    'high判定の最低サンプル数'],
  ['confidence_med_min',  '3',     'medium判定の最低サンプル数'],
];

/** 初期アカウント（はーと♡セール開催中） */
const PHASE32_INITIAL_ACCOUNTS = [
  ['793350860', 'はーと♡セール開催中', 'https://jp.mercari.com/user/profile/793350860'],
];

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 33: work_records 物販詳細カラム追加
// ═══════════════════════════════════════════════════════════════════════════════
// 既存 expense カラムは削除・変更しない（旧データの保持）。
// 新規レコードでは expense = cost_purchase + cost_shipping + commission_amount。

const PHASE33_COLUMNS = [
  "ALTER TABLE work_records ADD COLUMN cost_purchase    INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE work_records ADD COLUMN cost_shipping    INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE work_records ADD COLUMN commission_rate  TEXT",
  "ALTER TABLE work_records ADD COLUMN commission_amount INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE work_records ADD COLUMN platform         TEXT",
  "ALTER TABLE work_records ADD COLUMN purchase_place   TEXT",
];

export function phase33Migration(db) {
  for (const sql of PHASE33_COLUMNS) {
    try { db.exec(sql); } catch (_) { /* column already exists */ }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Phase 34: work_records 出品日・売却日・仕入日カラム追加
// ═══════════════════════════════════════════════════════════════════════════════

const PHASE34_COLUMNS = [
  "ALTER TABLE work_records ADD COLUMN listed_date    TEXT",
  "ALTER TABLE work_records ADD COLUMN sold_date      TEXT",
  "ALTER TABLE work_records ADD COLUMN purchased_date TEXT",
];

export function phase34Migration(db) {
  for (const sql of PHASE34_COLUMNS) {
    try { db.exec(sql); } catch (_) { /* already exists */ }
  }
}

export function phase32Migration(db) {
  for (const sql of PHASE32_TABLES) {
    try { db.exec(sql); } catch (_) { /* already exists */ }
  }

  // デフォルト設定を INSERT OR IGNORE
  const settingStmt = db.prepare(
    'INSERT OR IGNORE INTO merch_analysis_settings (key, value, description) VALUES (?, ?, ?)'
  );
  for (const [key, value, description] of PHASE32_DEFAULT_SETTINGS) {
    try { settingStmt.run(key, value, description); } catch (_) {}
  }

  // 初期アカウントを INSERT OR IGNORE
  const accountStmt = db.prepare(
    'INSERT OR IGNORE INTO merch_competitor_accounts (mercari_user_id, display_name, profile_url) VALUES (?, ?, ?)'
  );
  for (const [uid, name, url] of PHASE32_INITIAL_ACCOUNTS) {
    try { accountStmt.run(uid, name, url); } catch (_) {}
  }
}
