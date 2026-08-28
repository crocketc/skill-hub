import { useQuery } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { useLocation, useParams } from "react-router-dom";
import { DataState } from "../../ui/DataState";
import { MarkdownWorkspace } from "../markdown/MarkdownWorkspace";
import {
  type MarkdownFacade,
  unavailableMarkdownFacade,
} from "../markdown/api";
import { parseSkillLibrarySearchParams } from "../skills/queryState";
import type { SkillDetailFacade } from "./api";
import {
  SkillDetailNotFoundError,
  SkillDetailUnavailableError,
  skillDetailKeys,
} from "./api";
import { DetailHeader } from "./DetailHeader";
import { DETAIL_SECTIONS, DetailSectionNav } from "./DetailSectionNav";
import { DetailStatusRail } from "./DetailStatusRail";
import { detailSearchFromLibrary, readLibraryReturnState } from "./detailContext";
import { MetadataPanel } from "./MetadataPanel";
import { LifecyclePanel } from "./LifecyclePanel";
import { RelationsPanel } from "./RelationsPanel";
import { RequirementsPanel } from "./RequirementsPanel";
import {
  ConnectionEvidence,
  ExternalHistoryEvidence,
  SecurityEvidence,
} from "./InsightPanels";
import { Button } from "../../ui/Button";
import { VersionTimeline } from "./VersionTimeline";

interface SkillDetailPageProps {
  facade: SkillDetailFacade;
  markdownFacade?: MarkdownFacade;
}

export function SkillDetailPage({
  facade,
  markdownFacade = unavailableMarkdownFacade,
}: SkillDetailPageProps) {
  const { t } = useTranslation();
  const location = useLocation();
  const { skillId = "" } = useParams();
  const isPreviewRoute = location.pathname.startsWith("/__preview/");
  const backPathname = isPreviewRoute ? "/__preview/skill-library" : "/library";
  const detailPathname = isPreviewRoute ? "/__preview/skill-detail" : "/library";
  const libraryReturn = readLibraryReturnState(location.state);
  const backSearch = detailSearchFromLibrary(location.search);
  const libraryQuery = parseSkillLibrarySearchParams(backSearch).query;
  const hasLibraryContext = Boolean(location.search || libraryReturn);
  const summaryQuery = useQuery({
    queryFn: () => facade.getSummary(skillId),
    queryKey: skillDetailKeys.summary(skillId),
    retry: false,
  });
  const adjacentQuery = useQuery({
    enabled: isPreviewRoute || hasLibraryContext,
    queryFn: () => facade.getAdjacentContext(skillId, libraryQuery),
    queryKey: skillDetailKeys.adjacent(skillId, libraryQuery),
  });
  const metadataQuery = useQuery({
    queryFn: () => facade.getMetadata(skillId),
    queryKey: skillDetailKeys.metadata(skillId),
  });
  const relationsQuery = useQuery({
    queryFn: () => facade.getRelations(skillId),
    queryKey: skillDetailKeys.relations(skillId),
  });
  const requirementsQuery = useQuery({
    queryFn: () => facade.getRequirements(skillId),
    queryKey: skillDetailKeys.requirements(skillId),
  });
  const insightsQuery = useQuery({
    queryFn: () => facade.getInsights(skillId),
    queryKey: skillDetailKeys.insights(skillId),
  });

  if (summaryQuery.isPending) {
    return <DataState state="loading" message={t("skillDetail.states.loading")} />;
  }
  if (summaryQuery.isError || !summaryQuery.data) {
    if (summaryQuery.error instanceof SkillDetailUnavailableError) {
      return <DataState state="unavailable" message={t("skillDetail.states.unavailable")} />;
    }
    if (summaryQuery.error instanceof SkillDetailNotFoundError) {
      return <DataState state="empty" message={t("skillDetail.states.notFound")} />;
    }
    return (
      <DataState
        actionLabel={t("actions.retry")}
        message={t("skillDetail.states.error")}
        onAction={() => void summaryQuery.refetch()}
        state="error"
      />
    );
  }

  return (
    <section className="sh-skill-detail">
      <div className="sh-skill-detail__layout">
        <aside className="sh-skill-detail__rail">
          <DetailHeader
            adjacent={adjacentQuery.data}
            backPathname={backPathname}
            backSearch={backSearch}
            detailPathname={detailPathname}
            libraryReturn={libraryReturn}
            summary={summaryQuery.data}
          />
          <DetailSectionNav />
        </aside>
        <main className="sh-skill-detail__content">
          {DETAIL_SECTIONS.map((section) => (
            <section className={`sh-skill-detail__section sh-skill-detail__section--${section}`} id={section} key={section}>
              <h2>{t(`skillDetail.navigation.sections.${section}`)}</h2>
              {section === "overview" ? (
                <>
                  <p>{summaryQuery.data.purpose}</p>
                  <LifecyclePanel summary={summaryQuery.data} />
                  <DetailStatusRail facade={facade} skillId={skillId} summary={summaryQuery.data} />
                </>
              ) : null}
              {section === "description" ? (
                <MarkdownWorkspace facade={markdownFacade} skillId={skillId} />
              ) : null}
              {section === "metadata" ? (
                metadataQuery.isPending ? (
                  <p role="status">{t("skillDetail.states.loadingMetadata")}</p>
                ) : metadataQuery.isError || !metadataQuery.data ? (
                  <p role="alert">{t("skillDetail.states.metadataError")}</p>
                ) : (
                  <MetadataPanel facade={facade} metadata={metadataQuery.data} skillId={skillId} />
                )
              ) : null}
              {section === "relations" ? (
                relationsQuery.isError ? (
                  <div aria-label={t("skillDetail.relations.loadErrorLabel")} role="alert">
                    <p>{t("skillDetail.relations.loadError")}</p>
                    <Button onClick={() => void relationsQuery.refetch()} size="sm" variant="secondary">
                      {t("skillDetail.relations.retry")}
                    </Button>
                  </div>
                ) : relationsQuery.data ? <RelationsPanel relations={relationsQuery.data} /> : null
              ) : null}
              {section === "requirements" && requirementsQuery.data ? (
                <RequirementsPanel
                  invocation={metadataQuery.data?.invocation}
                  requirements={requirementsQuery.data}
                />
              ) : null}
              {section === "security" ? <SecurityEvidence summary={summaryQuery.data} /> : null}
              {section === "connections" && insightsQuery.data ? (
                <ConnectionEvidence insights={insightsQuery.data} />
              ) : null}
              {section === "external" && insightsQuery.data ? (
                <ExternalHistoryEvidence insights={insightsQuery.data} />
              ) : null}
              {section === "versions" ? <VersionTimeline facade={facade} skillId={skillId} /> : null}
            </section>
          ))}
        </main>
      </div>
    </section>
  );
}
