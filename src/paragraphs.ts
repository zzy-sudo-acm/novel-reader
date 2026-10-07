import type { BookMeta } from './types';

/**
 * 正文按段落切分。阅读页、目录段落数、全文搜索、书签校验共用此函数，
 * 保证 data-paragraph / paragraphIndex 在所有入口一致。
 * - markdown 书：按空行分段，块内保留单个换行（围栏代码块的多行与缩进得以完整保留）
 * - 其他书：按单个换行分段（原有行为，存量书籍的段落索引不变）
 */
export function splitContentParagraphs(content: string, format?: BookMeta['format']): string[] {
  if (format === 'markdown') {
    return content
      .split(/(?:\r\n|\r|\n)(?:[ \t]*(?:\r\n|\r|\n))+/)
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }
  return content
    .split(/\r\n|\r|\n/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
