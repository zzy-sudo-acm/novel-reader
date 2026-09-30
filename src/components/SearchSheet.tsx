import { useEffect, useRef, useState } from 'react';
import { findLiteralMatch, SEARCH_RESULT_LIMIT, type SearchMatch, type SearchWorkerResponse } from '../search';
import Sheet from './Sheet';
import './reading-tools.css';

interface Props {
  bookId: string;
  chapterCount: number;
  onClose: () => void;
  onSelect: (match: SearchMatch, query: string) => void;
}

interface SearchState {
  query: string;
  status: 'idle' | 'waiting' | 'scanning' | 'done' | 'error';
  matches: SearchMatch[];
  totalMatches: number;
  scannedChapters: number;
  error: string;
}

const EMPTY_STATE: SearchState = { query: '', status: 'idle', matches: [], totalMatches: 0, scannedChapters: 0, error: '' };
const RESULT_BATCH = 40;

function Excerpt({ match, query }: { match: SearchMatch; query: string }) {
  const hit = findLiteralMatch(match.excerpt, query);
  return <span className="reading-tools-excerpt">
    {match.excerptOffset > 0 ? '…' : ''}
    {hit ? <>{match.excerpt.slice(0, hit.offset)}<mark>{match.excerpt.slice(hit.offset, hit.offset + hit.length)}</mark>{match.excerpt.slice(hit.offset + hit.length)}</> : match.excerpt}
    {match.excerptOffset + match.excerpt.length < match.paragraphLength ? '…' : ''}
  </span>;
}

