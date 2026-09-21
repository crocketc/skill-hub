import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useState } from "react";
import { useTranslation } from "react-i18next";
import { describeNativeError } from "../../api/nativeErrors";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { DataState } from "../../ui/DataState";
import { Icon } from "../../ui/Icon";
import { buildSkillRelationshipViews } from "../relationshipGovernance/relationshipGovernance";
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
import { DetailSectionNav } from "./DetailSectionNav";
import { DetailStatusRail } from "./DetailStatusRail";
import { detailSearchFromLibrary, readLibraryReturnState } from "./detailContext";
import { MetadataPanel } from "./MetadataPanel";
import { LifecyclePanel } from "./LifecyclePanel";
import { RelationsPanel } from "./RelationsPanel";
import { ProvenancePanel } from "./ProvenancePanel";
import { RequirementsPanel } from "./RequirementsPanel";
import {
  ConnectionEvidence,
  ExternalHistoryEvidence,
  SecurityEvidence,
} from "./InsightPanels";
import { Button } from "../../ui/Button";
import { useOptionalAppNotifications } from "../../ui/notifications";
import { operationTracker, type OperationTracker } from "../../platform/operationTracker";
import { runTrackedOperation } from "../../platform/runTrackedOperation";
import { VersionTimeline } from "./VersionTimeline";
import { SourceUpdatePanel } from "./SourceUpdatePanel";
import { SourceRelinkPanel } from "./SourceRelinkPanel";
import { RemovalImpactDialog } from "../removal/RemovalImpactDialog";
import { SemanticDuplicatePanel } from "./SemanticDuplicatePanel";
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
  tracker?: OperationTracker;
}

/** 关系区唯一强化的视觉线索：来源 → 本地集中库 → 部署目标（图标仅装饰，含义由文字承载）。 */
function SkillTrajectory({
  deployments,
  source,
  version,
}: {
  deployments: number;
  source?: string;
  version: string;
}) {
  const { t } = useTranslation();
  return (
    <div
      aria-label={t("skillDetail.trajectory.label")}
      className="sh-skill-detail__trajectory"
      role="group"
    >
      <span className="sh-skill-detail__trajectory-step">
        <Icon aria-hidden="true" name="open-external" size={16} />
        <span className="sh-skill-detail__trajectory-label">{t("skillDetail.trajectory.source")}</span>
        <span className="sh-skill-detail__trajectory-value">{source ?? t("skillDetail.metadata.empty")}</span>
      </span>
      <span aria-hidden="true" className="sh-skill-detail__trajectory-link" />
      <span className="sh-skill-detail__trajectory-step">
        <Icon aria-hidden="true" name="library" size={16} />
        <span className="sh-skill-detail__trajectory-label">{t("skillDetail.trajectory.library")}</span>
        <span className="sh-skill-detail__trajectory-value">{version}</span>
      </span>
      <span aria-hidden="true" className="sh-skill-detail__trajectory-link" />
      <span className="sh-skill-detail__trajectory-step">
        <Icon aria-hidden="true" name="deploy" size={16} />
        <span className="sh-skill-detail__trajectory-label">{t("skillDetail.trajectory.deployments")}</span>
        <span className="sh-skill-detail__trajectory-value">
          {t("skillDetail.statusRail.deployments", { count: deployments })}
        </span>
      </span>
    </div>
  );
}

