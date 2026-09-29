import { beforeEach, expect, it, vi } from "vitest";
import {
  queryApplication,
  type AgentDirectoryProjection,
  type DeploymentTarget as NativeDeploymentTarget,
} from "../../api/bindings";
import { nativeAgentFacade } from "./nativeApi";
import { nativeProjectFacade } from "../projects/nativeApi";
import { createNativeBatchDeploymentFacade } from "../deployment/nativeApi";
import { buildDeploymentTargetCards } from "../deployment/api";
import { selectableCompatibilityTargetIds } from "../onboarding/CompatibilityStep";
import type { CompatibilityTarget } from "../bootstrap/api";
import type { AgentDirectoryMemberFact } from "../../api/bindings";

vi.mock("../../api/bindings", () => ({
  executeCommand: vi.fn(),
  queryApplication: vi.fn(),
}));
const query = vi.mocked(queryApplication);

beforeEach(() => {
  query.mockReset();
});

/**
 * DEV-109：一套隔离发现事实（同一 AgentDirectoryProjection）同时喂给
 * Agents 列表、初始化/重新扫描向导、部署目标与项目候选四个入口，断言
 * 身份、共享数量与展示类型从头到尾一致。后端 listTargets 与投影的一致性
 * 由 Rust 侧 facade_builtin_directories 回归固定；这里固定前端各入口对
 * 同一投影的推导不漂移。
 */
const projection: AgentDirectoryProjection = { directories: [
  {
    role: "agent_native",
    identity: { kind: "verified_physical", value: "fs:ordinary" },
    path: "C:/Agents/openai/skills",
    status: "existing",
    exists: true,
    readable: true,
    writable: true,
    available: true,
    members: [
      member("ordinary-cli", "OpenAI", "openai.cli", "cli"),
      member("ordinary-desktop", "OpenAI", "openai.desktop", "desktop"),
    ],
  },
  {
    role: "shared_directory",
    identity: { kind: "verified_physical", value: "fs:shared" },
    path: "C:/Shared/.agents/skills",
    status: "existing",
    exists: true,
    readable: true,
    writable: true,
    available: true,
    members: [
      member("shared-canonical", "Agent Skills", "agent-skills.shared-directory", "shared_directory"),
      member("shared-cli", "OpenAI", "openai.cli", "cli"),
      member("shared-cursor", "Cursor", "cursor.desktop", "desktop"),
    ],
  },
  {
    role: "agent_native",
    identity: { kind: "candidate", value: "root-x::physical-x" },
    path: "C:/Agents/kimi/skills",
    status: "missing",
    exists: false,
    readable: false,
    writable: false,
    available: false,
    members: [member("pending-cli", "Kimi", "kimi.cli", "cli")],
  },
  {
    role: "builtin",
    identity: { kind: "verified_physical", value: "fs:builtin" },
    path: "C:/Apps/OpenAI/system-skills",
    status: "existing",
    exists: true,
    readable: true,
    writable: false,
    available: true,
    members: [member("builtin-1", "OpenAI", "openai.cli", "cli")],
  },
  {
    role: "project",
    identity: { kind: "verified_physical", value: "fs:project" },
    path: "D:/Work/aurora",
    status: "existing",
    exists: true,
    readable: true,
    writable: true,
    available: true,
    members: [member("project-1", "Aurora", "project", "cli")],
  },
] };

function member(
  logicalTargetId: string,
  brand: string,
  clientId: string,
  kind: "cli" | "desktop" | "shared_directory",
): AgentDirectoryMemberFact {
  return {
    logical_target_id: logicalTargetId,
    brand,
    client_id: clientId,
    kind,
    availability: { status: "existing", exists: true, readable: true, writable: true, available: true },
    capabilities: {
      deployment: { copy: true, symlink: true, junction: false },
      modes: ["managed_copy", "symbolic_link"],
      preferred_mode: "symbolic_link",
    },
    deployment_status: "not_deployed",
    managed_deployment_relation_count: 0,
    managed_deployment_count: 0,
  };
}

/** 后端 listTargets 语义的镜像（与 Rust 一致性回归同规则）。 */
const deploymentTargets: NativeDeploymentTarget[] = [
  nativeTarget("ordinary-cli", "C:/Agents/openai/skills", "fs:ordinary", false, "openai.cli"),
  nativeTarget("ordinary-desktop", "C:/Agents/openai/skills", "fs:ordinary", false, "openai.desktop"),
  nativeTarget("shared-canonical", "C:/Shared/.agents/skills", "fs:shared", true, "agent-skills.shared-directory"),
  nativeTarget("pending-cli", "C:/Agents/kimi/skills", "physical-x", false, "kimi.cli", "missing", false),
  nativeTarget("project-1", "D:/Work/aurora", "fs:project", false),
];

function nativeTarget(
  id: string,
  path: string,
  physicalId: string,
  shared: boolean,
  agentClientId?: string,
  directoryStatus?: "missing",
  available = true,
): NativeDeploymentTarget {
  return {
    id,
    label: agentClientId ?? id,
    path,
    available,
    physical_id: physicalId,
    modes: ["managed_copy", "symbolic_link"],
    agent_client_id: agentClientId ?? null,
    agent_profile_id: agentClientId ? "profile" : null,
    shared_directory: shared,
    shared_agent_brands: shared ? ["Cursor", "OpenAI"] : [],
    shared_agent_brand_kinds: shared ? { Cursor: ["desktop"], OpenAI: ["cli"] } : {},
    directory_status: directoryStatus ?? null,
    physical_identity_verified: directoryStatus !== "missing",
    preferred_mode: "symbolic_link",
  };
}