export default function SearchSheet({ bookId, chapterCount, onClose, onSelect }: Props) {
  const [input, setInput] = useState('');
  const [composing, setComposing] = useState(false);
  const [state, setState] = useState<SearchState>(EMPTY_STATE);
  const [retry, setRetry] = useState(0);
  const [visibleCount, setVisibleCount] = useState(RESULT_BATCH);
  const requestRef = useRef(0);
  const listRef = useRef<HTMLDivElement>(null);
  const query = input.trim();

  useEffect(() => {
    const requestId = ++requestRef.current;
    setVisibleCount(RESULT_BATCH);
    if (listRef.current) listRef.current.scrollTop = 0;
    if (!query || composing) {
      setState({ ...EMPTY_STATE, query });
      return;
    }
    setState({ ...EMPTY_STATE, query, status: 'waiting' });
    let worker: Worker | null = null;
    let active = true;
    const failure = (message: string) => {
      if (!active || requestRef.current !== requestId) return;
      setState({ ...EMPTY_STATE, query, status: 'error', error: message });
      worker?.terminate();
    };
    const timer = window.setTimeout(() => {
      if (!active) return;
      try {
        worker = new Worker(new URL('../search.worker.ts', import.meta.url), { type: 'module' });
        worker.onmessage = (event: MessageEvent<SearchWorkerResponse>) => {
          const result = event.data;
          if (!active || requestRef.current !== requestId || result.requestId !== requestId) return;
          if (result.type === 'error') { failure(result.message); return; }
          if (result.type === 'progress') {
            setState({ ...EMPTY_STATE, query, status: 'scanning', scannedChapters: result.scannedChapters, totalMatches: result.totalMatches });
          } else {
            setState({ ...EMPTY_STATE, query, status: 'done', matches: result.matches, scannedChapters: result.scannedChapters, totalMatches: result.totalMatches });
            worker?.terminate();
          }
        };
        worker.onerror = (event) => {
          event.preventDefault();
          failure('搜索暂时不可用，请重试。');
        };
        worker.onmessageerror = () => failure('搜索结果读取失败，请重试。');
        setState({ ...EMPTY_STATE, query, status: 'scanning' });
        worker.postMessage({ requestId, bookId, query });
      } catch {
        failure('搜索暂时不可用，请关闭面板后重试。');
      }
    }, 250);
    return () => {
      active = false;
      window.clearTimeout(timer);
      worker?.terminate();
    };
  }, [bookId, query, composing, retry]);

  const currentState = state.query === query ? state : { ...EMPTY_STATE, query, status: 'waiting' as const };
  const scanning = currentState.status === 'scanning' || currentState.status === 'waiting';

  return <Sheet label="全文搜索" className="reading-tools-sheet search-sheet" onClose={onClose}>
    <div className="sheet-head">
      <h2 className="reading-tools-title">全文搜索</h2>
      <button className="bar-btn" onClick={onClose}>关闭</button>
    </div>
    <div className="search-controls">
      <div className="search-input-wrap">
        <input
          type="search"
          className="reading-tools-input"
          aria-label="搜索全文"
          placeholder="搜索人物、剧情或一句话"
          autoComplete="off"
          value={input}
          onChange={(event) => setInput(event.target.value)}
          onCompositionStart={() => setComposing(true)}
          onCompositionEnd={(event) => { setInput(event.currentTarget.value); setComposing(false); }}
        />
        {input ? <button className="search-clear" aria-label="清空搜索" onClick={() => setInput('')}>清空</button> : null}
      </div>
      <p className="reading-tools-meta">搜索当前书的全部正文，支持单个汉字。</p>
    </div>
    <div className="search-summary" role="status" aria-live="polite">
      {scanning ? <><p>{currentState.status === 'waiting' ? '准备搜索…' : `正在搜索 · 已扫描 ${currentState.scannedChapters} / ${chapterCount} 章`}</p>
        {chapterCount > 0 ? <progress aria-label="正文搜索进度" max={chapterCount} value={currentState.scannedChapters} /> : null}</> :
        currentState.status === 'done' ? <p>{currentState.totalMatches === 0 ? '搜索完成' : `找到 ${currentState.totalMatches} 段正文${currentState.totalMatches > SEARCH_RESULT_LIMIT ? `，显示前 ${SEARCH_RESULT_LIMIT} 条` : ''}`}</p> : null}
    </div>
    <div className="reading-tools-list search-results" ref={listRef} aria-busy={scanning}>
      {currentState.status === 'idle' ? <div className="reading-tools-empty"><p>找回书里的某个片段</p><p className="reading-tools-meta">输入关键词，点选结果即可跳到对应段落。</p></div> :
        scanning ? <div className="reading-tools-empty"><p>正在逐章查找</p><p className="reading-tools-meta">{currentState.totalMatches > 0 ? `目前找到 ${currentState.totalMatches} 段正文` : '全文保存在本机，离线也可以搜索。'}</p></div> :
        currentState.status === 'error' ? <div className="reading-tools-empty"><p role="alert">{currentState.error}</p><button className="reading-tools-secondary" onClick={() => setRetry((value) => value + 1)}>重新搜索</button></div> :
        currentState.matches.length === 0 ? <div className="reading-tools-empty"><p>没有找到“{query}”</p><p className="reading-tools-meta">试试更短的词，或换一个说法。</p></div> : <>
          <ul className="search-result-list" aria-label="全文搜索结果">
            {currentState.matches.slice(0, visibleCount).map((match) => <li key={`${match.chapterIndex}:${match.paragraphIndex}`}>
              <button className="search-result" onClick={() => onSelect(match, currentState.query)}>
                <span className="reading-tools-row-title">{match.chapterTitle}</span>
                <span className="reading-tools-meta">第 {match.chapterIndex + 1} 章 · 第 {match.paragraphIndex + 1} 段</span>
                <Excerpt match={match} query={currentState.query} />
              </button>
            </li>)}
          </ul>
          {visibleCount < currentState.matches.length ? <button className="search-show-more" onClick={() => setVisibleCount((value) => value + RESULT_BATCH)}>显示更多结果（还有 {currentState.matches.length - visibleCount} 条）</button> : null}
        </>}
    </div>
  </Sheet>;
}
