/* ============================================================
   releases/disco.js — ディスコグラフィの共通テンプレート
   ・一覧（index.html）・作品詳細（release.html?id=）・楽曲詳細（song.html?id=）を描画する
   ・データは data.js の SF_DISCO、アーティスト名・ページは artists/artists.js の SfArtists
   ・未登録の項目は出さない（セクションごと省略）
   ============================================================ */
(function (global) {
  var ROOT = '../';     // サイトのルートまでの相対パス（アーティストページから使うときは '../../'）
  var PAGES = '';       // 作品・楽曲詳細ページ（releases/）までの相対パス
  var D = global.SF_DISCO || { songs: {}, releases: [] };
  var ARTISTS = (global.SfArtists && global.SfArtists.list) || [];

  var TYPE_LABEL = { single: 'Single', ep: 'EP', album: 'Album' };
  // body に付けるテーマ（artists/artist.css の theme-*）
  var THEME = { snowflakes: 'theme-snowflakes', towa: 'theme-towa', 'amaoto-club': 'theme-amaoto', moonveil: 'theme-moonveil' };

  // ── 共通 ───────────────────────────────────────────────────
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function has(v) { return v != null && v !== '' && !(Array.isArray(v) && v.length === 0); }
  function param(name) { return new URLSearchParams(location.search).get(name); }
  function todayJst() { return new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10); }
  function fmtDate(d) { return d ? d.replace(/-/g, '.') : ''; }
  function asset(path) { return encodeURI(ROOT + path); }

  /** 一般公開してよい作品か（status が public で、リリース日が来ているもの） */
  function isVisible(r) {
    return r && r.status === 'public' && (!r.releaseDate || r.releaseDate <= todayJst());
  }
  function visibleReleases() { return D.releases.filter(isVisible); }
  function findRelease(id) { return D.releases.filter(function (r) { return r.id === id; })[0]; }
  function artist(id) {
    return ARTISTS.filter(function (a) { return a.id === id; })[0] || { id: id, name: id };
  }
  function artistNames(ids) {
    return (ids || []).map(function (id) { return esc(artist(id).name); }).join(' / ');
  }
  function artistPlain(ids) { return (ids || []).map(function (id) { return artist(id).name; }).join(' / '); }
  function artistLinks(ids) {
    return (ids || []).map(function (id) {
      var a = artist(id);
      return a.page ? '<a href="' + asset(a.page) + '">' + esc(a.name) + '</a>' : esc(a.name);
    }).join(' / ');
  }
  /** 新しい順。リリース日未登録は常に最後、同じ日は order の小さい順 */
  function compareRelease(a, b, oldest) {
    if (!a.releaseDate !== !b.releaseDate) return a.releaseDate ? -1 : 1;
    if (a.releaseDate !== b.releaseDate) {
      var c = a.releaseDate < b.releaseDate ? -1 : 1;
      return oldest ? c : -c;
    }
    return (a.order || 0) - (b.order || 0);
  }
  /** その曲を収録した公開中の作品（古い順） */
  function releasesOfSong(songId) {
    return visibleReleases().filter(function (r) { return (r.tracks || []).indexOf(songId) >= 0; })
      .sort(function (a, b) { return compareRelease(a, b, true); });
  }
  function setTheme(artistId) {
    var t = THEME[artistId];
    if (t) document.body.classList.add(t);
  }
  function setMeta(title, desc) {
    document.title = title + '｜Discography｜Snow flakes 公式';
    var m = document.querySelector('meta[name="description"]');
    if (m && desc) m.setAttribute('content', desc);
  }
  function noIndex() {
    var m = document.createElement('meta');
    m.name = 'robots'; m.content = 'noindex';
    document.head.appendChild(m);
  }

  // ── 部品 ───────────────────────────────────────────────────
  /** 画像が読めなければ仮ジャケットに切り替える（img の onerror から呼ぶ） */
  function ph(img) {
    var box = img.parentNode;
    if (box) box.classList.add('is-ph');
    img.remove();
  }
  function jacket(r, cls) {
    var label = esc(r ? r.title : '');
    var img = r && r.jacket
      ? '<img src="' + asset(r.jacket) + '" alt="' + label + ' ジャケット" loading="lazy" onerror="SfDisco.ph(this)">'
      : '';
    return '<div class="dj ' + (cls || '') + (img ? '' : ' is-ph') + '" data-title="' + label + '">' + img + '</div>';
  }
  function serviceButtons(o) {
    var b = [];
    if (o.spotify) b.push('<a class="pill spotify" href="' + esc(o.spotify) + '" target="_blank" rel="noopener noreferrer"><i class="fa-brands fa-spotify"></i> Spotify</a>');
    if (o.amazon)  b.push('<a class="pill amazon" href="' + esc(o.amazon) + '" target="_blank" rel="noopener noreferrer"><i class="fa-brands fa-amazon"></i> Amazon Music</a>');
    return b.length ? '<div class="dd-links">' + b.join('') + '</div>' : '';
  }
  function section(id, en, ja, body) {
    if (!body) return '';
    return '<section class="a-section dd-sec" id="' + id + '">' +
      '<span class="sec-label">' + en + '</span>' + (ja ? '<h2 class="sec-title">' + ja + '</h2>' : '') + body + '</section>';
  }
  function storyTitle(s) {
    if (s.label) return esc(s.label);
    return esc(s.work || '') + (s.ep ? ' 第' + esc(s.ep) + '話' : '');
  }
  /** 関連エピソード：「Snow flakes｜第82話「話タイトル」 →」を1行ずつ縦に並べ、行全体がリンク。
      種類（type）・説明文（note）はデータに残すが表示しない。話タイトル（epTitle）は原作の正式名称を登録したものだけ出す。
      話数のない作品（短編・書籍）は label または作品名を出す。複数曲の作品ページでは、どの曲の話かを ♪ で併記する */
  function storiesLines(items) {
    if (!items.length) return '';
    return '<ul class="dd-stories">' + items.map(function (s) {
      var work = s.series || 'Snow flakes';
      var text = s.ep ? esc(work) + '｜第' + esc(s.ep) + '話' + (s.epTitle ? '「' + esc(s.epTitle) + '」' : '') : storyTitle(s);
      return '<li><a href="' + esc(s.url) + '" target="_blank" rel="noopener noreferrer">' +
        '<span class="dd-story-text">' + text + (s.song ? '<span class="dd-story-song">♪ ' + esc(s.song) + '</span>' : '') + '</span>' +
        '<span class="dd-story-go" aria-hidden="true">→</span></a></li>';
    }).join('') + '</ul>';
  }
  /** 歌詞：本文と行内の改行は原文どおり（pre-wrap）。空行で区切られたまとまりを段落（p）にし、
      段落の間隔だけを CSS で調整する。空行が2つ以上続く箇所は data-gap に空行の数を持たせて間隔を広げる */
  /** 曲の歌詞。別バージョンで歌詞が同じものは lyricsFrom に元の曲のキーを書き、その歌詞を表示する（歌詞は1か所だけに持つ） */
  function lyricsOf(s) {
    if (!s) return '';
    if (has(s.lyrics)) return s.lyrics;
    var from = s.lyricsFrom && D.songs[s.lyricsFrom];
    return from && has(from.lyrics) ? from.lyrics : '';
  }
  function lyricsParas(text) {
    var parts = String(text).replace(/^\s*\n|\n\s*$/g, '').split(/(\n(?:[ \t　]*\n)+)/);
    var html = '', gap = 0;
    parts.forEach(function (p, i) {
      if (i % 2) { gap = p.split('\n').length - 2; return; }
      html += '<p' + (gap > 1 ? ' data-gap="' + gap + '"' : '') + '>' + esc(p) + '</p>';
    });
    return html;
  }
  /** 歌詞はページ内に全文を出さず、「歌詞を見る」ボタンからモーダルで表示する（全楽曲共通・2026-10-28）。
      本文はボタンの直後に非表示で持ち（文はそのまま）、モーダルで1カラム・左揃えに表示する。
      meta: { title, artist, credits }（モーダルの見出し用。credits はアーティスト名の下に小さく出し、ページには出さない・2026-10-28） */
  function lyricsBlock(text, meta) {
    if (!has(text)) return '';
    meta = meta || {};
    return '<div class="dd-lyr-open-wrap"><button type="button" class="pill dd-lyr-open" aria-haspopup="dialog"' +
      ' data-title="' + esc(meta.title || '') + '" data-artist="' + esc(meta.artist || '') + '"' +
      ' data-credit="' + esc(creditLine(meta.credits)) + '">歌詞を見る</button></div>' +
      '<div class="dd-lyrics dd-lyr-src" hidden>' + lyricsParas(text) + '</div>';
  }
  function textBlock(text, cls) {
    if (!has(text)) return '';
    return '<div class="' + cls + '">' + String(text).split(/\n{2,}/).map(function (p) {
      return '<p>' + esc(p).replace(/\n/g, '<br>') + '</p>';
    }).join('') + '</div>';
  }
  /** 制作クレジット：見出し・表組みなしで「役割：名前」を1件1行。歌詞のすぐ下に、歌詞と同じ開始位置で置く */
  function creditLine(credits) {
    if (!has(credits)) return '';
    return '<div class="dd-credit">' + credits.map(function (c) {
      return '<p class="f-en">' + esc(c.role) + ': ' + esc(c.name) + '</p>';
    }).join('') + '</div>';
  }
  /** 作品情報の日付：「Release：2026.03.19」形式の1行 */
  function infoLines(release, created) {
    var h = (release ? '<p class="dd-line f-en">Release：' + fmtDate(release) + '</p>' : '') +
            (created ? '<p class="dd-line">制作：<span class="f-en">' + fmtDate(created) + '</span></p>' : '');
    return h ? '<div class="dd-lines">' + h + '</div>' : '';
  }
  function mvBlock(items) {
    // items: [{ id: YouTube ID, caption }]
    if (!items.length) return '';
    return items.map(function (m) {
      return '<div class="mv-frame"><iframe src="https://www.youtube.com/embed/' + esc(m.id) + '" title="' + esc(m.caption) + '" loading="lazy" ' +
        'allow="accelerometer; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe></div>' +
        '<p class="mv-caption">' + esc(m.caption) + '</p>';
    }).join('');
  }
  /** Hi-Res バッジ（作品データの hiRes が true のものだけ） */
  function hiResBadge(r) {
    return r.hiRes === true ? '<span class="hires" title="ハイレゾ配信対応">Hi-Res</span>' : '';
  }
  /** 一覧カード：ジャケット・作品タイトル・アーティスト・リリース日（＋種別と Hi-Res）。
      カップリング曲（sub）や収録曲名はカードに出さず、作品詳細の収録曲に表示する */
  function releaseCard(r) {
    return '<a class="dc" href="' + PAGES + 'release.html?id=' + encodeURIComponent(r.id) + '">' + jacket(r, 'dc-jacket') +
      '<span class="dc-meta"><span class="dc-type">' + esc(TYPE_LABEL[r.type] || r.type) + '</span>' + hiResBadge(r) + '</span>' +
      '<span class="dc-title">' + esc(r.title) + '</span>' +
      '<span class="dc-artist">' + artistNames(r.artists) + '</span>' +
      (r.releaseDate ? '<span class="dc-date f-en">' + fmtDate(r.releaseDate) + '</span>' : '') + '</a>';
  }
  function cardsBlock(list) {
    return list.length ? '<div class="dc-grid is-small">' + list.map(releaseCard).join('') + '</div>' : '';
  }
  function notFound(root, what) {
    noIndex();
    setMeta('ページが見つかりません');
    root.innerHTML = '<section class="a-section dd-missing"><p>' + what + 'が見つかりませんでした。</p>' +
      '<a class="pill ghost" href="./">ディスコグラフィ一覧へ →</a></section>';
  }

  // ── SCENE GALLERY（物語に関連する画像と制作メモ）────────────────
  /** gallery: [{ img, title, memo, order, link, focus }]
      ・order の小さい順。img がないものは出さない。画像が読めなかったものはその1枚だけ消し、全部消えたら欄ごと消す
      ・title・memo は登録された文だけを出す（どちらも空なら重ねて表示しない）。memo の改行はそのまま
      ・focus：縦長画像の見せる位置（CSS の object-position。既定は上寄り '50% 25%'。拡大表示では全体を表示）
      ・link：拡大表示に「関連ページへ」を出す */
  function galleryBlock(items) {
    var list = (items || []).filter(function (g) { return g && g.img; }).slice()
      .sort(function (a, b) { return (a.order || 0) - (b.order || 0); });
    if (!list.length) return '';
    return '<ul class="dg-grid">' + list.map(function (g, i) {
      var cap = (has(g.title) || has(g.memo))
        ? '<span class="dg-cap" aria-hidden="true">' + (has(g.memo) ? '<span class="dg-cap-label">制作メモ</span>' : '') +
          (has(g.title) ? '<span class="dg-cap-title">' + esc(g.title) + '</span>' : '') +
          // 一覧のホバーは最初の段落だけ（全文は拡大表示で読む。文そのものは変えない）
          (has(g.memo) ? '<span class="dg-cap-memo">' + esc(String(g.memo).replace(/^\s+/, '').split(/\n[ \t　]*\n/)[0]) + '</span>' : '') + '</span>'
        : '';
      return '<li class="dg-item"><button type="button" class="dg-open" data-i="' + i + '"' +
        ' data-src="' + asset(g.img) + '" data-title="' + esc(g.title || '') + '" data-memo="' + esc(g.memo || '') + '" data-link="' + esc(g.link || '') + '"' +
        ' aria-label="' + esc((g.title || 'シーン ' + (i + 1)) + '（拡大して見る）') + '">' +
        '<img src="' + asset(g.img) + '" alt="' + esc(g.title || '') + '" loading="lazy" style="object-position:' + esc(g.focus || '50% 25%') + '" onerror="SfDisco.gph(this)">' +
        cap + '</button></li>';
    }).join('') + '</ul>';
  }
  /** 読めなかった画像はその1枚を外す。全部外れたら欄ごと消す（空の欄を出さない） */
  function gph(img) {
    var li = img.closest('.dg-item'), sec = img.closest('.dd-sec');
    if (li) li.remove();
    if (sec && !sec.querySelector('.dg-item')) sec.remove();
  }

  /** 拡大表示（ライトボックス）：ページに1つだけ作り、押されたギャラリーの画像を順に見せる。
      PC は画像の右、スマホは画像の下にコメント欄（制作メモ・タイトル・本文・関連ページ）。
      タイトル・本文・リンクがすべて空の画像ではコメント欄ごと出さず、画像だけを中央に置く。
      閉じる（×・背景・Esc）、前後（ボタン・←→キー・左右スワイプ）。閉じたら押したボタンへフォーカスを戻す */
  var lb = null;
  function lightbox() {
    if (lb) return lb;
    var d = document.createElement('dialog');
    d.className = 'dg-lb';
    d.setAttribute('aria-label', '画像の拡大表示');
    d.innerHTML =
      '<div class="dg-lb-inner">' +
        '<button type="button" class="dg-lb-close" aria-label="閉じる">×</button>' +
        '<figure class="dg-lb-fig">' +
          '<div class="dg-lb-media"><img class="dg-lb-img" alt=""><span class="dg-lb-count f-en" aria-live="polite"></span></div>' +
          '<figcaption class="dg-lb-cap">' +
            '<span class="dg-cap-label dg-lb-label">制作メモ</span>' +
            '<span class="dg-lb-title"></span><div class="dg-lb-memo"></div>' +
            '<a class="dg-lb-link" target="_blank" rel="noopener noreferrer">関連ページへ →</a>' +
            '<span class="dg-lb-more" aria-hidden="true">続きがあります ↓</span></figcaption></figure>' +
        '<button type="button" class="dg-lb-nav dg-lb-prev" aria-label="前の画像">‹</button>' +
        '<button type="button" class="dg-lb-nav dg-lb-next" aria-label="次の画像">›</button>' +
      '</div>';
    document.body.appendChild(d);
    lb = { d: d, img: d.querySelector('.dg-lb-img'), count: d.querySelector('.dg-lb-count'), cap: d.querySelector('.dg-lb-cap'),
           label: d.querySelector('.dg-lb-label'), title: d.querySelector('.dg-lb-title'), memo: d.querySelector('.dg-lb-memo'), link: d.querySelector('.dg-lb-link'),
           items: [], i: 0, opener: null };
    function go(step) { if (lb.items.length > 1) show((lb.i + step + lb.items.length) % lb.items.length); }
    d.querySelector('.dg-lb-close').addEventListener('click', function () { d.close(); });
    d.querySelector('.dg-lb-prev').addEventListener('click', function () { go(-1); });
    d.querySelector('.dg-lb-next').addEventListener('click', function () { go(1); });
    // 背景（画像・文字・ボタン以外）を押したら閉じる
    d.addEventListener('click', function (e) {
      if (e.target === d || e.target.classList.contains('dg-lb-inner') || e.target.classList.contains('dg-lb-fig')) d.close();
    });
    d.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowLeft') { e.preventDefault(); go(-1); }
      else if (e.key === 'ArrowRight') { e.preventDefault(); go(1); }
      else if (lb.cap.hasAttribute('tabindex')) {
        // 制作メモ欄がスクロールできるときは ↑↓・PageUp/PageDown（ボタン・リンク以外では Space も）でメモを読み進める
        var onControl = /^(A|BUTTON)$/.test((e.target && e.target.tagName) || '');
        if (!/^(ArrowDown|ArrowUp|PageDown|PageUp)$/.test(e.key) && !(e.key === ' ' && !onControl)) return;
        e.preventDefault();
        var step = /Page| /.test(e.key) ? lb.cap.clientHeight * 0.85 : 48;
        lb.cap.scrollBy({ top: /Up/.test(e.key) ? -step : step, behavior: 'smooth' });
      }
    });
    var x0 = null;
    d.addEventListener('touchstart', function (e) { x0 = e.touches[0].clientX; }, { passive: true });
    d.addEventListener('touchend', function (e) {
      if (x0 == null) return;
      var dx = e.changedTouches[0].clientX - x0; x0 = null;
      if (Math.abs(dx) > 50) go(dx < 0 ? 1 : -1);
    });
    // メモ欄がスクロールできるときは、続きの案内とキーボード操作（↑↓・PageUp/Down）を有効に
    lb.cap.addEventListener('scroll', more, { passive: true });
    d.addEventListener('close', function () {
      document.documentElement.classList.remove('dg-lock');
      if (lb.opener && document.contains(lb.opener)) lb.opener.focus();
    });
    return lb;
  }
  function more() {
    if (!lb) return;
    var c = lb.cap, scrollable = !c.hidden && c.scrollHeight > c.clientHeight + 2;
    c.classList.toggle('has-more', scrollable && c.scrollHeight - c.scrollTop - c.clientHeight > 4);
    if (scrollable) { c.setAttribute('tabindex', '0'); c.setAttribute('aria-label', '制作メモ（スクロールして読めます）'); }
    else { c.removeAttribute('tabindex'); c.removeAttribute('aria-label'); }
  }
  function show(i) {
    var b = lb.items[i]; lb.i = i;
    var t = b.getAttribute('data-title'), m = b.getAttribute('data-memo'), l = b.getAttribute('data-link');
    lb.img.src = b.getAttribute('data-src');
    lb.img.alt = t || '';
    lb.count.textContent = lb.items.length > 1 ? (i + 1) + ' / ' + lb.items.length : '';
    // コメント欄：見出し「制作メモ」はタイトルか本文があるときだけ。全部空なら欄ごと隠す
    lb.label.hidden = !(t || m);
    lb.title.textContent = t || ''; lb.title.hidden = !t;
    // 本文：空行で区切られたまとまりを段落（p）にする。行内の改行はそのまま（文は変えない）
    lb.memo.textContent = '';
    (m || '').replace(/^\s*\n|\n\s*$/g, '').split(/\n[ \t　]*\n+/).forEach(function (para) {
      if (!para) return;
      var p = document.createElement('p'); p.textContent = para; lb.memo.appendChild(p);
    });
    lb.memo.hidden = !m;
    if (l) { lb.link.href = l; lb.link.hidden = false; } else { lb.link.removeAttribute('href'); lb.link.hidden = true; }
    lb.cap.hidden = !(t || m || l);
    lb.cap.scrollTop = 0;
    requestAnimationFrame(more);
    if (!lb.img.complete) lb.img.addEventListener('load', more, { once: true });
    lb.d.querySelector('.dg-lb-inner').scrollTop = 0;   // スマホ：切り替えたら画像の先頭から見せる
    lb.d.classList.toggle('has-note', !lb.cap.hidden);
    lb.d.classList.toggle('is-single', lb.items.length < 2);
  }
  function initGallery(root) {
    root.addEventListener('click', function (e) {
      var b = e.target.closest('.dg-open');
      if (!b) return;
      var box = lightbox();
      box.items = Array.prototype.slice.call(b.closest('.dg-grid').querySelectorAll('.dg-open'));
      box.opener = b;
      show(box.items.indexOf(b));
      document.documentElement.classList.add('dg-lock');
      box.d.showModal();
      box.d.querySelector('.dg-lb-close').focus();
    });
  }

  // ── 歌詞モーダル（全楽曲共通） ─────────────────────────────────
  /** 「歌詞を見る」で開く。1カラム・左揃え。閉じる（×・背景・Esc）、閉じたら押したボタンへフォーカスを戻す。
      歌詞の本文だけ、通常操作でのコピー（選択・右クリック・コピー・切り取り・ドラッグ）を抑える。
      ほかの文章・リンク・ページ全体には影響させない（完全な保護ではない） */
  var lyr = null;
  function lyricsModal() {
    if (lyr) return lyr;
    var d = document.createElement('dialog');
    d.className = 'dd-lyr';
    d.setAttribute('aria-labelledby', 'dd-lyr-title');
    d.innerHTML =
      '<div class="dd-lyr-box">' +
        '<header class="dd-lyr-head"><div><span class="sec-label">LYRICS</span>' +
          '<h2 class="dd-lyr-title" id="dd-lyr-title"></h2><p class="dd-lyr-artist"></p><div class="dd-lyr-credit"></div></div>' +
          '<button type="button" class="dd-lyr-close" aria-label="歌詞を閉じる">×</button></header>' +
        '<div class="dd-lyr-scroll" tabindex="0" aria-label="歌詞（スクロールして読めます）"><div class="dd-lyr-body"></div></div>' +
      '</div>';
    document.body.appendChild(d);
    lyr = { d: d, title: d.querySelector('.dd-lyr-title'), artist: d.querySelector('.dd-lyr-artist'), credit: d.querySelector('.dd-lyr-credit'), body: d.querySelector('.dd-lyr-body'), scroll: d.querySelector('.dd-lyr-scroll'), opener: null };
    d.querySelector('.dd-lyr-close').addEventListener('click', function () { d.close(); });
    // 背景（枠の外）を押したら閉じる
    d.addEventListener('click', function (e) { if (e.target === d) d.close(); });
    d.addEventListener('close', function () {
      document.documentElement.classList.remove('dd-lyr-lock');
      if (lyr.opener && document.contains(lyr.opener)) lyr.opener.focus();
    });
    // 歌詞の本文だけ、通常操作でのコピーを抑える
    ['copy', 'cut', 'contextmenu', 'dragstart', 'selectstart'].forEach(function (ev) {
      lyr.body.addEventListener(ev, function (e) { e.preventDefault(); });
    });
    return lyr;
  }
  function initLyrics(root) {
    root.addEventListener('click', function (e) {
      var b = e.target.closest('.dd-lyr-open');
      if (!b) return;
      var src = b.parentNode.nextElementSibling;
      if (!src || !src.classList.contains('dd-lyr-src')) return;
      var m = lyricsModal();
      m.opener = b;
      m.title.textContent = b.getAttribute('data-title') || '';
      m.artist.textContent = b.getAttribute('data-artist') || '';
      m.artist.hidden = !m.artist.textContent;
      m.credit.innerHTML = b.getAttribute('data-credit') || '';   // creditLine で作ったもの（esc 済み）
      m.credit.hidden = !m.credit.innerHTML;
      m.body.innerHTML = src.innerHTML;   // 文はそのまま（同じ段落を写すだけ）
      m.scroll.scrollTop = 0;
      document.documentElement.classList.add('dd-lyr-lock');
      m.d.showModal();
      m.d.querySelector('.dd-lyr-close').focus();
    });
  }

  /** 関連作品：手動指定（related）＋同じ曲・同じ曲の別バージョンを含む作品 */
  function relatedReleases(r) {
    var base = function (sid) { var s = D.songs[sid]; return (s && s.versionOf) || sid; };
    var mine = (r.tracks || []).map(base);
    var out = (r.related || []).map(findRelease).filter(isVisible);
    visibleReleases().forEach(function (o) {
      if (o.id === r.id || out.indexOf(o) >= 0) return;
      if ((o.tracks || []).some(function (sid) { return mine.indexOf(base(sid)) >= 0; })) out.push(o);
    });
    return out.sort(function (a, b) { return compareRelease(a, b, false); });
  }

  // ── 一覧 ───────────────────────────────────────────────────
  function renderList(root) {
    var all = visibleReleases();
    var artistIds = ARTISTS.map(function (a) { return a.id; }).filter(function (id) {
      return all.some(function (r) { return (r.artists || []).indexOf(id) >= 0; });
    });
    var state = {
      artist: artistIds.indexOf(param('artist')) >= 0 ? param('artist') : 'all',
      type: TYPE_LABEL[param('type')] ? param('type') : 'all',
      sort: param('sort') === 'old' ? 'old' : 'new'
    };
    setTheme(state.artist);

    function chips(name, items) {
      return '<div class="dl-chips" role="group" data-name="' + name + '">' + items.map(function (it) {
        return '<button type="button" class="dl-chip' + (state[name] === it[0] ? ' is-on' : '') + '" data-v="' + esc(it[0]) + '" aria-pressed="' + (state[name] === it[0]) + '">' + esc(it[1]) + '</button>';
      }).join('') + '</div>';
    }
    function draw() {
      var list = all.filter(function (r) {
        return (state.artist === 'all' || (r.artists || []).indexOf(state.artist) >= 0) &&
               (state.type === 'all' || r.type === state.type);
      }).sort(function (a, b) { return compareRelease(a, b, state.sort === 'old'); });
      root.querySelector('.dl-count').textContent = list.length + ' 作品';
      root.querySelector('.dc-grid').innerHTML = list.length
        ? list.map(releaseCard).join('')
        : '<p class="dl-empty">該当する作品はありません。</p>';
      var q = new URLSearchParams();
      if (state.artist !== 'all') q.set('artist', state.artist);
      if (state.type !== 'all') q.set('type', state.type);
      if (state.sort !== 'new') q.set('sort', state.sort);
      history.replaceState(null, '', location.pathname + (q.toString() ? '?' + q : ''));
    }

    root.innerHTML =
      '<header class="a-section dl-head"><span class="sec-label">DISCOGRAPHY</span><h1 class="sec-title">ディスコグラフィ</h1>' +
      '<div class="dl-controls">' +
        (artistIds.length > 1 ? chips('artist', [['all', 'All']].concat(artistIds.map(function (id) { return [id, artist(id).name]; }))) : '') +
        chips('type', [['all', 'All'], ['single', 'Single'], ['ep', 'EP'], ['album', 'Album']]) +
        '<div class="dl-sort"><span class="dl-count"></span>' +
          '<select aria-label="並び順"><option value="new"' + (state.sort === 'new' ? ' selected' : '') + '>新しい順</option>' +
          '<option value="old"' + (state.sort === 'old' ? ' selected' : '') + '>古い順</option></select></div>' +
      '</div></header>' +
      '<section class="a-section dl-body"><div class="dc-grid"></div></section>';

    root.querySelectorAll('.dl-chips').forEach(function (g) {
      g.addEventListener('click', function (e) {
        var b = e.target.closest('.dl-chip');
        if (!b) return;
        state[g.dataset.name] = b.dataset.v;
        g.querySelectorAll('.dl-chip').forEach(function (x) {
          var on = x === b; x.classList.toggle('is-on', on); x.setAttribute('aria-pressed', on);
        });
        if (g.dataset.name === 'artist') {
          Object.keys(THEME).forEach(function (k) { document.body.classList.remove(THEME[k]); });
          setTheme(state.artist);
        }
        draw();
      });
    });
    root.querySelector('.dl-sort select').addEventListener('change', function (e) { state.sort = e.target.value; draw(); });
    draw();
  }

  // ── 作品詳細 ───────────────────────────────────────────────
  function renderRelease(root) {
    var r = findRelease(param('id'));
    if (!isVisible(r)) return notFound(root, '作品');
    setTheme((r.artists || [])[0]);
    setMeta(r.title + (r.sub ? ' / ' + r.sub : ''), artist((r.artists || [])[0]).name + '「' + r.title + '」' + (TYPE_LABEL[r.type] || '') + 'の作品ページ。');

    var songs = (r.tracks || []).map(function (sid) { return { id: sid, s: D.songs[sid] }; }).filter(function (t) { return t.s; });
    var single = r.type === 'single';

    // 1〜3. ジャケット・作品名・アーティスト・日付・配信リンク
    var head =
      '<header class="a-section dd-head">' + jacket(r, 'dd-jacket') +
      '<div class="dd-info"><p class="dd-meta"><span class="dd-type f-en">' + esc(TYPE_LABEL[r.type] || r.type) + '</span>' + hiResBadge(r) + '</p>' +
      '<h1 class="dd-title">' + esc(r.title) + '</h1>' +
      (r.sub ? '<p class="dd-sub">' + esc(r.sub) + '</p>' : '') +
      '<p class="dd-artist">' + artistLinks(r.artists) + '</p>' +
      infoLines(r.releaseDate, r.createdDate) +
      serviceButtons(r) + '</div></header>';

    // 4. Tracklist（EP・Album、および2曲以上のシングル）
    var tracklist = (!single || songs.length > 1) ? '<ol class="dd-tracks">' + songs.map(function (t, i) {
      var other = (t.s.artists || []).join() !== (r.artists || []).join();
      return '<li><a href="song.html?id=' + encodeURIComponent(t.id) + '"><span class="dd-tn f-en">' + String(i + 1).padStart(2, '0') + '</span>' +
        '<span class="dd-tt">' + esc(t.s.title) + (other ? '<small>' + artistNames(t.s.artists) + '</small>' : '') + '</span><span class="dd-tg">›</span></a></li>';
    }).join('') + '</ol>' : '';

    // 5. Lyrics・Kotori's Note（どちらも楽曲単位で管理。シングルは収録曲の分をここに出し、
    //    EP・Album は各楽曲ページに出す。2曲以上のときは曲名の小見出しを付ける）
    function perSong(field, block) {
      if (!single) return '';
      return songs.filter(function (t) { return has(t.s[field]); }).map(function (t) {
        return (songs.length > 1 ? '<h3 class="dd-sub-h">' + esc(t.s.title) + '</h3>' : '') + block(t.s[field]);
      }).join('');
    }
    // 歌詞は1曲シングルだけ作品ページに出す。2曲以上のシングル・EP・Album は各楽曲ページ（収録曲から開く・2026-10-28 ユーザー指示）
    var lyrics = (single && songs.length === 1 && has(lyricsOf(songs[0].s)))
      ? lyricsBlock(lyricsOf(songs[0].s), { title: songs[0].s.title, artist: artistPlain(songs[0].s.artists), credits: songs[0].s.credits }) : '';
    var noteBody = textBlock(r.kotoriNote, 'dd-note') + perSong('kotoriNote', function (v) { return textBlock(v, 'dd-note'); });

    // 6. Related Story（作品に付いたもの＋収録曲に付いたもの）
    var stories = (r.stories || []).slice();
    songs.forEach(function (t) {
      (t.s.stories || []).forEach(function (s) {
        var o = {}; for (var k in s) o[k] = s[k];
        if (songs.length > 1) o.song = t.s.title;
        stories.push(o);
      });
    });

    // 9. MV（シングルは曲の MV も使う）
    var mvs = [];
    if (r.mv) mvs.push({ id: r.mv, caption: '「' + r.title + '」Music Video' });
    else if (single) songs.forEach(function (t) { if (t.s.mv) mvs.push({ id: t.s.mv, caption: '「' + t.s.title + '」Music Video' }); });

    root.innerHTML = assemble({
      head: head, lyrics: lyrics, note: noteBody, tracklist: tracklist,
      // ギャラリー：作品に付いたもの。1曲シングルでは曲に付いたものを使う
      mv: mvBlock(mvs), stories: stories, gallery: galleryBlock(r.gallery || (single && songs.length === 1 ? songs[0].s.gallery : null)), versions: '',
      relatedTitle: '関連作品', related: cardsBlock(relatedReleases(r))
    }) + backLink(r.artists);
    initGallery(root);
    initLyrics(root);
  }

  // ── 楽曲詳細 ───────────────────────────────────────────────
  function renderSong(root) {
    var id = param('id');
    var s = D.songs[id];
    var on = s ? releasesOfSong(id) : [];
    if (!s || !on.length) return notFound(root, '楽曲');
    var first = on[0];
    setTheme((s.artists || [])[0]);
    setMeta(s.title, artist((s.artists || [])[0]).name + '「' + s.title + '」の楽曲ページ。');

    var head =
      '<header class="a-section dd-head">' + jacket(first, 'dd-jacket') +
      '<div class="dd-info"><p class="dd-type f-en">Song</p>' +
      '<h1 class="dd-title">' + esc(s.title) + '</h1>' +
      '<p class="dd-artist">' + artistLinks(s.artists) + '</p>' +
      // 「収録：」の行は下の収録作品と重なるので出さない（2026-10-28 ユーザー指示）
      infoLines(first.releaseDate, s.createdDate) +
      serviceButtons(s) + '</div></header>';

    // 別バージョン（同じ元曲を持つ曲・元曲そのもの）
    var baseId = s.versionOf || id;
    var versions = Object.keys(D.songs).filter(function (k) {
      return k !== id && (k === baseId || D.songs[k].versionOf === baseId) && releasesOfSong(k).length;
    });
    // 並び順は versionOrder（小さいほど先）。未指定は登録順のまま後ろへ
    var vo = function (k) { var n = D.songs[k].versionOrder; return n == null ? 999 : n; };
    versions = versions.map(function (k, i) { return { k: k, i: i }; })
      .sort(function (a, b) { return vo(a.k) - vo(b.k) || a.i - b.i; }).map(function (o) { return o.k; });
    // versionsNote：別バージョンのボタンの上に小さく添える一言（曲ごとに任意・2026-10-28）
    var versionList = versions.length ? (s.versionsNote ? '<p class="dd-ver-note">' + esc(s.versionsNote) + '</p>' : '') +
      '<ul class="dd-versions">' + versions.map(function (k) {
      return '<li><a href="song.html?id=' + encodeURIComponent(k) + '">' + esc(D.songs[k].title) + ' ›</a></li>';
    }).join('') + '</ul>' : '';

    var mvs = s.mv ? [{ id: s.mv, caption: '「' + s.title + '」Music Video' }] : [];
    root.innerHTML = assemble({
      head: head,
      lyrics: lyricsBlock(lyricsOf(s), { title: s.title, artist: artistPlain(s.artists), credits: s.credits }),
      note: textBlock(s.kotoriNote, 'dd-note'), tracklist: '', mv: mvBlock(mvs),
      stories: s.stories || [], gallery: galleryBlock(s.gallery), versions: versionList,
      relatedTitle: '収録作品', related: cardsBlock(on.slice().reverse())
    }) + backLink(s.artists);
    initGallery(root);
    initLyrics(root);
  }

  /** 折りたたみ式のセクション（見出しを押すと開く）。中身がなければ出さない */
  function fold(id, en, ja, body) {
    if (!body) return '';
    return '<section class="a-section dd-sec dd-fold" id="' + id + '"><details>' +
      '<summary><span class="dd-fold-label"><span class="sec-label">' + en + '</span><span class="dd-fold-title">' + ja + '</span></span>' +
      '<span class="dd-fold-icon" aria-hidden="true"></span></summary>' +
      '<div class="dd-fold-body">' + body + '</div></details></section>';
  }

  /** 詳細ページ共通の組み立て（全作品・全楽曲共通）：
        作品情報（ジャケットと左右に並べる）→ 歌詞（常に表示・PCは2段組み）→ 収録曲 → MV
        → 関連エピソード（常時表示・1行リンク。未設定なら出さない）→ シーンギャラリー（画像がなければ出さない）
        → ことりノート（折りたたみ）→ 別バージョン → 関連作品 */
  function assemble(p) {
    return '<div class="dd-v2">' + p.head +
      section('lyrics', 'LYRICS', '歌詞', p.lyrics) +
      section('tracklist', 'TRACKLIST', '収録曲', p.tracklist) +
      section('mv', 'MUSIC VIDEO', 'MV', p.mv) +
      section('story', 'RELATED STORY', '関連エピソード', storiesLines(p.stories)) +
      section('gallery', 'SCENE GALLERY', 'シーンギャラリー', p.gallery) +
      fold('note', "KOTORI'S NOTE", 'ことりノート', p.note) +
      section('versions', 'OTHER VERSIONS', '', p.versions) +   // 日本語見出しは出さない（2026-10-28 ユーザー指示）
      section('related', 'RELATED RELEASES', p.relatedTitle, p.related) + '</div>';
  }

  function backLink(artistIds) {
    var a = (artistIds || [])[0];
    return '<div class="a-section dd-back"><a class="pill ghost" href="./' + (a ? '?artist=' + encodeURIComponent(a) : '') + '">← ディスコグラフィ一覧</a>' +
      (a && artist(a).page ? '<a class="pill ghost" href="' + asset(artist(a).page) + '">' + esc(artist(a).name) + ' のページ</a>' : '') + '</div>';
  }

  /** アーティストページのディスコグラフィ欄：そのアーティストの公開作品を新しい順に limit 件
      opts: { artist, root（サイトのルートまでの相対パス）, limit } */
  function renderArtist(el, opts) {
    if (!el) return;
    ROOT = opts.root || '../../';
    PAGES = ROOT + 'releases/';
    var list = visibleReleases().filter(function (r) { return (r.artists || []).indexOf(opts.artist) >= 0; })
      .sort(function (a, b) { return compareRelease(a, b, false); });
    var shown = opts.limit ? list.slice(0, opts.limit) : list;
    el.innerHTML = shown.map(releaseCard).join('');
    el.hidden = !shown.length;
    return list.length;
  }

  global.SfDisco = {
    ph: ph,
    gph: gph,
    renderArtist: renderArtist,
    isVisible: isVisible,
    render: function () {
      var root = document.getElementById('disco-root');
      if (!root) return;
      var page = root.dataset.page;
      if (page === 'release') renderRelease(root);
      else if (page === 'song') renderSong(root);
      else renderList(root);
    }
  };
})(window);
