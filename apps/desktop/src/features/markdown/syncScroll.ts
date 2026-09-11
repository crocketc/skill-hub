/**
 * 编辑/预览分屏的"行比例"同步滚动（P1-14）。
 *
 * 设计约束：联动不得形成循环抖动。这里用两个互相独立的机制收敛：
 * 1. 回声消费：程序化写入对侧 scrollTop 后，浏览器补发的 scroll 事件
 *    按写入位置识别并消费，不再驱动源面板；
 * 2. 原位跳过：目标已在映射位置（±1px 取整容差）时不写入——不写入就
 *    不会产生新滚动事件，联动链路自然终止。
 *
 * 不加防抖/帧节流：scroll 事件本身已与渲染帧对齐，写入是 O(1) 常量
 * 操作，且防循环不依赖任何时序，节流只会引入额外的观察窗口。
 */

export interface ScrollGeometry {
  clientHeight: number;
  scrollHeight: number;
  scrollTop: number;
}

export interface ScrollSyncEcho {
  element: HTMLElement;
  expectedTop: number;
}

/** 整数 scrollTop 取整带来的最大误差；容差内视为"已在目标位置/回声"。 */
const SYNC_TOLERANCE_PX = 1;

export const SYNC_SCROLL_STORAGE_KEY = "skillhub.markdownSyncScroll";

/** 滚动进度比例：0 = 顶部，1 = 底部；不可滚动时恒为 0。 */
export function computeSyncScrollRatio(geometry: ScrollGeometry): number {
  const scrollable = geometry.scrollHeight - geometry.clientHeight;
  if (scrollable <= 0) {
    return 0;
  }
  const ratio = geometry.scrollTop / scrollable;
  if (ratio <= 0) {
    return 0;
  }
  return ratio >= 1 ? 1 : ratio;
}

/** 反向映射：把源面板比例换算为目标面板的 scrollTop。 */
export function ratioToScrollTop(
  ratio: number,
  clientHeight: number,
  scrollHeight: number,
): number {
  const scrollable = scrollHeight - clientHeight;
  if (scrollable <= 0) {
    return 0;
  }
  const clamped = ratio <= 0 ? 0 : ratio >= 1 ? 1 : ratio;
  return clamped * scrollable;
}

export interface ScrollSyncOptions {
  echoRef: { current: ScrollSyncEcho | null };
  source: HTMLElement;
  target: HTMLElement;
}

/**
 * 处理一次 scroll 事件：识别回声、计算比例、按需写入对侧。
 * 由编辑器把两侧滚动容器接到同一个处理器上（双向都走这里）。
 */
export function applyScrollSync({ echoRef, source, target }: ScrollSyncOptions): void {
  const pending = echoRef.current;
  if (
    pending &&
    pending.element === source &&
    Math.abs(source.scrollTop - pending.expectedTop) <= SYNC_TOLERANCE_PX
  ) {
    echoRef.current = null;
    return;
  }
  echoRef.current = null;
  const nextTop = ratioToScrollTop(
    computeSyncScrollRatio({
      clientHeight: source.clientHeight,
      scrollHeight: source.scrollHeight,
      scrollTop: source.scrollTop,
    }),
    target.clientHeight,
    target.scrollHeight,
  );
  if (Math.abs(target.scrollTop - nextTop) <= SYNC_TOLERANCE_PX) {
    return;
  }
  echoRef.current = { element: target, expectedTop: nextTop };
  target.scrollTop = nextTop;
}

export interface SyncScrollStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/** 开关默认开启；存储缺失/损坏/拒绝访问都不影响编辑器可用。 */
export function readSyncScrollPreference(
  storage?: Pick<SyncScrollStorage, "getItem"> | null,
): boolean {
  if (!storage) {
    return true;
  }
  try {
    return storage.getItem(SYNC_SCROLL_STORAGE_KEY) !== "false";
  } catch {
    return true;
  }
}

export function writeSyncScrollPreference(storage: SyncScrollStorage, enabled: boolean): void {
  try {
    storage.setItem(SYNC_SCROLL_STORAGE_KEY, enabled ? "true" : "false");
  } catch {
    // 偏好写不进去只影响下次会话的默认值，不打断当前编辑。
  }
}
