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

export function resolveWindowChrome(): WindowChrome | null {
  if (!isTauriRuntime()) {
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

/**
 * macOS 专属样式开关：红绿灯按钮悬浮在内容上（titleBarStyle: Overlay），
 * 侧栏等区域需要留白避让；非 macOS 必须确保该类被移除。
 * userAgent 参数供测试注入，运行时读取 navigator。
 */
export function applyWindowChromePlatformClass(userAgent?: string): void {
  const source = userAgent ?? navigator.userAgent;
  document.documentElement.classList.toggle("sh-is-macos", source.includes("Mac"));
}
