/* SF Task Notify — app.js
   IIFE でグローバルスコープを汚染しない
   localStorage のみ使用・JARVIS DB/API・taskpwa とは完全独立 */

(function () {
  'use strict';

  const TASKS_KEY   = 'sftn_tasks_v1';
  const NOTIFIED_KEY = 'sftn_notified_v1';

  const CAT_COLORS = {
    '音楽':   '#58a6ff',
    '小説':   '#9b7fe8',
    'SNS':    '#4ec9a0',
    'イラスト': '#f0a050',
    'その他': '#6e7681',
  };

  let tasks        = [];
  let notifiedMap  = {};   // { taskId: notifiedDate(YYYY-MM-DD) }
  let editingId    = null;
  let notifyTaskId = null;
  let audioCtx     = null;

  // ── Date helpers ──────────────────────────────────────────────────────────

  function localDateStr(d) {
    d = d || new Date();
    const y  = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const da = String(d.getDate()).padStart(2, '0');
    return `${y}-${mo}-${da}`;
  }

  function localDatetimeStr(d) {
    d = d || new Date();
    const h  = String(d.getHours()).padStart(2, '0');
    const mi = String(d.getMinutes()).padStart(2, '0');
    return `${localDateStr(d)}T${h}:${mi}`;
  }

  function fmtTime(startAt) {
    if (!startAt) return '';
    // startAt は "YYYY-MM-DDTHH:MM" — Date として解釈するとローカルタイム
    const d = new Date(startAt);
    return d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
  }

  function fmtDatetime(startAt) {
    if (!startAt) return '';
    const d = new Date(startAt);
    return d.toLocaleString('ja-JP', {
      month: 'numeric', day: 'numeric',
      hour: '2-digit', minute: '2-digit',
    });
  }

  function defaultStartAt() {
    const d = new Date();
    d.setMinutes(d.getMinutes() + 30);
    d.setSeconds(0, 0);
    return localDatetimeStr(d);
  }

  // ── Storage ───────────────────────────────────────────────────────────────

  function loadTasks() {
    try { tasks = JSON.parse(localStorage.getItem(TASKS_KEY) || '[]'); }
    catch { tasks = []; }
  }

  function saveTasks() {
    localStorage.setItem(TASKS_KEY, JSON.stringify(tasks));
  }

  function loadNotified() {
    try { notifiedMap = JSON.parse(localStorage.getItem(NOTIFIED_KEY) || '{}'); }
    catch { notifiedMap = {}; }
    // 今日以外のエントリを削除
    const today = localDateStr();
    for (const id of Object.keys(notifiedMap)) {
      if (notifiedMap[id] !== today) delete notifiedMap[id];
    }
    saveNotified();
  }

  function saveNotified() {
    localStorage.setItem(NOTIFIED_KEY, JSON.stringify(notifiedMap));
  }

  // ── Audio ─────────────────────────────────────────────────────────────────

  function ensureAudio() {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
  }

  function playChime() {
    try {
      ensureAudio();
      // 4音チャイム（A5, C#6, E6, A5）
      const freqs = [880, 1109, 1319, 880];
      freqs.forEach((freq, i) => {
        const t0   = audioCtx.currentTime + i * 0.2;
        const osc  = audioCtx.createOscillator();
        const gain = audioCtx.createGain();
        osc.connect(gain);
        gain.connect(audioCtx.destination);
        osc.type = 'sine';
        osc.frequency.setValueAtTime(freq, t0);
        gain.gain.setValueAtTime(0, t0);
        gain.gain.linearRampToValueAtTime(0.28, t0 + 0.04);
        gain.gain.exponentialRampToValueAtTime(0.001, t0 + 0.4);
        osc.start(t0);
        osc.stop(t0 + 0.4);
      });
    } catch (e) {
      console.warn('[sftn] audio error:', e.message);
    }
  }

  // ── Web Notifications ─────────────────────────────────────────────────────

  function updateNotifyUI() {
    const statusEl = document.getElementById('sftn-notify-status');
    const btn      = document.getElementById('sftn-notify-btn');
    if (!('Notification' in window)) {
      statusEl.textContent = '通知: 非対応';
      btn.hidden = true;
      return;
    }
    const p = Notification.permission;
    if (p === 'granted') {
      statusEl.textContent = '通知: ✓ 許可済み';
      statusEl.classList.add('sftn-granted');
      statusEl.classList.remove('sftn-denied');
      btn.hidden = true;
    } else if (p === 'denied') {
      statusEl.textContent = '通知: ✗ ブラウザ設定で許可してください';
      statusEl.classList.add('sftn-denied');
      statusEl.classList.remove('sftn-granted');
      btn.hidden = true;
    } else {
      statusEl.textContent = '通知: 未設定';
      statusEl.classList.remove('sftn-granted', 'sftn-denied');
      btn.hidden = false;
    }
  }

  function requestNotifyPermission() {
    Notification.requestPermission().then(updateNotifyUI);
  }

  function sendBrowserNotification(task) {
    if (Notification.permission !== 'granted') return;
    try {
      new Notification('❄ SF Task Notify', {
        body: task.name + (task.content ? '\n' + task.content : ''),
        icon: '/favicon.svg',
        tag: 'sftn_' + task.id,
      });
    } catch (e) {
      console.warn('[sftn] notification error:', e.message);
    }
  }

  // ── Task CRUD ─────────────────────────────────────────────────────────────

  function genId() {
    return 'sftn_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
  }

  function createTask(data) {
    const task = {
      id:        genId(),
      name:      data.name.trim(),
      content:   (data.content || '').trim(),
      startAt:   data.startAt,
      category:  data.category || 'その他',
      status:    'pending',
      createdAt: new Date().toISOString(),
    };
    tasks.push(task);
    saveTasks();
    return task;
  }

  function updateTask(id, patch) {
    const t = tasks.find(t => t.id === id);
    if (!t) return;
    Object.assign(t, patch);
    saveTasks();
  }

  function deleteTask(id) {
    tasks = tasks.filter(t => t.id !== id);
    delete notifiedMap[id];
    saveTasks();
    saveNotified();
  }

  function todayTasks() {
    const today = localDateStr();
    return tasks
      .filter(t => t.startAt && t.startAt.slice(0, 10) === today)
      .sort((a, b) => a.startAt.localeCompare(b.startAt));
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const STATUS_LABEL = { pending: '', completed: '✓ 完了', skipped: 'スキップ' };

  function esc(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function renderTasks() {
    const el    = document.getElementById('sftn-task-list');
    const list  = todayTasks();

    if (list.length === 0) {
      el.innerHTML = '<p class="sftn-empty">今日のタスクはありません</p>';
      return;
    }

    el.innerHTML = list.map(t => {
      const color       = CAT_COLORS[t.category] || CAT_COLORS['その他'];
      const doneClass   = t.status !== 'pending' ? 'sftn-task-done' : '';
      const notifClass  = notifiedMap[t.id] ? 'sftn-task-notified' : '';
      const statusLabel = STATUS_LABEL[t.status] || '';

      return `
<div class="sftn-task-card ${doneClass} ${notifClass}" data-id="${esc(t.id)}">
  <div class="sftn-task-cat-bar" style="background:${color}"></div>
  <div class="sftn-task-body">
    <div class="sftn-task-top">
      <span class="sftn-task-time">${esc(fmtTime(t.startAt))}</span>
      <span class="sftn-task-cat" style="color:${color}">${esc(t.category)}</span>
      ${statusLabel ? `<span class="sftn-task-status-label">${statusLabel}</span>` : ''}
    </div>
    <div class="sftn-task-name">${esc(t.name)}</div>
    ${t.content ? `<div class="sftn-task-content">${esc(t.content)}</div>` : ''}
  </div>
  <div class="sftn-task-actions">
    <button class="sftn-btn-icon" title="編集" data-action="edit" data-id="${esc(t.id)}">✎</button>
    <button class="sftn-btn-icon sftn-btn-danger" title="削除" data-action="delete" data-id="${esc(t.id)}">✕</button>
  </div>
</div>`;
    }).join('');
  }

  function updateDate() {
    const el = document.getElementById('sftn-date');
    el.textContent = new Date().toLocaleDateString('ja-JP', {
      year: 'numeric', month: 'long', day: 'numeric', weekday: 'short',
    });
  }

  // ── Form ──────────────────────────────────────────────────────────────────

  function openForm(task) {
    editingId = task ? task.id : null;
    document.getElementById('sftn-form-title').textContent = task ? 'タスクを編集' : 'タスクを追加';
    document.getElementById('sftn-f-name').value     = task ? task.name    : '';
    document.getElementById('sftn-f-content').value  = task ? task.content : '';
    document.getElementById('sftn-f-startat').value  = task ? task.startAt.slice(0, 16) : defaultStartAt();
    document.getElementById('sftn-f-category').value = task ? task.category : '音楽';
    document.getElementById('sftn-form-overlay').hidden = false;
    document.getElementById('sftn-f-name').focus();
  }

  function closeForm() {
    document.getElementById('sftn-form-overlay').hidden = true;
    editingId = null;
  }

  function submitForm(e) {
    e.preventDefault();
    const data = {
      name:     document.getElementById('sftn-f-name').value,
      content:  document.getElementById('sftn-f-content').value,
      startAt:  document.getElementById('sftn-f-startat').value,
      category: document.getElementById('sftn-f-category').value,
    };
    if (!data.name.trim() || !data.startAt) return;

    if (editingId) {
      const old = tasks.find(t => t.id === editingId);
      // 開始時刻が変わったら通知済みをリセット
      if (old && old.startAt !== data.startAt) {
        delete notifiedMap[editingId];
        saveNotified();
      }
      updateTask(editingId, data);
    } else {
      createTask(data);
    }
    closeForm();
    renderTasks();
  }

  // ── Notification popup ────────────────────────────────────────────────────

  function showNotifyPopup(task) {
    notifyTaskId = task.id;
    document.getElementById('sftn-notify-name').textContent    = task.name;
    document.getElementById('sftn-notify-meta').textContent    = fmtDatetime(task.startAt) + '  ｜  ' + task.category;
    document.getElementById('sftn-notify-content').textContent = task.content || '';
    document.getElementById('sftn-notify-overlay').hidden = false;

    // 通知済みとしてマーク
    notifiedMap[task.id] = localDateStr();
    saveNotified();

    playChime();
    sendBrowserNotification(task);
    renderTasks();
  }

  function closeNotifyPopup() {
    document.getElementById('sftn-notify-overlay').hidden = true;
    notifyTaskId = null;
  }

  // ── Time check（1分ごと） ─────────────────────────────────────────────────

  function checkTasks() {
    const now   = Date.now();
    const today = localDateStr();

    for (const t of tasks) {
      if (t.status !== 'pending') continue;
      if (!t.startAt) continue;
      if (t.startAt.slice(0, 10) !== today) continue;
      if (notifiedMap[t.id]) continue;
      if (document.getElementById('sftn-notify-overlay') &&
          !document.getElementById('sftn-notify-overlay').hidden) continue; // 既にポップアップ表示中

      const taskMs = new Date(t.startAt).getTime();
      const diffMin = (taskMs - now) / 1000 / 60;

      // 開始時刻の -0.5〜+2.0 分以内で発火（1分タイマーの誤差を考慮）
      if (diffMin <= 0.5 && diffMin > -2.0) {
        showNotifyPopup(t);
        break; // 同時に複数は出さない
      }
    }
  }

  // ── Events ────────────────────────────────────────────────────────────────

  function initEvents() {
    // 通知許可
    document.getElementById('sftn-notify-btn')
      .addEventListener('click', requestNotifyPermission);

    // 追加ボタン
    document.getElementById('sftn-add-btn')
      .addEventListener('click', () => openForm(null));

    // フォームキャンセル
    document.getElementById('sftn-form-cancel')
      .addEventListener('click', closeForm);

    // オーバーレイ外クリックで閉じる
    document.getElementById('sftn-form-overlay')
      .addEventListener('click', e => {
        if (e.target === document.getElementById('sftn-form-overlay')) closeForm();
      });

    // フォーム送信
    document.getElementById('sftn-task-form')
      .addEventListener('submit', submitForm);

    // タスクリスト（イベント委譲）
    document.getElementById('sftn-task-list')
      .addEventListener('click', e => {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        const id = btn.dataset.id;
        if (btn.dataset.action === 'edit') {
          const task = tasks.find(t => t.id === id);
          if (task) openForm(task);
        } else if (btn.dataset.action === 'delete') {
          const task = tasks.find(t => t.id === id);
          if (task && confirm(`「${task.name}」を削除しますか？`)) {
            deleteTask(id);
            renderTasks();
          }
        }
      });

    // 通知ポップアップ：完了
    document.getElementById('sftn-notify-done')
      .addEventListener('click', () => {
        if (notifyTaskId) updateTask(notifyTaskId, { status: 'completed' });
        closeNotifyPopup();
        renderTasks();
      });

    // 通知ポップアップ：あと10分
    document.getElementById('sftn-notify-snooze')
      .addEventListener('click', () => {
        if (notifyTaskId) {
          const task = tasks.find(t => t.id === notifyTaskId);
          if (task) {
            const newTime = new Date(new Date(task.startAt).getTime() + 10 * 60 * 1000);
            delete notifiedMap[notifyTaskId];
            saveNotified();
            updateTask(notifyTaskId, { startAt: localDatetimeStr(newTime) });
          }
        }
        closeNotifyPopup();
        renderTasks();
      });

    // 通知ポップアップ：スキップ
    document.getElementById('sftn-notify-skip')
      .addEventListener('click', () => {
        if (notifyTaskId) updateTask(notifyTaskId, { status: 'skipped' });
        closeNotifyPopup();
        renderTasks();
      });

    // AudioContext は最初のユーザー操作でアンロック
    document.addEventListener('click', () => {
      try { ensureAudio(); } catch {}
    });
  }

  // ── Init ──────────────────────────────────────────────────────────────────

  function init() {
    loadTasks();
    loadNotified();
    updateDate();
    updateNotifyUI();
    renderTasks();
    initEvents();

    // 1分ごとに時刻チェック
    setInterval(checkTasks, 60 * 1000);
    // 起動直後にも1回チェック（ページリロード後の取りこぼし防止）
    setTimeout(checkTasks, 1500);
  }

  document.addEventListener('DOMContentLoaded', init);

})();
