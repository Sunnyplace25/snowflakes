/* 今日のワンオラクル（トップページの最初のポップアップ）
 * カードの文言・画像は Under tone（room/undertone/index.html）の CARDS / CARD_IMGS と同じ内容。
 * Under tone 側のカードを直したら、ここも同じように直すこと。
 * 1日1回だけ自動表示。引いたカードは端末に保存し、同じ日は同じ結果。Snow は消費しない。
 */
(function() {
  var BASE = 'room/undertone/';
  var CARDS = [
    { num:'0',     name:'名前のない歌',  arch:'FOOL',           archJP:'愚者',
      up:  { key:'始まり・可能性・新しい流れ',    msg:'まだ何者でもない音が、動き始めている',     advice:'動き始めたなら、理由はあとからついてくる。' },
      rev: { key:'迷い・衝動・空回り',            msg:'音は鳴っている。でも向かう場所が見えていない', advice:'向かう場所を、ひとつだけ決めろ。' } },
    { num:'Ⅰ',    name:'最初の音',      arch:'MAGICIAN',       archJP:'魔術師',
      up:  { key:'才能・行動・創造',              msg:'置いた音が形になり始める',                 advice:'今持っているもので、始めていい。' },
      rev: { key:'自信不足・迷い',                msg:'鳴らせる音を、自分で止めている',           advice:'できないんじゃなく、やらない選択をしている。' } },
    { num:'Ⅱ',    name:'白い部屋',      arch:'HIGH PRIESTESS', archJP:'女教皇',
      up:  { key:'直感・静寂・内面',              msg:'答えは静かな場所に残っている',             advice:'すぐ答えを出さなくていい。' },
      rev: { key:'思い込み・混乱',                msg:'周りの音が大きすぎる',                     advice:'外ではなく、内側に聞け。' } },
    { num:'Ⅲ',    name:'重なる音',      arch:'EMPRESS',        archJP:'女帝',
      up:  { key:'愛情・成長・繋がり',            msg:'誰かと重なることで広がる',                 advice:'誰かと居ることを、もう少し許していい。' },
      rev: { key:'依存・甘え',                    msg:'近すぎて輪郭が消えている',                 advice:'あなたの輪郭は、あなたのものだ。' } },
    { num:'Ⅳ',    name:'置いた椅子',    arch:'EMPEROR',        archJP:'皇帝',
      up:  { key:'安定・支え・基盤',              msg:'戻る場所はちゃんとある',                   advice:'安定は、怠けじゃない。' },
      rev: { key:'頑固・支配',                    msg:'守ることが縛ることになっている',           advice:'守るための力が、縛る力になっていないか確かめろ。' } },
    { num:'Ⅴ',    name:'続く約束',      arch:'HIEROPHANT',     archJP:'教皇',
      up:  { key:'信頼・学び',                    msg:'言葉にしない約束が残っている',             advice:'信じてきたものを、信じ続けていい。' },
      rev: { key:'固定観念・停滞',                msg:'昔の音に縛られている',                     advice:'古い地図で新しい場所を歩こうとしている。' } },
    { num:'Ⅵ',    name:'半分のまま',    arch:'LOVERS',         archJP:'恋人',
      up:  { key:'選択・愛情・関係',              msg:'迷いながらでも進んでいる',                 advice:'迷いながら選んだ答えも、ちゃんと正解になる。' },
      rev: { key:'すれ違い・優柔不断',            msg:'決められないまま時間だけが過ぎる',         advice:'どちらも選ばないことが、一番遠回りになる。' } },
    { num:'Ⅶ',    name:'走る鼓動',      arch:'CHARIOT',        archJP:'戦車',
      up:  { key:'前進・勢い',                    msg:'止まる理由より進む理由',                   advice:'止まらなくていい。進みながら考えろ。' },
      rev: { key:'暴走・焦り',                    msg:'速さだけが先に行っている',                 advice:'速さより方向を確かめろ。' } },
    { num:'Ⅷ',    name:'整えない音',    arch:'STRENGTH',       archJP:'力',
      up:  { key:'優しさ・強さ',                  msg:'無理に強くならなくていい',                 advice:'柔らかくいることが、今の強さだ。' },
      rev: { key:'我慢・消耗',                    msg:'静かに削れている',                         advice:'消耗していいのは、大切なものに対してだけだ。' } },
    { num:'Ⅸ',    name:'遠い窓',        arch:'HERMIT',         archJP:'隠者',
      up:  { key:'内省・観察',                    msg:'少し離れて見える景色',                     advice:'一人でいる時間は、弱さじゃない。' },
      rev: { key:'孤立・閉鎖',                    msg:'閉じすぎて声が届かない',                   advice:'閉じることと、守ることは違う。' } },
    { num:'Ⅹ',    name:'揺れたコード',  arch:'WHEEL OF FORTUNE',archJP:'運命の輪',
      up:  { key:'転機・流れ',                    msg:'次の音が始まる',                           advice:'今が変わり目だ。流れに乗れ。' },
      rev: { key:'停滞・ズレ',                    msg:'タイミングが少しだけ違う',                 advice:'タイミングはずれているだけで、波は来る。' } },
    { num:'XI',    name:'置いた手',      arch:'JUSTICE',        archJP:'正義',
      up:  { key:'判断・均衡・選択',              msg:'今必要なのは感情より答え',                 advice:'感情より先に、答えを出せ。' },
      rev: { key:'偏り・迷い',                    msg:'気持ちと答えが重なっていない',             advice:'どちらかに傾いたまま選ばないでいる。' } },
    { num:'XII',   name:'逆さの景色',    arch:'HANGED MAN',     archJP:'吊るされた男',
      up:  { key:'待機・別視点・受容',            msg:'止まっているようで、ちゃんと進んでいる',   advice:'今は待つ時間だ。動かなくていい。' },
      rev: { key:'停滞・諦め',                    msg:'同じ場所を見続けている',                   advice:'角度を変えると、違う景色が見える。' } },
    { num:'XIII',  name:'消えた音',      arch:'DEATH',          archJP:'死神',
      up:  { key:'終わり・再生・区切り',          msg:'終わることで残る音もある',                 advice:'手放すことで、次の音が鳴る。' },
      rev: { key:'執着・変化拒否',                msg:'消えた音を探し続けている',                 advice:'終わったものに引っ張られている。' } },
    { num:'XIV',   name:'透明のまま',    arch:'TEMPERANCE',     archJP:'節制',
      up:  { key:'調和・自然体・流れ',            msg:'無理をしない方が近づく',                   advice:'急がなくても届く。' },
      rev: { key:'乱れ・極端',                    msg:'混ざりすぎて輪郭が消えている',             advice:'バランスが崩れている。どちらかを緩めろ。' } },
    { num:'XV',    name:'ほどけない糸',  arch:'DEVIL',          archJP:'悪魔',
      up:  { key:'執着・欲望・依存',              msg:'離した方が軽くなる',                       advice:'手放す勇気は、逃げることじゃない。' },
      rev: { key:'解放・気付き',                  msg:'絡まっていた糸がほどけ始めている',         advice:'絡まりが解け始めている。今が動き時だ。' } },
    { num:'XVI',   name:'崩れたコード',  arch:'TOWER',          archJP:'塔',
      up:  { key:'衝撃・崩壊・真実',              msg:'壊れたから見えた景色',                     advice:'壊れた場所から、本当に必要なものが見える。' },
      rev: { key:'先延ばし・不安',                msg:'崩れる前の音が続いている',                 advice:'崩れる前に、自分で動け。' } },
    { num:'XVII',  name:'残る光',        arch:'STAR',           archJP:'星',
      up:  { key:'希望・未来・安心',              msg:'消えたように見えて残っている',             advice:'信じていていい。光はある。' },
      rev: { key:'失望・迷い',                    msg:'光があることを忘れている',                 advice:'希望を諦める理由を探すのをやめろ。' } },
    { num:'XVIII', name:'白い夜',        arch:'MOON',           archJP:'月',
      up:  { key:'曖昧・不安・感覚',              msg:'全部見えない夜もある',                     advice:'全部分からなくていい。感覚に従え。' },
      rev: { key:'真実・気付き',                  msg:'ぼやけていたものが少し見える',             advice:'ぼやけていたものが見え始めている。見逃すな。' } },
    { num:'XIX',   name:'朝の音',        arch:'SUN',            archJP:'太陽',
      up:  { key:'喜び・成功・前進',              msg:'ちゃんと光が届いている',                   advice:'素直に喜んでいい。' },
      rev: { key:'空回り・疲労',                  msg:'明るさの中で少し無理をしている',           advice:'無理に明るくしなくていい。' } },
    { num:'XX',    name:'戻る場所',      arch:'JUDGEMENT',      archJP:'審判',
      up:  { key:'再会・目覚め・気付き',          msg:'終わった音が戻ってきた',                   advice:'気付いたなら、もう動き出せる。' },
      rev: { key:'迷い・後悔',                    msg:'過去に立ち止まっている',                   advice:'過去に返事をしている場合じゃない。' } },
    { num:'XXI',   name:'続いた音',      arch:'WORLD',          archJP:'世界',
      up:  { key:'完成・達成・循環',              msg:'終わりじゃない。続いている',               advice:'ここが終わりじゃない。続きがある。' },
      rev: { key:'未完成・途中',                  msg:'あと少しだけ音が足りない',                 advice:'あと少しだけ、続けろ。' } },
    { num:'XXII',  name:'置かれた音',    arch:'THE PLACED SOUND',archJP:'置かれた音',
      up:  { key:'運命・出会い・偶然',            msg:'理由はまだ分からない。でも残る音がある',   advice:'理由が分からなくても、残るものは残る。' },
      rev: { key:'すれ違い・タイミングのズレ',    msg:'拾う場所を少し間違えている',               advice:'拾う前に、置いてきたものがある。' },
      note:'誰かが置いていった音。\n誰のものだったかは分からない。\n店主も説明しない。' },
    { num:'XXIII', name:'Snow flakes',   arch:'SNOW FLAKES',    archJP:'スノーフレークス',
      up:  { key:'絆・重なり・奇跡',              msg:'別々だった音が、重なった',                 advice:'離れていても、同じ場所に向かっている。' },
      rev: { key:'距離・静止・余白',              msg:'離れているだけで、消えてはいない',         advice:'距離は、消えていない証拠でもある。' },
      note:'それぞれ違う形なのに、\n同じ場所へ落ちてくる音。',
      special:'snow' },
    { num:'XXIV',  name:'白いカセット',  arch:'WHITE TAPE',     archJP:'白いカセット',
      up:  { key:'記憶・始まり・受け継ぐもの',    msg:'忘れていた音が戻ってくる',                 advice:'忘れていた音でも、大切にしていていい。' },
      rev: { key:'曖昧・欠落',                    msg:'聞こえているのに思い出せない',             advice:'聞こえているはずの音を、聞こえないふりしている。' },
      note:'ラベルのない古いカセット。\n再生するたび、少し違う音がする。',
      special:'tape' },
    { num:'XXV',   name:'途中の音',      arch:'HALFWAY SOUND',  archJP:'途中の音',
      up:  { key:'未完成・可能性',                msg:'終わっていないなら、まだ続けられる',       advice:'未完成のまま、価値がある。' },
      rev: { key:'諦め・停滞',                    msg:'途中で止めた音が残っている',               advice:'途中で止めた理由より、続ける理由を探せ。' },
      note:'完成しなかった曲。\nでも、誰かには必要だった。' },
    { num:'XXVI',  name:'静かな席',      arch:'EMPTY CHAIR',    archJP:'静かな席',
      up:  { key:'居場所・安心・再会',            msg:'空いているのは、待っているから',           advice:'誰かがあなたのために空けている。' },
      rev: { key:'孤独・喪失',                    msg:'誰も座っていない理由を考え続けている',     advice:'孤独と一人は違う。' },
      note:'店の奥に置かれている古い椅子。\n店主は誰の席か教えない。' },
  ];
  var CARD_IMGS = {
    'FOOL':             'cards/00_fool.webp',
    'MAGICIAN':         'cards/01_magician.webp',
    'HIGH PRIESTESS':   'cards/02_high_priestess.webp',
    'EMPRESS':          'cards/03_empress.webp',
    'EMPEROR':          'cards/04_emperor.webp',
    'HIEROPHANT':       'cards/05_hierophant.webp',
    'LOVERS':           'cards/06_lovers.webp',
    'CHARIOT':          'cards/07_chariot.webp',
    'STRENGTH':         'cards/08_strength.webp',
    'HERMIT':           'cards/09_hermit.webp',
    'WHEEL OF FORTUNE': 'cards/10_wheel.webp',
    'JUSTICE':          'cards/11_justice.webp',
    'HANGED MAN':       'cards/12_hanged_man.webp',
    'DEATH':            'cards/13_death.webp',
    'TEMPERANCE':       'cards/14_temperance.webp',
    'DEVIL':            'cards/15_devil.webp',
    'TOWER':            'cards/16_tower.webp',
    'STAR':             'cards/17_star.webp',
    'MOON':             'cards/18_moon.webp',
    'SUN':              'cards/19_sun.webp',
    'JUDGEMENT':        'cards/20_judgement.webp',
    'WORLD':            'cards/21_world.webp',
    'THE PLACED SOUND': 'cards/ori_placed_sound.webp',
    'WHITE TAPE':       'card_back_b.webp',
  };

  var KEY = 'sf_daily_oracle';
  function today() {
    var d = new Date();
    return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate();
  }
  function load() {
    try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; }
  }
  function save(v) {
    try { localStorage.setItem(KEY, JSON.stringify(v)); } catch (e) {}
  }
  function track(name, params) {
    if (typeof gtag === 'function') { try { gtag('event', name, params || {}); } catch (e) {} }
  }

  var state = load();
  if (state && state.date === today()) return;            // 今日はもう表示済み
  var idx = Math.floor(Math.random() * CARDS.length);
  var up  = Math.random() < 0.5;
  state = { date: today(), idx: idx, up: up, flipped: false };
  save(state);

  var card = CARDS[idx];
  var data = up ? card.up : card.rev;
  var img  = BASE + (CARD_IMGS[card.arch] || 'card_back_b.webp');

  var P = '#daily-oracle-popup ';
  var css = [
    '#daily-oracle-popup{position:fixed;inset:0;z-index:10003;display:flex;align-items:center;justify-content:center;padding:16px;background:rgba(8,13,24,0.92);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);opacity:0;transition:opacity .4s;overflow-y:auto;}',
    '#daily-oracle-popup.show{opacity:1;}',
    P + '.do-box{position:relative;max-width:340px;width:100%;margin:auto;background:#0a1221;border:1px solid rgba(196,181,253,0.18);border-radius:22px;padding:26px 22px 22px;text-align:center;box-shadow:0 0 60px rgba(196,181,253,0.08);}',
    P + '.do-x{position:absolute;top:10px;right:12px;background:rgba(0,0,0,0.45);border:none;color:#cbd5e1;font-size:20px;line-height:1;width:32px;height:32px;cursor:pointer;border-radius:8px;}',
    P + '.do-eye{font-family:"Cormorant Garamond",serif;font-size:10px;letter-spacing:6px;color:#c4b5fd;margin-bottom:4px;}',
    P + '.do-date{font-family:"Cormorant Garamond",serif;font-size:11px;letter-spacing:3px;color:#64748b;margin-bottom:16px;}',
    P + '.do-wrap{perspective:900px;width:150px;margin:0 auto 12px;}',
    P + '.do-card{position:relative;width:150px;height:225px;cursor:pointer;transform-style:preserve-3d;transition:transform .9s cubic-bezier(.4,.2,.2,1);}',
    P + '.do-card.flipped{transform:rotateY(180deg);cursor:default;}',
    P + '.do-face{position:absolute;inset:0;backface-visibility:hidden;-webkit-backface-visibility:hidden;border-radius:10px;overflow:hidden;border:1px solid rgba(255,255,255,0.1);background:#111a2e;}',
    P + '.do-face img{width:100%;height:100%;object-fit:cover;display:block;}',
    P + '.do-front{transform:rotateY(180deg);}',
    P + '.do-hint{font-family:"Noto Serif JP",serif;font-size:12px;letter-spacing:3px;color:#94a3b8;transition:opacity .4s;}',
    P + '.do-res{display:none;opacity:0;transition:opacity .6s;}',
    P + '.do-res.show{opacity:1;}',
    P + '.do-pos{font-family:"Noto Serif JP",serif;font-size:11px;letter-spacing:4px;margin-bottom:4px;}',
    P + '.do-name{font-family:"Noto Serif JP",serif;font-size:19px;font-weight:300;color:#f1f5f9;letter-spacing:3px;margin-bottom:4px;}',
    P + '.do-arch{font-family:"Cormorant Garamond",serif;font-size:10px;letter-spacing:3px;color:#64748b;margin-bottom:10px;}',
    P + '.do-key{font-family:"Noto Serif JP",serif;font-size:12px;letter-spacing:2px;color:#c4b5fd;}',
    P + '.do-line{width:20px;height:1px;background:rgba(255,255,255,0.12);margin:12px auto;}',
    P + '.do-msg{font-family:"Noto Serif JP",serif;font-size:14px;line-height:1.9;color:#e2e8f0;white-space:pre-line;}',
    P + '.do-note{font-family:"Noto Serif JP",serif;font-size:11px;line-height:1.9;color:#94a3b8;white-space:pre-line;margin-top:10px;}',
    P + '.do-adv{font-family:"Noto Serif JP",serif;font-size:12px;line-height:1.9;color:#fde68a;}',
    P + '.do-go{display:flex;flex-direction:column;gap:8px;margin-top:18px;}',
    P + '.do-go a{display:flex;align-items:center;justify-content:space-between;gap:8px;text-decoration:none;border-radius:100px;padding:11px 18px;font-family:"Noto Serif JP",serif;font-size:12px;letter-spacing:2px;border:1px solid;}',
    P + '.do-go a small{font-family:"Cormorant Garamond",serif;font-size:10px;letter-spacing:2px;opacity:.75;}',
    P + '.do-go .g-ut{color:#c4b5fd;border-color:rgba(196,181,253,0.35);background:rgba(196,181,253,0.08);}',
    P + '.do-go .g-gacha{color:#fde68a;border-color:rgba(253,230,138,0.3);background:rgba(253,230,138,0.06);}',
    P + '.do-go .g-novel{color:#93c5fd;border-color:rgba(147,197,253,0.35);background:rgba(147,197,253,0.08);}',
    P + '.do-credit{font-family:"Cormorant Garamond",serif;font-size:10px;letter-spacing:2px;color:#475569;margin-top:16px;}',
    '@keyframes doFlash{0%,100%{box-shadow:0 0 0 rgba(147,197,253,0)}50%{box-shadow:0 0 36px rgba(147,197,253,0.45)}}',
    '.do-flash{animation:doFlash 1.2s ease 2;}'
  ].join('\n');

  var ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
  function esc(s) { return String(s || '').replace(/[&<>"]/g, function(c) { return ESC[c]; }); }

  var now = new Date();
  var dateText = (now.getMonth() + 1) + '.' + now.getDate();

  function build() {
    var st = document.createElement('style');
    st.textContent = css;
    document.head.appendChild(st);

    var el = document.createElement('div');
    el.id = 'daily-oracle-popup';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-label', '今日のワンオラクル');
    el.innerHTML = [
      '<div class="do-box">',
        '<button class="do-x" aria-label="閉じる">×</button>',
        '<p class="do-eye">TODAY’S ONE ORACLE</p>',
        '<p class="do-date">' + dateText + '</p>',
        '<div class="do-wrap"><div class="do-card" role="button" aria-label="カードをめくる">',
          '<div class="do-face do-back"><img src="' + BASE + 'card_back_b.webp" alt="カードの裏"></div>',
          '<div class="do-face do-front"><img alt="' + esc(card.name) + '"' + (up ? '' : ' style="transform:rotate(180deg);"') + '></div>',
        '</div></div>',
        '<p class="do-hint">カードに触れて</p>',
        '<div class="do-res">',
          '<p class="do-pos" style="color:' + (up ? '#fde68a' : '#7dd3fc') + '">' + (up ? '正位置' : '逆位置') + '</p>',
          '<p class="do-name">' + esc(card.name) + '</p>',
          '<p class="do-arch">' + esc(card.num) + '  ·  ' + esc(card.arch) + '  |  ' + esc(card.archJP) + '</p>',
          '<p class="do-key">' + esc(data.key) + '</p>',
          '<div class="do-line"></div>',
          '<p class="do-msg">' + esc((data.msg || '').replace(/。/g, '。\n')) + '</p>',
          (card.note ? '<p class="do-note">' + esc(card.note) + '</p>' : ''),
          '<div class="do-line"></div>',
          '<p class="do-adv">' + esc(data.advice) + '</p>',
          '<div class="do-go">',
            '<a class="g-ut" href="room/undertone/" data-go="undertone">Under tone へ行く<small>もっと占う →</small></a>',
            '<a class="g-gacha" href="gacha/" data-go="gacha">今日の音<small>GACHA・音診断 →</small></a>',
            '<a class="g-novel" href="#" data-go="novel">小説を読む<small>今日の更新 →</small></a>',
          '</div>',
          '<p class="do-credit">Snow flakes Tarot  ·  Words &amp; Interpretation  ·  Kotori Yamabuki</p>',
        '</div>',
      '</div>'
    ].join('');
    document.body.appendChild(el);

    var cardEl = el.querySelector('.do-card');
    var frontImg = el.querySelector('.do-front img');
    var hint = el.querySelector('.do-hint');
    var res = el.querySelector('.do-res');

    function flip() {
      if (cardEl.classList.contains('flipped')) return;
      frontImg.src = img;
      cardEl.classList.add('flipped');
      hint.style.opacity = '0';
      state.flipped = true; save(state);
      track('daily_oracle_flip', { card: card.arch, position: up ? 'up' : 'rev' });
      setTimeout(function() {
        hint.style.display = 'none';
        res.style.display = 'block';
        requestAnimationFrame(function() { res.classList.add('show'); });
      }, 900);
    }
    function close() {
      el.classList.remove('show');
      document.removeEventListener('keydown', onKey);
      setTimeout(function() { el.style.display = 'none'; }, 400);
      track('daily_oracle_close', { flipped: !!state.flipped });
    }
    function onKey(e) { if (e.key === 'Escape') close(); }

    cardEl.addEventListener('click', flip);
    el.querySelector('.do-x').addEventListener('click', close);
    el.addEventListener('click', function(e) { if (e.target === el) close(); });
    document.addEventListener('keydown', onKey);

    Array.prototype.forEach.call(el.querySelectorAll('.do-go a'), function(a) {
      a.addEventListener('click', function(e) {
        var go = a.getAttribute('data-go');
        track('daily_oracle_go', { destination: go, card: card.arch });
        if (go !== 'novel') return;                       // Under tone・今日の音は通常のリンク
        e.preventDefault();
        close();
        var target = document.getElementById('update-banner') || document.getElementById('sf-banner-wrap');
        if (!target) return;
        setTimeout(function() {
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
          setTimeout(function() {
            target.classList.remove('do-flash'); void target.offsetWidth; target.classList.add('do-flash');
          }, 600);
        }, 420);
      });
    });

    requestAnimationFrame(function() {
      requestAnimationFrame(function() { el.classList.add('show'); });
    });
    track('popup_view', { campaign: 'daily_oracle', source: 'homepage_popup' });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', build);
  else build();
})();
