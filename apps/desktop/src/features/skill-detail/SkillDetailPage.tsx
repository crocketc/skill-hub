import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { describeNativeError } from "../../api/nativeErrors";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { DataState } from "../../ui/DataState";
import { Icon } from "../../ui/Icon";
import { readableAgentIdName } from "../../ui/AgentPresentation";
import { buildSkillRelationshipViews } from "../relationshipGovernance/relationshipGovernance";
import {
  relationIdOf,
  type RelationGovernanceFacade,
} from "../relationships/governance/api";
import { nativeGovernanceFacade } from "../relationships/governance/nativeApi";
import { relationshipsKeys } from "../relationships/api";
import { useRelationshipContextCheck } from "../relationships/governance/useRelationshipContextCheck";
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
import { buildGovernanceLibraryReturnTo } from "../relationships/governance/libraryReturnContext";
import { MetadataPanel } from "./MetadataPanel";
import { LifecyclePanel } from "./LifecyclePanel";
import { RelationsPanel } from "./RelationsPanel";
import { ProvenancePanel } from "./ProvenancePanel";
import { RequirementsPanel } from "./RequirementsPanel";
import { ConnectionEvidence, ExternalHistoryEvidence } from "./InsightPanels";
import { SecurityResults } from "../security/SecurityResults";
import type { SecurityFacade } from "../security/api";
import { Button } from "../../ui/Button";
import { useOptionalAppNotifications } from "../../ui/notifications";
import { operationTracker, type OperationTracker } from "../../platform/operationTracker";
import { runTrackedOperation } from "../../platform/runTrackedOperation";
import { VersionTimeline } from "./VersionTimeline";
import { SourceUpdatePanel } from "./SourceUpdatePanel";
import { SourceRelinkPanel } from "./SourceRelinkPanel";
import { UpstreamLineage } from "./UpstreamLineage";
import { RemovalImpactDialog } from "../removal/RemovalImpactDialog";
import {
  RemovalOutcomeResult,
  type RemovalOutcomeTargetLabel,
} from "../removal/RemovalOutcomeResult";
import { SemanticDuplicatePanel } from "./SemanticDuplicatePanel";
import type {
  RemovalFacade,
  RemovalImpact,
  RemovalChoice,
  RemovalResult,
  UndeployDecision,
  UndeployImpact,
} from "../removal/api";
import { nativeRemovalFacade, unavailableRemovalFacade } from "../removal/nativeApi";
import { UndeployDialog } from "../removal/UndeployDialog";
import type { SkillRelation } from "./api";
import { SkillDetailReviewExperience } from "./SkillDetailReviewExperience";

interface SkillDetailPageProps {
  facade: SkillDetailFacade;
  markdownFacade?: MarkdownFacade;
  /** 任务 12C：治理门面（上下文自动检查 + 来源事件摘要）；缺省用原生实现。 */
  governanceFacade?: RelationGovernanceFacade;
  removalFacade?: RemovalFacade;
  securityFacade: SecurityFacade;
  refreshSnapshot?: () => Promise<void>;
  tracker?: OperationTracker;
  reviewPrototype?: boolean;
}

/** 关系区唯一强化的视觉线索：来源 → 本地集中库 → 部署目标（图标仅装饰，含义由文字承载）。 */
function SkillTrajectory({
  deployments,
  source,
  version,
}: {
  deployments?: number;
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
          {deployments === undefined
            ? t("skillDetail.statusRail.deploymentsUnavailable")
            : t("skillDetail.statusRail.deployments", { count: deployments })}
        </span>
      </span>
    </div>
  );
}

