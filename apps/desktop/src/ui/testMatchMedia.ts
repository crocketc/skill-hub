import { vi } from "vitest";

type MediaListener = (event: { matches: boolean }) => void;

export interface ReducedMotionStub {
  setMatches: (matches: boolean) => void;
}

/**
 * 确定性的 matchMedia 测试替身：只识别 "(prefers-reduced-motion: reduce)"，
 * 其余查询一律返回 false。记录监听器以便测试驱动系统偏好变化。
 */
export function stubMatchMediaReducedMotion(initialMatches: boolean): ReducedMotionStub {
  const listeners = new Set<MediaListener>();
  const media = {
    matches: initialMatches,
    addEventListener: (_: string, listener: MediaListener) => {
      listeners.add(listener);
    },
    removeEventListener: (_: string, listener: MediaListener) => {
      listeners.delete(listener);
    },
  };
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockImplementation((query: string) => {
      if (query === "(prefers-reduced-motion: reduce)") {
        return media;
      }
      return { matches: false, addEventListener() {}, removeEventListener() {} };
    }),
  );
  return {
    setMatches(matches: boolean) {
      media.matches = matches;
      for (const listener of [...listeners]) listener({ matches });
    },
  };
}
