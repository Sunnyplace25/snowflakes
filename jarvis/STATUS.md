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
| 第4段階前半 | 予約管理・事前確認・dry-run（X/Instagram/YouTube） | ✅ 完了 | `48cf107` |
| 第4段階 TikTok追加 | TikTok下書き生成・予約管理・preflight追加 | ✅ 完了 | `c6847d0` |
| 第4段階 note追加 | note記事下書き生成・エクスポート・preflight | ✅ 完了 | `d5efde0` |
| 第4段階後半 Phase 1A | YouTube OAuth秘密領域・安全設定 | ✅ 完了 | `11a9fdd` |
| オーケストレーター C1 | タスク状態ストレージ準備（tasks/.gitkeep） | ✅ 完了 | `1871573` |
| オーケストレーター C2 | task_manager.js / logger.js | ✅ 完了 | `b41e347` |
| オーケストレーター C3 | safety_guard.js / budget_tracker.js | ✅ 完了 | `6bdfd4d` |
| オーケストレーター C4 | context_builder.js | ✅ 完了 | `03a0ae4` |
| オーケストレーター C5 | openai_client.js | ✅ 完了 | `f394da1` |
| オーケストレーター C6 | orchestrator.js / task_manager.js / safety_guard.js / logger.js | ✅ 完了 | `cafe250` |
| オーケストレーター C7 | file_executor.js / openai_client.js / orchestrator.js / logger.js | ✅ 完了 | `8dc93b2` |
| オーケストレーター C8 | test_runner.js / task_manager.js / openai_client.js / orchestrator.js / logger.js | ✅ 完了 | `a3eab19` |
| オーケストレーター C9 | review_manager.js / task_manager.js / logger.js | ✅ 完了 | `f465c7a` |
| Integration Fix 1 | task_manager.js / orchestrator.js / file_executor.js / test_runner.js | ✅ 完了 | `4989261` |
| Safe REVISING Recovery | recovery_manager.js（新規） / task_manager.js / tests/test_recovery.js | ✅ 完了 | `6d8264f` |
| Top-level Task Runner | orchestrator/task_runner.js（新規） / run_task.js（新規） / tests/test_task_runner.js（新規） / package.json | ✅ 完了 | `8a33d8a` |
| Final Integration Test | file_executor.js / test_runner.js（不具合修正） / tests/test_final_integration.js（新規） / STATUS.md | ✅ 完了 | `87cadd7` |

---

## 各段階の commit ID

- 第1段階: `59924bd feat(jarvis): add initial draft management foundation`
- 第2段階: `b50a7327534cf1d0e493fb807b82dd15df941efb feat(jarvis): add local draft approval workflow`
- 第3段階: `3553404771f3f070e15e9daf8de16a86f22359cd feat(jarvis): add SNS draft generation workflow`
- 第4段階前半: `48cf107 feat(jarvis): add local scheduling and YouTube preflight workflow`
- 第4段階 TikTok追加: `c6847d0 feat(jarvis): add TikTok draft and preflight workflow`
- 第4段階 note追加: `d5efde0 feat(jarvis): add local note article workflow`
- 第4段階後半 Phase 1A: `11a9fdd feat(jarvis): prepare YouTube OAuth secrets area and settings`
- C1: `1871573 chore(jarvis): prepare orchestrator task state storage`
- C2: `b41e347 feat(jarvis): add orchestrator task state and logging`
- C3: `6bdfd4d feat(jarvis): add orchestrator safety and budget guards`
- C4: `03a0ae4 feat(jarvis): add orchestrator context builder`
- C5: `f394da1 feat(jarvis): add orchestrator OpenAI client`
- C6: `cafe250 feat(jarvis): add orchestrator planning workflow`
- C7: `8dc93b2 feat(jarvis): add safe file execution workflow`
- C8: `a3eab19 feat(jarvis): add safe test execution workflow`
- C9: `f465c7a feat(jarvis): add review and approval workflow`
- Integration Fix 1: `4989261 fix(jarvis): repair orchestrator phase integration`
- Safe REVISING Recovery: `6d8264f feat(jarvis): add safe revising recovery`
- Top-level Task Runner: `8a33d8a feat(jarvis): add top-level task runner`
- Final Integration Test: `87cadd7 fix(jarvis): complete final integration flow`

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
| `jarvis/tools/manage_schedule.js` | 第4段階前半 | ✅ 新規作成済み（第4段階 TikTok追加で更新） |
| `jarvis/tools/preflight_check.js` | 第4段階前半 | ✅ 新規作成済み（第4段階 TikTok追加で更新） |
| `jarvis/tools/generate_tiktok_draft.js` | 第4段階 TikTok追加 | ✅ 完成 |
| `jarvis/tools/generate_note_draft.js` | 第4段階 note追加 | 🔄 新規作成済み・未commit |
| `jarvis/tools/export_note_draft.js` | 第4段階 note追加 | 🔄 新規作成済み・未commit |

