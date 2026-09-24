import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { RefObject } from "react";
import type { RelationGovernanceRow } from "../../../api/bindings";
import {
  relationAgentIdOf,
  relationIdOf,
  relationPathOf,
  relationSkillIdOf,
  relationSourceKeyOf,
  relationVerificationKeyOf,
  relationshipKeyOf,
  sourceCopyCleanAvailability,
  sourceCopyRetainAvailability,
} from "./api";
import { Button } from "../../../ui/Button";
import { StatusBadge } from "../../../ui/StatusBadge";
import {
  fingerprintLabelKey,
  relationshipLabelKey,
} from "../../relationshipGovernance/relationshipGovernance";
import { rowNeedsSharedImpactConfirmation } from "./api";
import { displayPath } from "../../../platform/displayPath";
import { AgentIdentity } from "../../skills/AgentDeploymentIcons";
import { AgentPresentation, agentBrandKey } from "../../../ui/AgentPresentation";
import { brandDisplayName } from "../../../ui/BrandTag";

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
  onRevalidate: (row: RelationGovernanceRow) => void;
  /** 来源副本清理（任务 11.7）：打开影响预览，经确认后走 clean 批次。 */
  onClean: (row: RelationGovernanceRow) => void;
  /** 来源副本保留：账本写入，绝不触碰来源目录。 */
  onRetain: (row: RelationGovernanceRow) => void;
}

type PrimaryAction = RelationGovernanceRow["primary_action"];

/**
 * 治理清单表（任务 8）：一行一条关系边（不按 Skill 合并），列固定为
 * 关系/来源/目标/影响/校验/操作；受阻行逐条给出确定性解释。
 * 选择框只是会话状态：同步浏览不写 tracker、通知或操作记录。
 */
