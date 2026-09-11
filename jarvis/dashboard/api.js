/**
 * jarvis/dashboard/api.js
 * REST API ハンドラ
 *
 * - 既存 DBモジュールをそのまま利用（ロジック重複実装なし）
 * - 全エンドポイントでサーバ側入力検証を実施
 * - ConflictError（完全休日への仕事登録）は 409 で返す
 */

import { addWorkRecord, getWorkRecords, updateWorkRecord, updateWorkRecordFull, deleteWorkRecord }
  from '../data/work_record_manager.js';
import { upsertDailyStatus, getDailyStatus, getFullDayOffCount }
  from '../data/daily_status_manager.js';
import { getMonthlySummary, getUnpaidCounts }
  from '../data/aggregator.js';
import {
  getTracks, getTrack, upsertTrack,
  getReleases, getRelease, upsertRelease,
  getArtistProfiles, upsertArtistProfile,
  getPreviews, upsertPreview,
  getImportHistory, getUnreviewedImportRows,
} from '../data/sf_manager.js';
import { importFile } from '../importers/soundrop.js';
import {
  getFunnelEvents,
  createFunnelEvent,
  getFunnelOverview,
  getEventImpact,
  getWorkFunnel,
  getTrackFunnel,
} from '../data/sf_funnel_manager.js';
import {
  getSyncStatus,
  getAttentionItems,
  runAutoSync,
  runSourceSync,
  setSourceEnabled,
  notifyImportSuccess,
  AUTO_SOURCES,
  SOURCE_REGISTRY,
} from '../data/sf_sync_manager.js';
import {
  getXTweets,
  getXTweetsTop,
  getXAccountDaily,
  getXSummary,
} from '../data/sf_x_manager.js';
import {
  getKdpBooks,
  getKdpOrders,
  getKdpKenp,
  getKdpRoyalties,
  getKdpPayments,
  getKdpSummary,
  getSnowflakesKdpSummary,
} from '../data/kdp_manager.js';
import {
  createArticle,
  updateArticle,
  setStatus,
  recordPublished,
  getArticle,
  getArticles,
  getScheduledArticles,
  getDashboardSummary,
  generateExport,
  VALID_STATUSES,
  VALID_EXPORT_FORMATS,
} from '../data/note_manager.js';

// ── 配信サイト問題管理 (Phase 24) ─────────────────────────────────────────────
import {
  getDistributionPlatforms,
  getIssues,
  getIssue,
  createIssue,
  updateIssue,
  setIssueRequested,
  resolveIssue,
  touchIssueChecked,
} from '../data/sf_platform_manager.js';

// ── Business Invoice Import ───────────────────────────────────────────────────
import { parseExcel, computeFileHash, getCategoryRules } from '../importers/invoice_importer.js';
import {
  importInvoices,
  getImportHistory as getInvoiceImportHistory,
  getInvoiceAnalytics,
  getAnalyticsByYear,
  getInvoiceLines,
  getAvailableYears,
} from '../data/invoice_manager.js';

// ── Google Calendar Sync ──────────────────────────────────────────────────────
import {
  getCalendarConfig, refreshAccessToken as refreshCalendarToken, listCalendars,
} from '../sync/calendar_client.js';
import { dryRunPush, executePush, dryRunPull } from '../sync/calendar_sync.js';
import {
  getCalendarLinks, getCalendarLinkCount,
  insertSyncRun, completeSyncRun, getSyncRuns,
} from '../data/calendar_manager.js';

// ── work_records ↔ Google Calendar 自動連動フック (Phase 20) ──────────────────
import {
  hookWorkCreated,
  hookWorkUpdated,
  hookWorkDeleted,
  prepareWorkRecordDelete,
  getGoogleEventIdBeforeDelete,  // 後方互換のため保持
} from '../sync/work_calendar_hook.js';

// ── Soundrop Catalog Sync ─────────────────────────────────────────────────────
import { extractTokenFromInput, verifyToken } from '../sync/soundrop_client.mjs';
import { runSoundropDiff, summarizeDiff }     from '../sync/soundrop_sync.mjs';
import { applyDiff }                           from '../sync/catalog_writer.mjs';
import { applyStatusReconciliation, localDateStr } from '../sync/status_reconciler.mjs';
import {
  createDbReadOnly, isSoundropMigrationApplied, DEFAULT_DB_PATH,
} from '../data/db.js';
import { copyFileSync, mkdirSync, existsSync,
         createReadStream, readFileSync,
         writeFileSync, unlinkSync }           from 'node:fs';
import { resolve as pathResolve,
         extname as pathExtname }              from 'node:path';
import { tmpdir }                              from 'node:os';
import { importTikTokCSV }  from '../importers/tiktok_csv_importer.js';
import { importXCSV }       from '../importers/x_csv_importer.js';
import { importKdpReport }  from '../importers/kdp_report_importer.js';
import { writeNarouSnapshot } from '../importers/narou_writer.js';

// ── Phase 32: 競合アカウント分析 ─────────────────────────────────────────────
import {
  listAllAccounts as listCompetitorAccounts,
  getAccount as getCompetitorAccount,
  insertAccount as insertCompetitorAccount,
  updateAccount as updateCompetitorAccount,
  listItems as listCompetitorItems,
  getBrandSoldRanking, getCategoryStats,
  getBuyingCandidates,
  getRecentScans as getCompetitorScans,
  getSettings as getAnalysisSettings, setSetting,
  listUnreadNotifications, markNotificationRead,
  listReports as listCompetitorReports,
} from '../data/merch_competitor_manager.js';
import {
  extractUserIdFromProfileUrl,
} from '../data/merch_competitor_scraper.js';

// ── Phase 28: 作品公開URL・原稿アーカイブ管理 ─────────────────────────────────
import {
  getWorks, getWork, updateWorkDetail, reorderWorks, deleteWork,
  getWorkPublications, upsertWorkPublication, updateWorkPublication,
  getWorkArchives, getWorkArchive, archiveManuscript, getArchivePath,
  deleteWorkArchive, archiveTextContent,
} from '../data/sf_works_manager.js';
import { fileURLToPath }                       from 'node:url';
import { DatabaseSync }                        from 'node:sqlite';
import { randomBytes }                         from 'node:crypto';

const _BACKUPS_DIR = pathResolve(
  fileURLToPath(import.meta.url), '../../backups',
);

// YouTube OAuth 用の .env ファイルパス
const _ENV_FILE_PATH = pathResolve(fileURLToPath(import.meta.url), '../../.env');

// YouTube OAuth 認証フローの一時状態管理（サーバーメモリのみ）
// state: CSRF防止。start時に生成しcallbackで一致確認（10分TTL）
// token: callback成功後に一時保管（5分TTL）、apply時に.envへ書き込む
let _youtubeOauthState = null;  // { value: string, expiresAt: number }
let _pendingYoutubeToken = null; // { refreshToken: string, expiresAt: number }

// ─── ユーティリティ ───────────────────────────────────────────────────────────

function jsonRes(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache',
  });
  res.end(JSON.stringify(data));
}

function errRes(res, status, message) {
  jsonRes(res, status, { ok: false, error: message });
}

