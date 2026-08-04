#!/usr/bin/env node
/**
 * Snow flakes JARVIS - 下書き管理ツール
 * manage_drafts.js v0.1.0
 *
 * 使用方法（jarvis/ ディレクトリから実行）:
 *   npm run list
 *   npm run show    -- <draft-id>
 *   npm run approve -- <draft-id>
 *   npm run reject  -- <draft-id>
 *   npm run publish -- <draft-id>
 *
 * 方針:
 *   - Node.js 標準機能のみ使用（外部パッケージなし）
 *   - 外部通信・SNS投稿・git操作なし
 *   - 元ファイルを誤って上書きしない
 *   - 移動先に同名ファイルが存在する場合は処理を中止
 *   - JSON破損時は処理を中止
 *   - ログに投稿本文・差し戻し理由本文・個人情報・秘密情報を記録しない
 */

import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { fileURLToPath } from 'url';

// ── パス設定 ─────────────────────────────────────────────────────
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const JARVIS_ROOT   = path.resolve(__dirname, '..');
const PENDING_DIR   = path.join(JARVIS_ROOT, 'drafts', 'pending');
const APPROVED_DIR  = path.join(JARVIS_ROOT, 'drafts', 'approved');
const PUBLISHED_DIR = path.join(JARVIS_ROOT, 'drafts', 'published');
const LOG_DIR  = path.join(JARVIS_ROOT, 'logs');
const LOG_PATH = path.join(LOG_DIR, 'history.log');

const TOOL_VERSION = '0.1.0';

// ID形式: draft_YYYYMMDD_xxxxxx（x は 16進数 6 文字）
const VALID_ID_RE = /^draft_\d{8}_[0-9a-f]{6}$/;

// ── 時刻ユーティリティ ───────────────────────────────────────────

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
  const local = new Date(d.getTime() + 9 * 60 * 60 * 1000);
  return local.toISOString().slice(0, 19) + '+09:00';
}

// ── ID 検証（パストラバーサル防止）──────────────────────────────

function validateId(id) {
  if (!id) {
    return { ok: false, reason: 'IDが指定されていません' };
  }
  if (typeof id !== 'string') {
    return { ok: false, reason: 'IDは文字列で指定してください' };
  }
  if (!VALID_ID_RE.test(id)) {
    return {
      ok: false,
      reason: `不正なID形式です: "${id}"\n   有効な形式: draft_YYYYMMDD_xxxxxx（例: draft_20260804_a1b2c3）`,
    };
  }
  return { ok: true };
}

// ── ログ ──────────────────────────────────────────────────────────
// 記録する内容: 日時・操作種別・ID・from・to・成否・失敗理由
// 記録しない内容: 投稿本文・差し戻し理由本文・個人情報・秘密情報

function writeLog(parts) {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    const line = `[${nowJST()}] ${parts.join(' | ')}\n`;
    fs.appendFileSync(LOG_PATH, line, 'utf-8');
  } catch {
    // ログ書き込み失敗は処理を止めない
  }
}

// ── 表示ユーティリティ ─────────────────────────────────────────

function hr(char = '─', width = 60) {
  return char.repeat(width);
}

function printHeader(title) {
  console.log('\n' + hr('═'));
  console.log(`  ${title}`);
  console.log(hr('─'));
}

function printFooter() {
  console.log(hr('═') + '\n');
}

// ── ファイル操作 ───────────────────────────────────────────────

/**
 * ファイルを読み込み、JSONパースして返す。
 * 存在しない・破損している場合は { ok: false, reason } を返す。
 */
function readDraftFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return { ok: false, reason: 'ファイルが見つかりません' };
  }
  let raw;
  try {
    raw = fs.readFileSync(filePath, 'utf-8');
  } catch (e) {
    return { ok: false, reason: `読み込みエラー: ${e.message}` };
  }
  try {
    const data = JSON.parse(raw);
    return { ok: true, data };
  } catch {
    return { ok: false, reason: 'JSONが破損しています。手動で確認してください。' };
  }
}

/**
 * 安全な書き込み: 一時ファイル(.tmp)へ書いて検証し、成功時のみリネーム。
 * 失敗時は .tmp を削除し、既存ファイルを変更しない。
 */
function safeWrite(dir, filename, data) {
  const finalPath = path.join(dir, filename);
  const tmpPath   = path.join(dir, filename + '.tmp');

  const cleanup = () => {
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch {}
  };

  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    // ① .tmp へ書き込む
    fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2), 'utf-8');

    // ② 読み返して JSON パース確認（破損検証）
    const verify = fs.readFileSync(tmpPath, 'utf-8');
    JSON.parse(verify);

    // ③ 成功: .tmp → 正式ファイル名へリネーム
    fs.renameSync(tmpPath, finalPath);
    return { ok: true };
  } catch (e) {
    cleanup();
    return { ok: false, reason: e.message };
  }
}

