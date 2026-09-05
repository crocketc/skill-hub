import { QueryClientProvider } from "@tanstack/react-query";
import { MotionConfig } from "motion/react";
import { I18nextProvider } from "react-i18next";
import { createBrowserRouter, RouterProvider, useLocation, useNavigate, useParams } from "react-router-dom";
import { OnboardingWizard } from "../features/onboarding/OnboardingWizard";
import { AgentDetailPage } from "../features/agents/AgentDetailPage";
import { AgentListPage } from "../features/agents/AgentListPage";
import { ProjectDetailPage } from "../features/projects/ProjectDetailPage";
import { ProjectListPage } from "../features/projects/ProjectListPage";
import { nativeAgentFacade } from "../features/agents/nativeApi";
import { nativeProjectFacade } from "../features/projects/nativeApi";
import { DeploymentDialog } from "../features/deployment/DeploymentDialog";
import { SecurityResults } from "../features/security/SecurityResults";
import { nativeSecurityFacade } from "../features/security/nativeApi";
import { PendingPage } from "../features/pending/PendingPage";
import { nativePendingFacade } from "../features/pending/nativeApi";
import { OperationProgress } from "../features/operations/OperationProgress";
import { nativeOperationFacade } from "../features/operations/nativeApi";
import { RecoveryPage } from "../features/recovery/RecoveryPage";
import { DataProtectionPage } from "../features/backup/DataProtectionPage";
import { nativeBackupFacade } from "../features/backup/nativeApi";
import { SettingsPage } from "../features/settings/SettingsPage";
import { nativeSettingsFacade } from "../features/settings/nativeApi";
import { DiscoveryPage } from "../features/discovery/DiscoveryPage";
import { OverviewPage } from "../features/overview/OverviewPage";
import { SkillLibraryPage } from "../features/skills/SkillLibraryPage";
import { SkillDetailPage } from "../features/skill-detail/SkillDetailPage";
import { SkillDetailPreview } from "../features/skill-detail/SkillDetailPreview";
import { nativeSkillDetailFacade } from "../features/skill-detail/nativeApi";
import { skillDetailKeys } from "../features/skill-detail/api";
import {
  SkillLibraryPreview,
  SkillLibraryPreviewShell,
} from "../features/skills/SkillLibraryPreview";
import {
  NATIVE_SORTABLE_COLUMNS,
  NATIVE_VERSION_UPGRADE_FILTER_SUPPORTED,
  nativeSkillLibraryFacade,
} from "../features/skills/nativeApi";
import { skillLibraryKeys } from "../features/skills/api";
import { type ImportResult } from "../features/import/api";
import { skillHubI18n } from "../i18n";
import "../features/markdown/markdown.css";
import "../styles/base.css";
import { ThemeProvider, useTheme } from "../styles/ThemeProvider";
import { DesktopApp } from "./App";
import { queryClient } from "./queryClient";

function OnboardingRoute() {
  const navigate = useNavigate();
  const { resolvedTheme, setAppearance } = useTheme();
  return (
    <OnboardingWizard
      onThemeChange={(theme) => {
        setAppearance(theme);
        void nativeSettingsFacade.execute({ type: "set_theme", payload: { theme } });
      }}
      onComplete={() => navigate("/", { replace: true })}
      onOpenImport={(roots) => navigate("/discovery", {
        state: {
          initialSources: roots,
          initialSourceText: roots[0] ?? "",
        },
      })}
      theme={resolvedTheme}
    />
  );
}

function AgentDetailRoute() {
  const { agentKey } = useParams();
  return <AgentDetailPage agentId={agentKey} facade={nativeAgentFacade} />;
}

function ProjectDetailRoute() {
  const { projectKey } = useParams();
  return <ProjectDetailPage facade={nativeProjectFacade} projectId={projectKey} />;
}

