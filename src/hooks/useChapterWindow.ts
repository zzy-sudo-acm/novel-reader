import { useEffect, useReducer, useRef } from 'react';
import { getChapter } from '../db';
import type { ChapterIllustration } from '../types';
import { splitContentParagraphs } from '../paragraphs';
import { getScrollTop, getViewportHeight, scrollToY } from '../scroll';

export interface ChapterData {
  index: number;
  title: string;
  paragraphs: string[];
  images?: ChapterIllustration[];
}

/** 至少保留的章节数；短章节还必须满足像素缓冲区，不能强行裁到六章。 */
const KEEP = 6;
/** 向下/向上预加载的缓冲区（视口高度倍数） */
const BUFFER_DOWN = 3;
const BUFFER_UP = 2;

/** 元素的逻辑文档坐标（弹层锁定 body 时同样有效） */
export function documentTop(el: HTMLElement): number {
  return el.getBoundingClientRect().top + getScrollTop();
}

interface Options {
  bookId: string;
  /** 组件存活标记（卸载后不再写缓存/DOM 状态） */
  activeRef: { current: boolean };
  getChapterCount: () => number;
  /** 初始化未完成、出错、弹层打开或等待重定位时应返回 false */
  canSync: () => boolean;
  onError: (e: unknown) => void;
}

/**
 * 连续滚动窗口：
 * 只真实渲染当前附近的少量章节，被回收的章节用 top/bottom 等高占位
 * 保持文档坐标稳定，从而滚动位置不跳动、也不依赖 scrollTo 补偿。
 */
