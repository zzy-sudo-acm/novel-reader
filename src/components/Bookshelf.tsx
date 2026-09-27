import type { BookMeta } from '../types';

interface Props {
  books: BookMeta[];
  importing: { name: string; ratio: number; stage: string } | null;
  onImport: (file: File) => void;
  onOpen: (id: string) => void;
  onDelete: (id: string) => void;
}

function progressPercent(book: BookMeta): string {
  const p = book.progress;
  if (!p || book.chapterCount === 0) return '0.0';
  // 用章节字数估算百分比
  let before = 0;
  for (let i = 0; i < Math.min(p.chapterIndex, book.toc.length); i++) before += book.toc[i].c;
  const entry = book.toc[p.chapterIndex];
  const inChapter = entry ? Math.min(1, p.paragraphIndex / Math.max(1, entry.p)) * entry.c : 0;
  return Math.min(100, ((before + inChapter) / Math.max(1, book.totalChars)) * 100).toFixed(1);
}

export default function Bookshelf({ books, importing, onImport, onOpen, onDelete }: Props) {
  return (
    <div className="shelf">
      <header className="shelf-head">
        <h1>书架</h1>
        <label className={`import-btn${importing ? ' disabled' : ''}`}>
          {importing ? '导入中…' : '导入小说'}
          <input
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
        </label>
      </header>

      {importing && (
        <div className="import-progress">
          <div className="import-name">{importing.name}</div>
          <div className="import-bar">
            <div className="import-bar-inner" style={{ width: `${importing.ratio * 100}%` }} />
          </div>
          <div className="import-stage">{importing.stage}</div>
        </div>
      )}

      {books.length === 0 && !importing && (
        <div className="shelf-empty">
          <p>书架还是空的</p>
          <p className="shelf-hint">点击右上角「导入小说」，选择本地的 book.json 文件</p>
        </div>
      )}

      <ul className="book-list">
        {books.map((b) => {
          const p = b.progress;
          const curTitle = p && b.toc[p.chapterIndex] ? b.toc[p.chapterIndex].t : null;
          return (
            <li className="book-item" key={b.id}>
              <button className="book-main" onClick={() => onOpen(b.id)}>
                <div className="book-title">{b.title}</div>
                <div className="book-meta">
                  共 {b.chapterCount} 章 · 已读 {progressPercent(b)}%
                </div>
                {curTitle && <div className="book-cur">读到：{curTitle}</div>}
                <div className="book-cta">{p ? '继续阅读 ›' : '开始阅读 ›'}</div>
              </button>
              <button
                className="book-del"
                onClick={() => {
                  if (window.confirm(`删除《${b.title}》？本地数据将被清除。`)) onDelete(b.id);
                }}
              >
                删除
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
