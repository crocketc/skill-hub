import type {
  BootstrapSnapshot,
  DeploymentChartCategory,
  DeploymentDimension,
  PendingKind,
} from "../../api/bindings";
import type { TFunction } from "i18next";

export type OverviewDimension = DeploymentDimension;

export interface OverviewMetric {
  count: number;
  label: string;
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
  return [
    {
      count: snapshot.skill_count,
      label: t("overview.metrics.skills", { count: snapshot.skill_count }),
      tone: "accent",
    },
    {
      count: snapshot.agent_count,
      label: t("overview.metrics.agents", { count: snapshot.agent_count }),
      tone: "neutral",
    },
    {
      count: snapshot.project_count,
      label: t("overview.metrics.projects", { count: snapshot.project_count }),
      tone: "neutral",
    },
    {
      count: snapshot.deployed_count,
      label: t("overview.metrics.deployments", { count: snapshot.deployed_count }),
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