---

## NPMコマンド一覧

| コマンド | 内容 |
|----------|------|
| `npm run draft` | サイト更新・活動報告などの下書き生成 |
| `npm run sns-draft` | XとInstagram用SNS下書き生成 |
| `npm run youtube-draft` | YouTube動画予約情報の下書き生成 |
| `npm run tiktok-draft` | TikTok動画下書きの生成 |
| `npm run note-draft` | note記事下書きの生成 |
| `npm run note-export -- <id>` | note記事のエクスポート（MD/テキスト/JSON） |
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

## Final Integration Test 結果

| 項目 | 結果 |
|------|------|
| A–L 12テスト | 12 tests passed / 0 failed |
| A: 新規タスク → planning → WAITING_FOR_APPROVAL で安全停止 | ✅ |
| B: WAITING_FOR_APPROVAL → runner 再実行しても前進しない | ✅ |
| C: 人間承認後 → IMPLEMENTING→TESTING→REVIEWING→WFA 自動チェーン | ✅ |
| D: review 承認なし → COMPLETED 不可・承認後のみ COMPLETED | ✅ |
| E: REVISING → runner 停止・requires_recovery:true | ✅ |
| F: recoverRevising → IMPLEMENTING 再開・二重復旧防止 | ✅ |
| G: COMPLETED/FAILED/CANCELLED → terminal:true で二重実行しない | ✅ |
| H: PAUSED → runner が勝手に再開しない | ✅ |
| I: planning 失敗（モックエラー）→ FAILED・JSON 破損なし | ✅ |
| J: IMPLEMENTING を繰り返しても二重反映されない | ✅ |
| K: runner 出力にAPIキー・シークレットが含まれない | ✅ |
| L: 外部通信 0 件（すべてモック） | ✅ |
| 発見・修正した不具合 | file_executor.js / test_runner.js（計2箇所） |
| OpenAI 実通信 | 0件 |
| 外部通信 | 0件 |

### 修正内容

`plan.requires_human_approval === true` のまま `finalizePlanningApproval` で承認後、
`executeFilePlan` および `runTestPhase` が `APPROVAL_REQUIRED` で実行をブロックしていた。

修正: 両モジュールで `task.approval_result?.stage === 'planning' && decision === 'approve'`
を確認し、承認済みの場合は実行を許可するよう最小修正した。

---

## Top-level Task Runner テスト結果

| 項目 | 結果 |
|------|------|
| T1–T11（T9b含む） | 11 tests passed / 0 failed |
| taskId・phase 未指定 → INVALID_ARGUMENT | ✅ |
| 存在しないtaskId → TASK_NOT_FOUND | ✅ |
| TERMINAL状態（COMPLETED）→ terminal:true | ✅ |
| STOP状態（WAITING_FOR_APPROVAL）→ 即停止 | ✅ |
| STOP状態（REVISING）→ requires_recovery:true | ✅ |
| 新規タスク作成 + callOpenAI モック → 承認待ち停止 | ✅ |
| dry_run=true → 1フェーズのみ・状態変化なし | ✅ |
| IMPLEMENTING → TESTING → REVIEWING → WAITING 自動チェーン | ✅ |
| getTaskStatus 正常系 / TASK_NOT_FOUND | ✅ |
| listAllTasks に作成タスクが含まれる | ✅ |
| OpenAI実通信 | 0件 |
| 外部通信 | 0件 |

