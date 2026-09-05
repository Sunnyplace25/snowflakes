# Snow flakes 公式HP 更新履歴

> Claude確認依頼 — 2026-09-05
>
> 最新の `main` を取得したうえで、以下を確認してください。
>
> 1. PC表示で、トップのヒーローを過ぎたあと右側に「音ハズ」広告が正常表示されること
> 2. `otohazu_ad.webp` が欠損せず、画像として正常に読み込めること
> 3. 広告クリック先が `https://ncode.syosetu.com/n1351mq/` になっていること
> 4. スマホでは固定広告を出さず、モバイルメニュー内の `音ハズ｜NEW SERIAL` から同作品へ遷移すること
> 5. 左側ページ目次、右下Spotifyプレイヤー、既存ポップアップ類と広告が干渉していないこと
> 6. SWEETsでは、Summer Special Episodeは夏画像、Autumn Special Episodeと三人の部屋トップはゴルフ画像のまま維持されていること
>
> 問題があれば、既存の変更を巻き戻さず原因だけ修正してください。


このファイルは、Snow flakes 公式サイトの手動更新・修正内容を共有するための記録です。
Claude / ChatGPT など複数環境から作業する場合は、更新前に `main` の最新状態を取得し、この記録も確認してください。

---

## 2026-09-05 追記

### 音ハズ広告画像を高解像度版へ差し替え

対象:

`otohazu_ad.webp`

変更内容:

- HP右サイドの「音ハズ」広告画像を、最新の修正版ビジュアルへ差し替え
- 既存の広告レイアウト・リンク先・表示条件は変更なし
- 小さい表示サイズでも文字と人物の輪郭がぼやけにくい高解像度版へ更新
- JARVIS側のファイルには変更なし

関連コミット:

`ac6777efda433fa8a0331408df93272710aa4884`

---

## 2026-09-05 追記

### 音ハズ広告画像の読み込み不具合を修正

原因:

最初に追加した `otohazu_ad.webp` が不完全な画像データになっており、ブラウザで正常に表示されない状態だった。

修正内容:

- 元画像から広告表示サイズ向けにWebPを再生成
- `otohazu_ad.webp` を正常な画像データへ差し替え
- 表示サイズ: 156px幅向け
- ファイルサイズ: 約6.4KB

修正コミット:

`304e1a5d458b343d9f32df80409071e942eaf1a7`

---

## 2026-09-05 追記

### 「音ハズ」右サイド広告を追加

対象:

`index.html`
`otohazu_ad.webp`

変更内容:

- ユーザー提供の「音ハズ」ビジュアルをWeb用に圧縮し、`otohazu_ad.webp` として追加
- PC（幅1280px以上）で、トップのヒーローを離れた後に右側へ固定広告を表示
- 広告コピー:
  - `NEW SERIAL`
  - `山吹ことりが描く、「音」が運命を変える異世界ファンタジー。`
  - `小説家になろうで読む →`
- クリック先:
  - `https://ncode.syosetu.com/n1351mq/`
- スマホ固定広告は出さず、モバイルメニューに `音ハズ｜NEW SERIAL` を追加
- 既存の左側ページ目次、右下Spotifyプレイヤーとは重ならない位置に設定

関連コミット:

- 広告画像追加: `371b8cd3f7e132035863de1aec4949b56a798947`
- 広告UI追加: `1de407d1e312162ff7e9930e2b4d598ecf1fcf86`

---

## 2026-09-05 追記

### SWEETs Autumn画像の分離修正

対象:

`sweets/index.html`
`room/hinata/index.html`
`room/kouta/index.html`
`room/hayate/index.html`

原因:

2026-08-31のAutumn対応で三人の部屋画像をゴルフ場画像へ差し替えた後、Summer Special Episodeの表紙を保護するため `room_face.webp` を夏画像へ戻したため、Autumn側と各部屋トップまで夏画像へ戻っていた。

修正内容:

- Summer Special Episode
  - ヒナタ / コウタ / ハヤテとも既存の夏画像 `room_face.webp` を維持
- Autumn Special Episode
  - 三人とも専用のゴルフ画像 `room_face_autumn.webp` を使用
- 各キャラクターの部屋トップ
  - 三人とも `room_face_autumn.webp` を使用
- 夏と秋で画像ファイルを分離し、今後片方の差し替えで他方が巻き戻らない構成へ変更

追加ファイル:

- `room/hinata/room_face_autumn.webp`
- `room/kouta/room_face_autumn.webp`
- `room/hayate/room_face_autumn.webp`

画像復元元:

- ヒナタ / コウタ: 2026-08-31 Autumnゴルフ場対応コミット `b50ae81ad843465d6e93dd41c70e9791d640a50d`
- ハヤテ: 2026-08-31 Autumn対応コミット `3c980d8b2f9f3fa7ab7929dce7abf1247ba160fd`

関連コミット:

- Autumn画像専用ファイル復元: `603300e2534a6a8ae14c933f754c866d09a0baa0`
- コウタ部屋トップ: `788c1918905ab00e4a54861a8327af135143af02`
- ハヤテ部屋トップ: `73708eb5a20bde88288ab55694c123ec68ae3bf3`
- Autumn / Summer Episode参照分離: `c1e14e0fe7dd01dfa2f525d3168bd577680a9891`

---

## 2026-09-05 追記

### 新連載の活動報告を追加

対象ファイル:

`index.html`

変更内容:

- 2026.08.22付の活動報告をトップページ一覧に追加
- 表示:
  - `新連載｜『音を覚えるだけの外れスキルで追放された俺、失われた古代魔法を全部再生できるらしい』`
- リンク先:
  - `https://mypage.syosetu.com/mypageblog/view/userid/2212173/blogkey/3692300/`
- 並び順を以下に調整
  - 2026.08.30 In One Sky リリース
  - 2026.08.22 新連載
  - 2026.08.20 Under tone
  - 2026.08.18 夏のホラー限定話
  - 2026.07.29 ホラーエピソード公開のお知らせ
- 表示件数を5件に維持するため、2026.07.17の項目をトップページ一覧から削除

実装コミット:

`fcb0cf77858459a4d625d085036d2ae6056210b8`

---

## 2026-09-05

### In One Sky リリース活動報告を追加

対象ファイル:

`index.html`

変更内容:

- トップページ「活動報告」欄の最上段に以下を追加
  - 日付: `2026.08.30`
  - 表示: `New Single「In One Sky」リリース`
- リンク先を Spotify の「In One Sky」配信ページに設定
- 活動報告の表示件数を従来どおり5件に維持するため、最古の「2026.07.05 活動報告｜短篇 透明なリズム 公開中」をトップページ一覧から削除
- 「活動報告をすべて見る」リンクなど、周辺UIには変更なし

Spotify:

`https://open.spotify.com/intl-ja/album/4ZB3NH6YOUIPmRcy0h8yX7?si=dTO8gAKtQUaGazBwD-Oabw`

反映ブランチ:

`main`

実装コミット:

`46de11b339bc0aad8b695d69de930bf7e91a6bfc`

### 作業時の注意

今回の変更は `main` に直接反映済みです。
別環境で `index.html` を編集する場合は、今回の変更を上書きしないよう、必ず最新の `main` を取得してから作業してください。

---

## 関連記録

Under tone バナーの2026-08-21ホットフィックスについては、以下を参照してください。

`HOTFIX_2026-08-21_UNDERTONE_BANNER.md`
