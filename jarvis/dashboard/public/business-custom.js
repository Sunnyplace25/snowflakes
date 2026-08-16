/**
 * Business UI adjustments
 * - Per-job invoice/payment status is hidden from the monthly workflow.
 * - Otec billing is shown as monthly totals (month-end close / next-month-end payment).
 * - Client, work-content, and income inputs remain directly editable with selectable suggestions.
 * - Adds a reliable Graph shortcut to the Business tabs.
 */
'use strict';

(function () {
  const OTEC_DEFAULT = 'オーテック';
  const OTEC_TAX_RATE = 0.10;
  const CONTENT_MONTH_LOOKBACK = 12;
  const COMMON_INCOMES = [26500, 25000, 17500, 14500, 13000];

  function isOtec(client) {
    return String(client ?? '').includes('オーテック');
  }

  function formatYen(value) {
    return Number(value || 0).toLocaleString('ja-JP') + '円';
  }

  function addOtecTax(value) {
    const base = Number(value || 0);
    const tax = Math.round(base * OTEC_TAX_RATE);
    return { base, tax, total: base + tax };
  }

  function previousMonth(ym) {
    const [year, month] = String(ym).split('-').map(Number);
    const d = new Date(year, month - 2, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  function shiftMonth(ym, delta) {
    const [year, month] = String(ym).split('-').map(Number);
    const d = new Date(year, month - 1 + delta, 1);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  function setupClientInputs() {
    if (!document.getElementById('client-suggestions')) {
      const datalist = document.createElement('datalist');
      datalist.id = 'client-suggestions';
      datalist.innerHTML = `
        <option value="オーテック"></option>
        <option value="株式会社　オーテック"></option>
      `;
      document.body.appendChild(datalist);
    }

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
    if (addButton && addClient) {
      addButton.addEventListener('click', () => {
        addClient.value = OTEC_DEFAULT;
      });
    }
  }

  function setupIncomeInputs() {
    let datalist = document.getElementById('income-suggestions');
    if (!datalist) {
      datalist = document.createElement('datalist');
      datalist.id = 'income-suggestions';
      COMMON_INCOMES.forEach(value => {
        const option = document.createElement('option');
        option.value = String(value);
        option.label = `${value.toLocaleString('ja-JP')}円`;
        datalist.appendChild(option);
      });
      document.body.appendChild(datalist);
    }

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
      : (() => {
          const d = new Date();
          return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        })();

    try {
      const months = Array.from({ length: CONTENT_MONTH_LOOKBACK }, (_, i) => shiftMonth(baseMonth, -i));
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
      // 候補取得に失敗しても直接入力はそのまま使える。
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

  function ensureGraphTab() {
    const tabs = document.getElementById('business-tabs');
    if (!tabs || tabs.querySelector('[data-business-graph]')) return;

    const button = document.createElement('button');
    button.className = 'sf-tab';
    button.type = 'button';
    button.dataset.businessGraph = '1';
    button.textContent = 'グラフ';
    button.addEventListener('click', () => {
      location.href = '/business-graph.html';
    });
    tabs.appendChild(button);
  }

  async function fetchWorks(month) {
    const response = await fetch(`/api/works?month=${encodeURIComponent(month)}`);
    const data = await response.json();
    return data.ok ? (data.works || []) : [];
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
      const [currentWorks, previousWorks] = await Promise.all([
        fetchWorks(currentMonth),
        fetchWorks(prev),
      ]);

      const billingBase = currentWorks
        .filter(w => isOtec(w.client))
        .reduce((sum, w) => sum + Number(w.income || 0), 0);

      const paymentBase = previousWorks
        .filter(w => isOtec(w.client))
        .reduce((sum, w) => sum + Number(w.income || 0), 0);

      const billing = addOtecTax(billingBase);
      const payment = addOtecTax(paymentBase);

      const billingLabel = invoiceCard.closest('.card')?.querySelector('.card-label');
      const paymentLabel = paymentCard.closest('.card')?.querySelector('.card-label');
      if (billingLabel) billingLabel.textContent = 'オーテック 当月請求額（税込10%）';
      if (paymentLabel) paymentLabel.textContent = '当月入金予定（税込・前月分）';

      const billingText = formatYen(billing.total);
      const paymentText = formatYen(payment.total);
      if (invoiceCard.textContent !== billingText) invoiceCard.textContent = billingText;
      if (paymentCard.textContent !== paymentText) paymentCard.textContent = paymentText;
      invoiceCard.title = `税抜 ${formatYen(billing.base)} + 消費税 ${formatYen(billing.tax)}`;
      paymentCard.title = `税抜 ${formatYen(payment.base)} + 消費税 ${formatYen(payment.tax)}`;
      invoiceCard.className = 'card-value green';
      paymentCard.className = 'card-value accent';
    } catch (_) {
      // 既存ダッシュボード側の表示を壊さない。
    } finally {
      updatingCards = false;
    }
  }

  let updateTimer = null;
  function scheduleRefresh() {
    clearTimeout(updateTimer);
    updateTimer = setTimeout(() => {
      hidePerJobBillingStatus();
      addCurrentContentSuggestions();
      updateMonthlyBillingCards();
    }, 80);
  }

  function init() {
    setupClientInputs();
    setupIncomeInputs();
    setupContentInputs();
    hidePerJobBillingStatus();
    ensureGraphTab();
    scheduleRefresh();

    const targets = [
      document.getElementById('works-table-container'),
      document.getElementById('current-month'),
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

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
