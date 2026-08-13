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

      return errRes(res, 404, 'Not Found');

    } catch (e) {
      console.error('[API Error]', e.message);
      return errRes(res, 500, 'Internal Server Error');
    }
  };
}
