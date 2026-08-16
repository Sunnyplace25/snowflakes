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

-- ── Instagram アカウント日次スナップショット（Phase 6 / 2026 API準拠）────────────
-- 参照: Instagram API with Instagram Login / graph.instagram.com v26.0
-- 注意: impressions は 2025-04-21 全廃のため使用しない → views を使用
--       profile_views / website_clicks は 2024-10-02 削除 → profile_links_taps を使用

CREATE TABLE IF NOT EXISTS sf_instagram_account_daily (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  date                  TEXT    NOT NULL,            -- YYYY-MM-DD（スナップショット日）
  followers_count       INTEGER,                     -- /me followers_count
  follows_count         INTEGER,                     -- /me follows_count（フォロー数）
  media_count           INTEGER,                     -- /me media_count（投稿総数）
  reach                 INTEGER,                     -- insights reach (period=day)
  views                 INTEGER,                     -- insights views (period=day) ← impressions後継
  accounts_engaged      INTEGER,                     -- insights accounts_engaged (period=day)
  total_interactions    INTEGER,                     -- insights total_interactions (period=day)
  likes                 INTEGER,                     -- insights likes (period=day)
  comments              INTEGER,                     -- insights comments (period=day)
  shares                INTEGER,                     -- insights shares (period=day)
  saves                 INTEGER,                     -- insights saves (period=day)
  follows_and_unfollows INTEGER,                     -- insights follows_and_unfollows (period=day)
  profile_links_taps    INTEGER,                     -- insights profile_links_taps (period=day)
  import_source         TEXT    NOT NULL DEFAULT 'api'
    CHECK (import_source IN ('api', 'manual')),
  fetched_at            TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
  UNIQUE(date)
);
CREATE INDEX IF NOT EXISTS idx_sf_ig_account_date ON sf_instagram_account_daily(date);

-- ── Instagram メディア台帳（Phase 6）────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS sf_instagram_media (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  instagram_media_id TEXT    NOT NULL UNIQUE,        -- Instagram の media ID（文字列）
  media_type         TEXT    NOT NULL
    CHECK (media_type IN ('IMAGE', 'VIDEO', 'CAROUSEL_ALBUM', 'REELS')),
  media_product_type TEXT                            -- FEED | REELS
    CHECK (media_product_type IN ('FEED', 'REELS') OR media_product_type IS NULL),
  published_at       TEXT,                           -- ISO 8601 投稿日時
  caption            TEXT,
  permalink          TEXT,
  import_source      TEXT    NOT NULL DEFAULT 'api'
    CHECK (import_source IN ('api', 'manual')),
  created_at         TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
);
CREATE INDEX IF NOT EXISTS idx_sf_ig_media_published ON sf_instagram_media(published_at);
CREATE INDEX IF NOT EXISTS idx_sf_ig_media_type      ON sf_instagram_media(media_product_type);

-- ── Instagram メディア日次スナップショット（Phase 6）────────────────────────────
-- 直接フィールド（/media?fields=...）と insights edge（/{media-id}/insights）の両方を格納
-- avg_watch_time_ms はリール専用（ig_reels_avg_watch_time）

CREATE TABLE IF NOT EXISTS sf_instagram_media_daily (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  instagram_media_id TEXT    NOT NULL REFERENCES sf_instagram_media(instagram_media_id),
  date               TEXT    NOT NULL,               -- スナップショット日 YYYY-MM-DD
  like_count         INTEGER,                        -- 直接フィールド
  comments_count     INTEGER,                        -- 直接フィールド
  view_count         INTEGER,                        -- 直接フィールド（再生・表示数）
  shares_count       INTEGER,                        -- 直接フィールド（2026-04追加）
  saved_count        INTEGER,                        -- 直接フィールド（2026-04追加）
  reposts_count      INTEGER,                        -- 直接フィールド（2026-04追加）
  reach              INTEGER,                        -- insights edge: reach
  profile_visits     INTEGER,                        -- insights edge: profile_visits
  avg_watch_time_ms  INTEGER,                        -- insights edge: ig_reels_avg_watch_time（リールのみ）
  import_source      TEXT    NOT NULL DEFAULT 'api'
    CHECK (import_source IN ('api', 'manual')),
  fetched_at         TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
  UNIQUE(instagram_media_id, date)
);
CREATE INDEX IF NOT EXISTS idx_sf_ig_media_daily_date  ON sf_instagram_media_daily(date);
CREATE INDEX IF NOT EXISTS idx_sf_ig_media_daily_media ON sf_instagram_media_daily(instagram_media_id);

