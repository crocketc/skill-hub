import type { JSX } from "react";
import { useTranslation } from "react-i18next";
import type { ConflictAnalysisRecord } from "../../../api/bindings";
import { describeNativeError } from "../../../api/nativeErrors";
import { StatusBadge } from "../../../ui/StatusBadge";
import { conflictClassificationLabelKey } from "../../relationshipGovernance/relationshipGovernance";

export interface ConflictAiConclusionProps {
  /** 一次已持久化的分析记录；结论与基线都在记录上。 */
  record: ConflictAnalysisRecord;
  /** 输入指纹已过期：旧结论标注失效，且不再展示可执行建议行。 */
  stale?: boolean;
}

/**
 * 可复用的只读 AI 结论展示（任务 7 从旧面板提取，归冲突处理模块所有）：
 * 确定性基线永远先于 AI 结论；过期记录明确标注且不给出可执行建议；
 * 本组件绝不渲染任何动作按钮——执行永远由使用方显式提供。
 */
export function ConflictAiConclusion({
  record,
  stale = false,
}: ConflictAiConclusionProps): JSX.Element {
  const { t } = useTranslation();
  const conclusion = record.conclusion;
  const failureReason = record.failure_code
    ? describeNativeError(
        {
          code: record.failure_code,
          severity: "error",
          params: {},
          actions: [],
        },
        (key, options) => String(t(key as never, options as never)),
        "relationships.decisions.ai.failureUnknown",
      )
    : null;

  return (
    <div className="sh-conflict-ai-conclusion" data-testid="conflict-ai-conclusion">
      <p className="sh-conflict-ai-conclusion__source">
        {record.source === "llm"
          ? t("relationships.decisions.ai.sourceLlm")
          : t("relationships.decisions.ai.sourceDeterministic")}
      </p>
      {stale ? (
        <>
          <p>
            <StatusBadge tone="warning">{t("relationships.decisions.ai.staleBadge")}</StatusBadge>
          </p>
          <p role="status" className="sh-settings-local-note">
            {t("relationships.decisions.ai.staleNotice")}
          </p>
        </>
      ) : null}
      {failureReason ? (
        <>
          <p role="alert">
            {t("relationships.decisions.ai.failureReason", { reason: failureReason })}
          </p>
          <p role="status" className="sh-settings-local-note">
            {t("relationships.decisions.ai.deterministicNote")}
          </p>
        </>
      ) : null}
      {!conclusion ? (
        <p>{t("relationships.decisions.ai.noConclusion")}</p>
      ) : (
        <>
          <p className="sh-conflict-ai-conclusion__baseline">
            <span className="sh-settings-local-note">
              {t("relationships.decisions.ai.baselineLabel")}
            </span>{" "}
            {t(conflictClassificationLabelKey(conclusion.baseline_classification) as never)}
          </p>
          <p className="sh-conflict-ai-conclusion__summary">{conclusion.summary}</p>
          {/* 过期结论只保留背景信息：建议行是可执行计划，过期时不再展示。 */}
          {!stale ? (
            <>
              <p>
                {t("relationships.decisions.ai.recommendedAction", {
                  action: t(
                    `relationships.decisions.ai.action.${conclusion.recommended_action}` as never,
                  ),
                })}
              </p>
              {conclusion.recommended_keep_member ? (
                <p>
                  {t("relationships.decisions.ai.recommendedKeep", {
                    member: conclusion.recommended_keep_member,
                  })}
                </p>
              ) : null}
            </>
          ) : null}
          {conclusion.key_evidence.length ? (
            <section>
              <h4>{t("relationships.decisions.ai.keyEvidence")}</h4>
              <ul>
                {conclusion.key_evidence.map((entry) => (
                  <li key={entry}>{entry}</li>
                ))}
              </ul>
            </section>
          ) : null}
          {conclusion.uncertainties.length ? (
            <section>
              <h4>{t("relationships.decisions.ai.uncertainties")}</h4>
              <ul>
                {conclusion.uncertainties.map((entry) => (
                  <li key={entry}>{entry}</li>
                ))}
              </ul>
            </section>
          ) : null}
          <p className="sh-settings-local-note">
            {t("relationships.decisions.ai.confidence", { value: conclusion.confidence })}
          </p>
        </>
      )}
      <p className="sh-settings-local-note">{t("relationships.decisions.ai.advisoryNote")}</p>
    </div>
  );
}
