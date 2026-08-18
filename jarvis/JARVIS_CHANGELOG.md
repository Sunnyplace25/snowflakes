# JARVIS CHANGELOG

JARVIS 本体の変更記録。今後の JARVIS コード変更は必ずここへ追記する。

記録項目:
- 日付
- 目的 / ユーザー要望
- 変更ファイル
- 実装内容
- 確認内容
- 未確認 / 残課題
- commit SHA

---

## 2026-08-18 — Business / 保育園 / グラフ周辺の連続修正（要 Claude 再監査）

### 背景
Business ダッシュボードの保育園給与明細、シフト表示、タブ構成、実績分析、グラフ、仕事一覧スクロール等を ChatGPT 側から連続で修正したが、複数スクリプトが同じ DOM / タブを後から書き換える構造になり、一部変更が競合して「修正済みと報告したが画面に反映されていない」状態が発生した。

### この期間に扱った主な要望
- 保育園の保存済み給与明細は年別表示。デフォルトは今年。
- 保育園はサマリーを常時表示し、シフト・給与明細は折りたたみ。
- シフトを給与明細より上に表示。
- 保存済み明細一覧はさらに折りたたみ。
- シフト部分はスクロール表示。
- 保育園サマリーに「出勤日数」「休日日数」を追加。
- 保育園給与の総支給を収入グラフへ入れる。シフト自体はグラフに入れない。
- Business タブ名 / 順序を整理。
- 「月次」は「音声」へ変更。
- 「完全休日」は誤解を招くため「音声休み」へ変更。
- 仕事一覧だけスクロールし、上部ダッシュボードと今日の仕事は常時見えるようにする。
- スクロールバーを細く目立たなくする。
- 仕事一覧ヘッダーを不透明にし、下の行が透けないようにする。
- 「インポート内容を確認」ボタンがファイル選択後も disabled のままになる問題を修正。
- Google カレンダーと請求書は関連機能としてまとめ、使いやすくする。
- 実績分析とグラフは最終的に **分離**。グラフは独立タブで表示。
- グラフは「合計 / 音声 / パート / 物販」を切替可能にする。
- 合計は音声 / パート / 物販を色分けした積み上げ棒グラフ。
- 棒グラフをクリックすると月の内訳を表示。

### ChatGPT 側で変更・追加された主なファイル
- `jarvis/dashboard/public/business-nursery-payslip.js`
- `jarvis/dashboard/public/business-merch.js`
- `jarvis/dashboard/public/business-ui-fixes.js`
- `jarvis/dashboard/public/business-graph.html`
- `jarvis/dashboard/public/business-graph-enhance.js`
- `jarvis/dashboard/public/business-graph-v2.html`
- `CLAUDE.md`

### 重要な監査ポイント
1. `business-nursery-payslip.js` 末尾に、**実績分析とグラフを結合する古い navigation コードが残っている**。このコードは `実績分析（グラフ）` に戻し、独立グラフボタンを削除し、iframe を挿入するため、最新要望「実績分析とグラフは分離」と競合する。
2. `business-merch.js` 側でも Business タブ順やグラフを変更している。Business ナビを複数ファイルで触る状態を解消すること。
3. `business-ui-fixes.js` は作成済みだが、確認時点の `server.js` の index.html script injection には含まれていなかった。**ファイルが存在するだけで実行されていない可能性がある**。
4. `business-graph-enhance.js` はグラフ切替 / 積み上げ / 内訳クリック機能を持つが、読み込み経路を確認すること。`business-graph-v2.html` は enhancer を iframe 内へ注入するために追加されたが、最終的に採用する構成を一つに整理すること。
5. Business タブを clone / append / MutationObserver で再配置する実装が複数あり、イベントが消える・後勝ちで上書きされる・無限再配置に近い状態になるリスクがある。
6. 「インポート内容を確認」ボタンの disabled 修正は文字列検索ベースの後付け処理になっている可能性がある。元のボタン制御ロジックを特定して根本修正すること。
7. 「音声休み」の表示は UI ラベルだけでなく、元データの意味が「音声の休み」であることを確認すること。
8. 保育園の出勤日数 / 休日日数は status と start 時刻から後付け計算している。`有給` を休日日数に含めるかどうかは現在の仕様を確認し、ラベルと計算を一致させること。

### 既知の関連 commit
- `5efd1b055e6a63d870f918d52a77b23f4136f13b` 保育園給与明細 UI の折りたたみ・年別履歴
- `dd063ceef78a51b1d011d5f8309310c9c1cdd35d` 仕事一覧ヘッダー等の修正
- `3f881308874aac0d154c285f155584c3344027cd` / `e25b91d34c48e6b5ee5796222814118b22b3e85a` Business UI 補助ファイル追加
- `166d748df1697f9eb2fe7dd3bccae086319bd3ca` グラフ分離修正試行
- `b3c973d0f5caef17c9aac6402c7591f7a6396cf7` グラフリンク修正試行
- `45cdc014f11d27ef861738d6d05fe5a14df35ca7` Business UI 修正集約試行
- `d0769e8ee056d7f308311d4db5704eb327a6f57d` `business-graph-v2.html` 追加
- `6bf2af414da44dd37804219e6416a4ff8886dff7` Claude-first / 二重チェック運用を `CLAUDE.md` に追加

### 状態
**未完了 / Claude 再監査必須。**
画面での最終確認が取れていないため、上記を「実装済み」と扱わないこと。
