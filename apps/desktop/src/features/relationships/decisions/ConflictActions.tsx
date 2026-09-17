import type { JSX } from "react";
import { useTranslation } from "react-i18next";
import type { ConflictWorkspaceCase } from "../../../api/bindings";
import { describeNativeError } from "../../../api/nativeErrors";
import { Button } from "../../../ui/Button";
import {
  allConflictScope,
  caseConflictScope,
  categoryConflictScope,
  conflictDecisionLabelKey,
} from "./conflictDecisions";
import type { ConflictAiAnalysisState, ResolvableConflictDecision } from "./useConflictDecisions";
import { ConflictAiConclusion } from "./ConflictAiConclusion";

export interface ConflictActionsProps {
  caseEntry: ConflictWorkspaceCase;
  ai: ConflictAiAnalysisState;
  aiAvailable: boolean | null;
  centralizeDisabled?: boolean;
  onCentralize: () => void;
  onFollowSuggestion: () => void;
  onNotNow: () => void;
  onResolve: (decision: ResolvableConflictDecision) => void;
  resolving: boolean;
}

/**
 * 处理决定区（任务 7）：可选 AI 分析（三个范围）+ 三个明确决定入口。
 * 「按建议」执行的是映射后的具体人工决定，绝不只写 adopted；
 * 「纳入集中库管理」只跳治理预览；「暂不处理」不写任何东西。
 */
export function ConflictActions({
  ai,
  aiAvailable,
  caseEntry,
  onCentralize,
  onFollowSuggestion,
  onNotNow,
  onResolve,
  resolving,
}: ConflictActionsProps): JSX.Element {
  const { t } = useTranslation();
  const { case: caseFact, latest_analysis: latestAnalysis, recommended_decision } = caseEntry;
  const aiUsable = aiAvailable === true;
  const { lastRun } = ai;
  const lastRunFailureReason = lastRun?.failure_code
    ? describeNativeError(
        { code: lastRun.failure_code, severity: "error", params: {}, actions: [] },
        (key, options) => String(t(key as never, options as never)),
        "relationships.decisions.ai.failureUnknown",
      )
    : null;

  return (
    <section aria-label={t("relationships.decisions.actions.heading")} className="sh-conflict-actions">
      <h3>{t("relationships.decisions.actions.heading")}</h3>
      <div className="sh-conflict-actions__buttons">
        <Button
          disabled={resolving}
          onClick={() => onResolve("confirm_same_skill")}
          size="sm"
        >
          {t("relationships.decisions.actions.confirmSame")}
        </Button>
        <Button
          disabled={resolving}
          onClick={() => onResolve("keep_distinct")}
          size="sm"
        >
          {t("relationships.decisions.actions.keepDistinct")}
        </Button>
        <Button
          disabled={resolving}
          onClick={onCentralize}
          size="sm"
          variant="secondary"
        >
          {t("relationships.decisions.actions.centralize")}
        </Button>
        <Button disabled={resolving} onClick={onNotNow} size="sm" variant="ghost">
          {t("relationships.decisions.actions.notNow")}
        </Button>
      </div>
      <p className="sh-settings-local-note">
        {t("relationships.decisions.actions.centralizeHint")}
      </p>
      <p className="sh-settings-local-note">{t("relationships.decisions.actions.notNowHint")}</p>

      <div className="sh-conflict-actions__ai">
        <h4>{t("relationships.decisions.ai.heading")}</h4>
        {aiAvailable === false ? (
          <p role="status">{t("relationships.decisions.ai.unavailable")}</p>
        ) : null}
        <div className="sh-button-row">
          <Button
            disabled={!aiUsable || ai.running}
            loading={ai.running}
            onClick={() => ai.run(caseConflictScope(caseFact.conflict_id))}
            size="sm"
            variant="ghost"
          >
            {t("relationships.decisions.ai.runCase")}
          </Button>
          <Button
            disabled={!aiUsable || ai.running}
            loading={ai.running}
            onClick={() => ai.run(categoryConflictScope(caseFact.classification))}
            size="sm"
            variant="ghost"
          >
            {t("relationships.decisions.ai.runCategory")}
          </Button>
          <Button
            disabled={!aiUsable || ai.running}
            loading={ai.running}
            onClick={() => ai.run(allConflictScope())}
            size="sm"
            variant="secondary"
          >
            {t("relationships.decisions.ai.runAll")}
          </Button>
        </div>
        {ai.error ? <p role="alert">{ai.error}</p> : null}
        {lastRun && !ai.error ? (
          <div data-testid="conflict-ai-run">
            {lastRunFailureReason ? (
              <p role="alert">
                {t("relationships.decisions.ai.failureReason", {
                  reason: lastRunFailureReason,
                })}
              </p>
            ) : null}
            {lastRun.skipped_decided_cases > 0 ? (
              <p role="status">
                {t("relationships.decisions.ai.skippedDecided", {
                  count: lastRun.skipped_decided_cases,
                })}
              </p>
            ) : null}
            {lastRun.total_case_count > lastRun.cases.length ? (
              <p role="status">
                {t("relationships.decisions.ai.partialCoverage", {
                  analyzed: lastRun.cases.length,
                  total: lastRun.total_case_count,
                })}
              </p>
            ) : null}
            {!lastRun.failure_code && lastRun.cases.length === 0 ? (
              <p role="status">{t("relationships.decisions.ai.emptyRun")}</p>
            ) : null}
          </div>
        ) : null}
        {latestAnalysis ? (
          <>
            <ConflictAiConclusion
              record={latestAnalysis}
              stale={caseEntry.analysis_stale}
            />
            {recommended_decision && !caseEntry.analysis_stale ? (
              <Button
                disabled={resolving}
                onClick={onFollowSuggestion}
                size="sm"
                variant="secondary"
              >
                {t("relationships.decisions.actions.followSuggestion", {
                  action: t(conflictDecisionLabelKey(recommended_decision) as never),
                })}
              </Button>
            ) : null}
          </>
        ) : (
          <p>{t("relationships.decisions.ai.noConclusion")}</p>
        )}
      </div>
    </section>
  );
}
