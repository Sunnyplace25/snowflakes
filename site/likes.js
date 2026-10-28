/* ============================================================
   site/likes.js — キャラクターの「いいね」（旧トップから移設・2026-10-26）
   ・保存先は旧トップと同じ Firebase Realtime Database の likes/{id}。既存のいいね数はそのまま引き継ぐ
   ・「いいね済み」は旧トップと同じ localStorage の liked_{id}。同じ人が旧トップ・新ページで二重に数えられない
   ・いいねの ❄ Snow 付与も旧トップと同じ（SfSnow.addWithToast('like_chara_' + id)。1日1回は snow.js 側で判定）
   ・カウンターの増減は runTransaction（同時押しでも数がずれない）
   使い方：<button class="like-btn h" id="btn-hinata" data-like="hinata"><span class="like-heart">♡</span><span id="count-hinata">—</span></button>
          <script type="module" src="（ルート）/site/likes.js"></script>
   ============================================================ */
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getDatabase, ref, onValue, runTransaction } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js';

// 旧トップ（index.html）と同じ Firebase の Web 用設定（公開前提の識別情報）
const firebaseConfig = {
  apiKey:            "AIzaSyDi61hBkjUjBTJX5cxkvbkzNOoqm3LIQY4",
  authDomain:        "snowflakes-likes.firebaseapp.com",
  databaseURL:       "https://snowflakes-likes-default-rtdb.firebaseio.com",
  projectId:         "snowflakes-likes",
  storageBucket:     "snowflakes-likes.firebasestorage.app",
  messagingSenderId: "554674189378",
  appId:             "1:554674189378:web:00c2520d3e8ac72d76a9db"
};
const db = getDatabase(initializeApp(firebaseConfig, 'sf-likes'));

function setLiked(btn, liked) {
  btn.classList.toggle('liked', liked);
  btn.setAttribute('aria-pressed', liked ? 'true' : 'false');
  const heart = btn.querySelector('.like-heart');
  if (heart) heart.textContent = liked ? '♥' : '♡';
}

document.querySelectorAll('[data-like]').forEach(btn => {
  const id = btn.getAttribute('data-like');
  const count = document.getElementById(`count-${id}`);
  onValue(ref(db, `likes/${id}`), snap => { if (count) count.textContent = snap.val() ?? 0; });
  setLiked(btn, !!localStorage.getItem(`liked_${id}`));
  btn.addEventListener('click', e => {
    e.preventDefault(); e.stopPropagation();
    if (localStorage.getItem(`liked_${id}`)) {
      runTransaction(ref(db, `likes/${id}`), v => Math.max(0, (v ?? 0) - 1));   // 取り消し
      localStorage.removeItem(`liked_${id}`);
      setLiked(btn, false);
    } else {
      runTransaction(ref(db, `likes/${id}`), v => (v ?? 0) + 1);
      localStorage.setItem(`liked_${id}`, '1');
      setLiked(btn, true);
      if (window.SfSnow) window.SfSnow.addWithToast('like_chara_' + id, 'キャラをお気に入り登録');
    }
  });
});
