import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';
const root = path.resolve(import.meta.dirname, '..');
const realMdPath = path.resolve(root, '../宗教史闲聊_从亚伯拉罕开始.md');
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', '4184', '--strictPort'], { windowsHide: true, stdio: 'pipe' });
let browser;
async function openSearch(page) {
  if (!await page.locator('.bottom-bar').isVisible()) await page.locator('.reader-menu-access').evaluate(el => el.click());
  await page.getByRole('button', { name: '搜索', exact: true }).click();
}
try {
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch('http://127.0.0.1:4184/novel-reader/')).ok) break; } catch {}
    await new Promise(r => setTimeout(r, 100));
  }
  browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await page.goto('http://127.0.0.1:4184/novel-reader/');
  const realMd = fs.existsSync(realMdPath) ? fs.readFileSync(realMdPath, 'utf8') : null;
  const imported = await page.evaluate(async (realMdText) => {
    const { importBookFile } = await import('/novel-reader/src/importer.ts');
    const { getBook, getChapter } = await import('/novel-reader/src/db.ts');
    const file = (value, name = 'book.json') => new File([typeof value === 'string' ? value : JSON.stringify(value)], name);
    const raw = {
      title: 'Markdown 测试', source: 'markdown-test', format: 'markdown',
      chapters: [{ title: '第一章', content: '# 大标题\n\n正文**粗体**和:smile:表情\n\n> 引用文字\n\n普通*斜体*~~删除线~~`代码`[链接](https://example.com)' }],
    };
    const book = await importBookFile(file(raw), () => {});
    const saved = await getBook(book.id);
    let rejected = 0;
    for (const format of ['html', 'Markdown', 1]) {
      try { await importBookFile(file({ ...raw, title: `非法${String(format)}`, format }), () => {}); } catch { rejected++; }
    }
    // 块结构：代码块内部换行属于同一段，--- 自成一段
    const blocks = await importBookFile(file({
      title: 'Markdown 块测试', source: 'markdown-block', format: 'markdown',
      chapters: [{ title: '第一章', content: '前文第一段\n\n```\n亚伯拉罕\n├── 以实玛利\n└── 以撒\n```\n\n---\n\n代码块之后的段落' }],
    }), () => {});
    const blocksMeta = await getBook(blocks.id);
    const blocksChapter = await getChapter(blocks.id, 0);
    // .md 直接导入
    const md1 = await importBookFile(file('# 书名为H1\n\n前言内容一句。\n\n## 第一章 开始\n\n正文一。\n\n## 第二章 继续\n\n正文二。', 'test.md'), () => {});
    const single = await importBookFile(file('# 只有一章\n\n正文。', 'single.md'), () => {});
    const noH1 = await importBookFile(file('## 第一节\n\n内容。', 'no-h1.md'), () => {});
    await importBookFile(file({ title: '纯文字书', chapters: [{ title: '正文', content: '**粗体**原样显示' }] }), () => {});
    let real = null;
    if (realMdText) {
      const b = await importBookFile(file(realMdText, '宗教史闲聊_从亚伯拉罕开始.md'), () => {});
      real = { id: b.id, title: b.title, chapterCount: b.chapterCount, first: b.toc[0].t, last: b.toc[b.toc.length - 1].t, format: b.format };
    }
    return {
      format: saved.format, rejected,
      blocks: { format: blocksMeta.format, paragraphs: blocksMeta.toc[0].p, chapterFormat: blocksChapter.format },
      md1: { title: md1.title, count: md1.chapterCount, toc: md1.toc.map(t => t.t), format: md1.format },
      single: { title: single.title, count: single.chapterCount, toc: single.toc.map(t => t.t) },
      noH1: { title: noH1.title, count: noH1.chapterCount, toc: noH1.toc.map(t => t.t) },
      real,
    };
  }, realMd);
  assert.deepEqual(imported.format, 'markdown');
  assert.equal(imported.rejected, 3);
  // markdown 书按空行分段：代码块是一段，format 已盖章到章节记录
  assert.deepEqual(imported.blocks, { format: 'markdown', paragraphs: 4, chapterFormat: 'markdown' });
  assert.deepEqual(imported.md1, { title: '书名为H1', count: 3, toc: ['前言', '第一章 开始', '第二章 继续'], format: 'markdown' });
  assert.deepEqual(imported.single, { title: '只有一章', count: 1, toc: ['只有一章'] });
  assert.deepEqual(imported.noH1, { title: 'no-h1', count: 1, toc: ['第一节'] });
  if (realMd) assert.deepEqual(imported.real, { id: imported.real.id, title: '从亚伯拉罕开始的三千年', chapterCount: 10, first: '前言', last: '尾声', format: 'markdown' });
  else console.log('SKIP 真实 .md 文件不存在，跳过冒烟（../宗教史闲聊_从亚伯拉罕开始.md）');

  await page.reload();
  await page.locator('.book-title', { hasText: 'Markdown 测试' }).click();
  await page.locator('.paras p .md-h1').waitFor();
  const ps = page.locator('.paras > p');
  assert.equal(await ps.count(), 4);
  assert.deepEqual(await ps.evaluateAll(els => els.map(el => el.dataset.paragraph)), ['0', '1', '2', '3']);
  assert.equal(await ps.nth(0).locator('.md-h1').textContent(), '大标题');
  assert.equal(await ps.nth(1).locator('strong').textContent(), '粗体');
  assert.ok((await ps.nth(1).textContent()).includes('😄'));
  assert.equal((await ps.nth(2).locator('.md-quote').textContent()).trim(), '引用文字');
  assert.equal(await ps.nth(3).locator('em').textContent(), '斜体');
  assert.equal(await ps.nth(3).locator('del').textContent(), '删除线');
  assert.equal(await ps.nth(3).locator('code').textContent(), '代码');
  const link = ps.nth(3).locator('a');
  assert.deepEqual([await link.getAttribute('href'), await link.getAttribute('target'), await link.getAttribute('rel')], ['https://example.com', '_blank', 'noreferrer']);

  // 代码块 / 分隔线渲染，以及搜索跳转的段落索引与阅读页一致
  await page.goto('http://127.0.0.1:4184/novel-reader/');
  await page.locator('.book-title', { hasText: 'Markdown 块测试' }).click();
  await page.locator('.paras p .md-pre').waitFor();
  const bps = page.locator('.paras > p');
  assert.equal(await bps.count(), 4);
  assert.deepEqual(await bps.evaluateAll(els => els.map(el => el.dataset.paragraph)), ['0', '1', '2', '3']);
  const preText = await bps.nth(1).locator('.md-pre').textContent();
  assert.ok(preText.includes('亚伯拉罕\n├── 以实玛利\n└── 以撒'), preText);
  assert.equal(await bps.nth(1).locator('code').count(), 1);
  assert.equal(await bps.nth(2).locator('.md-hr').count(), 1);
  await openSearch(page);
  await page.getByRole('searchbox', { name: '搜索全文' }).fill('代码块之后');
  await page.locator('.search-result').first().waitFor();
  await page.locator('.search-result').first().click();
  await page.locator('.paras mark').waitFor();
  const hit = await page.locator('.paras mark').evaluate(el => ({ paragraph: el.closest('p').dataset.paragraph, text: el.textContent }));
  assert.deepEqual(hit, { paragraph: '3', text: '代码块之后' });

  // 纯文字 .json 书的渲染与分段行为完全不变
  await page.goto('http://127.0.0.1:4184/novel-reader/');
  await page.locator('.book-title', { hasText: '纯文字书' }).click();
  await page.locator('.paras p').waitFor();
  assert.equal(await page.locator('.paras strong').count(), 0);
  assert.equal((await page.locator('.paras > p').textContent()).trim(), '**粗体**原样显示');

  // 真实 .md 冒烟：前言 + 9 部分共 10 章；第八部分含代码块，尾声（最后一章）能打开
  if (realMd) {
    await page.goto('http://127.0.0.1:4184/novel-reader/');
    await page.locator('.book-title', { hasText: '从亚伯拉罕开始的三千年' }).click();
    await page.locator('.paras p').first().waitFor();
    if (!await page.locator('.bottom-bar').isVisible()) await page.locator('.reader-menu-access').evaluate(el => el.click());
    await page.getByRole('button', { name: '目录', exact: true }).click();
    await page.locator('.toc-row', { hasText: '第八部分' }).click();
    await page.locator('.paras p .md-pre').first().waitFor();
    const preTexts = await page.locator('.paras p .md-pre').allTextContents();
    assert.ok(preTexts.length >= 3, String(preTexts.length));
    assert.ok(preTexts.every(t => t.includes('\n')), preTexts.map(t => t.slice(0, 60)).join(' | '));
    assert.ok(preTexts.some(t => t.includes('罗马人把耶稣钉死\n→')), preTexts.map(t => t.slice(0, 60)).join(' | '));
    await page.getByRole('button', { name: '目录', exact: true }).click();
    await page.locator('.toc-row', { hasText: '尾声' }).click();
    await page.waitForFunction(() => [...document.querySelectorAll('.ch-title')].some(el => el.textContent === '尾声'));
    assert.ok(await page.locator('.paras > p').count() > 0);
  }
  console.log('PASS markdown format validation, blank-line paragraphs, fenced code/hr rendering, md import (H1/H2/前言), search highlight indices, plain-text books unchanged' + (realMd ? ', real .md smoke' : ''));
} finally { await browser?.close(); server.kill(); }
