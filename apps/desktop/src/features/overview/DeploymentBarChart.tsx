import {
  Suspense,
  lazy,
  useEffect,
  useMemo,
  useState,
  type ComponentType,
} from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import { useTheme } from "../../styles/ThemeProvider";
import { AgentPresentation } from "../../ui/AgentPresentation";
import type { OverviewDeploymentItem, OverviewDimension } from "./api";

export interface DeploymentBarChartPalette {
  axisLabelColor: string;
  axisLineColor: string;
  barColor: string;
  chartColors: string[];
  splitLineColor: string;
  surfaceColor: string;
  textColor: string;
  tooltipBorderColor: string;
}

interface DeploymentBarChartProps {
  ariaLabel: string;
  dimension: OverviewDimension;
  items: OverviewDeploymentItem[];
  palette?: DeploymentBarChartPalette;
  runtimeLoader?: DeploymentBarChartRuntimeLoader;
}

export interface DeploymentBarChartRuntimeProps {
  animation: boolean;
  ariaLabel: string;
  dimensionLabel: string;
  items: OverviewDeploymentItem[];
  onSelect: (target: string) => void;
  orientation: "horizontal" | "vertical";
  palette: DeploymentBarChartPalette;
}

type DeploymentBarChartRuntimeLoader = () => Promise<{
  default: ComponentType<DeploymentBarChartRuntimeProps>;
}>;

const defaultPalette: DeploymentBarChartPalette = {
  axisLabelColor: "#5f6d63",
  axisLineColor: "rgb(24 43 29 / 10%)",
  barColor: "#3f7259",
  chartColors: ["#3f7259", "#4f7e9e", "#b26a43", "#8069a7", "#4f8a76", "#b18a3e"],
  splitLineColor: "rgb(24 43 29 / 10%)",
  surfaceColor: "#f7f9f5",
  textColor: "#1c251f",
  tooltipBorderColor: "rgb(24 43 29 / 10%)",
};

const defaultRuntimeLoader: DeploymentBarChartRuntimeLoader = async () =>
  import("./DeploymentBarChartRuntime");

const projectChartLimit = 10;
const scrollableDetailThreshold = 6;

function resolvePaletteValue(
  styles: CSSStyleDeclaration,
  token: string,
  fallback: string,
) {
  return styles.getPropertyValue(token).trim() || fallback;
}

export function readDeploymentBarChartPalette(): DeploymentBarChartPalette {
  if (typeof document === "undefined") {
    return defaultPalette;
  }

  const styles = getComputedStyle(document.documentElement);

  return {
    axisLabelColor: resolvePaletteValue(
      styles,
      "--color-text-muted",
      defaultPalette.axisLabelColor,
    ),
    axisLineColor: resolvePaletteValue(
      styles,
      "--color-border",
      defaultPalette.axisLineColor,
    ),
    barColor: resolvePaletteValue(styles, "--color-accent", defaultPalette.barColor),
    chartColors: defaultPalette.chartColors,
    splitLineColor: resolvePaletteValue(
      styles,
      "--color-border",
      defaultPalette.splitLineColor,
    ),
    surfaceColor: resolvePaletteValue(
      styles,
      "--color-surface-raised",
      defaultPalette.surfaceColor,
    ),
    textColor: resolvePaletteValue(styles, "--color-text", defaultPalette.textColor),
    tooltipBorderColor: resolvePaletteValue(
      styles,
      "--color-border",
      defaultPalette.tooltipBorderColor,
    ),
  };
}

export function DeploymentBarChart({
  ariaLabel,
  dimension,
  items,
  palette,
  runtimeLoader = defaultRuntimeLoader,
}: DeploymentBarChartProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { resolvedTheme } = useTheme();
  const [resolvedPalette, setResolvedPalette] = useState<DeploymentBarChartPalette>(
    () => palette ?? readDeploymentBarChartPalette(),
  );
  const RuntimeChart = useMemo(() => lazy(runtimeLoader), [runtimeLoader]);
  const chartItems =
    dimension === "project" ? items.slice(0, projectChartLimit) : items;
  const orientation = dimension === "project" ? "horizontal" : "vertical";
  const isRankedProject = dimension === "project" && items.length > projectChartLimit;

  useEffect(() => {
    if (!palette) {
      setResolvedPalette(readDeploymentBarChartPalette());
    }
  }, [palette, resolvedTheme]);

  return (
    <section
      className={`sh-overview__chart-block${isRankedProject ? " sh-overview__chart-block--ranked" : ""}`}
    >
      {isRankedProject ? (
        <p className="sh-overview__chart-summary">
          {t("overview.chart.projectLimit", {
            shown: projectChartLimit,
            total: items.length,
          })}
        </p>
      ) : null}
      <div aria-label={ariaLabel} className="sh-overview__chart-figure" role="img">
        <Suspense
          fallback={
            <p className="sh-overview__chart-loading">
              {t("overview.chart.loading")}
            </p>
          }
        >
          <RuntimeChart
            animation={false}
            ariaLabel={ariaLabel}
            dimensionLabel={t(`overview.chart.axis.${dimension}`)}
            items={chartItems}
            onSelect={(target) => navigate(target)}
            orientation={orientation}
            palette={palette ?? resolvedPalette}
          />
        </Suspense>
      </div>
    </section>
  );
}

interface DeploymentDetailListProps {
  detailsLabel: string;
  dimension: OverviewDimension;
  items: OverviewDeploymentItem[];
}

export function DeploymentDetailList({
  countLabel,
  detailsLabel,
  dimension,
  items,
}: DeploymentDetailListProps & { countLabel?: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const isScrollable = items.length > scrollableDetailThreshold;

  return (
    <section aria-label={detailsLabel} className="sh-overview__details">
      <div className="sh-overview__details-head">
        <h2>{detailsLabel}</h2>
        <span>
          {countLabel ?? t(`overview.chart.detailCount.${dimension}`, { count: items.length })}
        </span>
      </div>
      <div
        aria-label={isScrollable ? t("overview.chart.scrollableDetails") : undefined}
        className="sh-overview__details-scroll"
        role={isScrollable ? "region" : undefined}
        tabIndex={isScrollable ? 0 : undefined}
      >
        <ol aria-label={detailsLabel} className="sh-overview__chart-list">
          {items.map((item) => (
            <li key={item.key}>
              <button
                aria-label={item.buttonLabel}
                className="sh-overview__chart-link"
                onClick={() => navigate(item.target)}
                type="button"
              >
                {/* 验收反馈（2026-09-25）：Agent 类别用统一 presenter 呈现
                    品牌厂商 logo + 展示类型徽标；项目等仍用纯文本名称。 */}
                {item.presentation ? (
                  <AgentPresentation
                    brand={item.presentation.brand}
                    kinds={item.presentation.kinds}
                  />
                ) : (
                  <span>{item.label}</span>
                )}
                <strong>{` ${item.count}`}</strong>
              </button>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
