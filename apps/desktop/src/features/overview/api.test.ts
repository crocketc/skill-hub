import { beforeEach, expect, it } from "vitest";
import type {
  BootstrapSnapshot,
  ConflictWorkspace,
  RelationGovernanceLedger,
  SkillRelationshipCandidate,
} from "../../api/bindings";
import { createSkillHubI18n } from "../../i18n";
import { getDeploymentItems, getOverviewRelationEntries, getOverviewRelationEntryHref, getOverviewSummaryMetrics } from "./api";
import type { OverviewDeploymentName } from "./deploymentNames";
import type { AgentKindKey } from "../../ui/AgentPresentation";

const summarySnapshot: BootstrapSnapshot = {
  initialization_state: "initialized",
  library_path: "C:\\Users\\Test\\SkillHub",
  onboarding_skipped: false,
  agent_count: 3,
  discovered_agent_count: 5,
  deployed_count: 18,
  deployment_categories: [
    { count: 12, dimension: "agent", key: "openai.codex-cli", label_code: "Codex" },
    { count: 3, dimension: "agent", key: "anthropic.claude-code", label_code: "Claude Code" },
    { count: 3, dimension: "project", key: "project-aurora", label_code: "Aurora" },
  ],
  tag_categories: [
    { key: "writing", count: 5 },
    { key: "pdf", count: 2 },
  ],
  last_scan_at: null,
  pending: { by_kind: { recovery: 1, security_finding: 2, trial_due: 1 }, total: 4 },
  project_count: 2,
  recent_operations: [],
  recovery_state: "clean",
  skill_count: 12,
};

const emptySnapshot: BootstrapSnapshot = {
  initialization_state: "initialized",
  library_path: "",
  onboarding_skipped: false,
  agent_count: 0,
  discovered_agent_count: 0,
  deployed_count: 0,
  deployment_categories: [],
  tag_categories: [],
  last_scan_at: null,
  pending: { by_kind: {}, total: 0 },
  project_count: 0,
  recent_operations: [],
  recovery_state: "clean",
  skill_count: 0,
};

function conflictCase(conflictId: string) {
  return {
    case: {
      classification: "uncertain" as const,
      conflict_id: conflictId,
      evidence: { fingerprints_match: null, names_match: true, sufficient_identity_evidence: false },
      member_skill_ids: [],
    },
    latest_analysis: null,
    analysis_stale: false,
    recommended_decision: null,
  };
}

/** 任务 2 冻结投影：`cases` 只含待确认（uncertain 且无用户决定）的冲突。 */
const pendingConflictWorkspace: ConflictWorkspace = {
  cases: [conflictCase("conflict-1"), conflictCase("conflict-2")],
  handled_count: 1,
  handled: [
    {
      conflict_id: "conflict-0",
      decision: "keep_distinct",
      conclusion: "distinct_skill",
      decided_at: "2026-09-01T00:00:00Z",
    },
  ],
  relationship_revision: "7",
  last_verified_at: null,
};

const relationshipCandidates: SkillRelationshipCandidate[] = [
  {
    display_name: "Writer",
    last_verified_at: null,
    matched_alias: null,
    relationship_count: 2,
    relationship_revision: "7",
    runtime_name: "writer",
    skill_id: "skill-writer" as SkillRelationshipCandidate["skill_id"],
    tags: [],
  },
  {
    display_name: "Reader",
    last_verified_at: null,
    matched_alias: null,
    relationship_count: 1,
    relationship_revision: "7",
    runtime_name: "reader",
    skill_id: "skill-reader" as SkillRelationshipCandidate["skill_id"],
    tags: [],
  },
];

const governanceLedger: RelationGovernanceLedger = {
  bucket: "all",
  counts: { all: 7, blocked: 1, eligible_to_centralize: 4, needs_validation: 2, status_normal: 0, status_retained: 0, status_needs_validation: 2, status_needs_attention: 0, status_blocked: 1, source_copies: 0, deployments: 0 },
  last_verified_at: null,
  relationship_revision: "7",
  rows: [],
  total: 7,
};

beforeEach(() => {
  // 空实现占位：测试内按需创建 i18n 实例。
});

it("names the five overview metrics with the frozen zh semantics and counts", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const metrics = getOverviewSummaryMetrics(summarySnapshot, pendingConflictWorkspace, i18n.t.bind(i18n));

  expect(metrics.map((metric) => metric.count)).toEqual([12, 3, 2, 18, 2]);
  expect(metrics.map((metric) => metric.name)).toEqual([
    "技能总数",
    "Agent（已配置目标 3 个 · 已发现 5 个）",
    "管理项目",
    "Skill 配置关系（配置到 Agent 15 条 · 项目 3 条）",
    "待确认的关系冲突",
  ]);
});

