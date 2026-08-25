import { useTranslation } from "react-i18next";
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

function NavigationLinks({ items }: { items: NavigationItem[] }) {
  const { t } = useTranslation();

  return (
    <ul className="sh-sidebar__list">
      {items.map((item) => (
        <li key={item.href}>
          <a className="sh-sidebar__link" href={item.href}>
            {t(`navigation.${item.translationKey}`)}
          </a>
        </li>
      ))}
    </ul>
  );
}

export function Sidebar() {
  const { t } = useTranslation();

  return (
    <aside aria-label={t("appShell.navigation")} className="sh-sidebar">
      <a aria-label="SkillHub" className="sh-sidebar__brand" href="/">
        <BrandLogo />
      </a>
      <nav>
        <NavigationLinks items={primaryNavigation} />
      </nav>
      <nav className="sh-sidebar__pinned">
        <NavigationLinks items={pinnedNavigation} />
      </nav>
    </aside>
  );
}