---

## Safe REVISING Recovery テスト結果

| 項目 | 結果 |
|------|------|
| T1–T18 | 18 tests passed / 0 failed |
| 通常REVISING→IMPLEMENTING | ✅ |
| REVISING停止→復旧 | ✅ |
| 二重実行防止（WRONG_STATE） | ✅ |
| IMPLEMENTING以外へ遷移しない | ✅ |
| confirmed_by_human ガード | ✅ |
| original_reason_code 保存 | ✅ |
| 既存フロー変更なし | ✅ |
| OpenAI実通信 | 0件 |
| 外部通信 | 0件 |

---

## Integration Fix 1 テスト結果

| 項目 | 結果 |
|------|------|
| T1–T44 | 52 assertions passed / 0 failed |
| Planning approve | WAITING_FOR_APPROVAL → IMPLEMENTING |
| Planning revise | WAITING_FOR_APPROVAL → PLANNING |
| C7 run_test | DEFERRED（planから削除しない） |
| C8 dry_run 0件 | 完全 read-only（byte-for-byte不変） |
| OpenAI実通信 | 0件 |
| 外部通信 | 0件 |

---

---

## Snow flakes Analytics + 収益・月次推移 MVP — 進捗

> ブランチ: `jarvis-development`

### 設計フェーズ（2026-08-12 完了）

| 項目 | 内容 | 状態 |
|------|------|------|
| 全体設計 | GA連携・SF収益・小説PV・SNS・音楽3サービス・ファネル分析 | ✅ 設計完了 |
| DB設計 | 14テーブル最終確定（既存2 + 新規12） | ✅ 確定 |
| Phase一覧 | Phase 1〜9 確定 | ✅ 確定 |
| 実装 | 未着手 | ⏳ 承認待ち |

### DBテーブル一覧（最終確定）

| テーブル | 区分 | 用途 |
|----------|------|------|
| `work_records` | 既存 | Business仕事レコード |
| `daily_status` | 既存 | Business日次状態 |
| `sf_works` | 新規 | 作品マスター |
| `sf_tracks` | 新規 | 楽曲マスター |
| `sf_track_work_links` | 新規 | 楽曲↔作品 M:N中間テーブル |
| `sf_revenue` | 新規 | SF収益（月次サマリー） |
| `sf_ga_daily` | 新規 | GA4日別スナップショット |
| `sf_narou_snapshot` | 新規 | なろう月次スナップショット |
| `sf_music_metrics` | 新規 | 音楽ストリーミング3サービス指標 |
| `sf_content_registry` | 新規 | SNSコンテンツ台帳 |
| `sf_social_metrics` | 新規 | SNS投稿別指標（正規化） |
| `sf_platform_ext` | 新規 | プラットフォーム固有指標 |
| `sf_account_daily` | 新規 | SNSアカウント日別集計 |
| `sf_funnel_event` | 新規 | ファネル基準点イベント |

### Phase一覧