/**
 * 安全なファイル移動: 移動先へ safeWrite 後、移動元を削除。
 * いずれかのステップが失敗しても元ファイルを保護する。
 */
function safeMove(srcPath, destDir, filename, data) {
  const result = safeWrite(destDir, filename, data);
  if (!result.ok) return result;

  try {
    fs.unlinkSync(srcPath);
    return { ok: true };
  } catch (e) {
    // 移動先への書き込みは完了しているが移動元の削除に失敗
    return {
      ok: false,
      reason: `移動先への保存は完了しましたが、移動元の削除に失敗しました。手動で確認してください: ${e.message}`,
    };
  }
}

// ── コマンド: list ────────────────────────────────────────────────

function cmdList() {
  printHeader('Snow flakes JARVIS - 承認待ち下書き一覧');

  if (!fs.existsSync(PENDING_DIR)) {
    console.log('  pending フォルダが見つかりません。');
    printFooter();
    return;
  }

  // .json ファイルのみ取得（.tmp・.gitkeep を除外）
  const files = fs.readdirSync(PENDING_DIR)
    .filter(f => f.endsWith('.json') && f !== '.gitkeep');

  if (files.length === 0) {
    console.log('  承認待ちの下書きはありません。');
    printFooter();
    return;
  }

  const drafts = [];
  const broken = [];

  files.forEach(f => {
    const result = readDraftFile(path.join(PENDING_DIR, f));
    if (result.ok) {
      drafts.push(result.data);
    } else {
      broken.push({ file: f, reason: result.reason });
    }
  });

  if (drafts.length > 0) {
    const COL = '  No.  ID                          種別               ステータス  作成日時';
    console.log(COL);
    console.log('  ' + hr('─', 76));
    drafts.forEach((d, i) => {
      const no   = String(i + 1).padStart(3);
      const id   = (d.id   || '（不明）').padEnd(27);
      const type = (d.type || '不明'   ).padEnd(18);
      const stat = (d.status || '不明' ).padEnd(10);
      const date = d.created_at
        ? d.created_at.slice(0, 16).replace('T', ' ')
        : '不明';
      console.log(`  ${no}. ${id} ${type} ${stat} ${date}`);
    });
  }

  if (broken.length > 0) {
    console.log('\n  ⚠️  読み込みに失敗したファイル:');
    broken.forEach(b => console.log(`    - ${b.file}: ${b.reason}`));
  }

  console.log('\n  ' + hr('─', 76));
  console.log(`  計 ${drafts.length} 件（破損: ${broken.length} 件）`);
  printFooter();
}

// ── コマンド: show ────────────────────────────────────────────────

function cmdShow(id) {
  const validation = validateId(id);
  if (!validation.ok) {
    console.error(`\n[エラー] ${validation.reason}\n`);
    process.exit(1);
  }

  const filename = `${id}.json`;

  // pending → approved → published の順で検索
  const locations = [
    { dir: PENDING_DIR,   label: 'pending' },
    { dir: APPROVED_DIR,  label: 'approved' },
    { dir: PUBLISHED_DIR, label: 'published' },
  ];

  let draft = null;
  let location = '';

  for (const { dir, label } of locations) {
    const filePath = path.join(dir, filename);
    if (fs.existsSync(filePath)) {
      const result = readDraftFile(filePath);
      if (!result.ok) {
        console.error(`\n[エラー] ${result.reason}（場所: ${label}/${filename}）\n`);
        process.exit(1);
      }
      draft    = result.data;
      location = label;
      break;
    }
  }

  if (!draft) {
    console.error(`\n[エラー] 指定されたIDが見つかりません: ${id}\n`);
    process.exit(1);
  }

  const show = (label, value) => {
    const v = (value !== undefined && value !== null)
      ? (Array.isArray(value)
        ? (value.length ? value.join(', ') : '（なし）')
        : String(value))
      : '（未設定）';
    console.log(`  ${label.padEnd(20)}: ${v}`);
  };

  printHeader(`Snow flakes JARVIS - 下書き詳細 [${location}]`);
  show('保存場所', location);
  show('ID', draft.id);
  show('種別', draft.type);
  show('ステータス', draft.status);
  show('作成日時', draft.created_at);
  if (draft.approved_at)       show('承認日時', draft.approved_at);
  if (draft.rejected_at)       show('差し戻し日時', draft.rejected_at);
  if (draft.rejection_reason)  show('差し戻し理由', draft.rejection_reason);
  if (draft.published_at)      show('公開記録日時', draft.published_at);

  const c = draft.content || {};
  const contentEntries = Object.entries(c).filter(([k]) => !k.startsWith('_'));
  if (contentEntries.length > 0) {
    console.log('\n  【内容】');
    contentEntries.forEach(([k, v]) => {
      const val = Array.isArray(v)
        ? (v.length ? v.join(', ') : '（なし）')
        : (v !== null && v !== undefined ? String(v) : '（未設定）');
      console.log(`    ${k.padEnd(18)}: ${val}`);
    });
  }

  if (c._note) {
    console.log(`\n  ⚠️  ${c._note}`);
  }

  if (draft.meta?.generated_by) {
    console.log('\n  【メタ情報】');
    show('生成ツール', draft.meta.generated_by);
  }

  printFooter();
}

