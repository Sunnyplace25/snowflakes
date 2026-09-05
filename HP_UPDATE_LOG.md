# Snow flakes 公式HP 更新履歴

このファイルは、Snow flakes 公式サイトの手動更新・修正内容を共有するための記録です。
Claude / ChatGPT など複数環境から作業する場合は、更新前に `main` の最新状態を取得し、この記録も確認してください。

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
