/**
 * content_business/db_migration.mjs
 * 出版事業部 テーブル作成・マイグレーション（冪等）
 */

const TABLES_SQL = `
-- プロジェクト（1テーマ = 1プロジェクト）
CREATE TABLE IF NOT EXISTS cb_projects (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  theme         TEXT,
  genre         TEXT,
  target_reader TEXT,
  price_range   TEXT,
  status        TEXT NOT NULL DEFAULT 'RESEARCH'
    CHECK (status IN (
      'RESEARCH','ANALYSIS','IDEA_REVIEW','OWNER_IDEA_APPROVAL',
      'WRITING','EDITING','AUTO_REVISION','APPROVAL_WAIT',
      'APPROVED','PUBLISHED','MEASURING','NEEDS_HUMAN_REVIEW','ERROR','CANCELLED'
    )),
  selected_idea_index INTEGER,
  revision_count      INTEGER NOT NULL DEFAULT 0,
  research_count      INTEGER NOT NULL DEFAULT 0,
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_cb_projects_status ON cb_projects(status);

-- ジョブ（各ステップの実行記録）
CREATE TABLE IF NOT EXISTS cb_jobs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER NOT NULL REFERENCES cb_projects(id),
  job_type    TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','RUNNING','DONE','ERROR')),
  started_at  DATETIME,
  finished_at DATETIME,
  retry_count INTEGER NOT NULL DEFAULT 0,
  error_message TEXT,
  payload_json  TEXT,
  result_json   TEXT,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_cb_jobs_status  ON cb_jobs(status);
CREATE INDEX IF NOT EXISTS idx_cb_jobs_project ON cb_jobs(project_id);

-- 市場調査アイテム（最大30件）
CREATE TABLE IF NOT EXISTS cb_research_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER NOT NULL REFERENCES cb_projects(id),
  url         TEXT,
  title       TEXT,
  author      TEXT,
  price       TEXT,
  published_at TEXT,
  target_reader TEXT,
  problem_solved TEXT,
  free_content  TEXT,
  table_of_contents TEXT,
  cta           TEXT,
  reaction_metrics TEXT,
  notes         TEXT,
  source        TEXT,
  fetch_ok      INTEGER NOT NULL DEFAULT 1 CHECK (fetch_ok IN (0,1)),
  fetch_error   TEXT,
  fetched_at    DATETIME,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_cb_research_project ON cb_research_items(project_id);

-- 商品企画案（Plannerが3案出力）
CREATE TABLE IF NOT EXISTS cb_ideas (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER NOT NULL REFERENCES cb_projects(id),
  idea_index  INTEGER NOT NULL,
  title       TEXT,
  target_reader TEXT,
  problem     TEXT,
  value       TEXT,
  uniqueness  TEXT,
  rationale   TEXT,
  structure   TEXT,
  price_range TEXT,
  workload    TEXT,
  raw_json    TEXT,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_cb_ideas_project ON cb_ideas(project_id);

-- 記事ドラフト（Writer/Editorのやり取り）
CREATE TABLE IF NOT EXISTS cb_article_drafts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER NOT NULL REFERENCES cb_projects(id),
  version     INTEGER NOT NULL DEFAULT 1,
  title_candidates TEXT,
  lead        TEXT,
  free_part   TEXT,
  paid_part   TEXT,
  summary     TEXT,
  editor_verdict TEXT
    CHECK (editor_verdict IN ('READY','REVISION_REQUIRED','BLOCKED') OR editor_verdict IS NULL),
  editor_notes TEXT,
  revision_request TEXT,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_cb_drafts_project ON cb_article_drafts(project_id);

-- 売上データ（Growth分析用）
CREATE TABLE IF NOT EXISTS cb_sales_records (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id  INTEGER NOT NULL REFERENCES cb_projects(id),
  record_date TEXT NOT NULL,
  pv          INTEGER,
  purchase_count INTEGER,
  revenue     INTEGER,
  price       INTEGER,
  sns_traffic TEXT,
  memo        TEXT,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_cb_sales_project ON cb_sales_records(project_id);
`;

