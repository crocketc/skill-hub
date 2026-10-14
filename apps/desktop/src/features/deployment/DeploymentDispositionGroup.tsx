import { useTranslation } from "react-i18next";
import {
  type DeploymentBlockReason,
  type DeploymentConflictDecision,
  type DeploymentConflictDecisionMap,
  type DeploymentTarget,
  type DispositionGroup,
  deploymentBlockReasonKey,
} from "./api";
import { DeploymentImpactCard } from "./DeploymentImpactCard";

export type DispositionGroupSelection = "include" | "confirm" | "none";

type DeploymentDispositionGroupProps = {
  group: DispositionGroup;
  /** include=参与本批；confirm=确认改用复制；none=纯展示（无法执行）。 */
  selection: DispositionGroupSelection;
  selected: Set<string>;
  onToggle: (pairId: string, checked: boolean) => void;
  targets: DeploymentTarget[];
  conflictDecisions: DeploymentConflictDecisionMap;
  conflictErrors: Record<string, string>;
  confirmedFallbackIds: Set<string>;
  confirmedSharedIds: Set<string>;
  onConflictDecisionChange: (pairId: string, decision: DeploymentConflictDecision) => void;
  onFallbackConfirmationChange: (pairId: string, checked: boolean) => void;
  onSharedTargetConfirmationChange: (pairId: string, checked: boolean) => void;
  disabled?: boolean;
};

/** 分组标题（14.5 四类）；标题里不带数量，数量由独立的计数徽标呈现。 */
export function dispositionGroupTitleKey(group: DispositionGroup): string {
  switch (group.disposition) {
    case "selected_mode":
      return "deployment.groups.selected";
    case "recommend_copy":
      return "deployment.groups.recommendCopy";
    case "no_change":
      return "deployment.groups.noChange";
    case "blocked":
      return "deployment.groups.blocked";
  }
}

/** 组级原因说明（14.4 五类文案）：阻断原因或回退建议。 */
export function dispositionGroupReasonKey(group: DispositionGroup): string | null {
  if (group.disposition === "recommend_copy" && group.blockReason) {
    return deploymentBlockReasonKey(group.blockReason);
  }
  if (group.disposition === "blocked" && group.blockReason) {
    return deploymentBlockReasonKey(group.blockReason);
  }
  return null;
}

const reasonDetailKeys: Partial<Record<DeploymentBlockReason, string>> = {
  shared_impact_requires_resolution: "deployment.blockReason.sharedImpactDetail",
};

const conflictActionOrder = ["skip", "replace_target", "rename_and_deploy"] as const;

function conflictActionLabel(action: (typeof conflictActionOrder)[number], t: (key: string) => string): string {
  switch (action) {
    case "replace_target": return t("deployment.conflict.actions.replaceTarget");
    case "rename_and_deploy": return t("deployment.conflict.actions.renameAndDeploy");
    case "skip": return t("deployment.conflict.actions.skip");
  }
}

function ConflictDecisionControls({
  pair,
  decision,
  error,
  fallbackConfirmed,
  sharedConfirmed,
  onDecisionChange,
  onFallbackConfirmationChange,
  onSharedTargetConfirmationChange,
  disabled,
}: {
  pair: DispositionGroup["pairs"][number];
  decision: DeploymentConflictDecision;
  error?: string;
  fallbackConfirmed: boolean;
  sharedConfirmed: boolean;
  onDecisionChange: (decision: DeploymentConflictDecision) => void;
  onFallbackConfirmationChange: (checked: boolean) => void;
  onSharedTargetConfirmationChange: (checked: boolean) => void;
  disabled: boolean;
}) {
  const { t } = useTranslation();
  const conflict = pair.conflict;
  if (!conflict) return null;
  const actions = conflictActionOrder.filter((action) => conflict.available_actions.includes(action));

  return (
    <fieldset className="sh-deployment-conflict-choice" disabled={disabled}>
      <legend>{t("deployment.conflict.chooseAction")}</legend>
      <div className="sh-deployment-conflict-choice__actions">
        {actions.map((action) => {
          const label = conflictActionLabel(action, (key) => String(t(key as never, { defaultValue: key } as never)));
          return (
            <label className="sh-deployment-conflict-choice__action" key={action}>
              <input
                aria-label={`${label} · ${pair.skillDisplayName} · ${pair.targetLabel}`}
                checked={decision.action === action}
                name={`conflict-action-${pair.pairId}`}
                onChange={() => onDecisionChange({ action })}
                type="radio"
                value={action}
              />
              <span>{label}</span>
            </label>
          );
        })}
      </div>
      {decision.action === "rename_and_deploy" ? (
        <label className="sh-deployment-conflict-choice__name">
          <span>{t("deployment.conflict.newName")}</span>
          <input
            aria-label={`${t("deployment.conflict.newName")} · ${pair.skillDisplayName} · ${pair.targetLabel}`}
            autoComplete="off"
            onChange={(event) => onDecisionChange({ ...decision, runtimeName: event.currentTarget.value })}
            spellCheck={false}
            type="text"
            value={decision.runtimeName ?? ""}
          />
        </label>
      ) : null}
      {decision.action !== "skip" && conflict.shared_target ? (
        <label className="sh-deployment-conflict-choice__confirmation">
          <input
            aria-label={t("deployment.conflict.confirmSharedTarget")}
            checked={sharedConfirmed}
            onChange={(event) => onSharedTargetConfirmationChange(event.currentTarget.checked)}
            type="checkbox"
          />
          <span>{t("deployment.conflict.confirmSharedTarget")}</span>
        </label>
      ) : null}
      {decision.action === "replace_target" && pair.mode === null && pair.fallbackMode !== null ? (
        <label className="sh-deployment-conflict-choice__confirmation">
          <input
            aria-label={t("deployment.conflict.confirmFallback")}
            checked={fallbackConfirmed}
            onChange={(event) => onFallbackConfirmationChange(event.currentTarget.checked)}
            type="checkbox"
          />
          <span>{t("deployment.conflict.confirmFallback")}</span>
        </label>
      ) : null}
      {error ? <p className="sh-deployment-conflict-choice__error" role="alert">{String(t(error as never, { defaultValue: error } as never))}</p> : null}
    </fieldset>
  );
}

