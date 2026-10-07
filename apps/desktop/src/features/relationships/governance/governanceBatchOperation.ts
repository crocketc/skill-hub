import type { QueryClient } from "@tanstack/react-query";
import type {
  RelationGovernanceBatchAction,
  RelationGovernanceBatchOutcome,
} from "../../../api/bindings";
import { runTrackedOperation } from "../../../platform/runTrackedOperation";
import type { OperationTracker } from "../../../platform/operationTracker";
import { relationshipsKeys } from "../api";
import { governanceDestination } from "../../pending/workspace";
import { SHARED_IMPACT_CONFIRMATION_TOKEN, type RelationGovernanceFacade } from "./api";

type TrackedNotifications = Parameters<typeof runTrackedOperation>[0]["notifications"];

export interface GovernanceBatchRunner {
  (
    action: RelationGovernanceBatchAction,
    relationIds: string[],
    confirmed: ReadonlySet<string>,
    onResult: (outcome: RelationGovernanceBatchOutcome) => void,
    onError: (message: string) => void,
    phaseLabel: string,
  ): void;
}

export interface GovernanceBatchRunnerOptions {
  facade: RelationGovernanceFacade;
  tracker: OperationTracker;
  notifications: TrackedNotifications;
  queryClient: QueryClient;
  describeError: (reason: unknown) => string;
  translate: (key: string, options?: Record<string, unknown>) => string;
}

/**
 * 统一治理批次执行（§7.8 生产承载）：详情页头部「转为集中管理」与治理页
 * 共用同一条 prepare → commit 编排。逐项子任务挂入 tracker，通知/记录三端
 * 以后端 batch_id 关联；只有 committed 才是成功，其余终态交由逐项结果面板
 * 如实呈现。
 */
export function createGovernanceBatchRunner({
  describeError,
  facade,
  notifications,
  queryClient,
  tracker,
  translate,
}: GovernanceBatchRunnerOptions): GovernanceBatchRunner {
  const buildConfirmations = (relationIds: readonly string[], confirmed: ReadonlySet<string>) => {
    const confirmations: Record<string, string> = {};
    for (const relationId of relationIds) {
      if (confirmed.has(relationId)) {
        confirmations[relationId] = SHARED_IMPACT_CONFIRMATION_TOKEN;
      }
    }
    return confirmations;
  };

  return (action, relationIds, confirmed, onResult, onError, phaseLabel) => {
    void runTrackedOperation<RelationGovernanceBatchOutcome>({
      targetHref: governanceDestination(relationIds),
      canCancel: false,
      describeError,
      invalidateQueryKeys: [[relationshipsKeys.root]],
      kind: "relation_governance_batch",
      label: translate("relationships.governance.batch.trackerLabel"),
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
            label: translate("relationships.governance.batch.itemTrackerLabel", { id: item.relation_id }),
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
          return { title: translate("relationships.governance.batch.trackerLabel"), tone: "success" as const };
        }
        if (outcome.committed_count > 0) {
          return {
            title: translate("relationships.governance.batch.resultPartial", {
              committed: outcome.committed_count,
              failed: outcome.failed_count,
            }),
            tone: "warning" as const,
          };
        }
        return { title: translate("relationships.governance.batch.resultNone"), tone: "danger" as const };
      },
      summarize: (outcome) => ({
        failed: outcome.failed_count,
        skipped: outcome.cancelled_count + outcome.blocked_count,
        succeeded: outcome.committed_count,
      }),
      total: relationIds.length,
      tracker,
      translate,
    }).then(onResult).catch((reason: unknown) => {
      onError(describeError(reason));
    });
  };
}
