import type { ChapterIllustration } from './types';

/** Embedded raster images travel with the book and work without network access. */
export async function parseIllustrations(value: unknown, paragraphCount: number): Promise<ChapterIllustration[] | undefined> {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length > 30) throw new Error('每章插图必须为数组，且不能超过 30 张');
  const result: ChapterIllustration[] = [];
  for (const raw of value) {
    if (!raw || !Number.isInteger(raw.afterParagraph) || raw.afterParagraph < 0 || raw.afterParagraph >= paragraphCount ||
        typeof raw.dataUrl !== 'string' || raw.dataUrl.length > 7_000_000 ||
        !/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(raw.dataUrl) ||
        typeof raw.alt !== 'string' || raw.alt.length > 1000) {
      throw new Error('插图格式不正确：需要有效段落位置、图片说明及不超过约 5 MB 的内嵌 PNG/JPEG/WebP/GIF');
    }
    const image = new Image();
    image.src = raw.dataUrl;
    try { await image.decode(); } catch { throw new Error('插图无法解码，请重新导出图片'); }
    if (!image.naturalWidth || !image.naturalHeight || image.naturalWidth * image.naturalHeight > 40_000_000) {
      throw new Error('插图尺寸无效或超过 4000 万像素');
    }
    result.push({ afterParagraph: raw.afterParagraph, dataUrl: raw.dataUrl, alt: raw.alt,
      width: image.naturalWidth, height: image.naturalHeight });
  }
  return result;
}
