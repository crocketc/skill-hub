import { useCallback, useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { describeNativeError } from "../../api/nativeErrors";
import { useAppNotifications } from "../../ui/notifications";
import { Button } from "../../ui/Button";
import { DataState } from "../../ui/DataState";
import { usableLlmProviderLabel } from "../settings/llmApi";
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
import { RelationshipGovernancePanel } from "../relationshipGovernance/RelationshipGovernancePanel";
import {
  hasExplicitGovernanceConfirmation,
  type ImportGovernanceDecision,
} from "../relationshipGovernance/relationshipGovernance";
import { SourceInput } from "./SourceInput";
import { readSessionSelectedSources, writeSessionSelectedSources } from "./sessionSources";
import {
  desktopDirectoryPicker,
  normalizeWindowsPath,
  sameSourcePath,
  type DirectoryPicker,
} from "../../platform/directoryPicker";
import {
  operationTracker,
  useHasRunningOperation,
  type OperationTracker,
} from "../../platform/operationTracker";
import { runTrackedOperation } from "../../platform/runTrackedOperation";

type WizardPhase =
  | "source"
  | "acquiring"
  | "candidate_gate"
  | "candidates"
  | "analyzing"
  | "governance"
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

interface SourcePreview {
  source: string;
  descriptor?: SourceDescriptor;
  candidates: CandidateSelectionProps["candidates"];
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
  governanceDecision: ImportGovernanceDecision;
  commitProgress?: ImportProgress;
  results: ImportResult[];
  /** M-29：每个已扫描目录的结果（候选数/失败原因）；保持扫描顺序。 */
  sourceResults: SourceScanResult[];
  /** M-29：单个失败目录重试中（显示进行中状态）。 */
  retryingSource?: string;
  error?: string;
  /**
   * OPT-20260914-01：冲突分析进度。总数在开始时即真实已知（送入分析的候选数）；
   * 逐项进度只在 facade 回调后存在，未回调前展示不确定进度，绝不伪造百分比。
   */
  analysisStartedAt?: number;
  analysisTotal?: number;
  analysisProgress?: ImportProgress;
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
  | { type: "analysis_started"; startedAt: number; total: number }
  | { type: "analysis_progress"; progress: ImportProgress }
  | { type: "analysis_succeeded"; plan: ImportPlan }
  | { type: "governance_decision"; decision: ImportGovernanceDecision }
  | { type: "governance_confirmed" }
  | { type: "analysis_cancelled" }
  | { type: "action_selected"; candidateId: string; action: ImportAction }
  | { type: "commit_started"; total: number }
  | { type: "commit_progress"; progress: ImportProgress }
  | { type: "commit_succeeded"; results: ImportResult[] }
  | { type: "source_preview_started"; source: string }
  | { type: "source_preview_finished"; source: string; status: SourceScanStatus }
  | { type: "source_rescan_started"; source: string }
  | { type: "source_rescan_finished"; source: string; status: SourceScanStatus; candidates: WizardState["candidates"] }
  | { type: "failed"; error: string; previousPhase: WizardPhase }
  | { type: "cancelled" }
  | { type: "retry" };

const initialState: WizardState = {
  actions: {},
  governanceDecision: { group_actions: {}, item_overrides: {} },
  candidates: [],
  candidatesBySource: [],
  phase: "source",
  results: [],
  selectedIds: [],
  sourceResults: [],
  sourceText: "",
};

const emptyGovernanceDecision = (): ImportGovernanceDecision => ({
  group_actions: {},
  item_overrides: {},
});

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
        governanceDecision: emptyGovernanceDecision(),
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
        governanceDecision: emptyGovernanceDecision(),
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
        governanceDecision: emptyGovernanceDecision(),
      };
    case "source_added":
      // M-29：追加来源立即进入已选列表（未扫描），不清空已有扫描结果；
      // inputValue 决定输入框内容（手动添加清空，本机选取保留路径）。
      return {
        ...state,
        error: undefined,
        sourceResults: upsertSourceResult(state.sourceResults, event.source, { kind: "unscanned" }),
        sourceText: event.inputValue,
        governanceDecision: emptyGovernanceDecision(),
      };
    case "source_preview_started":
      return {
        ...state,
        sourceResults: upsertSourceResult(state.sourceResults, event.source, { kind: "scanning" }),
      };
    case "source_preview_finished":
      return {
        ...state,
        sourceResults: upsertSourceResult(state.sourceResults, event.source, event.status),
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
        governanceDecision: emptyGovernanceDecision(),
        selectedIds: state.selectedIds.filter((id) => remainingIds.has(id)),
        sourceResults: remainingResults,
      };
    }
    case "sources_cleared":
      return { ...initialState, sourceText: state.sourceText };
    case "show_candidates":
      return { ...state, governanceDecision: emptyGovernanceDecision(), phase: "candidates" };
    case "candidates_selected":
      return { ...state, selectedIds: event.ids };
    case "analysis_started":
      return {
        ...state,
        analysisProgress: undefined,
        analysisStartedAt: event.startedAt,
        analysisTotal: event.total,
        error: undefined,
        phase: "analyzing",
        governanceDecision: emptyGovernanceDecision(),
      };
    case "analysis_progress":
      return { ...state, analysisProgress: event.progress };
    case "analysis_succeeded":
      // 离开分析阶段即丢弃进度快照：避免下一次分析开始前残留旧数据。
      return {
        ...state,
        analysisProgress: undefined,
        analysisStartedAt: undefined,
        analysisTotal: undefined,
        error: undefined,
        phase: event.plan.governanceGroups?.length ? "governance" : "conflicts",
        plan: event.plan,
        governanceDecision: emptyGovernanceDecision(),
      };
    case "governance_decision":
      return { ...state, governanceDecision: event.decision };
    case "governance_confirmed":
      return { ...state, phase: "conflicts" };
    case "analysis_cancelled":
      // 分析阶段的取消：回到候选阶段，已选候选保留，在途结果由 operation
      // 序号守卫丢弃（不进入冲突阶段）。
      return {
        ...state,
        analysisProgress: undefined,
        analysisStartedAt: undefined,
        analysisTotal: undefined,
        phase: "candidates",
        governanceDecision: emptyGovernanceDecision(),
      };
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
      return {
        ...state,
        error: undefined,
        governanceDecision: emptyGovernanceDecision(),
        phase: "acquiring",
        retryingSource: event.source,
      };
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
      return {
        ...state,
        analysisProgress: undefined,
        analysisStartedAt: undefined,
        analysisTotal: undefined,
        error: event.error,
        phase: "failed",
        previousPhase: event.previousPhase,
      };
    case "cancelled":
      return { ...state, error: undefined, phase: "cancelled", previousPhase: "source", retryingSource: undefined };
    case "retry":
      return {
        ...state,
        actions: state.previousPhase === "conflicts" ? {} : state.actions,
        analysisProgress: undefined,
        analysisStartedAt: undefined,
        analysisTotal: undefined,
        commitProgress: undefined,
        error: undefined,
        phase: state.previousPhase ?? "source",
        governanceDecision: emptyGovernanceDecision(),
      };
    default:
      return state;
  }
}

