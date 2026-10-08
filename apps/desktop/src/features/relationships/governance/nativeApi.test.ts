import { beforeEach, expect, it, vi } from "vitest";
import type { GovernableRelationFact, RemovalImpact } from "../../../api/bindings";
import { executeCommand, queryApplication } from "../../../api/bindings";
import { nativeGovernanceFacade } from "./nativeApi";

vi.mock("../../../api/bindings", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../api/bindings")>();
  return { ...original, executeCommand: vi.fn(), queryApplication: vi.fn() };
});

beforeEach(() => {
  vi.mocked(queryApplication).mockReset();
  vi.mocked(executeCommand).mockReset();
});

function deploymentRelation(): GovernableRelationFact {
  return {
    kind: "deployment",
    fact: {
      relation_id: "managed:dep-1",
      skill_id: "skill-pdf",
      agent_client_id: "codex",
      path: "C:/agents/codex/skills/pdf-reader",
      path_key: "c:/agents/codex/skills/pdf-reader",
      directory_node_id: "node-codex",
      relationship: "managed_link",
      file_representation: "symbolic_link",
      ownership: "skillhub_managed",
      link_target_path: "C:/library/pdf-reader",
      link_target_path_key: "c:/library/pdf-reader",
      link_target_directory_id: "node-library",
      content_fingerprint: "sha256:aaa",
      origin: "import",
      match_state: "content_verified",
      active: true,
      observed_at: "1737600000000",
      released_at: null,
    },
  };
}

const removalImpact: RemovalImpact = {
  operation_id: "op-undeploy-1",
  skill_id: "skill-pdf",
  deployments: [],
  requires_shared_target_choice: true,
  dependencies: [],
};

const removalResult = {
  operation_id: "op-undeploy-1",
  skill_id: "skill-pdf",
  decisions: [],
  central_skill_deleted: false,
};

// K2/G-07：治理「从 Agent/项目移除」的提交载荷必须携带用户在预览对话框
// 给出的共享目标决定（confirm_shared_target_removal），不得再硬编码
// remove_owned_target 并丢弃共享决定。字段名按 K0 契约 §K2 钉死。
it("passes the user's shared-target decision into the commit payload", async () => {
  vi.mocked(executeCommand)
    .mockResolvedValueOnce({ type: "removal_impact", payload: removalImpact })
    .mockResolvedValueOnce({ type: "removal_result", payload: removalResult });

  await nativeGovernanceFacade.prepareRelationUndeploy(deploymentRelation());
  await nativeGovernanceFacade.commitRelationUndeploy("op-undeploy-1", { confirmSharedTargetRemoval: true });

  expect(executeCommand).toHaveBeenNthCalledWith(1, {
    type: "prepare_undeploy",
    payload: { deployment_id: "dep-1" },
  });
  expect(executeCommand).toHaveBeenNthCalledWith(2, {
    type: "commit_undeploy",
    payload: {
      prepared_undeploy_id: "op-undeploy-1",
      decision: "remove_owned_target",
      confirm_shared_target_removal: true,
    },
  });
});

it("sends an explicit false confirmation when the user did not confirm the shared target", async () => {
  vi.mocked(executeCommand)
    .mockResolvedValueOnce({ type: "removal_impact", payload: removalImpact })
    .mockResolvedValueOnce({ type: "removal_result", payload: removalResult });

  await nativeGovernanceFacade.prepareRelationUndeploy(deploymentRelation());
  await nativeGovernanceFacade.commitRelationUndeploy("op-undeploy-1", { confirmSharedTargetRemoval: false });

  expect(executeCommand).toHaveBeenNthCalledWith(2, {
    type: "commit_undeploy",
    payload: {
      prepared_undeploy_id: "op-undeploy-1",
      decision: "remove_owned_target",
      confirm_shared_target_removal: false,
    },
  });
});


it("queries the unified relationship overview independently from the legacy governance ledger", async () => {
  vi.mocked(queryApplication).mockResolvedValue({
    type: "relationship_overview",
    payload: { usage_relations: [] },
  } as never);

  expect("getRelationshipOverview" in nativeGovernanceFacade).toBe(true);
  await (nativeGovernanceFacade as unknown as { getRelationshipOverview(): Promise<unknown> }).getRelationshipOverview();
  expect(queryApplication).toHaveBeenCalledWith({
    type: "get_relationship_overview",
    payload: { scope: { type: "all" } },
  });
});
