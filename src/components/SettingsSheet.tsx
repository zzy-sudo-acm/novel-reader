import type { ReaderSettings, Theme } from '../settings';
import Sheet from './Sheet';

interface Props {
  settings: ReaderSettings;
  onChange: (s: ReaderSettings) => void;
  onClose: () => void;
}

const THEMES: { key: Theme; label: string }[] = [
  { key: 'white', label: '白色' },
  { key: 'sepia', label: '米黄' },
  { key: 'dark', label: '深色' },
];

export default function SettingsSheet({ settings, onChange, onClose }: Props) {
  const set = (patch: Partial<ReaderSettings>) => onChange({ ...settings, ...patch });

  return (
    <Sheet label="阅读设置" className="settings-sheet" onClose={onClose}>
        <div className="sheet-head">
          <span>阅读设置</span>
          <button className="bar-btn" onClick={onClose}>
            完成
          </button>
        </div>

        <label className="setting-row">
          <span>字号 {settings.fontSize}</span>
          <input
            type="range"
            min={14}
            max={28}
            step={1}
            value={settings.fontSize}
            onChange={(e) => set({ fontSize: Number(e.target.value) })}
          />
        </label>

        <label className="setting-row">
          <span>行距 {settings.lineHeight.toFixed(1)}</span>
          <input
            type="range"
            min={1.4}
            max={2.4}
            step={0.1}
            value={settings.lineHeight}
            onChange={(e) => set({ lineHeight: Number(e.target.value) })}
          />
        </label>

        <label className="setting-row">
          <span>边距 {settings.margin}</span>
          <input
            type="range"
            min={8}
            max={40}
            step={2}
            value={settings.margin}
            onChange={(e) => set({ margin: Number(e.target.value) })}
          />
        </label>

        <div className="setting-row">
          <span>字体</span>
          <div className="seg">
            <button
              className={settings.fontFamily === 'serif' ? 'seg-on' : ''}
              aria-pressed={settings.fontFamily === 'serif'}
              onClick={() => set({ fontFamily: 'serif' })}
            >
              衬线
            </button>
            <button
              className={settings.fontFamily === 'sans' ? 'seg-on' : ''}
              aria-pressed={settings.fontFamily === 'sans'}
              onClick={() => set({ fontFamily: 'sans' })}
            >
              黑体
            </button>
          </div>
        </div>

        <div className="setting-row">
          <span>主题</span>
          <div className="seg">
            {THEMES.map((t) => (
              <button
                key={t.key}
                className={settings.theme === t.key ? 'seg-on' : ''}
                aria-pressed={settings.theme === t.key}
                onClick={() => set({ theme: t.key })}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
    </Sheet>
  );
}
