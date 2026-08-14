/**
 * jarvis/data/sf_sync_manager.js
 * Snow flakes Ops Automation — 同期状態管理・自動取得オーケストレーター（Phase 10）
 *
 * 設計原則:
 *   - AUTO source (Instagram/YouTube) のみ自動実行
 *   - MANUAL source (TikTok/Soundrop/GA4/Narou/Revenue) は手動取込を追跡するだけ
 *   - 認証情報は ENV のみ。DB・ログ・APIレスポンスへ secret/token を出力しない
 *   - source 単位で独立実行。1 source の失敗が他に波及しない
 *   - source of truth は各分析テーブルの MAX(date)
 *   - sf_sync_state は運用状態のみ（分析データ本体を格納しない）
 *   - テストは :memory: DB + fetch モックのみ。実 DB・実 API 通信 0 件
 */

// ─── 必須 ENV 変数（存在確認のみ。値は参照・ログ出力しない）──────────────────────
const INSTAGRAM_ENV = [
  'INSTAGRAM_APP_ID', 'INSTAGRAM_APP_SECRET',
  'INSTAGRAM_ACCESS_TOKEN', 'INSTAGRAM_USER_ID',
];
const YOUTUBE_ENV = [
  'YOUTUBE_CLIENT_ID', 'YOUTUBE_CLIENT_SECRET',
  'YOUTUBE_REFRESH_TOKEN', 'YOUTUBE_CHANNEL_ID',
];

// ─── Source 定義 ──────────────────────────────────────────────────────────────

/**
 * 派生 source マップ。
 * 値に指定した source が attention に出ている場合、キー source の attention を抑制する。
 * これは同じユーザー作業が原因の重複 attention を防ぐため。
 *
 * Revenue は Soundrop Statement CSV と入力源が同一なので、
 * Soundrop が stale/manual_required のとき Revenue は独立 attention を生成しない。
 * Revenue に独立した問題（Soundrop 以外の入力源が必要になった場合）が生じた場合は
 * この設定を削除して独立 attention を許可すること。
 */
export const DERIVED_FROM = {
  revenue: 'soundrop', // Revenue は Soundrop Statement CSV と同じ入力源
};

/**
 * freshness 判定しきい値（日数）。
 * ここを変更すればすべての判定に反映される。
 */
export const FRESHNESS_THRESHOLDS = {
  instagram: 3,    // API 日次。3日未更新でstale
  youtube:   3,    // API 日次。3日未更新でstale
  ga4:       7,    // 手動・日次粒度。1週間未更新でstale
  narou:     32,   // 月次スナップショット。約1か月以上でstale
  tiktok:    14,   // 手動 CSV。2週間未更新でstale
  x:         14,   // 手動 CSV（X Analytics エクスポート）。2週間未更新でstale
  kdp:       35,   // 月次ロイヤリティ TSV。約1か月以上でstale
  soundrop:  35,   // 月次Statement。約1か月以上でstale
  revenue:   35,   // 月次・Soundrop Statement 由来
};

/**
 * 通知重複抑制間隔（時間）。
 * last_notified_at からこの時間が経過するまで同じ source の警告を再通知しない。
 */
export const NOTIFY_COOLDOWN_HOURS = {
  instagram: 24,   // 毎日最大1回
  youtube:   24,
  ga4:       48,
  narou:     72,
  tiktok:    48,
  soundrop:  72,
  revenue:   72,
};

/**
 * source ごとの定義（registry）。
 * mode, label, データ取得元テーブルと日付カラム、ENV チェック関数。
 */
