#!/usr/bin/env node
/**
 * jarvis/run_task.js
 * Top-level task runner CLI — タスクの開始・再開・状態確認
 *
 * 使い方:
 *   node run_task.js start <phase>              # 新規タスク開始
 *   node run_task.js resume <taskId>            # 既存タスク再開
 *   node run_task.js status <taskId>            # タスク状態確認
 *   node run_task.js list                       # 全タスク一覧
 *   node run_task.js dry-run <taskId>           # 1フェーズのみプレビュー
 *   node run_task.js dry-run --phase <phase>    # 新規タスクでプレビュー
 */

import { runTask, getTaskStatus, listAllTasks } from './orchestrator/task_runner.js';

const [,, cmd, ...args] = process.argv;

function printJSON(obj) {
  console.log(JSON.stringify(obj, null, 2));
}

function usage() {
  console.error([
    'Usage:',
    '  node run_task.js start <phase>       # 新規タスク開始',
    '  node run_task.js resume <taskId>     # 既存タスク再開',
    '  node run_task.js status <taskId>     # タスク状態確認',
    '  node run_task.js list                # 全タスク一覧',
    '  node run_task.js dry-run <taskId>    # 1フェーズプレビュー（taskId）',
  ].join('\n'));
  process.exit(1);
}

async function main() {
  switch (cmd) {
    case 'start': {
      const phase = args[0];
      if (!phase) { console.error('Error: phase is required'); usage(); }
      const result = await runTask({ phase });
      printJSON(result);
      process.exit(result.ok ? 0 : 1);
      break;
    }

    case 'resume': {
      const taskId = args[0];
      if (!taskId) { console.error('Error: taskId is required'); usage(); }
      const result = await runTask({ taskId });
      printJSON(result);
      process.exit(result.ok ? 0 : 1);
      break;
    }

    case 'dry-run': {
      const taskId = args[0];
      if (!taskId) { console.error('Error: taskId is required'); usage(); }
      const result = await runTask({ taskId, dry_run: true });
      printJSON(result);
      process.exit(result.ok ? 0 : 1);
      break;
    }

    case 'status': {
      const taskId = args[0];
      if (!taskId) { console.error('Error: taskId is required'); usage(); }
      const result = getTaskStatus(taskId);
      printJSON(result);
      process.exit(result.ok ? 0 : 1);
      break;
    }

    case 'list': {
      const tasks = listAllTasks();
      printJSON(tasks);
      process.exit(0);
      break;
    }

    default:
      usage();
  }
}

main().catch(e => {
  console.error('Fatal error:', e.message);
  process.exit(1);
});
