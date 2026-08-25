import type { BootstrapSnapshot } from "../api/bindings";
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
  if (pathname === "/") {
    return "navigation.overview";
  }
  if (pathname.startsWith("/agents")) {
    return "navigation.agents";
  }
  if (pathname.startsWith("/discovery")) {
    return "navigation.discovery";
  }
  if (pathname.startsWith("/library")) {
    return "navigation.library";
  }
  if (pathname.startsWith("/operations")) {
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

export function AppShell({ snapshot, verification }: AppShellProps) {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const title = t(resolveRouteTitleKey(pathname));

  return (
    <div className="sh-app-shell">
      <Sidebar />
      <section className="sh-app-shell__workspace">
        <header className="sh-app-shell__topbar">
          <h1>{title}</h1>
          {verification.kind === "verifying" ? (
            <span className="sh-app-shell__verification" role="status">
              {t("appShell.verification")}
            </span>
          ) : null}
        </header>
        <main className="sh-app-shell__content">
          <section aria-label={t("appShell.cachedData")} className="sh-app-shell__summary">
            <p>{t("appShell.cachedData")}</p>
            <strong>{snapshot.skill_count}</strong>
            <span>{t("appShell.skillCount")}</span>
          </section>
          <Outlet context={snapshot} />
        </main>
      </section>
    </div>
  );
}
