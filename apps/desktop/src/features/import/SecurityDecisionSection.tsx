import { useTranslation } from "react-i18next";
import { StatusBadge } from "../../ui/StatusBadge";
import type { ImportSecurityDecision, ImportSecurityPlan } from "./api";
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
 * W3-1（FB-003）：危险级安全风险的显式决策区块——处置环节内联呈现，置顶
 * （风险先于冲突）。每个危险级候选展示完整发现明细（候选名 + 可读规则名 +
 * 文件/行号），并要求在“仍然导入 / 不导入”之间显式决策，没有静默默认。
 * “不导入”透传 security_decision=skip，由后端按跳过落账（不落库）。
 *
 * 第 24 节：本区块自 ConflictResolution.tsx 原样搬迁至安全检测步渲染，
 * 内部逻辑与文案键保持不变。
 */
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
  if (dangerEntries.length === 0 && warningEntries.length === 0) return null;

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
              return (
                <li className="sh-import-conflicts__item" key={candidateId}>
                  <div className="sh-import-conflicts__summary">
                    <strong>{label?.name ?? candidateId}</strong>
                    <StatusBadge tone="danger">
                      {t("importWorkflow.conflicts.security.level.danger")}
                    </StatusBadge>
                    {summary.findings.length ? (
                      <>
                        <p>
                          <span>{t("importWorkflow.conflicts.security.findingsLabel")}</span>
                        </p>
                        <ul className="sh-import-conflicts__findings">
                          {summary.findings.map((finding, index) => (
                            <li key={`${finding.code}-${index}`}>
                              <span>{findingLabel(finding.code)}</span>
                              {finding.file ? (
                                <code title={finding.file}>
                                  {finding.file}
                                  {finding.lineStart != null ? `:${finding.lineStart}` : ""}
                                </code>
                              ) : null}
                            </li>
                          ))}
                        </ul>
                      </>
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
      {warningEntries.length ? (
        <section aria-labelledby="import-security-warning-title" className="sh-import-conflicts__security-group">
          <h3 id="import-security-warning-title">
            {t("importWorkflow.conflicts.security.warningTitle")}
          </h3>
          <p>
            {t("importWorkflow.conflicts.security.warningSummary", {
              count: warningEntries.length,
            })}
          </p>
          <ul className="sh-import-conflicts__list">
            {warningEntries.map(([candidateId]) => {
              const label = labels.get(candidateId);
              return (
                <li key={candidateId}>
                  <strong>{label?.name ?? candidateId}</strong>
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