| Phase | 内容 | 状態 |
|-------|------|------|
| Phase 1 | DB基盤（schema.sql 12テーブル追記 + sf_seed.js） | ✅ 完了（2026-08-12） |
| Phase 1.5 | 楽曲・リリース管理基盤（13テーブル追加 + Soundrop importer + Music Library Dashboard） | ✅ 完了（2026-08-12） |
| Phase 1.6 | catalog_builder.js（Soundrop Statement → sf_tracks/sf_releases 自動登録）+ ISRC_TITLE_OVERRIDES | ✅ 完了（2026-08-12） |
| Phase 2 | SF収益（revenue_writer.js + API 3エンドポイント）| ✅ 完了（2026-08-12） |
| Phase 3 | 小説PV・なろう（narou_writer / API 3エンドポイント / テスト） | ✅ 完了（2026-08-12） |
| Phase 4 | GA連携（ga_client / sf_ga_manager / API / Dashboard） | ⏳ 未着手 |
| Phase 5 | 音楽3サービス（music_csv_importer / sf_music_manager / API / Dashboard） | ⏳ 未着手 |
| Phase 6 | Instagram（instagram_client / social_manager / Dashboard） | ⏳ 未着手 |
| Phase 7 | YouTube（youtube_client OAuth2 / social_manager / Dashboard） | ⏳ 未着手 |
| Phase 8 | TikTok（tiktok_csv_importer / social_manager / Dashboard） | ⏳ 未着手 |
| Phase 9 | ファネル分析（sf_funnel_manager / API / Dashboard可視化 / Character Stage連動） | ⏳ 未着手 |

### Phase 1 完了記録（2026-08-12）

#### 実装内容

| 項目 | 内容 |
|------|------|
| schema.sql | 新規12テーブル・全インデックス追記 |
| sf_seed.js | 新規作成（作品4件・楽曲12件・リンク15件） |
| test_sf_schema.js | 新規作成（39テスト） |
| registry.json | sf_schema テスト追加 |

#### 追加・変更ファイル

| ファイル | 変更種別 |
|----------|---------|
| `jarvis/data/schema.sql` | 追記（12テーブル + インデックス） |
| `jarvis/data/sf_seed.js` | 新規作成 |
| `jarvis/tests/test_sf_schema.js` | 新規作成 |
| `jarvis/tests/registry.json` | sf_schema エントリ追加 |

#### テスト結果

| テストスイート | 結果 |
|----------------|------|
| test_sf_schema.js（Phase 1新規） | 39 passed / 0 failed ✅ |
| test_data_manager.js（回帰） | 29 passed / 0 failed ✅ |
| test_dashboard_api.js（回帰） | 32 passed / 0 failed ✅ |
| **合計** | **100 passed / 0 failed** |

#### 主な設計変更（前フェーズからの修正点）

- `sf_tracks.primary_work_id` を廃止。代表作品は `sf_track_work_links.link_type='primary'` のみで管理
- `sf_music_metrics.track_id` を NOT NULL FK に変更（曲名変更耐性）
- `sf_music_metrics` の UNIQUE 制約を `(date, granularity, platform, track_id)` に変更
- `sf_music_metrics.platform_track_id` TEXT カラム追加（配信サービス固有ID）
- `PRAGMA foreign_keys = ON` は db.js 既存設定で対応済み（変更不要を確認）

#### seed データ（初期マスター）

| テーブル | レコード数 | 主な内容 |
|----------|-----------|---------|
| sf_works | 4 | ひとつ多い音 / Under tone / Quietly Falling / Moon Veil |
| sf_tracks | 12 | Undertone / Spring Waltz / Aftertone / Little Snow / 音が消えるまでは / Signal / グラスの縁 / Rabbit / ハッピーエンドはいらない / 置いた音 / SWEETs / 呼吸の距離 |
| sf_track_work_links | 15 | primary 12件 + related 3件（spring_waltz, oita_oto, sweets_track → Quietly Falling） |

#### 未解決事項

- 各作品の `published_at` は NULL（正確な初公開日は別途更新要）
- 各楽曲の `release_date` は NULL（リリース日は別途更新要）
- SWEETsゲート楽曲（SWEETs）の `track_key` は `sweets_track`（DB名）と `SWEETs`（配信名）が異なる点を注意

### Phase 1.5 完了記録（2026-08-12）

#### 実装内容

