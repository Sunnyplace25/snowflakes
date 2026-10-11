# JARVIS × Metricool / vidIQ 統合方針（2026-10-11）

## この文書の位置づけ
- 2026-10-11時点の比較結果と、ローカル最新版へ適用するための実装仕様。**本書の追加だけでは外部連携は稼働しない。**
- 調査対象の GitHub jarvis-development ブランチ HEAD は e329b8e（2026-09-11）。ローカル D:\JARVIS\jarvis にある10月の変更は未照合。コード変更・マイグレーション・既存機能削除は、ローカル最新版の現状確認後に限る。
- ChatGPT内で接続済みのプラグイン認証は、JARVIS本体やClaude Codeへ自動共有されない。各クライアントで個別に認可する。

## 判断（全面置き換えはしない）
| 機能 | 採用元 | 根拠 |
|---|---|---|
| Instagram/YouTubeの日次履歴保存・比較 | JARVIS既存 | 正規化DB・既存同期・可視化・作品別分析を維持。外部無料プランの履歴制限に依存しない |
| GA4／音楽配信／なろう／KDP／収益の横断分析 | JARVIS既存 | 外部SNSツール単体では扱えない独自統合領域 |
| 投稿企画・下書き・公開前チェック・人間承認 | JARVIS既存 | preflight、承認、dry-runを維持 |
| Instagramなどの投稿予約・運用カレンダー | Metricool優先（任意接続） | 複数SNS運用UIが充実。投稿先が接続可能な場合のみ |
| YouTubeキーワード・競合・タイトル／サムネイル改善 | vidIQ優先（オンデマンド） | 研究・企画向け専用ツール。使用クレジットを管理 |
| 作品との紐付け・投稿後の効果検証 | JARVIS既存 | JARVIS内の作品ID・リリースIDと公式データを結合 |

## 現行リポジトリで確認した実装
- importers/instagram_collector.js：Instagram Graph API のアカウント・投稿・インサイト取得
- importers/youtube_channel_collector.js：チャンネル、動画、流入元、engagedViews対応
- data/sf_sync_manager.js：日次AUTO同期、ソース別失敗分離、鮮度監視、重複アラート抑制
- automation/sf_ops_runner.js：GA4とSNS同期のCLI実行
- data/sf_funnel_manager.js：ファネル分析。プラットフォーム指標の異種合算・因果断定を禁止
- tools/manage_schedule.js と tools/preflight_check.js：予約管理、投稿前検証、dry-run
- dashboard/api.js と public/modules/sf.js：Instagram/YouTube/SNS Syncの画面・API

## 外部接続条件の確認
- Metricool MCP URL: https://ai.metricool.com/mcp 。FreeでもMCP利用可能。Freeの分析履歴は30日、予約上限20件。独自HTTP APIはAdvanced/Customのみ。
- vidIQ MCP URL: https://mcp.vidiq.com/mcp 。プランに応じたクレジット制。2026-10-11の確認値は残150／更新上限150、次回更新2026-11-10 UTC。検索・分析にはクレジットがかかるため定期一括全走査はしない。
- ChatGPTで確認した接続対象: MetricoolのInstagram snowflakes_story、vidIQのYouTubeチャンネルID UCL70O3byplFl3nUBMaqSoVw。
- 上記のMCP接続をClaude Codeに追加するだけではJARVIS Webダッシュボードには組み込まれない。本体への実装はバックエンドの安全なMCPクライアント、別途OAuth/API認証、結果変換が必要。

## 費用制御ポリシー（2026-10-11 追加・最優先）
目的: JARVISへの機能統合に伴う新規・追加費用を原則0円とし、既存のClaude等の従量課金まで含めて利用量を制御する。

### 採用原則
- 新しい有料サブスクリプション、プランのアップグレード、有料アドオン、従量課金APIの有効化は行わない。必要が判明したら機能を停止・代替提案する。ユーザーの明示承認が必要。
- ChatGPT連携済みアカウントのOAuth/認証情報はJARVISへ自動移行できない。JARVIS側の接続は無料枠・MCP互換性の確認が済むまで提案止まり。
- Metricool MCPはFreeで利用可（1ブランド、月20予約投稿、履歴30日）。Metricoolの独自APIはAdvanced/Customが必要なので採用しない。
- vidIQはFree月150クレジット。基本的な調査等で1回5クレジット、動画フル視聴分析は25、サムネイル生成22など。現在残高150を確認。自動実行時の消費上限は0クレジットとし、ユーザーが必要時に明示的に選んだ操作だけ行う。
- 既存YouTube/Instagram公式API、GA4、JARVIS収集DBが取得済みの指標は再収集しない。vidIQはキーワード、類似動画、企画等、JARVISにない用途に限定。
- SNS投稿本文・分析レポートのAI生成は、ローカル集計とテンプレートを優先。外部有料AI APIの実行前に単価、推定消費量、当月利用量、超過額を評価し、課金可能性がある場合はユーザーの承認なしに実行しない。
- 外部ツールが無料枠・クレジット上限に達した場合、勝手に有料モードへフォールバックせず明示的に PLAN_LIMIT / CREDIT_LIMIT と記録する。
- SNS予約・投稿は無料プランの上限およびアカウント別制約を考慮し、投稿するかどうかはユーザーが承認する。勝手な自動再試行による二重投稿禁止。

