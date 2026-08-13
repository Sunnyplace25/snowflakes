/**
 * jarvis/importers/tiktok_csv_importer.js
 * TikTok Analytics CSV インポーター（Phase 8）
 *
 * TikTok 公式 API との接続なし。
 * JARVIS 内部正規化 CSV フォーマット（以下仕様参照）を読み込み、
 * 既存 SNS 共通テーブルへ安全に UPSERT する。
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * JARVIS 内部正規化 CSV フォーマット（カラム仕様）
 * ══════════════════════════════════════════════════════════════════════════════
 *
 * 注意: TikTok Studio 実 CSV との互換性は未保証。
 *   実際の TikTok Studio export サンプルを確認後、
 *   adapter / header mapping を追加することが可能。
 *   「TikTok Studio 公式 CSV 対応済み」ではない。
 *
 * ── Type A: account_daily ─────────────────────────────────────────────────────
 *   必須: date
 *   任意: followers, followers_delta, reach, impressions, profile_visits, link_clicks
 *
 *   カラム一覧（すべてカラム名は小文字・trim 済みで比較する）:
 *     date             TEXT  YYYY-MM-DD          アカウント集計日（必須）
 *     followers        INT   >= 0                フォロワー総数
 *     followers_delta  INT   （マイナス可）        当日純増
 *     reach            INT   >= 0                リーチ数（reach の意味がある場合のみ）
 *     impressions      INT   >= 0                インプレッション数
 *     profile_visits   INT   >= 0                プロフィール表示数
 *     link_clicks      INT   >= 0                リンクタップ数
 *
 *   !! account-level video_views（日次動画再生数合計）について !!
 *     sf_account_daily に意味の一致する列がないため、Phase 8 では保存対象外。
 *     video_views を reach に代替保存することは禁止（意味が異なる）。
 *     将来、専用列または sf_platform_ext への保存が必要な場合はスキーマ変更を検討すること。
 *
 *   DB マッピング → sf_account_daily (platform='tiktok', import_source='csv'):
 *     followers        → followers
 *     followers_delta  → followers_delta
 *     reach            → reach         ← 意味が一致する場合のみ
 *     impressions      → impressions
 *     profile_visits   → profile_visits
 *     link_clicks      → link_clicks
 *
 * ── Type B: video_metrics ─────────────────────────────────────────────────────
 *   必須: video_id, snapshot_date
 *   任意: title, published_at, duration_sec,
 *          views, likes, comments, shares, saves, watch_time_min, avg_watch_sec,
 *          completion_rate
 *
 *   カラム一覧:
 *     snapshot_date        TEXT  YYYY-MM-DD          スナップショット取得日
 *     video_id             TEXT                      TikTok 動画 ID（必須・一意）
 *     title                TEXT                      動画タイトル
 *     published_at         TEXT  YYYY-MM-DD or ISO   公開日時
 *     duration_sec         INT   >= 0                動画長（秒）
 *     views                INT   >= 0                再生数
 *     likes                INT   >= 0                いいね数
 *     comments             INT   >= 0                コメント数
 *     shares               INT   >= 0                シェア数
 *     saves                INT   >= 0                保存数
 *     watch_time_min       REAL  >= 0                累計視聴時間（分）
 *     avg_watch_sec        REAL  >= 0                平均視聴時間（秒）
 *     completion_rate      REAL  [0.0, 1.0]          完了率（小数。0〜100% 形式は不可）
 *
 *   DB マッピング:
 *     sf_content_registry: platform='tiktok', content_type='tiktok_video'
 *     sf_social_metrics:   import_source='csv'
 *       views / likes / comments / shares / saves / watch_time_min / avg_watch_sec
 *       / completion_rate → sf_social_metrics の各列へ直接保存
 *
 * ══════════════════════════════════════════════════════════════════════════════
 * 重要制約
 * ══════════════════════════════════════════════════════════════════════════════
 *   - completion_rate は 0.0〜1.0 の小数のみ受け付ける（0〜100% 形式は拒否）
 *   - 意味の異なる指標への代替保存は禁止
 *   - 全 UPSERT は COALESCE(excluded.col, col) で既存非 NULL 値を保護する
 *   - スキーマ変更なし（Phase 8 はテーブル追加・カラム追加を一切行わない）
 *   - 実 DB (business_data.db) は使用禁止
 */

// ══════════════════════════════════════════════════════════════════════════════
// CSV パーサー
// ══════════════════════════════════════════════════════════════════════════════

