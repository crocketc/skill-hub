import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useLocation } from "react-router-dom";
import type { AdjacentSkillContext } from "./api";

/** 详情页五个信息区（设计规格 5.4）：身份、状态、正文、关系、生命周期。 */
export const DETAIL_ZONES = [
  "identity",
  "status",
  "content",
  "relations",
  "lifecycle",
] as const;

export type DetailZone = (typeof DETAIL_ZONES)[number];

/** 旧九章节锚点保留为分区内的锚点 id；外部分链路（如快速抽屉 #versions）不断链。 */
const ANCHOR_ZONES: Record<string, DetailZone> = {
  overview: "status",
  metadata: "identity",
  description: "content",
  relations: "relations",
  requirements: "relations",
  security: "status",
  connections: "relations",
  external: "lifecycle",
  versions: "lifecycle",
};

function zoneFromHash(hash: string): DetailZone | undefined {
  const id = hash.replace(/^#/, "");
  if (DETAIL_ZONES.includes(id as DetailZone)) return id as DetailZone;
  return ANCHOR_ZONES[id];
}

interface DetailSectionNavProps {
  adjacent?: AdjacentSkillContext;
  backSearch: string;
  detailPathname: string;
}

export function DetailSectionNav({
  adjacent,
  backSearch,
  detailPathname,
}: DetailSectionNavProps) {
  const { t } = useTranslation();
  const location = useLocation();
  const [activeZone, setActiveZone] = useState<DetailZone>(() =>
    zoneFromHash(location.hash) ?? "identity",
  );

  useEffect(() => {
    const zone = zoneFromHash(location.hash);
    if (zone) setActiveZone(zone);
  }, [location.hash]);

  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;

    const observer = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((entry) => entry.isIntersecting)
          .sort((left, right) => left.boundingClientRect.top - right.boundingClientRect.top);
        const zoneId = visible[0]?.target.id.replace(/^zone-/, "");
        if (DETAIL_ZONES.includes(zoneId as DetailZone)) {
          setActiveZone(zoneId as DetailZone);
        }
      },
      { rootMargin: "-12% 0px -68% 0px", threshold: [0, 1] },
    );

    DETAIL_ZONES.forEach((zone) => {
      const element = document.getElementById(`zone-${zone}`);
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
        className="sh-skill-detail__zone-nav"
      >
        {DETAIL_ZONES.map((zone) => (
          <a
            aria-current={activeZone === zone ? "location" : undefined}
            className={activeZone === zone ? "is-active" : undefined}
            href={`#zone-${zone}`}
            key={zone}
            onClick={() => setActiveZone(zone)}
          >
            {t(`skillDetail.zones.${zone}`)}
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
