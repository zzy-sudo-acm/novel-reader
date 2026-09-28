import { useEffect, useRef } from 'react';

interface Options {
  /** 宽度变化立即调用（用于冻结阅读锚点） */
  onWidthChange: () => void;
  /** 宽度变化防抖 150ms 后调用（用于重新锚定） */
  onSettled: () => void;
}

/**
 * 视口监听。
 * 关键语义：Safari 地址栏展开/收起只改变高度——只更新测量、不重定位；
 * 只有宽度变化（横竖屏切换）才触发冻结 + 防抖后的重新锚定。
 */
export function useReaderViewport(active: boolean, { onWidthChange, onSettled }: Options) {
  const cb = useRef({ onWidthChange, onSettled });
  cb.current = { onWidthChange, onSettled };

  useEffect(() => {
    if (!active) return;
    let w = window.innerWidth;
    let timer = 0;
    const onResize = () => {
      if (window.innerWidth === w) return;
      w = window.innerWidth;
      cb.current.onWidthChange();
      window.clearTimeout(timer);
      timer = window.setTimeout(() => cb.current.onSettled(), 150);
    };
    window.addEventListener('resize', onResize);
    window.visualViewport?.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      window.visualViewport?.removeEventListener('resize', onResize);
      window.clearTimeout(timer);
    };
  }, [active]);
}