### 実装で必要な監視項目
- provider / API名 / action名 / 実行時刻 / 呼び出し回数 / クレジット消費見込みと実測 / 金銭コスト見込みと実測 / 実行結果 / キャッシュヒットを保存する。キー・個人情報は保存しない。
- 月次上限: 新規サービス料金0円、追加の従量課金0円（設定変更はユーザーの明示承認時のみ）。vidIQ月150クレジット以下、日次自動使用0クレジット。
- 実行前ゲート: 同じ日時・同じアカウント・同じ指標を取得する場合はキャッシュ優先。既存DBに十分なデータがある場合は外部リクエスト禁止。
- 当月の使用量、残クレジット、あと何回調査可能か、停止理由をJARVIS内に表示する。推定と確定コストを区別する。
- AI呼び出しは必要なときにのみ行い、通常の定期レポートはDB集計で作成する。無限リトライ、自己対話ループ、バックグラウンド調査連続実行を禁止。
- 負荷テスト・回帰テストはモック/ローカルDBのみで実施し、実サービスに不要な通信をしない。
- 実装により月額固定費が増える可能性があると判明した機能は保留する。

### 参照（2026-10-11確認）
- https://help.metricool.com/mcp-limits-and-plan-requirements-h72jg
- https://help.metricool.com/main-differences-between-free-and-paid-plans-bl0v9
- https://support.vidiq.com/en/articles/15082430-vidiq-mcp

## ローカル最新版に対する実装手順
### 第0段階：現状照合（必須）
1. D:\JARVIS\jarvis のHEAD、未コミット差分、DBバックアップ、現行SNS画面／APIと既存集計テストを検査。同期やコード修正は行わず報告。
2. 旧コードと現行ローカルコードの機能差分を比較。JARVIS側に同等以上の機能がある場合は既存実装を優先。
3. 接続アカウント／利用可能プラン／OAuth権限を画面で確認。秘密情報をGit、DB、ログ、ChatGPTに出さない。

### 第1段階：非破壊統合（読み取り専用）
1. SNSダッシュボード内に「外部分析」領域を設け、Metricool／vidIQの接続状態、取得日時、アカウント識別子、クレジット残量（利用可能なら）を表示。
2. provider adapterを切り離し、外部MCPサービスの応答をJARVIS内の正規化形式へ変換。ネットワークAPI呼び出しはサーバー側のみ、timeout/rate-limit/retry/backoffを設定。
3. 同じ投稿は platform + external_post_id を一意キーとして二重取り込みを防ぐ。データには source、fetched_at、timezone、metric_definition、periodを保存。
4. 非互換指標は合算しない。views／engagedViews、reach／impressions、stream数の違いを明示し、値0と未取得nullを区別。
5. 接続エラー／クレジット不足／無料プランの履歴不足時は「未取得」と表示し、既存JARVISの表示と同期を継続。

### 第2段階：企画提案（オンデマンド）
1. vidIQからキーワード・競合・タイトル改善の候補を取得し、提案をJARVISの下書き・承認機構へ格納。取得ごとの消費クレジットを予算ガードで確認。
2. Metricoolの最適投稿時間や予約候補を表示。既存JARVISの作品・リリース予定と照合する。
3. 同一内容の二重予約を防ぐ。外部の予約がsource of truthなら予約IDと日時をローカルで参照し、二系統で自動投稿しない。

### 第3段階：投稿連携（明示承認後のみ）
1. 内容・媒体・予約時刻・アカウントを明示した承認画面を通過するまで外部書込みを一切実行しない。
2. 投稿／予約の成功レスポンスを確認してから状態更新。失敗した場合は再送前に外部状態を読み直し、二重投稿を防止。
3. 機能フラグで外部連携を無効化できるようにし、従来の下書き・同期を退避先として維持。既存機能の一括削除を禁止。

## テスト・受入条件
- OAuth無し・外部API停止・429・有効期限切れ・クレジット0・非対応アカウントでも本体の起動と既存SNS集計が継続する。
- 出力のAPIキー、アクセストークン、OAuth callback等に機密が混入しない。ポスト処理は承認までdry-run。
- DBマイグレーション前後のバックアップ・integrity_check、既存testsと追加モックテスト全件成功。
- external ID重複とJST/UTC跨ぎ、null/0、異なる集計対象期間、計測仕様変更をテスト。
- SNS旧同期と外部同期の値に差があった場合は優先順位を記録し、無言でデータを上書きしない。
- ローカル最新版を確認しない限り、Phase 39を含む既存機能へ変更を加えない。

## 参考（公式）
- https://help.metricool.com/mcp-vs-api-access-what-is-the-difference-5y3ib
- https://help.metricool.com/mcp-limits-and-plan-requirements-h72jg
- https://help.metricool.com/how-to-connect-metricools-mcp-eqp9h
- https://support.vidiq.com/en/articles/15082430-vidiq-mcp
