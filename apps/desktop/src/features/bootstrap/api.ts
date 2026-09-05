import {
  executeCommand,
  queryApplication,
  type BootstrapSnapshot,
  type OperationPhase,
  type RestoreDecision,
  type RestorePlan,
  type RestoreResult,
  type ScanResult,
} from "../../api/bindings";
import { desktopDirectoryPicker } from "../../platform/directoryPicker";

export type BootstrapVerificationState =
  | { kind: "unavailable" }
  | { kind: "verifying" };

export interface BootstrapView {
  snapshot: BootstrapSnapshot;
  verification: BootstrapVerificationState;
}

export type InitializationScanState =
  | { kind: "completed"; result: ScanResult }
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
  prepareRestore?: (path: string) => Promise<RestorePlan>;
  commitRestore?: (path: string, decisions: RestoreDecision[]) => Promise<RestoreResult>;
  pickDirectory?: () => Promise<string | null>;
}

export interface CompatibilityTarget {
  id: string;
  label: string;
  /** Brand key (builtin profile id, e.g. "openai"). Absent in legacy callers. */
  profileId?: string;
  /** Client form factor when the snapshot provides it. */
  kind?: string | null;
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
    const kindByClient = new Map(
      result.payload.instances.map((instance) => [
        `${instance.profile_id}:${instance.client_id}`,
        instance.kind,
      ]),
    );
    const logicalTargets = result.payload.logical_targets.map((target) => ({
      id: target.id,
      label: target.client_id,
      profileId: target.profile_id,
      kind: kindByClient.get(`${target.profile_id}:${target.client_id}`) ?? null,
      availability: target.available && target.exists && target.readable
        ? ("available" as const)
        : ("unavailable" as const),
    }));
    const representedClients = new Set(
      result.payload.logical_targets.map((target) => `${target.profile_id}:${target.client_id}`),
    );
    const instancesWithoutTargets = result.payload.instances
      .filter((instance) => !representedClients.has(`${instance.profile_id}:${instance.client_id}`))
      .map((instance) => ({
        id: `${instance.profile_id}:${instance.client_id}`,
        label: instance.client_id,
        profileId: instance.profile_id,
        kind: instance.kind as string | null,
        availability: "unavailable" as const,
      }));
    return {
      targets: [...logicalTargets, ...instancesWithoutTargets],
    };
  },
  async prepareRestore(path) {
    const result = await executeCommand({ type: "prepare_restore", payload: { path } });
    if (result.type !== "restore_plan") {
      throw new Error("Unexpected restore plan response from the native application.");
    }
    return result.payload;
  },
  async commitRestore(path, decisions) {
    const result = await executeCommand({
      type: "commit_restore",
      payload: { path, decisions },
    });
    if (result.type !== "restore_result") {
      throw new Error("Unexpected restore result response from the native application.");
    }
    return result.payload;
  },
  async pickDirectory() {
    return desktopDirectoryPicker.pickDirectory();
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
      return { kind: "completed", result: result.payload };
    }
    throw new Error("Unexpected initialization scan response from the native application.");
  },
};
