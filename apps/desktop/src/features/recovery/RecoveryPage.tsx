import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui/Button";
import { DataState } from "../../ui/DataState";
import { type OperationFacade, unavailableOperationFacade } from "../operations/api";
import type { OperationState } from "../operations/api";

export function RecoveryPage({ operationId = "latest", facade = unavailableOperationFacade }: { operationId?: string; facade?: OperationFacade }) {
  const { t } = useTranslation();
  const [operation, setOperation] = useState<OperationState>();
  const [error, setError] = useState<string>();
  useEffect(() => { void facade.get(operationId).then(setOperation).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason))); }, [facade, operationId]);
  if (error) return <DataState message={error} state="unavailable" />;
  if (!operation) return <DataState message={t("recovery.loading")} state="loading" />;
  const acknowledge = async () => { await facade.acknowledgeRecovery(operation.operationId); setOperation({ ...operation, phase: "rolled_back" }); };
  return <main className="sh-page sh-workflow-page"><header className="sh-page__header"><div><p className="sh-eyebrow">{t("recovery.eyebrow")}</p><h1>{t("recovery.heading")}</h1><p>{t("recovery.description")}</p></div></header><section className="sh-workflow-card"><OperationSummary operation={operation} /><Button onClick={() => void acknowledge()} variant="primary">{t("recovery.acknowledge")}</Button></section></main>;
}

function OperationSummary({ operation }: { operation: OperationState }) { const { t } = useTranslation(); return <div className="sh-operation-summary"><strong>{operation.operationId}</strong><span className={`sh-status sh-status--${operation.phase}`}>{t(`operations.phases.${operation.phase}`)}</span><p>{operation.message}</p></div>; }
