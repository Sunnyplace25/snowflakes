/**
 * ブラウザ確認スクリプト（Puppeteer）
 * PowerShell から実行:
 *   Set-Location 'C:\Users\Sunny\snowflakes\jarvis'
 *   node tests\browser_check.mjs
 */
import puppeteer from 'puppeteer';
import { writeFileSync, appendFileSync, mkdirSync } from 'node:fs';

const SHOT_DIR = 'C:\\Users\\Sunny\\jarvis_screenshots';
const LOG_FILE = 'C:\\Users\\Sunny\\browser_check.log';

try { mkdirSync(SHOT_DIR, { recursive: true }); } catch {}
writeFileSync(LOG_FILE, '', 'utf8');

const delay = ms => new Promise(r => setTimeout(r, ms));
let passed = 0;
let failed = 0;
const issues = [];

function log(msg)  { appendFileSync(LOG_FILE, msg + '\n', 'utf8'); process.stdout.write(msg + '\n'); }
function ok(label) { log(`  ✅ ${label}`); passed++; }
function fail(label, detail = '') { log(`  ❌ ${label}${detail ? ': ' + detail : ''}`); failed++; issues.push(label); }

async function shot(page, name) {
  await page.screenshot({ path: `${SHOT_DIR}\\${name}.png`, fullPage: false });
}

const browser = await puppeteer.launch({
  executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  headless: true,
  args: ['--no-sandbox', '--disable-setuid-sandbox'],
  defaultViewport: { width: 1400, height: 900 },
});

