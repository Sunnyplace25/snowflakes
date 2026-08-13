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
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  date              TEXT    NOT NULL,
  month             TEXT    NOT NULL,           -- statement_period（Soundrop明細発行月 YYYY-MM）
  transaction_month TEXT,                        -- 実際の再生・売上発生月（YYYY-MM）
  source            TEXT    NOT NULL
    CHECK (source IN ('音楽配信', '広告', '電子書籍', '有料コンテンツ', 'その他')),
  platform          TEXT,
  work_id           INTEGER REFERENCES sf_works(id),
  track_id          INTEGER REFERENCES sf_tracks(id),
  quantity          INTEGER NOT NULL DEFAULT 0,  -- 再生数・UGC使用数の合計
  content           TEXT,
  amount            REAL    NOT NULL DEFAULT 0,
  currency          TEXT    NOT NULL DEFAULT 'JPY',
  amount_jpy        INTEGER NOT NULL DEFAULT 0,
  memo              TEXT,
  import_source     TEXT    DEFAULT 'manual'
    CHECK (import_source IN ('manual', 'csv', 'api')),
  created_at        TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE INDEX IF NOT EXISTS idx_sf_revenue_month            ON sf_revenue(month);
CREATE INDEX IF NOT EXISTS idx_sf_revenue_transaction_month ON sf_revenue(transaction_month);
CREATE INDEX IF NOT EXISTS idx_sf_revenue_track_id         ON sf_revenue(track_id);

-- 旧インポーター（soundrop.js / metrics_writer.js）の冪等性保証
-- transaction_month を設定しない旧パスの重複防止
CREATE UNIQUE INDEX IF NOT EXISTS idx_sf_revenue_csv_track
  ON sf_revenue(month, platform, track_id)
  WHERE import_source IN ('csv', 'api') AND track_id IS NOT NULL AND transaction_month IS NULL;

-- revenue_writer.js（Phase 2）の冪等性保証
-- 集計キー: statement_period(month) × transaction_month × platform × track_id
CREATE UNIQUE INDEX IF NOT EXISTS idx_sf_revenue_statement
  ON sf_revenue(month, transaction_month, platform, track_id)
  WHERE import_source IN ('csv', 'api') AND track_id IS NOT NULL AND transaction_month IS NOT NULL;

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

-- ── GA4 イベント日別集計（音源デモ再生等の受け口）────────────────────────────
-- 注意: 音源デモ再生イベントは公式サイト未実装。テーブルは受け口として設計のみ。

CREATE TABLE IF NOT EXISTS sf_ga_event_daily (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  date       TEXT    NOT NULL,
  event_name TEXT    NOT NULL,
  page_path  TEXT    NOT NULL DEFAULT '/',
  count      INTEGER NOT NULL DEFAULT 0,
  fetched_at TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
  UNIQUE(date, event_name, page_path)
);
CREATE INDEX IF NOT EXISTS idx_sf_ga_event_date ON sf_ga_event_daily(date);
CREATE INDEX IF NOT EXISTS idx_sf_ga_event_name ON sf_ga_event_daily(event_name);

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

-- ═══════════════════════════════════════════════════════════════════════════════
-- Phase 1.5: Snow flakes 楽曲・リリース管理基盤
-- ═══════════════════════════════════════════════════════════════════════════════

-- ── 音源ファイル台帳 ──────────────────────────────────────────────────────────
-- ファイル本体は参照のみ。移動・削除・リネーム・上書き禁止。
CREATE TABLE IF NOT EXISTS sf_track_files (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id        INTEGER NOT NULL REFERENCES sf_tracks(id),
  file_type       TEXT    NOT NULL
    CHECK (file_type IN ('master_wav','streaming_mp3','short_mp3','instrumental','demo','other')),
  file_path       TEXT    NOT NULL,
  label           TEXT,
  is_master       INTEGER NOT NULL DEFAULT 0 CHECK (is_master IN (0,1)),
  sample_rate     INTEGER,
  bit_depth       INTEGER,
  bitrate         INTEGER,
  duration_sec    REAL,
  file_size_bytes INTEGER,
  checksum        TEXT,
  memo            TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE(track_id, file_type, file_path)
);
CREATE INDEX IF NOT EXISTS idx_sf_track_files_track ON sf_track_files(track_id);

