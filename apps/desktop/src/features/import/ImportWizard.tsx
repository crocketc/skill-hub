import { useEffect, useReducer, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "../../ui/Button";
import { DataState } from "../../ui/DataState";
import { ConflictResolution } from "./ConflictResolution";
import {
  CandidateSelection,
  type CandidateSelectionProps,
} from "./CandidateSelection";
import {
  ImportCancelledError,
  type ImportAction,
  type ImportFacade,
  type ImportPlan,
  type ImportProgress,
  type ImportResult,
  type SourceDescriptor,
  unavailableImportFacade,
} from "./api";
import { ImportSummary } from "./ImportSummary";
import { SourceInput } from "./SourceInput";
import {
  desktopDirectoryPicker,
  normalizeWindowsPath,
  type DirectoryPicker,
} from "../../platform/directoryPicker";
import {
  operationTracker,
  useHasRunningOperation,
  type OperationTracker,
  type TrackedResultSummary,
} from "../../platform/operationTracker";

type WizardPhase =
  | "source"
  | "acquiring"
  | "candidate_gate"
  | "candidates"
  | "analyzing"
  | "conflicts"
  | "committing"
  | "summary"
  | "failed"
  | "cancelled";

interface WizardState {
  phase: WizardPhase;
  previousPhase?: WizardPhase;
  sourceText: string;
  descriptor?: SourceDescriptor;
  candidates: CandidateSelectionProps["candidates"];
  selectedIds: string[];
  plan?: ImportPlan;
  actions: Record<string, ImportAction>;
  commitProgress?: ImportProgress;
  results: ImportResult[];
  sourceCounts?: { source: string; count: number }[];
  error?: string;
}

type WizardEvent =
  | { type: "source_changed"; value: string }
  | { type: "parse_started" }
  | { type: "parse_succeeded"; descriptor: SourceDescriptor }
  | { type: "acquire_succeeded"; candidates: WizardState["candidates"]; sourceCounts: { source: string; count: number }[] }
  | { type: "show_candidates" }
  | { type: "candidates_selected"; ids: string[] }
  | { type: "analysis_started" }
  | { type: "analysis_succeeded"; plan: ImportPlan }
  | { type: "action_selected"; candidateId: string; action: ImportAction }
  | { type: "commit_started"; total: number }
  | { type: "commit_progress"; progress: ImportProgress }
  | { type: "commit_succeeded"; results: ImportResult[] }
  | { type: "failed"; error: string; previousPhase: WizardPhase }
  | { type: "cancelled" }
  | { type: "retry" };

const initialState: WizardState = {
  actions: {},
  candidates: [],
  phase: "source",
  results: [],
  selectedIds: [],
  sourceText: "",
};

function reducer(state: WizardState, event: WizardEvent): WizardState {
  switch (event.type) {
    case "source_changed":
      return {
        ...state,
        actions: {},
        candidates: [],
        descriptor: undefined,
        error: undefined,
        phase: "source",
        plan: undefined,
        commitProgress: undefined,
        selectedIds: [],
        sourceCounts: undefined,
        sourceText: event.value,
      };
    case "parse_started":
      return { ...state, error: undefined, phase: "acquiring" };
    case "parse_succeeded":
      return { ...state, descriptor: event.descriptor };
    case "acquire_succeeded":
      return {
        ...state,
        candidates: event.candidates,
        error: undefined,
        phase: "candidate_gate",
        sourceCounts: event.sourceCounts,
      };
    case "show_candidates":
      return { ...state, phase: "candidates" };
    case "candidates_selected":
      return { ...state, selectedIds: event.ids };
    case "analysis_started":
      return { ...state, error: undefined, phase: "analyzing" };
    case "analysis_succeeded":
      return { ...state, error: undefined, phase: "conflicts", plan: event.plan };
    case "action_selected":
      return { ...state, actions: { ...state.actions, [event.candidateId]: event.action } };
    case "commit_started":
      return {
        ...state,
        commitProgress: { candidateId: "", completed: 0, total: event.total },
        error: undefined,
        phase: "committing",
      };
    case "commit_progress":
      return { ...state, commitProgress: event.progress };
    case "commit_succeeded":
      return { ...state, commitProgress: undefined, error: undefined, phase: "summary", results: event.results };
    case "failed":
      return { ...state, error: event.error, phase: "failed", previousPhase: event.previousPhase };
    case "cancelled":
      return { ...state, error: undefined, phase: "cancelled", previousPhase: "source" };
    case "retry":
      return {
        ...state,
        actions: state.previousPhase === "conflicts" ? {} : state.actions,
        commitProgress: undefined,
        error: undefined,
        phase: state.previousPhase ?? "source",
      };
    default:
      return state;
  }
}

export interface ImportWizardProps {
  directoryPicker?: DirectoryPicker;
  facade?: ImportFacade;
  initialSources?: string[];
  initialSourceText?: string;
  importGuide?: string;
  /** 全局操作跟踪；测试可注入独立实例，默认模块级单例（跨路由存续）。 */
  tracker?: OperationTracker;
  onComplete?: (results: ImportResult[]) => void;
  onOpenLibrary?: () => void;
}

export function ImportWizard({
  directoryPicker = desktopDirectoryPicker,
  facade = unavailableImportFacade,
  initialSources = [],
  initialSourceText = "",
  importGuide,
  tracker = operationTracker,
  onComplete,
  onOpenLibrary = () => undefined,
}: ImportWizardProps) {
  const { t } = useTranslation();
  const normalizedInitialSources = Array.from(new Set(initialSources.map(normalizeWindowsPath)));
  const normalizedInitialSourceText = normalizeWindowsPath(initialSourceText);
  const [state, dispatch] = useReducer(reducer, { ...initialState, sourceText: normalizedInitialSourceText });
  const [selectedSources, setSelectedSources] = useState(normalizedInitialSources);
  const [pickerError, setPickerError] = useState<string | null>(null);
  // AR-014 导入互斥：已有后台导入进行中时禁止第二次提交。
  const importLocked = useHasRunningOperation(tracker, "import");
  const [commitBlockedNotice, setCommitBlockedNotice] = useState(false);
  const commitLockNotice = importLocked || commitBlockedNotice;
  const operationRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);

  // 互斥的 import 结束后自动解除本地锁定提示。
  useEffect(() => {
    if (!importLocked) setCommitBlockedNotice(false);
  }, [importLocked]);

  const runAcquisition = async () => {
    const operation = ++operationRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    dispatch({ type: "parse_started" });
    try {
      const inputs = selectedSources.length > 0 ? selectedSources : [state.sourceText];
      const descriptors = [];
      const sourceCounts: { source: string; count: number }[] = [];
      const candidates = [];
      for (const input of inputs) {
        const descriptor = await facade.parseSource(input);
        if (operation !== operationRef.current) return;
        descriptors.push(descriptor);
      }
      if (operation !== operationRef.current) return;
      const descriptor = descriptors[0];
      if (!descriptor) throw new Error(t("importWorkflow.errors.emptySource"));
      dispatch({ type: "parse_succeeded", descriptor });
      for (let index = 0; index < descriptors.length; index += 1) {
        if (operation !== operationRef.current) return;
        const acquired = await facade.acquireCandidates(descriptors[index], controller.signal);
        candidates.push(...acquired);
        sourceCounts.push({ source: inputs[index], count: acquired.length });
      }
      if (operation !== operationRef.current) return;
      dispatch({ type: "acquire_succeeded", candidates, sourceCounts });
    } catch (error) {
      if (operation !== operationRef.current) return;
      if (error instanceof ImportCancelledError) {
        dispatch({ type: "cancelled" });
      } else {
        dispatch({
          error: error instanceof Error ? error.message : t("importWorkflow.errors.unknown"),
          previousPhase: "source",
          type: "failed",
        });
      }
    }
  };

  const pickLocalDirectory = async () => {
    setPickerError(null);
    try {
      const path = await directoryPicker.pickDirectory();
      if (!path) return;
      setSelectedSources([]);
      dispatch({ type: "source_changed", value: normalizeWindowsPath(path) });
    } catch (error) {
      setPickerError(error instanceof Error ? error.message : t("importWorkflow.source.pickerFailed"));
    }
  };

  const cancelAcquisition = async () => {
    operationRef.current += 1;
    abortRef.current?.abort();
    await facade.cancel();
    dispatch({ type: "cancelled" });
  };

  const analyze = async () => {
    const operation = ++operationRef.current;
    dispatch({ type: "analysis_started" });
    try {
      const plan = await facade.analyzeConflicts(state.selectedIds.map(
        (id) => state.candidates.find((candidate) => candidate.id === id),
      ).filter((candidate): candidate is CandidateSelectionProps["candidates"][number] => Boolean(candidate)));
      if (operation === operationRef.current) dispatch({ type: "analysis_succeeded", plan });
    } catch (error) {
      if (operation === operationRef.current) {
        dispatch({ type: "failed", error: error instanceof Error ? error.message : t("importWorkflow.errors.unknown"), previousPhase: "candidates" });
      }
    }
  };

  const commit = async () => {
    if (!state.plan) return;
    // 在 begin 之前检查：进行中的 import（包括其他向导实例提交的）阻塞本次提交；
    // 自己后续的 begin 不会被误判，因为检查发生在登记之前。
    if (tracker.hasRunningKind("import")) {
      setCommitBlockedNotice(true);
      return;
    }
    const operation = ++operationRef.current;
    const total = state.plan.candidates.length;
    dispatch({ type: "commit_started", total });
    // 提交循环挂在全局 tracker 上：用户离开本页（组件卸载）后循环继续，
    // 进度与结果通过全局指示器可见（验收反馈 #12）。
    const trackedId = tracker.begin({
      kind: "import",
      label: t("importWorkflow.tracker.label"),
      total,
    });
    try {
      const results = await facade.commitImport(state.plan, state.actions, (progress) => {
        tracker.progress(trackedId, progress.completed, progress.total);
        if (operation === operationRef.current) dispatch({ type: "commit_progress", progress });
      });
      const summary: TrackedResultSummary = {
        succeeded: results.filter((result) => result.status === "succeeded").length,
        failed: results.filter((result) => result.status === "failed").length,
        skipped: results.filter((result) => result.status === "skipped").length,
      };
      tracker.complete(trackedId, summary);
      if (operation === operationRef.current) {
        dispatch({ type: "commit_succeeded", results });
        onComplete?.(results);
      }
    } catch (error) {
      tracker.fail(
        trackedId,
        error instanceof Error ? error.message : t("importWorkflow.errors.unknown"),
      );
      if (operation === operationRef.current) {
        dispatch({ type: "failed", error: error instanceof Error ? error.message : t("importWorkflow.errors.unknown"), previousPhase: "conflicts" });
      }
    }
  };

  const phaseLabel = t(`importWorkflow.phases.${state.phase}`);

  return (
    <section className="sh-import-wizard" aria-labelledby="import-wizard-title">
      <div className="sh-import-wizard__topline">
        <div>
          <p className="sh-import-wizard__eyebrow">{t("importWorkflow.eyebrow")}</p>
          <h1 id="import-wizard-title">{t("importWorkflow.title")}</h1>
        </div>
        <p aria-live="polite" className="sh-import-wizard__phase">{phaseLabel}</p>
      </div>

      <div className="sh-import-wizard__panel">
        {importGuide ? <p aria-live="polite" className="sh-import-wizard__guide">{importGuide}</p> : null}
        {pickerError ? <p aria-live="polite" className="sh-import-source__notice">{pickerError}</p> : null}
        {commitLockNotice && state.phase === "conflicts" ? (
          <p aria-live="polite" role="alert" className="sh-import-source__notice">
            {t("importWorkflow.commit.locked")}
          </p>
        ) : null}
        {(["source", "acquiring", "candidate_gate", "cancelled", "failed"] as WizardPhase[]).includes(state.phase) ? (
          <SourceInput
            actionLabel={selectedSources.length > 0 ? t("importWorkflow.source.acquireSelectedSources") : undefined}
            descriptor={state.descriptor}
            disabled={state.phase === "acquiring"}
            onChange={(value) => {
              setSelectedSources([]);
              dispatch({ type: "source_changed", value: normalizeWindowsPath(value) });
            }}
            onParse={() => void runAcquisition()}
            onPickLocalPath={() => void pickLocalDirectory()}
            onSelectAllSources={() => setSelectedSources(normalizedInitialSources)}
            onToggleSource={(source) => setSelectedSources((current) => current.includes(source) ? current.filter((item) => item !== source) : [...current, source])}
            selectedSources={selectedSources}
            suggestedSources={normalizedInitialSources}
            value={state.sourceText}
          />
        ) : null}

        {state.phase === "acquiring" ? (
          <DataState message={t("importWorkflow.source.acquiring")} state="loading" />
        ) : null}

        {state.phase === "candidate_gate" ? (
          <div className="sh-import-wizard__gate" role="status">
            {state.sourceCounts && state.sourceCounts.length > 1 ? (
              <>
                <p>{t("importWorkflow.acquisition.multiSource", { count: state.sourceCounts.length })}</p>
                <ul>
                  {state.sourceCounts.map(({ source, count }) => (
                    <li key={source}>
                      {t("importWorkflow.acquisition.perSource", { source, count })}
                    </li>
                  ))}
                </ul>
              </>
            ) : null}
            <p>{t("importWorkflow.acquisition.complete", { count: state.candidates.length })}</p>
            <Button onClick={() => dispatch({ type: "show_candidates" })}>{t("importWorkflow.source.continueCandidates")}</Button>
          </div>
        ) : null}

        {state.phase === "candidates" ? (
          <CandidateSelection
            candidates={state.candidates}
            continueLabel={t("importWorkflow.candidates.analyze")}
            onBack={() => dispatch({ type: "source_changed", value: state.sourceText })}
            onSelectAll={() => dispatch({ type: "candidates_selected", ids: state.candidates.map(({ id }) => id) })}
            onContinue={() => void analyze()}
            onToggle={(id) => dispatch({ type: "candidates_selected", ids: state.selectedIds.includes(id) ? state.selectedIds.filter((selectedId) => selectedId !== id) : [...state.selectedIds, id] })}
            selectedIds={state.selectedIds}
          />
        ) : null}

        {state.phase === "analyzing" ? <DataState message={t("importWorkflow.phases.analyzing")} state="loading" /> : null}

        {state.phase === "conflicts" && state.plan ? (
          <ConflictResolution
            actions={state.actions}
            commitDisabled={commitLockNotice}
            conflicts={state.plan.conflicts}
            continueLabel={t("importWorkflow.conflicts.commit")}
            onAction={(candidateId, action) => dispatch({ type: "action_selected", candidateId, action })}
            onBack={() => dispatch({ type: "show_candidates" })}
            onContinue={() => void commit()}
          />
        ) : null}

        {state.phase === "committing" ? (
          <DataState
            message={state.commitProgress ? t("importWorkflow.phases.committingProgress", { ...state.commitProgress }) : t("importWorkflow.phases.committing")}
            state="loading"
            hint={t("importWorkflow.phases.committingBackgroundHint")}
          />
        ) : null}

        {state.phase === "summary" ? <ImportSummary onOpenLibrary={onOpenLibrary} onRetry={() => dispatch({ type: "retry" })} results={state.results} /> : null}

        {state.phase === "cancelled" ? (
          <DataState actionLabel={t("importWorkflow.source.retry")} message={t("importWorkflow.cancelled")} onAction={() => dispatch({ type: "retry" })} state="empty" />
        ) : null}

        {state.phase === "failed" ? (
          <DataState actionLabel={t("actions.retry")} message={state.error ?? t("importWorkflow.errors.unknown")} onAction={() => dispatch({ type: "retry" })} state="error" />
        ) : null}
      </div>

      {state.phase === "acquiring" ? (
        <div className="sh-import-wizard__actions">
          <Button onClick={() => void cancelAcquisition()} variant="ghost">{t("importWorkflow.source.cancelAcquiring")}</Button>
        </div>
      ) : null}
    </section>
  );
}