export const SOURCE_REGISTRY = {
  instagram: {
    source:      'instagram',
    mode:        'auto',
    label:       'Instagram',
    granularity: 'daily',
    dataTable:   'sf_instagram_account_daily',
    dateCol:     'date',
    envVars:     INSTAGRAM_ENV,
    collectorModule: '../importers/instagram_collector.js',
    actionMessage: null,  // AUTOは自動
  },
  youtube: {
    source:      'youtube',
    mode:        'auto',
    label:       'YouTube',
    granularity: 'daily',
    dataTable:   'sf_youtube_channel_daily',
    dateCol:     'date',
    envVars:     YOUTUBE_ENV,
    collectorModule: '../importers/youtube_channel_collector.js',
    actionMessage: null,
  },
  ga4: {
    source:      'ga4',
    mode:        'manual',
    label:       'GA4',
    granularity: 'daily',
    dataTable:   'sf_ga_daily',
    dateCol:     'date',
    envVars:     [],
    collectorModule: null,
    actionMessage: 'GA4 Data API のデータを ga_writer.js 経由で取込してください',
  },
  narou: {
    source:      'narou',
    mode:        'manual',
    label:       'なろう',
    granularity: 'monthly',
    dataTable:   'sf_narou_snapshot',
    dateCol:     'month',    // YYYY-MM
    envVars:     [],
    collectorModule: null,
    actionMessage: '小説家になろうの月次スナップショットを取込してください',
  },
  tiktok: {
    source:      'tiktok',
    mode:        'manual',
    label:       'TikTok',
    granularity: 'daily',
    dataTable:   'sf_account_daily',
    dateCol:     'date',
    dateFilter:  "platform = 'tiktok'",
    envVars:     [],
    collectorModule: null,
    actionMessage: 'TikTok Studio の CSV を importTikTokCSV() で取込してください',
  },
  x: {
    source:      'x',
    mode:        'manual',
    label:       'X（旧Twitter）',
    granularity: 'daily',
    dataTable:   'sf_x_tweet_metrics',
    dateCol:     'snapshot_date',
    envVars:     [],
    collectorModule: null,
    actionMessage: 'X Analytics から CSV をエクスポートして importXCSV() で取込してください',
  },
  kdp: {
    source:      'kdp',
    mode:        'manual',
    label:       'KDP（Kindle）',
    granularity: 'monthly',
    dataTable:   'kdp_royalties',
    dateCol:     'royalty_month',
    envVars:     [],
    collectorModule: null,
    actionMessage: 'KDP レポートから月次ロイヤリティ TSV をダウンロードして importKdpReport() で取込してください',
  },
  soundrop: {
    source:      'soundrop',
    mode:        'manual',
    label:       'Soundrop',
    granularity: 'monthly',
    dataTable:   'sf_revenue',
    dateCol:     'transaction_month',
    dateFilter:  'transaction_month IS NOT NULL',
    envVars:     [],
    collectorModule: null,
    actionMessage: 'Soundrop から最新の Statement CSV をダウンロードして取込してください',
  },
  revenue: {
    source:      'revenue',
    mode:        'manual',
    label:       'Revenue',
    granularity: 'monthly',
    dataTable:   'sf_revenue',
    dateCol:     'month',
    dateFilter:  null,
    envVars:     [],
    collectorModule: null,
    actionMessage: 'Soundrop Statement CSV から revenue_writer.js で取込してください',
  },
};

export const SOURCE_NAMES = Object.keys(SOURCE_REGISTRY);
export const AUTO_SOURCES   = SOURCE_NAMES.filter(s => SOURCE_REGISTRY[s].mode === 'auto');
export const MANUAL_SOURCES = SOURCE_NAMES.filter(s => SOURCE_REGISTRY[s].mode === 'manual');

// ─── ユーティリティ ──────────────────────────────────────────────────────────

/** YYYY-MM-DD を返す（UTC基準）*/
function todayUTC() {
  return new Date().toISOString().slice(0, 10);
}

/** ISO8601 文字列から Date を取得 */
function parseDate(str) {
  if (!str) return null;
  // YYYY-MM の場合は月初として扱う
  if (/^\d{4}-\d{2}$/.test(str)) return new Date(str + '-01T00:00:00Z');
  return new Date(str + 'T00:00:00Z');
}

