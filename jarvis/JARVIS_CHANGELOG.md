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

## 2026-08-19 — 請求書：出力ファイル名を生成画面で指定可能に

### 目的
生成画面で保存ファイル名を指定できるようにする。
デフォルト名は請求日を使って `YYYY年M月D日_請求書_大和谷しおり.xlsx` 形式で自動生成。
請求書番号は DB 管理のまま変更なし。

### 変更ファイル
- `data/invoice_generator.js`
- `dashboard/public/business-custom.js`

### 実装内容

**invoice_generator.js**
- `defaultOutputFilename(issueDate)` 関数追加：`YYYY-MM-DD → YYYY年M月D日_請求書_大和谷しおり.xlsx`
- `sanitizeFilename(name)` 関数追加：Windows 禁止文字 `\ / : * ? " < > |` を除去
- `generateInvoiceWorkbook()` に `output_filename` パラメータ追加
  - 指定あり: サニタイズ後 `.xlsx` 自動付与、出力パスに使用
  - 指定なし（空文字/null）: `defaultOutputFilename(issueDate)` を使用
  - 旧デフォルト `請求書_${safeNumber}.xlsx` は廃止

**business-custom.js**
- `invoiceDefaultFilename(invoiceDate)` ヘルパー追加（JS側デフォルト名生成）
- `renderInvoiceGenerationPreview()` のプレビューフォームに「出力ファイル名」入力欄追加
  - デフォルト値: 請求日から自動計算
  - 請求日変更時: ファイル名未手動編集なら自動更新（`data-user-modified` フラグで追跡）
  - 手動編集後: 請求日変更に追従しない
- `generateInvoiceExcel()` のリクエスト body に `output_filename` 追加

### 確認結果
- デフォルト名テスト `2026-09-01` → `2026年9月1日_請求書_大和谷しおり.xlsx` ✓
- ファイル生成・ダウンロード: server.js は `body` を `generateInvoiceWorkbook` に直渡しのため追加変更なし ✓
- invoice_number DB 管理は変更なし ✓

### 未確認 / 残課題
- ブラウザ UI での目視確認（ユーザーに依頼）

### commit SHA：未採番（commit 前）

---

## 2026-08-20 — 請求書25行対応：全機能完成・スタイル完全正規化（最終確認済み）

### 目的
請求書明細の最大25行対応（テンプレート20行 → 生成時5行動的拡張）を完成させ、
実ファイル目視確認で発見された視覚不具合をすべて修正。
テスト・機械監査・印刷プレビューまで完了。

### 変更ファイル
- `data/generate_invoice_py.py`（メイン生成スクリプト）
- `data/invoice_generator.js`（Node.js ラッパー）
- `dashboard/public/business-custom.js`（生成UI）

---

### 実装済み機能（全体まとめ）

**明細行数対応**
- 最大25件まで対応（テンプレート基準20件 → コピー側に5行動的挿入）
- 26件以上は `ValueError` でエラー終了
- 20件以下は従来レイアウト完全維持
- 拡張時の行シフト・数式参照・マージセル・CF sqref を自動更新

**数式・集計セルの参照位置修正**
- `D11`（合計金額表示）の参照先を拡張後の `L41` に自動更新
- 小計・消費税・合計セルの参照が拡張後も正しく動作
- 支払期限（`D46`）: 手動指定値を Excel シリアル値で上書き反映

**出力ファイル名指定**
- 生成画面に「出力ファイル名」入力欄を追加
- デフォルト: `YYYY年M月D日_請求書_大和谷しおり.xlsx`（請求日から自動生成）
- 請求日変更時: 未手動編集ならファイル名を自動追従
- 手動編集後は追従しない（`data-user-modified` フラグ）
- Windows 禁止文字を自動サニタイズ・`.xlsx` 自動付与

**原本テンプレート保護**
- `shutil.copy2()` → tmp ファイル差し替え方式により原本を一切変更しない

---

### 視覚不具合修正（今回最終対応）

| # | 不具合 | 根本原因 | 修正 |
|---|---|---|---|
| 1 | B29/C29 赤文字（13件目） | テンプレート row 29 に `xf[165/166]`（font FFFF0000）が混入 | `fix_sheet_layout()` に `BC_STYLE_MAP` 追加、全明細スキャンで自動正規化 |
| 2 | I32 Calibri 残存（16件目） | テンプレート I32 が `xf[168]`（Calibri 11pt）で I_STYLE_MAP 対象外 | `I_STYLE_MAP` に `'168': '111'` 追加 |
| 3 | H列 配置ずれ | `rewrite_styles_xml()` で誤って center を付与 | 変更を削除、元の right を維持（H右寄せ/I左寄せ） |
| 4 | 20件目に不要な下罫線 | Step 2 で D/E/F セル（borderId=60, bottom:thin）が残留 | `expand_detail_rows()` Step 2 で D/E/F セルを明示的に削除 |
| 5 | 25件目 I41 が青背景 | 奇数最終行に偶数用 `xf[188]`（fillId=4 青）を使用 | `rewrite_styles_xml()` で fillId=0 の clone を追加（→ xf[386]）、奇数最終行に使用 |
| 6 | CF sqref が行36 止まり | テンプレート CF が `...:36` 固定 | `expand_detail_rows()` Step 5 で末端行を new_last に自動拡張 |
| 7 | I列 Meiryo 統一 | 行 25 以降テンプレートが Calibri 切替、`I_STYLE_MAP` 未対応の xf が複数存在 | `I_STYLE_MAP: {'160':'153', '164':'111', '168':'111', '175':'188'}` で全件正規化 |

