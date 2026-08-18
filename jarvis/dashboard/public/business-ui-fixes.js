'use strict';

(function () {
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  function currentYm() {
    if (typeof currentMonth !== 'undefined' && /^\d{4}-\d{2}$/.test(currentMonth)) return currentMonth;
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  function installStyles() {
    if ($('#business-ui-fixes-style')) return;
    const style = document.createElement('style');
    style.id = 'business-ui-fixes-style';
    style.textContent = `
      #works-table-container,
      #nursery-shift-container,
      #nursery-bulk-grid {
        scrollbar-width: thin;
        scrollbar-color: #475569 transparent;
      }
      #works-table-container::-webkit-scrollbar,
      #nursery-shift-container::-webkit-scrollbar,
      #nursery-bulk-grid::-webkit-scrollbar { width: 8px; height: 8px; }
      #works-table-container::-webkit-scrollbar-track,
      #nursery-shift-container::-webkit-scrollbar-track,
      #nursery-bulk-grid::-webkit-scrollbar-track { background: transparent; }
      #works-table-container::-webkit-scrollbar-thumb,
      #nursery-shift-container::-webkit-scrollbar-thumb,
      #nursery-bulk-grid::-webkit-scrollbar-thumb {
        background: #475569;
        border-radius: 999px;
        border: 2px solid transparent;
        background-clip: padding-box;
      }
      #works-table-container::-webkit-scrollbar-thumb:hover,
      #nursery-shift-container::-webkit-scrollbar-thumb:hover,
      #nursery-bulk-grid::-webkit-scrollbar-thumb:hover { background: #64748b; background-clip: padding-box; }

      #works-table-container .works-table thead th,
      #nursery-shift-container .works-table thead th,
      #nursery-bulk-grid .works-table thead th {
        position: sticky;
        top: 0;
        z-index: 4;
        background: #0f172a !important;
        background-color: #0f172a !important;
        opacity: 1 !important;
        box-shadow: 0 1px 0 #334155;
      }
      #nursery-shift-container,
      #nursery-bulk-grid {
        max-height: min(48vh, 520px);
        overflow-y: auto !important;
        overflow-x: auto;
        overscroll-behavior: contain;
      }

      .business-linked-subtabs {
        display:flex;
        gap:8px;
        flex-wrap:wrap;
        margin:0 0 16px;
        padding:8px 10px;
        border:1px solid #263449;
        border-radius:8px;
        background:#0f172a;
      }
      .business-linked-subtabs button {
        border:1px solid #334155;
        border-radius:6px;
        background:#1e293b;
        color:#94a3b8;
        padding:7px 13px;
        font-size:12px;
        cursor:pointer;
      }
      .business-linked-subtabs button.active {
        color:#fff;
        border-color:#3b82f6;
        background:#1d4ed8;
      }
    `;
    document.head.appendChild(style);
  }

  function relabelAudioDayOff() {
    const value = $('#card-dayoff');
    const label = value?.closest('.card')?.querySelector('.card-label');
    if (label) {
      label.textContent = '音声休み';
      label.title = '音声仕事の休日として登録した日数';
    }
  }

  function ensureNurseryCards() {
    const cards = $('#nursery-pay-summary .cards-secondary');
    if (!cards) return false;
    if (!$('#nursery-work-days')) {
      const work = document.createElement('div');
      work.className = 'card';
      work.innerHTML = '<div class="card-label">出勤日数</div><div class="card-value" id="nursery-work-days">—</div>';
      cards.appendChild(work);
    }
    if (!$('#nursery-off-days')) {
      const off = document.createElement('div');
      off.className = 'card';
      off.innerHTML = '<div class="card-label">休日日数</div><div class="card-value" id="nursery-off-days">—</div>';
      cards.appendChild(off);
    }
    return true;
  }

  async function refreshNurseryCounts() {
    if (!ensureNurseryCards()) return;
    const workEl = $('#nursery-work-days');
    const offEl = $('#nursery-off-days');
    try {
      const res = await fetch(`/api/nursery-shifts?month=${encodeURIComponent(currentYm())}`);
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error('load failed');
      const shifts = data.shifts || [];
      const workDays = shifts.filter(s => s.status !== '休み' && s.status !== '有給' && (s.original_start || s.changed_start)).length;
      const offDays = shifts.filter(s => s.status === '休み').length;
      if (workEl) workEl.textContent = `${workDays}日`;
      if (offEl) offEl.textContent = `${offDays}日`;
    } catch (_) {
      if (workEl) workEl.textContent = '—';
      if (offEl) offEl.textContent = '—';
    }
  }

  function addLinkedSubnav(panel, activeName, invoiceBtn, calendarBtn) {
    if (!panel || $('.business-linked-subtabs', panel)) return;
    const nav = document.createElement('nav');
    nav.className = 'business-linked-subtabs';
    nav.innerHTML = `
      <button type="button" data-linked="invoice" class="${activeName === 'invoice' ? 'active' : ''}">請求書</button>
      <button type="button" data-linked="calendar" class="${activeName === 'calendar' ? 'active' : ''}">Googleカレンダー</button>`;
    panel.insertBefore(nav, panel.firstChild);
    $('[data-linked="invoice"]', nav)?.addEventListener('click', () => invoiceBtn?.click());
    $('[data-linked="calendar"]', nav)?.addEventListener('click', () => calendarBtn?.click());
  }

  function groupInvoiceAndCalendar() {
    const tabs = $('#business-tabs');
    if (!tabs) return;
    const invoiceBtn = $('[data-biz-tab="invoice"]', tabs);
    const calendarBtn = $('[data-biz-tab="calendar"]', tabs);
    if (!invoiceBtn || !calendarBtn) return;

    let groupBtn = $('#business-linked-tab', tabs);
    if (!groupBtn) {
      groupBtn = document.createElement('button');
      groupBtn.id = 'business-linked-tab';
      groupBtn.type = 'button';
      groupBtn.className = 'sf-tab';
      groupBtn.textContent = '請求・連携';
      groupBtn.addEventListener('click', () => invoiceBtn.click());
      tabs.appendChild(groupBtn);
    }

    invoiceBtn.style.display = 'none';
    calendarBtn.style.display = 'none';
    invoiceBtn.setAttribute('aria-hidden', 'true');
    calendarBtn.setAttribute('aria-hidden', 'true');

    const invoicePanel = $('#biz-tab-invoice');
    const calendarPanel = $('#biz-tab-calendar');
    addLinkedSubnav(invoicePanel, 'invoice', invoiceBtn, calendarBtn);
    addLinkedSubnav(calendarPanel, 'calendar', invoiceBtn, calendarBtn);

    const syncActive = (name) => queueMicrotask(() => {
      groupBtn.classList.toggle('active', name === 'invoice' || name === 'calendar');
    });
    if (!invoiceBtn.dataset.linkedGroupBound) {
      invoiceBtn.dataset.linkedGroupBound = '1';
      invoiceBtn.addEventListener('click', () => syncActive('invoice'));
    }
    if (!calendarBtn.dataset.linkedGroupBound) {
      calendarBtn.dataset.linkedGroupBound = '1';
      calendarBtn.addEventListener('click', () => syncActive('calendar'));
    }
    $$('#business-tabs .sf-tab').forEach(btn => {
      if (btn === groupBtn || btn === invoiceBtn || btn === calendarBtn || btn.dataset.linkedClearBound) return;
      btn.dataset.linkedClearBound = '1';
      btn.addEventListener('click', () => groupBtn.classList.remove('active'));
    });
  }

  function fixImportPreviewButton() {
    const candidates = $$('button').filter(btn => btn.textContent.includes('インポート内容を確認'));
    if (!candidates.length) return;
    const hasSelectedFile = $$('input[type="file"]').some(input => input.files && input.files.length > 0);
    if (hasSelectedFile) candidates.forEach(btn => { btn.disabled = false; });
  }

  function bindImportPreviewFix() {
    if (document.documentElement.dataset.importPreviewFixBound === '1') return;
    document.documentElement.dataset.importPreviewFixBound = '1';
    document.addEventListener('change', event => {
      if (event.target?.matches?.('input[type="file"]')) setTimeout(fixImportPreviewButton, 0);
    }, true);
    setInterval(fixImportPreviewButton, 1200);
  }

  function injectGraphEnhancer() {
    const frame = $('#business-analytics-graph-frame');
    if (!frame) return;
    const inject = () => {
      try {
        const doc = frame.contentDocument;
        if (!doc || doc.getElementById('business-graph-enhance-loader')) return;
        const script = doc.createElement('script');
        script.id = 'business-graph-enhance-loader';
        script.src = '/business-graph-enhance.js';
        doc.body.appendChild(script);
      } catch (_) {}
    };
    if (!frame.dataset.graphEnhancerBound) {
      frame.dataset.graphEnhancerBound = '1';
      frame.addEventListener('load', inject);
    }
    inject();
  }

  function apply() {
    installStyles();
    relabelAudioDayOff();
    ensureNurseryCards();
    refreshNurseryCounts();
    groupInvoiceAndCalendar();
    fixImportPreviewButton();
    injectGraphEnhancer();
  }

  function init() {
    installStyles();
    bindImportPreviewFix();
    setTimeout(apply, 950);
    setTimeout(apply, 1800);

    $('#prev-month')?.addEventListener('click', () => setTimeout(refreshNurseryCounts, 150));
    $('#next-month')?.addEventListener('click', () => setTimeout(refreshNurseryCounts, 150));
    $('#business-nursery-tab-btn')?.addEventListener('click', () => setTimeout(refreshNurseryCounts, 120));

    const module = $('#module-business');
    if (module) {
      let timer = null;
      new MutationObserver(() => {
        clearTimeout(timer);
        timer = setTimeout(apply, 180);
      }).observe(module, { childList:true, subtree:true });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once:true });
  else init();
})();
