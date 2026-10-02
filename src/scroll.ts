// 弹层打开时 iOS 需要固定 body；阅读器继续使用同一套逻辑文档坐标。
let locked: { y: number; restore: () => void } | null = null;
let scrollRevision = 0;

/** 区分应用主动定位与浏览器/用户滚动，避免把目录跳转等识别为意外回顶。 */
export function getScrollRevision(): number {
  return scrollRevision;
}

export function getScrollTop(): number {
  return locked?.y ?? Math.max(0, window.scrollY);
}

/**
 * 当前实际可见视口高度。
 * Safari 地址栏展开/收起时 visualViewport.height 反映真实可见区域；
 * 注意：高度变化只更新测量值，调用方才决定是否需要重新定位。
 */
export function getViewportHeight(): number {
  return window.visualViewport?.height ?? window.innerHeight;
}

export function getViewportWidth(): number {
  return window.visualViewport?.width ?? window.innerWidth;
}

export function scrollToY(y: number): void {
  scrollRevision++;
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
