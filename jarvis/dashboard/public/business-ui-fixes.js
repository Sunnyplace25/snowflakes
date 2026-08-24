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

      #works-table-container {
        max-height: min(60vh, 640px);
        overflow-y: auto;
        overflow-x: auto;
        overscroll-behavior: contain;
      }
      #works-table-container .works-table thead th,
      #nursery-shift-container .works-table thead th,
      #nursery-bulk-grid .works-table thead th {
        position: sticky;
        top: 0;
        z-index: 4;
        background: #161b22;
        box-shadow: 0 1px 0 #30363d;
      }
      #nursery-shift-container,
      #nursery-bulk-grid {
        max-height: min(48vh, 520px);
        overflow-y: auto;
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

  function fixImportPreviewButton() {
    const candidates = $$('button').filter(btn => btn.textContent.includes('インポート内容を確認'));
    if (!candidates.length) return;
    const hasSelectedFile = $$('input[type="file"]').some(input => input.files && input.files.length > 0);
    if (hasSelectedFile) candidates.forEach(btn => { btn.disabled = false; });
  }

  function bindImportPreviewFix() {
    if (document.documentElement.dataset.importPreviewFixBound === '1') return;
    document.documentElement.dataset.importPreviewFixBound = '1';
    // ファイル選択時のみ再評価（setInterval ポーリングは禁止）
    document.addEventListener('change', event => {
      if (event.target?.matches?.('input[type="file"]')) setTimeout(fixImportPreviewButton, 0);
    }, true);
  }

  function apply() {
    installStyles();
    relabelAudioDayOff();
    ensureNurseryCards();
    refreshNurseryCounts();
    fixImportPreviewButton();
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
