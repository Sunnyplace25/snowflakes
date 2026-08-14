/**
 * jarvis/automation/setup_youtube_oauth.js
 * YouTube OAuth 2.0 初回セットアップ CLI
 *
 * 使用方法:
 *   node --env-file jarvis/.env jarvis/automation/setup_youtube_oauth.js
 *
 * 事前準備:
 *   Google Cloud Console で OAuth 2.0 クライアント ID を作成してください。
 *   アプリケーションの種類: デスクトップ アプリ
 *   ※ リダイレクト URI の手動登録は不要です（Desktop app + loopback callback を自動処理）。
 *   jarvis/.env に YOUTUBE_CLIENT_ID と YOUTUBE_CLIENT_SECRET を設定してください。
 *
 * フロー:
 *   1. YOUTUBE_CLIENT_ID / YOUTUBE_CLIENT_SECRET を process.env から読み込む
 *   2. PKCE (S256) + state 生成
 *   3. OS にランダムポートを割り当て（127.0.0.1:0）→ 実際のポートで redirect_uri を構成
 *   4. システムブラウザを開く
 *   5. 127.0.0.1:PORT で authorization code を受信
 *   6. Token exchange（同じ redirect_uri を使用）→ refresh_token / access_token 取得
 *   7. YouTube Data API channels.list?mine=true で Channel ID を自動取得
 *   8. YOUTUBE_REFRESH_TOKEN / YOUTUBE_CHANNEL_ID を jarvis/.env に安全に保存
 *
 * セキュリティ:
 *   - PKCE (code_challenge_method=S256) — Desktop app loopback 推奨方式
 *   - state パラメータで CSRF を防止
 *   - ランダムポートで固定ポート衝突を回避
 *   - 127.0.0.1 を使用（localhost DNS lookup を回避）
 *   - access_token / refresh_token はコンソールに出力しない
 *   - .env 書き込みはアトミック（一時ファイル → rename）
 *   - 取得スコープは read-only 最小限:
 *       https://www.googleapis.com/auth/yt-analytics.readonly
 *       https://www.googleapis.com/auth/youtube.readonly
 */

import { createServer }                                          from 'http';
import { createHash, randomBytes }                               from 'crypto';
import { readFileSync, writeFileSync, renameSync, existsSync }   from 'fs';
import { exec }                                                  from 'child_process';
import { resolve, dirname }                                      from 'path';
import { fileURLToPath }                                         from 'url';
import { tmpdir }                                                from 'os';

const __dirname   = dirname(fileURLToPath(import.meta.url));
const JARVIS_ROOT = resolve(__dirname, '..');
export const ENV_PATH = resolve(JARVIS_ROOT, '.env');

export const REDIRECT_HOST    = '127.0.0.1';             // localhost DNS lookup を回避
const GOOGLE_AUTH_URL         = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL        = 'https://oauth2.googleapis.com/token';
const YOUTUBE_DATA_URL        = 'https://www.googleapis.com/youtube/v3';

/** 最小限 read-only スコープ（書き込み不可） */
export const SCOPES = [
  'https://www.googleapis.com/auth/yt-analytics.readonly',
  'https://www.googleapis.com/auth/youtube.readonly',
];

// ─── PKCE ────────────────────────────────────────────────────────────────────

function base64urlEncode(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

export function generateCodeVerifier() {
  return base64urlEncode(randomBytes(32));
}

export function generateCodeChallenge(verifier) {
  return base64urlEncode(createHash('sha256').update(verifier).digest());
}

export function generateState() {
  return base64urlEncode(randomBytes(16));
}

// ─── Authorization URL ───────────────────────────────────────────────────────

/**
 * OAuth 認可 URL を生成する（純粋関数）。
 *
 * @param {{ clientId: string, redirectUri: string, codeChallenge: string, state: string }} opts
 * @returns {string} 認可 URL
 */
export function buildAuthUrl({ clientId, redirectUri, codeChallenge, state }) {
  const params = new URLSearchParams({
    client_id:             clientId,
    redirect_uri:          redirectUri,
    response_type:         'code',
    scope:                 SCOPES.join(' '),
    access_type:           'offline',
    prompt:                'consent',     // refresh_token を確実に取得するため
    state,
    code_challenge:        codeChallenge,
    code_challenge_method: 'S256',
  });
  return `${GOOGLE_AUTH_URL}?${params}`;
}

// ─── .env 操作 ────────────────────────────────────────────────────────────────

export function readEnvFile(envPath) {
  if (!existsSync(envPath)) return '';
  return readFileSync(envPath, 'utf8');
}

export function readEnvKey(envPath, key) {
  const m = readEnvFile(envPath).match(new RegExp(`^${key}=(.*)$`, 'm'));
  return m ? m[1].trim() : '';
}

/**
 * 指定キーだけを更新する純粋関数（ファイル操作なし）。
 * コメント・空行・他キー・Instagram 設定はすべて保持する。
 *
 * @param {string} content - .env ファイルの現在の内容
 * @param {Record<string, string>} updates - 更新するキーと値
 * @returns {string} 更新後の内容
 */
export function updateEnvContent(content, updates) {
  const lines = content.split('\n');
  const found = {};

  const updated = lines.map(line => {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)/);
    if (m && Object.prototype.hasOwnProperty.call(updates, m[1])) {
      found[m[1]] = true;
      return `${m[1]}=${updates[m[1]]}`;
    }
    return line;
  });

  for (const key of Object.keys(updates)) {
    if (!found[key]) updated.push(`${key}=${updates[key]}`);
  }

  return updated.join('\n');
}