-- ── YouTube チャンネル日次スナップショット（Phase 7）────────────────────────────
-- YouTube Analytics API v2 + YouTube Data API v3
--
-- 取得方法:
--   subscribers_count         → YouTube Data API v3: channels?mine=true&part=statistics
--   subscribers_gained/lost   → Analytics API: metrics=subscribersGained,subscribersLost
--   views                     → Analytics API: metrics=views (channel=MINE / dimensions=day)
--   estimated_minutes_watched → Analytics API: metrics=estimatedMinutesWatched
--   average_view_duration_sec → Analytics API: metrics=averageViewDuration（秒）
--
-- Phase 7 では取得しない指標（NULL 予約）:
--   impressions / ctr         → サムネイルインプレッション・CTR。
--                               YouTube Analytics API v2 channel reports での安定取得が
--                               保証されない（YouTube Reporting API Reach report が必要な場合あり）。
--                               将来 Reporting API 対応後に書き込む予定。列は NULL 予約済み。
--   収益データ                → monetization 権限が必要
--   ユニーク視聴者数          → video フィルタ時 estimatedUniqueViewers が unavailable
--   低評価数 (dislikes)        → Phase 7 では取得対象外。一般公開値ではないが
--                               動画所有者として認証されたAPIリクエストでは取得可能。
--                               現時点の JARVIS では利用しない。
--   リアルタイムデータ        → 24-48h のレポートラグあり
--
-- 動画別データは sf_content_registry (platform='youtube') + sf_social_metrics +
-- sf_platform_ext（avg_view_percentage 等）に格納する（既存テーブル流用）。

CREATE TABLE IF NOT EXISTS sf_youtube_channel_daily (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  date                      TEXT    NOT NULL,              -- YYYY-MM-DD
  subscribers_count         INTEGER,                       -- 総登録者数（Data API）
  subscribers_gained        INTEGER,                       -- 期間内新規登録者数（Analytics）
  subscribers_lost          INTEGER,                       -- 期間内登録解除数（Analytics）
  views                     INTEGER,                       -- 期間内再生回数（Analytics）
  estimated_minutes_watched INTEGER,                       -- 総視聴時間（分）（Analytics）
  average_view_duration_sec INTEGER,                       -- 平均視聴時間（秒）（Analytics）
  impressions               INTEGER,                       -- NULL 予約（Reporting API 対応後）
  ctr                       REAL,                          -- NULL 予約（Reporting API 対応後）
  import_source             TEXT    NOT NULL DEFAULT 'api'
    CHECK (import_source IN ('api', 'manual')),
  fetched_at                TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
  UNIQUE(date)
);
CREATE INDEX IF NOT EXISTS idx_sf_yt_channel_date ON sf_youtube_channel_daily(date);

-- ── YouTube トラフィックソース（Phase 7）────────────────────────────────────────
-- YouTube Analytics API v2: dimensions=insightTrafficSourceType
-- 期間集計（period_start〜period_end）でトラフィック流入元ごとの再生数・視聴時間を保存。
--
-- 代表的な source_type 値（API 返り値そのまま保存）:
--   YT_SEARCH         → YouTube 検索
--   SUGGESTED         → 関連動画
--   EXTERNAL          → 外部リンク（Twitter/Web 等）
--   PLAYLIST          → プレイリスト
--   DIRECT_OR_UNKNOWN → 直接アクセス or 不明
--   CHANNEL           → チャンネルページ
--   NOTIFICATION      → 通知
--   EXT_URL           → 外部 URL（Embedded 含む）

