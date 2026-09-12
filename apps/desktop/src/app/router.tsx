import { QueryClientProvider } from "@tanstack/react-query";
import { MotionConfig } from "motion/react";
import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { I18nextProvider, useTranslation } from "react-i18next";
import { createBrowserRouter, RouterProvider, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { OnboardingPreview } from "../features/onboarding/OnboardingPreview";
import { desktopBootstrapRuntime } from "../features/bootstrap/api";
import { AgentsPreview, AgentDetailPreview } from "../features/agents/AgentsPreview";
import { ProjectsPreview } from "../features/projects/ProjectsPreview";
import { nativeAgentFacade } from "../features/agents/nativeApi";
import { nativeProjectFacade } from "../features/projects/nativeApi";
import { nativeRemovalFacade } from "../features/removal/nativeApi";
import { nativeSecurityFacade } from "../features/security/nativeApi";
import { nativePendingFacade } from "../features/pending/nativeApi";
import { nativeOperationFacade } from "../features/operations/nativeApi";
import { nativeBackupFacade } from "../features/backup/nativeApi";
import { nativeSettingsFacade } from "../features/settings/nativeApi";
import { SettingsLlmPreview } from "../features/settings/SettingsLlmPreview";
import { SecurityLlmPreview } from "../features/security/SecurityLlmPreview";
import { ImportWizardPreview } from "../features/import/ImportWizardPreview";
import { DeploymentPreview } from "../features/deployment/DeploymentPreview";
import { RemovalPreview } from "../features/removal/RemovalPreview";
import { OnlineDiscoveryPreview } from "../features/discovery/OnlineDiscoveryPreview";
import { DiscoveryCardsPreview } from "../features/discovery/DiscoveryCardsPreview";
import { UiFoundationsPreview } from "../features/dev-preview/UiFoundationsPreview";
import { MarkdownWorkspacePreview } from "../features/markdown/MarkdownWorkspacePreview";
import { OverviewPreviewShell } from "../features/overview/OverviewPreview";
import { PendingPreview } from "../features/pending/PendingPreview";
import { OperationsPreview, OperationProgressPreview } from "../features/operations/OperationsPreview";
import { RecoveryPreview } from "../features/recovery/RecoveryPreview";
import { DiscoveryRoute } from "./DiscoveryRoute";
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
import { skillHubI18n } from "../i18n";
import "../features/markdown/markdown.css";
import "../styles/base.css";
import "../features/settings/settings.css";
import "../features/discovery/discovery.css";
import "../features/skill-detail/skill-detail.css";
import { ThemeProvider, useTheme } from "../styles/ThemeProvider";
import { DesktopApp } from "./App";
import { queryClient } from "./queryClient";
import { DataState } from "../ui/DataState";

// 路由级代码分割：每个页面按需加载，开发用 __preview 路由保持静态导入。
const OnboardingWizard = lazy(() => import("../features/onboarding/OnboardingWizard").then((m) => ({ default: m.OnboardingWizard })));
const RescanWizard = lazy(() => import("../features/onboarding/RescanWizard").then((m) => ({ default: m.RescanWizard })));
const AgentDetailPage = lazy(() => import("../features/agents/AgentDetailPage").then((m) => ({ default: m.AgentDetailPage })));
const AgentListPage = lazy(() => import("../features/agents/AgentListPage").then((m) => ({ default: m.AgentListPage })));
const ProjectDetailPage = lazy(() => import("../features/projects/ProjectDetailPage").then((m) => ({ default: m.ProjectDetailPage })));
const ProjectListPage = lazy(() => import("../features/projects/ProjectListPage").then((m) => ({ default: m.ProjectListPage })));
const DeploymentDialog = lazy(() => import("../features/deployment/DeploymentDialog").then((m) => ({ default: m.DeploymentDialog })));
const BatchDeploymentPage = lazy(() => import("../features/deployment/BatchDeploymentPage").then((m) => ({ default: m.BatchDeploymentPage })));
const SecurityResults = lazy(() => import("../features/security/SecurityResults").then((m) => ({ default: m.SecurityResults })));
const PendingPage = lazy(() => import("../features/pending/PendingPage").then((m) => ({ default: m.PendingPage })));
const OperationProgress = lazy(() => import("../features/operations/OperationProgress").then((m) => ({ default: m.OperationProgress })));
const OperationsRecordsPage = lazy(() => import("../features/operations/OperationsRecordsPage").then((m) => ({ default: m.OperationsRecordsPage })));
const RecoveryPage = lazy(() => import("../features/recovery/RecoveryPage").then((m) => ({ default: m.RecoveryPage })));
const DataProtectionPage = lazy(() => import("../features/backup/DataProtectionPage").then((m) => ({ default: m.DataProtectionPage })));
const SettingsPage = lazy(() => import("../features/settings/SettingsPage").then((m) => ({ default: m.SettingsPage })));
const OverviewPage = lazy(() => import("../features/overview/OverviewPage").then((m) => ({ default: m.OverviewPage })));
const SkillLibraryPage = lazy(() => import("../features/skills/SkillLibraryPage").then((m) => ({ default: m.SkillLibraryPage })));
const SkillDetailPage = lazy(() => import("../features/skill-detail/SkillDetailPage").then((m) => ({ default: m.SkillDetailPage })));
const CombinationManagerPage = lazy(() => import("../features/skills/CombinationManagerPage").then((m) => ({ default: m.CombinationManagerPage })));

function RouteSuspense({ children }: { children: ReactNode }) {
  const { t } = useTranslation();
  return (
    <Suspense fallback={<DataState message={t("dataState.loading")} state="loading" />}>
      {children}
    </Suspense>
  );
}

// 悬停/聚焦导航时预取对应路由 chunk（bundle-preload），消除首次点击的 Suspense 停顿。
const routePreloaders: Record<string, () => Promise<unknown>> = {
  "/": () => import("../features/overview/OverviewPage"),
  "/agents": () => import("../features/agents/AgentListPage"),
  "/library": () => import("../features/skills/SkillLibraryPage"),
  "/operations": () => import("../features/operations/OperationsRecordsPage"),
  "/pending": () => import("../features/pending/PendingPage"),
  "/projects": () => import("../features/projects/ProjectListPage"),
  "/settings": () => import("../features/settings/SettingsPage"),
};

export function preloadRoute(href: string) {
  void routePreloaders[href]?.();
}

function OnboardingRoute() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { resolvedTheme, setAppearance } = useTheme();
  const [snapshot, setSnapshot] = useState<Awaited<ReturnType<typeof desktopBootstrapRuntime.getBootstrapView>>["snapshot"] | null>(null);
  const [snapshotLoadFailed, setSnapshotLoadFailed] = useState(false);
  useEffect(() => {
    void desktopBootstrapRuntime.getBootstrapView()
      .then((view) => setSnapshot(view.snapshot))
      .catch(() => setSnapshotLoadFailed(true));
  }, []);
  if (!snapshot && !snapshotLoadFailed) {
    return <DataState message={t("dataState.loading")} state="loading" />;
  }
  if (snapshotLoadFailed) {
    return <DataState message={t("onboarding.bootstrapUnavailable")} state="unavailable" />;
  }
  if (snapshot?.initialization_state === "initialized") {
    return (
      <RouteSuspense>
      <RescanWizard
        libraryPath={snapshot.library_path ?? ""}
        onCancel={() => navigate("/settings")}
        onComplete={() => navigate("/", { replace: true })}
        onOpenImport={(roots) => navigate("/discovery/local", { state: { initialSources: roots, initialSourceText: roots.length > 1 ? "" : roots[0] ?? "", onboardingImport: true } })}
      />
      </RouteSuspense>
    );
  }
  return (
    <RouteSuspense>
    <OnboardingWizard
      initialBranch="select"
      onThemeChange={(theme) => {
        setAppearance(theme);
        void nativeSettingsFacade.execute({ type: "set_theme", payload: { theme } });
      }}
      onComplete={() => navigate("/", { replace: true })}
      onOpenImport={(roots) => navigate("/discovery/local", {
        state: {
          initialSources: roots,
          // With multiple scanned sources the checkbox list drives selection;
          // the manual source box stays empty unless the user picks their own.
          initialSourceText: roots.length > 1 ? "" : roots[0] ?? "",
          onboardingImport: true,
        },
      })}
      theme={resolvedTheme}
    />
    </RouteSuspense>
  );
}

