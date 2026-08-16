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

// ─── モジュールタブ切替 ───────────────────────────────────────────────────────

/**
 * 登録済みモジュール。
 * 将来のタブ（System 等）は MODULES にエントリを追加するだけでよい。
 */
const MODULES = {
  business: {
    activate() {
      refresh();
    },
  },
  sf: SfModule,   // modules/sf.js で定義
};

/**
 * 指定モジュールへ切り替える。
 * - ページ遷移・再読み込みなし（CSS hidden 付け替えのみ）
 * - 各モジュールの activate() は必要な API を fetch 可能
 * - URL hash でリロード後もタブ位置を保持する
 * - 月ナビは全タブで常時表示（Business: 収支確認、SF: 公開予定・収益推移）
 */
function switchModule(name) {
  if (!MODULES[name]) return;

  // セクション表示切替
  document.querySelectorAll('[id^="module-"]').forEach(el => {
    el.hidden = (el.id !== `module-${name}`);
  });

  // タブのアクティブ状態
  document.querySelectorAll('.module-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.module === name);
  });

  // URL hash 更新（履歴は汚さない）
  history.replaceState(null, '', `#${name}`);

  // モジュール起動
  MODULES[name].activate();
}

// タブクリックイベント
document.querySelectorAll('.module-tab').forEach(btn => {
  btn.addEventListener('click', () => switchModule(btn.dataset.module));
});

// 初期タブ：URL hash 優先、なければ business
// ※ init() が business データをロード済みのため business の activate() は呼ばない
(function initTabs() {
  const hash    = location.hash.replace('#', '');
  const initial = MODULES[hash] ? hash : 'business';

  // DOM の初期状態だけセット（business は init() がロード済み）
  document.querySelectorAll('[id^="module-"]').forEach(el => {
    el.hidden = (el.id !== `module-${initial}`);
  });
  document.querySelectorAll('.module-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.module === initial);
  });
  history.replaceState(null, '', `#${initial}`);

  // business 以外で開始する場合だけ activate を呼ぶ
  if (initial !== 'business') MODULES[initial].activate();
})();

// ─── Business サブタブ ────────────────────────────────────────────────────────

let bizCurrentTab = 'monthly';

function switchBizTab(name) {
  bizCurrentTab = name;

  // panel 表示切替
  ['monthly', 'invoice', 'analytics', 'calendar'].forEach(t => {
    const el = document.getElementById(`biz-tab-${t}`);
    if (el) el.hidden = (t !== name);
  });

  // ボタンの active 状態
  document.querySelectorAll('#business-tabs .sf-tab').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.bizTab === name);
  });

  if (name === 'invoice')   initInvoiceTab();
  if (name === 'analytics') initAnalyticsTab();
  if (name === 'calendar')  initCalendarTab();
}

document.querySelectorAll('#business-tabs .sf-tab').forEach(btn => {
  btn.addEventListener('click', () => switchBizTab(btn.dataset.bizTab));
});

// ─── 請求書取込タブ ───────────────────────────────────────────────────────────

let invoiceFileBuffer = null;  // base64 of current file
let invoiceFilename   = '';
let invoiceInitialized = false;

function initInvoiceTab() {
  loadInvoiceHistory();
}

/** ArrayBuffer → Base64（大ファイル対応・チャンク分割） */
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary  = '';
  const CHUNK = 8192;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

// Dropzone
const invoiceDropzone  = document.getElementById('invoice-dropzone');
const invoiceFileInput = document.getElementById('invoice-file-input');

invoiceDropzone.addEventListener('click', () => invoiceFileInput.click());

invoiceDropzone.addEventListener('dragover', e => {
  e.preventDefault();
  invoiceDropzone.style.borderColor = '#60a5fa';
});
invoiceDropzone.addEventListener('dragleave', () => {
  invoiceDropzone.style.borderColor = '#334155';
});
invoiceDropzone.addEventListener('drop', e => {
  e.preventDefault();
  invoiceDropzone.style.borderColor = '#334155';
  const file = e.dataTransfer.files[0];
  if (file) handleInvoiceFile(file);
});

