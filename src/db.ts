import type { Bookmark, BookMeta, ChapterRecord, ReadingProgress } from './types';

const DB_NAME = 'novel-reader';
const DB_VERSION = 2;

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
        if (!db.objectStoreNames.contains('bookmarks')) {
          const store = db.createObjectStore('bookmarks', { keyPath: 'id' });
          store.createIndex('byBook', 'bookId', { unique: false });
        }
      };
      req.onsuccess = () => {
        const db = req.result;
        // 其他标签页触发版本升级时主动断开，避免旧连接阻塞升级
        db.onversionchange = () => {
          db.close();
          dbPromise = null;
        };
        resolve(db);
      };
      req.onblocked = () => {
        // 有旧标签页占用连接；下次操作会重新尝试打开
        dbPromise = null;
        reject(new Error('本地数据库被其他标签页占用，请关闭后重试'));
      };
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

/** 在事务内读取当前记录，避免使用旧的书架对象覆盖进度或复活已删书。 */
async function updateExistingBook(bookId: string, update: (book: BookMeta) => void): Promise<void> {
  const db = await openDB();
  const tx = db.transaction('books', 'readwrite');
  const done = txDone(tx);
  const store = tx.objectStore('books');
  const request = store.get(bookId) as IDBRequest<BookMeta | undefined>;
  request.onsuccess = () => {
    if (!request.result) return;
    update(request.result);
    store.put(request.result);
  };
  await done;
}

export async function markBookOpened(bookId: string): Promise<void> {
  await updateExistingBook(bookId, (book) => {
    book.lastReadAt = Date.now();
    if (book.readingStatus !== 'finished') book.readingStatus = 'reading';
  });
}

export async function setBookReadingStatus(bookId: string, status: 'reading' | 'finished'): Promise<void> {
  await updateExistingBook(bookId, (book) => {
    book.readingStatus = status;
  });
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
    await updateExistingBook(bookId, (book) => {
      if (updatedAt < (book.progressUpdatedAt ?? 0)) return;
      book.progress = progress;
      book.progressUpdatedAt = updatedAt;
      book.lastReadAt = Math.max(updatedAt, book.lastReadAt ?? 0);
      if (book.readingStatus !== 'finished') book.readingStatus = 'reading';
    });
  } catch {
    /* 页面关闭场景下事务可能中断，localStorage 镜像兜底 */
  }
}

export async function getBookmarks(bookId: string): Promise<Bookmark[]> {
  const db = await openDB();
  const tx = db.transaction('bookmarks', 'readonly');
  const bookmarks = await reqToPromise(
    tx.objectStore('bookmarks').index('byBook').getAll(IDBKeyRange.only(bookId)) as IDBRequest<Bookmark[]>,
  );
  return bookmarks.sort((a, b) => b.createdAt - a.createdAt);
}

