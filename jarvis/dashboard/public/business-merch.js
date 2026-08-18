/** Business 物販専用タブ。月次から物販を分離し、統計グラフでは全体集計。 */
'use strict';

(function () {
  let merchRows = [];
  let loadedMonth = null;
  let filterBusy = false;

  const yen = v => Number(v || 0).toLocaleString('ja-JP') + '円';
  const esc = v => String(v ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;');

  function todayISO() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }
  function monthValue() {
    return (typeof currentMonth !== 'undefined' && /^\d{4}-\d{2}$/.test(currentMonth)) ? currentMonth : todayISO().slice(0,7);
  }
  async function fetchMonthWorks() {
    const r = await fetch(`/api/works?month=${encodeURIComponent(monthValue())}`);
    const d = await r.json();
    if (!r.ok || !d.ok) throw new Error(d.error || '読み込みに失敗しました');
    return d.works || [];
  }

  function ensureUi() {
    const tabs = document.getElementById('business-tabs');
    if (tabs && !document.getElementById('business-merch-tab')) {
      const btn = document.createElement('button');
      btn.id = 'business-merch-tab';
      btn.className = 'sf-tab';
      btn.type = 'button';
      btn.textContent = '物販';
      tabs.appendChild(btn);
      btn.addEventListener('click', openMerchTab);
      tabs.querySelectorAll('[data-biz-tab]').forEach(b => b.addEventListener('click', () => {
        document.getElementById('biz-tab-merch')?.setAttribute('hidden','');
        btn.classList.remove('active');
      }));
    }

    if (!document.getElementById('biz-tab-merch')) {
      const monthly = document.getElementById('biz-tab-monthly');
      if (!monthly) return;
      const panel = document.createElement('div');
      panel.id = 'biz-tab-merch';
      panel.className = 'sf-tab-panel';
      panel.hidden = true;
      panel.innerHTML = `<section class="section">
        <div class="section-header"><h2>物販</h2><button class="btn btn-primary" id="merch-add-btn">＋ 物販を登録</button></div>
        <div id="merch-container" class="loading">読み込み中...</div>
      </section>`;
      monthly.parentNode.insertBefore(panel, monthly.nextSibling);
      document.getElementById('merch-add-btn')?.addEventListener('click', () => openModal(null));
    }

    const overlay = document.getElementById('modal-overlay');
    if (!overlay || document.getElementById('modal-merch')) return;
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.id = 'modal-merch';
    modal.hidden = true;
    modal.innerHTML = `<h3 id="merch-modal-title">物販を登録</h3>
      <form id="merch-form" autocomplete="off">
        <input type="hidden" id="merch-id">
        <div class="form-grid">
          <div class="form-group"><label for="merch-date">日付 *</label><input type="date" id="merch-date" required></div>
          <div class="form-group form-full"><label for="merch-content">商品・内容</label><input type="text" id="merch-content"></div>
          <div class="form-group"><label for="merch-income">売上（円）</label><input type="number" id="merch-income" min="0"></div>
          <div class="form-group"><label for="merch-expense">原価・経費（円）</label><input type="number" id="merch-expense" min="0"></div>
          <div class="form-group form-full"><label for="merch-memo">メモ</label><textarea id="merch-memo"></textarea></div>
        </div>
        <div class="error-msg" id="merch-error"></div>
        <div class="modal-actions">
          <button type="button" class="btn btn-secondary edit-delete-btn" id="merch-delete-btn" hidden>削除</button>
          <button type="button" class="btn btn-secondary" id="merch-cancel-btn">キャンセル</button>
          <button type="submit" class="btn btn-primary">保存する</button>
        </div>
      </form>`;
    overlay.appendChild(modal);
    document.getElementById('merch-cancel-btn').addEventListener('click', closeModal);
    document.getElementById('merch-form').addEventListener('submit', saveMerch);
    document.getElementById('merch-delete-btn').addEventListener('click', deleteMerch);
  }

  function openMerchTab() {
    document.querySelectorAll('#module-business .sf-tab-panel').forEach(p => { p.hidden = true; });
    const p = document.getElementById('biz-tab-merch');
    if (p) p.hidden = false;
    document.querySelectorAll('#business-tabs .sf-tab').forEach(b => b.classList.remove('active'));
    document.getElementById('business-merch-tab')?.classList.add('active');
    loadMerch(true);
  }

  function showModal() {
    const overlay = document.getElementById('modal-overlay');
    const modal = document.getElementById('modal-merch');
    if (!overlay || !modal) return;
    overlay.removeAttribute('hidden');
    document.querySelectorAll('#modal-overlay .modal').forEach(m => { m.hidden = true; });
    modal.hidden = false;
  }
  function closeModal() { document.getElementById('modal-overlay')?.setAttribute('hidden',''); }
  function openModal(row) {
    const month = monthValue(), today = todayISO();
    document.getElementById('merch-modal-title').textContent = row ? '物販を編集' : '物販を登録';
    document.getElementById('merch-id').value = row?.id || '';
    document.getElementById('merch-date').value = row?.date || (today.startsWith(month) ? today : `${month}-01`);
    document.getElementById('merch-content').value = row?.content || '';
    document.getElementById('merch-income').value = row?.income ?? '';
    document.getElementById('merch-expense').value = row?.expense ?? '';
    document.getElementById('merch-memo').value = row?.memo || '';
    document.getElementById('merch-error').textContent = '';
    document.getElementById('merch-delete-btn').hidden = !row;
    showModal();
  }

  async function loadMerch(force=false) {
    ensureUi();
    const month = monthValue();
    if (!force && loadedMonth === month) return;
    loadedMonth = month;
    const c = document.getElementById('merch-container');
    if (!c) return;
    try {
      merchRows = (await fetchMonthWorks()).filter(w => w.category === '物販');
      render();
    } catch(e) { c.className=''; c.textContent='読み込みエラー: '+e.message; }
  }

  function render() {
    const c = document.getElementById('merch-container');
    if (!c) return;
    c.className='';
    const sales=merchRows.reduce((s,r)=>s+Number(r.income||0),0);
    const costs=merchRows.reduce((s,r)=>s+Number(r.expense||0),0);
    const profit=sales-costs;
    const summary=`<div class="cards-secondary" style="margin-bottom:14px">
      <div class="card"><div class="card-label">物販売上</div><div class="card-value green">${yen(sales)}</div></div>
      <div class="card"><div class="card-label">原価・経費</div><div class="card-value red">${yen(costs)}</div></div>
      <div class="card"><div class="card-label">物販利益</div><div class="card-value ${profit>=0?'green':'red'}">${yen(profit)}</div></div></div>`;
    if (!merchRows.length) { c.innerHTML=summary+'<div class="empty-state">この月の物販はありません</div>'; return; }
    const rows=merchRows.map(r=>`<tr><td>${esc(r.date)}</td><td>${esc(r.content||'—')}</td><td style="text-align:right">${yen(r.income)}</td><td style="text-align:right">${yen(r.expense)}</td><td style="text-align:right">${yen(Number(r.income||0)-Number(r.expense||0))}</td><td style="text-align:right"><button class="btn btn-secondary btn-sm" data-merch-edit="${r.id}">編集</button></td></tr>`).join('');
    c.innerHTML=summary+`<table class="works-table"><thead><tr><th>日付</th><th>商品・内容</th><th>売上</th><th>原価・経費</th><th>利益</th><th></th></tr></thead><tbody>${rows}</tbody></table>`;
    c.querySelectorAll('[data-merch-edit]').forEach(btn=>btn.addEventListener('click',()=>{const row=merchRows.find(r=>Number(r.id)===Number(btn.dataset.merchEdit));if(row)openModal(row);}));
  }

  async function keepMonthlyWorkOnly() {
    if (filterBusy) return;
    filterBusy = true;
    try {
      const works = await fetchMonthWorks();
      const normal = works.filter(w => w.category !== '物販');
      const income = normal.reduce((s,w)=>s+Number(w.income||0),0);
      const expense = normal.reduce((s,w)=>s+Number(w.expense||0),0);
      const profit = income-expense;
      const setText = (id,text) => { const el=document.getElementById(id); if(el && el.textContent!==text) el.textContent=text; };
      setText('card-income',yen(income));
      setText('card-expense',yen(expense));
      const p=document.getElementById('card-profit');
      if(p){ const text=yen(profit); if(p.textContent!==text)p.textContent=text; p.className='card-value '+(profit>=0?'green':'red'); }
      const merchIds=new Set(works.filter(w=>w.category==='物販').map(w=>Number(w.id)));
      document.querySelectorAll('#works-tbody tr[data-id]').forEach(tr=>{ if(merchIds.has(Number(tr.dataset.id))) tr.remove(); });
    } catch(_) {} finally { filterBusy=false; }
  }

  async function saveMerch(e) {
    e.preventDefault();
    const id=Number(document.getElementById('merch-id').value||0);
    const body={date:document.getElementById('merch-date').value,category:'物販',work_type:'物販',content:document.getElementById('merch-content').value.trim()||null,client:null,income:Number(document.getElementById('merch-income').value||0),expense:Number(document.getElementById('merch-expense').value||0),invoice_status:'対象外',payment_status:'対象外',memo:document.getElementById('merch-memo').value.trim()||null};
    try{
      const r=await fetch(id?`/api/work/${id}`:'/api/work',{method:id?'PUT':'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});const d=await r.json();if(!r.ok||!d.ok)throw new Error(d.error||'保存に失敗しました');
      closeModal();loadedMonth=null;if(typeof refresh==='function')await refresh();await keepMonthlyWorkOnly();await loadMerch(true);
    }catch(err){document.getElementById('merch-error').textContent=err.message;}
  }

  async function deleteMerch() {
    const id=Number(document.getElementById('merch-id').value||0);if(!id)return;
    if(!window.confirm('この物販記録を削除しますか？\n削除後は元に戻せません。'))return;
    try{const r=await fetch(`/api/work/${id}`,{method:'DELETE'});const d=await r.json();if(!r.ok||!d.ok)throw new Error(d.error||'削除に失敗しました');closeModal();loadedMonth=null;if(typeof refresh==='function')await refresh();await keepMonthlyWorkOnly();await loadMerch(true);}catch(err){document.getElementById('merch-error').textContent=err.message;}
  }

  function init() {
    ensureUi();
    keepMonthlyWorkOnly();
    let lastMonth=monthValue();
    const monthEl=document.getElementById('current-month');
    if(monthEl){
      new MutationObserver(()=>{
        const m=monthValue();
        if(m===lastMonth)return;
        lastMonth=m;loadedMonth=null;
        setTimeout(()=>{keepMonthlyWorkOnly();if(!document.getElementById('biz-tab-merch')?.hidden)loadMerch(true);},50);
      }).observe(monthEl,{childList:true,characterData:true,subtree:true});
    }
    const worksEl=document.getElementById('works-table-container');
    if(worksEl){
      new MutationObserver(()=>{ if(!filterBusy) setTimeout(keepMonthlyWorkOnly,30); }).observe(worksEl,{childList:true,subtree:true});
    }
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();

/* Business UI corrections collected from the current troubleshooting thread. */
(function () {
  const $ = (sel, root=document) => root.querySelector(sel);
  const $$ = (sel, root=document) => [...root.querySelectorAll(sel)];

  function installStyles() {
    if ($('#business-thread-fixes-style')) return;
    const style=document.createElement('style');
    style.id='business-thread-fixes-style';
    style.textContent=`
      #works-table-container{max-height:min(48vh,520px);overflow-y:auto;overscroll-behavior:contain;scrollbar-gutter:stable;scrollbar-width:thin;scrollbar-color:#475569 transparent}
      #works-table-container::-webkit-scrollbar,#nursery-shift-container::-webkit-scrollbar,#nursery-bulk-grid::-webkit-scrollbar{width:8px;height:8px}
      #works-table-container::-webkit-scrollbar-track,#nursery-shift-container::-webkit-scrollbar-track,#nursery-bulk-grid::-webkit-scrollbar-track{background:transparent}
      #works-table-container::-webkit-scrollbar-thumb,#nursery-shift-container::-webkit-scrollbar-thumb,#nursery-bulk-grid::-webkit-scrollbar-thumb{background:#475569;border-radius:999px;border:2px solid transparent;background-clip:padding-box}
      #works-table-container::-webkit-scrollbar-thumb:hover,#nursery-shift-container::-webkit-scrollbar-thumb:hover,#nursery-bulk-grid::-webkit-scrollbar-thumb:hover{background:#64748b;background-clip:padding-box}
      #works-table-container .works-table thead th,#nursery-shift-container .works-table thead th,#nursery-bulk-grid .works-table thead th{position:sticky;top:0;z-index:6;background:#0f172a!important;background-color:#0f172a!important;background-image:none!important;opacity:1!important;box-shadow:0 1px 0 #334155}
      #nursery-shift-container,#nursery-bulk-grid{max-height:min(48vh,520px);overflow-y:auto!important;overflow-x:auto;overscroll-behavior:contain;scrollbar-width:thin;scrollbar-color:#475569 transparent}
      .business-linked-subtabs{display:flex;gap:8px;flex-wrap:wrap;margin:0 0 16px;padding:8px 10px;border:1px solid #263449;border-radius:8px;background:#0f172a}
      .business-linked-subtabs button{border:1px solid #334155;border-radius:6px;background:#1e293b;color:#94a3b8;padding:7px 13px;font-size:12px;cursor:pointer}
      .business-linked-subtabs button.active{color:#fff;border-color:#3b82f6;background:#1d4ed8}
    `;
    document.head.appendChild(style);
  }

  function relabelAudioDayOff(){
    const value=$('#card-dayoff');
    const label=value?.closest('.card')?.querySelector('.card-label');
    if(label){label.textContent='音声休み';label.title='音声仕事の休日として登録した日数';}
  }

  async function refreshNurseryCounts(){
    const cards=$('#nursery-pay-summary .cards-secondary');
    if(!cards)return;
    if(!$('#nursery-work-days')){const c=document.createElement('div');c.className='card';c.innerHTML='<div class="card-label">出勤日数</div><div class="card-value" id="nursery-work-days">—</div>';cards.appendChild(c);}
    if(!$('#nursery-off-days')){const c=document.createElement('div');c.className='card';c.innerHTML='<div class="card-label">休日日数</div><div class="card-value" id="nursery-off-days">—</div>';cards.appendChild(c);}
    try{
      const ym=(typeof currentMonth!=='undefined'&&/^\d{4}-\d{2}$/.test(currentMonth))?currentMonth:todayYm();
      const r=await fetch(`/api/nursery-shifts?month=${encodeURIComponent(ym)}`);const d=await r.json();if(!r.ok||!d.ok)throw new Error();
      const shifts=d.shifts||[];
      const work=shifts.filter(s=>s.status!=='休み'&&s.status!=='有給'&&(s.original_start||s.changed_start)).length;
      const off=shifts.filter(s=>s.status==='休み').length;
      $('#nursery-work-days').textContent=`${work}日`;$('#nursery-off-days').textContent=`${off}日`;
    }catch(_){$('#nursery-work-days').textContent='—';$('#nursery-off-days').textContent='—';}
  }
  function todayYm(){const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;}

  function linkedSubnav(panel, active){
    if(!panel||$('.business-linked-subtabs',panel))return;
    const nav=document.createElement('nav');nav.className='business-linked-subtabs';
    nav.innerHTML=`<button type="button" data-linked="invoice" class="${active==='invoice'?'active':''}">請求書</button><button type="button" data-linked="calendar" class="${active==='calendar'?'active':''}">Googleカレンダー</button>`;
    panel.insertBefore(nav,panel.firstChild);
    $('[data-linked="invoice"]',nav).addEventListener('click',()=>openLinked('invoice'));
    $('[data-linked="calendar"]',nav).addEventListener('click',()=>openLinked('calendar'));
  }
  function openLinked(name){
    if(typeof switchBizTab==='function')switchBizTab(name);
    else{
      $$('#module-business .sf-tab-panel').forEach(p=>p.hidden=true);
      const p=$(`#biz-tab-${name}`);if(p)p.hidden=false;
      if(name==='invoice'&&typeof initInvoiceTab==='function')initInvoiceTab();
      if(name==='calendar'&&typeof initCalendarTab==='function')initCalendarTab();
    }
    setTimeout(()=>{
      $$('#business-tabs .sf-tab').forEach(b=>b.classList.remove('active'));
      $('#business-linked-top')?.classList.add('active');
    },0);
  }

  function fixNavigation(){
    const tabs=$('#business-tabs');if(!tabs)return;
    const analytics=tabs.querySelector('[data-biz-tab="analytics"]');
    const monthly=tabs.querySelector('[data-biz-tab="monthly"]');
    const merch=$('#business-merch-tab');
    const nursery=$('#business-nursery-tab-btn');
    let calendar=tabs.querySelector('[data-biz-tab="calendar"]');
    const invoice=tabs.querySelector('[data-biz-tab="invoice"]');

    if(analytics)analytics.textContent='実績分析';
    if(monthly)monthly.textContent='音声';
    if(nursery)nursery.textContent='パート（保育園）';
    if(invoice){invoice.textContent='請求・連携';invoice.id='business-linked-top';}

    const embedded=$('#business-analytics-graph');if(embedded)embedded.style.display='none';

    /* Do not add/remove tab children here: the old payslip observer watches childList. Reuse Calendar as Graph. */
    if(calendar && calendar.dataset.businessGraph!=='1'){
      calendar.removeAttribute('data-biz-tab');
      calendar.dataset.businessGraph='1';
      calendar.textContent='グラフ';
      calendar.addEventListener('click',e=>{e.preventDefault();e.stopImmediatePropagation();location.href='/business-graph-v2.html';},true);
    } else if(!calendar){
      calendar=tabs.querySelector('[data-business-graph="1"]');
      if(calendar)calendar.textContent='グラフ';
    }

    linkedSubnav($('#biz-tab-invoice'),'invoice');
    linkedSubnav($('#biz-tab-calendar'),'calendar');

    const ordered=[analytics,calendar,monthly,merch,nursery,invoice].filter(Boolean);
    /* append only if order is currently wrong; after old observers have settled this runs once late. */
    const current=$$('#business-tabs > .sf-tab');
    const needs=ordered.some((b,i)=>current[i]!==b);
    if(needs)ordered.forEach(b=>tabs.appendChild(b));
  }

  function fixImportPreviewButton(){
    const buttons=$$('button').filter(b=>b.textContent.includes('インポート内容を確認'));
    if(!buttons.length)return;
    const selected=$$('input[type="file"]').some(i=>i.files&&i.files.length>0);
    if(selected)buttons.forEach(b=>{b.disabled=false;});
  }

  function init(){
    installStyles();relabelAudioDayOff();
    setTimeout(()=>{fixNavigation();refreshNurseryCounts();fixImportPreviewButton();},1000);
    setTimeout(()=>{fixNavigation();refreshNurseryCounts();fixImportPreviewButton();},1800);
    document.addEventListener('change',e=>{if(e.target?.matches?.('input[type="file"]'))setTimeout(fixImportPreviewButton,0);},true);
    $('#prev-month')?.addEventListener('click',()=>setTimeout(refreshNurseryCounts,180));
    $('#next-month')?.addEventListener('click',()=>setTimeout(refreshNurseryCounts,180));
    $('#business-nursery-tab-btn')?.addEventListener('click',()=>setTimeout(refreshNurseryCounts,120));
  }
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
