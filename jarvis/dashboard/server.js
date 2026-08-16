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

import { createServer }              from 'http';
import { readFileSync, existsSync }  from 'fs';
import { resolve, extname, dirname, sep } from 'path';
import { fileURLToPath }             from 'url';

import { createDb, DEFAULT_DB_PATH } from '../data/db.js';
import { createApiHandler }          from './api.js';
import { syncAllInvoiceLinesToWorkRecords } from '../data/invoice_work_backfill.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(__dirname, 'public');
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

function readSmallJsonBody(req) {
  return new Promise((resolveBody, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > 65_536) reject(new Error('Request body too large'));
    });
    req.on('end', () => {
      try { resolveBody(body ? JSON.parse(body) : {}); }
      catch { reject(new Error('Invalid JSON')); }
    });
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  // ─── セキュリティヘッダー ────────────────────────────────────────────────
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');

  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  // ─── 既存請求書 → 仕事一覧 後追い同期 ────────────────────────────────────
  // 大量の請求書を先に取り込んでいた場合でも、再アップロードせず同期できる。
  if (url.pathname === '/api/invoice/sync-work' && req.method === 'POST') {
    let body;
    try { body = await readSmallJsonBody(req); }
    catch (e) { return jsonRes(res, 400, { ok: false, error: e.message }); }

    const year = body.year ? String(body.year) : null;
    if (year && !/^\d{4}$/.test(year)) {
      return jsonRes(res, 400, { ok: false, error: 'year は4桁で指定してください' });
    }

    try {
      const result = syncAllInvoiceLinesToWorkRecords(db, { year });
      return jsonRes(res, 200, result);
    } catch (e) {
      console.error('[invoice sync-work]', e.message);
      return jsonRes(res, 500, { ok: false, error: e.message });
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

    // Business のグラフ画面を既存HTMLを大きく変更せずタブから開けるようにする。
    if (relativePath === '/index.html') {
      const marker = '<button class="sf-tab" data-biz-tab="calendar">Google Calendar</button>';
      const graphButton = '<button class="sf-tab" type="button" onclick="location.href=\'/business-graph.html\'">グラフ</button>';
      const html = content.toString('utf8');
      if (html.includes(marker) && !html.includes('/business-graph.html')) {
        content = Buffer.from(html.replace(marker, marker + '\n    ' + graphButton), 'utf8');
      }
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