/** 展示层映射：每个阶段归属唯一流程步骤；失败态回到触发它的步骤。
 * hasGovernance：分析产出治理分组时流程插入治理步骤，后续步骤顺延。 */
function flowStepIndex(
  phase: WizardPhase,
  previousPhase: WizardPhase | undefined,
  hasGovernance: boolean,
): number {
  const conflictsStep = hasGovernance ? 3 : 2;
  switch (phase) {
    case "candidates":
    case "analyzing":
      return 1;
    case "governance":
      return 2;
    case "conflicts":
    case "committing":
      return conflictsStep;
    case "summary":
      return conflictsStep + 1;
    case "failed":
      return previousPhase === "conflicts" || previousPhase === "committing"
        ? conflictsStep
        : previousPhase === "governance"
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
  onOpenGovernanceTask?: (task: NonNullable<ImportResult["governanceTasks"]>[number]) => void;
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
  onOpenGovernanceTask,
  onOpenLibrary = () => undefined,
}: ImportWizardProps) {
  const { t } = useTranslation();
  // 验收反馈：导入提交的成功/失败/取消接入全局通知；错误详情仍留在流程页。
  const notifications = useAppNotifications();
  const { notify } = notifications;
  const normalizedInitialSources = Array.from(new Set(initialSources.map(normalizeWindowsPath)));
  const normalizedInitialSourceText = normalizeWindowsPath(initialSourceText);
  const [state, dispatch] = useReducer(reducer, {
    ...initialState,
    // onboarding 自动预览从挂载第一帧起就是流程的一部分：初始来源以"未扫描"
    // 进入状态机，页脚据此禁用；条目缺失从此只表示"预览会话已被编辑作废"。
    sourceResults: variant === "onboarding"
      ? normalizedInitialSources.map((source) => ({ source, status: { kind: "unscanned" as const } }))
      : initialState.sourceResults,
    sourceText: normalizedInitialSourceText,
  });
  // M-29：标准变体的已选来源在会话内存续——重开向导后仍保留。
  const [selectedSources, setSelectedSources] = useState<string[]>(() => {
    if (variant !== "standard") return normalizedInitialSources;
    return Array.from(new Set([...readSessionSelectedSources(), ...normalizedInitialSources]));
  });
  // M-29：重复添加同一目录时聚焦已有条目（展示层状态）。
  const [focusedSource, setFocusedSource] = useState<string>();
  const previewRequestsRef = useRef(new Map<string, number>());
  // 预览请求单调序号：来源被移除/作废后重新预览时，新请求的序号不可能与
  // 旧请求相同，迟到的旧完成一定被序号守卫丢弃（不会复活陈旧终结）。
  const previewRequestSeqRef = useRef(0);
  const previewCandidatesRef = useRef(new Map<string, CandidateSelectionProps["candidates"]>());
  const previewStatusesRef = useRef(new Map<string, SourceScanStatus>());
  const previewDescriptorsRef = useRef(new Map<string, SourceDescriptor>());
  const previewPendingRef = useRef(new Set<string>());
  const selectedSourcesRef = useRef(selectedSources);
  selectedSourcesRef.current = selectedSources;
  const [pickerError, setPickerError] = useState<string | null>(null);
  const onboardingPreviewKeyRef = useRef<string>();
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
  // Task 8：AI 可用性接真实信号——已配置并启用的供应商存在即可用。
  // null 表示查询尚未返回（此时不显示按钮，也不伪造不可用提示）。
  const [aiAvailable, setAiAvailable] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    facade
      .listLlmProviders()
      .then((providers) => {
        if (!cancelled) setAiAvailable(usableLlmProviderLabel(providers) !== "");
      })
      .catch(() => {
        if (!cancelled) setAiAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, [facade]);

  // M-29：已选来源同步进会话存储（标准变体）；副作用集中在 effect，避免渲染期写入。
  useEffect(() => {
    if (variant === "standard") writeSessionSelectedSources(selectedSources);
  }, [selectedSources, variant]);

  // 互斥的 import 结束后自动解除本地锁定提示。
  useEffect(() => {
    if (!importLocked) setCommitBlockedNotice(false);
  }, [importLocked]);

  const statusBySource: Record<string, SourceScanStatus> = {};
  for (const result of state.sourceResults) {
    // M-29：来源确认列表同时承载手动解析来源与已选目录的最近结果，
    // 因而失败原因不能只在候选阶段短暂出现后消失。
    statusBySource[result.source] = result.status;
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
          const acquired = previewCandidatesRef.current.get(input)
            ?? await facade.acquireCandidates(descriptor, controller.signal);
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

  const finalizeOnboardingPreviews = useCallback(() => {
    if (variant !== "onboarding") return;
    const selected = selectedSourcesRef.current;
    if (selected.length === 0 || selected.some((source) => previewPendingRef.current.has(source))) return;
    if (selected.some((source) => !previewStatusesRef.current.has(source))) return;
    const sourceResults = selected.map((source) => ({
      source,
      status: previewStatusesRef.current.get(source)!,
    }));
    const candidatesBySource = selected
      .filter((source) => previewStatusesRef.current.get(source)?.kind === "scanned")
      .map((source) => ({ source, candidates: previewCandidatesRef.current.get(source) ?? [] }));
    const candidates = candidatesBySource.flatMap(({ candidates: sourceCandidates }) => sourceCandidates);
    const descriptor = selected
      .map((source) => previewDescriptorsRef.current.get(source))
      .find((item): item is SourceDescriptor => item !== undefined);
    if (descriptor) dispatch({ descriptor, type: "parse_succeeded" });
    dispatch({ candidates, candidatesBySource, sourceResults, type: "acquire_succeeded" });
  }, [variant]);

  const previewSource = useCallback(async (source: string): Promise<SourcePreview | undefined> => {
    const request = ++previewRequestSeqRef.current;
    previewRequestsRef.current.set(source, request);
    previewPendingRef.current.add(source);
    previewStatusesRef.current.delete(source);
    dispatch({ type: "source_preview_started", source });
    try {
      const descriptor = await facade.parseSource(source);
      const candidates = await facade.acquireCandidates(descriptor, new AbortController().signal);
      if (previewRequestsRef.current.get(source) !== request) return;
      previewCandidatesRef.current.set(source, candidates);
      previewDescriptorsRef.current.set(source, descriptor);
      const status = { kind: "scanned", count: candidates.length } as const;
      previewStatusesRef.current.set(source, status);
      previewPendingRef.current.delete(source);
      dispatch({ type: "source_preview_finished", source, status });
      finalizeOnboardingPreviews();
      return { candidates, descriptor, source, status };
    } catch (error) {
      if (previewRequestsRef.current.get(source) !== request) return;
      const reason = describeNativeError(error, (key, options) => String(t(key as never, options as never)), "importWorkflow.errors.generic");
      const status = { kind: "failed", reason } as const;
      previewStatusesRef.current.set(source, status);
      previewPendingRef.current.delete(source);
      dispatch({
        source,
        status,
        type: "source_preview_finished",
      });
      finalizeOnboardingPreviews();
      return { candidates: [], source, status };
    }
  }, [facade, finalizeOnboardingPreviews, t]);

  useEffect(() => {
    if (variant !== "onboarding" || normalizedInitialSources.length === 0) return;
    const key = normalizedInitialSources.join("\u0000");
    if (onboardingPreviewKeyRef.current === key) return;
    onboardingPreviewKeyRef.current = key;
    const onboardingSources = key.split("\u0000");
    for (const source of onboardingSources) void previewSource(source);
  }, [normalizedInitialSources.join("\u0000"), previewSource, variant]);

  // DEV-13：标准向导挂载时已选来源（初始建议 + 会话恢复）立即后台解析。
  // 此前只有 onboarding 变体有自动预览，标准向导的已选来源一直停在
  // 「未扫描」，与文案「Skill 数量会在后台自动解析」不符；用户必须再点
  // 「读取已选目录候选」。挂载后每条来源的勾选/追加各有即时预览路径，
  // 这里只补挂载这一次。
  const standardPreviewKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (variant !== "standard") return;
    const key = [...selectedSourcesRef.current].sort().join("\u0000");
    if (standardPreviewKeyRef.current === key) return;
    standardPreviewKeyRef.current = key;
    for (const source of selectedSourcesRef.current) void previewSource(source);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 作废当前预览会话：清空请求序号表与预览缓存。在途预览的迟到完成因
  // 序号不再匹配被守卫丢弃，不会再写回状态或触发 onboarding 终结。
  const discardPreviews = () => {
    previewRequestsRef.current.clear();
    previewCandidatesRef.current.clear();
    previewStatusesRef.current.clear();
    previewDescriptorsRef.current.clear();
    previewPendingRef.current.clear();
  };

  const pickLocalDirectory = async () => {
    setPickerError(null);
    try {
      const path = await directoryPicker.pickDirectory();
      if (!path) return;
      const normalized = normalizeWindowsPath(path);
      // 与手动添加一致：重复（含仅大小写不同的 Windows 目录）聚焦已有条目，
      // 不新增来源；已扫描状态保持不变。
      const existing = selectedSources.find((item) => sameSourcePath(item, normalized));
      if (existing) {
        setFocusedSource(existing);
        return;
      }
      // M-29：本机选取的目录直接进入统一来源确认列表，并静默预览候选数量。
      const nextSources = [...new Set([...selectedSourcesRef.current, normalized])];
      selectedSourcesRef.current = nextSources;
      setSelectedSources(nextSources);
      setFocusedSource(normalized);
      dispatch({ type: "source_added", inputValue: normalized, source: normalized });
      void previewSource(normalized);
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
    previewRequestsRef.current.delete(source);
    previewCandidatesRef.current.delete(source);
    previewStatusesRef.current.delete(source);
    previewDescriptorsRef.current.delete(source);
    previewPendingRef.current.delete(source);
    selectedSourcesRef.current = selectedSourcesRef.current.filter((item) => item !== source);
    setSelectedSources((current) => current.filter((item) => item !== source));
    dispatch({ type: "source_removed", source });
  };

  // DEV-9：批量删除入口已随复选框收口一并移除（单条删除 + 全部清空已覆盖）。
  const clearSources = () => {
    discardPreviews();
    selectedSourcesRef.current = [];
    setSelectedSources([]);
    dispatch({ type: "sources_cleared" });
  };

  // AR-006/M-29：混合导入——手动目录追加进已选来源列表并立即可见（未扫描）；
  // 重复添加去重并聚焦已有条目。Windows 卷大小写不敏感，Windows 形态路径
  // 折叠大小写比较（列表保留首次添加的写法）；POSIX 路径按大小写敏感精确
  // 比较，macOS 大小写敏感卷上仅大小写不同的目录是两个真实目录。
  const addManualSource = async (source: string) => {
    const normalized = normalizeWindowsPath(source);
    if (!normalized.trim()) return;
    const existing = selectedSources.find((item) => sameSourcePath(item, normalized));
    if (existing) {
      setFocusedSource(existing);
      return;
    }
    const nextSources = [...new Set([...selectedSourcesRef.current, normalized])];
    selectedSourcesRef.current = nextSources;
    setSelectedSources(nextSources);
    setFocusedSource(normalized);
    dispatch({ type: "source_added", inputValue: "", source: normalized });
    void previewSource(normalized);
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

  // OPT-20260914-01：分析已用时间——进入分析阶段启动秒级计时，离开即停。
  // 参照 ScanStep 的既有做法，只做时间戳差值，不引入任何估算延时。
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (state.phase !== "analyzing") return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [state.phase]);
  const analysisElapsedSeconds = Math.max(
    0,
    Math.floor((now - (state.analysisStartedAt ?? now)) / 1000),
  );

  const analyze = async () => {
    const operation = ++operationRef.current;
    const selectedCandidates = state.selectedIds.map(
      (id) => state.candidates.find((candidate) => candidate.id === id),
    ).filter((candidate): candidate is CandidateSelectionProps["candidates"][number] => Boolean(candidate));
    // 总数在开始时即真实已知；逐项进度只在 facade 回调后派发，
    // 过期操作（已被取消或重开）的回调直接丢弃。
    dispatch({ startedAt: Date.now(), total: selectedCandidates.length, type: "analysis_started" });
    try {
      const plan = await facade.analyzeConflicts(selectedCandidates, (progress) => {
        if (operation === operationRef.current) dispatch({ progress, type: "analysis_progress" });
      });
      if (operation === operationRef.current) dispatch({ type: "analysis_succeeded", plan });
    } catch (error) {
      if (operation === operationRef.current) {
        dispatch({ type: "failed", error: describeNativeError(error, (key, options) => String(t(key as never, options as never)), "importWorkflow.errors.generic"), previousPhase: "candidates" });
      }
    }
  };

  const cancelAnalysis = async () => {
    // 先作废当前操作序号：在途分析的结果（成功/失败/进度）全部被守卫丢弃。
    operationRef.current += 1;
    await facade.cancel();
    notify({ tone: "info", title: t("importWorkflow.notifications.cancelledTitle") });
    dispatch({ type: "analysis_cancelled" });
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
    try {
      const results = await runTrackedOperation<ImportResult[]>({
        tracker,
        notifications,
        kind: "import",
        label: t("importWorkflow.tracker.label"),
        total,
        translate: (key, options) => String(t(key as never, options as never)),
        summarize: (settled) => ({
          succeeded: settled.filter((result) => result.status === "succeeded").length,
          failed: settled.filter((result) => result.status === "failed").length,
          skipped: settled.filter((result) => result.status === "skipped").length,
          todo: settled.filter((result) => result.status === "todo").length,
        }),
        successNotice: (_settled, summary) => ({
          tone: summary?.failed || summary?.todo ? "warning" : "success",
          title: summary?.todo
            ? t("importWorkflow.notifications.attentionTitle")
            : t("importWorkflow.notifications.succeededTitle"),
          detail: t("importWorkflow.notifications.succeededDetail", {
            failed: summary?.failed ?? 0,
            skipped: summary?.skipped ?? 0,
            succeeded: summary?.succeeded ?? 0,
            todo: summary?.todo ?? 0,
          }),
          action: { label: t("importWorkflow.notifications.openLibrary"), to: "/library" },
        }),
        errorNotice: (_error, message) => ({
          tone: "danger",
          title: t("importWorkflow.notifications.failedTitle"),
          detail: message,
        }),
        run: async (handle) => facade.commitImport(
          state.plan!,
          state.actions,
          (progress) => {
            handle.progress(progress.completed, progress.total);
            if (operation === operationRef.current) dispatch({ type: "commit_progress", progress });
          },
          state.governanceDecision,
        ),
      });
      if (operation === operationRef.current) {
        dispatch({ type: "commit_succeeded", results });
        onComplete?.(results);
      }
    } catch (error) {
      const commitError = describeNativeError(error, (key, options) => String(t(key as never, options as never)), "importWorkflow.errors.generic");
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
  const hasTodo = state.results.some((result) => result.status === "todo");
  const hasAttention = hasFailure || hasTodo;
  const hasGovernanceGroups = Boolean(state.plan?.governanceGroups?.length);
  const stepIndex = flowStepIndex(state.phase, state.previousPhase, hasGovernanceGroups);
  const flowSteps: ImportStep[] = (hasGovernanceGroups
    ? ["source", "candidates", "governance", "conflicts", "summary"]
    : ["source", "candidates", "conflicts", "summary"]
  ).map(
    (key, index) => ({
      label: String(t(`importWorkflow.phases.${key}` as never)),
      state: index < stepIndex ? "complete" : index === stepIndex ? "current" : "upcoming",
    }),
  );
  const statusText = String(t(`importWorkflow.phases.${state.phase}` as never));
  const status: ImportStatus =
    state.phase === "summary"
      ? {
          kind: hasAttention ? "warning" : "success",
          text: hasTodo ? String(t("importWorkflow.phases.attention")) : statusText,
        }
      : state.phase === "failed"
        ? { kind: "failure", text: statusText }
        : { kind: "info", text: statusText };

  const missingRequiredAction = (state.plan?.conflicts ?? []).some(
    (conflict) => conflict.required && !state.actions[conflict.candidateId],
  );
  const governanceConfirmed = state.plan
    ? hasExplicitGovernanceConfirmation(state.plan.governanceGroups ?? [], state.governanceDecision)
    : false;
  const canParse = state.phase === "source"
    && (state.sourceText.trim().length > 0 || selectedSources.length > 0);
  // onboarding 页脚禁用判定只信任真实条目状态（未扫描/解析中）。
  // 条目缺失不再视为"运行中"：那是来源被编辑、预览会话被作废后的状态，
  // 页脚必须回到可操作的空闲态，而不是永久停留在"正在解析…"。
  const onboardingPreviewRunning = variant === "onboarding"
    && normalizedInitialSources.some((source) => {
      const kind = statusBySource[source]?.kind;
      return kind === "unscanned" || kind === "scanning";
    });
  // OPT-20260914-01：逐项分析进度是否已真实到达（到达前只展示不确定进度）。
  const analysisLive = Boolean(
    state.analysisProgress && state.analysisProgress.total > 0,
  );

  let actions: { secondary: ReactNode[]; primary: ReactNode[] };
  switch (state.phase) {
    case "source":
      actions = {
        primary: [
          <Button disabled={!canParse || onboardingPreviewRunning} key="parse" onClick={() => void runAcquisition()} size="lg">
            {onboardingPreviewRunning
              ? t("importWorkflow.source.previewing")
              : selectedSources.length > 0
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
    case "analyzing":
      // OPT-20260914-01：分析阶段提供取消入口；提交阶段保持后台语义不设动作。
      actions = {
        primary: [],
        secondary: [
          <Button key="cancel-analysis" onClick={() => void cancelAnalysis()} variant="ghost">
            {t("importWorkflow.analysis.cancel")}
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
    case "governance":
      actions = {
        primary: [
          <Button disabled={!governanceConfirmed} key="confirm-governance" onClick={() => dispatch({ type: "governance_confirmed" })} size="lg">
            {t("importWorkflow.governance.confirmAction")}
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
      // committing：后台提交不提供流程动作（进度在全局任务状态可见）。
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
            // 编辑即作废预览会话：source_changed 清空结果条目，预览缓存与
            // 在途请求一并废弃，页脚回到空闲态由用户决定何时重新获取；
            // 迟到的预览完成被请求序号守卫丢弃，不会复活陈旧终结。
            discardPreviews();
            dispatch({ type: "source_changed", value: normalizeWindowsPath(value) });
          }}
          onClearSources={clearSources}
          onFocusedSourceApplied={() => setFocusedSource(undefined)}
          onPickLocalPath={() => void pickLocalDirectory()}
          onRemoveSource={removeSource}
          onRetrySource={(source) => void (state.phase === "candidate_gate" ? rescanSource(source) : previewSource(source))}
          onSelectAllSources={() => {
            const allSelected = normalizedInitialSources.every((source) => selectedSources.includes(source));
            if (allSelected) {
              for (const source of normalizedInitialSources) {
                if (selectedSources.includes(source)) removeSource(source);
              }
              return;
            }
            for (const source of normalizedInitialSources) {
              if (!selectedSources.includes(source)) {
                setSelectedSources((current) => [...new Set([...current, source])]);
                dispatch({ type: "source_added", inputValue: state.sourceText, source });
                void previewSource(source);
              }
            }
          }}
          onToggleSource={(source) => {
            const selected = selectedSources.includes(source);
            if (selected) {
              removeSource(source);
              return;
            }
            setSelectedSources((current) => [...new Set([...current, source])]);
            dispatch({ type: "source_added", inputValue: state.sourceText, source });
            void previewSource(source);
          }}
          selectedSources={selectedSources}
          sourceStatuses={statusBySource}
          suggestedSources={[...normalizedInitialSources, ...Object.keys(statusBySource)]}
          value={state.sourceText}
        />
      ) : null}

      {state.phase === "acquiring" ? (
        <DataState message={t("importWorkflow.source.acquiring")} state="loading" />
      ) : null}

      {state.phase === "candidates" ? (
        <CandidateSelection
          candidates={state.candidates}
          onSelectAll={() => dispatch({ type: "candidates_selected", ids: state.candidates.map(({ id }) => id) })}
          onToggle={(id) => dispatch({ type: "candidates_selected", ids: state.selectedIds.includes(id) ? state.selectedIds.filter((selectedId) => selectedId !== id) : [...state.selectedIds, id] })}
          selectedIds={state.selectedIds}
        />
      ) : null}

      {state.phase === "analyzing" ? (
        <section aria-label={t("importWorkflow.analysis.progressTitle")} className="sh-import-wizard__analysis">
          <div className="sh-import-wizard__analysis-meta">
            <span>{t("importWorkflow.phases.analyzing")}</span>
            <span>{t("importWorkflow.analysis.elapsed", { seconds: analysisElapsedSeconds })}</span>
          </div>
          <progress
            aria-label={t("importWorkflow.analysis.progressTitle")}
            max={analysisLive ? state.analysisProgress!.total : undefined}
            value={analysisLive ? state.analysisProgress!.completed : undefined}
          />
          <p>{t("importWorkflow.analysis.scope", { total: state.analysisTotal ?? 0 })}</p>
          {analysisLive ? (
            <p>
              {t("importWorkflow.analysis.count", {
                completed: state.analysisProgress!.completed,
                percent: Math.round((state.analysisProgress!.completed / state.analysisProgress!.total) * 100),
                total: state.analysisProgress!.total,
              })}
            </p>
          ) : (
            <p>{t("importWorkflow.analysis.progressUnavailable")}</p>
          )}
        </section>
      ) : null}

      {state.phase === "governance" && state.plan ? (
        <RelationshipGovernancePanel
          aiAvailable={aiAvailable === true}
          decision={state.governanceDecision}
          groups={state.plan.governanceGroups ?? []}
          onDecision={(decision) => dispatch({ type: "governance_decision", decision })}
        />
      ) : null}

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
            {facade.runAiPreChecks && aiAvailable ? (
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
              <p>
                {aiAvailable
                  ? t("importWorkflow.aiPreCheck.unavailable")
                  : t("importWorkflow.aiPreCheck.providerMissing")}
              </p>
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

      {state.phase === "summary" ? <ImportSummary onOpenGovernanceTask={onOpenGovernanceTask} results={state.results} /> : null}

      {state.phase === "cancelled" ? (
        <DataState message={t("importWorkflow.cancelled")} state="empty" />
      ) : null}

      {state.phase === "failed" ? (
        <DataState message={state.error ?? t("importWorkflow.errors.unknown")} state="error" />
      ) : null}
    </ImportShell>
  );
}
