'use strict';

(function () {
  const TRAVEL_HOURS = [0.5, 1, 2];

  function installStyles() {
    if (document.getElementById('business-extra-style')) return;
    const style = document.createElement('style');
    style.id = 'business-extra-style';
    style.textContent = `
      /* 一覧では削除を目立たせず、編集モーダル内だけに置く */
      #works-table-container .work-delete-btn { display: none !important; }
      #edit-work-delete-btn {
        margin-right: auto;
        color: #fca5a5;
        border-color: #7f1d1d;
      }
      #edit-work-delete-btn:hover {
        background: #451a1a;
        border-color: #991b1b;
      }
    `;
    document.head.appendChild(style);
  }

  function setupTravelHours() {
    let list = document.getElementById('travel-hours-suggestions');
    if (!list) {
      list = document.createElement('datalist');
      list.id = 'travel-hours-suggestions';
      TRAVEL_HOURS.forEach(value => {
        const option = document.createElement('option');
        option.value = String(value);
        option.label = `${value}時間`;
        list.appendChild(option);
      });
      document.body.appendChild(list);
    }

    ['travel-hours', 'edit-travel-hours'].forEach(id => {
      const input = document.getElementById(id);
      if (!input) return;
      input.setAttribute('list', 'travel-hours-suggestions');
      input.setAttribute('autocomplete', 'off');
      input.placeholder = '0.5 / 1 / 2 または直接入力';
      const label = document.querySelector(`label[for="${id}"]`);
      if (label) label.textContent = '移動時間（選択 / 直接入力）';
    });
  }

  async function deleteEditedWork(button) {
    const id = Number(document.getElementById('edit-work-id')?.value);
    if (!Number.isInteger(id) || id <= 0) return;

    const date = document.getElementById('edit-work-date')?.value || '';
    const content = document.getElementById('edit-work-content')?.value?.trim() || '';
    const detail = [date, content].filter(Boolean).join('　');
    const message = detail
      ? `${detail}\n\nこの仕事を削除しますか？\n削除後は元に戻せません。`
      : 'この仕事を削除しますか？\n削除後は元に戻せません。';

    if (!window.confirm(message)) return;

    button.disabled = true;
    const original = button.textContent;
    button.textContent = '削除中...';

    try {
      const response = await fetch(`/api/work/${id}`, { method: 'DELETE' });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || '削除に失敗しました');

      if (typeof hideModal === 'function') hideModal();
      if (typeof refresh === 'function') await refresh();
      else location.reload();
    } catch (e) {
      alert('削除に失敗しました: ' + e.message);
      button.disabled = false;
      button.textContent = original;
    }
  }

  function setupEditDeleteButton() {
    const modal = document.getElementById('modal-edit-work');
    const actions = modal?.querySelector('.modal-actions');
    if (!actions || document.getElementById('edit-work-delete-btn')) return;

    const button = document.createElement('button');
    button.type = 'button';
    button.id = 'edit-work-delete-btn';
    button.className = 'btn btn-secondary';
    button.textContent = '削除';
    button.addEventListener('click', () => deleteEditedWork(button));
    actions.insertBefore(button, actions.firstChild);
  }

  function init() {
    installStyles();
    setupTravelHours();
    setupEditDeleteButton();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