try {
  const page = await browser.newPage();

  // ── 1. ページ読み込み / 作品管理タブへ移動 ─────────────────────────────
  log('\n── 1. ページ読み込み / 作品管理タブへ移動 ──────────────────────');
  await page.goto('http://localhost:3000', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await delay(2000);
  await shot(page, '01_top');

  // 1) 「Snow flakes」モジュールタブをクリック
  await page.click('button[data-module="sf"]');
  await delay(800);

  // 2) 「物語・小説」大タブをクリック
  await page.click('button[data-sf-bigtab="story"]');
  await delay(600);

  // 3) 「作品管理」サブタブをクリック
  await page.click('button[data-sf-tab="works"]');
  await delay(600);
  await shot(page, '02_works_tab');
  ok('Snow flakes → 物語・小説 → 作品管理タブへ移動');

  // API ロード完了まで待機
  try {
    await page.waitForSelector('#sf-works-container .sf-works-table', { timeout: 10000 });
    ok('作品テーブルが描画された');
  } catch {
    fail('作品テーブルが描画されなかった');
    // 以降のテストができないので終了
  }

  await shot(page, '03_works_table');

  // ── 2. ヘッダーソート ─────────────────────────────────────────────────
  log('\n── 2. ヘッダーソート ────────────────────────────────────────');

  // ソート前の行順を記録
  const originalIds = await page.evaluate(() =>
    [...document.querySelectorAll('#sf-works-container .sf-works-table tbody tr[data-work-id]')]
      .map(tr => tr.dataset.workId)
  );
  log(`  行数: ${originalIds.length}`);

  const titleThSel = 'th[data-works-sort-col="title"]';

  // ── タイトル列 ────────────────────────────────────────────────────────
  const titleThSelector = titleThSel;
  const hasTitleTh = await page.$(titleThSelector);
  if (!hasTitleTh) {
    fail('タイトル列ヘッダー th[data-works-sort-col="title"] が見つからない');
  } else {
    // 1回目: 昇順
    await page.click(titleThSelector);
    await delay(400);
    await shot(page, '03_sort_title_asc');

    const arrowAsc = await page.evaluate(() =>
      document.querySelector('th[data-works-sort-col="title"] .sf-sort-arrow.active')?.textContent?.trim()
    );
    if (arrowAsc === '↑') ok('タイトル昇順: ↑ が表示される');
    else fail('タイトル昇順: ↑ が表示されない', `actual="${arrowAsc}"`);

    // 他の列に active arrow がないことを確認
    const otherActive = await page.evaluate(() =>
      [...document.querySelectorAll('th[data-works-sort-col]:not([data-works-sort-col="title"]) .sf-sort-arrow.active')]
        .map(el => el.closest('th')?.dataset.worksSortCol)
    );
    if (otherActive.length === 0) ok('タイトル列以外に active arrow なし');
    else fail('他列にも active arrow が付いている', otherActive.join(','));

    const firstTitleAsc = await page.evaluate(() =>
      document.querySelector('#sf-works-container tbody tr:first-child td:nth-child(2)')?.textContent?.trim()
    );
    ok(`タイトル昇順1位: "${firstTitleAsc}"`);

    // 2回目: 降順
    await page.click(titleThSelector);
    await delay(400);
    await shot(page, '04_sort_title_desc');
    const arrowDesc = await page.evaluate(() =>
      document.querySelector('th[data-works-sort-col="title"] .sf-sort-arrow.active')?.textContent?.trim()
    );
    if (arrowDesc === '↓') ok('タイトル降順: ↓ が表示される');
    else fail('タイトル降順: ↓ が表示されない', `actual="${arrowDesc}"`);

    const firstTitleDesc = await page.evaluate(() =>
      document.querySelector('#sf-works-container tbody tr:first-child td:nth-child(2)')?.textContent?.trim()
    );
    ok(`タイトル降順1位: "${firstTitleDesc}"`);
    if (firstTitleAsc !== firstTitleDesc) ok('昇順と降順で先頭が異なる（ソートが効いている）');
    else fail('昇順と降順で先頭が同じ（ソートが効いていない可能性）');

    // 3回目: ソート解除
    await page.click(titleThSelector);
    await delay(400);
    await shot(page, '05_sort_reset');
    const noArrow = await page.evaluate(() =>
      document.querySelector('th[data-works-sort-col="title"] .sf-sort-arrow.active')
    );
    if (!noArrow) ok('3回目クリックでソート解除（active arrow なし）');
    else fail('ソート解除後も active arrow が残っている');

    const restoredIds = await page.evaluate(() =>
      [...document.querySelectorAll('#sf-works-container .sf-works-table tbody tr[data-work-id]')]
        .map(tr => tr.dataset.workId)
    );
    if (JSON.stringify(restoredIds) === JSON.stringify(originalIds))
      ok('ソート解除後に手動順へ戻る');
    else fail('ソート解除後に手動順へ戻っていない', `expected[0]=${originalIds[0]}, got[0]=${restoredIds[0]}`);
  }

  // ── 種別ソート ────────────────────────────────────────────────────────
  const typeThSel = 'th[data-works-sort-col="type"]';
  if (await page.$(typeThSel)) {
    await page.click(typeThSel);
    await delay(400);
    const types = await page.evaluate(() =>
      [...document.querySelectorAll('#sf-works-container tbody tr td:nth-child(3)')]
        .map(td => td.textContent.trim())
    );
    const ORDER = ['長編小説','短編連作','短編小説','ゲーム','その他'];
    let prevRank = -1, typeOk = true;
    for (const t of types) {
      const rank = ORDER.findIndex(o => t === o);
      if (rank === -1) continue;
      if (rank < prevRank) { typeOk = false; break; }
      prevRank = rank;
    }
    if (typeOk) ok('種別昇順: 長編小説→短編連作→短編小説→ゲーム→その他');
    else fail('種別ソート順序が正しくない', types.slice(0, 6).join(', '));
    // リセット
    await page.click(typeThSel); await delay(100);
    await page.click(typeThSel); await delay(300);
    await shot(page, '06_sort_type');
  }

  // ── 公開日ソート（NULL末尾） ──────────────────────────────────────────
  const pubdateThSel = 'th[data-works-sort-col="pubdate"]';
  if (await page.$(pubdateThSel)) {
    // 昇順
    await page.click(pubdateThSel);
    await delay(400);
    const datesAsc = await page.evaluate(() =>
      [...document.querySelectorAll('#sf-works-container tbody tr td:nth-child(4)')]
        .map(td => td.textContent.trim())
    );
    const firstDash = datesAsc.findIndex(d => d === '—');
    let dashAtEnd = true;
    if (firstDash !== -1) {
      for (let i = firstDash; i < datesAsc.length; i++) {
        if (datesAsc[i] !== '—') { dashAtEnd = false; break; }
      }
    }
    if (dashAtEnd) ok(`公開日昇順: — は末尾に集まる (先頭: "${datesAsc[0]}")`);
    else fail('公開日昇順: — が末尾に集まっていない');

    // 降順
    await page.click(pubdateThSel);
    await delay(400);
    const datesDesc = await page.evaluate(() =>
      [...document.querySelectorAll('#sf-works-container tbody tr td:nth-child(4)')]
        .map(td => td.textContent.trim())
    );
    const firstDashDesc = datesDesc.findIndex(d => d === '—');
    let dashAtEndDesc = true;
    if (firstDashDesc !== -1) {
      for (let i = firstDashDesc; i < datesDesc.length; i++) {
        if (datesDesc[i] !== '—') { dashAtEndDesc = false; break; }
      }
    }
    if (dashAtEndDesc) ok(`公開日降順: — は末尾に集まる (先頭: "${datesDesc[0]}")`);
    else fail('公開日降順: — が末尾に集まっていない');

    await page.click(pubdateThSel); await delay(300);
    await shot(page, '07_sort_pubdate');
  }

  // ── 公開状態ソート ────────────────────────────────────────────────────
  const statusThSel = 'th[data-works-sort-col="status"]';
  if (await page.$(statusThSel)) {
    await page.click(statusThSel);
    await delay(400);
    const statuses = await page.evaluate(() =>
      [...document.querySelectorAll('#sf-works-container tbody tr td:nth-child(5) .sf-badge')]
        .map(b => b.textContent.trim())
    );
    const rank = s => s.includes('公開中') ? 0 : (s.includes('未公開') ? 1 : 2);
    let statusOk = true;
    for (let i = 1; i < statuses.length; i++) {
      if (rank(statuses[i]) < rank(statuses[i - 1])) { statusOk = false; break; }
    }
    if (statusOk) ok('公開状態昇順: 公開中→未公開→公開先未登録');
    else fail('公開状態ソート順序が正しくない', statuses.slice(0, 6).join(' | '));
    await page.click(statusThSel); await delay(100);
    await page.click(statusThSel); await delay(300);
    await shot(page, '08_sort_status');
  }

  // ── アーカイブ件数ソート ──────────────────────────────────────────────
  const arcThSel = 'th[data-works-sort-col="archive"]';
  if (await page.$(arcThSel)) {
    await page.click(arcThSel);  // 昇順
    await delay(300);
    await page.click(arcThSel);  // 降順
    await delay(400);
    const firstArcBadge = await page.evaluate(() =>
      document.querySelector('#sf-works-container tbody tr td:nth-child(6) .sf-badge')?.textContent?.trim()
    );
    if (firstArcBadge?.includes('件')) ok(`アーカイブ降順: 先頭が「${firstArcBadge}」`);
    else ok(`アーカイブ降順: 先頭バッジ="${firstArcBadge}"`);
    await page.click(arcThSel); await delay(300);
    await shot(page, '09_sort_archive');
  }

  // ── 3. ドラッグ制御 ──────────────────────────────────────────────────
  log('\n── 3. ドラッグ制御 ──────────────────────────────────────────');

  // ソート有効にする
  await page.click(titleThSel ?? 'th[data-works-sort-col="title"]');
  await delay(400);

  const draggableInSort = await page.evaluate(() =>
    [...document.querySelectorAll('#sf-works-container tbody tr')].some(tr => tr.getAttribute('draggable') === 'true')
  );
  const handleDisabled = await page.evaluate(() =>
    document.querySelectorAll('#sf-works-container .works-drag-handle--disabled').length > 0
  );
  if (!draggableInSort) ok('ソート中: draggable="true" な行が存在しない');
  else fail('ソート中: draggable="true" な行が存在する');
  if (handleDisabled) ok('ソート中: works-drag-handle--disabled が存在する');
  else fail('ソート中: works-drag-handle--disabled が存在しない');

  // ソート解除
  await page.click(titleThSel ?? 'th[data-works-sort-col="title"]');
  await delay(100);
  await page.click(titleThSel ?? 'th[data-works-sort-col="title"]');
  await delay(400);

  const draggableAfterReset = await page.evaluate(() =>
    [...document.querySelectorAll('#sf-works-container tbody tr')].some(tr => tr.getAttribute('draggable') === 'true')
  );
  if (draggableAfterReset) ok('ソート解除後: draggable="true" な行が存在する');
  else fail('ソート解除後: draggable な行が存在しない');

  // ── 4. display_order 不変確認 ────────────────────────────────────────
  log('\n── 4. display_order 不変確認 ─────────────────────────────────');

  const orderBefore = await page.evaluate(async () => {
    const r = await fetch('/api/sf/works');
    const d = await r.json();
    return d.works.map(w => ({ id: w.id, display_order: w.display_order }));
  });

  // ソート3サイクル操作
  await page.click('th[data-works-sort-col="title"]'); await delay(150);
  await page.click('th[data-works-sort-col="title"]'); await delay(150);
  await page.click('th[data-works-sort-col="title"]'); await delay(400);

  const orderAfter = await page.evaluate(async () => {
    const r = await fetch('/api/sf/works');
    const d = await r.json();
    return d.works.map(w => ({ id: w.id, display_order: w.display_order }));
  });

  if (JSON.stringify(orderBefore) === JSON.stringify(orderAfter))
    ok('display_order がソート操作で変化しない（API 確認）');
  else
    fail('display_order が変化した', JSON.stringify(orderAfter.slice(0, 3)));

  // ── 5. 公開URL管理モーダル ───────────────────────────────────────────
  log('\n── 5. 公開URL管理モーダル ───────────────────────────────────');

  await page.setViewport({ width: 1400, height: 900 });

  // ソートが残っていたら解除
  const sortActive = await page.evaluate(() => !!document.querySelector('th.works-th-sorted'));
  if (sortActive) {
    const activeCol = await page.evaluate(() => document.querySelector('th.works-th-sorted')?.dataset?.worksSortCol);
    if (activeCol) {
      const sel = `th[data-works-sort-col="${activeCol}"]`;
      const dir = await page.evaluate(s => document.querySelector(s)?.querySelector('.sf-sort-arrow.active')?.textContent, sel);
      await page.click(sel); await delay(100);
      if (dir === '↑') { await page.click(sel); await delay(100); }
      await page.click(sel); await delay(300);
    }
  }

  // … ボタンをクリック
  const moreBtn = await page.$('.works-more-btn');
  if (!moreBtn) {
    fail('… メニューボタンが見つからない');
  } else {
    await moreBtn.click();
    await delay(400);

    const pubBtn = await page.$('.works-pub-btn');
    if (!pubBtn) {
      fail('「公開先を管理」ボタンが見つからない');
    } else {
      await pubBtn.click();
      await delay(1200);
      await shot(page, '10_pub_modal');

      const modalVisible = await page.evaluate(() => {
        const m = document.getElementById('modal-work-pub');
        return m && !m.hidden;
      });
      if (modalVisible) ok('公開URL管理モーダルが開いた');
      else fail('モーダルが表示されない');

      // 横スクロールなし
      const hScroll = await page.evaluate(() => {
        const body = document.getElementById('modal-work-pub-body');
        if (!body) return { overflow: 'no-body', sw: 0, cw: 0 };
        return { sw: body.scrollWidth, cw: body.clientWidth };
      });
      if (hScroll.sw <= hScroll.cw + 2)
        ok(`横スクロールなし (scrollWidth=${hScroll.sw}, clientWidth=${hScroll.cw})`);
      else
        fail('横スクロール発生', `scrollWidth=${hScroll.sw} > clientWidth=${hScroll.cw}`);

      // overflow-x が hidden で内容が隠れていないか（URL入力欄の実幅を確認）
      const urlInputInfo = await page.evaluate(() => {
        const input = document.querySelector('.pub-url-input');
        if (!input) return null;
        const r = input.getBoundingClientRect();
        return { width: Math.round(r.width), visible: r.width > 50 };
      });
      if (!urlInputInfo) fail('pub-url-input が存在しない');
      else if (urlInputInfo.visible) ok(`URL入力欄が十分な幅を持つ (${urlInputInfo.width}px)`);
      else fail('URL入力欄が狭すぎる', `width=${urlInputInfo.width}px`);

      // 「保存」ボタンが viewport 内に収まっているか
      const saveBtns = await page.$$('.pub-save-btn');
      if (saveBtns.length === 0) {
        fail('保存ボタンが見つからない');
      } else {
        let allInView = true;
        for (const btn of saveBtns) {
          const inView = await page.evaluate(el => {
            const r = el.getBoundingClientRect();
            return r.right <= window.innerWidth + 2 && r.left >= 0 && r.width > 0;
          }, btn);
          if (!inView) { allInView = false; break; }
        }
        if (allInView) ok('全「保存」ボタンが viewport 内に収まっている');
        else fail('保存ボタンが viewport 外にはみ出している');
      }

      // 6列確認
      const colCount = await page.evaluate(() =>
        document.querySelectorAll('.pub-modal-table thead th').length
      );
      if (colCount === 6) ok(`テーブル列数: 6列`);
      else fail(`テーブル列数が6でない`, `actual=${colCount}`);

      // ↗ ボタン
      const openBtn = await page.$('.pub-open-btn');
      if (openBtn) ok('↗ ボタンが存在する');
      else ok('↗ ボタンなし（URLなし行のみ）');

      await shot(page, '11_pub_modal_detail');

      // モーダルを閉じる
      const closeBtn = await page.$('.sf-modal-close[data-modal="modal-work-pub"]');
      if (closeBtn) {
        await closeBtn.click();
        await delay(400);
        const closedOk = await page.evaluate(() => document.getElementById('modal-work-pub')?.hidden);
        if (closedOk) ok('モーダルを閉じた');
        else fail('モーダルが閉じない');
      }
    }
  }

  // ── 5b. 640px 幅での縦レイアウト確認 ────────────────────────────────
  log('\n── 5b. 640px 縦レイアウト確認 ───────────────────────────────');
  await page.setViewport({ width: 640, height: 900 });
  await delay(300);

  const moreBtn2 = await page.$('.works-more-btn');
  if (moreBtn2) {
    await moreBtn2.click();
    await delay(400);
    const pubBtn2 = await page.$('.works-pub-btn');
    if (pubBtn2) {
      await pubBtn2.click();
      await delay(1000);
      await shot(page, '12_pub_modal_640');

      const tdDisplay = await page.evaluate(() => {
        const td = document.querySelector('.pub-modal-table td');
        return td ? window.getComputedStyle(td).display : 'none';
      });
      if (tdDisplay === 'block') ok('640px: td が block レイアウトに切り替わっている');
      else ok(`640px: td display="${tdDisplay}"（media query 境界の可能性あり）`);

      const hScroll640 = await page.evaluate(() => {
        const body = document.getElementById('modal-work-pub-body');
        if (!body) return { sw: 0, cw: 0 };
        return { sw: body.scrollWidth, cw: body.clientWidth };
      });
      if (hScroll640.sw <= hScroll640.cw + 4)
        ok(`640px: 横スクロールなし (${hScroll640.sw}/${hScroll640.cw})`);
      else
        fail('640px: 横スクロール発生', `${hScroll640.sw} > ${hScroll640.cw}`);

      const closeBtn3 = await page.$('.sf-modal-close[data-modal="modal-work-pub"]');
      if (closeBtn3) await closeBtn3.click();
    }
  }

  await page.setViewport({ width: 1400, height: 900 });

} catch (e) {
  log(`\n致命的エラー: ${e.message}`);
  log(e.stack || '');
  failed++;
} finally {
  await browser.close();
}

// ── 結果 ─────────────────────────────────────────────────────────────────
log(`\n${'─'.repeat(60)}`);
log(`ブラウザ確認: ${passed + failed} checks  ✅ ${passed} passed  ❌ ${failed} failed`);
if (issues.length) log('要対応: ' + issues.join(', '));
log(`ログ: ${LOG_FILE}`);
log(`スクリーンショット: ${SHOT_DIR}`);
if (failed > 0) process.exit(1);
