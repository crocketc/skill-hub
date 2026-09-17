import { useTranslation } from "react-i18next";
import { Link, useLocation } from "react-router-dom";
import { Icon, type IconName } from "../ui/Icon";
import { BrandLogo } from "../ui/BrandLogo";
import { preloadRoute } from "./router";

interface NavigationItem {
  href: string;
  /**
   * 完整 i18n 键：既有条目沿用 navigation.*；任务 5 起新键只允许落在
   * relationships.* 命名空间（冻结词汇边界），故不再按前缀拼接。
   */
  translationKey:
    | "navigation.overview"
    | "navigation.library"
    | "relationships.nav"
    | "navigation.discovery"
    | "navigation.agents"
    | "navigation.projects"
    | "navigation.pending"
    | "navigation.operations"
    | "navigation.settings";
  icon: IconName;
}

type NavigationIconName = IconName;

const primaryNavigation: NavigationItem[] = [
  { href: "/", translationKey: "navigation.overview", icon: "overview" },
  { href: "/library", translationKey: "navigation.library", icon: "library" },
  { href: "/relationships", translationKey: "relationships.nav", icon: "relationships" },
  { href: "/discovery", translationKey: "navigation.discovery", icon: "discovery" },
  { href: "/agents", translationKey: "navigation.agents", icon: "agents" },
  { href: "/projects", translationKey: "navigation.projects", icon: "projects" },
  { href: "/pending", translationKey: "navigation.pending", icon: "pending" },
];

const pinnedNavigation: NavigationItem[] = [
  { href: "/operations", translationKey: "navigation.operations", icon: "operations" },
  { href: "/settings", translationKey: "navigation.settings", icon: "settings" },
];

export function sidebarNavigationEnd(href: string) {
  return href === "/";
}

function NavigationIcon({ name }: { name: NavigationIconName }) {
  // 导航图标纯装饰：链接可访问名称来自可见文字（或折叠时的 aria-label），
  // 只朗读一次。
  return <Icon className="sh-sidebar__icon" name={name} size={20} />;
}

function NavigationLinks({ items, collapsed }: { items: NavigationItem[]; collapsed: boolean }) {
  const { t } = useTranslation();
  const { pathname } = useLocation();

  return (
    <ul className="sh-sidebar__list">
      {items.map((item) => {
        const isPreviewLibrary =
          item.href === "/library" && pathname.startsWith("/__preview/skill-");
        const isCurrent =
          isPreviewLibrary ||
          (item.href === "/"
            ? pathname === "/"
            : pathname === item.href || pathname.startsWith(`${item.href}/`));
        const label = t(item.translationKey);
        return (
          <li key={item.href}>
            <Link
              aria-label={label}
              aria-current={isCurrent ? "page" : undefined}
              className={isCurrent ? "sh-sidebar__link sh-sidebar__link--active" : "sh-sidebar__link"}
              onFocus={() => preloadRoute(item.href)}
              onMouseEnter={() => preloadRoute(item.href)}
              to={item.href}
              title={collapsed ? label : undefined}
            >
              <NavigationIcon name={item.icon} />
              <span className="sh-sidebar__label">{label}</span>
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

interface SidebarProps {
  /** 折叠状态和按钮动作由壳层持有，头部负责呈现稳定的 Logo/控制布局。 */
  collapsed?: boolean;
  onToggle?: () => void;
}

export function Sidebar({ collapsed = false, onToggle = () => undefined }: SidebarProps) {
  const { t } = useTranslation();

  return (
    <aside
      aria-label={t("appShell.navigation")}
      className={`sh-sidebar${collapsed ? " is-collapsed" : ""}`}
    >
      <div className="sh-sidebar__header" data-tauri-drag-region>
        <button
          aria-expanded={!collapsed}
          aria-label={t(collapsed ? "navigation.expand" : "navigation.collapse")}
          className="sh-icon-button sh-sidebar__toggle"
          onClick={onToggle}
          type="button"
        >
          <Icon
            aria-hidden="true"
            className="sh-sidebar__toggle-icon"
            name="panelLeft"
            size={14}
          />
        </button>
        {!collapsed ? (
          <Link
            aria-label="SkillHub"
            className="sh-sidebar__brand"
            data-tauri-drag-region
            to="/"
          >
            <BrandLogo />
          </Link>
        ) : null}
      </div>
      <div className="sh-sidebar__scroll">
        <nav>
          <NavigationLinks collapsed={collapsed} items={primaryNavigation} />
        </nav>
        <nav className="sh-sidebar__pinned">
          <NavigationLinks collapsed={collapsed} items={pinnedNavigation} />
        </nav>
      </div>
    </aside>
  );
}
