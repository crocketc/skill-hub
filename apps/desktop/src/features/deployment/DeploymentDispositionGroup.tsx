import { useTranslation } from "react-i18next";
import { type DispositionGroup, type DeploymentBlockReason, type DeploymentTarget, deploymentBlockReasonKey } from "./api";
import { DeploymentImpactCard } from "./DeploymentImpactCard";

export type DispositionGroupSelection = "include" | "confirm" | "none";

type DeploymentDispositionGroupProps = {
  group: DispositionGroup;
  /** include=参与本批；confirm=确认改用复制；none=纯展示（无法执行）。 */
  selection: DispositionGroupSelection;
  selected: Set<string>;
  onToggle: (pairId: string, checked: boolean) => void;
  targets: DeploymentTarget[];
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

/**
 * 一类处置的分组呈现（任务 14.6/14.13）：分组键保证不同影响的 pair 不会
 * 因原因文案相同被并组；组内提供全选与逐项取消；pair id 不进首屏。
 */
export function DeploymentDispositionGroup({ group, selection, selected, onToggle, targets }: DeploymentDispositionGroupProps) {
  const { t } = useTranslation();
  const titleKey = dispositionGroupTitleKey(group);
  const reasonKey = dispositionGroupReasonKey(group);
  const allSelected = group.pairs.every((pair) => selected.has(pair.pairId));
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
        <input
          aria-label={selectAllName}
          checked={allSelected}
          disabled={selection === "none"}
          onChange={(event) => {
            if (selection === "none") return;
            group.pairs.forEach((pair) => onToggle(pair.pairId, event.target.checked));
          }}
          ref={(element) => {
            // 部分选中态：React 不支持 indeterminate 属性，经 ref 设置。
            if (element) {
              element.indeterminate = selection !== "none" && !allSelected
                && group.pairs.some((pair) => selected.has(pair.pairId));
            }
          }}
          type="checkbox"
        />
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
              </div>
            </div>
          );
        })}
      </div>
    </section>
  );
}