| 項目 | 内容 |
|------|------|
| schema.sql | 新規13テーブル追記（Phase 1.5） |
| db.js | `runMigrations()` 追加（sf_tracks へ8カラム ALTER TABLE） |
| sf_manager.js | 新規作成（楽曲・リリース・プロフィール・プレビュー CRUD） |
| soundrop.js + 周辺 | Soundrop importer 一式（csv_parser / track_matcher / metrics_writer） |
| api.js | SF API 16エンドポイント追加 |
| index.html | SF タブに Music Library サブタブ3枚追加 |
| modules/sf.js | Music Library 全レンダリング関数・サブタブ切替ロジック追加 |
| style.css | .sf-tabs / .sf-table / .sf-badge 等スタイル追加 |
| test_sf_schema_15.js | 新規作成（71テスト） |
| test_soundrop_importer.js | 新規作成（24テスト） |
| registry.json | sf_schema_15 / soundrop_importer エントリ追加 |
| imports/soundrop/.gitkeep | Soundropレポート格納ディレクトリ |

#### 追加・変更ファイル

| ファイル | 変更種別 |
|----------|---------|
| `jarvis/data/schema.sql` | 追記（13テーブル + インデックス） |
| `jarvis/data/db.js` | `runMigrations()` 追加 |
| `jarvis/data/sf_manager.js` | 新規作成 |
| `jarvis/importers/soundrop.js` | 新規作成 |
| `jarvis/importers/parsers/csv_parser.js` | 新規作成 |
| `jarvis/importers/matchers/track_matcher.js` | 新規作成 |
| `jarvis/importers/writers/metrics_writer.js` | 新規作成 |
| `jarvis/imports/soundrop/.gitkeep` | 新規作成（ディレクトリ） |
| `jarvis/dashboard/api.js` | SF API 16エンドポイント追記 |
| `jarvis/dashboard/public/index.html` | SF サブタブ3枚追加 |
| `jarvis/dashboard/public/modules/sf.js` | Music Library UI 全追加 |
| `jarvis/dashboard/public/style.css` | SF Library スタイル追加 |
| `jarvis/tests/test_sf_schema_15.js` | 新規作成 |
| `jarvis/tests/test_soundrop_importer.js` | 新規作成 |
| `jarvis/tests/registry.json` | 2エントリ追加 |

#### テスト結果

| テストスイート | 結果 |
|----------------|------|
| test_sf_schema_15.js（Phase 1.5新規） | 71 passed / 0 failed ✅ |
| test_soundrop_importer.js（新規） | 28 passed / 0 failed ✅ |
| test_sf_schema.js（Phase 1回帰） | 39 passed / 0 failed ✅ |
| test_data_manager.js（回帰） | 29 passed / 0 failed ✅ |
| test_dashboard_api.js（回帰） | 32 passed / 0 failed ✅ |
| **合計** | **199 passed / 0 failed** |

#### Phase 1.5 テーブル一覧（計13テーブル追加、累計27テーブル）

| テーブル | 用途 |
|----------|------|
| `sf_track_files` | 音源ファイル台帳（参照のみ） |
| `sf_track_lyrics` | 歌詞管理（多言語・多バージョン） |
| `sf_releases` | Single/EP/Albumマスター |
| `sf_release_tracks` | リリース↔楽曲 M:N |
| `sf_release_artworks` | ジャケット管理（参照のみ） |
| `sf_credits` | クレジット（楽曲・リリース両対応） |
| `sf_distributions` | Soundrop配信管理（リリース単位） |
| `sf_distribution_imports` | Soundropインポートログ |
| `sf_distribution_import_rows` | インポート生データ行 |
| `sf_artist_profiles` | アーティストページ管理 |
| `sf_track_releases` | 楽曲単位ストア情報 |
| `sf_release_platforms` | リリース単位ストア情報 |
| `sf_track_previews` | 公式サイトデモ音源管理 |

#### sf_tracks 追加カラム

`status` / `created_date` / `duration_sec` / `isrc` / `source_service` / `source_id` / `source_url` / `memo`

#### Soundrop Importer 設計

