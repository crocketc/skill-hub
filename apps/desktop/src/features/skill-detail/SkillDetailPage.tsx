import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { describeNativeError } from "../../api/nativeErrors";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { DataState } from "../../ui/DataState";
import { MarkdownWorkspace } from "../markdown/MarkdownWorkspace";
import {
  type MarkdownFacade,
} from "../markdown/api";
import { nativeMarkdownFacade } from "../markdown/nativeApi";
import { parseSkillLibrarySearchParams } from "../skills/queryState";
import { skillLibraryKeys } from "../skills/api";
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
import { SourceUpdatePanel } from "./SourceUpdatePanel";
import { SourceRelinkPanel } from "./SourceRelinkPanel";
import { RemovalImpactDialog } from "../removal/RemovalImpactDialog";
import type {
  RemovalFacade,
  RemovalImpact,
  RemovalChoice,
  UndeployDecision,
  UndeployImpact,
} from "../removal/api";
import { nativeRemovalFacade, unavailableRemovalFacade } from "../removal/nativeApi";
import { UndeployDialog } from "../removal/UndeployDialog";
import type { SkillRelation } from "./api";

interface SkillDetailPageProps {
  facade: SkillDetailFacade;
  markdownFacade?: MarkdownFacade;
  removalFacade?: RemovalFacade;
}