/**
 * CSV テキストを { headers, rows } に変換する。
 *
 * 対応:
 *   - UTF-8 BOM（\uFEFF）除去
 *   - CRLF / LF 正規化
 *   - ダブルクォート囲みフィールド（カンマ・改行・二重引用符を含む値）
 *   - ヘッダ名は小文字化・trim する
 *
 * @param {string} text
 * @returns {{ headers: string[], rows: Record<string, string>[] }}
 */
export function parseCSV(text) {
  if (typeof text !== 'string') throw new Error('parseCSV: text は string が必要です');

  // BOM 除去
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);

  // CRLF → LF
  text = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  const lines = tokenizeCSV(text);
  if (lines.length === 0) return { headers: [], rows: [] };

  const headers = lines[0].map(h => h.trim().toLowerCase());
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const cells = lines[i];
    // 全セルが空行はスキップ
    if (cells.length === 0 || (cells.length === 1 && cells[0].trim() === '')) continue;

    const row = {};
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = (cells[j] ?? '').trim();
    }
    rows.push(row);
  }

  return { headers, rows };
}

/**
 * CSV テキストを行・セルの二次元配列にトークン化する。
 * RFC 4180 準拠（クォートフィールド内の改行も1セルとして扱う）。
 *
 * @param {string} text - BOM 除去・LF 正規化済みのテキスト
 * @returns {string[][]}
 */
function tokenizeCSV(text) {
  const lines = [];
  let current = [];
  let cell = '';
  let inQuote = false;
  let i = 0;

  while (i < text.length) {
    const ch = text[i];

    if (inQuote) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
        } else {
          inQuote = false;
          i++;
        }
      } else {
        cell += ch;
        i++;
      }
    } else {
      if (ch === '"') {
        inQuote = true;
        i++;
      } else if (ch === ',') {
        current.push(cell);
        cell = '';
        i++;
      } else if (ch === '\n') {
        current.push(cell);
        cell = '';
        lines.push(current);
        current = [];
        i++;
      } else {
        cell += ch;
        i++;
      }
    }
  }

  // 最終セル・最終行
  if (cell !== '' || current.length > 0) {
    current.push(cell);
    lines.push(current);
  }

  return lines;
}

// ══════════════════════════════════════════════════════════════════════════════
// 型検出
// ══════════════════════════════════════════════════════════════════════════════

/**
 * ヘッダ配列から CSV タイプを判定する。
 *
 * @param {string[]} headers - 小文字化済みヘッダ
 * @returns {'account_daily' | 'video_metrics' | 'unknown'}
 */
export function detectType(headers) {
  const has = (h) => headers.includes(h);

  // video_id が含まれれば Type B（video_id が存在する限り優先）
  if (has('video_id')) return 'video_metrics';

  // date があれば Type A（account_daily）
  if (has('date')) return 'account_daily';

  return 'unknown';
}

// ══════════════════════════════════════════════════════════════════════════════
// バリデーション
// ══════════════════════════════════════════════════════════════════════════════

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 整数文字列を安全に解析する（空文字列 → null） */
function parseIntSafe(s) {
  if (s === '' || s == null) return null;
  const n = Number(s);
  return Number.isInteger(n) ? n : NaN;
}

/** 浮動小数点文字列を安全に解析する（空文字列 → null） */
function parseFloatSafe(s) {
  if (s === '' || s == null) return null;
  const n = Number(s);
  return isFinite(n) ? n : NaN;
}

/**
 * Type A 行をバリデーションする。
 *
 * 必須: date
 * 任意: followers, followers_delta, reach, impressions, profile_visits, link_clicks
 *
 * @param {Record<string, string>} row  - parseCSV が返した行オブジェクト
 * @param {number}                 rowNum - 1-based 行番号（エラーメッセージ用）
 * @returns {string[]} エラーメッセージ配列（空なら OK）
 */
export function validateAccountRow(row, rowNum) {
  const errors = [];
  const prefix = `行 ${rowNum}`;

  // date（必須）
  if (!row.date) {
    errors.push(`${prefix}: date は必須です`);
  } else if (!DATE_RE.test(row.date)) {
    errors.push(`${prefix}: date の形式が不正です（YYYY-MM-DD が必要）: ${row.date}`);
  }

  // followers（任意・0 以上整数）
  if (row.followers != null && row.followers !== '') {
    const n = parseIntSafe(row.followers);
    if (isNaN(n) || n < 0) {
      errors.push(`${prefix}: followers は 0 以上の整数が必要です: ${row.followers}`);
    }
  }

  // followers_delta（任意・整数・マイナス可）
  if (row.followers_delta != null && row.followers_delta !== '') {
    const n = parseIntSafe(row.followers_delta);
    if (isNaN(n)) {
      errors.push(`${prefix}: followers_delta は整数が必要です: ${row.followers_delta}`);
    }
  }

  // reach, impressions, profile_visits, link_clicks（任意・0 以上整数）
  for (const col of ['reach', 'impressions', 'profile_visits', 'link_clicks']) {
    if (row[col] != null && row[col] !== '') {
      const n = parseIntSafe(row[col]);
      if (isNaN(n) || n < 0) {
        errors.push(`${prefix}: ${col} は 0 以上の整数が必要です: ${row[col]}`);
      }
    }
  }

  return errors;
}

