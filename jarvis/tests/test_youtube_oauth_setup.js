/**
 * jarvis/tests/test_youtube_oauth_setup.js
 * YouTube OAuth セットアップ CLI テストスイート
 *
 * 方針:
 *   - 実 API 呼び出し: なし（fetch をモック）
 *   - 実 DB: 使用しない
 *   - 実ブラウザ: 開かない
 *   - 実 .env ファイル: 書き込まない（一時ファイルのみ）
 *
 * Section 1: PKCE 生成（generateCodeVerifier / generateCodeChallenge / generateState）
 * Section 2: buildAuthUrl — パラメータ検証
 * Section 3: updateEnvContent — 純粋関数テスト
 * Section 4: readEnvFile / readEnvKey
 * Section 5: writeEnvFile — アトミック書き込み
 * Section 6: exchangeCode — fetch モック
 * Section 7: fetchMyChannelId — fetch モック
 * Section 8: セキュリティ定数（REDIRECT_HOST / ENV_PATH / SCOPES）
 */

import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, unlinkSync, existsSync } from 'fs';
import { resolve }                                             from 'path';
import { tmpdir }                                              from 'os';
import { createHash }                                          from 'crypto';

import {
  generateCodeVerifier,
  generateCodeChallenge,
  generateState,
  buildAuthUrl,
  updateEnvContent,
  readEnvFile,
  readEnvKey,
  writeEnvFile,
  exchangeCode,
  fetchMyChannelId,
  SCOPES,
  REDIRECT_HOST,
  ENV_PATH,
} from '../automation/setup_youtube_oauth.js';

// ─── テストユーティリティ ─────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

async function testAsync(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    failed++;
  }
}

// ─── Section 1: PKCE 生成 ────────────────────────────────────────────────────

console.log('\nSection 1: PKCE 生成');

test('generateCodeVerifier: base64url 文字のみ（+/= なし）', () => {
  const v = generateCodeVerifier();
  assert.match(v, /^[A-Za-z0-9\-_]+$/, 'base64url 以外の文字が含まれている');
});

test('generateCodeVerifier: 32 バイト → 43 文字の base64url', () => {
  const v = generateCodeVerifier();
  // 32 bytes → ceil(32/3)*4 = 44 base64 chars → padding 除去で 43
  assert.ok(v.length >= 42 && v.length <= 44, `長さ不正: ${v.length}`);
});

test('generateCodeVerifier: 呼び出しごとに異なる値', () => {
  const a = generateCodeVerifier();
  const b = generateCodeVerifier();
  assert.notEqual(a, b, '同じ値が返された');
});

test('generateCodeChallenge: S256 検証（SHA-256 の base64url）', () => {
  const verifier   = generateCodeVerifier();
  const challenge  = generateCodeChallenge(verifier);
  const expected   = createHash('sha256')
    .update(verifier)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
  assert.equal(challenge, expected);
});

test('generateCodeChallenge: verifier が変われば challenge も変わる', () => {
  const a = generateCodeChallenge(generateCodeVerifier());
  const b = generateCodeChallenge(generateCodeVerifier());
  assert.notEqual(a, b);
});

test('generateState: 非空の base64url 文字列', () => {
  const s = generateState();
  assert.ok(s.length > 0);
  assert.match(s, /^[A-Za-z0-9\-_]+$/);
});

test('generateState: 呼び出しごとに異なる値', () => {
  const a = generateState();
  const b = generateState();
  assert.notEqual(a, b);
});

// ─── Section 2: buildAuthUrl ─────────────────────────────────────────────────

console.log('\nSection 2: buildAuthUrl パラメータ検証');

const SAMPLE_ARGS = {
  clientId:      'test-client-id',
  redirectUri:   'http://127.0.0.1:54321/',
  codeChallenge: 'test_challenge',
  state:         'test_state',
};

test('buildAuthUrl: access_type=offline が含まれる', () => {
  const url = buildAuthUrl(SAMPLE_ARGS);
  assert.ok(url.includes('access_type=offline'), `URL: ${url}`);
});

test('buildAuthUrl: prompt=consent が含まれる（refresh_token 取得保証）', () => {
  const url = buildAuthUrl(SAMPLE_ARGS);
  assert.ok(url.includes('prompt=consent'), `URL: ${url}`);
});

test('buildAuthUrl: code_challenge_method=S256 が含まれる', () => {
  const url = buildAuthUrl(SAMPLE_ARGS);
  assert.ok(url.includes('code_challenge_method=S256'), `URL: ${url}`);
});

