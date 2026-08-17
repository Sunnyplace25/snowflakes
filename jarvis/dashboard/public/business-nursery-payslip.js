/**
 * 保育園 給与明細入力。
 * 過去月は日々のシフトを再入力せず、給与明細の月次実績をそのまま保存できる。
 */
'use strict';

(function () {
  const yen = value => value == null || value === '' ? '—' : `${Number(value).toLocaleString('ja-JP')}円`;
  const num = id => {
    const value = document.getElementById(id)?.value;
    return value === '' || value == null ? null : Number(value);
  };

  function monthValue() {
    if (typeof currentMonth !== 'undefined' && /^\d{4}-\d{2}$/.test(currentMonth)) return currentMonth;
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  function ensureUi() {
    const panel = document.getElementById('biz-tab-nursery');
    if (!panel || document.getElementById('nursery-payslip-section')) return;

    const section = document.createElement('section');
    section.className = 'section';
    section.id = 'nursery-payslip-section';
    section.innerHTML = `
      <div class="section-header">
        <h2>給与明細</h2>
        <span class="sf-note">過去月はシフト入力なしで実績を保存</span>
      </div>
      <div class="business-muted-note" style="margin-bottom:12px">
        給与明細に書いてある数字をそのまま入れればOKです。全部埋めなくても、分かる項目だけ保存できます。
      </div>
      <div class="business-form-inline" style="align-items:end">
        <div class="form-group"><label for="payslip-month">対象月</label><input id="payslip-month" type="month"></div>
        <div class="form-group"><label for="payslip-hourly">時給</label><input id="payslip-hourly" type="number" min="0" step="1"></div>
        <div class="form-group"><label for="payslip-hours">勤務時間</label><input id="payslip-hours" type="number" min="0" step="0.01" placeholder="h"></div>
        <div class="form-group"><label for="payslip-leave-used">有給使用</label><input id="payslip-leave-used" type="number" min="0" step="0.5" placeholder="日"></div>
        <div class="form-group"><label for="payslip-leave-balance">有給残</label><input id="payslip-leave-balance" type="number" min="0" step="0.5" placeholder="日"></div>
      </div>
      <div class="business-form-inline" style="margin-top:10px;align-items:end">
        <div class="form-group"><label for="payslip-gross">総支給額</label><input id="payslip-gross" type="number" min="0" step="1"></div>
        <div class="form-group"><label for="payslip-net">手取り</label><input id="payslip-net" type="number" min="0" step="1"></div>
        <div class="form-group"><label for="payslip-transport">交通費支給</label><input id="payslip-transport" type="number" min="0" step="1"></div>
        <div class="form-group"><label for="payslip-deductions">控除合計</label><input id="payslip-deductions" type="number" min="0" step="1"></div>
        <button class="btn btn-primary" id="payslip-save">この月の明細を保存</button>
      </div>
      <div class="form-group" style="margin-top:10px"><label for="payslip-memo">メモ</label><input id="payslip-memo" type="text" placeholder="例：給与明細から入力"></div>
      <div id="payslip-status" class="business-muted-note" style="margin-top:8px"></div>
      <div id="payslip-history" style="margin-top:16px"></div>`;

    const paySummary = document.getElementById('nursery-pay-summary');
    if (paySummary) paySummary.insertAdjacentElement('afterend', section);
    else panel.appendChild(section);

    document.getElementById('payslip-month').value = monthValue();
    document.getElementById('payslip-month').addEventListener('change', loadSelectedMonth);
    document.getElementById('payslip-save').addEventListener('click', savePayslip);
    loadSelectedMonth();
    loadHistory();
  }

  async function loadSelectedMonth() {
    const month = document.getElementById('payslip-month')?.value || monthValue();
    try {
      const response = await fetch(`/api/nursery-payslips?month=${encodeURIComponent(month)}`);
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || '読込失敗');
      const row = data.payslips?.[0] || {};
      const fields = {
        'payslip-hourly': row.hourly_rate,
        'payslip-hours': row.worked_hours,
        'payslip-leave-used': row.paid_leave_used,
        'payslip-leave-balance': row.paid_leave_balance,
        'payslip-gross': row.gross_pay,
        'payslip-net': row.net_pay,
        'payslip-transport': row.transport_pay,
        'payslip-deductions': row.deductions,
        'payslip-memo': row.memo,
      };
      Object.entries(fields).forEach(([id, value]) => {
        const el = document.getElementById(id);
        if (el) el.value = value ?? '';
      });
      document.getElementById('payslip-status').textContent = row.id ? '保存済みの明細を表示しています。' : 'この月の明細はまだありません。';
    } catch (e) {
      document.getElementById('payslip-status').textContent = '読込エラー: ' + e.message;
    }
  }

  async function savePayslip() {
    const month = document.getElementById('payslip-month').value;
    const button = document.getElementById('payslip-save');
    const status = document.getElementById('payslip-status');
    const body = {
      month,
      hourly_rate: num('payslip-hourly'),
      worked_hours: num('payslip-hours'),
      paid_leave_used: num('payslip-leave-used'),
      paid_leave_balance: num('payslip-leave-balance'),
      gross_pay: num('payslip-gross'),
      net_pay: num('payslip-net'),
      transport_pay: num('payslip-transport'),
      deductions: num('payslip-deductions'),
      memo: document.getElementById('payslip-memo').value.trim() || null,
    };
    button.disabled = true;
    status.textContent = '保存中...';
    try {
      const response = await fetch('/api/nursery-payslip', {
        method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify(body),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || '保存失敗');
      status.textContent = `${month.replace('-', '年')}月の給与明細を保存しました。`;
      await loadHistory();
    } catch (e) {
      status.textContent = '保存エラー: ' + e.message;
    } finally {
      button.disabled = false;
    }
  }

  async function loadHistory() {
    const el = document.getElementById('payslip-history');
    if (!el) return;
    try {
      const response = await fetch('/api/nursery-payslips');
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || '読込失敗');
      const rows = data.payslips || [];
      if (!rows.length) {
        el.innerHTML = '<div class="empty-state">給与明細の登録はまだありません</div>';
        return;
      }
      el.innerHTML = `<table class="works-table">
        <thead><tr><th>月</th><th>勤務時間</th><th>有給残</th><th>総支給</th><th>手取り</th><th></th></tr></thead>
        <tbody>${rows.map(r => `<tr>
          <td>${r.month}</td>
          <td>${r.worked_hours == null ? '—' : Number(r.worked_hours).toFixed(2).replace(/\.00$/,'') + 'h'}</td>
          <td>${r.paid_leave_balance == null ? '—' : r.paid_leave_balance + '日'}</td>
          <td>${yen(r.gross_pay)}</td><td>${yen(r.net_pay)}</td>
          <td style="text-align:right"><button class="btn btn-secondary btn-sm" data-payslip-month="${r.month}">表示</button></td>
        </tr>`).join('')}</tbody></table>`;
      el.querySelectorAll('[data-payslip-month]').forEach(btn => btn.addEventListener('click', () => {
        document.getElementById('payslip-month').value = btn.dataset.payslipMonth;
        loadSelectedMonth();
      }));
    } catch (e) {
      el.textContent = '給与明細一覧の読込エラー: ' + e.message;
    }
  }

  function init() {
    ensureUi();
    const observer = new MutationObserver(ensureUi);
    const business = document.getElementById('module-business');
    if (business) observer.observe(business, {childList:true, subtree:true});
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, {once:true});
  else init();
})();
