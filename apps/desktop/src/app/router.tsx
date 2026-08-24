import { QueryClientProvider } from "@tanstack/react-query";
import { MotionConfig } from "motion/react";
import { I18nextProvider } from "react-i18next";
import { createBrowserRouter, RouterProvider } from "react-router-dom";
import { resolveLocale, skillHubI18n } from "../i18n";
import "../styles/base.css";
import { ThemeProvider } from "../styles/ThemeProvider";
import { App } from "./App";
import { queryClient } from "./queryClient";

const preferredLanguages =
  typeof navigator === "undefined" ? ["en-US"] : navigator.languages;

export const appRouter = createBrowserRouter([
  {
    element: (
      <App
        bootstrap={{
          locale: resolveLocale(preferredLanguages),
          phase: "loading_local",
        }}
      />
    ),
    path: "/",
  },
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
