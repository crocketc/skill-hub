import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { formatTimestamp, resolveLocale } from "../../../i18n";
import { displayPath } from "../../../platform/displayPath";
import { readableAgentIdName } from "../../skills/AgentDeploymentIcons";
import { AgentPresentation } from "../../../ui/AgentPresentation";
import type { RelationshipGraphFactCounts } from "../../../api/bindings";
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
  relationshipRevision: string;
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
    case "agent":
      return node.agent_client_id ? readableAgentIdName(node.agent_client_id) : fallback;
    case "directory":
      return node.path ? displayPath(node.path) : node.directory_node_id ?? fallback;
    case "conflict":
      return node.conflict_id ?? fallback;
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
      return node.path ? displayPath(node.path) : fallback;
    default:
      return fallback;
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
        <dt>{t("relationships.graph.detailsState")}</dt>
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
      <VerifiedLine lastVerifiedAt={edge.last_verified_at} />
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
  relationshipRevision,
  selectedEdgeId,
  selectedNodeId,
}: GraphDetailsPanelProps) {
  const { t } = useTranslation();
  const selectedEdge = selectedEdgeId
    ? projection.edges.find((projected) => projected.edge.edge_id === selectedEdgeId) ?? null
    : null;
  const selectedNodeEntry = selectedNodeId
    ? projection.nodes.find((projected) => projected.node.node_id === selectedNodeId) ?? null
    : null;
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
          {relationshipRevision ? (
            <details className="sh-graph-details__technical">
              <summary>{t("relationships.graph.technicalDetails")}</summary>
              {/* DEV-99：Skill ID 不进界面，技术详情只保留用户可读的修订号。 */}
              <dl>
                <div>
                  <dt>{t("relationships.graph.revisionLabel")}</dt>
                  <dd>{relationshipRevision}</dd>
                </div>
              </dl>
            </details>
          ) : null}
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
            to="/relationships/governance?from=graph"
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
          </>
        ) : selectedNodeEntry ? (
          <>
            <h3>
              {selectedNodeEntry.node.kind === "agent" && selectedNodeEntry.node.agent_client_id ? (
                <AgentPresentation agentId={selectedNodeEntry.node.agent_client_id} />
              ) : (
                nodeLabel(selectedNodeEntry.node, selectedNodeEntry.node.node_id, resolveSkillName)
              )}
            </h3>
            <p className="sh-graph-details__kind">
              {t(`relationships.graph.nodeKind.${selectedNodeEntry.node.kind}`)}
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