/**
 * .env を安全にアトミック更新する。
 * 一時ファイルへ書き出してから rename する。
 */
export function writeEnvFile(envPath, content) {
  const tmpPath = resolve(tmpdir(), `jarvis_env_${Date.now()}.tmp`);
  writeFileSync(tmpPath, content, 'utf8');
  try {
    renameSync(tmpPath, envPath);
  } catch {
    // 別ドライブのフォールバック
    writeFileSync(envPath, content, 'utf8');
  }
}

// ─── Token Exchange ───────────────────────────────────────────────────────────

/**
 * @param {{ clientId, clientSecret, code, redirectUri, codeVerifier }} opts
 * @returns {Promise<{ access_token: string, refresh_token?: string }>}
 */
export async function exchangeCode({ clientId, clientSecret, code, redirectUri, codeVerifier }) {
  const res = await fetch(GOOGLE_TOKEN_URL, {
    method:  'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body:    new URLSearchParams({
      code,
      client_id:     clientId,
      client_secret: clientSecret,
      redirect_uri:  redirectUri,
      grant_type:    'authorization_code',
      code_verifier: codeVerifier,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token exchange failed: ${res.status} ${body}`);
  }
  return res.json();
}

// ─── Channel ID 取得 ──────────────────────────────────────────────────────────

/**
 * channels.list?part=id&mine=true で認証ユーザーのチャンネル ID を取得する。
 * @param {string} accessToken
 * @returns {Promise<string>} Channel ID（例: UCxxxxxxxx）
 */
export async function fetchMyChannelId(accessToken) {
  const params = new URLSearchParams({ part: 'id', mine: 'true' });
  const res = await fetch(`${YOUTUBE_DATA_URL}/channels?${params}`, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`channels.list failed: ${res.status} ${body}`);
  }
  const data = await res.json();
  const channelId = data?.items?.[0]?.id;
  if (!channelId) {
    throw new Error(
      'channels.list: Channel ID が見つかりませんでした。' +
      'YouTube チャンネルが存在するアカウントでログインしてください。'
    );
  }
  return channelId;
}

// ─── ブラウザを開く（Windows）────────────────────────────────────────────────

function openBrowser(url) {
  exec(`start "" "${url.replace(/"/g, '%22')}"`, (err) => {
    if (err) {
      console.log('[setup] ブラウザを自動で開けませんでした。以下の URL を手動で開いてください:');
      console.log(url);
    }
  });
}

