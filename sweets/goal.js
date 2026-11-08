/* 次に解放したいもの：EXCHANGE_CATALOG から目標を1つ選ぶと、必要数・持っている数・あと何個かを出す。
   選んだ目標はこの端末にだけ保存（sf_sweets_goal）。交換そのものは今までどおり各欄で行う。 */
(function () {
  var el = document.getElementById('sw-goal');
  if (!el || typeof EXCHANGE_CATALOG === 'undefined' || !window.SfSnow) return;
  var KEY = 'sf_sweets_goal';
  var CUR = {
    pick:          { name: 'ギターピック',       img: '../item/pick.webp' },
    milk:          { name: 'ミルクキャンディー', img: '../item/candy_milk.webp' },
    honey:         { name: 'ハニーキャンディー', img: '../item/candy_honey.webp' },
    cassis:        { name: 'カシスキャンディー', img: '../item/candy_cassis.webp' },
    proteincoffee: { name: 'プロテインコーヒー', img: '../item/proteincoffee.webp' }
  };
  var TYPE = { room: '部屋', song: '曲', note: 'NOTE', story: 'ストーリー', webapp: 'アプリ' };
  var esc = function (s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return '&#' + c.charCodeAt(0) + ';'; }); };
  var store = {
    get: function () { try { return localStorage.getItem(KEY) || ''; } catch (e) { return ''; } },
    set: function (v) { try { v ? localStorage.setItem(KEY, v) : localStorage.removeItem(KEY); } catch (e) {} }
  };

  // 必要なもの → [{ key, need, have }]
  function needs(item) {
    var c = item.cost || {}, out = [];
    if (c.pick) out.push({ key: 'pick', need: c.pick, have: SfSnow.getPicks() || 0 });
    if (c.candy) out.push({ key: c.candy, need: c.amount, have: (SfSnow.getCandies()[c.candy] || 0) });
    if (c.item) out.push({ key: c.item, need: c.amount, have: (SfSnow.getMonthlyItems()[c.item] || 0) });
    return out;
  }
  function locked() {
    return EXCHANGE_CATALOG.filter(function (i) { return i.cost && !SfSnow.isUnlocked(i.id); });
  }

  function render() {
    var list = locked();
    if (!list.length) { el.hidden = true; return; }
    el.hidden = false;
    var id = store.get(), item = list.filter(function (i) { return i.id === id; })[0];
    var html = '<p class="goal-label">NEXT GOAL</p><p class="goal-title">次に解放したいもの</p>';
    if (!item) {
      html += '<p class="goal-lead">目標を1つ選ぶと、あと何個で交換できるかが分かります。</p>';
    } else {
      var ns = needs(item), ready = ns.every(function (n) { return n.have >= n.need; });
      html += '<p class="goal-name"><span class="goal-type">' + esc(TYPE[item.type] || '') + '</span>' + esc(item.title) + '</p><div class="goal-needs">';
      ns.forEach(function (n) {
        var cur = CUR[n.key] || { name: n.key, img: '' }, left = Math.max(0, n.need - n.have);
        var pct = Math.min(100, Math.round(n.have / n.need * 100));
        html += '<div class="goal-need">' + (cur.img ? '<img src="' + cur.img + '" alt="">' : '') +
          '<div class="goal-need-body"><p>' + esc(cur.name) + '　<b>' + Math.min(n.have, n.need) + ' / ' + n.need + '</b></p>' +
          '<div class="goal-bar"><span style="width:' + pct + '%"></span></div>' +
          '<p class="goal-left">' + (left ? 'あと ' + left + ' 個' : 'そろいました') + '</p></div></div>';
      });
      html += '</div>' + (ready ? '<p class="goal-ready">交換できます。下の欄から解放してください。</p>' : '');
    }
    html += '<select class="goal-select" aria-label="目標を選ぶ"><option value="">' + (item ? '目標を変える' : '目標を選ぶ') + '</option>' +
      list.map(function (i) { return '<option value="' + esc(i.id) + '"' + (item && i.id === item.id ? ' selected' : '') + '>' + esc((TYPE[i.type] ? TYPE[i.type] + '｜' : '') + i.title) + '</option>'; }).join('') +
      '</select>' + (item ? '<button class="goal-clear" type="button">目標をはずす</button>' : '');
    el.innerHTML = html;
    el.querySelector('.goal-select').onchange = function () { if (this.value) { store.set(this.value); render(); } };
    var clr = el.querySelector('.goal-clear');
    if (clr) clr.onclick = function () { store.set(''); render(); };
  }
  render();
  // 交換やキャンディ入手のあとに数を合わせる（ページに戻ってきたとき・他の欄を操作したとき）
  document.addEventListener('visibilitychange', function () { if (!document.hidden) render(); });
  document.addEventListener('click', function (e) { if (!el.contains(e.target)) setTimeout(render, 300); });
})();
