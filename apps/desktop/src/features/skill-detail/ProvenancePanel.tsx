import { useTranslation } from "react-i18next";
import type {
  ConflictCaseFact,
  GovernanceTaskFact,
  SourceRelationFact,
} from "../../api/bindings";
import { StatusBadge } from "../../ui/StatusBadge";
import {
  conflictClassificationLabelKey,
  governanceTaskKindLabelKey,
  ownershipLabelKey,
  relationshipLabelKey,
} from "../relationshipGovernance/relationshipGovernance";
import type {
  SkillImportProvenance,
  SkillObservedDeployment,
} from "./api";

/** Task 7：Skill 维度关系概览中与"来源/治理"相关的确定性事实。 */
export interface ProvenanceRelationshipFacts {
  sources: SourceRelationFact[];
  conflicts: ConflictCaseFact[];
  pendingTasks: GovernanceTaskFact[];
}

export interface ProvenancePanelProps {
  provenance: SkillImportProvenance | null;
  observedDeployments: SkillObservedDeployment[];
  relationship?: ProvenanceRelationshipFacts;
}

/**
 * OPT-20260914-08：导入存证 + 已观察部署关系的最小展示。
 *
 * 只读呈现：存证回答"这个 Skill 从哪里来"（导入那一刻的不可变事实），
 * 已观察关系回答"哪些 Agent 目录里已经部署着它"。来源不明（无 Agent
 * 归属）显式标注"未识别"，绝不猜测；内容分叉/同名疑似只标注不冒充。
 *
 * Task 7：接入统一关系概览的多来源存证、冲突组与治理待办；所有标签
 * 来自确定性事实，不做"已合并/已解决"的虚假结论。
 */
export function ProvenancePanel({
  observedDeployments,
  provenance,
  relationship,
}: ProvenancePanelProps) {
  const { t } = useTranslation();
  const hasProvenance = provenance !== null;
  const hasRelations = observedDeployments.length > 0;
  const sources = relationship?.sources ?? [];
  const conflicts = relationship?.conflicts ?? [];
  const pendingTasks = relationship?.pendingTasks ?? [];
  return (
    <div className="sh-detail-provenance" data-testid="provenance-panel">
      {hasProvenance ? (
        <section data-testid="import-provenance">
          <p>
            <strong>{t("skillDetail.provenance.source")}</strong>{" "}
            {t(`skillDetail.provenance.sourceKinds.${provenance.sourceKind}`, {
              defaultValue: provenance.sourceKind,
            })}
            <span>{provenance.sourceLocator}</span>
          </p>
          <p>
            <strong>{t("skillDetail.provenance.agent")}</strong>{" "}
            {provenance.agentClientId ??
              t("skillDetail.provenance.unknownAgent")}
          </p>
          <p>
            <strong>{t("skillDetail.provenance.originalPath")}</strong>{" "}
            <span>{provenance.originalPath}</span>
          </p>
          <p>
            <strong>{t("skillDetail.provenance.importedAt")}</strong>{" "}
            {provenance.importedAt}
          </p>
          <p>
            <strong>{t("skillDetail.provenance.fingerprint")}</strong>{" "}
            <span>{provenance.contentFingerprint}</span>
          </p>
          <p>
            <strong>{t("skillDetail.provenance.ownership")}</strong>{" "}
            {t(`skillDetail.provenance.ownerships.${provenance.ownership}`, {
              defaultValue: provenance.ownership,
            })}
          </p>
        </section>
      ) : (
        <p data-testid="provenance-absent">
          {t("skillDetail.provenance.absent")}
        </p>
      )}
      {hasRelations ? (
        <ul data-testid="observed-deployments">
          {observedDeployments.map((relation) => (
            <li key={relation.id} data-testid="observed-deployment">
              <span>{relation.originalPath}</span>
              <span>{relation.clientId}</span>
              <StatusBadge
                tone={relation.matchState === "content_verified" ? "success" : "neutral"}
              >
                {t(`skillDetail.provenance.matchStates.${relation.matchState}`)}
              </StatusBadge>
              <StatusBadge tone={relation.status === "active" ? "success" : "neutral"}>
                {t(`skillDetail.provenance.statuses.${relation.status}`)}
              </StatusBadge>
            </li>
          ))}
        </ul>
      ) : (
        <p data-testid="observed-absent">
          {t("skillDetail.provenance.noObservedDeployments")}
        </p>
      )}
      {relationship ? (
        <>
          <section data-testid="provenance-sources">
            <p><strong>{t("skillDetail.provenance.sources.heading")}</strong></p>
            {sources.length === 0 ? (
              <p>{t("skillDetail.provenance.sources.empty")}</p>
            ) : (
              <ul>
                {sources.map((source) => (
                  <li data-testid="provenance-source" key={source.provenance_id}>
                    <span>{source.source_path}</span>
                    <StatusBadge tone="info">
                      {t(relationshipLabelKey(source.relationship) as never)}
                    </StatusBadge>
                    <span>{t(ownershipLabelKey(source.ownership) as never)}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section data-testid="provenance-conflicts">
            <p><strong>{t("skillDetail.provenance.conflicts.heading")}</strong></p>
            {conflicts.length === 0 && pendingTasks.length === 0 ? (
              <p>{t("skillDetail.provenance.conflicts.empty")}</p>
            ) : (
              <>
                {conflicts.map((conflict) => {
                  const memberPaths = (conflict.members ?? [])
                    .map((member) => member.path)
                    .filter((path): path is string => Boolean(path));
                  return (
                    <p data-testid="provenance-conflict" key={conflict.conflict_id}>
                      <StatusBadge tone="warning">
                        {t(conflictClassificationLabelKey(conflict.classification) as never)}
                      </StatusBadge>
                      {memberPaths.length > 0 ? (
                        <span>
                          {t("skillDetail.provenance.conflicts.memberPaths", {
                            paths: memberPaths.join("、"),
                          })}
                        </span>
                      ) : null}
                    </p>
                  );
                })}
                {pendingTasks.map((task) => (
                  <p data-testid="provenance-task" key={task.task_id}>
                    <StatusBadge tone="neutral">
                      {t(governanceTaskKindLabelKey(task.kind) as never)}
                    </StatusBadge>
                    <span>{task.detail}</span>
                  </p>
                ))}
              </>
            )}
          </section>
        </>
      ) : null}
    </div>
  );
}
