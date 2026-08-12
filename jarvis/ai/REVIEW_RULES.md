# JARVIS AI Bridge — Review Rules

OpenAI レビュアーはこのルールに従ってコードレビューを行う。

---

## 必須チェック項目

### 1. Task 要件の充足
- 実装が task の要求をすべて満たしているか
- 要求されていない機能が追加されていないか

### 2. 既存機能の保護
- 既存テストがすべて pass しているか
- 既存 API / 関数のシグネチャが壊れていないか
- `metrics_writer.js` など既存インポーターに変更がないか

### 3. テストの追加
- 新機能に対応するテストが追加されているか
- テストは `:memory:` DB を使用しているか（実 DB 禁止）
- テストが全件 pass しているか

### 4. データ安全性
- `jarvis/data/business_data.db` を変更していないか
- `jarvis/backups/` を変更していないか
- 推測や固定値でデータを作らないか（実データ由来のみ）
- テストに実 DB を使用していないか

### 5. 保護ファイルへの変更禁止
以下のファイル・ディレクトリは変更禁止:
- `jarvis/data/business_data.db` / `*.db-shm` / `*.db-wal`
- `jarvis/backups/`
- `jarvis/imports/` 以下の実 CSV
- `music/` / `sweets/` 以下の音声・画像ファイル

### 6. 秘密情報の保護
- API キー・パスワード・トークンをコードやログに出力していないか
- `.env` ファイルや秘密情報を git 管理下に入れていないか
- `process.env.XXX` 経由でのみ取得しているか

### 7. 変更スコープの適切さ
- task と無関係なリファクタリングをしていないか
- 不要なコメント・型注釈の追加をしていないか
- 依存パッケージを不必要に追加していないか

### 8. ブランチ・commit 規律
- main ブランチを変更していないか
- commit / push をユーザー承認なしに行っていないか

---

## Decision 基準

| decision     | 条件 |
|:-------------|:-----|
| `approve`    | 上記 8 項目すべて問題なし・全テスト pass |
| `revise`     | 修正可能な問題あり → `instructions_to_claude` に具体的な修正指示を記載 |
| `needs_user` | AI だけでは決められない判断・実 DB 変更要否・外部公開の可否 など |

`approve` でも全テスト pass していない場合は `revise` を返すこと。
Structured Output が壊れている・decision が上記 3 択以外の場合は失敗として扱う（`approve` 扱いにしない）。
