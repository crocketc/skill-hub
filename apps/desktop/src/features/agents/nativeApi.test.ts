import { beforeEach, expect, it, vi } from "vitest";
import {
  executeCommand,
  queryApplication,
  type DeploymentRecord,
  type DiscoverySnapshot,
  type AgentDirectoryProjection,
  type CustomAgent,
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
    agent_roots: [{
      id: "root-1",
      profile_id: overrides.profileId ?? "openai",
      client_id: overrides.clientId ?? "codex-cli",
      scope: "global",
      path: "C:/Users/Test/.codex",
      status: "existing",
      exists: true,
      readable: true,
      writable: true,
      physical_id: "root-physical-1",
      physical_identity_verified: true,
    }],
    logical_targets: [{
      id: targetId,
      profile_id: overrides.profileId ?? "openai",
      client_id: overrides.clientId ?? "codex-cli",
      scope: "global",
      path: "C:/Users/Test/.codex/skills",
      agent_root_id: "root-1",
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

it("loads canonical directory card facts and preserves logical member identities", async () => {
  const projection: AgentDirectoryProjection = { directories: [{
    role: "agent_native",
    identity: { kind: "verified_physical", value: "physical-codex" },
    path: "C:/Users/Test/.codex/skills",
    status: "existing",
    exists: true,
    readable: true,
    writable: true,
    available: true,
    members: [
      {
        logical_target_id: "openai.codex-cli",
        brand: "OpenAI",
        client_id: "codex-cli",
        kind: "cli",
        availability: { status: "existing", exists: true, readable: true, writable: true, available: true },
        capabilities: { deployment: { copy: true, symlink: true, junction: false }, modes: ["managed_copy", "symbolic_link"], preferred_mode: "symbolic_link" },
        deployment_status: "not_deployed",
        managed_deployment_relation_count: 0,
        managed_deployment_count: 0,
      },
      {
        logical_target_id: "openai.codex-desktop",
        brand: "OpenAI",
        client_id: "codex-desktop",
        kind: "desktop",
        availability: { status: "existing", exists: true, readable: true, writable: true, available: true },
        capabilities: { deployment: { copy: true, symlink: false, junction: true }, modes: ["managed_copy", "directory_junction"], preferred_mode: "managed_copy" },
        deployment_status: "not_deployed",
        managed_deployment_relation_count: 0,
        managed_deployment_count: 0,
      },
    ],
  }] };
  query
    .mockResolvedValueOnce({ type: "agent_directory_projection", payload: projection })
    .mockResolvedValueOnce({ type: "custom_agents", payload: [] })
    .mockResolvedValueOnce({ type: "deployments", payload: [] });

  const models = await nativeAgentFacade.listCardModels?.();

  expect(query).toHaveBeenCalledWith({ type: "get_agent_directory_projection", payload: null });
  expect(models).toHaveLength(1);
  expect(models?.[0]).toMatchObject({
    brand: "OpenAI",
    kinds: ["desktop", "cli"],
    detailTarget: "openai.codex-cli",
    supportedModes: ["managed_copy"],
    members: [
      { id: "openai.codex-cli", client: "codex-cli" },
      { id: "openai.codex-desktop", client: "codex-desktop" },
    ],
  });
});

const customAgentPayload: CustomAgent = {
  id: "custom-acme",
  display_name: "Acme Reviewer",
  directory: { grant_id: "D:/Agents/acme", path: "D:/Agents/acme", operating_system: "windows" },
  profile: {
    profile_version: 1,
    research_date: "2026-09-06",
    official_references: ["https://acme.example/docs"],
    brand: "Acme",
    clients: [{
      id: "acme.cli",
      kind: "cli",
      display_name: "Acme",
      supported_os: ["windows"],
      path_candidates: [],
      skill_marker: "SKILL.md",
      deployment: { copy: true, symlink: false, junction: false },
      call_policy: "unknown",
    }],
  },
};

it("builds custom agent cards from verified projection facts without duplicate cards", async () => {
  // DEV-105：自定义 Agent 目录事实来自统一投影的系统验证（存在性、能力交集、
  // 部署账目），持久化 id 与「custom」状态标记保留；不再单独拼旧卡片。
  const projection: AgentDirectoryProjection = { directories: [{
    role: "agent_native",
    identity: { kind: "verified_physical", value: "physical-acme" },
    path: "D:/Agents/acme",
    status: "existing",
    exists: true,
    readable: true,
    writable: true,
    available: true,
    members: [{
      logical_target_id: "custom-acme",
      brand: "Acme",
      client_id: "acme.cli",
      kind: "cli",
      availability: { status: "existing", exists: true, readable: true, writable: true, available: true },
      capabilities: { deployment: { copy: true, symlink: false, junction: false }, modes: ["managed_copy"], preferred_mode: "managed_copy" },
      deployment_status: "deployed",
      managed_deployment_relation_count: 2,
      managed_deployment_count: 1,
    }],
  }] };
  query
    .mockResolvedValueOnce({ type: "agent_directory_projection", payload: projection })
    .mockResolvedValueOnce({ type: "custom_agents", payload: [customAgentPayload] });

  const models = await nativeAgentFacade.listCardModels?.();

  expect(models).toHaveLength(1);
  expect(models?.[0]).toMatchObject({
    brand: "Acme",
    kinds: ["cli"],
    detailTarget: "custom-acme",
    supportedModes: ["managed_copy"],
  });
  expect(models?.[0]?.members[0]).toMatchObject({
    id: "custom-acme",
    status: "custom",
    brand: "Acme",
    instance: "Acme Reviewer",
    client: "acme.cli",
    officialReference: "https://acme.example/docs",
    discoveredPaths: ["D:/Agents/acme"],
    managedDeploymentCount: 1,
    managedDeploymentRelationCount: 2,
  });
});

it("keeps custom agents whose directory disappeared visible as pending creation", async () => {
  // DEV-107 原则同样适用于自定义 Agent：目录缺失不静默消失，也不误报为正常。
  const projection: AgentDirectoryProjection = { directories: [{
    role: "agent_native",
    identity: { kind: "candidate", value: "custom::custom-acme" },
    path: "D:/Agents/acme",
    status: "missing",
    exists: false,
    readable: false,
    writable: false,
    available: false,
    members: [{
      logical_target_id: "custom-acme",
      brand: "Acme",
      client_id: "acme.cli",
      kind: "cli",
      availability: { status: "missing", exists: false, readable: false, writable: false, available: false },
      capabilities: { deployment: { copy: true, symlink: false, junction: false }, modes: ["managed_copy"], preferred_mode: "managed_copy" },
      deployment_status: "not_deployed",
      managed_deployment_relation_count: 0,
      managed_deployment_count: 0,
    }],
  }] };
  query
    .mockResolvedValueOnce({ type: "agent_directory_projection", payload: projection })
    .mockResolvedValueOnce({ type: "custom_agents", payload: [customAgentPayload] });

  const models = await nativeAgentFacade.listCardModels?.();

  expect(models).toHaveLength(1);
  expect(models?.[0]?.members[0]).toMatchObject({ id: "custom-acme", status: "custom" });
  expect(models?.[0]?.directories[0]).toMatchObject({ status: "pending_creation", path: null });
});

it("resolves detail views from the unified projection so list and detail agree", async () => {
  // DEV-105：合卡点进详情必须看到同一类型、目录与能力；detailTarget（逻辑
  // 成员 id）必须能直接解析，不再依赖旧 {profile}.{client} id 空间。
  const projection: AgentDirectoryProjection = { directories: [{
    role: "agent_native",
    identity: { kind: "verified_physical", value: "physical-codex" },
    path: "C:/Users/Test/.codex/skills",
    status: "existing",
    exists: true,
    readable: true,
    writable: true,
    available: true,
    members: [
      {
        logical_target_id: "openai:codex-cli:global:skills",
        brand: "OpenAI",
        client_id: "codex-cli",
        kind: "cli",
        availability: { status: "existing", exists: true, readable: true, writable: true, available: true },
        capabilities: { deployment: { copy: true, symlink: true, junction: false }, modes: ["managed_copy", "symbolic_link"], preferred_mode: "symbolic_link" },
        deployment_status: "not_deployed",
        managed_deployment_relation_count: 0,
        managed_deployment_count: 0,
      },
      {
        logical_target_id: "openai:codex-desktop:global:skills",
        brand: "OpenAI",
        client_id: "codex-desktop",
        kind: "desktop",
        availability: { status: "existing", exists: true, readable: true, writable: true, available: true },
        capabilities: { deployment: { copy: true, symlink: false, junction: true }, modes: ["managed_copy", "directory_junction"], preferred_mode: "managed_copy" },
        deployment_status: "not_deployed",
        managed_deployment_relation_count: 0,
        managed_deployment_count: 0,
      },
    ],
  }] };
  query
    .mockResolvedValueOnce({ type: "agent_directory_projection", payload: projection })
    .mockResolvedValueOnce({ type: "custom_agents", payload: [] });

  const detail = await nativeAgentFacade.get("openai:codex-desktop:global:skills");

  // 合卡详情按整卡呈现：与列表同一类型、目录、成员和能力（DEV-105）。
  expect(detail).toMatchObject({
    id: "openai:codex-cli:global:skills",
    brand: "OpenAI",
    kinds: ["desktop", "cli"],
  });
  // 详情目录事实与合卡同源：能力是成员交集，不是单个成员的事实。
  expect(detail.directoryViews?.[0]).toMatchObject({
    status: "existing",
    supportedModes: ["managed_copy"],
  });
  expect(detail.directoryMembers?.map((member) => member.client_id)).toEqual(["codex-cli", "codex-desktop"]);
  expect(detail.relations.map((relation) => relation.logicalTargetId)).toEqual([
    "openai:codex-cli:global:skills",
    "openai:codex-desktop:global:skills",
  ]);
});

it("keeps the persisted custom identity on the detail read path", async () => {
  const projection: AgentDirectoryProjection = { directories: [{
    role: "agent_native",
    identity: { kind: "candidate", value: "custom::custom-acme" },
    path: "D:/Agents/acme",
    status: "existing",
    exists: true,
    readable: true,
    writable: true,
    available: true,
    members: [{
      logical_target_id: "custom-acme",
      brand: "Acme",
      client_id: "acme.cli",
      kind: "cli",
      availability: { status: "existing", exists: true, readable: true, writable: true, available: true },
      capabilities: { deployment: { copy: true, symlink: false, junction: false }, modes: ["managed_copy"], preferred_mode: "managed_copy" },
      deployment_status: "not_deployed",
      managed_deployment_relation_count: 0,
      managed_deployment_count: 0,
    }],
  }] };
  query
    .mockResolvedValueOnce({ type: "agent_directory_projection", payload: projection })
    .mockResolvedValueOnce({ type: "custom_agents", payload: [customAgentPayload] });

  const detail = await nativeAgentFacade.get("custom-acme");

  // 自定义 Agent 详情保留持久化身份与「custom」状态（编辑/移除入口依赖它）。
  expect(detail).toMatchObject({
    id: "custom-acme",
    status: "custom",
    instance: "Acme Reviewer",
    discoveredPaths: ["D:/Agents/acme"],
  });
});

it("falls back to legacy discovery facts when the projection query is unavailable", async () => {
  query
    .mockRejectedValueOnce(new Error("bridge too old"))
    // 并发的 list_custom_agents 也会消费一次查询结果。
    .mockResolvedValueOnce({ type: "custom_agents", payload: [] })
    .mockResolvedValueOnce({ type: "discovery_snapshot", payload: snapshotWithTarget({}) })
    .mockResolvedValueOnce({ type: "custom_agents", payload: [] })
    .mockResolvedValueOnce({ type: "deployments", payload: [] })
    .mockResolvedValueOnce({ type: "deployment_targets", payload: [] });

  const detail = await nativeAgentFacade.get("openai.codex-cli");

  expect(detail).toMatchObject({ id: "openai.codex-cli", status: "accessible" });
});

it("carries the authoritative ClientKind into the view instead of id-string guesses", async () => {
  // 2026-09-25 验收反馈：pi.coding-agent / OpenClaw / Hermes 的 id 不含
  // cli/headless 关键词，卡片此前只能显示「Agent」；kind 的权威事实在
  // discovery 快照的 ClientKind 里，必须随视图传递。
  query
    .mockResolvedValueOnce({ type: "discovery_snapshot", payload: snapshotWithTarget({
      targetId: "pi.coding-agent.user",
      profileId: "pi",
      clientId: "pi.coding-agent",
    }) })
    .mockResolvedValueOnce({ type: "custom_agents", payload: [] })
    .mockResolvedValueOnce({ type: "deployments", payload: [] });
  // snapshotWithTarget 固定 kind: "cli"；用 headless 客户端再断言一次透传。
  const agents = await nativeAgentFacade.list();
  expect(agents).toEqual([expect.objectContaining({
    id: "pi.pi.coding-agent",
    kinds: ["cli"],
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
    usage_relations: [],
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