export function GovernanceRelationTable({
  busyRelationIds,
  listRef,
  onCentralize,
  onClean,
  onListScroll,
  onRevalidate,
  onRetain,
  onToggleAll,
  onToggleRow,
  onUndeploy,
  rows,
  selectedIds,
}: GovernanceRelationTableProps) {
  const { t } = useTranslation();
  const allChecked = rows.length > 0 && rows.every((row) => selectedIds.has(relationIdOf(row.relation)));

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
            const rowAgentId = relationAgentIdOf(row.relation);
            const busy = busyRelationIds.has(relationId);
            return (
              <tr data-testid="governance-row" key={relationId}>
                <td>
                  <input
                    aria-label={t("relationships.governance.table.selectRow", {
                    name: row.skill_display_name ?? relationSkillIdOf(row.relation) ?? relationId,
                  })}
                    checked={selectedIds.has(relationId)}
                    data-testid={`governance-select-${relationId}`}
                    onChange={(event) => onToggleRow(relationId, event.target.checked)}
                    type="checkbox"
                  />
                </td>
                <td>
                  <strong>
                    {row.skill_display_name ?? relationSkillIdOf(row.relation)
                      ?? t("relationshipGovernance.matrix.unknownSkill")}
                  </strong>
                  <StatusBadge tone="info">
                    {t(relationshipLabelKey(relationshipKeyOf(row.relation) as never) as never)}
                  </StatusBadge>
                  <span className="sh-governance__readiness">
                    {t(`relationships.governance.readiness.${row.readiness}` as never)}
                  </span>
                </td>
                <td data-testid={`governance-source-${relationId}`}>
                  {t(`relationships.governance.source.${relationSourceKeyOf(row.relation)}` as never)}
                </td>
                <td data-testid={`governance-target-${relationId}`}>
                  <strong className="sh-governance__directory-kind">
                    {directoryGovernanceLabel(row, t)}
                  </strong>
                  {/* 来源副本边没有 Agent 归属，仅部署边呈现 Agent 身份。 */}
                  {row.relation.kind === "deployment" && rowAgentId ? (
                    <AgentIdentity agentId={rowAgentId} />
                  ) : null}
                  <span>{t("agents.pathLabel")} <code>{displayPath(relationPathOf(row.relation))}</code></span>
                </td>
                <td data-testid={`governance-impact-${relationId}`}>
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
                </td>
                <td>
                  <span>{t(fingerprintLabelKey(relationVerificationKeyOf(row.relation) as never) as never)}</span>
                  {row.blockers.length > 0 ? (
                    <ul
                      className="sh-governance__blockers"
                      data-testid={`governance-blockers-${relationId}`}
                    >
                      {row.blockers.map((blocker) => (
                        <li key={blocker}>
                          {t(`relationships.governance.blockers.${blocker}` as never)}
                        </li>
                      ))}
                    </ul>
                  ) : null}
                </td>
                <td className="sh-governance__actions">
                  <PrimaryActionButton
                    busy={busy}
                    onCentralize={onCentralize}
                    onRevalidate={onRevalidate}
                    onUndeploy={onUndeploy}
                    primary={row.primary_action}
                    row={row}
                  />
                  {sourceCopyActionButtons(row, busy, onClean, onRetain)}
                  {/* 仅待共享影响确认的行：主操作是重新检查，另给带确认的纳入入口。 */}
                  {rowNeedsSharedImpactConfirmation(row) ? (
                    <Button
                      data-testid={`governance-centralize-${relationId}`}
                      disabled={busy}
                      onClick={() => onCentralize(row)}
                      size="sm"
                      variant="secondary"
                    >
                      {t("relationships.governance.actions.centralize_management")}
                    </Button>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
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

function PrimaryActionButton({
  busy,
  onCentralize,
  onRevalidate,
  onUndeploy,
  primary,
  row,
}: {
  busy: boolean;
  onCentralize: GovernanceRelationTableProps["onCentralize"];
  onRevalidate: GovernanceRelationTableProps["onRevalidate"];
  onUndeploy: GovernanceRelationTableProps["onUndeploy"];
  primary: PrimaryAction;
  row: RelationGovernanceRow;
}) {
  const { t } = useTranslation();
  // 来源副本的保留动作由专属按钮承载（任务 11.7）；后端给的
  // keep_independent_copy/none 主操作不再重复出按钮。
  const superseded = row.relation.kind === "source_copy"
    && (primary === "keep_independent_copy" || primary === "none");
  if (superseded) return null;
  const disabled = busy || primary === "none";
  const onClick = () => {
    if (primary === "centralize_management") onCentralize(row);
    else if (primary === "undeploy") onUndeploy(row);
    else if (primary === "revalidate") onRevalidate(row);
  };
  return (
    <Button
      data-testid={`governance-action-${relationIdOf(row.relation)}`}
      disabled={disabled}
      onClick={onClick}
      size="sm"
      variant={primary === "undeploy" ? "secondary" : "primary"}
    >
      {t(`relationships.governance.actions.${primary}` as never)}
    </Button>
  );
}

/**
 * 来源副本行专属动作（任务 11.7）：清理（pending/retained）与保留（仅
 * pending）。可用性由统一的行 DTO 推导：受阻隐藏、待校验禁用。
 */
function sourceCopyActionButtons(
  row: RelationGovernanceRow,
  busy: boolean,
  onClean: (row: RelationGovernanceRow) => void,
  onRetain: (row: RelationGovernanceRow) => void,
) {
  const { t } = useTranslation();
  const relationId = relationIdOf(row.relation);
  const clean = sourceCopyCleanAvailability(row);
  const retain = sourceCopyRetainAvailability(row);
  const title = clean === "disabled"
    ? t("relationships.governance.clean.needsValidationHint")
    : undefined;
  return (
    <>
      {clean !== "hidden" ? (
        <Button
          data-testid={`governance-clean-${relationId}`}
          disabled={busy || clean === "disabled"}
          onClick={() => onClean(row)}
          size="sm"
          title={title}
          variant="secondary"
        >
          {t("relationships.governance.clean.action")}
        </Button>
      ) : null}
      {retain !== "hidden" ? (
        <Button
          data-testid={`governance-retain-${relationId}`}
          disabled={busy || retain === "disabled"}
          onClick={() => onRetain(row)}
          size="sm"
          title={title}
          variant="secondary"
        >
          {t("relationships.governance.retain.action")}
        </Button>
      ) : null}
    </>
  );
}
