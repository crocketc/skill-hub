import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { type ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import type { UsageEnvironmentStatisticsSummary } from "../../api/bindings";
import type { RelationshipsFacade } from "../relationships/api";
import { useUsageEnvironmentStatistics } from "./deploymentNames";

const statistics: UsageEnvironmentStatisticsSummary = {
  real_agent_count: 3,
  shared_directory_count: 1,
  project_count: 2,
  physical_usage_count: 5,
  subject_count: 7,
  environments: [],
};

function facadeWith(query: () => Promise<UsageEnvironmentStatisticsSummary>): RelationshipsFacade {
  return { getUsageEnvironmentStatistics: vi.fn(query) } as unknown as RelationshipsFacade;
}

function wrapper() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  };
}

describe("useUsageEnvironmentStatistics", () => {
  it("loads the single backend statistics projection through the relationship facade", async () => {
    const query = vi.fn(async () => statistics);
    const facade = facadeWith(query);
    const { result } = renderHook(() => useUsageEnvironmentStatistics(facade), { wrapper: wrapper() });

    await waitFor(() => expect(result.current).toBe(statistics));
    expect(query).toHaveBeenCalledTimes(1);
  });

  it("does not invent zero statistics before the query resolves", () => {
    const facade = facadeWith(() => new Promise(() => {}));
    const { result } = renderHook(() => useUsageEnvironmentStatistics(facade), { wrapper: wrapper() });

    expect(result.current).toBeUndefined();
  });
});
