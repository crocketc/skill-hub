import { useTranslation } from "react-i18next";
import type { RefObject } from "react";
import type { RelationGovernanceRow } from "../../../api/bindings";
import { Button } from "../../../ui/Button";
import { StatusBadge } from "../../../ui/StatusBadge";
import {
  fingerprintLabelKey,
  relationshipLabelKey,
} from "../../relationshipGovernance/relationshipGovernance";
import { rowNeedsSharedImpactConfirmation } from "./api";
import { displayPath } from "../../../platform/displayPath";
import { AgentIdentity } from "../../skills/AgentDeploymentIcons";
import { AgentPresentation } from "../../../ui/AgentPresentation";

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
  onListScroll,
  onRevalidate,
  onToggleAll,
  onToggleRow,
  onUndeploy,
  rows,
  selectedIds,
}: GovernanceRelationTableProps) {
  const { t } = useTranslation();
  const allChecked = rows.length > 0 && rows.every((row) => selectedIds.has(row.relation.relation_id));

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
            const relationId = row.relation.relation_id;
            const busy = busyRelationIds.has(relationId);
            return (
              <tr data-testid="governance-row" key={relationId}>
                <td>
                  <input
                    aria-label={t("relationships.governance.table.selectRow", { id: relationId })}
                    checked={selectedIds.has(relationId)}
                    data-testid={`governance-select-${relationId}`}
                    onChange={(event) => onToggleRow(relationId, event.target.checked)}
                    type="checkbox"
                  />
                </td>
                <td>
                  <strong>
                    {row.skill_display_name ?? row.relation.skill_id
                      ?? t("relationshipGovernance.matrix.unknownSkill")}
                  </strong>
                  <StatusBadge tone="info">
                    {t(relationshipLabelKey(row.relation.relationship) as never)}
                  </StatusBadge>
                  <span className="sh-governance__readiness">
                    {t(`relationships.governance.readiness.${row.readiness}` as never)}
                  </span>
                </td>
                <td data-testid={`governance-source-${relationId}`}>
                  {t(`relationships.governance.source.${row.relation.origin}` as never)}
                </td>
                <td data-testid={`governance-target-${relationId}`}>
                  <AgentIdentity agentId={row.relation.agent_client_id} />
                  <code>{displayPath(row.relation.path)}</code>
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
                  <span>{t(fingerprintLabelKey(row.relation.match_state) as never)}</span>
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
  const disabled = busy || primary === "none";
  const onClick = () => {
    if (primary === "centralize_management") onCentralize(row);
    else if (primary === "undeploy") onUndeploy(row);
    else if (primary === "revalidate") onRevalidate(row);
  };
  return (
    <Button
      data-testid={`governance-action-${row.relation.relation_id}`}
      disabled={disabled}
      onClick={onClick}
      size="sm"
      variant={primary === "undeploy" ? "secondary" : "primary"}
    >
      {t(`relationships.governance.actions.${primary}` as never)}
    </Button>
  );
}
