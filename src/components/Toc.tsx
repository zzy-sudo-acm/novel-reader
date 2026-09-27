import { useEffect, useMemo, useRef, useState } from 'react';
import type { TocEntry } from '../types';

interface Props {
  toc: TocEntry[];
  current: number;
  onClose: () => void;
  onSelect: (index: number) => void;
}

const ROW_H = 44;
const OVERSCAN = 8;

/** 虚拟化目录：1418+ 章节也能流畅滚动 */
export default function Toc({ toc, current, onClose, onSelect }: Props) {
  const [q, setQ] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(600);

  const items = useMemo(() => {
    const all = toc.map((t, i) => ({ t: t.t, i }));
    const query = q.trim();
    if (!query) return all;
    return all.filter((x) => x.t.includes(query));
  }, [toc, q]);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    setViewH(el.clientHeight);
    // 打开时自动滚动到当前章节附近
    const pos = items.findIndex((x) => x.i === current);
    if (pos >= 0) el.scrollTop = Math.max(0, pos * ROW_H - el.clientHeight / 2);
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    return () => ro.disconnect();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const end = Math.min(items.length, Math.ceil((scrollTop + viewH) / ROW_H) + OVERSCAN);

  return (
    <div className="overlay">
      <div className="sheet toc-sheet">
        <div className="sheet-head">
          <input
            className="toc-search"
            placeholder="搜索章节标题"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <button className="bar-btn" onClick={onClose}>
            关闭
          </button>
        </div>
        <div
          className="toc-list"
          ref={listRef}
          onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
        >
          <div style={{ height: items.length * ROW_H, position: 'relative' }}>
            {items.slice(start, end).map((x, k) => {
              const row = start + k;
              return (
                <button
                  key={x.i}
                  className={`toc-row${x.i === current ? ' toc-current' : ''}`}
                  style={{ top: row * ROW_H, height: ROW_H }}
                  onClick={() => onSelect(x.i)}
                >
                  {x.t}
                </button>
              );
            })}
          </div>
          {items.length === 0 && <div className="toc-empty">没有匹配的章节</div>}
        </div>
      </div>
    </div>
  );
}
