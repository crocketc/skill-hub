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
      deployed_count: 0,
      deployment_categories: [],
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
    { id: "target-1", label: "codex", availability: "available" },
  ]);
});
