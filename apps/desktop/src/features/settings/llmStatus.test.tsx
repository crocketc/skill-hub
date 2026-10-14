import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { expect, it } from "vitest";
import type { LlmRuntimeStatus } from "./llmApi";
import {
  evaluateLlmCapability,
  invalidateLlmStatus,
  llmStatusQueryKey,
  useLlmCapability,
  useLlmStatus,
  type LlmStatusSnapshot,
} from "./llmStatus";

const allCapabilitiesOn = {
  safety_check: true,
  semantic_duplicate: true,
  description_translation: true,
  online_search_assist: true,
};

function runtimeProvider(
  overrides: Partial<NonNullable<LlmRuntimeStatus["provider"]>> = {},
): NonNullable<LlmRuntimeStatus["provider"]> {
  return {
    id: "provider-a",
    deployment: "online",
    endpoint_configured: true,
    model_configured: true,
    credential_configured: true,
    last_connection_test: {
      service_ok: true,
      model_ok: true,
      structured_ok: true,
      tested_at: "2026-10-15T00:00:00Z",
    },
    ...overrides,
  };
}

function snapshot(provider: NonNullable<LlmRuntimeStatus["provider"]> | null = runtimeProvider()): LlmStatusSnapshot {
  return {
    runtimeStatus: {
      provider,
      capabilities: allCapabilitiesOn,
      ai_output_language: "system",
      runner_available: true,
    },
  };
}

it.each([
  ["ready when the backend-selected provider passes the required model test", snapshot(), {}, "ready"],
  ["does not require structured output for model-only tasks", snapshot(runtimeProvider({
    last_connection_test: { service_ok: true, model_ok: true, structured_ok: false, tested_at: "now" },
  })), { requiredTestLevel: "model" }, "ready"],
  ["reports no selected provider rather than guessing from configured providers", snapshot(null), {}, "provider_unselected"],
  ["requires endpoint and model configuration", snapshot(runtimeProvider({ model_configured: false })), {}, "provider_incomplete"],
  ["requires a credential for the selected remote provider", snapshot(runtimeProvider({ credential_configured: false })), {}, "credential_missing"],
  ["requires a fresh successful model check", snapshot(runtimeProvider({ last_connection_test: null })), {}, "connection_unverified"],
  ["requires structured output only for tasks that need it", snapshot(runtimeProvider({
    last_connection_test: { service_ok: true, model_ok: true, structured_ok: false, tested_at: "now" },
  })), { requiredTestLevel: "structured" }, "structured_output_unverified"],
  ["blocks when the runtime runner is unavailable", {
    ...snapshot(),
    runtimeStatus: { ...snapshot().runtimeStatus, runner_available: false },
  }, {}, "provider_unavailable"],
  ["keeps an independent capability switch authoritative", {
    ...snapshot(),
    runtimeStatus: {
      ...snapshot().runtimeStatus,
      capabilities: { ...allCapabilitiesOn, safety_check: false },
    },
  }, {}, "capability_disabled"],
  ["reports unmet operation prerequisites", snapshot(), { preconditionsMet: false }, "preconditions_missing"],
] as const)("%s", (_name, current, options, expected) => {
  const result = evaluateLlmCapability(current, "safety_check", options);
  if (expected === "ready") {
    expect(result.ready).toBe(true);
    expect(result.reasons).toEqual([]);
  } else {
    expect(result.reasons).toContain(expected);
  }
});

it("allows a local selected provider without a stored credential when its task test passes", () => {
  const local = runtimeProvider({ deployment: "local", credential_configured: false });
  expect(evaluateLlmCapability(snapshot(local), "description_translation").ready).toBe(true);
});

it("does not mark shared status available while a read is pending or failed", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const pendingFacade = {
    readRuntimeStatus: () => new Promise<LlmRuntimeStatus>(() => {}),
  } as never;
  const pending = renderHook(() => useLlmStatus(pendingFacade), { wrapper });
  expect(pending.result.current.isLoading).toBe(true);
  expect(pending.result.current.data).toBeUndefined();
  pending.unmount();
  client.clear();

  const failedFacade = {
    async readRuntimeStatus() {
      throw new Error("local settings unavailable");
    },
  } as never;
  const failed = renderHook(() => useLlmStatus(failedFacade), { wrapper });
  await waitFor(() => expect(failed.result.current.isError).toBe(true));
  expect(failed.result.current.data).toBeUndefined();
  failed.unmount();
  client.clear();
});

it("does not reuse cached readiness while refreshing or after the refresh fails", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  client.setQueryData(llmStatusQueryKey, snapshot());
  const facade = {
    async readRuntimeStatus() {
      throw new Error("settings read failed");
    },
  } as never;

  const result = renderHook(
    () => useLlmCapability(facade, "description_translation"),
    { wrapper },
  );
  expect(result.result.current.state).toBe("loading");
  expect(result.result.current.readiness).toBeUndefined();

  await waitFor(() => expect(result.result.current.state).toBe("error"));
  expect(result.result.current.readiness).toBeUndefined();
  result.unmount();
  client.clear();
});

it("keeps the four capability switches independent", () => {
  const capabilities = [
    "safety_check",
    "semantic_duplicate",
    "description_translation",
    "online_search_assist",
  ] as const;
  for (const disabled of capabilities) {
    const current = snapshot();
    const altered = {
      ...current,
      runtimeStatus: {
        ...current.runtimeStatus,
        capabilities: { ...allCapabilitiesOn, [disabled]: false },
      },
    };
    expect(evaluateLlmCapability(altered, disabled).reasons).toContain("capability_disabled");
    for (const other of capabilities.filter((item) => item !== disabled)) {
      expect(evaluateLlmCapability(altered, other).ready).toBe(true);
    }
  }
});

it("shares one read-only status query and refreshes active consumers after invalidation", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let statusReads = 0;
  const facade = {
    async readRuntimeStatus() {
      statusReads += 1;
      return snapshot().runtimeStatus;
    },
  } as never;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const { result } = renderHook(() => useLlmStatus(facade), { wrapper });
  await waitFor(() => expect(result.current.data?.runtimeStatus.provider?.id).toBe("provider-a"));
  expect(statusReads).toBe(1);

  await invalidateLlmStatus(client);
  await waitFor(() => expect(statusReads).toBe(2));
  expect(result.current.data?.runtimeStatus.capabilities).toEqual(allCapabilitiesOn);
  expect(client.getQueryCache().find({ queryKey: llmStatusQueryKey })).toBeDefined();
});

it("uses an invalidated cached status again for a later page entry", async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  let statusReads = 0;
  const facade = {
    async readRuntimeStatus() {
      statusReads += 1;
      return snapshot().runtimeStatus;
    },
  } as never;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  const first = renderHook(() => useLlmStatus(facade), { wrapper });
  await waitFor(() => expect(first.result.current.isSuccess).toBe(true));
  first.unmount();
  await invalidateLlmStatus(client);

  const second = renderHook(() => useLlmStatus(facade), { wrapper });
  await waitFor(() => expect(second.result.current.isSuccess).toBe(true));
  expect(statusReads).toBe(2);
  second.unmount();
  client.clear();
});
