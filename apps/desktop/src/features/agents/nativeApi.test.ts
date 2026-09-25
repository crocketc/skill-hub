import { beforeEach, expect, it, vi } from "vitest";
import {
  executeCommand,
  queryApplication,
  type DeploymentRecord,
  type DiscoverySnapshot,
  type RelationshipOverview,
} from "../../api/bindings";
import { nativeAgentFacade } from "./nativeApi";

vi.mock("../../api/bindings", () => ({
  executeCommand: vi.fn(),
  queryApplication: vi.fn(),
}));
const query = vi.mocked(queryApplication);
const command = vi.mocked(executeCommand);

const emptySnapshot: DiscoverySnapshot = {
  generation: "g",
  observed_at: "now",
  instances: [],
  logical_targets: [],
  physical_targets: [],
};

function snapshotWithTarget(overrides: Partial<{
  targetId: string;
  profileId: string;
  clientId: string;
  available: boolean;
  exists: boolean;
  physicalId: string;
}>): DiscoverySnapshot {
  const targetId = overrides.targetId ?? "openai.codex-cli.user";
  const physicalId = overrides.physicalId ?? "physical-1";
  return {
    generation: "generation-1",
    observed_at: "2026-09-02T00:00:00Z",
    instances: [{
      profile_id: overrides.profileId ?? "openai",
      client_id: overrides.clientId ?? "codex-cli",
      kind: "cli",
      supported_os: ["windows"],
      client_presence: "Unknown",
    }],
    logical_targets: [{
      id: targetId,
      profile_id: overrides.profileId ?? "openai",
      client_id: overrides.clientId ?? "codex-cli",
      scope: "global",
      path: "C:/Users/Test/.codex/skills",
      marker: "SKILL.md",
      precedence: "preferred",
      exists: overrides.exists ?? overrides.available ?? true,
      readable: overrides.available ?? true,
      writable: overrides.available ?? true,
      available: overrides.available ?? true,
      physical_id: physicalId,
    }],
    physical_targets: [{
      id: physicalId,
      path: "C:/Users/Test/.codex/skills",
      exists: overrides.available ?? true,
      readable: overrides.available ?? true,
      writable: overrides.available ?? true,
      case_behavior: "insensitive",
      logical_target_ids: [targetId],
    }],
  };
}

function deployments(targetId: string, states: DeploymentRecord["state"][]): DeploymentRecord[] {
  return states.map((state, index) => ({
    id: `deployment-${index}`,
    skill_id: `skill-${index}`,
    version_id: `version-${index}`,
    target_id: targetId,
    state,
    mode: "managed_copy",
    managed: true,
    runtime_name: "runtime",
    expected_hash: "hash",
    observed_hash: null,
  }));
}

beforeEach(() => {
  query.mockReset();
  command.mockReset();
});

it("maps discovered clients with availability status and active deployment counts", async () => {
  query
    .mockResolvedValueOnce({ type: "discovery_snapshot", payload: snapshotWithTarget({}) })
    .mockResolvedValueOnce({ type: "custom_agents", payload: [] })
    .mockResolvedValueOnce({
      type: "deployments",
      payload: [
        ...deployments("openai.codex-cli.user", ["deployed", "needs_recovery"]),
        ...deployments("other-target", ["deployed"]),
      ],
    });

  const agents = await nativeAgentFacade.list();

  expect(agents).toEqual([expect.objectContaining({
    id: "openai.codex-cli",
    status: "accessible",
    managedDeploymentCount: 2,
  })]);
});

it("marks agents whose directories exist but are unavailable as inaccessible", async () => {
  query
    .mockResolvedValueOnce({
      type: "discovery_snapshot",
      payload: snapshotWithTarget({ exists: true, available: false }),
    })
    .mockResolvedValueOnce({ type: "custom_agents", payload: [] })
    .mockResolvedValueOnce({
      type: "deployments",
      payload: deployments("openai.codex-cli.user", ["deployed"]),
    });

  const agents = await nativeAgentFacade.list();

  expect(agents).toEqual([expect.objectContaining({
    status: "inaccessible",
    managedDeploymentCount: 1,
  })]);
});

it("marks clients whose candidate directories do not exist as directory-only without paths", async () => {
  // 验收反馈（2026-09-25）：Antigravity 声明的用户级目录 ~/.gemini/config/skills
  // 在本机不存在（exists=false），不是「当前不可访问」这种真实告警；语义应为
  // 仅发现相关目录，路径不出卡，便于并入品牌内真实目录卡。
  query
    .mockResolvedValueOnce({
      type: "discovery_snapshot",
      payload: snapshotWithTarget({ exists: false, available: false }),
    })
    .mockResolvedValueOnce({ type: "custom_agents", payload: [] })
    .mockResolvedValueOnce({ type: "deployments", payload: [] });

  const agents = await nativeAgentFacade.list();

  expect(agents).toEqual([expect.objectContaining({
    status: "directory_only",
    discoveredPaths: [],
  })]);
});