export function SkillDetailPage({
  facade,
  markdownFacade = nativeMarkdownFacade,
  governanceFacade = nativeGovernanceFacade,
  removalFacade,
  securityFacade,
  refreshSnapshot,
  tracker = operationTracker,
  reviewPrototype = false,
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
  const governanceReturnTo = isPreviewRoute
    ? undefined
    : buildGovernanceLibraryReturnTo(skillId, backSearch, location.hash);
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
  // 任务 12C：当前 Skill 的可管理关系台账 + 最近来源事件摘要（只读）。
  const governanceLedgerQuery = useQuery({
    enabled: !reviewPrototype,
    queryFn: () => governanceFacade.listGovernance({ skill_id: skillId }),
    queryKey: relationshipsKeys.governance({ skill_id: skillId }),
  });
  const governedRelationIds = (governanceLedgerQuery.data?.rows ?? []).map((row) =>
    relationIdOf(row.relation),
  );
  useRelationshipContextCheck({
    facade: governanceFacade,
    scope: `skill:${skillId}`,
    relationIds: governedRelationIds,
    enabled: !reviewPrototype && governanceLedgerQuery.isSuccess && governedRelationIds.length > 0,
  });
  const sourceEventsQuery = useQuery({
    enabled: !reviewPrototype,
    queryFn: () => governanceFacade.listHistory({ skillId, page: 1, pageSize: 5 }),
    queryKey: relationshipsKeys.governanceHistory({ page: 1, pageSize: 5, skillId }),
  });
  const sourceEvents = [...(sourceEventsQuery.data?.items ?? [])].sort(
    (left, right) => Number(right.occurred_at) - Number(left.occurred_at),
  );
  const requirementsQuery = useQuery({
    queryFn: () => facade.getRequirements(skillId),
    queryKey: skillDetailKeys.requirements(skillId),
  });
  const insightsQuery = useQuery({
    queryFn: () => facade.getInsights(skillId),
    queryKey: skillDetailKeys.insights(skillId),
  });
  const [removalImpact, setRemovalImpact] = useState<RemovalImpact | null>(null);
  const [removalLoading, setRemovalLoading] = useState(false);
  const [removalSubmitting, setRemovalSubmitting] = useState(false);
  const [removalError, setRemovalError] = useState<string>();
  // K2/G-07：中央删除失败（目标已回收、中央 Skill 未删除）时的逐项结果面板数据；
  // targetLabels 用 prepare 返回的目标显示名，绝不裸露 deployment_id。
  const [removalOutcome, setRemovalOutcome] = useState<{
    result: RemovalResult;
    targetLabels: Record<string, RemovalOutcomeTargetLabel>;
  } | null>(null);
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
    setRemovalOutcome(null);
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
    if (!operationId) {
      // K2 预览失效边界：prepared 丢失时拒绝提交并要求重新预览，
      // 绝不静默 no-op 让确认动作看起来成功而什么都不发生。
      setRemovalError(t("removal.errors.previewInvalidated"));
      return;
    }
    setRemovalSubmitting(true);
    setRemovalError(undefined);
    try {
      const result = await runTrackedOperation<RemovalResult>({
        tracker,
        notifications,
        kind: "remove",
        label: t("removal.tracker.batchLabel"),
        operationId,
        translate: (key, options) => String(t(key as never, options as never)),
        queryClient,
        invalidateQueryKeys: [skillLibraryKeys.root],
        // K2/G-07：中央删除失败不是成功——tracker 如实记失败，不冒充完成。
        summarize: (settled) => ({
          succeeded: settled.centralSkillDeleted ? 1 : 0,
          failed: settled.centralSkillDeleted ? 0 : 1,
          skipped: 0,
        }),
        run: async (handle) => {
          handle.correlate(operationId);
          return effectiveRemovalFacade.commitDelete(operationId, choices);
        },
      });
      if (!result.centralSkillDeleted) {
        // 故障矩阵：delete_skill 失败——目标已回收但中央 Skill 未删除。渲染
        // 逐项结果面板（含恢复入口）而不是抛原始错误；不导航回列表冒充完成。
        setRemovalImpact(null);
        setRemovalOutcome({
          result,
          targetLabels: Object.fromEntries(
            (removalImpact?.deployments ?? []).map((deployment) => [
              deployment.id,
              { label: deployment.label, path: deployment.path },
            ]),
          ),
        });
        return;
      }
      navigate({ pathname: backPathname, search: backSearch }, { replace: true, state: libraryReturn ? { libraryReturn } : undefined });
    } catch (reason) {
      setRemovalError(describeNativeError(reason, (key, options) => String(t(key as never, options as never)), "removal.commitError"));
    } finally {
      setRemovalSubmitting(false);
    }
  };

  const startUndeploy = async (relation: SkillRelation) => {    setUndeployError(undefined);
    try {
      // DEV-97：relation.label 来自后端目标 label（技术 client_id），
      // 确认标题呈现品牌显示名；共享目录与项目关系保持可读名称。
      const targetName = relation.kind === "agent"
        ? relation.sharedDirectory
          ? t("agents.sharedBrand")
          : readableAgentIdName(relation.agentClientId ?? relation.label)
        : relation.label;
      setUndeployImpact(await effectiveRemovalFacade.prepareUndeploy(relation.id, targetName));
    } catch (reason) {
      setUndeployError(describeNativeError(reason, (key, options) => String(t(key as never, options as never)), "undeploy.loadError"));
    }
  };

  const commitUndeploy = async (decision: UndeployDecision) => {
    const operationId = undeployImpact?.operationId;
    if (!operationId) {
      // K2 预览失效边界：prepared 丢失时拒绝提交并要求重新预览，不静默。
      setUndeployError(t("removal.errors.previewInvalidated"));
      return;
    }
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

  // W3-1（FB-003 裁决第 1 节）：待办「不信任（删除）」经 removalRequest 状态
  // 直达既有删除影响确认——复用 startRemoval 同一条流程，不造第二套删除；
  // 每次挂载至多自动触发一次，且只响应当前 Skill 的请求。
  const removalRequestHandledRef = useRef(false);
  const removalRequest = (location.state as { removalRequest?: { skillId?: string } } | null)?.removalRequest;
  const summaryReady = !summaryQuery.isPending && !summaryQuery.isError && Boolean(summaryQuery.data);
  useEffect(() => {
    if (removalRequestHandledRef.current) return;
    if (isPreviewRoute || !summaryReady) return;
    if (!removalRequest || removalRequest.skillId !== skillId) return;
    removalRequestHandledRef.current = true;
    void startRemoval();
    // startRemoval 只依赖 skillId 与 summary 名称；挂载期一次性触发。
  }, [isPreviewRoute, removalRequest, skillId, summaryReady]);

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

  if (reviewPrototype) {
    const reviewReturnParams = new URLSearchParams(backSearch);
    reviewReturnParams.delete("detailPrototype");
    reviewReturnParams.set("drawerPrototype", "review");
    reviewReturnParams.set("skill", skillId);
    return (
      <SkillDetailReviewExperience
        adjacent={adjacentQuery.data}
        backSearch={backSearch}
        detailPathname={detailPathname}
        facade={facade}
        insights={insightsQuery.data}
        markdownFacade={markdownFacade}
        metadata={metadataQuery.data}
        provenance={provenanceQuery.data}
        requirements={requirementsQuery.data}
        securityFacade={securityFacade}
        skillId={skillId}
        summary={summaryQuery.data}
        libraryReturn={libraryReturn}
        returnToLibrary={`${backPathname}?${reviewReturnParams.toString()}`}
      />
    );
  }

  // 部署关系优先使用「关系」区块的成功结果；查询失败时回退到 get_skill
  // 的同口径计数。旧记录缺少任一计数时保留未知，不显示为 0。
  const deploymentCount = relationsQuery.data
    ? relationsQuery.data.length
    : summaryQuery.data.agentDeploymentCount !== undefined
      && summaryQuery.data.projectDeploymentCount !== undefined
      ? summaryQuery.data.agentDeploymentCount + summaryQuery.data.projectDeploymentCount
      : undefined;

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
          <div
            aria-label={t("skillDetail.navigation.skillIdentity")}
            className="sh-skill-detail__rail-identity"
            role="group"
          >
            {summaryQuery.data.alias ? (
              <span className="sh-skill-detail__rail-alias">{summaryQuery.data.alias}</span>
            ) : null}
            <strong>{summaryQuery.data.name}</strong>
          </div>
          <DetailSectionNav
            adjacent={adjacentQuery.data}
            backSearch={backSearch}
            detailPathname={detailPathname}
            libraryReturn={libraryReturn}
          />
        </aside>
        <main className="sh-skill-detail__content">
          <DetailHeader
            onDispatch={!isPreviewRoute ? () => navigate(`/deploy?skill=${encodeURIComponent(skillId)}`, {
              state: libraryReturn ? { libraryReturn } : undefined,
            }) : undefined}
            onDelete={!isPreviewRoute ? () => void startRemoval() : undefined}
            onExport={!isPreviewRoute ? () => navigate("/settings/data-protection", {
              state: {
                exportSkillIds: [skillId],
                ...(libraryReturn ? { libraryReturn } : {}),
              },
            }) : undefined}
            onSecurityHandling={!isPreviewRoute && summaryQuery.data.securityAlert
              ? () => navigate(`/library/${encodeURIComponent(skillId)}/security`, {
                  state: libraryReturn ? { libraryReturn } : undefined,
                })
              : undefined}
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
                <MetadataPanel
                  facade={facade}
                  metadata={metadataQuery.data}
                  refreshSnapshot={refreshSnapshot}
                  skillId={skillId}
                />
              )}
              {/* K5/MS-04：上游谱系在身份数据区内如实呈现；未登记时不渲染。 */}
              <UpstreamLineage lineage={summaryQuery.data.upstreamLineage} />
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
              {summaryQuery.data.currentVersionId ? (
                <SecurityResults
                  facade={securityFacade}
                  securityAlert={summaryQuery.data.securityAlert}
                  skillId={skillId}
                  variant="embedded"
                  versionId={summaryQuery.data.currentVersionId}
                />
              ) : (
                <DataState
                  message={t("skillDetail.states.noCurrentVersionForSecurity")}
                  state="empty"
                />
              )}
            </div>
          </section>
          <section aria-labelledby="zone-content-heading" className="sh-skill-detail__zone" id="zone-content">
            <h2 id="zone-content-heading">{t("skillDetail.zones.content")}</h2>
            <div className="sh-skill-detail__block" id="description">
              <h3>{t("skillDetail.navigation.sections.description")}</h3>
              <MarkdownWorkspace
                facade={markdownFacade}
                skillId={skillId}
                skillRootPath={summaryQuery.data.rootPath}
              />
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
                  governanceNavigationState={(relation) => {
                    const ledgerRow = governanceLedgerQuery.data?.rows.find((row) =>
                      relationIdOf(row.relation) === relation.relationId &&
                      row.relation.fact.skill_id === skillId,
                    );
                    const targetIdentity = ledgerRow?.target_identity?.skill_id === skillId
                      ? ledgerRow.target_identity
                      : null;
                    return {
                      ...(libraryReturn ? { libraryReturn } : {}),
                      ...(governanceReturnTo ? { returnTo: governanceReturnTo } : {}),
                      targetIdentity,
                    };
                  }}
                  historyHref="/relationships/governance/history"
                  navigationState={libraryReturn ? { libraryReturn } : undefined}
                  onLoadRemovalImpact={loadRelationshipRemovalImpact}
                  onUndeploy={!isPreviewRoute ? (relation) => void startUndeploy(relation) : undefined}
                  relationship={relationshipViews}
                  relations={relationsQuery.data}
                  sourceEvents={sourceEvents}
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
              <div id="source"><SourceUpdatePanel facade={facade} skillId={skillId} /></div>
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
      {removalOutcome ? (
        <RemovalOutcomeResult
          continuing={removalLoading}
          onContinue={() => {
            setRemovalOutcome(null);
            void startRemoval();
          }}
          result={removalOutcome.result}
          targetLabels={removalOutcome.targetLabels}
        />
      ) : null}
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
