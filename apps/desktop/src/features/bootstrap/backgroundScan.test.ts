import { expect, it, vi } from "vitest";
import type { ScanResult } from "../../api/bindings";
import type { InitializationScanState } from "./api";
import {
  beginBackgroundScan,
  getBackgroundScanState,
  resetBackgroundScan,
  subscribeBackgroundScan,
} from "./backgroundScan";

const scanResult: ScanResult = {
  generation: { generation: 1, observed_at: 1 },
  roots: ["C:\\Users\\Test\\.codex\\skills"],
  discovered: [],
  visited_paths: [],
  reparsed_count: 0,
  unchanged_count: 0,
  errors: [],
};

it("keeps a handed-off scan observable as scanning until the real promise settles", async () => {
  resetBackgroundScan();
  let resolve!: (value: InitializationScanState) => void;
  const scan = new Promise<InitializationScanState>((res) => {
    resolve = res;
  });

  beginBackgroundScan(scan, ["codex"]);
  expect(getBackgroundScanState().status).toBe("scanning");
  expect(getBackgroundScanState().scopeIds).toEqual(["codex"]);

  resolve({ kind: "completed", result: scanResult });
  await Promise.resolve();
  await Promise.resolve();

  expect(getBackgroundScanState().status).toBe("completed");
  expect(getBackgroundScanState().result?.roots).toEqual(scanResult.roots);
});

it("records a failed handed-off scan instead of fabricating completion", async () => {
  resetBackgroundScan();
  let reject!: (error: unknown) => void;
  const scan = new Promise<InitializationScanState>((_res, rej) => {
    reject = rej;
  });

  beginBackgroundScan(scan, []);
  reject({ code: "input.invalid" });
  await Promise.resolve();
  await Promise.resolve();

  const state = getBackgroundScanState();
  expect(state.status).toBe("failed");
  expect((state.error as { code?: string }).code).toBe("input.invalid");
});

it("ignores a settlement that arrives after the scan was reset or superseded", async () => {
  resetBackgroundScan();
  let resolve!: (value: InitializationScanState) => void;
  const scan = new Promise<InitializationScanState>((res) => {
    resolve = res;
  });
  beginBackgroundScan(scan, []);

  resetBackgroundScan();
  resolve({ kind: "completed", result: scanResult });
  await Promise.resolve();
  await Promise.resolve();

  expect(getBackgroundScanState().status).toBe("idle");
});

it("notifies subscribers on every state change and stops after unsubscribe", async () => {
  resetBackgroundScan();
  const listener = vi.fn();
  const unsubscribe = subscribeBackgroundScan(listener);

  beginBackgroundScan(Promise.resolve({ kind: "completed", result: scanResult }), []);
  await Promise.resolve();
  await Promise.resolve();
  expect(listener.mock.calls.length).toBeGreaterThanOrEqual(2);

  listener.mockClear();
  unsubscribe();
  resetBackgroundScan();
  expect(listener).not.toHaveBeenCalled();
});