test('buildAuthUrl: yt-analytics.readonly スコープが含まれる', () => {
  const url = buildAuthUrl(SAMPLE_ARGS);
  assert.ok(url.includes('yt-analytics.readonly'), `URL: ${url}`);
});

test('buildAuthUrl: youtube.readonly スコープが含まれる', () => {
  const url = buildAuthUrl(SAMPLE_ARGS);
  assert.ok(url.includes('youtube.readonly'), `URL: ${url}`);
});

test('buildAuthUrl: 書き込みスコープ（manage / upload / force-ssl）は含まれない', () => {
  const url = buildAuthUrl(SAMPLE_ARGS);
  assert.ok(!url.includes('youtube%2Fmanage'), 'manage スコープが含まれている');
  assert.ok(!url.includes('upload'), 'upload スコープが含まれている');
  assert.ok(!url.includes('force-ssl'), 'force-ssl スコープが含まれている');
});

test('buildAuthUrl: redirect_uri は引数の値をそのまま使用（8080 固定でない）', () => {
  const url = buildAuthUrl(SAMPLE_ARGS);
  const parsed = new URL(url);
  assert.equal(parsed.searchParams.get('redirect_uri'), 'http://127.0.0.1:54321/');
});

test('buildAuthUrl: redirect_uri に localhost でなく 127.0.0.1 が使われる', () => {
  const url = buildAuthUrl(SAMPLE_ARGS);
  assert.ok(url.includes('127.0.0.1'), '127.0.0.1 が含まれていない');
  const parsed = new URL(url);
  const ruri = parsed.searchParams.get('redirect_uri') ?? '';
  assert.ok(!ruri.includes('localhost'), 'redirect_uri に localhost が含まれている');
});

test('buildAuthUrl: response_type=code が含まれる', () => {
  const url = buildAuthUrl(SAMPLE_ARGS);
  assert.ok(url.includes('response_type=code'), `URL: ${url}`);
});

// ─── Section 3: updateEnvContent ─────────────────────────────────────────────

console.log('\nSection 3: updateEnvContent 純粋関数テスト');

test('updateEnvContent: 既存キーの値を更新する', () => {
  const content = 'YOUTUBE_REFRESH_TOKEN=old_token\nYOUTUBE_CHANNEL_ID=old_id\n';
  const result  = updateEnvContent(content, { YOUTUBE_REFRESH_TOKEN: 'new_token' });
  assert.ok(result.includes('YOUTUBE_REFRESH_TOKEN=new_token'), result);
  assert.ok(!result.includes('old_token'), result);
});

test('updateEnvContent: 存在しないキーは末尾に追加する', () => {
  const content = 'EXISTING_KEY=value\n';
  const result  = updateEnvContent(content, { YOUTUBE_CHANNEL_ID: 'UCabc123' });
  assert.ok(result.includes('YOUTUBE_CHANNEL_ID=UCabc123'), result);
});

test('updateEnvContent: Instagram 設定（他キー）が保持される', () => {
  const content = [
    'INSTAGRAM_APP_ID=123',
    'INSTAGRAM_APP_SECRET=secret',
    'YOUTUBE_REFRESH_TOKEN=old',
  ].join('\n');
  const result = updateEnvContent(content, { YOUTUBE_REFRESH_TOKEN: 'new' });
  assert.ok(result.includes('INSTAGRAM_APP_ID=123'), 'Instagram APP_ID が消えた');
  assert.ok(result.includes('INSTAGRAM_APP_SECRET=secret'), 'Instagram APP_SECRET が消えた');
});

test('updateEnvContent: コメント行が保持される', () => {
  const content = '# YouTube config\nYOUTUBE_REFRESH_TOKEN=old\n';
  const result  = updateEnvContent(content, { YOUTUBE_REFRESH_TOKEN: 'new' });
  assert.ok(result.includes('# YouTube config'), 'コメントが消えた');
});

test('updateEnvContent: 空行が保持される', () => {
  const content = 'KEY_A=val\n\nKEY_B=val\n';
  const result  = updateEnvContent(content, { KEY_A: 'new' });
  assert.ok(result.includes('\n\n'), '空行が消えた');
});

