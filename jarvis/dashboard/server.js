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

import { createServer }            from 'http';
import { readFileSync, existsSync } from 'fs';
import { resolve, extname, dirname, sep } from 'path';
import { fileURLToPath }           from 'url';

import { createDb, DEFAULT_DB_PATH } from '../data/db.js';
import { createApiHandler }          from './api.js';

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

const server = createServer((req, res) => {
  // ─── セキュリティヘッダー ────────────────────────────────────────────────
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');

  const url = new URL(req.url, `http://${HOST}:${PORT}`);

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
    const content = readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': contentType });
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
