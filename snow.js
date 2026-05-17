/* Snow flakes — Snow point system
   localStorage-based, no login required.
   Include this script on every page that participates. */

(function(w) {
  'use strict';

  var KEY_BAL = 'sf_snow';
  var KEY_DAY = 'sf_snow_day_';

  // Points per action (daily cap per action)
  var ACTION_PTS = {
    visit_top:       10,
    visit_sweets:    10,
    link_narou_today: 10,
    link_novel:       5,
    link_amazon:      5,
    link_spotify:     5,
    link_instagram:   5,
    link_x:           5,
    link_tiktok:      5,
    link_youtube:     5,
    link_taskapp:        5,
    like_chara_hinata:   5,
    like_chara_kouta:    5,
    like_chara_hayate:   5,
    visit_kotori_room:   5,
  };
  var DAILY_MAX = (function() {
    var s = 0;
    for (var k in ACTION_PTS) s += ACTION_PTS[k];
    return s; // 70
  })();

  function today() { return new Date().toLocaleDateString('ja-JP'); }

  function getBalance() {
    return parseInt(localStorage.getItem(KEY_BAL) || '0', 10);
  }
  function setBalance(n) {
    localStorage.setItem(KEY_BAL, String(Math.max(0, n)));
  }

  function getDone() {
    try { return JSON.parse(localStorage.getItem(KEY_DAY + today()) || '[]'); }
    catch(e) { return []; }
  }
  function isDone(action) { return getDone().indexOf(action) !== -1; }
  function markDone(action) {
    var d = getDone();
    if (d.indexOf(action) === -1) d.push(action);
    localStorage.setItem(KEY_DAY + today(), JSON.stringify(d));
  }

  // Add points for action. Returns points gained (0 if already done today).
  function add(action) {
    if (isDone(action)) return 0;
    var pts = ACTION_PTS[action] || 0;
    if (pts === 0) return 0;
    setBalance(getBalance() + pts);
    markDone(action);
    updateUI();
    return pts;
  }

  // Spend points. Returns true if successful.
  function spend(amount) {
    if (getBalance() < amount) return false;
    setBalance(getBalance() - amount);
    updateUI();
    return true;
  }

  function getDailyEarned() {
    var done = getDone();
    return done.reduce(function(sum, a) {
      return sum + (ACTION_PTS[a] || 0);
    }, 0);
  }
  function getDailyRemaining() {
    return Math.max(0, DAILY_MAX - getDailyEarned());
  }

  // Update all .sf-snow-val elements and detail panel
  function updateUI() {
    var b = getBalance();
    var els = document.querySelectorAll('.sf-snow-val');
    for (var i = 0; i < els.length; i++) els[i].textContent = b;

    var balEl = document.getElementById('sf-snow-balance');
    if (balEl) balEl.textContent = b;
    var remEl = document.getElementById('sf-daily-remaining');
    if (remEl) remEl.textContent = getDailyRemaining();
    var earnEl = document.getElementById('sf-daily-earned');
    if (earnEl) earnEl.textContent = getDailyEarned();
  }

  // Show a floating toast ("+10" style) — stacked, no overlap
  var _activeToasts = [];
  var TOAST_H = 44; // height + gap

  function repositionToasts() {
    var base = 76;
    for (var i = 0; i < _activeToasts.length; i++) {
      _activeToasts[i].style.bottom = (base + i * TOAST_H) + 'px';
    }
  }

  function toast(pts) {
    var t = document.createElement('div');
    t.className = 'sf-toast';
    t.innerHTML = '<span class="sf-toast-flake">❄</span><span class="sf-toast-pts">+' + pts + '</span>';
    document.body.appendChild(t);
    _activeToasts.push(t);
    repositionToasts();

    requestAnimationFrame(function() {
      requestAnimationFrame(function() { t.classList.add('show'); });
    });
    setTimeout(function() {
      t.classList.remove('show');
      setTimeout(function() {
        if (t.parentNode) t.parentNode.removeChild(t);
        var idx = _activeToasts.indexOf(t);
        if (idx !== -1) _activeToasts.splice(idx, 1);
        repositionToasts();
      }, 400);
    }, 2200);
  }

  // Add + show toast
  function addWithToast(action) {
    var pts = add(action);
    if (pts > 0) toast(pts);
    return pts;
  }

  // Inject shared CSS
  (function injectCSS() {
    var s = document.createElement('style');
    s.id = 'sf-snow-style';
    s.textContent = [
      /* Toast */
      '.sf-toast{position:fixed;bottom:76px;right:18px;z-index:10000;',
      'background:rgba(147,197,253,0.22);border:1.5px solid rgba(147,197,253,0.55);',
      'color:#dbeeff;font-family:"Cormorant Garamond",Georgia,serif;',
      'font-size:16px;letter-spacing:4px;padding:10px 22px;border-radius:100px;',
      'backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);',
      'display:flex;align-items:center;gap:8px;',
      'pointer-events:none;opacity:0;transform:translateY(14px) scale(0.92);',
      'transition:opacity 0.3s ease,transform 0.3s ease,bottom 0.25s ease;',
      'box-shadow:0 4px 20px rgba(147,197,253,0.18);}',
      '.sf-toast.show{opacity:1;transform:translateY(0) scale(1);}',
      '.sf-toast-flake{font-size:18px;line-height:1;}',
      '.sf-toast-pts{font-size:17px;font-weight:400;}',
      /* Nav badge */
      '.sf-snow-nav{font-family:"Cormorant Garamond",Georgia,serif;',
      'font-size:12px;letter-spacing:3px;color:#64748b;',
      'display:inline-flex;align-items:center;gap:4px;}',
      '.sf-snow-nav .sf-snow-val{color:#94a3b8;}',
    ].join('');
    document.head.appendChild(s);
  })();

  /* ── Monthly item system ── */
  var KEY_MONTH = 'sf_month_';
  function thisMonth() {
    var d = new Date();
    return d.getFullYear() + '-' + (d.getMonth() + 1);
  }
  function getMonthlyDone() {
    try { return JSON.parse(localStorage.getItem(KEY_MONTH + thisMonth()) || '[]'); }
    catch(e) { return []; }
  }
  function isMonthlyDone(action) { return getMonthlyDone().indexOf(action) !== -1; }
  function markMonthlyDone(action) {
    var d = getMonthlyDone();
    if (d.indexOf(action) === -1) d.push(action);
    localStorage.setItem(KEY_MONTH + thisMonth(), JSON.stringify(d));
  }

  var KEY_MITEMS = 'sf_monthly_items';
  function getMonthlyItems() {
    try { return JSON.parse(localStorage.getItem(KEY_MITEMS) || '{}'); }
    catch(e) { return {}; }
  }
  // Add monthly item (returns count if first time this month, 0 if already got)
  function addMonthlyItem(action, itemId) {
    if (isMonthlyDone(action)) return 0;
    var items = getMonthlyItems();
    items[itemId] = (items[itemId] || 0) + 1;
    localStorage.setItem(KEY_MITEMS, JSON.stringify(items));
    markMonthlyDone(action);
    updateMonthlyItemUI();
    return items[itemId];
  }
  function updateMonthlyItemUI() {
    var items = getMonthlyItems();
    var el = document.getElementById('sf-mitem-proteincoffee');
    if (el) el.textContent = items['proteincoffee'] || 0;
  }

  /* ── Candy system ── */
  var CANDY_TYPES = [
    { id: 'milk',   label: 'ミルクキャンディー',      img: '../item/candy_milk.webp',
      chara: 'hinata', charaLines: ['これ、美味いやつ', '舌の上で溶ける'] },
    { id: 'honey',  label: 'ハニーレモンキャンディー', img: '../item/candy_honey.webp',
      chara: 'kouta',  charaLines: ['甘いけど、嫌いじゃない', 'ひとくちでほどけていく'] },
    { id: 'cassis', label: 'カシスキャンディー',       img: '../item/candy_cassis.webp',
      chara: 'hayate', charaLines: ['好きだな、これ', 'まだ足りない！まだ欲しい！'] },
  ];
  var KEY_CANDY = 'sf_candy';

  function getCandies() {
    try { return JSON.parse(localStorage.getItem(KEY_CANDY) || '{}'); }
    catch(e) { return {}; }
  }
  function addCandy(id) {
    var c = getCandies();
    c[id] = (c[id] || 0) + 1;
    localStorage.setItem(KEY_CANDY, JSON.stringify(c));
    updateCandyUI();
    return c[id];
  }
  // Roll candy: each type has independent 7% chance, returns array of obtained candies
  function rollCandy() {
    var got = [];
    CANDY_TYPES.forEach(function(c) {
      if (Math.random() < 0.07) {
        addCandy(c.id);
        got.push(c);
      }
    });
    return got.length > 0 ? got[0] : null; // 後方互換：最初の1個を返す
  }
  // 全取得分を返すバージョン
  function rollCandyAll() {
    var got = [];
    CANDY_TYPES.forEach(function(c) {
      if (Math.random() < 0.07) {
        addCandy(c.id);
        got.push(c);
      }
    });
    return got;
  }
  function updateCandyUI() {
    var c = getCandies();
    CANDY_TYPES.forEach(function(t) {
      var el = document.getElementById('sf-candy-' + t.id);
      if (el) el.textContent = c[t.id] || 0;
    });
  }

  function updatePickUI() {
    var el = document.getElementById('sf-pick-count');
    if (el) el.textContent = getPicks();
  }

  // Extend updateUI to also refresh candies, monthly items and picks
  var _origUpdateUI = updateUI;
  updateUI = function() { _origUpdateUI(); updateCandyUI(); updateMonthlyItemUI(); updatePickUI(); };

  /* ── Pick system ── */
  var KEY_PICKS = 'sf_picks';
  function getPicks() {
    try { return parseInt(localStorage.getItem(KEY_PICKS) || '0', 10); }
    catch(e) { return 0; }
  }
  function addPick(n) {
    var p = getPicks() + (n || 1);
    localStorage.setItem(KEY_PICKS, String(p));
    return p;
  }
  function spendPick(n) {
    var p = getPicks();
    if (p < n) return false;
    localStorage.setItem(KEY_PICKS, String(p - n));
    return true;
  }

  /* ── Spend / Unlock system ── */
  var KEY_UNLOCKED = 'sf_unlocked';

  function spendCandy(id, amount) {
    var c = getCandies();
    if ((c[id] || 0) < amount) return false;
    c[id] = (c[id] || 0) - amount;
    localStorage.setItem(KEY_CANDY, JSON.stringify(c));
    updateCandyUI();
    return true;
  }

  function spendMonthlyItem(id, amount) {
    var items = getMonthlyItems();
    if ((items[id] || 0) < amount) return false;
    items[id] = items[id] - amount;
    localStorage.setItem(KEY_MITEMS, JSON.stringify(items));
    updateMonthlyItemUI();
    return true;
  }

  function getUnlocked() {
    try { return JSON.parse(localStorage.getItem(KEY_UNLOCKED) || '[]'); }
    catch(e) { return []; }
  }
  function isUnlocked(id) { return getUnlocked().indexOf(id) !== -1; }
  function unlockItem(id) {
    var u = getUnlocked();
    if (u.indexOf(id) === -1) { u.push(id); localStorage.setItem(KEY_UNLOCKED, JSON.stringify(u)); }
  }

  w.SfSnow = {
    getBalance:       getBalance,
    add:              add,
    addWithToast:     addWithToast,
    spend:            spend,
    isDone:           isDone,
    updateUI:         updateUI,
    getDailyEarned:   getDailyEarned,
    getDailyRemaining:getDailyRemaining,
    DAILY_MAX:        DAILY_MAX,
    CANDY_TYPES:        CANDY_TYPES,
    getCandies:         getCandies,
    addCandy:           addCandy,
    rollCandy:          rollCandy,
    rollCandyAll:       rollCandyAll,
    isMonthlyDone:      isMonthlyDone,
    addMonthlyItem:     addMonthlyItem,
    getMonthlyItems:    getMonthlyItems,
    spendCandy:         spendCandy,
    spendMonthlyItem:   spendMonthlyItem,
    isUnlocked:         isUnlocked,
    unlockItem:         unlockItem,
    getPicks:           getPicks,
    addPick:            addPick,
    spendPick:          spendPick,
  };

  document.addEventListener('DOMContentLoaded', updateUI);

})(window);
