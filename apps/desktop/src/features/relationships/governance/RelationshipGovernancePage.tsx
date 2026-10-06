import { governanceDestination } from "../../pending/workspace";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { describeNativeError } from "../../../api/nativeErrors";
import type {
  RelationGovernanceBatchAction,
  RelationGovernanceBatchOutcome,
  RelationGovernanceRow,
  RelationshipCheckItem,
  RelationshipCheckReport,
} from "../../../api/bindings";
import {
  operationTracker,
  type OperationTracker,
} from "../../../platform/operationTracker";
import { runTrackedOperation } from "../../../platform/runTrackedOperation";
import { useOptionalAppNotifications } from "../../../ui/notifications";
import { Button } from "../../../ui/Button";
import { Input } from "../../../ui/Input";
import { DataState } from "../../../ui/DataState";
import { RelationshipsLayout } from "../RelationshipsLayout";
import { useRelationshipsReturnState } from "../returnState";
import { relationshipsKeys } from "../api";
import { useRelationshipContextCheck } from "./useRelationshipContextCheck";
import {
  GOVERNANCE_CLASSIFICATIONS,
  actionConditionOf,
  isGovernanceActionAvailable,
  mergeBatchItemOutcome,
  parseGovernanceSearchParams,
  relationIdOf,
  relationPathOf,
  rowIsBatchExecutable,
  rowIsNaturallyExecutable,
  summarizeBatchSelection,
  summarizeRowExecutability,
  SHARED_IMPACT_CONFIRMATION_TOKEN,
} from "./api";
import type { RelationGovernanceFacade } from "./api";
import { nativeGovernanceFacade } from "./nativeApi";
import { GovernanceRelationTable } from "./GovernanceRelationTable";
import { governanceSkillDisplayName } from "./GovernanceRelationTable";
import { GovernanceBoard } from "./GovernanceBoard";
import { GovernanceImpactPreview } from "./GovernanceImpactPreview";
import { GovernanceDecisionPreview, type GovernanceDecisionAction } from "./GovernanceDecisionPreview";
import { BatchResult, GovernanceBatchDialog } from "./GovernanceBatchDialog";
import { governanceReasonLabelKey } from "./governancePresenter";
import { readGovernanceLibraryReturnTarget } from "./libraryReturnContext";
import "./governance.css";

export type { RelationGovernanceFacade } from "./api";

export interface RelationshipGovernancePageProps {
  /** 治理门面；缺省用原生实现，测试/预览注入替身。 */
  facade?: RelationGovernanceFacade;
  /** 统一执行桥的在途投影；测试注入独立实例，默认模块级单例。 */
  tracker?: OperationTracker;
  /** 仅 DEV 预览注入：显式标记夹具数据，不连接本机 Skill/Agent 目录。 */
  previewNotice?: string;
}

interface SingleFlowState {
  kind: "centralize" | "undeploy" | GovernanceDecisionAction;
  row: RelationGovernanceRow;
  relationshipRevision: string;
  busy: boolean;
  error: string | null;
  /** committed 终态的成功文案；其余终态为 null（改由逐项结果面板呈现）。 */
  resultText: string | null;
  /** 纳入集中库管理的批次结果：committed 以外也必须保留逐项事实。 */
  outcome: RelationGovernanceBatchOutcome | null;
  sharedImpactConfirmed: boolean;
}

interface BatchFlowState {
  checkedIds: string[];
  sharedConfirmedIds: string[];
  running: boolean;
  error: string | null;
  result: RelationGovernanceBatchOutcome | null;
}

const INITIAL_BATCH_FLOW: BatchFlowState = {
  checkedIds: [],
  sharedConfirmedIds: [],
  running: false,
  error: null,
  result: null,
};

/**
 * 关系治理工作台（任务 8）：以关系边为单位的清单、四桶筛选、单条与批量
 * 安全执行。浏览（筛选/搜索/选择）绝不写入 tracker、通知或操作记录；
 * 只有用户确认后的执行经 runTrackedOperation 走统一桥（父批次 + 逐项子任务）。
 * URL 承载可复现状态（from/bucket/text/skillId/agent/relationId），
 * 勾选与滚动位置走 return-state（按历史条目隔离），后退回到来源页保存的状态。
 */
