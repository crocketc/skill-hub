import { useTranslation } from "react-i18next";

export const DETAIL_SECTIONS = [
  "overview",
  "description",
  "metadata",
  "relations",
  "requirements",
  "security",
  "connections",
  "external",
  "versions",
] as const;

export function DetailSectionNav() {
  const { t } = useTranslation();
  return (
    <nav
      aria-label={t("skillDetail.navigation.sectionsLabel")}
      className="sh-skill-detail__section-nav"
    >
      {DETAIL_SECTIONS.map((section) => (
        <a href={`#${section}`} key={section}>
          {t(`skillDetail.navigation.sections.${section}`)}
        </a>
      ))}
    </nav>
  );
}
