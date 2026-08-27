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
import { DiscoveryPage } from "../features/discovery/DiscoveryPage";
import { OverviewPage } from "../features/overview/OverviewPage";
import { SkillLibraryPage } from "../features/skills/SkillLibraryPage";
import { SkillDetailPage } from "../features/skill-detail/SkillDetailPage";
import { SkillDetailPreview } from "../features/skill-detail/SkillDetailPreview";
import { unavailableSkillDetailFacade } from "../features/skill-detail/api";
import {
  SkillLibraryPreview,
  SkillLibraryPreviewShell,
} from "../features/skills/SkillLibraryPreview";
import { unavailableSkillLibraryFacade } from "../features/skills/api";
import { skillHubI18n } from "../i18n";
import "../features/markdown/markdown.css";
import "../styles/base.css";
import { ThemeProvider } from "../styles/ThemeProvider";
import { DesktopApp } from "./App";
import { queryClient } from "./queryClient";
import { RoutePlaceholder } from "./RoutePlaceholder";

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
      { path: "discovery", element: <DiscoveryPage /> },
      { path: "agents", element: <AgentListPage facade={unavailableAgentFacade} /> },
      { path: "agents/:agentKey", element: <AgentDetailRoute /> },
      { path: "projects", element: <ProjectListPage facade={unavailableProjectFacade} /> },
      { path: "projects/:projectKey", element: <ProjectDetailRoute /> },
      { path: "pending", element: <RoutePlaceholder titleKey="navigation.pending" /> },
      { path: "operations", element: <RoutePlaceholder titleKey="navigation.operations" /> },
      { path: "settings", element: <RoutePlaceholder titleKey="navigation.settings" /> },
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
