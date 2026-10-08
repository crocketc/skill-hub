import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import type { RefObject } from "react";
import type { RelationGovernanceRow } from "../../../api/bindings";
import { Button } from "../../../ui/Button";
import { StatusBadge } from "../../../ui/StatusBadge";
import { AgentIdentity } from "../../skills/AgentDeploymentIcons";
import { AgentPresentation } from "../../../ui/AgentPresentation";
import { RelationshipPath } from "../RelationshipPath";
import {
  classifyUsageRelation,
  usageGovernanceActionRelationId,
  directoryRoleLabelKey,
  usageGovernanceRowId,
  usageGovernanceRowIsSelectable,
  type UsageGovernanceRow,
} from "../../relationshipGovernance/relationshipGovernance";
import {
  isGovernanceActionAvailable,
  relationIdOf,
  relationPathOf,
  rowNeedsSharedImpactConfirmation,
} from "./api";
import {
  presentGovernanceRow,
  usageHealthLabelKey,
} from "./governancePresenter";

export interface GovernanceRelationTableProps {
  rows: readonly UsageGovernanceRow[];
  selectedIds: ReadonlySet<string>;
  busyRelationIds: ReadonlySet<string>;
  listRef?: RefObject<HTMLDivElement>;
  onListScroll?: () => void;
  onToggleRow: (relationId: string, checked: boolean) => void;
  onToggleAll: (checked: boolean) => void;
  onCentralize: (row: RelationGovernanceRow) => void;
  onUndeploy: (row: RelationGovernanceRow) => void;
  onRevalidate: (row: RelationGovernanceRow) => void;
}

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
  const selectableRows = rows.filter(usageGovernanceRowIsSelectable);
  const allChecked = selectableRows.length > 0
    && selectableRows.every((row) => selectedIds.has(usageGovernanceRowId(row)));

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
            <th data-testid="governance-header-relation" scope="col">{t("relationships.governance.table.relation")}</th>
            <th data-testid="governance-header-source" scope="col">{t("relationships.governance.table.source")}</th>
            <th data-testid="governance-header-target" scope="col">{t("relationships.governance.table.target")}</th>
            <th data-testid="governance-header-impact" scope="col">{t("relationships.governance.table.impact")}</th>
            <th scope="col">{t("relationships.governance.table.verification")}</th>
            <th scope="col">{t("relationships.governance.table.action")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const relationId = usageGovernanceRowId(row);
            const noAction = classifyUsageRelation(row.usage) === "no_action";
            return (
              <tr
                data-readonly={row.usage.target.directory_role === "builtin" ? "true" : undefined}
                data-testid="governance-row"
                key={relationId}
              >
                <td>
                  {!noAction ? (
                    <GovernanceRelationSelection
                      onToggleRow={onToggleRow}
                      row={row}
                      selected={selectedIds.has(relationId)}
                    />
                  ) : null}
                </td>
                <td><GovernanceRelationIdentity row={row} /></td>
                <td data-testid={`governance-source-${relationId}`}><GovernanceRelationSource row={row} /></td>
                <td data-testid={`governance-target-${relationId}`}><GovernanceRelationTarget row={row} /></td>
                <td data-testid={`governance-impact-${relationId}`}><GovernanceRelationImpact row={row} /></td>
                <td><GovernanceRelationVerification row={row} /></td>
                <td className="sh-governance__actions">
                  <GovernanceRelationActions
                    busy={busyRelationIds.has(usageGovernanceActionRelationId(row))}
                    onCentralize={onCentralize}
                    onRevalidate={onRevalidate}
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

export function governanceSkillDisplayName(row: UsageGovernanceRow | RelationGovernanceRow, t: TFunction): string {
  if (!("usage" in row)) return row.skill_display_name?.trim() || String(t("relationships.governance.unnamedSkill"));
  const names = [...new Set(row.evidenceRows
    .map((evidence) => evidence.skill_display_name?.trim())
    .filter((name): name is string => Boolean(name)))];
  if (names.length === 1) return names[0]!;
  if (names.length > 1) return String(t("relationships.governance.multipleSkillNames", { names: names.join("、") }));
  return String(t("relationships.governance.unnamedSkill"));
}

export function GovernanceRelationSelection({
  onToggleRow,
  row,
  selected,
}: {
  onToggleRow: GovernanceRelationTableProps["onToggleRow"];
  row: UsageGovernanceRow;
  selected: boolean;
}) {
  const { t } = useTranslation();
  const relationId = usageGovernanceRowId(row);
  const executable = usageGovernanceRowIsSelectable(row);
  return (
    <input
      aria-label={t("relationships.governance.table.selectRow", { name: governanceSkillDisplayName(row, t) })}
      checked={selected}
      data-testid={`governance-select-${relationId}`}
      disabled={!executable}
      onChange={(event) => onToggleRow(relationId, event.target.checked)}
      type="checkbox"
    />
  );
}

export function GovernanceRelationIdentity({ row }: { row: UsageGovernanceRow }) {
  const { t } = useTranslation();
  const relationId = usageGovernanceRowId(row);
  const presentation = presentGovernanceRow(row.usage);
  const noAction = classifyUsageRelation(row.usage) === "no_action";
  const relationshipLabel = presentation.formKey
    ? t(presentation.formKey as never)
    : t("relationships.governance.form.unknown");

  return (
    <div className="sh-governance__identity">
      <strong
        aria-label={governanceSkillDisplayName(row, t)}
        tabIndex={0}
        title={governanceSkillDisplayName(row, t)}
      >
        {governanceSkillDisplayName(row, t)}
      </strong>
      <StatusBadge tone="info">{relationshipLabel}</StatusBadge>
      <StatusBadge tone={noAction ? "success" : "warning"}>
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
      <StatusBadge tone="info">{t(presentation.managementKey as never)}</StatusBadge>
      {noAction && row.usage.target.directory_role === "builtin" ? (
        <p className="sh-governance__readonly-note" data-testid="governance-builtin-note">
          {t(presentation.descriptionKey as never)}
        </p>
      ) : null}
      {!noAction && row.usage.target.directory_role === "builtin" ? (
        <p className="sh-governance__readonly-note" data-testid="governance-readonly-note">
          {t("relationships.governance.readOnly.note")}
        </p>
      ) : null}
      <p className="sh-visually-hidden" id={`governance-description-${relationId}`}>
        {t(presentation.descriptionKey as never)}
      </p>
    </div>
  );
}

export function GovernanceRelationTargetSummary({ row }: { row: UsageGovernanceRow }) {
  const { t } = useTranslation();
  const target = row.usage.target;
  const hasDeploymentEvidence = row.evidenceRows.some((evidence) => evidence.relation.kind === "deployment");
  return (
    <div className="sh-governance__board-target-summary">
      <strong className="sh-governance__directory-kind">{directoryGovernanceLabel(row, t)}</strong>
      {hasDeploymentEvidence && target.kind === "agent" && target.agent_client_id
        ? <AgentIdentity agentId={target.agent_client_id} />
        : null}
    </div>
  );
}

export function GovernanceRelationSource({ row }: { row: UsageGovernanceRow }) {
  const { t } = useTranslation();
  const form = row.usage.form;
  return <>{t(form ? `relationships.governance.form.${form}` as never : "relationships.governance.form.unknown")}</>;
}

export function GovernanceRelationTarget({ row }: { row: UsageGovernanceRow }) {
  const { t } = useTranslation();
  const { target, entry_key: entryKey } = row.usage;
  const hasDeploymentEvidence = row.evidenceRows.some((evidence) => evidence.relation.kind === "deployment");
  const paths = [...new Set(row.evidenceRows.map((evidence) => relationPathOf(evidence.relation)))];
  return (
    <>
      <strong className="sh-governance__directory-kind">{directoryGovernanceLabel(row, t)}</strong>
      {hasDeploymentEvidence && target.kind === "agent" && target.agent_client_id
        ? <AgentIdentity agentId={target.agent_client_id} />
        : null}
      {entryKey?.relative_entry_path ? (
        <span>{t("relationships.governance.entryLabel")} <RelationshipPath path={entryKey.relative_entry_path} /></span>
      ) : null}
      {paths.length > 0 ? (
        <span>{t("agents.pathLabel")} {paths.map((path) => <RelationshipPath key={path} path={path} />)}</span>
      ) : null}
    </>
  );
}

export function GovernanceRelationImpact({ row }: { row: UsageGovernanceRow }) {
  const { t } = useTranslation();
  const consumerIds = [...new Set(row.evidenceRows.flatMap((evidence) => evidence.impact.other_consumer_agent_ids))];
  const paths = [...new Set(row.evidenceRows.flatMap((evidence) => evidence.impact.other_skill_paths.map((item) => item.path)))];
  if (row.evidenceRows.length === 0) return <>{t("relationships.governance.impact.unconfirmed")}</>;
  return (
    <>
      {consumerIds.length > 0
        ? <>
            {t("relationships.governance.impact.otherConsumers", { agents: "", count: consumerIds.length })}
            {consumerIds.map((agentId, index) => <span key={agentId}>{index > 0 ? "、" : ""}<AgentPresentation agentId={agentId} /></span>)}
          </>
        : t("relationships.governance.impact.noOtherConsumers")}
      {paths.map((path) => <span key={path}><RelationshipPath path={path} /></span>)}
      {row.actionRestriction ? (
        <span role="note">{t(`relationships.governance.actionRestrictions.${row.actionRestriction}` as never)}</span>
      ) : null}
    </>
  );
}

export function GovernanceRelationVerification({ row }: { row: UsageGovernanceRow }) {
  return <><GovernanceRelationVerificationLabel row={row} /><GovernanceRelationBlockers row={row} /></>;
}

export function GovernanceRelationVerificationLabel({ row }: { row: UsageGovernanceRow }) {
  const { t } = useTranslation();
  const presentation = presentGovernanceRow(row.usage);
  return <span>{t(presentation.summaryKey as never)}</span>;
}

export function GovernanceRelationBlockers({ row }: { row: UsageGovernanceRow }) {
  const { t } = useTranslation();
  const relationId = usageGovernanceRowId(row);
  const reasons = presentGovernanceRow(row.usage).reasonKeys.filter((reason) => reason !== "normal");
  return (
    <>
      {reasons.length > 0 ? (
        <ul className="sh-governance__reason-list" data-testid={`governance-reasons-${relationId}`}>
          {reasons.map((reason) => (
            <li key={reason}>{t(usageHealthLabelKey(reason as never) as never)}</li>
          ))}
        </ul>
      ) : null}
      {row.actionRestriction ? (
        <p className="sh-governance__action-restriction" data-testid={`governance-action-restriction-${relationId}`} role="note">
          {t(`relationships.governance.actionRestrictions.${row.actionRestriction}` as never)}
        </p>
      ) : null}
    </>
  );
}

export function GovernanceRelationActions({
  busy,
  onCentralize,
  onRevalidate,
  onUndeploy,
  row,
}: {
  busy: boolean;
  onCentralize: GovernanceRelationTableProps["onCentralize"];
  onRevalidate: GovernanceRelationTableProps["onRevalidate"];
  onUndeploy: GovernanceRelationTableProps["onUndeploy"];
  row: UsageGovernanceRow;
}) {
  const { t } = useTranslation();
  const actionRow = row.actionRow;
  if (!actionRow) return null;
  const classification = classifyUsageRelation(row.usage);
  const actions = [
    {
      action: "centralize_management" as const,
      available: classification === "pending"
        && row.usage.management === "unmanaged"
        && (
          isGovernanceActionAvailable(actionRow, "centralize_management")
          || rowNeedsSharedImpactConfirmation(actionRow)
        ),
      onClick: () => onCentralize(actionRow),
      variant: "primary" as const,
    },
    {
      action: "revalidate" as const,
      available: row.usage.health_reasons.some((reason) => reason !== "normal")
        && isGovernanceActionAvailable(actionRow, "revalidate"),
      onClick: () => onRevalidate(actionRow),
      variant: "secondary" as const,
    },
    {
      action: "undeploy" as const,
      available: row.usage.management === "managed"
        && isGovernanceActionAvailable(actionRow, "undeploy"),
      onClick: () => onUndeploy(actionRow),
      variant: "secondary" as const,
    },
  ].filter((item) => item.available);

  return (
    <>
      {actions.map(({ action, onClick, variant }) => (
        <Button
          data-action={action}
          data-testid={action === "centralize_management"
            ? `governance-action-${relationIdOf(actionRow.relation)}`
            : `governance-action-${action}-${relationIdOf(actionRow.relation)}`}
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

function directoryGovernanceLabel(row: UsageGovernanceRow, t: TFunction): string {
  const { target } = row.usage;
  if (target.kind === "shared_directory" || target.directory_role === "shared_directory") {
    return t("relationships.governance.directory.sharedAgent");
  }
  if (target.directory_role === "agent_user") return t("agents.directoryRole.user");
  if (target.directory_role === "agent_workspace") return t("agents.directoryRole.workspace");
  if (target.directory_role === "builtin") return t("agents.directoryRole.builtin");
  if (target.directory_role) return t(directoryRoleLabelKey(target.directory_role as never) as never);
  return t("relationships.governance.directory.independent");
}