invoiceFileInput.addEventListener('change', e => {
  const file = e.target.files[0];
  if (file) handleInvoiceFile(file);
});

function handleInvoiceFile(file) {
  if (!file.name.toLowerCase().endsWith('.xlsx')) {
    document.getElementById('invoice-file-info').textContent = '⚠ .xlsx ファイルのみ対応しています';
    return;
  }

  invoiceFilename = file.name;
  document.getElementById('invoice-file-info').textContent =
    `選択中: ${file.name}（${(file.size / 1024).toFixed(1)} KB）`;
  document.getElementById('invoice-already-msg').style.display = 'none';
  document.getElementById('invoice-preview-area').hidden = true;
  document.getElementById('invoice-import-status').textContent = '解析中...';

  const reader = new FileReader();
  reader.onload = async ev => {
    const b64 = arrayBufferToBase64(ev.target.result);
    invoiceFileBuffer = b64;
    await parseInvoiceFile(b64, file.name);
  };
  reader.readAsArrayBuffer(file);
}

async function parseInvoiceFile(b64, filename) {
  const statusEl = document.getElementById('invoice-import-status');
  try {
    const { status, data } = await api('POST', '/api/invoice/parse', {
      filename,
      data_b64: b64,
    });

    if (status !== 200) {
      statusEl.textContent = `エラー: ${data.error || '解析失敗'}`;
      return;
    }

    // 既取込み警告
    if (data.existImport) {
      const alreadyEl = document.getElementById('invoice-already-msg');
      alreadyEl.style.display = 'block';
      const at = data.existImport.imported_at
        ? `（${data.existImport.imported_at.slice(0, 16)} 取込済み）`
        : '';
      alreadyEl.textContent =
        `このファイルは既に取込済みです${at}。再取込する場合はそのまま「取り込む」を押してください。`;
    }

    renderInvoicePreview(data);
    statusEl.textContent = '';
  } catch (err) {
    statusEl.textContent = `通信エラー: ${err.message}`;
  }
}