// ── コマンド: approve ─────────────────────────────────────────────

async function cmdApprove(id) {
  const validation = validateId(id);
  if (!validation.ok) {
    console.error(`\n[エラー] ${validation.reason}\n`);
    process.exit(1);
  }

  const filename = `${id}.json`;
  const srcPath  = path.join(PENDING_DIR,  filename);
  const destPath = path.join(APPROVED_DIR, filename);

  // 1. 移動元の読み込み・JSON検証
  const readResult = readDraftFile(srcPath);
  if (!readResult.ok) {
    const reason = fs.existsSync(srcPath)
      ? readResult.reason
      : 'pending 内に指定のIDが見つかりません';
    console.error(`\n[エラー] ${reason}\n`);
    writeLog(['APPROVE', `id=${id}`, 'from=pending', 'FAIL', `reason=${reason}`]);
    process.exit(1);
  }

  const draft = readResult.data;

  // 2. ステータス確認
  if (draft.status !== 'pending') {
    const reason = `承認できる状態ではありません（現在のステータス: ${draft.status}）`;
    console.error(`\n[エラー] ${reason}\n`);
    writeLog(['APPROVE', `id=${id}`, 'from=pending', 'FAIL', `reason=${reason}`]);
    process.exit(1);
  }

  // 3. 移動先の重複確認
  if (fs.existsSync(destPath)) {
    const reason = '移動先（approved）に同名ファイルが既に存在します。処理を中止します。';
    console.error(`\n[エラー] ${reason}\n`);
    writeLog(['APPROVE', `id=${id}`, 'from=pending', 'to=approved', 'FAIL', `reason=${reason}`]);
    process.exit(1);
  }

  // 4. 更新データ作成（id は変更しない）
  const updated = {
    ...draft,
    status: 'approved',
    approved_at: nowISO(),
  };
  // 差し戻し履歴があれば除去（承認でリセット）
  delete updated.rejected_at;
  delete updated.rejection_reason;

  // 5. 安全な移動
  const moveResult = safeMove(srcPath, APPROVED_DIR, filename, updated);
  if (!moveResult.ok) {
    console.error(`\n[エラー] 保存に失敗しました: ${moveResult.reason}\n`);
    writeLog(['APPROVE', `id=${id}`, 'from=pending', 'to=approved', 'FAIL', `reason=${moveResult.reason}`]);
    process.exit(1);
  }

  console.log(`\n✅ 承認しました: ${id}`);
  console.log(`   pending → approved\n`);
  writeLog(['APPROVE', `id=${id}`, 'from=pending', 'to=approved', 'SUCCESS']);
}

// ── コマンド: reject ─────────────────────────────────────────────

