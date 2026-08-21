# Under tone バナー表示修正記録

作成日: 2026-08-21
対象: Snow flakes 公式サイトトップページ
ブランチ: main

## 背景

トップページの「Under tone」短篇バナーは、2026-08-20 23:00 から 2026-08-31 23:59:59 まで表示する設定だったが、既読判定に `localStorage` を使用していたため、一度表示された端末では以後バナーが消える状態になっていた。

該当キー:

`sf_undertone_story_v1_seen`

## 変更内容

2026-08-21、公開中の `main` にホットフィックスを実施。

`index.html` 全体を大きく書き換えず、トップページで共通読み込みされている `snow.js` に表示強制処理を追加した。

処理内容:

- 表示期間は 2026-08-20 23:00〜2026-08-31 23:59:59 JST
- 期間内は `sf_undertone_story_v1_seen` を削除
- `#banner-ut-story` に `display:block!important;` を適用
- PC / スマホとも常時表示
- 8月31日終了後は強制表示しない
- 夏のホラー特集バナーなど、他の表示条件には触れない

## 実装箇所

ファイル:

`snow.js`

追加した処理の概要:

```js
(function forceUndertoneStoryBanner() {
  var start = new Date('2026-08-20T23:00:00+09:00');
  var end   = new Date('2026-08-31T23:59:59+09:00');
  var now   = new Date();
  if (now < start || now > end) return;
  localStorage.removeItem('sf_undertone_story_v1_seen');
  var s = document.createElement('style');
  s.id = 'sf-ut-story-force-visible';
  s.textContent = '#banner-ut-story{display:block!important;}';
  document.head.appendChild(s);
})();
```

## コミット

ホットフィックスコミット:

`0a0cee84819c0fc7cf5d78f1301c7fd43728ce8c`

## 今後の注意

今回の修正は緊急対応として `snow.js` 側から既存の `index.html` の「1回表示」ロジックを上書きしている。

後日トップページ整理を行う場合は、`index.html` 内の以下の旧ロジックを直接整理してよい。

- `UT_SEEN_KEY`
- `localStorage.getItem(UT_SEEN_KEY)`
- 初回表示時の `localStorage.setItem(UT_SEEN_KEY, '1')`

最終的には「期間内は常時表示 / 期間外は非表示」という単純な条件に統一するのが望ましい。
