/* Snow flakes 本編の「章・編」ページのデータ（stories/snowflakes/arc/<id>/ と本編タブの章一覧で共用）
   話番号は「小説家になろう」n9009lo の通し番号。各話タイトルは episodes.js（目次から作る）
   lead（あらすじ）・shorts（関連短編）・songs（関連曲）・gallery（ギャラリー）は空なら「準備中」と出る
   color：本編タブの章カードの色（kouta 赤 / hayate 黄 / saku 紫 / mikoto 白っぽい水色。なしは青）
   shorts: { title, note, url, chara }（chara：hinata / kouta / hayate / saku で枠の色）  songs: { title, url, note } か { title, url, jacket }（ジャケット付きカード）  gallery: { img, alt }（img はこのフォルダからのパス） */
window.SF_ARC_SITE = { ncode: 'n9009lo', series: 'Snow flakes' };
window.SF_ARC_GROUPS = [
  { id: 'ch1', label: '第一章', sub: 'Snow flakes', en: 'CHAPTER 1', numbered: true },   // 第一章の大きなくくり（第二章の After the Snow と対・2026-11-07 ユーザー）
  { id: 'qf', label: 'Quietly Falling', en: 'QF' },
  { id: 'mid', label: '第二章の前に', en: 'INTERLUDE', numbered: true },   // プロデュース編＝10・Before the Sound＝0（〇章扱い。番号だけ付ける：2026-11-07 ユーザー）
  { id: 'ch2', label: '第二章', sub: 'After the Snow', en: 'CHAPTER 2' }   // 第二章の大きなくくりが After the Snow（2026-11-07 ユーザー）。中の編のタイトルは大学編に入ってから決める
];

