/**
 * jarvis/importers/ga4_collector.js
 * Google Analytics Data API v1 から実データを取得し、
 * sf_ga_daily / sf_ga_event_daily へ書き込む（Phase 4）。
 *
 * 認証: GOOGLE_APPLICATION_CREDENTIALS（サービスアカウント JSON パス）
 * 設定: GA4_PROPERTY_ID（数字のみ）
 *
 * 注意:
 *   - 認証情報・秘密鍵はコードに保存しない
 *   - ハードコードされた property ID・イベント名は持たない
 *   - テスト用モック化は ENV を差し替えることで対応
 */

import { google }          from 'googleapis';
import { writeGaDaily, writeGaEventDaily } from './ga_writer.js';

export const REQUIRED_ENV_VARS = [
  'GA4_PROPERTY_ID',
  'GOOGLE_APPLICATION_CREDENTIALS',
];

/**
 * ENV から GA4 設定を読み込む。
 * @returns {{ propertyId: string, credentialsPath: string }}
 */
export function getGa4Config() {
  for (const key of REQUIRED_ENV_VARS) {
    if (!process.env[key]) throw new Error(`ENV 変数が未設定: ${key}`);
  }
  return {
    propertyId:      process.env.GA4_PROPERTY_ID,
    credentialsPath: process.env.GOOGLE_APPLICATION_CREDENTIALS,
  };
}

/**
 * サービスアカウントで認証済みの analyticsdata クライアントを返す。
 */
async function getAnalyticsDataClient() {
  const auth = new google.auth.GoogleAuth({
    scopes: ['https://www.googleapis.com/auth/analytics.readonly'],
  });
  return google.analyticsdata({ version: 'v1beta', auth });
}

/**
 * GA4 から日別ページ指標を取得する。
 *
 * @param {{ analyticsdata: object, propertyId: string, startDate: string, endDate: string }} opts
 * @returns {Promise<Array<{ date, pagePath, sessions, users, pageViews, engagedSessions }>>}
 */
export async function fetchGaDaily({ analyticsdata, propertyId, startDate, endDate }) {
  const res = await analyticsdata.properties.runReport({
    property: `properties/${propertyId}`,
    requestBody: {
      dateRanges: [{ startDate, endDate }],
      dimensions: [
        { name: 'date' },
        { name: 'pagePath' },
      ],
      metrics: [
        { name: 'sessions' },
        { name: 'totalUsers' },
        { name: 'screenPageViews' },
        { name: 'engagedSessions' },
      ],
      orderBys: [{ dimension: { dimensionName: 'date' } }],
      limit: 10000,
    },
  });

  const rows = res.data.rows ?? [];
  return rows.map(r => {
    // GA4 の日付形式は YYYYMMDD → YYYY-MM-DD に変換
    const rawDate = r.dimensionValues[0].value;
    const date = `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`;
    return {
      date,
      pagePath:         r.dimensionValues[1].value,
      sessions:         parseInt(r.metricValues[0].value, 10),
      users:            parseInt(r.metricValues[1].value, 10),
      pageViews:        parseInt(r.metricValues[2].value, 10),
      engagedSessions:  parseInt(r.metricValues[3].value, 10),
    };
  });
}

/**
 * GA4 からイベント日別集計を取得する。
 *
 * @param {{ analyticsdata: object, propertyId: string, startDate: string, endDate: string }} opts
 * @returns {Promise<Array<{ date, eventName, pagePath, count }>>}
 */
export async function fetchGaEventDaily({ analyticsdata, propertyId, startDate, endDate }) {
  const res = await analyticsdata.properties.runReport({
    property: `properties/${propertyId}`,
    requestBody: {
      dateRanges: [{ startDate, endDate }],
      dimensions: [
        { name: 'date' },
        { name: 'eventName' },
        { name: 'pagePath' },
      ],
      metrics: [
        { name: 'eventCount' },
      ],
      orderBys: [{ dimension: { dimensionName: 'date' } }],
      limit: 50000,
    },
  });

  const rows = res.data.rows ?? [];
  return rows.map(r => {
    const rawDate = r.dimensionValues[0].value;
    const date = `${rawDate.slice(0, 4)}-${rawDate.slice(4, 6)}-${rawDate.slice(6, 8)}`;
    return {
      date,
      eventName: r.dimensionValues[1].value,
      pagePath:  r.dimensionValues[2].value,
      count:     parseInt(r.metricValues[0].value, 10),
    };
  });
}

/**
 * GA4 からデータを取得して DB に書き込むメイン関数。
 *
 * @param {import('node:sqlite').DatabaseSync} db
 * @param {{ startDate?: string, endDate?: string }} opts
 * @returns {Promise<{ daily: object, events: object, startDate: string, endDate: string }>}
 */
export async function syncGa4(db, { startDate, endDate } = {}) {
  const { propertyId } = getGa4Config();

  // デフォルト: 過去90日
  const today = new Date();
  const defaultEnd   = today.toISOString().slice(0, 10);
  const defaultStart = new Date(today - 90 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

  const from = startDate ?? defaultStart;
  const to   = endDate   ?? defaultEnd;

  const analyticsdata = await getAnalyticsDataClient();

  // 日別ページ指標
  const dailyRows = await fetchGaDaily({ analyticsdata, propertyId, startDate: from, endDate: to });
  const dailyResult = writeGaDaily(db, dailyRows);

  // イベント日別集計
  const eventRows = await fetchGaEventDaily({ analyticsdata, propertyId, startDate: from, endDate: to });
  const eventResult = writeGaEventDaily(db, eventRows);

  return {
    startDate:  from,
    endDate:    to,
    daily:      { fetched: dailyRows.length,  ...dailyResult },
    events:     { fetched: eventRows.length,  ...eventResult },
  };
}
