import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { BookMeta } from '../types';
import { getBook, readSavedProgress } from '../db';
import type { ReaderSettings } from '../settings';
import Toc from './Toc';
import SettingsSheet from './SettingsSheet';
import { useChapterWindow } from '../hooks/useChapterWindow';
import { useReadingProgress } from '../hooks/useReadingProgress';
import { useReaderGestures } from '../hooks/useReaderGestures';
import { useReaderViewport } from '../hooks/useReaderViewport';

interface Props {
  bookId: string;
  settings: ReaderSettings;
  onSettingsChange: (s: ReaderSettings) => void;
  onExit: () => void;
}

/**
 * 阅读器：组合章节窗口、阅读进度、手势、视口四个 hook。
 * 本文件只负责初始化编排、渲染后的事件编排和 JSX。
 */
export default function Reader({ bookId, settings, onSettingsChange, onExit }: Props) {
  const bookRef = useRef<BookMeta | null>(null);
  const [book, setBook] = useState<BookMeta | null>(null);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [barsVisible, setBarsVisible] = useState(true);
  const [showHint, setShowHint] = useState(false);
  const [overlay, setOverlay] = useState<'none' | 'toc' | 'settings'>('none');
  const overlayRef = useRef<'none' | 'toc' | 'settings'>('none');
  const errorRef = useRef(false);
  const activeRef = useRef(false);
  const hintTimerRef = useRef(0);
  const rafRef = useRef(0);
  const prevSettingsRef = useRef(settings);

  function fail(e: unknown) {
    if (!activeRef.current) return;
    errorRef.current = true;
    setError(e instanceof Error ? e.message : '章节加载失败，请返回书架后重试');
  }

  const cw = useChapterWindow({
    bookId,
    activeRef,
    getChapterCount: () => bookRef.current?.chapterCount ?? 0,
    // prog 在下方创建；canSync 只在运行时被调用，不存在初始化时序问题
    canSync: () =>
      prog.initializedRef.current &&
      !errorRef.current &&
      overlayRef.current === 'none' &&
      !prog.pendingScrollRef.current,
    onError: fail,
  });

  const prog = useReadingProgress({ bookId, bookRef, cw });

  // ---------- 渲染后：应用待处理的定位 / 滚动补偿，然后继续窗口同步 ----------

  useLayoutEffect(() => {
    overlayRef.current = overlay;
    // 字体、窗口结构变化都会改变坐标。只缓存当前这次布局。
    cw.offsetsRef.current.clear();
    const previous = prevSettingsRef.current;
    prevSettingsRef.current = settings;
    if (
      previous.fontSize !== settings.fontSize ||
      previous.lineHeight !== settings.lineHeight ||
      previous.margin !== settings.margin ||
      previous.fontFamily !== settings.fontFamily
    ) {
      if (bookRef.current && !prog.pendingScrollRef.current) prog.freezeAnchor();
    }

    if (!prog.applyPendingScroll()) cw.applyAnchor();
    if (prog.initializedRef.current) prog.updateCurrent();
    cw.scheduleSync();
  });

  // ---------- 初始化：加载书籍并恢复进度 ----------

  useEffect(() => {
    let cancelled = false;
    activeRef.current = true;
    const generation = ++cw.generationRef.current;
    (async () => {
      const b = await getBook(bookId);
      if (cancelled) return;
      if (!b) throw new Error('书籍不存在，请返回书架重新导入');
      bookRef.current = b;
      setBook(b);
      const saved = await readSavedProgress(b);
      const start = prog.begin(b, saved);
      const lo = Math.max(0, start - 1);
      const hi = Math.min(b.chapterCount - 1, start + 2);
      const arr = Array.from({ length: hi - lo + 1 }, (_, i) => lo + i);
      await Promise.all(arr.map(cw.loadChapter));
      if (cancelled || generation !== cw.generationRef.current) return;
      cw.setWindow(arr);
      setReady(true);
      // 首次进入时控制栏默认可见，并短暂提示操作方式
      setBarsVisible(true);
      setShowHint(true);
      hintTimerRef.current = window.setTimeout(() => {
        setShowHint(false);
        setBarsVisible(false);
      }, 4000);
    })().catch((e) => {
      if (!cancelled) fail(e);
    });
    return () => {
      cancelled = true;
      activeRef.current = false;
      cw.generationRef.current++;
      window.clearTimeout(hintTimerRef.current);
      cancelAnimationFrame(rafRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bookId]);

  // ---------- 滚动 / 视口 / 手势 ----------

  useEffect(() => {
    const h = () => onScroll();
    window.addEventListener('scroll', h, { passive: true });
    return () => window.removeEventListener('scroll', h);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onScroll() {
    cw.notifyScroll();
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      prog.updateCurrent();
      cw.scheduleSync();
      prog.scheduleSave();
    });
  }

  useReaderViewport(ready, {
    // 先冻结锚点，避免 resize 之后的 scroll 事件把旧进度替换掉
    onWidthChange: () => prog.freezeAnchor(),
    onSettled: () => {
      cw.offsetsRef.current.clear();
      prog.freezeAnchor();
      cw.forceRender();
    },
  });

  const gestureHandlers = useReaderGestures({
    onTap: () => {
      window.clearTimeout(hintTimerRef.current);
      setShowHint(false);
      setBarsVisible((v) => !v);
    },
    isBlocked: () => overlay !== 'none',
    isScrolling: cw.scrolling,
    onRelease: cw.waitForIdle,
  });

  // ---------- 跳转 ----------

  async function jumpTo(i: number) {
    const b = bookRef.current;
    if (!b) return;
    setOverlay('none');
    const generation = ++cw.generationRef.current;
    errorRef.current = false;
    setError(null);
    const target = Math.max(0, Math.min(i, b.chapterCount - 1));
    const lo = Math.max(0, target - 1);
    const hi = Math.min(b.chapterCount - 1, target + 2);
    const arr = Array.from({ length: hi - lo + 1 }, (_, k) => lo + k);
    try {
      await Promise.all(arr.map(cw.loadChapter));
    } catch (e) {
      fail(e);
      return;
    }
    if (!activeRef.current || generation !== cw.generationRef.current) return;
    cw.resetWindow(arr);
    prog.jumpSet(target);
  }

  function handleBack() {
    prog.updateCurrent();
    prog.saveNow();
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
      <button className="reader-menu-access" onClick={() => setBarsVisible(true)}>
        显示阅读菜单
      </button>
      <div className="content" {...gestureHandlers}>
        <div aria-hidden="true" style={{ height: cw.topSpaceRef.current }} />
        {ready &&
          cw.indicesRef.current.map((i) => {
            const ch = cw.cacheRef.current.get(i);
            if (!ch) return null;
            return (
              <section
                className="chapter"
                key={i}
                data-idx={i}
                ref={(el) => {
                  if (el) cw.sectionEls.current.set(i, el);
                  else cw.sectionEls.current.delete(i);
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
        <div aria-hidden="true" style={{ height: cw.bottomSpaceRef.current }} />
        {ready && cw.indicesRef.current.length > 0 && b && cw.indicesRef.current[cw.indicesRef.current.length - 1] >= b.chapterCount - 1 && (
          <div className="book-end">全书完</div>
        )}
      </div>

      {barsVisible && overlay === 'none' && (
        <>
          <div className="bar top-bar">
            <button className="bar-btn" onClick={handleBack}>
              ‹ 书架
            </button>
            <div className="bar-title">{b?.toc[prog.current]?.t ?? b?.title ?? ''}</div>
            <div className="bar-pct">{prog.percent.toFixed(1)}%</div>
          </div>
          <div className="bar bottom-bar">
            <button className="bar-btn" onClick={() => setOverlay('toc')}>
              目录
            </button>
            <div className="bar-sub">
              {prog.current + 1}/{b?.chapterCount ?? 0}
            </div>
            <button className="bar-btn" onClick={() => setOverlay('settings')}>
              设置
            </button>
          </div>
        </>
      )}

      {overlay === 'toc' && b && (
        <Toc toc={b.toc} current={prog.current} onClose={() => setOverlay('none')} onSelect={jumpTo} />
      )}
      {overlay === 'settings' && (
        <SettingsSheet settings={settings} onChange={onSettingsChange} onClose={() => setOverlay('none')} />
      )}

      {error && (
        <div className="reader-error" role="alert">
          <p>{error}</p>
          <button className="bar-btn" onClick={handleBack}>
            返回书架
          </button>
        </div>
      )}
      {!ready && !error && <div className="loading">加载中…</div>}

      {ready && showHint && overlay === 'none' && (
        <div className="tap-hint">轻点屏幕中央可显示 / 隐藏菜单（目录、设置）</div>
      )}
    </div>
  );
}
