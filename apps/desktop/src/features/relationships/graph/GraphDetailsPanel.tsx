import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { formatTimestamp, resolveLocale } from "../../../i18n";
import { AgentPresentation } from "../../../ui/AgentPresentation";
import type { RelationshipGraphFactCounts } from "../../../api/bindings";
import { governanceStateReasonKeys } from "../governance/api";
import { governanceReasonLabelKey, presentGovernanceState } from "../governance/governancePresenter";
import { RelationshipPath } from "../RelationshipPath";
import { presentRelationshipPath } from "../pathPresentation";
import {
  edgeStatusLabelKey,
  edgeTypeLabelKey,
  type GraphProjection,
  type ProjectedEdge,
  type ProjectedNode,
} from "./graphProjection";


export interface GraphDetailsPanelProps {
  centerSkillId: string;
  displayName: string | null;
  factCounts: RelationshipGraphFactCounts;
  lastVerifiedAt: string | null;
  /** 外链点击前保存图谱返回状态（视口/筛选已由 URL 承载）。 */
  onBeforeNavigate: () => void;
  projection: GraphProjection;
  /** Resolve internal Skill ids to the current user-facing display name. */
  resolveSkillName?: (skillId: string) => string | undefined;
  selectedEdgeId: string | null;
  selectedNodeId: string | null;
}

function nodeLabel(
  node: ProjectedNode["node"],
  fallback: string,
  resolveSkillName?: (skillId: string) => string | undefined,
): string {
  switch (node.kind) {
    case "skill":
      return node.skill_id ? resolveSkillName?.(node.skill_id) ?? fallback : fallback;
    case "directory":
      return node.path ? presentRelationshipPath(node.path).label : fallback;
    case "conflict":
      return fallback;
    case "source":
      // 任务 12B：在线来源展示用户可读 URL，不暴露缓存路径；本地来源展示路径。
      if (node.source) {
        const locator = node.source.locator as {
          local_path?: string;
          https_url?: string;
          git_url?: string;
        };
        if (locator.https_url) return locator.https_url;
        if (locator.git_url) return locator.git_url;
      }
      return node.path ? presentRelationshipPath(node.path).label : fallback;
    default:
      return fallback;
  }
}

function localNodePath(node: ProjectedNode["node"]): string | null {
  if (node.kind === "directory") return node.path;
  if (node.kind !== "source") return null;
  const locator = node.source?.locator as { https_url?: string; git_url?: string } | undefined;
  return locator?.https_url || locator?.git_url ? null : node.path;
}

function nodeKindLabel(node: ProjectedNode["node"], t: (key: string) => string): string {
  if (node.kind === "directory" && node.role === "shared_directory") {
    return t("agents.kind.sharedDirectory");
  }
  switch (node.kind) {
    case "skill":
    case "agent":
    case "project":
    case "directory":
    case "source":
    case "conflict":
    case "collapsed":
      return t(`relationships.graph.nodeKind.${node.kind}`);
    default:
      return t("relationships.graph.nodeKind.unknown");
  }
}

function VerifiedLine({ lastVerifiedAt }: { lastVerifiedAt: string | null }) {
  const { t, i18n } = useTranslation();
  const locale = resolveLocale([i18n.resolvedLanguage ?? i18n.language]);
  return (
    <div>
      <dt>{t("relationships.graph.lastVerifiedLabel")}</dt>
      {/* DEV-15：unix 秒/毫秒时间戳一并格式化为可读本地时间。 */}
      <dd>
        {lastVerifiedAt
          ? t("relationships.graph.lastVerified", { time: formatTimestamp(lastVerifiedAt, locale) })
          : t("relationships.graph.neverVerified")}
      </dd>
    </div>
  );
}

function EdgeFacts({ projected }: { projected: ProjectedEdge }) {
  const { t } = useTranslation();
  const { edge } = projected;
  return (
    <>
      <div>
        <dt>{t("relationships.graph.detailsRelationship")}</dt>
        <dd>{t(edgeTypeLabelKey(edge))}</dd>
      </div>
      <div>
        <dt>{t("relationships.graph.detailsHealth")}</dt>
        <dd>
          {t(edgeStatusLabelKey(edge))}
          {edge.active === false ? (
            <strong className="sh-graph-badge sh-graph-badge--danger">
              {t("relationships.graph.inaccessible")}
            </strong>
          ) : null}
          {projected.state === "unverified" ? (
            <strong className="sh-graph-badge sh-graph-badge--warning">
              {t("relationships.graph.needsValidation")}
            </strong>
          ) : null}
        </dd>
      </div>
      {edge.governance ? <GraphGovernanceFacts governance={edge.governance} edgeId={edge.edge_id} /> : null}
      <VerifiedLine lastVerifiedAt={edge.last_verified_at} />
    </>
  );
}

