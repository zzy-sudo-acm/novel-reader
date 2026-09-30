// 新功能使用独立浏览器上下文及合成正文，验证旧数据升级、真实交互与离线 Worker。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const base = 'http://127.0.0.1:4180/novel-reader/';
const productionBase = 'http://127.0.0.1:4181/novel-reader/';
const vite = path.join(root, 'node_modules/vite/bin/vite.js');
const servers = [];
let browser;
let checks = 0;
const errors = [];
function check(name, value, details) {
  assert.ok(value, `${name}: ${JSON.stringify(details)}`);
  checks++;
  console.log(`PASS ${name}`);
}
async function startServer(port, preview = false) {
  const child = spawn(process.execPath, [vite, ...(preview ? ['preview'] : []), '--host', '127.0.0.1', '--port', String(port), '--strictPort'], { cwd: root, windowsHide: true, stdio: 'pipe' });
  servers.push(child);
  let output = '';
  child.stderr.on('data', value => { output += value; });
  for (let i = 0; i < 80; i++) {
    if (child.exitCode != null) throw new Error(`预览启动失败：${output}`);
    try { if ((await fetch(`http://127.0.0.1:${port}/novel-reader/`)).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error(`预览启动超时：${output}`);
}
const fixture = (title, source = title) => ({ title, source, chapters: Array.from({ length: 8 }, (_, chapter) => ({
  title: `第${chapter + 1}章 远行`,
  content: Array.from({ length: 12 }, (_, paragraph) => {
    const token = chapter === 5 && paragraph === 6 ? '星河钥匙' : chapter === 3 && paragraph === 4 ? 'A+B?' : '';
    return `第${chapter + 1}章第${paragraph + 1}段。${'山间的风吹过长廊，旅人循着熟悉的脚步继续前行。'.repeat(5)}${token}故事还在继续。`;
  }).join('\n\n'),
})) });
async function upload(page, book) {
  await page.setInputFiles('input[type=file]', { name: 'fixture.json', mimeType: 'application/json', buffer: Buffer.from(JSON.stringify(book)) });
  await page.getByRole('button', { name: '导入小说', exact: true }).waitFor({ state: 'visible' });
  await page.waitForFunction(title => [...document.querySelectorAll('.book-title')].some(el => el.textContent === title), book.title);
}
async function showBars(page) {
  if (!await page.locator('.bottom-bar').isVisible()) await page.locator('.reader-menu-access').evaluate(el => el.click());
}
async function openPanel(page, name) {
  await showBars(page);
  await page.getByRole('button', { name, exact: true }).click();
}
async function anchor(page) {
  return page.evaluate(() => {
    const line = innerHeight * .33;
    const sections = [...document.querySelectorAll('section[data-idx]')];
    const section = sections.filter(el => el.getBoundingClientRect().top <= line).at(-1) ?? sections[0];
    const paragraphs = [...section.querySelectorAll('.paras p')];
    const paragraph = paragraphs.filter(el => el.getBoundingClientRect().top <= line).at(-1) ?? paragraphs[0];
    return { chapter: +section.dataset.idx, paragraph: paragraphs.indexOf(paragraph), top: paragraph.getBoundingClientRect().top };
  });
}
async function newPage(options = {}) {
  const context = await browser.newContext(options);
  context.on('page', page => page.on('pageerror', error => errors.push(String(error))));
  return context.newPage();
}

try {
  fs.mkdirSync(path.join(root, 'e2e/results'), { recursive: true });
  fs.writeFileSync(path.join(root, 'e2e/results/reading-tools-fixture.json'), JSON.stringify(fixture('星河漫游')));
  await startServer(4180);
  browser = await chromium.launch({ channel: 'msedge', headless: true });

  // 版本 1 数据库先有一本旧书；应用升级后书籍、正文与进度不能丢失。
  const legacy = await newPage();
  await legacy.route('**/legacy-fixture', route => route.fulfill({ contentType: 'text/html', body: '<html><body>fixture</body></html>' }));
  await legacy.goto(`${base}legacy-fixture`);
  await legacy.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('novel-reader', 1);
    request.onupgradeneeded = () => {
      request.result.createObjectStore('books', { keyPath: 'id' });
      request.result.createObjectStore('chapters', { keyPath: ['bookId', 'index'] }).createIndex('byBook', 'bookId');
    };
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const tx = db.transaction(['books', 'chapters'], 'readwrite');
      tx.objectStore('books').put({ id: 'legacy', title: '旧书兼容', chapterCount: 1, toc: [{ t: '旧章节', p: 2, c: 10 }], totalChars: 10, addedAt: 1, progress: { chapterIndex: 0, paragraphIndex: 1, paragraphProgress: .5 }, progressUpdatedAt: 1 });
      tx.objectStore('chapters').put({ bookId: 'legacy', index: 0, title: '旧章节', content: '原来第一段\n\n原来第二段' });
      tx.oncomplete = () => { db.close(); resolve(); };
      tx.onabort = () => reject(tx.error);
    };
  }));
  await legacy.goto(base);
  await legacy.locator('.book-main').waitFor();
  const migrated = await legacy.evaluate(async () => {
    const db = await import('/novel-reader/src/db.ts');
    return { book: await db.getBook('legacy'), chapter: await db.getChapter('legacy', 0), bookmarks: await db.getBookmarks('legacy') };
  });
  check('旧数据库升级后书籍、正文和进度保留', migrated.book.progress.paragraphIndex === 1 && migrated.chapter.content.includes('原来第二段') && migrated.bookmarks.length === 0, migrated);

  const page = await newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await page.goto(base);
  await upload(page, fixture('星河漫游'));
  await upload(page, fixture('山海札记'));
  await upload(page, fixture('未读集'));
  check('新书默认未读', await page.locator('.book-main').count() === 3);
  await page.getByRole('searchbox', { name: '搜索书名' }).fill('星河');
  check('书架按书名过滤', await page.locator('.book-main').count() === 1 && (await page.locator('.book-title').textContent()) === '星河漫游');
  await page.locator('.book-main').click();
  await page.locator('.paras p').first().waitFor();
  await page.evaluate(() => window.scrollTo(0, 1450));
  await page.waitForTimeout(450);
  const original = await anchor(page);
  await openPanel(page, '书签');
  await page.getByRole('button', { name: '添加当前位置', exact: true }).click();
  await page.locator('.bookmark-item').waitFor();
  check('当前位置书签保存并显示段落', await page.locator('.bookmark-item').count() === 1);
  check('同段落书签不会重复添加', await page.getByRole('button', { name: /已.*书签|已.*添加|当前位置已/ }).isDisabled());
  await page.keyboard.press('Escape');
  const afterBookmark = await anchor(page);
  check('打开、关闭书签不挪动正文', original.chapter === afterBookmark.chapter && original.paragraph === afterBookmark.paragraph && Math.abs(original.top - afterBookmark.top) < 2, { original, afterBookmark });

  await openPanel(page, '搜索');
  await page.getByRole('searchbox', { name: '搜索全文' }).fill('星河钥匙');
  await page.locator('.search-result').first().waitFor();
  check('全文搜索找到远处章节并显示上下文', (await page.locator('.search-result').first().textContent()).includes('第6章') && await page.locator('.search-result mark').count() === 1);
  await page.screenshot({ path: path.join(root, 'e2e/results/features-mobile-search.png') });
  await page.locator('.search-result').first().click();
  await page.waitForTimeout(500);
  const resultPosition = await anchor(page);
  check('搜索跳到对应章节段落并高亮', resultPosition.chapter === 5 && resultPosition.paragraph === 6 && (await page.locator('.paras mark').textContent()) === '星河钥匙', resultPosition);
  await page.getByRole('button', { name: '返回原阅读位置', exact: true }).click();
  await page.waitForTimeout(450);
  const returned = await anchor(page);
  check('搜索后返回原段落和屏幕位置', original.chapter === returned.chapter && original.paragraph === returned.paragraph && Math.abs(original.top - returned.top) < 2, { original, returned });

  await openPanel(page, '搜索');
  await page.getByRole('searchbox', { name: '搜索全文' }).fill('星河钥匙');
  await page.locator('.search-result').first().waitFor();
  await page.setViewportSize({ width: 390, height: 560 });
  await page.locator('.search-result').click();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(350);
  await page.getByRole('button', { name: '返回原阅读位置', exact: true }).click();
  await page.waitForTimeout(350);
  const afterKeyboard = await anchor(page);
  check('搜索弹层视口收缩后仍返回打开面板前的位置', original.chapter === afterKeyboard.chapter && original.paragraph === afterKeyboard.paragraph && Math.abs(original.top - afterKeyboard.top) < 2, { original, afterKeyboard });

  await openPanel(page, '搜索');
  const query = page.getByRole('searchbox', { name: '搜索全文' });
  await query.fill('a+b?');
  await page.locator('.search-result').first().waitFor();
  check('英文忽略大小写且特殊字符按字面搜索', (await page.locator('.search-result mark').textContent()) === 'A+B?');
  await query.fill('没有这个关键字');
  await page.waitForTimeout(400);
  await query.fill('风');
  await page.waitForFunction(() => document.querySelector('.search-summary')?.textContent.includes('找到 96 段正文'));
  check('快速更换关键词不会显示过期结果且支持中文单字', (await page.locator('.search-summary').textContent()).includes('找到 96 段正文'));
  await query.fill('完全不存在的内容');
  await page.waitForFunction(() => document.querySelector('.search-sheet')?.textContent.includes('没有找到'));
  check('无结果时显示清楚的提示', await page.locator('.search-result').count() === 0);
  await page.keyboard.press('Escape');

  await page.reload();
  await page.locator('.book-main').first().waitFor();
  await page.locator('.book-item').filter({ hasText: '星河漫游' }).locator('.book-main').click();
  await page.locator('.paras p').first().waitFor();
  await page.evaluate(() => window.scrollBy(0, 1500));
  await page.waitForTimeout(450);
  const beforeBookmarkJump = await anchor(page);
  await openPanel(page, '书签');
  await page.locator('.bookmark-item').waitFor();
  check('重新打开页面书签仍存在', await page.locator('.bookmark-item').count() === 1);
  await page.screenshot({ path: path.join(root, 'e2e/results/features-mobile-bookmarks.png') });
  await page.locator('.bookmark-select').click();
  await page.waitForTimeout(350);
  const bookmarkTarget = await anchor(page);
  check('书签跳回保存的段落与屏幕位置', original.chapter === bookmarkTarget.chapter && original.paragraph === bookmarkTarget.paragraph && Math.abs(original.top - bookmarkTarget.top) < 2, { original, bookmarkTarget });
  await page.getByRole('button', { name: '返回原阅读位置', exact: true }).click();
  await page.waitForTimeout(350);
  const afterBookmarkReturn = await anchor(page);
  check('书签跳转后可以返回原位置', beforeBookmarkJump.chapter === afterBookmarkReturn.chapter && beforeBookmarkJump.paragraph === afterBookmarkReturn.paragraph && Math.abs(beforeBookmarkJump.top - afterBookmarkReturn.top) < 2, { beforeBookmarkJump, afterBookmarkReturn });
  await openPanel(page, '书签');
  await page.locator('.bookmark-remove').click();
  await page.waitForFunction(() => document.querySelectorAll('.bookmark-item').length === 0);
  await page.keyboard.press('Escape');
  await openPanel(page, '书签');
  await page.getByText('还没有书签', { exact: true }).waitFor();
  check('删除书签后重新打开不会恢复', await page.locator('.bookmark-item').count() === 0);
  await page.keyboard.press('Escape');
  await showBars(page);
  await page.getByRole('button', { name: /‹ 书架/ }).click();
  await page.getByRole('button', { name: /^在读，/ }).click();
  check('打开过的书归入在读筛选', await page.locator('.book-main').count() === 1 && (await page.locator('.book-title').textContent()) === '星河漫游');
  await page.locator('.book-status').click();
  await page.getByRole('button', { name: /^已读完，/ }).click();
  await page.waitForFunction(() => document.querySelectorAll('.book-main').length === 1);
  check('手动标记已读完并筛选', (await page.locator('.book-title').textContent()) === '星河漫游');
  await page.locator('.book-status').click();
  await page.getByRole('button', { name: /^全部，/ }).click();
  await page.waitForFunction(() => document.querySelectorAll('.book-main').length === 3);
  await page.locator('.shelf-resume').waitFor({ state: 'visible' });
  check('最近阅读入口突出当前在读书', await page.locator('.shelf-resume').isVisible());
  check('默认排序优先最近阅读', (await page.locator('.book-title').first().textContent()) === '星河漫游');
  await page.getByLabel('排序', { exact: true }).selectOption('added');
  check('可以按最近导入排序', (await page.locator('.book-title').first().textContent()) === '未读集');
  await page.getByLabel('排序', { exact: true }).selectOption('title');
  const titles = await page.locator('.book-title').allTextContents();
  const sorted = [...titles].sort(new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' }).compare);
  check('可以按中文书名排序', JSON.stringify(titles) === JSON.stringify(sorted));
  await page.getByRole('button', { name: /^未读，/ }).click();
  check('未读筛选排除已开始阅读的书', await page.locator('.book-main').count() === 2);
  await page.getByRole('button', { name: /^全部，/ }).click();
  await page.getByLabel('排序', { exact: true }).selectOption('recent');
  await page.setViewportSize({ width: 320, height: 720 });
  check('窄屏书架无横向溢出', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: path.join(root, 'e2e/results/features-mobile-shelf.png') });
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: path.join(root, 'e2e/results/features-desktop-shelf.png') });
  check('书架手机与桌面无横向溢出', await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));

  const data = await page.evaluate(async () => {
    const db = await import('/novel-reader/src/db.ts');
    const { importBookFile } = await import('/novel-reader/src/importer.ts');
    const make = titles => new File([JSON.stringify({ title: '迁移测试', source: 'migration', chapters: titles.map(title => ({ title, content: '第一段\n\n第二段\n\n第三段' })) })], 'm.json');
    const book = await importBookFile(make(['第一章', '第二章']), () => {});
    const position = { chapterIndex: 1, paragraphIndex: 1, paragraphProgress: .5 };
    const first = await db.addBookmark(book.id, position, '第二段');
    const duplicate = await db.addBookmark(book.id, position, '第二段');
    await db.markBookOpened(book.id);
    await db.setBookReadingStatus(book.id, 'finished');
    const before = await db.getBook(book.id);
    await importBookFile(make(['序章', '第一章', '第二章']), () => {});
    const moved = (await db.getBookmarks(book.id))[0];
    const after = await db.getBook(book.id);
    let replaceFailed = false;
    try { await importBookFile(make(['序章', '第一章']), () => { throw new Error('模拟失败'); }); } catch { replaceFailed = true; }
    const intact = (await db.getBookmarks(book.id))[0];
    await importBookFile(make(['序章', '第一章']), () => {});
    const unavailable = (await db.getBookmarks(book.id))[0];
    await db.deleteBook(book.id);
    let rejected = false;
    try { await db.addBookmark(book.id, position, '第二段'); } catch { rejected = true; }
    return { deduplicated: first.id === duplicate.id, moved, keptActivity: before.lastReadAt === after.lastReadAt && after.readingStatus === 'finished', replaceFailed, intact, unavailable, clean: (await db.getBookmarks(book.id)).length === 0 && !(await db.getBook(book.id)), rejected };
  });
  check('同段书签在数据层去重', data.deduplicated);
  check('前插章节后书签按标题迁移', data.moved.progress.chapterIndex === 2 && data.moved.progress.paragraphIndex === 1, data);
  check('重新导入保留最近阅读与完成状态', data.keptActivity);
  check('导入失败保留原书签', data.replaceFailed && data.intact.progress.chapterIndex === 2 && !data.intact.unavailable, data);
  check('无法匹配的书签保留并明确不可跳转', data.unavailable.unavailable);
  check('删书原子清理书签且不能给已删书新增书签', data.clean && data.rejected);

  const many = await newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await many.goto(base);
  await upload(many, { title: '搜索上限', chapters: [{ title: '潮汐', content: Array.from({ length: 240 }, (_, index) => `潮汐第${index}段。海风吹来。`).join('\n\n') }] });
  await many.locator('.book-main').click();
  await many.locator('.paras p').first().waitFor();
  await openPanel(many, '搜索');
  await many.getByRole('searchbox', { name: '搜索全文' }).fill('潮汐');
  await many.waitForFunction(() => document.querySelector('.search-summary')?.textContent.includes('找到 240 段正文'));
  check('大批结果统计全书并明确显示200条上限', (await many.locator('.search-summary').textContent()).includes('显示前 200 条') && await many.locator('.search-result').count() === 40);
  while (await many.locator('.search-show-more').count()) await many.locator('.search-show-more').click();
  check('按批展示结果且界面节点数量受限', await many.locator('.search-result').count() === 200);

  // 生产构建重新断网启动后首次打开搜索，Worker 也必须能从 PWA 缓存加载。
  await startServer(4181, true);
  const offline = await newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await offline.goto(productionBase);
  await upload(offline, fixture('离线阅读'));
  await offline.evaluate(() => navigator.serviceWorker.ready);
  await offline.reload();
  await offline.waitForFunction(() => !!navigator.serviceWorker.controller);
  await offline.context().setOffline(true);
  await offline.reload();
  await offline.locator('.book-main').click();
  await offline.locator('.paras p').first().waitFor();
  await openPanel(offline, '搜索');
  await offline.getByRole('searchbox', { name: '搜索全文' }).fill('星河钥匙');
  await offline.locator('.search-result').first().waitFor();
  check('断网重新启动后首次全文搜索可用', (await offline.locator('.search-result').textContent()).includes('星河钥匙'));
  check('新功能场景无运行时错误', errors.length === 0, errors);
  console.log(`\n${checks} 项新功能检查全部通过`);
} finally {
  await browser?.close();
  servers.forEach(server => server.kill());
}
