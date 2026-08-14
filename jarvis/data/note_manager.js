/**
 * jarvis/data/note_manager.js
 * note 記事 Workflow マネージャー（Phase 14）
 *
 * 設計原則:
 * - note へのログイン・自動投稿は禁止（MANUAL workflow のみ）
 * - 実 DB (business_data.db) はテストでは使用禁止（':memory:' のみ）
 * - 認証情報・パスワード・セッション・cookie は一切格納しない
 * - export は投稿用コンテンツ生成のみ。公開はユーザーが手動で行う
 * - status が 'published' 以外の記事は公開済み扱いしない
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// ─── 定数 ─────────────────────────────────────────────────────────────────────

export const VALID_STATUSES = [
  'idea', 'draft', 'review', 'ready', 'scheduled', 'published', 'archived',
];

export const VALID_EXPORT_FORMATS = ['md', 'txt', 'json'];

// ─── 内部ユーティリティ ───────────────────────────────────────────────────────

/**
 * status 遷移の妥当性検証。
 * 'published' 後は 'archived' のみ許可。同一 status への更新は拒否。
 */
function validateTransition(current, next) {
  if (!VALID_STATUSES.includes(next)) return false;
  if (current === next) return false;
  if (current === 'published' && next !== 'archived') return false;
  return true;
}

/**
 * DB 行を JavaScript オブジェクトに変換。
 * tags（JSON文字列）を配列に変換する。
 */
function parseRow(row) {
  if (!row) return null;
  let tags = [];
  if (row.tags) {
    try { tags = JSON.parse(row.tags); } catch (_) { tags = []; }
  }
  return { ...row, tags };
}

// ─── CRUD ────────────────────────────────────────────────────────────────────

/**
 * 記事を新規作成する。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {object} data
 * @returns {number} 新規 id
 */
