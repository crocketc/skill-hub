import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { describeNativeError } from "../../../api/nativeErrors";
import type {
  RelationGovernanceBatchOutcome,
  RelationGovernanceRow,
} from "../../../api/bindings";
import {
  operationTracker,
  type OperationTracker,
} from "../../../platform/operationTracker";
import { runTrackedOperation } from "../../../platform/runTrackedOperation";
import { useOptionalAppNotifications } from "../../../ui/notifications";
import { Button } from "../../../ui/Button";
import { DataState } from "../../../ui/DataState";
import { RelationshipsLayout } from "../RelationshipsLayout";
import { useRelationshipsReturnState } from "../returnState";
import { relationshipsKeys } from "../api";
import {
  GOVERNANCE_BUCKETS,
  mergeBatchItemOutcome,
  parseGovernanceSearchParams,
  rowIsBatchExecutable,
  summarizeRowExecutability,
  SHARED_IMPACT_CONFIRMATION_TOKEN,
} from "./api";
import type { RelationGovernanceFacade } from "./api";
import { nativeGovernanceFacade } from "./nativeApi";
import { GovernanceRelationTable } from "./GovernanceRelationTable";
import { GovernanceImpactPreview } from "./GovernanceImpactPreview";
import { BatchResult, GovernanceBatchDialog } from "./GovernanceBatchDialog";
import "./governance.css";

export type { RelationGovernanceFacade } from "./api";

export interface RelationshipGovernancePageProps {
  /** 治理门面；缺省用原生实现，测试/预览注入替身。 */
  facade?: RelationGovernanceFacade;
  /** 统一执行桥的在途投影；测试注入独立实例，默认模块级单例。 */
  tracker?: OperationTracker;
}

