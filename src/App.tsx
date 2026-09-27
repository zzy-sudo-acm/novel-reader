import { useCallback, useEffect, useState } from 'react';
import type { BookMeta } from './types';
import { deleteBook, getAllBooks } from './db';
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
    setBooks(await getAllBooks());
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

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
      await deleteBook(id);
      await refresh();
    },
    [refresh],
  );

  const handleSettingsChange = useCallback((s: ReaderSettings) => {
    setSettings(s);
    saveSettings(s);
  }, []);

  return (
    <div className="app" data-theme={openBookId ? settings.theme : 'white'}>
      {openBookId ? (
        <Reader
          bookId={openBookId}
          settings={settings}
          onSettingsChange={handleSettingsChange}
          onExit={() => {
            setOpenBookId(null);
            void refresh();
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
            <div className="error-toast" onClick={() => setError(null)}>
              {error}
            </div>
          )}
        </>
      )}
    </div>
  );
}
