import type { BootstrapSnapshot } from "../api/bindings";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { Button } from "../ui/Button";
import { Sidebar } from "./Sidebar";
import type { BootstrapVerificationState } from "../features/bootstrap/api";

interface AppShellProps {
  snapshot: BootstrapSnapshot;
  verification: BootstrapVerificationState;
}

export type RouteTitleKey =
  | "navigation.overview"
  | "navigation.agents"
  | "navigation.discovery"
  | "navigation.library"
  | "navigation.operations"
  | "navigation.pending"
  | "navigation.projects"
  | "navigation.settings";

export function resolveRouteTitleKey(pathname: string): RouteTitleKey {
  if (pathname === "/") {
    return "navigation.overview";
  }
  if (pathname.startsWith("/agents")) {
    return "navigation.agents";
  }
  if (pathname.startsWith("/discovery")) {
    return "navigation.discovery";
  }
  if (
    pathname.startsWith("/library") ||
    pathname === "/__preview/skill-library" ||
    pathname.startsWith("/__preview/skill-detail/")
  ) {
    return "navigation.library";
  }
  if (pathname.startsWith("/operations")) {
    return "navigation.operations";
  }
  if (pathname.startsWith("/recovery")) {
    return "navigation.operations";
  }
  if (pathname.startsWith("/pending")) {
    return "navigation.pending";
  }
  if (pathname.startsWith("/projects")) {
    return "navigation.projects";
  }
  if (pathname.startsWith("/settings")) {
    return "navigation.settings";
  }

  return "navigation.overview";
}

/**
 * Returns the parent tab for sub-routes reached from a main navigation tab,
 * or null when the route already is a main tab (no back affordance needed).
 */
export function resolveSubRouteFallback(pathname: string): string | null {
  if (pathname.startsWith("/library/") && pathname.endsWith("/deploy")) {
    return "/library";
  }
  if (pathname.startsWith("/library/") && pathname.endsWith("/security")) {
    return "/library";
  }
  if (pathname === "/deploy") {
    return "/library";
  }
  if (pathname.startsWith("/agents/")) {
    return "/agents";
  }
  if (pathname.startsWith("/projects/")) {
    return "/projects";
  }
  if (pathname.startsWith("/operations/")) {
    return "/operations";
  }
  if (pathname === "/settings/data-protection") {
    return "/settings";
  }
  return null;
}

export function AppShell({ snapshot, verification }: AppShellProps) {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const title = t(resolveRouteTitleKey(pathname));
  const isSkillDetailRoute =
    pathname.startsWith("/library/") || pathname.startsWith("/__preview/skill-detail/");
  const backFallback = resolveSubRouteFallback(pathname);

  const goBack = () => {
    const historyState = window.history.state as { idx?: number } | null;
    if (typeof historyState?.idx === "number" && historyState.idx > 0) {
      navigate(-1);
    } else if (backFallback) {
      navigate(backFallback);
    }
  };

  return (
    <div className={`sh-app-shell${sidebarCollapsed ? " is-sidebar-collapsed" : ""}`}>
      <Sidebar
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed((value) => !value)}
      />
      <section className={`sh-app-shell__workspace${isSkillDetailRoute ? " is-detail-route" : ""}`}>
        {!isSkillDetailRoute ? (
          <header className="sh-app-shell__topbar">
            <div className="sh-app-shell__topbar-start">
              {backFallback ? (
                <Button onClick={goBack} variant="ghost">
                  {t("appShell.back")}
                </Button>
              ) : null}
              <h1>{title}</h1>
            </div>
            {verification.kind === "verifying" ? (
              <span className="sh-app-shell__verification" role="status">
                {t("appShell.verification")}
              </span>
            ) : null}
          </header>
        ) : null}
        <main className="sh-app-shell__content">
          <Outlet context={snapshot} />
        </main>
      </section>
    </div>
  );
}