/** 日付差（日数）。d1 - d2 の日数 */
function dayDiff(d1str, d2str) {
  const d1 = parseDate(d1str);
  const d2 = parseDate(d2str);
  if (!d1 || !d2) return null;
  return Math.floor((d1 - d2) / 86400000);
}

/** ENV 変数がすべて設定されているか（true/false のみ返す。値は返さない）*/
function isConfigured(envVars) {
  return envVars.every(k => !!process.env[k]);
}

// ─── DB から実データ日付を取得 ──────────────────────────────────────────────

/**
 * 各 source の分析テーブルから MAX(date) を取得する（source of truth）。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} source
 * @returns {string|null} YYYY-MM-DD または null
 */
export function getLastDataDate(db, source) {
  const def = SOURCE_REGISTRY[source];
  if (!def) return null;

  let sql = `SELECT MAX(${def.dateCol}) AS d FROM ${def.dataTable}`;
  if (def.dateFilter) sql += ` WHERE ${def.dateFilter}`;

  try {
    const row = db.prepare(sql).get();
    return row?.d ?? null;
  } catch (_) {
    return null;
  }
}

// ─── freshness 評価 ──────────────────────────────────────────────────────────

/**
 * source の freshness を評価して状態文字列を返す。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} source
 * @param {string} [today] - テスト用日付上書き（YYYY-MM-DD）
 * @returns {{ status: string, last_data_date: string|null, days_since_update: number|null }}
 */
export function evaluateFreshness(db, source, today = null) {
  const def = SOURCE_REGISTRY[source];
  if (!def) return { status: 'error', last_data_date: null, days_since_update: null };

  const configured = isConfigured(def.envVars);
  if (def.mode === 'auto' && !configured) {
    return { status: 'unconfigured', last_data_date: null, days_since_update: null };
  }

  const lastDate = getLastDataDate(db, source);
  if (!lastDate) {
    return {
      status: def.mode === 'auto' ? 'never_synced' : 'manual_required',
      last_data_date: null,
      days_since_update: null,
    };
  }

  const t = today ?? todayUTC();
  const threshold = FRESHNESS_THRESHOLDS[source] ?? 7;
  const diff = dayDiff(t, lastDate);

  if (diff === null) return { status: 'error', last_data_date: lastDate, days_since_update: null };

  const status = diff <= threshold ? 'fresh' : 'stale';
  return { status, last_data_date: lastDate, days_since_update: diff };
}

// ─── sync_state CRUD ─────────────────────────────────────────────────────────

/**
 * sf_sync_state から source のレコードを取得（なければ null）。
 */
function getSyncStateRow(db, source) {
  try {
    return db.prepare('SELECT * FROM sf_sync_state WHERE source = ?').get(source) ?? null;
  } catch (_) {
    return null;
  }
}

/**
 * sf_sync_state を UPSERT する。
 */
