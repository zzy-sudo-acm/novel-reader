import React, { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import type { BookMeta } from '../types';
import { getBook, getChapter, readSavedProgress, saveBookProgress } from '../db';
import type { ReaderSettings } from '../settings';
import Toc from './Toc';
import SettingsSheet from './SettingsSheet';
import { getScrollTop, scrollToY } from '../scroll';

interface ChapterData {
  index: number;
  title: string;
  paragraphs: string[];
}

interface Props {
  bookId: string;
  settings: ReaderSettings;
  onSettingsChange: (s: ReaderSettings) => void;
  onExit: () => void;
}

/** 至少保留的章节数；短章节还必须满足像素缓冲区，不能强行裁到六章。 */
const KEEP = 6;
const READING_LINE = 0.33;
/** 向下/向上预加载的缓冲区（视口高度倍数） */
const BUFFER_DOWN = 3;
const BUFFER_UP = 2;

function splitParagraphs(content: string): string[] {
  return content
    .split(/\r\n|\r|\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function prefixSums(arr: number[]): number[] {
  const out = new Array<number>(arr.length + 1).fill(0);
  for (let i = 0; i < arr.length; i++) out[i + 1] = out[i] + arr[i];
  return out;
}

function getViewH(): number {
  return window.innerHeight;
}

function documentTop(el: HTMLElement): number {
  return el.getBoundingClientRect().top + getScrollTop();
}

export default function Reader({ bookId, settings, onSettingsChange, onExit }: Props) {
  const bookRef = useRef<BookMeta | null>(null);
  const [book, setBook] = useState<BookMeta | null>(null);
  const [ready, setReady] = useState(false);
  const [, forceRender] = useReducer((x: number) => x + 1, 0);
  const [error, setError] = useState<string | null>(null);
  const [percent, setPercent] = useState(0);

  const indicesRef = useRef<number[]>([]);
  const cacheRef = useRef(new Map<number, ChapterData>());
  const sectionEls = useRef(new Map<number, HTMLElement>());
  /** 当前布局中每章段落的逻辑文档坐标，包含已回收章节的等高占位。 */
  const offsetsRef = useRef(new Map<number, number[]>());
  const pendingAnchorRef = useRef<{ chapter: number; para: number; top: number } | null>(null);
  const pendingScrollRef = useRef<{ chapter: number; para: number; ratio: number } | null>(null);
  const progressRef = useRef({ chapter: 0, para: 0, ratio: 0 });
  const prefixCharsRef = useRef<number[]>([0]);
  const topSpaceRef = useRef(0);
  const bottomSpaceRef = useRef(0);
  const heightsRef = useRef(new Map<number, number>());
  const generationRef = useRef(0);
  const activeRef = useRef(false);
  const initializedRef = useRef(false);
  const errorRef = useRef(false);
  const overlayRef = useRef<'none' | 'toc' | 'settings'>('none');
  const touchingRef = useRef(false);
  const lastScrollRef = useRef(0);
  const idleTimerRef = useRef(0);
  const hintTimerRef = useRef(0);
  const syncRafRef = useRef(0);
  const gestureRef = useRef<{ id: number; x: number; y: number; scroll: number; time: number; valid: boolean } | null>(null);

  const [current, setCurrent] = useState(0);
  const currentRef = useRef(0);
  const [barsVisible, setBarsVisible] = useState(true);
  const [showHint, setShowHint] = useState(false);
  const [overlay, setOverlay] = useState<'none' | 'toc' | 'settings'>('none');

  const syncingRef = useRef(false);
  const syncScheduledRef = useRef(false);
  const needSyncRef = useRef(false);
  const rafRef = useRef(0);
  const saveTimerRef = useRef(0);
  const prevSettingsRef = useRef(settings);

  function fail(e: unknown) {
    if (!activeRef.current) return;
    errorRef.current = true;
    setError(e instanceof Error ? e.message : '章节加载失败，请返回书架后重试');
  }

  function scrolling() { return touchingRef.current || performance.now() - lastScrollRef.current < 220; }

  function waitForIdle() {
    window.clearTimeout(idleTimerRef.current);
    idleTimerRef.current = window.setTimeout(() => { if (!touchingRef.current) scheduleSync(); }, 250);
  }

  // ---------- 数据加载 ----------

  async function loadChapter(i: number): Promise<ChapterData | null> {
    const generation = generationRef.current;
    const cached = cacheRef.current.get(i);
    if (cached) return cached;
    const rec = await getChapter(bookId, i);
    if (!rec) throw new Error(`第 ${i + 1} 章正文缺失，请重新导入完整书籍`);
    const data: ChapterData = { index: i, title: rec.title, paragraphs: splitParagraphs(rec.content) };
    if (activeRef.current && generation === generationRef.current) cacheRef.current.set(i, data);
    return data;
  }

  // ---------- 测量工具（弹层锁定 body 时也使用同一文档坐标） ----------

  function getOffsets(idx: number): number[] {
    let o = offsetsRef.current.get(idx);
    if (!o) {
      const sec = sectionEls.current.get(idx);
      o = [];
      if (sec) {
        const paras = sec.querySelector('.paras');
        if (paras) {
          for (let k = 0; k < paras.children.length; k++) {
            o.push(documentTop(paras.children[k] as HTMLElement));
          }
        }
      }
      offsetsRef.current.set(idx, o);
    }
    return o;
  }

  function paraElement(idx: number, para: number): HTMLElement | null {
    const sec = sectionEls.current.get(idx);
    const el = sec?.querySelector('.paras')?.children[para];
    return (el as HTMLElement) ?? null;
  }

  /** 找到视口顶部附近的锚点段落，用于增删章节后的滚动补偿 */
  function captureAnchor() {
    const y = getScrollTop();
    for (const idx of indicesRef.current) {
      const sec = sectionEls.current.get(idx);
      if (!sec) continue;
      if (documentTop(sec) + sec.offsetHeight <= y) continue;
      const offs = getOffsets(idx);
      let p = 0;
      for (let k = 0; k < offs.length; k++) {
        const h = paragraphHeight(idx, k, offs);
        if (offs[k] + h > y) {
          p = k;
          break;
        }
      }
      const el = paraElement(idx, p);
      if (el) pendingAnchorRef.current = { chapter: idx, para: p, top: el.getBoundingClientRect().top };
      return;
    }
  }

  function paragraphHeight(chapter: number, para: number, offsets = getOffsets(chapter)) {
    return Math.max(1, para + 1 < offsets.length
      ? offsets[para + 1] - offsets[para]
      : paraElement(chapter, para)?.offsetHeight ?? 40);
  }

  function scrollToPara(chapter: number, para: number, ratio: number) {
    const sec = sectionEls.current.get(chapter);
    if (!sec) return;
    const offs = getOffsets(chapter);
    if (offs.length === 0) {
      scrollToY(documentTop(sec));
      return;
    }
    const p = Math.max(0, Math.min(para, offs.length - 1));
    const h = paragraphHeight(chapter, p, offs);
    scrollToY(offs[p] + ratio * h - getViewH() * READING_LINE);
  }

  // ---------- 窗口滑动（核心） ----------

  async function grow(dir: 'append' | 'prepend', i: number) {
    const generation = generationRef.current;
    const data = await loadChapter(i);
    if (!data || !activeRef.current || generation !== generationRef.current) return;
    // 前插未渲染内容可能改变高度，只在手指和惯性均停止后锚定。
    if (dir === 'prepend' && scrolling()) { waitForIdle(); return; }
    const idxs = indicesRef.current;
    if (dir === 'append') {
      if (idxs[idxs.length - 1] !== i - 1) return;
      bottomSpaceRef.current = Math.max(0, bottomSpaceRef.current - (heightsRef.current.get(i) ?? 0));
      indicesRef.current = [...idxs, i];
    } else {
      if (idxs[0] !== i + 1) return;
      captureAnchor();
      topSpaceRef.current = Math.max(0, topSpaceRef.current - (heightsRef.current.get(i) ?? 0));
      indicesRef.current = [i, ...idxs];
    }
    forceRender();
  }

  function trim() {
    const idxs = indicesRef.current;
    if (idxs.length <= KEEP || scrolling()) return;
    const y = getScrollTop();
    const h = getViewH();
    let cutAbove = 0;
    let cutBelow = 0;
    while (idxs.length - cutAbove > KEEP) {
      const sec = sectionEls.current.get(idxs[cutAbove]);
      if (!sec || documentTop(sec) + sec.offsetHeight >= y - h * (BUFFER_UP + 1)) break;
      heightsRef.current.set(idxs[cutAbove], sec.getBoundingClientRect().height);
      topSpaceRef.current += sec.getBoundingClientRect().height;
      cutAbove++;
    }
    while (idxs.length - cutAbove - cutBelow > KEEP) {
      const index = idxs[idxs.length - 1 - cutBelow];
      const sec = sectionEls.current.get(index);
      if (!sec || documentTop(sec) <= y + h * (BUFFER_DOWN + 2)) break;
      heightsRef.current.set(index, sec.getBoundingClientRect().height);
      bottomSpaceRef.current += sec.getBoundingClientRect().height;
      cutBelow++;
    }
    if (cutAbove <= 0 && cutBelow <= 0) return;
    // 用等高占位保留文档坐标；向下阅读时不再 scrollTo 补偿几千像素。
    const removed = [...idxs.slice(0, cutAbove), ...idxs.slice(idxs.length - cutBelow)];
    indicesRef.current = idxs.slice(cutAbove, idxs.length - cutBelow);
    for (const i of removed) {
      offsetsRef.current.delete(i);
      cacheRef.current.delete(i);
    }
    forceRender();
  }

  /** 单步同步：append / prepend / trim 一次，之后由 layout effect 继续调度直到收敛 */
  async function step() {
    if (!activeRef.current || !initializedRef.current || errorRef.current || overlayRef.current !== 'none' || pendingScrollRef.current) return;
    const b = bookRef.current;
    if (!b) return;
    const idxs = indicesRef.current;
    if (idxs.length === 0) return;
    const first = idxs[0];
    const last = idxs[idxs.length - 1];
    const firstSec = sectionEls.current.get(first);
    const lastSec = sectionEls.current.get(last);
    if (!firstSec || !lastSec) return;
    const viewTop = getScrollTop();
    const viewH = getViewH();

    if (last < b.chapterCount - 1 && documentTop(lastSec) + lastSec.offsetHeight < viewTop + viewH * BUFFER_DOWN) {
      await grow('append', last + 1);
      return;
    }
    if (first > 0 && documentTop(firstSec) > viewTop - viewH * BUFFER_UP) {
      if (scrolling()) { waitForIdle(); return; }
      await grow('prepend', first - 1);
      return;
    }
    trim();
  }

  function scheduleSync() {
    if (!activeRef.current || syncScheduledRef.current) return;
    syncScheduledRef.current = true;
    syncRafRef.current = requestAnimationFrame(() => {
      syncScheduledRef.current = false;
      if (syncingRef.current) {
        needSyncRef.current = true;
        return;
      }
      syncingRef.current = true;
      void step().catch(fail).finally(() => {
        syncingRef.current = false;
        if (needSyncRef.current) {
          needSyncRef.current = false;
          scheduleSync();
        }
      });
    });
  }

  // ---------- 当前章节与进度 ----------

  function updateCurrent() {
    if (!initializedRef.current || pendingScrollRef.current) return;
    const refY = getScrollTop() + getViewH() * READING_LINE;
    const idxs = indicesRef.current;
    if (idxs.length === 0) return;
    let cur = idxs[0];
    for (const i of idxs) {
      const sec = sectionEls.current.get(i);
      if (sec && documentTop(sec) <= refY) cur = i;
      else break;
    }
    let para = 0;
    let ratio = 0;
    const offs = getOffsets(cur);
    for (let k = offs.length - 1; k >= 0; k--) {
      if (offs[k] <= refY) {
        para = k;
        const h = paragraphHeight(cur, k, offs);
        ratio = Math.min(1, Math.max(0, (refY - offs[k]) / (h || 40)));
        break;
      }
    }
    progressRef.current = { chapter: cur, para, ratio };
    const b = bookRef.current;
    const entry = b?.toc[cur];
    if (b && entry) {
      const fraction = Math.min(1, (para + ratio) / Math.max(1, entry.p));
      const next = ((prefixCharsRef.current[cur] ?? 0) + fraction * entry.c) / Math.max(1, b.totalChars) * 100;
      setPercent(Math.round(Math.min(100, next) * 10) / 10);
    }
    if (cur !== currentRef.current) {
      currentRef.current = cur;
      setCurrent(cur);
      scheduleSave();
    }
  }

  function scheduleSave() {
    window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(saveNow, 400);
  }

  function saveNow() {
    const b = bookRef.current;
    if (!b || !initializedRef.current) return;
    const p = progressRef.current;
    void saveBookProgress(b.id, {
      chapterIndex: p.chapter,
      paragraphIndex: p.para,
      paragraphProgress: p.ratio,
    });
  }

  // ---------- 渲染后：应用待处理的滚动补偿 / 定位 ----------

  useLayoutEffect(() => {
    overlayRef.current = overlay;
    // 字体、窗口结构变化都会改变坐标。只缓存当前这次布局。
    offsetsRef.current.clear();
    const previous = prevSettingsRef.current;
    prevSettingsRef.current = settings;
    if (previous.fontSize !== settings.fontSize || previous.lineHeight !== settings.lineHeight ||
        previous.margin !== settings.margin || previous.fontFamily !== settings.fontFamily) {
      if (bookRef.current && !pendingScrollRef.current) {
        const p = progressRef.current;
        pendingScrollRef.current = { chapter: p.chapter, para: p.para, ratio: p.ratio };
      }
    }

    if (pendingScrollRef.current) {
      const t = pendingScrollRef.current;
      const sec = sectionEls.current.get(t.chapter);
      if (sec) {
        pendingScrollRef.current = null;
        scrollToPara(t.chapter, t.para, t.ratio);
        updateCurrent();
      }
    } else if (pendingAnchorRef.current) {
      const a = pendingAnchorRef.current;
      pendingAnchorRef.current = null;
      const el = paraElement(a.chapter, a.para);
      if (el) {
        const delta = el.getBoundingClientRect().top - a.top;
        if (Math.abs(delta) > 0.5) scrollToY(getScrollTop() + delta);
      }
    }
    if (initializedRef.current) updateCurrent();
    scheduleSync();
  });

  // ---------- 初始化：加载书籍并恢复进度 ----------

  useEffect(() => {
    let cancelled = false;
    activeRef.current = true;
    const generation = ++generationRef.current;
    (async () => {
      const b = await getBook(bookId);
      if (cancelled) return;
      if (!b) throw new Error('书籍不存在，请返回书架重新导入');
      bookRef.current = b;
      setBook(b);
      prefixCharsRef.current = prefixSums(b.toc.map((t) => t.c));
      const saved = await readSavedProgress(b);
      const start = Math.max(0, Math.min(saved.chapterIndex, b.chapterCount - 1));
      const lo = Math.max(0, start - 1);
      const hi = Math.min(b.chapterCount - 1, start + 2);
      const arr = Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
      await Promise.all(arr.map(loadChapter));
      if (cancelled || generation !== generationRef.current) return;
      indicesRef.current = arr;
      currentRef.current = start;
      setCurrent(start);
      progressRef.current = { chapter: start, para: saved.paragraphIndex, ratio: saved.paragraphProgress };
      pendingScrollRef.current = { chapter: start, para: saved.paragraphIndex, ratio: saved.paragraphProgress };
      initializedRef.current = true;
      setReady(true);
      forceRender();
      // 首次进入时控制栏默认可见，并短暂提示操作方式
      setBarsVisible(true);
      setShowHint(true);
      hintTimerRef.current = window.setTimeout(() => {
        setShowHint(false);
        setBarsVisible(false);
      }, 4000);
    })().catch((e) => { if (!cancelled) fail(e); });
    return () => {
      cancelled = true;
      activeRef.current = false;
      generationRef.current++;
      window.clearTimeout(hintTimerRef.current);
      window.clearTimeout(idleTimerRef.current);
      cancelAnimationFrame(rafRef.current);
      cancelAnimationFrame(syncRafRef.current);
      syncScheduledRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId]);

  // ---------- 事件：滚动 / 保存 / 横竖屏 / 地址栏变化 ----------

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'hidden') { updateCurrent(); saveNow(); }
    };
    const onPageHide = () => { updateCurrent(); saveNow(); };
    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('beforeunload', onPageHide);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('pagehide', onPageHide);
      window.removeEventListener('beforeunload', onPageHide);
      window.clearTimeout(saveTimerRef.current);
      saveNow();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId]);

  // 原生文档滚动监听
  useEffect(() => {
    const h = () => onScroll();
    const touch = (e: TouchEvent) => {
      touchingRef.current = e.touches.length > 0;
      if (!touchingRef.current) waitForIdle();
    };
    window.addEventListener('scroll', h, { passive: true });
    window.addEventListener('touchstart', touch, { passive: true });
    window.addEventListener('touchend', touch, { passive: true });
    window.addEventListener('touchcancel', touch, { passive: true });
    return () => {
      window.removeEventListener('scroll', h);
      window.removeEventListener('touchstart', touch);
      window.removeEventListener('touchend', touch);
      window.removeEventListener('touchcancel', touch);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 仅宽度变化（横竖屏切换）时重新锚定；Safari 地址栏展开/收起只改高度，不重定位
  useEffect(() => {
    if (!ready) return;
    let w = window.innerWidth;
    let timer = 0;
    const onResize = () => {
      if (window.innerWidth === w) return;
      w = window.innerWidth;
      const p = { ...progressRef.current };
      // 先冻结锚点，避免 resize 之后的 scroll 事件把旧进度替换掉。
      pendingScrollRef.current = p;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        offsetsRef.current.clear();
        pendingScrollRef.current = { chapter: p.chapter, para: p.para, ratio: p.ratio };
        forceRender();
      }, 150);
    };
    window.addEventListener('resize', onResize);
    window.visualViewport?.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.visualViewport?.removeEventListener('resize', onResize);
      window.clearTimeout(timer);
    };
  }, [ready]);

  function onScroll() {
    lastScrollRef.current = performance.now();
    waitForIdle();
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      updateCurrent();
      scheduleSync();
      scheduleSave();
    });
  }

  // ---------- 跳转 ----------

  async function jumpTo(i: number) {
    const b = bookRef.current;
    if (!b) return;
    setOverlay('none');
    const generation = ++generationRef.current;
    errorRef.current = false;
    setError(null);
    const target = Math.max(0, Math.min(i, b.chapterCount - 1));
    const lo = Math.max(0, target - 1);
    const hi = Math.min(b.chapterCount - 1, target + 2);
    const arr = Array.from({ length: hi - lo + 1 }, (_, k) => lo + k);
    try { await Promise.all(arr.map(loadChapter)); } catch (e) { fail(e); return; }
    if (!activeRef.current || generation !== generationRef.current) return;
    topSpaceRef.current = 0;
    bottomSpaceRef.current = 0;
    heightsRef.current.clear();
    for (const key of cacheRef.current.keys()) if (!arr.includes(key)) cacheRef.current.delete(key);
    offsetsRef.current.clear();
    indicesRef.current = arr;
    pendingAnchorRef.current = null;
    pendingScrollRef.current = { chapter: target, para: 0, ratio: 0 };
    progressRef.current = { chapter: target, para: 0, ratio: 0 };
    currentRef.current = target;
    setCurrent(target);
    forceRender();
    scheduleSave();
  }

  function handleBack() {
    updateCurrent();
    saveNow();
    onExit();
  }

  // ---------- 渲染 ----------

  const b = book;

  return (
    <div
      className="reader"
      style={
        {
          '--fs': `${settings.fontSize}px`,
          '--lh': settings.lineHeight,
          '--mg': `${settings.margin}px`,
          fontFamily:
            settings.fontFamily === 'serif'
              ? "'Songti SC', 'Noto Serif CJK SC', 'SimSun', Georgia, serif"
              : "-apple-system, 'PingFang SC', 'Microsoft YaHei', sans-serif",
        } as React.CSSProperties
      }
    >
      <button className="reader-menu-access" onClick={() => setBarsVisible(true)}>显示阅读菜单</button>
      <div
        className="content"
        onPointerDown={(e) => {
          if (!e.isPrimary) { if (gestureRef.current) gestureRef.current.valid = false; return; }
          gestureRef.current = { id: e.pointerId, x: e.clientX, y: e.clientY, scroll: getScrollTop(), time: performance.now(), valid: !scrolling() };
        }}
        onPointerMove={(e) => {
          const g = gestureRef.current;
          if (g && (Math.abs(g.x - e.clientX) > 8 || Math.abs(g.y - e.clientY) > 8)) g.valid = false;
        }}
        onPointerUp={() => waitForIdle()}
        onPointerCancel={() => {
          if (gestureRef.current) gestureRef.current.valid = false;
          waitForIdle();
        }}
        onClick={(e) => {
          const g = gestureRef.current;
          if (overlay === 'none' && g?.valid && performance.now() - g.time < 500 &&
              Math.abs(getScrollTop() - g.scroll) < 4 && e.clientX > window.innerWidth * .15 &&
              e.clientX < window.innerWidth * .85 && e.clientY > getViewH() * .15 && e.clientY < getViewH() * .85 &&
              !window.getSelection()?.toString()) {
            window.clearTimeout(hintTimerRef.current);
            setShowHint(false);
            setBarsVisible((v) => !v);
          }
        }}
      >
        <div aria-hidden="true" style={{ height: topSpaceRef.current }} />
        {ready &&
          indicesRef.current.map((i) => {
            const ch = cacheRef.current.get(i);
            if (!ch) return null;
            return (
              <section
                className="chapter"
                key={i}
                data-idx={i}
                ref={(el) => {
                  if (el) sectionEls.current.set(i, el);
                  else sectionEls.current.delete(i);
                }}
              >
                <h2 className="ch-title">{ch.title}</h2>
                <div className="paras">
                  {ch.paragraphs.map((t, k) => (
                    <p key={k}>{t}</p>
                  ))}
                </div>
              </section>
            );
          })}
        <div aria-hidden="true" style={{ height: bottomSpaceRef.current }} />
        {ready && indicesRef.current.length > 0 && b && indicesRef.current[indicesRef.current.length - 1] >= b.chapterCount - 1 && (
          <div className="book-end">全书完</div>
        )}
      </div>

      {barsVisible && overlay === 'none' && (
        <>
          <div className="bar top-bar">
            <button className="bar-btn" onClick={handleBack}>
              ‹ 书架
            </button>
            <div className="bar-title">{b?.toc[current]?.t ?? b?.title ?? ''}</div>
            <div className="bar-pct">{percent.toFixed(1)}%</div>
          </div>
          <div className="bar bottom-bar">
            <button className="bar-btn" onClick={() => setOverlay('toc')}>
              目录
            </button>
            <div className="bar-sub">
              {current + 1}/{b?.chapterCount ?? 0}
            </div>
            <button className="bar-btn" onClick={() => setOverlay('settings')}>
              设置
            </button>
          </div>
        </>
      )}

      {overlay === 'toc' && b && (
        <Toc toc={b.toc} current={current} onClose={() => setOverlay('none')} onSelect={jumpTo} />
      )}
      {overlay === 'settings' && (
        <SettingsSheet settings={settings} onChange={onSettingsChange} onClose={() => setOverlay('none')} />
      )}

      {error && <div className="reader-error" role="alert"><p>{error}</p><button className="bar-btn" onClick={handleBack}>返回书架</button></div>}
      {!ready && !error && <div className="loading">加载中…</div>}

      {ready && showHint && overlay === 'none' && (
        <div className="tap-hint">轻点屏幕中央可显示 / 隐藏菜单（目录、设置）</div>
      )}
    </div>
  );
}
