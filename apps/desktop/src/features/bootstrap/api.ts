import {
  executeCommand,
  queryApplication,
  type BootstrapSnapshot,
  type OperationPhase,
} from "../../api/bindings";

export type BootstrapVerificationState =
  | { kind: "unavailable" }
  | { kind: "verifying" };

export interface BootstrapView {
  snapshot: BootstrapSnapshot;
  verification: BootstrapVerificationState;
}

export type InitializationScanState =
  | { kind: "completed" }
  | { kind: "in_progress"; operationId: string; phase: OperationPhase };

export interface BootstrapRuntime {
  getBootstrapView: () => Promise<BootstrapView>;
  runInitializationScan: (scopeIds: string[]) => Promise<InitializationScanState>;
}

export interface CompleteOnboardingInput {
  libraryPath: string;
  skipped: boolean;
}

/**
 * These operations deliberately remain injected until their native contracts
 * are generated. The renderer never substitutes a filesystem implementation.
 */
export interface OnboardingOperations {
  completeOnboarding: (input: CompleteOnboardingInput) => Promise<void>;
  discoverAgents: () => Promise<CompatibilityDiscoveryResult>;
}

export interface CompatibilityTarget {
  id: string;
  label: string;
  availability: "available" | "unavailable";
}

export interface CompatibilityDiscoveryResult {
  targets: CompatibilityTarget[];
}

function unavailable(operation: string): Promise<never> {
  return Promise.reject(
    new Error(`${operation} is unavailable until its native contract is generated.`),
  );
}

export const unavailableOnboardingOperations: OnboardingOperations = {
  completeOnboarding: () => unavailable("complete_onboarding"),
  discoverAgents: () => unavailable("discover_agents"),
};

export const desktopOnboardingOperations: OnboardingOperations = {
  async completeOnboarding(input) {
    const result = await executeCommand({
      type: "complete_onboarding",
      payload: {
        library_path: input.libraryPath,
        skipped: input.skipped,
      },
    });
    if (result.type !== "initialization_status") {
      throw new Error("Unexpected onboarding response from the native application.");
    }
  },
  async discoverAgents() {
    const result = await executeCommand({
      type: "discover_agent_targets",
      payload: null,
    });
    if (result.type !== "discovery_snapshot") {
      throw new Error("Unexpected Agent discovery response from the native application.");
    }
    return {
      targets: result.payload.instances.map((instance) => ({
        id: `${instance.profile_id}:${instance.client_id}`,
        label: instance.client_id,
        availability: result.payload.logical_targets.some(
          (target) =>
            target.profile_id === instance.profile_id &&
            target.client_id === instance.client_id &&
            target.available,
        )
          ? "available"
          : "unavailable",
      })),
    };
  },
};

export const desktopBootstrapRuntime: BootstrapRuntime = {
  async getBootstrapView() {
    const result = await queryApplication({ type: "get_bootstrap_snapshot" });
    if (result.type !== "bootstrap_snapshot") {
      throw new Error("Unexpected bootstrap response from the native application.");
    }
    return {
      snapshot: result.payload,
      verification: { kind: "unavailable" },
    };
  },
  async runInitializationScan(scopeIds) {
    const result = await executeCommand({
      type: "run_initialization_scan",
      payload: { scope_ids: scopeIds },
    });
    if (result.type === "operation_summary") {
      return {
        kind: "in_progress",
        operationId: result.payload.operation_id,
        phase: result.payload.phase,
      };
    }
    if (result.type === "scan_result") {
      return { kind: "completed" };
    }
    throw new Error("Unexpected initialization scan response from the native application.");
  },
};
