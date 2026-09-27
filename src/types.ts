export interface TocEntry {
  /** 章节标题 */
  t: string;
  /** 章节正文字符数 */
  c: number;
  /** 章节段落数 */
  p: number;
}

export interface ReadingProgress {
  chapterIndex: number;
  paragraphIndex: number;
  /** 0~1，参考线落在该段落内的相对位置 */
  paragraphProgress: number;
}

export interface BookMeta {
  id: string;
  title: string;
  chapterCount: number;
  toc: TocEntry[];
  totalChars: number;
  addedAt: number;
  progress?: ReadingProgress;
}

export interface ChapterRecord {
  bookId: string;
  index: number;
  title: string;
  content: string;
}
