import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useOutletContext } from "react-router-dom";
import type { BootstrapSnapshot } from "../../api/bindings";
import { DataState } from "../../ui/DataState";
import { DeploymentBarChart, DeploymentDetailList } from "./DeploymentBarChart";
import { PendingSummary } from "./PendingSummary";
import {
  getDeploymentItems,
  getOverviewMetrics,
  getTagItems,
  type OverviewDimension,
} from "./api";

function OverviewMetricCard({
  count,
  href,
  label,
  tone,
}: {
  count: number;
  href?: string;
  label: string;
  tone: "accent" | "neutral";
}) {
  const body = (
    <>
      <strong>{count}</strong>
      <span>{label}</span>
    </>
  );
  const className =
    tone === "accent"
      ? "sh-overview__metric sh-overview__metric--hero"
      : "sh-overview__metric";
  if (href) {
    return (
      <Link className={className} to={href}>
        {body}
      </Link>
    );
  }
  return (
    <article className={className}>
      {body}
    </article>
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

export function OverviewPage() {
  const snapshot = useOutletContext<BootstrapSnapshot>();
  const { t } = useTranslation();
  const [dimension, setDimension] = useState<OverviewDimension>("agent");
  const metrics = getOverviewMetrics(snapshot, t);
  const deploymentItems = getDeploymentItems(snapshot, dimension, t);
  const tagItems = getTagItems(snapshot, t);

  return (
    <section className="sh-overview">
      <section className="sh-overview__metrics">
        {metrics.map((metric, index) => (
          <OverviewMetricCard
            count={metric.count}
            href={metric.href}
            key={`${metric.label}-${index}`}
            label={metric.label}
            tone={metric.tone}
          />
        ))}
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
  );
}
