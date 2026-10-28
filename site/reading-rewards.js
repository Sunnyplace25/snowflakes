/* ─────────────────────────────────────────────────────────────
   読書特典（旧トップの「QF Instagram → ランダムアイテム付与」を新しい作品ページへ移設）
   - 旧トップと同じ保存キー・同じ判定を使うので、獲得履歴をそのまま引き継ぎ、二重には取れない
     ・QF のリンクを押す → sf_qf_insta_pending / sf_qf_insta_left を記録
     ・30秒以上たってから戻る → 1日1回（SfSnow の qf_insta_visit）だけ、3種のどれかを付与
   - 使い方：SfReadingRewards.watchQF(要素の並び)  ※ snow.js を先に読み込む
   ───────────────────────────────────────────────────────────── */
(function (global) {
  'use strict';

  // 旧トップの SF_BANNER_ITEMS と同じ内容
  var ITEMS = [
    { key: 'shiori_kouta',     img: 'item/shiori_kouta.webp',     name: '本のしおり',            desc: '本を買うたびについてくる。\n地味に溜まる。', color: '#fca5a5' },
    { key: 'coaster_hayate',   img: 'item/coaster_hayate.webp',   name: 'STARSの紙製コースター', desc: 'ハヤテの行きつけのバー"STARS"の紙製コースター。\n地味に集めている。', color: '#fde68a' },
    { key: 'drinkcoin_hinata', img: 'item/drinkcoin_hinata.webp', name: 'ドリンクコイン',        desc: 'ライブハウスのやつ。\n引き換え忘れて、いつの間にか溜まっていく。', color: '#93c5fd' }
  ];
  var PENDING = 'sf_qf_insta_pending', LEFT = 'sf_qf_insta_left', ACTION = 'qf_insta_visit';
  var MIN_AWAY = 30000;
  var root = (document.currentScript && document.currentScript.getAttribute('data-root')) || '';

  function injectCss() {
    if (document.getElementById('sfrr-css')) return;
    var s = document.createElement('style'); s.id = 'sfrr-css';
    s.textContent =
      '.sfrr-back{position:fixed;inset:0;z-index:2000;background:rgba(8,13,24,.85);backdrop-filter:blur(12px);display:flex;align-items:center;justify-content:center;padding:20px}' +
      '.sfrr-card{background:rgba(13,21,38,.99);border:1px solid rgba(255,255,255,.08);border-radius:20px;padding:32px 24px 24px;max-width:300px;width:100%;text-align:center;color:#e2e8f0}' +
      '.sfrr-eyebrow{font-family:"Cormorant Garamond",serif;font-size:11px;letter-spacing:4px;color:#94a3b8;margin:0 0 14px}' +
      '.sfrr-card img{width:120px;height:120px;object-fit:contain;display:block;margin:0 auto 14px}' +
      '.sfrr-name{font-family:"Noto Serif JP",serif;font-size:15px;margin:0 0 10px}' +
      '.sfrr-desc{font-family:"Noto Serif JP",serif;font-size:12px;line-height:1.9;color:#94a3b8;white-space:pre-line;margin:0 0 20px}' +
      '.sfrr-ok{background:none;border:1px solid rgba(255,255,255,.2);border-radius:100px;color:#e2e8f0;padding:9px 28px;font-size:12px;letter-spacing:2px;cursor:pointer}' +
      '.sfrr-ok:focus-visible{outline:2px solid #93c5fd;outline-offset:3px}';
    document.head.appendChild(s);
  }

  function showPopup(item) {
    injectCss();
    var prev = document.activeElement;
    var back = document.createElement('div'); back.className = 'sfrr-back';
    var card = document.createElement('div'); card.className = 'sfrr-card';
    card.setAttribute('role', 'dialog'); card.setAttribute('aria-modal', 'true'); card.setAttribute('aria-labelledby', 'sfrr-name');
    var eyebrow = document.createElement('p'); eyebrow.className = 'sfrr-eyebrow'; eyebrow.textContent = 'ITEM GET';
    var img = document.createElement('img'); img.src = root + item.img; img.alt = '';
    var name = document.createElement('p'); name.className = 'sfrr-name'; name.id = 'sfrr-name'; name.textContent = item.name; name.style.color = item.color;
    var desc = document.createElement('p'); desc.className = 'sfrr-desc'; desc.textContent = item.desc;
    var ok = document.createElement('button'); ok.type = 'button'; ok.className = 'sfrr-ok'; ok.textContent = 'OK';
    [eyebrow, img, name, desc, ok].forEach(function (n) { card.appendChild(n); });
    back.appendChild(card); document.body.appendChild(back);
    function close() { document.removeEventListener('keydown', onKey); back.remove(); if (prev && prev.focus) prev.focus(); }
    function onKey(e) { if (e.key === 'Escape' || e.key === 'Tab') { e.preventDefault(); if (e.key === 'Escape') close(); } }
    ok.addEventListener('click', close);
    back.addEventListener('click', function (e) { if (e.target === back) close(); });
    document.addEventListener('keydown', onKey);
    ok.focus();
  }

  // 戻ってきたときの付与（旧トップと同じ判定）
  function onReturn() {
    if (document.visibilityState !== 'visible') return;
    if (!localStorage.getItem(PENDING)) return;
    localStorage.removeItem(PENDING);
    var leftAt = parseInt(localStorage.getItem(LEFT) || '0', 10);
    localStorage.removeItem(LEFT);
    if (Date.now() - leftAt < MIN_AWAY) return;
    setTimeout(function () {
      if (typeof SfSnow === 'undefined') return;
      if (SfSnow.isNDaysDone(ACTION, 1)) return;
      var item = ITEMS[Math.floor(Math.random() * ITEMS.length)];
      SfSnow.unlockItem(item.key);
      SfSnow.addMItemDirect(item.key, 1);
      SfSnow.markNDaysDone(ACTION);
      showPopup(item);
    }, 600);
  }

  function watchQF(links) {
    Array.prototype.forEach.call(links, function (a) {
      a.addEventListener('click', function () {
        localStorage.setItem(PENDING, '1');
        localStorage.setItem(LEFT, Date.now().toString());
      });
    });
  }

  document.addEventListener('visibilitychange', onReturn);
  global.SfReadingRewards = { ITEMS: ITEMS, watchQF: watchQF, showPopup: showPopup };
})(window);
