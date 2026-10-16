/**
 * dashboard/public/modules/timecard.js
 * タイムカード UI モジュール
 *
 * 状態: idle / working / breaking
 * 操作: in / out / break_start / break_end
 */

(function () {
  'use strict';

  const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
  const DEFAULT_LOCATIONS  = ['自宅', 'オフィス', '外出先'];
  const DEFAULT_CATEGORIES = ['スノフレ', '物販'];
  const CATEGORY_COLOR = {
    'スノフレ': { bg: 'rgba(88,166,255,0.15)', color: '#58a6ff' },
    '物販':     { bg: 'rgba(63,185,80,0.15)',  color: '#3fb950' },
  };
  const DOW = ['日','月','火','水','木','金','土'];
  const KIND_LABEL = { in: '作業開始', out: '作業終了', break_start: '休憩開始', break_end: '作業再開' };
  const KIND_CLS   = { in: 'tc-hist-in', out: 'tc-hist-out', break_start: 'tc-hist-break', break_end: 'tc-hist-resume' };

  // ── タブ識別 / クロスタブ通信 ──────────────────────────────────────────────────
  const _tabId = Math.random().toString(36).slice(2, 10);
  const _bc = typeof BroadcastChannel !== 'undefined'
    ? new BroadcastChannel('tc')
    : null;

  // ── テスト用オーバーライド ─────────────────────────────────────────────────────
  // localStorage.setItem('tc_test_now', <UTC ms>)      → 通知チェック時刻を上書き
  // localStorage.setItem('tc_test_snooze_ms', <ms>)   → スヌーズ待ち時間を短縮
  function nowForNotif() {
    try {
      const v = localStorage.getItem('tc_test_now');
      if (v) { const n = parseInt(v, 10); if (!isNaN(n)) return n; }
    } catch (_) {}
    return Date.now();
  }
  function snoozeDuration() {
    try {
      const v = localStorage.getItem('tc_test_snooze_ms');
      if (v) { const n = parseInt(v, 10); if (!isNaN(n) && n > 0) return n; }
    } catch (_) {}
    return 10 * 60 * 1000;
  }

  // ── DOM ─────────────────────────────────────────────────────────────────────

  function el(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // ── 状態 ─────────────────────────────────────────────────────────────────────

  let _state      = 'idle';
  let _location   = '自宅';
  let _category   = 'スノフレ';
  let _lastPunch  = null;
  let _today      = {};
  let _statusOk   = true;
  let _clockTimer = null;
  let _refreshTimer = null;

  // ── 時計 ─────────────────────────────────────────────────────────────────────

  function nowJst() { return new Date(Date.now() + JST_OFFSET_MS); }

  function updateClock() {
    const d   = nowJst();
    const pad = n => String(n).padStart(2, '0');
    const dateStr = `${d.getUTCFullYear()}年${d.getUTCMonth()+1}月${d.getUTCDate()}日`;
    const dow  = DOW[d.getUTCDay()];
    const timeStr = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
    const ce = el('tc-clock');
    if (ce) ce.textContent = `${dateStr}（${dow}）　${timeStr}`;
    updateLiveSummary();
  }

  function updateLiveSummary() {
    if (!_today?.date) return;
    const nowMs = Date.now();
    const dayStart = new Date(_today.date + 'T00:00:00+09:00').getTime();
    const dayEnd   = dayStart + 86400000;
    const overlap  = (s, e) => Math.max(0, Math.min(e, dayEnd) - Math.max(s, dayStart));

    let extraWork  = 0;
    let extraBreak = 0;
    if (_state === 'working' && _lastPunch) {
      extraWork = overlap(_lastPunch.at_ms, nowMs);
    } else if (_state === 'breaking' && _lastPunch) {
      extraBreak = overlap(_lastPunch.at_ms, nowMs);
    }

    const workMs  = (_today.workMs  ?? 0) + extraWork;
    const breakMs = (_today.breakMs ?? 0) + extraBreak;

    const fmt = ms => {
      const m = Math.floor(ms / 60000);
      const h = Math.floor(m / 60);
      return h > 0 ? `${h}時間${m % 60}分` : `${m}分`;
    };
    const fmtTime = ms => {
      if (!ms) return '—';
      const d = new Date(ms + JST_OFFSET_MS);
      return `${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`;
    };

    // サマリーカード
    const we = el('tc-work-time');
    const be = el('tc-break-time');
    const fe = el('tc-first-in');
    const le = el('tc-last-out');
    if (we) we.textContent = fmt(workMs);
    if (be) be.textContent = fmt(breakMs);
    if (fe) fe.textContent = fmtTime(_today.firstInMs);
    if (le) le.textContent = _state === 'idle' ? fmtTime(_today.lastOutMs) : '稼働中';

    // アコーディオン今日行
    const lw = el('tc-live-row-work');
    const lb = el('tc-live-row-break');
    if (lw) lw.textContent = fmt(workMs);
    if (lb) lb.textContent = fmt(breakMs);
  }

  // ── フォーマット ─────────────────────────────────────────────────────────────

  function fmtMs(ms) {
    if (!ms) return '—';
    const m = Math.floor(ms / 60000);
    const h = Math.floor(m / 60);
    return h > 0 ? `${h}時間${m % 60}分` : `${m}分`;
  }

  function fmtTime(ms) {
    if (!ms) return '—';
    const d = new Date(ms + JST_OFFSET_MS);
    return `${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`;
  }

  function fmtTimeSec(ms) {
    if (!ms) return '—';
    const d = new Date(ms + JST_OFFSET_MS);
    return `${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}:${String(d.getUTCSeconds()).padStart(2,'0')}`;
  }

  function fmtDate(dateStr) {
    const d   = new Date(dateStr + 'T00:00:00+09:00');
    const dow = DOW[d.getUTCDay()];
    const m   = d.getUTCMonth() + 1;
    const day = d.getUTCDate();
    return `${m}/${String(day).padStart(2,'0')}（${dow}）`;
  }

  // ── API ──────────────────────────────────────────────────────────────────────

  async function fetchStatus() {
    try {
      const r = await fetch('/api/tc/status');
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      if (!data.ok) throw new Error(data.error ?? 'API error');
      _state     = data.state;
      _location  = data.location;
      _lastPunch = data.lastPunch;
      _today     = data.today ?? {};
      _statusOk  = true;
      return data;
    } catch (e) {
      _statusOk = false;
      console.error('[TC] fetchStatus failed:', e.message);
      throw e;
    }
  }

  async function fetchDailyHistory(days = 30) {
    const r = await fetch(`/api/tc/daily?days=${days}`);
    const d = await r.json();
    return d.ok ? d.history : [];
  }

  function genRequestId() {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  }

  async function doPunch(kind) {
    if (!_statusOk) {
      showError('状態を確認できません。再読込してください。');
      return;
    }

    const atMs      = Date.now();
    const requestId = genRequestId();
    const location  = _location;
    const category  = _category;

    setButtonsDisabled(true);
    hideError();

    let result;
    try {
      const r = await fetch('/api/tc/punch', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, atMs, location, category, requestId }),
      });
      result = await r.json();
      if (!r.ok && !result) throw new Error(`HTTP ${r.status}`);
    } catch (e) {
      showError(`通信エラー。状態を再確認しています... (${e.message})`);
      await new Promise(res => setTimeout(res, 1500));
      try {
        await fetchStatus();
        hideError();
        renderAll();
      } catch (_) {}
      setButtonsDisabled(false);
      return;
    }

    if (!result.ok) {
      showError(result.error ?? '打刻に失敗しました');
      try { await fetchStatus(); } catch (_) {}
      setButtonsDisabled(false);
      renderAll();
      return;
    }

    try { await fetchStatus(); } catch (_) {}
    // タイマー連携
    if (kind === 'break_start') {
      // 作業タイマーが稼働中なら停止
      if (_timerState && _timerState.type === 'work') {
        pauseTimer();
      }
    } else if (kind === 'out') {
      // 作業終了 → タイマーをリセット
      resetTimer();
    } else if (kind === 'break_end') {
      // 休憩終了 → タイマーが休憩中なら停止（break_endバナーからの操作以外）
      if (_timerState && _timerState.type === 'break') {
        stopTimerInterval();
        _timerState = null;
        saveTimerState();
        renderTimer();
      }
    }
    // 他タブへ打刻を通知（即時状態同期）
    _bc?.postMessage({ type: 'punch', tabId: _tabId, kind });
    checkSnoozeCancel();
    setButtonsDisabled(false);
    hideError();
    await renderAll();
    await loadDailyHistory();
  }

  // ── レンダリング ─────────────────────────────────────────────────────────────

  function renderState() {
    const labels = { idle: '未作業', working: '作業中', breaking: '休憩中' };
    const cls    = { idle: 'tc-state-idle', working: 'tc-state-working', breaking: 'tc-state-breaking' };
    const se = el('tc-state');
    if (se) {
      se.textContent = labels[_state] ?? '不明';
      se.className   = `tc-state-badge ${cls[_state] ?? ''}`;
    }
  }

  function renderButtons() {
    const btnIn     = el('tc-btn-in');
    const btnOut    = el('tc-btn-out');
    const btnBreak  = el('tc-btn-break');
    const btnResume = el('tc-btn-resume');
    if (!btnIn) return;
    btnIn.style.display     = _state === 'idle'                                  ? '' : 'none';
    btnOut.style.display    = (_state === 'working' || _state === 'breaking')    ? '' : 'none';
    btnBreak.style.display  = _state === 'working'                               ? '' : 'none';
    btnResume.style.display = _state === 'breaking'                              ? '' : 'none';
  }

  function renderLocation() {
    const le = el('tc-location-display');
    if (le) le.textContent = _location;

    const area = el('tc-location-area');
    if (area) area.style.display = _state === 'idle' ? '' : 'none';

    const sel = el('tc-location-select');
    if (sel) {
      if (DEFAULT_LOCATIONS.includes(_location)) {
        sel.value = _location;
        const custom = el('tc-location-custom');
        if (custom) custom.style.display = 'none';
      } else {
        sel.value = '__custom__';
        const custom = el('tc-location-custom');
        if (custom) {
          custom.style.display = '';
          custom.value = _location;
        }
      }
    }
  }

  function renderCategory() {
    const area = el('tc-category-area');
    if (area) area.style.display = _state === 'idle' ? '' : 'none';

    const sel = el('tc-category-select');
    if (sel) {
      if (DEFAULT_CATEGORIES.includes(_category)) {
        sel.value = _category;
        const custom = el('tc-category-custom');
        if (custom) custom.style.display = 'none';
      } else if (_category) {
        sel.value = '__custom__';
        const custom = el('tc-category-custom');
        if (custom) {
          custom.style.display = '';
          custom.value = _category;
        }
      }
    }
  }

  async function renderAll() {
    renderState();
    renderButtons();
    renderLocation();
    renderCategory();
    updateLiveSummary();
    if (!_statusOk) {
      showError('状態の取得に失敗しました。');
      el('tc-reload-btn')?.style.setProperty('display', '');
    } else {
      el('tc-reload-btn')?.style.setProperty('display', 'none');
    }
  }

  // ── セッション計算 ──────────────────────────────────────────────────────────

  /**
   * 打刻配列（at_ms 昇順）からセッション配列を計算する。
   * セッション = 作業開始（in）〜作業終了（out）または継続中。
   */
  function computeSessions(punches, nowMs = Date.now()) {
    const sessions = [];
    let cur = null;

    for (const p of punches) {
      if (p.kind === 'in') {
        // 前のセッションが閉じていなければ強制終了
        if (cur) sessions.push({ ...cur, outMs: p.at_ms, open: false });
        cur = {
          inMs: p.at_ms, outMs: null, open: true,
          category: p.category || '',
          location: p.location || '',
          breaks: [], breakStart: null,
          punches: [p],
        };
      } else if (p.kind === 'break_start' && cur) {
        if (cur.breakStart === null) cur.breakStart = p.at_ms;
        cur.punches.push(p);
      } else if (p.kind === 'break_end' && cur) {
        if (cur.breakStart !== null) {
          cur.breaks.push({ startMs: cur.breakStart, endMs: p.at_ms });
          cur.breakStart = null;
        }
        cur.punches.push(p);
      } else if (p.kind === 'out' && cur) {
        if (cur.breakStart !== null) {
          cur.breaks.push({ startMs: cur.breakStart, endMs: p.at_ms });
          cur.breakStart = null;
        }
        cur.outMs = p.at_ms;
        cur.open  = false;
        cur.punches.push(p);
        sessions.push(cur);
        cur = null;
      }
    }

    // 継続中セッション
    if (cur) {
      if (cur.breakStart !== null) {
        // 現在休憩中
        cur.breaks.push({ startMs: cur.breakStart, endMs: nowMs });
        cur.breakStart = null;
      }
      cur.open = true;
      sessions.push(cur);
    }

    return sessions;
  }

  function sessionWorkMs(s, nowMs = Date.now()) {
    const end = s.outMs ?? nowMs;
    const totalMs = end - s.inMs;
    const breakMs = s.breaks.reduce((acc, b) => acc + (b.endMs - b.startMs), 0);
    return Math.max(0, totalMs - breakMs);
  }

  function sessionBreakMs(s, nowMs = Date.now()) {
    return s.breaks.reduce((acc, b) => acc + (b.endMs - b.startMs), 0);
  }

  // ── 深夜作業計算（0:00〜5:00 JST）────────────────────────────────────────────
  const NIGHT_END_HOUR = 5; // 深夜帯: 0時〜5時

  /** 1つの作業区間 [segStartMs, segEndMs] が深夜に重なるミリ秒を返す */
  function calcNightOverlap(segStartMs, segEndMs) {
    const DAY = 86400000;
    // 開始日の JST 深夜0時 (UTC) を求める
    let dayStartUtc = Math.floor((segStartMs + JST_OFFSET_MS) / DAY) * DAY - JST_OFFSET_MS;
    let total = 0;
    while (dayStartUtc < segEndMs) {
      const nightEnd = dayStartUtc + NIGHT_END_HOUR * 3600000;
      const overlap  = Math.max(0, Math.min(segEndMs, nightEnd) - Math.max(segStartMs, dayStartUtc));
      total += overlap;
      dayStartUtc += DAY;
    }
    return total;
  }

  /** セッション1件の深夜作業時間（休憩を除く）*/
  function sessionNightWorkMs(s, nowMs = Date.now()) {
    const endMs = s.outMs ?? nowMs;
    const brks  = [...s.breaks].sort((a, b) => a.startMs - b.startMs);
    let pos = s.inMs, night = 0;
    for (const b of brks) {
      if (b.startMs > pos) night += calcNightOverlap(pos, Math.min(b.startMs, endMs));
      pos = Math.max(pos, b.endMs);
    }
    if (pos < endMs) night += calcNightOverlap(pos, endMs);
    return night;
  }

  /** セッション配列全体の深夜作業時間合計 */
  function calcNightWorkMs(sessions, nowMs = Date.now()) {
    return sessions.reduce((t, s) => t + sessionNightWorkMs(s, nowMs), 0);
  }

  /**
   * セッション配列からカテゴリ別作業時間を集計。
   * @returns {Map<string, number>} category → workMs
   */
  function calcCategoryBreakdown(sessions, nowMs = Date.now()) {
    const map = new Map();
    for (const s of sessions) {
      const cat = s.category || '（未設定）';
      const wms = sessionWorkMs(s, nowMs);
      map.set(cat, (map.get(cat) ?? 0) + wms);
    }
    return map;
  }

  // 現在選択中の期間
  let _periodDays = 1;        // 1=今日
  let _periodCustomFrom = ''; // YYYY-MM-DD
  let _periodCustomTo   = '';

  // ── 日別履歴（セッション表示） ────────────────────────────────────────────────

  async function loadDailyHistory() {
    const container = el('tc-history-list');
    if (!container) return;

    const maxDays = _periodCustomFrom ? _customPeriodDays() : _periodDays;
    const history = await fetchDailyHistory(maxDays).catch(() => null);
    if (!history) {
      container.innerHTML = '<div class="tc-history-empty">履歴を取得できませんでした</div>';
      return;
    }

    // 期間フィルタ
    const filteredHistory = filterHistoryByPeriod(history);

    if (filteredHistory.length === 0) {
      container.innerHTML = '<div class="tc-history-empty">打刻履歴がありません</div>';
      renderCategoryBreakdown([]);
      return;
    }

    const catTag = cat => {
      if (!cat) return '';
      const s = CATEGORY_COLOR[cat] ?? { bg: 'rgba(110,118,129,0.15)', color: '#8b949e' };
      return `<span class="tc-cat-tag" style="background:${s.bg};color:${s.color}">${esc(cat)}</span>`;
    };

    const nowMs = Date.now();

    // 全打刻を時系列で結合
    const allPunches = filteredHistory
      .flatMap(d => d.punches)
      .sort((a, b) => a.at_ms - b.at_ms || a.seq - b.seq);

    const sessions = computeSessions(allPunches, nowMs);
    renderCategoryBreakdown(sessions, nowMs);

    if (sessions.length === 0) {
      container.innerHTML = '<div class="tc-history-empty">打刻履歴がありません</div>';
      return;
    }

    // セッション行を新しい順で表示
    const rows = [...sessions].reverse().map((s, revIdx) => {
      const idx = sessions.length - 1 - revIdx;
      const wMs  = sessionWorkMs(s, nowMs);
      const bMs  = sessionBreakMs(s, nowMs);
      const startDisp = fmtTimeSec(s.inMs);
      const endDisp   = s.open ? '<span class="tc-day-live">作業中</span>' : fmtTimeSec(s.outMs);
      const cat       = s.category || '（未設定）';
      const catS      = CATEGORY_COLOR[s.category] ?? { bg: 'rgba(110,118,129,0.15)', color: '#8b949e' };

      // セッション開始日付（JST）
      const sessionDateStr = new Date(s.inMs + JST_OFFSET_MS).toISOString().slice(0, 10);
      const sessionDateDisp = fmtDate(sessionDateStr);

      const nightWMs  = sessionNightWorkMs(s, nowMs);
      const nightBadge = nightWMs >= 60000
        ? `<span class="tc-night-session-badge">🌙 ${esc(fmtMs(nightWMs))}</span>`
        : '';

      const workDisp  = s.open
        ? `<span id="tc-live-row-work">${esc(fmtMsLong(wMs))}</span>${nightBadge}`
        : `${esc(fmtMsLong(wMs))}${nightBadge}`;
      const breakDisp = s.open
        ? `<span id="tc-live-row-break">${esc(fmtMs(bMs))}</span>`
        : esc(fmtMs(bMs));

      const punchRows = s.punches.map(p => `
        <div class="tc-day-punch-row">
          <span class="tc-punch-time">${esc(fmtTimeSec(p.at_ms))}</span>
          <span class="tc-punch-kind ${KIND_CLS[p.kind] ?? ''}">${esc(KIND_LABEL[p.kind] ?? p.kind)}</span>
          <span class="tc-punch-loc">${esc(p.location)}</span>
          ${p.category ? catTag(p.category) : ''}
          <button class="tc-delete-btn" data-id="${esc(p.id)}" title="削除">✕</button>
        </div>
      `).join('');

      return `
        <div class="tc-session-row">
          <div class="tc-session-summary">
            <span class="tc-session-date">${esc(sessionDateDisp)}</span>
            <span class="tc-session-time">${esc(startDisp)}〜${endDisp}</span>
            <span class="tc-session-cat" style="background:${catS.bg};color:${catS.color}">${esc(cat)}</span>
            <span class="tc-session-loc">${esc(s.location || '—')}</span>
            <span class="tc-session-work">${workDisp}</span>
            <span class="tc-session-break">${breakDisp}</span>
            <span class="tc-day-arrow">›</span>
          </div>
          <div class="tc-session-detail" hidden>
            ${punchRows || '<div class="tc-history-empty">打刻なし</div>'}
          </div>
        </div>
      `;
    }).join('');

    container.innerHTML = rows;

    // アコーディオントグル
    container.querySelectorAll('.tc-session-summary').forEach(summary => {
      summary.addEventListener('click', () => {
        const detail = summary.nextElementSibling;
        if (!detail) return;
        detail.hidden = !detail.hidden;
        const arrow = summary.querySelector('.tc-day-arrow');
        if (arrow) arrow.textContent = detail.hidden ? '›' : '‹';
        summary.classList.toggle('tc-day-open', !detail.hidden);
      });
    });

    // 削除ボタン
    container.querySelectorAll('.tc-delete-btn').forEach(btn => {
      btn.addEventListener('click', async e => {
        e.stopPropagation();
        const id = btn.dataset.id;
        if (!id) return;
        btn.disabled = true;
        btn.textContent = '…';
        try {
          const r = await fetch(`/api/tc/punch/${encodeURIComponent(id)}`, { method: 'DELETE' });
          const data = await r.json();
          if (data.ok) {
            await fetchStatus();
            await renderAll();
            await loadDailyHistory();
          } else {
            showError(data.error ?? '削除に失敗しました');
            btn.disabled = false;
            btn.textContent = '✕';
          }
        } catch (_) {
          showError('削除に失敗しました');
          btn.disabled = false;
          btn.textContent = '✕';
        }
      });
    });
  }

  // ── カテゴリ集計レンダリング ───────────────────────────────────────────────────

  function renderCategoryBreakdown(sessions, nowMs = Date.now()) {
    const el_bd = el('tc-category-breakdown');
    if (!el_bd) return;

    if (sessions.length === 0) {
      el_bd.innerHTML = '';
      return;
    }

    const map = calcCategoryBreakdown(sessions, nowMs);
    const totalWork = [...map.values()].reduce((a, b) => a + b, 0);

    const items = [...map.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([cat, wMs]) => {
        const s = CATEGORY_COLOR[cat] ?? { bg: 'rgba(110,118,129,0.15)', color: '#8b949e' };
        const pct = totalWork > 0 ? Math.round(wMs / totalWork * 100) : 0;
        return `
          <div class="tc-cat-bar-row">
            <span class="tc-cat-bar-label" style="color:${s.color}">${esc(cat)}</span>
            <div class="tc-cat-bar-wrap">
              <div class="tc-cat-bar-fill" style="width:${pct}%;background:${s.color}20;border-color:${s.color}"></div>
            </div>
            <span class="tc-cat-bar-val">${esc(fmtMs(wMs))}</span>
          </div>
        `;
      }).join('');

    const nightMs   = calcNightWorkMs(sessions, nowMs);
    const nightHtml = nightMs >= 60000
      ? `<div class="tc-night-badge">🌙 深夜 ${esc(fmtMs(nightMs))}</div>`
      : '';

    el_bd.innerHTML = `
      <div class="tc-cat-breakdown-inner">
        <div class="tc-cat-total">合計作業 ${esc(fmtMs(totalWork))}${nightHtml}</div>
        ${items}
      </div>
    `;
  }

  // ── 期間フィルタ ─────────────────────────────────────────────────────────────

  function filterHistoryByPeriod(history) {
    if (_periodCustomFrom && _periodCustomTo) {
      return history.filter(d => d.date >= _periodCustomFrom && d.date <= _periodCustomTo);
    }
    if (_periodDays === 1) {
      // 今日のみ
      const todayStr = new Date(Date.now() + JST_OFFSET_MS).toISOString().slice(0, 10);
      return history.filter(d => d.date === todayStr);
    }
    if (_periodDays === 7) {
      // 今週（月曜日〜今日）
      const todayMs  = Date.now();
      const todayJst = new Date(todayMs + JST_OFFSET_MS);
      const dow      = todayJst.getUTCDay(); // 0=Sun
      const monday   = new Date(todayMs + JST_OFFSET_MS - ((dow === 0 ? 6 : dow - 1) * 86400000));
      const mondayStr = monday.toISOString().slice(0, 10);
      const todayStr  = todayJst.toISOString().slice(0, 10);
      return history.filter(d => d.date >= mondayStr && d.date <= todayStr);
    }
    if (_periodDays === 30) {
      // 今月（1日〜今日）
      const todayJst = new Date(Date.now() + JST_OFFSET_MS);
      const year  = todayJst.getUTCFullYear();
      const month = String(todayJst.getUTCMonth() + 1).padStart(2, '0');
      const monthStart = `${year}-${month}-01`;
      const todayStr   = todayJst.toISOString().slice(0, 10);
      return history.filter(d => d.date >= monthStart && d.date <= todayStr);
    }
    return history;
  }

  function _customPeriodDays() {
    if (!_periodCustomFrom || !_periodCustomTo) return 30;
    const from = new Date(_periodCustomFrom + 'T00:00:00+09:00');
    const to   = new Date(_periodCustomTo   + 'T23:59:59+09:00');
    return Math.ceil((to - from) / 86400000) + 2;
  }

  // "H時間M分S秒" 形式（3桁以上の秒も対応）
  function fmtMsLong(ms) {
    if (!ms || ms <= 0) return '0分';
    const totalSec = Math.floor(ms / 1000);
    const h   = Math.floor(totalSec / 3600);
    const m   = Math.floor((totalSec % 3600) / 60);
    const s   = totalSec % 60;
    if (h === 0 && m === 0) return `${s}秒`;
    if (h === 0) return `${m}分${s > 0 ? s + '秒' : ''}`;
    return `${h}時間${m}分${s > 0 ? s + '秒' : ''}`;
  }

  // ── エラー表示 ────────────────────────────────────────────────────────────────

  function showError(msg) {
    const e = el('tc-error');
    if (e) { e.textContent = msg; e.style.display = ''; }
  }
  function hideError() {
    const e = el('tc-error');
    if (e) { e.textContent = ''; e.style.display = 'none'; }
  }
  function setButtonsDisabled(disabled) {
    ['tc-btn-in','tc-btn-out','tc-btn-break','tc-btn-resume'].forEach(id => {
      const b = el(id);
      if (b) b.disabled = disabled;
    });
  }

  // ── 初期化 ───────────────────────────────────────────────────────────────────

  async function init() {
    if (_clockTimer) clearInterval(_clockTimer);
    _clockTimer = setInterval(updateClock, 1000);
    updateClock();

    try { await fetchStatus(); } catch (_) {}
    await renderAll();
    await loadDailyHistory();

    // ボタンイベント
    el('tc-btn-in')?.addEventListener('click', () => {
      const loc = getSelectedLocation();
      if (!loc) { showError('作業場所を選択または入力してください'); return; }
      _location = loc;
      _category = getSelectedCategory();
      doPunch('in');
    });
    el('tc-btn-out')   ?.addEventListener('click', () => doPunch('out'));
    el('tc-btn-break') ?.addEventListener('click', () => doPunch('break_start'));
    el('tc-btn-resume')?.addEventListener('click', () => doPunch('break_end'));

    // 場所選択
    el('tc-location-select')?.addEventListener('change', function () {
      const custom = el('tc-location-custom');
      if (this.value === '__custom__') {
        if (custom) custom.style.display = '';
      } else {
        if (custom) custom.style.display = 'none';
        _location = this.value;
      }
    });
    el('tc-location-custom')?.addEventListener('input', function () {
      const v = this.value.trim().slice(0, 60);
      if (v) _location = v;
    });

    // カテゴリ選択
    el('tc-category-select')?.addEventListener('change', function () {
      const custom = el('tc-category-custom');
      if (this.value === '__custom__') {
        if (custom) custom.style.display = '';
      } else {
        if (custom) custom.style.display = 'none';
        _category = this.value;
      }
    });
    el('tc-category-custom')?.addEventListener('input', function () {
      const v = this.value.trim().slice(0, 40);
      if (v) _category = v;
    });

    // 再読込ボタン
    el('tc-reload-btn')?.addEventListener('click', async () => {
      hideError();
      try { await fetchStatus(); await renderAll(); await loadDailyHistory(); } catch (_) {}
    });

    // 期間タブ
    document.querySelectorAll('.tc-period-tab').forEach(btn => {
      btn.addEventListener('click', () => {
        document.querySelectorAll('.tc-period-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        const period = btn.dataset.period;
        const customRow = el('tc-period-custom-row');
        if (period === 'custom') {
          if (customRow) customRow.style.display = '';
        } else {
          if (customRow) customRow.style.display = 'none';
          _periodCustomFrom = '';
          _periodCustomTo   = '';
          if (period === 'today') _periodDays = 1;
          else if (period === 'week')  _periodDays = 7;
          else if (period === 'month') _periodDays = 30;
          loadDailyHistory();
        }
      });
    });

    el('tc-period-apply')?.addEventListener('click', () => {
      const from = el('tc-period-from')?.value;
      const to   = el('tc-period-to')?.value;
      if (!from || !to) return;
      _periodCustomFrom = from;
      _periodCustomTo   = to;
      loadDailyHistory();
    });

    // 30秒ごとに DB 再取得（他タブ打刻の補完的な同期）
    if (_refreshTimer) clearInterval(_refreshTimer);
    _refreshTimer = setInterval(async () => {
      try { await fetchStatus(); await renderAll(); await loadDailyHistory(); } catch (_) {}
      checkSnoozeCancel();
    }, 30 * 1000);

    // BroadcastChannel リスナー（他タブからの即時同期）
    if (_bc) {
      _bc.onmessage = async (e) => {
        if (!e.data || e.data.tabId === _tabId) return;
        if (e.data.type === 'punch') {
          try { await fetchStatus(); await renderAll(); } catch (_) {}
          checkSnoozeCancel();
        }
        if (e.data.type === 'notif_claim') {
          markFiredToday(e.data.notifId);
        }
        if (e.data.type === 'timer_update') {
          // 他タブのタイマー状態を同期
          _timerState = e.data.timerState ?? null;
          saveTimerState();
          stopTimerInterval();
          if (_timerState && _timerState.pausedRemaining === null) {
            const rem = timerRemainingMs();
            if (rem > 0) startTimerInterval();
          }
          renderTimer();
        }
      };
    }

    // 通知初期化
    initNotifications();
    // タイマー初期化
    initTimer();
  }

  function getSelectedLocation() {
    const sel    = el('tc-location-select');
    const custom = el('tc-location-custom');
    if (!sel) return _location;
    if (sel.value === '__custom__') {
      const v = custom?.value?.trim().slice(0, 60) ?? '';
      return v || null;
    }
    return sel.value || null;
  }

  function getSelectedCategory() {
    const sel    = el('tc-category-select');
    const custom = el('tc-category-custom');
    if (!sel) return _category;
    if (sel.value === '__custom__') {
      return custom?.value?.trim().slice(0, 40) || '';
    }
    return sel.value || '';
  }

  // ── 通知 ─────────────────────────────────────────────────────────────────────

  const NOTIF_DEFAULTS = [
    {
      id: 'lunch',
      enabled: true,
      time: '12:30',
      message: '昼休憩の時間です',
      condition: 'working',
      actionLabel: '休憩を開始する',
      actionKind: 'break_start',
      days: [0,1,2,3,4,5,6],
    },
    {
      id: 'evening',
      enabled: true,
      time: '17:30',
      message: '夕方の作業を一度終了する時間です',
      condition: 'active',
      actionLabel: '一度作業を終了する',
      actionKind: 'out',
      days: [0,1,2,3,4,5,6],
    },
    {
      id: 'work_end',
      enabled: true,
      time: '23:30',
      message: '深夜になりました。作業を終了しませんか？',
      condition: 'active',
      actionLabel: '作業を終了する',
      actionKind: 'out',
      days: [0,1,2,3,4,5,6],
    },
  ];

  function loadNotifSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem('tc_notif_settings') || 'null');
      if (!saved) return NOTIF_DEFAULTS.map(d => ({ ...d }));
      return NOTIF_DEFAULTS.map(def => {
        const s = saved.find(x => x.id === def.id);
        if (!s) return { ...def };
        return {
          ...def,
          enabled: typeof s.enabled === 'boolean' ? s.enabled : def.enabled,
          time:    typeof s.time    === 'string'  ? s.time    : def.time,
          days:    Array.isArray(s.days)           ? s.days    : def.days,
        };
      });
    } catch (_) {
      return NOTIF_DEFAULTS.map(d => ({ ...d }));
    }
  }

  function saveNotifSettings() {
    localStorage.setItem('tc_notif_settings', JSON.stringify(
      _notifSettings.map(s => ({ id: s.id, enabled: s.enabled, time: s.time, days: s.days }))
    ));
  }

  // ── カスタム通知 ──────────────────────────────────────────────────────────────

  const CUSTOM_NOTIFS_KEY = 'tc_custom_notifs';

  function loadCustomNotifs() {
    try {
      const saved = JSON.parse(localStorage.getItem(CUSTOM_NOTIFS_KEY) || '[]');
      return Array.isArray(saved) ? saved : [];
    } catch (_) { return []; }
  }

  function saveCustomNotifs() {
    localStorage.setItem(CUSTOM_NOTIFS_KEY, JSON.stringify(_customNotifs));
  }

  function genCustomId() {
    return `custom_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  }

  let _customNotifs = loadCustomNotifs();

  /** システム通知＋カスタム通知を結合して返す */
  function allNotifs() {
    return [..._notifSettings, ..._customNotifs];
  }

  let _notifSettings   = loadNotifSettings();
  const _snoozeTimers  = {};   // { notifId: timeoutId }
  let _notifCheckTimer = null;

  function jstHHMM(baseMs = Date.now()) {
    const d = new Date(baseMs + JST_OFFSET_MS);
    return `${String(d.getUTCHours()).padStart(2,'0')}:${String(d.getUTCMinutes()).padStart(2,'0')}`;
  }

  function jstTodayStr(baseMs = Date.now()) {
    return new Date(baseMs + JST_OFFSET_MS).toISOString().slice(0, 10);
  }

  /**
   * テストモード時（localStorage.tc_test_mode === '1'）は
   * tc_test_ プレフィックスを付けてデータを隔離する。
   * 本番の発火履歴・ロックキーには一切触れない。
   */
  function testKey(base) {
    try { return localStorage.getItem('tc_test_mode') === '1' ? `tc_test_${base}` : base; }
    catch (_) { return base; }
  }

  function hasFiredToday(notifId) {
    try {
      const fired = JSON.parse(localStorage.getItem(testKey('tc_notif_fired')) || '{}');
      return fired[notifId] === jstTodayStr(nowForNotif());
    } catch (_) { return false; }
  }

  function markFiredToday(notifId) {
    try {
      const key   = testKey('tc_notif_fired');
      const fired = JSON.parse(localStorage.getItem(key) || '{}');
      fired[notifId] = jstTodayStr(nowForNotif());
      localStorage.setItem(key, JSON.stringify(fired));
    } catch (_) {}
  }

  /**
   * テストモード中は tc_test_state を返す（本番 API・打刻データに影響しない）。
   * それ以外は実際の _state を返す。
   */
  function getEffectiveState() {
    try {
      if (localStorage.getItem('tc_test_mode') === '1') {
        const ts = localStorage.getItem('tc_test_state');
        if (ts) return ts;
      }
    } catch (_) {}
    return _state;
  }

  function stateMatchesCondition(condition) {
    const state = getEffectiveState();
    if (condition === 'working') return state === 'working';
    if (condition === 'active')  return state === 'working' || state === 'breaking';
    if (condition === 'always')  return true;
    return false;
  }

  const CLAIM_TTL_MS = 3000;

  /**
   * 通知発火の排他制御（1 タブだけに発火権を与える）
   *
   * Web Locks API が使えればそちらを優先。
   *   - navigator.locks.request(..., { ifAvailable: true }) でロックを試みる
   *   - 他タブが保持中なら lock=null → 即 false
   *   - ロック内で hasFiredToday を再確認してから markFiredToday
   *   - ロックは callback return まで保持（mark 直後に return するため極短時間）
   *
   * 使用不可環境（Safari 15 未満等）は localStorage + 50ms フォールバック。
   */
  async function tryClaimNotif(notifId) {
    if (hasFiredToday(notifId)) return false;

    if (typeof navigator !== 'undefined' && 'locks' in navigator) {
      return new Promise(resolve => {
        navigator.locks.request(
          testKey(`tc_notif_${notifId}`),
          { ifAvailable: true },
          async lock => {
            if (!lock) { resolve(false); return; }
            // ロック内で再チェック（取得前に別タブが先着した場合に備えて）
            if (hasFiredToday(notifId)) { resolve(false); return; }
            markFiredToday(notifId);
            resolve(true);
          }
        );
      });
    }

    // ── localStorage フォールバック ─────────────────────────────────────────────
    const lockKey = testKey(`tc_notif_lock_${notifId}`);
    const today   = jstTodayStr(nowForNotif());
    const now     = Date.now();
    try {
      const existing = JSON.parse(localStorage.getItem(lockKey) || 'null');
      if (existing?.date === today && existing.tabId !== _tabId && (now - existing.claimedAt) < CLAIM_TTL_MS) {
        return false;
      }
    } catch (_) {}
    try {
      localStorage.setItem(lockKey, JSON.stringify({ tabId: _tabId, claimedAt: now, date: today }));
    } catch (_) { return false; }
    await new Promise(r => setTimeout(r, 50));
    try {
      const claim = JSON.parse(localStorage.getItem(lockKey) || 'null');
      if (!claim || claim.tabId !== _tabId || claim.date !== today) return false;
    } catch (_) { return false; }
    if (hasFiredToday(notifId)) return false;
    markFiredToday(notifId);
    return true;
  }

  /**
   * スヌーズ再通知の排他制御
   * 通常、スヌーズは1タブのみで予約される（初回通知が排他済みのため）。
   * 万一複数タブにタイマーが残っていても 1 タブだけ発火するよう保護する。
   *
   * Web Locks: ロックを 2 秒保持して同時発火ウィンドウをブロック。
   * フォールバック: 5 秒 TTL の localStorage クレーム。
   */
  async function tryClaimSnooze(notifId) {
    if (typeof navigator !== 'undefined' && 'locks' in navigator) {
      return new Promise(resolve => {
        navigator.locks.request(
          testKey(`tc_snooze_${notifId}`),
          { ifAvailable: true },
          async lock => {
            if (!lock) { resolve(false); return; }
            resolve(true);
            await new Promise(r => setTimeout(r, 2000));
          }
        );
      });
    }

    // ── localStorage フォールバック ─────────────────────────────────────────────
    const lockKey = testKey(`tc_snooze_lock_${notifId}`);
    const now = Date.now();
    try {
      const existing = JSON.parse(localStorage.getItem(lockKey) || 'null');
      if (existing && (now - existing.claimedAt) < 5000 && existing.tabId !== _tabId) return false;
      localStorage.setItem(lockKey, JSON.stringify({ tabId: _tabId, claimedAt: now }));
    } catch (_) { return false; }
    return true;
  }

  function cancelSnooze(notifId) {
    if (_snoozeTimers[notifId]) {
      clearTimeout(_snoozeTimers[notifId]);
      delete _snoozeTimers[notifId];
    }
  }

  function scheduleSnooze(cfg) {
    cancelSnooze(cfg.id);
    const delay = snoozeDuration();
    _snoozeTimers[cfg.id] = setTimeout(async () => {
      delete _snoozeTimers[cfg.id];
      if (!cfg.enabled) return;
      // テストモード中はサーバー呼び出しをスキップ（本番打刻データに触れない）
      if (localStorage.getItem('tc_test_mode') !== '1') {
        try { await fetchStatus(); } catch (_) {}
      }
      if (!stateMatchesCondition(cfg.condition)) return;
      // スヌーズも排他制御（複数タブにタイマーが残っていた場合の重複防止）
      const claimed = await tryClaimSnooze(cfg.id);
      if (!claimed) return;
      showNotifBanner(cfg);
      showBrowserNotif(cfg);
    }, delay);
  }

  // 状態変化後にスヌーズ条件を再確認し、不要なものをキャンセル
  function checkSnoozeCancel() {
    for (const notifId of Object.keys(_snoozeTimers)) {
      const cfg = allNotifs().find(s => s.id === notifId);
      if (!cfg || !stateMatchesCondition(cfg.condition)) {
        cancelSnooze(notifId);
        document.getElementById(`tc-notif-banner-${notifId}`)?.remove();
      }
    }
  }

  function showNotifBanner(cfg, { force = false } = {}) {
    // 既存バナーを閉じてから表示
    document.getElementById(`tc-notif-banner-${cfg.id}`)?.remove();
    if (!force && !stateMatchesCondition(cfg.condition)) return;

    const hasAction = !!cfg.actionKind;
    const banner = document.createElement('div');
    banner.id        = `tc-notif-banner-${cfg.id}`;
    banner.className = 'tc-notif-banner';
    banner.innerHTML = `
      <div class="tc-notif-body">
        <span class="tc-notif-icon">🔔</span>
        <span class="tc-notif-msg">${cfg.name ? `<b>${esc(cfg.name)}</b> ` : ''}${esc(cfg.message)}</span>
      </div>
      <div class="tc-notif-btns">
        ${hasAction ? `<button class="tc-notif-action">${esc(cfg.actionLabel)}</button>` : ''}
        <button class="tc-notif-snooze">10分後に再通知</button>
        <button class="tc-notif-dismiss">閉じる</button>
      </div>
    `;

    // 打刻ボタン（action がある場合のみ）
    if (hasAction) {
      banner.querySelector('.tc-notif-action').addEventListener('click', async () => {
        banner.remove();
        cancelSnooze(cfg.id);
        try { await fetchStatus(); } catch (_) {}
        if (!stateMatchesCondition(cfg.condition)) return;
        await doPunch(cfg.actionKind);
      });
    }

    // スヌーズ
    banner.querySelector('.tc-notif-snooze').addEventListener('click', () => {
      banner.remove();
      scheduleSnooze(cfg);
    });

    // 閉じる
    banner.querySelector('.tc-notif-dismiss').addEventListener('click', () => {
      banner.remove();
      cancelSnooze(cfg.id);
    });

    const area = el('tc-notif-area');
    if (area) area.appendChild(banner);
  }

  function showBrowserNotif(cfg) {
    if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
    try {
      const n = new Notification('JARVIS タイムカード', {
        body: cfg.message,
        tag:  `tc-${cfg.id}`,   // 同タグは上書き（重複防止）
      });
      n.onclick = () => { window.focus(); n.close(); };
      setTimeout(() => n.close(), 30000);
    } catch (_) {}
  }

  // 毎分チェック（async: tryClaimNotif の 50ms 待機を含む）
  async function checkNotifications() {
    const baseMs  = nowForNotif();
    const nowHHMM = jstHHMM(baseMs);
    const nowDow  = new Date(baseMs + JST_OFFSET_MS).getUTCDay();

    for (const cfg of allNotifs()) {
      if (!cfg.enabled)               continue;
      if (!cfg.days.includes(nowDow)) continue;
      if (hasFiredToday(cfg.id))      continue;
      if (cfg.time !== nowHHMM)       continue;
      if (!stateMatchesCondition(cfg.condition)) continue;

      const claimed = await tryClaimNotif(cfg.id);
      if (!claimed) continue;

      _bc?.postMessage({ type: 'notif_claim', tabId: _tabId, notifId: cfg.id });
      showNotifBanner(cfg);
      showBrowserNotif(cfg);
    }
  }

  // 通知設定パネルのレンダリング
  function renderNotifSettings() {
    const panel = el('tc-settings-panel');
    if (!panel) return;

    const permStatus = typeof Notification === 'undefined' ? 'unsupported' : Notification.permission;
    const permLabel = {
      granted:     '通知：許可済み ✓',
      denied:      '通知：ブロック中（ブラウザ設定から変更してください）',
      unsupported: '通知：このブラウザでは非対応',
      default:     '通知の許可を求める',
    }[permStatus] ?? '通知の許可を求める';
    const permDisabled = permStatus !== 'default';

    const DAY_LABELS = ['日','月','火','水','木','金','土'];
    const COND_LABEL = {
      working: '作業中のみ',
      active:  '作業中・休憩中',
      always:  '状態に関係なく',
    };

    const sysRows = _notifSettings.map(cfg => {
      const dayBoxes = [1,2,3,4,5,0,6].map(d => `
        <label class="tc-day-chk">
          <input type="checkbox" data-notif-id="${esc(cfg.id)}" data-src="sys" data-field="day" data-day="${d}"
                 ${cfg.days.includes(d) ? 'checked' : ''}>
          <span>${DAY_LABELS[d]}</span>
        </label>
      `).join('');

      return `
        <div class="tc-settings-row">
          <div class="tc-settings-row-head">
            <label class="tc-settings-toggle">
              <input type="checkbox" data-notif-id="${esc(cfg.id)}" data-src="sys" data-field="enabled"
                     ${cfg.enabled ? 'checked' : ''}>
              <span class="tc-settings-name">${esc(cfg.message)}</span>
            </label>
            <input type="time" class="tc-settings-time"
                   data-notif-id="${esc(cfg.id)}" data-src="sys" data-field="time"
                   value="${esc(cfg.time)}">
          </div>
          <div class="tc-settings-days">${dayBoxes}</div>
          <div class="tc-settings-cond">${COND_LABEL[cfg.condition] ?? cfg.condition}</div>
        </div>
      `;
    }).join('');

    const customRows = _customNotifs.map(cfg => {
      const dayBoxes = [1,2,3,4,5,0,6].map(d => `
        <label class="tc-day-chk">
          <input type="checkbox" data-notif-id="${esc(cfg.id)}" data-src="custom" data-field="day" data-day="${d}"
                 ${cfg.days.includes(d) ? 'checked' : ''}>
          <span>${DAY_LABELS[d]}</span>
        </label>
      `).join('');

      return `
        <div class="tc-settings-row tc-settings-row-custom" data-custom-id="${esc(cfg.id)}">
          <div class="tc-settings-row-head">
            <label class="tc-settings-toggle">
              <input type="checkbox" data-notif-id="${esc(cfg.id)}" data-src="custom" data-field="enabled"
                     ${cfg.enabled ? 'checked' : ''}>
              <span class="tc-settings-name">${esc(cfg.name || cfg.message)}</span>
            </label>
            <input type="time" class="tc-settings-time"
                   data-notif-id="${esc(cfg.id)}" data-src="custom" data-field="time"
                   value="${esc(cfg.time)}">
            <button class="tc-custom-edit-btn" data-custom-id="${esc(cfg.id)}">編集</button>
            <button class="tc-custom-del-btn"  data-custom-id="${esc(cfg.id)}">削除</button>
          </div>
          <div class="tc-settings-days">${dayBoxes}</div>
          <div class="tc-settings-cond">${COND_LABEL[cfg.condition] ?? cfg.condition}</div>
        </div>
      `;
    }).join('');

    panel.innerHTML = `
      <details class="tc-settings-details">
        <summary class="tc-settings-summary">通知設定</summary>
        <div class="tc-settings-body">
          <div class="tc-settings-perm-row">
            <button class="tc-notif-perm-btn" id="tc-notif-perm-btn"
                    ${permDisabled ? 'disabled' : ''}>${esc(permLabel)}</button>
          </div>
          <div class="tc-settings-section-label">システム通知</div>
          ${sysRows}
          <div class="tc-settings-section-label" style="margin-top:12px">カスタム通知</div>
          ${customRows || '<div class="tc-settings-empty">カスタム通知がありません</div>'}
          <button class="tc-add-custom-btn" id="tc-add-custom-btn">+ 通知を追加</button>
        </div>
      </details>

      <!-- カスタム通知編集モーダル -->
      <div id="tc-custom-notif-modal" class="tc-custom-modal" style="display:none">
        <div class="tc-custom-modal-inner">
          <div class="tc-settings-section-label">通知の設定</div>
          <div class="tc-custom-form-row">
            <label>通知名</label>
            <input id="tc-cn-name" type="text" maxlength="30" placeholder="例: ストレッチ">
          </div>
          <div class="tc-custom-form-row">
            <label>メッセージ</label>
            <input id="tc-cn-msg" type="text" maxlength="80" placeholder="例: ストレッチの時間です">
          </div>
          <div class="tc-custom-form-row">
            <label>時刻</label>
            <input id="tc-cn-time" type="time" value="15:00">
          </div>
          <div class="tc-custom-form-row">
            <label>通知条件</label>
            <select id="tc-cn-cond">
              <option value="working">作業中のみ</option>
              <option value="active">作業中・休憩中</option>
              <option value="always">状態に関係なく</option>
            </select>
          </div>
          <div class="tc-custom-form-row">
            <label>曜日</label>
            <div class="tc-settings-days tc-cn-days">
              ${[1,2,3,4,5,0,6].map(d => `
                <label class="tc-day-chk">
                  <input type="checkbox" class="tc-cn-day" data-day="${d}" checked>
                  <span>${DAY_LABELS[d]}</span>
                </label>
              `).join('')}
            </div>
          </div>
          <div class="tc-custom-modal-btns">
            <button id="tc-cn-save" class="tc-custom-save-btn">保存</button>
            <button id="tc-cn-cancel" class="tc-custom-cancel-btn">キャンセル</button>
          </div>
        </div>
      </div>
    `;

    // 通知許可ボタン
    panel.querySelector('#tc-notif-perm-btn')?.addEventListener('click', async () => {
      try { await Notification.requestPermission(); } catch (_) {}
      renderNotifSettings();
    });

    // システム通知設定変更
    panel.querySelectorAll('[data-src="sys"]').forEach(input => {
      input.addEventListener('change', () => {
        const id  = input.dataset.notifId;
        const fld = input.dataset.field;
        const cfg = _notifSettings.find(s => s.id === id);
        if (!cfg) return;
        if (fld === 'enabled') cfg.enabled = input.checked;
        if (fld === 'time')    cfg.time    = input.value;
        if (fld === 'day') {
          const d = parseInt(input.dataset.day, 10);
          cfg.days = input.checked
            ? [...new Set([...cfg.days, d])]
            : cfg.days.filter(x => x !== d);
        }
        saveNotifSettings();
      });
    });

    // カスタム通知 ON/OFF・時刻・曜日変更
    panel.querySelectorAll('[data-src="custom"]').forEach(input => {
      input.addEventListener('change', () => {
        const id  = input.dataset.notifId;
        const fld = input.dataset.field;
        const cfg = _customNotifs.find(s => s.id === id);
        if (!cfg) return;
        if (fld === 'enabled') cfg.enabled = input.checked;
        if (fld === 'time')    cfg.time    = input.value;
        if (fld === 'day') {
          const d = parseInt(input.dataset.day, 10);
          cfg.days = input.checked
            ? [...new Set([...cfg.days, d])]
            : cfg.days.filter(x => x !== d);
        }
        saveCustomNotifs();
      });
    });

    // カスタム通知削除
    panel.querySelectorAll('.tc-custom-del-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = btn.dataset.customId;
        if (!confirm('この通知を削除しますか？')) return;
        _customNotifs = _customNotifs.filter(c => c.id !== id);
        saveCustomNotifs();
        cancelSnooze(id);
        document.getElementById(`tc-notif-banner-${id}`)?.remove();
        renderNotifSettings();
      });
    });

    // カスタム通知編集
    panel.querySelectorAll('.tc-custom-edit-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        openCustomModal(btn.dataset.customId);
      });
    });

    // 追加ボタン
    el('tc-add-custom-btn')?.addEventListener('click', () => openCustomModal(null));

    // モーダル保存
    el('tc-cn-save')?.addEventListener('click', () => saveCustomModal());
    el('tc-cn-cancel')?.addEventListener('click', () => {
      el('tc-custom-notif-modal').style.display = 'none';
    });
  }

  let _editingCustomId = null;

  function openCustomModal(editId) {
    _editingCustomId = editId;
    const modal = el('tc-custom-notif-modal');
    if (!modal) return;

    if (editId) {
      const cfg = _customNotifs.find(c => c.id === editId);
      if (!cfg) return;
      el('tc-cn-name').value = cfg.name ?? '';
      el('tc-cn-msg').value  = cfg.message ?? '';
      el('tc-cn-time').value = cfg.time ?? '15:00';
      el('tc-cn-cond').value = cfg.condition ?? 'working';
      modal.querySelectorAll('.tc-cn-day').forEach(cb => {
        const d = parseInt(cb.dataset.day, 10);
        cb.checked = cfg.days.includes(d);
      });
    } else {
      el('tc-cn-name').value = '';
      el('tc-cn-msg').value  = '';
      el('tc-cn-time').value = '15:00';
      el('tc-cn-cond').value = 'working';
      modal.querySelectorAll('.tc-cn-day').forEach(cb => { cb.checked = true; });
    }

    modal.style.display = 'block';
  }

  function saveCustomModal() {
    const modal  = el('tc-custom-notif-modal');
    const name   = el('tc-cn-name').value.trim();
    const msg    = el('tc-cn-msg').value.trim();
    const time   = el('tc-cn-time').value;
    const cond   = el('tc-cn-cond').value;
    const days   = Array.from(modal.querySelectorAll('.tc-cn-day:checked'))
                        .map(cb => parseInt(cb.dataset.day, 10));

    if (!msg) { alert('メッセージを入力してください'); return; }
    if (!time) { alert('時刻を設定してください'); return; }

    if (_editingCustomId) {
      const cfg = _customNotifs.find(c => c.id === _editingCustomId);
      if (cfg) { cfg.name = name; cfg.message = msg; cfg.time = time; cfg.condition = cond; cfg.days = days; }
    } else {
      _customNotifs.push({
        id:        genCustomId(),
        name,
        message:   msg,
        time,
        condition: cond,
        days,
        enabled:   true,
      });
    }

    saveCustomNotifs();
    modal.style.display = 'none';
    renderNotifSettings();
  }

  function initNotifications() {
    renderNotifSettings();
    if (_notifCheckTimer) clearInterval(_notifCheckTimer);
    _notifCheckTimer = setInterval(checkNotifications, 60 * 1000);
  }

  // ── 作業タイマー ──────────────────────────────────────────────────────────────

  const TIMER_STORE_KEY = 'tc_timer';
  const TIMER_SETTINGS_KEY = 'tc_timer_settings';

  // タイマー設定
  let _timerSettings = (() => {
    try {
      const s = JSON.parse(localStorage.getItem(TIMER_SETTINGS_KEY) || 'null');
      return {
        workMin:  (s?.workMin  && s.workMin  > 0) ? s.workMin  : 60,
        breakMin: (s?.breakMin && s.breakMin > 0) ? s.breakMin : 10,
      };
    } catch (_) { return { workMin: 60, breakMin: 10 }; }
  })();

  function saveTimerSettings() {
    localStorage.setItem(TIMER_SETTINGS_KEY, JSON.stringify(_timerSettings));
  }

  // タイマー状態 (null = 停止)
  // { type: 'work'|'break', endMs: number, pausedRemaining: number|null }
  let _timerState = (() => {
    try {
      const s = JSON.parse(localStorage.getItem(TIMER_STORE_KEY) || 'null');
      if (!s || !s.type) return null;
      return s;
    } catch (_) { return null; }
  })();

  let _timerInterval = null;

  function saveTimerState() {
    if (_timerState) {
      localStorage.setItem(TIMER_STORE_KEY, JSON.stringify(_timerState));
    } else {
      localStorage.removeItem(TIMER_STORE_KEY);
    }
  }

  function timerRemainingMs() {
    if (!_timerState) return 0;
    if (_timerState.pausedRemaining !== null && _timerState.pausedRemaining !== undefined) {
      return _timerState.pausedRemaining;
    }
    return Math.max(0, _timerState.endMs - Date.now());
  }

  function fmtTimerMs(ms) {
    if (ms <= 0) return '0:00';
    const totalSec = Math.ceil(ms / 1000);
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}:${String(s).padStart(2,'0')}`;
  }

  function renderTimer() {
    const labelEl = el('tc-timer-label');
    const remEl   = el('tc-timer-remaining');
    const btnStart  = el('tc-timer-start');
    const btnPause  = el('tc-timer-pause');
    const btnResume = el('tc-timer-resume');
    const btnReset  = el('tc-timer-reset');
    if (!labelEl || !remEl) return;

    const rem = timerRemainingMs();

    if (!_timerState) {
      // 停止状態
      labelEl.textContent = '作業タイマー';
      remEl.textContent = '—';
      remEl.className = 'tc-timer-remaining';
      btnStart.style.display  = '';
      btnPause.style.display  = 'none';
      btnResume.style.display = 'none';
      btnReset.style.display  = 'none';
    } else {
      const typeLabel = _timerState.type === 'work' ? '作業タイマー' : '休憩タイマー';
      labelEl.textContent = typeLabel;
      remEl.textContent = fmtTimerMs(rem);
      remEl.className = `tc-timer-remaining tc-timer-${_timerState.type} ${rem < 60000 ? 'tc-timer-urgent' : ''}`;

      const paused = _timerState.pausedRemaining !== null && _timerState.pausedRemaining !== undefined;
      btnStart.style.display  = 'none';
      btnPause.style.display  = paused ? 'none' : '';
      btnResume.style.display = paused ? '' : 'none';
      btnReset.style.display  = '';
    }

    // タイマー設定UIの同期
    const workSel = el('tc-timer-work-sel');
    const workCustom = el('tc-timer-work-custom');
    const breakInput = el('tc-timer-break-input');
    if (workSel && workCustom) {
      const w = _timerSettings.workMin;
      if (w === 60 || w === 90) {
        workSel.value = String(w);
        workCustom.style.display = 'none';
      } else {
        workSel.value = '0';
        workCustom.style.display = '';
        workCustom.value = String(w);
      }
    }
    if (breakInput) breakInput.value = String(_timerSettings.breakMin);
  }

  function startTimer(type) {
    const durationMin = type === 'work' ? _timerSettings.workMin : _timerSettings.breakMin;
    _timerState = {
      type,
      endMs: Date.now() + durationMin * 60 * 1000,
      pausedRemaining: null,
    };
    saveTimerState();
    startTimerInterval();
    renderTimer();
    // 他タブへ同期
    _bc?.postMessage({ type: 'timer_update', tabId: _tabId, timerState: _timerState });
  }

  function pauseTimer() {
    if (!_timerState || _timerState.pausedRemaining !== null) return;
    _timerState.pausedRemaining = Math.max(0, _timerState.endMs - Date.now());
    stopTimerInterval();
    saveTimerState();
    renderTimer();
    _bc?.postMessage({ type: 'timer_update', tabId: _tabId, timerState: _timerState });
  }

  function resumeTimer() {
    if (!_timerState || _timerState.pausedRemaining === null) return;
    _timerState.endMs = Date.now() + _timerState.pausedRemaining;
    _timerState.pausedRemaining = null;
    saveTimerState();
    startTimerInterval();
    renderTimer();
    _bc?.postMessage({ type: 'timer_update', tabId: _tabId, timerState: _timerState });
  }

  function resetTimer() {
    stopTimerInterval();
    _timerState = null;
    saveTimerState();
    renderTimer();
    // タイマー関連バナーを閉じる
    document.getElementById('tc-notif-banner-timer_work')?.remove();
    document.getElementById('tc-notif-banner-timer_break')?.remove();
    _bc?.postMessage({ type: 'timer_update', tabId: _tabId, timerState: null });
  }

  function stopTimerInterval() {
    if (_timerInterval) { clearInterval(_timerInterval); _timerInterval = null; }
  }

  function startTimerInterval() {
    stopTimerInterval();
    _timerInterval = setInterval(timerTick, 1000);
  }

  async function timerTick() {
    if (!_timerState || _timerState.pausedRemaining !== null) return;
    const rem = timerRemainingMs();
    renderTimer();
    if (rem <= 0) {
      stopTimerInterval();
      await onTimerExpire(_timerState.type);
    }
  }

  async function onTimerExpire(type) {
    // タイマーを停止状態に（バナー操作でアクションが決まる）
    _timerState = null;
    saveTimerState();
    renderTimer();

    if (type === 'work') {
      showTimerExpireBanner('work');
      showBrowserNotif({ id: 'timer_work', message: '作業時間が終了しました' });
    } else {
      showTimerExpireBanner('break');
      showBrowserNotif({ id: 'timer_break', message: '休憩時間が終了しました' });
    }
  }

  function showTimerExpireBanner(type) {
    const bannerId = `tc-notif-banner-timer_${type}`;
    document.getElementById(bannerId)?.remove();

    const banner = document.createElement('div');
    banner.id = bannerId;
    banner.className = 'tc-notif-banner tc-notif-timer';

    if (type === 'work') {
      banner.innerHTML = `
        <div class="tc-notif-body">
          <span class="tc-notif-icon">⏰</span>
          <span class="tc-notif-msg"><b>作業時間が終了しました</b></span>
        </div>
        <div class="tc-notif-btns">
          <button class="tc-timer-extend-btn">10分延長</button>
          <button class="tc-timer-break-action">休憩を開始する</button>
          <button class="tc-timer-banner-close">閉じる</button>
        </div>
      `;
      banner.querySelector('.tc-timer-extend-btn').addEventListener('click', () => {
        banner.remove();
        // 10分延長: 作業タイマーを10分で再開始
        _timerState = { type: 'work', endMs: Date.now() + 10 * 60 * 1000, pausedRemaining: null };
        saveTimerState();
        startTimerInterval();
        renderTimer();
        _bc?.postMessage({ type: 'timer_update', tabId: _tabId, timerState: _timerState });
      });
      banner.querySelector('.tc-timer-break-action').addEventListener('click', async () => {
        banner.remove();
        // 作業状態チェック
        try { await fetchStatus(); } catch (_) {}
        if (_state !== 'working') return;
        await doPunch('break_start');
        // break_start 成功後にタイマーはdoPunch内で開始される
      });
      banner.querySelector('.tc-timer-banner-close').addEventListener('click', () => {
        banner.remove();
      });
    } else {
      // 休憩終了
      banner.innerHTML = `
        <div class="tc-notif-body">
          <span class="tc-notif-icon">⏰</span>
          <span class="tc-notif-msg"><b>休憩時間が終了しました</b></span>
        </div>
        <div class="tc-notif-btns">
          <button class="tc-timer-resume-action">作業再開</button>
          <button class="tc-timer-banner-close">閉じる</button>
        </div>
      `;
      banner.querySelector('.tc-timer-resume-action').addEventListener('click', async () => {
        banner.remove();
        try { await fetchStatus(); } catch (_) {}
        if (_state !== 'breaking') return;
        await doPunch('break_end');
        // break_end 成功後に作業タイマーを開始
        if (_state === 'working') {
          startTimer('work');
        }
      });
      banner.querySelector('.tc-timer-banner-close').addEventListener('click', () => {
        banner.remove();
      });
    }

    const area = el('tc-notif-area');
    if (area) area.appendChild(banner);
  }

  function initTimer() {
    // タイマー設定UI
    const workSel    = el('tc-timer-work-sel');
    const workCustom = el('tc-timer-work-custom');
    const breakInput = el('tc-timer-break-input');

    workSel?.addEventListener('change', () => {
      const v = parseInt(workSel.value, 10);
      if (v === 0) {
        workCustom.style.display = '';
      } else {
        workCustom.style.display = 'none';
        _timerSettings.workMin = v;
        saveTimerSettings();
      }
    });
    workCustom?.addEventListener('change', () => {
      const v = parseInt(workCustom.value, 10);
      if (v > 0 && v <= 480) {
        _timerSettings.workMin = v;
        saveTimerSettings();
      }
    });
    breakInput?.addEventListener('change', () => {
      const v = parseInt(breakInput.value, 10);
      if (v > 0 && v <= 120) {
        _timerSettings.breakMin = v;
        saveTimerSettings();
      }
    });

    // タイマーボタン
    el('tc-timer-start')?.addEventListener('click', () => {
      if (_state !== 'working') {
        // タイマーは作業中のみ開始可能
        return;
      }
      startTimer('work');
    });
    el('tc-timer-pause')?.addEventListener('click', pauseTimer);
    el('tc-timer-resume')?.addEventListener('click', resumeTimer);
    el('tc-timer-reset')?.addEventListener('click', resetTimer);

    // ページ復元（再読み込み後のタイマー継続）
    if (_timerState && _timerState.pausedRemaining === null) {
      const rem = timerRemainingMs();
      if (rem > 0) {
        startTimerInterval();
      } else {
        // すでに期限切れ
        onTimerExpire(_timerState.type);
      }
    }

    renderTimer();
  }

  // ── 公開 ─────────────────────────────────────────────────────────────────────

  window.initTimecard = init;
  window.reloadTimecard = async () => {
    try { await fetchStatus(); await renderAll(); await loadDailyHistory(); } catch (_) {}
  };

  /**
   * ブラウザコンソール用テストユーティリティ
   * 本番の打刻データ・通知済みフラグには一切触れない。
   *
   * 使い方:
   *   tc_test.enable()              — テストモード有効（履歴を tc_test_ に隔離）
   *   tc_test.setState('working')   — テスト用勤務状態を設定（本番 API 不使用）
   *   tc_test.setTime('12:30')      — 通知判定時刻を 12:30 JST にモック
   *   tc_test.setSnooze(10000)      — スヌーズを 10 秒に短縮
   *   tc_test.fire()                — checkNotifications を手動発火
   *   tc_test.status()              — 現在のテスト設定を表示
   *   tc_test.clear()               — タイマー・バナー・モック・ls を全解除
   */
  window.tc_test = {
    enable() {
      localStorage.setItem('tc_test_mode', '1');
      console.info('[tc_test] テストモード有効（本番データは保護）');
    },
    /** テスト用の勤務状態を設定（サーバーへの打刻を行わない） */
    setState(state) {
      if (!['idle', 'working', 'breaking'].includes(state)) {
        console.warn('[tc_test] 有効な状態: idle / working / breaking'); return;
      }
      localStorage.setItem('tc_test_state', state);
      console.info(`[tc_test] テスト状態: ${state}`);
    },
    /**
     * テスト状態を完全解除
     *   - スヌーズタイマーをすべてキャンセル
     *   - 表示中のバナーをすべて除去
     *   - tc_test_* キーをすべて削除（本番データは無変更）
     */
    clear() {
      // スヌーズタイマー全キャンセル
      const timerIds = Object.keys(_snoozeTimers);
      timerIds.forEach(id => cancelSnooze(id));
      // 表示中バナーを除去
      document.querySelectorAll('[id^="tc-notif-banner-"]').forEach(b => b.remove());
      // tc_test_* キーを全消去
      const removed = [];
      for (const k of Object.keys(localStorage)) {
        if (k.startsWith('tc_test_')) { localStorage.removeItem(k); removed.push(k); }
      }
      console.info('[tc_test] キャンセルしたタイマー: ' + (timerIds.join(', ') || 'なし'));
      console.info('[tc_test] 消去したキー: ' + (removed.join(', ') || 'なし'));
      console.info('[tc_test] テスト完了 — バナー除去・タイマー停止・本番データは無変更');
    },
    setTime(hhmm) {
      const [h, m] = hhmm.split(':').map(Number);
      const todayJst = new Date(Date.now() + 9 * 3600000).toISOString().slice(0, 10);
      const mockMs = new Date(`${todayJst}T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00+09:00`).getTime();
      localStorage.setItem('tc_test_now', mockMs);
      console.info(`[tc_test] 通知判定時刻: ${hhmm} JST → ${new Date(mockMs).toISOString()}`);
    },
    setSnooze(ms) {
      localStorage.setItem('tc_test_snooze_ms', ms);
      console.info(`[tc_test] スヌーズ待ち: ${ms}ms`);
    },
    async fire() {
      console.info('[tc_test] checkNotifications を発火...');
      await checkNotifications();
      console.info('[tc_test] 完了（status() で結果を確認）');
    },
    status() {
      const tm  = localStorage.getItem('tc_test_mode');
      const tn  = localStorage.getItem('tc_test_now');
      const ts  = localStorage.getItem('tc_test_snooze_ms');
      const tst = localStorage.getItem('tc_test_state');
      const tf  = localStorage.getItem('tc_test_tc_notif_fired');
      const rf  = localStorage.getItem('tc_notif_fired');
      console.table({
        'mode':          tm  ?? '(off)',
        'test state':    tst ?? '(本番状態を使用)',
        'mock time':     tn  ? new Date(+tn).toISOString() + ' / ' + jstHHMM(+tn) + ' JST' : '(real)',
        'snooze ms':     ts  ?? '(600000)',
        'test fired':    tf  ?? '(none)',
        'real fired':    rf  ?? '(none)',
        'snooze timers': Object.keys(_snoozeTimers).join(', ') || 'なし',
        'timer state':   _timerState ? `${_timerState.type} rem=${fmtTimerMs(timerRemainingMs())} paused=${_timerState.pausedRemaining !== null}` : '停止中',
        'custom notifs': _customNotifs.length,
      });
    },
    timerStart(type = 'work') {
      _timerState = { type, endMs: Date.now() + 10 * 1000, pausedRemaining: null }; // 10秒テスト
      saveTimerState();
      startTimerInterval();
      renderTimer();
      console.info(`[tc_test] タイマー開始 type=${type} 10秒`);
    },
    timerReset() {
      resetTimer();
      console.info('[tc_test] タイマーリセット');
    },
  };
})();
