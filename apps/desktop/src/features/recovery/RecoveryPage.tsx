import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { describeNativeError } from "../../api/nativeErrors";
import { Button } from "../../ui/Button";
import { DataState } from "../../ui/DataState";
import { PageFrame } from "../../ui/PageFrame";
import { PageHeader } from "../../ui/PageHeader";
import { OperationsList } from "../operations/OperationsList";
import { OperationPhaseStatus } from "../operations/OperationPhaseStatus";
import { nativeRecentOperations, type RecentOperationsReader } from "../operations/nativeApi";
import { type OperationFacade, type OperationState, type RecoveryCandidate, unavailableOperationFacade } from "../operations/api";
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

/**
 * 恢复页是恢复闸门的唯一出口：闸门在 `recovery_state !== "clean"` 时阻断其余
 * 全部路由，所以这一页必须列出 `list_recovery_candidates` 的**所有**候选，
 * 而不是只认「最新一条」。处置走 `resolve_recovery`（统一回滚语义，用户可见
 * 文案只说「恢复」，不出现「回滚」）。
 */
export function RecoveryPage({ facade = unavailableOperationFacade, recent = nativeRecentOperations }: { facade?: OperationFacade; recent?: RecentOperationsReader }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<RecoveryTab>("records");
  const [candidates, setCandidates] = useState<RecoveryCandidate[]>();
  const [selectedId, setSelectedId] = useState<string>();
  const [operation, setOperation] = useState<OperationState>();
  const [error, setError] = useState<string>();
  const [resolved, setResolved] = useState(false);
  const [busy, setBusy] = useState(false);
  const tabRefs = useRef<Partial<Record<RecoveryTab, HTMLButtonElement | null>>>({});

  const describe = useCallback(
    (reason: unknown) => describeNativeError(reason, (key, options) => String(t(key as never, options as never)), "recovery.errors.generic"),
    [t],
  );

  const loadCandidates = useCallback(async () => {
    const list = await facade.listRecoveryCandidates();
    setCandidates(list);
    setSelectedId((current) => (current && list.some((candidate) => candidate.operationId === current) ? current : list[0]?.operationId));
  }, [facade]);

  useEffect(() => {
    let cancelled = false;
    loadCandidates().catch((reason: unknown) => { if (!cancelled) setError(describe(reason)); });
    return () => { cancelled = true; };
  }, [loadCandidates, describe]);

  useEffect(() => {
    if (!selectedId) { setOperation(undefined); return; }
    let cancelled = false;
    facade.get(selectedId).then(
      (state) => { if (!cancelled) setOperation(state); },
      (reason: unknown) => { if (!cancelled) setError(describe(reason)); },
    );
    return () => { cancelled = true; };
  }, [facade, selectedId, describe]);

  const confirmRecovery = async () => {
    if (!selectedId) return;
    setBusy(true);
    setError(undefined);
    setResolved(false);
    try {
      await facade.resolveRecovery(selectedId, "rollback_operation");
      setResolved(true);
      await loadCandidates();
    } catch (reason: unknown) {
      setError(describe(reason));
    } finally {
      setBusy(false);
    }
  };

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
            <RecoveryCandidatesTab
              busy={busy}
              candidates={candidates}
              error={error}
              onConfirm={() => void confirmRecovery()}
              onSelect={setSelectedId}
              operation={operation}
              resolved={resolved}
              selectedId={selectedId}
            />
          </div>
        )}
      </div>
    </PageFrame>
  );
}

function RecoveryCandidatesTab({ candidates, selectedId, operation, error, resolved, busy, onSelect, onConfirm }: {
  candidates?: RecoveryCandidate[];
  selectedId?: string;
  operation?: OperationState;
  error?: string;
  resolved: boolean;
  busy: boolean;
  onSelect: (operationId: string) => void;
  onConfirm: () => void;
}) {
  const { t } = useTranslation();
  if (error) return <DataState message={error} state="unavailable" />;
  if (!candidates) return <DataState message={t("recovery.loading")} state="loading" />;
  if (candidates.length === 0) {
    return (
      <>
        <p className="sh-eyebrow">{t("recovery.tabs.backupRestoreHint")}</p>
        <p>{t("recovery.noCandidates")}</p>
        {resolved ? <p role="status">{t("recovery.resolved")}</p> : null}
      </>
    );
  }
  return (
    <>
      <p className="sh-eyebrow">{t("recovery.tabs.backupRestoreHint")}</p>
      <fieldset className="sh-recovery__candidates">
        <legend>{t("recovery.candidatesHeading")}</legend>
        {candidates.map((candidate) => (
          <label key={candidate.operationId}>
            <input
              aria-label={t("recovery.candidateLabel", { id: candidate.operationId })}
              checked={candidate.operationId === selectedId}
              name="recovery-candidate"
              onChange={() => onSelect(candidate.operationId)}
              type="radio"
              value={candidate.operationId}
            />
            {candidate.operationId}
          </label>
        ))}
      </fieldset>
      {operation ? <OperationSummary operation={operation} /> : <DataState message={t("recovery.loading")} state="loading" />}
      <div className="sh-recovery__actions">
        <Button disabled={busy || !selectedId} onClick={onConfirm} variant="primary">{t("recovery.acknowledge")}</Button>
      </div>
      {resolved ? <p role="status">{t("recovery.resolved")}</p> : null}
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