export function createArticle(db, data) {
  if (!data || !data.title || typeof data.title !== 'string' || !data.title.trim()) {
    throw new Error('title は必須です');
  }
  const status = data.status ?? 'idea';
  if (!VALID_STATUSES.includes(status)) {
    throw new Error(`status が不正です: ${status}`);
  }

  const tags = Array.isArray(data.tags)
    ? JSON.stringify(data.tags)
    : (data.tags ? String(data.tags) : null);

  const result = db.prepare(`
    INSERT INTO sf_note_article
      (title, internal_key, article_type, status, summary, body_markdown, tags, magazine,
       related_work_id, related_track_id, related_release_id,
       scheduled_date, published_date, note_url)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).run(
    data.title.trim(),
    data.internal_key   ?? null,
    data.article_type   ?? null,
    status,
    data.summary        ?? null,
    data.body_markdown  ?? null,
    tags,
    data.magazine       ?? null,
    data.related_work_id    ?? null,
    data.related_track_id   ?? null,
    data.related_release_id ?? null,
    data.scheduled_date ?? null,
    data.published_date ?? null,
    data.note_url       ?? null,
  );
  return Number(result.lastInsertRowid);
}

/**
 * 記事の本文・メタデータを部分更新する。
 * status 変更は setStatus() を使う。
 * @returns {object} 更新後の記事
 */
export function updateArticle(db, id, data) {
  const article = getArticle(db, id);
  if (!article) throw new Error(`記事が見つかりません: id=${id}`);

  if ('title' in data) {
    if (!data.title || typeof data.title !== 'string' || !data.title.trim()) {
      throw new Error('title は空にできません');
    }
  }

  const merged = {
    title:          ('title' in data)          ? data.title.trim()    : article.title,
    internal_key:   ('internal_key' in data)   ? data.internal_key    : article.internal_key,
    article_type:   ('article_type' in data)   ? data.article_type    : article.article_type,
    summary:        ('summary' in data)        ? data.summary         : article.summary,
    body_markdown:  ('body_markdown' in data)  ? data.body_markdown   : article.body_markdown,
    magazine:       ('magazine' in data)       ? data.magazine        : article.magazine,
    related_work_id:    ('related_work_id' in data)    ? data.related_work_id    : article.related_work_id,
    related_track_id:   ('related_track_id' in data)   ? data.related_track_id   : article.related_track_id,
    related_release_id: ('related_release_id' in data) ? data.related_release_id : article.related_release_id,
    scheduled_date: ('scheduled_date' in data) ? data.scheduled_date  : article.scheduled_date,
  };

  // tags: Array → JSON string, 未指定なら既存値を保持
  let tags;
  if ('tags' in data) {
    tags = Array.isArray(data.tags)
      ? JSON.stringify(data.tags)
      : (data.tags ? String(data.tags) : null);
  } else {
    tags = article.tags.length > 0 ? JSON.stringify(article.tags) : null;
  }

  db.prepare(`
    UPDATE sf_note_article SET
      title=?, internal_key=?, article_type=?, summary=?, body_markdown=?,
      tags=?, magazine=?, related_work_id=?, related_track_id=?, related_release_id=?,
      scheduled_date=?, updated_at=datetime('now','localtime')
    WHERE id=?
  `).run(
    merged.title, merged.internal_key, merged.article_type,
    merged.summary, merged.body_markdown,
    tags, merged.magazine,
    merged.related_work_id, merged.related_track_id, merged.related_release_id,
    merged.scheduled_date, id,
  );
  return getArticle(db, id);
}

/**
 * status を遷移させる。
 * 'published' 後は 'archived' のみ許可。同一 status への更新は拒否。
 * @returns {object} 更新後の記事
 */
export function setStatus(db, id, newStatus) {
  const article = getArticle(db, id);
  if (!article) throw new Error(`記事が見つかりません: id=${id}`);

  if (!validateTransition(article.status, newStatus)) {
    if (!VALID_STATUSES.includes(newStatus)) {
      throw new Error(`status が不正です: ${newStatus}`);
    }
    if (article.status === newStatus) {
      throw new Error(`status 遷移が無効です: すでに ${newStatus} です`);
    }
    throw new Error(`status 遷移が無効です: ${article.status} → ${newStatus}`);
  }

  db.prepare(`
    UPDATE sf_note_article SET status=?, updated_at=datetime('now','localtime') WHERE id=?
  `).run(newStatus, id);
  return getArticle(db, id);
}

/**
 * ユーザーが note へ投稿した後、公開済みとして記録する。
 * status を 'published' に設定し、URL と公開日を記録する。
 * JARVIS は自動投稿しない。
 * @returns {object} 更新後の記事
 */
export function recordPublished(db, id, { note_url, published_date } = {}) {
  const article = getArticle(db, id);
  if (!article) throw new Error(`記事が見つかりません: id=${id}`);

  db.prepare(`
    UPDATE sf_note_article SET
      status='published',
      note_url=COALESCE(?, note_url),
      published_date=COALESCE(?, published_date),
      updated_at=datetime('now','localtime')
    WHERE id=?
  `).run(note_url ?? null, published_date ?? null, id);
  return getArticle(db, id);
}

// ─── READ ─────────────────────────────────────────────────────────────────────

/**
 * 単件取得。存在しない場合は null を返す。
 */
export function getArticle(db, id) {
  const row = db.prepare('SELECT * FROM sf_note_article WHERE id=?').get(id);
  return parseRow(row);
}

/**
 * 一覧取得。オプションでフィルタリング。
 * @param {{ status?: string, article_type?: string, limit?: number }} opts
 */
export function getArticles(db, opts = {}) {
  const conditions = [];
  const params = [];

  if (opts.status) {
    conditions.push('status=?');
    params.push(opts.status);
  }
  if (opts.article_type) {
    conditions.push('article_type=?');
    params.push(opts.article_type);
  }

  const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
  const rawLimit = parseInt(opts.limit ?? 100, 10);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, 500) : 100;

  const rows = db.prepare(`
    SELECT * FROM sf_note_article ${where}
    ORDER BY updated_at DESC, id DESC LIMIT ?
  `).all(...params, limit);
  return rows.map(parseRow);
}

/**
 * status 別に記事一覧を取得する。
 */
export function getArticlesByStatus(db, status) {
  return getArticles(db, { status });
}

/**
 * 公開予定記事（status='scheduled'）を scheduled_date 昇順で取得する。
 */
export function getScheduledArticles(db) {
  const rows = db.prepare(`
    SELECT * FROM sf_note_article
    WHERE status='scheduled'
    ORDER BY scheduled_date ASC, id ASC
  `).all();
  return rows.map(parseRow);
}

/**
 * Dashboard 用サマリー（status 別カウント）。
 * @returns {{ total: number, counts: Record<string, number> }}
 */
export function getDashboardSummary(db) {
  const rows = db.prepare(`
    SELECT status, COUNT(*) AS count FROM sf_note_article GROUP BY status
  `).all();
  const counts = Object.fromEntries(VALID_STATUSES.map(s => [s, 0]));
  for (const r of rows) counts[r.status] = r.count;
  const total = Object.values(counts).reduce((a, b) => a + b, 0);
  return { total, counts };
}

// ─── EXPORT ───────────────────────────────────────────────────────────────────

/**
 * 投稿用コンテンツ文字列を生成する。
 * note 認証情報は含まない。AI 生成内容ではなく手動記入の body_markdown を使用。
 * @param {object} article - getArticle() の戻り値
 * @param {'md'|'txt'|'json'} format
 * @returns {string}
 */
export function generateExport(article, format) {
  if (!VALID_EXPORT_FORMATS.includes(format)) {
    throw new Error(`format が不正です: ${format}`);
  }

  const tags = Array.isArray(article.tags) ? article.tags : [];

  if (format === 'json') {
    return JSON.stringify({
      title:        article.title,
      article_type: article.article_type ?? null,
      summary:      article.summary      ?? null,
      body:         article.body_markdown ?? null,
      tags,
      magazine:     article.magazine     ?? null,
      scheduled_date: article.scheduled_date ?? null,
    }, null, 2);
  }

  if (format === 'md') {
    const lines = [];
    lines.push(`# ${article.title}`);
    lines.push('');
    if (article.summary) {
      lines.push(`> ${article.summary}`);
      lines.push('');
    }
    if (tags.length) {
      lines.push(`**タグ:** ${tags.join(' / ')}`);
      lines.push('');
    }
    if (article.magazine) {
      lines.push(`**マガジン:** ${article.magazine}`);
      lines.push('');
    }
    lines.push('---');
    lines.push('');
    if (article.body_markdown) lines.push(article.body_markdown);
    return lines.join('\n');
  }

  // txt
  const lines = [];
  lines.push(article.title);
  lines.push('='.repeat(Math.max(article.title.length, 1)));
  lines.push('');
  if (article.summary) {
    lines.push(article.summary);
    lines.push('');
  }
  if (tags.length) {
    lines.push(`タグ: ${tags.join(' / ')}`);
    lines.push('');
  }
  if (article.magazine) {
    lines.push(`マガジン: ${article.magazine}`);
    lines.push('');
  }
  lines.push('---');
  lines.push('');
  if (article.body_markdown) lines.push(article.body_markdown);
  return lines.join('\n');
}

/**
 * 記事をファイルとして書き出す。
 * exportDir が存在しない場合は作成する。
 * 同一ファイルへの再書き出しは安全に上書きする。
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {number} id
 * @param {'md'|'txt'|'json'} format
 * @param {string} exportDir - 書き出し先ディレクトリの絶対パス
 * @returns {string} 書き出したファイルの絶対パス
 */
export function writeNoteExport(db, id, format, exportDir) {
  const article = getArticle(db, id);
  if (!article) throw new Error(`記事が見つかりません: id=${id}`);
  if (!VALID_EXPORT_FORMATS.includes(format)) throw new Error(`format が不正です: ${format}`);

  const content = generateExport(article, format);

  mkdirSync(exportDir, { recursive: true });

  // 安全なファイル名（英数字・日本語・ハイフン・アンダースコアのみ、最大50文字）
  const safeTitle = article.title
    .replace(/[^\w\u3040-\u9fff\-]/g, '_')
    .replace(/_+/g, '_')
    .slice(0, 50);
  const ext = format;
  const filename = `note_${id}_${safeTitle}.${ext}`;
  const filepath = join(exportDir, filename);

  writeFileSync(filepath, content, 'utf8');
  return filepath;
}