/**
 * Type B 行をバリデーションする。
 *
 * 必須: video_id, snapshot_date
 * 任意: title, published_at, duration_sec,
 *        views, likes, comments, shares, saves, watch_time_min,
 *        avg_watch_sec, completion_rate
 *
 * @param {Record<string, string>} row
 * @param {number}                 rowNum
 * @returns {string[]} エラーメッセージ配列
 */
export function validateVideoRow(row, rowNum) {
  const errors = [];
  const prefix = `行 ${rowNum}`;

  // video_id（必須）
  if (!row.video_id || row.video_id.trim() === '') {
    errors.push(`${prefix}: video_id は必須です`);
  }

  // snapshot_date（必須・YYYY-MM-DD 形式）
  if (!row.snapshot_date || row.snapshot_date.trim() === '') {
    errors.push(`${prefix}: snapshot_date は必須です`);
  } else if (!DATE_RE.test(row.snapshot_date)) {
    errors.push(`${prefix}: snapshot_date の形式が不正です（YYYY-MM-DD が必要）: ${row.snapshot_date}`);
  }

  // published_at（任意・日付形式）
  if (row.published_at != null && row.published_at !== '') {
    const d = row.published_at.slice(0, 10);
    if (!DATE_RE.test(d)) {
      errors.push(`${prefix}: published_at の形式が不正です（YYYY-MM-DD または ISO8601 が必要）: ${row.published_at}`);
    }
  }

  // views, likes, comments, shares, saves, duration_sec（任意・0 以上整数）
  for (const col of ['views', 'likes', 'comments', 'shares', 'saves', 'duration_sec']) {
    if (row[col] != null && row[col] !== '') {
      const n = parseIntSafe(row[col]);
      if (isNaN(n) || n < 0) {
        errors.push(`${prefix}: ${col} は 0 以上の整数が必要です: ${row[col]}`);
      }
    }
  }

  // watch_time_min, avg_watch_sec（任意・0 以上実数）
  for (const col of ['watch_time_min', 'avg_watch_sec']) {
    if (row[col] != null && row[col] !== '') {
      const n = parseFloatSafe(row[col]);
      if (n === null || isNaN(n) || n < 0) {
        errors.push(`${prefix}: ${col} は 0 以上の数値が必要です: ${row[col]}`);
      }
    }
  }

  // completion_rate（任意・[0.0, 1.0] の小数のみ。0〜100% 形式は拒否）
  if (row.completion_rate != null && row.completion_rate !== '') {
    const n = parseFloatSafe(row.completion_rate);
    if (n === null || isNaN(n) || n < 0 || n > 1) {
      errors.push(`${prefix}: completion_rate は 0.0〜1.0 の小数が必要です（0〜100% 形式は不可）: ${row.completion_rate}`);
    }
  }

  return errors;
}

// ══════════════════════════════════════════════════════════════════════════════
// 行ビルダー
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Type A の CSV 行から sf_account_daily 用オブジェクトを構築する。
 * バリデーション済みの行を受け取ることを前提とする。
 *
 * !! video_views は保存対象外（reach への代替保存は禁止）。
 *    reach は CSV に reach カラムが明示的に存在する場合のみ保存する。
 *
 * @param {Record<string, string>} row
 * @returns {{
 *   platform: 'tiktok',
 *   date: string,
 *   followers: number|null,
 *   followers_delta: number|null,
 *   reach: number|null,
 *   impressions: number|null,
 *   profile_visits: number|null,
 *   link_clicks: number|null,
 *   import_source: 'csv',
 * }}
 */
export function buildAccountDailyRow(row) {
  return {
    platform:        'tiktok',
    date:            row.date,
    followers:       parseIntSafe(row.followers),
    followers_delta: parseIntSafe(row.followers_delta),
    reach:           parseIntSafe(row.reach),
    impressions:     parseIntSafe(row.impressions),
    profile_visits:  parseIntSafe(row.profile_visits),
    link_clicks:     parseIntSafe(row.link_clicks),
    import_source:   'csv',
  };
}

