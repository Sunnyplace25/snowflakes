/**
 * Business UI adjustments
 * - 月単位のオーテック請求 / 入金予定を表示
 * - 発注元・仕事内容・収入・交通費・移動時間を候補 + 手入力にする
 * - 個別の請求 / 入金ステータスを月次画面から隠す
 * - 仕事削除は編集モーダル内へ移動し、確認後に削除する
 * - 保育園シフトと変更理由を仕事収支とは別管理する
 * - 既存 Excel テンプレートを使った請求書作成 UI を追加する
 */
'use strict';

(function () {
  const OTEC_DEFAULT = '株式会社　オーテック';
  const OTEC_TAX_RATE = 0.10;
  const OTEC_WITHHOLD_RATE = 0.1021;
  const CONTENT_MONTH_LOOKBACK = 12;
  const COMMON_INCOMES = [26500, 25000, 17500, 14500, 13000];
  const COMMON_TRAVEL_COSTS = [500];
  const COMMON_TRAVEL_HOURS = [0.5, 1, 2];

  function isOtec(client) {
    return String(client ?? '').includes('オーテック');
  }

  function formatYen(value) {
    return Number(value || 0).toLocaleString('ja-JP') + '円';
  }

  function escHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function localDateISO() {
    const d = new Date();
    return [
      d.getFullYear(),
      String(d.getMonth() + 1).padStart(2, '0'),
      String(d.getDate()).padStart(2, '0'),
    ].join('-');
  }

  function shiftMonthValue(ym, delta) {
    const [year, month] = String(ym).split('-').map(Number);
    const d = new Date(year, month - 1 + delta, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  function previousMonth(ym) {
    return shiftMonthValue(ym, -1);
  }

  function addOtecTax(value) {
    const base = Number(value || 0);
    const tax = Math.round(base * OTEC_TAX_RATE);
    return { base, tax, total: base + tax };
  }

  function calcWithholding(baseValue) {
    const base = Number(baseValue || 0);
    if (base <= 0) return 0;
    if (base <= 1_000_000) return Math.floor(base * OTEC_WITHHOLD_RATE);
    return Math.floor((base - 1_000_000) * 0.2042 + 102_100);
  }

  function setupStyles() {
    if (document.getElementById('business-custom-styles')) return;
    const style = document.createElement('style');
    style.id = 'business-custom-styles';
    style.textContent = `
      #module-business input[type="number"] {
        -moz-appearance: textfield;
        appearance: textfield;
      }
      #module-business input[type="number"]::-webkit-outer-spin-button,
      #module-business input[type="number"]::-webkit-inner-spin-button {
        -webkit-appearance: none;
        margin: 0;
      }
      .business-muted-note {
        color: #64748b;
        font-size: 12px;
        line-height: 1.65;
      }
      .business-form-inline {
        display: flex;
        gap: 12px;
        align-items: end;
        flex-wrap: wrap;
      }
      .business-form-inline .form-group {
        min-width: 150px;
        margin: 0;
      }
      .business-subpanel {
        background: #0f172a;
        border: 1px solid #1e293b;
        border-radius: 7px;
        padding: 14px 16px;
        margin-top: 14px;
      }
      .nursery-status {
        display: inline-block;
        border-radius: 999px;
        padding: 2px 8px;
        font-size: 11px;
        background: #1e293b;
        color: #cbd5e1;
      }
      .nursery-status.changed { color: #93c5fd; }
      .nursery-status.off { color: #c4b5fd; }
      .edit-delete-btn {
        margin-right: auto;
        opacity: .72;
        color: #cbd5e1;
      }
      .edit-delete-btn:hover {
        opacity: 1;
        color: #fca5a5;
        border-color: #7f1d1d;
      }
      #invoice-gen-preview .works-table,
      #nursery-shift-container .works-table {
        font-size: 12px;
      }
      #invoice-template-status.configured { color: #86efac; }
      #invoice-template-status.missing { color: #fbbf24; }
    `;
    document.head.appendChild(style);
  }

  function ensureDatalist(id, values, labeler = null) {
    let datalist = document.getElementById(id);
    if (!datalist) {
      datalist = document.createElement('datalist');
      datalist.id = id;
      document.body.appendChild(datalist);
    }
    datalist.innerHTML = '';
    values.forEach(value => {
      const option = document.createElement('option');
      option.value = String(value);
      if (labeler) option.label = labeler(value);
      datalist.appendChild(option);
    });
    return datalist;
  }

  function setupClientInputs() {
    ensureDatalist('client-suggestions', [OTEC_DEFAULT]);
    for (const id of ['work-client', 'edit-work-client']) {
      const input = document.getElementById(id);
      if (!input) continue;
      input.setAttribute('list', 'client-suggestions');
      input.setAttribute('autocomplete', 'off');
      input.placeholder = '選択または直接入力';
      const label = document.querySelector(`label[for="${id}"]`);
      if (label) label.textContent = '発注元（選択 / 直接入力）';
    }

    const addButton = document.getElementById('add-work-btn');
    const addClient = document.getElementById('work-client');
    if (addButton && addClient && !addButton.dataset.otecDefaultBound) {
      addButton.dataset.otecDefaultBound = '1';
      addButton.addEventListener('click', () => {
        addClient.value = OTEC_DEFAULT;
      });
    }
  }

  function setupIncomeInputs() {
    ensureDatalist(
      'income-suggestions',
      COMMON_INCOMES,
      value => `${Number(value).toLocaleString('ja-JP')}円`,
    );
    for (const id of ['work-income', 'edit-work-income']) {
      const input = document.getElementById(id);
      if (!input) continue;
      input.setAttribute('list', 'income-suggestions');
      input.setAttribute('autocomplete', 'off');
      input.placeholder = '候補から選択、または直接入力';
      const label = document.querySelector(`label[for="${id}"]`);
      if (label) label.textContent = '収入（選択 / 直接入力）';
    }
  }

  function setupTravelCostInputs() {
    ensureDatalist(
      'travel-cost-suggestions',
      COMMON_TRAVEL_COSTS,
      value => `${Number(value).toLocaleString('ja-JP')}円`,
    );
    for (const id of ['work-expense', 'edit-work-expense']) {
      const input = document.getElementById(id);
      if (!input) continue;
      input.setAttribute('list', 'travel-cost-suggestions');
      input.setAttribute('autocomplete', 'off');
      input.placeholder = '500円または直接入力';
      const label = document.querySelector(`label[for="${id}"]`);
      if (label) label.textContent = '交通費（選択 / 直接入力）';
    }
  }

  function setupTravelHourInputs() {
    ensureDatalist(
      'travel-hour-suggestions',
      COMMON_TRAVEL_HOURS,
      value => `${value}時間`,
    );
    for (const id of ['travel-hours', 'edit-travel-hours']) {
      const input = document.getElementById(id);
      if (!input) continue;
      input.setAttribute('list', 'travel-hour-suggestions');
      input.setAttribute('autocomplete', 'off');
      input.placeholder = '0.5 / 1 / 2 または直接入力';
      const label = document.querySelector(`label[for="${id}"]`);
      if (label) label.textContent = '移動時間（h・選択 / 直接入力）';
    }
  }

  function relabelTravelCostUi() {
    const expenseCard = document.getElementById('card-expense');
    const expenseCardLabel = expenseCard?.closest('.card')?.querySelector('.card-label');
    if (expenseCardLabel) expenseCardLabel.textContent = '交通費';
    document.querySelectorAll('.works-table th.col-expense').forEach(th => {
      th.textContent = '交通費';
    });
  }

  async function fetchWorks(month) {
    const response = await fetch(`/api/works?month=${encodeURIComponent(month)}`);
    const data = await response.json();
    return data.ok ? (data.works || []) : [];
  }

  async function setupContentInputs() {
    let datalist = document.getElementById('content-suggestions');
    if (!datalist) {
      datalist = document.createElement('datalist');
      datalist.id = 'content-suggestions';
      document.body.appendChild(datalist);
    }

    for (const id of ['work-content', 'edit-work-content']) {
      const input = document.getElementById(id);
      if (!input) continue;
      input.setAttribute('list', 'content-suggestions');
      input.setAttribute('autocomplete', 'off');
      input.placeholder = '過去の仕事内容から選択、または直接入力';
      const label = document.querySelector(`label[for="${id}"]`);
      if (label) label.textContent = '仕事内容（選択 / 直接入力）';
    }

    const baseMonth = (typeof currentMonth !== 'undefined' && /^\d{4}-\d{2}$/.test(currentMonth))
      ? currentMonth
      : localDateISO().slice(0, 7);

    try {
      const months = Array.from({ length: CONTENT_MONTH_LOOKBACK }, (_, i) => shiftMonthValue(baseMonth, -i));
      const rowsByMonth = await Promise.all(months.map(fetchWorks));
      const counts = new Map();
      rowsByMonth.flat().forEach(w => {
        const value = String(w.content ?? '').trim();
        if (!value) return;
        counts.set(value, (counts.get(value) || 0) + 1);
      });
      const values = [...counts.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'ja'))
        .slice(0, 50)
        .map(([value]) => value);
      datalist.innerHTML = '';
      values.forEach(value => {
        const option = document.createElement('option');
        option.value = value;
        datalist.appendChild(option);
      });
    } catch (_) {
      // 取得に失敗しても直接入力は利用可能。
    }
  }

  function addCurrentContentSuggestions() {
    const datalist = document.getElementById('content-suggestions');
    if (!datalist || typeof currentWorks === 'undefined' || !Array.isArray(currentWorks)) return;
    const existing = new Set([...datalist.options].map(o => o.value));
    currentWorks.forEach(w => {
      const value = String(w.content ?? '').trim();
      if (!value || existing.has(value)) return;
      const option = document.createElement('option');
      option.value = value;
      datalist.appendChild(option);
      existing.add(value);
    });
  }

  function hidePerJobBillingStatus() {
    document.querySelectorAll('.works-table .col-status').forEach(el => {
      el.style.display = 'none';
    });
    for (const id of ['work-invoice', 'work-payment', 'edit-work-invoice', 'edit-work-payment']) {
      const el = document.getElementById(id);
      const group = el?.closest('.form-group');
      if (group) group.style.display = 'none';
    }
  }

  function setupEditDeleteButton() {
    // 旧版で一覧に追加された削除ボタンが残っていても消す。
    document.querySelectorAll('.work-delete-btn').forEach(btn => btn.remove());

    const form = document.getElementById('edit-work-form');
    const actions = form?.querySelector('.modal-actions');
    if (!form || !actions || document.getElementById('edit-work-delete-btn')) return;

    const button = document.createElement('button');
    button.id = 'edit-work-delete-btn';
    button.type = 'button';
    button.className = 'btn btn-secondary edit-delete-btn';
    button.textContent = '削除';
    actions.insertBefore(button, actions.firstChild);

    button.addEventListener('click', async () => {
      const id = Number(document.getElementById('edit-work-id')?.value);
      if (!Number.isInteger(id) || id <= 0) return;
      const work = (typeof currentWorks !== 'undefined' && Array.isArray(currentWorks))
        ? currentWorks.find(w => Number(w.id) === id)
        : null;
      const label = [work?.date, work?.content].filter(Boolean).join('　') || 'この仕事';
      if (!window.confirm(`${label}\n\nこの登録を削除しますか？\n削除後は元に戻せません。`)) return;

      button.disabled = true;
      button.textContent = '削除中';
      try {
        const response = await fetch(`/api/work/${id}`, { method: 'DELETE' });
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error(data.error || '削除に失敗しました');
        if (typeof hideModal === 'function') hideModal();
        if (typeof refresh === 'function') await refresh();
      } catch (e) {
        alert('削除に失敗しました: ' + e.message);
      } finally {
        button.disabled = false;
        button.textContent = '削除';
      }
    });
  }

let updatingCards = false;
  async function updateMonthlyBillingCards() {
    if (updatingCards) return;
    if (typeof currentMonth === 'undefined' || !/^\d{4}-\d{2}$/.test(currentMonth)) return;

    const invoiceCard = document.getElementById('card-uninvoiced');
    const paymentCard = document.getElementById('card-unpaid');
    if (!invoiceCard || !paymentCard) return;

    updatingCards = true;
    try {
      const prev = previousMonth(currentMonth);
      const [currentRows, previousRows] = await Promise.all([
        fetchWorks(currentMonth),
        fetchWorks(prev),
      ]);

      const billingBase = currentRows
        .filter(w => isOtec(w.client))
        .reduce((sum, w) => sum + Number(w.income || 0), 0);
      const paymentBase = previousRows
        .filter(w => isOtec(w.client))
        .reduce((sum, w) => sum + Number(w.income || 0), 0);

      const billing = addOtecTax(billingBase);
      // 入金予定: 税抜 + 消費税10% - floor(税抜 × 10.21%)
      const paymentTax  = Math.floor(paymentBase * OTEC_TAX_RATE);
      const withholding = calcWithholding(paymentBase);
      const paymentNet  = paymentBase + paymentTax - withholding;

      const billingLabel = invoiceCard.closest('.card')?.querySelector('.card-label');
      const paymentLabel = paymentCard.closest('.card')?.querySelector('.card-label');
      if (billingLabel) billingLabel.textContent = 'オーテック 当月請求額（税込10%）';
      if (paymentLabel) paymentLabel.textContent = '当月入金予定（源泉控除後・前月分）';

      invoiceCard.textContent = formatYen(billing.total);
      paymentCard.textContent = formatYen(paymentNet);
      invoiceCard.title = `税抜 ${formatYen(billing.base)} + 消費税 ${formatYen(billing.tax)}`;
      paymentCard.title = `税抜 ${formatYen(paymentBase)} + 消費税 ${formatYen(paymentTax)} - 源泉徴収 ${formatYen(withholding)}`;
      invoiceCard.className = 'card-value green';
      paymentCard.className = 'card-value accent';
    } catch (_) {
      // 既存画面を壊さない。
    } finally {
      updatingCards = false;
    }
  }

  // ─── 保育園シフト ────────────────────────────────────────────────────────

  let nurseryShifts = [];
  let lastNurseryMonth = null;

  function shiftText(start, end) {
    if (!start && !end) return '—';
    if (start && end) return `${start}–${end}`;
    return start || end || '—';
  }

  function ensureNurseryShiftUi() {
    if (document.getElementById('nursery-shift-section')) return;
    const worksContainer = document.getElementById('works-table-container');
    const worksSection = worksContainer?.closest('.section');
    if (!worksSection) return;

    const section = document.createElement('section');
    section.className = 'section';
    section.id = 'nursery-shift-section';
    section.innerHTML = `
      <div class="section-header">
        <h2>保育園シフト</h2>
        <button class="btn btn-secondary" id="add-nursery-shift-btn">＋ シフトを登録</button>
      </div>
      <div id="nursery-shift-container" class="loading">読み込み中...</div>
    `;
    worksSection.parentNode.insertBefore(section, worksSection);

    const overlay = document.getElementById('modal-overlay');
    if (!overlay || document.getElementById('modal-nursery-shift')) return;
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.id = 'modal-nursery-shift';
    modal.hidden = true;
    modal.innerHTML = `
      <h3 id="nursery-modal-title">保育園シフトを登録</h3>
      <form id="nursery-shift-form" autocomplete="off">
        <input type="hidden" id="nursery-shift-id">
        <div class="form-grid">
          <div class="form-group">
            <label for="nursery-date">日付 *</label>
            <input type="date" id="nursery-date" required>
          </div>
          <div class="form-group">
            <label for="nursery-status">状態</label>
            <select id="nursery-status">
              <option value="通常">通常</option>
              <option value="変更">変更</option>
              <option value="休み">休み</option>
              <option value="有給">有給</option>
            </select>
          </div>
          <div class="form-group">
            <label for="nursery-original-start">元の開始</label>
            <input type="time" id="nursery-original-start">
          </div>
          <div class="form-group">
            <label for="nursery-original-end">元の終了</label>
            <input type="time" id="nursery-original-end">
          </div>
          <div class="form-group nursery-change-field">
            <label for="nursery-changed-start">変更後の開始</label>
            <input type="time" id="nursery-changed-start">
          </div>
          <div class="form-group nursery-change-field">
            <label for="nursery-changed-end">変更後の終了</label>
            <input type="time" id="nursery-changed-end">
          </div>
          <div class="form-group form-full nursery-change-field">
            <label for="nursery-reason">変更理由</label>
            <select id="nursery-reason">
              <option value="">—</option>
              <option value="音声仕事優先">音声仕事優先</option>
              <option value="園都合">園都合</option>
              <option value="自分都合">自分都合</option>
              <option value="その他">その他</option>
            </select>
          </div>
          <div class="form-group form-full">
            <label for="nursery-memo">メモ</label>
            <textarea id="nursery-memo" placeholder="例：みんテレ／帰宅20時すぎ"></textarea>
          </div>
        </div>
        <div class="error-msg" id="nursery-error"></div>
        <div class="modal-actions">
          <button type="button" class="btn btn-secondary edit-delete-btn" id="nursery-delete-btn" hidden>削除</button>
          <button type="button" class="btn btn-secondary" id="nursery-cancel-btn">キャンセル</button>
          <button type="submit" class="btn btn-primary">保存する</button>
        </div>
      </form>
    `;
    overlay.appendChild(modal);

    document.getElementById('add-nursery-shift-btn')?.addEventListener('click', () => openNurseryModal(null));
    document.getElementById('nursery-cancel-btn')?.addEventListener('click', closeNurseryModal);
    document.getElementById('nursery-status')?.addEventListener('change', updateNurseryChangeFields);
    document.getElementById('nursery-shift-form')?.addEventListener('submit', saveNurseryShift);
    document.getElementById('nursery-delete-btn')?.addEventListener('click', deleteNurseryShiftEntry);
  }

  function updateNurseryChangeFields() {
    const status = document.getElementById('nursery-status')?.value;
    document.querySelectorAll('#modal-nursery-shift .nursery-change-field').forEach(el => {
      el.style.display = status === '変更' ? '' : 'none';
    });
  }

  function showNurseryModal() {
    const overlay = document.getElementById('modal-overlay');
    const modal = document.getElementById('modal-nursery-shift');
    if (!overlay || !modal) return;
    overlay.removeAttribute('hidden');
    document.querySelectorAll('#modal-overlay .modal').forEach(m => { m.hidden = true; });
    modal.hidden = false;
  }

  function closeNurseryModal() {
    const overlay = document.getElementById('modal-overlay');
    if (overlay) overlay.setAttribute('hidden', '');
  }

  function openNurseryModal(shift) {
    const month = (typeof currentMonth !== 'undefined' && /^\d{4}-\d{2}$/.test(currentMonth))
      ? currentMonth : localDateISO().slice(0, 7);
    const today = localDateISO();
    const defaultDate = today.startsWith(month) ? today : `${month}-01`;

    document.getElementById('nursery-modal-title').textContent = shift ? '保育園シフトを編集' : '保育園シフトを登録';
    document.getElementById('nursery-shift-id').value = shift?.id || '';
    document.getElementById('nursery-date').value = shift?.date || defaultDate;
    document.getElementById('nursery-status').value = shift?.status || '通常';
    document.getElementById('nursery-original-start').value = shift?.original_start || '';
    document.getElementById('nursery-original-end').value = shift?.original_end || '';
    document.getElementById('nursery-changed-start').value = shift?.changed_start || '';
    document.getElementById('nursery-changed-end').value = shift?.changed_end || '';
    document.getElementById('nursery-reason').value = shift?.change_reason || '';
    document.getElementById('nursery-memo').value = shift?.memo || '';
    document.getElementById('nursery-error').textContent = '';
    document.getElementById('nursery-delete-btn').hidden = !shift;
    updateNurseryChangeFields();
    showNurseryModal();
  }

  async function loadNurseryShifts(force = false) {
    ensureNurseryShiftUi();
    if (typeof currentMonth === 'undefined' || !/^\d{4}-\d{2}$/.test(currentMonth)) return;
    if (!force && lastNurseryMonth === currentMonth) return;
    lastNurseryMonth = currentMonth;

    const container = document.getElementById('nursery-shift-container');
    if (!container) return;
    container.className = 'loading';
    container.textContent = '読み込み中...';

    try {
      const response = await fetch(`/api/nursery-shifts?month=${encodeURIComponent(currentMonth)}`);
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || '読み込みに失敗しました');
      nurseryShifts = data.shifts || [];
      renderNurseryShifts();
    } catch (e) {
      container.className = '';
      container.textContent = '読み込みエラー: ' + e.message;
    }
  }

  function renderNurseryShifts() {
    const container = document.getElementById('nursery-shift-container');
    if (!container) return;
    container.className = '';
    if (!nurseryShifts.length) {
      container.innerHTML = '<div class="empty-state">この月の保育園シフトはまだありません</div>';
      return;
    }

    const rows = nurseryShifts.map(s => {
      let shift = shiftText(s.original_start, s.original_end);
      if (s.status === '変更') shift += ` → ${shiftText(s.changed_start, s.changed_end)}`;
      if (s.status === '休み') shift += ' → 休み';
      if (s.status === '有給') shift += ' → 有給';
      const statusClass = s.status === '変更' ? 'changed' : (s.status === '休み' || s.status === '有給' ? 'off' : '');
      return `
        <tr>
          <td style="white-space:nowrap">${escHtml(s.date)}</td>
          <td>${escHtml(shift)}</td>
          <td>
            <span class="nursery-status ${statusClass}">${escHtml(s.status)}</span>
            ${s.change_reason ? `<div style="margin-top:4px;color:#94a3b8">${escHtml(s.change_reason)}</div>` : ''}
          </td>
          <td>${escHtml(s.memo || '—')}</td>
          <td style="text-align:right"><button class="btn btn-secondary btn-sm" data-nursery-edit="${s.id}">編集</button></td>
        </tr>
      `;
    }).join('');

    container.innerHTML = `
      <table class="works-table">
        <thead><tr><th>日付</th><th>シフト</th><th>状態 / 理由</th><th>メモ</th><th></th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
    `;
    container.querySelectorAll('[data-nursery-edit]').forEach(btn => {
      btn.addEventListener('click', () => {
        const shift = nurseryShifts.find(s => Number(s.id) === Number(btn.dataset.nurseryEdit));
        if (shift) openNurseryModal(shift);
      });
    });
  }

  async function saveNurseryShift(event) {
    event.preventDefault();
    const id = Number(document.getElementById('nursery-shift-id').value || 0);
    const body = {
      date: document.getElementById('nursery-date').value,
      status: document.getElementById('nursery-status').value,
      original_start: document.getElementById('nursery-original-start').value || null,
      original_end: document.getElementById('nursery-original-end').value || null,
      changed_start: document.getElementById('nursery-changed-start').value || null,
      changed_end: document.getElementById('nursery-changed-end').value || null,
      change_reason: document.getElementById('nursery-reason').value || null,
      memo: document.getElementById('nursery-memo').value.trim() || null,
    };
    const error = document.getElementById('nursery-error');
    error.textContent = '';
    try {
      const response = await fetch(id ? `/api/nursery-shift/${id}` : '/api/nursery-shift', {
        method: id ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || '保存に失敗しました');
      closeNurseryModal();
      lastNurseryMonth = null;
      await loadNurseryShifts(true);
    } catch (e) {
      error.textContent = e.message;
    }
  }

  async function deleteNurseryShiftEntry() {
    const id = Number(document.getElementById('nursery-shift-id').value || 0);
    if (!id) return;
    const shift = nurseryShifts.find(s => Number(s.id) === id);
    const label = shift ? `${shift.date} の保育園シフト` : 'この保育園シフト';
    if (!window.confirm(`${label}\n\n削除しますか？\n削除後は元に戻せません。`)) return;
    try {
      const response = await fetch(`/api/nursery-shift/${id}`, { method: 'DELETE' });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || '削除に失敗しました');
      closeNurseryModal();
      lastNurseryMonth = null;
      await loadNurseryShifts(true);
    } catch (e) {
      document.getElementById('nursery-error').textContent = e.message;
    }
  }

  // ─── 請求書作成 ──────────────────────────────────────────────────────────

  let invoiceTemplateConfigured = false;
  let currentInvoicePreview = null;

  function ensureInvoiceGeneratorUi() {
    const panel = document.getElementById('audio-subtab-invoice-gen');
    if (!panel || document.getElementById('invoice-generator-section')) return;

    const section = document.createElement('section');
    section.className = 'section';
    section.id = 'invoice-generator-section';
    section.innerHTML = `
      <div class="section-header">
        <h2>請求書作成</h2>
        <span class="sf-note">仕事一覧 → Excel</span>
      </div>
      <div class="business-form-inline">
        <div class="form-group">
          <label for="invoice-gen-month">請求対象月</label>
          <input type="month" id="invoice-gen-month">
        </div>
        <button class="btn btn-secondary" id="invoice-gen-preview-btn">内容を確認</button>
        <div style="margin-left:auto;display:flex;align-items:center;gap:10px;flex-wrap:wrap">
          <span id="invoice-template-status" class="business-muted-note">テンプレート確認中...</span>
          <button class="btn btn-secondary" id="invoice-template-btn">Excelテンプレートを設定</button>
          <input type="file" id="invoice-template-file" accept=".xlsx" hidden>
        </div>
      </div>
      <div class="business-muted-note" style="margin-top:10px">
        今使っている Google スプレッドシートは、初回だけ「Microsoft Excel（.xlsx）」で保存して設定すればOKです。
        テンプレートと生成請求書は個人情報を含むため GitHub には保存しません。送付用ファイルには請求書シートだけを入れます。
      </div>
      <div id="invoice-gen-status" class="business-muted-note" style="margin-top:10px"></div>
      <div id="invoice-gen-preview" class="business-subpanel" hidden></div>
    `;
    panel.insertBefore(section, panel.firstChild);

    const monthInput = document.getElementById('invoice-gen-month');
    monthInput.value = (typeof currentMonth !== 'undefined' && /^\d{4}-\d{2}$/.test(currentMonth))
      ? currentMonth : localDateISO().slice(0, 7);

    document.getElementById('invoice-template-btn').addEventListener('click', () => {
      document.getElementById('invoice-template-file').click();
    });
    document.getElementById('invoice-template-file').addEventListener('change', handleInvoiceTemplateFile);
    document.getElementById('invoice-gen-preview-btn').addEventListener('click', loadInvoiceGenerationPreview);
    loadInvoiceTemplateStatus();
  }

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const CHUNK = 8192;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    return btoa(binary);
  }

  async function loadInvoiceTemplateStatus() {
    const status = document.getElementById('invoice-template-status');
    if (!status) return;
    try {
      const response = await fetch('/api/invoice/template-status');
      const data = await response.json();
      invoiceTemplateConfigured = !!data.configured;
      status.textContent = data.configured ? 'テンプレート設定済み' : 'テンプレート未設定';
      status.className = data.configured ? 'business-muted-note configured' : 'business-muted-note missing';
    } catch (_) {
      status.textContent = 'テンプレート状態を確認できません';
    }
  }

  async function handleInvoiceTemplateFile(event) {
    const file = event.target.files?.[0];
    if (!file) return;
    const status = document.getElementById('invoice-gen-status');
    status.textContent = 'テンプレートを設定中...';
    try {
      const buffer = await file.arrayBuffer();
      const response = await fetch('/api/invoice/template', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.name, data_b64: arrayBufferToBase64(buffer) }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || 'テンプレート設定に失敗しました');
      status.textContent = `テンプレートを設定しました（使用シート：${data.sourceSheet || '請求書'}）`;
      await loadInvoiceTemplateStatus();
    } catch (e) {
      status.textContent = 'エラー: ' + e.message;
    } finally {
      event.target.value = '';
    }
  }

  async function loadInvoiceGenerationPreview() {
    const month = document.getElementById('invoice-gen-month')?.value;
    const status = document.getElementById('invoice-gen-status');
    const previewEl = document.getElementById('invoice-gen-preview');
    if (!month || !previewEl) return;
    status.textContent = '請求内容を確認中...';
    previewEl.hidden = true;

    try {
      const response = await fetch(`/api/invoice/generate-preview?month=${encodeURIComponent(month)}`);
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || '確認に失敗しました');
      currentInvoicePreview = data;
      renderInvoiceGenerationPreview(data);
      previewEl.hidden = false;
      status.textContent = data.rows.length
        ? `${data.rows.length}件の仕事を請求対象にしています。`
        : 'この月にオーテックの請求対象仕事がありません。';
    } catch (e) {
      status.textContent = 'エラー: ' + e.message;
    }
  }

  function invoiceDefaultFilename(invoiceDate) {
    if (!invoiceDate || !/^\d{4}-\d{2}/.test(invoiceDate)) return '';
    const [y, m] = invoiceDate.split('-').map(Number);
    return `${y}年${m}月_請求書_大和谷しおり.xlsx`;
  }

  function renderInvoiceGenerationPreview(data) {
    const el = document.getElementById('invoice-gen-preview');
    if (!el) return;
    const rows = (data.rows || []).map(r => `
      <tr>
        <td>${r.no}</td>
        <td style="white-space:nowrap">${escHtml(r.date)}</td>
        <td style="white-space:nowrap">${escHtml(r.description)}</td>
        <td style="text-align:right;white-space:nowrap">${formatYen(r.unit_price)}</td>
      </tr>
    `).join('');

    const defaultFn = invoiceDefaultFilename(data.invoice_date);
    el.innerHTML = `
      <div class="business-form-inline" style="margin-bottom:14px">
        <div class="form-group">
          <label for="invoice-gen-number">請求書番号</label>
          <input type="text" id="invoice-gen-number" value="${escHtml(data.invoice_number)}">
        </div>
        <div class="form-group">
          <label for="invoice-gen-date">請求日</label>
          <input type="date" id="invoice-gen-date" value="${escHtml(data.invoice_date)}">
        </div>
        <div class="form-group">
          <label for="invoice-gen-due">支払期限</label>
          <input type="date" id="invoice-gen-due" value="${escHtml(data.due_date)}">
        </div>
        <div class="form-group form-full">
          <label for="invoice-gen-filename">出力ファイル名</label>
          <input type="text" id="invoice-gen-filename"
                 value="${escHtml(defaultFn)}"
                 placeholder="空欄で請求日から自動生成（.xlsx 自動付与）">
        </div>
      </div>
      ${rows ? `
        <div style="overflow-x:auto">
          <table class="works-table">
            <thead><tr><th>No.</th><th>日付</th><th>明細</th><th>単価</th></tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      ` : '<div class="empty-state">請求対象がありません</div>'}
      <div style="display:flex;justify-content:flex-end;gap:20px;margin-top:14px;flex-wrap:wrap">
        <span>税抜 <strong>${formatYen(data.subtotal)}</strong></span>
        <span>消費税10% <strong>${formatYen(data.tax)}</strong></span>
        <span>請求額 <strong>${formatYen(data.total)}</strong></span>
      </div>
      <div class="business-muted-note" style="margin-top:10px">
        源泉徴収は請求書の金額からは引かず、JARVISの「入金予定」で控除後の金額を表示します。
      </div>
      <div style="display:flex;justify-content:flex-end;margin-top:14px">
        <button class="btn btn-primary" id="invoice-gen-download-btn" ${(!invoiceTemplateConfigured || !rows) ? 'disabled' : ''}>Excel請求書を作成</button>
      </div>
    `;
    document.getElementById('invoice-gen-download-btn')?.addEventListener('click', generateInvoiceExcel);

    // 請求日変更時にファイル名を自動更新（ユーザーが手動変更した場合は追従しない）
    const dateInput = document.getElementById('invoice-gen-date');
    const fnInput = document.getElementById('invoice-gen-filename');
    if (dateInput && fnInput) {
      fnInput.addEventListener('input', () => { fnInput.dataset.userModified = '1'; });
      dateInput.addEventListener('change', () => {
        if (!fnInput.dataset.userModified) {
          fnInput.value = invoiceDefaultFilename(dateInput.value);
        }
      });
    }
  }

  async function generateInvoiceExcel() {
    if (!currentInvoicePreview) return;
    const button = document.getElementById('invoice-gen-download-btn');
    const status = document.getElementById('invoice-gen-status');
    button.disabled = true;
    status.textContent = 'Excel請求書を作成中...';

    try {
      const body = {
        month: document.getElementById('invoice-gen-month').value,
        invoice_number: document.getElementById('invoice-gen-number').value.trim(),
        invoice_date: document.getElementById('invoice-gen-date').value,
        due_date: document.getElementById('invoice-gen-due').value,
        output_filename: document.getElementById('invoice-gen-filename')?.value.trim() || '',
      };
      const response = await fetch('/api/invoice/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || '請求書作成に失敗しました');
      }

      const blob = await response.blob();
      const disposition = response.headers.get('Content-Disposition') || '';
      const match = disposition.match(/filename\*=UTF-8''([^;]+)/i);
      const filename = match ? decodeURIComponent(match[1]) : `請求書_${body.month.replace('-', '')}.xlsx`;
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      status.textContent = `作成しました：${filename}`;
      await loadInvoiceGenerationPreview();
    } catch (e) {
      status.textContent = 'エラー: ' + e.message;
    } finally {
      button.disabled = false;
    }
  }

  function syncInvoiceMonthInput() {
    const input = document.getElementById('invoice-gen-month');
    if (!input || document.activeElement === input) return;
    if (typeof currentMonth !== 'undefined' && /^\d{4}-\d{2}$/.test(currentMonth)) {
      input.value = currentMonth;
    }
  }

  // ─── 再描画 ──────────────────────────────────────────────────────────────

  let updateTimer = null;
  function scheduleRefresh() {
    clearTimeout(updateTimer);
    updateTimer = setTimeout(() => {
      hidePerJobBillingStatus();
      relabelTravelCostUi();
      addCurrentContentSuggestions();
      setupEditDeleteButton();
      ensureNurseryShiftUi();
      ensureInvoiceGeneratorUi();
      syncInvoiceMonthInput();
      loadNurseryShifts();
      updateMonthlyBillingCards();
    }, 80);
  }

  function init() {
    setupStyles();
    setupClientInputs();
    setupIncomeInputs();
    setupTravelCostInputs();
    setupTravelHourInputs();
    setupContentInputs();
    hidePerJobBillingStatus();
    relabelTravelCostUi();
    setupEditDeleteButton();
    ensureNurseryShiftUi();
    ensureInvoiceGeneratorUi();
    scheduleRefresh();

    const targets = [
      document.getElementById('works-table-container'),
      document.getElementById('current-month'),
      document.getElementById('card-expense'),
      document.getElementById('card-uninvoiced'),
      document.getElementById('card-unpaid'),
    ].filter(Boolean);

    const observer = new MutationObserver(scheduleRefresh);
    targets.forEach(target => observer.observe(target, {
      childList: true,
      subtree: true,
      characterData: true,
    }));
  }

  // switchAudioSubTab('invoice-gen') 時に app.js から呼べるよう公開
  window.__jarvisEnsureInvoiceGen = ensureInvoiceGeneratorUi;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
