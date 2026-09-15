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
    | { initialSources?: string[]; initialSourceText?: string; onboardingImport?: boolean }
    | null;

  const handleImportComplete = (results: ImportResult[]) => {
    if (results.some((result) => result.status === "succeeded")) {
      void queryClient.invalidateQueries({ queryKey: skillLibraryKeys.root });
      void refreshSnapshot();
    }
  };

  const handleOpenGovernanceTask = (task: GovernanceTaskFact) => {
    // ImportSummary is reached from the production route with a real handler:
    // refresh the existing relationship overview query before navigating back
    // to the local discovery entry, where governance work is surfaced.
    void queryClient.fetchQuery({
      queryKey: ["relationship-overview", "all"],
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
    });
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
      view={view}
      discoveryFacade={discoveryFacade}
      importFacade={importFacade}
      importedNames={loadImportedNames}
      initialSources={state?.initialSources}
      initialSourceText={state?.initialSourceText}
      onboardingImport={state?.onboardingImport}
      onImportComplete={handleImportComplete}
      onOpenLibrary={() => navigate("/library")}
      onOpenGovernanceTask={handleOpenGovernanceTask}
      onNavigate={(module) => navigate(`/discovery/${module}`)}
      onOpenSettings={() => navigate("/settings")}
    />
  );
}
