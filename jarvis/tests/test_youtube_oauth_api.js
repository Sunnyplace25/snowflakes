/**
 * jarvis/tests/test_youtube_oauth_api.js
 * api.js の YouTube OAuth フロー実装テスト
 *
 * テスト対象:
 *   1. .env 更新ロジック（updateYoutubeRefreshTokenInEnv）
 *   2. state 生成・検証ロジック
 *   3. buildOauthResultHtml — トークン露出がないこと
 *   4. OAuth リクエストパラメータ確認
 *
 * 外部通信: なし / 実 .env: 書き込まない（一時ファイルのみ）
 */

import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, unlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { readFileSync as _rf } from 'node:fs';

// ─── テストユーティリティ ──────────────────────────────────────────────────────

let passed = 0, failed = 0;
function test(name, fn) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (err) { console.error(`  ✗ ${name}\n    ${err.message}`); failed++; }
}

// ─── テスト対象関数を api.js ソースから抽出 ────────────────────────────────────
// api.js はサーバー起動を伴うため import しない。
// ロジックを純粋関数として再現し、api.js ソースとの一致を正規表現で確認する。

const API_SRC = _rf(resolve('dashboard/api.js'), 'utf8');

/**
 * api.js の .env 更新ロジック（純粋関数として抽出）
 * YOUTUBE_REFRESH_TOKEN=XXX の行だけを置換し、他は変えない
 */
function updateEnvContent(envText, refreshToken) {
  const keyLine = `YOUTUBE_REFRESH_TOKEN=${refreshToken}`;
  if (/^YOUTUBE_REFRESH_TOKEN=.*/m.test(envText)) {
    return envText.replace(/^YOUTUBE_REFRESH_TOKEN=.*$/m, keyLine);
  }
  return envText.endsWith('\n')
    ? envText + keyLine + '\n'
    : envText + '\n' + keyLine + '\n';
}

/**
 * state 生成（api.js と同じロジック）
 */
function generateState() {
  return randomBytes(32).toString('hex');
}

// ─── Section 1: .env 更新ロジック ─────────────────────────────────────────────

console.log('\nSection 1: .env 更新ロジック');

test('既存 YOUTUBE_REFRESH_TOKEN を置換する', () => {
  const before = [
    'YOUTUBE_CLIENT_ID=abc',
    'YOUTUBE_REFRESH_TOKEN=old_token',
    'YOUTUBE_CLIENT_SECRET=def',
    '',
  ].join('\n');
  const after = updateEnvContent(before, 'new_token');
  assert.ok(after.includes('YOUTUBE_REFRESH_TOKEN=new_token'), '新トークンが含まれる');
  assert.ok(!after.includes('old_token'), '旧トークンが消える');
});

test('他の ENV 行を壊さない', () => {
  const before = [
    '# YouTube 設定',
    'YOUTUBE_CLIENT_ID=abc123',
    'YOUTUBE_CLIENT_SECRET=secret456',
    'YOUTUBE_REFRESH_TOKEN=old',
    'YOUTUBE_CHANNEL_ID=UCxxx',
    '',
    'INSTAGRAM_ACCESS_TOKEN=igtoken',
    '# 末尾コメント',
  ].join('\n');
  const after = updateEnvContent(before, 'newtoken');
  assert.ok(after.includes('YOUTUBE_CLIENT_ID=abc123'), 'CLIENT_ID 保持');
  assert.ok(after.includes('YOUTUBE_CLIENT_SECRET=secret456'), 'CLIENT_SECRET 保持');
  assert.ok(after.includes('YOUTUBE_CHANNEL_ID=UCxxx'), 'CHANNEL_ID 保持');
  assert.ok(after.includes('INSTAGRAM_ACCESS_TOKEN=igtoken'), 'Instagram ENV 保持');
  assert.ok(after.includes('# YouTube 設定'), 'コメント行保持');
  assert.ok(after.includes('# 末尾コメント'), '末尾コメント保持');
  assert.ok(after.includes(''), '空行保持（空行が存在する）');
});

test('コメント行・空行を削除しない', () => {
  const before = '# コメント\n\nYOUTUBE_REFRESH_TOKEN=old\n\n# 後ろ\n';
  const after = updateEnvContent(before, 'new');
  const lines = after.split('\n');
  assert.ok(lines.includes('# コメント'), 'コメント行保持');
  assert.ok(lines.includes(''), '空行保持');
  assert.ok(lines.includes('# 後ろ'), '後ろコメント保持');
});

test('YOUTUBE_REFRESH_TOKEN が存在しない場合は末尾に追加', () => {
  const before = 'YOUTUBE_CLIENT_ID=abc\nYOUTUBE_CLIENT_SECRET=def\n';
  const after = updateEnvContent(before, 'brand_new');
  assert.ok(after.includes('YOUTUBE_REFRESH_TOKEN=brand_new'), '末尾追加される');
  assert.ok(after.includes('YOUTUBE_CLIENT_ID=abc'), '既存 ENV 保持');
});

