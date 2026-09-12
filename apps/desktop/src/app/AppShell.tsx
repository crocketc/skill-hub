import type { BootstrapSnapshot } from "../api/bindings";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Outlet, useLocation, useNavigate } from "react-router-dom";
import { IconButton } from "../ui/IconButton";
import {
  AppNotificationsProvider,
  NotificationBell,
  useAppNotifications,
} from "../ui/notifications";
import { BackgroundScanNotifier } from "../features/bootstrap/BackgroundScanNotifier";
import { Sidebar } from "./Sidebar";
import { OperationIndicator } from "./OperationIndicator";
import type { BootstrapVerificationState } from "../features/bootstrap/api";

interface AppShellProps {
  snapshot: BootstrapSnapshot;
  verification: BootstrapVerificationState;
  refreshSnapshot: () => Promise<void>;
}

export interface BootstrapOutletContext {
  snapshot: BootstrapSnapshot;
  refreshSnapshot: () => Promise<void>;
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

/** react-router 写入浏览器历史的位置标记（BrowserRouter 场景）。 */
export interface ShellHistoryPosition {
  /** 当前条目在会话历史中的序号；无标记（如 MemoryRouter、首次加载）为 null。 */
  idx: number | null;
  length: number;
}

export function readHistoryPosition(): ShellHistoryPosition {
  const state = window.history.state as { idx?: number } | null;
  return {
    idx: typeof state?.idx === "number" ? state.idx : null,
    length: window.history.length,
  };
}

export interface ShellHistoryControls {
  /** 仅子路由显示返回按钮；主导航页保持干净的标题行。 */
  showBack: boolean;
  /** 有可前进的历史条目时才启用前进（历史位置未知时保持禁用）。 */
  canGoForward: boolean;
}

export function resolveShellHistoryControls(
  position: ShellHistoryPosition,
  backFallback: string | null,
): ShellHistoryControls {
  return {
    showBack: backFallback !== null,
    canGoForward: position.idx !== null && position.idx < position.length - 1,
  };
}

/** Bridges the handed-off initialization scan into the shell notification service. */
function BackgroundScanBridge() {
  const { notify } = useAppNotifications();
  return <BackgroundScanNotifier notify={notify} />;
}

export function AppShell({ refreshSnapshot, snapshot, verification }: AppShellProps) {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const title = t(resolveRouteTitleKey(pathname));
  const isSkillDetailRoute =
    pathname.startsWith("/library/") || pathname.startsWith("/__preview/skill-detail/");
  const backFallback = resolveSubRouteFallback(pathname);
  const historyControls = resolveShellHistoryControls(
    readHistoryPosition(),
    backFallback,
  );

  const goBack = () => {
    // 历史优先：有真实的前一条目就回退，否则落到父导航页。
    const { idx } = readHistoryPosition();
    if (idx !== null && idx > 0) {
      navigate(-1);
    } else if (backFallback) {
      navigate(backFallback);
    }
  };

  return (
    <AppNotificationsProvider>
      <BackgroundScanBridge />
      <div className={`sh-app-shell${sidebarCollapsed ? " is-sidebar-collapsed" : ""}`}>
        <a className="sh-skip-link" href="#main-content">
          {t("appShell.skipToContent")}
        </a>
        <Sidebar
          collapsed={sidebarCollapsed}
          onToggle={() => setSidebarCollapsed((value) => !value)}
        />
        <section className={`sh-app-shell__workspace${isSkillDetailRoute ? " is-detail-route" : ""}`}>
          {!isSkillDetailRoute ? (
            <header className="sh-app-shell__topbar">
              <div className="sh-app-shell__topbar-start">
                {historyControls.showBack ? (
                  <IconButton
                    icon="arrowLeft"
                    label={t("appShell.back")}
                    onClick={goBack}
                  />
                ) : null}
                <IconButton
                  icon="arrowRight"
                  label={t("appShell.forward")}
                  disabled={!historyControls.canGoForward}
                  onClick={() => navigate(1)}
                />
                <h1>{title}</h1>
              </div>
              <div className="sh-app-shell__topbar-end">
                {verification.kind === "verifying" ? (
                  <span className="sh-app-shell__verification" role="status">
                    {t("appShell.verification")}
                  </span>
                ) : null}
                <NotificationBell />
              </div>
            </header>
          ) : null}
          <main className="sh-app-shell__content" id="main-content" tabIndex={-1}>
            <Outlet context={{ refreshSnapshot, snapshot } satisfies BootstrapOutletContext} />
          </main>
          <OperationIndicator />
        </section>
      </div>
    </AppNotificationsProvider>
  );
}