test('updateEnvContent: 複数キーを同時に更新できる', () => {
  const content = 'YOUTUBE_REFRESH_TOKEN=old\nYOUTUBE_CHANNEL_ID=old_id\n';
  const result  = updateEnvContent(content, {
    YOUTUBE_REFRESH_TOKEN: 'new_token',
    YOUTUBE_CHANNEL_ID:    'UCnew',
  });
  assert.ok(result.includes('YOUTUBE_REFRESH_TOKEN=new_token'), result);
  assert.ok(result.includes('YOUTUBE_CHANNEL_ID=UCnew'), result);
});

// ─── Section 4: readEnvFile / readEnvKey ─────────────────────────────────────

console.log('\nSection 4: readEnvFile / readEnvKey');

const TMP_ENV = resolve(tmpdir(), `test_oauth_read_${Date.now()}.env`);

test('readEnvFile: 存在しないファイルは空文字を返す', () => {
  const result = readEnvFile(TMP_ENV + '_nonexistent');
  assert.equal(result, '');
});

test('readEnvKey: 存在するキーの値を返す', () => {
  writeFileSync(TMP_ENV, 'YOUTUBE_REFRESH_TOKEN=abc123\n', 'utf8');
  const val = readEnvKey(TMP_ENV, 'YOUTUBE_REFRESH_TOKEN');
  assert.equal(val, 'abc123');
});

test('readEnvKey: 存在しないキーは空文字を返す', () => {
  writeFileSync(TMP_ENV, 'OTHER_KEY=value\n', 'utf8');
  const val = readEnvKey(TMP_ENV, 'YOUTUBE_REFRESH_TOKEN');
  assert.equal(val, '');
});

// ─── Section 5: writeEnvFile ─────────────────────────────────────────────────

console.log('\nSection 5: writeEnvFile アトミック書き込み');

const TMP_ENV_WRITE = resolve(tmpdir(), `test_oauth_write_${Date.now()}.env`);

test('writeEnvFile: ファイルに内容が書き込まれる', () => {
  const content = 'YOUTUBE_REFRESH_TOKEN=test_token\nYOUTUBE_CHANNEL_ID=UCtest\n';
  writeEnvFile(TMP_ENV_WRITE, content);
  const read = readFileSync(TMP_ENV_WRITE, 'utf8');
  assert.equal(read, content);
});

test('writeEnvFile: 既存内容を上書きできる', () => {
  writeEnvFile(TMP_ENV_WRITE, 'OLD=content\n');
  writeEnvFile(TMP_ENV_WRITE, 'NEW=content\n');
  const read = readFileSync(TMP_ENV_WRITE, 'utf8');
  assert.ok(read.includes('NEW=content'), read);
  assert.ok(!read.includes('OLD=content'), read);
});

// ─── Section 6: exchangeCode — fetch モック ───────────────────────────────────

console.log('\nSection 6: exchangeCode fetch モック');

await testAsync('exchangeCode: POST body に必須パラメータが含まれる', async () => {
  let capturedBody = '';
  const origFetch = global.fetch;
  global.fetch = async (url, opts) => {
    capturedBody = opts.body.toString();
    return {
      ok:   true,
      json: async () => ({ access_token: 'at', refresh_token: 'rt' }),
    };
  };
  try {
    await exchangeCode({
      clientId:     'cid',
      clientSecret: 'csec',
      code:         'auth_code',
      redirectUri:  'http://127.0.0.1:12345/',
      codeVerifier: 'verifier',
    });
  } finally {
    global.fetch = origFetch;
  }
  assert.ok(capturedBody.includes('grant_type=authorization_code'), capturedBody);
  assert.ok(capturedBody.includes('code=auth_code'), capturedBody);
  assert.ok(capturedBody.includes('code_verifier=verifier'), capturedBody);
  assert.ok(capturedBody.includes('redirect_uri='), capturedBody);
});

await testAsync('exchangeCode: redirect_uri は 127.0.0.1 を含む（localhost でない）', async () => {
  let capturedBody = '';
  const origFetch = global.fetch;
  global.fetch = async (url, opts) => {
    capturedBody = opts.body.toString();
    return {
      ok:   true,
      json: async () => ({ access_token: 'at', refresh_token: 'rt' }),
    };
  };
  try {
    await exchangeCode({
      clientId:     'cid',
      clientSecret: 'csec',
      code:         'code',
      redirectUri:  'http://127.0.0.1:54321/',
      codeVerifier: 'cv',
    });
  } finally {
    global.fetch = origFetch;
  }
  assert.ok(capturedBody.includes('127.0.0.1'), capturedBody);
  assert.ok(!capturedBody.includes('localhost'), capturedBody);
});