---

### 機械監査結果（A17:M41 全セル）

| 確認項目 | 結果 |
|---|---|
| 赤文字 | なし ✓ |
| Calibri 残存 | なし ✓ |
| H17:H41 alignment | 全件 h=right ✓ |
| I17:I41 font | 全件 Meiryo 13pt / 黒 / h=left ✓ |
| I列 奇数行 fill | None（白）✓ |
| I列 偶数行 fill | FFD9E2F3（青）✓ |
| row36 bottom border | 全セル none ✓（20件目に不要線なし）|
| row41 bottom border | 全セル thin ✓（25件目のみ最終行線）|
| I41 fill | None（白）✓ |

---

### テスト結果

| テストケース | 結果 |
|---|---|
| 20件生成 | PASS ✓ |
| 21件生成 | PASS ✓ |
| 25件生成 | PASS ✓ |
| 26件エラー | PASS ✓（正常エラー）|

---

### ユーザー目視確認済み（2026-08-20）

- 請求書明細 最大25行表示 ✓
- 26件以上はエラー ✓
- 青白の交互背景 ✓
- 13件目の赤文字修正 ✓
- 20件目の不要な下罫線修正 ✓
- 数量・単位の配置（H右寄せ / I左寄せ）✓
- I列 Meiryo 13pt / 黒文字統一 ✓
- 25件目の単位セル背景（白）✓
- D11 / 小計 / 消費税 / 合計の参照位置 ✓
- 支払期限の手動指定値を Excel に反映 ✓
- 出力ファイル名指定 UI ✓
- デフォルト名 `YYYY年M月D日_請求書_大和谷しおり.xlsx` ✓
- 原本テンプレート変更なし ✓
- 印刷プレビュー ✓
- Excel 最終目視確認 ✓
- テスト用 xlsx は削除済み ✓

### 未確認 / 残課題
- PDF 実ファイルの最終印刷確認（実機プリンタ）は未実施

### commit SHA：未採番（commit 前）

---

## 2026-08-19 — 請求書25行：CF sqref 拡張・青白縞・赤テキスト修正

### 目的
新規追加行（37〜41）が、既存明細の青／白の交互縞模様を引き継いでいない問題と
一部セルで文字が赤く表示される問題を修正する。

**根本原因**
テンプレートの条件付き書式（CF）sqref が `A28:G36 H17:H36 I28:I36 J17:M36` で
行36 で終端しており、動的挿入した行37〜41 が CF 適用範囲外だった。
赤テキストは CF 未適用によるレンダリング差異（theme/numFmt/dxf には `[Red]` なし）。

### 変更ファイル
- `data/generate_invoice_py.py`

### 実装内容

**expand_detail_rows() に Step 5 追加**
```python
# Step 5: CF sqref を新規行まで拡張
for cf_el in sheet_root.findall(f'{{{NS}}}conditionalFormatting'):
    old_sqref = cf_el.get('sqref', '')
    def _extend_range(m, _end=DETAIL_ROW_END, _new=new_last):
        if int(m.group(3)) == _end:
            return f'{m.group(1)}:{m.group(2)}{_new}'
        return m.group(0)
    new_sqref = re.sub(r'([A-Z]+\d+):([A-Z]+)(\d+)', _extend_range, old_sqref)
    if new_sqref != old_sqref:
        cf_el.set('sqref', new_sqref)
```

sqref 末端行（DETAIL_ROW_END=36）を new_last に更新。
- 20件（拡張なし）: sqref 変更なし（36のまま）
- 21件（+1行）: `...:36` → `...:37`
- 25件（+5行）: `...:36` → `...:41`

### 確認結果（全6ケース PASS）

| ケース | CF sqref 末端 | 正否 |
|---|---|---|
| 20件 | 36 | ✓ |
| 21件 | 37 | ✓ |
| 25件 | 41 | ✓ |
| 26件（エラー） | — | ✓ |
| 25件・日本語長業務名 | 41 | ✓ |
| 20件・ファイル名指定 | 36 | ✓ |

### テンプレート保護確認
- 生成前後で `invoice_template.xlsx` の mtime 変化なし ✓
- `shutil.copy2()` → `tmp_path` 差し替え方式により完全保護 ✓

### PDF確認
- 自動スクリーンショット方式は安全に動作しないため手動確認を依頼
- 生成済みファイル: `exports/invoices/test_25ken.xlsx`（25件）等

### 未確認 / 残課題
- Excel 実機での目視確認（青白縞・赤テキスト解消の最終確認）
- PDF 印刷プレビューでのレイアウト確認

### commit SHA：未採番（commit 前）

---

## 2026-08-19 — 請求書明細：最大25行対応（コピー側5行動的拡張）

