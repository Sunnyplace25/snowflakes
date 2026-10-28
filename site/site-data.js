/* ============================================================
   site/site-data.js — サイト全体の案内データ（トップ・STORIES・GAME・VIDEO・ABOUT・SHOP 共通）
   ------------------------------------------------------------
   ■ 画像について
     ・image が null の項目は画像なしの表示（CSS のグラデーションと文字）になる。仮画像は置かない
     ・画像を用意したら image にサイトのルートからのパスを書くだけで表示される（例：'img/works/snowflakes.webp'）
     ・imageSpec は推奨サイズ（WebP 推奨）
     ・縦長の画像など、切り抜かずに全体を見せたいときは imageFit: 'contain'（背景にぼかした同じ画像を敷く）
   ■ 文章について
     ・作品名・あらすじ・連載先は既存ページの表記から転記（2026-10-26）。推測で補わない
     ・status が 'public' 以外の項目は表示しない（'draft' = 準備中）
   ■ 追加のしかた
     ・新しい小説：works に1件足し、stories/<id>/index.html を stories/kamisama/index.html と同じ形で作る
     ・新しいゲーム：games に1件足す（GAME 一覧に出る）
     ・映像：videos に1件足す（VIDEO 一覧に出る）
     ・商品：shop.items に足す。shop.visible を true にするまでどこにも表示しない
   ============================================================ */
