import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui/Button";
import { StatusBadge } from "../../ui/StatusBadge";
import type { ImportAction, ImportConflict } from "./api";

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

function sharedActions(conflicts: ImportConflict[]): ImportAction[] {
  if (conflicts.length === 0) return [];
  return actionOrder.filter((action) =>
    conflicts.every((conflict) => conflict.allowedActions.includes(action)),
  );
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
  const hasMissingRequiredAction = conflicts.some(
    (conflict) => conflict.required && !actions[conflict.candidateId],
  );

  const groups = useMemo(() => {
    const byKind = new Map<ImportConflict["kind"], ImportConflict[]>();
    for (const conflict of conflicts) {
      const list = byKind.get(conflict.kind) ?? [];
      list.push(conflict);
      byKind.set(conflict.kind, list);
    }
    return [...byKind.entries()].map(([kind, items]) => ({ kind, items }));
  }, [conflicts]);

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
        <div className="sh-import-conflicts__groups">
          {groups.map(({ kind, items }) => {
            const batchActions = items.length > 1 ? sharedActions(items) : [];
            return (
              <fieldset className="sh-import-conflicts__group" key={kind}>
                <legend>
                  {t(`importWorkflow.conflicts.kinds.${kind}`)}
                  {" · "}
                  {t("importWorkflow.conflicts.groupCount", { count: items.length })}
                </legend>
                {batchActions.length ? (
                  <div aria-label={t("importWorkflow.conflicts.batchLabel")} className="sh-import-conflicts__batch">
                    <span>{t("importWorkflow.conflicts.batchLabel")}</span>
                    {batchActions.map((action) => (
                      <Button
                        key={action}
                        onClick={() => {
                          for (const conflict of items) onAction(conflict.candidateId, action);
                        }}
                        size="sm"
                        variant="secondary"
                      >
                        {t(`importWorkflow.conflicts.actions.${action}`)}
                      </Button>
                    ))}
                  </div>
                ) : null}
                <ul className="sh-import-conflicts__list">
                  {items.map((conflict) => (
                    <li className="sh-import-conflicts__item" key={conflict.candidateId}>
                      <div className="sh-import-conflicts__summary">
                        <strong>{conflict.candidateId}</strong>
                        <StatusBadge tone="warning">{t(`importWorkflow.conflicts.kinds.${conflict.kind}`)}</StatusBadge>
                        <p>{conflict.summary}</p>
                        {conflict.candidatePath ? (
                          <p>
                            <span>{t("importWorkflow.conflicts.candidatePath")}</span>
                            <code title={conflict.candidatePath}>{conflict.candidatePath}</code>
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
                      </div>
                      <fieldset>
                        <legend>{t("importWorkflow.conflicts.chooseAction")}</legend>
                        <div className="sh-import-conflicts__options">
                          {actionOrder
                            .filter((action) => conflict.allowedActions.includes(action))
                            .map((action) => (
                              <label key={action}>
                                <input
                                  checked={actions[conflict.candidateId] === action}
                                  name={`conflict-${conflict.candidateId}`}
                                  onChange={() => onAction(conflict.candidateId, action)}
                                  type="radio"
                                />
                                {t(`importWorkflow.conflicts.actions.${action}`)}
                              </label>
                            ))}
                        </div>
                      </fieldset>
                    </li>
                  ))}
                </ul>
              </fieldset>
            );
          })}
        </div>
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
