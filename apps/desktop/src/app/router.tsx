import { QueryClientProvider } from "@tanstack/react-query";
import { MotionConfig } from "motion/react";
import { I18nextProvider } from "react-i18next";
import { createBrowserRouter, RouterProvider, useNavigate, useParams } from "react-router-dom";
import { OnboardingWizard } from "../features/onboarding/OnboardingWizard";
import { AgentDetailPage } from "../features/agents/AgentDetailPage";
import { AgentListPage } from "../features/agents/AgentListPage";
import { ProjectDetailPage } from "../features/projects/ProjectDetailPage";
import { ProjectListPage } from "../features/projects/ProjectListPage";
import { nativeAgentFacade } from "../features/agents/nativeApi";
import { nativeProjectFacade } from "../features/projects/nativeApi";
import { DeploymentDialog } from "../features/deployment/DeploymentDialog";
import { SecurityResults } from "../features/security/SecurityResults";
import { unavailableSecurityFacade } from "../features/security/api";
import { PendingPage } from "../features/pending/PendingPage";
import { nativePendingFacade } from "../features/pending/nativeApi";
import { OperationProgress } from "../features/operations/OperationProgress";
import { unavailableOperationFacade } from "../features/operations/api";
import { RecoveryPage } from "../features/recovery/RecoveryPage";
import { SettingsPage } from "../features/settings/SettingsPage";
import { nativeSettingsFacade } from "../features/settings/nativeApi";
import { DiscoveryPage } from "../features/discovery/DiscoveryPage";
import { OverviewPage } from "../features/overview/OverviewPage";
import { SkillLibraryPage } from "../features/skills/SkillLibraryPage";
import { SkillDetailPage } from "../features/skill-detail/SkillDetailPage";
import { SkillDetailPreview } from "../features/skill-detail/SkillDetailPreview";
import { nativeSkillDetailFacade } from "../features/skill-detail/nativeApi";
import {
  SkillLibraryPreview,
  SkillLibraryPreviewShell,
} from "../features/skills/SkillLibraryPreview";
import { nativeSkillLibraryFacade } from "../features/skills/nativeApi";
import { skillHubI18n } from "../i18n";
import "../features/markdown/markdown.css";
import "../styles/base.css";
import { ThemeProvider } from "../styles/ThemeProvider";
import { DesktopApp } from "./App";
import { queryClient } from "./queryClient";

function OnboardingRoute() {
  const navigate = useNavigate();
  return <OnboardingWizard onComplete={() => navigate("/", { replace: true })} />;
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
  return <DeploymentDialog skillId={skillId ?? "unknown"} versionId="current" />;
}

function SecurityRoute() {
  const { skillId } = useParams();
  return <SecurityResults facade={unavailableSecurityFacade} skillId={skillId ?? "unknown"} versionId="current" />;
}

function OperationRoute() {
  const { operationId } = useParams();
  return <OperationProgress facade={unavailableOperationFacade} operationId={operationId ?? "latest"} />;
}

export const appRouter = createBrowserRouter([
  {
    element: <DesktopApp />,
    path: "/",
    children: [
      { index: true, element: <OverviewPage /> },
      {
        path: "library",
        element: <SkillLibraryPage facade={nativeSkillLibraryFacade} />,
      },
      {
        path: "library/:skillId",
        element: <SkillDetailPage facade={nativeSkillDetailFacade} />,
      },
      { path: "library/:skillId/deploy", element: <DeploymentRoute /> },
      { path: "library/:skillId/security", element: <SecurityRoute /> },
      { path: "discovery", element: <DiscoveryPage /> },
      { path: "agents", element: <AgentListPage facade={nativeAgentFacade} /> },
      { path: "agents/:agentKey", element: <AgentDetailRoute /> },
      { path: "projects", element: <ProjectListPage facade={nativeProjectFacade} /> },
      { path: "projects/:projectKey", element: <ProjectDetailRoute /> },
      { path: "pending", element: <PendingPage facade={nativePendingFacade} /> },
      { path: "operations/:operationId", element: <OperationRoute /> },
      { path: "operations", element: <OperationRoute /> },
      { path: "recovery", element: <RecoveryPage facade={unavailableOperationFacade} /> },
      { path: "settings", element: <SettingsPage facade={nativeSettingsFacade} /> },
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
