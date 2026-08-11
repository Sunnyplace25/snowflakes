#!/usr/bin/env node
/**
 * jarvis/tools/record_day.js
 * 日次状態（daily_status）手入力 CLI ツール
 *
 * 使い方:
 *   node tools/record_day.js set --date 2026-08-11 --off        # 完全休日
 *   node tools/record_day.js set --date 2026-08-11 --work       # 勤務日
 *   node tools/record_day.js set --date 2026-08-11 --off --memo "旅行"
 *   node tools/record_day.js show --date 2026-08-11
 *   node tools/record_day.js stats [--month 2026-08]
 */

import { createDb, DEFAULT_DB_PATH }                          from '../data/db.js';
import { upsertDailyStatus, getDailyStatus,
         getFullDayOffCount, getMaxConsecutiveWorkDays }      from '../data/daily_status_manager.js';

const args = process.argv.slice(2);
const cmd  = args[0];

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--off')  { opts.off  = true; continue; }
    if (argv[i] === '--work') { opts.work = true; continue; }
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
      opts[key] = argv[i + 1] ?? true;
      i++;
    }
  }
  return opts;
}

function usage() {
  console.error([
    'Usage:',
    '  node tools/record_day.js set --date <YYYY-MM-DD> --off [--memo <text>]',
    '  node tools/record_day.js set --date <YYYY-MM-DD> --work [--memo <text>]',
    '  node tools/record_day.js show --date <YYYY-MM-DD>',
    '  node tools/record_day.js stats [--month <YYYY-MM>]',
    '',
    '※ --off: 完全休日として登録',
    '※ --work: 勤務日として登録',
    '※ 未登録日は勤務日とも休日とも判断しません',
  ].join('\n'));
  process.exit(1);
}

const db = createDb(DEFAULT_DB_PATH);

try {
  if (cmd === 'set') {
    const opts = parseArgs(args.slice(1));
    if (!opts.date) usage();
    if (opts.off === undefined && opts.work === undefined) usage();

    const isOff = !!opts.off;
    upsertDailyStatus(db, {
      date:            opts.date,
      is_full_day_off: isOff,
      memo:            opts.memo ?? null,
    });
    console.log(`✅ ${opts.date} を ${isOff ? '完全休日' : '勤務日'} として登録しました`);

  } else if (cmd === 'show') {
    const opts   = parseArgs(args.slice(1));
    if (!opts.date) usage();
    const row = getDailyStatus(db, opts.date);
    if (!row) {
      console.log(`${opts.date}: 未登録（勤務日・休日どちらでもありません）`);
    } else {
      console.log(`${row.date}: ${row.is_full_day_off ? '完全休日' : '勤務日'} memo=${row.memo ?? ''}`);
    }

  } else if (cmd === 'stats') {
    const opts    = parseArgs(args.slice(1));
    const month   = opts.month ?? null;
    const offDays = getFullDayOffCount(db, { yearMonth: month });
    const { max_consecutive_work_days } = getMaxConsecutiveWorkDays(db);
    console.log(`完全休日日数: ${offDays}日${month ? ` (${month})` : ''}`);
    console.log(`最大連勤: ${max_consecutive_work_days}日`);

  } else {
    usage();
  }
} finally {
  db.close();
}