CREATE TABLE IF NOT EXISTS sf_youtube_traffic_sources (
  id                        INTEGER PRIMARY KEY AUTOINCREMENT,
  period_start              TEXT    NOT NULL,              -- 取得期間開始 YYYY-MM-DD
  period_end                TEXT    NOT NULL,              -- 取得期間終了 YYYY-MM-DD
  source_type               TEXT    NOT NULL,              -- insightTrafficSourceType の値
  views                     INTEGER,                       -- 期間内再生数
  estimated_minutes_watched INTEGER,                       -- 期間内総視聴時間（分）
  fetched_at                TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
  UNIQUE(period_start, period_end, source_type)
);
CREATE INDEX IF NOT EXISTS idx_sf_yt_traffic_period
  ON sf_youtube_traffic_sources(period_start, period_end);

-- ── Ops 同期状態（Phase 10）──────────────────────────────────────────────────
-- 各データソースの自動/手動取得の運用状態を永続化する。
-- 分析データ本体はここへコピーしない（運用状態のみ）。
-- source of truth は各分析テーブルの MAX(date)。
-- このテーブルは最終試行・失敗カウント・通知抑制などの運用情報だけを保持する。

CREATE TABLE IF NOT EXISTS sf_sync_state (
  source               TEXT    PRIMARY KEY,                -- source identifier (e.g. 'instagram')
  mode                 TEXT    NOT NULL DEFAULT 'manual'
    CHECK (mode IN ('auto', 'manual')),
  last_attempt_at      TEXT,                               -- ISO8601
  last_success_at      TEXT,                               -- ISO8601
  last_data_date       TEXT,                               -- YYYY-MM-DD（取得成功時のデータ末尾日）
  status               TEXT    NOT NULL DEFAULT 'never_synced'
    CHECK (status IN ('fresh','stale','never_synced','unconfigured','error','manual_required')),
  last_error           TEXT,                               -- エラーメッセージ（最新）
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  last_notified_at     TEXT,                               -- 通知重複抑制用
  snoozed_until        TEXT,                               -- この日時まで通知しない
  updated_at           TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Phase 12: X（旧Twitter）Analytics — ツイート実績・反応記録
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- 取得方式: B（CSV エクスポート）
--   X Analytics（analytics.twitter.com）→ Export Data → CSV
--   ツイート別累計指標（インプレッション・エンゲージメント等）を手動取込。
--
-- 取得不可指標:
--   フォロワー日次推移 → X Analytics CSV 非提供（API または手動のみ）
--   プロモーション指標 → 広告なしアカウントは常に 0 / NULL
--   ユニークリーチ     → X Analytics CSV では提供されない
--
-- 禁止事項:
--   異なる指標の合算による「人気度」算出
--   フォロワー個人識別・他 SNS との人物照合
--   非公式 API・スクレイピング・セッション流用
--

-- ── X ツイート台帳（Phase 12）────────────────────────────────────────────────
-- tweet_id: X の数値 ID（文字列として保存）
-- text_snippet: 本文先頭 140 文字のみ（識別用・個人情報除外済）
-- tweet_type: text prefix による推定（RT @ → retweet / @ → reply / else → tweet）

CREATE TABLE IF NOT EXISTS sf_x_tweet (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  tweet_id      TEXT    NOT NULL UNIQUE,
  published_at  TEXT,                           -- 投稿日時（ISO 8601 または YYYY-MM-DD HH:MM）
  text_snippet  TEXT,                           -- 本文先頭 140 文字（識別用のみ）
  tweet_type    TEXT    NOT NULL DEFAULT 'tweet'
    CHECK (tweet_type IN ('tweet', 'reply', 'retweet', 'quote')),
  import_source TEXT    NOT NULL DEFAULT 'csv'
    CHECK (import_source IN ('csv', 'manual')),
  created_at    TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
);

-- ── X ツイート別指標スナップショット（Phase 12）─────────────────────────────
-- X Analytics CSV エクスポートからの累計指標。
-- UNIQUE(tweet_id, snapshot_date): 同じ CSV を再インポートしても冪等。
-- engagements: X Analytics が提供する合計エンゲージメント数（内訳の合算ではない）。

CREATE TABLE IF NOT EXISTS sf_x_tweet_metrics (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  tweet_id           TEXT    NOT NULL REFERENCES sf_x_tweet(tweet_id),
  snapshot_date      TEXT    NOT NULL,          -- エクスポート取得日 YYYY-MM-DD
  impressions        INTEGER,                   -- インプレッション数
  engagements        INTEGER,                   -- エンゲージメント数合計（X Analytics 提供値）
  retweets           INTEGER,                   -- リツイート数
  replies            INTEGER,                   -- リプライ数
  likes              INTEGER,                   -- いいね数
  url_clicks         INTEGER,                   -- URL クリック数
  profile_clicks     INTEGER,                   -- プロフィールクリック数
  detail_expands     INTEGER,                   -- 詳細展開数
  media_views        INTEGER,                   -- メディア表示数
  media_engagements  INTEGER,                   -- メディアエンゲージメント数
  import_source      TEXT    NOT NULL DEFAULT 'csv'
    CHECK (import_source IN ('csv', 'manual')),
  fetched_at         TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
  UNIQUE(tweet_id, snapshot_date)
);

CREATE INDEX IF NOT EXISTS idx_sf_x_tweet_published  ON sf_x_tweet(published_at);
CREATE INDEX IF NOT EXISTS idx_sf_x_metrics_date     ON sf_x_tweet_metrics(snapshot_date);
CREATE INDEX IF NOT EXISTS idx_sf_x_metrics_tweet    ON sf_x_tweet_metrics(tweet_id);

-- ── X アカウント日次スナップショット（Phase 12）─────────────────────────────
-- フォロワー数等。CSV エクスポートでは提供されないため手動入力または将来 API 対応。
-- import_source='csv' は将来 X Analytics が account CSV を提供した場合に備えた予約。

CREATE TABLE IF NOT EXISTS sf_x_account_daily (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  date            TEXT    NOT NULL UNIQUE,      -- YYYY-MM-DD
  followers_count INTEGER,                      -- フォロワー総数（手動入力）
  import_source   TEXT    NOT NULL DEFAULT 'manual'
    CHECK (import_source IN ('api', 'csv', 'manual')),
  fetched_at      TEXT    NOT NULL DEFAULT (datetime('now', 'localtime'))
);

CREATE INDEX IF NOT EXISTS idx_sf_x_account_date ON sf_x_account_daily(date);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Phase 13: KDP（Kindle Direct Publishing）Analytics — 電子書籍実績管理
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- 取得方式: MANUAL（公式 KDP レポート TSV/CSV エクスポート）
--   kdp.amazon.co.jp → レポート → 各タブ → ダウンロード
--   スクレイピング・非公式API・セッション流用は禁止。
--
-- テーブル命名規則: kdp_* （ビジネス全体共通基盤 / sf_ プレフィックスなし）
-- Snow flakes 固有の接続: sf_kdp_book_map を経由
--
-- 重要制約:
--   - 通貨合算禁止（JPY / USD / GBP は別レコード）
--   - 指標の混在禁止（Orders ≠ KENP ≠ Royalty ≠ Payment）
--   - sf_revenue への書き込みは sf_kdp_book_map 登録本のみ
--   - ASIN が本の一次識別子（eBook と Paperback は別 ASIN = 別レコード）
--

-- ── KDP 本台帳 ────────────────────────────────────────────────────────────────
-- ASIN PRIMARY UNIQUE。同一作品でも eBook/Paperback は別 ASIN。

CREATE TABLE IF NOT EXISTS kdp_books (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  asin       TEXT    NOT NULL UNIQUE,             -- Amazon 標準識別番号（10文字英数字）
  isbn       TEXT,                                -- ISBN-13（任意）
  title      TEXT    NOT NULL,                    -- 書籍タイトル
  author     TEXT,                                -- 著者名（任意）
  format     TEXT                                 -- 'ebook' / 'paperback' / 'hardcover' / 'other'
    CHECK (format IN ('ebook','paperback','hardcover','other') OR format IS NULL),
  memo       TEXT,
  created_at TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE INDEX IF NOT EXISTS idx_kdp_books_asin  ON kdp_books(asin);
CREATE INDEX IF NOT EXISTS idx_kdp_books_title ON kdp_books(title);

-- ── KDP 日次注文（Orders Report）─────────────────────────────────────────────
-- 日次注文ユニット数（有料・無料）
-- UNIQUE(date, book_id, marketplace) で同一 CSV の再インポートが冪等

CREATE TABLE IF NOT EXISTS kdp_orders_daily (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  date        TEXT    NOT NULL,                   -- YYYY-MM-DD
  book_id     INTEGER NOT NULL REFERENCES kdp_books(id),
  marketplace TEXT    NOT NULL,                   -- 'amazon.co.jp' など
  paid_units  INTEGER,                            -- 有料注文数
  free_units  INTEGER,                            -- 無料注文数（KDP Select 等）
  fetched_at  TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE(date, book_id, marketplace)
);

CREATE INDEX IF NOT EXISTS idx_kdp_orders_date    ON kdp_orders_daily(date);
CREATE INDEX IF NOT EXISTS idx_kdp_orders_book    ON kdp_orders_daily(book_id);

-- ── KDP 日次 KENP（KENP Report）──────────────────────────────────────────────
-- Kindle Edition Normalized Pages（Kindle Unlimited 読み取りページ数）
-- UNIQUE(date, book_id, marketplace) で冪等

CREATE TABLE IF NOT EXISTS kdp_kenp_daily (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  date        TEXT    NOT NULL,                   -- YYYY-MM-DD
  book_id     INTEGER NOT NULL REFERENCES kdp_books(id),
  marketplace TEXT    NOT NULL,
  kenp_read   INTEGER,                            -- 読み取りページ数
  fetched_at  TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE(date, book_id, marketplace)
);

CREATE INDEX IF NOT EXISTS idx_kdp_kenp_date ON kdp_kenp_daily(date);
CREATE INDEX IF NOT EXISTS idx_kdp_kenp_book ON kdp_kenp_daily(book_id);

-- ── KDP 月次ロイヤリティ（Royalties Report）──────────────────────────────────
-- 月次確定ロイヤリティ。通貨別保持（合算禁止）。
-- transaction_type: royalty / ku_koll / refund / free / other
-- UNIQUE(royalty_month, book_id, marketplace, transaction_type) で冪等

CREATE TABLE IF NOT EXISTS kdp_royalties (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  royalty_month    TEXT    NOT NULL,              -- YYYY-MM（レポート対象月）
  book_id          INTEGER NOT NULL REFERENCES kdp_books(id),
  marketplace      TEXT    NOT NULL,              -- 'amazon.co.jp' など
  transaction_type TEXT    NOT NULL DEFAULT 'royalty'
    CHECK (transaction_type IN ('royalty','ku_koll','refund','free','other')),
  units_sold       INTEGER,                       -- 販売ユニット数
  units_refunded   INTEGER,                       -- 返金ユニット数
  net_units        INTEGER,                       -- 正味ユニット数
  royalty_amount   REAL,                          -- ロイヤリティ金額（通貨別）
  currency         TEXT    NOT NULL DEFAULT 'JPY',
  fetched_at       TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE(royalty_month, book_id, marketplace, transaction_type)
);

CREATE INDEX IF NOT EXISTS idx_kdp_royalties_month ON kdp_royalties(royalty_month);
CREATE INDEX IF NOT EXISTS idx_kdp_royalties_book  ON kdp_royalties(book_id);

-- ── KDP 支払い履歴（Payments Report）────────────────────────────────────────
-- 実際の支払いトランザクション。UNIQUE(payment_number, marketplace) で冪等。
-- 通貨は保存するが JPY / USD の混合合算は禁止。

CREATE TABLE IF NOT EXISTS kdp_payments (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_number  TEXT    NOT NULL,               -- KDP 支払い識別番号
  marketplace     TEXT    NOT NULL,
  sales_period    TEXT,                           -- 対象販売期間（YYYY-MM 等）
  payment_status  TEXT,                           -- 'Paid', 'Pending' など
  payment_date    TEXT,                           -- 支払日 YYYY-MM-DD
  payment_method  TEXT,                           -- 'Wire Transfer' など
  net_earnings    REAL,                           -- 正味収益
  currency        TEXT    NOT NULL DEFAULT 'JPY',
  fx_rate         REAL,                           -- 為替レート（USD→JPY 等、任意）
  payment_amount  REAL,                           -- 実際の支払金額
  tax_withholding REAL,                           -- 源泉徴収額
  fetched_at      TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE(payment_number, marketplace)
);

CREATE INDEX IF NOT EXISTS idx_kdp_payments_date ON kdp_payments(payment_date);

-- ── KDP インポートログ ────────────────────────────────────────────────────────
-- 各レポートのインポート結果を記録する（監査用）。

CREATE TABLE IF NOT EXISTS kdp_import_log (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  report_type      TEXT    NOT NULL
    CHECK (report_type IN ('orders','kenp','royalties','payments')),
  file_name        TEXT,
  file_fingerprint TEXT,                          -- ファイルハッシュ（重複検出用、任意）
  report_period    TEXT,                          -- YYYY-MM など
  row_count        INTEGER DEFAULT 0,
  imported_count   INTEGER DEFAULT 0,
  skipped_count    INTEGER DEFAULT 0,
  warning_count    INTEGER DEFAULT 0,
  imported_at      TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);

-- ── Snow flakes ↔ KDP 本マッピング ──────────────────────────────────────────
-- KDP 本（ASIN 単位）を Snow flakes 作品（sf_works）に明示的に紐付ける。
-- UNIQUE(book_id): 1 ASIN → 最大 1 作品のみ（複数 ASIN が同一作品に対応可）。
-- このテーブルに登録されていない本は sf_revenue に書き込まれない。

CREATE TABLE IF NOT EXISTS sf_kdp_book_map (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  book_id    INTEGER NOT NULL UNIQUE REFERENCES kdp_books(id),
  work_id    INTEGER NOT NULL REFERENCES sf_works(id),
  created_at TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE INDEX IF NOT EXISTS idx_sf_kdp_map_work ON sf_kdp_book_map(work_id);

-- ── sf_revenue — KDP 用部分 UNIQUE インデックス ──────────────────────────────
-- platform='kdp' の電子書籍ロイヤリティ。通貨別・作品別・月別で1行。
-- source='電子書籍', platform='kdp', work_id NOT NULL, track_id IS NULL が対象。
-- 通貨が異なれば別行として保持（JPY/USD 混合合算禁止）。

CREATE UNIQUE INDEX IF NOT EXISTS idx_sf_revenue_kdp
  ON sf_revenue(month, platform, work_id, currency)
  WHERE platform = 'kdp' AND work_id IS NOT NULL AND track_id IS NULL;

-- ═══════════════════════════════════════════════════════════════════════════════
-- Phase 14: note Workflow — 記事企画・下書き・投稿管理
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- 設計原則:
--   - MANUAL workflow のみ。note への自動ログイン・自動投稿は一切禁止。
--   - 認証情報・パスワード・セッション・cookie は格納しない。
--   - 記事本文と公開 URL の管理を分離。
--   - status が 'published' 以外の記事は公開済み扱いしない。
--   - export は投稿用コンテンツ生成のみ。公開はユーザーが手動で行う。
--
-- status 遷移:
--   idea → draft → review → ready → scheduled → published → archived
--   published 後は archived のみ許可。
--
-- article_type: CHECK 制約なし（将来の追加を妨げないオープンエンド設計）
-- tags: JSON 配列文字列（例: '["Snow flakes","制作日記"]'）
-- note_url: ユーザーが投稿後に手動記録。JARVIS は自動投稿しない。
--

CREATE TABLE IF NOT EXISTS sf_note_article (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  title              TEXT    NOT NULL,                    -- 記事タイトル
  internal_key       TEXT    UNIQUE,                      -- 内部スラッグ（任意・重複不可）
  article_type       TEXT,                                -- カテゴリ（オープンエンド）
  status             TEXT    NOT NULL DEFAULT 'idea'
    CHECK (status IN ('idea','draft','review','ready','scheduled','published','archived')),
  summary            TEXT,                                -- 記事概要（短文）
  body_markdown      TEXT,                                -- 本文（Markdown）
  tags               TEXT,                                -- JSON配列文字列
  magazine           TEXT,                                -- マガジン名
  related_work_id    INTEGER REFERENCES sf_works(id),     -- 関連作品
  related_track_id   INTEGER REFERENCES sf_tracks(id),    -- 関連楽曲
  related_release_id INTEGER REFERENCES sf_releases(id),  -- 関連リリース
  scheduled_date     TEXT,                                -- 公開予定日 YYYY-MM-DD
  published_date     TEXT,                                -- 実際の公開日 YYYY-MM-DD
  note_url           TEXT,                                -- note公開URL（手動記録）
  created_at         TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at         TEXT    NOT NULL DEFAULT (datetime('now','localtime'))
);

CREATE INDEX IF NOT EXISTS idx_sf_note_status    ON sf_note_article(status);
CREATE INDEX IF NOT EXISTS idx_sf_note_scheduled ON sf_note_article(scheduled_date);
CREATE INDEX IF NOT EXISTS idx_sf_note_type      ON sf_note_article(article_type);

-- ═══════════════════════════════════════════════════════════════════════════════
-- Phase 17: Business Invoice Import — 請求書Excel取込・仕事実績分析
-- ═══════════════════════════════════════════════════════════════════════════════
--
-- 設計原則:
--   - 個人情報（住所・電話・メール・口座）は一切保存しない
--   - description は元の作業内容を絶対に書き換えない
--   - invoice_status は 'invoiced' 固定。入金済みは別管理
--   - 同一請求書番号は1件のみ（UNIQUE(invoice_number) で重複防止）
--   - 同一請求書の同一行は1件のみ（UNIQUE(invoice_id, source_row) で重複防止）
--   - category は自動分類（ルールベース）。後から変更可能な構造
--   - job_id は将来 Google Calendar 連携用（現在は NULL でよい）
--

CREATE TABLE IF NOT EXISTS business_invoice_imports (
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
);

CREATE INDEX IF NOT EXISTS idx_bii_filename ON business_invoice_imports(source_filename);
CREATE INDEX IF NOT EXISTS idx_bii_hash     ON business_invoice_imports(file_hash);

CREATE TABLE IF NOT EXISTS business_invoices (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  import_id       INTEGER NOT NULL REFERENCES business_invoice_imports(id),
  client_name     TEXT    NOT NULL DEFAULT '株式会社オーテック',
  invoice_number  TEXT    NOT NULL,
  invoice_date    TEXT,                            -- YYYY-MM-DD
  due_date        TEXT,                            -- YYYY-MM-DD（将来拡張用）
  subtotal        INTEGER NOT NULL DEFAULT 0,      -- 税抜合計（明細の積み上げ）
  tax             INTEGER NOT NULL DEFAULT 0,      -- 消費税額
  total           INTEGER NOT NULL DEFAULT 0,      -- 税込合計（Excelの請求金額）
  source_sheet    TEXT    NOT NULL,
  source_filename TEXT    NOT NULL,
  created_at      TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  -- (invoice_number, source_sheet) の組み合わせで重複防止
  -- シート名誤記で同番号が複数存在する場合は別シートとして区別
  UNIQUE(invoice_number, source_sheet)
);

CREATE INDEX IF NOT EXISTS idx_bi_invoice_date ON business_invoices(invoice_date);
CREATE INDEX IF NOT EXISTS idx_bi_client       ON business_invoices(client_name);
CREATE INDEX IF NOT EXISTS idx_bi_import       ON business_invoices(import_id);

CREATE TABLE IF NOT EXISTS business_invoice_lines (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id      INTEGER NOT NULL REFERENCES business_invoices(id),
  work_date       TEXT,                            -- YYYY-MM-DD（明細記載の仕事日）
  description     TEXT    NOT NULL,                -- 元の作業内容（絶対に書き換えない）
  quantity        REAL    NOT NULL DEFAULT 1,
  quantity_unit   TEXT    NOT NULL DEFAULT '日',
  unit_price      INTEGER NOT NULL DEFAULT 0,
  amount          INTEGER NOT NULL DEFAULT 0,      -- 税抜金額
  category        TEXT    NOT NULL DEFAULT 'その他', -- 自動分類（ルールベース・変更可）
  job_id          TEXT,                            -- 将来 Google Calendar 紐付け用
  source_row      INTEGER NOT NULL,                -- Excelの行番号（1始まり）
  created_at      TEXT    NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE(invoice_id, source_row)                  -- 同一請求書の同一行は1件のみ
);

CREATE INDEX IF NOT EXISTS idx_bil_invoice   ON business_invoice_lines(invoice_id);
CREATE INDEX IF NOT EXISTS idx_bil_work_date ON business_invoice_lines(work_date);
CREATE INDEX IF NOT EXISTS idx_bil_category  ON business_invoice_lines(category);

-- ─── Phase 18: Google Calendar 双方向同期 ──────────────────────────────────────
--
-- business_calendar_links      invoice_line ↔ Google Calendar イベントの紐付け
-- business_calendar_sync_runs  同期実行履歴
-- business_calendar_imports    Google Calendar → JARVIS 取込候補（将来用）
--

-- invoice_line ↔ Calendar イベント 1:1 リンク
CREATE TABLE IF NOT EXISTS business_calendar_links (
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
);

CREATE INDEX IF NOT EXISTS idx_bcl_line   ON business_calendar_links(invoice_line_id);
CREATE INDEX IF NOT EXISTS idx_bcl_event  ON business_calendar_links(google_calendar_id, google_event_id);

-- 同期実行履歴
CREATE TABLE IF NOT EXISTS business_calendar_sync_runs (
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
);

CREATE INDEX IF NOT EXISTS idx_bcsr_dir ON business_calendar_sync_runs(direction, started_at);

-- Google Calendar → JARVIS 取込候補（将来用: 新規仕事予定の取込）
CREATE TABLE IF NOT EXISTS business_calendar_imports (
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
);

CREATE INDEX IF NOT EXISTS idx_bci_event  ON business_calendar_imports(google_calendar_id, google_event_id);
CREATE INDEX IF NOT EXISTS idx_bci_status ON business_calendar_imports(import_status);
