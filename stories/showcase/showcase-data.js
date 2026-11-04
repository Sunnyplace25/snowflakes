/* ============================================================
   stories/showcase/showcase-data.js — 『ショーケースの前で恋をした』の公開情報（2026-11-02）
   各話のタイトル・URL・公開日時は、ここだけで管理する。
   特集ページ（stories/showcase/）・トップの特集バナー・短篇一覧のカードが、このファイルを読む。

   ■ 各話の書き方
       { ep: 1, date: '2026-11-07T20:00:00+09:00', title: '', url: '' }
     ・date：公開日時（日本時間。+09:00 を必ず付ける）
     ・title：正式な各話タイトル。空のあいだは「第1話」とだけ表示する
     ・url：各話のURL。空のあいだはリンクにしない（公開時刻を過ぎていても押せない）
   ■ title は小説家になろうの各話タイトル（2026-11-04 ユーザーから受領）。ページでは公開時刻を過ぎた話だけタイトルを出す（公開前は「第N話」と日時だけ）
   ■ 判定はすべて日本時間の公開日時（date）で行う（見る人の端末の時計で判定）
   ============================================================ */
(function (global) {
  // URL：2026-11-04 ユーザーから受領（小説家になろう n7218my。11/4 時点は予約投稿で未公開＝404。リンクは各話の公開時刻を過ぎてから押せる）
  var EPISODES = [
    { ep: 1, date: '2026-11-07T20:00:00+09:00', title: '同じ本の途中', url: 'https://ncode.syosetu.com/n7218my/1/' },
    { ep: 2, date: '2026-11-08T20:00:00+09:00', title: '古本屋', url: 'https://ncode.syosetu.com/n7218my/2/' },
    { ep: 3, date: '2026-11-09T20:00:00+09:00', title: '花のしおり', url: 'https://ncode.syosetu.com/n7218my/3/' },
    { ep: 4, date: '2026-11-10T20:00:00+09:00', title: '雨宿り', url: 'https://ncode.syosetu.com/n7218my/4/' },
    { ep: 5, date: '2026-11-11T20:00:00+09:00', title: '星の夜', url: 'https://ncode.syosetu.com/n7218my/5/' },
    { ep: 6, date: '2026-11-12T20:00:00+09:00', title: 'バス停', url: 'https://ncode.syosetu.com/n7218my/6/' },
    { ep: 7, date: '2026-11-13T20:00:00+09:00', title: '待ち合わせ', url: 'https://ncode.syosetu.com/n7218my/7/' },
    { ep: 8, date: '2026-11-14T20:00:00+09:00', title: '本棚', url: 'https://ncode.syosetu.com/n7218my/8/' }
  ];

  var SC = {
    title: 'ショーケースの前で恋をした',
    kind: 'Snow flakes 短篇連作',
    author: '山吹ことり',
    page: 'stories/showcase/',                         // サイトのルートからのパス
    intro: 'https://www.instagram.com/p/DfPJmP5FF4L/',   // 導入にあたる Instagram 特別短篇（2026-11-02 ユーザー指定）
    periodText: '11月7日〜14日／毎日20時公開・全8話',
    // トップの特集バナーを出す期間（日本時間）。11/30 まで（2026-11-02 ユーザー指定）。期間後も特集ページと短篇一覧のカードは残す
    bannerFrom: '2026-11-02T00:00:00+09:00',
    bannerUntil: '2026-11-30T23:59:59+09:00',
    episodes: EPISODES
  };

  function t(iso) { return new Date(iso).getTime(); }
  // 日本時間の「11月7日」
  function md(iso) { var d = new Date(t(iso) + 9 * 3600000); return (d.getUTCMonth() + 1) + '月' + d.getUTCDate() + '日'; }
  function hour(iso) { var d = new Date(t(iso) + 9 * 3600000); return d.getUTCHours() + '時' + (d.getUTCMinutes() ? d.getUTCMinutes() + '分' : ''); }

  /** 各話の状態：{ ep, label（第1話 または 正式タイトル）, released, link（押せるURL。なければ null）, when（11月7日 20時） } */
  SC.episodeState = function (e, now) {
    now = now == null ? Date.now() : now;
    var released = now >= t(e.date);
    return { ep: e.ep, title: e.title || '', released: released,
      link: released && e.url ? e.url : null, date: e.date, when: md(e.date) + ' ' + hour(e.date) };
  };

  /** 連載の状態：'before'（開始前）／'running'（連載中）／'done'（全話公開） と、公開済みの話数 */
  SC.status = function (now) {
    now = now == null ? Date.now() : now;
    var n = EPISODES.filter(function (e) { return now >= t(e.date); }).length;
    var phase = n === 0 ? 'before' : (n < EPISODES.length ? 'running' : 'done');
    var text = phase === 'before' ? md(EPISODES[0].date) + ' 連載開始'
      : phase === 'running' ? '連載中・第' + n + '話まで公開'
      : '全' + EPISODES.length + '話公開中';
    return { phase: phase, released: n, total: EPISODES.length, text: text };
  };

  SC.bannerVisible = function (now) {
    now = now == null ? Date.now() : now;
    return now >= t(SC.bannerFrom) && now <= t(SC.bannerUntil);
  };

  global.SfShowcase = SC;
})(window);
