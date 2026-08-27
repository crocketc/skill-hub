import { useTranslation } from "react-i18next";
import { Button } from "../../ui/Button";
import { StatusBadge } from "../../ui/StatusBadge";
import type { ImportAction, ImportConflict } from "./api";

export interface ConflictResolutionProps {
  conflicts: ImportConflict[];
  actions: Record<string, ImportAction>;
  onAction: (candidateId: string, action: ImportAction) => void;
  onContinue: () => void;
  onBack: () => void;
}

const actionOrder: ImportAction[] = ["reuse", "copy", "takeover", "independent", "skip"];

export function ConflictResolution({
  conflicts,
  actions,
  onAction,
  onContinue,
  onBack,
}: ConflictResolutionProps) {
  const { t } = useTranslation();
  const hasMissingRequiredAction = conflicts.some(
    (conflict) => conflict.required && !actions[conflict.candidateId],
  );

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
        <ul className="sh-import-conflicts__list">
          {conflicts.map((conflict) => (
            <li className="sh-import-conflicts__item" key={conflict.candidateId}>
              <div className="sh-import-conflicts__summary">
                <strong>{conflict.candidateId}</strong>
                <StatusBadge tone="warning">{t(`importWorkflow.conflicts.kinds.${conflict.kind}`)}</StatusBadge>
                <p>{conflict.summary}</p>
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
      ) : (
        <p className="sh-import-conflicts__empty" role="status">
          {t("importWorkflow.conflicts.none")}
        </p>
      )}

      <div className="sh-import-conflicts__actions">
        <Button onClick={onBack} variant="ghost">{t("actions.back")}</Button>
        <Button disabled={hasMissingRequiredAction} onClick={onContinue}>{t("actions.continue")}</Button>
      </div>
    </section>
  );
}
