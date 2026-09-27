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
    if (raw) return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<ReaderSettings>) };
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
