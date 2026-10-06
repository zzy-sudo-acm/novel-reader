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
  /** 0~1，参考线落在该段落内的相对高度位置（旧格式，保留作 fallback） */
  paragraphProgress: number;
  /** 0~1，参考位置约位于该段落的字符比例；比高度比例更抗字号/行距变化 */
  paragraphCharProgress?: number;
}

export interface BookMeta {
  id: string;
  title: string;
  /** 书源标识，来自 book.json 的 source 字段 */
  source?: string;
  /** 无 source 时使用的内容指纹，用于识别同一本书 */
  fingerprint?: string;
  chapterCount: number;
  toc: TocEntry[];
  totalChars: number;
  addedAt: number;
  /** 实际打开或保存阅读进度的时间；导入不会更新。 */
  lastReadAt?: number;
  readingStatus?: 'unread' | 'reading' | 'finished';
  progress?: ReadingProgress;
  /** 与同步进度镜像比较新旧；无进度时也记录重置时间。 */
  progressUpdatedAt?: number;
}

export interface ChapterIllustration {
  afterParagraph: number;
  dataUrl: string;
  alt: string;
  width: number;
  height: number;
}

export interface ChapterRecord {
  bookId: string;
  index: number;
  title: string;
  content: string;
  images?: ChapterIllustration[];
}

export interface Bookmark {
  id: string;
  bookId: string;
  chapterTitle: string;
  excerpt: string;
  createdAt: number;
  progress: ReadingProgress;
  /** 重导入后无法确认原章节时保留书签，但禁止跳转。 */
  unavailable?: boolean;
}