function AgentDetailRoute() {
  const { agentKey } = useParams();
  return <RouteSuspense><AgentDetailPage agentId={agentKey} facade={nativeAgentFacade} /></RouteSuspense>;
}

function ProjectDetailRoute() {
  const { projectKey } = useParams();
  return <RouteSuspense><ProjectDetailPage
    facade={nativeProjectFacade}
    managedDeploymentOps={{
      list: () => nativeSkillLibraryFacade.listDeployments!(),
      detach: (deploymentId) => nativeRemovalFacade.detachManagement(deploymentId),
    }}
    projectId={projectKey}
  /></RouteSuspense>;
}

function ProjectListRoute() {
  const navigate = useNavigate();
  return <RouteSuspense><ProjectListPage facade={nativeProjectFacade} onOpenProject={(projectId) => navigate(`/projects/${projectId}`)} /></RouteSuspense>;
}

function DeploymentRoute() {
  const { skillId } = useParams();
  const effectiveSkillId = skillId ?? "unknown";
  return (
    <RouteSuspense>
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
    </RouteSuspense>
  );
}

function BatchDeploymentRoute() {
  const [searchParams] = useSearchParams();
  const skillIds = [...new Set(searchParams.getAll("skill").filter(Boolean))];
  return <RouteSuspense><BatchDeploymentPage
    onCommitted={(results) => {
      if (results.some((result) => result.status === "succeeded")) {
        void queryClient.invalidateQueries({ queryKey: skillLibraryKeys.root });
      }
    }}
    skillIds={skillIds}
  /></RouteSuspense>;
}