### 目的
請求書明細をテンプレート基準の最大20件から最大25件まで対応できるよう拡張。
テンプレートファイル自体は変更せず、生成コピー側のみに5行を動的挿入する。

### 変更ファイル
- `data/generate_invoice_py.py`
- `data/invoice_generator.js`

### 実装内容

**定数拡張（generate_invoice_py.py）**
- `MAX_ROWS = 25`（旧 20）
- `MAX_ROWS_BASE = 20`（テンプレートの実明細行数）
- `EXPAND_DELTA = 5`、`SHIFT_FROM_ROW = 37`

**スタイル定数**
- `LAST_ROW_TO_INTERIOR`：行36の最終行スタイル（169/170/171/173/174/175/176）→ 内部行スタイルへのマッピング
- `NEW_ROW_ODD_STYLES`：item 21/23（奇数）の新規行スタイル（I=160→153に正規化）
- `NEW_ROW_EVEN_STYLES`：item 22/24（偶数）の新規行スタイル（I=164→111に正規化）
- `NEW_ROW_LAST_STYLES`：item 25（最終行）のスタイル（I=188：Meiryo 13pt + borderId=62 + fillId=4）

**ヘルパー関数**
- `_update_formula_refs(formula, delta, shift_from, old_end)`：行挿入後に数式内セル参照を更新
  - `row == old_end (36)` → `new_end (41)` へ拡張（SUM範囲末端対応）
  - `row >= shift_from (37)` → `+delta` シフト
- `_update_merge_ref(ref, delta, shift_from)`：マージセル参照のシフト
- `expand_detail_rows(sheet_root, extra)`：本体
  1. 行37以降を `+extra` シフト（r属性・セルref・数式参照を一括更新）
  2. **行37未満の数式で shifted 範囲（≥37）を参照するものも更新**
     → 例: D11=`"L40"`（合計表示）→ 25行展開後は `"L45"` に修正。L40が明細行になるバグを防ぐ
  3. 行36を内部行スタイルに変換（LAST_ROW_TO_INTERIOR）
  4. 新規行37〜(36+extra)を挿入（奇数/偶数/最終の3パターン）
  5. マージセル更新（既存シフト + 新規C:G・J:K・L:Mを追加）
  6. `new_last` を返す（Python 3.14 は Element にカスタム属性付与不可のため戻り値方式）

**fix_sheet_layout() 更新**
- 引数 `effective_end=None` を追加
- I列スタイル正規化マップを拡張：`{'160': '153', '164': '111', '175': '188'}`
  - `175`（Calibri 11pt）→ `188`（Meiryo 13pt / borderId=62 / fillId=4 は同一）
  - 既存テンプレートの行36の I 列（20行以下の最終行）も含め全行 Meiryo 13pt に統一
- I列スタイル正規化の対象範囲を `DETAIL_ROW_END` から `effective_end` に拡大
  → 新規行37〜41も Meiryo 13pt に統一

**generate() 更新**
- `extra = max(0, len(rows) - MAX_ROWS_BASE)` を計算
- `extra > 0` のとき `expand_detail_rows(sheet_root, extra)` を呼び出し
- 戻り値 `effective_detail_end` を `fix_sheet_layout(sheet_root, effective_end=...)` に渡す
- ヘッダーセル（L3請求日・D46支払期限・K39消費税率等）は拡張前に書き込む
  → 拡張時に行番号と共にシフトされるため正しい位置（例：D51）に到達する

**invoice_generator.js**
- `MAX_ROWS = 25`（旧 20）

### 確認結果（4ケーステスト）

| ケース | 結果 | 詳細 |
|---|---|---|
| 20件（拡張なし） | **PASS** | SUM(L17:M36)@L38、D46=46295 ✓ |
| 21件（+1行拡張） | **PASS** | SUM(L17:M37)@L39、D47=46295 ✓ |
| 25件（+5行拡張） | **PASS** | SUM(L17:M41)@L43、D51=46295 ✓ |
| 26件（エラー期待） | **PASS** | `明細が25行を超えています（26件）` ✓ |

**スタイル検証（25件）**
- 新規行37（item 21, 奇数）：I=153（Meiryo 13pt） ✓
- 新規行38（item 22, 偶数）：I=111（Meiryo 13pt+fill） ✓
- 新規行39（item 23, 奇数）：I=153 ✓
- 新規行40（item 24, 偶数）：I=111 ✓
- 新規行41（item 25, 最終）：**I=188**（Meiryo 13pt + borderId=62 + fillId=4） ✓
- 行高 ht=18.75 全行統一 ✓

**追加検証（25件・総合）**
- I36: s=111（行36が内部行化後 Meiryo 13pt に統一） ✓
- D11: `L45`（合計参照が拡張後に正しくシフト更新） ✓
- 合計数式: `SUM(L17:M41)@L43` / `INT(L43*K44/100)@L44` / `L43+L44@L45` ✓
- drawing 保持: image1.png / image2.png（2枚） ✓
- マージ行37〜41: C:G / J:K / L:M 各5行 計15マージ ✓
- 境界罫線 row41→42: 行41 下罫線（s169/188/176）→ 行42 セパレータ（s177/187/189）✓
- print area: テンプレート未定義 → Excel デフォルト印刷範囲で対応 ✓

