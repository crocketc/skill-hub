import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui/Button";
import { StatusBadge } from "../../ui/StatusBadge";
import type {
  ConflictKind,
  ImportAction,
  ImportBatchAnalysis,
  ImportCandidate,
  ImportConflict,
} from "./api";
import { overrideNameCollision, type OverrideCollision } from "./batchDispositions";

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

interface BatchCandidateLabel {
  name: string;
  path?: string | null;
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
 * W2-2：批内同名不同内容组——成员必须逐项显式处置（独立命名或跳过），
 * 没有任何静默默认；独立命名提供内联输入与即时碰撞反馈（最终裁决仍由
 * 提交期的后端错误码给出）。
 */
function BatchSameNameSection({
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

/**
 * 冲突决策区：筛选、批量与逐项决策语义保持不变；
 * 返回/提交等流程动作在向导底部操作区。
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
  // AR-010：先按冲突原因类别筛选，再为该类别批量选择处理方式。
  const [kindFilter, setKindFilter] = useState<"all" | ConflictKind>("all");
  const [batchAction, setBatchAction] = useState<ImportAction | "">("");

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
                        {conflict.matchedSkills && conflict.matchedSkills.length ? (
                          <div>
                            <p>
                              <span>{t("importWorkflow.conflicts.matchedWith")}</span>
                            </p>
                            <ul>
                              {conflict.matchedSkills.map((skill) => (
                                <li key={skill.id}>
                                  <strong>{skill.displayName}</strong>
                                  {skill.runtimeName !== skill.displayName ? (
                                    <span> ({skill.runtimeName})</span>
                                  ) : null}
                                  {skill.source ? (
                                    <code title={skill.source}> · {skill.source}</code>
                                  ) : null}
                                </li>
                              ))}
                            </ul>
                          </div>
                        ) : conflict.matchedSkillIds && conflict.matchedSkillIds.length ? (
                          <p>
                            <span>{t("importWorkflow.conflicts.matchedWith")}</span>
                            {conflict.matchedSkillIds.map((skillId) => (
                              <code key={skillId}>{skillId}</code>
                            ))}
                          </p>
                        ) : null}
                        {conflict.summary ? (
                          // M-14：详情入口——技术诊断（reason code、差异类型）
                          // 折叠在 details 中，主信息保持名称/路径/差异可读。
                          <details className="sh-import-conflicts__details">
                            <summary>{t("importWorkflow.conflicts.detailsToggle")}</summary>
                            <p className="sh-import-conflicts__diagnostic">
                              <span>{t("importWorkflow.conflicts.diagnosticsLabel")}</span>
                              <code>{conflict.summary}</code>
                              {conflict.duplicateKind ? <code>{conflict.duplicateKind}</code> : null}
                            </p>
                          </details>
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
      ) : batchSections.length ? null : (
        <p className="sh-import-conflicts__empty" role="status">
          {t("importWorkflow.conflicts.none")}
        </p>
      )}
    </section>
  );
}