it("mirrors the frozen metric names in English with the same caliber", async () => {
  const i18n = await createSkillHubI18n(["en-US"]);
  const metrics = getOverviewSummaryMetrics(summarySnapshot, pendingConflictWorkspace, i18n.t.bind(i18n));

  expect(metrics.map((metric) => metric.name)).toEqual([
    "Total skills",
    "Agents (3 configured · 5 discovered)",
    "Manage projects",
    "Skill configuration relations (15 to agents · 3 to projects)",
    "Unconfirmed relationship conflicts",
  ]);
});

it("keeps the fixed metric order, accent hero and frozen drill-down targets", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const t = i18n.t.bind(i18n);
  const metrics = getOverviewSummaryMetrics(summarySnapshot, pendingConflictWorkspace, t);

  expect(metrics.map((metric) => metric.tone)).toEqual([
    "accent",
    "neutral",
    "neutral",
    "neutral",
    "neutral",
  ]);
  // 页面切片（任务 9）接线：冲突指标钻取任务 5 已交付的 /relationships/decisions。
  expect(metrics.map((metric) => metric.href)).toEqual([
    "/library",
    "/agents",
    "/projects",
    "/library?deployment=deployed",
    "/relationships/decisions",
  ]);
});

it("maps each relation entry key to its frozen relationship subpage route", async () => {
  // 任务 5 路由即状态：图谱入口不带 skillId（条目只携带稳定 key，页面不伪造
  // 选中态）；冲突与治理各进自己的子页。任务 12.6：治理深链携带与计数
  // 同一口径的状态并集（需处理 = 待校验 + 需关注 + 受阻）。
  expect(getOverviewRelationEntryHref("graph")).toBe("/relationships");
  expect(getOverviewRelationEntryHref("conflicts")).toBe("/relationships/decisions");
  expect(getOverviewRelationEntryHref("governance")).toBe(
    "/relationships/governance?status=needs_validation,needs_attention,blocked",
  );
});

it("splits deployment relations by dimension across all chart categories", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const splitSnapshot: BootstrapSnapshot = {
    ...summarySnapshot,
    deployment_categories: [
      { count: 4, dimension: "project", key: "project-b", label_code: "B" },
      { count: 2, dimension: "agent", key: "agent-a", label_code: "A" },
      { count: 1, dimension: "project", key: "project-c", label_code: "C" },
      { count: 6, dimension: "agent", key: "agent-d", label_code: "D" },
    ],
  };

  const metrics = getOverviewSummaryMetrics(splitSnapshot, pendingConflictWorkspace, i18n.t.bind(i18n));

  expect(metrics[3].count).toBe(13);
  expect(metrics[3].name).toBe("Skill 配置关系（配置到 Agent 8 条 · 项目 5 条）");
});

it("never renders the raw i18n key as a chart label (DEV-22-A)", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  // 后端按维度分组时给的 label_code 是内部 i18n 键，必须翻译后呈现。
  const keySnapshot: BootstrapSnapshot = {
    ...summarySnapshot,
    deployment_categories: [
      { count: 4, dimension: "agent", key: "codex-cli", label_code: "deployment.dimension.agent" },
      { count: 2, dimension: "project", key: "project-aurora", label_code: "deployment.dimension.project" },
    ],
  };

  const agents = getDeploymentItems(keySnapshot, "agent", i18n.t.bind(i18n));
  const projects = getDeploymentItems(keySnapshot, "project", i18n.t.bind(i18n));

  expect(agents.map((item) => item.label)).toEqual(["Agent"]);
  expect(projects.map((item) => item.label)).toEqual(["项目"]);
  for (const item of [...agents, ...projects]) {
    expect(item.label).not.toMatch(/^deployment\./);
  }
});

it("prefers the resolved Agent/Project name over the dimension key (DEV-22-A)", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const keySnapshot: BootstrapSnapshot = {
    ...summarySnapshot,
    deployment_categories: [
      { count: 4, dimension: "agent", key: "codex-cli", label_code: "deployment.dimension.agent" },
      { count: 2, dimension: "project", key: "project-aurora", label_code: "deployment.dimension.project" },
    ],
  };
  const names = new Map<string, OverviewDeploymentName>([
    ["codex-cli", { brand: "openai", kinds: ["cli"] as AgentKindKey[] }],
    ["project-aurora", "Aurora"],
  ]);

  // Agent 类别按规则呈现「品牌 · 类型」；项目仍用纯名称。
  expect(getDeploymentItems(keySnapshot, "agent", i18n.t.bind(i18n), names).map((item) => item.label))
    .toEqual(["OpenAI · 终端"]);
  expect(getDeploymentItems(keySnapshot, "project", i18n.t.bind(i18n), names).map((item) => item.label))
    .toEqual(["Aurora"]);
});