/**
 * Type B の CSV 行から sf_content_registry 用オブジェクトを構築する。
 *
 * @param {Record<string, string>} row
 * @returns {{
 *   platform: 'tiktok',
 *   content_type: 'tiktok_video',
 *   platform_id: string,
 *   title: string|null,
 *   published_at: string|null,
 *   duration_sec: number|null,
 * }}
 */
export function buildVideoEntry(row) {
  const publishedAt = (row.published_at && row.published_at.trim())
    ? row.published_at.trim().slice(0, 10)
    : null;
  return {
    platform:     'tiktok',
    content_type: 'tiktok_video',
    platform_id:  row.video_id.trim(),
    title:        (row.title && row.title.trim()) || null,
    published_at: publishedAt,
    duration_sec: parseIntSafe(row.duration_sec),
  };
}

/**
 * Type B の CSV 行から sf_social_metrics 用オブジェクトを構築する。
 *
 * @param {Record<string, string>} row
 * @param {number}                 contentRegId - sf_content_registry.id
 * @param {string}                 snapshotDate - YYYY-MM-DD
 * @returns {{
 *   content_reg_id: number,
 *   snapshot_date: string,
 *   views: number|null,
 *   likes: number|null,
 *   comments: number|null,
 *   shares: number|null,
 *   saves: number|null,
 *   watch_time_min: number|null,
 *   avg_watch_sec: number|null,
 *   completion_rate: number|null,
 *   import_source: 'csv',
 * }}
 */
