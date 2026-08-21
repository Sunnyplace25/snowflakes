/* Snow flakes — Snow point system
   localStorage-based, no login required.
   Include this script on every page that participates. */

(function(w) {
  'use strict';

  var KEY_BAL = 'sf_snow';
  var KEY_DAY = 'sf_snow_day_';

  // Points per action (daily cap per action)
  var ACTION_PTS = {
    oita_oto_daily:  5,
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
    share_site:          10,
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

  function toast(pts, label) {
    var t = document.createElement('div');
    t.className = 'sf-toast';
    var inner = label
      ? '<span class="sf-toast-label">' + label + '</span><span class="sf-toast-flake">❄</span><span class="sf-toast-pts">+' + pts + '</span>'
      : '<span class="sf-toast-flake">❄</span><span class="sf-toast-pts">+' + pts + '</span>';
    t.innerHTML = inner;
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
  function addWithToast(action, label) {
    var pts = add(action);
    if (pts > 0) toast(pts, label);
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
      '.sf-toast-label{font-size:11px;letter-spacing:2px;color:#93c5fd;opacity:0.8;margin-right:4px;}',
      /* Nav badge */
      '.sf-snow-nav{font-family:"Cormorant Garamond",Georgia,serif;',
      'font-size:12px;letter-spacing:3px;color:#64748b;',
      'display:inline-flex;align-items:center;gap:4px;}',
      '.sf-snow-nav .sf-snow-val{color:#94a3b8;}',
    ].join('');
    document.head.appendChild(s);
  })();

  // Under tone 短篇バナー: 2026-08-20 23:00〜08-31 は常時表示
  (function forceUndertoneStoryBanner() {
    var start = new Date('2026-08-20T23:00:00+09:00');
    var end   = new Date('2026-08-31T23:59:59+09:00');
    var now   = new Date();
    if (now < start || now > end) return;
    localStorage.removeItem('sf_undertone_story_v1_seen');
    var s = document.createElement('style');
    s.id = 'sf-ut-story-force-visible';
    s.textContent = '#banner-ut-story{display:block!important;}';
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
  // N日間隔クールダウン
  var KEY_NDAY = 'sf_nday_';
  function isNDaysDone(action, n) {
    var last = parseInt(localStorage.getItem(KEY_NDAY + action) || '0', 10);
    return last > 0 && (Date.now() - last) < n * 86400000;
  }
  function markNDaysDone(action) {
    localStorage.setItem(KEY_NDAY + action, String(Date.now()));
  }
  function addNDaysItem(action, itemId, n) {
    if (isNDaysDone(action, n)) return 0;
    var items = getMonthlyItems();
    items[itemId] = (items[itemId] || 0) + 1;
    localStorage.setItem(KEY_MITEMS, JSON.stringify(items));
    markNDaysDone(action);
    updateMonthlyItemUI();
    return items[itemId];
  }

  // Add monthly item directly without monthly-action restriction (for gacha drops etc.)
  function addMItemDirect(itemId, count) {
    var items = getMonthlyItems();
    items[itemId] = (items[itemId] || 0) + (count || 1);
    localStorage.setItem(KEY_MITEMS, JSON.stringify(items));
    updateMonthlyItemUI();
  }
  function updateMonthlyItemUI() {
    var items = getMonthlyItems();
    var el = document.getElementById('sf-mitem-proteincoffee');
    if (el) el.textContent = items['proteincoffee'] || 0;
    var elL = document.getElementById('sf-mitem-loupe');
    if (elL) elL.textContent = items['loupe'] || 0;
    if (typeof renderItemRows === 'function') renderItemRows();
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

  // 直接加算（回数制限なし）
  function addDirect(amount, label) {
    setBalance(getBalance() + amount);
    updateUI();
    if (label) toast(amount, label);
    return amount;
  }

  // 初回のみポイント付与（unlockItemをフラグとして使用）
  function addOnce(key, amount, label) {
    if (isUnlocked(key)) return 0;
    unlockItem(key);
    setBalance(getBalance() + amount);
    updateUI();
    toast(amount, label);
    return amount;
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
    isNDaysDone:        isNDaysDone,
    markNDaysDone:      markNDaysDone,
    addNDaysItem:       addNDaysItem,
    addMItemDirect:     addMItemDirect,
    getMonthlyItems:    getMonthlyItems,
    spendCandy:         spendCandy,
    spendMonthlyItem:   spendMonthlyItem,
    isUnlocked:         isUnlocked,
    unlockItem:         unlockItem,
    addDirect:          addDirect,
    addOnce:            addOnce,
    getPicks:           getPicks,
    addPick:            addPick,
    spendPick:          spendPick,
  };

  document.addEventListener('DOMContentLoaded', updateUI);

  /* ── Character room extra profile fields ── */
  document.addEventListener('DOMContentLoaded', function() {
    var path = location.pathname;
    var cfg = null;

    if (path.indexOf('/room/hayate/') !== -1) {
      cfg = {
        saveKey: 'sf_pf_hayate_v2',
        candy: 'cassis',
        candyLabel: 'カシスキャンディー',
        candyImg: '../../item/candy_cassis.webp',
        fields: [
          { id: 'pf-sports', label: 'SPORTS', val: 'サッカー' },
          { id: 'pf-item',   label: 'ITEM',   val: 'Grand Seiko SBGM221' },
          { id: 'pf-skill',  label: 'SKILL',  val: '英会話 / 人の顔と名前を覚える' },
          { id: 'pf-music',  label: 'MUSIC',  val: 'Reggae / Rock / Pop' },
          { id: 'pf-weak',   label: 'WEAK',   val: '虫 / お化け屋敷' },
          { id: 'pf-drink',  label: 'DRINK',  val: '炭酸飲料' },
        ],
      };
    } else if (path.indexOf('/room/kouta/') !== -1) {
      cfg = {
        saveKey: 'sf_pf_kouta_v2',
        candy: 'honey',
        candyLabel: 'ハニーレモンキャンディー',
        candyImg: '../../item/candy_honey.webp',
        fields: [
          { id: 'pf-sports', label: 'SPORTS', val: 'ゴルフ' },
          { id: 'pf-item',   label: 'ITEM',   val: 'SONY IER-M7' },
          { id: 'pf-skill',  label: 'SKILL',  val: '文章を書く / 人の変化によく気づく' },
          { id: 'pf-music',  label: 'MUSIC',  val: 'Alternative / Jazz' },
          { id: 'pf-weak',   label: 'WEAK',   val: '辛いもの / 熱い食べ物' },
          { id: 'pf-drink',  label: 'DRINK',  val: 'ミルクティー' },
        ],
      };
    } else if (path.indexOf('/room/hinata/') !== -1) {
      cfg = {
        saveKey: 'sf_pf_hinata_v2',
        candy: 'milk',
        candyLabel: 'ミルクキャンディー',
        candyImg: '../../item/candy_milk.webp',
        fields: [
          { id: 'pf-sports', label: 'SPORTS', val: 'スキー' },
          { id: 'pf-item',   label: 'ITEM',   val: 'VOLVO V60（Black）' },
          { id: 'pf-skill',  label: 'SKILL',  val: '勘が鋭い / 音の違和感に気づく' },
          { id: 'pf-music',  label: 'MUSIC',  val: 'Folk / Indie Rock' },
          { id: 'pf-weak',   label: 'WEAK',   val: '高いところ / 注射' },
          { id: 'pf-drink',  label: 'DRINK',  val: 'ブラックコーヒー' },
        ],
      };
    }

    if (!cfg) return;
    var list = document.querySelector('.detail-list');
    if (!list || document.getElementById('pf-sports')) return;

    var saved = [];
    try { saved = JSON.parse(localStorage.getItem(cfg.saveKey) || '[]'); } catch(e) {}

    var smokeRow = null;
    var rows = list.querySelectorAll('.detail-row');
    for (var r = 0; r < rows.length; r++) {
      var key = rows[r].querySelector('.detail-key');
      if (key && key.textContent.trim() === 'SMOKE') {
        smokeRow = rows[r];
        break;
      }
    }

    function saveUnlocked(id) {
      if (saved.indexOf(id) === -1) {
        saved.push(id);
        localStorage.setItem(cfg.saveKey, JSON.stringify(saved));
      }
    }

    function refreshExtraButtons() {
      var candies = getCandies();
      var ready = (candies[cfg.candy] || 0) >= 10;
      cfg.fields.forEach(function(field) {
        if (saved.indexOf(field.id) !== -1) return;
        var el = document.getElementById(field.id);
        if (!el) return;
        var btn = el.querySelector('.unlock-btn');
        if (!btn) return;
        btn.classList.toggle('ready', ready);
      });
    }

    function reveal(field) {
      var el = document.getElementById(field.id);
      if (el) el.textContent = field.val;
    }

    cfg.fields.forEach(function(field) {
      var row = document.createElement('div');
      row.className = 'detail-row';

      var key = document.createElement('p');
      key.className = 'detail-key';
      key.textContent = field.label;

      var val = document.createElement('p');
      val.className = 'detail-val';
      val.id = field.id;

      if (saved.indexOf(field.id) !== -1) {
        val.textContent = field.val;
      } else {
        var btn = document.createElement('button');
        btn.className = 'unlock-btn';
        btn.innerHTML = '<img src="' + cfg.candyImg + '" class="candy-ic">' + cfg.candyLabel + ' × 10';
        btn.addEventListener('click', function() {
          var candies = getCandies();
          if ((candies[cfg.candy] || 0) < 10) {
            if (typeof w.showAlert === 'function') w.showAlert(cfg.candyLabel + 'が足りません');
            return;
          }

          var doUnlock = function() {
            if (!spendCandy(cfg.candy, 10)) {
              if (typeof w.showAlert === 'function') w.showAlert(cfg.candyLabel + 'が足りません');
              return;
            }
            saveUnlocked(field.id);
            reveal(field);
            refreshExtraButtons();
          };

          if (typeof w.showDialog === 'function') {
            w.showDialog(cfg.candyLabel + ' × 10', doUnlock);
          } else {
            doUnlock();
          }
        });
        val.appendChild(btn);
      }

      row.appendChild(key);
      row.appendChild(val);
      list.insertBefore(row, smokeRow);
    });

    refreshExtraButtons();
  });

  /* ── GA4 自動リンクトラッキング ── */
  document.addEventListener('click', function(e) {
    var a = e.target.closest('a[href]');
    if (!a) return;
    var href = a.href || '';
    var ev = null;
    if (/amzn\.asia|amazon\.co\.jp/i.test(href))          ev = 'click_kindle';
    else if (/ncode\.syosetu|syosetu\.com/i.test(href))   ev = 'click_novel';
    else if (/open\.spotify\.com/i.test(href))            ev = 'click_spotify';
    else if (/instagram\.com/i.test(href))                ev = 'click_instagram';
    else if (/youtube\.com|music\.youtube/i.test(href))   ev = 'click_youtube';
    else if (/twitter\.com|x\.com/i.test(href))          ev = 'click_x';
    else if (/suno\.com/i.test(href))                     ev = 'click_suno';
    else if (/\/sweets\//i.test(href))                    ev = 'enter_sweets';
    else if (/\/undertone\//i.test(href))                 ev = 'enter_undertone';
    if (ev && typeof gtag === 'function') {
      gtag('event', ev, { link_url: href });
    }
  });

})(window);