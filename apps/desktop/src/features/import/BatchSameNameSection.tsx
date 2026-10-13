import { useTranslation } from "react-i18next";
import type { ImportAction, ImportBatchAnalysis } from "./api";
import type { BatchCandidateLabel } from "./batchCandidateLabel";

/**
 * W2-2：批内同名不同内容组——成员必须逐项选择独立导入或跳过，
 * 没有任何静默默认；独立导入保留候选原名。
 *
 * 批内冲突区块逐项展示候选信息与用户选择。
 */
export function BatchSameNameSection({
  group,
  labels,
  actions,
  onAction,
}: {
  group: ImportBatchAnalysis["sameNameGroups"][number];
  labels: ReadonlyMap<string, BatchCandidateLabel>;
  actions: Record<string, ImportAction>;
  onAction: (candidateId: string, action: ImportAction) => void;
}) {
  const { t } = useTranslation();
  const headingId = `batch-same-name-${group.normalizedRuntimeName.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  return (
    <section aria-labelledby={headingId} className="sh-import-conflicts__batch-group">
      <h3 id={headingId}>{t("importWorkflow.conflicts.batch.sameNameTitle")}</h3>
      <p>{t("importWorkflow.conflicts.batch.sameNameDescription")}</p>
      <ul className="sh-import-conflicts__list">
        {group.candidateIds.map((memberId) => {
          const label = labels.get(memberId);
          return (
            <li className="sh-import-conflicts__item" key={memberId}>
              <div className="sh-import-conflicts__summary">
                <strong>{label?.name ?? memberId}</strong>
                {label?.path ? (
                  <p>
                    <span>{t("importWorkflow.conflicts.candidatePath")}</span>
                    <code title={label.path}>{label.path}</code>
                  </p>
                ) : null}
              </div>
              <fieldset>
                <legend>{t("importWorkflow.conflicts.chooseAction")}</legend>
                <div className="sh-import-conflicts__options">
                  {(["independent", "skip"] as ImportAction[]).map((action) => (
                    <div className="sh-import-conflicts__option" key={action}>
                      <label>
                        <input
                          checked={actions[memberId] === action}
                          name={`conflict-${memberId}`}
                          onChange={() => onAction(memberId, action)}
                          type="radio"
                        />
                        {t(`importWorkflow.conflicts.actions.${action}`)}
                      </label>
                    </div>
                  ))}
                </div>
              </fieldset>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
