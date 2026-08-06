#!/usr/bin/env node
/**
 * Snow flakes JARVIS - note記事下書き生成
 * generate_note_draft.js v0.1.0
 *
 * 使用方法（jarvis/ ディレクトリから実行）:
 *   npm run note-draft
 *
 * 方針:
 *   - Node.js 標準機能のみ使用（外部パッケージなし）
 *   - 外部通信・note API・OAuth 認証・ブラウザ自動化・git 操作なし
 *   - 生成した下書きは drafts/pending/ に保存するのみ（note への投稿は行わない）
 *   - ログにタイトル・本文・リード・まとめ・ハッシュタグ・価格・アイキャッチ・マガジン情報を記録しない
 */

import fs       from 'fs';
import path     from 'path';
import readline from 'readline';
import crypto   from 'crypto';
import { fileURLToPath } from 'url';

// ── パス設定 ─────────────────────────────────────────────────────
const __filename  = fileURLToPath(import.meta.url);
const __dirname   = path.dirname(__filename);
const JARVIS_ROOT = path.resolve(__dirname, '..');
const REPO_ROOT   = path.resolve(JARVIS_ROOT, '..');
const PENDING_DIR = path.join(JARVIS_ROOT, 'drafts', 'pending');
const LOG_DIR     = path.join(JARVIS_ROOT, 'logs');
const LOG_PATH    = path.join(LOG_DIR, 'history.log');

const TOOL_VERSION    = '0.1.0';
const SCHEDULED_AT_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?)?$/;

const VALID_ARTICLE_TYPES = [
  '小説', '短編', '制作日記', '楽曲解説', '活動報告',
  'イベント告知', 'お知らせ', 'コラム', '有料記事', 'その他',
];

// ── ユーティリティ ────────────────────────────────────────────────

function nowJST() {
  return new Date().toLocaleString('ja-JP', {
    timeZone: 'Asia/Tokyo',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  }).replace(/\//g, '-');
}

function nowISO() {
  const d = new Date();
  return new Date(d.getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 19) + '+09:00';
}

function todayYYYYMMDD() {
  const jst = new Date(Date.now() + 9 * 60 * 60 * 1000);
  return jst.toISOString().slice(0, 10).replace(/-/g, '');
}

function genId() {
  return `draft_${todayYYYYMMDD()}_${crypto.randomBytes(3).toString('hex')}`;
}

function writeLog(parts) {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    fs.appendFileSync(LOG_PATH, `[${nowJST()}] ${parts.join(' | ')}\n`, 'utf-8');
  } catch { /* ログ失敗は処理を止めない */ }
}

function safeWrite(dir, filename, data) {
  const finalPath = path.join(dir, filename);
  const tmpPath   = finalPath + '.tmp';
  const cleanup   = () => { try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {} };
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
    JSON.parse(fs.readFileSync(tmpPath, 'utf-8'));
    fs.renameSync(tmpPath, finalPath);
    return { ok: true };
  } catch (e) {
    cleanup();
    return { ok: false, reason: e.message };
  }
}

function hr(char = '─', width = 60) { return char.repeat(width); }

// ── stdin 読み込みヘルパー ────────────────────────────────────────
// Node.js v18+ では非TTY環境（パイプ）で readline が全行を即座に処理するため、
// stdin が TTY でない場合は先に全行を読み込んでおき、順に返す方式に切り替える。

async function createAskFn() {
  if (process.stdin.isTTY) {
    // 対話モード: readline を通常どおり使用
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = q => new Promise(resolve => rl.question(q, resolve));
    return { ask, close: () => rl.close() };
  } else {
    // パイプ・リダイレクト: 全行を先読みしてキューに積む
    const lines = await new Promise(resolve => {
      const buf = [];
      const scanner = readline.createInterface({ input: process.stdin });
      scanner.on('line', line => buf.push(line));
      scanner.on('close', () => resolve(buf));
    });
    let idx = 0;
    const ask = q => {
      const line = idx < lines.length ? lines[idx++] : '';
      process.stdout.write(q + line + '\n');
      return Promise.resolve(line);
    };
    return { ask, close: () => {} };
  }
}

// ── メイン処理 ────────────────────────────────────────────────────