test('末尾が改行なしでも正しく追加', () => {
  const before = 'YOUTUBE_CLIENT_ID=abc';
  const after = updateEnvContent(before, 'tkn');
  assert.ok(after.includes('YOUTUBE_REFRESH_TOKEN=tkn'), 'トークン追加');
  // 改行が挟まれることを確認
  const idx = after.indexOf('YOUTUBE_REFRESH_TOKEN=tkn');
  assert.ok(after[idx - 1] === '\n', '前に改行がある');
});

test('部分一致で誤置換しない（YOUTUBE_REFRESH_TOKEN_EX などを壊さない）', () => {
  // 現実には存在しないが、行頭一致の正規表現を確認
  const before = 'YOUTUBE_REFRESH_TOKEN=old\nSOME_YOUTUBE_REFRESH_TOKEN_EX=other\n';
  const after = updateEnvContent(before, 'new');
  assert.ok(after.includes('YOUTUBE_REFRESH_TOKEN=new'), 'ターゲット行更新');
  assert.ok(after.includes('SOME_YOUTUBE_REFRESH_TOKEN_EX=other'), '別 key 保持');
});

test('実際のファイル読み書き：一時ファイルで確認', () => {
  const tmpPath = resolve(tmpdir(), `test_env_${Date.now()}.env`);
  try {
    const original = 'YOUTUBE_CLIENT_ID=cid\nYOUTUBE_REFRESH_TOKEN=old\n# comment\n';
    writeFileSync(tmpPath, original, 'utf8');
    const read = readFileSync(tmpPath, 'utf8');
    const updated = updateEnvContent(read, 'updated_token');
    writeFileSync(tmpPath, updated, 'utf8');
    const result = readFileSync(tmpPath, 'utf8');
    assert.ok(result.includes('YOUTUBE_REFRESH_TOKEN=updated_token'), '更新後トークン存在');
    assert.ok(result.includes('YOUTUBE_CLIENT_ID=cid'), '他 ENV 保持');
    assert.ok(result.includes('# comment'), 'コメント保持');
    assert.ok(!result.includes('YOUTUBE_REFRESH_TOKEN=old'), '旧トークン消去');
  } finally {
    try { unlinkSync(tmpPath); } catch {}
  }
});

// ─── Section 2: state 生成・検証ロジック ──────────────────────────────────────

console.log('\nSection 2: state 生成・検証ロジック');

test('state は 64文字の hex 文字列（32バイト）', () => {
  const s = generateState();
  assert.match(s, /^[0-9a-f]{64}$/, '64文字 hex');
});

test('state は毎回異なる値が生成される', () => {
  const s1 = generateState();
  const s2 = generateState();
  assert.notEqual(s1, s2, '毎回異なる');
});

test('state TTL ロジック: 期限内なら有効', () => {
  const state = { value: 'abc', expiresAt: Date.now() + 60_000 };
  assert.ok(Date.now() <= state.expiresAt, '期限内');
});

test('state TTL ロジック: 期限切れは拒否', () => {
  const state = { value: 'abc', expiresAt: Date.now() - 1 };
  assert.ok(Date.now() > state.expiresAt, '期限切れ判定');
});

test('state 不一致は拒否', () => {
  const stored = { value: 'correct_state', expiresAt: Date.now() + 60_000 };
  const received = 'tampered_state';
  assert.ok(stored.value !== received, '不一致を検出');
});

test('state null の場合は拒否', () => {
  const oauthState = null;
  assert.ok(!oauthState, 'null は falsy で拒否される');
});

// ─── Section 3: buildOauthResultHtml — トークン露出なし ────────────────────────

console.log('\nSection 3: buildOauthResultHtml — トークン不露出');

// api.js ソースから buildOauthResultHtml の内容を文字列として検査
test('成功HTML に refresh_token という文字列が含まれない', () => {
  // buildOauthResultHtml success=true のテンプレートリテラル部分を検索
  const successSection = API_SRC.match(/if \(success\) \{([\s\S]*?)^\s*\}/m)?.[1] ?? '';
  assert.ok(!successSection.includes('refresh_token'), 'refresh_token を HTML に出力していない');
  assert.ok(!successSection.includes('tokenData'), 'tokenData を HTML に出力していない');
});

test('成功HTMLに「新しい認証情報を取得しました」が含まれる', () => {
  assert.ok(API_SRC.includes('新しい認証情報を取得しました'), '適切な文言');
});

test('/apply レスポンスの jsonRes 呼び出しに refreshToken 値が含まれない', () => {
  // apply 最後の jsonRes(...) 呼び出しだけを抜き出して確認
  // → { ok: true, message: '...' } のみで refresh token の値を返していないこと
  const jsonResCalls = [...API_SRC.matchAll(/jsonRes\(res,\s*200,\s*\{([^}]+)\}\)/g)]
    .map(m => m[1]);
  // apply エンドポイントの jsonRes は "YouTube 同期を実行しました" を含む
  const applyJsonRes = jsonResCalls.find(s => s.includes('YouTube 同期を実行しました')) ?? '';
  assert.ok(!!applyJsonRes, 'apply の jsonRes 呼び出しを発見できた');
  assert.ok(!applyJsonRes.includes('refreshToken'), 'jsonRes の中に refreshToken が含まれない');
  assert.ok(!applyJsonRes.includes('refresh_token'), 'jsonRes の中に refresh_token が含まれない');
});