-- ── 歌詞管理 ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sf_track_lyrics (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id     INTEGER NOT NULL REFERENCES sf_tracks(id),
  language     TEXT    NOT NULL DEFAULT 'ja',
  version      TEXT    NOT NULL DEFAULT 'v1',
  lyrics_text  TEXT    NOT NULL,
  status       TEXT    NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','final')),
  has_furigana INTEGER NOT NULL DEFAULT 0 CHECK (has_furigana IN (0,1)),
  is_public    INTEGER NOT NULL DEFAULT 0 CHECK (is_public IN (0,1)),
  memo         TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE(track_id, language, version)
);

-- ── リリースマスター ──────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sf_releases (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  release_key  TEXT    NOT NULL UNIQUE,
  title        TEXT    NOT NULL,
  release_type TEXT    NOT NULL
    CHECK (release_type IN ('single','ep','album','compilation')),
  status       TEXT    NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','scheduled','released','private')),
  created_date TEXT,
  release_date TEXT,
  upc_ean      TEXT,
  memo         TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- ── リリース ↔ 楽曲 M:N ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sf_release_tracks (
  release_id   INTEGER NOT NULL REFERENCES sf_releases(id),
  track_id     INTEGER NOT NULL REFERENCES sf_tracks(id),
  track_number INTEGER,
  disc_number  INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (release_id, track_id)
);
CREATE INDEX IF NOT EXISTS idx_sf_rel_tracks_track ON sf_release_tracks(track_id);

-- ── ジャケット管理 ────────────────────────────────────────────────────────────
-- 画像本体は参照のみ。移動・削除・リネーム・上書き禁止。
CREATE TABLE IF NOT EXISTS sf_release_artworks (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  release_id      INTEGER NOT NULL REFERENCES sf_releases(id),
  file_path       TEXT    NOT NULL,
  status          TEXT    NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','final')),
  version         TEXT,
  width           INTEGER,
  height          INTEGER,
  file_size_bytes INTEGER,
  checksum        TEXT,
  memo            TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE(release_id, file_path)
);

-- ── クレジット管理（楽曲 / リリース 両対応）──────────────────────────────────
CREATE TABLE IF NOT EXISTS sf_credits (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id   INTEGER REFERENCES sf_tracks(id),
  release_id INTEGER REFERENCES sf_releases(id),
  role       TEXT    NOT NULL
    CHECK (role IN ('lyrics','composition','arrangement','vocal','guitar','bass',
                    'drums','programming','mix','mastering','artwork','other')),
  name       TEXT    NOT NULL,
  memo       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  CHECK (track_id IS NOT NULL OR release_id IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS idx_sf_credits_track   ON sf_credits(track_id);
CREATE INDEX IF NOT EXISTS idx_sf_credits_release ON sf_credits(release_id);

-- ── Soundrop配信管理（リリース単位）─────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sf_distributions (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  release_id           INTEGER NOT NULL REFERENCES sf_releases(id),
  distributor          TEXT    NOT NULL DEFAULT 'soundrop'
    CHECK (distributor IN ('soundrop','tunecore','distrokid','other')),
  distributor_release_id TEXT,
  distribution_status  TEXT    NOT NULL DEFAULT 'not_ready'
    CHECK (distribution_status IN (
      'not_ready','ready','submitted','reviewing',
      'needs_changes','approved','distributed'
    )),
  submitted_at         TEXT,
  approved_at          TEXT,
  memo                 TEXT,
  created_at           TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at           TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE(release_id, distributor)
);

-- ── Soundropインポートログ ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sf_distribution_imports (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  distributor     TEXT    NOT NULL DEFAULT 'soundrop',
  source_type     TEXT    NOT NULL DEFAULT 'csv'
    CHECK (source_type IN ('csv','xlsx','tsv','json','api','manual')),
  file_name       TEXT,
  file_path       TEXT,
  report_period   TEXT,
  row_count       INTEGER DEFAULT 0,
  matched_count   INTEGER DEFAULT 0,
  unmatched_count INTEGER DEFAULT 0,
  import_status   TEXT    NOT NULL DEFAULT 'pending'
    CHECK (import_status IN ('pending','processing','completed','failed','partial')),
  error_log       TEXT,
  imported_at     TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);

-- ── Soundropインポート生データ行 ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sf_distribution_import_rows (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  import_id          INTEGER NOT NULL REFERENCES sf_distribution_imports(id),
  row_index          INTEGER NOT NULL,
  raw_data           TEXT,
  matched_track_id   INTEGER REFERENCES sf_tracks(id),
  matched_release_id INTEGER REFERENCES sf_releases(id),
  match_method       TEXT
    CHECK (match_method IN ('isrc','upc','track_key','title_fuzzy','manual','unmatched')),
  platform           TEXT,
  period             TEXT,
  streams            INTEGER,
  revenue_amount     REAL,
  currency           TEXT,
  needs_review       INTEGER NOT NULL DEFAULT 0 CHECK (needs_review IN (0,1)),
  review_memo        TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_sf_import_rows_import    ON sf_distribution_import_rows(import_id);
CREATE INDEX IF NOT EXISTS idx_sf_import_rows_track     ON sf_distribution_import_rows(matched_track_id);
CREATE INDEX IF NOT EXISTS idx_sf_import_rows_unmatched ON sf_distribution_import_rows(needs_review);

-- ── アーティストページ管理 ────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sf_artist_profiles (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  artist_key         TEXT    NOT NULL,
  artist_name        TEXT    NOT NULL,
  platform           TEXT    NOT NULL
    CHECK (platform IN ('spotify','apple_music','amazon_music','youtube_music','other')),
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
);

-- ── 楽曲単位のストア情報 ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sf_track_releases (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id          INTEGER NOT NULL REFERENCES sf_tracks(id),
  platform          TEXT    NOT NULL
    CHECK (platform IN ('spotify','apple_music','amazon_music','youtube_music','other')),
  release_status    TEXT    NOT NULL DEFAULT 'unknown'
    CHECK (release_status IN ('unknown','live','pending','not_distributed','withdrawn')),
  platform_track_id TEXT,
  platform_url      TEXT,
  release_date      TEXT,
  distributed_via   TEXT,
  memo              TEXT,
  created_at        TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE(track_id, platform)
);
CREATE INDEX IF NOT EXISTS idx_sf_track_releases_track ON sf_track_releases(track_id);

-- ── リリース単位のストア情報 ──────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sf_release_platforms (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  release_id          INTEGER NOT NULL REFERENCES sf_releases(id),
  platform            TEXT    NOT NULL
    CHECK (platform IN ('spotify','apple_music','amazon_music','youtube_music','other')),
  release_status      TEXT    NOT NULL DEFAULT 'unknown'
    CHECK (release_status IN ('unknown','live','pending','not_distributed','withdrawn')),
  platform_release_id TEXT,
  platform_url        TEXT,
  release_date        TEXT,
  distributed_via     TEXT,
  memo                TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at          TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE(release_id, platform)
);
CREATE INDEX IF NOT EXISTS idx_sf_release_platforms_release ON sf_release_platforms(release_id);

-- ── 公式サイトデモ音源管理 ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS sf_track_previews (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  track_id      INTEGER NOT NULL REFERENCES sf_tracks(id),
  file_id       INTEGER REFERENCES sf_track_files(id),
  preview_type  TEXT    NOT NULL
    CHECK (preview_type IN ('demo','short','full_preview')),
  platform      TEXT    NOT NULL DEFAULT 'official_site'
    CHECK (platform IN ('official_site')),
  page_path     TEXT,
  page_url      TEXT,
  status        TEXT    NOT NULL DEFAULT 'draft'
    CHECK (status IN ('draft','published','hidden','ended')),
  published_at  TEXT,
  ended_at      TEXT,
  start_sec     REAL,
  end_sec       REAL,
  analytics_key TEXT UNIQUE,
  label         TEXT,
  memo          TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_sf_previews_track  ON sf_track_previews(track_id);
CREATE INDEX IF NOT EXISTS idx_sf_previews_status ON sf_track_previews(status);
