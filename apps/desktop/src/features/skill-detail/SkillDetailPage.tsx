import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { describeNativeError } from "../../api/nativeErrors";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { DataState } from "../../ui/DataState";
import type { MarkdownFacade } from "../markdown/api";
import { nativeMarkdownFacade } from "../markdown/nativeApi";
import { parseSkillLibrarySearchParams } from "../skills/queryState";
import { skillLibraryKeys } from "../skills/api";
import type { SkillLibraryFacade } from "../skills/api";
import type { SkillDetailFacade } from "./api";
import {
  deriveAdjacentSkills,
  SkillDetailNotFoundError,
  SkillDetailUnavailableError,
  skillDetailKeys,
} from "./api";
import { detailSearchFromLibrary, readLibraryReturnState } from "./detailContext";
import type { SecurityFacade } from "../security/api";
import { useOptionalAppNotifications } from "../../ui/notifications";
import { operationTracker, type OperationTracker } from "../../platform/operationTracker";
import { runTrackedOperation } from "../../platform/runTrackedOperation";
import type { DirectoryOpener } from "../../platform/directoryOpener";
import { RemovalImpactDialog } from "../removal/RemovalImpactDialog";
import {
  RemovalOutcomeResult,
  type RemovalOutcomeTargetLabel,
} from "../removal/RemovalOutcomeResult";
import type {
  RemovalFacade,
  RemovalImpact,
  RemovalChoice,
  RemovalResult,
} from "../removal/api";
import { nativeRemovalFacade, unavailableRemovalFacade } from "../removal/nativeApi";
import type { RelationGovernanceBatchOutcome } from "../../api/bindings";
import { relationshipsKeys } from "../relationships/api";
import type { RelationGovernanceFacade } from "../relationships/governance/api";
import { mergeBatchItemOutcome, relationIdOf, rowIsBatchExecutable } from "../relationships/governance/api";
import { buildGovernanceLibraryReturnTo } from "../relationships/governance/libraryReturnContext";
import { createGovernanceBatchRunner } from "../relationships/governance/governanceBatchOperation";
import { nativeGovernanceFacade } from "../relationships/governance/nativeApi";
import { GovernanceBatchDialog } from "../relationships/governance/GovernanceBatchDialog";
import { usageDestinationCards, type UsageDestinationsState } from "./usageDestinations";
import { SkillDetailReviewExperience } from "./SkillDetailReviewExperience";

interface SkillDetailPageProps {
  facade: SkillDetailFacade;
  /** W3-6：主体位置「打开位置」走受控 open_local_directory；测试注入替身。 */
  directoryOpener?: DirectoryOpener;
  /** W3-3（§7.8 生产承载）：头部「转为集中管理」接真实治理批次契约。 */
  governanceFacade?: RelationGovernanceFacade;
  /** W1-5（FB-①/D7-A）：相邻技能由库列表（同筛选/排序）前端推导所需的只读能力。 */
  libraryFacade?: Pick<SkillLibraryFacade, "listSkills">;
  markdownFacade?: MarkdownFacade;
  removalFacade?: RemovalFacade;
  securityFacade: SecurityFacade;
  refreshSnapshot?: () => Promise<void>;
  tracker?: OperationTracker;
}

/**
 * 技能详情页（§9 裁决，2026-10-06）：评审原型即生产默认呈现，旧分区布局已
 * 移除。真实删除流（K2/G-07 两段式 + W3-1 待办「不信任（删除）」直达）保留
 * 在本页，通过 removalRequest 状态自动触发既有删除影响确认。
 */