- 照合優先順位: ISRC → UPC → track_key → unmatched（needs_review=1）
- 冪等性: INSERT OR IGNORE で重複取込安全
- ステータス管理: pending → processing → completed / partial / failed
- 格納先: `jarvis/imports/soundrop/`（.gitignore対象推奨）

### Phase 1.6 完了記録（2026-08-12）

#### 実装内容

| 項目 | 内容 |
|------|------|
| catalog_builder.js | 新規作成（Soundrop Statement CSV → sf_tracks/sf_releases 自動登録） |
| ISRC_TITLE_OVERRIDES | catalog_builder.js に追加（ISRCをキーにした公式タイトル補正マップ） |
| test_catalog_builder.js | 新規作成（46テスト）。Section 9: タイトル保護、Section 10: ISRC_TITLE_OVERRIDES |
| registry.json | catalog_builder エントリ追加 |

#### 追加・変更ファイル

| ファイル | 変更種別 |
|----------|---------|
| `jarvis/importers/catalog_builder.js` | 新規作成 |
| `jarvis/tests/test_catalog_builder.js` | 新規作成 |
| `jarvis/tests/registry.json` | catalog_builder エントリ追加 |

#### sf_tracks 照合ロジック

1. **ISRC完全一致** → 既存レコードをUPDATE（track_key/id変更なし）
   - ISRC_TITLE_OVERRIDES あり → title + status を補正タイトルで更新
   - ISRC_TITLE_OVERRIDES なし → status のみ更新（既存 title 保護）
2. **ISRC不一致 → title完全一致 + isrc IS NULL**
   - 1件一致 → ISRCとstatus='released'をUPDATE（track_key/id変更なし）
   - 0件 → 新規INSERT（track_key='isrc_'+ISRC.toLowerCase()）
   - 2件以上 → needs_review に記録（自動確定しない）

#### ISRC_TITLE_OVERRIDES ポリシー

- Soundrop Statement の Track Title が正式タイトルと異なる場合に登録する
- キー: ISRC（大文字）、値: 正式タイトル
- INSERT / ISRC一致 UPDATE のいずれのパスでも補正タイトルが優先される
- 空DBから再構築しても正式タイトルが自動的に適用される（永続設定）
- 現在の登録: `QZPJ32548359` → `'Little Snow (Raw)'`

#### sf_releases 登録ルール

- UPC一致 → スキップ（既存優先）
- 1 ISRC/UPC → release_type='single' で自動登録
- 複数ISRC/UPC + options.releaseTypes[upc]指定あり → 指定値を使用
- 複数ISRC/UPC + 指定なし → 登録保留（needs_review）

#### テスト結果

| テストスイート | 結果 |
|----------------|------|
| test_catalog_builder.js（Phase 1.6） | 46 passed / 0 failed ✅ |
| test_soundrop_importer.js（回帰） | 28 passed / 0 failed ✅ |
| test_sf_schema_15.js（回帰） | 71 passed / 0 failed ✅ |
| test_sf_schema.js（回帰） | 39 passed / 0 failed ✅ |
| test_data_manager.js（回帰） | 29 passed / 0 failed ✅ |
| test_dashboard_api.js（回帰） | 32 passed / 0 failed ✅ |
| **合計** | **245 passed / 0 failed** |

#### 確認済み動作（3か月分Statement相当）

| 確認項目 | 結果 |
|----------|------|
| 9曲が重複なく登録される | ✅ |
| 4リリース（3 single + 1 ep）が登録される | ✅ |
| Little Snow / SWEETs / 置いた音 の track_key/id 維持 | ✅ |
| sf_release_tracks 9件リンク | ✅ |
| sf_distributions 4件（soundrop/distributed） | ✅ |
| 同じCSVを再実行しても重複しない | ✅ |
| needs_review = 0件 | ✅ |
| "Still "（末尾スペース）→ trim後 "Still" で正常登録 | ✅ |
| 空DB再構築時に QZPJ32548359 が "Little Snow (Raw)" で登録される | ✅ |
| QZPJ32548356（override 未設定）が "Little Snow (Near)" のまま登録される | ✅ |
| ISRC一致 re-import 時に override タイトルが適用される | ✅ |
| override なし ISRC の手動修正タイトルが上書きされない | ✅ |

