import { useSyncExternalStore } from "react";

/**
 * M-04 减少动效偏好：有效减少动效 = 系统 `prefers-reduced-motion: reduce`
 * || 用户开关。用户开关走与 ThemeProvider 外观偏好同款的 localStorage 持久化
 * 模式（key 记录"用户显式开启"，缺省=跟随系统），经 useSyncExternalStore
 * 暴露——不需要 Provider，任何组件（设置页、抽屉、toast）都能直接消费。
 */

export const REDUCED_MOTION_STORAGE_KEY = "skillhub.reduced-motion";
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";

function readStoredUserPreference(): boolean {
  if (typeof window === "undefined") {
    return false;
  }
  try {
    return window.localStorage.getItem(REDUCED_MOTION_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

const userListeners = new Set<() => void>();

/** 用户开关：写入持久化偏好并即时广播（界面同步生效，无需刷新）。 */
export function setUserReducedMotion(value: boolean): void {
  try {
    if (value) {
      window.localStorage.setItem(REDUCED_MOTION_STORAGE_KEY, "true");
    } else {
      window.localStorage.removeItem(REDUCED_MOTION_STORAGE_KEY);
    }
  } catch {
    // 存储不可用时保留内存中的选择（对齐 ThemeProvider 的降级策略）。
  }
  for (const listener of [...userListeners]) {
    listener();
  }
}

function subscribeUserReducedMotion(listener: () => void): () => void {
  userListeners.add(listener);
  return () => {
    userListeners.delete(listener);
  };
}

export function useUserReducedMotion(): boolean {
  // getSnapshot 每次读存储：外部清理（如测试、多窗口）即时反映，无隐藏模块态。
  return useSyncExternalStore(subscribeUserReducedMotion, readStoredUserPreference);
}

function systemPrefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia(REDUCED_MOTION_QUERY).matches
  );
}

function subscribeSystemReducedMotion(listener: () => void): () => void {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => undefined;
  }
  const media = window.matchMedia(REDUCED_MOTION_QUERY);
  media.addEventListener("change", listener);
  return () => {
    media.removeEventListener("change", listener);
  };
}

/** 系统层的"减少动效"设置（TC-GR-09 M-04）。 */
export function useSystemPrefersReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeSystemReducedMotion,
    systemPrefersReducedMotion,
  );
}

/** 有效减少动效：系统开启或用户开关开启，二者取或。
 *  注意不能写 `a() || b()`：短路会在开关切换时跳过第二个 hook。 */
export function usePrefersReducedMotion(): boolean {
  const user = useUserReducedMotion();
  const system = useSystemPrefersReducedMotion();
  return user || system;
}
