import { useEffect, useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import type {
  AnalyzeConflictScope,
  ConflictAnalysis,
} from "../../api/bindings";
import { describeNativeError } from "../../api/nativeErrors";
import { Button } from "../../ui/Button";
import { StatusBadge } from "../../ui/StatusBadge";
import {
  conflictClassificationLabelKey,
} from "../relationshipGovernance/relationshipGovernance";
import {
  type SemanticDuplicateReport,
  type SkillDetailFacade,
} from "./api";

const recommendedActionKeys: Record<ConflictAnalysis["cases"][number]["recommended_action"], string> = {
  same_skill_version: "relationshipGovernance.conflictAnalysis.action.same_skill_version",
  distinct_skill: "relationshipGovernance.conflictAnalysis.action.distinct_skill",
  keep_uncertain: "relationshipGovernance.conflictAnalysis.action.keep_uncertain",
};

interface SemanticDuplicatePanelProps {
  facade: SkillDetailFacade;
  skillId: string;
  /** P1-12：来自 getInsights 的确定性重复候选（内容比对产物，与 AI 无关），
   * 页面加载即常显；可选 AI 分析在其上作为增强层，由用户显式触发。 */
  deterministicCandidates?: string[];
}

/** Optional AI layer over the deterministic duplicate candidates (US-018).
 * The panel is user-initiated, shows the deterministic candidates even when
 * the AI layer fails, and never performs any action by itself: merging,
 * deleting or archiving always stays a separate explicit user decision.
 * Task 8：AI 可用性接真实供应商信号；并新增 Skill 维度冲突分析入口。 */
export function SemanticDuplicatePanel({
  deterministicCandidates = [],
  facade,
  skillId,
}: SemanticDuplicatePanelProps): JSX.Element {
  const { t } = useTranslation();
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<SemanticDuplicateReport>();
  const [error, setError] = useState<string>();
  // null 表示可用性查询尚未返回：按钮暂不可点，但不显示不可用文案。
  const [aiAvailable, setAiAvailable] = useState<boolean | null>(null);
  const [conflictRunning, setConflictRunning] = useState(false);
  const [conflictAnalysis, setConflictAnalysis] = useState<ConflictAnalysis>();
  const [conflictError, setConflictError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    facade
      .isAiAvailable()
      .then((available) => {
        if (!cancelled) setAiAvailable(available);
      })
      .catch(() => {
        if (!cancelled) setAiAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, [facade]);

  const describeError = (reason: unknown) =>
    describeNativeError(
      reason,
      (key, options) => String(t(key as never, options as never)),
      "skillDetail.duplicates.failureUnknown",
    );

  const run = () => {
    if (running) return;
    setRunning(true);
    setError(undefined);
    facade
      .analyzeSemanticDuplicates(skillId)
      .then(setReport)
      // 结构化 AppError 直接 String() 会变成 "[object Object]"；
      // 统一走分类文案，并明确确定性候选不受影响。
      .catch((reason: unknown) => setError(describeError(reason)))
      .finally(() => setRunning(false));
  };

  const runConflictAnalysis = (scope: AnalyzeConflictScope) => {
    if (conflictRunning) return;
    setConflictRunning(true);
    setConflictError(undefined);
    facade
      .analyzeConflicts(scope)
      .then(setConflictAnalysis)
      .catch((reason: unknown) => setConflictError(describeError(reason)))
      .finally(() => setConflictRunning(false));
  };

  const aiUnavailableCopy = aiAvailable === false;

  return (
    <section aria-labelledby="deterministic-duplicates-heading" className="sh-detail-insights">
      {/* 上段：确定性候选常显（数据来自 getInsights，无需点击，也不依赖 LLM）。 */}
      <div className="sh-metadata-panel__section-heading">
        <h3 id="deterministic-duplicates-heading">
          {t("skillDetail.duplicates.deterministicHeading")}
        </h3>
      </div>
      <p className="sh-settings-local-note">{t("skillDetail.duplicates.deterministicHint")}</p>
      {deterministicCandidates.length ? (
        <ul aria-label={t("skillDetail.duplicates.deterministicHeading")}>
          {deterministicCandidates.map((candidate) => (
            <li key={candidate}>{candidate}</li>
          ))}
        </ul>
      ) : (
        <p>{t("skillDetail.duplicates.noCandidates")}</p>
      )}
      {/* 下段：可选 AI 语义分析（用户显式触发；确定性结果不依赖它）。 */}
      <div className="sh-metadata-panel__section-heading">
        <h3 id="semantic-duplicates-heading">{t("skillDetail.duplicates.heading")}</h3>
        <Button
          disabled={running || aiUnavailableCopy}
          loading={running}
          onClick={run}
          size="sm"
          variant="ghost"
        >
          {t("skillDetail.duplicates.run")}
        </Button>
      </div>
      <p className="sh-settings-local-note">{t("skillDetail.duplicates.scopeNote")}</p>
      {aiUnavailableCopy ? (
        <p role="status">{t("skillDetail.duplicates.aiUnavailable")}</p>
      ) : null}
      {error ? (
        <>
          <p role="alert">{t("skillDetail.duplicates.runFailed", { message: error })}</p>
          <p role="status">{t("skillDetail.duplicates.deterministicNote")}</p>
        </>
      ) : null}
      {report ? (
        <>
          <p>
            {report.source === "llm"
              ? t("skillDetail.duplicates.sourceLlm")
              : t("skillDetail.duplicates.sourceDeterministic")}
          </p>
          {report.failureCode ? (
            <>
              {/* reason 自成立句、“确定性候选不受影响”独立成句渲染：
                  分隔不依赖 keyed 文案自带句尾标点的隐式不变量。 */}
              <p role="status">
                {t("skillDetail.duplicates.failureReason", {
                  reason: describeError({
                    code: report.failureCode,
                    severity: "error",
                    params: {},
                    actions: [],
                  }),
                })}
              </p>
              <p role="status">
                {t("skillDetail.duplicates.deterministicUnaffected")}
              </p>
            </>
          ) : null}
          {report.candidates.length ? (
            <section>
              <h4>{t("skillDetail.duplicates.candidates")}</h4>
              <ul aria-label={t("skillDetail.duplicates.candidates")}>
                {report.candidates.map((candidate) => (
                  <li key={candidate.id}>
                    <strong>{candidate.name}</strong>
                    <span> · {candidate.description}</span>
                    {candidate.locallyModified ? (
                      <StatusBadge tone="warning">{t("skillDetail.duplicates.locallyModified")}</StatusBadge>
                    ) : null}
                  </li>
                ))}
              </ul>
            </section>
          ) : (
            <p>{t("skillDetail.duplicates.noCandidates")}</p>
          )}
          <p className="sh-settings-local-note">{t("skillDetail.duplicates.confirmationNote")}</p>
        </>
      ) : null}
      {/* 下段：Skill 维度可选冲突分析（Task 8）。确定性冲突分组先于 AI 结论。 */}
      <div className="sh-metadata-panel__section-heading">
        <h3 id="skill-conflicts-heading">{t("skillDetail.conflicts.heading")}</h3>
        <Button
          disabled={conflictRunning || aiUnavailableCopy}
          loading={conflictRunning}
          onClick={() =>
            runConflictAnalysis({ type: "skill", value: { skill_id: skillId } })
          }
          size="sm"
          variant="ghost"
        >
          {t("skillDetail.conflicts.run")}
        </Button>
      </div>
      <p className="sh-settings-local-note">{t("skillDetail.conflicts.scopeNote")}</p>
      {aiUnavailableCopy ? (
        <p role="status">{t("skillDetail.conflicts.aiUnavailable")}</p>
      ) : null}
      {conflictError ? (
        <>
          <p role="alert">
            {t("skillDetail.conflicts.failureReason", { reason: conflictError })}
          </p>
          <p role="status">{t("skillDetail.conflicts.deterministicNote")}</p>
        </>
      ) : null}
      {conflictAnalysis ? (
        <div data-testid="conflict-analysis-result">
          <p>
            {conflictAnalysis.source === "llm"
              ? t("relationshipGovernance.conflictAnalysis.sourceLlm")
              : t("relationshipGovernance.conflictAnalysis.sourceDeterministic")}
          </p>
          {conflictAnalysis.failure_code ? (
            <>
              <p role="alert">
                {t("skillDetail.conflicts.failureReason", {
                  reason: describeError({
                    code: conflictAnalysis.failure_code,
                    severity: "error",
                    params: {},
                    actions: [],
                  }),
                })}
              </p>
              <p role="status">{t("skillDetail.conflicts.deterministicNote")}</p>
            </>
          ) : null}
          {conflictAnalysis.skipped_decided_cases > 0 ? (
            <p role="status">
              {t("relationshipGovernance.conflictAnalysis.skippedDecided", {
                count: conflictAnalysis.skipped_decided_cases,
              })}
            </p>
          ) : null}
          {conflictAnalysis.cases.length === 0 && !conflictAnalysis.failure_code ? (
            <p>{t("skillDetail.conflicts.empty")}</p>
          ) : (
            <ul>
              {conflictAnalysis.cases.map((conclusion) => (
                <li key={conclusion.conflict_id}>
                  <strong>
                    {t("skillDetail.conflicts.caseHeading", {
                      id: conclusion.conflict_id,
                    })}
                  </strong>
                  <span>
                    {" "}
                    {t("relationshipGovernance.conflictAnalysis.baselineLabel")}{" "}
                    {t(conflictClassificationLabelKey(conclusion.baseline_classification) as never)}
                  </span>
                  <p>{conclusion.summary}</p>
                  <p>
                    {t("relationshipGovernance.conflictAnalysis.recommendedAction", {
                      action: t(
                        recommendedActionKeys[conclusion.recommended_action] as never,
                      ),
                    })}
                  </p>
                  {conclusion.recommended_keep_member ? (
                    <p>
                      {t("relationshipGovernance.conflictAnalysis.recommendedKeep", {
                        member: conclusion.recommended_keep_member,
                      })}
                    </p>
                  ) : null}
                  {conclusion.key_evidence.length ? (
                    <p>{conclusion.key_evidence.join("；")}</p>
                  ) : null}
                  {conclusion.uncertainties.length ? (
                    <p>
                      {t("relationshipGovernance.conflictAnalysis.uncertainties")}：
                      {conclusion.uncertainties.join("；")}
                    </p>
                  ) : null}
                  <p>
                    {t("relationshipGovernance.conflictAnalysis.confidence", {
                      value: conclusion.confidence,
                    })}
                  </p>
                </li>
              ))}
            </ul>
          )}
          <p className="sh-settings-local-note">
            {t("relationshipGovernance.conflictAnalysis.advisoryNote")}
          </p>
        </div>
      ) : null}
    </section>
  );
}