---

### Phase 2 完了記録（2026-08-12）

#### 実装内容

| 項目 | 内容 |
|------|------|
| schema.sql | sf_revenue に `transaction_month TEXT` / `quantity INTEGER` 追加、インデックス2本体制に移行 |
| db.js | Phase 2 migration 追加（各 ALTER TABLE を個別 try/catch、インデックス再構築） |
| revenue_writer.js | 新規作成（Soundrop Statement CSV → sf_revenue UPSERT） |
| api.js | `/api/sf/revenue/monthly` / `/by-track` / `/by-service` 3エンドポイント追加 |
| test_revenue_writer.js | 新規作成（20テスト） |
| registry.json | revenue_writer エントリ追加 |

#### 追加・変更ファイル

| ファイル | 変更種別 |
|----------|---------|
| `jarvis/data/schema.sql` | 変更（sf_revenue 拡張・インデックス更新） |
| `jarvis/data/db.js` | 変更（Phase 2 migration 追加） |
| `jarvis/importers/revenue_writer.js` | 新規作成 |
| `jarvis/dashboard/api.js` | 変更（3エンドポイント追加） |
| `jarvis/tests/test_revenue_writer.js` | 新規作成 |
| `jarvis/tests/registry.json` | 変更（エントリ追加） |

#### sf_revenue 設計

| カラム | 用途 |
|--------|------|
| `month` | statement_period（Soundrop 明細発行月 YYYY-MM）|
| `transaction_month` | 実際の再生・売上発生月（YYYY-MM）/ 旧パスは NULL |
| `quantity` | 再生数・UGC使用数の集計合計 |
| `amount` | Net Revenue in USD の集計合計（USD建て）|
| `platform` | Service 列の値そのまま（例: `TikTok`, `Apple Music`）|

#### インデックス体制

| インデックス | 対象パス | 条件 |
|-------------|----------|------|
| `idx_sf_revenue_csv_track` | soundrop.js / metrics_writer.js（旧パス）| `transaction_month IS NULL` |
| `idx_sf_revenue_statement` | revenue_writer.js（Phase 2）| `transaction_month IS NOT NULL` |

#### API エンドポイント

| エンドポイント | クエリパラメータ | 説明 |
|---|---|---|
| `/api/sf/revenue/monthly` | `basis=transaction`（デフォルト）/ `statement` | 月別売上合計 |
| `/api/sf/revenue/by-track` | `basis`, `month=YYYY-MM` | 楽曲別売上合計 |
| `/api/sf/revenue/by-service` | `basis`, `month=YYYY-MM` | サービス別売上合計 |

#### テスト結果

| テストスイート | 結果 |
|----------------|------|
| test_revenue_writer.js（Phase 2新規） | 20 passed / 0 failed ✅ |
| test_catalog_builder.js（回帰） | 46 passed / 0 failed ✅ |
| test_soundrop_importer.js（回帰） | 28 passed / 0 failed ✅ |
| test_sf_schema_15.js（回帰） | 71 passed / 0 failed ✅ |
| test_sf_schema.js（回帰） | 39 passed / 0 failed ✅ |
| test_data_manager.js（回帰） | 29 passed / 0 failed ✅ |
| test_dashboard_api.js（回帰） | 32 passed / 0 failed ✅ |
| **合計** | **265 passed / 0 failed** |

---

### Phase 3 完了記録（2026-08-12）

#### 実装内容

| 項目 | 内容 |
|------|------|
| narou_writer.js | 新規作成（sf_narou_snapshot へ UPSERT・import_source='manual'） |
| api.js | `/api/sf/narou/summary` / `monthly` / `compare` 3エンドポイント追加 |
| test_narou.js | 新規作成（25テスト・Section 1〜3） |
| registry.json | narou エントリ追加 |

