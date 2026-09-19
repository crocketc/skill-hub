import { useTranslation } from "react-i18next";
import { Link } from "react-router-dom";
import type { RelationshipOverview, RemovalImpactFact } from "../../api/bindings";
import { StatusBadge } from "../../ui/StatusBadge";
import {
  buildAgentDirectoryViews,
  directoryRoleLabelKey,
  fileRepresentationLabelKey,
  fingerprintLabelKey,
  ownershipLabelKey,
  precedenceLabelKey,
  recognitionLabelKey,
  relationshipLabelKey,
  type AgentDirectoryView,
  type RelationshipView,
} from "../relationshipGovernance/relationshipGovernance";
import { RelationshipRemovalImpactView } from "../relationshipGovernance/RelationshipRemovalImpactView";
import { displayPath } from "../../platform/displayPath";

export interface DirectoryMatrixProps {
  overview?: RelationshipOverview;
  currentAgentClientId?: string;
  /** 提供时每个活动关系都有"查看移除影响"入口；入口只读取影响，不执行变更。 */
  onLoadRemovalImpact?: (relationId: string) => Promise<RemovalImpactFact>;
  /** 提供时每个关系行都有「管理关系」深链，指向治理页并携带来源与 relationId。 */
  governanceHref?: (relation: RelationshipView) => string;
}

function recognitionTone(recognition: AgentDirectoryView["recognition"]): "neutral" | "success" | "warning" {
  if (recognition === "supported") return "success";
  if (recognition === "unsupported") return "warning";
  return "neutral";
}

function DirectoryCard({
  currentAgentClientId,
  directory,
  governanceHref,
  onLoadRemovalImpact,
}: {
  currentAgentClientId?: string;
  directory: AgentDirectoryView;
  governanceHref?: DirectoryMatrixProps["governanceHref"];
  onLoadRemovalImpact?: DirectoryMatrixProps["onLoadRemovalImpact"];
}) {
  const { t } = useTranslation();
  return (
    <article className="sh-agent-directory-card" data-testid="directory-card">
      <header className="sh-agent-directory-card__header">
        <code>{displayPath(directory.path)}</code>
        <StatusBadge tone="info">{t(directoryRoleLabelKey(directory.role) as never)}</StatusBadge>
        <StatusBadge tone={recognitionTone(directory.recognition)}>
          {t(recognitionLabelKey(directory.recognition) as never)}
        </StatusBadge>
        {!directory.exists ? (
          <StatusBadge tone="warning">{t("relationshipGovernance.matrix.directoryMissing")}</StatusBadge>
        ) : null}
      </header>
      <p>{t("relationshipGovernance.matrix.skillCount", { count: directory.skillCount })}</p>
      <p>
        {directory.sharedConsumers.length > 0
          ? t("relationshipGovernance.matrix.sharedConsumers", {
              agents: directory.sharedConsumers.join(t("importWorkflow.governance.impact.agentSeparator") as never),
            })
          : t("relationshipGovernance.matrix.noSharedConsumers")}
      </p>
      {directory.precedence ? (
        <p>{t(precedenceLabelKey(directory.precedence) as never)}</p>
      ) : null}
      {directory.evidenceReference ? (
        <p>
          {t("relationshipGovernance.matrix.evidenceLabel", { evidence: directory.evidenceReference })}
          {directory.researchedAt
            ? ` ${t("relationshipGovernance.matrix.researchedLabel", { date: directory.researchedAt })}`
            : ""}
        </p>
      ) : null}
      {directory.relations.length > 0 ? (
        <ul className="sh-agent-directory-card__relations">
          {directory.relations.map((relation) => (
            <RelationRow
              currentAgentClientId={currentAgentClientId}
              governanceHref={governanceHref}
              key={relation.relationId}
              onLoadRemovalImpact={onLoadRemovalImpact}
              relation={relation}
            />
          ))}
        </ul>
      ) : null}
    </article>
  );
}

