import { afterEach, expect, it, vi } from "vitest";
import { observeChartContainerResize } from "./chartContainerResize";

afterEach(() => {
  vi.unstubAllGlobals();
});

it("resizes after its observed chart container settles and disconnects on cleanup", () => {
  let callback: ResizeObserverCallback | undefined;
  const disconnect = vi.fn();
  vi.stubGlobal(
    "ResizeObserver",
    class MockResizeObserver implements ResizeObserver {
      constructor(next: ResizeObserverCallback) {
        callback = next;
      }

      disconnect = disconnect;
      observe = vi.fn();
      unobserve = vi.fn();
    },
  );
  const queued: FrameRequestCallback[] = [];
  vi.stubGlobal("requestAnimationFrame", vi.fn((next: FrameRequestCallback) => {
    queued.push(next);
    return queued.length;
  }));
  vi.stubGlobal("cancelAnimationFrame", vi.fn());
  const resize = vi.fn();
  const element = document.createElement("div");

  const stop = observeChartContainerResize(element, resize);
  expect(resize).not.toHaveBeenCalled();

  callback?.([], {} as ResizeObserver);
  expect(queued).toHaveLength(1);
  queued.shift()?.(0);
  expect(resize).toHaveBeenCalledTimes(1);

  callback?.([], {} as ResizeObserver);
  queued.shift()?.(1);
  expect(resize).toHaveBeenCalledTimes(2);

  stop();
  expect(disconnect).toHaveBeenCalledTimes(1);
});