**目視確認用ファイル（再生成済み）**
- `exports/invoices/test_25row_visual.xlsx`（25件・2026-08月）

### 未確認 / 残課題
- Excel を開いての目視確認（ユーザーに依頼）
- 21〜24件の中間件数での印刷プレビュー確認

### commit SHA：未採番（commit 前）

---

## 2026-08-19 — 請求書生成：支払期限 D46 書き込み漏れ修正

### 目的
`generateInvoiceWorkbook()` が確定した `due_date` を DB に保存していたが、
Python スクリプトへの受け渡しと D46 への書き込みが未実装だった。
ユーザーが生成画面で支払期限を変更した場合、画面・DB と Excel の期限が食い違う状態を修正。

### 変更ファイル
- `data/invoice_generator.js`
- `data/generate_invoice_py.py`

### 実装内容

**invoice_generator.js — pyInput に due_date を追加**
- `generateInvoiceWorkbook()` の `pyInput` に `due_date: paymentDue` を追加
- これにより確定済み支払期限が Python へ確実に渡される

**generate_invoice_py.py — D46 に支払期限を書き込む**
- `# D46: 支払期限` ブロックを追加（L3 請求日の直後）
- `set_date(sheet_root, 'D46', data['due_date'])` で日付シリアル値を書き込む
- `set_number()` が `<f>` タグも削除するため、テンプレートの `=EOMONTH(L3,0)` 数式を完全に上書き
- `due_date` がない場合は何も書かない（テンプレートの数式がフォールバックとして残る）

### 確認結果（XML 検証 2ケース）

| ケース | L3（請求日） | D46（支払期限） | D46 の型 |
|---|---|---|---|
| デフォルト（翌月末） | 2026-08-01 (serial=46235) | **2026-08-31** (serial=46265) | 数値（数式なし）|
| 手動変更（翌々月末） | 2026-08-01 (serial=46235) | **2026-09-30** (serial=46295) | 数値（数式なし）|

両ケースともテンプレートの `=EOMONTH(L3,0)` 数式が確定値に置き換わり、formula フィールドが存在しないことを確認 ✓

### 未確認 / 残課題
- なし

### commit SHA：未採番（commit 前）

---

## 2026-08-19 — 請求書生成：日付デフォルト修正・明細 I 列スタイル統一

### 目的
1. 請求日・支払期限のデフォルト値ルールを正しい業務ルールに修正
   - 旧: 対象月1日請求・対象月末支払
   - 新: **翌月1日請求・翌月末支払**（月末締め）
2. 明細 I 列（単位）の書式がテンプレートの行グループ境界（行25以降）で
   Meiryo 13pt → Calibri 11pt に切り替わり、9件目以降の見た目が異なる問題を修正

### 変更ファイル
- `data/invoice_generator.js`
- `data/generate_invoice_py.py`

### 実装内容

**日付デフォルト修正（invoice_generator.js）**
- `firstDayOfNextMonth(month)` 関数を追加
  → `new Date(y, m, 1)` で翌月1日を計算（m=1-indexed, DateのmonthはDateが0-indexedで受け取るため m 渡しで翌月になる）
- `buildInvoicePreview()` のデフォルト値を変更：
  - 請求日: `firstDayOfMonth(month)` → `firstDayOfNextMonth(month)`（翌月1日）
  - 支払期限: `lastDayOfMonth(month, 0)` → `lastDayOfMonth(month, 1)`（翌月末日）

**I 列スタイル正規化（generate_invoice_py.py）**
- テンプレートの I 列スタイルがテンプレートの行グループ境界（行17-24 vs 行25-35）で異なる：
  - 行17-24: xf[270]/[153]/[111] → fontId=11（Meiryo 13pt）
  - 行25-35: xf[160]/[164] → fontId=5（Calibri 11pt）← テンプレート設計の副作用
- `fix_sheet_layout()` 内に I 列スタイルマッピングを追加：
  - `s=160` → `s=153`（Calibri 11pt → Meiryo 13pt、fillなし・borderId=57）
  - `s=164` → `s=111`（Calibri 11pt → Meiryo 13pt、fill あり・borderId=49）

### 確認結果（XML 検証 + Excel 目視）

**XML 構造検証**
- L3 = serial 46235 = `2026-08-01` ✓
- D46 = `=EOMONTH(L3,0)` → 2026-08-31 ✓
- I17: s=270（特別行）/ I18: s=111 / I19-I23 奇数: s=153 / I18-I24 偶数: s=111 ✓
- **I25（9件目）: s=153（旧 s=160）→ Meiryo 13pt に統一 ✓**
- I26: s=111（旧 s=164）→ 空行も正規化 ✓

**Excel 目視確認（請求書_2026-07.xlsx）**
- 請求日 `2026年8月1日`、支払期限 `2026年8月31日` ✓
- 9件目の単位「日」フォントが他の明細行と統一 ✓
- 全件 Meiryo 13pt で揃っている ✓

