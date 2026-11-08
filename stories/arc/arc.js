/* 章・編ページの組み立て（Snow flakes・音ハズで共用。body の data-arc で、どの編かを決める）
   データ：作品ごとの arcs.js（SF_ARC_SITE＝なろうの作品コード・作品名、SF_ARC_GROUPS、SF_ARCS）・episodes.js（各話タイトル）
   Snow flakes だけ：books.js（Kindle）・qf-instagram.js（QF ページ） */
(function () {
  var SITE = window.SF_ARC_SITE || { ncode: 'n9009lo', series: 'Snow flakes' };
  var NAROU = 'https://ncode.syosetu.com/' + SITE.ncode + '/';
  var ARCS = window.SF_ARCS || [], GROUPS = window.SF_ARC_GROUPS || [], EPS = window.SF_EPISODES || {}, BOOKS = window.SF_BOOKS || [];
  var id = document.body.getAttribute('data-arc');
  var arc = ARCS.filter(function (a) { return a.id === id; })[0];
  if (!arc) return;
  var group = GROUPS.filter(function (g) { return g.id === arc.group; })[0] || {};
  var lastNo = window.SF_EPISODE_LAST ? SF_EPISODE_LAST() : 0;

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return '&#' + c.charCodeAt(0) + ';'; }); }
  function $(sel) { return document.querySelector(sel); }
  // 公開済みの話（lastNo）までだけ出す。予約投稿で先に登録した章・話は、公開されるまで出さない
  function partTo(p) { return Math.min(p.to == null ? lastNo : p.to, lastNo); }
  var SHOWN = ARCS.filter(function (a) { return a.parts[0].from <= lastNo || a.id === id; });
  var first = arc.parts[0].from;
  function chapterLabel(a) {
    var g = GROUPS.filter(function (x) { return x.id === a.group; })[0] || {};
    if (a.label) return a.label;   // 音ハズの「第一章」など、編ごとに見出しを決めているとき
    return a.no != null ? g.label + '　' + a.no : g.label;
  }
  var soon = '<p class="arc-soon">準備中</p>';

  // ── 上：章・編の切り替え ──
  $('#arc-map').innerHTML = GROUPS.map(function (g) {
    var items = SHOWN.filter(function (a) { return a.group === g.id; });
    return '<div class="arc-map-group"><span class="arc-map-label">' + esc(g.label) + (g.sub ? '<small>' + esc(g.sub) + '</small>' : '') + '</span><div class="arc-map-items">' +
      items.map(function (a) {
        var cur = a.id === arc.id;
        return '<a class="arc-chip' + (cur ? ' is-current' : '') + (a.color ? ' c-' + a.color : '') + '" href="../' + a.id + '/"' + (cur ? ' aria-current="page"' : '') + '>' +
          (a.no != null && g.numbered ? '<span class="arc-chip-no">' + a.no + '</span>' : '') + esc(a.title) + '</a>';
      }).join('') + '</div></div>';
  }).join('');

  // スマホでは一覧をたたんで「章・編を選ぶ」の1行にする（押すと開く。PC は CSS で常に開いたまま）
  $('#arc-map').insertAdjacentHTML('beforebegin', '<button class="arc-map-toggle" id="arc-map-toggle" type="button" aria-expanded="false" aria-controls="arc-map">' +
    '<span class="arc-map-toggle-label">章・編を選ぶ</span><span class="arc-map-toggle-cur">' + esc(chapterLabel(arc) === arc.title ? arc.title : chapterLabel(arc) + '｜' + arc.title) + '</span><span class="arc-map-toggle-icon" aria-hidden="true">▾</span></button>');
  $('#arc-map-toggle').addEventListener('click', function () {
    var open = $('#arc-map').classList.toggle('is-open');
    this.setAttribute('aria-expanded', open ? 'true' : 'false');
  });

  // ── ヒーロー ──
  $('#arc-kind').textContent = group.kind ? group.kind + ' ' + arc.no : (group.en || 'STORY');   // kind … 章ごとに番号を付ける（音ハズの CHAPTER 1 など）
  if (arc.color) document.querySelector('.hero').classList.add('c-' + arc.color);   // 編の色（章カード・ピルボタンと同じ）
  $('#arc-chapter').textContent = chapterLabel(arc);
  if (chapterLabel(arc) === arc.title) $('#arc-chapter').hidden = true;
  $('#arc-title').textContent = arc.title;
  $('#arc-en').textContent = arc.en && arc.en !== arc.title ? arc.en : '';
  $('#arc-actions').insertAdjacentHTML('afterbegin', '<span id="arc-acts" style="display:contents"></span>');

  // ── 話数・ボタン・各話一覧（連載中の編は、なろう API の話数が増えていたら描き直す） ──
  function renderEpisodes() {
    // 最初の話がまだ公開前（予約投稿）の章：話数とボタンの代わりに公開日時だけ出す
    if (first > lastNo) {
      var at = (window.SF_EPISODE_SCHEDULE || {})[first], d = at ? new Date(at) : null;
      $('#arc-meta').textContent = d ? (d.getMonth() + 1) + '月' + d.getDate() + '日 ' + d.getHours() + ':' + String(d.getMinutes()).padStart(2, '0') + ' 公開予定' : '公開前';
      $('#arc-acts').innerHTML = '';
      $('#arc-eps').innerHTML = '<p class="arc-soon">公開前</p>';
      return;
    }
    var last = partTo(arc.parts[arc.parts.length - 1]);
    var total = 0; arc.parts.forEach(function (p) { total += partTo(p) - p.from + 1; });
    $('#arc-meta').textContent = 'ep.' + first + '〜' + last + '（全' + total + '話）' + (arc.ongoing ? '・連載中' : '');
    var acts = '<a class="btn main" href="' + NAROU + first + '/" target="_blank" rel="noopener">ep.' + first + ' から読む</a>';
    if (arc.ongoing) acts += '<a class="btn" href="' + NAROU + last + '/" target="_blank" rel="noopener">最新話を読む</a>';
    $('#arc-acts').innerHTML = acts + '<a class="btn" href="#episodes">各話一覧 ↓</a>';
    // 編が2つある章は、編ごとに見出し。タイトルがまだ episodes.js にない新しい話は「新しい話」と出す
    $('#arc-eps').innerHTML = arc.parts.map(function (p) {
      var rows = [];
      for (var n = p.from; n <= partTo(p); n++) {
        var t = EPS[n] || '', m = /^幕間[｜|](.*)$/.exec(t);
        rows.push('<li' + (m ? ' class="is-interlude"' : '') + '><a href="' + NAROU + n + '/" target="_blank" rel="noopener"><span class="ep-no">' + (m ? '幕間' : 'ep.' + n) + '</span><span>' + (t ? esc(m ? m[1] : t) : '<span class="ep-new">新しい話</span>') + '</span></a></li>');
      }
      return (arc.parts.length > 1 ? '<h3 class="arc-part">' + esc(p.name) + '<small>ep.' + p.from + '〜' + partTo(p) + '</small></h3>' : '') + '<ol class="eps">' + rows.join('') + '</ol>';
    }).join('');
    // 話数が多い編は、スマホでは決まった高さの枠に入れて枠の中だけスクロール（arc.css の .is-scroll：2026-11-07 ユーザー）
    $('#arc-eps').classList.toggle('is-scroll', $('#arc-eps').querySelectorAll('li').length > 20);
  }
  renderEpisodes();
  if (arc.ongoing) {
    window.__sfArcNarou = function (res) {
      var n = res && res[1] && +res[1].general_all_no;
      if (n > 0 && n !== lastNo) { lastNo = n; renderEpisodes(); }
    };
    var js = document.createElement('script');
    js.src = 'https://api.syosetu.com/novelapi/api/?out=jsonp&callback=__sfArcNarou&of=ga&ncode=' + SITE.ncode;
    document.head.appendChild(js);
  }

  // ── あらすじ ──
  if (!arc.lead) $('#arc-lead').className = '';
  $('#arc-lead').innerHTML = arc.lead ? arc.lead.split(/\n{2,}/).map(function (p) { return '<p>' + esc(p).replace(/\n/g, '<br>') + '</p>'; }).join('') : soon;

  // ── QF：Instagram 連載（QF ページだけ） ──
  var ig = $('#instagram');
  if (ig) {
    if (arc.instagram && window.SF_QF_INSTAGRAM) {
      ig.hidden = false;
      $('#arc-ig-list').innerHTML = window.SF_QF_INSTAGRAM.map(function (e) {   // 上の各話一覧と同じく ep.01 から。note（関連）はボタンに出さない
        return '<li><a href="' + esc(e.url) + '" target="_blank" rel="noopener"><span class="ep-no">' + esc(e.ep) + '</span><span>' + esc(e.title) + '</span></a></li>';
      }).join('');
    }
  }

  // ── 関連短編 ──
  // url がないものは未公開（リンクなしのカードだけ）
  $('#arc-shorts').innerHTML = arc.shorts.length ? '<div class="arc-links">' + arc.shorts.map(function (s) {
    if (s.eps) return '<div class="arc-set"><a class="arc-link" href="' + esc(s.url) + '" target="_blank" rel="noopener"><span class="arc-link-name">' + esc(s.title) + '</span><span class="arc-link-note">' + esc(s.note || '') + '</span><span>→</span></a>' +
      '<div class="arc-set-eps">' + s.eps.map(function (e) { return '<a href="' + esc(s.epBase + e.no + '/') + '" target="_blank" rel="noopener"><small>' + e.no + '</small>' + esc(e.title) + '</a>'; }).join('') + '</div></div>';   // 連作：1枚のカード＋各話のボタン
    var cc = s.chara ? ' c-' + s.chara : '';   // 主人公の色（枠）
    if (!s.url) return '<div class="arc-link is-soon' + cc + '"><span class="arc-link-name">' + esc(s.title) + '</span><span class="arc-link-note">' + esc(s.note || '') + '</span><span class="arc-link-badge">未公開</span></div>';
    return '<a class="arc-link' + cc + '" href="' + esc(s.url) + '"' + (s.internal ? '' : ' target="_blank" rel="noopener"') + '><span class="arc-link-name">' + esc(s.title) + '</span><span class="arc-link-note">' + esc(s.note || '') + '</span><span>→</span></a>';
  }).join('') + '</div>' : soon;

  // ── ギャラリー ──
  $('#arc-gallery').innerHTML = arc.gallery.length ? '<div class="gallery">' + arc.gallery.map(function (g, i) {
    return '<button class="g-item" type="button" data-i="' + i + '" aria-label="拡大：' + esc(g.alt) + '"><img src="' + esc(g.img) + '" alt="' + esc(g.alt) + '" loading="lazy"></button>';
  }).join('') + '</div>' : soon;

  // ── 関連曲 ──
  // 章の曲＋作品全体の曲（SF_ARC_SITE.songs）。yt があれば YouTube Shorts のサムネイル付きカード
  var songs = arc.songs.concat(SITE.songs || []);
  $('#arc-songs').innerHTML = songs.length ? '<div class="songs">' + songs.map(function (s) {
    if (s.yt) return '<a class="song" href="https://youtube.com/shorts/' + esc(s.yt) + '" target="_blank" rel="noopener"><div class="song-thumb"><img src="https://i.ytimg.com/vi/' + esc(s.yt) + '/oar2.jpg" alt="' + esc(s.title) + '" loading="lazy"></div>' +
      '<div class="song-body"><p class="song-title">' + esc(s.title) + '</p><p class="song-note">' + esc(s.note || '') + '</p></div></a>';
    if (s.mv) return '<a class="song" href="https://www.youtube.com/watch?v=' + esc(s.mv) + '" target="_blank" rel="noopener"><div class="song-thumb is-jacket is-mv"><img src="https://i.ytimg.com/vi/' + esc(s.mv) + '/hqdefault.jpg" alt="' + esc(s.title) + '" loading="lazy"><span class="song-play" aria-hidden="true">▶</span></div>' +
      '<div class="song-body"><p class="song-title">' + esc(s.title) + '</p></div></a>';   // mv … YouTube の MV（ジャケットと同じ四角いカード）
    if (s.jacket) return '<a class="song" href="' + esc(s.url) + '"' + (/^https?:/.test(s.url) ? ' target="_blank" rel="noopener"' : '') + '><div class="song-thumb is-jacket"><img src="../../../../' + encodeURI(s.jacket) + '" alt="' + esc(s.title) + '" loading="lazy"></div>' +
      '<div class="song-body"><p class="song-title">' + esc(s.title) + '</p>' + (s.badge ? '<p class="song-badge">' + esc(s.badge) + '</p>' : '') + '</div></a>';   // jacket … HP の Discography の画像（ジャケット＋タイトルだけ）。badge … 「SWEETs限定」など押す前に知らせたいこと
    return '<a class="arc-link" href="' + esc(s.url) + '"><span class="arc-link-name">' + esc(s.title) + '</span><span class="arc-link-note">' + esc(s.note || '') + '</span><span>→</span></a>';
  }).join('') + '</div>' : soon;

  // 中身のない欄（あらすじ・関連短編・ギャラリー・関連曲）は「準備中」を並べず、欄ごと隠す（2026-11-07）
  $('#story').hidden = !arc.lead;
  $('#shorts').hidden = !arc.shorts.length;
  $('#gallery').hidden = !arc.gallery.length;
  $('#songs').hidden = !songs.length;

  // ── 書籍（Kindle に収録されている編だけ） ──
  var bk = arc.kindle != null ? BOOKS[arc.kindle] : null;
  if (bk) {
    $('#arc-book-sec').hidden = false;
    $('#arc-book').innerHTML = '<a class="arc-book" href="' + esc(bk.url) + '" target="_blank" rel="noopener"><img src="../../../../' + encodeURI(bk.img) + '" alt="' + esc(SITE.series) + ' ' + esc(bk.title) + '" loading="lazy">' +
      '<span><span class="arc-book-title">' + esc(SITE.series) + ' ' + esc(bk.title) + '</span><span class="arc-book-text">' + esc(bk.text[0]) + '</span><span class="arc-book-go">Kindle で読む →</span></span></a>';
  }

  // ── 前の編・次の編 ──
  var i = SHOWN.indexOf(arc), prev = SHOWN[i - 1], next = SHOWN[i + 1];
  $('#arc-pager').innerHTML =
    (prev ? '<a class="arc-pager-link' + (prev.color ? ' c-' + prev.color : '') + '" href="../' + prev.id + '/"><small>← 前へ｜' + esc(chapterLabel(prev)) + '</small>' + esc(prev.title) + '</a>' : '<span></span>') +
    (next ? '<a class="arc-pager-link is-next' + (next.color ? ' c-' + next.color : '') + '" href="../' + next.id + '/"><small>次へ｜' + esc(chapterLabel(next)) + ' →</small>' + esc(next.title) + '</a>' : '<span></span>');
  // 続けて読む人が迷わないよう、前後の編は各話一覧のすぐ下へ（2026-11-08 導線見直し）
  if ($('#episodes')) $('#episodes').parentNode.insertBefore($('#arc-pager'), $('#episodes').nextSibling);

  // ── ギャラリーの拡大 ──
  var lb = $('#lb'), lbImg = $('#lb-img'), cur = 0;
  function show(n) { cur = (n + arc.gallery.length) % arc.gallery.length; lbImg.src = arc.gallery[cur].img; lbImg.alt = arc.gallery[cur].alt; lb.classList.add('open'); }
  $('#arc-gallery').addEventListener('click', function (e) { var b = e.target.closest('.g-item'); if (b) show(+b.dataset.i); });
  lb.querySelector('.lb-close').onclick = function () { lb.classList.remove('open'); };
  lb.querySelector('.lb-prev').onclick = function (e) { e.stopPropagation(); show(cur - 1); };
  lb.querySelector('.lb-next').onclick = function (e) { e.stopPropagation(); show(cur + 1); };
  lb.addEventListener('click', function (e) { if (e.target === lb) lb.classList.remove('open'); });
  document.addEventListener('keydown', function (e) {
    if (!lb.classList.contains('open')) return;
    if (e.key === 'Escape') lb.classList.remove('open');
    if (e.key === 'ArrowLeft') show(cur - 1);
    if (e.key === 'ArrowRight') show(cur + 1);
  });
})();
