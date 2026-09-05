import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui/Button";
import { DataState } from "../../ui/DataState";
import { OperationsList } from "../operations/OperationsList";
import { nativeRecentOperations, type RecentOperationsReader } from "../operations/nativeApi";
import { type OperationFacade, unavailableOperationFacade, type OperationState } from "../operations/api";

export function RecoveryPage({ operationId = "latest", facade = unavailableOperationFacade, recent = nativeRecentOperations }: { operationId?: string; facade?: OperationFacade; recent?: RecentOperationsReader }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<"records" | "backupRestore">("records");
  const [operation, setOperation] = useState<OperationState>();
  const [error, setError] = useState<string>();
  useEffect(() => { void facade.get(operationId).then(setOperation).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason))); }, [facade, operationId]);

  return (
    <main className="sh-page sh-workflow-page">
      <header className="sh-page__header">
        <div>
          <p className="sh-eyebrow">{t("recovery.eyebrow")}</p>
          <h1>{t("recovery.heading")}</h1>
          <p>{t("recovery.description")}</p>
        </div>
      </header>
      <div role="tablist" className="sh-tabs">
        <button
          aria-selected={tab === "records"}
          className="sh-tabs__tab"
          id="recovery-tab-records"
          onClick={() => setTab("records")}
          role="tab"
          type="button"
        >
          {t("recovery.tabs.records")}
        </button>
        <button
          aria-selected={tab === "backupRestore"}
          className="sh-tabs__tab"
          id="recovery-tab-backup"
          onClick={() => setTab("backupRestore")}
          role="tab"
          type="button"
        >
          {t("recovery.tabs.backupRestore")}
        </button>
      </div>
      {tab === "records" ? (
        <div aria-labelledby="recovery-tab-records" className="sh-workflow-card" role="tabpanel">
          <OperationsList recent={recent} />
        </div>
      ) : (
        <BackupRestoreTab error={error} facade={facade} onLoaded={setOperation} operation={operation} />
      )}
    </main>
  );
}

function BackupRestoreTab({ operation, error, facade, onLoaded }: {
  operation?: OperationState;
  error?: string;
  facade: OperationFacade;
  onLoaded: (operation: OperationState) => void;
}) {
  const { t } = useTranslation();
  const [localError, setLocalError] = useState<string>();
  const current = operation;
  const acknowledge = async () => {
    if (!current) return;
    try {
      await facade.acknowledgeRecovery(current.operationId);
      onLoaded({ ...current, phase: "rolled_back" });
    } catch (reason: unknown) {
      setLocalError(reason instanceof Error ? reason.message : String(reason));
    }
  };
  if (error || localError) return <DataState message={error ?? localError ?? ""} state="unavailable" />;
  if (!current) return <DataState message={t("recovery.loading")} state="loading" />;
  return (
    <div aria-labelledby="recovery-tab-backup" className="sh-workflow-card" role="tabpanel">
      <p className="sh-eyebrow">{t("recovery.tabs.backupRestoreHint")}</p>
      <OperationSummary operation={current} />
      <Button onClick={() => void acknowledge()} variant="primary">{t("recovery.acknowledge")}</Button>
    </div>
  );
}

function OperationSummary({ operation }: { operation: OperationState }) { const { t } = useTranslation(); return <div className="sh-operation-summary"><strong>{operation.operationId}</strong><span className={`sh-status sh-status--${operation.phase}`}>{t(`operations.phases.${operation.phase}`)}</span><p>{operation.message}</p></div>; }
