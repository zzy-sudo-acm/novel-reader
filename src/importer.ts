import type { BookMeta, TocEntry } from './types';
import { clearChapters, getAllBooks, putBook, putChapterBatch } from './db';

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

/**
 * 解析并导入 book.json：
 * - 书籍元信息（含目录、每章字数/段落数）存入 books
 * - 每章正文单独一条记录存入 chapters，阅读时按需读取
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
  const chapters: { title: string; content: string }[] = [];
  for (const c of raw.chapters) {
    const ch = c as { title?: unknown; content?: unknown };
    if (typeof ch?.title === 'string' && typeof ch?.content === 'string') {
      chapters.push({ title: ch.title, content: ch.content });
    }
  }
  if (chapters.length === 0) throw new Error('文件格式不正确：没有有效章节');

  onProgress(0.05, '分析章节…');
  await new Promise((r) => setTimeout(r, 0));
  const toc: TocEntry[] = chapters.map((c) => ({
    t: c.title,
    c: c.content.length,
    p: splitParagraphs(c.content).length,
  }));
  const totalChars = toc.reduce((sum, t) => sum + t.c, 0);

  // 同名书籍视为重新导入：覆盖章节，章节数一致时保留阅读进度
  const existing = (await getAllBooks()).find((b) => b.title === title);
  const id = existing?.id ?? crypto.randomUUID();
  const keepProgress = existing && existing.chapterCount === chapters.length ? existing.progress : undefined;

  if (existing) {
    onProgress(0.08, '清理旧数据…');
    await clearChapters(existing.id);
  }

  const book: BookMeta = {
    id,
    title,
    chapterCount: chapters.length,
    toc,
    totalChars,
    addedAt: Date.now(),
    progress: keepProgress,
  };

  const BATCH = 100;
  for (let i = 0; i < chapters.length; i += BATCH) {
    await putChapterBatch(id, i, chapters.slice(i, i + BATCH));
    onProgress(0.1 + 0.88 * Math.min(1, (i + BATCH) / chapters.length), `写入章节 ${Math.min(i + BATCH, chapters.length)}/${chapters.length}…`);
  }
  await putBook(book);
  onProgress(1, '完成');
  return book;
}
