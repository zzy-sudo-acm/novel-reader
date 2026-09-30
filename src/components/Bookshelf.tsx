import type { BookMeta } from '../types';
import { useMemo, useRef, useState } from 'react';
import '../bookshelf.css';

type ReadingStatus = 'unread' | 'reading' | 'finished';
type ShelfFilter = 'all' | ReadingStatus;
type ShelfSort = 'recent' | 'added' | 'title';

const FILTERS: { value: ShelfFilter; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'unread', label: '未读' },
  { value: 'reading', label: '在读' },
  { value: 'finished', label: '已读完' },
];
const STATUS_LABELS: Record<ReadingStatus, string> = {
  unread: '未读',
  reading: '在读',
  finished: '已读完',
};
const titleCollator = new Intl.Collator('zh-CN', { numeric: true, sensitivity: 'base' });

interface Props {
  books: BookMeta[];
  importing: { name: string; ratio: number; stage: string } | null;
  onImport: (file: File) => void;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
  onStatusChange: (id: string, status: 'reading' | 'finished') => void;
}

function progressPercent(book: BookMeta): string {
  const p = book.progress;
  if (!p || book.chapterCount === 0) return '0.0';
  // 用章节字数估算百分比
  let before = 0;
  for (let i = 0; i < Math.min(p.chapterIndex, book.toc.length); i++) before += book.toc[i].c;
  const entry = book.toc[p.chapterIndex];
  const inChapter = entry ? Math.min(1, (p.paragraphIndex + p.paragraphProgress) / Math.max(1, entry.p)) * entry.c : 0;
  return Math.min(100, ((before + inChapter) / Math.max(1, book.totalChars)) * 100).toFixed(1);
}

function readingStatus(book: BookMeta): ReadingStatus {
  return book.readingStatus ?? (book.progress ? 'reading' : 'unread');
}

function lastReadTime(book: BookMeta): number {
  // 旧书只有真正开始阅读后，进度更新时间才能作为最近阅读时间。
  return book.lastReadAt ?? (book.progress ? book.progressUpdatedAt ?? 0 : 0);
}

