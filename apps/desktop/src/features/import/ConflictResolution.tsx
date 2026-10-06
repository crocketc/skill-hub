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
  ImportSecurityDecision,
  ImportSecurityFindingView,
  ImportSecurityPlan,
  ImportSecuritySummaryView,
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
  /**
   * W3-1（FB-003）：prepare 阶段的安全分级摘要。缺省（宿主未提供）时
   * 不渲染安全区块，行为与既有版本一致；提交期门禁由后端错误码把守。
   */
  security?: ImportSecurityPlan;
  /** candidateId → 危险级候选的安全决策（受控值由向导持有）。 */
  securityDecisions?: Record<string, ImportSecurityDecision>;
  onSecurityDecision?: (candidateId: string, decision: ImportSecurityDecision) => void;
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

/**
 * W3-1：basic-v1 规则码的当前集合。已知码映射为可读名称；未知码诚实
 * 兜底（携带原始码），绝不渲染 finding 序号等内部标识。
 */
const knownFindingCodes = [
  "security.command_interpolation",
  "security.destructive_command",
  "security.download_and_execute",
  "security.data_upload",
  "security.elevation",
  "security.obfuscation",
  "security.path_traversal",
  "security.permission_change",
  "security.persistence",
  "security.possible_plaintext_credential",
  "security.prompt_injection",
  "security.suspicious_external_resource",
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
 * W3-1（FB-003）：危险级安全风险的显式决策区块——处置环节内联呈现，置顶
 * （风险先于冲突）。§24（2026-10-06）呈现收口：
 * 1) 危险级决策列表只渲染 productLevel=danger 的发现（警告级发现不进入
 *    危险级决策列表）；明细按规则聚合为"规则 × 命中处数"，附首条文件/行
 *    位置，逐行位置收进可展开的次级视图；
 * 2) 警告级名单按 Skill 身份去重（规范化 runtime 名，与后端
 *    normalize_runtime_name 同口径），同身份多来源条目合并为一条并显示
 *    来源数，计数按去重后口径；警告级默认导入并写入预警，提供整体继续/
 *    整体跳过/逐个调整三档，不是逐条确认门禁。
 * 每个危险级候选仍要求在“仍然导入 / 不导入”之间显式决策，没有静默默认；
 * “不导入”透传 security_decision=skip，由后端按跳过落账（不落库）。
 */

/** §24：危险级发现的规则聚合组（组内发现按后端稳定排序保持原顺序）。 */
interface RuleFindingGroup {
  code: string;
  hits: ImportSecurityFindingView[];
}

/** 只聚合 productLevel=danger 的发现；警告级发现不进入危险级决策列表。 */
function groupDangerFindingsByRule(findings: ImportSecurityFindingView[]): RuleFindingGroup[] {
  const byCode = new Map<string, ImportSecurityFindingView[]>();
  for (const finding of findings) {
    if (finding.productLevel !== "danger") continue;
    const hits = byCode.get(finding.code) ?? [];
    hits.push(finding);
    byCode.set(finding.code, hits);
  }
  return [...byCode.entries()].map(([code, hits]) => ({ code, hits }));
}

/** 发现的"文件:行"呈现位置；无文件事实时返回 null，由调用方诚实兜底。 */
function findingLocation(finding: ImportSecurityFindingView): string | null {
  if (!finding.file) return null;
  return finding.lineStart != null ? `${finding.file}:${finding.lineStart}` : finding.file;
}

/** §24：警告级名单的身份合并组——key 为规范化 runtime 名（无名称数据时退化为逐候选条目）。 */
interface WarningIdentityGroup {
  key: string;
  displayName: string;
  memberIds: string[];
}

function dedupeWarningEntries(
  entries: Array<[string, ImportSecuritySummaryView]>,
  labels: ReadonlyMap<string, BatchCandidateLabel>,
): WarningIdentityGroup[] {
  const groups = new Map<string, WarningIdentityGroup>();
  for (const [candidateId] of entries) {
    const name = labels.get(candidateId)?.name ?? "";
    // 身份口径与后端 normalize_runtime_name 一致：trim + 小写。
    const key = name.trim().length > 0 ? `name:${name.trim().toLowerCase()}` : `id:${candidateId}`;
    const existing = groups.get(key);
    if (existing) {
      existing.memberIds.push(candidateId);
    } else {
      groups.set(key, {
        displayName: name.length > 0 ? name : candidateId,
        key,
        memberIds: [candidateId],
      });
    }
  }
  return [...groups.values()];
}

/** §24：警告级批量语义三档（整体继续=默认，整体跳过，逐个调整）。 */
type WarningTier = "continue" | "skip" | "individual";

const warningTierOptions: WarningTier[] = ["continue", "skip", "individual"];

