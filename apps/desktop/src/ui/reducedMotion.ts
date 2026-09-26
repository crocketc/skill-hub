import { useSyncExternalStore } from "react";

/**
 * SkillHub 减少动效偏好由应用内开关独立控制，不读取操作系统
 * `prefers-reduced-motion`，避免 Windows 动画设置覆盖应用内选择。
 */

export const REDUCED_MOTION_STORAGE_KEY = "skillhub.reduced-motion";
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

/** SkillHub 内减少动效的唯一开关；默认播放应用自身动效。 */
export function useSkillHubReducedMotion(): boolean {
  return useUserReducedMotion();
}
