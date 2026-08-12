-- JARVIS 共通データ基盤 MVP スキーマ
-- Git管理対象（実データDBファイル business_data.db は .gitignore 対象）

CREATE TABLE IF NOT EXISTS work_records (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id         TEXT    NOT NULL,
  date           TEXT    NOT NULL,
  category       TEXT    NOT NULL
    CHECK (category IN ('Snow flakes', '音声仕事', '物販', '17配信', 'その他')),
  work_type      TEXT,
  content        TEXT,
  client         TEXT,
  income         INTEGER DEFAULT 0
    CHECK (income IS NULL OR income >= 0),
  expense        INTEGER DEFAULT 0
    CHECK (expense IS NULL OR expense >= 0),
  work_hours     REAL    DEFAULT 0
    CHECK (work_hours IS NULL OR work_hours >= 0),
  travel_hours   REAL    DEFAULT 0
    CHECK (travel_hours IS NULL OR travel_hours >= 0),
  invoice_status TEXT    NOT NULL DEFAULT '対象外'
    CHECK (invoice_status IN ('対象外', '未請求', '請求済')),
  payment_status TEXT    NOT NULL DEFAULT '対象外'
    CHECK (payment_status IN ('対象外', '未入金', '入金済')),
  memo           TEXT,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE TABLE IF NOT EXISTS daily_status (
  date           TEXT    PRIMARY KEY,
  is_full_day_off INTEGER NOT NULL DEFAULT 0
    CHECK (is_full_day_off IN (0, 1)),
  memo           TEXT,
  updated_at     TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Snow flakes Analytics — 観測データ基盤
-- Phase 1: マスターテーブル + 全観測テーブル
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── 作品マスター ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sf_works (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  work_key     TEXT    NOT NULL UNIQUE,
  title        TEXT    NOT NULL,
  work_type    TEXT    NOT NULL
    CHECK (work_type IN ('novel', 'short_story', 'short_series', 'game', 'other')),
  status       TEXT    NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'completed', 'hiatus')),
  published_at TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- ── 楽曲マスター ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sf_tracks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  track_key    TEXT    NOT NULL UNIQUE,
  title        TEXT    NOT NULL,
  release_date TEXT,
  created_at   TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- ── 楽曲 ↔ 作品 M:N 中間テーブル ─────────────────────────────────────────────
-- 代表作品は link_type='primary' で管理（sf_tracks 側に primary_work_id は持たない）
-- primary は track_id につき最大1件を partial UNIQUE INDEX で保証

CREATE TABLE IF NOT EXISTS sf_track_work_links (
  track_id  INTEGER NOT NULL REFERENCES sf_tracks(id),
  work_id   INTEGER NOT NULL REFERENCES sf_works(id),
  link_type TEXT    NOT NULL DEFAULT 'related'
    CHECK (link_type IN ('primary', 'related', 'collab')),
  PRIMARY KEY (track_id, work_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_sf_twl_primary
  ON sf_track_work_links(track_id)
  WHERE link_type = 'primary';

-- ── Snow flakes 収益 ──────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sf_revenue (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  date          TEXT    NOT NULL,
  month         TEXT    NOT NULL,
  source        TEXT    NOT NULL
    CHECK (source IN ('音楽配信', '広告', '電子書籍', '有料コンテンツ', 'その他')),
  platform      TEXT,
  work_id       INTEGER REFERENCES sf_works(id),
  track_id      INTEGER REFERENCES sf_tracks(id),
  content       TEXT,
  amount        REAL    NOT NULL DEFAULT 0,
  currency      TEXT    NOT NULL DEFAULT 'JPY',
  amount_jpy    INTEGER NOT NULL DEFAULT 0,
  memo          TEXT,
  import_source TEXT    DEFAULT 'manual'
    CHECK (import_source IN ('manual', 'csv', 'api')),
  created_at    TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE INDEX IF NOT EXISTS idx_sf_revenue_month    ON sf_revenue(month);
CREATE INDEX IF NOT EXISTS idx_sf_revenue_track_id ON sf_revenue(track_id);

-- ── GA4 日別スナップショット ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sf_ga_daily (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  date             TEXT    NOT NULL,
  page_path        TEXT    NOT NULL DEFAULT '/',
  sessions         INTEGER DEFAULT 0,
  users            INTEGER DEFAULT 0,
  page_views       INTEGER DEFAULT 0,
  engaged_sessions INTEGER DEFAULT 0,
  fetched_at       TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
  UNIQUE(date, page_path)
);

CREATE INDEX IF NOT EXISTS idx_sf_ga_date ON sf_ga_daily(date);
CREATE INDEX IF NOT EXISTS idx_sf_ga_page ON sf_ga_daily(page_path);

-- ── なろう 月次スナップショット ───────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sf_narou_snapshot (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  month          TEXT    NOT NULL,
  ncode          TEXT    NOT NULL,
  work_id        INTEGER REFERENCES sf_works(id),
  title          TEXT,
  pv_total       INTEGER,
  pv_monthly     INTEGER,
  bookmark_count INTEGER,
  review_count   INTEGER,
  point          INTEGER,
  memo           TEXT,
  import_source  TEXT    DEFAULT 'manual'
    CHECK (import_source IN ('manual', 'api', 'scraping')),
  created_at     TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
  UNIQUE(month, ncode)
);

CREATE INDEX IF NOT EXISTS idx_sf_narou_month   ON sf_narou_snapshot(month);
CREATE INDEX IF NOT EXISTS idx_sf_narou_work_id ON sf_narou_snapshot(work_id);

-- ── 音楽ストリーミング指標 ────────────────────────────────────────────────────
-- track_id は sf_tracks.id への FK（曲名変更・表記揺れでも紐付けを保持）
-- platform_track_id は各配信サービス固有の楽曲ID（将来 API 連携で使用）
-- UNIQUE は (date, granularity, platform, track_id) 基準

CREATE TABLE IF NOT EXISTS sf_music_metrics (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  date              TEXT    NOT NULL,
  month             TEXT    NOT NULL,
  granularity       TEXT    NOT NULL DEFAULT 'daily'
    CHECK (granularity IN ('daily', 'monthly')),
  platform          TEXT    NOT NULL
    CHECK (platform IN ('spotify', 'apple_music', 'amazon_music', 'youtube_music', 'other')),
  track_id          INTEGER NOT NULL REFERENCES sf_tracks(id),
  platform_track_id TEXT,
  streams           INTEGER DEFAULT 0,
  listeners         INTEGER,
  followers         INTEGER,
  followers_delta   INTEGER,
  saves             INTEGER,
  playlist_adds     INTEGER,
  revenue_amount    REAL    DEFAULT 0,
  currency          TEXT    DEFAULT 'JPY',
  revenue_jpy       INTEGER DEFAULT 0,
  import_source     TEXT    DEFAULT 'csv'
    CHECK (import_source IN ('csv', 'api', 'manual')),
  import_file       TEXT,
  fetched_at        TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
  UNIQUE(date, granularity, platform, track_id)
);

CREATE INDEX IF NOT EXISTS idx_sf_music_month    ON sf_music_metrics(month);
CREATE INDEX IF NOT EXISTS idx_sf_music_platform ON sf_music_metrics(platform);
CREATE INDEX IF NOT EXISTS idx_sf_music_track    ON sf_music_metrics(track_id);

-- ── SNS コンテンツ台帳 ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sf_content_registry (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  platform      TEXT    NOT NULL
    CHECK (platform IN ('youtube', 'instagram', 'tiktok')),
  content_type  TEXT    NOT NULL
    CHECK (content_type IN ('video', 'short', 'reel', 'post', 'story', 'tiktok_video')),
  platform_id   TEXT    NOT NULL,
  title         TEXT,
  work_id       INTEGER REFERENCES sf_works(id),
  track_id      INTEGER REFERENCES sf_tracks(id),
  related_char  TEXT,
  content_theme TEXT,
  published_at  TEXT,
  duration_sec  INTEGER,
  memo          TEXT,
  created_at    TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
  UNIQUE(platform, platform_id)
);

CREATE INDEX IF NOT EXISTS idx_sf_content_work_id  ON sf_content_registry(work_id);
CREATE INDEX IF NOT EXISTS idx_sf_content_track_id ON sf_content_registry(track_id);

-- ── SNS 投稿別指標（正規化） ──────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sf_social_metrics (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  content_reg_id  INTEGER NOT NULL REFERENCES sf_content_registry(id),
  snapshot_date   TEXT    NOT NULL,
  views           INTEGER DEFAULT 0,
  reach           INTEGER,
  impressions     INTEGER,
  likes           INTEGER DEFAULT 0,
  comments        INTEGER DEFAULT 0,
  shares          INTEGER DEFAULT 0,
  saves           INTEGER DEFAULT 0,
  link_clicks     INTEGER,
  watch_time_min  REAL,
  avg_watch_sec   REAL,
  completion_rate REAL,
  profile_visits  INTEGER,
  import_source   TEXT    DEFAULT 'api'
    CHECK (import_source IN ('api', 'csv', 'manual')),
  fetched_at      TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
  UNIQUE(content_reg_id, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_sf_social_date ON sf_social_metrics(snapshot_date);

-- ── プラットフォーム固有指標 ──────────────────────────────────────────────────
-- YouTube 視聴維持率・流入元など platform 固有データを key-value で保存

CREATE TABLE IF NOT EXISTS sf_platform_ext (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  metrics_id INTEGER NOT NULL REFERENCES sf_social_metrics(id),
  key        TEXT    NOT NULL,
  value_num  REAL,
  value_text TEXT,
  UNIQUE(metrics_id, key)
);

-- ── SNS アカウント日別集計 ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sf_account_daily (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  platform        TEXT    NOT NULL
    CHECK (platform IN ('youtube', 'instagram', 'tiktok')),
  date            TEXT    NOT NULL,
  followers       INTEGER,
  followers_delta INTEGER,
  reach           INTEGER,
  impressions     INTEGER,
  profile_visits  INTEGER,
  link_clicks     INTEGER,
  import_source   TEXT    DEFAULT 'api'
    CHECK (import_source IN ('api', 'csv', 'manual')),
  fetched_at      TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
  UNIQUE(platform, date)
);

CREATE INDEX IF NOT EXISTS idx_sf_account_daily ON sf_account_daily(platform, date);

-- ── ファネル基準点イベント ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sf_funnel_event (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  date           TEXT    NOT NULL,
  event_type     TEXT    NOT NULL
    CHECK (event_type IN (
      'novel_publish', 'novel_update', 'music_release', 'sns_post',
      'sweets_update', 'site_update', 'campaign_start', 'campaign_end'
    )),
  platform       TEXT,
  content_reg_id INTEGER REFERENCES sf_content_registry(id),
  work_id        INTEGER REFERENCES sf_works(id),
  track_id       INTEGER REFERENCES sf_tracks(id),
  label          TEXT,
  memo           TEXT,
  created_at     TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE INDEX IF NOT EXISTS idx_sf_funnel_date ON sf_funnel_event(date);
CREATE INDEX IF NOT EXISTS idx_sf_funnel_type ON sf_funnel_event(event_type);