function SecurityDecisionSection({
  summaries,
  labels,
  decisions,
  onSecurityDecision,
}: {
  summaries: ImportSecurityPlan;
  labels: ReadonlyMap<string, BatchCandidateLabel>;
  decisions: Record<string, ImportSecurityDecision>;
  onSecurityDecision?: (candidateId: string, decision: ImportSecurityDecision) => void;
}) {
  const { t } = useTranslation();
  const [adjustingIndividually, setAdjustingIndividually] = useState(false);
  // 已知规则码收敛到嵌套键；未知码走带占位符的兜底文案，绝不裸露内部 id。
  const findingLabel = (code: string): string =>
    (knownFindingCodes as readonly string[]).includes(code)
      ? t(`importWorkflow.conflicts.security.findings.${code}` as never)
      : t("importWorkflow.conflicts.security.findings.unknown", { code });

  const dangerEntries = Object.entries(summaries).filter(
    ([, summary]) => summary.level === "danger",
  );
  const warningEntries = Object.entries(summaries).filter(
    ([, summary]) => summary.level === "warning",
  );
  const warningGroups = dedupeWarningEntries(warningEntries, labels);
  const warningMemberIds = warningGroups.flatMap((group) => group.memberIds);
  // 档位由受控决策推导（不重复持有第二份状态）：全部跳过=整体跳过；
  // 出现任何跳过（或用户进入逐个调整）=逐个调整；其余（含全 proceed/未
  // 决策）=整体继续。混合状态回显“逐个调整”并揭示逐条决策项，不假装仍
  // 处于默认档。
  const warningTier: WarningTier = warningMemberIds.every((id) => decisions[id] === "skip")
    && warningMemberIds.length > 0
    ? "skip"
    : warningMemberIds.some((id) => decisions[id] === "skip") || adjustingIndividually
      ? "individual"
      : "continue";
  if (dangerEntries.length === 0 && warningEntries.length === 0) return null;

  const applyWarningTier = (tier: WarningTier) => {
    if (tier === "individual") {
      setAdjustingIndividually(true);
      return;
    }
    setAdjustingIndividually(false);
    // 三档批量语义作用于全部警告级来源条目；默认档显式写入 proceed，
    // 使"整体继续"成为留痕决策而不是无记录的静默默认。
    for (const candidateId of warningMemberIds) {
      onSecurityDecision?.(candidateId, tier === "continue" ? "proceed" : "skip");
    }
  };

  const warningEntryDecision = (group: WarningIdentityGroup): ImportSecurityDecision | undefined => {
    if (group.memberIds.every((id) => decisions[id] === "skip")) return "skip";
    if (group.memberIds.every((id) => decisions[id] === "proceed")) return "proceed";
    return undefined;
  };

  return (
    <div className="sh-import-conflicts__security">
      {dangerEntries.length ? (
        <section aria-labelledby="import-security-danger-title" className="sh-import-conflicts__security-group">
          <h3 id="import-security-danger-title">
            {t("importWorkflow.conflicts.security.dangerTitle")}
          </h3>
          <p>{t("importWorkflow.conflicts.security.dangerDescription")}</p>
          <ul className="sh-import-conflicts__list">
            {dangerEntries.map(([candidateId, summary]) => {
              const label = labels.get(candidateId);
              // §24：只渲染危险级发现；警告级发现不进入危险级决策列表。
              const ruleGroups = groupDangerFindingsByRule(summary.findings);
              // §24 裁决③（2026-10-06）：警告级发现不静默消失——卡内汇总计数，
              // 导入"仍然导入"后照常写入预警。
              const warningCount = summary.findings.filter(
                (finding) => finding.productLevel === "warning",
              ).length;
              return (
                <li className="sh-import-conflicts__item" key={candidateId}>
                  <div className="sh-import-conflicts__summary">
                    <strong>{label?.name ?? candidateId}</strong>
                    <StatusBadge tone="danger">
                      {t("importWorkflow.conflicts.security.level.danger")}
                    </StatusBadge>
                    {ruleGroups.length ? (
                      <>
                        <p>
                          <span>{t("importWorkflow.conflicts.security.findingsLabel")}</span>
                        </p>
                        <ul className="sh-import-conflicts__findings">
                          {ruleGroups.map((group) => {
                            const firstLocation = findingLocation(group.hits[0]);
                            return (
                              <li key={group.code}>
                                <div className="sh-import-conflicts__finding-rule">
                                  <span>{findingLabel(group.code)}</span>
                                  <StatusBadge tone="danger">
                                    {t("importWorkflow.conflicts.security.findingsHitCount", {
                                      count: group.hits.length,
                                    })}
                                  </StatusBadge>
                                  {firstLocation ? (
                                    <code title={firstLocation}>{firstLocation}</code>
                                  ) : null}
                                </div>
                                {group.hits.length > 1 ? (
                                  // §24：逐行位置是次级明细——折叠进可展开
                                  // 视图，主信息保持"规则 × 处数 + 首条位置"。
                                  <details className="sh-import-conflicts__details">
                                    <summary>
                                      {t("importWorkflow.conflicts.security.findingsDetailsToggle")}
                                    </summary>
                                    <ul className="sh-import-conflicts__finding-locations">
                                      {group.hits.map((hit, index) => {
                                        const location = findingLocation(hit);
                                        return (
                                          <li key={`${group.code}-${index}`}>
                                            {location ? (
                                              <code title={location}>{location}</code>
                                            ) : (
                                              <span>{t("security.locationUnknown")}</span>
                                            )}
                                          </li>
                                        );
                                      })}
                                    </ul>
                                  </details>
                                ) : null}
                              </li>
                            );
                          })}
                        </ul>
                      </>
                    ) : null}
                    {warningCount ? (
                      <p className="sh-import-conflicts__danger-warnings-note">
                        {t("importWorkflow.conflicts.security.dangerExtraWarnings", {
                          count: warningCount,
                        })}
                      </p>
                    ) : null}
                  </div>
                  <fieldset>
                    <legend>{t("importWorkflow.conflicts.security.chooseLabel")}</legend>
                    <div className="sh-import-conflicts__options">
                      {(["proceed", "skip"] as ImportSecurityDecision[]).map((decision) => (
                        <div className="sh-import-conflicts__option" key={decision}>
                          <label>
                            <input
                              checked={decisions[candidateId] === decision}
                              name={`security-${candidateId}`}
                              onChange={() => onSecurityDecision?.(candidateId, decision)}
                              type="radio"
                            />
                            {t(decision === "proceed"
                              ? "importWorkflow.conflicts.security.proceedLabel"
                              : "importWorkflow.conflicts.security.skipLabel")}
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
      ) : null}
      {warningGroups.length ? (
        <section aria-labelledby="import-security-warning-title" className="sh-import-conflicts__security-group">
          <h3 id="import-security-warning-title">
            {t("importWorkflow.conflicts.security.warningTitle")}
          </h3>
          <p>
            {t("importWorkflow.conflicts.security.warningSummary", {
              count: warningGroups.length,
            })}
          </p>
          <fieldset>
            <legend>{t("importWorkflow.conflicts.security.warningTierLabel")}</legend>
            <div className="sh-import-conflicts__options">
              {warningTierOptions.map((tier) => (
                <div className="sh-import-conflicts__option" key={tier}>
                  <label>
                    <input
                      checked={warningTier === tier}
                      name="security-warning-tier"
                      onChange={() => applyWarningTier(tier)}
                      type="radio"
                    />
                    {t(`importWorkflow.conflicts.security.warningTier.${tier}`)}
                  </label>
                </div>
              ))}
            </div>
          </fieldset>
          <ul className="sh-import-conflicts__list">
            {warningGroups.map((group) => {
              const entryDecision = warningEntryDecision(group);
              return (
                <li key={group.key}>
                  <div className="sh-import-conflicts__summary">
                    <strong>{group.displayName}</strong>
                    {group.memberIds.length > 1 ? (
                      <StatusBadge tone="neutral">
                        {t("importWorkflow.conflicts.security.warningSourceCount", {
                          count: group.memberIds.length,
                        })}
                      </StatusBadge>
                    ) : null}
                  </div>
                  {warningTier === "individual" ? (
                    <fieldset>
                      <legend>{t("importWorkflow.conflicts.security.chooseLabel")}</legend>
                      <div className="sh-import-conflicts__options">
                        {(["proceed", "skip"] as ImportSecurityDecision[]).map((decision) => (
                          <div className="sh-import-conflicts__option" key={decision}>
                            <label>
                              <input
                                checked={entryDecision === decision}
                                name={`security-warning-${group.key}`}
                                onChange={() => {
                                  for (const candidateId of group.memberIds) {
                                    onSecurityDecision?.(candidateId, decision);
                                  }
                                }}
                                type="radio"
                              />
                              {t(decision === "proceed"
                                ? "importWorkflow.conflicts.security.proceedLabel"
                                : "importWorkflow.conflicts.security.skipLabel")}
                            </label>
                          </div>
                        ))}
                      </div>
                    </fieldset>
                  ) : null}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </div>
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
  security,
  securityDecisions = {},
  onSecurityDecision,
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

      {security ? (
        <SecurityDecisionSection
          decisions={securityDecisions}
          labels={batchLabels}
          onSecurityDecision={onSecurityDecision}
          summaries={security}
        />
      ) : null}

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