function renderInvoicePreview(data) {
  const area    = document.getElementById('invoice-preview-area');
  const summary = document.getElementById('invoice-preview-summary');
  const wrap    = document.getElementById('invoice-preview-table-wrap');
  const { invoices = [], summary: s = {} } = data;

  // サマリー行
  let parts = [`請求書: ${s.invoiceCount ?? invoices.length}件`, `明細: ${s.lineCount ?? '—'}行`];
  if (s.skippedCount) parts.push(`スキップ: ${s.skippedCount}件`);
  if (s.totalSubtotal != null) parts.push(`合計（税抜）: ${Number(s.totalSubtotal).toLocaleString('ja-JP')}円`);
  summary.textContent = parts.join(' / ');

  if (!invoices.length) {
    wrap.innerHTML = '<p style="color:#64748b;font-size:13px">取込対象の請求書が見つかりませんでした</p>';
  } else {
    const rows = invoices.map(inv => `
      <tr>
        <td>${esc(inv.invoiceNumber)}</td>
        <td>${esc(inv.sourceSheet)}</td>
        <td style="text-align:right">${inv.lines?.length ?? 0}行</td>
        <td style="text-align:right">${Number(inv.subtotal ?? 0).toLocaleString('ja-JP')}円</td>
      </tr>
    `).join('');
    wrap.innerHTML = `
      <table class="works-table" style="min-width:420px">
        <thead><tr>
          <th>請求書番号</th><th>シート名</th><th>明細行数</th><th>金額（税抜）</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  area.hidden = false;
}

// 取り込むボタン
document.getElementById('invoice-import-btn').addEventListener('click', async () => {
  if (!invoiceFileBuffer) return;

  const btn      = document.getElementById('invoice-import-btn');
  const statusEl = document.getElementById('invoice-import-status');
  btn.disabled   = true;
  statusEl.textContent = '取込中...';

  try {
    const { status, data } = await api('POST', '/api/invoice/import', {
      filename:  invoiceFilename,
      data_b64:  invoiceFileBuffer,
    });

    if (status !== 200 && status !== 201) {
      statusEl.textContent = `エラー: ${data.error || '取込失敗'}`;
      btn.disabled = false;
      return;
    }

    statusEl.textContent =
      `完了: 新規 ${data.newCount}件 取込${data.dupCount ? `（重複スキップ ${data.dupCount}件）` : ''}`;
    loadInvoiceHistory();
    setTimeout(resetInvoiceDropzone, 4000);
  } catch (err) {
    statusEl.textContent = `通信エラー: ${err.message}`;
    btn.disabled = false;
  }
});

// キャンセルボタン
document.getElementById('invoice-cancel-btn').addEventListener('click', resetInvoiceDropzone);

function resetInvoiceDropzone() {
  invoiceFileBuffer = null;
  invoiceFilename   = '';
  document.getElementById('invoice-file-info').textContent     = '';
  document.getElementById('invoice-preview-area').hidden       = true;
  document.getElementById('invoice-already-msg').style.display = 'none';
  document.getElementById('invoice-import-status').textContent = '';
  document.getElementById('invoice-import-btn').disabled       = false;
  document.getElementById('invoice-file-input').value          = '';
}

// 履歴読み込み
async function loadInvoiceHistory() {
  const el = document.getElementById('invoice-history-container');
  el.className   = 'loading';
  el.textContent = '読み込み中...';

  try {
    const { data } = await api('GET', '/api/invoice/imports');
    if (!data.ok || !data.imports?.length) {
      el.className = '';
      el.innerHTML = '<p style="color:#64748b;font-size:13px">取込履歴がありません</p>';
      return;
    }

    const rows = data.imports.map(imp => `
      <tr>
        <td style="color:#94a3b8;font-size:12px">${esc((imp.imported_at || '').slice(0, 16))}</td>
        <td>${esc(imp.source_filename)}</td>
        <td style="text-align:right">${imp.new_count}</td>
        <td style="text-align:right;color:#64748b">${imp.dup_count}</td>
        <td><span class="badge badge-${imp.status === 'completed' ? 'invoiced' : 'uninvoiced'}">${imp.status}</span></td>
      </tr>
    `).join('');

    el.className = '';
    el.innerHTML = `
      <table class="works-table">
        <thead><tr><th>取込日時</th><th>ファイル名</th><th>新規</th><th>重複</th><th>状態</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  } catch {
    el.className = '';
    el.textContent = '読み込みエラー';
  }
}

document.getElementById('invoice-history-refresh-btn')
  .addEventListener('click', loadInvoiceHistory);

// ─── 実績分析タブ ─────────────────────────────────────────────────────────────

let invAnalyticsFull = null;   // GET /api/invoice/analytics のキャッシュ
let invCurrentYear   = '';     // '' = 全期間

async function initAnalyticsTab() {
  // 初回のみ全期間データを取得
  if (!invAnalyticsFull) {
    await loadFullAnalytics();
    populateYearSelect();
  }
  await renderAnalytics();
}

async function loadFullAnalytics() {
  try {
    const { data } = await api('GET', '/api/invoice/analytics');
    if (data.ok) invAnalyticsFull = data;
  } catch { /* silent */ }
}

function populateYearSelect() {
  const sel   = document.getElementById('inv-year-select');
  const years = invAnalyticsFull?.availableYears ?? [];

  // 既存オプション（全期間以外）を削除
  while (sel.options.length > 1) sel.remove(1);

  // 降順で追加（availableYears は DESC で来る）
  years.forEach(y => {
    const opt = document.createElement('option');
    opt.value       = y;
    opt.textContent = `${y}年`;
    sel.appendChild(opt);
  });

  // 初期値: 最新年（years[0] が最新）
  if (years.length > 0 && !invCurrentYear) {
    invCurrentYear = years[0];
  }
  sel.value = invCurrentYear;
}

