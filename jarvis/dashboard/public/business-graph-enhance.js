'use strict';

(function () {
  const MODES = [
    { key:'total', label:'合計' },
    { key:'audio', label:'音声' },
    { key:'nursery', label:'パート' },
    { key:'merch', label:'物販' },
  ];
  const COLORS = { audio:'#3b82f6', nursery:'#22c55e', merch:'#a855f7' };
  let mode = 'total';
  let cachedYear = null;
  let cachedRows = null;

  const yen = n => Number(n || 0).toLocaleString('ja-JP') + '円';
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  async function getMonth(year, month) {
    const ym = `${year}-${String(month).padStart(2,'0')}`;
    const r = await fetch(`/api/works?month=${ym}`);
    const d = await r.json();
    return d.ok ? (d.works || []) : [];
  }

  async function getPayslips() {
    const r = await fetch('/api/nursery-payslips');
    const d = await r.json();
    return d.ok ? (d.payslips || []) : [];
  }

  async function buildRows(year) {
    if (cachedYear === year && cachedRows) return cachedRows;
    const [months, payslips] = await Promise.all([
      Promise.all(Array.from({length:12}, (_, i) => getMonth(year, i + 1))),
      getPayslips(),
    ]);
    const nurseryByMonth = new Map(
      payslips.filter(p => String(p.month || '').startsWith(`${year}-`))
        .map(p => [String(p.month), p])
    );
    cachedRows = months.map((works, i) => {
      const ym = `${year}-${String(i + 1).padStart(2,'0')}`;
      const audioWorks = works.filter(w => w.category !== '物販');
      const merchWorks = works.filter(w => w.category === '物販');
      const payslip = nurseryByMonth.get(ym) || null;
      const audio = audioWorks.reduce((s,w) => s + Number(w.income || 0), 0);
      const merch = merchWorks.reduce((s,w) => s + Number(w.income || 0), 0);
      const nursery = Number(payslip?.gross_pay || 0);
      return {
        month:i + 1,
        ym,
        audio,
        nursery,
        merch,
        total:audio + nursery + merch,
        audioWorks,
        merchWorks,
        payslip,
      };
    });
    cachedYear = year;
    return cachedRows;
  }

  function ensureUi() {
    const svg = document.getElementById('monthly-chart');
    const panel = svg?.closest('.panel');
    if (!svg || !panel) return false;
    const h2 = panel.querySelector('h2');
    const note = panel.querySelector('.note');
    if (h2) h2.textContent = '月別 収入';
    if (note) note.textContent = '音声・パート（保育園）・物販を切り替えて確認。合計は色分けした積み上げ表示です。棒をクリックすると内訳を表示します。';

    let controls = document.getElementById('income-chart-controls');
    if (!controls) {
      controls = document.createElement('div');
      controls.id = 'income-chart-controls';
      controls.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin:8px 0 12px';
      controls.innerHTML = MODES.map(m => `<button type="button" data-income-mode="${m.key}">${m.label}</button>`).join('');
      const wrap = panel.querySelector('.chart-wrap');
      panel.insertBefore(controls, wrap);
      controls.querySelectorAll('[data-income-mode]').forEach(btn => {
        btn.addEventListener('click', () => {
          mode = btn.dataset.incomeMode;
          updateModeButtons();
          render();
        });
      });
    }

    let legend = panel.querySelector('.legend');
    if (legend) {
      legend.id = 'income-chart-legend';
      legend.innerHTML = `
        <span><i class="key" style="background:${COLORS.audio}"></i>音声</span>
        <span><i class="key" style="background:${COLORS.nursery}"></i>パート</span>
        <span><i class="key" style="background:${COLORS.merch}"></i>物販</span>`;
    }

    let detail = document.getElementById('income-chart-detail');
    if (!detail) {
      detail = document.createElement('div');
      detail.id = 'income-chart-detail';
      detail.style.cssText = 'margin-top:14px;padding:14px;border:1px solid #30363d;border-radius:8px;background:#0d1117;display:none';
      panel.appendChild(detail);
    }

    if (!document.getElementById('income-chart-enhance-style')) {
      const style = document.createElement('style');
      style.id = 'income-chart-enhance-style';
      style.textContent = `
        #income-chart-controls button{background:#21262d;border:1px solid #30363d;color:#8b949e;border-radius:999px;padding:6px 12px;cursor:pointer}
        #income-chart-controls button.active{color:#fff;border-color:#58a6ff;background:#1f6feb}
        #monthly-chart .income-segment{cursor:pointer;transition:opacity .15s}
        #monthly-chart .income-segment:hover{opacity:.82}
        #income-chart-detail .detail-grid{display:grid;grid-template-columns:repeat(4,minmax(110px,1fr));gap:10px;margin-bottom:12px}
        #income-chart-detail .detail-card{background:#161b22;border:1px solid #30363d;border-radius:7px;padding:10px}
        #income-chart-detail .detail-label{color:#8b949e;font-size:11px;margin-bottom:4px}
        #income-chart-detail .detail-value{font-weight:700}
        #income-chart-detail .detail-list{display:grid;gap:6px;font-size:12px;color:#c9d1d9}
        #income-chart-detail .detail-row{display:flex;justify-content:space-between;gap:12px;border-top:1px solid #21262d;padding-top:6px}
        @media(max-width:760px){#income-chart-detail .detail-grid{grid-template-columns:1fr 1fr}}
      `;
      document.head.appendChild(style);
    }
    updateModeButtons();
    return true;
  }

  function updateModeButtons() {
    document.querySelectorAll('[data-income-mode]').forEach(btn => btn.classList.toggle('active', btn.dataset.incomeMode === mode));
    const legend = document.getElementById('income-chart-legend');
    if (legend) legend.style.display = mode === 'total' ? '' : 'none';
  }

  function modeValue(row) {
    return mode === 'total' ? row.total : Number(row[mode] || 0);
  }

  async function render() {
    if (!ensureUi()) return;
    const year = Number(document.getElementById('year')?.value || new Date().getFullYear());
    const rows = await buildRows(year);
    const svg = document.getElementById('monthly-chart');
    if (!svg) return;

    const W=1000,H=330,L=58,R=18,T=18,B=42,plotW=W-L-R,plotH=H-T-B;
    const max = Math.max(1, ...rows.map(modeValue));
    const unit = max <= 100000 ? 10000 : 50000;
    const nice = Math.ceil(max / unit) * unit || unit;
    const y = v => T + plotH - (Math.max(0, v) / nice) * plotH;
    const step = plotW / 12;
    const bw = Math.min(42, step * .55);
    let s = '';

    for (let i=0;i<=4;i++) {
      const val = nice * i / 4, yy = y(val);
      s += `<line class="gridline" x1="${L}" y1="${yy}" x2="${W-R}" y2="${yy}"/>`;
      s += `<text class="axis-label" x="${L-8}" y="${yy+4}" text-anchor="end">${Math.round(val/10000)}万</text>`;
    }

    rows.forEach((r, i) => {
      const cx = L + step * (i + .5);
      const x = cx - bw / 2;
      if (mode === 'total') {
        let base = 0;
        for (const key of ['audio','nursery','merch']) {
          const val = Number(r[key] || 0);
          if (!val) continue;
          const yTop = y(base + val);
          const yBottom = y(base);
          s += `<rect class="income-segment" data-month="${i}" data-kind="${key}" x="${x}" y="${yTop}" width="${bw}" height="${Math.max(1,yBottom-yTop)}" rx="2" fill="${COLORS[key]}"><title>${r.month}月 ${key==='audio'?'音声':key==='nursery'?'パート':'物販'} ${yen(val)}</title></rect>`;
          base += val;
        }
      } else {
        const val = Number(r[mode] || 0);
        const yy = y(val);
        s += `<rect class="income-segment" data-month="${i}" data-kind="${mode}" x="${x}" y="${yy}" width="${bw}" height="${Math.max(1,T+plotH-yy)}" rx="3" fill="${COLORS[mode]}"><title>${r.month}月 ${yen(val)}</title></rect>`;
      }
      s += `<text class="axis-label" x="${cx}" y="${H-18}" text-anchor="middle">${r.month}月</text>`;
    });
    svg.innerHTML = s;
    svg.querySelectorAll('.income-segment').forEach(rect => rect.addEventListener('click', () => showDetail(rows[Number(rect.dataset.month)])));
  }

  function workLabel(w) {
    return [w.date, w.content || w.work_type || w.category].filter(Boolean).join('　');
  }

  function showDetail(row) {
    const el = document.getElementById('income-chart-detail');
    if (!el) return;
    el.style.display = '';
    const audioRows = row.audioWorks.map(w => `<div class="detail-row"><span>${esc(workLabel(w))}</span><strong>${yen(w.income)}</strong></div>`).join('');
    const merchRows = row.merchWorks.map(w => `<div class="detail-row"><span>${esc(workLabel(w))}</span><strong>${yen(w.income)}</strong></div>`).join('');
    const p = row.payslip;
    const nurseryExtra = p ? `勤務 ${p.worked_hours == null ? '—' : Number(p.worked_hours).toFixed(2).replace(/\.00$/,'') + 'h'} / 手取り ${p.net_pay == null ? '—' : yen(p.net_pay)}` : '給与明細なし';
    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;gap:10px;align-items:center;margin-bottom:10px"><strong>${row.month}月の内訳</strong><span style="color:#8b949e;font-size:12px">${row.ym}</span></div>
      <div class="detail-grid">
        <div class="detail-card"><div class="detail-label">合計</div><div class="detail-value">${yen(row.total)}</div></div>
        <div class="detail-card"><div class="detail-label">音声</div><div class="detail-value" style="color:${COLORS.audio}">${yen(row.audio)}</div></div>
        <div class="detail-card"><div class="detail-label">パート</div><div class="detail-value" style="color:${COLORS.nursery}">${yen(row.nursery)}</div></div>
        <div class="detail-card"><div class="detail-label">物販</div><div class="detail-value" style="color:${COLORS.merch}">${yen(row.merch)}</div></div>
      </div>
      <div class="detail-list">
        ${audioRows ? `<div><strong>音声</strong>${audioRows}</div>` : ''}
        ${row.nursery ? `<div><strong>パート</strong><div class="detail-row"><span>${esc(nurseryExtra)}</span><strong>${yen(row.nursery)}</strong></div></div>` : ''}
        ${merchRows ? `<div><strong>物販</strong>${merchRows}</div>` : ''}
        ${!row.total ? '<div style="color:#8b949e">この月の収入データはありません。</div>' : ''}
      </div>`;
  }

  function invalidateAndRender() {
    cachedYear = null;
    cachedRows = null;
    setTimeout(render, 140);
  }

  function init() {
    if (!ensureUi()) {
      setTimeout(init, 250);
      return;
    }
    document.getElementById('year')?.addEventListener('change', invalidateAndRender);
    document.getElementById('reload')?.addEventListener('click', invalidateAndRender);
    render();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once:true });
  else init();
})();
