import { useLayoutEffect, useRef, type ReactNode } from 'react';
import { lockDocumentScroll } from '../scroll';

export default function Sheet({ label, className, onClose, children }: {
  label: string; className: string; onClose: () => void; children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const unlock = lockDocumentScroll();
    const el = ref.current!;
    el.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.preventDefault(); closeRef.current(); }
      if (e.key !== 'Tab') return;
      const items = [...el.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]')];
      const first = items[0];
      const last = items[items.length - 1];
      if (!first) { e.preventDefault(); return; }
      const outside = !el.contains(document.activeElement);
      if (e.shiftKey && (document.activeElement === first || document.activeElement === el || outside)) {
        e.preventDefault(); last.focus({ preventScroll: true });
      } else if (!e.shiftKey && (document.activeElement === last || document.activeElement === el || outside)) {
        e.preventDefault(); first.focus({ preventScroll: true });
      }
    };
    // 保存中禁用当前按钮可能使焦点回到 body，Escape 和 Tab 仍应由当前弹层处理。
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      unlock();
      if (previous?.isConnected) previous.focus({ preventScroll: true });
    };
  }, []);
  return <div className="overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
    <div className={`sheet ${className}`} ref={ref} role="dialog" aria-modal="true" aria-label={label} tabIndex={-1}>
      {children}
    </div>
  </div>;
}
