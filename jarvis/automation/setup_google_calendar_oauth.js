/**
 * jarvis/automation/setup_google_calendar_oauth.js
 * Google Calendar OAuth 2.0 初回セットアップ CLI
 *
 * 使用方法:
 *   node --env-file jarvis/.env jarvis/automation/setup_google_calendar_oauth.js
 *
 * 前提: Google Cloud Console で OAuth 2.0 クライアントID（デスクトップアプリ）を作成済み
 *       スコープ: calendar.events (読み書き), calendar.readonly (一覧取得)
 *
 * フロー:
 *   1. GCALENDAR_CLIENT_ID / GCALENDAR_CLIENT_SECRET を .env から読み込む
 *   2. PKCE (S256) + state 生成
 *   3. ランダムポートで loopback callback サーバー起動
 *   4. ブラウザを開く
 *   5. authorization code 受信
 *   6. Token exchange → refresh_token 取得
 *   7. GCALENDAR_REFRESH_TOKEN を .env に安全に保存
 *
 * セキュリティ:
 *   - PKCE S256 (YouTube と同じ方式)
 *   - state で CSRF 防止
 *   - access_token / refresh_token はコンソールに出力しない
 */

import { createServer }  from 'http';
import { execSync }      from 'child_process';
import { fileURLToPath } from 'url';
import { resolve, dirname } from 'path';

// YouTube OAuth ユーティリティを再利用
import {
  generateCodeVerifier,
  generateCodeChallenge,
  generateState,
  exchangeCode,
  readEnvFile,
  updateEnvContent,
  writeEnvFile,
  readEnvKey,
  ENV_PATH,
  REDIRECT_HOST,
} from './setup_youtube_oauth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Google Calendar 用スコープ */
export const SCOPES = [
  'https://www.googleapis.com/auth/calendar',          // カレンダー管理（作成・削除含む）
  'https://www.googleapis.com/auth/calendar.events',
  'https://www.googleapis.com/auth/calendar.readonly',
];

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';

// ─── Auth URL Builder ─────────────────────────────────────────────────────────

/**
 * Google Calendar 用 OAuth 認可 URL を生成する。
 * @param {{ clientId: string, redirectUri: string, codeChallenge: string, state: string }} opts
 * @returns {string}
 */
export function buildCalendarAuthUrl({ clientId, redirectUri, codeChallenge, state }) {
  const params = new URLSearchParams({
    client_id:             clientId,
    redirect_uri:          redirectUri,
    response_type:         'code',
    scope:                 SCOPES.join(' '),
    access_type:           'offline',
    prompt:                'consent',   // refresh_token を確実に取得するため
    state,
    code_challenge:        codeChallenge,
    code_challenge_method: 'S256',
  });
  return `${GOOGLE_AUTH_URL}?${params}`;
}

// ─── ブラウザを開く（Windows）────────────────────────────────────────────────

function openBrowser(url) {
  try {
    execSync(`start "" "${url.replace(/"/g, '%22')}"`);
  } catch {
    console.log('[setup] ブラウザを自動で開けませんでした。以下の URL を手動で開いてください:');
    console.log(url);
  }
}

// ─── メイン ──────────────────────────────────────────────────────────────────

async function main() {
  console.log('');
  console.log('======================================================');
  console.log(' Snow flakes JARVIS — Google Calendar OAuth セットアップ');
  console.log('======================================================');

  // .env から Client ID / Secret を読み込む
  const clientId     = process.env.GCALENDAR_CLIENT_ID     ?? '';
  const clientSecret = process.env.GCALENDAR_CLIENT_SECRET ?? '';

  console.log('');
  console.log('[config] GCALENDAR_CLIENT_ID    :', clientId     ? 'configured' : 'NOT SET ❌');
  console.log('[config] GCALENDAR_CLIENT_SECRET:', clientSecret ? 'configured' : 'NOT SET ❌');

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
    console.log('     - Google Calendar API');
    console.log('  3. クライアント ID / シークレットを jarvis/.env に設定:');
    console.log('     GCALENDAR_CLIENT_ID=<取得した Client ID>');
    console.log('     GCALENDAR_CLIENT_SECRET=<取得した Client Secret>');
    console.log('');
    console.log('設定後に再度実行してください:');
    console.log('  node --env-file jarvis/.env jarvis/automation/setup_google_calendar_oauth.js');
    process.exit(1);
  }

  // PKCE + state 生成
  const codeVerifier  = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state         = generateState();

  console.log('');
  console.log('[auth] PKCE (S256) + state を生成しました。');
  console.log('[auth] スコープ:');
  SCOPES.forEach(s => console.log('       ' + s));

  // コールバックサーバー起動 → ランダムポート確保 → ブラウザ起動 → code 受信
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
        '<html><body><h2>Google Calendar 認証完了</h2>' +
        '<p>このウィンドウを閉じて、ターミナルに戻ってください。</p></body></html>'
      );
      server.close();

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

      const authUrl = buildCalendarAuthUrl({
        clientId,
        redirectUri: capturedRedirectUri,
        codeChallenge,
        state,
      });

      openBrowser(authUrl);
      console.log('[auth] ブラウザが開かない場合は、以下の URL を手動で開いてください:');
      console.log(authUrl);
      console.log(`\n[auth] 127.0.0.1:${port} でコールバックを待機中...`);
    });
  });

  console.log('[auth] 認証コードを受信しました。Token exchange を実行中...');

  // Token exchange
  let tokenData;
  try {
    tokenData = await exchangeCode({
      clientId,
      clientSecret,
      code,
      redirectUri,
      codeVerifier,
    });
  } catch (err) {
    console.error('[error] Token exchange 失敗:', err.message);
    process.exit(1);
  }

  const refreshToken = tokenData.refresh_token;

  if (!tokenData.access_token) {
    console.error('[error] access_token が取得できませんでした。');
    process.exit(1);
  }

  // 既存の refresh_token があれば保持（Google は初回のみ返す）
  const existingRefreshToken = readEnvKey(ENV_PATH, 'GCALENDAR_REFRESH_TOKEN');
  const finalRefreshToken    = refreshToken || existingRefreshToken;

  if (!finalRefreshToken) {
    console.error(
      '[error] refresh_token が取得できませんでした。' +
      '再認証してください（prompt=consent で再実行）。'
    );
    process.exit(1);
  }

  // .env を更新
  const envContent = readEnvFile(ENV_PATH);
  const newContent = updateEnvContent(envContent, {
    GCALENDAR_REFRESH_TOKEN: finalRefreshToken,
  });
  writeEnvFile(ENV_PATH, newContent);

  console.log('');
  console.log('======================================================');
  console.log(' セットアップ完了');
  console.log('======================================================');
  console.log('');
  console.log(' 保存した情報:');
  console.log('   GCALENDAR_REFRESH_TOKEN : ✅ 保存済み（非表示）');
  console.log('');
  console.log(' 次のステップ:');
  console.log('   node --env-file jarvis/.env jarvis/sync/calendar_sync.js --dry-run');
  console.log('');
}

// ─── エントリーポイント ────────────────────────────────────────────────────────

// import で読み込まれた場合はメイン実行しない
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch(err => {
    console.error('[fatal]', err.message);
    process.exit(1);
  });
}
