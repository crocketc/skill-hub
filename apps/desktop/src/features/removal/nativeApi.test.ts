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

it("maps the full deletion impact matrix onto the desktop contract", async () => {
  const impact = {
    operation_id: "op-matrix",
    skill_id: "skill-notes",
    deployments: [],
    requires_shared_target_choice: false,
    dependencies: ["python 3.11 runtime"],
    project_configs: ["Demo Project"],
    pinned_versions: [{ project_id: "project-1", version_id: "sha256:vvvv" }],
    combinations: ["Cleanup combo"],
    related_skills: ["notes packager"],
    unknown_external_references: ["/agents/root/notes"],
  };
  vi.mocked(executeCommand).mockResolvedValueOnce({ type: "removal_impact", payload: impact });

  // QA-001：桌面契约必须逐字段映射领域影响矩阵，
  // 不再把依赖冒充成“关联项目”。
  await expect(nativeRemovalFacade.prepareDelete("skill-notes", "Notes")).resolves.toEqual({
    operationId: "op-matrix",
    skillId: "skill-notes",
    skillName: "Notes",
    deployments: [],
    dependentProjects: ["Demo Project"],
    declaredDependencies: ["python 3.11 runtime"],
    pinnedVersions: [{ projectId: "project-1", versionId: "sha256:vvvv" }],
    combinations: ["Cleanup combo"],
    relatedSkills: ["notes packager"],
    unknownExternalReferences: ["/agents/root/notes"],
  });
});

it("rejects deletion preparation when deployment target facts cannot be loaded", async () => {
  vi.mocked(executeCommand).mockResolvedValue({
    type: "removal_impact",
    payload: {
      operation_id: "op-delete",
      skill_id: "skill-notes",
      deployments: [
        {
          id: "deployment-1",
          skill_id: "skill-notes",
          version_id: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          target_id: "target-1",
          state: "deployed",
          mode: "managed_copy",
          managed: true,
          runtime_name: "notes-reader",
          expected_hash: "sha256:tree",
          observed_hash: "sha256:tree",
        },
      ],
      requires_shared_target_choice: false,
      dependencies: [],
      project_configs: [],
      pinned_versions: [],
      combinations: [],
      related_skills: [],
      unknown_external_references: [],
    },
  } as never);
  vi.mocked(queryApplication).mockRejectedValue(new Error("deployment target lookup failed"));

  await expect(nativeRemovalFacade.prepareDelete("skill-notes", "Notes")).rejects.toMatchObject({
    code: "removal.deployment_target_unavailable",
    params: {},
  });
});

it("maps a deployment reference to the registered physical target identity", async () => {
  const impact = {
    operation_id: "op-delete",
    skill_id: "skill-pdf",
    deployments: [{
      id: "deployment-1", skill_id: "skill-pdf", version_id: "v1", target_id: "physical-target-1",
      state: "deployed" as const, mode: "managed_copy" as const, managed: true, runtime_name: "pdf",
      expected_hash: "sha256:tree", observed_hash: "sha256:tree",
    }],
    requires_shared_target_choice: false, dependencies: [], project_configs: [], pinned_versions: [],
    combinations: [], related_skills: [], unknown_external_references: [],
  };
  vi.mocked(executeCommand).mockResolvedValueOnce({ type: "removal_impact", payload: impact });
  vi.mocked(queryApplication).mockResolvedValueOnce({
    type: "deployment_targets",
    payload: [{
      id: "logical-target-1", physical_id: "physical-target-1", label: "Codex",
      path: "C:\\Users\\demo\\.agents\\skills", available: true, modes: [],
      physical_identity_verified: true,
    }],
  } as never);

  await expect(nativeRemovalFacade.prepareDelete("skill-pdf", "PDF Reader")).resolves.toMatchObject({
    deployments: [{ id: "deployment-1", path: "C:\\Users\\demo\\.agents\\skills", physicalId: "physical-target-1" }],
  });
});

