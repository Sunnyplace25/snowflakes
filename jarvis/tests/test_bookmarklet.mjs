// Bookmarklet validation test (2-click MutationObserver version)
import { writeFileSync } from 'node:fs';

// ── Same lines as buildBookmarklet() in business-merch-competitor.js ─────
const lines = [
  '(function(){',
  'var KEY="__jarvisCollector";',
  'if(!window[KEY]){',
  'window[KEY]={items:{},obs:null};',
  'function extractCard(c){',
  '  var anc=c.querySelector("a");',
  '  var img=c.querySelector("img");',
  '  var pm=c.querySelector("[class*=\'price\'],[class*=\'Price\']");',
  '  var nm=c.querySelector("[class*=\'name\'],[class*=\'Name\'],[class*=\'title\']");',
  '  var href=anc?anc.href:"";',
  '  var hp=href.split("/").filter(function(p){return p.length>0;});',
  '  var iIdx=hp.indexOf("item");',
  '  var itemId=iIdx>=0&&hp[iIdx+1]?hp[iIdx+1]:null;',
  '  if(!itemId||window[KEY].items[itemId])return;',
  '  var pt=pm?pm.textContent:"";',
  '  var pd="";',
  '  for(var i=0;i<pt.length;i++){var cc=pt.charCodeAt(i);if(cc>=48&&cc<=57)pd+=pt[i];}',
  '  var st="ITEM_STATUS_ON_SALE";',
  '  var soldEl=c.querySelector("[class*=\'sold\'],[class*=\'Sold\'],[data-testid*=\'sold\']");',
  '  if(soldEl){st="ITEM_STATUS_SOLD_OUT";}',
  '  else{',
  '    var badge=c.querySelector("[class*=\'badge\'],[class*=\'label\'],[class*=\'status\'],[class*=\'overlay\']");',
  '    if(badge){var bt=badge.textContent;if(bt.indexOf("SOLD")>=0||bt.indexOf("\u58f2\u308a\u5207\u308c")>=0)st="ITEM_STATUS_SOLD_OUT";}',
  '  }',
  '  window[KEY].items[itemId]={id:itemId,name:nm?nm.textContent.trim():null,price:pd?parseInt(pd,10):0,status:st,image_url:img?img.src:null,item_url:href};',
  '}',
  'function scan(){',
  '  var cards=document.querySelectorAll("[data-testid=\'item-cell\'],[data-location*=\'item_thumbnail_list\'],[class*=\'merItem\'],[class*=\'item-cell\']");',
  '  Array.from(cards).forEach(extractCard);',
  '}',
  'var nd=window.__NEXT_DATA__;',
  'if(nd){',
  '  var pp=(nd.props&&nd.props.pageProps)||{};',
  '  var ri=pp.items||(pp.data&&pp.data.items)||(pp.seller&&pp.seller.items)||(pp.searchResult&&pp.searchResult.items)||[];',
  '  ri.forEach(function(r){',
  '    var id=String(r.id||"").trim();if(!id)return;',
  '    var price=(r.price&&typeof r.price==="object")?Number(r.price.amount||r.price.value||0):Number(r.price||0);',
  '    window[KEY].items[id]={',
  '      id:id,name:r.name||"",price:price,',
  '      status:r.status||"ITEM_STATUS_ON_SALE",',
  '      brand:(r.itemBrand&&r.itemBrand.name)||r.brand||null,',
  '      category:(r.itemCategory&&r.itemCategory.name)||r.category||null,',
  '      size:(r.itemSize&&r.itemSize.name)||r.size||null,',
  '      color:(r.colors&&r.colors[0]&&r.colors[0].name)||r.color||null,',
  '      image_url:(r.thumbnails&&r.thumbnails[0])||r.thumbnail||null,',
  '      item_url:r.id?"https://jp.mercari.com/item/"+r.id:null',
  '    };',
  '  });',
  '}',
  'scan();',
  'var obs=new MutationObserver(function(){scan();});',
  'obs.observe(document.body,{childList:true,subtree:true});',
  'window[KEY].obs=obs;',
  'var cnt=Object.keys(window[KEY].items).length;',
  'alert("JARVIS: \u53ce\u96c6\u958b\u59cb\uff01\u73fe\u5728"+cnt+"\u4ef6\u3002\\n\u30da\u30fc\u30b8\u3092\u4e0b\u307e\u3067\u30b9\u30af\u30ed\u30fc\u30eb\u3057\u3066\u304f\u3060\u3055\u3044\u3002\\n\u5168\u5546\u54c1\u8868\u793a\u5f8c\u3001\u3082\u3046\u4e00\u5ea6\u30af\u30ea\u30c3\u30af\u3057\u3066\u4fdd\u5b58\u3057\u3066\u304f\u3060\u3055\u3044\u3002");',
  '}else{',
  'if(window[KEY].obs)window[KEY].obs.disconnect();',
  'var items=Object.values(window[KEY].items);',
  'delete window[KEY];',
  'if(items.length===0){alert("JARVIS: \u5546\u54c1\u30c7\u30fc\u30bf\u304c\u3042\u308a\u307e\u305b\u3093\u3002\u30e1\u30eb\u30ab\u30ea\u306e\u51fa\u54c1\u8005\u30d7\u30ed\u30d5\u30a3\u30fc\u30eb\u30da\u30fc\u30b8\u3067\u5b9f\u884c\u3057\u3066\u304f\u3060\u3055\u3044\u3002");return;}',
  'var parts=location.pathname.split("/").filter(function(p){return p.length>0;});',
  'var pIdx=parts.indexOf("profile");',
  'var sellerId=pIdx>=0&&parts[pIdx+1]?parts[pIdx+1]:"unknown";',
  'var ts=new Date().toISOString();',
  'var data={jarvis_import:true,seller_id:sellerId,extracted_at:ts,source:"bookmarklet_v2",items:items};',
  'var blob=new Blob([JSON.stringify(data,null,2)],{type:"application/json"});',
  'var bUrl=URL.createObjectURL(blob);',
  'var dl=document.createElement("a");',
  'dl.href=bUrl;',
  'dl.download="mercari_"+sellerId+"_"+ts.slice(0,10)+".json";',
  'document.body.appendChild(dl);',
  'dl.click();',
  'document.body.removeChild(dl);',
  'setTimeout(function(){URL.revokeObjectURL(bUrl);},3000);',
  'alert("JARVIS: "+items.length+"\u4ef6\u306e\u5546\u54c1\u30c7\u30fc\u30bf\u3092\u4fdd\u5b58\u3057\u307e\u3057\u305f\u3002\\nJARVIS\u7af6\u5408\u5206\u6790\u306e\u300c\u624b\u52d5\u53d6\u308a\u8fbc\u307f\u300d\u3078\u30c9\u30e9\u30c3\u30b0\uff06\u30c9\u30ed\u30c3\u30d7\u3057\u3066\u304f\u3060\u3055\u3044\u3002");',
  '}',
  '})();',
];

