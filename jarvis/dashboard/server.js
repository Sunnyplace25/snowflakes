#!/usr/bin/env node
/**
 * jarvis/dashboard/server.js
 * JARVIS Dashboard ローカル HTTP サーバ
 *
 * - 127.0.0.1 のみバインド（0.0.0.0 禁止・外部公開しない）
 * - /api/*    → api.js へルーティング
 * - /        → public/ 静的ファイル配信
 * - DBファイルは public/ 配下に置かない（HTTP 経由で取得不可）
 */

import { createServer } from 'http';
import { readFileSync, existsSync, mkdirSync, copyFileSync } from 'fs';
import { resolve, extname, dirname, sep, basename } from 'path';
import { fileURLToPath } from 'url';

import { createDb, DEFAULT_DB_PATH } from '../data/db.js';
import { createApiHandler } from './api.js';
import { syncAllInvoiceLinesToWorkRecords } from '../data/invoice_work_backfill.js';
import {
  getNurseryShifts,
  upsertNurseryShift,
  updateNurseryShift,
  deleteNurseryShift,
} from '../data/nursery_shift_manager.js';
import {
  getInvoiceTemplateStatus,
  saveInvoiceTemplate,
  buildInvoicePreview,
  generateInvoiceWorkbook,
} from '../data/invoice_generator.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(__dirname, 'public');
const BACKUP_DIR = resolve(__dirname, '../backups');
const PORT = 3000;
const HOST = '127.0.0.1';   // localhost 限定

// DB 接続（起動時に 1 回だけ）
const db = createDb(DEFAULT_DB_PATH);
const apiHandler = createApiHandler(db);

// MIME types（外部フォント・CDN 不使用）
const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.ico':  'image/x-icon',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
};

function jsonRes(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache',
  });
  res.end(JSON.stringify(data));
}

