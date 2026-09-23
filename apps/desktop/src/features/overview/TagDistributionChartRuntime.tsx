import { useEffect, useRef } from "react";
import {
  type ECElementEvent,
  init,
  type ComposeOption,
  type EChartsType,
  use,
} from "echarts/core";
import { PieChart, type PieSeriesOption } from "echarts/charts";
import {
  AriaComponent,
  TooltipComponent,
  type TooltipComponentOption,
} from "echarts/components";
import { SVGRenderer } from "echarts/renderers";
import type { TagDistributionChartRuntimeProps } from "./TagDistributionChart";
import { observeChartContainerResize } from "./chartContainerResize";

use([AriaComponent, PieChart, SVGRenderer, TooltipComponent]);

type TagChartOption = ComposeOption<PieSeriesOption | TooltipComponentOption>;

function buildChartOption({
  animation,
  ariaLabel,
  items,
  palette,
}: Pick<
  TagDistributionChartRuntimeProps,
  "animation" | "ariaLabel" | "items" | "palette"
>): TagChartOption {
  return {
    animation,
    aria: { enabled: true, description: ariaLabel },
    series: [
      {
        data: items.map((item, index) => ({
          name: item.label,
          target: item.target,
          value: item.count,
          itemStyle: { color: palette.chartColors[index % palette.chartColors.length] },
        })),
        itemStyle: { borderColor: palette.surfaceColor, borderWidth: 2 },
        label: { color: palette.textColor, formatter: "{b}" },
        radius: ["42%", "72%"],
        type: "pie",
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
      textStyle: { color: palette.textColor },
      trigger: "item",
    },
  };
}

function canMountRuntimeChart() {
  return typeof navigator === "undefined" || !/jsdom/i.test(navigator.userAgent);
}

export default function TagDistributionChartRuntime(
  props: TagDistributionChartRuntimeProps,
) {
  const chartRef = useRef<HTMLDivElement | null>(null);
  const instanceRef = useRef<EChartsType | null>(null);
  const latestPropsRef = useRef(props);
  useEffect(() => {
    latestPropsRef.current = props;
  });

  useEffect(() => {
    if (!chartRef.current || !canMountRuntimeChart()) return undefined;

    const chart = init(chartRef.current, undefined, { renderer: "svg" });
    instanceRef.current = chart;
    chart.setOption(buildChartOption(latestPropsRef.current));
    chart.on("click", (params: ECElementEvent) => {
      const { data } = params;
      if (typeof data === "object" && data !== null && "target" in data) {
        const target = data.target;
        if (typeof target === "string") latestPropsRef.current.onSelect(target);
      }
    });

    const stopObservingResize = observeChartContainerResize(
      chartRef.current,
      () => chart.resize(),
    );
    return () => {
      stopObservingResize();
      chart.dispose();
      instanceRef.current = null;
    };
  }, []);

  const { animation, ariaLabel, items, palette } = props;
  useEffect(() => {
    instanceRef.current?.setOption(buildChartOption({ animation, ariaLabel, items, palette }));
  }, [animation, ariaLabel, items, palette]);

  return <div aria-hidden="true" className="sh-overview__tag-chart-canvas" ref={chartRef} />;
}
