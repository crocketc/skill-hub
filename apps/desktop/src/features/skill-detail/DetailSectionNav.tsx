import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { useLocation } from "react-router-dom";

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

type DetailSection = (typeof DETAIL_SECTIONS)[number];

function sectionFromHash(hash: string): DetailSection | undefined {
  const section = hash.replace(/^#/, "") as DetailSection;
  return DETAIL_SECTIONS.includes(section) ? section : undefined;
}

export function DetailSectionNav() {
  const { t } = useTranslation();
  const location = useLocation();
  const [activeSection, setActiveSection] = useState<DetailSection>(() =>
    sectionFromHash(location.hash) ?? "overview",
  );

  useEffect(() => {
    const section = sectionFromHash(location.hash);
    if (section) setActiveSection(section);
  }, [location.hash]);

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((left, right) => left.boundingClientRect.top - right.boundingClientRect.top);
        const section = visible[0]?.target.id;
        if (section) {
          const next = sectionFromHash(`#${section}`);
          if (next) setActiveSection(next);
        }
      },
      { rootMargin: "-12% 0px -68% 0px", threshold: [0, 1] },
    );

    DETAIL_SECTIONS.forEach((section) => {
      const element = document.getElementById(section);
      if (element) observer.observe(element);
    });

    return () => {
      observer.disconnect();
    };
  }, []);

  return (
    <nav
      aria-label={t("skillDetail.navigation.sectionsLabel")}
      className="sh-skill-detail__section-nav"
    >
      {DETAIL_SECTIONS.map((section) => (
        <a
          aria-current={activeSection === section ? "location" : undefined}
          className={activeSection === section ? "is-active" : undefined}
          href={`#${section}`}
          key={section}
          onClick={() => setActiveSection(section)}
        >
          {t(`skillDetail.navigation.sections.${section}`)}
        </a>
      ))}
    </nav>
  );
}
