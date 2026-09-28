// 弹层打开时 iOS 需要固定 body；阅读器继续使用同一套逻辑文档坐标。
let locked: { y: number; restore: () => void } | null = null;

export function getScrollTop(): number {
  return locked?.y ?? Math.max(0, window.scrollY);
}

export function scrollToY(y: number): void {
  const height = locked ? document.body.scrollHeight : document.documentElement.scrollHeight;
  const target = Math.max(0, Math.min(y, height - window.innerHeight));
  if (locked) {
    locked.y = target;
    document.body.style.top = `${-target}px`;
  } else window.scrollTo({ top: target, behavior: 'instant' });
}

export function lockDocumentScroll(): () => void {
  if (locked) return () => {};
  const y = getScrollTop();
  const body = document.body;
  const previous = { position: body.style.position, top: body.style.top, width: body.style.width, overflow: body.style.overflow };
  const width = document.documentElement.clientWidth;
  let viewportWidth = window.innerWidth;
  const onResize = () => {
    if (window.innerWidth === viewportWidth) return;
    viewportWidth = window.innerWidth;
    body.style.width = `${document.documentElement.clientWidth}px`;
  };
  locked = { y, restore: () => Object.assign(body.style, previous) };
  Object.assign(body.style, { position: 'fixed', top: `${-y}px`, width: `${width}px`, overflow: 'hidden' });
  window.addEventListener('resize', onResize);
  return () => {
    window.removeEventListener('resize', onResize);
    if (!locked) return;
    const target = locked.y;
    locked.restore();
    locked = null;
    scrollToY(target);
  };
}
