/* ============================================================
   artists/artist.js — アーティストページ共通の動作
   ・雪（雨音クラブは雨）の演出 … music.html と同じ描画
   ・share ボタン
   ・画像未着時の仮表示（後から同名ファイルを置けば自動で表示される）
   ・GA：配信サービス・小説・MV リンクのクリック計測
   ============================================================ */
(function () {
  // ── 画像の仮表示：<img data-ph> が読み込めなければ親に is-ph を付けて img を外す
  document.querySelectorAll('img[data-ph]').forEach(function (img) {
    function fallback() {
      var box = img.closest('[data-ph-box]') || img.parentElement;
      if (box) box.classList.add('is-ph');
      img.remove();
    }
    if (img.complete && img.naturalWidth === 0) fallback();
    else img.addEventListener('error', fallback);
  });

  // ── 縦横比が合わないメインビジュアル：同じ画像をぼかして背景に敷く（絶対URLで渡す）
  document.querySelectorAll('.hero-media.is-contain img').forEach(function (img) {
    var box = img.closest('.hero-media');
    if (box) box.style.setProperty('--hero-bg', 'url("' + img.src + '")');
  });

  // ── 元メンバー：名前を押すと小さな写真を表示（画像は初回に読み込む）
  window.sfToggleFormer = function (btn) {
    var img = document.getElementById(btn.getAttribute('aria-controls'));
    if (!img) return;
    var open = btn.getAttribute('aria-expanded') === 'true';
    if (!open) {
      if (!img.getAttribute('src') && img.dataset.src) img.src = img.dataset.src;
      img.hidden = false;
      requestAnimationFrame(function () { img.classList.add('is-open'); });
      btn.setAttribute('aria-expanded', 'true');
    } else {
      img.classList.remove('is-open');
      btn.setAttribute('aria-expanded', 'false');
      setTimeout(function () { if (btn.getAttribute('aria-expanded') === 'false') img.hidden = true; }, 300);
    }
  };

  // ── share
  window.sfArtistShare = function () {
    // 作品・楽曲の単独ページ（release.html?id=…・song.html?id=…）は id を残す。それ以外の ? と # は外す
    var id = new URLSearchParams(location.search).get('id');
    var url = location.href.split('#')[0].split('?')[0] + (id ? '?id=' + encodeURIComponent(id) : '');
    var title = document.title;
    if (navigator.share) {
      navigator.share({ title: title, url: url }).catch(function () {});
    } else if (navigator.clipboard) {
      navigator.clipboard.writeText(url).then(function () {
        var t = document.getElementById('share-toast');
        if (!t) {   // 「コピーしました」の表示がないページでは作る
          t = document.createElement('div');
          t.id = 'share-toast';
          t.textContent = 'リンクをコピーしました';
          document.body.appendChild(t);
        }
        t.style.display = 'block';
        setTimeout(function () { t.style.display = 'none'; }, 2000);
      });
    }
  };

  // ── 雪／雨
  var canvas = document.getElementById('snow');
  if (canvas) {
    var ctx = canvas.getContext('2d');
    var rain = document.body.getAttribute('data-particles') === 'rain';
    function resize() { canvas.width = innerWidth; canvas.height = innerHeight; }
    window.addEventListener('resize', resize); resize();
    var flakes = Array.from({ length: rain ? 70 : 50 }, function () {
      return {
        x: Math.random() * innerWidth, y: Math.random() * innerHeight,
        r: Math.random() * 1.6 + 0.4,
        speed: rain ? Math.random() * 4 + 5 : Math.random() * 0.5 + 0.15,
        drift: rain ? -0.6 : (Math.random() - 0.5) * 0.25
      };
    });
    (function draw() {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.fillStyle = '#fff';
      ctx.strokeStyle = 'rgba(203,213,225,0.35)';
      ctx.lineWidth = 1;
      for (var i = 0; i < flakes.length; i++) {
        var f = flakes[i];
        if (rain) {
          ctx.beginPath(); ctx.moveTo(f.x, f.y); ctx.lineTo(f.x + f.drift * 3, f.y + f.r * 8); ctx.stroke();
        } else {
          ctx.beginPath(); ctx.arc(f.x, f.y, f.r, 0, Math.PI * 2); ctx.fill();
        }
        f.y += f.speed; f.x += f.drift;
        if (f.y > canvas.height + 10) { f.y = -10; f.x = Math.random() * canvas.width; }
        if (f.x < -10) f.x = canvas.width + 10;
        if (f.x > canvas.width + 10) f.x = -10;
      }
      requestAnimationFrame(draw);
    })();
  }

  // ── GA：外部リンクのクリック計測（music.html と同じイベント名）
  var MAP = [
    { pattern: /open\.spotify\.com/,      name: 'click_spotify', params: { destination: 'spotify' } },
    { pattern: /music\.apple\.com/,       name: 'click_music',   params: { destination: 'apple_music' } },
    { pattern: /music\.amazon/,           name: 'click_music',   params: { destination: 'amazon_music' } },
    { pattern: /music\.youtube\.com/,     name: 'click_youtube', params: { destination: 'youtube_music' } },
    { pattern: /youtube\.com|youtu\.be/,  name: 'click_youtube', params: { destination: 'youtube' } },
    { pattern: /ncode\.syosetu\.com/,     name: 'click_story',   params: { destination: 'syosetu' } }
  ];
  var artist = document.body.getAttribute('data-artist') || '';
  document.addEventListener('click', function (e) {
    var a = e.target.closest && e.target.closest('a[href]');
    if (!a || typeof gtag !== 'function') return;
    var href = a.href || '';
    for (var i = 0; i < MAP.length; i++) {
      if (MAP[i].pattern.test(href)) {
        gtag('event', MAP[i].name, Object.assign({}, MAP[i].params, { url: href.slice(0, 100), artist: artist, source: 'artist_page' }));
        return;
      }
    }
  });
})();
