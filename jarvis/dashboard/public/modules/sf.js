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
        else if (tabName === 'profiles')     loadProfiles();
        else if (tabName === 'import')       loadImports();
        else if (tabName === 'youtube')      loadYouTube();
        else if (tabName === 'tiktok')       loadTikTok();
        else if (tabName === 'funnel')       loadFunnel();
        else if (tabName === 'sync')         loadSync();
        else if (tabName === 'hp-analytics') loadHpAnalytics();
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

  // ─── Sync / Ops（Phase 10）────────────────────────────────────────────────

  async function loadSync() {
    setState('analyzing');
    const bannerEl = document.getElementById('sf-sync-attention-banner');
    const autoEl   = document.getElementById('sf-sync-auto-container');
    const manualEl = document.getElementById('sf-sync-manual-container');
    const runBtn   = document.getElementById('sf-sync-run-btn');

    try {
      const [statusRes, attentionRes] = await Promise.all([
        fetch('/api/sf/sync/status'),
        fetch('/api/sf/sync/attention'),
      ]);
      const statusData    = await statusRes.json();
      const attentionData = await attentionRes.json();

      renderSyncAttentionBanner(bannerEl, attentionData.items ?? []);
      renderSyncSources(autoEl,   statusData.sources?.filter(s => s.mode === 'auto')   ?? []);
      renderSyncSources(manualEl, statusData.sources?.filter(s => s.mode === 'manual') ?? []);

      if (attentionData.count > 0) setState('notice');
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
          const res  = await fetch('/api/sf/sync/run', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
          const data = await res.json();
          loadSync();
        } catch (_) {
          loadSync();
        } finally {
          runBtn.disabled = false;
          runBtn.textContent = '今すぐ同期';
        }
      };
    }
  }

  function renderSyncAttentionBanner(el, items) {
    if (!el) return;
    if (items.length === 0) {
      el.innerHTML = '<div class="sf-attention-ok">要確認なし — すべてのデータソースが正常です</div>';
      return;
    }
    const rows = items.map(item => {
      const cls = item.severity === 'error' ? 'attention-error' : item.severity === 'warning' ? 'attention-warning' : 'attention-info';
      return `<div class="sf-attention-item ${cls}">
        <strong>${esc(item.label)}</strong> — ${esc(item.message)}
      </div>`;
    }).join('');
    el.innerHTML = `<div class="sf-attention-banner">
      <div class="sf-attention-title">要確認 ${items.length} 件</div>
      ${rows}
    </div>`;
  }

  function renderSyncSources(el, sources) {
    if (!el) return;
    if (sources.length === 0) { el.innerHTML = ''; return; }
    const rows = sources.map(s => {
      const stCls = s.status === 'fresh' ? 'status-fresh' : s.status === 'stale' ? 'status-stale' : 'status-other';
      const lastDate = s.last_data_date ?? '未取得';
      const nextAction = s.requires_user_action
        ? `<span class="sync-action">${esc(s.action_message ?? '確認が必要です')}</span>` : '';
      return `<tr>
        <td>${esc(s.label)}</td>
        <td>${esc(lastDate)}</td>
        <td><span class="sf-badge ${stCls}">${esc(s.status)}</span></td>
        <td>${nextAction}</td>
      </tr>`;
    }).join('');
    el.innerHTML = `<table class="sf-table">
      <thead><tr><th>Source</th><th>最終データ日</th><th>状態</th><th>次の対応</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>`;
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

  /** 流入元（現在未取得）*/
  function renderHpSources() {
    return `
      <div class="hp-sources-placeholder">
        流入元（source / medium / referrer）データは現在未取得です。<br>
        GA4 の acquisition レポートデータは sf_ga_daily / sf_ga_event_daily に含まれていません。<br>
        将来拡張予定（STATUS.md 参照）。
      </div>
    `;
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

    let overviewRes, pagesRes, dailyRes, eventsRes;
    try {
      [overviewRes, pagesRes, dailyRes, eventsRes] = await Promise.all([
        fetch('/api/sf/ga/overview?days=30').then(r => r.json()),
        fetch('/api/sf/ga/pages').then(r => r.json()),
        fetch('/api/sf/ga/daily').then(r => r.json()),
        fetch('/api/sf/ga/events').then(r => r.json()),
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
    if (sourcesEl)  sourcesEl.innerHTML  = renderHpSources();
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
    loadLibrary, loadProfiles, loadImports, loadYouTube, loadTikTok,
    loadFunnel, loadEventImpact, loadSync, loadHpAnalytics,
    renderTracksTable, renderReleasesTable, renderProfilesTable, renderImportHistory,
    renderYouTubeChannel, renderYouTubeVideos,
    renderTikTokAccount, renderTikTokVideos,
    renderFunnelOverview, renderEventTimeline, renderEventImpact,
    renderSyncAttentionBanner, renderSyncSources,
    renderHpOverview, renderHpPages, renderHpDaily, renderHpEvents,
    renderHpMusicFunnel, renderHpSources,
  };

})();
