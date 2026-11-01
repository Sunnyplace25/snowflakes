/* ============================================================
   site/i18n-auto.js — トップの言語切り替え（EN / KO / ZH）を、ページ全体に効かせる（2026-10-30）
   ・data-i18n の目印がない文（新しいトップの各欄・後から描画される作品カードやお知らせ・バナーの状態表示など）を
     下の辞書で置き換える。後から描画・書き換えされた文も、表示された時点で置き換える
   ・日本語に戻すと元の文に戻る。data-i18n の付いた要素は、従来の辞書（index.html の T）に任せる
   ・曲名・アーティスト名などの固有名はそのまま。辞書にない文は日本語のまま
   使い方：window.SfAutoI18n.apply('en' | 'ko' | 'zh' | 'ja')（index.html の applyLang から呼ぶ）
   2026-11-01：トップの切り替えは 日本語⇔英語 だけ（ko / zh は辞書に残してあるが、ボタンでは選べない）。
     英語だけの訳は [en] の1つだけ書く（ko / zh を選んだときは日本語のまま）
   ============================================================ */
(function () {
  'use strict';
  var NAME = { en: 'Kotori Yamabuki', ko: '야마부키 코토리', zh: '山吹ことり' };
  // ja: [en, ko, zh]
  var D = {
    // ナビ
    'ガチャ': ['Gacha', '가챠', '扭蛋'],
    'アプリ': ['App', '앱', '应用'],
    // プロジェクト紹介
    'Snow flakes Story & Music Projectは、': ['Snow flakes Story & Music Project is', 'Snow flakes Story & Music Project는', 'Snow flakes Story & Music Project 是'],
    '山吹ことりが手がけるクロスメディア創作プロジェクトです。': ['a cross-media creative project by Kotori Yamabuki.', '야마부키 코토리가 만드는 크로스미디어 창작 프로젝트입니다.', '由山吹ことり打造的跨媒体创作项目。'],
    '小説で描かれる人物たちの物語。': ['Stories of the characters portrayed in novels.', '소설 속 인물들의 이야기.', '小说中描绘的人物故事。'],
    'その世界から生まれる音楽。': ['Music born from that world.', '그 세계에서 태어나는 음악.', '诞生于那个世界的音乐。'],
    '情景を映し出す映像や、物語の中へ入り込むゲーム。': ['Videos that capture its scenes, and games that take you inside the story.', '정경을 비추는 영상과, 이야기 속으로 들어가는 게임.', '映照情景的影像，以及走进故事的游戏。'],
    'それぞれが独立した作品でありながら、': ['Each is a work in its own right,', '각각이 독립된 작품이면서도,', '每一部都是独立的作品，'],
    'ときに互いにつながり、新しい楽しみ方を生み出していきます。': ['yet at times they connect and create new ways to enjoy them.', '때로는 서로 이어져 새로운 즐거움을 만들어 갑니다.', '有时又彼此相连，创造出新的乐趣。'],
    '物語から音楽に出会うことも。': ['You might discover music through a story,', '이야기에서 음악을 만나기도 하고,', '你可能会从故事中遇见音乐，'],
    '一曲の歌から、まだ知らない物語を見つけることも。': ['or find a story you never knew through a single song.', '한 곡의 노래에서 아직 모르는 이야기를 발견하기도 합니다.', '也可能从一首歌中发现尚未知晓的故事。'],
    '読む、聴く、観る、遊ぶ。': ['Read, listen, watch, play.', '읽고, 듣고, 보고, 즐기다.', '阅读、聆听、观看、游玩。'],
    'どこからでも、': ['Wherever you begin,', '어디서부터든,', '无论从哪里开始，'],
    'この世界に触れていただけたら嬉しく思います。': ['we would be happy if you stepped into this world.', '이 세계를 만나 주신다면 기쁘겠습니다.', '若能接触到这个世界，我们将倍感欣喜。'],
    // 楽しみ方を選ぶ
    '楽しみ方を選ぶ': ['Choose how to enjoy', '즐기는 방법 고르기', '选择享受方式'],
    'どこからでも楽しめます。気になる入口を選んでください。': ['Start anywhere. Pick the entrance that interests you.', '어디서든 즐길 수 있습니다. 마음에 드는 입구를 골라 주세요.', '从哪里都能享受。请选择你感兴趣的入口。'],
    '小説から楽しむ': ['Enjoy through novels', '소설로 즐기기', '从小说开始'],
    'バンドの青春から異世界ファンタジーまで。連載中の物語を、作品ごとに紹介しています。': ['From band coming-of-age stories to isekai fantasy — our ongoing serials, introduced work by work.', '밴드의 청춘부터 이세계 판타지까지. 연재 중인 이야기를 작품별로 소개합니다.', '从乐队青春到异世界奇幻。按作品介绍正在连载的故事。'],
    '小説へ →': ['Novels →', '소설 →', '小说 →'],
    '音楽から楽しむ': ['Enjoy through music', '음악으로 즐기기', '从音乐开始'],
    '物語の中で鳴っている音楽を、実際の楽曲として配信しています。Snow flakes、雨音クラブなど、アーティストごとに聴けます。': ['The music heard in the stories is released as real songs. Listen by artist — Snow flakes, Amaoto Club and more.', '이야기 속에서 울리는 음악을 실제 곡으로 발매하고 있습니다. Snow flakes, 아마오토 클럽 등 아티스트별로 들을 수 있습니다.', '故事中响起的音乐，作为真实的歌曲发行。可按艺人收听 Snow flakes、雨音俱乐部等。'],
    '音楽へ →': ['Music →', '음악 →', '音乐 →'],
    'ゲームで遊ぶ': ['Play games', '게임으로 즐기기', '玩游戏'],
    'キャラクター育成ゲーム「ハヤテっち」や、ノベルゲーム「Under tone」など、物語の世界で遊べるコンテンツです。': ['Play inside the story world — the character-raising game "Hayatecchi", the novel game "Under tone" and more.', '캐릭터 육성 게임 「하야텟치」, 노벨 게임 「Under tone」 등 이야기의 세계에서 즐길 수 있는 콘텐츠입니다.', '角色养成游戏「Hayatecchi」、视觉小说游戏「Under tone」等，可在故事世界中游玩的内容。'],
    'ゲームへ →': ['Games →', '게임 →', '游戏 →'],
    // 代表作品
    '代表作品': ['Featured Works', '대표 작품', '代表作品'],
    'すべての作品を見る →': ['See all works →', '모든 작품 보기 →', '查看全部作品 →'],
    '連載小説・シリーズ': ['Serial novel / series', '연재 소설・시리즈', '连载小说・系列'],
    '連載小説': ['Serial novel', '연재 소설', '连载小说'],
    '約束なんてしていない。それでも、三人の音は続いていく。': ['No promises were ever made. Still, the sound of the three goes on.', '약속 같은 건 하지 않았다. 그래도 세 사람의 소리는 이어진다.', '从未许下约定。即便如此，三人的声音仍在继续。'],
    '作品ページへ →': ['Go to the work page →', '작품 페이지로 →', '前往作品页面 →'],
    '神様はバンド名がダサいと言った': ['The God Said Our Band Name Is Lame', '신은 밴드 이름이 촌스럽다고 했다', '神明说我们的乐队名很土'],
    '解散寸前のバンドに、音を聞く神様がついてきた。': ['A band on the verge of breaking up gets followed by a god who listens to sound.', '해체 직전의 밴드에게 소리를 듣는 신이 따라왔다.', '濒临解散的乐队，被一位聆听声音的神明跟上了。'],
    '音を覚えるだけの外れスキルで追放された俺、失われた古代魔法を全部再生できるらしい': ['Exiled for a Useless Skill That Only Memorizes Sounds, I Can Apparently Replay Every Lost Ancient Magic', '소리를 기억하기만 하는 꽝 스킬로 추방된 나, 잃어버린 고대 마법을 전부 재생할 수 있는 모양이다', '因只能记住声音的废柴技能被放逐的我，似乎能重现所有失传的古代魔法'],
    '山吹ことりが描く、「音」が運命を変える異世界ファンタジー。': ['An isekai fantasy by Kotori Yamabuki, where "sound" changes fate.', '야마부키 코토리가 그리는, 「소리」가 운명을 바꾸는 이세계 판타지.', '山吹ことり笔下，「声音」改变命运的异世界奇幻。'],
    // 最新情報（バナー）
    '? アイテムについて': ['? About items', '? 아이템에 대해', '? 关于道具'],
    '神様はバンド名が': ['The God Said', '신은 밴드 이름이', '神明说'],
    'ダサいと言った': ['Our Band Name Is Lame', '촌스럽다고 했다', '我们的乐队名很土'],
    '第一章 全25話': ['Chapter 1 — 25 episodes', '제1장 전 25화', '第一章 全25话'],
    '更新しました ✦': ['Updated ✦', '업데이트했습니다 ✦', '已更新 ✦'],
    '本編 更新済み': ['Main story updated', '본편 업데이트 완료', '正篇 已更新'],
    '本編 明日21時更新': ['Main story: next update tomorrow at 9 PM', '본편 내일 21시 업데이트', '正篇 明天21点更新'],
    '本編 毎日21時更新': ['Main story: updated daily at 9 PM', '본편 매일 21시 업데이트', '正篇 每天21点更新'],
    '最新話を読む': ['Read the latest episode', '최신화 읽기', '阅读最新话'],
    // スペシャルコンテンツ
    'スペシャルコンテンツ': ['Special Contents', '스페셜 콘텐츠', '特别内容'],
    'Snow flakesの世界をもっと深く楽しめる、コアコンテンツエリア。\nアイテムを集めて、限定エピソードを解放しよう！\n本編では描かれなかった、彼らの意外な一面をのぞけるかも？\nLIVEアーカイブやノベルゲームなど、さまざまなコンテンツも楽しめます。（まもなくアップデート予定！）': [
      'A core content area to enjoy the world of Snow flakes more deeply.\nCollect items and unlock limited episodes!\nYou might catch unexpected sides of them never shown in the main story.\nEnjoy LIVE archives, novel games and much more. (Update coming soon!)',
      'Snow flakes의 세계를 더 깊이 즐길 수 있는 코어 콘텐츠 에리어.\n아이템을 모아서 한정 에피소드를 해금하자!\n본편에서는 그려지지 않은 그들의 의외의 일면을 엿볼 수 있을지도?\nLIVE 아카이브와 노벨 게임 등 다양한 콘텐츠도 즐길 수 있습니다. (곧 업데이트 예정!)',
      '更深入享受 Snow flakes 世界的核心内容区。\n收集道具，解锁限定剧情吧！\n或许能窥见正篇中未曾描绘的、他们意外的一面？\n还可以享受 LIVE 存档和视觉小说游戏等各种内容。（即将更新！）'],
    '見る →': ['View →', '보기 →', '查看 →'],
    // 制作者・応援・リンク・フッター
    '制作者紹介': ['About the Creator', '제작자 소개', '创作者介绍'],
    '山吹ことり': [NAME.en, NAME.ko, NAME.zh],
    '応援する': ['Support', '응원하기', '支持我们'],
    '応援プラン・アプリ・ゲーム': ['Support plans, apps & games', '응원 플랜・앱・게임', '支持方案・应用・游戏'],
    '応援プランや、アプリ・ゲームの購入で活動を応援できます。': ['You can support our work through support plans or by purchasing apps and games.', '응원 플랜이나 앱・게임 구매로 활동을 응원할 수 있습니다.', '可以通过支持方案或购买应用、游戏来支持我们的活动。'],
    '小説家になろう': ['Shōsetsuka ni Narō', '소설가가 되자', '成为小说家吧'],
    'X（旧Twitter）': ['X (formerly Twitter)', 'X (구 트위터)', 'X（原Twitter）'],
    'ハヤテっち': ['Hayatecchi', '하야텟치', 'Hayatecchi'],
    '© 2026- 山吹ことり / Snow flakes Story & Music Project': ['© 2026- ' + NAME.en + ' / Snow flakes Story & Music Project', '© 2026- ' + NAME.ko + ' / Snow flakes Story & Music Project', '© 2026- ' + NAME.zh + ' / Snow flakes Story & Music Project'],
    // キャラクターの吹き出し
    '最初に、それだけ聞かせて': ['First, just tell me this.', '먼저, 그것만 알려 줘.', '先告诉我这个就好。'],
    'あとで呼ぶかもしれないから': ['I might call you by it later.', '나중에 부를지도 모르니까', '因为之后可能会叫你'],
    'SWEETs ROOM、覗いてった？': ['Did you peek into the SWEETs ROOM?', 'SWEETs ROOM, 들여다봤어?', 'SWEETs ROOM，去看过了吗？'],
    'SWEETsCode、もうゲットした？': ['Got the SWEETsCode yet?', 'SWEETsCode, 벌써 얻었어?', 'SWEETsCode，已经拿到了吗？'],
    'SWEETsCode、気づいた？': ['Did you notice the SWEETsCode?', 'SWEETsCode, 눈치챘어?', '注意到 SWEETsCode 了吗？'],
    '……名前、残していく？': ['…Want to leave your name?', '……이름, 남기고 갈래?', '……要留下名字吗？'],
    '……来てくれたんだ': ['…You came.', '……와 줬구나', '……你来了啊'],
    'お、また来てる': ['Oh, you\'re here again.', '오, 또 왔네', '哦，又来了'],
    'お、来た来た！': ['Oh, there you are!', '오, 왔다 왔다!', '哦，来了来了！'],
    'ここでは、なんて呼ばれてる？': ['What do people call you here?', '여기서는 뭐라고 불려?', '在这里，大家怎么称呼你？'],
    'ことりの部屋では月1回': ['In Kotori\'s room, once a month', '코토리의 방에서는 한 달에 한 번', '在ことり的房间，每月一次'],
    'プロテインコーヒー': ['Protein Coffee', '프로틴 커피', '蛋白咖啡'],
    'がもらえるぞ！': ['is yours for the taking!', '를 받을 수 있어!', '可以领取哦！'],
    'ちゃんと見つけてくれたんだ': ['You actually found it.', '제대로 찾아 줬구나', '你真的找到了啊'],
    'ちゃんと見てくれてるんだ': ['You\'re really paying attention.', '제대로 봐 주고 있구나', '你真的有在看呢'],
    'また来てくれてありがとな！': ['Thanks for coming back!', '또 와 줘서 고마워!', '谢谢你又来了！'],
    'また来ると思ってた': ['I knew you\'d be back.', '또 올 줄 알았어', '我就知道你会再来'],
    'また遊びに来てくれたんだな': ['You came to hang out again.', '또 놀러 와 줬구나', '你又来玩了呢'],
    'ゆっくりしてけば？': ['Why not stay a while?', '천천히 있다 가지 그래?', '要不要多待一会儿？'],
    'よかったら、名前': ['If you like, your name…', '괜찮으면, 이름', '方便的话，名字'],
    'コード、意外と気づいてもらえて嬉しい': ['Glad people actually notice the code.', '코드, 의외로 알아봐 줘서 기뻐', '没想到大家会注意到代码，好开心'],
    'ヒント見つけるの早くない？': ['Weren\'t you quick to find the hint?', '힌트 찾는 거 빠르지 않아?', '找到提示也太快了吧？'],
    '今日は、少しだけ賑やかだね': ['It\'s a little lively today.', '오늘은 조금 북적이네', '今天稍微热闹一些呢'],
    '今日はどこから見る？': ['Where do you want to start today?', '오늘은 어디부터 볼래?', '今天从哪里开始看？'],
    '今日は何見る？': ['What are we looking at today?', '오늘은 뭐 볼래?', '今天看什么？'],
    '名前、聞いてもいい？': ['Can I ask your name?', '이름, 물어봐도 돼?', '可以问你的名字吗？'],
    '君の名前、知りたい': ['I\'d like to know your name.', '네 이름, 알고 싶어', '想知道你的名字'],
    '呼び方だけ、教えて': ['Just tell me what to call you.', '부르는 방법만 알려 줘', '只要告诉我怎么称呼你'],
    '少しでも楽しんでくれたらいい': ['I hope you enjoy it, even a little.', '조금이라도 즐겨 주면 좋겠어', '哪怕一点点，能让你开心就好'],
    '来てくれてありがと': ['Thanks for coming.', '와 줘서 고마워', '谢谢你来'],
    '楽しんでくれてたら嬉しい！': ['I\'d be happy if you\'re enjoying it!', '즐겨 주고 있다면 기뻐!', '如果你玩得开心，我就很高兴！'],
    '無理なら、そのままでもいいけど': ['It\'s fine if you\'d rather not.', '싫으면 그냥 둬도 괜찮지만', '不方便的话，就这样也没关系'],
    '甘いもの、増えてるかも': ['There might be more sweets now.', '단것, 늘어났을지도', '甜点可能变多了哦'],
    '結構ちゃんと見てくれてるじゃん': ['You\'re looking pretty closely, huh.', '꽤 제대로 봐 주고 있잖아', '你看得还挺仔细的嘛'],
    '見つけてくれてありがとう': ['Thanks for finding me.', '찾아 줘서 고마워', '谢谢你找到这里'],
    '静かな場所だけど、嬉しい': ['It\'s a quiet place, but I\'m glad you\'re here.', '조용한 곳이지만, 기뻐', '虽然是个安静的地方，但我很开心'],
    // 案内（ガイド）
    '次へ →': ['Next →', '다음 →', '下一步 →'],
    'なまえ': ['Name', '이름', '名字'],
    '物語に触れてみよう':['Step into the story', '이야기를 만나 보자', '来接触故事吧'],
    'デイリーアップデート': ['Daily update', '데일리 업데이트', '每日更新'],
    'Snow flakesの音楽を': ['Listen to the music', 'Snow flakes의 음악을', '来听听'],
    '聴いてみよう': ['of Snow flakes', '들어 보자', 'Snow flakes 的音乐吧'],
    'ガチャをひいて': ['Spin the gacha', '가챠를 돌려서', '抽扭蛋'],
    'アイテムを集めよう！': ['and collect items!', '아이템을 모으자!', '收集道具吧！'],
    '特別なコンテンツが': ['To the place where', '특별한 콘텐츠가', '前往汇集'],
    '集まる場所へ': ['special contents gather', '모이는 곳으로', '特别内容的地方'],
    // お知らせのポップアップ
    '6月7日 — 10日': ['June 7 — 10', '6월 7일 — 10일', '6月7日 — 10日'],
    'Spotify で聴く →': ['Listen on Spotify →', 'Spotify에서 듣기 →', '在 Spotify 收听 →'],
    '閉じる': ['Close', '닫기', '关闭'],
    '公開しました！': ['Now available!', '공개했습니다!', '已发布！'],
    '公開しました': ['Now available', '공개했습니다', '已发布'],
    'SWEETs へ →': ['To SWEETs →', 'SWEETs로 →', '前往 SWEETs →'],
    '読む →': ['Read →', '읽기 →', '阅读 →'],
    // 作品の広告パネル
    '山吹ことりが描く、': ['By Kotori Yamabuki —', '야마부키 코토리가 그리는,', '山吹ことり笔下，'],
    '「音」が運命を変える': ['where "sound" changes fate:', '「소리」가 운명을 바꾸는', '「声音」改变命运的'],
    '異世界ファンタジー。': ['an isekai fantasy.', '이세계 판타지.', '异世界奇幻。'],
    '小説家になろうで読む →': ['Read on Shōsetsuka ni Narō →', '소설가가 되자에서 읽기 →', '在「成为小说家吧」阅读 →'],
    '解散寸前のバンドに、': ['A band on the verge of breaking up', '해체 직전의 밴드에게', '濒临解散的乐队，'],
    '音を聞く神様が': ['gets followed by a god', '소리를 듣는 신이', '被一位聆听声音的神明'],
    'ついてきた。': ['who listens to sound.', '따라왔다.', '跟上了。'],
    'カクヨムで1話先行 →': ['One episode ahead on Kakuyomu →', '카쿠요무에서 1화 먼저 →', '在 Kakuyomu 抢先一话 →'],
    'なろうで読む →': ['Read on Narō →', '나로우에서 읽기 →', '在「成为小说家吧」阅读 →'],
    // ── ここから英語だけ（2026-11-01）──
    // お知らせのポップアップのボタン
    '小説を読む': ['Read the novel'],
    'Spotify で聴く': ['Listen on Spotify'],
    'Amazon Music で聴く': ['Listen on Amazon Music'],
    'YouTubeで見る': ['Watch on YouTube'],
    '活動報告をすべて見る →': ['See all activity reports →'],
    // はじめての案内
    'ようこそ、Snow flakesへ。': ['Welcome to Snow flakes.'],
    'このサイトでは、': ['On this site,'],
    '物語を読んだり、音楽を聴いたり、': ['reading stories, listening to music,'],
    'いろいろな部屋を訪れることで': ['and visiting all kinds of rooms'],
    '「Snow」が少しずつ積もっていきます。': ['lets "Snow" pile up little by little.'],
    '集めたSnowで、': ['With the Snow you collect,'],
    'ガチャや特別なページが開くことがあります。': ['you can spin the gacha and open special pages.'],
    '毎日少しずつ遊ぶのがおすすめ。': ['We recommend playing a little every day.'],
    'ホームに追加しておくと便利です。': ['Adding it to your home screen makes it easy to come back.'],
    'まずは、今日の物語からどうぞ。': ['To begin, start with today\'s story.'],
    'はじめる': ['Start'],
    'ホーム画面に追加 →': ['Add to Home Screen →'],
    // ガチャ・アイテム・ログインボーナス
    'コンテンツを回って積もる Snow ❄ で': ['Use the Snow ❄ that piles up as you explore'],
    'ガチャを引いてアイテムを集めよう。': ['to spin the gacha and collect items.'],
    'ガチャを引きに行く →': ['Go spin the gacha →'],
    'アイテムを入手しました': ['You got an item'],
    'アイテムはSWEETs 内でコンテンツを': ['Items are the keys that unlock'],
    '使用する鍵となります': ['content inside SWEETs'],
    '── 受け取る ──': ['── Receive ──'],
    'バックステージパス': ['Backstage Pass'],
    '入手しました': ['obtained'],
    '連続ログイン': ['Login streak'],
    'Snow 獲得': ['Snow earned'],
    '── 閉じる ──': ['── Close ──'],
    // QF・DAILY UPDATE の説明
    'QF のエピソードを Instagram で読むと、ランダムでアイテムがひとつ手に入ります。': ['Read a QF episode on Instagram and you\'ll get one random item.'],
    'どれが届くかは、読んでからのお楽しみ。': ['Which one you get is a surprise until you\'ve read it.'],
    'ゆっくり読んで戻ってくると、アイテムが届きます。': ['Take your time reading — the item arrives when you come back.'],
    '集めたアイテムは、': ['The items you collect become'],
    'SWEETs 内で特別な扉を開く鍵': ['keys that open special doors inside SWEETs'],
    'になります。': ['.'],
    '入場には': ['Entry requires'],
    'が必要です。': ['.'],
    '本日の更新から物語を読むと、ランダムでアイテムがひとつ手に入ります。': ['Read a story from today\'s update and you\'ll get one random item.'],
    'DAILY UPDATE へ →': ['To DAILY UPDATE →']
  };
  // 形が決まっている文（数字や曲名が入るもの）
  var RULES = [
    [/^本編 (\d+)時更新$/, ['Main story: next update at $1:00', '본편 $1시 업데이트', '正篇 $1点更新']],
    [/^#(\d+) まもなく$/, ['#$1 coming soon', '#$1 곧 공개', '#$1 即将更新']],
    [/^(.+)「(.+)」リリース$/, ['$1 “$2” released', '$1 「$2」 발매', '$1《$2》发行']],
    [/^ありがとう、(.+)さん$/, ['Thank you, $1', '고마워, $1 씨', '谢谢你，$1']]
  ];
  var IDX = { en: 0, ko: 1, zh: 2 };
  var SKIP = 'script,style,noscript,textarea,[data-i18n],#lang-toggle,.sf-legacy';
  var orig = new WeakMap();   // 文の元（日本語）
  var lang = 'ja';
  var busy = false;

  function translate(s) {
    var i = IDX[lang];
    var t = s.trim();
    if (!t) return null;
    var hit = D[t];
    var out = hit ? hit[i] : null;
    if (out == null) for (var r = 0; r < RULES.length; r++) { if (RULES[r][0].test(t)) { out = t.replace(RULES[r][0], RULES[r][1][i]); break; } }
    if (out == null) return null;
    var lead = s.match(/^\s*/)[0], tail = s.match(/\s*$/)[0];
    return lead + out + tail;
  }

  function each(root, fn) {
    if (root.nodeType === 3) { fn(root); return; }
    if (root.nodeType !== 1 || (root.closest && root.closest(SKIP))) return;
    var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) { return n.parentElement && !n.parentElement.closest(SKIP) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT; }
    });
    var n, list = [];
    while ((n = w.nextNode())) list.push(n);
    list.forEach(fn);
  }

  function fix(node) {
    if (node.parentElement && node.parentElement.closest(SKIP)) return;
    var src = orig.has(node) ? orig.get(node) : node.nodeValue;
    if (lang === 'ja') { if (orig.has(node) && node.nodeValue !== src) node.nodeValue = src; return; }
    var t = translate(src);
    if (t == null) return;
    if (!orig.has(node)) orig.set(node, src);
    if (node.nodeValue !== t) node.nodeValue = t;
  }

  // 入力欄の案内の文字（placeholder）
  var origPh = new WeakMap();
  function fixPlaceholders() {
    document.querySelectorAll('input[placeholder], textarea[placeholder]').forEach(function (el) {
      if (el.closest(SKIP.replace('textarea,', ''))) return;
      if (!origPh.has(el)) origPh.set(el, el.getAttribute('placeholder'));
      var src = origPh.get(el);
      var t = lang === 'ja' ? src : translate(src);
      if (t != null && el.getAttribute('placeholder') !== t) el.setAttribute('placeholder', t);
    });
  }

  function apply(next) {
    lang = next === 'en' || next === 'ko' || next === 'zh' ? next : 'ja';
    busy = true;
    each(document.body, fix);
    fixPlaceholders();
    busy = false;
  }

  // 後から描画・書き換えされた文も置き換える
  var obs = new MutationObserver(function (muts) {
    if (busy) return;
    busy = true;
    muts.forEach(function (m) {
      if (m.type === 'characterData') {
        var node = m.target;
        if (orig.has(node)) {   // スクリプトが文を書き換えた：新しい文を元として覚え直す
          var cur = node.nodeValue;
          var known = translate(orig.get(node));
          if (cur !== known) orig.set(node, cur);
        }
        if (lang !== 'ja') fix(node);
      } else m.addedNodes.forEach(function (n) { if (lang !== 'ja') each(n, fix); });
    });
    if (lang !== 'ja') fixPlaceholders();
    busy = false;
  });

  function start() {
    obs.observe(document.body, { childList: true, subtree: true, characterData: true });
    var saved = 'ja';
    try { saved = localStorage.getItem('sf-lang') || 'ja'; } catch (e) { /* 保存できない環境 */ }
    if (saved !== 'ja') apply(saved);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();

  window.SfAutoI18n = { apply: apply };
})();