// Chat起点ドラフトテーブル（Chatから生成された記事を保存）
const CB_CHAT_DRAFTS_SQL = `
CREATE TABLE IF NOT EXISTS cb_chat_drafts (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id           INTEGER REFERENCES cb_projects(id),
  chat_session_id      INTEGER REFERENCES cb_chat_sessions(id),
  parent_draft_id      INTEGER REFERENCES cb_chat_drafts(id),
  version              INTEGER NOT NULL DEFAULT 1,
  title                TEXT,
  lead                 TEXT,
  free_part            TEXT,
  paid_part            TEXT,
  summary              TEXT,
  full_content         TEXT,
  word_count           INTEGER,
  created_by           TEXT NOT NULL DEFAULT 'Writer',
  status               TEXT NOT NULL DEFAULT 'DRAFT'
    CHECK (status IN ('DRAFT','READY','EDITOR_CHECK','APPROVED')),
  revision_instruction TEXT,
  editor_verdict       TEXT,
  editor_notes         TEXT,
  created_at           DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at           DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_cb_chat_drafts_session ON cb_chat_drafts(chat_session_id);
CREATE INDEX IF NOT EXISTS idx_cb_chat_drafts_project ON cb_chat_drafts(project_id);
`;

// Chat / AI編集会議テーブル
const CB_CHAT_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS cb_chat_sessions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id   INTEGER REFERENCES cb_projects(id),
  employee_id  TEXT NOT NULL,
  session_type TEXT NOT NULL DEFAULT 'EMPLOYEE'
    CHECK (session_type IN ('EMPLOYEE','MEETING')),
  topic        TEXT,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_cb_chat_sessions_project ON cb_chat_sessions(project_id);

