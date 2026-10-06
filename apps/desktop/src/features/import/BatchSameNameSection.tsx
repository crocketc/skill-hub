import { useTranslation } from "react-i18next";
import type { ImportAction, ImportBatchAnalysis, ImportConflict } from "./api";
import type { BatchCandidateLabel } from "./batchCandidateLabel";
import { overrideNameCollision, type OverrideCollision } from "./batchDispositions";

/**
 * W2-2：批内同名不同内容组——成员必须逐项显式处置（独立命名或跳过），
 * 没有任何静默默认；独立命名提供内联输入与即时碰撞反馈（最终裁决仍由
 * 提交期的后端错误码给出）。
 *
 * 第 24 节：本区块自 ConflictResolution.tsx 原样搬迁为独立组件文件，
 * 内部逻辑与文案键保持不变（另一任务并行修改其内部语义，合并时对位）。
 */
export function BatchSameNameSection({
  group,
  labels,
  candidateNames,
  conflicts,
  actions,
  overrides,
  onAction,
  onOverrideName,
}: {
  group: ImportBatchAnalysis["sameNameGroups"][number];
  labels: ReadonlyMap<string, BatchCandidateLabel>;
  candidateNames: Readonly<Record<string, string>>;
  conflicts: ImportConflict[];
  actions: Record<string, ImportAction>;
  overrides: Record<string, string>;
  onAction: (candidateId: string, action: ImportAction) => void;
  onOverrideName?: (candidateId: string, name: string) => void;
}) {
  const { t } = useTranslation();
  const headingId = `batch-same-name-${group.normalizedRuntimeName.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  const collisionMessage = (collision: OverrideCollision): string | null => {
    if (collision === "empty") return t("importWorkflow.conflicts.batch.renameEmpty");
    if (collision === "batch") return t("importWorkflow.conflicts.batch.renameBatchCollision");
    if (collision === "library") return t("importWorkflow.conflicts.batch.renameLibraryCollision");
    return null;
  };
  return (
    <section aria-labelledby={headingId} className="sh-import-conflicts__batch-group">
      <h3 id={headingId}>{t("importWorkflow.conflicts.batch.sameNameTitle")}</h3>
      <p>{t("importWorkflow.conflicts.batch.sameNameDescription")}</p>
      <ul className="sh-import-conflicts__list">
        {group.candidateIds.map((memberId) => {
          const label = labels.get(memberId);
          const independent = actions[memberId] === "independent";
          const value = overrides[memberId] ?? "";
          // 该成员自己的库内冲突已展示的 runtime 名参与即时校验；最终以
          // prepare/commit 的后端错误码为准，这里只是前端即时反馈。
          const libraryRuntimeNames = conflicts
            .filter((conflict) => conflict.candidateId === memberId)
            .flatMap((conflict) => (conflict.matchedSkills ?? []).map((skill) => skill.runtimeName));
          const collision = independent
            ? overrideNameCollision({
                candidateId: memberId,
                groupCandidateIds: group.candidateIds,
                normalizedGroupName: group.normalizedRuntimeName,
                candidateNames,
                libraryRuntimeNames,
                overrides,
                value,
              })
            : null;
          const collisionText = collision ? collisionMessage(collision) : null;
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
              {independent ? (
                <div className="sh-import-conflicts__rename">
                  <label htmlFor={`override-name-${memberId}`}>
                    {t("importWorkflow.conflicts.batch.renameLabel")}
                  </label>
                  <input
                    aria-invalid={collision ? true : false}
                    aria-describedby={collisionText ? `override-hint-${memberId}` : undefined}
                    id={`override-name-${memberId}`}
                    onChange={(event) => onOverrideName?.(memberId, event.target.value)}
                    type="text"
                    value={value}
                  />
                  <p className="sh-import-conflicts__reason">
                    {t("importWorkflow.conflicts.batch.renameGuidance")}
                  </p>
                  {collisionText ? (
                    <p className="sh-import-conflicts__reason" id={`override-hint-${memberId}`}>
                      {collisionText}
                    </p>
                  ) : null}
                </div>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
