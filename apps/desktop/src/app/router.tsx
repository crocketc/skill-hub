import { QueryClientProvider } from "@tanstack/react-query";
import { MotionConfig } from "motion/react";
import { I18nextProvider } from "react-i18next";
import { createBrowserRouter, RouterProvider, useNavigate, useParams } from "react-router-dom";
import { OnboardingWizard } from "../features/onboarding/OnboardingWizard";
import { AgentDetailPage } from "../features/agents/AgentDetailPage";
import { AgentListPage } from "../features/agents/AgentListPage";
import { ProjectDetailPage } from "../features/projects/ProjectDetailPage";
import { ProjectListPage } from "../features/projects/ProjectListPage";
import { unavailableAgentFacade } from "../features/agents/api";
import { unavailableProjectFacade } from "../features/projects/api";
import { DeploymentDialog } from "../features/deployment/DeploymentDialog";
import { unavailableDeploymentFacade } from "../features/deployment/api";
import { SecurityResults } from "../features/security/SecurityResults";
import { unavailableSecurityFacade } from "../features/security/api";
import { PendingPage } from "../features/pending/PendingPage";
import { unavailablePendingFacade } from "../features/pending/api";
import { OperationProgress } from "../features/operations/OperationProgress";
import { unavailableOperationFacade } from "../features/operations/api";
import { RecoveryPage } from "../features/recovery/RecoveryPage";
import { SettingsPage } from "../features/settings/SettingsPage";
import { unavailableSettingsFacade } from "../features/settings/api";
import { DiscoveryPage } from "../features/discovery/DiscoveryPage";
import { OverviewPage } from "../features/overview/OverviewPage";
import { SkillLibraryPage } from "../features/skills/SkillLibraryPage";
import { SkillDetailPage } from "../features/skill-detail/SkillDetailPage";
import { SkillDetailPreview } from "../features/skill-detail/SkillDetailPreview";
import { unavailableSkillDetailFacade } from "../features/skill-detail/api";
import { SkillLibraryPreview } from "../features/skills/SkillLibraryPreview";
import { unavailableSkillLibraryFacade } from "../features/skills/api";
import { skillHubI18n } from "../i18n";
import "../features/markdown/markdown.css";
import "../styles/base.css";
import { ThemeProvider } from "../styles/ThemeProvider";
import { DesktopApp } from "./App";
import { queryClient } from "./queryClient";
import {
  PreviewAgentDetail,
  PreviewAgentList,
  PreviewDeployment,
  PreviewDiscovery,
  PreviewOperation,
  PreviewOnboarding,
  PreviewPending,
  PreviewProjectDetail,
  PreviewProjectList,
  PreviewRecovery,
  PreviewSecurity,
  PreviewSettings,
  PreviewShell,
} from "./PreviewShell";

function OnboardingRoute() {
  const navigate = useNavigate();
  return <OnboardingWizard onComplete={() => navigate("/", { replace: true })} />;
}

function AgentDetailRoute() {
  const { agentKey } = useParams();
  return <AgentDetailPage agentId={agentKey} facade={unavailableAgentFacade} />;
}

function ProjectDetailRoute() {
  const { projectKey } = useParams();
  return <ProjectDetailPage facade={unavailableProjectFacade} projectId={projectKey} />;
}

function DeploymentRoute() {
  const { skillId } = useParams();
  return <DeploymentDialog facade={unavailableDeploymentFacade} skillId={skillId ?? "unknown"} versionId="current" />;
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
        element: <SkillLibraryPage facade={unavailableSkillLibraryFacade} />,
      },
      {
        path: "library/:skillId",
        element: <SkillDetailPage facade={unavailableSkillDetailFacade} />,
      },
      { path: "library/:skillId/deploy", element: <DeploymentRoute /> },
      { path: "library/:skillId/security", element: <SecurityRoute /> },
      { path: "discovery", element: <DiscoveryPage /> },
      { path: "agents", element: <AgentListPage facade={unavailableAgentFacade} /> },
      { path: "agents/:agentKey", element: <AgentDetailRoute /> },
      { path: "projects", element: <ProjectListPage facade={unavailableProjectFacade} /> },
      { path: "projects/:projectKey", element: <ProjectDetailRoute /> },
      { path: "pending", element: <PendingPage facade={unavailablePendingFacade} /> },
      { path: "operations/:operationId", element: <OperationRoute /> },
      { path: "operations", element: <OperationRoute /> },
      { path: "recovery", element: <RecoveryPage facade={unavailableOperationFacade} /> },
      { path: "settings", element: <SettingsPage facade={unavailableSettingsFacade} /> },
    ],
  },
  { element: <OnboardingRoute />, path: "/initialize" },
  ...(import.meta.env.DEV
    ? [
        { path: "__preview/onboarding", element: <PreviewOnboarding /> },
        {
          path: "__preview",
          element: <PreviewShell />,
          children: [
            { index: true, element: <OverviewPage /> },
            { path: "skill-library", element: <SkillLibraryPreview /> },
            { path: "skill-detail/:skillId", element: <SkillDetailPreview /> },
            { path: "discovery", element: <PreviewDiscovery /> },
            { path: "agents", element: <PreviewAgentList /> },
            { path: "agents/:agentKey", element: <PreviewAgentDetail /> },
            { path: "projects", element: <PreviewProjectList /> },
            { path: "projects/:projectKey", element: <PreviewProjectDetail /> },
            { path: "library/:skillId/deploy", element: <PreviewDeployment /> },
            { path: "library/:skillId/security", element: <PreviewSecurity /> },
            { path: "pending", element: <PreviewPending /> },
            { path: "operations/:operationId", element: <PreviewOperation /> },
            { path: "recovery", element: <PreviewRecovery /> },
            { path: "settings", element: <PreviewSettings /> },
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
