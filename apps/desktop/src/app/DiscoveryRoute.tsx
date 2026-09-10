import { useLocation, useNavigate, useOutletContext } from "react-router-dom";
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
      onNavigate={(module) => navigate(`/discovery/${module}`)}
      onBack={() => navigate("/discovery")}
    />
  );
}
