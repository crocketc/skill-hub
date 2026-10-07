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
    // W1-2：prepare_delete 返回随主体删除的未保存编辑草稿数量。
    draft_count: 2,
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
    draftCount: 2,
  });
});

it("defaults the draft count to zero for legacy impacts without draft_count", async () => {
  // W1-2：旧载荷缺 draft_count 时按 0 归一，消费方按“无草稿”处理，不显示草稿行。
  const impact = {
    operation_id: "op-legacy",
    skill_id: "skill-pdf",
    deployments: [],
    requires_shared_target_choice: false,
    dependencies: [],
  };
  vi.mocked(executeCommand).mockResolvedValueOnce({ type: "removal_impact", payload: impact });

  await expect(nativeRemovalFacade.prepareDelete("skill-pdf", "PDF Reader")).resolves.toMatchObject({
    draftCount: 0,
  });
});

// #12-7 重构：对话框按部署形态分组（链接固定删除/拷贝默认保留），
// 按共享物理目标分组要求逐项确认——桌面契约必须携带 mode 与 targetId；
// 导入拷贝关系数来自治理台账（只读、best-effort），失败时如实省略。
it("maps deployment modes, target ids and the imported-copy relation count", async () => {
  const impact = {
    operation_id: "op-modes",
    skill_id: "skill-pdf",
    deployments: [
      {
        id: "d-link", skill_id: "skill-pdf", version_id: "v1", target_id: "target-link",
        state: "deployed" as const, mode: "symbolic_link" as const, managed: true,
        runtime_name: "pdf", expected_hash: "h", observed_hash: null,
      },
      {
        id: "d-copy", skill_id: "skill-pdf", version_id: "v1", target_id: "target-copy",
        state: "deployed" as const, mode: "managed_copy" as const, managed: true,
        runtime_name: "pdf", expected_hash: "h", observed_hash: null,
      },
    ],
    requires_shared_target_choice: false,
    dependencies: [],
  };
  vi.mocked(executeCommand).mockResolvedValueOnce({ type: "removal_impact", payload: impact });
  vi.mocked(queryApplication)
    .mockResolvedValueOnce({
      type: "deployment_targets",
      payload: [
        { id: "target-link", physical_id: "target-link", label: "Codex", path: "C:\\links\\skills", available: true, modes: [], physical_identity_verified: true },
        { id: "target-copy", physical_id: "target-copy", label: "Claude", path: "C:\\copies\\skills", available: true, modes: [], physical_identity_verified: true },
      ],
    } as never)
    .mockResolvedValueOnce({
      type: "relation_governance_ledger",
      payload: { rows: [], counts: {}, bucket: "all", total: 2, relationship_revision: "r1", last_verified_at: null },
    } as never);

  await expect(nativeRemovalFacade.prepareDelete("skill-pdf", "PDF Reader")).resolves.toMatchObject({
    deployments: [
      { id: "d-link", mode: "symbolic_link", targetId: "target-link" },
      { id: "d-copy", mode: "managed_copy", targetId: "target-copy" },
    ],
    importRelationCount: 2,
  });
  expect(queryApplication).toHaveBeenNthCalledWith(2, {
    type: "list_relation_governance",
    payload: { filters: { skill_id: "skill-pdf", relationship_types: ["import_copy"] } },
  });
});

