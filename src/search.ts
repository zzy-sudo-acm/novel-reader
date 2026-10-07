export interface SearchMatch {
  chapterIndex: number;
  chapterTitle: string;
  paragraphIndex: number;
  matchOffset: number;
  paragraphLength: number;
  /** 原始正文片段，不包含省略号。 */
  excerpt: string;
  /** 片段在原段落中的字符偏移。 */
  excerptOffset: number;
}

export interface LiteralMatch {
  offset: number;
  length: number;
}

/** 字面量、忽略大小写匹配；保留原文的 UTF-16 偏移供定位和高亮使用。 */
export function findLiteralMatch(text: string, query: string): LiteralMatch | null {
  if (!query) return null;
  const foldedText = text.toLowerCase();
  const foldedQuery = query.toLowerCase();
  const start = foldedText.indexOf(foldedQuery);
  if (start < 0) return null;
  const end = start + foldedQuery.length;
  if (foldedText.length === text.length) return { offset: start, length: end - start };

  // 如 İ 会小写成两个字符；此时把规范化偏移映射回实际正文。
  let originalOffset = 0;
  let foldedOffset = 0;
  let matchStart = -1;
  for (const character of text) {
    const foldedEnd = foldedOffset + character.toLowerCase().length;
    if (matchStart < 0 && start < foldedEnd) matchStart = originalOffset;
    originalOffset += character.length;
    if (end <= foldedEnd) return { offset: matchStart, length: originalOffset - matchStart };
    foldedOffset = foldedEnd;
  }
  return null;
}

export const SEARCH_RESULT_LIMIT = 200;

export function createSearchMatch(
  chapterIndex: number,
  chapterTitle: string,
  paragraphIndex: number,
  paragraph: string,
  hit: LiteralMatch,
): SearchMatch {
  let excerptOffset = Math.max(0, hit.offset - 36);
  let excerptEnd = Math.min(paragraph.length, hit.offset + hit.length + 72);
  // 不在 emoji 等代理对中间截断。
  if (excerptOffset > 0 && /[\uDC00-\uDFFF]/.test(paragraph[excerptOffset])) excerptOffset--;
  if (excerptEnd < paragraph.length && /[\uDC00-\uDFFF]/.test(paragraph[excerptEnd])) excerptEnd++;
  return {
    chapterIndex,
    chapterTitle,
    paragraphIndex,
    matchOffset: hit.offset,
    paragraphLength: paragraph.length,
    excerpt: paragraph.slice(excerptOffset, excerptEnd),
    excerptOffset,
  };
}

export interface SearchWorkerRequest {
  requestId: number;
  bookId: string;
  query: string;
}

export type SearchWorkerResponse =
  | { type: 'progress'; requestId: number; scannedChapters: number; totalMatches: number }
  | { type: 'result'; requestId: number; scannedChapters: number; totalMatches: number; matches: SearchMatch[] }
  | { type: 'error'; requestId: number; message: string };