async function cmdReject(id) {
  const validation = validateId(id);
  if (!validation.ok) {
    console.error(`\n[エラー] ${validation.reason}\n`);
    process.exit(1);
  }

  const filename = `${id}.json`;
  const srcPath  = path.join(PENDING_DIR, filename);

  // 1. ファイル確認・JSON検証
  const readResult = readDraftFile(srcPath);
  if (!readResult.ok) {
    const reason = fs.existsSync(srcPath)
      ? readResult.reason
      : 'pending 内に指定のIDが見つかりません';
    console.error(`\n[エラー] ${reason}\n`);
    writeLog(['REJECT', `id=${id}`, 'from=pending', 'FAIL', `reason=${reason}`]);
    process.exit(1);
  }

  const draft = readResult.data;

  // 2. ステータス確認（pending または rejected のみ差し戻し可）
  if (!['pending', 'rejected'].includes(draft.status)) {
    const reason = `差し戻しできない状態です（現在のステータス: ${draft.status}）`;
    console.error(`\n[エラー] ${reason}\n`);
    writeLog(['REJECT', `id=${id}`, 'from=pending', 'FAIL', `reason=${reason}`]);
    process.exit(1);
  }

  // 3. 差し戻し理由の入力（本文はログに記録しない）
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const reason = await new Promise(resolve => {
    rl.question('\n差し戻し理由を入力してください（必須）> ', resolve);
  });
  rl.close();

  if (!reason.trim()) {
    console.error('\n[エラー] 差し戻し理由は必須です。処理を中止します。\n');
    writeLog(['REJECT', `id=${id}`, 'from=pending', 'FAIL', 'reason=理由未入力']);
    process.exit(1);
  }

  // 4. 更新データ作成（id は変更しない・rejection_reason はファイルのみ保存）
  const updated = {
    ...draft,
    status: 'rejected',
    rejected_at: nowISO(),
    rejection_reason: reason.trim(),
  };

  // 5. 安全な書き込み（pending 内でインプレース更新）
  const writeResult = safeWrite(PENDING_DIR, filename, updated);
  if (!writeResult.ok) {
    console.error(`\n[エラー] 保存に失敗しました: ${writeResult.reason}\n`);
    writeLog(['REJECT', `id=${id}`, 'from=pending', 'FAIL', `reason=${writeResult.reason}`]);
    process.exit(1);
  }

  console.log(`\n✅ 差し戻しました: ${id}`);
  console.log(`   ステータス: rejected（pending 内に留まります）\n`);
  // 差し戻し理由の本文はログに記録しない
  writeLog(['REJECT', `id=${id}`, 'from=pending', 'reason=入力済み', 'SUCCESS']);
}

// ── コマンド: publish ─────────────────────────────────────────────

async function cmdPublish(id) {
  const validation = validateId(id);
  if (!validation.ok) {
    console.error(`\n[エラー] ${validation.reason}\n`);
    process.exit(1);
  }

  const filename = `${id}.json`;
  const srcPath  = path.join(APPROVED_DIR,  filename);
  const destPath = path.join(PUBLISHED_DIR, filename);

  // 1. ファイル確認・JSON検証
  const readResult = readDraftFile(srcPath);
  if (!readResult.ok) {
    const reason = fs.existsSync(srcPath)
      ? readResult.reason
      : 'approved 内に指定のIDが見つかりません';
    console.error(`\n[エラー] ${reason}\n`);
    writeLog(['PUBLISH', `id=${id}`, 'from=approved', 'FAIL', `reason=${reason}`]);
    process.exit(1);
  }

  const draft = readResult.data;

  // 2. ステータス確認
  if (draft.status !== 'approved') {
    const reason = `公開記録できる状態ではありません（現在のステータス: ${draft.status}）`;
    console.error(`\n[エラー] ${reason}\n`);
    writeLog(['PUBLISH', `id=${id}`, 'from=approved', 'FAIL', `reason=${reason}`]);
    process.exit(1);
  }

  // 3. 移動先の重複確認
  if (fs.existsSync(destPath)) {
    const reason = '移動先（published）に同名ファイルが既に存在します。処理を中止します。';
    console.error(`\n[エラー] ${reason}\n`);
    writeLog(['PUBLISH', `id=${id}`, 'from=approved', 'to=published', 'FAIL', `reason=${reason}`]);
    process.exit(1);
  }

  // 4. 更新データ作成（id は変更しない）
  const updated = {
    ...draft,
    status: 'published',
    published_at: nowISO(),
  };

  // 5. 安全な移動
  const moveResult = safeMove(srcPath, PUBLISHED_DIR, filename, updated);
  if (!moveResult.ok) {
    console.error(`\n[エラー] 保存に失敗しました: ${moveResult.reason}\n`);
    writeLog(['PUBLISH', `id=${id}`, 'from=approved', 'to=published', 'FAIL', `reason=${moveResult.reason}`]);
    process.exit(1);
  }

  console.log(`\n✅ 公開済みとして記録しました: ${id}`);
  console.log(`   approved → published\n`);
  writeLog(['PUBLISH', `id=${id}`, 'from=approved', 'to=published', 'SUCCESS']);
}

// ── エントリーポイント ────────────────────────────────────────────

const args    = process.argv.slice(2);
const command = args[0];
const draftId = args[1];

switch (command) {
  case 'list':
    cmdList();
    break;
  case 'show':
    cmdShow(draftId);
    break;
  case 'approve':
    await cmdApprove(draftId);
    break;
  case 'reject':
    await cmdReject(draftId);
    break;
  case 'publish':
    await cmdPublish(draftId);
    break;
  default:
    console.error(`\n[エラー] 不明なコマンドです: ${command || '（未指定）'}`);
    console.error('使用可能なコマンド: list / show / approve / reject / publish\n');
    process.exit(1);
}
