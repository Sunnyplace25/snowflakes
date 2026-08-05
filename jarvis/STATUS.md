# Snow flakes JARVIS - 進捗管理

## 現在のブランチ

```
jarvis-development
```

---

## 段階別進捗

| 段階 | 内容 | 状態 | commit |
|------|------|------|--------|
| 第1段階 | 基盤構築（generate_draft.js, manage_drafts.js の土台） | ✅ 完了 | `59924bd` |
| 第2段階 | ローカル下書き承認ワークフロー（manage_drafts.js 完成） | ✅ 完了 | `b50a7327` |
| 第3段階 | SNS下書き生成（generate_sns_draft.js） | ✅ 完了 | `3553404` |
| 第4段階前半 | 予約管理・事前確認・dry-run（X/Instagram/YouTube） | ✅ 実装完了・未commit | 未commit |

---

## 各段階の commit ID

- 第1段階: `59924bd feat(jarvis): add initial draft management foundation`
- 第2段階: `b50a7327534cf1d0e493fb807b82dd15df941efb feat(jarvis): add local draft approval workflow`
- 第3段階: `3553404771f3f070e15e9daf8de16a86f22359cd feat(jarvis): add SNS draft generation workflow`
- 第4段階前半: 未commit（承認待ち）

---

## 作成済み主要ファイル

| ファイル | 段階 | 状態 |
|----------|------|------|
| `jarvis/tools/generate_draft.js` | 第1段階 | ✅ 完成・変更禁止 |
| `jarvis/tools/manage_drafts.js` | 第2段階 | ✅ 完成・変更禁止 |
| `jarvis/config/settings.json` | 第1段階 | ✅ 第3段階で追記済み |
| `jarvis/package.json` | 第1段階 | ✅ 第3段階で追記済み |
| `jarvis/tools/generate_sns_draft.js` | 第3段階 | ✅ 新規作成済み |
| `jarvis/STATUS.md` | 第3段階 | ✅ 新規作成済み |
| `jarvis/tools/generate_youtube_draft.js` | 第4段階前半 | ✅ 新規作成済み |
| `jarvis/tools/manage_schedule.js` | 第4段階前半 | ✅ 新規作成済み |
| `jarvis/tools/preflight_check.js` | 第4段階前半 | ✅ 新規作成済み |

---

## NPMコマンド一覧

| コマンド | 内容 |
|----------|------|
| `npm run draft` | サイト更新・活動報告などの下書き生成 |
| `npm run sns-draft` | XとInstagram用SNS下書き生成 |
| `npm run youtube-draft` | YouTube動画予約情報の下書き生成 |
| `npm run schedule-list` | 投稿予定一覧表示（X/Instagram/YouTube） |
| `npm run schedule-show -- <id>` | 投稿予定詳細表示 |
| `npm run schedule-set -- <id>` | 投稿予定日時の設定 |
| `npm run schedule-check -- <id>` | 投稿前チェック（READY/WARNING/BLOCKED） |
| `npm run dry-run -- <id>` | 投稿模擬実行（実際の投稿なし） |
| `npm run list` | pending の下書き一覧 |
| `npm run show -- <id>` | 下書きの詳細表示 |
| `npm run approve -- <id>` | 承認（pending → approved） |
| `npm run reject -- <id>` | 差し戻し |
| `npm run publish -- <id>` | 公開済み記録（approved → published） |

---

## 変更禁止ファイル

- `jarvis/tools/generate_draft.js`（既存・変更禁止）
- `jarvis/tools/manage_drafts.js`（既存・変更禁止）
- `jarvis/tools/generate_sns_draft.js`（既存・変更禁止）
- サイト本体の既存ファイル全般

---

## 安全ルール（必ず守ること）

- 未追跡の音声ファイル（`music/`, `sweets/` の `.mp3` / `.wav`）には絶対に触れない
- `git add .` は禁止。追加する場合は対象ファイルを個別指定する
- `commit` / `push` / `main へのマージ` は山吹ことり様の承認なしに実行しない
