// 独立临时浏览器数据库；不依赖或上传真实小说。
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chromium } from 'playwright-core';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const base = 'http://127.0.0.1:4176/novel-reader/';
const server = spawn(process.execPath, [path.join(root, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', '4176', '--strictPort'], {cwd:root, windowsHide:true, stdio:'pipe'});
const sleep = ms => new Promise(r => setTimeout(r, ms));
let browser;
let checks = 0;
function check(name, test, detail) { assert.ok(test, `${name}: ${JSON.stringify(detail)}`); checks++; console.log(`PASS ${name}`); }
const fixture = (title, count, paragraphs = 45) => ({title, chapters:Array.from({length:count},(_,i)=>({title:`章节 ${String(i).padStart(3,'0')}`,content:Array.from({length:paragraphs},(_,p)=>`第${i}章第${p}段。${'这是一段验证阅读位置的合成文字。'.repeat(3 + (p % 4))}`).join('\n\n')}))});
async function upload(page, book) {
  await page.setInputFiles('input[type=file]',{name:'fixture.json',mimeType:'application/json',buffer:Buffer.from(JSON.stringify(book))});
  await page.waitForSelector('.book-main');
}
async function anchor(page) {
  return page.evaluate(() => {
    const ref = innerHeight * .33;
    const secs = [...document.querySelectorAll('section[data-idx]')];
    const sec = secs.filter(s=>s.getBoundingClientRect().top<=ref).at(-1) || secs[0];
    const ps = [...sec.querySelectorAll('p')];
    let para = 0;
    for (let i=0;i<ps.length;i++) if(ps[i].getBoundingClientRect().top<=ref) para=i;
    const p = ps[para];
    const h = para+1 < ps.length ? ps[para+1].getBoundingClientRect().top-p.getBoundingClientRect().top : p.offsetHeight;
    return {chapter:+sec.dataset.idx,para,top:p.getBoundingClientRect().top,ratio:Math.max(0,Math.min(1,(ref-p.getBoundingClientRect().top)/h)),scroll:scrollY};
  });
}
const progress = page => page.evaluate(() => JSON.parse(localStorage.getItem(Object.keys(localStorage).find(k=>k.startsWith('nr:prog:')))));
const browserColors = page => page.evaluate(() => ({
  meta: document.querySelector('meta[name="theme-color"]').content,
  canvas: getComputedStyle(document.documentElement).backgroundColor,
  body: getComputedStyle(document.body).backgroundColor,
  scheme: getComputedStyle(document.documentElement).colorScheme,
  edges: [...document.querySelectorAll('.browser-edge')].map(el => ({
    color: getComputedStyle(el).backgroundColor,
    pointerEvents: getComputedStyle(el).pointerEvents,
    display: getComputedStyle(el).display,
    top: el.getBoundingClientRect().top,
    bottom: el.getBoundingClientRect().bottom,
  })),
  height: innerHeight,
}));
const showBars = async page => { if (!await page.locator('.bottom-bar').isVisible()) await page.locator('.reader-menu-access').evaluate(el=>el.click()); };
try {
  for(let i=0;i<60;i++){try{if((await fetch(base)).ok)break;}catch{} await sleep(200);}
  browser = await chromium.launch({channel:'msedge',headless:true});
  const ctx = await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
  const page = await ctx.newPage();
  const errors=[]; page.on('pageerror',e=>errors.push(String(e)));
  await page.goto(base);
  const shelfColors=await browserColors(page);
  check('书架画布与浏览器主题底色一致',shelfColors.meta==='#f7f7f8'&&shelfColors.canvas==='rgb(247, 247, 248)'&&shelfColors.body===shelfColors.canvas,shelfColors);
  await upload(page, fixture('滚动回归',30));
  await page.locator('.book-main').click();
  await page.waitForSelector('.paras p');
  await sleep(500);
  const sepiaColors=await browserColors(page);
  check('米黄主题同步浏览器主题色及上下背景',sepiaColors.meta==='#f5efe0'&&sepiaColors.canvas==='rgb(245, 239, 224)'&&sepiaColors.body===sepiaColors.canvas&&sepiaColors.edges.every(e=>e.color===sepiaColors.canvas&&e.pointerEvents==='none'&&e.display==='block'),sepiaColors);
  await page.evaluate(()=>{
    window.testScroll = window.scrollTo.bind(window);
    window.appScrollCalls=[];
    window.scrollTo=(...args)=>{window.appScrollCalls.push(args);window.testScroll(...args);};
  });
  for(let i=0;i<13;i++) {
    await page.waitForSelector(`section[data-idx="${i}"]`);
    await page.evaluate(i=>{
      const sec=document.querySelector(`section[data-idx="${i}"]`);
      window.testScroll(0,sec.offsetTop+sec.offsetHeight-innerHeight*.8);
    },i);
    await sleep(100);
    const before=await anchor(page);
    await sleep(500);
    const after=await anchor(page), saved=await progress(page);
    check(`跨章 ${i}: 回收前后同一段停在原处`, before.chapter===after.chapter && before.para===after.para && Math.abs(before.top-after.top)<1.5,{before,after});
    check(`跨章 ${i}: 保存段落与屏幕一致`,saved.chapterIndex===after.chapter && saved.paragraphIndex===after.para,{saved,after});
  }
  check('连续向下阅读不调用程序 scrollTo 补偿',await page.evaluate(()=>window.appScrollCalls.length)===0,await page.evaluate(()=>window.appScrollCalls));
  check('长章节回收后正文节点数量有限',await page.locator('section[data-idx]').count()<=9);
  const beforeReload=await anchor(page);
  await page.reload(); await page.locator('.book-main').click(); await page.waitForSelector('.paras p'); await sleep(600);
  const afterReload=await anchor(page);
  check('刷新恢复到同一段和同一屏幕位置',beforeReload.chapter===afterReload.chapter && beforeReload.para===afterReload.para && Math.abs(beforeReload.top-afterReload.top)<2,{beforeReload,afterReload});
  await showBars(page); await page.getByRole('button',{name:'设置',exact:true}).click();
  const beforeTheme=await anchor(page);
  await page.getByRole('button',{name:'深色',exact:true}).click(); await sleep(300);
  const afterTheme=await anchor(page);
  check('只改主题不改变正文位置',beforeTheme.chapter===afterTheme.chapter && beforeTheme.para===afterTheme.para && Math.abs(beforeTheme.top-afterTheme.top)<1,{beforeTheme,afterTheme});
  const darkColors=await browserColors(page);
  check('深色主题同步系统配色和边缘背景',darkColors.meta==='#111214'&&darkColors.canvas==='rgb(17, 18, 20)'&&darkColors.body===darkColors.canvas&&darkColors.scheme==='dark'&&darkColors.edges.every(e=>e.color===darkColors.canvas),darkColors);
  await page.getByRole('button',{name:'白色',exact:true}).click();
  const whiteColors=await browserColors(page);
  check('切回白色同步浏览器外观',whiteColors.meta==='#ffffff'&&whiteColors.canvas==='rgb(255, 255, 255)'&&whiteColors.scheme==='light'&&whiteColors.edges.every(e=>e.color===whiteColors.canvas),whiteColors);
  await page.getByRole('button',{name:'深色',exact:true}).click();
  const ranges=page.locator('.settings-sheet input[type=range]');
  for(const value of [20,24,16,18]) {
    await ranges.nth(0).evaluate((el,value)=>{Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,String(value));el.dispatchEvent(new Event('input',{bubbles:true}));},value);
    await sleep(100);
    const next=await anchor(page);
    check(`字号 ${value}: 保留同一段及段内比例`,next.chapter===beforeTheme.chapter && next.para===beforeTheme.para && Math.abs(next.ratio-beforeTheme.ratio)<.03,{beforeTheme,next});
  }
  const beforeWheel=await anchor(page);
  await page.mouse.move(150,90); await page.mouse.wheel(0,700); await sleep(350);
  const afterWheel=await anchor(page);
  check('设置遮罩阻止背景滚动',Math.abs(beforeWheel.top-afterWheel.top)<1 && beforeWheel.para===afterWheel.para,{beforeWheel,afterWheel});
  fs.mkdirSync(path.join(root,'e2e/results'),{recursive:true});
  await page.screenshot({path:path.join(root,'e2e/results/fixed-mobile.png')});
  await page.keyboard.press('Escape'); await sleep(300);
  const afterClose=await anchor(page);
  check('关闭弹层保留正文位置',afterClose.para===beforeWheel.para && Math.abs(afterClose.top-beforeWheel.top)<1.5,{beforeWheel,afterClose});
  const beforeBrowserResize=await page.evaluate(()=>scrollY);
  await page.setViewportSize({width:390,height:700});await sleep(300);
  const resizedColors=await browserColors(page);
  check('浏览器栏展开后上下背景跟随视口且不滚动正文',resizedColors.edges[0].top===0&&resizedColors.edges[1].bottom===resizedColors.height&&await page.evaluate(()=>scrollY)===beforeBrowserResize,resizedColors);
  await page.setViewportSize({width:390,height:844});await sleep(300);
  await page.setViewportSize({width:844,height:390}); await sleep(700);
  const landscape=await anchor(page);
  check('横屏保留段落和段内位置',landscape.chapter===afterClose.chapter&&landscape.para===afterClose.para&&Math.abs(landscape.ratio-afterClose.ratio)<.03,{afterClose,landscape});
  await page.setViewportSize({width:390,height:844}); await sleep(600);
  // 从窗口上缘往回读，覆盖前插与历史占位的替换。
  for(let i=0;i<3;i++){
    await page.evaluate(()=>{const sec=document.querySelector('section[data-idx]');window.scrollTo(0,sec.offsetTop+200);});
    await sleep(100); const before=await anchor(page); await sleep(600); const after=await anchor(page);
    check(`向上预加载 ${i}: 正文锚点保持`,before.chapter===after.chapter&&before.para===after.para&&Math.abs(before.top-after.top)<2,{before,after});
  }
  await sleep(500);
  const barsBeforeTap=await page.locator('.bottom-bar').isVisible();
  await page.touchscreen.tap(195,400);
  check('原生触摸轻点可切换菜单',await page.locator('.bottom-bar').isVisible()!==barsBeforeTap);
  const barsBeforeSwipe=await page.locator('.bottom-bar').isVisible();
  const scrollBeforeSwipe=await page.evaluate(()=>scrollY);
  const cdp=await ctx.newCDPSession(page);
  await cdp.send('Input.dispatchTouchEvent',{type:'touchStart',touchPoints:[{x:195,y:640}]});
  for(const y of [600,550,500,450,400,350]){
    await cdp.send('Input.dispatchTouchEvent',{type:'touchMove',touchPoints:[{x:195,y}]});await sleep(25);
  }
  await cdp.send('Input.dispatchTouchEvent',{type:'touchEnd',touchPoints:[]});await sleep(600);
  check('触摸滑动正常滚动且不误开菜单',await page.evaluate(()=>scrollY)>scrollBeforeSwipe&&await page.locator('.bottom-bar').isVisible()===barsBeforeSwipe);
  await showBars(page);await page.getByRole('button',{name:'设置',exact:true}).click();
  const beforeModalRotate=await anchor(page);
  await page.setViewportSize({width:844,height:390});await sleep(600);
  const rotatedModal=await anchor(page);
  check('设置打开时转横屏仍保持段落',beforeModalRotate.chapter===rotatedModal.chapter&&beforeModalRotate.para===rotatedModal.para&&Math.abs(beforeModalRotate.ratio-rotatedModal.ratio)<.03,{beforeModalRotate,rotatedModal});
  await page.keyboard.press('Escape');await sleep(400);
  const closedModal=await anchor(page);
  check('横屏关闭设置后不跳动',closedModal.chapter===rotatedModal.chapter&&closedModal.para===rotatedModal.para&&Math.abs(closedModal.top-rotatedModal.top)<2,{closedModal,rotatedModal});
  check('阅读场景无 JavaScript 错误',errors.length===0,errors);

  const dataPage=await (await browser.newContext()).newPage(); await dataPage.goto(base);
  const data=await dataPage.evaluate(async()=>{
    const db=await import('/novel-reader/src/db.ts');
    const {importBookFile}=await import('/novel-reader/src/importer.ts');
    const make=(n,title='导入回归',mark='原文')=>new File([JSON.stringify({title,chapters:Array.from({length:n},(_,i)=>({title:`章${i}`,content:`${mark}${i}`}))})],'test.json');
    const original=await importBookFile(make(205),()=>{});
    const old={chapterIndex:2,paragraphIndex:0,paragraphProgress:.2},fresh={chapterIndex:50,paragraphIndex:0,paragraphProgress:.8};
    await db.saveBookProgress(original.id,old);
    const savedBook=await db.getBook(original.id);
    localStorage.setItem(`nr:prog:${original.id}`,JSON.stringify({...fresh,updatedAt:savedBook.progressUpdatedAt+1}));
    const restored=await db.readSavedProgress(savedBook);
    let failed=false;
    try {await importBookFile(make(206,'导入回归','新文'),(_,stage)=>{if(stage.startsWith('写入章节 100/'))throw new Error('模拟中断');});}catch{failed=true;}
    const rollback={failed,count:await db.countChapters(original.id),last:(await db.getChapter(original.id,204))?.content,metadata:(await db.getBook(original.id)).chapterCount};
    const reset=await importBookFile(make(3),()=>{});
    localStorage.setItem(`nr:prog:${reset.id}`,JSON.stringify({...old,updatedAt:savedBook.progressUpdatedAt}));
    const resetProgress=await db.readSavedProgress(reset);
    const tx=await new Promise(resolve=>{const req=indexedDB.open('novel-reader');req.onsuccess=()=>resolve(req.result);});
    let newFailed=false;
    try{await importBookFile(make(201,'失败的新书'),(_,stage)=>{if(stage.startsWith('写入章节 100/'))throw new Error('模拟中断');});}catch{newFailed=true;}
    const all=await db.getAllBooks();
    const total=await new Promise(resolve=>{const req=tx.transaction('chapters').objectStore('chapters').count();req.onsuccess=()=>resolve(req.result);});
    return {restored,rollback,resetProgress,newFailed,books:all.length,total};
  });
  check('使用更新的同步进度镜像',data.restored.chapterIndex===50,data);
  check('覆盖导入失败完整保留原书',data.rollback.failed&&data.rollback.count===205&&data.rollback.metadata===205&&data.rollback.last==='原文204',data);
  check('重置后不复活旧进度镜像',data.resetProgress.chapterIndex===0,data);
  check('新书导入失败没有残留章节',data.newFailed&&data.books===1&&data.total===3,data);

  const short=await (await browser.newContext({viewport:{width:390,height:844}})).newPage();await short.goto(base);
  await upload(short,fixture('短章回归',80,1));await short.locator('.book-main').click();await short.waitForSelector('.paras p');await sleep(1000);
  const stable=await short.evaluate(async()=>{let changes=0;const mo=new MutationObserver(()=>changes++);mo.observe(document.querySelector('.content'),{childList:true});await new Promise(r=>setTimeout(r,800));mo.disconnect();return {changes,sections:document.querySelectorAll('section[data-idx]').length};});
  check('短章节静止后不再反复增删',stable.changes===0&&stable.sections<80,stable);
  await short.setViewportSize({width:1440,height:900});await sleep(700);await short.screenshot({path:path.join(root,'e2e/results/fixed-desktop.png')});
  check('桌面正文宽度受限',await short.locator('.content').evaluate(el=>el.getBoundingClientRect().width)<=780);
  check('桌面不叠加移动浏览器背景层',await short.locator('.browser-edge').first().evaluate(el=>getComputedStyle(el).display)==='none');
  console.log(`\n${checks} 项回归检查全部通过`);
} finally {
  await browser?.close();
  server.kill();
}
