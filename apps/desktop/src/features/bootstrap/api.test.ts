import { beforeEach, expect, it, vi } from "vitest";
import {
  desktopBootstrapRuntime,
  desktopOnboardingOperations,
} from "./api";

const mocks = vi.hoisted(() => ({
  executeCommand: vi.fn(),
  queryApplication: vi.fn(),
}));

vi.mock("../../api/bindings", () => mocks);

beforeEach(() => {
  mocks.executeCommand.mockReset();
  mocks.queryApplication.mockReset();
});

it("returns the exact configured library path from the native bootstrap snapshot", async () => {
  mocks.queryApplication.mockResolvedValue({
    type: "bootstrap_snapshot",
    payload: {
      initialization_state: "not_initialized",
      library_path: "C:\\Users\\Test\\SkillHub",
      onboarding_skipped: false,
      skill_count: 0,
      project_count: 0,
      agent_count: 0,
      discovered_agent_count: 0,
      deployed_count: 0,
      deployment_categories: [],
      tag_categories: [],
      recent_operations: [],
      pending: { total: 0, by_kind: {} },
      last_scan_at: null,
      recovery_state: "clean",
    },
  });

  const view = await desktopBootstrapRuntime.getBootstrapView();

  expect(view.snapshot.library_path).toBe("C:\\Users\\Test\\SkillHub");
  expect(view.snapshot.initialization_state).toBe("not_initialized");
});

it("completes onboarding and discovers Agent targets through typed native commands", async () => {
  mocks.executeCommand
    .mockResolvedValueOnce({
      type: "initialization_status",
      payload: {
        state: "initialized",
        library_path: "C:\\Users\\Test\\SkillHub",
        skipped: true,
      },
    })
    .mockResolvedValueOnce({
      type: "discovery_snapshot",
      payload: {
        generation: "1",
        observed_at: "0",
        instances: [
          {
            profile_id: "openai",
            client_id: "codex",
            kind: "cli",
            supported_os: ["windows"],
            client_presence: "Unknown",
          },
        ],
        logical_targets: [
          {
            id: "target-1",
            profile_id: "openai",
            client_id: "codex",
            scope: "global",
            path: "C:\\Users\\Test\\.codex\\skills",
            marker: "SKILL.md",
            precedence: "preferred",
            exists: true,
            readable: true,
            writable: true,
            available: true,
            physical_id: "physical-1",
          },
        ],
        physical_targets: [],
      },
    });

  await desktopOnboardingOperations.completeOnboarding({
    libraryPath: "C:\\Users\\Test\\SkillHub",
    skipped: true,
  });
  const result = await desktopOnboardingOperations.discoverAgents();

  expect(mocks.executeCommand).toHaveBeenNthCalledWith(1, {
    type: "complete_onboarding",
    payload: {
      library_path: "C:\\Users\\Test\\SkillHub",
      skipped: true,
    },
  });
  expect(mocks.executeCommand).toHaveBeenNthCalledWith(2, {
    type: "discover_agent_targets",
    payload: null,
  });
  expect(result.targets).toEqual([
    { id: "target-1", label: "codex", profileId: "openai", kind: "cli", availability: "available" },
  ]);
});

it("keeps the native scan result for the read-only preview", async () => {
  const scanResult = {
    generation: { generation: 1, observed_at: 2 },
    roots: ["C:\\Users\\Test\\.codex\\skills"],
    discovered: [],
    visited_paths: ["C:\\Users\\Test\\.codex\\skills"],
    reparsed_count: 0,
    unchanged_count: 0,
    errors: [],
  };
  mocks.executeCommand.mockResolvedValue({ type: "scan_result", payload: scanResult });

  await expect(desktopBootstrapRuntime.runInitializationScan([])).resolves.toEqual({
    kind: "completed",
    result: scanResult,
  });
});

it("activates a selected library through the typed native command", async () => {
  mocks.executeCommand.mockResolvedValue({
    type: "initialization_status",
    payload: { state: "initialized", library_path: "D:\\SkillHub", skipped: false },
  });

  await desktopOnboardingOperations.activateLibraryRoot!("D:\\SkillHub", "create");

  expect(mocks.executeCommand).toHaveBeenCalledWith({
    type: "activate_library_root",
    payload: { path: "D:\\SkillHub", mode: "create" },
  });
});

