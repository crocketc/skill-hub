import { QueryClientProvider } from "@tanstack/react-query";
import { MotionConfig } from "motion/react";
import { I18nextProvider } from "react-i18next";
import { createBrowserRouter, RouterProvider, useNavigate } from "react-router-dom";
import { OnboardingWizard } from "../features/onboarding/OnboardingWizard";
import { skillHubI18n } from "../i18n";
import "../styles/base.css";
import { ThemeProvider } from "../styles/ThemeProvider";
import { DesktopApp } from "./App";
import { queryClient } from "./queryClient";
import { RoutePlaceholder } from "./RoutePlaceholder";

function OnboardingRoute() {
  const navigate = useNavigate();
  return <OnboardingWizard onComplete={() => navigate("/", { replace: true })} />;
}

export const appRouter = createBrowserRouter([
  {
    element: <DesktopApp />,
    path: "/",
    children: [
      { index: true, element: <RoutePlaceholder titleKey="navigation.overview" /> },
      { path: "library", element: <RoutePlaceholder titleKey="navigation.library" /> },
      { path: "discovery", element: <RoutePlaceholder titleKey="navigation.discovery" /> },
      { path: "agents", element: <RoutePlaceholder titleKey="navigation.agents" /> },
      { path: "projects", element: <RoutePlaceholder titleKey="navigation.projects" /> },
      { path: "pending", element: <RoutePlaceholder titleKey="navigation.pending" /> },
      { path: "operations", element: <RoutePlaceholder titleKey="navigation.operations" /> },
      { path: "settings", element: <RoutePlaceholder titleKey="navigation.settings" /> },
    ],
  },
  { element: <OnboardingRoute />, path: "/initialize" },
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
