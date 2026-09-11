/** Business 物販専用タブ。月次から物販を分離し、統計グラフでは全体集計。 */
'use strict';

(function () {
  let merchRows = [];
  let loadedMonth = null;
  let filterBusy = false;

  const yen = v => Number(v || 0).toLocaleString('ja-JP') + '円';
  const esc = v => String(v ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;');

  function todayISO() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
  }
  function monthValue() {
    return (typeof currentMonth !== 'undefined' && /^\d{4}-\d{2}$/.test(currentMonth)) ? currentMonth : todayISO().slice(0,7);
  }
  async function fetchMonthWorks() {
    const r = await fetch(`/api/works?month=${encodeURIComponent(monthValue())}`);
    const d = await r.json();
    if (!r.ok || !d.ok) throw new Error(d.error || '読み込みに失敗しました');
    return d.works || [];
  }

  // ─── サブタブ切替 ──────────────────────────────────────────────────────────
  let merchCurrentSubTab = 'dashboard';

  function switchMerchSubTab(name) {
    merchCurrentSubTab = name;
    ['dashboard', 'register', 'items', 'sold', 'stock', 'competitor'].forEach(t => {
      const el = document.getElementById(`merch-subtab-${t}`);
      if (el) el.hidden = (t !== name);
    });
    document.querySelectorAll('#merch-subtabs [data-merch-tab]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.merchTab === name);
    });
    // インポートセクションはregisterのみ表示
    const importSec = document.getElementById('merch-import-section');
    if (importSec) importSec.hidden = (name !== 'register');
    // 商品一覧系タブの描画フック
    if (typeof window.__jarvisMerchSubTabChanged === 'function') {
      window.__jarvisMerchSubTabChanged(name);
    }
  }

  function ensureUi() {
    // スピナー非表示CSS（一度だけ注入）
    if (!document.getElementById('merch-spinner-style')) {
      const style = document.createElement('style');
      style.id = 'merch-spinner-style';
      style.textContent = `
#biz-tab-merch input[type=number]::-webkit-inner-spin-button,
#biz-tab-merch input[type=number]::-webkit-outer-spin-button,
#modal-merch input[type=number]::-webkit-inner-spin-button,
#modal-merch input[type=number]::-webkit-outer-spin-button { -webkit-appearance:none; margin:0; }
#biz-tab-merch input[type=number], #modal-merch input[type=number] { -moz-appearance:textfield; }
`;
      document.head.appendChild(style);
    }

    const tabs = document.getElementById('business-tabs');
    if (tabs && !document.getElementById('business-merch-tab')) {
      const btn = document.createElement('button');
      btn.id = 'business-merch-tab';
      btn.className = 'sf-tab';
      btn.type = 'button';
      btn.textContent = '物販';
      tabs.appendChild(btn);
      btn.addEventListener('click', openMerchTab);
      tabs.querySelectorAll('[data-biz-tab]').forEach(b => b.addEventListener('click', () => {
        document.getElementById('biz-tab-merch')?.setAttribute('hidden','');
        btn.classList.remove('active');
      }));
    }

    if (!document.getElementById('biz-tab-merch')) {
      const monthly = document.getElementById('biz-tab-monthly');
      if (!monthly) return;
      const panel = document.createElement('div');
      panel.id = 'biz-tab-merch';
      panel.className = 'sf-tab-panel';
      panel.hidden = true;
      panel.innerHTML = `
        <!-- ─── 物販サブタブナビ ─── -->
        <nav class="sf-tabs" id="merch-subtabs" style="
          overflow-x:auto;-webkit-overflow-scrolling:touch;
          flex-wrap:nowrap;white-space:nowrap;
          scrollbar-width:none;
        ">
          <button class="sf-tab active" data-merch-tab="dashboard" style="white-space:nowrap">ダッシュボード</button>
          <button class="sf-tab" data-merch-tab="register" style="white-space:nowrap">登録</button>
          <button class="sf-tab" data-merch-tab="items" style="white-space:nowrap">商品一覧</button>
          <button class="sf-tab" data-merch-tab="sold" style="white-space:nowrap">売却済み</button>
          <button class="sf-tab" data-merch-tab="stock" style="white-space:nowrap">在庫</button>
          <button class="sf-tab" data-merch-tab="competitor" style="white-space:nowrap">競合分析</button>
        </nav>

        <!-- ─── ダッシュボードタブ ─── -->
        <div id="merch-subtab-dashboard" class="sf-tab-panel">
          <div id="merch-dash-stats" style="padding:16px 20px;color:var(--text-sec);font-size:13px">読み込み中...</div>
        </div>

        <!-- ─── 登録タブ ─── -->
        <div id="merch-subtab-register" class="sf-tab-panel" hidden>
          <section class="section">
            <!-- 月次サマリー -->
            <div id="merch-summary-cards" style="margin-bottom:16px"></div>

            <div class="section-header" style="margin-bottom:16px">
              <h2 style="margin:0">物販を登録</h2>
            </div>

            <!-- 登録フォーム（インライン） -->
            <div id="merch-reg-form-wrap">
              <form id="merch-reg-form" autocomplete="off">
                <div class="form-grid">
                  <div class="form-group">
                    <label for="merch-reg-listed-date">出品日 *</label>
                    <input type="date" id="merch-reg-listed-date" required>
                  </div>
                  <div class="form-group">
                    <label for="merch-reg-sold-date">売れた日 <span style="font-size:11px;color:var(--text-sec)">（未販売なら空欄）</span></label>
                    <input type="date" id="merch-reg-sold-date">
                  </div>
                  <div class="form-group">
                    <label for="merch-reg-purchased-date">仕入れた日</label>
                    <input type="date" id="merch-reg-purchased-date">
                  </div>
                  <div class="form-group form-full">
                    <label for="merch-reg-content">商品・内容</label>
                    <input type="text" id="merch-reg-content">
                  </div>

                  <div class="form-group">
                    <label for="merch-reg-income">売上（円）</label>
                    <input type="number" id="merch-reg-income" min="0" placeholder="0" inputmode="numeric">
                  </div>
                  <div class="form-group">
                    <label for="merch-reg-platform">プラットフォーム</label>
                    <select id="merch-reg-platform">
                      <option value="">─ 未選択 ─</option>
                      <option value="メルカリ">メルカリ</option>
                      <option value="ラクマ">ラクマ</option>
                      <option value="ヤフオク">ヤフオク</option>
                      <option value="その他">その他</option>
                    </select>
                  </div>

                  <!-- 原価2点セット：横並び -->
                  <div class="form-group form-full">
                    <label style="display:block;margin-bottom:6px">原価・経費（円）</label>
                    <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
                      <div>
                        <label for="merch-reg-cost-purchase" style="font-size:11px;color:var(--text-sec)">仕入れ原価</label>
                        <input type="number" id="merch-reg-cost-purchase" min="0" placeholder="0" style="width:100%" inputmode="numeric">
                      </div>
                      <div>
                        <label for="merch-reg-cost-shipping" style="font-size:11px;color:var(--text-sec)">送料</label>
                        <input type="number" id="merch-reg-cost-shipping" min="0" placeholder="0" style="width:100%" inputmode="numeric">
                      </div>
                    </div>
                  </div>

                  <div class="form-group">
                    <label for="merch-reg-commission-rate">手数料率（%）</label>
                    <input type="number" id="merch-reg-commission-rate"
                      min="0" max="100" step="0.1" placeholder="例: 10" inputmode="decimal"
                      list="merch-reg-commission-rate-list" style="width:100%">
                    <datalist id="merch-reg-commission-rate-list">
                      <option value="5">5%</option>
                      <option value="8">8%</option>
                      <option value="10">10%（メルカリ標準）</option>
                    </datalist>
                  </div>
                  <div class="form-group">
                    <label for="merch-reg-purchase-place">仕入れ場所</label>
                    <input type="text" id="merch-reg-purchase-place" placeholder="例: ブックオフ、メルカリ">
                  </div>

                  <div class="form-group form-full">
                    <label for="merch-reg-memo">メモ</label>
                    <textarea id="merch-reg-memo"></textarea>
                  </div>
                </div>

                <!-- 利益プレビュー -->
                <div id="merch-reg-profit-preview" style="
                  background:rgba(255,255,255,.04);border:1px solid var(--border);
                  border-radius:8px;padding:10px 14px;margin:8px 0;font-size:13px;display:none
                ">
                  <span style="color:var(--text-sec)">利益プレビュー：</span>
                  <span id="merch-reg-profit-value" style="font-weight:600;font-size:16px"></span>
                  <span id="merch-reg-profit-breakdown" style="color:var(--text-sec);font-size:11px;margin-left:8px"></span>
                </div>

                <div class="error-msg" id="merch-reg-error"></div>
                <div style="margin-top:12px">
                  <button type="submit" class="btn btn-primary">保存する</button>
                </div>
              </form>
            </div>

            <!-- 保存完了後の選択UI -->
            <div id="merch-reg-success" hidden style="
              background:rgba(80,200,120,.08);border:1px solid var(--success);
              border-radius:8px;padding:16px 20px;margin-top:8px;text-align:center
            ">
              <div style="font-size:15px;font-weight:600;color:var(--success);margin-bottom:12px">
                ✓ 登録しました
              </div>
              <div style="display:flex;gap:10px;justify-content:center;flex-wrap:wrap">
                <button class="btn btn-primary" id="merch-reg-continue-btn">続けて登録する</button>
                <button class="btn btn-secondary" id="merch-reg-goto-list-btn">商品一覧へ</button>
              </div>
            </div>

            <!-- 今月の記録（簡易一覧・編集用） -->
            <div style="margin-top:28px">
              <div style="font-size:12px;color:var(--text-sec);margin-bottom:8px;font-weight:600;letter-spacing:.04em">
                今月の物販記録
              </div>
              <div id="merch-container" class="loading">読み込み中...</div>
            </div>
          </section>
        </div>

        <!-- ─── 商品一覧 ─── -->
        <div id="merch-subtab-items" class="sf-tab-panel" hidden>
          <section class="section">
            <div class="section-header"><h2>商品一覧</h2></div>
            <div id="merch-items-container" style="padding:20px;color:var(--text-sec);font-size:13px">
              （実装予定）
            </div>
          </section>
        </div>

        <!-- ─── 売却済み ─── -->
        <div id="merch-subtab-sold" class="sf-tab-panel" hidden>
          <section class="section">
            <div class="section-header"><h2>売却済み</h2></div>
            <div id="merch-sold-container" style="padding:20px;color:var(--text-sec);font-size:13px">
              （実装予定）
            </div>
          </section>
        </div>

        <!-- ─── 在庫 ─── -->
        <div id="merch-subtab-stock" class="sf-tab-panel" hidden>
          <section class="section">
            <div class="section-header"><h2>在庫</h2></div>
            <div id="merch-stock-container" style="padding:20px;color:var(--text-sec);font-size:13px">
              （実装予定）
            </div>
          </section>
        </div>

        <!-- ─── 競合分析 ─── -->
        <div id="merch-subtab-competitor" class="sf-tab-panel" hidden>
          <div id="merch-competitor-root"></div>
        </div>
      `;
      monthly.parentNode.insertBefore(panel, monthly.nextSibling);

      // サブタブ切替
      panel.querySelectorAll('#merch-subtabs [data-merch-tab]').forEach(btn => {
        btn.addEventListener('click', () => switchMerchSubTab(btn.dataset.merchTab));
      });

      // 登録フォームのイベント
      document.getElementById('merch-reg-form').addEventListener('submit', saveMerchReg);
      ['merch-reg-income','merch-reg-cost-purchase','merch-reg-cost-shipping']
        .forEach(id => document.getElementById(id)?.addEventListener('input', updateProfitPreviewReg));
      document.getElementById('merch-reg-commission-rate')?.addEventListener('input', calcCommissionReg);

      // 保存後の選択ボタン
      document.getElementById('merch-reg-continue-btn')?.addEventListener('click', resetRegForm);
      document.getElementById('merch-reg-goto-list-btn')?.addEventListener('click', () => {
        switchMerchSubTab('items');
      });
    }

    // ─── 編集用モーダル ─────────────────────────────────────────────────────
    const overlay = document.getElementById('modal-overlay');
    if (!overlay || document.getElementById('modal-merch')) return;
    const modal = document.createElement('div');
    modal.className = 'modal';
    modal.id = 'modal-merch';
    modal.hidden = true;
    modal.innerHTML = `<h3 id="merch-modal-title">物販を編集</h3>
      <form id="merch-form" autocomplete="off">
        <input type="hidden" id="merch-id">
        <div class="form-grid">
          <div class="form-group">
            <label for="merch-listed-date">出品日 *</label>
            <input type="date" id="merch-listed-date" required>
          </div>
          <div class="form-group">
            <label for="merch-sold-date">売れた日 <span style="font-size:11px;color:var(--text-sec)">（未販売なら空欄）</span></label>
            <input type="date" id="merch-sold-date">
          </div>
          <div class="form-group">
            <label for="merch-purchased-date">仕入れた日</label>
            <input type="date" id="merch-purchased-date">
          </div>
          <div class="form-group form-full"><label for="merch-content">商品・内容</label><input type="text" id="merch-content"></div>

          <div class="form-group"><label for="merch-income">売上（円）</label><input type="number" id="merch-income" min="0" placeholder="0" inputmode="numeric"></div>
          <div class="form-group"><label for="merch-platform">プラットフォーム</label>
            <select id="merch-platform">
              <option value="">─ 未選択 ─</option>
              <option value="メルカリ">メルカリ</option>
              <option value="ラクマ">ラクマ</option>
              <option value="ヤフオク">ヤフオク</option>
              <option value="その他">その他</option>
            </select>
          </div>

          <!-- 原価2点セット：横並び -->
          <div class="form-group form-full">
            <label style="display:block;margin-bottom:6px">原価・経費（円）</label>
            <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
              <div>
                <label for="merch-cost-purchase" style="font-size:11px;color:var(--text-sec)">仕入れ原価</label>
                <input type="number" id="merch-cost-purchase" min="0" placeholder="0" style="width:100%" inputmode="numeric">
              </div>
              <div>
                <label for="merch-cost-shipping" style="font-size:11px;color:var(--text-sec)">送料</label>
                <input type="number" id="merch-cost-shipping" min="0" placeholder="0" style="width:100%" inputmode="numeric">
              </div>
            </div>
          </div>

          <div class="form-group">
            <label for="merch-commission-rate">手数料率（%）</label>
            <input type="number" id="merch-commission-rate"
              min="0" max="100" step="0.1" placeholder="例: 10" inputmode="decimal"
              list="merch-commission-rate-list" style="width:100%">
            <datalist id="merch-commission-rate-list">
              <option value="5">5%</option>
              <option value="8">8%</option>
              <option value="10">10%（メルカリ標準）</option>
            </datalist>
          </div>
          <div class="form-group"><label for="merch-purchase-place">仕入れ場所</label>
            <input type="text" id="merch-purchase-place" placeholder="例: ブックオフ、メルカリ">
          </div>

          <!-- 既存データ用: 旧「原価・経費」フィールド（Phase32以前のデータのみ表示） -->
          <div class="form-group form-full" id="merch-legacy-expense-row" hidden>
            <label style="font-size:12px;color:var(--text-sec)">
              旧・原価経費（参照のみ — 下記の原価欄が未入力の場合に集計へ反映）
            </label>
            <input type="number" id="merch-expense" min="0" readonly
              style="background:var(--card-bg);color:var(--text-sec);width:100%" inputmode="numeric">
          </div>

          <div class="form-group form-full"><label for="merch-memo">メモ</label><textarea id="merch-memo"></textarea></div>
        </div>

        <!-- 利益プレビュー -->
        <div id="merch-profit-preview" style="
          background:rgba(255,255,255,.04);border:1px solid var(--border);
          border-radius:8px;padding:10px 14px;margin:8px 0;font-size:13px;display:none
        ">
          <span style="color:var(--text-sec)">利益プレビュー：</span>
          <span id="merch-profit-value" style="font-weight:600;font-size:16px"></span>
          <span id="merch-profit-breakdown" style="color:var(--text-sec);font-size:11px;margin-left:8px"></span>
        </div>

        <div class="error-msg" id="merch-error"></div>
        <div class="modal-actions">
          <button type="button" class="btn btn-secondary edit-delete-btn" id="merch-delete-btn" hidden>削除</button>
          <button type="button" class="btn btn-secondary" id="merch-cancel-btn">キャンセル</button>
          <button type="submit" class="btn btn-primary">保存する</button>
        </div>
      </form>`;
    overlay.appendChild(modal);
    document.getElementById('merch-cancel-btn').addEventListener('click', closeModal);
    document.getElementById('merch-form').addEventListener('submit', saveMerch);
    document.getElementById('merch-delete-btn').addEventListener('click', deleteMerch);
    // 手数料自動計算・利益プレビュー更新（編集モーダル用）
    ['merch-income','merch-cost-purchase','merch-cost-shipping']
      .forEach(id => document.getElementById(id)?.addEventListener('input', updateProfitPreview));
    document.getElementById('merch-commission-rate')?.addEventListener('input', calcCommission);
  }

  function openMerchTab() {
    document.querySelectorAll('#module-business .sf-tab-panel').forEach(p => { p.hidden = true; });
    const p = document.getElementById('biz-tab-merch');
    if (p) p.hidden = false;
    document.querySelectorAll('#business-tabs .sf-tab').forEach(b => b.classList.remove('active'));
    document.getElementById('business-merch-tab')?.classList.add('active');
    // 初期表示は「ダッシュボード」タブ
    switchMerchSubTab(merchCurrentSubTab || 'dashboard');
    loadMerch(true);
  }

  // ─── 編集モーダル ──────────────────────────────────────────────────────────
  function showModal() {
    const overlay = document.getElementById('modal-overlay');
    const modal = document.getElementById('modal-merch');
    if (!overlay || !modal) return;
    overlay.removeAttribute('hidden');
    document.querySelectorAll('#modal-overlay .modal').forEach(m => { m.hidden = true; });
    modal.hidden = false;
  }
  function closeModal() { document.getElementById('modal-overlay')?.setAttribute('hidden',''); }

  function openModal(row) {
    if (!row) return; // 新規登録は登録タブで行う
    document.getElementById('merch-modal-title').textContent = '物販を編集';
    document.getElementById('merch-id').value               = row.id;
    document.getElementById('merch-listed-date').value      = row.listed_date || row.date || '';
    document.getElementById('merch-sold-date').value        = row.sold_date || '';
    document.getElementById('merch-purchased-date').value   = row.purchased_date || '';
    document.getElementById('merch-content').value          = row.content || '';
    document.getElementById('merch-income').value           = row.income ?? '';
    document.getElementById('merch-platform').value         = row.platform || '';
    document.getElementById('merch-cost-purchase').value    = row.cost_purchase || '';
    document.getElementById('merch-cost-shipping').value    = row.cost_shipping || '';
    document.getElementById('merch-commission-rate').value  = row.commission_rate || '';
    document.getElementById('merch-purchase-place').value   = row.purchase_place || '';
    document.getElementById('merch-memo').value             = row.memo || '';
    document.getElementById('merch-error').textContent      = '';
    document.getElementById('merch-delete-btn').hidden      = false;

    // 旧データ（expense に値があり新フィールドが 0 の場合）は legacy 行を表示
    const hasLegacyExpense = Number(row.expense || 0) > 0
      && !Number(row.cost_purchase) && !Number(row.cost_shipping) && !Number(row.commission_amount);
    const legacyRow = document.getElementById('merch-legacy-expense-row');
    if (legacyRow) legacyRow.hidden = !hasLegacyExpense;
    if (hasLegacyExpense) {
      document.getElementById('merch-expense').value = row.expense;
    }
    updateProfitPreview();
    showModal();
  }

  // ─── 手数料額の内部計算 ────────────────────────────────────────────────────
  function getCommissionAmount(incomeEl, rateEl) {
    const income = Number(incomeEl.value || 0);
    const rate = parseFloat(rateEl.value) || 0;
    return rate > 0 && income > 0 ? Math.round(income * rate / 100) : 0;
  }

  // ─── 編集モーダル 手数料・利益プレビュー ───────────────────────────────────
  function calcCommission() {
    updateProfitPreview();
  }

  function updateProfitPreview() {
    const incomeEl   = document.getElementById('merch-income');
    const rateEl     = document.getElementById('merch-commission-rate');
    const income     = Number(incomeEl?.value || 0);
    const purchase   = Number(document.getElementById('merch-cost-purchase').value    || 0);
    const shipping   = Number(document.getElementById('merch-cost-shipping').value    || 0);
    const comm       = getCommissionAmount(incomeEl, rateEl);
    const legacyEl   = document.getElementById('merch-legacy-expense-row');
    const legacyExp  = (!legacyEl?.hidden) ? Number(document.getElementById('merch-expense').value || 0) : 0;
    const useNew     = purchase > 0 || shipping > 0 || (rateEl && rateEl.value !== '');
    const expense    = useNew ? (purchase + shipping + comm) : legacyExp;
    const profit     = income - expense;
    const prev       = document.getElementById('merch-profit-preview');
    const val        = document.getElementById('merch-profit-value');
    const brkdn      = document.getElementById('merch-profit-breakdown');
    if (!prev) return;
    prev.style.display = income > 0 ? 'block' : 'none';
    if (val) { val.textContent = yen(profit); val.style.color = profit >= 0 ? 'var(--success)' : 'var(--danger)'; }
    if (brkdn && useNew) {
      brkdn.textContent = `（売上${yen(income)} − 仕入${yen(purchase)} − 送料${yen(shipping)} − 手数料${yen(comm)}）`;
    } else if (brkdn) { brkdn.textContent = ''; }
  }

  // ─── 登録タブ 手数料・利益プレビュー ─────────────────────────────────────
  function calcCommissionReg() {
    updateProfitPreviewReg();
  }

  function updateProfitPreviewReg() {
    const incomeEl  = document.getElementById('merch-reg-income');
    const rateEl    = document.getElementById('merch-reg-commission-rate');
    const income    = Number(incomeEl?.value || 0);
    const purchase  = Number(document.getElementById('merch-reg-cost-purchase').value  || 0);
    const shipping  = Number(document.getElementById('merch-reg-cost-shipping').value  || 0);
    const comm      = getCommissionAmount(incomeEl, rateEl);
    const useNew    = purchase > 0 || shipping > 0 || (rateEl && rateEl.value !== '');
    const expense   = useNew ? (purchase + shipping + comm) : 0;
    const profit    = income - expense;
    const prev      = document.getElementById('merch-reg-profit-preview');
    const val       = document.getElementById('merch-reg-profit-value');
    const brkdn     = document.getElementById('merch-reg-profit-breakdown');
    if (!prev) return;
    prev.style.display = income > 0 ? 'block' : 'none';
    if (val) { val.textContent = yen(profit); val.style.color = profit >= 0 ? 'var(--success)' : 'var(--danger)'; }
    if (brkdn && useNew) {
      brkdn.textContent = `（売上${yen(income)} − 仕入${yen(purchase)} − 送料${yen(shipping)} − 手数料${yen(comm)}）`;
    } else if (brkdn) { brkdn.textContent = ''; }
  }

  // ─── 登録タブ フォームリセット ────────────────────────────────────────────
  function resetRegForm() {
    const month = monthValue(), today = todayISO();
    const listedDate = today.startsWith(month) ? today : `${month}-01`;
    document.getElementById('merch-reg-listed-date').value    = listedDate;
    document.getElementById('merch-reg-sold-date').value      = '';
    document.getElementById('merch-reg-purchased-date').value = '';
    document.getElementById('merch-reg-content').value          = '';
    document.getElementById('merch-reg-income').value           = '';
    document.getElementById('merch-reg-platform').value         = '';
    document.getElementById('merch-reg-cost-purchase').value    = '';
    document.getElementById('merch-reg-cost-shipping').value    = '';
    document.getElementById('merch-reg-commission-rate').value  = '';
    document.getElementById('merch-reg-purchase-place').value   = '';
    document.getElementById('merch-reg-memo').value             = '';
    document.getElementById('merch-reg-error').textContent      = '';
    document.getElementById('merch-reg-profit-preview').style.display = 'none';
    // フォームを再表示、成功UIを隠す
    document.getElementById('merch-reg-form-wrap').hidden = false;
    document.getElementById('merch-reg-success').hidden   = true;
  }

  // ─── 登録タブ 保存 ────────────────────────────────────────────────────────
  async function saveMerchReg(e) {
    e.preventDefault();
    const incomeEl   = document.getElementById('merch-reg-income');
    const rateEl     = document.getElementById('merch-reg-commission-rate');
    const income     = Number(incomeEl.value           || 0);
    const purchase   = Number(document.getElementById('merch-reg-cost-purchase').value    || 0);
    const shipping   = Number(document.getElementById('merch-reg-cost-shipping').value    || 0);
    const commAmt    = getCommissionAmount(incomeEl, rateEl);
    const commRate   = rateEl.value || null;
    const platform   = document.getElementById('merch-reg-platform').value         || null;
    const place      = document.getElementById('merch-reg-purchase-place').value.trim() || null;
    const listedDate = document.getElementById('merch-reg-listed-date').value;
    const soldDate   = document.getElementById('merch-reg-sold-date').value || null;
    const purchasedDate = document.getElementById('merch-reg-purchased-date').value || null;
    const useNew     = purchase > 0 || shipping > 0 || commAmt > 0;
    const expense    = useNew ? (purchase + shipping + commAmt) : 0;

    const body = {
      date:              listedDate,
      listed_date:       listedDate,
      sold_date:         soldDate,
      purchased_date:    purchasedDate,
      category:          '物販',
      work_type:         '物販',
      content:           document.getElementById('merch-reg-content').value.trim() || null,
      client:            null,
      income,
      expense,
      invoice_status:    '対象外',
      payment_status:    '対象外',
      memo:              document.getElementById('merch-reg-memo').value.trim() || null,
      cost_purchase:     purchase,
      cost_shipping:     shipping,
      commission_rate:   commRate,
      commission_amount: commAmt,
      platform,
      purchase_place:    place,
    };

    try {
      const r = await fetch('/api/work', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d.error || '保存に失敗しました');

      // 成功UI表示
      document.getElementById('merch-reg-form-wrap').hidden = true;
      document.getElementById('merch-reg-success').hidden   = false;

      // バックグラウンドでデータ更新
      loadedMonth = null;
      if (typeof refresh === 'function') await refresh();
      await keepMonthlyWorkOnly();
      await loadMerch(true);
    } catch (err) {
      document.getElementById('merch-reg-error').textContent = err.message;
    }
  }

  // ─── ロード・レンダリング ─────────────────────────────────────────────────
  async function loadMerch(force=false) {
    ensureUi();
    const month = monthValue();
    if (!force && loadedMonth === month) return;
    loadedMonth = month;
    const c = document.getElementById('merch-container');
    if (!c) return;
    try {
      merchRows = (await fetchMonthWorks()).filter(w => w.category === '物販');
      render();
    } catch(e) { c.className=''; c.textContent='読み込みエラー: '+e.message; }
  }

  function render() {
    const c = document.getElementById('merch-container');
    if (!c) return;
    c.className='';
    const sales  = merchRows.reduce((s,r)=>s+Number(r.income||0),0);
    const costs  = merchRows.reduce((s,r)=>s+Number(r.expense||0),0);
    const profit = sales - costs;

    // 月次サマリーカード
    const sc = document.getElementById('merch-summary-cards');
    if (sc) {
      sc.innerHTML = `<div class="cards-secondary">
        <div class="card"><div class="card-label">物販売上</div><div class="card-value green">${yen(sales)}</div></div>
        <div class="card"><div class="card-label">原価・経費</div><div class="card-value red">${yen(costs)}</div></div>
        <div class="card"><div class="card-label">物販利益</div><div class="card-value ${profit>=0?'green':'red'}">${yen(profit)}</div></div>
      </div>`;
    }

    if (!merchRows.length) {
      c.innerHTML='<div class="empty-state" style="font-size:13px;color:var(--text-sec);padding:12px 0">この月の物販はありません</div>';
      return;
    }
    const rows=merchRows.map(r=>{
      const soldDateVal = r.sold_date;
      const soldCell = soldDateVal
        ? esc(soldDateVal)
        : `<span style="color:var(--text-sec);font-size:11px">在庫中</span>`;
      return `<tr>
        <td>${esc(r.listed_date || r.date)}</td>
        <td>${soldCell}</td>
        <td>${esc(r.content||'—')}</td>
        <td style="text-align:right">${yen(r.income)}</td>
        <td style="text-align:right">${yen(r.expense)}</td>
        <td style="text-align:right;color:${Number(r.income||0)-Number(r.expense||0)>=0?'var(--success)':'var(--danger)'}">${yen(Number(r.income||0)-Number(r.expense||0))}</td>
        <td style="text-align:right"><button class="btn btn-secondary btn-sm" data-merch-edit="${r.id}">編集</button></td>
      </tr>`;
    }).join('');
    c.innerHTML=`<table class="works-table"><thead><tr>
      <th>出品日</th><th>売却</th><th>商品・内容</th><th>売上</th><th>原価・経費</th><th>利益</th><th></th>
    </tr></thead><tbody>${rows}</tbody></table>`;
    c.querySelectorAll('[data-merch-edit]').forEach(btn=>btn.addEventListener('click',()=>{
      const row=merchRows.find(r=>Number(r.id)===Number(btn.dataset.merchEdit));
      if(row) openModal(row);
    }));
  }

  async function keepMonthlyWorkOnly() {
    if (filterBusy) return;
    filterBusy = true;
    try {
      const works = await fetchMonthWorks();
      const normal = works.filter(w => w.category !== '物販');
      const income = normal.reduce((s,w)=>s+Number(w.income||0),0);
      const expense = normal.reduce((s,w)=>s+Number(w.expense||0),0);
      const profit = income-expense;
      const setText = (id,text) => { const el=document.getElementById(id); if(el && el.textContent!==text) el.textContent=text; };
      setText('card-income',yen(income));
      setText('card-expense',yen(expense));
      const p=document.getElementById('card-profit');
      if(p){ const text=yen(profit); if(p.textContent!==text)p.textContent=text; p.className='card-value '+(profit>=0?'green':'red'); }
      const merchIds=new Set(works.filter(w=>w.category==='物販').map(w=>Number(w.id)));
      document.querySelectorAll('#works-tbody tr[data-id]').forEach(tr=>{ if(merchIds.has(Number(tr.dataset.id))) tr.remove(); });
    } catch(_) {} finally { filterBusy=false; }
  }

  // ─── 編集モーダル 保存 ────────────────────────────────────────────────────
  async function saveMerch(e) {
    e.preventDefault();
    const id = Number(document.getElementById('merch-id').value || 0);
    if (!id) return;

    const incomeEl   = document.getElementById('merch-income');
    const rateEl     = document.getElementById('merch-commission-rate');
    const income     = Number(incomeEl.value           || 0);
    const purchase   = Number(document.getElementById('merch-cost-purchase').value    || 0);
    const shipping   = Number(document.getElementById('merch-cost-shipping').value    || 0);
    const commAmt    = getCommissionAmount(incomeEl, rateEl);
    const commRate   = rateEl.value || null;
    const platform   = document.getElementById('merch-platform').value         || null;
    const place      = document.getElementById('merch-purchase-place').value.trim() || null;
    const listedDate = document.getElementById('merch-listed-date').value;
    const soldDate   = document.getElementById('merch-sold-date').value || null;
    const purchasedDate = document.getElementById('merch-purchased-date').value || null;

    const useNewFields = purchase > 0 || shipping > 0 || commAmt > 0;
    const legacyEl     = document.getElementById('merch-legacy-expense-row');
    const legacyExp    = (!legacyEl?.hidden) ? Number(document.getElementById('merch-expense').value || 0) : 0;
    const expense      = useNewFields ? (purchase + shipping + commAmt) : legacyExp;

    const body = {
      date:              listedDate,
      listed_date:       listedDate,
      sold_date:         soldDate,
      purchased_date:    purchasedDate,
      category:          '物販',
      work_type:         '物販',
      content:           document.getElementById('merch-content').value.trim() || null,
      client:            null,
      income,
      expense,
      invoice_status:    '対象外',
      payment_status:    '対象外',
      memo:              document.getElementById('merch-memo').value.trim() || null,
      cost_purchase:     purchase,
      cost_shipping:     shipping,
      commission_rate:   commRate,
      commission_amount: commAmt,
      platform,
      purchase_place:    place,
    };

    try {
      const r = await fetch(`/api/work/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await r.json();
      if (!r.ok || !d.ok) throw new Error(d.error || '保存に失敗しました');
      closeModal();
      loadedMonth = null;
      if (typeof refresh === 'function') await refresh();
      await keepMonthlyWorkOnly();
      await loadMerch(true);
    } catch (err) {
      document.getElementById('merch-error').textContent = err.message;
    }
  }

  async function deleteMerch() {
    const id=Number(document.getElementById('merch-id').value||0);if(!id)return;
    if(!window.confirm('この物販記録を削除しますか？\n削除後は元に戻せません。'))return;
    try{
      const r=await fetch(`/api/work/${id}`,{method:'DELETE'});
      const d=await r.json();
      if(!r.ok||!d.ok)throw new Error(d.error||'削除に失敗しました');
      closeModal();loadedMonth=null;
      if(typeof refresh==='function')await refresh();
      await keepMonthlyWorkOnly();
      await loadMerch(true);
    }catch(err){document.getElementById('merch-error').textContent=err.message;}
  }

  function init() {
    ensureUi();
    resetRegForm();   // 登録フォームの初期値をセット
    keepMonthlyWorkOnly();
    let lastMonth=monthValue();
    const monthEl=document.getElementById('current-month');
    if(monthEl){
      new MutationObserver(()=>{
        const m=monthValue();
        if(m===lastMonth)return;
        lastMonth=m;loadedMonth=null;
        setTimeout(()=>{keepMonthlyWorkOnly();if(!document.getElementById('biz-tab-merch')?.hidden)loadMerch(true);},50);
      }).observe(monthEl,{childList:true,characterData:true,subtree:true});
    }
    const worksEl=document.getElementById('works-table-container');
    if(worksEl){
      new MutationObserver(()=>{ if(!filterBusy) setTimeout(keepMonthlyWorkOnly,30); }).observe(worksEl,{childList:true,subtree:true});
    }
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
})();