it("rejects deletion preparation when a matching target has no verified path", async () => {
  const impact = {
    operation_id: "op-delete", skill_id: "skill-pdf",
    deployments: [{
      id: "deployment-1", skill_id: "skill-pdf", version_id: "v1", target_id: "physical-target-1",
      state: "deployed" as const, mode: "managed_copy" as const, managed: true, runtime_name: "pdf",
      expected_hash: "sha256:tree", observed_hash: "sha256:tree",
    }],
    requires_shared_target_choice: false, dependencies: [], project_configs: [], pinned_versions: [],
    combinations: [], related_skills: [], unknown_external_references: [],
  };
  vi.mocked(executeCommand).mockResolvedValueOnce({ type: "removal_impact", payload: impact });
  vi.mocked(queryApplication).mockResolvedValueOnce({
    type: "deployment_targets",
    payload: [{
      id: "logical-target-1", physical_id: "physical-target-1", label: "Codex",
      path: "", available: true, modes: [], physical_identity_verified: true,
    }],
  } as never);

  await expect(nativeRemovalFacade.prepareDelete("skill-pdf", "PDF Reader")).rejects.toMatchObject({
    code: "removal.deployment_target_unavailable",
  });
});

it.each([undefined, null, false])("rejects deletion preparation when physical identity verification is %s", async (verified) => {
  const impact = {
    operation_id: "op-delete", skill_id: "skill-pdf",
    deployments: [{
      id: "deployment-1", skill_id: "skill-pdf", version_id: "v1", target_id: "physical-target-1",
      state: "deployed" as const, mode: "managed_copy" as const, managed: true, runtime_name: "pdf",
      expected_hash: "sha256:tree", observed_hash: "sha256:tree",
    }],
    requires_shared_target_choice: false, dependencies: [], project_configs: [], pinned_versions: [],
    combinations: [], related_skills: [], unknown_external_references: [],
  };
  vi.mocked(executeCommand).mockResolvedValueOnce({ type: "removal_impact", payload: impact });
  vi.mocked(queryApplication).mockResolvedValueOnce({
    type: "deployment_targets",
    payload: [{
      id: "logical-target-1", physical_id: "physical-target-1", label: "Codex",
      path: "C:\\Users\\demo\\.agents\\skills", available: true, modes: [],
      physical_identity_verified: verified,
    }],
  } as never);

  await expect(nativeRemovalFacade.prepareDelete("skill-pdf", "PDF Reader")).rejects.toMatchObject({
    code: "removal.deployment_target_unavailable",
  });
});

it("rejects an ambiguous deployment target key that resolves to different physical paths", async () => {
  const impact = {
    operation_id: "op-delete", skill_id: "skill-pdf",
    deployments: [{
      id: "deployment-1", skill_id: "skill-pdf", version_id: "v1", target_id: "shared-target-key",
      state: "deployed" as const, mode: "managed_copy" as const, managed: true, runtime_name: "pdf",
      expected_hash: "sha256:tree", observed_hash: "sha256:tree",
    }],
    requires_shared_target_choice: false, dependencies: [], project_configs: [], pinned_versions: [],
    combinations: [], related_skills: [], unknown_external_references: [],
  };
  vi.mocked(executeCommand).mockResolvedValueOnce({ type: "removal_impact", payload: impact });
  vi.mocked(queryApplication).mockResolvedValueOnce({
    type: "deployment_targets",
    payload: [
      {
        id: "shared-target-key", physical_id: "physical-a", label: "Codex A",
        path: "C:\\Users\\demo\\.agents\\skills", available: true, modes: [], physical_identity_verified: true,
      },
      {
        id: "logical-target-b", physical_id: "shared-target-key", label: "Codex B",
        path: "D:\\Other\\skills", available: true, modes: [], physical_identity_verified: true,
      },
    ],
  } as never);

  await expect(nativeRemovalFacade.prepareDelete("skill-pdf", "PDF Reader")).rejects.toMatchObject({
    code: "removal.deployment_target_unavailable",
  });
});

