import { beforeEach, expect, it, vi } from "vitest";
import { executeCommand, queryApplication } from "../../api/bindings";
import { nativeRemovalFacade } from "./nativeApi";

vi.mock("../../api/bindings", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../api/bindings")>();
  return { ...original, executeCommand: vi.fn(), queryApplication: vi.fn() };
});

beforeEach(() => {
  vi.mocked(queryApplication).mockReset();
  vi.mocked(executeCommand).mockReset();
});

it("loads removal impact through the native query contract", async () => {
  const impact = {
    operation_id: "op-1",
    skill_id: "skill-pdf",
    deployments: [],
    requires_shared_target_choice: false,
    dependencies: [],
  };
  vi.mocked(queryApplication).mockResolvedValue({ type: "removal_impact", payload: impact });

  await expect(nativeRemovalFacade.getImpact("skill-pdf")).resolves.toEqual(impact);
  expect(queryApplication).toHaveBeenCalledWith({
    type: "get_removal_impact",
    payload: { skill_id: "skill-pdf" },
  });
});

it("prepares a shared-target undeploy before committing the explicit relation-only decision", async () => {
  const impact = {
    operation_id: "op-2",
    skill_id: "skill-pdf",
    deployments: [],
    requires_shared_target_choice: true,
    dependencies: [],
  };
  const result = {
    operation_id: "op-2",
    skill_id: "skill-pdf",
    decisions: [],
    central_skill_deleted: false,
  };
  vi.mocked(executeCommand)
    .mockResolvedValueOnce({ type: "removal_impact", payload: impact })
    .mockResolvedValueOnce({ type: "removal_result", payload: result });

  await expect(nativeRemovalFacade.prepareUndeploy("deployment-1", "Codex CLI")).resolves.toEqual({
    deploymentId: "deployment-1",
    label: "Codex CLI",
    operationId: "op-2",
    sharedTarget: true,
  });
  await expect(nativeRemovalFacade.commitUndeploy("op-2", "keep_shared_deployment")).resolves.toBeUndefined();
  expect(executeCommand).toHaveBeenNthCalledWith(1, {
    type: "prepare_undeploy",
    payload: { deployment_id: "deployment-1" },
  });
  expect(executeCommand).toHaveBeenNthCalledWith(2, {
    type: "commit_undeploy",
    payload: { prepared_undeploy_id: "op-2", decision: "keep_shared_deployment" },
  });
});

it("detaches management through the dedicated command", async () => {
  const result = {
    operation_id: "op-3",
    skill_id: "skill-pdf",
    decisions: [],
    central_skill_deleted: false,
  };
  vi.mocked(executeCommand).mockResolvedValue({ type: "removal_result", payload: result });

  await expect(nativeRemovalFacade.detachManagement("deployment-1")).resolves.toEqual(result);
  expect(executeCommand).toHaveBeenCalledWith({
    type: "detach_management",
    payload: { deployment_id: "deployment-1" },
  });
});

it("prepares and commits central Skill deletion with explicit mapped choices", async () => {
  const impact = {
    operation_id: "op-delete",
    skill_id: "skill-pdf",
    deployments: [
      {
        id: "deployment-1",
        skill_id: "skill-pdf",
        version_id: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        target_id: "target-1",
        state: "deployed" as const,
        mode: "managed_copy" as const,
        managed: true,
        runtime_name: "pdf",
        expected_hash: "sha256:tree",
        observed_hash: "sha256:tree",
      },
    ],
    requires_shared_target_choice: false,
    dependencies: ["project:demo"],
  };
  const result = {
    operation_id: "op-delete",
    skill_id: "skill-pdf",
    decisions: [],
    central_skill_deleted: true,
  };
  vi.mocked(executeCommand)
    .mockResolvedValueOnce({ type: "removal_impact", payload: impact })
    .mockResolvedValueOnce({ type: "removal_result", payload: result });

  await expect(nativeRemovalFacade.deleteSkill("skill-pdf", { "deployment-1": "convert_to_copy" })).resolves.toEqual({
    centralSkillDeleted: true,
  });
  expect(executeCommand).toHaveBeenNthCalledWith(1, {
    type: "prepare_delete_skill",
    payload: { skill_id: "skill-pdf" },
  });
  expect(executeCommand).toHaveBeenNthCalledWith(2, {
    type: "commit_delete_skill",
    payload: {
      prepared_delete_id: "op-delete",
      decisions: [{ deployment_id: "deployment-1", decision: "remove_relation_only" }],
    },
  });
});
