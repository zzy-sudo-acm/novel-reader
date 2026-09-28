import { useCallback, useEffect, useState } from 'react';
import type { BookMeta } from './types';
import { deleteBook, getAllBooks, readSavedProgress } from './db';
import { importBookFile } from './importer';
import { loadSettings, saveSettings, type ReaderSettings } from './settings';
import Bookshelf from './components/Bookshelf';
import Reader from './components/Reader';

export default function App() {
  const [books, setBooks] = useState<BookMeta[]>([]);
  const [openBookId, setOpenBookId] = useState<string | null>(null);
  const [settings, setSettings] = useState<ReaderSettings>(loadSettings);
  const [importing, setImporting] = useState<{ name: string; ratio: number; stage: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const items = await getAllBooks();
    setBooks(await Promise.all(items.map(async (book) => {
      const progress = await readSavedProgress(book);
      const started = book.progress || progress.chapterIndex || progress.paragraphIndex || progress.paragraphProgress;
      return { ...book, progress: started ? progress : undefined };
    })));
  }, []);

  useEffect(() => {
    void refresh().catch(() => setError('无法读取本地书架，请确认浏览器允许本地存储后刷新重试'));
  }, [refresh]);

  // 主题挂到 <html>，使 body 背景覆盖 Safari 工具栏/橡皮筋/PWA 全屏区域
  useEffect(() => {
    document.documentElement.dataset.theme = openBookId ? settings.theme : 'white';
  }, [openBookId, settings.theme]);

  const handleImport = useCallback(
    async (file: File) => {
      setError(null);
      setImporting({ name: file.name, ratio: 0, stage: '开始…' });
      try {
        await importBookFile(file, (ratio, stage) =>
          setImporting({ name: file.name, ratio, stage }),
        );
        await refresh();
      } catch (e) {
        setError(e instanceof Error ? e.message : '导入失败');
      } finally {
        setImporting(null);
      }
    },
    [refresh],
  );

  const handleDelete = useCallback(
    async (id: string) => {
      try { await deleteBook(id); await refresh(); }
      catch { setError('删除失败，请稍后重试'); }
    },
    [refresh],
  );

  const handleSettingsChange = useCallback((s: ReaderSettings) => {
    setSettings(s);
    saveSettings(s);
  }, []);

  return (
    <div className="app">
      {openBookId ? (
        <Reader
          key={openBookId}
          bookId={openBookId}
          settings={settings}
          onSettingsChange={handleSettingsChange}
          onExit={() => {
            setOpenBookId(null);
            void refresh().catch(() => setError('书架刷新失败，请刷新页面重试'));
          }}
        />
      ) : (
        <>
          <Bookshelf
            books={books}
            importing={importing}
            onImport={handleImport}
            onOpen={setOpenBookId}
            onDelete={handleDelete}
          />
          {error && (
            <div className="error-toast" role="alert" onClick={() => setError(null)}>
              {error}
            </div>
          )}
        </>
      )}
    </div>
  );
}