export function SkillDetailPage({
  facade,
  markdownFacade = nativeMarkdownFacade,
  removalFacade,
}: SkillDetailPageProps) {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { skillId = "" } = useParams();
  const isPreviewRoute = location.pathname.startsWith("/__preview/");
  const effectiveRemovalFacade = removalFacade ?? (isPreviewRoute ? unavailableRemovalFacade : nativeRemovalFacade);
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
  const currentVersion = summaryQuery.data?.currentVersion;
  const hasCurrentVersion = Boolean(currentVersion && currentVersion !== "unknown");
  const basicFindingsQuery = useQuery({
    enabled: hasCurrentVersion,
    queryFn: () => facade.getFindings(skillId, currentVersion ?? "", "basic"),
    queryKey: [...skillDetailKeys.summary(skillId), "findings", "basic", currentVersion],
  });
  const llmFindingsQuery = useQuery({
    enabled: hasCurrentVersion,
    queryFn: () => facade.getFindings(skillId, currentVersion ?? "", "llm"),
    queryKey: [...skillDetailKeys.summary(skillId), "findings", "llm", currentVersion],
  });
  const [removalImpact, setRemovalImpact] = useState<RemovalImpact | null>(null);
  const [removalLoading, setRemovalLoading] = useState(false);
  const [removalSubmitting, setRemovalSubmitting] = useState(false);
  const [removalError, setRemovalError] = useState<string>();
  const [undeployImpact, setUndeployImpact] = useState<UndeployImpact | null>(null);
  const [undeploySubmitting, setUndeploySubmitting] = useState(false);
  const [undeployError, setUndeployError] = useState<string>();

  const startRemoval = async () => {
    setRemovalLoading(true);
    setRemovalError(undefined);
    try {
      setRemovalImpact(await effectiveRemovalFacade.prepareDelete(skillId, summaryQuery.data?.name));
    } catch (reason) {
      setRemovalError(describeNativeError(reason, (key, options) => String(t(key as never, options as never)), "removal.loadError"));
    } finally {
      setRemovalLoading(false);
    }
  };

  const commitRemoval = async (choices: Record<string, RemovalChoice>) => {
    if (!removalImpact?.operationId) return;
    setRemovalSubmitting(true);
    setRemovalError(undefined);
    try {
      const result = await effectiveRemovalFacade.commitDelete(removalImpact.operationId, choices);
      if (!result.centralSkillDeleted) {
        throw new Error("central skill was not deleted");
      }
      await queryClient.invalidateQueries({ queryKey: skillLibraryKeys.root });
      navigate({ pathname: backPathname, search: backSearch }, { replace: true, state: libraryReturn ? { libraryReturn } : undefined });
    } catch (reason) {
      setRemovalError(describeNativeError(reason, (key, options) => String(t(key as never, options as never)), "removal.commitError"));
    } finally {
      setRemovalSubmitting(false);
    }
  };

  const startUndeploy = async (relation: SkillRelation) => {
    setUndeployError(undefined);
    try {
      setUndeployImpact(await effectiveRemovalFacade.prepareUndeploy(relation.id, relation.label));
    } catch (reason) {
      setUndeployError(describeNativeError(reason, (key, options) => String(t(key as never, options as never)), "undeploy.loadError"));
    }
  };

  const commitUndeploy = async (decision: UndeployDecision) => {
    if (!undeployImpact) return;
    setUndeploySubmitting(true);
    setUndeployError(undefined);
    try {
      await effectiveRemovalFacade.commitUndeploy(undeployImpact.operationId, decision);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: skillDetailKeys.relations(skillId) }),
        queryClient.invalidateQueries({ queryKey: skillDetailKeys.summary(skillId) }),
        queryClient.invalidateQueries({ queryKey: skillLibraryKeys.root }),
      ]);
      setUndeployImpact(null);
    } catch {
      setUndeployError(t("undeploy.commitError"));
    } finally {
      setUndeploySubmitting(false);
    }
  };

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
            backPathname={backPathname}
            backSearch={backSearch}
            libraryReturn={libraryReturn}
            onDelete={!isPreviewRoute ? () => void startRemoval() : undefined}
            summary={summaryQuery.data}
          />
          <DetailSectionNav
            adjacent={adjacentQuery.data}
            backSearch={backSearch}
            detailPathname={detailPathname}
          />
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
                <>
                  {metadataQuery.isPending ? (
                    <p role="status">{t("skillDetail.states.loadingMetadata")}</p>
                  ) : metadataQuery.isError || !metadataQuery.data ? (
                    <p role="alert">{t("skillDetail.states.metadataError")}</p>
                  ) : (
                    <MetadataPanel facade={facade} metadata={metadataQuery.data} skillId={skillId} />
                  )}
                  <SourceRelinkPanel facade={facade} skillId={skillId} />
                </>
              ) : null}
              {section === "relations" ? (
                relationsQuery.isError ? (
                  <div aria-label={t("skillDetail.relations.loadErrorLabel")} role="alert">
                    <p>{t("skillDetail.relations.loadError")}</p>
                    <Button onClick={() => void relationsQuery.refetch()} size="sm" variant="secondary">
                      {t("skillDetail.relations.retry")}
                    </Button>
                  </div>
                ) : relationsQuery.data ? (
                  <RelationsPanel
                    onUndeploy={!isPreviewRoute ? (relation) => void startUndeploy(relation) : undefined}
                    relations={relationsQuery.data}
                  />
                ) : null
              ) : null}
              {section === "requirements" && requirementsQuery.data ? (
                <RequirementsPanel
                  invocation={metadataQuery.data?.invocation}
                  requirements={requirementsQuery.data}
                />
              ) : null}
              {section === "security" ? (
                <SecurityEvidence
                  findings={basicFindingsQuery.data}
                  llmFindings={llmFindingsQuery.data}
                  summary={summaryQuery.data}
                />
              ) : null}
              {section === "connections" && insightsQuery.data ? (
                <ConnectionEvidence insights={insightsQuery.data} />
              ) : null}
              {section === "external" && insightsQuery.data ? (
                <ExternalHistoryEvidence insights={insightsQuery.data} />
              ) : null}
              {section === "versions" ? (
                <>
                  <SourceUpdatePanel facade={facade} skillId={skillId} />
                  <VersionTimeline facade={facade} skillId={skillId} summary={summaryQuery.data} />
                </>
              ) : null}
            </section>
          ))}
        </main>
      </div>
      {removalLoading ? <p role="status">{t("removal.loading")}</p> : null}
      {removalImpact ? (
        <RemovalImpactDialog
          error={removalError}
          impact={removalImpact}
          onCancel={() => setRemovalImpact(null)}
          onConfirm={commitRemoval}
          submitting={removalSubmitting}
        />
      ) : removalError && !removalLoading ? <p role="alert">{removalError}</p> : null}
      {undeployImpact ? (
        <UndeployDialog
          error={undeployError}
          impact={undeployImpact}
          onCancel={() => setUndeployImpact(null)}
          onConfirm={commitUndeploy}
          submitting={undeploySubmitting}
        />
      ) : undeployError ? <p role="alert">{undeployError}</p> : null}
    </section>
  );
}
