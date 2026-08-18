# Claude Audit Handoff — JARVIS Business Dashboard — 2026-08-18

## 最優先指示

このファイルを読んだら、**現行の `jarvis-development` をコードベースとして自分で監査し、以下を一括で直すこと。**
ChatGPT 側の「修正済み」という報告は信用せず、ブラウザへ実際に読み込まれるファイル・script injection・DOM 書き換え順・イベント競合まで確認する。

作業結果は必ず `jarvis/JARVIS_CHANGELOG.md` に追記する。

## ユーザーの最終要望

### Business タブ
最終的に **実績分析とグラフは分離**する。

見やすい順序を再確認して一貫した一か所の実装にする。少なくとも以下の名称を使用する。
- 実績分析
- グラフ
- 音声
- 物販
- パート（保育園）
- 請求・連携（この中で 請求書 / Googleカレンダー を切替）

`実績分析（グラフ）` という結合ラベルや、実績分析パネルへの graph iframe 埋め込みは削除する。

### グラフ
- 独立タブから確実に開ける。
- 年ごとの表示。
- 棒グラフ表示モードを `合計 / 音声 / パート / 物販` で切替。
- 合計は音声 / パート / 物販を色分けした積み上げ棒。
- パート収入は保存済み保育園給与明細の **総支給**を使用。
- 保育園シフトはグラフ集計に入れない。
- 棒をクリックすると、その月の各収入の内訳を表示。
- 既存の経費 / 利益表示を残すかは画面を見て整理してよいが、「収入の比較が主目的」であること。

### パート（保育園）
- サマリーは常時見える。
- シフトを給与明細より上にする。
- シフトは折りたたみ可能、かつ開いた一覧はスクロール式。
- 給与明細も折りたたみ。
- 保存済み明細一覧はさらに折りたたみ。
- 保存済み明細は年別表示、デフォルトは現在年。
- 出勤日数 / 休日日数をサマリーに表示。
- 既存保存データを壊さない。

### 音声 / 月次
- `月次` の表示名は `音声`。
- `完全休日` というラベルは使わず `音声休み` にする。保育園等の別仕事があるため「完全休日」は不正確。

### 仕事一覧
- 上の収入等ダッシュボードと「今日の仕事」は常に見える。
- 仕事一覧部分だけ縦スクロール。
- スクロールバーは細く目立たないデザイン。
- sticky header は完全不透明。スクロール中に下の行が透けて見えない。

### インポート
- `インポート内容を確認` ボタンがファイル選択後も無効のままになる問題を根本修正。
- 後付けで全 button を文字列検索して disabled=false にするだけの対症療法にしない。元の state / event / selector を特定する。

### 請求書 + Google Calendar
- 機能が連携しているためトップタブを `請求・連携` にまとめてよい。
- 内部で `請求書` / `Googleカレンダー` をサブタブとして切替できるようにする。
- 既存の請求書取込・Calendar 接続 / preview / execute / history を壊さない。

## 現時点で確認できた競合

### `business-nursery-payslip.js`
末尾に `// Business navigation: combine analytics + graph ...` が残っており、以下を行う古いコードがある。
- 実績分析を `実績分析（グラフ）` に書き換える
- 独立 graph button を削除する
- `business-analytics-graph` iframe を実績分析パネルへ追加する
- MutationObserver で繰り返しタブを並べ替える

これはユーザーの最終要望と正反対なので、削除 / 廃止すること。

### `business-merch.js`
物販本体以外に Business ナビ / scroll / fix を持たせる試行が重なっている。物販の責務と Business navigation の責務を分離すること。

### `business-ui-fixes.js`
後付け UI fix を集約する目的で作成されたが、確認時点の `server.js` では index.html へ注入されていない。ロードされないコードを残さない。採用するなら正式に読み込む、採用しないなら移植して削除候補にする。

### `business-graph-enhance.js`
希望する `合計 / 音声 / パート / 物販`、積み上げ棒、click 内訳の実装がある。ロジックを監査して、正式なグラフ画面から一度だけ確実にロードされる構造にする。

### `business-graph-v2.html`
ChatGPT が graph enhancer を確実に読み込ませるため追加した wrapper。場当たり対応なので、最終構成として必要か判断する。不要なら既存 `business-graph.html` に正式統合する方を優先。

## 必須監査対象

- `jarvis/dashboard/public/index.html`
- `jarvis/dashboard/public/app.js`
- `jarvis/dashboard/public/business-custom.js`
- `jarvis/dashboard/public/business-extra.js`
- `jarvis/dashboard/public/business-nursery-tab.js`
- `jarvis/dashboard/public/business-nursery-payslip.js`
- `jarvis/dashboard/public/business-merch.js`
- `jarvis/dashboard/public/business-ui-fixes.js`
- `jarvis/dashboard/public/business-graph.html`
- `jarvis/dashboard/public/business-graph-enhance.js`
- `jarvis/dashboard/public/business-graph-v2.html`
- `jarvis/dashboard/server.js`
- 関連 API / nursery manager / invoice / calendar 実装

## 進め方

1. `jarvis-development` の branch / HEAD / tracked changes を確認。
2. 上記ファイルを読んで、Business navigation を誰が触っているか一覧化。
3. **Business タブ制御を一か所に集約**。MutationObserver の競合を除去。
4. グラフを独立画面として確立。
5. 保育園 UI / scroll / count を整理。
6. import button 問題を根本修正。
7. 請求・連携をまとめる。
8. 関連テスト実行。JS 構文エラーも確認。
9. 可能ならローカルで Dashboard 起動し、各 Business タブを順番にクリックして回帰確認。
10. `jarvis/JARVIS_CHANGELOG.md` へ、変更内容・確認結果・未確認事項を追記。

## 完了条件

- タブを何度切り替えても開かなくならない。
- 実績分析とグラフが明確に別。
- グラフが独立タブから開き、希望の切替 / 積み上げ / 内訳が動く。
- 保育園シフト / 給与明細 / 保存済み明細の表示構造が希望通り。
- 仕事一覧 scroll / header が視覚的に破綻しない。
- `インポート内容を確認` が正常に有効化される。
- 請求書と Google Calendar が `請求・連携` 内で正常に使える。
- 変更履歴が `jarvis/JARVIS_CHANGELOG.md` に残っている。

**途中で場当たり的な JS を追加するより、重複した制御を消して一か所へ整理することを優先する。**
