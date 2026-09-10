// jarvis/dashboard/public/modules/work-detail.js

const WORK_TYPE_LABELS = {
  novel:        '長編小説',
  short_story:  '短編小説',
  short_series: '短編集',
  game:         'ゲーム',
  other:        'その他',
};

const PLATFORM_LABELS = {
  narou:   'なろう',
  kakuyomu:'カクヨム',
  note:    'note',
  pixiv:   'pixiv',
  hp:      'HP',
  other:   'その他',
};

const STATUS_LABELS = {
  active:    '執筆中',
  completed: '完結',
  hiatus:    '休止',
};

const PUB_STATUS_LABELS = {
  published:   '公開中',
  unpublished: '非公開',
  private:     '限定',
  deleted:     '削除済',
};

const PUB_STATUS_DOT = {
  published:   'published',
  unpublished: 'unpublished',
  private:     'private',
  deleted:     'deleted',
};

function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fmtDate(s) {
  return s ? String(s).slice(0, 10) : '—';
}

/** http/https のみ許可。それ以外（javascript: 等）は null を返す */
function safeUrl(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    return (u.protocol === 'http:' || u.protocol === 'https:') ? url : null;
  } catch {
    return null;
  }
}

function fmtSize(bytes) {
  if (!bytes) return '';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

// ── 計算ロジック ───────────────────────────────────────────────────────────────

function computeEarliestPubDate(publications, workPublishedAt) {
  const dates = (publications || [])
    .filter(p => p.publication_status === 'published' && p.published_at)
    .map(p => p.published_at)
    .sort();
  if (dates.length > 0) return dates[0].slice(0, 10);
  return workPublishedAt ? workPublishedAt.slice(0, 10) : null;
}

function computeLastRevisionDate(archives) {
  const dates = (archives || [])
    .filter(a => a.archive_type === 'revision' && a.version_date)
    .map(a => a.version_date)
    .sort();
  return dates.length > 0 ? dates[dates.length - 1].slice(0, 10) : null;
}

function computeLatestArchive(archives) {
  if (!archives || archives.length === 0) return null;
  return [...archives].sort((a, b) => {
    // version_date あり優先
    if (a.version_date && !b.version_date) return -1;
    if (!a.version_date && b.version_date) return 1;
    if (a.version_date && b.version_date) {
      const cmp = b.version_date.localeCompare(a.version_date);
      if (cmp !== 0) return cmp;
    }
    return b.archived_at.localeCompare(a.archived_at);
  })[0];
}

// ── レンダリング ────────────────────────────────────────────────────────────────

function renderChips(work, publications) {
  const typeLabel   = WORK_TYPE_LABELS[work.work_type] || work.work_type;
  const statusLabel = STATUS_LABELS[work.status] || work.status;

  const publishedPlatforms = (publications || [])
    .filter(p => p.publication_status === 'published')
    .map(p => PLATFORM_LABELS[p.platform] || p.platform);

  let dotClass = 'wd-chip-dot--dim';
  if (work.status === 'completed') dotClass = 'wd-chip-dot--green';
  else if (work.status === 'active') dotClass = 'wd-chip-dot--yellow';

  const chips = [
    `<span class="wd-chip"><span class="wd-chip-dot ${dotClass}"></span>${esc(typeLabel)}</span>`,
    `<span class="wd-chip">${esc(statusLabel)}</span>`,
  ];

  if (work.title_provisional) {
    chips.push(`<span class="wd-chip" style="color:var(--yellow)">仮題</span>`);
  }

  if (publishedPlatforms.length > 0) {
    chips.push(`<span class="wd-chip" style="color:var(--green)">${esc(publishedPlatforms.join(' / '))}</span>`);
  }

  return chips.join('');
}

function renderMeta(work, publications, archives) {
  const earliestPub  = computeEarliestPubDate(publications, work.published_at);
  const lastRevision = computeLastRevisionDate(archives);

  return `
    <div class="wd-meta-grid">
      <div class="wd-meta-item">
        <div class="wd-meta-label">公開日</div>
        <div class="wd-meta-value">${fmtDate(earliestPub)}</div>
      </div>
      <div class="wd-meta-item">
        <div class="wd-meta-label">文字数</div>
        <div class="wd-meta-value">${work.character_count != null ? Number(work.character_count).toLocaleString() + ' 字' : '—'}</div>
      </div>
      <div class="wd-meta-item">
        <div class="wd-meta-label">初稿日</div>
        <div class="wd-meta-value">${fmtDate(work.first_draft_date)}</div>
      </div>
      <div class="wd-meta-item">
        <div class="wd-meta-label">最終改稿日</div>
        <div class="wd-meta-value">${fmtDate(lastRevision)}</div>
      </div>
    </div>
  `;
}

function renderSynopsisSection(work) {
  const hasSynopsis = work.synopsis && work.synopsis.trim();
  return `
    <div class="wd-section" id="wd-section-synopsis">
      <div class="wd-section-header">
        <div class="wd-section-title">あらすじ</div>
        <button class="wd-edit-btn" id="wd-edit-btn">編集</button>
      </div>
      <div class="wd-view-content" id="wd-view-content">
        ${hasSynopsis
          ? `<div class="wd-synopsis">${esc(work.synopsis)}</div>`
          : `<div class="wd-synopsis wd-synopsis--empty">あらすじ未登録</div>`}
      </div>
      <div class="wd-edit-form" id="wd-edit-form">
        <div class="wd-field">
          <label>あらすじ</label>
          <textarea class="wd-input wd-textarea" id="wd-synopsis-input" rows="6">${esc(work.synopsis || '')}</textarea>
        </div>
        <div class="wd-field">
          <label>初稿日 (YYYY-MM-DD)</label>
          <input class="wd-input" id="wd-first-draft-input" type="text" placeholder="2024-01-01" value="${esc(work.first_draft_date || '')}">
        </div>
        <div class="wd-field">
          <label>文字数</label>
          <input class="wd-input" id="wd-charcount-input" type="number" min="0" step="1" value="${work.character_count != null ? work.character_count : ''}">
        </div>
        <div class="wd-field">
          <label>メモ（管理用）</label>
          <textarea class="wd-input wd-textarea" id="wd-memo-input" rows="4">${esc(work.memo || '')}</textarea>
        </div>
        <div class="wd-edit-actions">
          <button class="wd-save-btn" id="wd-save-btn">保存</button>
          <button class="wd-cancel-btn" id="wd-cancel-btn">キャンセル</button>
        </div>
      </div>
    </div>
  `;
}

function extOf(filename) {
  if (!filename) return '';
  const m = filename.match(/\.([^.]+)$/);
  return m ? m[1].toLowerCase() : '';
}

function renderArchiveActions(workId, archive) {
  const fileUrl = `/api/sf/works/${workId}/archives/${archive.id}/file`;
  const ext = extOf(archive.archived_filename || archive.original_filename || '');
  const isInline = ['txt', 'md', 'pdf'].includes(ext);
  const openBtn = isInline
    ? `<a class="wd-open-btn" href="${fileUrl}" target="_blank" rel="noopener">開く</a>`
    : '';
  const dlBtn = `<a class="wd-dl-btn" href="${fileUrl}" download="${esc(archive.original_filename || archive.archived_filename)}">DL</a>`;
  const moreMenu = `
    <div class="wd-arc-menu-wrap">
      <button class="wd-arc-more-btn" aria-label="メニュー" data-arc-id="${archive.id}">…</button>
      <ul class="wd-arc-menu" hidden>
        <li><button class="wd-arc-menu-item wd-arc-menu-item--danger wd-arc-del-btn"
                    data-work-id="${workId}" data-arc-id="${archive.id}"
                    data-arc-name="${esc(archive.original_filename || archive.archived_filename)}">
          アーカイブ登録を解除…
        </button></li>
      </ul>
    </div>`;
  return `${openBtn} ${dlBtn} ${moreMenu}`;
}

function renderArchivesSection(workId, archives) {
  if (!archives || archives.length === 0) {
    return `
      <div class="wd-section">
        <div class="wd-section-title">本文・原稿</div>
        <div class="wd-synopsis--empty" style="font-size:13px;color:var(--text-dim);font-style:italic">原稿なし</div>
      </div>`;
  }

  const latest = computeLatestArchive(archives);
  const ext = extOf(latest.archived_filename || latest.original_filename || '');
  const isInline = ['txt', 'md', 'pdf'].includes(ext);
  const latestUrl = `/api/sf/works/${workId}/archives/${latest.id}/file`;

  const latestBlock = `
    <div class="wd-latest-archive">
      <span class="wd-latest-label">最新原稿</span>
      <span class="wd-latest-name">${esc(latest.original_filename || latest.archived_filename)}</span>
      ${isInline
        ? `<a class="wd-open-btn" href="${latestUrl}" target="_blank" rel="noopener">最新原稿を開く</a>`
        : `<a class="wd-dl-btn" href="${latestUrl}" download="${esc(latest.original_filename || latest.archived_filename)}">最新原稿をDL</a>`}
    </div>`;

  const ARCHIVE_TYPE_LABELS = {
    submission:    '投稿',
    publication:   '公開版',
    revision:      '改稿',
    literary_award:'文学賞応募',
    direct_input:  '直接入力',
    backup:        'バックアップ',
    other:         'その他',
  };

  const rows = archives.map(a => `
    <tr>
      <td>${esc(ARCHIVE_TYPE_LABELS[a.archive_type] || a.archive_type)}</td>
      <td>${esc(a.version_label || '')}</td>
      <td class="wd-archive-dim">${fmtDate(a.version_date)}</td>
      <td>${esc(a.original_filename || a.archived_filename)}</td>
      <td class="wd-archive-dim">${fmtSize(a.file_size_bytes)}</td>
      <td class="wd-archive-dim">${fmtDate(a.archived_at)}</td>
      <td>${renderArchiveActions(workId, a)}</td>
    </tr>`).join('');

  return `
    <div class="wd-section">
      <div class="wd-section-title">本文・原稿</div>
      ${latestBlock}
      <table class="wd-archive-table">
        <thead>
          <tr>
            <th>種別</th><th>バージョン</th><th>版日</th>
            <th>ファイル名</th><th>サイズ</th><th>登録日</th><th></th>
          </tr>
        </thead>
        <tbody>${rows}</tbody>
      </table>
    </div>`;
}

function renderHistorySection(archives) {
  const withDate = (archives || [])
    .filter(a => a.version_date)
    .sort((a, b) => a.version_date.localeCompare(b.version_date));

  const withoutDate = (archives || []).filter(a => !a.version_date);

  if (withDate.length === 0 && withoutDate.length === 0) {
    return `
      <div class="wd-section">
        <div class="wd-section-title">改稿履歴</div>
        <div class="wd-synopsis--empty" style="font-size:13px;color:var(--text-dim);font-style:italic">履歴なし</div>
      </div>`;
  }

  const ARCHIVE_TYPE_LABELS = {
    submission:    '投稿',
    publication:   '公開版',
    revision:      '改稿',
    literary_award:'文学賞応募',
    direct_input:  '直接入力',
    backup:        'バックアップ',
    other:         'その他',
  };

  const items = withDate.map(a => `
    <li class="wd-history-item">
      <span class="wd-history-date">${esc(a.version_date.slice(0, 10))}</span>
      <span class="wd-history-label">${esc(a.version_label || ARCHIVE_TYPE_LABELS[a.archive_type] || a.archive_type)}</span>
    </li>`).join('');

  const undatedItems = withoutDate.length > 0
    ? `<li class="wd-history-item">
        <span class="wd-history-date wd-archive-dim">日付未設定</span>
        <span class="wd-history-label wd-archive-dim">${withoutDate.map(a => esc(a.version_label || ARCHIVE_TYPE_LABELS[a.archive_type] || a.archive_type)).join('、')}</span>
       </li>`
    : '';

  return `
    <div class="wd-section">
      <div class="wd-section-title">改稿履歴</div>
      <ul class="wd-history-list">${items}${undatedItems}</ul>
    </div>`;
}

function renderPublicationsSection(publications) {
  if (!publications || publications.length === 0) {
    return `
      <div class="wd-section">
        <div class="wd-section-title">公開先</div>
        <div class="wd-synopsis--empty" style="font-size:13px;color:var(--text-dim);font-style:italic">公開先未登録</div>
      </div>`;
  }

  const items = publications.map(p => {
    const dotCls = PUB_STATUS_DOT[p.publication_status] || 'unpublished';
    const statusLabel = PUB_STATUS_LABELS[p.publication_status] || p.publication_status;
    const platformLabel = PLATFORM_LABELS[p.platform] || p.platform;
    const safeLink = safeUrl(p.public_url);
    const openLink = safeLink
      ? `<a class="wd-pub-open" href="${esc(safeLink)}" target="_blank" rel="noopener">開く ↗</a>`
      : '';
    return `
      <li class="wd-pub-item">
        <span class="wd-pub-platform">${esc(platformLabel)}</span>
        <span class="wd-pub-status">
          <span class="wd-status-dot wd-status-dot--${dotCls}"></span>${esc(statusLabel)}
        </span>
        <span class="wd-pub-date">${fmtDate(p.published_at)}</span>
        <span class="wd-pub-url wd-archive-dim">${esc(p.public_url || '')}</span>
        ${openLink}
      </li>`;
  }).join('');

  return `
    <div class="wd-section">
      <div class="wd-section-title">公開先</div>
      <ul class="wd-pub-list">${items}</ul>
    </div>`;
}

function renderMemoSection(work) {
  if (!work.memo) return '';
  return `
    <div class="wd-section">
      <div class="wd-section-title">メモ</div>
      <div class="wd-synopsis">${esc(work.memo)}</div>
    </div>`;
}

function renderPage(work, publications, archives) {
  const content = document.getElementById('wd-content');
  content.innerHTML = `
    <div class="wd-header">
      <h1 class="wd-title">${esc(work.title)}${work.title_provisional ? ' <span style="font-size:14px;color:var(--yellow);font-weight:400">(仮)</span>' : ''}</h1>
      <div class="wd-chips">${renderChips(work, publications)}</div>
    </div>

    <div class="wd-section">
      <div class="wd-section-title">概要</div>
      ${renderMeta(work, publications, archives)}
    </div>

    ${renderSynopsisSection(work)}
    ${renderArchivesSection(work.id, archives)}
    ${renderHistorySection(archives)}
    ${renderPublicationsSection(publications)}
    ${renderMemoSection(work)}
  `;
  content.hidden = false;

  bindEditMode(work);
  bindArchiveMenus(work.id);
}

function bindEditMode(work) {
  const editBtn    = document.getElementById('wd-edit-btn');
  const saveBtn    = document.getElementById('wd-save-btn');
  const cancelBtn  = document.getElementById('wd-cancel-btn');
  const viewCont   = document.getElementById('wd-view-content');
  const editForm   = document.getElementById('wd-edit-form');
  if (!editBtn) return;

  editBtn.addEventListener('click', () => {
    viewCont.classList.add('hidden');
    editForm.classList.add('active');
    editBtn.style.display = 'none';
  });

  cancelBtn.addEventListener('click', () => {
    editForm.classList.remove('active');
    viewCont.classList.remove('hidden');
    editBtn.style.display = '';
  });

  saveBtn.addEventListener('click', async () => {
    saveBtn.disabled = true;
    saveBtn.textContent = '保存中…';
    const body = {
      synopsis:         document.getElementById('wd-synopsis-input').value || null,
      first_draft_date: document.getElementById('wd-first-draft-input').value || null,
      character_count:  document.getElementById('wd-charcount-input').value !== ''
                          ? Number(document.getElementById('wd-charcount-input').value)
                          : null,
      memo:             document.getElementById('wd-memo-input').value || null,
    };
    try {
      const res = await fetch(`/api/sf/works/${work.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error || `HTTP ${res.status}`);
      }
      // reload page to reflect changes
      location.reload();
    } catch (e) {
      alert('保存に失敗しました: ' + e.message);
      saveBtn.disabled = false;
      saveBtn.textContent = '保存';
    }
  });
}

function bindArchiveMenus(workId) {
  // Toggle menus
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.wd-arc-more-btn');
    if (btn) {
      e.stopPropagation();
      const menu = btn.parentElement.querySelector('.wd-arc-menu');
      if (menu) {
        const isOpen = !menu.hidden;
        // close all
        document.querySelectorAll('.wd-arc-menu').forEach(m => { m.hidden = true; });
        menu.hidden = isOpen;
      }
      return;
    }
    // Close all on outside click
    document.querySelectorAll('.wd-arc-menu').forEach(m => { m.hidden = true; });
  });

  // Delete buttons
  document.querySelectorAll('.wd-arc-del-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const arcId   = btn.dataset.arcId;
      const arcName = btn.dataset.arcName;
      if (!confirm(`「${arcName}」のアーカイブ登録を解除しますか？\n（実ファイルは削除されません）`)) return;
      try {
        const res = await fetch(`/api/sf/works/${workId}/archives/${arcId}`, { method: 'DELETE' });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw new Error(j.error || `HTTP ${res.status}`);
        }
        location.reload();
      } catch (e) {
        alert('解除に失敗しました: ' + e.message);
      }
    });
  });
}

// ── エントリーポイント ──────────────────────────────────────────────────────────

async function init() {
  const params = new URLSearchParams(location.search);
  const workId = parseInt(params.get('id'), 10);

  if (!workId || isNaN(workId)) {
    document.getElementById('wd-loading').textContent = 'IDが指定されていません';
    return;
  }

  // Back link: go back if came from same origin, else top
  const backLink = document.getElementById('wd-back-link');
  if (document.referrer && new URL(document.referrer).origin === location.origin) {
    backLink.addEventListener('click', (e) => { e.preventDefault(); history.back(); });
  }

  try {
    const res = await fetch(`/api/sf/works/${workId}`);
    if (!res.ok) {
      const j = await res.json().catch(() => ({}));
      throw new Error(j.error || `HTTP ${res.status}`);
    }
    const data = await res.json();
    document.title = `${data.work.title} — JARVIS`;
    document.getElementById('wd-loading').hidden = true;
    renderPage(data.work, data.publications, data.archives);
  } catch (e) {
    document.getElementById('wd-loading').innerHTML =
      `<div class="wd-error">読み込みに失敗しました: ${esc(e.message)}</div>`;
  }
}

init();
