import { useTranslation } from "react-i18next";
import { NavLink } from "react-router-dom";
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
}

const primaryNavigation: NavigationItem[] = [
  { href: "/", translationKey: "overview" },
  { href: "/library", translationKey: "library" },
  { href: "/discovery", translationKey: "discovery" },
  { href: "/agents", translationKey: "agents" },
  { href: "/projects", translationKey: "projects" },
  { href: "/pending", translationKey: "pending" },
];

const pinnedNavigation: NavigationItem[] = [
  { href: "/operations", translationKey: "operations" },
  { href: "/settings", translationKey: "settings" },
];

export function sidebarNavigationEnd(href: string) {
  return href === "/";
}

function NavigationLinks({ items }: { items: NavigationItem[] }) {
  const { t } = useTranslation();

  return (
    <ul className="sh-sidebar__list">
      {items.map((item) => (
        <li key={item.href}>
          <NavLink
            className={({ isActive }) =>
              isActive ? "sh-sidebar__link sh-sidebar__link--active" : "sh-sidebar__link"
            }
            end={sidebarNavigationEnd(item.href)}
            to={item.href}
          >
            {t(`navigation.${item.translationKey}`)}
          </NavLink>
        </li>
      ))}
    </ul>
  );
}

export function Sidebar() {
  const { t } = useTranslation();

  return (
    <aside aria-label={t("appShell.navigation")} className="sh-sidebar">
      <NavLink aria-label="SkillHub" className="sh-sidebar__brand" to="/">
        <BrandLogo />
      </NavLink>
      <nav>
        <NavigationLinks items={primaryNavigation} />
      </nav>
      <nav className="sh-sidebar__pinned">
        <NavigationLinks items={pinnedNavigation} />
      </nav>
    </aside>
  );
}