export function SkillDetailPage({
  facade,
  directoryOpener,
  governanceFacade,
  libraryFacade,
  markdownFacade = nativeMarkdownFacade,
  removalFacade,
  securityFacade,
  refreshSnapshot,
  tracker = operationTracker,
}: SkillDetailPageProps) {
  const { t } = useTranslation();
  const location = useLocation();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const notifications = useOptionalAppNotifications();
  const { skillId = "" } = useParams();
  const isPreviewRoute = location.pathname.startsWith("/__preview/");
  const effectiveRemovalFacade = removalFacade ?? (isPreviewRoute ? unavailableRemovalFacade : nativeRemovalFacade);
  // §7.8 生产承载：预览路由不接真实治理门面；生产默认原生门面。
  const effectiveGovernanceFacade = governanceFacade ?? (isPreviewRoute ? undefined : nativeGovernanceFacade);
  const backPathname = isPreviewRoute ? "/__preview/skill-library" : "/library";
  const detailPathname = isPreviewRoute ? "/__preview/skill-detail" : "/library";
  const libraryReturn = readLibraryReturnState(location.state);
  const backSearch = detailSearchFromLibrary(location.search);
  const libraryQuery = parseSkillLibrarySearchParams(backSearch).query;
  const hasLibraryContext = Boolean(location.search || libraryReturn);
  const summaryQuery = useQuery({
    queryFn: () => facade.getSummary(skillId),
    queryKey: skillDetailKeys.summary(skillId),
    retry: false,
  });
  // W1-5（FB-①/D7-A）：相邻技能由库列表（同筛选/排序）前端推导；无库上下文
  // 或未接库门面时隐藏控件，不伪造相邻。找不到当前 Skill 时返回 null 同样隐藏。
  const adjacentQuery = useQuery({
    enabled: (isPreviewRoute || hasLibraryContext) && libraryFacade !== undefined,
    queryFn: async () => {
      if (!libraryFacade) return null;
      return deriveAdjacentSkills(libraryFacade.listSkills, skillId, libraryQuery);
    },
    queryKey: skillDetailKeys.adjacent(skillId, libraryQuery),
  });
  const metadataQuery = useQuery({
    queryFn: () => facade.getMetadata(skillId),
    queryKey: skillDetailKeys.metadata(skillId),
  });
  const provenanceQuery = useQuery({
    queryFn: () => facade.getProvenance(skillId),
    queryKey: skillDetailKeys.provenance(skillId),
  });
  const requirementsQuery = useQuery({
    queryFn: () => facade.getRequirements(skillId),
    queryKey: skillDetailKeys.requirements(skillId),
  });
  const insightsQuery = useQuery({
    queryFn: () => facade.getInsights(skillId),
    queryKey: skillDetailKeys.insights(skillId),
  });
  // W3-3（§7.8 生产承载）：待接管使用关系来自真实治理清单（按 Skill 过滤），
  // 候选行以后端 action_conditions 为唯一准入依据（可执行，或只差共享影响确认）。
  const takeoverLedgerQuery = useQuery({
    enabled: effectiveGovernanceFacade !== undefined,
    queryFn: async () => {
      if (!effectiveGovernanceFacade) throw new Error("governance.facade_unavailable");
      return effectiveGovernanceFacade.listGovernance({ skill_id: skillId });
    },
    queryKey: relationshipsKeys.governance({ skill_id: skillId }),
    retry: false,
  });
  const takeoverCandidates = useMemo(
    () => (takeoverLedgerQuery.data?.rows ?? []).filter(rowIsBatchExecutable),
    [takeoverLedgerQuery.data],
  );
  // W3-5：使用去向卡与待接管候选共用同一份治理清单（单一事实来源），
  // 卡片状态、路径与关系身份都来自清单行，不在前端自备样例或翻转状态。
  const usageDestinations: UsageDestinationsState | undefined = useMemo(() => {
    if (effectiveGovernanceFacade === undefined) return undefined;
    if (takeoverLedgerQuery.isError) return { state: "unavailable" };
    if (!takeoverLedgerQuery.isSuccess) return { state: "loading" };
    return { state: "ready", cards: usageDestinationCards(takeoverLedgerQuery.data?.rows ?? []) };
  }, [effectiveGovernanceFacade, takeoverLedgerQuery.isError, takeoverLedgerQuery.isSuccess, takeoverLedgerQuery.data]);
  // W3-3b（§7.8）：卡片治理入口携 Skill+关系身份深链治理页，并带受控返回
  // 上下文（returnTo 只接受本 Skill 详情；接管等动作仍在治理页执行）。
  const openGovernanceDestination = useCallback((relationId: string) => {
    navigate(`/relationships/governance?${new URLSearchParams({
      from: "library",
      skillId,
      relationId,
    })}`, {
      state: {
        returnTo: buildGovernanceLibraryReturnTo(skillId, backSearch) ?? `/library/${encodeURIComponent(skillId)}`,
        ...(libraryReturn ? { libraryReturn } : {}),
      },
    });
  }, [backSearch, libraryReturn, navigate, skillId]);
  // §7.8：详情面板承载与治理页同一套批次流程——面板状态只管选择与呈现，
  // 执行走共享的批次编排（prepare → commit，逐项结果 + 重试/回退）。
  const [takeoverOpen, setTakeoverOpen] = useState(false);
  const [takeoverCheckedIds, setTakeoverCheckedIds] = useState<ReadonlySet<string>>(new Set());
  const [takeoverSharedConfirmedIds, setTakeoverSharedConfirmedIds] = useState<ReadonlySet<string>>(new Set());
  const [takeoverRunning, setTakeoverRunning] = useState(false);
  const [takeoverResult, setTakeoverResult] = useState<RelationGovernanceBatchOutcome | null>(null);
  const [takeoverError, setTakeoverError] = useState<string | null>(null);
  const describeTakeoverError = useCallback(
    (reason: unknown) => describeNativeError(
      reason,
      (key, options) => String(t(key as never, options as never)),
      "tasks.notices.failureUnknown",
    ),
    [t],
  );
  const translateTakeover = useCallback(
    (key: string, options?: Record<string, unknown>) => String(t(key as never, options as never)),
    [t],
  );

  const openTakeover = () => {
    setTakeoverCheckedIds(new Set(takeoverCandidates.map((row) => relationIdOf(row.relation))));
    setTakeoverSharedConfirmedIds(new Set());
    setTakeoverResult(null);
    setTakeoverError(null);
    setTakeoverOpen(true);
  };
  const closeTakeover = () => {
    setTakeoverOpen(false);
    setTakeoverCheckedIds(new Set());
    setTakeoverSharedConfirmedIds(new Set());
    setTakeoverResult(null);
    setTakeoverError(null);
  };

  const runTakeoverBatch = useMemo(() => {
    if (!effectiveGovernanceFacade) return null;
    return createGovernanceBatchRunner({
      describeError: describeTakeoverError,
      facade: effectiveGovernanceFacade,
      notifications,
      queryClient,
      tracker,
      translate: translateTakeover,
    });
  }, [describeTakeoverError, effectiveGovernanceFacade, notifications, queryClient, tracker, translateTakeover]);

  const confirmTakeover = () => {
    const relationIds = [...takeoverCheckedIds];
    if (!runTakeoverBatch || relationIds.length === 0) return;
    setTakeoverRunning(true);
    setTakeoverError(null);
    runTakeoverBatch(
      "centralize_management",
      relationIds,
      takeoverSharedConfirmedIds,
      (outcome) => {
        setTakeoverRunning(false);
        setTakeoverResult(outcome);
      },
      (message) => {
        setTakeoverRunning(false);
        setTakeoverError(message);
      },
      t("relationships.governance.batch.running"),
    );
  };

  const retryTakeoverItem = (relationId: string) => {
    if (!runTakeoverBatch) return;
    setTakeoverRunning(true);
    setTakeoverError(null);
    runTakeoverBatch(
      "centralize_management",
      [relationId],
      takeoverSharedConfirmedIds,
      (outcome) => {
        setTakeoverRunning(false);
        // 逐项重试后原位替换该项，计数与终态按合并后的事实重算。
        setTakeoverResult((current) => current
          ? mergeBatchItemOutcome(current, relationId, outcome)
          : current);
      },
      (message) => {
        setTakeoverRunning(false);
        setTakeoverError(message);
      },
      t("relationships.governance.batch.running"),
    );
  };

  const rollbackTakeoverItem = (relationId: string) => {
    if (!effectiveGovernanceFacade || !takeoverResult) return;
    const batchId = takeoverResult.batch_id;
    setTakeoverRunning(true);
    setTakeoverError(null);
    void runTrackedOperation<RelationGovernanceBatchOutcome>({
      canCancel: false,
      describeError: describeTakeoverError,
      invalidateQueryKeys: [[relationshipsKeys.root]],
      kind: "relation_governance_batch",
      label: t("relationships.governance.batch.trackerLabel"),
      notifications,
      queryClient,
      run: async (handle) => {
        const outcome = await effectiveGovernanceFacade.rollbackGovernanceBatch(batchId, [relationId]);
        handle.correlate(batchId);
        return outcome;
      },
      successNotice: () => null,
      summarize: () => ({ failed: 0, skipped: 0, succeeded: 1 }),
      total: 1,
      tracker,
      translate: translateTakeover,
    }).then((outcome) => {
      setTakeoverRunning(false);
      setTakeoverResult((current) => current
        ? mergeBatchItemOutcome(current, relationId, outcome)
        : current);
    }).catch((reason: unknown) => {
      setTakeoverRunning(false);
      setTakeoverError(describeTakeoverError(reason));
    });
  };
  const [removalImpact, setRemovalImpact] = useState<RemovalImpact | null>(null);
  const [removalLoading, setRemovalLoading] = useState(false);
  const [removalSubmitting, setRemovalSubmitting] = useState(false);
  const [removalError, setRemovalError] = useState<string>();
  // K2/G-07：中央删除失败（目标已回收、中央 Skill 未删除）时的逐项结果面板数据；
  // targetLabels 用 prepare 返回的目标显示名，绝不裸露 deployment_id。
  const [removalOutcome, setRemovalOutcome] = useState<{
    result: RemovalResult;
    targetLabels: Record<string, RemovalOutcomeTargetLabel>;
  } | null>(null);

  const startRemoval = async () => {
    setRemovalLoading(true);
    setRemovalError(undefined);
    setRemovalOutcome(null);
    try {
      setRemovalImpact(await effectiveRemovalFacade.prepareDelete(skillId, summaryQuery.data?.name));
    } catch (reason) {
      setRemovalError(describeNativeError(reason, (key, options) => String(t(key as never, options as never)), "removal.loadError"));
    } finally {
      setRemovalLoading(false);
    }
  };

  const commitRemoval = async (choices: Record<string, RemovalChoice>, confirmedSharedTargets: ReadonlySet<string>) => {
    const operationId = removalImpact?.operationId;
    if (!operationId) {
      // K2 预览失效边界：prepared 丢失时拒绝提交并要求重新预览，
      // 绝不静默 no-op 让确认动作看起来成功而什么都不发生。
      setRemovalError(t("removal.errors.previewInvalidated"));
      return;
    }
    setRemovalSubmitting(true);
    setRemovalError(undefined);
    try {
      const result = await runTrackedOperation<RemovalResult>({
        tracker,
        notifications,
        kind: "remove",
        label: t("removal.tracker.batchLabel"),
        operationId,
        translate: (key, options) => String(t(key as never, options as never)),
        queryClient,
        invalidateQueryKeys: [skillLibraryKeys.root],
        // K2/G-07：中央删除失败不是成功——tracker 如实记失败，不冒充完成。
        summarize: (settled) => ({
          succeeded: settled.centralSkillDeleted ? 1 : 0,
          failed: settled.centralSkillDeleted ? 0 : 1,
          skipped: 0,
        }),
        run: async (handle) => {
          handle.correlate(operationId);
          // K2/G-09：共享物理目标的逐项显式确认集合随提交转发。
          return effectiveRemovalFacade.commitDelete(operationId, choices, confirmedSharedTargets);
        },
      });
      if (!result.centralSkillDeleted) {
        // 故障矩阵：delete_skill 失败——目标已回收但中央 Skill 未删除。渲染
        // 逐项结果面板（含恢复入口）而不是抛原始错误；不导航回列表冒充完成。
        setRemovalImpact(null);
        setRemovalOutcome({
          result,
          targetLabels: Object.fromEntries(
            (removalImpact?.deployments ?? []).map((deployment) => [
              deployment.id,
              { label: deployment.label, path: deployment.path },
            ]),
          ),
        });
        return;
      }
      navigate({ pathname: backPathname, search: backSearch }, { replace: true, state: libraryReturn ? { libraryReturn } : undefined });
    } catch (reason) {
      setRemovalError(describeNativeError(reason, (key, options) => String(t(key as never, options as never)), "removal.commitError"));
    } finally {
      setRemovalSubmitting(false);
    }
  };

  // W3-1（FB-003 裁决第 1 节）：待办「不信任（删除）」经 removalRequest 状态
  // 直达既有删除影响确认——复用 startRemoval 同一条流程，不造第二套删除；
  // 每次挂载至多自动触发一次，且只响应当前 Skill 的请求。
  const removalRequestHandledRef = useRef(false);
  const removalRequest = (location.state as { removalRequest?: { skillId?: string } } | null)?.removalRequest;
  const summaryReady = !summaryQuery.isPending && !summaryQuery.isError && Boolean(summaryQuery.data);
  useEffect(() => {
    if (removalRequestHandledRef.current) return;
    if (isPreviewRoute || !summaryReady) return;
    if (!removalRequest || removalRequest.skillId !== skillId) return;
    removalRequestHandledRef.current = true;
    void startRemoval();
    // startRemoval 只依赖 skillId 与 summary 名称；挂载期一次性触发。
  }, [isPreviewRoute, removalRequest, skillId, summaryReady]);

  // 评审详情分区锚点（review-*）深链落位：SPA 客户端导航不触发浏览器原生
  // 锚点滚动，快速抽屉「查看更新」等入口依赖这里把目标分区滚入视口。
  const sectionHash = /^#review-[a-z-]+$/.exec(location.hash)?.[0].slice(1);
  useEffect(() => {
    if (!sectionHash || !summaryReady) return;
    // 分区内容随查询数据异步渲染：有界重试直到分区出现或放弃（约 0.5s），
    // 不做无限轮询，也不给不存在的锚点保留滚动位置。
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = (remaining: number) => {
      if (cancelled) return;
      const target = document.getElementById(sectionHash);
      if (target) {
        target.scrollIntoView({ block: "start" });
        return;
      }
      if (remaining > 0) {
        timer = setTimeout(() => attempt(remaining - 1), 50);
      }
    };
    attempt(10);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [sectionHash, summaryReady]);

  if (summaryQuery.isPending) {
    return <DataState state="loading" message={t("skillDetail.states.loading")} />;
  }
  if (summaryQuery.isError || !summaryQuery.data) {
    if (summaryQuery.error instanceof SkillDetailUnavailableError) {
      return <DataState state="unavailable" message={t("skillDetail.states.unavailable")} />;
    }
    if (summaryQuery.error instanceof SkillDetailNotFoundError) {
      return <DataState state="empty" message={t("skillDetail.states.notFound")} />;
    }
    return (
      <DataState
        actionLabel={t("actions.retry")}
        message={t("skillDetail.states.error")}
        onAction={() => void summaryQuery.refetch()}
        state="error"
      />
    );
  }

  // 返回技能库时携带 skill 参数：技能库据其重新打开该技能的抽屉，
  // 保持「库 ↔ 详情」往返上下文（detailContext 契约）。
  const reviewReturnParams = new URLSearchParams(backSearch);
  reviewReturnParams.delete("detailPrototype");
  reviewReturnParams.set("skill", skillId);

  return (
    <>
      <SkillDetailReviewExperience
        adjacent={adjacentQuery.data ?? undefined}
        backSearch={backSearch}
        detailPathname={detailPathname}
        directoryOpener={directoryOpener}
        facade={facade}
        insights={insightsQuery.data}
        markdownFacade={markdownFacade}
        metadata={metadataQuery.data}
        // §7.8：入口只在存在真实待接管关系时出现（隐藏而非禁用）。
        onCentralize={takeoverCandidates.length > 0 ? openTakeover : undefined}
        onDelete={() => void startRemoval()}
        onOpenGovernanceDestination={openGovernanceDestination}
        provenance={provenanceQuery.data}
        refreshSnapshot={refreshSnapshot}
        requirements={requirementsQuery.data}
        securityFacade={securityFacade}
        skillId={skillId}
        summary={summaryQuery.data}
        usageDestinations={usageDestinations}
        libraryReturn={libraryReturn}
        returnToLibrary={`${backPathname}?${reviewReturnParams.toString()}`}
      />
      {removalLoading ? <p role="status">{t("removal.loading")}</p> : null}
      {removalImpact ? (
        <RemovalImpactDialog
          error={removalError}
          impact={removalImpact}
          onCancel={() => setRemovalImpact(null)}
          onConfirm={commitRemoval}
          submitting={removalSubmitting}
        />
      ) : removalError && !removalLoading ? <p role="alert">{removalError}</p> : null}
      {removalOutcome ? (
        <RemovalOutcomeResult
          continuing={removalLoading}
          onContinue={() => {
            setRemovalOutcome(null);
            void startRemoval();
          }}
          result={removalOutcome.result}
          targetLabels={removalOutcome.targetLabels}
        />
      ) : null}
      {takeoverOpen && effectiveGovernanceFacade ? (
        <GovernanceBatchDialog
          checkedIds={takeoverCheckedIds}
          error={takeoverError}
          onClose={closeTakeover}
          onConfirm={confirmTakeover}
          onRetry={retryTakeoverItem}
          onRollback={rollbackTakeoverItem}
          onSharedImpactConfirm={(relationId, checked) => setTakeoverSharedConfirmedIds((current) => {
            const next = new Set(current);
            if (checked) next.add(relationId);
            else next.delete(relationId);
            return next;
          })}
          onToggleItem={(relationId, checked) => setTakeoverCheckedIds((current) => {
            const next = new Set(current);
            if (checked) next.add(relationId);
            else next.delete(relationId);
            return next;
          })}
          result={takeoverResult}
          rows={takeoverCandidates}
          running={takeoverRunning}
          sharedConfirmedIds={takeoverSharedConfirmedIds}
        />
      ) : null}
    </>
  );
}
