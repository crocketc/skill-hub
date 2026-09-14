import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const getCurrentWindow = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow,
}));

import {
  applyWindowChromePlatformClass,
  isMacOSPlatform,
  resolveWindowChrome,
} from "./windowChrome";

interface ResizeHandler {
  (event?: unknown): void | Promise<void>;
}

interface WindowInstance {
  minimize: ReturnType<typeof vi.fn>;
  toggleMaximize: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
  isMaximized: ReturnType<typeof vi.fn>;
  onResized: ReturnType<typeof vi.fn>;
  emitResize: () => Promise<void>;
  unlistens: Array<ReturnType<typeof vi.fn>>;
}

function createWindowInstance(): WindowInstance {
  const handlers: ResizeHandler[] = [];
  const unlistens: Array<ReturnType<typeof vi.fn>> = [];
  return {
    minimize: vi.fn(async () => {}),
    toggleMaximize: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    isMaximized: vi.fn(async () => false),
    onResized: vi.fn(async (handler: ResizeHandler) => {
      handlers.push(handler);
      const unlisten = vi.fn();
      unlistens.push(unlisten);
      return unlisten;
    }),
    emitResize: async () => {
      for (const handler of handlers) {
        await handler();
      }
    },
    unlistens,
  };
}

function enableTauriRuntime(instance: WindowInstance): void {
  (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__ = {};
  getCurrentWindow.mockReturnValue(instance);
}

beforeEach(() => {
  getCurrentWindow.mockReset();
  document.documentElement.className = "";
});

afterEach(() => {
  delete (window as unknown as Record<string, unknown>).__TAURI_INTERNALS__;
  document.documentElement.className = "";
});

describe("resolveWindowChrome", () => {
  it("returns null outside Tauri without touching the Tauri API", () => {
    expect("__TAURI_INTERNALS__" in window).toBe(false);

    const chrome = resolveWindowChrome();

    expect(chrome).toBeNull();
    expect(getCurrentWindow).not.toHaveBeenCalled();
  });

  it("returns null on macOS so the system traffic lights remain the only window controls", () => {
    const instance = createWindowInstance();
    enableTauriRuntime(instance);
    vi.stubGlobal("navigator", {
      userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)",
      platform: "MacIntel",
    });

    try {
      expect(resolveWindowChrome()).toBeNull();
      expect(getCurrentWindow).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("maps the action methods onto the current Tauri window", async () => {
    const instance = createWindowInstance();
    enableTauriRuntime(instance);
    const chrome = resolveWindowChrome();
    expect(chrome).not.toBeNull();

    await chrome?.minimize();
    await chrome?.toggleMaximize();
    await chrome?.close();

    expect(instance.minimize).toHaveBeenCalledTimes(1);
    expect(instance.toggleMaximize).toHaveBeenCalledTimes(1);
    expect(instance.close).toHaveBeenCalledTimes(1);
  });

  it("reads the maximized state through the window API", async () => {
    const instance = createWindowInstance();
    enableTauriRuntime(instance);
    instance.isMaximized.mockResolvedValue(true);
    const chrome = resolveWindowChrome();

    await expect(chrome?.isMaximized()).resolves.toBe(true);
    expect(instance.isMaximized).toHaveBeenCalledTimes(1);
  });

  it("re-queries isMaximized on resize events and forwards it to the listener", async () => {
    const instance = createWindowInstance();
    enableTauriRuntime(instance);
    const chrome = resolveWindowChrome();
    const listener = vi.fn();
    const unlisten = await chrome?.onMaximizeChange(listener);

    instance.isMaximized.mockResolvedValue(true);
    await instance.emitResize();

    expect(listener).toHaveBeenCalledWith(true);
    expect(instance.isMaximized).toHaveBeenCalled();

    instance.isMaximized.mockResolvedValue(false);
    await instance.emitResize();
    expect(listener).toHaveBeenLastCalledWith(false);

    unlisten?.();
    expect(instance.unlistens[0]).toHaveBeenCalledTimes(1);
  });

  it("unsubscribes each resize subscription through its own unlisten", async () => {
    const instance = createWindowInstance();
    enableTauriRuntime(instance);
    const chrome = resolveWindowChrome();
    const first = await chrome?.onMaximizeChange(vi.fn());
    const second = await chrome?.onMaximizeChange(vi.fn());

    expect(first).not.toBe(second);

    first?.();
    second?.();
    expect(instance.unlistens[0]).toHaveBeenCalledTimes(1);
    expect(instance.unlistens[1]).toHaveBeenCalledTimes(1);
  });
});

describe("applyWindowChromePlatformClass", () => {
  it("marks the document as macOS when the user agent is a Mac", () => {
    applyWindowChromePlatformClass(
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15",
    );

    expect(document.documentElement.classList.contains("sh-is-macos")).toBe(
      true,
    );
  });

  it("removes the macOS marker for non-Mac user agents", () => {
    document.documentElement.classList.add("sh-is-macos");

    applyWindowChromePlatformClass(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    );

    expect(document.documentElement.classList.contains("sh-is-macos")).toBe(
      false,
    );
  });

  it("falls back to the navigator user agent when none is provided", () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Macintosh) Test" });

    try {
      applyWindowChromePlatformClass();
      expect(document.documentElement.classList.contains("sh-is-macos")).toBe(
        true,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("isMacOSPlatform", () => {
  it("recognizes the macOS user agent and platform", () => {
    expect(
      isMacOSPlatform(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)",
        "MacIntel",
      ),
    ).toBe(true);
  });

  it("does not classify Windows as macOS", () => {
    expect(
      isMacOSPlatform(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64)",
        "Win32",
      ),
    ).toBe(false);
  });
});