export async function addBookmark(bookId: string, progress: ReadingProgress, excerpt: string): Promise<Bookmark> {
  const db = await openDB();
  return new Promise<Bookmark>((resolve, reject) => {
    const tx = db.transaction(['books', 'chapters', 'bookmarks'], 'readwrite');
    const store = tx.objectStore('bookmarks');
    let bookmark: Bookmark | undefined;
    let failure: unknown;
    tx.oncomplete = () => {
      if (bookmark) resolve(bookmark);
      else reject(new Error('书签未保存'));
    };
    tx.onabort = () => reject(failure ?? tx.error ?? new Error('无法保存书签'));
    const guard = (fn: () => void) => {
      try { fn(); } catch (error) { failure = error; tx.abort(); }
    };
    const bookRequest = tx.objectStore('books').get(bookId) as IDBRequest<BookMeta | undefined>;
    bookRequest.onsuccess = () => guard(() => {
      const book = bookRequest.result;
      if (!book) throw new Error('这本书已不存在，无法保存书签');
      if (!Number.isInteger(progress.chapterIndex) || progress.chapterIndex < 0 || progress.chapterIndex >= book.chapterCount ||
          !Number.isInteger(progress.paragraphIndex) || progress.paragraphIndex < 0 ||
          !Number.isFinite(progress.paragraphProgress) || progress.paragraphProgress < 0 || progress.paragraphProgress > 1 ||
          (progress.paragraphCharProgress !== undefined &&
            (!Number.isFinite(progress.paragraphCharProgress) || progress.paragraphCharProgress < 0 || progress.paragraphCharProgress > 1))) {
        throw new Error('阅读位置无效，无法保存书签');
      }
      const chapterRequest = tx.objectStore('chapters').get([bookId, progress.chapterIndex]) as IDBRequest<ChapterRecord | undefined>;
      chapterRequest.onsuccess = () => guard(() => {
        const chapter = chapterRequest.result;
        const paragraphs = chapter?.content.split(/\r\n|\r|\n/).map((text) => text.trim()).filter(Boolean);
        if (!chapter || !paragraphs || progress.paragraphIndex >= paragraphs.length) {
          throw new Error('书签所在段落已不存在');
        }
        const allRequest = store.index('byBook').getAll(IDBKeyRange.only(bookId)) as IDBRequest<Bookmark[]>;
        allRequest.onsuccess = () => guard(() => {
          bookmark = allRequest.result.find((item) => !item.unavailable &&
            item.progress.chapterIndex === progress.chapterIndex && item.progress.paragraphIndex === progress.paragraphIndex);
          if (bookmark) return;
          bookmark = {
            id: crypto.randomUUID(),
            bookId,
            chapterTitle: chapter.title,
            excerpt: excerpt.trim().replace(/\s+/g, ' ').slice(0, 200),
            createdAt: Date.now(),
            progress: { ...progress },
          };
          store.add(bookmark);
        });
      });
    });
  });
}

export async function deleteBookmark(id: string): Promise<void> {
  const db = await openDB();
  const tx = db.transaction('bookmarks', 'readwrite');
  tx.objectStore('bookmarks').delete(id);
  await txDone(tx);
}

function migrateBookmark(bookmark: Bookmark, book: BookMeta, titleIndices: Map<string, number[]>): Bookmark {
  const saved = bookmark.progress;
  let index = saved.chapterIndex;
  if (book.toc[index]?.t !== bookmark.chapterTitle) {
    const matches = titleIndices.get(bookmark.chapterTitle);
    if (matches?.length !== 1) return { ...bookmark, unavailable: true };
    index = matches[0];
  }
  const paragraphCount = book.toc[index]?.p ?? 0;
  if (paragraphCount < 1 || !Number.isInteger(saved.paragraphIndex) || saved.paragraphIndex < 0) {
    return { ...bookmark, unavailable: true };
  }
  const truncated = saved.paragraphIndex >= paragraphCount;
  return {
    ...bookmark,
    unavailable: false,
    progress: {
      chapterIndex: index,
      paragraphIndex: Math.min(saved.paragraphIndex, paragraphCount - 1),
      paragraphProgress: truncated ? 0 : saved.paragraphProgress,
      paragraphCharProgress: truncated ? 0 : saved.paragraphCharProgress,
    },
  };
}

