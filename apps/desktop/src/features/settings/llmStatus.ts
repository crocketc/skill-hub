import {
  useQuery,
  type QueryClient,
  type UseQueryResult,
} from "@tanstack/react-query";
import type { LlmAdminFacade, LlmCapabilitySettings, LlmRuntimeStatus } from "./llmApi";

export const llmStatusQueryKey = ["llm", "shared-status"] as const;

export type LlmStatusSnapshot = {
  runtimeStatus: LlmRuntimeStatus;
};

export type LlmCapabilityName = keyof LlmCapabilitySettings;
export type LlmRequiredTestLevel = "model" | "structured";

export type LlmCapabilityBlockReason =
  | "preconditions_missing"
  | "provider_unselected"
  | "provider_unavailable"
  | "provider_incomplete"
  | "credential_missing"
  | "connection_unverified"
  | "structured_output_unverified"
  | "capability_disabled";

export type LlmCapabilityReadiness = {
  ready: boolean;
  providerId: string | null;
  reasons: LlmCapabilityBlockReason[];
};

export type LlmCapabilityState = {
  state: "loading" | "error" | "blocked" | "ready";
  readiness?: LlmCapabilityReadiness;
  query: UseQueryResult<LlmStatusSnapshot, Error>;
};

/** Read the exact backend-selected provider and capability switches together.
 * This local-only query never invokes an AI task or sends skill data. */
export async function readLlmStatus(
  facade: Pick<LlmAdminFacade, "readRuntimeStatus">,
): Promise<LlmStatusSnapshot> {
  return { runtimeStatus: await facade.readRuntimeStatus() };
}

/** All open AI consumers use this same query key and source of truth. */
export function useLlmStatus(
  facade: Pick<LlmAdminFacade, "readRuntimeStatus">,
  options: { enabled?: boolean } = {},
): UseQueryResult<LlmStatusSnapshot, Error> {
  return useQuery({
    enabled: options.enabled ?? true,
    queryKey: llmStatusQueryKey,
    queryFn: () => readLlmStatus(facade),
    refetchOnMount: "always",
    retry: false,
    staleTime: 0,
  });
}

/** Cached readiness is never authoritative during a refresh or after a failed read. */
export function useLlmCapability(
  facade: Pick<LlmAdminFacade, "readRuntimeStatus">,
  capability: LlmCapabilityName,
  options: {
    enabled?: boolean;
    requiredTestLevel?: LlmRequiredTestLevel;
    preconditionsMet?: boolean;
  } = {},
): LlmCapabilityState {
  const query = useLlmStatus(facade, options);
  if (query.isFetching || query.isPending) {
    return { state: "loading", query };
  }
  if (query.isError) return { state: "error", query };
  if (!query.data) return { state: "loading", query };

  const readiness = evaluateLlmCapability(query.data, capability, options);
  return {
    state: readiness.ready ? "ready" : "blocked",
    readiness,
    query,
  };
}

/** Refresh every open consumer after a successful provider or capability edit.
 * Inactive consumers refetch the snapshot when they open. */
export function invalidateLlmStatus(queryClient: Pick<QueryClient, "invalidateQueries">): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: llmStatusQueryKey }).then(() => undefined);
}

/** Evaluate task readiness against the exact model the backend will use.
 * UI state must never substitute a different configured provider. */
export function evaluateLlmCapability(
  snapshot: LlmStatusSnapshot,
  capability: LlmCapabilityName,
  options: { requiredTestLevel?: LlmRequiredTestLevel; preconditionsMet?: boolean } = {},
): LlmCapabilityReadiness {
  const reasons: LlmCapabilityBlockReason[] = [];
  const runtime = snapshot.runtimeStatus;
  const provider = runtime.provider;

  if (options.preconditionsMet === false) reasons.push("preconditions_missing");
  if (!provider) {
    reasons.push("provider_unselected");
  } else if (!runtime.runner_available) {
    reasons.push("provider_unavailable");
  } else if (!provider.endpoint_configured || !provider.model_configured) {
    reasons.push("provider_incomplete");
  } else if (provider.deployment === "online" && !provider.credential_configured) {
    reasons.push("credential_missing");
  } else {
    const test = provider.last_connection_test;
    if (!test?.service_ok || !test.model_ok) {
      reasons.push("connection_unverified");
    } else if (options.requiredTestLevel === "structured" && test.structured_ok !== true) {
      reasons.push("structured_output_unverified");
    }
  }

  if (runtime.capabilities[capability] !== true) reasons.push("capability_disabled");
  return {
    ready: reasons.length === 0,
    providerId: provider?.id ?? null,
    reasons,
  };
}
