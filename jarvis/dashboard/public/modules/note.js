/**
 * dashboard/public/modules/note.js
 * note 企画管理 Dashboard モジュール
 *
 * タブ構成:
 *   企画一覧  — アクティブな企画カード（採用/却下/再提案ボタン付き）
 *   AI企画生成 — 収益企画を AI に生成させる
 *   却下履歴  — ソフト削除済み企画の一覧・復元
 *   販売データ — 月別販売データの手動入力・編集
 */

(function () {
  'use strict';

  // ── 状態 ────────────────────────────────────────────────────────────────────

  let state = {
    plans:        [],     // アクティブ企画
    rejected:     [],     // 却下履歴
    salesArticle: null,   // 販売データタブで選択中の記事ID
    salesRecords: [],     // 販売データ一覧
    selectedIds:  new Set(), // 一括却下チェックボックス
    editingSalesId: null, // 編集中の販売データID (null=新規)
    rejectTargetId: null, // 却下モーダルの対象ID
  };

  // ── DOM 取得ヘルパー ─────────────────────────────────────────────────────────

  const $ = id => document.getElementById(id);
  const $q = (sel, root = document) => root.querySelector(sel);

  // ── API ────────────────────────────────────────────────────────────────────

  async function api(method, path, body = null) {
    const opts = {
      method,
      headers: { 'Content-Type': 'application/json' },
    };
    if (body !== null) opts.body = JSON.stringify(body);
    const res = await fetch(path, opts);
    return res.json();
  }

  // ── メインタブ切り替え ───────────────────────────────────────────────────────

  function initTabs() {
    const tabs = document.querySelectorAll('#module-note .note-tab');
    tabs.forEach(btn => {
      btn.addEventListener('click', () => {
        tabs.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const tabName = btn.dataset.tab;
        document.querySelectorAll('#module-note .note-tab-panel').forEach(p => {
          p.hidden = true;
        });
        $(`note-tab-${tabName}`).hidden = false;

        // 一括却下ボタン表示
        $('note-bulk-reject-btn').style.display = tabName === 'plans' ? '' : 'none';

        if (tabName === 'plans')    loadPlans();
        if (tabName === 'rejected') loadRejected();
        if (tabName === 'sales')    loadSalesTab();
      });
    });
  }

  // ── 企画一覧 ─────────────────────────────────────────────────────────────────

  async function loadPlans() {
    const res = await api('GET', '/api/note/articles?limit=200');
    if (!res.ok) return;
    // アクティブな企画のみ（plan_status が null または 'active'）
    state.plans = (res.articles ?? []).filter(a => a.plan_status !== 'rejected');
    state.selectedIds.clear();
    renderPlans();
    updateSummaryBar();
  }

  function renderPlans() {
    const filterPlanStatus = $('note-filter-plan-status')?.value ?? '';
    const filterStatus     = $('note-filter-status')?.value ?? '';
    const list = $('note-plans-list');
    if (!list) return;

    let plans = state.plans;
    if (filterPlanStatus === 'paid')  plans = plans.filter(p => p.is_paid === 1);
    if (filterPlanStatus === 'free')  plans = plans.filter(p => p.is_paid === 0 && p.revenue_score !== null);
    if (filterStatus) plans = plans.filter(p => p.status === filterStatus);

    if (plans.length === 0) {
      list.innerHTML = '<p class="note-empty-msg">企画がありません</p>';
      return;
    }
    list.innerHTML = plans.map(p => renderPlanCard(p, false)).join('');
    attachPlanCardEvents(list);
  }

  function renderPlanCard(article, isGenerated) {
    const score = article.revenue_score ?? null;
    const scoreClass = score === null ? '' : score >= 80 ? 'score-high' : score >= 60 ? 'score-mid' : 'score-low';
    const badgeText  = article.is_paid === 1 ? '有料候補' : article.is_paid === 0 ? '無料/集客' : '';
    const badgeClass = article.is_paid === 1 ? 'badge-paid' : 'badge-free';
    const statusLabel = article.status ?? 'idea';

    const actionButtons = isGenerated
      ? `<button class="note-card-btn btn-adopt" data-id="${article._genIdx ?? 0}">採用して登録</button>`
      : `
          <button class="note-card-btn btn-adopt"  data-id="${article.id}">採用（draft）</button>
          <button class="note-card-btn btn-reject" data-id="${article.id}">却下</button>
        `;

    return `
      <div class="note-card ${scoreClass} ${article.plan_status === 'rejected' ? 'note-card-rejected' : ''}" data-id="${article.id ?? ''}">
        ${!isGenerated ? `<label class="note-card-check"><input type="checkbox" class="plan-select-cb" data-id="${article.id}"></label>` : ''}
        <div class="note-card-header">
          ${badgeText ? `<span class="note-badge ${badgeClass}">${badgeText}</span>` : ''}
          ${score !== null ? `<span class="note-score ${scoreClass}">${score}点</span>` : ''}
          <span class="note-status-badge">${statusLabel}</span>
        </div>
        <h4 class="note-card-title">${esc(article.title)}</h4>
        ${article.buyer_target   ? `<p class="note-card-meta"><b>対象:</b> ${esc(article.buyer_target)}</p>` : ''}
        ${article.buyer_problem  ? `<p class="note-card-meta"><b>悩み:</b> ${esc(article.buyer_problem)}</p>` : ''}
        ${article.solution       ? `<p class="note-card-meta"><b>価値:</b> ${esc(article.solution)}</p>` : ''}
        ${article.purchase_reason ? `<p class="note-card-meta"><b>購入理由:</b> ${esc(article.purchase_reason)}</p>` : ''}
        ${article.differentiation ? `<p class="note-card-meta"><b>差別化:</b> ${esc(article.differentiation)}</p>` : ''}
        ${article.recommended_price !== null && article.recommended_price !== undefined
          ? `<p class="note-card-meta"><b>推奨価格:</b> ¥${Number(article.recommended_price).toLocaleString()}</p>` : ''}
        ${article.eval_reason    ? `<p class="note-card-meta note-card-eval"><b>評価:</b> ${esc(article.eval_reason)}</p>` : ''}
        ${article.required_info  ? `<p class="note-card-meta note-card-required"><b>要確認:</b> ${esc(article.required_info)}</p>` : ''}
        <div class="note-card-actions">${actionButtons}</div>
      </div>
    `;
  }

  function attachPlanCardEvents(root) {
    root.querySelectorAll('.btn-adopt').forEach(btn => {
      btn.addEventListener('click', () => adoptPlan(parseInt(btn.dataset.id, 10)));
    });
    root.querySelectorAll('.btn-reject').forEach(btn => {
      btn.addEventListener('click', () => openRejectModal(parseInt(btn.dataset.id, 10)));
    });
    root.querySelectorAll('.plan-select-cb').forEach(cb => {
      cb.addEventListener('change', () => {
        const id = parseInt(cb.dataset.id, 10);
        if (cb.checked) state.selectedIds.add(id);
        else            state.selectedIds.delete(id);
      });
    });
  }

  async function adoptPlan(id) {
    const res = await api('POST', '/api/note/article/status', { id, status: 'draft' });
    if (!res.ok) return showToast(`採用失敗: ${res.error}`, 'error');
    showToast('draft に移行しました');
    loadPlans();
  }

  function openRejectModal(id) {
    state.rejectTargetId = id;
    $('note-reject-reason-select').value = '市場性不足';
    $('note-reject-note').value = '';
    $('note-reject-modal').hidden = false;
  }

  async function doReject() {
    const id = state.rejectTargetId;
    if (!id) return;
    const reason = $('note-reject-reason-select').value;
    const note   = $('note-reject-note').value.trim();
    const res = await api('POST', '/api/note/article/reject', { id, reason, note });
    $('note-reject-modal').hidden = true;
    if (!res.ok) return showToast(`却下失敗: ${res.error}`, 'error');
    showToast('却下しました');
    loadPlans();
  }

  // ── サマリーバー ──────────────────────────────────────────────────────────────

  function updateSummaryBar() {
    const active = state.plans;
    $('note-cnt-active').textContent    = active.length;
    $('note-cnt-paid').textContent      = active.filter(p => p.is_paid === 1).length;
    $('note-cnt-free').textContent      = active.filter(p => p.is_paid === 0 && p.revenue_score !== null).length;
    // 公開済みは別APIから取得（summary API流用）
    api('GET', '/api/note/dashboard').then(res => {
      if (res.ok) $('note-cnt-published').textContent = res.counts?.published ?? 0;
    });
  }

  // ── AI企画生成タブ ────────────────────────────────────────────────────────────

  function initGenerateTab() {
    $('note-gen-submit').addEventListener('click', () => generatePlans(false));
    $('note-repropose-submit').addEventListener('click', () => generatePlans(true));
  }

  async function generatePlans(repropose = false) {
    const theme = $('note-gen-theme').value.trim();
    if (!theme) { showToast('テーマを入力してください', 'error'); return; }

    const body = {
      theme,
      experience: $('note-gen-experience').value.trim(),
      target:     $('note-gen-target').value.trim(),
      notes:      $('note-gen-notes').value.trim(),
    };

    const statusEl = $('note-gen-status');
    statusEl.hidden = false;
    statusEl.textContent = repropose ? '却下履歴を参照して再提案中...' : 'AI が企画を分析中...';
    statusEl.className = 'note-gen-status note-gen-status-loading';
    $('note-gen-submit').disabled = true;
    $('note-repropose-submit').disabled = true;
    $('note-gen-results').hidden = true;

    const endpoint = repropose ? '/api/note/article/repropose' : '/api/note/generate-plans';
    let res;
    try {
      res = await api('POST', endpoint, body);
    } catch (e) {
      statusEl.textContent = `通信エラー: ${e.message}`;
      statusEl.className = 'note-gen-status note-gen-status-error';
      $('note-gen-submit').disabled = false;
      $('note-repropose-submit').disabled = false;
      return;
    }

    $('note-gen-submit').disabled = false;
    $('note-repropose-submit').disabled = false;

    if (!res.ok) {
      statusEl.textContent = `エラー: ${res.error}`;
      statusEl.className = 'note-gen-status note-gen-status-error';
      return;
    }

    statusEl.hidden = true;
    renderGeneratedResults(res);
  }

  function renderGeneratedResults(res) {
    const resultsEl = $('note-gen-results');
    resultsEl.hidden = false;

    // 分析サマリー
    $('note-gen-analysis').innerHTML = res.analysis_summary
      ? `<div class="note-gen-analysis-text">${esc(res.analysis_summary)}</div>`
      : '';

    // 企画カード
    const cardsEl = $('note-gen-cards');
    const plans = res.plans ?? [];
    if (plans.length === 0) {
      cardsEl.innerHTML = '<p class="note-empty-msg">有望な企画案は見つかりませんでした</p>';
    } else {
      cardsEl.innerHTML = plans.map((p, i) => renderGeneratedCard(p, i)).join('');
      cardsEl.querySelectorAll('.btn-register-plan').forEach(btn => {
        btn.addEventListener('click', () => {
          const idx = parseInt(btn.dataset.idx, 10);
          registerGeneratedPlan(plans[idx]);
        });
      });
    }

    // 却下アイデア
    const rejectedEl = $('note-gen-rejected');
    const rejected = res.rejected_ideas ?? [];
    if (rejected.length > 0) {
      rejectedEl.innerHTML = `
        <h4 class="note-gen-rejected-heading">却下されたアイデア（${rejected.length}件）</h4>
        <ul class="note-gen-rejected-ul">
          ${rejected.map(r => `<li><b>${esc(r.idea ?? '')}</b>: ${esc(r.reason ?? '')} (${r.score ?? '—'}点)</li>`).join('')}
        </ul>
      `;
    } else {
      rejectedEl.innerHTML = '';
    }
  }

  function renderGeneratedCard(plan, idx) {
    const score = plan.revenue_score ?? null;
    const scoreClass = score === null ? '' : score >= 80 ? 'score-high' : score >= 60 ? 'score-mid' : 'score-low';
    const badgeText  = plan.is_paid === 1 ? '有料候補' : plan.is_paid === 0 ? '無料/集客' : '';
    const badgeClass = plan.is_paid === 1 ? 'badge-paid' : 'badge-free';

    return `
      <div class="note-card ${scoreClass}">
        <div class="note-card-header">
          ${badgeText ? `<span class="note-badge ${badgeClass}">${badgeText}</span>` : ''}
          ${score !== null ? `<span class="note-score ${scoreClass}">${score}点</span>` : ''}
        </div>
        <h4 class="note-card-title">${esc(plan.title)}</h4>
        ${plan.buyer_target    ? `<p class="note-card-meta"><b>対象:</b> ${esc(plan.buyer_target)}</p>` : ''}
        ${plan.buyer_problem   ? `<p class="note-card-meta"><b>悩み:</b> ${esc(plan.buyer_problem)}</p>` : ''}
        ${plan.solution        ? `<p class="note-card-meta"><b>価値:</b> ${esc(plan.solution)}</p>` : ''}
        ${plan.purchase_reason ? `<p class="note-card-meta"><b>購入理由:</b> ${esc(plan.purchase_reason)}</p>` : ''}
        ${plan.differentiation ? `<p class="note-card-meta"><b>差別化:</b> ${esc(plan.differentiation)}</p>` : ''}
        ${plan.recommended_price !== null && plan.recommended_price !== undefined
          ? `<p class="note-card-meta"><b>推奨価格:</b> ¥${Number(plan.recommended_price).toLocaleString()}</p>` : ''}
        ${plan.eval_reason     ? `<p class="note-card-meta note-card-eval"><b>評価:</b> ${esc(plan.eval_reason)}</p>` : ''}
        ${plan.required_info   ? `<p class="note-card-meta note-card-required"><b>要確認:</b> ${esc(plan.required_info)}</p>` : ''}
        <div class="note-card-actions">
          <button class="note-card-btn btn-adopt btn-register-plan" data-idx="${idx}">採用して登録</button>
        </div>
      </div>
    `;
  }

  async function registerGeneratedPlan(plan) {
    const articleData = {
      title:           plan.title,
      status:          'idea',
      buyer_target:    plan.buyer_target    || null,
      buyer_problem:   plan.buyer_problem   || null,
      solution:        plan.solution        || null,
      purchase_reason: plan.purchase_reason || null,
      differentiation: plan.differentiation || null,
      required_info:   plan.required_info   || null,
      recommended_price: plan.recommended_price ?? null,
      is_paid:         plan.is_paid         ?? null,
      revenue_score:   plan.revenue_score   ?? null,
      score_detail:    plan.score_detail    ?? null,
    };

    const res = await api('POST', '/api/note/articles', articleData);
    if (!res.ok) return showToast(`登録失敗: ${res.error}`, 'error');
    showToast(`「${plan.title}」を登録しました`);
  }

  // ── 却下履歴タブ ─────────────────────────────────────────────────────────────

  async function loadRejected() {
    const res = await api('GET', '/api/note/rejections?limit=100');
    if (!res.ok) return;
    state.rejected = res.articles ?? [];
    renderRejected();
  }

  function renderRejected() {
    const list = $('note-rejected-list');
    if (!list) return;
    if (state.rejected.length === 0) {
      list.innerHTML = '<p class="note-empty-msg">却下済み企画はありません</p>';
      return;
    }
    list.innerHTML = state.rejected.map(a => `
      <div class="note-card note-card-rejected">
        <div class="note-card-header">
          ${a.revenue_score !== null ? `<span class="note-score">${a.revenue_score}点</span>` : ''}
          <span class="note-rejected-at">${a.rejected_at ? a.rejected_at.slice(0, 10) : ''} 却下</span>
        </div>
        <h4 class="note-card-title">${esc(a.title)}</h4>
        ${a.rejection_reason ? `<p class="note-card-meta note-card-reject-reason"><b>理由:</b> ${esc(a.rejection_reason)}</p>` : ''}
        ${a.rejection_note   ? `<p class="note-card-meta"><b>メモ:</b> ${esc(a.rejection_note)}</p>` : ''}
        <div class="note-card-actions">
          <button class="note-card-btn btn-restore" data-id="${a.id}">復元</button>
        </div>
      </div>
    `).join('');
    list.querySelectorAll('.btn-restore').forEach(btn => {
      btn.addEventListener('click', () => restorePlan(parseInt(btn.dataset.id, 10)));
    });
  }

  async function restorePlan(id) {
    const res = await api('POST', '/api/note/article/restore', { id });
    if (!res.ok) return showToast(`復元失敗: ${res.error}`, 'error');
    showToast('企画を復元しました');
    loadRejected();
  }

  // ── 販売データタブ ────────────────────────────────────────────────────────────

  async function loadSalesTab() {
    // 公開済み記事一覧をセレクトに入れる
    const res = await api('GET', '/api/note/articles?status=published&limit=200');
    const sel = $('note-sales-article-select');
    if (!sel) return;

    const articles = res.articles ?? [];
    sel.innerHTML = '<option value="">記事を選択...</option>' +
      articles.map(a => `<option value="${a.id}">${esc(a.title)}</option>`).join('');

    if (state.salesArticle) {
      sel.value = String(state.salesArticle);
      loadSalesRecords(state.salesArticle);
    } else {
      $('note-sales-list').innerHTML = '<p class="note-empty-msg">記事を選択してください</p>';
      $('note-sales-add-btn').disabled = true;
    }
  }

  async function loadSalesRecords(articleId) {
    const res = await api('GET', `/api/note/sales?article_id=${articleId}`);
    state.salesRecords = res.records ?? [];
    renderSalesTable();
  }

  function renderSalesTable() {
    const wrap = $('note-sales-list');
    if (!wrap) return;
    if (state.salesRecords.length === 0) {
      wrap.innerHTML = '<p class="note-empty-msg">販売データがありません。「データ追加」で登録できます。</p>';
      return;
    }
    wrap.innerHTML = `
      <table class="note-sales-table">
        <thead>
          <tr>
            <th>期間</th><th>PV</th><th>スキ</th><th>販売数</th>
            <th>売上</th><th>購入率</th><th>価格</th><th>流入元</th><th>メモ</th><th></th>
          </tr>
        </thead>
        <tbody>
          ${state.salesRecords.map(r => `
            <tr>
              <td>${esc(r.period)}</td>
              <td>${nullFmt(r.pv)}</td>
              <td>${nullFmt(r.likes)}</td>
              <td>${nullFmt(r.sales_count)}</td>
              <td>${r.revenue !== null ? `¥${Number(r.revenue).toLocaleString()}` : '—'}</td>
              <td>${r.purchase_rate !== null ? `${r.purchase_rate}%` : '—'}</td>
              <td>${r.price !== null ? `¥${Number(r.price).toLocaleString()}` : '—'}</td>
              <td>${esc(r.source ?? '')}</td>
              <td class="note-sales-note-cell">${esc(r.note ?? '')}</td>
              <td class="note-sales-actions">
                <button class="btn-xs btn-edit-sales" data-id="${r.id}">編集</button>
                <button class="btn-xs btn-del-sales" data-id="${r.id}">削除</button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
    wrap.querySelectorAll('.btn-edit-sales').forEach(btn => {
      btn.addEventListener('click', () => openSalesModal(parseInt(btn.dataset.id, 10)));
    });
    wrap.querySelectorAll('.btn-del-sales').forEach(btn => {
      btn.addEventListener('click', () => deleteSalesRecord(parseInt(btn.dataset.id, 10)));
    });
  }

  function nullFmt(v) { return v !== null && v !== undefined ? v : '—'; }

  function openSalesModal(salesId = null) {
    state.editingSalesId = salesId;
    $('note-sales-modal-title').textContent = salesId ? '販売データ編集' : '販売データ追加';
    // フォームをリセット/既存値をセット
    const fields = ['period','pv','likes','count','revenue','rate','price','source','note'];
    fields.forEach(f => { const el = $(`note-sales-${f}`); if (el) el.value = ''; });

    if (salesId) {
      const rec = state.salesRecords.find(r => r.id === salesId);
      if (rec) {
        $('note-sales-period').value  = rec.period    ?? '';
        $('note-sales-pv').value      = rec.pv        ?? '';
        $('note-sales-likes').value   = rec.likes     ?? '';
        $('note-sales-count').value   = rec.sales_count ?? '';
        $('note-sales-revenue').value = rec.revenue   ?? '';
        $('note-sales-rate').value    = rec.purchase_rate ?? '';
        $('note-sales-price').value   = rec.price     ?? '';
        $('note-sales-source').value  = rec.source    ?? '';
        $('note-sales-note').value    = rec.note      ?? '';
      }
    }
    $('note-sales-modal').hidden = false;
  }

  async function saveSalesRecord() {
    const period = $('note-sales-period').value.trim();
    if (!period || !/^\d{4}-\d{2}$/.test(period)) {
      return showToast('期間は YYYY-MM 形式で入力してください', 'error');
    }

    const data = {
      article_id:    state.salesArticle,
      period,
      pv:            toNullInt($('note-sales-pv').value),
      likes:         toNullInt($('note-sales-likes').value),
      sales_count:   toNullInt($('note-sales-count').value),
      revenue:       toNullInt($('note-sales-revenue').value),
      purchase_rate: toNullFloat($('note-sales-rate').value),
      price:         toNullInt($('note-sales-price').value),
      source:        $('note-sales-source').value.trim() || null,
      note:          $('note-sales-note').value.trim()   || null,
    };

    let res;
    if (state.editingSalesId) {
      res = await api('PATCH', `/api/note/sales/record?id=${state.editingSalesId}`, data);
    } else {
      res = await api('POST', '/api/note/sales', data);
    }

    $('note-sales-modal').hidden = true;
    if (!res.ok) return showToast(`保存失敗: ${res.error}`, 'error');
    showToast('保存しました');
    loadSalesRecords(state.salesArticle);
  }

  async function deleteSalesRecord(id) {
    if (!confirm('この販売データを削除しますか？')) return;
    const res = await api('DELETE', `/api/note/sales/record?id=${id}`);
    if (!res.ok) return showToast(`削除失敗: ${res.error}`, 'error');
    showToast('削除しました');
    loadSalesRecords(state.salesArticle);
  }

  function toNullInt(v) {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  }
  function toNullFloat(v) {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }

  // ── 一括却下 ─────────────────────────────────────────────────────────────────

  async function bulkRejectSelected() {
    if (state.selectedIds.size === 0) return showToast('記事を選択してください', 'error');
    if (!confirm(`選択中の ${state.selectedIds.size} 件を一括却下しますか？`)) return;
    const res = await api('POST', '/api/note/bulk-reject', {
      ids: [...state.selectedIds],
      reason: '一括却下',
    });
    if (!res.ok) return showToast(`一括却下失敗: ${res.error}`, 'error');
    showToast(`${res.count} 件を却下しました`);
    loadPlans();
  }

  // ── 全選択チェックボックス ────────────────────────────────────────────────────

  function initSelectAll() {
    const allCb = $('note-select-all-plans');
    if (!allCb) return;
    allCb.addEventListener('change', () => {
      const checked = allCb.checked;
      document.querySelectorAll('.plan-select-cb').forEach(cb => {
        cb.checked = checked;
        const id = parseInt(cb.dataset.id, 10);
        if (checked) state.selectedIds.add(id);
        else         state.selectedIds.delete(id);
      });
    });
  }

  // ── ユーティリティ ────────────────────────────────────────────────────────────

  function esc(str) {
    return String(str ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function showToast(msg, type = 'success') {
    // JARVIS 共通 toast があれば使う、なければコンソール
    if (typeof window.showToast === 'function') {
      window.showToast(msg, type);
    } else {
      console.log(`[note] ${type}: ${msg}`);
    }
  }

  // ── 初期化 ────────────────────────────────────────────────────────────────────

  function init() {
    initTabs();
    initGenerateTab();
    initSelectAll();

    // フィルター変更
    $('note-filter-plan-status')?.addEventListener('change', renderPlans);
    $('note-filter-status')?.addEventListener('change', renderPlans);

    // 更新ボタン
    $('note-refresh-btn')?.addEventListener('click', () => {
      const activeTab = document.querySelector('#module-note .note-tab.active')?.dataset.tab;
      if (activeTab === 'plans')    loadPlans();
      if (activeTab === 'rejected') loadRejected();
      if (activeTab === 'sales')    loadSalesTab();
    });

    // 一括却下ボタン
    $('note-bulk-reject-btn')?.addEventListener('click', bulkRejectSelected);

    // 却下モーダルボタン
    $('note-reject-modal-save')?.addEventListener('click', doReject);
    $('note-reject-modal-cancel')?.addEventListener('click', () => {
      $('note-reject-modal').hidden = true;
    });

    // 販売データモーダルボタン
    $('note-sales-modal-save')?.addEventListener('click', saveSalesRecord);
    $('note-sales-modal-cancel')?.addEventListener('click', () => {
      $('note-sales-modal').hidden = true;
    });

    // 販売データ記事選択
    $('note-sales-article-select')?.addEventListener('change', e => {
      const id = parseInt(e.target.value, 10);
      state.salesArticle = Number.isFinite(id) ? id : null;
      $('note-sales-add-btn').disabled = !state.salesArticle;
      if (state.salesArticle) loadSalesRecords(state.salesArticle);
      else $('note-sales-list').innerHTML = '<p class="note-empty-msg">記事を選択してください</p>';
    });

    // 販売データ追加ボタン
    $('note-sales-add-btn')?.addEventListener('click', () => openSalesModal(null));

    // モジュール表示時に初回ロード
    const observer = new MutationObserver(() => {
      if (!$('module-note').hidden) {
        loadPlans();
        observer.disconnect();
      }
    });
    observer.observe($('module-note'), { attributes: true, attributeFilter: ['hidden'] });
  }

  // DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
