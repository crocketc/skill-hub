import type { BootstrapSnapshot } from "../api/bindings";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Outlet, useLocation } from "react-router-dom";
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
  const routePath = pathname.startsWith("/__preview")
    ? pathname.slice("/__preview".length) || "/"
    : pathname;
  if (routePath === "/") {
    return "navigation.overview";
  }
  if (routePath.startsWith("/agents")) {
    return "navigation.agents";
  }
  if (routePath.startsWith("/discovery")) {
    return "navigation.discovery";
  }
  if (
    routePath.startsWith("/library") ||
    pathname === "/__preview/skill-library" ||
    pathname.startsWith("/__preview/skill-detail/")
  ) {
    return "navigation.library";
  }
  if (routePath.startsWith("/operations")) {
    return "navigation.operations";
  }
  if (routePath.startsWith("/recovery")) {
    return "navigation.operations";
  }
  if (routePath.startsWith("/pending")) {
    return "navigation.pending";
  }
  if (routePath.startsWith("/projects")) {
    return "navigation.projects";
  }
  if (routePath.startsWith("/settings")) {
    return "navigation.settings";
  }

  return "navigation.overview";
}

export function AppShell({ snapshot, verification }: AppShellProps) {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const title = t(resolveRouteTitleKey(pathname));
  const isSkillDetailRoute =
    pathname.startsWith("/library/") || pathname.startsWith("/__preview/skill-detail/");

  return (
    <div className={`sh-app-shell${sidebarCollapsed ? " is-sidebar-collapsed" : ""}`}>
      <Sidebar
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed((value) => !value)}
      />
      <section className={`sh-app-shell__workspace${isSkillDetailRoute ? " is-detail-route" : ""}`}>
        {!isSkillDetailRoute ? (
          <header className="sh-app-shell__topbar">
            <h1>{title}</h1>
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