it("accepts a previously activated matching root after a restart", async () => {
  mocks.executeCommand.mockRejectedValueOnce({
    code: "operation.conflict",
    severity: "error",
    params: { reason: "library_root_locked" },
    actions: ["migrate_data"],
  });
  mocks.queryApplication.mockResolvedValueOnce({
    type: "bootstrap_snapshot",
    payload: {
      initialization_state: "not_initialized",
      library_path: "C:\\skillhub-test",
      onboarding_skipped: false,
      skill_count: 0,
      project_count: 0,
      agent_count: 0,
      discovered_agent_count: 0,
      deployed_count: 0,
      deployment_categories: [],
      tag_categories: [],
      recent_operations: [],
      pending: { total: 0, by_kind: {} },
      last_scan_at: null,
      recovery_state: "clean",
    },
  });

  await expect(
    desktopOnboardingOperations.activateLibraryRoot!("C:\\skillhub-test", "existing"),
  ).resolves.toBeUndefined();

  expect(mocks.queryApplication).toHaveBeenCalledWith({ type: "get_bootstrap_snapshot" });
});

it("keeps the root-lock error when the persisted root differs", async () => {
  const lockError = {
    code: "operation.conflict",
    severity: "error",
    params: { reason: "library_root_locked" },
    actions: ["migrate_data"],
  };
  mocks.executeCommand.mockRejectedValueOnce(lockError);
  mocks.queryApplication.mockResolvedValueOnce({
    type: "bootstrap_snapshot",
    payload: {
      initialization_state: "not_initialized",
      library_path: "D:\\other-library",
      onboarding_skipped: false,
      skill_count: 0,
      project_count: 0,
      agent_count: 0,
      discovered_agent_count: 0,
      deployed_count: 0,
      deployment_categories: [],
      tag_categories: [],
      recent_operations: [],
      pending: { total: 0, by_kind: {} },
      last_scan_at: null,
      recovery_state: "clean",
    },
  });

  await expect(
    desktopOnboardingOperations.activateLibraryRoot!("C:\\skillhub-test", "existing"),
  ).rejects.toBe(lockError);
});

it("sends the selected target to first-run restore while preserving ordinary restore", async () => {
  mocks.executeCommand
    .mockResolvedValueOnce({ type: "restore_plan", payload: { conflicts: [] } })
    .mockResolvedValueOnce({ type: "restore_result", payload: { restored: [], skipped: [] } })
    .mockResolvedValueOnce({ type: "restore_plan", payload: { conflicts: [] } })
    .mockResolvedValueOnce({ type: "restore_result", payload: { restored: [], skipped: [] } });

  await desktopOnboardingOperations.prepareInitialRestore!("C:\\backup.skillhub", "D:\\SkillHub");
  await desktopOnboardingOperations.commitInitialRestore!("C:\\backup.skillhub", "D:\\SkillHub", []);
  await desktopOnboardingOperations.prepareRestore?.("C:\\backup.skillhub");
  await desktopOnboardingOperations.commitRestore?.("C:\\backup.skillhub", []);

  expect(mocks.executeCommand).toHaveBeenNthCalledWith(1, {
    type: "prepare_initial_restore",
    payload: { backup_path: "C:\\backup.skillhub", library_path: "D:\\SkillHub" },
  });
  expect(mocks.executeCommand).toHaveBeenNthCalledWith(2, {
    type: "commit_initial_restore",
    payload: { backup_path: "C:\\backup.skillhub", library_path: "D:\\SkillHub", decisions: [] },
  });
  expect(mocks.executeCommand).toHaveBeenNthCalledWith(3, {
    type: "prepare_restore",
    payload: { path: "C:\\backup.skillhub" },
  });
  expect(mocks.executeCommand).toHaveBeenNthCalledWith(4, {
    type: "commit_restore",
    payload: { path: "C:\\backup.skillhub", decisions: [] },
  });
});

it("does not expose the restart workaround in onboarding operations", () => {
  expect("restart" in desktopOnboardingOperations).toBe(false);
});
