/* 音ハズ（音を覚えるだけの外れスキルで追放された俺、失われた古代魔法を全部再生できるらしい）の章ページのデータ
   stories/otohazu/chapter/<id>/ と作品ページの章一覧で共用。話番号は「小説家になろう」n1351mq の通し番号。各話タイトルは episodes.js
   章の区切り・章タイトルは なろうの目次のまま（2026-11-07 時点）。lead・shorts・songs・gallery は空なら「準備中」 */
window.SF_ARC_SITE = { ncode: 'n1351mq', series: '音ハズ' };
window.SF_ARC_GROUPS = [
  { id: 'main', label: '本編', en: 'CHAPTERS', kind: 'CHAPTER', numbered: true }
];

window.SF_ARCS = [
  { id: 'ch1', group: 'main', no: 1, label: '第一章', title: '外れスキル《残響記録》', parts: [{ name: '第一章', from: 1, to: 7 }], lead: '', shorts: [], songs: [], gallery: [] },
  { id: 'ch2', group: 'main', no: 2, label: '第二章', title: '忘れられた音', parts: [{ name: '第二章', from: 8, to: 20 }], lead: '', shorts: [], songs: [], gallery: [] },
  { id: 'ch3', group: 'main', no: 3, label: '第三章', title: '勇者候補のパーティ', parts: [{ name: '第三章', from: 21, to: 36 }], lead: '', shorts: [], songs: [], gallery: [] },
  { id: 'ch4', group: 'main', no: 4, label: '第四章', title: '当たり前になった音', parts: [{ name: '第四章', from: 37, to: 53 }], lead: '', shorts: [], songs: [], gallery: [] },
  { id: 'ch5', group: 'main', no: 5, label: '第五章', title: '六人と五つの席', parts: [{ name: '第五章', from: 54, to: 75 }], lead: '', shorts: [], songs: [], gallery: [] },
  { id: 'ch6', group: 'main', no: 6, label: '第六章', title: 'それぞれの場所', parts: [{ name: '第六章', from: 76, to: 81 }], lead: '', shorts: [], songs: [], gallery: [] },
  // 第七章・第八章は 2026-11-07 ユーザーのスクショから（予約投稿。最初の話が公開されるまで一覧・切り替えに出ない）
  { id: 'ch7', group: 'main', no: 7, label: '第七章', title: '声のない谷', parts: [{ name: '第七章', from: 82, to: 91 }], lead: '', shorts: [], songs: [], gallery: [] },
  { id: 'ch8', group: 'main', no: 8, label: '第八章', title: '残された六つの音', parts: [{ name: '第八章', from: 92, to: null }],   // to: null … 連載中
    lead: '', ongoing: true, shorts: [], songs: [], gallery: [] }
];
