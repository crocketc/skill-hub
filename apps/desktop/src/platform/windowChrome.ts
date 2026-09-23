import { getCurrentWindow } from "@tauri-apps/api/window";

/**
 * 自绘窗口控制按钮的平台封装。所有方法只在 Tauri 运行时可用；
 * 浏览器、e2e（纯浏览器预览）与单测环境必须拿到 null 且完全不触碰
 * Tauri API，让消费方（WindowControls）自动无痕。
 */
export interface WindowChrome {
  minimize: () => Promise<void>;
  toggleMaximize: () => Promise<void>;
  close: () => Promise<void>;
  isMaximized: () => Promise<boolean>;
  /**
   * 订阅最大化状态变化：内部挂在窗口 resize 事件上，触发时重查
   * isMaximized（Tauri 没有专门的最大化事件）。返回取消订阅函数。
   */
  onMaximizeChange: (
    listener: (maximized: boolean) => void,
  ) => Promise<() => void>;
}

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export function isMacOSPlatform(
  userAgent = typeof navigator !== "undefined" ? navigator.userAgent : "",
  platform = typeof navigator !== "undefined" ? navigator.platform : "",
): boolean {
  return /Macintosh|Mac OS X/i.test(userAgent) || /^Mac/i.test(platform);
}

export function resolveWindowChrome(): WindowChrome | null {
  if (!isTauriRuntime() || isMacOSPlatform()) {
    return null;
  }
  const currentWindow = getCurrentWindow();
  return {
    minimize: () => currentWindow.minimize(),
    toggleMaximize: () => currentWindow.toggleMaximize(),
    close: () => currentWindow.close(),
    isMaximized: () => currentWindow.isMaximized(),
    onMaximizeChange: async (listener) => {
      const unlisten = await currentWindow.onResized(async () => {
        listener(await currentWindow.isMaximized());
      });
      return unlisten;
    },
  };
}

const maximizedWindowClass = "sh-is-window-maximized";

function applyWindowMaximizedClass(maximized: boolean): void {
  if (typeof document === "undefined") {
    return;
  }
  const wasMaximized = document.documentElement.classList.contains(maximizedWindowClass);
  document.documentElement.classList.toggle(
    maximizedWindowClass,
    maximized,
  );
  // 图表运行时根据 resize 更新 SVG 尺寸；最大化状态切换会改变可用轨道，
  // 所以在样式类写入后通知它们重新量尺，避免旧 SVG 尺寸溢出新容器。
  if (wasMaximized !== maximized && typeof window !== "undefined") {
    window.dispatchEvent(new Event("resize"));
  }
}

/**
 * 将原生窗口的最大化状态映射为根节点样式类。
 *
 * 这和 Windows 自绘控制按钮不同：macOS 同样需要该状态来选择概览的
 * “填满页面”布局。因此不能复用只针对 Windows 的 resolveWindowChrome。
 * 浏览器预览/测试环境显式移除遗留标记，维持普通窗口的自然文档流。
 */
export async function observeWindowMaximizedClass(): Promise<() => void> {
  if (!isTauriRuntime()) {
    applyWindowMaximizedClass(false);
    return () => {};
  }

  const currentWindow = getCurrentWindow();
  const syncMaximizedState = async () => {
    applyWindowMaximizedClass(await currentWindow.isMaximized());
  };

  await syncMaximizedState();
  return currentWindow.onResized(() => {
    void syncMaximizedState();
  });
}

/**
 * macOS 专属样式开关：红绿灯按钮悬浮在内容上（titleBarStyle: Overlay），
 * 侧栏等区域需要留白避让；非 macOS 必须确保该类被移除。
 * userAgent 参数供测试注入，运行时读取 navigator。
 */
export function applyWindowChromePlatformClass(userAgent?: string): void {
  const source = userAgent ?? navigator.userAgent;
  document.documentElement.classList.toggle("sh-is-macos", source.includes("Mac"));
}
