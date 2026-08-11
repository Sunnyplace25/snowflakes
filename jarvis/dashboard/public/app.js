/**
 * jarvis/dashboard/public/app.js
 * クライアントサイド JS — 外部ライブラリ不使用・Vanilla JS のみ
 * 日付・対象月はすべて PC ローカル日時から動的に生成（ハードコードなし）
 */

'use strict';

// ─── 状態 ─────────────────────────────────────────────────────────────────────
let currentMonth = '';   // "YYYY-MM"
let currentWorks = [];   // 現在表示中の仕事一覧（編集モーダル用）

// ─── ユーティリティ ───────────────────────────────────────────────────────────

/** PC ローカル日時で YYYY-MM-DD を返す */
function localDateISO() {
  const d = new Date();
  return [
    d.getFullYear(),
    String(d.getMonth() + 1).padStart(2, '0'),
    String(d.getDate()).padStart(2, '0'),
  ].join('-');
}

/** PC ローカル日時で YYYY-MM を返す */
function localYearMonth() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** 曜日ラベル（日本語） */
const WEEKDAYS = ['日', '月', '火', '水', '木', '金', '土'];
function weekdayJa(isoDate) {
  return WEEKDAYS[new Date(isoDate + 'T00:00:00').getDay()];
}

/** 円表示 */
function yen(n) {
  if (n == null) return '—';
  return Number(n).toLocaleString('ja-JP') + '円';
}

/** 時間表示 */
function hours(n) {
  if (n == null || n === 0) return '0h';
  return Number(n).toFixed(1) + 'h';
}

/** 月を N か月ずらす */
function shiftMonth(ym, delta) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

/** 月表示ラベル（例: 2026年8月） */
function monthLabel(ym) {
  const [y, m] = ym.split('-').map(Number);
  return `${y}年${m}月`;
}

/** API 呼び出し共通 */
async function api(method, path, body = null) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== null) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  const data = await res.json();
  return { status: res.status, data };
}

// ─── ヘッダー更新 ─────────────────────────────────────────────────────────────

function updateHeader() {
  const today = localDateISO();
  const wd = weekdayJa(today);
  const [y, mo, d] = today.split('-').map(Number);
  document.getElementById('header-date').textContent =
    `${y}年${mo}月${d}日（${wd}）`;
  document.getElementById('current-month').textContent = monthLabel(currentMonth);
}

// ─── サマリーカード更新 ───────────────────────────────────────────────────────

async function loadSummary() {
  const { data } = await api('GET', `/api/summary?month=${currentMonth}`);
  if (!data.ok) return;

  const s = data.summary;
  document.getElementById('card-income').textContent    = yen(s.total_income);
  document.getElementById('card-expense').textContent   = yen(s.total_expense);
  document.getElementById('card-profit').textContent    = yen(s.profit);
  document.getElementById('card-uninvoiced').textContent = `${data.uninvoiced}件`;
  document.getElementById('card-unpaid').textContent     = `${data.unpaid}件`;
  document.getElementById('card-work-hours').textContent   = hours(s.total_work_hours);
  document.getElementById('card-travel-hours').textContent = hours(s.total_travel_hours);
  document.getElementById('card-dayoff').textContent       = `${data.full_day_off}日`;

  // 利益の色分け
  const profitEl = document.getElementById('card-profit');
  profitEl.className = 'card-value ' + (s.profit >= 0 ? 'green' : 'red');

  // 未請求・未入金の強調
  document.getElementById('card-uninvoiced').className =
    'card-value ' + (data.uninvoiced > 0 ? 'yellow' : '');
  document.getElementById('card-unpaid').className =
    'card-value ' + (data.unpaid > 0 ? 'red' : '');
}

// ─── 今日の仕事 ───────────────────────────────────────────────────────────────

async function loadToday() {
  const { data } = await api('GET', '/api/today');
  if (!data.ok) return;

  const el = document.getElementById('today-works');
  if (data.works.length === 0) {
    el.innerHTML = '<p class="today-empty">本日の仕事はありません</p>';
    return;
  }
  el.innerHTML = data.works.map(w => `
    <div class="today-work-item">
      <span class="today-work-content">${esc(w.content || w.category)}</span>
      ${w.client ? `<span class="today-work-client">${esc(w.client)}</span>` : ''}
      ${w.income != null ? `<span class="today-work-income">${yen(w.income)}</span>` : ''}
    </div>
  `).join('');
}

// ─── 仕事一覧 ─────────────────────────────────────────────────────────────────

