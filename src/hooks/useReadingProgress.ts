import { useEffect, useRef, useState } from 'react';
import type { BookMeta, ReadingProgress } from '../types';
import { saveBookProgress } from '../db';
import { getScrollTop, getViewportHeight, scrollToY } from '../scroll';
import { documentTop, type ChapterWindow } from './useChapterWindow';

/** 进度测量参考线（视口比例） */
const READING_LINE = 0.33;

export interface RelocateTarget {
  chapter: number;
  para: number;
  /** 段落内高度比例（旧格式 fallback） */
  ratio: number;
  /** 段落内字符比例，存在时优先用于跨布局定位 */
  charProgress?: number;
}

function prefixSums(arr: number[]): number[] {
  const out = new Array<number>(arr.length + 1).fill(0);
  for (let i = 0; i < arr.length; i++) out[i + 1] = out[i] + arr[i];
  return out;
}

interface Options {
  bookId: string;
  bookRef: { current: BookMeta | null };
  cw: ChapterWindow;
  isMeasurementBlocked: () => boolean;
}

/**
 * 阅读进度：当前章节/段落判断、进度保存与恢复、改字号后的重新定位。
 * 进度同时记录高度比例（兼容旧数据）和字符比例（跨布局更稳定）。
 */
export function useReadingProgress({ bookId, bookRef, cw, isMeasurementBlocked }: Options) {
  const [current, setCurrent] = useState(0);
  const currentRef = useRef(0);
  const [percent, setPercent] = useState(0);
  const progressRef = useRef({ chapter: 0, para: 0, ratio: 0, charRatio: undefined as number | undefined });
  const pendingScrollRef = useRef<RelocateTarget | null>(null);
  const prefixCharsRef = useRef<number[]>([0]);
  const saveTimerRef = useRef(0);
  const initializedRef = useRef(false);

  // ---------- 当前章节与进度 ----------

  function updateCurrent() {
    if (!initializedRef.current || pendingScrollRef.current || isMeasurementBlocked()) return;
    const refY = getScrollTop() + getViewportHeight() * READING_LINE;
    const idxs = cw.indicesRef.current;
    if (idxs.length === 0) return;
    let cur = idxs[0];
    for (const i of idxs) {
      const sec = cw.sectionEls.current.get(i);
      if (sec && documentTop(sec) <= refY) cur = i;
      else break;
    }
    let para = 0;
    let ratio = 0;
    const offs = cw.getOffsets(cur);
    for (let k = offs.length - 1; k >= 0; k--) {
      if (offs[k] <= refY) {
        para = k;
        const h = cw.paragraphHeight(cur, k, offs);
        ratio = Math.min(1, Math.max(0, (refY - offs[k]) / (h || 40)));
        break;
      }
    }
    // 中文段落字符近似等宽均布，高度比例≈字符比例；恢复时会按新布局重新映射
    progressRef.current = { chapter: cur, para, ratio, charRatio: ratio };
    const b = bookRef.current;
    const entry = b?.toc[cur];
    if (b && entry) {
      const fraction = Math.min(1, (para + ratio) / Math.max(1, entry.p));
      const next = (((prefixCharsRef.current[cur] ?? 0) + fraction * entry.c) / Math.max(1, b.totalChars)) * 100;
      setPercent(Math.round(Math.min(100, next) * 10) / 10);
    }
    if (cur !== currentRef.current) {
      currentRef.current = cur;
      setCurrent(cur);
      scheduleSave();
    }
  }

  // ---------- 保存 ----------

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
      paragraphCharProgress: p.charRatio,
    });
  }

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'hidden') {
        updateCurrent();
        saveNow();
      }
    };
    const onPageHide = () => {
      updateCurrent();
      saveNow();
    };
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

  // ---------- 定位与恢复 ----------

  function scrollToProgress(t: RelocateTarget) {
    const sec = cw.sectionEls.current.get(t.chapter);
    if (!sec) return;
    const offs = cw.getOffsets(t.chapter);
    if (offs.length === 0) {
      scrollToY(documentTop(sec));
      return;
    }
    const p = Math.max(0, Math.min(t.para, offs.length - 1));
    const h = cw.paragraphHeight(t.chapter, p, offs);
    const yRatio = t.ratio * h;
    let yInPara = yRatio;
    const el = cw.paraElement(t.chapter, p);
    const text = cw.cacheRef.current.get(t.chapter)?.paragraphs[p] ?? '';
    if (el && text && t.charProgress != null) {
      // 字符级近似定位：总行数取实际渲染值，每行字符数由段落长度均摊，
      // 对字号/行距变化比高度比例更稳；布局未变时与高度比例一致（偏差小于一行），
      // 此时仍用精确的高度比例，保证刷新恢复像素级不变。
      const cs = getComputedStyle(el);
      const fontSize = parseFloat(cs.fontSize) || 18;
      const lineH = parseFloat(cs.lineHeight) || fontSize * 1.8;
      const totalLines = Math.max(1, Math.round(h / lineH));
      const charsPerLine = Math.max(1, Math.round(text.length / totalLines));
      const line = Math.min(totalLines - 1, Math.max(0, Math.floor((t.charProgress * text.length) / charsPerLine)));
      const yChar = line * lineH + lineH * 0.5;
      if (Math.abs(yChar - yRatio) > lineH) yInPara = yChar;
    }
    scrollToY(offs[p] + yInPara - getViewportHeight() * READING_LINE);
  }

  /** 渲染后调用：应用待处理的定位。目标章节尚未渲染时保留到下一帧。 */
  function applyPendingScroll(): boolean {
    const t = pendingScrollRef.current;
    if (!t) return false;
    const sec = cw.sectionEls.current.get(t.chapter);
    if (!sec) return false;
    pendingScrollRef.current = null;
    scrollToProgress(t);
    updateCurrent();
    return true;
  }

  /** 冻结当前位置作为重定位目标（设置变化、横竖屏切换前调用） */
  function freezeAnchor() {
    const p = progressRef.current;
    pendingScrollRef.current = { chapter: p.chapter, para: p.para, ratio: p.ratio, charProgress: p.charRatio };
  }

  /** 初始化：返回起始章节，并注册恢复到保存进度的定位请求 */
  function begin(book: BookMeta, saved: ReadingProgress): number {
    prefixCharsRef.current = prefixSums(book.toc.map((t) => t.c));
    const start = Math.max(0, Math.min(saved.chapterIndex, book.chapterCount - 1));
    progressRef.current = {
      chapter: start,
      para: saved.paragraphIndex,
      ratio: saved.paragraphProgress,
      charRatio: saved.paragraphCharProgress,
    };
    pendingScrollRef.current = {
      chapter: start,
      para: saved.paragraphIndex,
      ratio: saved.paragraphProgress,
      charProgress: saved.paragraphCharProgress,
    };
    currentRef.current = start;
    setCurrent(start);
    initializedRef.current = true;
    return start;
  }

  /** 目录、书签及搜索共用同一套段落定位，避免绕过进度恢复逻辑。 */
  function jumpSet(target: ReadingProgress) {
    pendingScrollRef.current = {
      chapter: target.chapterIndex,
      para: target.paragraphIndex,
      ratio: target.paragraphProgress,
      charProgress: target.paragraphCharProgress,
    };
    progressRef.current = {
      chapter: target.chapterIndex,
      para: target.paragraphIndex,
      ratio: target.paragraphProgress,
      charRatio: target.paragraphCharProgress,
    };
    currentRef.current = target.chapterIndex;
    setCurrent(target.chapterIndex);
    scheduleSave();
  }

  return {
    current,
    currentRef,
    percent,
    progressRef,
    pendingScrollRef,
    initializedRef,
    updateCurrent,
    scrollToProgress,
    applyPendingScroll,
    freezeAnchor,
    begin,
    jumpSet,
    scheduleSave,
    saveNow,
  };
}

export type ReadingProgressApi = ReturnType<typeof useReadingProgress>;
