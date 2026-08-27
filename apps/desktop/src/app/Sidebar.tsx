import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation } from "react-router-dom";
import { BrandLogo } from "../ui/BrandLogo";

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
  icon: NavigationIconName;
}

type NavigationIconName =
  | "overview"
  | "library"
  | "discovery"
  | "agents"
  | "projects"
  | "pending"
  | "operations"
  | "settings";

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

function NavigationIcon({ name, label }: { name: NavigationIconName; label: string }) {
  const paths: Record<NavigationIconName, string> = {
    overview: "M4 12 12 4l8 8M6 10v9h12v-9M9 19v-5h6v5",
    library: "M5 4.5h6a2 2 0 0 1 2 2v13a2 2 0 0 0-2-2H5zM19 4.5h-6a2 2 0 0 0-2 2v13a2 2 0 0 1 2-2h6z",
    discovery: "m21 21-4.35-4.35M10.8 18a7.2 7.2 0 1 1 0-14.4 7.2 7.2 0 0 1 0 14.4Z",
    agents: "M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm8-1a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM3.5 19a4.5 4.5 0 0 1 9 0M13 18a4 4 0 0 1 7.5 1",
    projects: "M4 7.5h6l1.5 2H20v9H4zM4 7.5V5h6l1.5 2.5",
    pending: "M12 7v5l3 2M20 12a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z",
    operations: "M6 4h12v16H6zM9 8h6M9 12h6M9 16h4",
    settings: "M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7Zm0-5v2M12 18.5v2M3.5 12h2M18.5 12h2M5.9 5.9l1.4 1.4M16.7 16.7l1.4 1.4M18.1 5.9l-1.4 1.4M7.3 16.7l-1.4 1.4",
  };

  return (
    <svg aria-label={`${label} icon`} className="sh-sidebar__icon" fill="none" role="img" viewBox="0 0 24 24">
      <path d={paths[name]} stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8" />
    </svg>
  );
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
              to={item.href}
              title={collapsed ? label : undefined}
            >
              <NavigationIcon label={label} name={item.icon} />
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
        <Link aria-label="SkillHub" className="sh-sidebar__brand" to="/">
          <BrandLogo />
        </Link>
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
      </div>
      <nav>
        <NavigationLinks collapsed={isCollapsed} items={primaryNavigation} />
      </nav>
      <nav className="sh-sidebar__pinned">
        <NavigationLinks collapsed={isCollapsed} items={pinnedNavigation} />
      </nav>
    </aside>
  );
}
