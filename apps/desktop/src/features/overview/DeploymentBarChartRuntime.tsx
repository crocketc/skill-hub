import { useEffect, useRef } from "react";
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
import type { DeploymentBarChartRuntimeProps } from "./DeploymentBarChart";

use([AriaComponent, BarChart, GridComponent, SVGRenderer, TooltipComponent]);

type DeploymentChartOption = ComposeOption<
  BarSeriesOption | GridComponentOption | TooltipComponentOption
>;

function buildChartOption({
  animation,
  ariaLabel,
  dimensionLabel,
  items,
  palette,
}: DeploymentBarChartRuntimeProps): DeploymentChartOption {
  return {
    animation,
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
            color: palette.barColor,
          },
          name: item.label,
          target: item.target,
          value: item.count,
        })),
        type: "bar",
      },
    ],
    tooltip: {
      backgroundColor: palette.surfaceColor,
      borderColor: palette.tooltipBorderColor,
      borderWidth: 1,
      formatter: (params) => {
        const item = Array.isArray(params) ? params[0] : params;
        return `${item.name}: ${item.value}`;
      },
      textStyle: {
        color: palette.textColor,
      },
      trigger: "item",
    },
    xAxis: {
      axisLabel: {
        color: palette.axisLabelColor,
        interval: 0,
      },
      axisLine: {
        lineStyle: {
          color: palette.axisLineColor,
        },
      },
      axisTick: {
        show: false,
      },
      data: items.map((item) => item.label),
      type: "category",
    },
    yAxis: {
      axisLabel: {
        color: palette.axisLabelColor,
      },
      min: 0,
      name: dimensionLabel,
      nameTextStyle: {
        color: palette.axisLabelColor,
      },
      splitLine: {
        lineStyle: {
          color: palette.splitLineColor,
        },
      },
      type: "value",
    },
  };
}

function canMountRuntimeChart() {
  return typeof navigator === "undefined" || !/jsdom/i.test(navigator.userAgent);
}

export default function DeploymentBarChartRuntime(
  props: DeploymentBarChartRuntimeProps,
) {
  const chartRef = useRef<HTMLDivElement | null>(null);
  const instanceRef = useRef<EChartsType | null>(null);

  useEffect(() => {
    if (!chartRef.current || !canMountRuntimeChart()) {
      return undefined;
    }

    const chart = init(chartRef.current, undefined, { renderer: "svg" });
    instanceRef.current = chart;
    chart.setOption(buildChartOption(props));
    chart.on("click", (params: ECElementEvent) => {
      const { data } = params;
      if (typeof data === "object" && data !== null && "target" in data) {
        const target = data.target;
        if (typeof target === "string") {
          props.onSelect(target);
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
  }, [props]);

  return <div aria-hidden="true" className="sh-overview__chart-canvas" ref={chartRef} />;
}