(function (global) {
  var NAROU = 'https://ncode.syosetu.com/';

  // ── 初めての方へ（楽しみ方を選ぶ入口・3つ） ─────────────────
  var entrances = [
    { id: 'stories', label: 'STORIES', title: '小説から楽しむ', href: 'stories/',   // 画像：2026-10-28 ユーザー指定（元画像は制作用の保管場所。対応は引き継ぎ資料）
      text: 'バンドの青春から異世界ファンタジーまで。連載中の物語を、作品ごとに紹介しています。',
      image: 'img/entrances/stories.webp', markOnImage: 'STORY', imageSpec: '1200×750（16:10）' },   // markOnImage：画像の上に「STORY」の文字（2026-10-28 ユーザー指示）
    { id: 'music', label: 'MUSIC', title: '音楽から楽しむ', href: 'music.html',   // 画像：2026-10-29 ユーザー指定（雨音クラブのステージ。元画像は制作用の保管場所。対応は引き継ぎ資料）
      text: '物語の中で鳴っている音楽を、実際の楽曲として配信しています。Snow flakes、雨音クラブなど、アーティストごとに聴けます。',
      image: 'img/entrances/music.webp', markOnImage: 'MUSIC', imageSpec: '1200×750（16:10）' },
    { id: 'game', label: 'GAME', title: 'ゲームで遊ぶ', href: 'game/',   // 画像：2026-10-29 ユーザー指定（Under tone の路地裏。元画像は制作用の保管場所。対応は引き継ぎ資料）
      text: 'キャラクター育成ゲーム「ハヤテっち」や、ノベルゲーム「Under tone」など、物語の世界で遊べるコンテンツです。',
      image: 'img/entrances/game.webp', markOnImage: 'GAME', imageSpec: '1200×750（16:10）' }
  ];

  // ── 作品（代表作品・STORIES 一覧・作品ページ） ─────────────────
  var works = [
    { id: 'snowflakes', status: 'public', featured: true, order: 1,
      title: 'Snow flakes', kana: 'スノーフレークス', kind: '連載小説・シリーズ', page: 'stories/snowflakes/',
      lead: '約束なんてしていない。それでも、三人の音は続いていく。高校時代に始まったバンド、Snow flakes。',   // 2026-10-28 ユーザー指定の紹介文の冒頭2文（全文は stories/snowflakes/ の冒頭）
      image: 'img/works/snowflakes.webp', imageSpec: '1600×900（16:9）',   // 2026-10-28 ユーザー指定のイラストに差し替え（元画像は制作用の保管場所。対応は引き継ぎ資料）。旧：仮の Kindle 1巻表紙 snowflakes_ad.webp（ファイルは残している）
      serials: [{ label: '小説家になろう', url: NAROU + 'n9009lo/', ncode: 'n9009lo', note: '毎日21時更新' }],
      artists: ['snowflakes'] },
    { id: 'kamisama', status: 'public', featured: true, order: 2,
      title: '神様はバンド名がダサいと言った', kind: '連載小説', page: 'stories/kamisama/',
      lead: '解散寸前のバンドに、音を聞く神様がついてきた。',
      synopsis: ['メンバー同士の恋愛トラブルで、解散寸前の雨音クラブ。それでもバンドを諦めきれないギタリスト・アキの前に、音にうるさい妙な神様が現れる。',
                 '神様が来たところで、何もかも上手くいくわけじゃない。それでも鳴らし続ける、不器用な若者たちのバンド青春コメディ。'],
      // 2026-10-28 ユーザー指定のイラストに差し替え（元画像は制作用の保管場所。対応は引き継ぎ資料）。旧：広告画像 kamisama_ad.webp（ファイルは残している）
      image: 'img/works/kamisama.webp', imageSpec: '1600×900（16:9）',
      serials: [{ label: '小説家になろう', url: NAROU + 'n3833mv/', ncode: 'n3833mv' },
                { label: 'カクヨム', url: 'https://kakuyomu.jp/works/11054822663783655461', note: '1話先行' }],
      artists: ['amaoto-club'] },
    { id: 'otohazu', status: 'public', featured: true, order: 3,
      title: '音を覚えるだけの外れスキルで追放された俺、失われた古代魔法を全部再生できるらしい', short: '音ハズ', kind: '連載小説', page: 'stories/otohazu/',
      lead: '山吹ことりが描く、「音」が運命を変える異世界ファンタジー。',
      // 2026-10-29 ユーザー指定のイラストに差し替え（元画像は制作用の保管場所。対応は引き継ぎ資料）。旧：広告画像 otohazu_ad.webp（ファイルは残している）
      image: 'img/works/otohazu.webp', imageSpec: '1600×900（16:9）',
      serials: [{ label: '小説家になろう', url: NAROU + 'n1351mq/', ncode: 'n1351mq' }],
      artists: [] }
  ];

  // ── ゲーム（GAME 一覧。ゲーム本体は既存の URL へ案内するだけで複製しない） ──
  var games = [
    { id: 'hayatecchi', status: 'public', title: 'ハヤテっち', kind: 'キャラクター育成ゲーム', href: 'hayatecchi-lp.html',
      text: 'Snow flakesのドラマー・ハヤテの日常に入り込む、キャラクター育成ゲームです。遊んでいるうちにドラムに詳しくなれるかも？',
      note: 'Web Game ／ ¥100 買い切り', work: 'snowflakes', image: 'img/games/hayatecchi.webp', imageSpec: '1200×750（16:10）' },   // ロゴ（背景透明）：2026-10-29 ユーザー指定。元画像は制作用の保管場所
    { id: 'undertone', status: 'public', title: 'Under tone', kind: 'ノベルゲーム＆占い', href: 'game/undertone/',   // 作品紹介 → ゲーム本体（room/undertone/）
      text: '短編「ひとつ多い音」の続編となるノベルゲーム＆占い。プロローグはすぐに遊べます。',   // 旧 note「続きの章はアイテムを集めると開きます」は 2026-10-28 アイテム必須の解除に合わせて削除
      note: '', work: 'snowflakes', image: 'img/games/undertone.webp', markOnImage: 'Under tone', markPos: 'top', imageSpec: '1200×750（16:10）' },   // 路地裏（入口 GAME と同じ画像の別ファイル）：2026-10-29 ユーザー指定
    { id: 'gacha', status: 'public', title: '今日の音', kind: 'ガチャ・占い', href: 'gacha/',
      text: '積もった ❄ Snow でガチャを引いてアイテムを集めよう。', note: '', work: 'snowflakes', image: 'img/games/gacha.webp', imageSpec: '1200×750（16:10）' }   // ちびキャラのスタジオ：2026-10-29 ユーザー指定
  ];

  // ── 映像（VIDEO 一覧。タイトルは各アーティストページの表記） ─────────
  var videos = [
    { youtube: 'dhL9OJBSksE', title: '届く場所｜TOWA', artist: 'towa' },
    { youtube: 'LqC29b4RLBI', title: 'Snow flakes｜Moon Veil', artist: 'moonveil' },
    { youtube: 'tRBHxBTfBUA', title: '雨音クラブ「雨天決行」｜山吹ことり', artist: 'amaoto-club' },
    { youtube: '_kqpiETerlo', title: '雨音クラブ｜午前零時のサイン', artist: 'amaoto-club' },
    { youtube: 'yjxA-WjvcaI', title: '雨音クラブ｜昨日までの音', artist: 'amaoto-club' },
    { youtube: 'sqnFkL1rR5Q', title: 'Snow flakes「置いた音」｜山吹ことり セルフカバー', artist: 'kotori' },
    { youtube: 'rwRNOYh6kNA', title: 'ここからまたね｜山吹ことり', artist: 'kotori' }
  ];

  // ── その他のコンテンツ（トップの「その他のコンテンツ」） ─────────────
  var contents = [
    // status: 'hidden'：映像カードは整うまで一度下げる（2026-10-29 ユーザー指示。public に戻せば表示）
    { id: 'video', status: 'hidden', label: 'VIDEO', title: '映像', href: 'video/', text: 'MV や映像作品をまとめて観られます。', image: 'img/entrances/video.webp', markOnImage: 'VIDEO', imageSpec: '1200×675（16:9）' },   // TOWA「届く場所」ジャケット別案から3人の顔の部分：2026-10-29 ユーザー指定
    // 説明文：2026-10-29 ユーザー指定の文のまま（\n は改行。行の間は空けない・2026-10-29 指示。旧文「限定エピソードやLIVEアーカイブ、ノベルゲームなどが集まる場所です。」）
    { id: 'sweets', label: 'SWEETs', title: 'SWEETs ROOM', href: 'sweets/',
      text: 'Snow flakesの世界をもっと深く楽しめる、コアコンテンツエリア。\nアイテムを集めて、限定エピソードを解放しよう！\n本編では描かれなかった、彼らの意外な一面をのぞけるかも？\nLIVEアーカイブやノベルゲームなど、さまざまなコンテンツも楽しめます。（まもなくアップデート予定！）',
      image: 'img/entrances/sweets.webp', markOnImage: 'SWEETs', imageSpec: '1200×675（16:9）' }   // 3人とスイーツ：2026-10-29 ユーザー指定
  ];

  // ── 最新情報（LATEST NEWS）─────
  // 新曲リリースはディスコグラフィ（releases/data.js）から自動で並ぶ。小説の毎日の話数更新は載せない（作品バナーの最新話で表示）
  // ここには手動のお知らせを書く：MV公開・新作発表・新連載開始・完結・Kindle発売・イベント・重要なお知らせなど
  // { date: 'YYYY-MM-DD', category: 'story'|'music'|'video'|'book'|'game'|'event'|'info', title, url（任意）, release（任意） }
  //   ・date が今日より先のものは、その日まで表示しない
  //   ・release: '作品ID' を書くと、同じ作品の自動の「リリース」行を出さない（同じ内容を二重に出さない）
  var news = [];

  // ── SHOP（構造だけ。visible を true にし、items を登録するまで表示しない） ──
  var shop = {
    visible: false,
    categories: [
      { id: 'music', label: 'CD・音楽作品' },
      { id: 'goods', label: 'キャラクターグッズ' },
      { id: 'live',  label: 'ライブ／ツアーグッズ' },
      { id: 'books', label: '紙の書籍・文学フリマ作品' }
    ],
    // { id, status:'public', category, title, works:['snowflakes'], artists:['amaoto-club'], price, url, image, imageSpec }
    items: []
  };

  // ── 文学作品（STORIES 内の領域。登録するまで表示しない） ──────────────
  // 応募歴（submissions）と受賞歴（awards）は混同しないよう別の欄で持つ
  // { id, status:'public', title, synopsis:[], cover, coverSpec:'1000×1500（2:3）', notes:[],
  //   submissions:[{ year, award:'○○文学賞', result:'一次選考通過' }], awards:[{ year, award:'○○賞', prize:'佳作' }],
  //   sales:[{ label:'文学フリマ', url }] }
  var literature = [];

  // ── SUPPORT（既存の support-lp.html へ案内） ───────────────────
  var support = { href: 'support-lp.html', text: '応援プランや、アプリ・ゲームの購入で活動を応援できます。' };

  global.SF_SITE = { entrances: entrances, works: works, games: games, videos: videos, contents: contents, news: news, literature: literature, shop: shop, support: support };
})(window);
