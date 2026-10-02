import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { BookMeta, ReadingProgress } from '../types';
import { getBook, markBookOpened, readSavedProgress } from '../db';
import { findLiteralMatch, type SearchMatch } from '../search';
import type { ReaderSettings } from '../settings';
import Toc from './Toc';
import SettingsSheet from './SettingsSheet';
import BookmarksSheet from './BookmarksSheet';
import SearchSheet from './SearchSheet';
import { useChapterWindow } from '../hooks/useChapterWindow';
import { useReadingProgress } from '../hooks/useReadingProgress';
import { useReaderGestures } from '../hooks/useReaderGestures';
import { useReaderViewport } from '../hooks/useReaderViewport';
import { useScrollTopRecovery } from '../hooks/useScrollTopRecovery';

interface Props {
  bookId: string;
  settings: ReaderSettings;
  onSettingsChange: (s: ReaderSettings) => void;
  onExit: () => void;
}

type Overlay = 'none' | 'toc' | 'settings' | 'bookmarks' | 'search';
interface SearchHighlight { chapter: number; paragraph: number; query: string }

// 只生成文本节点和 mark，不把小说内容当作 HTML 执行。
function highlightText(text: string, query: string): React.ReactNode {
  const match = findLiteralMatch(text, query);
  if (!match) return text;
  return <>{text.slice(0, match.offset)}<mark>{text.slice(match.offset, match.offset + match.length)}</mark>{text.slice(match.offset + match.length)}</>;
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
  const [overlay, setOverlay] = useState<Overlay>('none');
  const overlayRef = useRef<Overlay>('none');
  const [bookmarkPosition, setBookmarkPosition] = useState<ReadingProgress | null>(null);
  const panelOriginRef = useRef<ReadingProgress | null>(null);
  const [returnLocations, setReturnLocations] = useState<ReadingProgress[]>([]);
  const [highlight, setHighlight] = useState<SearchHighlight | null>(null);
  const [jumping, setJumping] = useState(false);
  const jumpingRef = useRef(false);
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
      !jumpingRef.current &&
      overlayRef.current === 'none' &&
      !prog.pendingScrollRef.current,
    onError: fail,
  });

  const prog = useReadingProgress({ bookId, bookRef, cw, isMeasurementBlocked: () => overlayRef.current !== 'none' });
  const recovery = useScrollTopRecovery({
    getPosition: () => {
      const p = prog.progressRef.current;
      return { chapterIndex: p.chapter, paragraphIndex: p.para, paragraphProgress: p.ratio, paragraphCharProgress: p.charRatio };
    },
    isBlocked: () => !prog.initializedRef.current || jumpingRef.current || errorRef.current || overlayRef.current !== 'none' || !!prog.pendingScrollRef.current,
    onRecoverable: (position) => {
      setReturnLocations((locations) => [...locations.slice(-9), position]);
      window.clearTimeout(hintTimerRef.current);
      setShowHint(false);
      setBarsVisible(true);
    },
  });

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
    recovery.syncPosition();
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
      void markBookOpened(bookId).catch(() => {
        // 最近阅读记录失败不阻断已加载的正文。
      });
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
    recovery.onScroll();
    cw.notifyScroll();
    if (rafRef.current) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0;
      prog.updateCurrent();
      recovery.syncPosition();
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

  function snapshotPosition(): ReadingProgress {
    prog.updateCurrent();
    const p = prog.progressRef.current;
    return {
      chapterIndex: p.chapter,
      paragraphIndex: p.para,
      paragraphProgress: p.ratio,
      paragraphCharProgress: p.charRatio,
    };
  }

  function openPanel(panel: Exclude<Overlay, 'none'>) {
    window.clearTimeout(hintTimerRef.current);
    setShowHint(false);
    const position = snapshotPosition();
    panelOriginRef.current = position;
    if (panel === 'bookmarks') setBookmarkPosition(position);
    setOverlay(panel);
  }

  async function jumpTo(
    position: ReadingProgress,
    searchHighlight: SearchHighlight | null = null,
    returning = false,
  ) {
    const b = bookRef.current;
    if (!b) return;
    // 手机搜索键盘改变可见高度；返回位置始终取打开面板之前的正文锚点。
    const origin = overlayRef.current !== 'none' && panelOriginRef.current ? { ...panelOriginRef.current } : snapshotPosition();
    const generation = ++cw.generationRef.current;
    jumpingRef.current = true;
    setJumping(true);
    errorRef.current = false;
    setError(null);
    const target = Math.max(0, Math.min(position.chapterIndex, b.chapterCount - 1));
    const lo = Math.max(0, target - 1);
    const hi = Math.min(b.chapterCount - 1, target + 2);
    const arr = Array.from({ length: hi - lo + 1 }, (_, k) => lo + k);
    try {
      await Promise.all(arr.map(cw.loadChapter));
    } catch (e) {
      if (generation === cw.generationRef.current) {
        jumpingRef.current = false;
        setJumping(false);
        setOverlay('none');
        fail(e);
      }
      return;
    }
    if (!activeRef.current || generation !== cw.generationRef.current) return;
    const paragraphs = cw.cacheRef.current.get(target)?.paragraphs.length ?? 1;
    const destination = { ...position, chapterIndex: target, paragraphIndex: Math.max(0, Math.min(position.paragraphIndex, paragraphs - 1)) };
    // 弹层关闭、窗口替换和段落定位在同一轮渲染完成，保持原生滚动锚点。
    setOverlay('none');
    cw.resetWindow(arr);
    prog.jumpSet(destination);
    setHighlight(searchHighlight);
    setReturnLocations((locations) => returning ? locations.slice(0, -1) : [...locations.slice(-9), origin]);
    jumpingRef.current = false;
    setJumping(false);
    setBarsVisible(true);
  }

  function jumpToSearch(match: SearchMatch, query: string) {
    const fraction = match.matchOffset / Math.max(1, match.paragraphLength);
    void jumpTo({
      chapterIndex: match.chapterIndex,
      paragraphIndex: match.paragraphIndex,
      paragraphProgress: fraction,
      paragraphCharProgress: fraction,
    }, { chapter: match.chapterIndex, paragraph: match.paragraphIndex, query });
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
                    <p key={k} data-paragraph={k}>
                      {highlight?.chapter === i && highlight.paragraph === k ? highlightText(t, highlight.query) : t}
                    </p>
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
            <div className="bar-title">
              <span>{b?.toc[prog.current]?.t ?? b?.title ?? ''}</span>
              {b && <small className="bar-chapter-number">{prog.current + 1}/{b.chapterCount} 章</small>}
            </div>
            <div className="bar-pct">{prog.percent.toFixed(1)}%</div>
          </div>
          <div className="bar bottom-bar">
            <button className="bar-btn" disabled={!ready || jumping} onClick={() => openPanel('toc')}>
              目录
            </button>
            <button className="bar-btn" disabled={!ready || jumping} onClick={() => openPanel('bookmarks')}>
              书签
            </button>
            <button className="bar-btn" disabled={!ready || jumping} onClick={() => openPanel('search')}>
              搜索
            </button>
            <button className="bar-btn" disabled={!ready || jumping} onClick={() => openPanel('settings')}>
              设置
            </button>
          </div>
          {returnLocations.length > 0 && (
            <button className="return-position" disabled={jumping} onClick={() => void jumpTo(returnLocations[returnLocations.length - 1], null, true)}>
              返回原阅读位置
            </button>
          )}
        </>
      )}

      {overlay === 'toc' && b && (
        <Toc toc={b.toc} current={prog.current} onClose={() => setOverlay('none')} onSelect={(chapterIndex) => void jumpTo({ chapterIndex, paragraphIndex: 0, paragraphProgress: 0 })} />
      )}
      {overlay === 'settings' && (
        <SettingsSheet settings={settings} onChange={onSettingsChange} onClose={() => setOverlay('none')} />
      )}
      {overlay === 'bookmarks' && bookmarkPosition && (
        <BookmarksSheet
          bookId={bookId}
          current={bookmarkPosition}
          currentExcerpt={cw.cacheRef.current.get(bookmarkPosition.chapterIndex)?.paragraphs[bookmarkPosition.paragraphIndex] ?? ''}
          onClose={() => setOverlay('none')}
          onSelect={(position) => void jumpTo(position)}
        />
      )}
      {overlay === 'search' && b && (
        <SearchSheet bookId={bookId} chapterCount={b.chapterCount} onClose={() => setOverlay('none')} onSelect={jumpToSearch} />
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
        <div className="tap-hint">轻点屏幕中央可显示 / 隐藏阅读菜单</div>
      )}
    </div>
  );
}