async function main() {
  const { ask, close: rlClose } = await createAskFn();

  console.log('\n' + hr('═'));
  console.log('  Snow flakes JARVIS - note記事下書き生成');
  console.log(hr('─'));
  console.log('  ※ note への直接投稿・API接続は行いません');
  console.log('  ※ 生成した下書きは drafts/pending/ に保存されます');
  console.log(hr('═') + '\n');

  // ── Step 1: タイトル（必須）────────────────────────────────────
  console.log('[Step 1/16] タイトル（必須）');
  let title = '';
  while (!title.trim()) {
    title = (await ask('> ')).trim();
    if (!title) console.log('  タイトルは必須です。入力してください。');
  }

  // ── Step 2: 記事タイプ（必須）──────────────────────────────────
  console.log('\n[Step 2/16] 記事タイプを選択してください（必須）');
  VALID_ARTICLE_TYPES.forEach((t, i) => console.log(`  ${i + 1}. ${t}`));

  let article_type = null;
  while (!article_type) {
    const inp = (await ask('番号を入力> ')).trim();
    const n   = parseInt(inp, 10);
    if (!isNaN(n) && n >= 1 && n <= VALID_ARTICLE_TYPES.length) {
      article_type = VALID_ARTICLE_TYPES[n - 1];
    } else {
      console.log(`  1〜${VALID_ARTICLE_TYPES.length} の番号を入力してください。`);
    }
  }
  console.log(`  → ${article_type}`);

  // ── Step 3: リード文（任意）────────────────────────────────────
  console.log('\n[Step 3/16] リード文（任意、空欄でスキップ）');
  const leadRaw = (await ask('> ')).trim();
  const lead    = leadRaw || null;

  // ── Step 4: 本文（必須）────────────────────────────────────────
  console.log('\n[Step 4/16] 本文（必須）');
  console.log('  入力方式を選択してください:');
  console.log('    1. 直接入力（空行で確定）');
  console.log('    2. テキストファイルから読み込み（UTF-8、リポジトリルートからの相対パス）');

  let body       = '';
  let bodyMethod = '';
  while (!bodyMethod) {
    const m = (await ask('番号を入力> ')).trim();
    if (m === '1' || m === '2') { bodyMethod = m; }
    else { console.log('  1 または 2 を入力してください。'); }
  }

  if (bodyMethod === '1') {
    // 直接入力モード
    const readBodyLines = async () => {
      console.log('  本文を入力してください（空行で確定）:');
      const lines = [];
      while (true) {
        const line = await ask('');
        if (line === '') break;
        lines.push(line);
      }
      return lines.join('\n');
    };
    body = await readBodyLines();
    while (!body.trim()) {
      console.log('  本文は必須です。');
      body = await readBodyLines();
    }
  } else {
    // ファイル読み込みモード
    let fileLoaded = false;
    while (!fileLoaded) {
      console.log('  リポジトリルートからの相対パスを入力してください（例: docs/article.txt）:');
      const p = (await ask('> ')).trim();
      if (!p) { console.log('  パスが入力されていません。'); continue; }
      if (p.includes('../') || p.includes('..\\')) {
        console.log('  エラー: パスに ../ を含むことはできません。');
        continue;
      }
      if (/^[/\\]/.test(p) || /^[A-Za-z]:[/\\]/.test(p)) {
        console.log('  エラー: 絶対パスは使用できません。リポジトリルートからの相対パスで指定してください。');
        continue;
      }
      const fullPath = path.resolve(REPO_ROOT, p);
      if (!fullPath.startsWith(REPO_ROOT + path.sep) && fullPath !== REPO_ROOT) {
        console.log('  エラー: リポジトリルート外のパスは指定できません。');
        continue;
      }
      if (!fs.existsSync(fullPath)) {
        console.log(`  エラー: ファイルが見つかりません: ${p}`);
        continue;
      }
      try {
        const loaded = fs.readFileSync(fullPath, 'utf-8');
        if (!loaded.trim()) { console.log('  エラー: ファイルの内容が空です。'); continue; }
        body = loaded;
        console.log(`  ✅ 読み込み完了（${body.length}文字）`);
        fileLoaded = true;
      } catch (e) {
        console.log(`  エラー: ファイルの読み込みに失敗しました: ${e.message}`);
      }
    }
  }

  // ── Step 5: 見出し構成メモ（任意）──────────────────────────────
  console.log('\n[Step 5/16] 見出し構成メモ（任意、1行ずつ入力、空行で確定）');
  const headings = [];
  while (true) {
    const prompt = headings.length === 0 ? '> （空行でスキップ）' : '> ';
    const h = await ask(prompt);
    if (h === '') break;
    headings.push(h.trim());
  }

  // ── Step 6: まとめ（任意）──────────────────────────────────────
  console.log('\n[Step 6/16] まとめ（任意、空欄でスキップ）');
  const summaryRaw = (await ask('> ')).trim();
  const summary    = summaryRaw || null;

  // ── Step 7: ハッシュタグ（任意）────────────────────────────────
  console.log('\n[Step 7/16] ハッシュタグ（任意、カンマまたはスペース区切り、空欄でスキップ）');
  const hashtagsRaw = (await ask('> ')).trim();
  const hashtags    = hashtagsRaw
    ? hashtagsRaw.split(/[,\s]+/).map(t => t.replace(/^#/, '').trim()).filter(Boolean)
    : [];

  // ── Step 8: アイキャッチ画像パス（任意）────────────────────────
  console.log('\n[Step 8/16] アイキャッチ画像パス（任意、リポジトリルートからの相対パス、空欄でスキップ）');
  const epRaw = (await ask('> ')).trim();
  let eyecatch_path = null;
  if (epRaw) {
    if (epRaw.includes('../') || epRaw.includes('..\\')) {
      console.log('  ⚠️  警告: パスに ../ を含みます。preflight で BLOCK になります。');
    } else if (/^[/\\]/.test(epRaw) || /^[A-Za-z]:[/\\]/.test(epRaw)) {
      console.log('  ⚠️  警告: 絶対パスです。preflight で BLOCK になります。');
    }
    eyecatch_path = epRaw;
  }

  // ── Step 9: 公開予定日時（任意）────────────────────────────────
  console.log('\n[Step 9/16] 公開予定日時（任意、例: 2026-08-10 18:00、空欄でスキップ）');
  console.log('  ※ noteへの予約登録は行いません。JARVIS内の管理用メモです。');
  const saRaw = (await ask('> ')).trim();
  let scheduled_at = null;
  if (saRaw) {
    if (!SCHEDULED_AT_RE.test(saRaw)) {
      console.log('  ⚠️  警告: 日時形式が不正です（例: 2026-08-10 18:00）。preflight で BLOCK になります。');
    }
    scheduled_at = saRaw;
  }

  // ── Step 10: 公開設定（必須）───────────────────────────────────
  console.log('\n[Step 10/16] 公開設定（必須）');
  console.log('  1. 無料公開');
  console.log('  2. 有料記事');

  let visibility = '';
  while (!visibility) {
    const v = (await ask('番号を入力> ')).trim();
    if (v === '1') { visibility = 'free'; }
    else if (v === '2') { visibility = 'paid'; }
    else { console.log('  1 または 2 を入力してください。'); }
  }
  console.log(`  → ${visibility === 'free' ? '無料公開' : '有料記事'}`);

  // ── Step 11: 価格（有料のみ）───────────────────────────────────
  let price = null;
  if (visibility === 'paid') {
    console.log('\n[Step 11/16] 販売価格（円、正の整数、必須）');
    while (price === null) {
      const pRaw = (await ask('> ')).trim();
      const p    = parseInt(pRaw, 10);
      if (!pRaw || isNaN(p) || p <= 0 || String(p) !== pRaw) {
        console.log('  正の整数で価格を入力してください（例: 300）。');
      } else {
        price = p;
      }
    }
  } else {
    console.log('\n[Step 11/16] 販売価格 → スキップ（無料記事のため）');
  }

  // ── Step 12: 有料パート区切りマーカー（有料のみ）───────────────
  let paid_section_marker = null;
  if (visibility === 'paid') {
    console.log('\n[Step 12/16] 有料パートの区切りマーカー（任意、空欄でスキップ）');
    console.log('  ※ 本文中で無料/有料の区切りを示す文字列です（例: ---ここから有料---）');
    const psmRaw = (await ask('> ')).trim();
    paid_section_marker = psmRaw || null;
  } else {
    console.log('\n[Step 12/16] 有料パートの区切りマーカー → スキップ（無料記事のため）');
  }

  // ── Step 13a: マガジン名（任意）────────────────────────────────
  console.log('\n[Step 13a/16] マガジン名（任意、空欄でスキップ）');
  const magazineNameRaw = (await ask('> ')).trim();
  const magazine_name   = magazineNameRaw || null;

  // ── Step 13b: マガジンID（任意）────────────────────────────────
  console.log('\n[Step 13b/16] マガジンID（任意、空欄でスキップ）');
  const magazineIdRaw = (await ask('> ')).trim();
  const magazine_id   = magazineIdRaw || null;

  // ── Step 14: コメント許可（任意）────────────────────────────────
  console.log('\n[Step 14/16] コメント許可（y=許可 / n=禁止 / 空欄=未設定）');
  const ceRaw = (await ask('> ')).trim().toLowerCase();
  let comments_enabled = null;
  if (ceRaw === 'y') { comments_enabled = true; }
  else if (ceRaw === 'n') { comments_enabled = false; }

  // ── Step 15: 未公開情報を含むか（必須）─────────────────────────
  console.log('\n[Step 15/16] 未公開情報を含みますか？（必須: y または n のみ）');
  console.log('  ※ キャラクター設定・楽曲情報など未公開のものを含む場合は y を入力してください。');
  let contains_unpublished_information = null;
  while (contains_unpublished_information === null) {
    const uiRaw = (await ask('y/n> ')).trim().toLowerCase();
    if (uiRaw === 'y') { contains_unpublished_information = true; }
    else if (uiRaw === 'n') { contains_unpublished_information = false; }
    else { console.log('  y または n を入力してください（空欄は不可）。'); }
  }

  // ── Step 16: 最終確認が必要か（任意、デフォルト: 必要）─────────
  console.log('\n[Step 16/16] 投稿前の最終確認が必要ですか？（y=必要 / n=不要 / 空欄=必要）');
  const rfcRaw = (await ask('> ')).trim().toLowerCase();
  const requires_final_confirmation = rfcRaw === 'n' ? false : true;

  // ── プレビュー表示 ───────────────────────────────────────────────
  console.log('\n' + hr('═'));
  console.log('  【下書きプレビュー】');
  console.log(hr('─'));
  console.log(`  タイトル           : ${title}`);
  console.log(`  記事タイプ         : ${article_type}`);
  console.log(`  リード文           : ${lead !== null ? `${lead.slice(0, 40)}${lead.length > 40 ? '...' : ''}` : '（なし）'}`);
  console.log(`  本文               : ${body.length}文字`);
  console.log(`  見出しメモ         : ${headings.length > 0 ? `${headings.length}件` : '（なし）'}`);
  console.log(`  まとめ             : ${summary !== null ? `${summary.slice(0, 40)}${summary.length > 40 ? '...' : ''}` : '（なし）'}`);
  console.log(`  ハッシュタグ       : ${hashtags.length > 0 ? `${hashtags.length}件` : '（なし）'}`);
  console.log(`  アイキャッチ       : ${eyecatch_path ?? '（未設定）'}`);
  console.log(`  公開予定日時       : ${scheduled_at ?? '（未設定）'}`);
  console.log(`  公開設定           : ${visibility === 'free' ? '無料公開' : '有料記事'}`);
  if (visibility === 'paid') {
    console.log(`  価格               : ${price}円`);
    console.log(`  有料区切りマーカー : ${paid_section_marker ?? '（未設定）'}`);
  }
  console.log(`  マガジン           : ${magazine_name ?? '（未設定）'} / ID: ${magazine_id ?? '（未設定）'}`);
  console.log(`  コメント           : ${comments_enabled === null ? '（未設定）' : comments_enabled ? '許可' : '禁止'}`);
  console.log(`  未公開情報を含む   : ${contains_unpublished_information ? 'はい' : 'いいえ'}`);
  console.log(`  最終確認が必要     : ${requires_final_confirmation ? 'はい' : 'いいえ'}`);
  console.log(hr('─'));

  const confirm = (await ask('この内容で下書きを保存しますか？ (y/N)> ')).trim().toLowerCase();
  rlClose();

  if (!confirm.startsWith('y')) {
    console.log('\nキャンセルしました。\n');
    writeLog(['NOTE_DRAFT', 'platform=note', `visibility=${visibility}`, 'CANCEL']);
    return;
  }

  // ── ID 生成・JSON 構築 ────────────────────────────────────────────
  const id      = genId();
  const created = nowISO();

  const draft = {
    id,
    type:       'note_article',
    platform:   'note',
    status:     'pending',
    created_at: created,
    content: {
      title,
      article_type,
      lead,
      body,
      headings,
      summary,
      hashtags,
      eyecatch_path,
      scheduled_at,
      visibility,
      price,
      paid_section_marker,
      magazine_name,
      magazine_id,
      comments_enabled,
      contains_unpublished_information,
      requires_final_confirmation,
    },
    meta: {
      generated_by: `generate_note_draft.js v${TOOL_VERSION}`,
      preflight: { last_checked_at: null, result: null, warning_count: 0, error_count: 0, checks: [] },
      dry_run:   { last_run_at: null, result: null },
      export:    { last_exported_at: null, format: null, path: null },
    },
  };

  const result = safeWrite(PENDING_DIR, `${id}.json`, draft);
  if (!result.ok) {
    console.error(`\n[エラー] 保存に失敗しました: ${result.reason}\n`);
    writeLog(['NOTE_DRAFT', `id=${id}`, 'platform=note', `visibility=${visibility}`, `scheduled_at=${scheduled_at ?? '未設定'}`, 'FAIL', `reason=${result.reason}`]);
    process.exit(1);
  }

  console.log(`\n✅ note記事下書きを保存しました`);
  console.log(`   ID: ${id}`);
  console.log(`   保存先: drafts/pending/${id}.json\n`);
  writeLog(['NOTE_DRAFT', `id=${id}`, 'platform=note', `visibility=${visibility}`, `scheduled_at=${scheduled_at ?? '未設定'}`, 'SUCCESS']);
}

main().catch(e => {
  console.error(`\n[致命的エラー] ${e.message}\n`);
  process.exit(1);
});