it("omits the imported-copy relation count when the governance ledger is unreachable", async () => {
  const impact = {
    operation_id: "op-import-fail",
    skill_id: "skill-pdf",
    deployments: [
      {
        id: "d-copy", skill_id: "skill-pdf", version_id: "v1", target_id: "target-1",
        state: "deployed" as const, mode: "managed_copy" as const, managed: true,
        runtime_name: "pdf", expected_hash: "h", observed_hash: null,
      },
    ],
    requires_shared_target_choice: false,
    dependencies: [],
  };
  vi.mocked(executeCommand).mockResolvedValueOnce({ type: "removal_impact", payload: impact });
  vi.mocked(queryApplication)
    .mockResolvedValueOnce({
      type: "deployment_targets",
      payload: [
        { id: "target-1", physical_id: "target-1", label: "Claude", path: "C:\\copies\\skills", available: true, modes: [], physical_identity_verified: true },
      ],
    } as never)
    .mockRejectedValueOnce(new Error("ledger unavailable"));

  // 台账不可达只是少一行摘要，绝不能阻塞删除确认。
  await expect(nativeRemovalFacade.prepareDelete("skill-pdf", "PDF Reader")).resolves.toMatchObject({
    importRelationCount: undefined,
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

  // K2：commitDelete 归一化后返回稳定全形状；旧载荷按已提交/已执行读取。
  await expect(nativeRemovalFacade.deleteSkill("skill-pdf", { "deployment-1": "convert_to_copy" })).resolves.toEqual({
    centralSkillDeleted: true,
    state: "committed",
    recoveryOperationId: null,
    centralDeleteError: null,
    items: [],
  });
  expect(executeCommand).toHaveBeenNthCalledWith(1, {
    type: "prepare_delete_skill",
    payload: { skill_id: "skill-pdf" },
  });
  expect(executeCommand).toHaveBeenNthCalledWith(2, {
    type: "commit_delete_skill",
    payload: {
      prepared_delete_id: "op-delete",
      decisions: [{
        deployment_id: "deployment-1",
        decision: "remove_relation_only",
        confirm_shared_target_removal: false,
      }],
    },
  });
});

// K2/G-09：回收共享物理目标必须逐条显式确认；门面把对话框收集的
// 确认集合逐条转发进提交载荷，未确认的行保持显式 false。
it("forwards explicit shared-target confirmations into the commit payload", async () => {
  const result = {
    operation_id: "op-confirm",
    skill_id: "skill-pdf",
    decisions: [],
    central_skill_deleted: true,
  };
  vi.mocked(executeCommand).mockResolvedValueOnce({ type: "removal_result", payload: result });

  await expect(nativeRemovalFacade.commitDelete(
    "op-confirm",
    { "dep-1": "remove_deployment", "dep-2": "convert_to_copy" },
    new Set(["dep-1"]),
  )).resolves.toMatchObject({ centralSkillDeleted: true });
  expect(executeCommand).toHaveBeenCalledWith({
    type: "commit_delete_skill",
    payload: {
      prepared_delete_id: "op-confirm",
      decisions: [
        { deployment_id: "dep-1", decision: "remove_owned_target", confirm_shared_target_removal: true },
        { deployment_id: "dep-2", decision: "remove_relation_only", confirm_shared_target_removal: false },
      ],
    },
  });
});

it("maps the full commit_delete result shape with per-item status and central failure facts", async () => {
  // K2 绑定：RemovalResult.state/recovery_operation_id/central_delete_error
  // 与 DeploymentRemovalResult.status/error_code 必须完整进入桌面契约，
  // 不再只留 central_skill_deleted 单字段。
  const result = {
    operation_id: "op-delete-1",
    skill_id: "skill-pdf",
    decisions: [
      {
        deployment_id: "dep-1",
        decision: "remove_owned_target",
        target_removed: true,
        relation_removed: true,
        management_detached: false,
        status: "applied",
        error_code: null,
      },
      {
        deployment_id: "dep-2",
        decision: "remove_owned_target",
        target_removed: false,
        relation_removed: false,
        management_detached: false,
        status: "failed",
        error_code: "deployment.ownership_mismatch",
      },
      {
        deployment_id: "dep-3",
        decision: "keep_shared_deployment",
        target_removed: false,
        relation_removed: false,
        management_detached: false,
        status: "pending",
      },
    ],
    central_skill_deleted: false,
    state: "partially_committed",
    recovery_operation_id: "op-restore-1",
    central_delete_error: "internal.error",
  };
  vi.mocked(executeCommand).mockResolvedValueOnce({ type: "removal_result", payload: result } as never);

  await expect(nativeRemovalFacade.commitDelete("op-delete-1", {
    "dep-1": "remove_deployment",
    "dep-2": "remove_deployment",
    "dep-3": "keep_deployed",
  })).resolves.toEqual({
    centralSkillDeleted: false,
    state: "partially_committed",
    recoveryOperationId: "op-restore-1",
    centralDeleteError: "internal.error",
    items: [
      { deploymentId: "dep-1", status: "applied", errorCode: null },
      { deploymentId: "dep-2", status: "failed", errorCode: "deployment.ownership_mismatch" },
      { deploymentId: "dep-3", status: "pending", errorCode: null },
    ],
  });
  expect(executeCommand).toHaveBeenCalledWith({
    type: "commit_delete_skill",
    payload: {
      prepared_delete_id: "op-delete-1",
      decisions: [
        { deployment_id: "dep-1", decision: "remove_owned_target", confirm_shared_target_removal: false },
        { deployment_id: "dep-2", decision: "remove_owned_target", confirm_shared_target_removal: false },
        { deployment_id: "dep-3", decision: "keep_shared_deployment", confirm_shared_target_removal: false },
      ],
    },
  });
});

it("normalizes a legacy delete result that predates per-item status as fully executed", async () => {
  const result = {
    operation_id: "op-delete",
    skill_id: "skill-pdf",
    decisions: [],
    central_skill_deleted: true,
  };
  vi.mocked(executeCommand).mockResolvedValueOnce({ type: "removal_result", payload: result });

  // 绑定注释：旧载荷缺省按已执行/已提交读取；桌面层归一，消费方拿稳定形状。
  await expect(nativeRemovalFacade.commitDelete("op-delete", {})).resolves.toEqual({
    centralSkillDeleted: true,
    state: "committed",
    recoveryOperationId: null,
    centralDeleteError: null,
    items: [],
  });
});

it("stops the delete flow before commit when the deployment target query fails", async () => {
  const impact = {
    operation_id: "op-delete",
    skill_id: "skill-pdf",
    deployments: [
      {
        id: "deployment-1",
        skill_id: "skill-pdf",
        version_id: "v1",
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
  vi.mocked(executeCommand).mockResolvedValueOnce({ type: "removal_impact", payload: impact });
  vi.mocked(queryApplication).mockRejectedValue(new Error("deployment target query failed"));

  // G-10/K2：影响查询失败必须可见失败并停止流程，绝不带脏数据进入提交。
  await expect(nativeRemovalFacade.prepareDelete("skill-pdf", "PDF Reader")).rejects.toMatchObject({
    code: "removal.deployment_target_unavailable",
  });
  expect(executeCommand).not.toHaveBeenCalledWith(
    expect.objectContaining({ type: "commit_delete_skill" }),
  );
});
