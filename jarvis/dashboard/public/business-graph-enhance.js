'use strict';

/**
 * business-graph-enhance.js
 * 月別収入積み上げ棒グラフ（カテゴリ別）
 *
 * データソース：
 *   - /api/works/category-monthly?year=YYYY  … work_records を月×カテゴリ集計
 *   - /api/nursery-payslips                  … 保育園給与明細（パート）
 *
 * 表示ルール：
 *   - データが存在するカテゴリのみ凡例・積み上げに表示
 *   - ダミーデータなし
 *   - 描画は 1 系統のみ（二重描画禁止）
 */

(function () {
  // ── カテゴリ定義（work_records.category → 表示ラベル・色）──────────────────
  // 順序は積み上げ順
  const CAT_DEF = [
    { key: '音声仕事',    label: '音声',        color: '#3b82f6' },
    { key: '物販',        label: '物販',        color: '#a855f7' },
    { key: '17配信',      label: '配信',        color: '#f59e0b' },
    { key: 'Snow flakes', label: 'Snow flakes', color: '#ec4899' },
    { key: 'その他',      label: 'その他',      color: '#6b7280' },
    // パート（保育園給与明細）は別テーブルなので key = '__nursery__' で管理
    { key: '__nursery__', label: 'パート',       color: '#22c55e' },
  ];

  const CAT_BY_KEY = Object.fromEntries(CAT_DEF.map(c => [c.key, c]));
  const yen = n => Number(n || 0).toLocaleString('ja-JP') + '円';
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  let cachedYear = null;
  let cachedRows = null;   // 配列[0..11] — 各月のカテゴリ別収入
  let cachedKeys = null;   // データが存在するカテゴリキーの配列

  // ── データ取得 ──────────────────────────────────────────────────────────────

  async function fetchCategoryMonthly(year) {
    const r = await fetch(`/api/works/category-monthly?year=${year}`);
    const d = await r.json();
    return d.ok ? (d.rows || []) : [];
  }

  async function fetchNursery() {
    const r = await fetch('/api/nursery-payslips');
    const d = await r.json();
    return d.ok ? (d.payslips || []) : [];
  }

  async function buildRows(year) {
    if (cachedYear === year && cachedRows) return { rows: cachedRows, keys: cachedKeys };

    const [catRows, payslips] = await Promise.all([
      fetchCategoryMonthly(year),
      fetchNursery(),
    ]);

    // 月×カテゴリ マップを構築
    const byMonth = new Map();
    for (let i = 1; i <= 12; i++) {
      const ym = `${year}-${String(i).padStart(2, '0')}`;
      byMonth.set(ym, {});
    }
    catRows.forEach(r => {
      const m = byMonth.get(r.month);
      if (m) m[r.category] = Number(r.income || 0);
    });

    // 保育園給与を __nursery__ として追加
    payslips
      .filter(p => String(p.month || '').startsWith(`${year}-`))
      .forEach(p => {
        const m = byMonth.get(String(p.month));
        if (m) m['__nursery__'] = Number(p.gross_pay || 0);
      });

    // rows[0..11] に変換
    const rows = Array.from({ length: 12 }, (_, i) => {
      const ym = `${year}-${String(i + 1).padStart(2, '0')}`;
      const cats = byMonth.get(ym) || {};
      const total = Object.values(cats).reduce((s, v) => s + v, 0);
      return { month: i + 1, ym, cats, total };
    });

    // データが存在するカテゴリキーを CAT_DEF の順序で取得
    const existingKeys = new Set(rows.flatMap(r => Object.keys(r.cats).filter(k => r.cats[k] > 0)));
    const keys = CAT_DEF.map(c => c.key).filter(k => existingKeys.has(k));

    cachedYear = year;
    cachedRows = rows;
    cachedKeys = keys;
    return { rows, keys };
  }

  // ── UI セットアップ ─────────────────────────────────────────────────────────

  function ensureUi(keys) {
    const svg = document.getElementById('monthly-chart');
    const panel = svg?.closest('.panel');
    if (!svg || !panel) return false;

    // パネルタイトル・説明を更新
    const h2 = panel.querySelector('h2');
    const note = panel.querySelector('.note');
    if (h2) h2.textContent = '月別収入（カテゴリ別積み上げ）';
    if (note) note.textContent = 'work_records の収入をカテゴリ別に積み上げて表示。データが存在するカテゴリのみ表示します。棒をクリックすると内訳を表示します。';

    // モード切替ボタンは不要なので既存のものを削除
    const oldControls = document.getElementById('income-chart-controls');
    if (oldControls) oldControls.remove();

    // 凡例（データが存在するカテゴリのみ）
    const legendId = 'income-chart-legend';
    let legend = document.getElementById(legendId);
    if (!legend) {
      legend = document.createElement('div');
      legend.id = legendId;
      legend.className = 'legend';
      const wrap = panel.querySelector('.chart-wrap');
      if (wrap) panel.insertBefore(legend, wrap);
    }
    legend.innerHTML = keys.map(k => {
      const def = CAT_BY_KEY[k];
      if (!def) return '';
      return `<span><i class="key" style="background:${def.color};display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:5px;"></i>${esc(def.label)}</span>`;
    }).join('');

    // 詳細パネル
    let detail = document.getElementById('income-chart-detail');
    if (!detail) {
      detail = document.createElement('div');
      detail.id = 'income-chart-detail';
      detail.style.cssText = 'margin-top:14px;padding:14px;border:1px solid #30363d;border-radius:8px;background:#0d1117;display:none';
      panel.appendChild(detail);
    }

    // スタイル
    if (!document.getElementById('income-chart-enhance-style')) {
      const style = document.createElement('style');
      style.id = 'income-chart-enhance-style';
      style.textContent = `
        #monthly-chart .income-segment{cursor:pointer;transition:opacity .15s}
        #monthly-chart .income-segment:hover{opacity:.78}
        #income-chart-detail .detail-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:10px;margin-bottom:12px}
        #income-chart-detail .detail-card{background:#161b22;border:1px solid #30363d;border-radius:7px;padding:10px}
        #income-chart-detail .detail-label{color:#8b949e;font-size:11px;margin-bottom:4px}
        #income-chart-detail .detail-value{font-weight:700}
        @media(max-width:760px){#income-chart-detail .detail-grid{grid-template-columns:1fr 1fr}}
      `;
      document.head.appendChild(style);
    }

    return true;
  }

  // ── SVG 描画 ─────────────────────────────────────────────────────────────────

  async function render() {
    const year = Number(document.getElementById('year')?.value || new Date().getFullYear());
    const { rows, keys } = await buildRows(year);
    const svg = document.getElementById('monthly-chart');
    if (!svg) return;
    if (!ensureUi(keys)) return;

    const W = 1000, H = 330, L = 62, R = 18, T = 18, B = 42;
    const plotW = W - L - R, plotH = H - T - B;
    const maxVal = Math.max(1, ...rows.map(r => r.total));
    const unit = maxVal <= 100000 ? 10000 : 50000;
    const nice = Math.ceil(maxVal / unit) * unit || unit;
    const yPos = v => T + plotH - (Math.max(0, v) / nice) * plotH;
    const step = plotW / 12;
    const bw = Math.min(44, step * 0.56);

    let s = '';

    // グリッド + Y 軸ラベル
    for (let i = 0; i <= 4; i++) {
      const val = nice * i / 4;
      const yy = yPos(val);
      s += `<line class="gridline" x1="${L}" y1="${yy}" x2="${W - R}" y2="${yy}"/>`;
      s += `<text class="axis-label" x="${L - 8}" y="${yy + 4}" text-anchor="end">${Math.round(val / 10000)}万</text>`;
    }

    // 各月の積み上げ棒
    rows.forEach((row, i) => {
      const cx = L + step * (i + 0.5);
      const x = cx - bw / 2;
      let base = 0;
      for (const key of keys) {
        const val = Number(row.cats[key] || 0);
        if (!val) continue;
        const def = CAT_BY_KEY[key];
        const yTop = yPos(base + val);
        const yBot = yPos(base);
        const h = Math.max(1, yBot - yTop);
        s += `<rect class="income-segment" data-month="${i}" data-key="${esc(key)}" x="${x.toFixed(1)}" y="${yTop.toFixed(1)}" width="${bw.toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${def.color}"><title>${row.month}月 ${esc(def.label)} ${yen(val)}</title></rect>`;
        base += val;
      }
      // 合計ラベル（棒の上）
      if (row.total > 0) {
        const labelY = yPos(row.total) - 4;
        s += `<text class="axis-label" x="${cx.toFixed(1)}" y="${labelY.toFixed(1)}" text-anchor="middle" font-size="9">${Math.round(row.total / 10000)}万</text>`;
      }
      // X 軸月ラベル
      s += `<text class="axis-label" x="${cx.toFixed(1)}" y="${H - 18}" text-anchor="middle">${row.month}月</text>`;
    });

    svg.innerHTML = s;

    // クリックで詳細表示
    svg.querySelectorAll('.income-segment').forEach(rect => {
      rect.addEventListener('click', () => showDetail(rows[Number(rect.dataset.month)], keys));
    });
  }

  // ── 月別内訳パネル ──────────────────────────────────────────────────────────

  function showDetail(row, keys) {
    const el = document.getElementById('income-chart-detail');
    if (!el) return;
    el.style.display = '';

    const cards = [
      `<div class="detail-card"><div class="detail-label">合計</div><div class="detail-value">${yen(row.total)}</div></div>`,
      ...keys.filter(k => row.cats[k] > 0).map(k => {
        const def = CAT_BY_KEY[k];
        return `<div class="detail-card"><div class="detail-label">${esc(def.label)}</div><div class="detail-value" style="color:${def.color}">${yen(row.cats[k])}</div></div>`;
      }),
    ].join('');

    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:10px">
        <strong>${row.month}月の内訳</strong>
        <span style="color:#8b949e;font-size:12px">${row.ym}</span>
      </div>
      <div class="detail-grid">${cards}</div>
      ${row.total === 0 ? '<div style="color:#8b949e">この月の収入データはありません。</div>' : ''}
    `;
  }

  // ── 初期化 ──────────────────────────────────────────────────────────────────

  function invalidateAndRender() {
    cachedYear = null;
    cachedRows = null;
    cachedKeys = null;
    render();
  }

  function init() {
    const svg = document.getElementById('monthly-chart');
    const panel = svg?.closest('.panel');
    if (!svg || !panel) {
      setTimeout(init, 250);
      return;
    }
    document.getElementById('year')?.addEventListener('change', invalidateAndRender);
    document.getElementById('reload')?.addEventListener('click', invalidateAndRender);
    render();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
