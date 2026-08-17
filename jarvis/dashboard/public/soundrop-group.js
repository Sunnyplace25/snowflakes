(() => {
  'use strict';

  const ITEMS = [
    { tab: 'import', label: '明細取込' },
    { tab: 'soundrop-stats', label: '収益・統計' },
    { tab: 'soundrop-sync', label: 'カタログ同期' },
  ];

  function init() {
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

    function openSub(tab) {
      const target = originals.get(tab);
      if (!target) return;

      // 既存の SfModule のタブ処理をそのまま利用し、データ読込も従来どおり実行する。
      target.btn.click();
      target.btn.classList.remove('active');
      parent.classList.add('active');
      setSubActive(tab);
    }

    parent.addEventListener('click', () => {
      const visible = ITEMS.find(item => !originals.get(item.tab).panel.hidden);
      openSub(visible?.tab || 'import');
    });

    // 既存の3タブのどれかが外部処理から開かれた場合も、親タブ表示を同期する。
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
