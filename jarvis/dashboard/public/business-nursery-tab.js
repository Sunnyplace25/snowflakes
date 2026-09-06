/**
 * Business nursery shift tab
 * - 保育園シフトを月次から独立タブへ移動
 * - 日付から曜日を自動表示
 * - 曜日テンプレート + 1か月分の一括入力
 * - 手動変更を未保存表示し、固定ボタンから一括保存
 * - 一括入力を基本導線にするため単独の「シフトを登録」ボタンは表示しない
 * - 時給 / 有給残 / 月の勤務時間 / 給与目安を表示
 */
'use strict';

(function () {
  const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
  const PRESETS = [
    { value: '', label: '未設定' },
    { value: '09:00-14:00', label: '9:00–14:00' },
    { value: '09:00-13:00', label: '9:00–13:00' },
    { value: '08:30-14:00', label: '8:30–14:00' },
    { value: '08:30-13:00', label: '8:30–13:00' },
    { value: '休み', label: '休み' },
    { value: '有給', label: '有給' },
  ];
  const SETTINGS_KEY = 'jarvis:nursery-pay-settings';

  const esc = value => String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/\"/g, '&quot;');

  function monthValue() {
    if (typeof currentMonth !== 'undefined' && /^\d{4}-\d{2}$/.test(currentMonth)) return currentMonth;
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  function parseIsoDate(iso) {
    const [y, m, d] = String(iso).split('-').map(Number);
    return new Date(y, m - 1, d);
  }

  function shortDate(iso) {
    const [, m, d] = String(iso).split('-').map(Number);
    return `${m}/${d}（${WEEKDAYS[parseIsoDate(iso).getDay()]}）`;
  }

  function monthDates(ym) {
    const [y, m] = ym.split('-').map(Number);
    const last = new Date(y, m, 0).getDate();
    return Array.from({ length: last }, (_, i) => `${y}-${String(m).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`);
  }

  function presetOptions(selected = '') {
    return PRESETS.map(p => `<option value="${esc(p.value)}"${p.value === selected ? ' selected' : ''}>${esc(p.label)}</option>`).join('');
  }

  function shiftToPreset(shift) {
    if (!shift) return '';
    if (shift.status === '休み' || shift.status === '有給') return shift.status;
    if (shift.status === '通常' && shift.original_start && shift.original_end) {
      const key = `${shift.original_start}-${shift.original_end}`;
      if (PRESETS.some(p => p.value === key)) return key;
    }
    return '';
  }

  function removeSingleRegisterButton() {
    document.getElementById('add-nursery-shift-btn')?.remove();
  }

  function loadPaySettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
      return {
        hourlyRate: Number(saved.hourlyRate || 0),
        paidLeaveBalance: Number(saved.paidLeaveBalance || 0),
        paidLeaveHours: Number(saved.paidLeaveHours || 0),
      };
    } catch (_) {
      return { hourlyRate: 0, paidLeaveBalance: 0, paidLeaveHours: 0 };
    }
  }

  function savePaySettings() {
    const settings = {
      hourlyRate: Number(document.getElementById('nursery-hourly-rate')?.value || 0),
      paidLeaveBalance: Number(document.getElementById('nursery-paid-leave-balance')?.value || 0),
      paidLeaveHours: Number(document.getElementById('nursery-paid-leave-hours')?.value || 0),
    };
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    refreshPaySummary();
  }

  function timeToMinutes(value) {
    if (!/^\d{2}:\d{2}$/.test(String(value || ''))) return null;
    const [h, m] = value.split(':').map(Number);
    return h * 60 + m;
  }

  function shiftHours(shift) {
    if (!shift || shift.status === '休み' || shift.status === '有給') return 0;
    const start = shift.status === '変更' && shift.changed_start ? shift.changed_start : shift.original_start;
    const end = shift.status === '変更' && shift.changed_end ? shift.changed_end : shift.original_end;
    const s = timeToMinutes(start);
    const e = timeToMinutes(end);
    if (s == null || e == null || e <= s) return 0;
    return (e - s) / 60;
  }

  async function fetchNurseryShifts(month = null) {
    const suffix = month ? `?month=${encodeURIComponent(month)}` : '';
    const response = await fetch(`/api/nursery-shifts${suffix}`);
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || 'シフト読込に失敗しました');
    return data.shifts || [];
  }

  async function refreshPaySummary() {
    const hoursEl = document.getElementById('nursery-month-hours');
    const payEl = document.getElementById('nursery-month-pay');
    const leaveUsedEl = document.getElementById('nursery-leave-used');
    if (!hoursEl || !payEl || !leaveUsedEl) return;

    try {
      const shifts = await fetchNurseryShifts(monthValue());
      const settings = loadPaySettings();
      const workHours = shifts.reduce((sum, shift) => sum + shiftHours(shift), 0);
      const leaveUsed = shifts.filter(s => s.status === '有給').length;
      const paidLeaveHours = leaveUsed * settings.paidLeaveHours;
      const paidHours = workHours + paidLeaveHours;
      const pay = Math.round(paidHours * settings.hourlyRate);

      hoursEl.textContent = `${workHours.toFixed(1)}h`;
      leaveUsedEl.textContent = `${leaveUsed}日`;
      payEl.textContent = settings.hourlyRate ? `${pay.toLocaleString('ja-JP')}円` : '時給未設定';
      payEl.title = settings.paidLeaveHours > 0
        ? `実働 ${workHours.toFixed(1)}h + 有給換算 ${paidLeaveHours.toFixed(1)}h`
        : `実働 ${workHours.toFixed(1)}h（有給分は未換算）`;
    } catch (_) {
      hoursEl.textContent = '—';
      leaveUsedEl.textContent = '—';
      payEl.textContent = '—';
    }
  }

  function ensurePaySummaryUi() {
    const panel = ensureTabAndPanel();
    if (!panel || document.getElementById('nursery-pay-summary')) return;
    const settings = loadPaySettings();
    const section = document.createElement('section');
    section.className = 'section';
    section.id = 'nursery-pay-summary';
    section.innerHTML = `
      <div class="section-header"><h2>勤務・給与</h2></div>
      <div class="cards-secondary" style="margin-bottom:14px">
        <div class="card"><div class="card-label">今月の実働時間</div><div class="card-value accent" id="nursery-month-hours">—</div></div>
        <div class="card"><div class="card-label">今月の有給</div><div class="card-value" id="nursery-leave-used">—</div></div>
        <div class="card"><div class="card-label">給与目安</div><div class="card-value green" id="nursery-month-pay">—</div></div>
      </div>
      <div class="business-form-inline">
        <div class="form-group">
          <label for="nursery-hourly-rate">時給（円）</label>
          <input type="number" id="nursery-hourly-rate" min="0" step="1" value="${settings.hourlyRate || ''}" placeholder="例：1300">
        </div>
        <div class="form-group">
          <label for="nursery-paid-leave-balance">有給残（日）</label>
          <input type="number" id="nursery-paid-leave-balance" min="0" step="0.5" value="${settings.paidLeaveBalance || ''}" placeholder="例：18">
        </div>
        <div class="form-group">
          <label for="nursery-paid-leave-hours">有給1日分（h）</label>
          <input type="number" id="nursery-paid-leave-hours" min="0" step="0.5" value="${settings.paidLeaveHours || ''}" placeholder="未設定なら給与計算から除外">
        </div>
      </div>
      <div class="business-muted-note" style="margin-top:8px">時給・有給残はこのブラウザに保存します。有給の給与も含めたい場合だけ「有給1日分」の時間を設定してください。</div>`;

    const bulk = document.getElementById('nursery-bulk-section');
    if (bulk) bulk.insertAdjacentElement('afterend', section);
    else panel.insertBefore(section, panel.firstChild);

    ['nursery-hourly-rate','nursery-paid-leave-balance','nursery-paid-leave-hours'].forEach(id => {
      document.getElementById(id)?.addEventListener('change', savePaySettings);
    });
    refreshPaySummary();
  }

  function ensureStyles() {
    if (document.getElementById('nursery-bulk-styles')) return;
    const style = document.createElement('style');
    style.id = 'nursery-bulk-styles';
    style.textContent = `
      #nursery-bulk-grid tr.is-dirty { background: rgba(210,153,34,.08); }
      .nursery-unsaved { color:#d29922; font-size:11px; font-weight:600; }
      #nursery-bulk-savebar {
        position:sticky; bottom:0; z-index:8; display:flex; gap:10px; align-items:center;
        justify-content:flex-end; margin-top:12px; padding:12px;
        background:rgba(15,23,42,.96); border:1px solid #334155; border-radius:8px;
        backdrop-filter:blur(6px);
      }
      #nursery-bulk-savebar[hidden] { display:none; }
    `;
    document.head.appendChild(style);
  }

  function ensureTabAndPanel() {
    const tabs = document.getElementById('business-tabs');
    const monthly = document.getElementById('biz-tab-monthly');
    if (!tabs || !monthly) return null;

    let button = document.getElementById('business-nursery-tab-btn');
    if (!button) {
      button = document.createElement('button');
      button.id = 'business-nursery-tab-btn';
      button.className = 'sf-tab';
      button.type = 'button';
      button.textContent = '保育園シフト';
      tabs.appendChild(button);
    }

    let panel = document.getElementById('biz-tab-nursery');
    if (!panel) {
      panel = document.createElement('div');
      panel.id = 'biz-tab-nursery';
      panel.className = 'sf-tab-panel';
      panel.hidden = true;
      monthly.parentNode.insertBefore(panel, monthly.nextSibling);
    }

    const section = document.getElementById('nursery-shift-section');
    if (section && section.parentNode !== panel) panel.appendChild(section);
    removeSingleRegisterButton();

    if (!button.dataset.bound) {
      button.dataset.bound = '1';
      button.addEventListener('click', () => {
        document.querySelectorAll('#module-business .sf-tab-panel').forEach(p => { p.hidden = true; });
        panel.hidden = false;
        document.querySelectorAll('#business-tabs .sf-tab').forEach(b => b.classList.remove('active'));
        button.classList.add('active');
        removeSingleRegisterButton();
        renderBulkPanel();
        formatNurseryDates();
        refreshPaySummary();
      });
    }

    document.querySelectorAll('#business-tabs .sf-tab').forEach(existing => {
      if (existing === button || existing.dataset.nurseryHideBound) return;
      existing.dataset.nurseryHideBound = '1';
      existing.addEventListener('click', () => { panel.hidden = true; });
    });
    return panel;
  }

  function ensureBulkUi() {
    const panel = ensureTabAndPanel();
    if (!panel || document.getElementById('nursery-bulk-section')) return;

    const bulk = document.createElement('section');
    bulk.className = 'section';
    bulk.id = 'nursery-bulk-section';
    bulk.innerHTML = `
      <div class="section-header">
        <h2>今月を一括入力</h2>
        <button class="btn btn-secondary" id="nursery-bulk-toggle">開く</button>
      </div>
      <div id="nursery-bulk-body" hidden>
        <div class="business-muted-note" style="margin-bottom:12px">
          曜日ごとの基本シフトを反映したあと、例外の日は下の一覧で直接変更できます。変更した行は「未保存」と表示されます。
        </div>
        <div id="nursery-week-template" style="display:grid;grid-template-columns:repeat(7,minmax(105px,1fr));gap:8px;margin-bottom:12px"></div>
        <div style="display:flex;gap:8px;align-items:center;margin-bottom:14px;flex-wrap:wrap">
          <button class="btn btn-secondary" id="nursery-apply-week">曜日設定を反映</button>
          <span id="nursery-bulk-status" class="business-muted-note"></span>
        </div>
        <div id="nursery-bulk-grid" style="overflow-x:auto"></div>
        <div id="nursery-bulk-savebar" hidden>
          <span id="nursery-dirty-count" class="nursery-unsaved"></span>
          <button class="btn btn-primary" id="nursery-save-month">変更した日を一括保存</button>
        </div>
      </div>`;
    panel.insertBefore(bulk, panel.firstChild);

    document.getElementById('nursery-bulk-toggle').addEventListener('click', () => {
      const body = document.getElementById('nursery-bulk-body');
      body.hidden = !body.hidden;
      document.getElementById('nursery-bulk-toggle').textContent = body.hidden ? '開く' : '閉じる';
      if (!body.hidden) renderBulkPanel();
    });
    document.getElementById('nursery-apply-week').addEventListener('click', applyWeekTemplate);
    document.getElementById('nursery-save-month').addEventListener('click', saveBulkMonth);
  }

  function markDirty(select) {
    select.dataset.dirty = '1';
    const tr = select.closest('tr');
    tr?.classList.add('is-dirty');
    const marker = tr?.querySelector('[data-unsaved-marker]');
    if (marker) marker.textContent = '未保存';
    updateDirtyUi();
  }

  function updateDirtyUi() {
    const count = document.querySelectorAll('[data-bulk-date][data-dirty="1"]').length;
    const bar = document.getElementById('nursery-bulk-savebar');
    const label = document.getElementById('nursery-dirty-count');
    if (bar) bar.hidden = count === 0;
    if (label) label.textContent = count ? `${count}日変更あり` : '';
  }

  async function renderBulkPanel() {
    ensureBulkUi();
    const body = document.getElementById('nursery-bulk-body');
    if (!body || body.hidden) return;

    const ym = monthValue();
    document.getElementById('nursery-week-template').innerHTML = WEEKDAYS.map((wd, index) => `
      <label style="display:block;font-size:12px;color:#94a3b8">${wd}曜
        <select data-week-template="${index}" style="width:100%;margin-top:4px">${presetOptions('')}</select>
      </label>`).join('');

    let existing = [];
    try { existing = await fetchNurseryShifts(ym); } catch (_) {}
    const byDate = new Map(existing.map(s => [s.date, s]));

    const rows = monthDates(ym).map(date => {
      const saved = byDate.get(date);
      const selected = shiftToPreset(saved);
      return `<tr>
        <td style="white-space:nowrap">${esc(shortDate(date))}</td>
        <td><select data-bulk-date="${date}" data-weekday="${parseIsoDate(date).getDay()}">${presetOptions(selected)}</select></td>
        <td><span data-unsaved-marker></span>${saved && !selected ? '<span style="font-size:11px;color:#64748b">詳細設定あり</span>' : ''}</td>
      </tr>`;
    }).join('');

    document.getElementById('nursery-bulk-grid').innerHTML = `
      <table class="works-table" style="min-width:520px">
        <thead><tr><th>日付</th><th>基本シフト</th><th>保存状態</th></tr></thead><tbody>${rows}</tbody>
      </table>`;

    document.querySelectorAll('[data-bulk-date]').forEach(select => {
      select.addEventListener('change', () => markDirty(select));
    });
    document.getElementById('nursery-bulk-status').textContent = `${ym.replace('-', '年')}月`;
    updateDirtyUi();
  }

  function applyWeekTemplate() {
    const template = new Map();
    document.querySelectorAll('[data-week-template]').forEach(select => template.set(Number(select.dataset.weekTemplate), select.value));
    document.querySelectorAll('[data-bulk-date]').forEach(select => {
      const next = template.get(Number(select.dataset.weekday));
      if (select.value !== next) {
        select.value = next;
        markDirty(select);
      }
    });
    document.getElementById('nursery-bulk-status').textContent = '曜日設定を反映しました。例外の日は直接変更できます。';
  }

  function bodyFromPreset(date, preset) {
    if (!preset) return null;
    if (preset === '休み' || preset === '有給') {
      return { date, status:preset, original_start:null, original_end:null, changed_start:null, changed_end:null, change_reason:null, memo:null };
    }
    const [start, end] = preset.split('-');
    return { date, status:'通常', original_start:start, original_end:end, changed_start:null, changed_end:null, change_reason:null, memo:null };
  }

  async function saveBulkMonth() {
    const button = document.getElementById('nursery-save-month');
    const status = document.getElementById('nursery-bulk-status');
    const changed = [...document.querySelectorAll('[data-bulk-date][data-dirty="1"]')];
    const rows = changed.map(select => bodyFromPreset(select.dataset.bulkDate, select.value)).filter(Boolean);

    if (!changed.length) { status.textContent = '未保存の変更はありません。'; return; }
    if (!rows.length) { status.textContent = '保存できるシフトが選ばれていません。'; return; }

    button.disabled = true;
    status.textContent = `${rows.length}日分を保存中...`;
    let saved = 0, failed = 0;
    for (const body of rows) {
      try {
        const response = await fetch('/api/nursery-shift', {
          method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify(body),
        });
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.error || '保存失敗');
        saved += 1;
      } catch (_) { failed += 1; }
    }

    button.disabled = false;
    status.textContent = failed ? `保存 ${saved}日 / 失敗 ${failed}日` : `${saved}日分を保存しました。`;
    if (!failed) {
      changed.forEach(select => {
        delete select.dataset.dirty;
        select.closest('tr')?.classList.remove('is-dirty');
        const marker = select.closest('tr')?.querySelector('[data-unsaved-marker]');
        if (marker) marker.textContent = '';
      });
      updateDirtyUi();
      await refreshPaySummary();
      setTimeout(() => location.reload(), 350);
    }
  }

  function formatNurseryDates() {
    const container = document.getElementById('nursery-shift-container');
    if (!container) return;
    container.querySelectorAll('tbody tr td:first-child').forEach(td => {
      const raw = td.textContent.trim();
      if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) td.textContent = shortDate(raw);
    });
  }

  function init() {
    ensureStyles();
    ensureTabAndPanel();
    ensureBulkUi();
    ensurePaySummaryUi();
    removeSingleRegisterButton();
    formatNurseryDates();
    const container = document.getElementById('nursery-shift-container');
    if (container) new MutationObserver(() => {
      removeSingleRegisterButton();
      formatNurseryDates();
      refreshPaySummary();
    }).observe(container, { childList:true, subtree:true });
    ['prev-month','next-month'].forEach(id => document.getElementById(id)?.addEventListener('click', () => setTimeout(() => {
      renderBulkPanel();
      refreshPaySummary();
    }, 80)));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once:true });
  else init();
})();