function GraphGovernanceFacts({
  edgeId,
  governance,
}: {
  edgeId: string;
  governance: NonNullable<ProjectedEdge["edge"]["governance"]>;
}) {
  const { t } = useTranslation();
  const presentation = presentGovernanceState(governance, governanceStateReasonKeys(governance));
  const descriptionId = `graph-governance-description-${edgeId}`;
  return (
    <>
      <div data-testid="graph-governance-classification">
        <dt>{t("relationships.graph.governanceClassification")}</dt>
        <dd>{t(presentation.classificationKey as never)}</dd>
      </div>
      <div data-testid="graph-governance-management">
        <dt>{t("relationships.graph.governanceManagement")}</dt>
        <dd>{t(presentation.managementKey as never)}</dd>
      </div>
      <div>
        <dt>{t("relationships.graph.governanceSummary")}</dt>
        <dd>
          <span
            aria-describedby={descriptionId}
            data-testid="graph-governance-summary"
            tabIndex={0}
            title={String(t(presentation.descriptionKey as never))}
          >
            {t(presentation.summaryKey as never)}
          </span>
          <p className="sh-visually-hidden sh-graph-details__governance-description" id={descriptionId}>
            {t(presentation.descriptionKey as never)}
          </p>
        </dd>
      </div>
      {presentation.decisionKey ? (
        <div>
          <dt>{t("relationships.graph.governanceDecision")}</dt>
          <dd>{t(presentation.decisionKey as never)}</dd>
        </div>
      ) : null}
      {presentation.reasonKeys.length > 0 ? (
        <div data-testid="graph-governance-reasons">
          <dt>{t("relationships.graph.governanceReasons")}</dt>
          <dd>
            <ul className="sh-graph-details__governance-reasons">
              {presentation.reasonKeys.map((reason) => (
                <li key={reason}>{t(governanceReasonLabelKey(reason) as never)}</li>
              ))}
            </ul>
          </dd>
        </div>
      ) : null}
    </>
  );
}

/**
 * 右侧详情面板（任务 6）：中心 Skill 常驻；选中的节点/边展示
 * 关系、状态、最后验证与不可访问/待校验标注。
 */
