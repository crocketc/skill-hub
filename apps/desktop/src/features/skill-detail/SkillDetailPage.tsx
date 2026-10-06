import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { describeNativeError } from "../../api/nativeErrors";
import { useLocation, useNavigate, useParams } from "react-router-dom";
import { DataState } from "../../ui/DataState";
import type { MarkdownFacade } from "../markdown/api";
import { nativeMarkdownFacade } from "../markdown/nativeApi";
import { parseSkillLibrarySearchParams } from "../skills/queryState";
import { skillLibraryKeys } from "../skills/api";
import type { SkillDetailFacade } from "./api";
import {
  SkillDetailNotFoundError,
  SkillDetailUnavailableError,
  skillDetailKeys,
} from "./api";
import { detailSearchFromLibrary, readLibraryReturnState } from "./detailContext";
import type { SecurityFacade } from "../security/api";
import { useOptionalAppNotifications } from "../../ui/notifications";
import { operationTracker, type OperationTracker } from "../../platform/operationTracker";
import { runTrackedOperation } from "../../platform/runTrackedOperation";
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
import { SkillDetailReviewExperience } from "./SkillDetailReviewExperience";

interface SkillDetailPageProps {
  facade: SkillDetailFacade;
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
  const adjacentQuery = useQuery({
    enabled: isPreviewRoute || hasLibraryContext,
    queryFn: () => facade.getAdjacentContext(skillId, libraryQuery),
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

  const commitRemoval = async (choices: Record<string, RemovalChoice>) => {
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
          return effectiveRemovalFacade.commitDelete(operationId, choices);
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
        adjacent={adjacentQuery.data}
        backSearch={backSearch}
        detailPathname={detailPathname}
        facade={facade}
        insights={insightsQuery.data}
        markdownFacade={markdownFacade}
        metadata={metadataQuery.data}
        provenance={provenanceQuery.data}
        refreshSnapshot={refreshSnapshot}
        requirements={requirementsQuery.data}
        securityFacade={securityFacade}
        skillId={skillId}
        summary={summaryQuery.data}
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
    </>
  );
}
