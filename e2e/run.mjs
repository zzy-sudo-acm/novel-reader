// 端到端测试：vite preview + 本机 Edge（headless）
// 用法: node e2e/run.mjs
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const BOOK_PATH = path.resolve(ROOT, '../output/qiufeng-smoke/book.json');
const BASE = 'http://localhost:4173/novel-reader/';
const PORT = 4173;

const book = JSON.parse(fs.readFileSync(BOOK_PATH, 'utf8'));
const TITLES = book.chapters.map((c) => c.title);
console.log(`测试书籍: ${book.title}, ${book.chapters.length} 章`);

const results = [];
let failed = 0;
function check(name, ok, extra = '') {
  results.push({ name, ok });
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? '  — ' + extra : ''}`);
}

async function waitForServer(url, timeout = 30000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 400));
  }
  throw new Error('preview server 启动超时');
}

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const server = spawn(npx, ['vite', 'preview', '--port', String(PORT), '--strictPort'], {
  cwd: ROOT,
  stdio: 'ignore',
  shell: process.platform === 'win32',
});

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 读取阅读器保存的进度（localStorage 镜像） */
async function readProg(page) {
  return page.evaluate(() => {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith('nr:prog:')) return JSON.parse(localStorage.getItem(k));
    }
    return null;
  });
}

/** 当前参考线（视口 33%）处的段落定位 */
async function paraAtRef(page) {
  return page.evaluate(() => {
    const s = document.querySelector('.scroller');
    const refY = s.scrollTop + s.clientHeight * 0.33;
    const secs = [...document.querySelectorAll('section[data-idx]')];
    let cur = secs[0];
    for (const sec of secs) {
      if (sec.offsetTop <= refY) cur = sec;
      else break;
    }
    if (!cur) return null;
    const paras = cur.querySelector('.paras').children;
    let p = 0;
    for (let k = 0; k < paras.length; k++) {
      if (paras[k].offsetTop <= refY) p = k;
      else break;
    }
    return { chapter: Number(cur.dataset.idx), para: p };
  });
}

async function scrollTo(page, y) {
  await page.evaluate((v) => {
    document.querySelector('.scroller').scrollTop = v;
  }, y);
}

async function currentScroll(page) {
  return page.evaluate(() => {
    const s = document.querySelector('.scroller');
    return { top: s.scrollTop, height: s.scrollHeight, view: s.clientHeight };
  });
}

async function setRange(page, selector, index, value) {
  await page.locator(selector).nth(index).evaluate((el, v) => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(el, String(v));
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }, value);
}

/** 确保控制栏可见（初始自动显示 4 秒后会隐藏，不可见时点屏幕中央） */
async function toggleBars(page) {
  for (let i = 0; i < 3; i++) {
    if (await page.locator('.bottom-bar').isVisible()) return;
    await page.mouse.click(195, 400);
    await sleep(200);
  }
  if (!(await page.locator('.bottom-bar').isVisible())) throw new Error('控制栏无法显示');
}

try {
  await waitForServer(BASE);
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 },
    hasTouch: true,
    isMobile: true,
  });
  const page = await ctx.newPage();
  page.on('dialog', (d) => void d.accept());
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));

  // ---------- 1. 打开 & 导入 ----------
  await page.goto(BASE, { waitUntil: 'load' });
  check('页面打开（书架）', await page.locator('.shelf').isVisible());

  await page.setInputFiles('input[type=file]', BOOK_PATH);
  await page.waitForSelector('.book-item', { timeout: 240000 });
  const title = await page.locator('.book-title').first().innerText();
  check('导入 13MB book.json 并出现在书架', title === book.title, title);
  const meta = await page.locator('.book-meta').first().innerText();
  check('书架显示章节数', meta.includes(String(book.chapters.length)), meta);

  // ---------- 2. 进入阅读 ----------
  await page.locator('.book-main').first().click();
  await page.waitForSelector('.reader section[data-idx]', { timeout: 20000 });
  check('进入阅读器', true);

  // ---------- 3. 目录跳转到第 500 章（索引 500） ----------
  await toggleBars(page);
  await page.locator('.bottom-bar .bar-btn', { hasText: '目录' }).click();
  await page.waitForSelector('.toc-search');
  await page.fill('.toc-search', TITLES[500]);
  await page.locator('.toc-row').first().click();
  await page.waitForSelector('section[data-idx="500"]', { timeout: 10000 });
  await sleep(600);
  let prog = await readProg(page);
  check('目录跳转到第 500 章', prog && prog.chapterIndex === 500, JSON.stringify(prog));

  // ---------- 4. 滚动到第 500 章中部 ----------
  await page.evaluate(() => {
    const sec = document.querySelector('section[data-idx="500"]');
    document.querySelector('.scroller').scrollTop = sec.offsetTop + sec.offsetHeight / 2;
  });
  await sleep(800);
  prog = await readProg(page);
  const mid500 = prog;
  check(
    '滚动到 500 章中部并保存进度',
    prog && prog.chapterIndex === 500 && prog.paragraphIndex > 5,
    JSON.stringify(prog),
  );

  // ---------- 5. 刷新后恢复进度 ----------
  await page.reload({ waitUntil: 'load' });
  await page.locator('.book-main').first().click();
  await page.waitForSelector('.reader section[data-idx]', { timeout: 20000 });
  await sleep(1000);
  const prog2 = await readProg(page);
  const restored =
    prog2 &&
    prog2.chapterIndex === mid500.chapterIndex &&
    Math.abs(prog2.paragraphIndex - mid500.paragraphIndex) <= 3;
  check('刷新后恢复到原段落附近', !!restored, `保存=${JSON.stringify(mid500)} 恢复=${JSON.stringify(prog2)}`);

  // ---------- 6. 向下滚入第 501 章 ----------
  const before = await currentScroll(page);
  await page.evaluate(() => {
    const sec = document.querySelector('section[data-idx="500"]');
    document.querySelector('.scroller').scrollTop = sec.offsetTop + sec.offsetHeight + 300;
  });
  await sleep(800);
  prog = await readProg(page);
  const has501 = await page.locator('section[data-idx="501"]').count();
  check('向下滚动自然进入 501 章', has501 > 0 && prog.chapterIndex === 501, JSON.stringify(prog));

  // ---------- 7. 向上回到 500 章 ----------
  await page.evaluate(() => {
    const sec = document.querySelector('section[data-idx="500"]');
    document.querySelector('.scroller').scrollTop = sec.offsetTop + 200;
  });
  await sleep(800);
  prog = await readProg(page);
  check('向上滚动回到 500 章', prog.chapterIndex === 500, JSON.stringify(prog));

  // ---------- 8. 修改字号后位置保持 ----------
  const anchor = await paraAtRef(page);
  await toggleBars(page);
  await page.locator('.bottom-bar .bar-btn', { hasText: '设置' }).click();
  await page.waitForSelector('.settings-sheet');
  await setRange(page, '.settings-sheet input[type=range]', 0, 24);
  await sleep(700);
  let rect = await page.evaluate(({ ch, p }) => {
    const sec = document.querySelector(`section[data-idx="${ch}"]`);
    if (!sec) return null;
    const el = sec.querySelector('.paras').children[p];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, view: window.innerHeight };
  }, { ch: anchor.chapter, p: anchor.para });
  check(
    '修改字号后当前段落仍在视口内',
    !!rect && rect.top < rect.view * 0.6 && rect.bottom > -50,
    rect ? `top=${rect.top.toFixed(0)} view=${rect.view}` : 'anchor missing',
  );

  // ---------- 9. 修改行距后位置保持 ----------
  const anchor2 = await paraAtRef(page);
  await setRange(page, '.settings-sheet input[type=range]', 1, 2.2);
  await sleep(700);
  rect = await page.evaluate(({ ch, p }) => {
    const sec = document.querySelector(`section[data-idx="${ch}"]`);
    if (!sec) return null;
    const el = sec.querySelector('.paras').children[p];
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: r.top, bottom: r.bottom, view: window.innerHeight };
  }, { ch: anchor2.chapter, p: anchor2.para });
  check(
    '修改行距后当前段落仍在视口内',
    !!rect && rect.top < rect.view * 0.6 && rect.bottom > -50,
    rect ? `top=${rect.top.toFixed(0)} view=${rect.view}` : 'anchor missing',
  );
  // 关闭设置
  await page.locator('.settings-sheet .bar-btn', { hasText: '完成' }).click();
  await sleep(300);

  // ---------- 10. 目录跳到第 1000 章 ----------
  await toggleBars(page);
  await page.locator('.bottom-bar .bar-btn', { hasText: '目录' }).click();
  await page.waitForSelector('.toc-search');
  await page.fill('.toc-search', TITLES[1000]);
  await page.locator('.toc-row').first().click();
  await page.waitForSelector('section[data-idx="1000"]', { timeout: 10000 });
  await sleep(600);
  prog = await readProg(page);
  check('目录跳转到第 1000 章', prog.chapterIndex === 1000, JSON.stringify(prog));

  // ---------- 11. 连续快速滚动多个章节 ----------
  for (let i = 0; i < 60; i++) {
    await page.evaluate(() => {
      const s = document.querySelector('.scroller');
      s.scrollTop += 3000;
    });
    await sleep(50);
  }
  await sleep(1200);
  const win = await page.evaluate(() => ({
    sections: document.querySelectorAll('section[data-idx]').length,
    paras: document.querySelectorAll('.paras p').length,
  }));
  prog = await readProg(page);
  check('连续滚动后进入更后章节', prog.chapterIndex > 1000, `current=${prog.chapterIndex}`);
  check('窗口化：渲染章节数受限', win.sections > 0 && win.sections <= 9, `sections=${win.sections} paras=${win.paras}`);

  // ---------- 12. 快速上滚多个章节（prepend 不跳动） ----------
  for (let i = 0; i < 30; i++) {
    await page.evaluate(() => {
      const s = document.querySelector('.scroller');
      s.scrollTop -= 3000;
    });
    await sleep(50);
  }
  await sleep(1200);
  prog = await readProg(page);
  const win2 = await page.evaluate(() => document.querySelectorAll('section[data-idx]').length);
  check('快速上滚后章节回退且窗口受限', prog.chapterIndex < 1010 && win2 <= 9, `current=${prog.chapterIndex} sections=${win2}`);

  // ---------- 13. 模拟切后台 / pagehide 后进度不丢 ----------
  await page.evaluate(() => {
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('pagehide'));
  });
  const progBeforeHide = await readProg(page);
  await page.reload({ waitUntil: 'load' });
  await page.locator('.book-main').first().click();
  await page.waitForSelector('.reader section[data-idx]', { timeout: 20000 });
  await sleep(800);
  const progAfterHide = await readProg(page);
  check(
    'pagehide/刷新后进度恢复',
    progAfterHide &&
      progAfterHide.chapterIndex === progBeforeHide.chapterIndex &&
      Math.abs(progAfterHide.paragraphIndex - progBeforeHide.paragraphIndex) <= 3,
    `before=${JSON.stringify(progBeforeHide)} after=${JSON.stringify(progAfterHide)}`,
  );

  // ---------- 14. Service Worker & 离线 ----------
  await page.goto(BASE, { waitUntil: 'load' });
  const swOk = await page
    .evaluate(async () => {
      const reg = await Promise.race([
        navigator.serviceWorker.ready,
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 15000)),
      ]);
      return !!reg;
    })
    .catch(() => false);
  check('Service Worker 注册成功', swOk);

  await ctx.setOffline(true);
  await page.reload({ waitUntil: 'load' }).catch(() => {});
  const offlineOk = await page
    .waitForSelector('.shelf, .reader', { timeout: 15000 })
    .then(() => true)
    .catch(() => false);
  check('断网后应用仍可打开（SW 缓存）', offlineOk);
  if (offlineOk) {
    await page.locator('.book-main').first().click();
    const offlineRead = await page
      .waitForSelector('.reader section[data-idx] .paras p', { timeout: 15000 })
      .then(() => true)
      .catch(() => false);
    check('断网后已导入小说可阅读', offlineRead);
  }
  await ctx.setOffline(false);

  // ---------- 15. 删除书籍并清理 IndexedDB ----------
  await page.goto(BASE, { waitUntil: 'load' });
  await page.waitForSelector('.book-item', { timeout: 20000 });
  await page.locator('.book-del').first().click(); // confirm 对话框已自动接受
  await sleep(1500);
  const left = await page.locator('.book-item').count();
  check('删除书籍后书架为空', left === 0);
  const chapterCount = await page.evaluate(
    () =>
      new Promise((resolve) => {
        const req = indexedDB.open('novel-reader');
        req.onsuccess = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains('chapters')) return resolve(-1);
          const tx = db.transaction('chapters', 'readonly');
          const c = tx.objectStore('chapters').count();
          c.onsuccess = () => resolve(c.result);
          c.onerror = () => resolve(-2);
        };
        req.onerror = () => resolve(-3);
      }),
  );
  check('删除后 IndexedDB 章节数据被清理', chapterCount === 0, `chapters=${chapterCount}`);

  // ---------- 汇总 ----------
  if (pageErrors.length > 0) {
    check('页面无 JS 运行时错误', false, pageErrors.slice(0, 3).join(' | '));
  } else {
    check('页面无 JS 运行时错误', true);
  }

  console.log(`\n===== ${results.length - failed}/${results.length} 通过 =====`);
  await browser.close();
  server.kill();
  process.exit(failed > 0 ? 1 : 0);
} catch (e) {
  console.error('E2E 运行异常:', e);
  server.kill();
  process.exit(2);
}
