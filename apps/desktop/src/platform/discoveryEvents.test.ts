import { afterEach, expect, it, vi } from "vitest";
import { queryClient } from "../app/queryClient";
import { relationshipsKeys } from "../features/relationships/api";
import { notifyDiscoveryFactsChanged, onDiscoveryFactsChanged } from "./discoveryEvents";

afterEach(() => {
  vi.restoreAllMocks();
  queryClient.clear();
});

it("broadcasts discovery changes and invalidates relationship and overview facts", () => {
  const listener = vi.fn();
  const governanceKey = relationshipsKeys.governance();
  queryClient.setQueryData(governanceKey, { rows: [] });
  const unsubscribe = onDiscoveryFactsChanged(listener);
  const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");

  notifyDiscoveryFactsChanged();

  expect(listener).toHaveBeenCalledTimes(1);
  expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: [relationshipsKeys.root] });
  expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["overview"] });
  expect(queryClient.getQueryState(governanceKey)?.isInvalidated).toBe(true);
  unsubscribe();
});
