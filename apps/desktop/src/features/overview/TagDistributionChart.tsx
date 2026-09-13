import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useState,
  type ComponentType,
} from "react";
import { useNavigate } from "react-router-dom";
import type { OverviewDeploymentItem } from "./api";
import {
  readDeploymentBarChartPalette,
  type DeploymentBarChartPalette,
} from "./DeploymentBarChart";
import { useTheme } from "../../styles/ThemeProvider";

export interface TagDistributionChartRuntimeProps {
  animation: boolean;
  ariaLabel: string;
  items: OverviewDeploymentItem[];
  onSelect: (target: string) => void;
  palette: DeploymentBarChartPalette;
}

type RuntimeLoader = () => Promise<{
  default: ComponentType<TagDistributionChartRuntimeProps>;
}>;

interface TagDistributionChartProps {
  ariaLabel: string;
  items: OverviewDeploymentItem[];
  palette?: DeploymentBarChartPalette;
  runtimeLoader?: RuntimeLoader;
}

const defaultRuntimeLoader: RuntimeLoader = async () =>
  import("./TagDistributionChartRuntime");

export function TagDistributionChart({
  ariaLabel,
  items,
  palette,
  runtimeLoader = defaultRuntimeLoader,
}: TagDistributionChartProps) {
  const navigate = useNavigate();
  const { resolvedTheme } = useTheme();
  const [resolvedPalette, setResolvedPalette] = useState<DeploymentBarChartPalette>(
    () => palette ?? readDeploymentBarChartPalette(),
  );
  const RuntimeChart = useMemo(() => lazy(runtimeLoader), [runtimeLoader]);

  useEffect(() => {
    if (!palette) {
      setResolvedPalette(readDeploymentBarChartPalette());
    }
  }, [palette, resolvedTheme]);

  return (
    <div aria-label={ariaLabel} className="sh-overview__tag-chart" role="img">
      <Suspense fallback={<span className="sh-overview__chart-loading">…</span>}>
        <RuntimeChart
          animation={false}
          ariaLabel={ariaLabel}
          items={items}
          onSelect={(target) => navigate(target)}
          palette={palette ?? resolvedPalette}
        />
      </Suspense>
    </div>
  );
}
