/* ============================================================
   文章の改行を句読点の位置に寄せる（2026-10-29 ユーザー指示）
   ・「、」「。」「！」「？」の後ろ、閉じかっこ（」』））の後ろだけで改行し、語の途中では折り返さない
   ・セリフも同じ（「…、」で区切り、「…」」はひとかたまり）
   ・かたまりが行より長いときは中黒（・）の後ろで折り返す（それでも長いときだけ語の途中で折り返す）
   ・自動で当てる対象：.sf-prose p／.sf-work-lead／.sf-work-intro p／[data-phrase]（中の要素も含む）
   ・後から描画する本文は SfPhrase.apply(要素) を呼ぶ
   ============================================================ */
(function (global) {
  var SEG = /[^、。！？!?」』）)]+(?:[、。！？!?]+[」』）)]*|[」』）)]+)?|[、。！？!?」』）)]+/g;
  var AUTO = '.sf-prose p, .sf-work-lead, .sf-work-intro p, [data-phrase]';

  function wrapText(node) {
    var text = node.nodeValue;
    if (!/[、。！？!?」』）)]/.test(text)) return;
    var parts = text.match(SEG);
    if (!parts || parts.length < 2) return;
    var frag = document.createDocumentFragment();
    parts.forEach(function (p) {
      var s = document.createElement('span');
      s.className = 'sf-ph';
      var sub = p.match(/[^・]+・*|・+/g) || [p];
      if (sub.length < 2) s.textContent = p;
      else sub.forEach(function (q) { var t = document.createElement('span'); t.className = 'sf-ph'; t.textContent = q; s.appendChild(t); });
      frag.appendChild(s);
    });
    node.parentNode.replaceChild(frag, node);
  }

  function apply(root) {
    if (!root || root.nodeType !== 1 || root.closest('.sf-ph')) return;
    var walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) {
        var p = n.parentNode;
        if (!n.nodeValue.trim() || !p || /^(SCRIPT|STYLE|TEXTAREA)$/.test(p.nodeName) || p.classList.contains('sf-ph')) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    var nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    nodes.forEach(wrapText);
  }

  function applyAll(scope) {
    [].forEach.call((scope || document).querySelectorAll(AUTO), apply);
  }

  var css = document.createElement('style');
  css.textContent = '.sf-ph{display:inline-block}';
  document.head.appendChild(css);

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { applyAll(); });
  else applyAll();

  global.SfPhrase = { apply: apply, applyAll: applyAll };
})(window);
