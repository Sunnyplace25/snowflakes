#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Generate en/index.html (static English version of index.html)
"""
import os
import re

with open('index.html', 'r', encoding='utf-8') as f:
    html = f.read()

# ── Split at i18n script to avoid replacing text inside the JS dictionary ──
SPLIT_MARKER = '<!-- ── i18n: Language toggle ── -->'
if SPLIT_MARKER in html:
    html_part, script_part = html.split(SPLIT_MARKER, 1)
else:
    html_part, script_part = html, ''

# ── Text replacements (HTML portion only) ──────────────────────────────────
replacements = [
    # Hero
    ('言葉にならない感情を、<wbr>音に。',
     'Turning emotions<br class="sp-br">beyond words<wbr> into sound.'),
    ('何も起きていないはずの瞬間が、<br>なぜか残る。',
     'The moments when nothing should happen —<br>somehow, they stay.'),
    # Opening
    ('うまく言えなかったこと。<br>\n      伝えきれなかった距離。<br>\n      そのままにした感情が、少しだけ残っている。',
     'Things I couldn\'t quite say.<br>\n      Distances I couldn\'t bridge.<br>\n      Feelings left as they were — still, just a little, remaining.'),
    ('小説を読む →', 'Read the novel →'),
    # Topics
    ('最新情報', 'Latest News'),
    # Concept
    ('Snow flakesは、物語と<br class="sp-br">音楽が連動するプロジェクトです。',
     'Snow flakes is a project where<br class="sp-br"> story and music interweave.'),
    ('ギターボーカルのヒナタ、<br>ベースのコウタ、<br>ドラムのハヤテ。',
     'Hinata on guitar &amp; vocals,<br>Kouta on bass,<br>Hayate on drums.'),
    ('三人の時間を追いながら、<br>その瞬間に生まれた感情が、<br class="sp-br">実際の楽曲として残っていきます。<br><br>物語を読むことで、<br class="sp-br">音が少し違って聴こえる。<br>音を聴くことで、<br class="sp-br">言葉の温度が変わる。',
     'Following the lives of three people,<br>the emotions born in those moments<br class="sp-br">become real music that endures.<br><br>Reading the story makes the sound<br class="sp-br">feel a little different.<br>Listening to the music changes<br class="sp-br">the warmth of the words.'),
    ('どちらかだけでは終わらない、<br>感情が行き来する作品です。',
     'A work where neither can stand alone —<br>emotions move between them.'),
    ('音楽を聴く →', 'Listen to music →'),
    # Core
    ('大きな出来事は、起きません。', 'Nothing dramatic happens.'),
    ('ただ、<br>\n      少しの間や、<br>\n      目を逸らした瞬間や、<br>\n      言わなかった言葉が、残る。<br>\n      <br>\n      その残ったものを、音にしています。',
     'Just<br>\n      a brief pause,<br>\n      a glance away,<br>\n      words left unsaid — they stay.<br>\n      <br>\n      Those things that remain — that\'s what we turn into music.'),
    # Characters (descriptions only — names replaced last to avoid breaking longer strings)
    ('言葉にしないまま、音に向かう。', 'Turning toward sound without finding the words.'),
    ('揺れを受け止め、形にする。', 'Catching the tremors, giving them form.'),
    ('迷いごと鳴らして、前へ進む。', 'Playing through the doubts, moving forward.'),
    # Novel
    ('>小説</', '>Novel</'),
    ('小説家になろう　毎日21時更新', 'Shōsetsuka ni Narō — updated daily at 9 PM'),
    ('<span style="color:#cbd5e1;font-style:italic;">「未完成でも、下手でも」</span><br>\n        <span style="color:#cbd5e1;font-style:italic;">「それでも続けたいって思った時が、<br>　名乗るタイミングなんじゃないか」</span><br><br>\n        ヒナタ、コウタ、ハヤテ。<br>\n        三人がバンドを組んだのは、高校生のころ。<br><br>\n        ただ音を鳴らして、<br>\n        同じ時間を過ごして、<br>\n        少しずつ、何かが変わっていく。<br><br>\n        言えなかったことも、<br>\n        うまくいかなかった日も、<br>\n        そのまま残しながら進んでいく物語です。',
     '<span style="color:#cbd5e1;font-style:italic;">"Even if it\'s unfinished. Even if it\'s rough."</span><br>\n        <span style="color:#cbd5e1;font-style:italic;">"The moment you still want to keep going —<br>&nbsp;that\'s when you get to call yourself a band."</span><br><br>\n        Hinata, Kouta, Hayate.<br>\n        The three of them formed a band back in high school.<br><br>\n        Just playing music,<br>\n        sharing time together,<br>\n        something slowly changing.<br><br>\n        Things they couldn\'t say,<br>\n        days that didn\'t go right —<br>\n        a story that carries all of it and keeps moving forward.'),
    # Books
    ('1: 戻る場所', 'Vol.1: A Place to Return'),
    ('小説家になろう ep.1–34（高校編・大学編）収録　描き下ろし2編「置いた音」「1枚目の色紙」',
     'Syosetu ep.1–34 (High School &amp; College arc) · Bonus stories: "The Sound Left Behind," "The First Colored Paper"'),
    ('成功も、<wbr>約束も、<wbr>確かな未来もない。<br>それでも、<wbr>音を出すと分かってしまう。<br>この三人でなければ、<wbr>鳴らないものがあることを。<br><br>気づけば<br>同じ音の中にいる。<br><br>「続ける」と決める前の時間を描く。',
     'No success, no promises, no certain future.<br>And yet — the moment you make a sound, you know.<br>There\'s something that only rings out with these three.<br><br>Before you realize it,<br>you\'re inside the same sound.<br><br>A story of the time before deciding to keep going.'),
    ('Kindleで読む →', 'Read on Kindle →'),
    ('2: リトルスノー', 'Vol.2: Little Snow'),
    ('小説家になろう ep.35–68収録　描き下ろし童話「リトルスノー」',
     'Syosetu ep.35–68 · Original fairy tale: "Little Snow"'),
    ('小さくて、<wbr>溶けそうで、<br>でも消えなかった。<br><br>形にならない音。<br>言葉にするには、<wbr>まだ早い感情。<br><br>三人で鳴らすことを選んだあと、<br>音は少しずつ外へ向かいはじめる。<br><br>確かさはない。<br>それでも、<wbr>手放さなかった。<br><br>触れすぎず、<wbr>壊さず、<br>距離を測りながら。<br><br>小さな音は、<wbr>静かに残り続ける。',
     'Small, nearly melting,<br>but it didn\'t disappear.<br><br>A sound without form.<br>Emotions too early to put into words.<br><br>After choosing to play as three,<br>the sound slowly begins to face outward.<br><br>No certainty.<br>Even so, they didn\'t let go.<br><br>Not too close, not broken,<br>measuring the distance.<br><br>The small sound quietly keeps remaining.'),
    ('3: ショーケース/夏の月', 'Vol.3: Showcase / Summer Moon'),
    ('小説家になろう ep.69–89収録　描き下ろし「名前のない歌」',
     'Syosetu ep.69–89 · Bonus story: "A Song Without a Name"'),
    ('同じ時間を重ねていたはずの距離が、<br>ある夜を境に、<wbr>静かにずれていく。<br><br>声に引き寄せられ、<br>選ばなかったはずの場所へ足が向かう。<br><br>正しさと沈黙、<wbr>優しさと迷い。<br>それぞれの選択は、<wbr>言葉になる前にすれ違っていく。<br><br>音は、<wbr>答えをくれない。<br>ただ残り、<wbr>続いていく。<br><br>――音だけが、<wbr>置かれたまま。',
     'The distance they thought they\'d shared<br>quietly shifts after one particular night.<br><br>Drawn by a voice,<br>their feet carry them somewhere they never chose.<br><br>Rightness and silence, kindness and doubt.<br>Each choice passes the other by before becoming words.<br><br>The music gives no answers.<br>It only remains, continuing on.<br><br>— Only the sound, left in place.'),
    ('4: ポジション', 'Vol.4: Position'),
    ('小説家になろう ep.90–125収録　描き下ろし1編', 'Syosetu ep.90–125 · 1 bonus story'),
    ('正しさは、<wbr>すでに揃っている。<br>選択肢も、<wbr>説明も、<wbr>十分だ。<br><br>前に出る音。<br>支える音。<br>残す音。<br><br>それぞれのポジションで、<br>三人は同じ流れに乗っている。<br><br>音は続く。<br>役割を引き受けたまま。',
     'All the rightness is already in place.<br>Options, explanations — enough.<br><br>The sound that leads.<br>The sound that supports.<br>The sound that stays.<br><br>Each in their own position,<br>the three ride the same current.<br><br>The music continues.<br>Carrying their roles, just as they are.'),
    ('以下続刊', 'More volumes to come'),
    # Short stories
    ('>短編作品</', '>Short Stories</'),
    ('ひとつ多い音', 'One Extra Sound'),
    ('「音だけ残ってる、みたいな」', '"Like only the sound remains."'),
    ('スタジオで、いつも通り音を出す。<br><br>揃っている。<br>ズレていない。<br><br>――揃いすぎている。<br><br>その音は、<br>ひとつ、多い。',
     'In the studio, the sound comes out as always.<br><br>It\'s in tune.<br>Nothing\'s off.<br><br>— It\'s too in tune.<br><br>That sound is<br>one note too many.'),
    ('整えない音', 'An Unpolished Sound'),
    ('整えた瞬間、<br>これはきっと、別のものになる。',
     'The moment it\'s polished,<br>it becomes something else entirely.'),
    ('整える側としての自分と、歌う側としての自分。昼は仕事で物事を整え、夜はバンドで揺らぎのある音を鳴らすヒナタが、本当に歌いたい音を求めて進んでいく物語。',
     'Himself as the one who polishes, and himself as the one who sings. By day he refines things at work; by night he plays rough-edged music with the band. A story of Hinata searching for the sound he truly wants to sing.'),
    ('半分のまま', 'Staying Half'),
    ('この夜は、確かに何かを残している。',
     'This night is leaving something behind — that much is certain.'),
    ('同じ音楽制作の現場で働くヒナタと小雪。プロとして信頼し合いながら、一歩を踏み出さないまま曖昧なバランスを保ち続ける。雨の夜から始まる、選ばないまま守られる関係の物語。',
     'Hinata and Koyuki, working together in the same music production space. Trusting each other as professionals, maintaining an ambiguous balance without taking a single step forward. A story that begins on a rainy night — a relationship preserved by never choosing.'),
    ('白い音', 'White Sound'),
    ('行ってしまった。向こう側に。', 'He\'s gone. To the other side.'),
    ('春のキャンパスで出会った、黒いギターケースの学生。<br>ベンチで音を聴く時間が、少しずつ積み重なっていく。<br>置いていかれたわけじゃない。<br>ただ、彼が前に進むほど、同じ場所にはいられなくなっていった。<br><br>スノーフレークスの外側にいた、誰かの話。',
     'A student with a black guitar case, met on a spring campus.<br>Time spent listening to music on a bench, slowly accumulating.<br>She wasn\'t left behind.<br>Just — the further he moved forward, the less she could stay in the same place.<br><br>The story of someone who was on the outside of Snow flakes.'),
    ('正しい距離より、<br>触れている方がいい',
     'Being Close Feels Better<br>than the Right Distance'),
    ('「……触れてる方がいい」', '"...Being close feels better."'),
    ('気づいたら、舞踏会の玉座にいた。<br>金髪の王子と、黒髪の姫。整いすぎた、正しい距離。<br>ヒナタには、言葉にできない違和感だけが残る。<br>「ちゃんとしてる。でも、触れてない」<br>近づくほど、その差ははっきりしていく。<br>正しさと、心地よさ。揺れたまま、距離だけが変わっていく物語。<br>これは番外編。正しい距離の、その向こう側の話。',
     'Before he knew it, he was seated at a ballroom throne.<br>A blond prince and a dark-haired princess. A perfectly correct distance.<br>All that\'s left for Hinata is a wordless sense of wrongness.<br>"It\'s right. But there\'s no touch."<br>The closer he gets, the clearer the difference becomes.<br>Rightness and comfort. A story where only the distance changes, wavering throughout.<br>This is a side story — the tale of what lies beyond the right distance.'),
    ('名前も立場も知らないまま、それでも場の空気を変えていく人たちがいる。Snow flakesの外側視点から、気づかれないひびと、静かに変わっていく空気を拾う番外編。',
     'There are people who change the atmosphere of a room without even knowing each other\'s names. A side story seen from outside Snow flakes — picking up on imperceptible cracks and the quietly shifting air.'),
    ('Instagramで連載中の書き下ろし短編シリーズ。日常のひとこまを切り取った、小さくて静かな物語たち。',
     'An original short story series serialized on Instagram. Small, quiet stories that capture everyday moments.'),
    # SWEETs
    ('三人のお気に入りのお菓子と、少し特別な時間。<br>未公開短編や作品解説などのスペシャルコンテンツをまとめています。<br>随時更新予定。',
     'The three members\' favorite sweets and a little extra time.<br>Special content including unreleased short stories and commentary.<br>Updated regularly.'),
    ('SWEETs CODEはInstagramのリールをチェック。',
     'For the SWEETs CODE, check the Instagram reels.'),
    # Music
    ('>音楽</', '>Music</'),
    ('各ストリーミングサービスで配信中', 'Now streaming on all platforms'),
    ('Spotify・Apple Music・Amazon Music・YouTube Musicほか各種ストリーミングサービスで楽曲を配信。小説の世界観をもとに制作した楽曲を、いつでも聴ける。',
     'Music available on Spotify, Apple Music, Amazon Music, YouTube Music, and more. Songs created from the world of the novel — listen anytime.'),
    ('Sunoでも楽曲を公開中。グラスの縁・呼吸の距離など、ストリーミング未配信の楽曲も聴ける。',
     'Music also available on Suno — including tracks not on streaming services, like "Glass Edge" and "Breathing Distance."'),
    ('Sunoで聴く →', 'Listen on Suno →'),
    # Discography
    ('>ディスコグラフィ</', '>Discography</'),
    ('>配信中</', '>Streaming</'),
    ('>約束はしない</', '>No Promises</'),
    ('>透明のまま</', '>Staying Transparent</'),
    ('>名前のない歌</', '>A Song Without a Name</'),
    # Links
    ('>リンク</', '>Links</'),
    ('>小説を読む</p>', '>Read the Novel</p>'),
    ('>電子書籍</p>', '>eBooks</p>'),
    ('>音楽を聴く</p>', '>Listen to Music</p>'),
    ('書き下ろし短編 / 映像リール / 未公開楽曲デモ',
     'Original short stories / Video reels / Unreleased demos'),
    ('楽曲 / ショート / Snow flakesアレンジ作業用BGM',
     'Music / Shorts / Lo-fi study BGM'),
    ('>リズムゲーム</p>', '>Rhythm Game</p>'),
    ('制作中 — デモで遊べます！', 'In development — try the demo!'),
    # Closing
    ('あなたの中にも、きっと残る。', 'Something will stay with you too.'),
    ('少しでも何かが残ったら、<br>\n    いいねや登録で応援していただけると嬉しいです。',
     'If something stayed with you even a little,<br>\n    we\'d love your support — likes and follows mean a lot.'),
    # App CTA
    ('Snow flakesの世界観をまとったタスク管理アプリも公開中',
     'A task management app dressed in the Snow flakes aesthetic — now available.'),
    ('アプリ紹介を見る →', 'View the app →'),
    # Footer
    ('山吹ことり について', 'About Kotori Yamabuki'),
    # News banner (partial)
    ('本編 毎日21時更新', 'Main story — updated daily at 9 PM'),
    # Character names — must come LAST (appear inside longer strings above)
    ('>ヒナタ</p>', '>Hinata</p>'),
    ('>コウタ</p>', '>Kouta</p>'),
    ('>ハヤテ</p>', '>Hayate</p>'),
]

not_found = []
for ja, en in replacements:
    if ja in html_part:
        html_part = html_part.replace(ja, en)
    else:
        not_found.append(ja[:50])

if not_found:
    print('WARNING - not found in HTML:')
    for s in not_found:
        print(f'  {s}')

html = html_part + SPLIT_MARKER + script_part

# ── Meta & structural updates ──────────────────────────────────────────────

# lang attribute
html = html.replace('<html lang="ja">', '<html lang="en">', 1)

# Add <base href="../"> so all relative paths resolve correctly from /en/
html = html.replace('<head>', '<head>\n  <base href="../">', 1)

# Title
html = html.replace(
    '<title>Snow flakes | 山吹ことり オフィシャルサイト</title>',
    '<title>Snow flakes | Kotori Yamabuki Official Site</title>',
    1
)

# meta description
html = html.replace(
    'content="山吹ことりによる小説・音楽・イラストのプロジェクト「Snow flakes」公式サイト。小説家になろう連載中・各種ストリーミングで楽曲配信中。"',
    'content="Snow flakes — Official site of Kotori Yamabuki. A story and music project. Novel serialized daily. Music on all streaming platforms."',
    1
)

# og:title
html = html.replace(
    'content="Snow flakes | 山吹ことり オフィシャルサイト"',
    'content="Snow flakes | Kotori Yamabuki Official Site"',
    1
)

# og:description
html = html.replace(
    'content="山吹ことりによる小説・音楽・イラストのプロジェクト「Snow flakes」公式サイト。"',
    'content="Snow flakes — A story and music project by Kotori Yamabuki."',
    1
)

# og:url
html = html.replace(
    'content="https://sunnyplace25.github.io/snowflakes/"',
    'content="https://sunnyplace25.github.io/snowflakes/en/"',
    1
)

# canonical
html = html.replace(
    '<link rel="canonical" href="https://sunnyplace25.github.io/snowflakes/">',
    '<link rel="canonical" href="https://sunnyplace25.github.io/snowflakes/en/">',
    1
)

# hreflang: swap ja/en references
html = html.replace(
    '<link rel="alternate" hreflang="ja" href="https://sunnyplace25.github.io/snowflakes/">',
    '<link rel="alternate" hreflang="ja" href="https://sunnyplace25.github.io/snowflakes/">\n  <!-- en canonical set above -->',
    1
)
# Actually just replace the block entirely
html = html.replace(
    '<link rel="alternate" hreflang="ja" href="https://sunnyplace25.github.io/snowflakes/">\n  <!-- en canonical set above -->\n  <link rel="alternate" hreflang="en" href="https://sunnyplace25.github.io/snowflakes/en/">\n  <link rel="alternate" hreflang="x-default" href="https://sunnyplace25.github.io/snowflakes/">',
    '<link rel="alternate" hreflang="ja" href="https://sunnyplace25.github.io/snowflakes/">\n  <link rel="alternate" hreflang="en" href="https://sunnyplace25.github.io/snowflakes/en/">\n  <link rel="alternate" hreflang="x-default" href="https://sunnyplace25.github.io/snowflakes/">',
    1
)

# ── JS: default to English on this page ───────────────────────────────────
# Change default lang from 'ja' to 'en'
html = html.replace(
    "var currentLang = localStorage.getItem('sf-lang') || 'ja';",
    "var currentLang = (localStorage.getItem('sf-lang') === 'ja') ? 'ja' : 'en';",
    1
)
# On startup: apply 'ja' if saved (HTML is already in English)
html = html.replace(
    "if (currentLang === 'en') {\n    if (document.readyState === 'loading') {\n      document.addEventListener('DOMContentLoaded', function() { applyLang('en'); });\n    } else {\n      applyLang('en');\n    }\n  }",
    "if (currentLang === 'ja') {\n    if (document.readyState === 'loading') {\n      document.addEventListener('DOMContentLoaded', function() { applyLang('ja'); });\n    } else {\n      applyLang('ja');\n    }\n  }",
    1
)

# Button initial text: show "JP" since we start in English
html = html.replace(
    '<button id="lang-toggle" onclick="toggleLang()">EN</button>',
    '<button id="lang-toggle" onclick="toggleLang()">JP</button>',
    1
)

# ── Output ─────────────────────────────────────────────────────────────────
os.makedirs('en', exist_ok=True)
with open('en/index.html', 'w', encoding='utf-8') as f:
    f.write(html)

print('OK Generated en/index.html')