export function useChapterWindow({ bookId, activeRef, getChapterCount, canSync, onError }: Options) {
  const [, forceRender] = useReducer((x: number) => x + 1, 0);
  const indicesRef = useRef<number[]>([]);
  const cacheRef = useRef(new Map<number, ChapterData>());
  const sectionEls = useRef(new Map<number, HTMLElement>());
  /** 当前布局中每章段落的逻辑文档坐标，仅本次布局有效（由 Reader 在每个 layout effect 清除） */
  const offsetsRef = useRef(new Map<number, number[]>());
  const heightsRef = useRef(new Map<number, number>());
  const topSpaceRef = useRef(0);
  const bottomSpaceRef = useRef(0);
  const pendingAnchorRef = useRef<{ chapter: number; para: number; top: number } | null>(null);
  const generationRef = useRef(0);

  const touchingRef = useRef(false);
  const lastScrollRef = useRef(0);
  const idleTimerRef = useRef(0);
  const syncRafRef = useRef(0);
  const syncingRef = useRef(false);
  const syncScheduledRef = useRef(false);
  const needSyncRef = useRef(false);

  function scrolling() {
    return touchingRef.current || performance.now() - lastScrollRef.current < 220;
  }

  function waitForIdle() {
    window.clearTimeout(idleTimerRef.current);
    idleTimerRef.current = window.setTimeout(() => {
      if (!touchingRef.current) scheduleSync();
    }, 250);
  }

  /** 滚动事件入口：记录活跃时间并安排惯性结束后的窗口同步 */
  function notifyScroll() {
    lastScrollRef.current = performance.now();
    waitForIdle();
  }

  useEffect(() => {
    const touch = (e: TouchEvent) => {
      touchingRef.current = e.touches.length > 0;
      if (!touchingRef.current) waitForIdle();
    };
    window.addEventListener('touchstart', touch, { passive: true });
    window.addEventListener('touchend', touch, { passive: true });
    window.addEventListener('touchcancel', touch, { passive: true });
    return () => {
      window.removeEventListener('touchstart', touch);
      window.removeEventListener('touchend', touch);
      window.removeEventListener('touchcancel', touch);
      window.clearTimeout(idleTimerRef.current);
      cancelAnimationFrame(syncRafRef.current);
      syncScheduledRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---------- 数据加载 ----------

  async function loadChapter(i: number): Promise<ChapterData | null> {
    const generation = generationRef.current;
    const cached = cacheRef.current.get(i);
    if (cached) return cached;
    const rec = await getChapter(bookId, i);
    if (!rec) throw new Error(`第 ${i + 1} 章正文缺失，请重新导入完整书籍`);
    const data: ChapterData = { index: i, title: rec.title, paragraphs: splitContentParagraphs(rec.content, rec.format), images: rec.images };
    if (activeRef.current && generation === generationRef.current) cacheRef.current.set(i, data);
    return data;
  }

  // ---------- 测量工具 ----------

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

  function paragraphHeight(chapter: number, para: number, offsets = getOffsets(chapter)) {
    return Math.max(
      1,
      para + 1 < offsets.length ? offsets[para + 1] - offsets[para] : paraElement(chapter, para)?.offsetHeight ?? 40,
    );
  }

  /** 找到视口顶部附近的锚点段落，用于前插章节后的滚动补偿 */
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

  /** 渲染后调用：按锚点段落补偿前插造成的位置偏移 */
  function applyAnchor() {
    const a = pendingAnchorRef.current;
    if (!a) return;
    pendingAnchorRef.current = null;
    const el = paraElement(a.chapter, a.para);
    if (el) {
      const delta = el.getBoundingClientRect().top - a.top;
      if (Math.abs(delta) > 0.5) scrollToY(getScrollTop() + delta);
    }
  }

  // ---------- 窗口滑动 ----------

  async function grow(dir: 'append' | 'prepend', i: number) {
    const generation = generationRef.current;
    const data = await loadChapter(i);
    if (!data || !activeRef.current || generation !== generationRef.current) return;
    // 前插未渲染内容可能改变高度，只在手指和惯性均停止后锚定。
    if (dir === 'prepend' && scrolling()) {
      waitForIdle();
      return;
    }
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
    const h = getViewportHeight();
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
    if (!activeRef.current || !canSync()) return;
    const count = getChapterCount();
    if (!count) return;
    const idxs = indicesRef.current;
    if (idxs.length === 0) return;
    const first = idxs[0];
    const last = idxs[idxs.length - 1];
    const firstSec = sectionEls.current.get(first);
    const lastSec = sectionEls.current.get(last);
    if (!firstSec || !lastSec) return;
    const viewTop = getScrollTop();
    const viewH = getViewportHeight();

    if (last < count - 1 && documentTop(lastSec) + lastSec.offsetHeight < viewTop + viewH * BUFFER_DOWN) {
      await grow('append', last + 1);
      return;
    }
    if (first > 0 && documentTop(firstSec) > viewTop - viewH * BUFFER_UP) {
      if (scrolling()) {
        waitForIdle();
        return;
      }
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
      void step()
        .catch(onError)
        .finally(() => {
          syncingRef.current = false;
          if (needSyncRef.current) {
            needSyncRef.current = false;
            scheduleSync();
          }
        });
    });
  }

  /** 直接设置窗口（初始化恢复用） */
  function setWindow(indices: number[]) {
    indicesRef.current = indices;
    forceRender();
  }

  /** 跳转到远处章节：重置窗口与占位，只保留目标附近 */
  function resetWindow(indices: number[]) {
    topSpaceRef.current = 0;
    bottomSpaceRef.current = 0;
    heightsRef.current.clear();
    for (const key of cacheRef.current.keys()) if (!indices.includes(key)) cacheRef.current.delete(key);
    offsetsRef.current.clear();
    pendingAnchorRef.current = null;
    indicesRef.current = indices;
    forceRender();
  }

  return {
    indicesRef,
    cacheRef,
    sectionEls,
    offsetsRef,
    topSpaceRef,
    bottomSpaceRef,
    pendingAnchorRef,
    generationRef,
    loadChapter,
    getOffsets,
    paraElement,
    paragraphHeight,
    captureAnchor,
    applyAnchor,
    scheduleSync,
    notifyScroll,
    waitForIdle,
    scrolling,
    setWindow,
    resetWindow,
    forceRender,
  };
}

export type ChapterWindow = ReturnType<typeof useChapterWindow>;
