/* ============================================================
   artists/artists.js — アーティスト一覧データとカード描画
   music.html とトップページ（#music）のカードはここから生成する。
   ★ アーティスト追加はこの配列に1件追記するだけ（ページは artists/<id>/ に作成）
   パスはサイトのルート（index.html と同じ階層）からの相対パスで書く。
   ============================================================ */
(function (global) {
  var ARTISTS = [
    {
      id: 'snowflakes',
      name: 'Snow flakes',
      kana: 'スノーフレークス',
      kind: 'INDIE ROCK BAND',
      intro: '繊細なメロディと力強いバンドサウンドを響かせる、3人組インディー・ロックバンド。物語とともに、その音楽は広がっていく。',
      members: 'ハヤテ / ヒナタ / コウタ',
      page: 'artists/snowflakes/',
      image: 'artists/snowflakes/img/main.webp',
      imagePos: '50% 35%',
      color: '#93c5fd',
      glow: 'radial-gradient(ellipse at 50% 120%, rgba(147,197,253,0.18), transparent 70%)',
      services: [
        { type: 'spotify', label: 'Spotify',       url: 'https://open.spotify.com/artist/0nOz1pWptKtNtav9yDoQwN' },
        { type: 'apple',   label: 'Apple Music',   url: 'https://music.apple.com/jp/artist/snow-flakes/1895094537' },
        { type: 'amazon',  label: 'Amazon Music',  url: 'https://music.amazon.co.jp/artists/B0GT9K7NND/snow-flakes' },
        { type: 'youtube', label: 'YouTube Music', url: 'https://music.youtube.com/channel/UCac5FTmiZPeFuTa_bYI0Kjw' },
        { type: 'qobuz',   label: 'Qobuz',         url: 'https://play.qobuz.com/label/10071545' }
      ]
    },
    {
      id: 'towa',
      name: 'TOWA',
      kind: 'TRIO',
      intro: 'Snow flakesがプロデュースする、ひなた・ましろ・みのりの3人組。1st Single「届く場所」。',
      members: 'みのり / ひなた / ましろ',
      page: 'artists/towa/',
      image: 'artists/towa/img/main.webp',
      imagePos: '50% 30%',
      color: '#c4b5fd',
      glow: 'radial-gradient(ellipse at 15% 120%, rgba(249,168,212,0.22), transparent 55%), radial-gradient(ellipse at 50% 120%, rgba(147,197,253,0.22), transparent 55%), radial-gradient(ellipse at 85% 120%, rgba(196,181,253,0.22), transparent 55%)',
      services: [
        { type: 'spotify', label: 'Spotify', url: 'https://open.spotify.com/artist/5DF0aoLhEJIba1vHU1ClrL' },
        { type: 'apple',   label: 'Apple Music', url: 'https://music.apple.com/us/artist/towa/6826399799' },
        { type: 'amazon',  label: 'Amazon Music', url: 'https://music.amazon.co.jp/artists/B0HP262C3J' },
        { type: 'qobuz',   label: 'Qobuz', url: 'https://play.qobuz.com/label/4628473' }
      ]
    },
    {
      id: 'amaoto-club',
      name: '雨音クラブ',
      kind: 'GARAGE ROCK BAND',
      intro: '小説『神様はバンド名がダサいと言った』に登場するガレージロックバンド。',
      members: 'シズク / アキ / ヒロキ',
      page: 'artists/amaoto-club/',
      image: 'artists/amaoto-club/img/main.webp',
      imagePos: '50% 40%',
      color: '#e5a07a',
      glow: 'radial-gradient(ellipse at 50% 120%, rgba(156,163,175,0.2), transparent 70%)',
      services: [
        { type: 'youtube', label: 'YouTube Shorts', url: 'https://youtube.com/shorts/tRBHxBTfBUA' }
      ]
    },
    {
      id: 'moonveil',
      name: 'MoonVeil',
      kind: 'UNIT',
      intro: '物語の中で、Snow flakesと同時期にデビューした、朔と宵子によるユニット。',
      members: '朔 / 宵子',
      page: 'artists/moonveil/',
      image: 'artists/moonveil/img/main.webp',
      imagePos: '50% 40%',
      color: '#a5b4fc',
      glow: 'radial-gradient(ellipse at 80% -10%, rgba(226,232,240,0.18), transparent 50%), radial-gradient(ellipse at 50% 120%, rgba(129,140,248,0.2), transparent 70%)',
      services: [
        { type: 'youtube', label: 'YouTube', url: 'https://www.youtube.com/shorts/LqC29b4RLBI' }
      ]
    }
  ];

  // 制作者（アーティスト一覧には並べず、「Creator｜制作者紹介」として別に案内する）
  var CREATOR = { name: '山吹ことり', page: 'artists/kotori/', image: 'artists/kotori/img/main.webp' };

  var ICONS = {
    spotify: 'fa-brands fa-spotify',
    apple:   'fa-brands fa-apple',
    amazon:  'fa-brands fa-amazon',
    youtube: 'fa-brands fa-youtube',
    qobuz:   'fa-solid fa-compact-disc',
    instagram: 'fa-brands fa-instagram'
  };

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  /**
   * カードを描画する。
   * @param {Element} el
   * @param {object} [opts]
   * @param {string} [opts.base='']    ルートからの相対パス接頭辞（例: artists/towa/ からなら '../../'）
   * @param {string} [opts.exclude]    除外するアーティストID（自分のページ等）
   * @param {boolean}[opts.compact]    サービスリンクを省いた小型カード
   */
  function render(el, opts) {
    if (!el) return;
    opts = opts || {};
    var base = opts.base || '';
    var items = ARTISTS.filter(function (a) { return a.id !== opts.exclude; });
    // 枚数に応じて並べ方を変える（artist-cards.css の .ac-count-N）
    el.className = el.className.replace(/\s*ac-count-\d+/g, '') + ' ac-count-' + items.length;
    el.innerHTML = items.map(function (a) {
      var media = a.image
        ? '<img src="' + esc(base + a.image) + '" alt="' + esc(a.name) + '" loading="lazy" style="object-position:' + esc(a.imagePos) + '">'
        : '<span class="ac-ph">' + esc(a.name) + '</span>';
      var svcs = opts.compact ? '' :
        '<div class="ac-svcs">' + a.services.map(function (s) {
          return '<a class="ac-svc ac-' + esc(s.type) + '" href="' + esc(s.url) + '" target="_blank" rel="noopener noreferrer" title="' + esc(s.label) + '" aria-label="' + esc(a.name + ' ' + s.label) + '"><i class="' + ICONS[s.type] + '"></i></a>';
        }).join('') + '</div>';
      return '<article class="ac-card ac-' + esc(a.id) + '" style="--ac:' + esc(a.color) + ';--ac-glow:' + esc(a.glow) + '">' +
        '<a class="ac-media" href="' + esc(base + a.page) + '" aria-label="' + esc(a.name) + ' のページへ">' + media + '</a>' +
        '<div class="ac-body">' +
          '<p class="ac-kind">' + esc(a.kind) + '</p>' +
          '<h3 class="ac-name"><a href="' + esc(base + a.page) + '">' + esc(a.name) + '</a></h3>' +
          '<p class="ac-members">' + esc(a.members) + '</p>' +
          '<p class="ac-intro">' + esc(a.intro) + '</p>' +
          '<div class="ac-foot">' +
            '<a class="ac-go" href="' + esc(base + a.page) + '">ARTIST PAGE →</a>' + svcs +
          '</div>' +
        '</div>' +
      '</article>';
    }).join('');
  }

  /**
   * 「Creator｜制作者紹介」への案内リンクを描画する（Music ページ・トップの Music 欄）
   * @param {Element} el
   * @param {object} [opts] - base: ルートからの相対パス接頭辞
   */
  function renderCreator(el, opts) {
    if (!el) return;
    var base = (opts && opts.base) || '';
    el.innerHTML = '<a class="creator-link" href="' + esc(base + CREATOR.page) + '">' +
      '<img src="' + esc(base + CREATOR.image) + '" alt="' + esc(CREATOR.name) + '" loading="lazy">' +
      '<span class="creator-text"><span class="creator-kind">CREATOR｜制作者紹介</span>' +
      '<span class="creator-name">' + esc(CREATOR.name) + '</span></span>' +
      '<span class="creator-arrow">→</span></a>';
  }

  /**
   * シェアボタンの HTML（押すと sfArtistShare：artists/artist.js）。作品・音楽ページの見出しに置く
   */
  function shareButton() {
    return '<div class="hero-actions"><button class="share-btn" onclick="sfArtistShare()" type="button">' +
      '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>' +
      'share</button></div>';
  }

  global.SfArtists = { list: ARTISTS, render: render, renderCreator: renderCreator, creator: CREATOR, shareButton: shareButton };
})(window);