it("accepts multiple logical consumers that project to the same verified physical target", async () => {
  const impact = {
    operation_id: "op-delete", skill_id: "skill-pdf",
    deployments: [{
      id: "deployment-1", skill_id: "skill-pdf", version_id: "v1", target_id: "physical-shared",
      state: "deployed" as const, mode: "managed_copy" as const, managed: true, runtime_name: "pdf",
      expected_hash: "sha256:tree", observed_hash: "sha256:tree",
    }],
    requires_shared_target_choice: false, dependencies: [], project_configs: [], pinned_versions: [],
    combinations: [], related_skills: [], unknown_external_references: [],
  };
  vi.mocked(executeCommand).mockResolvedValueOnce({ type: "removal_impact", payload: impact });
  vi.mocked(queryApplication).mockResolvedValueOnce({
    type: "deployment_targets",
    payload: [
      {
        id: "logical-agent", physical_id: "physical-shared", label: "Codex",
        path: "C:\\Users\\demo\\.agents\\skills", available: true, modes: [], physical_identity_verified: true,
      },
      {
        id: "logical-project", physical_id: "physical-shared", label: "Project",
        path: "C:\\Users\\demo\\.agents\\skills", available: true, modes: [], physical_identity_verified: true,
      },
    ],
  } as never);

  await expect(nativeRemovalFacade.prepareDelete("skill-pdf", "PDF Reader")).resolves.toMatchObject({
    deployments: [{ id: "deployment-1", path: "C:\\Users\\demo\\.agents\\skills", physicalId: "physical-shared" }],
  });
});

it("rejects a shared physical target when any matching logical consumer is unverified", async () => {
  const impact = {
    operation_id: "op-delete", skill_id: "skill-pdf",
    deployments: [{
      id: "deployment-1", skill_id: "skill-pdf", version_id: "v1", target_id: "physical-shared",
      state: "deployed" as const, mode: "managed_copy" as const, managed: true, runtime_name: "pdf",
      expected_hash: "sha256:tree", observed_hash: "sha256:tree",
    }],
    requires_shared_target_choice: false, dependencies: [], project_configs: [], pinned_versions: [],
    combinations: [], related_skills: [], unknown_external_references: [],
  };
  vi.mocked(executeCommand).mockResolvedValueOnce({ type: "removal_impact", payload: impact });
  vi.mocked(queryApplication).mockResolvedValueOnce({
    type: "deployment_targets",
    payload: [
      {
        id: "logical-agent-unverified", physical_id: "physical-shared", label: "Codex",
        path: "C:\\Users\\demo\\.agents\\skills", available: true, modes: [],
        physical_identity_verified: false,
      },
      {
        id: "logical-project-verified", physical_id: "physical-shared", label: "Project",
        path: "C:\\Users\\demo\\.agents\\skills", available: true, modes: [],
        physical_identity_verified: true,
      },
    ],
  } as never);

  await expect(nativeRemovalFacade.prepareDelete("skill-pdf", "PDF Reader")).rejects.toMatchObject({
    code: "removal.deployment_target_unavailable",
  });
});

it("accepts verified shared targets whose Windows paths differ only by case and separators", async () => {
  const impact = {
    operation_id: "op-delete", skill_id: "skill-pdf",
    deployments: [{
      id: "deployment-1", skill_id: "skill-pdf", version_id: "v1", target_id: "physical-shared",
      state: "deployed" as const, mode: "managed_copy" as const, managed: true, runtime_name: "pdf",
      expected_hash: "sha256:tree", observed_hash: "sha256:tree",
    }],
    requires_shared_target_choice: false, dependencies: [], project_configs: [], pinned_versions: [],
    combinations: [], related_skills: [], unknown_external_references: [],
  };
  vi.mocked(executeCommand).mockResolvedValueOnce({ type: "removal_impact", payload: impact });
  vi.mocked(queryApplication).mockResolvedValueOnce({
    type: "deployment_targets",
    payload: [
      {
        id: "logical-agent", physical_id: "physical-shared", label: "Codex",
        path: "C:\\Users\\Demo\\.agents\\skills\\", available: true, modes: [],
        physical_identity_verified: true,
      },
      {
        id: "logical-project", physical_id: "physical-shared", label: "Project",
        path: "c:/users/demo/.AGENTS/skills", available: true, modes: [],
        physical_identity_verified: true,
      },
    ],
  } as never);

  await expect(nativeRemovalFacade.prepareDelete("skill-pdf", "PDF Reader")).resolves.toMatchObject({
    deployments: [{ id: "deployment-1", physicalId: "physical-shared" }],
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
    dependencies: [],
    project_configs: [],
    pinned_versions: [],
    combinations: [],
    related_skills: [],
    unknown_external_references: [],
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
  vi.mocked(queryApplication).mockResolvedValueOnce({
    type: "deployment_targets",
    payload: [{ id: "target-1", physical_id: "target-1", label: "Codex", path: "C:\\Users\\demo\\.agents\\skills", physical_identity_verified: true }],
  } as never);

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