function RelationRow({
  currentAgentClientId,
  governanceHref,
  onLoadRemovalImpact,
  relation,
}: {
  currentAgentClientId?: string;
  governanceHref?: DirectoryMatrixProps["governanceHref"];
  onLoadRemovalImpact?: DirectoryMatrixProps["onLoadRemovalImpact"];
  relation: RelationshipView;
}) {
  const { t } = useTranslation();
  return (
    <li data-testid="directory-relation">
      <strong>{relation.skillId ?? t("relationshipGovernance.matrix.unknownSkill")}</strong>
      <StatusBadge tone={relation.active ? "neutral" : "info"}>
        {t(relationshipLabelKey(relation.relationship) as never)}
      </StatusBadge>
      {/* 其他 Agent 的关系必须显式标注归属，不混入当前 Agent 的矩阵语义。 */}
      {relation.targetAgentClientId !== currentAgentClientId ? (
        <span>
          {t("relationshipGovernance.matrix.ownerAgent", { agent: relation.targetAgentClientId })}
        </span>
      ) : null}
      {relation.pendingTaskIds.length > 0 ? (
        <span>
          {t("relationshipGovernance.matrix.pendingTaskCount", { count: relation.pendingTaskIds.length })}
        </span>
      ) : null}
      {!relation.active ? <span>{t("relationshipGovernance.matrix.inactive")}</span> : null}
      {relation.actions.includes("view_removal_impact") && onLoadRemovalImpact ? (
        <RelationshipRemovalImpactView
          loadImpact={() => onLoadRemovalImpact(relation.relationId)}
          triggerLabel={t("relationshipGovernance.matrix.viewRemovalImpact")}
        />
      ) : null}
      {governanceHref ? (
        <Link
          className="sh-governance__row-link"
          data-testid="governance-link"
          to={governanceHref(relation)}
        >
          {t("relationships.governance.manageRelations")}
        </Link>
      ) : null}
      <details>
        <summary>{t("relationshipGovernance.matrix.technicalSummary")}</summary>
        <p>{t(fileRepresentationLabelKey(relation.fileRepresentation) as never)}</p>
        <p>{t(ownershipLabelKey(relation.ownership) as never)}</p>
        <p>{t(fingerprintLabelKey(relation.fingerprintState) as never)}</p>
        {relation.linkTargetPath ? (
          <p>{t("relationshipGovernance.matrix.linkTarget", { path: relation.linkTargetPath })}</p>
        ) : null}
      </details>
    </li>
  );
}

/**
 * Task 7：Agent 页目录矩阵。
 * 只呈现确定性关系事实（目录角色、识别状态、Skill 数、共享消费者、关系标签），
 * 不推断"已加载/一定会调用"；符号链接等文件表示只进技术详情。
 */
export function DirectoryMatrix({
  currentAgentClientId,
  governanceHref,
  onLoadRemovalImpact,
  overview,
}: DirectoryMatrixProps) {
  const { t } = useTranslation();
  const directories = overview
    ? buildAgentDirectoryViews(overview, { currentAgentClientId })
    : [];

  return (
    <section aria-labelledby="agent-directory-matrix-title" className="sh-agent-directory-matrix">
      <div className="sh-agent-section-heading">
        <div>
          <p className="sh-agent-eyebrow">{t("relationshipGovernance.matrix.eyebrow")}</p>
          <h2 id="agent-directory-matrix-title">{t("relationshipGovernance.matrix.title")}</h2>
        </div>
      </div>
      <p>{t("relationshipGovernance.matrix.description")}</p>
      <p data-testid="directory-matrix-execution-note">
        {t("relationshipGovernance.matrix.executionNote")}
      </p>
      {!overview ? (
        <p data-testid="directory-matrix-empty" role="status">
          {t("relationshipGovernance.matrix.empty")}
        </p>
      ) : directories.length === 0 ? (
        <p data-testid="directory-matrix-empty" role="status">
          {t("relationshipGovernance.matrix.empty")}
        </p>
      ) : (
        directories.map((directory) => (
          <DirectoryCard
            currentAgentClientId={currentAgentClientId}
            directory={directory}
            governanceHref={governanceHref}
            key={directory.directoryNodeId}
            onLoadRemovalImpact={onLoadRemovalImpact}
          />
        ))
      )}
    </section>
  );
}
