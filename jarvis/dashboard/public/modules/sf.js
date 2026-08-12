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

  // ─── SF サブタブ切替 ──────────────────────────────────────────────────────

  function initSubTabs() {
    document.querySelectorAll('.sf-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        const tabName = btn.dataset.sfTab;

        // ボタンのアクティブ状態
        document.querySelectorAll('.sf-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');

        // パネルの表示切替
        document.querySelectorAll('.sf-tab-panel').forEach(panel => {
          panel.hidden = true;
        });
        const panel = document.getElementById(`sf-tab-${tabName}`);
        if (panel) panel.hidden = false;

        // タブに応じたデータ読み込み
        if (tabName === 'library') loadLibrary();
        else if (tabName === 'profiles') loadProfiles();
        else if (tabName === 'import') loadImports();
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

  /**
   * 楽曲一覧テーブルを生成する。
   * 列: 曲名 | 制作日 | リリース日 | 正式状態 | HPデモ | WAV | MP3 | ISRC
   * @param {object[]} tracks
   * @returns {string} HTML文字列
   */
  function renderTracksTable(tracks) {
    if (!tracks || tracks.length === 0) {
      return '<div class="empty-state">楽曲データがありません</div>';
    }
    const rows = tracks.map(t => `
      <tr>
        <td class="sf-col-title">${esc(t.title)}</td>
        <td class="sf-col-date">${t.created_date || '—'}</td>
        <td class="sf-col-date">${t.release_date || '—'}</td>
        <td>${trackStatusBadge(t.status)}</td>
        <td>${previewStatusBadge(t.preview_status)}</td>
        <td class="sf-col-center">${fileCheck(t.has_wav)}</td>
        <td class="sf-col-center">${fileCheck(t.has_mp3)}</td>
        <td class="sf-col-isrc">${esc(t.isrc || '—')}</td>
      </tr>
    `).join('');

    return `
      <table class="sf-table">
        <thead>
          <tr>
            <th>曲名</th>
            <th>制作日</th>
            <th>リリース日</th>
            <th>正式状態</th>
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
      if (tracksEl)   tracksEl.innerHTML   = renderTracksTable(tracksRes.tracks || []);
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

  // ─── モジュール起動 ────────────────────────────────────────────────────────

  /**
   * Snow flakes タブへの切替時に呼ばれる。
   */
  function activate() {
    setState('idle');
    initSubTabs();
    loadLibrary();
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  return {
    activate,
    setState, setStatus, setCharState, setAllCharsState,
    loadLibrary, loadProfiles, loadImports,
    renderTracksTable, renderReleasesTable, renderProfilesTable, renderImportHistory,
  };

})();
