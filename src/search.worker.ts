import {
  createSearchMatch, findLiteralMatch, SEARCH_RESULT_LIMIT, splitSearchParagraphs,
  type SearchMatch, type SearchWorkerRequest, type SearchWorkerResponse,
} from './search';
import type { ChapterRecord } from './types';

const scope = self as unknown as {
  onmessage: ((event: MessageEvent<SearchWorkerRequest>) => void) | null;
  postMessage: (message: SearchWorkerResponse) => void;
};

scope.onmessage = (event) => {
  const { requestId, bookId, query } = event.data;
  if (!query.trim()) {
    scope.postMessage({ type: 'result', requestId, scannedChapters: 0, totalMatches: 0, matches: [] });
    return;
  }

  // 不指定版本，使用阅读器已升级的数据库；每次搜索仅保留一个逐章游标。
  const opening = indexedDB.open('novel-reader');
  let failed = false;
  const fail = (message: string) => {
    if (failed) return;
    failed = true;
    scope.postMessage({ type: 'error', requestId, message });
  };
  opening.onupgradeneeded = () => {
    opening.transaction?.abort();
    fail('未找到本地书籍，请回到书架重新导入后再试。');
  };
  opening.onblocked = () => fail('本地书库暂时被其他页面占用，请关闭其他阅读页面后重试。');
  opening.onerror = () => fail('无法读取本地正文，请重试；若仍失败，请重新导入这本书。');
  opening.onsuccess = () => {
    const db = opening.result;
    if (failed) { db.close(); return; }
    db.onversionchange = () => {
      db.close();
      fail('书库已更新，请重新搜索。');
    };
    try {
      const tx = db.transaction('chapters', 'readonly');
      const cursorRequest = tx.objectStore('chapters').index('byBook').openCursor(IDBKeyRange.only(bookId));
      const matches: SearchMatch[] = [];
      let totalMatches = 0;
      let scannedChapters = 0;
      let lastNotice = 0;
      let finished = false;
      tx.onabort = () => {
        db.close();
        fail('搜索中断，请重试。若刚更新了书籍，请等待导入完成。');
      };
      tx.onerror = () => fail('正文读取失败，请重试；若仍失败，请重新导入这本书。');
      tx.oncomplete = () => {
        db.close();
        if (failed || !finished) return;
        if (scannedChapters === 0) {
          fail('未找到这本书的正文，请回到书架重新导入后再试。');
          return;
        }
        scope.postMessage({ type: 'result', requestId, matches, totalMatches, scannedChapters });
      };
      cursorRequest.onsuccess = () => {
        try {
          const cursor = cursorRequest.result;
          if (!cursor) { finished = true; return; }
          const chapter = cursor.value as ChapterRecord;
          const paragraphs = splitSearchParagraphs(chapter.content);
          for (let index = 0; index < paragraphs.length; index++) {
            const paragraph = paragraphs[index];
            const hit = findLiteralMatch(paragraph, query);
            if (!hit) continue;
            totalMatches++;
            if (matches.length < SEARCH_RESULT_LIMIT) {
              matches.push(createSearchMatch(chapter.index, chapter.title, index, paragraph, hit));
            }
          }
          scannedChapters++;
          const now = performance.now();
          if (scannedChapters === 1 || now - lastNotice >= 120) {
            lastNotice = now;
            scope.postMessage({ type: 'progress', requestId, scannedChapters, totalMatches });
          }
          cursor.continue();
        } catch {
          fail('正文格式无法读取，请重新导入这本书后再试。');
          tx.abort();
        }
      };
    } catch {
      db.close();
      fail('本地书库尚未准备好，请关闭搜索后重试。');
    }
  };
};
