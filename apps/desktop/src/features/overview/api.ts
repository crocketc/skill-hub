import type {
  BootstrapSnapshot,
  ConflictWorkspace,
  DeploymentChartCategory,
  DeploymentDimension,
  PendingKind,
  RelationGovernanceLedger,
  SkillRelationshipCandidate,
} from "../../api/bindings";
import type { TFunction } from "i18next";

export type OverviewDimension = DeploymentDimension;

export interface OverviewMetric {
  href?: string;
  count: number;
  /**
   * 不带数量的指标名（如 "configured agents"）。紧凑卡渲染成
   * 数字 + 指标名两行结构；可访问名称由 count 与 name 组合而成
   * （如 "3 configured agents"）。
   */
  name: string;
  tone: "accent" | "neutral";
}

export interface OverviewDeploymentItem {
  buttonLabel: string;
  count: number;
  key: string;
  label: string;
  target: string;
}

export interface PendingSummaryItem {
  count: number;
  key: PendingKind;
  label: string;
}

const pendingKindOrder: PendingKind[] = ["security_finding", "recovery", "trial_due"];

function deploymentTarget(dimension: DeploymentDimension, key: string) {
  if (dimension === "agent") {
    return `/agents/${key}?view=deployments`;
  }

  return `/projects/${key}?view=deployments`;
}

/**
 * DEV-22-A：`label_code` 可能是 i18n 键（后端按维度兜底时给的就是
 * `deployment.dimension.agent` 这类内部键），绝不能原样渲染；翻译不出来时
 * 才把它当作现成名称使用。
 */
function deploymentLabel(category: DeploymentChartCategory, t: TFunction): string {
  return String(t(category.label_code as never, { defaultValue: category.label_code } as never));
}

export function getOverviewMetrics(
  snapshot: BootstrapSnapshot,
  t: TFunction,
): OverviewMetric[] {
  // P1-07 信息架构：每个指标的钻取去向唯一且目的明确——
  // skills → /library（库维护全部 Skill）；agents → /agents（管理已登记
  // 部署目标）；discoveredAgents → /discovery/local（处理本机发现快照中
  // 的 Agent 实例，发现→纳管走 /discovery 流程）；projects → /projects；
  // deployments → /library?deployment=deployed（过滤处于部署状态的 Skill）。
  return [
    {
      count: snapshot.skill_count,
      href: "/library",
      name: t("overview.metrics.names.skills"),
      tone: "accent",
    },
    {
      count: snapshot.agent_count,
      href: "/agents",
      // 已确认的部署目标数；与“发现到的 Agent”分开命名、分开去向，避免口径混淆。
      name: t("overview.metrics.names.agents"),
      tone: "neutral",
    },
    {
      count: snapshot.discovered_agent_count,
      // 钻取本机发现工作台而非 /agents：发现到的实例尚未成为可管理的
      // 部署目标，纳管必须经 /discovery 流程确认。
      href: "/discovery/local",
      name: t("overview.metrics.names.discoveredAgents"),
      tone: "neutral",
    },
    {
      count: snapshot.project_count,
      href: "/projects",
      name: t("overview.metrics.names.projects"),
      tone: "neutral",
    },
    {
      count: snapshot.deployed_count,
      href: "/library?deployment=deployed",
      name: t("overview.metrics.names.deployments"),
      tone: "neutral",
    },
  ];
}

export function getDeploymentItems(
  snapshot: BootstrapSnapshot,
  dimension: OverviewDimension,
  t: TFunction,
  /** 类别 key（Agent 客户端 id / 项目 id）到可读名称的映射；缺省退回翻译结果。 */
  names?: ReadonlyMap<string, string>,
): OverviewDeploymentItem[] {
  return snapshot.deployment_categories
    .filter((category) => category.dimension === dimension)
    .sort((left, right) => right.count - left.count || left.label_code.localeCompare(right.label_code))
    .map((category) => {
      const label = names?.get(category.key) ?? deploymentLabel(category, t);
      return {
        buttonLabel: t(`overview.chart.drilldown.${dimension}`, {
          count: category.count,
          label,
        }),
        count: category.count,
        key: category.key,
        label,
        target: deploymentTarget(dimension, category.key),
      };
    });
}

/**
 * Per-tag skill counts from the bootstrap snapshot, each drilling into the
 * library with the tag URL parameter the library page already parses.
 */
export function getTagItems(
  snapshot: BootstrapSnapshot,
  t: TFunction,
): OverviewDeploymentItem[] {
  return [...snapshot.tag_categories]
    .sort((left, right) => right.count - left.count || left.key.localeCompare(right.key))
    .map((category) => {
      const label = category.key === "__untagged__" ? String(t("overview.tags.untagged" as never)) : category.key;
      return {
        buttonLabel: t("overview.tags.drilldown", { count: category.count, label }),
        count: category.count,
        key: category.key,
        label,
        target: category.key === "__untagged__" ? "/library" : `/library?tag=${encodeURIComponent(category.key)}`,
      };
    });
}

export function getPendingSummaryItems(
  snapshot: BootstrapSnapshot,
  t: TFunction,
): PendingSummaryItem[] {
  return pendingKindOrder.flatMap((key) => {
    const count = snapshot.pending.by_kind[key];
    if (!count) {
      return [];
    }

    return [
      {
        count,
        key,
        label: t(`overview.pending.kinds.${key}`, { count }),
      },
    ];
  });
}