export function GraphDetailsPanel({
  centerSkillId,
  displayName,
  factCounts,
  lastVerifiedAt,
  onBeforeNavigate,
  projection,
  resolveSkillName,
  selectedEdgeId,
  selectedNodeId,
}: GraphDetailsPanelProps) {
  const { t } = useTranslation();
  const translateGraphKind = (key: string) => String(t(key as never));
  const selectedEdge = selectedEdgeId
    ? projection.edges.find((projected) => projected.edge.edge_id === selectedEdgeId) ?? null
    : null;
  const selectedNodeEntry = selectedNodeId
    ? projection.nodes.find((projected) => projected.node.node_id === selectedNodeId) ?? null
    : null;
  const selectedNodePath = selectedNodeEntry ? localNodePath(selectedNodeEntry.node) : null;
  const selectedNodeLabel = selectedNodeEntry
    ? nodeLabel(
        selectedNodeEntry.node,
        nodeKindLabel(selectedNodeEntry.node, translateGraphKind),
        resolveSkillName,
      )
    : "";
  const selectedNodeEdge: ProjectedEdge | null = (() => {
    if (!selectedNodeEntry || selectedNodeEntry.layer === "center") return null;
    const nodeId = selectedNodeEntry.node.node_id;
    return projection.edges.find((projected) =>
      projected.edge.from_node_id === nodeId || projected.edge.to_node_id === nodeId,
    ) ?? null;
  })();

  return (
    <aside className="sh-graph-details" aria-label={t("relationships.graph.detailsLabel")}>
      <section className="sh-graph-details__center">
        <h2>{displayName ?? t("relationships.graph.unknownSkill")}</h2>
        <dl>
          <div>
            <dt>{t("relationships.graph.detailsFacts")}</dt>
            <dd>
              {t("relationships.graph.centerFacts", {
                deployments: factCounts.deployment_relations,
                sources: factCounts.source_relations,
                conflicts: factCounts.conflict_cases,
              })}
            </dd>
          </div>
          <VerifiedLine lastVerifiedAt={lastVerifiedAt} />
        </dl>
        <div className="sh-graph-details__actions">
          <Link
            className="sh-button sh-button--secondary sh-button--sm"
            to={`/library/${centerSkillId}?from=relationships`}
            onClick={onBeforeNavigate}
          >
            {t("relationships.graph.viewSkill")}
          </Link>
          <Link
            className="sh-button sh-button--secondary sh-button--sm"
            to={`/relationships/governance?from=graph&skillId=${encodeURIComponent(centerSkillId)}`}
            onClick={onBeforeNavigate}
          >
            {t("relationships.graph.goToGovernance")}
          </Link>
        </div>
      </section>
      <section className="sh-graph-details__selection">
        {selectedEdge ? (
          <>
            <h3>{t(edgeTypeLabelKey(selectedEdge.edge))}</h3>
            <dl>
              <EdgeFacts projected={selectedEdge} />
              {/*
                DEV-99：治理关系 id 不进界面（含技术详情折叠区）；需要技术
                对账时经「去治理」深链跳转，id 只存在于路由参数中。
              */}
            </dl>
            {/*
              任务 12.12：只有可管理（当前来源副本/部署 relation 存在）才给
              治理入口；纯 provenance 事实只提供来源详情，不给治理按钮。
            */}
            {selectedEdge.governanceRelationId ? (
              <Link
                className="sh-button sh-button--secondary sh-button--sm"
                to={`/relationships/governance?from=graph&relationId=${encodeURIComponent(selectedEdge.governanceRelationId)}`}
                onClick={onBeforeNavigate}
              >
                {t("relationships.graph.governRelation")}
              </Link>
            ) : null}
            {selectedEdge.edge.kind === "source" ? (
              <Link
                className="sh-button sh-button--secondary sh-button--sm"
                to={`/library/${encodeURIComponent(centerSkillId)}#review-versions`}
                onClick={onBeforeNavigate}
              >
                {t("relationships.graph.openSourceLifecycle")}
              </Link>
            ) : null}
          </>
        ) : selectedNodeEntry ? (
          <>
            <h3>
              {selectedNodeEntry.node.kind === "agent" && selectedNodeEntry.node.agent_client_id ? (
                <AgentPresentation agentId={selectedNodeEntry.node.agent_client_id} />
              ) : selectedNodePath ? (
                <RelationshipPath path={selectedNodePath} />
              ) : (
                <span
                  aria-label={selectedNodeLabel}
                  className="sh-graph-details__node-label"
                  tabIndex={0}
                  title={selectedNodeLabel}
                >
                  {selectedNodeLabel}
                </span>
              )}
            </h3>
            <p className="sh-graph-details__kind">
              {nodeKindLabel(selectedNodeEntry.node, translateGraphKind)}
            </p>
            {selectedNodeEdge ? (
              <dl>
                <EdgeFacts projected={selectedNodeEdge} />
              </dl>
            ) : (
              <dl>
                <VerifiedLine lastVerifiedAt={selectedNodeEntry.node.last_verified_at} />
              </dl>
            )}
            <div className="sh-graph-details__actions">
              {selectedNodeEntry.node.kind === "skill" && selectedNodeEntry.node.skill_id ? (
                <Link
                  className="sh-button sh-button--secondary sh-button--sm"
                  to={`/library/${selectedNodeEntry.node.skill_id}?from=relationships`}
                  onClick={onBeforeNavigate}
                >
                  {t("relationships.graph.viewSkill")}
                </Link>
              ) : null}
              {selectedNodeEntry.node.kind === "source" ? (
                <Link
                  className="sh-button sh-button--secondary sh-button--sm"
                  to={`/library/${encodeURIComponent(centerSkillId)}#review-versions`}
                  onClick={onBeforeNavigate}
                >
                  {t("relationships.graph.openSourceLifecycle")}
                </Link>
              ) : null}
              {selectedNodeEntry.node.kind === "conflict" && selectedNodeEntry.node.conflict_id ? (
                <Link
                  className="sh-button sh-button--secondary sh-button--sm"
                  to={`/relationships/decisions?from=relationships&conflictId=${encodeURIComponent(selectedNodeEntry.node.conflict_id)}`}
                  onClick={onBeforeNavigate}
                >
                  {t("relationships.graph.goToDecisions")}
                </Link>
              ) : null}
            </div>
          </>
        ) : (
          <p>{t("relationships.graph.selectHint")}</p>
        )}
      </section>
    </aside>
  );
}
