/**
 * jarvis/dashboard/api.js
 * REST API ハンドラ
 *
 * - 既存 DBモジュールをそのまま利用（ロジック重複実装なし）
 * - 全エンドポイントでサーバ側入力検証を実施
 * - ConflictError（完全休日への仕事登録）は 409 で返す
 */

import { addWorkRecord, getWorkRecords, updateWorkRecord, updateWorkRecordFull }
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

/** POST ボディを JSON として読み込む（最大 64 KB） */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 65_536) reject(new Error('Request body too large'));
    });
    req.on('end', () => {
      try { resolve(body ? JSON.parse(body) : {}); }
      catch  { reject(new Error('Invalid JSON')); }
    });
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
            invoice_status: body.invoice_status || '対象外',
            payment_status: body.payment_status || '対象外',
            memo:           body.memo           || null,
          });
          return jsonRes(res, 201, { ok: true, id: rowid, job_id });
        } catch (e) {
          const status = e.message.startsWith('ConflictError') ? 409 : 400;
          return errRes(res, status, e.message);
        }
      }

      // ── PUT /api/work/:id ──────────────────────────────────────────────────
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
            invoice_status: body.invoice_status,
            payment_status: body.payment_status,
            memo:           body.memo,
          });
          return jsonRes(res, 200, { ok: true });
        } catch (e) {
          return errRes(res, 400, e.message);
        }
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

      return errRes(res, 404, 'Not Found');

    } catch (e) {
      console.error('[API Error]', e.message);
      return errRes(res, 500, 'Internal Server Error');
    }
  };
}