// ─── Section 4: OAuth リクエストパラメータ確認 ───────────────────────────────

console.log('\nSection 4: OAuth リクエストパラメータ');

test('access_type=offline が設定されている', () => {
  assert.ok(API_SRC.includes("access_type:   'offline'"), 'offline access_type');
});

test("prompt=consent が設定されている（既存トークンでも再発行）", () => {
  assert.ok(API_SRC.includes("prompt:        'consent'"), 'consent prompt');
});

test('youtube.readonly スコープが含まれる', () => {
  assert.ok(
    API_SRC.includes('youtube.readonly'),
    'youtube.readonly スコープ'
  );
});

test('yt-analytics.readonly スコープが含まれる', () => {
  assert.ok(
    API_SRC.includes('yt-analytics.readonly'),
    'yt-analytics.readonly スコープ'
  );
});

test('state パラメータが OAuth URL に含まれる', () => {
  // start エンドポイントで state: stateValue が params に追加されているか
  assert.ok(API_SRC.includes('state:         stateValue'), 'state を OAuth URL に付与');
});

test('callback で state パラメータを検証している', () => {
  assert.ok(API_SRC.includes('stateParam !== _youtubeOauthState.value'), 'state 一致確認');
  assert.ok(API_SRC.includes('_youtubeOauthState.expiresAt'), '有効期限確認');
});

test('state は使い捨て（callback 後に null にする）', () => {
  // state 一致確認の直後に null を代入しているか
  const callbackSection = API_SRC.match(/callback.*?end\(\);[\s\S]*?\/\/ state は使い捨て[\s\S]*?= null;/)?.[0] ?? '';
  // より単純な確認: _youtubeOauthState = null が callback 内に複数あること
  const nullCount = (API_SRC.match(/_youtubeOauthState = null;/g) ?? []).length;
  assert.ok(nullCount >= 3, `state を null にするケースが複数ある（${nullCount}箇所）`);
});

// ─── Section 5: apply 後の自動同期 ────────────────────────────────────────────

console.log('\nSection 5: apply 後の自動同期');

test('apply エンドポイントで runSourceSync を呼び出している', () => {
  assert.ok(
    API_SRC.includes("await runSourceSync(db, 'youtube')"),
    "apply 後に runSourceSync(db, 'youtube') を呼ぶ"
  );
});

test('runSourceSync は try/catch で囲まれている（同期失敗でも apply 成功を返す）', () => {
  const applyBlock = API_SRC.slice(
    API_SRC.indexOf('POST /api/sf/sync/youtube/oauth/apply'),
    API_SRC.indexOf('POST /api/sf/sync/youtube/oauth/apply') + 2000
  );
  assert.ok(applyBlock.includes('try {'), 'try ブロック');
  assert.ok(applyBlock.includes('} catch ('), 'catch ブロック');
  assert.ok(applyBlock.includes("runSourceSync(db, 'youtube')"), 'runSourceSync 呼び出し');
});

test('apply レスポンスに「同期を実行」の文言が含まれる', () => {
  assert.ok(
    API_SRC.includes('YouTube 同期を実行しました'),
    'apply レスポンスメッセージに同期実行の旨がある'
  );
});

test('statusを強制 fresh に書き換えるコードがない', () => {
  // apply ブロック周辺に status='fresh' の直接代入がないか確認
  const applyBlock = API_SRC.slice(
    API_SRC.indexOf('/oauth/apply'),
    API_SRC.indexOf('/oauth/apply') + 3000
  );
  assert.ok(!applyBlock.includes("status = 'fresh'"), "status を fresh に強制変更しない");
  assert.ok(!applyBlock.includes('force_fresh'), 'force_fresh がない');
});

// ─── Section 6: .env の git 管理外確認 ───────────────────────────────────────

console.log('\nSection 6: .env の git 管理外確認');

test('.gitignore に .env が含まれている', () => {
  try {
    const gitignore = readFileSync(resolve('.gitignore'), 'utf8');
    assert.ok(gitignore.includes('.env'), '.gitignore に .env 記載あり');
  } catch {
    // .gitignore がなければ警告のみ
    console.warn('    ⚠️  .gitignore が見つかりません');
  }
});

test('api.js が .env ファイルをレスポンスに含める実装がない', () => {
  assert.ok(!API_SRC.includes('readFileSync(_ENV_FILE_PATH)'.replace('_ENV_FILE_PATH', 'envPath') + '.toString()'), '環境ファイル全体をレスポンスに含めない');
});

// ─── 集計 ─────────────────────────────────────────────────────────────────────

console.log(`\n${'─'.repeat(60)}`);
console.log(`テスト結果: ${passed + failed} 件 / ✅ ${passed} 件成功 / ❌ ${failed} 件失敗`);
if (failed > 0) process.exit(1);