/** 向导目标（由同一投影的成员事实构造）。 */
const compatibilityTargets: CompatibilityTarget[] = projection.directories
  .filter((directory) => directory.role !== "project")
  .flatMap((directory) => directory.members.map((member) => ({
    id: member.logical_target_id,
    label: member.brand ?? member.logical_target_id,
    profileId: member.brand ?? undefined,
    kind: member.kind,
    path: directory.exists ? directory.path : undefined,
    physicalId: directory.identity.kind === "verified_physical" ? directory.identity.value : undefined,
    availability: directory.status === "missing" ? "pending_creation" as const : "available" as const,
  })));

it("agents, wizard, deployment and project entries agree on one set of discovery facts", async () => {
  query.mockImplementation(async (query_) => {
    if (query_.type === "get_agent_directory_projection") {
      return { type: "agent_directory_projection", payload: projection };
    }
    if (query_.type === "list_custom_agents") return { type: "custom_agents", payload: [] };
    if (query_.type === "list_deployment_targets") {
      return { type: "deployment_targets", payload: deploymentTargets };
    }
    throw new Error(`unexpected query ${query_.type}`);
  });

  // 入口 1：Agents 主列表卡片。
  const agentCards = await nativeAgentFacade.listCardModels?.() ?? [];
  const agentCardById = new Map(agentCards.map((card) => [card.id, card]));

  // 入口 2：部署目标（经同一投影回填卡模型后的合卡）。
  const deploymentFacade = createNativeBatchDeploymentFacade();
  const targets = await deploymentFacade.listTargets();
  const deploymentCards = buildDeploymentTargetCards(targets);

  // 入口 3：项目关联候选。
  const candidates = await nativeProjectFacade.listAgentCandidates();

  // 入口 4：初始化/重新扫描向导可选目标。
  const wizardSelectable = selectableCompatibilityTargetIds(compatibilityTargets, projection);

  // —— 身份一致：普通卡一张、成员两个；共享目录恰好一张卡、一个部署入口。
  expect(agentCards.filter((card) => card.sharedDirectory)).toHaveLength(1);
  expect(deploymentCards.filter((card) => card.target.sharedDirectory)).toHaveLength(1);
  const sharedCard = agentCards.find((card) => card.sharedDirectory)!;
  expect(sharedCard.members.map((member) => member.id).sort())
    .toEqual(["shared-canonical", "shared-cli", "shared-cursor"]);

  // 普通品牌卡在 Agents 与部署两侧是同一组合卡（同 id、同成员集合）。
  const ordinaryCard = agentCards.find((card) => card.members.some((member) => member.id === "ordinary-cli"))!;
  const ordinaryDeploymentCard = deploymentCards.find((card) => card.cardModel?.id === ordinaryCard.id)!;
  expect(ordinaryDeploymentCard.targets.map((target) => target.id).sort())
    .toEqual(["ordinary-cli", "ordinary-desktop"]);

  // 待建目录在 Agents、部署、向导三侧都保留且可创建，不被静默过滤。
  const pendingCard = agentCardById.get("agent_native:candidate:root-x::physical-x");
  expect(pendingCard?.directories[0]).toMatchObject({ status: "pending_creation" });
  expect(targets.find((target) => target.id === "pending-cli")).toMatchObject({ available: false });
  expect(wizardSelectable).not.toContain("pending-cli");

  // 内置目录保留卡但不进部署目标。
  expect(agentCards.some((card) => card.builtin)).toBe(true);
  expect(targets.some((target) => target.id === "builtin-1")).toBe(false);

  // 项目是独立实体卡：Agents 侧一张，不混入 Agent 品牌；项目候选不含它。
  const projectCards = agentCards.filter((card) => card.directories.every((directory) => directory.role === "project"));
  expect(projectCards).toHaveLength(1);
  expect(candidates.find((candidate) => candidate.id === projectCards[0]!.id)).toBeUndefined();

  // —— 类型与数量一致：项目候选的品牌/类型与 Agents 卡一致；共享候选成员
  // 是品牌成员（不含 agent-skills canonical），可选成员与可访问成员一致。
  const ordinaryCandidate = candidates.find((candidate) => candidate.id === ordinaryCard.id)!;
  expect([...(ordinaryCandidate.memberIds ?? [])].sort()).toEqual(["ordinary-cli", "ordinary-desktop"]);
  expect([...(ordinaryCandidate.kinds ?? [])].sort()).toEqual(ordinaryCard.kinds.slice().sort());
  const sharedCandidate = candidates.find((candidate) => candidate.sharedDirectory)!;
  expect([...(sharedCandidate.selectableMemberIds ?? [])].sort()).toEqual(["shared-cli", "shared-cursor"]);

  // 向导可选集合 = 全体可用成员（含内置卡成员；待建不可选）。
  expect([...wizardSelectable].sort()).toEqual([
    "builtin-1",
    "ordinary-cli", "ordinary-desktop",
    "shared-canonical", "shared-cli", "shared-cursor",
  ]);
});