export default function Bookshelf({ books, importing, onImport, onOpen, onDelete, onStatusChange }: Props) {
  const fileRef = useRef<HTMLInputElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<ShelfFilter>('all');
  const [sort, setSort] = useState<ShelfSort>('recent');
  const searchTerm = query.trim().toLocaleLowerCase();
  const hasFilters = searchTerm.length > 0 || filter !== 'all';

  const library = useMemo(() => {
    const counts: Record<ShelfFilter, number> = { all: books.length, unread: 0, reading: 0, finished: 0 };
    const rows = books.map((book) => {
      const status = readingStatus(book);
      counts[status]++;
      return { book, status, percent: progressPercent(book), readAt: lastReadTime(book) };
    });
    const recent = rows
      .filter((row) => row.status === 'reading')
      .sort((a, b) => b.readAt - a.readAt || b.book.addedAt - a.book.addedAt)[0];
    return { rows, counts, recent };
  }, [books]);

  const visibleBooks = useMemo(() => {
    const result = library.rows.filter(({ book, status }) =>
      (filter === 'all' || status === filter) &&
      (!searchTerm || book.title.toLocaleLowerCase().includes(searchTerm)),
    );
    return result.sort((a, b) => {
      if (sort === 'title') {
        return titleCollator.compare(a.book.title, b.book.title) || b.book.addedAt - a.book.addedAt;
      }
      if (sort === 'added') return b.book.addedAt - a.book.addedAt;
      return b.readAt - a.readAt || b.book.addedAt - a.book.addedAt;
    });
  }, [library.rows, searchTerm, filter, sort]);

  function clearFilters() {
    setQuery('');
    setFilter('all');
    searchRef.current?.focus();
  }

  const recent = !hasFilters ? library.recent : undefined;
  const recentTitle = recent?.book.progress && recent.book.toc[recent.book.progress.chapterIndex]?.t;

  return (
    <div className="shelf shelf-managed">
      <header className="shelf-head">
        <h1>书架</h1>
        <button className="import-btn" disabled={!!importing} onClick={() => fileRef.current?.click()}>
          {importing ? '导入中…' : '导入小说'}
        </button>
        <input
          ref={fileRef}
          aria-label="选择小说 JSON 文件"
          type="file"
          accept=".json,application/json"
          style={{ display: 'none' }}
          disabled={!!importing}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onImport(f);
            e.target.value = '';
          }}
        />
      </header>

      {importing && (
        <div className="import-progress" role="status">
          <div className="import-name">{importing.name}</div>
          <div className="import-bar">
            <div className="import-bar-inner" style={{ width: `${importing.ratio * 100}%` }} />
          </div>
          <div className="import-stage">{importing.stage}</div>
        </div>
      )}

      {recent && (
        <section className="shelf-resume" aria-labelledby="resume-heading">
          <h2 id="resume-heading">接着读</h2>
          <button
            className="shelf-resume-open"
            disabled={!!importing}
            onClick={() => onOpen(recent.book.id)}
            aria-label={`继续阅读《${recent.book.title}》`}
          >
            <span className="shelf-resume-title">{recent.book.title}</span>
            <span className="shelf-resume-detail">
              {recentTitle ? `读到：${recentTitle}` : '从开头开始'}
            </span>
            <span className="shelf-resume-footer">
              <span>已读 {recent.percent}%</span>
              <span className="shelf-resume-cta">继续阅读 ›</span>
            </span>
          </button>
        </section>
      )}

      {books.length > 0 && (
        <section className="shelf-controls" aria-label="查找和整理书架">
          <div className="shelf-toolbar">
            <div className="shelf-search-field">
              <label htmlFor="shelf-search">搜索书名</label>
              <div className="shelf-search-box">
                <input
                  ref={searchRef}
                  id="shelf-search"
                  type="search"
                  placeholder="输入书名"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
                {query && (
                  <button
                    className="shelf-search-clear"
                    aria-label="清除书名搜索"
                    onClick={() => {
                      setQuery('');
                      searchRef.current?.focus();
                    }}
                  >
                    清除
                  </button>
                )}
              </div>
            </div>
            <div className="shelf-sort-field">
              <label htmlFor="shelf-sort">排序</label>
              <select id="shelf-sort" value={sort} onChange={(e) => setSort(e.target.value as ShelfSort)}>
                <option value="recent">最近阅读</option>
                <option value="added">最近导入</option>
                <option value="title">书名</option>
              </select>
            </div>
          </div>
          <div className="shelf-filters" role="group" aria-label="按阅读状态筛选">
            {FILTERS.map(({ value, label }) => (
              <button
                key={value}
                className="shelf-filter"
                aria-label={`${label}，${library.counts[value]} 本`}
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
              >
                <span>{label}</span>
                <span className="shelf-filter-count">{library.counts[value]}</span>
              </button>
            ))}
          </div>
          <div className="shelf-results">
            <p role="status">{hasFilters ? `找到 ${visibleBooks.length} 本` : `共 ${books.length} 本小说`}</p>
            {hasFilters && <button className="shelf-reset" onClick={clearFilters}>清除筛选</button>}
          </div>
        </section>
      )}

      {books.length === 0 && !importing && (
        <div className="shelf-empty">
          <p>书架还是空的</p>
          <p className="shelf-hint">点击右上角「导入小说」，选择本地的 book.json 文件</p>
        </div>
      )}

      {books.length > 0 && visibleBooks.length === 0 && (
        <div className="shelf-no-results">
          <p>{!searchTerm && filter !== 'all' ? `还没有${STATUS_LABELS[filter]}的小说` : '没有找到符合条件的小说'}</p>
          <p className="shelf-hint">换个书名，或清除筛选看看全部书籍。</p>
          <button className="shelf-empty-reset" onClick={clearFilters}>查看全部小说</button>
        </div>
      )}

      <ul className="book-list" aria-label="小说列表">
        {visibleBooks.map(({ book: b, status, percent }) => {
          const p = b.progress;
          const curTitle = p && b.toc[p.chapterIndex] ? b.toc[p.chapterIndex].t : null;
          return (
            <li className="book-item" key={b.id}>
              <button className="book-main" disabled={!!importing} onClick={() => onOpen(b.id)}>
                <div className="book-title">{b.title}</div>
                <div className="book-meta">
                  {STATUS_LABELS[status]} · 共 {b.chapterCount} 章{status !== 'finished' ? ` · 已读 ${percent}%` : ''}
                </div>
                {curTitle && <div className="book-cur">读到：{curTitle}</div>}
                <div className="book-cta">{status === 'finished' ? '再次阅读 ›' : p ? '继续阅读 ›' : '开始阅读 ›'}</div>
              </button>
              <div className="book-actions">
                <button
                  className="book-status"
                  disabled={!!importing}
                  aria-label={`将《${b.title}》${status === 'finished' ? '改为在读' : '标为已读完'}`}
                  onClick={() => onStatusChange(b.id, status === 'finished' ? 'reading' : 'finished')}
                >
                  {status === 'finished' ? '改为在读' : '标为已读完'}
                </button>
                <button
                  className="book-del"
                  disabled={!!importing}
                  aria-label={`删除《${b.title}》`}
                  onClick={() => {
                    if (window.confirm(`删除《${b.title}》？本地数据将被清除。`)) onDelete(b.id);
                  }}
                >
                  删除
                </button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