/**
 * 一类处置的分组呈现（任务 14.6/14.13）：分组键保证不同影响的 pair 不会
 * 因原因文案相同被并组；组内提供全选与逐项取消；pair id 不进首屏。
 */
export function DeploymentDispositionGroup({
  group,
  selection,
  selected,
  onToggle,
  targets,
  conflictDecisions,
  conflictErrors,
  confirmedFallbackIds,
  confirmedSharedIds,
  onConflictDecisionChange,
  onFallbackConfirmationChange,
  onSharedTargetConfirmationChange,
  disabled = false,
}: DeploymentDispositionGroupProps) {
  const { t } = useTranslation();
  const titleKey = dispositionGroupTitleKey(group);
  const reasonKey = dispositionGroupReasonKey(group);
  const allSelected = group.pairs.every((pair) => selected.has(pair.pairId));
  const hasConflicts = group.pairs.some((pair) => pair.conflict !== null && pair.conflict !== undefined);
  const selectAllName = selection === "confirm"
    ? t("deployment.groups.confirmAll")
    : t("deployment.groups.selectAll");

  return (
    <section
      aria-labelledby={`disposition-group-${group.key}`}
      className="sh-disposition-group"
      data-disposition={group.disposition}
      data-testid="disposition-group"
    >
      <div className="sh-disposition-group__header">
        {selection !== "none" ? <input
          aria-label={selectAllName}
          checked={allSelected}
          disabled={disabled}
          onChange={(event) => {
            if (disabled) return;
            group.pairs.forEach((pair) => onToggle(pair.pairId, event.target.checked));
          }}
          ref={(element) => {
            // 部分选中态：React 不支持 indeterminate 属性，经 ref 设置。
            if (element) {
              element.indeterminate = !allSelected && group.pairs.some((pair) => selected.has(pair.pairId));
            }
          }}
          type="checkbox"
        /> : hasConflicts ? <span aria-hidden="true" className="sh-disposition-group__header-spacer" /> : null}
        <h3 id={`disposition-group-${group.key}`}>
          {String(t(titleKey as never, { defaultValue: titleKey } as never))}
          <span className="sh-count-badge">{group.pairs.length}</span>
        </h3>
      </div>
      {reasonKey ? <p className="sh-disposition-group__reason">{String(t(reasonKey as never, { defaultValue: reasonKey } as never))}</p> : null}
      {group.blockReason && reasonDetailKeys[group.blockReason] ? (
        <p className="sh-disposition-group__hint">{String(t(reasonDetailKeys[group.blockReason] as never, { defaultValue: reasonDetailKeys[group.blockReason] } as never))}</p>
      ) : null}
      {selection === "confirm" ? <p className="sh-disposition-group__hint">{t("deployment.groups.confirmCopyHint")}</p> : null}
      {selection === "include" ? <p className="sh-disposition-group__hint">{t("deployment.groups.includeHint")}</p> : null}
      <div className="sh-disposition-group__rows">
        {group.pairs.map((pair) => {
          const checked = selected.has(pair.pairId);
          const rowName = `${pair.skillDisplayName} · ${pair.targetLabel}`;
          return (
            <div className="sh-disposition-group__row" data-testid="disposition-row" key={pair.pairId}>
              {selection !== "none" ? <input
                aria-label={rowName}
                checked={checked}
                disabled={disabled}
                onChange={(event) => onToggle(pair.pairId, event.target.checked)}
                type="checkbox"
              /> : null}
              <div className="sh-disposition-group__row-body">
                <strong>{pair.skillDisplayName}</strong>
                {selection === "confirm" && checked ? (
                  <span className="sh-disposition-group__confirmed" data-testid="confirmed-copy">
                    {t("deployment.groups.confirmedCopy")}
                  </span>
                ) : null}
                <DeploymentImpactCard pair={pair} targets={targets} />
                {pair.conflict ? <ConflictDecisionControls
                  decision={conflictDecisions[pair.pairId] ?? {
                    action: pair.conflict.default_action,
                  }}
                  disabled={disabled}
                  error={conflictErrors[pair.pairId]}
                  fallbackConfirmed={confirmedFallbackIds.has(pair.pairId)}
                  sharedConfirmed={confirmedSharedIds.has(pair.pairId)}
                  onDecisionChange={(decision) => onConflictDecisionChange(pair.pairId, decision)}
                  onFallbackConfirmationChange={(confirmed) => onFallbackConfirmationChange(pair.pairId, confirmed)}
                  onSharedTargetConfirmationChange={(confirmed) => onSharedTargetConfirmationChange(pair.pairId, confirmed)}
                  pair={pair}
                /> : null}
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
