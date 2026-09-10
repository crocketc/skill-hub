import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui/Button";
import { DataState } from "../../ui/DataState";
import { PageFrame } from "../../ui/PageFrame";
import { PageHeader } from "../../ui/PageHeader";
import { OperationsList } from "../operations/OperationsList";
import { OperationPhaseStatus } from "../operations/OperationPhaseStatus";
import { nativeRecentOperations, type RecentOperationsReader } from "../operations/nativeApi";
import { type OperationFacade, unavailableOperationFacade, type OperationState } from "../operations/api";
import "./recovery.css";

const TAB_ORDER = ["records", "backupRestore"] as const;
type RecoveryTab = (typeof TAB_ORDER)[number];

const TAB_IDS: Record<RecoveryTab, string> = {
  records: "recovery-tab-records",
  backupRestore: "recovery-tab-backup",
};

const PANEL_IDS: Record<RecoveryTab, string> = {
  records: "recovery-panel-records",
  backupRestore: "recovery-panel-backup",
};

export function RecoveryPage({ operationId = "latest", facade = unavailableOperationFacade, recent = nativeRecentOperations }: { operationId?: string; facade?: OperationFacade; recent?: RecentOperationsReader }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<RecoveryTab>("records");
  const [operation, setOperation] = useState<OperationState>();
  const [error, setError] = useState<string>();
  const tabRefs = useRef<Partial<Record<RecoveryTab, HTMLButtonElement | null>>>({});
  useEffect(() => { void facade.get(operationId).then(setOperation).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason))); }, [facade, operationId]);

  // WAI-ARIA tabs：roving tabindex + 方向键/Home/End 循环移动，焦点与选中同步。
  const moveTab = (current: RecoveryTab, key: string) => {
    const index = TAB_ORDER.indexOf(current);
    const nextByKey: Record<string, number | undefined> = {
      ArrowRight: (index + 1) % TAB_ORDER.length,
      ArrowLeft: (index - 1 + TAB_ORDER.length) % TAB_ORDER.length,
      Home: 0,
      End: TAB_ORDER.length - 1,
    };
    const nextIndex = nextByKey[key];
    if (nextIndex === undefined) return;
    const next = TAB_ORDER[nextIndex];
    setTab(next);
    tabRefs.current[next]?.focus();
  };

  return (
    <PageFrame width="wide">
      <div className="sh-workflow-page sh-recovery">
        <PageHeader description={t("recovery.description")} title={t("recovery.heading")} />
        <div role="tablist" aria-label={t("recovery.heading")} className="sh-tabs sh-recovery__tabs">
          {TAB_ORDER.map((tabKey) => (
            <button
              aria-controls={PANEL_IDS[tabKey]}
              aria-selected={tab === tabKey}
              className="sh-tabs__tab"
              id={TAB_IDS[tabKey]}
              key={tabKey}
              onClick={() => setTab(tabKey)}
              onKeyDown={(event) => moveTab(tab, event.key)}
              ref={(node) => { tabRefs.current[tabKey] = node; }}
              role="tab"
              tabIndex={tab === tabKey ? 0 : -1}
              type="button"
            >
              {tabKey === "records" ? t("recovery.tabs.records") : t("recovery.tabs.backupRestore")}
            </button>
          ))}
        </div>
        {tab === "records" ? (
          <div
            aria-labelledby={TAB_IDS.records}
            className="sh-workflow-card sh-recovery__panel"
            id={PANEL_IDS.records}
            role="tabpanel"
            tabIndex={0}
          >
            <OperationsList recent={recent} />
          </div>
        ) : (
          <div
            aria-labelledby={TAB_IDS.backupRestore}
            className="sh-workflow-card sh-recovery__panel"
            id={PANEL_IDS.backupRestore}
            role="tabpanel"
            tabIndex={0}
          >
            <BackupRestoreTab error={error} facade={facade} onLoaded={setOperation} operation={operation} />
          </div>
        )}
      </div>
    </PageFrame>
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
    <>
      <p className="sh-eyebrow">{t("recovery.tabs.backupRestoreHint")}</p>
      <OperationSummary operation={current} />
      <div className="sh-recovery__actions">
        <Button onClick={() => void acknowledge()} variant="primary">{t("recovery.acknowledge")}</Button>
      </div>
    </>
  );
}

function OperationSummary({ operation }: { operation: OperationState }) {
  return (
    <div className="sh-operation-summary">
      <div className="sh-recovery__summary-heading">
        <strong>{operation.operationId}</strong>
        <OperationPhaseStatus phase={operation.phase} />
      </div>
      <p>{operation.message}</p>
    </div>
  );
}
