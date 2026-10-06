import { useState } from "react";
import { useTranslation } from "react-i18next";
import { StatusBadge } from "../../ui/StatusBadge";
import type {
  ImportSecurityDecision,
  ImportSecurityFindingView,
  ImportSecurityPlan,
  ImportSecuritySummaryView,
} from "./api";
import type { BatchCandidateLabel } from "./batchCandidateLabel";

/** bindings 中已知的基础检查规则码集合；用于把规则码映射为可读名称。 */
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

/**
 * W3-1（FB-003）：危险级安全风险的显式决策区块——自 ConflictResolution.tsx
 * 拆分为独立组件，在安全检测步渲染。§24（2026-10-06）呈现收口：
 * 1) 危险级决策列表只渲染 productLevel=danger 的发现（警告级发现不进入
 *    危险级决策列表）；明细按规则聚合为"规则 × 命中处数"，附首条文件/行
 *    位置，逐行位置收进可展开的次级视图；
 * 2) 警告级名单按 Skill 身份去重（规范化 runtime 名，与后端
 *    normalize_runtime_name 同口径），同身份多来源条目合并为一条并显示
 *    来源数，计数按去重后口径；警告级默认导入并写入预警，提供整体继续/
 *    整体跳过/逐个调整三档，不是逐条确认门禁；
 * 3) 裁决③：危险级候选内的警告级发现不静默消失——卡内汇总计数提示，
 *    导入"仍然导入"后照常写入预警。
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

export function SecurityDecisionSection({
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
