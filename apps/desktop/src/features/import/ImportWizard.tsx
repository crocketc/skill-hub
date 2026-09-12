import { useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { describeNativeError } from "../../api/nativeErrors";
import { useAppNotifications } from "../../ui/notifications";
import { Button } from "../../ui/Button";
import { DataState } from "../../ui/DataState";
import { ConflictResolution } from "./ConflictResolution";
import {
  CandidateSelection,
  type CandidateSelectionProps,
} from "./CandidateSelection";
import {
  ImportCancelledError,
  ImportUnavailableError,
  type ImportAction,
  type ImportAiPreCheckReport,
  type ImportFacade,
  type ImportPlan,
  type ImportProgress,
  type ImportResult,
  type SourceDescriptor,
  type SourceScanStatus,
  unavailableImportFacade,
} from "./api";
import { ImportShell, type ImportStatus, type ImportStep } from "./ImportShell";
import { ImportSummary } from "./ImportSummary";
import { SourceInput } from "./SourceInput";
import { readSessionSelectedSources, writeSessionSelectedSources } from "./sessionSources";
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

/** M-29：来源扫描结果——按目录记录候选数或失败原因，未扫描的来源不在此列。 */
interface SourceScanResult {
  source: string;
  status: SourceScanStatus;
}

interface WizardState {
  phase: WizardPhase;
  previousPhase?: WizardPhase;
  sourceText: string;
  descriptor?: SourceDescriptor;
  candidates: CandidateSelectionProps["candidates"];
  /** AR-006：候选按来源分组，支持在门槛页移除单个来源及其候选。 */
  candidatesBySource: { source: string; candidates: CandidateSelectionProps["candidates"] }[];
  selectedIds: string[];
  plan?: ImportPlan;
  actions: Record<string, ImportAction>;
  commitProgress?: ImportProgress;
  results: ImportResult[];
  /** M-29：每个已扫描目录的结果（候选数/失败原因）；保持扫描顺序。 */
  sourceResults: SourceScanResult[];
  /** M-29：单个失败目录重试中（显示进行中状态）。 */
  retryingSource?: string;
  error?: string;
}

type WizardEvent =
  | { type: "source_changed"; value: string }
  | { type: "back_to_sources" }
  | { type: "parse_started" }
  | { type: "parse_succeeded"; descriptor: SourceDescriptor }
  | { type: "acquire_succeeded"; candidates: WizardState["candidates"]; sourceResults: SourceScanResult[]; candidatesBySource: WizardState["candidatesBySource"] }
    | { type: "source_added"; source: string; inputValue: string }
  | { type: "source_removed"; source: string }
  | { type: "sources_cleared" }
  | { type: "show_candidates" }
  | { type: "candidates_selected"; ids: string[] }
  | { type: "analysis_started" }
  | { type: "analysis_succeeded"; plan: ImportPlan }
  | { type: "action_selected"; candidateId: string; action: ImportAction }
  | { type: "commit_started"; total: number }
  | { type: "commit_progress"; progress: ImportProgress }
  | { type: "commit_succeeded"; results: ImportResult[] }
  | { type: "source_rescan_started"; source: string }
  | { type: "source_rescan_finished"; source: string; status: SourceScanStatus; candidates: WizardState["candidates"] }
  | { type: "failed"; error: string; previousPhase: WizardPhase }
  | { type: "cancelled" }
  | { type: "retry" };

const initialState: WizardState = {
  actions: {},
  candidates: [],
  candidatesBySource: [],
  phase: "source",
  results: [],
  selectedIds: [],
  sourceResults: [],
  sourceText: "",
};

/** M-29：把重扫结果并入按目录结果列表——已有条目原位替换，新条目追加。 */
function upsertSourceResult(
  results: SourceScanResult[],
  source: string,
  status: SourceScanStatus,
): SourceScanResult[] {
  const existing = results.findIndex((result) => result.source === source);
  if (existing === -1) return [...results, { source, status }];
  return results.map((result, index) =>
    index === existing ? { source, status } : result,
  );
}

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
        sourceResults: [],
        retryingSource: undefined,
        sourceText: event.value,
      };
    case "back_to_sources":
      // M-29：返回来源步骤——已选列表与每个目录的最近扫描结果保留，
      // 只清空派生的候选选择；再次扫描会刷新这些结果。
      return {
        ...state,
        actions: {},
        candidates: [],
        candidatesBySource: [],
        commitProgress: undefined,
        error: undefined,
        phase: "source",
        plan: undefined,
        selectedIds: [],
      };
    case "parse_started":
      return { ...state, error: undefined, phase: "acquiring", retryingSource: undefined };
    case "parse_succeeded":
      return { ...state, descriptor: event.descriptor };
    case "acquire_succeeded":
      return {
        ...state,
        candidates: event.candidates,
        candidatesBySource: event.candidatesBySource,
        error: undefined,
        phase: "candidate_gate",
        retryingSource: undefined,
        sourceResults: event.sourceResults,
      };
    case "source_added":
      // M-29：追加来源立即进入已选列表（未扫描），不清空已有扫描结果；
      // inputValue 决定输入框内容（手动添加清空，本机选取保留路径）。
      return {
        ...state,
        error: undefined,
        sourceResults: upsertSourceResult(state.sourceResults, event.source, { kind: "unscanned" }),
        sourceText: event.inputValue,
      };
    case "source_removed": {
      // AR-006/M-29：局部调整来源——仅丢弃被移除来源的候选与结果，其余保留；
      // 阶段保持不变（来源页删除停在来源页，门槛页删除停在门槛页）。
      const remaining = state.candidatesBySource.filter(
        (entry) => entry.source !== event.source,
      );
      const remainingResults = state.sourceResults.filter(
        (result) => result.source !== event.source,
      );
      const remainingCandidates = remaining.flatMap((entry) => entry.candidates);
      const remainingIds = new Set(remainingCandidates.map((candidate) => candidate.id));
      if (remaining.length === 0 && remainingResults.length === 0) {
        return { ...initialState, sourceText: state.sourceText };
      }
      return {
        ...state,
        candidates: remainingCandidates,
        candidatesBySource: remaining,
        selectedIds: state.selectedIds.filter((id) => remainingIds.has(id)),
        sourceResults: remainingResults,
      };
    }
    case "sources_cleared":
      return { ...initialState, sourceText: state.sourceText };
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
    case "source_rescan_started":
      // M-29：单个失败目录重试——其余目录的候选与结果保持不动。
      return { ...state, error: undefined, phase: "acquiring", retryingSource: event.source };
    case "source_rescan_finished": {
      const others = state.candidatesBySource.filter(
        (entry) => entry.source !== event.source,
      );
      const candidatesBySource = event.status.kind === "scanned"
        ? [...others, { source: event.source, candidates: event.candidates }]
        : others;
      const candidates = candidatesBySource.flatMap((entry) => entry.candidates);
      const remainingIds = new Set(candidates.map((candidate) => candidate.id));
      return {
        ...state,
        candidates,
        candidatesBySource,
        phase: "candidate_gate",
        retryingSource: undefined,
        selectedIds: state.selectedIds.filter((id) => remainingIds.has(id)),
        sourceResults: upsertSourceResult(state.sourceResults, event.source, event.status),
      };
    }
    case "failed":
      return { ...state, error: event.error, phase: "failed", previousPhase: event.previousPhase };
    case "cancelled":
      return { ...state, error: undefined, phase: "cancelled", previousPhase: "source", retryingSource: undefined };
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

