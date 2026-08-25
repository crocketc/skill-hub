import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import type { OverviewDeploymentItem, OverviewDimension } from "./api";
import {
  type ECElementEvent,
  init,
  type ComposeOption,
  type EChartsType,
  use,
} from "echarts/core";
import { BarChart, type BarSeriesOption } from "echarts/charts";
import {
  AriaComponent,
  GridComponent,
  TooltipComponent,
  type GridComponentOption,
  type TooltipComponentOption,
} from "echarts/components";
import { SVGRenderer } from "echarts/renderers";

use([AriaComponent, BarChart, GridComponent, SVGRenderer, TooltipComponent]);

type DeploymentChartOption = ComposeOption<
  BarSeriesOption | GridComponentOption | TooltipComponentOption
>;

interface DeploymentBarChartProps {
  ariaLabel: string;
  detailsLabel: string;
  dimension: OverviewDimension;
  items: OverviewDeploymentItem[];
}

function buildChartOption(
  ariaLabel: string,
  dimensionLabel: string,
  items: OverviewDeploymentItem[],
): DeploymentChartOption {
  return {
    animationDuration: 220,
    aria: {
      enabled: true,
      description: ariaLabel,
    },
    grid: {
      bottom: 12,
      containLabel: true,
      left: 12,
      right: 12,
      top: 12,
    },
    series: [
      {
        barMaxWidth: 48,
        data: items.map((item) => ({
          itemStyle: {
            borderRadius: [10, 10, 0, 0],
          },
          name: item.label,
          target: item.target,
          value: item.count,
        })),
        emphasis: {
          focus: "series",
          itemStyle: {
            opacity: 0.92,
          },
        },
        type: "bar",
      },
    ],
    tooltip: {
      formatter: (params) => {
        const item = Array.isArray(params) ? params[0] : params;
        return `${item.name}: ${item.value}`;
      },
      trigger: "item",
    },
    xAxis: {
      axisLabel: {
        interval: 0,
      },
      axisTick: {
        show: false,
      },
      data: items.map((item) => item.label),
      type: "category",
    },
    yAxis: {
      min: 0,
      name: dimensionLabel,
      splitLine: {
        lineStyle: {
          opacity: 0.28,
        },
      },
      type: "value",
    },
  };
}

function canMountRuntimeChart() {
  return typeof navigator === "undefined" || !/jsdom/i.test(navigator.userAgent);
}

export function DeploymentBarChart({
  ariaLabel,
  detailsLabel,
  dimension,
  items,
}: DeploymentBarChartProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const chartRef = useRef<HTMLDivElement | null>(null);
  const instanceRef = useRef<EChartsType | null>(null);

  useEffect(() => {
    if (!chartRef.current || !canMountRuntimeChart()) {
      return undefined;
    }

    const chart = init(chartRef.current, undefined, { renderer: "svg" });
    instanceRef.current = chart;
    chart.setOption(
      buildChartOption(
        ariaLabel,
        t(`overview.chart.axis.${dimension}`),
        items,
      ),
    );
    chart.on("click", (params: ECElementEvent) => {
      const { data } = params;
      if (typeof data === "object" && data !== null && "target" in data) {
        const target = data.target;
        if (typeof target === "string") {
          navigate(target);
        }
      }
    });

    const resize = () => {
      chart.resize();
    };

    window.addEventListener("resize", resize);

    return () => {
      window.removeEventListener("resize", resize);
      chart.dispose();
      instanceRef.current = null;
    };
  }, [ariaLabel, dimension, items, navigate, t]);

  return (
    <section className="sh-overview__chart-block">
      <div aria-label={ariaLabel} className="sh-overview__chart-figure" role="img">
        <div aria-hidden="true" className="sh-overview__chart-canvas" ref={chartRef} />
      </div>
      <ol aria-label={detailsLabel} className="sh-overview__chart-list">
        {items.map((item) => (
          <li key={item.key}>
            <button
              aria-label={item.buttonLabel}
              className="sh-overview__chart-link"
              onClick={() => navigate(item.target)}
              type="button"
            >
              <span>{`${item.label} ${item.count}`}</span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}
