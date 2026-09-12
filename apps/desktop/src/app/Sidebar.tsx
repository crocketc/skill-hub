import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation } from "react-router-dom";
import { Icon, type IconName } from "../ui/Icon";
import { BrandLogo } from "../ui/BrandLogo";
import { preloadRoute } from "./router";

interface NavigationItem {
  href: string;
  translationKey:
    | "overview"
    | "library"
    | "discovery"
    | "agents"
    | "projects"
    | "pending"
    | "operations"
    | "settings";
  icon: IconName;
}

type NavigationIconName = IconName;

const primaryNavigation: NavigationItem[] = [
  { href: "/", translationKey: "overview", icon: "overview" },
  { href: "/library", translationKey: "library", icon: "library" },
  { href: "/discovery", translationKey: "discovery", icon: "discovery" },
  { href: "/agents", translationKey: "agents", icon: "agents" },
  { href: "/projects", translationKey: "projects", icon: "projects" },
  { href: "/pending", translationKey: "pending", icon: "pending" },
];

const pinnedNavigation: NavigationItem[] = [
  { href: "/operations", translationKey: "operations", icon: "operations" },
  { href: "/settings", translationKey: "settings", icon: "settings" },
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
        const label = t(`navigation.${item.translationKey}`);
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
  collapsed?: boolean;
  onToggle?: () => void;
}

export function Sidebar({ collapsed, onToggle }: SidebarProps) {
  const { t } = useTranslation();
  const [internalCollapsed, setInternalCollapsed] = useState(false);
  const isCollapsed = collapsed ?? internalCollapsed;
  const toggle = onToggle ?? (() => setInternalCollapsed((value) => !value));

  return (
    <aside
      aria-label={t("appShell.navigation")}
      className={`sh-sidebar${isCollapsed ? " is-collapsed" : ""}`}
    >
      <div className="sh-sidebar__header">
        {/* P1-01a：折叠按钮固定在侧栏左上角（头部第一个元素），brand 随后。 */}
        <button
          aria-expanded={!isCollapsed}
          aria-label={t(isCollapsed ? "navigation.expand" : "navigation.collapse")}
          className="sh-sidebar__toggle"
          onClick={toggle}
          type="button"
        >
          <svg aria-hidden="true" className="sh-sidebar__toggle-icon" fill="none" viewBox="0 0 24 24">
            <path
              d={isCollapsed ? "m9 6 6 6-6 6" : "m15 6-6 6 6 6"}
              stroke="currentColor"
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth="2.25"
            />
          </svg>
        </button>
        <Link aria-label="SkillHub" className="sh-sidebar__brand" to="/">
          <BrandLogo />
        </Link>
      </div>
      <div className="sh-sidebar__scroll">
        <nav>
          <NavigationLinks collapsed={isCollapsed} items={primaryNavigation} />
        </nav>
        <nav className="sh-sidebar__pinned">
          <NavigationLinks collapsed={isCollapsed} items={pinnedNavigation} />
        </nav>
      </div>
    </aside>
  );
}
