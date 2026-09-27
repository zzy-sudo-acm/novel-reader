// 线上部署验证：直接访问 GitHub Pages
import { chromium } from 'playwright-core';
import path from 'node:path';

const BASE = 'https://zzy-sudo-acm.github.io/novel-reader/';
const BOOK_PATH = path.resolve(import.meta.dirname, '../../output/qiufeng-smoke/book.json');

const browser = await chromium.launch({ channel: 'msedge', headless: true });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
const page = await ctx.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));

await page.goto(BASE, { waitUntil: 'load' });
console.log('页面打开:', await page.title());

const swOk = await page
  .evaluate(async () => {
    await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((_, rej) => setTimeout(() => rej(new Error('sw timeout')), 20000)),
    ]);
    const reg = await navigator.serviceWorker.getRegistration();
    return !!reg && reg.scope.includes('/novel-reader/');
  })
  .catch((e) => String(e));
console.log('Service Worker:', swOk === true ? 'OK' : swOk);

await page.setInputFiles('input[type=file]', BOOK_PATH);
await page.waitForSelector('.book-item', { timeout: 240000 });
console.log('导入书籍:', await page.locator('.book-title').first().innerText());

await page.locator('.book-main').first().click();
await page.waitForSelector('.reader section[data-idx]', { timeout: 20000 });
const text = await page.locator('.reader section .paras p').first().innerText();
console.log('阅读页正文开头:', text.slice(0, 30));

await page.evaluate(() => {
  document.querySelector('.scroller').scrollTop += 5000;
});
await new Promise((r) => setTimeout(r, 800));
const sections = await page.evaluate(() => document.querySelectorAll('section[data-idx]').length);
console.log('滚动后渲染章节数:', sections);

await page.reload({ waitUntil: 'load' });
await page.waitForSelector('.book-item', { timeout: 20000 });
console.log('刷新后书籍仍在书架: OK');

console.log('JS 错误:', errors.length ? errors.join(' | ') : '无');
await browser.close();
process.exit(errors.length ? 1 : 0);