interface SingleFlowState {
  kind: "centralize" | "undeploy";
  row: RelationGovernanceRow;
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
  tracker = operationTracker,
}: RelationshipGovernancePageProps) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const notifications = useOptionalAppNotifications();
  const [searchParams, setSearchParams] = useSearchParams();
  const deepLink = useMemo(
    () => parseGovernanceSearchParams(searchParams),
    [searchParams],
  );
  const returnState = useRelationshipsReturnState("governance");

  const ledgerQuery = useQuery({
    queryFn: () => facade.listGovernance({
      agent_client_id: deepLink.agentClientId ?? undefined,
      bucket: deepLink.bucket,
      skill_id: deepLink.skillId ?? undefined,
      text: deepLink.text || undefined,
    }),
    queryKey: relationshipsKeys.governance({
      agent_client_id: deepLink.agentClientId ?? undefined,
      bucket: deepLink.bucket,
      skill_id: deepLink.skillId ?? undefined,
      text: deepLink.text || undefined,
    }),
  });
  const rows = useMemo(() => ledgerQuery.data?.rows ?? [], [ledgerQuery.data]);
  const counts = ledgerQuery.data?.counts;

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
    if (saved && listRef.current) {
      listRef.current.scrollTop = saved;
    }
  }, [ledgerQuery.isSuccess, returnState.initialState]);

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

  const toggleAll = useCallback((checked: boolean) => {
    setSelectedIds(() => {
      if (!checked) return [];
      // 全选默认跳过受阻行；它们仍可被单独勾选（勾选后在预览里按受阻呈现）。
      return rows
        .filter((row) => row.readiness !== "blocked")
        .map((row) => row.relation.relation_id);
    });
  }, [rows]);

  // —— URL 即状态：筛选浏览一律 replace，不向历史推入条目 ——
  const applyParams = useCallback((patch: Record<string, string | null>) => {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === "") next.delete(key);
      else next.set(key, value);
    }
    setSearchParams(next, { replace: true });
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
      sharedImpactConfirmed: false,
    });
  }, []);

  // —— 批量流程 ——
  const selectedRows = useMemo(
    () => rows.filter((row) => selectedIds.includes(row.relation.relation_id)),
    [rows, selectedIds],
  );
  const executability = useMemo(
    () => summarizeRowExecutability(selectedRows),
    [selectedRows],
  );
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchFlow, setBatchFlow] = useState<BatchFlowState>(INITIAL_BATCH_FLOW);

  const openBatchDialog = useCallback(() => {
    setBatchFlow({
      ...INITIAL_BATCH_FLOW,
      // 受阻行在对话框里默认不选中（它们根本不可勾选执行）。
      checkedIds: selectedRows
        .filter(rowIsBatchExecutable)
        .map((row) => row.relation.relation_id),
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
    if (single) busy.add(single.row.relation.relation_id);
    if (batchOpen && batchFlow.running) {
      for (const id of batchFlow.checkedIds) busy.add(id);
    }
    return busy;
  }, [batchFlow.checkedIds, batchFlow.running, batchOpen, single]);

  const describeError = useCallback(
    (reason: unknown) => describeNativeError(
      reason,
      (key, options) => String(t(key as never, options as never)),
      "relationships.governance.loadError",
    ),
    [t],
  );

  const buildConfirmations = useCallback((relationIds: readonly string[], confirmed: ReadonlySet<string>) => {
    const confirmations: Record<string, string> = {};
    for (const relationId of relationIds) {
      if (confirmed.has(relationId)) {
        confirmations[relationId] = SHARED_IMPACT_CONFIRMATION_TOKEN;
      }
    }
    return confirmations;
  }, []);

  /** 一组关系的纳入集中库管理执行（单条 = 一个只有一项的批次）。 */
  const runCentralizeBatch = useCallback((
    relationIds: string[],
    confirmed: ReadonlySet<string>,
    onResult: (outcome: RelationGovernanceBatchOutcome) => void,
    onError: (message: string) => void,
    phaseLabel: string,
  ) => {
    void runTrackedOperation<RelationGovernanceBatchOutcome>({
      canCancel: false,
      errorNotice: () => null,
      invalidateQueryKeys: [[relationshipsKeys.root]],
      kind: "relation_governance_batch",
      label: t("relationships.governance.batch.trackerLabel"),
      notifications,
      queryClient,
      run: async (handle) => {
        handle.phase(phaseLabel);
        const prepared = await facade.prepareGovernanceBatch({
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
      skill: flow.row.skill_display_name ?? flow.row.relation.skill_id
        ?? t("relationshipGovernance.matrix.unknownSkill"),
    },
  ), [t]);

  const confirmSingleCentralize = useCallback((flow: SingleFlowState) => {
    const relationId = flow.row.relation.relation_id;
    setSingle((current) => current ? { ...current, busy: true, error: null } : current);
    runCentralizeBatch(
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
  }, [centralizeDoneText, runCentralizeBatch, t]);

  /** 单条结果的逐项重试：与批量重试共用同一合并语义。 */
  const retrySingleItem = useCallback((relationId: string) => {
    if (!single?.outcome) return;
    const confirmed = single.sharedImpactConfirmed ? new Set([relationId]) : new Set<string>();
    setSingle((current) => current ? { ...current, busy: true, error: null } : current);
    runCentralizeBatch(
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
  }, [centralizeDoneText, runCentralizeBatch, single, t]);

  /** 单条结果的逐项回退：回退必须针对发起批次（子任务挂在该批次下）。 */
  const rollbackSingleItem = useCallback((relationId: string) => {
    if (!single?.outcome) return;
    const batchId = single.outcome.batch_id;
    setSingle((current) => current ? { ...current, busy: true, error: null } : current);
    void runTrackedOperation<RelationGovernanceBatchOutcome>({
      canCancel: false,
      errorNotice: () => null,
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
    const relationId = flow.row.relation.relation_id;
    setSingle((current) => current ? { ...current, busy: true, error: null } : current);
    void runTrackedOperation({
      canCancel: false,
      errorNotice: () => null,
      invalidateQueryKeys: [[relationshipsKeys.root]],
      kind: "undeploy",
      label: t("relationships.governance.actions.undeploy"),
      notifications,
      queryClient,
      run: async (handle) => {
        const prepared = await facade.prepareRelationUndeploy(relationId);
        handle.correlate(prepared.operationId);
        return await facade.commitRelationUndeploy(prepared.operationId);
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
        resultText: t("relationships.governance.undeployResult.done", { path: flow.row.relation.path }),
      } : current);
    }).catch((reason: unknown) => {
      setSingle((current) => current
        ? { ...current, busy: false, error: describeError(reason) }
        : current);
    });
  }, [describeError, facade, notifications, queryClient, t, tracker]);

  const confirmBatch = useCallback(() => {
    const relationIds = [...batchFlow.checkedIds];
    setBatchFlow((current) => ({ ...current, running: true, error: null }));
    runCentralizeBatch(
      relationIds,
      new Set(batchFlow.sharedConfirmedIds),
      (outcome) => setBatchFlow((current) => ({ ...current, running: false, result: outcome })),
      (message) => setBatchFlow((current) => ({ ...current, running: false, error: message })),
      t("relationships.governance.batch.running"),
    );
  }, [batchFlow.checkedIds, batchFlow.sharedConfirmedIds, runCentralizeBatch, t]);

  const retryBatchItem = useCallback((relationId: string) => {
    setBatchFlow((current) => ({ ...current, running: true, error: null }));
    runCentralizeBatch(
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
  }, [batchFlow.sharedConfirmedIds, runCentralizeBatch, t]);

  const rollbackBatchItem = useCallback((relationId: string) => {
    if (!batchFlow.result) return;
    const batchId = batchFlow.result.batch_id;
    setBatchFlow((current) => ({ ...current, running: true, error: null }));
    void runTrackedOperation<RelationGovernanceBatchOutcome>({
      canCancel: false,
      errorNotice: () => null,
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
  useEffect(() => {
    if (!ledgerQuery.isSuccess || !pendingRelationIdRef.current) return;
    const relationId = pendingRelationIdRef.current;
    pendingRelationIdRef.current = null;
    const row = rows.find((candidate) => candidate.relation.relation_id === relationId);
    if (!row) return;
    if (rowIsBatchExecutable(row)) openSingle("centralize", row);
    else if (row.primary_action === "undeploy") openSingle("undeploy", row);
  }, [ledgerQuery.isSuccess, openSingle, rows]);

  const closeSingle = useCallback(() => setSingle(null), []);

  return (
    <RelationshipsLayout scope="governance">
      {deepLink.from ? (
        <div className="sh-governance__source-bar">
          <Button onClick={() => navigate(-1)} size="sm" variant="ghost">
            {t(`relationships.governance.back.${deepLink.from}` as never)}
          </Button>
        </div>
      ) : null}

      <section className="sh-governance__deploy-entry" data-testid="governance-deploy-entry">
        <p className="sh-governance__eyebrow">{t("relationships.governance.deployEntry.eyebrow")}</p>
        <h2>{t("relationships.governance.deployEntry.title")}</h2>
        <p>{t("relationships.governance.deployEntry.description")}</p>
        <Link className="sh-button sh-button--secondary sh-button--sm" to="/deploy">
          {t("relationships.governance.deployEntry.action")}
        </Link>
      </section>

      <p>{t("relationships.governance.description")}</p>

      <div aria-label={t("relationships.governance.filters.label")} className="sh-governance__filters" role="group">
        {GOVERNANCE_BUCKETS.map((bucket) => (
          <Button
            aria-pressed={deepLink.bucket === bucket}
            data-testid={`governance-bucket-${bucket}`}
            key={bucket}
            onClick={() => applyParams({ bucket })}
            size="sm"
            variant={deepLink.bucket === bucket ? "primary" : "secondary"}
          >
            {t("relationships.governance.filters.withCount", {
              count: counts ? counts[bucket] : 0,
              label: t(`relationships.governance.filters.${bucket}` as never),
            })}
          </Button>
        ))}
        <form
          className="sh-governance__search"
          onSubmit={(event) => {
            event.preventDefault();
            applyParams({ text: searchDraft });
          }}
        >
          <input
            aria-label={t("relationships.governance.search.label")}
            onChange={(event) => setSearchDraft(event.target.value)}
            placeholder={t("relationships.governance.search.label")}
            value={searchDraft}
          />
          <button type="submit">{t("relationships.governance.search.apply")}</button>
        </form>
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
        rows.length === 0 ? (
          <p role="status">
            {deepLink.bucket === "all"
              ? t("relationships.governance.empty.all")
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
                  disabled={executability.executable === 0}
                  onClick={openBatchDialog}
                  size="sm"
                >
                  {t("relationships.governance.selection.openBatch")}
                </Button>
              </div>
            ) : null}
            <GovernanceRelationTable
              busyRelationIds={busyRelationIds}
              listRef={listRef}
              onCentralize={(row) => openSingle("centralize", row)}
              onListScroll={onListScroll}
              onRevalidate={() => void ledgerQuery.refetch()}
              onToggleAll={toggleAll}
              onToggleRow={toggleRow}
              onUndeploy={(row) => openSingle("undeploy", row)}
              rows={rows}
              selectedIds={new Set(selectedIds)}
            />
          </>
        )
      ) : null}

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
          <GovernanceImpactPreview
            busy={single.busy}
            error={single.error}
            loadImpact={() => facade.getRelationshipRemovalImpact(single.row.relation.relation_id)}
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
    </RelationshipsLayout>
  );
}
