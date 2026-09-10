/**
 * jarvis/dashboard/public/modules/sf.js
 * Snow flakes モジュール — Phase 1.5: Music Library 追加
 *
 * 状態管理・キャラクター Stage・JARVIS Status 表示を担当する。
 * Phase 1.5: Music Library (楽曲/リリース/プロフィール/インポート) 追加。
 *
 * 画像拡張ポイント:
 *   .char-img-wrap 内の .char-placeholder を
 *   <img src="/sf/chars/{name}_{state}.webp"> に差し替えるだけでよい。
 *   Live2D 移行時は同 wrapper 内を <canvas> に置き換える。
 */

'use strict';

const SfModule = (() => {

  // ─── 状態定義 ─────────────────────────────────────────────────────────────

  /** JARVIS の動作状態と Snow flakes 専用メッセージ */
  const STATUS_MESSAGES = {
    idle:      'JARVIS は待機中です',
    analyzing: 'サイト導線を分析しています...',
    notice:    '改善できそうな導線を見つけました',
    approval:  'サイト修正案の確認をお願いします',
    working:   '作業を実行しています...',
    completed: '完了しました',
  };

  // ─── JARVIS Status 操作 ───────────────────────────────────────────────────

  /**
   * JARVIS Status バーの状態を更新する。
   * @param {'idle'|'analyzing'|'notice'|'approval'|'working'|'completed'} state
   * @param {string} [message] - 省略時は STATUS_MESSAGES[state] を使用
   */
  function setStatus(state, message = null) {
    const dot   = document.getElementById('sf-status-dot');
    const label = document.getElementById('sf-status-state');
    const msg   = document.getElementById('sf-status-message');
    if (!dot || !label || !msg) return;

    dot.dataset.state  = state;
    label.textContent  = state;
    msg.textContent    = message ?? STATUS_MESSAGES[state] ?? state;
  }

  // ─── Character Stage 操作 ─────────────────────────────────────────────────

  /**
   * キャラクタースロットの状態を更新する。
   * @param {'hinata'|'kouta'|'hayate'} charName
   * @param {'idle'|'analyzing'|'notice'|'approval'|'working'|'completed'} state
   */
  function setCharState(charName, state) {
    const slot = document.querySelector(`.char-slot[data-char="${charName}"]`);
    if (!slot) return;
    slot.dataset.state = state;
  }

  /**
   * すべてのキャラクターを同一状態にする（一括変更用）。
   * @param {'idle'|'analyzing'|'notice'|'approval'|'working'|'completed'} state
   */
  function setAllCharsState(state) {
    ['hinata', 'kouta', 'hayate'].forEach(c => setCharState(c, state));
  }

  // ─── JARVIS 状態と Character Stage の連動 ────────────────────────────────

  /**
   * JARVIS Status とキャラクターを同時に切り替える。
   * @param {'idle'|'analyzing'|'notice'|'approval'|'working'|'completed'} state
   * @param {string} [message]
   */
  function setState(state, message = null) {
    setStatus(state, message);
    setAllCharsState(state);
  }

  // ─── SF 2段タブ切替（Phase 28） ───────────────────────────────────────────

  /** big-tab グループ定義 */
  const BIG_TAB_GROUPS = {
    music: ['library', 'profiles', 'distribution', 'import', 'soundrop-stats', 'soundrop-sync'],
    story: ['works', 'knowledge'],
    sns:   ['youtube', 'tiktok', 'hp-analytics', 'funnel'],
  };

  /** タブ名に応じたデータ読み込み */
  function _activateTabContent(tabName) {
    if      (tabName === 'library')         loadLibrary();
    else if (tabName === 'profiles')        loadProfiles();
    else if (tabName === 'distribution')    loadDistribution();
    else if (tabName === 'import')          loadImports();
    else if (tabName === 'soundrop-stats')  initSoundropStats();
    else if (tabName === 'soundrop-sync')   loadSoundropSync();
    else if (tabName === 'youtube')         loadYouTube();
    else if (tabName === 'tiktok')          loadTikTok();
    else if (tabName === 'funnel')          loadFunnel();
    else if (tabName === 'sync')            loadSync();
    else if (tabName === 'hp-analytics')    loadHpAnalytics();
    else if (tabName === 'knowledge')       initKnowledge();
    else if (tabName === 'works')           loadWorks();
  }

  /** sub-tab ボタンをアクティブ化してパネルを表示する */
  function _selectSubTab(btn) {
    const tabName = btn.dataset.sfTab;
    const group   = btn.closest('.sf-tabs[data-group]')?.dataset.group;

    // アクティブ状態: 同グループ内だけ解除
    if (group) {
      document.querySelectorAll(`.sf-tabs[data-group="${group}"] .sf-tab`)
        .forEach(b => b.classList.remove('active'));
    }
    btn.classList.add('active');

    // パネル切替（#module-sf 内だけ対象。Business 側の .sf-tab-panel には触れない）
    document.querySelectorAll('#module-sf .sf-tab-panel').forEach(p => { p.hidden = true; });
    const panel = document.getElementById(`sf-tab-${tabName}`);
    if (panel) panel.hidden = false;

    _activateTabContent(tabName);
  }

  function initSubTabs() {
    // ── big-tab 切替 ─────────────────────────────────────────────────────────
    document.querySelectorAll('.sf-big-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        const group = btn.dataset.sfBigtab;

        document.querySelectorAll('.sf-big-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        // グループに対応するサブナビを表示、それ以外を非表示
        document.querySelectorAll('.sf-tabs[data-group]').forEach(nav => {
          nav.hidden = nav.dataset.group !== group;
        });

        // グループ内の先頭タブを自動選択
        const firstTab = document.querySelector(`.sf-tabs[data-group="${group}"] .sf-tab`);
        if (firstTab) _selectSubTab(firstTab);
      });
    });

    // ── 全体同期 / Ops ボタン ────────────────────────────────────────────────
    document.getElementById('sf-global-sync-btn')?.addEventListener('click', () => {
      document.querySelectorAll('.sf-big-tab').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.sf-tabs[data-group]').forEach(nav => { nav.hidden = true; });
      document.querySelectorAll('#module-sf .sf-tab-panel').forEach(p => { p.hidden = true; });
      const panel = document.getElementById('sf-tab-sync');
      if (panel) panel.hidden = false;
      loadSync();
    });

    // ── sub-tab 切替 ─────────────────────────────────────────────────────────
    document.querySelectorAll('.sf-tab[data-sf-tab]').forEach(btn => {
      btn.addEventListener('click', () => _selectSubTab(btn));
    });

    // ── モーダル閉じるボタン ─────────────────────────────────────────────────
    document.querySelectorAll('.sf-modal-close').forEach(btn => {
      btn.addEventListener('click', () => {
        const modalId = btn.dataset.modal;
        const modal = document.getElementById(modalId);
        if (modal) modal.hidden = true;
      });
    });
  }

  // ─── ステータスバッジヘルパー ─────────────────────────────────────────────

  /** トラックステータスバッジ HTML */
  function trackStatusBadge(status) {
    const map = {
      unknown:           { cls: 'sf-badge-gray',    label: 'unknown' },
      unreleased:        { cls: 'sf-badge-dim',     label: '未リリース' },
      streaming_pending: { cls: 'sf-badge-yellow',  label: '配信準備中' },
      released:          { cls: 'sf-badge-green',   label: 'リリース済' },
      private:           { cls: 'sf-badge-red',     label: '非公開' },
    };
    const info = map[status] || { cls: 'sf-badge-gray', label: status || '—' };
    return `<span class="sf-badge ${info.cls}">${info.label}</span>`;
  }

  /** プレビューステータスバッジ HTML */
  function previewStatusBadge(previewStatus) {
    if (previewStatus === 'published') {
      return '<span class="sf-badge sf-badge-green">HPデモ公開中</span>';
    }
    return '<span class="sf-badge sf-badge-dim">HPデモなし</span>';
  }

  /** ファイル有無表示 */
  function fileCheck(count) {
    return count > 0
      ? '<span class="sf-check">✓</span>'
      : '<span class="sf-check sf-check-none">—</span>';
  }

  /** リリース配信ステータスバッジ */
  function releaseStatusBadge(status) {
    const map = {
      draft:      { cls: 'sf-badge-dim',    label: 'Draft' },
      scheduled:  { cls: 'sf-badge-yellow', label: 'Scheduled' },
      released:   { cls: 'sf-badge-green',  label: 'Released' },
      private:    { cls: 'sf-badge-red',    label: 'Private' },
    };
    const info = map[status] || { cls: 'sf-badge-dim', label: status || '—' };
    return `<span class="sf-badge ${info.cls}">${info.label}</span>`;
  }

  /** Soundrop配信ステータスバッジ */
  function soundropBadge(status) {
    if (!status) return '<span class="sf-badge sf-badge-dim">—</span>';
    const map = {
      not_ready:    { cls: 'sf-badge-dim',    label: 'Not Ready' },
      ready:        { cls: 'sf-badge-yellow', label: 'Ready' },
      submitted:    { cls: 'sf-badge-yellow', label: 'Submitted' },
      reviewing:    { cls: 'sf-badge-yellow', label: 'Reviewing' },
      needs_changes:{ cls: 'sf-badge-red',    label: 'Needs Changes' },
      approved:     { cls: 'sf-badge-green',  label: 'Approved' },
      distributed:  { cls: 'sf-badge-green',  label: 'Distributed' },
    };
    const info = map[status] || { cls: 'sf-badge-dim', label: status };
    return `<span class="sf-badge ${info.cls}">${info.label}</span>`;
  }

  /** アーティストプロフィールステータスバッジ */
  function profileStatusBadge(status) {
    const map = {
      unknown:   { cls: 'sf-badge-gray',   label: 'Unknown' },
      active:    { cls: 'sf-badge-green',  label: 'Active' },
      pending:   { cls: 'sf-badge-yellow', label: 'Pending' },
      unclaimed: { cls: 'sf-badge-red',    label: 'Unclaimed' },
      inactive:  { cls: 'sf-badge-dim',    label: 'Inactive' },
    };
    const info = map[status] || { cls: 'sf-badge-dim', label: status || '—' };
    return `<span class="sf-badge ${info.cls}">${info.label}</span>`;
  }

  // ─── テーブルレンダリング ─────────────────────────────────────────────────

  // ── 楽曲ソート/フィルタ状態 ──────────────────────────────────────────────
  let _allTracks  = [];
  let _trackSort   = 'release_date_desc';
  let _trackFilter = 'all';

  /** release_date の NULL-last 比較 */
  function _dateCompare(a, b, dir) {
    if (!a && !b) return 0;
    if (!a) return 1;
    if (!b) return -1;
    const cmp = a < b ? -1 : a > b ? 1 : 0;
    return dir === 'desc' ? -cmp : cmp;
  }

  /** status の表示優先順位 (released=0, upcoming=1, unreleased=2) */
  function _statusOrder(status) {
    return { released: 0, streaming_pending: 1, scheduled: 1, unreleased: 2, draft: 2, unknown: 2 }[status] ?? 3;
  }

  /** ソート＋フィルタを適用してトラック配列を返す */
  function _sortAndFilterTracks(tracks, sort, filter) {
    let result = tracks.filter(t => {
      if (filter === 'released')  return t.status === 'released';
      if (filter === 'upcoming')  return t.status === 'streaming_pending' || t.status === 'scheduled';
      if (filter === 'unreleased') return ['unreleased', 'draft', 'unknown'].includes(t.status);
      return true;
    });

    result = [...result].sort((a, b) => {
      switch (sort) {
        case 'release_date_desc': return _dateCompare(a.release_date, b.release_date, 'desc');
        case 'release_date_asc':  return _dateCompare(a.release_date, b.release_date, 'asc');
        case 'title_asc':   return a.title.localeCompare(b.title, 'ja');
        case 'title_desc':  return b.title.localeCompare(a.title, 'ja');
        case 'release_asc':  return (a.primary_release_title || '').localeCompare(b.primary_release_title || '', 'ja');
        case 'release_desc': return (b.primary_release_title || '').localeCompare(a.primary_release_title || '', 'ja');
        case 'status':        return _statusOrder(a.status) - _statusOrder(b.status);
        case 'revenue_desc':  return (b.total_revenue  || 0) - (a.total_revenue  || 0);
        case 'revenue_asc':   return (a.total_revenue  || 0) - (b.total_revenue  || 0);
        case 'streams_desc':  return (b.total_streams  || 0) - (a.total_streams  || 0);
        case 'streams_asc':   return (a.total_streams  || 0) - (b.total_streams  || 0);
        default: return 0;
      }
    });
    return result;
  }

  /**
   * 楽曲一覧テーブルを生成する。
   * 列: 曲名 | リリース | リリース日 | 状態 | Revenue | Units | HPデモ | WAV | MP3 | ISRC
   * @param {object[]} tracks  ソート/フィルタ済み配列
   * @param {string}   sort    現在のソートキー
   * @returns {string} HTML文字列（コントロールUIを含む）
   */
  function renderTracksTable(tracks, sort) {
    const currentSort   = sort   || _trackSort;
    const currentFilter = _trackFilter;
    const allCount      = _allTracks.length;

    // ── ソート矢印ヘルパー ──────────────────────────────────────────────────
    function arrow(key, descKey, ascKey) {
      if (currentSort === descKey) return '<span class="sf-sort-arrow active">↓</span>';
      if (currentSort === ascKey)  return '<span class="sf-sort-arrow active">↑</span>';
      return '<span class="sf-sort-arrow">↕</span>';
    }

    // ── ソートコントロール ──────────────────────────────────────────────────
    const controls = `
      <div class="sf-track-controls">
        <div class="sf-filter-group">
          <button class="sf-filter-btn${currentFilter === 'all'        ? ' active' : ''}" data-sf-filter="all">All (${allCount})</button>
          <button class="sf-filter-btn${currentFilter === 'released'   ? ' active' : ''}" data-sf-filter="released">Released</button>
          <button class="sf-filter-btn${currentFilter === 'upcoming'   ? ' active' : ''}" data-sf-filter="upcoming">Upcoming</button>
          <button class="sf-filter-btn${currentFilter === 'unreleased' ? ' active' : ''}" data-sf-filter="unreleased">Unreleased</button>
        </div>
        <div class="sf-sort-group">
          <label class="sf-sort-label">Sort</label>
          <select class="sf-sort-select" id="sf-track-sort-select">
            <optgroup label="Release Date">
              <option value="release_date_desc" ${currentSort === 'release_date_desc' ? 'selected' : ''}>Newest first</option>
              <option value="release_date_asc"  ${currentSort === 'release_date_asc'  ? 'selected' : ''}>Oldest first</option>
            </optgroup>
            <optgroup label="Track Title">
              <option value="title_asc"  ${currentSort === 'title_asc'  ? 'selected' : ''}>A → Z</option>
              <option value="title_desc" ${currentSort === 'title_desc' ? 'selected' : ''}>Z → A</option>
            </optgroup>
            <optgroup label="Release">
              <option value="release_asc"  ${currentSort === 'release_asc'  ? 'selected' : ''}>A → Z</option>
              <option value="release_desc" ${currentSort === 'release_desc' ? 'selected' : ''}>Z → A</option>
            </optgroup>
            <optgroup label="Status">
              <option value="status" ${currentSort === 'status' ? 'selected' : ''}>Released → Upcoming → Unreleased</option>
            </optgroup>
            <optgroup label="Revenue">
              <option value="revenue_desc" ${currentSort === 'revenue_desc' ? 'selected' : ''}>High → Low</option>
              <option value="revenue_asc"  ${currentSort === 'revenue_asc'  ? 'selected' : ''}>Low → High</option>
            </optgroup>
            <optgroup label="Units (Streams)">
              <option value="streams_desc" ${currentSort === 'streams_desc' ? 'selected' : ''}>High → Low</option>
              <option value="streams_asc"  ${currentSort === 'streams_asc'  ? 'selected' : ''}>Low → High</option>
            </optgroup>
          </select>
        </div>
      </div>
    `;

    if (!tracks || tracks.length === 0) {
      return controls + '<div class="empty-state">該当する楽曲がありません</div>';
    }

    const rows = tracks.map(t => `
      <tr>
        <td class="sf-col-title">${esc(t.title)}</td>
        <td class="sf-col-release-title">${esc(t.primary_release_title || '—')}</td>
        <td class="sf-col-date">${t.release_date || '—'}</td>
        <td>${trackStatusBadge(t.status)}</td>
        <td class="sf-col-num">${t.total_revenue > 0 ? '$' + Number(t.total_revenue).toFixed(2) : '—'}</td>
        <td class="sf-col-num">${t.total_streams > 0 ? Number(t.total_streams).toLocaleString() : '—'}</td>
        <td>${previewStatusBadge(t.preview_status)}</td>
        <td class="sf-col-center">${fileCheck(t.has_wav)}</td>
        <td class="sf-col-center">${fileCheck(t.has_mp3)}</td>
        <td class="sf-col-isrc">${esc(t.isrc || '—')}</td>
      </tr>
    `).join('');

    return controls + `
      <table class="sf-table sf-table-sortable">
        <thead>
          <tr>
            <th data-sf-sort-asc="title_asc" data-sf-sort-desc="title_desc" class="sf-th-sort">曲名${arrow('title', 'title_desc', 'title_asc')}</th>
            <th data-sf-sort-asc="release_asc" data-sf-sort-desc="release_desc" class="sf-th-sort">リリース${arrow('release', 'release_desc', 'release_asc')}</th>
            <th data-sf-sort-asc="release_date_asc" data-sf-sort-desc="release_date_desc" class="sf-th-sort">リリース日${arrow('release_date', 'release_date_desc', 'release_date_asc')}</th>
            <th data-sf-sort-asc="status" data-sf-sort-desc="status" class="sf-th-sort">状態${currentSort === 'status' ? '<span class="sf-sort-arrow active">↓</span>' : '<span class="sf-sort-arrow">↕</span>'}</th>
            <th data-sf-sort-asc="revenue_asc" data-sf-sort-desc="revenue_desc" class="sf-th-sort sf-col-num">Revenue${arrow('revenue', 'revenue_desc', 'revenue_asc')}</th>
            <th data-sf-sort-asc="streams_asc" data-sf-sort-desc="streams_desc" class="sf-th-sort sf-col-num">Units${arrow('streams', 'streams_desc', 'streams_asc')}</th>
            <th>HPデモ</th>
            <th>WAV</th>
            <th>MP3</th>
            <th>ISRC</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  /**
   * リリース一覧テーブルを生成する。
   * 列: タイトル | Single/EP/Album | リリース日 | UPC | ジャケット | Soundrop | Spotify | Apple | Amazon
   * @param {object[]} releases
   * @returns {string} HTML文字列
   */
  function renderReleasesTable(releases) {
    if (!releases || releases.length === 0) {
      return '<div class="empty-state">リリースデータがありません</div>';
    }
    const rows = releases.map(r => `
      <tr>
        <td class="sf-col-title">${esc(r.title)}</td>
        <td>${releaseStatusBadge(r.status)}</td>
        <td class="sf-col-type">${esc(r.release_type)}</td>
        <td class="sf-col-date">${r.release_date || '—'}</td>
        <td class="sf-col-isrc">${esc(r.upc_ean || '—')}</td>
        <td class="sf-col-center">${r.artwork_status === 'final' ? '<span class="sf-check">✓</span>' : '<span class="sf-check sf-check-none">—</span>'}</td>
        <td>${soundropBadge(r.soundrop_status)}</td>
      </tr>
    `).join('');

    return `
      <table class="sf-table">
        <thead>
          <tr>
            <th>タイトル</th>
            <th>状態</th>
            <th>種別</th>
            <th>リリース日</th>
            <th>UPC/EAN</th>
            <th>ジャケット</th>
            <th>Soundrop</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  /**
   * アーティストプロフィールテーブルを生成する。
   * 列: Platform | Artist ID | URL | Claimed | Status | 最終確認日
   * @param {object[]} profiles
   * @returns {string} HTML文字列
   */
  function renderProfilesTable(profiles) {
    if (!profiles || profiles.length === 0) {
      return '<div class="empty-state">プロフィールデータがありません</div>';
    }
    const rows = profiles.map(p => `
      <tr>
        <td class="sf-col-platform">${esc(p.platform)}</td>
        <td class="sf-col-isrc">${esc(p.platform_artist_id || '—')}</td>
        <td class="sf-col-url">${p.artist_page_url
          ? `<a href="${esc(p.artist_page_url)}" target="_blank" rel="noopener">${esc(p.artist_page_url)}</a>`
          : '—'}</td>
        <td class="sf-col-center">${p.claimed ? '<span class="sf-check">✓</span>' : '<span class="sf-check sf-check-none">—</span>'}</td>
        <td>${profileStatusBadge(p.profile_status)}</td>
        <td class="sf-col-date">${p.last_checked_at || '—'}</td>
      </tr>
    `).join('');

    return `
      <table class="sf-table">
        <thead>
          <tr>
            <th>Platform</th>
            <th>Artist ID</th>
            <th>URL</th>
            <th>Claimed</th>
            <th>Status</th>
            <th>最終確認日</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  /**
   * インポート履歴テーブルを生成する。
   * @param {object[]} imports
   * @returns {string} HTML文字列
   */
  function renderImportHistory(imports) {
    if (!imports || imports.length === 0) {
      return '<div class="empty-state">インポート履歴がありません</div>';
    }
    const statusCls = {
      pending:    'sf-badge-dim',
      processing: 'sf-badge-yellow',
      completed:  'sf-badge-green',
      failed:     'sf-badge-red',
      partial:    'sf-badge-yellow',
    };
    const rows = imports.map(i => `
      <tr>
        <td class="sf-col-date">${i.imported_at || '—'}</td>
        <td>${esc(i.distributor)}</td>
        <td>${esc(i.file_name || '—')}</td>
        <td>${esc(i.report_period || '—')}</td>
        <td class="sf-col-center">${i.row_count ?? 0}</td>
        <td class="sf-col-center">${i.matched_count ?? 0}</td>
        <td class="sf-col-center">${i.unmatched_count ?? 0}</td>
        <td><span class="sf-badge ${statusCls[i.import_status] || 'sf-badge-dim'}">${esc(i.import_status)}</span></td>
      </tr>
    `).join('');

    return `
      <table class="sf-table">
        <thead>
          <tr>
            <th>インポート日時</th>
            <th>配信元</th>
            <th>ファイル名</th>
            <th>期間</th>
            <th>行数</th>
            <th>マッチ</th>
            <th>未マッチ</th>
            <th>状態</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  // ─── データ取得・表示 ─────────────────────────────────────────────────────

  /** 現在の sort/filter 状態でトラックテーブルを再描画する */
  function _applyTrackDisplay() {
    const el = document.getElementById('sf-tracks-container');
    if (!el) return;
    const sorted = _sortAndFilterTracks(_allTracks, _trackSort, _trackFilter);
    el.innerHTML = renderTracksTable(sorted, _trackSort);
    _bindTrackControls(el);
  }

  /** ソート/フィルタコントロールにイベントリスナーを付与する */
  function _bindTrackControls(container) {
    // フィルタボタン
    container.querySelectorAll('[data-sf-filter]').forEach(btn => {
      btn.addEventListener('click', () => {
        _trackFilter = btn.dataset.sfFilter;
        _applyTrackDisplay();
      });
    });

    // ソート select
    const sel = container.querySelector('#sf-track-sort-select');
    if (sel) {
      sel.addEventListener('change', () => {
        _trackSort = sel.value;
        _applyTrackDisplay();
      });
    }

    // テーブルヘッダークリックでソート切替
    container.querySelectorAll('th[data-sf-sort-desc]').forEach(th => {
      th.addEventListener('click', () => {
        const descKey = th.dataset.sfSortDesc;
        const ascKey  = th.dataset.sfSortAsc;
        // 現在 desc → asc に切替、それ以外は desc へ
        _trackSort = (_trackSort === descKey) ? ascKey : descKey;
        _applyTrackDisplay();
      });
    });
  }

  /** Music Library タブ: 楽曲・リリース一覧を読み込む */
  async function loadLibrary() {
    const tracksEl   = document.getElementById('sf-tracks-container');
    const releasesEl = document.getElementById('sf-releases-container');
    if (tracksEl)   tracksEl.innerHTML   = '<div class="loading">読み込み中...</div>';
    if (releasesEl) releasesEl.innerHTML = '<div class="loading">読み込み中...</div>';

    try {
      const [tracksRes, releasesRes] = await Promise.all([
        fetch('/api/sf/tracks').then(r => r.json()),
        fetch('/api/sf/releases').then(r => r.json()),
      ]);
      _allTracks   = tracksRes.tracks || [];
      _trackSort   = 'release_date_desc';
      _trackFilter = 'all';
      _applyTrackDisplay();
      if (releasesEl) releasesEl.innerHTML = renderReleasesTable(releasesRes.releases || []);
    } catch (e) {
      if (tracksEl)   tracksEl.innerHTML   = `<div class="empty-state">エラー: ${esc(e.message)}</div>`;
      if (releasesEl) releasesEl.innerHTML = '';
    }
  }

  /** Artist Profiles タブ: プロフィール一覧を読み込む */
  async function loadProfiles() {
    const el = document.getElementById('sf-profiles-container');
    if (el) el.innerHTML = '<div class="loading">読み込み中...</div>';

    try {
      const res = await fetch('/api/sf/artist-profiles').then(r => r.json());
      if (el) el.innerHTML = renderProfilesTable(res.profiles || []);
    } catch (e) {
      if (el) el.innerHTML = `<div class="empty-state">エラー: ${esc(e.message)}</div>`;
    }
  }

  // ─── 配信状況タブ (Phase 24) ─────────────────────────────────────────────

  /** 配信プラットフォームの表示名マップ（配信状況タブ用・Phase 25 拡張版） */
  const DIST_PLATFORM_LABELS = {
    spotify:            'Spotify',
    apple_music:        'Apple Music',
    amazon_music:       'Amazon Music',
    youtube_music:      'YouTube Music',
    tidal:              'TIDAL',
    qobuz:              'Qobuz',
    deezer:             'Deezer',
    pandora:            'Pandora',
    iheartradio:        'iHeartRadio',
    tiktok:             'TikTok',
    facebook_instagram: 'Facebook / Instagram',
    anghami:            'Anghami',
    boomplay:           'Boomplay',
    ayoba:              'Ayoba',
    netease:            'NetEase',
    tencent:            'Tencent Music',
    claro_musica:       'Claro música',
    peloton:            'Peloton',
    awa:                'AWA',
    line_music:         'LINE MUSIC',
    kkbox:              'KKBOX',
    lissen:             'Lissen',
    audiomack:          'Audiomack',
    audible_magic:      'Audible Magic',
    nuuday:             'Nuuday',
    flo:                'FLO',
    snapchat:           'Snapchat',
    seven_digital:      '7digital',
    other:              'その他',
  };

  /** 全プラットフォームの定義順（表示順に使用） */
  const PLATFORM_ORDER = [
    'spotify','apple_music','amazon_music','youtube_music','tidal','qobuz',
    'deezer','pandora','iheartradio','tiktok','facebook_instagram','anghami',
    'boomplay','ayoba','netease','tencent','claro_musica','peloton',
    'awa','line_music','kkbox','lissen','audiomack','audible_magic',
    'nuuday','flo','snapchat','seven_digital','other',
  ];

  /** issue_type → 表示名 */
  const ISSUE_TYPE_LABELS = {
    mixed_artist:  '別アーティストとの混在',
    wrong_link:    '別ページへの紐付け',
    name_variant:  '表記揺れ',
    not_reflected: '未反映',
    other:         'その他',
  };

  /**
   * Soundrop配信済みだが Snow flakes 本人と確定できる公開 Artist URL が未特定のサービス。
   * 「未配信」ではなく「URL 未特定」と表示する。
   */
  const DIST_URL_UNKNOWN = new Set([
    'awa', 'line_music', 'kkbox', 'boomplay', 'ayoba', 'pandora',
    'iheartradio', 'claro_musica', 'flo', 'lissen', 'netease',
    'tencent', 'seven_digital', 'audiomack',
  ]);

  /**
   * 一般向け固定 Artist プロフィールページを管理する通常の DSP ではないサービス。
   * Soundrop 経由の著作権管理・データ照合等を行うプラットフォーム。
   */
  const DIST_NOT_APPLICABLE = new Set([
    'audible_magic', 'peloton', 'nuuday',
  ]);

  /**
   * 音源ライブラリ配信（TikTok Sound Library / Meta Sound Collection 等）のサービス。
   * 通常の Artist ページとは異なる配信形態であり、固定 Artist プロフィール URL は存在しない。
   */
  const DIST_LIBRARY_ONLY = new Set([
    'tiktok', 'facebook_instagram', 'snapchat',
  ]);

  /**
   * プラットフォームの統合表示ステータスを返す。
   * 優先順位: issue状態 > profile_status > プラットフォーム分類 > 未登録
   *
   * @param {string} platform
   * @param {object|undefined} profile  - sf_artist_profiles 行 or undefined
   * @param {Array}  issues             - sf_platform_issues 全行（フィルタはここで行う）
   * @returns {{ cls: string, label: string }}
   */
  function _platformDisplayStatus(platform, profile, issues) {
    // 未解決 issue（このplatform対象）
    const unresolved = issues.filter(i =>
      i.platform === platform &&
      i.issue_status !== 'resolved' &&
      i.issue_status !== 'wont_fix'
    );

    if (profile) {
      if (unresolved.length > 0) {
        // open が1件でもあれば「問題あり」、全件 requested なら「修正依頼済み」
        const hasOpen = unresolved.some(i => i.issue_status === 'open');
        return hasOpen
          ? { cls: 'sf-badge-red',    label: '問題あり' }
          : { cls: 'sf-badge-yellow', label: '修正依頼済み' };
      }
      if (profile.profile_status === 'active') {
        return { cls: 'sf-badge-green', label: '問題なし' };
      }
      // active 以外（unknown / pending 等）は profile_status をそのまま表示
      return PROFILE_STATUS_BADGE[profile.profile_status]
        || { cls: 'sf-badge-gray', label: profile.profile_status };
    }

    // プロフィールなし → プラットフォーム分類で判定
    if (DIST_NOT_APPLICABLE.has(platform))  return { cls: 'sf-badge-dim',  label: '対象外' };
    if (DIST_LIBRARY_ONLY.has(platform))    return { cls: 'sf-badge-dim',  label: '音源ライブラリ' };
    if (DIST_URL_UNKNOWN.has(platform))     return { cls: 'sf-badge-blue', label: 'URL未特定' };
    return { cls: 'sf-badge-dim', label: '未登録' };
  }

  /** issue_status → バッジ CSS */
  const ISSUE_STATUS_BADGE = {
    open:      { cls: 'sf-badge-red',    label: 'オープン' },
    requested: { cls: 'sf-badge-yellow', label: '修正依頼済み' },
    resolved:  { cls: 'sf-badge-green',  label: '解決済み' },
    wont_fix:  { cls: 'sf-badge-dim',    label: '対応しない' },
  };

  /** profile_status → バッジ CSS */
  const PROFILE_STATUS_BADGE = {
    active:    { cls: 'sf-badge-green',  label: 'active' },
    pending:   { cls: 'sf-badge-yellow', label: 'pending' },
    unclaimed: { cls: 'sf-badge-yellow', label: 'unclaimed' },
    inactive:  { cls: 'sf-badge-dim',    label: 'inactive' },
    unknown:   { cls: 'sf-badge-gray',   label: 'unknown' },
  };

  /** 内部データキャッシュ */
  let _distProfiles = [];
  let _distIssues   = [];

  /** 配信状況タブ: プロフィール一覧 + issue一覧を読み込む */
  async function loadDistribution() {
    const pEl = document.getElementById('dist-platforms-container');
    const iEl = document.getElementById('dist-issues-container');
    if (pEl) pEl.innerHTML = '<div class="loading">読み込み中...</div>';
    if (iEl) iEl.innerHTML = '<div class="loading">読み込み中...</div>';

    try {
      const [profRes, issueRes] = await Promise.all([
        fetch('/api/sf/artist-profiles').then(r => r.json()),
        fetch('/api/sf/platform-issues').then(r => r.json()),
      ]);

      _distProfiles = profRes.profiles || [];
      _distIssues   = issueRes.issues  || [];

      if (pEl) pEl.innerHTML = renderDistPlatforms(_distProfiles, _distIssues);
      _renderDistIssues();
      _bindDistEvents();
    } catch (e) {
      if (pEl) pEl.innerHTML = `<div class="empty-state">エラー: ${esc(e.message)}</div>`;
      if (iEl) iEl.innerHTML = '';
    }
  }

  /** フィルタ変更時のissue再描画のみ */
  function _renderDistIssues() {
    const iEl    = document.getElementById('dist-issues-container');
    const filter = document.getElementById('dist-issue-filter')?.value || '';
    if (!iEl) return;
    const filtered = filter ? _distIssues.filter(i => i.issue_status === filter) : _distIssues;
    iEl.innerHTML = renderDistIssues(filtered, _distProfiles);
    _bindDistIssueActions();
  }

  /** プラットフォームグリッドを描画する */
  function renderDistPlatforms(profiles, issues) {
    // platform -> profile マップ
    const profMap = {};
    for (const p of profiles) profMap[p.platform] = p;

    // platform -> 未解決 issue 数
    const issueCount = {};
    for (const iss of issues) {
      if (iss.issue_status !== 'resolved' && iss.issue_status !== 'wont_fix') {
        issueCount[iss.platform] = (issueCount[iss.platform] || 0) + 1;
      }
    }

    const cards = PLATFORM_ORDER.map(platform => {
      const p      = profMap[platform];
      const cnt    = issueCount[platform] || 0;
      const name   = DIST_PLATFORM_LABELS[platform] || platform;
      const status = _platformDisplayStatus(platform, p, issues);

      if (!p) {
        // プロフィール未登録カード
        // 対象外・音源ライブラリは「追加」ボタンを表示しない
        const addBtn = (DIST_NOT_APPLICABLE.has(platform) || DIST_LIBRARY_ONLY.has(platform))
          ? ''
          : `<button class="sf-btn dist-add-profile-for" data-platform="${esc(platform)}">追加</button>`;
        return `
          <div class="dist-platform-card dist-platform-empty">
            <div class="dist-platform-name">${esc(name)}</div>
            <div class="dist-platform-status">
              <span class="sf-badge ${status.cls}">${status.label}</span>
            </div>
            ${addBtn ? `<div class="dist-platform-actions">${addBtn}</div>` : ''}
          </div>`;
      }

      // プロフィール登録済みカード
      const claimed = p.claimed
        ? '<span class="sf-badge sf-badge-green">✓ claimed</span>'
        : '';
      const issLabel = cnt > 0
        ? `<span class="sf-badge sf-badge-red" title="未解決の問題あり">${cnt} 件</span>`
        : '';
      const urlHtml = p.artist_page_url
        ? `<a href="${esc(p.artist_page_url)}" target="_blank" rel="noopener"
              style="color:var(--accent);font-size:11px;word-break:break-all">${esc(p.artist_page_url)}</a>`
        : '<span style="color:var(--text-dim);font-size:11px">URL未登録</span>';

      return `
        <div class="dist-platform-card" data-platform="${esc(platform)}">
          <div class="dist-platform-name">${esc(name)}</div>
          <div class="dist-platform-status">
            <span class="sf-badge ${status.cls}">${status.label}</span>
            ${claimed}
            ${issLabel}
          </div>
          <div class="dist-platform-detail">
            <div style="font-size:11px;color:var(--text-sec);margin-top:4px">
              ${p.platform_artist_id ? `ID: ${esc(p.platform_artist_id)}` : '<span style="color:var(--text-dim)">ID未登録</span>'}
            </div>
            <div style="margin-top:4px">${urlHtml}</div>
            <div style="font-size:11px;color:var(--text-sec);margin-top:4px">
              確認日: ${p.last_checked_at || '—'}
            </div>
            ${p.memo ? `<div style="font-size:11px;color:var(--text-sec);margin-top:2px">${esc(p.memo)}</div>` : ''}
          </div>
          <div class="dist-platform-actions">
            <button class="sf-btn dist-edit-profile" data-id="${p.id}">編集</button>
          </div>
        </div>`;
    });

    return `<div class="dist-platforms-grid">${cards.join('')}</div>`;
  }

  /** issue一覧テーブルを描画する */
  function renderDistIssues(issues, profiles) {
    if (!issues.length) {
      return '<div class="empty-state">問題は登録されていません</div>';
    }

    // profileId -> "Platform (artist_key)" マップ（entity_type=artist用）
    const profLabels = {};
    for (const p of profiles) {
      profLabels[p.id] = `${DIST_PLATFORM_LABELS[p.platform] || p.platform} (${p.artist_key})`;
    }

    const rows = issues.map(iss => {
      const stInfo  = ISSUE_STATUS_BADGE[iss.issue_status] || { cls: 'sf-badge-gray', label: iss.issue_status };
      const typeLabel = ISSUE_TYPE_LABELS[iss.issue_type] || iss.issue_type;
      const pLabel  = DIST_PLATFORM_LABELS[iss.platform] || iss.platform;
      const entity  = iss.entity_type === 'artist'
        ? (profLabels[iss.entity_id] || `artist #${iss.entity_id}`)
        : `${iss.entity_type} #${iss.entity_id}`;
      const urlHtml = iss.related_url
        ? `<a href="${esc(iss.related_url)}" target="_blank" rel="noopener"
              style="color:var(--accent);font-size:11px">リンク</a>`
        : '';

      const canRequest = (iss.issue_status === 'open');
      const canResolve = (iss.issue_status !== 'resolved');

      return `
        <tr data-issue-id="${iss.id}">
          <td><span class="sf-badge ${stInfo.cls}">${stInfo.label}</span></td>
          <td>${esc(pLabel)}</td>
          <td style="font-size:12px;color:var(--text-sec)">${esc(entity)}</td>
          <td>${esc(typeLabel)}</td>
          <td style="font-size:12px">${esc(iss.opened_at || '—')}</td>
          <td style="font-size:12px">${esc(iss.requested_at || '—')}</td>
          <td style="font-size:12px">${esc(iss.resolved_at || '—')}</td>
          <td style="font-size:12px">${esc(iss.last_checked_at || '—')}</td>
          <td style="max-width:160px;font-size:11px;word-break:break-all">${esc(iss.memo || '')} ${urlHtml}</td>
          <td>
            <div style="display:flex;gap:4px;flex-wrap:wrap">
              <button class="sf-btn dist-issue-edit" data-id="${iss.id}" style="font-size:11px;padding:3px 7px">編集</button>
              ${canRequest ? `<button class="sf-btn dist-issue-request" data-id="${iss.id}" style="font-size:11px;padding:3px 7px;background:#92400e">依頼済み</button>` : ''}
              ${canResolve ? `<button class="sf-btn dist-issue-resolve" data-id="${iss.id}" style="font-size:11px;padding:3px 7px;background:#14532d">解決済み</button>` : ''}
              <button class="sf-btn dist-issue-check" data-id="${iss.id}" style="font-size:11px;padding:3px 7px">今日確認</button>
            </div>
          </td>
        </tr>`;
    });

    return `
      <div style="overflow-x:auto">
        <table class="sf-table">
          <thead>
            <tr>
              <th>状態</th>
              <th>プラットフォーム</th>
              <th>対象</th>
              <th>問題種別</th>
              <th>発覚日</th>
              <th>依頼日</th>
              <th>解決日</th>
              <th>最終確認</th>
              <th>メモ / URL</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>${rows.join('')}</tbody>
        </table>
      </div>`;
  }

  /** 配信状況タブのイベントをバインドする（ページ・フィルタ級） */
  function _bindDistEvents() {
    // ＋ プロフィール追加ボタン
    document.getElementById('dist-add-profile-btn')?.addEventListener('click', () => {
      _openProfileModal(null, null);
    });

    // プラットフォームカードの「追加」ボタン（platform プリセット付き）
    document.querySelectorAll('.dist-add-profile-for').forEach(btn => {
      btn.addEventListener('click', () => _openProfileModal(null, btn.dataset.platform));
    });

    // プラットフォームカードの「編集」ボタン
    document.querySelectorAll('.dist-edit-profile').forEach(btn => {
      btn.addEventListener('click', () => {
        const id      = parseInt(btn.dataset.id, 10);
        const profile = _distProfiles.find(p => p.id === id);
        if (profile) _openProfileModal(profile, null);
      });
    });

    // ＋ 問題追加ボタン
    document.getElementById('dist-add-issue-btn')?.addEventListener('click', () => {
      _openIssueModal(null);
    });

    // フィルタ変更
    document.getElementById('dist-issue-filter')?.addEventListener('change', _renderDistIssues);
  }

  /** issue アクションボタンのバインド（issue テーブル再描画後に呼ぶ） */
  function _bindDistIssueActions() {
    document.querySelectorAll('.dist-issue-edit').forEach(btn => {
      btn.addEventListener('click', () => {
        const id    = parseInt(btn.dataset.id, 10);
        const issue = _distIssues.find(i => i.id === id);
        if (issue) _openIssueModal(issue);
      });
    });

    document.querySelectorAll('.dist-issue-request').forEach(btn => {
      btn.addEventListener('click', () => _issueAction(parseInt(btn.dataset.id, 10), 'request'));
    });

    document.querySelectorAll('.dist-issue-resolve').forEach(btn => {
      btn.addEventListener('click', () => _issueAction(parseInt(btn.dataset.id, 10), 'resolve'));
    });

    document.querySelectorAll('.dist-issue-check').forEach(btn => {
      btn.addEventListener('click', () => _issueAction(parseInt(btn.dataset.id, 10), 'check'));
    });
  }

  // ─── プロフィールモーダル ──────────────────────────────────────────────────

  function _openProfileModal(profile, presetPlatform) {
    const overlay = document.getElementById('modal-overlay');
    const modal   = document.getElementById('modal-dist-profile');
    if (!overlay || !modal) return;

    // 他モーダルを非表示
    overlay.querySelectorAll('.modal').forEach(m => m.hidden = true);
    document.getElementById('dist-profile-error').textContent = '';

    const isEdit = !!profile;
    document.getElementById('modal-dist-profile-title').textContent = isEdit ? 'プロフィールを編集' : 'プロフィールを追加';
    document.getElementById('dist-profile-id').value          = profile?.id ?? '';
    document.getElementById('dist-profile-platform').value    = profile?.platform ?? presetPlatform ?? '';
    document.getElementById('dist-profile-platform').disabled = isEdit;
    document.getElementById('dist-profile-status').value      = profile?.profile_status ?? 'unknown';
    document.getElementById('dist-profile-artist-id').value   = profile?.platform_artist_id ?? '';
    document.getElementById('dist-profile-claimed').checked   = !!(profile?.claimed);
    document.getElementById('dist-profile-url').value         = profile?.artist_page_url ?? '';
    document.getElementById('dist-profile-checked').value     = profile?.last_checked_at ?? '';
    document.getElementById('dist-profile-memo').value        = profile?.memo ?? '';
    document.getElementById('dist-profile-submit').textContent = isEdit ? '保存する' : '追加する';

    modal.hidden = false;
    overlay.hidden = false;

    document.getElementById('dist-profile-form').onsubmit = (e) => {
      e.preventDefault();
      _submitProfileModal(isEdit);
    };
  }

  async function _submitProfileModal(isEdit) {
    const errEl  = document.getElementById('dist-profile-error');
    errEl.textContent = '';

    const id       = document.getElementById('dist-profile-id').value;
    const platform = document.getElementById('dist-profile-platform').value;
    const status   = document.getElementById('dist-profile-status').value;
    const artistId = document.getElementById('dist-profile-artist-id').value.trim();
    const claimed  = document.getElementById('dist-profile-claimed').checked ? 1 : 0;
    const url      = document.getElementById('dist-profile-url').value.trim();
    const checked  = document.getElementById('dist-profile-checked').value;
    const memo     = document.getElementById('dist-profile-memo').value.trim();

    if (!platform) { errEl.textContent = 'プラットフォームを選択してください'; return; }

    const body = {
      artist_key:         'snow_flakes',
      artist_name:        'Snow flakes',
      platform,
      profile_status:     status,
      platform_artist_id: artistId || null,
      claimed,
      artist_page_url:    url || null,
      last_checked_at:    checked || null,
      memo:               memo || null,
    };

    try {
      let res;
      if (isEdit && id) {
        res = await fetch(`/api/sf/artist-profiles/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }).then(r => r.json());
      } else {
        res = await fetch('/api/sf/artist-profiles', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }).then(r => r.json());
      }

      if (!res.ok) { errEl.textContent = res.message || '保存に失敗しました'; return; }
      _closeModals();
      await loadDistribution();
    } catch (e) {
      errEl.textContent = `エラー: ${e.message}`;
    }
  }

  // ─── issueモーダル ─────────────────────────────────────────────────────────

  function _openIssueModal(issue) {
    const overlay = document.getElementById('modal-overlay');
    const modal   = document.getElementById('modal-dist-issue');
    if (!overlay || !modal) return;

    overlay.querySelectorAll('.modal').forEach(m => m.hidden = true);
    document.getElementById('dist-issue-error').textContent = '';

    const isEdit = !!issue;
    document.getElementById('modal-dist-issue-title').textContent = isEdit ? '問題を編集' : '問題を追加';
    document.getElementById('dist-issue-id').value          = issue?.id ?? '';
    document.getElementById('dist-issue-entity-type').value = issue?.entity_type ?? 'artist';
    document.getElementById('dist-issue-platform').value    = issue?.platform ?? '';
    document.getElementById('dist-issue-type').value        = issue?.issue_type ?? 'other';
    document.getElementById('dist-issue-status').value      = issue?.issue_status ?? 'open';
    document.getElementById('dist-issue-opened-at').value   = issue?.opened_at ?? '';
    document.getElementById('dist-issue-url').value         = issue?.related_url ?? '';
    document.getElementById('dist-issue-memo').value        = issue?.memo ?? '';
    document.getElementById('dist-issue-submit').textContent = isEdit ? '保存する' : '追加する';

    // entity selector を更新
    _updateEntitySelector(issue?.entity_type ?? 'artist', issue?.entity_id ?? null);

    modal.hidden  = false;
    overlay.hidden = false;

    // entity_type 変更時に selector を切り替え
    document.getElementById('dist-issue-entity-type').onchange = function() {
      _updateEntitySelector(this.value, null);
    };

    document.getElementById('dist-issue-form').onsubmit = (e) => {
      e.preventDefault();
      _submitIssueModal(isEdit);
    };
  }

  /** entity種別に応じてセレクタ or テキスト入力を切り替える */
  function _updateEntitySelector(entityType, selectedId) {
    const sel   = document.getElementById('dist-issue-entity-id-select');
    const inp   = document.getElementById('dist-issue-entity-id-input');
    if (!sel || !inp) return;

    if (entityType === 'artist') {
      sel.style.display = '';
      inp.style.display = 'none';
      // プロフィール一覧を option として展開
      sel.innerHTML = '<option value="">— 選択 —</option>' +
        _distProfiles.map(p =>
          `<option value="${p.id}" ${p.id === selectedId ? 'selected' : ''}>
            ${esc(DIST_PLATFORM_LABELS[p.platform] || p.platform)} (id: ${p.id})
           </option>`
        ).join('');
    } else {
      sel.style.display = 'none';
      inp.style.display = '';
      inp.value = selectedId ?? '';
    }
  }

  async function _submitIssueModal(isEdit) {
    const errEl = document.getElementById('dist-issue-error');
    errEl.textContent = '';

    const id         = document.getElementById('dist-issue-id').value;
    const entityType = document.getElementById('dist-issue-entity-type').value;
    const sel        = document.getElementById('dist-issue-entity-id-select');
    const inp        = document.getElementById('dist-issue-entity-id-input');
    const entityId   = entityType === 'artist'
      ? parseInt(sel.value, 10)
      : parseInt(inp.value, 10);
    const platform   = document.getElementById('dist-issue-platform').value;
    const issueType  = document.getElementById('dist-issue-type').value;
    const issueStatus = document.getElementById('dist-issue-status').value;
    const openedAt   = document.getElementById('dist-issue-opened-at').value;
    const url        = document.getElementById('dist-issue-url').value.trim();
    const memo       = document.getElementById('dist-issue-memo').value.trim();

    if (!platform)       { errEl.textContent = 'プラットフォームを選択してください'; return; }
    if (!entityId || isNaN(entityId)) { errEl.textContent = '対象を選択してください'; return; }

    try {
      let res;
      if (isEdit && id) {
        res = await fetch(`/api/sf/platform-issues/${id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            platform, issue_type: issueType, issue_status: issueStatus,
            opened_at: openedAt || null, related_url: url || null, memo: memo || null,
          }),
        }).then(r => r.json());
      } else {
        res = await fetch('/api/sf/platform-issues', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            entity_type: entityType, entity_id: entityId, platform,
            issue_type: issueType, issue_status: issueStatus,
            opened_at: openedAt || null, related_url: url || null, memo: memo || null,
          }),
        }).then(r => r.json());
      }

      if (!res.ok) { errEl.textContent = res.message || '保存に失敗しました'; return; }
      _closeModals();
      await loadDistribution();
    } catch (e) {
      errEl.textContent = `エラー: ${e.message}`;
    }
  }

  // ─── issueアクション（request / resolve / check） ──────────────────────────

  async function _issueAction(id, action) {
    const actions = { request: '修正依頼済みに変更', resolve: '解決済みに変更', check: '今日確認日を記録' };
    try {
      const res = await fetch(`/api/sf/platform-issues/${id}/${action}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      }).then(r => r.json());

      if (!res.ok) {
        alert(`エラー: ${res.message || '操作に失敗しました'}`);
        return;
      }
      // issue を更新して再描画（全リロード不要）
      const updated = await fetch('/api/sf/platform-issues').then(r => r.json());
      _distIssues = updated.issues || [];
      _renderDistIssues();
    } catch (e) {
      alert(`エラー: ${e.message}`);
    }
  }

  /** モーダルを閉じる */
  function _closeModals() {
    const overlay = document.getElementById('modal-overlay');
    if (overlay) overlay.hidden = true;
    overlay?.querySelectorAll('.modal').forEach(m => m.hidden = true);
  }

  // ─── YouTube Analytics タブ ────────────────────────────────────────────────

  /** YouTube チャンネル概要と動画トップ10を読み込む（Phase 7） */
  async function loadYouTube() {
    const chEl  = document.getElementById('sf-yt-channel-container');
    const vidEl = document.getElementById('sf-yt-videos-container');
    if (chEl)  chEl.innerHTML  = '<div class="loading">読み込み中...</div>';
    if (vidEl) vidEl.innerHTML = '<div class="loading">読み込み中...</div>';

    try {
      const [compareRes, topRes] = await Promise.all([
        fetch('/api/sf/youtube/channel/compare?days=30').then(r => r.json()),
        fetch('/api/sf/youtube/videos/top?metric=views&limit=10').then(r => r.json()),
      ]);

      if (chEl)  chEl.innerHTML  = renderYouTubeChannel(compareRes);
      if (vidEl) vidEl.innerHTML = renderYouTubeVideos(topRes.rows || []);
    } catch (e) {
      const msg = `<div class="empty-state">エラー: ${esc(e.message)}</div>`;
      if (chEl)  chEl.innerHTML  = msg;
      if (vidEl) vidEl.innerHTML = msg;
    }
  }

  /** YouTube チャンネル比較カードを描画する */
  function renderYouTubeChannel(data) {
    if (!data?.ok) {
      return '<div class="empty-state">データなし — 認証設定が必要か、データが未取得です</div>';
    }
    const fmt    = (n) => (n == null ? '—' : Number(n).toLocaleString());
    const fmtH   = (min) => (min == null ? '—' : `${Math.floor(min / 60).toLocaleString()}h ${min % 60}m`);
    const pct    = (a, b) => {
      if (a == null || b == null || b === 0) return '';
      const d = ((a - b) / b * 100).toFixed(1);
      const sign = d >= 0 ? '+' : '';
      return `<span style="color:${d >= 0 ? 'var(--green)' : 'var(--red)'}">${sign}${d}%</span>`;
    };
    const cv = data.current_views;
    const pv = data.previous_views;
    const cw = data.current_watch_min;
    const pw = data.previous_watch_min;
    const cg = data.current_subs_gained;
    const pg = data.previous_subs_gained;
    const cl = data.current_subs_lost;
    const pl = data.previous_subs_lost;

    return `
      <div style="padding: 12px 18px 6px; font-size: 12px; color: var(--text-muted);">
        直近${esc(String(data.days))}日間 vs 前${esc(String(data.days))}日間
      </div>
      <table class="sf-table">
        <thead>
          <tr><th>指標</th><th>今期</th><th>前期</th><th>変化</th></tr>
        </thead>
        <tbody>
          <tr><td>総登録者数</td>
              <td>${fmt(data.subscribers_count?.current)}</td>
              <td>${fmt(data.subscribers_count?.previous)}</td>
              <td>${pct(data.subscribers_count?.current, data.subscribers_count?.previous)}</td></tr>
          <tr><td>再生回数</td>
              <td>${fmt(cv)}</td><td>${fmt(pv)}</td><td>${pct(cv, pv)}</td></tr>
          <tr><td>視聴時間</td>
              <td>${fmtH(cw)}</td><td>${fmtH(pw)}</td><td>${pct(cw, pw)}</td></tr>
          <tr><td>新規登録者</td>
              <td>${fmt(cg)}</td><td>${fmt(pg)}</td><td>${pct(cg, pg)}</td></tr>
          <tr><td>登録解除</td>
              <td>${fmt(cl)}</td><td>${fmt(pl)}</td><td></td></tr>
        </tbody>
      </table>
      <div style="padding: 4px 18px 12px; font-size: 11px; color: var(--text-muted);">
        ※ 収益・低評価・リアルタイムデータは YouTube Analytics API の制限により取得不可
      </div>
    `;
  }

  /** YouTube 動画パフォーマンステーブルを描画する */
  function renderYouTubeVideos(rows) {
    if (!rows.length) {
      return '<div class="empty-state">動画データなし — データ未収集または認証が必要です</div>';
    }
    const fmt  = (n) => (n == null ? '—' : Number(n).toLocaleString());
    const fmtS = (s) => {
      if (s == null) return '—';
      const m = Math.floor(s / 60);
      const sec = Math.round(s % 60);
      return `${m}:${String(sec).padStart(2, '0')}`;
    };
    const rowsHtml = rows.map(r => `
      <tr>
        <td>${r.platform_id
          ? `<a href="https://www.youtube.com/watch?v=${esc(r.platform_id)}" target="_blank" rel="noopener">${esc(r.title || r.platform_id)}</a>`
          : esc(r.title || '—')}</td>
        <td>${esc(r.content_type || '—')}</td>
        <td>${esc((r.published_at || '').slice(0, 10) || '—')}</td>
        <td class="sf-col-center">${fmt(r.views)}</td>
        <td class="sf-col-center">${fmtS(r.avg_watch_sec)}</td>
        <td class="sf-col-center">${fmt(r.likes)}</td>
        <td class="sf-col-center">${fmt(r.comments)}</td>
      </tr>
    `).join('');
    return `
      <table class="sf-table">
        <thead>
          <tr>
            <th>タイトル</th><th>種別</th><th>投稿日</th>
            <th>再生数</th><th>平均視聴時間</th><th>いいね</th><th>コメント</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    `;
  }

  // ─── TikTok Analytics タブ ────────────────────────────────────────────────

  /** TikTok アカウント概要と動画トップ10を読み込む（Phase 8） */
  async function loadTikTok() {
    const acEl  = document.getElementById('sf-tt-account-container');
    const vidEl = document.getElementById('sf-tt-videos-container');
    if (acEl)  acEl.innerHTML  = '<div class="loading">読み込み中...</div>';
    if (vidEl) vidEl.innerHTML = '<div class="loading">読み込み中...</div>';

    try {
      const [compareRes, topRes] = await Promise.all([
        fetch('/api/sf/tiktok/account/compare?days=30').then(r => r.json()),
        fetch('/api/sf/tiktok/videos/top?metric=views&limit=10').then(r => r.json()),
      ]);

      if (acEl)  acEl.innerHTML  = renderTikTokAccount(compareRes);
      if (vidEl) vidEl.innerHTML = renderTikTokVideos(topRes.rows || []);
    } catch (e) {
      const msg = `<div class="empty-state">エラー: ${esc(e.message)}</div>`;
      if (acEl)  acEl.innerHTML  = msg;
      if (vidEl) vidEl.innerHTML = msg;
    }
  }

  /** TikTok アカウント比較カードを描画する */
  function renderTikTokAccount(data) {
    if (!data?.ok) {
      return '<div class="empty-state">データなし — TikTok Analytics CSV をインポートしてください</div>';
    }
    const fmt  = (n) => (n == null ? '—' : Number(n).toLocaleString());
    const pct  = (a, b) => {
      if (a == null || b == null || b === 0) return '';
      const d = ((a - b) / b * 100).toFixed(1);
      const sign = d >= 0 ? '+' : '';
      return `<span style="color:${d >= 0 ? 'var(--green)' : 'var(--red)'}">${sign}${d}%</span>`;
    };
    const cv = data.current_reach;
    const pv = data.previous_reach;
    const cp = data.current_profile_visits;
    const pp = data.previous_profile_visits;
    const cfd = data.current_followers_delta;
    const pfd = data.previous_followers_delta;

    return `
      <div style="padding: 12px 18px 6px; font-size: 12px; color: var(--text-muted);">
        直近${esc(String(data.days))}日間 vs 前${esc(String(data.days))}日間
      </div>
      <table class="sf-table">
        <thead>
          <tr><th>指標</th><th>今期</th><th>前期</th><th>変化</th></tr>
        </thead>
        <tbody>
          <tr><td>総フォロワー数</td>
              <td>${fmt(data.followers_count?.current)}</td>
              <td>${fmt(data.followers_count?.previous)}</td>
              <td>${pct(data.followers_count?.current, data.followers_count?.previous)}</td></tr>
          <tr><td>純増フォロワー</td>
              <td>${fmt(cfd)}</td><td>${fmt(pfd)}</td><td>${pct(cfd, pfd)}</td></tr>
          <tr><td>動画再生数</td>
              <td>${fmt(cv)}</td><td>${fmt(pv)}</td><td>${pct(cv, pv)}</td></tr>
          <tr><td>プロフィール表示</td>
              <td>${fmt(cp)}</td><td>${fmt(pp)}</td><td>${pct(cp, pp)}</td></tr>
        </tbody>
      </table>
      <div style="padding: 4px 18px 12px; font-size: 11px; color: var(--text-muted);">
        ※ CSV インポート方式。TikTok Analytics CSV（内部正規化フォーマット）を使用
      </div>
    `;
  }

  /** TikTok 動画パフォーマンステーブルを描画する */
  function renderTikTokVideos(rows) {
    if (!rows || rows.length === 0) {
      return '<div class="empty-state">動画データなし — TikTok video_metrics CSV をインポートしてください</div>';
    }
    const fmt  = (n) => (n == null ? '—' : Number(n).toLocaleString());
    const fmtS = (s) => {
      if (s == null) return '—';
      const m = Math.floor(s / 60);
      const sec = Math.round(s % 60);
      return `${m}:${String(sec).padStart(2, '0')}`;
    };
    const fmtPct = (r) => (r == null ? '—' : `${(r * 100).toFixed(1)}%`);
    const rowsHtml = rows.map(r => `
      <tr>
        <td>${r.platform_id
          ? `<a href="https://www.tiktok.com/video/${esc(r.platform_id)}" target="_blank" rel="noopener">${esc(r.title || r.platform_id)}</a>`
          : esc(r.title || '—')}</td>
        <td>${esc((r.published_at || '').slice(0, 10) || '—')}</td>
        <td class="sf-col-center">${fmt(r.views)}</td>
        <td class="sf-col-center">${fmtS(r.avg_watch_sec)}</td>
        <td class="sf-col-center">${fmtPct(r.completion_rate)}</td>
        <td class="sf-col-center">${fmt(r.likes)}</td>
        <td class="sf-col-center">${fmt(r.shares)}</td>
      </tr>
    `).join('');
    return `
      <table class="sf-table">
        <thead>
          <tr>
            <th>タイトル</th><th>投稿日</th>
            <th>再生数</th><th>平均視聴時間</th><th>完了率</th><th>いいね</th><th>シェア</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
    `;
  }

  /** Soundrop Import タブ: インポート履歴を読み込む */
  async function loadImports() {
    const el = document.getElementById('sf-import-container');
    if (el) el.innerHTML = '<div class="loading">読み込み中...</div>';

    try {
      const [histRes, unreviewedRes] = await Promise.all([
        fetch('/api/sf/imports').then(r => r.json()),
        fetch('/api/sf/imports/unreviewed').then(r => r.json()),
      ]);

      let html = renderImportHistory(histRes.imports || []);

      const unreviewed = unreviewedRes.rows || [];
      if (unreviewed.length > 0) {
        const unrevRows = unreviewed.map(r => `
          <tr class="sf-import-row needs-review">
            <td class="sf-col-center">${r.row_index ?? '—'}</td>
            <td>${esc(r.distributor || '—')}</td>
            <td>${esc(r.file_name || '—')}</td>
            <td>${esc(r.platform || '—')}</td>
            <td>${esc(r.period || '—')}</td>
            <td class="sf-col-center">${r.streams ?? '—'}</td>
            <td class="sf-col-center">${r.revenue_amount ?? '—'}</td>
            <td><span class="sf-badge sf-badge-red">要確認</span></td>
          </tr>
        `).join('');
        html += `
          <h3 style="margin: 20px 18px 8px; font-size: 13px; color: var(--yellow);">
            要レビュー行 (${unreviewed.length}件)
          </h3>
          <table class="sf-table">
            <thead>
              <tr>
                <th>行番号</th><th>配信元</th><th>ファイル</th>
                <th>Platform</th><th>期間</th><th>Streams</th><th>Revenue</th><th>状態</th>
              </tr>
            </thead>
            <tbody>${unrevRows}</tbody>
          </table>
        `;
      }

      if (el) el.innerHTML = html;
    } catch (e) {
      if (el) el.innerHTML = `<div class="empty-state">エラー: ${esc(e.message)}</div>`;
    }
  }

  // ─── Funnel Analytics（Phase 9）──────────────────────────────────────────

  /**
   * Funnel タブを読み込む。
   * - 読み込み中: setState('analyzing')
   * - 完了時:    setState('completed')
   * - データ警告: setState('notice')
   *
   * 因果関係を断定しない表現を使用する。
   * 自動でサイト変更・投稿・作品変更は行わない。
   */
  async function loadFunnel() {
    setState('analyzing', 'ファネルデータを分析しています...');

    const overviewEl  = document.getElementById('sf-funnel-overview-container');
    const timelineEl  = document.getElementById('sf-funnel-timeline-container');

    if (overviewEl)  overviewEl.innerHTML  = '<div class="loading">読み込み中...</div>';
    if (timelineEl)  timelineEl.innerHTML  = '<div class="loading">読み込み中...</div>';

    try {
      const [overviewRes, eventsRes] = await Promise.all([
        fetch('/api/sf/funnel/overview').then(r => r.json()),
        fetch('/api/sf/funnel/events').then(r => r.json()),
      ]);

      if (overviewEl) {
        overviewEl.innerHTML = renderFunnelOverview(overviewRes.ok ? overviewRes : null);
      }
      if (timelineEl) {
        timelineEl.innerHTML = renderEventTimeline(eventsRes.ok ? (eventsRes.events || []) : []);
      }

      // notice: データ欠損や警告がある場合に軽度の注意喚起
      // 「確認した方がよい変化があります」程度に留める
      const dq = overviewRes?.data_quality;
      if (dq && (dq.missing_sources?.length > 0 || dq.warnings?.length > 0)) {
        setState('notice', '確認した方がよいデータがあります');
      } else {
        setState('completed', '分析完了');
      }

    } catch (e) {
      if (overviewEl) overviewEl.innerHTML = `<div class="empty-state">エラー: ${esc(e.message)}</div>`;
      if (timelineEl) timelineEl.innerHTML = '';
      setState('idle');
    }
  }

  /**
   * Funnel Overview を 4 Stage カード形式でレンダリングする。
   *
   * !! 人数の漏斗図として描かない !!
   *    異種データを 1 本の人数として表現しない。
   *    source 別の指標カードを表示する。
   *
   * @param {object|null} data - /api/sf/funnel/overview レスポンス
   * @returns {string} HTML
   */
  function renderFunnelOverview(data) {
    if (!data) return '<div class="empty-state">データを取得できませんでした</div>';

    const { stages, data_quality, from, to } = data;

    const fmtNum = (v) => (v == null) ? '—' : v.toLocaleString();
    const fmtPct = (v) => (v == null) ? '—' : `${(v * 100).toFixed(1)}%`;

    const dqHtml = (() => {
      if (!data_quality) return '';
      const parts = [];
      if (data_quality.missing_sources?.length > 0) {
        parts.push(`データなし: ${data_quality.missing_sources.join(', ')}`);
      }
      if (data_quality.monthly_only_sources?.length > 0) {
        parts.push(`月次のみ: ${data_quality.monthly_only_sources.join(', ')}`);
      }
      if (data_quality.unlinked_content_count > 0) {
        parts.push(`未紐付けコンテンツ: ${data_quality.unlinked_content_count}件`);
      }
      if (data_quality.warnings?.length > 0) {
        parts.push(...data_quality.warnings);
      }
      if (parts.length === 0) return '';
      return `<div class="sf-funnel-dq">${parts.map(p => `<span>${esc(p)}</span>`).join(' / ')}</div>`;
    })();

    const d = stages?.discovery?.social ?? {};
    const e = stages?.engagement?.social ?? {};

    return `
      <div class="sf-funnel-period">集計期間: ${esc(from ?? '—')} 〜 ${esc(to ?? '—')}</div>
      ${dqHtml}
      <div class="sf-funnel-stages">

        <div class="sf-funnel-stage">
          <div class="sf-funnel-stage-label">Stage 1: DISCOVERY</div>
          <div class="sf-funnel-cards">
            <div class="sf-funnel-card">
              <div class="sf-funnel-source">Instagram</div>
              <div class="sf-funnel-row"><span>Reach</span><span>${fmtNum(d.instagram?.reach)}</span></div>
              <div class="sf-funnel-row"><span>Views</span><span>${fmtNum(d.instagram?.views)}</span></div>
            </div>
            <div class="sf-funnel-card">
              <div class="sf-funnel-source">YouTube</div>
              <div class="sf-funnel-row"><span>Views</span><span>${fmtNum(d.youtube?.views)}</span></div>
            </div>
            <div class="sf-funnel-card">
              <div class="sf-funnel-source">TikTok</div>
              <div class="sf-funnel-row"><span>Reach</span><span>${fmtNum(d.tiktok?.reach)}</span></div>
              <div class="sf-funnel-row"><span>Impressions</span><span>${fmtNum(d.tiktok?.impressions)}</span></div>
            </div>
            <div class="sf-funnel-card">
              <div class="sf-funnel-source">サイト (GA4)</div>
              <div class="sf-funnel-row"><span>Sessions</span><span>${fmtNum(stages?.discovery?.site?.sessions)}</span></div>
              <div class="sf-funnel-row"><span>Users</span><span>${fmtNum(stages?.discovery?.site?.users)}</span></div>
            </div>
          </div>
        </div>

        <div class="sf-funnel-stage">
          <div class="sf-funnel-stage-label">Stage 2: ENGAGEMENT</div>
          <div class="sf-funnel-cards">
            <div class="sf-funnel-card">
              <div class="sf-funnel-source">Instagram</div>
              <div class="sf-funnel-row"><span>Likes</span><span>${fmtNum(e.instagram?.likes)}</span></div>
              <div class="sf-funnel-row"><span>Comments</span><span>${fmtNum(e.instagram?.comments)}</span></div>
              <div class="sf-funnel-row"><span>Saves</span><span>${fmtNum(e.instagram?.saves)}</span></div>
            </div>
            <div class="sf-funnel-card">
              <div class="sf-funnel-source">YouTube</div>
              <div class="sf-funnel-row"><span>Likes</span><span>${fmtNum(e.youtube?.likes)}</span></div>
              <div class="sf-funnel-row"><span>Watch time</span><span>${fmtNum(e.youtube?.watch_time_min)} min</span></div>
            </div>
            <div class="sf-funnel-card">
              <div class="sf-funnel-source">TikTok</div>
              <div class="sf-funnel-row"><span>Likes</span><span>${fmtNum(e.tiktok?.likes)}</span></div>
              <div class="sf-funnel-row"><span>Completion</span><span>${fmtPct(e.tiktok?.completion_rate)}</span></div>
            </div>
            <div class="sf-funnel-card">
              <div class="sf-funnel-source">サイト (GA4)</div>
              <div class="sf-funnel-row"><span>Page Views</span><span>${fmtNum(stages?.engagement?.site?.page_views)}</span></div>
              <div class="sf-funnel-row"><span>Engaged Sessions</span><span>${fmtNum(stages?.engagement?.site?.engaged_sessions)}</span></div>
            </div>
          </div>
        </div>

        <div class="sf-funnel-stage">
          <div class="sf-funnel-stage-label">Stage 3: DEEP INTEREST</div>
          <div class="sf-funnel-cards">
            <div class="sf-funnel-card">
              <div class="sf-funnel-source">なろう <span class="sf-funnel-monthly">月次</span></div>
              <div class="sf-funnel-row"><span>月間PV</span><span>${fmtNum(stages?.deep_interest?.narou?.pv_monthly)}</span></div>
              <div class="sf-funnel-row"><span>ブックマーク</span><span>${fmtNum(stages?.deep_interest?.narou?.bookmark_count)}</span></div>
              <div class="sf-funnel-row"><span>レビュー</span><span>${fmtNum(stages?.deep_interest?.narou?.review_count)}</span></div>
            </div>
            <div class="sf-funnel-card">
              <div class="sf-funnel-source">Music</div>
              <div class="sf-funnel-row"><span>Streams</span><span>${fmtNum(stages?.deep_interest?.music?.streams)}</span></div>
              <div class="sf-funnel-row"><span>Listeners</span><span>${fmtNum(stages?.deep_interest?.music?.listeners)}</span></div>
              <div class="sf-funnel-row"><span>Saves</span><span>${fmtNum(stages?.deep_interest?.music?.saves)}</span></div>
            </div>
          </div>
        </div>

        <div class="sf-funnel-stage">
          <div class="sf-funnel-stage-label">Stage 4: VALUE</div>
          <div class="sf-funnel-cards">
            <div class="sf-funnel-card">
              <div class="sf-funnel-source">収益 <span class="sf-funnel-monthly">月次</span></div>
              <div class="sf-funnel-row"><span>収益（JPY）</span><span>${fmtNum(stages?.value?.revenue?.amount_jpy)}</span></div>
              <div class="sf-funnel-row"><span>数量</span><span>${fmtNum(stages?.value?.revenue?.quantity)}</span></div>
            </div>
          </div>
        </div>

      </div>
    `;
  }

  /**
   * Event Timeline をレンダリングする。
   * @param {object[]} events
   * @returns {string} HTML
   */
  function renderEventTimeline(events) {
    if (!events || events.length === 0) {
      return '<div class="empty-state">イベントが登録されていません</div>';
    }

    const typeLabel = {
      novel_publish:  '小説公開',
      novel_update:   '小説更新',
      music_release:  '音楽リリース',
      sns_post:       'SNS投稿',
      sweets_update:  'SWEETs更新',
      site_update:    'サイト更新',
      campaign_start: 'キャンペーン開始',
      campaign_end:   'キャンペーン終了',
    };

    const rows = events.map(ev => `
      <tr class="sf-funnel-event-row" data-event-id="${ev.id}">
        <td class="sf-col-date">${esc(ev.date)}</td>
        <td>${esc(typeLabel[ev.event_type] || ev.event_type)}</td>
        <td>${esc(ev.platform || '—')}</td>
        <td>${esc(ev.label || '—')}</td>
        <td>
          <button class="sf-btn-small" onclick="loadEventImpact(${ev.id})">前後比較</button>
        </td>
      </tr>
    `).join('');

    return `
      <table class="sf-table">
        <thead>
          <tr>
            <th>日付</th><th>種別</th><th>Platform</th><th>ラベル</th><th>操作</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  /**
   * Event Impact を before/after テーブルでレンダリングする。
   *
   * 表示ルール:
   * - データなし → —
   * - 月次 not_comparable → 「月次データ」
   * - percent_change null → —
   *
   * @param {object|null} data - /api/sf/funnel/event-impact レスポンス
   * @returns {string} HTML
   */
  function renderEventImpact(data) {
    if (!data) return '<div class="empty-state">イベントが見つかりません</div>';

    const { event, event_date, before_period, after_period, note, metrics } = data;

    const fmtVal = (v) => (v == null) ? '—' : v.toLocaleString();
    const fmtChg = (m) => {
      if (m.not_comparable) return '<td colspan="2" class="sf-funnel-monthly-note">月次データ</td>';
      const abs = m.absolute_change != null ? `${m.absolute_change > 0 ? '+' : ''}${m.absolute_change.toLocaleString()}` : '—';
      const pct = m.percent_change  != null ? `${m.percent_change > 0 ? '+' : ''}${m.percent_change}%` : '—';
      return `<td>${abs}</td><td>${pct}</td>`;
    };

    const rows = (metrics || []).map(m => `
      <tr>
        <td class="sf-col-dim">${esc(m.source)}</td>
        <td>${esc(m.metric)}</td>
        <td>${fmtVal(m.before_value)}</td>
        <td>${fmtVal(m.after_value)}</td>
        ${fmtChg(m)}
      </tr>
    `).join('');

    return `
      <div class="sf-funnel-impact-header">
        <span class="sf-funnel-event-label">${esc(event?.label || event?.event_type || '—')}</span>
        <span class="sf-funnel-event-date">${esc(event_date)}</span>
      </div>
      <div class="sf-funnel-periods">
        <span>前: ${esc(before_period?.from)} 〜 ${esc(before_period?.to)}（${before_period?.days}日間）</span>
        <span>後: ${esc(after_period?.from)} 〜 ${esc(after_period?.to)}（${after_period?.days}日間）</span>
      </div>
      <div class="sf-funnel-note">${esc(note || '')}</div>
      <table class="sf-table">
        <thead>
          <tr>
            <th>Source</th><th>指標</th>
            <th>前${before_period?.days}日</th><th>後${after_period?.days}日</th>
            <th>変化</th><th>変化率</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  /** Event Impact を読み込む（イベント選択時に呼ばれる）。 */
  async function loadEventImpact(eventId) {
    const impactEl = document.getElementById('sf-funnel-impact-container');
    if (!impactEl) return;
    impactEl.innerHTML = '<div class="loading">読み込み中...</div>';
    try {
      const res  = await fetch(`/api/sf/funnel/event-impact?event_id=${eventId}`).then(r => r.json());
      impactEl.innerHTML = renderEventImpact(res.ok ? res : null);
    } catch (e) {
      impactEl.innerHTML = `<div class="empty-state">エラー: ${esc(e.message)}</div>`;
    }
  }

  // グローバル公開（onclick から呼ばれる）
  if (typeof window !== 'undefined') window.loadEventImpact = loadEventImpact;

  // ─── Sync / Ops（Phase 10 / Phase 31 改修）──────────────────────────────

  async function loadSync() {
    setState('analyzing');
    const bannerEl = document.getElementById('sf-sync-attention-banner');
    const autoEl   = document.getElementById('sf-sync-auto-container');
    const manualEl = document.getElementById('sf-sync-manual-container');
    const runBtn   = document.getElementById('sf-sync-run-btn');

    try {
      const [statusRes, attentionRes] = await Promise.all([
        fetch('/api/sf/sync/status'),
        fetch('/api/sf/sync/attention?all=1'),
      ]);
      const statusData    = await statusRes.json();
      const attentionData = await attentionRes.json();

      const allSources = statusData.sources ?? [];

      renderSyncSummaryBanner(bannerEl, allSources, attentionData.items ?? []);

      const autoSources   = allSources.filter(s => s.mode === 'auto');
      const manualSources = allSources.filter(s => s.mode === 'manual');
      renderSyncSourcesSection(autoEl,   autoSources,   'AUTO');
      renderSyncSourcesSection(manualEl, manualSources, 'MANUAL');

      // 要確認件数: enabled AUTO source の error/unconfigured/never_synced/stale
      const attentionCount = allSources.filter(s =>
        s.enabled !== 0 &&
        s.mode === 'auto' &&
        ['error', 'unconfigured', 'never_synced', 'stale'].includes(s.status)
      ).length;
      if (attentionCount > 0) setState('notice');
      else setState('completed');
    } catch (e) {
      if (bannerEl) bannerEl.innerHTML = `<div class="error-state">読み込みエラー: ${esc(e.message)}</div>`;
      setState('notice');
    }

    if (runBtn) {
      runBtn.onclick = async () => {
        runBtn.disabled = true;
        runBtn.textContent = '同期中...';
        setState('working');
        try {
          await fetch('/api/sf/sync/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
        } catch (_) {}
        finally {
          runBtn.disabled = false;
          runBtn.textContent = '今すぐ同期';
          loadSync();
        }
      };
    }
  }

  /** 上部サマリーバナー（要確認 / 更新待ち / 未取込の3ライン）*/
  function renderSyncSummaryBanner(el, allSources, attentionItems) {
    if (!el) return;

    // 要確認: enabled AUTO source の error/unconfigured/never_synced/stale
    const attentionCount = allSources.filter(s =>
      s.enabled !== 0 &&
      s.mode === 'auto' &&
      ['error', 'unconfigured', 'never_synced', 'stale'].includes(s.status)
    ).length;

    // 更新待ち: enabled MANUAL source の stale
    const waitingCount = allSources.filter(s =>
      s.enabled !== 0 &&
      s.mode === 'manual' &&
      s.status === 'stale'
    ).length;

    // 未取込: enabled MANUAL source の manual_required
    const pendingCount = allSources.filter(s =>
      s.enabled !== 0 &&
      s.mode === 'manual' &&
      s.status === 'manual_required'
    ).length;

    const lines = [];
    if (attentionCount > 0) {
      lines.push(`<div class="sync-summary-line sync-summary-error">要確認 ${attentionCount} 件 — AUTO取得に問題があるソースがあります</div>`);
    } else {
      lines.push(`<div class="sync-summary-line sync-summary-ok">要確認なし — AUTO取得ソースは正常です</div>`);
    }
    if (waitingCount > 0) {
      lines.push(`<div class="sync-summary-line sync-summary-waiting">更新待ち ${waitingCount} 件 — 手動取込が必要なソースがあります</div>`);
    }
    if (pendingCount > 0) {
      lines.push(`<div class="sync-summary-line sync-summary-pending">未取込 ${pendingCount} 件 — データがまだ取り込まれていないソースがあります</div>`);
    }

    el.innerHTML = `<div class="sf-sync-summary-banner">${lines.join('')}</div>`;
  }

  /** AUTO / MANUAL セクションのソース一覧をレンダリング */
  function renderSyncSourcesSection(el, sources, sectionMode) {
    if (!el) return;
    if (sources.length === 0) { el.innerHTML = ''; return; }

    const enabled  = sources.filter(s => s.enabled !== 0);
    const disabled = sources.filter(s => s.enabled === 0);

    const renderRow = (s) => {
      const isDisabled = s.enabled === 0;
      const dotCls = isDisabled ? 'sync-dot-disabled'
        : s.status === 'fresh'                            ? 'sync-dot-fresh'
        : s.status === 'stale'                            ? 'sync-dot-stale'
        : s.status === 'manual_required'                  ? 'sync-dot-pending'
        : ['error','unconfigured','never_synced'].includes(s.status) ? 'sync-dot-error'
        : 'sync-dot-disabled';

      const stateLabel = isDisabled ? '未使用'
        : sectionMode === 'AUTO'
          ? (s.status === 'fresh'       ? '最新'
          : s.status === 'stale'        ? '更新待ち'
          : s.status === 'error'        ? 'エラー'
          : s.status === 'unconfigured' ? '設定が必要'
          : '未取得')
          : (s.status === 'fresh'           ? '最新'
          : s.status === 'stale'            ? '更新待ち'
          : s.status === 'manual_required'  ? '未取込'
          : '未取得');

      const stateCls = isDisabled ? 'sync-label-disabled'
        : (stateLabel === '最新')    ? 'sync-label-fresh'
        : (stateLabel === '更新待ち') ? 'sync-label-stale'
        : (stateLabel === '未取込')   ? 'sync-label-pending'
        : (stateLabel === 'エラー' || stateLabel === '設定が必要' || stateLabel === '未取得') ? 'sync-label-error'
        : '';

      const lastDate   = s.last_data_date ?? '—';
      // segmented toggle: 「利用中」と「未使用」の2択ピル
      const toggleStateCls = isDisabled ? 'state-disabled' : 'state-enabled';
      const segToggle = `
        <div class="sync-seg-toggle ${toggleStateCls}" data-source="${esc(s.source)}">
          <button class="sync-seg-btn${!isDisabled ? ' is-active' : ''}" data-to="0">利用中</button>
          <button class="sync-seg-btn${isDisabled  ? ' is-active' : ''}" data-to="1">未使用</button>
        </div>`;

      return `<div class="sync-source-row${isDisabled ? ' sync-row-disabled' : ''}">
        <span class="sync-status-dot ${dotCls}"></span>
        <span class="sync-source-name">${esc(s.label)}</span>
        <span class="sync-last-date">${esc(lastDate)}</span>
        <span class="sync-state-label ${stateCls}">${stateLabel}</span>
        ${segToggle}
      </div>`;
    };

    let html = '';
    if (enabled.length > 0) {
      html += enabled.map(renderRow).join('');
    }
    if (disabled.length > 0) {
      html += `<div class="sync-section-label sync-section-unused">未使用</div>`;
      html += disabled.map(renderRow).join('');
    }

    el.innerHTML = html;

    // segmented toggle のイベント登録
    el.querySelectorAll('.sync-seg-toggle').forEach(toggle => {
      toggle.querySelectorAll('.sync-seg-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          if (btn.classList.contains('is-active')) return; // 現在の状態はno-op
          const sourceKey  = toggle.dataset.source;
          const newEnabled = parseInt(btn.dataset.to, 10) === 0; // 0=利用中, 1=未使用
          toggle.classList.add('is-loading');
          try {
            await fetch(`/api/sf/sync/sources/${encodeURIComponent(sourceKey)}/enabled`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ enabled: newEnabled }),
            });
            loadSync();
          } catch (_) {
            toggle.classList.remove('is-loading');
          }
        });
      });
    });
  }

  // 旧 renderSyncAttentionBanner / renderSyncSources はエイリアスとして残す（export互換）
  function renderSyncAttentionBanner(el, items) {
    renderSyncSummaryBanner(el, [], items);
  }
  function renderSyncSources(el, sources) {
    renderSyncSourcesSection(el, sources, 'AUTO');
  }

  // グローバル公開
  if (typeof window !== 'undefined') window.loadSync = loadSync;

  // ─── ユーティリティ ───────────────────────────────────────────────────────

  /** HTML エスケープ */
  function esc(str) {
    if (str == null) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ─── HP Analytics（Phase 15）─────────────────────────────────────────────

  /** Phase 11 計測イベントのうち HP Analytics タブで表示するもの */
  const HP_KEY_EVENTS = [
    { name: 'click_instagram', label: 'Instagram遷移',              stage: 'DISCOVERY' },
    { name: 'click_youtube',   label: 'YouTube遷移',                stage: 'DISCOVERY' },
    { name: 'click_x',        label: 'X（旧Twitter）遷移',          stage: 'DISCOVERY' },
    { name: 'nav_sweets',     label: 'SWEETsページ遷移',            stage: 'ENGAGEMENT' },
    { name: 'sweets_unlock',  label: 'SWEETsゲート解錠',            stage: 'ENGAGEMENT' },
    { name: 'click_music',    label: '音楽配信リンク（Apple Music・Amazon Music等）', stage: 'ENGAGEMENT' },
    { name: 'click_spotify',  label: 'Spotifyリンク',               stage: 'ENGAGEMENT' },
    { name: 'nav_hayatecchi', label: 'ゲームLPへ遷移',              stage: 'ENGAGEMENT' },
    { name: 'music_play',     label: '音源再生開始',                stage: 'DEEP_INTEREST' },
    { name: 'music_play_30s', label: '30秒再生通過',                stage: 'DEEP_INTEREST' },
    { name: 'click_story',    label: '小説・なろうリンク',           stage: 'DEEP_INTEREST' },
    { name: 'click_kindle',   label: 'Kindle/Amazon電子書籍',       stage: 'VALUE' },
  ];

  /** stage 名 → CSS クラスサフィックス */
  function stageCls(stage) {
    const map = {
      DISCOVERY:     'discovery',
      ENGAGEMENT:    'engagement',
      DEEP_INTEREST: 'deep-interest',
      VALUE:         'value',
    };
    return map[stage] || 'discovery';
  }

  /** 増減バッジ HTML（前期間比） */
  function hpDiffBadge(curr, prev) {
    if (prev == null || prev === 0) return '';
    const diff = curr - prev;
    const pct  = Math.round((diff / prev) * 100);
    const sign = diff >= 0 ? '+' : '';
    const cls  = diff > 0 ? 'green' : (diff < 0 ? 'red' : '');
    return `<span class="hp-diff ${cls}">${sign}${pct}%</span>`;
  }

  /** サイト概要カード */
  function renderHpOverview(res) {
    if (!res || !res.ok) {
      return '<div class="empty-state">概要データを取得できませんでした</div>';
    }
    if (!res.has_data) {
      return `
        <div class="empty-state">
          データ未取得（GA4同期が必要です）<br>
          <span style="font-size:11px;color:var(--text-dim)">${esc(res.period?.from || '')} 〜 ${esc(res.period?.to || '')}</span>
        </div>
      `;
    }
    const c = res.current;
    const p = res.previous;
    const metrics = [
      { label: 'Page Views',      key: 'page_views' },
      { label: 'Users',           key: 'users' },
      { label: 'Sessions',        key: 'sessions' },
      { label: 'Engaged Sessions',key: 'engaged_sessions' },
    ];
    const cardsHtml = metrics.map(m => `
      <div class="hp-stat-card">
        <div class="hp-stat-label">${esc(m.label)}</div>
        <div class="hp-stat-value">${Number(c[m.key]).toLocaleString()}</div>
        ${res.has_previous_data && p ? hpDiffBadge(c[m.key], p[m.key]) : ''}
      </div>
    `).join('');
    const periodLabel = `${esc(res.period.from)} 〜 ${esc(res.period.to)}（${res.days}日間）`;
    const prevLabel   = res.has_previous_data
      ? `<div class="hp-compare-note">前期間比: ${esc(res.previous_period.from)} 〜 ${esc(res.previous_period.to)}</div>`
      : '';
    return `
      <div class="hp-period-label">${periodLabel}</div>
      <div class="hp-stat-cards">${cardsHtml}</div>
      ${prevLabel}
    `;
  }

  /** 人気ページテーブル */
  function renderHpPages(res) {
    if (!res || !res.ok || !res.rows || res.rows.length === 0) {
      return '<div class="empty-state">ページデータ未取得（GA4同期が必要です）</div>';
    }
    const rows = res.rows.slice(0, 20).map(r => `
      <tr>
        <td class="hp-col-path">${esc(r.page_path)}</td>
        <td class="hp-col-num">${Number(r.page_views).toLocaleString()}</td>
        <td class="hp-col-num">${Number(r.users).toLocaleString()}</td>
        <td class="hp-col-num">${Number(r.sessions).toLocaleString()}</td>
      </tr>
    `).join('');
    return `
      <table class="sf-table">
        <thead>
          <tr>
            <th>ページ</th>
            <th class="hp-col-num">PV</th>
            <th class="hp-col-num">ユーザー</th>
            <th class="hp-col-num">セッション</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  /** 日別推移テーブル（ミニバーチャート付き） */
  function renderHpDaily(res) {
    if (!res || !res.ok || !res.rows || res.rows.length === 0) {
      return '<div class="empty-state">日別データ未取得（GA4同期が必要です）</div>';
    }
    const maxPv = Math.max(...res.rows.map(r => Number(r.page_views) || 0), 1);
    const rows = res.rows.map(r => {
      const pv       = Number(r.page_views) || 0;
      const users    = Number(r.users) || 0;
      const barWidth = Math.max(Math.round((pv / maxPv) * 100), 1);
      return `
        <tr>
          <td class="hp-col-date">${esc(r.date)}</td>
          <td class="hp-col-num">${pv.toLocaleString()}</td>
          <td class="hp-col-num">${users.toLocaleString()}</td>
          <td class="hp-bar-cell">
            <div class="hp-bar-wrap">
              <div class="hp-bar" style="width:${barWidth}%"></div>
            </div>
          </td>
        </tr>
      `;
    }).join('');
    return `
      <table class="sf-table">
        <thead>
          <tr>
            <th class="hp-col-date">日付</th>
            <th class="hp-col-num">PV</th>
            <th class="hp-col-num">ユーザー</th>
            <th>推移（PV）</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  /**
   * サイトイベント一覧。
   * gaHasData=true の場合、件数0はイベント未発生（0件）。
   * gaHasData=false の場合、未取得（GA4未同期）。
   */
  function renderHpEvents(eventsRes, gaHasData) {
    if (!eventsRes || !eventsRes.ok) {
      return '<div class="empty-state">イベントデータを取得できませんでした</div>';
    }

    // event_name 別に集計
    const counts = {};
    for (const r of (eventsRes.rows || [])) {
      counts[r.event_name] = (counts[r.event_name] || 0) + Number(r.count || 0);
    }
    const hasEventRows = (eventsRes.rows || []).length > 0;

    let note = '';
    if (!gaHasData && !hasEventRows) {
      note = '<div class="hp-events-note">GA4同期が必要です（データ未取得。0ではありません）。</div>';
    }

    const rows = HP_KEY_EVENTS.map(ev => {
      let countHtml;
      if (!gaHasData && !hasEventRows) {
        countHtml = '<span class="hp-not-fetched">未取得</span>';
      } else {
        countHtml = (counts[ev.name] || 0).toLocaleString();
      }
      return `
        <tr>
          <td><span class="hp-stage-badge hp-stage-${stageCls(ev.stage)}">${esc(ev.stage)}</span></td>
          <td class="sf-col-title">${esc(ev.name)}</td>
          <td>${esc(ev.label)}</td>
          <td class="hp-col-num">${countHtml}</td>
        </tr>
      `;
    }).join('');
    return `
      ${note}
      <table class="sf-table">
        <thead>
          <tr>
            <th>Stage</th>
            <th>イベント名</th>
            <th>説明</th>
            <th class="hp-col-num">30日合計</th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    `;
  }

  /** Music 導線（再生→配信サービス移動）*/
  function renderHpMusicFunnel(eventsRes, gaHasData) {
    if (!eventsRes || !eventsRes.ok) {
      return '<div class="empty-state">イベントデータを取得できませんでした</div>';
    }
    const counts = {};
    for (const r of (eventsRes.rows || [])) {
      counts[r.event_name] = (counts[r.event_name] || 0) + Number(r.count || 0);
    }
    const hasEventRows = (eventsRes.rows || []).length > 0;
    const synced = gaHasData || hasEventRows;

    function countOf(name) {
      if (!synced) return '<span class="hp-not-fetched">未取得</span>';
      return (counts[name] || 0).toLocaleString();
    }

    const funnel = [
      { icon: '▶', name: 'music_play',     label: '音源再生開始',             note: '' },
      { icon: '⏱', name: 'music_play_30s', label: '30秒再生通過',             note: '' },
      { icon: '→', name: 'click_music',    label: '音楽配信リンク（全体）',   note: '（Apple Music / Amazon Music / Suno 等）' },
      { icon: '→', name: 'click_spotify',  label: 'Spotifyリンク（個別）',    note: '' },
      { icon: '🎮', name: 'nav_hayatecchi', label: 'ゲームLPへ遷移',           note: '' },
    ];

    const rows = funnel.map(f => `
      <div class="hp-funnel-row">
        <span class="hp-funnel-icon">${f.icon}</span>
        <span class="hp-funnel-label">
          ${esc(f.label)}
          ${f.note ? `<span class="hp-funnel-note-inline">${esc(f.note)}</span>` : ''}
        </span>
        <code class="hp-funnel-event">${esc(f.name)}</code>
        <span class="hp-funnel-count">${countOf(f.name)}</span>
      </div>
    `).join('');

    return `
      <div class="hp-music-funnel">${rows}</div>
      <div class="hp-music-note">
        ※ click_music / click_spotify のパラメータ（destination）は現在 DB に集計されていないため、
        サービス別（Apple Music / Amazon Music / YouTube Music 個別）の内訳は未取得です。<br>
        ※ 上記は単純件数集計であり、同一ユーザーのコンバージョンパスを示すものではありません。
      </div>
    `;
  }

  /** 流入元（sessionSource / sessionMedium 別） */
  function renderHpSources(data) {
    if (!data || !data.rows || data.rows.length === 0) {
      return `<div class="empty-state">流入元データなし</div>`;
    }

    const SOURCE_LABELS = {
      '(direct)': 'Direct',
      'google':   'Google',
      'instagram.com': 'Instagram',
      'twitter.com':   'Twitter',
      'l.instagram.com': 'Instagram (l)',
      't.co': 'Twitter (t.co)',
    };

    const rows = data.rows.slice(0, 15).map(r => {
      const srcLabel = SOURCE_LABELS[r.session_source] ?? esc(r.session_source);
      const medLabel = esc(r.session_medium);
      return `
        <tr>
          <td>${srcLabel}</td>
          <td><span style="color:var(--text-muted);font-size:.85em;">${medLabel}</span></td>
          <td style="text-align:right;">${(r.sessions ?? 0).toLocaleString()}</td>
          <td style="text-align:right;">${(r.users ?? 0).toLocaleString()}</td>
          <td style="text-align:right;">${(r.page_views ?? 0).toLocaleString()}</td>
        </tr>`;
    }).join('');

    return `
      <div style="overflow-x:auto;">
        <table class="sf-table" style="width:100%;font-size:.9em;">
          <thead>
            <tr>
              <th style="text-align:left;">Source</th>
              <th style="text-align:left;">Medium</th>
              <th style="text-align:right;">Sessions</th>
              <th style="text-align:right;">Users</th>
              <th style="text-align:right;">PV</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        <p style="margin:.5rem 0 0;font-size:.78em;color:var(--text-muted);">
          期間: ${esc(data.from)} 〜 ${esc(data.to)}（上位15件）
        </p>
      </div>`;
  }

  /** HP Analytics タブのデータをすべて読み込む */
  async function loadHpAnalytics() {
    const overviewEl = document.getElementById('hp-overview-container');
    const pagesEl    = document.getElementById('hp-pages-container');
    const dailyEl    = document.getElementById('hp-daily-container');
    const eventsEl   = document.getElementById('hp-events-container');
    const musicEl    = document.getElementById('hp-music-container');
    const sourcesEl  = document.getElementById('hp-sources-container');

    if (!overviewEl) return;

    let overviewRes, pagesRes, dailyRes, eventsRes, sourcesRes;
    try {
      [overviewRes, pagesRes, dailyRes, eventsRes, sourcesRes] = await Promise.all([
        fetch('/api/sf/ga/overview?days=30').then(r => r.json()),
        fetch('/api/sf/ga/pages').then(r => r.json()),
        fetch('/api/sf/ga/daily').then(r => r.json()),
        fetch('/api/sf/ga/events').then(r => r.json()),
        fetch('/api/sf/ga/sources').then(r => r.json()),
      ]);
    } catch (e) {
      if (overviewEl) overviewEl.innerHTML =
        `<div class="empty-state">データ取得エラー: ${esc(e.message)}</div>`;
      return;
    }

    const gaHasData = overviewRes?.has_data === true;

    if (overviewEl) overviewEl.innerHTML = renderHpOverview(overviewRes);
    if (pagesEl)    pagesEl.innerHTML    = renderHpPages(pagesRes);
    if (dailyEl)    dailyEl.innerHTML    = renderHpDaily(dailyRes);
    if (eventsEl)   eventsEl.innerHTML   = renderHpEvents(eventsRes, gaHasData);
    if (musicEl)    musicEl.innerHTML    = renderHpMusicFunnel(eventsRes, gaHasData);
    if (sourcesEl)  sourcesEl.innerHTML  = renderHpSources(sourcesRes);
  }

  // ─── Soundrop Stats ───────────────────────────────────────────────────────

  /** パイチャート用カラーパレット */
  const PIE_COLORS = [
    '#58a6ff', '#3fb950', '#d29922', '#f85149', '#a371f7',
    '#79c0ff', '#56d364', '#e3b341', '#ffa198', '#cae8ff',
  ];

  /** Platform 表示名マップ */
  const PLATFORM_LABELS = {
    spotify:      'Spotify',
    apple_music:  'Apple Music',
    amazon_music: 'Amazon Music',
    youtube_music:'YouTube Music',
    other:        'Other',
  };

  /**
   * SVG パイチャートを生成する。
   * @param {Array<{label:string, value:number, pct:number}>} slices
   * @param {number} size - SVG の幅・高さ（px）
   */
  function renderPieChart(slices, size = 140) {
    if (!slices || slices.length === 0) return '<div class="empty-state">データなし</div>';
    const total = slices.reduce((s, x) => s + x.value, 0);
    if (total <= 0) return '<div class="empty-state">収益データなし</div>';

    const cx = size / 2, cy = size / 2, r = size / 2 - 4;
    let startAngle = -Math.PI / 2;
    const paths = [];

    slices.forEach((s, i) => {
      const angle = (s.value / total) * 2 * Math.PI;
      const endAngle = startAngle + angle;
      const largeArc = angle > Math.PI ? 1 : 0;
      const x1 = cx + r * Math.cos(startAngle);
      const y1 = cy + r * Math.sin(startAngle);
      const x2 = cx + r * Math.cos(endAngle);
      const y2 = cy + r * Math.sin(endAngle);
      const color = PIE_COLORS[i % PIE_COLORS.length];

      if (slices.length === 1) {
        // 円全体
        paths.push(`<circle cx="${cx}" cy="${cy}" r="${r}" fill="${color}" />`);
      } else {
        paths.push(
          `<path d="M${cx},${cy} L${x1.toFixed(2)},${y1.toFixed(2)} A${r},${r} 0 ${largeArc},1 ${x2.toFixed(2)},${y2.toFixed(2)} Z" fill="${color}" />`
        );
      }
      startAngle = endAngle;
    });

    return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" class="sd-pie-svg">${paths.join('')}</svg>`;
  }

  /** Services パイチャート + 凡例 */
  function renderSdServices(rows) {
    if (!rows || rows.length === 0) return '<div class="empty-state">データなし</div>';
    const slices = rows.map(r => ({
      label: PLATFORM_LABELS[r.platform] || r.platform,
      value: r.total_usd,
      pct:   r.pct,
    }));
    const legend = rows.map((r, i) => {
      const color = PIE_COLORS[i % PIE_COLORS.length];
      const label = PLATFORM_LABELS[r.platform] || r.platform;
      return `
        <div class="sd-legend-row">
          <div class="sd-legend-dot" style="background:${color}"></div>
          <div class="sd-legend-name" title="${esc(label)}">${esc(label)}</div>
          <div class="sd-legend-pct">${r.pct.toFixed(1)}%</div>
          <div class="sd-legend-usd">$${(r.total_usd || 0).toFixed(4)}</div>
        </div>
      `;
    }).join('');
    return `
      <div class="sd-pie-wrap">
        ${renderPieChart(slices)}
        <div class="sd-pie-legend">${legend}</div>
      </div>
    `;
  }

  /** Channels パイチャート + 凡例 */
  function renderSdChannels(rows) {
    if (!rows || rows.length === 0) return '<div class="empty-state">データなし</div>';
    const slices = rows.map(r => ({
      label: r.channel || 'Unknown',
      value: r.total_usd,
      pct:   r.pct,
    }));
    const legend = rows.map((r, i) => {
      const color = PIE_COLORS[i % PIE_COLORS.length];
      const label = r.channel || 'Unknown';
      return `
        <div class="sd-legend-row">
          <div class="sd-legend-dot" style="background:${color}"></div>
          <div class="sd-legend-name" title="${esc(label)}">${esc(label)}</div>
          <div class="sd-legend-pct">${r.pct.toFixed(1)}%</div>
          <div class="sd-legend-usd">$${(r.total_usd || 0).toFixed(4)}</div>
        </div>
      `;
    }).join('');
    return `
      <div class="sd-pie-wrap">
        ${renderPieChart(slices)}
        <div class="sd-pie-legend">${legend}</div>
      </div>
    `;
  }

  /** Tracks / Releases ランキングテーブル */
  function renderSdRanking(rows, titleKey = 'title') {
    if (!rows || rows.length === 0) return '<div class="empty-state">データなし</div>';
    const maxUsd = Math.max(...rows.map(r => r.total_usd || 0), 0.0001);
    const trs = rows.map((r, i) => {
      const barW = Math.max(Math.round(((r.total_usd || 0) / maxUsd) * 100), 1);
      return `
        <tr>
          <td class="sd-rank-num">${i + 1}</td>
          <td class="sd-rank-title">${esc(r[titleKey] || '—')}</td>
          <td class="sd-rank-bar-cell">
            <div class="sd-rank-bar-wrap">
              <div class="sd-rank-bar" style="width:${barW}%"></div>
            </div>
          </td>
          <td class="sd-rank-usd">$${(r.total_usd || 0).toFixed(5)}</td>
          <td class="sd-rank-pct">${(r.pct || 0).toFixed(1)}%</td>
          <td class="sd-rank-qty">${(r.total_quantity || 0).toLocaleString()}</td>
        </tr>
      `;
    }).join('');
    return `
      <table class="sd-ranking">
        <thead>
          <tr>
            <th>#</th>
            <th>タイトル</th>
            <th></th>
            <th>Revenue (USD)</th>
            <th>%</th>
            <th>Units</th>
          </tr>
        </thead>
        <tbody>${trs}</tbody>
      </table>
    `;
  }

  /** 月別推移バーチャート */
  function renderSdMonthly(rows) {
    if (!rows || rows.length === 0) return '<div class="empty-state">データなし</div>';
    const maxUsd = Math.max(...rows.map(r => r.total_usd || 0), 0.0001);
    const bars = rows.map(r => {
      const h = Math.max(Math.round(((r.total_usd || 0) / maxUsd) * 78), 2);
      const label = (r.month || '').slice(2); // YY-MM 表示
      return `
        <div class="sd-bar-col">
          <div class="sd-bar-value">$${(r.total_usd || 0).toFixed(3)}</div>
          <div class="sd-bar-wrap">
            <div class="sd-bar" style="height:${h}px" title="${r.month}: $${(r.total_usd || 0).toFixed(5)} / ${(r.total_quantity || 0).toLocaleString()} units"></div>
          </div>
          <div class="sd-bar-label">${esc(label)}</div>
        </div>
      `;
    }).join('');
    return `<div class="sd-monthly-chart">${bars}</div>`;
  }

  /** Soundrop Stats タブ全体のデータ読み込み */
  async function loadSoundropStats(statement = '') {
    const totalsEl   = document.getElementById('sd-totals-container');
    const monthlyEl  = document.getElementById('sd-monthly-container');
    const servicesEl = document.getElementById('sd-services-container');
    const channelsEl = document.getElementById('sd-channels-container');
    const tracksEl   = document.getElementById('sd-tracks-container');
    const releasesEl = document.getElementById('sd-releases-container');

    [totalsEl, monthlyEl, servicesEl, channelsEl, tracksEl, releasesEl]
      .filter(Boolean).forEach(el => { el.className = 'loading'; el.innerHTML = '読み込み中...'; });

    const qs = statement ? `?statement=${encodeURIComponent(statement)}` : '';
    let res;
    try {
      res = await fetch(`/api/sf/soundrop/stats${qs}`).then(r => r.json());
    } catch (e) {
      if (totalsEl) totalsEl.innerHTML = `<div class="empty-state">取得エラー: ${esc(e.message)}</div>`;
      return;
    }
    if (!res.ok) {
      if (totalsEl) totalsEl.innerHTML = `<div class="empty-state">エラー: ${esc(res.error || '不明')}</div>`;
      return;
    }

    // ステートメント期間セレクト更新
    const sel = document.getElementById('sd-stmt-select');
    if (sel && res.stmtPeriods) {
      const cur = sel.value;
      sel.innerHTML = '<option value="">全期間</option>';
      res.stmtPeriods.forEach(p => {
        const opt = document.createElement('option');
        opt.value = p; opt.textContent = p;
        if (p === cur) opt.selected = true;
        sel.appendChild(opt);
      });
    }

    // totals
    if (totalsEl) {
      totalsEl.className = '';
      totalsEl.innerHTML = `
        <div class="sd-totals-card">
          <div>
            <div class="sd-total-usd">$${(res.totals.total_usd || 0).toFixed(5)}</div>
            <div class="sd-total-label">Net Revenue (USD)</div>
          </div>
          <div>
            <div class="sd-total-units">${(res.totals.total_quantity || 0).toLocaleString()}</div>
            <div class="sd-total-units-label">Total Units</div>
          </div>
        </div>
      `;
    }

    if (monthlyEl)  { monthlyEl.className  = ''; monthlyEl.innerHTML  = renderSdMonthly(res.monthly);   }
    if (servicesEl) { servicesEl.className = ''; servicesEl.innerHTML = renderSdServices(res.services); }
    if (channelsEl) { channelsEl.className = ''; channelsEl.innerHTML = renderSdChannels(res.channels); }
    if (tracksEl)   { tracksEl.className   = ''; tracksEl.innerHTML   = renderSdRanking(res.tracks, 'title');         }
    if (releasesEl) { releasesEl.className = ''; releasesEl.innerHTML = renderSdRanking(res.releases, 'release_title'); }
  }

  /** Soundrop Stats フィルタ初期化 */
  function initSoundropStats() {
    const sel = document.getElementById('sd-stmt-select');
    if (sel && !sel.dataset.initialized) {
      sel.dataset.initialized = '1';
      sel.addEventListener('change', () => loadSoundropStats(sel.value));
    }
    loadSoundropStats(sel?.value || '');
  }

  // ─── Soundrop カタログ同期 ────────────────────────────────────────────────

  /** diff summary から「変更あり / なし」を判定して表示を切り替えるヘルパ */
  function _sdSyncHasChanges(diff) {
    return diff.hasChanges;
  }

  /** diff.releases / tracks の変更詳細を HTML テーブルで返す */
  function _renderSdSyncDiffTable(diff) {
    const rows = [];

    // Releases
    rows.push(`<tr style="color:#94a3b8;font-size:11px"><td colspan="4">── Releases ──</td></tr>`);
    rows.push(`<tr><td>マッチ済み</td><td>${diff.releases.matched}</td><td>-</td><td>変更なし</td></tr>`);
    if (diff.releases.newItems.length > 0) {
      for (const r of diff.releases.newItems) {
        rows.push(`<tr style="color:#34d399"><td>新規</td><td colspan="2">${escHtml(r.name)}</td><td>${r.release_type} / ${r.status}</td></tr>`);
      }
    }
    if (diff.releases.updatedItems.length > 0) {
      for (const r of diff.releases.updatedItems) {
        const chg = r.changes.map(c => `${c.field}: ${c.from ?? 'null'} → ${c.to}`).join(', ');
        rows.push(`<tr style="color:#fbbf24"><td>更新</td><td colspan="2">${escHtml(r.title)}</td><td style="font-size:11px">${escHtml(chg)}</td></tr>`);
      }
    }
    if (diff.releases.skipped > 0)   rows.push(`<tr><td>スキップ</td><td>${diff.releases.skipped}</td><td>-</td><td>ID/UPC なし</td></tr>`);
    if (diff.releases.conflicts > 0) rows.push(`<tr style="color:#f87171"><td>競合</td><td>${diff.releases.conflicts}</td><td>-</td><td>要確認</td></tr>`);

    // Tracks
    rows.push(`<tr style="color:#94a3b8;font-size:11px"><td colspan="4">── Tracks ──</td></tr>`);
    rows.push(`<tr><td>マッチ済み</td><td>${diff.tracks.matched}</td><td>-</td><td>変更なし</td></tr>`);
    if (diff.tracks.newItems.length > 0) {
      for (const t of diff.tracks.newItems) {
        rows.push(`<tr style="color:#34d399"><td>新規</td><td colspan="2">${escHtml(t.name)}</td><td>ISRC: ${t.isrc}</td></tr>`);
      }
    }
    if (diff.tracks.updatedItems.length > 0) {
      for (const t of diff.tracks.updatedItems) {
        const chg = t.changes.map(c => `${c.field}: ${c.from ?? 'null'} → ${c.to}`).join(', ');
        rows.push(`<tr style="color:#fbbf24"><td>更新</td><td colspan="2">${escHtml(t.title)}</td><td style="font-size:11px">${escHtml(chg)}</td></tr>`);
      }
    }
    if (diff.tracks.skipped > 0)   rows.push(`<tr><td>スキップ</td><td>${diff.tracks.skipped}</td><td>-</td><td>ID/ISRC なし</td></tr>`);
    if (diff.tracks.conflicts > 0) rows.push(`<tr style="color:#f87171"><td>競合</td><td>${diff.tracks.conflicts}</td><td>-</td><td>要確認</td></tr>`);

    // Relations
    rows.push(`<tr style="color:#94a3b8;font-size:11px"><td colspan="4">── リレーション (Release↔Track) ──</td></tr>`);
    rows.push(`<tr><td>DB 既存</td><td>${diff.relations.existing}</td><td>-</td><td>-</td></tr>`);
    if (diff.relations.toAdd > 0)         rows.push(`<tr style="color:#34d399"><td>追加予定</td><td>${diff.relations.toAdd}</td><td>-</td><td>-</td></tr>`);
    if (diff.relations.toUpdateOrder > 0) rows.push(`<tr style="color:#fbbf24"><td>順序更新</td><td>${diff.relations.toUpdateOrder}</td><td>-</td><td>-</td></tr>`);

    return `<table class="sf-table" style="width:100%;font-size:13px">
      <thead><tr><th>種別</th><th>件数</th><th>-</th><th>詳細</th></tr></thead>
      <tbody>${rows.join('')}</tbody>
    </table>`;
  }

  function escHtml(s) {
    return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  /**
   * 自動同期ステータスパネルを描画・更新する。
   * #sd-auto-sync-panel が存在する場合のみ実行。
   */
  async function _refreshSdAutoSyncPanel() {
    const panel = document.getElementById('sd-auto-sync-panel');
    if (!panel) return;
    try {
      const res  = await fetch('/api/sf/soundrop-sync/token-status');
      const data = await res.json();

      const tokenBadge = data.tokenConfigured
        ? '<span style="color:#34d399">● 設定済み</span>'
        : '<span style="color:#94a3b8">○ 未設定（手動のみ有効）</span>';

      let lastSyncText = '未同期';
      if (data.lastSuccessAt) {
        const d = new Date(data.lastSuccessAt);
        const fmt = `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
        const h   = data.hoursAgo != null ? `（${Math.round(data.hoursAgo)}時間前）` : '';
        lastSyncText = fmt + h;
      }

      const statusColors = { fresh: '#34d399', error: '#f87171', unconfigured: '#94a3b8', never_synced: '#94a3b8' };
      const statusColor  = statusColors[data.status] ?? '#94a3b8';

      const errorLine = (data.status === 'error' || data.needsToken)
        ? `<p style="color:#f87171;font-size:12px;margin:4px 0 0">${escHtml(data.lastError ?? 'Soundrop接続情報の更新が必要です')}</p>`
        : '';

      panel.innerHTML = `
        <div style="padding:14px 16px;background:#1e293b;border-radius:8px;border:1px solid #334155;margin-bottom:16px">
          <p style="font-size:13px;font-weight:600;color:#cbd5e1;margin:0 0 8px">自動同期ステータス</p>
          <table style="font-size:12px;color:#94a3b8;border-collapse:collapse">
            <tr><td style="padding:2px 12px 2px 0">トークン</td><td>${tokenBadge}</td></tr>
            <tr><td style="padding:2px 12px 2px 0">最終API同期</td><td style="color:#e2e8f0">${escHtml(lastSyncText)}</td></tr>
            <tr><td style="padding:2px 12px 2px 0">ステータス</td><td style="color:${statusColor}">${escHtml(data.status)}</td></tr>
          </table>
          ${errorLine}
          <div style="margin-top:10px">
            <button id="sd-force-sync-btn"
                    style="padding:6px 16px;background:#3b82f6;color:#fff;border:none;
                           border-radius:5px;cursor:pointer;font-size:12px;font-weight:600">
              今すぐ同期
            </button>
            <span id="sd-force-sync-msg" style="font-size:12px;color:#94a3b8;margin-left:10px"></span>
          </div>
        </div>`;

      // 「今すぐ同期」ハンドラ
      document.getElementById('sd-force-sync-btn')?.addEventListener('click', async () => {
        const btn = document.getElementById('sd-force-sync-btn');
        const msg = document.getElementById('sd-force-sync-msg');
        btn.disabled    = true;
        btn.textContent = '同期中...';
        if (msg) msg.textContent = '';
        try {
          const r    = await fetch('/api/sf/soundrop-sync/auto', {
            method:  'POST',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ force: true }),
          });
          const d = await r.json();
          if (d.needsToken) {
            if (msg) msg.textContent = 'Soundrop接続情報の更新が必要です';
            if (msg) msg.style.color = '#f87171';
          } else if (!d.ok) {
            if (msg) msg.textContent = d.error ?? '同期エラー';
            if (msg) msg.style.color = '#f87171';
          } else {
            const s = d.stats;
            if (msg) msg.textContent = s
              ? `完了 (R+${s.releasesInserted} T+${s.tracksInserted} Rel+${s.relationsAdded})`
              : '完了';
            if (msg) msg.style.color = '#34d399';
          }
        } catch (_e) {
          if (msg) { msg.textContent = '通信エラー'; msg.style.color = '#f87171'; }
        } finally {
          btn.disabled    = false;
          btn.textContent = '今すぐ同期';
          _refreshSdAutoSyncPanel();
        }
      });
    } catch (_e) {
      panel.innerHTML = '<p style="color:#64748b;font-size:12px">同期状態の取得に失敗しました</p>';
    }
  }

  /**
   * Soundrop 同期タブ — メイン関数
   * 初回タブ開時・タブ再選択時に呼ばれる。
   * DB 書き込みは「同期する」ボタン押下時のみ。
   */
  async function loadSoundropSync() {
    const urlInput  = document.getElementById('soundrop-request-url');
    const checkBtn  = document.getElementById('soundrop-check-btn');
    const resultDiv = document.getElementById('soundrop-sync-result');
    if (!checkBtn) return;

    // ステータスパネルを初期描画（毎回更新）
    _refreshSdAutoSyncPanel();

    // 二重初期化防止
    if (checkBtn.dataset.sdSyncInit === '1') return;
    checkBtn.dataset.sdSyncInit = '1';

    checkBtn.addEventListener('click', async () => {
      const requestUrl = urlInput.value.trim();
      if (!requestUrl) {
        resultDiv.innerHTML = '<p style="color:#f87171;font-size:13px">Request URL を入力してください。</p>';
        return;
      }

      // 差分取得中
      checkBtn.disabled = true;
      checkBtn.textContent = '取得中...';
      resultDiv.innerHTML = '<p style="color:#94a3b8;font-size:13px">⏳ Soundrop に接続して差分を取得しています（数秒かかります）...</p>';

      try {
        const res  = await fetch('/api/sf/soundrop-sync/diff', {
          method:  'POST',
          headers: { 'Content-Type': 'application/json' },
          body:    JSON.stringify({ requestUrl }),
        });
        const data = await res.json();

        if (!data.ok) {
          resultDiv.innerHTML = `<p style="color:#f87171;font-size:13px">⚠ ${escHtml(data.error || 'エラーが発生しました')}</p>`;
          checkBtn.disabled = false;
          checkBtn.textContent = '差分を確認';
          return;
        }

        const diff = data.diff;
        const hasChanges = _sdSyncHasChanges(diff);

        // 結果表示
        let html = '';
        if (!hasChanges) {
          html = `<div style="padding:16px;background:#1e293b;border-radius:8px;border:1px solid #334155">
            <p style="color:#34d399;font-size:14px;font-weight:600;margin:0">
              ✔ SoundropとJARVISは同期済みです
            </p>
            <p style="color:#64748b;font-size:12px;margin:6px 0 0">
              Release: ${diff.releases.matched}件一致 / Track: ${diff.tracks.matched}件一致
            </p>
          </div>`;
        } else {
          html = `<div style="margin-bottom:12px">
            <p style="color:#fbbf24;font-size:13px;font-weight:600;margin:0 0 8px">
              差分が見つかりました — 内容を確認してください
            </p>
            ${_renderSdSyncDiffTable(diff)}
          </div>
          <div style="margin-top:12px">
            <button id="soundrop-apply-btn"
                    style="padding:10px 24px;background:#ef4444;color:#fff;border:none;
                           border-radius:6px;cursor:pointer;font-size:14px;font-weight:600">
              同期する
            </button>
            <span style="font-size:12px;color:#64748b;margin-left:12px">
              ※ このボタンを押すと実 DB が更新されます
            </span>
          </div>`;
        }
        resultDiv.innerHTML = html;
        checkBtn.disabled = false;
        checkBtn.textContent = '差分を再確認';

        // 「同期する」ボタンのハンドラ
        const applyBtn = document.getElementById('soundrop-apply-btn');
        if (applyBtn) {
          applyBtn.addEventListener('click', async () => {
            if (!confirm('Soundrop の差分を JARVIS DB に適用しますか？')) return;

            applyBtn.disabled = true;
            applyBtn.textContent = '同期中...';
            resultDiv.querySelector('span')?.remove();

            try {
              const applyRes  = await fetch('/api/sf/soundrop-sync/apply', {
                method:  'POST',
                headers: { 'Content-Type': 'application/json' },
                body:    JSON.stringify({ requestUrl }),
              });
              const applyData = await applyRes.json();

              if (!applyData.ok) {
                resultDiv.insertAdjacentHTML('beforeend',
                  `<p style="color:#f87171;font-size:13px;margin-top:8px">⚠ ${escHtml(applyData.error || '同期エラー')}</p>`);
                applyBtn.disabled = false;
                applyBtn.textContent = '同期する';
                return;
              }

              const s = applyData.stats;
              resultDiv.innerHTML = `<div style="padding:16px;background:#1e293b;border-radius:8px;border:1px solid #334155">
                <p style="color:#34d399;font-size:14px;font-weight:600;margin:0 0 8px">✔ 同期完了</p>
                <table style="font-size:12px;color:#94a3b8;border-collapse:collapse">
                  <tr><td style="padding:2px 12px 2px 0">リリース更新</td><td>${s.releasesUpdated}件</td></tr>
                  <tr><td style="padding:2px 12px 2px 0">リリース新規</td><td>${s.releasesInserted}件</td></tr>
                  <tr><td style="padding:2px 12px 2px 0">トラック更新</td><td>${s.tracksUpdated}件</td></tr>
                  <tr><td style="padding:2px 12px 2px 0">トラック新規</td><td>${s.tracksInserted}件</td></tr>
                  <tr><td style="padding:2px 12px 2px 0">リレーション追加</td><td>${s.relationsAdded}件</td></tr>
                  <tr><td style="padding:2px 12px 2px 0">順序更新</td><td>${s.relationsOrderUpdated}件</td></tr>
                </table>
              </div>`;
            } catch (_e) {
              resultDiv.insertAdjacentHTML('beforeend',
                '<p style="color:#f87171;font-size:13px;margin-top:8px">⚠ 通信エラー</p>');
              applyBtn.disabled = false;
              applyBtn.textContent = '同期する';
            }
          });
        }

      } catch (_e) {
        resultDiv.innerHTML = '<p style="color:#f87171;font-size:13px">⚠ 通信エラー。ネットワーク接続を確認してください。</p>';
        checkBtn.disabled = false;
        checkBtn.textContent = '差分を確認';
      }
    });
  }

  // ─── 作品管理 (Phase 28) ─────────────────────────────────────────────────

  /** 作品タイプラベル */
  const WORK_TYPE_LABELS = {
    novel:        '長編小説',
    short_story:  '短編小説',
    short_series: '短編連作',
    game:         'ゲーム',
    other:        'その他',
  };

  /** 公開ステータスラベル */
  const PUB_STATUS_LABELS = {
    published:   '公開中',
    unpublished: '未公開',
    private:     '非公開',
    deleted:     '削除済',
  };

  /** アーカイブ種別ラベル */
  const ARCHIVE_TYPE_LABELS = {
    submission:     '投稿用',
    publication:    '公開版',
    revision:       '改稿',
    literary_award: '文学賞',
    direct_input:   '直接入力',
    backup:         'バックアップ',
    other:          'その他',
  };

  let _worksLoaded = false;
  let _allWorks    = [];     // API から取得した全作品（manual order を保持）
  let _worksSort   = null;   // null | { col: string, dir: 'asc'|'desc' }

  async function loadWorks() {
    const container = document.getElementById('sf-works-container');
    if (!container) return;
    container.className = 'loading';
    container.textContent = '読み込み中...';
    _worksLoaded = false;
    _worksSort   = null;

    try {
      const res  = await fetch('/api/sf/works');
      const data = await res.json();
      if (!data.ok) throw new Error(data.error || 'unknown error');
      _allWorks    = data.works || [];
      container.className = '';
      container.innerHTML = _renderWorksTable(_allWorks);
      _bindWorksEvents(container);
      _worksLoaded = true;
    } catch (e) {
      container.className = 'error';
      container.textContent = `エラー: ${e.message}`;
    }
  }

  /** プラットフォーム表示名 */
  const WORKS_PLATFORM_LABELS = {
    narou:    'なろう',
    kakuyomu: 'カクヨム',
    note:     'note',
    pixiv:    'pixiv',
    hp:       'HP',
    other:    'その他',
  };

  /**
   * 全platform の公開状態バッジを生成する。
   * @param {string|null} publishedPlatforms - カンマ区切りの published platform 名
   * @param {number} pubCount - publication 行の総件数
   */
  function _makePublicBadge(publishedPlatforms, pubCount) {
    if (pubCount === 0) {
      return '<span class="sf-badge sf-badge-dim">公開先未登録</span>';
    }
    if (!publishedPlatforms) {
      return '<span class="sf-badge sf-badge-dim">未公開</span>';
    }
    const platforms = publishedPlatforms.split(',').filter(Boolean);
    const labels    = platforms.map(p => WORKS_PLATFORM_LABELS[p] || p).join('・');
    return `<span class="sf-badge sf-badge-green">公開中（${labels}）</span>`;
  }

  /** 種別の表示ソート順 */
  const _WORKS_TYPE_ORDER = { novel: 0, short_series: 1, short_story: 2, game: 3, other: 4 };

  /** 公開状態のソート順（バッジ表示に準拠） */
  function _worksStatusRank(w) {
    if (Number(w.pub_count) === 0) return 2; // 公開先未登録
    if (w.published_platforms)    return 0; // 公開中
    return 1;                                // 未公開
  }

  /** _worksSort に従って works を並べ替えて返す（元配列を破壊しない） */
  function _sortedWorks(works) {
    if (!_worksSort) return works;
    const { col, dir } = _worksSort;
    const sign = dir === 'asc' ? 1 : -1;

    return [...works].sort((a, b) => {
      switch (col) {
        case 'title':
          return sign * a.title.localeCompare(b.title, 'ja');
        case 'type': {
          const oa = _WORKS_TYPE_ORDER[a.work_type] ?? 99;
          const ob = _WORKS_TYPE_ORDER[b.work_type] ?? 99;
          return sign * (oa - ob);
        }
        case 'pubdate': {
          const da = a.earliest_pub_date || null;
          const db = b.earliest_pub_date || null;
          if (da === null && db === null) return 0;
          if (da === null) return 1;   // NULL は昇順・降順どちらでも末尾
          if (db === null) return -1;
          return sign * da.localeCompare(db);
        }
        case 'status':
          return sign * (_worksStatusRank(a) - _worksStatusRank(b));
        case 'archive': {
          const ca = Number(a.archive_count) || 0;
          const cb = Number(b.archive_count) || 0;
          return sign * (ca - cb);
        }
        default:
          return 0;
      }
    });
  }

  function _renderWorksTable(works) {
    if (!works.length) {
      return '<div class="empty-state">作品がありません</div>';
    }

    const sortActive = _worksSort !== null;

    /** ソート矢印 HTML を返す */
    function _arrowFor(col) {
      if (!_worksSort || _worksSort.col !== col) {
        return '<span class="sf-sort-arrow">↕</span>';
      }
      return _worksSort.dir === 'asc'
        ? '<span class="sf-sort-arrow active">↑</span>'
        : '<span class="sf-sort-arrow active">↓</span>';
    }

    /** th の追加クラス（ソート中の列を薄く強調） */
    function _thClass(col) {
      const active = _worksSort?.col === col ? ' works-th-sorted' : '';
      return `sf-th-sort${active}`;
    }

    const rows = works.map(w => {
      const typeLabel    = WORK_TYPE_LABELS[w.work_type] || w.work_type;
      const pubBadge     = _makePublicBadge(w.published_platforms, Number(w.pub_count));
      const archiveBadge = w.archive_count > 0
        ? `<span class="sf-badge sf-badge-yellow">${w.archive_count}件</span>`
        : `<span class="sf-badge sf-badge-dim">なし</span>`;

      const handleCell = sortActive
        ? `<td class="works-drag-handle works-drag-handle--disabled" aria-hidden="true"></td>`
        : `<td class="works-drag-handle" title="ドラッグで並べ替え" aria-label="並べ替え">
            <svg width="10" height="14" viewBox="0 0 10 16" fill="currentColor" aria-hidden="true">
              <circle cx="3" cy="2"  r="1.5"/><circle cx="7" cy="2"  r="1.5"/>
              <circle cx="3" cy="6"  r="1.5"/><circle cx="7" cy="6"  r="1.5"/>
              <circle cx="3" cy="10" r="1.5"/><circle cx="7" cy="10" r="1.5"/>
              <circle cx="3" cy="14" r="1.5"/><circle cx="7" cy="14" r="1.5"/>
            </svg>
          </td>`;

      return `
        <tr data-work-id="${w.id}"${sortActive ? '' : ' draggable="true"'}>
          ${handleCell}
          <td>${esc(w.title)}</td>
          <td>${typeLabel}</td>
          <td>${(w.earliest_pub_date || '').slice(0, 10) || '—'}</td>
          <td>${pubBadge}</td>
          <td>${archiveBadge}</td>
          <td class="works-action-td">
            <div class="works-row-menu-wrap">
              <button class="works-more-btn" data-work-id="${w.id}" aria-label="アクションメニュー" title="アクション">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                  <circle cx="12" cy="5"  r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/>
                </svg>
              </button>
              <ul class="works-row-menu" hidden>
                <li><button class="works-menu-item works-pub-btn" data-work-id="${w.id}" data-work-title="${esc(w.title)}">公開先を管理</button></li>
                <li><button class="works-menu-item works-arc-btn" data-work-id="${w.id}" data-work-title="${esc(w.title)}">原稿アーカイブ</button></li>
                <li class="works-menu-divider"></li>
                <li><button class="works-menu-item works-menu-item--danger works-del-btn" data-work-id="${w.id}" data-work-title="${esc(w.title)}">JARVISから削除…</button></li>
              </ul>
            </div>
          </td>
        </tr>`;
    }).join('');

    return `
      <table class="sf-table sf-works-table">
        <thead>
          <tr>
            <th class="works-handle-th"></th>
            <th class="${_thClass('title')}"  data-works-sort-col="title">タイトル${_arrowFor('title')}</th>
            <th class="${_thClass('type')}"   data-works-sort-col="type">種別${_arrowFor('type')}</th>
            <th class="${_thClass('pubdate')}" data-works-sort-col="pubdate">公開日${_arrowFor('pubdate')}</th>
            <th class="${_thClass('status')}" data-works-sort-col="status">公開状態${_arrowFor('status')}</th>
            <th class="${_thClass('archive')}" data-works-sort-col="archive">アーカイブ${_arrowFor('archive')}</th>
            <th class="works-action-th"></th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>`;
  }

  /** 開いているドロップダウンをすべて閉じる */
  function _closeAllWorksMenus() {
    document.querySelectorAll('.works-row-menu').forEach(m => { m.hidden = true; });
  }

  function _bindWorksEvents(container) {
    // ── 「…」ドロップダウンメニュー ──────────────────────────────────────────
    container.querySelectorAll('.works-more-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        // バブリングを止めて document の閉じるハンドラに拾われないようにする
        e.stopPropagation();
        const wrap = btn.closest('.works-row-menu-wrap');
        const menu = wrap?.querySelector('.works-row-menu');
        if (!menu) return;
        const isOpen = !menu.hidden;
        _closeAllWorksMenus();
        if (!isOpen) menu.hidden = false;
      });
    });

    // ── メニュー内アイテム ────────────────────────────────────────────────────
    container.querySelectorAll('.works-pub-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        _closeAllWorksMenus();
        const workId    = parseInt(btn.dataset.workId, 10);
        const workTitle = btn.dataset.workTitle;
        _openWorkPubModal(workId, workTitle);
      });
    });
    container.querySelectorAll('.works-arc-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        _closeAllWorksMenus();
        const workId    = parseInt(btn.dataset.workId, 10);
        const workTitle = btn.dataset.workTitle;
        _openWorkArchiveModal(workId, workTitle);
      });
    });
    container.querySelectorAll('.works-del-btn').forEach(btn => {
      btn.addEventListener('click', e => {
        e.stopPropagation();
        _closeAllWorksMenus();
        const workId    = parseInt(btn.dataset.workId, 10);
        const workTitle = btn.dataset.workTitle;
        _openWorkDeleteModal(workId, workTitle);
      });
    });

    // ── 外側クリックでメニューを閉じる（1回だけ登録） ─────────────────────
    if (!container._worksMenuOutsideHandler) {
      container._worksMenuOutsideHandler = () => _closeAllWorksMenus();
      document.addEventListener('click', container._worksMenuOutsideHandler);
    }

    // ── ヘッダーソート ──────────────────────────────────────────────────────
    container.querySelectorAll('th[data-works-sort-col]').forEach(th => {
      th.addEventListener('click', () => {
        const col = th.dataset.worksSortCol;
        if (_worksSort === null || _worksSort.col !== col) {
          // 別の列 or 未ソート → 昇順
          _worksSort = { col, dir: 'asc' };
        } else if (_worksSort.dir === 'asc') {
          // 同列2回目 → 降順
          _worksSort = { col, dir: 'desc' };
        } else {
          // 同列3回目 → ソート解除（manual order へ戻す）
          _worksSort = null;
        }
        const c = document.getElementById('sf-works-container');
        if (!c) return;
        c.innerHTML = _renderWorksTable(_sortedWorks(_allWorks));
        _bindWorksEvents(c);
      });
    });

    _initWorksDragDrop(container);
  }

  /** 削除確認モーダルを動的生成して表示する */
  function _openWorkDeleteModal(workId, workTitle) {
    document.getElementById('modal-work-delete')?.remove();

    const modal = document.createElement('div');
    modal.id        = 'modal-work-delete';
    modal.className = 'sf-modal-overlay';
    modal.innerHTML = `
      <div class="work-delete-dialog">
        <p class="wdd-title">JARVISから削除</p>
        <p class="wdd-body">「<span class="wdd-name">${esc(workTitle)}</span>」を作品管理から削除します。</p>
        <p class="wdd-note">外部サイトの作品や原稿ファイルは削除されません。</p>
        <div id="wdd-blockers" class="wdd-blockers" style="display:none"></div>
        <p id="wdd-error" class="wdd-error" style="display:none"></p>
        <div class="wdd-actions">
          <button class="sf-btn" id="del-cancel-btn">キャンセル</button>
          <button class="sf-btn wdd-del-btn" id="del-confirm-btn">削除</button>
        </div>
      </div>`;
    document.body.appendChild(modal);

    const close = () => modal.remove();
    modal.querySelector('#del-cancel-btn').addEventListener('click', close);
    modal.addEventListener('click', e => { if (e.target === modal) close(); });
    document.addEventListener('keydown', function onKey(e) {
      if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
    });

    modal.querySelector('#del-confirm-btn').addEventListener('click', async () => {
      const confirmBtn  = modal.querySelector('#del-confirm-btn');
      const cancelBtn   = modal.querySelector('#del-cancel-btn');
      const errorEl     = modal.querySelector('#wdd-error');
      const blockersEl  = modal.querySelector('#wdd-blockers');
      confirmBtn.disabled = true;
      cancelBtn.disabled  = true;
      confirmBtn.textContent = '削除中…';
      errorEl.style.display = 'none';

      try {
        const res  = await fetch(`/api/sf/works/${workId}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.ok) {
          modal.remove();
          setStatus('completed', `「${workTitle}」を削除しました`);
          setTimeout(() => setStatus('idle'), 2500);
          loadWorks();
        } else if (res.status === 409 && data.blockers) {
          // 関連データあり → ブロッカー一覧をコンパクトに表示
          const BLOCKER_LABELS = {
            sf_work_archives:      '原稿',
            sf_track_work_links:   '楽曲紐付け',
            sf_revenue:            '収益データ',
            sf_narou_snapshot:     'なろうスナップショット',
            sf_content_registry:   'コンテンツ登録',
            sf_funnel_event:       'ファネルイベント',
            sf_kdp_book_map:       'KDPマッピング',
            sf_note_article:       'note記事',
          };
          const items = data.blockers.map(b =>
            `<span class="wdd-blocker-item">${BLOCKER_LABELS[b.table] ?? b.table} ${b.count}件</span>`
          ).join('');
          blockersEl.innerHTML = items;
          blockersEl.style.display = 'flex';
          errorEl.textContent   = '関連データがあるため削除できません';
          errorEl.style.display = 'block';
          confirmBtn.disabled       = true;
          cancelBtn.disabled        = false;
          confirmBtn.textContent    = '削除';
        } else {
          errorEl.textContent   = data.error ?? '削除に失敗しました';
          errorEl.style.display = 'block';
          confirmBtn.disabled   = false;
          cancelBtn.disabled    = false;
          confirmBtn.textContent = '削除';
        }
      } catch (err) {
        errorEl.textContent   = `エラー: ${err.message}`;
        errorEl.style.display = 'block';
        confirmBtn.disabled   = false;
        cancelBtn.disabled    = false;
        confirmBtn.textContent = '削除';
      }
    });
  }

  /**
   * 作品一覧テーブルのドラッグ並べ替えを初期化する。
   * ハンドル (.works-drag-handle) を掴んだときだけドラッグを開始する。
   * ドロップ後に PUT /api/sf/works/reorder へ保存し、
   * 失敗時はステータスバーにエラーを表示して loadWorks() でDBの順番へ戻す。
   */
  function _initWorksDragDrop(container) {
    // ソート中はドラッグ並べ替えを無効にする
    if (_worksSort !== null) return;

    const tbody = container.querySelector('.sf-works-table tbody');
    if (!tbody) return;

    let dragSrcRow  = null;
    let fromHandle  = false;

    tbody.querySelectorAll('tr').forEach(tr => {
      // ハンドル上でのみドラッグ開始を許可
      tr.querySelector('.works-drag-handle')?.addEventListener('mousedown', () => {
        fromHandle = true;
      });
      document.addEventListener('mouseup', () => { fromHandle = false; }, { once: false, passive: true });

      tr.setAttribute('draggable', 'true');

      tr.addEventListener('dragstart', e => {
        if (!fromHandle) { e.preventDefault(); return; }
        dragSrcRow = tr;
        // Firefox requires dataTransfer data
        e.dataTransfer.setData('text/plain', tr.dataset.workId);
        e.dataTransfer.effectAllowed = 'move';
        // 少し遅らせて透過（dragstart 中に style を変えると ghost 画像に影響するため）
        requestAnimationFrame(() => { if (dragSrcRow) dragSrcRow.classList.add('works-dragging'); });
      });

      tr.addEventListener('dragend', () => {
        if (dragSrcRow) dragSrcRow.classList.remove('works-dragging');
        tbody.querySelectorAll('tr').forEach(r => r.classList.remove('drag-over-top', 'drag-over-bottom'));
        dragSrcRow = null;
        fromHandle = false;
      });

      tr.addEventListener('dragover', e => {
        if (!dragSrcRow || tr === dragSrcRow) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        tbody.querySelectorAll('tr').forEach(r => r.classList.remove('drag-over-top', 'drag-over-bottom'));
        const rect = tr.getBoundingClientRect();
        tr.classList.add(e.clientY < rect.top + rect.height / 2 ? 'drag-over-top' : 'drag-over-bottom');
      });

      tr.addEventListener('dragleave', () => {
        tr.classList.remove('drag-over-top', 'drag-over-bottom');
      });

      tr.addEventListener('drop', async e => {
        e.preventDefault();
        tbody.querySelectorAll('tr').forEach(r => r.classList.remove('drag-over-top', 'drag-over-bottom'));
        if (!dragSrcRow || dragSrcRow === tr) return;

        const rect = tr.getBoundingClientRect();
        const insertBefore = e.clientY < rect.top + rect.height / 2;
        if (insertBefore) {
          tbody.insertBefore(dragSrcRow, tr);
        } else {
          tbody.insertBefore(dragSrcRow, tr.nextSibling);
        }

        const newOrder = [...tbody.querySelectorAll('tr[data-work-id]')]
          .map(r => parseInt(r.dataset.workId, 10));

        try {
          const res = await fetch('/api/sf/works/reorder', {
            method:  'PUT',
            headers: { 'Content-Type': 'application/json' },
            body:    JSON.stringify({ work_ids: newOrder }),
          });
          const data = await res.json();
          if (!data.ok) throw new Error(data.error || '保存失敗');
          setStatus('completed', '順番を保存しました');
          setTimeout(() => setStatus('idle'), 2000);
        } catch (err) {
          setStatus('notice', `並べ替え保存失敗: ${err.message}`);
          loadWorks();
        }
      });
    });
  }

  async function _openWorkPubModal(workId, workTitle) {
    const modal = document.getElementById('modal-work-pub');
    const title = document.getElementById('modal-work-pub-title');
    const body  = document.getElementById('modal-work-pub-body');
    if (!modal || !body) return;

    title.textContent = `公開URL管理 — ${workTitle}`;
    body.innerHTML    = '<div class="loading">読み込み中...</div>';
    modal.hidden      = false;

    try {
      const res  = await fetch(`/api/sf/works/${workId}/publications`);
      const data = await res.json();
      if (!data.ok) throw new Error(data.error);

      const PLATFORMS = ['narou', 'kakuyomu', 'note', 'pixiv', 'hp', 'other'];
      const pubMap    = Object.fromEntries((data.publications || []).map(p => [p.platform, p]));

      const rows = PLATFORMS.map(pl => {
        const pub       = pubMap[pl] || {};
        const statusSel = ['published','unpublished','private','deleted'].map(s =>
          `<option value="${s}" ${pub.publication_status === s ? 'selected' : ''}>${PUB_STATUS_LABELS[s]}</option>`
        ).join('');
        const openBtn = pub.public_url && /^https?:\/\//i.test(pub.public_url)
          ? `<a href="${esc(pub.public_url)}" target="_blank" rel="noopener noreferrer" class="pub-open-btn" title="新しいタブで開く">↗</a>`
          : '';
        const pubDate = (pub.published_at || '').slice(0, 10);
        return `
          <tr data-platform="${pl}">
            <td class="pub-col-platform">${WORKS_PLATFORM_LABELS[pl] || pl}</td>
            <td class="pub-col-url">
              <div class="pub-url-cell">
                <input type="text" class="pub-modal-input pub-url-input" value="${esc(pub.public_url || '')}" placeholder="https://...">
                ${openBtn}
              </div>
            </td>
            <td class="pub-col-wid"><input type="text" class="pub-modal-input-sm pub-wid-input" value="${esc(pub.platform_work_id || '')}" placeholder="作品ID"></td>
            <td class="pub-col-date">
              <input type="date" class="pub-modal-input-sm pub-date-input" value="${esc(pubDate)}">
            </td>
            <td class="pub-col-status">
              <select class="pub-modal-input-sm pub-status-sel">
                ${statusSel}
              </select>
            </td>
            <td class="pub-col-save"><button class="sf-btn sf-btn-sm pub-save-btn" data-work-id="${workId}" data-platform="${pl}" data-pub-id="${pub.id || ''}">保存</button></td>
          </tr>`;
      }).join('');

      body.innerHTML = `
        <table class="pub-modal-table">
          <colgroup>
            <col class="pub-col-w-platform">
            <col class="pub-col-w-url">
            <col class="pub-col-w-wid">
            <col class="pub-col-w-date">
            <col class="pub-col-w-status">
            <col class="pub-col-w-save">
          </colgroup>
          <thead><tr>
            <th>プラットフォーム</th><th>公開URL</th><th>作品ID</th><th>公開日</th><th>状態</th><th></th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
        <div id="pub-save-msg" class="pub-save-msg"></div>`;

      body.querySelectorAll('.pub-save-btn').forEach(btn => {
        btn.addEventListener('click', async () => {
          const row      = btn.closest('tr');
          const platform = btn.dataset.platform;
          const pubId    = btn.dataset.pubId;
          const public_url         = row.querySelector('.pub-url-input').value.trim() || null;
          const platform_work_id   = row.querySelector('.pub-wid-input').value.trim() || null;
          const published_at       = row.querySelector('.pub-date-input').value.trim() || null;
          const publication_status = row.querySelector('.pub-status-sel').value;

          const method  = pubId ? 'PUT' : 'POST';
          const url     = pubId
            ? `/api/sf/works/${workId}/publications/${pubId}`
            : `/api/sf/works/${workId}/publications`;

          try {
            const r = await fetch(url, {
              method,
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ platform, public_url, platform_work_id, publication_status, published_at }),
            });
            const d = await r.json();
            const msg = document.getElementById('pub-save-msg');
            if (d.ok) {
              if (msg) msg.textContent = `${platform} を保存しました`;
              if (!pubId && d.id) btn.dataset.pubId = String(d.id);
              if (_worksLoaded) loadWorks();
            } else {
              if (msg) { msg.style.color = '#f87171'; msg.textContent = d.error; }
            }
          } catch (e) {
            const msg = document.getElementById('pub-save-msg');
            if (msg) { msg.style.color = '#f87171'; msg.textContent = e.message; }
          }
        });
      });

    } catch (e) {
      body.innerHTML = `<div class="error">エラー: ${esc(e.message)}</div>`;
    }
  }

  async function _openWorkArchiveModal(workId, workTitle) {
    const modal = document.getElementById('modal-work-archive');
    const title = document.getElementById('modal-work-archive-title');
    const body  = document.getElementById('modal-work-archive-body');
    if (!modal || !body) return;

    title.textContent = `原稿アーカイブ — ${workTitle}`;
    body.innerHTML    = '<div class="loading">読み込み中...</div>';
    modal.hidden      = false;

    function _fmtBytes(bytes) {
      if (!bytes) return '—';
      if (bytes < 1024) return `${bytes} B`;
      if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
      return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    }

    async function _reloadArchiveList() {
      try {
        const res  = await fetch(`/api/sf/works/${workId}/archives`);
        const data = await res.json();
        const list = document.getElementById('archive-list');
        if (!list) return;
        if (!data.ok || !data.archives?.length) {
          list.innerHTML = '<div class="empty-state" style="font-size:12px">アーカイブがありません</div>';
          return;
        }
        const INLINE_EXTS = new Set(['.pdf', '.txt', '.md']);
        list.innerHTML = data.archives.map(a => {
          const displayName = a.original_filename && a.original_filename !== 'direct_input.md'
            ? a.original_filename
            : a.archived_filename;
          const ext      = (a.archived_filename.match(/\.[^.]+$/) || [''])[0].toLowerCase();
          const fileBase = `/api/sf/works/${workId}/archives/${a.id}/file`;
          const openBtn  = INLINE_EXTS.has(ext)
            ? `<a href="${fileBase}?mode=inline" target="_blank" rel="noopener noreferrer" class="sf-btn sf-btn-sm" style="text-decoration:none;font-size:11px;padding:2px 7px">開く</a>`
            : '';
          return `
          <tr>
            <td>${ARCHIVE_TYPE_LABELS[a.archive_type] || a.archive_type}</td>
            <td style="font-family:monospace;font-size:11px">${esc(displayName)}</td>
            <td>${esc(a.version_label || '—')}</td>
            <td>${_fmtBytes(a.file_size_bytes)}</td>
            <td>${a.archived_at?.slice(0, 10) || '—'}</td>
            <td style="white-space:nowrap">
              ${openBtn}
              <a href="${fileBase}" class="sf-btn sf-btn-sm" download style="text-decoration:none">DL</a>
            </td>
            <td class="works-action-td">
              <div class="works-row-menu-wrap">
                <button class="works-more-btn arc-more-btn" data-arc-id="${a.id}" aria-label="メニュー" title="メニュー">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
                    <circle cx="12" cy="5" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="19" r="1.5"/>
                  </svg>
                </button>
                <ul class="works-row-menu" hidden>
                  <li><button class="works-menu-item works-menu-item--danger arc-unregister-btn"
                    data-arc-id="${a.id}"
                    data-arc-filename="${esc(a.archived_filename)}"
                    data-arc-type="${esc(a.archive_type)}"
                    data-arc-version="${esc(a.version_label || '')}"
                    data-arc-date="${esc(a.version_date || '')}">アーカイブ登録を解除…</button></li>
                </ul>
              </div>
            </td>
          </tr>`;
        }).join('');
      } catch (_) {}

      // アーカイブ一覧の … メニュー / 登録解除バインド
      const arcList = document.getElementById('archive-list');
      if (!arcList) return;

      // 外側クリックでアーカイブメニューを閉じる（重複登録防止）
      if (!arcList._arcMenuOutsideHandler) {
        arcList._arcMenuOutsideHandler = () => {
          arcList.querySelectorAll('.works-row-menu').forEach(m => { m.hidden = true; });
        };
        document.addEventListener('click', arcList._arcMenuOutsideHandler);
      }

      arcList.querySelectorAll('.arc-more-btn').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          const wrap = btn.closest('.works-row-menu-wrap');
          const menu = wrap?.querySelector('.works-row-menu');
          if (!menu) return;
          const isOpen = !menu.hidden;
          arcList.querySelectorAll('.works-row-menu').forEach(m => { m.hidden = true; });
          if (!isOpen) menu.hidden = false;
        });
      });

      arcList.querySelectorAll('.arc-unregister-btn').forEach(btn => {
        btn.addEventListener('click', e => {
          e.stopPropagation();
          arcList.querySelectorAll('.works-row-menu').forEach(m => { m.hidden = true; });
          const arcId       = parseInt(btn.dataset.arcId, 10);
          const arcFilename = btn.dataset.arcFilename;
          const arcType     = ARCHIVE_TYPE_LABELS[btn.dataset.arcType] || btn.dataset.arcType;
          const arcVersion  = btn.dataset.arcVersion;
          const arcDate     = btn.dataset.arcDate;
          _openArchiveUnregisterDialog(workId, arcId, arcFilename, arcType, arcVersion, arcDate, _reloadArchiveList);
        });
      });
    }

    // ファイルアップロード用種別（direct_input は除外）
    const fileTypeOptions = Object.entries(ARCHIVE_TYPE_LABELS)
      .filter(([v]) => v !== 'direct_input')
      .map(([v, l]) => `<option value="${v}">${l}</option>`).join('');

    const inputStyle = 'background:#1e293b;border:1px solid #334155;color:#e2e8f0;padding:4px 8px;border-radius:4px;font-size:12px;width:100%';

    body.innerHTML = `
      <div style="margin-bottom:16px">
        <div class="arc-mode-tabs">
          <button class="arc-mode-tab arc-mode-tab--active" data-mode="file">ファイルから登録</button>
          <button class="arc-mode-tab" data-mode="text">直接入力</button>
        </div>

        <div id="arc-panel-file">
          <div style="display:grid;grid-template-columns:auto 1fr;gap:6px 12px;align-items:center;font-size:12px;margin-bottom:8px">
            <label>種別</label>
            <select id="arc-type-sel" style="${inputStyle}">${fileTypeOptions}</select>
            <label>バージョン</label>
            <input type="text" id="arc-version" placeholder="例: v1.2、第一稿" style="${inputStyle}">
            <label>版日付</label>
            <input type="date" id="arc-version-date" style="${inputStyle}">
            <label>メモ</label>
            <input type="text" id="arc-memo" placeholder="任意" style="${inputStyle}">
            <label>ファイル</label>
            <input type="file" id="arc-file" accept=".docx,.md,.txt,.pdf" style="font-size:12px;color:#e2e8f0;background:#1e293b;border:1px solid #334155;border-radius:4px;padding:4px 6px;width:100%;box-sizing:border-box">
          </div>
          <button class="sf-btn" id="arc-upload-btn">アーカイブ登録</button>
          <span id="arc-msg" style="margin-left:10px;font-size:12px;color:#4ade80"></span>
        </div>

        <div id="arc-panel-text" style="display:none">
          <div style="font-size:12px;margin-bottom:8px">
            <textarea id="arc-text-content" placeholder="本文を入力してください"></textarea>
            <div id="arc-char-count" style="font-size:11px;color:#64748b;text-align:right;margin-top:4px">0字</div>
          </div>
          <div style="display:grid;grid-template-columns:auto 1fr;gap:6px 12px;align-items:center;font-size:12px;margin-bottom:8px">
            <label>バージョン名</label>
            <input type="text" id="arc-text-version" placeholder="例: 第一稿、投稿用" style="${inputStyle}">
            <label>版日付</label>
            <input type="date" id="arc-text-date" style="${inputStyle}">
            <label>メモ</label>
            <input type="text" id="arc-text-memo" placeholder="任意" style="${inputStyle}">
          </div>
          <button class="sf-btn" id="arc-text-submit-btn">保存</button>
          <span id="arc-text-msg" style="margin-left:10px;font-size:12px;color:#4ade80"></span>
        </div>
      </div>
      <h4 style="font-size:13px;color:#94a3b8;margin:0 0 8px">アーカイブ一覧</h4>
      <table class="sf-table" style="font-size:12px">
        <thead><tr><th>種別</th><th>ファイル名</th><th>バージョン</th><th>サイズ</th><th>登録日</th><th></th><th class="works-action-th"></th></tr></thead>
        <tbody id="archive-list"></tbody>
      </table>`;

    await _reloadArchiveList();

    // タブ切り替え
    document.querySelectorAll('.arc-mode-tab').forEach(tab => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.arc-mode-tab').forEach(t => t.classList.remove('arc-mode-tab--active'));
        tab.classList.add('arc-mode-tab--active');
        const mode = tab.dataset.mode;
        document.getElementById('arc-panel-file').style.display = mode === 'file' ? '' : 'none';
        document.getElementById('arc-panel-text').style.display = mode === 'text' ? '' : 'none';
      });
    });

    // 文字数カウント
    document.getElementById('arc-text-content')?.addEventListener('input', () => {
      const content = document.getElementById('arc-text-content').value;
      const count   = [...content].length;
      const el      = document.getElementById('arc-char-count');
      if (el) el.textContent = count.toLocaleString('ja-JP') + '字';
    });

    // ファイルアップロードハンドラー
    document.getElementById('arc-upload-btn')?.addEventListener('click', async () => {
      const file         = document.getElementById('arc-file')?.files?.[0];
      const archiveType  = document.getElementById('arc-type-sel')?.value;
      const version      = document.getElementById('arc-version')?.value.trim() || null;
      const version_date = document.getElementById('arc-version-date')?.value.trim() || null;
      const memo         = document.getElementById('arc-memo')?.value.trim() || null;
      const msgEl        = document.getElementById('arc-msg');

      if (!file)        { if (msgEl) { msgEl.style.color='#f87171'; msgEl.textContent='ファイルを選択してください'; } return; }
      if (!archiveType) { if (msgEl) { msgEl.style.color='#f87171'; msgEl.textContent='種別を選択してください'; } return; }

      if (msgEl) { msgEl.style.color='#94a3b8'; msgEl.textContent='アップロード中...'; }

      try {
        const buf     = await file.arrayBuffer();
        const headers = {
          'Content-Type':        'application/octet-stream',
          'X-Archive-Type':      archiveType,
          'X-Original-Filename': encodeURIComponent(file.name),
        };
        if (version)      headers['X-Version-Label'] = encodeURIComponent(version);
        if (version_date) headers['X-Version-Date']  = version_date;
        if (memo)         headers['X-Memo']           = encodeURIComponent(memo);

        const r = await fetch(`/api/sf/works/${workId}/archives`, {
          method: 'POST',
          headers,
          body: buf,
        });
        const d = await r.json();
        if (d.ok) {
          if (msgEl) { msgEl.style.color='#4ade80'; msgEl.textContent=`登録しました (${d.archived_filename})`; }
          await _reloadArchiveList();
          if (_worksLoaded) loadWorks();
        } else {
          if (msgEl) { msgEl.style.color='#f87171'; msgEl.textContent=d.error; }
        }
      } catch (e) {
        if (msgEl) { msgEl.style.color='#f87171'; msgEl.textContent=e.message; }
      }
    });

    // 直接入力保存ハンドラー
    document.getElementById('arc-text-submit-btn')?.addEventListener('click', async () => {
      const content      = document.getElementById('arc-text-content')?.value ?? '';
      const version      = document.getElementById('arc-text-version')?.value.trim() || null;
      const version_date = document.getElementById('arc-text-date')?.value.trim() || null;
      const memo         = document.getElementById('arc-text-memo')?.value.trim() || null;
      const msgEl        = document.getElementById('arc-text-msg');
      if (!content.trim()) {
        if (msgEl) { msgEl.style.color='#f87171'; msgEl.textContent='本文を入力してください'; }
        return;
      }
      if (msgEl) { msgEl.style.color='#94a3b8'; msgEl.textContent='保存中...'; }
      try {
        const r = await fetch(`/api/sf/works/${workId}/archives/text`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ content, version_label: version, version_date, memo }),
        });
        const d = await r.json();
        const charCount = [...content].length;
        if (d.ok) {
          if (msgEl) { msgEl.style.color='#4ade80'; msgEl.textContent=`${charCount.toLocaleString('ja-JP')}字で保存しました (${d.archived_filename})`; }
          document.getElementById('arc-text-content').value = '';
          document.getElementById('arc-char-count').textContent = '0字';
          await _reloadArchiveList();
          if (_worksLoaded) loadWorks();
        } else {
          if (msgEl) { msgEl.style.color='#f87171'; msgEl.textContent=d.error; }
        }
      } catch (e) {
        if (msgEl) { msgEl.style.color='#f87171'; msgEl.textContent=e.message; }
      }
    });
  }

  /**
   * アーカイブ登録解除の確認ダイアログを表示する。
   * 実ファイルは削除せず、sf_work_archives の行だけ DELETE する。
   */
  function _openArchiveUnregisterDialog(workId, archiveId, filename, typeLabel, versionLabel, versionDate, onSuccess) {
    document.getElementById('modal-arc-unregister')?.remove();

    const infoLines = [
      `<span class="wdd-name">${esc(filename)}</span>`,
      typeLabel,
      versionLabel || null,
      versionDate  || null,
    ].filter(Boolean).map(s => `<span class="arc-ud-info-item">${s}</span>`).join('');

    const modal = document.createElement('div');
    modal.id        = 'modal-arc-unregister';
    modal.className = 'sf-modal-overlay';
    modal.innerHTML = `
      <div class="work-delete-dialog">
        <p class="wdd-title">アーカイブ登録を解除</p>
        <p class="wdd-body">このアーカイブをJARVISから外します。</p>
        <p class="wdd-note">保存済みの原稿ファイル自体は削除されません。</p>
        <div class="arc-ud-info">${infoLines}</div>
        <p id="arc-ud-error" class="wdd-error" style="display:none"></p>
        <div class="wdd-actions">
          <button class="sf-btn" id="arc-ud-cancel">キャンセル</button>
          <button class="sf-btn wdd-del-btn" id="arc-ud-confirm">登録を解除</button>
        </div>
      </div>`;
    document.body.appendChild(modal);

    const close = () => modal.remove();
    modal.querySelector('#arc-ud-cancel').addEventListener('click', close);
    modal.addEventListener('click', e => { if (e.target === modal) close(); });
    document.addEventListener('keydown', function onKey(e) {
      if (e.key === 'Escape') { close(); document.removeEventListener('keydown', onKey); }
    });

    modal.querySelector('#arc-ud-confirm').addEventListener('click', async () => {
      const confirmBtn = modal.querySelector('#arc-ud-confirm');
      const cancelBtn  = modal.querySelector('#arc-ud-cancel');
      const errorEl    = modal.querySelector('#arc-ud-error');
      confirmBtn.disabled = true;
      cancelBtn.disabled  = true;
      confirmBtn.textContent = '解除中…';
      errorEl.style.display = 'none';

      try {
        const res  = await fetch(`/api/sf/works/${workId}/archives/${archiveId}`, { method: 'DELETE' });
        const data = await res.json();
        if (data.ok) {
          modal.remove();
          if (_worksLoaded) loadWorks();
          await onSuccess();
        } else {
          errorEl.textContent   = data.error ?? '解除に失敗しました';
          errorEl.style.display = 'block';
          confirmBtn.disabled   = false;
          cancelBtn.disabled    = false;
          confirmBtn.textContent = '登録を解除';
        }
      } catch (err) {
        errorEl.textContent   = `エラー: ${err.message}`;
        errorEl.style.display = 'block';
        confirmBtn.disabled   = false;
        cancelBtn.disabled    = false;
        confirmBtn.textContent = '登録を解除';
      }
    });
  }

  // ─── モジュール起動 ────────────────────────────────────────────────────────

  /**
   * SF画面起動時にバックグラウンドでSoundrop自動同期を1回トリガーする。
   * UIをブロックしない。エラーは静かに無視する。
   */
  async function _triggerSoundropAutoSync() {
    try {
      await fetch('/api/sf/soundrop-sync/auto', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ force: false }),
      });
      // soundrop-sync タブが現在開いていれば状態パネルを更新
      const syncPanel = document.getElementById('sd-auto-sync-panel');
      if (syncPanel) _refreshSdAutoSyncPanel();
    } catch (_e) {
      // ネットワークエラー等は無視（UIを壊さない）
    }
  }

  /**
   * Snow flakes タブへの切替時に呼ばれる。
   */
  function activate() {
    setState('idle');
    initSubTabs();
    loadLibrary();
    _triggerSoundropAutoSync();
  }

  // ─── 設定資料検索 (Phase 26) ─────────────────────────────────────────────

  /** source コード → UI 表示名 */
  const KNOWLEDGE_SOURCE_LABELS = {
    existing: '既存資料',
    chatgpt:  'ChatGPT作成資料',
  };

  /** matchType コード → UI 表示名 */
  const KNOWLEDGE_MATCH_LABELS = {
    name: 'タイトル一致',
    body: '本文一致',
  };

  /**
   * 設定資料タブを初期化する。
   * タブ切り替え時に1回だけ呼ばれる。2回目以降はイベントが重複しないよう管理。
   */
  let _knowledgeInitialized = false;

  function initKnowledge() {
    if (_knowledgeInitialized) return;
    _knowledgeInitialized = true;

    const input  = document.getElementById('knowledge-search-input');
    const btn    = document.getElementById('knowledge-search-btn');
    const container = document.getElementById('knowledge-results-container');
    if (!input || !btn || !container) return;

    btn.addEventListener('click', () => _runKnowledgeSearch());
    input.addEventListener('keydown', e => {
      if (e.key === 'Enter') _runKnowledgeSearch();
    });
  }

  /** 検索を実行してコンテナに結果を描画する */
  async function _runKnowledgeSearch() {
    const input     = document.getElementById('knowledge-search-input');
    const container = document.getElementById('knowledge-results-container');
    if (!input || !container) return;

    const query = input.value.trim();
    if (!query) return;

    container.innerHTML = '<p class="knowledge-loading">検索中...</p>';

    try {
      const res = await fetch(`/api/knowledge/search?q=${encodeURIComponent(query)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      container.innerHTML = _renderKnowledgeResults(data.results ?? [], query);
    } catch (e) {
      container.innerHTML = `<p class="knowledge-error">検索エラー：${esc(e.message)}</p>`;
    }
  }

  /**
   * 検索結果を HTML 文字列で返す。
   * @param {Array} results - API レスポンスの results 配列
   * @param {string} query  - 検索クエリ（表示用）
   * @returns {string}
   */
  function _renderKnowledgeResults(results, query) {
    if (results.length === 0) {
      return `<p class="knowledge-empty">「${esc(query)}」の設定資料では確認できません。</p>`;
    }

    const items = results.map(r => {
      const sourceLabel = KNOWLEDGE_SOURCE_LABELS[r.source] ?? r.source;
      const sourceBadge = `<span class="knowledge-badge knowledge-badge-${esc(r.source)}">${esc(sourceLabel)}</span>`;

      const matchRows = (r.matches ?? []).map(m => {
        const matchLabel = KNOWLEDGE_MATCH_LABELS[m.matchType] ?? m.matchType;
        const snippet = (m.snippet ?? '').trim().slice(0, 300);
        return `
          <div class="knowledge-match">
            <div class="knowledge-match-meta">
              <span class="knowledge-match-type">${esc(matchLabel)}</span>
              <span class="knowledge-line-no">L${m.lineNo}</span>
            </div>
            <pre class="knowledge-snippet">${esc(snippet)}</pre>
          </div>`;
      }).join('');

      return `
        <div class="knowledge-result-card">
          <div class="knowledge-result-header">
            <span class="knowledge-filename">${esc(r.file)}</span>
            ${sourceBadge}
          </div>
          ${matchRows}
        </div>`;
    });

    return `
      <p class="knowledge-summary">${results.length} 件の資料が見つかりました</p>
      <div class="knowledge-result-list">${items.join('')}</div>`;
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  return {
    activate,
    setState, setStatus, setCharState, setAllCharsState,
    loadLibrary, loadProfiles, loadImports, loadYouTube, loadTikTok,
    loadFunnel, loadEventImpact, loadSync, loadHpAnalytics,
    loadSoundropStats, initSoundropStats, loadSoundropSync,
    loadDistribution,
    renderDistPlatforms, renderDistIssues,
    initKnowledge,
    loadWorks,
    renderTracksTable, renderReleasesTable, renderProfilesTable, renderImportHistory,
    renderYouTubeChannel, renderYouTubeVideos,
    renderTikTokAccount, renderTikTokVideos,
    renderFunnelOverview, renderEventTimeline, renderEventImpact,
    renderSyncAttentionBanner, renderSyncSources,
    renderHpOverview, renderHpPages, renderHpDaily, renderHpEvents,
    renderHpMusicFunnel, renderHpSources,
    renderSdServices, renderSdChannels, renderSdRanking, renderSdMonthly,
  };

})();
