/* ============================================================
   releases/data.js — ディスコグラフィの登録データ（全アーティスト共通）
   ------------------------------------------------------------
   ■ 構造
     SONGS    : 楽曲（1曲1件）。シングルとアルバムに同じ曲が入る場合も、この1件を共用する
     RELEASES : 作品（Single / EP / Album）。収録曲は SONGS のキーを並べる
   ■ 表示のルール（disco.js が処理する）
     ・値が未登録（null・空文字・空配列）の項目は、公開ページに出さない
     ・URL が未登録の配信サービスはボタンを出さない
     ・画像が読めない／未登録のときは仮ジャケットを表示
     ・status が 'public' 以外、またはリリース日が未来の作品は一覧・詳細に出さない
       （'draft' = 準備中、'limited' = SWEETs 限定などの非配信）
   ■ 登録順と表示順
     ・ここに書く順番は表示に関係しない
     ・一覧はリリース日順（同じ日は order の小さい順）
     ・収録曲は RELEASES[].tracks に書いた順（＝トラック番号）
   ■ 日付
     ・releaseDate（リリース日）と createdDate（制作日）は別項目。形式は 'YYYY-MM-DD'
   ■ 関連エピソード（stories）
     type: 'in-story'（劇中登場曲）／'related'（関連楽曲）／'theme'（テーマ曲）
     work: 作品名、ep: 話数（任意）、epTitle: 話タイトル（原作の正式名称のみ・推測しない）、series: 新表示の作品名（省略時 Snow flakes）、label: 表示名（任意。ep が無いとき使用）、url、note: 短い説明（任意・新表示では非表示）
   ■ 歌詞・ことりノート（楽曲単位。SONGS の各曲に lyrics / kotoriNote を書く）
     ・改行・空行はそのまま表示される。複数行はテンプレート文字列（` で囲む）で書く
         lyrics: `1行目
     2行目

     2番の1行目`,
     ・シングルは作品詳細に、EP・Album は各楽曲ページに表示。未登録なら見出しごと出ない
     ・作品全体についてのノートは RELEASES の kotoriNote（任意）
   ■ SCENE GALLERY（楽曲・作品の gallery。関連エピソードと関連作品の間に表示。画像がなければ出ない）
         gallery: [{ order: 1, img: 'Discography/gallery/曲ID/01.webp', title: 'タイトル',
                     memo: `制作メモ（改行可）`, link: '関連ページのURL（任意）', focus: '50% 25%'（縦長画像の見せる位置・任意） }]
       ・枚数は自由。order の小さい順に並ぶ。title・memo は空でもよい（空なら重ねて表示しない）
       ・ここには表示に使う情報だけを書く。管理用の情報（元画像ファイル名・関連作品/楽曲・画像制作日・HP登録日）は
         制作用の管理ファイル（_サイト用対応表.json・サイトには置かない）にあり、img のパスでつながる（同じ情報を2か所に持たない）
       ・元画像は制作用の保管場所に保存（変更しない）。サイト用の WebP と管理情報の扱いは引き継ぎ資料を参照
   ■ 画像パスはサイトのルート（index.html と同じ階層）からの相対パス
   ■ 出典：リリース日・種別・収録曲・ISRC は 配信管理データ（Soundrop 同期）、
     配信URL・関連エピソードは既存の各アーティストページの表記から転記（2026-10-24）、
     話タイトル（epTitle）は原作ページの見出しから転記（2026-10-26 確認）
   ============================================================ */