function SkillLibraryRoute() {
  const navigate = useNavigate();
  return (
    <RouteSuspense>
    <SkillLibraryPage
      capabilities={{
        sortableColumns: NATIVE_SORTABLE_COLUMNS,
        versionFilterSupported: NATIVE_VERSION_UPGRADE_FILTER_SUPPORTED,
      }}
      facade={nativeSkillLibraryFacade}
      onOpenDiscovery={() => navigate("/discovery")}
    />
    </RouteSuspense>
  );
}

function CombinationManagerRoute() {
  return <RouteSuspense><CombinationManagerPage facade={nativeSkillLibraryFacade} /></RouteSuspense>;
}

function SecurityRoute() {
  const { skillId } = useParams();
  return <RouteSuspense><SecurityResults facade={nativeSecurityFacade} skillId={skillId ?? "unknown"} versionId="current" /></RouteSuspense>;
}

function OperationRoute() {
  const { operationId } = useParams();
  return <RouteSuspense><OperationProgress facade={nativeOperationFacade} operationId={operationId ?? "latest"} /></RouteSuspense>;
}

export const appRouter = createBrowserRouter([
  {
    element: <DesktopApp />,
    path: "/",
    children: [
      { index: true, element: <RouteSuspense><OverviewPage /></RouteSuspense> },
      {
        path: "library",
        element: <SkillLibraryRoute />,
      },
      {
        path: "library/combinations",
        element: <CombinationManagerRoute />,
      },
      {
        path: "library/:skillId",
        element: <RouteSuspense><SkillDetailPage facade={nativeSkillDetailFacade} /></RouteSuspense>,
      },
      { path: "library/:skillId/deploy", element: <DeploymentRoute /> },
      { path: "deploy", element: <BatchDeploymentRoute /> },
      { path: "library/:skillId/security", element: <SecurityRoute /> },
      // AR-012：发现主页 + 每种发现方式的独立子页（本机/在线/仓库/lock）。
      { path: "discovery", element: <DiscoveryRoute /> },
      { path: "discovery/local", element: <DiscoveryRoute view="local" /> },
      { path: "discovery/online", element: <DiscoveryRoute view="online" /> },
      { path: "discovery/repo", element: <DiscoveryRoute view="repo" /> },
      { path: "discovery/lock", element: <DiscoveryRoute view="lock" /> },
      { path: "agents", element: <RouteSuspense><AgentListPage facade={nativeAgentFacade} /></RouteSuspense> },
      { path: "agents/:agentKey", element: <AgentDetailRoute /> },
      { path: "projects", element: <ProjectListRoute /> },
      { path: "projects/:projectKey", element: <ProjectDetailRoute /> },
      { path: "pending", element: <RouteSuspense><PendingPage facade={nativePendingFacade} /></RouteSuspense> },
      { path: "operations/:operationId", element: <OperationRoute /> },
      { path: "operations", element: <RouteSuspense><OperationsRecordsPage /></RouteSuspense> },
      { path: "recovery", element: <RouteSuspense><RecoveryPage facade={nativeOperationFacade} /></RouteSuspense> },
      { path: "settings", element: <RouteSuspense><SettingsPage facade={nativeSettingsFacade} /></RouteSuspense> },
      { path: "settings/data-protection", element: <RouteSuspense><DataProtectionPage facade={nativeBackupFacade} /></RouteSuspense> },
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
            { path: "settings-llm", element: <SettingsLlmPreview /> },
            { path: "security-llm", element: <SecurityLlmPreview /> },
            { path: "discovery-online", element: <OnlineDiscoveryPreview /> },
            { path: "discovery-cards", element: <DiscoveryCardsPreview /> },
            { path: "import-wizard", element: <ImportWizardPreview /> },
            { path: "deployment", element: <DeploymentPreview /> },
            { path: "removal", element: <RemovalPreview /> },
            { path: "ui-foundations", element: <UiFoundationsPreview /> },
            { path: "markdown-workspace", element: <MarkdownWorkspacePreview /> },
            { path: "agents", element: <AgentsPreview /> },
            { path: "agents/detail", element: <AgentDetailPreview /> },
            { path: "projects", element: <ProjectsPreview /> },
            { path: "pending", element: <PendingPreview /> },
            { path: "operations-records", element: <OperationsPreview /> },
            { path: "operation-progress", element: <OperationProgressPreview /> },
            { path: "recovery", element: <RecoveryPreview /> },
          ],
        },
        {
          path: "__preview/overview",
          element: <OverviewPreviewShell />,
          children: [{ index: true, element: <OverviewPage /> }],
        },
        { path: "__preview/onboarding/:scenario", element: <OnboardingPreview /> },
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
