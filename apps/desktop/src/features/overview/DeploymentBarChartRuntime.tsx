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
  items,
  orientation,
  palette,
}: Pick<
  DeploymentBarChartRuntimeProps,
  "animation" | "ariaLabel" | "items" | "orientation" | "palette"
>): DeploymentChartOption {
  const isHorizontal = orientation === "horizontal";
  const categoryAxis = {
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
    inverse: isHorizontal,
    type: "category" as const,
  };
  // 数值轴不显示名称：图表的 role="img" aria 标签、明细列表和维度切换
  // 已经承担同样的语义，轴名称在窄容器里会被 SVG 视口裁切。
  const valueAxis = {
    axisLabel: {
      color: palette.axisLabelColor,
    },
    axisLine: {
      lineStyle: {
        color: palette.axisLineColor,
      },
    },
    min: 0,
    splitLine: {
      lineStyle: {
        color: palette.splitLineColor,
      },
    },
    type: "value" as const,
  };

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
        barMaxWidth: isHorizontal ? 28 : 48,
        data: items.map((item) => ({
          itemStyle: {
            borderRadius: isHorizontal ? [0, 8, 8, 0] : [10, 10, 0, 0],
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
    xAxis: isHorizontal ? valueAxis : categoryAxis,
    yAxis: isHorizontal ? categoryAxis : valueAxis,
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
  const latestPropsRef = useRef(props);
  useEffect(() => {
    latestPropsRef.current = props;
  });

  useEffect(() => {
    if (!chartRef.current || !canMountRuntimeChart()) {
      return undefined;
    }

    const chart = init(chartRef.current, undefined, { renderer: "svg" });
    instanceRef.current = chart;
    chart.setOption(buildChartOption(latestPropsRef.current));
    chart.on("click", (params: ECElementEvent) => {
      const { data } = params;
      if (typeof data === "object" && data !== null && "target" in data) {
        const target = data.target;
        if (typeof target === "string") {
          latestPropsRef.current.onSelect(target);
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
  }, []);

  const { animation, ariaLabel, items, orientation, palette } = props;
  useEffect(() => {
    instanceRef.current?.setOption(
      buildChartOption({ animation, ariaLabel, items, orientation, palette }),
    );
  }, [animation, ariaLabel, items, orientation, palette]);

  return (
    <div
      aria-hidden="true"
      className={`sh-overview__chart-canvas sh-overview__chart-canvas--${props.orientation}`}
      ref={chartRef}
    />
  );
}
