import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
const BOOK_PATH = path.resolve(ROOT, '../output/qiufeng-smoke/book.json');
const BASE = 'http://localhost:4173/novel-reader/';

const server = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx', ['vite', 'preview', '--port', '4173', '--strictPort'], { cwd: ROOT, stdio: 'ignore', shell: process.platform === 'win32' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  for (let i = 0; i < 50; i++) { try { const r = await fetch(BASE); if (r.ok) break; } catch {} await sleep(400); }
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  page.on('pageerror', (e) => console.log('PAGEERROR:', String(e)));
  page.on('console', (m) => { if (m.type() === 'error') console.log('CONSOLE:', m.text()); });

  await page.goto(BASE, { waitUntil: 'load' });
  await page.setInputFiles('input[type=file]', BOOK_PATH);
  await page.waitForSelector('.book-item', { timeout: 240000 });
  await page.locator('.book-main').first().click();
  await page.waitForSelector('.reader section[data-idx]', { timeout: 20000 });

  const state = async (tag) => console.log(tag, await page.evaluate(() => ({
    bars: !!document.querySelector('.bottom-bar'),
    settings: !!document.querySelector('.settings-sheet'),
    hint: !!document.querySelector('.tap-hint'),
  })));

  await state('刚进入:');
  await sleep(4500);
  await state('4.5秒后:');
  await page.mouse.click(195, 400);
  await sleep(300);
  await state('点击中央后:');
  await page.locator('.bottom-bar .bar-btn', { hasText: '设置' }).click();
  await sleep(300);
  await state('打开设置后:');
  await page.locator('.settings-sheet .bar-btn', { hasText: '完成' }).click();
  await sleep(300);
  await state('点完成后:');
  await browser.close();
} finally {
  server.kill();
}