### 未確認 / 残課題
- 10件以上の仕事がある月での I 列スタイル確認（行26以降も同様に正規化される設計）
- **【未実装】明細最大25行対応**：現在 `DETAIL_ROW_END=36`、`MAX_ROWS=20`（テンプレートの行数制限）。
  25行対応はテンプレート拡張・行範囲変更が必要なため、本コミットには含まない。別タスクで対応予定。

### commit SHA：未採番（commit 前）

---

## 2026-08-19 — 請求書生成：レイアウト追加調整（名前縮小修正・数量整数表示・消費税ラベル修正）

### 目的
前回の shrinkToFit 追加が逆効果（発行者名 I9 が 17pt→4pt 以下まで縮小）だったため修正。
数量 "1.　日" 問題を数値→inline string 変換で根本解決。

### 変更ファイル
- `data/generate_invoice_py.py`

### 実装内容

**shrinkToFit の再設計**
- xf[26]（A5 請求先名）: shrinkToFit を追加しない（原本通り）
  → "株式会社　オーテック" は A5:G6 マージ幅に収まるため不要
- xf[52]（I9 発行者名 17pt）: shrinkToFit を追加しない
  → I列が 6.86 単位しかなく shrinkToFit で 4pt 以下まで縮小してしまう
  → テキストは J9/K9 へ自然にオーバーフローさせる設計
- xf[199]（I39 消費税相当額）: `shrinkToFit="1"` を追加
  → I39:J39 マージ幅が「消費税相当額」7文字にわずかに不足のため

**数量表示の根本解決**
- H列（数量）を数値ではなく inline string として書き込む
  → numFmt の "." 問題を完全に回避
  → 整数: `float(1.0)` → "1"、小数: `1.5` → "1.5"
- `DETAIL_STRING_COLS` に 'H' を追加

**レイアウト調整 fix_sheet_layout() 追加**
- J列（col 10）幅: 8.71 → 10.5（I39:J39 合計: 6.86+10.5=17.36 単位）
  → 「消費税相当額」（7文字×12pt）が収まる
- 9行目の行高: 18.75pt → 24.0pt（17pt Meiryo の垂直クリップ防止）

### 確認結果（XML 構造 + Excel 目視）

**XML 構造検証（Python zipfile + ET）**
- I9: sharedStrings[12]=`" 大和谷　しおり"`、s=52、shrinkToFit なし ✓
- J9/K9/L9/M9: スタイルのみ・値なし → I9 テキストが自然にオーバーフロー可能 ✓
- Row 9: ht=24.0、customHeight=1 ✓
- I39: sharedStrings[55]=`"消費税相当額"`、s=199（shrinkToFit="1"）、I39:J39 マージ ✓
- Column J（col 10）: width=10.5、K-M: width=8.71 ✓
- A17: v=1、型=数値（右寄せ、位置ずれなし）✓
- A18: formula=`A17+1` 保持 ✓
- H17/H18: inlineStr=`'1'`（小数点なし）✓
- H19: inlineStr=`'4.5'` ✓
- L38/L39/L40: 合計計算式すべて保持 ✓
- xf[199]: shrinkToFit="1" ✓
- xf[26]/xf[52]: shrinkToFit なし ✓

**Excel 目視確認（請求書_テスト3_2026-07.xlsx）**
- 「大和谷　しおり」：自然な文字サイズで全文表示 ✓
- 「消費税相当額」：切れずに全文表示 ✓
- 数量：「1日」「4.5日」表示（「1.0日」「1.　日」なし）✓
- No.欄の「1」：原本と同等の位置・右寄せ数値 ✓

### 未確認 / 残課題
- なし（本エントリの修正はすべて目視確認済み）
- 実業務データでの通し確認（テンプレート以外のレイアウト崩れがないか）は本番運用時に確認

### commit SHA：未採番（commit 前）

---

## 2026-08-19 — 請求書生成：表示調整 + 日付デフォルト修正

### 目的
1. No.欄の数字位置ずれ修正（inlineStr → 数値）
2. 数量の "1.0日" → "1日" 表記修正（numFmt 0.0 → 0.#）
3. 請求先名・発行者名の文字切れ防止（shrinkToFit 追加）
4. 請求日デフォルト → 対象月1日、支払期限デフォルト → 対象月末日

### 変更ファイル
- `data/generate_invoice_py.py`
- `data/invoice_generator.js`

### 実装内容（generate_invoice_py.py）

**No.欄（列A）の修正**
- `DETAIL_STRING_COLS = {'B', 'C', 'I'}` を追加（A を文字列列から除外）
- 列A を `set_inline_string` → `set_number` に変更
  → style s=87 (numFmtId=166 = `0_ `) の右寄せ数値として正しく表示
  → A18以降の `=A17+1` 数式が正しく参照できる

**数量 "1.0日" → "1日" の修正**
- `rewrite_styles_xml()` 関数を追加
- numFmtId=167 のformatCodeを `0.0` → `0.#` に変更
  → 整数:  1 → "1"　小数: 4.5 → "4.5"　（0.# は小数部ゼロを非表示）
- float(1.0) などはint(1)に変換してから書き込み（`<v>1</v>`）

