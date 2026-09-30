import { useEffect, useRef, useState } from 'react';
import { addBookmark, deleteBookmark, getBookmarks } from '../db';
import type { Bookmark, ReadingProgress } from '../types';
import Sheet from './Sheet';
import './reading-tools.css';

interface Props {
  bookId: string;
  current: ReadingProgress;
  currentExcerpt: string;
  onClose: () => void;
  onSelect: (progress: ReadingProgress) => void;
}

const dateFormatter = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });

export default function BookmarksSheet({ bookId, current, currentExcerpt, onClose, onSelect }: Props) {
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [actionError, setActionError] = useState('');
  const [notice, setNotice] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const activeRef = useRef(true);

  useEffect(() => {
    activeRef.current = true;
    return () => { activeRef.current = false; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError('');
    getBookmarks(bookId)
      .then((items) => {
        if (!cancelled) setBookmarks(items.sort((a, b) => b.createdAt - a.createdAt));
      })
      .catch(() => {
        if (!cancelled) setLoadError('书签读取失败，请重试。');
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [bookId, retry]);

  const alreadyAdded = bookmarks.some((bookmark) => !bookmark.unavailable &&
    bookmark.progress.chapterIndex === current.chapterIndex && bookmark.progress.paragraphIndex === current.paragraphIndex);

  async function addCurrent() {
    if (busy || loading || loadError || alreadyAdded || !currentExcerpt.trim()) return;
    setBusy('add');
    setActionError('');
    setNotice('');
    try {
      const bookmark = await addBookmark(bookId, current, currentExcerpt);
      if (!activeRef.current) return;
      setBookmarks((items) => [bookmark, ...items.filter((item) => item.id !== bookmark.id)]);
      setNotice('当前位置已加入书签。');
    } catch {
      if (activeRef.current) setActionError('书签保存失败，请再次添加。');
    } finally {
      if (activeRef.current) setBusy(null);
    }
  }

  async function removeBookmark(bookmark: Bookmark) {
    if (busy) return;
    setBusy(bookmark.id);
    setActionError('');
    setNotice('');
    try {
      await deleteBookmark(bookmark.id);
      if (!activeRef.current) return;
      setBookmarks((items) => items.filter((item) => item.id !== bookmark.id));
      setNotice('书签已删除。');
    } catch {
      if (activeRef.current) setActionError('书签删除失败，请重试。');
    } finally {
      if (activeRef.current) setBusy(null);
    }
  }

  return <Sheet label="书签" className="reading-tools-sheet bookmarks-sheet" onClose={onClose}>
    <div className="sheet-head">
      <h2 className="reading-tools-title">书签</h2>
      <button className="bar-btn" onClick={onClose}>关闭</button>
    </div>
    <div className="bookmark-current">
      <div className="bookmark-current-heading">
        <span>当前位置</span>
        <span className="reading-tools-meta">第 {current.chapterIndex + 1} 章 · 第 {current.paragraphIndex + 1} 段</span>
      </div>
      <p className="bookmark-current-excerpt">{currentExcerpt || '当前位置暂无正文'}</p>
      <button
        className="reading-tools-primary"
        disabled={loading || !!loadError || busy !== null || alreadyAdded || !currentExcerpt.trim()}
        onClick={() => { void addCurrent(); }}
      >{busy === 'add' ? '正在添加…' : alreadyAdded ? '当前位置已添加' : '添加当前位置'}</button>
    </div>
    <div className="reading-tools-feedback" aria-live="polite">
      {actionError ? <p role="alert">{actionError}</p> : notice ? <p>{notice}</p> : null}
    </div>
    <div className="reading-tools-list" aria-busy={loading}>
      {loading ? <div className="reading-tools-empty" role="status">正在读取书签…</div> : loadError ?
        <div className="reading-tools-empty"><p role="alert">{loadError}</p><button className="reading-tools-secondary" onClick={() => setRetry((value) => value + 1)}>重新读取</button></div> :
        bookmarks.length === 0 ? <div className="reading-tools-empty"><p>还没有书签</p><p className="reading-tools-meta">把喜欢的段落记下来，下次一键回到这里。</p></div> :
        <ul className="bookmark-list" aria-label="已保存的书签">
          {bookmarks.map((bookmark) => <li className="bookmark-item" key={bookmark.id}>
            <button className="bookmark-select" disabled={bookmark.unavailable} onClick={() => onSelect(bookmark.progress)}>
              <span className="reading-tools-row-title">{bookmark.chapterTitle}</span>
              <span className="reading-tools-meta">第 {bookmark.progress.paragraphIndex + 1} 段 · {dateFormatter.format(bookmark.createdAt)}</span>
              <span className="reading-tools-excerpt">{bookmark.excerpt}</span>
              {bookmark.unavailable ? <span className="bookmark-unavailable">书籍更新后已无法匹配章节，暂时不能跳转。</span> : null}
            </button>
            <button
              className="bookmark-remove"
              aria-label={`删除书签：${bookmark.chapterTitle}，第 ${bookmark.progress.paragraphIndex + 1} 段`}
              disabled={busy !== null}
              onClick={() => { void removeBookmark(bookmark); }}
            >{busy === bookmark.id ? '删除中…' : '删除书签'}</button>
          </li>)}
        </ul>}
    </div>
  </Sheet>;
}
