import { useEffect, useRef } from 'react';
import type { ReadingProgress } from '../types';
import { getScrollRevision, getScrollTop, getViewportHeight } from '../scroll';

interface Options {
  getPosition: () => ReadingProgress;
  isBlocked: () => boolean;
  onRecoverable: (position: ReadingProgress) => void;
}

interface Snapshot {
  y: number;
  revision: number;
  position: ReadingProgress;
}

/**
 * iOS 状态栏回顶没有网页可取消的 pointer 事件。
 * 为连续向上滚动超过三屏并到达顶部的动作保留起点，供用户主动返回。
 * 不抢夺原生滚动；普通短滑、布局补偿和应用内跳转不触发。
 */
export function useScrollTopRecovery(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const last = useRef<Snapshot | null>(null);
  const origin = useRef<Snapshot | null>(null);
  const idleTimer = useRef(0);

  function syncPosition() {
    const revision = getScrollRevision();
    if (latest.current.isBlocked()) {
      last.current = null;
      origin.current = null;
      return;
    }
    if (last.current?.revision !== revision) origin.current = null;
    last.current = { y: getScrollTop(), revision, position: latest.current.getPosition() };
  }

  function onScroll() {
    window.clearTimeout(idleTimer.current);
    const previous = last.current;
    const y = getScrollTop();
    if (latest.current.isBlocked() || !previous || previous.revision !== getScrollRevision()) {
      origin.current = null;
      syncPosition();
      return;
    }
    if (y < previous.y - 1 && !origin.current) origin.current = previous;
    if (y > previous.y + 1) origin.current = null;

    const start = origin.current;
    if (y <= 2 && start && start.y - y >= getViewportHeight() * 3) {
      origin.current = null;
      latest.current.onRecoverable(start.position);
    }
    // 保存坐标；本帧测量完阅读进度后，Reader 会再调用 syncPosition。
    last.current = { ...previous, y };
    idleTimer.current = window.setTimeout(() => {
      origin.current = null;
      syncPosition();
    }, 300);
  }

  useEffect(() => () => window.clearTimeout(idleTimer.current), []);

  return { onScroll, syncPosition };
}