**shrinkToFit の追加（文字切れ防止）**
- xf[26]（A5 請求先名 / 18pt Meiryo center）: `shrinkToFit="1"` 追加
- xf[52]（I9 発行者名 / left align）: `shrinkToFit="1"` 追加
- テンプレート styles.xml は変更しない。生成ファイルのみに適用。

**ZIP rebuild でスタイル書き換えを適用**
- `xl/styles.xml` → `rewrite_styles_xml()` を通して書き込む

### 実装内容（invoice_generator.js）

- `firstDayOfMonth(month)` 関数を追加
- `buildInvoicePreview()` のデフォルト値を変更：
  - 請求日: `lastDayOfMonth(month, 0)` → `firstDayOfMonth(month)`（対象月1日）
  - 支払期限: `lastDayOfMonth(month, 1)` → `lastDayOfMonth(month, 0)`（対象月末日）
- 画面で変更した場合はその値が優先される（既存の `prior?.xxx || default` 構造を維持）

### 確認結果
- A17: t=numeric v='1'（数値）、A18 formula v='2'（正しく計算）
- H17: v='1'（整数）、H19: v='4.5'（小数保持）
- numFmt 167: formatCode = "0.#" ✓
- xf[26]: shrinkToFit="1" ✓
- xf[52]: shrinkToFit="1" ✓

### 未確認
- Excel で開いて目視確認（ユーザー確認待ち）
- shrinkToFit による印刷レイアウトへの影響

### commit SHA：未採番（commit 前）

---

## 2026-08-18 — 請求書生成：単一シート出力（Excelが正しいシートを表示）

### 目的
生成した xlsx を Excel で開くと、マスターシートではなく先頭の過去データシート
（202602 請求書）が表示される問題を修正。

### 原因
テンプレートには 16 シートが含まれており、ZIP をそのままコピーして
1 シートだけ値を書き換えた場合でも、Excel は `workbookView` の `activeTab` 属性
（元の値）に従い先頭シートを表示していた。

### 変更ファイル
- `data/generate_invoice_py.py`（全面改修）

### 実装内容
出力 ZIP を 1 シートのみに絞り込む：
1. `find_sheet_info()` でマスターシートの ZIP パスと rId を特定
2. `discover_master_assets()` でマスターに紐づく drawing・media パスを収集
3. `should_exclude()` で他シートの XML・rels をすべて除外
4. `rewrite_workbook_xml()` : `<sheets>` にマスターのみ残し `activeTab="0"` を設定
5. `rewrite_workbook_rels()` : worksheet タイプの rel をマスター (rId12) のみ残す
6. `rewrite_content_types()` : 除外シート・描画の Override を削除
7. styles.xml・theme・sharedStrings・media(image1.png)・drawing9.xml はそのまま保持

### 確認結果
- 出力 ZIP のシート数：1（xl/worksheets/sheet9.xml のみ）
- workbook.xml：name="202607 請求書" sheetId="1" activeTab="0"
- styles.xml：テンプレートとバイト完全一致（OK）
- theme1.xml：テンプレートとバイト完全一致（OK）
- image1.png：テンプレートとバイト完全一致（OK）
- drawing9.xml：テンプレートとバイト完全一致（OK）
- テスト生成：`請求書_テスト_2026-07.xlsx` 生成成功

### 未確認
- Excel で開いて請求先名（A5）・印刷レイアウトの目視確認（ユーザー確認待ち）

### commit SHA：未採番（commit 前）

---

## 2026-08-18 — 請求書生成：ZIP直接操作方式への再実装（書式完全保持）

### 目的
openpyxl 方式でもスタイルインデックスの再マッピングにより名前欄等の書式が
変化する問題が発生。ZIP 直接操作方式に切り替えて書式を 100% 保持する。

### 原因
openpyxl は読み込み時にスタイルテーブルを再構築するため、
元の `style="26"` 等のインデックスが変わり、フォントサイズ・配置等が
テンプレートと異なる値になる可能性があった。

### 変更ファイル
- `data/generate_invoice_py.py`（全面書き換え）— ZIP + ElementTree 直接操作方式

### 実装内容
1. `shutil.copy2()` でテンプレートを ZIP ごとコピー
2. `xl/workbook.xml` でシートパスを特定
3. ワークシート XML を ElementTree で解析し、指定セルの値のみ差し替え
4. 文字列は `t="inlineStr"` で書き込み（sharedStrings 再インデックス回避）
5. 数値・日付は `<v>` 要素のみ更新
6. 数式セル（f 要素あり）は一切上書きしない
7. `xl/styles.xml`・描画・画像・印刷設定は ZIP エントリを丸ごと通過

### 確認結果
- `styles.xml`：テンプレートと完全一致（80,961B 同一）
- 画像：`image1.png`（1.6MB）・`image2.png`（52KB）保持
- 描画：29ファイル全保持
- 生成ファイル：`請求書_2026-07.xlsx`（9件・202,950円税込）

### 未確認
- Excel で開いて名前欄・印刷レイアウトを目視確認（ユーザー確認待ち）

### commit SHA：未採番（commit 前）

---

## 2026-08-18 — 請求書生成：テンプレートコピー方式（openpyxl）への移行

