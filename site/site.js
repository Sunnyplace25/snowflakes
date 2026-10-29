/* ============================================================
   site/site.js — site-data.js の内容を描画する共通スクリプト
   ・SfSite.renderEntrances / renderWorks / renderContents / renderNews / renderGames / renderVideos / renderWork
   ・opts.root：サイトのルートまでの相対パス（トップは ''、/stories/ は '../'、/stories/kamisama/ は '../../'）
   ・連載の最新話は「小説家になろう」の公開 API（JSONP）から取得する。取得できなければ「未取得」と表示し、推測しない
   ============================================================ */
(function (global) {
  var S = global.SF_SITE || {};
  var COLORS = { stories: '#93c5fd', music: '#c4b5fd', game: '#fde68a', video: '#f9a8d4', sweets: '#f9a8d4',
    snowflakes: '#93c5fd', kamisama: '#e8a5c4', otohazu: '#7ccf9e', hayatecchi: '#fde68a', undertone: '#c4b5fd', gacha: '#fde68a' };
  var CAT = { story: 'STORY', music: 'MUSIC', game: 'GAME', book: 'BOOK', video: 'VIDEO', event: 'EVENT', info: 'INFO' };

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function isPublic(x) { return !x.status || x.status === 'public'; }
  function todayJst() { return new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10); }
  function link(root, href) { return /^https?:/.test(href) ? href : root + href; }
  function ext(href) { return /^https?:/.test(href) ? ' target="_blank" rel="noopener noreferrer"' : ''; }

  /** 画像枠：image があれば画像、なければグラデーションと英字ラベル */
  function media(root, item, mark, sub, ratio) {
    var has = !!item.image;
    // markOnImage：画像の上にも英字ラベルを重ねる（例：入口 STORIES の「STORY」・2026-10-28）。markPos: 'top' で上端に置く
    if (has && item.markOnImage) mark = item.markOnImage;
    return '<div class="sf-media' + (has ? ' has-img' : '') + (has && item.markOnImage ? ' mark-on' + (item.markPos === 'top' ? ' mark-top' : '') : '') + '"' + (ratio ? ' style="--ratio:' + ratio + '"' : '') + '>' +
      (has ? (item.imageFit === 'contain'
        ? '<img class="sf-media-bg" src="' + esc(link(root, item.image)) + '" alt="" aria-hidden="true" loading="lazy"><img class="sf-media-fg" src="' + esc(link(root, item.image)) + '" alt="' + esc(item.title) + '" loading="lazy">'
        : '<img src="' + esc(link(root, item.image)) + '" alt="' + esc(item.title) + '" loading="lazy">') : '') +
      (sub ? '<span class="sf-media-sub">' + esc(sub) + '</span>' : '') +
      '<span class="sf-media-mark">' + esc(mark) + '</span></div>';
  }
  function card(root, o) {
    return '<a class="sf-card" href="' + esc(link(root, o.href)) + '"' + ext(o.href) + ' style="--c:' + (o.color || '#93c5fd') + '">' +
      media(root, o.item || o, o.mark || o.label || '', o.sub || '', o.ratio) +
      '<div class="sf-card-body">' +
      (o.label ? '<span class="sf-card-label">' + esc(o.label) + '</span>' : '') +
      '<span class="sf-card-title">' + esc(o.title) + '</span>' +
      (o.text ? '<span class="sf-card-text">' + esc(o.text) + '</span>' : '') +
      (o.note ? '<span class="sf-card-note">' + esc(o.note) + '</span>' : '') +
      '<span class="sf-card-go">' + esc(o.go || '見る →') + '</span></div></a>';
  }

  // ── 初めての方へ（3つの入口） ─────────────────────────────
  function renderEntrances(el, opts) {
    var root = (opts && opts.root) || '';
    el.innerHTML = '<div class="sf-cards">' + (S.entrances || []).map(function (e) {
      return card(root, { href: e.href, label: e.label, title: e.title, text: e.text, color: COLORS[e.id], mark: e.label, item: e, go: e.title.replace('から楽しむ', '').replace('で遊ぶ', '') + 'へ →' });
    }).join('') + '</div>';
  }

  // ── 代表作品・作品一覧 ───────────────────────────────────
  function worksList(featuredOnly) {
    return (S.works || []).filter(function (w) { return isPublic(w) && (!featuredOnly || w.featured); })
      .sort(function (a, b) { return (a.order || 99) - (b.order || 99); });
  }
  function renderWorks(el, opts) {
    var root = (opts && opts.root) || '';
    el.innerHTML = '<div class="sf-cards sf-works">' + worksList(opts && opts.featuredOnly).map(function (w) {
      return card(root, { href: w.page, label: w.kind, title: w.title, text: w.lead, color: COLORS[w.id], mark: w.short || w.title, sub: w.kana || '', item: w, ratio: '16 / 9', go: '作品ページへ →' });
    }).join('') + '</div>';
  }

  // ── その他のコンテンツ ───────────────────────────────────
  function renderContents(el, opts) {
    var root = (opts && opts.root) || '';
    var list = (S.contents || []).filter(isPublic);   // status が public 以外のカードは出さない（2026-10-29）
    el.innerHTML = '<div class="sf-cards ' + (list.length === 1 ? 'is-one' : 'is-two') + '">' + list.map(function (c) {
      return card(root, { href: c.href, label: c.label, title: c.title, text: c.text, color: COLORS[c.id], mark: c.label, item: c, ratio: '16 / 9' });
    }).join('') + '</div>';
  }

  // ── ゲーム ───────────────────────────────────────────────
  function renderGames(el, opts) {
    var root = (opts && opts.root) || '';
    var list = (S.games || []).filter(isPublic);
    el.innerHTML = list.length ? '<div class="sf-cards">' + list.map(function (g) {
      return card(root, { href: g.href, label: g.kind, title: g.title, text: g.text, note: g.note, color: COLORS[g.id], mark: g.title, item: g, go: '遊ぶ・詳しく見る →' });
    }).join('') + '</div>' : '<p class="sf-empty">掲載中のゲームはありません。</p>';
  }

  // ── 映像 ─────────────────────────────────────────────────
  function renderVideos(el, opts) {
    var root = (opts && opts.root) || '';
    var artists = (global.SfArtists && global.SfArtists.list) || [];
    var nameOf = function (id) { var a = artists.filter(function (x) { return x.id === id; })[0]; return a ? a : { name: id }; };
    el.innerHTML = '<div class="sf-videos">' + (S.videos || []).map(function (v) {
      var a = nameOf(v.artist);
      return '<figure class="sf-video"><div class="mv-frame"><iframe src="https://www.youtube.com/embed/' + esc(v.youtube) + '" title="' + esc(v.title) + '" loading="lazy" ' +
        'allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe></div>' +
        '<figcaption><span class="sf-video-title">' + esc(v.title) + '</span><br><span class="sf-video-artist">' +
        (a.page ? '<a href="' + esc(root + a.page) + '">' + esc(a.name) + ' →</a>' : esc(a.name)) + '</span></figcaption></figure>';
    }).join('') + '</div>';
  }

  // ── 小説家になろう API（JSONP）で連載の最新話を取得 ─────────────────
  var narouCache = null, narouWaiters = null;
  function narou(cb) {
    if (narouCache) return cb(narouCache);
    if (narouWaiters) return narouWaiters.push(cb);
    narouWaiters = [cb];
    var codes = []; (S.works || []).forEach(function (w) { (w.serials || []).forEach(function (s) { if (s.ncode) codes.push(s.ncode); }); });
    var done = function (map) { narouCache = map; var ws = narouWaiters; narouWaiters = null; ws.forEach(function (f) { f(map); }); };
    if (!codes.length) return done({});
    var name = '__sfNarou' + Date.now();
    var timer = setTimeout(function () { done({ error: true }); }, 8000);
    global[name] = function (res) {
      clearTimeout(timer);
      var map = {};
      (res || []).slice(1).forEach(function (n) { if (n && n.ncode) map[String(n.ncode).toLowerCase()] = { episodes: n.general_all_no, lastup: n.general_lastup }; });
      done(map);
      try { delete global[name]; } catch (e) { global[name] = undefined; }
    };
    var s = document.createElement('script');
    s.src = 'https://api.syosetu.com/novelapi/api/?out=jsonp&callback=' + name + '&of=n-ga-gl&ncode=' + codes.join('-');
    s.onerror = function () { clearTimeout(timer); done({ error: true }); };
    document.head.appendChild(s);
  }

  // ── 最新情報：新曲リリースはディスコグラフィから自動、それ以外（MV・新作発表・新連載/完結・Kindle・イベント・お知らせ）は
  //    site-data.js の news に手で書く。小説の毎日の話数更新は載せない（作品バナーの「最新話」で自動表示しているため・2026-10-27）
  //    手動のお知らせが自動のリリースと同じ内容のときは、news に release: '作品ID' を書くと自動の行を出さない（重複防止）
  function renderNews(el, opts) {
    var root = (opts && opts.root) || '', limit = (opts && opts.limit) || 8, today = todayJst();
    var manual = (S.news || []).filter(function (n) { return n.date && n.title && n.date <= today; });
    var covered = {};
    manual.forEach(function (n) { if (n.release) covered[n.release] = 1; });
    var items = manual.map(function (n) { return { date: n.date, cat: n.category, title: n.title, url: n.url }; });
    var D = global.SF_DISCO, artists = (global.SfArtists && global.SfArtists.list) || [];
    if (D) D.releases.filter(function (r) { return r.status === 'public' && r.releaseDate && r.releaseDate <= today && !covered[r.id]; }).forEach(function (r) {
      var a = artists.filter(function (x) { return x.id === (r.artists || [])[0]; })[0];
      items.push({ date: r.releaseDate, cat: 'music', title: (a ? a.name + '「' : '「') + r.title + '」リリース', url: 'releases/release.html?id=' + encodeURIComponent(r.id) });
    });
    var list = items.sort(function (a, b) { return b.date.localeCompare(a.date); }).slice(0, limit);
    el.innerHTML = list.length ? '<ul class="sf-news">' + list.map(function (n) {
      // リンク先のないお知らせは、リンクにせず矢印も出さない
      var open = n.url ? '<a href="' + esc(link(root, n.url)) + '"' + ext(n.url) + '>' : '<a>';
      return '<li>' + open + '<span class="sf-news-date">' + esc(n.date.replace(/-/g, '.')) + '</span>' +
        '<span class="sf-news-cat">' + esc(CAT[n.cat] || n.cat) + '</span><span class="sf-news-title">' + esc(n.title) +
        (n.date === today ? ' <span style="color:var(--accent,#93c5fd)">TODAY</span>' : '') + '</span>' + (n.url ? '<span class="sf-news-go">→</span>' : '') + '</a></li>';
    }).join('') + '</ul>' : '<p class="sf-empty">お知らせはまだありません。</p>';
  }

  // ── 作品ページ（神様・音ハズなど。Snow flakes はシリーズ専用ページ） ─────────
  function renderWork(el, id, opts) {
    var root = (opts && opts.root) || '../../';
    var w = (S.works || []).filter(function (x) { return x.id === id && isPublic(x); })[0];
    if (!w) { el.innerHTML = '<p class="sf-empty" style="padding:160px 24px">作品が見つかりません。</p>'; return; }
    var artists = (global.SfArtists && global.SfArtists.list) || [];
    var related = (w.artists || []).map(function (aid) { return artists.filter(function (a) { return a.id === aid; })[0]; }).filter(Boolean);
    var games = (S.games || []).filter(function (g) { return isPublic(g) && g.work === w.id; });
    var sec = function (idv, label, title, body) { return body ? '<section class="sf-sec" id="' + idv + '"><div class="sf-wrap"><span class="sf-sec-label">' + label + '</span><h2 class="sf-sec-title sf-head-gap">' + title + '</h2>' + body + '</div></section>' : ''; };
    el.innerHTML =
      '<header class="sf-work-hero" style="--c:' + (COLORS[w.id] || '#93c5fd') + '">' +
        '<p class="sf-work-kind">' + esc(w.kind) + '</p><h1 class="sf-work-title">' + esc(w.title) + '</h1>' +
        (w.short ? '<p class="sf-card-note" style="margin-top:6px">通称「' + esc(w.short) + '」</p>' : '') +
        '<p class="sf-work-lead">' + esc(w.lead) + '</p>' + media(root, w, w.short || w.title, w.kana || '', '16 / 9') + '</header>' +
      sec('synopsis', 'STORY', 'あらすじ', w.synopsis && w.synopsis.length ? '<div class="sf-prose">' + w.synopsis.map(function (p) { return '<p>' + esc(p) + '</p>'; }).join('') + '</div>' : '') +
      sec('update', 'UPDATE', '最新の更新', '<div class="sf-update-list" id="sf-update"></div>' +
        (w.updateNote ? '<p class="sf-update-note" style="color:' + (COLORS[w.id] || '#93c5fd') + '">' + w.updateNote.map(esc).join('<br>') + '</p>' : '')) +   // 最新の更新の下のお知らせ（site-data.js の updateNote）
      sec('read', 'READ', '連載先', '<div class="sf-links">' + (w.serials || []).map(function (s) {
        var row = function (href, name, note) { return '<a class="sf-link-row" href="' + esc(href) + '" target="_blank" rel="noopener noreferrer"><span class="sf-link-name">' + esc(name) + '</span>' +
          (note ? '<span class="sf-link-note">' + esc(note) + '</span>' : '') + '<span>→</span></a>'; };
        return s.ncode ? row(s.url + '1/', '第1話から読む', s.label) : row(s.url, s.label, s.note);
      }).join('') + '</div>') +
      sec('characters', 'CHARACTERS', '登場人物', related.length ? '<p class="sf-sec-lead">作中のバンドとメンバーは、アーティストページで紹介しています。</p><div class="sf-links">' + related.map(function (a) {
        return '<a class="sf-link-row" href="' + esc(root + a.page) + '"><span class="sf-link-name">' + esc(a.name) + '</span><span class="sf-link-note">メンバー紹介・楽曲</span><span>→</span></a>';
      }).join('') + '</div>' : '') +
      sec('related', 'RELATED', '関連コンテンツ', games.length ? '<div class="sf-links">' + games.map(function (g) {
        return '<a class="sf-link-row" href="' + esc(link(root, g.href)) + '"><span class="sf-link-name">' + esc(g.title) + '</span><span class="sf-link-note">' + esc(g.kind) + '</span><span>→</span></a>';
      }).join('') + '</div>' : '') +
      // 将来の追加コンテンツ用（site-data.js の extra に HTML を入れると表示）
      (w.extra ? '<section class="sf-sec"><div class="sf-wrap">' + w.extra + '</div></section>' : '');
    updateBanners(el.querySelector('#sf-update'), w);
  }

  // ── 最新の更新バナー（トップの DAILY UPDATE と同じ見た目・作品色。当日更新なら光る。押すと最新話へ） ──
  function updateBanners(box, w) {
    if (!box || !w) return;
    var color = COLORS[w.id] || '#93c5fd';
    narou(function (map) {
      box.innerHTML = (w.serials || []).filter(function (s) { return s.ncode; }).map(function (s) {
        var n = !map.error && map[s.ncode], ok = !!(n && n.lastup);
        var today = ok && n.lastup.slice(0, 10) === todayJst();
        var href = ok ? s.url + n.episodes + '/' : s.url;
        var sub = !ok ? '最新話は連載ページでご確認ください' : today ? '今日更新しました ✦' : '最終更新 ' + n.lastup.slice(0, 16).replace(/-/g, '/');
        return '<a class="sf-upd' + (today ? ' is-today' : '') + '" style="--c:' + color + '" href="' + esc(href) + '" target="_blank" rel="noopener noreferrer">' +
          '<span class="sf-upd-shine"></span><span class="sf-upd-dot"></span>' +
          '<span class="sf-upd-body"><span class="sf-upd-label">' + (today ? 'TODAY’S UPDATE' : 'LATEST UPDATE') + '</span>' +
          '<span class="sf-upd-title">' + esc(w.short || w.title) + (ok ? '<span class="sf-upd-ep">#' + n.episodes + '</span>' : '') + '</span>' +
          '<span class="sf-upd-sub">' + esc(s.label) + '　' + esc(sub) + '</span></span>' +
          '<span class="sf-upd-side"><span class="sf-upd-status">' + (ok ? '第' + n.episodes + '話まで公開' : '未取得') + '</span><span class="sf-upd-arrow">→</span></span></a>';
      }).join('');
      fitTitles(box);
      if (!box.sfFitBound) { box.sfFitBound = true; global.addEventListener('resize', function () { fitTitles(box); }); }
    });
  }
  // 長い作品名は改行せず、バナーの幅に収まるまで文字を小さくする
  function fitTitles(box) {
    [].forEach.call(box.querySelectorAll('.sf-upd-title'), function (t) {
      t.style.fontSize = '';
      var size = parseFloat(getComputedStyle(t).fontSize);
      while (t.scrollWidth > t.clientWidth && size > 12) { size -= 1; t.style.fontSize = size + 'px'; }
    });
  }

  global.SfSite = { renderEntrances: renderEntrances, renderWorks: renderWorks, renderContents: renderContents, renderNews: renderNews,
    renderGames: renderGames, renderVideos: renderVideos, renderWork: renderWork, narou: narou, updateBanners: updateBanners };
})(window);