export function buildVideoSnapshot(row, contentRegId, snapshotDate) {
  if (!contentRegId) throw new Error('buildVideoSnapshot: contentRegId が必要です');
  if (!snapshotDate || !DATE_RE.test(snapshotDate)) {
    throw new Error(`buildVideoSnapshot: 不正な snapshotDate: ${snapshotDate}`);
  }
  return {
    content_reg_id:  contentRegId,
    snapshot_date:   snapshotDate,
    views:           parseIntSafe(row.views),
    likes:           parseIntSafe(row.likes),
    comments:        parseIntSafe(row.comments),
    shares:          parseIntSafe(row.shares),
    saves:           parseIntSafe(row.saves),
    watch_time_min:  parseFloatSafe(row.watch_time_min),
    avg_watch_sec:   parseFloatSafe(row.avg_watch_sec),
    completion_rate: parseFloatSafe(row.completion_rate),
    import_source:   'csv',
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// DB 書き込み
// ══════════════════════════════════════════════════════════════════════════════

/**
 * sf_account_daily へ複数行を UPSERT する。
 * 既存非 NULL 値は COALESCE で保護する。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {ReturnType<typeof buildAccountDailyRow>[]} rows
 * @returns {number} 処理件数
 */
export function writeAccountDaily(db, rows) {
  if (!rows || rows.length === 0) return 0;
  const stmt = db.prepare(`
    INSERT INTO sf_account_daily
      (platform, date, followers, followers_delta, reach, impressions,
       profile_visits, link_clicks, import_source)
    VALUES ('tiktok', ?, ?, ?, ?, ?, ?, ?, 'csv')
    ON CONFLICT(platform, date) DO UPDATE SET
      followers       = COALESCE(excluded.followers,       followers),
      followers_delta = COALESCE(excluded.followers_delta, followers_delta),
      reach           = COALESCE(excluded.reach,           reach),
      impressions     = COALESCE(excluded.impressions,     impressions),
      profile_visits  = COALESCE(excluded.profile_visits,  profile_visits),
      link_clicks     = COALESCE(excluded.link_clicks,     link_clicks),
      import_source   = 'csv'
  `);
  db.exec('BEGIN');
  try {
    for (const r of rows) {
      stmt.run(
        r.date, r.followers, r.followers_delta, r.reach,
        r.impressions, r.profile_visits, r.link_clicks,
      );
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return rows.length;
}

/**
 * sf_content_registry へ動画エントリを UPSERT し、その id を返す。
 * 既存非 NULL 値は COALESCE で保護する。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {ReturnType<typeof buildVideoEntry>} entry
 * @returns {number} sf_content_registry.id
 */
export function writeVideoEntry(db, entry) {
  db.prepare(`
    INSERT INTO sf_content_registry
      (platform, content_type, platform_id, title, published_at, duration_sec)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(platform, platform_id) DO UPDATE SET
      title        = COALESCE(excluded.title,        title),
      published_at = COALESCE(excluded.published_at, published_at),
      duration_sec = COALESCE(excluded.duration_sec, duration_sec)
  `).run(
    entry.platform,
    entry.content_type,
    entry.platform_id,
    entry.title,
    entry.published_at,
    entry.duration_sec,
  );

  const row = db.prepare(
    `SELECT id FROM sf_content_registry WHERE platform = 'tiktok' AND platform_id = ?`,
  ).get(entry.platform_id);

  if (!row) throw new Error(`writeVideoEntry: content_registry の行が見つかりません: ${entry.platform_id}`);
  return row.id;
}

/**
 * sf_social_metrics へスナップショットを UPSERT する。
 * 既存非 NULL 値は COALESCE で保護する。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {ReturnType<typeof buildVideoSnapshot>} metrics
 * @returns {void}
 */
export function writeVideoMetrics(db, metrics) {
  db.prepare(`
    INSERT INTO sf_social_metrics
      (content_reg_id, snapshot_date, views, likes, comments, shares,
       saves, watch_time_min, avg_watch_sec, completion_rate, import_source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'csv')
    ON CONFLICT(content_reg_id, snapshot_date) DO UPDATE SET
      views           = COALESCE(excluded.views,           views),
      likes           = COALESCE(excluded.likes,           likes),
      comments        = COALESCE(excluded.comments,        comments),
      shares          = COALESCE(excluded.shares,          shares),
      saves           = COALESCE(excluded.saves,           saves),
      watch_time_min  = COALESCE(excluded.watch_time_min,  watch_time_min),
      avg_watch_sec   = COALESCE(excluded.avg_watch_sec,   avg_watch_sec),
      completion_rate = COALESCE(excluded.completion_rate, completion_rate),
      import_source   = 'csv'
  `).run(
    metrics.content_reg_id,
    metrics.snapshot_date,
    metrics.views,
    metrics.likes,
    metrics.comments,
    metrics.shares,
    metrics.saves,
    metrics.watch_time_min,
    metrics.avg_watch_sec,
    metrics.completion_rate,
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// メインエントリポイント
// ══════════════════════════════════════════════════════════════════════════════

/**
 * TikTok CSV テキストを解析して DB へ一括インポートする。
 *
 * Type A（account_daily）と Type B（video_metrics）を自動判定し、
 * それぞれ適切なテーブルへ UPSERT する。
 *
 * @param {import('better-sqlite3').Database} db
 * @param {string} text - CSV 全文（UTF-8 / UTF-8 BOM 対応）
 * @param {object} [opts] - 現在未使用（将来拡張用）
 * @returns {{
 *   type: 'account_daily' | 'video_metrics' | 'unknown',
 *   processed: number,
 *   inserted: number,
 *   errors: string[],
 * }}
 */
export function importTikTokCSV(db, text, opts = {}) {
  const { headers, rows } = parseCSV(text);
  const csvType = detectType(headers);

  if (csvType === 'unknown') {
    return {
      type:      'unknown',
      processed: 0,
      inserted:  0,
      errors:    ['CSV タイプを判定できません。ヘッダに video_id または date が必要です'],
    };
  }

  const allErrors = [];
  let inserted = 0;

  if (csvType === 'account_daily') {
    const validRows = [];
    for (let i = 0; i < rows.length; i++) {
      const errs = validateAccountRow(rows[i], i + 2); // ヘッダ行が1行目なので+2
      if (errs.length > 0) {
        allErrors.push(...errs);
      } else {
        validRows.push(buildAccountDailyRow(rows[i]));
      }
    }
    if (validRows.length > 0) {
      inserted = writeAccountDaily(db, validRows);
    }
    return {
      type:      'account_daily',
      processed: rows.length,
      inserted,
      errors:    allErrors,
    };
  }

  // video_metrics
  db.exec('BEGIN');
  try {
    for (let i = 0; i < rows.length; i++) {
      const errs = validateVideoRow(rows[i], i + 2);
      if (errs.length > 0) {
        allErrors.push(...errs);
        continue;
      }

      // snapshot_date: validateVideoRow で検証済み
      const rowSnapDate = rows[i].snapshot_date;

      const entry   = buildVideoEntry(rows[i]);
      const regId   = writeVideoEntry(db, entry);
      const metrics = buildVideoSnapshot(rows[i], regId, rowSnapDate);
      writeVideoMetrics(db, metrics);
      inserted++;
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }

  return {
    type:      'video_metrics',
    processed: rows.length,
    inserted,
    errors:    allErrors,
  };
}
