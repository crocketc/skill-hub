import { QueryClientProvider } from "@tanstack/react-query";
import { MotionConfig } from "motion/react";
import { I18nextProvider } from "react-i18next";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { skillHubI18n } from "../i18n";
import "../styles/base.css";
import { ThemeProvider } from "../styles/ThemeProvider";
import { DesktopApp } from "./App";
import { queryClient } from "./queryClient";
import { OnboardingWizard } from "../features/onboarding/OnboardingWizard";

export const appRouter = createBrowserRouter([
  {
    element: <DesktopApp />,
    path: "/",
  },
  { element: <DesktopApp />, path: "/library" },
  { element: <DesktopApp />, path: "/discovery" },
  { element: <DesktopApp />, path: "/agents" },
  { element: <DesktopApp />, path: "/projects" },
  { element: <DesktopApp />, path: "/pending" },
  { element: <DesktopApp />, path: "/operations" },
  { element: <DesktopApp />, path: "/settings" },
  { element: <OnboardingWizard />, path: "/initialize" },
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