export function SkillDetailPage({
  facade,
  markdownFacade = nativeMarkdownFacade,
  removalFacade,
  tracker = operationTracker,
}: SkillDetailPageProps) {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const notifications = useOptionalAppNotifications();
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
  const provenanceQuery = useQuery({
    queryFn: () => facade.getProvenance(skillId),
    queryKey: skillDetailKeys.provenance(skillId),
  });
  const relationshipQuery = useQuery({
    queryFn: () => facade.getRelationshipOverview(skillId),
    queryKey: skillDetailKeys.relationship(skillId),
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

  // Task 7：关系概览是只读事实查询；失败只降级关系明细区，不影响其他面板。
  const relationshipViews = relationshipQuery.data
    ? buildSkillRelationshipViews(relationshipQuery.data)
    : undefined;
  const loadRelationshipRemovalImpact = useCallback(
    (relationId: string) => facade.getRelationshipRemovalImpact(relationId),
    [facade],
  );

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
    const operationId = removalImpact?.operationId;
    if (!operationId) return;
    setRemovalSubmitting(true);
    setRemovalError(undefined);
    try {
      const result = await runTrackedOperation({
        tracker,
        notifications,
        kind: "remove",
        label: t("removal.tracker.batchLabel"),
        operationId,
        translate: (key, options) => String(t(key as never, options as never)),
        queryClient,
        invalidateQueryKeys: [skillLibraryKeys.root],
        run: async (handle) => {
          handle.correlate(operationId);
          return effectiveRemovalFacade.commitDelete(operationId, choices);
        },
      });
      if (!result.centralSkillDeleted) {
        throw new Error("central skill was not deleted");
      }
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
    const operationId = undeployImpact?.operationId;
    if (!operationId) return;
    setUndeploySubmitting(true);
    setUndeployError(undefined);
    try {
      await runTrackedOperation({
        tracker,
        notifications,
        kind: "remove",
        label: t("undeploy.eyebrow"),
        operationId,
        translate: (key, options) => String(t(key as never, options as never)),
        queryClient,
        invalidateQueryKeys: [
          skillDetailKeys.relations(skillId),
          skillDetailKeys.summary(skillId),
          skillLibraryKeys.root,
        ],
        run: async (handle) => {
          handle.correlate(operationId);
          await effectiveRemovalFacade.commitUndeploy(operationId, decision);
        },
      });
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

  // DEV-22：状态栏与轨迹的部署关系计数与「关系」区块同源（同一份
  // get_deployment_relations 查询，仅计活跃关系）。summary 里的计数字段
  // 是后端未填充的占位 0，此前状态页签恒显 0、与关系页签矛盾。
  const deploymentCount = relationsQuery.data
    ? relationsQuery.data.length
    : summaryQuery.data.agentDeploymentCount + summaryQuery.data.projectDeploymentCount;

  return (
    <section className="sh-skill-detail">
      <div className="sh-skill-detail__layout">
        <aside className="sh-skill-detail__rail">
          <Link
            className="sh-skill-detail__back"
            state={libraryReturn ? { libraryReturn } : undefined}
            to={{ pathname: backPathname, search: backSearch }}
          >
            {t("skillDetail.navigation.back")}
          </Link>
          <DetailSectionNav
            adjacent={adjacentQuery.data}
            backSearch={backSearch}
            detailPathname={detailPathname}
          />
        </aside>
        <main className="sh-skill-detail__content">
          <DetailHeader
            onDelete={!isPreviewRoute ? () => void startRemoval() : undefined}
            summary={summaryQuery.data}
          />
          <section aria-labelledby="zone-identity-heading" className="sh-skill-detail__zone" id="zone-identity">
            <h2 id="zone-identity-heading">{t("skillDetail.zones.identity")}</h2>
            <div className="sh-skill-detail__block" id="metadata">
              <h3>{t("skillDetail.navigation.sections.metadata")}</h3>
              {metadataQuery.isPending ? (
                <p role="status">{t("skillDetail.states.loadingMetadata")}</p>
              ) : metadataQuery.isError || !metadataQuery.data ? (
                <p role="alert">{t("skillDetail.states.metadataError")}</p>
              ) : (
                <MetadataPanel facade={facade} metadata={metadataQuery.data} skillId={skillId} />
              )}
              <SourceRelinkPanel facade={facade} skillId={skillId} />
            </div>
          </section>
          <section aria-labelledby="zone-status-heading" className="sh-skill-detail__zone" id="zone-status">
            <h2 id="zone-status-heading">{t("skillDetail.zones.status")}</h2>
            <div className="sh-skill-detail__block" id="overview">
              <h3>{t("skillDetail.navigation.sections.overview")}</h3>
              <p>{summaryQuery.data.purpose}</p>
              <LifecyclePanel summary={summaryQuery.data} />
              <DetailStatusRail
                deployments={relationsQuery.data?.length}
                facade={facade}
                skillId={skillId}
                summary={summaryQuery.data}
              />
            </div>
            <div className="sh-skill-detail__block" id="security">
              <h3>{t("skillDetail.navigation.sections.security")}</h3>
              <SecurityEvidence
                findings={basicFindingsQuery.data}
                llmFindings={llmFindingsQuery.data}
                summary={summaryQuery.data}
              />
            </div>
          </section>
          <section aria-labelledby="zone-content-heading" className="sh-skill-detail__zone" id="zone-content">
            <h2 id="zone-content-heading">{t("skillDetail.zones.content")}</h2>
            <div className="sh-skill-detail__block" id="description">
              <h3>{t("skillDetail.navigation.sections.description")}</h3>
              <MarkdownWorkspace facade={markdownFacade} skillId={skillId} />
            </div>
          </section>
          <section aria-labelledby="zone-relations-heading" className="sh-skill-detail__zone" id="zone-relations">
            <h2 id="zone-relations-heading">{t("skillDetail.zones.relations")}</h2>
            <SkillTrajectory
              deployments={deploymentCount}
              source={metadataQuery.data?.source}
              version={summaryQuery.data.currentVersion}
            />
            <div className="sh-skill-detail__block" id="relations">
              <h3>{t("skillDetail.navigation.sections.relations")}</h3>
              {relationsQuery.isError ? (
                <div aria-label={t("skillDetail.relations.loadErrorLabel")} role="alert">
                  <p>{t("skillDetail.relations.loadError")}</p>
                  <Button onClick={() => void relationsQuery.refetch()} size="sm" variant="secondary">
                    {t("skillDetail.relations.retry")}
                  </Button>
                </div>
              ) : null}
              {relationshipQuery.isError ? (
                <p role="note">{t("skillDetail.relations.governed.loadError")}</p>
              ) : null}
              {relationsQuery.data ? (
                <RelationsPanel
                  governanceHref={(relation) =>
                    `/relationships/governance?from=library&skillId=${encodeURIComponent(skillId)}&relationId=${encodeURIComponent(relation.relationId)}`}
                  onLoadRemovalImpact={loadRelationshipRemovalImpact}
                  onUndeploy={!isPreviewRoute ? (relation) => void startUndeploy(relation) : undefined}
                  relationship={relationshipViews}
                  relations={relationsQuery.data}
                />
              ) : null}
            </div>
            <div className="sh-skill-detail__block" id="provenance">
              <h3>{t("skillDetail.provenance.heading")}</h3>
              {provenanceQuery.isError ? (
                <div aria-label={t("skillDetail.provenance.loadErrorLabel")} role="alert">
                  <p>{t("skillDetail.provenance.loadError")}</p>
                  <Button onClick={() => void provenanceQuery.refetch()} size="sm" variant="secondary">
                    {t("skillDetail.provenance.retry")}
                  </Button>
                </div>
              ) : provenanceQuery.data ? (
                <ProvenancePanel
                  observedDeployments={provenanceQuery.data.observedDeployments}
                  provenance={provenanceQuery.data.provenance}
                  relationship={relationshipViews
                    ? {
                        conflicts: relationshipViews.conflicts,
                        pendingTasks: relationshipViews.pendingTasks,
                        sources: relationshipViews.sources,
                      }
                    : undefined}
                />
              ) : null}
            </div>
            <div className="sh-skill-detail__block" id="requirements">
              <h3>{t("skillDetail.navigation.sections.requirements")}</h3>
              {requirementsQuery.data ? (
                <RequirementsPanel
                  invocationPolicy={metadataQuery.data?.invocationPolicy}
                  requirements={requirementsQuery.data}
                />
              ) : null}
            </div>
            <div className="sh-skill-detail__block" id="connections">
              <h3>{t("skillDetail.navigation.sections.connections")}</h3>
              {insightsQuery.data ? (
                <>
                  <ConnectionEvidence insights={insightsQuery.data} />
                  <SemanticDuplicatePanel
                    deterministicCandidates={insightsQuery.data.deterministicDuplicates}
                    facade={facade}
                    skillId={skillId}
                  />
                </>
              ) : null}
            </div>
          </section>
          <section aria-labelledby="zone-lifecycle-heading" className="sh-skill-detail__zone" id="zone-lifecycle">
            <h2 id="zone-lifecycle-heading">{t("skillDetail.zones.lifecycle")}</h2>
            <div className="sh-skill-detail__block" id="versions">
              <h3>{t("skillDetail.navigation.sections.versions")}</h3>
              <div className="sh-button-row">
                <Button
                  onClick={() => navigate("/settings/data-protection", {
                    state: { exportSkillIds: [skillId] },
                  })}
                  variant="secondary"
                >
                  {t("skillDetail.versions.exportSkill")}
                </Button>
              </div>
              <SourceUpdatePanel facade={facade} skillId={skillId} />
              <VersionTimeline facade={facade} skillId={skillId} summary={summaryQuery.data} />
            </div>
            <div className="sh-skill-detail__block" id="external">
              <h3>{t("skillDetail.navigation.sections.external")}</h3>
              {insightsQuery.data ? (
                <ExternalHistoryEvidence insights={insightsQuery.data} />
              ) : null}
            </div>
          </section>
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
