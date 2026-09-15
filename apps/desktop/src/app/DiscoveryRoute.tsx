import { useEffect, useState } from "react";
import { useLocation, useNavigate, useOutletContext } from "react-router-dom";
import { queryApplication, type GovernanceTaskFact } from "../api/bindings";
import { DiscoveryPage, type DiscoveryModuleView } from "../features/discovery/DiscoveryPage";
import { desktopDiscoveryFacade } from "../features/discovery/api";
import { type ImportFacade, type ImportResult } from "../features/import/api";
import { nativeImportFacade } from "../features/import/nativeApi";
import { DEFAULT_SKILL_QUERY, skillLibraryKeys } from "../features/skills/api";
import { nativeSkillLibraryFacade } from "../features/skills/nativeApi";
import type { BootstrapOutletContext } from "./AppShell";
import { queryClient } from "./queryClient";

const relationshipOverviewQueryKey = ["relationship-overview", "all"] as const;

interface DiscoveryRouteProps {
  view?: DiscoveryModuleView;
  discoveryFacade?: typeof desktopDiscoveryFacade;
  importFacade?: ImportFacade;
}

export function DiscoveryRoute({
  view,
  discoveryFacade = desktopDiscoveryFacade,
  importFacade = nativeImportFacade,
}: DiscoveryRouteProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const { refreshSnapshot } = useOutletContext<BootstrapOutletContext>();
  const state = location.state as
    | { initialSources?: string[]; initialSourceText?: string; onboardingImport?: boolean; governanceTaskId?: string }
    | null;
  const governanceTaskId = state?.governanceTaskId;
  const [governanceTasks, setGovernanceTasks] = useState<GovernanceTaskFact[]>([]);
  const [governanceTasksLoading, setGovernanceTasksLoading] = useState(false);

  useEffect(() => {
    if (!governanceTaskId) {
      setGovernanceTasks([]);
      setGovernanceTasksLoading(false);
      return;
    }
    let active = true;
    setGovernanceTasksLoading(true);
    void queryClient.fetchQuery({
      queryKey: relationshipOverviewQueryKey,
      // 定向待办导航必须拿到提交后真实落库的事实，不能沿用全局 30 秒 staleTime。
      staleTime: 0,
      queryFn: async () => {
        const result = await queryApplication({
          type: "get_relationship_overview",
          payload: { scope: { type: "all" } },
        });
        if (result.type !== "relationship_overview") {
          throw new Error("relationship overview query returned an unexpected result");
        }
        return result.payload;
      },
    }).then((overview) => {
      if (active) setGovernanceTasks(overview.pending_governance_tasks);
    }).catch(() => {
      if (active) setGovernanceTasks([]);
    }).finally(() => {
      if (active) setGovernanceTasksLoading(false);
    });
    return () => {
      active = false;
    };
  }, [governanceTaskId]);

  const handleImportComplete = (results: ImportResult[]) => {
    const hasImportedData = results.some(
      (result) => result.status === "succeeded" || result.status === "todo",
    );
    if (hasImportedData) {
      void queryClient.invalidateQueries({ queryKey: skillLibraryKeys.root });
      void queryClient.invalidateQueries({ queryKey: relationshipOverviewQueryKey });
      void refreshSnapshot();
    }
  };

  const handleOpenGovernanceTask = (task: GovernanceTaskFact) => {
    // 目标页会消费该稳定 task_id，查询真实关系概览并展开对应待办。
    navigate("/discovery/local", { state: { governanceTaskId: task.task_id } });
  };

  // C2 收口：复用既有 listSkills 查询提供库内显示名，驱动在线结果"已在库"标记。
  const loadImportedNames = async () => {
    const page = await nativeSkillLibraryFacade.listSkills({
      ...DEFAULT_SKILL_QUERY,
      page: 1,
      pageSize: 100,
    });
    return page.items.map((item) => item.name);
  };

  return (
    <DiscoveryPage
      key={governanceTaskId ?? "discovery"}
      view={view}
      discoveryFacade={discoveryFacade}
      importFacade={importFacade}
      importedNames={loadImportedNames}
      initialSources={state?.initialSources}
      initialSourceText={state?.initialSourceText}
      onboardingImport={state?.onboardingImport}
      onImportComplete={handleImportComplete}
      governanceTaskId={governanceTaskId}
      governanceTasks={governanceTasks}
      governanceTasksLoading={governanceTasksLoading}
      onOpenLibrary={() => navigate("/library")}
      onOpenGovernanceTask={handleOpenGovernanceTask}
      onNavigate={(module) => navigate(`/discovery/${module}`)}
      onOpenSettings={() => navigate("/settings")}
    />
  );
}