document.getElementById('inv-year-select').addEventListener('change', async e => {
  invCurrentYear = e.target.value;
  await renderAnalytics();
});

async function renderAnalytics() {
  if (invCurrentYear) {
    await renderAnalyticsByYear(invCurrentYear);
  } else {
    renderAnalyticsAll();
  }
}

function renderAnalyticsAll() {
  if (!invAnalyticsFull) {
    setAnalyticsCards('—', '—', '—', '—');
    return;
  }

  const { byYear = [], byMonth = [], byCategory = [] } = invAnalyticsFull;

  const totalSubtotal = byYear.reduce((s, r) => s + (r.subtotal   ?? 0), 0);
  const totalCount    = byYear.reduce((s, r) => s + (r.lineCount   ?? 0), 0);
  const avgAmount     = totalCount > 0 ? Math.round(totalSubtotal / totalCount) : 0;

  setAnalyticsCards(yen(totalSubtotal), `${totalCount}件`, yen(avgAmount), '—');
  document.getElementById('inv-card-yoy').className = 'card-value';

  renderMonthlyTable(byMonth);
  renderCategoryTable(byCategory);
  loadInvLines({});
}

async function renderAnalyticsByYear(year) {
  try {
    const { status, data } = await api('GET', `/api/invoice/analytics/${year}`);
    if (status !== 200 || !data.ok) return;

    // yoy 表示
    let yoyText  = '—';
    let yoyClass = 'card-value';
    if (data.yoyRate != null) {
      const sign = data.yoyRate >= 0 ? '+' : '';
      yoyText  = `${sign}${data.yoyRate}%`;
      yoyClass = 'card-value ' + (data.yoyRate >= 0 ? 'green' : 'red');
    }

    setAnalyticsCards(yen(data.subtotal), `${data.lineCount}件`, yen(data.avgAmount), yoyText);
    document.getElementById('inv-card-yoy').className = yoyClass;

    renderMonthlyTable(data.byMonth   ?? []);
    renderCategoryTable(data.byCategory ?? []);
    loadInvLines({ year });
  } catch { /* silent */ }
}

function setAnalyticsCards(subtotal, count, avg, yoy) {
  document.getElementById('inv-card-subtotal').textContent = subtotal;
  document.getElementById('inv-card-count').textContent    = count;
  document.getElementById('inv-card-avg').textContent      = avg;
  document.getElementById('inv-card-yoy').textContent      = yoy;
}

