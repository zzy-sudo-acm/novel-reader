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
  check('失败导入不破坏已有书籍',data.rollback.failed&&data.rollback.count===205&&data.rollback.metadata===205&&data.rollback.last==='原文204',data);
  check('重置后不复活旧进度镜像',data.resetProgress.chapterIndex===0,data);
  // 新的书籍身份规则：同名但指纹不同视为不同书（205 章版与 3 章版共存），失败导入无残留
  check('新书导入失败没有残留章节',data.newFailed&&data.books===2&&data.total===208,data);

  // ===== 书籍身份 / 进度迁移 / 删除原子性 / 旧进度兼容 =====
  const idPage=await (await browser.newContext()).newPage(); await idPage.goto(base);
  const identity=await idPage.evaluate(async()=>{
    const db=await import('/novel-reader/src/db.ts');
    const {importBookFile}=await import('/novel-reader/src/importer.ts');
    // 每章 5 段，保证 paragraphIndex=2 合法
    const mk=(titles,title,source)=>new File([JSON.stringify({title,source,chapters:titles.map(t=>({title:t,content:Array.from({length:5},(_,p)=>`${t}第${p}段正文。`).join('\n\n')}))})],'b.json');
    const titlesA=Array.from({length:30},(_,i)=>`第${i}章`);
    // C: 同名不同 source → 两本共存，互不覆盖
    const a=await importBookFile(mk(titlesA,'同名书','源A'),()=>{});
    const bAlt=await importBookFile(mk(titlesA.slice(0,25),'同名书','源B'),()=>{});
    const afterC=await db.getAllBooks();
    const cOk=afterC.length===2&&a.id!==bAlt.id&&(await db.countChapters(a.id))===30&&(await db.countChapters(bAlt.id))===25;
    // D: 相同 source 重导入 → 同一本书、进度保留
    await db.saveBookProgress(a.id,{chapterIndex:10,paragraphIndex:2,paragraphProgress:.5,paragraphCharProgress:.5});
    const a2=await importBookFile(mk(titlesA,'同名书','源A'),()=>{});
    const progD=await db.readSavedProgress(await db.getBook(a.id));
    const dOk=(await db.getAllBooks()).length===2&&a2.id===a.id&&progD.chapterIndex===10&&progD.paragraphIndex===2;
    // E: 同书前面插入一章 → 进度按章节标题迁移 10 → 11
    const a3=await importBookFile(mk(['新增序章',...titlesA],'同名书','源A'),()=>{});
    const progE=await db.readSavedProgress(await db.getBook(a.id));
    const eOk=a3.id===a.id&&(await db.getAllBooks()).length===2&&progE.chapterIndex===11&&progE.paragraphIndex===2;
    // F: 删除原子性——books 删除失败时章节回滚；成功时全部清理
    const origDelete=IDBObjectStore.prototype.delete;
    IDBObjectStore.prototype.delete=function(key){if(this.name==='books')throw new Error('模拟 books 删除失败');return origDelete.call(this,key);};
    let threw=false;
    try{await db.deleteBook(bAlt.id);}catch{threw=true;}
    IDBObjectStore.prototype.delete=origDelete;
    const intact=(await db.countChapters(bAlt.id))===25&&!!(await db.getBook(bAlt.id));
    await db.deleteBook(bAlt.id);
    const cleaned=!(await db.getBook(bAlt.id))&&(await db.countChapters(bAlt.id))===0&&(await db.getAllBooks()).length===1;
    const fOk=threw&&intact&&cleaned;
    // A: 旧版进度（无 paragraphCharProgress）正常读取
    const legacyBook=await importBookFile(mk(titlesA.slice(0,20),'旧进度书','源C'),()=>{});
    const lb=await db.getBook(legacyBook.id);
    localStorage.setItem(`nr:prog:${lb.id}`,JSON.stringify({chapterIndex:7,paragraphIndex:3,paragraphProgress:.4,updatedAt:Date.now()}));
    const progA=await db.readSavedProgress(lb);
    const aOk=progA.chapterIndex===7&&progA.paragraphIndex===3&&Math.abs(progA.paragraphProgress-.4)<1e-9;
    // 同一本书覆盖导入中途失败 → 原书完整保留
    let failThrew=false;
    try{await importBookFile(mk(titlesA,'同名书','源A'),(_,stage)=>{if(stage.startsWith('写入章节'))throw new Error('模拟中断');});}catch{failThrew=true;}
    const gOk=failThrew&&(await db.countChapters(a.id))===31&&(await db.getBook(a.id)).chapterCount===31&&(await db.getChapter(a.id,11))?.title==='第10章';
    return {cOk,dOk,eOk,fOk,aOk,gOk};
  });
  check('同名不同源的书互不覆盖',identity.cOk,identity);
  check('同源重导入保留身份与进度',identity.dOk,identity);
  check('前插章节后进度按标题迁移',identity.eOk,identity);
  check('删除失败整体回滚、删除成功全部清理',identity.fOk,identity);
  check('旧版进度数据兼容恢复',identity.aOk,identity);
  check('同书覆盖导入失败保留原书',identity.gOk,identity);

  // ===== B: 字符级进度——改字号后回到原文同一文字附近 =====
  const charPage=await (await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true})).newPage();
  await charPage.goto(base);
  await upload(charPage,{title:'字符进度',chapters:Array.from({length:6},(_,i)=>({title:`长章${i}`,content:Array.from({length:5},(_,p)=>`第${i}章第${p}段。`+'验'.repeat(360)).join('\n\n')}))});
  await charPage.locator('.book-main').click();
  await charPage.waitForSelector('.paras p'); await sleep(600);
  await charPage.evaluate(()=>{
    const p=document.querySelector('section[data-idx="2"]').querySelectorAll('.paras p')[2];
    window.scrollTo(0,p.getBoundingClientRect().top+scrollY+p.offsetHeight*.6-innerHeight*.33);
  });
  await sleep(700);
  const charAt=()=>charPage.evaluate(()=>{
    const r=document.caretRangeFromPoint(150,innerHeight*.33);
    const p=r?.startContainer?.parentElement;
    const sec=p?.closest('section');
    if(!r||!p||!sec)return null;
    return {chapter:+sec.dataset.idx,para:[...sec.querySelectorAll('p')].indexOf(p),offset:r.startOffset,len:p.textContent.length};
  });
  const c1=await charAt();
  const savedProg=await progress(charPage);
  check('进度包含字符比例字段',typeof savedProg?.paragraphCharProgress==='number',savedProg);
  await showBars(charPage);
  await charPage.getByRole('button',{name:'设置',exact:true}).click();
  await charPage.locator('.settings-sheet input[type=range]').nth(0).evaluate(el=>{
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'26');
    el.dispatchEvent(new Event('input',{bubbles:true}));
  });
  await sleep(400);
  await charPage.keyboard.press('Escape'); await sleep(500);
  const c2=await charAt();
  check('改字号后字符级位置保持',c1&&c2&&c1.chapter===c2.chapter&&c1.para===c2.para&&Math.abs(c1.offset-c2.offset)<=Math.max(30,c1.len*.1),{c1,c2});

  const short=await (await browser.newContext({viewport:{width:390,height:844}})).newPage();await short.goto(base);
  await upload(short,fixture('短章回归',80,1));await short.locator('.book-main').click();await short.waitForSelector('.paras p');await sleep(1000);
  const stable=await short.evaluate(async()=>{let changes=0;const mo=new MutationObserver(()=>changes++);mo.observe(document.querySelector('.content'),{childList:true});await new Promise(r=>setTimeout(r,800));mo.disconnect();return {changes,sections:document.querySelectorAll('section[data-idx]').length};});
  check('短章节静止后不再反复增删',stable.changes===0&&stable.sections<80,stable);

  // 浏览器/系统回顶只提供 scroll 事件，不经过应用的 scrollToY。
  // 从保存的进度开始，验证动画全过程保留起点，而不是最后一帧的位置。
  const recoveryPage=await (await browser.newContext({viewport:{width:390,height:844},isMobile:true,hasTouch:true})).newPage();
  await recoveryPage.goto(base);
  await upload(recoveryPage,fixture('回顶恢复',20,20));
  await recoveryPage.evaluate(async()=>{
    const db=await import('/novel-reader/src/db.ts');
    const [book]=await db.getAllBooks();
    await db.saveBookProgress(book.id,{chapterIndex:12,paragraphIndex:15,paragraphProgress:.4});
  });
  await recoveryPage.locator('.book-main').click();
  await recoveryPage.waitForSelector('.paras p'); await sleep(700);
  check('恢复进度不会误报回顶',await recoveryPage.locator('.return-position').count()===0);
  const initialY=await recoveryPage.evaluate(()=>scrollY);
  for(const y of [130,230,350]) { await recoveryPage.touchscreen.tap(195,y); await sleep(300); }
  check('上半屏连续轻点不移动正文',Math.abs(await recoveryPage.evaluate(()=>scrollY)-initialY)<2);
  await recoveryPage.evaluate(()=>window.scrollBy(0,-150)); await sleep(500);
  check('普通向上短滑不显示返回入口',await recoveryPage.locator('.return-position').count()===0);
  for(const behavior of ['smooth','instant']) {
    const origin=await anchor(recoveryPage);
    if(await recoveryPage.locator('.bottom-bar').isVisible()) await recoveryPage.touchscreen.tap(195,350);
    await recoveryPage.evaluate(behavior=>window.scrollTo({top:0,behavior}),behavior);
    await recoveryPage.waitForFunction(()=>scrollY<=2);
    await recoveryPage.getByRole('button',{name:'返回原阅读位置',exact:true}).waitFor({state:'visible'});
    check(`${behavior} 大幅回顶后自动显示恢复入口`,await recoveryPage.locator('.bottom-bar').isVisible());
    await recoveryPage.getByRole('button',{name:'返回原阅读位置',exact:true}).click(); await sleep(700);
    const returned=await anchor(recoveryPage);
    check(`${behavior} 回顶后恢复误触前的段落和位置`,origin.chapter===returned.chapter&&origin.para===returned.para&&Math.abs(origin.top-returned.top)<2,{origin,returned});
    check(`${behavior} 返回后不会循环生成恢复入口`,await recoveryPage.locator('.return-position').count()===0);
  }

  await short.setViewportSize({width:1440,height:900});await sleep(700);await short.screenshot({path:path.join(root,'e2e/results/fixed-desktop.png')});
  check('桌面正文宽度受限',await short.locator('.content').evaluate(el=>el.getBoundingClientRect().width)<=780);
  check('桌面不叠加移动浏览器背景层',await short.locator('.browser-edge').first().evaluate(el=>getComputedStyle(el).display)==='none');
  console.log(`\n${checks} 项回归检查全部通过`);
} finally {
  await browser?.close();
  server.kill();
}
