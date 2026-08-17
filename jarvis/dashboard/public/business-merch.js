/**
 * Business 物販台帳
 * - 物販は月次の仕事一覧・収支から分離して専用タブで管理
 * - データ自体は work_records(category='物販') に保持
 * - 統計グラフでは他カテゴリと合わせて全体集計する
 */
'use strict';

(function () {
  let merchRows = [];
  let loadedMonth = null;

  const yen = value => Number(value || 0).toLocaleString('ja-JP') + '円';
  const esc = value => String(value ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

  function todayISO() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function monthValue() {
    return (typeof currentMonth !== 'undefined' && /^\d{4}-\d{2}$/.test(currentMonth))
      ? currentMonth : todayISO().slice(0, 7);
  }

  async function fetchMonthWorks() {
    const response = await fetch(`/api/works?month=${encodeURIComponent(monthValue())}`);
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || '読み込みに失敗しました');
    return data.works || [];
  }

  function ensureUi() {
    const tabs = document.getElementById('business-tabs');
    if (tabs && !document.getElementById('business-merch-tab')) {
      const btn = document.createElement('button');
      btn.id = 'business-merch-tab';
      btn.className = 'sf-tab';
      btn.type = 'button';
      btn.textContent = '物販';
      btn.dataset.businessMerch = '1';
      tabs.appendChild(btn);
      btn.addEventListener('click', openMerchTab);

      // 既存タブへ戻ったときは物販パネルを必ず閉じる。
      tabs.querySelectorAll('[data-biz-tab]').forEach(existing => {
        existing.addEventListener('click', () => {
          const panel = document.getElementById('biz-tab-merch');
          if (panel) panel.hidden = true;
          btn.classList.remove('active');
        });
      });
    }

    if (!document.getElementById('biz-tab-merch')) {
      const monthly = document.getElementById('biz-tab-monthly');
      if (!monthly) return;
      const panel = document.createElement('div');
      panel.id = 'biz-tab-merch';
      panel.className = 'sf-tab-panel';
      panel.hidden = true;
      panel.innerHTML = `
        <section class="section">
          <div class="section-header">
            <h2>物販</h2>
            <button class="btn btn-primary" id="merch-add-btn">＋ 物販を登録</button>
          </div>
          <div class="business-muted-note" style="margin-bottom:12px">
            物販売上は月次の仕事収入とは分けて表示します。統計グラフでは全カテゴリをまとめて確認できます。
          </div>
          <div id="merch-container" class="loading">読み込み中...</div>
        </section>
      `;
      monthly.parentNode.insertBefore(panel, monthly.nextSibling);
      document.getElementById('merch-add-btn')?.addEventListener('click', () => openModal(null));
    }

    const overlay = document.getElementById('modal-overlay');
    if (!overlay || document.getElementById('modal-merch')) return;
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.id = 'modal-merch';
    modal.hidden = true;
    modal.innerHTML = `
      <h3 id="merch-modal-title">物販を登録</h3>
      <form id="merch-form" autocomplete="off">
        <input type="hidden" id="merch-id">
        <div class="form-grid">
          <div class="form-group"><label for="merch-date">日付 *</label><input type="date" id="merch-date" required></div>
          <div class="form-group form-full"><label for="merch-content">商品・内容</label><input type="text" id="merch-content" placeholder="例：Snow flakes グッズ"></div>
          <div class="form-group"><label for="merch-income">売上（円）</label><input type="number" id="merch-income" min="0" placeholder="0"></div>
          <div class="form-group"><label for="merch-expense">原価・経費（円）</label><input type="number" id="merch-expense" min="0" placeholder="0"></div>
          <div class="form-group form-full"><label for="merch-memo">メモ</label><textarea id="merch-memo" placeholder="販売場所・個数など"></textarea></div>
        </div>
        <div class="error-msg" id="merch-error"></div>
        <div class="modal-actions">
          <button type="button" class="btn btn-secondary edit-delete-btn" id="merch-delete-btn" hidden>削除</button>
          <button type="button" class="btn btn-secondary" id="merch-cancel-btn">キャンセル</button>
          <button type="submit" class="btn btn-primary">保存する</button>
        </div>
      </form>
    `;
    overlay.appendChild(modal);
    document.getElementById('merch-cancel-btn').addEventListener('click', closeModal);
    document.getElementById('merch-form').addEventListener('submit', saveMerch);
    document.getElementById('merch-delete-btn').addEventListener('click', deleteMerch);
  }

  function openMerchTab() {
    document.querySelectorAll('#module-business .sf-tab-panel').forEach(p => { p.hidden = true; });
    const panel = document.getElementById('biz-tab-merch');
    if (panel) panel.hidden = false;
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
  function closeModal() { document.getElementById('modal-overlay')?.setAttribute('hidden', ''); }

  function openModal(row) {
    const month = monthValue();
    const today = todayISO();
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

  async function loadMerch(force = false) {
    ensureUi();
    const month = monthValue();
    if (!force && loadedMonth === month) return;
    loadedMonth = month;
    const container = document.getElementById('merch-container');
    if (!container) return;
    try {
      const works = await fetchMonthWorks();
      merchRows = works.filter(w => w.category === '物販');
      render();
    } catch (e) {
      container.className = '';
      container.textContent = '読み込みエラー: ' + e.message;
    }
  }

  function render() {
    const container = document.getElementById('merch-container');
    if (!container) return;
    container.className = '';
    const sales = merchRows.reduce((s, r) => s + Number(r.income || 0), 0);
    const costs = merchRows.reduce((s, r) => s + Number(r.expense || 0), 0);
    const profit = sales - costs;
    const summary = `
      <div class="cards-secondary" style="margin-bottom:14px">
        <div class="card"><div class="card-label">物販売上</div><div class="card-value green">${yen(sales)}</div></div>
        <div class="card"><div class="card-label">原価・経費</div><div class="card-value red">${yen(costs)}</div></div>
        <div class="card"><div class="card-label">物販利益</div><div class="card-value ${profit >= 0 ? 'green' : 'red'}">${yen(profit)}</div></div>
      </div>`;
    if (!merchRows.length) {
      container.innerHTML = summary + '<div class="empty-state">この月の物販はありません</div><div class="business-muted-note" style="margin-top:8px">過去の物販帳簿は、Excel / CSVからまとめて取り込めます。</div>';
      return;
    }
    const rows = merchRows.map(r => `<tr>
      <td>${esc(r.date)}</td><td>${esc(r.content || '—')}</td>
      <td style="text-align:right">${yen(r.income)}</td><td style="text-align:right">${yen(r.expense)}</td>
      <td style="text-align:right">${yen(Number(r.income || 0)-Number(r.expense || 0))}</td>
      <td style="text-align:right"><button class="btn btn-secondary btn-sm" data-merch-edit="${r.id}">編集</button></td>
    </tr>`).join('');
    container.innerHTML = summary + `<table class="works-table"><thead><tr><th>日付</th><th>商品・内容</th><th>売上</th><th>原価・経費</th><th>利益</th><th></th></tr></thead><tbody>${rows}</tbody></table>
      <div class="business-muted-note" style="margin-top:8px">過去の物販帳簿は、Excel / CSVからまとめて取り込めます。</div>`;
    container.querySelectorAll('[data-merch-edit]').forEach(btn => btn.addEventListener('click', () => {
      const row = merchRows.find(r => Number(r.id) === Number(btn.dataset.merchEdit));
      if (row) openModal(row);
    }));
  }

  async function keepMonthlyWorkOnly() {
    try {
      const works = await fetchMonthWorks();
      const normal = works.filter(w => w.category !== '物販');
      const income = normal.reduce((s,w)=>s+Number(w.income||0),0);
      const expense = normal.reduce((s,w)=>s+Number(w.expense||0),0);
      const profit = income-expense;
      const incomeEl = document.getElementById('card-income');
      const expenseEl = document.getElementById('card-expense');
      const profitEl = document.getElementById('card-profit');
      if (incomeEl) incomeEl.textContent = yen(income);
      if (expenseEl) expenseEl.textContent = yen(expense);
      if (profitEl) {
        profitEl.textContent = yen(profit);
        profitEl.className = 'card-value ' + (profit >= 0 ? 'green' : 'red');
      }

      // 月次の仕事一覧から物販行を除外する。物販は専用タブで編集する。
      const merchIds = new Set(works.filter(w=>w.category==='物販').map(w=>Number(w.id)));
      document.querySelectorAll('#works-tbody tr[data-id]').forEach(tr => {
        if (merchIds.has(Number(tr.dataset.id))) tr.remove();
      });
    } catch (_) {}
  }

  async function saveMerch(event) {
    event.preventDefault();
    const id = Number(document.getElementById('merch-id').value || 0);
    const body = {
      date: document.getElementById('merch-date').value, category: '物販', work_type: '物販',
      content: document.getElementById('merch-content').value.trim() || null, client: null,
      income: document.getElementById('merch-income').value ? Number(document.getElementById('merch-income').value) : 0,
      expense: document.getElementById('merch-expense').value ? Number(document.getElementById('merch-expense').value) : 0,
      invoice_status: '対象外', payment_status: '対象外', memo: document.getElementById('merch-memo').value.trim() || null,
    };
    const error = document.getElementById('merch-error'); error.textContent = '';
    try {
      const response = await fetch(id ? `/api/work/${id}` : '/api/work', {method:id?'PUT':'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || '保存に失敗しました');
      closeModal(); loadedMonth = null;
      if (typeof refresh === 'function') await refresh();
      await loadMerch(true); await keepMonthlyWorkOnly();
    } catch (e) { error.textContent = e.message; }
  }

  async function deleteMerch() {
    const id = Number(document.getElementById('merch-id').value || 0); if (!id) return;
    const row = merchRows.find(r => Number(r.id) === id);
    if (!window.confirm(`${row?.content ? `${row.date}　${row.content}` : 'この物販記録'}\n\n削除しますか？\n削除後は元に戻せません。`)) return;
    try {
      const response = await fetch(`/api/work/${id}`, {method:'DELETE'}); const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || '削除に失敗しました');
      closeModal(); loadedMonth = null;
      if (typeof refresh === 'function') await refresh();
      await loadMerch(true); await keepMonthlyWorkOnly();
    } catch (e) { document.getElementById('merch-error').textContent = e.message; }
  }

  function init() {
    ensureUi();
    keepMonthlyWorkOnly();
    const targets = [document.getElementById('current-month'), document.getElementById('works-table-container'), document.getElementById('card-income')].filter(Boolean);
    const observer = new MutationObserver(() => {
      clearTimeout(window.__merchRefreshTimer);
      window.__merchRefreshTimer = setTimeout(() => { loadedMonth = null; keepMonthlyWorkOnly(); if (!document.getElementById('biz-tab-merch')?.hidden) loadMerch(true); }, 100);
    });
    targets.forEach(t => observer.observe(t, {childList:true,subtree:true,characterData:true}));
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, {once:true});
  else init();
})();
