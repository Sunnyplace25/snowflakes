/* ============================================================
   stories/collection.js — 「ホラー作品」「短篇・その他の作品」の一覧を描画する（2026-10-31）
   ・SfCollection.render(el, groups)
     groups: [{ id, label, title, lead, items: [ 作品 ] }]
     作品: { title, kind, date, eps, rank, text, excerpt, image, imagePos, related: [{ label, href }], links: [{ label, href, note }],
             episodes: { base, list: [{ ep, title }] } }   … image：カード上部の画像（サイトのルートからのパス） / episodes：開閉式の各話一覧（base + 話数 + '/' へ直接移動）
   ・opts.root：サイトのルートまでの相対パス（stories/horror/ は '../../'）
   ・opts.showDates：true のときだけ日付を表示（2026-10-31 一覧ページでは日付を出さない方針。データの date は残している）
   ・body.sc-horror のページだけ、カードが画面に入ったときにゆっくり浮かび上がる（動きを減らす設定の環境では出さない）
   ・紹介文は公開先のあらすじ・既存ページの表記から転記する。推測で補わない
   ・外部サイトのリンクは新しいタブで開く
   ============================================================ */
(function (global) {
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function ext(href) { return /^https?:/.test(href) ? ' target="_blank" rel="noopener noreferrer"' : ''; }

  function episodes(e) {
    if (!e || !e.list || !e.list.length) return '';
    return '<details class="sc-eps"><summary>各話一覧（全' + e.list.length + '話）</summary><ol>' + e.list.map(function (x) {
      return '<li><a href="' + esc(e.base + x.ep + '/') + '"' + ext(e.base) + '><span class="sc-ep-no">第' + x.ep + '話</span><span class="sc-ep-title">' + esc(x.title) + '</span><span class="sc-ep-go">→</span></a></li>';
    }).join('') + '</ol></details>';
  }

  function card(w, root, showDates) {
    return '<article class="sc-card' + (w.image ? ' has-img' : '') + '">' +
      (w.image ? '<div class="sc-card-img"><img src="' + esc(root + w.image) + '" alt="' + esc(w.title) + '" loading="lazy"' + (w.imagePos ? ' style="object-position:' + esc(w.imagePos) + '"' : '') + '></div>' : '') +
      '<div class="sc-meta">' + (w.kind ? '<span class="sc-kind">' + esc(w.kind) + '</span>' : '') +
        (showDates && w.date ? '<span>' + esc(w.date) + '</span>' : '') + (w.eps ? '<span>' + esc(w.eps) + '</span>' : '') + '</div>' +
      '<h3 class="sc-title">' + esc(w.title) + '</h3>' +
      (w.rank ? '<span class="sc-rank">' + esc(w.rank) + '</span>' : '') +
      (w.text ? '<p class="sc-text">' + esc(w.text) + '</p>' : '') +
      (w.excerpt ? '<p class="sc-excerpt"><span class="sc-excerpt-label">OPENING</span>' + esc(w.excerpt) + '</p>' : '') +
      (w.related && w.related.length ? '<div class="sc-related"><span class="sc-related-label">RELATED</span>' +
        w.related.map(function (r) { return '<a href="' + esc(r.href) + '"' + ext(r.href) + '>' + esc(r.label) + '</a>'; }).join('') + '</div>' : '') +
      episodes(w.episodes) +
      '<div class="sc-actions">' + (w.links || []).map(function (l) {
        return '<a class="sc-read" href="' + esc(l.href) + '"' + ext(l.href) + '>' + esc(l.label || '読む') + ' →' + (l.note ? '<span class="sc-read-note">' + esc(l.note) + '</span>' : '') + '</a>';
      }).join('') + '</div>' +
      '</article>';
  }

  function render(el, groups, opts) {
    if (!el) return;
    var root = (opts && opts.root) || '';
    var showDates = !!(opts && opts.showDates);
    el.innerHTML = groups.map(function (g) {
      return '<section class="sc-group" id="' + esc(g.id) + '">' +
        '<div class="sc-group-head"><span class="sf-sec-label">' + esc(g.label) + '</span>' +
        '<h2 class="sf-sec-title">' + esc(g.title) + '</h2>' +
        (g.lead ? '<p class="sc-group-lead">' + esc(g.lead) + '</p>' : '') + '</div>' +
        (g.html || '') +
        (g.items && g.items.length ? '<div class="sc-grid">' + g.items.map(function (w) { return card(w, root, showDates); }).join('') + '</div>' : '') +
        '</section>';
    }).join('');
    reveal(el);
  }

  /** ホラー作品ページだけ：カードが画面に入ったら、ゆっくり浮かび上がる（控えめ・1回だけ） */
  function reveal(el) {
    if (!document.body.classList.contains('sc-horror') || !('IntersectionObserver' in window)) return;
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var items = el.querySelectorAll('.sc-card, .sc-feature');
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add('is-shown'); io.unobserve(e.target); } });
    }, { rootMargin: '0px 0px -8% 0px' });
    items.forEach(function (c) { c.classList.add('sc-reveal'); io.observe(c); });
  }

  /** 分類へのジャンプ用チップ */
  function jump(el, groups) {
    if (!el) return;
    el.innerHTML = groups.map(function (g) { return '<a href="#' + esc(g.id) + '">' + esc(g.title) + '</a>'; }).join('');
  }

  global.SfCollection = { render: render, jump: jump };
})(window);
