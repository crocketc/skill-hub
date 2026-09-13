import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useOutletContext } from "react-router-dom";
import type { BootstrapOutletContext } from "../../app/AppShell";
import { DataState } from "../../ui/DataState";
import { Icon, type IconName } from "../../ui/Icon";
import { PageFrame } from "../../ui/PageFrame";
import { PageHeader } from "../../ui/PageHeader";
import { DeploymentBarChart, DeploymentDetailList } from "./DeploymentBarChart";
import { PendingSummary } from "./PendingSummary";
import { TagDistributionChart } from "./TagDistributionChart";
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
 * 已配置 Agent、发现到的 Agent、项目、部署；图标按同一次序注册，纯装饰。
 */
const compactStatIcons: IconName[] = ["agents", "discovery", "projects", "deploy"];

function OverviewHeroMetric({ metric }: { metric: OverviewMetric }) {
  const body = (
    <>
      <strong>{metric.count}</strong>
      <span>{metric.name}</span>
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

/** 紧凑统计的两行卡内容：图标 + 数字（第一行）与指标名（第二行）。 */
function CompactStatBody({ icon, metric }: { icon: IconName; metric: OverviewMetric }) {
  return (
    <>
      <span className="sh-overview__stat-figure">
        <Icon aria-hidden="true" name={icon} size={16} />
        <strong>{metric.count}</strong>
      </span>
      <span className="sh-overview__stat-name">{metric.name}</span>
    </>
  );
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

function TagDistributionPanel({
  items,
}: {
  items: ReturnType<typeof getTagItems>;
}) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const heading = t("overview.tags.heading");

  return (
    <section aria-label={heading} className="sh-overview__tag-panel">
      <div className="sh-overview__details-head">
        <h2>{heading}</h2>
        <span>{t("overview.tags.detailCount", { count: items.length })}</span>
      </div>
      <div className="sh-overview__tag-layout">
        <TagDistributionChart ariaLabel={t("overview.tags.chartAria")} items={items} />
        <div className="sh-overview__tag-details-scroll">
          <ol aria-label={heading} className="sh-overview__chart-list">
            {items.map((item) => (
              <li key={item.key}>
                <button
                  aria-label={item.buttonLabel}
                  className="sh-overview__chart-link"
                  onClick={() => navigate(item.target)}
                  type="button"
                >
                  <span>{item.label}</span>
                  <strong>{` ${item.count}`}</strong>
                </button>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
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
    <PageFrame fill width="wide">
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
              <li key={metric.name}>
                {metric.href ? (
                  <Link className="sh-overview__stat" to={metric.href}>
                    <CompactStatBody icon={compactStatIcons[index] ?? "info"} metric={metric} />
                  </Link>
                ) : (
                  <p className="sh-overview__stat">
                    <CompactStatBody icon={compactStatIcons[index] ?? "info"} metric={metric} />
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
            {deploymentItems.length > 0 ? (
              <DeploymentDetailList
                detailsLabel={t("overview.chart.detailsLabel")}
                dimension={dimension}
                items={deploymentItems}
              />
            ) : null}
          </section>

          <div className="sh-overview__rail">
            {tagItems.length > 0 ? <TagDistributionPanel items={tagItems} /> : null}
            <PendingSummary snapshot={snapshot} />
          </div>
        </section>
      </section>
    </PageFrame>
  );
}