await testAsync('exchangeCode: HTTP エラー時に Error をスローする', async () => {
  const origFetch = global.fetch;
  global.fetch = async () => ({
    ok:   false,
    status: 401,
    text: async () => 'unauthorized',
  });
  try {
    await assert.rejects(
      () => exchangeCode({ clientId: 'x', clientSecret: 'x', code: 'x', redirectUri: 'x', codeVerifier: 'x' }),
      /Token exchange failed/
    );
  } finally {
    global.fetch = origFetch;
  }
});

// ─── Section 7: fetchMyChannelId — fetch モック ───────────────────────────────

console.log('\nSection 7: fetchMyChannelId fetch モック');

await testAsync('fetchMyChannelId: items[0].id を返す', async () => {
  const origFetch = global.fetch;
  global.fetch = async () => ({
    ok:   true,
    json: async () => ({ items: [{ id: 'UCabc123def' }] }),
  });
  try {
    const id = await fetchMyChannelId('dummy_token');
    assert.equal(id, 'UCabc123def');
  } finally {
    global.fetch = origFetch;
  }
});

await testAsync('fetchMyChannelId: チャンネルが 0 件のとき Error をスローする', async () => {
  const origFetch = global.fetch;
  global.fetch = async () => ({
    ok:   true,
    json: async () => ({ items: [] }),
  });
  try {
    await assert.rejects(
      () => fetchMyChannelId('dummy_token'),
      /Channel ID が見つかりません/
    );
  } finally {
    global.fetch = origFetch;
  }
});

await testAsync('fetchMyChannelId: mine=true で呼び出される', async () => {
  let capturedUrl = '';
  const origFetch = global.fetch;
  global.fetch = async (url) => {
    capturedUrl = url;
    return {
      ok:   true,
      json: async () => ({ items: [{ id: 'UC_test' }] }),
    };
  };
  try {
    await fetchMyChannelId('token');
  } finally {
    global.fetch = origFetch;
  }
  assert.ok(capturedUrl.includes('mine=true'), `URL: ${capturedUrl}`);
});

await testAsync('fetchMyChannelId: HTTP エラー時に Error をスローする', async () => {
  const origFetch = global.fetch;
  global.fetch = async () => ({
    ok:     false,
    status: 403,
    text:   async () => 'forbidden',
  });
  try {
    await assert.rejects(
      () => fetchMyChannelId('bad_token'),
      /channels\.list failed/
    );
  } finally {
    global.fetch = origFetch;
  }
});

// ─── Section 8: セキュリティ定数 ─────────────────────────────────────────────

console.log('\nSection 8: セキュリティ定数');

test('REDIRECT_HOST が 127.0.0.1 である（localhost でない）', () => {
  assert.equal(REDIRECT_HOST, '127.0.0.1');
});

test('SCOPES に書き込み系スコープが含まれない（read-only 最小限）', () => {
  for (const scope of SCOPES) {
    assert.ok(!scope.includes('manage'), `管理スコープが含まれている: ${scope}`);
    assert.ok(!scope.includes('upload'), `upload スコープが含まれている: ${scope}`);
    assert.ok(scope.includes('readonly'), `readonly でないスコープ: ${scope}`);
  }
});

test('SCOPES が yt-analytics.readonly を含む', () => {
  assert.ok(SCOPES.some(s => s.includes('yt-analytics.readonly')));
});

test('SCOPES が youtube.readonly を含む', () => {
  assert.ok(SCOPES.some(s => s.includes('youtube.readonly')));
});

test('ENV_PATH が jarvis/.env を指す（tmpdir でない）', () => {
  assert.ok(ENV_PATH.includes('jarvis'), `ENV_PATH: ${ENV_PATH}`);
  assert.ok(ENV_PATH.endsWith('.env'), `ENV_PATH: ${ENV_PATH}`);
  assert.ok(!ENV_PATH.includes(tmpdir()), `ENV_PATH が tmpdir を指している: ${ENV_PATH}`);
});

// ─── クリーンアップ ───────────────────────────────────────────────────────────

for (const f of [TMP_ENV, TMP_ENV_WRITE]) {
  if (existsSync(f)) {
    try { unlinkSync(f); } catch { /* ignore */ }
  }
}

// ─── 結果 ─────────────────────────────────────────────────────────────────────

console.log('');
console.log('================================================');
console.log(` テスト完了: ${passed} passed / ${failed} failed`);
console.log('================================================');

if (failed > 0) process.exit(1);
