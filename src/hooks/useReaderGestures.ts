import { useRef } from 'react';
import type React from 'react';
import { getScrollTop, getViewportHeight } from '../scroll';

interface Options {
  /** 轻点屏幕中央时调用（切换菜单） */
  onTap: () => void;
  /** 弹层打开等场景返回 true，禁止触发 */
  isBlocked: () => boolean;
  /** 手指或惯性滚动中返回 true，此时按下不视为有效点击 */
  isScrolling: () => boolean;
  /** 手势结束（抬起/取消）时调用，用于调度空闲后的窗口同步 */
  onRelease?: () => void;
}

/**
 * 阅读区手势：区分轻点与滑动。
 * 只有位移 < 8px、时长 < 500ms、期间没有滚动、位置在屏幕中央区域、
 * 且没有选中文字时才算一次「轻点」。
 */
export function useReaderGestures({ onTap, isBlocked, isScrolling, onRelease }: Options) {
  const gestureRef = useRef<{
    id: number;
    x: number;
    y: number;
    scroll: number;
    time: number;
    valid: boolean;
  } | null>(null);

  const onPointerDown = (e: React.PointerEvent) => {
    if (!e.isPrimary) {
      if (gestureRef.current) gestureRef.current.valid = false;
      return;
    }
    gestureRef.current = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      scroll: getScrollTop(),
      time: performance.now(),
      valid: !isScrolling(),
    };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const g = gestureRef.current;
    if (g && (Math.abs(g.x - e.clientX) > 8 || Math.abs(g.y - e.clientY) > 8)) g.valid = false;
  };

  const onPointerUp = () => {
    onRelease?.();
  };

  const onPointerCancel = () => {
    if (gestureRef.current) gestureRef.current.valid = false;
    onRelease?.();
  };

  const onClick = (e: React.MouseEvent) => {
    const g = gestureRef.current;
    if (
      !isBlocked() &&
      g?.valid &&
      performance.now() - g.time < 500 &&
      Math.abs(getScrollTop() - g.scroll) < 4 &&
      e.clientX > window.innerWidth * 0.15 &&
      e.clientX < window.innerWidth * 0.85 &&
      e.clientY > getViewportHeight() * 0.15 &&
      e.clientY < getViewportHeight() * 0.85 &&
      !window.getSelection()?.toString()
    ) {
      onTap();
    }
  };

  return { onPointerDown, onPointerMove, onPointerUp, onPointerCancel, onClick };
}
