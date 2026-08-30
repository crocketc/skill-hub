import { beforeEach, expect, it, vi } from "vitest";
import { executeCommand, queryApplication } from "../../api/bindings";
import { createNativeDeploymentFacade } from "./nativeApi";
import type { DeploymentTarget } from "./api";

vi.mock("../../api/bindings", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../api/bindings")>();
  return { ...original, executeCommand: vi.fn(), queryApplication: vi.fn() };
});

beforeEach(() => {
  vi.mocked(queryApplication).mockReset();
  vi.mocked(executeCommand).mockReset();
});

it("lists only registered deployment targets and preserves capability modes", async () => {
  vi.mocked(queryApplication).mockResolvedValue({
    type: "deployment_targets",
    payload: [{
      id: "codex-global",
      label: "Codex CLI",
      path: "C:/Users/demo/.codex/skills",
      available: true,
      physical_id: "fs:codex",
      modes: ["managed_copy"],
    }],
  });

  const facade = createNativeDeploymentFacade({ skillId: "skill-pdf", versionId: "v1", runtimeName: "pdf" });
  await expect(facade.listTargets()).resolves.toEqual([{
    id: "codex-global",
    label: "Codex CLI",
    path: "C:/Users/demo/.codex/skills",
    available: true,
    physicalId: "fs:codex",
    modes: ["managed_copy"],
  }]);
  expect(queryApplication).toHaveBeenCalledWith({ type: "list_deployment_targets", payload: null });
});

it("maps a native plan and commits through prepare then commit", async () => {
  const nativePlan = {
    skill_id: "skill-pdf",
    version_id: "v1",
    runtime_name: "pdf",
    mode: "managed_copy" as const,
    targets: [{
      physical_target_id: "fs:codex",
      logical_target_ids: ["codex-global"],
      target_path: "C:/Users/demo/.codex/skills",
      destination_path: "C:/Users/demo/.codex/skills/pdf",
      source_path: "C:/Library/versions/skill-pdf/v1",
      runtime_name: "pdf",
      skill_id: "skill-pdf",
      version_id: "v1",
      mode: "managed_copy" as const,
      change: "create" as const,
      warnings: [],
      conflicts: [],
    }],
    warnings: [],
    conflicts: [],
  };
  vi.mocked(queryApplication).mockResolvedValue({
    type: "deployment_plan",
    payload: nativePlan,
  });
  vi.mocked(executeCommand)
    .mockResolvedValueOnce({ type: "prepared_deployment", payload: {
      id: "op-1",
      plan: nativePlan,
    } })
    .mockResolvedValueOnce({ type: "deployment_summary", payload: {
      operation_id: "op-1",
      skill_id: "skill-pdf",
      version_id: "v1",
      targets: [{
        physical_target_id: "fs:codex",
        logical_target_ids: ["codex-global"],
        status: "failed",
        deployment_id: null,
        version_id: "v1",
        error_code: "deployment.target_exists",
      }],
      committed: false,
    } });

  const facade = createNativeDeploymentFacade({ skillId: "skill-pdf", versionId: "v1", runtimeName: "pdf" });
  const target: DeploymentTarget = { id: "codex-global", label: "Codex CLI", path: "hidden", available: true, physicalId: "fs:codex", modes: ["managed_copy"] };
  const plan = await facade.preview([target]);
  expect(plan.targets[0]).toMatchObject({ targetId: "codex-global", label: "Codex CLI", mode: "managed_copy" });
  const result = await facade.commit(plan);
  expect(result).toEqual([{ targetId: "codex-global", label: "Codex CLI", status: "failed", message: "deployment.target_exists" }]);
  expect(executeCommand).toHaveBeenNthCalledWith(1, expect.objectContaining({ type: "prepare_deployment" }));
  expect(executeCommand).toHaveBeenNthCalledWith(2, { type: "commit_deployment", payload: { prepared_deployment_id: "op-1" } });
});
