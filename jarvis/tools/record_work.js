#!/usr/bin/env node
/**
 * jarvis/tools/record_work.js
 * 仕事レコード手入力 CLI ツール
 *
 * 使い方:
 *   node tools/record_work.js add --date 2026-08-11 --category 音声仕事 \
 *     --work-type ロケ --client "○○プロ" --income 25000 \
 *     --work-hours 4.0 --travel-hours 1.5 --invoice-status 未請求
 *
 *   node tools/record_work.js list [--month 2026-08]
 *   node tools/record_work.js update <id> --invoice-status 請求済
 */

import { createDb, DEFAULT_DB_PATH }  from '../data/db.js';
import { addWorkRecord, getWorkRecords, updateWorkRecord } from '../data/work_record_manager.js';
import { markWorkDay } from '../data/daily_status_manager.js';

const args = process.argv.slice(2);
const cmd  = args[0];

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      opts[key] = argv[i + 1] ?? true;
      i++;
    } else if (!opts._id) {
      opts._id = argv[i];
    }
  }
  return opts;
}

function usage() {
  console.error([
    'Usage:',
    '  node tools/record_work.js add --date <YYYY-MM-DD> --category <category> [options]',
    '  node tools/record_work.js list [--month <YYYY-MM>]',
    '  node tools/record_work.js update <id> --invoice-status <status>',
    '',
    'Categories: Snow flakes / 音声仕事 / 物販 / 17配信 / その他',
    'work-type (音声仕事): ロケ / STUDIO / 中継 / その他',
    'invoice-status: 対象外 / 未請求 / 請求済',
    'payment-status: 対象外 / 未入金 / 入金済',
  ].join('\n'));
  process.exit(1);
}

const db = createDb(DEFAULT_DB_PATH);

try {
  if (cmd === 'add') {
    const opts = parseArgs(args.slice(1));
    if (!opts.date || !opts.category) usage();

    const income       = opts.income       ? parseInt(opts.income, 10)       : null;
    const expense      = opts.expense      ? parseInt(opts.expense, 10)      : null;
    const workHours    = opts.workHours    ? parseFloat(opts.workHours)      : null;
    const travelHours  = opts.travelHours  ? parseFloat(opts.travelHours)   : null;

    const { rowid, job_id } = addWorkRecord(db, {
      date:           opts.date,
      category:       opts.category,
      work_type:      opts.workType      ?? null,
      content:        opts.content       ?? null,
      client:         opts.client        ?? null,
      income,
      expense,
      work_hours:     workHours,
      travel_hours:   travelHours,
      invoice_status: opts.invoiceStatus ?? '対象外',
      payment_status: opts.paymentStatus ?? '対象外',
      memo:           opts.memo          ?? null,
    });

    // 仕事を登録した日を daily_status に安全に反映
    markWorkDay(db, opts.date);

    console.log(`✅ 登録完了 id=${rowid} job_id=${job_id}`);

  } else if (cmd === 'list') {
    const opts    = parseArgs(args.slice(1));
    const records = getWorkRecords(db, { yearMonth: opts.month ?? null });
    if (records.length === 0) {
      console.log('レコードがありません。');
    } else {
      console.table(records.map(r => ({
        id: r.id, date: r.date, category: r.category, work_type: r.work_type,
        client: r.client, income: r.income, invoice: r.invoice_status,
      })));
    }

  } else if (cmd === 'update') {
    const opts = parseArgs(args.slice(1));
    const id   = parseInt(opts._id, 10);
    if (!id) usage();
    updateWorkRecord(db, id, {
      invoice_status: opts.invoiceStatus,
      payment_status: opts.paymentStatus,
    });
    console.log(`✅ 更新完了 id=${id}`);

  } else {
    usage();
  }
} finally {
  db.close();
}
