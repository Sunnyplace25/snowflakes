/**
 * business-merch-competitor.js
 * 競合アカウント分析 UI モジュール
 *
 * 機能:
 *   - アカウント一覧・登録・有効/無効切替
 *   - 今日の分析（スキャンサマリー）
 *   - 売れ筋分析（ブランド/カテゴリ別）
 *   - 仕入れ候補一覧
 *   - 週次/月次レポート一覧
 *   - 設定（手数料率・送料・最低利益など）
 *   - 日次通知ポップアップ（1日1回）
 */
'use strict';

(function () {
  // ─── 状態 ───────────────────────────────────────────────────────────────────

  let currentAccountId = null;
  let accounts = [];
  let competitorSubTab = 'import';

  // ─── ユーティリティ ─────────────────────────────────────────────────────────

  const yen = v => Number(v ?? 0).toLocaleString('ja-JP') + '円';
  const esc = v => String(v ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  const pct = v => (Number(v ?? 0) * 100).toFixed(0) + '%';

  // ─── メイン UI 構築 ─────────────────────────────────────────────────────────

  function ensureCompetitorUi() {
    const root = document.getElementById('merch-competitor-root');
    if (!root || root.dataset.initialized) return;
    root.dataset.initialized = 'true';

    root.innerHTML = `
      <section class="section">
        <!-- タブナビ -->
        <nav class="sf-tabs" id="competitor-subtabs" style="margin-bottom:0;overflow-x:auto;-webkit-overflow-scrolling:touch;flex-wrap:nowrap;white-space:nowrap;scrollbar-width:none">
          <button class="sf-tab active" data-comp-tab="import" style="white-space:nowrap">手動取り込み</button>
          <button class="sf-tab" data-comp-tab="today" style="white-space:nowrap">今日の分析</button>
          <button class="sf-tab" data-comp-tab="accounts" style="white-space:nowrap">競合アカウント</button>
          <button class="sf-tab" data-comp-tab="brands" style="white-space:nowrap">売れ筋分析</button>
          <button class="sf-tab" data-comp-tab="candidates" style="white-space:nowrap">仕入れ候補</button>
          <button class="sf-tab" data-comp-tab="reports" style="white-space:nowrap">レポート</button>
          <button class="sf-tab" data-comp-tab="settings" style="white-space:nowrap">設定</button>
        </nav>

        <!-- 手動取り込み -->
        <div id="comp-tab-import" class="sf-tab-panel" style="padding-top:16px">

          <!-- アカウント選択（seller_id が unknown の場合のみ表示） -->
          <div id="comp-import-account-row" style="display:none;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:16px;padding:12px 16px;background:rgba(251,191,36,.07);border:1px solid rgba(251,191,36,.3);border-radius:8px">
            <span style="font-size:12px;color:#fbbf24">⚠️ seller_id が取得できませんでした。取り込み先アカウントを手動で選択してください:</span>
            <select id="comp-import-account" class="sf-input" style="width:auto"></select>
            <button class="btn btn-primary" id="comp-import-manual-account-btn" style="font-size:13px">この先アカウントへ取り込む</button>
          </div>

          <!-- ブックマークレット案内 -->
          <div style="background:rgba(96,165,250,.07);border:1px solid rgba(96,165,250,.25);border-radius:10px;padding:16px 18px;margin-bottom:16px">
            <div style="font-size:13px;font-weight:600;color:#93c5fd;margin-bottom:10px">
              📌 ステップ1 — ブックマークレットをEdgeに登録する
            </div>
            <p style="font-size:12px;color:var(--text-sec);margin:0 0 12px">
              メルカリにログイン不要・追加通信なし・Cookie非取得の安全な抽出ツールです。
            </p>
            <button id="comp-bookmarklet-copy-btn" class="btn btn-secondary"
                    style="font-size:13px;padding:7px 18px">
              📋 ブックマークレットをコピー
            </button>
            <div id="comp-bookmarklet-msg" style="margin-top:10px;font-size:12px;display:none"></div>
            <textarea id="comp-bookmarklet-fallback"
                      style="display:none;width:100%;margin-top:10px;height:64px;resize:none;
                             font-family:monospace;font-size:11px;
                             background:var(--bg-card);border:1px solid var(--border);
                             border-radius:6px;padding:8px;color:var(--text);box-sizing:border-box"
                      readonly></textarea>
          </div>

          <!-- 取り込み手順 -->
          <div style="background:rgba(255,255,255,.03);border:1px solid var(--border);border-radius:10px;padding:16px 18px;margin-bottom:16px">
            <div style="font-size:13px;font-weight:600;margin-bottom:10px">
              📋 ステップ2 — メルカリから商品データを取得する
            </div>
            <ol style="font-size:12px;color:var(--text-sec);margin:0;padding-left:20px;line-height:1.9">
              <li>Edgeのお気に入りを右クリック →「お気に入りを追加」→ 名前を「JARVIS用に保存」、URLへ上でコピーしたコードを貼り付け</li>
              <li>通常のブラウザで競合の<strong>メルカリプロフィールページ</strong>を開く</li>
              <li><strong>1回目クリック</strong>: 「収集開始」アラートを確認 → ページを一番下までスクロール</li>
              <li><strong>2回目クリック</strong>: JSONファイルが自動ダウンロードされる（出品者ごとに自動判別）</li>
              <li>下のドロップゾーンにファイルをドラッグ＆ドロップ（またはファイル選択）</li>
            </ol>
          </div>

          <!-- ドロップゾーン -->
          <div id="comp-import-dropzone" style="
            border:2px dashed rgba(96,165,250,.4);border-radius:10px;
            padding:32px 20px;text-align:center;cursor:pointer;
            transition:border-color .2s,background .2s;margin-bottom:12px
          ">
            <div style="font-size:28px;margin-bottom:8px">📂</div>
            <div style="font-size:14px;font-weight:600;margin-bottom:6px">
              JSONファイルをここにドロップ
            </div>
            <div style="font-size:12px;color:var(--text-sec);margin-bottom:14px">
              または
            </div>
            <label style="cursor:pointer">
              <input type="file" id="comp-import-file" accept=".json,.csv" style="display:none">
              <span class="btn btn-secondary" style="font-size:13px;pointer-events:none">
                ファイルを選択
              </span>
            </label>
          </div>

          <!-- テキスト直接貼り付け（上級者向け） -->
          <details style="margin-bottom:12px">
            <summary style="font-size:12px;color:var(--text-sec);cursor:pointer;padding:6px 0">
              テキストを直接貼り付ける（JSON / CSV）
            </summary>
            <div style="margin-top:10px">
              <div style="display:flex;gap:8px;margin-bottom:8px">
                <button class="btn btn-secondary comp-import-fmt-btn active" data-fmt="json" style="font-size:12px;padding:4px 12px">JSON</button>
                <button class="btn btn-secondary comp-import-fmt-btn" data-fmt="csv" style="font-size:12px;padding:4px 12px">CSV</button>
                <a href="/api/competitor/import/template" download style="margin-left:auto;font-size:12px;color:var(--text-sec);align-self:center;text-decoration:none">
                  CSVテンプレートをダウンロード
                </a>
              </div>
              <textarea id="comp-import-text"
                placeholder="JSONまたはCSVテキストをここに貼り付けてください..."
                style="width:100%;height:120px;resize:vertical;font-family:monospace;font-size:12px;
                       background:var(--bg-card);border:1px solid var(--border);border-radius:6px;
                       padding:8px;color:var(--text);box-sizing:border-box"></textarea>
              <button class="btn btn-primary" id="comp-import-text-btn" style="margin-top:8px;font-size:13px">
                テキストから取り込む
              </button>
            </div>
          </details>

          <!-- 取り込み結果 -->
          <div id="comp-import-result"></div>
        </div>

        <!-- 今日の分析 -->
        <div id="comp-tab-today" class="sf-tab-panel" hidden style="padding-top:16px">
          <div style="display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:12px">
            <div>
              <label style="font-size:13px;color:var(--text-sec)">アカウント: </label>
              <select id="comp-account-select" class="sf-input" style="width:auto;display:inline-block"></select>
            </div>
          </div>
          <div id="comp-today-content" class="loading">読み込み中...</div>
        </div>

        <!-- 競合アカウント -->
        <div id="comp-tab-accounts" class="sf-tab-panel" hidden style="padding-top:16px">
          <div class="section-header" style="margin-bottom:12px">
            <h3 style="margin:0">登録アカウント</h3>
            <button class="btn btn-primary" id="comp-add-account-btn">＋ 追加</button>
          </div>
          <div id="comp-accounts-list"></div>
        </div>

        <!-- 売れ筋分析 -->
        <div id="comp-tab-brands" class="sf-tab-panel" hidden style="padding-top:16px">
          <div id="comp-brands-selector" style="margin-bottom:12px">
            <label style="font-size:13px;color:var(--text-sec)">アカウント: </label>
            <select id="comp-brands-account-select" class="sf-input" style="width:auto;display:inline-block"></select>
          </div>
          <div id="comp-brands-content" class="loading">読み込み中...</div>
        </div>

        <!-- 仕入れ候補 -->
        <div id="comp-tab-candidates" class="sf-tab-panel" hidden style="padding-top:16px">
          <div id="comp-candidates-selector" style="margin-bottom:12px">
            <label style="font-size:13px;color:var(--text-sec)">アカウント: </label>
            <select id="comp-candidates-account-select" class="sf-input" style="width:auto;display:inline-block"></select>
          </div>
          <div id="comp-candidates-content" class="loading">読み込み中...</div>
        </div>

        <!-- レポート -->
        <div id="comp-tab-reports" class="sf-tab-panel" hidden style="padding-top:16px">
          <div id="comp-reports-content" class="loading">読み込み中...</div>
        </div>

        <!-- 設定 -->
        <div id="comp-tab-settings" class="sf-tab-panel" hidden style="padding-top:16px">
          <div id="comp-settings-content" class="loading">読み込み中...</div>
        </div>
      </section>

      <!-- アカウント登録モーダル -->
      <div id="comp-add-modal" style="
        display:none; position:fixed; inset:0; background:rgba(0,0,0,.6);
        z-index:9999; align-items:center; justify-content:center;
      ">
        <div style="
          background:var(--card-bg); border-radius:12px; padding:24px;
          width:420px; max-width:90vw; box-shadow:0 8px 32px rgba(0,0,0,.4);
        ">
          <h3 style="margin:0 0 16px">競合アカウントを追加</h3>
          <div class="form-group" style="margin-bottom:12px">
            <label style="font-size:13px;color:var(--text-sec)">プロフィール URL *</label>
            <input type="url" id="comp-modal-url" class="sf-input" style="width:100%;margin-top:4px"
              placeholder="https://jp.mercari.com/user/profile/123456789">
          </div>
          <div class="form-group" style="margin-bottom:12px">
            <label style="font-size:13px;color:var(--text-sec)">表示名（任意）</label>
            <input type="text" id="comp-modal-name" class="sf-input" style="width:100%;margin-top:4px"
              placeholder="セラー名">
          </div>
          <div class="form-group" style="margin-bottom:16px">
            <label style="font-size:13px;color:var(--text-sec)">メモ（任意）</label>
            <input type="text" id="comp-modal-note" class="sf-input" style="width:100%;margin-top:4px">
          </div>
          <div id="comp-modal-error" style="color:var(--danger);font-size:13px;margin-bottom:8px;display:none"></div>
          <div style="display:flex;gap:8px;justify-content:flex-end">
            <button class="btn btn-secondary" id="comp-modal-cancel">キャンセル</button>
            <button class="btn btn-primary" id="comp-modal-save">登録</button>
          </div>
        </div>
      </div>
    `;

    // タブ切替
    root.querySelectorAll('#competitor-subtabs [data-comp-tab]').forEach(btn => {
      btn.addEventListener('click', () => switchCompTab(btn.dataset.compTab));
    });

    // アカウントセレクタ連動
    root.getElementById = root.querySelector.bind(root);
    document.getElementById('comp-account-select').addEventListener('change', e => {
      currentAccountId = parseInt(e.target.value, 10) || null;
      loadToday();
    });
    document.getElementById('comp-brands-account-select').addEventListener('change', e => {
      currentAccountId = parseInt(e.target.value, 10) || null;
      loadBrands();
    });
    document.getElementById('comp-candidates-account-select').addEventListener('change', e => {
      currentAccountId = parseInt(e.target.value, 10) || null;
      loadCandidates();
    });

    // アカウント追加ボタン
    document.getElementById('comp-add-account-btn').addEventListener('click', openAddModal);
    document.getElementById('comp-modal-cancel').addEventListener('click', closeAddModal);
    document.getElementById('comp-modal-save').addEventListener('click', saveAccount);

    // 手動取り込みイベント
    setupImportUi();

    loadAccounts();
    checkNotifications();
  }

  // ─── タブ切替 ──────────────────────────────────────────────────────────────

  function switchCompTab(name) {
    competitorSubTab = name;
    ['import', 'today', 'accounts', 'brands', 'candidates', 'reports', 'settings'].forEach(t => {
      const el = document.getElementById(`comp-tab-${t}`);
      if (el) el.hidden = (t !== name);
    });
    document.querySelectorAll('#competitor-subtabs [data-comp-tab]').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.compTab === name);
    });
    if      (name === 'today')      loadToday();
    else if (name === 'accounts')   renderAccountsList();
    else if (name === 'brands')     loadBrands();
    else if (name === 'candidates') loadCandidates();
    else if (name === 'reports')    loadReports();
    else if (name === 'settings')   loadSettings();
  }

  // ─── アカウント読み込み ────────────────────────────────────────────────────

  async function loadAccounts() {
    try {
      const res = await fetch('/api/competitor/accounts');
      const d = await res.json();
      if (!d.ok) throw new Error(d.error);
      accounts = d.accounts ?? [];
      if (accounts.length > 0 && !currentAccountId) {
        currentAccountId = accounts[0].id;
      }
      populateAccountSelects();
      if (competitorSubTab === 'accounts') renderAccountsList();
      if (competitorSubTab === 'today')    loadToday();
    } catch (e) {
      console.error('[competitor] アカウント読み込み失敗:', e);
    }
  }

  function populateAccountSelects() {
    const opts = accounts.map(a =>
      `<option value="${a.id}" ${a.id === currentAccountId ? 'selected' : ''}>${esc(a.display_name)}</option>`
    ).join('');
    const noAcct = '<option value="">（アカウントなし）</option>';
    for (const id of [
      'comp-account-select',
      'comp-brands-account-select',
      'comp-candidates-account-select',
    ]) {
      const el = document.getElementById(id);
      if (el) el.innerHTML = opts || noAcct;
    }
    // 手動選択欄: 全アカウント（非アクティブ含む）を表示
    const importSel = document.getElementById('comp-import-account');
    if (importSel) {
      importSel.innerHTML = accounts.map(a =>
        `<option value="${a.id}">${esc(a.display_name)}${a.is_active ? '' : '（無効）'}</option>`
      ).join('') || noAcct;
    }
  }

  function renderAccountsList() {
    const el = document.getElementById('comp-accounts-list');
    if (!el) return;
    if (accounts.length === 0) {
      el.innerHTML = '<p style="color:var(--text-sec);font-size:13px;padding:12px">登録アカウントがありません。右上の「＋ 追加」から登録してください。</p>';
      return;
    }
    el.innerHTML = `
      <table class="sf-table" style="width:100%">
        <thead><tr>
          <th>セラー名</th><th>メルカリID</th><th>最終取り込み</th><th>状態</th><th></th>
        </tr></thead>
        <tbody>
          ${accounts.map(a => `
            <tr>
              <td>${esc(a.display_name)}</td>
              <td><a href="${esc(a.profile_url)}" target="_blank" rel="noopener">${esc(a.mercari_user_id)}</a></td>
              <td style="font-size:12px;color:var(--text-sec)">${a.last_scanned_at ? a.last_scanned_at.slice(0,10) : '未取り込み'}</td>
              <td><span style="
                display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;
                background:${a.is_active ? 'rgba(74,222,128,.15)' : 'rgba(255,255,255,.07)'};
                color:${a.is_active ? 'var(--success)' : 'var(--text-sec)'}
              ">${a.is_active ? '有効' : '無効'}</span></td>
              <td>
                <button class="btn btn-secondary" style="font-size:11px;padding:3px 8px"
                  onclick="window.__jarvisCompetitorToggle(${a.id}, ${a.is_active ? 0 : 1})">
                  ${a.is_active ? '無効化' : '有効化'}
                </button>
              </td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;

    window.__jarvisCompetitorToggle = async (id, isActive) => {
      await fetch(`/api/competitor/accounts/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_active: isActive }),
      });
      loadAccounts();
    };
  }

  // ─── 今日の分析 ────────────────────────────────────────────────────────────

  async function loadToday() {
    const el = document.getElementById('comp-today-content');
    if (!el) return;
    if (!currentAccountId) {
      el.innerHTML = '<p style="color:var(--text-sec);font-size:13px;padding:12px">アカウントを選択してください。</p>';
      return;
    }
    el.innerHTML = '<div class="loading">読み込み中...</div>';
    try {
      const [scanRes, analysisRes] = await Promise.all([
        fetch(`/api/competitor/accounts/${currentAccountId}/scans?limit=7`),
        fetch(`/api/competitor/accounts/${currentAccountId}/analysis`),
      ]);
      const scanData     = await scanRes.json();
      const analysisData = await analysisRes.json();
      if (!scanData.ok)     throw new Error(scanData.error);
      if (!analysisData.ok) throw new Error(analysisData.error);

      const scans = scanData.scans ?? [];
      const latest = scans[0];

      el.innerHTML = `
        <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(140px,1fr));gap:12px;margin-bottom:20px">
          ${statCard('新規', latest?.items_new ?? 0, '件')}
          ${statCard('売却', latest?.items_sold ?? 0, '件')}
          ${statCard('価格変化', latest?.items_price_changed ?? 0, '件')}
          ${statCard('消失', latest?.items_missing ?? 0, '件')}
          ${statCard('再出品', latest?.items_reappeared ?? 0, '件')}
          ${statCard('取得件数', latest?.items_fetched ?? 0, '件')}
        </div>
        ${latest ? `<p style="font-size:12px;color:var(--text-sec)">
          スキャン日: ${latest.scan_date} / 状態: ${latest.status}
          ${latest.error_message ? `<br><span style="color:var(--danger)">${esc(latest.error_message)}</span>` : ''}
        </p>` : '<p style="color:var(--text-sec);font-size:13px">スキャン結果がありません。</p>'}

        <h4 style="margin:20px 0 10px;font-size:14px">直近スキャン履歴</h4>
        ${renderScanHistory(scans)}

        <h4 style="margin:20px 0 10px;font-size:14px">仕入れ候補（上位5件）</h4>
        ${renderCandidatesTable((analysisData.buying_candidates ?? []).slice(0, 5))}
      `;
    } catch (e) {
      el.innerHTML = `<p style="color:var(--danger);font-size:13px">${esc(e.message)}</p>`;
    }
  }

  function statCard(label, value, unit) {
    return `
      <div style="
        background:var(--card-bg);border:1px solid var(--border);
        border-radius:8px;padding:12px;text-align:center
      ">
        <div style="font-size:22px;font-weight:700;color:var(--text)">${value}${unit}</div>
        <div style="font-size:12px;color:var(--text-sec);margin-top:2px">${label}</div>
      </div>
    `;
  }

  function renderScanHistory(scans) {
    if (scans.length === 0) return '<p style="color:var(--text-sec);font-size:13px">履歴がありません。</p>';
    return `
      <table class="sf-table" style="width:100%;font-size:12px">
        <thead><tr>
          <th>日付</th><th>状態</th><th>新規</th><th>売却</th><th>価格変化</th><th>取得</th>
        </tr></thead>
        <tbody>
          ${scans.slice(0, 7).map(s => `
            <tr>
              <td>${s.scan_date}</td>
              <td><span style="color:${s.status === 'completed' ? 'var(--success)' : s.status === 'failed' ? 'var(--danger)' : 'var(--text-sec)'}">${s.status}</span></td>
              <td>${s.items_new}</td>
              <td>${s.items_sold}</td>
              <td>${s.items_price_changed}</td>
              <td>${s.items_fetched}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  // ─── 売れ筋分析 ───────────────────────────────────────────────────────────

  async function loadBrands() {
    const el = document.getElementById('comp-brands-content');
    if (!el) return;
    if (!currentAccountId) {
      el.innerHTML = '<p style="color:var(--text-sec);font-size:13px">アカウントを選択してください。</p>';
      return;
    }
    el.innerHTML = '<div class="loading">読み込み中...</div>';
    try {
      const res = await fetch(`/api/competitor/accounts/${currentAccountId}/analysis`);
      const d   = await res.json();
      if (!d.ok) throw new Error(d.error);

      const brands    = d.brand_ranking   ?? [];
      const cats      = d.category_stats  ?? [];

      el.innerHTML = `
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px">
          <div>
            <h4 style="margin:0 0 10px;font-size:14px">売れ筋ブランド（上位）</h4>
            ${renderBrandTable(brands)}
          </div>
          <div>
            <h4 style="margin:0 0 10px;font-size:14px">カテゴリ別統計</h4>
            ${renderCategoryTable(cats)}
          </div>
        </div>
      `;
    } catch (e) {
      el.innerHTML = `<p style="color:var(--danger);font-size:13px">${esc(e.message)}</p>`;
    }
  }

  function renderBrandTable(brands) {
    if (brands.length === 0) return '<p style="color:var(--text-sec);font-size:13px">データがありません。</p>';
    return `
      <table class="sf-table" style="width:100%;font-size:12px">
        <thead><tr><th>ブランド</th><th>売却数</th><th>平均価格</th></tr></thead>
        <tbody>
          ${brands.map(b => `
            <tr>
              <td>${esc(b.brand)}</td>
              <td>${b.sold_count}件</td>
              <td>${yen(b.avg_price)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  function renderCategoryTable(cats) {
    if (cats.length === 0) return '<p style="color:var(--text-sec);font-size:13px">データがありません。</p>';
    return `
      <table class="sf-table" style="width:100%;font-size:12px">
        <thead><tr><th>カテゴリ</th><th>出品中</th><th>売却</th><th>平均売値</th></tr></thead>
        <tbody>
          ${cats.map(c => `
            <tr>
              <td>${esc(c.category)}</td>
              <td>${c.on_sale_count}</td>
              <td>${c.sold_count}</td>
              <td>${c.avg_sold_price ? yen(c.avg_sold_price) : '—'}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  // ─── 仕入れ候補 ───────────────────────────────────────────────────────────

  async function loadCandidates() {
    const el = document.getElementById('comp-candidates-content');
    if (!el) return;
    if (!currentAccountId) {
      el.innerHTML = '<p style="color:var(--text-sec);font-size:13px">アカウントを選択してください。</p>';
      return;
    }
    el.innerHTML = '<div class="loading">読み込み中...</div>';
    try {
      const res = await fetch(`/api/competitor/accounts/${currentAccountId}/analysis`);
      const d   = await res.json();
      if (!d.ok) throw new Error(d.error);
      el.innerHTML = renderCandidatesTable(d.buying_candidates ?? []);
    } catch (e) {
      el.innerHTML = `<p style="color:var(--danger);font-size:13px">${esc(e.message)}</p>`;
    }
  }

  function renderCandidatesTable(candidates) {
    if (candidates.length === 0) {
      return '<p style="color:var(--text-sec);font-size:13px">仕入れ候補がありません。スキャン後にデータが蓄積されます。</p>';
    }
    return `
      <table class="sf-table" style="width:100%;font-size:12px">
        <thead><tr>
          <th>商品名</th><th>ブランド</th><th>カテゴリ</th>
          <th>現在価格</th><th>買付上限</th><th>利益幅</th>
        </tr></thead>
        <tbody>
          ${candidates.map(c => `
            <tr>
              <td style="max-width:160px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap"
                title="${esc(c.name)}">${esc(c.name)}</td>
              <td>${esc(c.classified_brand ?? c.brand ?? '—')}</td>
              <td>${esc(c.classified_category ?? c.category ?? '—')}</td>
              <td>${yen(c.price)}</td>
              <td style="color:var(--success)">${yen(c.buying_limit)}</td>
              <td style="color:var(--accent-blue)">${yen((c.buying_limit ?? 0) - c.price)}</td>
            </tr>
          `).join('')}
        </tbody>
      </table>
    `;
  }

  // ─── レポート ──────────────────────────────────────────────────────────────

  async function loadReports() {
    const el = document.getElementById('comp-reports-content');
    if (!el) return;
    el.innerHTML = '<div class="loading">読み込み中...</div>';
    try {
      const res = await fetch('/api/competitor/reports');
      const d   = await res.json();
      if (!d.ok) throw new Error(d.error);
      const reports = d.reports ?? [];
      if (reports.length === 0) {
        el.innerHTML = '<p style="color:var(--text-sec);font-size:13px;padding:12px">レポートがありません。週次（月曜）・月次（1日）のスキャン後に自動生成されます。</p>';
        return;
      }
      el.innerHTML = `
        <table class="sf-table" style="width:100%;font-size:12px">
          <thead><tr><th>種別</th><th>期間</th><th>生成日</th></tr></thead>
          <tbody>
            ${reports.map(r => {
              let body = {};
              try { body = JSON.parse(r.body); } catch (_) {}
              return `
                <tr>
                  <td>${r.report_type === 'weekly' ? '週次' : '月次'}</td>
                  <td>${r.period_start} 〜 ${r.period_end}</td>
                  <td style="color:var(--text-sec)">${r.created_at?.slice(0,10) ?? ''}</td>
                </tr>
              `;
            }).join('')}
          </tbody>
        </table>
      `;
    } catch (e) {
      el.innerHTML = `<p style="color:var(--danger);font-size:13px">${esc(e.message)}</p>`;
    }
  }

  // ─── 設定 ─────────────────────────────────────────────────────────────────

  async function loadSettings() {
    const el = document.getElementById('comp-settings-content');
    if (!el) return;
    el.innerHTML = '<div class="loading">読み込み中...</div>';
    try {
      const res = await fetch('/api/competitor/settings');
      const d   = await res.json();
      if (!d.ok) throw new Error(d.error);
      const s = d.settings ?? {};
      el.innerHTML = `
        <div style="max-width:480px">
          <h4 style="margin:0 0 16px;font-size:14px">買付け上限計算パラメータ</h4>
          ${settingRow('fee_rate',         'メルカリ手数料率', s.fee_rate         ?? '0.10', 'number', '0.01〜0.20')}
          ${settingRow('shipping_cost',    '送料目安（円）',   s.shipping_cost    ?? '600',  'number', '0〜2000')}
          ${settingRow('min_profit',       '最低利益（円）',   s.min_profit       ?? '2000', 'number', '0〜10000')}
          ${settingRow('max_items_per_scan','最大スキャン件数', s.max_items_per_scan ?? '300', 'number', '1〜300')}
          <div style="margin-top:16px">
            <button class="btn btn-primary" id="comp-settings-save">保存する</button>
            <span id="comp-settings-msg" style="margin-left:10px;font-size:13px;color:var(--success)"></span>
          </div>
        </div>
      `;
      document.getElementById('comp-settings-save').addEventListener('click', saveSettings);
    } catch (e) {
      el.innerHTML = `<p style="color:var(--danger);font-size:13px">${esc(e.message)}</p>`;
    }
  }

  function settingRow(key, label, value, type, hint) {
    return `
      <div class="form-group" style="margin-bottom:12px">
        <label style="font-size:13px;color:var(--text-sec);display:block;margin-bottom:4px">
          ${label}${hint ? ` <span style="font-size:11px">(${hint})</span>` : ''}
        </label>
        <input type="${type}" id="comp-setting-${key}" class="sf-input"
          style="width:160px" value="${esc(value)}" data-key="${key}">
      </div>
    `;
  }

  async function saveSettings() {
    const body = {};
    document.querySelectorAll('[id^="comp-setting-"]').forEach(el => {
      body[el.dataset.key] = el.value;
    });
    try {
      const res = await fetch('/api/competitor/settings', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await res.json();
      if (!d.ok) throw new Error(d.error);
      const msg = document.getElementById('comp-settings-msg');
      if (msg) { msg.textContent = '保存しました'; setTimeout(() => { msg.textContent = ''; }, 2000); }
    } catch (e) {
      alert('保存失敗: ' + e.message);
    }
  }

  // ─── アカウント登録モーダル ────────────────────────────────────────────────

  function openAddModal() {
    const modal = document.getElementById('comp-add-modal');
    if (!modal) return;
    modal.style.display = 'flex';
    document.getElementById('comp-modal-url').value  = '';
    document.getElementById('comp-modal-name').value = '';
    document.getElementById('comp-modal-note').value = '';
    const errEl = document.getElementById('comp-modal-error');
    if (errEl) { errEl.style.display = 'none'; errEl.textContent = ''; }
  }

  function closeAddModal() {
    const modal = document.getElementById('comp-add-modal');
    if (modal) modal.style.display = 'none';
  }

  async function saveAccount() {
    const profile_url  = document.getElementById('comp-modal-url').value.trim();
    const display_name = document.getElementById('comp-modal-name').value.trim();
    const note         = document.getElementById('comp-modal-note').value.trim();
    const errEl        = document.getElementById('comp-modal-error');

    if (!profile_url) {
      errEl.textContent = 'プロフィール URL を入力してください';
      errEl.style.display = 'block';
      return;
    }

    try {
      const res = await fetch('/api/competitor/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profile_url, display_name: display_name || undefined, note: note || undefined }),
      });
      const d = await res.json();
      if (!d.ok) throw new Error(d.error);
      closeAddModal();
      await loadAccounts();
      currentAccountId = d.id;
      populateAccountSelects();
      switchCompTab('accounts');
    } catch (e) {
      errEl.textContent = e.message;
      errEl.style.display = 'block';
    }
  }

  // ─── 手動取り込み ──────────────────────────────────────────────────────────

  /**
   * ブックマークレットコードを生成する。
   *
   * 【重要】テンプレートリテラル内の \d \/ 等はJSエンジンに文字列として
   * 解釈される際にバックスラッシュが消えるため、正規表現を一切使わない実装にする。
   * パス解析は split('/') + indexOf、数字抽出は charCode 比較で代替する。
   *
   * - メルカリへの追加通信なし
   * - ログイン情報・Cookie・トークン取得なし
   * - 現在ページの __NEXT_DATA__ または DOM から公開情報のみ抽出
   * - revokeObjectURL は 3 秒後（ダウンロード完了を待つ）
   */
  function buildBookmarklet() {
    // 2クリック方式: 1回目→MutationObserver開始、2回目→JSON保存
    // 正規表現なし・自動スクロールなし・追加通信なし
    const lines = [
      '(function(){',
      'var KEY="__jarvisCollector";',
      // ════ PHASE 1: 収集開始 ═══════════════════════════════════════════
      'if(!window[KEY]){',
      'window[KEY]={items:{},obs:null};',
      // カード1枚からIDを取り出し items に蓄積（重複はスキップ）
      'function extractCard(c){',
      '  var anc=c.querySelector("a");',
      '  var img=c.querySelector("img");',
      '  var pm=c.querySelector("[class*=\'price\'],[class*=\'Price\']");',
      '  var nm=c.querySelector("[class*=\'name\'],[class*=\'Name\'],[class*=\'title\']");',
      '  var href=anc?anc.href:"";',
      '  var hp=href.split("/").filter(function(p){return p.length>0;});',
      '  var iIdx=hp.indexOf("item");',
      '  var itemId=iIdx>=0&&hp[iIdx+1]?hp[iIdx+1]:null;',
      '  if(!itemId||window[KEY].items[itemId])return;',
      // 価格: charCode 48-57 = '0'-'9'
      '  var pt=pm?pm.textContent:"";',
      '  var pd="";',
      '  for(var i=0;i<pt.length;i++){var cc=pt.charCodeAt(i);if(cc>=48&&cc<=57)pd+=pt[i];}',
      // 販売状態: sold系クラス → SOLD_OUT、それ以外はバッジテキストで判定
      '  var st="ITEM_STATUS_ON_SALE";',
      '  var soldEl=c.querySelector("[class*=\'sold\'],[class*=\'Sold\'],[data-testid*=\'sold\']");',
      '  if(soldEl){st="ITEM_STATUS_SOLD_OUT";}',
      '  else{',
      '    var badge=c.querySelector("[class*=\'badge\'],[class*=\'label\'],[class*=\'status\'],[class*=\'overlay\']");',
      '    if(badge){var bt=badge.textContent;if(bt.indexOf("SOLD")>=0||bt.indexOf("\u58f2\u308a\u5207\u308c")>=0)st="ITEM_STATUS_SOLD_OUT";}',
      '  }',
      '  window[KEY].items[itemId]={id:itemId,name:nm?nm.textContent.trim():null,price:pd?parseInt(pd,10):0,status:st,image_url:img?img.src:null,item_url:href};',
      '}',
      // 現在表示中の全カードをスキャン
      'function scan(){',
      '  var cards=document.querySelectorAll("[data-testid=\'item-cell\'],[data-location*=\'item_thumbnail_list\'],[class*=\'merItem\'],[class*=\'item-cell\']");',
      '  Array.from(cards).forEach(extractCard);',
      '}',
      // __NEXT_DATA__ から初期10件を取得（ブランド・カテゴリ等リッチデータ付き）
      'var nd=window.__NEXT_DATA__;',
      'if(nd){',
      '  var pp=(nd.props&&nd.props.pageProps)||{};',
      '  var ri=pp.items||(pp.data&&pp.data.items)||(pp.seller&&pp.seller.items)||(pp.searchResult&&pp.searchResult.items)||[];',
      '  ri.forEach(function(r){',
      '    var id=String(r.id||"").trim();if(!id)return;',
      '    var price=(r.price&&typeof r.price==="object")?Number(r.price.amount||r.price.value||0):Number(r.price||0);',
      '    window[KEY].items[id]={',
      '      id:id,name:r.name||"",price:price,',
      '      status:r.status||"ITEM_STATUS_ON_SALE",',
      '      brand:(r.itemBrand&&r.itemBrand.name)||r.brand||null,',
      '      category:(r.itemCategory&&r.itemCategory.name)||r.category||null,',
      '      size:(r.itemSize&&r.itemSize.name)||r.size||null,',
      '      color:(r.colors&&r.colors[0]&&r.colors[0].name)||r.color||null,',
      '      image_url:(r.thumbnails&&r.thumbnails[0])||r.thumbnail||null,',
      '      item_url:r.id?"https://jp.mercari.com/item/"+r.id:null',
      '    };',
      '  });',
      '}',
      // DOM スキャンで __NEXT_DATA__ 未収録分を補完
      'scan();',
      // MutationObserver: スクロール後のDOM追加を自動捕捉
      'var obs=new MutationObserver(function(){scan();});',
      'obs.observe(document.body,{childList:true,subtree:true});',
      'window[KEY].obs=obs;',
      'var cnt=Object.keys(window[KEY].items).length;',
      'alert("JARVIS: \u53ce\u96c6\u958b\u59cb\uff01\u73fe\u5728"+cnt+"\u4ef6\u3002\\n\u30da\u30fc\u30b8\u3092\u4e0b\u307e\u3067\u30b9\u30af\u30ed\u30fc\u30eb\u3057\u3066\u304f\u3060\u3055\u3044\u3002\\n\u5168\u5546\u54c1\u8868\u793a\u5f8c\u3001\u3082\u3046\u4e00\u5ea6\u30af\u30ea\u30c3\u30af\u3057\u3066\u4fdd\u5b58\u3057\u3066\u304f\u3060\u3055\u3044\u3002");',
      // ════ PHASE 2: 保存 ══════════════════════════════════════════════
      '}else{',
      'if(window[KEY].obs)window[KEY].obs.disconnect();',
      'var items=Object.values(window[KEY].items);',
      'delete window[KEY];',
      'if(items.length===0){alert("JARVIS: \u5546\u54c1\u30c7\u30fc\u30bf\u304c\u3042\u308a\u307e\u305b\u3093\u3002\u30e1\u30eb\u30ab\u30ea\u306e\u51fa\u54c1\u8005\u30d7\u30ed\u30d5\u30a3\u30fc\u30eb\u30da\u30fc\u30b8\u3067\u5b9f\u884c\u3057\u3066\u304f\u3060\u3055\u3044\u3002");return;}',
      'var parts=location.pathname.split("/").filter(function(p){return p.length>0;});',
      'var pIdx=parts.indexOf("profile");',
      'var sellerId=pIdx>=0&&parts[pIdx+1]?parts[pIdx+1]:"unknown";',
      // seller_name: プロフィールページのh1や名前要素から取得
      'var snEl=document.querySelector("[class*=\'userName\'],[class*=\'ProfileName\'],[data-testid*=\'seller-name\'],[class*=\'sellerName\'],h1");',
      'var sellerName=snEl?snEl.textContent.trim():"";',
      'var profileUrl=location.href;',
      'var ts=new Date().toISOString();',
      'var data={jarvis_import:true,seller_id:sellerId,seller_name:sellerName,profile_url:profileUrl,extracted_at:ts,source:"bookmarklet_v2",items:items};',
      'var blob=new Blob([JSON.stringify(data,null,2)],{type:"application/json"});',
      'var bUrl=URL.createObjectURL(blob);',
      'var dl=document.createElement("a");',
      'dl.href=bUrl;',
      'dl.download="mercari_"+sellerId+"_"+ts.slice(0,10)+".json";',
      'document.body.appendChild(dl);',
      'dl.click();',
      'document.body.removeChild(dl);',
      'setTimeout(function(){URL.revokeObjectURL(bUrl);},3000);',
      'alert("JARVIS: "+items.length+"\u4ef6\u306e\u5546\u54c1\u30c7\u30fc\u30bf\u3092\u4fdd\u5b58\u3057\u307e\u3057\u305f\u3002\\nJARVIS\u7af6\u5408\u5206\u6790\u306e\u300c\u624b\u52d5\u53d6\u308a\u8fbc\u307f\u300d\u3078\u30c9\u30e9\u30c3\u30b0\uff06\u30c9\u30ed\u30c3\u30d7\u3057\u3066\u304f\u3060\u3055\u3044\u3002");',
      '}',
      '})();',
    ];
    const code = lines.join('\n');
    return 'javascript:' + encodeURIComponent(code);
  }

  let _importFormat = 'json';
  let _importBusy   = false;

  function setupImportUi() {
    // ブックマークレット コピーボタン
    document.getElementById('comp-bookmarklet-copy-btn')?.addEventListener('click', () => {
      const url = buildBookmarklet();
      const msgEl      = document.getElementById('comp-bookmarklet-msg');
      const fallbackEl = document.getElementById('comp-bookmarklet-fallback');
      navigator.clipboard.writeText(url).then(() => {
        msgEl.style.display = 'block';
        msgEl.style.color   = '#4ade80';
        msgEl.textContent   = 'コピーしました。Edgeのお気に入りを右クリック → 編集 → URL欄へ貼り付けてください。';
        if (fallbackEl) fallbackEl.style.display = 'none';
      }).catch(() => {
        msgEl.style.display = 'block';
        msgEl.style.color   = 'var(--text-sec)';
        msgEl.textContent   = '自動コピーに失敗しました。以下のコードを手動でコピーしてください:';
        if (fallbackEl) { fallbackEl.style.display = 'block'; fallbackEl.value = url; fallbackEl.select(); }
      });
    });

    // 手動アカウント選択での取り込み
    document.getElementById('comp-import-manual-account-btn')?.addEventListener('click', () => {
      runImportWithAccount();
    });

    // フォーマット切替
    document.querySelectorAll('.comp-import-fmt-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        _importFormat = btn.dataset.fmt;
        document.querySelectorAll('.comp-import-fmt-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const ta = document.getElementById('comp-import-text');
        if (ta) ta.placeholder = _importFormat === 'csv'
          ? '商品ID,商品名,価格,状態,ブランド,カテゴリ\nm12345678901,商品名,1000,on_sale,ブランド,カテゴリ'
          : 'JSONをここに貼り付けてください（ブックマークレットで保存したファイルの内容、またはAPIレスポンス）...';
      });
    });

    // テキスト直接取り込み
    document.getElementById('comp-import-text-btn')?.addEventListener('click', () => {
      const text = document.getElementById('comp-import-text')?.value?.trim();
      if (!text) return;
      runImport(_importFormat, text);
    });

    // ファイル選択
    document.getElementById('comp-import-file')?.addEventListener('change', e => {
      const file = e.target.files?.[0];
      if (!file) return;
      const fmt = file.name.endsWith('.csv') ? 'csv' : 'json';
      readFileAndImport(file, fmt);
      e.target.value = ''; // 同ファイル再選択を可能にする
    });

    // ドロップゾーン
    const dz = document.getElementById('comp-import-dropzone');
    if (dz) {
      dz.addEventListener('dragover', e => {
        e.preventDefault();
        dz.style.borderColor = '#60a5fa';
        dz.style.background  = 'rgba(96,165,250,.06)';
      });
      dz.addEventListener('dragleave', () => {
        dz.style.borderColor = 'rgba(96,165,250,.4)';
        dz.style.background  = '';
      });
      dz.addEventListener('drop', e => {
        e.preventDefault();
        dz.style.borderColor = 'rgba(96,165,250,.4)';
        dz.style.background  = '';
        const file = e.dataTransfer?.files?.[0];
        if (!file) return;
        const fmt = file.name.endsWith('.csv') ? 'csv' : 'json';
        readFileAndImport(file, fmt);
      });
      dz.addEventListener('click', e => {
        if (!e.target.closest('label')) {
          document.getElementById('comp-import-file')?.click();
        }
      });
    }
  }

  function readFileAndImport(file, fmt) {
    const reader = new FileReader();
    reader.onload = e => runImport(fmt, e.target.result);
    reader.onerror = () => showImportResult(null, '❌ ファイル読み込みエラー');
    reader.readAsText(file, 'utf-8');
  }

  // 保留中のデータ（seller_id 不明時にアカウント選択後に使う）
  let _pendingImport = null;

  async function runImport(format, data) {
    if (_importBusy) return;
    _importBusy = true;

    showImportResult('loading', '<span style="color:var(--text-sec)">⏳ 処理中...</span>');

    try {
      const res = await fetch('/api/competitor/import', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ format, data }),
      });
      const d = await res.json();

      // seller_id が不明 → アカウント選択欄を表示
      if (!res.ok && d.needsAccountSelect) {
        _pendingImport = { format, data };
        const row = document.getElementById('comp-import-account-row');
        if (row) row.style.display = 'flex';
        showImportResult('warn', `⚠️ ${esc(d.error || '出品者を特定できませんでした。')}`);
        _importBusy = false;
        return;
      }

      if (!res.ok || !d.ok) {
        showImportResult('error', `❌ エラー: ${esc(d.error || '不明なエラー')}`);
        return;
      }

      showImportSuccess(d);

    } catch (e) {
      showImportResult('error', `❌ 通信エラー: ${esc(e.message)}`);
    } finally {
      _importBusy = false;
    }
  }

  async function runImportWithAccount() {
    if (!_pendingImport || _importBusy) return;
    const accountId = parseInt(document.getElementById('comp-import-account')?.value, 10);
    if (!accountId) return;
    _importBusy = true;
    showImportResult('loading', '<span style="color:var(--text-sec)">⏳ 処理中...</span>');
    try {
      const res = await fetch('/api/competitor/import', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ account_id: accountId, format: _pendingImport.format, data: _pendingImport.data }),
      });
      const d = await res.json();
      if (!res.ok || !d.ok) {
        showImportResult('error', `❌ エラー: ${esc(d.error || '不明なエラー')}`);
        return;
      }
      _pendingImport = null;
      document.getElementById('comp-import-account-row').style.display = 'none';
      showImportSuccess(d);
    } catch (e) {
      showImportResult('error', `❌ 通信エラー: ${esc(e.message)}`);
    } finally {
      _importBusy = false;
    }
  }

  async function showImportSuccess(d) {
    const isNew     = d.new > 0;
    const hasDiff   = d.price_changed > 0 || d.sold > 0 || d.reappeared > 0;
    const isFirst   = d.new === d.total && d.unchanged === 0 && !hasDiff;
    const errRows   = (d.errors || []).map(e =>
      `<li style="color:var(--danger)">${esc(e.item_id || e.name || '?')}: ${esc(e.error)}</li>`
    ).join('');
    const newBadge  = d.isNewAccount ? ' <span style="font-size:11px;background:rgba(96,165,250,.2);color:#93c5fd;padding:2px 6px;border-radius:4px">新規登録</span>' : '';

    let analysisHtml = '';
    if (isFirst && d.total > 0) {
      // 初回取り込み: 基本統計
      try {
        const ar = await fetch(`/api/competitor/accounts/${d.accountId}/analysis`);
        const ad = await ar.json();
        if (ad.ok && ad.analysis) {
          const a = ad.analysis;
          const onSale = a.on_sale_count ?? d.total;
          const sold   = a.sold_count ?? 0;
          const avgP   = a.avg_price  ? `¥${Math.round(a.avg_price).toLocaleString()}` : '—';
          const medP   = a.median_price ? `¥${a.median_price.toLocaleString()}` : '—';
          analysisHtml = `
            <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border)">
              <div style="font-size:12px;font-weight:600;margin-bottom:8px;color:var(--text-sec)">初回取り込み分析</div>
              <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px">
                <div class="card"><div class="card-label">出品中</div><div class="card-value green">${onSale}件</div></div>
                <div class="card"><div class="card-label">売却済</div><div class="card-value">${sold}件</div></div>
                <div class="card"><div class="card-label">平均価格</div><div class="card-value">${avgP}</div></div>
                <div class="card"><div class="card-label">中央値</div><div class="card-value">${medP}</div></div>
              </div>
              <div style="font-size:11px;color:var(--text-sec);margin-top:8px">
                売れ筋分析には同じアカウントの2回以上の取り込みが必要です。
              </div>
            </div>`;
        }
      } catch (_) {}
    } else if (hasDiff || !isFirst) {
      // 2回目以降: 差分分析
      analysisHtml = `
        <div style="margin-top:14px;padding-top:12px;border-top:1px solid var(--border)">
          <div style="font-size:12px;font-weight:600;margin-bottom:8px;color:var(--text-sec)">差分分析</div>
          <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(110px,1fr));gap:8px">
            <div class="card"><div class="card-label">新規出品</div><div class="card-value green">${d.new}件</div></div>
            <div class="card"><div class="card-label">売却</div><div class="card-value ${d.sold > 0 ? 'red' : ''}">${d.sold}件</div></div>
            <div class="card"><div class="card-label">価格変更</div><div class="card-value">${d.price_changed}件</div></div>
            <div class="card"><div class="card-label">再出品</div><div class="card-value">${d.reappeared ?? 0}件</div></div>
          </div>
        </div>`;
    }

    showImportResult('ok', `
      <div style="font-weight:600;color:var(--success);font-size:15px;margin-bottom:10px">
        ✓ 取り込み完了 — ${esc(d.accountName || '')}${newBadge}
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:10px">
        <div class="card"><div class="card-label">合計</div><div class="card-value">${d.total}件</div></div>
        <div class="card"><div class="card-label">新規</div><div class="card-value green">${d.new}件</div></div>
        <div class="card"><div class="card-label">価格変更</div><div class="card-value">${d.price_changed}件</div></div>
        <div class="card"><div class="card-label">売却</div><div class="card-value ${d.sold > 0 ? 'red' : ''}">${d.sold}件</div></div>
        <div class="card"><div class="card-label">変更なし</div><div class="card-value">${d.unchanged}件</div></div>
      </div>
      ${analysisHtml}
      ${errRows ? `<div style="margin-top:8px;font-size:12px;color:var(--text-sec)">スキップ:</div><ul style="margin:4px 0;padding-left:18px;font-size:12px">${errRows}</ul>` : ''}
    `);

    // アカウント一覧 & 各タブを自動更新
    await loadAccounts();
    if (competitorSubTab === 'today')           loadToday();
    else if (competitorSubTab === 'brands')     loadBrands();
    else if (competitorSubTab === 'candidates') loadCandidates();
    await checkNotifications();
  }

  function showImportResult(type, html) {
    const el = document.getElementById('comp-import-result');
    if (!el) return;
    const styles = {
      ok:      { bg: 'rgba(74,222,128,.07)',   border: '1px solid rgba(74,222,128,.25)' },
      error:   { bg: 'rgba(239,68,68,.07)',    border: '1px solid rgba(239,68,68,.25)' },
      warn:    { bg: 'rgba(251,191,36,.07)',   border: '1px solid rgba(251,191,36,.25)' },
      loading: { bg: '',                       border: '' },
    };
    const s = styles[type] || styles.loading;
    el.style.cssText = `padding:${html ? '14px 16px' : '0'};background:${s.bg};border:${s.border};border-radius:8px;margin-top:${html ? '12px' : '0'}`;
    el.innerHTML = html || '';
  }

  // ─── 通知チェック ──────────────────────────────────────────────────────────

  async function checkNotifications() {
    try {
      const res = await fetch('/api/competitor/notifications');
      const d   = await res.json();
      if (!d.ok) return;
      const unread = d.notifications ?? [];
      if (unread.length === 0) return;

      const latest = unread[0];
      let summary  = {};
      try { summary = JSON.parse(latest.summary); } catch (_) {}

      // 既読でなければポップアップ表示
      showNotificationPopup(latest.notify_date, summary);
    } catch (_) {}
  }

  function showNotificationPopup(date, summary) {
    // セッション内で既に表示済みならスキップ
    const key = `merch_notify_shown_${date}`;
    if (sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key, '1');

    const popup = document.createElement('div');
    popup.style.cssText = `
      position:fixed; bottom:20px; right:20px; z-index:9998;
      background:var(--card-bg); border:1px solid var(--border);
      border-radius:12px; padding:16px 20px; box-shadow:0 4px 20px rgba(0,0,0,.4);
      min-width:260px; max-width:320px;
    `;
    popup.innerHTML = `
      <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px">
        <span style="font-size:13px;font-weight:600">競合アカウント更新 (${date})</span>
        <button style="background:none;border:none;color:var(--text-sec);cursor:pointer;font-size:16px" id="comp-notif-close">×</button>
      </div>
      <div style="font-size:12px;color:var(--text-sec)">
        新規: ${summary.new ?? 0}件 / 売却: ${summary.sold ?? 0}件 / 価格変化: ${summary.price_change ?? 0}件
      </div>
      <div style="margin-top:10px">
        <button class="btn btn-secondary" style="font-size:11px;padding:3px 10px" id="comp-notif-view">詳細を見る</button>
      </div>
    `;
    document.body.appendChild(popup);

    const close = () => {
      popup.remove();
      fetch('/api/competitor/notifications/read', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ date }),
      }).catch(() => {});
    };
    popup.getElementById = popup.querySelector.bind(popup);
    document.getElementById('comp-notif-close').addEventListener('click', close);
    document.getElementById('comp-notif-view').addEventListener('click', () => {
      close();
      // 物販タブ → 競合分析 → 今日の分析 へ遷移
      document.getElementById('business-merch-tab')?.click();
      setTimeout(() => {
        if (typeof switchMerchSubTab === 'function') switchMerchSubTab('competitor');
        setTimeout(() => switchCompTab('today'), 100);
      }, 100);
    });

    // 10秒後に自動クローズ
    setTimeout(close, 10_000);
  }

  // ─── 外部フック（business-merch.js の __jarvisMerchSubTabChanged から呼ばれる） ──
  // business-merch-list.js が先に同名フックを設定しているため、
  // 既存フックを保持してから連鎖呼び出しする（上書きしない）。

  const _prevMerchSubTabHook = window.__jarvisMerchSubTabChanged;
  window.__jarvisMerchSubTabChanged = function (name) {
    // 既存フック（dashboard/items/sold/stock の描画）を先に呼ぶ
    if (typeof _prevMerchSubTabHook === 'function') _prevMerchSubTabHook(name);
    // 競合分析タブのみ追加処理
    if (name === 'competitor') {
      ensureCompetitorUi();
      switchCompTab(competitorSubTab || 'today');
    }
  };

})();
