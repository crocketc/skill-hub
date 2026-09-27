import { expect, it, vi } from "vitest";
import { createStore } from "./usePendingItems";
import { createOperationTracker } from "../../platform/operationTracker";
import { emitPendingFactsChanged } from "../../platform/pendingEvents";
import type { PendingItem } from "./api";

it("shares reads between subscribers and refreshes after an instant operation", async () => {
  const list = vi.fn().mockResolvedValue([{ id: "one", kind: "trial_due" }]);
  const store = createStore({ list }, createOperationTracker());
  const stopA = store.subscribe(vi.fn());
  const stopB = store.subscribe(vi.fn());
  await vi.waitFor(() => expect(store.getSnapshot().items).toHaveLength(1));
  expect(list).toHaveBeenCalledTimes(1);
  list.mockResolvedValue([]);
  emitPendingFactsChanged();
  await vi.waitFor(() => expect(store.getSnapshot().items).toEqual([]));
  expect(list).toHaveBeenCalledTimes(2);
  stopA(); stopB();
});

it("retains only unavailable groups on partial refresh and keeps last data on total failure", async () => {
  const recovery = { id: "recovery", kind: "recovery" } as PendingItem;
  const conflict = { id: "conflict", kind: "conflict" } as PendingItem;
  const workspace = vi.fn().mockResolvedValue({ items: [recovery, conflict], unavailableSources: [] });
  const store = createStore({ list: vi.fn(), workspace }, createOperationTracker());
  const stop = store.subscribe(vi.fn());
  await vi.waitFor(() => expect(store.getSnapshot().items).toHaveLength(2));
  workspace.mockResolvedValue({ items: [], unavailableSources: ["recovery"] }); store.reload();
  await vi.waitFor(() => expect(store.getSnapshot().items).toEqual([recovery]));
  expect(store.getSnapshot().unavailableSources).toEqual(["recovery"]);
  workspace.mockRejectedValue(new Error("offline")); store.reload();
  await vi.waitFor(() => expect(store.getSnapshot().error).toBeDefined());
  expect(store.getSnapshot().items).toEqual([recovery]);
  stop();
});
