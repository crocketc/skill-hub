import {
  executeCommand,
  queryApplication,
  type BootstrapSnapshot,
} from "../../api/bindings";

export interface BootstrapRuntime {
  getBootstrapSnapshot: () => Promise<BootstrapSnapshot>;
  runInitializationScan: (scopeIds: string[]) => Promise<void>;
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
  discoverAgents: () => Promise<void>;
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

export const desktopBootstrapRuntime: BootstrapRuntime = {
  async getBootstrapSnapshot() {
    const result = await queryApplication({ type: "get_bootstrap_snapshot" });
    if (result.type !== "bootstrap_snapshot") {
      throw new Error("Unexpected bootstrap response from the native application.");
    }
    return result.payload;
  },
  async runInitializationScan(scopeIds) {
    await executeCommand({
      type: "run_initialization_scan",
      payload: { scope_ids: scopeIds },
    });
  },
};
