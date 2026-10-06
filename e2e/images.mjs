import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '4183', '--strictPort'], { windowsHide: true, stdio: 'pipe' });
let browser;
try {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch('http://127.0.0.1:4183/novel-reader/')).ok) break; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:4183/novel-reader/');
  const result = await page.evaluate(async () => {
    const { importBookFile } = await import('/novel-reader/src/importer.ts');
    const { getChapter, getAllBooks } = await import('/novel-reader/src/db.ts');
    const canvas = document.createElement('canvas'); canvas.width = 300; canvas.height = 150;
    canvas.getContext('2d').fillRect(0, 0, 300, 150);
    const raw = { title: '插图测试', source: 'image-test', chapters: [{ title: '第一章', content: '第一段\n第二段', images: [{ afterParagraph: 0, alt: '示意图', dataUrl: canvas.toDataURL() }] }] };
    const file = value => new File([JSON.stringify(value)], 'book.json');
    const book = await importBookFile(file(raw), () => {});
    const saved = await getChapter(book.id, 0);
    let rejected = 0;
    for (const image of [{ ...raw.chapters[0].images[0], dataUrl: 'https://example.com/a.png' }, { ...raw.chapters[0].images[0], afterParagraph: 2 }, { ...raw.chapters[0].images[0], dataUrl: 'data:image/png;base64,AAAA' }]) {
      try { await importBookFile(file({ ...raw, chapters: [{ ...raw.chapters[0], images: [image] }] }), () => {}); } catch { rejected++; }
    }
    const preserved = await getChapter(book.id, 0);
    await importBookFile(file({ title: '旧书', chapters: [{ title: '正文', content: '纯文字' }] }), () => {});
    return { width: saved.images[0].width, height: saved.images[0].height, rejected, preserved: preserved.images[0].dataUrl === saved.images[0].dataUrl, count: (await getAllBooks()).length };
  });
  assert.deepEqual(result, { width: 300, height: 150, rejected: 3, preserved: true, count: 2 });
  await page.reload();
  await page.locator('.book-title', { hasText: '插图测试' }).click();
  await page.locator('.book-illustration img').waitFor();
  await context.setOffline(true);
  const display = await page.locator('.book-illustration img').evaluate(async img => { await img.decode(); return { valid: img.naturalWidth === 300, fit: img.getBoundingClientRect().width <= 390 }; });
  assert.deepEqual(display, { valid: true, fit: true });
  assert.equal(await page.locator('.paras > p').count(), 2);
  console.log('PASS embedded persistence, invalid import atomicity, legacy books, reload, offline decoding, mobile layout, paragraph indices');
} finally { await browser?.close(); server.kill(); }
