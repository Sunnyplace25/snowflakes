/* ============================================================
   site/site-footer.js — 新しいページ共通のフッターリンク（.sf-footer-links に入れる）
   読み込み：<script src="（ルート）/site/site-footer.js" data-root="（ルートまでの相対パス）"></script>
   SHOP は site-data.js の shop.visible が true のときだけ出す
   ============================================================ */
(function () {
  var me = document.currentScript, root = (me && me.getAttribute('data-root')) || '';
  var shop = window.SF_SITE && window.SF_SITE.shop && window.SF_SITE.shop.visible && (window.SF_SITE.shop.items || []).some(function (i) { return i.status === 'public'; });
  var links = [['HOME', ''], ['STORIES', 'stories/'], ['MUSIC', 'music.html'], ['GAME', 'game/'], ['VIDEO', 'video/'], ['ABOUT', 'about/'],
    ['SUPPORT', 'support-lp.html']].concat(shop ? [['SHOP', 'shop/']] : []).concat([['制作理念・AI技術の活用について', 'creative-process/']]);
  function fill() {
    document.querySelectorAll('.sf-footer-links').forEach(function (el) {
      el.innerHTML = links.map(function (l) { return '<a href="' + root + l[1] + '">' + l[0] + '</a>'; }).join('');
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fill); else fill();
})();
