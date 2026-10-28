/* ─────────────────────────────────────────────────────────────
   データの書き出し・復元（ファイル保存方式・サーバー不要）
   - 対象：ブラウザに保存された Snow・アイテム・解放履歴・部屋や SWEETs の進行など
     （sf_ / mi_extra_ / liked_ / hayatecchi_ / ht_ で始まるキー）
   - 対象外：sf_sweets_email（旧クラウドバックアップの ID・PIN）、sfbk_（この機能の控え）
   - 復元は「確認付きの置き換え」：ファイルの内容をそのまま書き戻す。
     Snow の最大値採用・アイテム数の合算はしないので、何度復元しても増えない。
   - 復元の直前に、現在のデータを控え（sfbk_prev）に保存してから書き換える。
     控えを保存できないときは復元しない。書き換え後に照合し、合わなければ控えから戻す。
   - liked_（キャラのいいね済み）は消さない：消すと Firebase の数を二重に数えられるため
   ───────────────────────────────────────────────────────────── */
(function (global) {
  'use strict';

  var FORMAT = 'snowflakes-data-backup';
  var VERSION = 1;
  var PREFIXES = ['sf_', 'mi_extra_', 'liked_', 'hayatecchi_', 'ht_'];
  var EXCLUDE = { 'sf_sweets_email': true };
  var KEEP_ON_RESTORE = ['liked_'];          // 置き換え時も消さない（追加のみ）
  var PREV_KEY = 'sfbk_prev';                // 復元直前の控え
  var MAX_FILE = 3 * 1024 * 1024;            // 3MB
  var MAX_VALUE = 1024 * 1024;               // 1件 1MB
  var MAX_KEYS = 5000;

  function isTarget(key) {
    if (typeof key !== 'string' || !key || EXCLUDE[key]) return false;
    for (var i = 0; i < PREFIXES.length; i++) if (key.indexOf(PREFIXES[i]) === 0) return true;
    return false;
  }
  function keepOnRestore(key) {
    for (var i = 0; i < KEEP_ON_RESTORE.length; i++) if (key.indexOf(KEEP_ON_RESTORE[i]) === 0) return true;
    return false;
  }

  function readCurrent() {
    var data = {};
    for (var i = 0; i < localStorage.length; i++) {
      var k = localStorage.key(i);
      if (isTarget(k)) data[k] = localStorage.getItem(k);
    }
    return data;
  }

  // キー順に並べた JSON（チェック値の計算用）
  function canonical(data) {
    var keys = Object.keys(data).sort(), out = {};
    keys.forEach(function (k) { out[k] = data[k]; });
    return JSON.stringify(out);
  }
  function sha256(text) {
    var bytes = new TextEncoder().encode(text);
    return crypto.subtle.digest('SHA-256', bytes).then(function (buf) {
      return Array.prototype.map.call(new Uint8Array(buf), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    });
  }

  // ── 書き出し ──
  function build() {
    var data = readCurrent();
    return sha256(canonical(data)).then(function (sum) {
      return { format: FORMAT, version: VERSION, createdAt: new Date().toISOString(),
               count: Object.keys(data).length, checksum: sum, data: data };
    });
  }
  function pad(n) { return ('0' + n).slice(-2); }
  function fileName(d) {
    d = d || new Date();
    return 'snowflakes-data-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' + pad(d.getHours()) + pad(d.getMinutes()) + '.json';
  }
  function exportFile() {
    return build().then(function (file) {
      var blob = new Blob([JSON.stringify(file, null, 1)], { type: 'application/json' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url; a.download = fileName();
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(url); }, 2000);
      return file;
    });
  }

  // ── 読み込み・検証 ──
  function fail(msg) { var e = new Error(msg); e.backupError = true; throw e; }
  function isPlainObject(v) { return v !== null && typeof v === 'object' && !Array.isArray(v); }
  function checkNonNegInt(s, name) {
    if (!/^\d{1,9}$/.test(String(s))) fail(name + ' の値が正しくありません');
  }
  function checkJson(s, name, test) {
    var v; try { v = JSON.parse(s); } catch (e) { fail(name + ' のデータが壊れています'); }
    if (!test(v)) fail(name + ' のデータ形式が正しくありません');
  }
  function countMap(v) {
    return isPlainObject(v) && Object.keys(v).every(function (k) { return typeof v[k] === 'number' && v[k] >= 0 && v[k] === Math.floor(v[k]); });
  }
  // 主要なデータの形を確かめる（壊れた値を書き戻さない）
  function validateValues(data) {
    if ('sf_snow' in data) checkNonNegInt(data.sf_snow, 'Snow');
    if ('sf_picks' in data) checkNonNegInt(data.sf_picks, 'ギターピック');
    if ('sf_candy' in data) checkJson(data.sf_candy, 'キャンディ', countMap);
    if ('sf_monthly_items' in data) checkJson(data.sf_monthly_items, '月替わりアイテム', countMap);
    if ('sf_unlocked' in data) checkJson(data.sf_unlocked, '解放履歴', function (v) {
      return Array.isArray(v) && v.every(function (x) { return typeof x === 'string'; });
    });
  }

  // 戻り値：Promise<{ data, createdAt, count }>。不正・破損は reject（message は日本語）
  function parse(text) {
    return Promise.resolve().then(function () {
      if (typeof text !== 'string' || !text) fail('ファイルが空です');
      if (text.length > MAX_FILE) fail('ファイルが大きすぎます');
      var file;
      try { file = JSON.parse(text); } catch (e) { fail('ファイルが壊れているか、データの形式が違います'); }
      if (!isPlainObject(file) || file.format !== FORMAT) fail('Snow flakes のデータファイルではありません');
      if (file.version !== VERSION) fail('対応していない版のファイルです');
      if (!isPlainObject(file.data)) fail('データが見つかりません');
      var keys = Object.keys(file.data);
      if (keys.length > MAX_KEYS) fail('データの件数が多すぎます');
      if (file.count !== keys.length) fail('ファイルが壊れています（件数が一致しません）');
      keys.forEach(function (k) {
        if (!isTarget(k)) fail('復元できないデータが含まれています');
        var v = file.data[k];
        if (typeof v !== 'string') fail('ファイルが壊れています（値の形式）');
        if (v.length > MAX_VALUE) fail('データが大きすぎます');
      });
      validateValues(file.data);
      return sha256(canonical(file.data)).then(function (sum) {
        if (sum !== file.checksum) fail('ファイルが壊れているか、書き換えられています（チェック値が一致しません）');
        return { data: file.data, createdAt: file.createdAt, count: keys.length };
      });
    });
  }

  // ── 内容のまとめと差分 ──
  var CANDY_LABEL = { milk: 'ミルクキャンディ', honey: 'はちみつキャンディ', cassis: 'カシスキャンディ' };
  function safeJson(s, def) { try { var v = JSON.parse(s); return v == null ? def : v; } catch (e) { return def; } }
  function summarize(data) {
    return {
      snow: parseInt(data.sf_snow || '0', 10) || 0,
      picks: parseInt(data.sf_picks || '0', 10) || 0,
      candy: safeJson(data.sf_candy, {}),
      monthly: safeJson(data.sf_monthly_items, {}),
      unlocked: safeJson(data.sf_unlocked, []),
      keys: Object.keys(data).length
    };
  }
  function diff(current, incoming) {
    var added = [], changed = [], removed = [], kept = [];
    Object.keys(incoming).forEach(function (k) {
      if (!(k in current)) added.push(k);
      else if (current[k] !== incoming[k]) changed.push(k);
    });
    Object.keys(current).forEach(function (k) {
      if (k in incoming) return;
      (keepOnRestore(k) ? kept : removed).push(k);
    });
    var a = summarize(current), b = summarize(incoming);
    var ua = {}, ub = {};
    a.unlocked.forEach(function (x) { ua[x] = 1; });
    b.unlocked.forEach(function (x) { ub[x] = 1; });
    return {
      current: a, incoming: b,
      added: added, changed: changed, removed: removed, kept: kept,
      unlockedGain: b.unlocked.filter(function (x) { return !ua[x]; }),
      unlockedLoss: a.unlocked.filter(function (x) { return !ub[x]; })
    };
  }

  // ── 置き換え ──
  function writeAll(target, current) {
    Object.keys(current).forEach(function (k) {
      if (!(k in target) && !keepOnRestore(k)) localStorage.removeItem(k);
    });
    Object.keys(target).forEach(function (k) { localStorage.setItem(k, target[k]); });
  }
  function matches(target) {
    var now = readCurrent();
    return Object.keys(target).every(function (k) { return now[k] === target[k]; }) &&
      Object.keys(now).every(function (k) { return (k in target) || keepOnRestore(k); });
  }
  function replaceWith(target) {
    var current = readCurrent();
    // 1. 控えを保存（できなければ中止）
    try {
      localStorage.setItem(PREV_KEY, JSON.stringify({ savedAt: new Date().toISOString(), data: current }));
    } catch (e) {
      fail('いまのデータの控えを保存できなかったため、復元を中止しました。先に「データを書き出す」で保存してください');
    }
    // 2. 書き換え → 照合。合わなければ控えから戻す
    try {
      writeAll(target, current);
      if (!matches(target)) throw new Error('mismatch');
    } catch (e) {
      try { writeAll(current, readCurrent()); } catch (e2) {}
      fail('復元の途中で問題が起きたため、元のデータに戻しました');
    }
    return true;
  }
  function restore(parsed) { return replaceWith(parsed.data); }

  function getPrev() {
    var p = safeJson(localStorage.getItem(PREV_KEY), null);
    return p && isPlainObject(p.data) ? p : null;
  }
  // 直前の状態に戻す（これも置き換え。戻す前の状態が新しい控えになる）
  function undo() {
    var p = getPrev();
    if (!p) fail('戻せる控えがありません');
    Object.keys(p.data).forEach(function (k) { if (!isTarget(k)) fail('控えのデータが正しくありません'); });
    return replaceWith(p.data);
  }

  global.SfBackup = {
    FORMAT: FORMAT, VERSION: VERSION, PREV_KEY: PREV_KEY, CANDY_LABEL: CANDY_LABEL,
    isTarget: isTarget, readCurrent: readCurrent, build: build, exportFile: exportFile, fileName: fileName,
    parse: parse, summarize: summarize, diff: diff, restore: restore, getPrev: getPrev, undo: undo
  };
})(window);
