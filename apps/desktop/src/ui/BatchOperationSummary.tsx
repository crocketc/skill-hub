import { useTranslation } from "react-i18next";

/**
 * Normalized per-item outcome for batch operations (deploy / removal / import).
 * Statuses follow the product language: 可执行（成功）、跳过、冲突、失败.
 */
export type BatchOutcomeStatus = "succeeded" | "skipped" | "conflict" | "failed";

export interface BatchOutcome {
  id: string;
  label: string;
  message?: string;
  status: BatchOutcomeStatus;
}

const STATUS_ORDER: readonly BatchOutcomeStatus[] = ["succeeded", "skipped", "conflict", "failed"];

/**
 * Unified aggregation for batch operations: one status line with per-status
 * counts followed by the individual outcomes, grouped by status, so a partial
 * batch is never mistaken for a fully successful one.
 */
export function BatchOperationSummary({ outcomes }: { outcomes: BatchOutcome[] }): JSX.Element {
  const { t } = useTranslation();
  const counts = new Map<BatchOutcomeStatus, BatchOutcome[]>();
  for (const outcome of outcomes) {
    const bucket = counts.get(outcome.status) ?? [];
    bucket.push(outcome);
    counts.set(outcome.status, bucket);
  }

  return (
    <section aria-labelledby="batch-summary-heading" className="sh-workflow-card sh-batch-summary" data-testid="batch-summary">
      <h2 id="batch-summary-heading">{t("batchSummary.heading", { count: outcomes.length })}</h2>
      <p className="sh-batch-summary__counts" role="status">
        {STATUS_ORDER.map((status) => (
          counts.has(status)
            ? (
                <span className={`sh-status sh-status--${status}`} key={status}>
                  {t(`batchSummary.status.${status}`, { count: counts.get(status)?.length ?? 0 })}
                </span>
              )
            : null
        ))}
      </p>
      {STATUS_ORDER.map((status) => {
        const bucket = counts.get(status);
        if (!bucket?.length) return null;
        return (
          <ul className="sh-workflow-list" key={status}>
            {bucket.map((outcome) => (
              <li className="sh-workflow-list__item" data-testid={`batch-outcome-${status}`} key={outcome.id}>
                <div>
                  <strong>{outcome.label}</strong>
                  {outcome.message ? <p>{outcome.message}</p> : null}
                </div>
                <span className={`sh-status sh-status--${status}`}>{t(`batchSummary.status.${status}`, { count: 1 })}</span>
              </li>
            ))}
          </ul>
        );
      })}
    </section>
  );
}
