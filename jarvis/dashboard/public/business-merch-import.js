/**
 * business-merch-import.js
 * 物販タブにアパレル / eBay Excel インポート機能を追加する
 *
 * 操作フロー:
 *   Excelを選ぶ → 自動解析・プレビュー → 「登録する」確認 → 完了
 */
'use strict';

(function () {
  const yen  = v => Number(v || 0).toLocaleString('ja-JP') + '円';
  const esc  = v => String(v ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const pct  = v => v != null ? (v * 100).toFixed(1) + '%' : '—';
  const dash = v => (v === null || v === undefined || v === '') ? '—' : esc(String(v));

  let _preview = null;  // 最後のプレビュー結果

  // ─── UI 初期化 ─────────────────────────────────────────────────────────────

  function ensureImportSection() {
    if (document.getElementById('merch-import-section')) return;

    // 物販タブパネルを待つ
    const panel = document.getElementById('biz-tab-merch');
    if (!panel) return;

    const section = document.createElement('section');
    section.className = 'section';
    section.id = 'merch-import-section';
    section.innerHTML = `
      <div class="section-header">
        <h2>物販 Excel インポート</h2>
        <span class="sf-note">アパレル・eBay の商品リストを一括取込</span>
      </div>
      <div style="padding:16px 20px">
        <div id="merch-import-drop"
             style="border:2px dashed #334155;border-radius:8px;padding:28px;text-align:center;
                    cursor:pointer;transition:border-color 0.2s;background:#0f172a">
          <div style="font-size:14px;color:#94a3b8;margin-bottom:6px">クリックまたはドラッグ＆ドロップ</div>
          <div style="font-size:12px;color:#475569">.xlsx 形式（アパレル商品リスト / eBay 商品リスト）</div>
          <input type="file" id="merch-import-file" accept=".xlsx" style="display:none">
        </div>
        <div id="merch-import-status" style="margin-top:10px;font-size:13px;color:#94a3b8"></div>
        <div id="merch-import-preview" hidden></div>
      </div>
    `;

    // 物販タブの最後に追加
    panel.appendChild(section);

    // イベント設定
    const drop = section.querySelector('#merch-import-drop');
    const fileInput = section.querySelector('#merch-import-file');

    drop.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', e => {
      const f = e.target.files?.[0];
      if (f) handleFile(f);
      e.target.value = '';
    });

    drop.addEventListener('dragover', e => { e.preventDefault(); drop.style.borderColor = '#58a6ff'; });
    drop.addEventListener('dragleave', () => { drop.style.borderColor = '#334155'; });
    drop.addEventListener('drop', e => {
      e.preventDefault();
      drop.style.borderColor = '#334155';
      const f = e.dataTransfer?.files?.[0];
      if (f) handleFile(f);
    });
  }

  // ─── ファイル処理 ──────────────────────────────────────────────────────────

  async function handleFile(file) {
    const status = document.getElementById('merch-import-status');
    const previewEl = document.getElementById('merch-import-preview');
    if (!status || !previewEl) return;

    status.textContent = '解析中...';
    previewEl.hidden = true;
    _preview = null;

    try {
      const b64 = await fileToBase64(file);
      const res = await fetch('/api/merch/import-preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ filename: file.name, data_b64: b64 }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || '解析に失敗しました');

      _preview = data;
      renderPreview(data, previewEl);
      previewEl.hidden = false;

      const typeLabel = data.source_type === 'apparel' ? 'アパレル' : 'eBay';
      status.textContent = `${typeLabel} / シート: ${data.sheets.join(', ')} / 全${data.total}件 → 新規 ${data.new_count}件・重複 ${data.dup_count}件`;
    } catch (e) {
      status.textContent = 'エラー: ' + e.message;
    }
  }

  function renderPreview(data, el) {
    const typeLabel = data.source_type === 'apparel' ? 'アパレル' : 'eBay';
    const isApparel = data.source_type === 'apparel';

    const headerCells = isApparel
      ? ['仕入日','ブランド','品名','仕入値','売却日','売上','粗利','粗利率','状態']
      : ['シート','仕入日','品名','仕入値','売却日','売上','粗利','状態'];

    const rows = (data.preview_rows || []).map(r => {
      if (isApparel) {
        return `<tr>
          <td>${dash(r.purchase_date)}</td>
          <td>${dash(r.brand)}</td>
          <td style="max-width:240px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(r.product_name)}</td>
          <td style="text-align:right">${yen(r.purchase_price)}</td>
          <td>${dash(r.sale_date)}</td>
          <td style="text-align:right">${r.sale_price ? yen(r.sale_price) : '—'}</td>
          <td style="text-align:right;${r.profit >= 0 ? 'color:var(--green)' : 'color:var(--red)'}">${yen(r.profit)}</td>
          <td>${pct(r.profit_rate)}</td>
          <td>${esc(r.status)}</td>
        </tr>`;
      } else {
        return `<tr>
          <td style="font-size:11px;color:var(--text-sec)">${dash(r.sheet_name)}</td>
          <td>${dash(r.purchase_date)}</td>
          <td style="max-width:240px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(r.product_name)}</td>
          <td style="text-align:right">${yen(r.purchase_price)}</td>
          <td>${dash(r.sale_date)}</td>
          <td style="text-align:right">${r.sale_price ? yen(r.sale_price) : '—'}</td>
          <td style="text-align:right;${r.profit >= 0 ? 'color:var(--green)' : 'color:var(--red)'}">${yen(r.profit)}</td>
          <td>${esc(r.status)}</td>
        </tr>`;
      }
    }).join('');

    const moreNote = data.new_count > 50
      ? `<div style="font-size:12px;color:var(--text-sec);margin-top:6px">※ 先頭50件を表示。全${data.new_count}件が登録されます。</div>`
      : '';

    el.innerHTML = `
      <div style="margin:14px 0 10px;display:flex;gap:16px;flex-wrap:wrap;align-items:center">
        <span style="font-size:13px;font-weight:600">${typeLabel}</span>
        <span style="font-size:12px;color:var(--text-sec)">全 <strong>${data.total}</strong> 件中 新規 <strong style="color:var(--green)">${data.new_count}</strong> 件 / 重複 ${data.dup_count} 件スキップ</span>
        ${data.new_count > 0
          ? `<button class="btn btn-primary" id="merch-import-confirm-btn" style="margin-left:auto">登録する（${data.new_count}件）</button>`
          : `<span style="color:var(--text-sec);margin-left:auto">新規データはありません</span>`}
      </div>
      ${data.new_count > 0 ? `
        <div style="overflow-x:auto">
          <table class="works-table" style="font-size:12px">
            <thead><tr>${headerCells.map(h => `<th>${h}</th>`).join('')}</tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
        ${moreNote}
      ` : ''}
    `;

    document.getElementById('merch-import-confirm-btn')?.addEventListener('click', confirmImport);
  }

  // ─── 登録確定 ──────────────────────────────────────────────────────────────

  async function confirmImport() {
    if (!_preview) return;
    const btn = document.getElementById('merch-import-confirm-btn');
    const status = document.getElementById('merch-import-status');
    if (btn) btn.disabled = true;

    try {
      const res = await fetch('/api/merch/import-confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: _preview.items,
          meta: {
            filename:    _preview.filename,
            source_type: _preview.source_type,
            sheets:      _preview.sheets,
            total:       _preview.total,
            dup_count:   _preview.dup_count,
          },
        }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error || '登録に失敗しました');

      const typeLabel = _preview.source_type === 'apparel' ? 'アパレル' : 'eBay';
      status.textContent = `✓ 登録完了：${typeLabel} ${data.created}件 登録 / ${data.skipped}件スキップ（import_id: ${data.import_id}）`;
      _preview = null;

      const previewEl = document.getElementById('merch-import-preview');
      if (previewEl) previewEl.hidden = true;
    } catch (e) {
      status.textContent = '登録エラー: ' + e.message;
      if (btn) btn.disabled = false;
    }
  }

  // ─── ユーティリティ ────────────────────────────────────────────────────────

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = e => resolve(e.target.result.split(',')[1]);
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  // ─── 物販タブが開かれたときにセクションを追加 ──────────────────────────────

  function onMerchTabOpen() {
    // business-merch.js が物販タブを動的生成するため、開かれるたびに確認
    ensureImportSection();
  }

  // 物販タブボタンのクリックを監視（business-merch.js のボタンが生成後に動作）
  function watchMerchTab() {
    const interval = setInterval(() => {
      const btn = document.getElementById('business-merch-tab');
      if (btn && !btn.dataset.importListenerBound) {
        btn.dataset.importListenerBound = '1';
        btn.addEventListener('click', () => setTimeout(onMerchTabOpen, 100));
        clearInterval(interval);
      }
    }, 300);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', watchMerchTab, { once: true });
  } else {
    watchMerchTab();
  }
})();
