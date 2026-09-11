import { describe, expect, it } from "vitest";
import {
  type ScrollSyncEcho,
  applyScrollSync,
  computeSyncScrollRatio,
  ratioToScrollTop,
  readSyncScrollPreference,
  SYNC_SCROLL_STORAGE_KEY,
  writeSyncScrollPreference,
} from "./syncScroll";

describe("sync scroll ratios", () => {
  it("maps a source scrollTop to a 0..1 ratio and onto a differently sized target", () => {
    const ratio = computeSyncScrollRatio({
      clientHeight: 500,
      scrollHeight: 2000,
      scrollTop: 300,
    });
    expect(ratio).toBeCloseTo(0.2, 5);
    expect(
      ratioToScrollTop(ratio, /* clientHeight */ 400, /* scrollHeight */ 1600),
    ).toBeCloseTo(240, 5);
  });

  it("clamps out-of-range scroll positions to the 0 and 1 boundaries", () => {
    const geometry = { clientHeight: 500, scrollHeight: 2000 };
    expect(computeSyncScrollRatio({ ...geometry, scrollTop: 0 })).toBe(0);
    expect(computeSyncScrollRatio({ ...geometry, scrollTop: -10 })).toBe(0);
    expect(computeSyncScrollRatio({ ...geometry, scrollTop: 1500 })).toBe(1);
    expect(computeSyncScrollRatio({ ...geometry, scrollTop: 4000 })).toBe(1);
    expect(ratioToScrollTop(0, 500, 2000)).toBe(0);
    expect(ratioToScrollTop(1, 500, 2000)).toBe(1500);
    expect(ratioToScrollTop(1.5, 500, 2000)).toBe(1500);
  });

  it("treats a non-scrollable pane as ratio 0 and never offsets the target", () => {
    expect(
      computeSyncScrollRatio({ clientHeight: 500, scrollHeight: 500, scrollTop: 120 }),
    ).toBe(0);
    expect(ratioToScrollTop(0.5, 500, 400)).toBe(0);
  });

  it("keeps a same-pane round trip within one pixel so sync cannot drift", () => {
    const geometry = { clientHeight: 420, scrollHeight: 1900, scrollTop: 733 };
    const mapped = ratioToScrollTop(
      computeSyncScrollRatio(geometry),
      geometry.clientHeight,
      geometry.scrollHeight,
    );
    expect(Math.abs(mapped - geometry.scrollTop)).toBeLessThanOrEqual(1);
  });
});

describe("scroll sync echo guard", () => {
  const fakeElement = (scrollTop: number, clientHeight: number, scrollHeight: number) =>
    ({ clientHeight, scrollHeight, scrollTop }) as HTMLElement;

  it("consumes the programmatic echo so both panes cannot ping-pong", () => {
    const sourcePane = fakeElement(300, 500, 2000);
    const target = fakeElement(240, 400, 1600);
    const echo: { current: ScrollSyncEcho | null } = {
      current: { element: target, expectedTop: 240 },
    };

    // 程序化写入 target 后浏览器补发 scroll 事件：滚动源就是 target 本身。
    applyScrollSync({ echoRef: echo, source: target, target: sourcePane });

    // 回声被消费，不再驱动源面板，联动到此终止。
    expect(echo.current).toBeNull();
    expect(sourcePane.scrollTop).toBe(300);
  });

  it("ignores a stale echo once the user scrolled the target elsewhere", () => {
    const preview = fakeElement(900, 400, 1600);
    const sourcePane = fakeElement(300, 500, 2000);
    const echo: { current: ScrollSyncEcho | null } = {
      current: { element: preview, expectedTop: 240 },
    };

    // 回声记录的位置（240）与实际位置（900）不符：这是真实滚动，必须反向同步。
    applyScrollSync({ echoRef: echo, source: preview, target: sourcePane });

    // 900/1200 = 0.75 → 源面板 0.75 × 1500 = 1125。
    expect(sourcePane.scrollTop).toBe(1125);
    expect(echo.current?.element).toBe(sourcePane);
  });

  it("skips the write when the target already sits at the mapped position", () => {
    const target = fakeElement(240, 400, 1600);
    const echo: { current: ScrollSyncEcho | null } = { current: null };
    const source = fakeElement(300, 500, 2000);

    applyScrollSync({ echoRef: echo, source, target });

    // 不写入就不会产生新滚动事件：无回声、无循环。
    expect(target.scrollTop).toBe(240);
    expect(echo.current).toBeNull();
  });

  it("writes the mapped offset and records the expected echo", () => {
    const target = fakeElement(0, 400, 1600);
    const echo: { current: ScrollSyncEcho | null } = { current: null };
    const source = fakeElement(300, 500, 2000);

    applyScrollSync({ echoRef: echo, source, target });

    expect(target.scrollTop).toBeCloseTo(240, 0);
    expect(echo.current?.element).toBe(target);
    expect(echo.current?.expectedTop).toBeCloseTo(240, 0);
  });
});

describe("sync scroll preference", () => {
  it("defaults to enabled when nothing was stored", () => {
    expect(readSyncScrollPreference(undefined)).toBe(true);
  });

  it("persists the disabled choice and reads it back", () => {
    const store = new Map<string, string>();
    const storage = {
      getItem: (key: string) => store.get(key) ?? null,
      setItem: (key: string, value: string) => void store.set(key, value),
    };

    expect(readSyncScrollPreference(storage)).toBe(true);
    writeSyncScrollPreference(storage, false);
    expect(store.get(SYNC_SCROLL_STORAGE_KEY)).toBe("false");
    expect(readSyncScrollPreference(storage)).toBe(false);
    writeSyncScrollPreference(storage, true);
    expect(store.get(SYNC_SCROLL_STORAGE_KEY)).toBe("true");
    expect(readSyncScrollPreference(storage)).toBe(true);
  });

  it("falls back to enabled when the stored value is malformed", () => {
    expect(readSyncScrollPreference({ getItem: () => "yes" })).toBe(true);
    expect(readSyncScrollPreference({ getItem: () => null })).toBe(true);
  });

  it("swallows storage access failures and keeps the default", () => {
    expect(
      readSyncScrollPreference({
        getItem: () => {
          throw new Error("storage denied");
        },
      }),
    ).toBe(true);
    expect(() =>
      writeSyncScrollPreference(
        {
          getItem: () => null,
          setItem: () => {
            throw new Error("storage denied");
          },
        },
        false,
      ),
    ).not.toThrow();
  });
});