window.SF_ARCS = [
  { id: 'highschool', group: 'ch1', no: 1, title: '高校・大学編', en: 'High School / University',
    parts: [{ name: '高校編', from: 1, to: 21 }, { name: '大学編', from: 22, to: 35 }],
    kindle: 0, lead: "高校で出会ったヒナタ、コウタ、ハヤテ。三人の音が重なったとき、Snow flakesというバンドが生まれた。\n\n進学し、生活も将来への考え方も少しずつ変わっていく。それでも三人は、同じ場所で音を鳴らし続ける。\n\nすべての始まりと、帰る場所ができるまでの物語。",
    shorts: [{ title: '置いた音', note: 'QF ep.08｜大学編 ep.27.5', url: 'https://www.instagram.com/reel/DWoEzizDheI/' }],
    songs: [], gallery: [] },
  { id: 'little-snow', group: 'ch1', no: 2, title: 'リトルスノー編', en: 'Little Snow',
    parts: [{ name: 'リトルスノー編', from: 36, to: 69 }],
    kindle: 1, lead: "言葉にできなかった想いが、一曲の音楽になる。\n\nヒナタが作った「Little Snow」。その音を受け取った小雪は、ヒナタの想いをひとつずつほどいていく。\n\n誰かに届けるための音が、やがてSnow flakesの新しい一歩へとつながっていく。",
    shorts: [{ title: '整えない音', chara: 'hinata', note: '短篇', url: 'https://ncode.syosetu.com/n0082lu/' },
      { title: '半分のまま', chara: 'hinata', note: '短篇', url: 'https://ncode.syosetu.com/n0327lw/' },
      { title: '白い音', chara: 'hinata', note: '短篇', url: 'https://ncode.syosetu.com/n0679lx/' }],   // 大学時代の話だが、終盤のライブの Little Snow につながるのでこちら（2026-11-07 ユーザー）
    songs: [{ title: 'Little Snow（Raw）', jacket: 'Discography/early_snow.webp', url: '../../../../releases/song.html?id=little-snow-raw' },
      { title: 'Little Snow（Near）', jacket: 'Discography/early_snow.webp', url: '../../../../releases/song.html?id=little-snow-near' },
      { title: '呼吸の距離', jacket: 'Discography/瞬間に残る.webp', url: '../../../../releases/song.html?id=kokyu-no-kyori' }],
    gallery: [] },
  { id: 'showcase', group: 'ch1', no: 3, color: 'kouta', title: 'ショーケース編', en: 'Showcase',
    parts: [{ name: 'ショーケース編', from: 70, to: 81 }],
    kindle: 2, lead: "ライブハウスで積み重ねてきた時間が、少しずつ外の世界へ届き始める。\n\n新しい出会い、向けられる期待、音楽を仕事にする人々の視線。\n\n三人が鳴らしてきた音は、まだ知らない場所へと広がろうとしていた。",
    shorts: [
      { title: 'SWEETs', note: 'QF ep.05｜ショーケース編 ep.79 前段', url: 'https://www.instagram.com/p/DVNsuIeF2D-/' }
    ],
    songs: [{ title: 'SWEETs', jacket: 'Discography/SWEETs.webp', url: '../../../../releases/song.html?id=sweets' },
      { title: 'ハッピーエンドはいらない', jacket: 'Discography/Rabbit.webp', url: '../../../../releases/song.html?id=happy-end' }],
    gallery: [] },
  // 夏の月も編として別ページ（2026-11-07 ユーザー）。Kindle はショーケース編と同じ3巻
  { id: 'summer-moon', group: 'ch1', no: 4, color: 'saku', title: '夏の月', en: 'Summer Moon',
    parts: [{ name: '夏の月', from: 82, to: 90 }],
    kindle: 2, lead: "夏の空気の中で、止まっていた時間が再び動き出す。\n\n懐かしい声、思いがけない再会、近づいたはずなのに届かない距離。\n\n音楽と日常が交差する季節。それぞれが胸の奥にしまっていた想いが、静かに輪郭を持ち始める。",
    shorts: [{ title: '透明なリズム', chara: 'hayate', note: '短篇', url: 'https://ncode.syosetu.com/n5484lz/' },
      { title: 'Moon Veil', chara: 'saku', note: '短篇', url: 'https://ncode.syosetu.com/n9832lr/' },
      { title: 'ショーケースの前で恋をした', note: '短篇連作', url: '../../../showcase/', internal: true }],   // 子どものハヤテと朔の話（2026-11-07 ユーザー）
    songs: [{ title: '透明のまま', jacket: 'Discography/early_snow.webp', url: '../../../../releases/song.html?id=toumei-no-mama' },
      { title: '花の名前を忘れても', jacket: 'Discography/瞬間に残る.webp', url: '../../../../releases/song.html?id=hana-no-namae' },
      { title: 'Moon Veil', jacket: 'artists/moonveil/img/main.webp', url: 'https://www.instagram.com/reel/DZuqfqwxpNs/' },
      { title: '夏の月（demo）', jacket: 'artists/moonveil/img/member_yoiko.webp', url: '../../../../sweets/' }],   // SWEETs 限定（ギターピック2枚で交換）。音源へ直接リンクはしない   // Moon Veil（朔と宵子）の曲。Instagram リール（2026-11-07 ユーザー）
    gallery: [] },
  { id: 'position', group: 'ch1', no: 5, color: 'hayate', title: 'ポジション編', en: 'Position',
    parts: [{ name: 'ポジション編', from: 91, to: 126 }],
    kindle: 3, lead: "Snow flakesの音が広く知られるにつれ、三人を取り巻く環境が変わり始める。\n\n増えていく仕事、求められる役割、少しずつ生まれるすれ違い。\n\n前に立つこと。支えること。同じ場所にいること。\n\n自分は、このバンドのどこに立っているのか。\n\n三人がそれぞれの「ポジション」と向き合う物語。",
    shorts: [{ title: '帰り道', note: 'QF ep.10｜ポジション編 ep.124.5', url: 'https://www.instagram.com/reel/DW_b7avjmf0/' }],
    songs: [], gallery: [] },
  { id: 'cocktail', group: 'ch1', no: 6, color: 'hayate', title: 'カクテル編', en: 'Cocktail',
    parts: [{ name: 'カクテル編', from: 127, to: 137 }],
    kindle: null, lead: "ある夜、ハヤテが訪れたバーには、一台のドラムセットがあった。\n\nカウンターの向こうにいるのは、バーテンダーのりん。\n\nグラスが鳴る音、華やかなフレアショー、思わず重なるリズム。\n\n音楽とは違う場所で出会った二人の時間が、少しずつ動き始める。",
    shorts: [{ title: 'デート', note: 'QF ep.12｜カクテル編 ep.136.5', url: 'https://www.instagram.com/reel/DXMhjm3mj5T/' },
      { title: '氷が呼ぶ', note: 'まだ、鳴っている 第4話', url: 'https://ncode.syosetu.com/n8678mk/4/' },   // 2026-11-07 ユーザー
      { title: 'ひとつ多い音', chara: 'kouta', note: '短篇', url: 'https://ncode.syosetu.com/n0964mc/' }],   // カクテル編とうさぎ編の間の話（2026-11-07 ユーザー）
    songs: [], gallery: [] },
  { id: 'usagi', group: 'ch1', no: 7, color: 'kouta', title: 'うさぎ編', en: 'Rabbit',
    parts: [{ name: 'うさぎ編', from: 138, to: 161 }],
    kindle: null, lead: "ペットショップのうさぎ売り場で、コウタの日常に小さな変化が訪れる。\n\n思いがけない出来事から始まった出会い。何気ない会話と、少しずつ縮まっていく距離。\n\n誰かが自分の音を聴いている。\n\nそのことが、コウタの中に新しい響きを残していく。",
    shorts: [{ title: 'Under tone', chara: 'kouta', note: '短篇', url: 'https://ncode.syosetu.com/n1628mq/' }],   // うさぎ編とスノーフレークス編の間の話（2026-11-07 ユーザー）
    songs: [], gallery: [] },
  { id: 'snowflakes', group: 'ch1', no: 8, title: 'スノーフレークス編', en: 'Snow flakes',
    parts: [{ name: 'スノーフレークス編', from: 162, to: 188 }],
    kindle: null, lead: "仕事も生活も変わり、三人はそれぞれの場所で新しい選択を重ねていく。\n\nバンドが大きくなるほど、これまで当たり前だった関係にも変化が生まれる。\n\n守りたいものは何か。変えずにいたいものは何か。\n\nSnow flakesという名前のもとで、三人はもう一度、自分たちの音と向き合う。",
    shorts: [{ title: '出禁', chara: 'kouta', note: '短篇', url: 'https://ncode.syosetu.com/n1609mm/' },
      { title: 'もっとこわいこと', note: 'まだ、鳴っている 第8話', url: 'https://ncode.syosetu.com/n8678mk/8/' },   // 2026-11-07 ユーザー：出禁のあと
      { title: '白い花', chara: 'hinata', note: '短篇｜文学賞版' }],   // url なし … 未公開（カードだけ・2026-11-07 ユーザー）
    songs: [], gallery: [] },
  { id: 'hinata', group: 'ch1', no: 9, title: 'ヒナタ編', en: 'Hinata',
    parts: [{ name: 'ヒナタ編', from: 189, to: 200 }],
    kindle: null, lead: "ハヤテとコウタがそれぞれの人生を歩き始める中で、ヒナタにも向き合わなければならない想いがあった。\n\nずっと音にしてきたもの。言葉にできずにいたこと。\n\n三人で鳴らし続けてきた音と、ひとりの人間としての選択。\n\nSnow flakes第一章、最後の物語。", shorts: [{ title: '始まりのベース', chara: 'kouta', note: '短篇', url: 'https://ncode.syosetu.com/n5432lz/' }], songs: [], gallery: [] },
  { id: 'qf', group: 'qf', no: null, title: 'Quietly Falling', en: 'Quietly Falling',
    parts: [{ name: 'Quietly Falling', from: 201, to: 289 }],
    kindle: null, lead: "物語が終わっても、三人の日常は続いていく。\n\n本編のその先の、何気ない日々のひとこま。", instagram: true,
    shorts: [   // 「まだ、鳴っている」は話ごとに時期が違うので、いったん載せない（各話の時期が決まったら、編ごとに eps でその話だけ出せる）
      { title: '怖', note: 'まだ、鳴っている 第6話', url: 'https://ncode.syosetu.com/n8678mk/6/' },   // 2026-11-07 ユーザー
      { title: '音の鳴る石', note: '連載', url: 'https://ncode.syosetu.com/n5455ml/' },
      { title: 'Blue Night Drive', chara: 'kouta', note: '短篇' }],   // 短篇・未公開（カードだけ）。公開されたら url を足す（2026-11-07 ユーザー）
    songs: [], gallery: [] },
  { id: 'produce', group: 'mid', no: 10, title: 'プロデュース編', en: 'Produce',
    parts: [{ name: 'プロデュース編', from: 290, to: 301 }],
    kindle: null, lead: "今度は、自分たちではない誰かのために曲を作る。\n\n新しい歌い手たちとの出会い。打ち合わせを重ね、言葉を選び、音を形にしていく時間。\n\n誰のための歌なのか。何を届けたいのか。\n\nSnow flakesが、音楽を作ることの新しい意味に触れていく物語。", shorts: [],
    songs: [{ title: '届く場所', jacket: 'Discography/towa_todoku_basho.webp', url: '../../../../releases/song.html?id=todoku-basho' },
      { title: '届く場所（MV）', mv: 'dhL9OJBSksE' }],   // TOWA（2026-11-07 ユーザー）
    gallery: [] },
  { id: 'before-the-sound', group: 'mid', no: 0, title: 'Before the Sound', en: 'Before the Sound',
    parts: [{ name: 'Before the Sound', from: 302, to: 309 }],
    kindle: null, lead: "まだSnow flakesという名前も、バンドも存在しなかった頃。\n\n幼いヒナタのそばには、小雪がいた。\n\n公園の音、古いカセット、初めて触れたギター。\n\n何気ない日々の中で、少年は少しずつ音楽と出会っていく。\n\nすべての音が鳴り始める前の、小さな物語。",
    shorts: [{ title: 'Before the Sound', chara: 'trio', note: '文学賞版' }],   // url なし … 未公開（カードだけ）
    songs: [], gallery: [] },
  { id: 'after-the-snow', group: 'ch2', no: 1, color: 'mikoto', title: 'After the Snow', en: 'After the Snow',
    parts: [{ name: 'After the Snow', from: 310, to: null }],   // to: null … 連載中（episodes.js の最後まで）
    kindle: null, lead: "Snow flakesの音を聴いて育った、子どもたちの物語。", ongoing: true, shorts: [], songs: [], gallery: [] }
];
