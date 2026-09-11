import type {
  BootstrapSnapshot,
  DeploymentChartCategory,
  DeploymentDimension,
  PendingKind,
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

function deploymentLabel(category: DeploymentChartCategory): string {
  return category.label_code;
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
): OverviewDeploymentItem[] {
  return snapshot.deployment_categories
    .filter((category) => category.dimension === dimension)
    .sort((left, right) => right.count - left.count || left.label_code.localeCompare(right.label_code))
    .map((category) => {
      const label = deploymentLabel(category);
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
    .map((category) => ({
      buttonLabel: t("overview.tags.drilldown", {
        count: category.count,
        label: category.key,
      }),
      count: category.count,
      key: category.key,
      label: category.key,
      target: `/library?tag=${encodeURIComponent(category.key)}`,
    }));
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
