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
