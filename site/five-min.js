/* 今日の5分：短篇1本＋関連曲1曲をセットで案内する（トップの EXPLORE の下）。
   日付で毎日入れ替わり、「ほかの組み合わせ」で次へ。組み合わせは PAIRS に足していく。 */
(function () {
  var PAIRS = [
    { story: { title: '白い音', note: 'ヒナタ｜短篇', url: 'https://ncode.syosetu.com/n0679lx/' },
      song:  { title: 'Little Snow（Near）', url: 'releases/song.html?id=little-snow-near', jacket: 'Discography/early_snow.webp' } },
    { story: { title: '整えない音', note: 'ヒナタ｜短篇', url: 'https://ncode.syosetu.com/n0082lu/' },
      song:  { title: 'Little Snow（Raw）', url: 'releases/song.html?id=little-snow-raw', jacket: 'Discography/early_snow.webp' } },
    { story: { title: '半分のまま', note: 'ヒナタ｜短篇', url: 'https://ncode.syosetu.com/n0327lw/' },
      song:  { title: '呼吸の距離', url: 'releases/song.html?id=kokyu-no-kyori', jacket: 'Discography/瞬間に残る.webp' } },
    { story: { title: '透明なリズム', note: 'ハヤテ｜短篇', url: 'https://ncode.syosetu.com/n5484lz/' },
      song:  { title: '透明のまま', url: 'releases/song.html?id=toumei-no-mama', jacket: 'Discography/early_snow.webp' } },
    { story: { title: 'Moon Veil', note: '朔｜短篇', url: 'https://ncode.syosetu.com/n9832lr/' },
      song:  { title: 'Moon Veil', url: 'https://www.instagram.com/reel/DZuqfqwxpNs/', jacket: 'artists/moonveil/img/main.webp' } },
    { story: { title: 'ひとつ多い音', note: 'コウタ｜短篇', url: 'https://ncode.syosetu.com/n0964mc/' },
      song:  { title: 'Undertone', url: 'releases/song.html?id=undertone', jacket: 'Discography/undertone.webp' } },
    { story: { title: '高校編', note: 'Snow flakes 本編｜ep.1〜', url: 'https://ncode.syosetu.com/n9009lo/1/' },
      song:  { title: '音が消えるまでは', url: 'releases/song.html?id=oto-ga-kieru-made', jacket: 'Discography/Little Snow.webp' } },
    { story: { title: '大学編', note: 'Snow flakes 本編｜ep.22〜', url: 'https://ncode.syosetu.com/n9009lo/22/' },
      song:  { title: '置いた音', url: 'releases/song.html?id=oita-oto', jacket: 'Discography/置いた音.webp' } },
    { story: { title: '一本だけのドラムスティック', note: 'ハヤテ｜短篇', url: 'https://ncode.syosetu.com/n2115mf/' },
      song:  { title: '約束はしない', url: 'releases/song.html?id=yakusoku-wa-shinai', jacket: 'Discography/early_snow.webp' } },
    { story: { title: 'ショーケースの前で恋をした', note: '短篇連作', url: 'stories/showcase/' },
      song:  { title: '花の名前を忘れても', url: 'releases/song.html?id=hana-no-namae', jacket: 'Discography/瞬間に残る.webp' } },
    { story: { title: '始まりのベース', note: 'コウタ｜短篇', url: 'https://ncode.syosetu.com/n5432lz/' },
      song:  { title: 'Still（Untitled）', url: 'releases/song.html?id=still', jacket: 'Discography/early_snow.webp' } },
    { story: { title: 'Under tone', note: 'コウタ｜短篇', url: 'https://ncode.syosetu.com/n1628mq/' },
      song:  { title: 'Aftertone', url: 'releases/song.html?id=aftertone', jacket: 'Discography/undertone.webp' } },
    { story: { title: '正しい距離より、触れている方がいい', note: 'ヒナタ｜短篇', url: 'https://ncode.syosetu.com/n0498ly/' },
      song:  { title: 'Spring Waltz', url: 'releases/song.html?id=spring-waltz', jacket: 'Discography/undertone.webp' } },
    { story: { title: 'Quietly Falling', note: 'Snow flakes 本編｜ep.201〜', url: 'https://ncode.syosetu.com/n9009lo/201/' },
      song:  { title: 'プリズム', url: 'releases/song.html?id=prism', jacket: 'Discography/prism.webp' } },
    { story: { title: 'Quietly Falling', note: 'Instagram 書き下ろし｜最新話', url: 'https://www.instagram.com/reel/DZ_4P6aFFHs/' },
      song:  { title: 'ここにいる', url: 'releases/song.html?id=koko-ni-iru', jacket: 'Discography/prism.webp' } },
    { story: { title: 'Quietly Falling', note: '本編とInstagram｜章ページ', url: 'stories/snowflakes/arc/qf/' },
      song:  { title: 'まだ鳴ってる', url: 'releases/song.html?id=mada-natteru', jacket: 'Discography/mada_natteru.webp' } },
    { story: { title: '神様はバンド名がダサいと言った', note: '雨音クラブ｜第十話', url: 'https://ncode.syosetu.com/n3833mv/10/' },
      song:  { title: '雨天決行', url: 'https://youtube.com/shorts/tRBHxBTfBUA', jacket: 'https://i.ytimg.com/vi/tRBHxBTfBUA/oardefault.jpg' } },
    { story: { title: '神様はバンド名がダサいと言った', note: '雨音クラブ｜第二十二話', url: 'https://ncode.syosetu.com/n3833mv/22/' },
      song:  { title: '雨天決行（Acoustic Ver.）', url: 'https://soundcloud.com/yamabuki-kotori/acoustic-ver', jacket: 'artists/amaoto-club/img/utenkekkou_acoustic.webp' } },
    { story: { title: '神様はバンド名がダサいと言った', note: '雨音クラブ｜第二十五話', url: 'https://ncode.syosetu.com/n3833mv/25/' },
      song:  { title: 'ここで鳴らす', url: 'https://youtube.com/shorts/oYcRo4GDQdU', jacket: 'https://i.ytimg.com/vi/oYcRo4GDQdU/oardefault.jpg' } },
    { story: { title: '神様はバンド名がダサいと言った', note: '雨音クラブ｜第五話', url: 'https://ncode.syosetu.com/n3833mv/5/' },
      song:  { title: '午前零時のサイン', url: 'https://youtube.com/shorts/_kqpiETerlo', jacket: 'https://i.ytimg.com/vi/_kqpiETerlo/oardefault.jpg' } },
    { story: { title: '対バン', note: '神様はバンド名がダサいと言った｜幕間', url: 'https://ncode.syosetu.com/n3833mv/26/' },
      song:  { title: '何でモテねえんだよ', url: 'https://youtube.com/shorts/mtXDr0yTVO4', jacket: 'https://i.ytimg.com/vi/mtXDr0yTVO4/oar1.jpg' } },
    { story: { title: '昨日までの音', note: '神様はバンド名がダサいと言った｜第十二話', url: 'https://ncode.syosetu.com/n3833mv/12/' },
      song:  { title: '昨日までの音', url: 'https://youtube.com/shorts/yjxA-WjvcaI', jacket: 'https://i.ytimg.com/vi/yjxA-WjvcaI/oardefault.jpg' } },
    { story: { title: 'スノーフレークス編', note: 'Snow flakes 本編｜ep.162〜', url: 'https://ncode.syosetu.com/n9009lo/162/' },
      song:  { title: '祝奏', url: 'releases/song.html?id=shukusou', jacket: 'Discography/瞬間に残る.webp' } },
    { story: { title: 'Before the Sound', note: 'Snow flakes 本編｜ep.302〜', url: 'https://ncode.syosetu.com/n9009lo/302/' },
      song:  { title: '名前のない歌', url: 'releases/song.html?id=namae-no-nai-uta', jacket: 'Discography/early_snow.webp' } },
    { story: { title: 'プロデュース編', note: 'Snow flakes 本編｜ep.290〜', url: 'https://ncode.syosetu.com/n9009lo/290/' },
      song:  { title: '届く場所', url: 'releases/song.html?id=todoku-basho', jacket: 'Discography/towa_todoku_basho.webp' } },
    { story: { title: 'ヒナタ編', note: 'Snow flakes 本編｜ep.189〜', url: 'https://ncode.syosetu.com/n9009lo/189/' },
      song:  { title: 'Little Snow', url: 'releases/song.html?id=little-snow', jacket: 'Discography/Little Snow.webp' } },
    { story: { title: '怖', note: 'まだ、鳴っている｜第6話', url: 'https://ncode.syosetu.com/n8678mk/6/' },
      song:  { title: 'In One Sky', url: 'releases/song.html?id=in-one-sky', jacket: 'Discography/in_one_sky.webp' } },
    { story: { title: 'ポジション編', note: 'Snow flakes 本編｜ep.91〜', url: 'https://ncode.syosetu.com/n9009lo/91/' },
      song:  { title: 'Signal', url: 'releases/song.html?id=signal', jacket: 'Discography/Signal.webp' } },
    { story: { title: 'カクテル編', note: 'Snow flakes 本編｜ep.127〜', url: 'https://ncode.syosetu.com/n9009lo/127/' },
      song:  { title: 'グラスの縁', url: 'releases/song.html?id=glass-no-fuchi', jacket: 'Discography/Signal.webp' } },
    { story: { title: 'うさぎ編', note: 'Snow flakes 本編｜ep.138〜', url: 'https://ncode.syosetu.com/n9009lo/138/' },
      song:  { title: 'Rabbit', url: 'releases/song.html?id=rabbit', jacket: 'Discography/Rabbit.webp' } },
    { story: { title: '夏の月', note: 'Snow flakes 本編｜ep.82〜', url: 'https://ncode.syosetu.com/n9009lo/82/' },
      song:  { title: 'Round Bounce', url: 'releases/song.html?id=round-bounce', jacket: 'Discography/Round Bounce.webp' } },
    { story: { title: 'ショーケース編', note: 'Snow flakes 本編｜ep.70〜', url: 'https://ncode.syosetu.com/n9009lo/70/' },
      song:  { title: 'SWEETs', url: 'releases/song.html?id=sweets', jacket: 'Discography/SWEETs.webp' } }
  ];
  var el = document.getElementById('five-min');
  if (!el || !PAIRS.length) return;
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return '&#' + c.charCodeAt(0) + ';'; }); };
  var ext = function (u) { return /^https?:/.test(u) ? ' target="_blank" rel="noopener noreferrer"' : ''; };
  var d = new Date(), i = (d.getFullYear() * 400 + d.getMonth() * 31 + d.getDate()) % PAIRS.length;
  function render() {
    var p = PAIRS[i];
    el.innerHTML =
      '<p class="fm-label">TODAY\'S 5 MINUTES</p>' +
      '<h3 class="fm-title">今日の5分</h3>' +
      '<p class="fm-lead">短篇をひとつ読んで、その曲を聴く。</p>' +
      '<div class="fm-body">' +
        '<a class="fm-jacket" href="' + esc(p.song.url) + '"' + ext(p.song.url) + '><img src="' + encodeURI(p.song.jacket) + '" alt="' + esc(p.song.title) + '" onload="if(this.naturalWidth<=120&&!this.dataset.fb){this.dataset.fb=1;this.src=this.src.replace(/oardefault/,this.dataset.alt)}" data-alt="oar2" loading="lazy"></a>' +
        '<div class="fm-items">' +
          '<a class="fm-item" href="' + esc(p.story.url) + '"' + ext(p.story.url) + '><span class="fm-kind">読む</span><span class="fm-name">' + esc(p.story.title) + '<small>' + esc(p.story.note) + '</small></span><span class="fm-go">→</span></a>' +
          '<a class="fm-item" href="' + esc(p.song.url) + '"' + ext(p.song.url) + '><span class="fm-kind">聴く</span><span class="fm-name">' + esc(p.song.title) + '</span><span class="fm-go">→</span></a>' +
        '</div>' +
      '</div>' +
      '<button class="fm-next" type="button">ほかの組み合わせ ↻</button>';
    el.querySelector('.fm-next').onclick = function () { i = (i + 1) % PAIRS.length; render(); };
  }
  render();
})();
