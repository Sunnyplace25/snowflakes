/**
 * business-merch-list.js
 * 物販サブタブ「商品一覧」「売却済み」「在庫」の実データ表示
 *
 * business-merch.js の switchMerchSubTab() が呼ぶ
 * window.__jarvisMerchSubTabChanged(name) フックを実装する。
 */
'use strict';

(function () {
  const yen  = v => Number(v || 0).toLocaleString('ja-JP') + '円';
  const dash = v => (v === null || v === undefined || v === '') ? '—' : String(v);
  const esc  = v => String(v ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');

  // ─── データキャッシュ ──────────────────────────────────────────────────────
  let _cache = null;        // 全件データ
  let _loading = false;

  async function fetchAll() {
    if (_cache) return _cache;
    if (_loading) return null;
    _loading = true;
    try {
      const res = await fetch('/api/merch/items');
      const d = await res.json();
      if (!res.ok || !d.ok) throw new Error(d.error || '取得に失敗しました');
      _cache = d.items;
      return _cache;
    } catch (e) {
      _loading = false;
      throw e;
    } finally {
      _loading = false;
    }
  }

  // ─── テーブル描画 ─────────────────────────────────────────────────────────

  const COLS = [
    { label: '種別',     key: r => r.source_type === 'apparel' ? 'アパレル' : 'eBay', align: '' },
    { label: '商品名',   key: r => esc(r.product_name), align: '', wide: true },
    { label: '状態',     key: r => esc(r.status), align: '' },
    { label: '元シート', key: r => esc(r.sheet_name), align: '' },
    { label: '仕入日',   key: r => dash(r.purchase_date), align: '' },
    { label: '売却日',   key: r => dash(r.sale_date), align: '' },
    { label: '仕入値',   key: r => yen(r.purchase_price), align: 'right', minWidth: '100px' },
    { label: '売上',     key: r => r.sale_price ? yen(r.sale_price) : '—', align: 'right', minWidth: '100px' },
    { label: '手数料',   key: r => r.commission ? yen(r.commission) : '—', align: 'right', minWidth: '88px' },
    { label: '送料',     key: r => r.shipping_cost ? yen(r.shipping_cost) : '—', align: 'right', minWidth: '80px' },
    { label: '粗利',
      key: r => yen(r.profit),
      align: 'right',
      minWidth: '100px',
      color: r => r.profit >= 0 ? 'var(--green)' : 'var(--red)',
    },
  ];

  function buildTable(items) {
    if (!items.length) {
      return '<div style="padding:20px;color:var(--text-sec);font-size:13px">データがありません</div>';
    }

    const thead = COLS.map(c => {
      const thStyle = [
        c.align ? `text-align:${c.align}` : '',
        c.minWidth ? `min-width:${c.minWidth}` : '',
      ].filter(Boolean).join(';');
      return `<th style="${thStyle}">${c.label}</th>`;
    }).join('');

    const tbody = items.map(r => {
      const cells = COLS.map(c => {
        const val = c.key(r);
        const color = c.color ? `color:${c.color(r)};` : '';
        const align = c.align ? `text-align:${c.align};` : '';
        const minW = c.minWidth ? `min-width:${c.minWidth};` : '';
        const wrap = c.wide
          ? 'max-width:240px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;'
          : 'white-space:nowrap;';
        return `<td style="${align}${color}${minW}${wrap}">${val}</td>`;
      }).join('');
      return `<tr>${cells}</tr>`;
    }).join('');

    return `<div style="overflow-x:auto">
      <table class="works-table" style="font-size:12px">
        <thead><tr>${thead}</tr></thead>
        <tbody>${tbody}</tbody>
      </table>
    </div>`;
  }

  function buildSummary(items) {
    const total     = items.length;
    const sold      = items.filter(r => r.sale_date).length;
    const sumPurch  = items.reduce((s, r) => s + (r.purchase_price || 0), 0);
    const sumSale   = items.reduce((s, r) => s + (r.sale_price   || 0), 0);
    const sumProfit = items.reduce((s, r) => s + (r.profit        || 0), 0);

    return `<div class="cards-secondary" style="margin:14px 20px 10px">
      <div class="card">
        <div class="card-label">件数</div>
        <div class="card-value">${total.toLocaleString('ja-JP')}件</div>
      </div>
      <div class="card">
        <div class="card-label">仕入総額</div>
        <div class="card-value red">${yen(sumPurch)}</div>
      </div>
      <div class="card">
        <div class="card-label">売上総額</div>
        <div class="card-value green">${yen(sumSale)}</div>
      </div>
      <div class="card">
        <div class="card-label">粗利合計</div>
        <div class="card-value ${sumProfit >= 0 ? 'green' : 'red'}">${yen(sumProfit)}</div>
      </div>
    </div>`;
  }

  async function renderTab(containerId, filter) {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = '<div style="padding:20px;color:var(--text-sec);font-size:13px">読み込み中...</div>';
    try {
      const all = await fetchAll();
      if (!all) return;
      const items = filter ? all.filter(filter) : all;
      el.innerHTML = buildSummary(items) + buildTable(items);
    } catch (e) {
      el.innerHTML = `<div style="padding:20px;color:var(--red);font-size:13px">読み込みエラー: ${esc(e.message)}</div>`;
    }
  }

  // ─── ダッシュボード描画 ───────────────────────────────────────────────────

  const card = (label, value, cls = '') =>
    `<div class="card"><div class="card-label">${label}</div><div class="card-value ${cls}">${value}</div></div>`;

  function calcStats(items) {
    const total   = items.length;
    const sold    = items.filter(r => r.sale_date || r.status === '販売済み');
    const stock   = items.filter(r => !r.sale_date && r.status !== '販売済み');
    const soldN   = sold.length;
    const stockN  = stock.length;
    const sumPurch  = items.reduce((s, r) => s + (r.purchase_price || 0), 0);
    const sumSale   = items.reduce((s, r) => s + (r.sale_price    || 0), 0);
    const sumCom    = items.reduce((s, r) => s + (r.commission    || 0), 0);
    const sumShip   = items.reduce((s, r) => s + (r.shipping_cost || 0), 0);
    const sumProfit = items.reduce((s, r) => s + (r.profit        || 0), 0);
    const avgProfit = soldN > 0
      ? Math.round(sold.reduce((s, r) => s + (r.profit || 0), 0) / soldN) : 0;
    const soldRate  = total > 0 ? (soldN / total * 100).toFixed(1) : '0.0';
    return { total, soldN, stockN, sumPurch, sumSale, sumCom, sumShip, sumProfit, avgProfit, soldRate };
  }

  function buildStatCards(s) {
    return `
      <div class="cards-primary" style="margin-bottom:14px">
        ${card('総商品数', s.total.toLocaleString('ja-JP') + '件')}
        ${card('売却済み', s.soldN.toLocaleString('ja-JP') + '件', 'green')}
        ${card('在庫',     s.stockN.toLocaleString('ja-JP') + '件')}
        ${card('売却率',   s.soldRate + '%', Number(s.soldRate) >= 50 ? 'green' : '')}
      </div>
      <div class="cards-secondary" style="margin-bottom:14px">
        ${card('仕入総額',       yen(s.sumPurch),  'red')}
        ${card('売上総額',       yen(s.sumSale),   'green')}
        ${card('手数料合計',     yen(s.sumCom))}
        ${card('送料合計',       yen(s.sumShip))}
        ${card('粗利合計',       yen(s.sumProfit),  s.sumProfit >= 0 ? 'green' : 'red')}
        ${card('平均粗利（売却済）', yen(s.avgProfit), s.avgProfit >= 0 ? 'green' : 'red')}
      </div>`;
  }

  // purchase_date から年を取得。取れない場合は '__unknown__' を返す
  function itemYear(r) {
    const y = r.purchase_date ? r.purchase_date.slice(0, 4) : null;
    return (y && /^\d{4}$/.test(y)) ? y : '__unknown__';
  }

  function buildDashboard(all) {
    // 仕入日から年一覧を抽出（降順）、年不明は末尾に固定
    const knownYears = [...new Set(
      all.map(itemYear).filter(y => y !== '__unknown__')
    )].sort((a, b) => b - a);

    const hasUnknown = all.some(r => itemYear(r) === '__unknown__');
    const allKeys = hasUnknown ? [...knownYears, '__unknown__'] : knownYears;

    const overall = calcStats(all);

    const yearBtns = allKeys.map(y =>
      `<button class="sf-tab" data-merch-dash-year="${y}" style="font-size:12px;padding:6px 14px">
         ${y === '__unknown__' ? '年不明' : y + '年'}
       </button>`
    ).join('');

    const firstKey   = allKeys[0] || '';
    const firstItems = firstKey
      ? all.filter(r => itemYear(r) === firstKey)
      : [];
    const firstStats = calcStats(firstItems);
    const firstLabel = firstKey === '__unknown__' ? '年不明' : firstKey ? `${firstKey}年` : '';

    return `
      <div style="padding:16px 20px 0">

        <!-- ── 総合 ── -->
        <div style="font-size:13px;font-weight:600;color:var(--text-sec);
                    text-transform:uppercase;letter-spacing:.5px;margin-bottom:10px">
          総合（全${all.length.toLocaleString()}件）
        </div>
        ${buildStatCards(overall)}

        <!-- ── 年度別 ── -->
        <div style="font-size:13px;font-weight:600;color:var(--text-sec);
                    text-transform:uppercase;letter-spacing:.5px;
                    margin-top:6px;margin-bottom:10px">
          年度別
        </div>
        <nav class="sf-tabs" id="merch-dash-year-tabs" style="margin-bottom:14px">
          ${yearBtns}
        </nav>
        <div id="merch-dash-year-stats">
          ${firstKey
            ? `<div style="font-size:12px;color:var(--text-sec);margin-bottom:8px">
                 ${firstLabel} / ${firstItems.length.toLocaleString()}件
               </div>${buildStatCards(firstStats)}`
            : '<div style="color:var(--text-sec);font-size:13px">データなし</div>'}
        </div>

      </div>`;
  }

  function bindYearTabs(all) {
    const nav = document.getElementById('merch-dash-year-tabs');
    if (!nav) return;
    const first = nav.querySelector('[data-merch-dash-year]');
    if (first) first.classList.add('active');

    nav.querySelectorAll('[data-merch-dash-year]').forEach(btn => {
      btn.addEventListener('click', () => {
        nav.querySelectorAll('[data-merch-dash-year]').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const key = btn.dataset.merchDashYear;
        const label = key === '__unknown__' ? '年不明' : `${key}年`;
        const filtered = all.filter(r => itemYear(r) === key);
        const s = calcStats(filtered);
        const el = document.getElementById('merch-dash-year-stats');
        if (el) el.innerHTML = `
          <div style="font-size:12px;color:var(--text-sec);margin-bottom:8px">
            ${label} / ${filtered.length.toLocaleString()}件
          </div>${buildStatCards(s)}`;
      });
    });
  }

  async function renderDashboard() {
    const panel = document.getElementById('merch-subtab-dashboard');
    if (!panel) return;

    let statsEl = document.getElementById('merch-dash-stats');
    if (!statsEl) {
      statsEl = document.createElement('div');
      statsEl.id = 'merch-dash-stats';
      panel.insertBefore(statsEl, panel.firstChild);
    }
    statsEl.innerHTML = '<div style="padding:16px 20px;color:var(--text-sec);font-size:13px">読み込み中...</div>';

    try {
      const all = await fetchAll();
      if (!all) return;
      statsEl.innerHTML = buildDashboard(all);
      bindYearTabs(all);
    } catch (e) {
      statsEl.innerHTML = `<div style="padding:16px 20px;color:var(--red);font-size:13px">読み込みエラー: ${esc(e.message)}</div>`;
    }
  }

  // ─── サブタブ変更フック ────────────────────────────────────────────────────

  const rendered = new Set();   // 一度描画したタブは再fetch不要

  window.__jarvisMerchSubTabChanged = function (name) {
    if (name === 'dashboard' && !rendered.has('dashboard')) {
      rendered.add('dashboard');
      renderDashboard();
    }
    if (name === 'items' && !rendered.has('items')) {
      rendered.add('items');
      renderTab('merch-items-container', null);
    }
    if (name === 'sold' && !rendered.has('sold')) {
      rendered.add('sold');
      renderTab('merch-sold-container', r => r.sale_date || r.status === '販売済み');
    }
    if (name === 'stock' && !rendered.has('stock')) {
      rendered.add('stock');
      renderTab('merch-stock-container', r => !r.sale_date && r.status !== '販売済み');
    }
  };

  // ─── インポート完了後のキャッシュ破棄 ─────────────────────────────────────
  // business-merch-import.js は変更しないため、MutationObserver で
  // #merch-import-status のテキストを監視し「登録完了」を検知したら
  // キャッシュと描画済みフラグをリセットする。
  // #merch-import-status は動的生成されるため、先に要素の追加を待つ。
  (function watchImportStatus() {
    function attachStatusObserver(el) {
      new MutationObserver(() => {
        if (el.textContent.includes('登録完了')) {
          _cache = null;
          rendered.clear();
        }
      }).observe(el, { childList: true, characterData: true, subtree: true });
    }

    const existing = document.getElementById('merch-import-status');
    if (existing) {
      attachStatusObserver(existing);
      return;
    }
    // まだ存在しない場合は document.body への追加を1回だけ待つ
    const bodyObserver = new MutationObserver((_, obs) => {
      const el = document.getElementById('merch-import-status');
      if (!el) return;
      obs.disconnect();
      attachStatusObserver(el);
    });
    bodyObserver.observe(document.body, { childList: true, subtree: true });
  })();

})();