(function (global) {
  var NOVEL = 'https://ncode.syosetu.com/n9009lo/';
  var MAIN = 'Snow flakes 本編';

  // ── 楽曲 ───────────────────────────────────────────────────
  // 項目：title, artists[], isrc, createdDate, versionOf（別バージョンの元曲キー）,
  //       spotify, amazon（曲単位のURL）, lyrics, kotoriNote, credits[{role,name}], mv（YouTube ID）, stories[]
  var SONGS = {
    'round-bounce': { title: 'Round Bounce', artists: ['snowflakes'], isrc: 'QZPJ32543034',
      spotify: 'https://open.spotify.com/intl-ja/track/6bhi3AvpNpYUFsQhVB9iHf',
      amazon: 'https://music.amazon.co.jp/albums/B0GT7CKP47?marketplaceId=A1VC38T7YXB528&musicTerritory=JP&trackAsin=B0GT793GCM',
      // 歌詞（2026-10-24 登録。行頭に空白を入れないこと＝そのまま表示される）
      lyrics: `靴先で鳴った音　気づかれないくらい
小さく蹴って　転がしてみた

予定は決めない　今日はなんとなく
リズムに任せてみる

深呼吸ひとつ　数えなくても
気分はもう前向き

揃えなくても　ズレてても
それがちょうどいい

丸い音が跳ねていく
笑うほどじゃない　でも楽しい

隣で鳴ればそれでいい
低いままで揺れている
止まらないこのリズム
気づいたら進んでた

言葉より先に鳴ったリズム
返事みたいに返ってくる
目が合っただけでなんとなく
通じた気がしてしまう

前に出なくても置いていかれない
この距離が好きなんだ

派手じゃないこの音が
今日を進めてる

転がした音が弾んでく
意味なんてあとでいい
続いてるならそれでいい
丸いままで繋がってく

止まらないこのリズム
気づいたらここにいた

低い場所で鳴り続ける
それだけで悪くない`,
      credits: [{ role: 'Lyrics & Music', name: 'Kotori Yamabuki' }],
      stories: [{ type: 'related', work: MAIN, ep: 82, epTitle: '幕間｜夏の日', url: NOVEL + '82', note: '物語の中では、コウタが手がけた楽曲。' }],  // epTitle は原作ページの表記（2026-10-25 確認）
      // SCENE GALLERY（試作 2026-10-27）：画像を受け取ったら1枚ずつ追加する（空のあいだは欄を出さない）
      // title・memo・order はユーザー指定のとおりに書く（創作しない）
      // 2026-10-27 登録（4枚・ユーザー指定の順。タイトル・制作メモは後日ユーザーが指定するまで空欄。元画像名・登録日などは _サイト用対応表.json）
      gallery: [
        // 制作メモ（2026-10-28 ユーザー指定の文をそのまま。加筆・省略・改変しない）
        { order: 1, img: 'Discography/gallery/round-bounce/01.webp', title: '', memo: `ヒナタ「来るとは思わなかった」`, link: '' },
        { order: 2, img: 'Discography/gallery/round-bounce/02.webp', title: '', memo: `コウタ「言い出したの、ヒナタだろ」`, link: '' },
        { order: 3, img: 'Discography/gallery/round-bounce/03.webp', title: '', memo: `ハヤテ「スライダー乗ろうぜ！」`, link: '' },
        { order: 4, img: 'Discography/gallery/round-bounce/04.webp', title: '', link: '',   // タイトルは表示しない（見出し「制作メモ」と重なるため・2026-10-28 ユーザー指示）
          memo: `Snow flakesのファーストシングルとして選んだ曲は、「Round Bounce」でした。

何曲か候補はあったのですが、楽しく跳ねていくようなリズムと、聴いているうちに自然と身体が動いてしまうような曲調が、初めてSnow flakesを知ってもらうきっかけとして、一番入りやすいと思ったからです。

この曲は、もともと別のシーンをイメージして先に作っていました。

でも　第82話「幕間｜夏の日」の一幕に、
この曲がぴったりはまると思ったんです。

社会人になってからの、何でもない休日。

音を出すでもなく、思いつきでプールへ出かけた三人が、子どものようにはしゃいで過ごします。

普段はあまり自分の感情を言葉にしないヒナタが、珍しく素直に口にした、

「めちゃくちゃ楽しい」

という言葉。

プールで遊んで、帰りにコンビニでアイスを買って、三人で並んで帰る。

特別な出来事があったわけではないけれど、きっと忘れられない一日。

そんな三人の何気ない夏の日が、Round Bounceの弾むようなリズムと自然に重なりました。

音楽制作については、当時まったくの素人でした。

それでもリリースを決めたのは、作中でヒナタが言った、こんな台詞に背中を押されたからです。

「でもさ。覚悟って、全部整ってからするもんじゃないと思うんだ」

「未完成でも、下手でも、それでも続けたいって思った時が、名乗るタイミングなんじゃないか」

この言葉に押されて、未完成で、下手なまま、リリースすることを決めました。

ちなみに、いざ配信しようとしたとき、ジャケット画像が必要なことをまったく考えておらず、焦りました。

純粋に音楽からSnow flakesを知ってほしいという気持ちもあったので、キャラクターの画像は使わず、シンプルなロゴだけのジャケットにしました。

そして、タイトルは普通に入れ忘れました。

ここは、いつか変えたいなと思っています。` }
      ] },
    'sweets': { title: 'SWEETs', artists: ['snowflakes'], isrc: 'QZPJ32544083',
      spotify: 'https://open.spotify.com/intl-ja/track/4fj4pzm4EsrNS1gjvD0VjU',
      amazon: 'https://music.amazon.co.jp/albums/B0GTWS1MWZ?marketplaceId=A1VC38T7YXB528&musicTerritory=JP&trackAsin=B0GTWQLWH3',
      // 歌詞（2026-10-28 ユーザー指定。行頭に空白を入れないこと＝そのまま表示される）
      lyrics: `気づけば君を
欲しがってる
甘い気配に
抗えない

君の香りに
落ちていく
もう目を逸らせない


まだ足りない
まだ欲しい
止める理由が
見つからない

わかってる
わかってる
それでも手が
伸びている


ひとくちで
ほどけていく
張りつめていた輪郭が
溶ける　溶ける
舌の上で

甘い顔して
近づくくせに
触れた瞬間　消えていく

それでも
なぜか
満ちていく


距離を測る
ふりをして
気づけばまた
目で追ってる

選んだはずが
選ばれて
戻れないって
わかってる


もうひとくち
確かめる
境目なんて
曖昧でいい

止まらない
止められない
欲しさだけが
残ってる


ひとくちで
ほどけていく
張りつめていた輪郭が
溶ける　溶ける
舌の上で

甘い顔して
近づくくせに
触れた瞬間　消えていく

それでも
なぜか
満ちていく


甘すぎるほど
わかってる
それでもまた
君を選ぶ

ひとくち分の
やさしさで
今日が
少し動き出す


ひとくちで
全部崩れる
理屈なんて
追いつかない

甘い顔して
近づくくせに
触れた瞬間　消えていく

それでも
なぜか
満ちていく`,
      stories: [{ type: 'related', work: MAIN, ep: 80, epTitle: '幕間｜SWEETs', url: NOVEL + '80' }] },
    'oita-oto': { title: '置いた音', artists: ['snowflakes'], isrc: 'QZPJ32545428',
      spotify: 'https://open.spotify.com/intl-ja/track/0GwRrnME0Tn5qsEbc2w2eG',
      // 歌詞（2026-10-28 ユーザー指定。貼り付けで各行の先頭に付いた全角空白は除いた。それ以外は原文のまま）
      lyrics: `朝になりきれない光が
カーテンの端で止まってる
昨日の続きみたいな今日を
まだ名前もつけずに歩く

靴紐を結び直すみたいに
何度も呼吸を確かめて
強くなりたいわけじゃない
ただ　消えたくないだけ

誰かの正解をなぞるたび
自分の輪郭が薄れていく
守ってきた沈黙が
今　少しだけ疼いた

壊さずに進めると思ってた
でも　置いた音は戻らない
優しさの裏に隠してた
本音がまだ　鳴り止まない

小さくても、歪んでても
これが今の俺の全部だ
綺麗じゃなくていいから
ここにいると　言わせてくれ

言葉にすれば簡単で
黙れば全部、嘘になる
選ばなかった未来たちが
夜になると肩を叩く

逃げてるように見えたなら
多分、それも間違いじゃない
でも　立ち止まった場所にも
ちゃんと理由はあった

期待されない温度で
守れたものも確かにあって
強がりと弱さの間
まだ線は引けない

壊さずに進めると思ってた
でも　置いた音は戻らない
誰かのためじゃなくても
鳴らしたい夜がある

静かでも、遠回りでも
消さなかった、それだけで
間違いじゃないと
今は、信じてみたい`,
      stories: [{ type: 'related', work: MAIN, ep: 34, epTitle: 'まだ続いている音', url: NOVEL + '34' }] },

    // Early Snow
    'yakusoku-wa-shinai': { title: '約束はしない', artists: ['snowflakes'], isrc: 'QZPJ32548354',
      spotify: 'https://open.spotify.com/intl-ja/track/4zq4FMTEfQ6Kb1dwf1egBP',
      amazon: 'https://music.amazon.co.jp/albums/B0GYG1KV9H?marketplaceId=A1VC38T7YXB528&musicTerritory=JP&trackAsin=B0GYFZCXJX',
      // 歌詞（2026-10-28 ユーザー指定。[Verse] [Pre-Chorus] [Chorus] の見出しは指示により外した。歌詞の文はそのまま）
      lyrics: `誰かが鳴らせば
誰かが笑う

止まっていた夜が
動き出してく

弾けた音が
重なっていく

このリズムで
ちょうどいい

少しずつ変わる
少しずつ進む

音が広がる

未完成のまま

答えを探さなくても
音は鳴っている

ばらばらのままで
進んでいく

約束はしない

ただ鳴らす

このリズムで
ちょうどいい

転びそうな夜も
音が支える

誰かが弾けば
誰かが笑う

少しずつ変わる
少しずつ進む

音が広がる

未完成のまま

答えを探さなくても
音は鳴っている

ばらばらのままで
進んでいく

約束はしない

ただ鳴らす

このリズムで
ちょうどいい

これからも続く
この音で` },
    'toumei-no-mama': { title: '透明のまま', artists: ['snowflakes'], isrc: 'QZPJ32548355',
      spotify: 'https://open.spotify.com/intl-ja/track/0xJ6A7mdJvC1IvjFf5dnyi',
      amazon: 'https://music.amazon.co.jp/albums/B0GYG1KV9H?marketplaceId=A1VC38T7YXB528&musicTerritory=JP&trackAsin=B0GYFXHKXP',
      // 歌詞（2026-10-28 ユーザー指定・原文のまま）
      lyrics: `形のないこの鼓動を
両手で守ってる

まだ言えないこの言葉を
胸の奥で転がしてる

心の弾む方へ
歩き出したその先に
星を見つけた

一歩ずつ進んでいく
一言ずつ未来を置く

小さく鳴る音を
こぼれる前にすくいとる

透明のまま走ってく

形のないこの景色を
少しずつ見ている

まだ小さなこの声を
胸の奥で鳴らしてる

心の弾む方へ
歩き出したその先に
星を見つけた

一歩ずつ進んでいく
一言ずつ未来を置く

小さく呼ぶ声を
こぼれる前にすくいとる

透明のまま走ってく
止まらずに走ってく`,
      stories: [{ type: 'related', work: '透明なリズム', url: 'https://ncode.syosetu.com/n5484lz/' }] },
    'little-snow-near': { title: 'Little Snow（Near）', artists: ['snowflakes'], isrc: 'QZPJ32548356', versionOf: 'little-snow', versionOrder: 2, lyricsFrom: 'little-snow',   // 歌詞は通常版と同じ（曲調だけ違う・2026-10-28 ユーザー確認）
      spotify: 'https://open.spotify.com/intl-ja/track/08rEcBRTnq4S5GyOYRLR8F',
      amazon: 'https://music.amazon.co.jp/albums/B0GYG1KV9H?marketplaceId=A1VC38T7YXB528&musicTerritory=JP&trackAsin=B0GYFZBHQJ',
      stories: [{ type: 'related', work: '白い音', url: 'https://ncode.syosetu.com/n0679lx/' }] },
    'still': { title: 'Still（Untitled）', artists: ['snowflakes'], isrc: 'QZPJ32548357',
      spotify: 'https://open.spotify.com/intl-ja/track/2SruInzN6ml3bRX4tPpT0T',
      amazon: 'https://music.amazon.co.jp/albums/B0GYG1KV9H?marketplaceId=A1VC38T7YXB528&musicTerritory=JP&trackAsin=B0GYFWZT26',
      // 歌詞（2026-10-28 登録。空行は1つに統一＝ユーザー指示）
      lyrics: `何も変わらない夜に
指だけが動いてる
言葉にしないままのこと
そのまま鳴らしてる
窓の外は静かで
時間だけが進んでる

触れなくていい傷も
今はふれないまま
決めなくていい未来も
まだ決めないまま
答えを探すより
消さないことを選ぶ

ここにある
それだけでいい
消えなかった
小さな音
動かないまま
揺れている
まだ名前は
いらない

遠くなる声もある
近づく影もある
選ばないことも
ひとつの形で
強くならなくていい
折れなければいい

誰の答えでもない
でも　嘘でもない
急がなくていい
なくならなければ

置いたままの気持ちが
少しだけ揺れている
形にならないまま
ここに残っている

名前を呼ばなくても
消えないものがある
たぶんそれだけで
今は足りている

ここにある
今もまだ
溶けきらない
静かな音
終わらなくていい
消えなければ
ただ　ここに
あるだけで`,
      stories: [{ type: 'related', work: 'Kindle', label: 'Kindle 3', url: 'https://amzn.asia/d/03DKJjbm' }] },
    'namae-no-nai-uta': { title: '名前のない歌', artists: ['snowflakes'], isrc: 'QZPJ32548358',
      spotify: 'https://open.spotify.com/intl-ja/track/6NOZewWG99R1nhgVljsziN',
      amazon: 'https://music.amazon.co.jp/albums/B0GYG1KV9H?marketplaceId=A1VC38T7YXB528&musicTerritory=JP&trackAsin=B0GYFRL382',
      // 歌詞（2026-10-28 登録。行頭の全角空白は貼り付け由来として除去）
      lyrics: `指に残る　ぬるいままの
理由のない　重さだけ
落としたはずの　あの瞬間
音もなく　床に消えた

呼ばれてない　はずなのに
振り向いたのは　なぜだろう
形のない　輪郭が
まだ　消えきらない

小さくて
溶けそうで
名前も持てないまま

消えなかった
何も言わず
まだ　そこにある

抱えたら
壊れそうで
触れずに　置いている

消えなかった
息のあと
残ったまま

しまい忘れた　みたいな顔
部屋の隅で　待っている
声にしたら　割れそうで
今日はまだ　歌えない

ふれてない　はずなのに
思い出すのは　なぜだろう
形のない　温度だけ
まだ　消えきらない

小さくて
溶けそうで
それでも　離れなくて

消えなかった
呼ばなくても
消えなかった

名前のないまま
まだ　残っている`,
      stories: [{ type: 'related', work: MAIN, ep: 19, epTitle: '音楽室の鍵', url: NOVEL + '19' }] },
    'little-snow-raw': { title: 'Little Snow（Raw）', artists: ['snowflakes'], isrc: 'QZPJ32548359', versionOf: 'little-snow', versionOrder: 1, lyricsFrom: 'little-snow',   // 別バージョン欄では Raw → Near の順（2026-10-28 ユーザー指示）   // 歌詞は通常版と同じ（曲調だけ違う・2026-10-28 ユーザー確認）
      spotify: 'https://open.spotify.com/intl-ja/track/2Fo3lO8znQ2OqswOhbupXa',
      amazon: 'https://music.amazon.co.jp/albums/B0GYG1KV9H?marketplaceId=A1VC38T7YXB528&musicTerritory=JP&trackAsin=B0GYFQHQF2',
      stories: [{ type: 'related', work: MAIN, ep: 53, epTitle: 'Little Snow', url: NOVEL + '53' }] },

    // シングル（2曲入り）
    'rabbit': { title: 'Rabbit', artists: ['snowflakes'], isrc: 'QZPJ32554976',
      // 歌詞（2026-10-28 登録。シングル版。Full Moon Version には付けていない）
      lyrics: `気がついたら
君のいるほうへ
足が向いてる

わかっていても
とめられない

もう
隠せない

君が笑う
この距離から
目を逸らせない

抑えていた音が
先に
跳ねていく夜

跳ねる　跳ねる
丸い音が

もう
じゅうぶん
気づいてる

君がいる
この場所から
目を逸らさない

とまらない
音が
先に
跳ねていく夜

跳ねる　跳ねる
丸い音が

届け　届け
君のもとへ` },
    'happy-end': { title: 'ハッピーエンドはいらない', artists: ['snowflakes'], isrc: 'QZPJ32554977',
      // 歌詞（2026-10-28 登録。ユーザー指示で整形：行頭の全角空白・[Interlude] を除去、空行は1つに、「、」は全角空白に）
      lyrics: `テーブルの上　開いたページ
ケーキはまだ　途中のまま

目が合って　少し笑って
また同じとこ戻って

時間だけが
先に進んでいく

少しだけ
近い距離のままで

甘いな
ちゃんと甘いな

甘いな
なんか今日　甘いな

ハッピーエンドじゃなくていい

この続きを
もう少しだけ　見ていたい

窓の向こう　流れる景色
知らない話　増えていく

笑うたびに
少しだけまた

言えないことも
増えていく

しおりだけが
同じ場所にいる

閉じたまま
忘れられないまま

甘いな
ちゃんと甘いな

甘いな
なんか今日　甘いな

ハッピーエンドじゃなくていい

この続きを
もう少しだけ　見ていたい` },
    'signal': { title: 'Signal', artists: ['snowflakes'], isrc: 'QZPJ32556054',
      spotify: 'https://open.spotify.com/intl-ja/track/2WEmeAbnB8Lc9bMWoFlndg',
      // 歌詞（2026-10-28 登録。行頭の全角空白は貼り付け由来として除去。「あいだで」は「間で」に統一、「間で」の前の空白は2か所とも削除＝ユーザー指示）
      lyrics: `夜の端で　光が跳ねる
合図みたいに　空が鳴る

弧を描いて　走る線
鼓動と一緒に　リズムが来る

急がなくて　いいんだと
重なる音が　教えてる

ずれてた世界が　今
きれいに　噛み合った

Signal　今　鳴ってる
胸の奥で　はっきりと

動いているだけで
ここに　立てる

光が巡って　弾けていく
音と身体の間で

逃げなくていい場所を
今　見つけた

グラス越しに　光が走る
夜を抜けて　弧を描く

散らばってた　昨日までが
ひとつの流れに　変わってく

強さじゃなく　軽さでいい
迷いは　もういらない

一歩ごとに　足元が
まっすぐ　応えてくれる

Signal　今　確かに
この胸で　響いてる

跳ねるこの瞬間が
俺を　連れていく

消えて　生まれて　また光る
合図は　風の中

爽やかな夜空が
背中を　押していく

Signal　今　鳴ってる
胸の奥で　はっきりと

動いているだけで
ここに　立てる

光が巡って　弾けていく
音と身体の間で

逃げなくていい場所を
今　見つけた

Signal　今　確かに
この胸で　響いてる

跳ねるこの瞬間が
俺を　連れていく

消えて　生まれて　また光る
合図は　風の中

爽やかな夜空が
背中を　押していく` },
    'glass-no-fuchi': { title: 'グラスの縁', artists: ['snowflakes'], isrc: 'QZPJ32556055',
      // 歌詞（2026-10-28 登録。行頭の全角空白は貼り付け由来として除去）
      lyrics: `グラスの縁　指でなぞって
まだ始まらない夜を見てる

悪くないな　この感じ
ちゃんと揃わないくらいがいい

笑い声が転がって
グラスが小さく鳴ってる

気づけばまたこの場所で
同じ夜を囲んでる

火をつける前の静けさで
だいたい全部　わかるから

消えないうちに　いこうぜ
このまま　燃えるとこまで

自由でいい
でも　置いていかない程度に

火が上がる瞬間だけ
ちゃんと見てりゃいい

なあ　今日はいい感じ
珍しく　ちゃんと回ってる

笑えればそれで十分だろ

少し減ったグラス越し
滲む灯りを眺めてる

悪くないな　この感じ
ちょっと揺れてるくらいがいい

氷がひとつ鳴るたびに
夜が少し深くなる

今日は何も喋らない
それも案外悪くない

風を読む前の静けさで
だいたい全部　わかるから

消えないうちに　いこうぜ
このまま　行けるとこまで

自由でいい
でも　置いていかない程度に

火が上がる瞬間だけ
ちゃんと見てりゃいい

なあ　今日はいい感じ
珍しく　ちゃんと回ってる

笑えればそれで十分だろ

自由でいい
でも　置いていかない程度に

火が上がる瞬間だけ
ちゃんと見てりゃいい

なあ　今日はいい感じ
珍しく　ちゃんと回ってる

笑えればそれで十分だろ

それで十分だろ` },
    'little-snow': { title: 'Little Snow', artists: ['snowflakes'], isrc: 'QZPJ32557793',
      versionsNote: 'Raw から、Near へ。そして Little Snow へ。',   // 別バージョン欄の下の一言（この曲のページだけ・2026-10-28 ユーザー指定）
      spotify: 'https://open.spotify.com/intl-ja/track/0bUCsMWqBHC1JPJZaC4TGw',
      // 歌詞（2026-10-28 ユーザー指定・原文のまま。行内の空白は半角のまま）
      lyrics: `雪が降るたび思い出す
小さな公園と笑い声
同じ音を分け合って歩いた
駅裏の坂 夜更けの窓 吐く息の白さ

まとまらない感情は
小さくて溶けそうで
胸の中に白く残る

静かに静かに降り積もるリトルスノー
この白さを君がほどいてくれたら

風の音 ブランコの影
水たまりに映る空
あの頃の音はまだ残ってる

言葉を形にする前に
溶けていくのが怖くて
触れられないまま胸にある
こぼれ落ちそうに白いまま

静かに静かに降り積もるリトルスノー
この白さを君がほどいてくれたら

雪が積もる前の土の匂いが
あの頃のまま
名前を呼ばずに君を呼んでいた` },
    'oto-ga-kieru-made': { title: '音が消えるまでは', artists: ['snowflakes'], isrc: 'QZPJ32557794',
      spotify: 'https://open.spotify.com/intl-ja/track/5dPzNXMgEAgmQVjEaNwthC',
      // 歌詞（2026-10-28 ユーザー指定・原文のまま。行頭の全角空白は貼り付け由来として除去、「、」→全角空白〔ユーザー指示〕）
      lyrics: `西日の残る　音楽室で
誰かのコードが　少しずれた
言葉もなく　また合わせて
それだけで　時間が伸びた

名前なんて　なくてもよかった
約束なんて　しなくてよかった
この音が　いつまでも
続いていくと　わかってた

まだこの音の中にいたい
誰かに言うほど大きな夢じゃない
でも　今日だけで終わらせたくない
指先だけが　次を知ってる

まだ帰らない
音が消えるまでは
約束なんて　ひとつもないのに
明日もきっと　ここで鳴らしてる

制服の袖を　少し上げて
自販機の灯りで　乾杯した
苦い缶コーヒー　笑って飲んで
大人になった　ふりをした

帰る時間は　過ぎていたけど
誰も時計を　見ようとしない
この音が　いつまでも
続いていくと　わかってた

まだこの音の中にいたい
誰かに言うほど大きな夢じゃない
でも　今日だけで終わらせたくない
次の音だけ　もう聞こえてる

まだ帰らない
音が消えるまでは
約束なんて　ひとつもないのに
明日もきっと　ここで鳴らしてる

いつか違う場所で
違う朝を迎えても
あの日の続きを
探してしまう気がした

まだこの音の中にいたい
誰かに言うほど大きな夢じゃない
でも　今日だけで終わらせたくない
言葉もなく　また合わせて

まだ帰らない
音が消えるまでは
約束なんて　ひとつもないのに
明日もきっと　ここで鳴らしてる

音が消えるまでは
ここで鳴らしてる` },

    // 瞬間に残る（アルバム新曲・別バージョン）
    'rabbit-full-moon': { title: 'Rabbit (Full Moon Version)', artists: ['snowflakes'], isrc: 'QZPJ32560127', versionOf: 'rabbit',
      spotify: 'https://open.spotify.com/intl-ja/track/6cMYdScQVqsmjjpuH9ykUv' },
    'sweets-brass': { title: 'SWEETs (Brass Band Version)', artists: ['snowflakes'], isrc: 'QZPJ32560124', versionOf: 'sweets',
      spotify: 'https://open.spotify.com/intl-ja/track/0tThknA9X9JOQwI9VeMec6' },
    'shukusou': { title: '祝奏', artists: ['snowflakes'], isrc: 'QZPJ32560125',
      spotify: 'https://open.spotify.com/intl-ja/track/0rZVIYnO4eqCBUgwwftfZm',
      // 歌詞（2026-10-28 ユーザー指定・原文のまま。行頭の全角空白・冒頭の空行は除去、連続する空行は1つに統一、「、」→全角空白〔ユーザー指示〕）
      lyrics: `名前もつけないまま
置いてきた音がある
うまく言えなかった日も
同じ場所で鳴っていた

遠くまで来たようで
まだあの日の続きみたいだ
変わらないものだけが
少し形を変えていく

白い光の中で
少しだけ息を吸う
笑っているはずなのに
胸の奥が震えてる

今日もここで鳴っている
派手じゃないこの音が
言えなかったありがとうを
代わりに抱えている

何者でもなかった僕らが
何者でもないまま
それでも続いてきたことを
今　ここに置いていく

言葉にしてしまえば
足りなくなる日もあった
何も決めていないのに
隣にいる日が増えた

間違えたリズムさえ
いつか笑い話になった
止まらずにいたことが
答えみたいに残っていた

白い光の奥で
少しだけ目を伏せた
鳴らす前からもう
胸の奥が震えてる

今日もここで鳴っている
名もないままの音が
言えなかったありがとうを
やさしく連れてくる

何者でもなかった僕らが
何者でもないまま
それでも続いてきたことを
今　君に渡すよ

大げさな言葉じゃなくて
いつもの音でよかった
ここまで来たことだけを
そっと鳴らせばよかった

今日もここで鳴っている
派手じゃないこの音が

何者でもなかった僕らが
何者でもないまま
それでも続いてきたことを
今　ここに残していく

名前もつけないまま
終わらない音がある
言えなかったありがとうが
まだ　ここで鳴っている` },
    'kokyu-no-kyori': { title: '呼吸の距離', artists: ['snowflakes'], isrc: 'QZPJ32560128',
      spotify: 'https://open.spotify.com/intl-ja/track/7JMBejlryPC4L4biF7661B',
      // 歌詞（2026-10-28 ユーザー指定。語句は原文のまま、改行が多いため行をまとめた〔ユーザー指示〕。つなぎ目は全角空白）
      lyrics: `ドアを閉める音が　少し遅れて
同じ部屋に残る

触れないまま　分かっている
詰めなくても　離れない

呼吸の距離で　並んでいる
言葉はいらない　目を閉じれば

近づかず　離れず
続いていく

同じ速さで　重なっていく

揺れないまま　揺れている
触れなくても　届いている

静かなまま
確かに　息をしてる

この距離ごと　抱きしめている` },
    'shunkan-ni-nokoru': { title: '瞬間に残る', artists: ['snowflakes'], isrc: 'QZPJ32560123',
      spotify: 'https://open.spotify.com/intl-ja/track/2SH2RzviQh6OjjIoUPxEiG',
      // 歌詞（2026-10-28 ユーザー指定。語句は原文のまま、改行が多いため行をまとめた〔ユーザー指示〕。つなぎ目は全角空白）
      lyrics: `言ってしまった一言が
部屋の隅で　まだ鳴ってる

言えなかった一言は
机の上で　伏せたまま

正しかったかなんて
今更分からない

振り返るほど　遠くなる

触れなかった　その温度

形を持たないまま　残っているもの

瞬間に残る

謝れないまま　残っている

抱えきれず　置いてきた
言葉の影

声を落とした理由も
今は思い出せない

笑ったままの顔が
一番　厄介だった

戻れるならなんて
考えないふりをした

近づくほど　遅れてく

間違いだと　言えないまま

形を持たないまま　残っているもの

瞬間に残る

拾い集めても　意味にはならない

それでも　消えない
感情だけ

名前を呼ばずに　夜が終わる
その前に

言えなかった　一言だけ` },
    'hana-no-namae': { title: '花の名前を忘れても', artists: ['snowflakes'], isrc: 'QZPJ32560126',
      spotify: 'https://open.spotify.com/intl-ja/track/3kItLq8qo4x30Muq6czaNs',
      // 歌詞（2026-10-28 ユーザー指定・原文のまま。連続する空行は1つに統一、「、」→全角空白〔ユーザー指示〕。行内の半角空白は原文のまま）
      lyrics: `写真の端に切れて残った
色だけを覚えている

名前を呼んだことさえ
もう　遠い

借りたままの本のページに
挟んだままの薄い花

返せないのは
君を忘れたからじゃない

花の名前を忘れても
季節はまた巡る

あの時止めた言葉の先に

咲いていた花の色は
今も覚えている

一歩に満たない空白を
守るように歩いていた

言えなかった理由だけ
今も探してる

ガラス越しにふと見つけた
小さく揺れた 淡い花

近づけないのは
僕が傷つきたくなかったから

花の名前を忘れても
季節はまた巡る

借りたままの本の中に

咲いていた笑顔は
今も覚えている

花の名前を忘れても
季節はまた巡る

借りたままの本を閉じて
返す言葉を探してる

咲いていた笑顔を胸に
振り返らず歩いていく` },
    'low-light': { title: 'Low Light', artists: ['snowflakes'], isrc: 'QZPJ32560122',
      spotify: 'https://open.spotify.com/intl-ja/track/2s7RTt9gAPHnQHyCR6dIsg',
      // 歌詞（2026-10-28 ユーザー指定・原文のまま。[Intro] 等の見出しは除去）
      lyrics: `夜の端に　残った灯り
静かに揺れてる

言えなかった言葉が
ポケットの中で冷えてる
うまく笑えない日も
悪くないと　思えたら

遠回りでもいい
止まらなければ

低い声で　鳴らせばいい
大きくなくていい
まっすぐ　揺れずに
君に届けばいい

焦らなくていいさ
夜はちゃんと明ける
背中越しの風が
少しだけ　あたたかい

強くなくていい
折れなければ

低いままで　進めばいい
派手じゃなくていい
静かに　確かに
ここにいると　鳴らせばいい

風がまた　動き出す
それだけでいい` },

    // Undertone
    'undertone': { title: 'Undertone', artists: ['snowflakes'], isrc: 'QZPJ32563423',
      // 歌詞（2026-10-28 ユーザー指定・原文のまま。行頭の全角空白は貼り付け由来として除去）
      lyrics: `静かなランプが
揺れていた

誰もいないはずなのに
何かが鳴っていた

足を止めたまま
見えないものばかり探して

聞こえないふりをしてた
声がまだ残っている

誰だ

誰だった

思い出せない

でも消えない

まだ　迷っている？

耳の奥で
誰かが笑った

置いてきたはずなのに
音だけ戻ってくる

まだ　終わっていない

何も選んでないのに

帰る場所みたいに
また灯りが見える

名前なんて
知らなくていい

答えを探すほど
遠くなっていく

言わなかった言葉も
触れなかった音も

沈んだまま
ここにいる

まだ　迷っている？

怖いくらい静かなのに

どうしてだろう

……悪くない` },
    'spring-waltz': { title: 'Spring Waltz', artists: ['snowflakes'], isrc: 'QZPJ32563424',
      // 歌詞（2026-10-28 ユーザー指定・ユーザーが整えた改行のまま。「少しだけ　乱してもいい？」の空白は全角に〔ユーザー指示〕）
      lyrics: `間違ってないのに
どこか遠い
それでいいと
言い聞かせて

整った動きで
なぞるように触れる
綺麗すぎて
何も残らない

届かないまま
完成してる

正しい距離より
触れている方がいい
その方がきっと
ここに残る

正しい距離より
触れている方がいい
言葉にしなくても
分かる気がして

白い手袋に
跡は残らない
それなのにまだ
消えない熱がある

近づきすぎたと
誰かが言っても
離れたままでは
気づけない

綺麗な形のまま
守られてる

正しい距離より
触れている方がいい
その方がきっと
息ができる

正しい距離より
触れている方がいい
間違いだとしても
忘れない気がして

正しさだけじゃ
届かないなら

少しだけ　乱してもいい？

正しい距離より
触れている方がいい
その方がきっと
ここに残る

正しい距離より
触れている方がいい
言葉にしなくても
分かる気がして

正しい距離より
触れている方がいい
綺麗なままでは
届かないものがある

正しい距離より
触れている方がいい
言葉にしなくても
分かる気がして` },
    'aftertone': { title: 'Aftertone', artists: ['snowflakes'], isrc: 'QZPJ32563422',
      // 歌詞（2026-10-28 ユーザー指定・原文のまま）
      lyrics: `夜が少し長くなっただけ
帰る道は変わっていない

足音だけ一つ増えて
振り向いても誰もいない

置いた音は消えたはずだった
名前も付けず置いたまま

鳴っている　遠くで

忘れた場所から
戻るはずのない音がまた触れた

静かなまま　何も言わず
少しだけ隣にいる

古い傷も癖みたいに
思い出さず触れてしまう

知らないまま拾ったものが
何故かまだ手に残る

……聞こえるか？
ひとつ多い音

鳴っている　今も

置いたままなのに
消したはずの景色まで連れてくる

言葉じゃなく　形でもなく
ただそこで待っていた` },

    // In One Sky
    'in-one-sky': { title: 'In One Sky', artists: ['snowflakes'], isrc: 'QZPJ32563425',
      // 歌詞（2026-10-28 ユーザー指定・原文のまま。[Instrumental Intro] の見出しは除去、連続する空行は1つに統一、「ふれないだけ」→「触れないだけ」〔ユーザー指示〕）
      lyrics: `月はまだ
沈まないまま

朝の端で
息をしている

太陽は
気づかないふりで

同じ空を
少しだけ照らす

In One Sky

会えないわけじゃない
触れないだけ

遠いわけじゃない
眩しいだけ

声にする前に
音だけ残した

月はまだ
見えない場所で

太陽の影を
覚えている

夜はまだ
明けないまま

窓の外で
色を変えている

太陽は
振り向かないまま

月の輪郭を
そっと消していく

In One Sky

重ならなくても
同じ空にいる

呼べないわけじゃない
守っただけ

消えないわけじゃない
残しただけ

胸の奥に
音だけ隠した

月はまだ
遠い場所から

太陽の熱を
覚えている

In One Sky

重ならなくても
同じ空にいる

In One Sky

気づかないまま
すれ違う朝に

消えない音だけが
静かに残る` },
    'kaeranai-hodo': { title: '帰らないほどでもない', artists: ['snowflakes'], isrc: 'QZPJ32563426',
      // 歌詞（2026-10-28 ユーザー指定・原文のまま。[Verse] 等の見出しと演奏指示〔英文〕は除去、行ごとの空行は除去して連ごとに1つ、8行の連は4行ずつに分けた、「、」→全角空白）
      lyrics: `「別に意味ないけど」って
鳴らしたコードが残ってる
コンビニ前　二本目の缶
炭酸だけ先に抜けた

笑ってるふりくらい
今はうまい気がしてる
どうでもいい話だけ
やたら覚えてるのに

夜風がちょっとぬるい
帰る理由もない
でも　帰らないほどでもない
たぶんそんな感じで
今日も終わっていく

名前もない歌を
口ずさんだまま
「またね」も言わずに
手を振った

駅前の光が
少しだけ滲んだ
意味なんかないよ
たぶん　最初から

ポケットの奥にまだ
レシートだけ残ってる
買ったものは全部
もう忘れたはずなのに

話してた内容は
ほとんど覚えてないのに
笑ったタイミングだけ
やけに残っていた

駅前の人影も
少しずつ減っていった
急ぐ理由もない
でも　止まるほどでもない

名前もない歌を
口ずさんだまま
「またね」も言わずに
手を振った

駅前の光が
少しだけ滲んだ
意味なんかないよ
たぶん　最初から

特別な意味もなく
鳴らしたコードが残ってる

口ずさんだ歌の先に

残る音だけ
消えなかった` },

    // プリズム
    'prism': { title: 'プリズム', artists: ['snowflakes'],
      // 歌詞（2026-10-28 ユーザー指定・チャットで受け取った版。D の プリズム歌詞_2026.7.17.txt ではなくこちらを登録。[Verse] 等の見出しは除去）
      lyrics: `あの日見ていた景色は
今も色を失わない
同じ風に吹かれても
違う匂いを覚えてる

振り返ることさえ
今は遠く感じるけれど

迷いながら選んだ日々が
この場所へ繋がっている

ひとりでは見えなかった景色
いま重ねて
違う色を映しながら
同じ空へ続いてく

重なって離れて
見えない明日へ伸びる
小さなプリズム

交わした視線の先に
新しい季節が広がる
同じ風を受けながら
違う景色へ手を伸ばす

選んできた道の先
いくつもの未来が見える

それぞれの歩幅で今
同じ場所から進んでいく

ひとりでは選べなかった未来
いま重ねて
違う色を映しながら
同じ空へ続いてく

重なって離れて
見えない明日へ伸びる
小さなプリズム

光の向きを変えるたび
知らない色に出会ってく

交わる道の先で
一つの景色に変わる

ひとりでは見えなかった景色
いま重ねて
違う色を映しながら
同じ空へ続いてく

重なって離れて
見えない明日へ伸びる
小さなプリズム` },
    'koko-ni-iru': { title: 'ここにいる', artists: ['snowflakes'],
      // 歌詞（2026-10-28 ユーザー指定・原文のまま。【Verse 1】等の見出しは除去、「風がとおって」→「風が通って」、行内の全角空白は除去〔ユーザー指示〕。対句の2行〔急がないで／急がなくていい〕だけ空白を残した）
      lyrics: `ライトが少し遠くなって
残った音だけ胸に降る
うまく言えない今日のことも
このまま音に預けていい

空いたフロアに風が通って
ほどけた熱を連れていく
終わったはずの歌の先で
まだ鳴るものを探していた

急がないで　消えないで
小さな音がそばにいる
揺れる影が並んだまま
同じ速さで夜を越える

言葉じゃなくて届くものを
君の明日へそっと置いていく
名前のないまま残る想いが
いつか君を照らせるように

街の明かりがにじむたびに
今日の景色が遠ざかる
選べなかった言葉ばかり
ポケットの中揺れていた

何も変わらないふりをしても
少しずつ夜は明けていく
君が笑ったその瞬間を
なくさないように歩いていく

届かなくて迷う日も
小さな音は消えないから
違う景色を見ていたって
同じ速さで夜を越える

言葉じゃなくて届くものを
君の明日へそっと置いていく
名前のないまま残る想いが
いつか君を照らせるように

もしも明日が遠く見えて
足を止めそうになったなら
あの日の音を思い出して
君の速さで進めばいい

振り返らなくてかまわないよ
見えなくなってもここにいる
離れた場所で朝を迎えても
同じ音を覚えている

言葉じゃなくて届くものを
君の明日へそっと置いていく
名前のないまま残る想いが
いつか君を照らせるように

急がなくていい　迷ってもいい
君の歩幅で朝へ向かえばいい
離れた場所で同じ空を見て
同じ速さで夜を越える

ライトがすべて消えたあとも
残った音だけ胸に降る
うまく言えない今日のことを
このまま君に預けていく` },

    // まだ鳴ってる（2026-10-27。曲名・収録曲は Amazon Music、リリース日は Apple の公開情報で確認。Spotify は配信後に追加）
    'mada-natteru': { title: 'まだ鳴ってる', artists: ['snowflakes'],
      // 歌詞（2026-10-28 ユーザー指定・ユーザーが整えた版のまま）
      lyrics: `暗い画面に音が灯る
止まった時間が少し動く
迷いながらでもここに立って
小さなビートで夜を越える

うまくいかない日々の中で
なくした言葉を拾い集めた
正しい答えは分からなくても
鳴らした音だけ嘘じゃなかった

震える指で弦に触れた
静かな夜が息を始める

鳴らせ　まだ鳴ってる
消えない音が胸を叩く
走れ　まだ届く
このステージで明日を呼べ

ライトが揺れて君が笑った
僕らの音は終わらない

遠くの声が近くなって
重なる鼓動が熱をつくる
ひとりで抱えた痛みさえも
今なら音に変えていける

選ばなかった道の先を
振り返る夜もきっとあるけど
ここまで続いたこの足跡を
間違いだったと呼びたくはない

かすれた声で名前を呼んだ
見えない壁が少し崩れた

鳴らせ　まだ鳴ってる
消えない音が胸を叩く
走れ　まだ届く
このステージで明日を呼べ

ライトが揺れて君が笑った
僕らの音は終わらない

何度暗闇に戻されても
何度この手を離しても
耳を澄ませばそこにある
始まりの日と同じ音

止まったままじゃ終われない
まだ僕たちは歌えるから

鳴らせ　まだ鳴ってる
消えない音が胸を叩く
走れ　まだ届く
このステージで明日を呼べ

叫べ　まだここにいる
重ねた音を空へ放て
進め　まだ見える
揺れる光のその向こうへ

ライトが揺れて君が笑った
僕らの夜は終わらない
僕らの音は終わらない

暗い画面に音が灯る
止まった時間がまた動き出す` },
    'nigai-purin': { title: '苦いプリン', artists: ['snowflakes'],
      // 歌詞（2026-10-28 ユーザー指定・原文のまま）
      lyrics: `苦いプリン　少し欠けたまま
甘い匂いだけ　口元にまだ残ってる

飲み込んだ言葉だけ　喉の奥でまだ揺れて
飲みかけのカップに　少し冷めた夜が残る

気づかないふりした苦い味も
ちゃんと抱えたまま　歩いていける

忘れたいわけじゃない
戻りたいわけでもない
まだ名前のない気持ちを
置いていけないだけ

気づけば探してる
ライブハウスでも駅前でもなくて

名前を呼ぶ声とか
小さく笑う顔とか

また会えたなら　ちゃんと笑えるように
今は少しだけ前を向いてる

新しい靴の音が　知らない道に溶けていく
立ち止まるたびにまた　思い出すこともあるけど

なくしたものを数えるよりも
残っているものを信じてみたい

答えなんてなくても
間違いだったとしても
あの日　選んだことまで
嫌いにはなりたくない

苦いプリン　少し欠けたまま
甘い匂いだけ　胸の奥にまだ残ってる

気づけば探してる
人混みの向こう　信号が変わる前に

振り返る横顔とか
ふいにほどける声とか

また会えたなら　今度は逃げないように
まだ不器用でも前を向いてる

季節が変わっても　消えないものがある
そのままでいいと　ようやく思えた

気づけば探してる
ライブハウスでも駅前でもなくて

名前を呼ぶ声とか
小さく笑う顔とか

また会えたなら　ちゃんと笑えるように
今は少しだけ前を向いてる

甘い匂いが　背中を押すから
もう少しだけ歩いてみる

あと少しだけ　もう少しだけ
歩いてみる` },

    // TOWA
    'todoku-basho': { title: '届く場所', artists: ['towa'], mv: 'dhL9OJBSksE',
      // 歌詞（2026-10-28 ユーザー指定・原文のまま。[Verse 1 - Mashiro] 等の見出し〔歌唱パート〕は除去、「、」→全角空白。語句は原文のまま、長いサビを連に分けるなど改行を整えた〔ユーザー指示〕）
      lyrics: `止まることでしか
見えないものがある
動き続けたあとで
私を見つけて

どこへ行くかなんて
まだ分からなくても
呼ばれる声があるなら
もう一度　前を向ける

振り返るたび
二人の声を探す
離れて見える夜も
同じ場所へ帰ってこられる

進んでもいい
止まってもいい
振り返ってもいい
呼ぶ声が聞こえるなら

同じ速さでなくていい
同じ方向を見なくてもいい
声が届く場所にいればいい

止まった時間にも
消えないものがある
誰かの声を待ちながら
ここにいてもいい

先が見えなくても
歩ける日ばかりじゃなくても
呼びたい名前があるなら
もう一度　声を出せる

振り返った先に
二人の姿がなくても
同じ場所を覚えていれば
また帰ってこられる

離れてもいい
迷ってもいい
立ち止まってもいい
呼ぶ声が聞こえるなら

同じ景色じゃなくていい
同じ答えを選ばなくていい
声が届く場所を
忘れなければいい

進んでもいい
止まってもいい
振り返ってもいい
何度でも呼べばいい

離れてもいい
迷ってもいい
違う明日を選んでもいい

同じ速さじゃなくていい
同じ道じゃなくていい
それでも声が聞こえるなら
きっとまた　帰ってこられる

声が届く場所に
私たちはいる` },

    // MoonVeil（SWEETs 限定。一般公開しない）
    'natsu-no-tsuki': { title: '夏の月', artists: ['moonveil'] }
  };

  // ── 作品 ───────────────────────────────────────────────────
  // 項目：id, title, sub（副題）, type('single'|'ep'|'album'), artists[], status, releaseDate, createdDate,
  //       order（同じ日の並び）, jacket, spotify, amazon, tracks[], stories[], kotoriNote, credits[], mv, related[],
  //       hiRes（ハイレゾ配信に対応している作品だけ true。リリース日などから自動判定はしない）
  var RELEASES = [
    { id: 'round-bounce', title: 'Round Bounce', type: 'single', artists: ['snowflakes'], status: 'public',
      releaseDate: '2026-03-19', jacket: 'Discography/Round Bounce.webp',
      spotify: 'https://open.spotify.com/intl-ja/track/6bhi3AvpNpYUFsQhVB9iHf',
      amazon: 'https://music.amazon.co.jp/albums/B0GT7CKP47?marketplaceId=A1VC38T7YXB528&musicTerritory=JP&trackAsin=B0GT793GCM',
      tracks: ['round-bounce'] },
    { id: 'sweets', title: 'SWEETs', type: 'single', artists: ['snowflakes'], status: 'public',
      releaseDate: '2026-03-25', jacket: 'Discography/SWEETs.webp',
      spotify: 'https://open.spotify.com/intl-ja/track/4fj4pzm4EsrNS1gjvD0VjU',
      amazon: 'https://music.amazon.co.jp/albums/B0GTWS1MWZ?marketplaceId=A1VC38T7YXB528&musicTerritory=JP&trackAsin=B0GTWQLWH3',
      tracks: ['sweets'] },
    { id: 'oita-oto', title: '置いた音', type: 'single', artists: ['snowflakes'], status: 'public',
      releaseDate: '2026-04-01', jacket: 'Discography/置いた音.webp',
      spotify: 'https://open.spotify.com/intl-ja/track/0GwRrnME0Tn5qsEbc2w2eG',
      amazon: 'https://music.amazon.co.jp/albums/B0GVPRQL4F?marketplaceId=A1VC38T7YXB528&musicTerritory=JP',
      tracks: ['oita-oto'] },
    { id: 'early-snow', title: 'Early Snow', type: 'ep', artists: ['snowflakes'], status: 'public',
      releaseDate: '2026-04-24', jacket: 'Discography/early_snow.webp',
      spotify: 'https://open.spotify.com/intl-ja/album/4aOj61cIiQ9qc7uWebq2Kx',
      amazon: 'https://music.amazon.co.jp/albums/B0GYG1KV9H?marketplaceId=A1VC38T7YXB528&musicTerritory=JP',
      tracks: ['yakusoku-wa-shinai', 'toumei-no-mama', 'little-snow-near', 'still', 'namae-no-nai-uta', 'little-snow-raw'] },
    { id: 'rabbit', title: 'Rabbit', sub: 'ハッピーエンドはいらない', type: 'single', artists: ['snowflakes'], status: 'public',
      releaseDate: '2026-05-28', jacket: 'Discography/Rabbit.webp',
      spotify: 'https://open.spotify.com/intl-ja/album/44dOQWscvSwLartZT8UBsJ',
      amazon: 'https://music.amazon.co.jp/albums/B0H38962NT?marketplaceId=A1VC38T7YXB528&musicTerritory=JP',
      tracks: ['rabbit', 'happy-end'],
      stories: [{ type: 'related', work: MAIN, ep: 155, epTitle: '重くて、丸い音', url: NOVEL + '155' }, { type: 'related', work: MAIN, ep: 76, epTitle: 'これはもう、デート', url: NOVEL + '76' }] },
    { id: 'signal', title: 'Signal', sub: 'グラスの縁', type: 'single', artists: ['snowflakes'], status: 'public',
      releaseDate: '2026-06-04', jacket: 'Discography/Signal.webp',
      spotify: 'https://open.spotify.com/intl-ja/album/4fpqDOsUjdcS1lpHbacdKr',
      amazon: 'https://music.amazon.co.jp/albums/B0H42LTTCM?marketplaceId=A1VC38T7YXB528&musicTerritory=JP',
      tracks: ['signal', 'glass-no-fuchi'],
      stories: [{ type: 'related', work: MAIN, ep: 178, epTitle: '音のないステージ', url: NOVEL + '178' }, { type: 'related', work: MAIN, ep: 133, epTitle: 'カクテルのあとで', url: NOVEL + '133' }] },
    { id: 'little-snow', title: 'Little Snow', sub: '音が消えるまでは', type: 'single', artists: ['snowflakes'], status: 'public',
      releaseDate: '2026-06-16', jacket: 'Discography/Little Snow.webp',
      spotify: 'https://open.spotify.com/intl-ja/album/5I4Ge2faqF3Yfk0YhnSxO7',
      amazon: 'https://music.amazon.co.jp/albums/B0H5L1R8L8?marketplaceId=A1VC38T7YXB528&musicTerritory=JP',
      tracks: ['little-snow', 'oto-ga-kieru-made'],      stories: [{ type: 'related', work: MAIN, ep: 200, epTitle: '届く声', url: NOVEL + '200' }] },
    { id: 'shunkan-ni-nokoru', title: '瞬間に残る', type: 'album', artists: ['snowflakes'], status: 'public',
      releaseDate: '2026-07-01', jacket: 'Discography/瞬間に残る.webp',
      spotify: 'https://open.spotify.com/intl-ja/album/1owH28KblGMMsC9AtQ5seZ',
      amazon: 'https://music.amazon.co.jp/albums/B0H77RVBD2?marketplaceId=A1VC38T7YXB528&musicTerritory=JP',
      tracks: ['signal', 'round-bounce', 'rabbit-full-moon', 'oita-oto', 'sweets-brass', 'shukusou', 'kokyu-no-kyori',
               'shunkan-ni-nokoru', 'hana-no-namae', 'low-light', 'oto-ga-kieru-made', 'little-snow'] },
    // Undertone は EP（3曲）で確定（2026-10-24 ユーザー確認）
    { id: 'undertone', title: 'Undertone', type: 'ep', artists: ['snowflakes'], status: 'public',
      releaseDate: '2026-07-30', jacket: 'Discography/undertone.webp',
      spotify: 'https://open.spotify.com/intl-ja/album/3cY9qIWkcj3S5veSYjx351',
      amazon: 'https://music.amazon.co.jp/albums/B0HBFLP371?marketplaceId=A1VC38T7YXB528&musicTerritory=JP',
      tracks: ['undertone', 'spring-waltz', 'aftertone'] },
    { id: 'in-one-sky', title: 'In One Sky', sub: '帰らないほどでもない', type: 'single', artists: ['snowflakes'], status: 'public',
      releaseDate: '2026-08-30', jacket: 'Discography/in_one_sky.webp',
      spotify: 'https://open.spotify.com/intl-ja/album/4ZB3NH6YOUIPmRcy0h8yX7',
      amazon: 'https://music.amazon.co.jp/albums/B0HBFMD4Y3?marketplaceId=A1VC38T7YXB528&musicTerritory=JP',
      tracks: ['in-one-sky', 'kaeranai-hodo'] },
    // リリース日 2026-10-17（ユーザー確定 2026-10-24。配信管理データには未登録）
    { id: 'prism', title: 'プリズム', sub: 'ここにいる', type: 'single', artists: ['snowflakes'], status: 'public', hiRes: true,
      releaseDate: '2026-10-17', jacket: 'Discography/prism.webp',
      spotify: 'https://open.spotify.com/intl-ja/album/3MHaDHM9tm1IiDtvWwMYzt',
      amazon: 'https://music.amazon.co.jp/albums/B0HN9KYH3G',
      tracks: ['prism', 'koko-ni-iru'] },
    // リリース日 2026-10-27（2026-10-28 登録）。ジャケットは仮（Amazon の 500px 画像。後でユーザーが差し替え）。Spotify は配信後に追加
    { id: 'mada-natteru', title: 'まだ鳴ってる', sub: '苦いプリン', type: 'single', artists: ['snowflakes'], status: 'public', hiRes: true,
      releaseDate: '2026-10-27', jacket: 'Discography/mada_natteru.webp',
      amazon: 'https://music.amazon.co.jp/albums/B0HPGMNF4M',
      tracks: ['mada-natteru', 'nigai-purin'] },

    // TOWA（リリース日 2026-10-20：ユーザー指定 2026-10-24）
    { id: 'todoku-basho', title: '届く場所', type: 'single', artists: ['towa'], status: 'public', hiRes: true,
      releaseDate: '2026-10-20', jacket: 'Discography/towa_todoku_basho.webp',
      spotify: 'https://open.spotify.com/intl-ja/album/6aFKChIMh0Kd75fnI1oGSe',
      amazon: 'https://music.amazon.co.jp/albums/B0HNSC7FCV',
      tracks: ['todoku-basho'] },

    // MoonVeil：SWEETs 限定（ギターピック2枚）。一覧・詳細には出さない
    { id: 'natsu-no-tsuki', title: '夏の月', type: 'single', artists: ['moonveil'], status: 'limited',
      releaseDate: null, tracks: ['natsu-no-tsuki'] }
  ];

  // クレジットの既定値（2026-10-28 ユーザー指示：全曲に英語で小さく）。
  // 曲ごとに credits を書けばそちらが優先（インスト曲を 'Music' だけにする場合など）
  var DEFAULT_CREDITS = [{ role: 'Lyrics & Music', name: 'Kotori Yamabuki' }];
  Object.keys(SONGS).forEach(function (k) {
    if (!SONGS[k].credits) SONGS[k].credits = DEFAULT_CREDITS;
  });

  global.SF_DISCO = { songs: SONGS, releases: RELEASES };
})(window);