export function RelationshipGovernancePage({
  facade = nativeGovernanceFacade,
  previewNotice,
  tracker = operationTracker,
}: RelationshipGovernancePageProps) {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const notifications = useOptionalAppNotifications();
  const [searchParams, setSearchParams] = useSearchParams();
  const deepLink = useMemo(
    () => parseGovernanceSearchParams(searchParams),
    [searchParams],
  );
  const libraryReturnTarget = useMemo(
    () => readGovernanceLibraryReturnTarget(location.state, deepLink.skillId ?? undefined),
    [deepLink.skillId, location.state],
  );
  const view = searchParams.get("view") === "table" ? "table" : "board";
  const boardScrollResetKey = JSON.stringify([
    deepLink.agentClientId,
    deepLink.batchId,
    deepLink.classification,
    deepLink.management,
    deepLink.relationId,
    deepLink.scope,
    deepLink.skillId,
    deepLink.text,
  ]);
  const returnState = useRelationshipsReturnState("governance");

  // 任务 11.5：逐行重校验的在途集合与最近一次逐项结论（按 relation 记忆）。
  const [revalidateBusy, setRevalidateBusy] = useState<ReadonlySet<string>>(new Set());
  const [revalidateResults, setRevalidateResults] = useState<ReadonlyMap<string, RelationshipCheckItem>>(
    new Map(),
  );

  const governanceFilters = {
    agent_client_id: deepLink.agentClientId ?? undefined,
    bucket: "all" as const,
    skill_id: deepLink.skillId ?? undefined,
    text: deepLink.text || undefined,
    batch_id: deepLink.batchId ?? undefined,
  } as const;
  const ledgerQuery = useQuery({
    queryFn: () => facade.listGovernance({ ...governanceFilters }),
    queryKey: relationshipsKeys.governance(governanceFilters),
  });
  const rows = useMemo(() => ledgerQuery.data?.rows ?? [], [ledgerQuery.data]);
  // scope=source_copy/deployment 与 management 深链保留为隐藏行过滤
  // （§10：参数解析兼容、映射到页签或细分桶，UI 不再提供 chips）。
  const scopedRows = useMemo(() => {
    let filtered = rows;
    if (deepLink.scope === "source_copy") {
      filtered = filtered.filter((row) => row.relation.kind === "source_copy");
    } else if (deepLink.scope === "deployment") {
      filtered = filtered.filter((row) => row.relation.kind === "deployment");
    }
    if (deepLink.management) {
      filtered = filtered.filter((row) => row.governance.management_status === deepLink.management);
    }
    return filtered;
  }, [deepLink.management, deepLink.scope, rows]);
  const visibleRows = useMemo(
    () => deepLink.classification === "all"
      ? scopedRows
      : scopedRows.filter((row) => row.governance.governance_status === deepLink.classification),
    [deepLink.classification, scopedRows],
  );
  const classificationCounts = useMemo(() => ({
    all: scopedRows.length,
    pending: scopedRows.filter((row) => row.governance.governance_status === "pending").length,
    completed: scopedRows.filter((row) => row.governance.governance_status === "completed").length,
  }), [scopedRows]);
  // D8（§10）：无隐藏过滤且清单仍有行时，待处理页签为空 = 已全部处理完；
  // 深链隐藏过滤（scope/management）造成的空仍按「该筛选下没有关系」呈现。
  const pendingDoneEmpty = deepLink.classification === "pending"
    && deepLink.scope === "all"
    && deepLink.management === null
    && scopedRows.length > 0;
  const allGoodEmpty = deepLink.classification === "all"
    || (deepLink.classification === "pending"
      && deepLink.scope === "all"
      && deepLink.management === null
      && scopedRows.length === 0);
  // 导入横幅的 N：本次批次映射的本地来源副本数（不受隐藏行过滤影响）。
  const sourceCopyCount = useMemo(
    () => rows.filter((row) => row.relation.kind === "source_copy").length,
    [rows],
  );
  // 任务 11.6：清单先渲染，再对当前 scope 做一次会话级 Light check。
  useRelationshipContextCheck({
    facade,
    scope: deepLink.scope,
    relationIds: visibleRows.map((row) => relationIdOf(row.relation)),
    enabled: ledgerQuery.isSuccess && visibleRows.length > 0,
  });

  // —— 会话视图状态：勾选 + 滚动（仅存 return-state，不进 URL/tracker）——
  const [selectedIds, setSelectedIds] = useState<string[]>(
    () => returnState.initialState?.selectedIds ?? [],
  );
  const listRef = useRef<HTMLDivElement | null>(null);
  const viewStateRef = useRef({
    scrollY: returnState.initialState?.scrollY ?? 0,
    selectedIds,
  });
  const restoredScrollRef = useRef(false);
  const persistFrameRef = useRef<number | null>(null);

  const persistViewState = useCallback(() => {
    returnState.saveState({
      scrollY: viewStateRef.current.scrollY,
      selectedIds: viewStateRef.current.selectedIds,
    });
  }, [returnState]);

  useEffect(() => {
    viewStateRef.current.selectedIds = selectedIds;
    persistViewState();
  }, [persistViewState, selectedIds]);

  // 滚动恢复：清单数据就绪后按保存位置复位一次（同一条目返回时）。
  useEffect(() => {
    if (restoredScrollRef.current || !ledgerQuery.isSuccess) return;
    restoredScrollRef.current = true;
    const saved = returnState.initialState?.scrollY;
    if (view === "table" && saved && listRef.current) {
      listRef.current.scrollTop = saved;
    }
  }, [ledgerQuery.isSuccess, returnState.initialState, view]);

  // Table view owns one scroll canvas; board columns keep their own scroll state.
  useEffect(() => {
    if (ledgerQuery.isSuccess && view === "table" && listRef.current) {
      listRef.current.scrollTop = viewStateRef.current.scrollY;
    }
  }, [ledgerQuery.isSuccess, view]);

  const onListScroll = useCallback(() => {
    const element = listRef.current;
    if (!element) return;
    viewStateRef.current.scrollY = element.scrollTop;
    if (persistFrameRef.current !== null) return;
    persistFrameRef.current = requestAnimationFrame(() => {
      persistFrameRef.current = null;
      persistViewState();
    });
  }, [persistViewState]);

  // 卸载（含路由离开）时收尾：取消未决帧并同步落盘最后一次滚动位置，
  // 避免刚滚动完就离开导致返回上下文丢失最后位置。
  useEffect(() => () => {
    if (persistFrameRef.current !== null) {
      cancelAnimationFrame(persistFrameRef.current);
      persistFrameRef.current = null;
    }
    persistViewState();
  }, [persistViewState]);

  const toggleRow = useCallback((relationId: string, checked: boolean) => {
    setSelectedIds((current) => checked
      ? [...current, relationId]
      : current.filter((id) => id !== relationId));
  }, []);

  // 整桶勾选（§10）：一类关系一桶，桶勾选只覆盖桶内可批量执行的行。
  const toggleBucketRows = useCallback((bucketRows: readonly RelationGovernanceRow[], checked: boolean) => {
    const ids = bucketRows.filter(rowIsNaturallyExecutable).map((row) => relationIdOf(row.relation));
    setSelectedIds((current) => checked
      ? [...new Set([...current, ...ids])]
      : current.filter((id) => !ids.includes(id)));
  }, []);

  const toggleAll = useCallback((checked: boolean) => {
    setSelectedIds(() => {
      if (!checked) return [];
      return visibleRows
        .filter(rowIsNaturallyExecutable)
        .map((row) => relationIdOf(row.relation));
    });
  }, [visibleRows]);

  // —— URL 即状态：已提交筛选写入历史条目（任务 11），前进/后退可恢复；
  // 勾选与滚动位置仍走 return-state，不进 URL。 ——
  const applyParams = useCallback((patch: Record<string, string | null>) => {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === "") next.delete(key);
      else next.set(key, value);
    }
    setSearchParams(next);
  }, [searchParams, setSearchParams]);

  const [searchDraft, setSearchDraft] = useState(deepLink.text);
  useEffect(() => setSearchDraft(deepLink.text), [deepLink.text]);

  // —— 单条流程 ——
  const [single, setSingle] = useState<SingleFlowState | null>(null);

  const openSingle = useCallback((kind: SingleFlowState["kind"], row: RelationGovernanceRow) => {
    setSingle({
      busy: false,
      error: null,
      kind,
      outcome: null,
      resultText: null,
      row,
      relationshipRevision: ledgerQuery.data?.relationship_revision ?? "",
      sharedImpactConfirmed: false,
    });
  }, [ledgerQuery.data?.relationship_revision]);

  // —— 批量流程 ——
  const selectedRows = useMemo(
    () => visibleRows.filter((row) => selectedIds.includes(relationIdOf(row.relation))),
    [selectedIds, visibleRows],
  );
  const executability = useMemo(
    () => summarizeRowExecutability(selectedRows),
    [selectedRows],
  );
  const batchSelection = useMemo(
    () => summarizeBatchSelection(selectedRows),
    [selectedRows],
  );
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchFlow, setBatchFlow] = useState<BatchFlowState>(INITIAL_BATCH_FLOW);

  const openBatchDialog = useCallback(() => {
    setBatchFlow({
      ...INITIAL_BATCH_FLOW,
      // 受阻行在对话框里默认不选中；可执行行按自身类别预选，
      // 混类批次在对话框里被拒绝收敛，取消单项后按剩余行重新收敛。
      checkedIds: selectedRows
        .filter(rowIsNaturallyExecutable)
        .map((row) => relationIdOf(row.relation)),
    });
    setBatchOpen(true);
  }, [selectedRows]);

  const closeBatchDialog = useCallback(() => {
    setBatchOpen(false);
    setBatchFlow(INITIAL_BATCH_FLOW);
  }, []);

  // 互斥锁定：单条预览中的行、批量执行覆盖的行都不再提供其他按钮；
  // 其余关系照常可操作。
  const busyRelationIds = useMemo(() => {
    const busy = new Set<string>();
    if (single) busy.add(relationIdOf(single.row.relation));
    if (batchOpen && batchFlow.running) {
      for (const id of batchFlow.checkedIds) busy.add(id);
    }
    for (const id of revalidateBusy) busy.add(id);
    return busy;
  }, [batchFlow.checkedIds, batchFlow.running, batchOpen, revalidateBusy, single]);

  const describeError = useCallback(
    (reason: unknown) => describeNativeError(
      reason,
      (key, options) => String(t(key as never, options as never)),
      // 动作失败的通用回退必须带出原始错误码；清单加载失败走模板里的
      // loadError 键直接渲染，不经这里。
      "tasks.notices.failureUnknown",
    ),
    [t],
  );

  // 任务 11.5：重校验是 RunRelationshipCheck 命令（facade.revalidate），完成后失效
  // 清单重新拉取；绝不把“再查一次清单”冒充校验。结论按 relation 记忆就地展示。
  const revalidateRows = useCallback((relationIds: readonly string[]) => {
    const ids = [...relationIds];
    if (ids.length === 0) return;
    setRevalidateBusy((current) => new Set([...current, ...ids]));
    void runTrackedOperation<RelationshipCheckReport>({
      targetHref: governanceDestination(ids),
      canCancel: false,
      describeError,
      invalidateQueryKeys: [[relationshipsKeys.root]],
      kind: "revalidate",
      label: t("relationships.governance.actions.revalidate"),
      notifications,
      queryClient,
      run: () => facade.revalidate(ids),
      summarize: () => ({ failed: 0, skipped: 0, succeeded: ids.length }),
      total: ids.length,
      tracker,
      translate: (key, options) => String(t(key as never, options as never)),
    }).then((report) => {
      setRevalidateResults((current) => {
        const next = new Map(current);
        for (const item of report.items) next.set(item.relation_id, item);
        return next;
      });
    }).catch(() => undefined).finally(() => {
      setRevalidateBusy((current) => new Set([...current].filter((id) => !ids.includes(id))));
    });
  }, [describeError, facade, notifications, queryClient, t, tracker]);

  const buildConfirmations = useCallback((relationIds: readonly string[], confirmed: ReadonlySet<string>) => {
    const confirmations: Record<string, string> = {};
    for (const relationId of relationIds) {
      if (confirmed.has(relationId)) {
        confirmations[relationId] = SHARED_IMPACT_CONFIRMATION_TOKEN;
      }
    }
    return confirmations;
  }, []);

  /** 一组关系的同动作批次执行（单条 = 一个只有一项的批次）；全部异步写操作
   *  都经这里走 runTrackedOperation 并与后端 operation id 关联（任务 11.14）。 */
  const runGovernanceBatch = useCallback((
    action: RelationGovernanceBatchAction,
    relationIds: string[],
    confirmed: ReadonlySet<string>,
    onResult: (outcome: RelationGovernanceBatchOutcome) => void,
    onError: (message: string) => void,
    phaseLabel: string,
  ) => {
    void runTrackedOperation<RelationGovernanceBatchOutcome>({
      targetHref: governanceDestination(relationIds),
      canCancel: false,
      describeError,
      invalidateQueryKeys: [[relationshipsKeys.root]],
      kind: "relation_governance_batch",
      label: t("relationships.governance.batch.trackerLabel"),
      notifications,
      queryClient,
      run: async (handle) => {
        handle.phase(phaseLabel);
        const prepared = await facade.prepareGovernanceBatch({
          action,
          confirmations: buildConfirmations(relationIds, confirmed),
          relationIds,
        });
        // 父批次对齐后端持久化 operation（batch_id），通知/记录三端同源。
        handle.correlate(prepared.batch_id);
        // 逐项子任务进入 tracker：子 migrate_relation 挂在父批次下，
        // 顶栏、通知与 /operations/:id 都能按 id 关联。
        const childIds = new Map<string, string>();
        for (const item of prepared.items) {
          if (item.state !== "prepared" || !item.operation_id) continue;
          const childId = tracker.begin({
            kind: "migrate_relation",
            label: t("relationships.governance.batch.itemTrackerLabel", { id: item.relation_id }),
            parentId: handle.trackedId,
            total: 1,
          });
          tracker.attach(childId, { operationId: item.operation_id });
          tracker.start(childId);
          childIds.set(item.relation_id, childId);
        }
        handle.progress(0, relationIds.length);
        const outcome = await facade.commitGovernanceBatch(prepared.batch_id, relationIds);
        let finished = 0;
        for (const item of outcome.items) {
          const childId = childIds.get(item.relation_id);
          if (childId) {
            if (item.state === "committed") {
              tracker.complete(childId, { failed: 0, skipped: 0, succeeded: 1 });
            } else if (item.state === "cancelled" || item.state === "rolled_back") {
              tracker.cancel(childId);
            } else if (item.state === "failed") {
              tracker.fail(childId, item.detail ?? item.error_code ?? item.relation_id);
            }
          }
          finished += 1;
          handle.progress(finished, relationIds.length);
        }
        return outcome;
      },
      successNotice: (outcome) => {
        // 通知标题必须与终态语义一致：partial 用部分成功文案，
        // 0 成功（含 backend Ok 返回的全失败批次）直接用 resultNone，不冒充成功。
        if (outcome.state === "committed") {
          return { title: t("relationships.governance.batch.trackerLabel"), tone: "success" as const };
        }
        if (outcome.committed_count > 0) {
          return {
            title: t("relationships.governance.batch.resultPartial", {
              committed: outcome.committed_count,
              failed: outcome.failed_count,
            }),
            tone: "warning" as const,
          };
        }
        return { title: t("relationships.governance.batch.resultNone"), tone: "danger" as const };
      },
      summarize: (outcome) => ({
        failed: outcome.failed_count,
        skipped: outcome.cancelled_count + outcome.blocked_count,
        succeeded: outcome.committed_count,
      }),
      total: relationIds.length,
      tracker,
      translate: (key, options) => String(t(key as never, options as never)),
    }).then(onResult).catch((reason: unknown) => {
      onError(describeError(reason));
    });
  }, [buildConfirmations, describeError, facade, notifications, queryClient, t, tracker]);

  /** 单条成功文案；committed 以外的终态一律走逐项结果面板，不冒充成功。 */
  const centralizeDoneText = useCallback((flow: SingleFlowState) => t(
    "relationships.governance.centralize.done",
    {
      skill: governanceSkillDisplayName(flow.row, t),
    },
  ), [t]);

  const confirmSingleCentralize = useCallback((flow: SingleFlowState) => {
    const relationId = relationIdOf(flow.row.relation);
    setSingle((current) => current ? { ...current, busy: true, error: null } : current);
    runGovernanceBatch(
      "centralize_management",
      [relationId],
      flow.sharedImpactConfirmed ? new Set([relationId]) : new Set(),
      (outcome) => {
        // 后端在单项失败/受阻时同样 Ok 返回批次结果：只有 committed 才是成功，
        // 其余终态交由逐项结果面板如实呈现（复用批量结果组件，不另造语义）。
        setSingle((current) => current ? {
          ...current,
          busy: false,
          outcome,
          resultText: outcome.state === "committed"
            ? centralizeDoneText(flow)
            : null,
        } : current);
      },
      (message) => {
        // 后端拒绝：预览保持打开，错误原样呈现，绝不更新为成功。
        setSingle((current) => current ? { ...current, busy: false, error: message } : current);
      },
      t("relationships.governance.batch.running"),
    );
  }, [centralizeDoneText, runGovernanceBatch, t]);

  /** 单条结果的逐项重试：与批量重试共用同一合并语义。 */
  const retrySingleItem = useCallback((relationId: string) => {
    if (!single?.outcome) return;
    const confirmed = single.sharedImpactConfirmed ? new Set([relationId]) : new Set<string>();
    setSingle((current) => current ? { ...current, busy: true, error: null } : current);
    runGovernanceBatch(
      "centralize_management",
      [relationId],
      confirmed,
      (outcome) => {
        setSingle((current) => {
          if (!current?.outcome) return current;
          const merged = mergeBatchItemOutcome(current.outcome, relationId, outcome);
          return {
            ...current,
            busy: false,
            outcome: merged,
            resultText: merged.state === "committed" && current.row
              ? centralizeDoneText(current)
              : null,
          };
        });
      },
      (message) => setSingle((current) => current
        ? { ...current, busy: false, error: message }
        : current),
      t("relationships.governance.batch.running"),
    );
  }, [centralizeDoneText, runGovernanceBatch, single, t]);

  // —— 来源副本动作（任务 11.7/11.9/11.14）——

  /** 保留来源副本：账本写入（决策改 retained + 历史），绝不触碰来源目录。 */
  const retainSourceCopyRow = useCallback((row: RelationGovernanceRow) => {
    const relationId = relationIdOf(row.relation);
    void runTrackedOperation({
      targetHref: governanceDestination([relationId]),
      canCancel: false,
      describeError,
      invalidateQueryKeys: [[relationshipsKeys.root]],
      kind: "retain_source_copy",
      label: t("relationships.governance.retain.action"),
      notifications,
      queryClient,
      run: () => facade.retainSourceCopy(relationId),
      successNotice: () => ({
        title: t("relationships.governance.retain.done"),
        tone: "success" as const,
      }),
      summarize: () => ({ failed: 0, skipped: 0, succeeded: 1 }),
      total: 1,
      tracker,
      translate: (key, options) => String(t(key as never, options as never)),
    }).catch(() => undefined);
  }, [describeError, facade, notifications, queryClient, t, tracker]);

  /** 单条结果的逐项回退：回退必须针对发起批次（子任务挂在该批次下）。 */
  const rollbackSingleItem = useCallback((relationId: string) => {
    if (!single?.outcome) return;
    const batchId = single.outcome.batch_id;
    setSingle((current) => current ? { ...current, busy: true, error: null } : current);
    void runTrackedOperation<RelationGovernanceBatchOutcome>({
      targetHref: governanceDestination([relationId]),
      canCancel: false,
      describeError,
      invalidateQueryKeys: [[relationshipsKeys.root]],
      kind: "relation_governance_batch",
      label: t("relationships.governance.batch.trackerLabel"),
      notifications,
      queryClient,
      run: async (handle) => {
        const outcome = await facade.rollbackGovernanceBatch(batchId, [relationId]);
        // 与批量回退一致：回退完成后对齐发起批次（时机裁定沿用复审登记项）。
        handle.correlate(batchId);
        return outcome;
      },
      successNotice: () => null,
      summarize: () => ({ failed: 0, skipped: 0, succeeded: 1 }),
      total: 1,
      tracker,
      translate: (key, options) => String(t(key as never, options as never)),
    }).then((outcome) => {
      setSingle((current) => {
        if (!current?.outcome) return current;
        return {
          ...current,
          busy: false,
          outcome: mergeBatchItemOutcome(current.outcome, relationId, outcome),
        };
      });
    }).catch((reason: unknown) => {
      setSingle((current) => current
        ? { ...current, busy: false, error: describeError(reason) }
        : current);
    });
  }, [describeError, facade, notifications, queryClient, single, t, tracker]);

  const confirmSingleUndeploy = useCallback((flow: SingleFlowState) => {
    setSingle((current) => current ? { ...current, busy: true, error: null } : current);
    void runTrackedOperation({
      targetHref: governanceDestination([relationIdOf(flow.row.relation)]),
      canCancel: false,
      describeError,
      invalidateQueryKeys: [[relationshipsKeys.root]],
      kind: "undeploy",
      label: t("relationships.governance.actions.undeploy"),
      notifications,
      queryClient,
      run: async (handle) => {
        const prepared = await facade.prepareRelationUndeploy(flow.row.relation);
        handle.correlate(prepared.operationId);
        // K2/G-07：预览对话框里的共享目标决定必须随提交透传，不得丢弃。
        return await facade.commitRelationUndeploy(prepared.operationId, {
          confirmSharedTargetRemoval: flow.sharedImpactConfirmed,
        });
      },
      successNotice: () => ({
        title: t("relationships.governance.actions.undeploy"),
        tone: "success" as const,
      }),
      summarize: () => ({ failed: 0, skipped: 0, succeeded: 1 }),
      total: 1,
      tracker,
      translate: (key, options) => String(t(key as never, options as never)),
    }).then(() => {
      setSingle((current) => current ? {
        ...current,
        busy: false,
        resultText: t("relationships.governance.undeployResult.done", { path: relationPathOf(flow.row.relation) }),
      } : current);
    }).catch((reason: unknown) => {
      setSingle((current) => current
        ? { ...current, busy: false, error: describeError(reason) }
        : current);
    });
  }, [describeError, facade, notifications, queryClient, t, tracker]);

  const confirmSingleDecision = useCallback((action: GovernanceDecisionAction, flow: SingleFlowState) => {
    const relationId = relationIdOf(flow.row.relation);
    setSingle((current) => current ? { ...current, busy: true, error: null } : current);

    void (async () => {
      try {
        const refreshed = await ledgerQuery.refetch();
        const currentRow = refreshed.data?.rows.find((row) => relationIdOf(row.relation) === relationId);
        if (refreshed.isError || !refreshed.data || !currentRow) {
          setSingle((current) => current ? {
            ...current,
            busy: false,
            error: t(currentRow ? "relationships.governance.mutation.refreshFailed" : "relationships.governance.mutation.relationshipUnavailable"),
            ...(currentRow ? { row: currentRow } : {}),
          } : current);
          return;
        }

        if (refreshed.data.relationship_revision !== flow.relationshipRevision) {
          setSingle((current) => current ? {
            ...current,
            busy: false,
            error: t("relationships.governance.mutation.changedReviewAgain"),
            relationshipRevision: refreshed.data.relationship_revision,
            row: currentRow,
          } : current);
          return;
        }

        const condition = actionConditionOf(currentRow, action);
        if (!condition?.available) {
          const reason = condition?.reasons.map((item) => String(t(governanceReasonLabelKey(item) as never))).join(" ");
          setSingle((current) => current ? {
            ...current,
            busy: false,
            error: reason || t("relationships.governance.mutation.actionUnavailable"),
            row: currentRow,
          } : current);
          return;
        }

        const operationId = createGovernanceOperationId();
        const actionLabel = String(t(`relationships.governance.actions.${action}` as never));
        void runTrackedOperation({
          targetHref: governanceDestination([relationId]),
          canCancel: false,
          describeError,
          invalidateQueryKeys: [[relationshipsKeys.root]],
          kind: "relationship_governance_mutation",
          label: actionLabel,
          mode: "instant",
          notifications,
          operationId,
          queryClient,
          run: () => facade[action === "revoke_retention" ? "revokeRetention" : "endRelationship"]({
            operationId,
            relationId,
            expectedRelationshipRevision: refreshed.data.relationship_revision,
          }),
          successNotice: () => ({
            title: t(`relationships.governance.mutation.${action}Done` as never),
            tone: "success" as const,
          }),
          summarize: () => ({ failed: 0, skipped: 0, succeeded: 1 }),
          total: 1,
          tracker,
          translate: (key, options) => String(t(key as never, options as never)),
        }).then((result) => {
          if (result.relation_id !== relationId) {
            setSingle((current) => current ? {
              ...current,
              busy: false,
              error: t("relationships.governance.mutation.unexpectedRelation"),
            } : current);
            return;
          }
          setSingle((current) => current ? {
            ...current,
            busy: false,
            resultText: String(t(`relationships.governance.mutation.${action}Done` as never)),
          } : current);
        }).catch((reason: unknown) => {
          setSingle((current) => current ? { ...current, busy: false, error: describeError(reason) } : current);
        });
      } catch (reason: unknown) {
        setSingle((current) => current ? { ...current, busy: false, error: describeError(reason) } : current);
      }
    })();
  }, [describeError, facade, ledgerQuery, notifications, queryClient, t, tracker]);

  const confirmBatch = useCallback(() => {
    const relationIds = [...batchFlow.checkedIds];
    const selection = summarizeBatchSelection(selectedRows);
    if (!selection.action) return;
    setBatchFlow((current) => ({ ...current, running: true, error: null }));
    const confirmed = new Set(batchFlow.sharedConfirmedIds);
    runGovernanceBatch(
      selection.action,
      relationIds,
      confirmed,
      (outcome) => setBatchFlow((current) => ({ ...current, running: false, result: outcome })),
      (message) => setBatchFlow((current) => ({ ...current, running: false, error: message })),
      t("relationships.governance.batch.running"),
    );
  }, [batchFlow.checkedIds, batchFlow.sharedConfirmedIds, runGovernanceBatch, selectedRows, t]);

  const retryBatchItem = useCallback((relationId: string) => {
    const selection = summarizeBatchSelection(selectedRows);
    if (!selection.action) return;
    setBatchFlow((current) => ({ ...current, running: true, error: null }));
    runGovernanceBatch(
      selection.action,
      [relationId],
      new Set(batchFlow.sharedConfirmedIds),
      (outcome) => {
        // 逐项重试后原位替换该项，计数与终态按合并后的事实重算。
        setBatchFlow((current) => {
          if (!current.result) return { ...current, running: false };
          return {
            ...current,
            running: false,
            result: mergeBatchItemOutcome(current.result, relationId, outcome),
          };
        });
      },
      (message) => setBatchFlow((current) => ({ ...current, running: false, error: message })),
      t("relationships.governance.batch.running"),
    );
  }, [batchFlow.sharedConfirmedIds, runGovernanceBatch, selectedRows, t]);

  const rollbackBatchItem = useCallback((relationId: string) => {
    if (!batchFlow.result) return;
    const batchId = batchFlow.result.batch_id;
    setBatchFlow((current) => ({ ...current, running: true, error: null }));
    void runTrackedOperation<RelationGovernanceBatchOutcome>({
      targetHref: governanceDestination([relationId]),
      canCancel: false,
      describeError,
      invalidateQueryKeys: [[relationshipsKeys.root]],
      kind: "relation_governance_batch",
      label: t("relationships.governance.batch.trackerLabel"),
      notifications,
      queryClient,
      run: async (handle) => {
        const outcome = await facade.rollbackGovernanceBatch(batchId, [relationId]);
        handle.correlate(batchId);
        return outcome;
      },
      successNotice: () => null,
      summarize: () => ({ failed: 0, skipped: 0, succeeded: 1 }),
      total: 1,
      tracker,
      translate: (key, options) => String(t(key as never, options as never)),
    }).then((outcome) => {
      setBatchFlow((current) => {
        if (!current.result) return { ...current, running: false };
        return {
          ...current,
          running: false,
          result: mergeBatchItemOutcome(current.result, relationId, outcome),
        };
      });
    }).catch((reason: unknown) => {
      setBatchFlow((current) => ({ ...current, running: false, error: describeError(reason) }));
    });
  }, [batchFlow.result, describeError, facade, notifications, queryClient, t, tracker]);

  // 深链 relationId：进入页面后按行的最恰当动作直接打开治理预览（仅一次）。
  const pendingRelationIdRef = useRef<string | null>(deepLink.relationId);
  useEffect(() => { pendingRelationIdRef.current = deepLink.relationId; }, [deepLink.relationId]);
  useEffect(() => {
    if (!ledgerQuery.isSuccess || !pendingRelationIdRef.current) return;
    const relationId = pendingRelationIdRef.current;
    pendingRelationIdRef.current = null;
    const row = visibleRows.find((candidate) => relationIdOf(candidate.relation) === relationId);
    if (!row) return;
    if (rowIsBatchExecutable(row)) openSingle("centralize", row);
    else if (isGovernanceActionAvailable(row, "undeploy")) openSingle("undeploy", row);
    else if (isGovernanceActionAvailable(row, "revoke_retention")) openSingle("revoke_retention", row);
    else if (isGovernanceActionAvailable(row, "end_relationship")) openSingle("end_relationship", row);
  }, [ledgerQuery.isSuccess, openSingle, visibleRows]);

  const closeSingle = useCallback(() => setSingle(null), []);

  return (
    <RelationshipsLayout scope="governance">
      {ledgerQuery.isSuccess && deepLink.relationId && !visibleRows.some((row) => relationIdOf(row.relation) === deepLink.relationId) ? <p role="status">{t("relationships.governance.deepLink.relationUnavailable")}</p> : null}
      {/* 工作台是 .sh-relationships 两行网格的唯一画布子元素：页签行 +
          画布行。治理页的块级内容一旦直接散落在网格里，画布行会被
          压缩，内容整体叠到后续兄弟元素上（2026-09-25 验收缺陷）。 */}
      <div className="sh-governance">
      {deepLink.from ? (
        <div className="sh-governance__source-bar">
          <Button
            onClick={() => {
              if (deepLink.from === "library") {
                navigate(libraryReturnTarget?.to ?? "/library", {
                  replace: true,
                  state: libraryReturnTarget?.state,
                });
                return;
              }
              navigate(-1);
            }}
            size="sm"
            variant="ghost"
          >
            {t(`relationships.governance.back.${deepLink.from}` as never)}
          </Button>
          {deepLink.from === "library" && !libraryReturnTarget ? (
            <p data-testid="governance-return-context-warning" role="note">
              {t("relationships.governance.deepLink.returnContextUnavailable")}
            </p>
          ) : null}
        </div>
      ) : null}

      <header className="sh-governance__head">
        {previewNotice ? (
          <p className="sh-governance__preview-notice" role="note">{previewNotice}</p>
        ) : null}
        <div className="sh-governance__head-row">
          <p className="sh-governance__intro">{t("relationships.governance.description")}</p>
          <Link
            className="sh-governance__history-link"
            data-testid="governance-history-link"
            to="/relationships/governance/history"
          >
            {t("relationships.governance.history.link")}
          </Link>
        </div>
        <p className="sh-governance__hint" data-testid="governance-deploy-entry">
          {t("relationships.governance.deployEntry.hint")}
          <Link className="sh-governance__hint-link" to="/deploy">
            {t("relationships.governance.deployEntry.action")}
          </Link>
        </p>
        {deepLink.from === "import" ? (
          <p className="sh-governance__import-banner" data-testid="governance-import-banner" role="status">
            {t("relationships.governance.importBatch.banner", { count: sourceCopyCount })}
          </p>
        ) : null}
      </header>

      <div aria-label={t("relationships.governance.filters.label")} className="sh-governance__filters" role="group">
        <div className="sh-governance__filters-primary">
          {/* FB-④（§10）：筛选条常驻内联，只保留页签、搜索与视图切换。 */}
          <div className="sh-governance__buckets" data-testid="governance-buckets" role="group">
            {GOVERNANCE_CLASSIFICATIONS.map((classification) => (
              <Button
                aria-pressed={deepLink.classification === classification}
                className="sh-governance__bucket-tab"
                data-testid={`governance-bucket-${classification}`}
                key={classification}
                onClick={() => applyParams({
                  governance: classification,
                  bucket: null,
                  status: null,
                })}
                size="sm"
                variant={deepLink.classification === classification ? "primary" : "secondary"}
              >
                {t("relationships.governance.filters.withCount", {
                  count: classificationCounts[classification],
                  label: t(`relationships.governance.classification.${classification}` as never),
                })}
              </Button>
            ))}
          </div>
        </div>
        <div className="sh-governance__filter-tools">
          <form
            className="sh-governance__search"
            onSubmit={(event) => {
              event.preventDefault();
              applyParams({ text: searchDraft });
            }}
          >
            <Input
              aria-label={t("relationships.governance.search.label")}
              className="sh-governance__search-input"
              onChange={(event) => setSearchDraft(event.target.value)}
              placeholder={t("relationships.governance.search.label")}
              type="search"
              value={searchDraft}
            />
            <Button size="sm" type="submit" variant="secondary">
              {t("relationships.governance.search.apply")}
            </Button>
          </form>
          <button
            aria-label={t(`relationships.governance.viewSwitch.switchTo${view === "board" ? "Table" : "Board"}` as never)}
            className="sh-governance__view-toggle"
            data-current-view={view}
            data-testid="governance-view-toggle"
            onClick={() => applyParams({ view: view === "board" ? "table" : null })}
            title={t(`relationships.governance.viewSwitch.switchTo${view === "board" ? "Table" : "Board"}` as never)}
            type="button"
          >
            <GovernanceViewIcon view={view} />
          </button>
        </div>
      </div>

      {ledgerQuery.isError ? (
        <div role="alert">
          <p>{t("relationships.governance.loadError")}</p>
          <Button onClick={() => void ledgerQuery.refetch()} size="sm" variant="secondary">
            {t("relationships.governance.retryLoad")}
          </Button>
        </div>
      ) : null}
      {ledgerQuery.isPending ? (
        <DataState message={t("relationships.governance.loading")} state="loading" />
      ) : null}

      {ledgerQuery.isSuccess ? (
        visibleRows.length === 0 ? (
          <p
            data-testid={pendingDoneEmpty ? "governance-empty-pending" : "governance-empty-state"}
            role="status"
          >
            {allGoodEmpty
              ? t("relationships.governance.empty.all")
              : pendingDoneEmpty
                ? t("relationships.governance.empty.pendingDone")
                : t("relationships.governance.empty.filtered")}
          </p>
        ) : (
          <>
            {selectedIds.length > 0 ? (
              <div className="sh-governance__toolbar" data-testid="governance-batch-summary">
                <span>
                  {t("relationships.governance.selection.selectedCount", { count: selectedIds.length })}
                </span>
                <span>
                  {t("relationships.governance.batchSummary.executable", { count: executability.executable })}
                </span>
                <span>
                  {t("relationships.governance.batchSummary.blocked", { count: executability.blocked })}
                </span>
                <Button
                  data-testid="governance-open-batch"
                  disabled={executability.executable === 0}
                  onClick={openBatchDialog}
                  size="sm"
                >
                  {t((batchSelection.kind === "source_copy"
                    ? "relationships.governance.selection.openBatchRetain"
                    : "relationships.governance.selection.openBatch") as never)}
                </Button>
              </div>
            ) : null}
            {view === "table" ? (
              <GovernanceRelationTable
                busyRelationIds={busyRelationIds}
                listRef={listRef}
                onCentralize={(row) => openSingle("centralize", row)}
                onEndRelationship={(row) => openSingle("end_relationship", row)}
                onRevokeRetention={(row) => openSingle("revoke_retention", row)}
                onListScroll={onListScroll}
                onRevalidate={(row) => revalidateRows([relationIdOf(row.relation)])}
                onRetain={(row) => retainSourceCopyRow(row)}
                onToggleAll={toggleAll}
                onToggleRow={toggleRow}
                onUndeploy={(row) => openSingle("undeploy", row)}
                rows={visibleRows}
                selectedIds={new Set(selectedIds)}
              />
            ) : (
              <GovernanceBoard
                busyRelationIds={busyRelationIds}
                classification={deepLink.classification}
                onCentralize={(row) => openSingle("centralize", row)}
                onEndRelationship={(row) => openSingle("end_relationship", row)}
                onRevokeRetention={(row) => openSingle("revoke_retention", row)}
                onRevalidate={(row) => revalidateRows([relationIdOf(row.relation)])}
                onRetain={(row) => retainSourceCopyRow(row)}
                onToggleAll={toggleAll}
                onToggleBucket={toggleBucketRows}
                onToggleRow={toggleRow}
                onUndeploy={(row) => openSingle("undeploy", row)}
                rows={visibleRows}
                scrollResetKey={boardScrollResetKey}
                selectedIds={new Set(selectedIds)}
              />
            )}
            {[...revalidateResults.entries()].map(([relationId, item]) => (
              <p
                data-testid={`governance-revalidate-result-${relationId}`}
                key={relationId}
                role="status"
              >
                {t(`relationships.governance.revalidate.${item.status}`, {
                  reason: item.reason ?? "",
                })}
              </p>
            ))}
          </>
        )
      ) : null}

      {/* 预览/结果面板：清单是 flex 画布里的弹性滚动区，面板打开时
          清单收缩让位，面板始终紧跟工具条可见，不必滚动寻找。 */}
      <div className="sh-governance__flows">
      {single ? (
        single.resultText ? (
          <div aria-label={t("relationships.governance.batch.resultTitle")} className="sh-governance__dialog" role="dialog">
            <h3>{t("relationships.governance.batch.resultTitle")}</h3>
            <p role="status">{single.resultText}</p>
            <div className="sh-governance__dialog-actions">
              <Button onClick={closeSingle} variant="secondary">
                {t("relationships.governance.batch.close")}
              </Button>
            </div>
          </div>
        ) : single.outcome ? (
          // committed 以外的终态：与批量共用同一套逐项结果组件，
          // 标题/失败明细/重试/回退语义完全一致，不冒充成功。
          <div aria-label={t("relationships.governance.batch.resultTitle")} className="sh-governance__dialog" role="dialog">
            <h3>{t("relationships.governance.batch.resultTitle")}</h3>
            {single.error ? (
              <div role="alert">
                <p>{t("relationships.governance.preview.rejectedNote")}</p>
                <p>{single.error}</p>
              </div>
            ) : null}
            <BatchResult
              onRetry={retrySingleItem}
              onRollback={rollbackSingleItem}
              result={single.outcome}
            />
            <div className="sh-governance__dialog-actions">
              <Button onClick={closeSingle} variant="secondary">
                {t("relationships.governance.batch.close")}
              </Button>
            </div>
          </div>
        ) : (
          single.kind === "revoke_retention" || single.kind === "end_relationship" ? (
            <GovernanceDecisionPreview
              action={single.kind}
              busy={single.busy}
              error={single.error}
              onCancel={closeSingle}
              onConfirm={() => {
                if (single.kind === "revoke_retention" || single.kind === "end_relationship") {
                  confirmSingleDecision(single.kind, single);
                }
              }}
              row={single.row}
            />
          ) : (
            <GovernanceImpactPreview
              busy={single.busy}
              error={single.error}
              loadImpact={() => facade.getRelationshipRemovalImpact(relationIdOf(single.row.relation))}
              mode={single.kind}
              onCancel={closeSingle}
              onConfirm={() => (single.kind === "centralize"
                ? confirmSingleCentralize(single)
                : confirmSingleUndeploy(single))}
              onSharedImpactConfirmChange={(checked) => setSingle((current) => current
                ? { ...current, sharedImpactConfirmed: checked }
                : current)}
              row={single.row}
              sharedImpactConfirmed={single.sharedImpactConfirmed}
            />
          )
        )
      ) : null}

      {batchOpen ? (
        <GovernanceBatchDialog
          checkedIds={new Set(batchFlow.checkedIds)}
          error={batchFlow.error}
          onClose={closeBatchDialog}
          onConfirm={confirmBatch}
          onRetry={retryBatchItem}
          onRollback={rollbackBatchItem}
          onSharedImpactConfirm={(relationId, checked) => setBatchFlow((current) => ({
            ...current,
            sharedConfirmedIds: checked
              ? [...current.sharedConfirmedIds, relationId]
              : current.sharedConfirmedIds.filter((id) => id !== relationId),
          }))}
          onToggleItem={(relationId, checked) => setBatchFlow((current) => ({
            ...current,
            checkedIds: checked
              ? [...current.checkedIds, relationId]
              : current.checkedIds.filter((id) => id !== relationId),
          }))}
          result={batchFlow.result}
          rows={selectedRows}
          running={batchFlow.running}
          sharedConfirmedIds={new Set(batchFlow.sharedConfirmedIds)}
        />
        ) : null}
      </div>
      </div>
    </RelationshipsLayout>
  );
}

function createGovernanceOperationId(): string {
  const randomId = globalThis.crypto?.randomUUID?.();
  return randomId ?? `relationship-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function GovernanceViewIcon({ view }: { view: "board" | "table" }) {
  return view === "board" ? (
    <svg aria-hidden="true" fill="none" viewBox="0 0 24 24">
      <rect height="7" rx="1" stroke="currentColor" strokeWidth="1.7" width="7" x="3" y="4" />
      <rect height="7" rx="1" stroke="currentColor" strokeWidth="1.7" width="7" x="14" y="4" />
      <rect height="7" rx="1" stroke="currentColor" strokeWidth="1.7" width="7" x="3" y="14" />
      <rect height="7" rx="1" stroke="currentColor" strokeWidth="1.7" width="7" x="14" y="14" />
    </svg>
  ) : (
    <svg aria-hidden="true" fill="none" viewBox="0 0 24 24">
      <rect height="17" rx="1.5" stroke="currentColor" strokeWidth="1.7" width="19" x="2.5" y="3.5" />
      <path d="M3 8h18M8 8v12M14 8v12M3 13h18M3 17h18" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}
