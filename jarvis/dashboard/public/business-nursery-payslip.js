/**
 * 保育園 給与明細入力。
 * 過去月は日々のシフトを再入力せず、給与明細の月次実績をそのまま保存できる。
 * PDFはローカル読取APIで解析し、単体または複数月を確認後に保存する。
 */
'use strict';

(function () {
  const yen = value => value == null || value === '' ? '—' : `${Number(value).toLocaleString('ja-JP')}円`;
  const num = id => {
    const value = document.getElementById(id)?.value;
    return value === '' || value == null ? null : Number(value);
  };
  let batchPayslips = [];

  function monthValue() {
    if (typeof currentMonth !== 'undefined' && /^\d{4}-\d{2}$/.test(currentMonth)) return currentMonth;
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  }

  function setField(id, value) {
    if (value == null || value === '') return;
    const el = document.getElementById(id);
    if (el) el.value = value;
  }

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunk = 8192;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  }

  function payslipBody(p) {
    return {
      month: p.month,
      hourly_rate: p.hourly_rate ?? null,
      worked_hours: p.worked_hours ?? null,
      paid_leave_used: p.paid_leave_used ?? null,
      paid_leave_balance: p.paid_leave_balance ?? null,
      gross_pay: p.gross_pay ?? null,
      net_pay: p.net_pay ?? null,
      transport_pay: p.transport_pay ?? null,
      deductions: p.deductions ?? null,
      memo: p.memo || null,
    };
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
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <button class="btn btn-secondary" id="payslip-pdf-btn">PDFを取り込む</button>
          <input type="file" id="payslip-pdf-file" accept="application/pdf,.pdf" multiple hidden>
          <span class="sf-note">複数PDFをまとめて選択できます</span>
        </div>
      </div>
      <div class="business-muted-note" style="margin-bottom:12px">
        1枚だけなら下の欄へ反映します。複数枚なら月ごとに一覧化し、確認後にまとめて保存できます。
      </div>
      <div id="payslip-batch" style="display:none;margin-bottom:16px"></div>
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
      <div class="form-group" style="margin-top:10px"><label for="payslip-memo">メモ</label><input id="payslip-memo" type="text" placeholder="例：給与明細PDFから入力"></div>
      <div id="payslip-status" class="business-muted-note" style="margin-top:8px"></div>
      <div id="payslip-history" style="margin-top:16px"></div>`;

    const paySummary = document.getElementById('nursery-pay-summary');
    if (paySummary) paySummary.insertAdjacentElement('afterend', section);
    else panel.appendChild(section);

    document.getElementById('payslip-month').value = monthValue();
    document.getElementById('payslip-month').addEventListener('change', loadSelectedMonth);
    document.getElementById('payslip-save').addEventListener('click', savePayslip);
    document.getElementById('payslip-pdf-btn').addEventListener('click', () => document.getElementById('payslip-pdf-file').click());
    document.getElementById('payslip-pdf-file').addEventListener('change', importPdf);
    loadSelectedMonth();
    loadHistory();
  }

  async function parsePdfFile(file) {
    const buffer = await file.arrayBuffer();
    const response = await fetch('/api/nursery-payslip/import-pdf', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ filename:file.name, data_b64:arrayBufferToBase64(buffer) }),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) throw new Error(data.error || 'PDFの読取に失敗しました');
    return { ...(data.payslip || {}), _filename: file.name };
  }

  async function importPdf(event) {
    const files = Array.from(event.target.files || []);
    if (!files.length) return;
    const status = document.getElementById('payslip-status');
    const button = document.getElementById('payslip-pdf-btn');
    button.disabled = true;
    status.textContent = `${files.length}件のPDFを読み取り中...`;
    try {
      const results = [];
      const errors = [];
      for (let i = 0; i < files.length; i++) {
        status.textContent = `PDFを読み取り中... ${i + 1}/${files.length}`;
        try {
          results.push(await parsePdfFile(files[i]));
        } catch (e) {
          errors.push(`${files[i].name}: ${e.message}`);
        }
      }

      if (!results.length) throw new Error(errors.join(' / ') || 'PDFの読取に失敗しました');

      if (files.length === 1 && results.length === 1) {
        const p = results[0];
        setField('payslip-month', p.month);
        setField('payslip-hourly', p.hourly_rate);
        setField('payslip-hours', p.worked_hours);
        setField('payslip-leave-used', p.paid_leave_used);
        setField('payslip-leave-balance', p.paid_leave_balance);
        setField('payslip-gross', p.gross_pay);
        setField('payslip-net', p.net_pay);
        setField('payslip-transport', p.transport_pay);
        setField('payslip-deductions', p.deductions);
        setField('payslip-memo', p.memo || `PDF取込: ${p._filename}`);
        status.textContent = 'PDFから読み取りました。数字を確認してから保存してください。';
        renderBatch([]);
      } else {
        batchPayslips = results
          .map(p => ({ ...p, memo: p.memo || `PDF取込: ${p._filename}` }))
          .sort((a, b) => String(a.month || '').localeCompare(String(b.month || '')));
        renderBatch(batchPayslips);
        const suffix = errors.length ? `（${errors.length}件は読取失敗）` : '';
        status.textContent = `${batchPayslips.length}件を読み取りました${suffix}。一覧を確認して「まとめて保存」を押してください。`;
      }
    } catch (e) {
      status.textContent = 'PDF読取エラー: ' + e.message;
    } finally {
      button.disabled = false;
      event.target.value = '';
    }
  }

  function renderBatch(rows) {
    const el = document.getElementById('payslip-batch');
    if (!el) return;
    if (!rows.length) {
      el.style.display = 'none';
      el.innerHTML = '';
      return;
    }
    const counts = rows.reduce((m, r) => {
      if (r.month) m[r.month] = (m[r.month] || 0) + 1;
      return m;
    }, {});
    el.style.display = '';
    el.innerHTML = `
      <div style="display:flex;justify-content:space-between;gap:8px;align-items:center;flex-wrap:wrap;margin-bottom:8px">
        <strong>まとめて取り込み ${rows.length}件</strong>
        <button class="btn btn-primary" id="payslip-batch-save">まとめて保存</button>
      </div>
      <table class="works-table">
        <thead><tr><th>対象月</th><th>勤務時間</th><th>総支給</th><th>手取り</th><th>ファイル</th><th>確認</th></tr></thead>
        <tbody>${rows.map((r, i) => {
          const duplicate = r.month && counts[r.month] > 1;
          const missing = !r.month;
          const note = missing ? '対象月不明' : duplicate ? '同じ月が複数' : 'OK';
          return `<tr>
            <td>${r.month || '—'}</td>
            <td>${r.worked_hours == null ? '—' : Number(r.worked_hours).toFixed(2).replace(/\.00$/,'') + 'h'}</td>
            <td>${yen(r.gross_pay)}</td>
            <td>${yen(r.net_pay)}</td>
            <td>${r._filename || '—'}</td>
            <td>${note}</td>
          </tr>`;
        }).join('')}</tbody>
      </table>`;
    document.getElementById('payslip-batch-save')?.addEventListener('click', saveBatchPayslips);
  }

  async function saveBatchPayslips() {
    if (!batchPayslips.length) return;
    const status = document.getElementById('payslip-status');
    const button = document.getElementById('payslip-batch-save');
    const validRows = batchPayslips.filter(r => /^\d{4}-\d{2}$/.test(r.month || ''));
    if (!validRows.length) {
      status.textContent = '保存できる対象月がありません。';
      return;
    }
    button.disabled = true;
    const errors = [];
    let saved = 0;
    try {
      for (let i = 0; i < validRows.length; i++) {
        status.textContent = `まとめて保存中... ${i + 1}/${validRows.length}`;
        try {
          const response = await fetch('/api/nursery-payslip', {
            method: 'POST',
            headers: {'Content-Type':'application/json'},
            body: JSON.stringify(payslipBody(validRows[i])),
          });
          const data = await response.json();
          if (!response.ok || !data.ok) throw new Error(data.error || '保存失敗');
          saved++;
        } catch (e) {
          errors.push(`${validRows[i].month}: ${e.message}`);
        }
      }
      status.textContent = errors.length
        ? `${saved}件保存しました。${errors.length}件は保存できませんでした。`
        : `${saved}件の給与明細をまとめて保存しました。`;
      if (!errors.length) {
        batchPayslips = [];
        renderBatch([]);
      }
      await loadHistory();
    } finally {
      button.disabled = false;
    }
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
