import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useOutletContext } from "react-router-dom";
import type { BootstrapSnapshot } from "../../api/bindings";
import { DataState } from "../../ui/DataState";
import { DeploymentBarChart } from "./DeploymentBarChart";
import { PendingSummary } from "./PendingSummary";
import {
  getDeploymentItems,
  getOverviewMetrics,
  type OverviewDimension,
} from "./api";

function OverviewMetricCard({
  count,
  label,
  tone,
}: {
  count: number;
  label: string;
  tone: "accent" | "neutral";
}) {
  return (
    <article
      className={
        tone === "accent"
          ? "sh-overview__metric sh-overview__metric--hero"
          : "sh-overview__metric"
      }
    >
      <strong>{count}</strong>
      <span>{label}</span>
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

  return (
    <section className="sh-overview">
      <section className="sh-overview__metrics">
        {metrics.map((metric, index) => (
          <OverviewMetricCard
            count={metric.count}
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
              detailsLabel={t("overview.chart.detailsLabel")}
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

        <PendingSummary snapshot={snapshot} />
      </section>
    </section>
  );
}