function readJsonBody(req, maxBytes = 10_485_760) {
  return new Promise((resolveBody, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > maxBytes) reject(new Error('Request body too large'));
    });
    req.on('end', () => {
      try { resolveBody(body ? JSON.parse(body) : {}); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

function backupBusinessDb() {
  // WAL に残った書き込みを本体DBへ反映してからコピーする。
  db.exec('PRAGMA wal_checkpoint(FULL)');
  mkdirSync(BACKUP_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = resolve(BACKUP_DIR, `business_data_before_invoice_sync_${stamp}.db`);
  copyFileSync(DEFAULT_DB_PATH, backupPath);
  return backupPath;
}

function tableExists(name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name = ? LIMIT 1").get(name);
}

function deleteWorkRecord(id) {
  const work = db.prepare('SELECT id, job_id, date, content FROM work_records WHERE id = ?').get(id);
  if (!work) return null;

  db.exec('BEGIN IMMEDIATE');
  try {
    // 請求書同期から作られた仕事の場合はリンクも外して、孤児レコードを残さない。
    // 後日「既存請求書 → 仕事一覧を同期」を再実行すると、その仕事は再作成されることがある。
    if (work.job_id && tableExists('business_invoice_work_links')) {
      db.prepare('DELETE FROM business_invoice_work_links WHERE job_id = ?').run(work.job_id);
    }
    if (work.job_id && tableExists('business_invoice_lines')) {
      db.prepare('UPDATE business_invoice_lines SET job_id = NULL WHERE job_id = ?').run(work.job_id);
    }

    db.prepare('DELETE FROM work_records WHERE id = ?').run(id);
    db.exec('COMMIT');
    return work;
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch {}
    throw e;
  }
}

const server = createServer(async (req, res) => {
  // ─── セキュリティヘッダー ────────────────────────────────────────────────
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');

  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  // ─── 既存請求書 → 仕事一覧 後追い同期 ────────────────────────────────────
  if (url.pathname === '/api/invoice/sync-work' && req.method === 'POST') {
    let body;
    try { body = await readJsonBody(req); }
    catch (e) { return jsonRes(res, 400, { ok: false, error: e.message }); }

    const year = body.year ? String(body.year) : null;
    if (year && !/^\d{4}$/.test(year)) {
      return jsonRes(res, 400, { ok: false, error: 'year は4桁で指定してください' });
    }

    try {
      const backupPath = backupBusinessDb();
      const result = syncAllInvoiceLinesToWorkRecords(db, { year });
      return jsonRes(res, 200, { ...result, backup: basename(backupPath) });
    } catch (e) {
      console.error('[invoice sync-work]', e.message);
      return jsonRes(res, 500, { ok: false, error: e.message });
    }
  }

  // ─── 仕事削除 ────────────────────────────────────────────────────────────
  const deleteWorkMatch = url.pathname.match(/^\/api\/work\/(\d+)$/);
  if (deleteWorkMatch && req.method === 'DELETE') {
    const id = Number(deleteWorkMatch[1]);
    if (!Number.isInteger(id) || id <= 0) {
      return jsonRes(res, 400, { ok: false, error: '不正な仕事IDです' });
    }

    try {
      const deleted = deleteWorkRecord(id);
      if (!deleted) return jsonRes(res, 404, { ok: false, error: '仕事が見つかりません' });
      return jsonRes(res, 200, { ok: true, deleted });
    } catch (e) {
      console.error('[delete work]', e.message);
      return jsonRes(res, 500, { ok: false, error: '削除に失敗しました' });
    }
  }

  // ─── 保育園シフト ────────────────────────────────────────────────────────
  if (url.pathname === '/api/nursery-shifts' && req.method === 'GET') {
    const month = url.searchParams.get('month') || null;
    try {
      const shifts = getNurseryShifts(db, { month });
      return jsonRes(res, 200, { ok: true, shifts });
    } catch (e) {
      return jsonRes(res, 400, { ok: false, error: e.message });
    }
  }

  if (url.pathname === '/api/nursery-shift' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const shift = upsertNurseryShift(db, body);
      return jsonRes(res, 201, { ok: true, shift });
    } catch (e) {
      return jsonRes(res, 400, { ok: false, error: e.message });
    }
  }

  const nurseryMatch = url.pathname.match(/^\/api\/nursery-shift\/(\d+)$/);
  if (nurseryMatch && req.method === 'PUT') {
    try {
      const body = await readJsonBody(req);
      const shift = updateNurseryShift(db, Number(nurseryMatch[1]), body);
      if (!shift) return jsonRes(res, 404, { ok: false, error: 'シフトが見つかりません' });
      return jsonRes(res, 200, { ok: true, shift });
    } catch (e) {
      return jsonRes(res, 400, { ok: false, error: e.message });
    }
  }

  if (nurseryMatch && req.method === 'DELETE') {
    try {
      const shift = deleteNurseryShift(db, Number(nurseryMatch[1]));
      if (!shift) return jsonRes(res, 404, { ok: false, error: 'シフトが見つかりません' });
      return jsonRes(res, 200, { ok: true, deleted: shift });
    } catch (e) {
      return jsonRes(res, 500, { ok: false, error: e.message });
    }
  }

  // ─── 請求書テンプレート・生成 ────────────────────────────────────────────
  if (url.pathname === '/api/invoice/template-status' && req.method === 'GET') {
    return jsonRes(res, 200, { ok: true, ...getInvoiceTemplateStatus() });
  }

  if (url.pathname === '/api/invoice/template' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      if (!body.data_b64) return jsonRes(res, 400, { ok: false, error: 'Excelファイルが必要です' });
      const result = saveInvoiceTemplate(Buffer.from(body.data_b64, 'base64'));
      return jsonRes(res, 200, { ok: true, ...result });
    } catch (e) {
      return jsonRes(res, 400, { ok: false, error: e.message });
    }
  }

  if (url.pathname === '/api/invoice/generate-preview' && req.method === 'GET') {
    try {
      const month = url.searchParams.get('month');
      const preview = buildInvoicePreview(db, month);
      return jsonRes(res, 200, { ok: true, ...preview });
    } catch (e) {
      return jsonRes(res, 400, { ok: false, error: e.message });
    }
  }

  if (url.pathname === '/api/invoice/generate' && req.method === 'POST') {
    try {
      const body = await readJsonBody(req);
      const result = generateInvoiceWorkbook(db, body);
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(result.filename)}`,
        'Content-Length': result.buffer.length,
        'Cache-Control': 'no-cache',
      });
      return res.end(result.buffer);
    } catch (e) {
      return jsonRes(res, 400, { ok: false, error: e.message });
    }
  }

  // ─── API ルーティング ────────────────────────────────────────────────────
  if (url.pathname.startsWith('/api/')) {
    return apiHandler(req, res, url);
  }

  // ─── 静的ファイル配信 ─────────────────────────────────────────────────────
  let relativePath = url.pathname === '/' ? '/index.html' : url.pathname;

  // パストラバーサル防止
  const filePath = resolve(PUBLIC_DIR, '.' + relativePath);
  if (!filePath.startsWith(PUBLIC_DIR + sep) && filePath !== PUBLIC_DIR) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    return res.end('Forbidden');
  }

  if (!existsSync(filePath)) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    return res.end('Not Found');
  }

  const ext = extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';

  try {
    let content = readFileSync(filePath);

    // Business の追加UIを index.html に注入する。
    if (relativePath === '/index.html') {
      let html = content.toString('utf8');

      const marker = '<button class="sf-tab" data-biz-tab="calendar">Google Calendar</button>';
      const graphButton = '<button class="sf-tab" type="button" onclick="location.href=\'/business-graph.html\'">グラフ</button>';
      if (html.includes(marker) && !html.includes('/business-graph.html')) {
        html = html.replace(marker, marker + '\n    ' + graphButton);
      }

      const customScript = '<script src="business-custom.js"></script>';
      if (!html.includes('business-custom.js')) {
        html = html.replace('</body>', `${customScript}\n</body>`);
      }

      content = Buffer.from(html, 'utf8');
    }

    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-cache' });
    res.end(content);
  } catch {
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Internal Server Error');
  }
});

server.listen(PORT, HOST, () => {
  console.log(`JARVIS Dashboard 起動: http://${HOST}:${PORT}`);
  console.log('終了するには Ctrl+C を押してください');
});

// ─── グレースフルシャットダウン ──────────────────────────────────────────────
process.on('SIGINT', () => {
  console.log('\nシャットダウン中...');
  server.close(() => {
    try { db.close(); } catch {}
    process.exit(0);
  });
});