CREATE TABLE IF NOT EXISTS cb_chat_messages (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id   INTEGER NOT NULL REFERENCES cb_chat_sessions(id),
  speaker      TEXT NOT NULL,
  message      TEXT NOT NULL,
  metadata_json TEXT,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_cb_chat_messages_session ON cb_chat_messages(session_id);
`;

// 既存 cb_research_items テーブルへのカラム追加マイグレーション
const CB_RESEARCH_MIGRATIONS = [
  "ALTER TABLE cb_research_items ADD COLUMN source TEXT",
  "ALTER TABLE cb_research_items ADD COLUMN fetch_ok INTEGER NOT NULL DEFAULT 1 CHECK (fetch_ok IN (0,1))",
  "ALTER TABLE cb_research_items ADD COLUMN fetch_error TEXT",
  "ALTER TABLE cb_research_items ADD COLUMN fetched_at DATETIME",
];

// cb_projects テーブルへのカラム追加マイグレーション
const CB_PROJECTS_MIGRATIONS = [
  "ALTER TABLE cb_projects ADD COLUMN is_pinned INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE cb_projects ADD COLUMN note_url TEXT",
  // DROPPED 機能
  "ALTER TABLE cb_projects ADD COLUMN is_dropped INTEGER NOT NULL DEFAULT 0",
  "ALTER TABLE cb_projects ADD COLUMN dropped_at DATETIME",
  "ALTER TABLE cb_projects ADD COLUMN prev_status TEXT",
  // owner-review エラー表示用
  "ALTER TABLE cb_projects ADD COLUMN owner_review_error TEXT",
];

// cb_sales_records テーブルへのカラム追加マイグレーション
const CB_SALES_RECORDS_MIGRATIONS = [
  "ALTER TABLE cb_sales_records ADD COLUMN milestone TEXT",
];

// 事実確認結果テーブル（本人レビューFACT_CHECKモード用）
const CB_FACT_CHECK_SQL = `
CREATE TABLE IF NOT EXISTS cb_fact_check_results (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    INTEGER NOT NULL REFERENCES cb_projects(id),
  draft_id      INTEGER REFERENCES cb_article_drafts(id),
  instruction   TEXT,
  fact_list     TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','CONFIRMED')),
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_cb_fact_check_project ON cb_fact_check_results(project_id);
`;

// 直接企画依頼テーブル（アサヒへの直接依頼）
const CB_DIRECT_PLANS_SQL = `
CREATE TABLE IF NOT EXISTS cb_direct_plans (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id    INTEGER REFERENCES cb_projects(id),
  theme         TEXT NOT NULL,
  purpose       TEXT,
  usable_facts  TEXT,
  avoid         TEXT,
  notes         TEXT,
  plan_json     TEXT,
  status        TEXT NOT NULL DEFAULT 'PENDING'
    CHECK (status IN ('PENDING','APPROVED','DROPPED')),
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);
`;

// ── Phase 42: AI社員 人格・人間関係システム ────────────────────────────────────

/**
 * cb_employee_relationships — 6名の双方向関係マスタ（30件）
 *
 * スコア仕様:
 *   trust / affection / respect : -100〜+100（負 = 不信・嫌い・軽蔑）
 *   rivalry / discomfort        :   0〜+100（負値なし）
 *   romantic_interest           :   0〜+100（負値なし。最大100で頭打ち）
 *
 * is_secret = 1 の行は通常APIに含めない。管理モード(X-Management-Mode: 1)のみ公開。
 */
const CB_RELATIONSHIP_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS cb_employee_relationships (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  from_emp            TEXT NOT NULL,
  to_emp              TEXT NOT NULL,
  -- ── スコア ──────────────────────────────────────
  trust               INTEGER NOT NULL DEFAULT 40
    CHECK (trust               BETWEEN -100 AND 100),
  affection           INTEGER NOT NULL DEFAULT 20
    CHECK (affection           BETWEEN -100 AND 100),
  respect             INTEGER NOT NULL DEFAULT 35
    CHECK (respect             BETWEEN -100 AND 100),
  rivalry             INTEGER NOT NULL DEFAULT 0
    CHECK (rivalry             BETWEEN    0 AND 100),
  discomfort          INTEGER NOT NULL DEFAULT 0
    CHECK (discomfort          BETWEEN    0 AND 100),
  romantic_interest   INTEGER NOT NULL DEFAULT 0
    CHECK (romantic_interest   BETWEEN    0 AND 100),
  -- ── テキスト分類 ────────────────────────────────
  relationship_type   TEXT NOT NULL DEFAULT 'colleague'
    CHECK (relationship_type IN (
      'colleague','friend','rival','crush','mentor_mentee','close_colleague'
    )),
  -- ── 表向き/内面（is_secret=1 の行は管理モードのみ公開） ──
  public_attitude     TEXT,
  private_feeling     TEXT,
  is_secret           INTEGER NOT NULL DEFAULT 0 CHECK (is_secret IN (0,1)),
  -- ── メタ ─────────────────────────────────────────
  last_interaction_at DATETIME,
  updated_at          DATETIME NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE(from_emp, to_emp)
);
CREATE INDEX IF NOT EXISTS idx_cb_rel_from ON cb_employee_relationships(from_emp);
CREATE INDEX IF NOT EXISTS idx_cb_rel_to   ON cb_employee_relationships(to_emp);

-- ── 自律交流ログ ──────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cb_employee_interactions (
  id                     INTEGER PRIMARY KEY AUTOINCREMENT,
  session_date           TEXT NOT NULL,
  from_emp               TEXT NOT NULL,
  to_emp                 TEXT NOT NULL,
  trigger_type           TEXT NOT NULL
    CHECK (trigger_type IN (
      'autonomous','joint_work_success','joint_work_failure',
      'conflict','help','small_talk','incidental'
    )),
  message                TEXT NOT NULL,
  reply                  TEXT,
  relationship_delta_json TEXT,
  token_count            INTEGER NOT NULL DEFAULT 0,
  created_at             DATETIME NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_cb_interact_date ON cb_employee_interactions(session_date);
CREATE INDEX IF NOT EXISTS idx_cb_interact_pair ON cb_employee_interactions(from_emp, to_emp);

-- ── 自律交流 制御設定（key/value） ───────────────────────────────────────────
CREATE TABLE IF NOT EXISTS cb_autonomous_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

// ── Phase 43-A: オフィス観察記録テーブル ─────────────────────────────────────

/**
 * cb_story_events — 社員の活動・感情変化をすべて記録するオフィス観察ログ
 *
 * 設計原則:
 *   - ログは事実のみ記録。is_fictional は常に 0。
 *   - event_uuid で重複を防ぐ（INSERT OR IGNORE）。
 *   - is_secret=1 の行は社長権限（APIレイヤーで認証）のみ閲覧可。
 *   - 既存ログは小説化・要約によって上書き禁止。
 *
 * event_type:
 *   BUSINESS_HANDOFF   : 業務フェーズ引き継ぎ・完了
 *   AUTONOMOUS_CHAT    : 自律交流（P42-C で記録）
 *   RELATIONSHIP_CHANGE: 関係性スコア変化
 *   PERSONALITY_UPDATE : 人格設定変更（将来用）
 *   SYSTEM             : システムイベント
 */
const CB_STORY_TABLES_SQL = `
CREATE TABLE IF NOT EXISTS cb_story_events (
  id           INTEGER  PRIMARY KEY AUTOINCREMENT,
  event_uuid   TEXT     NOT NULL,
  event_date   TEXT     NOT NULL,
  event_time   TEXT     NOT NULL,
  event_type   TEXT     NOT NULL
    CHECK (event_type IN (
      'BUSINESS_HANDOFF','AUTONOMOUS_CHAT','RELATIONSHIP_CHANGE',
      'PERSONALITY_UPDATE','SYSTEM'
    )),
  from_emp     TEXT,
  to_emp       TEXT,
  content_text TEXT     NOT NULL,
  delta_json   TEXT,
  source_type  TEXT,
  source_id    INTEGER,
  is_secret    INTEGER  NOT NULL DEFAULT 0 CHECK (is_secret IN (0,1)),
  is_fictional INTEGER  NOT NULL DEFAULT 0 CHECK (is_fictional IN (0,1)),
  created_at   DATETIME NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE(event_uuid)
);
CREATE INDEX IF NOT EXISTS idx_story_ev_date ON cb_story_events(event_date);
CREATE INDEX IF NOT EXISTS idx_story_ev_emp  ON cb_story_events(from_emp);
CREATE INDEX IF NOT EXISTS idx_story_ev_type ON cb_story_events(event_type);

-- 元イベントIDに基づく安定した重複防止インデックス
-- （UUID + INSERT OR IGNORE だけでは再起動・リトライ時の再処理を防げないため）
-- source_id が NULL の行（きっかけ不明のイベント等）はこの制約の対象外
CREATE UNIQUE INDEX IF NOT EXISTS idx_story_ev_src_dedup
  ON cb_story_events(event_type, source_type, source_id, from_emp, to_emp)
  WHERE source_id IS NOT NULL;

-- 小説執筆制御設定（P43-A/B で参照）
CREATE TABLE IF NOT EXISTS cb_story_settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/**
 * cb_story_settings の初期値を挿入（冪等）
 * @param {import('node:sqlite').DatabaseSync} db
 */
function seedStorySettings(db) {
  const stmt = db.prepare(`INSERT OR IGNORE INTO cb_story_settings (key, value) VALUES (?, ?)`);
  const defaults = [
    ['logging_enabled',          '1'],       // ログ収集 全体 ON/OFF
    ['auto_write_enabled',       '0'],       // 自動執筆 ON/OFF（P43-B 実装後に有効化）
    ['auto_write_frequency',     'manual'],  // daily / weekly / manual
    ['min_events_per_episode',   '3'],       // 最低イベント数（これ未満なら執筆を見送り）
    ['max_chars_per_episode',    '3000'],    // 1話あたりの目安文字数
    ['max_revision_rounds',      '2'],       // ソラ↔キイロの修正上限回数
    ['budget_threshold_percent', '30'],      // 残予算がこの%未満なら執筆を保留
    ['advance_lock',             ''],        // P42-C: 手動進行の排他ロック（空=未ロック、ISO日時=ロック中）
  ];
  for (const [k, v] of defaults) stmt.run(k, v);
}

/**
 * cb_employee_relationships の初期データを挿入（冪等）
 *
 * 8件 個別設定:
 *   Scout→Analyst, Analyst→Scout
 *   Planner→Analyst, Analyst→Planner
 *   Writer→Editor, Editor→Writer
 *   Analyst→Growth, Growth→Analyst
 *
 * 22件 デフォルト同僚（trust=40, affection=20, respect=35, その他0）
 *
 * @param {import('node:sqlite').DatabaseSync} db
 */
function seedEmployeeRelationships(db) {
  // 既にデータがあればスキップ（冪等）
  const count = db.prepare('SELECT COUNT(*) AS c FROM cb_employee_relationships').get()?.c ?? 0;
  if (count > 0) return;

  // ── 8件 個別設定 ─────────────────────────────────────────────────────────

  // 1. Scout → Analyst（ヒカゲ→ヒノデ）: 片想い（秘密）
  //    Phase 1 承認値: trust=60, affection=70, romantic_interest=80（上限100）
  db.prepare(`INSERT INTO cb_employee_relationships
    (from_emp, to_emp, trust, affection, respect, rivalry, discomfort, romantic_interest,
     relationship_type, public_attitude, private_feeling, is_secret)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'Scout','Analyst',
    60, 70, 65, 0, 0, 80,  // trust=60, affection=70 が Phase1 承認値
    'colleague',
    '山吹社長、ヒノデから分析データが届きました。確認します。',
    'ヒノデが隣で作業しているとき、報告の声が落ち着いていて、つい聞き取ってしまう。特別なことではないと思うようにしている。',
    1  // 秘密
  );

  // 2. Analyst → Scout（ヒノデ→ヒカゲ）: ヒカゲの好意に気づかず
  //    Phase 1 承認値: trust=55, affection=30
  db.prepare(`INSERT INTO cb_employee_relationships
    (from_emp, to_emp, trust, affection, respect, rivalry, discomfort, romantic_interest,
     relationship_type, public_attitude, private_feeling, is_secret)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'Analyst','Scout',
    55, 30, 65, 0, 0, 0,  // trust=55, affection=30 が Phase1 承認値
    'colleague',
    'ヒカゲの調査は信頼できます。情報の精度が高くて、分析のしがいがあります。',
    null,
    0
  );

  // 3. Planner → Analyst（アサヒ→ヒノデ）: 親友
  db.prepare(`INSERT INTO cb_employee_relationships
    (from_emp, to_emp, trust, affection, respect, rivalry, discomfort, romantic_interest,
     relationship_type, public_attitude, private_feeling, is_secret)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'Planner','Analyst',
    70, 80, 55, 0, 0, 0,
    'friend',
    'ヒノデとは話しやすい。一緒に整理するとアイデアが広がる気がして、楽しい。',
    null,
    0
  );

  // 4. Analyst → Planner（ヒノデ→アサヒ）: 親友
  db.prepare(`INSERT INTO cb_employee_relationships
    (from_emp, to_emp, trust, affection, respect, rivalry, discomfort, romantic_interest,
     relationship_type, public_attitude, private_feeling, is_secret)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'Analyst','Planner',
    65, 75, 50, 0, 0, 0,
    'friend',
    'アサヒが出してくるアイデアは整理しやすい。見ているポイントが違うのに、話が噛み合う。',
    null,
    0
  );

  // 5. Writer → Editor（ソラ→キイロ）: 信頼・個人的意識
  db.prepare(`INSERT INTO cb_employee_relationships
    (from_emp, to_emp, trust, affection, respect, rivalry, discomfort, romantic_interest,
     relationship_type, public_attitude, private_feeling, is_secret)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'Writer','Editor',
    65, 50, 80, 0, 0, 20,  // trust=65, discomfort=0 が Phase1 承認値
    'mentor_mentee',
    'キイロの指摘はいつも言葉の意味を突いていて、重要だと思っています。',
    'キイロが原稿をちゃんと読んでいるのが伝わると、少しほっとする。それ以上のことは、まだ分からない。',
    1  // 秘密（内面のみ）
  );

  // 6. Editor → Writer（キイロ→ソラ）: 特に気にかける
  db.prepare(`INSERT INTO cb_employee_relationships
    (from_emp, to_emp, trust, affection, respect, rivalry, discomfort, romantic_interest,
     relationship_type, public_attitude, private_feeling, is_secret)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'Editor','Writer',
    70, 45, 80, 0, 0, 15,  // affection=45 が Phase1 承認値
    'mentor_mentee',
    'ソラの言葉の選び方は丁寧で、修正のしがいがある原稿を書く。',
    'ソラが納得して直してくれたとき、なぜか少し安心する。理由は考えすぎないようにしている。',
    1  // 秘密（内面のみ）
  );

  // 7. Analyst → Growth（ヒノデ→アオ）: ライバル兼相棒
  db.prepare(`INSERT INTO cb_employee_relationships
    (from_emp, to_emp, trust, affection, respect, rivalry, discomfort, romantic_interest,
     relationship_type, public_attitude, private_feeling, is_secret)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'Analyst','Growth',
    50, 40, 60, 60, 0, 0,  // trust=50, rivalry=60, discomfort=0 が Phase1 承認値
    'rival',
    'アオとは意見が合わないことも多いが、数字の見方は参考になります。',
    null,
    0
  );

  // 8. Growth → Analyst（アオ→ヒノデ）: ライバル兼相棒
  db.prepare(`INSERT INTO cb_employee_relationships
    (from_emp, to_emp, trust, affection, respect, rivalry, discomfort, romantic_interest,
     relationship_type, public_attitude, private_feeling, is_secret)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    'Growth','Analyst',
    50, 40, 60, 60, 0, 0,  // trust=50, rivalry=60, discomfort=0 が Phase1 承認値
    'rival',
    'ヒノデの分析は丁寧だが、結論が遠い。もう少し直接的に言えばいいのに。',
    null,
    0
  );

  // ── 22件 デフォルト同僚 ───────────────────────────────────────────────────
  const defaultPairs = [
    // Scout との残りペア（Analyst は個別設定済み）
    ['Scout','Planner'],['Planner','Scout'],
    ['Scout','Writer'], ['Writer','Scout'],
    ['Scout','Editor'], ['Editor','Scout'],
    ['Scout','Growth'], ['Growth','Scout'],
    // Analyst との残りペア（Scout/Planner/Growth は個別設定済み）
    ['Analyst','Writer'], ['Writer','Analyst'],
    ['Analyst','Editor'], ['Editor','Analyst'],
    // Planner との残りペア（Analyst は個別設定済み）
    ['Planner','Writer'], ['Writer','Planner'],
    ['Planner','Editor'], ['Editor','Planner'],
    ['Planner','Growth'], ['Growth','Planner'],
    // Writer との残りペア（Editor は個別設定済み）
    ['Writer','Growth'],  ['Growth','Writer'],
    // Editor との残りペア
    ['Editor','Growth'],  ['Growth','Editor'],
  ];

  const stmtDefault = db.prepare(`INSERT OR IGNORE INTO cb_employee_relationships
    (from_emp, to_emp, trust, affection, respect, relationship_type)
    VALUES (?,?,40,20,35,'colleague')`);

  for (const [from, to] of defaultPairs) {
    stmtDefault.run(from, to);
  }
}

/**
 * cb_autonomous_settings の初期値を挿入（冪等）
 * @param {import('node:sqlite').DatabaseSync} db
 */
function seedAutonomousSettings(db) {
  const stmt = db.prepare(`INSERT OR IGNORE INTO cb_autonomous_settings (key, value) VALUES (?, ?)`);
  const defaults = [
    ['enabled',                    '0'],   // 自律交流 全体 ON/OFF
    ['romance_enabled',            '1'],   // 恋愛感情の描写 ON/OFF
    ['daily_interaction_limit',    '5'],   // 1日の自律交流上限
    ['budget_threshold_percent',   '50'],  // 月次予算使用率がこの値未満のとき実行
    ['interaction_interval_hours', '4'],   // 前回交流から最低N時間あけてから実行
  ];
  for (const [k, v] of defaults) stmt.run(k, v);
}

/**
 * 出版事業部テーブルを作成（冪等 - 何度実行しても安全）
 * @param {import('node:sqlite').DatabaseSync} db
 */
export function applyCbMigration(db) {
  db.exec(TABLES_SQL);
  try { db.exec(CB_CHAT_TABLES_SQL); } catch (_) { /* 既存テーブルはスキップ */ }
  try { db.exec(CB_CHAT_DRAFTS_SQL); } catch (_) { /* 既存テーブルはスキップ */ }
  try { db.exec(CB_FACT_CHECK_SQL); } catch (_) { /* 既存テーブルはスキップ */ }
  try { db.exec(CB_DIRECT_PLANS_SQL); } catch (_) { /* 既存テーブルはスキップ */ }

  // 既存テーブルへのカラム追加（冪等）
  for (const sql of CB_RESEARCH_MIGRATIONS) {
    try { db.exec(sql); } catch (_) { /* カラム既存はスキップ */ }
  }
  for (const sql of CB_PROJECTS_MIGRATIONS) {
    try { db.exec(sql); } catch (_) { /* カラム既存はスキップ */ }
  }
  for (const sql of CB_SALES_RECORDS_MIGRATIONS) {
    try { db.exec(sql); } catch (_) { /* カラム既存はスキップ */ }
  }

  // 重複URL行を削除してからUNIQUEインデックスを追加（冪等）
  try {
    // 重複がある場合は古い方（id小さい方）を残して削除
    db.exec(`
      DELETE FROM cb_research_items
      WHERE id NOT IN (
        SELECT MAX(id) FROM cb_research_items
        WHERE url IS NOT NULL
        GROUP BY project_id, url
      ) AND url IS NOT NULL
    `);
    db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_cb_research_url
        ON cb_research_items(project_id, url)
        WHERE url IS NOT NULL
    `);
  } catch (_) { /* 既存インデックスはスキップ */ }

  // ── Phase 42: 人間関係テーブル ──────────────────────────────────────────
  try { db.exec(CB_RELATIONSHIP_TABLES_SQL); } catch (_) { /* 既存テーブルはスキップ */ }
  try { seedEmployeeRelationships(db); }      catch (e) { console.warn('[P42] 関係性シード失敗:', e.message); }
  try { seedAutonomousSettings(db); }         catch (e) { console.warn('[P42] 設定シード失敗:', e.message); }

  // ── Phase 43-A: オフィス観察記録テーブル ─────────────────────────────────
  try { db.exec(CB_STORY_TABLES_SQL); }       catch (_) { /* 既存テーブルはスキップ */ }
  try { seedStorySettings(db); }              catch (e) { console.warn('[P43] 記録設定シード失敗:', e.message); }
  // source_id 安定キー重複防止インデックス（既存DBへの追加マイグレーション）
  try {
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_story_ev_src_dedup
      ON cb_story_events(event_type, source_type, source_id, from_emp, to_emp)
      WHERE source_id IS NOT NULL`);
  } catch (_) { /* 既存インデックスはスキップ */ }

  // Phase 42-B: cb_employee_interactions に source_job_id カラム追加（冪等）
  try {
    db.exec('ALTER TABLE cb_employee_interactions ADD COLUMN source_job_id INTEGER');
  } catch (_) { /* カラム既存はスキップ */ }
  try {
    db.exec(`CREATE INDEX IF NOT EXISTS idx_cb_interact_job
      ON cb_employee_interactions(source_job_id)
      WHERE source_job_id IS NOT NULL`);
  } catch (_) { /* 既存はスキップ */ }

  // ── Phase 42-A/engine: ナレッジ管理テーブル（cb_editorial_learnings）────────
  try {
    db.exec(`
CREATE TABLE IF NOT EXISTS cb_editorial_learnings (
  id                  INTEGER  PRIMARY KEY AUTOINCREMENT,
  category            TEXT     NOT NULL
                        CHECK (category IN ('FACT','PRIVACY','STYLE','EDITORIAL_RULE','ARTICLE_SPECIFIC','REJECTED')),
  rule_text           TEXT     NOT NULL,
  source_type         TEXT     NOT NULL DEFAULT 'owner_explicit',
  source_project_id   INTEGER,
  source_draft_version INTEGER,
  trust_level         TEXT     NOT NULL DEFAULT 'owner_explicit',
  approval_status     TEXT     NOT NULL DEFAULT 'approved'
                        CHECK (approval_status IN ('approved','pending','rejected_by_owner')),
  is_active           INTEGER  NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
  created_at          DATETIME NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at          DATETIME NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_cb_editorial_cat    ON cb_editorial_learnings(category);
CREATE INDEX IF NOT EXISTS idx_cb_editorial_status ON cb_editorial_learnings(approval_status, is_active);
    `);
  } catch (_) { /* 既存はスキップ */ }

  // ── Phase 42-C: 承認待ちイベントテーブル ────────────────────────────────────
  try {
    db.exec(`
CREATE TABLE IF NOT EXISTS cb_pending_approvals (
  id            INTEGER  PRIMARY KEY AUTOINCREMENT,
  type          TEXT     NOT NULL,       -- 'relationship_change' | 'story_event'
  from_emp      TEXT,                    -- 関係者A（任意）
  to_emp        TEXT,                    -- 関係者B（任意）
  description   TEXT     NOT NULL,       -- オーナーへの説明文
  data_json     TEXT     NOT NULL,       -- 保留中のデータ（JSON）
  source_interaction_id INTEGER,         -- 起因した cb_employee_interactions.id
  status        TEXT     NOT NULL DEFAULT 'pending'
                  CHECK (status IN ('pending','approved','rejected')),
  created_at    DATETIME NOT NULL DEFAULT (datetime('now','localtime')),
  resolved_at   DATETIME
);
CREATE INDEX IF NOT EXISTS idx_cb_pending_status
  ON cb_pending_approvals(status);
    `);
  } catch (_) { /* 既存はスキップ */ }
}

/**
 * テーブルが存在するか確認
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {boolean}
 */
export function isCbMigrationApplied(db) {
  const row = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='cb_projects'"
  ).get();
  return !!row;
}