/** 展示层映射：每个阶段归属唯一流程步骤；失败态回到触发它的步骤。 */
function flowStepIndex(phase: WizardPhase, previousPhase?: WizardPhase): number {
  switch (phase) {
    case "candidates":
    case "analyzing":
      return 1;
    case "conflicts":
    case "committing":
      return 2;
    case "summary":
      return 3;
    case "failed":
      return previousPhase === "conflicts"
        ? 2
        : previousPhase === "candidates" || previousPhase === "analyzing"
          ? 1
          : 0;
    default:
      return 0;
  }
}

export interface ImportWizardProps {
  directoryPicker?: DirectoryPicker;
  facade?: ImportFacade;
  initialSources?: string[];
  initialSourceText?: string;
  importGuide?: string;
  /** onboarding：初始化批量导入只读取已选目录候选，不提供手动追加来源按钮。 */
  variant?: "onboarding" | "standard";
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
  variant = "standard",
  tracker = operationTracker,
  onComplete,
  onOpenLibrary = () => undefined,
}: ImportWizardProps) {
  const { t } = useTranslation();
  // 验收反馈：导入提交的成功/失败/取消接入全局通知；错误详情仍留在流程页。
  const { notify } = useAppNotifications();
  const normalizedInitialSources = Array.from(new Set(initialSources.map(normalizeWindowsPath)));
  const normalizedInitialSourceText = normalizeWindowsPath(initialSourceText);
  const [state, dispatch] = useReducer(reducer, { ...initialState, sourceText: normalizedInitialSourceText });
  // M-29：标准变体的已选来源在会话内存续——重开向导后仍保留。
  const [selectedSources, setSelectedSources] = useState<string[]>(() => {
    if (variant !== "standard") return normalizedInitialSources;
    return Array.from(new Set([...readSessionSelectedSources(), ...normalizedInitialSources]));
  });
  // M-29：重复添加同一目录时聚焦已有条目（展示层状态）。
  const [focusedSource, setFocusedSource] = useState<string>();
  const [pickerError, setPickerError] = useState<string | null>(null);
  // AR-014 导入互斥：已有后台导入进行中时禁止第二次提交。
  const importLocked = useHasRunningOperation(tracker, "import");
  const [commitBlockedNotice, setCommitBlockedNotice] = useState(false);
  const commitLockNotice = importLocked || commitBlockedNotice;
  const operationRef = useRef(0);
  const abortRef = useRef<AbortController | null>(null);
  // US-016 第 5 步：AI 预检由用户主动发起，跳过不影响确定性导入门。
  const [aiPreCheck, setAiPreCheck] = useState<ImportAiPreCheckReport>();
  const [aiPreCheckRunning, setAiPreCheckRunning] = useState(false);
  const [aiPreCheckError, setAiPreCheckError] = useState<string | null>(null);
  const [aiPreCheckSkipped, setAiPreCheckSkipped] = useState(false);

  // M-29：已选来源同步进会话存储（标准变体）；副作用集中在 effect，避免渲染期写入。
  useEffect(() => {
    if (variant === "standard") writeSessionSelectedSources(selectedSources);
  }, [selectedSources, variant]);

  // 互斥的 import 结束后自动解除本地锁定提示。
  useEffect(() => {
    if (!importLocked) setCommitBlockedNotice(false);
  }, [importLocked]);

  const statusBySource: Record<string, SourceScanStatus> = {};
  const selectedSet = new Set(selectedSources);
  for (const result of state.sourceResults) {
    // 只向来源列表暴露仍处于已选状态的目录状态；门槛页使用完整扫描结果。
    if (selectedSet.has(result.source)) statusBySource[result.source] = result.status;
  }

  const runAcquisition = async () => {
    const operation = ++operationRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    dispatch({ type: "parse_started" });
    try {
      const inputs = selectedSources.length > 0 ? selectedSources : [state.sourceText];
      const sourceResults: SourceScanResult[] = [];
      const candidatesBySource: WizardState["candidatesBySource"] = [];
      const candidates: WizardState["candidates"] = [];
      let firstDescriptor: SourceDescriptor | undefined;
      for (const input of inputs) {
        // M-29：逐目录扫描——单目录失败记录该目录原因并继续，不影响其他目录。
        try {
          const descriptor = await facade.parseSource(input);
          if (operation !== operationRef.current) return;
          const acquired = await facade.acquireCandidates(descriptor, controller.signal);
          if (operation !== operationRef.current) return;
          firstDescriptor = firstDescriptor ?? descriptor;
          candidates.push(...acquired);
          candidatesBySource.push({ source: input, candidates: acquired });
          sourceResults.push({ source: input, status: { kind: "scanned", count: acquired.length } });
        } catch (error) {
          if (operation !== operationRef.current) return;
          // 取消与"宿主未提供导入能力"是流程级事件：前者走取消态，
          // 后者保持全局失败+重试（单目录重试解决不了环境缺失）。
          if (error instanceof ImportCancelledError) throw error;
          if (error instanceof ImportUnavailableError) throw error;
          sourceResults.push({
            source: input,
            status: {
              kind: "failed",
              reason: describeNativeError(error, (key, options) => String(t(key as never, options as never)), "importWorkflow.errors.generic"),
            },
          });
        }
      }
      if (firstDescriptor) dispatch({ type: "parse_succeeded", descriptor: firstDescriptor });
      dispatch({ type: "acquire_succeeded", candidates, sourceResults, candidatesBySource });
    } catch (error) {
      if (operation !== operationRef.current) return;
      if (error instanceof ImportCancelledError) {
        dispatch({ type: "cancelled" });
      } else {
        dispatch({
error: describeNativeError(error, (key, options) => String(t(key as never, options as never)), "importWorkflow.errors.generic"),
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
      const normalized = normalizeWindowsPath(path);
      // M-29：本机选取的目录直接进入已选来源列表（未扫描），同时保留
      // 在输入框中，用户可以继续追加或直接读取候选。
      setSelectedSources((current) => [...new Set([...current, normalized])]);
      setFocusedSource(normalized);
      dispatch({ type: "source_added", inputValue: normalized, source: normalized });
    } catch (error) {
      setPickerError(error instanceof Error ? error.message : t("importWorkflow.source.pickerFailed"));
    }
  };

  const cancelAcquisition = async () => {
    operationRef.current += 1;
    abortRef.current?.abort();
    await facade.cancel();
    notify({ tone: "info", title: t("importWorkflow.notifications.cancelledTitle") });
    dispatch({ type: "cancelled" });
  };

  // AR-006：局部移除来源——同步勾选列表，避免后续重读时又带上。
  const removeSource = (source: string) => {
    setSelectedSources((current) => current.filter((item) => item !== source));
    dispatch({ type: "source_removed", source });
  };

  // M-29：多选删除——逐个来源走同一条移除路径。
  const removeSources = (sources: string[]) => {
    for (const source of sources) removeSource(source);
  };

  const clearSources = () => {
    setSelectedSources([]);
    dispatch({ type: "sources_cleared" });
  };

  // AR-006/M-29：混合导入——手动目录追加进已选来源列表并立即可见（未扫描）；
  // 重复添加去重并聚焦已有条目。
  const addManualSource = async (source: string) => {
    const normalized = normalizeWindowsPath(source);
    if (!normalized.trim()) return;
    if (selectedSources.includes(normalized)) {
      setFocusedSource(normalized);
      return;
    }
    await facade.parseSource(normalized);
    setSelectedSources((current) => [...new Set([...current, normalized])]);
    setFocusedSource(normalized);
    dispatch({ type: "source_added", inputValue: "", source: normalized });
  };

  // M-29：单个失败目录的重试——只重扫该目录，不惊动其他目录的候选。
  const rescanSource = async (source: string) => {
    const operation = ++operationRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    dispatch({ type: "source_rescan_started", source });
    try {
      const descriptor = await facade.parseSource(source);
      if (operation !== operationRef.current) return;
      const acquired = await facade.acquireCandidates(descriptor, controller.signal);
      if (operation !== operationRef.current) return;
      dispatch({
        candidates: acquired,
        source,
        status: { kind: "scanned", count: acquired.length },
        type: "source_rescan_finished",
      });
    } catch (error) {
      if (operation !== operationRef.current) return;
      if (error instanceof ImportCancelledError) {
        dispatch({ type: "cancelled" });
        return;
      }
      dispatch({
        source,
        status: {
          kind: "failed",
          reason: describeNativeError(error, (key, options) => String(t(key as never, options as never)), "importWorkflow.errors.generic"),
        },
        type: "source_rescan_finished",
        candidates: [],
      });
    }
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
        dispatch({ type: "failed", error: describeNativeError(error, (key, options) => String(t(key as never, options as never)), "importWorkflow.errors.generic"), previousPhase: "candidates" });
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
      // 全局通知不依赖向导仍挂载：用户离开页面后提交完成也要可见。
      notify({
        tone: summary.failed > 0 ? "warning" : "success",
        title: t("importWorkflow.notifications.succeededTitle"),
        detail: t("importWorkflow.notifications.succeededDetail", {
          failed: summary.failed,
          skipped: summary.skipped,
          succeeded: summary.succeeded,
        }),
        action: { label: t("importWorkflow.notifications.openLibrary"), to: "/library" },
      });
      if (operation === operationRef.current) {
        dispatch({ type: "commit_succeeded", results });
        onComplete?.(results);
      }
    } catch (error) {
      const commitError = describeNativeError(error, (key, options) => String(t(key as never, options as never)), "importWorkflow.errors.generic");
      tracker.fail(trackedId, commitError);
      notify({
        tone: "danger",
        title: t("importWorkflow.notifications.failedTitle"),
        detail: commitError,
      });
      if (operation === operationRef.current) {
        dispatch({ type: "failed", error: commitError, previousPhase: "conflicts" });
      }
    }
  };

  const runAiPreChecks = async () => {
    if (!state.plan || !facade.runAiPreChecks || aiPreCheckRunning) return;
    setAiPreCheckRunning(true);
    setAiPreCheckError(null);
    setAiPreCheckSkipped(false);
    try {
      setAiPreCheck(await facade.runAiPreChecks(state.plan));
    } catch (error) {
      setAiPreCheckError(describeNativeError(error, (key, options) => String(t(key as never, options as never)), "importWorkflow.errors.generic"));
    } finally {
      setAiPreCheckRunning(false);
    }
  };

  const hasFailure = state.results.some((result) => result.status === "failed");
  const stepIndex = flowStepIndex(state.phase, state.previousPhase);
  const flowSteps: ImportStep[] = (["source", "candidates", "conflicts", "summary"] as const).map(
    (key, index) => ({
      label: t(`importWorkflow.phases.${key}`),
      state: index < stepIndex ? "complete" : index === stepIndex ? "current" : "upcoming",
    }),
  );
  const statusText = t(`importWorkflow.phases.${state.phase}`);
  const status: ImportStatus =
    state.phase === "summary"
      ? { kind: hasFailure ? "warning" : "success", text: statusText }
      : state.phase === "failed"
        ? { kind: "failure", text: statusText }
        : { kind: "info", text: statusText };

  const missingRequiredAction = (state.plan?.conflicts ?? []).some(
    (conflict) => conflict.required && !state.actions[conflict.candidateId],
  );
  const canParse = state.phase === "source"
    && (state.sourceText.trim().length > 0 || selectedSources.length > 0);

  let actions: { secondary: ReactNode[]; primary: ReactNode[] };
  switch (state.phase) {
    case "source":
      actions = {
        primary: [
          <Button disabled={!canParse} key="parse" onClick={() => void runAcquisition()} size="lg">
            {selectedSources.length > 0
              ? t("importWorkflow.source.acquireSelectedSources")
              : t("importWorkflow.source.parse")}
          </Button>,
        ],
        secondary: variant !== "onboarding"
          ? [
              <Button
                disabled={!state.sourceText.trim()}
                key="add-source"
                onClick={() => void addManualSource(state.sourceText)}
                variant="secondary"
              >
                {t("importWorkflow.source.addSource")}
              </Button>,
            ]
          : [],
      };
      break;
    case "acquiring":
      actions = {
        primary: [
          <Button key="cancel" onClick={() => void cancelAcquisition()} variant="ghost">
            {t("importWorkflow.source.cancelAcquiring")}
          </Button>,
        ],
        secondary: [],
      };
      break;
    case "candidate_gate":
      actions = {
        primary: [
          <Button
            disabled={state.candidates.length === 0}
            key="gate-continue"
            onClick={() => dispatch({ type: "show_candidates" })}
            size="lg"
          >
            {t("importWorkflow.source.continueCandidates")}
          </Button>,
        ],
        secondary: [],
      };
      break;
    case "candidates":
      actions = {
        primary: [
          <Button
            disabled={!state.selectedIds.length}
            key="analyze"
            onClick={() => void analyze()}
            size="lg"
          >
            {t("importWorkflow.candidates.analyze")}
          </Button>,
        ],
        secondary: [
          <Button
            key="back"
            onClick={() => dispatch({ type: "back_to_sources" })}
            variant="ghost"
          >
            {t("actions.back")}
          </Button>,
        ],
      };
      break;
    case "conflicts":
      actions = {
        primary: [
          <Button
            disabled={missingRequiredAction || commitLockNotice}
            key="commit"
            onClick={() => void commit()}
            size="lg"
          >
            {t("importWorkflow.conflicts.commit")}
          </Button>,
        ],
        secondary: [
          <Button key="back" onClick={() => dispatch({ type: "show_candidates" })} variant="ghost">
            {t("actions.back")}
          </Button>,
        ],
      };
      break;
    case "summary":
      actions = {
        primary: [
          <Button key="open-library" onClick={onOpenLibrary} size="lg">
            {t("importWorkflow.summary.openLibrary")}
          </Button>,
        ],
        secondary: hasFailure
          ? [<Button key="retry" onClick={() => dispatch({ type: "retry" })} variant="secondary">{t("actions.retry")}</Button>]
          : [],
      };
      break;
    case "cancelled":
      actions = {
        primary: [
          <Button key="retry" onClick={() => dispatch({ type: "retry" })} size="lg">
            {t("importWorkflow.source.retry")}
          </Button>,
        ],
        secondary: [],
      };
      break;
    case "failed":
      actions = {
        primary: [
          <Button key="retry" onClick={() => dispatch({ type: "retry" })} size="lg">
            {t("actions.retry")}
          </Button>,
        ],
        secondary: [],
      };
      break;
    default:
      // analyzing / committing：进度态不提供流程动作。
      actions = { primary: [], secondary: [] };
  }

  return (
    <ImportShell
      eyebrow={t("importWorkflow.eyebrow")}
      footer={actions.primary.length + actions.secondary.length > 0 ? (
        <>
          {actions.secondary.length > 0 ? (
            <div className="sh-import-wizard__actions-group">{actions.secondary}</div>
          ) : null}
          {actions.primary.length > 0 ? (
            <div className="sh-import-wizard__actions-group sh-import-wizard__actions-group--primary">
              {actions.primary}
            </div>
          ) : null}
        </>
      ) : undefined}
      status={status}
      steps={flowSteps}
      stepsLabel={t("importWorkflow.steps.label")}
      title={t("importWorkflow.title")}
    >
      {importGuide ? <p aria-live="polite" className="sh-import-wizard__guide">{importGuide}</p> : null}
      {pickerError ? <p aria-live="polite" className="sh-import-source__notice">{pickerError}</p> : null}
      {commitLockNotice && state.phase === "conflicts" ? (
        <p aria-live="polite" role="alert" className="sh-import-source__notice">
          {t("importWorkflow.commit.locked")}
        </p>
      ) : null}
      {(["source", "acquiring", "candidate_gate", "cancelled", "failed"] as WizardPhase[]).includes(state.phase) ? (
        <SourceInput
          descriptor={state.descriptor}
          disabled={state.phase === "acquiring"}
          focusedSource={focusedSource}
          onChange={(value) => {
            // AR-006：输入手动来源不再清空已选扫描来源（混合导入）。
            dispatch({ type: "source_changed", value: normalizeWindowsPath(value) });
          }}
          onClearSources={clearSources}
          onFocusedSourceApplied={() => setFocusedSource(undefined)}
          onPickLocalPath={() => void pickLocalDirectory()}
          onRemoveSource={removeSource}
          onRemoveSources={removeSources}
          onSelectAllSources={() => setSelectedSources((current) => {
            const allSelected = normalizedInitialSources.every((source) => current.includes(source));
            if (allSelected) {
              return current.filter((source) => !normalizedInitialSources.includes(source));
            }
            return [...new Set([...current, ...normalizedInitialSources])];
          })}
          onToggleSource={(source) => setSelectedSources((current) => current.includes(source) ? current.filter((item) => item !== source) : [...current, source])}
          selectedSources={selectedSources}
          sourceStatuses={statusBySource}
          suggestedSources={normalizedInitialSources}
          value={state.sourceText}
        />
      ) : null}

      {state.phase === "acquiring" ? (
        <DataState message={t("importWorkflow.source.acquiring")} state="loading" />
      ) : null}

      {state.phase === "candidate_gate" ? (
        <div className="sh-import-wizard__gate" role="status">
          {state.sourceResults.length > 0 ? (
            <>
              <p>{t("importWorkflow.acquisition.multiSource", { count: state.sourceResults.filter((result) => result.status.kind === "scanned").length })}</p>
              <ul>
                {state.sourceResults.map(({ source, status: scanStatus }) => (
                  <li key={source}>
                    {scanStatus.kind === "failed" ? (
                      <>
                        {t("importWorkflow.acquisition.perSourceFailed", { reason: scanStatus.reason, source })}
                        <Button
                          aria-label={t("importWorkflow.sources.retrySource", { source })}
                          disabled={state.phase !== "candidate_gate"}
                          loading={state.retryingSource === source}
                          onClick={() => void rescanSource(source)}
                          size="sm"
                          variant="secondary"
                        >
                          {t("importWorkflow.sources.retry")}
                        </Button>
                      </>
                    ) : (
                      <>
                        {t("importWorkflow.acquisition.perSource", { count: scanStatus.count, source })}
                      </>
                    )}
                    <Button
                      aria-label={t("importWorkflow.acquisition.removeSource", { source })}
                      disabled={state.phase !== "candidate_gate"}
                      onClick={() => removeSource(source)}
                      size="sm"
                      variant="ghost"
                    >
                      {t("importWorkflow.acquisition.remove")}
                    </Button>
                  </li>
                ))}
              </ul>
              <Button onClick={clearSources} size="sm" variant="secondary">
                {t("importWorkflow.acquisition.removeAllSources")}
              </Button>
            </>
          ) : null}
          <p>{t("importWorkflow.acquisition.complete", { count: state.candidates.length })}</p>
        </div>
      ) : null}

      {state.phase === "candidates" ? (
        <CandidateSelection
          candidates={state.candidates}
          onSelectAll={() => dispatch({ type: "candidates_selected", ids: state.candidates.map(({ id }) => id) })}
          onToggle={(id) => dispatch({ type: "candidates_selected", ids: state.selectedIds.includes(id) ? state.selectedIds.filter((selectedId) => selectedId !== id) : [...state.selectedIds, id] })}
          selectedIds={state.selectedIds}
        />
      ) : null}

      {state.phase === "analyzing" ? <DataState message={t("importWorkflow.phases.analyzing")} state="loading" /> : null}

      {state.phase === "conflicts" && state.plan ? (
        <>
          <ConflictResolution
            actions={state.actions}
            conflicts={state.plan.conflicts}
            onAction={(candidateId, action) => dispatch({ type: "action_selected", candidateId, action })}
          />
          <section aria-labelledby="import-ai-precheck-heading" className="sh-import-wizard__gate">
            <h2 id="import-ai-precheck-heading">{t("importWorkflow.aiPreCheck.heading")}</h2>
            <p className="sh-settings-local-note">{t("importWorkflow.aiPreCheck.description")}</p>
            <p>
              {t("importWorkflow.aiPreCheck.scope", { count: state.plan.candidates.length })}
            </p>
            {facade.runAiPreChecks ? (
              <div className="sh-button-row">
                <Button
                  disabled={aiPreCheckRunning}
                  loading={aiPreCheckRunning}
                  onClick={() => void runAiPreChecks()}
                  variant="secondary"
                >
                  {aiPreCheckRunning
                    ? t("importWorkflow.aiPreCheck.running")
                    : t("importWorkflow.aiPreCheck.run")}
                </Button>
                <Button onClick={() => setAiPreCheckSkipped(true)} variant="ghost">
                  {t("importWorkflow.aiPreCheck.skip")}
                </Button>
              </div>
            ) : (
              <p>{t("importWorkflow.aiPreCheck.unavailable")}</p>
            )}
            {aiPreCheckSkipped ? <p role="status">{t("importWorkflow.aiPreCheck.skippedNote")}</p> : null}
            {aiPreCheckError ? (
              <>
                <p role="alert">{aiPreCheckError}</p>
                <p role="status">{t("importWorkflow.aiPreCheck.errorNote")}</p>
              </>
            ) : null}
            {aiPreCheck && !aiPreCheckSkipped ? (
              <div>
                <p>
                  {t("importWorkflow.aiPreCheck.reportHeader", {
                    count: aiPreCheck.requested,
                    model: aiPreCheck.model,
                    provider: aiPreCheck.provider,
                  })}
                </p>
                <ul>
                  {aiPreCheck.outcomes.map((outcome) => (
                    <li key={outcome.candidateId}>
                      <strong>{outcome.candidateId}</strong>{" "}
                      <span className="sh-status sh-status--muted">
                        {t(`importWorkflow.aiPreCheck.states.${outcome.state}`)}
                      </span>
                      <span>
                        {" · "}
                        {t("importWorkflow.aiPreCheck.findings", { count: outcome.findingCount, files: outcome.fileCount })}
                      </span>
                      {outcome.failureCode ? (
                        <span role="status">
                          {" · "}
                          {t("importWorkflow.aiPreCheck.failureReadable", {
                            reason: describeNativeError(
                              { code: outcome.failureCode, severity: "error", params: {}, actions: [] },
                              (key, options) => String(t(key as never, options as never)),
                              "importWorkflow.aiPreCheck.failureUnknown",
                            ),
                          })}
                        </span>
                      ) : null}
                    </li>
                  ))}
                </ul>
                <p className="sh-settings-local-note">{t("importWorkflow.aiPreCheck.gatesNote")}</p>
              </div>
            ) : null}
          </section>
        </>
      ) : null}

      {state.phase === "committing" ? (
        <DataState
          message={state.commitProgress ? t("importWorkflow.phases.committingProgress", { ...state.commitProgress }) : t("importWorkflow.phases.committing")}
          state="loading"
          hint={t("importWorkflow.phases.committingBackgroundHint")}
        />
      ) : null}

      {state.phase === "summary" ? <ImportSummary results={state.results} /> : null}

      {state.phase === "cancelled" ? (
        <DataState message={t("importWorkflow.cancelled")} state="empty" />
      ) : null}

      {state.phase === "failed" ? (
        <DataState message={state.error ?? t("importWorkflow.errors.unknown")} state="error" />
      ) : null}
    </ImportShell>
  );
}
