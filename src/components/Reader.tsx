import React, { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import type { BookMeta } from '../types';
import { getBook, getChapter, readSavedProgress, saveBookProgress } from '../db';
import type { ReaderSettings } from '../settings';
import Toc from './Toc';
import SettingsSheet from './SettingsSheet';

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

/** 最多同时渲染的章节数（windowing） */
const KEEP = 6;
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

export default function Reader({ bookId, settings, onSettingsChange, onExit }: Props) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const bookRef = useRef<BookMeta | null>(null);
  const [book, setBook] = useState<BookMeta | null>(null);
  const [ready, setReady] = useState(false);
  const [renderTick, forceRender] = useReducer((x: number) => x + 1, 0);

  const indicesRef = useRef<number[]>([]);
  const cacheRef = useRef(new Map<number, ChapterData>());
  const sectionEls = useRef(new Map<number, HTMLElement>());
  /** 每章段落的绝对 offsetTop（相对内容容器） */
  const offsetsRef = useRef(new Map<number, number[]>());
  const pendingAnchorRef = useRef<{ chapter: number; para: number; top: number } | null>(null);
  const pendingScrollRef = useRef<{ chapter: number; para: number; ratio: number } | null>(null);
  const progressRef = useRef({ chapter: 0, para: 0, ratio: 0 });
  const prefixCharsRef = useRef<number[]>([0]);

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

  // ---------- 数据加载 ----------

  async function loadChapter(i: number): Promise<ChapterData | null> {
    const cached = cacheRef.current.get(i);
    if (cached) return cached;
    const rec = await getChapter(bookId, i);
    if (!rec) return null;
    const data: ChapterData = { index: i, title: rec.title, paragraphs: splitParagraphs(rec.content) };
    cacheRef.current.set(i, data);
    return data;
  }

  // ---------- 测量工具（offsetTop 均相对 .content 容器） ----------

  function getOffsets(idx: number): number[] {
    let o = offsetsRef.current.get(idx);
    if (!o) {
      const sec = sectionEls.current.get(idx);
      o = [];
      if (sec) {
        const paras = sec.querySelector('.paras');
        if (paras) {
          for (let k = 0; k < paras.children.length; k++) {
            o.push((paras.children[k] as HTMLElement).offsetTop);
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
    const s = scrollerRef.current;
    if (!s) return;
    const y = s.scrollTop;
    for (const idx of indicesRef.current) {
      const sec = sectionEls.current.get(idx);
      if (!sec) continue;
      if (sec.offsetTop + sec.offsetHeight <= y) continue;
      const offs = getOffsets(idx);
      let p = 0;
      for (let k = 0; k < offs.length; k++) {
        const h = k + 1 < offs.length ? offs[k + 1] - offs[k] : 40;
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

  function scrollToPara(chapter: number, para: number, ratio: number) {
    const s = scrollerRef.current;
    const sec = sectionEls.current.get(chapter);
    if (!s || !sec) return;
    const offs = getOffsets(chapter);
    if (offs.length === 0) {
      s.scrollTop = sec.offsetTop;
      return;
    }
    const p = Math.max(0, Math.min(para, offs.length - 1));
    const h = p + 1 < offs.length ? offs[p + 1] - offs[p] : 40;
    s.scrollTop = offs[p] + ratio * h - s.clientHeight * 0.2;
  }

  // ---------- 窗口滑动（核心） ----------

  async function grow(dir: 'append' | 'prepend', i: number) {
    const data = await loadChapter(i);
    if (!data) return;
    const idxs = indicesRef.current;
    if (dir === 'append') {
      if (idxs[idxs.length - 1] !== i - 1) return;
      indicesRef.current = [...idxs, i];
    } else {
      if (idxs[0] !== i + 1) return;
      captureAnchor();
      indicesRef.current = [i, ...idxs];
    }
    forceRender();
  }

  function trim() {
    const idxs = indicesRef.current;
    if (idxs.length <= KEEP) return;
    const cur = currentRef.current;
    const excess = idxs.length - KEEP;
    const cutAbove = Math.min(excess, idxs.filter((i) => i < cur - 1).length);
    const cutBelow = Math.min(excess - cutAbove, idxs.filter((i) => i > cur + 1).length);
    if (cutAbove <= 0 && cutBelow <= 0) return;
    if (cutAbove > 0) captureAnchor();
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
    const s = scrollerRef.current;
    const b = bookRef.current;
    if (!s || !b) return;
    const idxs = indicesRef.current;
    if (idxs.length === 0) return;
    const first = idxs[0];
    const last = idxs[idxs.length - 1];
    const firstSec = sectionEls.current.get(first);
    const lastSec = sectionEls.current.get(last);
    if (!firstSec || !lastSec) return;
    const viewTop = s.scrollTop;
    const viewH = s.clientHeight;

    if (last < b.chapterCount - 1 && lastSec.offsetTop + lastSec.offsetHeight < viewTop + viewH * BUFFER_DOWN) {
      await grow('append', last + 1);
      return;
    }
    if (first > 0 && firstSec.offsetTop > viewTop - viewH * BUFFER_UP) {
      await grow('prepend', first - 1);
      return;
    }
    trim();
  }

  function scheduleSync() {
    if (syncScheduledRef.current) return;
    syncScheduledRef.current = true;
    requestAnimationFrame(() => {
      syncScheduledRef.current = false;
      if (syncingRef.current) {
        needSyncRef.current = true;
        return;
      }
      syncingRef.current = true;
      void step().finally(() => {
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
    const s = scrollerRef.current;
    if (!s) return;
    const refY = s.scrollTop + s.clientHeight * 0.33;
    const idxs = indicesRef.current;
    let cur = idxs[0] ?? 0;
    for (const i of idxs) {
      const sec = sectionEls.current.get(i);
      if (sec && sec.offsetTop <= refY) cur = i;
      else break;
    }
    let para = 0;
    let ratio = 0;
    const offs = getOffsets(cur);
    for (let k = offs.length - 1; k >= 0; k--) {
      if (offs[k] <= refY) {
        para = k;
        const h = k + 1 < offs.length ? offs[k + 1] - offs[k] : 40;
        ratio = Math.min(1, Math.max(0, (refY - offs[k]) / (h || 40)));
        break;
      }
    }
    progressRef.current = { chapter: cur, para, ratio };
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
    if (!b) return;
    const p = progressRef.current;
    void saveBookProgress(b.id, {
      chapterIndex: p.chapter,
      paragraphIndex: p.para,
      paragraphProgress: p.ratio,
    });
  }

  // ---------- 渲染后：应用待处理的滚动补偿 / 定位 ----------

  useLayoutEffect(() => {
    const s = scrollerRef.current;
    if (!s) return;

    if (prevSettingsRef.current !== settings) {
      prevSettingsRef.current = settings;
      offsetsRef.current.clear();
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
        if (Math.abs(delta) > 0.5) s.scrollTop += delta;
      }
    }
    scheduleSync();
  });

  // ---------- 初始化：加载书籍并恢复进度 ----------

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const b = await getBook(bookId);
      if (!b || cancelled) return;
      bookRef.current = b;
      setBook(b);
      prefixCharsRef.current = prefixSums(b.toc.map((t) => t.c));
      const saved = await readSavedProgress(b);
      const start = Math.max(0, Math.min(saved.chapterIndex, b.chapterCount - 1));
      const lo = Math.max(0, start - 1);
      const hi = Math.min(b.chapterCount - 1, start + 2);
      const arr: number[] = [];
      for (let i = lo; i <= hi; i++) {
        await loadChapter(i);
        arr.push(i);
      }
      if (cancelled) return;
      indicesRef.current = arr;
      currentRef.current = start;
      setCurrent(start);
      progressRef.current = { chapter: start, para: saved.paragraphIndex, ratio: saved.paragraphProgress };
      pendingScrollRef.current = { chapter: start, para: saved.paragraphIndex, ratio: saved.paragraphProgress };
      setReady(true);
      forceRender();
      // 首次进入时控制栏默认可见，并短暂提示操作方式
      setBarsVisible(true);
      setShowHint(true);
      window.setTimeout(() => {
        setShowHint(false);
        setBarsVisible(false);
      }, 4000);
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId]);

  // ---------- 事件：滚动 / 保存 / 横竖屏 ----------

  useEffect(() => {
    const onVis = () => {
      if (document.visibilityState === 'hidden') saveNow();
    };
    const onPageHide = () => saveNow();
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

  useEffect(() => {
    const s = scrollerRef.current;
    if (!s || !ready) return;
    let w = s.clientWidth;
    let timer = 0;
    const ro = new ResizeObserver(() => {
      if (s.clientWidth === w) return;
      w = s.clientWidth;
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        offsetsRef.current.clear();
        const p = progressRef.current;
        pendingScrollRef.current = { chapter: p.chapter, para: p.para, ratio: p.ratio };
        forceRender();
      }, 150);
    });
    ro.observe(s);
    return () => {
      ro.disconnect();
      window.clearTimeout(timer);
    };
  }, [ready]);

  function onScroll() {
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
    const target = Math.max(0, Math.min(i, b.chapterCount - 1));
    const lo = Math.max(0, target - 1);
    const hi = Math.min(b.chapterCount - 1, target + 2);
    const arr: number[] = [];
    for (let k = lo; k <= hi; k++) {
      await loadChapter(k);
      arr.push(k);
    }
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
    saveNow();
    onExit();
  }

  // ---------- 渲染 ----------

  const b = book;
  const totalChars = b?.totalChars ?? 1;
  const prefix = prefixCharsRef.current;
  const curEntry = b?.toc[current];
  const chapterChars = curEntry?.c ?? 1;
  const chapterParas = Math.max(1, curEntry?.p ?? 1);
  const inChapter = Math.min(1, (progressRef.current.para + progressRef.current.ratio) / chapterParas);
  const percent = b ? Math.min(100, ((prefix[current] ?? 0) + inChapter * chapterChars) / totalChars * 100) : 0;

  return (
    <div
      className="reader"
      data-theme={settings.theme}
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
      <div
        className="scroller"
        ref={scrollerRef}
        onScroll={onScroll}
        onClick={() => {
          if (overlay === 'none') setBarsVisible((v) => !v);
        }}
      >
        <div className="content">
          {ready &&
            indicesRef.current.map((i) => {
              const ch = cacheRef.current.get(i);
              if (!ch) return null;
              return (
                <section
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
          {ready && indicesRef.current.length > 0 && b && indicesRef.current[indicesRef.current.length - 1] >= b.chapterCount - 1 && (
            <div className="book-end">全书完</div>
          )}
        </div>
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

      {!ready && <div className="loading">加载中…</div>}

      {ready && showHint && overlay === 'none' && (
        <div className="tap-hint">轻点屏幕中央可显示 / 隐藏菜单（目录、设置）</div>
      )}
    </div>
  );
}
