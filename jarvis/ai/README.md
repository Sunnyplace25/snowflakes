# JARVIS AI Bridge

Claude Code と OpenAI の間の自動開発ブリッジ。
ユーザーが設計・diff・修正指示を手動コピペしなくてよい状態にする。

---

## フロー

```
node jarvis/ai/orchestrator.mjs run jarvis/ai/tasks/phase3-narou.md
```

```
Claude 実装
  ↓
テスト実行
  ↓
OpenAI コードレビュー (Responses API + Structured Output)
  ↓ revise
Claude へ修正指示を自動返却  ← 最大 4 回
  ↓ approve (全テスト pass)
ユーザー承認ゲート
  ↓ y
git add -- <file> (個別)
git commit
  ↓ y
git push origin jarvis-development
```

---

## ユーザー確認が必要なタイミング

- `commit`
- `push`
- main ブランチ変更
- 実 DB 変更
- 外部公開・外部送信
- 削除などの破壊的操作
- AI 同士で 4 回レビューしても解決しない場合

---

## ファイル構成

```
jarvis/ai/
  orchestrator.mjs      — エントリーポイント
  claude_runner.mjs     — Claude CLI 実行
  openai_reviewer.mjs   — OpenAI Responses API レビュー
  guardrails.mjs        — ブランチ・保護ファイルチェック
  approval_gate.mjs     — ユーザー承認ゲート
  REVIEW_RULES.md       — レビュールール
  README.md             — このファイル

jarvis/ai/runtime/      — .gitignore 対象（実行時状態）
  session.json          — Claude セッション ID
  last_review.json      — 直近の OpenAI レビュー結果
  pending_approval.json — 承認待ち状態
  logs/                 — 実行ログ

jarvis/ai/tasks/        — タスクファイル置き場
  phase3-narou.md       — (例) Phase 3 タスク
```

---

## 環境変数

| 変数名               | 必須 | 説明 |
|:---------------------|:-----|:-----|
| `OPENAI_API_KEY`     | ○    | OpenAI API キー（値は絶対にログに出力しない） |
| `OPENAI_REVIEW_MODEL`| —    | 使用モデル（デフォルト: `gpt-5.6-terra`） |

設定方法（PowerShell）:
```powershell
$env:OPENAI_API_KEY = "sk-..."
```

設定方法（.env ファイル — git 管理禁止）:
```
OPENAI_API_KEY=sk-...
```

---

## タスクファイル

`jarvis/ai/tasks/` 以下に Markdown で記述する。

```markdown
# Phase 3 — 小説 PV・なろう管理

## 目的
...

## 実装内容
...

## 完了条件
...
```

---

## CLI コマンド

```bash
# タスク実行
node jarvis/ai/orchestrator.mjs run jarvis/ai/tasks/phase3-narou.md

# Claude CLI と OpenAI キーの確認
node jarvis/ai/orchestrator.mjs check-cli
```

---

## テスト

```bash
node jarvis/tests/test_ai_bridge.js
```

---

## 制約

- `git add .` / `git add -A` / `git add --all` は使用禁止
- API キーはログ・ファイルに出力禁止
- `jarvis/data/business_data.db` など保護ファイルは変更禁止
- commit / push はユーザー承認後のみ
- main ブランチへの変更禁止