### 目的
SheetJS（xlsx）が Excel ファイル内の画像を破棄する問題を根本修正。
テンプレートの画像・書式・結合セル・ロゴを完全保持したまま値だけ差し替える。

### 背景・原因
- テンプレート `★2026　オーテック請求書 .xlsx` に画像（ロゴ等）31ファイルが含まれる
- SheetJS community edition は `xl/drawings/` / `xl/media/` を読み捨てるため、生成ファイルから画像が消えていた

### 変更ファイル
- `data/generate_invoice_py.py`（新規）— Python + openpyxl でテンプレートコピー生成
- `data/invoice_generator.js` — `generateInvoiceWorkbook()` の生成部分を Python スクリプト呼び出しに変更

### 実装内容
1. `generate_invoice_py.py`：テンプレートを load_workbook で読み込み、`★請求書マスター` シートのみ対象セルの値を書き換え、他シートを削除して保存
2. 数式セル（L38 小計、L39 消費税、L40 合計、D11 合計表示、D46 支払期限）は上書きせず Excel に再計算させる
3. `invoice_generator.js` が `execFileSync('python', ...)` で Python スクリプトを呼び出す

### 確認結果
- 生成ファイル：シート1枚・画像1枚（`xl/media/image1.png`）・結合セル87個を確認
- L2（請求番号）・L3（請求日）・A5（請求先）・明細行すべて正しく書き込まれた
- テンプレートファイル自体は変更されない

### 未確認
- 実際に Excel で開いて見た目を確認していない（ローカルでファイルを開いて確認推奨）

### commit SHA：未採番（commit 前）

---

## 2026-08-18 — Business タブ構成整理・デザイン統一

### 目的
重複 ID の解消・タブ構成の整理・Google Calendar の切り離し・初期表示タブの変更。

### 変更ファイル
- `jarvis/dashboard/public/index.html`
- `jarvis/dashboard/public/app.js`

### 実装内容

**index.html**
- `#business-tabs` のタブボタンを「実績分析 | グラフ | 音声 | 請求実績」に変更（物販・保育園は各専用 JS が動的追加）
- `biz-tab-monthly` に `hidden` 属性を追加（初期表示を analytics に変更）
- 旧 `biz-tab-billing`（サブタブ構造）を完全削除
- 旧 `biz-tab-analytics` から invoice 系カード・テーブル類を削除し、プレースホルダーに変更
- `biz-tab-invoice`（新）を作成：年選択・年次サマリーカード・月別売上・仕事内容別・明細一覧・Excel 取込・取込履歴を収容
- `biz-tab-calendar` を Business タブから切り離し、非表示の独立パネルとして保持
- 重複していた `inv-year-select`, `inv-summary-cards`, `inv-card-*`, `inv-monthly-container`, `inv-category-container`, `inv-lines-container`, `inv-lines-note` の全 ID を `biz-tab-invoice` に一か所のみ配置
- server.js のスクリプト inject 判定が誤検出されないようコメント文言を修正

**app.js**
- `bizCurrentTab` 初期値を `'monthly'` → `'analytics'` に変更
- `switchBizTab` を全面更新：`['analytics','graph','monthly','merch','nursery','invoice']` のパネル切替・`initInvoiceTab()` 呼び出し追加・`switchBillingSubTab()` 削除
- `billingCurrentSub` 変数と `switchBillingSubTab()` 関数を削除
- `initAnalyticsTab()` を work_records ベースの実装予定プレースホルダーに変更
- `initInvoiceTab()` に invoice analytics（年選択・カード・テーブル）の初期化処理を追加
- `inv-year-select` のイベントリスナーを `initInvoiceTab()` 内で一度だけ登録するよう変更
- `populateYearSelect()` に null チェック追加
- `init()` IIFE 末尾に `switchBizTab('analytics')` を追加（初期 Business サブタブを analytics に設定）

### 確認結果
- 重複 ID ゼロを確認（`inv-year-select` 等は `biz-tab-invoice` に1か所のみ）
- `billing-subtabs` の残骸なし
- Google Calendar 関連コード（`initCalendarTab()` / `biz-tab-calendar` パネル）は残存
- タブボタンと `sf-tab` クラスは Business / Snow flakes で共通（style.css に Business 専用上書きなし）
- server.js inject が全スクリプトを正しく提供することを確認

### commit SHA：未採番（commit 前）

---

## 2026-08-18 — 仕事一覧 sticky header CSS 競合修正

### 修正
- `style.css` の `.works-table th` から `position: sticky; top: 53px;` を削除。ページ全体スクロール前提の `top` 値が競合の原因だった。
- `business-ui-fixes.js` の `installStyles()` に `#works-table-container` の `overflow-y: auto; max-height: min(60vh, 640px); overflow-x: auto; overscroll-behavior: contain;` を追加。これにより仕事一覧（tbody）だけがスクロールするコンテナが確立された。
- `business-ui-fixes.js` の `#works-table-container .works-table thead th` から `!important` による強制上書き（`background`, `background-color`, `opacity`）を削除し、`background: #161b22`（`--bg-card` 相当・完全不透明）と `box-shadow: 0 1px 0 #30363d` に整理。`top: 0` を維持。
- `#nursery-shift-container` / `#nursery-bulk-grid` の `overflow-y: auto !important;` から `!important` を除去。

