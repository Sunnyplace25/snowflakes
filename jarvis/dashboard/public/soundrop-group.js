(() => {
  'use strict';

  const ITEMS = [
    { tab: 'soundrop-stats', label: '収益・統計' },
    { tab: 'import', label: '明細取込' },
    { tab: 'soundrop-sync', label: 'カタログ同期' },
  ];

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const value = String(reader.result || '');
        resolve(value.includes(',') ? value.split(',').pop() : value);
      };
      reader.onerror = () => reject(reader.error || new Error('ファイルを読み込めませんでした'));
      reader.readAsDataURL(file);
    });
  }

  function addUploadUi(panel, refreshImport) {
    if (!panel || document.getElementById('soundrop-upload-card')) return;

    const card = document.createElement('section');
    card.id = 'soundrop-upload-card';
    card.className = 'sf-section';
    card.innerHTML = `
      <div class="sf-section-header">
        <h2>Soundrop 明細を取り込む</h2>
        <span class="sf-note">Soundropからダウンロードした CSV / TSV をそのまま選択</span>
      </div>
      <div class="soundrop-upload-box" id="soundrop-upload-box">
        <div class="soundrop-upload-title">CSVファイルを選択</div>
        <div class="soundrop-upload-note">クリックして Soundrop の明細ファイルを選んでください</div>
        <input id="soundrop-upload-input" type="file" accept=".csv,.tsv,text/csv,text/tab-separated-values" hidden>
      </div>
      <div class="soundrop-upload-row">
        <label>ステートメント月（任意）
          <input id="soundrop-report-period" type="month">
        </label>
        <button id="soundrop-import-btn" class="sf-btn" type="button" disabled>取り込む</button>
        <span id="soundrop-upload-status"></span>
      </div>
    `;

    const firstSection = panel.querySelector('.sf-section');
    if (firstSection) firstSection.before(card);
    else panel.appendChild(card);

    const box = card.querySelector('#soundrop-upload-box');
    const input = card.querySelector('#soundrop-upload-input');
    const button = card.querySelector('#soundrop-import-btn');
    const status = card.querySelector('#soundrop-upload-status');
    let selectedFile = null;

    box.addEventListener('click', () => input.click());
    input.addEventListener('change', () => {
      selectedFile = input.files?.[0] || null;
      button.disabled = !selectedFile;
      if (selectedFile) {
        box.querySelector('.soundrop-upload-title').textContent = selectedFile.name;
        box.querySelector('.soundrop-upload-note').textContent = `${(selectedFile.size / 1024).toFixed(1)} KB`;
        status.textContent = '';
      }
    });

    button.addEventListener('click', async () => {
      if (!selectedFile) return;
      button.disabled = true;
      status.textContent = '取り込み中...';
      status.className = '';

      try {
        const data_b64 = await fileToBase64(selectedFile);
        const reportPeriod = card.querySelector('#soundrop-report-period').value || null;
        const res = await fetch('/api/soundrop/import-upload', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            file_name: selectedFile.name,
            data_b64,
            report_period: reportPeriod,
          }),
        });
        const data = await res.json();
        if (!res.ok || !data.ok) throw new Error(data.error || '取り込みに失敗しました');

        status.textContent = `完了：${data.rowCount}行 / マッチ ${data.matchedCount} / 未マッチ ${data.unmatchedCount}`;
        status.className = 'soundrop-upload-ok';
        refreshImport();
      } catch (e) {
        status.textContent = `エラー：${e.message}`;
        status.className = 'soundrop-upload-error';
      } finally {
        button.disabled = !selectedFile;
      }
    });
  }

  function setupBusinessFastSwitch() {
    const button = document.querySelector('.module-tab[data-module="business"]');
    const business = document.getElementById('module-business');
    if (!button || !business || button.dataset.fastSwitchBound === '1') return;

    button.dataset.fastSwitchBound = '1';
    let lastRefreshAt = Date.now();

    button.addEventListener('click', event => {
      // app.js の従来ハンドラより先に捕まえ、重い refresh() を切替前に走らせない。
      event.stopImmediatePropagation();

      document.querySelectorAll('[id^="module-"]').forEach(el => {
        el.hidden = (el.id !== 'module-business');
      });
      document.querySelectorAll('.module-tab').forEach(tab => {
        tab.classList.toggle('active', tab.dataset.module === 'business');
      });
      history.replaceState(null, '', '#business');

      // 画面は即表示。データが古い時だけ、描画後にバックグラウンド更新する。
      const now = Date.now();
      if (now - lastRefreshAt < 30_000 || typeof window.refresh !== 'function') return;
      lastRefreshAt = now;
      requestAnimationFrame(() => {
        setTimeout(() => {
          Promise.resolve(window.refresh()).catch(() => {});
        }, 0);
      });
    }, true);
  }

  function init() {
    setupBusinessFastSwitch();

    const module = document.getElementById('module-sf');
    if (!module || document.getElementById('sf-soundrop-group-tab')) return;

    const topNav = module.querySelector(':scope > nav.sf-tabs');
    if (!topNav) return;

    const originals = new Map();
    for (const item of ITEMS) {
      const btn = topNav.querySelector(`[data-sf-tab="${item.tab}"]`);
      const panel = document.getElementById(`sf-tab-${item.tab}`);
      if (!btn || !panel) return;
      originals.set(item.tab, { btn, panel });
    }

    const firstOriginal = originals.get('import').btn;
    const parent = document.createElement('button');
    parent.type = 'button';
    parent.id = 'sf-soundrop-group-tab';
    parent.className = 'sf-tab';
    parent.textContent = 'Soundrop';
    firstOriginal.before(parent);

    originals.forEach(({ btn }) => {
      btn.style.display = 'none';
      btn.setAttribute('aria-hidden', 'true');
      btn.tabIndex = -1;
    });

    const style = document.createElement('style');
    style.textContent = `
      .soundrop-subtabs {
        display:flex;
        gap:8px;
        flex-wrap:wrap;
        margin:0 0 18px;
        padding:10px 12px;
        border:1px solid #263449;
        border-radius:8px;
        background:#0f172a;
      }
      .soundrop-subtab {
        border:1px solid #334155;
        border-radius:6px;
        background:#1e293b;
        color:#94a3b8;
        padding:7px 14px;
        font-size:13px;
        cursor:pointer;
      }
      .soundrop-subtab:hover { color:#e2e8f0; border-color:#475569; }
      .soundrop-subtab.active {
        color:#fff;
        border-color:#3b82f6;
        background:#1d4ed8;
      }
      .soundrop-upload-box {
        border:2px dashed #334155;
        border-radius:8px;
        padding:26px;
        text-align:center;
        cursor:pointer;
        background:#0f172a;
        transition:border-color .2s;
      }
      .soundrop-upload-box:hover { border-color:#3b82f6; }
      .soundrop-upload-title { color:#e2e8f0; font-size:14px; font-weight:600; }
      .soundrop-upload-note { color:#64748b; font-size:12px; margin-top:6px; }
      .soundrop-upload-row {
        display:flex;
        gap:12px;
        align-items:end;
        flex-wrap:wrap;
        margin-top:14px;
      }
      .soundrop-upload-row label { color:#94a3b8; font-size:12px; display:grid; gap:5px; }
      .soundrop-upload-row input[type="month"] {
        background:#1e293b;
        border:1px solid #334155;
        color:#e2e8f0;
        border-radius:5px;
        padding:7px 9px;
      }
      #soundrop-upload-status { color:#94a3b8; font-size:12px; padding-bottom:7px; }
      #soundrop-upload-status.soundrop-upload-ok { color:#22c55e; }
      #soundrop-upload-status.soundrop-upload-error { color:#ef4444; }
    `;
    document.head.appendChild(style);

    for (const item of ITEMS) {
      const { panel } = originals.get(item.tab);
      const subnav = document.createElement('nav');
      subnav.className = 'soundrop-subtabs';
      subnav.setAttribute('aria-label', 'Soundrop');
      for (const sub of ITEMS) {
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'soundrop-subtab';
        b.dataset.soundropSub = sub.tab;
        b.textContent = sub.label;
        b.addEventListener('click', () => openSub(sub.tab));
        subnav.appendChild(b);
      }
      panel.prepend(subnav);
    }

    function setSubActive(tab) {
      module.querySelectorAll('[data-soundrop-sub]').forEach(b => {
        b.classList.toggle('active', b.dataset.soundropSub === tab);
      });
    }

    function showPanelImmediately(tab) {
      const target = originals.get(tab);
      if (!target) return;

      module.querySelectorAll('.sf-tab-panel').forEach(panel => {
        panel.hidden = true;
      });
      target.panel.hidden = false;

      topNav.querySelectorAll('.sf-tab').forEach(b => b.classList.remove('active'));
      parent.classList.add('active');
      setSubActive(tab);
    }

    function openSub(tab) {
      const target = originals.get(tab);
      if (!target) return;

      // まず画面だけ即時切替。重いデータ取得は描画後に既存処理へ渡す。
      showPanelImmediately(tab);
      requestAnimationFrame(() => {
        setTimeout(() => {
          target.btn.click();
          target.btn.classList.remove('active');
          parent.classList.add('active');
          setSubActive(tab);
        }, 0);
      });
    }

    addUploadUi(originals.get('import').panel, () => openSub('import'));

    parent.addEventListener('click', () => {
      const visible = ITEMS.find(item => !originals.get(item.tab).panel.hidden);
      openSub(visible?.tab || 'soundrop-stats');
    });

    originals.forEach(({ btn }, tab) => {
      btn.addEventListener('click', () => {
        queueMicrotask(() => {
          btn.classList.remove('active');
          parent.classList.add('active');
          setSubActive(tab);
        });
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
