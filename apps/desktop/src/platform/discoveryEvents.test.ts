import { afterEach, expect, it, vi } from "vitest";
import { queryClient } from "../app/queryClient";
import { notifyDiscoveryFactsChanged, onDiscoveryFactsChanged } from "./discoveryEvents";

afterEach(() => {
  vi.restoreAllMocks();
});

it("broadcasts discovery changes and invalidates relationship and overview facts", () => {
  const listener = vi.fn();
  const unsubscribe = onDiscoveryFactsChanged(listener);
  const invalidateQueries = vi.spyOn(queryClient, "invalidateQueries");

  notifyDiscoveryFactsChanged();

  expect(listener).toHaveBeenCalledTimes(1);
  expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["relationships"] });
  expect(invalidateQueries).toHaveBeenCalledWith({ queryKey: ["overview"] });
  unsubscribe();
});
