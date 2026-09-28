import type { BookMeta, ChapterRecord, ReadingProgress } from './types';

const DB_NAME = 'novel-reader';
const DB_VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDB(): Promise<IDBDatabase> {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('books')) {
          db.createObjectStore('books', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('chapters')) {
          const store = db.createObjectStore('chapters', { keyPath: ['bookId', 'index'] });
          store.createIndex('byBook', 'bookId', { unique: false });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => {
        dbPromise = null;
        reject(req.error);
      };
    });
  }
  return dbPromise;
}

function reqToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function txDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function getAllBooks(): Promise<BookMeta[]> {
  const db = await openDB();
  const tx = db.transaction('books', 'readonly');
  const books = await reqToPromise(tx.objectStore('books').getAll() as IDBRequest<BookMeta[]>);
  return books.sort((a, b) => b.addedAt - a.addedAt);
}

export async function getBook(id: string): Promise<BookMeta | undefined> {
  const db = await openDB();
  const tx = db.transaction('books', 'readonly');
  return reqToPromise(tx.objectStore('books').get(id) as IDBRequest<BookMeta | undefined>);
}

export async function putBook(book: BookMeta): Promise<void> {
  const db = await openDB();
  const tx = db.transaction('books', 'readwrite');
  tx.objectStore('books').put(book);
  await txDone(tx);
}

export async function saveBookProgress(bookId: string, progress: ReadingProgress): Promise<void> {
  const updatedAt = Date.now();
  // localStorage 镜像：轻量、同步可写，pagehide 时也能可靠落盘
  try {
    localStorage.setItem(`nr:prog:${bookId}`, JSON.stringify({ ...progress, updatedAt }));
  } catch {
    /* ignore quota errors */
  }
  try {
    const db = await openDB();
    const tx = db.transaction('books', 'readwrite');
    const book = await reqToPromise(tx.objectStore('books').get(bookId) as IDBRequest<BookMeta | undefined>);
    if (book && updatedAt >= (book.progressUpdatedAt ?? 0)) {
      book.progress = progress;
      book.progressUpdatedAt = updatedAt;
      tx.objectStore('books').put(book);
      await txDone(tx);
    }
  } catch {
    /* 页面关闭场景下事务可能中断，localStorage 镜像兜底 */
  }
}

export async function readSavedProgress(book: BookMeta): Promise<ReadingProgress> {
  const valid = (p: ReadingProgress | undefined): p is ReadingProgress => !!p &&
    Number.isInteger(p.chapterIndex) && p.chapterIndex >= 0 && p.chapterIndex < book.chapterCount &&
    Number.isInteger(p.paragraphIndex) && p.paragraphIndex >= 0 &&
    Number.isFinite(p.paragraphProgress) && p.paragraphProgress >= 0 && p.paragraphProgress <= 1;
  try {
    const raw = localStorage.getItem(`nr:prog:${book.id}`);
    if (raw) {
      const mirror = JSON.parse(raw) as ReadingProgress & { updatedAt?: number };
      if (valid(mirror) && (mirror.updatedAt ?? 0) >= (book.progressUpdatedAt ?? 0)) return mirror;
    }
  } catch {
    /* ignore */
  }
  return valid(book.progress) ? book.progress : { chapterIndex: 0, paragraphIndex: 0, paragraphProgress: 0 };
}

/** 删除旧章节、分批写新章节和更新书架属于同一事务，任何失败都会回滚。 */
export async function replaceBook(
  book: BookMeta,
  chapters: { title: string; content: string }[],
  onBatch: (written: number) => void,
): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['books', 'chapters'], 'readwrite');
    const store = tx.objectStore('chapters');
    let failure: unknown;
    tx.oncomplete = () => resolve();
    tx.onabort = () => reject(failure ?? tx.error ?? new Error('导入未完成，原书已保留'));
    const guard = (fn: () => void) => {
      try { fn(); } catch (e) { failure = e; tx.abort(); }
    };
    const writeBatch = (start: number) => guard(() => {
      const end = Math.min(start + 100, chapters.length);
      let last: IDBRequest | undefined;
      for (let i = start; i < end; i++) {
        last = store.put({ bookId: book.id, index: i, ...chapters[i] } satisfies ChapterRecord);
      }
      if (!last) { tx.objectStore('books').put(book); return; }
      last.onsuccess = () => guard(() => {
        onBatch(end);
        if (end < chapters.length) writeBatch(end);
        else tx.objectStore('books').put(book);
      });
    });
    const cursor = store.index('byBook').openCursor(IDBKeyRange.only(book.id));
    cursor.onsuccess = () => guard(() => {
      if (cursor.result) {
        cursor.result.delete();
        cursor.result.continue();
      } else writeBatch(0);
    });
  });
  // 只有事务提交后才能更新镜像；重置时间还会屏蔽意外残留的旧镜像。
  try {
    if (book.progress) localStorage.setItem(`nr:prog:${book.id}`, JSON.stringify({ ...book.progress, updatedAt: book.progressUpdatedAt }));
    else localStorage.removeItem(`nr:prog:${book.id}`);
  } catch { /* 数据库已完整提交 */ }
}

/** 批量写入章节，每批一个事务 */
export async function putChapterBatch(bookId: string, startIndex: number, items: { title: string; content: string }[]): Promise<void> {
  const db = await openDB();
  const tx = db.transaction('chapters', 'readwrite');
  const store = tx.objectStore('chapters');
  for (let i = 0; i < items.length; i++) {
    store.put({ bookId, index: startIndex + i, title: items[i].title, content: items[i].content } satisfies ChapterRecord);
  }
  await txDone(tx);
}

export async function getChapter(bookId: string, index: number): Promise<ChapterRecord | undefined> {
  const db = await openDB();
  const tx = db.transaction('chapters', 'readonly');
  return reqToPromise(tx.objectStore('chapters').get([bookId, index]) as IDBRequest<ChapterRecord | undefined>);
}

export async function clearChapters(bookId: string): Promise<void> {
  const db = await openDB();
  const tx = db.transaction('chapters', 'readwrite');
  const store = tx.objectStore('chapters');
  const keys = await reqToPromise(store.index('byBook').getAllKeys(IDBKeyRange.only(bookId)));
  for (const key of keys) store.delete(key);
  await txDone(tx);
}

export async function countChapters(bookId: string): Promise<number> {
  const db = await openDB();
  const tx = db.transaction('chapters', 'readonly');
  return reqToPromise(tx.objectStore('chapters').index('byBook').count(IDBKeyRange.only(bookId)));
}

export async function deleteBook(bookId: string): Promise<void> {
  await clearChapters(bookId);
  const db = await openDB();
  const tx = db.transaction('books', 'readwrite');
  tx.objectStore('books').delete(bookId);
  await txDone(tx);
  try {
    localStorage.removeItem(`nr:prog:${bookId}`);
  } catch {
    /* ignore */
  }
}