it("splits existing built-in directories into separate builtin views", async () => {
  // 2026-09-25 验收裁决：内置技能目录（.codex/skills/.system）独立成只读
  // 「内置」视图，不混入用户级（终端/桌面端）目录的路径与计数；本机不存在的
  // 内置候选完全不产出视图。
  const snapshot = snapshotWithTarget({});
  snapshot.logical_targets.push({
    id: "openai.codex-cli.builtin",
    profile_id: "openai",
    client_id: "codex-cli",
    scope: "global",
    path: "C:/Users/Test/.codex/skills/.system",
    marker: "SKILL.md",
    precedence: "may_coexist",
    builtin: true,
    exists: true,
    readable: true,
    writable: true,
    available: true,
    physical_id: "physical-system",
  });
  snapshot.logical_targets.push({
    id: "openai.codex-cli.builtin-missing",
    profile_id: "openai",
    client_id: "codex-cli",
    scope: "global",
    path: "C:/Users/Test/.cursor/skills-cursor",
    marker: "SKILL.md",
    precedence: "may_coexist",
    builtin: true,
    exists: false,
    readable: false,
    writable: false,
    available: false,
    physical_id: "physical-cursor-builtin",
  });
  snapshot.physical_targets.push({
    id: "physical-system",
    path: "C:/Users/Test/.codex/skills/.system",
    exists: true,
    readable: true,
    writable: true,
    case_behavior: "insensitive",
    logical_target_ids: ["openai.codex-cli.builtin"],
  });
  query
    .mockResolvedValueOnce({ type: "discovery_snapshot", payload: snapshot })
    .mockResolvedValueOnce({ type: "custom_agents", payload: [] })
    .mockResolvedValueOnce({ type: "deployments", payload: deployments("openai.codex-cli.user", ["deployed"]) });

  const agents = await nativeAgentFacade.list();

  const normal = agents.find((agent) => agent.id === "openai.codex-cli");
  const builtin = agents.find((agent) => agent.id === "openai.codex-cli.builtin");
  expect(normal).toEqual(expect.objectContaining({
    discoveredPaths: ["C:/Users/Test/.codex/skills"],
    status: "accessible",
    managedDeploymentCount: 1,
  }));
  expect(normal?.builtin).toBeFalsy();
  expect(builtin).toEqual(expect.objectContaining({
    discoveredPaths: ["C:/Users/Test/.codex/skills/.system"],
    status: "accessible",
    builtin: true,
    // 内置目录只读观察：部署计数恒为 0。
    managedDeploymentCount: 0,
  }));
});

it("marks registered custom agents as custom with their granted directory", async () => {
  query
    .mockResolvedValueOnce({ type: "discovery_snapshot", payload: emptySnapshot })
    .mockResolvedValueOnce({
      type: "custom_agents",
      payload: [{
        id: "custom-reviewer",
        display_name: "Reviewer",
        directory: { grant_id: "grant-1", path: "D:/Agents/reviewer", operating_system: "windows" },
        profile: {
          profile_version: 1,
          research_date: "2026-09-02",
          official_references: ["https://acme.example/docs"],
          brand: "Acme",
          clients: [],
        },
      }],
    })
    .mockResolvedValueOnce({ type: "deployments", payload: [] });

  const agents = await nativeAgentFacade.list();

  expect(agents).toEqual([expect.objectContaining({
    id: "custom-reviewer",
    brand: "Acme",
    client: "custom",
    instance: "Reviewer",
    discoveredPaths: ["D:/Agents/reviewer"],
    officialReference: "https://acme.example/docs",
    status: "custom",
    managedDeploymentCount: 0,
  })]);
});

it("counts a real deployment whose record carries the physical target id (DEV-22-A)", async () => {
  // 真实提交把 deployments.target_id 写成物理目标 id；Agent 页只持有逻辑
  // 目标 id。两者必须互投影，否则刚部署完的 Skill 在本页计数为 0。
  query
    .mockResolvedValueOnce({
      type: "discovery_snapshot",
      payload: snapshotWithTarget({ targetId: "openai.codex-cli.user", physicalId: "physical-1" }),
    })
    .mockResolvedValueOnce({ type: "custom_agents", payload: [] })
    .mockResolvedValueOnce({
      type: "deployments",
      payload: [
        { ...deployments("physical-1", ["deployed"])[0], id: "dep-1", skill_id: "skill-a" },
        { ...deployments("physical-1", ["deployed"])[0], id: "dep-2", skill_id: "skill-b" },
        { ...deployments("physical-1", ["needs_recovery"])[0], id: "dep-3", skill_id: "skill-a" },
        { ...deployments("physical-other", ["deployed"])[0], id: "dep-4", skill_id: "skill-c" },
      ],
    });

  const agents = await nativeAgentFacade.list();

  // 2 个 Skill、3 条关系；别的目标的部署不混入。
  expect(agents).toEqual([expect.objectContaining({
    id: "openai.codex-cli",
    managedDeploymentCount: 2,
    managedDeploymentRelationCount: 3,
  })]);
});