function DeploymentRoute() {
  const { skillId } = useParams();
  const effectiveSkillId = skillId ?? "unknown";
  return (
    <DeploymentDialog
      onCommitted={(results) => {
        if (results.some((result) => result.status === "succeeded")) {
          void Promise.all([
            queryClient.invalidateQueries({ queryKey: skillLibraryKeys.root }),
            queryClient.invalidateQueries({ queryKey: skillDetailKeys.relations(effectiveSkillId) }),
            queryClient.invalidateQueries({ queryKey: skillDetailKeys.summary(effectiveSkillId) }),
          ]);
        }
      }}
      skillId={effectiveSkillId}
      versionId="current"
    />
  );
}

function SkillLibraryRoute() {
  const navigate = useNavigate();
  return (
    <SkillLibraryPage
      capabilities={{
        sortableColumns: NATIVE_SORTABLE_COLUMNS,
        versionFilterSupported: NATIVE_VERSION_UPGRADE_FILTER_SUPPORTED,
      }}
      facade={nativeSkillLibraryFacade}
      onOpenDiscovery={() => navigate("/discovery")}
    />
  );
}

function DiscoveryRoute() {
  const navigate = useNavigate();
  const location = useLocation();
  const state = location.state as { initialSources?: string[]; initialSourceText?: string } | null;

  const handleImportComplete = (results: ImportResult[]) => {
    if (results.some((result) => result.status === "succeeded")) {
      void queryClient.invalidateQueries({ queryKey: skillLibraryKeys.root });
    }
  };

  return (
    <DiscoveryPage
      initialSources={state?.initialSources}
      initialSourceText={state?.initialSourceText}
      onImportComplete={handleImportComplete}
      onOpenLibrary={() => navigate("/library")}
    />
  );
}

function SecurityRoute() {
  const { skillId } = useParams();
  return <SecurityResults facade={nativeSecurityFacade} skillId={skillId ?? "unknown"} versionId="current" />;
}

function OperationRoute() {
  const { operationId } = useParams();
  return <OperationProgress facade={nativeOperationFacade} operationId={operationId ?? "latest"} />;
}

export const appRouter = createBrowserRouter([
  {
    element: <DesktopApp />,
    path: "/",
    children: [
      { index: true, element: <OverviewPage /> },
      {
        path: "library",
        element: <SkillLibraryRoute />,
      },
      {
        path: "library/:skillId",
        element: <SkillDetailPage facade={nativeSkillDetailFacade} />,
      },
      { path: "library/:skillId/deploy", element: <DeploymentRoute /> },
      { path: "library/:skillId/security", element: <SecurityRoute /> },
      { path: "discovery", element: <DiscoveryRoute /> },
      { path: "agents", element: <AgentListPage facade={nativeAgentFacade} /> },
      { path: "agents/:agentKey", element: <AgentDetailRoute /> },
      { path: "projects", element: <ProjectListPage facade={nativeProjectFacade} /> },
      { path: "projects/:projectKey", element: <ProjectDetailRoute /> },
      { path: "pending", element: <PendingPage facade={nativePendingFacade} /> },
      { path: "operations/:operationId", element: <OperationRoute /> },
      { path: "operations", element: <OperationRoute /> },
      { path: "recovery", element: <RecoveryPage facade={nativeOperationFacade} /> },
      { path: "settings", element: <SettingsPage facade={nativeSettingsFacade} /> },
      { path: "settings/data-protection", element: <DataProtectionPage facade={nativeBackupFacade} /> },
    ],
  },
  { element: <OnboardingRoute />, path: "/initialize" },
  ...(import.meta.env.DEV
    ? [
        {
          path: "__preview",
          element: <SkillLibraryPreviewShell />,
          children: [
            { path: "skill-library", element: <SkillLibraryPreview /> },
            { path: "skill-detail/:skillId", element: <SkillDetailPreview /> },
          ],
        },
      ]
    : []),
]);

export function AppRouter() {
  return (
    <ThemeProvider>
      <MotionConfig reducedMotion="user">
        <I18nextProvider i18n={skillHubI18n}>
          <QueryClientProvider client={queryClient}>
            <RouterProvider router={appRouter} />
          </QueryClientProvider>
        </I18nextProvider>
      </MotionConfig>
    </ThemeProvider>
  );
}
