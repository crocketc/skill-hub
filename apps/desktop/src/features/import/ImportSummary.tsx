import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui/Button";
import { DataState } from "../../ui/DataState";
import { StatusBadge } from "../../ui/StatusBadge";
import type { ImportResult } from "./api";

export interface ImportSummaryProps {
  results: ImportResult[];
  unavailable?: boolean;
  onRetry: () => void;
  onOpenLibrary: () => void;
}

export function ImportSummary({
  results,
  unavailable = false,
  onRetry,
  onOpenLibrary,
}: ImportSummaryProps) {
  const { t } = useTranslation();
  const [showCompletedDetails, setShowCompletedDetails] = useState(false);

  if (unavailable) {
    return (
      <section className="sh-import-summary" aria-labelledby="import-summary-title">
        <h2 id="import-summary-title">{t("importWorkflow.summary.title")}</h2>
        <DataState
          actionLabel={t("actions.retry")}
          message={t("importWorkflow.summary.unavailable")}
          onAction={onRetry}
          state="unavailable"
        />
      </section>
    );
  }

  const hasFailure = results.some((result) => result.status === "failed");
  const succeeded = results.filter((result) => result.status === "succeeded").length;
  const skipped = results.filter((result) => result.status === "skipped").length;
  const failed = results.filter((result) => result.status === "failed").length;
  const visibleResults = showCompletedDetails
    ? results
    : results.filter((result) => result.status === "failed");

  return (
    <section className="sh-import-summary" aria-labelledby="import-summary-title">
      <div className="sh-import-summary__heading">
        <div>
          <p className="sh-import-summary__eyebrow">{t("importWorkflow.summary.eyebrow")}</p>
          <h2 id="import-summary-title">{t("importWorkflow.summary.title")}</h2>
          <p>{t(hasFailure ? "importWorkflow.summary.partial" : "importWorkflow.summary.complete")}</p>
        </div>
        <span className="sh-import-summary__step">{t("importWorkflow.step", { current: 4, total: 4 })}</span>
      </div>

      <div className="sh-import-summary__counts">
        <span>{t("importWorkflow.summary.counts.succeeded", { count: succeeded })}</span>
        <span>{t("importWorkflow.summary.counts.skipped", { count: skipped })}</span>
        <span>{t("importWorkflow.summary.counts.failed", { count: failed })}</span>
      </div>

      <ul className="sh-import-summary__list">
        {visibleResults.map((result) => (
          <li className="sh-import-summary__item" key={result.candidateId}>
            <div>
              <strong>{result.candidateId}</strong>
              <span>{t(`importWorkflow.summary.actions.${result.action}`)}</span>
            </div>
            <StatusBadge tone={result.status === "succeeded" ? "success" : result.status === "skipped" ? "neutral" : "danger"}>
              {t(`importWorkflow.summary.status.${result.status}`)}
            </StatusBadge>
            <p>{t(result.message, { defaultValue: result.message })}</p>
          </li>
        ))}
      </ul>

      <div className="sh-import-summary__actions">
        {succeeded + skipped > 0 ? (
          <Button onClick={() => setShowCompletedDetails((current) => !current)} variant="ghost">
            {t(showCompletedDetails
              ? "importWorkflow.summary.hideCompletedDetails"
              : "importWorkflow.summary.showCompletedDetails")}
          </Button>
        ) : null}
        {hasFailure ? <Button onClick={onRetry} variant="secondary">{t("actions.retry")}</Button> : null}
        <Button onClick={onOpenLibrary}>{t("importWorkflow.summary.openLibrary")}</Button>
      </div>
    </section>
  );
}