const decoded = lines.join('\n');

// ── バックスラッシュ検出（\n \u など正規エスケープ以外を検出）─────────────
console.log('=== バックスラッシュ検出 ===');
// \n \u \\ \' \" は正規。それ以外のバックスラッシュ使われ方を検出
const bsPositions = [];
for (let i = 0; i < decoded.length; i++) {
  if (decoded.codePointAt(i) === 92) {
    const next = decoded[i + 1];
    if (next !== 'n' && next !== 'u' && next !== '\\' && next !== "'" && next !== '"') {
      bsPositions.push(i);
      console.log(`  位置${i}: "${decoded.slice(Math.max(0,i-6), i+8)}" (次文字: '${next}')`);
    }
  }
}
if (bsPositions.length === 0) console.log('  問題なし — OK');

// ── Problem patterns ──────────────────────────────────────────────────────
console.log('\n=== 問題パターンチェック ===');
[
  ['壊れた regex (d+)',   decoded.includes('(d+)')],
  ['壊れた //user',      decoded.includes('//user')],
  ['壊れた //item',      decoded.includes('//item')],
  ['match( / )',         decoded.includes('match(/')],
].forEach(([k,bad]) => console.log(k + ':', bad ? 'NG' : 'OK'));

// ── Required tokens ───────────────────────────────────────────────────────
console.log('\n=== 必要要素チェック ===');
[
  ['2クリック状態キー',        '__jarvisCollector'],
  ['MutationObserver',         'MutationObserver'],
  ['obs.observe',              'obs.observe'],
  ['obs.disconnect',           'obs.disconnect'],
  ['Object.values',            'Object.values'],
  ['split("/") パス解析',      'split("/")'],
  ['indexOf("profile")',       'indexOf("profile")'],
  ['indexOf("item")',          'indexOf("item")'],
  ['charCodeAt 数字抽出',      'charCodeAt'],
  ['ITEM_STATUS_SOLD_OUT',     'ITEM_STATUS_SOLD_OUT'],
  ['sold クラス判定',          'sold'],
  ['売り切れ判定',             '\u58f2\u308a\u5207\u308c'],
  ['setTimeout revokeObjectURL','setTimeout'],
  ['URL.revokeObjectURL',      'revokeObjectURL'],
  ['jarvis_import フラグ',     'jarvis_import'],
  ['bookmarklet_v2',           'bookmarklet_v2'],
  ['__NEXT_DATA__',            '__NEXT_DATA__'],
  ['querySelectorAll',         'querySelectorAll'],
  ['new Blob',                 'new Blob'],
  ['dl.click()',               'dl.click()'],
  ['setTimeout 3000ms',        '3000'],
].forEach(([label, token]) => {
  console.log(label + ':', decoded.includes(token) ? 'OK' : 'MISSING');
});