function upsertSyncState(db, source, fields) {
  const now = new Date().toISOString();
  const def = SOURCE_REGISTRY[source];
  const mode = def?.mode ?? 'manual';

  const existing = getSyncStateRow(db, source);
  if (!existing) {
    db.prepare(`
      INSERT INTO sf_sync_state
        (source, mode, last_attempt_at, last_success_at, last_data_date,
         status, last_error, consecutive_failures, last_notified_at, snoozed_until, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      source, mode,
      fields.last_attempt_at ?? null,
      fields.last_success_at ?? null,
      fields.last_data_date  ?? null,
      fields.status          ?? 'never_synced',
      fields.last_error      ?? null,
      fields.consecutive_failures ?? 0,
      fields.last_notified_at ?? null,
      fields.snoozed_until    ?? null,
      now,
    );
  } else {
    const updates = [];
    const params  = [];
    const allowed = [
      'last_attempt_at', 'last_success_at', 'last_data_date',
      'status', 'last_error', 'consecutive_failures',
      'last_notified_at', 'snoozed_until',
    ];
    for (const k of allowed) {
      if (k in fields) {
        updates.push(`${k} = ?`);
        params.push(fields[k]);
      }
    }
    if (updates.length === 0) return;
    updates.push('updated_at = ?');
    params.push(now);
    params.push(source);
    db.prepare(`UPDATE sf_sync_state SET ${updates.join(', ')} WHERE source = ?`).run(...params);
  }
}

/**
 * 手動 import が成功した後に sync_state を更新するフック。
 * tiktok_csv_importer / revenue_writer 等から呼び出す想定。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} source
 */
export function notifyImportSuccess(db, source) {
  const def = SOURCE_REGISTRY[source];
  if (!def) return;
  const lastDate = getLastDataDate(db, source);
  upsertSyncState(db, source, {
    last_success_at:     new Date().toISOString(),
    last_data_date:      lastDate,
    status:              lastDate ? 'fresh' : 'manual_required',
    last_error:          null,
    consecutive_failures: 0,
  });
}

// ─── source status ───────────────────────────────────────────────────────────

/**
 * 単一 source の現在状態を返す。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} source
 * @param {string} [today]
 * @returns {{
 *   source: string, mode: string, configured: boolean,
 *   status: string, last_data_date: string|null,
 *   last_attempt_at: string|null, last_success_at: string|null,
 *   last_error: string|null, freshness: object,
 *   requires_user_action: boolean, action_message: string|null
 * }}
 */
export function getSourceStatus(db, source, today = null) {
  const def = SOURCE_REGISTRY[source];
  if (!def) throw new Error(`Unknown source: ${source}`);

  const configured = isConfigured(def.envVars);
  const freshness  = evaluateFreshness(db, source, today);
  const stateRow   = getSyncStateRow(db, source);

  // 最終試行・成功は sync_state から補完
  const last_attempt_at = stateRow?.last_attempt_at ?? null;
  const last_success_at = stateRow?.last_success_at ?? null;
  const last_error      = stateRow?.last_error      ?? null;

  const status = freshness.status;

  // ユーザー操作が必要な条件
  const requires_user_action =
    status === 'stale' ||
    status === 'manual_required' ||
    status === 'never_synced'   ||
    status === 'unconfigured'   ||
    status === 'error';

  let action_message = null;
  if (status === 'unconfigured') {
    action_message = `${def.label} の認証 ENV 変数を設定してください: ${def.envVars.join(', ')}`;
  } else if (status === 'error') {
    action_message = `${def.label} の自動取得でエラーが発生しました。認証状態を確認してください`;
  } else if (status === 'stale' || status === 'manual_required' || status === 'never_synced') {
    action_message = def.actionMessage ?? `${def.label} の自動取得に問題があります`;
    if (def.mode === 'auto' && status === 'stale') {
      action_message = `${def.label} の自動取得が ${freshness.days_since_update} 日間更新されていません。認証状態を確認してください`;
    } else if (def.mode === 'manual' && status === 'stale') {
      action_message = def.actionMessage + `（${freshness.days_since_update} 日未更新）`;
    }
  }

  return {
    source,
    mode:        def.mode,
    label:       def.label,
    granularity: def.granularity,
    configured,
    status,
    last_data_date:  freshness.last_data_date,
    days_since_update: freshness.days_since_update,
    last_attempt_at,
    last_success_at,
    last_error,
    requires_user_action,
    action_message,
  };
}

// ─── 全 source 状態 ──────────────────────────────────────────────────────────

/**
 * 登録済み全 source の定義一覧を返す。
 */
export function getSyncSources() {
  return Object.values(SOURCE_REGISTRY).map(def => ({
    source:      def.source,
    mode:        def.mode,
    label:       def.label,
    granularity: def.granularity,
  }));
}

/**
 * 全 source の現在状態を返す。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} [today]
 * @returns {{ sources: object[], auto: string[], manual: string[], summary: object }}
 */
export function getSyncStatus(db, today = null) {
  const sources = SOURCE_NAMES.map(s => getSourceStatus(db, s, today));
  const attention = sources.filter(s => s.requires_user_action);

  return {
    sources,
    auto:   AUTO_SOURCES,
    manual: MANUAL_SOURCES,
    summary: {
      total:        sources.length,
      fresh:        sources.filter(s => s.status === 'fresh').length,
      stale:        sources.filter(s => s.status === 'stale').length,
      error:        sources.filter(s => s.status === 'error').length,
      unconfigured: sources.filter(s => s.status === 'unconfigured').length,
      attention_count: attention.length,
    },
  };
}

// ─── attention items ──────────────────────────────────────────────────────────

/**
 * 今ユーザーが対応すべき項目だけを返す（重複通知抑制あり）。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ today?: string, ignoreCooldown?: boolean }} [opts]
 * @returns {Array<{
 *   source: string, label: string, severity: string,
 *   reason: string, message: string, action: string
 * }>}
 */
export function getAttentionItems(db, opts = {}) {
  const today = opts.today ?? todayUTC();
  const items = [];
  // 既に attention に追加された source を記録（派生抑制用）
  const attentionSourceSet = new Set();

  for (const source of SOURCE_NAMES) {
    const st = getSourceStatus(db, source, today);
    if (!st.requires_user_action) continue;

    // 派生 source 抑制:
    // この source の親 source（DERIVED_FROM[source]）が attention に出ている場合はスキップ。
    // これは同じユーザー作業を要求する重複 attention を防ぐ。
    // 親 source が attention に出ていない（親が fresh など）場合は独立 attention を許可する。
    const parentSource = DERIVED_FROM[source];
    if (parentSource && attentionSourceSet.has(parentSource)) {
      continue;
    }

    // スヌーズ中はスキップ
    if (!opts.ignoreCooldown) {
      const stateRow = getSyncStateRow(db, source);
      if (stateRow?.snoozed_until && stateRow.snoozed_until > today) continue;

      // 通知クールダウン（last_notified_at から cooldown_hours 時間以内はスキップ）
      if (stateRow?.last_notified_at) {
        const cooldownHours = NOTIFY_COOLDOWN_HOURS[source] ?? 24;
        const lastNotified = new Date(stateRow.last_notified_at);
        const cutoff = new Date(lastNotified.getTime() + cooldownHours * 3600 * 1000);
        if (new Date() < cutoff) continue;
      }
    }

    const severity =
      st.status === 'error' || st.status === 'unconfigured' ? 'error'  :
      st.status === 'stale'                                  ? 'warning' :
      'info';

    const reason =
      st.status === 'error'        ? 'auto_error'     :
      st.status === 'unconfigured' ? 'unconfigured'   :
      st.status === 'stale'        ? 'stale'          :
      st.status === 'manual_required' ? 'manual_required' :
      'never_synced';

    const action =
      st.mode === 'auto' ? 'check_auth' : 'import_data';

    items.push({
      source:   st.source,
      label:    st.label,
      severity,
      reason,
      message:  st.action_message ?? `${st.label} の確認が必要です`,
      action,
    });

    attentionSourceSet.add(source);

    // last_notified_at を更新（重複抑制）
    if (!opts.ignoreCooldown) {
      upsertSyncState(db, source, { last_notified_at: new Date().toISOString() });
    }
  }

  return items;
}

/**
 * source をスヌーズする（today から hours 時間後まで attention に出さない）。
 * @param {string} [today] - テスト用。省略時は実時刻を使用
 */
export function snoozeSource(db, source, hours = 24, today = null) {
  if (!SOURCE_REGISTRY[source]) throw new Error(`Unknown source: ${source}`);
  const base = today ? new Date(today + 'T00:00:00Z') : new Date();
  const until = new Date(base.getTime() + hours * 3600 * 1000).toISOString().slice(0, 10);
  upsertSyncState(db, source, { snoozed_until: until });
}

// ─── AUTO sync 実行 ──────────────────────────────────────────────────────────

/**
 * 単一 AUTO source を実行する。
 * MANUAL source に対して呼ばれた場合はエラーを返す。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {string} source
 * @param {{ collectFn?: Function, dryRun?: boolean }} [opts]
 * @returns {Promise<{ source: string, success: boolean, error: string|null, data_date: string|null }>}
 */
export async function runSourceSync(db, source, opts = {}) {
  const def = SOURCE_REGISTRY[source];
  if (!def) return { source, success: false, error: `Unknown source: ${source}`, data_date: null };
  if (def.mode !== 'auto') {
    return {
      source, success: false,
      error: `${source} は MANUAL source です。自動取得できません`,
      data_date: null,
    };
  }

  const configured = isConfigured(def.envVars);
  if (!configured) {
    upsertSyncState(db, source, {
      last_attempt_at: new Date().toISOString(),
      status: 'unconfigured',
      last_error: `ENV 変数が未設定: ${def.envVars.filter(k => !process.env[k]).join(', ')}`,
    });
    return { source, success: false, error: 'unconfigured', data_date: null };
  }

  // dry-run モード
  if (opts.dryRun) {
    return { source, success: true, error: null, data_date: getLastDataDate(db, source) };
  }

  // collect 関数（テスト時は opts.collectFn で差し替え可能）
  let collectFn = opts.collectFn;
  if (!collectFn) {
    try {
      const mod = await import(def.collectorModule);
      collectFn = source === 'instagram'
        ? mod.collectInstagramDaily
        : mod.collectYouTubeChannel;
    } catch (e) {
      return { source, success: false, error: `collector import failed: ${e.message}`, data_date: null };
    }
  }

  const attemptAt = new Date().toISOString();
  upsertSyncState(db, source, { last_attempt_at: attemptAt });

  try {
    await collectFn(db);
    const dataDate = getLastDataDate(db, source);
    upsertSyncState(db, source, {
      last_success_at:      new Date().toISOString(),
      last_data_date:       dataDate,
      status:               'fresh',
      last_error:           null,
      consecutive_failures: 0,
    });
    return { source, success: true, error: null, data_date: dataDate };
  } catch (err) {
    // エラーメッセージからトークン・シークレットを除去
    const safeMsg = (err.message ?? String(err)).replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]');
    const stateRow = getSyncStateRow(db, source);
    const failures = (stateRow?.consecutive_failures ?? 0) + 1;
    upsertSyncState(db, source, {
      status:               'error',
      last_error:           safeMsg,
      consecutive_failures: failures,
    });
    return { source, success: false, error: safeMsg, data_date: null };
  }
}

/**
 * 全 AUTO source を独立して実行する。
 * 1 source の失敗が他に波及しない。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ collectFns?: object, dryRun?: boolean }} [opts]
 * @returns {Promise<{
 *   overall: 'success'|'partial'|'failed',
 *   results: Array,
 *   succeeded: string[],
 *   failed: string[]
 * }>}
 */
export async function runAutoSync(db, opts = {}) {
  const results = [];

  for (const source of AUTO_SOURCES) {
    const collectFn = opts.collectFns?.[source] ?? null;
    const r = await runSourceSync(db, source, {
      collectFn,
      dryRun: opts.dryRun ?? false,
    });
    results.push(r);
  }

  const succeeded = results.filter(r => r.success).map(r => r.source);
  const failed    = results.filter(r => !r.success).map(r => r.source);

  const overall =
    failed.length === 0           ? 'success' :
    succeeded.length === 0        ? 'failed'  :
    'partial';

  return { overall, results, succeeded, failed };
}