export async function readSavedProgress(book: BookMeta): Promise<ReadingProgress> {
  const valid = (p: ReadingProgress | undefined): p is ReadingProgress => !!p &&
    Number.isInteger(p.chapterIndex) && p.chapterIndex >= 0 && p.chapterIndex < book.chapterCount &&
    Number.isInteger(p.paragraphIndex) && p.paragraphIndex >= 0 &&
    Number.isFinite(p.paragraphProgress) && p.paragraphProgress >= 0 && p.paragraphProgress <= 1 &&
    // 旧版数据没有字符比例字段；存在时则必须合法
    (p.paragraphCharProgress === undefined ||
      (Number.isFinite(p.paragraphCharProgress) && p.paragraphCharProgress >= 0 && p.paragraphCharProgress <= 1));
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
  const titleIndices = new Map<string, number[]>();
  book.toc.forEach((chapter, index) => {
    const indices = titleIndices.get(chapter.t) ?? [];
    indices.push(index);
    titleIndices.set(chapter.t, indices);
  });
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['books', 'chapters', 'bookmarks'], 'readwrite');
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
    const deleteChapters = () => {
      const cursor = store.index('byBook').openCursor(IDBKeyRange.only(book.id));
      cursor.onsuccess = () => guard(() => {
        if (cursor.result) {
          cursor.result.delete();
          cursor.result.continue();
        } else writeBatch(0);
      });
    };
    const migrateBookmarks = () => {
      const cursor = tx.objectStore('bookmarks').index('byBook').openCursor(IDBKeyRange.only(book.id));
      cursor.onsuccess = () => guard(() => {
        if (cursor.result) {
          cursor.result.update(migrateBookmark(cursor.result.value as Bookmark, book, titleIndices));
          cursor.result.continue();
        } else deleteChapters();
      });
    };
    const currentBook = tx.objectStore('books').get(book.id) as IDBRequest<BookMeta | undefined>;
    currentBook.onsuccess = () => guard(() => {
      // 导入过程中可能继续阅读；保留事务开始时的最新阅读状态。
      if (currentBook.result) {
        book.lastReadAt = currentBook.result.lastReadAt;
        book.readingStatus = currentBook.result.readingStatus ?? (currentBook.result.progress ? 'reading' : 'unread');
      }
      migrateBookmarks();
    });
  });
  // 只有事务提交后才能更新镜像；重置时间还会屏蔽意外残留的旧镜像。
  try {
    if (book.progress) localStorage.setItem(`nr:prog:${book.id}`, JSON.stringify({ ...book.progress, updatedAt: book.progressUpdatedAt }));
    else localStorage.removeItem(`nr:prog:${book.id}`);
  } catch { /* 数据库已完整提交 */ }
}

export async function getChapter(bookId: string, index: number): Promise<ChapterRecord | undefined> {
  const db = await openDB();
  const tx = db.transaction('chapters', 'readonly');
  return reqToPromise(tx.objectStore('chapters').get([bookId, index]) as IDBRequest<ChapterRecord | undefined>);
}

export async function countChapters(bookId: string): Promise<number> {
  const db = await openDB();
  const tx = db.transaction('chapters', 'readonly');
  return reqToPromise(tx.objectStore('chapters').index('byBook').count(IDBKeyRange.only(bookId)));
}

/** 原子删除书籍、章节及书签，任何一步失败全部回滚。 */
export async function deleteBook(bookId: string): Promise<void> {
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(['books', 'chapters', 'bookmarks'], 'readwrite');
    const store = tx.objectStore('chapters');
    let failure: unknown;
    tx.oncomplete = () => resolve();
    tx.onerror = () => {
      failure ??= tx.error;
    };
    tx.onabort = () => reject(failure ?? tx.error ?? new Error('删除失败，书籍已保留'));
    const guard = (fn: () => void) => {
      try {
        fn();
      } catch (e) {
        failure = e;
        try {
          tx.abort();
        } catch {
          /* 事务可能已结束 */
        }
      }
    };
    const deleteRecords = (recordStore: IDBObjectStore, onDone: () => void) => {
      const cursor = recordStore.index('byBook').openCursor(IDBKeyRange.only(bookId));
      cursor.onsuccess = () => guard(() => {
        if (cursor.result) {
          cursor.result.delete();
          cursor.result.continue();
        } else onDone();
      });
    };
    deleteRecords(store, () => {
      deleteRecords(tx.objectStore('bookmarks'), () => tx.objectStore('books').delete(bookId));
    });
  });
  // 只有事务提交后才清理进度镜像
  try {
    localStorage.removeItem(`nr:prog:${bookId}`);
  } catch {
    /* 数据库已完整提交 */
  }
}