async function loadWorks() {
  const { data } = await api('GET', `/api/works?month=${currentMonth}`);
  const container = document.getElementById('works-table-container');
  if (!data.ok || data.works.length === 0) {
    currentWorks = [];
    container.innerHTML = '<div class="empty-state">この月の仕事はまだありません</div>';
    return;
  }

  currentWorks = data.works;

  container.innerHTML = `
    <table class="works-table">
      <thead>
        <tr>
          <th class="col-date">日付</th>
          <th class="col-cat">カテゴリ</th>
          <th class="col-type">種別</th>
          <th class="col-content">内容・発注元</th>
          <th class="col-income">収入</th>
          <th class="col-expense">経費</th>
          <th class="col-hours">労働h</th>
          <th class="col-status">請求 / 入金</th>
          <th class="col-actions"></th>
        </tr>
      </thead>
      <tbody id="works-tbody"></tbody>
    </table>
  `;

  const tbody = document.getElementById('works-tbody');
  tbody.innerHTML = data.works.map(w => `
    <tr data-id="${w.id}">
      <td class="col-date">${w.date}（${weekdayJa(w.date)}）</td>
      <td class="col-cat">${esc(w.category)}</td>
      <td class="col-type">${esc(w.work_type || '—')}</td>
      <td class="col-content">
        <div class="content-cell" title="${esc(w.content || '')}">
          ${esc(w.content || '—')}
        </div>
        <div style="font-size:11px;color:var(--text-sec)">${esc(w.client || '')}</div>
      </td>
      <td class="col-income">${w.income != null ? yen(w.income) : '—'}</td>
      <td class="col-expense">${w.expense ? yen(w.expense) : '—'}</td>
      <td class="col-hours">${w.work_hours != null ? w.work_hours + 'h' : '—'}</td>
      <td class="col-status">
        ${statusSelect(w.id, 'invoice_status', w.invoice_status, ['対象外', '未請求', '請求済'])}
        ${statusSelect(w.id, 'payment_status', w.payment_status, ['対象外', '未入金', '入金済'])}
      </td>
      <td class="col-actions">
        <button class="btn btn-secondary btn-sm" onclick="openEditModal(${w.id})">編集</button>
      </td>
    </tr>
  `).join('');
}

/** ステータス選択セル（双方向変更可） */
function statusSelect(id, field, current, options) {
  const opts = options.map(v =>
    `<option value="${esc(v)}"${current === v ? ' selected' : ''}>${esc(v)}</option>`
  ).join('');
  return `<select class="status-select" onchange="updateStatus(${id},'${field}',this.value)">${opts}</select>`;
}

/** ステータスを更新（双方向対応） */
window.updateStatus = async function(id, field, value) {
  const body = {};
  body[field] = value;
  const { status, data } = await api('PUT', `/api/work/${id}`, body);
  if (status === 200 && data.ok) {
    await refresh();
  } else {
    alert('更新に失敗しました: ' + (data.error || '不明なエラー'));
  }
};

// ─── 全体リフレッシュ ─────────────────────────────────────────────────────────

async function refresh() {
  updateHeader();
  await Promise.all([loadSummary(), loadToday(), loadWorks()]);
}

// ─── 月ナビゲーション ─────────────────────────────────────────────────────────

document.getElementById('prev-month').addEventListener('click', async () => {
  currentMonth = shiftMonth(currentMonth, -1);
  await refresh();
});

document.getElementById('next-month').addEventListener('click', async () => {
  currentMonth = shiftMonth(currentMonth, +1);
  await refresh();
});

// ─── 仕事登録モーダル ─────────────────────────────────────────────────────────

document.getElementById('add-work-btn').addEventListener('click', () => {
  // 今日の日付をデフォルトにセット
  document.getElementById('work-date').value = localDateISO();
  document.getElementById('work-error').textContent = '';
  showModal('modal-work');
});

document.getElementById('work-form').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  document.getElementById('work-error').textContent = '';

  const body = {
    date:           f.date.value,
    category:       f.category.value,
    work_type:      f.work_type.value   || null,
    content:        f.content.value     || null,
    client:         f.client.value      || null,
    income:         f.income.value      ? Number(f.income.value)      : null,
    expense:        f.expense.value     ? Number(f.expense.value)     : null,
    work_hours:     f.work_hours.value  ? Number(f.work_hours.value)  : null,
    travel_hours:   f.travel_hours.value ? Number(f.travel_hours.value) : null,
    invoice_status: f.invoice_status.value,
    payment_status: f.payment_status.value,
    memo:           f.memo.value        || null,
  };

  const { status, data } = await api('POST', '/api/work', body);
  if (status === 201 && data.ok) {
    hideModal();
    f.reset();
    await refresh();
  } else {
    document.getElementById('work-error').textContent = data.error || '登録に失敗しました';
  }
});

