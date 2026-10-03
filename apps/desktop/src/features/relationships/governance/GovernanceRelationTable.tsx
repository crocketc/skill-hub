import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { RefObject } from "react";
import type { RelationGovernanceRow } from "../../../api/bindings";
import {
  relationAgentIdOf,
  relationIdOf,
  relationPathOf,
  relationSourceKeyOf,
  relationVerificationKeyOf,
  relationshipKeyOf,
  isGovernanceActionAvailable,
  rowIsNaturallyExecutable,
  rowNeedsSharedImpactConfirmation,
} from "./api";
import { Button } from "../../../ui/Button";
import { StatusBadge } from "../../../ui/StatusBadge";
import {
  fingerprintLabelKey,
  relationshipLabelKey,
} from "../../relationshipGovernance/relationshipGovernance";
import { AgentIdentity } from "../../skills/AgentDeploymentIcons";
import { AgentPresentation, agentBrandKey } from "../../../ui/AgentPresentation";
import { brandDisplayName } from "../../../ui/BrandTag";
import { RelationshipPath } from "../RelationshipPath";
import { governanceReasonLabelKey, presentGovernanceRow } from "./governancePresenter";

export interface GovernanceRelationTableProps {
  rows: readonly RelationGovernanceRow[];
  selectedIds: ReadonlySet<string>;
  busyRelationIds: ReadonlySet<string>;
  /** 清单滚动容器引用：页面用它保存/恢复返回上下文中的滚动位置。 */
  listRef?: RefObject<HTMLDivElement>;
  /** 滚动事件透传：页面据此把滚动位置写进返回上下文。 */
  onListScroll?: () => void;
  onToggleRow: (relationId: string, checked: boolean) => void;
  onToggleAll: (checked: boolean) => void;
  onCentralize: (row: RelationGovernanceRow) => void;
  onUndeploy: (row: RelationGovernanceRow) => void;
  onRevokeRetention: (row: RelationGovernanceRow) => void;
  onEndRelationship: (row: RelationGovernanceRow) => void;
  onRevalidate: (row: RelationGovernanceRow) => void;
  /** 来源副本保留：账本写入，绝不触碰来源目录。 */
  onRetain: (row: RelationGovernanceRow) => void;
}

/**
 * 治理清单表（任务 8）：一行一条关系边（不按 Skill 合并），列固定为
 * 关系/来源/目标/影响/校验/操作；受阻行逐条给出确定性解释。
 * 选择框只是会话状态：同步浏览不写 tracker、通知或操作记录。
 */
