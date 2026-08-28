import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation } from "react-router-dom";
import type { AdjacentSkillContext } from "./api";

export const DETAIL_SECTIONS = [
  "overview",
  "metadata",
  "description",
  "relations",
  "requirements",
  "security",
  "connections",
  "external",
  "versions",
] as const;

type DetailSection = (typeof DETAIL_SECTIONS)[number];

interface DetailSectionNavProps {
  adjacent?: AdjacentSkillContext;
  backSearch: string;
  detailPathname: string;
}

function sectionFromHash(hash: string): DetailSection | undefined {
  const section = hash.replace(/^#/, "") as DetailSection;
  return DETAIL_SECTIONS.includes(section) ? section : undefined;
}

export function DetailSectionNav({
  adjacent,
  backSearch,
  detailPathname,
}: DetailSectionNavProps) {
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
    <>
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
      {adjacent ? (
        <nav aria-label={t("skillDetail.navigation.label")} className="sh-skill-detail__adjacent">
          <span>{t("skillDetail.navigation.position", { position: adjacent.position, total: adjacent.total })}</span>
          <div className="sh-skill-detail__adjacent-controls">
            {adjacent.previous ? (
              <Link
                className="sh-button sh-button--ghost sh-button--sm"
                to={{ pathname: `${detailPathname}/${adjacent.previous.id}`, search: backSearch }}
              >
                {t("skillDetail.navigation.previous")}
              </Link>
            ) : (
              <button className="sh-button sh-button--ghost sh-button--sm" disabled type="button">
                {t("skillDetail.navigation.previous")}
              </button>
            )}
            {adjacent.next ? (
              <Link
                className="sh-button sh-button--ghost sh-button--sm"
                to={{ pathname: `${detailPathname}/${adjacent.next.id}`, search: backSearch }}
              >
                {t("skillDetail.navigation.next")}
              </Link>
            ) : (
              <button className="sh-button sh-button--ghost sh-button--sm" disabled type="button">
                {t("skillDetail.navigation.next")}
              </button>
            )}
          </div>
        </nav>
      ) : null}
    </>
  );
}
