import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import { formatTimestamp, resolveLocale } from "../../../i18n";
import { displayPath } from "../../../platform/displayPath";
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
  relationshipRevision: string;
  selectedEdgeId: string | null;
  selectedNodeId: string | null;
}

function nodeLabel(node: ProjectedNode["node"], fallback: string): string {
  switch (node.kind) {
    case "skill":
      return node.skill_id ?? fallback;
    case "agent":
      return node.agent_client_id ?? fallback;
    case "directory":
      return node.path ? displayPath(node.path) : node.directory_node_id ?? fallback;
    case "conflict":
      return node.conflict_id ?? fallback;
    case "source":
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
        <h2>{displayName ?? centerSkillId}</h2>
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
          <div>
            <dt>{t("relationships.graph.revisionLabel")}</dt>
            <dd>{relationshipRevision}</dd>
          </div>
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
              {selectedEdge.edge.relation_id ? (
                <div>
                  <dt>{t("relationships.graph.detailsRelationId")}</dt>
                  <dd>{selectedEdge.edge.relation_id}</dd>
                </div>
              ) : null}
            </dl>
            {selectedEdge.edge.relation_id ? (
              <Link
                className="sh-button sh-button--secondary sh-button--sm"
                to={`/relationships/governance?from=graph&relationId=${encodeURIComponent(selectedEdge.edge.relation_id)}`}
                onClick={onBeforeNavigate}
              >
                {t("relationships.graph.governRelation")}
              </Link>
            ) : null}
          </>
        ) : selectedNodeEntry ? (
          <>
            <h3>{nodeLabel(selectedNodeEntry.node, selectedNodeEntry.node.node_id)}</h3>
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