export function GovernanceRelationTable({
  busyRelationIds,
  listRef,
  onCentralize,
  onEndRelationship,
  onListScroll,
  onRevalidate,
  onRetain,
  onRevokeRetention,
  onToggleAll,
  onToggleRow,
  onUndeploy,
  rows,
  selectedIds,
}: GovernanceRelationTableProps) {
  const { t } = useTranslation();
  const selectableRows = rows.filter(rowIsNaturallyExecutable);
  const allChecked = selectableRows.length > 0
    && selectableRows.every((row) => selectedIds.has(relationIdOf(row.relation)));

  return (
    <div
      className="sh-governance__list"
      data-testid="governance-row-list"
      onScroll={onListScroll}
      ref={listRef}
    >
      <table aria-label={t("relationships.governance.table.listLabel")} className="sh-governance__table">
        <thead>
          <tr>
            <th scope="col">
              <input
                aria-label={t("relationships.governance.table.selectAll")}
                checked={allChecked}
                data-testid="governance-select-all"
                disabled={selectableRows.length === 0}
                onChange={(event) => onToggleAll(event.target.checked)}
                type="checkbox"
              />
            </th>
            <th data-testid="governance-header-relation" scope="col">
              {t("relationships.governance.table.relation")}
            </th>
            <th data-testid="governance-header-source" scope="col">
              {t("relationships.governance.table.source")}
            </th>
            <th data-testid="governance-header-target" scope="col">
              {t("relationships.governance.table.target")}
            </th>
            <th data-testid="governance-header-impact" scope="col">
              {t("relationships.governance.table.impact")}
            </th>
            <th scope="col">{t("relationships.governance.table.verification")}</th>
            <th scope="col">{t("relationships.governance.table.action")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const relationId = relationIdOf(row.relation);
            const busy = busyRelationIds.has(relationId);
            return (
              <tr data-testid="governance-row" key={relationId}>
                <td>
                  <GovernanceRelationSelection
                    onToggleRow={onToggleRow}
                    row={row}
                    selected={selectedIds.has(relationId)}
                  />
                </td>
                <td><GovernanceRelationIdentity row={row} /></td>
                <td data-testid={`governance-source-${relationId}`}>
                  <GovernanceRelationSource row={row} />
                </td>
                <td data-testid={`governance-target-${relationId}`}>
                  <GovernanceRelationTarget row={row} />
                </td>
                <td data-testid={`governance-impact-${relationId}`}>
                  <GovernanceRelationImpact row={row} />
                </td>
                <td><GovernanceRelationVerification row={row} /></td>
                <td className="sh-governance__actions">
                  <GovernanceRelationActions
                    busy={busy}
                    onCentralize={onCentralize}
                    onEndRelationship={onEndRelationship}
                    onRevalidate={onRevalidate}
                    onRetain={onRetain}
                    onRevokeRetention={onRevokeRetention}
                    onUndeploy={onUndeploy}
                    row={row}
                  />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function governanceSkillDisplayName(row: RelationGovernanceRow, t: TFunction): string {
  const name = row.skill_display_name?.trim();
  return name || String(t("relationships.governance.unnamedSkill"));
}

export function GovernanceRelationSelection({
  onToggleRow,
  row,
  selected,
}: {
  onToggleRow: GovernanceRelationTableProps["onToggleRow"];
  row: RelationGovernanceRow;
  selected: boolean;
}) {
  const { t } = useTranslation();
  const relationId = relationIdOf(row.relation);
  const executable = rowIsNaturallyExecutable(row);
  return (
    <input
      aria-label={t("relationships.governance.table.selectRow", {
        name: governanceSkillDisplayName(row, t),
      })}
      checked={selected}
      data-testid={`governance-select-${relationId}`}
      disabled={!executable}
      onChange={(event) => onToggleRow(relationId, event.target.checked)}
      type="checkbox"
    />
  );
}

export function GovernanceRelationIdentity({ row }: { row: RelationGovernanceRow }) {
  const { t } = useTranslation();
  const relationId = relationIdOf(row.relation);
  const presentation = presentGovernanceRow(row);
  const managementMatchesSummary = (
    row.governance.management_status === "taken_over"
      && presentation.summaryKey === "relationships.governance.shortName.taken_over"
  ) || (
    row.governance.management_status === "not_taken_over"
      && presentation.summaryKey === "relationships.governance.shortName.not_taken_over"
  );
  const relationshipLabel = row.relation.kind === "source_copy"
    ? t("relationships.governance.scope.source_copy")
    : t(relationshipLabelKey(relationshipKeyOf(row.relation) as never) as never);
  return (
    <div className="sh-governance__identity">
      <strong
        aria-label={governanceSkillDisplayName(row, t)}
        tabIndex={0}
        title={governanceSkillDisplayName(row, t)}
      >
        {governanceSkillDisplayName(row, t)}
      </strong>
      <StatusBadge tone="info">
        {relationshipLabel}
      </StatusBadge>
      <StatusBadge tone={row.governance.governance_status === "completed" ? "success" : "warning"}>
        {t(presentation.classificationKey as never)}
      </StatusBadge>
      <StatusBadge tone={presentation.tone}>
        <span
          aria-describedby={`governance-description-${relationId}`}
          data-testid={`governance-short-name-${relationId}`}
          tabIndex={0}
          title={String(t(presentation.descriptionKey as never))}
        >
          {t(presentation.summaryKey as never)}
        </span>
      </StatusBadge>
      {!managementMatchesSummary ? (
        <StatusBadge tone="info">{t(presentation.managementKey as never)}</StatusBadge>
      ) : null}
      {presentation.decisionKey ? (
        <span className="sh-governance__decision">{t(presentation.decisionKey as never)}</span>
      ) : null}
      <p className="sh-visually-hidden" id={`governance-description-${relationId}`}>
        {t(presentation.descriptionKey as never)}
      </p>
    </div>
  );
}

export function GovernanceRelationTargetSummary({ row }: { row: RelationGovernanceRow }) {
  const { t } = useTranslation();
  const rowAgentId = relationAgentIdOf(row.relation);
  return (
    <div className="sh-governance__board-target-summary">
      <strong className="sh-governance__directory-kind">{directoryGovernanceLabel(row, t)}</strong>
      {row.relation.kind === "deployment" && rowAgentId ? (
        <AgentIdentity agentId={rowAgentId} />
      ) : null}
    </div>
  );
}

export function GovernanceRelationSource({ row }: { row: RelationGovernanceRow }) {
  const { t } = useTranslation();
  return <>{t(`relationships.governance.source.${relationSourceKeyOf(row.relation)}` as never)}</>;
}

export function GovernanceRelationTarget({ row }: { row: RelationGovernanceRow }) {
  const { t } = useTranslation();
  const rowAgentId = relationAgentIdOf(row.relation);
  return (
    <>
      <strong className="sh-governance__directory-kind">{directoryGovernanceLabel(row, t)}</strong>
      {/* 来源副本边没有 Agent 归属；部署边使用统一的品牌 + 用户视角类型 presenter。 */}
      {row.relation.kind === "deployment" && rowAgentId ? (
        <AgentIdentity agentId={rowAgentId} />
      ) : null}
      <span>{t("agents.pathLabel")} <RelationshipPath path={relationPathOf(row.relation)} /></span>
    </>
  );
}

export function GovernanceRelationImpact({ row }: { row: RelationGovernanceRow }) {
  const { t } = useTranslation();
  return (
    <>
      {row.impact.other_consumer_agent_ids.length > 0
        ? <>
            {t("relationships.governance.impact.otherConsumers", {
              agents: "",
              count: row.impact.other_consumer_agent_ids.length,
            })}
            {row.impact.other_consumer_agent_ids.map((agentId, index) => (
              <span key={agentId}>
                {index > 0 ? "、" : ""}
                <AgentPresentation agentId={agentId} />
              </span>
            ))}
          </>
        : t("relationships.governance.impact.noOtherConsumers")}
      <span>
        {row.impact.rollback_available
          ? t("relationships.governance.impact.rollbackAvailable")
          : t("relationships.governance.impact.rollbackUnavailable")}
      </span>
    </>
  );
}

export function GovernanceRelationVerification({ row }: { row: RelationGovernanceRow }) {
  return (
    <>
      <GovernanceRelationVerificationLabel row={row} />
      <GovernanceRelationBlockers row={row} />
    </>
  );
}

export function GovernanceRelationVerificationLabel({ row }: { row: RelationGovernanceRow }) {
  const { t } = useTranslation();
  return (
    <span>{t(fingerprintLabelKey(relationVerificationKeyOf(row.relation) as never) as never)}</span>
  );
}

export function GovernanceRelationBlockers({ row }: { row: RelationGovernanceRow }) {
  const { t } = useTranslation();
  const relationId = relationIdOf(row.relation);
  const reasons = presentGovernanceRow(row).reasonKeys;
  return reasons.length > 0 ? (
    <ul className="sh-governance__reason-list" data-testid={`governance-reasons-${relationId}`}>
      {reasons.map((reason) => (
        <li key={reason}>{t(governanceReasonLabelKey(reason) as never)}</li>
      ))}
    </ul>
  ) : null;
}

export function GovernanceRelationActions({
  busy,
  onCentralize,
  onEndRelationship,
  onRevalidate,
  onRetain,
  onRevokeRetention,
  onUndeploy,
  row,
}: {
  busy: boolean;
  onCentralize: GovernanceRelationTableProps["onCentralize"];
  onEndRelationship: GovernanceRelationTableProps["onEndRelationship"];
  onRevalidate: GovernanceRelationTableProps["onRevalidate"];
  onRetain: GovernanceRelationTableProps["onRetain"];
  onRevokeRetention: GovernanceRelationTableProps["onRevokeRetention"];
  onUndeploy: GovernanceRelationTableProps["onUndeploy"];
  row: RelationGovernanceRow;
}) {
  const { t } = useTranslation();
  const relationId = relationIdOf(row.relation);
  const actions = [
    {
      action: "centralize_management" as const,
      available: isGovernanceActionAvailable(row, "centralize_management")
        || rowNeedsSharedImpactConfirmation(row),
      onClick: () => onCentralize(row),
      variant: "primary" as const,
    },
    {
      action: "revalidate" as const,
      available: isGovernanceActionAvailable(row, "revalidate"),
      onClick: () => onRevalidate(row),
      variant: "secondary" as const,
    },
    {
      action: "keep_independent_copy" as const,
      available: isGovernanceActionAvailable(row, "keep_independent_copy"),
      onClick: () => onRetain(row),
      variant: "secondary" as const,
    },
    {
      action: "undeploy" as const,
      available: isGovernanceActionAvailable(row, "undeploy"),
      onClick: () => onUndeploy(row),
      variant: "secondary" as const,
    },
    {
      action: "revoke_retention" as const,
      available: isGovernanceActionAvailable(row, "revoke_retention"),
      onClick: () => onRevokeRetention(row),
      variant: "secondary" as const,
    },
    {
      action: "end_relationship" as const,
      available: isGovernanceActionAvailable(row, "end_relationship"),
      onClick: () => onEndRelationship(row),
      variant: "secondary" as const,
    },
  ].filter((item) => item.available);

  return (
    <>
      {actions.map(({ action, onClick, variant }, index) => (
        <Button
          data-action={action}
          data-testid={index === 0
            ? `governance-action-${relationId}`
            : `governance-action-${action}-${relationId}`}
          disabled={busy}
          key={action}
          onClick={onClick}
          size="sm"
          variant={variant}
        >
          {t(`relationships.governance.actions.${action}` as never)}
        </Button>
      ))}
    </>
  );
}
/**
 * 治理单位按同一物理目录上的消费者关系呈现：共享目录只操作一次；
 * 同品牌多端共用的目录也只操作一次；其余目录保持独立。内部 relation
 * 类型不进入用户界面。
 */
function directoryGovernanceLabel(
  row: RelationGovernanceRow,
  t: TFunction,
): string {
  if (
    row.relation.kind === "deployment"
    && (row.relation.fact.relationship === "shared_directory_read"
      || row.relation.fact.relationship === "shared_directory_reference")
  ) {
    return t("relationships.governance.directory.sharedAgent");
  }
  const consumers = [
    relationAgentIdOf(row.relation),
    ...row.impact.other_consumer_agent_ids,
  ].filter((agentId): agentId is string => agentId !== null);
  const brands = new Set(consumers.map(agentBrandKey));
  if (consumers.length > 1 && brands.size === 1) {
    return t("relationships.governance.directory.brandCommon", {
      brand: brandDisplayName(agentBrandKey(consumers[0])),
    });
  }
  return t("relationships.governance.directory.independent");
}
