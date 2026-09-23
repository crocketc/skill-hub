import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, Outlet, useLocation, useNavigate } from "react-router-dom";
import {
  isLibraryViewModeRoute,
  LibraryViewModeProvider,
  LibraryViewModeSwitch,
} from "../features/skills/libraryViewContext";
import {
  applyWindowChromePlatformClass,
  observeWindowMaximizedClass,
} from "../platform/windowChrome";
import { BrandLogo } from "../ui/BrandLogo";
import { IconButton } from "../ui/IconButton";
import { WindowControls } from "../ui/WindowControls";
import {
  AppNotificationsProvider,
  NotificationBell,
  useAppNotifications,
} from "../ui/notifications";
import { BackgroundScanNotifier } from "../features/bootstrap/BackgroundScanNotifier";
import { Sidebar } from "./Sidebar";
import { TaskStatusIndicator } from "./TaskStatusIndicator";
import type { BootstrapVerificationState } from "../features/bootstrap/api";
import type { BootstrapSnapshot } from "../api/bindings";

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
  | "navigation.settings"
  // 任务 5：技能关系模块标题键落在 relationships.* 命名空间（冻结词汇边界）。
  | "relationships.nav";

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
  if (pathname.startsWith("/relationships")) {
    return "relationships.nav";
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
  if (pathname.startsWith("/discovery/")) {
    return "/discovery";
  }
  // 任务 5：关系子页（冲突处理/关系治理）回退到模块主页。
  if (pathname.startsWith("/relationships/")) {
    return "/relationships";
  }
  if (pathname === "/library/combinations") {
    return "/library";
  }
  return null;
}

/** 只有技能详情及其操作子页使用沉浸式布局；其它 library 子页仍保留壳层。 */
export function isSkillDetailRoute(pathname: string): boolean {
  return (
    (pathname !== "/library/combinations" &&
      /^\/library\/[^/]+(?:\/(?:deploy|security))?$/.test(pathname)) ||
    pathname.startsWith("/__preview/skill-detail/")
  );
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

  // 自绘窗口控制的平台适配只在挂载时做一次（macOS 红绿灯避让类标记）。
  useEffect(() => {
    applyWindowChromePlatformClass();
  }, []);

  // 原生最大化状态决定概览是否进入“无滚动、填满页面”的布局；普通窗口
  // 保持自然文档流，允许页面滚动。异步订阅必须在卸载后自行释放。
  useEffect(() => {
    let disposed = false;
    let stopObserving: (() => void) | undefined;

    void observeWindowMaximizedClass()
      .then((stop) => {
        if (disposed) {
          stop();
        } else {
          stopObserving = stop;
        }
      })
      .catch(() => {
        // 原生桥接不可用时已由适配层回落为普通窗口布局；不影响应用挂载。
      });

    return () => {
      disposed = true;
      stopObserving?.();
    };
  }, []);

  const title = t(resolveRouteTitleKey(pathname));
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
    <LibraryViewModeProvider>
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
          <section className="sh-app-shell__workspace">
            {/* 内容区顶栏：所有分区承担拖拽区域，按钮控件除外。 */}
            <header className="sh-app-shell__topbar" data-tauri-drag-region>
              <div className="sh-app-shell__topbar-start" data-tauri-drag-region>
                {sidebarCollapsed ? (
                  <Link
                    aria-label="SkillHub"
                    className="sh-app-shell__compact-brand"
                    data-tauri-drag-region
                    to="/"
                  >
                    <BrandLogo />
                  </Link>
                ) : null}
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
                {/* 回归修复（基线 E2E §5.4）：顶栏标题自 2026-09-17 起降级为
                    非 heading，route-level h1 由页面内容自持，保证“每路由唯一
                    h1”（T3-C 契约）；样式类保持原 h1 的视觉规格。 */}
                <p className="sh-app-shell__title" data-tauri-drag-region>{title}</p>
              </div>
              <div className="sh-app-shell__topbar-context" data-tauri-drag-region>
                {/* DEV-6：中间区完整让给在途任务摘要（任务 5 的 360px 摘要口径）；
                    库路由视图切换器归位到右侧通知铃铛旁（用户裁定位置）。 */}
                <TaskStatusIndicator />
              </div>
              <div className="sh-app-shell__topbar-end" data-tauri-drag-region>
                {verification.kind === "verifying" ? (
                  <span className="sh-app-shell__verification" role="status">
                    {t("appShell.verification")}
                  </span>
                ) : null}
                {isLibraryViewModeRoute(pathname) ? <LibraryViewModeSwitch /> : null}
                <NotificationBell />
                <WindowControls />
              </div>
            </header>
            <main className="sh-app-shell__content" id="main-content" tabIndex={-1}>
              <Outlet context={{ refreshSnapshot, snapshot } satisfies BootstrapOutletContext} />
            </main>
          </section>
        </div>
      </AppNotificationsProvider>
    </LibraryViewModeProvider>
  );
}
