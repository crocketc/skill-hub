import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui/Button";
import { StatusBadge } from "../../ui/StatusBadge";
import type { ConflictKind, ImportAction, ImportConflict } from "./api";

export interface ConflictResolutionProps {
  conflicts: ImportConflict[];
  actions: Record<string, ImportAction>;
  /** AR-014 导入互斥：为 true 时禁用提交按钮。 */
  commitDisabled?: boolean;
  onAction: (candidateId: string, action: ImportAction) => void;
  onContinue: () => void;
  onBack: () => void;
  continueLabel?: string;
}

const actionOrder: ImportAction[] = ["reuse", "copy", "takeover", "independent", "skip"];

/** bindings 中 ConflictKind 的当前集合；用于把未知类型诚实兜底，而不是渲染内部键名。 */
const knownKinds: ConflictKind[] = ["exact_duplicate", "same_name", "semantic_match", "agent_owned"];

/** bindings 中 DuplicateKind 的当前集合；用于展示候选与已有 Skill 的差异信息。 */
const knownDuplicateKinds = [
  "exact_content",
  "same_source",
  "same_runtime_name_different_content",
  "search_candidate",
] as const;

function sharedActions(conflicts: ImportConflict[]): ImportAction[] {
  if (conflicts.length === 0) return [];
  return actionOrder.filter((action) =>
    conflicts.every((conflict) => conflict.allowedActions.includes(action)),
  );
}

function impactAnchor(candidateId: string, action: ImportAction): string {
  return `conflict-impact-${candidateId.replace(/[^a-zA-Z0-9_-]/g, "_")}-${action}`;
}

