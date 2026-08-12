/**
 * jarvis/dashboard/public/modules/sf.js
 * Snow flakes モジュール — 骨格実装
 *
 * 状態管理・キャラクター Stage・JARVIS Status 表示を担当する。
 * GA / Analytics / サイト導線連携は次フェーズで追加する。
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
   * CSS の data-state アニメーションが自動的に切り替わる。
   *
   * 画像ファイルが存在する場合:
   *   .char-img-wrap 内に <img id="char-img-{name}"> を配置し、
   *   src を "/sf/chars/{name}_{state}.webp" に書き換えてよい。
   *
   * @param {'hinata'|'kouta'|'hayate'} charName
   * @param {'idle'|'analyzing'|'notice'|'approval'|'working'|'completed'} state
   */
  function setCharState(charName, state) {
    const slot = document.querySelector(`.char-slot[data-char="${charName}"]`);
    if (!slot) return;
    slot.dataset.state = state;

    // 将来の画像切替拡張ポイント
    // const img = slot.querySelector('img');
    // if (img) img.src = `/sf/chars/${charName}_${state}.webp`;
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

  // ─── モジュール起動 ────────────────────────────────────────────────────────

  /**
   * Snow flakes タブへの切替時に呼ばれる。
   * 現時点では idle 状態を表示するのみ。
   * 次フェーズで fetch('/api/sf/status') 等を追加する。
   */
  function activate() {
    setState('idle');
    // TODO（次フェーズ）:
    // const { data } = await api('GET', '/api/sf/status');
    // setState(data.jarvis_state, data.message);
  }

  // ─── Public API ────────────────────────────────────────────────────────────

  return { activate, setState, setStatus, setCharState, setAllCharsState };

})();
