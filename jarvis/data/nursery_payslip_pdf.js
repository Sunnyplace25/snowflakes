/**
 * 保育園の給与明細PDFをローカルでテキスト抽出し、
 * JARVIS の給与明細フォーム用JSONへ正規化する。
 * 外部AI APIは使わず、PDF自体も保存しない。
 */
'use strict';

import PDFParser from 'pdf2json';

function nullableNumber(value) {
  if (value == null || value === '') return null;
  const cleaned = typeof value === 'string' ? value.replace(/[,，円\s]/g, '') : value;
  const n = Number(cleaned);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function parsePdfText(buffer) {
  return new Promise((resolve, reject) => {
    const parser = new PDFParser(null, 1);
    parser.on('pdfParser_dataError', err => {
      reject(err?.parserError || new Error('PDFの文字を読み取れませんでした'));
    });
    parser.on('pdfParser_dataReady', () => {
      try {
        resolve(String(parser.getRawTextContent() || ''));
      } catch (e) {
        reject(e);
      }
    });
    parser.parseBuffer(buffer);
  });
}

function firstNumber(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return nullableNumber(match[1]);
  }
  return null;
}

function parseTargetMonth(text) {
  const pay = text.match(/(20\d{2})[^\d]{0,8}(\d{1,2})月\s*(?:\d{1,2}日)?支給/);
  const period = text.match(/対象期間[\s:：]*?(\d{1,2})月\s*0?1日[\s\S]{0,30}?(\d{1,2})月\s*\d{1,2}日/);
  if (!pay && !period) return null;

  const payYear = pay ? Number(pay[1]) : new Date().getFullYear();
  const payMonth = pay ? Number(pay[2]) : null;
  const targetMonth = period ? Number(period[1]) : payMonth;
  if (!targetMonth) return null;

  let year = payYear;
  if (payMonth && targetMonth > payMonth) year -= 1;
  return `${year}-${String(targetMonth).padStart(2, '0')}`;
}

function compact(text) {
  return String(text || '')
    .replace(/\r/g, '\n')
    .replace(/[\u00a0\u3000]/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n+/g, '\n');
}

export async function readNurseryPayslipPdf({ data_b64, filename = '' } = {}) {
  if (!data_b64 || typeof data_b64 !== 'string') throw new Error('PDFファイルが必要です');

  const buffer = Buffer.from(data_b64, 'base64');
  if (!buffer.length) throw new Error('PDFファイルが空です');
  if (buffer.length > 12 * 1024 * 1024) throw new Error('PDFは12MB以下にしてください');

  const rawText = await parsePdfText(buffer);
  const text = compact(rawText);

  if (!text.trim()) {
    throw new Error('このPDFから文字を取り出せませんでした。画像だけのPDFには現在対応していません');
  }

  const hourlyRate = firstNumber(text, [
    /基本給\s*\(\s*時給\s*\)\s*[@＠]\s*([\d,]+)/,
    /基本給[^\n]{0,20}時給[^\n]{0,10}[@＠]?\s*([\d,]+)/,
  ]);

  const workedHours = firstNumber(text, [
    /勤務時間\s*([\d.]+)/,
    /実働時間\s*([\d.]+)/,
  ]);

  const paidLeaveUsed = firstNumber(text, [
    /有休日数\s*([\d.]+)/,
    /有給(?:使用|取得)(?:日数)?\s*([\d.]+)/,
  ]);

  const paidLeaveBalance = firstNumber(text, [
    /有休残\s*([\d.]+)/,
    /有給残(?:日数)?\s*([\d.]+)/,
  ]);

  const netPay = firstNumber(text, [
    /差引支給額\s*[:：]?\s*([\d,]+)/,
    /差引支給\s*[:：]?\s*([\d,]+)/,
  ]);

  const transportPay = firstNumber(text, [
    /通勤手当\s*[（(]?非[）)]?\s*([\d,]+)/,
    /通勤手当[^\n\d]{0,12}([\d,]+)/,
  ]);

  const deductions = firstNumber(text, [
    /社会保険料等合計\s*([\d,]+)/,
    /控除(?:額)?合計\s*([\d,]+)/,
  ]);

  const taxablePay = firstNumber(text, [/課税支給額\s*([\d,]+)/]);
  const nonTaxablePay = firstNumber(text, [/非課税支給額\s*([\d,]+)/]);

  let grossPay = firstNumber(text, [
    /支給合計\s*([\d,]+)/,
    /総支給額\s*([\d,]+)/,
  ]);
  if (grossPay == null && taxablePay != null && nonTaxablePay != null) {
    grossPay = taxablePay + nonTaxablePay;
  }

  const result = {
    month: parseTargetMonth(text),
    hourly_rate: hourlyRate,
    worked_hours: workedHours,
    paid_leave_used: paidLeaveUsed,
    paid_leave_balance: paidLeaveBalance,
    gross_pay: grossPay,
    net_pay: netPay,
    transport_pay: transportPay,
    deductions,
    memo: filename ? `PDF取込: ${filename}` : '給与明細PDFから取込',
  };

  const found = Object.entries(result)
    .filter(([key, value]) => key !== 'memo' && value != null)
    .length;
  if (found === 0) {
    throw new Error('給与明細の項目を認識できませんでした');
  }

  return result;
}