### 競合の根本原因
1. `style.css` が `top: 53px`（ページヘッダー高さ）を前提とした sticky を設定
2. `business-ui-fixes.js` が `top: 0` の sticky を `!important` で上書き
3. `#works-table-container` がスクロールコンテナになっていないため、`thead th` の sticky が機能する親が存在しなかった

### 確認結果
サーバーは既にポート 3000 で起動済み（EADDRINUSE確認）。curl でページが正常返却されることを確認。DOM 構造から以下を推定：`#works-table-container` が `max-height: min(60vh, 640px)` でスクロールコンテナになり、`thead th` は `top: 0` の sticky で正常に吸着する。背景は `#161b22` （完全不透明）。上部ダッシュボードと「今日の仕事」はコンテナ外のため従来通りページ固定。

### commit SHA：未採番（commit 前）

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

---

## 2026-08-18 — Business ナビゲーション競合コードの整理（Claude 実施）

### 目的
CLAUDE_AUDIT_2026-08-18.md の指示に従い、ChatGPT が複数ファイルへ混入させた Business ナビ制御の競合を解消し、タブ構成をユーザー最終要望通りに整備する。

### 変更ファイルと内容
- `business-nursery-payslip.js` — 末尾の古いナビ制御 IIFE（76行）を削除。「実績分析（グラフ）」結合・iframe 埋め込み・MutationObserver 再配置コードを除去
- `business-merch.js` — 末尾の UI 修正 IIFE（123行）を削除。物販以外の Business ナビ制御を分離
- `business-graph.html` — `<script src="business-graph-enhance.js"></script>` を直接追加。グラフ拡張機能（モード切替・積み上げ棒・クリック内訳）を確実に読み込み
- `business-graph-v2.html` — 廃止スタブに変換（`/business-graph.html` へリダイレクト）
- `business-ui-fixes.js` — `injectGraphEnhancer()` / `groupInvoiceAndCalendar()` / `addLinkedSubnav()` / `setInterval(fixImportPreviewButton)` を削除（対症療法コード除去）
- `business-custom.js` — `ensureGraphTab()` とその呼び出しを削除（index.html にタブ定義済みのため重複）
- `index.html` — タブ構成を要望通りに整備。グラフ独立タブ追加、「請求書・Googleカレンダー」を「請求・連携」サブタブにまとめ、「月次」→「音声」・「完全休日」→「音声休み」変更
- `app.js` — `switchBizTab()` に `billing` / `graph` 追加。`switchBillingSubTab()` 新規追加
- `server.js` — `business-ui-fixes.js` の注入ブロックを追加（これまで未注入だった問題を修正）

### テスト
- `tests/test_calendar_sync.js`：45件全合格

### 残課題
- ブラウザでの実機確認未実施（ローカルサーバー起動が必要）
- commit SHA：未採番（commit 前）

---

## 2026-08-18 — 明細カテゴリ統一（ゴルフ中継 / スポーツ中継）

### 目的
2023・2024年の `business_invoice_lines.category` を正式カテゴリ名に統一する。再インポート時のカテゴリ判定ロジックも修正する。

### 背景・原因
`ｍeijicup`（全角ｍ）の説明文が `classifyWork()` の `toLowerCase()` で `meijicup` にマッチせず「その他」に分類されていた。`toHalfWidth()` が数字のみ対応で、全角英字（Ａ-Ｚ / ａ-ｚ）を変換していなかったことが原因。

### 変更ファイル
- `importers/invoice_importer.js`
  - `toHalfWidth()` に全角英字（Ａ-Ｚ・ａ-ｚ）→ 半角の変換を追加
  - `classifyWork()` 内で `toHalfWidth()` を呼んでから `toLowerCase()` するよう変更

### DB 更新
- `business_invoice_lines` id=60（2023-08-06）：`その他` → `ゴルフ中継`
- `business_invoice_lines` id=63（2024-08-02）：`その他` → `ゴルフ中継`
- `business_invoice_lines` id=65（2024-08-04）：`その他` → `ゴルフ中継`

### 最終状態（2023・2024年全件）
| id | 日付 | カテゴリ |
|----|------|----------|
| 58 | 2023-08-02 | ゴルフ中継 ✅ |
| 59 | 2023-08-04 | ゴルフ中継 ✅ |
| 60 | 2023-08-06 | ゴルフ中継 ✅（修正） |
| 61 | 2024-07-31 | ゴルフ中継 ✅ |
| 62 | 2024-08-01 | ゴルフ中継 ✅ |
| 63 | 2024-08-02 | ゴルフ中継 ✅（修正） |
| 64 | 2024-08-03 | ゴルフ中継 ✅ |
| 65 | 2024-08-04 | ゴルフ中継 ✅（修正） |
| 66 | 2024-08-25 | スポーツ中継 ✅ |

### テスト
- `tests/test_invoice_importer.js`：28件全合格
- `classifyWork()` 直接確認：全角ｍ含む説明文も「ゴルフ中継」に正しく分類

### commit SHA：未採番（commit 前）