#### 追加・変更ファイル

| ファイル | 変更種別 |
|----------|---------|
| `jarvis/importers/narou_writer.js` | 新規作成 |
| `jarvis/dashboard/api.js` | 変更（3エンドポイント追加） |
| `jarvis/tests/test_narou.js` | 新規作成 |
| `jarvis/tests/registry.json` | 変更（narou エントリ追加） |

#### API エンドポイント

| エンドポイント | クエリパラメータ | 説明 |
|---|---|---|
| `/api/sf/narou/summary` | `work_id=`（省略時は全作品） | 各 ncode の最新スナップショット + sf_works JOIN |
| `/api/sf/narou/monthly` | `ncode=`（省略時は全作品） | 月別 PV 推移（month/ncode/pv_monthly/pv_total/bookmark_count/point） |
| `/api/sf/narou/compare` | `metric=pv_total|pv_monthly|bookmark_count|point|review_count`（デフォルト: pv_total） | 作品別最新値比較・降順 |

#### テスト結果

| テストスイート | 結果 |
|----------------|------|
| test_narou.js（Phase 3新規） | 25 passed / 0 failed ✅ |
| test_revenue_writer.js（回帰） | 20 passed / 0 failed ✅ |
| test_catalog_builder.js（回帰） | 46 passed / 0 failed ✅ |
| test_soundrop_importer.js（回帰） | 28 passed / 0 failed ✅ |
| test_sf_schema_15.js（回帰） | 71 passed / 0 failed ✅ |
| test_sf_schema.js（回帰） | 39 passed / 0 failed ✅ |
| test_data_manager.js（回帰） | 29 passed / 0 failed ✅ |
| test_dashboard_api.js（回帰） | 32 passed / 0 failed ✅ |
| test_ai_bridge.js（回帰） | 33 passed / 0 failed ✅ |
| **合計** | **323 passed / 0 failed** |

---

#### 未確認データ（Phase 1.5 seed 対象外）

| ファイル名（推定） | 理由 |
|----------------|------|
| kaeranai | 正式タイトル・status未確認 |
| natsunomoon | 正式タイトル・status未確認 |
| shukusou | 正式タイトル・status未確認 |
| nigaipurin | 正式タイトル・status未確認 |
| shiroiimama | 正式タイトル・status未確認 |
| madakokoni | 正式タイトル・status未確認 |
| madanatteru | 正式タイトル・status未確認 |
| iawasete | 正式タイトル・status未確認 |
| sweets BGM系 | 正式タイトル・status未確認 |

確認後は `sf_tracks` に `status='unknown'` で登録し、判明次第更新すること。

---

### 注意事項

- `related_work` / `related_track` TEXT参照は廃止。`work_id` / `track_id` FK参照に統一済み
- GA認証: Service Account（`jarvis/secrets/ga_service_account.json`、.gitignore対象済）
- YouTube認証: OAuth2（`jarvis/secrets/youtube_token.json`、.gitignore対象済）
- TikTok / Spotify / Apple Music / Amazon Music: CSV取込ベース（将来API拡張可）
- ファネル分析: `sf_funnel_event` を基準点として各テーブルをJOIN
- STATUS.mdはPhase完了ごとに必ず更新すること

---

## 変更禁止ファイル

- `jarvis/tools/generate_draft.js`（既存・変更禁止）
- `jarvis/tools/manage_drafts.js`（既存・変更禁止）
- `jarvis/tools/generate_sns_draft.js`（既存・変更禁止）
- `jarvis/tools/generate_tiktok_draft.js`（既存・変更禁止）
- サイト本体の既存ファイル全般

---

## 安全ルール（必ず守ること）

- 未追跡の音声ファイル（`music/`, `sweets/` の `.mp3` / `.wav`）には絶対に触れない
- `git add .` は禁止。追加する場合は対象ファイルを個別指定する
- `commit` / `push` / `main へのマージ` は山吹ことり様の承認なしに実行しない
