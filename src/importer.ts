import type { BookMeta, ReadingProgress, TocEntry } from './types';
import { getAllBooks, readSavedProgress, replaceBook } from './db';

interface RawBook {
  title?: unknown;
  source?: unknown;
  chapters?: unknown;
}

function splitParagraphs(content: string): string[] {
  return content
    .split(/\r\n|\r|\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 轻量内容指纹（djb2 变体双哈希），用于无 source 时识别同一本书 */
export function computeFingerprint(title: string, chapters: { title: string; content: string }[]): string {
  const parts: string[] = [title, String(chapters.length)];
  for (const c of chapters.slice(0, 3)) parts.push(c.title, c.content.slice(0, 100));
  const last = chapters[chapters.length - 1];
  if (last) parts.push(last.title, last.content.slice(-100));
  const s = parts.join('');
  let h1 = 5381;
  let h2 = 52711;
  for (let i = 0; i < s.length; i++) {
    h1 = ((h1 * 33) ^ s.charCodeAt(i)) >>> 0;
    h2 = ((h2 * 31) ^ s.charCodeAt(i)) >>> 0;
  }
  return h1.toString(36) + h2.toString(36);
}

/**
 * 书籍身份：
 * - 任一方有 source：以 title + source 为准
 * - 都没有 source：比较内容指纹
 * - 旧数据（无 source 无指纹）：退化为标题匹配，由调用方兜底
 */
function sameIdentity(b: BookMeta, title: string, source: string | undefined, fingerprint: string): boolean {
  if (source || b.source) return b.title === title && b.source === source;
  if (b.fingerprint) return b.fingerprint === fingerprint;
  return false;
}

/**
 * 重新导入时迁移阅读进度：
 * 1. 同 index 同标题 → 直接保留
 * 2. 附近 ±20 章内有相同标题 → 迁移到新 index
 * 3. 都找不到 → 保留章节序号、回到章节开头（安全位置）
 */
function migrateProgress(saved: ReadingProgress, oldBook: BookMeta, newToc: TocEntry[]): ReadingProgress {
  let idx = Math.min(saved.chapterIndex, newToc.length - 1);
  const oldTitle = oldBook.toc[saved.chapterIndex]?.t;
  if (oldTitle && newToc[idx]?.t !== oldTitle) {
    let found = -1;
    for (let d = 1; d <= 20; d++) {
      if (newToc[idx + d]?.t === oldTitle) {
        found = idx + d;
        break;
      }
      if (idx - d >= 0 && newToc[idx - d]?.t === oldTitle) {
        found = idx - d;
        break;
      }
    }
    if (found < 0) return { chapterIndex: idx, paragraphIndex: 0, paragraphProgress: 0 };
    idx = found;
  }
  const maxPara = Math.max(0, (newToc[idx]?.p ?? 1) - 1);
  return {
    chapterIndex: idx,
    paragraphIndex: Math.min(saved.paragraphIndex, maxPara),
    paragraphProgress: saved.paragraphProgress,
    paragraphCharProgress: saved.paragraphCharProgress,
  };
}

/**
 * 解析并导入 book.json：
 * - 书籍元信息（含目录、每章字数/段落数）存入 books
 * - 每章正文单独一条记录存入 chapters，阅读时按需读取
 * - 同一本书（title+source 或指纹相同）重新导入时覆盖并迁移阅读进度；
 *   同名但来源/内容不同的书作为新书共存，互不覆盖
 */
export async function importBookFile(
  file: File,
  onProgress: (ratio: number, stage: string) => void,
): Promise<BookMeta> {
  onProgress(0, '读取文件…');
  const text = await file.text();
  onProgress(0.02, '解析 JSON…');
  // 让出一帧，避免 UI 卡死
  await new Promise((r) => setTimeout(r, 0));
  const raw = JSON.parse(text) as RawBook;
  if (!raw || typeof raw.title !== 'string' || !Array.isArray(raw.chapters)) {
    throw new Error('文件格式不正确：缺少 title 或 chapters');
  }
  const title = raw.title.trim();
  if (!title) throw new Error('文件格式不正确：书名不能为空');
  const source = typeof raw.source === 'string' && raw.source.trim() ? raw.source.trim() : undefined;
  const chapters: { title: string; content: string }[] = [];
  for (const c of raw.chapters) {
    const ch = c as { title?: unknown; content?: unknown };
    if (typeof ch?.title === 'string' && typeof ch?.content === 'string') {
      chapters.push({ title: ch.title, content: ch.content });
    } else throw new Error('文件中有格式错误的章节，未导入，请检查 title 和 content');
  }
  if (chapters.length === 0) throw new Error('文件格式不正确：没有有效章节');
  const fingerprint = computeFingerprint(title, chapters);

  onProgress(0.05, '分析章节…');
  const toc: TocEntry[] = [];
  for (let i = 0; i < chapters.length; i++) {
    const c = chapters[i];
    toc.push({ t: c.title, c: c.content.length, p: splitParagraphs(c.content).length });
    // 大文件分析期间定期让出主线程，保持导入进度 UI 可更新
    if (i % 200 === 199) await new Promise((r) => setTimeout(r, 0));
  }
  const totalChars = toc.reduce((sum, t) => sum + t.c, 0);

  // 身份匹配；旧数据（无 source/fingerprint）按标题兜底，导入时顺便升级记录
  const books = await getAllBooks();
  const existing =
    books.find((b) => sameIdentity(b, title, source, fingerprint)) ??
    books.find((b) => b.title === title && !b.source && !b.fingerprint);
  const id = existing?.id ?? crypto.randomUUID();

  let progress: ReadingProgress | undefined;
  if (existing) {
    const saved = await readSavedProgress(existing);
    const started =
      !!existing.progress || saved.chapterIndex > 0 || saved.paragraphIndex > 0 || saved.paragraphProgress > 0;
    if (started) progress = migrateProgress(saved, existing, toc);
  }

  const book: BookMeta = {
    id,
    title,
    source,
    fingerprint,
    chapterCount: chapters.length,
    toc,
    totalChars,
    addedAt: Date.now(),
    progress,
    progressUpdatedAt: Date.now(),
  };

  await replaceBook(book, chapters, (written) => {
    onProgress(0.1 + (0.88 * written) / chapters.length, `写入章节 ${written}/${chapters.length}…`);
  });
  onProgress(1, '完成');
  return book;
}
