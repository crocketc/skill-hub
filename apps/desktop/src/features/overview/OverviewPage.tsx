import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useOutletContext } from "react-router-dom";
import type { BootstrapOutletContext } from "../../app/AppShell";
import { DataState } from "../../ui/DataState";
import { Icon, type IconName } from "../../ui/Icon";
import { PageFrame } from "../../ui/PageFrame";
import { PageHeader } from "../../ui/PageHeader";
import { DeploymentBarChart, DeploymentDetailList } from "./DeploymentBarChart";
import { PendingSummary } from "./PendingSummary";
import {
  getDeploymentItems,
  getOverviewMetrics,
  getTagItems,
  type OverviewDimension,
  type OverviewMetric,
} from "./api";
import "./overview.css";

/**
 * 紧凑统计的装饰图标映射。`getOverviewMetrics` 的口径顺序固定为
 * 已配置 Agent、发现到的 Agent、项目、部署；同指向 /agents 的两项按
 * 出现次序区分（已配置=agents，发现到=discovery）。
 */
const compactStatIcons: IconName[] = ["agents", "discovery", "projects", "deploy"];

function OverviewHeroMetric({ metric }: { metric: OverviewMetric }) {
  const body = (
    <>
      <strong aria-hidden="true">{metric.count}</strong>
      <span>{metric.label}</span>
    </>
  );

  if (metric.href) {
    return (
      <Link className="sh-overview__hero" to={metric.href}>
        {body}
      </Link>
    );
  }
  return <article className="sh-overview__hero">{body}</article>;
}

function DeploymentDimensionToggle({
  onChange,
  value,
}: {
  onChange: (next: OverviewDimension) => void;
  value: OverviewDimension;
}) {
  const { t } = useTranslation();

  return (
    <fieldset className="sh-overview__toggle">
      <legend className="sh-visually-hidden">{t("overview.chart.dimensionLabel")}</legend>
      <label className="sh-overview__toggle-option">
        <input
          checked={value === "agent"}
          name="overview-dimension"
          onChange={() => onChange("agent")}
          type="radio"
        />
        <span>{t("overview.chart.dimensions.agent")}</span>
      </label>
      <label className="sh-overview__toggle-option">
        <input
          checked={value === "project"}
          name="overview-dimension"
          onChange={() => onChange("project")}
          type="radio"
        />
        <span>{t("overview.chart.dimensions.project")}</span>
      </label>
    </fieldset>
  );
}

export function OverviewPage() {
  const { snapshot } = useOutletContext<BootstrapOutletContext>();
  const { t } = useTranslation();
  const [dimension, setDimension] = useState<OverviewDimension>("agent");
  const metrics = getOverviewMetrics(snapshot, t);
  const heroMetric =
    metrics.find((metric) => metric.tone === "accent") ?? metrics[0];
  const compactMetrics = metrics.filter((metric) => metric !== heroMetric);
  const deploymentItems = getDeploymentItems(snapshot, dimension, t);
  const tagItems = getTagItems(snapshot, t);

  return (
    <PageFrame width="wide">
      <PageHeader
        description={t("overview.page.description")}
        title={t("navigation.overview")}
      />
      <section className="sh-overview">
        <section className="sh-overview__metrics">
          <OverviewHeroMetric metric={heroMetric} />
          <ul
            aria-label={t("overview.metrics.compactLabel")}
            className="sh-overview__stats"
          >
            {compactMetrics.map((metric, index) => (
              <li key={metric.label}>
                {metric.href ? (
                  <Link className="sh-overview__stat" to={metric.href}>
                    <Icon
                      aria-hidden="true"
                      name={compactStatIcons[index] ?? "info"}
                      size={16}
                    />
                    <span>{metric.label}</span>
                  </Link>
                ) : (
                  <p className="sh-overview__stat">
                    <Icon
                      aria-hidden="true"
                      name={compactStatIcons[index] ?? "info"}
                      size={16}
                    />
                    <span>{metric.label}</span>
                  </p>
                )}
              </li>
            ))}
          </ul>
        </section>

        <section className="sh-overview__content-grid">
          <section className="sh-overview__panel">
            <div className="sh-overview__section-head">
              <div>
                <p className="sh-overview__eyebrow">{t("overview.chart.eyebrow")}</p>
                <h2>{t("overview.chart.heading")}</h2>
              </div>
              <DeploymentDimensionToggle onChange={setDimension} value={dimension} />
            </div>
            {deploymentItems.length > 0 ? (
              <DeploymentBarChart
                ariaLabel={t(`overview.chart.aria.${dimension}`)}
                dimension={dimension}
                items={deploymentItems}
              />
            ) : (
              <DataState
                message={t(`overview.chart.empty.${dimension}`)}
                state="empty"
              />
            )}
          </section>

          <div className="sh-overview__rail">
            <PendingSummary snapshot={snapshot} />
            {deploymentItems.length > 0 ? (
              <DeploymentDetailList
                detailsLabel={t("overview.chart.detailsLabel")}
                dimension={dimension}
                items={deploymentItems}
              />
            ) : null}
            {tagItems.length > 0 ? (
              <DeploymentDetailList
                countLabel={t("overview.tags.detailCount", { count: tagItems.length })}
                detailsLabel={t("overview.tags.heading")}
                dimension={dimension}
                items={tagItems}
              />
            ) : null}
          </div>
        </section>
      </section>
    </PageFrame>
  );
}
