import { useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { RecoveryAction } from "../../api/bindings";
import { describeNativeError } from "../../api/nativeErrors";
import { resolveLocale } from "../../i18n";
import { Button } from "../../ui/Button";
import { DataState } from "../../ui/DataState";
import { PageFrame } from "../../ui/PageFrame";
import { PageHeader } from "../../ui/PageHeader";
import { formatOperationTimes, localizeErrorCode, operationObjectTitle } from "../operations/labels";
import { OperationsList } from "../operations/OperationsList";
import { OperationPhaseStatus } from "../operations/OperationPhaseStatus";
import { nativeRecentOperations, type RecentOperationsReader } from "../operations/nativeApi";
import { type OperationFacade, type OperationState, type RecoveryCandidate, unavailableOperationFacade } from "../operations/api";
import "./recovery.css";

const TAB_ORDER = ["records", "backupRestore"] as const;
type RecoveryTab = (typeof TAB_ORDER)[number];
type RecoveryResolutionAction = Extract<RecoveryAction, "complete_operation" | "rollback_operation">;

function isRecoveryResolutionAction(action: RecoveryAction): action is RecoveryResolutionAction {
  return action === "complete_operation" || action === "rollback_operation";
}

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
 * 而不是只认「最新一条」。处置按钮严格按候选声明的能力调用，不能为所有操作
 * 假定都能完成或撤销。
 */
export function RecoveryPage({ facade = unavailableOperationFacade, recent = nativeRecentOperations, initialOperationId, onResolved }: { facade?: OperationFacade; recent?: RecentOperationsReader; initialOperationId?: string; onResolved?: () => Promise<void> }) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<RecoveryTab>(initialOperationId ? "backupRestore" : "records");
  const [candidates, setCandidates] = useState<RecoveryCandidate[]>();
  const [selectedId, setSelectedId] = useState<string | undefined>(initialOperationId);
  const [operation, setOperation] = useState<OperationState>();
  const [candidateError, setCandidateError] = useState<string>();
  const [operationError, setOperationError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [operationLoading, setOperationLoading] = useState(false);
  const [resolvedAction, setResolvedAction] = useState<RecoveryResolutionAction>();
  const [busy, setBusy] = useState(false);
  const tabRefs = useRef<Partial<Record<RecoveryTab, HTMLButtonElement | null>>>({});
  const candidateRequest = useRef(0);
  const operationRequest = useRef(0);

  const describe = useCallback(
    (reason: unknown) => describeNativeError(reason, (key, options) => String(t(key as never, options as never)), "recovery.errors.generic"),
    [t],
  );

  const loadCandidates = useCallback(async () => {
    const request = ++candidateRequest.current;
    setCandidateError(undefined);
    try {
      const list = await facade.listRecoveryCandidates();
      if (request !== candidateRequest.current) return;
      setCandidates(list);
      setSelectedId((current) => (current && list.some((candidate) => candidate.operationId === current) ? current : list[0]?.operationId));
    } catch (reason: unknown) {
      if (request === candidateRequest.current) setCandidateError(describe(reason));
    }
  }, [facade, describe]);

  const loadOperation = useCallback(async (operationId: string) => {
    const request = ++operationRequest.current;
    setOperation(undefined);
    setOperationError(undefined);
    setOperationLoading(true);
    try {
      const state = await facade.get(operationId);
      if (request === operationRequest.current) setOperation(state);
    } catch (reason: unknown) {
      if (request === operationRequest.current) setOperationError(describe(reason));
    } finally {
      if (request === operationRequest.current) setOperationLoading(false);
    }
  }, [facade, describe]);

  useEffect(() => {
    void loadCandidates();
    return () => { candidateRequest.current += 1; };
  }, [loadCandidates]);

  useEffect(() => {
    if (selectedId) void loadOperation(selectedId);
    else {
      operationRequest.current += 1;
      setOperation(undefined);
      setOperationError(undefined);
      setOperationLoading(false);
    }
    return () => { operationRequest.current += 1; };
  }, [selectedId, loadOperation]);

  const selectedCandidate = candidates?.find((candidate) => candidate.operationId === selectedId);

  const confirmRecovery = async (action: RecoveryResolutionAction) => {
    if (!selectedId || !selectedCandidate?.actions.includes(action) || !operation || operation.operationId !== selectedId || operationLoading || operationError) return;
    setBusy(true);
    setActionError(undefined);
    setResolvedAction(undefined);
    try {
      await facade.resolveRecovery(selectedId, action);
      setResolvedAction(action);
      await loadCandidates();
      await onResolved?.();
    } catch (reason: unknown) {
      setActionError(describe(reason));
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
              actionError={actionError}
              busy={busy}
              candidateError={candidateError}
              candidates={candidates}
              onConfirm={(action) => void confirmRecovery(action)}
              operationError={operationError}
              operationLoading={operationLoading}
              onRetryCandidates={() => void loadCandidates()}
              onRetryOperation={() => { if (selectedId) void loadOperation(selectedId); }}
              onSelect={(operationId) => { setSelectedId(operationId); setActionError(undefined); setResolvedAction(undefined); }}
              operation={operation}
              resolvedAction={resolvedAction}
              selectedId={selectedId}
            />
          </div>
        )}
      </div>
    </PageFrame>
  );
}

