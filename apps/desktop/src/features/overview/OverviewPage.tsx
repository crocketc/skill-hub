import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useOutletContext } from "react-router-dom";
import type { BootstrapOutletContext } from "../../app/AppShell";
import { DataState } from "../../ui/DataState";
import { Icon, type IconName } from "../../ui/Icon";
import { PageFrame } from "../../ui/PageFrame";
import { PageHeader } from "../../ui/PageHeader";
import type { RelationshipsFacade } from "../relationships/api";
import { DeploymentBarChart, DeploymentDetailList } from "./DeploymentBarChart";
import { PendingSummary } from "./PendingSummary";
import {
  RelationshipThumbnailNetwork,
  useOverviewRelationshipSummaries,
} from "./RelationshipThumbnail";
import { TagDistributionChart } from "./TagDistributionChart";
import {
  getDeploymentItems,
  getOverviewSummaryMetrics,
  getTagItems,
  type OverviewDimension,
  type OverviewMetric,
} from "./api";
import "./overview.css";

/**
 * 紧凑统计的装饰图标映射。`getOverviewSummaryMetrics` 的口径顺序冻结于
 * api.test.ts：合并 Agent、管理项目、部署关系、待确认冲突；图标按同一次序
 * 注册，纯装饰。
 */
const compactStatIcons: IconName[] = ["agents", "projects", "deploy", "warning"];

export interface OverviewPageProps {
  /**
   * 测试与预览桩的接缝：缺省使用原生只读关系门面。概览是纯浏览查询，
   * 不经 runTrackedOperation（无写入、无顶栏任务）。
   */
  relationshipsFacade?: RelationshipsFacade;
}

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
function CompactStatBody({
  icon,
  metric,
  placeholder = false,
}: {
  icon: IconName;
  metric: OverviewMetric;
  /** 计数来源（关系投影）未就绪时以占位符呈现，不显示假 0。 */
  placeholder?: boolean;
}) {
  return (
    <>
      <span className="sh-overview__stat-figure">
        <Icon aria-hidden="true" name={icon} size={16} />
        <strong>{placeholder ? "–" : metric.count}</strong>
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

  if (items.length === 0) {
    // DEV-7（用户裁定）：零标签渲染空态面板——饼图占位 + 暂无标签文案，
    // 待处理摘要的位置因此保持稳定，不再随标签数量出现/消失。
    return (
      <section aria-label={heading} className="sh-overview__tag-panel">
        <div className="sh-overview__details-head">
          <h2>{heading}</h2>
          <span>{t("overview.tags.detailCount", { count: 0 })}</span>
        </div>
        <div className="sh-overview__tag-layout sh-overview__tag-layout--empty">
          <div className="sh-overview__tag-placeholder" aria-hidden="true" />
          <div className="sh-overview__tag-empty">
            <p className="sh-overview__tag-empty-title">{t("overview.tags.emptyTitle")}</p>
            <p className="sh-overview__tag-empty-hint">{t("overview.tags.emptyHint")}</p>
          </div>
        </div>
      </section>
    );
  }

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

export function OverviewPage({ relationshipsFacade }: OverviewPageProps) {
  const { snapshot } = useOutletContext<BootstrapOutletContext>();
  const { t } = useTranslation();
  const [dimension, setDimension] = useState<OverviewDimension>("agent");
  const { conflictsQuery } = useOverviewRelationshipSummaries(relationshipsFacade);
  // 五个冻结指标（api.test.ts 锁定名称与口径）。前四项来自 bootstrap 快照
  // 同步可得；冲突项计数来自任务 2 工作台投影（异步）——未就绪时以占位符
  // 呈现且不提供携带假计数的钻取链接，绝不把 0 当作"查询还没回来"。
  const summaryMetrics = getOverviewSummaryMetrics(snapshot, conflictsQuery.data ?? null, t);
  const conflictMetric = summaryMetrics[summaryMetrics.length - 1];
  const heroMetric =
    summaryMetrics.find((metric) => metric.tone === "accent") ?? summaryMetrics[0];
  const compactMetrics = summaryMetrics.filter((metric) => metric !== heroMetric);
  const deploymentItems = getDeploymentItems(snapshot, dimension, t);
  const tagItems = getTagItems(snapshot, t);

  return (
    <PageFrame fill width="wide">
      <PageHeader
        description={t("overview.page.description")}
        headingLevel="h1"
        title={t("navigation.overview")}
      />
      <section className="sh-overview">
        <section className="sh-overview__metrics">
          <OverviewHeroMetric metric={heroMetric} />
          <ul
            aria-label={t("overview.metrics.compactLabel")}
            className="sh-overview__stats"
          >
            {compactMetrics.map((metric, index) => {
              const placeholder = metric === conflictMetric && !conflictsQuery.isSuccess;
              const body = (
                <CompactStatBody
                  icon={compactStatIcons[index] ?? "info"}
                  metric={metric}
                  placeholder={placeholder}
                />
              );
              const target = placeholder ? undefined : metric.href;
              return (
                <li key={metric.name}>
                  {target ? (
                    <Link className="sh-overview__stat" to={target}>
                      {body}
                    </Link>
                  ) : (
                    <p className="sh-overview__stat">{body}</p>
                  )}
                </li>
              );
            })}
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
            <TagDistributionPanel items={tagItems} />
            <PendingSummary snapshot={snapshot} />
          </div>
        </section>

        <RelationshipThumbnailNetwork facade={relationshipsFacade} />
      </section>
    </PageFrame>
  );
}
