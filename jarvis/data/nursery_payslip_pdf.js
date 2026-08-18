/**
 * 給与明細PDFを Anthropic の document 入力で読み取り、
 * JARVIS の給与明細フォーム用JSONへ正規化する。
 * PDF自体は保存しない。
 */
'use strict';

const DEFAULT_MODEL = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5-20250929';

function extractJson(text) {
  const raw = String(text || '').trim();
  try { return JSON.parse(raw); } catch (_) {}
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) {
    try { return JSON.parse(fenced[1].trim()); } catch (_) {}
  }
  const first = raw.indexOf('{');
  const last = raw.lastIndexOf('}');
  if (first >= 0 && last > first) return JSON.parse(raw.slice(first, last + 1));
  throw new Error('PDFの読取結果をJSONとして解析できませんでした');
}

function nullableNumber(value) {
  if (value == null || value === '') return null;
  const cleaned = typeof value === 'string' ? value.replace(/[,，円\s]/g, '') : value;
  const n = Number(cleaned);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function normalizeMonth(value) {
  if (!value) return null;
  const s = String(value).trim();
  if (/^\d{4}-\d{2}$/.test(s)) return s;
  const m = s.match(/(20\d{2})\D+(\d{1,2})/);
  if (!m) return null;
  return `${m[1]}-${String(Number(m[2])).padStart(2, '0')}`;
}

export async function readNurseryPayslipPdf({ data_b64, filename = '' } = {}) {
  if (!data_b64 || typeof data_b64 !== 'string') throw new Error('PDFファイルが必要です');
  if (Buffer.byteLength(data_b64, 'base64') > 12 * 1024 * 1024) throw new Error('PDFは12MB以下にしてください');

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY が未設定です。JARVISの .env を確認してください');

  const prompt = `日本の給与明細PDFを読み取り、下記JSONだけを返してください。
この明細ではラベル名を優先して読み取ってください。推測で埋めず、不明なものだけ null にしてください。

重要:
- month: 「対象期間」の月。支給日ではありません。例: 対象期間が 07月01日〜07月31日、支給日が8月14日なら 2026-07。
- hourly_rate: 「基本給(時給)＠」の値。支給欄の「時間給」の総額ではありません。
- worked_hours: 勤怠欄の「勤務時間」。
- paid_leave_used: 勤怠欄の「有休日数」。
- paid_leave_balance: 勤怠欄の「有休残」。
- gross_pay: 支給欄の「合計」。
- net_pay: 「差引支給額」。
- transport_pay: 支給欄の「通勤手当（非）」または通勤手当。
- deductions: 控除欄の「合計」または「社会保険料等合計」。
- 金額は円の整数、時間・日数は数値。

{
  "month": "YYYY-MM or null",
  "hourly_rate": number|null,
  "worked_hours": number|null,
  "paid_leave_used": number|null,
  "paid_leave_balance": number|null,
  "gross_pay": number|null,
  "net_pay": number|null,
  "transport_pay": number|null,
  "deductions": number|null,
  "memo": "短い補足 or null"
}

ファイル名: ${filename}`;

  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: DEFAULT_MODEL,
      max_tokens: 1200,
      temperature: 0,
      messages: [{
        role: 'user',
        content: [
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: data_b64 },
          },
          { type: 'text', text: prompt },
        ],
      }],
    }),
  });

  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const msg = data?.error?.message || `Anthropic API error (${response.status})`;
    throw new Error(msg);
  }

  const text = (data.content || []).filter(x => x.type === 'text').map(x => x.text).join('\n');
  const parsed = extractJson(text);
  return {
    month: normalizeMonth(parsed.month),
    hourly_rate: nullableNumber(parsed.hourly_rate),
    worked_hours: nullableNumber(parsed.worked_hours),
    paid_leave_used: nullableNumber(parsed.paid_leave_used),
    paid_leave_balance: nullableNumber(parsed.paid_leave_balance),
    gross_pay: nullableNumber(parsed.gross_pay),
    net_pay: nullableNumber(parsed.net_pay),
    transport_pay: nullableNumber(parsed.transport_pay),
    deductions: nullableNumber(parsed.deductions),
    memo: parsed.memo == null ? null : String(parsed.memo).trim(),
  };
}
