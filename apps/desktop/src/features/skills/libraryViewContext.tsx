import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui/Button";
import { Icon, type IconName } from "../../ui/Icon";
import type { LibraryViewMode } from "./api";

/**
 * D5 第二波：技能库视图模式 state 从 SkillLibraryPage 上提到壳层。
 * Provider 由 AppShell 在最外层挂载；顶栏切换（LibraryViewModeSwitch，
 * 渲染在 topbar-context）与页面渲染分支消费同一份 state，双向同步；
 * 页面负责挂载水合（facade.loadViewMode，仅未水合时一次）与持久化
 * （facade.saveViewMode，语义不变）。
 */

/** 视图切换只在技能库主标签页与其预览路由显示；子路由与详情不显示。 */
export function isLibraryViewModeRoute(pathname: string): boolean {
  return pathname === "/library" || pathname === "/__preview/skill-library";
}

export interface LibraryViewModeContextValue {
  viewMode: LibraryViewMode;
  /** 页面是否已完成一次挂载水合；未水合前页面不得重复触发 loadViewMode。 */
  hydrated: boolean;
  /** 顶栏切换与页面共用唯一变更入口：更新 state，不负责持久化。 */
  changeViewMode: (next: LibraryViewMode) => void;
  /** 页面水合交接：写入持久化读取值并标记已水合（幂等）。 */
  hydrateViewMode: (mode: LibraryViewMode) => void;
}

const LibraryViewModeContext = createContext<LibraryViewModeContextValue | null>(
  null,
);

// P1-08：视图切换的分段控件选项（图标 + 可访问名），自页面随迁移一同上提。
const VIEW_MODE_OPTIONS: ReadonlyArray<{
  icon: IconName;
  labelKey:
    | "skillLibrary.viewMode.table"
    | "skillLibrary.viewMode.cards"
    | "skillLibrary.viewMode.matrix";
  mode: LibraryViewMode;
}> = [
  { icon: "operations", labelKey: "skillLibrary.viewMode.table", mode: "table" },
  { icon: "library", labelKey: "skillLibrary.viewMode.cards", mode: "cards" },
  { icon: "agents", labelKey: "skillLibrary.viewMode.matrix", mode: "matrix" },
];

export function LibraryViewModeProvider({ children }: { children: ReactNode }) {
  const [viewMode, setViewMode] = useState<LibraryViewMode>("cards");
  const [hydrated, setHydrated] = useState(false);

  const changeViewMode = useCallback((next: LibraryViewMode) => {
    setViewMode(next);
  }, []);

  const hydrateViewMode = useCallback((mode: LibraryViewMode) => {
    setViewMode(mode);
    setHydrated(true);
  }, []);

  const value = useMemo(
    () => ({ viewMode, hydrated, changeViewMode, hydrateViewMode }),
    [viewMode, hydrated, changeViewMode, hydrateViewMode],
  );

  return (
    <LibraryViewModeContext.Provider value={value}>
      {children}
    </LibraryViewModeContext.Provider>
  );
}

export function useLibraryViewMode(): LibraryViewModeContextValue {
  const value = useContext(LibraryViewModeContext);
  if (!value) {
    throw new Error(
      "useLibraryViewMode must be used within a LibraryViewModeProvider",
    );
  }
  return value;
}

/** 顶栏（topbar-context）内的三段视图切换；结构与可访问名与迁移前一致。 */
export function LibraryViewModeSwitch() {
  const { t } = useTranslation();
  const { viewMode, changeViewMode } = useLibraryViewMode();

  return (
    <div
      aria-label={t("skillLibrary.viewMode.label")}
      className="sh-skill-library__mode-switch"
      role="group"
    >
      {VIEW_MODE_OPTIONS.map((option) => (
        <Button
          aria-label={t(option.labelKey)}
          aria-pressed={viewMode === option.mode}
          key={option.mode}
          onClick={() => changeViewMode(option.mode)}
          title={t(option.labelKey)}
          variant={viewMode === option.mode ? "secondary" : "ghost"}
        >
          <Icon aria-hidden="true" name={option.icon} size={16} />
        </Button>
      ))}
    </div>
  );
}
