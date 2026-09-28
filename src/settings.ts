export type Theme = 'white' | 'sepia' | 'dark';
export type FontFamily = 'sans' | 'serif';

export interface ReaderSettings {
  fontSize: number;
  lineHeight: number;
  /** 左右边距 px */
  margin: number;
  fontFamily: FontFamily;
  theme: Theme;
}

const KEY = 'nr:settings';

export const DEFAULT_SETTINGS: ReaderSettings = {
  fontSize: 18,
  lineHeight: 1.8,
  margin: 20,
  fontFamily: 'serif',
  theme: 'sepia',
};

export function loadSettings(): ReaderSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const s = JSON.parse(raw) as Partial<ReaderSettings>;
      const number = (v: unknown, fallback: number, lo: number, hi: number) =>
        typeof v === 'number' && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : fallback;
      return {
        fontSize: number(s.fontSize, 18, 14, 28),
        lineHeight: number(s.lineHeight, 1.8, 1.4, 2.4),
        margin: number(s.margin, 20, 8, 40),
        fontFamily: s.fontFamily === 'sans' ? 'sans' : 'serif',
        theme: s.theme === 'white' || s.theme === 'dark' ? s.theme : 'sepia',
      };
    }
  } catch {
    /* ignore */
  }
  return DEFAULT_SETTINGS;
}

export function saveSettings(s: ReaderSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* ignore */
  }
}