it("counts a custom agent deployment recorded against its directory grant (DEV-22-A)", async () => {
  query
    .mockResolvedValueOnce({ type: "discovery_snapshot", payload: emptySnapshot })
    .mockResolvedValueOnce({
      type: "custom_agents",
      payload: [{
        id: "custom-reviewer",
        display_name: "Reviewer",
        directory: { grant_id: "grant-1", path: "D:/Agents/reviewer", operating_system: "windows" },
        profile: {
          profile_version: 1,
          research_date: "2026-09-02",
          official_references: [],
          brand: "Acme",
          clients: [],
        },
      }],
    })
    .mockResolvedValueOnce({ type: "deployments", payload: deployments("grant-1", ["deployed"]) });

  const agents = await nativeAgentFacade.list();

  expect(agents).toEqual([expect.objectContaining({
    id: "custom-reviewer",
    managedDeploymentCount: 1,
    managedDeploymentRelationCount: 1,
  })]);
});

it("aggregates managed deployments by unique skill while keeping the relation total", async () => {
  const record = (skillId: string, index: number, state: DeploymentRecord["state"] = "deployed"): DeploymentRecord => ({
    id: `deployment-${index}`,
    skill_id: skillId,
    version_id: `version-${index}`,
    target_id: "openai.codex-cli.user",
    state,
    mode: "managed_copy",
    managed: true,
    runtime_name: "runtime",
    expected_hash: "hash",
    observed_hash: null,
  });
  query
    .mockResolvedValueOnce({ type: "discovery_snapshot", payload: snapshotWithTarget({}) })
    .mockResolvedValueOnce({ type: "custom_agents", payload: [] })
    .mockResolvedValueOnce({
      type: "deployments",
      payload: [
        record("skill-a", 0),
        record("skill-a", 1),
        record("skill-b", 2),
        record("skill-a", 3, "removed"),
      ],
    });

  const agents = await nativeAgentFacade.list();

  expect(agents).toEqual([expect.objectContaining({
    id: "openai.codex-cli",
    managedDeploymentCount: 2,
    managedDeploymentRelationCount: 3,
  })]);
});

it("creates custom agents through the native command with the picked directory grant", async () => {
  command.mockResolvedValue({
    type: "custom_agent",
    payload: {
      id: "custom-reviewer",
      display_name: "Reviewer",
      directory: { grant_id: "D:/Agents/reviewer", path: "D:/Agents/reviewer", operating_system: "windows" },
      profile: {
        profile_version: 1,
        research_date: "2026-09-06",
        official_references: ["https://acme.example/docs"],
        brand: "Acme",
        clients: [],
      },
    },
  });

  await nativeAgentFacade.createCustomAgent({
    brand: "Acme",
    displayName: "Reviewer",
    directoryPath: "D:/Agents/reviewer",
    referenceUrl: "https://acme.example/docs",
  });

  expect(command).toHaveBeenCalledTimes(1);
  const request = command.mock.calls[0][0];
  expect(request.type).toBe("create_custom_agent");
  if (request.type !== "create_custom_agent") throw new Error("unexpected command");
  expect(request.payload.agent.id).toBe("custom-reviewer");
  expect(request.payload.agent.display_name).toBe("Reviewer");
  expect(request.payload.agent.directory.grant_id).toBe("D:/Agents/reviewer");
  expect(request.payload.agent.profile.brand).toBe("Acme");
  expect(request.payload.agent.profile.official_references).toEqual(["https://acme.example/docs"]);
  expect(request.payload.agent.profile.clients).toHaveLength(1);
  expect(request.payload.agent.profile.clients[0].path_candidates).toEqual([{
    marker: "SKILL.md",
    path: "D:/Agents/reviewer",
    precedence: "preferred",
    scope: "global",
  }]);
});