// ─── 休日登録モーダル ─────────────────────────────────────────────────────────

document.getElementById('add-day-btn').addEventListener('click', () => {
  document.getElementById('day-date').value = localDateISO();
  document.getElementById('day-error').textContent = '';
  showModal('modal-day');
});

document.getElementById('day-form').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  document.getElementById('day-error').textContent = '';

  const body = {
    date:           f.date.value,
    is_full_day_off: f.type.value === 'off',
    memo:           f.memo.value || null,
  };

  const { status, data } = await api('POST', '/api/day', body);
  if (status === 200 && data.ok) {
    hideModal();
    f.reset();
    await refresh();
  } else {
    document.getElementById('day-error').textContent = data.error || '登録に失敗しました';
  }
});

// ─── 仕事編集モーダル ─────────────────────────────────────────────────────────

window.openEditModal = function(id) {
  const w = currentWorks.find(x => x.id === id);
  if (!w) return;

  document.getElementById('edit-work-id').value         = w.id;
  document.getElementById('edit-work-date').value       = w.date;
  document.getElementById('edit-work-category').value   = w.category;
  document.getElementById('edit-work-type').value       = w.work_type   || '';
  document.getElementById('edit-work-client').value     = w.client      || '';
  document.getElementById('edit-work-content').value    = w.content     || '';
  document.getElementById('edit-work-income').value     = w.income  != null ? w.income       : '';
  document.getElementById('edit-work-expense').value    = w.expense != null ? w.expense      : '';
  document.getElementById('edit-work-hours').value      = w.work_hours   != null ? w.work_hours   : '';
  document.getElementById('edit-travel-hours').value    = w.travel_hours != null ? w.travel_hours : '';
  document.getElementById('edit-work-invoice').value    = w.invoice_status;
  document.getElementById('edit-work-payment').value    = w.payment_status;
  document.getElementById('edit-work-memo').value       = w.memo        || '';
  document.getElementById('edit-work-error').textContent = '';
  showModal('modal-edit-work');
};

document.getElementById('edit-work-form').addEventListener('submit', async e => {
  e.preventDefault();
  const f = e.target;
  document.getElementById('edit-work-error').textContent = '';
  const id = Number(document.getElementById('edit-work-id').value);

  const body = {
    date:           f.date.value,
    category:       f.category.value,
    work_type:      f.work_type.value     || null,
    content:        f.content.value       || null,
    client:         f.client.value        || null,
    income:         f.income.value        ? Number(f.income.value)       : null,
    expense:        f.expense.value       ? Number(f.expense.value)      : null,
    work_hours:     f.work_hours.value    ? Number(f.work_hours.value)   : null,
    travel_hours:   f.travel_hours.value  ? Number(f.travel_hours.value) : null,
    invoice_status: f.invoice_status.value,
    payment_status: f.payment_status.value,
    memo:           f.memo.value          || null,
  };

  const { status, data } = await api('PUT', `/api/work/${id}`, body);
  if (status === 200 && data.ok) {
    hideModal();
    await refresh();
  } else {
    document.getElementById('edit-work-error').textContent = data.error || '更新に失敗しました';
  }
});

// ─── モーダル制御 ─────────────────────────────────────────────────────────────

function showModal(id) {
  document.getElementById('modal-overlay').removeAttribute('hidden');
  document.querySelectorAll('.modal').forEach(m => m.hidden = true);
  document.getElementById(id).hidden = false;
}

function hideModal() {
  document.getElementById('modal-overlay').setAttribute('hidden', '');
}

document.getElementById('modal-overlay').addEventListener('click', e => {
  if (e.target === document.getElementById('modal-overlay')) hideModal();
});

document.querySelectorAll('.modal-cancel').forEach(btn => {
  btn.addEventListener('click', hideModal);
});

// ─── JARVIS 入力欄 ────────────────────────────────────────────────────────────

document.getElementById('jarvis-send').addEventListener('click', async () => {
  const text = document.getElementById('jarvis-text').value.trim();
  if (!text) return;

  const { data } = await api('POST', '/api/chat', { text });
  const logEl = document.getElementById('jarvis-log');
  logEl.textContent = data.message || '自然言語入力は次の開発で対応予定です。';
  logEl.style.color = 'var(--text-sec)';
  document.getElementById('jarvis-text').value = '';
});

document.getElementById('jarvis-text').addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    document.getElementById('jarvis-send').click();
  }
});

// ─── HTML エスケープ ──────────────────────────────────────────────────────────

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── 初期化 ───────────────────────────────────────────────────────────────────

(async function init() {
  currentMonth = localYearMonth();
  await refresh();
})();