/** 关系缩略区域深链目标。路由由页面切片接线，数据层只提供稳定 key。 */
export type OverviewRelationEntryKey = "conflicts" | "graph" | "governance";

/**
 * 任务 9 页面切片接线的深链目标（路由由任务 5 交付，URL 即状态）。
 * 图谱入口固定不带 skillId：缩略条目只携带稳定 key，概览不伪造
 * 图谱选中态——skillId 深链由技能详情等持有事实的入口发起。
 */
export function getOverviewRelationEntryHref(key: OverviewRelationEntryKey): string {
  if (key === "graph") {
    return "/relationships";
  }
  return key === "conflicts" ? "/relationships/decisions" : "/relationships/governance";
}

export interface OverviewRelationEntry {
  count: number;
  key: OverviewRelationEntryKey;
  label: string;
}

/**
 * 任务 1/2 冻结查询的聚合结果。三个来源都可以缺省（查询失败、事实尚未
 * 生成或旧快照）：缺省按 0 计，概览已有内容不受影响。
 */
export interface OverviewRelationSummarySource {
  /** 任务 2 冲突工作台投影；`cases` 即未确认（uncertain 且无决定）冲突全集。 */
  conflictWorkspace?: ConflictWorkspace | null;
  /** 关系治理台账；`total` 为已建立的关系边总数。 */
  governanceLedger?: RelationGovernanceLedger | null;
  /** 任务 1 候选列表（不过滤查询的全量结果）：有可展示关系事实的 Skill。 */
  relationshipCandidates?: SkillRelationshipCandidate[] | null;
}

/**
 * 按部署维度汇总部署关系条数。与部署柱状图同源（bootstrap 快照的
 * `deployment_categories`），保证指标主数与括号拆分、柱状图三者一致；
 * 未纳管部署与发现快照一样不计入该口径。
 */
function deploymentRelationTotals(snapshot: BootstrapSnapshot): {
  agentRelations: number;
  projectRelations: number;
} {
  let agentRelations = 0;
  let projectRelations = 0;
  for (const category of snapshot.deployment_categories) {
    if (category.dimension === "agent") {
      agentRelations += category.count;
    } else {
      projectRelations += category.count;
    }
  }
  return { agentRelations, projectRelations };
}

/**
 * 概览融合后的五个指标，显示名称与口径为冻结契约：
 * 技能总数、Agent（已配置/已发现合并口径）、管理项目、
 * Skill 部署关系（按 Agent/项目拆分）、待确认的关系冲突。
 * 冲突数直接复用任务 2 工作台投影的 `cases`（已实现待确认筛选），
 * 本模块不重新实现另一套筛选规则；`conflictWorkspace` 缺省按 0 计。
 */
export function getOverviewSummaryMetrics(
  snapshot: BootstrapSnapshot,
  conflictWorkspace: ConflictWorkspace | null,
  t: TFunction,
): OverviewMetric[] {
  const { agentRelations, projectRelations } = deploymentRelationTotals(snapshot);
  return [
    {
      count: snapshot.skill_count,
      href: "/library",
      name: t("overview.summary.metrics.skillsTotal"),
      tone: "accent",
    },
    {
      count: snapshot.agent_count,
      href: "/agents",
      // “已发现”继续指发现快照口径（discovered_agent_count），
      // 与“已配置”的部署目标口径在同一条指标内并列展示、互不混用。
      name: t("overview.summary.metrics.agentsCombined", {
        configured: snapshot.agent_count,
        discovered: snapshot.discovered_agent_count,
      }),
      tone: "neutral",
    },
    {
      count: snapshot.project_count,
      href: "/projects",
      name: t("overview.summary.metrics.projectsManage"),
      tone: "neutral",
    },
    {
      count: agentRelations + projectRelations,
      href: "/library?deployment=deployed",
      name: t("overview.summary.metrics.deploymentRelations", {
        agentCount: agentRelations,
        projectCount: projectRelations,
      }),
      tone: "neutral",
    },
    {
      // 冲突数复用任务 2 工作台投影的 `cases`（已实现待确认筛选）；
      // 钻取目标 /relationships/decisions 由任务 5 交付、任务 9 页面切片接线。
      count: conflictWorkspace?.cases.length ?? 0,
      href: "/relationships/decisions",
      name: t("overview.summary.metrics.unconfirmedConflicts"),
      tone: "neutral",
    },
  ];
}

/**
 * 关系缩略区域的三个入口计数：图谱（有关系事实的 Skill 数，任务 1）、
 * 冲突处理（待确认冲突数，任务 2 投影）、治理（已建立关系边数，治理台账）。
 * 输入缺省时返回 0 计数的完整条目，页面仍可渲染占位。
 */
export function getOverviewRelationEntries(
  source: OverviewRelationSummarySource,
  t: TFunction,
): OverviewRelationEntry[] {
  return [
    {
      count: source.relationshipCandidates?.length ?? 0,
      key: "graph",
      label: t("overview.summary.entries.graph"),
    },
    {
      count: source.conflictWorkspace?.cases.length ?? 0,
      key: "conflicts",
      label: t("overview.summary.entries.conflicts"),
    },
    {
      count: source.governanceLedger?.total ?? 0,
      key: "governance",
      label: t("overview.summary.entries.governance"),
    },
  ];
}