function renderMonthlyTable(rows) {
  const el = document.getElementById('inv-monthly-container');
  if (!rows.length) {
    el.innerHTML = '<p style="color:#64748b;font-size:13px">データなし</p>';
    return;
  }

  const max = Math.max(...rows.map(r => r.subtotal ?? 0), 1);
  const trs = rows.map(r => {
    const pct = Math.round(((r.subtotal ?? 0) / max) * 100);
    return `
      <tr>
        <td style="color:#94a3b8;font-size:12px">${esc(r.month)}</td>
        <td style="text-align:right;color:#64748b">${r.line_count}件</td>
        <td style="text-align:right">${yen(r.subtotal)}</td>
        <td style="width:140px;padding-right:0">
          <div style="background:#1e3a5f;border-radius:3px;height:10px">
            <div style="background:#3b82f6;width:${pct}%;height:100%;border-radius:3px"></div>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  el.innerHTML = `
    <table class="works-table">
      <thead><tr><th>月</th><th>件数</th><th>金額（税抜）</th><th></th></tr></thead>
      <tbody>${trs}</tbody>
    </table>
  `;
}

function renderCategoryTable(rows) {
  const el = document.getElementById('inv-category-container');
  if (!rows.length) {
    el.innerHTML = '<p style="color:#64748b;font-size:13px">データなし</p>';
    return;
  }

  const max = Math.max(...rows.map(r => r.subtotal ?? 0), 1);
  const trs = rows.map(r => {
    const pct = Math.round(((r.subtotal ?? 0) / max) * 100);
    return `
      <tr>
        <td>${esc(r.category)}</td>
        <td style="text-align:right;color:#64748b">${r.line_count}件</td>
        <td style="text-align:right">${yen(r.subtotal)}</td>
        <td style="width:140px;padding-right:0">
          <div style="background:#1e3a5f;border-radius:3px;height:10px">
            <div style="background:#8b5cf6;width:${pct}%;height:100%;border-radius:3px"></div>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  el.innerHTML = `
    <table class="works-table">
      <thead><tr><th>カテゴリ</th><th>件数</th><th>金額（税抜）</th><th></th></tr></thead>
      <tbody>${trs}</tbody>
    </table>
  `;
}

async function loadInvLines({ year, month, category } = {}) {
  const el     = document.getElementById('inv-lines-container');
  const noteEl = document.getElementById('inv-lines-note');

  const params = new URLSearchParams();
  if (year)     params.set('year',     year);
  if (month)    params.set('month',    month);
  if (category) params.set('category', category);
  params.set('limit', '200');

  try {
    const { data } = await api('GET', `/api/invoice/lines?${params}`);
    if (!data.ok || !data.lines?.length) {
      noteEl.textContent = '';
      el.innerHTML = '<p style="color:#64748b;font-size:13px">データなし</p>';
      return;
    }

    noteEl.textContent = `${data.lines.length}件`;

    const trs = data.lines.map(l => `
      <tr>
        <td style="color:#94a3b8;font-size:12px;white-space:nowrap">${esc(l.work_date ?? '—')}</td>
        <td style="max-width:240px">${esc(l.description)}</td>
        <td style="text-align:right;color:#64748b">${l.quantity}${esc(l.quantity_unit)}</td>
        <td style="text-align:right;color:#64748b">${yen(l.unit_price)}</td>
        <td style="text-align:right">${yen(l.amount)}</td>
        <td style="color:#94a3b8">${esc(l.category)}</td>
        <td style="color:#64748b;font-size:12px">${esc(l.invoice_number)}</td>
      </tr>
    `).join('');

    el.innerHTML = `
      <div style="overflow-x:auto">
        <table class="works-table" style="font-size:12px;min-width:700px">
          <thead><tr>
            <th>作業日</th><th>作業内容</th><th>数量</th><th>単価</th><th>金額</th><th>カテゴリ</th><th>請求書</th>
          </tr></thead>
          <tbody>${trs}</tbody>
        </table>
      </div>
    `;
  } catch {
    el.innerHTML = '<p style="color:#64748b;font-size:13px">読み込みエラー</p>';
  }
}

// ─── Google Calendar タブ ─────────────────────────────────────────────────────

let calConnected      = false;
let calPushPreviewData = null;   // 最後のdry-run結果キャッシュ

async function initCalendarTab() {
  await loadCalendarStatus();
  loadCalendarSyncRuns();
}

// ── 接続状態確認 ──────────────────────────────────────────────────────────────

async function loadCalendarStatus() {
  const el = document.getElementById('cal-status-container');
  el.className   = 'loading';
  el.textContent = '確認中...';

  try {
    const { data } = await api('GET', '/api/calendar/status');

    if (data.connected) {
      calConnected = true;
      el.className = '';
      el.innerHTML = `
        <div style="display:flex;align-items:center;gap:10px;font-size:13px">
          <span style="color:#22c55e;font-size:16px">●</span>
          <span style="color:#e2e8f0">接続済み</span>
          <span style="color:#64748b">（同期済み: ${data.linkedCount ?? 0}件）</span>
        </div>
      `;
      showCalPushConfig(true);
      await loadCalendarList();
    } else {
      calConnected = false;
      el.className = '';
      const missing = (data.missingVars || []).join(', ');
      el.innerHTML = `
        <div style="font-size:13px;color:#f59e0b">
          <strong>未接続</strong>
          ${missing ? `<span style="color:#64748b;margin-left:8px">未設定: ${esc(missing)}</span>` : ''}
          <div style="margin-top:8px;color:#64748b">${esc(data.hint || '')}</div>
        </div>
      `;
      showCalPushConfig(false);
    }
  } catch {
    el.className = '';
    el.textContent = '確認エラー';
  }
}

function showCalPushConfig(connected) {
  document.getElementById('cal-push-config').style.display         = connected ? '' : 'none';
  document.getElementById('cal-push-not-connected').style.display  = connected ? 'none' : '';
}

document.getElementById('cal-status-refresh-btn')
  .addEventListener('click', loadCalendarStatus);

// ── カレンダー一覧取得 ────────────────────────────────────────────────────────

async function loadCalendarList() {
  const sel = document.getElementById('cal-push-calendar');
  // 既存オプション（先頭以外）をクリア
  while (sel.options.length > 1) sel.remove(1);

  try {
    const { data } = await api('GET', '/api/calendar/calendars');
    if (!data.ok) return;

    data.calendars.forEach(cal => {
      const opt = document.createElement('option');
      opt.value = cal.id;
      // 書き込み可能なもの優先表示
      const role = cal.writable ? '' : '（読み取り専用）';
      opt.textContent = `${cal.summary}${role}`;
      if (!cal.writable) opt.disabled = true;
      sel.appendChild(opt);
    });
  } catch { /* silent — status check でエラー表示済み */ }
}

// ── dry-run プレビュー ────────────────────────────────────────────────────────

document.getElementById('cal-push-preview-btn').addEventListener('click', async () => {
  const calendarId = document.getElementById('cal-push-calendar').value;
  const year       = document.getElementById('cal-push-year').value;

  if (!calendarId) {
    document.getElementById('cal-push-status').textContent = '書き込み先カレンダーを選択してください';
    return;
  }

  const statusEl = document.getElementById('cal-push-status');
  const previewEl = document.getElementById('cal-push-preview-area');
  statusEl.textContent = '解析中...';
  previewEl.hidden = true;

  try {
    const { status, data } = await api('POST', '/api/calendar/push/preview', { calendarId, year });
    if (status !== 200) {
      statusEl.textContent = `エラー: ${data.error || 'プレビュー失敗'}`;
      return;
    }

    calPushPreviewData = { calendarId, year, items: data.items };
    statusEl.textContent = '';
    renderCalPushPreview(data);
    previewEl.hidden = false;
  } catch (err) {
    statusEl.textContent = `通信エラー: ${err.message}`;
  }
});

function renderCalPushPreview(data) {
  const summaryEl = document.getElementById('cal-push-preview-summary');
  const wrapEl    = document.getElementById('cal-push-preview-table-wrap');
  const { createCount, updateCount, skipCount, items = [] } = data;

  // サマリー行
  let parts = [];
  if (createCount) parts.push(`新規作成: ${createCount}件`);
  if (updateCount) parts.push(`更新: ${updateCount}件`);
  if (skipCount)   parts.push(`スキップ: ${skipCount}件`);
  summaryEl.innerHTML = parts.length
    ? `<strong>${parts.join(' / ')}</strong>`
    : '<span style="color:#64748b">対象データがありません</span>';

  if (!items.length) { wrapEl.innerHTML = ''; return; }

  // アクション別カラー
  const actionLabel = { create: '新規作成', update: '更新', skip: 'スキップ' };
  const actionColor = { create: '#22c55e',  update: '#60a5fa', skip: '#475569' };

  const trs = items.map(item => {
    const line  = item.line || {};
    const color = actionColor[item.action] || '#94a3b8';
    const label = actionLabel[item.action] || item.action;
    const reason = item.reason ? ` <span style="color:#64748b">(${esc(item.reason)})</span>` : '';
    return `
      <tr>
        <td style="color:#94a3b8;font-size:12px;white-space:nowrap">${esc(line.work_date ?? '—')}</td>
        <td style="max-width:280px">${esc(line.description ?? '—')}</td>
        <td style="color:#64748b">${esc(line.category ?? '')}</td>
        <td><span style="color:${color};font-size:12px">${label}</span>${reason}</td>
      </tr>
    `;
  }).join('');

  wrapEl.innerHTML = `
    <table class="works-table" style="font-size:12px;min-width:500px">
      <thead><tr><th>作業日</th><th>作業内容</th><th>カテゴリ</th><th>処理</th></tr></thead>
      <tbody>${trs}</tbody>
    </table>
  `;
}

// ── 実行（Google Calendar への書き込み）──────────────────────────────────────

document.getElementById('cal-push-execute-btn').addEventListener('click', async () => {
  if (!calPushPreviewData) return;

  const btn      = document.getElementById('cal-push-execute-btn');
  const statusEl = document.getElementById('cal-push-status');
  btn.disabled   = true;
  statusEl.textContent = 'Google Calendarへ書き込み中...';

  try {
    const { status, data } = await api('POST', '/api/calendar/push/execute', {
      calendarId: calPushPreviewData.calendarId,
      year:       calPushPreviewData.year,
    });

    if (status !== 200) {
      statusEl.textContent = `エラー: ${data.error || '実行失敗'}`;
      btn.disabled = false;
      return;
    }

    statusEl.textContent =
      `完了: 作成 ${data.createdCount}件 / 更新 ${data.updatedCount}件` +
      (data.errorCount ? ` / エラー ${data.errorCount}件` : '');

    calPushPreviewData = null;
    document.getElementById('cal-push-preview-area').hidden = true;
    loadCalendarSyncRuns();
    // 接続状態の件数を更新
    loadCalendarStatus();
    btn.disabled = false;
  } catch (err) {
    statusEl.textContent = `通信エラー: ${err.message}`;
    btn.disabled = false;
  }
});

document.getElementById('cal-push-cancel-btn').addEventListener('click', () => {
  calPushPreviewData = null;
  document.getElementById('cal-push-preview-area').hidden = true;
  document.getElementById('cal-push-status').textContent = '';
});

// ── 同期履歴 ─────────────────────────────────────────────────────────────────

async function loadCalendarSyncRuns() {
  const el = document.getElementById('cal-runs-container');
  el.className   = 'loading';
  el.textContent = '読み込み中...';

  try {
    const { data } = await api('GET', '/api/calendar/sync-runs');
    if (!data.ok || !data.runs?.length) {
      el.className = '';
      el.innerHTML = '<p style="color:#64748b;font-size:13px">同期履歴がありません</p>';
      return;
    }

    const dirLabel = { push: 'JARVIS → Calendar', pull: 'Calendar → JARVIS' };
    const trs = data.runs.map(r => {
      const statusColor = r.status === 'completed' ? '#22c55e' : r.status === 'failed' ? '#ef4444' : '#f59e0b';
      return `
        <tr>
          <td style="color:#94a3b8;font-size:12px;white-space:nowrap">${esc((r.started_at || '').slice(0, 16))}</td>
          <td style="font-size:12px">${esc(dirLabel[r.direction] || r.direction)}</td>
          <td style="color:#64748b;font-size:12px">${esc(r.year_filter || '全期間')}</td>
          <td style="text-align:right">${r.created_count}</td>
          <td style="text-align:right;color:#64748b">${r.updated_count}</td>
          <td style="text-align:right;color:#64748b">${r.skipped_count}</td>
          <td><span style="color:${statusColor};font-size:12px">${r.status}</span></td>
        </tr>
      `;
    }).join('');

    el.className = '';
    el.innerHTML = `
      <table class="works-table" style="font-size:12px">
        <thead><tr><th>日時</th><th>方向</th><th>対象年</th><th>作成</th><th>更新</th><th>スキップ</th><th>状態</th></tr></thead>
        <tbody>${trs}</tbody>
      </table>
    `;
  } catch {
    el.className = '';
    el.textContent = '読み込みエラー';
  }
}

document.getElementById('cal-runs-refresh-btn')
  .addEventListener('click', loadCalendarSyncRuns);
