import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { DataState } from "../../ui/DataState";
import { type OperationFacade, type OperationState, unavailableOperationFacade } from "./api";

export function OperationProgress({ operationId, facade = unavailableOperationFacade }: { operationId: string; facade?: OperationFacade }) {
  const { t } = useTranslation();
  const [operation, setOperation] = useState<OperationState>();
  const [error, setError] = useState<string>();
  useEffect(() => { void facade.get(operationId).then(setOperation).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason))); }, [facade, operationId]);
  if (error) return <DataState message={error} state="unavailable" />;
  if (!operation) return <DataState message={t("operations.loading")} state="loading" />;
  const progress = operation.total > 0 ? Math.round((operation.completed / operation.total) * 100) : 0;
  return <section aria-labelledby="operation-progress-heading" className="sh-workflow-card"><div className="sh-section-heading"><div><p className="sh-eyebrow">{t("operations.eyebrow")}</p><h2 id="operation-progress-heading">{t("operations.progressHeading")}</h2></div><span className={`sh-status sh-status--${operation.phase}`}>{t(`operations.phases.${operation.phase}`)}</span></div><p>{operation.message}</p><progress aria-label={t("operations.progressLabel")} max={100} value={progress}>{progress}%</progress><details><summary>{t("operations.technicalDetails")}</summary><dl className="sh-facts"><dt>{t("operations.operationId")}</dt><dd>{operation.operationId}</dd><dt>{t("operations.completed")}</dt><dd>{operation.completed}/{operation.total}</dd></dl></details></section>;
}
