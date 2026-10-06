import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { StatusBadge } from "../../ui/StatusBadge";
import type {
  ImportAction,
  ImportBatchAnalysis,
  ImportCandidate,
  ImportConflict,
} from "./api";
import type { BatchCandidateLabel } from "./batchCandidateLabel";
import { BatchSameNameSection } from "./BatchSameNameSection";
import { LibraryConflictsSection } from "./LibraryConflictsSection";

export interface ConflictResolutionProps {
  conflicts: ImportConflict[];
  actions: Record<string, ImportAction>;
  onAction: (candidateId: string, action: ImportAction) => void;
  /**
   * W2-2（FB-007）：批内分组与组成签名。缺省（宿主未提供批内分析）时
   * 不渲染批内区块，行为与既有版本一致。
   */
  batchAnalysis?: ImportBatchAnalysis;
  /** 批内候选（把候选 id 显示为名称与路径）；缺省时仅显示候选 id。 */
  candidates?: ImportCandidate[];
  /** candidateId → 独立导入已填写的新名（受控值由向导持有）。 */
  overrides?: Record<string, string>;
  onOverrideName?: (candidateId: string, name: string) => void;
}

/** W2-2：批内同内容组——明显重复，建议保留一项（复制）、其余跳过；建议可改。 */
function BatchSameContentSection({
  group,
  labels,
  actions,
  onAction,
}: {
  group: ImportBatchAnalysis["sameContentGroups"][number];
  labels: ReadonlyMap<string, BatchCandidateLabel>;
  actions: Record<string, ImportAction>;
  onAction: (candidateId: string, action: ImportAction) => void;
}) {
  const { t } = useTranslation();
  const headingId = `batch-same-content-${group.normalizedRuntimeName.replace(/[^a-zA-Z0-9_-]/g, "_")}`;
  // 保留项在前：勾选/单选的文档顺序与建议语义一致，批量断言与屏幕阅读器
  // 都按“先保留、后跳过”读取。
  const members = [group.keepCandidateId, ...group.skipCandidateIds];
  return (
    <section aria-labelledby={headingId} className="sh-import-conflicts__batch-group">
      <h3 id={headingId}>{t("importWorkflow.conflicts.batch.sameContentTitle")}</h3>
      <p>{t("importWorkflow.conflicts.batch.sameContentDescription")}</p>
      <ul className="sh-import-conflicts__list">
        {members.map((memberId) => {
          const label = labels.get(memberId);
          const isKeep = memberId === group.keepCandidateId;
          return (
            <li className="sh-import-conflicts__item" key={memberId}>
              <div className="sh-import-conflicts__summary">
                <strong>{label?.name ?? memberId}</strong>
                <StatusBadge tone={isKeep ? "info" : "neutral"}>
                  {isKeep
                    ? t("importWorkflow.conflicts.batch.keepBadge")
                    : t("importWorkflow.conflicts.batch.skipBadge")}
                </StatusBadge>
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
                  {(["copy", "skip"] as ImportAction[]).map((action) => (
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

/**
 * 冲突决策区：筛选、批量与逐项决策语义保持不变；
 * 返回/提交等流程动作在向导底部操作区。
 *
 * 第 24 节（流程重组）：危险级安全决策区块搬迁至向导的安全检测步
 * （SecurityDecisionSection.tsx），本组件只承载冲突维度——批内同内容/同名
 * 分组与库内冲突区（BatchSameNameSection/LibraryConflictsSection 已搬迁为
 * 独立组件文件，此处仅组合）。
 */
export function ConflictResolution({
  conflicts,
  actions,
  onAction,
  batchAnalysis,
  candidates,
  overrides = {},
  onOverrideName,
}: ConflictResolutionProps) {
  const { t } = useTranslation();

  const batchLabels = useMemo(
    () =>
      new Map(
        (candidates ?? []).map(
          (candidate): [string, BatchCandidateLabel] => [
            candidate.id,
            { name: candidate.name, path: candidate.path },
          ],
        ),
      ),
    [candidates],
  );
  // 即时重名校验需要全部批内候选的发现名（含同组兄弟与同批其他组）。
  const batchCandidateNames = useMemo(
    () => Object.fromEntries((candidates ?? []).map((candidate) => [candidate.id, candidate.name])),
    [candidates],
  );
  const batchSections = useMemo(() => {
    if (!batchAnalysis) return [];
    return [
      ...batchAnalysis.sameContentGroups.map((group) => ({
        kind: "same-content" as const,
        key: `same-content:${group.normalizedRuntimeName}:${group.keepCandidateId}`,
        group,
      })),
      ...batchAnalysis.sameNameGroups.map((group) => ({
        kind: "same-name" as const,
        key: `same-name:${group.normalizedRuntimeName}`,
        group,
      })),
    ];
  }, [batchAnalysis]);

  return (
    <section className="sh-import-conflicts" aria-labelledby="import-conflicts-title">
      <div className="sh-import-conflicts__heading">
        <div>
          <p className="sh-import-conflicts__eyebrow">{t("importWorkflow.conflicts.eyebrow")}</p>
          <h2 id="import-conflicts-title">{t("importWorkflow.conflicts.title")}</h2>
          <p>{t("importWorkflow.conflicts.description")}</p>
        </div>
      </div>

      {batchSections.length ? (
        <div className="sh-import-conflicts__batch-sections">
          {batchSections.map((section) =>
            section.kind === "same-content" ? (
              <BatchSameContentSection
                actions={actions}
                group={section.group}
                key={section.key}
                labels={batchLabels}
                onAction={onAction}
              />
            ) : (
              <BatchSameNameSection
                actions={actions}
                candidateNames={batchCandidateNames}
                conflicts={conflicts}
                group={section.group}
                key={section.key}
                labels={batchLabels}
                onAction={onAction}
                onOverrideName={onOverrideName}
                overrides={overrides}
              />
            ),
          )}
        </div>
      ) : null}

      {conflicts.length ? (
        <LibraryConflictsSection
          actions={actions}
          conflicts={conflicts}
          onAction={onAction}
        />
      ) : batchSections.length ? null : (
        <p className="sh-import-conflicts__empty" role="status">
          {t("importWorkflow.conflicts.none")}
        </p>
      )}
    </section>
  );
}