// ─── メイン ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('');
  console.log('======================================================');
  console.log(' Snow flakes JARVIS — YouTube OAuth セットアップ');
  console.log('======================================================');

  const clientId     = process.env.YOUTUBE_CLIENT_ID     ?? '';
  const clientSecret = process.env.YOUTUBE_CLIENT_SECRET ?? '';

  console.log('');
  console.log('[config] YOUTUBE_CLIENT_ID    :', clientId     ? 'configured' : 'NOT SET ❌');
  console.log('[config] YOUTUBE_CLIENT_SECRET:', clientSecret ? 'configured' : 'NOT SET ❌');

  if (!clientId || !clientSecret) {
    console.log('');
    console.log('======================================================');
    console.log(' 事前設定が必要です');
    console.log('======================================================');
    console.log('');
    console.log('Google Cloud Console で以下を設定してください:');
    console.log('  1. APIs & Services → OAuth 2.0 クライアント ID を作成');
    console.log('     アプリケーションの種類: デスクトップ アプリ');
    console.log('     ※ リダイレクト URI の手動登録は不要です（自動処理）');
    console.log('  2. 有効にする API:');
    console.log('     - YouTube Analytics API');
    console.log('     - YouTube Data API v3');
    console.log('  3. クライアント ID / シークレットを jarvis/.env に設定:');
    console.log('     YOUTUBE_CLIENT_ID=<取得した Client ID>');
    console.log('     YOUTUBE_CLIENT_SECRET=<取得した Client Secret>');
    console.log('');
    console.log('設定後に再度実行してください:');
    console.log('  node --env-file jarvis/.env jarvis/automation/setup_youtube_oauth.js');
    process.exit(1);
  }

  // PKCE + state 生成
  const codeVerifier  = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state         = generateState();

  console.log('');
  console.log('[auth] PKCE (S256) + state を生成しました。');
  console.log('[auth] スコープ (read-only 最小限):');
  SCOPES.forEach(s => console.log('       ' + s));

  // ─ 1. コールバックサーバーを先に起動してランダムポートを確保
  // ─ 2. 確保したポートで redirect_uri / auth URL を構築
  // ─ 3. ブラウザを開く
  // ─ 4. code 受信後に Promise を解決（code と redirectUri の両方を返す）
  const { code, redirectUri } = await new Promise((res, rej) => {
    let capturedRedirectUri = '';

    const server = createServer((req, reply) => {
      const urlObj = new URL(req.url, `http://${REDIRECT_HOST}`);
      const code   = urlObj.searchParams.get('code');
      const st     = urlObj.searchParams.get('state');
      const error  = urlObj.searchParams.get('error');

      if (error) {
        reply.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        reply.end('<html><body><h2>認証が拒否されました</h2><p>ウィンドウを閉じてください。</p></body></html>');
        server.close();
        rej(new Error(`OAuth error: ${error}`));
        return;
      }
      if (!code) {
        reply.writeHead(400);
        reply.end();
        server.close();
        rej(new Error('No code in callback'));
        return;
      }
      if (st !== state) {
        reply.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' });
        reply.end('<html><body><h2>state mismatch（CSRF防止）</h2></body></html>');
        server.close();
        rej(new Error('OAuth state mismatch'));
        return;
      }

      reply.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      reply.end(
        '<html><body><h2>認証完了</h2>' +
        '<p>このウィンドウを閉じて、ターミナルに戻ってください。</p></body></html>'
      );
      server.close();

      // code と redirectUri を両方解決値として渡す
      res({ code, redirectUri: capturedRedirectUri });
    });

    server.on('error', rej);

    // ポート 0 → OS がランダムな空きポートを割り当て
    server.listen(0, REDIRECT_HOST, () => {
      const port = server.address().port;
      capturedRedirectUri = `http://${REDIRECT_HOST}:${port}/`;

      console.log(`\n[auth] ランダムポート ${port} を確保しました。`);
      console.log(`[auth] redirect_uri: ${capturedRedirectUri}`);
      console.log('[auth] ブラウザで Google ログイン画面を開きます...');

      const authUrl = buildAuthUrl({ clientId, redirectUri: capturedRedirectUri, codeChallenge, state });
      openBrowser(authUrl);
      console.log('[auth] ブラウザが開かない場合は、以下の URL を手動で開いてください:');
      console.log(authUrl);
      console.log(`\n[auth] 127.0.0.1:${port} でコールバックを待機中...`);
    });
  });

  console.log('[auth] 認証コードを受信しました。Token exchange を実行中...');

  // Token exchange — redirectUri は認可時と完全一致
  let tokenData;
  try {
    tokenData = await exchangeCode({ clientId, clientSecret, code, redirectUri, codeVerifier });
  } catch (err) {
    console.error('[error] Token exchange 失敗:', err.message);
    process.exit(1);
  }

  const accessToken  = tokenData.access_token;
  const refreshToken = tokenData.refresh_token;

  if (!accessToken) {
    console.error('[error] access_token が取得できませんでした。');
    process.exit(1);
  }

  // Channel ID 取得
  console.log('[auth] YouTube Channel ID を取得中...');
  let channelId;
  try {
    channelId = await fetchMyChannelId(accessToken);
  } catch (err) {
    console.error('[error] Channel ID 取得失敗:', err.message);
    process.exit(1);
  }
  console.log('[auth] Channel ID を取得しました。');

  // .env 更新
  const envContent = readEnvFile(ENV_PATH);

  // refresh_token: 既存値があれば保持（Google は初回のみ返す）
  const existingRefreshToken = readEnvKey(ENV_PATH, 'YOUTUBE_REFRESH_TOKEN');
  const finalRefreshToken    = refreshToken || existingRefreshToken;

  if (!finalRefreshToken) {
    console.error('[error] refresh_token が取得できませんでした。再認証してください（prompt=consent で再実行）。');
    process.exit(1);
  }

  const updates = {
    YOUTUBE_REFRESH_TOKEN: finalRefreshToken,
    YOUTUBE_CHANNEL_ID:    channelId,
  };

  const newContent = updateEnvContent(envContent, updates);
  writeEnvFile(ENV_PATH, newContent);

  console.log('');
  console.log('======================================================');
  console.log(' セットアップ完了');
  console.log('======================================================');
  console.log('');
  console.log(' 保存した情報:');
  console.log('   YOUTUBE_REFRESH_TOKEN : ✅ 保存済み（非表示）');
  console.log(`   YOUTUBE_CHANNEL_ID    : ${channelId}`);
  console.log('');
  console.log(' 次のステップ:');
  console.log('   node --env-file jarvis/.env jarvis/automation/sf_ops_runner.js --dry-run');
  console.log('');
}

// ─── エントリーポイント ────────────────────────────────────────────────────────

// import で読み込まれた場合はメイン実行しない（テスト用）
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(err => {
    console.error('[fatal]', err.message);
    process.exit(1);
  });
}