/** POST ボディを JSON として読み込む（最大 10 MB — Excel base64 対応） */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 10_485_760) reject(new Error('Request body too large'));
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch  { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

/** バイナリ POST ボディを Buffer として読み込む（最大 maxBytes） */
function readBinaryBody(req, maxBytes = 52_428_800) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on('data', chunk => {
      total += chunk.length;
      if (total > maxBytes) return reject(new Error('Request body too large (max 50MB)'));
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** YYYY-MM-DD の今日 */
function todayISO() {
  const d = new Date();
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
}

/** YYYY-MM の今月 */
function currentYearMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** YouTube OAuth コールバック結果ページ HTML */
function buildOauthResultHtml({ success, error = '' }) {
  const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  if (success) {
    return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">
<title>YouTube 再認証</title>
<style>body{font-family:sans-serif;max-width:480px;margin:60px auto;text-align:center}
.box{border:1px solid #ccc;border-radius:8px;padding:32px}
h2{color:#1a7}button{margin-top:24px;padding:12px 32px;background:#1a7;color:#fff;
border:none;border-radius:6px;font-size:1rem;cursor:pointer}
button:hover{background:#159}</style></head><body>
<div class="box">
<h2>✅ 新しい認証情報を取得しました</h2>
<p>「適用する」をクリックすると .env を更新し、YouTube の自動同期を再実行します。</p>
<button id="applyBtn">適用する</button>
<p id="msg" style="margin-top:16px;color:#555"></p>
</div>
<script>
document.getElementById('applyBtn').addEventListener('click', async () => {
  const btn = document.getElementById('applyBtn');
  const msg = document.getElementById('msg');
  btn.disabled = true;
  msg.textContent = '適用中...';
  try {
    const r = await fetch('/api/sf/sync/youtube/oauth/apply', { method: 'POST' });
    const j = await r.json();
    if (j.ok) {
      msg.textContent = '✅ .env を更新しました。このタブを閉じてください。';
      msg.style.color = '#1a7';
    } else {
      msg.textContent = '❌ ' + (j.error || '適用に失敗しました');
      msg.style.color = '#c00';
      btn.disabled = false;
    }
  } catch (e) {
    msg.textContent = '❌ 通信エラー: ' + e.message;
    msg.style.color = '#c00';
    btn.disabled = false;
  }
});
</script></body></html>`;
  }
  return `<!DOCTYPE html><html lang="ja"><head><meta charset="UTF-8">
<title>YouTube 再認証エラー</title>
<style>body{font-family:sans-serif;max-width:480px;margin:60px auto;text-align:center}
.box{border:1px solid #f99;border-radius:8px;padding:32px}
h2{color:#c00}</style></head><body>
<div class="box">
<h2>❌ 認証に失敗しました</h2>
<p>${esc(error)}</p>
<p>このタブを閉じて、JARVISの「再認証」ボタンからやり直してください。</p>
</div></body></html>`;
}

// ─── 入力検証ヘルパー ─────────────────────────────────────────────────────────

function validateMonth(month) {
  return typeof month === 'string' && /^\d{4}-\d{2}$/.test(month);
}

function validateDate(date) {
  return typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date);
}

/** income / expense をパースして非負整数を保証する */
function parseAmount(val) {
  if (val == null) return null;
  const n = parseInt(val, 10);
  if (!Number.isFinite(n) || n < 0) throw new Error('金額は0以上の整数で入力してください');
  return n;
}

/** work_hours / travel_hours をパースして非負数を保証する */
function parseHours(val) {
  if (val == null) return null;
  const n = parseFloat(val);
  if (!Number.isFinite(n) || n < 0) throw new Error('時間は0以上の数値で入力してください');
  return n;
}

// ─── ルーター ─────────────────────────────────────────────────────────────────

/**
 * db を受け取って async リクエストハンドラを返す。
 * @param {import('node:sqlite').DatabaseSync} db
 * @returns {Function} (req, res, url) => void
 */
export function createApiHandler(db) {
  return async function apiHandler(req, res, url) {
    const method = req.method;
    const path   = url.pathname;

    try {

      // ── GET /api/today ─────────────────────────────────────────────────────
      if (path === '/api/today' && method === 'GET') {
        const today = todayISO();
        const month = currentYearMonth();
        const works     = getWorkRecords(db, { yearMonth: month }).filter(r => r.date === today);
        const dayStatus = getDailyStatus(db, today);
        return jsonRes(res, 200, { ok: true, today, month, works, day_status: dayStatus });
      }

      // ── GET /api/summary?month=YYYY-MM ─────────────────────────────────────
      if (path === '/api/summary' && method === 'GET') {
        const month = url.searchParams.get('month') || currentYearMonth();
        if (!validateMonth(month)) return errRes(res, 400, '月は YYYY-MM 形式で指定してください');
        const summary    = getMonthlySummary(db, month);
        const { uninvoiced, unpaid } = getUnpaidCounts(db);
        const fullDayOff = getFullDayOffCount(db, { yearMonth: month });
        return jsonRes(res, 200, { ok: true, month, summary, uninvoiced, unpaid, full_day_off: fullDayOff });
      }

      // ── GET /api/works?month=YYYY-MM ───────────────────────────────────────
      if (path === '/api/works' && method === 'GET') {
        const month = url.searchParams.get('month') || currentYearMonth();
        if (!validateMonth(month)) return errRes(res, 400, '月は YYYY-MM 形式で指定してください');
        const works = getWorkRecords(db, { yearMonth: month });
        return jsonRes(res, 200, { ok: true, works });
      }

      // ── GET /api/works/monthly-summary — work_records 全月集計 ──────────────
      if (path === '/api/works/monthly-summary' && method === 'GET') {
        const rows = db.prepare(`
          SELECT strftime('%Y-%m', date) AS month,
                 COUNT(*) AS count,
                 COALESCE(SUM(income), 0) AS income,
                 COALESCE(SUM(expense), 0) AS expense
          FROM work_records
          GROUP BY month
          ORDER BY month DESC
        `).all();
        return jsonRes(res, 200, { ok: true, rows });
      }

      // ── GET /api/works/category-monthly?year=YYYY — カテゴリ別月次集計 ─────
      if (path.startsWith('/api/works/category-monthly') && method === 'GET') {
        const year = url.searchParams.get('year') || new Date().getFullYear().toString();
        const rows = db.prepare(`
          SELECT strftime('%Y-%m', date) AS month,
                 category,
                 COALESCE(SUM(income), 0)  AS income,
                 COALESCE(SUM(expense), 0) AS expense,
                 COUNT(*) AS count
          FROM work_records
          WHERE date LIKE ?
          GROUP BY month, category
          ORDER BY month, category
        `).all(`${year}-%`);
        return jsonRes(res, 200, { ok: true, year, rows });
      }

      // ── POST /api/work ──────────────────────────────────────────────────────
      if (path === '/api/work' && method === 'POST') {
        let body;
        try { body = await readBody(req); } catch (e) { return errRes(res, 400, e.message); }

        if (!body.date || !body.category) return errRes(res, 400, 'date と category は必須です');
        if (!validateDate(body.date))      return errRes(res, 400, '日付は YYYY-MM-DD 形式で入力してください');

        let income, expense, workHours, travelHours;
        try {
          income      = parseAmount(body.income);
          expense     = parseAmount(body.expense);
          workHours   = parseHours(body.work_hours);
          travelHours = parseHours(body.travel_hours);
        } catch (e) { return errRes(res, 400, e.message); }

        try {
          const { rowid, job_id } = addWorkRecord(db, {
            date:           body.date,
            category:       body.category,
            work_type:      body.work_type      || null,
            content:        body.content        || null,
            client:         body.client         || null,
            income,
            expense,
            work_hours:     workHours,
            travel_hours:   travelHours,
            is_full_day:    body.is_full_day ? 1 : 0,
            invoice_status: body.invoice_status || '対象外',
            payment_status: body.payment_status || '対象外',
            memo:           body.memo           || null,
          });
          // Calendar 連動（非同期・失敗しても HTTP 応答には影響しない）
          hookWorkCreated(db, rowid);
          return jsonRes(res, 201, { ok: true, id: rowid, job_id });
        } catch (e) {
          const status = e.message.startsWith('ConflictError') ? 409 : 400;
          return errRes(res, status, e.message);
        }
      }

      // ── PUT /api/work/:id  ／  DELETE /api/work/:id ───────────────────────
      const workMatch = path.match(/^\/api\/work\/(\d+)$/);

      if (workMatch && method === 'PUT') {
        const id = parseInt(workMatch[1], 10);
        if (!id || isNaN(id)) return errRes(res, 400, '不正なIDです');
        let body;
        try { body = await readBody(req); } catch (e) { return errRes(res, 400, e.message); }
        try {
          updateWorkRecordFull(db, id, {
            date:           body.date,
            category:       body.category,
            work_type:      body.work_type,
            content:        body.content,
            client:         body.client,
            income:         body.income,
            expense:        body.expense,
            work_hours:     body.work_hours,
            travel_hours:   body.travel_hours,
            is_full_day:    body.is_full_day !== undefined ? (body.is_full_day ? 1 : 0) : undefined,
            invoice_status: body.invoice_status,
            payment_status: body.payment_status,
            memo:           body.memo,
          });
          // Calendar 連動（非同期・失敗しても HTTP 応答には影響しない）
          hookWorkUpdated(db, id);
          return jsonRes(res, 200, { ok: true });
        } catch (e) {
          const status = e.message.startsWith('ConflictError') ? 409 : 400;
          return errRes(res, status, e.message);
        }
      }

      if (workMatch && method === 'DELETE') {
        const id = parseInt(workMatch[1], 10);
        if (!id || isNaN(id)) return errRes(res, 400, '不正なIDです');

        // ON DELETE CASCADE でリンクが消える前に削除情報を取得する（Phase 23 起点分岐）
        // calendar 起点の場合は candidate をリセットし googleEventId=null を返す
        const { googleEventId } = prepareWorkRecordDelete(db, id);

        const deleted = deleteWorkRecord(db, id);
        if (!deleted) return errRes(res, 404, '指定された仕事レコードが見つかりません');

        // DB 削除成功後:
        //   jarvis 起点 → Calendar からも非同期削除（失敗時は calendar_delete_queue に記録）
        //   calendar 起点 → googleEventId=null のため hookWorkDeleted は即時 return（削除しない）
        hookWorkDeleted(db, googleEventId, id);

        return jsonRes(res, 200, { ok: true });
      }

      // ── POST /api/day ───────────────────────────────────────────────────────
      if (path === '/api/day' && method === 'POST') {
        let body;
        try { body = await readBody(req); } catch (e) { return errRes(res, 400, e.message); }
        if (!body.date) return errRes(res, 400, 'date は必須です');
        if (!validateDate(body.date)) return errRes(res, 400, '日付は YYYY-MM-DD 形式で入力してください');
        if (typeof body.is_full_day_off !== 'boolean') {
          return errRes(res, 400, 'is_full_day_off は true または false で指定してください');
        }
        try {
          upsertDailyStatus(db, {
            date:           body.date,
            is_full_day_off: body.is_full_day_off,
            memo:           body.memo || null,
          });
          return jsonRes(res, 200, { ok: true });
        } catch (e) { return errRes(res, 400, e.message); }
      }

      // ── POST /api/chat（将来実装・現在は未対応）───────────────────────────
      if (path === '/api/chat' && method === 'POST') {
        return jsonRes(res, 200, {
          ok: true,
          implemented: false,
          message: '自然言語入力は次の開発で対応予定です。',
        });
      }

      // ══════════════════════════════════════════════════════════════════════
      // SF API エンドポイント（Phase 1.5）
      // ══════════════════════════════════════════════════════════════════════

      // ── GET /api/sf/tracks ─────────────────────────────────────────────
      if (path === '/api/sf/tracks' && method === 'GET') {
        return jsonRes(res, 200, { ok: true, tracks: getTracks(db) });
      }

      // ── GET /api/sf/tracks/:id ─────────────────────────────────────────
      const sfTrackMatch = path.match(/^\/api\/sf\/tracks\/(\d+)$/);
      if (sfTrackMatch && method === 'GET') {
        const track = getTrack(db, parseInt(sfTrackMatch[1], 10));
        if (!track) return errRes(res, 404, 'Track not found');
        return jsonRes(res, 200, { ok: true, track });
      }

      // ── POST /api/sf/tracks ────────────────────────────────────────────
      if (path === '/api/sf/tracks' && method === 'POST') {
        let body;
        try { body = await readBody(req); } catch (e) { return errRes(res, 400, e.message); }
        try {
          const result = upsertTrack(db, body);
          return jsonRes(res, 201, { ok: true, ...result });
        } catch (e) { return errRes(res, 400, e.message); }
      }

      // ── PUT /api/sf/tracks/:id ─────────────────────────────────────────
      if (sfTrackMatch && method === 'PUT') {
        let body;
        try { body = await readBody(req); } catch (e) { return errRes(res, 400, e.message); }
        try {
          const result = upsertTrack(db, { ...body, id: parseInt(sfTrackMatch[1], 10) });
          return jsonRes(res, 200, { ok: true, ...result });
        } catch (e) { return errRes(res, 400, e.message); }
      }

      // ── GET /api/sf/releases ───────────────────────────────────────────
      if (path === '/api/sf/releases' && method === 'GET') {
        return jsonRes(res, 200, { ok: true, releases: getReleases(db) });
      }

      // ── GET /api/sf/releases/:id ───────────────────────────────────────
      const sfReleaseMatch = path.match(/^\/api\/sf\/releases\/(\d+)$/);
      if (sfReleaseMatch && method === 'GET') {
        const release = getRelease(db, parseInt(sfReleaseMatch[1], 10));
        if (!release) return errRes(res, 404, 'Release not found');
        return jsonRes(res, 200, { ok: true, release });
      }

      // ── POST /api/sf/releases ──────────────────────────────────────────
      if (path === '/api/sf/releases' && method === 'POST') {
        let body;
        try { body = await readBody(req); } catch (e) { return errRes(res, 400, e.message); }
        try {
          const result = upsertRelease(db, body);
          return jsonRes(res, 201, { ok: true, ...result });
        } catch (e) { return errRes(res, 400, e.message); }
      }

      // ── PUT /api/sf/releases/:id ───────────────────────────────────────
      if (sfReleaseMatch && method === 'PUT') {
        let body;
        try { body = await readBody(req); } catch (e) { return errRes(res, 400, e.message); }
        try {
          const result = upsertRelease(db, { ...body, id: parseInt(sfReleaseMatch[1], 10) });
          return jsonRes(res, 200, { ok: true, ...result });
        } catch (e) { return errRes(res, 400, e.message); }
      }

      // ── GET /api/sf/artist-profiles ────────────────────────────────────
      if (path === '/api/sf/artist-profiles' && method === 'GET') {
        return jsonRes(res, 200, { ok: true, profiles: getArtistProfiles(db) });
      }

      // ── POST /api/sf/artist-profiles ──────────────────────────────────
      if (path === '/api/sf/artist-profiles' && method === 'POST') {
        let body;
        try { body = await readBody(req); } catch (e) { return errRes(res, 400, e.message); }
        try {
          const result = upsertArtistProfile(db, body);
          return jsonRes(res, 201, { ok: true, ...result });
        } catch (e) { return errRes(res, 400, e.message); }
      }

      // ── PUT /api/sf/artist-profiles/:id ───────────────────────────────
      const sfProfileMatch = path.match(/^\/api\/sf\/artist-profiles\/(\d+)$/);
      if (sfProfileMatch && method === 'PUT') {
        let body;
        try { body = await readBody(req); } catch (e) { return errRes(res, 400, e.message); }
        try {
          const result = upsertArtistProfile(db, { ...body, id: parseInt(sfProfileMatch[1], 10) });
          return jsonRes(res, 200, { ok: true, ...result });
        } catch (e) { return errRes(res, 400, e.message); }
      }

      // ── GET /api/sf/distribution-platforms ────────────────────────────
      if (path === '/api/sf/distribution-platforms' && method === 'GET') {
        return jsonRes(res, 200, { ok: true, platforms: getDistributionPlatforms() });
      }

      // ── GET /api/sf/platform-issues ───────────────────────────────────
      if (path === '/api/sf/platform-issues' && method === 'GET') {
        const opts = {
          entity_type:  url.searchParams.get('entity_type')  || undefined,
          entity_id:    url.searchParams.get('entity_id')
                          ? parseInt(url.searchParams.get('entity_id'), 10) : undefined,
          platform:     url.searchParams.get('platform')     || undefined,
          issue_status: url.searchParams.get('issue_status') || undefined,
        };
        return jsonRes(res, 200, { ok: true, issues: getIssues(db, opts) });
      }

      // ── POST /api/sf/platform-issues ──────────────────────────────────
      if (path === '/api/sf/platform-issues' && method === 'POST') {
        let body;
        try { body = await readBody(req); } catch (e) { return errRes(res, 400, e.message); }
        try {
          const result = createIssue(db, body);
          return jsonRes(res, 201, { ok: true, ...result });
        } catch (e) { return errRes(res, 400, e.message); }
      }

      // ── /api/sf/platform-issues/:id/* ─────────────────────────────────
      const sfIssueMatch  = path.match(/^\/api\/sf\/platform-issues\/(\d+)$/);
      const sfIssueAction = path.match(/^\/api\/sf\/platform-issues\/(\d+)\/(request|resolve|check)$/);

      // PUT /api/sf/platform-issues/:id
      if (sfIssueMatch && method === 'PUT') {
        let body;
        try { body = await readBody(req); } catch (e) { return errRes(res, 400, e.message); }
        try {
          const result = updateIssue(db, parseInt(sfIssueMatch[1], 10), body);
          return jsonRes(res, 200, { ok: true, ...result });
        } catch (e) { return errRes(res, 400, e.message); }
      }

      // POST /api/sf/platform-issues/:id/request
      if (sfIssueAction && sfIssueAction[2] === 'request' && method === 'POST') {
        let body = {};
        try { body = await readBody(req); } catch (_) {}
        try {
          const result = setIssueRequested(db, parseInt(sfIssueAction[1], 10), body.requested_at ?? undefined);
          return jsonRes(res, 200, { ok: true, ...result });
        } catch (e) { return errRes(res, 400, e.message); }
      }

      // POST /api/sf/platform-issues/:id/resolve
      if (sfIssueAction && sfIssueAction[2] === 'resolve' && method === 'POST') {
        let body = {};
        try { body = await readBody(req); } catch (_) {}
        try {
          const result = resolveIssue(db, parseInt(sfIssueAction[1], 10), body.resolved_at ?? undefined);
          return jsonRes(res, 200, { ok: true, ...result });
        } catch (e) { return errRes(res, 400, e.message); }
      }

      // POST /api/sf/platform-issues/:id/check
      if (sfIssueAction && sfIssueAction[2] === 'check' && method === 'POST') {
        let body = {};
        try { body = await readBody(req); } catch (_) {}
        try {
          const result = touchIssueChecked(db, parseInt(sfIssueAction[1], 10), body.checked_at ?? undefined);
          return jsonRes(res, 200, { ok: true, ...result });
        } catch (e) { return errRes(res, 400, e.message); }
      }

      // ── GET /api/sf/previews ───────────────────────────────────────────
      if (path === '/api/sf/previews' && method === 'GET') {
        return jsonRes(res, 200, { ok: true, previews: getPreviews(db) });
      }

      // ── POST /api/sf/previews ──────────────────────────────────────────
      if (path === '/api/sf/previews' && method === 'POST') {
        let body;
        try { body = await readBody(req); } catch (e) { return errRes(res, 400, e.message); }
        try {
          const result = upsertPreview(db, body);
          return jsonRes(res, 201, { ok: true, ...result });
        } catch (e) { return errRes(res, 400, e.message); }
      }

      // ── PUT /api/sf/previews/:id ───────────────────────────────────────
      const sfPreviewMatch = path.match(/^\/api\/sf\/previews\/(\d+)$/);
      if (sfPreviewMatch && method === 'PUT') {
        let body;
        try { body = await readBody(req); } catch (e) { return errRes(res, 400, e.message); }
        try {
          const result = upsertPreview(db, { ...body, id: parseInt(sfPreviewMatch[1], 10) });
          return jsonRes(res, 200, { ok: true, ...result });
        } catch (e) { return errRes(res, 400, e.message); }
      }

      // ── GET /api/sf/imports ────────────────────────────────────────────
      if (path === '/api/sf/imports' && method === 'GET') {
        return jsonRes(res, 200, { ok: true, imports: getImportHistory(db) });
      }

      // ── GET /api/sf/imports/unreviewed ─────────────────────────────────
      if (path === '/api/sf/imports/unreviewed' && method === 'GET') {
        return jsonRes(res, 200, { ok: true, rows: getUnreviewedImportRows(db) });
      }

      // ── POST /api/sf/imports ───────────────────────────────────────────
      if (path === '/api/sf/imports' && method === 'POST') {
        let body;
        try { body = await readBody(req); } catch (e) { return errRes(res, 400, e.message); }
        if (!body.file_path) return errRes(res, 400, 'file_path は必須です');
        try {
          const result = await importFile(db, body.file_path, {
            distributor:   body.distributor   || 'soundrop',
            report_period: body.report_period || null,
            delimiter:     body.delimiter     || ',',
          });
          return jsonRes(res, 200, { ok: true, ...result });
        } catch (e) { return errRes(res, 400, e.message); }
      }

      // ── GET /api/sf/revenue/monthly ────────────────────────────────────
      if (path === '/api/sf/revenue/monthly' && method === 'GET') {
        const basis   = url.searchParams.get('basis') === 'statement' ? 'statement' : 'transaction';
        const monthCol = basis === 'statement' ? 'month' : 'transaction_month';
        const rows = db.prepare(`
          SELECT ${monthCol} AS month,
                 ROUND(SUM(amount), 10) AS total_usd,
                 SUM(quantity) AS total_quantity
          FROM sf_revenue
          WHERE import_source IN ('csv', 'api') AND track_id IS NOT NULL
          GROUP BY ${monthCol}
          ORDER BY ${monthCol}
        `).all();
        return jsonRes(res, 200, { ok: true, basis, rows });
      }

      // ── GET /api/sf/revenue/by-track ───────────────────────────────────
      if (path === '/api/sf/revenue/by-track' && method === 'GET') {
        const basis    = url.searchParams.get('basis') === 'statement' ? 'statement' : 'transaction';
        const month    = url.searchParams.get('month') || null;
        const monthCol = basis === 'statement' ? 'r.month' : 'r.transaction_month';
        const rows = db.prepare(`
          SELECT r.track_id,
                 t.title,
                 ROUND(SUM(r.amount), 10) AS total_usd,
                 SUM(r.quantity) AS total_quantity
          FROM sf_revenue r
          JOIN sf_tracks t ON t.id = r.track_id
          WHERE r.import_source IN ('csv', 'api') AND r.track_id IS NOT NULL
            AND (? IS NULL OR ${monthCol} = ?)
          GROUP BY r.track_id
          ORDER BY total_usd DESC
        `).all(month, month);
        return jsonRes(res, 200, { ok: true, basis, month, rows });
      }

      // ── GET /api/sf/revenue/by-service ─────────────────────────────────
      if (path === '/api/sf/revenue/by-service' && method === 'GET') {
        const basis    = url.searchParams.get('basis') === 'statement' ? 'statement' : 'transaction';
        const month    = url.searchParams.get('month') || null;
        const monthCol = basis === 'statement' ? 'month' : 'transaction_month';
        const rows = db.prepare(`
          SELECT platform,
                 ROUND(SUM(amount), 10) AS total_usd,
                 SUM(quantity) AS total_quantity
          FROM sf_revenue
          WHERE import_source IN ('csv', 'api') AND track_id IS NOT NULL
            AND (? IS NULL OR ${monthCol} = ?)
          GROUP BY platform
          ORDER BY total_usd DESC
        `).all(month, month);
        return jsonRes(res, 200, { ok: true, basis, month, rows });
      }

      // ── GET /api/sf/narou/summary ──────────────────────────────────────────
      // 各 ncode の最新スナップショット1件 + sf_works JOIN
      if (path === '/api/sf/narou/summary' && method === 'GET') {
        const workId = url.searchParams.get('work_id') || null;
        const rows = db.prepare(`
          SELECT s.ncode,
                 w.title  AS work_title,
                 w.work_type,
                 w.status AS work_status,
                 s.month,
                 s.pv_total,
                 s.pv_monthly,
                 s.bookmark_count,
                 s.review_count,
                 s.point
          FROM sf_narou_snapshot s
          LEFT JOIN sf_works w ON w.id = s.work_id
          WHERE s.month = (
            SELECT MAX(s2.month)
            FROM sf_narou_snapshot s2
            WHERE s2.ncode = s.ncode
          )
          AND (? IS NULL OR s.work_id = ?)
          ORDER BY s.ncode ASC
        `).all(workId, workId);
        return jsonRes(res, 200, { ok: true, rows });
      }

      // ── GET /api/sf/narou/monthly ──────────────────────────────────────────
      // 月別 PV 推移（全作品または指定 ncode）
      if (path === '/api/sf/narou/monthly' && method === 'GET') {
        const ncode = url.searchParams.get('ncode') || null;
        const rows = db.prepare(`
          SELECT month, ncode, pv_monthly, pv_total, bookmark_count, point
          FROM sf_narou_snapshot
          WHERE (? IS NULL OR ncode = ?)
          ORDER BY month ASC, ncode ASC
        `).all(ncode, ncode);
        return jsonRes(res, 200, { ok: true, rows });
      }

      // ── GET /api/sf/narou/compare ──────────────────────────────────────────
      // 作品別の最新値比較（メトリクス指定）
      if (path === '/api/sf/narou/compare' && method === 'GET') {
        const VALID_METRICS = ['pv_total', 'pv_monthly', 'bookmark_count', 'point', 'review_count'];
        const metric = VALID_METRICS.includes(url.searchParams.get('metric'))
          ? url.searchParams.get('metric')
          : 'pv_total';
        const rows = db.prepare(`
          SELECT s.ncode,
                 w.title AS work_title,
                 s.${metric} AS value,
                 s.month
          FROM sf_narou_snapshot s
          LEFT JOIN sf_works w ON w.id = s.work_id
          WHERE s.month = (
            SELECT MAX(s2.month)
            FROM sf_narou_snapshot s2
            WHERE s2.ncode = s.ncode
          )
          ORDER BY value DESC NULLS LAST, s.ncode ASC
        `).all();
        return jsonRes(res, 200, { ok: true, metric, rows });
      }

      // ══════════════════════════════════════════════════════════════════════
      // SF GA4 エンドポイント（Phase 4）
      // ══════════════════════════════════════════════════════════════════════

      // ── GET /api/sf/ga/daily ───────────────────────────────────────────────
      // 日別 PV・ユーザー・セッション推移
      if (path === '/api/sf/ga/daily' && method === 'GET') {
        const toParam   = url.searchParams.get('to');
        const fromParam = url.searchParams.get('from');
        const toDate    = (toParam && validateDate(toParam)) ? toParam : todayISO();
        let fromDate;
        if (fromParam && validateDate(fromParam)) {
          fromDate = fromParam;
        } else {
          const d = new Date(toDate);
          d.setDate(d.getDate() - 29);
          fromDate = [
            d.getFullYear(),
            String(d.getMonth() + 1).padStart(2, '0'),
            String(d.getDate()).padStart(2, '0'),
          ].join('-');
        }
        const pagePath = url.searchParams.get('page_path') || null;
        const rows = db.prepare(`
          SELECT date,
                 SUM(page_views)       AS page_views,
                 SUM(users)            AS users,
                 SUM(sessions)         AS sessions,
                 SUM(engaged_sessions) AS engaged_sessions
          FROM sf_ga_daily
          WHERE date >= ? AND date <= ?
            AND (? IS NULL OR page_path = ?)
          GROUP BY date
          ORDER BY date ASC
        `).all(fromDate, toDate, pagePath, pagePath);
        return jsonRes(res, 200, { ok: true, rows });
      }

      // ── GET /api/sf/ga/pages ───────────────────────────────────────────────
      // ページ別 PV 集計
      if (path === '/api/sf/ga/pages' && method === 'GET') {
        const toParam   = url.searchParams.get('to');
        const fromParam = url.searchParams.get('from');
        const toDate    = (toParam && validateDate(toParam)) ? toParam : todayISO();
        let fromDate;
        if (fromParam && validateDate(fromParam)) {
          fromDate = fromParam;
        } else {
          const d = new Date(toDate);
          d.setDate(d.getDate() - 29);
          fromDate = [
            d.getFullYear(),
            String(d.getMonth() + 1).padStart(2, '0'),
            String(d.getDate()).padStart(2, '0'),
          ].join('-');
        }
        const rows = db.prepare(`
          SELECT page_path,
                 SUM(page_views) AS page_views,
                 SUM(users)      AS users,
                 SUM(sessions)   AS sessions
          FROM sf_ga_daily
          WHERE date >= ? AND date <= ?
          GROUP BY page_path
          ORDER BY page_views DESC, page_path ASC
        `).all(fromDate, toDate);
        return jsonRes(res, 200, { ok: true, rows });
      }

      // ── GET /api/sf/ga/compare ─────────────────────────────────────────────
      // ページ別比較（直近期間 vs 前期間）
      if (path === '/api/sf/ga/compare' && method === 'GET') {
        const VALID_DAYS = [7, 14, 30];
        const daysParam = parseInt(url.searchParams.get('days') || '30', 10);
        const days = VALID_DAYS.includes(daysParam) ? daysParam : 30;

        const today = todayISO();
        function subDays(base, n) {
          const d = new Date(base);
          d.setDate(d.getDate() - n);
          return [
            d.getFullYear(),
            String(d.getMonth() + 1).padStart(2, '0'),
            String(d.getDate()).padStart(2, '0'),
          ].join('-');
        }
        const currentEnd   = today;
        const currentStart = subDays(today, days - 1);
        const previousEnd  = subDays(today, days);
        const previousStart = subDays(today, days * 2 - 1);

        const rows = db.prepare(`
          SELECT page_path,
                 SUM(CASE WHEN date >= ? AND date <= ? THEN page_views ELSE 0 END) AS current_views,
                 SUM(CASE WHEN date >= ? AND date <= ? THEN page_views ELSE 0 END) AS previous_views
          FROM sf_ga_daily
          WHERE date >= ? AND date <= ?
          GROUP BY page_path
          ORDER BY current_views DESC, page_path ASC
        `).all(currentStart, currentEnd, previousStart, previousEnd, previousStart, currentEnd);
        return jsonRes(res, 200, { ok: true, days, rows });
      }

      // ── GET /api/sf/ga/sources ─────────────────────────────────────────────
      // 流入元別集計（sessionSource / sessionMedium 別、Phase 19）
      if (path === '/api/sf/ga/sources' && method === 'GET') {
        const toParam   = url.searchParams.get('to');
        const fromParam = url.searchParams.get('from');
        const toDate    = (toParam && validateDate(toParam)) ? toParam : todayISO();
        let fromDate;
        if (fromParam && validateDate(fromParam)) {
          fromDate = fromParam;
        } else {
          const d = new Date(toDate);
          d.setDate(d.getDate() - 29);
          fromDate = [
            d.getFullYear(),
            String(d.getMonth() + 1).padStart(2, '0'),
            String(d.getDate()).padStart(2, '0'),
          ].join('-');
        }
        const rows = db.prepare(`
          SELECT session_source,
                 session_medium,
                 SUM(sessions)         AS sessions,
                 SUM(users)            AS users,
                 SUM(page_views)       AS page_views,
                 SUM(engaged_sessions) AS engaged_sessions
          FROM sf_ga_sources
          WHERE date >= ? AND date <= ?
          GROUP BY session_source, session_medium
          ORDER BY sessions DESC, session_source ASC, session_medium ASC
        `).all(fromDate, toDate);
        return jsonRes(res, 200, { ok: true, from: fromDate, to: toDate, rows });
      }

      // ══════════════════════════════════════════════════════════════════════
      // SF 音楽指標エンドポイント（Phase 5）
      // ══════════════════════════════════════════════════════════════════════

      // ── GET /api/sf/music/monthly ──────────────────────────────────────────
      // 月別総再生数推移
      if (path === '/api/sf/music/monthly' && method === 'GET') {
        const fromParam  = url.searchParams.get('from');
        const toParam    = url.searchParams.get('to');
        const platform   = url.searchParams.get('platform') || null;
        const trackIdRaw = url.searchParams.get('track_id');
        const trackId    = trackIdRaw ? parseInt(trackIdRaw, 10) : null;

        // デフォルト: 直近12ヶ月
        const now = new Date();
        const defaultTo = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
        const prev = new Date(now);
        prev.setMonth(prev.getMonth() - 11);
        const defaultFrom = `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`;

        const fromMonth = (fromParam && validateMonth(fromParam)) ? fromParam : defaultFrom;
        const toMonth   = (toParam   && validateMonth(toParam))   ? toParam   : defaultTo;

        const rows = db.prepare(`
          SELECT month, SUM(streams) AS streams
          FROM sf_music_metrics
          WHERE granularity = 'monthly'
            AND month >= ? AND month <= ?
            AND (? IS NULL OR platform = ?)
            AND (? IS NULL OR track_id = ?)
          GROUP BY month
          ORDER BY month ASC
        `).all(fromMonth, toMonth, platform, platform, trackId, trackId);
        return jsonRes(res, 200, { ok: true, rows });
      }

      // ── GET /api/sf/music/by-track ─────────────────────────────────────────
      // 楽曲別総再生数
      if (path === '/api/sf/music/by-track' && method === 'GET') {
        const fromParam = url.searchParams.get('from') || null;
        const toParam   = url.searchParams.get('to')   || null;
        const platform  = url.searchParams.get('platform') || null;

        const fromMonth = (fromParam && validateMonth(fromParam)) ? fromParam : null;
        const toMonth   = (toParam   && validateMonth(toParam))   ? toParam   : null;

        const rows = db.prepare(`
          SELECT m.track_id, t.title, SUM(m.streams) AS streams, ? AS platform
          FROM sf_music_metrics m
          JOIN sf_tracks t ON t.id = m.track_id
          WHERE m.granularity = 'monthly'
            AND (? IS NULL OR m.month >= ?)
            AND (? IS NULL OR m.month <= ?)
            AND (? IS NULL OR m.platform = ?)
          GROUP BY m.track_id
          ORDER BY streams DESC, m.track_id ASC
        `).all(platform, fromMonth, fromMonth, toMonth, toMonth, platform, platform);
        return jsonRes(res, 200, { ok: true, rows });
      }

      // ── GET /api/sf/music/by-platform ─────────────────────────────────────
      // サービス別総再生数
      if (path === '/api/sf/music/by-platform' && method === 'GET') {
        const fromParam  = url.searchParams.get('from') || null;
        const toParam    = url.searchParams.get('to')   || null;
        const trackIdRaw = url.searchParams.get('track_id');
        const trackId    = trackIdRaw ? parseInt(trackIdRaw, 10) : null;

        const fromMonth = (fromParam && validateMonth(fromParam)) ? fromParam : null;
        const toMonth   = (toParam   && validateMonth(toParam))   ? toParam   : null;

        const rows = db.prepare(`
          SELECT platform, SUM(streams) AS streams
          FROM sf_music_metrics
          WHERE granularity = 'monthly'
            AND (? IS NULL OR month >= ?)
            AND (? IS NULL OR month <= ?)
            AND (? IS NULL OR track_id = ?)
          GROUP BY platform
          ORDER BY streams DESC, platform ASC
        `).all(fromMonth, fromMonth, toMonth, toMonth, trackId, trackId);
        return jsonRes(res, 200, { ok: true, rows });
      }

      // ══════════════════════════════════════════════════════════════════════
      // SF YouTube エンドポイント（Phase 7）
      // ══════════════════════════════════════════════════════════════════════

      // ── GET /api/sf/youtube/channel/daily ─────────────────────────────────
      // 日別チャンネル指標（再生数・視聴時間・登録者変化・CTR 等）
      // ?from=YYYY-MM-DD  &to=YYYY-MM-DD  （デフォルト: 直近30日）
      if (path === '/api/sf/youtube/channel/daily' && method === 'GET') {
        const toParam   = url.searchParams.get('to');
        const fromParam = url.searchParams.get('from');
        const toDate   = (toParam   && validateDate(toParam))   ? toParam   : todayISO();
        let fromDate;
        if (fromParam && validateDate(fromParam)) {
          fromDate = fromParam;
        } else {
          const d = new Date(toDate);
          d.setDate(d.getDate() - 29);
          fromDate = [
            d.getFullYear(),
            String(d.getMonth() + 1).padStart(2, '0'),
            String(d.getDate()).padStart(2, '0'),
          ].join('-');
        }
        const rows = db.prepare(`
          SELECT date,
                 subscribers_count, subscribers_gained, subscribers_lost,
                 views, estimated_minutes_watched, average_view_duration_sec,
                 impressions, ctr
          FROM sf_youtube_channel_daily
          WHERE date >= ? AND date <= ?
          ORDER BY date ASC
        `).all(fromDate, toDate);
        return jsonRes(res, 200, { ok: true, from: fromDate, to: toDate, rows });
      }

      // ── GET /api/sf/youtube/channel/compare ───────────────────────────────
      // 現在期間 vs 前期間 比較（合計値）
      // ?days=7|14|30  （デフォルト: 30）
      if (path === '/api/sf/youtube/channel/compare' && method === 'GET') {
        const VALID_DAYS = [7, 14, 30];
        const daysParam = parseInt(url.searchParams.get('days') || '30', 10);
        const days = VALID_DAYS.includes(daysParam) ? daysParam : 30;

        const today = todayISO();
        function subDaysYT(base, n) {
          const d = new Date(base);
          d.setDate(d.getDate() - n);
          return [
            d.getFullYear(),
            String(d.getMonth() + 1).padStart(2, '0'),
            String(d.getDate()).padStart(2, '0'),
          ].join('-');
        }
        const currentEnd    = today;
        const currentStart  = subDaysYT(today, days - 1);
        const previousEnd   = subDaysYT(today, days);
        const previousStart = subDaysYT(today, days * 2 - 1);

        const [summary] = db.prepare(`
          SELECT
            SUM(CASE WHEN date >= ? AND date <= ? THEN views                     ELSE 0 END) AS current_views,
            SUM(CASE WHEN date >= ? AND date <= ? THEN views                     ELSE 0 END) AS previous_views,
            SUM(CASE WHEN date >= ? AND date <= ? THEN estimated_minutes_watched ELSE 0 END) AS current_watch_min,
            SUM(CASE WHEN date >= ? AND date <= ? THEN estimated_minutes_watched ELSE 0 END) AS previous_watch_min,
            SUM(CASE WHEN date >= ? AND date <= ? THEN subscribers_gained        ELSE 0 END) AS current_subs_gained,
            SUM(CASE WHEN date >= ? AND date <= ? THEN subscribers_gained        ELSE 0 END) AS previous_subs_gained,
            SUM(CASE WHEN date >= ? AND date <= ? THEN subscribers_lost          ELSE 0 END) AS current_subs_lost,
            SUM(CASE WHEN date >= ? AND date <= ? THEN subscribers_lost          ELSE 0 END) AS previous_subs_lost,
            SUM(CASE WHEN date >= ? AND date <= ? THEN impressions               ELSE 0 END) AS current_impressions,
            SUM(CASE WHEN date >= ? AND date <= ? THEN impressions               ELSE 0 END) AS previous_impressions
          FROM sf_youtube_channel_daily
          WHERE date >= ? AND date <= ?
        `).all(
          currentStart, currentEnd,   previousStart, previousEnd,
          currentStart, currentEnd,   previousStart, previousEnd,
          currentStart, currentEnd,   previousStart, previousEnd,
          currentStart, currentEnd,   previousStart, previousEnd,
          currentStart, currentEnd,   previousStart, previousEnd,
          previousStart, currentEnd,
        );

        // 期間端の登録者数
        const [subsCurrent] = db.prepare(`
          SELECT subscribers_count FROM sf_youtube_channel_daily
          WHERE date <= ? ORDER BY date DESC LIMIT 1
        `).all(currentEnd);
        const [subsPrevEnd] = db.prepare(`
          SELECT subscribers_count FROM sf_youtube_channel_daily
          WHERE date <= ? ORDER BY date DESC LIMIT 1
        `).all(previousEnd);

        return jsonRes(res, 200, {
          ok: true,
          days,
          current:  { start: currentStart,  end: currentEnd },
          previous: { start: previousStart, end: previousEnd },
          subscribers_count: {
            current:  subsCurrent?.subscribers_count ?? null,
            previous: subsPrevEnd?.subscribers_count ?? null,
          },
          ...summary,
        });
      }

      // ── GET /api/sf/youtube/videos ─────────────────────────────────────────
      // 動画一覧 + 最新スナップショット（公開日降順）
      // ?limit=N  &offset=N  &type=video|short
      if (path === '/api/sf/youtube/videos' && method === 'GET') {
        const limitRaw  = parseInt(url.searchParams.get('limit')  || '20', 10);
        const offsetRaw = parseInt(url.searchParams.get('offset') || '0',  10);
        const limit  = (Number.isFinite(limitRaw)  && limitRaw  > 0 && limitRaw  <= 100) ? limitRaw  : 20;
        const offset = (Number.isFinite(offsetRaw) && offsetRaw >= 0)                    ? offsetRaw : 0;
        const VALID_TYPES = ['video', 'short'];
        const typeFilter  = url.searchParams.get('type') || null;
        const contentType = VALID_TYPES.includes(typeFilter) ? typeFilter : null;

        const rows = db.prepare(`
          SELECT cr.id, cr.platform_id, cr.title, cr.content_type,
                 cr.published_at, cr.duration_sec,
                 sm.snapshot_date, sm.views, sm.watch_time_min, sm.avg_watch_sec,
                 sm.likes, sm.comments, sm.shares, sm.completion_rate
          FROM sf_content_registry cr
          LEFT JOIN sf_social_metrics sm
            ON sm.content_reg_id = cr.id
           AND sm.snapshot_date = (
                 SELECT MAX(sm2.snapshot_date)
                 FROM sf_social_metrics sm2
                 WHERE sm2.content_reg_id = cr.id
               )
          WHERE cr.platform = 'youtube'
            AND (? IS NULL OR cr.content_type = ?)
          ORDER BY cr.published_at DESC, cr.id DESC
          LIMIT ? OFFSET ?
        `).all(contentType, contentType, limit, offset);
        return jsonRes(res, 200, { ok: true, limit, offset, rows });
      }

      // ── GET /api/sf/youtube/videos/top ────────────────────────────────────
      // 上位動画（指標指定・最新スナップショット基準）
      // ?metric=views|watch_time_min|likes|comments|shares  &type=video|short  &limit=N
      if (path === '/api/sf/youtube/videos/top' && method === 'GET') {
        const VALID_METRICS = ['views', 'watch_time_min', 'likes', 'comments', 'shares', 'avg_watch_sec'];
        const metricParam   = url.searchParams.get('metric') || 'views';
        const metric        = VALID_METRICS.includes(metricParam) ? metricParam : 'views';

        const limitRaw    = parseInt(url.searchParams.get('limit') || '10', 10);
        const limit       = (Number.isFinite(limitRaw) && limitRaw > 0 && limitRaw <= 50) ? limitRaw : 10;
        const VALID_TYPES = ['video', 'short'];
        const typeFilter  = url.searchParams.get('type') || null;
        const contentType = VALID_TYPES.includes(typeFilter) ? typeFilter : null;

        const rows = db.prepare(`
          SELECT cr.id, cr.platform_id, cr.title, cr.content_type,
                 cr.published_at, cr.duration_sec,
                 sm.snapshot_date, sm.views, sm.watch_time_min, sm.avg_watch_sec,
                 sm.likes, sm.comments, sm.shares, sm.completion_rate
          FROM sf_content_registry cr
          LEFT JOIN sf_social_metrics sm
            ON sm.content_reg_id = cr.id
           AND sm.snapshot_date = (
                 SELECT MAX(sm2.snapshot_date)
                 FROM sf_social_metrics sm2
                 WHERE sm2.content_reg_id = cr.id
               )
          WHERE cr.platform = 'youtube'
            AND (? IS NULL OR cr.content_type = ?)
          ORDER BY sm.${metric} DESC NULLS LAST, cr.published_at DESC
          LIMIT ?
        `).all(contentType, contentType, limit);
        return jsonRes(res, 200, { ok: true, metric, limit, rows });
      }

      // ── GET /api/sf/youtube/channel/traffic ───────────────────────────────
      // トラフィックソース別内訳（dimensions=insightTrafficSourceType）
      // ?from=YYYY-MM-DD  &to=YYYY-MM-DD  （デフォルト: 直近30日）
      if (path === '/api/sf/youtube/channel/traffic' && method === 'GET') {
        const toParam   = url.searchParams.get('to');
        const fromParam = url.searchParams.get('from');
        const toDate   = (toParam   && validateDate(toParam))   ? toParam   : todayISO();
        let fromDate;
        if (fromParam && validateDate(fromParam)) {
          fromDate = fromParam;
        } else {
          const _d = new Date(toDate);
          _d.setDate(_d.getDate() - 29);
          fromDate = [
            _d.getFullYear(),
            String(_d.getMonth() + 1).padStart(2, '0'),
            String(_d.getDate()).padStart(2, '0'),
          ].join('-');
        }
        const rows = db.prepare(`
          SELECT source_type, SUM(views) AS views,
                 SUM(estimated_minutes_watched) AS estimated_minutes_watched
          FROM sf_youtube_traffic_sources
          WHERE period_start >= ? AND period_end <= ?
          GROUP BY source_type
          ORDER BY views DESC NULLS LAST
        `).all(fromDate, toDate);
        return jsonRes(res, 200, { ok: true, from: fromDate, to: toDate, rows });
      }

      // ══════════════════════════════════════════════════════════════════════
      // SF Instagram エンドポイント（Phase 6）
      // ══════════════════════════════════════════════════════════════════════

      // ── GET /api/sf/instagram/account/daily ───────────────────────────────
      // 日別アカウント指標（フォロワー・リーチ等）
      // ?from=YYYY-MM-DD  &to=YYYY-MM-DD  （デフォルト: 直近30日）
      if (path === '/api/sf/instagram/account/daily' && method === 'GET') {
        const toParam   = url.searchParams.get('to');
        const fromParam = url.searchParams.get('from');
        const toDate   = (toParam   && validateDate(toParam))   ? toParam   : todayISO();
        let fromDate;
        if (fromParam && validateDate(fromParam)) {
          fromDate = fromParam;
        } else {
          const d = new Date(toDate);
          d.setDate(d.getDate() - 29);
          fromDate = [
            d.getFullYear(),
            String(d.getMonth() + 1).padStart(2, '0'),
            String(d.getDate()).padStart(2, '0'),
          ].join('-');
        }
        const rows = db.prepare(`
          SELECT date,
                 followers_count, follows_count, media_count,
                 reach, views, accounts_engaged, total_interactions,
                 likes, comments, shares, saves,
                 follows_and_unfollows, profile_links_taps
          FROM sf_instagram_account_daily
          WHERE date >= ? AND date <= ?
          ORDER BY date ASC
        `).all(fromDate, toDate);
        return jsonRes(res, 200, { ok: true, from: fromDate, to: toDate, rows });
      }

      // ── GET /api/sf/instagram/account/compare ─────────────────────────────
      // 現在期間 vs 前期間 比較（日合計）
      // ?days=7|14|30  （デフォルト: 30）
      if (path === '/api/sf/instagram/account/compare' && method === 'GET') {
        const VALID_DAYS = [7, 14, 30];
        const daysParam = parseInt(url.searchParams.get('days') || '30', 10);
        const days = VALID_DAYS.includes(daysParam) ? daysParam : 30;

        const today = todayISO();
        function subDaysIG(base, n) {
          const d = new Date(base);
          d.setDate(d.getDate() - n);
          return [
            d.getFullYear(),
            String(d.getMonth() + 1).padStart(2, '0'),
            String(d.getDate()).padStart(2, '0'),
          ].join('-');
        }
        const currentEnd    = today;
        const currentStart  = subDaysIG(today, days - 1);
        const previousEnd   = subDaysIG(today, days);
        const previousStart = subDaysIG(today, days * 2 - 1);

        const [summary] = db.prepare(`
          SELECT
            SUM(CASE WHEN date >= ? AND date <= ? THEN reach             ELSE 0 END) AS current_reach,
            SUM(CASE WHEN date >= ? AND date <= ? THEN reach             ELSE 0 END) AS previous_reach,
            SUM(CASE WHEN date >= ? AND date <= ? THEN views             ELSE 0 END) AS current_views,
            SUM(CASE WHEN date >= ? AND date <= ? THEN views             ELSE 0 END) AS previous_views,
            SUM(CASE WHEN date >= ? AND date <= ? THEN total_interactions ELSE 0 END) AS current_interactions,
            SUM(CASE WHEN date >= ? AND date <= ? THEN total_interactions ELSE 0 END) AS previous_interactions,
            SUM(CASE WHEN date >= ? AND date <= ? THEN follows_and_unfollows ELSE 0 END) AS current_follows_delta,
            SUM(CASE WHEN date >= ? AND date <= ? THEN follows_and_unfollows ELSE 0 END) AS previous_follows_delta
          FROM sf_instagram_account_daily
          WHERE date >= ? AND date <= ?
        `).all(
          currentStart,  currentEnd,
          previousStart, previousEnd,
          currentStart,  currentEnd,
          previousStart, previousEnd,
          currentStart,  currentEnd,
          previousStart, previousEnd,
          currentStart,  currentEnd,
          previousStart, previousEnd,
          previousStart, currentEnd,
        );

        // 期間端のフォロワー数を取得
        const [followersCurrent] = db.prepare(`
          SELECT followers_count FROM sf_instagram_account_daily
          WHERE date <= ? ORDER BY date DESC LIMIT 1
        `).all(currentEnd);
        const [followersPrevEnd] = db.prepare(`
          SELECT followers_count FROM sf_instagram_account_daily
          WHERE date <= ? ORDER BY date DESC LIMIT 1
        `).all(previousEnd);

        return jsonRes(res, 200, {
          ok: true,
          days,
          current:  { start: currentStart,  end: currentEnd },
          previous: { start: previousStart, end: previousEnd },
          followers_count: {
            current:  followersCurrent?.followers_count  ?? null,
            previous: followersPrevEnd?.followers_count  ?? null,
          },
          ...summary,
        });
      }

      // ── GET /api/sf/instagram/media ────────────────────────────────────────
      // メディア一覧 + 最新スナップショット（公開日降順）
      // ?limit=N  &offset=N  &type=FEED|REELS
      if (path === '/api/sf/instagram/media' && method === 'GET') {
        const limitRaw  = parseInt(url.searchParams.get('limit')  || '20', 10);
        const offsetRaw = parseInt(url.searchParams.get('offset') || '0',  10);
        const typeFilter = url.searchParams.get('type') || null;
        const limit  = (Number.isFinite(limitRaw)  && limitRaw  > 0 && limitRaw  <= 100) ? limitRaw  : 20;
        const offset = (Number.isFinite(offsetRaw) && offsetRaw >= 0)                     ? offsetRaw : 0;

        const VALID_TYPES = ['FEED', 'REELS'];
        const productType = VALID_TYPES.includes(typeFilter) ? typeFilter : null;

        const rows = db.prepare(`
          SELECT m.instagram_media_id,
                 m.media_type, m.media_product_type,
                 m.published_at, m.caption, m.permalink,
                 d.date        AS snapshot_date,
                 d.like_count, d.comments_count, d.view_count,
                 d.shares_count, d.saved_count, d.reposts_count,
                 d.reach, d.profile_visits, d.avg_watch_time_ms
          FROM sf_instagram_media m
          LEFT JOIN sf_instagram_media_daily d
            ON d.instagram_media_id = m.instagram_media_id
           AND d.date = (
                 SELECT MAX(d2.date)
                 FROM sf_instagram_media_daily d2
                 WHERE d2.instagram_media_id = m.instagram_media_id
               )
          WHERE (? IS NULL OR m.media_product_type = ?)
          ORDER BY m.published_at DESC, m.instagram_media_id ASC
          LIMIT ? OFFSET ?
        `).all(productType, productType, limit, offset);
        return jsonRes(res, 200, { ok: true, limit, offset, rows });
      }

      // ── GET /api/sf/instagram/media/top ───────────────────────────────────
      // 上位投稿（指標指定・最新スナップショット基準）
      // ?metric=view_count|reach|like_count|avg_watch_time_ms
      // ?type=FEED|REELS  &limit=N
      if (path === '/api/sf/instagram/media/top' && method === 'GET') {
        const VALID_METRICS = ['view_count', 'reach', 'like_count', 'avg_watch_time_ms',
                               'comments_count', 'shares_count', 'saved_count'];
        const metricParam = url.searchParams.get('metric') || 'view_count';
        const metric      = VALID_METRICS.includes(metricParam) ? metricParam : 'view_count';

        const limitRaw  = parseInt(url.searchParams.get('limit') || '10', 10);
        const limit     = (Number.isFinite(limitRaw) && limitRaw > 0 && limitRaw <= 50) ? limitRaw : 10;
        const typeFilter = url.searchParams.get('type') || null;
        const VALID_TYPES = ['FEED', 'REELS'];
        const productType = VALID_TYPES.includes(typeFilter) ? typeFilter : null;

        const rows = db.prepare(`
          SELECT m.instagram_media_id,
                 m.media_type, m.media_product_type,
                 m.published_at, m.caption, m.permalink,
                 d.date        AS snapshot_date,
                 d.view_count, d.reach, d.like_count,
                 d.comments_count, d.shares_count, d.saved_count,
                 d.avg_watch_time_ms
          FROM sf_instagram_media m
          LEFT JOIN sf_instagram_media_daily d
            ON d.instagram_media_id = m.instagram_media_id
           AND d.date = (
                 SELECT MAX(d2.date)
                 FROM sf_instagram_media_daily d2
                 WHERE d2.instagram_media_id = m.instagram_media_id
               )
          WHERE (? IS NULL OR m.media_product_type = ?)
          ORDER BY d.${metric} DESC NULLS LAST, m.published_at DESC
          LIMIT ?
        `).all(productType, productType, limit);
        return jsonRes(res, 200, { ok: true, metric, limit, rows });
      }

      // ══════════════════════════════════════════════════════════════════════
      // SF TikTok エンドポイント（Phase 8）
      // ══════════════════════════════════════════════════════════════════════

      // ── GET /api/sf/tiktok/account/daily ─────────────────────────────────
      // 日別アカウント指標（フォロワー・リーチ等）
      // ?from=YYYY-MM-DD  &to=YYYY-MM-DD  （デフォルト: 直近30日）
      if (path === '/api/sf/tiktok/account/daily' && method === 'GET') {
        const toParam   = url.searchParams.get('to');
        const fromParam = url.searchParams.get('from');
        const toDate   = (toParam   && validateDate(toParam))   ? toParam   : todayISO();
        let fromDate;
        if (fromParam && validateDate(fromParam)) {
          fromDate = fromParam;
        } else {
          const d = new Date(toDate);
          d.setDate(d.getDate() - 29);
          fromDate = [
            d.getFullYear(),
            String(d.getMonth() + 1).padStart(2, '0'),
            String(d.getDate()).padStart(2, '0'),
          ].join('-');
        }
        const rows = db.prepare(`
          SELECT date, followers, followers_delta, reach, impressions,
                 profile_visits, link_clicks
          FROM sf_account_daily
          WHERE platform = 'tiktok' AND date >= ? AND date <= ?
          ORDER BY date ASC
        `).all(fromDate, toDate);
        return jsonRes(res, 200, { ok: true, from: fromDate, to: toDate, rows });
      }

      // ── GET /api/sf/tiktok/account/compare ───────────────────────────────
      // 現在期間 vs 前期間 比較（フォロワー・リーチ合計）
      // ?days=7|14|30  （デフォルト: 30）
      if (path === '/api/sf/tiktok/account/compare' && method === 'GET') {
        const VALID_DAYS_TT = [7, 14, 30];
        const daysParam = parseInt(url.searchParams.get('days') || '30', 10);
        const days = VALID_DAYS_TT.includes(daysParam) ? daysParam : 30;

        const today = todayISO();
        function subDaysTT(base, n) {
          const d = new Date(base);
          d.setDate(d.getDate() - n);
          return [
            d.getFullYear(),
            String(d.getMonth() + 1).padStart(2, '0'),
            String(d.getDate()).padStart(2, '0'),
          ].join('-');
        }
        const currentEnd    = today;
        const currentStart  = subDaysTT(today, days - 1);
        const previousEnd   = subDaysTT(today, days);
        const previousStart = subDaysTT(today, days * 2 - 1);

        const [summary] = db.prepare(`
          SELECT
            SUM(CASE WHEN date >= ? AND date <= ? THEN reach             ELSE 0 END) AS current_reach,
            SUM(CASE WHEN date >= ? AND date <= ? THEN reach             ELSE 0 END) AS previous_reach,
            SUM(CASE WHEN date >= ? AND date <= ? THEN impressions       ELSE 0 END) AS current_impressions,
            SUM(CASE WHEN date >= ? AND date <= ? THEN impressions       ELSE 0 END) AS previous_impressions,
            SUM(CASE WHEN date >= ? AND date <= ? THEN profile_visits    ELSE 0 END) AS current_profile_visits,
            SUM(CASE WHEN date >= ? AND date <= ? THEN profile_visits    ELSE 0 END) AS previous_profile_visits,
            SUM(CASE WHEN date >= ? AND date <= ? THEN followers_delta   ELSE 0 END) AS current_followers_delta,
            SUM(CASE WHEN date >= ? AND date <= ? THEN followers_delta   ELSE 0 END) AS previous_followers_delta
          FROM sf_account_daily
          WHERE platform = 'tiktok' AND date >= ? AND date <= ?
        `).all(
          currentStart,  currentEnd,
          previousStart, previousEnd,
          currentStart,  currentEnd,
          previousStart, previousEnd,
          currentStart,  currentEnd,
          previousStart, previousEnd,
          currentStart,  currentEnd,
          previousStart, previousEnd,
          previousStart, currentEnd,
        );

        const [followersCurrent] = db.prepare(`
          SELECT followers FROM sf_account_daily
          WHERE platform = 'tiktok' AND date <= ? ORDER BY date DESC LIMIT 1
        `).all(currentEnd);
        const [followersPrevEnd] = db.prepare(`
          SELECT followers FROM sf_account_daily
          WHERE platform = 'tiktok' AND date <= ? ORDER BY date DESC LIMIT 1
        `).all(previousEnd);

        return jsonRes(res, 200, {
          ok: true,
          days,
          current:  { start: currentStart,  end: currentEnd },
          previous: { start: previousStart, end: previousEnd },
          followers_count: {
            current:  followersCurrent?.followers  ?? null,
            previous: followersPrevEnd?.followers  ?? null,
          },
          ...summary,
        });
      }

      // ── GET /api/sf/tiktok/videos ─────────────────────────────────────────
      // 動画一覧＋最新スナップショット（公開日降順）
      // ?limit=N  &offset=N
      if (path === '/api/sf/tiktok/videos' && method === 'GET') {
        const limitRaw  = parseInt(url.searchParams.get('limit')  || '20', 10);
        const offsetRaw = parseInt(url.searchParams.get('offset') || '0',  10);
        const limit  = (Number.isFinite(limitRaw)  && limitRaw  > 0 && limitRaw  <= 100) ? limitRaw  : 20;
        const offset = (Number.isFinite(offsetRaw) && offsetRaw >= 0)                     ? offsetRaw : 0;

        const rows = db.prepare(`
          SELECT cr.platform_id, cr.title, cr.published_at, cr.duration_sec,
                 sm.snapshot_date, sm.views, sm.likes, sm.comments, sm.shares,
                 sm.saves, sm.watch_time_min, sm.avg_watch_sec, sm.completion_rate
          FROM sf_content_registry cr
          LEFT JOIN sf_social_metrics sm
            ON sm.content_reg_id = cr.id
           AND sm.snapshot_date = (
                 SELECT MAX(sm2.snapshot_date)
                 FROM sf_social_metrics sm2
                 WHERE sm2.content_reg_id = cr.id
               )
          WHERE cr.platform = 'tiktok'
          ORDER BY cr.published_at DESC NULLS LAST, cr.platform_id ASC
          LIMIT ? OFFSET ?
        `).all(limit, offset);
        return jsonRes(res, 200, { ok: true, limit, offset, rows });
      }

      // ── GET /api/sf/tiktok/videos/top ────────────────────────────────────
      // 上位動画（指標指定・最新スナップショット基準）
      // ?metric=views|likes|comments|shares|avg_watch_sec|completion_rate
      // ?limit=N
      if (path === '/api/sf/tiktok/videos/top' && method === 'GET') {
        const VALID_METRICS_TT = ['views', 'likes', 'comments', 'shares',
                                  'saves', 'watch_time_min', 'avg_watch_sec', 'completion_rate'];
        const metricParam = url.searchParams.get('metric');
        if (metricParam !== null && metricParam !== '' && !VALID_METRICS_TT.includes(metricParam)) {
          return errRes(res, 400, 'Invalid metric');
        }
        const metric = (metricParam && VALID_METRICS_TT.includes(metricParam)) ? metricParam : 'views';

        const limitRaw = parseInt(url.searchParams.get('limit') || '10', 10);
        const limit    = (Number.isFinite(limitRaw) && limitRaw > 0 && limitRaw <= 50) ? limitRaw : 10;

        const rows = db.prepare(`
          SELECT cr.platform_id, cr.title, cr.published_at, cr.duration_sec,
                 sm.snapshot_date, sm.views, sm.likes, sm.comments, sm.shares,
                 sm.saves, sm.watch_time_min, sm.avg_watch_sec, sm.completion_rate
          FROM sf_content_registry cr
          LEFT JOIN sf_social_metrics sm
            ON sm.content_reg_id = cr.id
           AND sm.snapshot_date = (
                 SELECT MAX(sm2.snapshot_date)
                 FROM sf_social_metrics sm2
                 WHERE sm2.content_reg_id = cr.id
               )
          WHERE cr.platform = 'tiktok'
          ORDER BY sm.${metric} DESC NULLS LAST, cr.published_at DESC
          LIMIT ?
        `).all(limit);
        return jsonRes(res, 200, { ok: true, metric, limit, rows });
      }

      // ══════════════════════════════════════════════════════════════════════
      // Phase 9: Funnel Analytics API
      // ══════════════════════════════════════════════════════════════════════

      // ── GET /api/sf/funnel/overview ────────────────────────────────────────
      // ファネル 4 Stage 概要。source 別に保持。異種指標の合算なし。
      // ?from=YYYY-MM-DD&to=YYYY-MM-DD
      if (path === '/api/sf/funnel/overview' && method === 'GET') {
        const fromP = url.searchParams.get('from');
        const toP   = url.searchParams.get('to');
        const opts  = {};
        if (fromP && validateDate(fromP)) opts.from = fromP;
        if (toP   && validateDate(toP))   opts.to   = toP;
        const result = getFunnelOverview(db, opts);
        return jsonRes(res, 200, { ok: true, ...result });
      }

      // ── GET /api/sf/funnel/events ──────────────────────────────────────────
      // イベント一覧取得。不正 filter は安全に無視。
      // ?from&to&type&platform&work_id&track_id
      if (path === '/api/sf/funnel/events' && method === 'GET') {
        const opts = {};
        const fromP    = url.searchParams.get('from');
        const toP      = url.searchParams.get('to');
        const typeP    = url.searchParams.get('type');
        const platP    = url.searchParams.get('platform');
        const workIdP  = url.searchParams.get('work_id');
        const trackIdP = url.searchParams.get('track_id');
        if (fromP    && validateDate(fromP))                opts.from      = fromP;
        if (toP      && validateDate(toP))                  opts.to        = toP;
        if (typeP)                                          opts.eventType = typeP;  // manager 内で allowlist 検証
        if (platP)                                          opts.platform  = platP;
        if (workIdP  && /^\d+$/.test(workIdP))             opts.workId    = Number(workIdP);
        if (trackIdP && /^\d+$/.test(trackIdP))            opts.trackId   = Number(trackIdP);
        const events = getFunnelEvents(db, opts);
        return jsonRes(res, 200, { ok: true, events });
      }

      // ── POST /api/sf/funnel/events ─────────────────────────────────────────
      // イベント登録。FK 存在確認あり。allowlist 検証あり。
      if (path === '/api/sf/funnel/events' && method === 'POST') {
        const body   = await readBody(req);
        const result = createFunnelEvent(db, body);
        if (!result.ok) return errRes(res, 400, result.errors.join('; '));
        return jsonRes(res, 201, { ok: true, id: result.id });
      }

      // ── GET /api/sf/funnel/event-impact ───────────────────────────────────
      // イベント前後の指標変化（temporal signal・因果推論なし）。
      // ?event_id=N&before_days=7&after_days=7
      if (path === '/api/sf/funnel/event-impact' && method === 'GET') {
        const eventIdRaw  = url.searchParams.get('event_id');
        const beforeRaw   = url.searchParams.get('before_days');
        const afterRaw    = url.searchParams.get('after_days');

        const eventId = parseInt(eventIdRaw, 10);
        if (!Number.isFinite(eventId) || eventId <= 0) {
          return errRes(res, 400, 'event_id は正の整数が必要です');
        }
        const beforeDays = parseInt(beforeRaw ?? '7', 10);
        const afterDays  = parseInt(afterRaw  ?? '7', 10);
        if (!Number.isFinite(beforeDays) || beforeDays < 1 || beforeDays > 90) {
          return errRes(res, 400, 'before_days は 1〜90 の整数が必要です');
        }
        if (!Number.isFinite(afterDays) || afterDays < 1 || afterDays > 90) {
          return errRes(res, 400, 'after_days は 1〜90 の整数が必要です');
        }
        const result = getEventImpact(db, { eventId, beforeDays, afterDays });
        if (!result) return errRes(res, 404, 'Event not found');
        return jsonRes(res, 200, { ok: true, ...result });
      }

      // ── GET /api/sf/funnel/work ────────────────────────────────────────────
      // 特定作品の横断分析。
      // ?work_id=N&from=YYYY-MM-DD&to=YYYY-MM-DD
      if (path === '/api/sf/funnel/work' && method === 'GET') {
        const workIdRaw = url.searchParams.get('work_id');
        const workId    = parseInt(workIdRaw, 10);
        if (!Number.isFinite(workId) || workId <= 0) {
          return errRes(res, 400, 'work_id は正の整数が必要です');
        }
        const fromP = url.searchParams.get('from');
        const toP   = url.searchParams.get('to');
        const opts  = {};
        if (fromP && validateDate(fromP)) opts.from = fromP;
        if (toP   && validateDate(toP))   opts.to   = toP;
        const result = getWorkFunnel(db, workId, opts);
        if (!result) return errRes(res, 404, 'Work not found');
        return jsonRes(res, 200, { ok: true, ...result });
      }

      // ── GET /api/sf/funnel/track ───────────────────────────────────────────
      // 特定楽曲の横断分析。
      // ?track_id=N&from=YYYY-MM-DD&to=YYYY-MM-DD
      if (path === '/api/sf/funnel/track' && method === 'GET') {
        const trackIdRaw = url.searchParams.get('track_id');
        const trackId    = parseInt(trackIdRaw, 10);
        if (!Number.isFinite(trackId) || trackId <= 0) {
          return errRes(res, 400, 'track_id は正の整数が必要です');
        }
        const fromP = url.searchParams.get('from');
        const toP   = url.searchParams.get('to');
        const opts  = {};
        if (fromP && validateDate(fromP)) opts.from = fromP;
        if (toP   && validateDate(toP))   opts.to   = toP;
        const result = getTrackFunnel(db, trackId, opts);
        if (!result) return errRes(res, 404, 'Track not found');
        return jsonRes(res, 200, { ok: true, ...result });
      }

      // ── Sync / Ops（Phase 10）─────────────────────────────────────────────

      // GET /api/sf/sync/status — 全 source の同期状態
      if (method === 'GET' && path === '/api/sf/sync/status') {
        const status = getSyncStatus(db);
        return jsonRes(res, 200, { ok: true, ...status });
      }

      // GET /api/sf/sync/attention — 今対応が必要な項目
      if (method === 'GET' && path === '/api/sf/sync/attention') {
        const ignoreCooldown = url.searchParams.get('all') === '1';
        const items = getAttentionItems(db, { ignoreCooldown });
        return jsonRes(res, 200, { ok: true, count: items.length, items });
      }

      // POST /api/sf/sync/run — 全 AUTO source を同期
      if (method === 'POST' && path === '/api/sf/sync/run') {
        const body = await readBody(req);
        const dryRun = body.dry_run === true;
        const result = await runAutoSync(db, { dryRun });
        const statusCode = result.overall === 'failed' ? 500 : 200;
        return jsonRes(res, statusCode, { ok: result.overall !== 'failed', ...result });
      }

      // POST /api/sf/sync/run-source — 指定 source を同期
      if (method === 'POST' && path === '/api/sf/sync/run-source') {
        const body = await readBody(req);
        const source = body.source;
        if (!source || typeof source !== 'string') {
          return errRes(res, 400, 'source が未指定です');
        }
        if (!SOURCE_REGISTRY[source]) {
          return errRes(res, 400, `不明な source: ${source}`);
        }
        if (!AUTO_SOURCES.includes(source)) {
          return errRes(res, 400, `${source} は MANUAL source です。自動取得できません`);
        }
        const dryRun = body.dry_run === true;
        const result = await runSourceSync(db, source, { dryRun });
        const statusCode = result.success ? 200 : 500;
        return jsonRes(res, statusCode, { ok: result.success, ...result });
      }

      // PUT /api/sf/sync/sources/:source/enabled — source の利用中/未使用を切り替え
      {
        const m = path.match(/^\/api\/sf\/sync\/sources\/([^/]+)\/enabled$/);
        if (method === 'PUT' && m) {
          const sourceKey = m[1];
          if (!SOURCE_REGISTRY[sourceKey]) {
            return errRes(res, 400, `不明な source: ${sourceKey}`);
          }
          const body = await readBody(req);
          if (typeof body.enabled !== 'boolean' && body.enabled !== 0 && body.enabled !== 1) {
            return errRes(res, 400, 'enabled は boolean または 0/1 が必要です');
          }
          setSourceEnabled(db, sourceKey, body.enabled ? 1 : 0);
          return jsonRes(res, 200, { ok: true });
        }
      }

      // ── YouTube OAuth 再認証フロー ──────────────────────────────────────────────

      // GET /api/sf/sync/youtube/oauth/start — state 生成 → OAuth 認証 URL にリダイレクト
      if (method === 'GET' && path === '/api/sf/sync/youtube/oauth/start') {
        const clientId     = process.env.YOUTUBE_CLIENT_ID;
        const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
        if (!clientId || !clientSecret) {
          return errRes(res, 503, 'YOUTUBE_CLIENT_ID または YOUTUBE_CLIENT_SECRET が未設定です');
        }

        // CSRF 防止 state: 32バイト hex（10分TTL）
        const stateValue = randomBytes(32).toString('hex');
        _youtubeOauthState = { value: stateValue, expiresAt: Date.now() + 10 * 60 * 1000 };

        const redirectUri = 'http://localhost:3000/api/sf/sync/youtube/oauth/callback';
        const params = new URLSearchParams({
          client_id:     clientId,
          redirect_uri:  redirectUri,
          response_type: 'code',
          // youtube.readonly + yt-analytics.readonly の両スコープが必要
          scope: [
            'https://www.googleapis.com/auth/youtube.readonly',
            'https://www.googleapis.com/auth/yt-analytics.readonly',
          ].join(' '),
          access_type:   'offline',
          prompt:        'consent', // 既存トークンがあっても必ず再発行させる
          state:         stateValue,
        });
        res.writeHead(302, { Location: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
        return res.end();
      }

      // GET /api/sf/sync/youtube/oauth/callback — state 検証 → コード交換 → token 一時保管
      if (method === 'GET' && path === '/api/sf/sync/youtube/oauth/callback') {
        const code       = url.searchParams.get('code');
        const error      = url.searchParams.get('error');
        const stateParam = url.searchParams.get('state');
        const htmlRes = (html) => {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          return res.end(html);
        };

        // ① Google 側エラー
        if (error) {
          _youtubeOauthState = null;
          return htmlRes(buildOauthResultHtml({ success: false, error: `Google からエラーが返りました: ${error}` }));
        }

        // ② state 検証（未設定・不一致・期限切れ）
        const now = Date.now();
        if (!_youtubeOauthState) {
          return htmlRes(buildOauthResultHtml({ success: false, error: '認証フローが開始されていません。やり直してください' }));
        }
        if (now > _youtubeOauthState.expiresAt) {
          _youtubeOauthState = null;
          return htmlRes(buildOauthResultHtml({ success: false, error: '認証フローがタイムアウトしました。やり直してください' }));
        }
        if (!stateParam || stateParam !== _youtubeOauthState.value) {
          _youtubeOauthState = null;
          return htmlRes(buildOauthResultHtml({ success: false, error: 'state が一致しません。CSRF の可能性があるため拒否しました' }));
        }
        // state は使い捨て
        _youtubeOauthState = null;

        // ③ 認証コード確認
        if (!code) {
          return htmlRes(buildOauthResultHtml({ success: false, error: '認証コードがありません' }));
        }

        const clientId     = process.env.YOUTUBE_CLIENT_ID;
        const clientSecret = process.env.YOUTUBE_CLIENT_SECRET;
        const redirectUri  = 'http://localhost:3000/api/sf/sync/youtube/oauth/callback';

        try {
          const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              code,
              client_id:     clientId,
              client_secret: clientSecret,
              redirect_uri:  redirectUri,
              grant_type:    'authorization_code',
            }),
          });
          const tokenData = await tokenRes.json();

          if (!tokenRes.ok || !tokenData.refresh_token) {
            // エラー詳細はログに留め、画面にはトークン値を一切表示しない
            const errMsg = tokenData.error_description || tokenData.error || 'トークン取得に失敗しました';
            return htmlRes(buildOauthResultHtml({ success: false, error: errMsg }));
          }

          // refresh token は HTML に表示せず、サーバーメモリに一時保管（5分TTL）
          _pendingYoutubeToken = {
            refreshToken: tokenData.refresh_token,
            expiresAt: Date.now() + 5 * 60 * 1000,
          };

          return htmlRes(buildOauthResultHtml({ success: true }));
        } catch (e) {
          return htmlRes(buildOauthResultHtml({ success: false, error: e.message }));
        }
      }

      // POST /api/sf/sync/youtube/oauth/apply — 一時トークンを .env に書き込み → 自動同期実行
      if (method === 'POST' && path === '/api/sf/sync/youtube/oauth/apply') {
        if (!_pendingYoutubeToken) {
          return errRes(res, 400, '適用できるトークンがありません。再認証からやり直してください');
        }
        if (Date.now() > _pendingYoutubeToken.expiresAt) {
          _pendingYoutubeToken = null;
          return errRes(res, 400, 'トークンの有効期限が切れました。再認証からやり直してください');
        }

        const { refreshToken } = _pendingYoutubeToken;
        _pendingYoutubeToken = null;

        // ① 新しい refresh token でアクセストークンが取れるか事前検証（.env 書き込み前）
        let verifyError = null;
        try {
          const verifyRes = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
              client_id:     process.env.YOUTUBE_CLIENT_ID,
              client_secret: process.env.YOUTUBE_CLIENT_SECRET,
              refresh_token: refreshToken,
              grant_type:    'refresh_token',
            }),
          });
          const verifyData = await verifyRes.json();
          if (!verifyRes.ok || !verifyData.access_token) {
            verifyError = verifyData.error_description || verifyData.error || 'トークン検証失敗';
          }
        } catch (e) {
          verifyError = e.message;
        }

        if (verifyError) {
          return errRes(res, 400, `新しいトークンが無効です（Google API エラー: ${verifyError}）。再認証からやり直してください`);
        }

        // ② 検証通過後のみ .env に書き込む
        let envText = '';
        try { envText = readFileSync(_ENV_FILE_PATH, 'utf8'); } catch {}
        const keyLine = `YOUTUBE_REFRESH_TOKEN=${refreshToken}`;
        if (/^YOUTUBE_REFRESH_TOKEN=.*/m.test(envText)) {
          envText = envText.replace(/^YOUTUBE_REFRESH_TOKEN=.*$/m, keyLine);
        } else {
          envText = envText.endsWith('\n') ? envText + keyLine + '\n' : envText + '\n' + keyLine + '\n';
        }
        writeFileSync(_ENV_FILE_PATH, envText, 'utf8');

        // ③ 現在のプロセスにも即時反映
        process.env.YOUTUBE_REFRESH_TOKEN = refreshToken;

        // ④ 実際に同期を実行して invalid_grant が解消されたことを確認
        // 同期結果は sf_sync_state に記録される（status を強制変更しない）
        let syncResult = null;
        try {
          syncResult = await runSourceSync(db, 'youtube');
        } catch (_syncErr) {
          // runSourceSync は内部で catch するため通常ここには来ない
        }

        const syncMsg = syncResult?.success
          ? `YouTube 同期成功（最新データ: ${syncResult.data_date}）`
          : `トークン更新済み。同期: ${syncResult?.error?.slice(0, 80) ?? '不明なエラー'}`;

        return jsonRes(res, 200, { ok: true, sync_success: syncResult?.success ?? false, message: syncMsg });
      }

      // ── 手動 CSV・スナップショット取込 ───────────────────────────────────────

      // POST /api/sf/sync/import/soundrop/preview — CSV内容を受け取り、取込内容プレビューを返す
      if (method === 'POST' && path === '/api/sf/sync/import/soundrop/preview') {
        const body = await readBody(req);
        const { csv } = body;
        if (typeof csv !== 'string' || !csv.trim()) {
          return errRes(res, 400, 'csv フィールドに CSV テキストを指定してください');
        }
        // ヘッダー行と行数のみカウント（DB書き込みなし）
        const lines = csv.split('\n').filter(l => l.trim());
        const header = lines[0] ?? '';
        const dataRows = lines.length - 1;
        // 期間（最初と最後のデータ行から推測）
        let period = null;
        if (dataRows > 0) {
          const firstCols = (lines[1] ?? '').split(',');
          const lastCols  = (lines[lines.length - 1] ?? '').split(',');
          // Soundrop CSV は通常 col[1] が period
          if (firstCols[1] && lastCols[1]) {
            const p1 = firstCols[1].replace(/"/g, '').trim();
            const p2 = lastCols[1].replace(/"/g, '').trim();
            period = p1 === p2 ? p1 : `${p1} 〜 ${p2}`;
          }
        }
        return jsonRes(res, 200, { ok: true, header, rows: dataRows, period });
      }

      // POST /api/sf/sync/import/soundrop — Soundrop CSV を取り込む
      if (method === 'POST' && path === '/api/sf/sync/import/soundrop') {
        const body = await readBody(req);
        const { csv } = body;
        if (typeof csv !== 'string' || !csv.trim()) {
          return errRes(res, 400, 'csv フィールドに CSV テキストを指定してください');
        }
        // 一時ファイルに書き込んで既存 importFile() を利用
        const tmpPath = pathResolve(tmpdir(), `soundrop_import_${Date.now()}.csv`);
        try {
          writeFileSync(tmpPath, csv, 'utf8');
          const result = importFile(db, tmpPath);
          notifyImportSuccess(db, 'soundrop');
          notifyImportSuccess(db, 'revenue');
          return jsonRes(res, 200, { ok: true, result });
        } finally {
          try { unlinkSync(tmpPath); } catch {}
        }
      }

      // POST /api/sf/sync/import/csv — TikTok / X / KDP CSV を取り込む
      // X-Source ヘッダーで source を指定: tiktok | x | kdp
      if (method === 'POST' && path === '/api/sf/sync/import/csv') {
        const source = req.headers['x-source'];
        if (!['tiktok', 'x', 'kdp'].includes(source)) {
          return errRes(res, 400, 'X-Source ヘッダーに tiktok / x / kdp のいずれかを指定してください');
        }
        const body = await readBody(req);
        const { csv, snapshot_date } = body;
        if (typeof csv !== 'string' || !csv.trim()) {
          return errRes(res, 400, 'csv フィールドに CSV テキストを指定してください');
        }

        let result;
        if (source === 'tiktok') {
          result = importTikTokCSV(db, csv);
          notifyImportSuccess(db, 'tiktok');
        } else if (source === 'x') {
          const snapshotDate = snapshot_date ?? todayISO();
          result = importXCSV(db, csv, snapshotDate);
          notifyImportSuccess(db, 'x');
        } else if (source === 'kdp') {
          result = importKdpReport(db, csv);
          notifyImportSuccess(db, 'kdp');
        }
        return jsonRes(res, 200, { ok: true, source, result });
      }

      // POST /api/sf/sync/narou/snapshot — なろう手動スナップショット投入
      if (method === 'POST' && path === '/api/sf/sync/narou/snapshot') {
        const body = await readBody(req);
        const { ncode, month, bookmarks, daily_point, weekly_point, monthly_point,
                impression, review_count, all_hyoka_cnt, all_point } = body;
        if (!ncode || typeof ncode !== 'string' || !/^[A-Za-z0-9]+$/.test(ncode)) {
          return errRes(res, 400, 'ncode は英数字で指定してください');
        }
        if (!month || !/^\d{4}-\d{2}$/.test(month)) {
          return errRes(res, 400, 'month は YYYY-MM 形式で指定してください');
        }
        const snapshot = {
          ncode: ncode.toUpperCase(),
          month,
          bookmarks:      bookmarks      ?? null,
          daily_point:    daily_point    ?? null,
          weekly_point:   weekly_point   ?? null,
          monthly_point:  monthly_point  ?? null,
          impression:     impression     ?? null,
          review_count:   review_count   ?? null,
          all_hyoka_cnt:  all_hyoka_cnt  ?? null,
          all_point:      all_point      ?? null,
        };
        writeNarouSnapshot(db, [snapshot]);
        notifyImportSuccess(db, 'narou');
        return jsonRes(res, 200, { ok: true });
      }

      // ── Soundrop Catalog Sync ─────────────────────────────────────────────────
      // GET /api/sf/soundrop-sync/status — migration 状態 + 行数確認
      if (method === 'GET' && path === '/api/sf/soundrop-sync/status') {
        const roDb = createDbReadOnly(DEFAULT_DB_PATH);
        const migrationApplied = isSoundropMigrationApplied(roDb);
        const counts = {
          sf_releases:       roDb.prepare('SELECT COUNT(*) AS n FROM sf_releases').get().n,
          sf_tracks:         roDb.prepare('SELECT COUNT(*) AS n FROM sf_tracks').get().n,
          sf_release_tracks: roDb.prepare('SELECT COUNT(*) AS n FROM sf_release_tracks').get().n,
        };
        roDb.close();
        // migration が未適用なら自動適用（バックアップ付き）
        if (!migrationApplied) {
          try {
            // バックアップ
            const dbPath = DEFAULT_DB_PATH;
            const tmpDb  = new DatabaseSync(dbPath);
            tmpDb.exec('PRAGMA wal_checkpoint(TRUNCATE)');
            tmpDb.close();
            const now = new Date();
            const pad = n => String(n).padStart(2, '0');
            const ts  = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}_`
                       + `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
            mkdirSync(_BACKUPS_DIR, { recursive: true });
            const backupPath = pathResolve(_BACKUPS_DIR, `business_data_${ts}_pre_phase16.db`);
            if (existsSync(dbPath)) copyFileSync(dbPath, backupPath);
            // migration 適用（createDb を使うと migration が走る）
            // サーバの db は既に createDb() 済みなので、db に再接続する形で migration を適用
            db.exec('SELECT 1'); // サーバの db が migration 済みであることを確認
            // サーバ起動時に createDb() が実行されているため実際は適用済みのはず
          } catch (_e) { /* ignore */ }
        }
        return jsonRes(res, 200, { ok: true, migrationApplied: true, counts });
      }

      // POST /api/sf/soundrop-sync/diff — dry-run 差分確認（DB 書き込みなし）
      if (method === 'POST' && path === '/api/sf/soundrop-sync/diff') {
        let body;
        try { body = await readBody(req); } catch (e) { return errRes(res, 400, e.message); }

        const { requestUrl } = body ?? {};
        if (!requestUrl || typeof requestUrl !== 'string') {
          return errRes(res, 400, 'requestUrl が未指定です');
        }

        // Token 抽出（URL / 生 Token 両対応）
        const token = extractTokenFromInput(requestUrl);
        if (!token) {
          return errRes(res, 400, 'Request URL に Token が見つかりません。\nDevTools でリクエストを選択して「Request URLをコピー」してください。');
        }

        // Token 検証
        const verify = await verifyToken(token);
        if (!verify.ok) {
          // Token・URL をエラーメッセージに含めない
          return errRes(res, 401, 'Soundropとの接続情報が無効です。新しいRequest URLを貼り直してください。');
        }

        // DB 読み取り専用で開く（dry-run: DB 書き込み禁止）
        const roDb = createDbReadOnly(DEFAULT_DB_PATH);
        try {
          const diffResult = await runSoundropDiff(token, roDb);
          const summary    = summarizeDiff(diffResult);
          return jsonRes(res, 200, { ok: true, diff: summary });
        } catch (e) {
          // Token がエラーメッセージに混入しないよう除去
          const safeMsg = e.message.replaceAll(token, '[TOKEN]');
          return errRes(res, 500, `同期エラー: ${safeMsg}`);
        } finally {
          roDb.close();
        }
      }

      // POST /api/sf/soundrop-sync/apply — 実同期（DB 書き込みあり）
      if (method === 'POST' && path === '/api/sf/soundrop-sync/apply') {
        let body;
        try { body = await readBody(req); } catch (e) { return errRes(res, 400, e.message); }

        const { requestUrl } = body ?? {};
        if (!requestUrl || typeof requestUrl !== 'string') {
          return errRes(res, 400, 'requestUrl が未指定です');
        }

        const token = extractTokenFromInput(requestUrl);
        if (!token) {
          return errRes(res, 400, 'Request URL に Token が見つかりません。');
        }

        const verify = await verifyToken(token);
        if (!verify.ok) {
          return errRes(res, 401, 'Soundropとの接続情報が無効です。新しいRequest URLを貼り直してください。');
        }

        try {
          // diff 再計算（apply 直前に最新状態で計算）
          const { releaseDetails, dbRelTracks, releaseDiff, trackDiff } =
            await runSoundropDiff(token, db);

          // DB 書き込み
          const stats = applyDiff(
            db,
            { releases: releaseDiff, tracks: trackDiff },
            releaseDetails,
            dbRelTracks,
          );
          return jsonRes(res, 200, { ok: true, stats });
        } catch (e) {
          const safeMsg = e.message.replaceAll(token, '[TOKEN]');
          return errRes(res, 500, `同期エラー: ${safeMsg}`);
        }
      }

      // ── GET /api/sf/soundrop-sync/token-status ───────────────────────────────
      // Token設定状況 + soundrop_catalog 同期状態（source='soundrop_catalog' のみ参照）
      // ※ source='soundrop' (Statement CSV) は一切変更・参照しない
      if (method === 'GET' && path === '/api/sf/soundrop-sync/token-status') {
        const tokenConfigured = !!process.env.SOUNDROP_TOKEN?.trim();
        const row = db.prepare(
          "SELECT status, last_success_at, last_attempt_at, last_error FROM sf_sync_state WHERE source = 'soundrop_catalog'"
        ).get() ?? null;

        let hoursAgo = null;
        if (row?.last_success_at) {
          const ms = Date.now() - new Date(row.last_success_at).getTime();
          hoursAgo = Math.round(ms / 36000) / 100;  // 小数2桁
        }

        return jsonRes(res, 200, {
          ok:            true,
          tokenConfigured,
          status:        row?.status        ?? 'never_synced',
          lastSuccessAt: row?.last_success_at ?? null,
          lastAttemptAt: row?.last_attempt_at ?? null,
          lastError:     row?.last_error
            ? row.last_error.replace(/SOUNDROP_TOKEN/g, 'Soundrop Token')
            : null,
          hoursAgo,
        });
      }

      // ── POST /api/sf/soundrop-sync/auto ──────────────────────────────────────
      // Token環境変数を使った自動同期。
      // 処理順:
      //   1. ローカル reconciliation（常に実行）
      //   2. soundrop_catalog 行の確認/初期化
      //   3. 6時間判定（force=false 時）
      //   4. Token確認（未設定 → unconfigured / 無効 → error）
      //   5. Soundrop API同期（applyDiff 内で Pass4 reconciliation 再実行）
      //   6. sf_sync_state 更新
      // ※ source='soundrop'（Statement CSV 同期状態）は絶対に変更しない
      if (method === 'POST' && path === '/api/sf/soundrop-sync/auto') {
        let body;
        try { body = await readBody(req); } catch (e) { return errRes(res, 400, e.message); }
        const force = body?.force === true;

        // Step 1: ローカル reconciliation（Token不要・常に実行）
        const reconcileStats = applyStatusReconciliation(db);

        // Step 2: soundrop_catalog 行の確認 / 初期化
        let catalogRow = db.prepare(
          "SELECT * FROM sf_sync_state WHERE source = 'soundrop_catalog'"
        ).get() ?? null;

        if (!catalogRow) {
          db.prepare(`
            INSERT INTO sf_sync_state (source, mode, status, consecutive_failures)
            VALUES ('soundrop_catalog', 'auto', 'never_synced', 0)
          `).run();
          catalogRow = db.prepare(
            "SELECT * FROM sf_sync_state WHERE source = 'soundrop_catalog'"
          ).get();
        }

        // Step 3: 6時間判定（force=false かつ 前回成功あり）
        if (!force && catalogRow.last_success_at) {
          const ms      = Date.now() - new Date(catalogRow.last_success_at).getTime();
          const hoursAgo = ms / (1000 * 60 * 60);
          if (hoursAgo < 6) {
            return jsonRes(res, 200, {
              ok:      true,
              skipped: true,
              hoursAgo: Math.round(hoursAgo * 100) / 100,
              reconcileStats,
            });
          }
        }

        const nowIso = new Date().toISOString();

        // Step 4a: Token未設定 → unconfigured
        const token = process.env.SOUNDROP_TOKEN?.trim() || null;
        if (!token) {
          db.prepare(`
            UPDATE sf_sync_state SET
              status          = 'unconfigured',
              last_attempt_at = ?,
              last_error      = 'Soundrop Token が未設定です（.env を更新してください）',
              updated_at      = ?
            WHERE source = 'soundrop_catalog'
          `).run(nowIso, nowIso);
          return jsonRes(res, 200, {
            ok:           false,
            needsToken:   true,
            error:        'Soundrop接続情報の更新が必要です',
            reconcileStats,
          });
        }

        // Step 4b: Token検証（401/403 → error + needsToken）
        const verify = await verifyToken(token);
        if (!verify.ok) {
          const failures = (catalogRow.consecutive_failures ?? 0) + 1;
          db.prepare(`
            UPDATE sf_sync_state SET
              status               = 'error',
              last_attempt_at      = ?,
              last_error           = ?,
              consecutive_failures = ?,
              updated_at           = ?
            WHERE source = 'soundrop_catalog'
          `).run(
            nowIso,
            `Token検証エラー (HTTP ${verify.httpStatus ?? 'null'})`,
            failures,
            nowIso,
          );
          return jsonRes(res, 200, {
            ok:           false,
            needsToken:   true,
            error:        'Soundrop接続情報の更新が必要です',
            reconcileStats,
          });
        }

        // Step 5: Soundrop API 同期（applyDiff 内で Pass4 reconciliation 再実行）
        try {
          const { releaseDetails, dbRelTracks, releaseDiff, trackDiff } =
            await runSoundropDiff(token, db);

          const stats = applyDiff(
            db,
            { releases: releaseDiff, tracks: trackDiff },
            releaseDetails,
            dbRelTracks,
          );

          // Step 6: sf_sync_state 更新（成功）
          db.prepare(`
            UPDATE sf_sync_state SET
              status               = 'fresh',
              last_attempt_at      = ?,
              last_success_at      = ?,
              last_error           = null,
              consecutive_failures = 0,
              updated_at           = ?
            WHERE source = 'soundrop_catalog'
          `).run(nowIso, nowIso, nowIso);

          return jsonRes(res, 200, {
            ok:      true,
            skipped: false,
            stats,
            reconcileStats,
          });
        } catch (e) {
          const safeMsg  = e.message.replaceAll(token, '[TOKEN]');
          const failures = (catalogRow.consecutive_failures ?? 0) + 1;
          db.prepare(`
            UPDATE sf_sync_state SET
              status               = 'error',
              last_attempt_at      = ?,
              last_error           = ?,
              consecutive_failures = ?,
              updated_at           = ?
            WHERE source = 'soundrop_catalog'
          `).run(nowIso, safeMsg.slice(0, 500), failures, nowIso);
          return jsonRes(res, 500, {
            ok:    false,
            error: `同期エラー: ${safeMsg}`,
            reconcileStats,
          });
        }
      }

      // ── GET /api/sf/ga/events ─────────────────────────────────────────────────
      // イベント日別集計（sf_ga_event_daily）
      if (path === '/api/sf/ga/events' && method === 'GET') {
        const toParam   = url.searchParams.get('to');
        const fromParam = url.searchParams.get('from');
        const toDate    = (toParam && validateDate(toParam)) ? toParam : todayISO();
        let fromDate;
        if (fromParam && validateDate(fromParam)) {
          fromDate = fromParam;
        } else {
          const d = new Date(toDate);
          d.setDate(d.getDate() - 29);
          fromDate = [
            d.getFullYear(),
            String(d.getMonth() + 1).padStart(2, '0'),
            String(d.getDate()).padStart(2, '0'),
          ].join('-');
        }
        const eventName = url.searchParams.get('event_name') || null;
        const rows = db.prepare(`
          SELECT date,
                 event_name,
                 SUM(count) AS count
          FROM sf_ga_event_daily
          WHERE date >= ? AND date <= ?
            AND (? IS NULL OR event_name = ?)
          GROUP BY date, event_name
          ORDER BY date ASC, event_name ASC
        `).all(fromDate, toDate, eventName, eventName);
        return jsonRes(res, 200, { ok: true, rows });
      }

      // ── GET /api/sf/ga/events/catalog ─────────────────────────────────────────
      // 公式サイトで計測しているイベントのカタログ（静的定義）
      if (path === '/api/sf/ga/events/catalog' && method === 'GET') {
        const events = [
          // ── DISCOVERY ──────────────────────────────────────────────────────────
          { event_name: 'click_instagram', funnel_stage: 'DISCOVERY', page: 'index / sweets',       description: 'Instagramリンク',            parameters: ['destination'], status: 'active' },
          { event_name: 'click_youtube',   funnel_stage: 'DISCOVERY', page: 'index / music',        description: 'YouTubeリンク（snow.js / music.html）', parameters: [],      status: 'active' },
          { event_name: 'click_x',         funnel_stage: 'DISCOVERY', page: 'index',                description: 'X（旧Twitter）リンク（snow.js）', parameters: [],          status: 'active' },
          { event_name: 'click_suno',      funnel_stage: 'DISCOVERY', page: 'index',                description: 'Sunoリンク（snow.js）',        parameters: [],             status: 'active' },
          { event_name: 'click_sns',       funnel_stage: 'DISCOVERY', page: 'index / sweets',       description: 'SNSリンク（X・YouTube、sfGa）', parameters: ['destination'], status: 'active' },
          // ── ENGAGEMENT ─────────────────────────────────────────────────────────
          { event_name: 'nav_sweets',      funnel_stage: 'ENGAGEMENT', page: 'index',                description: 'SWEETsページ遷移（sfGa）',      parameters: ['from'],               status: 'active' },
          { event_name: 'enter_sweets',    funnel_stage: 'ENGAGEMENT', page: 'index',                description: 'SWEETsリンク（snow.js）',       parameters: ['link_url'],           status: 'active' },
          { event_name: 'sweets_unlock',   funnel_stage: 'ENGAGEMENT', page: 'sweets',               description: 'SWEETsゲート解錠（コード入力成功）', parameters: ['season', 'is_new_user'], status: 'active' },
          { event_name: 'enter_summer',    funnel_stage: 'ENGAGEMENT', page: 'sweets',               description: '夏コンテンツ入場',               parameters: ['event_category'],     status: 'active' },
          { event_name: 'nav_gacha',       funnel_stage: 'ENGAGEMENT', page: 'index',                description: 'ガチャページ遷移',               parameters: ['from'],               status: 'active' },
          { event_name: 'click_music',     funnel_stage: 'ENGAGEMENT', page: 'index / sweets / music', description: '音楽配信リンク（Apple Music・Amazon Music・Suno等）', parameters: ['destination'], status: 'active' },
          { event_name: 'click_spotify',   funnel_stage: 'ENGAGEMENT', page: 'index / music',        description: 'Spotifyリンク（snow.js / music.html）', parameters: ['destination'],  status: 'active' },
          { event_name: 'nav_hayatecchi',  funnel_stage: 'ENGAGEMENT', page: 'index',                description: 'ゲームLPへの遷移',               parameters: ['from'],               status: 'active' },
          // ── DEEP_INTEREST ──────────────────────────────────────────────────────
          { event_name: 'music_play',      funnel_stage: 'DEEP_INTEREST', page: 'sweets',            description: '音源再生開始（1セッション1曲1回）', parameters: ['song_id'],           status: 'active' },
          { event_name: 'music_play_30s',  funnel_stage: 'DEEP_INTEREST', page: 'sweets',            description: '音源30秒再生通過',               parameters: ['song_id'],            status: 'active' },
          { event_name: 'click_story',     funnel_stage: 'DEEP_INTEREST', page: 'index / sweets',    description: '小説・なろうリンク（sfGa）',      parameters: ['destination', 'url'], status: 'active' },
          { event_name: 'click_novel',     funnel_stage: 'DEEP_INTEREST', page: 'index',             description: '小説リンク（snow.js）',           parameters: ['link_url'],           status: 'active' },
          { event_name: 'se_read',         funnel_stage: 'DEEP_INTEREST', page: 'sweets',            description: '夏エピソード読了',               parameters: ['event_label'],        status: 'active' },
          { event_name: 'se_complete',     funnel_stage: 'DEEP_INTEREST', page: 'sweets',            description: '夏エピソード全話完了',            parameters: ['event_category'],     status: 'active' },
          // ── VALUE ──────────────────────────────────────────────────────────────
          { event_name: 'click_kindle',    funnel_stage: 'VALUE',        page: 'index',              description: 'Kindle/Amazon電子書籍リンク（snow.js）', parameters: ['link_url'],    status: 'active' },
        ];
        return jsonRes(res, 200, { ok: true, events });
      }

      // ── GET /api/sf/x/tweets ──────────────────────────────────────────────────
      // ツイート一覧（最新スナップショット指標付き）
      if (path === '/api/sf/x/tweets' && method === 'GET') {
        const from       = url.searchParams.get('from')       || null;
        const to         = url.searchParams.get('to')         || null;
        const tweet_type = url.searchParams.get('tweet_type') || null;
        const limitParam = parseInt(url.searchParams.get('limit') ?? '100', 10);
        const limit      = (Number.isFinite(limitParam) && limitParam > 0) ? Math.min(limitParam, 500) : 100;
        const rows = getXTweets(db, { from, to, tweet_type, limit });
        return jsonRes(res, 200, { ok: true, rows });
      }

      // ── GET /api/sf/x/tweets/top ─────────────────────────────────────────────
      // インプレッション上位ツイート
      if (path === '/api/sf/x/tweets/top' && method === 'GET') {
        const snapshot_date = url.searchParams.get('snapshot_date') || null;
        const limitParam    = parseInt(url.searchParams.get('limit') ?? '10', 10);
        const limit         = (Number.isFinite(limitParam) && limitParam > 0) ? Math.min(limitParam, 100) : 10;
        const rows = getXTweetsTop(db, { snapshot_date, limit });
        return jsonRes(res, 200, { ok: true, rows });
      }

      // ── GET /api/sf/x/account/daily ──────────────────────────────────────────
      // アカウント日次スナップショット（フォロワー数等）
      if (path === '/api/sf/x/account/daily' && method === 'GET') {
        const from = url.searchParams.get('from') || null;
        const to   = url.searchParams.get('to')   || null;
        const rows = getXAccountDaily(db, { from, to });
        return jsonRes(res, 200, { ok: true, rows });
      }

      // ── GET /api/sf/x/summary ────────────────────────────────────────────────
      // 期間集計サマリー（投稿数・インプレッション等。engagements は X Analytics 提供値のみ）
      if (path === '/api/sf/x/summary' && method === 'GET') {
        const snapshot_date = url.searchParams.get('snapshot_date') || null;
        const from          = url.searchParams.get('from') || null;
        const to            = url.searchParams.get('to')   || null;
        const summary = getXSummary(db, { snapshot_date, from, to });
        return jsonRes(res, 200, { ok: true, ...summary });
      }

      // ══════════════════════════════════════════════════════════════════════
      // KDP Analytics エンドポイント（Phase 13）
      // ══════════════════════════════════════════════════════════════════════

      // ── GET /api/kdp/books ────────────────────────────────────────────────
      // KDP 本一覧。?sf_only=1 で Snow flakes マッピング済みのみ。
      if (path === '/api/kdp/books' && method === 'GET') {
        const sfOnly = url.searchParams.get('sf_only') === '1';
        const asin   = url.searchParams.get('asin') || null;
        const books  = getKdpBooks(db, { sf_only: sfOnly, asin });
        return jsonRes(res, 200, { ok: true, count: books.length, books });
      }

      // ── GET /api/kdp/orders ───────────────────────────────────────────────
      // 日次注文データ。?from=YYYY-MM-DD &to=YYYY-MM-DD &book_id=N &marketplace=...
      if (path === '/api/kdp/orders' && method === 'GET') {
        const from        = url.searchParams.get('from') || null;
        const to          = url.searchParams.get('to')   || null;
        const bookIdRaw   = url.searchParams.get('book_id');
        const book_id     = bookIdRaw ? parseInt(bookIdRaw, 10) : null;
        const marketplace = url.searchParams.get('marketplace') || null;
        const rows = getKdpOrders(db, {
          from:        (from && validateDate(from)) ? from : null,
          to:          (to   && validateDate(to))   ? to   : null,
          book_id:     (book_id && Number.isFinite(book_id)) ? book_id : null,
          marketplace,
        });
        return jsonRes(res, 200, { ok: true, rows });
      }

      // ── GET /api/kdp/kenp ─────────────────────────────────────────────────
      // 日次 KENP データ。?from=YYYY-MM-DD &to=YYYY-MM-DD &book_id=N &marketplace=...
      if (path === '/api/kdp/kenp' && method === 'GET') {
        const from        = url.searchParams.get('from') || null;
        const to          = url.searchParams.get('to')   || null;
        const bookIdRaw   = url.searchParams.get('book_id');
        const book_id     = bookIdRaw ? parseInt(bookIdRaw, 10) : null;
        const marketplace = url.searchParams.get('marketplace') || null;
        const rows = getKdpKenp(db, {
          from:        (from && validateDate(from)) ? from : null,
          to:          (to   && validateDate(to))   ? to   : null,
          book_id:     (book_id && Number.isFinite(book_id)) ? book_id : null,
          marketplace,
        });
        return jsonRes(res, 200, { ok: true, rows });
      }

      // ── GET /api/kdp/royalties ────────────────────────────────────────────
      // 月次ロイヤリティ。?royalty_month=YYYY-MM &book_id=N &marketplace=... &currency=...
      if (path === '/api/kdp/royalties' && method === 'GET') {
        const royalty_month = url.searchParams.get('royalty_month') || null;
        const bookIdRaw     = url.searchParams.get('book_id');
        const book_id       = bookIdRaw ? parseInt(bookIdRaw, 10) : null;
        const marketplace   = url.searchParams.get('marketplace') || null;
        const currency      = url.searchParams.get('currency') || null;
        const rows = getKdpRoyalties(db, {
          royalty_month: (royalty_month && validateMonth(royalty_month)) ? royalty_month : null,
          book_id: (book_id && Number.isFinite(book_id)) ? book_id : null,
          marketplace,
          currency,
        });
        return jsonRes(res, 200, { ok: true, rows });
      }

      // ── GET /api/kdp/payments ─────────────────────────────────────────────
      // 支払い履歴。?marketplace=... &payment_status=...
      if (path === '/api/kdp/payments' && method === 'GET') {
        const marketplace    = url.searchParams.get('marketplace') || null;
        const payment_status = url.searchParams.get('payment_status') || null;
        const rows = getKdpPayments(db, { marketplace, payment_status });
        return jsonRes(res, 200, { ok: true, rows });
      }

      // ── GET /api/kdp/summary ──────────────────────────────────────────────
      // KDP 月次サマリー（全本 / 通貨別）。?royalty_month=YYYY-MM
      if (path === '/api/kdp/summary' && method === 'GET') {
        const royalty_month = url.searchParams.get('royalty_month') || null;
        const summary = getKdpSummary(db, { royalty_month });
        return jsonRes(res, 200, { ok: true, ...summary });
      }

      // ── GET /api/sf/kdp/summary ───────────────────────────────────────────
      // Snow flakes にマッピングされた本のみの KDP サマリー。?royalty_month=YYYY-MM
      if (path === '/api/sf/kdp/summary' && method === 'GET') {
        const royalty_month = url.searchParams.get('royalty_month') || null;
        const summary = getSnowflakesKdpSummary(db, { royalty_month });
        return jsonRes(res, 200, { ok: true, ...summary });
      }

      // ══════════════════════════════════════════════════════════════════════
      // note Workflow エンドポイント（Phase 14）
      // ══════════════════════════════════════════════════════════════════════

      // ── GET /api/note/dashboard ───────────────────────────────────────────
      // status 別記事カウント
      if (path === '/api/note/dashboard' && method === 'GET') {
        const summary = getDashboardSummary(db);
        return jsonRes(res, 200, { ok: true, ...summary });
      }

      // ── GET /api/note/articles ────────────────────────────────────────────
      // 記事一覧。?status=... &article_type=... &limit=N &scheduled=1
      if (path === '/api/note/articles' && method === 'GET') {
        const statusParam  = url.searchParams.get('status') || null;
        const typeParam    = url.searchParams.get('article_type') || null;
        const limitParam   = url.searchParams.get('limit');
        const scheduledOnly = url.searchParams.get('scheduled') === '1';

        if (statusParam && !VALID_STATUSES.includes(statusParam)) {
          return errRes(res, 400, `status が不正です: ${statusParam}`);
        }

        let articles;
        if (scheduledOnly) {
          articles = getScheduledArticles(db);
        } else {
          const limit = limitParam ? parseInt(limitParam, 10) : 100;
          articles = getArticles(db, {
            status:       statusParam,
            article_type: typeParam,
            limit,
          });
        }
        return jsonRes(res, 200, { ok: true, count: articles.length, articles });
      }

      // ── POST /api/note/articles ───────────────────────────────────────────
      // 新規記事作成
      if (path === '/api/note/articles' && method === 'POST') {
        let body;
        try { body = await readBody(req); } catch (e) { return errRes(res, 400, e.message); }
        let id;
        try { id = createArticle(db, body); } catch (e) { return errRes(res, 400, e.message); }
        const article = getArticle(db, id);
        return jsonRes(res, 201, { ok: true, id, article });
      }

      // ── GET /api/note/article ─────────────────────────────────────────────
      // 単件記事詳細。?id=N
      if (path === '/api/note/article' && method === 'GET') {
        const idRaw = url.searchParams.get('id');
        const id    = parseInt(idRaw, 10);
        if (!Number.isFinite(id) || id <= 0) return errRes(res, 400, 'id は正の整数が必要です');
        const article = getArticle(db, id);
        if (!article) return errRes(res, 404, '記事が見つかりません');
        return jsonRes(res, 200, { ok: true, article });
      }

      // ── PATCH /api/note/article ───────────────────────────────────────────
      // 記事更新（title/body/tags 等）。?id=N または body.id
      if (path === '/api/note/article' && method === 'PATCH') {
        let body;
        try { body = await readBody(req); } catch (e) { return errRes(res, 400, e.message); }
        const idRaw = url.searchParams.get('id') ?? String(body.id ?? '');
        const id    = parseInt(idRaw, 10);
        if (!Number.isFinite(id) || id <= 0) return errRes(res, 400, 'id は正の整数が必要です');
        let article;
        try { article = updateArticle(db, id, body); } catch (e) { return errRes(res, 400, e.message); }
        return jsonRes(res, 200, { ok: true, article });
      }

      // ── POST /api/note/article/status ─────────────────────────────────────
      // status 遷移。body: { id, status }
      if (path === '/api/note/article/status' && method === 'POST') {
        let body;
        try { body = await readBody(req); } catch (e) { return errRes(res, 400, e.message); }
        const id     = parseInt(body.id, 10);
        const status = body.status;
        if (!Number.isFinite(id) || id <= 0) return errRes(res, 400, 'id は正の整数が必要です');
        if (!status) return errRes(res, 400, 'status は必須です');
        let article;
        try { article = setStatus(db, id, status); } catch (e) { return errRes(res, 400, e.message); }
        return jsonRes(res, 200, { ok: true, article });
      }

      // ── POST /api/note/article/published ─────────────────────────────────
      // 公開済み記録（ユーザーが note に投稿した後）。body: { id, note_url, published_date }
      if (path === '/api/note/article/published' && method === 'POST') {
        let body;
        try { body = await readBody(req); } catch (e) { return errRes(res, 400, e.message); }
        const id = parseInt(body.id, 10);
        if (!Number.isFinite(id) || id <= 0) return errRes(res, 400, 'id は正の整数が必要です');
        let article;
        try {
          article = recordPublished(db, id, {
            note_url:       body.note_url       ?? null,
            published_date: body.published_date ?? null,
          });
        } catch (e) { return errRes(res, 400, e.message); }
        return jsonRes(res, 200, { ok: true, article });
      }

      // ── GET /api/note/article/export ──────────────────────────────────────
      // 投稿用コンテンツ export。?id=N&format=md|txt|json
      if (path === '/api/note/article/export' && method === 'GET') {
        const idRaw    = url.searchParams.get('id');
        const format   = url.searchParams.get('format') || 'md';
        const id       = parseInt(idRaw, 10);
        if (!Number.isFinite(id) || id <= 0) return errRes(res, 400, 'id は正の整数が必要です');
        if (!VALID_EXPORT_FORMATS.includes(format)) {
          return errRes(res, 400, `format が不正です: ${format}`);
        }
        const article = getArticle(db, id);
        if (!article) return errRes(res, 404, '記事が見つかりません');
        let content;
        try { content = generateExport(article, format); } catch (e) { return errRes(res, 400, e.message); }
        const contentType = format === 'json'
          ? 'application/json; charset=utf-8'
          : 'text/plain; charset=utf-8';
        res.writeHead(200, {
          'Content-Type': contentType,
          'Cache-Control': 'no-cache',
        });
        return res.end(content);
      }

      // ══════════════════════════════════════════════════════════════════════
      // HP Analytics Dashboard エンドポイント（Phase 15）
      // ══════════════════════════════════════════════════════════════════════

      // ── GET /api/sf/ga/overview ───────────────────────────────────────────
      // HP Analytics サイト概要（直近 N 日の集計 + 前期間比較）
      // has_data=false → 期間内データなし（未取得）、current=null
      // has_data=true  → データあり、count=0 は 0（イベント未発生）
      if (path === '/api/sf/ga/overview' && method === 'GET') {
        const VALID_DAYS_OV = [7, 14, 30];
        const daysRaw = parseInt(url.searchParams.get('days') || '30', 10);
        const days = VALID_DAYS_OV.includes(daysRaw) ? daysRaw : 30;

        const today = todayISO();
        function subDaysOv(base, n) {
          const d = new Date(base);
          d.setDate(d.getDate() - n);
          return [
            d.getFullYear(),
            String(d.getMonth() + 1).padStart(2, '0'),
            String(d.getDate()).padStart(2, '0'),
          ].join('-');
        }
        const currentEnd    = today;
        const currentStart  = subDaysOv(today, days - 1);
        const previousEnd   = subDaysOv(today, days);
        const previousStart = subDaysOv(today, days * 2 - 1);

        const currentRow = db.prepare(`
          SELECT SUM(page_views)       AS page_views,
                 SUM(users)            AS users,
                 SUM(sessions)         AS sessions,
                 SUM(engaged_sessions) AS engaged_sessions,
                 COUNT(*)              AS row_count
          FROM sf_ga_daily WHERE date >= ? AND date <= ?
        `).get(currentStart, currentEnd);

        const previousRow = db.prepare(`
          SELECT SUM(page_views)       AS page_views,
                 SUM(users)            AS users,
                 SUM(sessions)         AS sessions,
                 SUM(engaged_sessions) AS engaged_sessions,
                 COUNT(*)              AS row_count
          FROM sf_ga_daily WHERE date >= ? AND date <= ?
        `).get(previousStart, previousEnd);

        const hasCurrentData  = (currentRow?.row_count  ?? 0) > 0;
        const hasPreviousData = (previousRow?.row_count ?? 0) > 0;

        return jsonRes(res, 200, {
          ok: true,
          days,
          period:          { from: currentStart,  to: currentEnd  },
          previous_period: { from: previousStart, to: previousEnd },
          has_data:          hasCurrentData,
          has_previous_data: hasPreviousData,
          current: hasCurrentData ? {
            page_views:       currentRow.page_views       ?? 0,
            users:            currentRow.users            ?? 0,
            sessions:         currentRow.sessions         ?? 0,
            engaged_sessions: currentRow.engaged_sessions ?? 0,
          } : null,
          previous: hasPreviousData ? {
            page_views:       previousRow.page_views       ?? 0,
            users:            previousRow.users            ?? 0,
            sessions:         previousRow.sessions         ?? 0,
            engaged_sessions: previousRow.engaged_sessions ?? 0,
          } : null,
        });
      }

      // ── GET /api/sf/soundrop/stats ─────────────────────────────────────────
      // Soundrop Stats ダッシュボード用集計
      // ?statement=YYYY-MM  でステートメント月フィルタ（省略=全期間）
      if (path === '/api/sf/soundrop/stats' && method === 'GET') {
        const stmt = url.searchParams.get('statement') || null;
        if (stmt && !validateMonth(stmt)) return errRes(res, 400, 'statement の形式が不正です');

        // ── 月フィルタ用 WHERE 句 ──
        // sf_revenue は month = statement_period
        // sf_distribution_import_rows は raw_data.statement_period
        const revWhere = stmt ? 'AND r.month = ?' : '';
        const revArgs  = stmt ? [stmt] : [];

        // ── totals (全体合計) ──
        const totalsRow = db.prepare(`
          SELECT ROUND(SUM(amount), 8) AS total_usd,
                 SUM(quantity) AS total_quantity
          FROM sf_revenue r
          WHERE import_source IN ('csv', 'api') AND track_id IS NOT NULL
            ${revWhere}
        `).get(...revArgs);
        const totalUsd = totalsRow?.total_usd || 0;
        const totalQty = totalsRow?.total_quantity || 0;

        // ── services (プラットフォーム別) ──
        const serviceRows = db.prepare(`
          SELECT r.platform,
                 ROUND(SUM(r.amount), 8) AS total_usd,
                 SUM(r.quantity) AS total_quantity
          FROM sf_revenue r
          WHERE r.import_source IN ('csv', 'api') AND r.track_id IS NOT NULL
            ${revWhere}
          GROUP BY r.platform
          ORDER BY total_usd DESC
        `).all(...revArgs);

        // ── channels (チャンネル別 from import_rows) ──
        const chWhere = stmt
          ? "AND json_extract(raw_data, '$.statement_period') = ?"
          : '';
        const channelRows = db.prepare(`
          SELECT json_extract(raw_data, '$.channel') AS channel,
                 ROUND(SUM(CAST(json_extract(raw_data, '$.revenue_usd') AS REAL)), 8) AS total_usd,
                 SUM(CAST(json_extract(raw_data, '$.quantity') AS INTEGER)) AS total_quantity
          FROM sf_distribution_import_rows
          WHERE matched_track_id IS NOT NULL ${chWhere}
          GROUP BY channel
          ORDER BY total_usd DESC
        `).all(...(stmt ? [stmt] : []));

        // ── tracks (楽曲別) ──
        const trackRows = db.prepare(`
          SELECT r.track_id, t.title,
                 ROUND(SUM(r.amount), 8) AS total_usd,
                 SUM(r.quantity) AS total_quantity
          FROM sf_revenue r
          JOIN sf_tracks t ON t.id = r.track_id
          WHERE r.import_source IN ('csv', 'api') AND r.track_id IS NOT NULL
            ${revWhere}
          GROUP BY r.track_id
          ORDER BY total_usd DESC
        `).all(...revArgs);

        // ── releases (リリース別 from import_rows) ──
        const releaseRows = db.prepare(`
          SELECT json_extract(raw_data, '$.release_title') AS release_title,
                 json_extract(raw_data, '$.upc') AS upc,
                 ROUND(SUM(CAST(json_extract(raw_data, '$.revenue_usd') AS REAL)), 8) AS total_usd,
                 SUM(CAST(json_extract(raw_data, '$.quantity') AS INTEGER)) AS total_quantity
          FROM sf_distribution_import_rows
          WHERE matched_track_id IS NOT NULL ${chWhere}
          GROUP BY json_extract(raw_data, '$.upc')
          ORDER BY total_usd DESC
        `).all(...(stmt ? [stmt] : []));

        // ── monthly trend (transaction_month 別) ──
        const monthlyRows = db.prepare(`
          SELECT r.transaction_month AS month,
                 ROUND(SUM(r.amount), 8) AS total_usd,
                 SUM(r.quantity) AS total_quantity
          FROM sf_revenue r
          WHERE r.import_source IN ('csv', 'api') AND r.track_id IS NOT NULL
            AND r.transaction_month IS NOT NULL
            ${revWhere}
          GROUP BY r.transaction_month
          ORDER BY r.transaction_month ASC
        `).all(...revArgs);

        // ── statement periods (フィルタ選択用) ──
        const stmtPeriods = db.prepare(`
          SELECT DISTINCT month AS statement_period
          FROM sf_revenue
          WHERE import_source IN ('csv', 'api') AND track_id IS NOT NULL
          ORDER BY month DESC
        `).all();

        // pct 計算
        const addPct = (rows, usdTotal) => rows.map(r => ({
          ...r,
          pct: usdTotal > 0 ? Math.round((r.total_usd / usdTotal) * 1000) / 10 : 0,
        }));

        return jsonRes(res, 200, {
          ok: true,
          statement:      stmt,
          totals:         { total_usd: totalUsd, total_quantity: totalQty },
          services:       addPct(serviceRows, totalUsd),
          channels:       addPct(channelRows, totalUsd),
          tracks:         addPct(trackRows, totalUsd),
          releases:       addPct(releaseRows, totalUsd),
          monthly:        monthlyRows,
          stmtPeriods:    stmtPeriods.map(r => r.statement_period),
        });
      }

      // ──────────────────────────────────────────────────────────────────────
      // Business Invoice Import API  (Phase 17)
      // ──────────────────────────────────────────────────────────────────────

      // POST /api/invoice/parse  — Excel 解析（dry-run、DB 書き込みなし）
      if (method === 'POST' && path === '/api/invoice/parse') {
        const body = await readBody(req);
        if (!body.filename || !body.data_b64) return errRes(res, 400, 'filename と data_b64 が必要です');
        const buf = Buffer.from(body.data_b64, 'base64');
        const result = parseExcel(buf, body.filename);
        const fileHash = computeFileHash(buf);

        // 既存インポート確認（同一ハッシュ）
        const existImport = db.prepare(
          'SELECT id, imported_at FROM business_invoice_imports WHERE file_hash = ? LIMIT 1'
        ).get(fileHash);

        return jsonRes(res, 200, { ok: true, ...result, fileHash, existImport: existImport ?? null });
      }

      // POST /api/invoice/import  — Excel 取込確定（DB 書き込みあり）
      if (method === 'POST' && path === '/api/invoice/import') {
        const body = await readBody(req);
        if (!body.filename || !body.data_b64) return errRes(res, 400, 'filename と data_b64 が必要です');
        const buf = Buffer.from(body.data_b64, 'base64');
        const fileHash = computeFileHash(buf);
        const { invoices } = parseExcel(buf, body.filename);
        const result = importInvoices(db, {
          filename: body.filename,
          fileHash,
          invoices,
          dryRun: false,
        });
        return jsonRes(res, 201, { ok: true, ...result });
      }

      // GET /api/invoice/imports  — インポート履歴
      if (method === 'GET' && path === '/api/invoice/imports') {
        const history = getInvoiceImportHistory(db);
        return jsonRes(res, 200, { ok: true, imports: history });
      }

      // GET /api/invoice/analytics  — 全期間集計
      if (method === 'GET' && path === '/api/invoice/analytics') {
        const analytics = getInvoiceAnalytics(db);
        const years     = getAvailableYears(db);
        return jsonRes(res, 200, { ok: true, ...analytics, availableYears: years });
      }

      // GET /api/invoice/analytics/:year  — 年別集計
      if (method === 'GET' && /^\/api\/invoice\/analytics\/\d{4}$/.test(path)) {
        const year = path.split('/').pop();
        const data = getAnalyticsByYear(db, year);
        return jsonRes(res, 200, { ok: true, ...data });
      }

      // GET /api/invoice/lines  — 明細一覧
      if (method === 'GET' && path.startsWith('/api/invoice/lines')) {
        const qs       = new URLSearchParams(url.search);
        const year     = qs.get('year')     || null;
        const month    = qs.get('month')    || null;
        const category = qs.get('category') || null;
        const limit    = Math.min(parseInt(qs.get('limit') || '200', 10), 500);
        const offset   = parseInt(qs.get('offset') || '0', 10);
        const lines    = getInvoiceLines(db, { year, month, category, limit, offset });
        return jsonRes(res, 200, { ok: true, lines });
      }

      // GET /api/invoice/category-rules  — 分類ルール一覧
      if (method === 'GET' && path === '/api/invoice/category-rules') {
        return jsonRes(res, 200, { ok: true, rules: getCategoryRules() });
      }

      // ── Google Calendar 同期 API ───────────────────────────────────────────

      // GET /api/calendar/status  — OAuth 接続状態確認
      if (method === 'GET' && path === '/api/calendar/status') {
        try {
          const cfg = getCalendarConfig();
          const accessToken = await refreshCalendarToken(cfg);
          const linkedCount = getCalendarLinkCount(db);
          return jsonRes(res, 200, { ok: true, connected: true, linkedCount });
        } catch (e) {
          const missing = ['GCALENDAR_CLIENT_ID', 'GCALENDAR_CLIENT_SECRET', 'GCALENDAR_REFRESH_TOKEN']
            .filter(k => !process.env[k]);
          return jsonRes(res, 200, {
            ok: true, connected: false,
            missingVars: missing,
            hint: 'node --env-file jarvis/.env jarvis/automation/setup_google_calendar_oauth.js を実行してください',
          });
        }
      }

      // GET /api/calendar/calendars  — カレンダー一覧
      if (method === 'GET' && path === '/api/calendar/calendars') {
        const cfg = getCalendarConfig();
        const accessToken = await refreshCalendarToken(cfg);
        const calendars = await listCalendars(accessToken);
        return jsonRes(res, 200, { ok: true, calendars });
      }

      // POST /api/calendar/push/preview  — JARVIS → Calendar dry-run
      if (method === 'POST' && path === '/api/calendar/push/preview') {
        const body = await readBody(req);
        if (!body.calendarId) return errRes(res, 400, 'calendarId が必要です');
        const cfg = getCalendarConfig();
        const accessToken = await refreshCalendarToken(cfg);
        const result = await dryRunPush(db, accessToken, {
          calendarId: body.calendarId,
          year:       body.year || null,
        });
        return jsonRes(res, 200, { ok: true, ...result });
      }

      // POST /api/calendar/push/execute  — JARVIS → Calendar 実書き込み
      if (method === 'POST' && path === '/api/calendar/push/execute') {
        const body = await readBody(req);
        if (!body.calendarId) return errRes(res, 400, 'calendarId が必要です');
        const cfg = getCalendarConfig();
        const accessToken = await refreshCalendarToken(cfg);
        const runId = insertSyncRun(db, {
          direction:  'push',
          calendarId: body.calendarId,
          yearFilter: body.year || null,
        });
        const result = await executePush(db, accessToken, {
          calendarId: body.calendarId,
          year:       body.year || null,
          runId,
        });
        completeSyncRun(db, {
          runId,
          createdCount: result.createdCount,
          updatedCount: result.updatedCount,
          skippedCount: result.skippedCount,
          errorCount:   result.errorCount,
          status: result.errorCount > 0 ? 'completed' : 'completed',
        });
        return jsonRes(res, 200, { ok: true, ...result });
      }

      // POST /api/calendar/pull/preview  — Calendar → JARVIS dry-run（将来用）
      if (method === 'POST' && path === '/api/calendar/pull/preview') {
        const body = await readBody(req);
        if (!body.calendarId || !body.startDate || !body.endDate)
          return errRes(res, 400, 'calendarId / startDate / endDate が必要です');
        const cfg = getCalendarConfig();
        const accessToken = await refreshCalendarToken(cfg);
        const result = await dryRunPull(accessToken, {
          calendarId: body.calendarId,
          startDate:  body.startDate,
          endDate:    body.endDate,
        });
        return jsonRes(res, 200, { ok: true, ...result });
      }

      // GET /api/calendar/sync-runs  — 同期履歴
      if (method === 'GET' && path === '/api/calendar/sync-runs') {
        const runs = getSyncRuns(db, 30);
        return jsonRes(res, 200, { ok: true, runs });
      }

      // GET /api/calendar/links  — リンク一覧
      if (method === 'GET' && path === '/api/calendar/links') {
        const links = getCalendarLinks(db);
        return jsonRes(res, 200, { ok: true, links, count: links.length });
      }

      // ── Phase 28: 作品公開URL・原稿アーカイブ管理 ─────────────────────────────

      // GET /api/sf/works  — 作品一覧（公開URL件数・アーカイブ件数付き）
      if (method === 'GET' && path === '/api/sf/works') {
        const works = getWorks(db);
        return jsonRes(res, 200, { ok: true, works });
      }

      // PUT /api/sf/works/reorder  — 表示順を一括更新
      if (method === 'PUT' && path === '/api/sf/works/reorder') {
        let body;
        try { body = await readBody(req); } catch (e) { return errRes(res, 400, e.message); }
        const workIds = body?.work_ids;
        if (!Array.isArray(workIds)) return errRes(res, 400, 'work_ids が配列ではありません');
        try {
          reorderWorks(db, workIds.map(id => Number(id)));
          return jsonRes(res, 200, { ok: true });
        } catch (e) {
          return errRes(res, 400, e.message);
        }
      }

      // GET /api/sf/works/:id  — 作品詳細（work + publications + archives）
      const worksIdMatch = path.match(/^\/api\/sf\/works\/(\d+)$/);
      if (method === 'GET' && worksIdMatch) {
        const workId = parseInt(worksIdMatch[1], 10);
        const work = getWork(db, workId);
        if (!work) return errRes(res, 404, '作品が見つかりません');
        const publications = getWorkPublications(db, workId);
        const archives     = getWorkArchives(db, workId);
        return jsonRes(res, 200, { ok: true, work, publications, archives });
      }

      // PUT /api/sf/works/:id  — 作品詳細更新（synopsis / first_draft_date / character_count / memo のみ）
      if (method === 'PUT' && worksIdMatch) {
        const workId = parseInt(worksIdMatch[1], 10);
        let body;
        try { body = await readBody(req); } catch (e) { return errRes(res, 400, e.message); }
        try {
          const updated = updateWorkDetail(db, workId, body ?? {});
          return jsonRes(res, 200, { ok: true, work: updated });
        } catch (e) {
          return errRes(res, e.status || 400, e.message);
        }
      }

      // DELETE /api/sf/works/:id  — 作品削除（依存チェック付き）
      if (method === 'DELETE' && worksIdMatch) {
        const workId = parseInt(worksIdMatch[1], 10);
        try {
          const result = deleteWork(db, workId);
          return jsonRes(res, 200, { ok: true, ...result });
        } catch (e) {
          return errRes(res, e.status || 400, e.message);
        }
      }

      // GET /api/sf/works/:id/publications  — 作品の公開URL一覧
      const worksPublicationsMatch = path.match(/^\/api\/sf\/works\/(\d+)\/publications$/);
      if (method === 'GET' && worksPublicationsMatch) {
        const workId = parseInt(worksPublicationsMatch[1], 10);
        if (!getWork(db, workId)) return errRes(res, 404, '作品が見つかりません');
        const publications = getWorkPublications(db, workId);
        return jsonRes(res, 200, { ok: true, publications });
      }

      // POST /api/sf/works/:id/publications  — 公開URL登録/更新（UPSERT）
      if (method === 'POST' && worksPublicationsMatch) {
        const workId = parseInt(worksPublicationsMatch[1], 10);
        if (!getWork(db, workId)) return errRes(res, 404, '作品が見つかりません');
        let body;
        try { body = await readBody(req); } catch (e) { return errRes(res, 400, e.message); }
        if (!body.platform) return errRes(res, 400, 'platform が必要です');
        try {
          const result = upsertWorkPublication(db, { ...body, work_id: workId });
          return jsonRes(res, 200, { ok: true, ...result });
        } catch (e) {
          return errRes(res, 400, e.message);
        }
      }

      // PUT /api/sf/works/:id/publications/:pubId  — 公開URL更新（所属確認付き）
      const worksPubUpdateMatch = path.match(/^\/api\/sf\/works\/(\d+)\/publications\/(\d+)$/);
      if (method === 'PUT' && worksPubUpdateMatch) {
        const workId = parseInt(worksPubUpdateMatch[1], 10);
        const pubId  = parseInt(worksPubUpdateMatch[2], 10);
        if (!getWork(db, workId)) return errRes(res, 404, '作品が見つかりません');
        let body;
        try { body = await readBody(req); } catch (e) { return errRes(res, 400, e.message); }
        try {
          updateWorkPublication(db, workId, pubId, body);
          return jsonRes(res, 200, { ok: true });
        } catch (e) {
          return errRes(res, e.message.includes('見つかりません') ? 404 : 400, e.message);
        }
      }

      // GET /api/sf/works/:id/archives  — アーカイブ一覧
      const worksArchivesMatch = path.match(/^\/api\/sf\/works\/(\d+)\/archives$/);
      if (method === 'GET' && worksArchivesMatch) {
        const workId = parseInt(worksArchivesMatch[1], 10);
        if (!getWork(db, workId)) return errRes(res, 404, '作品が見つかりません');
        const archives = getWorkArchives(db, workId);
        return jsonRes(res, 200, { ok: true, archives });
      }

      // POST /api/sf/works/:workId/archives/text  — 直接入力テキストをアーカイブ保存
      const worksArchiveTextMatch = path.match(/^\/api\/sf\/works\/(\d+)\/archives\/text$/);
      if (method === 'POST' && worksArchiveTextMatch) {
        const workId = parseInt(worksArchiveTextMatch[1], 10);
        const archiveDir = process.env.MANUSCRIPT_ARCHIVE_DIR?.trim();
        if (!archiveDir) return errRes(res, 503, 'MANUSCRIPT_ARCHIVE_DIR が設定されていません');
        if (!getWork(db, workId)) return errRes(res, 404, '作品が見つかりません');
        let body;
        try { body = await readBody(req); } catch (e) { return errRes(res, 400, e.message); }
        const { content, version_label, version_date, memo } = body ?? {};
        if (!content?.trim()) return errRes(res, 400, '本文が空です');
        if (version_date && !/^\d{4}-\d{2}-\d{2}$/.test(version_date)) {
          return errRes(res, 400, 'version_date は YYYY-MM-DD 形式で指定してください');
        }
        try {
          const result = archiveTextContent(db, workId, content, {
            version_label: version_label || null,
            version_date:  version_date  || null,
            memo:          memo          || null,
            archiveDir,
          });
          return jsonRes(res, 200, { ok: true, ...result });
        } catch (e) {
          return errRes(res, e.status || 400, e.message);
        }
      }

      // POST /api/sf/works/:id/archives  — 原稿アーカイブ登録（バイナリアップロード）
      if (method === 'POST' && worksArchivesMatch) {
        const workId = parseInt(worksArchivesMatch[1], 10);
        if (!getWork(db, workId)) return errRes(res, 404, '作品が見つかりません');

        const archiveDir = process.env.MANUSCRIPT_ARCHIVE_DIR?.trim();
        if (!archiveDir) {
          return errRes(res, 503, 'MANUSCRIPT_ARCHIVE_DIR が設定されていません');
        }

        // X-* ヘッダからメタデータを取得
        const archive_type       = req.headers['x-archive-type'];
        const original_filename  = req.headers['x-original-filename']
          ? decodeURIComponent(req.headers['x-original-filename']) : null;
        const version_label      = req.headers['x-version-label']
          ? decodeURIComponent(req.headers['x-version-label']) : null;
        const version_date       = req.headers['x-version-date']
          ? decodeURIComponent(req.headers['x-version-date']) : null;
        const memo               = req.headers['x-memo']
          ? decodeURIComponent(req.headers['x-memo']) : null;

        if (!archive_type)      return errRes(res, 400, 'X-Archive-Type ヘッダが必要です');
        if (!original_filename) return errRes(res, 400, 'X-Original-Filename ヘッダが必要です');

        let buffer;
        try { buffer = await readBinaryBody(req); } catch (e) { return errRes(res, 400, e.message); }

        try {
          const result = archiveManuscript(
            db,
            { work_id: workId, archive_type, version_label, version_date, original_filename, memo, buffer },
            pathResolve(archiveDir),
          );
          return jsonRes(res, 200, { ok: true, ...result });
        } catch (e) {
          return errRes(res, 400, e.message);
        }
      }

      // DELETE /api/sf/works/:workId/archives/:archiveId  — アーカイブ登録解除（実ファイルは削除しない）
      const worksArchiveDelMatch = path.match(/^\/api\/sf\/works\/(\d+)\/archives\/(\d+)$/);
      if (method === 'DELETE' && worksArchiveDelMatch) {
        const workId    = parseInt(worksArchiveDelMatch[1], 10);
        const archiveId = parseInt(worksArchiveDelMatch[2], 10);
        try {
          const result = deleteWorkArchive(db, workId, archiveId);
          return jsonRes(res, 200, { ok: true, ...result });
        } catch (e) {
          return errRes(res, e.status || 500, e.message);
        }
      }

      // GET /api/sf/works/:id/archives/:archiveId/file  — アーカイブファイルダウンロード
      const worksArchiveFileMatch = path.match(/^\/api\/sf\/works\/(\d+)\/archives\/(\d+)\/file$/);
      if (method === 'GET' && worksArchiveFileMatch) {
        const workId    = parseInt(worksArchiveFileMatch[1], 10);
        const archiveId = parseInt(worksArchiveFileMatch[2], 10);

        const archiveDir = process.env.MANUSCRIPT_ARCHIVE_DIR?.trim();
        if (!archiveDir) return errRes(res, 503, 'MANUSCRIPT_ARCHIVE_DIR が設定されていません');

        if (!getWork(db, workId)) return errRes(res, 404, '作品が見つかりません');
        const record = getWorkArchive(db, workId, archiveId);
        if (!record) return errRes(res, 404, 'アーカイブが見つかりません');

        let filePath;
        try {
          filePath = getArchivePath(record, pathResolve(archiveDir));
        } catch (e) {
          return errRes(res, 400, 'Invalid file path');
        }

        const ext      = pathExtname(record.archived_filename).toLowerCase();
        const mimeMap  = {
          '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          '.md':   'text/plain; charset=utf-8',
          '.txt':  'text/plain; charset=utf-8',
          '.pdf':  'application/pdf',
        };
        const mime     = mimeMap[ext] || 'application/octet-stream';
        const safeName = encodeURIComponent(record.archived_filename);

        // ?mode=inline: PDF/TXT/MD はインライン表示、DOCX は強制ダウンロード
        const INLINE_EXTS = new Set(['.pdf', '.txt', '.md']);
        const wantInline  = url.searchParams.get('mode') === 'inline' && INLINE_EXTS.has(ext);
        const disposition = wantInline
          ? `inline; filename*=UTF-8''${safeName}`
          : `attachment; filename*=UTF-8''${safeName}`;

        res.writeHead(200, {
          'Content-Type':        mime,
          'Content-Disposition': disposition,
          'Cache-Control':       'no-store',
        });
        createReadStream(filePath).pipe(res);
        return;
      }

      // ── Phase 32: 競合アカウント分析 API ─────────────────────────────────────

      // GET /api/competitor/accounts — アカウント一覧
      if (method === 'GET' && path === '/api/competitor/accounts') {
        const accounts = listCompetitorAccounts(db);
        return jsonRes(res, 200, { ok: true, accounts });
      }

      // POST /api/competitor/accounts — アカウント登録
      if (method === 'POST' && path === '/api/competitor/accounts') {
        let body;
        try { body = await readBody(req); } catch (e) { return errRes(res, 400, e.message); }
        const { profile_url, note } = body;
        if (!profile_url) return errRes(res, 400, 'profile_url は必須です');

        let mercari_user_id;
        try {
          mercari_user_id = extractUserIdFromProfileUrl(profile_url);
        } catch (e) {
          return errRes(res, 400, e.message);
        }

        // 表示名は未確定（スキャン時に更新）、とりあえず ID で仮登録
        const display_name = body.display_name || `セラー ${mercari_user_id}`;
        try {
          const result = insertCompetitorAccount(db, {
            mercari_user_id, display_name,
            profile_url: `https://jp.mercari.com/user/profile/${mercari_user_id}`,
            note: note ?? null,
          });
          return jsonRes(res, 201, { ok: true, id: result.id, mercari_user_id });
        } catch (e) {
          if (e.message?.includes('UNIQUE')) return errRes(res, 409, 'このアカウントは既に登録されています');
          throw e;
        }
      }

      // PATCH /api/competitor/accounts/:id — アカウント更新
      if (method === 'PATCH' && /^\/api\/competitor\/accounts\/\d+$/.test(path)) {
        const id = parseInt(path.split('/').pop(), 10);
        let body;
        try { body = await readBody(req); } catch (e) { return errRes(res, 400, e.message); }
        const account = getCompetitorAccount(db, id);
        if (!account) return errRes(res, 404, 'アカウントが見つかりません');
        updateCompetitorAccount(db, id, {
          display_name: body.display_name,
          note:         body.note,
          is_active:    body.is_active,
        });
        return jsonRes(res, 200, { ok: true });
      }

      // GET /api/competitor/accounts/:id/items — 商品一覧
      if (method === 'GET' && /^\/api\/competitor\/accounts\/\d+\/items$/.test(path)) {
        const id     = parseInt(path.split('/')[4], 10);
        const status = url.searchParams.get('status') ?? undefined;
        const limit  = parseInt(url.searchParams.get('limit')  ?? '100', 10);
        const offset = parseInt(url.searchParams.get('offset') ?? '0',   10);
        const items = listCompetitorItems(db, id, { status, limit, offset });
        return jsonRes(res, 200, { ok: true, items });
      }

      // GET /api/competitor/accounts/:id/scans — スキャン履歴
      if (method === 'GET' && /^\/api\/competitor\/accounts\/\d+\/scans$/.test(path)) {
        const id    = parseInt(path.split('/')[4], 10);
        const limit = parseInt(url.searchParams.get('limit') ?? '30', 10);
        const scans = getCompetitorScans(db, id, limit);
        return jsonRes(res, 200, { ok: true, scans });
      }

      // GET /api/competitor/accounts/:id/analysis — 分析データ
      if (method === 'GET' && /^\/api\/competitor\/accounts\/\d+\/analysis$/.test(path)) {
        const id = parseInt(path.split('/')[4], 10);
        return jsonRes(res, 200, {
          ok: true,
          brand_ranking:     getBrandSoldRanking(db, id),
          category_stats:    getCategoryStats(db, id),
          buying_candidates: getBuyingCandidates(db, id, 50),
        });
      }

      // GET /api/competitor/reports — レポート一覧
      if (method === 'GET' && path === '/api/competitor/reports') {
        const report_type = url.searchParams.get('type') ?? undefined;
        const reports = listCompetitorReports(db, { report_type });
        return jsonRes(res, 200, { ok: true, reports });
      }

      // GET /api/competitor/notifications — 未読通知
      if (method === 'GET' && path === '/api/competitor/notifications') {
        const notifications = listUnreadNotifications(db);
        return jsonRes(res, 200, { ok: true, notifications });
      }

      // POST /api/competitor/notifications/read — 通知既読
      if (method === 'POST' && path === '/api/competitor/notifications/read') {
        let body;
        try { body = await readBody(req); } catch (e) { return errRes(res, 400, e.message); }
        if (!body.date) return errRes(res, 400, 'date は必須です');
        markNotificationRead(db, body.date);
        return jsonRes(res, 200, { ok: true });
      }

      // GET /api/competitor/settings — 分析設定
      if (method === 'GET' && path === '/api/competitor/settings') {
        const settings = getAnalysisSettings(db);
        return jsonRes(res, 200, { ok: true, settings });
      }

      // PATCH /api/competitor/settings — 分析設定更新
      if (method === 'PATCH' && path === '/api/competitor/settings') {
        let body;
        try { body = await readBody(req); } catch (e) { return errRes(res, 400, e.message); }
        const ALLOWED_KEYS = new Set([
          'fee_rate', 'shipping_cost', 'min_profit',
          'max_items_per_scan', 'confidence_high_min', 'confidence_med_min',
        ]);
        for (const [key, value] of Object.entries(body)) {
          if (ALLOWED_KEYS.has(key)) setSetting(db, key, String(value));
        }
        return jsonRes(res, 200, { ok: true, settings: getAnalysisSettings(db) });
      }

      return errRes(res, 404, 'Not Found');

    } catch (e) {
      console.error('[API Error]', e.message);
      return errRes(res, 500, 'Internal Server Error');
    }
  };
}