it("updates custom agents under their existing identifier", async () => {
  command.mockResolvedValue({
    type: "custom_agent",
    payload: {
      id: "custom-reviewer",
      display_name: "Reviewer 2",
      directory: { grant_id: "D:/Agents/reviewer", path: "D:/Agents/reviewer", operating_system: "windows" },
      profile: {
        profile_version: 1,
        research_date: "2026-09-06",
        official_references: ["https://acme.example/docs"],
        brand: "Acme",
        clients: [],
      },
    },
  });

  await nativeAgentFacade.updateCustomAgent("custom-reviewer", {
    brand: "Acme",
    displayName: "Reviewer 2",
    directoryPath: "D:/Agents/reviewer",
    referenceUrl: "https://acme.example/docs",
  });

  const request = command.mock.calls[0][0];
  expect(request.type).toBe("update_custom_agent");
  if (request.type !== "update_custom_agent") throw new Error("unexpected command");
  expect(request.payload.agent.id).toBe("custom-reviewer");
  expect(request.payload.agent.display_name).toBe("Reviewer 2");
});

it("surfaces create failures instead of pretending the agent was saved", async () => {
  command.mockRejectedValue(new Error("agent_invalid"));

  await expect(nativeAgentFacade.createCustomAgent({
    brand: "Acme",
    displayName: "Reviewer",
    directoryPath: "D:/Agents/reviewer",
    referenceUrl: "https://acme.example/docs",
  })).rejects.toThrow("agent_invalid");
});

it("removes custom agents by identifier through the native command", async () => {
  command.mockResolvedValue({
    type: "operation_summary",
    payload: { operation_id: "op-1", phase: "committed", message_code: "custom_agent.removed", error_code: null },
  });

  await nativeAgentFacade.removeCustomAgent("custom-reviewer");

  expect(command).toHaveBeenCalledWith({
    type: "remove_custom_agent",
    payload: { id: "custom-reviewer" },
  });
});

it("surfaces remove failures instead of pretending the agent was removed", async () => {
  command.mockRejectedValue(new Error("remove failed"));

  await expect(nativeAgentFacade.removeCustomAgent("custom-reviewer")).rejects.toThrow("remove failed");
});

it("reruns agent discovery through the native command", async () => {
  command.mockResolvedValue({
    type: "discovery_snapshot",
    payload: emptySnapshot,
  });

  await nativeAgentFacade.rescan();

  expect(command).toHaveBeenCalledWith({
    type: "discover_agent_targets",
    payload: null,
  });
});

it("surfaces rescan failures instead of pretending the scan ran", async () => {
  command.mockRejectedValue(new Error("scan failed"));
  await expect(nativeAgentFacade.rescan()).rejects.toThrow("scan failed");
});

it("loads the relationship overview scoped to the agent client", async () => {
  const overview: RelationshipOverview = {
    scope: { type: "agent", value: { agent_client_id: "codex-cli" } },
    directory_nodes: [],
    agent_directory_capabilities: [],
    source_relations: [],
    deployment_relations: [],
    conflict_cases: [],
    pending_governance_tasks: [],
    agent_execution_confirmed: false,
  };
  query.mockResolvedValue({ type: "relationship_overview", payload: overview });

  await expect(nativeAgentFacade.getRelationshipOverview("codex-cli")).resolves.toBe(overview);
  expect(query).toHaveBeenCalledWith({
    type: "get_relationship_overview",
    payload: { scope: { type: "agent", value: { agent_client_id: "codex-cli" } } },
  });
});

it("surfaces relationship overview failures instead of showing an empty matrix", async () => {
  query.mockRejectedValue(new Error("relationship_overview failed"));

  await expect(nativeAgentFacade.getRelationshipOverview("codex-cli")).rejects.toThrow(
    "relationship_overview failed",
  );
});

it("rejects unexpected results from the relationship overview query", async () => {
  query.mockResolvedValue({ type: "discovery_snapshot", payload: emptySnapshot });

  await expect(nativeAgentFacade.getRelationshipOverview("codex-cli")).rejects.toThrow(
    "get_relationship_overview returned an unexpected native result.",
  );
});

it("loads the governed removal impact for one relation", async () => {
  const impact = {
    relation_id: "rel-1",
    relation: null,
    ownership: "skillhub_managed",
    current_agent_reads_shared_directory: false,
    other_consumers: [],
    other_skill_paths: [],
    minimal_action: "create_governance_task",
    backup: { required: false, rollback_available: false, backup_location: null, detail: "" },
    governance_tasks: [],
    permission_limited: false,
  } as never;
  query.mockResolvedValue({ type: "relationship_removal_impact", payload: impact });

  await expect(nativeAgentFacade.getRelationshipRemovalImpact("rel-1")).resolves.toBe(impact);
  expect(query).toHaveBeenCalledWith({
    type: "get_relationship_removal_impact",
    payload: { relation_id: "rel-1" },
  });
});

it("surfaces removal impact failures instead of pretending the impact is empty", async () => {
  query.mockRejectedValue(new Error("impact failed"));

  await expect(nativeAgentFacade.getRelationshipRemovalImpact("rel-1")).rejects.toThrow("impact failed");
});