function RecoveryCandidatesTab({ candidates, selectedId, operation, candidateError, operationError, operationLoading, actionError, resolvedAction, busy, onSelect, onConfirm, onRetryCandidates, onRetryOperation }: {
  candidates?: RecoveryCandidate[];
  selectedId?: string;
  operation?: OperationState;
  candidateError?: string;
  operationError?: string;
  operationLoading: boolean;
  actionError?: string;
  resolvedAction?: RecoveryResolutionAction;
  busy: boolean;
  onSelect: (operationId: string) => void;
  onConfirm: (action: RecoveryResolutionAction) => void;
  onRetryCandidates: () => void;
  onRetryOperation: () => void;
}) {
  const { t } = useTranslation();
  const translate = useCallback(
    (key: string, options?: Record<string, unknown>) => String(t(key as never, options as never)),
    [t],
  );
  if (candidateError) return <><DataState message={candidateError} state="unavailable" /><Button onClick={onRetryCandidates}>{t("actions.retry")}</Button></>;
  if (!candidates) return <DataState message={t("recovery.loading")} state="loading" />;
  if (candidates.length === 0) {
    return (
      <>
        <p className="sh-eyebrow">{t("recovery.tabs.backupRestoreHint")}</p>
        <p>{t("recovery.noCandidates")}</p>
        {resolvedAction ? <p role="status">{t(`recovery.resolved.${resolvedAction}`)}</p> : null}
      </>
    );
  }
  const selectedCandidate = candidates.find((candidate) => candidate.operationId === selectedId);
  const availableActions = selectedCandidate?.actions.filter(isRecoveryResolutionAction) ?? [];
  return (
    <>
      <p className="sh-eyebrow">{t("recovery.tabs.backupRestoreHint")}</p>
      <fieldset className="sh-recovery__candidates">
        <legend>{t("recovery.candidatesHeading")}</legend>
        {candidates.map((candidate) => {
          // DEV-98：候选按「本地化操作名：对象名」呈现；快照未命中的如实标注
          // 未知操作。operation id 只作为内部 value，不进可见文案。
          const title = operationObjectTitle(candidate.kind, candidate.objectName, translate) || t("recovery.unknownOperation");
          return (
            <label key={candidate.operationId}>
              <input
                aria-label={title}
                checked={candidate.operationId === selectedId}
                name="recovery-candidate"
                onChange={() => onSelect(candidate.operationId)}
                type="radio"
                value={candidate.operationId}
              />
              {title}
            </label>
          );
        })}
      </fieldset>
      {operationError ? <><DataState message={operationError} state="unavailable" /><Button onClick={onRetryOperation}>{t("recovery.retryDetails")}</Button></> : operationLoading || !operation || operation.operationId !== selectedId ? <DataState message={t("recovery.loading")} state="loading" /> : <OperationSummary operation={operation} />}
      <div className="sh-recovery__actions">
        {availableActions.map((action) => (
          <Button
            disabled={busy || !selectedId || !operation || operation.operationId !== selectedId || operationLoading || Boolean(operationError)}
            key={action}
            onClick={() => onConfirm(action)}
            variant="primary"
          >
            {t(`recovery.actions.${action}`)}
          </Button>
        ))}
      </div>
      {selectedCandidate && availableActions.length === 0 ? <p role="note">{t("recovery.noSupportedActions")}</p> : null}
      {actionError ? <p role="status">{actionError}</p> : null}
      {resolvedAction ? <p role="status">{t(`recovery.resolved.${resolvedAction}`)}</p> : null}
    </>
  );
}

function OperationSummary({ operation }: { operation: OperationState }) {
  const { t, i18n } = useTranslation();
  const translate = useCallback(
    (key: string, options?: Record<string, unknown>) => String(t(key as never, options as never)),
    [t],
  );
  // DEV-98：标题用「本地化操作名：对象名」+ 本地化时间；message 只有在携带
  // 真实错误码（≠裸 kind）时才映射为可读失败说明，原始 kind 不进界面。
  const title = operationObjectTitle(operation.kind, operation.objectName, translate) || t("recovery.unknownOperation");
  const time = operation.createdAt
    ? formatOperationTimes([operation.createdAt], resolveLocale([i18n.resolvedLanguage ?? i18n.language]))[0]
    : undefined;
  const errorCode = operation.kind && operation.message && operation.message !== operation.kind
    ? localizeErrorCode(operation.message, translate)
    : undefined;
  return (
    <div className="sh-operation-summary">
      <div className="sh-recovery__summary-heading">
        <strong>{title}</strong>
        <OperationPhaseStatus phase={operation.phase} />
        {time ? <time>{time}</time> : null}
      </div>
      {errorCode ? <p>{errorCode}</p> : <p>{operation.kind ? null : operation.message}</p>}
    </div>
  );
}
