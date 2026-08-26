import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useLocation, useParams } from "react-router-dom";
import { DataState } from "../../ui/DataState";
import { parseSkillLibrarySearchParams } from "../skills/queryState";
import type { SkillDetailFacade } from "./api";
import { skillDetailKeys } from "./api";
import { DetailHeader } from "./DetailHeader";
import { DETAIL_SECTIONS, DetailSectionNav } from "./DetailSectionNav";
import { DetailStatusRail } from "./DetailStatusRail";
import { detailSearchFromLibrary, readLibraryReturnState } from "./detailContext";

interface SkillDetailPageProps {
  facade: SkillDetailFacade;
}

export function SkillDetailPage({ facade }: SkillDetailPageProps) {
  const { t } = useTranslation();
  const location = useLocation();
  const { skillId = "" } = useParams();
  const libraryReturn = readLibraryReturnState(location.state);
  const backSearch = detailSearchFromLibrary(location.search);
  const libraryQuery = parseSkillLibrarySearchParams(backSearch).query;
  const hasLibraryContext = Boolean(location.search || libraryReturn);
  const summaryQuery = useQuery({
    queryFn: () => facade.getSummary(skillId),
    queryKey: skillDetailKeys.summary(skillId),
  });
  const adjacentQuery = useQuery({
    enabled: hasLibraryContext,
    queryFn: () => facade.getAdjacentContext(skillId, libraryQuery),
    queryKey: skillDetailKeys.adjacent(skillId, libraryQuery),
  });

  if (summaryQuery.isPending) {
    return <DataState state="loading" message={t("skillDetail.states.loading")} />;
  }
  if (summaryQuery.isError || !summaryQuery.data) {
    return <DataState state="error" message={t("skillDetail.states.error")} />;
  }

  return (
    <section className="sh-skill-detail">
      <DetailHeader adjacent={adjacentQuery.data} backSearch={backSearch} summary={summaryQuery.data} />
      <div className="sh-skill-detail__layout">
        <DetailSectionNav />
        <main className="sh-skill-detail__content">
          {DETAIL_SECTIONS.map((section) => (
            <section className="sh-skill-detail__section" id={section} key={section}>
              <h2>{t(`skillDetail.navigation.sections.${section}`)}</h2>
              {section === "overview" ? <p>{summaryQuery.data.purpose}</p> : null}
            </section>
          ))}
        </main>
        <DetailStatusRail summary={summaryQuery.data} />
      </div>
    </section>
  );
}
