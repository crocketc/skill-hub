import { useState, type JSX } from "react";
import { useTranslation } from "react-i18next";
import { describeNativeError } from "../../api/nativeErrors";
import { Button } from "../../ui/Button";
import { StatusBadge } from "../../ui/StatusBadge";
import {
  type SemanticDuplicateReport,
  type SkillDetailFacade,
} from "./api";

interface SemanticDuplicatePanelProps {
  facade: SkillDetailFacade;
  skillId: string;
}

/** Optional AI layer over the deterministic duplicate candidates (US-018).
 * The panel is user-initiated, shows the deterministic candidates even when
 * the AI layer fails, and never performs any action by itself: merging,
 * deleting or archiving always stays a separate explicit user decision. */
export function SemanticDuplicatePanel({ facade, skillId }: SemanticDuplicatePanelProps): JSX.Element {
  const { t } = useTranslation();
  const [running, setRunning] = useState(false);
  const [report, setReport] = useState<SemanticDuplicateReport>();
  const [error, setError] = useState<string>();

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

  return (
    <section aria-labelledby="semantic-duplicates-heading" className="sh-detail-insights">
      <div className="sh-metadata-panel__section-heading">
        <h3 id="semantic-duplicates-heading">{t("skillDetail.duplicates.heading")}</h3>
        <Button disabled={running} loading={running} onClick={run} size="sm" variant="ghost">
          {t("skillDetail.duplicates.run")}
        </Button>
      </div>
      <p className="sh-settings-local-note">{t("skillDetail.duplicates.scopeNote")}</p>
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
    </section>
  );
}