export function ConflictResolution({
  conflicts,
  actions,
  commitDisabled = false,
  onAction,
  onContinue,
  onBack,
  continueLabel,
}: ConflictResolutionProps) {
  const { t } = useTranslation();
  // AR-010：先按冲突原因类别筛选，再为该类别批量选择处理方式。
  const [kindFilter, setKindFilter] = useState<"all" | ConflictKind>("all");
  const [batchAction, setBatchAction] = useState<ImportAction | "">("");

  const kindLabel = (kind: ConflictKind): string =>
    knownKinds.includes(kind)
      ? t(`importWorkflow.conflicts.kinds.${kind}`)
      : t("importWorkflow.conflicts.reasons.unknown", { kind });

  const reasonLabel = (kind: ConflictKind): string =>
    knownKinds.includes(kind)
      ? t(`importWorkflow.conflicts.reasons.${kind}`)
      : t("importWorkflow.conflicts.reasons.unknown", { kind });

  const differenceLabel = (duplicateKind: string | null | undefined): string | null => {
    if (!duplicateKind) return null;
    const known = knownDuplicateKinds.find((candidate) => candidate === duplicateKind);
    return known
      ? t(`importWorkflow.conflicts.diffKinds.${known}`)
      : t("importWorkflow.conflicts.diffKinds.unknown", { kind: duplicateKind });
  };

  const hasMissingRequiredAction = conflicts.some(
    (conflict) => conflict.required && !actions[conflict.candidateId],
  );

  const groups = useMemo(() => {
    const byKind = new Map<ConflictKind, ImportConflict[]>();
    for (const conflict of conflicts) {
      const list = byKind.get(conflict.kind) ?? [];
      list.push(conflict);
      byKind.set(conflict.kind, list);
    }
    return [...byKind.entries()].map(([kind, items]) => ({ kind, items }));
  }, [conflicts]);

  const visibleConflicts = useMemo(
    () => (kindFilter === "all" ? conflicts : conflicts.filter((conflict) => conflict.kind === kindFilter)),
    [conflicts, kindFilter],
  );

  const batchChoices = useMemo(
    () => (kindFilter === "all" || visibleConflicts.length < 2 ? [] : sharedActions(visibleConflicts)),
    [kindFilter, visibleConflicts],
  );

  const selectFilter = (next: "all" | ConflictKind) => {
    setKindFilter(next);
    setBatchAction("");
  };

  const applyBatch = () => {
    if (!batchAction) return;
    for (const conflict of visibleConflicts) onAction(conflict.candidateId, batchAction);
  };

  return (
    <section className="sh-import-conflicts" aria-labelledby="import-conflicts-title">
      <div className="sh-import-conflicts__heading">
        <div>
          <p className="sh-import-conflicts__eyebrow">{t("importWorkflow.conflicts.eyebrow")}</p>
          <h2 id="import-conflicts-title">{t("importWorkflow.conflicts.title")}</h2>
          <p>{t("importWorkflow.conflicts.description")}</p>
        </div>
        <span className="sh-import-conflicts__step">{t("importWorkflow.step", { current: 3, total: 4 })}</span>
      </div>

      {conflicts.length ? (
        <>
          <div className="sh-import-conflicts__filters" role="group" aria-label={t("importWorkflow.conflicts.filterLabel")}>
            <button
              aria-pressed={kindFilter === "all"}
              className="sh-import-conflicts__filter"
              onClick={() => selectFilter("all")}
              type="button"
            >
              {t("importWorkflow.conflicts.filterAll")}
              {t("importWorkflow.conflicts.filterCount", { count: conflicts.length })}
            </button>
            {groups.map(({ kind, items }) => (
              <button
                aria-pressed={kindFilter === kind}
                className="sh-import-conflicts__filter"
                key={kind}
                onClick={() => selectFilter(kind)}
                type="button"
              >
                {kindLabel(kind)}
                {t("importWorkflow.conflicts.filterCount", { count: items.length })}
              </button>
            ))}
          </div>

          {batchChoices.length ? (
            <div aria-label={t("importWorkflow.conflicts.batchLabel")} className="sh-import-conflicts__batch" role="group">
              <span>{t("importWorkflow.conflicts.batchLabel")}</span>
              <select
                aria-label={t("importWorkflow.conflicts.chooseAction")}
                onChange={(event) => setBatchAction(event.target.value as ImportAction | "")}
                value={batchAction}
              >
                <option value="">{t("importWorkflow.conflicts.batchPrompt")}</option>
                {batchChoices.map((action) => (
                  <option key={action} value={action}>
                    {t(`importWorkflow.conflicts.actions.${action}`)}
                  </option>
                ))}
              </select>
              <span>{t("importWorkflow.conflicts.batchScopeCount", { count: visibleConflicts.length })}</span>
              {batchAction ? <span>{t(`importWorkflow.conflicts.impacts.${batchAction}`)}</span> : null}
              <Button disabled={!batchAction} onClick={applyBatch} size="sm" variant="secondary">
                {t("importWorkflow.conflicts.batchApply")}
              </Button>
              <p className="sh-import-conflicts__batch-note">{t("importWorkflow.conflicts.batchScopeNote")}</p>
            </div>
          ) : null}

          <div className="sh-import-conflicts__groups">
            {(kindFilter === "all"
              ? groups
              : groups.filter(({ kind }) => kind === kindFilter)
            ).map(({ kind, items }) => (
              <fieldset className="sh-import-conflicts__group" key={kind}>
                <legend>
                  {kindLabel(kind)}
                  {" · "}
                  {t("importWorkflow.conflicts.groupCount", { count: items.length })}
                </legend>
                <ul className="sh-import-conflicts__list">
                  {items.map((conflict) => (
                    <li className="sh-import-conflicts__item" key={conflict.candidateId}>
                      <div className="sh-import-conflicts__summary">
                        <strong>{conflict.candidateName || conflict.candidateId}</strong>
                        {knownKinds.includes(conflict.kind) ? (
                          <StatusBadge tone="warning">{kindLabel(conflict.kind)}</StatusBadge>
                        ) : null}
                        <p className="sh-import-conflicts__reason">{reasonLabel(conflict.kind)}</p>
                        {conflict.candidatePath ? (
                          <p>
                            <span>{t("importWorkflow.conflicts.candidatePath")}</span>
                            <code title={conflict.candidatePath}>{conflict.candidatePath}</code>
                          </p>
                        ) : null}
                        {differenceLabel(conflict.duplicateKind) ? (
                          <p>
                            <span>{t("importWorkflow.conflicts.diffLabel")}</span>
                            {differenceLabel(conflict.duplicateKind)}
                          </p>
                        ) : null}
                        {conflict.matchedSkillIds && conflict.matchedSkillIds.length ? (
                          <p>
                            <span>{t("importWorkflow.conflicts.matchedWith")}</span>
                            {conflict.matchedSkillIds.map((skillId) => (
                              <code key={skillId}>{skillId}</code>
                            ))}
                          </p>
                        ) : null}
                        {conflict.summary ? (
                          <p className="sh-import-conflicts__diagnostic">
                            <span>{t("importWorkflow.conflicts.diagnosticsLabel")}</span>
                            <code>{conflict.summary}</code>
                            {conflict.duplicateKind ? <code>{conflict.duplicateKind}</code> : null}
                          </p>
                        ) : null}
                      </div>
                      <fieldset>
                        <legend>{t("importWorkflow.conflicts.chooseAction")}</legend>
                        <div className="sh-import-conflicts__options">
                          {actionOrder
                            .filter((action) => conflict.allowedActions.includes(action))
                            .map((action) => (
                              <div className="sh-import-conflicts__option" key={action}>
                                <label>
                                  <input
                                    aria-describedby={impactAnchor(conflict.candidateId, action)}
                                    checked={actions[conflict.candidateId] === action}
                                    name={`conflict-${conflict.candidateId}`}
                                    onChange={() => onAction(conflict.candidateId, action)}
                                    type="radio"
                                  />
                                  {t(`importWorkflow.conflicts.actions.${action}`)}
                                </label>
                                <p className="sh-import-conflicts__option-impact" id={impactAnchor(conflict.candidateId, action)}>
                                  {t(`importWorkflow.conflicts.impacts.${action}`)}
                                </p>
                              </div>
                            ))}
                        </div>
                      </fieldset>
                    </li>
                  ))}
                </ul>
              </fieldset>
            ))}
          </div>
        </>
      ) : (
        <p className="sh-import-conflicts__empty" role="status">
          {t("importWorkflow.conflicts.none")}
        </p>
      )}

      <div className="sh-import-conflicts__actions">
        <Button onClick={onBack} variant="ghost">{t("actions.back")}</Button>
        <Button disabled={hasMissingRequiredAction || commitDisabled} onClick={onContinue}>{continueLabel ?? t("actions.continue")}</Button>
      </div>
    </section>
  );
}
