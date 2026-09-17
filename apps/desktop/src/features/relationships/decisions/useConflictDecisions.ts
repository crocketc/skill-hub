import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { describeNativeError } from "../../../api/nativeErrors";
import type {
  ConflictCaseFact,
  ConflictDecision,
  ConflictResolutionOutcome,
} from "../../../api/bindings";
import {
  operationTracker,
  type OperationTracker,
} from "../../../platform/operationTracker";
import { runTrackedOperation } from "../../../platform/runTrackedOperation";
import type { AppNotifications } from "../../../ui/notifications";
import { relationshipsKeys } from "../api";
import type { ConflictDecisionsFacade } from "./decisionsApi";

/**
 * 冲突处理工作台的页面级 hooks（任务 7）：
 * - 工作台查询：键携带 relationship_revision（0016 迁移后修订变化必须换键）；
 * - AI 可用性：复用真实 LLM 供应商判定，绝不伪造可用；
 * - AI 分析：经统一执行桥（phased），完成后失效工作台让结论回流 latest_analysis；
 * - 决定写入：经统一执行桥（instant，即时命令不闪顶栏），成功后失效整个
 *   relationships 命名空间（结论写入会推进 relationship_revision）。
 */

export function useConflictWorkspace(facade: ConflictDecisionsFacade) {
  const queryClient = useQueryClient();
  const [knownRevision, setKnownRevision] = useState<string>();
  const query = useQuery({
    queryKey: relationshipsKeys.conflicts(
      knownRevision ? { relationshipRevision: knownRevision } : {},
    ),
    queryFn: () => facade.getConflictWorkspace(),
    // 投影查询诚实呈现失败：不静默重试掩盖。
    retry: false,
    staleTime: 30_000,
  });

  const revision = query.data?.relationship_revision;
  useEffect(() => {
    if (!revision || revision === knownRevision) return;
    // 修订号进键：把刚取到的投影播种到新键下，避免同数据二次网络请求。
    queryClient.setQueryData(
      relationshipsKeys.conflicts({ relationshipRevision: revision }),
      query.data,
    );
    setKnownRevision(revision);
  }, [knownRevision, query.data, queryClient, revision]);

  return query;
}

export interface ConflictAiAvailability {
  /** null 表示可用性尚未确认：不显示“不可用”，也不假装可用。 */
  available: boolean | null;
}

export function useConflictAiAvailability(facade: ConflictDecisionsFacade): ConflictAiAvailability {
  const query = useQuery({
    queryKey: [...relationshipsKeys.root, "decisions", "ai-available"] as const,
    queryFn: () => facade.isAiAvailable(),
    retry: false,
    staleTime: 60_000,
  });
  if (query.isError) return { available: false };
  return { available: query.data ?? null };
}

export interface ConflictAiAnalysisState {
  running: boolean;
  /** 最近一次运行的原始结果（覆盖范围/跳过数/失败码如实来自命令返回）。 */
  lastRun: ConflictAnalysisState | null;
  error: string | null;
  run: (scope: Parameters<ConflictDecisionsFacade["analyzeConflict"]>[0]) => void;
}

type ConflictAnalysisState = Awaited<ReturnType<ConflictDecisionsFacade["analyzeConflict"]>>;

export function useConflictAiAnalysis(options: {
  facade: ConflictDecisionsFacade;
  tracker?: OperationTracker;
}): ConflictAiAnalysisState {
  const { facade, tracker = operationTracker } = options;
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [running, setRunning] = useState(false);
  const [lastRun, setLastRun] = useState<ConflictAnalysisState | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = (scope: Parameters<ConflictDecisionsFacade["analyzeConflict"]>[0]) => {
    if (running) return;
    setRunning(true);
    setError(null);
    runTrackedOperation({
      tracker,
      // 分析结果保留在工作台内反馈；不额外发全局通知。
      notifications: null,
      kind: "ai_analysis",
      label: t("relationships.decisions.ai.trackerLabel"),
      translate: (key, translateOptions) =>
        String(t(key as never, translateOptions as never)),
      successNotice: () => null,
      errorNotice: () => null,
      run: () => facade.analyzeConflict(scope),
    })
      .then((result) => {
        setLastRun(result);
        // 分析记录已持久化：失效工作台，让结论经 latest_analysis 回流。
        void queryClient.invalidateQueries({ queryKey: relationshipsKeys.conflicts({}) });
      })
      .catch((reason: unknown) => {
        setError(
          describeNativeError(
            reason,
            (key, describeOptions) => String(t(key as never, describeOptions as never)),
            "relationships.decisions.ai.failureUnknown",
          ),
        );
      })
      .finally(() => setRunning(false));
  };

  return { error, lastRun, run, running };
}

/** 「按建议」与决定按钮共用的写入入参；centralize 走治理深链，不在此执行。 */
export type ResolvableConflictDecision = Exclude<ConflictDecision, "centralize_management">;

export function useResolveConflict(options: {
  facade: ConflictDecisionsFacade;
  tracker?: OperationTracker;
  notifications?: AppNotifications | null;
  onResolved?: (outcome: ConflictResolutionOutcome) => void;
}): {
  resolving: boolean;
  resolve: (input: {
    caseFact: ConflictCaseFact;
    decision: ResolvableConflictDecision;
    expectedRelationshipRevision: string;
  }) => Promise<ConflictResolutionOutcome | null>;
} {
  const { facade, notifications = null, onResolved, tracker = operationTracker } = options;
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const [resolving, setResolving] = useState(false);

  const resolve = async (input: {
    caseFact: ConflictCaseFact;
    decision: ResolvableConflictDecision;
    expectedRelationshipRevision: string;
  }) => {
    if (resolving) return null;
    setResolving(true);
    const command = {
      conflict_id: input.caseFact.conflict_id,
      decision: input.decision,
      expected_relationship_revision: input.expectedRelationshipRevision,
    };
    try {
      // 统一执行桥（任务 4）：即时写入命令不进在途投影、不闪顶栏，
      // 结果/失败经通知中心反馈；异常原样 rethrow，绝不吞掉。
      const outcome = await runTrackedOperation({
        tracker,
        notifications,
        kind: "conflict_resolve",
        mode: "instant",
        label: t("relationships.decisions.resolve.trackerLabel"),
        translate: (key, translateOptions) =>
          String(t(key as never, translateOptions as never)),
        successNotice: (result) => ({
          tone: "success" as const,
          title: t("relationships.decisions.resolve.successTitle"),
          detail: t("relationships.decisions.resolve.successDetail", {
            conflictId: result.conflict_id,
          }),
        }),
        errorNotice: (_error, message) => ({
          tone: "danger" as const,
          title: t("relationships.decisions.resolve.errorTitle"),
          detail: message,
        }),
        describeError: (error: unknown) =>
          describeNativeError(
            error,
            (key, describeOptions) => String(t(key as never, describeOptions as never)),
            "relationships.decisions.resolve.errorUnknown",
          ),
        run: () => facade.resolveConflictCase(command),
      });
      // 结论写入推进 relationship_revision：失效工作台（conflicts 前缀），
      // 重取后的新修订号会经 useConflictWorkspace 的键管理换到新键。
      void queryClient.invalidateQueries({ queryKey: relationshipsKeys.conflicts({}) });
      onResolved?.(outcome);
      return outcome;
    } finally {
      setResolving(false);
    }
  };

  return { resolve, resolving };
}
