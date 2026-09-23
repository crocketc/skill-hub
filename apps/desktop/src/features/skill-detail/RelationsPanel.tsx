import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import type { RemovalImpactFact } from "../../api/bindings";
import { Button } from "../../ui/Button";
import { StatusBadge } from "../../ui/StatusBadge";
import { AgentPresentation } from "../../ui/AgentPresentation";
import { RelationshipRemovalImpactView } from "../relationshipGovernance/RelationshipRemovalImpactView";
import {
  fingerprintLabelKey,
  ownershipLabelKey,
  relationshipLabelKey,
  type RelationshipView,
  type SkillRelationshipViews,
} from "../relationshipGovernance/relationshipGovernance";
import type { SkillRelation } from "./api";

export interface RelationsPanelProps {
  relations: SkillRelation[];
  onUndeploy?: (relation: SkillRelation) => void;
  /** Task 7：统一关系概览中的部署关系事实；提供时补充关系类型与移除影响入口。 */
  relationship?: SkillRelationshipViews;
  /** 只读加载移除影响；变更仍由用户在既有部署/移除流程中确认执行。 */
  onLoadRemovalImpact?: (relationId: string) => Promise<RemovalImpactFact>;
  /** 提供时每条治理关系行都有「管理关系」深链，指向治理页并携带 relationId。 */
  governanceHref?: (relation: RelationshipView) => string;
}

export function RelationsPanel({
  governanceHref,
  onLoadRemovalImpact,
  onUndeploy,
  relations,
  relationship,
}: RelationsPanelProps) {
  const { t } = useTranslation();
  const groups = new Map<string, SkillRelation[]>();
  for (const relation of relations) {
    groups.set(relation.physicalTarget, [...(groups.get(relation.physicalTarget) ?? []), relation]);
  }
  return (
    <div className="sh-detail-relations">
      {[...groups.entries()].map(([physicalTarget, items]) => (
        <section key={physicalTarget}>
          <p data-testid="physical-target">
            <strong>{t("skillDetail.relations.physicalTarget")}</strong> {physicalTarget}
          </p>
          <ul>
            {items.map((relation) => (
              <li data-testid="logical-target" key={relation.id}>
                {relation.kind === "agent" && relation.agentClientId ? (
                  <AgentPresentation agentId={relation.agentClientId} brand={relation.agentProfileId} sharedDirectory={relation.sharedDirectory} />
                ) : <strong>{relation.label}</strong>}
                <span>{relation.logicalTarget}</span>
                <span>{relation.version}</span>
                {relation.pinned ? <span>{t("skillDetail.relations.pinned")}</span> : null}
                {onUndeploy ? (
                  <Button
                    aria-label={t("skillDetail.relations.undeployTarget", { target: relation.label })}
                    onClick={() => onUndeploy(relation)}
                    size="sm"
                    variant="secondary"
                  >
                    {t("skillDetail.relations.undeploy")}
                  </Button>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ))}
      {relationship ? (
        <section data-testid="governed-relations">
          <p><strong>{t("skillDetail.relations.governed.heading")}</strong></p>
          <p>{t("skillDetail.relations.governed.description")}</p>
          {relationship.deployments.length === 0 ? (
            <p>{t("skillDetail.relations.governed.empty")}</p>
          ) : (
            <ul>
              {relationship.deployments.map((row) => (
                <li data-testid="governed-relation" key={row.relationId}>
                  <strong>{row.skillId ?? t("relationshipGovernance.matrix.unknownSkill")}</strong>
                  <StatusBadge tone="info">
                    {t(relationshipLabelKey(row.relationship) as never)}
                  </StatusBadge>
                  <span>{t(ownershipLabelKey(row.ownership) as never)}</span>
                  <span>{t(fingerprintLabelKey(row.fingerprintState) as never)}</span>
                  <span>
                    {t("skillDetail.relations.governed.sharedAgent", { agent: "" })}
                    <AgentPresentation agentId={row.targetAgentClientId} />
                  </span>
                  {!row.active ? (
                    <StatusBadge tone="neutral">{t("relationshipGovernance.matrix.inactive")}</StatusBadge>
                  ) : null}
                  {row.actions.includes("view_removal_impact") && onLoadRemovalImpact ? (
                    <RelationshipRemovalImpactView
                      loadImpact={() => onLoadRemovalImpact(row.relationId)}
                      triggerLabel={t("relationshipGovernance.matrix.viewRemovalImpact")}
                    />
                  ) : null}
                  {governanceHref ? (
                    <Link
                      className="sh-governance__row-link"
                      data-testid="governance-link"
                      to={governanceHref(row)}
                    >
                      {t("relationships.governance.manageRelations")}
                    </Link>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>
      ) : null}
    </div>
  );
}
