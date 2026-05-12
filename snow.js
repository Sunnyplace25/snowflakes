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
    link_taskapp:     5,
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

  // Show a floating toast ("+10" style)
  function toast(pts) {
    var t = document.createElement('div');
    t.className = 'sf-toast';
    t.textContent = '❄ +' + pts;
    document.body.appendChild(t);
    requestAnimationFrame(function() {
      requestAnimationFrame(function() { t.classList.add('show'); });
    });
    setTimeout(function() {
      t.classList.remove('show');
      setTimeout(function() { if (t.parentNode) t.parentNode.removeChild(t); }, 400);
    }, 1800);
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
      'background:rgba(147,197,253,0.12);border:1px solid rgba(147,197,253,0.35);',
      'color:#93c5fd;font-family:"Cormorant Garamond",Georgia,serif;',
      'font-size:13px;letter-spacing:3px;padding:7px 16px;border-radius:100px;',
      'pointer-events:none;opacity:0;transform:translateY(8px);',
      'transition:opacity 0.35s ease,transform 0.35s ease;}',
      '.sf-toast.show{opacity:1;transform:translateY(0);}',
      /* Nav badge */
      '.sf-snow-nav{font-family:"Cormorant Garamond",Georgia,serif;',
      'font-size:12px;letter-spacing:3px;color:#64748b;',
      'display:inline-flex;align-items:center;gap:4px;}',
      '.sf-snow-nav .sf-snow-val{color:#94a3b8;}',
    ].join('');
    document.head.appendChild(s);
  })();

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
  };

  document.addEventListener('DOMContentLoaded', updateUI);

})(window);
