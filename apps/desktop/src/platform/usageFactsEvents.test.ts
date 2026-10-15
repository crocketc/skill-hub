import { QueryClient } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { AppEvent } from "../api/bindings";
import { overviewKeys } from "../features/overview/api";
import { relationshipsKeys } from "../features/relationships/api";
import { skillDetailKeys } from "../features/skill-detail/api";
import { skillLibraryKeys } from "../features/skills/api";

const nativeEvents = vi.hoisted(() => ({ subscribe: vi.fn() }));
vi.mock("../api/bindings", () => ({ onAppEvent: nativeEvents.subscribe }));

import { onUsageFactsChanged, refreshAllFactViews } from "./usageFactsEvents";

afterEach(() => vi.clearAllMocks());

describe("onUsageFactsChanged", () => {
  it("forwards only verified facts_changed events and releases the native listener", async () => {
    let receiveNativeEvent: ((event: AppEvent) => void) | undefined;
    const unlisten = vi.fn();
    nativeEvents.subscribe.mockImplementation(async (listener: (event: AppEvent) => void) => {
      receiveNativeEvent = listener;
      return unlisten;
    });
    const onFactsChanged = vi.fn();

    const stop = await onUsageFactsChanged(onFactsChanged);
    receiveNativeEvent?.({ type: "operation_finished", payload: {} as never });
    receiveNativeEvent?.({
      type: "facts_changed",
      payload: {
        operation_id: null,
        skill_ids: ["skill-1"],
        entry_keys: [],
        environment_keys: [],
        problem_ids: [],
      },
    });

    expect(nativeEvents.subscribe).toHaveBeenCalledTimes(1);
    expect(onFactsChanged).toHaveBeenCalledTimes(1);
    expect(onFactsChanged).toHaveBeenCalledWith(expect.objectContaining({ skill_ids: ["skill-1"] }));
    stop();
    expect(unlisten).toHaveBeenCalledTimes(1);
  });

  it("refreshes bootstrap, pending, Agent, detail, governance, and graph projections together", async () => {
    const client = new QueryClient();
    const keys = [
      overviewKeys.root,
      [relationshipsKeys.root],
      skillDetailKeys.root,
      skillLibraryKeys.root,
    ];
    for (const key of keys) client.setQueryData(key, { stale: false });
    const refreshSnapshot = vi.fn(async () => undefined);

    await refreshAllFactViews(client, refreshSnapshot);

    for (const key of keys) {
      expect(client.getQueryState(key)?.isInvalidated).toBe(true);
    }
    expect(refreshSnapshot).toHaveBeenCalledTimes(1);
    client.clear();
  });
});