// ── Syntax check ──────────────────────────────────────────────────────────
console.log('\n=== 構文チェック ===');
try {
  new Function(decoded);
  console.log('OK');
} catch(e) {
  console.log('エラー:', e.message);
  const m = e.message.match(/line (\d+)/);
  if (m) {
    const ln = parseInt(m[1]);
    console.log('問題行:', decoded.split('\n')[ln - 1]);
  }
}

// ── Logic test (mock) ─────────────────────────────────────────────────────
console.log('\n=== ロジックテスト（モック） ===');

// Test 1: pathname parsing
const testPathname = (pathname) => {
  const parts = pathname.split('/').filter(p => p.length > 0);
  const pIdx = parts.indexOf('profile');
  return pIdx >= 0 && parts[pIdx+1] ? parts[pIdx+1] : 'unknown';
};
console.log('pathname /user/profile/12345678 →', testPathname('/user/profile/12345678'));
console.log('pathname /other/page →', testPathname('/other/page'));

// Test 2: item ID parsing
const testItemId = (href) => {
  const hp = href.split('/').filter(p => p.length > 0);
  const iIdx = hp.indexOf('item');
  return iIdx >= 0 && hp[iIdx+1] ? hp[iIdx+1] : null;
};
console.log('href .../item/m12345678901234 →', testItemId('https://jp.mercari.com/item/m12345678901234'));

// Test 3: price extraction
const testPrice = (text) => {
  let pd = '';
  for (let i = 0; i < text.length; i++) {
    const cc = text.charCodeAt(i);
    if (cc >= 48 && cc <= 57) pd += text[i];
  }
  return pd ? parseInt(pd, 10) : 0;
};
console.log('価格テキスト "¥1,000" →', testPrice('¥1,000'));
console.log('価格テキスト "3,500円" →', testPrice('3,500円'));

// Test 4: sold status detection (sold-class element present)
const testStatus = (hasSoldEl, badgeText) => {
  let st = 'ITEM_STATUS_ON_SALE';
  if (hasSoldEl) {
    st = 'ITEM_STATUS_SOLD_OUT';
  } else if (badgeText) {
    if (badgeText.indexOf('SOLD') >= 0 || badgeText.indexOf('\u58f2\u308a\u5207\u308c') >= 0) {
      st = 'ITEM_STATUS_SOLD_OUT';
    }
  }
  return st;
};
console.log('soldEl あり →', testStatus(true, null));
console.log('バッジ "SOLD" →', testStatus(false, 'SOLD'));
console.log('バッジ "売り切れ" →', testStatus(false, '売り切れ'));
console.log('通常商品 →', testStatus(false, null));

// Test 5: deduplication via object key
const testDedup = () => {
  const items = {};
  ['m111', 'm222', 'm111', 'm333'].forEach(id => {
    if (!items[id]) items[id] = { id };
  });
  return Object.keys(items).length;
};
console.log('重複除外（4件→3件）→', testDedup(), '件');

// ── Output URL ────────────────────────────────────────────────────────────
const url = 'javascript:' + encodeURIComponent(decoded);
console.log('\n=== URL 情報 ===');
console.log('URL長:', url.length, '文字');

writeFileSync('tests/bookmarklet_url.txt', url, 'utf8');
console.log('→ tests/bookmarklet_url.txt に書き出し完了');
console.log('  Edgeのブックマーク編集 → URLに貼り付けて動作確認してください');
console.log('  1回目クリック: 収集開始アラート → スクロール → 2回目クリック: JSON保存');