it("attaches the brand presentation fact so the detail list can render the unified presenter (2026-09-25)", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const keySnapshot: BootstrapSnapshot = {
    ...summarySnapshot,
    deployment_categories: [
      { count: 3, dimension: "agent", key: "anthropic.claude-code", label_code: "deployment.dimension.agent" },
    ],
  };
  const names = new Map<string, OverviewDeploymentName>([
    ["anthropic.claude-code", { brand: "anthropic", kinds: ["cli"] as AgentKindKey[] }],
  ]);

  const items = getDeploymentItems(keySnapshot, "agent", i18n.t.bind(i18n), names);

  expect(items[0].presentation).toEqual({ brand: "anthropic", kinds: ["cli"] });
  // 品牌名由统一 presenter 的映射决定（anthropic → Claude）。
  expect(items[0].label).toBe("Claude · 终端");
  expect(items[0].label).not.toContain("anthropic.claude-code");
  expect(items[0].buttonLabel).toBe("查看 Claude · 终端 的 3 条配置关系");
});

it("uses the agent-page card caliber for the discovered count when provided (2026-09-25)", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const t = i18n.t.bind(i18n);

  // 覆盖值：与 Agent 页合并卡片一致（合并计 1，不展示不计）。
  const overridden = getOverviewSummaryMetrics(summarySnapshot, null, t, 7);
  expect(overridden[1].name).toBe("Agent（已配置目标 3 个 · 已发现 7 个）");

  // 未提供（查询未就绪/旧快照）：回退发现快照口径。
  const fallback = getOverviewSummaryMetrics(summarySnapshot, null, t);
  expect(fallback[1].name).toBe("Agent（已配置目标 3 个 · 已发现 5 个）");
});

it("counts exactly the unconfirmed conflicts the workspace projection already selected", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const t = i18n.t.bind(i18n);

  // 冲突数 = 工作台投影 `cases` 的长度，本模块不重新实现另一套筛选口径；
  // `handled`/`handled_count` 是历史，不回流当前计数。
  const metrics = getOverviewSummaryMetrics(summarySnapshot, pendingConflictWorkspace, t);
  expect(metrics[4].count).toBe(pendingConflictWorkspace.cases.length);
  expect(metrics[4].count).toBe(2);

  const emptyCases = getOverviewSummaryMetrics(summarySnapshot, { ...pendingConflictWorkspace, cases: [] }, t);
  expect(emptyCases[4].count).toBe(0);
});

it("returns well-defined empty shapes that keep the overview intact without relationship data", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const t = i18n.t.bind(i18n);

  const metrics = getOverviewSummaryMetrics(emptySnapshot, null, t);
  expect(metrics).toHaveLength(5);
  expect(metrics.map((metric) => metric.name)).toEqual([
    "技能总数",
    "Agent（已配置目标 0 个 · 已发现 0 个）",
    "管理项目",
    "Skill 配置关系（配置到 Agent 0 条 · 项目 0 条）",
    "待确认的关系冲突",
  ]);
  expect(metrics.map((metric) => metric.count)).toEqual([0, 0, 0, 0, 0]);

  const entries = getOverviewRelationEntries(
    {
      conflictWorkspace: null,
      governanceLedger: null,
      relationshipCandidates: null,
    },
    t,
  );
  expect(entries.map((entry) => entry.key)).toEqual(["graph", "conflicts", "governance"]);
  expect(entries.map((entry) => entry.count)).toEqual([0, 0, 0]);
});

it("builds the three relationship thumbnail entries from task 1/2 aggregates", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const zhEntries = getOverviewRelationEntries(
    {
      conflictWorkspace: pendingConflictWorkspace,
      governanceLedger,
      relationshipCandidates,
    },
    i18n.t.bind(i18n),
  );

  expect(zhEntries).toEqual([
    { count: 2, key: "graph", label: "关系图谱" },
    { count: 2, key: "conflicts", label: "冲突处理" },
    // 任务 12.6/12.16：治理入口只计需处理可管理关系（status_needs_validation
    // + status_needs_attention + status_blocked，全部来自服务端 counts，不在
    // 前端重算状态）。fixture：2 + 0 + 1 = 3。
    { count: 3, key: "governance", label: "待治理" },
  ]);

  const enI18n = await createSkillHubI18n(["en-US"]);
  const enEntries = getOverviewRelationEntries(
    {
      conflictWorkspace: pendingConflictWorkspace,
      governanceLedger,
      relationshipCandidates,
    },
    enI18n.t.bind(enI18n),
  );

  expect(enEntries.map((entry) => entry.label)).toEqual([
    "Relationship graph",
    "Conflict workspace",
    "Needs governance",
  ]);
});

it("counts needs-attention relations in the needs-governance entry", async () => {
  const i18n = await createSkillHubI18n(["zh-CN"]);
  const entries = getOverviewRelationEntries(
    {
      governanceLedger: {
        ...governanceLedger,
        counts: {
          ...governanceLedger.counts,
          status_needs_attention: 4,
        },
      },
    },
    i18n.t.bind(i18n),
  );

  // 2 待校验 + 4 需关注 + 1 受阻 = 7。
  expect(entries.find((entry) => entry.key === "governance")?.count).toBe(7);
});
